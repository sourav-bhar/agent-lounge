import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  atomicWriteJson,
  atomicWriteJsonIfAbsent,
  atomicWriteText,
  atomicWriteTextIfAbsent,
  isNodeError,
  pathExists,
  readJsonFile,
  safeReadDirectory
} from "../src/fs-utils.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("atomic filesystem helpers", () => {
  it("creates a complete JSON file exactly once under contention", async () => {
    const directory = await temporaryDirectory("atomic-create");
    const target = path.join(directory, "once.json");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        atomicWriteJsonIfAbsent(target, { index, body: "complete" })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = JSON.parse(await readFile(target, "utf8")) as {
      index: number;
      body: string;
    };
    expect(stored.index).toBeGreaterThanOrEqual(0);
    expect(stored.index).toBeLessThan(40);
    expect(stored.body).toBe("complete");
    expect((await readdir(directory)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("atomically replaces text and JSON while preserving create-once text", async () => {
    const directory = await temporaryDirectory("atomic-replace");
    const textPath = path.join(directory, "note.txt");
    const jsonPath = path.join(directory, "value.json");

    expect(await atomicWriteTextIfAbsent(textPath, "first\n")).toBe(true);
    expect(await atomicWriteTextIfAbsent(textPath, "second\n")).toBe(false);
    expect(await readFile(textPath, "utf8")).toBe("first\n");
    await atomicWriteText(textPath, "replacement\n");
    expect(await readFile(textPath, "utf8")).toBe("replacement\n");

    await atomicWriteJson(jsonPath, { version: 1 });
    expect(await readJsonFile(jsonPath)).toEqual({ version: 1 });
    expect(await pathExists(jsonPath)).toBe(true);
    expect(await pathExists(path.join(directory, "missing.json"))).toBe(false);
  });

  it("reads empty or existing directories and identifies Node error codes", async () => {
    const root = await temporaryDirectory("safe-read");
    const missing = path.join(root, "missing");
    expect(await safeReadDirectory(missing)).toEqual([]);
    await mkdir(missing);
    expect(await safeReadDirectory(missing)).toEqual([]);

    const nodeError = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isNodeError(nodeError, "ENOENT")).toBe(true);
    expect(isNodeError(nodeError, "EEXIST")).toBe(false);
    expect(isNodeError("ENOENT", "ENOENT")).toBe(false);
  });
});
