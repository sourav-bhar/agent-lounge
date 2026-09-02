import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafePurgeTarget,
  boardRootFor,
  compactTimestamp,
  getStorePaths,
  legacyStoreHome,
  projectRootFromEnvironment,
  resolveProjectRef,
  resolveStoreHome
} from "../src/paths.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTemporaryDirectories);

describe("store paths", () => {
  it("resolves an explicit home and derives versioned paths", async () => {
    const root = await temporaryDirectory("paths");
    const home = resolveStoreHome(path.join(root, "board"));
    const paths = getStorePaths(home);
    expect(paths.home).toBe(path.join(root, "board"));
    expect(paths.personalBoard).toContain(path.join("v1", "boards", "personal"));
    expect(paths.trashRoot).toContain(path.join("v1", "trash"));
  });

  it("supports current and legacy environment overrides plus home expansion", async () => {
    const original = {
      loungeHome: process.env.AGENT_LOUNGE_HOME,
      boardHome: process.env.AGENT_BOARD_HOME,
      loungeProject: process.env.AGENT_LOUNGE_PROJECT_ROOT,
      boardProject: process.env.AGENT_BOARD_PROJECT_ROOT,
      claudeProject: process.env.CLAUDE_PROJECT_DIR
    };
    try {
      delete process.env.AGENT_LOUNGE_HOME;
      process.env.AGENT_BOARD_HOME = "~/legacy-lounge";
      expect(resolveStoreHome()).toBe(path.join(homedir(), "legacy-lounge"));
      process.env.AGENT_LOUNGE_HOME = "~/current-lounge";
      expect(resolveStoreHome()).toBe(path.join(homedir(), "current-lounge"));
      expect(resolveStoreHome("~")).toBe(homedir());
      expect(legacyStoreHome()).toBe(path.join(homedir(), ".agent-board"));

      delete process.env.AGENT_LOUNGE_PROJECT_ROOT;
      delete process.env.AGENT_BOARD_PROJECT_ROOT;
      process.env.CLAUDE_PROJECT_DIR = "~/claude-project";
      expect(projectRootFromEnvironment()).toBe(path.join(homedir(), "claude-project"));
      process.env.AGENT_BOARD_PROJECT_ROOT = "~/board-project";
      expect(projectRootFromEnvironment()).toBe(path.join(homedir(), "board-project"));
      process.env.AGENT_LOUNGE_PROJECT_ROOT = "~/lounge-project";
      expect(projectRootFromEnvironment()).toBe(path.join(homedir(), "lounge-project"));
    } finally {
      restoreEnvironment("AGENT_LOUNGE_HOME", original.loungeHome);
      restoreEnvironment("AGENT_BOARD_HOME", original.boardHome);
      restoreEnvironment("AGENT_LOUNGE_PROJECT_ROOT", original.loungeProject);
      restoreEnvironment("AGENT_BOARD_PROJECT_ROOT", original.boardProject);
      restoreEnvironment("CLAUDE_PROJECT_DIR", original.claudeProject);
    }
  });

  it("selects board roots explicitly and rejects missing project context", async () => {
    const root = await temporaryDirectory("board-roots");
    const paths = getStorePaths(path.join(root, "lounge"));
    expect(boardRootFor(paths, "personal")).toBe(paths.personalBoard);
    expect(boardRootFor(paths, "project", { key: "a".repeat(16), name: "fixture-project" })).toBe(
      path.join(paths.projectsRoot, "a".repeat(16))
    );
    expect(() => boardRootFor(paths, "project")).toThrow(/project context/i);
    expect(() => assertSafePurgeTarget(path.join(root, "safe-store"))).not.toThrow();
  });

  it("uses one project identity for a Git repository", async () => {
    const root = await temporaryDirectory("git-project");
    await execFileAsync("git", ["init", "--quiet", root]);
    const nested = path.join(root, "src", "nested");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested, { recursive: true }));
    const fromRoot = await resolveProjectRef(root);
    const fromNested = await resolveProjectRef(nested);
    expect(fromNested).toEqual(fromRoot);
    expect(fromRoot.name).toBe(path.basename(root));
    expect(fromRoot.key).toMatch(/^[a-f0-9]{16}$/);
  });

  it("formats sortable UTC timestamps", () => {
    expect(compactTimestamp(new Date("2026-02-03T04:05:06.789Z"))).toBe("20260203T040506789Z");
  });

  it("uses a stable fallback identity outside a Git repository", async () => {
    const root = await temporaryDirectory("non-git-project");
    const missing = path.join(root, "not-created");
    expect(await resolveProjectRef(missing)).toMatchObject({ name: "not-created" });
    expect((await resolveProjectRef(path.parse(root).root)).name).toBe("project");
  });

  it("refuses broad destructive targets", () => {
    expect(() => assertSafePurgeTarget(path.parse(process.cwd()).root)).toThrow(/unsafe path/i);
    expect(() => assertSafePurgeTarget(process.cwd())).toThrow(/unsafe path/i);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
