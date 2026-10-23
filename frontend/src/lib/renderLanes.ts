export type RenderNodeKind = "local" | "docker-sbx" | "ssh";

export const BOX_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const LANE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const DEFAULT_LANE_ID = "inherit";
export const DEFAULT_SANDBOX_TEMPLATE = "";
export const DEFAULT_SANDBOX_MAX_HOURS = 5;
export const DEFAULT_SANDBOX_IDLE_PAUSE_S = 300;
export const DEFAULT_SSH_USER = "ubuntu";
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_REMOTE_DIR = "/tmp/manhwa-worker";

export const RENDER_NODE_KINDS: readonly RenderNodeKind[] = ["local", "docker-sbx", "ssh"] as const;

export type RenderLaneKind = "inherit" | RenderNodeKind | "custom";

export interface RenderKindMetadata {
  kind: RenderLaneKind;
  label: string;
  shortLabel: string;
  workerLabel: string;
  groupLabel: string;
  subtitle: string;
  minSlots: number;
  maxSlots: number;
  defaultSlots: number;
  defaultIdPrefix: string;
  defaultTemplate?: string;
  defaultMaxHours?: number;
  defaultIdlePauseS?: number;
  defaultUser?: string;
  defaultPort?: number;
  defaultRemoteDir?: string;
}

export const RENDER_KIND_META: Record<RenderLaneKind, RenderKindMetadata> = {
  inherit: {
    kind: "inherit",
    label: "Auto",
    shortLabel: "Auto",
    workerLabel: "Auto",
    groupLabel: "Auto",
    subtitle: "Follows lane policy",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 1,
    defaultIdPrefix: "inherit",
  },
  local: {
    kind: "local",
    label: "Local",
    shortLabel: "Local",
    workerLabel: "Local",
    groupLabel: "Local",
    subtitle: "Local host",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 1,
    defaultIdPrefix: "local",
  },
  "docker-sbx": {
    kind: "docker-sbx",
    label: "Sandbox",
    shortLabel: "Sandbox",
    workerLabel: "Sandbox",
    groupLabel: "Sandbox",
    subtitle: "Cloud sandbox",
    minSlots: 1,
    maxSlots: 2,
    defaultSlots: 2,
    defaultIdPrefix: "sbx-1",
    defaultTemplate: DEFAULT_SANDBOX_TEMPLATE,
    defaultMaxHours: DEFAULT_SANDBOX_MAX_HOURS,
    defaultIdlePauseS: DEFAULT_SANDBOX_IDLE_PAUSE_S,
  },
  ssh: {
    kind: "ssh",
    label: "SSH",
    shortLabel: "SSH",
    workerLabel: "SSH",
    groupLabel: "SSH",
    subtitle: "SSH worker",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 2,
    defaultIdPrefix: "ssh-1",
    defaultUser: DEFAULT_SSH_USER,
    defaultPort: DEFAULT_SSH_PORT,
    defaultRemoteDir: DEFAULT_SSH_REMOTE_DIR,
  },
  custom: {
    kind: "custom",
    label: "Custom",
    shortLabel: "Custom",
    workerLabel: "Custom",
    groupLabel: "Custom",
    subtitle: "Custom worker",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 2,
    defaultIdPrefix: "node-1",
  },
};

export function inferRenderKind(id?: string, nodeKind?: string): RenderNodeKind {
  const kind = String(nodeKind || "").trim().toLowerCase();
  const normId = String(id || "").trim().toLowerCase();
  if (kind === "local" || normId === "local") return "local";
  if (
    kind === "docker-sbx" ||
    kind === "cloud" ||
    kind === "sbx" ||
    normId === "cloud" ||
    normId.includes("sbx") ||
    kind.includes("sbx")
  ) {
    return "docker-sbx";
  }
  if (kind === "ssh" || kind === "remote" || normId === "laptop") return "ssh";
  return "ssh";
}

export function inferLaneKind(id?: string, nodeKind?: string): RenderLaneKind {
  const normId = String(id || "").trim().toLowerCase();
  if (normId === DEFAULT_LANE_ID) return "inherit";
  const kind = String(nodeKind || "").trim().toLowerCase();
  if (kind && !["local", "docker-sbx", "cloud", "sbx", "ssh", "remote"].includes(kind) && !kind.includes("sbx")) {
    return "custom";
  }
  return inferRenderKind(id, nodeKind);
}

export function getRenderKindMeta(kind?: string, id?: string): RenderKindMetadata {
  const resolved = inferLaneKind(id, kind);
  return RENDER_KIND_META[resolved] ?? RENDER_KIND_META.custom;
}

export function maxSlotsForKind(kind?: string): number {
  return inferRenderKind(undefined, kind) === "docker-sbx" ? 2 : 4;
}

export function clampSlotsForKind(kind: string | undefined, slots: number): number {
  const max = maxSlotsForKind(kind);
  return Math.max(1, Math.min(max, Math.trunc(Number(slots)) || 1));
}

export function conciseNodeLabel(label?: string, kind?: string, id?: string): string {
  const meta = getRenderKindMeta(kind, id);
  const trimmed = String(label || "").trim();
  if (!trimmed) return meta.label;
  if (/^(local host worker|local render worker|local host|local)$/i.test(trimmed)) return "Local";
  if (/^(docker cloud sandbox|cloud sandbox|docker sandbox)$/i.test(trimmed)) return "Sandbox";
  if (/^(remote ssh|ssh render worker|ssh workers)$/i.test(trimmed)) return "SSH";
  if (/^(global policy|auto)$/i.test(trimmed)) return "Auto";
  return trimmed;
}

export interface JobRecord {
  notBefore?: number | null;
  autoRetry?: import("./retry").AutoRetry;
  failureDetail?: string | null;
  id: string;
  status?: string;
  paused?: boolean;
  stage?: string;
  title?: string;
  slug?: string;
  error?: string | null;
  actions?: string[];
  controlActions?: string[];
  [key: string]: unknown;
}

export function parseIntakeJob(raw: unknown): JobRecord {
  if (!raw || typeof raw !== "object") {
    return { id: "", paused: false };
  }
  const r = raw as Record<string, unknown>;
  const hasActions = Array.isArray(r.actions);
  const hasControl = Array.isArray(r.controlActions);
  const rawActions = hasActions ? (r.actions as unknown[]).map((a) => String(a)) : [];
  const rawControl = hasControl ? (r.controlActions as unknown[]).map((a) => String(a)) : [];
  const actions = hasActions || hasControl ? Array.from(new Set([...rawActions, ...rawControl])) : undefined;
  const controlActions = hasControl
    ? rawControl
    : hasActions
      ? rawActions.filter((a) => a === "pause" || a === "resume" || a === "stop" || a === "cancel")
      : undefined;
  return {
    ...r,
    id: typeof r.id === "string" ? r.id : String(r.id ?? ""),
    paused: Boolean(r.paused),
    ...(actions !== undefined ? { actions } : {}),
    ...(controlActions !== undefined ? { controlActions } : {}),
  };
}

export interface IntakeLaneOption {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  kind: RenderLaneKind;
}

export interface RenderNodeLike {
  id: string;
  label?: string;
  kind?: RenderNodeKind | string;
  enabled?: boolean;
}

function normalizeLaneIdInternal(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return LANE_ID_RE.test(value) ? value : DEFAULT_LANE_ID;
}

function catalogLaneRowsInternal(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
    );
  }
  return [];
}

function conciseLaneOptionLabelInternal(
  id: string,
  rawLabel: unknown,
  node?: RenderNodeLike,
  rawKind?: string,
): string {
  if (id === DEFAULT_LANE_ID) return "Auto";
  if (node?.label && node.label.trim()) return conciseNodeLabel(node.label, rawKind ?? node.kind, id);
  const str = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (str && !str.includes("(")) return conciseNodeLabel(str, rawKind ?? node?.kind, id);
  return conciseNodeLabel(undefined, rawKind ?? node?.kind, id);
}

export function buildIntakeLanes(
  catalog: { renderLanes?: unknown } | null | undefined,
  nodes: RenderNodeLike[],
  savedDefaultLane?: string,
  selectedLaneId?: string,
): IntakeLaneOption[] {
  const byId = new Map<string, IntakeLaneOption>();
  const normalizedSaved = savedDefaultLane ? normalizeLaneIdInternal(savedDefaultLane) : "";
  const normalizedSelected = selectedLaneId ? normalizeLaneIdInternal(selectedLaneId) : "";

  for (const item of catalogLaneRowsInternal(catalog?.renderLanes)) {
    const id = String(item.id || "").trim().toLowerCase();
    if (!LANE_ID_RE.test(id)) continue;
    const node = nodes.find((entry) => entry.id.trim().toLowerCase() === id);
    const available = id === DEFAULT_LANE_ID ? true : item.available !== false && node?.enabled !== false;
    if (
      (id === "cloud" || id === "laptop") &&
      !available &&
      !node &&
      id !== normalizedSaved &&
      id !== normalizedSelected
    ) {
      continue;
    }
    const kindStr = typeof item.kind === "string" ? item.kind : node?.kind;
    byId.set(id, {
      id,
      label: conciseLaneOptionLabelInternal(id, item.label, node, kindStr),
      available,
      unavailableReason:
        id === DEFAULT_LANE_ID
          ? null
          : typeof item.unavailableReason === "string" && item.unavailableReason
            ? item.unavailableReason
            : node?.enabled === false
              ? "disabled in Studio"
              : null,
      kind: inferLaneKind(id, kindStr),
    });
  }

  for (const node of nodes) {
    const id = node.id.trim().toLowerCase();
    if (!LANE_ID_RE.test(id)) continue;
    const existing = byId.get(id);
    const disabled = node.enabled === false;
    if (existing) {
      byId.set(id, {
        ...existing,
        kind: inferLaneKind(id, node.kind),
        label: conciseNodeLabel(node.label || existing.label, node.kind, id),
        available: existing.available && !disabled,
        unavailableReason: existing.unavailableReason || (disabled ? "disabled in Studio" : null),
      });
    } else {
      byId.set(id, {
        id,
        label: conciseLaneOptionLabelInternal(id, node.label, node, node.kind),
        available: !disabled,
        unavailableReason: disabled ? "disabled in Studio" : null,
        kind: inferLaneKind(id, node.kind),
      });
    }
  }

  for (const pin of [normalizedSaved, normalizedSelected]) {
    if (pin && pin !== DEFAULT_LANE_ID && !byId.has(pin)) {
      byId.set(pin, {
        id: pin,
        label: `${pin} (removed)`,
        available: false,
        unavailableReason: "saved default lane was removed in Studio",
        kind: inferLaneKind(pin),
      });
    }
  }

  if (!byId.has(DEFAULT_LANE_ID)) {
    byId.set(DEFAULT_LANE_ID, {
      id: DEFAULT_LANE_ID,
      label: "Auto",
      available: true,
      unavailableReason: null,
      kind: "inherit",
    });
  }
  const inherit = byId.get(DEFAULT_LANE_ID)!;
  const rest = [...byId.values()].filter((lane) => lane.id !== DEFAULT_LANE_ID);
  return [inherit, ...rest];
}

export function formatRenderNodeSubtitle(node: {
  kind?: string;
  box?: string;
  user?: string;
  host?: string;
}): string {
  const resolved = inferLaneKind(undefined, node.kind);
  if (resolved === "docker-sbx") return node.box ? `Sandbox · ${node.box}` : "Sandbox";
  if (resolved === "ssh") return `${node.user || "user"}@${node.host || "host"}`;
  if (resolved === "local") return "Local host";
  return node.kind ? `Custom (${node.kind})` : RENDER_KIND_META.custom.subtitle;
}
