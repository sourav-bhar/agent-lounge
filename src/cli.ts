#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command, CommanderError, Option } from "commander";
import pc from "picocolors";

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./constants.js";
import {
  formatMessage,
  formatPage,
  formatStoredMessage,
  jsonString,
  terminalSafe
} from "./format.js";
import {
  AgentClientSchema,
  detectClients,
  getInstallationHealth,
  getInstallState,
  installAgentBoard,
  uninstallAgentBoard,
  type AgentClient,
  type InstallationHealth,
  type InstallReport
} from "./installer.js";
import { runMcpServer } from "./mcp-server.js";
import {
  ConfidenceSchema,
  EvidenceSchema,
  MessageKindSchema,
  type MessageScope
} from "./schema.js";
import { AgentBoardStore } from "./storage.js";
import { startDashboard } from "./ui-server.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  json?: boolean;
  home?: string;
  projectRoot?: string;
  color: boolean;
}

interface ListOptions {
  scope: "relevant" | "personal" | "project" | "all";
  kind?: string;
  limit: string;
  offset: string;
  includeHidden?: boolean;
}

interface PostOptions {
  scope: MessageScope;
  kind: string;
  topic: string;
  body?: string;
  bodyFile?: string;
  stdin?: boolean;
  tag: string[];
  evidence: string;
  confidence: string;
  replyTo?: string;
  supersedes?: string;
  allowSensitive?: boolean;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const jsonRequested = argv.includes("--json");
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return;
    }
    process.exitCode = 1;
    const message = safeErrorMessage(error);
    if (jsonRequested) output.write(jsonString({ ok: false, error: { message } }));
    else process.stderr.write(`${pc.red("error")} ${message}\n`);
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("agent-board")
    .description("A private local message board shared by your AI agent sessions.")
    .version(VERSION)
    .option("--json", "emit stable JSON to stdout")
    .option("--home <path>", "override the board directory (or set AGENT_BOARD_HOME)")
    .option("--project-root <path>", "override the current project used for project scope")
    .option("--no-color", "disable ANSI color")
    .showHelpAfterError()
    .addHelpText(
      "after",
      "\nStart with the `doctor` command. Agent operations never require the dashboard to be running.\n"
    );

  program
    .command("init")
    .description("create the private local board store")
    .action(async (_options, command: Command) => {
      const globals = globalOptions(command);
      const store = makeStore(globals, "human");
      await store.initialize();
      emit(
        command,
        { ok: true, home: store.paths.home },
        `Ready · ${terminalSafe(store.paths.home)}`
      );
    });

  program
    .command("doctor")
    .description("check storage, permissions, malformed files, and agent integrations")
    .action(async (_options, command: Command) => {
      const globals = globalOptions(command);
      const store = makeStore(globals, "doctor");
      const [storeReport, installState, integrations] = await Promise.all([
        store.doctor(),
        getInstallState(globals.home),
        getInstallationHealth(globals.home)
      ]);
      const report = {
        ...storeReport,
        ok: storeReport.ok && integrations.every((integration) => integration.ok),
        package_version: VERSION,
        detected_clients: detectClients(),
        managed_clients: Object.keys(installState.clients),
        integrations
      };
      if (globals.json) output.write(jsonString(report));
      else output.write(formatDoctor(report, globals.color));
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("install")
    .description("connect Agent Board to installed agent clients and install its companion skill")
    .addOption(
      new Option("--client <client>", "client to configure; repeat for more than one")
        .choices(AgentClientSchema.options)
        .argParser(collectValues)
    )
    .option("--dry-run", "show the changes without applying them")
    .option(
      "--force",
      "replace an unrecognized agent-board integration while preserving skill backups"
    )
    .action(
      async (
        options: { client?: string[]; dryRun?: boolean; force?: boolean },
        command: Command
      ) => {
        const globals = globalOptions(command);
        const report = await installAgentBoard({
          ...(globals.home ? { home: globals.home } : {}),
          ...(options.client ? { clients: parseClients(options.client) } : {}),
          dryRun: options.dryRun ?? false,
          force: options.force ?? false
        });
        emitInstallReport(command, report);
      }
    );

  program
    .command("uninstall")
    .description("remove managed agent integrations while preserving board data")
    .addOption(
      new Option("--client <client>", "client to disconnect; repeat for more than one")
        .choices(AgentClientSchema.options)
        .argParser(collectValues)
    )
    .option("--dry-run", "show the changes without applying them")
    .option("--force", "remove an agent-board integration even if its command was changed")
    .option("--purge", "also permanently remove the entire local board store")
    .option("--yes", "confirm permanent store removal")
    .action(
      async (
        options: {
          client?: string[];
          dryRun?: boolean;
          force?: boolean;
          purge?: boolean;
          yes?: boolean;
        },
        command: Command
      ) => {
        const globals = globalOptions(command);
        if (options.purge && !options.yes) {
          throw new Error("--purge is permanent. Re-run with both --purge and --yes.");
        }
        const report = await uninstallAgentBoard({
          ...(globals.home ? { home: globals.home } : {}),
          ...(options.client ? { clients: parseClients(options.client) } : {}),
          dryRun: options.dryRun ?? false,
          force: options.force ?? false
        });
        if (options.purge && !options.dryRun) {
          await makeStore(globals, "human").purgeStore();
        }
        emitInstallReport(command, report, options.purge ? "Store purged." : undefined);
      }
    );

  const messages = program.command("messages").description("read and write board messages");

  addListOptions(messages.command("list").description("list recent messages")).action(
    async (options: ListOptions, command: Command) => {
      const globals = globalOptions(command);
      const page = await makeStore(globals).list(queryFromListOptions(options));
      emitPage(command, page);
    }
  );

  addListOptions(
    messages
      .command("search")
      .description("search message topics, bodies, tags, evidence, and project names")
      .argument("<query>", "words or exact text to find")
  ).action(async (query: string, options: ListOptions, command: Command) => {
    const globals = globalOptions(command);
    const page = await makeStore(globals).list({ ...queryFromListOptions(options), query });
    emitPage(command, page);
  });

  messages
    .command("show")
    .description("show one exact message")
    .argument("<message-id>")
    .action(async (messageId: string, _options, command: Command) => {
      const globals = globalOptions(command);
      const view = await makeStore(globals).get(messageId);
      if (!view) throw new Error(`Message not found: ${messageId}`);
      emit(command, { item: view }, `${formatMessage(view, { color: globals.color })}\n`);
    });

  messages
    .command("thread")
    .description("show every message in a conversation thread")
    .argument("<thread-id>")
    .option("--include-hidden", "include human-hidden messages")
    .action(async (threadId: string, options: { includeHidden?: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const page = await makeStore(globals).list({
        scope: "all",
        threadId,
        includeHidden: options.includeHidden ?? false,
        limit: MAX_PAGE_LIMIT,
        offset: 0
      });
      emitPage(command, page);
    });

  messages
    .command("post")
    .description("post one durable message")
    .requiredOption("--scope <scope>", "personal or project", parseMessageScope)
    .requiredOption("--kind <kind>", MessageKindSchema.options.join(", "))
    .requiredOption("--topic <topic>", "short, specific subject")
    .option("--body <text>", "message body")
    .option("--body-file <path>", "read message body from a UTF-8 file")
    .option("--stdin", "read message body from standard input")
    .option("--tag <tag>", "lowercase discovery tag; repeat as needed", collectValues, [])
    .requiredOption("--evidence <type>", EvidenceSchema.options.join(", "))
    .requiredOption("--confidence <level>", ConfidenceSchema.options.join(", "))
    .option("--reply-to <message-id>", "message being answered")
    .option("--supersedes <message-id>", "older message this corrects")
    .option("--allow-sensitive", "human override for the local secret-pattern guard")
    .action(async (options: PostOptions, command: Command) => {
      const globals = globalOptions(command);
      const body = await resolveBody(options);
      const message = await makeStore(globals, "cli").post(
        {
          scope: options.scope,
          kind: MessageKindSchema.parse(options.kind),
          topic: options.topic,
          body,
          tags: options.tag,
          evidence: EvidenceSchema.parse(options.evidence),
          confidence: ConfidenceSchema.parse(options.confidence),
          reply_to: options.replyTo ?? null,
          supersedes: options.supersedes ?? null
        },
        { allowSensitive: options.allowSensitive ?? false }
      );
      emit(
        command,
        { message },
        `${pc.green("posted")} ${formatStoredMessage(message, { color: globals.color })}\n`
      );
    });

  messages
    .command("delete")
    .description("move one message to recoverable local trash")
    .argument("<message-id>")
    .option("--yes", "confirm moving the message to trash")
    .action(async (messageId: string, options: { yes?: boolean }, command: Command) => {
      if (!options.yes) throw new Error("Re-run with --yes. The message will remain restorable.");
      const globals = globalOptions(command);
      await makeStore(globals, "human").trash(messageId);
      emit(
        command,
        { ok: true, message_id: messageId, recoverable: true },
        `Moved ${terminalSafe(messageId)} to trash. Restore with: npx -y agent-board@${VERSION} messages restore ${terminalSafe(messageId)}\n`
      );
    });

  messages
    .command("restore")
    .description("restore a message from local trash")
    .argument("<message-id>")
    .action(async (messageId: string, _options, command: Command) => {
      const globals = globalOptions(command);
      const message = await makeStore(globals, "human").restore(messageId);
      emit(command, { message }, `Restored ${terminalSafe(message.id)}.\n`);
    });

  const curation = program.command("curation").description("human pinning and visibility controls");
  for (const state of ["pinned", "hidden"] as const) {
    curation
      .command(state === "pinned" ? "pin" : "hide")
      .description(
        state === "pinned" ? "pin a trusted message" : "hide a message from normal reads"
      )
      .argument("<message-id>")
      .option("--note <note>", "short human curation note")
      .action(async (messageId: string, options: { note?: string }, command: Command) => {
        const globals = globalOptions(command);
        const record = await makeStore(globals, "human").setCuration(
          messageId,
          state,
          options.note
        );
        emit(command, { curation: record }, `${state} · ${terminalSafe(messageId)}\n`);
      });
  }

  curation
    .command("clear")
    .description("remove pin or hide state from a message")
    .argument("<message-id>")
    .action(async (messageId: string, _options, command: Command) => {
      const globals = globalOptions(command);
      const cleared = await makeStore(globals, "human").clearCuration(messageId);
      emit(
        command,
        { ok: true, message_id: messageId, cleared },
        `${cleared ? "cleared" : "unchanged"} · ${terminalSafe(messageId)}\n`
      );
    });

  program
    .command("ui")
    .description("open the optional local dashboard")
    .option("--port <port>", "loopback port; use 0 for a random available port", parsePort, 47_831)
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: { port: number; open: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const dashboard = await startDashboard({
        store: makeStore(globals, "dashboard"),
        port: options.port,
        openBrowser: options.open
      });
      if (globals.json)
        output.write(jsonString({ ok: true, url: dashboard.url, port: dashboard.port }));
      else {
        const bold = globals.color ? pc.bold : (value: string) => value;
        const dim = globals.color ? pc.dim : (value: string) => value;
        output.write(
          `${bold("Agent Board")} · ${dashboard.url}\n${dim("Press Ctrl+C to stop the dashboard. Agents continue working without it.")}\n`
        );
      }
    });

  program
    .command("mcp")
    .description("serve the three Agent Board tools over stdio")
    .action((_options, command: Command) => {
      const globals = globalOptions(command);
      runMcpServer({
        ...(globals.home ? { home: globals.home } : {}),
        ...(globals.projectRoot ? { projectRoot: globals.projectRoot } : {}),
        client: process.env.AGENT_BOARD_CLIENT ?? "mcp"
      });
    });

  return program;
}

function addListOptions(command: Command): Command {
  return command
    .option("--scope <scope>", "relevant, personal, project, or all", "relevant")
    .option("--kind <kind>", MessageKindSchema.options.join(", "))
    .option("--limit <count>", `1-${MAX_PAGE_LIMIT}`, String(DEFAULT_PAGE_LIMIT))
    .option("--offset <count>", "pagination offset", "0")
    .option("--include-hidden", "include human-hidden messages");
}

function queryFromListOptions(options: ListOptions) {
  const limit = parseBoundedInteger(options.limit, 1, MAX_PAGE_LIMIT, "limit");
  const offset = parseBoundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
  return {
    scope: parseQueryScope(options.scope),
    ...(options.kind ? { kind: MessageKindSchema.parse(options.kind) } : {}),
    includeHidden: options.includeHidden ?? false,
    limit,
    offset
  };
}

function makeStore(options: GlobalOptions, defaultClient = "cli"): AgentBoardStore {
  return new AgentBoardStore({
    ...(options.home ? { home: options.home } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    client: process.env.AGENT_BOARD_CLIENT ?? defaultClient
  });
}

function globalOptions(command: Command): GlobalOptions {
  const options = command.optsWithGlobals<GlobalOptions>();
  return { ...options, color: options.color && output.isTTY };
}

function emit(command: Command, jsonValue: unknown, humanValue: string): void {
  if (globalOptions(command).json) output.write(jsonString(jsonValue));
  else output.write(humanValue.endsWith("\n") ? humanValue : `${humanValue}\n`);
}

function emitPage(command: Command, page: Awaited<ReturnType<AgentBoardStore["list"]>>): void {
  const globals = globalOptions(command);
  if (globals.json) output.write(jsonString(page));
  else output.write(`${formatPage(page, { color: globals.color })}\n`);
}

function emitInstallReport(command: Command, report: InstallReport, extra?: string): void {
  const globals = globalOptions(command);
  if (globals.json) {
    output.write(jsonString({ ...report, ...(extra ? { note: extra } : {}) }));
    return;
  }
  output.write(formatInstallReport(report, globals.color, extra));
}

function formatInstallReport(report: InstallReport, color: boolean, extra?: string): string {
  const green = color ? pc.green : (value: string) => value;
  const dim = color ? pc.dim : (value: string) => value;
  const isPlan = report.actions.some((action) => action.status === "planned");
  const isRemoval = report.actions.some((action) => action.action.startsWith("remove_"));
  const heading = isPlan
    ? "Agent Board changes are ready."
    : isRemoval
      ? "Agent Board is disconnected."
      : "Agent Board is connected.";
  const lines = [green(heading), ""];
  for (const action of report.actions) {
    const marker = action.status === "planned" ? "○" : action.status === "skipped" ? "–" : "✓";
    lines.push(`${marker} ${action.client.padEnd(6)} ${action.action.replaceAll("_", " ")}`);
    lines.push(`  ${dim(terminalSafe(action.detail))}`);
  }
  if (extra) lines.push("", terminalSafe(extra));
  if (report.warnings.length > 0)
    lines.push("", ...report.warnings.map((warning) => `warning · ${terminalSafe(warning)}`));
  lines.push(
    "",
    dim(`Run \`npx -y agent-board@${VERSION} doctor\` to verify the local store and integrations.`),
    ""
  );
  return lines.join("\n");
}

function formatDoctor(
  report: {
    ok: boolean;
    home: string;
    initialized: boolean;
    permissions: string | null;
    message_count: number;
    trashed_count: number;
    malformed_files: string[];
    warnings: string[];
    package_version: string;
    detected_clients: AgentClient[];
    managed_clients: string[];
    integrations: InstallationHealth[];
  },
  color: boolean
): string {
  const green = color ? pc.green : (value: string) => value;
  const red = color ? pc.red : (value: string) => value;
  const dim = color ? pc.dim : (value: string) => value;
  const bold = color ? pc.bold : (value: string) => value;
  const status = report.ok ? green("healthy") : red("needs attention");
  const lines = [
    `${bold("Agent Board")} ${dim(`v${report.package_version}`)} · ${status}`,
    "",
    `store       ${terminalSafe(report.home)}`,
    `initialized ${String(report.initialized)}`,
    `permissions ${report.permissions ?? "missing"}`,
    `messages    ${report.message_count}`,
    `trash       ${report.trashed_count}`,
    `detected    ${report.detected_clients.join(", ") || "none"}`,
    `managed     ${report.managed_clients.join(", ") || "none"}`
  ];
  for (const integration of report.integrations) {
    lines.push(
      `  ${integration.client.padEnd(10)} ${integration.ok ? green("healthy") : red("needs attention")}`
    );
    if (!integration.ok) {
      lines.push(...integration.issues.map((issue) => `    ${red(terminalSafe(issue))}`));
    }
  }
  if (report.malformed_files.length > 0) {
    lines.push(
      "",
      red("Malformed files:"),
      ...report.malformed_files.map((file) => `  ${terminalSafe(file)}`)
    );
  }
  if (report.warnings.length > 0) {
    lines.push("", ...report.warnings.map((warning) => `warning · ${terminalSafe(warning)}`));
  }
  return `${lines.join("\n")}\n`;
}

async function resolveBody(options: PostOptions): Promise<string> {
  const sources = [
    options.body !== undefined,
    options.bodyFile !== undefined,
    options.stdin === true
  ].filter(Boolean);
  if (sources.length !== 1) {
    throw new Error("Provide exactly one of --body, --body-file, or --stdin.");
  }
  if (options.body !== undefined) return options.body;
  if (options.bodyFile !== undefined) return readFile(options.bodyFile, "utf8");
  return readStdin();
}

async function readStdin(): Promise<string> {
  if (input.isTTY) throw new Error("--stdin requires piped input.");
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
}

function parseMessageScope(value: string): MessageScope {
  if (value === "personal" || value === "project") return value;
  throw new Error("scope must be personal or project");
}

function parseQueryScope(value: string): "relevant" | "personal" | "project" | "all" {
  if (value === "relevant" || value === "personal" || value === "project" || value === "all") {
    return value;
  }
  throw new Error("scope must be relevant, personal, project, or all");
}

function parseClients(values: string[]): AgentClient[] {
  return values.flatMap((value) => value.split(",")).map((value) => AgentClientSchema.parse(value));
}

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function parsePort(value: string): number {
  return parseBoundedInteger(value, 0, 65_535, "port");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return terminalSafe(error.message.replaceAll(/[\r\n]+/g, " ")).slice(0, 1_000);
  }
  return "Unexpected error.";
}

void main();
