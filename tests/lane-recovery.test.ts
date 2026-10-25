/**
 * Lane cooldown recovery: a provider account change or a manual reset clears a
 * stale cooldown in a running process. All config, secrets, logs and status
 * files live in a private temp MANHWA_OUT_DIR.
 */
import fs from "node:fs";
import type http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { putSecret } from "../src/config/secretStore.js";
import { putStagesConfig, upsertProvider } from "../src/config/studioConfig.js";
import * as llm from "../src/llm/client.js";
import { handleStudioRoute } from "../src/player/studio.js";
import * as tel from "../src/telemetry/telemetry.js";

const SECRET_A1 = "sk-lane-a-first-secret-0001";
const SECRET_A2 = "sk-lane-a-rotated-secret-000002";
const SECRET_B = "sk-lane-b-only-secret-0003";

let root: string;
let outDir: string;
let clock: number;
let logLines: string[];

function provider(id: string, apiKey: string): void {
  upsertProvider({
    id,
    preset: "custom-openai",
    label: id,
    baseUrl: `https://${id}.example/v1`,
    apiKey,
    models: [{
      id: "m1",
      label: "M1",
      enabled: true,
      capabilities: { vision: true, writer: true, json: true, reasoning: false, streaming: false, tts: false },
    }],
  }, outDir);
}

/** Fetch stub: status per host, 200 otherwise. */
function stubFetch(statusByHost: Record<string, number>): string[] {
  const hits: string[] = [];
  llm._setFetchForTests(async (input) => {
    const host = new URL(String(input)).host;
    hits.push(host);
    const status = statusByHost[host] ?? 200;
    if (status !== 200) return new Response('{"error":"account rejected"}', { status });
    return new Response(JSON.stringify({ choices: [{ message: { content: `ok ${host}` } }] }), { status: 200 });
  });
  return hits;
}

const write = () => llm.call([{ role: "user", content: "write" }], { stage: "writer", retries: 1 });

beforeEach(() => {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  root = fs.mkdtempSync("/tmp/opencode/lane-recovery-");
  outDir = path.join(root, "out");
  vi.stubEnv("MANHWA_OUT_DIR", outDir);
  vi.stubEnv("MANHWA_NO_AUTO_WORKER", "1");
  vi.stubEnv("PIPELINE_LOG", path.join(root, "pipeline.log"));
  vi.stubEnv("PIPELINE_STATUS_DIR", path.join(root, "status"));
  vi.stubEnv("PIPELINE_ENV", path.join(root, "no.env"));
  logLines = [];
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(" ")); });
  }
  clock = 1_800_000_000_000;
  llm._setClockForTests(() => clock);
  llm._setSleepForTests(async () => {});
  llm._resetSnapshotForTests();
  tel._reset();
  provider("lane-a", SECRET_A1);
  provider("lane-b", SECRET_B);
  putStagesConfig({
    stages: { writer: { chain: ["lane-a:m1", "lane-b:m1"], concurrency: 1, temperature: 0.5, inheritFrom: null } },
  }, outDir);
  tel.start("lane-series", ["ch1"]);
});

afterEach(() => {
  const everything = [
    ...logLines,
    fs.existsSync(path.join(root, "pipeline.log")) ? fs.readFileSync(path.join(root, "pipeline.log"), "utf8") : "",
    JSON.stringify(tel._data() ?? {}),
  ].join("\n");
  for (const secret of [SECRET_A1, SECRET_A2, SECRET_B, "vertex-token-account"]) expect(everything).not.toContain(secret);
  tel._reset();
  llm._setFetchForTests(null);
  llm._setSleepForTests(null);
  llm._setClockForTests(null);
  llm._resetSnapshotForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lane cooldown recovery", () => {
  it("a 403 cools the lane and reports the reason", async () => {
    const hits = stubFetch({ "lane-a.example": 403 });
    await expect(write()).resolves.toMatchObject({ choices: [{ message: { content: "ok lane-b.example" } }] });
    expect(llm.laneCooldownLeft("lane-a")).toBeGreaterThan(1700);
    expect(llm.laneCooldownLeft("lane-b")).toBe(0);
    expect(tel._data()?.providers["lane-a"]).toMatchObject({ coolingReason: "HTTP 403 rejected" });
    await write();
    expect(hits).toEqual(["lane-a.example", "lane-b.example", "lane-b.example"]);
    expect(fs.readFileSync(path.join(root, "pipeline.log"), "utf8")).toContain("COOLDOWN lane lane-a for 1800s");
  });

  it("a rotated secret clears only that lane's cooldown, on the first call after 5s", async () => {
    stubFetch({ "lane-a.example": 403, "lane-b.example": 403 });
    await expect(write()).rejects.toThrow(/all lanes failed/);
    expect(llm.laneCooldownLeft("lane-a")).toBeGreaterThan(0);
    expect(llm.laneCooldownLeft("lane-b")).toBeGreaterThan(0);

    putSecret("provider:lane-a", SECRET_A2, outDir);
    const hits = stubFetch({});
    clock += 1000;
    await expect(write()).rejects.toThrow(/lane cooling/);
    expect(hits).toEqual([]);

    clock += 5000;
    await expect(write()).resolves.toMatchObject({ choices: [{ message: { content: "ok lane-a.example" } }] });
    expect(llm.laneCooldownLeft("lane-a")).toBe(0);
    expect(llm.laneCooldownLeft("lane-b")).toBeGreaterThan(0);
    expect(tel._data()?.providers["lane-a"]).toMatchObject({ coolingUntil: null });
    expect((tel._data()?.providers["lane-b"] as Record<string, unknown> | undefined)?.coolingUntil).toEqual(expect.any(Number));
    expect(fs.readFileSync(path.join(root, "pipeline.log"), "utf8"))
      .toContain("COOLDOWN cleared lane lane-a (provider settings changed)");
  });

  it("an unchanged config keeps cooldowns across reload checks", async () => {
    stubFetch({ "lane-a.example": 403 });
    await write();
    clock += 6000;
    await write();
    expect(llm.laneCooldownLeft("lane-a")).toBeGreaterThan(0);
  });

  it("lane-resets.json clears a cooldown older than the reset, not a newer one", async () => {
    stubFetch({ "lane-a.example": 403 });
    await write();
    const resetAt = clock + 10;
    clock += 1000;
    stubFetch({ "lane-a.example": 200, "lane-b.example": 403 });
    clock += 5000;
    // lane-a still cooling, so lane-b answers 403 and cools after the reset time
    await expect(write()).rejects.toThrow(/all lanes failed/);
    expect(llm.laneCooldownLeft("lane-b")).toBeGreaterThan(0);

    llm.writeLaneReset("lane-a", resetAt, outDir);
    llm.writeLaneReset("lane-b", resetAt, outDir);
    expect(fs.statSync(llm.laneResetsPath(outDir)).mode & 0o777).toBe(0o600);
    stubFetch({});
    clock += 5000;
    await expect(write()).resolves.toMatchObject({ choices: [{ message: { content: "ok lane-a.example" } }] });
    expect(llm.laneCooldownLeft("lane-a")).toBe(0);
    expect(llm.laneCooldownLeft("lane-b")).toBeGreaterThan(0);
  });

  it("keys the Vertex LLM token cache per account", async () => {
    upsertProvider({
      id: "vertex-ai",
      preset: "vertex-ai",
      auth: { mode: "vertex-oauth", projectId: "p1", secretRef: "provider:vertex-ai" },
    }, outDir);
    putSecret("provider:vertex-ai", JSON.stringify({ access_token: "vertex-token-account-one" }), outDir);
    expect(await llm.vertexToken()).toBe("vertex-token-account-one");
    putSecret("provider:vertex-ai", JSON.stringify({ access_token: "vertex-token-account-two" }), outDir);
    expect(await llm.vertexToken()).toBe("vertex-token-account-two");
  });
});

async function studioRequest(
  body: Record<string, unknown>,
  opts: { privileged?: boolean; csrf?: string } = {},
): Promise<{ status: number; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    host: "studio.local",
    origin: "http://studio.local",
    "x-csrf-token": opts.csrf ?? "test-csrf",
    "content-type": "application/json",
  };
  let result!: { status: number; body: any };
  await handleStudioRoute(req, {} as ServerResponse, "/api/studio/lanes/reset", new URL("http://studio.local/api/studio/lanes/reset"), {
    user: "admin", exp: Date.now() + 60_000, isTemp: !(opts.privileged ?? true), privileged: opts.privileged ?? true, csrfToken: "test-csrf",
  }, (_res, status, response) => { result = { status, body: response }; });
  return result;
}

describe("POST /api/studio/lanes/reset", () => {
  it("guards privilege and CSRF, validates the lane, writes the file and clears this process's cooldown", async () => {
    stubFetch({ "lane-a.example": 403 });
    await write();
    expect(llm.laneCooldownLeft("lane-a")).toBeGreaterThan(0);

    expect((await studioRequest({ lane: "lane-a" }, { privileged: false })).status).toBe(403);
    expect((await studioRequest({ lane: "lane-a" }, { csrf: "wrong-token" })).status).toBe(403);
    expect((await studioRequest({ lane: "nope" })).status).toBe(400);
    expect((await studioRequest({ lane: 7 })).status).toBe(400);
    expect(fs.existsSync(llm.laneResetsPath(outDir))).toBe(false);
    expect(llm.laneCooldownLeft("lane-a")).toBeGreaterThan(0);

    const ok = await studioRequest({ lane: "lane-a" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, lane: "lane-a", at: expect.any(Number) });
    expect(llm.laneCooldownLeft("lane-a")).toBe(0);
    const file = llm.laneResetsPath(outDir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "lane-a": ok.body.at });
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("requires a session through the player server", async () => {
    vi.stubEnv("PLAYER_HTPASSWD", path.join(root, ".htpasswd"));
    vi.stubEnv("PLAYER_SECRET_FILE", path.join(root, ".auth_secret"));
    vi.stubEnv("PLAYER_TEMP_USERS", path.join(root, ".temp_users.json"));
    vi.stubEnv("MANHWA_SETUP_MODE", "0");
    const serverMod = await import("../src/player/server.js");
    const srv: http.Server = serverMod.createPlayerServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const res = await globalThis.fetch(`${base}/api/studio/lanes/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ lane: "lane-a" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
