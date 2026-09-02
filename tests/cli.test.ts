import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryProject } from "./helpers.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "src", "cli.ts");

let home: string;
let projectRoot: string;

beforeEach(async () => {
  home = path.join(await temporaryDirectory("cli"), "board");
  projectRoot = await temporaryProject("cli-project");
});

afterEach(cleanupTemporaryDirectories);

describe("agent-lounge CLI", () => {
  it("offers concise help and stable JSON initialization and diagnostics", async () => {
    const version = await runCli(["--version"]);
    expect(version).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: "" });

    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("agent-lounge");
    expect(help.stdout).toContain("doctor");
    expect(help.stdout).toContain("messages");
    expect(help.stdout).toContain("setup");
    expect(help.stdout).toContain("rules");
    expect(help.stdout).toContain("ui");

    const before = await runJson(["doctor"]);
    expect(before.result.code).toBe(1);
    expect(before.json).toMatchObject({ ok: false, initialized: false });

    const initialized = await runJson(["init"]);
    expect(initialized.result.code).toBe(0);
    expect(initialized.json).toMatchObject({ ok: true, home });
    const doctor = await runJson(["doctor"]);
    expect(doctor.result.code).toBe(0);
    expect(doctor.json).toMatchObject({ ok: true, initialized: true, message_count: 0 });
  });

  it("configures presets non-interactively and previews the exact agent instructions", async () => {
    const setup = await runJson(["setup", "--preset", "helpful"]);
    expect(setup.result.code).toBe(0);
    expect(setup.json).toMatchObject({
      ok: true,
      path: path.join(home, "LOUNGE.md"),
      rules: {
        preset: "helpful",
        gossip: "closed",
        boss_awareness: "known",
        chattiness: "quiet-professionals"
      }
    });
    expect((await runJson(["doctor"])).json).toMatchObject({
      ok: true,
      initialized: true,
      rules: { ok: true }
    });

    const checked = await runJson(["rules", "check"]);
    expect(checked.result.code).toBe(0);
    const preview = checked.json as { compiled_instructions: string };
    expect(preview.compiled_instructions).toContain(
      "You know the boss can check in on lounge conversations."
    );

    const candid = await runJson(["setup", "--yes"]);
    expect(candid.json).toMatchObject({
      rules: { preset: "candid", boss_awareness: "unknown", gossip: "roast-gently" }
    });
    const candidPreview = (await runJson(["rules", "check"])).json as {
      compiled_instructions: string;
    };
    expect(candidPreview.compiled_instructions).not.toContain(
      "can check in on lounge conversations"
    );
  });

  it("requires an explicit preset when setup cannot open a terminal UI", async () => {
    const result = await runJson(["setup"]);
    expect(result.result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false });
    expect(JSON.stringify(result.json)).toMatch(/interactive setup needs a terminal/i);

    const missingRules = await runJson(["rules", "check"]);
    expect(missingRules.result.code).toBe(1);
    expect(JSON.stringify(missingRules.json)).toMatch(/LOUNGE\.md is missing/i);
  });

  it("posts, searches, shows, trashes, and restores one message", async () => {
    const posted = await runJson([
      "messages",
      "post",
      "--scope",
      "personal",
      "--kind",
      "preference",
      "--topic",
      "Prefer narrow validation",
      "--body",
      "Run the focused test before the full suite.",
      "--tag",
      "testing",
      "--evidence",
      "explicit_user_statement",
      "--confidence",
      "high"
    ]);
    expect(posted.result.code).toBe(0);
    const id = (posted.json as { message: { id: string } }).message.id;

    const searched = await runJson(["messages", "search", "narrow full", "--scope", "all"]);
    expect(searched.json).toMatchObject({ total: 1, count: 1 });
    const shown = await runJson(["messages", "show", id]);
    expect(shown.json).toMatchObject({ item: { message: { id } } });

    const unconfirmed = await runJson(["messages", "delete", id]);
    expect(unconfirmed.result.code).toBe(1);
    expect(unconfirmed.json).toMatchObject({ ok: false });
    const deleted = await runJson(["messages", "delete", id, "--yes"]);
    expect(deleted.json).toMatchObject({ ok: true, message_id: id, recoverable: true });
    expect((await runJson(["messages", "list", "--scope", "all"])).json).toMatchObject({
      total: 0
    });
    const restored = await runJson(["messages", "restore", id]);
    expect(restored.json).toMatchObject({ message: { id } });
  });

  it("emits machine-readable errors with no ANSI escapes", async () => {
    const invalid = await runJson([
      "messages",
      "post",
      "--scope",
      "personal",
      "--kind",
      "reply",
      "--topic",
      "Missing parent",
      "--body",
      "Body",
      "--evidence",
      "agent_inference",
      "--confidence",
      "low"
    ]);
    expect(invalid.result.code).toBe(1);
    expect(invalid.json).toMatchObject({ ok: false });
    expect(JSON.stringify(invalid.json)).toMatch(/reply_to/i);
    expect(invalid.result.stdout).not.toMatch(/\u001b\[/);
    expect(invalid.result.stderr).toBe("");
  });

  it("preserves every post across concurrent CLI processes", async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        runCli([
          "messages",
          "post",
          "--scope",
          "project",
          "--kind",
          "lesson",
          "--topic",
          `Process note ${index}`,
          "--body",
          `Independent process body ${index}`,
          "--tag",
          "concurrency",
          "--evidence",
          "observed_success",
          "--confidence",
          "medium"
        ])
      )
    );
    expect(results.every((result) => result.code === 0)).toBe(true);
    const listed = await runJson(["messages", "list", "--scope", "project", "--limit", "100"]);
    const page = listed.json as { total: number; items: Array<{ message: { id: string } }> };
    expect(page.total).toBe(24);
    expect(new Set(page.items.map((item) => item.message.id)).size).toBe(24);
  });
});

async function runJson(args: string[]) {
  const result = await runCli(["--json", ...args]);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  return { result, json: JSON.parse(result.stdout) as unknown };
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "--home",
        home,
        "--project-root",
        projectRoot,
        "--no-color",
        ...args
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
