/**
 * Studio routes for the ElevenLabs key pool: session, privilege and CSRF gates,
 * and no plaintext key or secretRef in any response body.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handleStudioRoute } from "../src/player/studio.js";
import { resetElevenLabsVoiceCheckCache } from "../src/llm/elevenlabsTts.js";

const TMP_ROOT = "/tmp/opencode";
const KEY_A = "sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111";
const KEY_B = "sk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222";
const BAD_KEY = "sk_badbadbadbadbadbadbadbadbadbadbadbadbadbad9999";
const LIB_VOICE = "J2FGlQG8Gd7x8uEDt2H8";
const CSRF = "el-csrf";
const realFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const key = String((init?.headers as Record<string, string>)?.["xi-api-key"] ?? "");
  if (key === BAD_KEY) return json(401, { detail: { type: "authentication_error", code: "invalid_api_key" } });
  if (url.includes("/v1/user/subscription")) {
    return json(200, { tier: "free", status: "active", character_count: 1, character_limit: 10000, can_extend_character_limit: false });
  }
  if (url.endsWith("/v1/voices")) return json(200, { voices: [{ voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", category: "premade" }] });
  if (url.includes(`/v1/voices/${LIB_VOICE}`)) return json(404, { detail: { code: "voice_not_found" } });
  if (url.includes("/v1/shared-voices")) return json(200, { voices: [{ voice_id: LIB_VOICE, name: "Pharaoh", category: "high_quality" }] });
  return json(404, { detail: { code: "not_found" } });
});

interface Call { status: number; body: any }

async function call(
  method: string, pathname: string, body?: unknown,
  opts: { privileged?: boolean; csrf?: string | null; origin?: string | null } = {},
): Promise<Call> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = method;
  const headers: Record<string, string> = { host: "studio.local" };
  if (opts.origin !== null) headers.origin = opts.origin ?? "http://studio.local";
  if (opts.csrf !== null) headers["x-csrf-token"] = opts.csrf ?? CSRF;
  req.headers = headers;
  const url = new URL(pathname, "http://studio.local");
  let result!: Call;
  await handleStudioRoute(req, {} as ServerResponse, url.pathname, url, {
    user: "admin", exp: Date.now() + 60_000, isTemp: false, privileged: opts.privileged ?? true, csrfToken: CSRF,
  }, (_res, status, response) => { result = { status, body: response }; });
  return result;
}

function assertNoSecrets(c: Call): void {
  const text = JSON.stringify(c.body);
  for (const k of [KEY_A, KEY_B, BAD_KEY]) expect(text).not.toContain(k);
  expect(text).not.toContain("elevenlabs-key:");
  expect(text).not.toContain("secretRef");
  expect(text).not.toContain("fingerprint");
}

let outDir: string;

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  outDir = fs.mkdtempSync(path.join(TMP_ROOT, "el-routes-"));
  vi.stubEnv("MANHWA_OUT_DIR", outDir);
  vi.stubGlobal("fetch", upstream);
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetElevenLabsVoiceCheckCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("ElevenLabs studio routes", () => {
  it("runs the key lifecycle without leaking keys", async () => {
    const empty = await call("GET", "/api/studio/elevenlabs/keys");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ keys: [], defaultModel: "eleven_v4", defaultVoice: "JBFqnCBsd6RMkjVDRZzb" });
    expect(empty.body.models.length).toBeGreaterThan(0);

    const added = await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A, label: "main" });
    expect(added.status).toBe(201);
    expect(added.body.key).toMatchObject({ label: "main", tier: "free", status: "ok" });
    assertNoSecrets(added);
    const b = await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_B });
    expect(b.status).toBe(201);
    const idA = added.body.key.id as string;
    const idB = b.body.key.id as string;

    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A })).status).toBe(409);
    const bad = await call("POST", "/api/studio/elevenlabs/keys", { key: BAD_KEY });
    expect(bad.status).toBe(400);
    assertNoSecrets(bad);
    expect((await call("POST", "/api/studio/elevenlabs/keys", {})).status).toBe(400);

    const patched = await call("PATCH", `/api/studio/elevenlabs/keys/${idA}`, { enabled: false, allowOverage: true });
    expect(patched.status).toBe(200);
    expect(patched.body.key).toMatchObject({ enabled: false, allowOverage: true, status: "disabled" });
    expect((await call("PATCH", `/api/studio/elevenlabs/keys/${idA}`, { enabled: "yes" })).status).toBe(400);
    expect((await call("PATCH", "/api/studio/elevenlabs/keys/el_missing", { label: "x" })).status).toBe(404);

    const order = await call("PUT", "/api/studio/elevenlabs/keys/order", { ids: [idB, idA] });
    expect(order.status).toBe(200);
    expect(order.body.keys.map((k: any) => k.id)).toEqual([idB, idA]);
    expect((await call("PUT", "/api/studio/elevenlabs/keys/order", { ids: "x" })).status).toBe(400);

    const refreshed = await call("POST", `/api/studio/elevenlabs/keys/${idB}/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.key.id).toBe(idB);

    const list = await call("GET", "/api/studio/elevenlabs/keys");
    assertNoSecrets(list);
    expect(list.body.keys).toHaveLength(2);

    const voices = await call("GET", "/api/studio/elevenlabs/voices");
    expect(voices.status).toBe(200);
    expect(voices.body.voices[0]).toEqual({ voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", category: "premade" });

    const check = await call("GET", `/api/studio/elevenlabs/voice-check?voiceId=${LIB_VOICE}`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ voiceId: LIB_VOICE, found: true, library: true, needsPaidKey: true, paidKeyAvailable: false });
    expect((await call("GET", "/api/studio/elevenlabs/voice-check?voiceId=bad!")).status).toBe(400);

    expect((await call("DELETE", `/api/studio/elevenlabs/keys/${idA}`, {})).body).toEqual({ ok: true });
    expect((await call("DELETE", `/api/studio/elevenlabs/keys/${idA}`, {})).status).toBe(404);

    for (const f of ["elevenlabs-keys.json", "elevenlabs-pool-state.json"]) {
      const text = fs.readFileSync(path.join(outDir, "config", f), "utf8");
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
    }
  });

  it("returns 409 for voice routes with no usable key", async () => {
    expect((await call("GET", "/api/studio/elevenlabs/voices")).status).toBe(409);
    expect((await call("GET", `/api/studio/elevenlabs/voice-check?voiceId=${LIB_VOICE}`)).status).toBe(409);
  });

  it("maps an inconclusive voice check to 502 and scrubs keys from the message", async () => {
    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A })).status).toBe(201);
    const original = upstream.getMockImplementation()!;
    upstream.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/v1/voices/${LIB_VOICE}`) || url.includes("/v1/shared-voices")) {
        return json(403, { detail: { code: "forbidden", message: `denied for ${KEY_A}` } });
      }
      return json(404, { detail: { code: "not_found" } });
    });
    let check: Call;
    try {
      check = await call("GET", `/api/studio/elevenlabs/voice-check?voiceId=${LIB_VOICE}`);
    } finally {
      upstream.mockImplementation(original);
    }
    expect(check.status).toBe(502);
    expect(typeof check.body.error).toBe("string");
    assertNoSecrets(check);
  });

  it("rejects mutations from non-privileged sessions but allows reads", async () => {
    expect((await call("GET", "/api/studio/elevenlabs/keys", undefined, { privileged: false })).status).toBe(200);
    const denied = await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A }, { privileged: false });
    expect(denied.status).toBe(403);
    expect(upstream).not.toHaveBeenCalledWith(expect.stringContaining("subscription"), expect.anything());
    for (const [method, p] of [
      ["PATCH", "/api/studio/elevenlabs/keys/el_x"],
      ["DELETE", "/api/studio/elevenlabs/keys/el_x"],
      ["POST", "/api/studio/elevenlabs/keys/el_x/refresh"],
      ["PUT", "/api/studio/elevenlabs/keys/order"],
    ] as const) {
      expect((await call(method, p, {}, { privileged: false })).status).toBe(403);
    }
  });

  it("enforces CSRF on mutations", async () => {
    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A }, { csrf: null })).status).toBe(403);
    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A }, { csrf: "wrong" })).status).toBe(403);
    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/studio/elevenlabs/keys", { key: KEY_A }, { origin: null })).status).toBe(403);
    expect(fs.existsSync(path.join(outDir, "config", "elevenlabs-keys.json"))).toBe(false);
  });
});

describe("ElevenLabs studio routes over HTTP", () => {
  let root: string;
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, "el-http-"));
    vi.stubEnv("PLAYER_HTPASSWD", path.join(root, "users"));
    vi.stubEnv("PLAYER_SECRET_FILE", path.join(root, "secret"));
    vi.stubEnv("PLAYER_TEMP_USERS", path.join(root, "temp-users"));
    vi.stubEnv("MANHWA_OUT_DIR", path.join(root, "out"));
    vi.stubEnv("MANHWA_SERIES_ROOT", path.join(root, "series"));
    vi.stubEnv("MANHWA_NO_AUTO_WORKER", "1");
    vi.stubEnv("PLAYER_API_ONLY", "1");
    const mod = await import("../src/player/server.js");
    fs.writeFileSync(path.join(root, "users"), `admin:${mod.apr1("test-password", "fixture")}\n`);
    server = mod.createPlayerServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns 401 without a session", async () => {
    for (const p of ["/api/studio/elevenlabs/keys", `/api/studio/elevenlabs/voice-check?voiceId=${LIB_VOICE}`]) {
      const res = await realFetch(`${base}${p}`);
      expect(res.status).toBe(401);
    }
    const post = await realFetch(`${base}/api/studio/elevenlabs/keys`, {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ key: KEY_A }),
    });
    expect(post.status).toBe(401);
  });
});
