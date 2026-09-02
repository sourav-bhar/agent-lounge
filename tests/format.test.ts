import { describe, expect, it } from "vitest";

import {
  formatMessage,
  formatPage,
  formatStoredMessage,
  jsonString,
  shortId,
  terminalSafe
} from "../src/format.js";
import type { MessageView, StoredMessage } from "../src/schema.js";

const message: StoredMessage = {
  schema_version: 1,
  id: "00000000-0000-4000-8000-000000000001",
  created_at: "2026-01-02T03:04:05.000Z",
  scope: "personal",
  kind: "lesson",
  topic: "Use focused checks",
  body: "Run the smallest useful test first.",
  tags: ["testing", "workflow"],
  evidence: "observed_success",
  confidence: "high",
  author: {
    client: "test",
    run_id: "00000000-0000-4000-8000-000000000002"
  },
  thread_id: "00000000-0000-4000-8000-000000000001",
  reply_to: null,
  supersedes: null
};

describe("terminal formatting", () => {
  it("renders complete plain-text message metadata", () => {
    const output = formatStoredMessage(message, { color: false });
    expect(output).toContain("Use focused checks");
    expect(output).toContain("Run the smallest useful test first.");
    expect(output).toContain("observed success");
    expect(output).toContain("#testing #workflow");
    expect(output).not.toMatch(/\u001b\[/);
  });

  it("renders curation and relationship signals", () => {
    const view: MessageView = {
      message: {
        ...message,
        reply_to: "00000000-0000-4000-8000-000000000003",
        supersedes: "00000000-0000-4000-8000-000000000004"
      },
      curation: {
        schema_version: 1,
        message_id: message.id,
        state: "hidden",
        updated_at: "2026-01-02T04:00:00.000Z"
      }
    };
    const output = formatMessage(view, { color: false, includeBody: false });
    expect(output).not.toContain(message.body);
    expect(output).toContain("reply to 00000000");
    expect(output).toContain("supersedes 00000000");
    expect(output).toContain("hidden from normal reads");
  });

  it("renders empty and paginated pages", () => {
    expect(
      formatPage(
        {
          items: [],
          total: 0,
          count: 0,
          offset: 0,
          has_more: false,
          next_offset: null,
          warnings: []
        },
        { color: false }
      )
    ).toBe("No messages found.");
    const output = formatPage(
      {
        items: [{ message, curation: null }],
        total: 3,
        count: 1,
        offset: 1,
        has_more: true,
        next_offset: 2,
        warnings: []
      },
      { color: true }
    );
    expect(output).toContain("Showing 2–2 of 3");
    expect(output).toContain("--offset 2");
  });

  it("provides stable JSON and short IDs", () => {
    expect(jsonString({ ok: true })).toBe('{\n  "ok": true\n}\n');
    expect(shortId(message.id)).toBe("00000000");
  });

  it("neutralizes terminal and bidirectional control sequences", () => {
    const hostile = `before${String.fromCharCode(27)}[2J${String.fromCharCode(0x202e)}after`;
    const safe = terminalSafe(hostile);
    expect(safe).toBe("before�[2J�after");
    expect(safe).not.toContain(String.fromCharCode(27));
    expect(safe).not.toContain(String.fromCharCode(0x202e));
  });
});
