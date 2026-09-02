import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agent-board-package-test-"));
let tarballPath;

try {
  const pack = run(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
    root
  );
  const report = JSON.parse(pack.stdout)[0];
  if (!report?.filename) throw new Error("npm pack did not return a tarball filename");
  tarballPath = path.join(temporaryRoot, report.filename);

  const prefix = path.join(temporaryRoot, "app");
  await mkdir(prefix, { recursive: true });
  run(npm, ["install", "--prefix", prefix, "--ignore-scripts", tarballPath], temporaryRoot);
  const executable = path.join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-board.cmd" : "agent-board"
  );
  const installedScript = path.join(prefix, "node_modules", "agent-board", "dist", "cli.js");
  const cliCommand = process.platform === "win32" ? process.execPath : executable;
  const cliPrefix = process.platform === "win32" ? [installedScript] : [];
  const board = path.join(temporaryRoot, "board");
  const project = path.join(temporaryRoot, "project");
  await mkdir(project, { recursive: true });

  const version = run(executable, ["--version"], temporaryRoot);
  if (!/^\d+\.\d+\.\d+\s*$/.test(version.stdout) || version.stderr) {
    throw new Error("packed --version command did not exit cleanly");
  }

  const common = ["--home", board, "--project-root", project, "--json"];
  const initialized = JSON.parse(
    run(cliCommand, [...cliPrefix, ...common, "init"], temporaryRoot).stdout
  );
  if (!initialized.ok || initialized.home !== board) {
    throw new Error("packed init command returned an unexpected result");
  }

  const posted = JSON.parse(
    run(
      cliCommand,
      [
        ...cliPrefix,
        ...common,
        "messages",
        "post",
        "--scope",
        "personal",
        "--kind",
        "note",
        "--topic",
        "Clean package install",
        "--body",
        "The packed CLI runs outside its source repository.",
        "--tag",
        "packaging",
        "--evidence",
        "observed_success",
        "--confidence",
        "high"
      ],
      temporaryRoot
    ).stdout
  );
  const listed = JSON.parse(
    run(cliCommand, [...cliPrefix, ...common, "messages", "list", "--scope", "all"], temporaryRoot)
      .stdout
  );
  if (
    !posted.message?.id ||
    listed.total !== 1 ||
    listed.items?.[0]?.message?.id !== posted.message.id
  ) {
    throw new Error("packed post/list round trip did not preserve the message");
  }

  const mcpClient = new Client({ name: "package-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : executable,
    args: [
      ...(process.platform === "win32" ? [installedScript] : []),
      "--home",
      board,
      "--project-root",
      project,
      "mcp"
    ],
    cwd: temporaryRoot,
    stderr: "pipe"
  });
  try {
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    const read = await mcpClient.callTool({
      name: "agent_board_read",
      arguments: { scope: "all", response_format: "json" }
    });
    if (tools.tools.length !== 3 || read.isError || read.structuredContent?.total !== 1) {
      throw new Error("packed MCP server did not expose and execute its expected tools");
    }
  } finally {
    await mcpClient.close();
  }

  console.log(`Clean tarball install passed for agent-board@${version.stdout.trim()}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (tarballPath) await rm(tarballPath, { force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", npm_config_dry_run: "false" },
    maxBuffer: 2_000_000,
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd")
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with exit ${result.status}: ${sanitize(result.stderr || result.stdout)}`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function sanitize(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}
