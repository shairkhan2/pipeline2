import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Cloud, Monitor, Pause, Play, RefreshCw, Server, Square } from "lucide-react";

import { AppShell, navigateClient } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Sortable, SortableHandle, SortableItem } from "@/components/ui/sortable";
import {
  api,
  isApiError,
  isConflict,
  type LaneConfig,
  type LaneControlAction,
  type LanesState,
  type PipelineStatus,
  type RenderNode,
  type StagesState,
} from "@/lib/api";
import { getRenderKindMeta, inferRenderKind, maxSlotsForKind } from "@/lib/renderLanes";
import { cn } from "@/lib/utils";

const STAGES = ["reader", "writer", "check", "audio", "clean", "timeline", "render"] as const;
const STAGE_LABEL: Record<string, string> = {
  reader: "Read",
  writer: "Write",
  check: "Check",
  audio: "Voice",
  clean: "Clean",
  timeline: "Stage",
  render: "Render",
};
const STAGE_LONG: Record<string, string> = {
  reader: "Reading panels",
  writer: "Writing the story",
  check: "Checking the script",
  audio: "Preparing narration",
  clean: "Cleaning artwork",
  timeline: "Building the timeline",
  render: "Rendering video",
};
const KNOWN_STATES = new Set(["running", "busy", "done", "completed", "idle", "queued", "retrying", "failed", "warning", "interrupted", "skipped", "unavailable", "last-seen", "paused", "pending"]);

type StageKey = (typeof STAGES)[number];
type WorkerKind = "local" | "docker-sbx" | "ssh";

interface StageCell {
  state?: string;
  completed?: number | null;
  total?: number | null;
  unit?: string;
  phase?: string;
  startedAt?: number;
  note?: string;
  duration?: number;
  wallSeconds?: number;
  findings?: number;
}

interface ChapterRow {
  stages?: Record<string, StageCell>;
  complete?: boolean;
  findings?: number;
  audioFiles?: number | null;
  artifacts?: { video?: { bytes?: number } };
}

interface ActiveCall {
  provider?: string;
  model?: string;
  role?: string;
  tag?: string;
  chapter?: string;
  attempt?: number;
  startedAt?: number;
  series?: string;
}

interface RecentCall {
  state?: string;
  tag?: string;
  role?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  tokens?: number | null;
  note?: string;
  duration?: number;
  endedAt?: number;
}

interface ActivityEvent {
  at?: number;
  message?: string;
  kind?: string;
}

interface StatusRun {
  id: string;
  title?: string;
  series?: string;
  slug?: string;
  jobId?: string;
  state?: string;
  alive?: boolean;
  pid?: number;
  elapsed?: number;
  completed?: number;
  total?: number;
  video?: boolean;
  captionVersion?: string | number;
  source?: string;
  chapters?: Record<string, ChapterRow>;
  activeCalls?: Record<string, ActiveCall>;
  providers?: Record<string, { coolingUntil?: number }>;
  recentCalls?: RecentCall[];
  events?: ActivityEvent[];
  totals?: { calls?: number };
}

interface WorkerJob {
  chapter?: string;
  series?: string;
  stages?: Array<StageCell & { id?: string }>;
}

interface StatusWorker {
  id: string;
  kind?: string;
  status?: string;
  available?: boolean;
  reason?: string;
  jobs?: WorkerJob[];
  metrics?: { cpus?: number | null; mem_gb?: number | null; disk_gb?: number | null; load?: number | null } | null;
  probedAt?: number;
  lastError?: string | null;
  boxStatus?: string | null;
  slots?: number;
  supportsCleaner?: boolean;
  probeMs?: number;
}

interface SystemSnap {
  hostname?: string;
  cores?: number;
  uptime?: number;
  load?: number[];
  cpuPercent?: number | null;
  memory?: { total?: number; available?: number; swapTotal?: number; swapFree?: number };
  disk?: { total?: number; free?: number; available?: number };
  battery?: { percent?: number; status?: string; ac?: boolean; seconds?: number } | null;
  interfaces?: Array<{ name?: string; rxPerSecond?: number | null; txPerSecond?: number | null }>;
  processes?: Array<{ pid?: number; name?: string; cpuPercent?: number | null; rss?: number }>;
}

interface DeskStatus {
  schemaVersion?: number;
  at?: number;
  state?: string;
  running?: boolean;
  stale?: boolean;
  stageOrder?: string[];
  system?: SystemSnap;
  runs?: StatusRun[];
  workers?: StatusWorker[];
  recentCalls?: RecentCall[];
}

interface RenderCatalogEntry {
  id: string;
  label?: string;
  kind?: string;
  description?: string;
  minSlots?: number;
  maxSlots?: number;
  defaultSlots?: number;
  costTier?: string;
  supportsCleaner?: boolean;
}

interface ModelCatalogEntry {
  id: string;
  label?: string;
  name?: string;
  model?: string;
  note?: string;
  roles?: string[];
  source?: string;
  capabilities?: Record<string, boolean>;
  concurrencyBounds?: { min?: number; max?: number; default?: number };
}

interface DeskLanes extends LanesState {
  catalog?: {
    render?: RenderCatalogEntry[];
    models?: ModelCatalogEntry[];
    unavailableModels?: Array<{ id: string; label?: string; reason?: string; roles?: string[] }>;
    modelConcurrencyBounds?: { min?: number; max?: number; default?: number };
  };
  appliesTo?: string;
  persistedValid?: boolean;
  configError?: string;
  runtimeIntegration?: {
    appliesTo?: string;
    renderSchedulerIntegrated?: boolean;
    renderLanesActive?: boolean;
    modelLanesIntegrated?: boolean;
    modelLanesActive?: boolean;
  };
  renderRuntime?: {
    policy?: {
      envRenderSwitches?: Record<string, boolean>;
      envEnabledButDisabled?: string[];
    };
  };
}

interface LaneDraft {
  render: Array<{ id: string; enabled: boolean; slots: number }>;
  models: {
    vision: Array<{ id: string; enabled: boolean; concurrency: number }>;
    writer: Array<{ id: string; enabled: boolean; concurrency: number }>;
  };
}

interface ConflictState {
  message: string;
  currentRevision: number | null;
}

function bytes(value: number | null | undefined, decimals = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Math.max(0, Number(value));
  const unit = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0;
  return `${(n / 1024 ** unit).toFixed(unit ? decimals : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
}

function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function clock(at: number | null | undefined): string {
  if (!at) return "—";
  return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * `/api/status` top-level `at` is already milliseconds (`now * 1000`), while
 * `event.at` / `startedAt` are epoch seconds. Normalize before `new Date()`.
 */
function toMs(t: number): number {
  return t > 1e11 ? t : t * 1000;
}

function age(at: number | null | undefined): string {
  if (!at) return "Not reported";
  return `${duration(Date.now() / 1000 - at)} ago`;
}

function titleCase(value: string): string {
  return String(value || "").replace(/[-_]/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

function pressureFromFree(free: number | null | undefined, capacity: number): number {
  if (free == null || !Number.isFinite(free) || !Number.isFinite(capacity) || capacity <= 0) return 0;
  return 1 - Math.max(0, Math.min(1, free / capacity));
}

function friendly(raw: string, fallback: string): string {
  const text = String(raw || "").trim();
  if (!text || /<html|<!doctype|traceback|econnreset|etimedout/i.test(text)) return fallback;
  return text.slice(0, 260);
}

function errText(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed";
}

function asStatus(payload: PipelineStatus): DeskStatus {
  const record = payload as DeskStatus;
  return {
    ...record,
    at: typeof record.at === "number" ? record.at : Date.now(),
    running: Boolean(record.running),
    stale: Boolean(record.stale),
    runs: Array.isArray(record.runs) ? record.runs : [],
    workers: Array.isArray(record.workers) ? record.workers : [],
    stageOrder: Array.isArray(record.stageOrder) ? record.stageOrder : [...STAGES],
  };
}

function statusSignature(status: DeskStatus): string {
  const { at: _at, ...rest } = status;
  return JSON.stringify(rest);
}

function lanesSignature(lanes: DeskLanes): string {
  return JSON.stringify({
    revision: lanes.revision,
    config: lanes.config,
    privileged: lanes.privileged,
    source: lanes.source,
    configError: lanes.configError,
    catalog: lanes.catalog,
    renderRuntime: lanes.renderRuntime,
    runtimeIntegration: lanes.runtimeIntegration,
  });
}

function cloneDraft(config: LaneConfig | undefined, customNodes: RenderNode[] = [], workers: StatusWorker[] = []): LaneDraft {
  const renderRows = (config?.render || []).map((row) => ({
    id: String(row.id),
    enabled: Boolean(row.enabled),
    slots: Number(row.slots) || 1,
  }));
  const seen = new Set(renderRows.map((row) => row.id));
  for (const node of customNodes) {
    if (!node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    renderRows.push({
      id: node.id,
      enabled: node.enabled !== false,
      slots: Number(node.slots) || 1,
    });
  }
  for (const worker of workers) {
    if (!worker.id || seen.has(worker.id)) continue;
    seen.add(worker.id);
    renderRows.push({
      id: worker.id,
      enabled: worker.available !== false,
      slots: Number(worker.slots) || 1,
    });
  }
  return {
    render: renderRows,
    models: {
      vision: (config?.models?.vision || []).map((row) => ({
        id: String(row.id),
        enabled: Boolean(row.enabled),
        concurrency: Number(row.concurrency) || 1,
      })),
      writer: (config?.models?.writer || []).map((row) => ({
        id: String(row.id),
        enabled: Boolean(row.enabled),
        concurrency: Number(row.concurrency) || 1,
      })),
    },
  };
}

function workerKindOf(worker: StatusWorker): WorkerKind {
  return inferRenderKind(worker.id, worker.kind);
}

function stageDetail(stage: StageCell | undefined): string {
  if (!stage) return "";
  const parts: string[] = [];
  if (stage.total) {
    parts.push(stage.completed == null ? `${stage.total} ${stage.unit || ""} to process` : `${stage.completed} / ${stage.total} ${stage.unit || ""}`);
  }
  if (stage.phase) parts.push(stage.phase);
  if (stage.startedAt && stage.state === "running") parts.push(duration(Date.now() / 1000 - stage.startedAt));
  if (stage.note) parts.push(stage.note);
  return parts.filter(Boolean).join(" · ");
}

function runHref(run: StatusRun): string {
  const jobId = typeof run.jobId === "string" ? run.jobId.trim() : "";
  const series = typeof run.series === "string" ? run.series.trim() : typeof run.slug === "string" ? run.slug.trim() : "";
  if (jobId && series) return `/new-series.html?job=${encodeURIComponent(jobId)}&series=${encodeURIComponent(series)}`;
  if (jobId) return `/new-series.html?job=${encodeURIComponent(jobId)}`;
  if (series) return `/new-series.html?series=${encodeURIComponent(series)}`;
  return "";
}

function envEnabledIds(lanes: DeskLanes | null): Set<string> {
  const ids = new Set<string>();
  const policy = lanes?.renderRuntime?.policy;
  if (!policy) return ids;
  if (policy.envRenderSwitches) {
    for (const [key, value] of Object.entries(policy.envRenderSwitches)) {
      if (value) ids.add(key);
    }
  }
  for (const id of policy.envEnabledButDisabled || []) {
    if (id) ids.add(String(id));
  }
  return ids;
}

function moveItem<T extends { id: string; enabled: boolean }>(list: T[], id: string, dir: "up" | "down" | "primary"): T[] | null {
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const next = list.slice();
  if (dir === "up" && index > 0) {
    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  } else if (dir === "down" && index < next.length - 1) {
    [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
  } else if (dir === "primary") {
    const [item] = next.splice(index, 1);
    if (!item) return null;
    item.enabled = true;
    next.unshift(item);
  } else {
    return null;
  }
  return next;
}

function Elapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!startedAt) return <>—</>;
  return <>{duration(now / 1000 - startedAt)}</>;
}

function workerCardSig(worker: StatusWorker, system: SystemSnap | undefined, slots: number, cleaner: boolean, privileged: boolean): string {
  return JSON.stringify({
    id: worker.id,
    kind: worker.kind,
    status: worker.status,
    reason: worker.reason,
    jobs: worker.jobs,
    metrics: worker.metrics,
    probedAt: worker.probedAt,
    lastError: worker.lastError,
    boxStatus: worker.boxStatus,
    probeMs: worker.probeMs,
    slots,
    cleaner,
    privileged,
    cpu: system?.cpuPercent,
    memory: system?.memory,
    disk: system?.disk,
  });
}

const WorkerCard = memo(function WorkerCard({
  worker,
  system,
  slots,
  cleaner,
  privileged,
  onControlLane,
}: {
  worker: StatusWorker;
  system?: SystemSnap;
  slots: number;
  cleaner: boolean;
  privileged: boolean;
  onControlLane: (laneId: string, action: LaneControlAction) => void;
}) {
  const kind = workerKindOf(worker);
  const status = String(worker.status || "idle");
  const busy = status === "busy" || status === "running";
  const local = kind === "local";
  const cpu = local
    ? Number(system?.cpuPercent) / 100
    : worker.metrics?.load != null && worker.metrics.cpus
      ? Number(worker.metrics.load) / Number(worker.metrics.cpus)
      : busy
        ? 0.62
        : status === "paused"
          ? 0
          : 0.12;
  const ramFree = local ? system?.memory?.available : worker.metrics?.mem_gb != null ? Number(worker.metrics.mem_gb) * 1024 ** 3 : null;
  const ramCap = local ? system?.memory?.total || 1 : Math.max(16 * 1024 ** 3, Number(ramFree) || 0, 1);
  const diskFree = local ? system?.disk?.available : worker.metrics?.disk_gb != null ? Number(worker.metrics.disk_gb) * 1024 ** 3 : null;
  const diskCap = local ? system?.disk?.total || 1 : Math.max(100 * 1024 ** 3, Number(diskFree) || 0, 1);
  const cpuText = local
    ? percent(system?.cpuPercent)
    : worker.metrics?.load != null
      ? `${worker.metrics.load} / ${worker.metrics.cpus ?? "—"}`
      : "—";
  const ramText = local ? `${bytes(system?.memory?.available)} free` : worker.metrics?.mem_gb != null ? `${worker.metrics.mem_gb} GB` : "—";
  const diskText = kind === "docker-sbx" && diskFree == null
    ? String(worker.boxStatus || "sandbox")
    : local
      ? `${bytes(system?.disk?.available)} free`
      : worker.metrics?.disk_gb != null
        ? `${worker.metrics.disk_gb} GB`
        : "—";
  const Icon = kind === "docker-sbx" ? Cloud : kind === "ssh" ? Server : Monitor;
  return (
    <article className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4" data-worker={worker.id} data-kind={kind}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-[#101113] text-[#f18b6e]">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-xl">{worker.id}</h3>
          <p className="text-sm text-[#a2a19f]">
            {getRenderKindMeta(worker.kind, worker.id).workerLabel}
          </p>
        </div>
        <span className="rounded-full border border-[#2b2c30] px-2 py-1 font-mono text-[10px] uppercase">{status === "last-seen" ? "Last seen" : status}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] px-3 py-2 text-xs">
        <div>
          <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">Slots</dt>
          <dd className="mt-0.5 font-mono text-[#f2efe9]">{slots}</dd>
        </div>
        <div>
          <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">Cleaner</dt>
          <dd className="mt-0.5 font-mono text-[#f2efe9]">{cleaner ? "On" : "Off"}</dd>
        </div>
        <div>
          <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">Probe</dt>
          <dd className="mt-0.5 font-mono text-[#f2efe9]">
            {typeof worker.probeMs === "number" ? `${Math.round(worker.probeMs)} ms` : age(worker.probedAt)}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-col gap-2">
        <MeterRow label="CPU load" value={cpuText} level={cpu} />
        <MeterRow label="RAM free" value={ramText} level={pressureFromFree(ramFree, ramCap)} />
        <MeterRow label={kind === "docker-sbx" && diskFree == null ? "Sandbox" : "Disk free"} value={diskText} level={diskFree == null ? (busy ? 0.4 : 0.08) : pressureFromFree(diskFree, diskCap)} />
      </div>
      {worker.jobs?.length ? (
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {worker.jobs.map((job, index) => (
            <li key={`${job.series || "job"}-${job.chapter || index}`} className="rounded-lg bg-[#101113] px-3 py-2">
              <strong>{job.chapter || "Chapter"} · {String(job.series || "").replace(/-/g, " ")}</strong>
              <p className="text-[#a2a19f]">{(job.stages || []).map((stage) => `${STAGE_LONG[stage.id || ""] || titleCase(stage.id || "stage")} · ${stage.state || "pending"}`).join(" · ")}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-[#a2a19f]">
          {status === "paused"
            ? "Sandbox is stopped. A render resumes it; idle time is not billed."
            : status === "unavailable"
              ? worker.reason || "Worker unavailable"
              : "No chapter assigned. Ready for the next job."}
        </p>
      )}
      {worker.lastError ? <p className="mt-2 text-sm text-[#f0a096]">Last failure: {worker.lastError}</p> : null}
      {privileged ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Controls for ${worker.id}`}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-8"
            disabled={status === "paused" || status === "idle" || status === "off" || status === "unavailable"}
            onClick={() => onControlLane(worker.id, "pause")}
          >
            <Pause className="size-3.5" aria-hidden /> Pause
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-8"
            disabled={status !== "paused"}
            onClick={() => onControlLane(worker.id, "resume")}
          >
            <Play className="size-3.5" aria-hidden /> Resume
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-8"
            onClick={() => onControlLane(worker.id, "stop")}
          >
            <Square className="size-3.5" aria-hidden /> Stop
          </Button>
        </div>
      ) : null}
    </article>
  );
}, (prev, next) => workerCardSig(prev.worker, prev.system, prev.slots, prev.cleaner, prev.privileged) === workerCardSig(next.worker, next.system, next.slots, next.cleaner, next.privileged));

function MeterRow({ label, value, level }: { label: string; value: string; level: number }) {
  const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const pct = Math.round(clamped * 100);
  const fillClass = pct >= 85 ? "bg-[#f0a096]" : pct >= 65 ? "bg-[#d6b57b]" : "bg-[#5eead4]";
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-2">
      <span className="text-[10px] tracking-wide text-[#a2a19f] uppercase">{label}</span>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={value}
        className="h-2 overflow-hidden rounded-full border border-[#2b2c30] bg-[#101113]"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-200", fillClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-end font-mono text-[11px] text-[#f2efe9]">{value}</span>
    </div>
  );
}

const ChapterMatrix = memo(function ChapterMatrix({
  run,
  order,
}: {
  run: StatusRun;
  order: string[];
}) {
  const chapters = Object.entries(run.chapters || {});
  if (!chapters.length) return <p className="text-sm text-[#a2a19f]">Chapter selection has not been reported yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-1 text-left text-xs">
        <caption className="sr-only">Chapter stage matrix</caption>
        <thead>
          <tr>
            <th className="px-2 py-1 text-[#a2a19f]">Chapter</th>
            {order.map((stage) => (
              <th key={stage} className="px-2 py-1 text-[#a2a19f]">{STAGE_LABEL[stage] || titleCase(stage)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chapters.map(([chapter, row]) => (
            <tr key={chapter}>
              <th className="px-2 py-2 font-medium text-[#f2efe9]" scope="row">
                {chapter.replace(/^ch/i, "")}
                <span className="mt-1 block text-[10px] font-normal text-[#a2a19f]">{row.complete ? "Complete" : "Waiting"}</span>
              </th>
              {order.map((stage) => {
                const cell = row.stages?.[stage] || { state: "pending" };
                const state = KNOWN_STATES.has(String(cell.state)) ? String(cell.state) : "pending";
                const detail = stageDetail(cell);
                return (
                  <td key={stage} className={cn("rounded-md border px-2 py-2 text-center", stageTone(state))} title={`${titleCase(stage)}: ${state}${detail ? `, ${detail}` : ""}`}>
                    <span className="block uppercase">{state}</span>
                    {detail ? <span className="mt-1 block text-[10px] text-[#a2a19f]">{detail}</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

function stageTone(state: string): string {
  if (state === "done" || state === "completed") return "border-[#3d523b] bg-[#1e281f] text-[#aed1a8]";
  if (state === "running" || state === "busy") return "border-[#5eead4] bg-[rgba(94,234,212,0.11)] text-[#5eead4]";
  if (state === "failed" || state === "interrupted" || state === "warning") return "border-[#69453e] bg-[#2e1f1e] text-[#f0a096]";
  if (state === "queued" || state === "retrying") return "border-[#605139] bg-[#2a241b] text-[#d6b57b]";
  return "border-[#2b2c30] bg-[#101113] text-[#a2a19f]";
}

export default function StatusPage() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [lanes, setLanes] = useState<DeskLanes | null>(null);
  const [studioStages, setStudioStages] = useState<StagesState | null>(null);
  const [studioNodes, setStudioNodes] = useState<RenderNode[]>([]);
  const [lanesError, setLanesError] = useState("");
  const [selectedRun, setSelectedRun] = useState("");
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState("Connecting");
  const [connError, setConnError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [issueOnly, setIssueOnly] = useState(true);
  const [renderOpen, setRenderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [draft, setDraft] = useState<LaneDraft | null>(null);
  const [draftBase, setDraftBase] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [editorError, setEditorError] = useState("");
  const [boundsNote, setBoundsNote] = useState("");
  const [saveConfirm, setSaveConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState("");
  const statusRef = useRef<DeskStatus | null>(null);
  const lanesRef = useRef<DeskLanes | null>(null);
  const statusSig = useRef("");
  const lanesSig = useRef("");
  const updatedRef = useRef<number | null>(null);
  const inFlight = useRef(false);
  const pausedRef = useRef(false);
  const focusRef = useRef<{ id: string; dir: string; role?: string } | null>(null);

  const applyStatus = useCallback((next: DeskStatus) => {
    statusRef.current = next;
    const sig = statusSignature(next);
    updatedRef.current = next.at || Date.now();
    if (sig !== statusSig.current) {
      statusSig.current = sig;
      setStatus(next);
    }
  }, []);

  const applyLanes = useCallback((next: DeskLanes) => {
    lanesRef.current = next;
    const sig = lanesSignature(next);
    if (sig !== lanesSig.current) {
      lanesSig.current = sig;
      setLanes(next);
    }
    setLanesError("");
  }, []);

  const refresh = useCallback(async (manual: boolean) => {
    if (inFlight.current) return;
    if (!manual && (pausedRef.current || document.hidden)) return;
    inFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      const [statusResult, lanesResult, studioResult] = await Promise.allSettled([
        api.status(),
        api.lanes.get(),
        api.studio.catalog(),
      ]);
      if (statusResult.status === "fulfilled") {
        const next = asStatus(statusResult.value);
        applyStatus(next);
        setConnError(next.stale ? `The collector is temporarily unavailable. Showing the last measurement from ${new Date(toMs(next.at || 0)).toLocaleTimeString()}.` : "");
        setConnection(pausedRef.current ? "Paused" : next.stale ? "Reconnecting" : "Live · 5s");
      } else {
        setConnection("Reconnecting");
        setConnError(statusRef.current
          ? "Connection lost. These are the last received values; retrying automatically."
          : "Couldn’t reach the status collector. Retrying automatically, or use the refresh button.");
      }
      if (lanesResult.status === "fulfilled") applyLanes(lanesResult.value as DeskLanes);
      else if (!lanesRef.current) setLanesError("Lane configuration is temporarily unavailable. Live monitoring continues.");
      if (studioResult.status === "fulfilled" && studioResult.value) {
        if (studioResult.value.stages) setStudioStages(studioResult.value.stages);
        if (Array.isArray(studioResult.value.nodes)) setStudioNodes(studioResult.value.nodes);
      }
    } finally {
      inFlight.current = false;
      if (manual) setRefreshing(false);
    }
  }, [applyLanes, applyStatus]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh(false), 5000);
    void refresh(true);
    const onVis = () => {
      if (!document.hidden) void refresh(false);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onVis);
    };
  }, [refresh]);

  useEffect(() => {
    const pending = focusRef.current;
    if (!pending) return;
    focusRef.current = null;
    const row = pending.role
      ? document.querySelector(`[data-model-role="${CSS.escape(pending.role)}"] [data-model-lane="${CSS.escape(pending.id)}"]`)
      : document.querySelector(`[data-render-lane="${CSS.escape(pending.id)}"]`);
    const preferred = row?.querySelector(`[data-move="${pending.dir}"]`);
    const target = preferred instanceof HTMLButtonElement && !preferred.disabled
      ? preferred
      : row?.querySelector("button:not(:disabled), input");
    if (target instanceof HTMLElement) target.focus();
  }, [draft, renderOpen, modelOpen]);

  const run = useMemo(() => {
    const runs = status?.runs || [];
    return runs.find((item) => item.id === selectedRun) || runs[0] || null;
  }, [status, selectedRun]);

  const calls = useMemo(() => {
    const runs = (status?.runs || []).filter((item) => item.alive && item.state === "running");
    return runs.flatMap((item) => Object.values(item.activeCalls || {}).map((call) => ({ ...call, series: item.series || call.series })));
  }, [status]);

  const failures = useMemo(() => {
    const events = [...(run?.events || [])].reverse().filter((event) => !issueOnly || event.kind === "error" || event.kind === "warning");
    const stageFails = Object.entries(run?.chapters || {}).flatMap(([chapter, row]) =>
      Object.entries(row.stages || [])
        .filter(([, stage]) => stage.state === "failed" || stage.state === "interrupted")
        .map(([name, stage]) => ({
          at: stage.startedAt,
          kind: "error",
          message: `${chapter} · ${STAGE_LONG[name] || titleCase(name)} ${stage.state}${stage.note ? ` · ${stage.note}` : ""}`,
        })),
    );
    const callFails = (run?.recentCalls || []).filter((call) => call.state === "error").map((call) => ({
      at: call.endedAt,
      kind: "error",
      message: `${call.provider || "provider"} / ${call.model || "model"} · ${call.tag || call.role || "request"}${call.note ? ` · ${call.note}` : ""}`,
    }));
    return [...stageFails, ...callFails, ...events].slice(0, 40);
  }, [run, issueOnly]);

  const privileged = lanes?.privileged === true;
  const order = useMemo(() => {
    const extra = (status?.stageOrder || []).filter((stage) => !STAGES.includes(stage as StageKey));
    return [...STAGES, ...extra];
  }, [status]);

  function ensureDraft() {
    if (draft || !lanes) return draft;
    const next = cloneDraft(lanes.config, studioNodes, status?.workers || []);
    setDraft(next);
    setDraftBase(Number.isInteger(lanes.revision) ? lanes.revision : 0);
    setDirty(false);
    return next;
  }

  function toggleEditor(section: "render" | "model") {
    if (!privileged) return;
    setBanner("");
    if (section === "render") {
      if (renderOpen) {
        setRenderOpen(false);
        if (!modelOpen && !dirty) {
          setDraft(null);
          setConflict(null);
          setEditorError("");
        }
      } else {
        ensureDraft();
        setRenderOpen(true);
      }
    } else if (modelOpen) {
      setModelOpen(false);
      if (!renderOpen && !dirty) {
        setDraft(null);
        setConflict(null);
        setEditorError("");
      }
    } else {
      ensureDraft();
      setModelOpen(true);
    }
  }

  function moveRender(id: string, dir: "up" | "down" | "primary") {
    if (!draft || saving) return;
    const next = moveItem(draft.render, id, dir);
    if (!next) return;
    setDraft({ ...draft, render: next });
    setDirty(true);
    setSaveConfirm(false);
    setEditorError("");
    focusRef.current = { id, dir };
  }

  function moveModel(role: "vision" | "writer", id: string, dir: "up" | "down" | "primary") {
    if (!draft || saving) return;
    const next = moveItem(draft.models[role], id, dir);
    if (!next) return;
    setDraft({ ...draft, models: { ...draft.models, [role]: next } });
    setDirty(true);
    setSaveConfirm(false);
    setEditorError("");
    focusRef.current = { id, dir, role };
  }

  function onEditorKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const dir = event.key === "ArrowUp" ? "up" : "down";
      const renderRow = (event.target as HTMLElement).closest("[data-render-lane]");
      if (renderRow instanceof HTMLElement && renderRow.dataset.renderLane) {
        event.preventDefault();
        moveRender(renderRow.dataset.renderLane, dir);
        return;
      }
      const modelRow = (event.target as HTMLElement).closest("[data-model-lane]");
      if (modelRow instanceof HTMLElement && modelRow.dataset.modelLane && (modelRow.dataset.role === "vision" || modelRow.dataset.role === "writer")) {
        event.preventDefault();
        moveModel(modelRow.dataset.role, modelRow.dataset.modelLane, dir);
      }
    }
    if (event.key === "Escape") {
      if (saveConfirm) {
        setSaveConfirm(false);
        return;
      }
      if (resetConfirm) {
        setResetConfirm(false);
        return;
      }
      if (!dirty) {
        setRenderOpen(false);
        setModelOpen(false);
        setDraft(null);
      }
    }
  }

  function affectedEnv(list = draft?.render || []): string[] {
    const ids = envEnabledIds(lanes);
    return list.filter((row) => !row.enabled && ids.has(row.id)).map((row) => row.id);
  }

  async function save(confirmed: boolean, override?: LaneDraft) {
    const source = override || draft;
    if (!privileged || !source || !lanes || saving) return;
    if (!source.render.some((row) => row.enabled)) {
      setEditorError("At least one render lane must remain enabled.");
      return;
    }
    for (const role of ["vision", "writer"] as const) {
      if (!source.models[role].some((row) => row.enabled)) {
        setEditorError(`Model role '${role}' must keep at least one enabled lane.`);
        return;
      }
    }
    if (affectedEnv(source.render).length && !confirmed) {
      setSaveConfirm(true);
      setResetConfirm(false);
      return;
    }
    setSaveConfirm(false);
    setSaving(true);
    setEditorError("");
    const catalogRenderIds = new Set((lanes.catalog?.render || []).map((item) => item.id));
    const renderForLanes = source.render.filter((row) => catalogRenderIds.size === 0 || catalogRenderIds.has(row.id));
    const customRenderRows = source.render.filter((row) => catalogRenderIds.size > 0 && !catalogRenderIds.has(row.id));
    const config: LaneConfig = {
      schemaVersion: lanes.config?.schemaVersion || lanes.schemaVersion || 1,
      render: (renderForLanes.length ? renderForLanes : source.render).map((row) => {
        const cat = lanes.catalog?.render?.find((item) => item.id === row.id);
        const min = cat?.minSlots ?? 1;
        const max = cat?.maxSlots ?? Math.max(min, row.slots, 1);
        return { id: row.id, enabled: row.enabled, slots: Math.max(min, Math.min(max, Math.trunc(row.slots) || min)) };
      }),
      models: {
        vision: source.models.vision.map((row) => clampModel(lanes, row)),
        writer: source.models.writer.map((row) => clampModel(lanes, row)),
      },
    };
    try {
      const saved = await api.lanes.put({ revision: draftBase, config }) as DeskLanes;
      applyLanes(saved);
      setDraftBase(saved.revision);
      const nodeResults = await Promise.allSettled(
        customRenderRows.flatMap((customRow, idx) => {
          const existingNode = studioNodes.find((n) => n.id === customRow.id);
          if (!existingNode) return [];
          return [
            api.studio.updateNode(customRow.id, {
              enabled: customRow.enabled,
              slots: customRow.slots,
              priority: idx + 1,
              expectedRevision: existingNode.revision,
            }),
          ];
        }),
      );
      if (nodeResults.length > 0) {
        const freshNodes = await api.studio.nodes().catch(() => null);
        if (freshNodes && Array.isArray(freshNodes.nodes)) {
          setStudioNodes(freshNodes.nodes);
        } else {
          for (const res of nodeResults) {
            if (res.status === "fulfilled" && Array.isArray(res.value?.nodes)) {
              setStudioNodes(res.value.nodes);
            }
          }
        }
        if (nodeResults.some((res) => res.status === "rejected")) {
          setConflict(null);
          setEditorError("Lane policy saved, but one or more render node updates failed.");
          return;
        }
      }
      setDraft(null);
      setDirty(false);
      setConflict(null);
      setRenderOpen(false);
      setModelOpen(false);
      setBoundsNote("");
      setBanner(`Saved lane policy (revision ${saved.revision}). Applies to new runs.`);
    } catch (error) {
      if (isConflict(error)) {
        const fresh = await api.lanes.get().catch(() => null);
        if (fresh) applyLanes(fresh as DeskLanes);
        setConflict({
          message: friendly(error.message, "Lane settings were updated in another session."),
          currentRevision: error.currentRevision ?? (fresh as DeskLanes | null)?.revision ?? null,
        });
      } else {
        setEditorError(isApiError(error) && error.status >= 500
          ? "Couldn’t save lane settings right now. Your draft edits are preserved — please try again."
          : friendly(errText(error), "Couldn’t save lane settings right now. Your draft edits are preserved."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function resetLanes() {
    if (!privileged || saving) return;
    setSaving(true);
    setEditorError("");
    try {
      const saved = await api.lanes.reset(draft ? draftBase : lanes?.revision) as DeskLanes;
      applyLanes(saved);
      setDraft(null);
      setDirty(false);
      setConflict(null);
      setResetConfirm(false);
      setSaveConfirm(false);
      setRenderOpen(false);
      setModelOpen(false);
      setBanner(`Restored default lane policy (revision ${saved.revision}). Applies to new runs.`);
    } catch (error) {
      if (isConflict(error)) {
        const fresh = await api.lanes.get().catch(() => null);
        if (fresh) applyLanes(fresh as DeskLanes);
        setResetConfirm(false);
        setConflict({
          message: friendly(error.message, "Lane settings were updated in another session before reset."),
          currentRevision: error.currentRevision ?? (fresh as DeskLanes | null)?.revision ?? null,
        });
      } else {
        setEditorError(friendly(errText(error), "Couldn’t reset lane settings right now. Your draft is preserved."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadServer() {
    if (saving) return;
    setSaving(true);
    try {
      const fresh = await api.lanes.get() as DeskLanes;
      applyLanes(fresh);
      setDraft(cloneDraft(fresh.config, studioNodes, status?.workers || []));
      setDraftBase(fresh.revision);
      setDirty(false);
      setConflict(null);
      setSaveConfirm(false);
      setResetConfirm(false);
      setEditorError("");
      setBanner(`Loaded latest server lane settings (revision ${fresh.revision}).`);
    } catch (error) {
      setEditorError(errText(error));
    } finally {
      setSaving(false);
    }
  }

  const progress = run?.total ? ((run.completed || 0) / run.total) * 100 : 0;
  const manage = run ? runHref(run) : "";
  const needsRecovery = run ? ["failed", "interrupted"].includes(String(run.state)) : false;
  const envDisabled = lanes?.renderRuntime?.policy?.envEnabledButDisabled || [];
  const conflictRev = conflict?.currentRevision ?? lanes?.revision ?? draftBase;
  const runJobId = run?.jobId || (run?.id && /^job-\d+-/.test(run.id) ? run.id : "");

  const handleControlLane = useCallback(async (laneId: string, action: LaneControlAction) => {
    try {
      const res = await api.studio.controlLane(laneId, action);
      setBanner(res.message || res.detail || `Lane ${laneId}: ${action} applied.`);
      void refresh(true);
    } catch (error) {
      setEditorError(errText(error));
    }
  }, [refresh]);

  async function handleRunControl(action: "pause" | "resume" | "stop") {
    if (!privileged || !runJobId) return;
    try {
      if (action === "pause") await api.intake.pauseJob(runJobId);
      else if (action === "resume") await api.intake.resumeJob(runJobId);
      else await api.intake.cancelJob(runJobId);
      setBanner(`Job ${runJobId}: ${action} requested.`);
      await refresh(true);
    } catch (error) {
      setEditorError(errText(error));
    }
  }

  return (
    <AppShell
      active="status"
      eyebrow="The production desk"
      title="Behind every chapter."
      actions={(
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#a2a19f]" role="status">{connection}</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-pressed={paused}
            aria-label={paused ? "Resume live updates" : "Pause live updates"}
            onClick={() => {
              const next = !paused;
              setPaused(next);
              pausedRef.current = next;
              setConnection(next ? "Paused" : status?.stale ? "Reconnecting" : "Live · 5s");
              if (!next) void refresh(true);
            }}
          >
            {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
          </Button>
          <Button type="button" variant="outline" className="min-h-11" aria-label="Refresh dashboard" disabled={refreshing} onClick={() => void refresh(true)}>
            <RefreshCw className="size-4" aria-hidden />
          </Button>
        </div>
      )}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.18em] text-[#a2a19f] uppercase">The production desk</p>
            <h1 className="font-serif text-3xl">Behind every chapter.</h1>
            <p className="text-sm text-[#a2a19f]">A live look at the work that brings stories to the screen.</p>
          </div>
          <span className={cn("rounded-full border px-3 py-1 text-xs", status?.running ? "border-[#5eead4] text-[#5eead4]" : "border-[#2b2c30] text-[#a2a19f]")}>
            {status?.running ? "Pipeline active" : status ? "Pipeline idle" : "Loading"}
          </span>
        </header>
        {connError ? <p className="rounded-xl border border-[#69453e] bg-[#2e1f1e] px-4 py-3 text-sm text-[#f0a096]" role="alert">{connError}</p> : null}

        <section className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4" aria-labelledby="runHeading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="runHeading" className="font-serif text-2xl">Live run</h2>
            {(status?.runs || []).length > 1 ? (
              <label className="text-sm">
                <span className="sr-only">Select pipeline run</span>
                <select
                  className="min-h-11 rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base"
                  value={run?.id || ""}
                  aria-label="Select pipeline run"
                  onChange={(event) => setSelectedRun(event.target.value)}
                >
                  {(status?.runs || []).map((item) => (
                    <option key={item.id} value={item.id}>{item.title || item.id} · {item.alive && item.state === "running" ? "live" : titleCase(item.state || "idle")}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {!run ? (
            <p className="mt-3 text-sm text-[#a2a19f]">No pipeline run is active. Start a run and its chapters, model calls, and render workers appear here.</p>
          ) : (
            <div className="mt-3">
              <p className="text-[10px] tracking-[0.16em] text-[#a2a19f] uppercase">
                {run.alive && run.state === "running" ? "On the production floor" : "Latest run"} · {titleCase(run.state || "idle")}
              </p>
              <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="font-serif text-2xl">{run.title || run.series || run.id}</h3>
                  <p className="text-sm text-[#a2a19f]">
                    {duration(run.elapsed)} elapsed · PID {run.pid ?? "—"} · {run.video ? "Script + video" : "Script lane"}
                    {run.captionVersion ? ` · captions v${run.captionVersion}` : ""}
                  </p>
                </div>
                <p className="font-mono text-sm"><strong className="text-2xl text-[#f2efe9]">{run.completed ?? 0}</strong> / {run.total ?? 0} chapters</p>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#101113]" role="progressbar" aria-label="Completed chapters" aria-valuemin={0} aria-valuemax={Math.max(1, run.total || 1)} aria-valuenow={run.completed || 0}>
                <i className="block h-full bg-[#f18b6e]" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {manage ? (
                  <a className="inline-flex min-h-11 items-center text-sm text-[#f18b6e]" href={manage}>
                    {needsRecovery ? "Recover run" : "Manage run"}
                  </a>
                ) : null}
                {privileged && runJobId ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={
                        String(run.state || "idle").toLowerCase() === "paused" ||
                        String(run.state || "idle").toLowerCase() === "idle" ||
                        ["completed", "done", "failed", "interrupted"].includes(String(run.state || "").toLowerCase())
                      }
                      onClick={() => void handleRunControl("pause")}
                    >
                      <Pause className="size-3.5" aria-hidden /> Pause
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={String(run.state || "idle").toLowerCase() !== "paused"}
                      onClick={() => void handleRunControl("resume")}
                    >
                      <Play className="size-3.5" aria-hidden /> Resume
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => void handleRunControl("stop")}>
                      <Square className="size-3.5" aria-hidden /> Stop
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="workersHeading">
          <h2 id="workersHeading" className="font-serif text-2xl">Render lanes <span className="text-base text-[#a2a19f]">{status?.workers?.length ?? 0} discovered</span></h2>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {(status?.workers || []).map((worker) => {
              const policy = lanes?.config?.render?.find((row) => row.id === worker.id);
              const cat = lanes?.catalog?.render?.find((row) => row.id === worker.id);
              return (
                <WorkerCard
                  key={worker.id}
                  worker={worker}
                  system={status?.system}
                  slots={policy?.slots ?? worker.slots ?? cat?.defaultSlots ?? 1}
                  cleaner={Boolean(worker.supportsCleaner ?? cat?.supportsCleaner)}
                  privileged={privileged}
                  onControlLane={(laneId, action) => void handleControlLane(laneId, action)}
                />
              );
            })}
            {!status?.workers?.length ? <p className="text-sm text-[#a2a19f]">No render workers reported yet.</p> : null}
          </div>
        </section>

        <section aria-labelledby="matrixHeading">
          <h2 id="matrixHeading" className="font-serif text-2xl">Chapter stage matrix</h2>
          <p className="text-sm text-[#a2a19f]">reader, writer, check, audio, clean, timeline, render.</p>
          <div className="mt-3 rounded-2xl border border-[#2b2c30] bg-[#17181a] p-3">
            {run ? <ChapterMatrix run={run} order={order} /> : <p className="text-sm text-[#a2a19f]">Waiting for a run.</p>}
          </div>
        </section>

        <section aria-labelledby="callsHeading">
          <h2 id="callsHeading" className="font-serif text-2xl">In-flight LLM calls</h2>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-[#2b2c30] bg-[#17181a]">
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="sr-only">In-flight model requests</caption>
              <thead className="text-xs tracking-wide text-[#a2a19f] uppercase">
                <tr>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Model</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Chapter</th>
                  <th className="px-3 py-2">Attempt</th>
                  <th className="px-3 py-2">Elapsed</th>
                  <th className="px-3 py-2">Series</th>
                </tr>
              </thead>
              <tbody>
                {calls.length ? calls.map((call) => (
                  <tr key={`${call.series}-${call.provider}-${call.model}-${call.startedAt}-${call.tag}`} className="border-t border-[#2b2c30]">
                    <td className="px-3 py-2">{call.provider || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{call.model || "—"}</td>
                    <td className="px-3 py-2">{call.role || "—"}</td>
                    <td className="px-3 py-2">{call.chapter || call.tag || "—"}</td>
                    <td className="px-3 py-2">{call.attempt ?? "—"}</td>
                    <td className="px-3 py-2 font-mono"><Elapsed startedAt={call.startedAt} /></td>
                    <td className="px-3 py-2">{call.series || "—"}</td>
                  </tr>
                )) : (
                  <tr><td className="px-3 py-4 text-[#a2a19f]" colSpan={7}>{status?.running ? "No in-flight model request reported." : "No model requests in flight."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="failuresHeading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="failuresHeading" className="font-serif text-2xl">Recent failures</h2>
            <label className="text-sm">
              <span className="sr-only">Filter activity</span>
              <select className="min-h-11 rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base" value={issueOnly ? "issues" : "all"} aria-label="Filter activity" onChange={(event) => setIssueOnly(event.target.value === "issues")}>
                <option value="issues">Failures</option>
                <option value="all">All events</option>
              </select>
            </label>
          </div>
          <div className="mt-3 rounded-2xl border border-[#2b2c30] bg-[#17181a] p-3" role="log" aria-live="off" aria-relevant="additions">
            {failures.length ? failures.map((event, index) => (
              <p key={`${event.at || 0}-${index}`} className={cn("border-b border-[#2b2c30] py-2 text-sm last:border-0", event.kind === "error" ? "text-[#f0a096]" : "text-[#f2efe9]")}>
                <time className="mr-2 font-mono text-xs text-[#a2a19f]">{clock(event.at)}</time>
                {event.message}
              </p>
            )) : <p className="text-sm text-[#a2a19f]">{issueOnly ? "No recent failures." : "Run events will appear here."}</p>}
          </div>
        </section>

        <section aria-labelledby="policyHeading" onKeyDown={onEditorKey}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="policyHeading" className="font-serif text-2xl">Lane priority & slots</h2>
              <p className="text-sm text-[#a2a19f]">Saved order applies to new runs. Active workers are not interrupted.</p>
            </div>
            <div className="flex gap-2">
              <a className="inline-flex min-h-11 items-center text-sm text-[#f18b6e]" href="/studio.html">Open Studio</a>
              {privileged ? (
                <>
                  <Button type="button" variant="outline" className="min-h-11" aria-expanded={renderOpen} aria-controls="renderConfigPanel" onClick={() => toggleEditor("render")}>{renderOpen ? "Close" : "Configure"}</Button>
                  <Button type="button" variant="outline" className="min-h-11" aria-expanded={modelOpen} aria-controls="modelConfigPanel" onClick={() => toggleEditor("model")}>{modelOpen ? "Close models" : "Models"}</Button>
                </>
              ) : lanes ? <span className="rounded-full border border-[#605139] px-3 py-1 text-xs text-[#d6b57b]">Temporary account · read-only</span> : null}
            </div>
          </div>
          {lanesError ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[#d6b57b]" role="status">
              {lanesError}
              <Button type="button" variant="outline" className="min-h-11" onClick={() => void refresh(true)}>Retry</Button>
            </p>
          ) : null}
          {banner ? (
            <p className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#3d523b] bg-[#1e281f] px-3 py-2 text-sm text-[#aed1a8]" role="status">
              {banner}
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setBanner("")}>Dismiss</Button>
            </p>
          ) : null}
          {studioStages?.persisted || (studioStages?.reader?.chain?.length ?? 0) > 0 || (studioStages?.writer?.chain?.length ?? 0) > 0 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#3d523b] bg-[#1e281f] px-3 py-2 text-sm text-[#aed1a8]" role="status">
              <span>
                <strong>Studio Stage Routing is active</strong> (<code>stages.json</code>) — Reader:{" "}
                <code className="font-mono text-xs">{studioStages?.reader?.primary || studioStages?.reader?.chain?.[0] || "default"}</code> · Writer:{" "}
                <code className="font-mono text-xs">{studioStages?.writer?.primary || studioStages?.writer?.chain?.[0] || "default"}</code>.
              </span>
              <a
                className="inline-flex min-h-9 items-center font-medium text-[#f18b6e] underline"
                href="/studio.html"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  navigateClient("/studio.html");
                }}
              >
                Edit Stage Routing in Studio →
              </a>
            </div>
          ) : null}
          {lanes ? <PolicySummary lanes={lanes} customNodes={studioNodes} workers={status?.workers || []} /> : null}
          {envDisabled.length ? (
            <p className="mt-2 text-sm text-[#d6b57b]">Environment-configured lane disabled by saved policy ({envDisabled.join(", ")}).</p>
          ) : null}
          {conflict ? (
            <div className="mt-3 rounded-xl border border-[#69453e] bg-[#2e1f1e] px-3 py-3 text-sm text-[#f0a096]" role="alert">
              <p>
                <strong>Revision conflict (server at rev {conflictRev}, draft started at rev {draftBase}).</strong>{" "}
                {conflict.message} Your draft edits are preserved.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <a className="inline-flex min-h-11 items-center underline" href="/studio.html">Open Studio</a>
                <Button type="button" className="min-h-11" onClick={() => {
                  if (Number.isInteger(conflictRev)) setDraftBase(Number(conflictRev));
                  setConflict(null);
                  setEditorError("");
                }}>Review & keep draft</Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void reloadServer()}>Reload server settings</Button>
              </div>
            </div>
          ) : null}
          {editorError ? <p className="mt-3 text-sm text-[#f0a096]" role="alert">{editorError}</p> : null}
          {boundsNote ? <p className="mt-2 text-sm text-[#d6b57b]" role="status">{boundsNote}</p> : null}
          {renderOpen && draft ? (
            <div id="renderConfigPanel" className="mt-3 rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4" role="region" aria-labelledby="renderEditorHeading">
              <h3 id="renderEditorHeading" className="font-serif text-xl">Configure render lane policy</h3>
              <p className="text-sm text-[#a2a19f]">Base revision {draftBase}{dirty ? " · Unsaved draft edits" : " · Saved state"} · Applies to new runs</p>
              <Sortable
                className="mt-3 flex flex-col gap-2"
                value={draft.render.map((row) => row.id)}
                onValueChange={(order) => {
                  if (saving) return;
                  const byId = new Map(draft.render.map((row) => [row.id, row]));
                  const next = order
                    .map((id) => byId.get(id))
                    .filter((row): row is (typeof draft.render)[number] => Boolean(row));
                  if (next.length !== draft.render.length) return;
                  setDraft({ ...draft, render: next });
                  setDirty(true);
                  setSaveConfirm(false);
                  setEditorError("");
                }}
              >
                {draft.render.map((row, index) => {
                  const cat = lanes?.catalog?.render?.find((item) => item.id === row.id);
                  const customNode = studioNodes.find((item) => item.id === row.id);
                  const rowLabel = cat?.label || customNode?.label || row.id;
                  const min = cat?.minSlots ?? 1;
                  const max = cat?.maxSlots ?? (customNode ? maxSlotsForKind(customNode.kind) : Math.max(min, 8));
                  const rank = row.enabled ? draft.render.slice(0, index + 1).filter((item) => item.enabled).length : 0;
                  return (
                    <SortableItem key={row.id} value={row.id} className="flex-col items-stretch rounded-xl border border-[#2b2c30] bg-[#101113] p-3" data-render-lane={row.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <SortableHandle aria-label={`Reorder ${rowLabel}`} />
                        <span className={cn("rounded-full px-2 py-1 text-[10px] uppercase", rank === 1 ? "bg-[rgba(241,139,110,0.14)] text-[#f18b6e]" : "bg-[#1e2024] text-[#a2a19f]")}>
                          {row.enabled ? (rank === 1 ? "Primary" : `Fallback ${rank - 1}`) : "Off"}
                        </span>
                        <strong>{rowLabel}</strong>
                        <code className="font-mono text-xs text-[#a2a19f]">{row.id}</code>
                        {customNode && !cat ? <span className="text-xs text-[#5eead4]">Custom ({customNode.kind})</span> : null}
                        {cat?.costTier === "paid-opt-in" ? <span className="text-xs text-[#d6b57b]">Paid opt-in</span> : null}
                      </div>
                      {cat?.description ? <p className="mt-1 text-xs text-[#a2a19f]">{cat.description}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            aria-label={`Enable ${cat?.label || row.id}`}
                            onChange={(event) => {
                              if (!event.target.checked && draft.render.filter((item) => item.enabled).length <= 1) {
                                setEditorError("At least one render lane must remain enabled.");
                                return;
                              }
                              setDraft({
                                ...draft,
                                render: draft.render.map((item) => item.id === row.id ? { ...item, enabled: event.target.checked } : item),
                              });
                              setDirty(true);
                              setEditorError("");
                            }}
                          />
                          {row.enabled ? "Enabled" : "Disabled"}
                        </label>
                        <label className="text-sm">
                          Slots
                          <input
                            className="ml-2 min-h-11 w-20 rounded-lg border border-[#2b2c30] bg-[#17181a] px-2 text-center font-mono text-base"
                            type="number"
                            min={min}
                            max={max}
                            value={row.slots}
                            aria-label={`${cat?.label || row.id} slots`}
                            readOnly={min === max}
                            onChange={(event) => {
                              const parsed = Number(event.target.value);
                              const clamped = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : min;
                              if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
                                setBoundsNote(`Slots for ${cat?.label || row.id} must be between ${min} and ${max} (clamped to ${clamped}).`);
                              } else setBoundsNote("");
                              setDraft({
                                ...draft,
                                render: draft.render.map((item) => item.id === row.id ? { ...item, slots: clamped } : item),
                              });
                              setDirty(true);
                            }}
                          />
                        </label>
                        <div className="flex gap-1" role="group" aria-label={`Reorder ${cat?.label || row.id}`}>
                          <Button type="button" variant="outline" className="min-h-11" data-move="up" disabled={index === 0} aria-label={`Move ${row.id} up`} onClick={() => moveRender(row.id, "up")}>Up</Button>
                          <Button type="button" variant="outline" className="min-h-11" data-move="down" disabled={index === draft.render.length - 1} aria-label={`Move ${row.id} down`} onClick={() => moveRender(row.id, "down")}>Down</Button>
                          <Button type="button" variant="outline" className="min-h-11" data-move="primary" disabled={index === 0 && row.enabled} aria-label={`Make ${row.id} primary`} onClick={() => moveRender(row.id, "primary")}>Make primary</Button>
                        </div>
                      </div>
                    </SortableItem>
                  );
                })}
              </Sortable>
            </div>
          ) : null}
          {modelOpen && draft ? (
            <div id="modelConfigPanel" className="mt-3 rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4">
              <h3 className="font-serif text-xl">Model priority</h3>
              {(["vision", "writer"] as const).map((role) => (
                <div key={role} className="mt-3" data-model-role={role}>
                  <h4 className="text-sm uppercase tracking-wide text-[#a2a19f]">{role}</h4>
                  <Sortable
                    className="mt-2 flex flex-col gap-2"
                    value={draft.models[role].map((row) => row.id)}
                    onValueChange={(order) => {
                      if (saving) return;
                      const byId = new Map(draft.models[role].map((row) => [row.id, row]));
                      const next = order
                        .map((id) => byId.get(id))
                        .filter((row): row is (typeof draft.models)[typeof role][number] => Boolean(row));
                      if (next.length !== draft.models[role].length) return;
                      setDraft({ ...draft, models: { ...draft.models, [role]: next } });
                      setDirty(true);
                      setSaveConfirm(false);
                      setEditorError("");
                    }}
                  >
                    {draft.models[role].map((row, index) => {
                      const cat = lanes?.catalog?.models?.find((item) => item.id === row.id);
                      const min = cat?.concurrencyBounds?.min ?? lanes?.catalog?.modelConcurrencyBounds?.min ?? 1;
                      const max = cat?.concurrencyBounds?.max ?? lanes?.catalog?.modelConcurrencyBounds?.max ?? 4;
                      return (
                        <SortableItem key={row.id} value={row.id} className="flex-col items-stretch rounded-xl border border-[#2b2c30] bg-[#101113] p-3" data-model-lane={row.id} data-role={role}>
                          <div className="flex items-center gap-2">
                            <SortableHandle aria-label={`Reorder ${cat?.label || row.id}`} />
                            <strong>{cat?.label || row.id}</strong>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label className="flex min-h-11 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={row.enabled}
                                onChange={(event) => {
                                  if (!event.target.checked && draft.models[role].filter((item) => item.enabled).length <= 1) {
                                    setEditorError(`Model role '${role}' must keep at least one enabled lane.`);
                                    return;
                                  }
                                  setDraft({
                                    ...draft,
                                    models: {
                                      ...draft.models,
                                      [role]: draft.models[role].map((item) => item.id === row.id ? { ...item, enabled: event.target.checked } : item),
                                    },
                                  });
                                  setDirty(true);
                                }}
                              />
                              On
                            </label>
                            <label className="text-sm">
                              Concurrency
                              <input
                                className="ml-2 min-h-11 w-20 rounded-lg border border-[#2b2c30] bg-[#17181a] px-2 text-center font-mono text-base"
                                type="number"
                                min={min}
                                max={max}
                                value={row.concurrency}
                                onChange={(event) => {
                                  const parsed = Number(event.target.value);
                                  const clamped = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : min;
                                  setDraft({
                                    ...draft,
                                    models: {
                                      ...draft.models,
                                      [role]: draft.models[role].map((item) => item.id === row.id ? { ...item, concurrency: clamped } : item),
                                    },
                                  });
                                  setDirty(true);
                                }}
                              />
                            </label>
                            <Button type="button" variant="outline" className="min-h-11" data-move="up" disabled={index === 0} onClick={() => moveModel(role, row.id, "up")}>Up</Button>
                            <Button type="button" variant="outline" className="min-h-11" data-move="down" disabled={index === draft.models[role].length - 1} onClick={() => moveModel(role, row.id, "down")}>Down</Button>
                            <Button type="button" variant="outline" className="min-h-11" data-move="primary" onClick={() => moveModel(role, row.id, "primary")}>1st</Button>
                          </div>
                        </SortableItem>
                      );
                    })}
                  </Sortable>
                </div>
              ))}
            </div>
          ) : null}
          {(renderOpen || modelOpen) && draft ? (
            <EditorFooter
              dirty={dirty}
              base={draftBase}
              saving={saving}
              saveConfirm={saveConfirm}
              resetConfirm={resetConfirm}
              affected={affectedEnv()}
              onSave={() => void save(false)}
              onConfirmSave={() => void save(true)}
              onKeepEnv={() => {
                const hit = new Set(affectedEnv());
                const next = {
                  ...draft,
                  render: draft.render.map((row) => hit.has(row.id) ? { ...row, enabled: true } : row),
                };
                setDraft(next);
                setDirty(true);
                void save(true, next);
              }}
              onCancelConfirm={() => setSaveConfirm(false)}
              onResetAsk={() => {
                setResetConfirm(true);
                setSaveConfirm(false);
              }}
              onReset={() => void resetLanes()}
              onCancelReset={() => setResetConfirm(false)}
              onCancel={() => {
                setRenderOpen(false);
                setModelOpen(false);
                setDraft(null);
                setDirty(false);
                setConflict(null);
                setEditorError("");
              }}
            />
          ) : null}
        </section>

        {status?.system ? (
          <details className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4">
            <summary className="cursor-pointer font-serif text-xl">{status.system.hostname || "Local machine"} · {status.system.cores ?? "—"} cores · up {duration(status.system.uptime)}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <MeterRow label="CPU" value={percent(status.system.cpuPercent)} level={Number(status.system.cpuPercent || 0) / 100} />
              <MeterRow label="RAM" value={bytes(status.system.memory?.available)} level={pressureFromFree(status.system.memory?.available, status.system.memory?.total || 1)} />
              <MeterRow label="Disk" value={bytes(status.system.disk?.available)} level={pressureFromFree(status.system.disk?.available, status.system.disk?.total || 1)} />
            </div>
            <PollStamp updatedRef={updatedRef} extra={privileged ? "live monitoring" : "read-only"} />
          </details>
        ) : (
          <PollStamp updatedRef={updatedRef} />
        )}
      </div>
    </AppShell>
  );
}

function PollStamp({ updatedRef, extra }: { updatedRef: { current: number | null }; extra?: string }) {
  const [at, setAt] = useState<number | null>(updatedRef.current);
  useEffect(() => {
    const id = window.setInterval(() => {
      setAt((prev) => (prev === updatedRef.current ? prev : updatedRef.current));
    }, 1000);
    return () => window.clearInterval(id);
  }, [updatedRef]);
  return (
    <p className="mt-3 text-xs text-[#a2a19f]">
      Updated {at ? new Date(toMs(at)).toLocaleTimeString() : "—"} · every 5 seconds{extra ? ` · ${extra}` : ""}
    </p>
  );
}

function clampModel(lanes: DeskLanes, row: { id: string; enabled: boolean; concurrency: number }) {
  const cat = lanes.catalog?.models?.find((item) => item.id === row.id);
  const min = cat?.concurrencyBounds?.min ?? 1;
  const max = cat?.concurrencyBounds?.max ?? 4;
  return {
    id: row.id,
    enabled: row.enabled,
    concurrency: Math.max(min, Math.min(max, Math.trunc(row.concurrency) || 1)),
  };
}

function PolicySummary({
  lanes,
  customNodes = [],
  workers = [],
}: {
  lanes: DeskLanes;
  customNodes?: RenderNode[];
  workers?: StatusWorker[];
}) {
  const cfg = lanes.config;
  const rows = [...(cfg?.render || [])];
  const seen = new Set(rows.map((r) => r.id));
  for (const node of customNodes) {
    if (!node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    rows.push({ id: node.id, enabled: node.enabled !== false, slots: node.slots || 1 });
  }
  for (const worker of workers) {
    if (!worker.id || seen.has(worker.id)) continue;
    seen.add(worker.id);
    rows.push({ id: worker.id, enabled: worker.available !== false, slots: worker.slots || 1 });
  }
  let rank = 0;
  return (
    <ol className="mt-3 flex flex-wrap gap-2" aria-label="Configured render lane policy">
      {rows.map((row) => {
        const cat = lanes.catalog?.render?.find((item) => item.id === row.id);
        const customNode = customNodes.find((item) => item.id === row.id);
        if (row.enabled) rank += 1;
        return (
          <li key={row.id} className={cn("rounded-full border px-3 py-1 text-xs", row.enabled ? "border-[#3d523b] text-[#aed1a8]" : "border-[#2b2c30] text-[#a2a19f]")}>
            {row.enabled ? (rank === 1 ? "Primary" : `Fallback ${rank - 1}`) : "Off"} · {cat?.label || customNode?.label || row.id} · {row.slots} slot{row.slots === 1 ? "" : "s"}
          </li>
        );
      })}
    </ol>
  );
}

function EditorFooter({
  dirty,
  base,
  saving,
  saveConfirm,
  resetConfirm,
  affected,
  onSave,
  onConfirmSave,
  onKeepEnv,
  onCancelConfirm,
  onResetAsk,
  onReset,
  onCancelReset,
  onCancel,
}: {
  dirty: boolean;
  base: number;
  saving: boolean;
  saveConfirm: boolean;
  resetConfirm: boolean;
  affected: string[];
  onSave: () => void;
  onConfirmSave: () => void;
  onKeepEnv: () => void;
  onCancelConfirm: () => void;
  onResetAsk: () => void;
  onReset: () => void;
  onCancelReset: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-4">
      {saveConfirm && affected.length ? (
        <div className="mb-3 rounded-xl border border-[#605139] bg-[#2a241b] px-3 py-3 text-sm text-[#d6b57b]" role="alert">
          <p>Saving this policy will disable environment-enabled render lanes: {affected.join(", ")}.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" disabled={saving} onClick={onKeepEnv}>Keep enabled & save</Button>
            <Button type="button" variant="destructive" className="min-h-11" disabled={saving} onClick={onConfirmSave}>Confirm save</Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onCancelConfirm}>Back to draft</Button>
          </div>
        </div>
      ) : null}
      {resetConfirm ? (
        <div className="mb-3 rounded-xl border border-[#69453e] bg-[#2e1f1e] px-3 py-3 text-sm text-[#f0a096]" role="alert">
          <p>Reset render and model lane policy to factory defaults? Applies to new runs only.</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="destructive" className="min-h-11" disabled={saving} onClick={onReset}>Confirm reset</Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onCancelReset}>Keep current</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[#a2a19f]">Base revision {base}{dirty ? " · Unsaved draft edits" : " · Saved state"}</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onResetAsk}>Reset to defaults</Button>
          <Button type="button" variant="ghost" className="min-h-11" disabled={saving} onClick={onCancel}>Cancel</Button>
          <Button type="button" className="min-h-11" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}
