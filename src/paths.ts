import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { RULES_FILE_NAME, STORE_SENTINEL } from "./constants.js";
import type { MessageScope, ProjectRef } from "./schema.js";

export interface StorePaths {
  home: string;
  sentinel: string;
  rules: string;
  installState: string;
  personalBoard: string;
  projectsRoot: string;
  trashRoot: string;
}

export function resolveStoreHome(explicitHome?: string): string {
  const configured = explicitHome ?? process.env.AGENT_LOUNGE_HOME ?? process.env.AGENT_BOARD_HOME;
  return path.resolve(configured ? expandHome(configured) : path.join(homedir(), ".agent-lounge"));
}

export function defaultStoreHome(): string {
  return path.join(homedir(), ".agent-lounge");
}

export function legacyStoreHome(): string {
  return path.join(homedir(), ".agent-board");
}

export function getStorePaths(home: string): StorePaths {
  const resolved = path.resolve(home);
  return {
    home: resolved,
    sentinel: path.join(resolved, STORE_SENTINEL),
    rules: path.join(resolved, RULES_FILE_NAME),
    installState: path.join(resolved, "install-state.json"),
    personalBoard: path.join(resolved, "v1", "boards", "personal"),
    projectsRoot: path.join(resolved, "v1", "boards", "projects"),
    trashRoot: path.join(resolved, "v1", "trash")
  };
}

export function boardRootFor(paths: StorePaths, scope: MessageScope, project?: ProjectRef): string {
  if (scope === "personal") return paths.personalBoard;
  if (!project) throw new Error("Project scope requires a project context");
  return path.join(paths.projectsRoot, project.key);
}

export function messageDirectoryForDate(boardRoot: string, date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(boardRoot, "messages", year, month, day);
}

export function curationPath(boardRoot: string, messageId: string): string {
  return path.join(boardRoot, "curation", `${messageId}.json`);
}

export function projectRootFromEnvironment(): string {
  const configured =
    process.env.AGENT_LOUNGE_PROJECT_ROOT ??
    process.env.AGENT_BOARD_PROJECT_ROOT ??
    process.env.CLAUDE_PROJECT_DIR;
  return path.resolve(configured ? expandHome(configured) : process.cwd());
}

export async function resolveProjectRef(cwd: string): Promise<ProjectRef> {
  const normalizedCwd = await safeRealpath(path.resolve(cwd));
  const commonDir = gitPath(cwd, ["rev-parse", "--git-common-dir"]);
  const topLevel = gitPath(cwd, ["rev-parse", "--show-toplevel"]);
  const identityPath = commonDir ? await safeRealpath(path.resolve(cwd, commonDir)) : normalizedCwd;
  const displayPath = topLevel ? path.resolve(cwd, topLevel) : normalizedCwd;
  return {
    key: createHash("sha256").update(identityPath).digest("hex").slice(0, 16),
    name: path.basename(displayPath) || "project"
  };
}

export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

export function assertSafePurgeTarget(target: string): void {
  const resolved = path.resolve(target);
  const dangerous = new Set([
    path.parse(resolved).root,
    homedir(),
    process.cwd(),
    path.dirname(homedir())
  ]);
  if (dangerous.has(resolved) || resolved.length < 8) {
    throw new Error(`Refusing to purge unsafe path: ${resolved}`);
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(homedir(), value.slice(2));
  return value;
}

function gitPath(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const value = result.stdout.trim();
  return value || null;
}

async function safeRealpath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}
