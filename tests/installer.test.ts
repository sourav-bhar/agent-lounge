import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectClients,
  getInstallationHealth,
  getInstallState,
  installAgentBoard,
  uninstallAgentBoard
} from "../src/installer.js";
import { VERSION } from "../src/version.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.js";

const managedEnvironmentKeys = [
  "PATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "FAKE_MCP_STATE_DIR",
  "FAKE_MCP_LOG",
  "FAKE_PACKAGE_VERSION"
] as const;

let originalEnvironment: Record<string, string | undefined>;
let fixtureRoot: string;
let boardHome: string;
let stateDirectory: string;
let logPath: string;
let codexHome: string;
let claudeHome: string;

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(
    managedEnvironmentKeys.map((key) => [key, process.env[key]])
  );
  fixtureRoot = await temporaryDirectory("installer");
  boardHome = join(fixtureRoot, "board");
  stateDirectory = join(fixtureRoot, "fake-state");
  logPath = join(fixtureRoot, "commands.jsonl");
  codexHome = join(fixtureRoot, "codex-home");
  claudeHome = join(fixtureRoot, "claude-home");
  const bin = join(fixtureRoot, "bin");
  await createFakeClients(bin);
  await mkdir(stateDirectory, { recursive: true });
  process.env.PATH = `${bin}${delimiter}${originalEnvironment.PATH ?? ""}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.FAKE_MCP_STATE_DIR = stateDirectory;
  process.env.FAKE_MCP_LOG = logPath;
  process.env.FAKE_PACKAGE_VERSION = VERSION;
});

afterEach(async () => {
  for (const key of managedEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupTemporaryDirectories();
});

describe("agent client installer", () => {
  it("detects supported clients and produces a side-effect-free dry run", async () => {
    expect(detectClients()).toEqual(["codex", "claude"]);
    const report = await installAgentBoard({
      home: boardHome,
      clients: ["codex", "claude"],
      dryRun: true
    });
    expect(report.ok).toBe(true);
    expect(report.actions).toHaveLength(4);
    expect(report.actions.every((action) => action.status === "planned")).toBe(true);
    await expect(stat(boardHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(codexHome, "skills", "agent-board"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await commandLog()).not.toContainEqual(
      expect.objectContaining({ args: expect.arrayContaining(["add"]) })
    );
  });

  it("installs and idempotently updates exact user-level MCP commands and skills", async () => {
    const first = await installAgentBoard({
      home: boardHome,
      clients: ["codex", "claude"]
    });
    expect(first.ok).toBe(true);
    expect(first.actions.map((action) => action.action)).toEqual([
      "add_mcp",
      "install_skill",
      "add_mcp",
      "install_skill"
    ]);

    const log = await commandLog();
    expect(log).toContainEqual({
      client: "codex",
      args: [
        "mcp",
        "add",
        "agent-board",
        "--env",
        "AGENT_BOARD_CLIENT=codex",
        "--",
        "npx",
        "-y",
        `agent-board@${VERSION}`,
        "mcp"
      ]
    });
    expect(log).toContainEqual({
      client: "claude",
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        "agent-board",
        "--env",
        "AGENT_BOARD_CLIENT=claude-code",
        "--",
        "npx",
        "-y",
        `agent-board@${VERSION}`,
        "mcp"
      ]
    });
    expect(await readFile(join(codexHome, "skills", "agent-board", "SKILL.md"), "utf8")).toContain(
      "managed-by: agent-board"
    );
    expect(await readFile(join(claudeHome, "skills", "agent-board", "SKILL.md"), "utf8")).toContain(
      "managed-by: agent-board"
    );
    expect(Object.keys((await getInstallState(boardHome)).clients).sort()).toEqual([
      "claude",
      "codex"
    ]);
    expect(await getInstallationHealth(boardHome)).toEqual([
      expect.objectContaining({ client: "codex", ok: true }),
      expect.objectContaining({ client: "claude", ok: true })
    ]);

    const second = await installAgentBoard({
      home: boardHome,
      clients: ["codex", "claude"]
    });
    expect(second.actions.map((action) => action.action)).toEqual([
      "replace_mcp",
      "add_mcp",
      "update_skill",
      "replace_mcp",
      "add_mcp",
      "update_skill"
    ]);
  });

  it("preserves foreign MCP configurations unless force is explicit", async () => {
    await writeFakeState("codex", "foreign");
    await expect(installAgentBoard({ home: boardHome, clients: ["codex"] })).rejects.toThrow(
      /different command/i
    );
    expect(await readFakeState("codex")).toBe("foreign");

    const forced = await installAgentBoard({
      home: boardHome,
      clients: ["codex"],
      force: true
    });
    expect(forced.actions.map((action) => action.action)).toEqual([
      "replace_mcp",
      "add_mcp",
      "install_skill"
    ]);
    expect(await readFakeState("codex")).toBe("managed");
  });

  it("backs up an unrecognized companion skill only when force is explicit", async () => {
    const skillPath = join(codexHome, "skills", "agent-board");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "# User-owned skill\n", "utf8");
    await expect(installAgentBoard({ home: boardHome, clients: ["codex"] })).rejects.toThrow(
      /unrecognized agent-board skill/i
    );
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toContain("User-owned");

    const report = await installAgentBoard({
      home: boardHome,
      clients: ["codex"],
      force: true
    });
    expect(report.warnings.join(" ")).toMatch(/preserved the existing skill/i);
    const siblings = await readdir(join(codexHome, "skills"));
    const backup = siblings.find((entry) => entry.startsWith("agent-board.backup-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(codexHome, "skills", backup!, "SKILL.md"), "utf8")).toContain(
      "User-owned"
    );
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toContain(
      "managed-by: agent-board"
    );
  });

  it("uninstalls managed integration files but preserves board data", async () => {
    await installAgentBoard({ home: boardHome, clients: ["codex"] });
    const report = await uninstallAgentBoard({ home: boardHome, clients: ["codex"] });
    expect(report.ok).toBe(true);
    expect(report.actions.map((action) => action.action)).toEqual(["remove_mcp", "remove_skill"]);
    expect(await readFakeState("codex")).toBeNull();
    await expect(stat(join(codexHome, "skills", "agent-board"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await stat(join(boardHome, ".agent-board-store"))).toBeTruthy();
    expect((await getInstallState(boardHome)).clients.codex).toBeUndefined();
  });

  it("does not remove a user-modified command without an explicit force", async () => {
    await installAgentBoard({ home: boardHome, clients: ["codex"] });
    await writeFakeState("codex", "foreign");
    expect(await getInstallationHealth(boardHome)).toEqual([
      expect.objectContaining({
        client: "codex",
        ok: false,
        configured: true,
        command_matches: false
      })
    ]);
    const preserved = await uninstallAgentBoard({ home: boardHome, clients: ["codex"] });
    expect(preserved.ok).toBe(false);
    expect(preserved.warnings.join(" ")).toMatch(/preserved/i);
    expect(await readFakeState("codex")).toBe("foreign");
    expect((await getInstallState(boardHome)).clients.codex).toBeDefined();

    const forced = await uninstallAgentBoard({
      home: boardHome,
      clients: ["codex"],
      force: true
    });
    expect(forced.ok).toBe(true);
    expect(await readFakeState("codex")).toBeNull();
    expect((await getInstallState(boardHome)).clients.codex).toBeUndefined();
  });

  it("fails closed when installation state is malformed", async () => {
    await mkdir(boardHome, { recursive: true });
    await writeFile(join(boardHome, "install-state.json"), "{}\n", "utf8");
    await expect(getInstallState(boardHome)).rejects.toThrow(/installation state is invalid/i);
  });
});

async function createFakeClients(bin: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  const script = join(bin, "fake-client.mjs");
  await writeFile(
    script,
    `import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const client = process.argv[2];
const args = process.argv.slice(3);
const statePath = join(process.env.FAKE_MCP_STATE_DIR, client + ".txt");
appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ client, args }) + "\\n");
if (args[0] === "--version") process.exit(0);
if (args[0] !== "mcp") process.exit(2);
if (args[1] === "get") {
  if (!existsSync(statePath)) process.exit(1);
  const mode = readFileSync(statePath, "utf8").trim();
  const version = process.env.FAKE_PACKAGE_VERSION;
  if (client === "codex") {
    const managed = mode === "managed";
    process.stdout.write(JSON.stringify({
      transport: {
        type: "stdio",
        command: managed ? "npx" : "different-command",
        args: managed ? ["-y", "agent-board@" + version, "mcp"] : ["--other"],
        env: { AGENT_BOARD_CLIENT: managed ? "codex" : "other" }
      }
    }));
  } else {
    const managed = mode === "managed";
    process.stdout.write([
      "agent-board:",
      "  Scope: User config (available in all your projects)",
      "  Status: " + (managed ? "Connected" : "Failed"),
      "  Type: stdio",
      "  Command: " + (managed ? "npx" : "different-command"),
      "  Args: " + (managed ? "-y agent-board@" + version + " mcp" : "--other"),
      "  Environment:",
      "    AGENT_BOARD_CLIENT=" + (managed ? "claude-code" : "other")
    ].join("\\n"));
  }
  process.exit(0);
}
if (args[1] === "add") {
  writeFileSync(statePath, "managed\\n");
  process.exit(0);
}
if (args[1] === "remove") {
  if (existsSync(statePath)) unlinkSync(statePath);
  process.exit(0);
}
process.exit(2);
`,
    "utf8"
  );

  for (const client of ["codex", "claude"]) {
    if (process.platform === "win32") {
      await writeFile(
        join(bin, `${client}.cmd`),
        `@"${process.execPath}" "${script}" ${client} %*\r\n`,
        "utf8"
      );
    } else {
      const wrapper = join(bin, client);
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec "${process.execPath}" "${script}" ${client} "$@"\n`,
        "utf8"
      );
      await chmod(wrapper, 0o700);
    }
  }
}

async function commandLog(): Promise<Array<{ client: string; args: string[] }>> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { client: string; args: string[] });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeFakeState(client: "codex" | "claude", value: "managed" | "foreign") {
  await writeFile(join(stateDirectory, `${client}.txt`), `${value}\n`, "utf8");
}

async function readFakeState(client: "codex" | "claude"): Promise<string | null> {
  try {
    return (await readFile(join(stateDirectory, `${client}.txt`), "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
