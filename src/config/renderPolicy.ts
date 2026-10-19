/**
 * Render lane selection policy.
 *
 * Turns the persisted render array into a runtime plan once per process and
 * answers which lanes are eligible, how much real concurrency each has, and
 * which lane a chapter should use first.
 *
 * No credentials, hosts, commands, or endpoints. A plan is lane ids, bounded
 * integers, and booleans. Laptop/cloud health probes are injectable. Until
 * lappy/cloudlane are wired, availability falls back to env configuration.
 */
import path from "node:path";
import {
  RENDER_CATALOG_BY_ID,
  RENDER_TRANSPORT_SLOT_CAP,
  customRenderCatalog,
  customRenderSlotCap,
  getLanesState,
  renderCatalogById,
  renderRuntimeContract,
  type Env,
  type LaneConfig,
} from "./laneConfig.js";
import { REPO_ROOT, getRegisteredNodes } from "../workers/nodeRegistry.js";

export const RENDER_LANE_ENV = "MANHWA_RENDER_LANE";
export const OVERRIDE_INHERIT = "inherit";
export const OVERRIDE_MODES = ["inherit", "local", "laptop", "cloud"] as const;
export const OVERRIDE_LANES = ["local", "laptop", "cloud"] as const;

/**
 * Extra lane ids registered at runtime (`nodeRegistry`): custom `docker-sbx`,
 * `ssh`, or additional `local` nodes. They are valid selectors; the built-in
 * three keep their static catalog entry.
 */
export function customNodeLaneIds(outDir?: string): string[] {
  const ids: string[] = [];
  try {
    for (const node of getRegisteredNodes(outDir)) {
      const id = String(node.id);
      if (id && !(OVERRIDE_LANES as readonly string[]).includes(id)) ids.push(id);
    }
  } catch {
    // registry unreadable: fall through to the persisted-node catalog
  }
  try {
    for (const entry of customRenderCatalog(outDir)) {
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
  } catch {
    // catalog unreadable: keep what the registry gave us
  }
  return ids;
}

function matchCustomNodeId(value: string, outDir?: string): string | null {
  for (const id of customNodeLaneIds(outDir ?? studioOutDirFromEnv())) {
    if (id.toLowerCase() === value) return id;
  }
  return null;
}

/** "0" forces the legacy plan even when a persisted config is valid. */
export const PLAN_SNAPSHOT_ENV = "MANHWA_RENDER_PLAN_SNAPSHOT";

export const SOURCE_LEGACY = "legacy";
export const SOURCE_PERSISTED = "persisted";

export const UNAVAILABLE_GRACE_ENV = "MANHWA_RENDER_UNAVAILABLE_GRACE_S";
export const DEFAULT_UNAVAILABLE_GRACE_S = 600;

export const RENDER_TRANSPORT_ENV: Record<string, string> = {
  laptop: "MANHWA_RENDER_REMOTE",
  cloud: "MANHWA_RENDER_CLOUD",
};

export class RenderOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderOverrideError";
  }
}

export type HealthResult = [ok: boolean, reason: string];

export interface HealthProbes {
  laptop?: () => HealthResult;
  cloud?: () => HealthResult;
}

export interface TransportDefaults {
  /** Stand-in for lappy.HOST when the env key is absent. */
  laptopHost?: string;
  /** Stand-in for cloudlane.NAME when the env key is absent. */
  cloudName?: string;
  cloudMaxSlots?: number;
  localMaxSlots?: number;
}

export interface PlanLane {
  id: string;
  order: number;
  enabled: boolean;
  configured: boolean;
  slots: number;
  effectiveSlots: number;
  minSlots: number;
  maxSlots: number;
  costTier: string;
  source?: string;
}

export interface RenderPlan {
  source: string;
  legacy: boolean;
  revision: number;
  configError: string | null;
  override: string | null;
  unavailableGraceS: number;
  lanes: PlanLane[];
}

export interface RenderPolicySemantics {
  persistedRenderPolicy: boolean;
  envRenderSwitches: Record<string, boolean>;
  envEnabledButDisabled: string[];
  note: string;
}

const UNSET = Symbol("unset");

const importHost = String(process.env.MANHWA_RENDER_REMOTE ?? "").trim();
const importCloud = String(process.env.MANHWA_RENDER_CLOUD ?? "").trim();

const transportDefaults = {
  laptopHost: importHost,
  cloudName: importCloud,
  cloudMaxSlots: 2,
  localMaxSlots: 1,
};

let transportDefaultsExplicit = false;

let healthProbes: HealthProbes = {};

/** Replace module-level transport constants (the lappy.HOST / cloudlane.NAME stand-in). */
export function setTransportDefaults(next: TransportDefaults | null): void {
  if (!next) {
    transportDefaultsExplicit = false;
    transportDefaults.laptopHost = importHost;
    transportDefaults.cloudName = importCloud;
    transportDefaults.cloudMaxSlots = 2;
    transportDefaults.localMaxSlots = 1;
    return;
  }
  transportDefaultsExplicit = true;
  if (next.laptopHost !== undefined) transportDefaults.laptopHost = next.laptopHost;
  if (next.cloudName !== undefined) transportDefaults.cloudName = next.cloudName;
  if (next.cloudMaxSlots !== undefined) transportDefaults.cloudMaxSlots = next.cloudMaxSlots;
  if (next.localMaxSlots !== undefined) transportDefaults.localMaxSlots = next.localMaxSlots;
}

/** Register laptop/cloud health callbacks. null clears them. */
export function setHealthProbes(next: HealthProbes | null): void {
  healthProbes = next ? { ...next } : {};
}

function resolveEnv(env?: Env): Env {
  return env ?? process.env;
}

function graceSeconds(env?: Env): number {
  const raw = resolveEnv(env)[UNAVAILABLE_GRACE_ENV];
  const val = Number(raw || DEFAULT_UNAVAILABLE_GRACE_S);
  if (!Number.isFinite(val)) return DEFAULT_UNAVAILABLE_GRACE_S;
  return Math.max(0, val);
}

function laneEntry(
  lid: string,
  enabled: boolean,
  slots: number,
  order: number,
  source: string,
  configured = true,
  outDir?: string,
): PlanLane {
  const cat = RENDER_CATALOG_BY_ID[lid] ?? renderCatalogById(outDir)[lid];
  if (!cat) {
    throw new RenderOverrideError(`unknown render lane ${lid}`);
  }
  const cap = RENDER_TRANSPORT_SLOT_CAP[lid] ?? customRenderSlotCap(cat.kind);
  const advertised = Number.isFinite(slots) ? Math.trunc(slots) : cat.defaultSlots;
  return {
    id: lid,
    order,
    enabled: Boolean(enabled),
    configured: Boolean(configured),
    slots: advertised,
    effectiveSlots: Math.max(1, Math.min(advertised, Number(cap))),
    minSlots: cat.minSlots,
    maxSlots: cat.maxSlots,
    costTier: cat.costTier,
    source,
  };
}

function transportSwitch(env: Env, key: string, fallback: string): string {
  if (Object.hasOwn(env, key)) return String(env[key] ?? "").trim();
  return String(fallback ?? "").trim();
}

/** Is the transport for that lane actually configured? */
export function transportConfiguration(env?: Env): Record<string, boolean> {
  const resolved = resolveEnv(env);
  return {
    laptop: Boolean(transportSwitch(resolved, "MANHWA_RENDER_REMOTE", transportDefaults.laptopHost)),
    cloud: Boolean(transportSwitch(resolved, "MANHWA_RENDER_CLOUD", transportDefaults.cloudName)),
    local: true,
  };
}

/**
 * Registered custom render nodes as legacy plan lanes. A custom node is
 * configured by definition (its presence in `render-nodes.json` is the
 * enable switch), so only its own `enabled` flag decides.
 */
function legacyCustomLanes(env?: Env, startOrder = 0): PlanLane[] {
  let catalog: ReturnType<typeof customRenderCatalog> = [];
  try {
    catalog = customRenderCatalog(studioOutDirFromEnv(env));
  } catch {
    return [];
  }
  const dir = studioOutDirFromEnv(env);
  return catalog.map((entry, idx) =>
    laneEntry(
      entry.id,
      entry.defaultEnabled,
      entry.defaultSlots,
      startOrder + idx,
      "legacy",
      true,
      dir,
    ),
  );
}

function stripTrailingConfigDir(value: string): string {
  const resolved = path.resolve(value);
  return path.basename(resolved) === "config" ? path.dirname(resolved) : resolved;
}

function studioOutDirFromEnv(env?: Env): string | undefined {
  const e = env ?? process.env;
  const out = String(e.MANHWA_OUT_DIR ?? "").trim() || String(e.PIPELINE_OUT_DIR ?? "").trim();
  if (out) return out;
  const laneCfgDir = String(e.MANHWA_LANE_CONFIG_DIR ?? "").trim();
  if (laneCfgDir) return stripTrailingConfigDir(laneCfgDir);
  const laneCfg = String(e.MANHWA_LANE_CONFIG ?? "").trim();
  if (laneCfg) return stripTrailingConfigDir(path.dirname(path.resolve(laneCfg)));
  const jobsDir = String(e.MANHWA_JOBS_DIR ?? "").trim();
  if (jobsDir) return path.dirname(path.resolve(jobsDir));
  if (String(process.env.VITEST ?? "").trim()) {
    return path.join(REPO_ROOT, "out", ".vitest-empty");
  }
  return undefined;
}

/** Lanes today's env-driven scheduler can use, in today's preference order. */
export function legacyLaneList(env?: Env): PlanLane[] {
  const configured = transportConfiguration(env);
  return [
    laneEntry("laptop", configured.laptop, 1, 0, "legacy", configured.laptop),
    laneEntry(
      "cloud",
      configured.cloud,
      transportDefaults.cloudMaxSlots,
      1,
      "legacy",
      configured.cloud,
    ),
    laneEntry("local", true, transportDefaults.localMaxSlots, 2, "legacy"),
    ...legacyCustomLanes(env, 3),
  ];
}

function withConfiguration(lanes: Array<Omit<PlanLane, "configured"> & { configured?: boolean }>, env: Env): PlanLane[] {
  const configured = transportConfiguration(env);
  return lanes.map((lane) => ({
    ...lane,
    // A custom node is configured by definition; its registry entry is the switch.
    configured: Boolean(configured[lane.id] ?? true),
  }));
}

function lanesFromState(state: { source?: string; config?: { render?: unknown[] } | null }, env: Env): PlanLane[] {
  if (state.source !== SOURCE_PERSISTED) return legacyLaneList(env);
  const contract = renderRuntimeContract(state.config?.render, studioOutDirFromEnv(env));
  return withConfiguration(contract, env);
}

/** Render lanes a real run would use. No override parsing, no probes. */
export function renderLanes(env?: Env): PlanLane[] {
  const resolved = resolveEnv(env);
  if ((resolved[PLAN_SNAPSHOT_ENV] ?? "1") === "0") return legacyLaneList(resolved);
  try {
    return lanesFromState(getLanesState(resolved), resolved);
  } catch {
    return legacyLaneList(resolved);
  }
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("'") && !value.includes('"')) return `"${value}"`;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return String(value);
}

/**
 * Validate a per-run override against a lane list.
 * Returns the pinned lane id, or null for inherit.
 */
export function parseRenderOverride(
  raw: unknown,
  lanes: ReadonlyArray<{ id: string; enabled?: boolean }>,
  outDir?: string,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new RenderOverrideError(`render lane override must be one of: ${OVERRIDE_MODES.join(", ")}`);
  }
  const value = raw.trim().toLowerCase();
  if (value === "" || value === OVERRIDE_INHERIT) return null;
  const enabled = new Set(lanes.filter((lane) => lane.enabled).map((lane) => lane.id));
  const known = new Set(lanes.map((lane) => lane.id));
  let target: string;
  if ((OVERRIDE_LANES as readonly string[]).includes(value)) {
    target = value;
  } else {
    const custom = matchCustomNodeId(value, outDir);
    if (!custom) {
      throw new RenderOverrideError(
        `unknown render lane override ${pyRepr(raw)} (allowed: ${OVERRIDE_MODES.join(", ")})`,
      );
    }
    target = custom;
  }
  if (!enabled.has(target)) {
    const why = known.has(target) ? "disabled by the current lane config" : "not configured on this host";
    throw new RenderOverrideError(
      `render lane ${pyRepr(target)} is ${why}; a pinned lane must be configured and enabled`,
    );
  }
  return target;
}

/** Canonical persisted form of an override. Does not check the current plan. */
export function normalizeRenderOverride(raw: unknown): string {
  if (raw === null || raw === undefined) return OVERRIDE_INHERIT;
  if (typeof raw !== "string") {
    throw new RenderOverrideError(`render lane override must be one of: ${OVERRIDE_MODES.join(", ")}`);
  }
  const value = raw.trim().toLowerCase();
  if (value === "" || value === OVERRIDE_INHERIT) return OVERRIDE_INHERIT;
  if (!(OVERRIDE_LANES as readonly string[]).includes(value)) {
    const custom = matchCustomNodeId(value);
    if (custom) return custom;
    throw new RenderOverrideError(
      `unknown render lane override ${pyRepr(raw)} (allowed: ${OVERRIDE_MODES.join(", ")})`,
    );
  }
  return value;
}

/** Canonicalize a per-job selector. inherit|local|laptop|cloud or a registered node id. */
export function normalizeRenderLane(raw: unknown): string {
  if (raw === null || raw === undefined) return OVERRIDE_INHERIT;
  if (typeof raw !== "string") {
    throw new RenderOverrideError(`render lane must be one of: ${OVERRIDE_MODES.join(", ")}`);
  }
  const value = raw.trim().toLowerCase();
  if (value === "" || value === OVERRIDE_INHERIT) return OVERRIDE_INHERIT;
  if (!(OVERRIDE_LANES as readonly string[]).includes(value)) {
    const custom = matchCustomNodeId(value);
    if (custom) return custom;
    throw new RenderOverrideError(
      `unknown render lane ${pyRepr(raw)} (allowed: ${OVERRIDE_MODES.join(", ")})`,
    );
  }
  return value;
}

/** Validate a normalized selector against current server lanes. Never probes. */
export function checkRenderLaneAvailable(selector: unknown, env?: Env): string {
  const normalized = normalizeRenderLane(selector);
  if (normalized === OVERRIDE_INHERIT) return normalized;
  if (!(OVERRIDE_LANES as readonly string[]).includes(normalized)) {
    // A registered custom node is configured by definition; its registry entry
    // and an explicit persisted lane row (`enabled: false`) both decide.
    const records = getRegisteredNodes(studioOutDirFromEnv(env));
    const node =
      records.find((item) => item.id === normalized) ??
      records.find((item) => item.id.toLowerCase() === normalized);
    if (!node) {
      throw new RenderOverrideError(
        `render lane ${pyRepr(normalized)} is not configured on this host`,
      );
    }
    if (node.enabled === false) {
      throw new RenderOverrideError(
        `render lane ${pyRepr(normalized)} is disabled by the current lane configuration`,
      );
    }
    const lanes = renderLanes(env);
    const match = lanes.find((lane) => lane.id === normalized);
    if (match && !match.enabled) {
      throw new RenderOverrideError(
        `render lane ${pyRepr(normalized)} is disabled by the current lane configuration`,
      );
    }
    return normalized;
  }
  const lanes = renderLanes(env);
  const match = lanes.find((lane) => lane.id === normalized);
  if (!match || !match.configured) {
    throw new RenderOverrideError(`render lane ${pyRepr(normalized)} is not configured on this host`);
  }
  if (!match.enabled) {
    throw new RenderOverrideError(
      `render lane ${pyRepr(normalized)} is disabled by the current lane configuration`,
    );
  }
  return normalized;
}

function laneLabel(lid: string, outDir?: string): string {
  return String(RENDER_CATALOG_BY_ID[lid]?.label || renderCatalogById(outDir)[lid]?.label || lid);
}

export interface RenderOverrideOption {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  pinned: boolean;
  costTier?: string;
}

/** Catalog options for a per-job render lane picker. Never probes the network. */
export function renderOverrideOptions(env?: Env): RenderOverrideOption[] {
  const lanes = renderLanes(env);
  const byId = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));
  const anyUsable = lanes.some((lane) => lane.enabled && lane.configured);
  const options: RenderOverrideOption[] = [{
    id: OVERRIDE_INHERIT,
    label: "Inherit global render policy",
    available: anyUsable,
    unavailableReason: anyUsable ? null : "no enabled render lane is configured on this server",
    pinned: false,
  }];
  for (const lid of OVERRIDE_LANES) {
    const lane = byId[lid];
    let available: boolean;
    let reason: string | null;
    if (!lane) {
      available = false;
      reason = "not part of the current render plan";
    } else if (!lane.configured) {
      available = false;
      reason = "transport is not configured on this server";
    } else if (!lane.enabled) {
      available = false;
      reason = "disabled by the global render policy";
    } else {
      available = true;
      reason = null;
    }
    options.push({
      id: lid,
      label: laneLabel(lid),
      available,
      unavailableReason: reason,
      pinned: true,
      costTier: lane?.costTier ?? RENDER_CATALOG_BY_ID[lid]?.costTier,
    });
  }
  for (const node of getRegisteredNodes(studioOutDirFromEnv(env))) {
    const id = String(node.id);
    if ((OVERRIDE_LANES as readonly string[]).includes(id)) continue;
    const disabled = node.enabled === false;
    options.push({
      id,
      label: String(node.label || id),
      available: !disabled,
      unavailableReason: disabled ? "disabled in render-nodes.json" : null,
      pinned: true,
      costTier: node.kind === "docker-sbx" ? "paid-opt-in" : "free",
    });
  }
  return options;
}

/** Is that lane's transport switch SET in this environment? Local has no switch. */
export function renderEnvSwitches(env?: Env): Record<string, boolean> {
  const resolved = resolveEnv(env);
  const out: Record<string, boolean> = {};
  for (const [lid, key] of Object.entries(RENDER_TRANSPORT_ENV)) {
    out[lid] = Boolean(String(resolved[key] ?? "").trim());
  }
  return out;
}

/**
 * What the persisted render policy does to env-set lanes.
 * A valid persisted config is authoritative. Nothing here enables a lane.
 */
export function renderPolicySemantics(
  activeCfg: Pick<LaneConfig, "render"> | null | undefined,
  env?: Env,
  source?: string | null,
): RenderPolicySemantics {
  const resolved = resolveEnv(env);
  const lanes = renderRuntimeContract(activeCfg?.render);
  const switches = renderEnvSwitches(resolved);
  const persisted = source === SOURCE_PERSISTED;
  const disabledButEnvSet = persisted
    ? lanes.filter((lane) => !lane.enabled && switches[lane.id]).map((lane) => lane.id)
    : [];
  return {
    persistedRenderPolicy: persisted,
    envRenderSwitches: switches,
    envEnabledButDisabled: disabledButEnvSet,
    note: persisted
      ? "Every save persists the render array it is sent. A model-only save that echoes the defaults therefore disables any lane the environment configures (for example MANHWA_RENDER_CLOUD) until render is edited explicitly. Disabling is never silent: envEnabledButDisabled lists the affected lanes. No lane is ever enabled on the operator's behalf."
      : "No valid persisted render config exists, so the legacy environment switches decide render lanes and nothing is being overridden.",
  };
}

export function buildRenderPlan(env?: Env, override: unknown = UNSET): RenderPlan {
  const resolved = resolveEnv(env);
  const explicitOverride = arguments.length >= 2;
  let state: { source?: string; revision?: number; configError?: string | null; config?: { render?: unknown[] } | null };
  if ((resolved[PLAN_SNAPSHOT_ENV] ?? "1") === "0") {
    state = { source: SOURCE_LEGACY, revision: 0, configError: null };
  } else {
    try {
      state = getLanesState(resolved);
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      state = { source: SOURCE_LEGACY, revision: 0, configError: name };
    }
  }
  const lanes = lanesFromState(state, resolved);
  const legacy = state.source !== SOURCE_PERSISTED;
  const raw = explicitOverride ? override : resolved[RENDER_LANE_ENV];
  const pinned = parseRenderOverride(raw, lanes, studioOutDirFromEnv(resolved));
  return {
    source: legacy ? SOURCE_LEGACY : SOURCE_PERSISTED,
    legacy,
    revision: state.revision ?? 0,
    configError: state.configError ?? null,
    override: pinned,
    unavailableGraceS: graceSeconds(resolved),
    lanes,
  };
}

const planCache: { loaded: boolean; plan: RenderPlan | null } = { loaded: false, plan: null };

/** Process/run render plan, resolved once and cached. */
export function resolveRenderPlan(env?: Env, override: unknown = UNSET): RenderPlan {
  const hasOverride = arguments.length >= 2;
  if (!planCache.loaded || !planCache.plan) {
    planCache.plan = buildRenderPlan(env, ...(hasOverride ? [override] as [unknown] : []));
    planCache.loaded = true;
    return structuredClone(planCache.plan);
  }
  if (hasOverride) {
    // A cached plan must never silently ignore a caller's explicit override.
    const plan = structuredClone(planCache.plan);
    plan.override = parseRenderOverride(override, plan.lanes ?? [], studioOutDirFromEnv(env));
    return plan;
  }
  return structuredClone(planCache.plan);
}

/** Test-only: forget the cached plan so the next call re-resolves it. */
export function resetRenderPlan(): void {
  planCache.loaded = false;
  planCache.plan = null;
}

/** Enabled lanes in persisted order. A pinned override narrows this to one. */
export function eligibleLanes(plan: { lanes?: ReadonlyArray<PlanLane> | null; override?: string | null }): PlanLane[] {
  const lanes = (plan.lanes ?? []).filter((lane) => lane.enabled);
  const pinned = plan.override;
  if (pinned) return lanes.filter((lane) => lane.id === pinned);
  return lanes;
}

function configuredHost(kind: "laptop" | "cloud", lane?: PlanLane): string {
  if (kind === "laptop") {
    const def = String(transportDefaults.laptopHost ?? "").trim();
    if (def) return def;
    if (transportDefaultsExplicit) return "";
    const envVal = String(process.env.MANHWA_RENDER_REMOTE ?? "").trim();
    if (envVal) return envVal;
    return lane?.configured ? "configured" : "";
  }
  const def = String(transportDefaults.cloudName ?? "").trim();
  if (def) return def;
  if (transportDefaultsExplicit) return "";
  const envVal = String(process.env.MANHWA_RENDER_CLOUD ?? "").trim();
  if (envVal) return envVal;
  return lane?.configured ? "configured" : "";
}

/**
 * Availability of every eligible lane.
 * Local is always available. Laptop and cloud use injected probes when set,
 * otherwise the env/module transport configuration (no network).
 */
export function laneAvailability(
  plan: { lanes?: ReadonlyArray<PlanLane> | null; override?: string | null },
  probes?: HealthProbes,
): Record<string, HealthResult> {
  const use = probes ?? healthProbes;
  const out: Record<string, HealthResult> = {};
  for (const lane of eligibleLanes(plan)) {
    const lid = lane.id;
    if (lid === "laptop") {
      if (!configuredHost("laptop", lane)) out[lid] = [false, "no remote configured"];
      else if (use.laptop) out[lid] = use.laptop();
      else out[lid] = [true, "configured"];
    } else if (lid === "cloud") {
      if (!configuredHost("cloud", lane)) out[lid] = [false, "no cloud configured"];
      else if (use.cloud) out[lid] = use.cloud();
      else out[lid] = [true, "configured"];
    } else {
      out[lid] = [true, "local"];
    }
  }
  return out;
}

/**
 * First eligible lane that is available and has a free slot, or null.
 * `busy` maps lane id to in-flight count. A lane is full when busy >= effectiveSlots.
 */
export function selectRenderLane(
  plan: { lanes?: ReadonlyArray<PlanLane> | null; override?: string | null },
  availability?: Record<string, HealthResult> | null,
  busy?: Record<string, number> | null,
): string | null {
  const avail = availability ?? laneAvailability(plan);
  const inflight = busy ?? {};
  for (const lane of eligibleLanes(plan)) {
    const [ok] = avail[lane.id] ?? [false, "unknown"];
    if (ok && (inflight[lane.id] ?? 0) < lane.effectiveSlots) return lane.id;
  }
  return null;
}

/** Alias kept for callers that still say selectLane. */
export const selectLane = selectRenderLane;

/** Lanes a chapter may overflow to after `lane`. A pin has no chain. */
export function fallbackChain(
  plan: { lanes?: ReadonlyArray<PlanLane> | null; override?: string | null },
  lane: string,
): PlanLane[] {
  const lanes = eligibleLanes(plan);
  const ids = lanes.map((item) => item.id);
  const idx = ids.indexOf(lane);
  if (idx < 0) return [];
  return lanes.slice(idx);
}

export interface PlanStatus {
  source: string;
  legacy: boolean;
  revision: number;
  configError: string | null;
  override: string | null;
  order: string[];
  lanes: Array<{
    id: string;
    order: number;
    enabled: boolean;
    slots: number;
    effectiveSlots: number;
    costTier: string;
  }>;
}

/** Serializable summary. No secrets, no probes. */
export function planStatus(plan?: RenderPlan | null): PlanStatus {
  const resolved = plan ?? resolveRenderPlan();
  return {
    source: resolved.source,
    legacy: resolved.legacy,
    revision: resolved.revision,
    configError: resolved.configError,
    override: resolved.override,
    order: eligibleLanes(resolved).map((lane) => lane.id),
    lanes: (resolved.lanes ?? []).map((lane) => ({
      id: lane.id,
      order: lane.order,
      enabled: lane.enabled,
      slots: lane.slots,
      effectiveSlots: lane.effectiveSlots,
      costTier: lane.costTier,
    })),
  };
}
