import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectClients,
  getInstallationHealth,
  getInstallState,
  installAgentLounge,
  uninstallAgentLounge
} from "../src/installer.js";
import { PACKAGE_NAME } from "../src/constants.js";
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
    const report = await installAgentLounge({
      home: boardHome,
      clients: ["codex", "claude"],
      dryRun: true
    });
    expect(report.ok).toBe(true);
    expect(report.actions).toHaveLength(4);
    expect(report.actions.every((action) => action.status === "planned")).toBe(true);
    await expect(stat(boardHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(codexHome, "skills", "agent-lounge"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await commandLog()).not.toContainEqual(
      expect.objectContaining({ args: expect.arrayContaining(["add"]) })
    );
  });

  it("installs and idempotently updates exact user-level MCP commands and skills", async () => {
    const first = await installAgentLounge({
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
        "agent-lounge",
        "--env",
        "AGENT_LOUNGE_CLIENT=codex",
        "--",
        "npx",
        "-y",
        `${PACKAGE_NAME}@${VERSION}`,
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
        "agent-lounge",
        "--env",
        "AGENT_LOUNGE_CLIENT=claude-code",
        "--",
        "npx",
        "-y",
        `${PACKAGE_NAME}@${VERSION}`,
        "mcp"
      ]
    });
    const codexSkill = await readFile(
      join(codexHome, "skills", "agent-lounge", "SKILL.md"),
      "utf8"
    );
    const claudeSkill = await readFile(
      join(claudeHome, "skills", "agent-lounge", "SKILL.md"),
      "utf8"
    );
    expect(codexSkill).toContain("managed-by: agent-lounge");
    expect(claudeSkill).toContain("managed-by: agent-lounge");
    expect(codexSkill).toContain("Use proactively near the start of substantial work");
    expect(claudeSkill).toContain("Use proactively near the start of substantial work");
    expect(Object.keys((await getInstallState(boardHome)).clients).sort()).toEqual([
      "claude",
      "codex"
    ]);
    expect(await getInstallationHealth(boardHome)).toEqual([
      expect.objectContaining({ client: "codex", ok: true }),
      expect.objectContaining({ client: "claude", ok: true })
    ]);

    const second = await installAgentLounge({
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

  it("updates an exact older Agent Lounge version without requiring force", async () => {
    process.env.FAKE_PACKAGE_VERSION = "0.2.0";
    await writeFakeState("codex", "managed");
    await writeFakeState("claude", "managed");

    const report = await installAgentLounge({
      home: boardHome,
      clients: ["codex", "claude"]
    });

    expect(report.actions.map((action) => action.action)).toEqual([
      "replace_mcp",
      "add_mcp",
      "install_skill",
      "replace_mcp",
      "add_mcp",
      "install_skill"
    ]);
    const log = await commandLog();
    expect(log).toContainEqual({
      client: "codex",
      args: expect.arrayContaining([`${PACKAGE_NAME}@${VERSION}`])
    });
    expect(log).toContainEqual({
      client: "claude",
      args: expect.arrayContaining([`${PACKAGE_NAME}@${VERSION}`])
    });
  });

  it("does not treat a mutable package tag as an installer-managed command", async () => {
    process.env.FAKE_PACKAGE_VERSION = "latest";
    await writeFakeState("codex", "managed");
    await writeFakeState("claude", "managed");

    await expect(installAgentLounge({ home: boardHome, clients: ["codex"] })).rejects.toThrow(
      /different command/i
    );
    await expect(installAgentLounge({ home: boardHome, clients: ["claude"] })).rejects.toThrow(
      /different command/i
    );
  });

  it("migrates managed Agent Board MCP entries and companion skills in place", async () => {
    await writeFakeState("codex", "legacy-managed", "agent-board");
    await writeFakeState("claude", "legacy-managed", "agent-board");
    const legacySkillPaths = [
      join(codexHome, "skills", "agent-board"),
      join(claudeHome, "skills", "agent-board")
    ];
    for (const legacySkillPath of legacySkillPaths) {
      await mkdir(legacySkillPath, { recursive: true });
      await writeFile(
        join(legacySkillPath, "SKILL.md"),
        "---\nname: agent-board\n---\n\n<!-- managed-by: agent-board -->\n",
        "utf8"
      );
    }

    const report = await installAgentLounge({
      home: boardHome,
      clients: ["codex", "claude"]
    });

    expect(report.actions.map((action) => action.action)).toEqual([
      "migrate_mcp",
      "add_mcp",
      "install_skill",
      "remove_legacy_skill",
      "migrate_mcp",
      "add_mcp",
      "install_skill",
      "remove_legacy_skill"
    ]);
    expect(await readFakeState("codex", "agent-board")).toBeNull();
    expect(await readFakeState("codex", "agent-lounge")).toBe("managed");
    expect(await readFakeState("claude", "agent-board")).toBeNull();
    expect(await readFakeState("claude", "agent-lounge")).toBe("managed");
    for (const legacySkillPath of legacySkillPaths) {
      await expect(stat(legacySkillPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(codexHome, "skills", "agent-lounge", "SKILL.md"), "utf8")).toContain(
      "managed-by: agent-lounge"
    );
    expect(
      await readFile(join(claudeHome, "skills", "agent-lounge", "SKILL.md"), "utf8")
    ).toContain("managed-by: agent-lounge");
  });

  it("preserves foreign MCP configurations unless force is explicit", async () => {
    await writeFakeState("codex", "foreign");
    await expect(installAgentLounge({ home: boardHome, clients: ["codex"] })).rejects.toThrow(
      /different command/i
    );
    expect(await readFakeState("codex")).toBe("foreign");

    const forced = await installAgentLounge({
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
    const skillPath = join(codexHome, "skills", "agent-lounge");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "# User-owned skill\n", "utf8");
    await expect(installAgentLounge({ home: boardHome, clients: ["codex"] })).rejects.toThrow(
      /unrecognized agent-lounge skill/i
    );
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toContain("User-owned");

    const report = await installAgentLounge({
      home: boardHome,
      clients: ["codex"],
      force: true
    });
    expect(report.warnings.join(" ")).toMatch(/preserved the existing skill/i);
    const siblings = await readdir(join(codexHome, "skills"));
    const backup = siblings.find((entry) => entry.startsWith("agent-lounge.backup-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(codexHome, "skills", backup!, "SKILL.md"), "utf8")).toContain(
      "User-owned"
    );
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toContain(
      "managed-by: agent-lounge"
    );
  });

  it("uninstalls managed integration files but preserves board data", async () => {
    await installAgentLounge({ home: boardHome, clients: ["codex"] });
    const report = await uninstallAgentLounge({ home: boardHome, clients: ["codex"] });
    expect(report.ok).toBe(true);
    expect(report.actions.map((action) => action.action)).toEqual(["remove_mcp", "remove_skill"]);
    expect(await readFakeState("codex")).toBeNull();
    await expect(stat(join(codexHome, "skills", "agent-lounge"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await stat(join(boardHome, ".agent-lounge-store"))).toBeTruthy();
    expect((await getInstallState(boardHome)).clients.codex).toBeUndefined();
  });

  it("does not remove a user-modified command without an explicit force", async () => {
    await installAgentLounge({ home: boardHome, clients: ["codex"] });
    await writeFakeState("codex", "foreign");
    expect(await getInstallationHealth(boardHome)).toEqual([
      expect.objectContaining({
        client: "codex",
        ok: false,
        configured: true,
        command_matches: false
      })
    ]);
    const preserved = await uninstallAgentLounge({ home: boardHome, clients: ["codex"] });
    expect(preserved.ok).toBe(false);
    expect(preserved.warnings.join(" ")).toMatch(/preserved/i);
    expect(await readFakeState("codex")).toBe("foreign");
    expect((await getInstallState(boardHome)).clients.codex).toBeDefined();

    const forced = await uninstallAgentLounge({
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
appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ client, args }) + "\\n");
if (args[0] === "--version") process.exit(0);
if (args[0] !== "mcp") process.exit(2);
if (args[1] === "get") {
  const configName = args[2];
  const statePath = join(process.env.FAKE_MCP_STATE_DIR, client + "-" + configName + ".txt");
  if (!existsSync(statePath)) process.exit(1);
  const mode = readFileSync(statePath, "utf8").trim();
  const version = process.env.FAKE_PACKAGE_VERSION;
  if (client === "codex") {
    const managed = mode === "managed";
    const legacy = mode === "legacy-managed";
    process.stdout.write(JSON.stringify({
      transport: {
        type: "stdio",
        command: managed || legacy ? "npx" : "different-command",
        args: managed
          ? ["-y", "agent-lounge@" + version, "mcp"]
          : legacy
            ? ["-y", "@souravbhar/agent-board@0.1.0", "mcp"]
            : ["--other"],
        env: managed
          ? { AGENT_LOUNGE_CLIENT: "codex" }
          : legacy
            ? { AGENT_BOARD_CLIENT: "codex" }
            : { AGENT_LOUNGE_CLIENT: "other" }
      }
    }));
  } else {
    const managed = mode === "managed";
    const legacy = mode === "legacy-managed";
    process.stdout.write([
      configName + ":",
      "  Scope: User config (available in all your projects)",
      "  Status: " + (managed || legacy ? "Connected" : "Failed"),
      "  Type: stdio",
      "  Command: " + (managed || legacy ? "npx" : "different-command"),
      "  Args: " +
        (managed
          ? "-y agent-lounge@" + version + " mcp"
          : legacy
            ? "-y @souravbhar/agent-board@0.1.0 mcp"
            : "--other"),
      "  Environment:",
      managed
        ? "    AGENT_LOUNGE_CLIENT=claude-code"
        : legacy
          ? "    AGENT_BOARD_CLIENT=claude-code"
          : "    AGENT_LOUNGE_CLIENT=other"
    ].join("\\n"));
  }
  process.exit(0);
}
if (args[1] === "add") {
  const configName = args.includes("agent-lounge") ? "agent-lounge" : "agent-board";
  const statePath = join(process.env.FAKE_MCP_STATE_DIR, client + "-" + configName + ".txt");
  writeFileSync(statePath, "managed\\n");
  process.exit(0);
}
if (args[1] === "remove") {
  const configName = args[2];
  const statePath = join(process.env.FAKE_MCP_STATE_DIR, client + "-" + configName + ".txt");
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

async function writeFakeState(
  client: "codex" | "claude",
  value: "managed" | "legacy-managed" | "foreign",
  configName = "agent-lounge"
) {
  await writeFile(join(stateDirectory, `${client}-${configName}.txt`), `${value}\n`, "utf8");
}

async function readFakeState(
  client: "codex" | "claude",
  configName = "agent-lounge"
): Promise<string | null> {
  try {
    return (await readFile(join(stateDirectory, `${client}-${configName}.txt`), "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
