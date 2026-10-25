import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, RotateCw, Check, ChevronDown, Cloud, Cpu, HardDrive, Info, LoaderCircle, MemoryStick, Monitor, Pause, Play, RefreshCw, Server, Settings2, Square, X } from "lucide-react";

import { AppShell, navigateClient } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Notice, RawDetails } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
import { FeedRow, LaneHealth, RunTotals, buildFeed } from "@/components/status/RunHealth";
import { RunSettingsDialog } from "@/components/shared/RunSettingsDialog";
import { Sortable, SortableHandle, SortableItem } from "@/components/ui/sortable";
import {
  api,
  isApiError,
  isConflict,
  type JobRecord,
  type LaneConfig,
  type LanesState,
  type PipelineStatus,
  type RenderNode,
  type StagesState,
} from "@/lib/api";
import { errorLine, parseFailureNote } from "@/lib/errors";
import { retryCountdown, useRetryClock, type StageRetryFields } from "@/lib/retry";
import { conciseNodeLabel, getRenderKindMeta, inferRenderKind, maxSlotsForKind } from "@/lib/renderLanes";
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

interface StageCell extends StageRetryFields {
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
  chapter?: string;
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
  jobId?: string | null;
  state?: string;
  paused?: boolean;
  pausedWhere?: string | null;
  alive?: boolean;
  pid?: number;
  elapsed?: number;
  completed?: number;
  total?: number;
  video?: boolean;
  captionVersion?: string | number;
  source?: string;
  actions?: string[];
  controlActions?: string[];
  chapters?: Record<string, ChapterRow>;
  activeCalls?: Record<string, ActiveCall>;
  providers?: Record<string, { coolingUntil?: number | null; coolingReason?: string }>;
  recentCalls?: RecentCall[];
  events?: ActivityEvent[];
  totals?: { calls?: number; errors?: number; tokens?: number };
  models?: Record<string, Array<{ name?: string; model?: string }>>;
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
  return errorLine(error);
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

function workerCardSig(worker: StatusWorker, label: string, system: SystemSnap | undefined, slots: number, cleaner: boolean): string {
  return JSON.stringify({
    id: worker.id,
    label,
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
    cpu: system?.cpuPercent,
    memory: system?.memory,
    disk: system?.disk,
  });
}

const WorkerCard = memo(function WorkerCard({
  worker,
  label,
  system,
  slots,
  cleaner,
}: {
  worker: StatusWorker;
  label: string;
  system?: SystemSnap;
  slots: number;
  cleaner: boolean;
}) {
  const kind = workerKindOf(worker);
  const kindMeta = getRenderKindMeta(worker.kind, worker.id);
  const status = String(worker.status || "idle");
  const local = kind === "local";
  const hasLocalCpu = local && system?.cpuPercent != null && Number.isFinite(Number(system.cpuPercent));
  const hasWorkerCpu = !local && worker.metrics?.load != null && Number.isFinite(Number(worker.metrics.load));
  const cpuLevel = hasLocalCpu
    ? Number(system!.cpuPercent) / 100
    : hasWorkerCpu && worker.metrics?.cpus
      ? Number(worker.metrics!.load) / Number(worker.metrics.cpus)
      : null;
  const ramFree = local
    ? system?.memory?.available != null && Number.isFinite(Number(system.memory.available))
      ? Number(system.memory.available)
      : null
    : worker.metrics?.mem_gb != null && Number.isFinite(Number(worker.metrics.mem_gb))
      ? Number(worker.metrics.mem_gb) * 1024 ** 3
      : null;
  const ramCap = local && system?.memory?.total && Number.isFinite(Number(system.memory.total)) ? Number(system.memory.total) : 0;
  const ramLevel = ramFree != null && ramCap > 0 ? pressureFromFree(ramFree, ramCap) : null;
  const diskFree = local
    ? system?.disk?.available != null && Number.isFinite(Number(system.disk.available))
      ? Number(system.disk.available)
      : null
    : worker.metrics?.disk_gb != null && Number.isFinite(Number(worker.metrics.disk_gb))
      ? Number(worker.metrics.disk_gb) * 1024 ** 3
      : null;
  const diskCap = local && system?.disk?.total && Number.isFinite(Number(system.disk.total)) ? Number(system.disk.total) : 0;
  const diskLevel = diskFree != null && diskCap > 0 ? pressureFromFree(diskFree, diskCap) : null;

  const cpuText = hasLocalCpu
    ? percent(system!.cpuPercent)
    : hasWorkerCpu
      ? worker.metrics?.cpus
        ? `${worker.metrics.load} / ${worker.metrics.cpus}`
        : String(worker.metrics!.load)
      : "Unknown";
  const ramText = local
    ? ramFree != null
      ? `${bytes(ramFree)} free`
      : "Unknown"
    : worker.metrics?.mem_gb != null
      ? `${worker.metrics.mem_gb} GB free`
      : "Unknown";
  const diskText = local
    ? diskFree != null
      ? `${bytes(diskFree)} free`
      : "Unknown"
    : worker.metrics?.disk_gb != null
      ? `${worker.metrics.disk_gb} GB free`
      : "Unknown";
  const probeText = typeof worker.probeMs === "number" ? `${Math.round(worker.probeMs)} ms` : age(worker.probedAt);
  const Icon = kind === "docker-sbx" ? Cloud : kind === "ssh" ? Server : Monitor;
  return (
    <article className="sr-row py-3" data-worker={worker.id} data-kind={kind}>
      <div className="min-w-0 flex-1">
      <div className="flex items-center gap-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-medium">{label}</h3>
        </div>
        <span className="flex items-center gap-2 text-sm text-muted-foreground"><span className={cn("size-2 rounded-full", status === "unavailable" ? "bg-destructive" : status === "busy" || status === "running" ? "bg-info" : "bg-border-strong")} aria-hidden />{status === "last-seen" ? "Offline" : titleCase(status)}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <MeterRow label="CPU" value={cpuText.replace("Unknown", "—")} level={cpuLevel} />
        <MeterRow label="RAM" value={ramText.replace("Unknown", "—").replace(" free", "")} level={ramLevel} />
        <MeterRow label="Disk" value={diskText.replace("Unknown", "—").replace(" free", "")} level={diskLevel} />
      </div>
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="flex min-h-11 cursor-pointer items-center gap-1 select-none">Details <ChevronDown className="size-4" aria-hidden /></summary>
        <dl className="grid grid-cols-2 gap-2 py-2 text-xs">
          <div><dd>{slots}</dd><dt>Slots</dt></div>
          <div><dd>{cleaner ? "On" : "Off"}</dd><dt>Cleaner</dt></div>
          <div><dd>{probeText}</dd><dt>Probe</dt></div>
          <div>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="break-all font-mono text-foreground">{worker.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Kind</dt>
            <dd className="text-foreground">{kindMeta.shortLabel}</dd>
          </div>
          {worker.boxStatus ? (
            <div>
              <dt className="text-muted-foreground">Sandbox</dt>
              <dd className="text-foreground">{worker.boxStatus}</dd>
            </div>
          ) : null}
          {worker.reason ? (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Note</dt>
              <dd className="text-foreground">{worker.reason}</dd>
            </div>
          ) : null}
        </dl>
        {worker.jobs?.length ? <RawDetails text={JSON.stringify(worker.jobs, null, 2)} /> : null}
        {worker.lastError ? <ErrorNotice error={worker.lastError} /> : null}
      </details>
      </div>
    </article>
  );
}, (prev, next) => workerCardSig(prev.worker, prev.label, prev.system, prev.slots, prev.cleaner) === workerCardSig(next.worker, next.label, next.system, next.slots, next.cleaner));

function MeterRow({ label, value, level }: { label: string; value: string; level: number | null }) {
  const known = level !== null && Number.isFinite(level);
  const clamped = known ? Math.max(0, Math.min(1, level)) : 0;
  const pct = Math.round(clamped * 100);
  const fillClass = pct >= 85 ? "bg-destructive" : pct >= 65 ? "bg-warning" : "bg-foreground/25";
  return (
    <Tooltip label={`${label}: ${value}`} side="top"><div tabIndex={0} className="min-w-0 text-xs text-muted-foreground" aria-label={`${label}: ${value}`}>
      <div className="mb-1.5 flex items-center gap-1.5">{label === "CPU" ? <Cpu className="size-4 shrink-0" aria-hidden /> : label === "RAM" ? <MemoryStick className="size-4 shrink-0" aria-hidden /> : <HardDrive className="size-4 shrink-0" aria-hidden />}<span className="truncate tabular-nums">{value}</span></div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? pct : undefined}
        aria-valuetext={value}
        className="h-1 overflow-hidden rounded-full bg-background"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-200", fillClass)} style={{ width: `${known ? pct : 0}%` }} />
      </div>
    </div></Tooltip>
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
  const retryUntil = Math.max(0, ...chapters.flatMap(([, row]) => Object.values(row.stages || {}).map((cell) => cell.retryAt || 0)));
  const now = useRetryClock(retryUntil);
  if (!chapters.length) return <p className="p-4 text-sm text-muted-foreground">No chapters</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-separate border-spacing-y-1 text-center text-xs">
        <caption className="sr-only">Chapter stage matrix</caption>
        <thead>
          <tr>
            <th className="w-7 py-2 text-muted-foreground"><span className="sr-only">Chapter</span></th>
            {order.map((stage) => (
              <th key={stage} className="py-2 text-[12px] font-normal text-muted-foreground">{STAGE_LABEL[stage] || titleCase(stage)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chapters.map(([chapter, row]) => (
            <tr key={chapter}>
              <th className="px-2 py-2 font-medium text-foreground" scope="row">
                {chapter.replace(/^ch/i, "")}
              </th>
              {order.map((stage) => {
                const cell = row.stages?.[stage] || { state: "pending" };
                const state = KNOWN_STATES.has(String(cell.state)) ? String(cell.state) : "pending";
                const detail = stageDetail(cell);
                const name = STAGE_LABEL[stage] || titleCase(stage);
                const tooltip = state === "warning" ? `${name} · ${cell.flagged ?? cell.findings ?? 0} notes`
                  : state === "retrying" ? `${name} · retry ${cell.attempt ?? 1} of ${cell.maxAttempts ?? 3} · ${retryCountdown(cell.retryAt || now, now)}${cell.note ? ` · ${parseFailureNote(cell.note).title}` : ""}`
                  : state === "failed" ? `${name} · ${parseFailureNote(cell.note).title}`
                  : `${name}: ${state}${detail ? ` · ${detail}` : ""}`;
                return (
                  <td key={stage}>
                    <Tooltip label={tooltip} side="top">
                      <button type="button" aria-label={`${chapter} ${stage}: ${state}`} className={cn("grid min-h-11 w-full place-items-center rounded-lg", stageTone(state))}>
                        {state === "warning" ? <><AlertTriangle className="size-4" strokeWidth={1.75} aria-hidden /><span className="sr-only">never blocks</span></> : state === "retrying" ? <RotateCw className="size-4" strokeWidth={1.75} aria-hidden /> : state === "done" || state === "completed" ? <Check className="size-4" strokeWidth={1.75} aria-hidden /> : state === "failed" || state === "interrupted" ? <X className="size-4" strokeWidth={1.75} aria-hidden /> : state === "running" || state === "busy" ? <LoaderCircle className="size-4 motion-safe:animate-spin" strokeWidth={1.75} aria-hidden /> : <span className={cn("size-1.5 rounded-full", state === "pending" || state === "idle" ? "bg-border-strong" : "bg-current")} aria-hidden />}
                      </button>
                    </Tooltip>
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
  if (state === "done" || state === "completed") return "text-success";
  if (state === "running" || state === "busy") return "text-info";
  if (state === "failed" || state === "interrupted") return "text-destructive";
  if (state === "queued" || state === "retrying" || state === "warning") return "text-warning";
  return "text-muted-foreground";
}

export default function StatusPage() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [lanes, setLanes] = useState<DeskLanes | null>(null);
  const [studioStages, setStudioStages] = useState<StagesState | null>(null);
  const [studioNodes, setStudioNodes] = useState<RenderNode[]>([]);
  const [intakeJobs, setIntakeJobs] = useState<JobRecord[]>([]);
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
  const [runControlBusy, setRunControlBusy] = useState<"" | "pause" | "resume" | "stop">("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlError, setControlError] = useState<{ error: unknown } | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const statusRef = useRef<DeskStatus | null>(null);
  const lanesRef = useRef<DeskLanes | null>(null);
  const statusSig = useRef("");
  const lanesSig = useRef("");
  const updatedRef = useRef<number | null>(null);
  const inFlight = useRef(false);
  const runControlLock = useRef(false);
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
      const [statusResult, lanesResult, studioResult, jobsResult] = await Promise.allSettled([
        api.status(),
        api.lanes.get(),
        api.studio.catalog(),
        api.intake.jobs(),
      ]);
      if (statusResult.status === "fulfilled") {
        const next = asStatus(statusResult.value);
        applyStatus(next);
        setConnError(next.stale ? `The collector is temporarily unavailable. Showing the last measurement from ${new Date(toMs(next.at || 0)).toLocaleTimeString()}.` : "");
        setConnection(pausedRef.current ? "Frozen" : next.stale ? "Reconnecting" : "Live · 5s");
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
      if (jobsResult.status === "fulfilled" && Array.isArray(jobsResult.value?.jobs)) {
        setIntakeJobs(jobsResult.value.jobs);
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

  function onEditorKey(event: KeyboardEvent<HTMLElement>) {
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
  const directRunJobId = useMemo(() => {
    if (!run) return "";
    if (typeof run.jobId === "string" && run.jobId.trim()) return run.jobId.trim();
    if (run.id && /^job-\d+-/.test(run.id)) return run.id;
    return "";
  }, [run]);
  const matchedJob = useMemo(() => {
    if (!run) return null;
    if (directRunJobId) {
      return intakeJobs.find((j) => j.id === directRunJobId) || null;
    }
    const runPid = typeof run.pid === "number" && Number.isFinite(run.pid) && run.pid > 0 ? run.pid : null;
    if (runPid !== null) {
      return (
        intakeJobs.find((j) => {
          const jobPid = typeof j.runPid === "number" ? j.runPid : typeof j.pid === "number" ? j.pid : null;
          return jobPid === runPid;
        }) || null
      );
    }
    return null;
  }, [run, directRunJobId, intakeJobs]);
  const runJobId = directRunJobId || matchedJob?.id || "";
  useEffect(() => { setSettingsOpen(false); }, [runJobId]);
  const retryNow = useRetryClock(matchedJob?.notBefore || 0);
  const waitingRetry = matchedJob?.status === "queued" && (matchedJob.notBefore || 0) > retryNow;
  const failures = buildFeed(run, issueOnly, (name) => STAGE_LABEL[name] || titleCase(name), waitingRetry ? `Retrying in ${retryCountdown(matchedJob!.notBefore!, retryNow)}` : undefined);
  const manage = useMemo(() => {
    if (!run) return "";
    if (runJobId) {
      const series = typeof run.series === "string" ? run.series.trim() : typeof run.slug === "string" ? run.slug.trim() : "";
      return series
        ? `/new-series.html?job=${encodeURIComponent(runJobId)}&series=${encodeURIComponent(series)}`
        : `/new-series.html?job=${encodeURIComponent(runJobId)}`;
    }
    return runHref(run);
  }, [run, runJobId]);
  const isRunPaused = matchedJob
    ? Boolean(matchedJob.paused || String(matchedJob.status || "").toLowerCase() === "paused")
    : Boolean(run?.paused || String(run?.state || "").toLowerCase() === "paused");
  const isRunPausing = !isRunPaused && Boolean(matchedJob?.pauseRequested);
  const pausedWhere = (matchedJob?.pausedWhere || run?.pausedWhere || "") as string;
  const pauseReason = isRunPaused ? String(matchedJob?.pauseReason || "") : "";
  const runEffectiveState = isRunPaused
    ? "paused"
    : isRunPausing ? "pausing" : waitingRetry ? "retrying" : String(matchedJob?.status || run?.state || "idle").toLowerCase();
  const isTerminalRun = ["completed", "done", "failed", "interrupted", "stopped", "cancelled"].includes(runEffectiveState);
  const advertisedControlActions = useMemo(() => {
    if (matchedJob && Array.isArray(matchedJob.controlActions)) {
      return matchedJob.controlActions.map((a) => String(a).toLowerCase());
    }
    if (Array.isArray(run?.controlActions)) {
      return run.controlActions.map((a) => String(a).toLowerCase());
    }
    if (matchedJob && Array.isArray(matchedJob.actions)) {
      return matchedJob.actions.map((a) => String(a).toLowerCase());
    }
    if (Array.isArray(run?.actions)) {
      return run.actions.map((a) => String(a).toLowerCase());
    }
    return null;
  }, [run, matchedJob]);
  const canPauseRun =
    !isRunPaused &&
    !isTerminalRun &&
    (advertisedControlActions !== null
      ? advertisedControlActions.includes("pause")
      : runEffectiveState === "running" || runEffectiveState === "queued" || Boolean(run?.alive));
  const canResumeRun =
    (isRunPaused || isRunPausing) &&
    (advertisedControlActions !== null ? advertisedControlActions.includes("resume") : isRunPaused);
  const canChangeSettings = Boolean(matchedJob && Array.isArray(matchedJob.actions) && matchedJob.actions.includes("settings"));
  const canStopRun =
    !isTerminalRun &&
    (advertisedControlActions !== null
      ? advertisedControlActions.includes("stop") || advertisedControlActions.includes("cancel")
       : isRunPaused || waitingRetry || runEffectiveState === "running" || runEffectiveState === "queued" || Boolean(run?.alive));
  const needsRecovery = run ? ["failed", "interrupted"].includes(runEffectiveState) : false;
  const envDisabled = lanes?.renderRuntime?.policy?.envEnabledButDisabled || [];
  const conflictRev = conflict?.currentRevision ?? lanes?.revision ?? draftBase;

  useEffect(() => {
    setStopConfirm(false);
  }, [runJobId, runEffectiveState]);

  async function handleRunControl(action: "pause" | "resume" | "stop") {
    if (!privileged || !runJobId || runControlLock.current) return;
    runControlLock.current = true;
    setRunControlBusy(action);
    setControlError(null);
    setStopConfirm(false);
    setEditorError("");
    try {
      const res =
        action === "pause"
          ? await api.intake.pauseJob(runJobId)
          : action === "resume"
            ? await api.intake.resumeJob(runJobId)
            : await api.intake.stopJob(runJobId);
      if (res?.job) {
        setIntakeJobs((current) => {
          const exists = current.some((j) => j.id === res.job.id);
          return exists ? current.map((j) => (j.id === res.job.id ? res.job : j)) : [res.job, ...current];
        });
      }
      const name = run?.title || run?.series || runJobId;
      setBanner(
        action === "pause"
          ? res?.job?.pauseRequested && !res.job.paused ? `Pausing ${name} after the current step.` : `Paused ${name}.`
          : action === "resume"
            ? isRunPausing ? `Pause cancelled for ${name}.` : `Resumed ${name}.`
            : `Stopped ${run?.title || run?.series || runJobId}.`,
      );
      await refresh(true);
    } catch (error) {
      setControlError({ error });
    } finally {
      runControlLock.current = false;
      setRunControlBusy("");
    }
  }

  return (
    <AppShell
      active="status"
      eyebrow="Workspace"
      title="Pipeline"
      actions={(
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" role="status">{connection.startsWith("Live") ? "Live" : connection}</span>
          <Tooltip label={paused ? "Unfreeze view" : "Freeze view"} side="bottom"><Button
            type="button"
            variant="outline"
            className="size-11 p-0"
            aria-pressed={paused}
            aria-label={paused ? "Unfreeze view" : "Freeze view"}
            onClick={() => {
              const next = !paused;
              setPaused(next);
              pausedRef.current = next;
              setConnection(next ? "Frozen" : status?.stale ? "Reconnecting" : "Live · 5s");
              if (!next) void refresh(true);
            }}
          >
            {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
          </Button></Tooltip>
          <Tooltip label="Refresh" side="bottom"><Button type="button" variant="outline" className="size-11 p-0" aria-label="Refresh dashboard" disabled={refreshing} onClick={() => void refresh(true)}>
            <RefreshCw className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </Button></Tooltip>
        </div>
      )}
    >
      <div className="flex flex-col gap-6">
        <header className="studio-heading">
          <div>
            <h1>Pipeline</h1>
          </div>
        </header>
        {connError ? <ErrorNotice error={connError} onRetry={() => void refresh(true)} /> : null}

        <section className="rounded-[24px] bg-card p-5" aria-labelledby="runHeading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span id="runHeading" className="sr-only">Run</span>
            {(status?.runs || []).length > 1 ? (
              <label className="text-sm">
                <span className="sr-only">Select pipeline run</span>
                <select
                  className="field min-h-10 w-auto rounded-full"
                  value={run?.id || ""}
                  aria-label="Select pipeline run"
                  onChange={(event) => setSelectedRun(event.target.value)}
                >
                  {(status?.runs || []).map((item) => (
                    <option key={item.id} value={item.id}>{item.title || item.id}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {!run ? (
            <p className="text-sm text-muted-foreground">No active run</p>
          ) : (
            <div className="mt-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(status?.runs || []).length <= 1 ? <h3 className="text-2xl font-semibold tracking-[-0.015em]">{run.title || run.series || run.id}</h3> : null}
                    <span className={cn("flex items-center gap-2 text-sm", waitingRetry ? "text-warning" : "text-muted-foreground")}><span className={cn("size-2 rounded-full", waitingRetry ? "bg-warning" : runEffectiveState === "running" ? "bg-info" : runEffectiveState === "failed" ? "bg-destructive" : runEffectiveState === "pausing" || runEffectiveState === "paused" ? "bg-warning" : "bg-border-strong")} aria-hidden /><span role="status" aria-live="polite">{isRunPausing ? "Pausing…" : titleCase(runEffectiveState)}</span>{waitingRetry ? <span role="timer">{retryCountdown(matchedJob!.notBefore!, retryNow)}</span> : null}</span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground tabular-nums">{run.completed ?? 0} of {run.total ?? 0} chapters</p>
              </div>
              {isRunPausing ? (
                <p className="mt-2 text-sm text-muted-foreground">Finishing the current step, then pausing.</p>
              ) : isRunPaused && (pausedWhere || pauseReason) ? (
                <div className="mt-2 text-sm">
                  {pausedWhere ? <p>Paused at <span className="font-mono">{pausedWhere}</span></p> : null}
                  {pauseReason ? <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">{pauseReason}</p> : null}
                </div>
              ) : null}
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-background" role="progressbar" aria-label="Completed chapters" aria-valuemin={0} aria-valuemax={Math.max(1, run.total || 1)} aria-valuenow={run.completed || 0}>
                <i className="block h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <RunTotals run={run} />
              <div className="flex flex-wrap items-center gap-2">
                {manage ? (
                  <Tooltip label={needsRecovery ? "Recover run" : "Manage run"} side="top"><a className="grid size-11 place-items-center rounded-full bg-background text-muted-foreground" href={manage} aria-label={needsRecovery ? "Recover run" : "Manage run"}>
                    <Settings2 className="size-[18px]" strokeWidth={1.75} aria-hidden />
                  </a></Tooltip>
                ) : null}
                {privileged && runJobId ? (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active run controls">
                    {isRunPaused || isRunPausing ? (
                      <Tooltip label={isRunPausing ? "Cancel pause" : "Resume"} side="top"><Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="size-11 p-0"
                        aria-label={isRunPausing ? "Cancel pause" : "Resume run"}
                        disabled={!canResumeRun || Boolean(runControlBusy)}
                        onClick={() => void handleRunControl("resume")}
                      >
                        <Play className="size-[18px]" strokeWidth={1.75} aria-hidden />
                      </Button></Tooltip>
                    ) : (
                      <Tooltip label="Pause" side="top"><Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="size-11 p-0"
                        aria-label="Pause run"
                        disabled={!canPauseRun || Boolean(runControlBusy)}
                        onClick={() => void handleRunControl("pause")}
                      >
                        <Pause className="size-[18px]" strokeWidth={1.75} aria-hidden />
                      </Button></Tooltip>
                    )}
                    {canChangeSettings ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11"
                        disabled={Boolean(runControlBusy)}
                        onClick={() => setSettingsOpen(true)}
                      >
                        Change settings
                      </Button>
                    ) : null}
                    {stopConfirm ? (
                      <div className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label="Confirm stop run">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="min-h-11 md:min-h-8"
                          disabled={Boolean(runControlBusy)}
                          onClick={() => void handleRunControl("stop")}
                        >
                          {runControlBusy === "stop" ? "Stopping…" : "Confirm stop"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="min-h-11 md:min-h-8"
                          disabled={Boolean(runControlBusy)}
                          onClick={() => setStopConfirm(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Tooltip label="Stop" side="top"><Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="size-11 p-0"
                        aria-label="Stop run"
                        disabled={!canStopRun || Boolean(runControlBusy)}
                        onClick={() => setStopConfirm(true)}
                      >
                        <Square className="size-[18px]" strokeWidth={1.75} aria-hidden />
                      </Button></Tooltip>
                    )}
                  </div>
                ) : null}
              </div>
              </div>
            </div>
          )}
        </section>

        {controlError ? <ErrorNotice error={controlError.error} /> : null}
        {run ? <LaneHealth run={run} privileged={privileged} onLaneReset={() => void refresh(true)} /> : null}

        <section aria-labelledby="matrixHeading">
          <h2 id="matrixHeading" className="sr-section-label">Chapters</h2>
          <div className="sr-group p-2">
            {run ? <ChapterMatrix run={run} order={order} /> : <p className="text-sm text-muted-foreground">Waiting for a run.</p>}
          </div>
        </section>

        <section aria-labelledby="callsHeading">
          <h2 id="callsHeading" className="sr-section-label">In progress</h2>
          <ul className="sr-group">
            {calls.length ? calls.map((call) => <li key={`${call.series}-${call.provider}-${call.model}-${call.startedAt}-${call.tag}`} className="sr-row py-3">
              <LoaderCircle className="size-[18px] shrink-0 text-info motion-safe:animate-spin" strokeWidth={1.75} aria-hidden />
              <div className="min-w-0 flex-1"><p className="truncate text-sm">{call.provider || "Model"}<span className="ml-2 text-muted-foreground">{call.chapter || call.tag}</span></p><p className="truncate text-xs text-muted-foreground">{call.model}</p></div>
              <span className="text-sm tabular-nums text-muted-foreground"><Elapsed startedAt={call.startedAt} /></span>
              <Tooltip label={[call.role, call.series, call.attempt ? `Attempt ${call.attempt}` : ""].filter(Boolean).join(" · ")} side="top"><button type="button" className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground" aria-label="Request details"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
            </li>) : <li className="p-4 text-sm text-muted-foreground">No requests</li>}
          </ul>
        </section>

        <section aria-labelledby="failuresHeading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="failuresHeading" className="sr-section-label">{issueOnly ? "Problems" : "Activity"}</h2>
            <label className="text-sm">
              <span className="sr-only">Filter activity</span>
              <select className="field min-h-10 w-auto rounded-full" value={issueOnly ? "issues" : "all"} aria-label="Filter activity" onChange={(event) => setIssueOnly(event.target.value === "issues")}>
                <option value="issues">Problems only</option>
                <option value="all">All events</option>
              </select>
            </label>
          </div>
          {failures.length ? (
            <ul className="sr-group mt-3" role="log" aria-live="off" aria-relevant="additions">
              {failures.map((item, index) => <FeedRow key={`${item.at || 0}-${index}`} item={item} />)}
            </ul>
          ) : (
            <p className="mt-3 rounded-[22px] bg-card px-4 py-5 text-[14.5px] text-muted-foreground">
              {issueOnly ? "No problems" : "No activity"}
            </p>
          )}
        </section>

        <section aria-labelledby="workersHeading">
          <h2 id="workersHeading" className="sr-section-label">Workers</h2>
          <div className="sr-group">
            {(status?.workers || []).map((worker) => {
              const policy = lanes?.config?.render?.find((row) => row.id === worker.id);
              const cat = lanes?.catalog?.render?.find((row) => row.id === worker.id);
              const customNode = studioNodes.find((row) => row.id === worker.id);
              return <WorkerCard key={worker.id} worker={worker} label={conciseNodeLabel(customNode?.label || cat?.label, worker.kind, worker.id)} system={status?.system} slots={policy?.slots ?? customNode?.slots ?? worker.slots ?? cat?.defaultSlots ?? 1} cleaner={Boolean(customNode?.supportsCleaner ?? worker.supportsCleaner ?? cat?.supportsCleaner)} />;
            })}
            {!status?.workers?.length ? <p className="p-4 text-sm text-muted-foreground">No workers</p> : null}
          </div>
        </section>

        <details className="sr-group" onKeyDown={onEditorKey} onToggle={(event) => { if (event.currentTarget.open && !renderOpen && !modelOpen && privileged) toggleEditor("render"); }}>
          <summary id="policyHeading" className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 text-[15px] font-medium"><Settings2 className="size-5 text-muted-foreground" strokeWidth={1.75} aria-hidden /><span className="flex-1">Lane priority</span><ChevronDown className="size-[18px] text-muted-foreground" strokeWidth={1.75} aria-hidden /></summary>
          <div className="px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
            </div>
            <div className="flex gap-2">
              <a className="inline-flex min-h-11 items-center text-sm text-primary-text md:min-h-8" href="?settings=routing">Edit stage routing</a>
              {privileged ? (
                <>
                  <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" aria-expanded={renderOpen} aria-controls="renderConfigPanel" onClick={() => toggleEditor("render")}>{renderOpen ? "Close" : "Configure"}</Button>
                  <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" aria-expanded={modelOpen} aria-controls="modelConfigPanel" onClick={() => toggleEditor("model")}>{modelOpen ? "Close models" : "Models"}</Button>
                </>
              ) : lanes ? <span className="rounded-full border border-warning/40 px-3 py-1 text-xs text-warning">Temporary account · read-only</span> : null}
            </div>
          </div>
          {lanesError ? (
            <ErrorNotice className="mt-3" error={lanesError} onRetry={() => void refresh(true)} />
          ) : null}
          {banner ? (
            <Notice className="mt-3" tone="success" title="Saved" details={<RawDetails text={banner} />} onDismiss={() => setBanner("")} />
          ) : null}
          {studioStages?.persisted || (studioStages?.reader?.chain?.length ?? 0) > 0 || (studioStages?.writer?.chain?.length ?? 0) > 0 ? (
            <details className="mt-3 text-sm text-muted-foreground">
              <summary className="flex min-h-11 cursor-pointer items-center">Routing</summary>
              <RawDetails text={`Reader: ${studioStages?.reader?.primary || studioStages?.reader?.chain?.[0] || "default"}\nWriter: ${studioStages?.writer?.primary || studioStages?.writer?.chain?.[0] || "default"}`} />
              <a
                className="inline-flex min-h-9 items-center font-medium text-primary-text underline"
                href="?settings=routing"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  navigateClient("?settings=routing");
                }}
              >
                Edit stage routing
              </a>
            </details>
          ) : null}
          {lanes && !renderOpen && !modelOpen ? <PolicySummary lanes={lanes} customNodes={studioNodes} workers={status?.workers || []} /> : null}
          {envDisabled.length ? (
            <Notice className="mt-2" tone="warning" title="Lane disabled" details={<RawDetails text={envDisabled.join(", ")} />} />
          ) : null}
          {conflict ? (
            <Notice className="mt-3" tone="danger" title="Settings changed" details={<RawDetails text={`${conflict.message} Server revision ${conflictRev}; draft ${draftBase}.`} />}>
              <div className="mt-2 flex flex-wrap gap-2">
                <a className="inline-flex min-h-11 items-center underline" href="?settings=routing">Edit stage routing</a>
                <Button type="button" className="min-h-11" onClick={() => {
                  if (Number.isInteger(conflictRev)) setDraftBase(Number(conflictRev));
                  setConflict(null);
                  setEditorError("");
                }}>Review & keep draft</Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void reloadServer()}>Reload server settings</Button>
              </div>
            </Notice>
          ) : null}
          {editorError ? <ErrorNotice className="mt-3" error={editorError} /> : null}
          {boundsNote ? <Notice className="mt-2" tone="warning" title="Value adjusted" details={<RawDetails text={boundsNote} />} /> : null}
          {renderOpen && draft ? (
            <div id="renderConfigPanel" className="mt-3" role="region" aria-labelledby="renderEditorHeading">
              <h3 id="renderEditorHeading" className="text-lg font-medium">Render lanes</h3>
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
                  const rowLabel = conciseNodeLabel(customNode?.label || cat?.label, customNode?.kind ?? cat?.kind, row.id);
                  const min = cat?.minSlots ?? 1;
                  const max = cat?.maxSlots ?? (customNode ? maxSlotsForKind(customNode.kind) : Math.max(min, 8));
                  const rank = row.enabled ? draft.render.slice(0, index + 1).filter((item) => item.enabled).length : 0;
                  return (
                    <SortableItem key={row.id} value={row.id} className="sr-row flex-col items-stretch rounded-none border-0 bg-transparent p-3" data-render-lane={row.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Tooltip label="Reorder" side="top"><span className="inline-flex"><SortableHandle className="size-11" aria-label={`Reorder ${rowLabel}`} /></span></Tooltip>
                        <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                          {row.enabled ? (rank === 1 ? "Primary" : `Fallback ${rank - 1}`) : "Off"}
                        </span>
                        <strong>{rowLabel}</strong>
                        {cat?.costTier === "paid-opt-in" ? <span className="text-xs text-warning">Paid opt-in</span> : null}
                      </div>
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
                            className="ml-2 min-h-11 w-20 rounded-xl bg-card px-2 text-center font-mono text-base"
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
            <div id="modelConfigPanel" className="mt-3">
              <h3 className="text-xl font-semibold tracking-[-0.01em]">Model priority</h3>
              {(["vision", "writer"] as const).map((role) => (
                <div key={role} className="mt-3" data-model-role={role}>
                  <h4 className="text-[14px] font-semibold text-muted-foreground">{role}</h4>
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
                        <SortableItem key={row.id} value={row.id} className="sr-row flex-col items-stretch rounded-none border-0 bg-transparent p-3" data-model-lane={row.id} data-role={role}>
                          <div className="flex items-center gap-2">
                            <Tooltip label="Reorder" side="top"><span className="inline-flex"><SortableHandle className="size-11" aria-label={`Reorder ${cat?.label || row.id}`} /></span></Tooltip>
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
                                className="ml-2 min-h-11 w-20 rounded-xl bg-card px-2 text-center font-mono text-base"
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
          </div>
        </details>

        <span className="sr-only"><PollStamp updatedRef={updatedRef} /></span>
      </div>
      <RunSettingsDialog
        job={matchedJob}
        open={settingsOpen && Boolean(matchedJob)}
        privileged={privileged}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved, resumed) => {
          if (saved?.id) setIntakeJobs((current) => current.map((j) => (j.id === saved.id ? saved : j)));
          setBanner(resumed ? `Saved settings and resumed ${run?.title || run?.series || runJobId}.` : "Settings saved.");
          void refresh(true);
        }}
      />
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
    <p className="mt-3 text-xs text-muted-foreground">
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
          <li key={row.id} className={cn("rounded-full border px-3 py-1 text-xs", row.enabled ? "border-success/40 text-success" : "border-border text-muted-foreground")}>
            {row.enabled ? (rank === 1 ? "Primary" : `Fallback ${rank - 1}`) : "Off"} · {conciseNodeLabel(customNode?.label || cat?.label, customNode?.kind ?? cat?.kind, row.id)} · {row.slots} slot{row.slots === 1 ? "" : "s"}
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
        <div className="mb-3 rounded-2xl bg-warning-soft px-4 py-3 text-[14.5px] text-foreground" role="alert">
          <p>Saving this policy will disable environment-enabled render lanes: {affected.join(", ")}.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" disabled={saving} onClick={onKeepEnv}>Keep enabled & save</Button>
            <Button type="button" variant="destructive" className="min-h-11" disabled={saving} onClick={onConfirmSave}>Confirm save</Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onCancelConfirm}>Back to draft</Button>
          </div>
        </div>
      ) : null}
      {resetConfirm ? (
        <div className="mb-3 rounded-2xl bg-destructive-soft px-4 py-3 text-[14.5px] text-foreground" role="alert">
          <p>Reset render and model lane policy to factory defaults? Applies to new runs only.</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="destructive" className="min-h-11" disabled={saving} onClick={onReset}>Confirm reset</Button>
            <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onCancelReset}>Keep current</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Base revision {base}{dirty ? " · Unsaved draft edits" : " · Saved state"}</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onResetAsk}>Reset to defaults</Button>
          <Button type="button" variant="ghost" className="min-h-11" disabled={saving} onClick={onCancel}>Cancel</Button>
          <Button type="button" className="min-h-11" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}
