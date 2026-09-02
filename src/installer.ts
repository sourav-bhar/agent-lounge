import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

import {
  LEGACY_MCP_SERVER_CONFIG_NAME,
  LEGACY_PACKAGE_NAME,
  MCP_SERVER_CONFIG_NAME,
  PACKAGE_NAME,
  STORE_SCHEMA_VERSION
} from "./constants.js";
import { atomicWriteJson, pathExists } from "./fs-utils.js";
import { defaultStoreHome, getStorePaths, legacyStoreHome, resolveStoreHome } from "./paths.js";
import { writeRulesDocument, type LoungeRulesDocument } from "./rules.js";
import { AgentLoungeStore } from "./storage.js";
import { VERSION } from "./version.js";

export const AgentClientSchema = z.enum(["codex", "claude"]);
export type AgentClient = z.infer<typeof AgentClientSchema>;

const ManagedClientSchema = z
  .object({
    package_version: z.string(),
    installed_at: z.string().datetime({ offset: true }),
    skill_path: z.string(),
    command: z.array(z.string())
  })
  .strict();

const InstallStateSchema = z
  .object({
    schema_version: z.literal(STORE_SCHEMA_VERSION),
    updated_at: z.string().datetime({ offset: true }),
    clients: z
      .object({
        codex: ManagedClientSchema.optional(),
        claude: ManagedClientSchema.optional()
      })
      .strict()
  })
  .strict();

type InstallState = z.infer<typeof InstallStateSchema>;

interface McpServerStatus {
  exists: boolean;
  matchesManagedCommand: boolean;
}

export interface InstallOptions {
  home?: string;
  clients?: AgentClient[];
  dryRun?: boolean;
  force?: boolean;
  rulesDocument?: LoungeRulesDocument;
}

export interface InstallAction {
  client: AgentClient;
  action:
    | "add_mcp"
    | "replace_mcp"
    | "migrate_mcp"
    | "install_skill"
    | "update_skill"
    | "remove_legacy_skill"
    | "remove_mcp"
    | "remove_skill";
  status: "planned" | "done" | "skipped";
  detail: string;
}

export interface InstallReport {
  ok: boolean;
  package_version: string;
  clients: AgentClient[];
  actions: InstallAction[];
  warnings: string[];
  rules_path: string;
}

export interface InstallationHealth {
  client: AgentClient;
  available: boolean;
  configured: boolean;
  command_matches: boolean;
  skill_managed: boolean;
  ok: boolean;
  issues: string[];
}

export async function installAgentLounge(options: InstallOptions = {}): Promise<InstallReport> {
  const paths = getStorePaths(resolveStoreHome(options.home));
  const state = await readInstallStateForInstall(paths.home, paths.installState);
  const clients = options.clients ?? detectClients();
  if (clients.length === 0) {
    throw new Error(
      "No supported agent clients were found. Install Codex or Claude Code, or use --client."
    );
  }
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const nextState: InstallState = structuredClone(state);
  const plans: Array<{
    client: AgentClient;
    status: McpServerStatus;
    legacyStatus: McpServerStatus;
    addCommand: string[];
    skillPath: string;
    legacySkillPath: string;
  }> = [];

  for (const client of [...new Set(clients)]) {
    AgentClientSchema.parse(client);
    if (!(await commandAvailable(clientCommand(client)))) {
      throw new Error(`${displayClient(client)} is not installed or is not available on PATH.`);
    }
    const [status, legacyStatus] = await Promise.all([
      inspectMcpServer(client, MCP_SERVER_CONFIG_NAME, "current"),
      inspectMcpServer(client, LEGACY_MCP_SERVER_CONFIG_NAME, "legacy")
    ]);
    if (status.exists && !status.matchesManagedCommand && !options.force) {
      throw new Error(
        `${displayClient(client)} already has an MCP server named '${MCP_SERVER_CONFIG_NAME}' with a different command. Re-run with --force only if replacing it is intentional.`
      );
    }
    const skillPath = skillTarget(client);
    const legacySkillPath = legacySkillTarget(client);
    await assertSkillInstallable(client, skillPath, options.force ?? false);
    plans.push({
      client,
      status,
      legacyStatus,
      addCommand: mcpAddCommand(client),
      skillPath,
      legacySkillPath
    });
  }

  if (!options.dryRun) {
    await new AgentLoungeStore({ home: paths.home, client: "installer" }).initialize();
    if (options.rulesDocument) await writeRulesDocument(options.rulesDocument, paths.home);
  }

  for (const { client, status, legacyStatus, addCommand, skillPath, legacySkillPath } of plans) {
    if (legacyStatus.exists && legacyStatus.matchesManagedCommand) {
      actions.push({
        client,
        action: "migrate_mcp",
        status: options.dryRun ? "planned" : "done",
        detail: `${LEGACY_MCP_SERVER_CONFIG_NAME} → ${MCP_SERVER_CONFIG_NAME}`
      });
      if (!options.dryRun) await removeMcpServer(client, LEGACY_MCP_SERVER_CONFIG_NAME);
    }
    if (status.exists) {
      actions.push({
        client,
        action: "replace_mcp",
        status: options.dryRun ? "planned" : "done",
        detail: `Replace ${MCP_SERVER_CONFIG_NAME} with ${PACKAGE_NAME}@${VERSION}`
      });
      if (!options.dryRun) await removeMcpServer(client, MCP_SERVER_CONFIG_NAME);
    }

    if (!options.dryRun) await runCommand(addCommand[0], addCommand.slice(1));
    actions.push({
      client,
      action: "add_mcp",
      status: options.dryRun ? "planned" : "done",
      detail: addCommand.join(" ")
    });

    const skillStatus = await installSkill(client, skillPath, {
      dryRun: options.dryRun ?? false,
      force: options.force ?? false,
      warnings
    });
    actions.push({
      client,
      action: skillStatus === "installed" ? "install_skill" : "update_skill",
      status: options.dryRun ? "planned" : "done",
      detail: skillPath
    });

    if (await isLegacyManagedSkill(legacySkillPath)) {
      if (!options.dryRun) await rm(legacySkillPath, { recursive: true, force: false });
      actions.push({
        client,
        action: "remove_legacy_skill",
        status: options.dryRun ? "planned" : "done",
        detail: legacySkillPath
      });
    }

    nextState.clients[client] = {
      package_version: VERSION,
      installed_at: new Date().toISOString(),
      skill_path: skillPath,
      command: addCommand
    };
    nextState.updated_at = new Date().toISOString();
    if (!options.dryRun) await atomicWriteJson(paths.installState, nextState);
  }

  return {
    ok: true,
    package_version: VERSION,
    clients,
    actions,
    warnings,
    rules_path: paths.rules
  };
}

async function assertSkillInstallable(
  client: AgentClient,
  target: string,
  force: boolean
): Promise<void> {
  if ((await pathExists(target)) && !(await isManagedSkill(target)) && !force) {
    throw new Error(
      `${displayClient(client)} already has an unrecognized agent-lounge skill at ${target}. Re-run with --force to preserve it as a timestamped backup.`
    );
  }
}

export async function uninstallAgentLounge(options: InstallOptions = {}): Promise<InstallReport> {
  const paths = getStorePaths(resolveStoreHome(options.home));
  const state = await readInstallState(paths.installState);
  const managedClients = (Object.keys(state.clients) as AgentClient[]).filter(
    (client) => state.clients[client] !== undefined
  );
  const clients = options.clients ?? managedClients;
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const nextState: InstallState = structuredClone(state);

  for (const client of [...new Set(clients)]) {
    const managed = state.clients[client];
    if (!managed) {
      actions.push({
        client,
        action: "remove_mcp",
        status: "skipped",
        detail: "No Agent Lounge-managed installation was recorded."
      });
      continue;
    }
    if (await commandAvailable(clientCommand(client))) {
      const status = await inspectMcpServer(client, MCP_SERVER_CONFIG_NAME, "current");
      if (status.exists && !status.matchesManagedCommand && !options.force) {
        warnings.push(
          `Preserved ${displayClient(client)}'s '${MCP_SERVER_CONFIG_NAME}' MCP server because its command is no longer managed by Agent Lounge. Re-run with --force to remove it.`
        );
        continue;
      }
      if (!options.dryRun && status.exists) {
        await removeMcpServer(client, MCP_SERVER_CONFIG_NAME);
      }
      actions.push({
        client,
        action: "remove_mcp",
        status: options.dryRun ? "planned" : "done",
        detail: MCP_SERVER_CONFIG_NAME
      });
    } else {
      warnings.push(
        `${displayClient(client)} is not available, so its MCP configuration was not removed.`
      );
      continue;
    }

    const skillPath = managed.skill_path;
    if (await isManagedSkill(skillPath)) {
      if (!options.dryRun) await rm(skillPath, { recursive: true, force: false });
      actions.push({
        client,
        action: "remove_skill",
        status: options.dryRun ? "planned" : "done",
        detail: skillPath
      });
    } else if (await pathExists(skillPath)) {
      warnings.push(`Preserved unrecognized skill directory: ${skillPath}`);
    }

    if (!options.dryRun) {
      delete nextState.clients[client];
      nextState.updated_at = new Date().toISOString();
      await atomicWriteJson(paths.installState, nextState);
    }
  }

  return {
    ok: warnings.length === 0,
    package_version: VERSION,
    clients,
    actions,
    warnings,
    rules_path: paths.rules
  };
}

export async function getInstallState(home?: string): Promise<InstallState> {
  const paths = getStorePaths(resolveStoreHome(home));
  return readInstallState(paths.installState);
}

export async function getInstallationHealth(home?: string): Promise<InstallationHealth[]> {
  const paths = getStorePaths(resolveStoreHome(home));
  const state = await readInstallState(paths.installState);
  const clients = (Object.keys(state.clients) as AgentClient[]).filter(
    (client) => state.clients[client] !== undefined
  );
  return Promise.all(
    clients.map(async (client) => {
      const managed = state.clients[client]!;
      const available = await commandAvailable(clientCommand(client));
      const status = available
        ? await inspectMcpServer(client, MCP_SERVER_CONFIG_NAME, "current")
        : { exists: false, matchesManagedCommand: false };
      const skillManaged = await isManagedSkill(managed.skill_path);
      const issues = [
        ...(!available ? [`${displayClient(client)} is not available on PATH.`] : []),
        ...(available && !status.exists
          ? [`${displayClient(client)} has no '${MCP_SERVER_CONFIG_NAME}' MCP server.`]
          : []),
        ...(status.exists && !status.matchesManagedCommand
          ? [`${displayClient(client)}'s '${MCP_SERVER_CONFIG_NAME}' command was changed.`]
          : []),
        ...(!skillManaged
          ? [`${displayClient(client)}'s companion skill is missing or changed.`]
          : [])
      ];
      return {
        client,
        available,
        configured: status.exists,
        command_matches: status.matchesManagedCommand,
        skill_managed: skillManaged,
        ok: issues.length === 0,
        issues
      };
    })
  );
}

export function detectClients(): AgentClient[] {
  return (["codex", "claude"] as const).filter((client) =>
    commandAvailableSync(clientCommand(client))
  );
}

function mcpAddCommand(client: AgentClient): string[] {
  const serverCommand = ["npx", "-y", `${PACKAGE_NAME}@${VERSION}`, "mcp"];
  if (client === "codex") {
    return [
      "codex",
      "mcp",
      "add",
      MCP_SERVER_CONFIG_NAME,
      "--env",
      "AGENT_LOUNGE_CLIENT=codex",
      "--",
      ...serverCommand
    ];
  }
  return [
    "claude",
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    MCP_SERVER_CONFIG_NAME,
    "--env",
    "AGENT_LOUNGE_CLIENT=claude-code",
    "--",
    ...serverCommand
  ];
}

async function inspectMcpServer(
  client: AgentClient,
  configName: string,
  expected: "current" | "legacy"
): Promise<McpServerStatus> {
  if (!(await commandAvailable(clientCommand(client)))) {
    return { exists: false, matchesManagedCommand: false };
  }
  const args =
    client === "codex" ? ["mcp", "get", configName, "--json"] : ["mcp", "get", configName];
  const result = await runCommandResult(clientCommand(client), args);
  if (result.code !== 0) return { exists: false, matchesManagedCommand: false };
  return {
    exists: true,
    matchesManagedCommand:
      expected === "legacy"
        ? client === "codex"
          ? legacyCodexConfigMatches(result.stdout)
          : legacyClaudeConfigMatches(result.stdout)
        : client === "codex"
          ? codexConfigMatches(result.stdout)
          : claudeConfigMatches(result.stdout)
  };
}

async function removeMcpServer(client: AgentClient, configName: string): Promise<void> {
  const args =
    client === "codex"
      ? ["mcp", "remove", configName]
      : ["mcp", "remove", configName, "--scope", "user"];
  await runCommand(clientCommand(client), args);
}

async function installSkill(
  client: AgentClient,
  target: string,
  options: { dryRun: boolean; force: boolean; warnings: string[] }
): Promise<"installed" | "updated"> {
  const source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
    "agent-lounge"
  );
  const exists = await pathExists(target);
  if (exists && !(await isManagedSkill(target))) {
    if (!options.force) {
      throw new Error(
        `${displayClient(client)} already has an unrecognized agent-lounge skill at ${target}. Re-run with --force to preserve it as a timestamped backup.`
      );
    }
    if (!options.dryRun) {
      const backup = `${target}.backup-${compactBackupTime(new Date())}`;
      await rename(target, backup);
      options.warnings.push(`Preserved the existing skill as ${backup}`);
    }
  } else if (exists && !options.dryRun) {
    await rm(target, { recursive: true, force: false });
  }
  if (!options.dryRun) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  }
  return exists ? "updated" : "installed";
}

async function isManagedSkill(directory: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
    return content.includes("managed-by: agent-lounge");
  } catch {
    return false;
  }
}

async function isLegacyManagedSkill(directory: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
    return content.includes("managed-by: agent-board");
  } catch {
    return false;
  }
}

function skillTarget(client: AgentClient): string {
  if (client === "codex") {
    const root = process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(homedir(), ".codex");
    return path.join(root, "skills", "agent-lounge");
  }
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(homedir(), ".claude");
  return path.join(root, "skills", "agent-lounge");
}

function legacySkillTarget(client: AgentClient): string {
  return path.join(path.dirname(skillTarget(client)), "agent-board");
}

function defaultInstallState(): InstallState {
  return {
    schema_version: STORE_SCHEMA_VERSION,
    updated_at: new Date(0).toISOString(),
    clients: {}
  };
}

async function readInstallState(filePath: string): Promise<InstallState> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return InstallStateSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return defaultInstallState();
    }
    throw new Error(`Agent Lounge installation state is invalid: ${safeError(error)}`);
  }
}

async function readInstallStateForInstall(
  resolvedHome: string,
  installStatePath: string
): Promise<InstallState> {
  if (await pathExists(installStatePath)) return readInstallState(installStatePath);
  if (resolvedHome === defaultStoreHome()) {
    const legacyPath = getStorePaths(legacyStoreHome()).installState;
    if (await pathExists(legacyPath)) return readInstallState(legacyPath);
  }
  return defaultInstallState();
}

function clientCommand(client: AgentClient): string {
  return client;
}

function displayClient(client: AgentClient): string {
  return client === "codex" ? "Codex" : "Claude Code";
}

function commandAvailableSync(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    timeout: 3_000,
    shell: process.platform === "win32"
  });
  return result.status === 0;
}

async function commandAvailable(command: string): Promise<boolean> {
  return commandAvailableSync(command);
}

async function runCommand(command: string | undefined, args: string[]): Promise<void> {
  if (!command) throw new Error("Missing command.");
  const result = await runCommandResult(command, args);
  if (result.code !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`
    );
  }
}

function runCommandResult(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 15_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-8_000);
}

function codexConfigMatches(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!value || typeof value !== "object") return false;
    const transport = (value as Record<string, unknown>).transport;
    if (!transport || typeof transport !== "object") return false;
    const record = transport as Record<string, unknown>;
    const env = record.env;
    return (
      record.type === "stdio" &&
      record.command === "npx" &&
      arraysEqual(record.args, ["-y", `${PACKAGE_NAME}@${VERSION}`, "mcp"]) &&
      !!env &&
      typeof env === "object" &&
      (env as Record<string, unknown>).AGENT_LOUNGE_CLIENT === "codex"
    );
  } catch {
    return false;
  }
}

function claudeConfigMatches(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  return (
    lines.includes("Scope: User config (available in all your projects)") &&
    lines.includes("Command: npx") &&
    lines.includes(`Args: -y ${PACKAGE_NAME}@${VERSION} mcp`) &&
    lines.includes("AGENT_LOUNGE_CLIENT=claude-code")
  );
}

function legacyCodexConfigMatches(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!value || typeof value !== "object") return false;
    const transport = (value as Record<string, unknown>).transport;
    if (!transport || typeof transport !== "object") return false;
    const record = transport as Record<string, unknown>;
    const args = record.args;
    const env = record.env;
    return (
      record.type === "stdio" &&
      record.command === "npx" &&
      Array.isArray(args) &&
      args.length === 3 &&
      args[0] === "-y" &&
      typeof args[1] === "string" &&
      legacyPackageSpec(args[1]) &&
      args[2] === "mcp" &&
      !!env &&
      typeof env === "object" &&
      (env as Record<string, unknown>).AGENT_BOARD_CLIENT === "codex"
    );
  } catch {
    return false;
  }
}

function legacyClaudeConfigMatches(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const argsLine = lines.find((line) => line.startsWith("Args: -y "));
  return (
    lines.includes("Scope: User config (available in all your projects)") &&
    lines.includes("Command: npx") &&
    !!argsLine &&
    /^Args: -y @souravbhar\/agent-board@[^\s]+ mcp$/u.test(argsLine) &&
    lines.includes("AGENT_BOARD_CLIENT=claude-code")
  );
}

function legacyPackageSpec(value: string): boolean {
  return (
    value.startsWith(`${LEGACY_PACKAGE_NAME}@`) && value.length > LEGACY_PACKAGE_NAME.length + 1
  );
}

function arraysEqual(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function compactBackupTime(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replaceAll(/[\r\n]+/g, " ").slice(0, 500)
    : "unknown error";
}
