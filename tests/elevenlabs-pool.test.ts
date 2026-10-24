/**
 * ElevenLabs key pool: storage, rotation per error class, pool wait, budget
 * checks and secret hygiene. Every test uses its own temp MANHWA_OUT_DIR and a
 * mocked fetch; nothing reaches the network.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as el from "../src/llm/elevenlabsTts.js";

const TMP_ROOT = "/tmp/opencode";
const KEY_A = "sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111";
const KEY_B = "sk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222";
const KEY_C = "sk_cccccccccccccccccccccccccccccccccccccccccccc3333";
const VOICE = "JBFqnCBsd6RMkjVDRZzb";
const LIB_VOICE = "J2FGlQG8Gd7x8uEDt2H8";
const RESET_UNIX = Math.floor(Date.now() / 1000) + 30 * 86400;

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Api {
  fetch: typeof fetch;
  tts: Record<string, Handler>;
  subs: Record<string, Handler>;
  calls: Array<{ url: string; key: string; method: string }>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function audio(cost = 12): Response {
  return new Response(Buffer.alloc(2048, 7), { status: 200, headers: { "content-type": "audio/mpeg", "character-cost": String(cost) } });
}

function sub(over: Record<string, unknown> = {}): Response {
  return json(200, {
    tier: "free", status: "active", character_count: 100, character_limit: 10000,
    next_character_count_reset_unix: RESET_UNIX, can_extend_character_limit: false, ...over,
  });
}

function detail(status: number, d: Record<string, unknown>, headers?: Record<string, string>): Handler {
  return () => json(status, { detail: d }, headers);
}

function makeApi(): Api {
  const api: Api = {
    tts: {},
    subs: {},
    calls: [],
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const key = String((init.headers as Record<string, string>)?.["xi-api-key"] ?? "");
      api.calls.push({ url, key, method: init.method ?? "GET" });
      if (url.includes("/v1/user/subscription")) return (api.subs[key] ?? (() => sub()))(url, init);
      if (url.includes("/v1/text-to-speech/")) return (api.tts[key] ?? (() => audio()))(url, init);
      return json(404, { detail: { code: "not_found" } });
    }) as typeof fetch,
  };
  return api;
}

let outDir: string;
let env: NodeJS.ProcessEnv;
let api: Api;
let logs: string[];

function cfg(file: string): string {
  return path.join(outDir, "config", file);
}

function readState(): any {
  return JSON.parse(fs.readFileSync(cfg(el.ELEVENLABS_POOL_STATE_FILENAME), "utf8"));
}

function writeState(s: unknown): void {
  fs.writeFileSync(cfg(el.ELEVENLABS_POOL_STATE_FILENAME), JSON.stringify(s));
}

async function addKey(key: string, label?: string) {
  return el.addElevenLabsKey(key, label, env, { fetchImpl: api.fetch });
}

function synth(extra: Partial<el.SynthesizeElevenLabsOptions> = {}) {
  return el.synthesizeElevenLabsToFile({
    text: "Hello there.", voiceId: VOICE, modelId: "eleven_v4", destPath: path.join(outDir, "line.mp3"),
    env, fetchImpl: api.fetch, ...extra,
  });
}

function ttsCalls(key: string) {
  return api.calls.filter((c) => c.key === key && c.url.includes("/v1/text-to-speech/")).length;
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  outDir = fs.mkdtempSync(path.join(TMP_ROOT, "el-pool-"));
  env = { ...process.env, MANHWA_OUT_DIR: outDir, MANHWA_ELEVENLABS_POOL_WAIT_S: "0", ELEVENLABS_API_URL: "" };
  api = makeApi();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  el.resetElevenLabsVoiceCheckCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("classifyElevenLabsError", () => {
  it.each([
    [402, { detail: { type: "payment_required", code: "insufficient_credits" } }, "quota"],
    [401, { detail: { status: "quota_exceeded", message: "quota" } }, "quota"],
    [401, { detail: { type: "authentication_error", code: "invalid_api_key" } }, "auth"],
    [400, { detail: { type: "authentication_error", code: "invalid_api_key" } }, "auth"],
    [402, { detail: { type: "payment_required", code: "paid_plan_required" } }, "plan"],
    [403, { detail: { code: "model_access_denied" } }, "plan"],
    [404, { detail: { code: "voice_not_found" } }, "voice"],
    [429, { detail: { code: "concurrent_limit_exceeded" } }, "rate"],
    [401, { detail: { status: "detected_unusual_activity" } }, "auth"],
    [503, "Service Unavailable", "server"],
    [422, { detail: [{ msg: "field required" }] }, "request"],
    [400, { detail: "bad thing" }, "request"],
  ])("HTTP %i %j -> %s", (status, body, kind) => {
    expect(el.classifyElevenLabsError(status, body).kind).toBe(kind);
  });
});

describe("key management", () => {
  it("adds keys without storing plaintext in the index; files are 0600", async () => {
    const a = await addKey(KEY_A, "first");
    expect(a).toMatchObject({ label: "first", tier: "free", characterLimit: 10000, status: "ok", allowOverage: false });
    expect(a.hint).toContain("1111");
    expect(JSON.stringify(a)).not.toContain(KEY_A);
    await synth();
    const index = fs.readFileSync(cfg(el.ELEVENLABS_KEYS_FILENAME), "utf8");
    expect(index).not.toContain(KEY_A);
    expect(index).toContain("elevenlabs-key:");
    expect(fs.readFileSync(cfg(el.ELEVENLABS_POOL_STATE_FILENAME), "utf8")).not.toContain(KEY_A);
    for (const f of [el.ELEVENLABS_KEYS_FILENAME, el.ELEVENLABS_POOL_STATE_FILENAME, "secrets.json"]) {
      expect(fs.statSync(cfg(f)).mode & 0o777).toBe(0o600);
    }
    expect(el.hasElevenLabsKeys(env)).toBe(true);
  });

  it("rejects invalid and duplicate keys; accepts scoped keys without user_read", async () => {
    api.subs[KEY_A] = detail(401, { type: "authentication_error", code: "invalid_api_key", message: `bad key ${KEY_A}` });
    const err = await addKey(KEY_A).catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsKeyError);
    expect(err.code).toBe("invalid");
    expect(String(err.message)).not.toContain(KEY_A);
    expect(el.listElevenLabsKeys(env)).toHaveLength(0);

    await addKey(KEY_B);
    await expect(addKey(KEY_B)).rejects.toMatchObject({ code: "duplicate" });

    api.subs[KEY_C] = detail(401, { status: "missing_permissions", message: "missing user_read" });
    const c = await addKey(KEY_C);
    expect(c.tier).toBe("unknown");
    expect(c.statusReason).toBe("key cannot read its usage");

    api.subs[KEY_A] = () => { throw new TypeError("fetch failed"); };
    await expect(addKey(KEY_A)).rejects.toMatchObject({ code: "network" });
  });

  it("reorders, disables and removes keys", async () => {
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    expect((await synth()).keyId).toBe(a.id);
    expect(el.reorderElevenLabsKeys([b.id], env).map((k) => k.id)).toEqual([b.id, a.id]);
    expect((await synth()).keyId).toBe(b.id);
    const disabled = el.updateElevenLabsKey(b.id, { enabled: false, label: "spare" }, env);
    expect(disabled).toMatchObject({ status: "disabled", label: "spare", enabled: false });
    expect((await synth()).keyId).toBe(a.id);
    el.updateElevenLabsKey(a.id, { enabled: false }, env);
    expect(el.hasElevenLabsKeys(env)).toBe(false);
    await expect(synth()).rejects.toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(() => el.reorderElevenLabsKeys(["nope"], env)).toThrow(el.ElevenLabsKeyError);
    expect(el.removeElevenLabsKey(a.id, env)).toBe(true);
    expect(el.removeElevenLabsKey(a.id, env)).toBe(false);
    expect(el.listElevenLabsKeys(env).map((k) => k.id)).toEqual([b.id]);
    expect(fs.readFileSync(cfg("secrets.json"), "utf8")).not.toContain(KEY_A);
  });
});

describe("rotation", () => {
  it.each([
    ["402 insufficient_credits", detail(402, { type: "payment_required", code: "insufficient_credits" }), "exhausted"],
    ["legacy 401 quota_exceeded", detail(401, { status: "quota_exceeded", message: "quota" }), "exhausted"],
    ["401 invalid_api_key", detail(401, { type: "authentication_error", code: "invalid_api_key" }), "invalid"],
    ["400 authentication_error", detail(400, { type: "authentication_error", code: "invalid_api_key" }), "invalid"],
    ["429 concurrent_limit_exceeded", detail(429, { code: "concurrent_limit_exceeded" }), "cooldown"],
  ])("%s marks the key and uses the next one", async (_name, handler, status) => {
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    api.tts[KEY_A] = handler;
    const res = await synth();
    expect(res).toEqual({ keyId: b.id, characterCost: 12 });
    expect(fs.statSync(path.join(outDir, "line.mp3")).size).toBe(2048);
    const summary = el.listElevenLabsKeys(env).find((k) => k.id === a.id)!;
    expect(summary.status).toBe(status);
    if (status === "exhausted") {
      expect(summary.statusUntil).toBe(RESET_UNIX * 1000);
      expect(summary.statusReason).toContain("quota exhausted until");
    }
    if (status === "cooldown") {
      expect(summary.statusUntil! - Date.now()).toBeLessThanOrEqual(5000);
    }
    expect(logs.some((l) => l.startsWith(`   audio: elevenlabs key ${a.hint} `) && l.endsWith("; trying next key"))).toBe(true);
    expect(logs.join("\n")).not.toContain(KEY_A);
  });

  it.each([
    ["402 paid_plan_required", detail(402, { type: "payment_required", code: "paid_plan_required" }), LIB_VOICE, LIB_VOICE],
    ["404 voice_not_found", detail(404, { code: "voice_not_found" }), LIB_VOICE, LIB_VOICE],
    ["403 model_access_denied", detail(403, { code: "model_access_denied" }), VOICE, "model:eleven_v4"],
  ])("%s blocks the key for that voice or model only", async (_name, handler, voiceId, block) => {
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    api.tts[KEY_A] = handler;
    expect((await synth({ voiceId })).keyId).toBe(b.id);
    const summary = el.listElevenLabsKeys(env).find((k) => k.id === a.id)!;
    expect(summary.status).toBe("ok");
    expect(summary.blockedVoices).toEqual([block]);
    // Second call skips the blocked key without asking it again.
    const before = ttsCalls(KEY_A);
    expect((await synth({ voiceId })).keyId).toBe(b.id);
    expect(ttsCalls(KEY_A)).toBe(before);
    // Another voice/model still uses key A.
    api.tts[KEY_A] = () => audio();
    const other = block.startsWith("model:") ? { modelId: "eleven_v3" } : { voiceId: VOICE };
    expect((await synth(other)).keyId).toBe(a.id);
  });

  it("5xx throws a retryable error without rotating", async () => {
    await addKey(KEY_A);
    await addKey(KEY_B);
    api.tts[KEY_A] = () => json(500, { detail: { code: "internal_error", message: "boom" } });
    const err = await synth().catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsRequestError);
    expect(err).toMatchObject({ status: 500, retryable: true });
    expect(err.message).toMatch(/^ElevenLabs HTTP 500 internal_error:/);
    expect(ttsCalls(KEY_B)).toBe(0);
  });

  it("network failure throws retryable 503", async () => {
    await addKey(KEY_A);
    api.tts[KEY_A] = () => { throw new TypeError(`fetch failed for ${KEY_A}`); };
    const err = await synth().catch((e) => e);
    expect(err).toMatchObject({ status: 503, retryable: true });
    expect(err.message).not.toContain(KEY_A);
  });

  it("400 validation throws non-retryable without rotating", async () => {
    await addKey(KEY_A);
    await addKey(KEY_B);
    api.tts[KEY_A] = detail(400, { type: "validation_error", code: "invalid_parameters", message: "bad text" });
    const err = await synth().catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsRequestError);
    expect(err).toMatchObject({ status: 400, code: "invalid_parameters", retryable: false });
    expect(ttsCalls(KEY_B)).toBe(0);
  });

  it("rejects a non-audio body as retryable", async () => {
    await addKey(KEY_A);
    api.tts[KEY_A] = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(synth()).rejects.toMatchObject({ retryable: true, status: 502 });
    expect(fs.existsSync(path.join(outDir, "line.mp3"))).toBe(false);
  });

  it("all keys cooling down throws retryable 429", async () => {
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(429, { code: "rate_limit_exceeded" }, { "retry-after": "12" });
    const err = await synth().catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsRequestError);
    expect(err).toMatchObject({ status: 429, retryable: true });
    const s = el.listElevenLabsKeys(env)[0]!;
    expect(s.status).toBe("cooldown");
    expect(s.statusUntil! - Date.now()).toBeGreaterThan(10_000);
  });

  it("pool exhaustion lists every key with its reason", async () => {
    await addKey(KEY_A);
    await addKey(KEY_B);
    const plan = detail(402, { type: "payment_required", code: "paid_plan_required" });
    api.tts[KEY_A] = plan;
    api.tts[KEY_B] = plan;
    const err = await synth({ voiceId: LIB_VOICE }).catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(err.permanent).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/^ElevenLabs key pool exhausted: /);
    expect(err.reasons).toHaveLength(2);
    for (const r of err.reasons) expect(r.reason).toBe(`voice ${LIB_VOICE} needs a paid plan`);
    expect(err.message).toContain("(free): voice");
    expect(err.message).not.toContain(KEY_A);
  });

  it("puts a per-reason count first so a 400-char report cut keeps it", async () => {
    await addKey(KEY_A);
    await addKey(KEY_B);
    api.tts[KEY_A] = detail(402, { type: "payment_required", code: "paid_plan_required" });
    api.tts[KEY_B] = detail(401, { type: "authentication_error", code: "invalid_api_key" });
    const err = await synth({ voiceId: LIB_VOICE }).catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(err.message).toMatch(
      /^ElevenLabs key pool exhausted: 2 keys \(1 need a paid plan for this voice or model, 1 invalid\)\. key /,
    );
  });
});

describe("state lifecycle", () => {
  it("expired blocks and quota windows make a key a candidate again", async () => {
    const a = await addKey(KEY_A);
    await addKey(KEY_B);
    api.tts[KEY_A] = detail(402, { code: "paid_plan_required" });
    await synth();
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    await synth({ voiceId: LIB_VOICE });
    const state = readState();
    expect(state.blocks[a.id][VOICE]).toBeTruthy();
    expect(state.keys[a.id].status).toBe("exhausted");
    state.blocks[a.id][VOICE].at = Date.now() - 25 * 3600_000;
    state.keys[a.id].until = Date.now() - 1000;
    writeState(state);
    api.tts[KEY_A] = () => audio();
    expect((await synth()).keyId).toBe(a.id);
    expect(el.listElevenLabsKeys(env)[0]).toMatchObject({ status: "ok", blockedVoices: [] });
  });

  it("refresh clears status and voice blocks, and re-marks a dead key", async () => {
    const a = await addKey(KEY_A);
    await addKey(KEY_B);
    api.tts[KEY_A] = detail(402, { code: "paid_plan_required" });
    await synth();
    api.tts[KEY_A] = detail(401, { code: "invalid_api_key" });
    await synth({ voiceId: LIB_VOICE });
    expect(el.listElevenLabsKeys(env)[0]).toMatchObject({ status: "invalid", blockedVoices: [VOICE] });

    api.subs[KEY_A] = () => sub({ tier: "creator", character_count: 5 });
    const refreshed = await el.refreshElevenLabsKey(a.id, env, { fetchImpl: api.fetch });
    expect(refreshed).toMatchObject({ status: "ok", blockedVoices: [], tier: "creator", characterCount: 5 });

    api.subs[KEY_A] = () => sub({ character_count: 10000 });
    expect((await el.refreshElevenLabsKey(a.id, env, { fetchImpl: api.fetch })).status).toBe("exhausted");

    api.subs[KEY_A] = detail(401, { code: "invalid_api_key" });
    expect((await el.refreshElevenLabsKey(a.id, env, { fetchImpl: api.fetch })).status).toBe("invalid");
    await expect(el.refreshElevenLabsKey("missing", env, { fetchImpl: api.fetch })).rejects.toMatchObject({ code: "not_found" });
  });

  it("budget check skips a key that cannot cover the request", async () => {
    api.subs[KEY_A] = () => sub({ character_count: 9995 });
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    expect((await synth({ text: "This line is longer than five characters." })).keyId).toBe(b.id);
    expect(ttsCalls(KEY_A)).toBe(0);
    const s = el.listElevenLabsKeys(env).find((k) => k.id === a.id)!;
    expect(s.status).toBe("exhausted");
    expect(s.statusReason).toContain("budget");
    // The budget was confirmed with a fresh subscription read.
    expect(api.calls.filter((c) => c.key === KEY_A && c.url.includes("subscription")).length).toBe(2);
  });

  it("usage since the last check counts toward the budget", async () => {
    let used = 9980;
    api.subs[KEY_A] = () => sub({ character_count: used });
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    api.tts[KEY_A] = () => { used += 15; return audio(15); };
    expect((await synth({ text: "short line" })).keyId).toBe(a.id);
    // 20 left minus 15 used leaves 5: a 10-char line no longer fits.
    expect((await synth({ text: "short line" })).keyId).toBe(b.id);
  });

  it("allowOverage lets an extendable paid key go past its included credits", async () => {
    api.subs[KEY_A] = () => sub({ tier: "creator", character_count: 10000, can_extend_character_limit: true });
    const a = await addKey(KEY_A);
    const b = await addKey(KEY_B);
    expect((await synth()).keyId).toBe(b.id);
    await el.refreshElevenLabsKey(a.id, env, { fetchImpl: api.fetch });
    const patched = el.updateElevenLabsKey(a.id, { allowOverage: true }, env);
    expect(patched.allowOverage).toBe(true);
    expect((await synth()).keyId).toBe(a.id);
  });

  it("unknown limits are not budget-checked", async () => {
    api.subs[KEY_A] = detail(401, { status: "missing_permissions" });
    const a = await addKey(KEY_A);
    expect((await synth({ text: "x".repeat(4000) })).keyId).toBe(a.id);
  });
});

describe("pool wait", () => {
  it("uses a key added while the run waits on an empty pool", async () => {
    env.MANHWA_ELEVENLABS_POOL_WAIT_S = "5";
    env.MANHWA_ELEVENLABS_POOL_POLL_S = "0.05";
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    const onPoolWait = vi.fn((info: { untilMs: number; reasons: el.ElevenLabsPoolReason[] }) => {
      expect(info.reasons[0]!.reason).toContain("quota exhausted");
      void addKey(KEY_B, "late");
    });
    const res = await synth({ onPoolWait });
    expect(onPoolWait).toHaveBeenCalledTimes(1);
    const late = el.listElevenLabsKeys(env).find((k) => k.label === "late")!;
    expect(res.keyId).toBe(late.id);
  });

  it("respects the abort signal while waiting", async () => {
    env.MANHWA_ELEVENLABS_POOL_WAIT_S = "30";
    env.MANHWA_ELEVENLABS_POOL_POLL_S = "5";
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    const ctl = new AbortController();
    const p = synth({ signal: ctl.signal, onPoolWait: () => setTimeout(() => ctl.abort(new Error("stop")), 20) });
    await expect(p).rejects.toThrow("stop");
  });

  it("a give-up fails fast in a fresh module instance while the pool is unchanged", async () => {
    env.MANHWA_ELEVENLABS_POOL_WAIT_S = "1";
    env.MANHWA_ELEVENLABS_POOL_POLL_S = "0.05";
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    const t0 = Date.now();
    await expect(synth()).rejects.toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(readState().giveUp).toBeTruthy();

    vi.resetModules();
    const fresh = await import("../src/llm/elevenlabsTts.js");
    expect(fresh).not.toBe(el);
    const onPoolWait = vi.fn();
    const t1 = Date.now();
    const err = await fresh.synthesizeElevenLabsToFile({
      text: "Hello there.", voiceId: VOICE, destPath: path.join(outDir, "x.mp3"), env, fetchImpl: api.fetch, onPoolWait,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(fresh.ElevenLabsPoolExhaustedError);
    expect(Date.now() - t1).toBeLessThan(500);
    expect(onPoolWait).not.toHaveBeenCalled();

    // Adding a key changes the pool signature, so the next call uses it.
    await addKey(KEY_B);
    const ok = await fresh.synthesizeElevenLabsToFile({
      text: "Hello there.", voiceId: VOICE, destPath: path.join(outDir, "y.mp3"), env, fetchImpl: api.fetch,
    });
    expect(ok.keyId).toBe(el.listElevenLabsKeys(env)[1]!.id);
  });
});

describe("voice check", () => {
  it("detects library voices and caches the result for the same pool", async () => {
    await addKey(KEY_A);
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/v1/voices/${LIB_VOICE}`)) return json(404, { detail: { code: "voice_not_found" } });
      if (url.includes("/v1/shared-voices")) {
        return json(200, { voices: [{ voice_id: LIB_VOICE, name: "The Pharaoh", category: "high_quality" }] });
      }
      return api.fetch(input, init);
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await el.checkElevenLabsVoice(LIB_VOICE, env);
      expect(r).toMatchObject({ voiceId: LIB_VOICE, found: true, library: true, needsPaidKey: true, paidKeyAvailable: false });
      expect(r.note).toContain("paid-tier key");
      const calls = fetchSpy.mock.calls.length;
      await el.checkElevenLabsVoice(LIB_VOICE, env);
      expect(fetchSpy.mock.calls.length).toBe(calls);

      const premade = await el.checkElevenLabsVoice(VOICE, env);
      expect(premade).toMatchObject({ found: true, library: false, needsPaidKey: false, category: "premade" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a paid key and own voices", async () => {
    api.subs[KEY_A] = () => sub({ tier: "creator" });
    await addKey(KEY_A);
    const own = "abcdefghij0123456789";
    const r = await el.checkElevenLabsVoice(own, env, {
      fetchImpl: (async () => json(200, { voice_id: own, name: "Mine", category: "cloned" })) as typeof fetch,
    });
    expect(r).toMatchObject({ found: true, name: "Mine", library: false, paidKeyAvailable: true });
  });

  it("throws not_found with no usable key", async () => {
    await expect(el.checkElevenLabsVoice(LIB_VOICE, env, { fetchImpl: api.fetch })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a 403 on the own-voice lookup is inconclusive, not found=false, and is not cached", async () => {
    await addKey(KEY_A);
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/v1/voices/${LIB_VOICE}`)) { calls++; return json(403, { detail: { code: "forbidden" } }); }
      if (url.includes("/v1/shared-voices")) return json(200, { voices: [] });
      return api.fetch(input, init);
    }) as typeof fetch;
    const err = await el.checkElevenLabsVoice(LIB_VOICE, env, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(el.ElevenLabsRequestError);
    expect(err).toMatchObject({ status: 403, retryable: false });
    expect(el.elevenLabsVoiceCheckCacheSize()).toBe(0);
    await el.checkElevenLabsVoice(LIB_VOICE, env, { fetchImpl }).catch(() => {});
    expect(calls).toBe(2);
  });

  it("an inconclusive own lookup still uses a conclusive shared-voices match", async () => {
    await addKey(KEY_A);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/v1/voices/${LIB_VOICE}`)) return json(429, { detail: { code: "rate_limit_exceeded" } });
      if (url.includes("/v1/shared-voices")) return json(200, { voices: [{ voice_id: LIB_VOICE, name: "P" }] });
      return api.fetch(input, init);
    }) as typeof fetch;
    expect(await el.checkElevenLabsVoice(LIB_VOICE, env, { fetchImpl })).toMatchObject({ found: true, library: true });
  });

  it("a real 404 voice_not_found with no library match is found=false", async () => {
    await addKey(KEY_A);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/v1/voices/${LIB_VOICE}`)) return json(404, { detail: { code: "voice_not_found" } });
      if (url.includes("/v1/shared-voices")) return json(200, { voices: [] });
      return api.fetch(input, init);
    }) as typeof fetch;
    expect(await el.checkElevenLabsVoice(LIB_VOICE, env, { fetchImpl })).toMatchObject({ found: false });
    expect(el.elevenLabsVoiceCheckCacheSize()).toBe(1);
  });

  it("prunes expired cache entries on insert", async () => {
    await addKey(KEY_A);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await el.checkElevenLabsVoice(VOICE, env, { fetchImpl: api.fetch });
    expect(el.elevenLabsVoiceCheckCacheSize()).toBe(1);
    now.mockReturnValue(t0 + 11 * 60_000);
    await el.checkElevenLabsVoice("nPczCjzI2devNBz1zQrb", env, { fetchImpl: api.fetch });
    expect(el.elevenLabsVoiceCheckCacheSize()).toBe(1);
  });
});

describe("cross-process safety", () => {
  it("two concurrent adds both survive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Both subscription fetches are in flight before either writes the index.
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/v1/user/subscription")) await gate;
      return api.fetch(input, init);
    }) as typeof fetch;
    const p1 = el.addElevenLabsKey(KEY_A, "a", env, { fetchImpl: slow });
    const p2 = el.addElevenLabsKey(KEY_B, "b", env, { fetchImpl: slow });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([p1, p2]);
    expect(el.listElevenLabsKeys(env).map((k) => k.label).sort()).toEqual(["a", "b"]);
    expect(fs.statSync(cfg(el.ELEVENLABS_LOCK_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it("a duplicate added concurrently is rejected and leaves one entry", async () => {
    const results = await Promise.allSettled([addKey(KEY_A), addKey(KEY_A)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(el.listElevenLabsKeys(env)).toHaveLength(1);
  });

  it("an add whose index write fails removes its secret", async () => {
    await addKey(KEY_A);
    const indexPath = cfg(el.ELEVENLABS_KEYS_FILENAME);
    const before = fs.readFileSync(path.join(outDir, "config", "secrets.json"), "utf8");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === indexPath) throw new Error("disk full");
      return rename(from, to);
    });
    await expect(addKey(KEY_B)).rejects.toThrow("disk full");
    vi.mocked(fs.renameSync).mockRestore();
    expect(el.listElevenLabsKeys(env)).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(path.join(outDir, "config", "secrets.json"), "utf8"));
    const refs = JSON.stringify(after);
    expect(refs.match(/elevenlabs-key:/g)?.length).toBe(JSON.stringify(JSON.parse(before)).match(/elevenlabs-key:/g)?.length);
  });
});

describe("give-up marker", () => {
  it("a wait-0 call never writes giveUp", async () => {
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    await expect(synth()).rejects.toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(readState().giveUp).toBeUndefined();
  });

  it("a wait-0 call does not refresh an existing giveUp", async () => {
    await addKey(KEY_A);
    api.tts[KEY_A] = detail(402, { code: "insufficient_credits" });
    const s = readState();
    s.giveUp = { at: 12345, poolSig: "old" };
    writeState(s);
    await expect(synth()).rejects.toBeInstanceOf(el.ElevenLabsPoolExhaustedError);
    expect(readState().giveUp).toEqual({ at: 12345, poolSig: "old" });
  });
});

describe("budget estimate", () => {
  it("an unparsable checkedAt means unknown budget, not checked", async () => {
    api.subs[KEY_A] = () => sub({ character_count: 9999, character_limit: 10000 });
    const a = await addKey(KEY_A);
    const idx = JSON.parse(fs.readFileSync(cfg(el.ELEVENLABS_KEYS_FILENAME), "utf8"));
    idx.keys[0].checkedAt = "garbage";
    fs.writeFileSync(cfg(el.ELEVENLABS_KEYS_FILENAME), JSON.stringify(idx));
    expect((await synth({ text: "x".repeat(500) })).keyId).toBe(a.id);
  });
});
