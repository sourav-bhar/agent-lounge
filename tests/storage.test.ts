import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentLoungeStore, migrateLegacyStoreDirectory } from "../src/storage.js";
import {
  cleanupTemporaryDirectories,
  messageInput,
  temporaryDirectory,
  temporaryProject
} from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("AgentLoungeStore", () => {
  it("moves a legacy Agent Board store intact and adds current Lounge files", async () => {
    const parent = await temporaryDirectory("legacy-store");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    const legacyStore = new AgentLoungeStore({
      home: legacyHome,
      projectRoot: await temporaryProject("legacy-project")
    });
    const message = await legacyStore.post(messageInput({ topic: "Preserve this lesson" }));
    await rename(
      path.join(legacyHome, ".agent-lounge-store"),
      path.join(legacyHome, ".agent-board-store")
    );

    expect(await migrateLegacyStoreDirectory(legacyHome, loungeHome)).toBe(true);
    const loungeStore = new AgentLoungeStore({
      home: loungeHome,
      projectRoot: legacyStore.projectRoot
    });
    await loungeStore.initialize();

    expect((await loungeStore.get(message.id))?.message.topic).toBe("Preserve this lesson");
    expect(await stat(path.join(loungeHome, ".agent-lounge-store"))).toBeTruthy();
    expect(await stat(path.join(loungeHome, "LOUNGE.md"))).toBeTruthy();
    await expect(stat(legacyHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await migrateLegacyStoreDirectory(legacyHome, loungeHome)).toBe(false);
  });

  it("merges a legacy store when a current Lounge already exists without deleting the safety copy", async () => {
    const parent = await temporaryDirectory("coexisting-stores");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    const projectRoot = await temporaryProject("coexisting-project");
    const legacyStore = new AgentLoungeStore({ home: legacyHome, projectRoot });
    const loungeStore = new AgentLoungeStore({ home: loungeHome, projectRoot });
    const message = await legacyStore.post(
      messageInput({ scope: "project", topic: "Do not strand this lesson" })
    );
    await legacyStore.setCuration(message.id, "pinned", "Still useful");
    await loungeStore.initialize();

    expect(await migrateLegacyStoreDirectory(legacyHome, loungeHome)).toBe(true);
    expect((await loungeStore.get(message.id))?.message.topic).toBe("Do not strand this lesson");
    expect((await loungeStore.get(message.id))?.curation?.state).toBe("pinned");
    expect(await stat(legacyHome)).toBeTruthy();
    expect(await migrateLegacyStoreDirectory(legacyHome, loungeHome)).toBe(false);
  });

  it("refuses to overwrite different files while merging coexisting stores", async () => {
    const parent = await temporaryDirectory("coexisting-conflict");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    const legacyStore = new AgentLoungeStore({
      home: legacyHome,
      projectRoot: await temporaryProject("conflict-project")
    });
    const message = await legacyStore.post(messageInput({ topic: "Original lesson" }));
    const legacyMessagePath = (await messageFiles(legacyHome))[0]!;
    const conflictingPath = path.join(loungeHome, path.relative(legacyHome, legacyMessagePath));
    await mkdir(path.dirname(conflictingPath), { recursive: true });
    await writeFile(conflictingPath, "different\n", "utf8");

    await expect(migrateLegacyStoreDirectory(legacyHome, loungeHome)).rejects.toThrow(
      /refusing to overwrite different/i
    );
    expect(await readFile(conflictingPath, "utf8")).toBe("different\n");
    expect((await legacyStore.get(message.id))?.message.topic).toBe("Original lesson");
  });

  it("does nothing when the legacy path is the current store or has no durable data", async () => {
    const parent = await temporaryDirectory("legacy-no-data");
    const emptyLegacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    await mkdir(emptyLegacyHome, { recursive: true });
    await mkdir(loungeHome, { recursive: true });

    expect(await migrateLegacyStoreDirectory(loungeHome, loungeHome)).toBe(false);
    expect(await migrateLegacyStoreDirectory(emptyLegacyHome, loungeHome)).toBe(false);
  });

  it("refuses a file-versus-directory collision while merging legacy data", async () => {
    const parent = await temporaryDirectory("legacy-directory-conflict");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    const legacyStore = new AgentLoungeStore({
      home: legacyHome,
      projectRoot: await temporaryProject("directory-conflict-project")
    });
    await legacyStore.post(messageInput({ topic: "Keep this file" }));
    const legacyMessagePath = (await messageFiles(legacyHome))[0]!;
    const conflictingPath = path.join(loungeHome, path.relative(legacyHome, legacyMessagePath));
    await mkdir(conflictingPath, { recursive: true });

    await expect(migrateLegacyStoreDirectory(legacyHome, loungeHome)).rejects.toThrow(
      /refusing to overwrite different/i
    );
    expect((await stat(conflictingPath)).isDirectory()).toBe(true);
  });

  it("refuses a directory-versus-file collision while merging legacy data", async () => {
    const parent = await temporaryDirectory("legacy-parent-conflict");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    await mkdir(path.join(legacyHome, "v1", "boards"), { recursive: true });
    await mkdir(path.join(loungeHome, "v1"), { recursive: true });
    await writeFile(path.join(loungeHome, "v1", "boards"), "different\n", "utf8");

    await expect(migrateLegacyStoreDirectory(legacyHome, loungeHome)).rejects.toThrow(
      /refusing to overwrite different/i
    );
    expect(await readFile(path.join(loungeHome, "v1", "boards"), "utf8")).toBe("different\n");
  });

  it("refuses a legacy data root that is not a directory", async () => {
    const parent = await temporaryDirectory("legacy-root-file");
    const legacyHome = path.join(parent, ".agent-board");
    const loungeHome = path.join(parent, ".agent-lounge");
    await mkdir(legacyHome, { recursive: true });
    await mkdir(loungeHome, { recursive: true });
    await writeFile(path.join(legacyHome, "v1"), "not-a-directory\n", "utf8");

    await expect(migrateLegacyStoreDirectory(legacyHome, loungeHome)).rejects.toThrow(
      /not a directory/i
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links while merging legacy data",
    async () => {
      const parent = await temporaryDirectory("legacy-symlink");
      const legacyHome = path.join(parent, ".agent-board");
      const loungeHome = path.join(parent, ".agent-lounge");
      const legacyData = path.join(legacyHome, "v1");
      await mkdir(legacyData, { recursive: true });
      await mkdir(loungeHome, { recursive: true });
      await symlink(path.join(parent, "outside"), path.join(legacyData, "linked-data"));

      await expect(migrateLegacyStoreDirectory(legacyHome, loungeHome)).rejects.toThrow(
        /unsupported symbolic link/i
      );
    }
  );

  it("creates a private, inspectable file store", async () => {
    const home = path.join(await temporaryDirectory("private"), "board");
    const projectRoot = await temporaryProject();
    const store = new AgentLoungeStore({ home, projectRoot, client: "Codex Test" });
    const message = await store.post(messageInput());

    const report = await store.doctor();
    expect(report).toMatchObject({ ok: true, initialized: true, message_count: 1 });
    const view = await store.get(message.id);
    expect(view?.message.author.client).toBe("codex-test");
    expect(view?.message).toEqual(message);

    if (process.platform !== "win32") {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      const files = await messageFiles(home);
      expect(files).toHaveLength(1);
      expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it("separates personal and project boards while relevant combines the current two", async () => {
    const home = path.join(await temporaryDirectory("scopes"), "board");
    const firstProject = await temporaryProject("first-project");
    const secondProject = await temporaryProject("second-project");
    const first = new AgentLoungeStore({ home, projectRoot: firstProject, client: "first" });
    const second = new AgentLoungeStore({ home, projectRoot: secondProject, client: "second" });

    await first.post(messageInput({ topic: "Personal preference" }));
    const firstProjectMessage = await first.post(
      messageInput({ scope: "project", topic: "First project lesson" })
    );
    const secondProjectMessage = await second.post(
      messageInput({ scope: "project", topic: "Second project warning", kind: "warning" })
    );

    const relevant = await first.list(query({ scope: "relevant" }));
    expect(relevant.items.map((item) => item.message.id)).toContain(firstProjectMessage.id);
    expect(relevant.items.map((item) => item.message.id)).not.toContain(secondProjectMessage.id);
    expect(relevant.total).toBe(2);
    expect((await first.list(query({ scope: "personal" }))).total).toBe(1);
    expect((await first.list(query({ scope: "project" }))).total).toBe(1);
    expect((await first.list(query({ scope: "all" }))).total).toBe(3);
  });

  it("supports multi-term, quoted, kind, and pagination filters", async () => {
    const home = path.join(await temporaryDirectory("search"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    await store.post(
      messageInput({
        kind: "lesson",
        topic: "Testing workflow",
        body: "Use focused checks before the broad build.",
        tags: ["quality"]
      })
    );
    await store.post(messageInput({ kind: "warning", topic: "Deployment warning" }));
    await store.post(messageInput({ topic: "Copy preference" }));

    expect((await store.list(query({ query: "testing checks" }))).total).toBe(1);
    expect((await store.list(query({ query: '"focused checks"' }))).total).toBe(1);
    expect((await store.list(query({ query: '"testing focused"' }))).total).toBe(0);
    expect((await store.list(query({ kind: "warning" }))).total).toBe(1);
    const firstPage = await store.list(query({ limit: 2 }));
    expect(firstPage).toMatchObject({ total: 3, count: 2, has_more: true, next_offset: 2 });
    const secondPage = await store.list(query({ limit: 2, offset: 2 }));
    expect(secondPage).toMatchObject({ count: 1, has_more: false, next_offset: null });
  });

  it("builds threads and prevents cross-board relationships", async () => {
    const home = path.join(await temporaryDirectory("threads"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const question = await store.post(messageInput({ kind: "question", topic: "Which command?" }));
    const reply = await store.post(
      messageInput({ kind: "reply", topic: "Use the focused command", reply_to: question.id })
    );
    expect(reply.thread_id).toBe(question.id);
    const thread = await store.list(query({ scope: "all", threadId: question.id }));
    expect(thread.total).toBe(2);

    await expect(
      store.post(
        messageInput({
          scope: "project",
          kind: "reply",
          topic: "Wrong board",
          reply_to: question.id
        })
      )
    ).rejects.toThrow(/same scope/i);
    await expect(
      store.post(
        messageInput({
          scope: "project",
          topic: "Wrong superseding board",
          supersedes: question.id
        })
      )
    ).rejects.toThrow(/same scope/i);
  });

  it("keeps curation separate, hides by default, and orders pins first", async () => {
    const home = path.join(await temporaryDirectory("curation"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const older = await store.post(messageInput({ topic: "Older trusted note" }));
    const newer = await store.post(messageInput({ topic: "Newer note" }));

    await store.setCuration(older.id, "pinned", "Human verified");
    const pinned = await store.list(query());
    expect(pinned.items[0]?.message.id).toBe(older.id);
    expect(pinned.items[0]?.curation?.note).toBe("Human verified");

    await store.setCuration(newer.id, "hidden");
    expect((await store.list(query())).total).toBe(1);
    expect((await store.list(query({ includeHidden: true }))).total).toBe(2);
    expect(await store.clearCuration(newer.id)).toBe(true);
    expect(await store.clearCuration(newer.id)).toBe(false);
  });

  it("moves messages and curation to recoverable trash", async () => {
    const home = path.join(await temporaryDirectory("trash"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const message = await store.post(messageInput());
    await store.setCuration(message.id, "pinned");

    await store.trash(message.id);
    expect(await store.get(message.id)).toBeNull();
    expect((await store.doctor()).trashed_count).toBe(1);
    await expect(store.trash(message.id)).rejects.toThrow(/already in trash/i);

    const restored = await store.restore(message.id);
    expect(restored.id).toBe(message.id);
    expect((await store.get(message.id))?.curation?.state).toBe("pinned");
    expect((await store.doctor()).trashed_count).toBe(0);
  });

  it("finishes a restore safely after an interrupted final cleanup", async () => {
    const home = path.join(await temporaryDirectory("restore-retry"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const message = await store.post(messageInput());
    const trashDirectory = await store.trash(message.id);
    const manifest = JSON.parse(
      await readFile(path.join(trashDirectory, "manifest.json"), "utf8")
    ) as { message_path: string };
    const target = path.resolve(home, manifest.message_path);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(path.join(trashDirectory, "message.json"), target);

    expect((await store.restore(message.id)).id).toBe(message.id);
    expect((await store.doctor()).trashed_count).toBe(0);
  });

  it("rejects a trash manifest that attempts path traversal", async () => {
    const home = path.join(await temporaryDirectory("trash-traversal"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const message = await store.post(messageInput());
    const trashDirectory = await store.trash(message.id);
    const manifestPath = path.join(trashDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.message_path = path.join("..", "..", "outside.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(store.restore(message.id)).rejects.toThrow(/outside/i);
  });

  it("reports malformed files and unsafe permissions without losing valid messages", async () => {
    const home = path.join(await temporaryDirectory("doctor"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    expect((await store.doctor()).ok).toBe(false);
    await store.post(messageInput());
    const badDirectory = path.join(
      home,
      "v1",
      "boards",
      "personal",
      "messages",
      "2026",
      "01",
      "01"
    );
    await mkdir(badDirectory, { recursive: true });
    await writeFile(path.join(badDirectory, "bad.json"), "{not-json}\n", "utf8");
    const malformed = await store.doctor();
    expect(malformed.ok).toBe(false);
    expect(malformed.message_count).toBe(1);
    expect(malformed.malformed_files).toContain(
      path.join("v1", "boards", "personal", "messages", "2026", "01", "01", "bad.json")
    );

    if (process.platform !== "win32") {
      await chmod(home, 0o755);
      expect((await store.doctor()).warnings.join(" ")).toMatch(/other local users/i);
    }
  });

  it("blocks likely secrets unless a human explicitly overrides the guard", async () => {
    const home = path.join(await temporaryDirectory("secrets"), "board");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    const synthetic = `npm_${"x".repeat(32)}`;
    await expect(store.post(messageInput({ body: synthetic }))).rejects.toThrow(/sensitive data/i);
    const stored = await store.post(messageInput({ body: synthetic }), { allowSensitive: true });
    expect(stored.body).toBe(synthetic);
  });

  it("does not lose messages during concurrent writes", async () => {
    const home = path.join(await temporaryDirectory("concurrency"), "board");
    const projectRoot = await temporaryProject();
    const stores = Array.from(
      { length: 8 },
      (_, index) => new AgentLoungeStore({ home, projectRoot, client: `worker-${index}` })
    );
    const messages = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        stores[index % stores.length]!.post(
          messageInput({ topic: `Concurrent message ${index}`, tags: ["concurrency"] })
        )
      )
    );
    expect(new Set(messages.map((message) => message.id)).size).toBe(80);
    expect((await stores[0]!.list(query({ limit: 100 }))).total).toBe(80);
    expect((await messageFiles(home)).length).toBe(80);
  });

  it("purges only a sentinel-marked, narrowly scoped store", async () => {
    const parent = await temporaryDirectory("purge");
    const home = path.join(parent, "board-store");
    const store = new AgentLoungeStore({ home, projectRoot: await temporaryProject() });
    await expect(store.purgeStore()).rejects.toThrow(/sentinel/i);
    await store.initialize();
    await store.purgeStore();
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function query(overrides: Record<string, unknown> = {}) {
  return {
    scope: "all" as const,
    includeHidden: false,
    limit: 20,
    offset: 0,
    ...overrides
  };
}

async function messageFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(directory, { withFileTypes: true })
    );
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        target.includes(`${path.sep}messages${path.sep}`)
      ) {
        results.push(target);
      }
    }
  };
  await walk(root);
  return results;
}
