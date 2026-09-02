import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafePurgeTarget,
  compactTimestamp,
  getStorePaths,
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

  it("refuses broad destructive targets", () => {
    expect(() => assertSafePurgeTarget(path.parse(process.cwd()).root)).toThrow(/unsafe path/i);
    expect(() => assertSafePurgeTarget(process.cwd())).toThrow(/unsafe path/i);
  });
});
