/**
 * Multi-lane LLM client. Port of pipeline/llm.py.
 *
 * Lanes are tried in order. A dead lane is skipped. Every lane failing raises
 * AllLanesFailed (fail-stop: a gate must never look clean because its verifier
 * was unreachable). FilterBlocked (moderation) propagates immediately so the
 * reader/writer rescue paths own it.
 *
 * Retry: timeout, connection error, HTTP 429/5xx, empty 200 -> exponential
 * backoff + jitter, spent on that lane before skip.
 * Skip: 401/403 and other 4xx -> next lane immediately.
 * Fail-fast: moderation (`data_inspection_failed`, `inappropriate content`,
 * `moderation`, `content_policy`, HTTP 422).
 *
 * Image helpers use sharp. Default max height is 1400 and JPEG quality is 85
 * (v2 contract; Python img_b64 defaults were 1200 / 75).
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import * as laneConfig from "../config/laneConfig.js";
import {
  DEFAULT_VISION_LANES,
  DEFAULT_WRITER_LANES,
  type DefaultRoleLane,
} from "../config/modelLanes.js";
import {
  MODEL_CANDIDATES,
  UNAVAILABLE_MODEL_CANDIDATES,
} from "../config/laneRegistry.js";
import * as secretStore from "../config/secretStore.js";
import * as studioConfig from "../config/studioConfig.js";
import * as telemetry from "../telemetry/telemetry.js";
import { isRefusalText } from "../domain/failure.js";

const SNAPSHOT_ENV = "MANHWA_LANE_CONFIG_SNAPSHOT";
const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const RESET_RE = /resets?\s+in\s+(?:(\d+)\s*h)?(?:(\d+)\s*m)?(?:(\d+)\s*s)?/i;

/** ChatGPT subscription Codex backend (OAuth tokens are not billed API keys). */
const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_DEFAULT_BASE = "https://api.openai.com/v1";
const OPENCODE_USER_AGENT = "opencode/production/2.0.26/opencode";

export const API =
  "https://aiplatform.googleapis.com/v1/projects/{p}/locations/{r}/endpoints/openapi/chat/completions";

const VREGION = process.env.VERTEX_REGION || "global";

export class AuthError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AuthError";
  }
}

export class FilterBlocked extends Error {
  constructor(message = "") {
    super(message);
    this.name = "FilterBlocked";
  }
}

export class ClientError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "ClientError";
  }
}

export class AllLanesFailed extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AllLanesFailed";
  }
}

export class RuntimeError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "RuntimeError";
  }
}

export interface Transport {
  base: string;
  key_env: string | null;
}

export interface Lane {
  kind: string;
  name: string;
  model: string;
  base: string | null;
  key_env: string | null;
  thinking: boolean | null;
  stream: boolean | null;
  provider?: string;
  concurrency?: number;
  protocol?: studioConfig.ProviderProtocol;
  authMode?: studioConfig.ProviderAuthMode;
  secretRef?: string | null;
  projectId?: string;
  location?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  reasoningEffort?: studioConfig.ReasoningEffort | null;
  /** Provider's hard output cap; max_tokens (incl. reasoning headroom) never exceeds it. */
  maxOutputTokens?: number;
  outDir?: string;
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface CallOptions {
  maxTokens?: number;
  max_tokens?: number;
  temperature?: number;
  retries?: number;
  tag?: string;
  timeout?: number;
  lane?: string | null;
  stage?: "reader" | "matcher" | "writer" | "scout" | "fact_check" | null;
}

export interface CompletionMessage {
  content?: string | null;
  reasoning_content?: string;
  [key: string]: unknown;
}

export interface Completion {
  choices: Array<{
    message: CompletionMessage;
    [key: string]: unknown;
  }>;
  usage?: {
    total_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ImageBlock {
  type: "image_url";
  image_url: { url: string };
}

export interface LaneSnapshotStatus {
  loaded: true;
  source: string;
  revision: number;
  configError: string | null;
  roles: Record<string, string[]>;
}

interface ResolvedSnapshot {
  lanes: { vision: Lane[]; writer: Lane[] };
  source: string;
  error: string | null;
  revision: number;
}

interface RegistrySpec {
  id: string;
  roleSettings?: Record<string, { thinking: boolean | null; stream: boolean }>;
}

interface LaneSem {
  readonly limit: number;
  readonly countKey: string;
  readonly mapKey: string;
  acquire(): Promise<void>;
  release(): void;
  readonly _value: number;
}

type FetchFn = typeof fetch;

const _AGY: Transport = {
  base: process.env.AGY_BASE || "http://127.0.0.1:8329/v1",
  key_env: null,
};
const _WB: Transport = {
  base: process.env.WORKBUDDY_BASE || "https://www.codebuddy.ai/v2",
  key_env: "WORKBUDDY_API_KEY",
};
const _OC: Transport = {
  base: process.env.OPENCODE_SHIM_BASE || "http://127.0.0.1:8324/v1",
  key_env: null,
};
const _OR: Transport = {
  base: "https://openrouter.ai/api/v1",
  key_env: "OPENROUTER_API_KEY",
};

/** Server-only transports. A persisted config never supplies base URL or key env. */
export const _TRANSPORTS: Record<string, Transport> = {
  agy: _AGY,
  workbuddy: _WB,
  opencode: _OC,
  openrouter: _OR,
};

export function _lane(
  kind: string,
  name: string,
  model: string,
  extra: Partial<Pick<Lane, "base" | "key_env" | "thinking" | "stream">> = {},
): Lane {
  return {
    kind,
    name,
    model,
    base: extra.base ?? null,
    key_env: extra.key_env ?? null,
    thinking: extra.thinking ?? null,
    stream: extra.stream ?? null,
  };
}

function withTransport(
  kind: string,
  name: string,
  model: string,
  transport: Transport,
  extra: Partial<Pick<Lane, "thinking" | "stream">> = {},
): Lane {
  return _lane(kind, name, model, {
    base: transport.base,
    key_env: transport.key_env,
    thinking: extra.thinking ?? null,
    stream: extra.stream ?? null,
  });
}

/**
 * Vision chain: free lanes first. thinking=false is set only where measured to
 * take effect on the reader call shape. hy3 is vision-capable and sits below
 * deepseek. Vertex is not listed.
 */
/**
 * The default chains come from the one canonical definition in
 * `config/modelLanes.ts` (also used by laneConfig and studioConfig); this module
 * only attaches the server-only transports.
 */
function laneFromDefault(lane: DefaultRoleLane): Lane {
  const transport = _TRANSPORTS[lane.provider];
  if (!transport) {
    return _lane(lane.kind, lane.provider, lane.model, {
      thinking: lane.thinking,
      stream: lane.stream,
    });
  }
  return withTransport(lane.kind, lane.provider, lane.model, transport, {
    thinking: lane.thinking,
    stream: lane.stream,
  });
}

export const VISION_LANES: Lane[] = DEFAULT_VISION_LANES.map(laneFromDefault);

export const WRITER_LANES: Lane[] = DEFAULT_WRITER_LANES.map(laneFromDefault);

export const MODEL = WRITER_LANES[0]?.model ?? "";

function defaultRoleLanes(): { vision: Lane[]; writer: Lane[] } {
  return { vision: VISION_LANES, writer: WRITER_LANES };
}

function registrySpecs(): Map<string, RegistrySpec> {
  const specs = new Map<string, RegistrySpec>();
  for (const spec of MODEL_CANDIDATES) specs.set(spec.id, spec);
  for (const spec of UNAVAILABLE_MODEL_CANDIDATES) {
    if (!specs.has(spec.id)) specs.set(spec.id, spec);
  }
  return specs;
}

function concurrencyOf(raw: unknown): number {
  if (raw === null || raw === undefined || raw === false || raw === 0 || raw === "") return 1;
  const n = typeof raw === "number" ? Math.trunc(raw) : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, n);
}

/**
 * Resolve a bare `<modelId>` lane entry against `providers.json`: the first
 * enabled provider that lists the model, else the only enabled provider.
 * Returns null when no provider can own the model (legacy transport path).
 */
function resolveBareModelLane(
  modelId: string,
  outDir?: string,
): { provider: string; model: string } | null {
  const id = String(modelId ?? "").trim();
  if (!id) return null;
  let providers: studioConfig.ProviderView[];
  try {
    providers = studioConfig.listProviders(outDir).filter((p) => p.enabled !== false);
  } catch {
    return null;
  }
  const owner = providers.find((p) =>
    (p.models ?? []).some((m) => m.id === id && m.enabled !== false));
  if (owner) return { provider: owner.id, model: id };
  // No provider lists it yet: the first enabled provider takes the bare model id.
  if (providers.length > 0) return { provider: providers[0]!.id, model: id };
  return null;
}

/** True when `id` names a provider this process can actually route to. */
function isKnownProviderId(id: string, outDir?: string): boolean {
  const providerId = String(id ?? "").trim();
  if (!providerId) return false;
  if (providerId in _TRANSPORTS) return true;
  return studioConfig.getProvider(providerId, outDir) !== null;
}

/** True when an enabled Studio provider lists `id` verbatim as a model id. */
function isKnownModelId(id: string, outDir?: string): boolean {
  const modelId = String(id ?? "").trim();
  if (!modelId) return false;
  let providers: studioConfig.ProviderView[];
  try {
    providers = studioConfig.listProviders(outDir).filter((p) => p.enabled !== false);
  } catch {
    return false;
  }
  return providers.some((p) =>
    (p.models ?? []).some((m) => m.id === modelId && m.enabled !== false));
}

function entryIsRoutable(entryId: string, outDir?: string): boolean {
  const raw = String(entryId ?? "").trim();
  if (!raw) return false;
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  let providers: studioConfig.ProviderView[];
  try {
    providers = studioConfig.listProviders(outDir);
  } catch {
    return true;
  }
  const explicitProvider = prefix && isKnownProviderId(prefix, outDir)
    ? providers.find((p) => p.id === prefix) ?? null
    : null;
  if (explicitProvider) {
    if (explicitProvider.enabled === false) return false;
    const modelId = raw.slice(colon + 1);
    const model = (explicitProvider.models ?? []).find((m) => m.id === modelId);
    return !(model && model.enabled === false);
  }
  // A bare model id resolves against the enabled providers that list it.
  const owners = providers.filter((p) => p.enabled !== false
    && (p.models ?? []).some((m) => m.id === raw && m.enabled !== false));
  if (owners.length > 0) return true;
  const known = providers.some((p) => (p.models ?? []).some((m) => m.id === raw));
  // Listed only by disabled providers/models -> not routable.
  return !known;
}

/** True when `<outDir>/config/stages.json` exists, so per-stage routing is live. */
function stageRoutingPersisted(outDir?: string): boolean {
  try {
    return studioConfig.getStagesConfig(outDir).persisted === true;
  } catch {
    return false;
  }
}

export function laneFromConfigEntry(
  entry: { id: string; concurrency?: unknown },
  role: "vision" | "writer" = "writer",
  outDir?: string,
): Lane {
  const raw = String(entry.id ?? "").trim();
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  // `<providerId>:<modelId>` only when the prefix is a real provider and the
  // whole string is not itself a model id. Bare ids may contain a colon
  // (`llama3:8b`, `google/gemma-4-31b-it:free`), so they resolve as models.
  const explicit =
    colon > 0 && isKnownProviderId(prefix, outDir) && !isKnownModelId(raw, outDir);
  let provider: string;
  let model: string;
  if (explicit) {
    provider = prefix;
    model = raw.slice(colon + 1);
  } else {
    // A bare `<modelId>` resolves against the first enabled Studio provider that
    // lists the model (or the only enabled one).
    const resolved = resolveBareModelLane(raw, outDir);
    provider = resolved?.provider || raw;
    model = resolved?.model ?? "";
  }

  const studioProv = studioConfig.getProvider(provider, outDir);
  if (studioProv) {
    const kind = studioProv.protocol === "anthropic-messages"
      ? "anthropic-messages"
      : studioProv.protocol === "vertex-openai"
        ? "vertex-openai"
        : "openai";
    const lane = _lane(kind, provider, model, {
      base: studioProv.baseUrl || null,
      key_env: null,
    });
    lane.provider = provider;
    lane.concurrency = concurrencyOf(entry.concurrency);
    lane.protocol = studioProv.protocol;
    lane.authMode = studioProv.auth.mode;
    lane.secretRef = studioProv.auth.secretRef || `provider:${provider}`;
    lane.projectId = studioProv.auth.projectId;
    lane.location = studioProv.auth.location;
    lane.headers = studioProv.headers;
    lane.extraBody = studioProv.extraBody;
    lane.outDir = outDir;

    const modelCfg = studioProv.models.find((m) => m.id === model);
    if (modelCfg) {
      lane.thinking = modelCfg.thinking ?? null;
      lane.stream = Boolean(modelCfg.stream);
      lane.reasoningEffort = modelCfg.reasoningEffort ?? null;
      if (typeof modelCfg.maxOutputTokens === "number") lane.maxOutputTokens = modelCfg.maxOutputTokens;
    }
    return lane;
  }

  const transport = _TRANSPORTS[provider] ?? { base: "", key_env: null };
  const lane = _lane("openai", provider, model, {
    base: transport.base || null,
    key_env: transport.key_env,
  });
  lane.provider = provider;
  lane.concurrency = concurrencyOf(entry.concurrency);
  const spec = registrySpecs().get(entry.id);
  const settings = spec?.roleSettings?.[role];
  if (spec && settings) {
    lane.thinking = settings.thinking === undefined ? null : settings.thinking;
    lane.stream = Boolean(settings.stream);
  } else if (!spec) {
    for (const base of defaultRoleLanes()[role]) {
      if (base.name === provider && base.model === model) {
        lane.thinking = base.thinking ?? null;
        lane.stream = base.stream ?? null;
        break;
      }
    }
  }
  return lane;
}

const snapshot: {
  loaded: boolean;
  lanes: { vision: Lane[]; writer: Lane[] } | null;
  source: string;
  error: string | null;
  revision: number;
} = {
  loaded: false,
  lanes: null,
  source: "defaults",
  error: null,
  revision: 0,
};

/** Resolve role chains once from persisted config, or the hardcoded defaults. */
export function _resolveSnapshot(): ResolvedSnapshot {
  const base = {
    vision: VISION_LANES.slice(),
    writer: WRITER_LANES.slice(),
  };
  if ((process.env[SNAPSHOT_ENV] ?? "1") === "0") {
    return { lanes: base, source: "defaults", error: null, revision: 0 };
  }
  let state: ReturnType<typeof laneConfig.getLanesState>;
  try {
    state = laneConfig.getLanesState();
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { lanes: base, source: "defaults", error: name, revision: 0 };
  }
  const cfg = state.config ?? { models: { vision: [], writer: [] } };
  const source = state.source ?? "defaults";
  const out = { vision: [] as Lane[], writer: [] as Lane[] };
  const resolvedOutDir = secretStore.resolveOutDir();
  for (const role of ["vision", "writer"] as const) {
    const entries = cfg.models?.[role] ?? [];
    const lanes = entries
      .filter((entry) => entry.enabled && entryIsRoutable(entry.id, resolvedOutDir))
      .map((entry) => laneFromConfigEntry(entry, role, resolvedOutDir));
    // A persisted role with entries whose providers/models are all disabled is
    // an explicit "no lane" choice: keep it empty instead of re-enabling the
    // hardcoded defaults behind the operator's back. Only a role that was
    // never configured falls back.
    out[role] = entries.length > 0 ? lanes : base[role];
  }

  // Studio stage routing (`stages.json`) is the authority for reader/writer
  // chains. Without it, an old `out/lanes.json` can point at a model the
  // operator already replaced, and telemetry reports the stale lane.
  let stageSource: string | null = null;
  let stageRevision: number | null = null;
  if (
    !process.env.MANHWA_LANE_CONFIG
    && !process.env.MANHWA_LANE_CONFIG_DIR
    && stageRoutingPersisted(resolvedOutDir)
  ) {
    try {
      const stagesCfg = studioConfig.getStagesConfig(resolvedOutDir);
      const fromChain = (
        chain: string[] | undefined,
        role: "vision" | "writer",
        concurrency: number,
      ): Lane[] =>
        (chain ?? [])
          .filter((id) => entryIsRoutable(id, resolvedOutDir))
          .map((id) => laneFromConfigEntry({ id, concurrency }, role, resolvedOutDir));
      // stages.json wins outright: an intentionally empty chain stays empty
      // instead of silently falling back to the hardcoded base lanes.
      out.vision = fromChain(stagesCfg.reader?.chain, "vision", stagesCfg.reader?.concurrency ?? 1);
      out.writer = fromChain(stagesCfg.writer?.chain, "writer", stagesCfg.writer?.concurrency ?? 1);
      stageSource = "persisted";
      stageRevision = stagesCfg.revision ?? 0;
    } catch {
      // keep the lane-config result
    }
  }
  return {
    lanes: out,
    source: stageSource ?? source,
    error: stageSource ? null : state.configError,
    revision: stageRevision ?? state.revision ?? 0,
  };
}

function loadSnapshot(): void {
  if (snapshot.loaded) return;
  const resolved = _resolveSnapshot();
  snapshot.lanes = resolved.lanes;
  snapshot.source = resolved.source;
  snapshot.error = resolved.error;
  snapshot.revision = resolved.revision;
  snapshot.loaded = true;
}

/**
 * Role chain for this process, resolved once and cached.
 * When no valid persisted config exists, the module arrays are returned live,
 * so in-place edits of VISION_LANES / WRITER_LANES still take effect.
 */
export function _activeLanes(role: string): Lane[] {
  loadSnapshot();
  if (snapshot.source !== "persisted") {
    return role === "vision" ? VISION_LANES : WRITER_LANES;
  }
  const lanes = role === "vision" || role === "writer" ? snapshot.lanes?.[role] : undefined;
  // An empty persisted chain is deliberate (every lane disabled): return it
  // as-is so callers fail loudly instead of silently using the defaults.
  if (lanes) return lanes;
  return role === "vision" ? VISION_LANES : WRITER_LANES;
}

const laneCache = {
  synced: false,
  store: {} as Record<string, Lane[]>,
};

function syncLanes(): Record<string, Lane[]> {
  if (!laneCache.synced) {
    laneCache.synced = true;
    const writer = _activeLanes("writer");
    laneCache.store = {
      vision: _activeLanes("vision"),
      writer,
      text: writer,
    };
  }
  return laneCache.store;
}

export const LANES: {
  readonly vision: Lane[];
  readonly writer: Lane[];
  readonly text: Lane[];
  items(): Array<[string, Lane[]]>;
  keys(): string[];
  values(): Lane[][];
  get(key: string, fallback?: Lane[]): Lane[] | undefined;
} = new Proxy({} as never, {
  get(_target, prop) {
    if (prop === "items") return () => Object.entries(syncLanes());
    if (prop === "keys") return () => Object.keys(syncLanes());
    if (prop === "values") return () => Object.values(syncLanes());
    if (prop === "get") {
      return (key: string, fallback?: Lane[]) => {
        const store = syncLanes();
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
      };
    }
    if (typeof prop !== "string") return undefined;
    return syncLanes()[prop];
  },
  has(_target, prop) {
    return typeof prop === "string" && Object.prototype.hasOwnProperty.call(syncLanes(), prop);
  },
  ownKeys() {
    return Object.keys(syncLanes());
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== "string") return undefined;
    const store = syncLanes();
    if (!Object.prototype.hasOwnProperty.call(store, prop)) return undefined;
    return { configurable: true, enumerable: true, value: store[prop] };
  },
});

export function laneSnapshotStatus(): LaneSnapshotStatus {
  if (!snapshot.loaded) _activeLanes("writer");
  const roles: Record<string, string[]> = {};
  for (const [role, lanes] of Object.entries(snapshot.lanes ?? {})) {
    roles[role] = lanes.map((ln) => `${ln.name}:${ln.model}`);
  }
  return {
    loaded: true,
    source: snapshot.source,
    revision: snapshot.revision,
    configError: snapshot.error,
    roles,
  };
}

class Semaphore implements LaneSem {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    readonly limit: number,
    readonly countKey: string,
    readonly mapKey: string,
  ) {
    _activeCounts.set(countKey, 0);
  }

  get _value(): number {
    return this.limit - this.active;
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      this.publish();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        this.publish();
        resolve();
      });
    });
  }

  release(): void {
    if (this.active <= 0 && this.waiters.length === 0) {
      throw new Error("BoundedSemaphore released too many times");
    }
    this.active -= 1;
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.publish();
  }

  private publish(): void {
    const current = laneSems.get(this.mapKey);
    if (current === this) _activeCounts.set(this.countKey, this.active);
  }
}

const laneSems = new Map<string, Semaphore>();

/** In-flight holders per `${role}:${name}:${model}`. */
export const _activeCounts = new Map<string, number>();

function laneCountKey(role: string, lane: Lane): string {
  return `${role}:${lane.name}:${lane.model}`;
}

/** One semaphore per (role, lane id), sized from concurrency at first use. */
export function _laneSemaphore(role: string, lane: Lane): LaneSem {
  const limit = concurrencyOf(lane.concurrency);
  const mapKey = `${role}\0${lane.name}\0${lane.model}`;
  const existing = laneSems.get(mapKey);
  if (!existing || existing.limit !== limit) {
    const sem = new Semaphore(limit, laneCountKey(role, lane), mapKey);
    laneSems.set(mapKey, sem);
    return sem;
  }
  return existing;
}

async function withLaneSlot<T>(role: string, lane: Lane, fn: () => Promise<T>): Promise<T> {
  const sem = _laneSemaphore(role, lane);
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

const cooldowns = new Map<string, number>();
/** Wall-clock ms at which each lane's current cooldown was set (for manual resets). */
const cooldownSetAt = new Map<string, number>();
const wbConv = new Map<string, string>();
/** Vertex LLM tokens keyed by `${providerId}:${secretFingerprint}`. */
const vtok = new Map<string, { tok: string; exp: number }>();

let nowImpl: () => number = () => Date.now();

/** Test-only. Production never calls this. Wall-clock ms for cooldowns and change checks. */
export function _setClockForTests(fn: (() => number) | null): void {
  nowImpl = fn ?? (() => Date.now());
}

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
let fetchImpl: FetchFn = (input, init) => fetch(input, init);

/** Test-only. Production never calls this. */
export function _setSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
}

/** Test-only. Production never calls this. */
export function _setFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}

/**
 * Forget the cached snapshot so the next call re-resolves it.
 * Production never calls this. Also drops semaphores, active counts, learned
 * quota cooldowns, and the LANES cache so a test process starts clean.
 */
export function _resetSnapshotForTests(): void {
  snapshot.loaded = false;
  snapshot.lanes = null;
  snapshot.source = "defaults";
  snapshot.error = null;
  snapshot.revision = 0;
  laneSems.clear();
  _activeCounts.clear();
  cooldowns.clear();
  cooldownSetAt.clear();
  vtok.clear();
  laneCache.synced = false;
  laneCache.store = {};
  laneWatch.checkedAt = Number.NEGATIVE_INFINITY;
  laneWatch.stamp = null;
  laneWatch.fingerprints = null;
  laneWatch.resetsCheckedAt = Number.NEGATIVE_INFINITY;
  laneWatch.resetsStamp = null;
}

/** How often a run re-checks provider config and manual lane resets. */
export const LANE_CHECK_INTERVAL_MS = 5000;
export const LANE_RESETS_FILENAME = "lane-resets.json";

const laneWatch: {
  checkedAt: number;
  stamp: string | null;
  fingerprints: Map<string, string> | null;
  resetsCheckedAt: number;
  resetsStamp: string | null;
} = {
  checkedAt: Number.NEGATIVE_INFINITY,
  stamp: null,
  fingerprints: null,
  resetsCheckedAt: Number.NEGATIVE_INFINITY,
  resetsStamp: null,
};

export function laneResetsPath(outDir?: string): string {
  return path.join(secretStore.resolveOutDir(outDir), "config", LANE_RESETS_FILENAME);
}

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** First 16 hex chars of sha256(secret); the plain secret is never kept. */
function secretFingerprint(ref: string | null | undefined, outDir?: string): string {
  if (!ref) return "";
  try {
    const raw = secretStore.getSecret(ref, outDir);
    return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "none";
  } catch {
    return "unreadable";
  }
}

function laneFingerprint(lane: Lane): string {
  const providerId = lane.provider || lane.name;
  const ref = lane.secretRef ?? (lane.protocol ? `provider:${providerId}` : null);
  return [
    providerId,
    lane.authMode ?? "",
    lane.base ?? "",
    lane.projectId ?? "",
    lane.model,
    secretFingerprint(ref, lane.outDir),
  ].join("|");
}

/** Fingerprint per lane name across the role chains and every stage chain. */
function laneFingerprints(): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  const add = (lanes: Lane[]) => {
    for (const ln of lanes) {
      const set = byName.get(ln.name) ?? new Set<string>();
      set.add(laneFingerprint(ln));
      byName.set(ln.name, set);
    }
  };
  try {
    add(_activeLanes("vision"));
    add(_activeLanes("writer"));
  } catch {
    // keep what was collected
  }
  for (const stage of studioConfig.STAGES) {
    try {
      add(resolveStageLanes(stage).lanes);
    } catch {
      // a broken stage route never blocks the check
    }
  }
  return new Map([...byName].map(([name, set]) => [name, [...set].sort().join("\n")]));
}

function clearCooldown(name: string, why: string): boolean {
  if (!cooldowns.has(name)) return false;
  cooldowns.delete(name);
  cooldownSetAt.delete(name);
  log(`COOLDOWN cleared lane ${name} (${why})`);
  telemetry.provider(name, { coolingUntil: null, coolingReason: null });
  return true;
}

/** Clear this process's cooldown for one lane (Studio "Retry now"). */
export function resetLaneCooldown(name: string): boolean {
  return clearCooldown(name, "manual reset");
}

/** Lane names of the role chains and every stage chain. */
export function configuredLaneNames(): string[] {
  return [...laneFingerprints().keys()];
}

/**
 * Record a manual reset in `<outDir>/config/lane-resets.json` (0600, atomic) so
 * running pipelines drop the lane's older cooldown.
 */
export function writeLaneReset(name: string, at: number, outDir?: string): void {
  const file = laneResetsPath(outDir);
  let doc: Record<string, number> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) doc[k] = v;
      }
    }
  } catch {
    doc = {};
  }
  doc[name] = at;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tmp, flags, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Pick up provider account changes made after this process started. Reloads the
 * lane snapshot (semaphores and active counts stay: in-flight calls hold them)
 * and clears the cooldown of every lane whose fingerprint changed.
 */
function checkProviderConfig(now: number): void {
  if (now - laneWatch.checkedAt < LANE_CHECK_INTERVAL_MS) return;
  laneWatch.checkedAt = now;
  const configDir = path.join(secretStore.resolveOutDir(), "config");
  const stamp = ["providers.json", "stages.json", secretStore.SECRETS_FILENAME]
    .map((file) => fileStamp(path.join(configDir, file)))
    .join(",");
  if (laneWatch.fingerprints && stamp === laneWatch.stamp) return;
  const changed = laneWatch.fingerprints !== null;
  laneWatch.stamp = stamp;
  if (changed) {
    snapshot.loaded = false;
    laneCache.synced = false;
    laneCache.store = {};
  }
  const before = laneWatch.fingerprints;
  const after = laneFingerprints();
  laneWatch.fingerprints = after;
  if (!before) return;
  for (const name of [...cooldowns.keys()]) {
    if (before.get(name) !== after.get(name)) clearCooldown(name, "provider settings changed");
  }
}

/** Drop cooldowns that started before the lane's manual reset time. */
function checkLaneResets(now: number): void {
  if (now - laneWatch.resetsCheckedAt < LANE_CHECK_INTERVAL_MS) return;
  laneWatch.resetsCheckedAt = now;
  const file = laneResetsPath();
  const stamp = fileStamp(file);
  if (stamp === laneWatch.resetsStamp) return;
  laneWatch.resetsStamp = stamp;
  if (stamp === "-") return;
  let resets: Record<string, unknown>;
  try {
    resets = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!resets || typeof resets !== "object" || Array.isArray(resets)) return;
  for (const [name, at] of Object.entries(resets)) {
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    const setAt = cooldownSetAt.get(name);
    if (setAt !== undefined && setAt < at) clearCooldown(name, "manual reset");
  }
}

function refreshLaneState(): void {
  const now = nowImpl();
  try {
    checkProviderConfig(now);
  } catch {
    // a config read failure never fails a call
  }
  try {
    checkLaneResets(now);
  } catch {
    // same
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function logPath(): string {
  return (
    process.env.PIPELINE_LOG ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "pipeline.log")
  );
}

export function envFilePath(): string {
  return process.env.PIPELINE_ENV || path.join(os.homedir(), ".hermes", ".env");
}

/** Append one line to PIPELINE_LOG. Failures are swallowed. */
export function log(line: string): void {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${stamp()} ${line}\n`);
  } catch {
    // A logging failure must never fail a call.
  }
}

/** Read a key from process.env, else PIPELINE_ENV / ~/.hermes/.env. */
export function loadKey(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const file = envFilePath();
  try {
    const text = fs.readFileSync(file, "utf8");
    const prefix = `${name}=`;
    for (const line of text.split("\n")) {
      if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  throw new RuntimeError(`${name} missing from env / ${file}`);
}

export function baiKey(): string {
  return loadKey("BAI_API_KEY");
}

function bearer(token: string): string {
  return "Be" + "arer " + token;
}

function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Vertex access token for a legacy `kind: "vertex"` lane.
 *
 * Credentials come only from the Studio store: the enabled `vertex-ai` provider
 * (or any provider using the Vertex preset/protocol) plus its secret. There is
 * no host ADC file lookup and no hardcoded host path.
 */
function studioVertexProvider(): studioConfig.ProviderView | null {
  let providers: studioConfig.ProviderView[] = [];
  try {
    providers = studioConfig.listProviders();
  } catch {
    providers = [];
  }
  return providers.find((p) =>
    p.enabled !== false
    && (p.id === "vertex-ai" || p.preset === "vertex-ai" || p.protocol === "vertex-openai")) ?? null;
}

export async function vertexToken(): Promise<string> {
  const provider = studioVertexProvider();
  if (!provider) {
    throw new AuthError("Vertex credential missing: configure a vertex-ai provider in Studio");
  }
  const secretRef = provider.auth?.secretRef || `provider:${provider.id}`;
  const rawSecret = secretStore.getSecret(secretRef);
  if (!rawSecret) {
    throw new AuthError(`Vertex credential missing for provider '${provider.id}'`);
  }
  // Keyed per account: a swapped credential never reuses the old account's token.
  const cacheKey = `${provider.id}:${createHash("sha256").update(rawSecret).digest("hex").slice(0, 16)}`;
  const cached = vtok.get(cacheKey);
  if (cached && Date.now() / 1000 < cached.exp - 120) return cached.tok;
  const oauthMode = provider.auth?.mode === "vertex-oauth" || studioConfig.isVertexOAuthSecret(rawSecret);
  const resolved = oauthMode
    ? await studioConfig.resolveVertexOAuthAccessToken(rawSecret, {
        fetchFn: fetchImpl,
        clientId: provider.auth?.clientId,
        tokenUrl: provider.auth?.tokenUrl,
      })
    : await studioConfig.mintVertexAccessToken(rawSecret, { fetchFn: fetchImpl });
  vtok.clear();
  vtok.set(cacheKey, { tok: resolved.accessToken, exp: resolved.expiresAt ?? Date.now() / 1000 + 3600 });
  return resolved.accessToken;
}

const oauthRefreshInFlight = new Map<string, Promise<string | null>>();

async function refreshOAuthSecretOnce(
  rawSecret: string,
  secretRef: string,
  outDir?: string,
): Promise<string | null> {
  const key = `${outDir ?? ""}:${secretRef}`;
  const existing = oauthRefreshInFlight.get(key);
  if (existing) return existing;
  const task = (async (): Promise<string | null> => {
    try {
      const parsed = JSON.parse(rawSecret) as {
        access_token?: string;
        accessToken?: string;
        refresh_token?: string;
        refreshToken?: string;
        expires_at?: number;
        expiresAt?: number;
        token_url?: string;
        client_id?: string;
      };
      const refreshToken = parsed.refresh_token ?? parsed.refreshToken;
      if (!refreshToken) return null;
      const tokenUrl = parsed.token_url || "https://auth.openai.com/oauth/token";
      const clientId = parsed.client_id || studioConfig.PROVIDER_PRESETS["codex-oauth"]!.client_id!;
      const res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const refreshed = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!refreshed.access_token) return null;
      const nextExp = Math.floor(Date.now() / 1000) + Number(refreshed.expires_in ?? 3600);
      secretStore.putSecret(
        secretRef,
        JSON.stringify({
          ...parsed,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token ?? refreshToken,
          expires_at: nextExp,
        }),
        outDir,
      );
      return refreshed.access_token;
    } catch {
      return null;
    }
  })();
  oauthRefreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    oauthRefreshInFlight.delete(key);
  }
}

const copilotTokenCache = new Map<string, { token: string; expiresAt: number }>();
const copilotExchangeInFlight = new Map<string, Promise<string>>();

/**
 * Exchange a GitHub OAuth token for a Copilot session token.
 * `GET https://api.github.com/copilot_internal/v2/token` is the only way a
 * `ghp_*` / `gho_*` token can call `api.githubcopilot.com`. A token that is
 * already a Copilot `tid` token passes through untouched, and an unreachable
 * exchange endpoint falls back to the raw token (offline / mocked tests).
 */
async function resolveCopilotToken(ghToken: string, outDir?: string): Promise<string> {
  const trimmed = ghToken.trim();
  if (!/^(gh[pous]_|github_pat_)/i.test(trimmed)) return trimmed;
  const cacheKey = `${outDir ?? ""}:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = copilotTokenCache.get(cacheKey);
  if (cached && nowSec < cached.expiresAt - 60) return cached.token;
  const existing = copilotExchangeInFlight.get(cacheKey);
  if (existing) return existing;
  const task = (async (): Promise<string> => {
    try {
      const res = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
        method: "GET",
        headers: {
          Authorization: `token ${trimmed}`,
          Accept: "application/json",
          "User-Agent": "GithubCopilot/1.155.0",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return trimmed;
      const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
      if (typeof body.token !== "string" || !body.token.trim()) return trimmed;
      const expiresAt = typeof body.expires_at === "number" ? body.expires_at : nowSec + 1500;
      copilotTokenCache.set(cacheKey, { token: body.token.trim(), expiresAt });
      return body.token.trim();
    } catch {
      return trimmed;
    }
  })();
  copilotExchangeInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    copilotExchangeInFlight.delete(cacheKey);
  }
}

async function resolveOAuthOrBearerSecret(
  rawSecret: string,
  secretRef: string,
  outDir?: string,
): Promise<string> {
  const trimmed = rawSecret.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as {
      access_token?: string;
      accessToken?: string;
      refresh_token?: string;
      refreshToken?: string;
      expires_at?: number;
      expiresAt?: number;
      token_url?: string;
      client_id?: string;
    };
    const accessToken = parsed.access_token ?? parsed.accessToken;
    const refreshToken = parsed.refresh_token ?? parsed.refreshToken;
    const expiresAt = parsed.expires_at ?? parsed.expiresAt;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt && nowSec >= expiresAt - 60 && refreshToken) {
      const refreshed = await refreshOAuthSecretOnce(trimmed, secretRef, outDir);
      if (refreshed) return refreshed;
    }
    if (typeof accessToken === "string" && accessToken.trim()) {
      return accessToken.trim();
    }
  } catch {
    // treat as raw bearer string
  }
  return trimmed;
}

export async function laneTarget(
  lane: Lane,
  outDir?: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const effectiveOutDir = outDir ?? lane.outDir;
  const providerId = lane.provider || lane.name;
  const studioProv = (lane.protocol || lane.secretRef || !(providerId in _TRANSPORTS))
    ? studioConfig.getProvider(providerId, effectiveOutDir)
    : null;

  const protocol = lane.protocol ?? studioProv?.protocol;
  const authMode = lane.authMode ?? studioProv?.auth?.mode;
  const secretRef = lane.secretRef ?? studioProv?.auth?.secretRef ?? (studioProv ? `provider:${providerId}` : null);
  const base = lane.base ?? studioProv?.baseUrl ?? null;
  const extraHeaders = lane.headers ?? studioProv?.headers ?? {};

  if (
    protocol === "vertex-openai"
    || lane.kind === "vertex-openai"
    || authMode === "vertex-service-account"
    || authMode === "vertex-oauth"
  ) {
    const rawSa = secretRef ? secretStore.getSecret(secretRef, effectiveOutDir) : null;
    if (!rawSa) {
      throw new AuthError(`Vertex credential missing for provider '${providerId}'`);
    }
    const oauthMode = authMode === "vertex-oauth" || studioConfig.isVertexOAuthSecret(rawSa);
    let accessToken: string;
    let mintedProjectId: string | undefined;
    if (oauthMode) {
      const resolved = await studioConfig.resolveVertexOAuthAccessToken(rawSa, {
        fetchFn: fetchImpl,
        clientId: studioProv?.auth?.clientId,
        tokenUrl: studioProv?.auth?.tokenUrl,
      });
      accessToken = resolved.accessToken;
      mintedProjectId = resolved.projectId;
    } else {
      const minted = await studioConfig.mintVertexAccessToken(rawSa, { fetchFn: fetchImpl });
      accessToken = minted.accessToken;
      mintedProjectId = minted.projectId;
    }
    const proj = (
      lane.projectId
      || studioProv?.auth?.projectId
      || mintedProjectId
      || ""
    ).trim();
    if (!proj) {
      throw new AuthError("Vertex projectId is missing on the Studio provider and the credential has no project_id");
    }
    const region = (
      lane.location
      || studioProv?.auth?.location
      || VREGION
    ).trim();
    const rawBase = base || API;
    const substituted = rawBase
      .replace(/\{projectId\}/g, proj)
      .replace(/\{p\}/g, proj)
      .replace(/\{location\}/g, region)
      .replace(/\{r\}/g, region)
      .replace(/\/+$/, "");
    const url = substituted.endsWith("/chat/completions")
      ? substituted
      : `${substituted}/chat/completions`;
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
        Authorization: bearer(accessToken),
      },
    };
  }

  if (lane.kind === "vertex") {
    const provider = studioVertexProvider();
    const proj = (
      lane.projectId
      || provider?.auth?.projectId
      || (process.env.VERTEX_PROJECT_ID ?? "")
      || ""
    ).trim();
    if (!proj) {
      throw new AuthError("Vertex projectId is missing (set it on the Studio vertex-ai provider)");
    }
    const region = (
      lane.location
      || provider?.auth?.location
      || process.env.VERTEX_REGION
      || VREGION
    ).trim();
    const url = API.replace("{p}", proj).replace("{r}", region);
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(await vertexToken()),
      },
    };
  }

  if (protocol === "anthropic-messages" || lane.kind === "anthropic-messages") {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    };
    let token: string | null = null;
    if (secretRef) {
      const raw = secretStore.getSecret(secretRef, effectiveOutDir);
      if (raw) token = await resolveOAuthOrBearerSecret(raw, secretRef, effectiveOutDir);
    }
    if (!token && lane.key_env) {
      token = loadKey(lane.key_env);
    }
    if (!token && authMode !== "none") {
      throw new AuthError(`Anthropic secret missing for provider '${providerId}'`);
    }
    if (token) {
      if (authMode === "oauth-pkce" || studioProv?.preset === "claude-oauth" || token.startsWith("sk-ant-oat")) {
        headers.Authorization = bearer(token);
        headers["anthropic-beta"] = "oauth-2025-04-20";
      } else {
        headers["x-api-key"] = token;
        headers.Authorization = bearer(token);
      }
    }
    const cleanBase = (base || "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const url = cleanBase.endsWith("/messages")
      ? cleanBase
      : cleanBase.endsWith("/v1")
        ? `${cleanBase}/messages`
        : `${cleanBase}/v1/messages`;
    return { url, headers };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (secretRef && authMode !== "none") {
    const raw = secretStore.getSecret(secretRef, effectiveOutDir);
    if (raw) {
      let token = await resolveOAuthOrBearerSecret(raw, secretRef, effectiveOutDir);
      if (studioProv?.preset === "github-copilot" || providerId === "github-copilot") {
        token = await resolveCopilotToken(token, effectiveOutDir);
      }
      headers.Authorization = bearer(token);
    } else if (lane.key_env) {
      const key = loadKey(lane.key_env);
      headers.Authorization = bearer(key);
    } else if (studioProv) {
      throw new AuthError(`Secret missing for studio provider '${providerId}'`);
    }
  } else if (lane.key_env) {
    const key = loadKey(lane.key_env);
    headers.Authorization = bearer(key);
    if (lane.name === "workbuddy") {
      let cid = wbConv.get(key);
      if (!cid) {
        cid = uuid5(UUID_NAMESPACE_URL, key);
        wbConv.set(key, cid);
      }
      headers["X-Conversation-ID"] = cid;
      headers["X-Conversation-Message-ID"] = randomUUID();
      headers["X-Conversation-Request-ID"] = randomUUID();
      headers["X-Session-ID"] = cid;
      headers["X-Agent-Intent"] = "craft";
    }
  }
  if (!base) throw new Error("lane base missing");
  const cleanBase = base.replace(/\/+$/, "");
  const url = cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`;
  return { url, headers };
}

function quotaHit(err: string): boolean {
  const low = err.toLowerCase();
  if (low.includes("resource_exhausted")) return true;
  return low.includes("quota") && (
    err.includes("429") || low.includes("exceed") || low.includes("limit") || low.includes("reset")
  );
}

function quotaResetS(err: string): number | null {
  if (!quotaHit(err)) return null;
  const match = RESET_RE.exec(err);
  if (!match || !match.slice(1).some((group) => group)) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function cooldownLeft(name: string): number {
  return Math.max(0, (cooldowns.get(name) ?? 0) - nowImpl() / 1000);
}

const AUTH_COOLDOWN_S = 1800;

function cooldown(name: string, seconds: number, why: string): void {
  const now = nowImpl();
  const until = now / 1000 + Math.max(0, seconds);
  cooldowns.set(name, Math.max(cooldowns.get(name) ?? 0, until));
  cooldownSetAt.set(name, now);
  log(`COOLDOWN lane ${name} for ${Math.trunc(seconds)}s (${why})`);
  telemetry.provider(name, { coolingUntil: now / 1000 + seconds, coolingReason: why });
}

/** Seconds left on a lane's cooldown in this process (0 when not cooling). */
export function laneCooldownLeft(name: string): number {
  return cooldownLeft(name);
}

function isFilterBlocked(status: number, err: string): boolean {
  const low = err.toLowerCase();
  if (low.includes("data_inspection_failed")) return true;
  if (low.includes("inappropriate content")) return true;
  if (low.includes("moderation")) return true;
  if (low.includes("content_policy")) return true;
  if (status === 422) return true;
  return false;
}

const RATE_COOLDOWN_S = 90;
/** Longest one call() waits for a cooling lane before giving up. */
export const CHAIN_WAIT_MAX_S = 900;

function retryAfterS(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

/** 429 needs more air than a 5xx blip: 15s, 30s, 60s, 60s... */
function rateBackoffMs(attempt: number, status: number): number {
  if (status !== 429) return backoffMs(attempt);
  return Math.min(60, 15 * 2 ** attempt + Math.random() * 3) * 1000;
}

function backoffMs(attempt: number): number {
  return Math.min(60, (2 ** attempt) * 3 + Math.random() * 2) * 1000;
}

function reprError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}('${err.message.replace(/'/g, "\\'")}')`.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

function contentEmpty(out: Completion): boolean {
  try {
    const content = out.choices[0]?.message?.content;
    if (typeof content !== "string") return true;
    return content.trim().length === 0;
  } catch {
    return true;
  }
}

/**
 * reasoning_effort to send, or null. thinking=false wins over the stored effort:
 * Vertex rejects "none" (HTTP 400), so it gets its lowest accepted level.
 */
export function effectiveEffort(lane: Lane): string | null {
  const vertex = lane.protocol === "vertex-openai";
  if (!vertex && lane.protocol !== "openai-compatible") return null;
  if (lane.thinking === false) return vertex ? "minimal" : null;
  return lane.reasoningEffort ?? null;
}

/** Short operator-facing note for a failed HTTP call: status, upstream message, and what to do. */
export function httpErrorNote(status: number, body: string): string {
  let msg = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | unknown; message?: unknown };
    const e = Array.isArray(j) ? (j[0] as typeof j)?.error : j.error;
    const m = (e && typeof e === "object" ? (e as { message?: unknown }).message : e) ?? j.message;
    if (typeof m === "string") msg = m;
  } catch {
    msg = body.replace(/\s+/g, " ").trim();
  }
  msg = msg.slice(0, 90);
  const hint = status === 401
    ? "key/login rejected - reconnect provider in Studio"
    : status === 403
      ? "access denied - check key, plan or model access; lane parked 30 min"
      : status === 404
        ? "model or endpoint not found - check model id"
        : status === 429
          ? "rate limited - backing off, retrying same lane"
          : status >= 500
            ? "provider outage - retrying"
            : status === 400
              ? "request rejected - check model settings (effort/thinking/max out)"
              : "";
  return [`HTTP ${status}`, msg, hint].filter(Boolean).join(" · ");
}

function emptyNote(finish: string | null): string {
  if (finish === "length") return "Empty response · hit token cap (reasoning used it) · retrying with bigger cap";
  if (finish && TERMINAL_FINISH.has(finish)) return `Empty response · blocked (${finish}) · next lane`;
  return finish ? `Empty response · ${finish}` : "Empty response";
}

/** Extra max_tokens reserved for hidden reasoning, by effort level. */
export function reasoningHeadroom(effort: string | null | undefined): number {
  switch (String(effort ?? "").toLowerCase()) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 12000;
    case "high": return 24000;
    case "xhigh": case "max": return 32000;
    default: return 8000;
  }
}

const TERMINAL_FINISH = new Set([
  "length", "max_tokens", "content_filter", "safety", "prohibited_content",
  "blocklist", "spii", "recitation", "image_safety", "refusal",
]);

/** Why a 200 came back empty: finish_reason plus token usage, for the log and retry policy. */
export function emptyReason(out: Completion): { finish: string | null; detail: string; terminal: boolean } {
  const choice = out?.choices?.[0] as Record<string, unknown> | undefined;
  const raw = choice?.finish_reason ?? choice?.stop_reason ?? null;
  const finish = typeof raw === "string" && raw ? raw.toLowerCase() : null;
  const usage = out?.usage as Record<string, unknown> | undefined;
  const details = usage?.completion_tokens_details as Record<string, unknown> | undefined;
  const parts: string[] = [];
  if (finish) parts.push(`finish=${finish}`);
  if (typeof usage?.prompt_tokens === "number") parts.push(`prompt=${usage.prompt_tokens}`);
  if (typeof usage?.completion_tokens === "number") parts.push(`completion=${usage.completion_tokens}`);
  if (typeof details?.reasoning_tokens === "number") parts.push(`reasoning=${details.reasoning_tokens}`);
  if (!choice) parts.push("no choices");
  return { finish, detail: parts.join(" "), terminal: finish !== null && TERMINAL_FINISH.has(finish) };
}

/**
 * Assemble an OpenAI SSE body into the completion shape callers read.
 * Collects delta.content, delta.reasoning_content, and usage.
 * A 200 body that is not SSE raises Error.
 */
export function _readSse(raw: string): Completion {
  const parts: string[] = [];
  const reasoning: string[] = [];
  let usage: Completion["usage"] = {};
  let seenData = false;
  for (const rawLine of raw.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    seenData = true;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    let ev: unknown;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev && typeof ev === "object" && "error" in ev && (ev as { error?: unknown }).error) {
      throw new Error(`stream error: ${JSON.stringify((ev as { error: unknown }).error).slice(0, 200)}`);
    }
    const choices = ev && typeof ev === "object" && Array.isArray((ev as { choices?: unknown }).choices)
      ? (ev as { choices: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }> }).choices
      : [];
    for (const choice of choices) {
      const content = choice.delta?.content;
      if (typeof content === "string" && content) parts.push(content);
      const thought = choice.delta?.reasoning_content;
      if (typeof thought === "string" && thought) reasoning.push(thought);
    }
    // Anthropic Messages streaming sends text in `content_block_delta` events.
    const evObj = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : null;
    if (evObj?.type === "content_block_delta") {
      const delta = evObj.delta as { text?: unknown } | undefined;
      if (typeof delta?.text === "string" && delta.text) parts.push(delta.text);
    }
    if (ev && typeof ev === "object" && (ev as { usage?: unknown }).usage) {
      usage = (ev as { usage: Completion["usage"] }).usage;
    }
  }
  if (!seenData) {
    try {
      const err = JSON.parse(raw);
      throw new Error(`non-SSE 200: ${JSON.stringify(err).slice(0, 200)}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("non-SSE 200:")) throw err;
      throw new Error(`non-SSE 200: ${raw.slice(0, 200)}`);
    }
  }
  const message: CompletionMessage = { content: parts.join("") };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("");
  return { choices: [{ message }], usage };
}

function isAnthropicLane(lane: Lane): boolean {
  if (lane.protocol === "anthropic-messages" || lane.kind === "anthropic-messages") return true;
  const provId = lane.provider || lane.name;
  if (!(provId in _TRANSPORTS)) {
    const studioProv = studioConfig.getProvider(provId, lane.outDir);
    if (studioProv?.protocol === "anthropic-messages") return true;
  }
  return false;
}

/**
 * Resolve the ChatGPT Codex transport for a lane, or `null` when the lane is not
 * a ChatGPT subscription lane.
 *
 * A subscription OAuth JWT cannot call `api.openai.com/v1/*` (billing is not
 * active for OAuth tokens); it only works against the Codex backend. A custom
 * `baseUrl` (a local mock or gateway) always wins so tests and bridges keep
 * working.
 */
async function codexBackendTarget(
  lane: Lane,
): Promise<{ url: string; headers: Record<string, string>; token: string } | null> {
  const providerId = lane.provider || lane.name;
  const studioProv = lane.protocol || lane.secretRef || !(providerId in _TRANSPORTS)
    ? studioConfig.getProvider(providerId, lane.outDir)
    : null;
  if (!studioConfig.isCodexOauthProvider({ id: providerId, preset: studioProv?.preset })) return null;

  const secretRef = lane.secretRef ?? studioProv?.auth?.secretRef ?? `provider:${providerId}`;
  const raw = secretStore.getSecret(secretRef, lane.outDir);
  if (!raw) return null;
  const token = await resolveOAuthOrBearerSecret(raw, secretRef, lane.outDir);
  const accountId = studioConfig.extractChatGptAccountId(token);
  if (!accountId) return null;

  const configuredBase = (lane.base ?? studioProv?.baseUrl ?? "").replace(/\/+$/, "");
  if (configuredBase && configuredBase !== CHATGPT_DEFAULT_BASE) {
    // Explicit mock/gateway base: keep the caller's endpoint.
    return null;
  }

  return {
    url: CHATGPT_CODEX_URL,
    token,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(lane.headers ?? studioProv?.headers ?? {}),
      Authorization: bearer(token),
      originator: "opencode",
      "User-Agent": OPENCODE_USER_AGENT,
      "chatgpt-account-id": accountId,
    },
  };
}

/** Build the Codex `/responses` body from chat messages. */
function buildCodexPayload(
  lane: Lane,
  messages: ChatMessage[],
  maxTokens: number,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const input: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.trim()) systemParts.push(msg.content);
      continue;
    }
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(msg.content)
      ? msg.content.map((part) => {
          if (!part || typeof part !== "object") return part;
          const block = part as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") {
            return { type: "input_text", text: block.text };
          }
          if (block.type === "image_url") {
            const imageUrl = block.image_url;
            return {
              type: "input_image",
              image_url: typeof imageUrl === "string" ? imageUrl : (imageUrl as { url?: string })?.url,
            };
          }
          return part;
        })
      : (msg.content ?? "");
    input.push({ role, content });
  }
  if (input.length === 0) input.push({ role: "user", content: "" });
  return {
    model: lane.model,
    instructions: systemParts.join("\n\n") || "You are a helpful assistant.",
    input,
    store: false,
    stream: true,
    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
    ...(lane.extraBody ?? {}),
  };
}

/** Parse the Codex `/responses` SSE stream into the standard completion shape. */
export function _readCodexSse(raw: string): Completion {
  const parts: string[] = [];
  const reasoning: string[] = [];
  let usage: Completion["usage"] = {};
  let seenData = false;
  let completedText: string | null = null;

  for (const rawLine of raw.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    seenData = true;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      parts.push(ev.delta);
    } else if (ev.type === "response.reasoning_summary_text.delta" && typeof ev.delta === "string") {
      reasoning.push(ev.delta);
    } else if (ev.type === "response.completed" || ev.type === "response.done") {
      const response = (ev.response && typeof ev.response === "object"
        ? ev.response
        : ev) as Record<string, unknown>;
      const output = Array.isArray(response.output) ? response.output : [];
      const text: string[] = [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = Array.isArray((item as { content?: unknown }).content)
          ? ((item as { content: unknown[] }).content)
          : [];
        for (const blk of content) {
          if (blk && typeof blk === "object") {
            const b = blk as Record<string, unknown>;
            if (typeof b.text === "string" && b.text) text.push(b.text);
          }
        }
      }
      if (text.length > 0) completedText = text.join("");
      const rawUsage = response.usage;
      if (rawUsage && typeof rawUsage === "object") {
        const u = rawUsage as Record<string, unknown>;
        usage = {
          ...u,
          total_tokens: typeof u.total_tokens === "number"
            ? u.total_tokens
            : Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0),
        };
      }
    } else if (ev.type === "error" || ev.type === "response.failed") {
      throw new Error(`codex stream error: ${JSON.stringify(ev.error ?? ev).slice(0, 200)}`);
    }
  }

  if (!seenData) {
    throw new Error(`non-SSE 200: ${raw.slice(0, 200)}`);
  }
  const message: CompletionMessage = {
    content: parts.length > 0 ? parts.join("") : (completedText ?? ""),
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("");
  return { choices: [{ message }], usage };
}

function buildAnthropicPayload(
  lane: Lane,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const convMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const blk of msg.content) {
          if (blk && typeof blk === "object" && "text" in blk && typeof (blk as { text?: unknown }).text === "string") {
            systemParts.push((blk as { text: string }).text);
          }
        }
      }
      continue;
    }
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      convMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const convertedBlocks = msg.content.map((rawBlk) => {
        if (!rawBlk || typeof rawBlk !== "object") return rawBlk;
        const blk = rawBlk as Record<string, unknown>;
        if (blk.type === "text") {
          return { type: "text", text: String(blk.text ?? "") };
        }
        if (blk.type === "image_url" && blk.image_url && typeof blk.image_url === "object") {
          const url = String((blk.image_url as { url?: unknown }).url ?? "");
          const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
          if (dataMatch) {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: dataMatch[1],
                data: dataMatch[2],
              },
            };
          }
          return {
            type: "image",
            source: {
              type: "url",
              url,
            },
          };
        }
        return blk;
      });
      convMessages.push({ role, content: convertedBlocks });
    } else {
      convMessages.push({ role, content: String(msg.content ?? "") });
    }
  }

  const out: Record<string, unknown> = {
    model: lane.model,
    max_tokens: maxTokens,
    temperature,
    messages: convMessages,
    ...(lane.extraBody ?? {}),
  };
  if (systemParts.length > 0) {
    out.system = systemParts.join("\n\n");
  }
  if (lane.stream) {
    out.stream = true;
  }
  return out;
}

function parseAnthropicResponse(raw: string): Completion {
  const parsed = JSON.parse(raw) as {
    choices?: Completion["choices"];
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  if (Array.isArray(parsed.choices)) {
    return parsed as unknown as Completion;
  }
  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const blk of blocks) {
    if (blk?.type === "text" && typeof blk.text === "string") {
      textParts.push(blk.text);
    } else if (blk?.type === "thinking" && typeof blk.thinking === "string") {
      thinkingParts.push(blk.thinking);
    }
  }
  const inputTokens = typeof parsed.usage?.input_tokens === "number" ? parsed.usage.input_tokens : 0;
  const outputTokens = typeof parsed.usage?.output_tokens === "number" ? parsed.usage.output_tokens : 0;
  const totalTokens = typeof parsed.usage?.total_tokens === "number"
    ? parsed.usage.total_tokens
    : inputTokens + outputTokens;

  const message: CompletionMessage = { content: textParts.join("") };
  if (thinkingParts.length > 0) {
    message.reasoning_content = thinkingParts.join("");
  }
  return {
    choices: [{ message }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };
}

/**
 * Vertex's OpenAI-compatible `/chat/completions` endpoint expects the publisher
 * prefix in the payload (`google/<model>`). Config and UI keep the bare id.
 */
export function vertexRequestModel(model: string): string {
  const id = String(model ?? "").trim();
  if (!id || id.includes("/")) return id;
  return `google/${id}`;
}

/** Model id as it must appear in the outbound request body. */
export function outboundModel(lane: Lane): string {
  const isVertex = lane.kind === "vertex"
    || lane.kind === "vertex-openai"
    || lane.protocol === "vertex-openai";
  return isVertex ? vertexRequestModel(lane.model) : lane.model;
}

async function callLane(
  lane: Lane,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  retries: number,
  tag: string,
  timeout: number,
  laneName: string,
): Promise<{ out: Completion | null; skip: string | null }> {
  const anthropicMode = isAnthropicLane(lane);
  const codex = anthropicMode ? null : await codexBackendTarget(lane);
  let payload: Record<string, unknown>;
  if (anthropicMode) {
    payload = buildAnthropicPayload(lane, messages, maxTokens, temperature);
  } else if (codex) {
    payload = buildCodexPayload(lane, messages, maxTokens);
  } else {
    payload = {
      model: outboundModel(lane),
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(lane.extraBody ?? {}),
    };
    // Vertex's OpenAI endpoint rejects unknown fields; it gets effort=minimal instead.
    if (lane.thinking === false && lane.protocol !== "vertex-openai") payload.enable_thinking = false;
    const effort = effectiveEffort(lane);
    if (effort) {
      payload.reasoning_effort = effort;
      // Reasoning tokens are billed against max_tokens: without headroom a
      // high-effort model can spend the whole cap thinking and return "".
      payload.max_tokens = maxTokens + reasoningHeadroom(effort);
    }
    if (typeof lane.maxOutputTokens === "number" && typeof payload.max_tokens === "number") {
      payload.max_tokens = Math.min(payload.max_tokens, lane.maxOutputTokens);
    }
    if (lane.stream) {
      payload.stream = true;
      if (messages.length === 0 || messages[0]?.role !== "system") {
        payload.messages = [
          {
            role: "system",
            content: "You are a helpful assistant. Follow the user's instructions exactly.",
          },
          ...messages,
        ];
      }
    }
  }
  let body = JSON.stringify(payload);
  let last: string | null = null;
  let grown = false;
  for (let i = 0; i < Math.max(1, retries); i++) {
    let url: string;
    let headers: Record<string, string>;
    try {
      ({ url, headers } = codex ? codex : await laneTarget(lane));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { out: null, skip: `lane-unavailable: ${error.name}: ${error.message}` };
    }
    const t0 = Date.now();
    const statusCall = telemetry.callStart(lane as unknown as telemetry.CallLane, tag, i + 1);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(Math.max(1, timeout) * 1000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const err = buf.subarray(0, 300).toString("utf8");
        last = `HTTP ${res.status}: ${err}`;
        telemetry.callEnd(statusCall, "error", undefined, httpErrorNote(res.status, err));
        log(`ERR  ${tag || laneName} [${laneName}] attempt=${i + 1} ${last}`);
        if (isFilterBlocked(res.status, err)) throw new FilterBlocked(last);
        // Only a stated reset ("resets in 3h", subscription caps) is a real
        // quota wall. A bare 429 / RESOURCE_EXHAUSTED (Vertex dynamic shared
        // quota) is a per-minute rate limit: back off and retry this lane.
        const resetS = quotaResetS(err);
        if (resetS !== null) {
          cooldown(lane.name, resetS + 60, `quota resets in ~${resetS}s`);
          return { out: null, skip: `quota-exhausted, lane cooling ${resetS + 60}s: ${err.slice(0, 120)}` };
        }
        if (res.status === 429 || quotaHit(err) || res.status >= 500) {
          if (i + 1 >= Math.max(1, retries)) {
            // Out of in-lane retries: short park so the chain can wait it out.
            if (res.status === 429 || quotaHit(err)) cooldown(lane.name, RATE_COOLDOWN_S, "rate limited");
            break;
          }
          const ra = retryAfterS(res.headers.get("retry-after"));
          await sleepImpl(ra !== null ? Math.min(ra, 120) * 1000 : rateBackoffMs(i, res.status));
          continue;
        }
        // Auth/permission rejections do not heal between calls: park the lane
        // so every later call in this run skips it instead of re-hitting it.
        if (res.status === 401 || res.status === 403) {
          cooldown(lane.name, AUTH_COOLDOWN_S, `HTTP ${res.status} rejected`);
        }
        return { out: null, skip: last };
      }
      const raw = buf.toString("utf8");
      const out = codex
        ? _readCodexSse(raw)
        : anthropicMode && !lane.stream
          ? parseAnthropicResponse(raw)
          : lane.stream
            ? _readSse(raw)
            : JSON.parse(raw) as Completion;
      if (contentEmpty(out)) {
        const why = emptyReason(out);
        last = `HTTP 200 but empty content${why.detail ? ` (${why.detail})` : ""}`;
        telemetry.callEnd(statusCall, "error", undefined, emptyNote(why.finish));
        log(`ERR  ${tag || laneName} [${laneName}] attempt=${i + 1} ${last}`);
        // Truncated before any visible text: one retry with a larger cap.
        if (why.finish === "length" && !grown && typeof payload.max_tokens === "number") {
          grown = true;
          payload.max_tokens = Math.min(payload.max_tokens * 2 + 8000, lane.maxOutputTokens ?? 65000);
          body = JSON.stringify(payload);
          log(`GROW ${tag || laneName} [${laneName}] max_tokens -> ${payload.max_tokens}`);
          i--; // the grown retry does not count against `retries`
          continue;
        }
        // Same prompt, same cap, same safety verdict: retrying only burns minutes.
        if (why.terminal) return { out: null, skip: last };
        // Unexplained empties: one retry, then hand off to the next lane.
        if (i >= 1) return { out: null, skip: last };
        await sleepImpl(backoffMs(i));
        continue;
      }
      const answer = out.choices?.[0]?.message?.content;
      if (typeof answer === "string" && answer.length < 1000 && isRefusalText(answer)) {
        last = `policy refusal: ${answer.slice(0, 120)}`;
        telemetry.callEnd(statusCall, "error", undefined, "Refused · safety policy · next lane");
        log(`ERR  ${tag || laneName} [${laneName}] attempt=${i + 1} ${last}`);
        return { out: null, skip: last };
      }
      const total = out.usage?.total_tokens;
      const shown = typeof total === "number" ? String(total) : "?";
      log(`OK   ${tag || laneName} [${laneName}] attempt=${i + 1} ${Math.round((Date.now() - t0) / 1000)}s tokens=${shown}`);
      telemetry.callEnd(statusCall, "ok", typeof total === "number" ? total : null);
      return { out, skip: null };
    } catch (err) {
      if (err instanceof FilterBlocked) throw err;
      last = reprError(err);
      telemetry.callEnd(statusCall, "error", undefined, err instanceof Error ? err.name : "Error");
      log(`ERR  ${tag || laneName} [${laneName}] attempt=${i + 1} ${last}`);
      if (isFilterBlocked(0, last)) throw new FilterBlocked(last);
      await sleepImpl(backoffMs(i));
    }
  }
  return { out: null, skip: last };
}

function optNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveStageLanes(
  stage: studioConfig.StageId,
): { lanes: Lane[]; role: "vision" | "writer"; temperature?: number } {
  const role: "vision" | "writer" = stage === "reader" || stage === "matcher" || stage === "scout"
    ? "vision"
    : "writer";
  try {
    const stagesState = studioConfig.getStagesConfig();
    if (stagesState.persisted) {
      const route = stagesState.stages[stage];
      if (route && Array.isArray(route.chain) && route.chain.length > 0) {
        const outDir = secretStore.resolveOutDir();
        const lanes = route.chain
          .filter((id) => entryIsRoutable(id, outDir))
          .map((id) => laneFromConfigEntry({ id, concurrency: route.concurrency }, role, outDir));
        // A persisted route whose every lane is disabled stays empty: falling
        // back to the role chain would silently re-enable what the operator
        // turned off.
        return { lanes, role, temperature: route.temperature };
      }
    }
  } catch {
    // fall back to active role lanes
  }
  return { lanes: _activeLanes(role), role };
}

/**
 * Walk the ordered lanes. First lane that answers wins.
 * `options.lane` is `vision` or `writer` (default writer). `timeout` is seconds.
 * `options.stage` optionally selects a per-stage chain from `studioConfig`.
 */
export async function call(messages: ChatMessage[], options: CallOptions = {}): Promise<Completion> {
  const maxTokens = optNum(options.maxTokens ?? options.max_tokens, 6000);
  const retries = optNum(options.retries, 4);
  const tag = options.tag ?? "";
  const timeout = optNum(options.timeout, 600);
  refreshLaneState();

  let key: string;
  let lanes: Lane[];
  let defaultTemp = 0.7;

  if (options.stage) {
    const resolved = resolveStageLanes(options.stage);
    key = options.lane || resolved.role;
    lanes = resolved.lanes;
    if (resolved.temperature !== undefined) defaultTemp = resolved.temperature;
  } else {
    key = options.lane || "writer";
    // Only an on-disk `stages.json` opts a role call into stage routing; without
    // it the role chain (and its module-level test hooks) stays authoritative.
    const fallbackStage = key === "vision" ? "reader" : key === "writer" ? "writer" : null;
    const resolved = fallbackStage && stageRoutingPersisted() ? resolveStageLanes(fallbackStage) : null;
    if (resolved) {
      lanes = resolved.lanes;
      if (resolved.temperature !== undefined) defaultTemp = resolved.temperature;
    } else {
      lanes = _activeLanes(key === "vision" ? "vision" : "writer");
    }
  }

  const temperature = optNum(options.temperature, defaultTemp);
  telemetry.bind({ role: key });
  let waited = 0;
  for (;;) {
    // A wait for a cooling lane also notices a provider change or a manual reset.
    if (waited > 0) refreshLaneState();
    const failures: string[] = [];
    for (const ln of lanes) {
      const left = cooldownLeft(ln.name);
      if (left > 0) {
        const msg = `lane cooling (${Math.trunc(left)}s left)`;
        failures.push(`${ln.name}(${ln.model}): ${msg}`);
        log(`SKIP lane ${ln.name} -> next (${msg})`);
        continue;
      }
      const result = await withLaneSlot(key, ln, () =>
        callLane(ln, messages, maxTokens, temperature, retries, tag, timeout, ln.name));
      if (result.out !== null) return result.out;
      failures.push(`${ln.name}(${ln.model}): ${result.skip}`);
      log(`SKIP lane ${ln.name} -> next (${result.skip})`);
    }
    // Every lane failed. If one is only cooling briefly (rate limit), wait for
    // it instead of failing the whole chapter in one second.
    const soonest = Math.min(...lanes.map((ln) => cooldownLeft(ln.name)).filter((s) => s > 0));
    if (!Number.isFinite(soonest) || waited + soonest > CHAIN_WAIT_MAX_S) {
      throw new AllLanesFailed(`all lanes failed: ${failures.join(" | ")}`);
    }
    const nap = Math.ceil(soonest) + 1;
    log(`WAIT ${tag || key}: all lanes busy, retrying in ${nap}s (waited ${Math.round(waited)}s of ${CHAIN_WAIT_MAX_S}s)`);
    telemetry.notice(`${tag || key}: all lanes busy (rate limit), retrying in ${nap}s`, "warn");
    await sleepImpl(nap * 1000);
    waited += nap;
  }
}

export function pagesIn(chdir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(chdir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((name) => /^[0-9]+$/.test(name.split(".")[0] ?? ""))
    .sort((a, b) => pageId(a) - pageId(b))
    .map((name) => path.join(chdir, name));
}

export function pageId(file: string): number {
  return Number.parseInt(path.basename(file).split(".")[0] ?? "", 10);
}

/** Resize when height > maxH (aspect preserved), RGB JPEG quality 85, base64. */
export async function imgB64(filePath: string, maxH = 1400, quality = 85): Promise<string> {
  const image = sharp(filePath);
  const meta = await image.metadata();
  const height = meta.height ?? 0;
  const width = meta.width ?? 0;
  if (height > maxH) {
    const newW = Math.max(1, Math.trunc((width * maxH) / height));
    image.resize(newW, maxH, { fit: "fill", kernel: "lanczos3" });
  }
  const buf = await image.toColorspace("srgb").jpeg({ quality }).toBuffer();
  return buf.toString("base64");
}

export async function pageBlocks(paths: string[], maxH = 1400): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  for (const file of paths) {
    blocks.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${await imgB64(file, maxH)}` },
    });
  }
  return blocks;
}

function sanitize(input: string): string {
  const out: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (esc) {
      out.push(ch);
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out.push(ch);
      esc = true;
      continue;
    }
    if (ch === '"') {
      if (!inStr) {
        inStr = true;
        out.push(ch);
      } else {
        let j = i + 1;
        while (j < input.length && " \t\r\n".includes(input[j] ?? "")) j += 1;
        const next = j >= input.length ? "" : input[j] ?? "";
        if (j >= input.length || ",}]:".includes(next)) {
          inStr = false;
          out.push(ch);
        } else {
          out.push('\\"');
        }
      }
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

function salvage(txt: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start: number | null = null;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== null) {
        const frag = txt.slice(start, i + 1);
        for (const cand of [frag, sanitize(frag)]) {
          try {
            objs.push(JSON.parse(cand));
            break;
          } catch {
            // try the sanitized candidate, then the next fragment
          }
        }
        start = null;
      }
    }
  }
  return objs;
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function stripFence(text: string): string {
  let txt = text.trim();
  if (!txt.startsWith("```")) return txt;
  const parts = txt.split("```");
  txt = parts[1] ?? "";
  if (txt.toLowerCase().startsWith("json")) txt = txt.slice(4);
  return txt;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  for (const cand of [text, sanitize(text)]) {
    try {
      return { ok: true, value: JSON.parse(cand) };
    } catch {
      // next candidate
    }
  }
  return { ok: false };
}

/** First balanced `{...}` or `[...]`, string-aware. */
function findBalanced(text: string): string | null {
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  if (objAt < 0 && arrAt < 0) return null;
  const start = arrAt >= 0 && (objAt < 0 || arrAt < objAt) ? arrAt : objAt;
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Tolerant JSON extraction. Strips `<think>` blocks and markdown fences, then
 * parses a balanced object or array. Falls back to salvaged page objects.
 */
export function parseJson(text: string): unknown {
  const stripped = stripFence(stripThink(text));
  const direct = tryParse(stripped);
  if (direct.ok) return direct.value;

  const balanced = findBalanced(stripped);
  if (balanced?.startsWith("[")) {
    const parsed = tryParse(balanced);
    if (parsed.ok) return parsed.value;
  }

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed.ok) return parsed.value;
  }

  const pages = salvage(stripped);
  if (pages.length > 1) {
    return { pages, characters: [], gags: [], events: [] };
  }

  if (balanced?.startsWith("{")) {
    const parsed = tryParse(balanced);
    if (parsed.ok) return parsed.value;
  }

  if (pages.length > 0) {
    return { pages, characters: [], gags: [], events: [] };
  }
  throw new Error("unparseable JSON");
}

export const parse_json = parseJson;
export const img_b64 = imgB64;
export const page_blocks = pageBlocks;
export const page_id = pageId;
export const pages_in = pagesIn;
export const _active_lanes = _activeLanes;
export const _lane_semaphore = _laneSemaphore;
export const _reset_lane_snapshot = _resetSnapshotForTests;
export const lane_snapshot_status = laneSnapshotStatus;
export const env_key = loadKey;
export const envKey = loadKey;
export const bai_key = baiKey;
export const _read_sse = _readSse;
