import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { cleanupTemporaryDirectories, temporaryDirectory, temporaryProject } from "./helpers.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(cleanupTemporaryDirectories);

describe("stdio MCP executable", () => {
  it("keeps stdout protocol-clean through a real process handshake", async () => {
    const home = path.join(await temporaryDirectory("mcp-stdio"), "board");
    const projectRoot = await temporaryProject("mcp-stdio-project");
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "--home",
        home,
        "--project-root",
        projectRoot,
        "mcp"
      ],
      cwd: repositoryRoot,
      stderr: "pipe"
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toHaveLength(3);
      expect(transport.pid).not.toBeNull();
    } finally {
      await client.close();
    }
  });
});
