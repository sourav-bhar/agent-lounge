import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteJsonIfAbsent } from "../src/fs-utils.js";
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
});
