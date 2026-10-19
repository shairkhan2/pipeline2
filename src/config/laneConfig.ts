/**
 * Validated, persisted model and render lane configuration.
 *
 * Schema version 1, monotonic revision, flock + fsync atomic writes.
 * Credential-free: no URLs, env var names, or secrets in the catalog.
 * Default role lanes are the static snapshot of pipeline/llm.py (no AST import).
 * Pass `roleLanes` to override that snapshot in tests.
 *
 * Default config path is `<repo>/out/lanes.json` inside pipeline-v2. This module
 * never writes outside its own repository tree.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_CANDIDATES,
  UNAVAILABLE_MODEL_CANDIDATES,
} from "./laneRegistry.js";
import { DEFAULT_VISION_LANES, DEFAULT_WRITER_LANES } from "./modelLanes.js";
import {
  RENDER_LANE_ENV,
  normalizeRenderOverride,
  renderPolicySemantics,
} from "./renderPolicy.js";
import { listProviders, listRenderNodesConfig } from "./studioConfig.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../..");
/** Linux O_CLOEXEC. Absent from fs.constants on this Node build. */
const O_CLOEXEC = 0o2000000;

export const SCHEMA_VERSION = 1;
export const LANE_CONFIG_FILENAME = "lanes.json";
export const LANE_LOCK_FILENAME = "lanes.lock";
export const MAX_CONFIG_FILE_BYTES = 65536;

export const MODEL_ROLES = ["vision", "writer"] as const;
export const RENDER_LANE_IDS = ["laptop", "cloud", "local"] as const;

export const MIN_MODEL_CONCURRENCY = 1;
export const MAX_MODEL_CONCURRENCY = 4;
export const DEFAULT_MODEL_CONCURRENCY = 1;

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "command",
  "cmd",
  "shell",
  "args",
  "url",
  "uri",
  "base",
  "base_url",
  "baseurl",
  "endpoint",
  "host",
  "hostname",
  "ssh",
  "apikey",
  "api_key",
  "key",
  "key_env",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "authorization",
  "auth",
  "auth_mode",
  "headers",
  "env",
  "settings",
  "force",
  "clear_cache",
]);

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
  /\bxai-[A-Za-z0-9_\-]{6,}\b/gi,
  /\bsk-or-[A-Za-z0-9_\-]{6,}\b/gi,
  /\bsk-ant-[A-Za-z0-9_\-]{6,}\b/gi,
  /\bsk-[A-Za-z0-9_\-]{8,}\b/gi,
  /\bAIza[A-Za-z0-9_\-]{10,}\b/g,
  /\bgsk_[A-Za-z0-9_\-]{6,}\b/g,
  /((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)\S+/gi,
  /("(?:access|refresh|api_key|token|authorization|secret|password)"\s*:\s*)"[^"]*"/gi,
];

export const PROVIDER_LABELS: Record<string, string> = {
  agy: "AGY Local Rotator",
  workbuddy: "WorkBuddy Gateway",
  opencode: "OpenCode Local Shim",
  openrouter: "OpenRouter",
  vertex: "Google Vertex AI",
};

export interface RoleLane {
  kind: string;
  provider: string;
  model: string;
  thinking: boolean | null;
  stream: boolean;
}

export type RoleLanes = {
  vision: RoleLane[];
  writer: RoleLane[];
};

/**
 * Isolated safe fallback matching pipeline/llm.py VISION_LANES and WRITER_LANES.
 * Derived from the one canonical definition in `modelLanes.ts`.
 */
export const _STATIC_ROLE_LANES: RoleLanes = {
  vision: DEFAULT_VISION_LANES.map((lane) => ({ ...lane })),
  writer: DEFAULT_WRITER_LANES.map((lane) => ({ ...lane })),
};

/**
 * Real per-lane renderer capacity. An advertised bound the transport cannot
 * honour is never offered. renderPolicy still clamps as defence in depth.
 *   local  - CPU-hog renders serialize; local host also serves TTS/cleaner prep.
 *   laptop - one whole-chapter remote job at a time.
 *   cloud  - Docker transport caps at two.
 */
export const RENDER_TRANSPORT_SLOT_CAP: Record<string, number> = {
  laptop: 1,
  cloud: 2,
  local: 1,
};

/**
 * Real transport capacity for operator-registered render nodes
 * (`config/render-nodes.json`): an SSH host or a second local worker can run up
 * to four serialized renders, a Docker sandbox transport caps at two.
 */
export const CUSTOM_RENDER_SLOT_CAP: Record<string, number> = {
  local: 4,
  ssh: 4,
  "docker-sbx": 2,
};

/** Slot cap for a custom node kind (unknown kinds keep the conservative 1). */
export function customRenderSlotCap(kind: string): number {
  return CUSTOM_RENDER_SLOT_CAP[String(kind)] ?? 1;
}

/**
 * Catalog entries synthesized from registered custom render nodes. Built-in
 * ids keep their static catalog entry; a node whose id collides with one is
 * skipped so the built-in definition always wins.
 */
export function customRenderCatalog(outDir?: string): RenderCatalogEntry[] {
  let nodes: ReturnType<typeof listRenderNodesConfig> = [];
  try {
    nodes = listRenderNodesConfig(outDir);
  } catch {
    return [];
  }
  const out: RenderCatalogEntry[] = [];
  for (const node of nodes) {
    const id = String(node.id ?? "").trim();
    if (!id || RENDER_CATALOG_BY_ID[id]) continue;
    const kind = String(node.kind ?? "local");
    const cap = customRenderSlotCap(kind);
    out.push({
      id,
      label: String(node.label || id),
      kind,
      defaultEnabled: node.enabled !== false,
      defaultPriority: Number(node.priority ?? 99),
      minSlots: 1,
      maxSlots: cap,
      defaultSlots: Math.max(1, Math.min(Math.trunc(Number(node.slots ?? 1)) || 1, cap)),
      supportsCleaner: node.supportsCleaner !== false && kind !== "docker-sbx",
      supportsRender: true,
      costTier: kind === "docker-sbx" ? "paid-opt-in" : "free",
      description: `Registered ${kind} render node '${id}' from config/render-nodes.json.`,
    });
  }
  return out.sort((a, b) => a.defaultPriority - b.defaultPriority || a.id.localeCompare(b.id));
}

/** Built-in catalog plus registered custom nodes, keyed by lane id. */
export function renderCatalogById(outDir?: string): Record<string, RenderCatalogEntry> {
  const out: Record<string, RenderCatalogEntry> = { ...RENDER_CATALOG_BY_ID };
  for (const entry of customRenderCatalog(outDir)) out[entry.id] = entry;
  return out;
}

export interface RenderCatalogEntry {
  id: string;
  label: string;
  kind: string;
  defaultEnabled: boolean;
  defaultPriority: number;
  minSlots: number;
  maxSlots: number;
  defaultSlots: number;
  supportsCleaner: boolean;
  supportsRender: boolean;
  costTier: string;
  description: string;
}

export const RENDER_LANE_CATALOG: readonly RenderCatalogEntry[] = [
  {
    id: "laptop",
    label: "Remote Laptop (Tailscale SSH)",
    kind: "remote",
    defaultEnabled: true,
    defaultPriority: 1,
    minSlots: 1,
    maxSlots: RENDER_TRANSPORT_SLOT_CAP.laptop,
    defaultSlots: 1,
    supportsCleaner: true,
    supportsRender: true,
    costTier: "free",
    description: "Primary remote worker for chapter cleaning and Remotion video rendering when reachable and idle.",
  },
  {
    id: "cloud",
    label: "Docker Cloud Sandbox",
    kind: "cloud",
    defaultEnabled: false,
    defaultPriority: 2,
    minSlots: 1,
    maxSlots: RENDER_TRANSPORT_SLOT_CAP.cloud,
    defaultSlots: 2,
    supportsCleaner: false,
    supportsRender: true,
    costTier: "paid-opt-in",
    description: "Opt-in Docker cloud render overflow (disabled by default to avoid unexpected paid cloud capacity).",
  },
  {
    id: "local",
    label: "Local Host VM",
    kind: "local",
    defaultEnabled: true,
    defaultPriority: 3,
    minSlots: 1,
    maxSlots: RENDER_TRANSPORT_SLOT_CAP.local,
    defaultSlots: 1,
    supportsCleaner: true,
    supportsRender: true,
    costTier: "free",
    description: "Local host fallback worker serialized through the local heavy-stage lock.",
  },
];

export const RENDER_CATALOG_BY_ID: Record<string, RenderCatalogEntry> = Object.fromEntries(
  RENDER_LANE_CATALOG.map((entry) => [entry.id, entry]),
);

export type Env = Record<string, string | undefined>;

export interface RenderLaneConfig {
  id: string;
  enabled: boolean;
  slots: number;
}

export interface ModelLaneConfig {
  id: string;
  enabled: boolean;
  concurrency: number;
}

export interface LaneConfig {
  schemaVersion: number;
  render: RenderLaneConfig[];
  models: { vision: ModelLaneConfig[]; writer: ModelLaneConfig[] };
}

export interface RuntimeLane {
  id: string;
  order: number;
  enabled: boolean;
  slots: number;
  effectiveSlots: number;
  minSlots: number;
  maxSlots: number;
  costTier: string;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  name: string;
  model: string;
  kind: string;
  label: string;
  roles: string[];
  capabilities: { vision: boolean; writer: boolean; tts: boolean };
  roleSettings: Record<string, { thinking: boolean | null; stream: boolean }>;
  concurrencyBounds: { min: number; max: number; default: number };
  defaultPriority: { vision: number | null; writer: number | null };
  costTier: string;
  source: string;
  note?: string;
}

export interface UnavailableModelView {
  id: string;
  provider: string;
  name: string;
  model: string;
  label: string;
  roles: string[];
  capabilities: { vision: boolean; writer: boolean; tts: boolean };
  available: false;
  reason: string;
}

export interface LaneCatalog {
  schemaVersion: number;
  roles: string[];
  modelConcurrencyBounds: { min: number; max: number; default: number };
  render: RenderCatalogEntry[];
  models: ModelCatalogEntry[];
  modelsByRole: { vision: string[]; writer: string[] };
  unavailableModels: UnavailableModelView[];
}

export interface RuntimeIntegration {
  appliesTo: "next-run";
  liveRunsInterrupted: false;
  modelLanesIntegrated: true;
  modelLaneSource: string;
  modelLanesActive: boolean;
  renderSchedulerIntegrated: true;
  renderLaneSource: string;
  renderLanesActive: boolean;
  perJobRenderOverrideIntegrated: true;
  renderOverride: string;
  status: "model-render-runtime-wired";
  note: string;
}

export interface LanesState {
  schemaVersion: number;
  revision: number;
  source: "defaults" | "persisted" | "invalid_persisted";
  persisted: boolean;
  persistedValid: boolean;
  persistedActive: boolean;
  isDefault: boolean;
  configError: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  appliesTo: "next-run";
  runtimeIntegration: RuntimeIntegration;
  renderRuntime: {
    order: string[];
    override: string;
    lanes: RuntimeLane[];
    policy: ReturnType<typeof renderPolicySemantics> | null;
  };
  config: LaneConfig;
  defaults: LaneConfig;
  catalog: LaneCatalog;
}

export type ParsedMutation =
  | { mode: "reset"; revision: number | null }
  | { mode: "update"; revision: number; config: LaneConfig };

const RUNTIME_NOTE =
  "Persisted model lane ordering/enablement/bounded concurrency (llm.py) and persisted render lane order/enablement/slots (renderlane.py via render_policy.py) are each resolved once at process/run start and never re-read, so active calls and renders are never interrupted. Render slots are clamped to real transport capacity (effectiveSlots), and the catalog advertises exactly that capacity. The per-job render override (inherit|local|laptop|cloud) is validated at intake, persisted on the job, preserved across retry/continue, and passed to the pipeline subprocess as the server-generated MANHWA_RENDER_LANE value.";

export class LaneConfigError extends Error {
  statusCode = 400;
  status_code = 400;
  code = "lane_config_error";

  constructor(message: string) {
    super(message);
    this.name = "LaneConfigError";
  }
}

export class LaneConfigValidationError extends LaneConfigError {
  override statusCode = 400;
  override status_code = 400;
  override code = "validation_error";

  constructor(message: string) {
    super(message);
    this.name = "LaneConfigValidationError";
    this.statusCode = 400;
    this.status_code = 400;
    this.code = "validation_error";
  }
}

export class RevisionConflictError extends LaneConfigError {
  override statusCode = 409;
  override status_code = 409;
  override code = "revision_conflict";
  currentRevision: number | null;
  current_revision: number | null;

  constructor(message: string, currentRevision: number | null = null) {
    super(message);
    this.name = "RevisionConflictError";
    this.statusCode = 409;
    this.status_code = 409;
    this.code = "revision_conflict";
    this.currentRevision = currentRevision;
    this.current_revision = currentRevision;
  }
}

export class LockUnavailableError extends LaneConfigError {
  override statusCode = 503;
  override status_code = 503;
  override code = "lock_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "LockUnavailableError";
    this.statusCode = 503;
    this.status_code = 503;
    this.code = "lock_unavailable";
  }
}

/** Python names for the renamed conflict and lock errors. */
export const LaneConfigConflictError = RevisionConflictError;
export const LaneConfigLockError = LockUnavailableError;

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("'") && !value.includes('"')) return `"${value}"`;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function isStrictInt(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(text: unknown): string {
  if (text === null || text === undefined || text === false || text === 0 || text === "") return "";
  return String(text);
}

/** Redact credentials, tokens, and keys from any diagnostic or error string. */
export function scrubSecrets(text: unknown): string {
  let s = asText(text);
  s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const pat of SECRET_PATTERNS) {
    pat.lastIndex = 0;
    s = s.replace(pat, (...args: unknown[]) => {
      const groups = args.slice(1, -2);
      const prefix = groups[0];
      return typeof prefix === "string" && prefix.length > 0 ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return s;
}

export function sanitizeLine(text: unknown, limit = 320): string {
  return scrubSecrets(text).split(/\s+/).filter((part) => part.length > 0).join(" ").slice(0, limit);
}

function resolveEnv(env?: Env): Env {
  return env ?? process.env;
}

export function configPath(env?: Env): string {
  const e = resolveEnv(env);
  if (e.MANHWA_LANE_CONFIG) return e.MANHWA_LANE_CONFIG;
  if (e.MANHWA_LANE_CONFIG_DIR) return path.join(e.MANHWA_LANE_CONFIG_DIR, LANE_CONFIG_FILENAME);
  // Share the studio out dir so `lanes.json` and `config/stages.json` agree.
  if (e.MANHWA_OUT_DIR) return path.join(e.MANHWA_OUT_DIR, LANE_CONFIG_FILENAME);
  if (e.PIPELINE_OUT_DIR) return path.join(e.PIPELINE_OUT_DIR, LANE_CONFIG_FILENAME);
  if (e.PIPELINE_LOG) return path.join(path.dirname(e.PIPELINE_LOG), LANE_CONFIG_FILENAME);
  if (e.MANHWA_JOBS_DIR) return path.join(path.dirname(e.MANHWA_JOBS_DIR), LANE_CONFIG_FILENAME);
  return path.join(REPO_ROOT, "out", LANE_CONFIG_FILENAME);
}

export function configDir(env?: Env): string {
  return path.dirname(configPath(env));
}

export function lockPath(env?: Env): string {
  return path.join(configDir(env), LANE_LOCK_FILENAME);
}

export function modelLaneId(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Static default role lanes, or a test override when both roles are non-empty. */
export function inspectStaticLanes(override?: RoleLanes | null): RoleLanes {
  if (
    override
    && Array.isArray(override.vision)
    && Array.isArray(override.writer)
    && override.vision.length > 0
    && override.writer.length > 0
  ) {
    return structuredClone(override);
  }
  return structuredClone(_STATIC_ROLE_LANES);
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function matchOwnerToDir(target: string, refDir: string): void {
  if (!isRoot()) return;
  try {
    let ref = refDir;
    while (!fs.existsSync(ref)) {
      const parent = path.dirname(ref);
      if (parent === ref) break;
      ref = parent;
    }
    const parentSt = fs.statSync(ref);
    if (parentSt.uid !== 0 || parentSt.gid !== 0) {
      fs.lchownSync(target, parentSt.uid, parentSt.gid);
    }
  } catch {
    // Ownership match is best-effort, same as the Python helper.
  }
}

function matchFdOwnerToDir(fd: number, refDir: string, st?: fs.Stats): void {
  if (!isRoot()) return;
  try {
    const fst = st ?? fs.fstatSync(fd);
    if (!fst.isFile()) return;
    const parentSt = fs.statSync(refDir);
    if (
      (parentSt.uid !== 0 || parentSt.gid !== 0)
      && (fst.uid !== parentSt.uid || fst.gid !== parentSt.gid)
    ) {
      fs.fchownSync(fd, parentSt.uid, parentSt.gid);
    }
  } catch {
    // Best-effort.
  }
}

function pyFalsy(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === false || raw === 0 || raw === "";
}

/** Python `int(value)` with a fallback on TypeError/ValueError. Falsy uses fallback first. */
function pyIntOr(raw: unknown, fallback: number): number {
  if (pyFalsy(raw)) return fallback;
  if (raw === true) return 1;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return fallback;
}

/**
 * Effective (transport-honest) slot count per lane id. Built-in lanes clamp to
 * `RENDER_TRANSPORT_SLOT_CAP`; registered custom nodes clamp to the cap for
 * their kind (4 for ssh/local, 2 for docker-sbx).
 */
export function effectiveRenderSlots(
  renderList: readonly unknown[] | null | undefined,
  outDir?: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  let catalog: Record<string, RenderCatalogEntry> | null = null;
  for (const raw of renderList ?? []) {
    if (!isPlainObject(raw)) continue;
    const lid = raw.id;
    if (typeof lid !== "string") continue;
    let cap = RENDER_TRANSPORT_SLOT_CAP[lid];
    if (cap === undefined) {
      catalog ??= renderCatalogById(outDir);
      const cat = catalog[lid];
      if (!cat) continue;
      cap = customRenderSlotCap(cat.kind);
    }
    const slots = pyIntOr(raw.slots, 1);
    out[lid] = Math.max(1, Math.min(slots, cap));
  }
  return out;
}

export function renderRuntimeContract(
  renderList: readonly unknown[] | null | undefined,
  outDir?: string,
): RuntimeLane[] {
  const eff = effectiveRenderSlots(renderList, outDir);
  const catalog = renderCatalogById(outDir);
  const lanes: RuntimeLane[] = [];
  const seen = new Set<string>();
  (renderList ?? []).forEach((raw, order) => {
    if (!isPlainObject(raw)) return;
    const lid = raw.id;
    if (typeof lid !== "string") return;
    const cat = catalog[lid];
    if (!cat) return;
    seen.add(lid);
    const slots = pyIntOr(raw.slots, cat.defaultSlots);
    lanes.push({
      id: lid,
      order,
      enabled: Boolean(raw.enabled),
      slots,
      effectiveSlots: eff[lid] ?? 1,
      minSlots: cat.minSlots,
      maxSlots: cat.maxSlots,
      costTier: cat.costTier,
    });
  });
  // Registered custom nodes are first-class lanes even when the render list was
  // written before they were registered: append them in priority order.
  for (const entry of customRenderCatalog(outDir)) {
    if (seen.has(entry.id)) continue;
    const slots = pyIntOr(entry.defaultSlots, 1);
    lanes.push({
      id: entry.id,
      order: lanes.length,
      enabled: entry.defaultEnabled,
      slots,
      effectiveSlots: Math.max(1, Math.min(slots, entry.maxSlots)),
      minSlots: entry.minSlots,
      maxSlots: entry.maxSlots,
      costTier: entry.costTier,
    });
  }
  return lanes;
}

interface BuiltCatalog {
  models: ModelCatalogEntry[];
  modelsById: Record<string, ModelCatalogEntry>;
  modelsByRole: { vision: string[]; writer: string[] };
  unavailableModels: UnavailableModelView[];
}

function studioOutDirFromEnv(env?: Env): string | undefined {
  if (!env) return undefined;
  if (env.MANHWA_OUT_DIR) return env.MANHWA_OUT_DIR;
  if (env.PIPELINE_OUT_DIR) return env.PIPELINE_OUT_DIR;
  if (env.MANHWA_LANE_CONFIG_DIR) {
    const resolved = path.resolve(env.MANHWA_LANE_CONFIG_DIR);
    return path.basename(resolved) === "config" ? path.dirname(resolved) : resolved;
  }
  if (env.MANHWA_LANE_CONFIG) {
    const dir = path.dirname(path.resolve(env.MANHWA_LANE_CONFIG));
    return path.basename(dir) === "config" ? path.dirname(dir) : dir;
  }
  return undefined;
}

export function buildModelCatalog(roleLanes?: RoleLanes | null, env?: Env): BuiltCatalog {
  const lanes = inspectStaticLanes(roleLanes);
  const byId: Record<string, ModelCatalogEntry> = {};
  const modelsByRole: { vision: string[]; writer: string[] } = { vision: [], writer: [] };

  const ensure = (provider: string, model: string, kind: string, customProviderLabel?: string): ModelCatalogEntry => {
    const lid = modelLaneId(provider, model);
    const existing = byId[lid];
    if (existing) return existing;
    const providerLabel = customProviderLabel ?? PROVIDER_LABELS[provider] ?? provider;
    const entry: ModelCatalogEntry = {
      id: lid,
      provider,
      name: provider,
      model,
      kind,
      label: `${providerLabel} · ${model}`,
      roles: [],
      capabilities: { vision: false, writer: false, tts: false },
      roleSettings: {},
      concurrencyBounds: {
        min: MIN_MODEL_CONCURRENCY,
        max: MAX_MODEL_CONCURRENCY,
        default: DEFAULT_MODEL_CONCURRENCY,
      },
      defaultPriority: { vision: null, writer: null },
      costTier: "free",
      source: "default",
    };
    byId[lid] = entry;
    return entry;
  };

  for (const role of MODEL_ROLES) {
    lanes[role].forEach((item, idx) => {
      const entry = ensure(item.provider, item.model, item.kind);
      if (!entry.roles.includes(role)) entry.roles.push(role);
      if (!modelsByRole[role].includes(entry.id)) modelsByRole[role].push(entry.id);
      entry.capabilities[role] = true;
      entry.defaultPriority[role] = idx + 1;
      entry.roleSettings[role] = {
        thinking: item.thinking ?? null,
        stream: Boolean(item.stream),
      };
    });
  }

  for (const spec of MODEL_CANDIDATES) {
    const entry = ensure(spec.provider, spec.model, spec.kind || "openai");
    entry.source = "candidate";
    if (spec.costTier) entry.costTier = spec.costTier;
    if (spec.note) entry.note = spec.note;
    for (const role of MODEL_ROLES) {
      if (!spec.roles.includes(role)) continue;
      if (!entry.roles.includes(role)) entry.roles.push(role);
      if (!modelsByRole[role].includes(entry.id)) modelsByRole[role].push(entry.id);
      const caps = spec.capabilities ?? {};
      entry.capabilities[role] = Boolean(caps[role] ?? true);
      const settings = spec.roleSettings?.[role] ?? {};
      entry.roleSettings[role] = {
        thinking: settings.thinking ?? null,
        stream: Boolean(settings.stream ?? false),
      };
    }
  }

  try {
    const studioProviders = listProviders(studioOutDirFromEnv(env));
    for (const provider of studioProviders) {
      if (provider.enabled === false) continue;
      const kind = provider.protocol === "anthropic-messages"
        ? "anthropic"
        : provider.protocol === "vertex-openai"
          ? "vertex"
          : "openai";
      for (const modelCfg of provider.models ?? []) {
        if (modelCfg.enabled === false) continue;
        const knownLane = Boolean(byId[modelLaneId(provider.id, modelCfg.id)]);
        const entry = ensure(provider.id, modelCfg.id, kind, provider.label || provider.id);
        // A lane that only the studio provider catalog knows must not stay
        // "default": validateModelsDict appends disabled default lanes to a saved
        // config, and a later read without that provider catalog would then
        // reject the file as containing unknown model lane ids.
        if (!knownLane) entry.source = "studio";
        if (modelCfg.costTier) entry.costTier = modelCfg.costTier;
        const supportedRoles: Array<"vision" | "writer"> = [];
        if (Array.isArray(modelCfg.roles) && modelCfg.roles.length > 0) {
          for (const r of modelCfg.roles) {
            if (r === "vision" || r === "writer") supportedRoles.push(r);
          }
        } else {
          if (modelCfg.capabilities?.vision) supportedRoles.push("vision");
          if (modelCfg.capabilities?.writer ?? true) supportedRoles.push("writer");
        }
        for (const role of supportedRoles) {
          if (!entry.roles.includes(role)) entry.roles.push(role);
          if (!modelsByRole[role].includes(entry.id)) modelsByRole[role].push(entry.id);
          entry.capabilities[role] = true;
          entry.roleSettings[role] = {
            thinking: modelCfg.thinking ?? null,
            stream: Boolean(modelCfg.stream ?? false),
          };
        }
      }
    }
  } catch {
    // Studio provider catalog is additive; never fail lane catalog build if unreadable.
  }

  const unavailable: UnavailableModelView[] = UNAVAILABLE_MODEL_CANDIDATES
    .filter((spec) => !byId[modelLaneId(spec.provider, spec.model)])
    .map((spec) => {
      const providerLabel = PROVIDER_LABELS[spec.provider] ?? spec.provider;
      return {
        id: modelLaneId(spec.provider, spec.model),
        provider: spec.provider,
        name: spec.provider,
        model: spec.model,
        label: `${providerLabel} · ${spec.model}`,
        roles: [...spec.roles],
        capabilities: { vision: false, writer: false, tts: false },
        available: false,
        reason: spec.reason || "Not wired on this host.",
      };
    });

  return {
    models: Object.values(byId),
    modelsById: byId,
    modelsByRole,
    unavailableModels: unavailable,
  };
}

export function getCatalog(roleLanes?: RoleLanes | null, env?: Env): LaneCatalog {
  const mcat = buildModelCatalog(roleLanes, env);
  const custom = customRenderCatalog(studioOutDirFromEnv(env ?? process.env));
  return {
    schemaVersion: SCHEMA_VERSION,
    roles: [...MODEL_ROLES],
    modelConcurrencyBounds: {
      min: MIN_MODEL_CONCURRENCY,
      max: MAX_MODEL_CONCURRENCY,
      default: DEFAULT_MODEL_CONCURRENCY,
    },
    render: [
      ...(structuredClone(RENDER_LANE_CATALOG) as RenderCatalogEntry[]),
      ...custom,
    ],
    models: mcat.models,
    modelsByRole: mcat.modelsByRole,
    unavailableModels: mcat.unavailableModels,
  };
}

export function getDefaultConfig(roleLanes?: RoleLanes | null): LaneConfig {
  const lanes = inspectStaticLanes(roleLanes);
  return {
    schemaVersion: SCHEMA_VERSION,
    render: RENDER_LANE_CATALOG.map((entry) => ({
      id: entry.id,
      enabled: Boolean(entry.defaultEnabled),
      slots: Number(entry.defaultSlots),
    })),
    models: {
      vision: lanes.vision.map((item) => ({
        id: modelLaneId(item.provider, item.model),
        enabled: true,
        concurrency: DEFAULT_MODEL_CONCURRENCY,
      })),
      writer: lanes.writer.map((item) => ({
        id: modelLaneId(item.provider, item.model),
        enabled: true,
        concurrency: DEFAULT_MODEL_CONCURRENCY,
      })),
    },
  };
}

export function runtimeIntegrationStatus(
  source = "defaults",
  persistedValid = false,
  override?: string | null,
): RuntimeIntegration {
  const active = Boolean(persistedValid && source === "persisted");
  return {
    appliesTo: "next-run",
    liveRunsInterrupted: false,
    modelLanesIntegrated: true,
    modelLaneSource: source,
    modelLanesActive: active,
    renderSchedulerIntegrated: true,
    renderLaneSource: source,
    renderLanesActive: active,
    perJobRenderOverrideIntegrated: true,
    renderOverride: override || "inherit",
    status: "model-render-runtime-wired",
    note: RUNTIME_NOTE,
  };
}

function renderRuntimeView(activeCfg: LaneConfig | null | undefined, env: Env, source: string) {
  let override = "inherit";
  let policy: ReturnType<typeof renderPolicySemantics> | null = null;
  try {
    const raw = Object.hasOwn(env, RENDER_LANE_ENV) ? env[RENDER_LANE_ENV] : undefined;
    override = normalizeRenderOverride(raw);
    policy = renderPolicySemantics(activeCfg, env, source);
  } catch {
    override = "inherit";
    policy = null;
  }
  const lanes = renderRuntimeContract(activeCfg?.render, studioOutDirFromEnv(env ?? process.env));
  return {
    order: lanes.filter((lane) => lane.enabled).map((lane) => lane.id),
    override,
    lanes,
    policy,
  };
}

function ensureConfigDir(cdir: string): string {
  let listed: fs.Stats | undefined;
  try {
    listed = fs.lstatSync(cdir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new LockUnavailableError(
        `Lane config directory path cannot be inspected: ${sanitizeLine(cdir)} (${code || "OSError"})`,
      );
    }
  }
  if (listed?.isSymbolicLink()) {
    throw new LockUnavailableError(`Lane config directory is a symbolic link: ${sanitizeLine(cdir)}`);
  }
  if (listed && !listed.isDirectory()) {
    throw new LockUnavailableError(`Lane config directory path is not a directory: ${sanitizeLine(cdir)}`);
  }
  const missing: string[] = [];
  let cur = cdir;
  while (!fs.existsSync(cur)) {
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const refExisting = cur;
  fs.mkdirSync(cdir, { recursive: true });
  for (const created of missing.reverse()) {
    matchOwnerToDir(created, refExisting);
  }
  return cdir;
}

function lockHoldMs(env?: Env): number {
  const raw = resolveEnv(env).MANHWA_LANE_LOCK_HOLD_S;
  const val = Number(raw || 0);
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, val) * 1000;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockUnavailable(lpath: string, reason: string): LockUnavailableError {
  return new LockUnavailableError(
    `Lane config lock is unavailable (${LANE_LOCK_FILENAME}): ${sanitizeLine(lpath)} (${sanitizeLine(reason, 120)}). Refusing to mutate lane configuration while it cannot be serialized.`,
  );
}

function verifyLockFd(fd: number, lpath: string): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.fstatSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw lockUnavailable(lpath, `lock fd is not valid (${code})`);
  }
  if (!st.isFile()) throw lockUnavailable(lpath, "not a regular file");
  let pathSt: fs.Stats;
  try {
    pathSt = fs.lstatSync(lpath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw lockUnavailable(lpath, `lock path is not stable (${code})`);
  }
  if (pathSt.isSymbolicLink()) throw lockUnavailable(lpath, "lock path is a symbolic link");
  if (!pathSt.isFile()) throw lockUnavailable(lpath, "not a regular file");
  if (pathSt.dev !== st.dev || pathSt.ino !== st.ino) {
    throw lockUnavailable(lpath, "lock path changed while opening");
  }
  return st;
}

function openLockFd(lpath: string): number {
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | O_CLOEXEC;
  let fd: number;
  try {
    fd = fs.openSync(lpath, flags, 0o664);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw lockUnavailable(lpath, `${e.code || e.name}: ${e.message}`);
  }
  try {
    const st = verifyLockFd(fd, lpath);
    matchFdOwnerToDir(fd, path.dirname(lpath), st);
    return fd;
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // already failing closed
    }
    throw err;
  }
}

/**
 * Exclusive lock on the open lanes.lock fd.
 * Uses non-blocking `flock -x -n 3` (fd passed as stdio 3) and retries until
 * acquired, so two writers serialize instead of failing the waiter closed.
 * The lock stays on this process's fd after flock exits; close(fd) releases it.
 */
function flockExclusive(fd: number, lpath: string): void {
  const start = Date.now();
  const timeoutMs = 60_000;
  while (true) {
    const res = spawnSync("flock", ["-x", "-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    if (res.status === 0) return;
    const busy = !res.error && res.status === 1 && Date.now() - start <= timeoutMs;
    if (busy) {
      sleepSync(20);
      continue;
    }
    const reason = res.error
      ? `${(res.error as NodeJS.ErrnoException).code || res.error.name}: ${res.error.message}`
      : `flock failed (status ${String(res.status)})`;
    throw lockUnavailable(lpath, reason);
  }
}

interface HeldLock {
  depth: number;
  pid: number;
}

const heldLocks = new Map<string, HeldLock>();

function withLaneConfigLock<T>(env: Env | undefined, fn: () => T): T {
  let cdir: string;
  let lpath: string;
  let key: string;
  try {
    cdir = ensureConfigDir(configDir(env));
    lpath = path.join(cdir, LANE_LOCK_FILENAME);
    key = `${fs.realpathSync(cdir)}:${process.pid}`;
  } catch (err) {
    if (err instanceof LaneConfigError) throw err;
    const e = err as NodeJS.ErrnoException;
    throw new LockUnavailableError(
      `Lane config lock is unavailable: config directory ${sanitizeLine(configDir(env))} (${sanitizeLine(e.code || e.name, 60)}). Refusing to mutate lane configuration while it cannot be serialized.`,
    );
  }

  for (const [k, held] of heldLocks) {
    if (held.pid !== process.pid) heldLocks.delete(k);
  }

  const existing = heldLocks.get(key);
  if (existing && existing.depth > 0) {
    existing.depth += 1;
    try {
      return fn();
    } finally {
      existing.depth -= 1;
      if (existing.depth <= 0) heldLocks.delete(key);
    }
  }

  const fd = openLockFd(lpath);
  try {
    flockExclusive(fd, lpath);
    const st = verifyLockFd(fd, lpath);
    matchFdOwnerToDir(fd, cdir, st);
    heldLocks.set(key, { depth: 1, pid: process.pid });
    const hold = lockHoldMs(env);
    if (hold > 0) sleepSync(hold);
    return fn();
  } finally {
    heldLocks.delete(key);
    try {
      fs.closeSync(fd);
    } catch {
      // close releases the flock
    }
  }
}

function verifyTargetWritable(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    const code = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw new LockUnavailableError(
      `Lane config path cannot be inspected: ${sanitizeLine(target)} (${code})`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new LockUnavailableError(
      `Lane config path is a symbolic link and will not be overwritten: ${sanitizeLine(target)}`,
    );
  }
  if (!st.isFile()) {
    throw new LockUnavailableError(`Lane config path is not a regular file: ${sanitizeLine(target)}`);
  }
}

function fsyncDir(dirPath: string): void {
  const flags = fs.constants.O_RDONLY | O_CLOEXEC | (fs.constants.O_DIRECTORY ?? 0);
  let dfd: number;
  try {
    dfd = fs.openSync(dirPath, flags);
  } catch {
    return;
  }
  try {
    fs.fsyncSync(dfd);
  } catch {
    // directory fsync is best-effort
  } finally {
    try {
      fs.closeSync(dfd);
    } catch {
      // ignore
    }
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const n = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw new Error("short write to temporary lane config file");
    offset += n;
  }
}

function unlinkQuiet(target: string): void {
  try {
    fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    fs.unlinkSync(target);
  } catch {
    // ignore
  }
}

function atomicWriteConfig(targetPath: string, data: unknown): void {
  const cdir = ensureConfigDir(path.dirname(targetPath));
  verifyTargetWritable(targetPath);
  const tmp = path.join(
    cdir,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`,
  );
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0)
    | O_CLOEXEC;
  const payload = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    const fd = fs.openSync(tmp, flags, 0o664);
    try {
      writeAll(fd, payload);
      fs.fsyncSync(fd);
      matchFdOwnerToDir(fd, cdir);
    } finally {
      fs.closeSync(fd);
    }
    verifyTargetWritable(targetPath);
    fs.renameSync(tmp, targetPath);
    matchOwnerToDir(targetPath, cdir);
    fsyncDir(cdir);
  } catch (err) {
    if (err instanceof LaneConfigError) throw err;
    const code = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw new LockUnavailableError(
      `Failed to persist lane configuration atomically: ${sanitizeLine(targetPath)} (${code})`,
    );
  } finally {
    unlinkQuiet(tmp);
  }
}

function unavailableById(): Record<string, { reason?: string }> {
  const out: Record<string, { reason?: string }> = {};
  for (const spec of UNAVAILABLE_MODEL_CANDIDATES) {
    out[spec.id] = spec;
    out[modelLaneId(spec.provider, spec.model)] = spec;
  }
  return out;
}

export function checkForbiddenKeys(obj: unknown, pathLabel = "body"): void {
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => checkForbiddenKeys(item, `${pathLabel}[${idx}]`));
    return;
  }
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    let norm = key.trim().toLowerCase().replace(/-/g, "_");
    if (norm.startsWith("x_")) norm = norm.slice(2);
    if (FORBIDDEN_KEYS.has(norm)) {
      throw new LaneConfigValidationError(
        `Forbidden configuration field ${pyRepr(key)} in ${pathLabel}: credentials, endpoints, and commands are server-only`,
      );
    }
    checkForbiddenKeys(obj[key], `${pathLabel}.${key}`);
  }
}

function validateRenderList(rawRender: unknown, outDir?: string): RenderLaneConfig[] {
  if (!Array.isArray(rawRender)) {
    throw new LaneConfigValidationError("render must be a non-empty array of render lane entries");
  }
  if (rawRender.length === 0) {
    throw new LaneConfigValidationError("render cannot be empty; at least one render lane must remain enabled");
  }
  const seen = new Set<string>();
  const normalized: RenderLaneConfig[] = [];
  const allowedKeys = new Set(["id", "enabled", "slots"]);
  // Built-ins plus operator-registered nodes (`config/render-nodes.json`).
  const catalog = renderCatalogById(outDir);
  const customIds = new Set(customRenderCatalog(outDir).map((entry) => entry.id));

  rawRender.forEach((item, idx) => {
    let itemDict: Record<string, unknown>;
    let lid: unknown;
    if (typeof item === "string") {
      lid = item.trim();
      itemDict = { id: lid, enabled: true };
    } else if (isPlainObject(item)) {
      const unknown = Object.keys(item).filter((key) => !allowedKeys.has(key));
      if (unknown.length) {
        throw new LaneConfigValidationError(
          `Unknown field ${pyRepr(unknown[0])} in render[${idx}] (allowed: id, enabled, slots)`,
        );
      }
      itemDict = item;
      lid = itemDict.id;
    } else {
      throw new LaneConfigValidationError(`render[${idx}] must be an object with id, enabled, and slots`);
    }
    if (typeof lid !== "string" || !lid.trim()) {
      throw new LaneConfigValidationError(`render[${idx}].id must be a non-empty string`);
    }
    const id = lid.trim();
    if (!catalog[id]) {
      const allowed = [...RENDER_LANE_IDS, ...customIds].join(", ");
      throw new LaneConfigValidationError(
        `Unknown render lane ID ${pyRepr(id)} (allowed: ${allowed})`,
      );
    }
    if (seen.has(id)) {
      throw new LaneConfigValidationError(`Duplicate render lane ID ${pyRepr(id)} in render list`);
    }
    seen.add(id);
    const cat = catalog[id]!;
    let enabled: boolean;
    if ("enabled" in itemDict) {
      enabled = itemDict.enabled as boolean;
      if (typeof enabled !== "boolean") {
        throw new LaneConfigValidationError(`render[${idx}].enabled for ${pyRepr(id)} must be a boolean`);
      }
    } else {
      enabled = true;
    }
    let slots: number;
    if ("slots" in itemDict) {
      slots = itemDict.slots as number;
      if (!isStrictInt(slots)) {
        throw new LaneConfigValidationError(`render[${idx}].slots for ${pyRepr(id)} must be an integer`);
      }
      if (slots < cat.minSlots || slots > cat.maxSlots) {
        throw new LaneConfigValidationError(
          `render[${idx}].slots for ${pyRepr(id)} must be between ${cat.minSlots} and ${cat.maxSlots} (got ${slots})`,
        );
      }
    } else {
      slots = Number(cat.defaultSlots);
    }
    normalized.push({ id, enabled, slots });
  });

  for (const entry of RENDER_LANE_CATALOG) {
    if (!seen.has(entry.id)) {
      normalized.push({
        id: entry.id,
        enabled: false,
        slots: Number(entry.defaultSlots),
      });
    }
  }
  if (!normalized.some((row) => row.enabled)) {
    throw new LaneConfigValidationError(
      "At least one render lane must remain enabled (disabling all render lanes is not allowed)",
    );
  }
  return normalized;
}

function validateModelsDict(rawModels: unknown, roleLanes?: RoleLanes | null, env?: Env): LaneConfig["models"] {
  if (!isPlainObject(rawModels)) {
    throw new LaneConfigValidationError("models must be an object with 'vision' and 'writer' lane lists");
  }
  const unknownRoles = Object.keys(rawModels).filter((key) => !(MODEL_ROLES as readonly string[]).includes(key));
  if (unknownRoles.length) {
    throw new LaneConfigValidationError(
      `Unknown model role ${pyRepr(unknownRoles[0])} in models (allowed: ${MODEL_ROLES.join(", ")})`,
    );
  }
  const missingRoles = MODEL_ROLES.filter((role) => !(role in rawModels));
  if (missingRoles.length) {
    throw new LaneConfigValidationError(
      `Missing required model role ${pyRepr(missingRoles[0])} in models (both 'vision' and 'writer' are required)`,
    );
  }

  const mcat = buildModelCatalog(roleLanes, env);
  const allowedItemKeys = new Set(["id", "enabled", "concurrency"]);
  const unavail = unavailableById();
  const out = {} as LaneConfig["models"];

  for (const role of MODEL_ROLES) {
    const rawChain = rawModels[role];
    if (!Array.isArray(rawChain)) {
      throw new LaneConfigValidationError(`models.${role} must be a non-empty array of model lane entries`);
    }
    if (rawChain.length === 0) {
      throw new LaneConfigValidationError(
        `models.${role} cannot be empty; at least one usable ${role} model lane is required`,
      );
    }
    const seen = new Set<string>();
    const normalized: ModelLaneConfig[] = [];
    rawChain.forEach((item, idx) => {
      let itemDict: Record<string, unknown>;
      let lid: unknown;
      if (typeof item === "string") {
        lid = item.trim();
        itemDict = { id: lid, enabled: true };
      } else if (isPlainObject(item)) {
        const unknown = Object.keys(item).filter((key) => !allowedItemKeys.has(key));
        if (unknown.length) {
          throw new LaneConfigValidationError(
            `Unknown field ${pyRepr(unknown[0])} in models.${role}[${idx}] (allowed: id, enabled, concurrency)`,
          );
        }
        itemDict = item;
        lid = itemDict.id;
      } else {
        throw new LaneConfigValidationError(
          `models.${role}[${idx}] must be a catalog ID string or object with id, enabled, concurrency`,
        );
      }
      if (typeof lid !== "string" || !lid.trim()) {
        throw new LaneConfigValidationError(`models.${role}[${idx}].id must be a non-empty string`);
      }
      const id = lid.trim();
      const catEntry = mcat.modelsById[id];
      if (!catEntry) {
        const missing = unavail[id];
        if (missing) {
          throw new LaneConfigValidationError(
            `Model lane ${pyRepr(id)} is not available for role ${pyRepr(role)}: ${missing.reason || "not wired on this host"}`,
          );
        }
        throw new LaneConfigValidationError(`Unknown model catalog ID ${pyRepr(id)} in models.${role}[${idx}]`);
      }
      if (!catEntry.roles.includes(role)) {
        throw new LaneConfigValidationError(
          `Model lane ${pyRepr(id)} does not support role ${pyRepr(role)} (supported roles: ${catEntry.roles.join(", ")})`,
        );
      }
      if (seen.has(id)) {
        throw new LaneConfigValidationError(`Duplicate model lane ID ${pyRepr(id)} in models.${role}`);
      }
      seen.add(id);
      let enabled: boolean;
      if ("enabled" in itemDict) {
        enabled = itemDict.enabled as boolean;
        if (typeof enabled !== "boolean") {
          throw new LaneConfigValidationError(
            `models.${role}[${idx}].enabled for ${pyRepr(id)} must be a boolean`,
          );
        }
      } else {
        enabled = true;
      }
      let conc: number;
      if ("concurrency" in itemDict) {
        conc = itemDict.concurrency as number;
        if (!isStrictInt(conc)) {
          throw new LaneConfigValidationError(
            `models.${role}[${idx}].concurrency for ${pyRepr(id)} must be an integer`,
          );
        }
        if (conc < MIN_MODEL_CONCURRENCY || conc > MAX_MODEL_CONCURRENCY) {
          throw new LaneConfigValidationError(
            `models.${role}[${idx}].concurrency for ${pyRepr(id)} must be between ${MIN_MODEL_CONCURRENCY} and ${MAX_MODEL_CONCURRENCY} (got ${conc})`,
          );
        }
      } else {
        conc = DEFAULT_MODEL_CONCURRENCY;
      }
      normalized.push({ id, enabled, concurrency: conc });
    });

    for (const lid of mcat.modelsByRole[role]) {
      if (seen.has(lid)) continue;
      if (mcat.modelsById[lid]?.source !== "default") continue;
      normalized.push({
        id: lid,
        enabled: false,
        concurrency: DEFAULT_MODEL_CONCURRENCY,
      });
    }
    if (!normalized.some((entry) => entry.enabled)) {
      throw new LaneConfigValidationError(
        `Model role ${pyRepr(role)} must keep at least one enabled lane (empty usable chain is not allowed)`,
      );
    }
    out[role] = normalized;
  }
  return out;
}

export function validateConfigObject(rawConfig: unknown, roleLanes?: RoleLanes | null, env?: Env): LaneConfig {
  if (!isPlainObject(rawConfig)) {
    throw new LaneConfigValidationError("Lane configuration must be a JSON object");
  }
  checkForbiddenKeys(rawConfig, "config");
  const allowed = new Set(["schemaVersion", "render", "models"]);
  const unknown = Object.keys(rawConfig).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new LaneConfigValidationError(`Unknown configuration field: ${pyRepr(unknown[0])}`);
  }
  if ("schemaVersion" in rawConfig) {
    const sv = rawConfig.schemaVersion;
    if (!isStrictInt(sv) || sv !== SCHEMA_VERSION) {
      throw new LaneConfigValidationError(
        `Unsupported schemaVersion ${pyRepr(sv)} (expected ${SCHEMA_VERSION})`,
      );
    }
  }
  if (!("render" in rawConfig)) throw new LaneConfigValidationError("Missing required field: 'render'");
  if (!("models" in rawConfig)) throw new LaneConfigValidationError("Missing required field: 'models'");
  return {
    schemaVersion: SCHEMA_VERSION,
    render: validateRenderList(rawConfig.render, studioOutDirFromEnv(env ?? process.env)),
    models: validateModelsDict(rawConfig.models, roleLanes, env),
  };
}

function definedRev(value: unknown): unknown {
  return value === undefined || value === null ? undefined : value;
}

/** Validate a PUT /api/lanes payload. Returns a reset or update mutation. */
export function validateConfigPayload(payload: unknown, roleLanes?: RoleLanes | null, env?: Env): ParsedMutation {
  if (!isPlainObject(payload)) {
    throw new LaneConfigValidationError("Request body must be a JSON object");
  }
  checkForbiddenKeys(payload, "body");

  if ("reset" in payload) {
    const resetVal = payload.reset;
    if (typeof resetVal !== "boolean") {
      throw new LaneConfigValidationError("reset must be a boolean");
    }
    if (resetVal === true) {
      const allowedReset = new Set(["reset", "revision", "csrfToken"]);
      const extra = Object.keys(payload).filter((key) => !allowedReset.has(key));
      if (extra.length) {
        throw new LaneConfigValidationError(`Cannot combine reset=true with field ${pyRepr(extra[0])}`);
      }
      const rev = definedRev(payload.revision);
      if (rev !== undefined && (!isStrictInt(rev) || rev < 0)) {
        throw new LaneConfigValidationError("revision must be a non-negative integer");
      }
      return { mode: "reset", revision: rev === undefined ? null : rev };
    }
  }

  const allowedTop = new Set(["schemaVersion", "revision", "config", "render", "models", "reset", "csrfToken"]);
  const unknownTop = Object.keys(payload).filter((key) => !allowedTop.has(key));
  if (unknownTop.length) {
    throw new LaneConfigValidationError(`Unknown request field: ${pyRepr(unknownTop[0])}`);
  }

  const topRev = definedRev(payload.revision);
  let innerRev: unknown;
  let rawCfg: Record<string, unknown>;
  if ("config" in payload) {
    if ("render" in payload || "models" in payload) {
      throw new LaneConfigValidationError(
        "Specify either top-level 'render'/'models' or a 'config' object, not both",
      );
    }
    const cfgObj = payload.config;
    if (!isPlainObject(cfgObj)) {
      throw new LaneConfigValidationError("config must be a JSON object");
    }
    const allowedCfg = new Set(["schemaVersion", "revision", "render", "models"]);
    const unknownCfg = Object.keys(cfgObj).filter((key) => !allowedCfg.has(key));
    if (unknownCfg.length) {
      throw new LaneConfigValidationError(`Unknown field in config: ${pyRepr(unknownCfg[0])}`);
    }
    innerRev = definedRev(cfgObj.revision);
    rawCfg = {};
    for (const key of Object.keys(cfgObj)) {
      if (key !== "revision") rawCfg[key] = cfgObj[key];
    }
    if ("schemaVersion" in payload && !("schemaVersion" in rawCfg)) {
      rawCfg.schemaVersion = payload.schemaVersion;
    }
  } else {
    rawCfg = {};
    for (const key of ["schemaVersion", "render", "models"] as const) {
      if (key in payload) rawCfg[key] = payload[key];
    }
    innerRev = undefined;
  }

  if (topRev !== undefined && innerRev !== undefined && topRev !== innerRev) {
    throw new LaneConfigValidationError("Conflicting revision values in request body and config");
  }
  const rev = topRev !== undefined ? topRev : innerRev;
  if (rev === undefined) {
    throw new LaneConfigValidationError("revision is required for optimistic concurrency control");
  }
  if (!isStrictInt(rev) || rev < 0) {
    throw new LaneConfigValidationError("revision must be a non-negative integer");
  }
  return {
    mode: "update",
    revision: rev,
    config: validateConfigObject(rawCfg, roleLanes, env),
  };
}

interface PersistedDoc {
  exists: boolean;
  valid: boolean;
  revision: number;
  config: LaneConfig | null;
  updatedAt: number | null;
  updatedBy: string | null;
  isDefault: boolean;
  error: string | null;
  unusablePath: boolean;
}

function absentDoc(): PersistedDoc {
  return {
    exists: false,
    valid: true,
    revision: 0,
    config: null,
    updatedAt: null,
    updatedBy: null,
    isDefault: true,
    error: null,
    unusablePath: false,
  };
}

function invalidDoc(error: string, extra: Partial<PersistedDoc> = {}): PersistedDoc {
  const { error: extraError, ...rest } = extra;
  return {
    exists: true,
    valid: false,
    revision: 0,
    config: null,
    updatedAt: null,
    updatedBy: null,
    isDefault: false,
    unusablePath: false,
    ...rest,
    error: sanitizeLine(extraError ?? error),
  };
}

function readPersistedDoc(cpath: string, roleLanes?: RoleLanes | null, env?: Env): PersistedDoc {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | O_CLOEXEC;
  let fd: number;
  try {
    fd = fs.openSync(cpath, flags);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return absentDoc();
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(cpath).isSymbolicLink();
    } catch {
      // path may have vanished
    }
    const reason = isSymlink
      ? "Persisted lane config path is a symbolic link and will not be trusted."
      : `Persisted lane config file cannot be opened (${e.code || e.name}).`;
    return invalidDoc(reason, { unusablePath: true });
  }

  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return invalidDoc("Persisted lane config path is not a regular file.", { unusablePath: true });
    }
    if (st.size > MAX_CONFIG_FILE_BYTES) {
      return invalidDoc(`Persisted lane config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes.`);
    }
    const buf = Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.length > MAX_CONFIG_FILE_BYTES) {
      return invalidDoc(`Persisted lane config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return invalidDoc("Persisted lane config contains invalid JSON (UnicodeDecodeError).");
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return invalidDoc("Persisted lane config contains invalid JSON (SyntaxError).");
    }
    if (!isPlainObject(doc)) {
      return invalidDoc("Persisted lane config root must be a JSON object.");
    }
    const rawRev = doc.revision;
    const recovered = isStrictInt(rawRev) && rawRev >= 0 ? rawRev : 0;
    try {
      checkForbiddenKeys(doc, "persisted");
      const allowedDoc = new Set([
        "schemaVersion",
        "revision",
        "updatedAt",
        "updatedBy",
        "isDefault",
        "render",
        "models",
      ]);
      const unknownDoc = Object.keys(doc).filter((key) => !allowedDoc.has(key));
      if (unknownDoc.length) {
        throw new LaneConfigValidationError(`Unknown field in persisted file: ${pyRepr(unknownDoc[0])}`);
      }
      if (!isStrictInt(rawRev) || rawRev < 1) {
        throw new LaneConfigValidationError(
          `Invalid persisted revision ${pyRepr(rawRev)} (must be integer >= 1)`,
        );
      }
      const validated = validateConfigObject(
        {
          schemaVersion: doc.schemaVersion,
          render: doc.render,
          models: doc.models,
        },
        roleLanes,
        env,
      );
      const defaults = getDefaultConfig(roleLanes);
      const isDefault = deepEqual(validated.render, defaults.render) && deepEqual(validated.models, defaults.models);
      const updatedAt = typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt) ? doc.updatedAt : null;
      const updatedBy = typeof doc.updatedBy === "string" ? doc.updatedBy : null;
      return {
        exists: true,
        valid: true,
        revision: rawRev,
        config: validated,
        updatedAt,
        updatedBy,
        isDefault,
        error: null,
        unusablePath: false,
      };
    } catch (err) {
      if (!(err instanceof LaneConfigValidationError)) throw err;
      return invalidDoc(`Invalid persisted lane config (not active; using defaults): ${err.message}`, {
        revision: recovered,
      });
    }
  } catch (err) {
    if (err instanceof LaneConfigError) throw err;
    const code = (err as NodeJS.ErrnoException).code || (err as Error).name;
    return invalidDoc(`Failed reading persisted lane config (${code}).`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, idx) => key !== bKeys[idx])) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function getLanesState(env?: Env, roleLanes?: RoleLanes | null): LanesState {
  const resolved = resolveEnv(env);
  const cpath = configPath(resolved);
  const catalog = getCatalog(roleLanes, resolved);
  const defaults = getDefaultConfig(roleLanes);
  const persisted = readPersistedDoc(cpath, roleLanes, resolved);
  let source: LanesState["source"];
  let activeCfg: LaneConfig;
  if (!persisted.exists) {
    source = "defaults";
    activeCfg = structuredClone(defaults);
  } else if (persisted.valid && persisted.config) {
    source = "persisted";
    activeCfg = persisted.config;
  } else {
    source = "invalid_persisted";
    activeCfg = structuredClone(defaults);
  }
  const active = Boolean(persisted.valid && source === "persisted");
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: persisted.revision,
    source,
    persisted: persisted.exists,
    persistedValid: persisted.valid,
    persistedActive: active,
    isDefault: persisted.valid ? persisted.isDefault : true,
    configError: persisted.error,
    updatedAt: persisted.updatedAt,
    updatedBy: persisted.updatedBy,
    appliesTo: "next-run",
    runtimeIntegration: runtimeIntegrationStatus(source, persisted.valid),
    renderRuntime: renderRuntimeView(activeCfg, resolved, source),
    config: activeCfg,
    defaults,
    catalog,
  };
}

export function loadEffectiveLaneConfig(
  env?: Env,
  strict = false,
  roleLanes?: RoleLanes | null,
): LaneConfig {
  const persisted = readPersistedDoc(configPath(env), roleLanes, env);
  if (!persisted.exists) return getDefaultConfig(roleLanes);
  if (!persisted.valid || !persisted.config) {
    if (strict) {
      throw new LaneConfigValidationError(persisted.error || "Invalid persisted lane configuration");
    }
    return getDefaultConfig(roleLanes);
  }
  return persisted.config;
}

export function resetLanesState(
  expectedRevision?: number | null,
  updatedBy?: string | null,
  env?: Env,
  roleLanes?: RoleLanes | null,
): LanesState {
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (!isStrictInt(expectedRevision) || expectedRevision < 0) {
      throw new LaneConfigValidationError("revision must be a non-negative integer");
    }
  }
  return withLaneConfigLock(env, () => {
    const cpath = configPath(env);
    const current = readPersistedDoc(cpath, roleLanes);
    if (current.unusablePath) {
      throw new LockUnavailableError(current.error || "Lane config path is not a usable regular file");
    }
    const curRev = current.revision;
    if (
      expectedRevision !== undefined
      && expectedRevision !== null
      && expectedRevision !== curRev
    ) {
      throw new RevisionConflictError(
        `Revision conflict: expected revision ${expectedRevision}, current revision is ${curRev}. Refresh lane settings and try again.`,
        curRev,
      );
    }
    const defaults = getDefaultConfig(roleLanes);
    const actor = updatedBy ? sanitizeLine(updatedBy, 64) : null;
    atomicWriteConfig(cpath, {
      schemaVersion: SCHEMA_VERSION,
      revision: curRev + 1,
      updatedAt: Date.now() / 1000,
      updatedBy: actor,
      isDefault: true,
      render: defaults.render,
      models: defaults.models,
    });
    return getLanesState(env, roleLanes);
  });
}

export function putLanesState(
  payload: unknown,
  updatedBy?: string | null,
  env?: Env,
  roleLanes?: RoleLanes | null,
): LanesState {
  const parsed = validateConfigPayload(payload, roleLanes, env);
  if (parsed.mode === "reset") {
    return resetLanesState(parsed.revision, updatedBy, env, roleLanes);
  }
  const expectedRev = parsed.revision;
  const validated = parsed.config;
  return withLaneConfigLock(env, () => {
    const cpath = configPath(env);
    const current = readPersistedDoc(cpath, roleLanes, env);
    if (current.unusablePath) {
      throw new LockUnavailableError(current.error || "Lane config path is not a usable regular file");
    }
    if (expectedRev !== current.revision) {
      throw new RevisionConflictError(
        `Revision conflict: expected revision ${expectedRev}, current revision is ${current.revision}. Refresh lane settings and try again.`,
        current.revision,
      );
    }
    const defaults = getDefaultConfig(roleLanes);
    const isDefault = deepEqual(validated.render, defaults.render) && deepEqual(validated.models, defaults.models);
    const actor = updatedBy ? sanitizeLine(updatedBy, 64) : null;
    atomicWriteConfig(cpath, {
      schemaVersion: SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: Date.now() / 1000,
      updatedBy: actor,
      isDefault,
      render: validated.render,
      models: validated.models,
    });
    return getLanesState(env, roleLanes);
  });
}

/** Roadmap name for putLanesState. */
export const updateLanesState = putLanesState;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usageText(): string {
  return [
    "usage: laneConfig.ts <command> [options]",
    "",
    "commands:",
    "  get [--json]",
    "  catalog [--json]",
    "  set --payload-json <json> [--updated-by <name>] [--json]",
    "  reset [--revision <n>] [--updated-by <name>] [--json]",
  ].join("\n");
}

function takeValue(argv: string[], idx: number, flag: string): string {
  const cur = argv[idx] ?? "";
  if (cur.includes("=")) return cur.slice(cur.indexOf("=") + 1);
  const next = argv[idx + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return next;
}

function parseCli(argv: string[]): {
  cmd: string;
  json: boolean;
  payloadJson?: string;
  updatedBy: string;
  revision?: string;
} {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") throw new UsageError(usageText());
  if (!["get", "catalog", "set", "reset"].includes(cmd)) {
    throw new UsageError(`unknown command ${cmd}\n${usageText()}`);
  }
  let json = false;
  let payloadJson: string | undefined;
  let updatedBy = "";
  let revision: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--payload-json" || arg.startsWith("--payload-json=")) {
      payloadJson = takeValue(argv, i, "--payload-json");
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--updated-by" || arg.startsWith("--updated-by=")) {
      updatedBy = takeValue(argv, i, "--updated-by");
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--revision" || arg.startsWith("--revision=")) {
      revision = takeValue(argv, i, "--revision");
      if (!arg.includes("=")) i += 1;
      continue;
    }
    throw new UsageError(`unrecognized argument ${arg}\n${usageText()}`);
  }
  if (cmd === "set" && payloadJson === undefined) {
    throw new UsageError(`set requires --payload-json\n${usageText()}`);
  }
  return { cmd, json, payloadJson, updatedBy, revision };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseCli(argv);
    let out: unknown;
    if (args.cmd === "get") {
      out = getLanesState();
    } else if (args.cmd === "catalog") {
      out = {
        schemaVersion: SCHEMA_VERSION,
        catalog: getCatalog(),
        defaults: getDefaultConfig(),
      };
    } else if (args.cmd === "set") {
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(args.payloadJson ?? "");
      } catch (err) {
        throw new LaneConfigValidationError("Invalid JSON request body");
      }
      out = putLanesState(rawPayload, args.updatedBy || null);
    } else if (args.cmd === "reset") {
      let expRev: number | null = null;
      if (args.revision !== undefined && args.revision.trim() !== "") {
        const rawRev = args.revision.trim();
        if (!/^\d+$/.test(rawRev)) {
          throw new LaneConfigValidationError("revision must be a non-negative integer");
        }
        expRev = Number(rawRev);
      }
      out = resetLanesState(expRev, args.updatedBy || null);
    } else {
      throw new LaneConfigValidationError(`Unsupported command: ${args.cmd}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof LaneConfigError) {
      const body: Record<string, unknown> = {
        error: sanitizeLine(err.message),
        statusCode: err.statusCode,
        code: err.code,
      };
      if (err instanceof RevisionConflictError && err.currentRevision !== null) {
        body.currentRevision = err.currentRevision;
      }
      process.stdout.write(`${JSON.stringify(body)}\n`);
      if (err.statusCode === 409) return 3;
      if (err.statusCode === 503) return 5;
      return 2;
    }
    const name = err instanceof Error ? err.name : "Error";
    process.stdout.write(`${JSON.stringify({
      error: sanitizeLine(`Lane configuration failure (${name})`),
      statusCode: 500,
      code: "internal_error",
    })}\n`);
    return 1;
  }
}

function ranDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

if (ranDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
