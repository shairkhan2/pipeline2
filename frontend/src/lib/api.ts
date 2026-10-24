/**
 * Typed same-origin client for the Screening Room player API.
 *
 * CSRF: the token from `/api/session` (and any JSON body that carries
 * `csrfToken`) is cached in memory only. Mutations send it as
 * `X-CSRF-Token` and, for JSON bodies, as `csrfToken`.
 * Secrets are never written to localStorage or sessionStorage.
 *
 * 401: if the body or `GET /api/setup/state` reports `needsSetup`, the browser
 * is sent to `/setup.html`. Otherwise it is sent to `/login`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: unknown;
  readonly currentRevision?: number;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload ?? null;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (typeof record.code === "string") this.code = record.code;
      if (typeof record.currentRevision === "number") this.currentRevision = record.currentRevision;
    }
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isConflict(error: unknown): error is ApiError {
  return isApiError(error) && error.status === 409;
}

export type ProviderCategory = "cloud-api" | "subscription" | "cloud-iam" | "local";
export type ProviderProtocol = "openai-compatible" | "anthropic-messages" | "vertex-openai";
export type ProviderAuthMode =
  | "bearer"
  | "oauth-pkce"
  | "device-code"
  | "vertex-service-account"
  | "vertex-oauth"
  | "none";
export type StageId = "reader" | "matcher" | "writer" | "scout" | "fact_check";
export type PromptStageId = "reader" | "writer" | "story_writer" | "matcher" | "outro";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type RenderQuality = "1080p" | "720p";
import { parseIntakeJob, type JobRecord, type RenderNodeKind } from "./renderLanes";
export { parseIntakeJob, type JobRecord, type RenderNodeKind };
export type { AutoRetry, AutoRetrySettings, StageRetryFields } from "./retry";
export type NodeAction = "start" | "pause" | "stop" | "status" | "provision" | "auth-status" | "auth-start";
export type OutroHookType = "part2" | "next_chapter" | "new_series" | "custom";
export type TrashKind = "chapter-video" | "full-video" | "series-cache" | "series" | "artifact";

export interface Session {
  user: string;
  privileged: boolean;
  csrfToken: string;
  needsSetup: boolean;
}

export interface SetupState {
  needsSetup: boolean;
  hasAdmin: boolean;
  providerCount: number;
  nodeCount: number;
  setupTokenRequired: boolean;
}

export interface SetupAdminResult {
  ok: boolean;
  user: string;
  privileged: boolean;
}

export interface LibraryChapter {
  ch: string;
  num: number;
  url: string;
  poster: string | null;
  size: number;
  duration: number | null;
  mtime: number;
}

export interface LibrarySeries {
  slug: string;
  title: string;
  chapters: LibraryChapter[];
  full?: { url: string; size: number; duration: number | null };
}

export interface LibrarySnapshot {
  series: LibrarySeries[];
  thumbnails: Array<{ name: string; url: string; size: number; mtime: number }>;
  generatedAt: number;
  user?: string;
  privileged?: boolean;
  csrfToken?: string;
}

export interface PipelineWorker {
  id?: string;
  kind?: string;
  status?: string;
  available?: boolean;
  reason?: string;
  metrics?: {
    cpus?: number | null;
    mem_gb?: number | null;
    disk_gb?: number | null;
    load?: number | null;
  } | null;
  [key: string]: unknown;
}

export interface PipelineStatus {
  system?: {
    cpuPercent?: number | null;
    memory?: { total?: number; available?: number };
    disk?: { total?: number; available?: number };
  };
  schemaVersion?: number;
  at?: number;
  state?: string;
  running?: boolean;
  progress?: boolean;
  lastAgeS?: number | null;
  lastLine?: string | null;
  series?: string | null;
  workers?: PipelineWorker[];
  [key: string]: unknown;
}

export interface LaneConfig {
  schemaVersion: number;
  render: Array<{ id: string; enabled: boolean; slots: number }>;
  models: {
    vision: Array<{ id: string; enabled: boolean; concurrency: number }>;
    writer: Array<{ id: string; enabled: boolean; concurrency: number }>;
  };
}

export interface LanesState {
  schemaVersion: number;
  revision: number;
  source?: string;
  persisted?: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  config: LaneConfig;
  defaults?: LaneConfig;
  user?: string;
  privileged?: boolean;
  csrfToken?: string;
  [key: string]: unknown;
}

export interface JobsList {
  schemaVersion: number;
  at: number;
  workerActive: boolean;
  jobs: JobRecord[];
  privileged?: boolean;
  csrfToken?: string;
  [key: string]: unknown;
}

export type SeriesStyle = Partial<Record<'writerMode' | 'storyShape' | 'matchMode' | 'emotionTags' | 'pacing', string>>;
export type StyleOptions = Record<keyof SeriesStyle, Array<{ value: string; label: string; description: string }>>;
export interface TtsStyle { voice_id?: string; model_id?: string; speed?: number; style?: string; language?: string }

export type ElevenLabsKeyStatus = "ok" | "exhausted" | "invalid" | "cooldown" | "disabled";
export interface ElevenLabsKeySummary {
  id: string;
  label: string;
  hint: string;
  enabled: boolean;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  /** Unix seconds. */
  resetAt?: number;
  checkedAt?: string;
  canExtend?: boolean;
  allowOverage: boolean;
  status: ElevenLabsKeyStatus;
  /** Epoch milliseconds. */
  statusUntil?: number;
  statusReason?: string;
  blockedVoices: string[];
}
export interface ElevenLabsModel { id: string; label: string; tags: boolean; costMultiplier?: number }
export interface ElevenLabsKeysState {
  keys: ElevenLabsKeySummary[];
  models?: ElevenLabsModel[];
  defaultModel?: string;
  defaultVoice?: string;
}
export interface ElevenLabsVoiceCheck {
  voiceId: string;
  found: boolean;
  name?: string;
  category?: string;
  library: boolean;
  needsPaidKey: boolean;
  paidKeyAvailable: boolean;
  note?: string;
}
/** Window-motion card animation (series meta visuals.animation). Absent fields use the renderer defaults. */
export interface CardAnimation {
  entry?: 'none' | 'fade' | 'zoom' | 'slide-up' | 'slide-left';
  exit?: 'none' | 'fade' | 'zoom-out' | 'slide-down';
  entryS?: number;
  exitS?: number;
  pushIn?: 'off' | 'subtle' | 'normal' | 'strong';
  drift?: boolean;
}
export interface SeriesSettings {
  style: SeriesStyle;
  tts: TtsStyle & { engine?: string };
  visuals: { background?: string; motion?: string; animation?: CardAnimation };
  styleOptions: StyleOptions;
  /** Read-only, from meta.tts.engine. */
  ttsEngine?: string | null;
}
export interface SeriesSettingsPatch {
  style?: Partial<Record<keyof SeriesStyle, string | null>>;
  tts?: { voice_id?: string | null; model_id?: string | null; speed?: number | null; style?: string | null; language?: string | null };
  visuals?: { background?: string; motion?: string; animation?: CardAnimation | null };
}

export interface IntakeCatalog {
  styleOptions?: StyleOptions;
  ttsOptions?: { speed: { min: number; max: number; step: number; description: string }; style: { description: string }; language: { description: string } };
  schemaVersion: number;
  defaultProvider: string;
  defaultRenderLane?: string;
  defaultRenderQuality?: RenderQuality;
  providers: Array<Record<string, unknown>>;
  renderLanes: unknown;
  backgrounds: string[];
  defaultBackground: string;
  motions: string[];
  defaultMotion: string;
  user?: string;
  privileged?: boolean;
  csrfToken?: string;
  [key: string]: unknown;
}

export interface PreviewResult {
  id: string;
  duration: number;
  cached: boolean;
  audioUrl: string;
}

export interface OutroConfigInput {
  enabled?: boolean;
  totalChapters?: number;
  coveredChapters?: number;
  hookType?: OutroHookType;
  customPrompt?: string;
  nextSeriesTitle?: string;
  provider?: string;
  voice?: string;
  renderVideo?: boolean;
}

export interface OutroCharacterPanel {
  chapter?: string;
  ch?: string;
  page?: string;
  panelId?: string;
  id?: string;
  imageUrl?: string;
  previewUrl?: string;
  url?: string;
  path?: string;
  panelFile?: string;
  character?: string;
  characters?: string[];
  characterNames?: string[];
  shotType?: string;
  weight?: number;
  score?: number;
  caption?: string;
  visual?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface SeriesOutroState {
  ok?: boolean;
  slug: string;
  exists?: boolean;
  hasOutro?: boolean;
  hasVideo?: boolean;
  rendered?: boolean;
  renderError?: string | null;
  audioError?: string | null;
  warning?: string | null;
  script?: string;
  narration?: string;
  text?: string;
  lines?: string[];
  hookType?: OutroHookType;
  totalChapters?: number;
  coveredChapters?: number;
  availableChapters?: string[];
  panels?: OutroCharacterPanel[];
  selectedPanels?: OutroCharacterPanel[];
  characters?: Array<{ name: string; role?: string; description?: string; visual?: string }>;
  audioUrl?: string | null;
  videoUrl?: string | null;
  videoUpdatedAt?: number | null;
  generatedAt?: string | null;
  shotsPath?: string | null;
  updatedAt?: number | null;
  [key: string]: unknown;
}

export interface SeriesOutroAttachment {
  /** An explicit saved preference exists. False means the legacy include-by-default behaviour. */
  explicit: boolean;
  enabled: boolean;
  /** Chapter the attached outro follows (always the newest rendered chapter). */
  targetChapter: string | null;
  tailChapter: string | null;
  addedSinceAttach?: boolean;
  videoChanged?: boolean;
  missing?: boolean;
  /** Enabled attachment whose render is gone: merge is refused instead of dropping it. */
  blocked?: boolean;
  videoAvailable?: boolean;
  stale?: boolean;
  attachedAt?: string | null;
  /** Whether the next Merge All Chapters click includes the outro. */
  nextMergeIncludesOutro: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface SeriesOutroAttachmentResult {
  ok?: boolean;
  slug?: string;
  attachment?: SeriesOutroAttachment;
  merge?: SeriesMergeState;
  error?: string;
  [key: string]: unknown;
}

export interface SeriesMergeState {
  ok?: boolean;
  slug?: string;
  exists?: boolean;
  merged?: boolean;
  stale?: boolean;
  canMerge?: boolean;
  url?: string | null;
  downloadUrl?: string | null;
  size?: number;
  sizeBytes?: number;
  bytes?: number;
  duration?: number | null;
  chapters?: string[];
  chaptersMerged?: string[];
  chapterCount?: number;
  includesOutro?: boolean;
  /** Saved outro attachment state; absent on older servers. */
  attachment?: SeriesOutroAttachment;
  outro?: {
    included?: boolean;
    targetChapter?: string | null;
    position?: number | null;
    videoUrl?: string | null;
  };
  updatedAt?: number | null;
  mtime?: number | null;
  message?: string;
  [key: string]: unknown;
}

export interface SeriesExtendInput {
  chapters?: string;
  gdriveUrl?: string;
  file?: Blob | File | null;
  filename?: string;
  sourceType?: "existing" | "gdrive" | "upload";
  provider?: string;
  voice?: string;
  background?: string;
  motion?: string;
  renderLane?: string;
  renderQuality?: RenderQuality;
  preserveCompleted?: boolean;
  outroConfig?: OutroConfigInput;
}

export interface SeriesExtendResult {
  ok: boolean;
  slug: string;
  job?: JobRecord;
  preservedChapters?: string[];
  newChapters?: string[];
  targetChapters?: string;
  message?: string;
  warnings?: string[];
  [key: string]: unknown;
}

import {
  type LanguageExportState,
  type LanguageGenerateInput,
  type LanguageMergeInput,
  type LanguageOutroInput,
  type LanguagePreviewResult,
  type SeriesLanguagesState,
} from "./languages";

export {
  LANGUAGE_SPEED_MAX,
  LANGUAGE_SPEED_MIN,
  defaultLanguageChapters,
  firstAvailableLanguageVoice,
  hasLanguageVideo,
  isLanguageChapterRetryable,
  isLanguageExportBusy,
  isLanguageVersionActive,
  languageChapterNumber,
  languageChapterSettings,
  languageChapterSpec,
  languageChapterWarnings,
  languageMediaUrl,
  languageProviderLabel,
  languageRetryGroups,
  languageVoiceGroups,
  languageVoiceModelId,
  languageVoiceUnavailableReason,
  mergeNewerSnapshot,
  type LanguageCatalogEntry,
  type LanguageChapterSpec,
  type LanguageChapterVersion,
  type LanguageExportChapterNote,
  type LanguageExportError,
  type LanguageExportOutcome,
  type LanguageExportState,
  type LanguageGenerateInput,
  type LanguageMergeInput,
  type LanguageOutroInput,
  type LanguagePreviewResult,
  type LanguageRetryGroup,
  type LanguageRetrySettings,
  type LanguageSourceChapter,
  type LanguageVersion,
  type LanguageVersionStatus,
  type LanguageVoice,
  type LanguageVoiceModelGroup,
  type SeriesLanguagesState,
} from "./languages";

export type StagePromptValue =
  | string
  | {
      stage?: PromptStageId;
      content: string;
      isCustom?: boolean;
      preserveCacheHashes?: boolean;
      updatedAt?: number | null;
    };

export interface StudioPromptsState {
  schemaVersion?: number;
  revision?: number;
  updatedAt?: number | null;
  updatedBy?: string | null;
  preserveCacheHashes?: boolean;
  prompts: Record<PromptStageId | string, StagePromptValue>;
  defaults?: Record<PromptStageId | string, string>;
  [key: string]: unknown;
}

export function unwrapPromptValue(val: StagePromptValue | unknown): string {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "content" in val) {
    const content = (val as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

function normalizePromptsState(state: StudioPromptsState): StudioPromptsState {
  if (!state || typeof state !== "object") return state;
  const rawPrompts = state.prompts && typeof state.prompts === "object" ? state.prompts : {};
  const normalizedPrompts: Record<string, StagePromptValue> = {};
  for (const [stage, entry] of Object.entries(rawPrompts)) {
    if (entry && typeof entry === "object" && "content" in entry) {
      const content = typeof entry.content === "string" ? entry.content : "";
      const copy = { ...entry, content };
      Object.defineProperty(copy, "toString", { value: () => content, enumerable: false });
      Object.defineProperty(copy, "valueOf", { value: () => content, enumerable: false });
      normalizedPrompts[stage] = copy;
    } else if (typeof entry === "string") {
      normalizedPrompts[stage] = entry;
    }
  }
  return {
    ...state,
    prompts: normalizedPrompts,
  };
}

export interface StudioSettingsState {
  autoRetry?: import("./retry").AutoRetrySettings;
  defaultOutro?: { enabled: boolean; hookType: OutroHookType; customNote: string };
  schemaVersion?: number;
  revision?: number;
  renderQuality: RenderQuality;
  defaultRenderLane?: string;
  preserveCacheHashes?: boolean;
  updatedAt?: number | null;
  updatedBy?: string | null;
  settings?: {
    autoRetry?: import("./retry").AutoRetrySettings;
    defaultOutro?: { enabled: boolean; hookType: OutroHookType; customNote: string };
    renderQuality?: RenderQuality;
    defaultRenderLane?: string;
    preserveCacheHashes?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StorageChapterItem {
  ch: string;
  num?: number;
  videoBytes: number;
  audioBytes: number;
  panelsBytes: number;
  cacheBytes?: number;
  hasVideo: boolean;
  [key: string]: unknown;
}

export interface StorageSeriesBreakdown {
  slug: string;
  title: string;
  totalBytes: number;
  videoBytes: number;
  videosBytes?: number;
  fullVideoBytes: number;
  audioBytes: number;
  panelsBytes: number;
  cacheBytes: number;
  cachesBytes?: number;
  chapters: StorageChapterItem[];
  [key: string]: unknown;
}

export interface TrashItem {
  id: string;
  trashId?: string;
  kind: TrashKind | string;
  slug?: string;
  chapter?: string;
  label?: string;
  originalPath: string;
  trashPath?: string;
  sizeBytes: number;
  deletedAt: string | number;
  expiresNote?: string;
  [key: string]: unknown;
}

export interface StudioStorageReport {
  totalBytes: number;
  seriesBytes?: number;
  jobsBytes?: number;
  previewsBytes?: number;
  configBytes?: number;
  thumbsBytes?: number;
  trashBytes?: number;
  series: StorageSeriesBreakdown[];
  trash: TrashItem[];
  [key: string]: unknown;
}

export interface GdriveJobInput {
  style?: SeriesStyle;
  tts?: TtsStyle;
  gdriveUrl: string;
  title: string;
  slug?: string;
  provider?: string;
  voice?: string;
  chapters?: string;
  background?: string;
  motion?: string;
  animation?: CardAnimation;
  renderLane?: string;
  renderQuality?: RenderQuality;
  outroConfig?: OutroConfigInput;
}

export interface UploadJobInput {
  style?: SeriesStyle;
  tts?: TtsStyle;
  file: Blob;
  filename?: string;
  title: string;
  slug?: string;
  provider?: string;
  voice?: string;
  chapters?: string;
  background?: string;
  motion?: string;
  animation?: CardAnimation;
  renderLane?: string;
  renderQuality?: RenderQuality;
  outroConfig?: OutroConfigInput;
  onProgress?: (pct: number, loaded: number, total: number | null) => void;
}

export interface ProviderCapabilities {
  vision: boolean;
  writer: boolean;
  json: boolean;
  reasoning: boolean;
  streaming: boolean;
  tts: boolean;
  image?: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  enabled: boolean;
  roles?: Array<"vision" | "writer" | "reasoning" | "tts" | "image">;
  capabilities: ProviderCapabilities;
  reasoningEffort?: ReasoningEffort | null;
  thinking?: boolean | null;
  stream?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  costTier?: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  category: ProviderCategory;
  kind: ProviderCategory;
  protocol: ProviderProtocol;
  baseUrl: string;
  authMode: ProviderAuthMode;
  allowPrivateNetwork: boolean;
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  description: string;
  defaultModels?: ProviderModel[];
}

export interface VertexDetectedProject {
  projectId: string;
  name: string;
}

export interface ProviderAuthView {
  mode: string;
  secretRef: string;
  hasSecret: boolean;
  secretHint?: string;
  updatedAt?: number | null;
  accountEmail?: string;
  accountName?: string;
  accountPlan?: string;
  accountId?: string;
  expiresAt?: number;
  projectId?: string;
  projects?: VertexDetectedProject[];
  location?: string;
  clientId?: string;
}

export interface ProviderTestSummary {
  ok: boolean;
  status: number;
  latencyMs: number;
  testedAt: number;
  modelCount?: number;
  error?: string | null;
}

export interface ProviderView {
  id: string;
  label: string;
  preset?: string;
  kind: ProviderCategory | string;
  protocol: ProviderProtocol;
  baseUrl: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth: ProviderAuthView;
  models: ProviderModel[];
  lastTest?: ProviderTestSummary | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface ProvidersState {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
  providers: ProviderView[];
  presets: Record<string, ProviderPreset>;
}

export interface ProviderUpsert {
  id: string;
  label?: string;
  preset?: string;
  kind?: ProviderCategory | string;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  enabled?: boolean;
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  apiKey?: string;
  secret?: string;
  serviceAccountJson?: string;
  oauthToken?: string;
  auth?: Record<string, unknown>;
  models?: Array<string | (Partial<ProviderModel> & { id: string })>;
  expectedRevision?: number;
  revokeSecret?: boolean;
  verifyBeforeSave?: boolean;
  createOnly?: boolean;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
  contextWindow?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  testedAt: number;
  models: DiscoveredModel[];
  modelsCount?: number;
  error: string | null;
  provider?: ProviderView | null;
}

export interface StageRoute {
  stage: StageId;
  primary: string | null;
  fallbacks: string[];
  chain: string[];
  concurrency: number;
  temperature: number;
  llmVerify?: boolean;
  inheritFrom?: StageId | null;
}

export interface StagesState {
  schemaVersion: number;
  revision: number;
  persisted: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  stages: Record<StageId, StageRoute>;
  reader: StageRoute;
  matcher: StageRoute;
  writer: StageRoute;
  scout: StageRoute;
  fact_check: StageRoute;
}

export interface RenderNodeAuth {
  secretRef: string | null;
  hasSecret: boolean;
  secretHint: string | null;
  updatedAt: number | null;
}

export interface RenderNode {
  id: string;
  label: string;
  kind: RenderNodeKind;
  enabled: boolean;
  slots: number;
  supportsCleaner: boolean;
  priority: number;
  box?: string;
  template?: string;
  maxHours?: number;
  idlePauseS?: number;
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  maxLoadFactor?: number;
  minMemGb?: number;
  minDiskGb?: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  auth: RenderNodeAuth;
}

export interface RenderNodeUpsert {
  id: string;
  label?: string;
  kind: RenderNodeKind;
  enabled?: boolean;
  slots?: number;
  supportsCleaner?: boolean;
  priority?: number;
  box?: string;
  template?: string;
  maxHours?: number;
  idlePauseS?: number;
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  sshKey?: string;
  privateKey?: string;
  maxLoadFactor?: number;
  minMemGb?: number;
  minDiskGb?: number;
  expectedRevision?: number;
}

export interface RuntimeNode {
  id: string;
  kind?: string;
  label?: string;
  enabled?: boolean;
  slots?: number;
  [key: string]: unknown;
}

export interface StudioCatalog {
  presets: Record<string, ProviderPreset>;
  providers: ProviderView[];
  providersRevision: number;
  stages: StagesState;
  nodes: RenderNode[];
  runtimeNodes: RuntimeNode[];
  stageList: StageId[];
  prompts?: StudioPromptsState;
  settings?: StudioSettingsState;
}

export interface NodeProbe {
  ok: boolean;
  reason: string;
  kind: string;
}

export interface NodeActionResult {
  ok: boolean;
  detail: string;
  status?: string;
  probe?: Record<string, unknown>;
}

export interface PkceStart {
  ok: boolean;
  providerId: string;
  redirectUri: string;
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  authorizeUrl?: string;
  verifier?: string;
}

export interface DeviceStart {
  ok: boolean;
  providerId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}

export interface AuditEntry {
  at: number;
  user: string;
  action: string;
  target: string;
  revision: number;
}

export interface AgyOverview {
  [key: string]: unknown;
}

type CsrfMode = "none" | "header" | "both";

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Default: `both` on mutations, `none` on GET. `header` omits the body field. */
  csrf?: CsrfMode;
  /** When false, a 401 is thrown and the browser stays put. */
  redirectOn401?: boolean;
}

const SETUP_PATHS = new Set(["/setup", "/setup.html", "/login"]);

let csrfToken = "";
let redirecting = false;

export function getCsrfToken(): string {
  return csrfToken;
}

export function setCsrfToken(token: string): void {
  if (token) csrfToken = token;
}

function rememberCsrf(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const token = (payload as { csrfToken?: unknown }).csrfToken;
  if (typeof token === "string" && token) csrfToken = token;
}

function isSetupPath(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return SETUP_PATHS.has(path) || window.location.hash.startsWith("#/setup");
}

function redirectForAuth(needsSetup: boolean): void {
  if (typeof window === "undefined" || redirecting || isSetupPath()) return;
  redirecting = true;
  window.location.assign(needsSetup ? "/setup.html" : "/login");
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, deadline]);
  return signal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

async function readPayload(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    if (response.status === 204) return null;
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, response: Response): string {
  if (payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" && (payload as { error: string }).error) {
    return (payload as { error: string }).error;
  }
  if (response.ok) return "Invalid server response";
  const status = response.status;
  const fallback = response.statusText.trim();
  if (status >= 400 && status < 500) {
    return fallback || `Request failed (HTTP ${status})`;
  }
  return `Server unavailable (HTTP ${status})`;
}

async function resolveNeedsSetup(payload: unknown): Promise<boolean> {
  if (payload && typeof payload === "object" && (payload as { needsSetup?: unknown }).needsSetup === true) {
    return true;
  }
  try {
    const state = await request<SetupState>("/api/setup/state", {
      method: "GET",
      csrf: "none",
      redirectOn401: false,
      timeoutMs: 8000,
    });
    return state.needsSetup === true;
  } catch {
    return false;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const csrfMode: CsrfMode = options.csrf ?? (isMutation ? "both" : "none");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  let body: BodyInit | undefined;
  if (options.body instanceof Blob || options.body instanceof FormData || typeof options.body === "string") {
    body = options.body;
  } else if (options.body !== undefined || (isMutation && csrfMode === "both")) {
    const record =
      options.body && typeof options.body === "object" && !Array.isArray(options.body)
        ? { ...(options.body as Record<string, unknown>) }
        : {};
    if (csrfMode === "both") {
      if (!csrfToken) await refreshCsrf();
      if (csrfToken) record.csrfToken = csrfToken;
    }
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(record);
  }

  if (csrfMode !== "none") {
    if (!csrfToken) await refreshCsrf();
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }

  const timeoutMs = options.timeoutMs ?? 120000;
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: withTimeout(options.signal, timeoutMs),
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
      throw new ApiError("Request timed out or was cancelled.", 0, { cause: error });
    }
    throw new ApiError("Could not reach the server. Check your connection and retry.", 0, { cause: error });
  }

  if (response.status === 401 && options.redirectOn401 !== false) {
    const payload = await readPayload(response);
    const needsSetup = await resolveNeedsSetup(payload);
    redirectForAuth(needsSetup);
    throw new ApiError(
      needsSetup ? "First-run setup is required." : "Your session expired. Sign in again.",
      401,
      payload,
    );
  }

  const payload = await readPayload(response);
  rememberCsrf(payload);
  if (!response.ok) {
    throw new ApiError(errorMessage(payload, response), response.status, payload);
  }
  const type = response.headers.get("content-type") || "";
  if (response.status !== 204 && type && !type.includes("application/json")) {
    throw new ApiError("Invalid server response", response.status, payload);
  }
  return payload as T;
}

let csrfRefresh: Promise<void> | null = null;

function refreshCsrf(): Promise<void> {
  if (csrfToken) return Promise.resolve();
  if (csrfRefresh) return csrfRefresh;
  csrfRefresh = request<Session>("/api/session", {
    method: "GET",
    csrf: "none",
    redirectOn401: false,
    timeoutMs: 8000,
  })
    .then((session) => {
      if (session?.csrfToken) csrfToken = session.csrfToken;
    })
    .catch(() => {
      /* Setup bootstrap and signed-out calls have no session yet. */
    })
    .finally(() => {
      csrfRefresh = null;
    });
  return csrfRefresh;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

export const api = {
  session(): Promise<Session> {
    return request<Session>("/api/session");
  },

  library(): Promise<LibrarySnapshot> {
    return request<LibrarySnapshot>("/api/library");
  },

  deleteChapter(input: { slug: string; chapter: string; confirm: string }): Promise<{
    ok: boolean;
    slug: string;
    chapter: string;
    deleted: string[];
    freedBytes: number;
    message: string;
  }> {
    return request("/api/library/delete", { method: "POST", body: input });
  },

  status(): Promise<PipelineStatus> {
    return request<PipelineStatus>("/api/status", { timeoutMs: 15000 });
  },

  lanes: {
    get(): Promise<LanesState> {
      return request<LanesState>("/api/lanes");
    },
    put(body: { revision: number; config: LaneConfig }): Promise<LanesState> {
      return request<LanesState>("/api/lanes", { method: "PUT", body });
    },
    reset(revision?: number | null): Promise<LanesState> {
      const body: { reset: true; revision?: number } = { reset: true };
      if (typeof revision === "number") body.revision = revision;
      return request<LanesState>("/api/lanes/reset", { method: "POST", body });
    },
  },

  intake: {
    catalog(): Promise<IntakeCatalog> {
      return request<IntakeCatalog>("/api/intake/catalog");
    },
    jobs(): Promise<JobsList> {
      return request<JobsList>("/api/intake/jobs").then((res) => ({
        ...res,
        jobs: Array.isArray(res?.jobs) ? res.jobs.map((j) => parseIntakeJob(j)) : [],
      }));
    },
    job(id: string): Promise<JobRecord> {
      return request<JobRecord>(`/api/intake/jobs/${enc(id)}`).then((res) =>
        parseIntakeJob(res && typeof res === "object" && "job" in res && res.job ? res.job : res),
      );
    },
    retry(id: string): Promise<{ job: JobRecord }> {
      return request<{ job: JobRecord }>(`/api/intake/jobs/${enc(id)}/retry`, { method: "POST", body: {} }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    continue(id: string, chapters: string): Promise<{ job: JobRecord }> {
      return request<{ job: JobRecord }>(`/api/intake/jobs/${enc(id)}/continue`, { method: "POST", body: { chapters } }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    pauseJob(id: string): Promise<{ ok?: boolean; job: JobRecord }> {
      return request<{ ok?: boolean; job: JobRecord }>(`/api/intake/jobs/${enc(id)}/pause`, { method: "POST", body: {} }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    resumeJob(id: string): Promise<{ ok?: boolean; job: JobRecord }> {
      return request<{ ok?: boolean; job: JobRecord }>(`/api/intake/jobs/${enc(id)}/resume`, { method: "POST", body: {} }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    stopJob(id: string): Promise<{ ok?: boolean; job: JobRecord }> {
      return request<{ ok?: boolean; job: JobRecord }>(`/api/intake/jobs/${enc(id)}/stop`, { method: "POST", body: {} }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    cancelJob(id: string): Promise<{ ok?: boolean; job: JobRecord }> {
      return request<{ ok?: boolean; job: JobRecord }>(`/api/intake/jobs/${enc(id)}/stop`, { method: "POST", body: {} }).then(
        (res) => ({ ...res, job: parseIntakeJob(res?.job ?? res) }),
      );
    },
    /** Voice preview. CSRF travels in the header only — the body allow-list is `provider`, `voice` and `model`. */
    preview(provider: string, voice: string, signal?: AbortSignal, model?: string): Promise<PreviewResult> {
      return request<PreviewResult>("/api/intake/preview", {
        method: "POST",
        csrf: "header",
        body: model ? { provider, voice, model } : { provider, voice },
        signal,
        timeoutMs: 60000,
      });
    },
    previewAudioUrl(id: string): string {
      return `/api/intake/preview/${enc(id)}.mp3`;
    },
    createGdriveJob(input: GdriveJobInput): Promise<JobRecord> {
      return request<JobRecord>("/api/intake/jobs", {
        method: "POST",
        body: { sourceType: "gdrive", ...input },
      }).then((res) => parseIntakeJob(res && typeof res === "object" && "job" in res && res.job ? res.job : res));
    },
    uploadZip(
      input: UploadJobInput,
      signal?: AbortSignal,
      onProgress?: (pct: number, loaded: number, total: number | null) => void,
    ): Promise<JobRecord> {
      const query: Record<string, string> = {
        sourceType: "upload",
        title: input.title,
        filename: input.filename || "upload.zip",
      };
      if (input.slug) query.slug = input.slug;
      if (input.provider) query.provider = input.provider;
      if (input.voice) query.voice = input.voice;
      if (input.chapters) query.chapters = input.chapters;
      if (input.background) query.background = input.background;
      if (input.motion) query.motion = input.motion;
      if (input.animation && Object.keys(input.animation).length) query.animation = JSON.stringify(input.animation);
      if (input.renderLane) query.renderLane = input.renderLane;
      if (input.renderQuality) query.renderQuality = input.renderQuality;
      if (input.outroConfig) query.outroConfig = JSON.stringify(input.outroConfig);
      if (input.style) query.style = JSON.stringify(input.style);
      if (input.tts) query.tts = JSON.stringify(input.tts);
      const progressCb = onProgress ?? input.onProgress;
      if (progressCb && typeof XMLHttpRequest !== "undefined") {
        return (async () => {
          if (!csrfToken) await refreshCsrf();
          return await new Promise<JobRecord>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const abort = () => xhr.abort();
            signal?.addEventListener("abort", abort);
            const finish = () => signal?.removeEventListener("abort", abort);
            xhr.open("POST", buildUrl("/api/intake/jobs", query));
            xhr.timeout = 720000;
            xhr.setRequestHeader("Accept", "application/json");
            xhr.setRequestHeader("Content-Type", input.file.type || "application/zip");
            if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
            xhr.upload.addEventListener("progress", (event) => {
              const total = event.lengthComputable && event.total > 0 ? event.total : null;
              const pct = total ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
              progressCb(pct, event.loaded, total);
            });
            xhr.addEventListener("load", () => {
              finish();
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(xhr.responseText || "{}") as Record<string, unknown>;
              } catch {
                reject(
                  new ApiError(
                    `Invalid upload response (HTTP ${xhr.status}). Refresh the queue before retrying.`,
                    xhr.status,
                  ),
                );
                return;
              }
              rememberCsrf(parsed);
              if (xhr.status === 401) {
                const needsSetup = parsed.needsSetup === true;
                redirectForAuth(needsSetup);
                reject(
                  new ApiError(
                    needsSetup ? "First-run setup is required." : "Your session expired. Sign in again.",
                    401,
                    parsed,
                  ),
                );
                return;
              }
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(parseIntakeJob("job" in parsed && parsed.job ? parsed.job : parsed));
              } else {
                const msg = typeof parsed.error === "string" ? parsed.error : `Upload failed (HTTP ${xhr.status})`;
                reject(new ApiError(msg, xhr.status, parsed));
              }
            });
            xhr.addEventListener("error", () => {
              finish();
              reject(new ApiError("Network error while uploading ZIP archive", 0));
            });
            xhr.addEventListener("abort", () => {
              finish();
              reject(new ApiError("Upload cancelled", 0));
            });
            xhr.addEventListener("timeout", () => {
              finish();
              reject(new ApiError("Upload timed out. Refresh the queue before retrying.", 0));
            });
            xhr.send(input.file);
          });
        })();
      }
      return request<JobRecord>("/api/intake/jobs", {
        method: "POST",
        csrf: "header",
        query,
        body: input.file,
        headers: { "Content-Type": input.file.type || "application/zip" },
        signal,
        timeoutMs: 0,
      }).then((res) => parseIntakeJob(res && typeof res === "object" && "job" in res && res.job ? res.job : res));
    },
  },

  series: {
    getSettings(slug: string): Promise<SeriesSettings> {
      return request(`/api/series/${enc(slug)}/settings`);
    },
    patchSettings(slug: string, patch: SeriesSettingsPatch): Promise<SeriesSettings> {
      return request(`/api/series/${enc(slug)}/settings`, { method: 'PATCH', body: patch });
    },
    /** Language versions: catalog, English source eligibility, and per-chapter Hindi progress. */
    languages(slug: string, signal?: AbortSignal): Promise<SeriesLanguagesState> {
      return request<SeriesLanguagesState>(`/api/series/${enc(slug)}/languages`, { signal, timeoutMs: 20000 });
    },
    generateLanguage(slug: string, input: LanguageGenerateInput, signal?: AbortSignal): Promise<SeriesLanguagesState> {
      return request<SeriesLanguagesState>(`/api/series/${enc(slug)}/languages`, {
        method: "POST",
        body: input,
        signal,
        timeoutMs: 60000,
      });
    },
    previewLanguage(
      slug: string,
      input: { locale: string; voice: string; speed?: number },
      signal?: AbortSignal,
    ): Promise<LanguagePreviewResult> {
      return request<LanguagePreviewResult>(`/api/series/${enc(slug)}/languages/preview`, {
        method: "POST",
        body: input,
        signal,
        timeoutMs: 60000,
      });
    },
    /** Merge/outro/download state of one language version (e.g. `hi-IN`). */
    languageExport(slug: string, locale: string, signal?: AbortSignal, includeOutro?: boolean): Promise<LanguageExportState> {
      const query = includeOutro === undefined ? "" : `?includeOutro=${includeOutro}`;
      return request<LanguageExportState>(`/api/series/${enc(slug)}/languages/${enc(locale)}/export${query}`, {
        signal,
        timeoutMs: 20000,
      });
    },
    /**
     * Start joining finished language chapters (plus the language outro when present).
     * Answers 202 at once with `busy.merge: true`; poll `languageExport` until it clears,
     * then read `lastMerge`.
     */
    mergeLanguage(slug: string, locale: string, input: LanguageMergeInput = {}, signal?: AbortSignal): Promise<LanguageExportState> {
      return request<LanguageExportState>(`/api/series/${enc(slug)}/languages/${enc(locale)}/merge`, {
        method: "POST",
        body: input,
        signal,
        timeoutMs: 30000,
      });
    },
    /** Start making or replacing the language outro (202, then poll; outcome in `lastOutro`). */
    generateLanguageOutro(slug: string, locale: string, input: LanguageOutroInput = {}, signal?: AbortSignal): Promise<LanguageExportState> {
      return request<LanguageExportState>(`/api/series/${enc(slug)}/languages/${enc(locale)}/outro`, {
        method: "POST",
        body: input,
        signal,
        timeoutMs: 30000,
      });
    },
    getOutro(slug: string): Promise<SeriesOutroState> {
      return request<SeriesOutroState>(`/api/series/${enc(slug)}/outro`);
    },
    generateOutro(slug: string, payload: OutroConfigInput): Promise<SeriesOutroState> {
      return request<SeriesOutroState>(`/api/series/${enc(slug)}/outro`, {
        method: "POST",
        body: payload,
        timeoutMs: 120000,
      });
    },
    getMerge(slug: string): Promise<SeriesMergeState> {
      return request<SeriesMergeState>(`/api/series/${enc(slug)}/merge`);
    },
    setOutroAttachment(slug: string, enabled: boolean): Promise<SeriesOutroAttachmentResult> {
      return request<SeriesOutroAttachmentResult>(`/api/series/${enc(slug)}/outro/attachment`, {
        method: "POST",
        body: { enabled },
        timeoutMs: 30000,
      });
    },
    mergeAll(slug: string, payload?: { includeOutro?: boolean; force?: boolean }): Promise<SeriesMergeState> {
      return request<SeriesMergeState>(`/api/series/${enc(slug)}/merge`, {
        method: "POST",
        body: payload ?? {},
        timeoutMs: 300000,
      });
    },
    extend(
      slug: string,
      payload: SeriesExtendInput | Blob,
      options?: Omit<SeriesExtendInput, "file">,
    ): Promise<SeriesExtendResult> {
      const file = payload instanceof Blob ? payload : payload.file instanceof Blob ? payload.file : null;
      const meta: SeriesExtendInput = payload instanceof Blob ? (options ?? {}) : payload;
      if (file) {
        const inferredName =
          meta.filename || (typeof File !== "undefined" && file instanceof File && file.name ? file.name : "upload.zip");
        const query: Record<string, string> = {
          filename: inferredName,
        };
        if (meta.chapters) query.chapters = meta.chapters;
        if (meta.background) query.background = meta.background;
        if (meta.motion) query.motion = meta.motion;
        if (meta.preserveCompleted !== undefined) query.preserveCompleted = String(meta.preserveCompleted);
        if (meta.renderLane) query.renderLane = meta.renderLane;
        if (meta.renderQuality) query.renderQuality = meta.renderQuality;
        if (meta.provider) query.provider = meta.provider;
        if (meta.voice) query.voice = meta.voice;
        if (meta.outroConfig) query.outroConfig = JSON.stringify(meta.outroConfig);
        return request<SeriesExtendResult>(`/api/series/${enc(slug)}/extend`, {
          method: "POST",
          csrf: "header",
          query,
          body: file,
          headers: { "Content-Type": "application/zip" },
          timeoutMs: 0,
        });
      }
      return request<SeriesExtendResult>(`/api/series/${enc(slug)}/extend`, {
        method: "POST",
        body: meta,
        timeoutMs: 120000,
      });
    },
  },

  studio: {
    catalog(): Promise<StudioCatalog> {
      return request<StudioCatalog>("/api/studio/catalog").then((cat) =>
        cat && cat.prompts ? { ...cat, prompts: normalizePromptsState(cat.prompts) } : cat,
      );
    },
    providers(): Promise<ProvidersState> {
      return request<ProvidersState>("/api/studio/providers");
    },
    provider(id: string): Promise<{ provider: ProviderView }> {
      return request(`/api/studio/providers/${enc(id)}`);
    },
    createProvider(input: ProviderUpsert): Promise<{ ok: boolean; provider: ProviderView; providers: ProviderView[] }> {
      return request("/api/studio/providers", { method: "POST", body: input });
    },
    updateProvider(
      id: string,
      input: Partial<ProviderUpsert>,
    ): Promise<{ ok: boolean; provider: ProviderView; providers: ProviderView[] }> {
      return request(`/api/studio/providers/${enc(id)}`, { method: "PATCH", body: input });
    },
    deleteProvider(id: string): Promise<{ ok: boolean; providers: ProviderView[] }> {
      return request(`/api/studio/providers/${enc(id)}`, { method: "DELETE", body: {} });
    },
    revokeSecret(id: string): Promise<{ ok: boolean; provider: ProviderView | null }> {
      return request(`/api/studio/providers/${enc(id)}`, {
        method: "DELETE",
        query: { revokeSecretOnly: 1 },
        body: {},
      });
    },
    testProvider(id: string): Promise<ProviderTestResult> {
      return request(`/api/studio/providers/${enc(id)}/test`, { method: "POST", body: {}, timeoutMs: 45000 });
    },
    discoverModels(
      id: string,
      save = true,
    ): Promise<{ ok: boolean; models: DiscoveredModel[]; provider: ProviderView | null }> {
      return request(`/api/studio/providers/${enc(id)}/models/discover`, {
        method: "POST",
        body: { save },
        timeoutMs: 45000,
      });
    },
    pkceStart(input: {
      providerId?: string;
      mode?: ProviderAuthMode;
      preset?: string;
      redirectUri?: string;
      authorizeUrl?: string;
      clientId?: string;
      scopes?: string[];
    }): Promise<PkceStart> {
      return request("/api/studio/oauth/pkce-start", { method: "POST", body: input });
    },
    pkceExchange(input: {
      providerId: string;
      mode?: ProviderAuthMode;
      codeOrUrl?: string;
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
      clientId?: string;
      tokenUrl?: string;
      accessToken?: string;
      refreshToken?: string;
      projectId?: string;
      location?: string;
      autoDiscoverModels?: boolean;
    }): Promise<{
      ok: boolean;
      provider: ProviderView | null;
      expiresAt?: number;
      projectId?: string;
      projects?: VertexDetectedProject[];
    }> {
      return request("/api/studio/oauth/pkce-exchange", { method: "POST", body: input });
    },
    deviceStart(
      providerId = "github-copilot",
      options?: { clientId?: string; preset?: string },
    ): Promise<DeviceStart> {
      const presetOrId = options?.preset || providerId;
      const defaultClientId =
        presetOrId === "codex-oauth"
          ? "app_EMoamEEZ73f0CkXaXp7hrann"
          : presetOrId === "grok-subscription"
            ? "b1a00492-073a-47ea-816f-4c329264a828"
            : "Ov23li8tweQw6odWQebz";
      const clientId = options?.clientId || defaultClientId;
      return request("/api/studio/oauth/device-start", {
        method: "POST",
        body: { providerId, ...(options?.preset ? { preset: options.preset } : {}), clientId },
      });
    },
    devicePoll(
      input: string | { providerId: string; preset?: string; accessToken?: string } = "github-copilot",
    ): Promise<{
      ok: boolean;
      status: "pending" | "authorized";
      provider?: ProviderView | null;
    }> {
      const body = typeof input === "string" ? { providerId: input } : input;
      return request("/api/studio/oauth/device-poll", { method: "POST", body });
    },
    stages(): Promise<StagesState> {
      return request<StagesState>("/api/studio/stages");
    },
    putStages(body: { revision: number; stages: Record<string, Partial<StageRoute>> }): Promise<StagesState> {
      return request<StagesState>("/api/studio/stages", { method: "PUT", body });
    },
    nodes(): Promise<{ nodes: RenderNode[]; runtimeNodes: RuntimeNode[] }> {
      return request("/api/studio/nodes");
    },
    createNode(input: RenderNodeUpsert): Promise<{ ok: boolean; node: RenderNode; nodes: RenderNode[] }> {
      return request("/api/studio/nodes", { method: "POST", body: input });
    },
    updateNode(
      id: string,
      input: Partial<RenderNodeUpsert> & { kind?: RenderNodeKind },
    ): Promise<{ ok: boolean; node: RenderNode; nodes: RenderNode[] }> {
      return request(`/api/studio/nodes/${enc(id)}`, { method: "PATCH", body: input });
    },
    deleteNode(id: string): Promise<{ ok: boolean; nodes: RenderNode[] }> {
      return request(`/api/studio/nodes/${enc(id)}`, { method: "DELETE", body: {} });
    },
    sbxAuthStatus(): Promise<{
      authenticated: boolean;
      detail: string;
      sandboxes?: Array<{ name: string; id: string; status: string; cpus?: number; memoryMib?: number }>;
    }> {
      return request("/api/studio/sbx/auth");
    },
    sbxAuthStart(token?: string): Promise<{
      ok: boolean;
      authenticated: boolean;
      verificationUrl: string | null;
      userCode?: string | null;
      instructions: string;
      detail: string;
      sandboxes?: Array<{ name: string; id: string; status: string; cpus?: number; memoryMib?: number }>;
    }> {
      return request("/api/studio/sbx/auth", {
        method: "POST",
        body: { mode: "start", ...(token ? { token } : {}) },
        timeoutMs: 30000,
      });
    },
    testNode(id: string): Promise<NodeProbe> {
      return request(`/api/studio/nodes/${enc(id)}/test`, { method: "POST", body: {}, timeoutMs: 45000 });
    },
    nodeAction(id: string, action: NodeAction): Promise<NodeActionResult> {
      return request(`/api/studio/nodes/${enc(id)}/action`, {
        method: "POST",
        body: { action },
        timeoutMs: action === "provision" ? 300000 : 60000,
      });
    },
    getPrompts(): Promise<StudioPromptsState> {
      return request<StudioPromptsState>("/api/studio/prompts").then(normalizePromptsState);
    },
    putPrompts(payload: {
      prompts?: Record<string, StagePromptValue | { content?: string; reset?: boolean }>;
      stage?: PromptStageId | string;
      prompt?: string;
      preserveCacheHashes?: boolean;
      revision?: number;
      expectedRevision?: number;
    }): Promise<StudioPromptsState> {
      const mergedPrompts: Record<string, string | { content?: string; reset?: boolean }> = {};
      if (payload.prompts && typeof payload.prompts === "object") {
        for (const [key, val] of Object.entries(payload.prompts)) {
          if (typeof val === "string") {
            mergedPrompts[key] = val;
          } else if (val && typeof val === "object") {
            if ("reset" in val && val.reset) mergedPrompts[key] = { reset: true };
            else if ("content" in val && typeof val.content === "string") mergedPrompts[key] = val.content;
          }
        }
      }
      if (payload.stage && typeof payload.prompt === "string") {
        mergedPrompts[payload.stage] = payload.prompt;
      }
      const body = {
        ...payload,
        prompts: mergedPrompts,
        stage: payload.stage,
        prompt: payload.prompt,
        preserveCacheHashes: payload.preserveCacheHashes,
      };
      return request<StudioPromptsState>("/api/studio/prompts", {
        method: "PUT",
        body,
      }).then(normalizePromptsState);
    },
    resetPrompt(stage?: PromptStageId | string): Promise<StudioPromptsState> {
      return request<StudioPromptsState>("/api/studio/prompts/reset", {
        method: "POST",
        body: stage ? { stage } : { all: true },
      }).then(normalizePromptsState);
    },
    getSettings(): Promise<StudioSettingsState> {
      return request<StudioSettingsState>("/api/studio/settings");
    },
    putSettings(payload: {
      autoRetry?: Partial<import("./retry").AutoRetrySettings>;
      renderQuality?: RenderQuality;
      defaultRenderLane?: string;
      preserveCacheHashes?: boolean;
      revision?: number;
      expectedRevision?: number;
      [key: string]: unknown;
    }): Promise<StudioSettingsState> {
      return request<StudioSettingsState>("/api/studio/settings", {
        method: "PUT",
        body: payload,
      });
    },
    getStorage(): Promise<StudioStorageReport> {
      return request<StudioStorageReport>("/api/studio/storage");
    },
    deleteStorageItem(payload: {
      slug?: string;
      chapter?: string;
      kind?: TrashKind | string;
      target?: string;
      targetPath?: string;
      path?: string;
      label?: string;
      confirm?: string;
    }): Promise<{ ok: boolean; item?: TrashItem; trashId?: string; freedBytes?: number; message?: string }> {
      return request("/api/studio/storage/delete", {
        method: "POST",
        body: {
          ...payload,
          targetPath: payload.targetPath || payload.path || payload.target,
          path: payload.path || payload.target,
          target: payload.target,
          kind: payload.kind,
          slug: payload.slug,
          chapter: payload.chapter,
        },
      });
    },
    getTrash(): Promise<{ items?: TrashItem[]; trash?: TrashItem[]; totalBytes?: number; trashBytes?: number }> {
      return request("/api/studio/storage/trash");
    },
    restoreTrash(trashId: string): Promise<{ ok: boolean; restoredPath?: string; item?: TrashItem; message?: string }> {
      return request("/api/studio/storage/restore", {
        method: "POST",
        body: { trashId, id: trashId },
      });
    },
    purgeTrash(trashId?: string): Promise<{ ok: boolean; purgedCount?: number; freedBytes?: number; message?: string }> {
      return request("/api/studio/storage/purge", {
        method: "POST",
        body: trashId ? { trashId, id: trashId } : { all: true },
      });
    },
    audit(): Promise<{ entries: AuditEntry[] }> {
      return request("/api/studio/audit");
    },
    elevenlabs: {
      keys(signal?: AbortSignal): Promise<ElevenLabsKeysState> {
        return request<ElevenLabsKeysState>("/api/studio/elevenlabs/keys", { signal, timeoutMs: 20000 });
      },
      addKey(input: { key: string; label?: string }): Promise<{ key: ElevenLabsKeySummary }> {
        return request("/api/studio/elevenlabs/keys", { method: "POST", body: input, timeoutMs: 45000 });
      },
      updateKey(id: string, patch: { label?: string; enabled?: boolean; allowOverage?: boolean }): Promise<{ key: ElevenLabsKeySummary }> {
        return request(`/api/studio/elevenlabs/keys/${enc(id)}`, { method: "PATCH", body: patch });
      },
      removeKey(id: string): Promise<{ ok: boolean }> {
        return request(`/api/studio/elevenlabs/keys/${enc(id)}`, { method: "DELETE", body: {} });
      },
      refreshKey(id: string): Promise<{ key: ElevenLabsKeySummary }> {
        return request(`/api/studio/elevenlabs/keys/${enc(id)}/refresh`, { method: "POST", body: {}, timeoutMs: 45000 });
      },
      reorder(ids: string[]): Promise<{ keys: ElevenLabsKeySummary[] }> {
        return request("/api/studio/elevenlabs/keys/order", { method: "PUT", body: { ids } });
      },
      voices(): Promise<{ voices: Array<{ voiceId: string; name: string; category?: string }> }> {
        return request("/api/studio/elevenlabs/voices", { timeoutMs: 30000 });
      },
      voiceCheck(voiceId: string, signal?: AbortSignal): Promise<ElevenLabsVoiceCheck> {
        return request<ElevenLabsVoiceCheck>("/api/studio/elevenlabs/voice-check", {
          query: { voiceId },
          signal,
          timeoutMs: 30000,
        });
      },
    },
  },

  setup: {
    state(): Promise<SetupState> {
      return request<SetupState>("/api/setup/state", { csrf: "none", redirectOn401: false });
    },
    createAdmin(input: { setupToken: string; username: string; password: string }): Promise<SetupAdminResult> {
      return request<SetupAdminResult>("/api/setup/admin", {
        method: "POST",
        csrf: "none",
        redirectOn401: false,
        body: input,
      });
    },
    complete(): Promise<{ ok: boolean; needsSetup: boolean }> {
      return request("/api/setup/complete", { method: "POST", body: {} });
    },
  },

  agy(fresh = false): Promise<AgyOverview> {
    return request<AgyOverview>("/api/agy", { query: fresh ? { fresh: 1 } : undefined, timeoutMs: fresh ? 60000 : 15000 });
  },
};
