import type { RenderNodeKind } from "@/lib/api";

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
    workerLabel: "Global policy",
    groupLabel: "Auto",
    subtitle: "Follows global lane policy",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 1,
    defaultIdPrefix: "inherit",
  },
  local: {
    kind: "local",
    label: "Local",
    shortLabel: "Local",
    workerLabel: "Local render worker",
    groupLabel: "Local",
    subtitle: "Local host",
    minSlots: 1,
    maxSlots: 4,
    defaultSlots: 1,
    defaultIdPrefix: "local",
  },
  "docker-sbx": {
    kind: "docker-sbx",
    label: "Docker Cloud Sandbox",
    shortLabel: "Cloud Sandbox",
    workerLabel: "Docker cloud sandbox",
    groupLabel: "Docker sandbox",
    subtitle: "Docker Cloud Sandbox",
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
    label: "Remote SSH",
    shortLabel: "Remote SSH",
    workerLabel: "SSH render worker",
    groupLabel: "SSH workers",
    subtitle: "Remote SSH node",
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
    label: "Custom Render Node",
    shortLabel: "Custom",
    workerLabel: "Custom render worker",
    groupLabel: "Custom workers",
    subtitle: "Custom render node",
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

export function formatRenderNodeSubtitle(node: {
  kind?: string;
  box?: string;
  user?: string;
  host?: string;
}): string {
  const resolved = inferLaneKind(undefined, node.kind);
  if (resolved === "docker-sbx") return `Docker Cloud Sandbox · ${node.box || "no box"}`;
  if (resolved === "ssh") return `${node.user || "user"}@${node.host || "host"}`;
  if (resolved === "local") return "Local host";
  return node.kind ? `Custom (${node.kind})` : RENDER_KIND_META.custom.subtitle;
}
