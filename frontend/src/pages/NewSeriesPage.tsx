import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Activity, Info, Link2, RefreshCw, Rocket, Upload, Volume2, X } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { StyleFields, type EditableTtsStyle } from '@/components/library/StyleFields';
import { ElevenLabsVoiceCheck } from '@/components/library/ElevenLabsVoiceCheck';
import { CardAnimationFields, compactCardAnimation } from '@/components/library/CardAnimationFields';
import { VoicePreview } from "@/components/shared/VoicePreview";
import { RunSettingsDialog } from "@/components/shared/RunSettingsDialog";
import {
  ChaptersField,
  DEFAULT_OUTRO_DRAFT,
  FieldError,
  normalizeChapters,
  outroConfigFrom,
  OutroFields,
  RenderLaneField,
  RenderQualityField,
  type OutroDraft,
} from "@/components/shared/RunOptionFields";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Dropzone } from "@/components/ui/dropzone";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/ui/stepper";
import { ErrorNotice, Notice, RawDetails } from "@/components/ui/notice";
import {
  api,
  getCsrfToken,
  isApiError,
  type IntakeCatalog,
  type JobRecord,
  type JobsList,
  type ProviderView,
  type RenderNode,
  type RenderQuality,
  type StudioSettingsState,
} from "@/lib/api";
import { describeError, describeJobFailure, errorLine, parseFailureNote, type ErrorInfo } from "@/lib/errors";
import { retryCountdown, useRetryClock, type AutoRetry } from "@/lib/retry";
import { parseDriveId } from "@/lib/driveUrl";
import {
  buildIntakeLanes,
  DEFAULT_LANE_ID,
  LANE_ID_RE,
  type IntakeLaneOption,
} from "@/lib/renderLanes";
import {
  buildTtsProviders,
  conciseVoiceName,
  ELEVENLABS_VOICE_ID_RE,
  isElevenLabsProvider,
  readPreferredVoice,
  writePreferredVoice,
  type TtsProviderGroup,
  type TtsVoiceItem,
} from "@/lib/tts";
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
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LANE = DEFAULT_LANE_ID;
const MAX_ZIP_FALLBACK = 1536 * 1024 * 1024;
const BG_LABELS: Record<string, string> = {
  starfield: "Starfield",
  "storm-valley": "Storm Valley",
  "mist-pines": "Mist Pines",
};
const MOTION_LABELS: Record<string, string> = { window: "Window", cut: "Cut", duo: "Duo" };
const STEPS = [
  { title: "Source" },
  { title: "Voice & style" },
  { title: "Launch" },
] as const;

type SourceMode = "gdrive" | "upload";
type FieldName = "title" | "slug" | "gdrive" | "file" | "voice" | "chapters" | "renderLane";
type FieldErrors = Partial<Record<FieldName, string>>;
type JobAction = "retry" | "continue" | "cancel" | "stop" | "pause" | "resume" | "settings";

type LaneOption = IntakeLaneOption;

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
  notBefore?: number | null;
  autoRetry?: AutoRetry;
  failureDetail?: string | null;
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
  pauseRequested?: boolean;
  pausedAt?: number | null;
  pauseReason?: string | null;
  pausedWhere?: string | null;
  settingsEditable?: boolean;
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
  const info = describeError(error);
  return errorLine(error) + (info.requestId ? ` Request ID: ${info.requestId}` : "");
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
  return conciseVoiceName(label, label);
}

function statusOf(job: IntakeJob | null | undefined): string {
  if (job?.paused === true || job?.status === "paused") return "paused";
  return String(job?.status || "queued").toLowerCase();
}

function isPausing(job: IntakeJob | null | undefined): boolean {
  return Boolean(job?.pauseRequested) && statusOf(job) !== "paused";
}

function statusLabel(job: IntakeJob, waiting: boolean): string {
  if (waiting) return "Retrying";
  if (isPausing(job)) return "Pausing…";
  const status = statusOf(job);
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Where a paused run stopped and why, or the pending pause request. */
function PauseInfo({ job }: { job: IntakeJob }) {
  const pausing = isPausing(job);
  const paused = statusOf(job) === "paused";
  if (!pausing && !paused) return null;
  return (
    <div className="mt-2 text-sm" role="status" aria-live="polite">
      {pausing ? (
        <p className="text-muted-foreground">Pausing… the current step finishes first.</p>
      ) : (
        <>
          {job.pausedWhere ? <p>Paused at <span className="font-mono">{job.pausedWhere}</span></p> : <p>Paused</p>}
          {job.pauseReason ? <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">{job.pauseReason}</p> : null}
        </>
      )}
    </div>
  );
}

function normalizeLaneId(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return LANE_ID_RE.test(value) ? value : DEFAULT_LANE;
}

function maxZipBytes(catalog: IntakeCatalog | null): number {
  const limits = catalog?.limits;
  if (limits && typeof limits === "object" && "maxZipBytes" in limits) {
    const n = Number((limits as { maxZipBytes?: unknown }).maxZipBytes);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return MAX_ZIP_FALLBACK;
}

function resolveDefaultQuality(
  settings: StudioSettingsState | null,
  catalog: IntakeCatalog | null,
): RenderQuality {
  const fromSettings = settings?.renderQuality || settings?.settings?.renderQuality;
  if (fromSettings === "1080p" || fromSettings === "720p") return fromSettings;
  const caps = catalog?.capabilities as { renderQuality?: { default?: unknown } } | undefined;
  const fromCatalog = catalog?.defaultRenderQuality || caps?.renderQuality?.default;
  if (fromCatalog === "1080p" || fromCatalog === "720p") return fromCatalog;
  return "1080p";
}

function defaultLaneId(
  catalog: IntakeCatalog | null,
  settings: StudioSettingsState | null,
): string {
  const fromSettings = settings?.defaultRenderLane ?? settings?.settings?.defaultRenderLane;
  const caps = catalog?.capabilities;
  const fromCaps = caps && typeof caps === "object" ? (caps as { renderLane?: { default?: unknown } }).renderLane?.default : undefined;
  const raw = fromSettings ?? catalog?.defaultRenderLane ?? fromCaps ?? DEFAULT_LANE;
  return normalizeLaneId(raw);
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
  return String(job.error || "").trim() ? describeJobFailure(job.error, job.statusNote).title : "";
}

function JobFailure({ job }: { job: IntakeJob }) {
  if (job.status !== "failed" && job.status !== "interrupted") return null;
  if (!job.error && !job.failureDetail) return null;
  const failure = describeJobFailure(job.error, job.statusNote);
  const hint = job.failureDetail ? (/audio|voice|tts/i.test(job.failureDetail) && /429|rate limit/i.test(job.failureDetail) ? "Voice rate limited" : parseFailureNote(job.failureDetail).title) : /quota|rate limit|429|too many users/i.test(job.error || "")
    ? "Try later or upload a ZIP."
    : /permission|access denied|private|not found|404/i.test(job.error || "")
      ? "Make the Drive link public."
      : /timeout|timed out/i.test(job.error || "")
        ? "Check the source link."
        : failure.reason;
  return <Notice
    tone="danger"
    title={failure.title}
    className="mt-3"
    details={<RawDetails text={[job.failureDetail, job.error, job.statusNote].filter(Boolean).join("\n")} />}
  >
    {[hint, job.autoRetry?.count ? `tried ${job.autoRetry.count}×` : ""].filter(Boolean).join(" · ") || undefined}
  </Notice>;
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
  if (action === "settings") return Array.isArray(job.actions) && job.actions.includes("settings");
  const isControl = action === "pause" || action === "resume" || action === "stop" || action === "cancel";
  if (isControl && Array.isArray(job.controlActions)) {
    return job.controlActions.includes(controlAction) || (controlAction === "stop" && job.controlActions.includes("cancel"));
  }
  if (action === "pause") return status === "running" || status === "queued";
  if (action === "resume") return status === "paused";
  if (action === "stop" || action === "cancel") return ACTIVE_STATUSES.has(status);
  if (Array.isArray(job.actions) && job.actions.includes(action)) return true;
  if (action === "retry") return status === "failed" || status === "interrupted" || (status === "queued" && (job.notBefore || 0) > Date.now() / 1000);
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

const CUSTOM_VOICE = "__custom_voice__";

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
      <ol className="flex flex-wrap gap-2 text-[12.5px] text-muted-foreground" aria-label="Production progress">
        {STAGE_ORDER.map((stage, index) => {
          const done = status === "completed" || index < current;
          const on = status !== "completed" && index === current;
          return (
            <li key={stage} className={cn("rounded-full bg-muted px-3 py-1", done && "bg-success-soft text-success", on && "bg-info-soft text-info")}>
              {{ download: "Download", extract: "Extract", pipeline: "Production" }[stage]}
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
  const [modelId, setModelId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [customVoice, setCustomVoice] = useState(false);
  const [customVoiceId, setCustomVoiceId] = useState("");
  const [synthModel, setSynthModel] = useState("");
  const [style, setStyle] = useState<import('@/lib/api').SeriesStyle>({});
  const [ttsStyle, setTtsStyle] = useState<EditableTtsStyle>({});
  const [background, setBackground] = useState("starfield");
  const [motion, setMotion] = useState("");
  const [cardAnimation, setCardAnimation] = useState<import('@/lib/api').CardAnimation>({});
  const [laneId, setLaneId] = useState(DEFAULT_LANE);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>("1080p");
  const [outro, setOutro] = useState<OutroDraft>(DEFAULT_OUTRO_DRAFT);
  const [catalog, setCatalog] = useState<IntakeCatalog | null>(null);
  const [settingsState, setSettingsState] = useState<StudioSettingsState | null>(null);
  const [studioProviders, setStudioProviders] = useState<ProviderView[]>([]);
  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [privileged, setPrivileged] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<{ text: string; ok: boolean; info?: ErrorInfo } | null>(null);
  const [jobs, setJobs] = useState<IntakeJob[]>([]);
  const retryNow = useRetryClock(Math.max(0, ...jobs.map((job) => job.notBefore || 0)));
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [queueNotice, setQueueNotice] = useState("");
  const [external, setExternal] = useState<Array<{ series?: string }>>([]);
  const [workerActive, setWorkerActive] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [showForm, setShowForm] = useState(true);
  const [showLaunch, setShowLaunch] = useState(false);
  const [missingQuery, setMissingQuery] = useState<{ job: string; series: string } | null>(null);
  const [actionNote, setActionNote] = useState<{ text: string; ok: boolean; info?: ErrorInfo } | null>(null);
  const [continueDrafts, setContinueDrafts] = useState<Record<string, string>>({});
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [unsupported, setUnsupported] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [settingsJobId, setSettingsJobId] = useState("");
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
  const uploadAbort = useRef<AbortController | null>(null);
  const focusField = useRef<string | null>(null);
  const restored = useRef(false);
  const laneTouched = useRef(false);
  const qualityTouched = useRef(false);
  const providerTouched = useRef(false);
  const voiceTouched = useRef(false);
  const jobsSig = useRef("");

  const savedDefaultLane = useMemo(() => defaultLaneId(catalog, settingsState), [catalog, settingsState]);
  const providers = useMemo(() => buildTtsProviders(catalog, studioProviders), [catalog, studioProviders]);
  const lanes = useMemo(
    () => buildIntakeLanes(catalog, nodes, savedDefaultLane, laneId),
    [catalog, nodes, savedDefaultLane, laneId],
  );
  const provider = providers.find((item) => item.id === providerId) || providers.find((item) => item.available) || providers[0] || null;
  const activeModelGroup = useMemo(() => {
    if (!provider) return null;
    if (modelId) {
      const hit = provider.models.find((m) => m.id === modelId);
      if (hit) return hit;
    }
    const voiceHit = provider.voices.find((v) => v.id === voiceId);
    if (voiceHit) {
      const hit = provider.models.find((m) => m.id === voiceHit.modelId);
      if (hit) return hit;
    }
    return provider.models[0] || null;
  }, [provider, modelId, voiceId]);
  const modelVoices = activeModelGroup?.voices || provider?.voices || [];
  const listVoice = modelVoices.find((item) => item.id === voiceId) || provider?.voices.find((item) => item.id === voiceId) || modelVoices[0] || provider?.voices[0] || null;
  const isEleven = isElevenLabsProvider(provider);
  const useCustomVoice = Boolean(isEleven && provider?.allowCustomVoice && customVoice);
  const customVoiceTrim = customVoiceId.trim();
  const customVoiceValid = ELEVENLABS_VOICE_ID_RE.test(customVoiceTrim);
  const voice: TtsVoiceItem | null = useCustomVoice
    ? customVoiceValid
      ? { id: customVoiceTrim, label: customVoiceTrim, rawLabel: customVoiceTrim, modelId: listVoice?.modelId || "default", modelLabel: listVoice?.modelLabel || "Default", default: false }
      : null
    : listVoice;
  const synthModels = isEleven ? provider?.synthModels || [] : [];
  const activeSynthModel = synthModels.find((m) => m.id === synthModel) || synthModels.find((m) => m.id === provider?.defaultSynthModel) || synthModels[0] || null;
  const voiceMissingMessage = useCustomVoice && !customVoiceValid
    ? "Enter a valid ElevenLabs voice ID: 16 to 40 letters or digits."
    : "Choose an available narrator before continuing.";
  const ttsPayload = {
    ...ttsStyle,
    speed: ttsStyle.speed ?? undefined,
    ...(isEleven && activeSynthModel ? { model_id: activeSynthModel.id } : {}),
  };
  const backgrounds = catalog?.backgrounds?.length ? catalog.backgrounds : ["starfield", "storm-valley", "mist-pines"];
  const motions = catalog?.motions?.length ? catalog.motions : ["window", "cut", "duo"];
  const driveId = parseDriveId(gdriveUrl);
  const slugPreview = slug || slugify(title);
  const chosenLane = lanes.find((lane) => lane.id === laneId) || lanes[0];
  const activeJob = jobs.find((job) => job.id === activeId) || null;
  const activeWaiting = statusOf(activeJob) === "queued" && (activeJob?.notBefore || 0) > retryNow;
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

  const refreshDefaultsAndCatalog = useCallback(async () => {
    try {
      const [nextCatalog, nodeRes, settingsRes, provRes] = await Promise.all([
        api.intake.catalog(),
        api.studio.nodes().catch(() => ({ nodes: [] as RenderNode[], runtimeNodes: [] })),
        api.studio.getSettings().catch(() => null),
        api.studio.providers().catch(() => null),
      ]);
      setCatalog(nextCatalog);
      setNodes(nodeRes.nodes || []);
      if (settingsRes) setSettingsState(settingsRes);
      if (Array.isArray(provRes?.providers)) setStudioProviders(provRes.providers);
      if (!qualityTouched.current) {
        setRenderQuality(resolveDefaultQuality(settingsRes, nextCatalog));
      }
      if (!laneTouched.current) {
        setLaneId(defaultLaneId(nextCatalog, settingsRes));
      }
      if (nextCatalog.privileged === false) setPrivileged(false);
    } catch (error) {
      setAlert((current) => current ?? { text: errText(error), info: describeError(error), ok: false });
    }
  }, []);

  useEffect(() => {
    void refreshDefaultsAndCatalog();
    void loadJobs();
  }, [loadJobs, refreshDefaultsAndCatalog]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) void loadJobs();
    }, 4000);
    const onReturn = () => {
      if (!document.hidden) {
        void loadJobs();
        void refreshDefaultsAndCatalog();
      }
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("popstate", onReturn);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("popstate", onReturn);
    };
  }, [loadJobs, refreshDefaultsAndCatalog]);

  useEffect(() => {
    if (!providers.length) return;
    const stored = readPreferredVoice();
    let targetProvider = providers.find((item) => item.id === providerId);
    if ((!targetProvider || !providerTouched.current) && stored?.providerId) {
      const fromStored = providers.find(
        (item) =>
          (item.id === stored.providerId || item.engine === stored.providerId) &&
          item.available,
      );
      if (fromStored) targetProvider = fromStored;
    }
    if (!targetProvider) {
      targetProvider =
        (catalog?.defaultProvider
          ? providers.find((item) => item.id === catalog.defaultProvider && item.available)
          : undefined) ||
        providers.find((item) => item.available) ||
        providers[0];
    }
    if (!targetProvider) return;
    if (targetProvider.id !== providerId) {
      setProviderId(targetProvider.id);
    }

    let targetVoice = targetProvider.voices.find((item) => item.id === voiceId);
    if (
      !voiceTouched.current &&
      stored?.voiceId &&
      (targetProvider.id === stored.providerId || targetProvider.engine === stored.providerId)
    ) {
      const storedVoice = targetProvider.voices.find((item) => item.id === stored.voiceId);
      if (storedVoice) targetVoice = storedVoice;
    }
    if (!targetVoice) {
      targetVoice = targetProvider.voices.find((item) => item.default) || targetProvider.voices[0];
    }
    if (targetVoice) {
      if (targetVoice.id !== voiceId) setVoiceId(targetVoice.id);
      if (targetVoice.modelId !== modelId) setModelId(targetVoice.modelId);
    }
    if (catalog?.defaultBackground) setBackground((current) => current || catalog.defaultBackground);
    if (catalog?.defaultMotion) setMotion((current) => current || catalog.defaultMotion);
  }, [catalog, providers, providerId, voiceId, modelId]);

  useEffect(() => {
    if (laneTouched.current) return;
    setLaneId(defaultLaneId(catalog, settingsState));
  }, [catalog, settingsState]);

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
      setField("voice", provider?.available ? voiceMissingMessage : "Choose an available narrator before continuing.");
      focusField.current = useCustomVoice ? "ttsCustomVoice" : "ttsVoice";
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

  async function launch() {
    if (submitting || !privileged) return;
    if (!validateStory()) return;
    if (!provider?.available || !voice) {
      setStep(1);
      setField(
        "voice",
        provider && !provider.available
          ? `${provider.label} unavailable: ${provider.unavailableReason || "connect in Studio"}`
          : voiceMissingMessage,
      );
      return;
    }
    const finalProviderId = provider.id;
    const finalVoiceId = voice.id;
    const finalQuality: RenderQuality = renderQuality;
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
    const outroConfig = outroConfigFrom(outro);
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
          motion: motion || "window",
          animation: compactCardAnimation(cardAnimation),
          renderLane: lane.id,
          renderQuality: finalQuality,
          outroConfig,
          style,
          tts: ttsPayload,
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
            motion: motion || "window",
            animation: compactCardAnimation(cardAnimation),
            renderLane: lane.id || DEFAULT_LANE,
            renderQuality: finalQuality,
            outroConfig,
            style,
            tts: ttsPayload,
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
      qualityTouched.current = false;
      setLaneId(defaultLaneId(catalog, settingsState));
      setRenderQuality(resolveDefaultQuality(settingsState, catalog));
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
      setAlert({ text: message === "Upload cancelled" ? "Upload cancelled." : message, info: describeError(error), ok: false });
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
              ? merged.pauseRequested && statusOf(merged) !== "paused"
                ? `Pausing ${merged.title || merged.slug || "this job"} after the current step.`
                : `Paused ${merged.title || merged.slug || "this job"}.`
              : action === "resume"
                ? existing.pauseRequested && statusOf(existing) !== "paused"
                  ? `Pause cancelled for ${merged.title || merged.slug || "this job"}.`
                  : `Resumed ${merged.title || merged.slug || "this job"}.`
                : `Stop requested for ${merged.title || merged.slug || "this job"}.`,
        ok: true,
      });
      await loadJobs();
    } catch (error) {
      if (isApiError(error) && (error.status === 404 || error.status === 405)) {
        setUnsupported((current) => new Set(current).add(`${jobId}:${action === "cancel" ? "stop" : action}`));
        setActionNote({ text: "This server does not support that action yet. Use “View pipeline” to watch the run.", ok: false });
      } else {
        setActionNote({ text: errText(error), info: describeError(error), ok: false });
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
  const queueLabel = allActiveJobs.some((job) => statusOf(job) === "queued" && (job.notBefore || 0) > retryNow) ? "Retrying" : allActiveJobs.length || workerActive
    ? allActiveJobs[0] ? `Running · ${allActiveJobs[0].title || allActiveJobs[0].slug}` : "Running"
    : jobs.some((job) => statusOf(job) === "queued")
      ? `${jobs.filter((job) => statusOf(job) === "queued").length} queued`
      : "Ready";

  function renderJob(job: IntakeJob) {
    const status = statusOf(job);
    const waiting = status === "queued" && (job.notBefore || 0) > retryNow;
    const logs = Array.isArray(job.logTail) ? job.logTail : [];
    const errorText = friendlyJobError(job);
    const busy = busyIds.has(job.id);
    const retryable = canAction(job, "retry", privileged, unsupported);
    const continuable = canAction(job, "continue", privileged, unsupported);
    const stoppable = canAction(job, "stop", privileged, unsupported);
    const pausable = canAction(job, "pause", privileged, unsupported);
    const resumable = canAction(job, "resume", privileged, unsupported);
    const editable = canAction(job, "settings", privileged, unsupported);
    const pausing = isPausing(job);
    const lane = normalizeLaneId(job.renderLane);
    return (
      <article key={job.id} className="min-w-0 rounded-[22px] bg-card p-4 [overflow-wrap:anywhere] md:p-5" data-job={job.id} data-selected={job.id === activeId ? "true" : undefined}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 break-words text-[17px] font-semibold">{job.title || job.slug || job.id}</h3>
          <span className={cn("shrink-0 rounded-full px-3 py-1 text-xs font-medium", waiting ? "bg-warning-soft text-warning" : status === "failed" ? "bg-destructive-soft text-destructive" : status === "completed" ? "bg-success-soft text-success" : "bg-muted text-muted-foreground")}>{statusLabel(job, waiting)}</span>
        </div>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground" title={`${cleanVoiceName(job.tts?.voiceLabel || job.tts?.voiceId || job.tts?.providerLabel || "Narrated")} · render ${lane}`}>
          {waiting ? `Retry ${job.autoRetry?.count ?? 1} of ${job.autoRetry?.max ?? 3}` : job.ingestedChapters?.length ? `${job.ingestedChapters.length} ${job.ingestedChapters.length === 1 ? "chapter" : "chapters"}` : `Chapters ${job.chapters || "all"}`}
          {" · "}
          {waiting ? <span role="timer">in {retryCountdown(job.notBefore!, retryNow)}</span> : fmtAge(job.updatedAt || job.createdAt)}
        </p>
        {job.statusNote && !errorText && status !== "completed" ? <details className="mt-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">Details</summary><RawDetails text={job.statusNote} /></details> : null}
        <PauseInfo job={job} />
        <JobFailure job={job} />
        {waiting && job.autoRetry?.lastFailure ? <p className="mt-2 text-sm text-muted-foreground">{parseFailureNote(job.autoRetry.lastFailure).title}</p> : null}
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
            <summary className="inline-flex min-h-10 cursor-pointer items-center text-[13.5px] text-muted-foreground select-none hover:text-foreground">Log</summary>
            <pre tabIndex={0} aria-label={`Raw log for ${job.id}`} className="mt-2 max-h-64 overflow-auto rounded-2xl bg-muted p-4 font-mono text-xs leading-6 text-foreground">{logs.join("\n")}</pre>
          </details>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Tooltip label="View pipeline" side="top"><a aria-label="View pipeline" className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground" href={job.statusUrl || "/status.html"}><Activity className="size-[18px]" strokeWidth={1.75} aria-hidden /></a></Tooltip>
          {status === "completed" ? (
            <a className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover" href={job.libraryUrl || "/"}>Watch</a>
          ) : null}
          {pausable && !waiting ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "pause")}>
              {busy ? "Working…" : "Pause"}
            </Button>
          ) : null}
          {resumable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "resume")}>
              {busy ? "Working…" : pausing ? "Cancel pause" : "Resume"}
            </Button>
          ) : null}
          {editable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setSettingsJobId(job.id)}>
              Change settings
            </Button>
          ) : null}
          {stoppable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "stop")}>
              {busy ? "Working…" : "Stop"}
            </Button>
          ) : null}
          {retryable ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void runAction(job.id, "retry")}>
              {busy ? "Retrying…" : waiting ? "Retry now" : "Retry"}
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
      <div className="mx-auto flex max-w-5xl flex-col gap-6 [&_[role=alert]_button]:min-h-11">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.02em]">New series</h1>
          </div>
          <span className="rounded-full bg-muted px-3 py-1.5 text-xs">{queueLabel}</span>
        </div>

        {privileged ? null : (
          <Notice tone="warning" title="View only" />
        )}
        {alert && !(showLaunch && activeJob) ? (
          alert.ok ? <Notice tone="success" title="Queued" details={<RawDetails text={alert.text} />} /> : <ErrorNotice info={alert.info} error={alert.text} />
        ) : null}

        {showLaunch ? (
          <section className="rounded-[22px] bg-card p-5" tabIndex={-1} aria-labelledby="successHeading">
            {missingQuery && !activeJob ? (
              <>
                <Notice tone="danger" title="Run not found" details={<RawDetails text={missingQuery.job || missingQuery.series} />} />
                <h2 id="successHeading" className="sr-only">Run not found</h2>
              </>
            ) : activeJob ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h2 id="successHeading" className="min-w-0 text-2xl font-semibold tracking-[-0.015em]">{activeJob.title || activeJob.slug || "This series"}</h2>
                  <span className={cn("shrink-0 rounded-full px-3 py-1 text-xs font-medium", activeWaiting ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground")}>{statusLabel(activeJob, activeWaiting)}</span>
                </div>
                {activeWaiting ? <>
                  <p className="mt-2 text-sm text-muted-foreground">Retry {activeJob.autoRetry?.count ?? 1} of {activeJob.autoRetry?.max ?? 3} · <span role="timer">in {retryCountdown(activeJob.notBefore!, retryNow)}</span></p>
                  {activeJob.autoRetry?.lastFailure ? <p className="mt-2 text-sm text-muted-foreground">{parseFailureNote(activeJob.autoRetry.lastFailure).title}</p> : null}
                  <details className="mt-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">Details</summary><RawDetails text={[activeJob.autoRetry?.lastFailure, activeJob.failureDetail, activeJob.error, activeJob.statusNote].filter(Boolean).join("\n")} /></details>
                </> : <StagePips job={activeJob} />}
                <PauseInfo job={activeJob} />
                <JobFailure job={activeJob} />
              </>
            ) : (
              <h2 id="successHeading" className="text-2xl font-semibold tracking-[-0.015em]">Preparing production</h2>
            )}
            {actionNote ? (
              actionNote.ok ? <Notice className="mt-3" tone="success" title="Updated" details={<RawDetails text={actionNote.text} />} /> : <ErrorNotice className="mt-3" info={actionNote.info} error={actionNote.text} />
            ) : null}
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Tooltip label="View pipeline" side="top"><a aria-label="View pipeline" className="grid size-11 place-items-center rounded-full bg-muted" href={activeJob?.statusUrl || "/status.html"}><Activity className="size-[18px]" strokeWidth={1.75} aria-hidden /></a></Tooltip>
              {activeJob && !activeWaiting && canAction(activeJob, "pause", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "pause")}>Pause</Button>
              ) : null}
              {activeJob && canAction(activeJob, "resume", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "resume")}>{isPausing(activeJob) ? "Cancel pause" : "Resume"}</Button>
              ) : null}
              {activeJob && canAction(activeJob, "settings", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => setSettingsJobId(activeId)}>Change settings</Button>
              ) : null}
              {activeJob && canAction(activeJob, "stop", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "stop")}>Stop</Button>
              ) : null}
              {activeJob && canAction(activeJob, "retry", privileged, unsupported) ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={busyIds.has(activeId)} onClick={() => void runAction(activeId, "retry")}>{activeWaiting ? "Retry now" : "Retry"}</Button>
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
                      className="field mt-1 min-h-11 w-40 font-mono"
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
              <span id="continueHint" className="sr-only">Reuses the staged archive.</span>
            ) : null}
          </section>
        ) : null}

        {showForm ? (
          <form
            id="intakeForm"
            className="rounded-[22px] bg-card p-5 md:p-5"
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
                    {index < step ? null : index === 0 ? <Link2 className="size-4" aria-hidden /> : index === 1 ? <Volume2 className="size-4" aria-hidden /> : <Rocket className="size-4" aria-hidden />}
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
                  <h2 id="sourceHeading" tabIndex={-1} className="sr-only">Source</h2>
                  <label className="mt-4 block text-sm" htmlFor="seriesTitle">
                    Title
                    <input
                      id="seriesTitle"
                      className="field mt-1 min-h-11"
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
                  <details className="mt-2 text-xs text-muted-foreground" open={Boolean(errors.slug)}>
                    <summary className="cursor-pointer select-none">
                      Folder ID
                    </summary>
                    <label className="mt-2 block text-sm text-foreground" htmlFor="seriesSlug">
                      Slug preview
                      <input
                        id="seriesSlug"
                        className="field mt-1 min-h-11 font-mono"
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
                    <p id="slugPreview" className="mt-1 font-mono text-xs text-muted-foreground">series/{slugPreview || "—"}</p>
                  </details>
                  <FieldError id="slugError" message={errors.slug} />

                  <div className="mt-4 grid grid-cols-2 gap-1 rounded-full bg-muted p-1" role="tablist" aria-label="Archive source method" onKeyDown={onTabKey}>
                    <button type="button" role="tab" id="tabGdrive" className={cn("min-h-11 rounded-full px-4 text-left text-[14.5px] font-medium transition-colors", sourceMode === "gdrive" ? "bg-background text-foreground shadow-float" : "text-muted-foreground hover:text-foreground")} aria-selected={sourceMode === "gdrive"} aria-controls="paneGdrive" onClick={() => setSourceMode("gdrive")}>
                      <Link2 className="mr-2 inline size-4" aria-hidden /> Drive link
                    </button>
                    <button type="button" role="tab" id="tabUpload" className={cn("min-h-11 rounded-full px-4 text-left text-[14.5px] font-medium transition-colors", sourceMode === "upload" ? "bg-background text-foreground shadow-float" : "text-muted-foreground hover:text-foreground")} aria-selected={sourceMode === "upload"} aria-controls="paneUpload" onClick={() => setSourceMode("upload")}>
                      <Upload className="mr-2 inline size-4" aria-hidden /> Upload ZIP
                    </button>
                  </div>

                  {sourceMode === "gdrive" ? (
                    <div id="paneGdrive" role="tabpanel" aria-labelledby="tabGdrive" className="relative mt-4">
                      <label className="block text-sm" htmlFor="gdriveUrl">
                        Drive ZIP URL
                        <input
                          id="gdriveUrl"
                          className="field mt-1 min-h-11 font-mono"
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
                      <Tooltip label="Share as Anyone with the link." side="top"><button type="button" aria-label="Drive link help" className="absolute -top-3 right-0 grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
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
                        className="bg-background p-4"
                      >
                        <span className="flex items-center gap-3 text-start">
                          <Upload className="size-5 shrink-0 text-primary-text" aria-hidden />
                          <span>
                            <strong className="block">{file ? file.name : "Drop .zip or browse"}</strong>
                            <span id="fileMeta" className="text-sm text-muted-foreground">
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

                  <ChaptersField
                    id="chaptersSpec"
                    errorId="chaptersError"
                    value={chapters}
                    error={errors.chapters}
                    onChange={(value) => {
                      setChapters(value);
                      setField("chapters", "");
                    }}
                  />
                </section>
              ) : null}

              {step === 1 ? (
                <section aria-labelledby="narrationHeading">
                  <h2 id="narrationHeading" tabIndex={-1} className="sr-only">Voice &amp; style</h2>
                  <div className={cn("mt-4 grid gap-3", provider?.hasExplicitModels || synthModels.length ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
                    <label className="text-sm" htmlFor="ttsProvider">
                      Provider
                      <select
                        id="ttsProvider"
                        className="field mt-1 min-h-11"
                        value={provider?.id || providerId}
                        onChange={(event) => {
                          const nextProviderId = event.target.value;
                          providerTouched.current = true;
                          setProviderId(nextProviderId);
                          setCustomVoice(false);
                          setSynthModel("");
                          const nextProv = providers.find((item) => item.id === nextProviderId);
                          const nextDefaultVoice = nextProv?.voices.find((v) => v.default) || nextProv?.voices[0];
                          if (nextDefaultVoice) {
                            setModelId(nextDefaultVoice.modelId);
                            setVoiceId(nextDefaultVoice.id);
                            if (nextProv?.available) {
                              writePreferredVoice({
                                providerId: nextProv.id,
                                modelId: nextDefaultVoice.modelId,
                                voiceId: nextDefaultVoice.id,
                                engine: nextProv.engine,
                                voiceLabel: nextDefaultVoice.label,
                              });
                            }
                          }
                          setField("voice", "");
                        }}
                      >
                        {providers.map((item) => (
                          <option key={item.id} value={item.id} disabled={!item.available || item.voices.length === 0}>
                            {item.label}{item.available ? "" : " (Unavailable)"}
                          </option>
                        ))}
                      </select>
                    </label>
                    {provider?.hasExplicitModels ? (
                      <label className="text-sm" htmlFor="ttsModel">
                        Model
                        <select
                          id="ttsModel"
                          className="field mt-1 min-h-11"
                          value={activeModelGroup?.id || ""}
                          onChange={(event) => {
                            const nextModelId = event.target.value;
                            voiceTouched.current = true;
                            setModelId(nextModelId);
                            const nextGroup = provider.models.find((m) => m.id === nextModelId);
                            const currentShort = voice?.label;
                            const nextVoice =
                              nextGroup?.voices.find((v) => v.label === currentShort) ||
                              nextGroup?.voices.find((v) => v.default) ||
                              nextGroup?.voices[0];
                            if (nextVoice) {
                              setVoiceId(nextVoice.id);
                              if (provider.available) {
                                writePreferredVoice({
                                  providerId: provider.id,
                                  modelId: nextModelId,
                                  voiceId: nextVoice.id,
                                  engine: provider.engine,
                                  voiceLabel: nextVoice.label,
                                });
                              }
                            }
                            setField("voice", "");
                          }}
                        >
                          {provider.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="text-sm" htmlFor="ttsVoice">
                      <span id="ttsVoiceLabel">Narrator voice</span>
                      <select
                        id="ttsVoice"
                        aria-labelledby="ttsVoiceLabel"
                        className="field mt-1 min-h-11"
                        value={useCustomVoice ? CUSTOM_VOICE : listVoice?.id || ""}
                        aria-invalid={errors.voice && !useCustomVoice ? true : undefined}
                        aria-describedby="voiceError"
                        onChange={(event) => {
                          const nextVoiceId = event.target.value;
                          voiceTouched.current = true;
                          setField("voice", "");
                          if (nextVoiceId === CUSTOM_VOICE) {
                            setCustomVoice(true);
                            return;
                          }
                          setCustomVoice(false);
                          setVoiceId(nextVoiceId);
                          const nextVoice = provider?.voices.find((v) => v.id === nextVoiceId);
                          if (nextVoice && provider) {
                            setModelId(nextVoice.modelId);
                            if (provider.available) {
                              writePreferredVoice({
                                providerId: provider.id,
                                modelId: nextVoice.modelId,
                                voiceId: nextVoice.id,
                                engine: provider.engine,
                                voiceLabel: nextVoice.label,
                              });
                            }
                          }
                          setField("voice", "");
                        }}
                      >
                        {modelVoices.map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                        {isEleven && provider?.allowCustomVoice ? <option value={CUSTOM_VOICE}>Custom voice ID…</option> : null}
                      </select>
                    </label>
                    {synthModels.length ? (
                      <label className="text-sm" htmlFor="ttsSynthModel">
                        Model
                        <select
                          id="ttsSynthModel"
                          className="field mt-1 min-h-11"
                          value={activeSynthModel?.id || ""}
                          aria-describedby="ttsSynthModelHint"
                          onChange={(event) => setSynthModel(event.target.value)}
                        >
                          {synthModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}{m.tags ? " · audio tags" : ""}{m.id === provider?.defaultSynthModel ? " (default)" : ""}
                            </option>
                          ))}
                        </select>
                        <span id="ttsSynthModelHint" className="mt-1 block text-xs text-muted-foreground">
                          {activeSynthModel?.tags ? "Supports audio tags like [whispers]." : "No audio tags. Tags are removed from the script."}
                        </span>
                      </label>
                    ) : null}
                  </div>
                  {useCustomVoice ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <label className="text-sm" htmlFor="ttsCustomVoice">
                        <span id="ttsCustomVoiceLabel">Custom voice ID</span>
                        <input
                          id="ttsCustomVoice"
                          aria-labelledby="ttsCustomVoiceLabel"
                          className="field mt-1 min-h-11 font-mono"
                          value={customVoiceId}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="e.g. JBFqnCBsd6RMkjVDRZzb"
                          aria-invalid={customVoiceTrim && !customVoiceValid ? true : undefined}
                          aria-describedby="ttsCustomVoiceHint voiceError"
                          onChange={(event) => {
                            voiceTouched.current = true;
                            setCustomVoiceId(event.target.value);
                            setField("voice", "");
                          }}
                        />
                        <span id="ttsCustomVoiceHint" className={cn("mt-1 block text-xs", customVoiceTrim && !customVoiceValid ? "text-destructive" : "text-muted-foreground")}>
                          {customVoiceTrim && !customVoiceValid ? "Use 16 to 40 letters or digits." : "Paste the voice ID from ElevenLabs."}
                        </span>
                      </label>
                      <ElevenLabsVoiceCheck className="sm:mt-6" voiceId={customVoiceId} disabled={!provider?.available} />
                    </div>
                  ) : isEleven && listVoice ? (
                    <ElevenLabsVoiceCheck className="mt-3" voiceId={listVoice.id} disabled={!provider?.available} />
                  ) : null}
                  {isEleven && provider?.costNotice ? (
                    <p className="mt-3 text-xs text-muted-foreground" role="note">{provider.costNotice}</p>
                  ) : null}
                  {providers.some((item) => !item.available && item.unavailableReason) ? (
                    <ul className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
                      {providers
                        .filter((item) => !item.available && item.unavailableReason)
                        .map((item) => (
                          <li key={item.id}>
                            <strong>{item.label} unavailable:</strong> {item.unavailableReason}
                            {isElevenLabsProvider(item) ? (
                              <>
                                {" "}
                                <a className="underline underline-offset-2" href="/studio.html?settings=voice">Open Studio &gt; Voice</a>
                              </>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  <FieldError id="voiceError" message={errors.voice} />
                  <VoicePreview provider={provider} voice={voice} privileged={privileged} model={isEleven ? activeSynthModel?.id : undefined} />
                  <StyleFields catalog={catalog} style={style} tts={ttsStyle} onStyle={setStyle} onTts={setTtsStyle} disabled={!privileged} />
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-sm">Background</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Background world">
                        {backgrounds.map((id) => (
                          <button key={id} type="button" className={cn("min-h-11 rounded-full px-4 text-sm", background === id ? "bg-primary-soft text-primary-text" : "bg-muted")} aria-pressed={background === id} onClick={() => setBackground(id)}>
                            {BG_LABELS[id] || id}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-sm">Panel motion</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Panel card motion">
                        {motions.map((id) => (
                          <button key={id} type="button" className={cn("min-h-11 rounded-full px-4 text-sm", motion === id ? "bg-primary-soft text-primary-text" : "bg-muted")} aria-pressed={motion === id} onClick={() => setMotion(id)}>
                            {MOTION_LABELS[id] || id}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <details className="mt-4 text-sm">
                    <summary className="min-h-11 cursor-pointer py-3">Card animation (optional)</summary>
                    <CardAnimationFields className="mt-2" idPrefix="newCardAnim" value={cardAnimation} onChange={setCardAnimation} disabled={!privileged} />
                  </details>
                </section>
              ) : null}

              {step === 2 ? (
                <section aria-labelledby="productionHeading">
                  <h2 id="productionHeading" tabIndex={-1} className="sr-only">Launch</h2>
                  <RenderLaneField
                    id="renderLane"
                    noteId="renderLaneNote"
                    errorId="renderLaneError"
                    lanes={lanes}
                    value={chosenLane?.id || DEFAULT_LANE}
                    error={errors.renderLane}
                    disabled={!privileged}
                    onChange={(value) => {
                      laneTouched.current = true;
                      setLaneId(value);
                      setField("renderLane", "");
                    }}
                  />

                  <RenderQualityField
                    value={renderQuality}
                    onChange={(q) => {
                      qualityTouched.current = true;
                      setRenderQuality(q);
                    }}
                  />

                  <OutroFields value={outro} onChange={setOutro} />

                  <dl className="sr-group mt-4 divide-y divide-border bg-muted [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:text-right [&_dt]:shrink-0" aria-live="polite">
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Series</dt><dd>{title.trim() || "Not set"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Slug</dt><dd className="font-mono">{slugPreview || "Not set"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm">
                      <dt>Narration</dt>
                      <dd>
                        {provider && voice
                          ? isEleven && activeSynthModel
                            ? `${provider.label} · ${activeSynthModel.label} · ${voice.label}`
                            : provider.hasExplicitModels && activeModelGroup
                            ? `${provider.label} · ${activeModelGroup.label} · ${voice.label}`
                            : `${provider.label} · ${voice.label}`
                          : "Not set"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Chapters</dt><dd className="font-mono">{chapters.trim() || "all"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Source & style</dt><dd>{sourceMode === "upload" ? file?.name || "No ZIP selected" : driveId ? "Google Drive ZIP" : "Waiting for link"} · {BG_LABELS[background] || background} · {MOTION_LABELS[motion || "window"] || motion || "Window"}</dd></div>
                    <div className="flex justify-between gap-3 px-3 py-2 text-sm"><dt>Render lane & quality</dt><dd>{laneLabel(chosenLane?.id || DEFAULT_LANE, lanes)} · {renderQuality}</dd></div>
                    {outro.enabled ? (
                      <div className="flex justify-between gap-3 px-3 py-2 text-sm">
                        <dt>Episode outro</dt>
                        <dd className="font-mono">{outro.coveredChapters}/{outro.totalChapters} ch</dd>
                      </div>
                    ) : null}
                  </dl>
                  <Tooltip label={provider?.costNotice || spending} side="top"><button type="button" aria-label="Run cost information" className="mt-2 grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
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

            {chosenLane && !chosenLane.available && step !== 2 ? (
              <Notice className="mt-4" tone="danger" title="Lane unavailable" details={<RawDetails text={`${chosenLane.label}: ${chosenLane.unavailableReason || "disabled or removed"}. Choose another lane in Launch.`} />} />
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className="min-h-11 md:min-h-9" hidden={step === 0} disabled={submitting} onClick={() => goToStep(step - 1)}>Back</Button>
              {step < 2 ? (
                <Button
                  type="button"
                  variant="default"
                  className="min-h-11 md:min-h-9"
                  disabled={submitting}
                  onClick={() => goToStep(step + 1)}
                >
                  Continue
                </Button>
              ) : null}
              {step === 2 ? <Button
                type="submit"
                className="min-h-11 md:min-h-9"
                disabled={!privileged || submitting || Boolean(chosenLane && !chosenLane.available) || Boolean(provider && !provider.available)}
              >
                {submitting
                  ? sourceMode === "upload"
                    ? "Uploading & validating…"
                    : "Validating & queueing…"
                  : "Start series"}
              </Button> : null}
            </div>
          </form>
        ) : null}

        {showLaunch && !activeJobs.length && !recentJobs.length ? null : (
          <section aria-labelledby="queueHeading">
            <h2 id="queueHeading" className="sr-section-label">Runs</h2>
            {external.length && !allActiveJobs.length ? (
              <Notice className="mt-3" tone="info" title="Queued" details={<RawDetails text={`Waiting for ${external[0]?.series || "the active run"}.`} />} />
            ) : null}
            {queueNotice ? <Notice className="mt-3" tone="warning" title="Queue unavailable" details={<RawDetails text={queueNotice} />} /> : null}
            {!jobsLoaded ? <p className="mt-3 text-sm text-muted-foreground">Loading intake jobs…</p> : null}
            {jobsLoaded && !jobs.length ? (
              <p className="mt-3 rounded-2xl bg-card px-4 py-6 text-sm text-muted-foreground">No runs</p>
            ) : null}
            {activeJobs.length ? (
              <div className="mt-3 flex flex-col gap-3">
                {activeJobs.map(renderJob)}
              </div>
            ) : null}
            {recentJobs.length ? (
              <div className="mt-4 flex flex-col gap-3">
                {recentJobs.map(renderJob)}
              </div>
            ) : null}
          </section>
        )}
      </div>
      <RunSettingsDialog
        job={(jobs.find((job) => job.id === settingsJobId) as JobRecord | undefined) ?? null}
        open={Boolean(settingsJobId)}
        privileged={privileged}
        onClose={() => setSettingsJobId("")}
        onSaved={(saved, resumed) => {
          if (saved?.id) {
            setJobs((current) => current.map((job) => (job.id === saved.id ? { ...job, ...(saved as IntakeJob) } : job)));
          }
          setActionNote({ text: resumed ? "Settings saved. Resuming from saved work." : "Settings saved.", ok: true });
          void loadJobs();
        }}
      />
    </AppShell>
  );
}

const PAGE_CSS = `
.upload-track {
  position: relative;
  height: 8px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--background);
  border: 1px solid var(--border);
}
.upload-track > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--primary);
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
