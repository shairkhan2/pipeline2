/**
 * ElevenLabs text-to-speech over HTTPS with a pool of user API keys.
 *
 * Storage lives in `<outDir>/config` (the secretStore directory):
 *  - `elevenlabs-keys.json`: key index, array order = priority. No plaintext keys;
 *    each entry points at a secretStore ref `elevenlabs-key:<id>`.
 *  - `elevenlabs-pool-state.json`: runtime status shared by the server and run
 *    child processes (exhausted / invalid / cooldown, voice+model blocks, usage,
 *    give-up marker). Re-read on every pick; last writer wins.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { deleteSecret, getSecret, maskSecretHint, putSecret, resolveOutDir, scrubSecrets } from "../config/secretStore.js";
import { flockFd } from "../locks/seriesLock.js";

type Env = NodeJS.ProcessEnv;

export const ELEVENLABS_API_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_DEFAULT_MODEL = "eleven_v4";
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
export const ELEVENLABS_KEYS_FILENAME = "elevenlabs-keys.json";
export const ELEVENLABS_POOL_STATE_FILENAME = "elevenlabs-pool-state.json";
export const ELEVENLABS_LOCK_FILENAME = "elevenlabs.lock";

export interface ElevenLabsModel { id: string; label: string; tags: boolean; costMultiplier: number }

export const ELEVENLABS_MODELS: ElevenLabsModel[] = [
  { id: "eleven_v4", label: "Eleven v4", tags: true, costMultiplier: 1 },
  { id: "eleven_v4_turbo", label: "Eleven v4 Turbo", tags: true, costMultiplier: 0.5 },
  { id: "eleven_v3", label: "Eleven v3", tags: true, costMultiplier: 1 },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", tags: false, costMultiplier: 1 },
  { id: "eleven_flash_v2_5", label: "Flash v2.5", tags: false, costMultiplier: 0.5 },
];

/** Premade voices: the only voices a free-tier key may use over the API. */
export const ELEVENLABS_PREMADE_VOICES: Array<{ id: string; label: string; default?: boolean }> = [
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George - Warm, Captivating Storyteller", default: true },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian - Deep, Resonant and Comforting" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel - Steady Broadcaster" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam - Dominant, Firm" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah - Mature, Reassuring, Confident" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily - Velvety Actress" },
];

export function elevenLabsModelSupportsTags(modelId?: string): boolean {
  const id = String(modelId || ELEVENLABS_DEFAULT_MODEL).trim();
  return ELEVENLABS_MODELS.find((m) => m.id === id)?.tags ?? false;
}

export function isValidElevenLabsVoiceId(id: string): boolean {
  return /^[A-Za-z0-9]{16,40}$/.test(String(id ?? "").trim());
}

export type ElevenLabsKeyStatus = "ok" | "exhausted" | "invalid" | "cooldown" | "disabled";

export interface ElevenLabsKeySummary {
  id: string;
  label: string;
  hint: string;
  enabled: boolean;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  resetAt?: number;
  checkedAt?: string;
  canExtend?: boolean;
  /** Paid keys with usage-based billing may go past their included credits only when this is true. */
  allowOverage: boolean;
  status: ElevenLabsKeyStatus;
  statusUntil?: number;
  statusReason?: string;
  blockedVoices: string[];
}

export interface ElevenLabsSubscription {
  tier: string;
  status: string;
  characterCount: number;
  characterLimit: number;
  resetAt?: number;
  canExtend: boolean;
}

export interface ElevenLabsVoiceInfo { voiceId: string; name: string; category?: string }

export interface ElevenLabsVoiceCheck {
  voiceId: string;
  found: boolean;
  name?: string;
  category?: string;
  /** Voice Library voice (shared by another account). */
  library: boolean;
  /** Free-tier keys get HTTP 402 paid_plan_required for this voice. */
  needsPaidKey: boolean;
  /** At least one enabled pool key is on a paid tier. */
  paidKeyAvailable: boolean;
  note?: string;
}

export interface ElevenLabsPoolReason { keyId: string; hint: string; reason: string }

export interface SynthesizeElevenLabsOptions {
  text: string;
  voiceId: string;
  modelId?: string;
  destPath: string;
  speed?: number;
  env?: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Called when every key is unusable and the pool starts waiting for a key to come back. */
  onPoolWait?: (info: { untilMs: number; reasons: ElevenLabsPoolReason[] }) => void;
}

export interface ElevenLabsSynthesisResult { keyId: string; characterCost?: number }

export type ElevenLabsErrorKind = "auth" | "quota" | "plan" | "voice" | "rate" | "server" | "request";

export class ElevenLabsKeyError extends Error {
  readonly code: "invalid" | "duplicate" | "network" | "not_found";
  constructor(message: string, code: ElevenLabsKeyError["code"]) {
    super(message);
    this.name = "ElevenLabsKeyError";
    this.code = code;
  }
}

/** Message format: `ElevenLabs HTTP <status> <code>: <message>`, so httpStatusOf() can read it. */
export class ElevenLabsRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "ElevenLabsRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Every pool key failed for this request. Message starts with `ElevenLabs key pool exhausted:`. */
export class ElevenLabsPoolExhaustedError extends Error {
  readonly retryable = false;
  /** failClass() reads this: the pool already waited, so the chapter must not requeue. */
  readonly permanent = true;
  readonly reasons: ElevenLabsPoolReason[];
  constructor(message: string, reasons: ElevenLabsPoolReason[]) {
    super(message);
    this.name = "ElevenLabsPoolExhaustedError";
    this.reasons = reasons;
  }
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

const AUTH_CODES = new Set([
  "invalid_api_key", "missing_api_key", "unauthorized", "detected_unusual_activity", "missing_permissions",
  "authentication_error",
]);
const QUOTA_CODES = new Set(["quota_exceeded", "insufficient_credits", "payment_required"]);
const PLAN_CODES = new Set([
  "paid_plan_required", "subscription_required", "feature_not_available", "voice_access_denied", "model_access_denied",
]);
const VOICE_CODES = new Set(["voice_not_found"]);
const RATE_CODES = new Set([
  "rate_limit_exceeded", "concurrent_limit_exceeded", "system_busy", "too_many_concurrent_requests", "rate_limit_error",
]);
const SERVER_CODES = new Set(["internal_error", "service_unavailable", "internal_server_error"]);
const REQUEST_CODES = new Set([
  "text_too_long", "invalid_parameters", "invalid_voice_settings", "model_not_found", "validation_error",
  "invalid_request", "invalid_request_error", "bad_request",
]);

const CODE_SETS: Array<[ElevenLabsErrorKind, Set<string>]> = [
  ["plan", PLAN_CODES],
  ["voice", VOICE_CODES],
  ["auth", AUTH_CODES],
  ["quota", QUOTA_CODES],
  ["rate", RATE_CODES],
  ["server", SERVER_CODES],
  ["request", REQUEST_CODES],
];

function kindForValue(value: string): ElevenLabsErrorKind | null {
  for (const [kind, set] of CODE_SETS) if (set.has(value)) return kind;
  return null;
}

function kindForStatus(status: number): ElevenLabsErrorKind {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 403) return "plan";
  if (status === 404) return "voice";
  if (status === 429) return "rate";
  if (status >= 500) return "server";
  return "request";
}

export function classifyElevenLabsError(
  status: number, body: unknown,
): { kind: ElevenLabsErrorKind; code: string; message: string } {
  let parsed: unknown = body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // plain text body
    }
  }
  const detail = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).detail ?? parsed
    : parsed;
  let message = "";
  const fields: string[] = [];
  if (typeof detail === "string") {
    message = detail;
  } else if (Array.isArray(detail)) {
    // FastAPI 422 validation list.
    message = detail
      .map((d) => (d && typeof d === "object" && typeof (d as { msg?: unknown }).msg === "string" ? (d as { msg: string }).msg : ""))
      .filter(Boolean)
      .join("; ") || "validation error";
    return { kind: "request", code: "validation_error", message };
  } else if (detail && typeof detail === "object") {
    const rec = detail as Record<string, unknown>;
    message = typeof rec.message === "string" ? rec.message : "";
    // Order matters: `code` is most specific (paid_plan_required has type payment_required).
    for (const field of ["code", "status", "type"]) {
      const v = rec[field];
      if (typeof v === "string" && v.trim()) fields.push(v.trim().toLowerCase());
    }
  }
  for (const value of fields) {
    const kind = kindForValue(value);
    if (kind) return { kind, code: value, message: message || value };
  }
  const kind = kindForStatus(status);
  return { kind, code: fields[0] || `http_${status}`, message: message || `HTTP ${status}` };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface KeyIndexEntry {
  id: string;
  label: string;
  secretRef: string;
  fingerprint: string;
  hint: string;
  enabled: boolean;
  allowOverage: boolean;
  addedAt: string;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  resetAt?: number;
  canExtend?: boolean;
  checkedAt?: string;
  note?: string;
}

interface KeyIndexDoc { schemaVersion: 1; keys: KeyIndexEntry[] }

interface KeyState { status: "exhausted" | "invalid" | "cooldown"; until?: number; reason: string; at: number }

interface PoolStateDoc {
  keys: Record<string, KeyState>;
  blocks: Record<string, Record<string, { reason: string; at: number }>>;
  usage: Record<string, { chars: number; since: number }>;
  giveUp?: { at: number; poolSig: string };
}

const BLOCK_TTL_MS = 24 * 3600_000;
const QUOTA_FALLBACK_MS = 6 * 3600_000;
const SUBSCRIPTION_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 180_000;
const MIN_AUDIO_BYTES = 128;
const VOICE_CHECK_TTL_MS = 10 * 60_000;

function envOutDir(env: Env): string {
  return resolveOutDir(env.MANHWA_OUT_DIR || env.PIPELINE_OUT_DIR);
}

function configPath(env: Env, filename: string): string {
  return path.join(envOutDir(env), "config", filename);
}

function apiBase(env: Env): string {
  const raw = String(env.ELEVENLABS_API_URL ?? "").trim();
  return (raw || ELEVENLABS_API_URL).replace(/\/+$/, "");
}

function fetcher(impl?: typeof fetch): typeof fetch {
  return impl ?? globalThis.fetch;
}

// studioConfig.ts keeps its atomicWriteJson0600 private; this mirrors it.
function writeJson0600(filePath: string, data: unknown): void {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`,
  );
  const payload = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tmpPath, flags, 0o600);
    try {
      let offset = 0;
      while (offset < payload.length) {
        const written = fs.writeSync(fd, payload, offset, payload.length - offset);
        if (written <= 0) throw new Error("Short write to ElevenLabs config temp file");
        offset += written;
      }
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function readIndex(env: Env): KeyIndexEntry[] {
  const doc = readJsonFile(configPath(env, ELEVENLABS_KEYS_FILENAME)) as { keys?: unknown } | null;
  const list = Array.isArray(doc?.keys) ? doc!.keys as unknown[] : [];
  const out: KeyIndexEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      label: str(r.label) ?? id,
      secretRef: str(r.secretRef) ?? `elevenlabs-key:${id}`,
      fingerprint: str(r.fingerprint) ?? "",
      hint: str(r.hint) ?? "****",
      enabled: r.enabled !== false,
      allowOverage: r.allowOverage === true,
      addedAt: str(r.addedAt) ?? new Date(0).toISOString(),
      tier: str(r.tier),
      characterCount: num(r.characterCount),
      characterLimit: num(r.characterLimit),
      resetAt: num(r.resetAt),
      canExtend: typeof r.canExtend === "boolean" ? r.canExtend : undefined,
      checkedAt: str(r.checkedAt),
      note: str(r.note),
    });
  }
  return out;
}

function writeIndex(env: Env, keys: KeyIndexEntry[]): void {
  writeJson0600(configPath(env, ELEVENLABS_KEYS_FILENAME), { schemaVersion: 1, keys } satisfies KeyIndexDoc);
}

function readState(env: Env): PoolStateDoc {
  const doc = readJsonFile(configPath(env, ELEVENLABS_POOL_STATE_FILENAME)) as Partial<PoolStateDoc> | null;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const giveUp = doc?.giveUp && typeof doc.giveUp.at === "number" && typeof doc.giveUp.poolSig === "string"
    ? { at: doc.giveUp.at, poolSig: doc.giveUp.poolSig }
    : undefined;
  return {
    keys: obj(doc?.keys) as PoolStateDoc["keys"],
    blocks: obj(doc?.blocks) as PoolStateDoc["blocks"],
    usage: obj(doc?.usage) as PoolStateDoc["usage"],
    ...(giveUp ? { giveUp } : {}),
  };
}

// flock(2) locks conflict between open file descriptions even inside one process,
// so nested calls reuse the lock already held instead of deadlocking.
let lockDepth = 0;

/**
 * Exclusive cross-process lock for every index/state read-modify-write.
 * The critical section must be synchronous: never hold this across a network call.
 */
function withConfigLock<T>(env: Env, fn: () => T): T {
  if (lockDepth > 0) {
    lockDepth++;
    try {
      return fn();
    } finally {
      lockDepth--;
    }
  }
  const lockPath = configPath(env, ELEVENLABS_LOCK_FILENAME);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // not the owner; the lock still works
    }
    flockFd(fd, "ex", false);
    lockDepth = 1;
    try {
      return fn();
    } finally {
      lockDepth = 0;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Read-modify-write on the freshest state, under the config lock. */
function mutateState(env: Env, fn: (s: PoolStateDoc) => void): PoolStateDoc {
  return withConfigLock(env, () => {
    const state = readState(env);
    fn(state);
    try {
      writeJson0600(configPath(env, ELEVENLABS_POOL_STATE_FILENAME), state);
    } catch {
      // A state write failure must not break synthesis.
    }
    return state;
  });
}

function mutateEntry(env: Env, id: string, fn: (e: KeyIndexEntry) => void): KeyIndexEntry | null {
  return withConfigLock(env, () => {
    const keys = readIndex(env);
    const entry = keys.find((k) => k.id === id);
    if (!entry) return null;
    fn(entry);
    writeIndex(env, keys);
    return entry;
  });
}

function fingerprintOf(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function activeKeyState(state: PoolStateDoc, id: string, now: number): KeyState | null {
  const s = state.keys[id];
  if (!s) return null;
  if (s.status === "invalid") return s;
  if (typeof s.until === "number" && s.until > now) return s;
  return null;
}

function activeBlocks(state: PoolStateDoc, id: string, now: number): string[] {
  const blocks = state.blocks[id] ?? {};
  return Object.entries(blocks).filter(([, b]) => b && now - b.at < BLOCK_TTL_MS).map(([k]) => k);
}

function blockFor(state: PoolStateDoc, id: string, voiceId: string, modelId: string, now: number) {
  const blocks = state.blocks[id] ?? {};
  for (const k of [voiceId, `model:${modelId}`]) {
    const b = blocks[k];
    if (b && now - b.at < BLOCK_TTL_MS) return b;
  }
  return null;
}

function poolSigOf(keys: KeyIndexEntry[]): string {
  const parts = keys.filter((k) => k.enabled).map((k) => `${k.id}:${k.checkedAt ?? ""}:${k.enabled ? 1 : 0}`);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function toSummary(entry: KeyIndexEntry, state: PoolStateDoc, now: number): ElevenLabsKeySummary {
  const ks = activeKeyState(state, entry.id, now);
  const status: ElevenLabsKeyStatus = !entry.enabled ? "disabled" : ks ? ks.status : "ok";
  const statusReason = ks?.reason ?? entry.note;
  return {
    id: entry.id,
    label: entry.label,
    hint: entry.hint,
    enabled: entry.enabled,
    ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
    ...(entry.characterCount !== undefined ? { characterCount: entry.characterCount } : {}),
    ...(entry.characterLimit !== undefined ? { characterLimit: entry.characterLimit } : {}),
    ...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}),
    ...(entry.checkedAt !== undefined ? { checkedAt: entry.checkedAt } : {}),
    ...(entry.canExtend !== undefined ? { canExtend: entry.canExtend } : {}),
    allowOverage: entry.allowOverage,
    status,
    ...(ks?.until !== undefined ? { statusUntil: ks.until } : {}),
    ...(statusReason ? { statusReason } : {}),
    blockedVoices: activeBlocks(state, entry.id, now),
  };
}

/** Remove plaintext keys from any text that may reach logs, errors or responses. */
function redact(text: string, keys: string[] = []): string {
  let out = String(text ?? "");
  for (const k of keys) if (k) out = out.split(k).join("[REDACTED]");
  out = out.replace(/\bsk_[A-Za-z0-9]{12,}\b/g, "[REDACTED]");
  return scrubSecrets(out);
}

function requestError(status: number, code: string, message: string, retryable: boolean, keys: string[] = []) {
  return new ElevenLabsRequestError(
    redact(`ElevenLabs HTTP ${status} ${code}: ${message}`, keys).slice(0, 500),
    status, code, retryable,
  );
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Network / timeout failure as a retryable 503; caller aborts are rethrown untouched. */
function networkError(err: unknown, apiKey: string, signal?: AbortSignal): Error {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : (err as Error);
  const name = (err as Error)?.name;
  const code = name === "TimeoutError" ? "timeout" : "network_error";
  return requestError(503, code, (err as Error)?.message || "request failed", true, [apiKey]);
}

/* ------------------------------------------------------------------ */
/* Subscription + key management                                       */
/* ------------------------------------------------------------------ */

export async function fetchElevenLabsSubscription(
  apiKey: string, env: Env = process.env, signal?: AbortSignal, fetchImpl?: typeof fetch,
): Promise<ElevenLabsSubscription> {
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(`${apiBase(env)}/v1/user/subscription`, {
      method: "GET",
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
      redirect: "error",
      signal: timeoutSignal(SUBSCRIPTION_TIMEOUT_MS, signal),
    });
  } catch (err) {
    throw networkError(err, apiKey, signal);
  }
  if (!res.ok) {
    const c = classifyElevenLabsError(res.status, await readErrorBody(res));
    throw requestError(res.status, c.code, c.message, c.kind === "server" || c.kind === "rate", [apiKey]);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw requestError(502, "bad_response", "subscription response is not JSON", true);
  return {
    tier: str(body.tier) ?? "unknown",
    status: str(body.status) ?? "unknown",
    characterCount: num(body.character_count) ?? 0,
    characterLimit: num(body.character_limit) ?? 0,
    ...(num(body.next_character_count_reset_unix) !== undefined ? { resetAt: num(body.next_character_count_reset_unix) } : {}),
    canExtend: body.can_extend_character_limit === true,
  };
}

function applySubscription(entry: KeyIndexEntry, sub: ElevenLabsSubscription, nowIso: string): void {
  entry.tier = sub.tier;
  entry.characterCount = sub.characterCount;
  entry.characterLimit = sub.characterLimit;
  entry.resetAt = sub.resetAt;
  entry.canExtend = sub.canExtend;
  entry.checkedAt = nowIso;
  delete entry.note;
}

function authReason(code: string): string {
  if (code === "detected_unusual_activity") return "free tier disabled by ElevenLabs";
  if (code === "missing_permissions") return "key lacks the needed permission";
  return "invalid API key";
}

export function listElevenLabsKeys(env: Env = process.env): ElevenLabsKeySummary[] {
  const state = readState(env);
  const now = Date.now();
  return readIndex(env).map((e) => toSummary(e, state, now));
}

/** >= 1 enabled key. Disk only, no network. */
export function hasElevenLabsKeys(env: Env = process.env): boolean {
  return readIndex(env).some((k) => k.enabled);
}

function summaryOf(env: Env, id: string): ElevenLabsKeySummary {
  const entry = readIndex(env).find((k) => k.id === id);
  if (!entry) throw new ElevenLabsKeyError(`ElevenLabs key '${id}' not found`, "not_found");
  return toSummary(entry, readState(env), Date.now());
}

export async function addElevenLabsKey(
  key: string, label?: string, env: Env = process.env, opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<ElevenLabsKeySummary> {
  const apiKey = String(key ?? "").trim();
  if (!/^[A-Za-z0-9_\-]{16,256}$/.test(apiKey)) {
    throw new ElevenLabsKeyError("That does not look like an ElevenLabs API key", "invalid");
  }
  const fingerprint = fingerprintOf(apiKey);
  if (readIndex(env).some((k) => k.fingerprint === fingerprint)) {
    throw new ElevenLabsKeyError("This ElevenLabs key is already in the pool", "duplicate");
  }
  let sub: ElevenLabsSubscription | null = null;
  let note: string | undefined;
  try {
    sub = await fetchElevenLabsSubscription(apiKey, env, opts?.signal, opts?.fetchImpl);
  } catch (err) {
    if (!(err instanceof ElevenLabsRequestError)) throw err;
    const kind = kindForValue(err.code) ?? kindForStatus(err.status);
    if (err.code === "missing_permissions") {
      note = "key cannot read its usage";
    } else if (kind === "auth") {
      throw new ElevenLabsKeyError(`ElevenLabs rejected the key: ${authReason(err.code)}`, "invalid");
    } else if (kind === "server" || kind === "rate" || err.status >= 500) {
      throw new ElevenLabsKeyError(`Could not reach ElevenLabs to verify the key (${err.code})`, "network");
    } else {
      throw new ElevenLabsKeyError(`ElevenLabs rejected the key (${err.code})`, "invalid");
    }
  }
  const id = `el_${crypto.randomBytes(5).toString("hex")}`;
  const secretRef = `elevenlabs-key:${id}`;
  const nowIso = new Date().toISOString();
  withConfigLock(env, () => {
    // Re-read after the network call: a concurrent add/remove/reorder may have changed the index.
    const keys = readIndex(env);
    if (keys.some((k) => k.fingerprint === fingerprint)) {
      throw new ElevenLabsKeyError("This ElevenLabs key is already in the pool", "duplicate");
    }
    const entry: KeyIndexEntry = {
      id,
      label: String(label ?? "").trim().slice(0, 80) || `Key ${keys.length + 1}`,
      secretRef,
      fingerprint,
      hint: maskSecretHint(apiKey),
      enabled: true,
      allowOverage: false,
      addedAt: nowIso,
    };
    if (sub) applySubscription(entry, sub, nowIso);
    else {
      entry.tier = "unknown";
      entry.checkedAt = nowIso;
      entry.note = note;
    }
    putSecret(secretRef, apiKey, envOutDir(env));
    keys.push(entry);
    try {
      writeIndex(env, keys);
    } catch (err) {
      try {
        deleteSecret(secretRef, envOutDir(env));
      } catch {
        // best effort: do not mask the write error
      }
      throw err;
    }
    mutateState(env, (s) => {
      delete s.keys[id];
      delete s.blocks[id];
      s.usage[id] = { chars: 0, since: Date.now() };
      if (sub && sub.characterLimit > 0 && sub.characterCount >= sub.characterLimit && !sub.canExtend) {
        s.keys[id] = quotaState(sub.resetAt);
      }
    });
  });
  return summaryOf(env, id);
}

function quotaState(resetAtSec?: number): KeyState {
  const now = Date.now();
  const until = resetAtSec && resetAtSec * 1000 > now ? resetAtSec * 1000 : now + QUOTA_FALLBACK_MS;
  return { status: "exhausted", until, reason: `quota exhausted until ${new Date(until).toISOString().slice(0, 10)}`, at: now };
}

export async function refreshElevenLabsKey(
  id: string, env: Env = process.env, opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<ElevenLabsKeySummary> {
  const entry = readIndex(env).find((k) => k.id === id);
  if (!entry) throw new ElevenLabsKeyError(`ElevenLabs key '${id}' not found`, "not_found");
  const apiKey = getSecret(entry.secretRef, envOutDir(env));
  const nowIso = new Date().toISOString();
  if (!apiKey) {
    mutateEntry(env, id, (e) => { e.checkedAt = nowIso; });
    mutateState(env, (s) => {
      delete s.blocks[id];
      s.keys[id] = { status: "invalid", reason: "stored key is missing; remove and add it again", at: Date.now() };
    });
    return summaryOf(env, id);
  }
  let sub: ElevenLabsSubscription | null = null;
  let failure: KeyState | null = null;
  let note: string | undefined;
  try {
    sub = await fetchElevenLabsSubscription(apiKey, env, opts?.signal, opts?.fetchImpl);
  } catch (err) {
    if (!(err instanceof ElevenLabsRequestError)) throw err;
    const kind = kindForValue(err.code) ?? kindForStatus(err.status);
    if (err.code === "missing_permissions") note = "key cannot read its usage";
    else if (kind === "auth") failure = { status: "invalid", reason: authReason(err.code), at: Date.now() };
    else throw new ElevenLabsKeyError(`Could not refresh the ElevenLabs key (${err.code})`, "network");
  }
  mutateEntry(env, id, (e) => {
    if (sub) applySubscription(e, sub, nowIso);
    else {
      e.checkedAt = nowIso;
      if (note) { e.note = note; e.tier = e.tier ?? "unknown"; }
    }
  });
  mutateState(env, (s) => {
    delete s.keys[id];
    delete s.blocks[id];
    s.usage[id] = { chars: 0, since: Date.now() };
    if (failure) s.keys[id] = failure;
    else if (sub && sub.characterLimit > 0 && sub.characterCount >= sub.characterLimit && !sub.canExtend) {
      s.keys[id] = quotaState(sub.resetAt);
    }
  });
  return summaryOf(env, id);
}

export function updateElevenLabsKey(
  id: string, patch: { label?: string; enabled?: boolean; allowOverage?: boolean }, env: Env = process.env,
): ElevenLabsKeySummary {
  if (patch.label !== undefined && typeof patch.label !== "string") throw new ElevenLabsKeyError("label must be a string", "invalid");
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new ElevenLabsKeyError("enabled must be a boolean", "invalid");
  if (patch.allowOverage !== undefined && typeof patch.allowOverage !== "boolean") {
    throw new ElevenLabsKeyError("allowOverage must be a boolean", "invalid");
  }
  const updated = mutateEntry(env, id, (e) => {
    if (typeof patch.label === "string") {
      const label = patch.label.trim().slice(0, 80);
      if (label) e.label = label;
    }
    if (typeof patch.enabled === "boolean") e.enabled = patch.enabled;
    if (typeof patch.allowOverage === "boolean") e.allowOverage = patch.allowOverage;
  });
  if (!updated) throw new ElevenLabsKeyError(`ElevenLabs key '${id}' not found`, "not_found");
  return summaryOf(env, id);
}

/** Listed ids move to the front in the given order; unlisted keys keep their relative order after them. */
export function reorderElevenLabsKeys(ids: string[], env: Env = process.env): ElevenLabsKeySummary[] {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new ElevenLabsKeyError("ids must be an array of key ids", "invalid");
  }
  if (new Set(ids).size !== ids.length) throw new ElevenLabsKeyError("ids contains duplicates", "invalid");
  withConfigLock(env, () => {
    const keys = readIndex(env);
    const byId = new Map(keys.map((k) => [k.id, k]));
    const unknown = ids.find((i) => !byId.has(i));
    if (unknown) throw new ElevenLabsKeyError(`ElevenLabs key '${unknown}' not found`, "not_found");
    const listed = new Set(ids);
    const next = [...ids.map((i) => byId.get(i)!), ...keys.filter((k) => !listed.has(k.id))];
    writeIndex(env, next);
  });
  return listElevenLabsKeys(env);
}

export function removeElevenLabsKey(id: string, env: Env = process.env): boolean {
  return withConfigLock(env, () => {
    const keys = readIndex(env);
    const entry = keys.find((k) => k.id === id);
    if (!entry) return false;
    writeIndex(env, keys.filter((k) => k.id !== id));
    try {
      deleteSecret(entry.secretRef, envOutDir(env));
    } catch {
      // index already dropped it; a stale secret is harmless
    }
    mutateState(env, (s) => {
      delete s.keys[id];
      delete s.blocks[id];
      delete s.usage[id];
    });
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Voices                                                              */
/* ------------------------------------------------------------------ */

/** Enabled keys that are not marked invalid, in priority order, with their plaintext. */
function usableKeys(env: Env): Array<{ entry: KeyIndexEntry; apiKey: string }> {
  const state = readState(env);
  const now = Date.now();
  const outDir = envOutDir(env);
  const out: Array<{ entry: KeyIndexEntry; apiKey: string }> = [];
  for (const entry of readIndex(env)) {
    if (!entry.enabled || activeKeyState(state, entry.id, now)?.status === "invalid") continue;
    const apiKey = getSecret(entry.secretRef, outDir);
    if (apiKey) out.push({ entry, apiKey });
  }
  return out;
}

function noUsableKey(): ElevenLabsKeyError {
  return new ElevenLabsKeyError("No usable ElevenLabs API key in the pool. Add one in Studio > Voice.", "not_found");
}

function markInvalid(env: Env, id: string, code: string): void {
  mutateState(env, (s) => { s.keys[id] = { status: "invalid", reason: authReason(code), at: Date.now() }; });
}

/** GET with key rotation on auth failures. Returns the first non-auth response. */
async function getWithPool(
  env: Env, url: string, fetchImpl?: typeof fetch,
): Promise<{ res: Response; body: unknown; ok: boolean }> {
  const keys = usableKeys(env);
  if (keys.length === 0) throw noUsableKey();
  for (const { entry, apiKey } of keys) {
    let res: Response;
    try {
      res = await fetcher(fetchImpl)(url, {
        method: "GET",
        headers: { "xi-api-key": apiKey, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, apiKey);
    }
    if (res.ok) return { res, body: await res.json().catch(() => null), ok: true };
    const body = await readErrorBody(res);
    const c = classifyElevenLabsError(res.status, body);
    if (c.kind === "auth") {
      markInvalid(env, entry.id, c.code);
      continue;
    }
    if (c.kind === "server" || c.kind === "rate") throw requestError(res.status, c.code, c.message, true, [apiKey]);
    return { res, body, ok: false };
  }
  throw noUsableKey();
}

export async function listElevenLabsVoices(
  env: Env = process.env, opts?: { fetchImpl?: typeof fetch },
): Promise<ElevenLabsVoiceInfo[]> {
  const { res, body, ok } = await getWithPool(env, `${apiBase(env)}/v1/voices`, opts?.fetchImpl);
  if (!ok) {
    const c = classifyElevenLabsError(res.status, body);
    throw requestError(res.status, c.code, c.message, false);
  }
  const list = body && typeof body === "object" && Array.isArray((body as { voices?: unknown }).voices)
    ? (body as { voices: unknown[] }).voices
    : [];
  const out: ElevenLabsVoiceInfo[] = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const voiceId = str(r.voice_id);
    if (!voiceId) continue;
    out.push({ voiceId, name: str(r.name) ?? voiceId, ...(str(r.category) ? { category: str(r.category) } : {}) });
  }
  return out;
}

const OWN_CATEGORIES = new Set(["premade", "cloned", "generated"]);
const voiceCheckCache = new Map<string, { at: number; result: ElevenLabsVoiceCheck }>();

/** Test hook: drop cached voice checks. */
export function resetElevenLabsVoiceCheckCache(): void {
  voiceCheckCache.clear();
}

/** Test hook: number of cached voice checks. */
export function elevenLabsVoiceCheckCacheSize(): number {
  return voiceCheckCache.size;
}

export async function checkElevenLabsVoice(
  voiceId: string, env: Env = process.env, opts?: { fetchImpl?: typeof fetch },
): Promise<ElevenLabsVoiceCheck> {
  const id = String(voiceId ?? "").trim();
  if (!isValidElevenLabsVoiceId(id)) throw new ElevenLabsKeyError("Invalid ElevenLabs voice id", "invalid");
  const index = readIndex(env);
  const cacheKey = `${envOutDir(env)}|${id}|${poolSigOf(index)}`;
  const cached = voiceCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VOICE_CHECK_TTL_MS) return { ...cached.result };

  const state = readState(env);
  const now = Date.now();
  const paidKeyAvailable = index.some((k) =>
    k.enabled && k.tier !== undefined && k.tier !== "free" && k.tier !== "unknown"
    && activeKeyState(state, k.id, now)?.status !== "invalid");

  let result: ElevenLabsVoiceCheck;
  const premade = ELEVENLABS_PREMADE_VOICES.find((v) => v.id === id);
  if (premade) {
    result = { voiceId: id, found: true, name: premade.label, category: "premade", library: false, needsPaidKey: false, paidKeyAvailable };
  } else {
    // ElevenLabsKeyError (no usable key) propagates; request errors make the own lookup inconclusive.
    const lookup = async (url: string) => {
      try {
        return await getWithPool(env, url, opts?.fetchImpl);
      } catch (err) {
        if (err instanceof ElevenLabsRequestError) return err;
        throw err;
      }
    };
    const inconclusive = (r: Awaited<ReturnType<typeof lookup>>): ElevenLabsRequestError | null => {
      if (r instanceof ElevenLabsRequestError) return r;
      if (r.ok) return null;
      const c = classifyElevenLabsError(r.res.status, r.body);
      return requestError(r.res.status, c.code, c.message, r.res.status === 429 || r.res.status >= 500);
    };
    const own = await lookup(`${apiBase(env)}/v1/voices/${encodeURIComponent(id)}`);
    const ownNotFound = !(own instanceof ElevenLabsRequestError) && !own.ok && own.res.status === 404
      && classifyElevenLabsError(own.res.status, own.body).code === "voice_not_found";
    if (!(own instanceof ElevenLabsRequestError) && own.ok) {
      const r = (own.body ?? {}) as Record<string, unknown>;
      const category = str(r.category);
      const library = !!category && !OWN_CATEGORIES.has(category);
      result = {
        voiceId: id, found: true, name: str(r.name) ?? id, ...(category ? { category } : {}),
        library, needsPaidKey: library, paidKeyAvailable,
        ...(library ? { note: "Library voice: needs a paid-tier key for API use" } : {}),
      };
    } else {
      const shared = await lookup(`${apiBase(env)}/v1/shared-voices?search=${encodeURIComponent(id)}&page_size=5`);
      const sharedErr = inconclusive(shared);
      const voices = !sharedErr && !(shared instanceof ElevenLabsRequestError) && shared.body
        && typeof shared.body === "object" && Array.isArray((shared.body as { voices?: unknown }).voices)
        ? (shared.body as { voices: Array<Record<string, unknown>> }).voices
        : [];
      const match = voices.find((v) => v && v.voice_id === id);
      if (!match && (!ownNotFound || sharedErr)) {
        // Neither lookup can say "not found" for sure; never report found=false or cache it.
        throw (ownNotFound ? sharedErr : inconclusive(own)) ?? sharedErr!;
      }
      if (match) {
        const category = str(match.category);
        result = {
          voiceId: id, found: true, name: str(match.name) ?? id, ...(category ? { category } : {}),
          library: true, needsPaidKey: true, paidKeyAvailable,
          note: "Library voice: needs a paid-tier key for API use",
        };
      } else {
        result = {
          voiceId: id, found: false, library: false, needsPaidKey: false, paidKeyAvailable,
          note: "Voice not found in your account or the Voice Library",
        };
      }
    }
  }
  const insertedAt = Date.now();
  for (const [k, v] of voiceCheckCache) {
    if (insertedAt - v.at >= VOICE_CHECK_TTL_MS) voiceCheckCache.delete(k);
  }
  voiceCheckCache.set(cacheKey, { at: insertedAt, result });
  return { ...result };
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

function envSeconds(env: Env, name: string, fallback: number): number {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function logRotation(hint: string, reason: string): void {
  console.log(`   audio: elevenlabs key ${hint} ${reason}; trying next key`);
}

function planReason(code: string, voiceId: string, modelId: string): { block: string; reason: string } {
  if (code === "model_access_denied") return { block: `model:${modelId}`, reason: `model ${modelId} not available on this plan` };
  if (code === "paid_plan_required") return { block: voiceId, reason: `voice ${voiceId} needs a paid plan` };
  return { block: voiceId, reason: `voice ${voiceId} not available on this plan (${code})` };
}

function poolReasons(
  keys: KeyIndexEntry[], state: PoolStateDoc, voiceId: string, modelId: string, seen: Map<string, string>,
): ElevenLabsPoolReason[] {
  const now = Date.now();
  return keys.filter((k) => k.enabled).map((k) => {
    const reason = seen.get(k.id)
      ?? activeKeyState(state, k.id, now)?.reason
      ?? blockFor(state, k.id, voiceId, modelId, now)?.reason
      ?? "unavailable";
    return { keyId: k.id, hint: k.hint, reason };
  });
}

function exhaustedError(keys: KeyIndexEntry[], reasons: ElevenLabsPoolReason[]): ElevenLabsPoolExhaustedError {
  if (reasons.length === 0) {
    return new ElevenLabsPoolExhaustedError(
      "ElevenLabs key pool exhausted: no enabled ElevenLabs API keys; add one in Studio > Voice", [],
    );
  }
  const tier = new Map(keys.map((k) => [k.id, k.tier ?? "unknown"]));
  const text = reasons.map((r) => `key ${r.hint} (${tier.get(r.keyId)}): ${r.reason}`).join("; ");
  // Run reports cut errors to 400 chars, so the counts come first.
  return new ElevenLabsPoolExhaustedError(
    `ElevenLabs key pool exhausted: ${poolSummary(reasons)}. ${text}`, reasons,
  );
}

function poolSummary(reasons: ElevenLabsPoolReason[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const kind = /quota|budget/.test(r.reason) ? "out of credits"
      : /paid plan|not available on this plan/.test(r.reason) ? "need a paid plan for this voice or model"
      : /not found/.test(r.reason) ? "cannot find this voice"
      : /rate limited/.test(r.reason) ? "rate limited"
      : /invalid|missing|disabled by|lacks the needed/.test(r.reason) ? "invalid"
      : "unavailable";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}`);
  return `${reasons.length} key${reasons.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/** Estimated characters left on a key; null when the limits are unknown. */
function estimatedRemaining(entry: KeyIndexEntry, state: PoolStateDoc): number | null {
  if (entry.characterLimit === undefined || entry.characterCount === undefined || entry.characterLimit <= 0) return null;
  const checkedMs = entry.checkedAt ? Date.parse(entry.checkedAt) : NaN;
  if (!Number.isFinite(checkedMs)) return null;
  const usage = state.usage[entry.id];
  const used = usage && usage.since >= checkedMs - 1000 ? usage.chars : 0;
  return entry.characterLimit - entry.characterCount - used;
}

type AttemptOutcome =
  | { ok: true; characterCost?: number }
  | { ok: false; kind: ElevenLabsErrorKind; code: string; message: string; status: number; retryAfterS?: number };

async function attemptTts(
  apiKey: string, opts: SynthesizeElevenLabsOptions, env: Env, modelId: string, destPath: string,
): Promise<AttemptOutcome> {
  const speedRaw = typeof opts.speed === "number" && Number.isFinite(opts.speed) ? opts.speed : 1;
  const speed = Math.min(1.2, Math.max(0.7, speedRaw));
  const payload: Record<string, unknown> = { text: opts.text, model_id: modelId };
  if (speed !== 1) payload.voice_settings = { speed };
  const url = `${apiBase(env)}/v1/text-to-speech/${encodeURIComponent(opts.voiceId.trim())}?output_format=mp3_44100_128`;
  let res: Response;
  try {
    res = await fetcher(opts.fetchImpl)(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: timeoutSignal(TTS_TIMEOUT_MS, opts.signal),
    });
  } catch (err) {
    throw networkError(err, apiKey, opts.signal);
  }
  if (!res.ok) {
    const c = classifyElevenLabsError(res.status, await readErrorBody(res));
    const ra = Number(res.headers.get("retry-after"));
    return { ok: false, ...c, status: res.status, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterS: ra } : {}) };
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  let audio: Buffer;
  try {
    audio = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw networkError(err, apiKey, opts.signal);
  }
  if (!(contentType.includes("audio") || contentType.includes("octet-stream")) || audio.length < MIN_AUDIO_BYTES) {
    throw requestError(502, "bad_audio", `unexpected response (${contentType || "no content-type"}, ${audio.length} bytes)`, true);
  }
  opts.signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, audio);
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
  const cost = Number(res.headers.get("character-cost"));
  return { ok: true, ...(Number.isFinite(cost) && cost >= 0 ? { characterCost: cost } : {}) };
}

/**
 * Synthesize `text` to `destPath` (MP3), rotating through the key pool.
 * Keys and state are re-read from disk on every pick, so Studio edits apply mid-run.
 */
export async function synthesizeElevenLabsToFile(opts: SynthesizeElevenLabsOptions): Promise<ElevenLabsSynthesisResult> {
  opts.signal?.throwIfAborted();
  const text = String(opts.text ?? "");
  if (!text.trim()) throw new Error("ElevenLabs TTS text is empty");
  const voiceId = String(opts.voiceId ?? "").trim();
  if (!isValidElevenLabsVoiceId(voiceId)) throw new Error(`Invalid ElevenLabs voice id '${voiceId}'`);
  const env = opts.env ?? process.env;
  const outDir = envOutDir(env);
  const modelId = String(opts.modelId || ELEVENLABS_DEFAULT_MODEL).trim();
  const multiplier = ELEVENLABS_MODELS.find((m) => m.id === modelId)?.costMultiplier ?? 1;
  const estCost = Math.ceil(text.length * multiplier);
  const destPath = path.resolve(opts.destPath);
  const waitMs = envSeconds(env, "MANHWA_ELEVENLABS_POOL_WAIT_S", 1800) * 1000;
  const pollMs = Math.max(10, envSeconds(env, "MANHWA_ELEVENLABS_POOL_POLL_S", 15) * 1000);
  const callOpts = { ...opts, voiceId };

  let waitDeadline: number | null = null;
  // Another call already waited on this exact pool: try it once more, but do not wait again.
  let skipWait = false;
  const seen = new Map<string, string>();

  for (let pass = 0; ; pass++) {
    opts.signal?.throwIfAborted();
    const index = readIndex(env);
    let state = readState(env);
    const now = Date.now();

    if (pass === 0 && state.giveUp && state.giveUp.poolSig === poolSigOf(index) && now - state.giveUp.at < waitMs) {
      skipWait = true;
    }

    const candidates = index.filter((k) =>
      k.enabled && !activeKeyState(state, k.id, now) && !blockFor(state, k.id, voiceId, modelId, now));

    for (const entry of candidates) {
      opts.signal?.throwIfAborted();
      let current = entry;
      // Proactive budget check: skip a key that cannot cover this request.
      let remaining = estimatedRemaining(current, state);
      if (remaining !== null && remaining < estCost && !(current.canExtend && current.allowOverage)) {
        const key = getSecret(current.secretRef, outDir);
        if (key) {
          try {
            const sub = await fetchElevenLabsSubscription(key, env, opts.signal, opts.fetchImpl);
            current = mutateEntry(env, current.id, (e) => applySubscription(e, sub, new Date().toISOString())) ?? current;
            state = mutateState(env, (s) => { s.usage[current.id] = { chars: 0, since: Date.now() }; });
            remaining = estimatedRemaining(current, state);
          } catch {
            // keep the estimate
          }
        }
        if (remaining !== null && remaining < estCost && !(current.canExtend && current.allowOverage)) {
          const ks = quotaState(current.resetAt);
          ks.reason = `${ks.reason} (budget ${Math.max(0, remaining)} < ${estCost} chars)`;
          state = mutateState(env, (s) => { s.keys[current.id] = ks; });
          seen.set(current.id, ks.reason);
          logRotation(current.hint, ks.reason);
          continue;
        }
      }

      const apiKey = getSecret(current.secretRef, outDir);
      if (!apiKey) {
        const reason = "stored key is missing";
        state = mutateState(env, (s) => { s.keys[current.id] = { status: "invalid", reason, at: Date.now() }; });
        seen.set(current.id, reason);
        logRotation(current.hint, reason);
        continue;
      }

      const outcome = await attemptTts(apiKey, callOpts, env, modelId, destPath);
      if (outcome.ok) {
        const used = outcome.characterCost ?? estCost;
        mutateState(env, (s) => {
          const prev = s.usage[current.id];
          s.usage[current.id] = { chars: (prev?.chars ?? 0) + used, since: prev?.since ?? Date.now() };
          const ks = s.keys[current.id];
          if (ks && ks.status !== "invalid") delete s.keys[current.id];
          delete s.giveUp;
        });
        return { keyId: current.id, ...(outcome.characterCost !== undefined ? { characterCost: outcome.characterCost } : {}) };
      }

      const { kind, code, message, status } = outcome;
      let reason: string;
      if (kind === "auth") {
        reason = authReason(code);
        state = mutateState(env, (s) => { s.keys[current.id] = { status: "invalid", reason, at: Date.now() }; });
      } else if (kind === "quota") {
        let resetAt = current.resetAt;
        try {
          const sub = await fetchElevenLabsSubscription(apiKey, env, opts.signal, opts.fetchImpl);
          resetAt = sub.resetAt;
          mutateEntry(env, current.id, (e) => applySubscription(e, sub, new Date().toISOString()));
        } catch {
          // fall back to the stored reset time
        }
        const ks = quotaState(resetAt);
        reason = ks.reason;
        state = mutateState(env, (s) => { s.keys[current.id] = ks; });
      } else if (kind === "plan" || kind === "voice") {
        const pr = kind === "voice"
          ? { block: voiceId, reason: `voice ${voiceId} not found for this key` }
          : planReason(code, voiceId, modelId);
        reason = pr.reason;
        state = mutateState(env, (s) => {
          s.blocks[current.id] = { ...(s.blocks[current.id] ?? {}), [pr.block]: { reason: pr.reason, at: Date.now() } };
        });
      } else if (kind === "rate") {
        const seconds = code === "concurrent_limit_exceeded" || code === "too_many_concurrent_requests"
          ? 5
          : outcome.retryAfterS ?? 30;
        reason = `rate limited (${code}) for ${seconds}s`;
        state = mutateState(env, (s) => {
          s.keys[current.id] = { status: "cooldown", until: Date.now() + seconds * 1000, reason, at: Date.now() };
        });
      } else if (kind === "server") {
        throw requestError(status >= 500 ? status : 503, code, message, true, [apiKey]);
      } else {
        throw requestError(status, code, message, false, [apiKey]);
      }
      seen.set(current.id, reason);
      logRotation(current.hint, reason);
    }

    // No candidate produced audio.
    const after = readState(env);
    const nowAfter = Date.now();
    const freshIndex = readIndex(env);
    const cooling = freshIndex.some((k) => k.enabled && activeKeyState(after, k.id, nowAfter)?.status === "cooldown");
    if (cooling) {
      throw requestError(429, "pool_rate_limited", "every usable ElevenLabs key is rate limited; retry shortly", true);
    }
    const reasons = poolReasons(freshIndex, after, voiceId, modelId, seen);
    if (waitDeadline === null && waitMs > 0 && !skipWait) {
      waitDeadline = nowAfter + waitMs;
      console.log(`   audio: elevenlabs key pool has no usable key; waiting up to ${Math.round(waitMs / 1000)}s`);
      try {
        opts.onPoolWait?.({ untilMs: waitDeadline, reasons });
      } catch {
        // observer errors must not break synthesis
      }
    }
    if (waitDeadline === null || nowAfter >= waitDeadline) {
      // Only a call that really waited may tell others to skip their wait.
      if (waitDeadline !== null) {
        const finalSig = poolSigOf(freshIndex);
        mutateState(env, (s) => { s.giveUp = { at: Date.now(), poolSig: finalSig }; });
      }
      throw exhaustedError(freshIndex, reasons);
    }
    await sleep(Math.min(pollMs, Math.max(10, waitDeadline - nowAfter)), opts.signal);
    // Reasons seen in this call are stale once the pool is re-read.
    seen.clear();
  }
}
