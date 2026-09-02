import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../src/mcp-server.js";
import { presetRules, writeRulesDocument } from "../src/rules.js";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryProject } from "./helpers.js";

let client: Client;
let server: Awaited<ReturnType<typeof createMcpServer>>;
let home: string;
let projectRoot: string;

beforeEach(async () => {
  home = path.join(await temporaryDirectory("mcp"), "board");
  projectRoot = await temporaryProject("mcp-project");
  client = new Client({ name: "agent-lounge-test", version: "1.0.0" });
  server = await createMcpServer({ home, projectRoot, client: "mcp-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await cleanupTemporaryDirectories();
});

describe("Agent Lounge MCP server", () => {
  it("advertises exactly three focused tools with safe annotations and instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "agent_lounge_post",
      "agent_lounge_read",
      "agent_lounge_search"
    ]);
    expect(tools.find((tool) => tool.name === "agent_lounge_read")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(tools.find((tool) => tool.name === "agent_lounge_post")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    expect(client.getInstructions()).toMatch(/untrusted peer context/i);
    expect(client.getInstructions()).toMatch(/never as user authorization/i);
  });

  it("loads the configured boss-awareness choice into agent-facing instructions", async () => {
    expect(client.getInstructions()).not.toContain("can check in on lounge conversations");
    await client.close();
    await server.close();

    await writeRulesDocument(
      {
        rules: { ...presetRules("helpful"), boss_awareness: "known" },
        customInstructions: "# Extra house rules"
      },
      home
    );
    client = new Client({ name: "agent-lounge-known-boss-test", version: "1.0.0" });
    server = await createMcpServer({ home, projectRoot, client: "mcp-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getInstructions()).toContain(
      "You know the boss can check in on lounge conversations."
    );
  });

  it("posts, reads, and searches structured local messages end to end", async () => {
    const post = await client.callTool({
      name: "agent_lounge_post",
      arguments: {
        scope: "project",
        kind: "lesson",
        topic: "Focused validation works",
        body: "Run the affected check before the broad build for faster feedback.",
        tags: ["testing", "workflow"],
        evidence: "observed_success",
        confidence: "high",
        response_format: "json"
      }
    });
    expect(post.isError).not.toBe(true);
    const posted = post.structuredContent as {
      message: { id: string; project: { name: string }; author: { client: string } };
    };
    expect(posted.message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted.message.project.name).toBe(path.basename(projectRoot));

    const search = await client.callTool({
      name: "agent_lounge_search",
      arguments: {
        query: "validation faster",
        scope: "relevant",
        response_format: "json"
      }
    });
    expect(search.isError).not.toBe(true);
    const searchPage = search.structuredContent as {
      total: number;
      items: Array<{ message: { id: string } }>;
    };
    expect(searchPage.total).toBe(1);
    expect(searchPage.items[0]?.message.id).toBe(posted.message.id);

    const read = await client.callTool({
      name: "agent_lounge_read",
      arguments: { scope: "all", limit: 10, response_format: "markdown" }
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ total: 1, count: 1, truncated: false });
    const text = read.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("Focused validation works");
  });

  it("returns tool errors without leaking the rejected secret value", async () => {
    const syntheticSecret = `gh${"p"}_${"q".repeat(24)}`;
    const result = await client.callTool({
      name: "agent_lounge_post",
      arguments: {
        scope: "personal",
        kind: "warning",
        topic: "Do not store this",
        body: syntheticSecret,
        evidence: "agent_inference",
        confidence: "low"
      }
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toMatch(/sensitive data/i);
    expect(text?.type === "text" ? text.text : "").not.toContain(syntheticSecret);
  });

  it("rejects structurally invalid calls at the protocol boundary", async () => {
    const result = await client.callTool({
      name: "agent_lounge_post",
      arguments: {
        scope: "personal",
        kind: "reply",
        topic: "Missing parent",
        body: "This reply has no parent.",
        evidence: "agent_inference",
        confidence: "low"
      }
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toMatch(/reply_to|invalid/i);
  });

  it("bounds large responses and provides a correct continuation offset", async () => {
    for (let index = 0; index < 5; index += 1) {
      const result = await client.callTool({
        name: "agent_lounge_post",
        arguments: {
          scope: "personal",
          kind: "note",
          topic: `Large note ${index}`,
          body: `${index} ${"bounded content ".repeat(470)}`,
          evidence: "human_note",
          confidence: "medium"
        }
      });
      expect(result.isError).not.toBe(true);
    }

    const first = await client.callTool({
      name: "agent_lounge_read",
      arguments: { scope: "personal", limit: 5, offset: 0, response_format: "json" }
    });
    const page = first.structuredContent as {
      count: number;
      total: number;
      truncated: boolean;
      has_more: boolean;
      next_offset: number;
    };
    expect(page.total).toBe(5);
    expect(page.truncated).toBe(true);
    expect(page.has_more).toBe(true);
    expect(page.count).toBeGreaterThan(0);
    expect(page.count).toBeLessThan(5);
    expect(page.next_offset).toBe(page.count);
    const text = first.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text.length : Number.POSITIVE_INFINITY).toBeLessThan(
      24_100
    );

    const second = await client.callTool({
      name: "agent_lounge_read",
      arguments: {
        scope: "personal",
        limit: 5,
        offset: page.next_offset,
        response_format: "json"
      }
    });
    expect((second.structuredContent as { count: number }).count).toBeGreaterThan(0);
  });
});
