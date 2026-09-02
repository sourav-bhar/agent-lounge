import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { STORE_SCHEMA_VERSION } from "./constants.js";
import {
  atomicWriteJson,
  atomicWriteJsonIfAbsent,
  chmodPrivateDirectory,
  isNodeError,
  pathExists,
  readJsonFile,
  safeReadDirectory
} from "./fs-utils.js";
import {
  assertSafePurgeTarget,
  boardRootFor,
  compactTimestamp,
  curationPath,
  getStorePaths,
  messageDirectoryForDate,
  projectRootFromEnvironment,
  resolveProjectRef,
  resolveStoreHome,
  type StorePaths
} from "./paths.js";
import {
  CreateMessageInputSchema,
  CurationRecordSchema,
  MessageKindSchema,
  StoredMessageSchema,
  type Author,
  type CreateMessageInput,
  type CurationRecord,
  type CurationState,
  type MessagePage,
  type MessageQuery,
  type MessageScope,
  type MessageView,
  type ProjectRef,
  type StoreDoctorReport,
  type StoredMessage
} from "./schema.js";
import { assertNoSensitivePatterns } from "./sensitive.js";

interface StoredRecord {
  message: StoredMessage;
  curation: CurationRecord | null;
  filePath: string;
  boardRoot: string;
}

interface TrashManifest {
  schema_version: 1;
  message_id: string;
  trashed_at: string;
  message_path: string;
  curation_path?: string;
}

export interface AgentBoardStoreOptions {
  home?: string;
  projectRoot?: string;
  client?: string;
  runId?: string;
}

export interface PostMessageOptions {
  allowSensitive?: boolean;
}

export class AgentBoardStore {
  readonly paths: StorePaths;
  readonly projectRoot: string;
  readonly author: Author;

  constructor(options: AgentBoardStoreOptions = {}) {
    this.paths = getStorePaths(resolveStoreHome(options.home));
    this.projectRoot = path.resolve(options.projectRoot ?? projectRootFromEnvironment());
    this.author = {
      client: sanitizeClientName(options.client ?? process.env.AGENT_BOARD_CLIENT ?? "cli"),
      run_id: options.runId ?? randomUUID()
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.paths.home, { recursive: true, mode: 0o700 });
    await chmodPrivateDirectory(this.paths.home);
    await Promise.all([
      mkdir(path.join(this.paths.personalBoard, "messages"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.paths.personalBoard, "curation"), { recursive: true, mode: 0o700 }),
      mkdir(this.paths.projectsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.paths.trashRoot, { recursive: true, mode: 0o700 })
    ]);
    await atomicWriteJsonIfAbsent(this.paths.sentinel, {
      schema_version: STORE_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      product: "agent-board"
    });
  }

  async post(
    rawInput: CreateMessageInput,
    options: PostMessageOptions = {}
  ): Promise<StoredMessage> {
    await this.initialize();
    const input = CreateMessageInputSchema.parse(rawInput);
    if (!options.allowSensitive) {
      assertNoSensitivePatterns([input.topic, input.body, ...input.tags].join("\n"));
    }

    const project =
      input.scope === "project" ? await resolveProjectRef(this.projectRoot) : undefined;
    const parent = input.reply_to ? await this.requireRecord(input.reply_to) : null;
    if (parent) this.assertSameBoard(input.scope, project, parent.message);

    const superseded = input.supersedes ? await this.requireRecord(input.supersedes) : null;
    if (superseded) this.assertSameBoard(input.scope, project, superseded.message);

    const now = new Date();
    const id = randomUUID();
    const message = StoredMessageSchema.parse({
      schema_version: STORE_SCHEMA_VERSION,
      id,
      created_at: now.toISOString(),
      scope: input.scope,
      kind: input.kind,
      topic: input.topic,
      body: input.body,
      tags: [...new Set(input.tags)],
      evidence: input.evidence,
      confidence: input.confidence,
      author: this.author,
      ...(project ? { project } : {}),
      thread_id: parent?.message.thread_id ?? id,
      reply_to: input.reply_to,
      supersedes: input.supersedes
    });

    const boardRoot = boardRootFor(this.paths, message.scope, message.project);
    const directory = messageDirectoryForDate(boardRoot, now);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (project) {
      const descriptor = path.join(boardRoot, "project.json");
      await atomicWriteJsonIfAbsent(descriptor, project);
    }
    const filename = `${compactTimestamp(now)}_${message.id}.json`;
    await atomicWriteJson(path.join(directory, filename), message);
    return message;
  }

  async list(query: MessageQuery): Promise<MessagePage> {
    await this.initialize();
    const normalized: MessageQuery = {
      ...query,
      ...(query.kind ? { kind: MessageKindSchema.parse(query.kind) } : {}),
      limit: Math.max(1, query.limit),
      offset: Math.max(0, query.offset)
    };
    const { records, warnings } = await this.loadRecords(normalized.scope);
    const needles = searchTerms(normalized.query);
    const filtered = records
      .filter(({ curation }) => normalized.includeHidden || curation?.state !== "hidden")
      .filter(({ message }) => !normalized.kind || message.kind === normalized.kind)
      .filter(({ message }) => !normalized.threadId || message.thread_id === normalized.threadId)
      .filter(({ message }) => {
        if (needles.length === 0) return true;
        const haystack = searchableText(message);
        return needles.every((needle) => haystack.includes(needle));
      })
      .sort(compareRecords);

    const items = filtered
      .slice(normalized.offset, normalized.offset + normalized.limit)
      .map(toView);
    const nextOffset = normalized.offset + items.length;
    return {
      items,
      total: filtered.length,
      count: items.length,
      offset: normalized.offset,
      has_more: nextOffset < filtered.length,
      next_offset: nextOffset < filtered.length ? nextOffset : null,
      warnings
    };
  }

  async get(messageId: string): Promise<MessageView | null> {
    await this.initialize();
    const record = await this.findRecord(messageId);
    return record ? toView(record) : null;
  }

  async setCuration(
    messageId: string,
    state: CurationState,
    note?: string
  ): Promise<CurationRecord> {
    await this.initialize();
    const record = await this.requireRecord(messageId);
    const curation = CurationRecordSchema.parse({
      schema_version: STORE_SCHEMA_VERSION,
      message_id: messageId,
      state,
      updated_at: new Date().toISOString(),
      ...(note?.trim() ? { note: note.trim() } : {})
    });
    await atomicWriteJson(curationPath(record.boardRoot, messageId), curation);
    return curation;
  }

  async clearCuration(messageId: string): Promise<boolean> {
    await this.initialize();
    const record = await this.requireRecord(messageId);
    const target = curationPath(record.boardRoot, messageId);
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async trash(messageId: string): Promise<string> {
    await this.initialize();
    const trashDirectory = path.join(this.paths.trashRoot, messageId);
    if (await pathExists(trashDirectory)) {
      if (await pathExists(path.join(trashDirectory, "message.json"))) {
        throw new Error(`Message ${messageId} is already in trash.`);
      }
    }
    const record = await this.requireRecord(messageId);
    if (await pathExists(trashDirectory)) {
      await rm(trashDirectory, { recursive: true, force: false });
    }
    await mkdir(trashDirectory, { recursive: false, mode: 0o700 });
    const originalCuration = curationPath(record.boardRoot, messageId);
    const manifest: TrashManifest = {
      schema_version: STORE_SCHEMA_VERSION,
      message_id: messageId,
      trashed_at: new Date().toISOString(),
      message_path: path.relative(this.paths.home, record.filePath),
      ...((await pathExists(originalCuration))
        ? { curation_path: path.relative(this.paths.home, originalCuration) }
        : {})
    };
    await atomicWriteJson(path.join(trashDirectory, "manifest.json"), manifest);
    await rename(record.filePath, path.join(trashDirectory, "message.json"));
    if (manifest.curation_path) {
      await rename(originalCuration, path.join(trashDirectory, "curation.json"));
    }
    return trashDirectory;
  }

  async restore(messageId: string): Promise<StoredMessage> {
    await this.initialize();
    const trashDirectory = path.join(this.paths.trashRoot, messageId);
    const manifest = parseTrashManifest(
      await readJsonFile(path.join(trashDirectory, "manifest.json"))
    );
    const messageSource = path.join(trashDirectory, "message.json");
    const messageTarget = safePathInside(this.paths.home, manifest.message_path);
    const targetExists = await pathExists(messageTarget);
    const message = StoredMessageSchema.parse(
      await readJsonFile((await pathExists(messageSource)) ? messageSource : messageTarget)
    );
    if (manifest.message_id !== messageId || message.id !== messageId) {
      throw new Error("Trash manifest and message identity do not match the requested message.");
    }
    if (targetExists) {
      const existing = StoredMessageSchema.parse(await readJsonFile(messageTarget));
      if (existing.id !== messageId || (await pathExists(messageSource))) {
        throw new Error(`Cannot restore ${messageId}: the original message path already exists.`);
      }
    }
    if (manifest.curation_path && (await pathExists(path.join(trashDirectory, "curation.json")))) {
      const curationTarget = safePathInside(this.paths.home, manifest.curation_path);
      if (await pathExists(curationTarget)) {
        throw new Error(`Cannot restore ${messageId}: the original curation path already exists.`);
      }
      await mkdir(path.dirname(curationTarget), { recursive: true, mode: 0o700 });
      await rename(path.join(trashDirectory, "curation.json"), curationTarget);
    }
    if (!targetExists) {
      await mkdir(path.dirname(messageTarget), { recursive: true, mode: 0o700 });
      await rename(messageSource, messageTarget);
    }
    await rm(trashDirectory, { recursive: true, force: false });
    return message;
  }

  async doctor(): Promise<StoreDoctorReport> {
    const initialized = await pathExists(this.paths.sentinel);
    const warnings: string[] = [];
    let permissions: string | null = null;
    if ((await pathExists(this.paths.home)) && process.platform !== "win32") {
      const info = await stat(this.paths.home);
      permissions = `0${(info.mode & 0o777).toString(8)}`;
      if ((info.mode & 0o077) !== 0) {
        warnings.push(
          "The store is readable or writable by other local users; expected mode 0700."
        );
      }
    }
    const { records, warnings: malformed } = initialized
      ? await this.loadRecords("all")
      : { records: [], warnings: [] };
    const trashEntries = await safeReadDirectory(this.paths.trashRoot);
    return {
      ok: initialized && warnings.length === 0 && malformed.length === 0,
      home: this.paths.home,
      initialized,
      permissions,
      message_count: records.length,
      trashed_count: trashEntries.filter((entry) => entry.isDirectory()).length,
      malformed_files: malformed,
      warnings
    };
  }

  async purgeStore(): Promise<void> {
    assertSafePurgeTarget(this.paths.home);
    if (!(await pathExists(this.paths.sentinel))) {
      throw new Error(`Refusing to purge ${this.paths.home}: Agent Board sentinel is missing.`);
    }
    await rm(this.paths.home, { recursive: true, force: false });
  }

  private async requireRecord(messageId: string): Promise<StoredRecord> {
    const record = await this.findRecord(messageId);
    if (!record) throw new Error(`Message not found: ${messageId}`);
    return record;
  }

  private async findRecord(messageId: string): Promise<StoredRecord | null> {
    const { records } = await this.loadRecords("all");
    return records.find(({ message }) => message.id === messageId) ?? null;
  }

  private async loadRecords(scope: MessageScope | "relevant" | "all"): Promise<{
    records: StoredRecord[];
    warnings: string[];
  }> {
    const roots = await this.boardRoots(scope);
    const warnings: string[] = [];
    const messageFiles = (
      await Promise.all(roots.map((boardRoot) => walkJsonFiles(path.join(boardRoot, "messages"))))
    ).flat();
    const records = (
      await Promise.all(
        messageFiles.map(async ({ filePath, boardRoot }) => {
          try {
            const message = StoredMessageSchema.parse(await readJsonFile(filePath));
            const curation = await readCuration(boardRoot, message.id, warnings, this.paths.home);
            return { message, curation, filePath, boardRoot } satisfies StoredRecord;
          } catch {
            warnings.push(path.relative(this.paths.home, filePath));
            return null;
          }
        })
      )
    ).filter((record): record is StoredRecord => record !== null);
    return { records, warnings: [...new Set(warnings)].sort() };
  }

  private async boardRoots(scope: MessageScope | "relevant" | "all"): Promise<string[]> {
    const roots: string[] = [];
    if (scope === "personal" || scope === "relevant" || scope === "all") {
      roots.push(this.paths.personalBoard);
    }
    if (scope === "project" || scope === "relevant") {
      const project = await resolveProjectRef(this.projectRoot);
      roots.push(boardRootFor(this.paths, "project", project));
    }
    if (scope === "all") {
      const projects = await safeReadDirectory(this.paths.projectsRoot);
      for (const entry of projects) {
        if (entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name)) {
          roots.push(path.join(this.paths.projectsRoot, entry.name));
        }
      }
    }
    return roots;
  }

  private assertSameBoard(
    scope: MessageScope,
    project: ProjectRef | undefined,
    related: StoredMessage
  ): void {
    if (related.scope !== scope) {
      throw new Error(
        "Replies and superseding messages must use the same scope as the related message."
      );
    }
    if (scope === "project" && related.project?.key !== project?.key) {
      throw new Error("Replies and superseding messages must belong to the same project board.");
    }
  }
}

async function readCuration(
  boardRoot: string,
  messageId: string,
  warnings: string[],
  home: string
): Promise<CurationRecord | null> {
  const target = curationPath(boardRoot, messageId);
  try {
    return CurationRecordSchema.parse(await readJsonFile(target));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    warnings.push(path.relative(home, target));
    return null;
  }
}

async function walkJsonFiles(
  root: string
): Promise<Array<{ filePath: string; boardRoot: string }>> {
  const boardRoot = path.dirname(root);
  const results: Array<{ filePath: string; boardRoot: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await safeReadDirectory(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".tmp-")) {
        results.push({ filePath: fullPath, boardRoot });
      }
    }
  };
  await visit(root);
  return results;
}

function compareRecords(left: StoredRecord, right: StoredRecord): number {
  const leftPinned = left.curation?.state === "pinned" ? 1 : 0;
  const rightPinned = right.curation?.state === "pinned" ? 1 : 0;
  if (leftPinned !== rightPinned) return rightPinned - leftPinned;
  return (
    right.message.created_at.localeCompare(left.message.created_at) ||
    right.message.id.localeCompare(left.message.id)
  );
}

function searchableText(message: StoredMessage): string {
  return [
    message.topic,
    message.body,
    message.kind,
    message.evidence,
    message.confidence,
    message.author.client,
    message.project?.name ?? "",
    ...message.tags
  ]
    .join("\n")
    .toLocaleLowerCase();
}

function searchTerms(query: string | undefined): string[] {
  const normalized = query?.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const terms: string[] = [];
  for (const match of normalized.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2])?.trim();
    if (term) terms.push(term);
  }
  return terms;
}

function toView(record: StoredRecord): MessageView {
  return { message: record.message, curation: record.curation };
}

function sanitizeClientName(value: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "").slice(0, 64) || "unknown";
}

function parseTrashManifest(value: unknown): TrashManifest {
  if (!value || typeof value !== "object") throw new Error("Trash manifest is invalid.");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema_version !== STORE_SCHEMA_VERSION ||
    typeof candidate.message_id !== "string" ||
    typeof candidate.trashed_at !== "string" ||
    typeof candidate.message_path !== "string" ||
    (candidate.curation_path !== undefined && typeof candidate.curation_path !== "string")
  ) {
    throw new Error("Trash manifest is invalid.");
  }
  return {
    schema_version: STORE_SCHEMA_VERSION,
    message_id: candidate.message_id,
    trashed_at: candidate.trashed_at,
    message_path: candidate.message_path,
    ...(candidate.curation_path ? { curation_path: candidate.curation_path } : {})
  };
}

function safePathInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("Trash manifest points outside the Agent Board store.");
  }
  return target;
}
