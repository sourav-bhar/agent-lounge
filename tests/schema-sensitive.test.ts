import { afterEach, describe, expect, it } from "vitest";

import { CreateMessageInputSchema, StoredMessageSchema } from "../src/schema.js";
import {
  SensitiveContentError,
  assertNoSensitivePatterns,
  findSensitivePatterns
} from "../src/sensitive.js";
import { cleanupTemporaryDirectories, messageInput } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("message schemas", () => {
  it("normalizes supported input and rejects unknown fields", () => {
    const parsed = CreateMessageInputSchema.parse({
      topic: "  Concise topic  ",
      body: "  Useful body  "
    });
    expect(parsed).toMatchObject({
      scope: "personal",
      kind: "note",
      topic: "Concise topic",
      body: "Useful body",
      evidence: "agent_inference",
      confidence: "medium"
    });
    expect(() =>
      CreateMessageInputSchema.parse({ topic: "Topic", body: "Body", unexpected: true })
    ).toThrow();
  });

  it("requires reply messages to identify their parent", () => {
    expect(() => CreateMessageInputSchema.parse(messageInput({ kind: "reply" }))).toThrow(
      /reply_to/i
    );
  });

  it("rejects multiline topics and terminal control characters", () => {
    expect(() =>
      CreateMessageInputSchema.parse(messageInput({ topic: "first line\nsecond line" }))
    ).toThrow(/one line/i);
    expect(() =>
      CreateMessageInputSchema.parse(
        messageInput({ body: `ordinary${String.fromCharCode(27)}[2J` })
      )
    ).toThrow(/control characters/i);
    expect(() =>
      CreateMessageInputSchema.parse(
        messageInput({ body: `left${String.fromCharCode(0x202e)}right` })
      )
    ).toThrow(/control characters/i);
    expect(
      CreateMessageInputSchema.parse(messageInput({ body: "first\r\nsecond\rthird" })).body
    ).toBe("first\nsecond\nthird");
  });

  it("enforces scope and project metadata coherence", () => {
    const base = {
      schema_version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-01-01T00:00:00.000Z",
      scope: "project",
      kind: "note",
      topic: "Topic",
      body: "Body",
      tags: [],
      evidence: "human_note",
      confidence: "high",
      author: {
        client: "test",
        run_id: "00000000-0000-4000-8000-000000000002"
      },
      thread_id: "00000000-0000-4000-8000-000000000001",
      reply_to: null,
      supersedes: null
    };
    expect(() => StoredMessageSchema.parse(base)).toThrow(/project metadata/i);
    expect(() =>
      StoredMessageSchema.parse({
        ...base,
        scope: "personal",
        project: { key: "0123456789abcdef", name: "sample" }
      })
    ).toThrow(/must not include project metadata/i);
  });
});

describe("sensitive-content guard", () => {
  it.each([
    ["private_key", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
    ["github_token", `gh${"p"}_${"a".repeat(24)}`],
    ["npm_token", `npm_${"b".repeat(32)}`],
    ["openai_key", `sk-${"c".repeat(24)}`],
    ["aws_access_key", `AKIA${"D".repeat(16)}`],
    ["slack_token", `xoxb-${"e".repeat(24)}`],
    ["credential_assignment", `password=${"f".repeat(20)}`]
  ] as const)("detects %s without returning the secret", (finding, value) => {
    expect(findSensitivePatterns(value)).toContain(finding);
    try {
      assertNoSensitivePatterns(value);
      throw new Error("Expected guard to reject the value");
    } catch (error) {
      expect(error).toBeInstanceOf(SensitiveContentError);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("does not reject ordinary technical prose", () => {
    const prose = "Store the API key in the operating system keychain; never paste its value here.";
    expect(findSensitivePatterns(prose)).toEqual([]);
    expect(() => assertNoSensitivePatterns(prose)).not.toThrow();
  });
});
