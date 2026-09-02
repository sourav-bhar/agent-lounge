import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

import { DASHBOARD_REQUEST_BODY_LIMIT } from "./constants.js";
import { readRulesDocument } from "./rules.js";
import { CreateMessageInputSchema, CurationStateSchema, MessageKindSchema } from "./schema.js";
import { SensitiveContentError } from "./sensitive.js";
import type { AgentLoungeStore } from "./storage.js";

const CurationRequestSchema = z
  .object({
    state: z.union([CurationStateSchema, z.literal("clear")]),
    note: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const AssetsSchema = z.object({
  html: z.instanceof(Buffer),
  css: z.instanceof(Buffer),
  js: z.instanceof(Buffer),
  favicon: z.instanceof(Buffer)
});

interface DashboardAssets extends z.infer<typeof AssetsSchema> {}

export interface StartDashboardOptions {
  store: AgentLoungeStore;
  port: number;
  openBrowser: boolean;
  accessToken?: string;
  instanceId?: string;
  onStopRequested?: () => void;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  instanceId: string;
  close(): Promise<void>;
}

export async function startDashboard(options: StartDashboardOptions): Promise<DashboardHandle> {
  await options.store.initialize();
  const assets = await loadAssets();
  const token = options.accessToken ?? randomBytes(24).toString("base64url");
  const instanceId = options.instanceId ?? randomUUID();
  let actualPort = options.port;
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      store: options.store,
      assets,
      token,
      port: actualPort,
      instanceId,
      ...(options.onStopRequested ? { onStopRequested: options.onStopRequested } : {})
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Dashboard did not receive a TCP port."));
        return;
      }
      actualPort = address.port;
      resolve();
    });
  });

  const url = `http://localhost:${actualPort}/#token=${token}`;
  if (options.openBrowser) openDashboardBrowser(url);
  return {
    url,
    port: actualPort,
    token,
    instanceId,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    store: AgentLoungeStore;
    assets: DashboardAssets;
    token: string;
    port: number;
    instanceId: string;
    onStopRequested?: () => void;
  }
): Promise<void> {
  setSecurityHeaders(response);
  try {
    if (!validHost(request.headers.host, context.port)) {
      sendJson(response, 421, { ok: false, error: "Invalid Host header." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://localhost:${context.port}`);
    if (url.pathname.startsWith("/api/")) {
      if (!validOrigin(request.headers.origin, context.port)) {
        sendJson(response, 403, { ok: false, error: "Invalid request origin." });
        return;
      }
      if (!validToken(request.headers["x-agent-lounge-token"], context.token)) {
        sendJson(response, 401, {
          ok: false,
          error: "Dashboard access token is missing or invalid."
        });
        return;
      }
      if (url.pathname === "/api/control/status" && request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          instance_id: context.instanceId,
          pid: process.pid
        });
        return;
      }
      if (url.pathname === "/api/control/stop" && request.method === "POST") {
        if (!context.onStopRequested) {
          sendJson(response, 409, {
            ok: false,
            error: "This dashboard is running in foreground mode. Press Ctrl+C to stop it."
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          instance_id: context.instanceId,
          pid: process.pid
        });
        setImmediate(context.onStopRequested);
        return;
      }
      await handleApi(request, response, url, context.store);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }
    const asset = staticAsset(url.pathname, context.assets);
    if (!asset) {
      sendText(response, 404, "Not found.", "text/plain; charset=utf-8");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", asset.body.byteLength);
    response.setHeader("Cache-Control", asset.cacheControl);
    if (request.method === "HEAD") response.end();
    else response.end(asset.body);
  } catch (error) {
    if (
      error instanceof HttpInputError ||
      error instanceof z.ZodError ||
      error instanceof SensitiveContentError
    ) {
      sendJson(response, 400, { ok: false, error: safeErrorMessage(error) });
      return;
    }
    console.error(`Agent Lounge dashboard error: ${safeErrorMessage(error)}`);
    sendJson(response, 500, { ok: false, error: "Unexpected dashboard error." });
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: AgentLoungeStore
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/messages") {
    const scope = parseScope(url.searchParams.get("scope") ?? "all");
    const kindValue = url.searchParams.get("kind");
    const queryValue = url.searchParams.get("query")?.trim();
    const page = await store.list({
      scope,
      ...(kindValue ? { kind: MessageKindSchema.parse(kindValue) } : {}),
      ...(queryValue ? { query: queryValue } : {}),
      includeHidden: url.searchParams.get("include_hidden") === "true",
      limit: parseInteger(url.searchParams.get("limit"), 100, 1, 100),
      offset: parseInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
    });
    sendJson(response, 200, page);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/stats") {
    const [doctor, page] = await Promise.all([
      store.doctor(),
      store.list({ scope: "all", includeHidden: true, limit: 1, offset: 0 })
    ]);
    sendJson(response, 200, {
      ok: true,
      message_count: page.total,
      trashed_count: doctor.trashed_count,
      malformed_count: doctor.malformed_files.length,
      store_permissions: doctor.permissions
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/rules") {
    const document = await readRulesDocument(store.paths.home);
    sendJson(response, 200, { ok: true, rules: document.rules });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    requireJson(request);
    const input = CreateMessageInputSchema.parse(await readJsonBody(request));
    const message = await store.post(input);
    sendJson(response, 201, { message });
    return;
  }

  const curationMatch = url.pathname.match(/^\/api\/curation\/([0-9a-f-]{36})$/i);
  if (request.method === "POST" && curationMatch?.[1]) {
    requireJson(request);
    const body = CurationRequestSchema.parse(await readJsonBody(request));
    if (body.state === "clear") {
      const cleared = await store.clearCuration(curationMatch[1]);
      sendJson(response, 200, { ok: true, cleared });
    } else {
      const curation = await store.setCuration(curationMatch[1], body.state, body.note);
      sendJson(response, 200, { curation });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: "API route not found." });
}

async function loadAssets(): Promise<DashboardAssets> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  return AssetsSchema.parse({
    html: await readFile(path.join(root, "index.html")),
    css: await readFile(path.join(root, "styles.css")),
    js: await readFile(path.join(root, "app.js")),
    favicon: await readFile(path.join(root, "favicon.svg"))
  });
}

function staticAsset(pathname: string, assets: DashboardAssets) {
  if (pathname === "/" || pathname === "/index.html") {
    return { body: assets.html, contentType: "text/html; charset=utf-8", cacheControl: "no-store" };
  }
  if (pathname === "/styles.css") {
    return { body: assets.css, contentType: "text/css; charset=utf-8", cacheControl: "no-cache" };
  }
  if (pathname === "/app.js") {
    return {
      body: assets.js,
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "no-cache"
    };
  }
  if (pathname === "/favicon.svg" || pathname === "/favicon.ico") {
    return {
      body: assets.favicon,
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=86400"
    };
  }
  return null;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function validHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      Number(parsed.port || 80) === port
    );
  } catch {
    return false;
  }
}

function validOrigin(value: string | undefined, port: number): boolean {
  if (!value) return true;
  return value === `http://localhost:${port}` || value === `http://127.0.0.1:${port}`;
}

function validToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireJson(request: IncomingMessage): void {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json")
    throw new HttpInputError("Content-Type must be application/json.");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > DASHBOARD_REQUEST_BODY_LIMIT) {
      throw new HttpInputError("Request body is too large.");
    }
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpInputError("Request body must contain valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.byteLength);
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  value: string,
  contentType: string
): void {
  const body = Buffer.from(value, "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", body.byteLength);
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function parseScope(value: string): "relevant" | "personal" | "project" | "all" {
  if (value === "relevant" || value === "personal" || value === "project" || value === "all") {
    return value;
  }
  throw new HttpInputError("Invalid scope filter.");
}

function parseInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new HttpInputError("Invalid numeric query parameter.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpInputError("Numeric query parameter is out of range.");
  }
  return parsed;
}

export function openDashboardBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    // Opening the browser is a convenience; the printed URL remains usable.
  });
  child.unref();
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof HttpInputError) return error.message;
  if (error instanceof z.ZodError) return "The request did not match the expected schema.";
  if (error instanceof Error) return error.message.replaceAll(/[\r\n]+/g, " ").slice(0, 500);
  return "Unexpected dashboard error.";
}

class HttpInputError extends Error {}
