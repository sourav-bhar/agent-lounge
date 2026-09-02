import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBoardStore } from "../src/storage.js";
import { startDashboard, type DashboardHandle } from "../src/ui-server.js";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryProject } from "./helpers.js";

let dashboard: DashboardHandle;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  const home = path.join(await temporaryDirectory("dashboard"), "board");
  const store = new AgentBoardStore({
    home,
    projectRoot: await temporaryProject("dashboard-project"),
    client: "dashboard-test"
  });
  dashboard = await startDashboard({ store, port: 0, openBrowser: false });
  const url = new URL(dashboard.url);
  token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
  baseUrl = `http://127.0.0.1:${dashboard.port}`;
});

afterEach(async () => {
  await dashboard.close();
  await cleanupTemporaryDirectories();
});

describe("local dashboard server", () => {
  it("serves only explicit local assets with restrictive browser headers", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("AGENT");

    const head = await fetch(`${baseUrl}/styles.css`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${baseUrl}/favicon.svg`)).headers.get("content-type")).toBe(
      "image/svg+xml"
    );
    expect((await fetch(`${baseUrl}/package.json`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/`, { method: "POST" })).status).toBe(405);
  });

  it("requires the fragment-delivered token and rejects cross-origin API calls", async () => {
    expect((await fetch(`${baseUrl}/api/stats`)).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/api/stats`, {
          headers: {
            "X-Agent-Board-Token": token,
            Origin: "https://example.invalid"
          }
        })
      ).status
    ).toBe(403);

    const invalidHost = await rawRequest(dashboard.port, {
      Host: `example.invalid:${dashboard.port}`,
      "X-Agent-Board-Token": token
    });
    expect(invalidHost.status).toBe(421);

    const authorized = await api("/api/stats");
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      ok: true,
      message_count: 0,
      trashed_count: 0,
      malformed_count: 0,
      store_permissions: process.platform === "win32" ? null : "0700"
    });
  });

  it("posts, lists, searches, and curates messages through the dashboard API", async () => {
    const body = "Render <script>alert('never')</script> as inert message text.";
    const created = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        scope: "personal",
        kind: "note",
        topic: "Literal markup stays data",
        body,
        tags: ["dashboard"],
        evidence: "human_note",
        confidence: "high",
        reply_to: null,
        supersedes: null
      })
    });
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as { message: { id: string } };

    const listed = await api("/api/messages?scope=all&query=markup%20inert&limit=10");
    const listedJson = (await listed.json()) as {
      total: number;
      items: Array<{ message: { body: string }; curation: { state: string } | null }>;
    };
    expect(listedJson.total).toBe(1);
    expect(listedJson.items[0]?.message.body).toBe(body);

    const pinned = await api(`/api/curation/${createdJson.message.id}`, {
      method: "POST",
      body: JSON.stringify({ state: "pinned", note: "Human reviewed" })
    });
    expect(pinned.status).toBe(200);
    const afterPin = (await (await api("/api/messages?scope=all")).json()) as {
      items: Array<{ curation: { state: string; note?: string } | null }>;
    };
    expect(afterPin.items[0]?.curation).toMatchObject({
      state: "pinned",
      note: "Human reviewed"
    });

    const cleared = await api(`/api/curation/${createdJson.message.id}`, {
      method: "POST",
      body: JSON.stringify({ state: "clear" })
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, cleared: true });
  });

  it("returns bounded, non-leaking 4xx errors for invalid input", async () => {
    const wrongType = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: { "X-Agent-Board-Token": token },
      body: "{}"
    });
    expect(wrongType.status).toBe(400);

    const malformed = await api("/api/messages", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: "Request body must contain valid JSON."
    });

    expect((await api("/api/messages?scope=elsewhere")).status).toBe(400);
    expect((await api("/api/messages?limit=1000")).status).toBe(400);
    expect((await api("/api/messages?kind=unknown")).status).toBe(400);

    const schemaMismatch = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ topic: "Missing body" })
    });
    expect(schemaMismatch.status).toBe(400);
    expect(await schemaMismatch.json()).toMatchObject({
      error: "The request did not match the expected schema."
    });

    const syntheticSecret = `npm_${"z".repeat(32)}`;
    const sensitive = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        topic: "Rejected",
        body: syntheticSecret
      })
    });
    expect(sensitive.status).toBe(400);
    const sensitiveError = JSON.stringify(await sensitive.json());
    expect(sensitiveError).toMatch(/sensitive data/i);
    expect(sensitiveError).not.toContain(syntheticSecret);

    const oversized = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ topic: "Large", body: "a".repeat(17_000) })
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: "Request body is too large." });
    expect((await api("/api/not-a-route")).status).toBe(404);
  });
});

function api(pathname: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "X-Agent-Board-Token": token,
      Origin: `http://localhost:${dashboard.port}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
}

function rawRequest(
  port: number,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/stats", method: "GET", headers },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}
