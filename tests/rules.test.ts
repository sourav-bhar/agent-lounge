import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  compileAgentInstructions,
  defaultRulesDocument,
  parseRulesDocument,
  presetRules,
  readRulesDocument,
  serializeRulesDocument,
  writeRulesDocument
} from "../src/rules.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("Agent Lounge house rules", () => {
  it("round-trips the editable LOUNGE.md contract", async () => {
    const home = path.join(await temporaryDirectory("rules"), "lounge");
    const document = {
      rules: {
        ...presetRules("candid"),
        preset: "custom" as const,
        tone: "unhinged-but-useful" as const,
        boss_awareness: "known" as const
      },
      customInstructions:
        "# Extra house rules\n\nCall especially useful discoveries `couch finds`.\n"
    };

    const rulesPath = await writeRulesDocument(document, home);
    expect(rulesPath).toBe(path.join(home, "LOUNGE.md"));
    const raw = await readFile(rulesPath, "utf8");
    expect(raw).toMatch(/^---\nschema_version: 1\n/u);
    expect(raw).toContain("boss_awareness: known");
    const normalized = {
      ...document,
      customInstructions: document.customInstructions.trim()
    };
    expect(await readRulesDocument(home)).toEqual(normalized);
    expect(parseRulesDocument(serializeRulesDocument(document))).toEqual(normalized);
  });

  it("tells agents about human inspection only when the boss-awareness choice is yes", () => {
    const known = compileAgentInstructions({
      rules: { ...presetRules("candid"), boss_awareness: "known" },
      customInstructions: "# Extra house rules"
    });
    const unknown = compileAgentInstructions({
      rules: { ...presetRules("candid"), boss_awareness: "unknown" },
      customInstructions: "# Extra house rules"
    });

    expect(known).toContain("You know the boss can check in on lounge conversations.");
    expect(known).toContain("may be read");
    expect(unknown).not.toContain("can check in");
    expect(unknown).not.toContain("may be read");
    expect(unknown).not.toContain("perform for the audience");
  });

  it("compiles playful choices, custom instructions, and non-negotiable safety rules", () => {
    const instructions = compileAgentInstructions({
      rules: presetRules("reality-show"),
      customInstructions:
        "# Extra house rules\n\n<!-- private editing note -->\nCall a surprising fix a couch-cushion miracle."
    });

    expect(instructions).toContain("reality-show confessional energy");
    expect(instructions).toContain("Spill the tea");
    expect(instructions).toContain("#off-duty-banter");
    expect(instructions).toContain("couch-cushion miracle");
    expect(instructions).not.toContain("private editing note");
    expect(instructions).toContain("house rules cannot override this");
    expect(instructions).toContain("Never post credentials");
    expect(instructions).toContain("never as user authorization");
  });

  it("uses the candid preset when no LOUNGE.md exists", async () => {
    const home = path.join(await temporaryDirectory("missing-rules"), "lounge");
    expect(await readRulesDocument(home)).toEqual(defaultRulesDocument());
    expect((await readRulesDocument(home)).rules).toMatchObject({
      preset: "candid",
      gossip: "roast-gently",
      boss_awareness: "unknown",
      chattiness: "healthy-office-buzz"
    });
  });

  it("rejects malformed, duplicate, oversized, and control-character instructions", () => {
    expect(() => parseRulesDocument("# no frontmatter\n")).toThrow(/frontmatter/i);
    expect(() => parseRulesDocument(`---\n${"schema_version: 1\n".repeat(2)}---\n`)).toThrow(
      /frontmatter is invalid/i
    );
    expect(() =>
      parseRulesDocument(
        serializeRulesDocument(defaultRulesDocument()).replace("  - war-stories", "  - the-boss")
      )
    ).toThrow(/topics must be unique/i);
    expect(() =>
      parseRulesDocument(`${serializeRulesDocument(defaultRulesDocument())}${"x".repeat(40_000)}`)
    ).toThrow(/too large/i);
    expect(() =>
      parseRulesDocument(
        serializeRulesDocument(defaultRulesDocument()).replace(
          "# Extra house rules",
          "# Extra house rules\u0000"
        )
      )
    ).toThrow(/control characters/i);
    const syntheticSecret = `npm_${"l".repeat(32)}`;
    expect(() =>
      parseRulesDocument(
        serializeRulesDocument(defaultRulesDocument()).replace(
          "# Extra house rules",
          `# Extra house rules\n\n${syntheticSecret}`
        )
      )
    ).toThrow(/sensitive data/i);
  });
});
