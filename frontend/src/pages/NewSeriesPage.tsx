import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Cloud, Link2, Monitor, RefreshCw, Server, Upload, X } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Dropzone } from "@/components/ui/dropzone";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/ui/stepper";
import { Terminal, TerminalBody, TerminalHeader, TerminalLine } from "@/components/ui/terminal";
import {
  api,
  getCsrfToken,
  isApiError,
  type IntakeCatalog,
  type JobsList,
  type OutroConfigInput,
  type OutroHookType,
  type RenderNode,
  type RenderQuality,
} from "@/lib/api";
import { parseDriveId } from "@/lib/driveUrl";
import {
  DEFAULT_LANE_ID,
  inferLaneKind,
  LANE_ID_RE,
  RENDER_KIND_META,
  type RenderLaneKind,
} from "@/lib/renderLanes";
import { cn } from "@/lib/utils";

/**
 * Create a Series.
 * ZIP bytes stream to POST /api/intake/jobs?sourceType=upload (the intake upload
 * route). There is no /api/intake/upload alias on the server.
 */

const ACTIVE_JOB_KEY = "screeningroom.intake.activeJob";
const STAGE_ORDER = ["download", "extract", "pipeline"] as const;
const RESTORE_STATUSES = new Set(["queued", "downloading", "ingesting", "running", "paused", "failed", "interrupted"]);
const ACTIVE_STATUSES = new Set(["queued", "downloading", "ingesting", "running", "paused"]);
const CHAPTERS_RE = /^(all|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LANE = DEFAULT_LANE_ID;
const MAX_ZIP_FALLBACK = 1536 * 1024 * 1024;
const BG_LABELS: Record<string, string> = {
  starfield: "Starfield",
  "storm-valley": "Storm Valley",
  "mist-pines": "Mist Pines",
};
const MOTION_LABELS: Record<string, string> = { cut: "Cut", duo: "Duo" };
const STEPS = [
  { title: "Source" },
  { title: "Voice & style" },
  { title: "Launch" },
] as const;

type SourceMode = "gdrive" | "upload";
type LaneKind = RenderLaneKind;
type FieldName = "title" | "slug" | "gdrive" | "file" | "voice" | "chapters" | "renderLane";
type FieldErrors = Partial<Record<FieldName, string>>;
type JobAction = "retry" | "continue" | "cancel" | "stop" | "pause" | "resume";

interface VoiceOption {
  id: string;
  label: string;
  default: boolean;
}

interface CatalogProvider {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string;
  costNotice: string;
  engine: string;
  voices: VoiceOption[];
}

interface LaneOption {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  kind: LaneKind;
}

interface JobProgress {
  phase?: string;
  percent?: number | null;
  loadedBytes?: number | null;
  totalBytes?: number | null;
  chapter?: string;
  chapterIndex?: number | null;
  chapterTotal?: number | null;
  totalChapters?: number | null;
  completedChapters?: number | null;
  chaptersCompleted?: number | null;
}

interface IntakeJob {
  id: string;
  status?: string;
  paused?: boolean;
  stage?: string;
  title?: string;
  slug?: string;
  error?: string | null;
  statusNote?: string;
  chapters?: string;
  sourceType?: string;
  renderLane?: string;
  updatedAt?: number;
  createdAt?: number;
  startedAt?: number;
  ingestedChapters?: string[];
  logTail?: string[];
  actions?: string[];
  controlActions?: string[];
  statusUrl?: string;
  libraryUrl?: string;
  progress?: JobProgress;
  tts?: { voiceLabel?: string; voiceId?: string; providerLabel?: string };
}

interface UploadState {
  active: boolean;
  phase: string;
  loaded: number;
  total: number | null;
  pct: number | null;
}

const IDLE_UPLOAD: UploadState = { active: false, phase: "", loaded: 0, total: null, pct: null };

function errText(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed";
}

function slugify(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\.(zip|cbz)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/g, "");
}

function fmtBytes(n: number): string {
  const value = Number(n) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function fmtAge(ts: number | undefined): string {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - Number(ts)));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

function cleanVoiceName(label: string): string {
  return String(label || "").replace(/\s*\([^)]*\)/g, "").trim() || String(label || "");
}

function statusOf(job: IntakeJob | null | undefined): string {
  if (job?.paused === true || job?.status === "paused") return "paused";
  return String(job?.status || "queued").toLowerCase();
}

function normalizeLaneId(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return LANE_ID_RE.test(value) ? value : DEFAULT_LANE;
}

function kindOf(id: string, nodeKind?: string): LaneKind {
  return inferLaneKind(id, nodeKind);
}

function maxZipBytes(catalog: IntakeCatalog | null): number {
  const limits = catalog?.limits;
  if (limits && typeof limits === "object" && "maxZipBytes" in limits) {
    const n = Number((limits as { maxZipBytes?: unknown }).maxZipBytes);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return MAX_ZIP_FALLBACK;
}

function asProviders(catalog: IntakeCatalog | null): CatalogProvider[] {
  if (!catalog || !Array.isArray(catalog.providers)) return [];
  return catalog.providers.flatMap((item) => {
    const id = String(item.id || "").trim();
    if (!id) return [];
    const voices = Array.isArray(item.voices)
      ? item.voices.flatMap((voice) => {
          if (!voice || typeof voice !== "object") return [];
          const record = voice as Record<string, unknown>;
          const voiceId = String(record.id || "").trim();
          if (!voiceId) return [];
          return [{ id: voiceId, label: String(record.label || voiceId), default: record.default === true }];
        })
      : [];
    return [{
      id,
      label: String(item.label || id),
      available: item.available !== false,
      unavailableReason: typeof item.unavailableReason === "string" ? item.unavailableReason : "",
      costNotice: typeof item.costNotice === "string" ? item.costNotice : "",
      engine: typeof item.engine === "string" ? item.engine : id,
      voices,
    }];
  });
}

function catalogLaneRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  }
  return [];
}

function buildLanes(catalog: IntakeCatalog | null, nodes: RenderNode[]): LaneOption[] {
  const byId = new Map<string, LaneOption>();
  for (const item of catalogLaneRows(catalog?.renderLanes)) {
    const id = String(item.id || "").trim().toLowerCase();
    if (!LANE_ID_RE.test(id)) continue;
    const node = nodes.find((entry) => entry.id.toLowerCase() === id);
    byId.set(id, {
      id,
      label: String(item.label || node?.label || id),
      available: id === DEFAULT_LANE ? true : item.available !== false,
      unavailableReason: id === DEFAULT_LANE ? null : typeof item.unavailableReason === "string" ? item.unavailableReason : null,
      kind: kindOf(id, typeof item.kind === "string" ? item.kind : node?.kind),
    });
  }
  for (const node of nodes) {
    const id = node.id.trim().toLowerCase();
    if (!LANE_ID_RE.test(id)) continue;
    const existing = byId.get(id);
    const disabled = node.enabled === false;
    if (existing) {
      byId.set(id, { ...existing, kind: kindOf(id, node.kind), label: existing.label || node.label });
    } else {
      byId.set(id, {
        id,
        label: node.label || id,
        available: !disabled,
        unavailableReason: disabled ? "disabled in render-nodes.json" : null,
        kind: kindOf(id, node.kind),
      });
    }
  }
  if (!byId.has(DEFAULT_LANE)) {
    byId.set(DEFAULT_LANE, { id: DEFAULT_LANE, label: "Auto", available: true, unavailableReason: null, kind: "inherit" });
  }
  const inherit = byId.get(DEFAULT_LANE)!;
  const rest = [...byId.values()].filter((lane) => lane.id !== DEFAULT_LANE);
  return [inherit, ...rest];
}

function defaultLaneId(catalog: IntakeCatalog | null, lanes: LaneOption[]): string {
  const caps = catalog?.capabilities;
  const raw = caps && typeof caps === "object" ? (caps as { renderLane?: { default?: unknown } }).renderLane?.default : undefined;
  const preferred = normalizeLaneId(raw || DEFAULT_LANE);
  return lanes.find((lane) => lane.id === preferred && lane.available)?.id || lanes.find((lane) => lane.available)?.id || DEFAULT_LANE;
}

function isPaidExternal(provider: CatalogProvider | null): boolean {
  if (!provider) return false;
  const engine = provider.engine.toLowerCase();
  return engine !== "edge" && engine !== "edge-tts";
}

function normalizeChapters(raw: string): { ok: true; spec: string } | { ok: false; error: string } {
  const spec = String(raw || "").trim().toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s*-\s*/g, "-");
  if (!spec) return { ok: false, error: "Enter a chapter range, for example 2-5, or “all”." };
  if (!CHAPTERS_RE.test(spec)) return { ok: false, error: "Use “all”, a range like 2-5, or a list like 1,2,3." };
  for (const part of spec.split(",")) {
    if (part === "all") continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!(a >= 1) || !(b >= a)) return { ok: false, error: `“${part}” is not a valid range. Use 2-5.` };
    } else if (!(Number(part) >= 1)) {
      return { ok: false, error: `“${part}” is not a valid chapter number.` };
    }
  }
  return { ok: true, spec };
}

function transferStage(job: IntakeJob): (typeof STAGE_ORDER)[number] {
  const status = statusOf(job);
  const phase = String(job.progress?.phase || job.stage || "").toLowerCase();
  if (STAGE_ORDER.includes(phase as (typeof STAGE_ORDER)[number])) return phase as (typeof STAGE_ORDER)[number];
  if (status === "failed") {
    if (Array.isArray(job.ingestedChapters) && job.ingestedChapters.length) return "pipeline";
    if (job.sourceType === "upload") return "extract";
    return "download";
  }
  const map: Record<string, (typeof STAGE_ORDER)[number]> = {
    queued: "download",
    downloading: "download",
    ingesting: "extract",
    running: "pipeline",
    completed: "pipeline",
    interrupted: "pipeline",
  };
  return map[status] || "download";
}

function downloadProgress(job: IntakeJob): { loaded: number; total: number | null } | null {
  const progress = job.progress;
  if (progress && typeof progress === "object") {
    const loaded = Number(progress.loadedBytes);
    const total = Number(progress.totalBytes);
    if (Number.isFinite(loaded) && loaded >= 0) {
      return { loaded, total: Number.isFinite(total) && total > 0 ? total : null };
    }
  }
  const match = /\(([\d.]+)\s*MB\)/.exec(String(job.statusNote || ""));
  if (match) return { loaded: Math.round(Number(match[1]) * 1024 * 1024), total: null };
  return null;
}

function pipelineProgress(job: IntakeJob): { chapter: string | null; index: number | null; total: number | null; completed: number | null } | null {
  const progress = job.progress;
  if (!progress) return null;
  const index = progress.chapterIndex != null && Number.isFinite(Number(progress.chapterIndex)) ? Number(progress.chapterIndex) : null;
  const rawTotal = progress.totalChapters ?? progress.chapterTotal;
  const total = rawTotal != null && Number.isFinite(Number(rawTotal)) && Number(rawTotal) > 0 ? Number(rawTotal) : null;
  const rawCompleted = progress.completedChapters ?? progress.chaptersCompleted;
  const completed = rawCompleted != null && Number.isFinite(Number(rawCompleted)) && Number(rawCompleted) >= 0 ? Number(rawCompleted) : null;
  if (index === null && total === null && completed === null) return null;
  return {
    chapter: typeof progress.chapter === "string" && progress.chapter.trim() ? progress.chapter.trim() : null,
    index,
    total,
    completed,
  };
}

function friendlyJobError(job: IntakeJob): string {
  const raw = String(job.error || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (/quota|too many users have viewed|rate limit|429/.test(lower)) {
    return `Download limit reached: ${raw} Retry in a few hours, or upload the ZIP instead.`;
  }
  if (/not found|404|permission|access denied|private/.test(lower)) {
    return `The link is not publicly readable: ${raw} Set the ZIP to “Anyone with the link”, then retry.`;
  }
  if (/already exists|never overwritten/.test(lower)) {
    return `That series folder already exists: ${raw} Choose a different slug.`;
  }
  if (/zip|archive|corrupt|invalid/.test(lower)) {
    return `The archive could not be read: ${raw} Re-export the ZIP and try again.`;
  }
  return raw;
}

function canAction(job: IntakeJob, action: JobAction, privileged: boolean, unsupported: Set<string>): boolean {
  const controlAction = action === "cancel" ? "stop" : action;
  if (!privileged || unsupported.has(`${job.id}:${action}`) || unsupported.has(`${job.id}:${controlAction}`)) return false;
  const status = statusOf(job);
  if (action === "continue") {
    const hasChapters = (job.ingestedChapters?.length ?? 0) > 0 || status === "completed";
    if (!hasChapters) return false;
    if (Array.isArray(job.actions) && job.actions.includes("continue")) return true;
    return status === "completed" || status === "interrupted" || status === "failed";
  }
  const isControl = action === "pause" || action === "resume" || action === "stop" || action === "cancel";
  if (isControl && Array.isArray(job.controlActions)) {
    return job.controlActions.includes(controlAction) || (controlAction === "stop" && job.controlActions.includes("cancel"));
  }
  if (action === "pause") return status === "running" || status === "queued";
  if (action === "resume") return status === "paused";
  if (action === "stop" || action === "cancel") return ACTIVE_STATUSES.has(status);
  if (Array.isArray(job.actions) && job.actions.includes(action)) return true;
  if (action === "retry") return status === "failed" || status === "interrupted";
  return false;
}

function externalRuns(list: JobsList): Array<{ series?: string }> {
  const raw = list.externalRuns;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object") as Array<{ series?: string }>;
}

function readStoredJob(): string {
  try {
    return localStorage.getItem(ACTIVE_JOB_KEY) || "";
  } catch {
    return "";
  }
}

function storeActiveJob(id: string): void {
  try {
    if (id) localStorage.setItem(ACTIVE_JOB_KEY, id);
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* Storage can be blocked. The in-memory selection still works. */
  }
}

function readQuery(): { job: string; series: string } | null {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const job = (params.get("job") || "").trim();
    const series = (params.get("series") || "").trim().toLowerCase();
    if (!job && !series) return null;
    return { job, series };
  } catch {
    return null;
  }
}

function jobScore(job: IntakeJob): number {
  for (const key of ["updatedAt", "createdAt", "startedAt"] as const) {
    const value = Number(job[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const match = /^job-(\d+)-/.exec(job.id);
  return match ? Number(match[1]) : 0;
}

function findJob(query: { job: string; series: string }, jobs: IntakeJob[]): IntakeJob | null {
  if (query.job) {
    const byId = jobs.find((job) => job.id === query.job);
    if (byId) return byId;
  }
  if (query.series) {
    const matches = jobs.filter((job) => String(job.slug || "").trim().toLowerCase() === query.series);
    matches.sort((a, b) => jobScore(b) - jobScore(a));
    return matches[0] || null;
  }
  return null;
}

function laneLabel(id: string, lanes: LaneOption[]): string {
  const lane = lanes.find((item) => item.id === id);
  const label = lane?.label || id;
  return id === DEFAULT_LANE ? label : `${label} only`;
}

function fmtAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return (
    <p id={id} hidden={!message} className="mt-1 text-sm text-[#f0a096]" role="alert">
      {message || ""}
    </p>
  );
}

function LaneIcon({ kind }: { kind: LaneKind }) {
  if (kind === "docker-sbx") return <Cloud className="size-3.5" aria-hidden />;
  if (kind === "ssh") return <Server className="size-3.5" aria-hidden />;
  if (kind === "local") return <Monitor className="size-3.5" aria-hidden />;
  return null;
}

function VoicePreview({
  provider,
  voice,
  privileged,
}: {
  provider: CatalogProvider | null;
  voice: VoiceOption | null;
  privileged: boolean;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [spendOk, setSpendOk] = useState(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const paid = isPaidExternal(provider);
  const blocked = !privileged || Boolean(provider && !provider.available);

  useEffect(() => {
    gen.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setSrc("");
    setError("");
    setBusy(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSpendOk(false);
  }, [provider?.id, voice?.id]);

  useEffect(() => {
    const onHide = () => {
      if (!document.hidden) return;
      gen.current += 1;
      abortRef.current?.abort();
      audioRef.current?.pause();
      setBusy(false);
      setPlaying(false);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      gen.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  async function listen() {
    if (!provider || !voice || busy) return;
    if (!privileged) return;
    if (!provider.available) {
      setError(`${provider.label} is unavailable: ${provider.unavailableReason || "not configured"}`);
      return;
    }
    if (paid && !spendOk) {
      setError("Confirm spend before synthesizing this paid voice.");
      return;
    }
    if (src && audioRef.current) {
      setError("");
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => undefined);
      return;
    }
    const token = ++gen.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    try {
      const preview = await api.intake.preview(provider.id, voice.id, controller.signal);
      if (token !== gen.current) return;
      setSrc(preview.audioUrl);
      window.setTimeout(() => {
        if (token !== gen.current) return;
        void audioRef.current?.play().catch(() => undefined);
      }, 40);
    } catch (err) {
      if (token !== gen.current) return;
      setError(errText(err));
    } finally {
      if (token === gen.current) setBusy(false);
    }
  }

  function stop() {
    gen.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setBusy(false);
    setPlaying(false);
    setCurrentTime(0);
  }

  return (
    <section
      className="mt-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3"
      aria-label="Voice sample player"
      data-playing={playing ? "" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant={playing ? "outline" : "default"}
            className="min-h-11"
            disabled={blocked || busy || (paid && !spendOk)}
            onClick={() => (playing ? stop() : void listen())}
          >
            {busy ? "Generating…" : playing ? "Stop" : "Listen sample"}
          </Button>
          {paid ? (
            <label className="flex min-h-11 items-center gap-2 text-xs text-[#a2a19f]">
              <input
                type="checkbox"
                checked={spendOk}
                onChange={(event) => {
                  setSpendOk(event.target.checked);
                  if (event.target.checked) setError("");
                }}
              />
              <span>
                Confirm paid synthesis{provider?.costNotice ? ` · ${provider.costNotice}` : ""}
              </span>
            </label>
          ) : (
            <span className="text-xs text-[#a2a19f]" role="note">
              {!privileged
                ? "Temporary accounts cannot generate previews."
                : provider && !provider.available
                  ? `Preview unavailable (${provider.unavailableReason || "not configured"}).`
                  : provider?.costNotice || "Free Edge TTS narration"}
            </span>
          )}
        </div>
        {src ? (
          <div className="flex min-w-[220px] flex-1 items-center justify-end gap-2">
            <audio
              ref={audioRef}
              src={src}
              controls
              preload="metadata"
              className="h-9 max-w-xs flex-1"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            />
            <span className="shrink-0 font-mono text-xs text-[#a2a19f] tabular-nums">
              {fmtAudioTime(currentTime)} / {fmtAudioTime(duration)}
            </span>
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-[#f0a096]" role="alert">{error}</p> : null}
    </section>
  );
}

function StagePips({ job }: { job: IntakeJob }) {
  const status = statusOf(job);
  const current = STAGE_ORDER.indexOf(transferStage(job));
  const bytes = downloadProgress(job);
  const pipe = pipelineProgress(job);
  const knownBytes = Boolean(bytes && bytes.total && bytes.total > 0);
  const chapterCount = pipe?.completed ?? pipe?.index ?? null;
  const knownChapters = Boolean(pipe && chapterCount !== null && pipe.total && chapterCount >= 0 && chapterCount <= pipe.total);
  const percent = job.progress?.percent;
  const pct = percent != null && Number.isFinite(Number(percent))
    ? Math.max(0, Math.min(100, Math.round(Number(percent))))
    : knownBytes
      ? Math.min(100, Math.round((bytes!.loaded / bytes!.total!) * 100))
      : knownChapters ? Math.min(100, Math.round((chapterCount! / pipe!.total!) * 100)) : null;
  return (
    <div className="mt-3">
      <ol className="flex flex-wrap gap-2 text-[11px] tracking-wide text-[#a2a19f] uppercase" aria-label="Production progress">
        {STAGE_ORDER.map((stage, index) => {
          const done = status === "completed" || index < current;
          const on = status !== "completed" && index === current;
          return (
            <li key={stage} className={cn("rounded-full border px-2 py-1", done && "border-[#3d523b] text-[#aed1a8]", on && "border-[#5eead4] text-[#5eead4]")}>
              {stage}
            </li>
          );
        })}
      </ol>
      {ACTIVE_STATUSES.has(status) ? (
        <div className={cn("upload-track mt-2", pct === null && "is-busy")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Stage progress">
          <i style={{ width: pct === null ? undefined : `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export default function NewSeriesPage() {
  const [step, setStep] = useState(0);
  const [sourceMode, setSourceMode] = useState<SourceMode>("gdrive");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [gdriveUrl, setGdriveUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [chapters, setChapters] = useState("all");
  const [providerId, setProviderId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [background, setBackground] = useState("starfield");
  const [motion, setMotion] = useState("cut");
  const [laneId, setLaneId] = useState(DEFAULT_LANE);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>("720p");
  const [outroEnabled, setOutroEnabled] = useState(false);
  const [outroTotalChapters, setOutroTotalChapters] = useState(50);
  const [outroCoveredChapters, setOutroCoveredChapters] = useState(20);
  const [outroHookType, setOutroHookType] = useState<OutroHookType>("part2");
  const [outroCustomPrompt, setOutroCustomPrompt] = useState("");
  const [catalog, setCatalog] = useState<IntakeCatalog | null>(null);
  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [privileged, setPrivileged] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<{ text: string; ok: boolean } | null>(null);
  const [jobs, setJobs] = useState<IntakeJob[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [queueNotice, setQueueNotice] = useState("");
  const [external, setExternal] = useState<Array<{ series?: string }>>([]);
  const [workerActive, setWorkerActive] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [showForm, setShowForm] = useState(true);
  const [showLaunch, setShowLaunch] = useState(false);
  const [missingQuery, setMissingQuery] = useState<{ job: string; series: string } | null>(null);
  const [actionNote, setActionNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [continueDrafts, setContinueDrafts] = useState<Record<string, string>>({});
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [unsupported, setUnsupported] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const focusField = useRef<string | null>(null);
  const restored = useRef(false);
  const laneTouched = useRef(false);
  const jobsSig = useRef("");

  const providers = useMemo(() => asProviders(catalog), [catalog]);
  const lanes = useMemo(() => buildLanes(catalog, nodes), [catalog, nodes]);
  const provider = providers.find((item) => item.id === providerId) || null;
  const voice = provider?.voices.find((item) => item.id === voiceId) || provider?.voices[0] || null;
  const backgrounds = catalog?.backgrounds?.length ? catalog.backgrounds : ["starfield", "storm-valley", "mist-pines"];
  const motions = catalog?.motions?.length ? catalog.motions : ["cut", "duo"];
  const driveId = parseDriveId(gdriveUrl);
  const slugPreview = slug || slugify(title);
  const chosenLane = lanes.find((lane) => lane.id === laneId) || lanes[0];
  const activeJob = jobs.find((job) => job.id === activeId) || null;
  const spending = typeof catalog?.spendingNotice === "string"
    ? catalog.spendingNotice
    : "Runs ingestion, vision, script, TTS, cleaning, and video rendering across selected chapters.";

  const loadJobs = useCallback(async () => {
    try {
      const list = await api.intake.jobs();
      if (typeof list.privileged === "boolean") setPrivileged(list.privileged);
      const nextJobs = (list.jobs || []) as IntakeJob[];
      const sig = JSON.stringify(nextJobs);
      if (sig !== jobsSig.current) {
        jobsSig.current = sig;
        setJobs(nextJobs);
      }
      const nextExternal = externalRuns(list);
      setExternal((current) => JSON.stringify(current) === JSON.stringify(nextExternal) ? current : nextExternal);
      setWorkerActive(Boolean(list.workerActive));
      setQueueNotice("");
      setJobsLoaded(true);
    } catch (error) {
      setQueueNotice(isApiError(error) && error.status === 401
        ? error.message
        : "Could not reach the server. Showing the last known queue. Retrying…");
    }
  }, []);

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const [nextCatalog, nodeRes, settingsRes] = await Promise.all([
          api.intake.catalog(),
          api.studio.nodes().catch(() => ({ nodes: [] as RenderNode[], runtimeNodes: [] })),
          api.studio.getSettings().catch(() => null),
        ]);
        if (stop) return;
        setCatalog(nextCatalog);
        setNodes(nodeRes.nodes || []);
        const q = settingsRes?.renderQuality || settingsRes?.settings?.renderQuality;
        if (q === "720p" || q === "1080p") setRenderQuality(q);
        if (nextCatalog.privileged === false) setPrivileged(false);
      } catch (error) {
        if (!stop) setAlert({ text: errText(error), ok: false });
      }
    })();
    void loadJobs();
    return () => {
      stop = true;
    };
  }, [loadJobs]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) void loadJobs();
    }, 4000);
    const onVis = () => {
      if (!document.hidden) void loadJobs();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadJobs]);

  useEffect(() => {
    if (!catalog) return;
    const list = asProviders(catalog);
    let storedProvider = "";
    let storedVoice = "";
    try {
      const raw = localStorage.getItem("screeningroom.preferredVoice");
      if (raw) {
        const parsed = JSON.parse(raw) as { providerId?: string; voiceId?: string; engine?: string };
        storedProvider = parsed.providerId || parsed.engine || "";
        storedVoice = parsed.voiceId || "";
      } else {
        storedProvider = localStorage.getItem("screeningroom.voice.provider") || "";
        storedVoice = localStorage.getItem("screeningroom.voice.id") || "";
      }
    } catch {
      /* Storage blocked */
    }
    const matchedProvider = storedProvider
      ? list.find((item) => (item.id === storedProvider || item.engine === storedProvider) && item.available)
      : undefined;
    const preferred =
      matchedProvider ||
      list.find((item) => item.id === catalog.defaultProvider && item.available) ||
      list.find((item) => item.available) ||
      list[0];
    setProviderId((current) => current || preferred?.id || "");
    if (matchedProvider && storedVoice && matchedProvider.voices.some((item) => item.id === storedVoice)) {
      setVoiceId((current) => current || storedVoice);
    }
    if (catalog.defaultBackground) setBackground((current) => current || catalog.defaultBackground);
    if (catalog.defaultMotion) setMotion((current) => current || catalog.defaultMotion);
  }, [catalog]);

  useEffect(() => {
    if (!provider) return;
    if (!provider.voices.some((item) => item.id === voiceId)) {
      const next = provider.voices.find((item) => item.default) || provider.voices[0];
      setVoiceId(next?.id || "");
    }
  }, [provider, voiceId]);

  useEffect(() => {
    if (laneTouched.current) return;
    setLaneId(defaultLaneId(catalog, lanes));
  }, [catalog, lanes]);

  useEffect(() => {
    if (!jobsLoaded || restored.current) return;
    restored.current = true;
    const query = readQuery();
    if (query) {
      const match = findJob(query, jobs);
      if (match) {
        setActiveId(match.id);
        setShowLaunch(true);
        setShowForm(false);
        setMissingQuery(null);
        storeActiveJob(match.id);
      } else {
        setMissingQuery(query);
        setShowLaunch(true);
        setShowForm(false);
        setAlert({ text: query.job ? `Could not find intake job “${query.job}”.` : `Could not find an intake job for series “${query.series}”.`, ok: false });
      }
      return;
    }
    const stored = readStoredJob();
    const job = jobs.find((item) => item.id === stored);
    if (job && RESTORE_STATUSES.has(statusOf(job))) {
      setActiveId(job.id);
      setShowLaunch(true);
      setShowForm(false);
    } else if (stored && !job) {
      storeActiveJob("");
    }
  }, [jobsLoaded, jobs]);

  useEffect(() => {
    if (!activeJob) return;
    if (statusOf(activeJob) !== "queued") {
      setAlert((current) => (current?.ok ? null : current));
    }
  }, [activeJob]);

  useEffect(() => {
    if (!focusField.current) return;
    const id = focusField.current;
    focusField.current = null;
    document.getElementById(id)?.focus();
  }, [step, errors]);

  useEffect(() => {
    const block = (event: Event) => event.preventDefault();
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    return () => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    };
  }, []);

  function setField(name: FieldName, message: string) {
    setErrors((current) => ({ ...current, [name]: message }));
  }

  function validateStory(): boolean {
    const next: FieldErrors = {};
    const trimmed = title.trim();
    if (!trimmed) next.title = "Enter a series title to continue.";
    const preview = (slugTouched ? slug : slugify(trimmed)).trim().toLowerCase();
    if (trimmed && (!SLUG_RE.test(preview) || preview.length < 1)) {
      next.slug = "Slug needs 2+ characters: lowercase letters, numbers, hyphens.";
    }
    if (sourceMode === "gdrive") {
      if (!parseDriveId(gdriveUrl)) {
        next.gdrive = gdriveUrl.trim()
          ? "Use a public Google Drive file link, not a folder link."
          : "Paste a public Google Drive ZIP file link.";
      }
    } else if (!file || !/\.zip$/i.test(file.name)) {
      next.file = "Choose a .zip archive to continue.";
    } else if (file.size > maxZipBytes(catalog)) {
      next.file = "This archive exceeds the upload size limit.";
    }
    const chapterCheck = normalizeChapters(chapters);
    if (!chapterCheck.ok) next.chapters = chapterCheck.error;
    setErrors((current) => ({ ...current, ...next, title: next.title || "", slug: next.slug || "", gdrive: next.gdrive || "", file: next.file || "", chapters: next.chapters || "" }));
    if (next.title || next.slug || next.gdrive || next.file || next.chapters) {
      setStep(0);
      focusField.current = next.title ? "seriesTitle" : next.slug ? "seriesSlug" : next.chapters ? "chaptersSpec" : sourceMode === "gdrive" ? "gdriveUrl" : "tabUpload";
      return false;
    }
    return true;
  }

  function goToStep(index: number) {
    if (submitting) return;
    const next = Math.max(0, Math.min(2, index));
    if (next > step && !validateStory()) return;
    if (next > 1 && (!provider?.available || !voice)) {
      setStep(1);
      setField("voice", "Choose an available narrator before continuing.");
      focusField.current = "ttsVoice";
      return;
    }
    setAlert(null);
    setStep(next);
  }

  function applyFile(next: File | null) {
    if (!next) {
      setFile(null);
      setField("file", "");
      return;
    }
    if (!/\.zip$/i.test(next.name || "")) {
      setFile(null);
      setField("file", "Only .zip archives are supported.");
      return;
    }
    const limit = maxZipBytes(catalog);
    setFile(next);
    setField("file", next.size > limit ? `File exceeds the ${fmtBytes(limit)} limit.` : "");
    if (!title.trim()) {
      const stem = next.name.replace(/\.(zip|cbz)$/i, "").replace(/[_-]+/g, " ").trim();
      if (stem) {
        setTitle(stem);
        setField("title", "");
        if (!slugTouched) setSlug(slugify(stem));
      }
    }
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: SourceMode = event.key === "Home" ? "gdrive" : event.key === "End" ? "upload" : sourceMode === "gdrive" ? "upload" : "gdrive";
    setSourceMode(next);
    setField("gdrive", "");
    setField("file", "");
    document.getElementById(next === "gdrive" ? "tabGdrive" : "tabUpload")?.focus();
  }

  function cancelUpload() {
    uploadAbort.current?.abort();
  }

  async function launch(options?: { qualityOverride?: RenderQuality; useDefaultVoice?: boolean }) {
    if (submitting || !privileged) return;
    if (!validateStory()) return;
    const edgeProvider =
      providers.find(
        (item) =>
          item.available &&
          (item.id === "edge" || item.id === "edge-tts" || item.engine === "edge" || item.engine === "edge-tts"),
      ) ||
      providers.find((item) => item.available) ||
      provider;
    const resolvedProvider = options?.useDefaultVoice ? edgeProvider || provider : provider;
    const resolvedVoice = options?.useDefaultVoice
      ? resolvedProvider?.voices.find((item) => item.default) || resolvedProvider?.voices[0] || voice
      : voice;
    if (!options?.useDefaultVoice && (!resolvedProvider?.available || !resolvedVoice)) {
      setStep(1);
      setField("voice", "Choose an available narrator before continuing.");
      return;
    }
    const finalProviderId = resolvedProvider?.id || "edge";
    const finalVoiceId = resolvedVoice?.id || "en-US-AndrewMultilingualNeural";
    const finalQuality: RenderQuality = options?.qualityOverride || renderQuality;
    if (options?.qualityOverride) {
      setRenderQuality(options.qualityOverride);
    }
    const nextSlug = (slugTouched ? slug : slugify(title)).trim().toLowerCase();
    setSlug(nextSlug);
    const chapterCheck = normalizeChapters(chapters);
    if (!chapterCheck.ok) {
      setStep(0);
      setField("chapters", chapterCheck.error);
      return;
    }
    const lane = lanes.find((item) => item.id === laneId);
    if (!lane) {
      setField("renderLane", "Choose a render lane from the list.");
      setStep(2);
      return;
    }
    if (!lane.available) {
      setField("renderLane", `${lane.label} is unavailable: ${lane.unavailableReason || "not available"}.`);
      setStep(2);
      return;
    }
    setAlert(null);
    setSubmitting(true);
    const controller = new AbortController();
    uploadAbort.current = controller;
    const outroConfig: OutroConfigInput | undefined = outroEnabled
      ? {
          enabled: true,
          totalChapters: Math.max(1, outroTotalChapters),
          coveredChapters: Math.max(1, outroCoveredChapters),
          hookType: outroHookType,
          customPrompt: outroCustomPrompt.trim() || undefined,
        }
      : undefined;
    try {
      let created: IntakeJob;
      if (sourceMode === "gdrive") {
        created = await api.intake.createGdriveJob({
          gdriveUrl: gdriveUrl.trim(),
          title: title.trim(),
          slug: nextSlug,
          provider: finalProviderId,
          voice: finalVoiceId,
          chapters: chapterCheck.spec,
          background,
          motion,
          renderLane: lane.id,
          renderQuality: finalQuality,
          outroConfig,
        }) as IntakeJob;
        setGdriveUrl("");
      } else {
        if (!file) throw new Error("Select or drop a .zip archive.");
        if (file.size > maxZipBytes(catalog)) throw new Error(`Selected file (${fmtBytes(file.size)}) exceeds the upload size limit.`);
        if (!getCsrfToken()) await api.session().catch(() => undefined);
        setUpload({ active: true, phase: "Uploading archive…", loaded: 0, total: file.size, pct: 0 });
        created = (await api.intake.uploadZip(
          {
            file,
            filename: file.name || "archive.zip",
            title: title.trim(),
            slug: nextSlug,
            provider: finalProviderId,
            voice: finalVoiceId,
            chapters: chapterCheck.spec,
            background,
            motion,
            renderLane: lane.id || DEFAULT_LANE,
            renderQuality: finalQuality,
            outroConfig,
          },
          controller.signal,
          (pct, loaded, total) => {
            setUpload({
              active: true,
              phase: total !== null && pct >= 100 ? "Validating ZIP & preflighting pipeline…" : "Uploading archive…",
              loaded,
              total,
              pct: total !== null ? pct : null,
            });
          },
        )) as IntakeJob;
        applyFile(null);
      }
      setTitle("");
      setSlug("");
      setSlugTouched(false);
      laneTouched.current = false;
      setLaneId(DEFAULT_LANE);
      setAlert({
        text: `Queued ${created.title || title.trim()} (series/${created.slug || nextSlug}) as ${created.id}. The pipeline runs in the background.`,
        ok: true,
      });
      if (created.id) {
        setJobs((current) => [created, ...current.filter((job) => job.id !== created.id)]);
        setActiveId(created.id);
        storeActiveJob(created.id);
        setShowLaunch(true);
        setShowForm(false);
        setMissingQuery(null);
      }
      await loadJobs();
    } catch (error) {
      const message = errText(error);
      setAlert({ text: message === "Upload cancelled" ? "Upload cancelled." : message, ok: false });
    } finally {
      uploadAbort.current = null;
      setUpload(IDLE_UPLOAD);
      setSubmitting(false);
    }
  }

  async function runAction(jobId: string, action: JobAction, payload?: { chapters?: string }) {
    if (!privileged || busyIds.has(jobId)) return;
    const existing = jobs.find((job) => job.id === jobId) || { id: jobId, status: "failed" };
    setActiveId(jobId);
    setShowLaunch(true);
    setShowForm(false);
    setMissingQuery(null);
    storeActiveJob(jobId);
    setActionNote(null);
    setBusyIds((current) => new Set(current).add(jobId));
    try {
      let next: IntakeJob = existing;
      if (action === "retry") {
        const body = await api.intake.retry(jobId);
        next = (body.job || existing) as IntakeJob;
      } else if (action === "continue") {
        const body = await api.intake.continue(jobId, payload?.chapters || "all");
        next = (body.job || existing) as IntakeJob;
      } else if (action === "pause") {
        const body = await api.intake.pauseJob(jobId);
        next = (body.job || { ...existing, status: "paused", paused: true, controlActions: ["resume", "stop"] }) as IntakeJob;
      } else if (action === "resume") {
        const body = await api.intake.resumeJob(jobId);
        next = (body.job || { ...existing, status: "running", paused: false, controlActions: ["pause", "stop"] }) as IntakeJob;
      } else if (action === "stop" || action === "cancel") {
        const body = await api.intake.cancelJob(existing.id);
        next = (body.job || { ...existing, status: "interrupted", paused: false, controlActions: [] }) as IntakeJob;
      }
      const merged = { ...existing, ...next, id: jobId };
      setJobs((current) => {
        const index = current.findIndex((job) => job.id === jobId);
        if (index < 0) return [merged, ...current];
        const copy = current.slice();
        copy[index] = merged;
        return copy;
      });
      setActionNote({
        text: action === "retry"
          ? `Retry requested for ${merged.title || merged.slug || "this job"}.`
          : action === "continue"
            ? `Continuing ${merged.title || merged.slug || "this job"} with chapters ${payload?.chapters || "all"}.`
            : action === "pause"
              ? `Paused ${merged.title || merged.slug || "this job"}.`
              : action === "resume"
                ? `Resumed ${merged.title || merged.slug || "this job"}.`
                : `Stop requested for ${merged.title || merged.slug || "this job"}.`,
        ok: true,
      });
      await loadJobs();
    } catch (error) {
      if (isApiError(error) && (error.status === 404 || error.status === 405)) {
        setUnsupported((current) => new Set(current).add(`${jobId}:${action === "cancel" ? "stop" : action}`));
        setActionNote({ text: "This server does not support that action yet. Use “View pipeline” to watch the run.", ok: false });
      } else {
        setActionNote({ text: errText(error), ok: false });
      }
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
    }
  }

  function openContinue(jobId: string) {
    setActiveId(jobId);
    setShowLaunch(true);
    setShowForm(false);
    storeActiveJob(jobId);
    window.setTimeout(() => document.getElementById("continueChapters")?.focus(), 0);
  }

  function createAnother() {
    setActiveId("");
    storeActiveJob("");
    setShowLaunch(false);
    setShowForm(true);
    setMissingQuery(null);
    setActionNote(null);
    setAlert(null);
    setStep(0);
    if (window.location.search) history.replaceState(null, "", window.location.pathname);
  }

  const allActiveJobs = jobs.filter((job) => ACTIVE_STATUSES.has(statusOf(job)));
  const listedJobs = showLaunch && activeId ? jobs.filter((job) => job.id !== activeId) : jobs;
  const activeJobs = listedJobs.filter((job) => ACTIVE_STATUSES.has(statusOf(job)));
  const recentJobs = listedJobs.filter((job) => !ACTIVE_STATUSES.has(statusOf(job)));
  const queueLabel = allActiveJobs.length || workerActive
    ? allActiveJobs[0] ? `Running · ${allActiveJobs[0].title || allActiveJobs[0].slug}` : "Running"
    : jobs.some((job) => statusOf(job) === "queued")
      ? `${jobs.filter((job) => statusOf(job) === "queued").length} queued`
      : "Ready";
  const unavailableLanes = lanes.filter((lane) => !lane.available && lane.id !== chosenLane?.id);
  const laneGroups: Array<{ kind: LaneKind; label: string }> = [
    { kind: "inherit", label: RENDER_KIND_META.inherit.groupLabel },
    { kind: "local", label: RENDER_KIND_META.local.groupLabel },
    { kind: "docker-sbx", label: RENDER_KIND_META["docker-sbx"].groupLabel },
    { kind: "ssh", label: RENDER_KIND_META.ssh.groupLabel },
    { kind: "custom", label: RENDER_KIND_META.custom.groupLabel },
  ];

  function renderJob(job: IntakeJob) {
    const status = statusOf(job);
    const logs = Array.isArray(job.logTail) ? job.logTail : [];
    const errorText = friendlyJobError(job);
    const busy = busyIds.has(job.id);
    const retryable = canAction(job, "retry", privileged, unsupported);
    const continuable = canAction(job, "continue", privileged, unsupported);
    const stoppable = canAction(job, "stop", privileged, unsupported);
    const pausable = canAction(job, "pause", privileged, unsupported);
    const resumable = canAction(job, "resume", privileged, unsupported);
    const lane = normalizeLaneId(job.renderLane);
    return (
      <article key={job.id} className={cn("rounded-xl border bg-[#17181a] p-4", job.id === activeId ? "border-[#f18b6e]" : "border-[#2b2c30]")} data-job={job.id} data-selected={job.id === activeId ? "true" : undefined}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-serif text-xl">{job.title || job.slug || job.id}</h3>
          <span className="rounded-full border border-[#2b2c30] px-2 py-1 font-mono text-[10px] tracking-wide uppercase">{status}</span>
        </div>
        <p className="mt-1 text-sm text-[#a2a19f]">
          {cleanVoiceName(job.tts?.voiceLabel || job.tts?.voiceId || job.tts?.providerLabel || "Narrated")}
          {" · "}
          {job.ingestedChapters?.length ? `${job.ingestedChapters.length} chapters ready` : `Chapters: ${job.chapters || "all"}`}
          {" · "}
          Render: {lane}
          {" · "}
          {fmtAge(job.updatedAt || job.createdAt)}
        </p>
        <StagePips job={job} />
        {job.statusNote && !errorText ? <p className="mt-2 text-sm text-[#a2a19f]">{job.statusNote}</p> : null}
        {errorText ? <p className="mt-2 text-sm text-[#f0a096]" role="alert">{errorText}</p> : null}
        {logs.length ? (
          <details
            className="mt-3"
            open={openLogs.has(job.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setOpenLogs((current) => {
                const next = new Set(current);
                if (open) next.add(job.id);
                else next.delete(job.id);
                return next;
              });
            }}
          >
            <summary className="cursor-pointer text-sm text-[#a2a19f]">Raw log ({logs.length} lines)</summary>
            <Terminal className="mt-2">
              <TerminalHeader>job {job.id}</TerminalHeader>
              <TerminalBody>
                {logs.map((line, index) => (
                  <TerminalLine key={`${job.id}-${index}`}>{line}</TerminalLine>
                ))}
              </TerminalBody>
            </Terminal>
          </details>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="inline-flex min-h-11 items-center text-sm text-[#f18b6e]" href={job.statusUrl || "/status.html"}>View pipeline</a>
          {status === "completed" ? (
            <a className="inline-flex min-h-11 items-center rounded-lg bg-[#f18b6e] px-3 text-sm text-[#201713]" href={job.libraryUrl || "/"}>Watch</a>
          ) : null}
          {pausable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "pause")}>
              {busy ? "Working…" : "Pause"}
            </Button>
          ) : null}
          {resumable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "resume")}>
              {busy ? "Working…" : "Resume"}
            </Button>
          ) : null}
          {stoppable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "stop")}>
              {busy ? "Working…" : "Stop"}
            </Button>
          ) : null}
          {retryable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "retry")}>
              {busy ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
          {continuable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => openContinue(job.id)}>
              {busy ? "Continuing…" : "Continue"}
            </Button>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <AppShell
      active="new-series"
      eyebrow="Workspace"
      title="New series"
      actions={(
        <Button type="button" variant="outline" className="min-h-11" aria-label="Refresh job queue" onClick={() => void loadJobs()}>
          <RefreshCw className="size-4" aria-hidden />
          Refresh
        </Button>
      )}
    >
      <style>{PAGE_CSS}</style>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.18em] text-[#a2a19f] uppercase">Create a series</p>
            <h1 className="font-serif text-3xl">New series</h1>
          </div>
          <span className="rounded-full border border-[#2b2c30] px-3 py-1 text-xs">{queueLabel}</span>
        </div>

        {privileged ? null : (
          <p className="rounded-xl border border-[#605139] bg-[#2a241b] px-4 py-3 text-sm text-[#d6b57b]" role="alert">
            Signed in with a temporary viewing account. Temporary accounts can watch the library and view status, but cannot preview voices or start paid pipeline jobs.
          </p>
        )}
        {alert && !(showLaunch && activeJob) ? (
          <p className={cn("rounded-xl border px-4 py-3 text-sm", alert.ok ? "border-[#3d523b] bg-[#1e281f] text-[#aed1a8]" : "border-[#69453e] bg-[#2e1f1e] text-[#f0a096]")} role="alert">
            {alert.text}
          </p>
        ) : null}

        {showLaunch ? (
          <section className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-5" tabIndex={-1} aria-labelledby="successHeading">
            {missingQuery && !activeJob ? (
              <>
                <p className="text-[10px] tracking-[0.16em] text-[#f0a096] uppercase">Run not found</p>
                <h2 id="successHeading" className="mt-1 font-serif text-2xl">No run found for {missingQuery.job || missingQuery.series}</h2>
                <p className="mt-2 text-sm text-[#a2a19f]">Check Recent runs below, or start a new series.</p>
              </>
            ) : activeJob ? (
              <>
                <p className="text-[10px] tracking-[0.16em] text-[#a2a19f] uppercase">{statusOf(activeJob)}</p>
                <h2 id="successHeading" className="mt-1 font-serif text-2xl">{activeJob.title || activeJob.slug || "This series"}</h2>
                {!friendlyJobError(activeJob) ? (
                  <p className="mt-2 text-sm text-[#a2a19f]">{activeJob.statusNote || "This page updates live."}</p>
                ) : null}
                <StagePips job={activeJob} />
                <p className="mt-3 text-sm">
                  Render lane <strong className="font-mono">{laneLabel(normalizeLaneId(activeJob.renderLane), lanes)}</strong>
                </p>
                {friendlyJobError(activeJob) ? <p className="mt-2 text-sm text-[#f0a096]" role="alert">{friendlyJobError(activeJob)}</p> : null}
              </>
            ) : (
              <h2 id="successHeading" className="font-serif text-2xl">Preparing production</h2>
            )}
            {actionNote ? (
              <p className={cn("mt-3 text-sm", actionNote.ok ? "text-[#aed1a8]" : "text-[#f0a096]")} role="status">{actionNote.text}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <a className="inline-flex min-h-11 items-center rounded-lg bg-[#f18b6e] px-3 text-sm text-[#201713]" href={activeJob?.statusUrl || "/status.html"}>View pipeline</a>
              {activeJob && canAction(activeJob, "pause", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "pause")}>Pause</Button>
              ) : null}
              {activeJob && canAction(activeJob, "resume", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "resume")}>Resume</Button>
              ) : null}
              {activeJob && canAction(activeJob, "stop", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "stop")}>Stop</Button>
              ) : null}
              {activeJob && canAction(activeJob, "retry", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "retry")}>Retry</Button>
              ) : null}
              {activeJob && canAction(activeJob, "continue", privileged, unsupported) ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const check = normalizeChapters(continueDrafts[activeId] || "");
                    if (!check.ok) {
                      setActionNote({ text: check.error, ok: false });
                      document.getElementById("continueChapters")?.focus();
                      return;
                    }
                    void runAction(activeId, "continue", { chapters: check.spec });
                  }}
                >
                  <label className="text-sm" htmlFor="continueChapters">
                    Continue chapters
                    <input
                      id="continueChapters"
                      className="mt-1 min-h-11 w-40 rounded-lg border border-[#2b2c30] bg-[#101113] px-3 font-mono text-base"
                      value={continueDrafts[activeId] || ""}
                      placeholder="2-5 or all"
                      autoComplete="off"
                      aria-describedby="continueHint"
                      onChange={(event) => setContinueDrafts((current) => ({ ...current, [activeId]: event.target.value }))}
                    />
                  </label>
                  <Button type="submit" className="min-h-11" disabled={busyIds.has(activeId)}>Continue</Button>
                </form>
              ) : null}
              <Button type="button" variant="ghost" className="min-h-11" onClick={createAnother}>Create another series</Button>
            </div>
            {activeJob && canAction(activeJob, "continue", privileged, unsupported) ? (
              <p id="continueHint" className="mt-2 text-xs text-[#a2a19f]">Reuses the staged archive without re-downloading.</p>
            ) : null}
          </section>
        ) : null}

        {showForm ? (
          <form
            id="intakeForm"
            className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-4 md:p-5"
            noValidate
            aria-busy={submitting}
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (step < 2) goToStep(step + 1);
              else void launch();
            }}
          >
            <Stepper value={step + 1} onValueChange={(next) => goToStep(next - 1)} aria-label="Series setup" className="mb-5">
              {STEPS.map((item, index) => (
                <StepperItem key={item.title} step={index + 1} disabled={submitting}>
                  <StepperTrigger className="min-h-11">
                    <StepperIndicator>
                    {index < step ? null : String(index + 1).padStart(2, "0")}
                  </StepperIndicator>
                    <StepperTitle>{item.title}</StepperTitle>
                  </StepperTrigger>
                  {index < STEPS.length - 1 ? <StepperSeparator /> : null}
                </StepperItem>
              ))}
            </Stepper>

            <fieldset disabled={submitting} className="min-w-0 border-0 p-0">
              {step === 0 ? (
                <section aria-labelledby="sourceHeading">
                  <h2 id="sourceHeading" tabIndex={-1} className="font-serif text-2xl">Source</h2>
                  <label className="mt-4 block text-sm" htmlFor="seriesTitle">
                    Title
                    <input
                      id="seriesTitle"
                      className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base"
                      value={title}
                      maxLength={120}
                      required
                      aria-invalid={errors.title ? true : undefined}
                      aria-describedby="titleError slugPreview"
                      onChange={(event) => {
                        setTitle(event.target.value);
                        if (!slugTouched) setSlug(slugify(event.target.value));
                        setField("title", "");
                      }}
                    />
                  </label>
                  <FieldError id="titleError" message={errors.title} />
                  <details className="mt-2 text-xs text-[#a2a19f]" open={Boolean(errors.slug)}>
                    <summary className="cursor-pointer select-none">
                      Custom folder slug (series/{slugPreview || "…"})
                    </summary>
                    <label className="mt-2 block text-sm text-[#f2efe9]" htmlFor="seriesSlug">
                      Slug preview
                      <input
                        id="seriesSlug"
                        className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 font-mono text-base"
                        value={slugTouched ? slug : slugPreview}
                        maxLength={64}
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        aria-invalid={errors.slug ? true : undefined}
                        aria-describedby="slugError slugPreview"
                        onChange={(event) => {
                          setSlugTouched(Boolean(event.target.value.trim()));
                          setSlug(event.target.value);
                          setField("slug", "");
                        }}
                      />
                    </label>
                    <p id="slugPreview" className="mt-1 font-mono text-xs text-[#a2a19f]">series/{slugPreview || "—"}</p>
                  </details>
                  <FieldError id="slugError" message={errors.slug} />

                  <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Archive source method" onKeyDown={onTabKey}>
                    <button type="button" role="tab" id="tabGdrive" className={cn("min-h-11 rounded-lg border px-3 text-left text-sm", sourceMode === "gdrive" ? "border-[#f18b6e] bg-[rgba(241,139,110,0.14)]" : "border-[#2b2c30]")} aria-selected={sourceMode === "gdrive"} aria-controls="paneGdrive" onClick={() => setSourceMode("gdrive")}>
                      <Link2 className="mr-2 inline size-4" aria-hidden /> Google Drive ZIP
                    </button>
                    <button type="button" role="tab" id="tabUpload" className={cn("min-h-11 rounded-lg border px-3 text-left text-sm", sourceMode === "upload" ? "border-[#f18b6e] bg-[rgba(241,139,110,0.14)]" : "border-[#2b2c30]")} aria-selected={sourceMode === "upload"} aria-controls="paneUpload" onClick={() => setSourceMode("upload")}>
                      <Upload className="mr-2 inline size-4" aria-hidden /> Upload ZIP
                    </button>
                  </div>

                  {sourceMode === "gdrive" ? (
                    <div id="paneGdrive" role="tabpanel" aria-labelledby="tabGdrive" className="mt-4">
                      <label className="block text-sm" htmlFor="gdriveUrl">
                        Drive ZIP URL
                        <input
                          id="gdriveUrl"
                          className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 font-mono text-base"
                          type="url"
                          value={gdriveUrl}
                          placeholder="https://drive.google.com/file/d/..."
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={errors.gdrive ? true : undefined}
                          aria-describedby="gdriveError"
                          onChange={(event) => {
                            setGdriveUrl(event.target.value);
                            setField("gdrive", "");
                          }}
                        />
                      </label>
                      {driveId ? (
                        <p className="mt-2 rounded-lg border border-[#3d523b] bg-[#1e281f] px-3 py-2 text-sm text-[#aed1a8]">
                          Drive ZIP ready · File {driveId.slice(0, 10)}…
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-[#a2a19f]">Share as Anyone with the link.</p>
                      <FieldError id="gdriveError" message={errors.gdrive} />
                    </div>
                  ) : (
                    <div id="paneUpload" role="tabpanel" aria-labelledby="tabUpload" className="mt-4">
                      <Dropzone
                        accept={{ "application/zip": [".zip"] }}
                        maxFiles={1}
                        maxSize={maxZipBytes(catalog)}
                        src={file ? [file] : []}
                        aria-label="Drop or choose a .zip archive"
                        onDrop={(accepted, rejections) => {
                          if (rejections.length && !accepted.length) {
                            setField("file", rejections.some((item) => item.reasons.includes("maxSize"))
                              ? `File exceeds the ${fmtBytes(maxZipBytes(catalog))} limit.`
                              : "Only .zip archives are supported.");
                            return;
                          }
                          applyFile(accepted[0] || null);
                        }}
                        onError={() => setField("file", "Could not read that file. Try another .zip archive.")}
                        className="bg-[#101113] p-4"
                      >
                        <span className="flex items-center gap-3 text-start">
                          <Upload className="size-5 shrink-0 text-[#f18b6e]" aria-hidden />
                          <span>
                            <strong className="block">{file ? file.name : "Drop .zip or browse"}</strong>
                            <span id="fileMeta" className="text-sm text-[#a2a19f]">
                              {file ? `${fmtBytes(file.size)} · ready to upload` : "Chapters or .cbz archive"}
                            </span>
                          </span>
                        </span>
                      </Dropzone>
                      {file ? (
                        <div className="mt-2 flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() => document.querySelector<HTMLElement>('#paneUpload [role="button"]')?.click()}
                          >
                            Replace file
                          </Button>
                          <Button type="button" variant="ghost" className="min-h-11" onClick={() => applyFile(null)}>
                            <X className="size-4" aria-hidden /> Remove
                          </Button>
                        </div>
                      ) : null}
                      <FieldError id="fileError" message={errors.file} />
                    </div>
                  )}

                  <label className="mt-4 block text-sm" htmlFor="chaptersSpec">
                    Chapters
                    <input
                      id="chaptersSpec"
                      className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 font-mono text-base"
                      value={chapters}
                      placeholder="all, 1-5, or 1,2,3"
                      aria-invalid={errors.chapters ? true : undefined}
                      aria-describedby="chaptersError"
                      onChange={(event) => {
                        setChapters(event.target.value);
                        setField("chapters", "");
                      }}
                    />
                  </label>
                  <div className="mt-2 flex gap-2" role="group" aria-label="Chapter presets">
                    {["all", "1"].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className="min-h-11 rounded-full border border-[#2b2c30] px-3 text-sm"
                        aria-pressed={chapters.trim() === preset}
                        onClick={() => {
                          setChapters(preset);
                          setField("chapters", "");
                        }}
                      >
                        {preset === "all" ? "All chapters" : "Chapter 1"}
                      </button>
                    ))}
                  </div>
                  <FieldError id="chaptersError" message={errors.chapters} />
                </section>
              ) : null}

              {step === 1 ? (
                <section aria-labelledby="narrationHeading">
                  <h2 id="narrationHeading" tabIndex={-1} className="font-serif text-2xl">Voice & style</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm" htmlFor="ttsProvider">
                      Provider
                      <select
                        id="ttsProvider"
                        className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base"
                        value={providerId}
                        onChange={(event) => {
                          setProviderId(event.target.value);
                          setField("voice", "");
                        }}
                      >
                        {providers.map((item) => (
                          <option key={item.id} value={item.id} disabled={!item.available}>
                            {item.label}{item.available ? "" : " (Unavailable)"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm" htmlFor="ttsVoice">
                      Narrator voice
                      <select
                        id="ttsVoice"
                        className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base"
                        value={voice?.id || ""}
                        aria-invalid={errors.voice ? true : undefined}
                        aria-describedby="voiceError"
                        onChange={(event) => {
                          setVoiceId(event.target.value);
                          setField("voice", "");
                        }}
                      >
                        {(provider?.voices || []).map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <FieldError id="voiceError" message={errors.voice} />
                  <VoicePreview provider={provider} voice={voice} privileged={privileged} />
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-sm">Background</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Background world">
                        {backgrounds.map((id) => (
                          <button key={id} type="button" className={cn("min-h-11 rounded-lg border px-3 text-sm", background === id ? "border-[#f18b6e]" : "border-[#2b2c30]")} aria-pressed={background === id} onClick={() => setBackground(id)}>
                            {BG_LABELS[id] || id}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-sm">Panel motion</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Panel card motion">
                        {motions.map((id) => (
                          <button key={id} type="button" className={cn("min-h-11 rounded-lg border px-3 text-sm", motion === id ? "border-[#f18b6e]" : "border-[#2b2c30]")} aria-pressed={motion === id} onClick={() => setMotion(id)}>
                            {MOTION_LABELS[id] || id}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {providers.some((item) => !item.available && item.unavailableReason) ? (
                    <ul className="mt-4 text-sm text-[#d6b57b]">
                      {providers.filter((item) => !item.available && item.unavailableReason).map((item) => (
                        <li key={item.id}><strong>{item.label}</strong> — {item.unavailableReason}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}

              {step === 2 ? (
                <section aria-labelledby="productionHeading">
                  <h2 id="productionHeading" tabIndex={-1} className="font-serif text-2xl">Launch</h2>
                  <label className="mt-4 block text-sm" htmlFor="renderLane">
                    Render lane
                    <select
                      id="renderLane"
                      className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#101113] px-3 text-base"
                      value={chosenLane?.id || DEFAULT_LANE}
                      disabled={!privileged}
                      aria-invalid={errors.renderLane ? true : undefined}
                      aria-describedby="renderLaneNote renderLaneError"
                      onChange={(event) => {
                        laneTouched.current = true;
                        setLaneId(event.target.value);
                        setField("renderLane", "");
                      }}
                    >
                      {laneGroups.map((group) => {
                        const options = lanes.filter((lane) => lane.kind === group.kind);
                        if (!options.length) return null;
                        return (
                          <optgroup key={group.kind} label={group.label}>
                            {options.map((lane) => (
                              <option key={lane.id} value={lane.id} disabled={!lane.available}>
                                {lane.label}{lane.available ? "" : " (Unavailable)"}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </label>
                  <p id="renderLaneNote" className="mt-1 flex items-center gap-2 text-xs text-[#a2a19f]">
                    <LaneIcon kind={chosenLane?.kind || "inherit"} />
                    {chosenLane && chosenLane.id !== DEFAULT_LANE
                      ? chosenLane.available
                        ? `${chosenLane.label} only · no fallback · waits if offline`
                        : `${chosenLane.label} unavailable: ${chosenLane.unavailableReason || "not available"}`
                      : "Follows global policy · waits if offline"}
                  </p>
                  {unavailableLanes.length ? (
                    <details className="mt-2 text-sm">
                      <summary>Unavailable: {unavailableLanes.map((lane) => lane.label).join(", ")}</summary>
                      <ul className="mt-2 text-[#d6b57b]">
                        {unavailableLanes.map((lane) => (
                          <li key={lane.id}><strong>{lane.label}</strong> — {lane.unavailableReason || "unavailable"}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <FieldError id="renderLaneError" message={errors.renderLane} />

                  <div className="mt-4 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Render Quality</p>
                        <p className="text-xs text-[#a2a19f]">
                          {renderQuality === "720p" ? "1280×720 Fast Render (--scale=0.6667)" : "1920×1080 Full HD (--scale=1)"}
                        </p>
                      </div>
                      <div className="flex gap-2" role="radiogroup" aria-label="Render quality">
                        {(["1080p", "720p"] as const).map((q) => (
                          <button
                            key={q}
                            type="button"
                            role="radio"
                            aria-checked={renderQuality === q}
                            className={cn(
                              "min-h-11 rounded-lg border px-3 text-sm",
                              renderQuality === q ? "border-[#f18b6e] bg-[rgba(241,139,110,0.14)]" : "border-[#2b2c30]",
                            )}
                            onClick={() => setRenderQuality(q)}
                          >
                            {q === "1080p" ? "1080p (Full HD)" : "720p (Fast Render)"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">Outro Announcement (Character-Panel Showcase)</p>
                        <p className="text-xs text-[#a2a19f]">
                          Auto-selects best character panels from <code>bible.json</code> + <code>obs</code> and narrates a contextual episode outro.
                        </p>
                      </div>
                      <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={outroEnabled}
                          onChange={(event) => setOutroEnabled(event.target.checked)}
                        />
                        Enable outro
                      </label>
                    </div>
                    {outroEnabled ? (
                      <div className="mt-3 space-y-3 border-t border-[#2b2c30] pt-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <label className="text-xs text-[#a2a19f]">
                            Total chapters so far
                            <input
                              type="number"
                              min={1}
                              className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 font-mono text-sm text-[#f2efe9]"
                              value={outroTotalChapters}
                              onChange={(event) => setOutroTotalChapters(Math.max(1, Number(event.target.value) || 1))}
                            />
                          </label>
                          <label className="text-xs text-[#a2a19f]">
                            Covered chapters
                            <input
                              type="number"
                              min={1}
                              className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 font-mono text-sm text-[#f2efe9]"
                              value={outroCoveredChapters}
                              onChange={(event) => setOutroCoveredChapters(Math.max(1, Number(event.target.value) || 1))}
                            />
                          </label>
                          <label className="text-xs text-[#a2a19f]">
                            Hook type
                            <select
                              className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-sm text-[#f2efe9]"
                              value={outroHookType}
                              onChange={(event) => setOutroHookType(event.target.value as OutroHookType)}
                            >
                              <option value="part2">Part 2 (part2)</option>
                              <option value="next_chapter">Next Chapter (next_chapter)</option>
                              <option value="new_series">New Series (new_series)</option>
                              <option value="custom">Custom (custom)</option>
                            </select>
                          </label>
                        </div>
                        {outroHookType === "custom" ? (
                          <label className="block text-xs text-[#a2a19f]">
                            Custom outro call-to-action
                            <input
                              className="mt-1 min-h-11 w-full rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-sm text-[#f2efe9]"
                              value={outroCustomPrompt}
                              placeholder="Ask viewers to drop a comment for Part 2"
                              onChange={(event) => setOutroCustomPrompt(event.target.value)}
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <dl className="mt-4 divide-y divide-[#2b2c30] rounded-xl border border-[#2b2c30]" aria-live="polite">
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Series</dt><dd>{title.trim() || "Not set"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Slug</dt><dd className="font-mono">{slugPreview || "Not set"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Narration</dt><dd>{provider && voice ? `${provider.label} · ${voice.label}` : "Not set"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Chapters</dt><dd className="font-mono">{chapters.trim() || "all"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Source & style</dt><dd>{sourceMode === "upload" ? file?.name || "No ZIP selected" : driveId ? "Google Drive ZIP" : "Waiting for link"} · {BG_LABELS[background] || background} · {MOTION_LABELS[motion] || motion}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Render lane & quality</dt><dd>{laneLabel(chosenLane?.id || DEFAULT_LANE, lanes)} · {renderQuality}</dd></div>
                    {outroEnabled ? (
                      <div className="flex justify-between gap-3 px-3 py-2 text-sm">
                        <dt>Outro announcement</dt>
                        <dd className="font-mono">{outroCoveredChapters}/{outroTotalChapters} ch · {outroHookType}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <details className="mt-4" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                    <summary className="cursor-pointer text-sm">Advanced options · slug</summary>
                    <p className="mt-2 text-sm text-[#a2a19f]">{spending}</p>
                  </details>
                </section>
              ) : null}
            </fieldset>

            {upload.active ? (
              <div className="mt-4" role="status" aria-live="polite">
                <div className="flex justify-between text-sm">
                  <span>{upload.phase}</span>
                  <span className="font-mono">{upload.pct === null ? fmtBytes(upload.loaded) : `${upload.pct}% (${fmtBytes(upload.loaded)} / ${fmtBytes(upload.total || 0)})`}</span>
                </div>
                <div className={cn("upload-track mt-2", upload.pct === null && "is-busy")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.pct ?? undefined} aria-label="Upload progress">
                  <i style={{ width: upload.pct === null ? undefined : `${upload.pct}%` }} />
                </div>
                <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={cancelUpload}>Cancel upload</Button>
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className="min-h-11" hidden={step === 0} disabled={submitting} onClick={() => goToStep(step - 1)}>Back</Button>
              <span className="font-mono text-xs text-[#a2a19f]">{String(step + 1).padStart(2, "0")} / 03</span>
              {step === 0 ? (
                <>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={!privileged || submitting}
                    onClick={() => void launch({ qualityOverride: "720p", useDefaultVoice: true })}
                  >
                    {submitting
                      ? sourceMode === "upload"
                        ? "Uploading & validating…"
                        : "Validating & queueing…"
                      : "Quick Start (Default Voice & 720p)"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={submitting}
                    onClick={() => goToStep(1)}
                  >
                    Customize Voice &amp; Render →
                  </Button>
                </>
              ) : step === 1 ? (
                <Button type="button" className="min-h-11" disabled={submitting} onClick={() => goToStep(2)}>
                  Next: Launch
                </Button>
              ) : (
                <Button type="submit" className="min-h-11" disabled={!privileged || submitting}>
                  {submitting ? (sourceMode === "upload" ? "Uploading & validating…" : "Validating & queueing…") : sourceMode === "upload" ? "Upload ZIP & start" : "Download ZIP & start"}
                </Button>
              )}
            </div>
          </form>
        ) : null}

        {showLaunch && !activeJobs.length && !recentJobs.length ? null : (
          <section aria-labelledby="queueHeading">
            <h2 id="queueHeading" className="font-serif text-2xl">Active & recent runs</h2>
            {external.length && !allActiveJobs.length ? (
              <p className="mt-3 rounded-xl border border-[#605139] bg-[#2a241b] px-4 py-3 text-sm text-[#d6b57b]">
                Another series ({external[0]?.series || "unknown"}) is currently running. New series will start right after.
              </p>
            ) : null}
            {queueNotice ? <p className="mt-3 text-sm text-[#d6b57b]" role="status">{queueNotice}</p> : null}
            {!jobsLoaded ? <p className="mt-3 text-sm text-[#a2a19f]">Loading intake jobs…</p> : null}
            {jobsLoaded && !jobs.length ? (
              <p className="mt-3 rounded-xl border border-[#2b2c30] bg-[#17181a] px-4 py-6 text-sm text-[#a2a19f]">No active runs. Started series appear here while chapters download and render.</p>
            ) : null}
            {activeJobs.length ? (
              <div className="mt-3 flex flex-col gap-3">
                <h3 className="text-sm tracking-wide text-[#a2a19f] uppercase">Active</h3>
                {activeJobs.map(renderJob)}
              </div>
            ) : null}
            {recentJobs.length ? (
              <div className="mt-4 flex flex-col gap-3">
                <h3 className="text-sm tracking-wide text-[#a2a19f] uppercase">Recent</h3>
                {recentJobs.map(renderJob)}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </AppShell>
  );
}

const PAGE_CSS = `
.upload-track {
  position: relative;
  height: 8px;
  overflow: hidden;
  border-radius: 99px;
  background: #101113;
  border: 1px solid #2b2c30;
}
.upload-track > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #f18b6e;
}
.upload-track.is-busy > i {
  width: 40%;
  animation: intake-slide 1.1s ease-in-out infinite;
}
@keyframes intake-slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(280%); }
}
@media (prefers-reduced-motion: reduce) {
  .upload-track.is-busy > i { animation: none; width: 100%; opacity: 0.45; }
}
`;
