import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pathExists } from "../src/fs-utils.js";
import { AgentLoungeStore } from "../src/storage.js";
import {
  getManagedUiStatus,
  serveManagedUi,
  startManagedUi,
  stopManagedUi
} from "../src/ui-process.js";
import { VERSION } from "../src/version.js";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryProject } from "./helpers.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "src", "cli.ts");

let homes: string[];
let children: ChildProcess[];

beforeEach(() => {
  homes = [];
  children = [];
});

afterEach(async () => {
  for (const home of homes) await stopManagedUi(home, { force: true }).catch(() => undefined);
  for (const child of children) {
    if (child.pid && processIsAlive(child.pid)) child.kill("SIGKILL");
  }
  await cleanupTemporaryDirectories();
});

describe("managed dashboard process", () => {
  it("starts, reuses, reports, and gracefully stops a detached dashboard", async () => {
    const store = await makeStore();
    const options = {
      store,
      port: 0,
      openBrowser: false,
      cliPath,
      nodeArgs: ["--import", "tsx"]
    };

    const started = await startManagedUi(options);
    expect(started).toMatchObject({ state: "running", running: true, reused: false });
    expect(started.pid).toBeGreaterThan(0);
    expect(started.port).toBeGreaterThan(0);

    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "running",
      pid: started.pid,
      port: started.port
    });
    expect(await startManagedUi(options)).toMatchObject({
      state: "running",
      pid: started.pid,
      reused: true
    });

    expect(await stopManagedUi(store.paths.home)).toMatchObject({
      stopped: true,
      was_running: true,
      forced: false
    });
    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "stopped",
      running: false
    });
  });

  it("runs the managed server until its authenticated stop endpoint is called", async () => {
    const store = await makeStore();
    const instanceId = randomUUID();
    const serving = serveManagedUi({ store, port: 0, instanceId });
    const state = await waitForState(store.paths.uiState);

    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "running",
      pid: process.pid,
      port: state.port
    });
    const response = await fetch(`http://127.0.0.1:${state.port}/api/control/stop`, {
      method: "POST",
      headers: { "X-Agent-Lounge-Token": state.token }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, instance_id: instanceId });
    await serving;
    expect(await pathExists(store.paths.uiState)).toBe(false);
  });

  it("removes malformed state files instead of trusting them", async () => {
    const store = await makeStore(false);
    await mkdir(store.paths.home, { recursive: true });
    await writeFile(store.paths.uiState, "{not-json", "utf8");
    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "stopped",
      warning: "Removed invalid dashboard state."
    });

    await writeFile(store.paths.uiState, `${JSON.stringify({ schema_version: 99 })}\n`, "utf8");
    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "stopped",
      warning: "Removed invalid dashboard state."
    });
  });

  it("refuses to stop an unrelated live PID and removes only the stale state", async () => {
    const store = await makeStore(false);
    await writeState(store, { pid: process.pid, port: await unusedPort() });

    await expect(stopManagedUi(store.paths.home)).rejects.toThrow(/different process/i);
    expect(process.kill(process.pid, 0)).toBe(true);
    expect(await pathExists(store.paths.uiState)).toBe(false);
  });

  it("rejects a mismatched control identity even when the endpoint returns valid JSON", async () => {
    const store = await makeStore(false);
    const instanceId = randomUUID();
    let responseStatus = 200;
    let responseBody: unknown = { ok: true, instance_id: randomUUID(), pid: process.pid };
    const server = createHttpServer((_request, response) => {
      response.statusCode = responseStatus;
      response.setHeader("Content-Type", "application/json");
      response.end(`${JSON.stringify(responseBody)}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server has no port.");
      await writeState(store, { instanceId, pid: process.pid, port: address.port });

      expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
        state: "stopped",
        warning: expect.stringMatching(/stale dashboard state/i)
      });
      responseBody = { ok: true, instance_id: instanceId, pid: process.pid + 100_000 };
      await writeState(store, { instanceId, pid: process.pid, port: address.port });
      expect(await getManagedUiStatus(store.paths.home)).toMatchObject({ state: "stopped" });

      responseStatus = 401;
      await writeState(store, { instanceId, pid: process.pid, port: address.port });
      expect(await getManagedUiStatus(store.paths.home)).toMatchObject({ state: "stopped" });

      responseStatus = 200;
      responseBody = { ok: false };
      await writeState(store, { instanceId, pid: process.pid, port: address.port });
      expect(await getManagedUiStatus(store.paths.home)).toMatchObject({ state: "stopped" });
      expect(process.kill(process.pid, 0)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cleans state for a process that already exited", async () => {
    const store = await makeStore(false);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    children.push(child);
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => {
        if (child.pid) resolve(child.pid);
        else reject(new Error("Fixture process did not receive a PID."));
      });
    });

    await writeState(store, { pid, port: await unusedPort() });
    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "stopped",
      warning: expect.stringMatching(/stale dashboard state/i)
    });
    await writeState(store, { pid, port: await unusedPort() });
    expect(await stopManagedUi(store.paths.home)).toMatchObject({
      stopped: true,
      was_running: false,
      warning: expect.stringMatching(/stale dashboard state/i)
    });
  });

  it("reports a child startup failure and points to the private UI log", async () => {
    const store = await makeStore();
    await expect(
      startManagedUi({
        store,
        port: 0,
        openBrowser: false,
        cliPath: path.join(store.paths.home, "missing-cli.js"),
        nodeArgs: []
      })
    ).rejects.toThrow(new RegExp(`exited with status.*${escapeRegExp(store.paths.uiLog)}`, "i"));
    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({ state: "stopped" });
  });

  it("detects and terminates an unresponsive process only when its identity matches", async () => {
    const store = await makeStore(false);
    const instanceId = randomUUID();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "__ui-serve", instanceId],
      { stdio: "ignore", windowsHide: true }
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Fixture process did not receive a PID.");
    await writeState(store, { instanceId, pid: child.pid, port: await unusedPort() });

    expect(await getManagedUiStatus(store.paths.home)).toMatchObject({
      state: "unresponsive",
      running: false,
      pid: child.pid
    });
    await expect(
      startManagedUi({
        store,
        port: 0,
        openBrowser: false,
        cliPath,
        nodeArgs: ["--import", "tsx"]
      })
    ).rejects.toThrow(/unresponsive/i);
    expect(await stopManagedUi(store.paths.home)).toMatchObject({
      stopped: true,
      was_running: true,
      forced: false
    });
    expect(processIsAlive(child.pid)).toBe(false);
  });
});

async function makeStore(initialize = true): Promise<AgentLoungeStore> {
  const home = path.join(await temporaryDirectory("ui-process"), "lounge");
  homes.push(home);
  const store = new AgentLoungeStore({
    home,
    projectRoot: await temporaryProject("ui-process-project"),
    client: "test"
  });
  if (initialize) await store.initialize();
  return store;
}

async function writeState(
  store: AgentLoungeStore,
  options: { instanceId?: string; pid: number; port: number }
): Promise<void> {
  await mkdir(store.paths.home, { recursive: true });
  await writeFile(
    store.paths.uiState,
    `${JSON.stringify({
      schema_version: 1,
      instance_id: options.instanceId ?? randomUUID(),
      pid: options.pid,
      port: options.port,
      token: "x".repeat(32),
      started_at: new Date().toISOString(),
      package_version: VERSION
    })}\n`,
    "utf8"
  );
}

async function waitForState(
  filePath: string
): Promise<{ port: number; token: string; instance_id: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as {
        port: number;
        token: string;
        instance_id: string;
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Managed dashboard state was not written in time.");
}

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Fixture server did not receive a TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
