import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";

import { atomicWriteJson, isNodeError } from "./fs-utils.js";
import { getStorePaths, resolveStoreHome } from "./paths.js";
import { AgentLoungeStore } from "./storage.js";
import { openDashboardBrowser, startDashboard } from "./ui-server.js";
import { VERSION } from "./version.js";

const READY_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 1_000;

const ManagedUiStateSchema = z
  .object({
    schema_version: z.literal(1),
    instance_id: z.string().uuid(),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535),
    token: z.string().min(24).max(256),
    started_at: z.string().datetime({ offset: true }),
    package_version: z.string().min(1).max(100)
  })
  .strict();

const ControlResponseSchema = z
  .object({
    ok: z.literal(true),
    instance_id: z.string().uuid(),
    pid: z.number().int().positive()
  })
  .strict();

type ManagedUiState = z.infer<typeof ManagedUiStateSchema>;

export interface ManagedUiStatus {
  state: "running" | "unresponsive" | "stopped";
  running: boolean;
  pid: number | null;
  port: number | null;
  url: string | null;
  started_at: string | null;
  package_version: string | null;
  warning: string | null;
}

export interface StartManagedUiOptions {
  store: AgentLoungeStore;
  port: number;
  openBrowser: boolean;
  cliPath: string;
  nodeArgs: string[];
}

export interface StartManagedUiResult extends ManagedUiStatus {
  reused: boolean;
}

export interface StopManagedUiResult {
  stopped: boolean;
  was_running: boolean;
  forced: boolean;
  warning: string | null;
}

export async function getManagedUiStatus(home?: string): Promise<ManagedUiStatus> {
  const paths = getStorePaths(resolveStoreHome(home));
  const loaded = await readManagedUiState(paths.uiState);
  if (!loaded.state) return stoppedStatus(loaded.warning);

  const control = await requestControl(loaded.state, "status");
  if (control && controlMatches(loaded.state, control)) {
    return statusFromState(loaded.state, "running", loaded.warning);
  }

  if (processIsAlive(loaded.state.pid) && processMatchesState(loaded.state)) {
    return statusFromState(
      loaded.state,
      "unresponsive",
      "The managed dashboard process is running but did not answer its local control endpoint."
    );
  }

  await removeStateIfOwned(paths.uiState, loaded.state.instance_id);
  return stoppedStatus("Removed stale dashboard state from an earlier process.");
}

export async function startManagedUi(
  options: StartManagedUiOptions
): Promise<StartManagedUiResult> {
  const current = await getManagedUiStatus(options.store.paths.home);
  if (current.state === "running") {
    if (options.openBrowser && current.url) openDashboardBrowser(current.url);
    return { ...current, reused: true };
  }
  if (current.state === "unresponsive") {
    throw new Error("The dashboard is unresponsive. Run `agent-lounge ui restart`.");
  }

  await options.store.initialize();
  const instanceId = randomUUID();
  const logDescriptor = openSync(options.store.paths.uiLog, "w", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        ...options.nodeArgs,
        options.cliPath,
        "--home",
        options.store.paths.home,
        "--project-root",
        options.store.projectRoot,
        "--no-color",
        "__ui-serve",
        "--port",
        String(options.port),
        "--instance-id",
        instanceId
      ],
      {
        cwd: process.cwd(),
        detached: true,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", logDescriptor, logDescriptor],
        windowsHide: true
      }
    );
  } finally {
    closeSync(logDescriptor);
  }
  if (process.platform !== "win32") await chmod(options.store.paths.uiLog, 0o600);
  if (!child.pid) throw new Error("Agent Lounge could not start the dashboard process.");

  let exited = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getManagedUiStatus(options.store.paths.home);
    if (status.state === "running" && status.pid === child.pid) {
      if (options.openBrowser && status.url) openDashboardBrowser(status.url);
      return { ...status, reused: false };
    }
    if (exited) {
      throw new Error(
        `The dashboard process exited with status ${exitCode ?? "unknown"}. See ${options.store.paths.uiLog}.`
      );
    }
    await delay(50);
  }

  child.kill("SIGTERM");
  await removeStateIfOwned(options.store.paths.uiState, instanceId);
  throw new Error(`The dashboard did not become ready. See ${options.store.paths.uiLog}.`);
}

export async function stopManagedUi(
  home?: string,
  options: { force?: boolean } = {}
): Promise<StopManagedUiResult> {
  const paths = getStorePaths(resolveStoreHome(home));
  const loaded = await readManagedUiState(paths.uiState);
  if (!loaded.state) {
    return {
      stopped: true,
      was_running: false,
      forced: false,
      warning: loaded.warning
    };
  }
  const state = loaded.state;
  const control = await requestControl(state, "status");
  if (control && controlMatches(state, control)) {
    const stopped = await requestControl(state, "stop");
    if (stopped && controlMatches(state, stopped)) {
      if (await waitForExit(state.pid, STOP_TIMEOUT_MS)) {
        await removeStateIfOwned(paths.uiState, state.instance_id);
        return { stopped: true, was_running: true, forced: false, warning: loaded.warning };
      }
    }
  }

  if (!processIsAlive(state.pid)) {
    await removeStateIfOwned(paths.uiState, state.instance_id);
    return {
      stopped: true,
      was_running: false,
      forced: false,
      warning: "Removed stale dashboard state from an earlier process."
    };
  }
  if (!processMatchesState(state)) {
    await removeStateIfOwned(paths.uiState, state.instance_id);
    throw new Error(
      "The saved dashboard PID belongs to a different process. Nothing was killed; stale state was removed."
    );
  }

  process.kill(state.pid, "SIGTERM");
  let exited = await waitForExit(state.pid, STOP_TIMEOUT_MS);
  let forced = false;
  if (!exited && options.force) {
    hardKill(state.pid);
    exited = await waitForExit(state.pid, STOP_TIMEOUT_MS);
    forced = true;
  }
  if (!exited) {
    throw new Error(
      "The dashboard did not stop. Re-run `agent-lounge ui stop --force` to terminate it."
    );
  }
  await removeStateIfOwned(paths.uiState, state.instance_id);
  return { stopped: true, was_running: true, forced, warning: loaded.warning };
}

export async function serveManagedUi(options: {
  store: AgentLoungeStore;
  port: number;
  instanceId: string;
}): Promise<void> {
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | null = null;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const onSignal = (): void => requestStop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    dashboard = await startDashboard({
      store: options.store,
      port: options.port,
      openBrowser: false,
      instanceId: options.instanceId,
      onStopRequested: requestStop
    });
    await atomicWriteJson(options.store.paths.uiState, {
      schema_version: 1,
      instance_id: options.instanceId,
      pid: process.pid,
      port: dashboard.port,
      token: dashboard.token,
      started_at: new Date().toISOString(),
      package_version: VERSION
    } satisfies ManagedUiState);
    if (process.platform !== "win32") await chmod(options.store.paths.uiState, 0o600);
    await stopRequested;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (dashboard) await dashboard.close();
    await removeStateIfOwned(options.store.paths.uiState, options.instanceId);
  }
}

function statusFromState(
  state: ManagedUiState,
  status: "running" | "unresponsive",
  warning: string | null
): ManagedUiStatus {
  return {
    state: status,
    running: status === "running",
    pid: state.pid,
    port: state.port,
    url: dashboardUrl(state),
    started_at: state.started_at,
    package_version: state.package_version,
    warning
  };
}

function stoppedStatus(warning: string | null): ManagedUiStatus {
  return {
    state: "stopped",
    running: false,
    pid: null,
    port: null,
    url: null,
    started_at: null,
    package_version: null,
    warning
  };
}

function dashboardUrl(state: ManagedUiState): string {
  return `http://localhost:${state.port}/#token=${state.token}`;
}

async function requestControl(
  state: ManagedUiState,
  action: "status" | "stop"
): Promise<z.infer<typeof ControlResponseSchema> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/control/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: { "X-Agent-Lounge-Token": state.token },
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const parsed = ControlResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function controlMatches(
  state: ManagedUiState,
  control: z.infer<typeof ControlResponseSchema>
): boolean {
  return control.instance_id === state.instance_id && control.pid === state.pid;
}

async function readManagedUiState(
  filePath: string
): Promise<{ state: ManagedUiState | null; warning: string | null }> {
  try {
    const parsed = ManagedUiStateSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")));
    if (parsed.success) return { state: parsed.data, warning: null };
    await rm(filePath, { force: true });
    return { state: null, warning: "Removed invalid dashboard state." };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { state: null, warning: null };
    if (error instanceof SyntaxError) {
      await rm(filePath, { force: true });
      return { state: null, warning: "Removed invalid dashboard state." };
    }
    throw error;
  }
}

async function removeStateIfOwned(filePath: string, instanceId: string): Promise<void> {
  const loaded = await readManagedUiState(filePath);
  if (loaded.state?.instance_id === instanceId) await rm(filePath, { force: true });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function processMatchesState(state: ManagedUiState): boolean {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${state.pid}\").CommandLine`
          ],
          { encoding: "utf8", windowsHide: true }
        )
      : spawnSync("ps", ["-p", String(state.pid), "-o", "command="], {
          encoding: "utf8"
        });
  if (result.status !== 0 || typeof result.stdout !== "string") return false;
  return result.stdout.includes("__ui-serve") && result.stdout.includes(state.instance_id);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(50);
  }
  return !processIsAlive(pid);
}

function hardKill(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status !== 0) throw new Error("Windows could not terminate the dashboard process.");
    return;
  }
  process.kill(pid, "SIGKILL");
}
