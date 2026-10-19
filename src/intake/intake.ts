/**
 * intake.ts - New Series intake, validation, preflight, and persistent serialized queue.
 *
 * TypeScript port of manhwa-pipeline/pipeline/intake.py. The player calls these
 * functions in-process (no Python subprocess). Google Drive downloads still enforce
 * HTTPS, host allowlists, and public-IP checks before any byte is read.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pyReprStr } from "../contracts/hashes.js";
import { getStudioSettings } from "../config/studioConfig.js";
import { resolveOutDir } from "../config/secretStore.js";
import {
  VERTEX_TTS_VOICES,
  discoverVertexTtsVoices,
  hasVertexTtsCredentials,
  listVertexTtsVoices,
  readCachedVertexTtsVoices,
} from "../llm/vertexTts.js";
import {
  discoverGrokTtsVoices,
  hasGrokTtsCredentials,
  listGrokTtsVoices,
  readCachedGrokTtsVoices,
} from "../llm/grokTts.js";
import { getRegisteredNodes } from "../workers/nodeRegistry.js";
import {
  BACKGROUNDS,
  DEFAULT_BACKGROUND,
  DEFAULT_MOTION,
  MAX_NESTED_ARCHIVES,
  MAX_TOTAL_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_BYTES,
  MOTIONS,
  SystemExit,
  ZipValidationError,
  archiveIndex,
  comicTitle,
  ingest,
  parseChapterSpec,
} from "./ingest.js";
import {
  RENDER_LANE_ENV,
  OVERRIDE_INHERIT,
  OVERRIDE_MODES,
  RenderOverrideError,
  checkRenderLaneAvailable,
  normalizeRenderLane,
  renderOverrideOptions,
} from "../config/renderPolicy.js";
import type { Env as LaneEnv } from "../config/laneConfig.js";
import {
  flockFd,
  tryFlockFd,
  withExclusiveSeriesLock,
} from "../locks/seriesLock.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, "../..");

/** Linux O_CLOEXEC. Absent from fs.constants on some Node builds. */
const O_CLOEXEC = 0o2000000;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export type Env = LaneEnv;

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CHAPTER_SPEC_RE = /^(?:all|\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)$/i;
export const GDRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{10,120}$/;
export const JOB_ID_RE = /^job-[0-9]+-[a-f0-9]+$/;
export const CHAPTER_DIR_RE = /^ch(\d+)$/;

export const ALLOWED_GDRIVE_INITIAL_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
]);
export const ALLOWED_DOWNLOAD_EXACT_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
]);
export const ALLOWED_DOWNLOAD_SUFFIX_HOSTS = [
  ".googleusercontent.com",
  ".drive.google.com",
] as const;

export const MAX_REDIRECTS = 6;
export const DOWNLOAD_TIMEOUT_S = intEnv("MANHWA_DOWNLOAD_TIMEOUT_S", 60);
export const MAX_DOWNLOAD_WALL_S = intEnv("MANHWA_MAX_DOWNLOAD_WALL_S", 900);
export const MAX_LOG_BYTES = 262_144;
export const MAX_LOG_TAIL_LINES = 80;

export const ACTIVE_JOB_STATES = ["queued", "paused", "downloading", "ingesting", "running"] as const;
export const RECOVERABLE_JOB_STATES = ["failed", "interrupted"] as const;
export const CONTINUABLE_JOB_STATES = ["completed", "failed", "interrupted"] as const;

export const RENDER_QUALITIES = ["1080p", "720p"] as const;
export type RenderQuality = (typeof RENDER_QUALITIES)[number];
export const DEFAULT_RENDER_QUALITY: RenderQuality = "1080p";

/** Source labels an existing-series extension job may keep from its request. */
export const EXTENSION_SOURCE_TYPES = ["existing", "gdrive", "upload", "local_zip"] as const;

/** Normalize a requested render quality; null means "not one of the allowed values". */
export function normalizeRenderQuality(raw: unknown): RenderQuality | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return DEFAULT_RENDER_QUALITY;
  if (value === "1080p" || value === "1080") return "1080p";
  if (value === "720p" || value === "720") return "720p";
  return null;
}

/** Global Studio render quality; the fallback for jobs that never chose one. */
function studioRenderQuality(env?: Env): RenderQuality {
  try {
    return getStudioSettings(resolveOutDir(env?.MANHWA_OUT_DIR)).renderQuality;
  } catch {
    return DEFAULT_RENDER_QUALITY;
  }
}

export const STAGE_BY_STATUS: Record<string, string> = {
  queued: "queued",
  paused: "paused",
  downloading: "download",
  ingesting: "extract",
  running: "pipeline",
  completed: "done",
  failed: "stopped",
  interrupted: "stopped",
};
export const PUBLIC_STAGES = ["queued", "paused", "download", "extract", "pipeline", "done", "stopped"] as const;

export const DEFAULT_ORPHAN_MIN_AGE_S = 3600;
export const DEFAULT_EXTERNAL_CATALOG_PATH = path.join(REPO_ROOT, "out", "config", "tts-providers.json");
export const META_LOCK_FILENAME = "meta.lock";

export const BUILTIN_EDGE_PROVIDER = {
  id: "edge",
  label: "Edge TTS (Free, Default)",
  engine: "edge",
  provider: "edge-tts",
  revision: "1",
  costNotice:
    "Free narration (Edge TTS Andrew Multilingual); pipeline still consumes LLM vision and writer quota.",
  voices: [
    {
      id: "en-US-AndrewMultilingualNeural",
      label: "Andrew Multilingual (en-US, Default)",
      default: true,
    },
  ],
} as const;

/** Google Vertex AI TTS: Chirp 3 HD + Gemini 3.8 Flash TTS voices. */
export const BUILTIN_VERTEX_PROVIDER = {
  id: "vertex",
  label: "Google Vertex AI TTS (Chirp 3 HD & Gemini 3.8)",
  engine: "vertex",
  provider: "vertex-ai",
  revision: "1",
  costNotice:
    "Paid Google Cloud Vertex AI text-to-speech (Chirp 3 HD / Gemini 3.8 Flash TTS) plus LLM vision and writer quota.",
  voices: VERTEX_TTS_VOICES.map((v) => ({
    id: v.id,
    label: v.label,
    default: Boolean(v.default),
  })),
} as const;

const RESERVED_SLUGS = new Set([
  "out",
  "thumbs",
  "thumbnails",
  "downloads",
  "new-series",
  "status",
  "login",
]);

const SECRET_PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
  /\bxai-[A-Za-z0-9_\-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_\-]{12,}\b/gi,
  /((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)\S+/gi,
  /("(?:access|refresh|api_key|token|authorization|secret|password)"\s*:\s*)"[^"]*"/gi,
];

const PRESERVE_CALLER_KEYS = new Set([
  "MANHWA_SERIES_ROOT",
  "MANHWA_DOWNLOADS",
  "MANHWA_STUDIO",
  "PIPELINE_LOG",
]);

export class IntakeError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "IntakeError";
    this.statusCode = statusCode;
  }

  get status_code(): number {
    return this.statusCode;
  }
}

export class ConflictError extends IntakeError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

/** Environment or TTS adapter preflight failure (HTTP 422). */
export class PreflightError extends IntakeError {
  constructor(message: string) {
    super(message, 422);
    this.name = "PreflightError";
  }
}

/** Alias required by the v2 intake contract. Same class as PreflightError. */
export { PreflightError as UnprocessableError };

export class MetaLockUnavailableError extends IntakeError {
  constructor(message: string) {
    super(message, 503);
    this.name = "MetaLockUnavailableError";
  }
}

export type JobRecord = Record<string, any>;

export interface TtsVoice {
  id: string;
  label: string;
  default: boolean;
}

export interface RawTtsProvider {
  id: string;
  label: string;
  engine: string;
  provider: string;
  revision: string;
  costNotice: string;
  voices: TtsVoice[];
  command?: string | string[];
  language?: string;
  speed?: number;
  style?: string;
  settings?: Record<string, unknown>;
  preflightArgs?: string[];
}

export interface TtsSelection {
  providerId: string;
  providerLabel: string;
  engine: string;
  voiceId: string;
  voiceLabel: string;
  costNotice: string;
  metaTts: Record<string, unknown>;
}

export interface PublicCatalog {
  schemaVersion: number;
  defaultProvider: string;
  capabilities: Record<string, unknown>;
  providers: Array<Record<string, unknown>>;
  renderLanes: unknown;
  backgrounds: readonly string[];
  defaultBackground: string;
  motions: readonly string[];
  defaultMotion: string;
  limits: Record<string, number>;
  spendingNotice: string;
}

export type HostResolver = (
  hostname: string,
  port?: number,
  type?: number,
) => unknown;

export interface DownloadOptions {
  maxZipBytes?: number;
  timeoutS?: number;
  maxWallS?: number;
  resolver?: HostResolver;
  fetchImpl?: typeof fetch;
  progressCb?: (loadedBytes: number) => void;
}

export interface DownloadResult {
  bytes: number;
  path: string;
  totalBytes: number | null;
}

export interface EnqueueOptions {
  title?: string | null;
  slug?: string | null;
  sourceType?: string | null;
  source_type?: string | null;
  gdriveUrl?: string | null;
  gdrive_url?: string | null;
  zipPath?: string | null;
  zip_path?: string | null;
  uploadFilename?: string | null;
  upload_filename?: string | null;
  provider?: string | null;
  voice?: string | null;
  chapters?: string | null;
  background?: string | null;
  motion?: string | null;
  renderLane?: string | null;
  render_lane?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
  spawnWorker?: boolean;
  spawn_worker?: boolean;
  repoRoot?: string;
  repo_root?: string;
  env?: Env;
  renderQuality?: RenderQuality | string | null;
  render_quality?: RenderQuality | string | null;
  /** Extension jobs: false re-queues chapters that already have a rendered video. */
  preserveCompleted?: boolean;
  outroConfig?: { enabled?: boolean; totalChapters?: number; coveredChapters?: number; hookType?: "part2" | "next_chapter" | "new_series" | "custom"; customNote?: string; customPrompt?: string; nextSeriesTitle?: string; provider?: string; voice?: string };
}

export interface WorkerOptions {
  once?: boolean;
  repoRoot?: string;
  env?: Env;
  downloadFn?: (
    fileId: string,
    destPath: string,
    opts?: DownloadOptions,
  ) => Promise<DownloadResult>;
  runCmdOverride?: string[] | null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function resolveEnv(env?: Env): Env {
  return env ?? process.env;
}

export function sanitizeText(text: unknown): string {
  let s = text == null ? "" : String(text);
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

export function sanitizeLine(text: unknown, limit = 400): string {
  return sanitizeText(text).split(/\s+/).filter((part) => part.length > 0).join(" ").slice(0, limit);
}

export function seriesRoot(env?: Env): string {
  const e = resolveEnv(env);
  return e.MANHWA_SERIES_ROOT || path.join(REPO_ROOT, "series");
}

export function jobsDir(env?: Env): string {
  const e = resolveEnv(env);
  if (e.MANHWA_JOBS_DIR) return e.MANHWA_JOBS_DIR;
  // I-21: one native default. server.ts, statusProbe.ts, telemetry.ts and laneConfig.ts
  // all default to <repo>/out/pipeline.log, so jobs live in <repo>/out/jobs.
  const logPath = e.PIPELINE_LOG || path.join(REPO_ROOT, "out", "pipeline.log");
  return path.join(path.dirname(logPath), "jobs");
}

function euidIsRoot(): boolean {
  return typeof process.getuid === "function" && process.geteuid?.() === 0;
}

export function matchOwner(target: string, refPath?: string | null): void {
  if (!euidIsRoot()) return;
  try {
    let ref = refPath ? path.resolve(refPath) : seriesRoot();
    while (!lexists(ref)) {
      const parent = path.dirname(ref);
      if (parent === ref) break;
      ref = parent;
    }
    const st = fs.statSync(ref);
    if (st.uid !== 0) fs.chownSync(target, st.uid, st.gid);
  } catch {
    // ownership match is best-effort
  }
}

export function ensureDir(dir: string, refPath?: string | null): string {
  const existed = isDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (!existed || refPath != null) {
    matchOwner(dir, refPath != null ? refPath : path.dirname(dir));
  }
  return dir;
}

export function atomicWriteJson(filePath: string, data: unknown, refPath?: string | null): void {
  const parent = path.dirname(filePath);
  ensureDir(parent, refPath);
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    matchOwner(tmp, refPath);
    fs.renameSync(tmp, filePath);
    matchOwner(filePath, refPath);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // temp already renamed
    }
  }
}

/** Merge an extension job's visuals into the series `meta.json` before the pipeline runs. */
function mergeSeriesMetaVisuals(sdir: string, visuals: { background?: string; motion?: string }): void {
  const metaPath = path.join(sdir, "meta.json");
  let meta: Record<string, any> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
  } catch {
    meta = {};
  }
  const current = meta.visuals && typeof meta.visuals === "object" && !Array.isArray(meta.visuals)
    ? { ...(meta.visuals as Record<string, unknown>) }
    : {};
  if (visuals.background) {
    current.background = visuals.background;
    meta.background = visuals.background;
  }
  if (visuals.motion) {
    current.motion = visuals.motion;
    meta.motion = visuals.motion;
  }
  meta.visuals = current;
  atomicWriteJson(metaPath, meta, sdir);
}

/**
 * Merge an extension job's TTS selection into the series `meta.json`.
 * `meta.tts` is what the audio stage reads, so a newly selected voice/provider
 * must land there before the extended chapters are rendered.
 * Returns true when the file changed.
 */
export function mergeSeriesMetaTts(sdir: string, tts: Record<string, unknown>): boolean {
  const metaPath = path.join(sdir, "meta.json");
  let meta: Record<string, any> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
  } catch {
    meta = {};
  }
  const previous = meta.tts && typeof meta.tts === "object" && !Array.isArray(meta.tts)
    ? { ...(meta.tts as Record<string, unknown>) }
    : {};
  const next: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(tts)) {
    if (value !== null && value !== undefined && value !== "") next[key] = value;
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return false;
  atomicWriteJson(metaPath, { ...meta, tts: next }, sdir);
  return true;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function orphanMinAgeS(env?: Env): number {
  const e = resolveEnv(env);
  const raw = e.MANHWA_ORPHAN_MIN_AGE_S ?? String(DEFAULT_ORPHAN_MIN_AGE_S);
  const val = Number(raw);
  if (!Number.isFinite(val)) return DEFAULT_ORPHAN_MIN_AGE_S;
  return Math.max(0, val);
}

function metaLockHoldS(env?: Env): number {
  const e = resolveEnv(env);
  const raw = e.MANHWA_INTAKE_META_LOCK_HOLD_S ?? "0";
  const val = Number(raw || 0);
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, val);
}

function metaLockUnavailable(lockPath: string, reason: string, label = META_LOCK_FILENAME): MetaLockUnavailableError {
  return new MetaLockUnavailableError(
    `Job metadata lock is unavailable (${label}): ` +
      `${sanitizeLine(lockPath)} (${sanitizeLine(reason, 120)}). ` +
      "Refusing to change job metadata while it cannot be serialized. " +
      "Check that the jobs directory is writable and that the lock file is a regular file.",
  );
}

function isRegMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFREG;
}

function verifyLockFd(fd: number, lockPath: string, label = META_LOCK_FILENAME): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.fstatSync(fd);
  } catch (err) {
    const name = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw metaLockUnavailable(lockPath, `lock fd is not valid (${name})`, label);
  }
  if (!st.isFile() && !isRegMode(st.mode)) {
    throw metaLockUnavailable(lockPath, "not a regular file", label);
  }
  if (!st.isFile()) throw metaLockUnavailable(lockPath, "not a regular file", label);
  let pathSt: fs.Stats;
  try {
    pathSt = fs.lstatSync(lockPath);
  } catch (err) {
    const name = (err as NodeJS.ErrnoException).code || (err as Error).name;
    throw metaLockUnavailable(lockPath, `lock path is not stable (${name})`, label);
  }
  if (pathSt.isSymbolicLink()) throw metaLockUnavailable(lockPath, "lock path is a symbolic link", label);
  if (!pathSt.isFile()) throw metaLockUnavailable(lockPath, "not a regular file", label);
  if (pathSt.dev !== st.dev || pathSt.ino !== st.ino) {
    throw metaLockUnavailable(lockPath, "lock path changed while opening", label);
  }
  return st;
}

function matchLockFdOwner(fd: number, lockPath: string, st?: fs.Stats): void {
  if (!euidIsRoot()) return;
  try {
    const cur = st ?? fs.fstatSync(fd);
    if (!cur.isFile()) return;
    const parentSt = fs.statSync(path.dirname(lockPath));
    if ((parentSt.uid !== 0 || parentSt.gid !== 0) && (cur.uid !== parentSt.uid || cur.gid !== parentSt.gid)) {
      fs.fchownSync(fd, parentSt.uid, parentSt.gid);
    }
  } catch {
    // best-effort
  }
}

function openLockFd(lockPath: string, label = META_LOCK_FILENAME): number {
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | O_CLOEXEC;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, flags, 0o664);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw metaLockUnavailable(lockPath, `${e.code || e.name}: ${e.message}`, label);
  }
  try {
    const st = verifyLockFd(fd, lockPath, label);
    matchLockFdOwner(fd, lockPath, st);
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

function acquireLockFd(lockPath: string, label = META_LOCK_FILENAME): number {
  const fd = openLockFd(lockPath, label);
  let locked = false;
  try {
    try {
      flockFd(fd, "ex", false);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw metaLockUnavailable(
        lockPath,
        `flock failed (${e.code || e.name}: ${e.message})`,
        label,
      );
    }
    locked = true;
    const st = verifyLockFd(fd, lockPath, label);
    matchLockFdOwner(fd, lockPath, st);
    return fd;
  } catch (err) {
    if (locked) {
      try {
        flockFd(fd, "un");
      } catch {
        // fd close still drops the lock
      }
    }
    try {
      fs.closeSync(fd);
    } catch {
      // already failing closed
    }
    throw err;
  }
}

function releaseLockFd(fd: number): void {
  try {
    flockFd(fd, "un");
  } catch {
    // close drops it
  }
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

interface MetaHold {
  depth: number;
  pid: number;
}

const metaHeld = new Map<string, MetaHold>();
const metaStack: string[] = [];

function popMetaStack(key: string): void {
  for (let i = metaStack.length - 1; i >= 0; i--) {
    if (metaStack[i] === key) {
      metaStack.splice(i, 1);
      return;
    }
  }
}

function scrubForeignHolds(curPid: number): void {
  for (const [key, hold] of metaHeld) {
    if (hold.pid !== curPid) metaHeld.delete(key);
  }
  for (let i = metaStack.length - 1; i >= 0; i--) {
    const pid = Number(metaStack[i]!.slice(metaStack[i]!.lastIndexOf(":") + 1));
    if (pid !== curPid) metaStack.splice(i, 1);
  }
}

/**
 * Serialize short job-metadata mutations. Re-entrant per (jobs dir, pid).
 * Fail closed: the callback never runs if the lock cannot be taken.
 */
export function withJobMetaLock<T>(env: Env | undefined, fn: () => T): T {
  let jdir: string;
  let lockPath: string;
  let key: string;
  const curPid = process.pid;
  try {
    jdir = ensureDir(jobsDir(env));
    lockPath = path.join(jdir, META_LOCK_FILENAME);
    key = `${fs.realpathSync(jdir)}:${curPid}`;
  } catch (err) {
    if (err instanceof MetaLockUnavailableError) throw err;
    const e = err as NodeJS.ErrnoException;
    throw new MetaLockUnavailableError(
      "Job metadata lock is unavailable: " +
        `jobs directory ${sanitizeLine(jobsDir(env))} ` +
        `(${sanitizeLine(e.code || e.name, 60)}). ` +
        "Refusing to change job metadata while it cannot be serialized.",
    );
  }

  scrubForeignHolds(curPid);
  const existing = metaHeld.get(key);
  if (existing && existing.depth > 0 && existing.pid === curPid) {
    existing.depth += 1;
    metaStack.push(key);
    try {
      return fn();
    } finally {
      popMetaStack(key);
      if (existing.depth <= 1) metaHeld.delete(key);
      else existing.depth -= 1;
    }
  }

  const fd = acquireLockFd(lockPath, META_LOCK_FILENAME);
  metaHeld.set(key, { depth: 1, pid: curPid });
  metaStack.push(key);
  try {
    const hold = metaLockHoldS(env);
    if (hold > 0) sleepSync(hold * 1000);
    return fn();
  } finally {
    popMetaStack(key);
    metaHeld.delete(key);
    releaseLockFd(fd);
  }
}

export function slugify(text: unknown): string {
  let s = String(text || "").trim().toLowerCase();
  s = s.replace(/\.(?:zip|cbz)$/i, "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 64).replace(/^-+|-+$/g, "");
}

export function validateSlug(slug: unknown): string {
  if (typeof slug !== "string") throw new IntakeError("Series slug is required");
  const s = slug.trim();
  if (s.length < 2 || s.length > 64) {
    throw new IntakeError("Series slug must be between 2 and 64 characters (a-z, 0-9, hyphens)");
  }
  if (!SLUG_RE.test(s)) {
    throw new IntakeError(
      `Invalid series slug ${pyReprStr(s)}: use lowercase letters, numbers, and hyphens only ` +
        "(cannot start or end with a hyphen or contain path characters)",
    );
  }
  if (RESERVED_SLUGS.has(s)) throw new IntakeError(`Series slug ${pyReprStr(s)} is reserved`);
  return s;
}

export function validateChaptersSpec(spec: unknown): string {
  let s = String(spec ?? "all").trim().toLowerCase();
  if (!s) s = "all";
  if (!CHAPTER_SPEC_RE.test(s)) {
    throw new IntakeError(
      `Invalid chapters specification ${pyReprStr(String(spec))}: expected 'all', '1-5', or '1,2,3'`,
    );
  }
  if (s === "all") return "all";
  const parts: string[] = [];
  for (const raw of s.split(",")) {
    const p = raw.trim();
    if (p.includes("-")) {
      const dash = p.indexOf("-");
      const ia = Number(p.slice(0, dash));
      const ib = Number(p.slice(dash + 1));
      if (!Number.isInteger(ia) || !Number.isInteger(ib) || ia <= 0 || ib <= 0 || ia > ib || ib - ia > 500) {
        throw new IntakeError(`Invalid chapter range ${pyReprStr(p)}`);
      }
      parts.push(`${ia}-${ib}`);
    } else {
      const iv = Number(p);
      if (!Number.isInteger(iv) || iv <= 0 || iv > 5000) {
        throw new IntakeError(`Invalid chapter number ${pyReprStr(p)}`);
      }
      parts.push(String(iv));
    }
  }
  return parts.join(",");
}

export function existingChapterNumbers(sdir: string): number[] {
  const nums = new Set<number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sdir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const m = CHAPTER_DIR_RE.exec(entry.name);
    if (m && entry.isDirectory()) nums.add(Number(m[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

function loadJobFile(filePath: string): JobRecord | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as JobRecord;
    if (data && typeof data === "object" && data.schemaVersion === 1 && data.id) return data;
  } catch {
    // unreadable snapshot
  }
  return null;
}

/**
 * A job JSON that cannot be parsed must never vanish from the queue: surface a
 * synthetic `failed` record so the operator can retry or delete it.
 */
function corruptJobRecord(filePath: string): JobRecord | null {
  if (!fs.existsSync(filePath)) return null;
  const base = path.basename(filePath).replace(/\.json$/, "");
  if (!JOB_ID_RE.test(base)) return null;
  let detail = "unreadable JSON";
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    detail = "unexpected schema (missing schemaVersion/id)";
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  const now = Date.now() / 1000;
  return {
    schemaVersion: 1,
    id: base,
    slug: "",
    title: `Corrupt job file ${base}`,
    status: "failed",
    statusNote: "Job file is corrupt; retry or delete it.",
    sourceType: "unknown",
    sourceSummary: "Corrupt job file",
    gdriveFileId: null,
    stagedZipPath: null,
    chapters: "all",
    runChapters: [],
    ingestedChapters: [],
    skipIngest: false,
    allowExistingSeries: false,
    tts: {},
    visuals: {},
    renderLane: "inherit",
    createdBy: "reconcile",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: now,
    workerPid: null,
    workerStartTicks: null,
    runPid: null,
    runStartTicks: null,
    error: `Corrupt job file ${base}.json: ${detail}`,
    logTail: [`RECONCILE: corrupt job file ${base}.json (${detail})`],
    corrupt: true,
  };
}

function loadJob(jobId: unknown, env?: Env): JobRecord {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) throw new IntakeError("Invalid job ID");
  const filePath = path.join(jobsDir(env), `${jobId}.json`);
  const job = loadJobFile(filePath);
  if (!job) {
    // A file that exists but cannot be read is corrupt, not missing: a 404 would
    // tell the operator to look for a job that is still on disk.
    if (isFile(filePath)) {
      throw new IntakeError(`Job file is corrupted and cannot be read: ${jobId}`);
    }
    throw new IntakeError(`Job not found: ${jobId}`);
  }
  return job;
}

function activeConflictFor(slug: string, excludeId: string | null, env?: Env): JobRecord | null {
  const jdir = jobsDir(env);
  if (!isDir(jdir)) return null;
  for (const name of fs.readdirSync(jdir)) {
    if (!name.endsWith(".json")) continue;
    const other = loadJobFile(path.join(jdir, name));
    if (!other || other.slug !== slug || other.id === excludeId) continue;
    if ((ACTIVE_JOB_STATES as readonly string[]).includes(other.status) || isPidAlive(other.runPid, other.runStartTicks)) return other;
  }
  return null;
}

function resetJobForRerun(job: JobRecord, note: string): JobRecord {
  const now = Date.now() / 1000;
  job.status = "queued";
  job.statusNote = note;
  job.error = null;
  job.endedAt = null;
  job.startedAt = null;
  job.workerPid = null;
  job.workerStartTicks = null;
  job.runPid = null;
  job.runStartTicks = null;
  job.progress = null;
  job.paused = false;
  job.stopRequested = false;
  job.updatedAt = now;
  return job;
}

export function publicCapabilities(env?: Env): Record<string, unknown> {
  void env;
  return {
    schemaVersion: 1,
    jobActions: {
      pause: { endpoint: "POST /api/intake/jobs/:id/pause", allowedStates: ["queued", "running"] },
      resume: { endpoint: "POST /api/intake/jobs/:id/resume", allowedStates: ["paused", "running"], description: "Resume a paused job." },
      stop: { endpoint: "POST /api/intake/jobs/:id/stop", allowedStates: ["queued", "paused", "running"] },
      retry: {
        endpoint: "POST /api/intake/jobs/:id/retry",
        body: {},
        allowedStates: [...RECOVERABLE_JOB_STATES],
        description: "Re-queue a failed or interrupted job and resume the work already on disk.",
      },
      continue: {
        endpoint: "POST /api/intake/jobs/:id/continue",
        body: { chapters: "2-5 or all" },
        allowedStates: [...CONTINUABLE_JOB_STATES],
        description:
          "Add later chapters to the existing series without creating a new series or re-importing pages.",
      },
    },
    activeStates: [...ACTIVE_JOB_STATES],
    recoverableStates: [...RECOVERABLE_JOB_STATES],
    continuableStates: [...CONTINUABLE_JOB_STATES],
    chapterSpec: {
      pattern: "all|1-5|1,2,3",
      examples: ["2-5", "all"],
      maxChapter: 5000,
      maxRange: 500,
    },
    renderLane: {
      field: "renderLane",
      values: [...OVERRIDE_MODES],
      default: OVERRIDE_INHERIT,
      preservedAcrossRetryAndContinue: true,
      description:
        "Optional per-job render lane pin. 'inherit' follows the global render " +
        "policy. A pinned lane must be configured on this server and enabled by " +
        "the global policy; it never falls back to another lane.",
    },
    progress: {
      stages: [...PUBLIC_STAGES],
      bytes: true,
      chapterCounts: true,
    },
  };
}

/** Put the repo venv(s) on PATH so `edge-tts`/`python` resolve without env.sh. */
function prependVenvBins(root: string, env: Env): Env {
  const venvBins = [
    path.join(root, ".venv", "bin"),
    path.resolve(root, "..", "manhwa-pipeline", ".venv", "bin"),
  ];
  const parts = (env.PATH || "").split(":").filter((p) => p);
  const missing = venvBins.filter((dir) => isDir(dir) && !parts.includes(dir));
  if (missing.length) env.PATH = `${missing.join(":")}:${env.PATH || "/usr/bin:/bin"}`;
  return env;
}

export function buildPipelineEnv(repoRoot = REPO_ROOT, baseEnv?: Env): Env {
  const root = path.resolve(repoRoot);
  const envFile = path.join(root, "env.sh");
  if (!isFile(envFile)) {
    throw new PreflightError(`Pipeline environment file missing: ${envFile}`);
  }
  const callerEnv: Env = { ...(baseEnv ?? process.env) };
  const env: Env = { ...callerEnv };
  const pwd = root;
  const rawLines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of rawLines) {
    let stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("export ")) stripped = stripped.slice("export ".length).trim();
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[0] === val[val.length - 1]) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)-([^}]*)\}/g, (_m, name: string, def: string) => {
      const cur = env[name];
      return cur == null ? def : cur;
    });
    val = val.replaceAll("$PWD", pwd).replaceAll("${PWD}", pwd);
    if (key === "PATH") {
      const curPath = env.PATH || "/usr/bin:/bin";
      val = val.replaceAll("$PATH", curPath).replaceAll("${PATH}", curPath);
      env.PATH = val;
    } else if (PRESERVE_CALLER_KEYS.has(key)) {
      if (!callerEnv[key]) env[key] = val;
    } else {
      env[key] = val;
    }
  }
  env.PYTHONDONTWRITEBYTECODE = "1";
  return prependVenvBins(root, env);
}
export function renderExecutionEnv(repoRoot = REPO_ROOT, env?: Env): Env {
  const base = resolveEnv(env);
  try {
    return buildPipelineEnv(repoRoot, base);
  } catch {
    return prependVenvBins(path.resolve(repoRoot), { ...base });
  }
}

export function resolveRenderLane(raw: unknown = null, env?: Env, repoRoot = REPO_ROOT): string {
  const laneEnv = renderExecutionEnv(repoRoot, env);
  try {
    const selector = normalizeRenderLane(raw);
    return checkRenderLaneAvailable(selector, laneEnv);
  } catch (err) {
    if (err instanceof RenderOverrideError) throw new IntakeError(sanitizeLine(err));
    throw err;
  }
}

export function renderLaneOptions(repoRoot = REPO_ROOT, env?: Env): unknown {
  return renderOverrideOptions(renderExecutionEnv(repoRoot, env));
}

export function renderLaneEnv(job: JobRecord | null | undefined, env?: Env): string {
  void env;
  try {
    return normalizeRenderLane(job?.renderLane);
  } catch (err) {
    if (err instanceof RenderOverrideError) return OVERRIDE_INHERIT;
    throw err;
  }
}

function renderLaneRecheck(job: JobRecord, env?: Env, repoRoot = REPO_ROOT): [boolean, string | null] {
  const selector = renderLaneEnv(job, env);
  if (selector === OVERRIDE_INHERIT) return [true, null];
  try {
    checkRenderLaneAvailable(selector, renderExecutionEnv(repoRoot, env));
    return [true, null];
  } catch (err) {
    if (err instanceof RenderOverrideError) return [false, sanitizeLine(err)];
    throw err;
  }
}

export function getProcStartTicks(pid: unknown): number | null {
  const n = Number(pid);
  if (!n || n <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (rest[0] === "Z") return null;
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: unknown, expectedTicks?: unknown): boolean {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  const ticks = getProcStartTicks(n);
  if (ticks == null) return false;
  if (expectedTicks != null && Number(expectedTicks) !== ticks) return false;
  return true;
}

export function detectActivePipelineRuns(repoRoot = REPO_ROOT): Array<Record<string, unknown>> {
  const active: Array<Record<string, unknown>> = [];
  const resolvedRoot = path.resolve(repoRoot);
  const runPy = path.resolve(resolvedRoot, "pipeline", "run.py");
  const renderPy = path.resolve(resolvedRoot, "pipeline", "renderlane.py");
  const runTs = path.resolve(resolvedRoot, "src", "cli", "run.ts");
  const candidates = new Set([
    "pipeline/run.py",
    "pipeline/renderlane.py",
    "run.py",
    runPy,
    renderPy,
    runTs,
    "src/cli/run.ts",
  ]);
  if (!isDir("/proc")) return active;
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return active;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const rawStat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = rawStat.slice(rawStat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields[0] === "Z") continue;
      const startTicks = Number(fields[19]);
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0$/, "");
      if (!cmdline) continue;
      const args = cmdline.split("\0");
      let procCwd: string | null | undefined;
      const getProcCwd = (): string | null => {
        if (procCwd === undefined) {
          try {
            procCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          } catch {
            procCwd = null;
          }
        }
        return procCwd;
      };
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        let matched = false;
        if (path.isAbsolute(arg)) {
          matched = candidates.has(path.resolve(arg));
        } else if (candidates.has(arg)) {
          const cwd = getProcCwd();
          matched = cwd != null && path.resolve(cwd) === resolvedRoot;
        }
        if (matched) {
          const rest = args.slice(i + 1);
          if (rest.length === 0 || rest.includes("--status") || rest.includes("--clear-cache")) break;
          const pos = rest.filter((a) => !a.startsWith("--"));
          active.push({
            pid,
            startTicks,
            series: pos[0] || "unknown",
            args: rest.slice(0, 8),
          });
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return active;
}

export function resolvePipelinePython(repoRoot = REPO_ROOT, env?: Env): string {
  const e = resolveEnv(env);
  if (e.MANHWA_PIPELINE_PYTHON) return e.MANHWA_PIPELINE_PYTHON;
  const venvPys = [
    path.join(repoRoot, ".venv", "bin", "python"),
    path.resolve(repoRoot, "..", "manhwa-pipeline", ".venv", "bin", "python"),
  ];
  for (const venvPy of venvPys) {
    if (fs.existsSync(venvPy)) return venvPy;
  }
  return "python3";
}

export interface PreflightInfo {
  python: string;
  env: Env;
  seriesRoot: string;
}

export function preflightPipelineEnv(repoRoot = REPO_ROOT, env?: Env): PreflightInfo {
  let pEnv: Env;
  try {
    pEnv = buildPipelineEnv(repoRoot, env);
  } catch (err) {
    if (err instanceof PreflightError && /environment file missing/i.test(err.message)) {
      pEnv = prependVenvBins(path.resolve(repoRoot), { ...(env ?? process.env) });
    } else {
      throw err;
    }
  }
  const runtime = process.execPath;
  if (!runtime || !isFile(runtime)) {
    throw new PreflightError(`Pipeline runtime is not executable: ${pyReprStr(runtime)}`);
  }
  const sRoot = seriesRoot(pEnv);
  if (lexists(sRoot) && !isDir(sRoot)) {
    throw new PreflightError(`MANHWA_SERIES_ROOT is not a directory: ${sRoot}`);
  }
  return { python: runtime, env: pEnv, seriesRoot: sRoot };
}

function which(exe: string, pathEnv?: string): string | null {
  if (path.isAbsolute(exe)) {
    try {
      const st = fs.statSync(exe);
      if (st.isFile() && (st.mode & 0o111)) return exe;
    } catch {
      return null;
    }
    return null;
  }
  for (const dir of (pathEnv || "").split(":")) {
    if (!dir) continue;
    const cand = path.join(dir, exe);
    try {
      const st = fs.statSync(cand);
      if (st.isFile() && (st.mode & 0o111)) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

export function shlexSplit(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  let token = false;
  for (const ch of raw) {
    if (escape) {
      cur += ch;
      escape = false;
      token = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      token = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      token = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      token = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (token) {
        out.push(cur);
        cur = "";
        token = false;
      }
      continue;
    }
    cur += ch;
    token = true;
  }
  if (token) out.push(cur);
  return out;
}

function titleCase(s: string): string {
  return s.replace(/(^|[\s_-]+)([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

/** Pick the external TTS catalog path, or `null` when none applies. */
function resolveExternalCatalogPath(e: Env): { path: string | null; explicit: boolean } {
  const explicit = String(e.MANHWA_TTS_CATALOG || "").trim();
  if (explicit) return { path: explicit, explicit: true };
  if (isFile(DEFAULT_EXTERNAL_CATALOG_PATH)) return { path: DEFAULT_EXTERNAL_CATALOG_PATH, explicit: false };
  return { path: null, explicit: false };
}

/** Built-in provider entry for a Studio-connected Grok / xAI TTS account. */
export const BUILTIN_GROK_PROVIDER = {
  id: "grok",
  label: "xAI Grok TTS (Studio subscription)",
  engine: "grok",
  provider: "grok-subscription-tts",
  revision: "1",
  costNotice:
    "Uses the connected xAI Grok subscription for narration plus LLM vision and writer quota.",
  voices: [] as Array<{ id: string; label: string; default: boolean }>,
} as const;

function grokCatalogProvider(e: Env): RawTtsProvider {
  const env = e as NodeJS.ProcessEnv;
  const voices = listGrokTtsVoices(env).map((v) => ({
    id: v.id,
    label: v.label,
    default: Boolean(v.default),
  }));
  if (voices.length > 0 && !voices.some((v) => v.default)) voices[0]!.default = true;
  return {
    ...structuredClone(BUILTIN_GROK_PROVIDER) as unknown as RawTtsProvider,
    voices,
  };
}

function vertexCatalogProvider(e: Env): RawTtsProvider {
  const env = e as NodeJS.ProcessEnv;
  const voices = listVertexTtsVoices(env).map((v) => ({
    id: v.id,
    label: v.label,
    default: Boolean(v.default),
  }));
  if (voices.length > 0 && !voices.some((v) => v.default)) voices[0]!.default = true;
  return {
    ...structuredClone(BUILTIN_VERTEX_PROVIDER) as unknown as RawTtsProvider,
    voices,
  };
}

export function loadRawTtsProviders(env?: Env): RawTtsProvider[] {
  const e = resolveEnv(env);
  const providers: RawTtsProvider[] = [structuredClone(BUILTIN_EDGE_PROVIDER) as unknown as RawTtsProvider];
  // Vertex AI TTS only appears when Studio has a usable vertex-ai provider, so a
  // stock install still offers Edge alone.
  if (hasVertexTtsCredentials(e as NodeJS.ProcessEnv).available) {
    providers.push(vertexCatalogProvider(e));
  }
  // Same rule for a connected Grok / xAI subscription.
  if (hasGrokTtsCredentials(e as NodeJS.ProcessEnv)) {
    providers.push(grokCatalogProvider(e));
  }
  const resolvedCatalog = resolveExternalCatalogPath(e);
  const catPathStr = resolvedCatalog.explicit ? resolvedCatalog.path : null;
  const catPath = resolvedCatalog.path;
  if (catPath && isFile(catPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(catPath, "utf8")) as unknown;
      const extList = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { providers?: unknown }).providers)
          ? (raw as { providers: unknown[] }).providers
          : [];
      for (const item of extList) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const pid = String(rec.id || "").trim().toLowerCase();
        const engine = String(rec.engine || "").trim().toLowerCase();
        if (!pid || pid === "edge" || pid === "eleven" || pid === "gsk" || engine !== "external") continue;
        const voices: TtsVoice[] = [];
        const voiceList = Array.isArray(rec.voices) ? rec.voices : [];
        for (const v of voiceList) {
          if (!v || typeof v !== "object") continue;
          const vr = v as Record<string, unknown>;
          const id = String(vr.id || "").trim();
          if (!id) continue;
          voices.push({
            id,
            label: String(vr.label || id).trim(),
            default: Boolean(vr.default),
          });
        }
        if (voices.length === 0) continue;
        if (!voices.some((v) => v.default)) voices[0]!.default = true;
        const speedRaw = rec.speed == null ? 1 : Number(rec.speed);
        providers.push({
          id: pid,
          label: String(rec.label || titleCase(pid)).trim(),
          engine: "external",
          provider: String(rec.provider || pid).trim(),
          revision: String(rec.revision || "1").trim(),
          command: Array.isArray(rec.command) ? rec.command.map((x) => String(x)) : String(rec.command || ""),
          language: String(rec.language || "en").trim(),
          speed: speedRaw,
          style: String(rec.style || "").trim(),
          settings: rec.settings && typeof rec.settings === "object" && !Array.isArray(rec.settings)
            ? (rec.settings as Record<string, unknown>)
            : {},
          preflightArgs: rec.preflightArgs == null
            ? ["--check-auth"]
            : Array.isArray(rec.preflightArgs)
              ? rec.preflightArgs.map((a) => String(a))
              : ["--check-auth"],
          costNotice: String(
            rec.costNotice ||
              `Uses external TTS provider (${rec.label || pid}) plus LLM vision and writer quota.`,
          ).trim(),
          voices,
        });
      }
    } catch (err) {
      if (catPathStr) {
        throw new PreflightError(
          `Failed to load MANHWA_TTS_CATALOG (${catPath}): ${sanitizeLine(err)}`,
        );
      }
    }
  }
  return providers;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCommand(
  cmd: string[],
  opts: { timeoutMs?: number; env?: Env; input?: string; cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      env: childEnv(opts.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errBuf.push(chunk));
    child.stdin?.end(opts.input ?? "");
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errBuf).toString("utf8"),
        timedOut,
      });
    });
  });
}

function childEnv(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function commandArgv(raw: unknown): string[] {
  if (typeof raw === "string") return shlexSplit(raw);
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter((x) => x);
  return [];
}

export async function preflightTtsProvider(
  providerEntry: RawTtsProvider,
  repoRoot = REPO_ROOT,
  env?: Env,
): Promise<[boolean, string | null]> {
  const pInfo = preflightPipelineEnv(repoRoot, env);
  const pEnv = pInfo.env;
  const engine = providerEntry.engine;
  const pid = providerEntry.id;
  if (engine === "edge") return [true, null];
  if (engine === "vertex") {
    const avail = hasVertexTtsCredentials(pEnv as NodeJS.ProcessEnv);
    return avail.available ? [true, null] : [false, avail.reason ?? "Vertex AI TTS credentials are not configured"];
  }
  if (engine === "grok") {
    return hasGrokTtsCredentials(pEnv as NodeJS.ProcessEnv)
      ? [true, null]
      : [false, "Grok TTS credentials are not configured (connect grok-subscription in Studio)"];
  }
  if (engine !== "external") return [false, `Unsupported TTS engine ${pyReprStr(engine)} for provider ${pyReprStr(pid)}`];
  const cmd = commandArgv(providerEntry.command);
  if (cmd.length === 0) return [false, `TTS provider ${pyReprStr(pid)} has an empty adapter command in server catalog`];
  const exe = cmd[0]!;
  const exeResolved = path.isAbsolute(exe) ? (isFile(exe) ? exe : null) : which(exe, pEnv.PATH);
  if (!exeResolved || !isFile(exeResolved)) {
    return [false, `TTS adapter executable not found or not executable: ${pyReprStr(exe)}`];
  }
  try {
    fs.accessSync(exeResolved, fs.constants.X_OK);
  } catch {
    return [false, `TTS adapter executable not found or not executable: ${pyReprStr(exe)}`];
  }
  if (cmd.length > 1) {
    const scriptCand = cmd[1]!;
    if (scriptCand.startsWith("/") || scriptCand.startsWith("./") || /\.(py|sh|js|mjs|cjs|ts)$/.test(scriptCand)) {
      if (!isFile(scriptCand)) return [false, `TTS adapter script not found: ${pyReprStr(scriptCand)}`];
      try {
        fs.accessSync(scriptCand, fs.constants.R_OK);
      } catch {
        return [false, `TTS adapter script is not readable: ${pyReprStr(scriptCand)}`];
      }
    }
  }
  const preflightArgs = providerEntry.preflightArgs == null ? ["--check-auth"] : providerEntry.preflightArgs;
  if (preflightArgs.length) {
    try {
      const r = await runCommand([exeResolved, ...cmd.slice(1), ...preflightArgs.map((a) => String(a))], {
        timeoutMs: 30_000,
        env: pEnv,
      });
      if (r.timedOut) return [false, "TTS adapter preflight timed out"];
      if (r.code !== 0) {
        const detail = sanitizeLine((r.stderr || r.stdout || "").trim(), 260);
        if (detail) return [false, `TTS adapter preflight failed (rc=${r.code}): ${detail}`];
        return [false, `TTS adapter preflight failed (rc=${r.code})`];
      }
    } catch (err) {
      return [false, `TTS adapter preflight failed: ${(err as Error).name || "Error"}`];
    }
  }
  return [true, null];
}

export async function getCatalog(repoRoot = REPO_ROOT, env?: Env): Promise<PublicCatalog> {
  const e = resolveEnv(env);
  const envRec = e as NodeJS.ProcessEnv;
  // Refresh the Studio-discovered voice lists when they are not cached yet. A
  // discovery failure (offline, missing scope) keeps the built-in catalog and
  // never fails the request.
  if (hasVertexTtsCredentials(envRec).available && readCachedVertexTtsVoices(envRec) === null) {
    try {
      await discoverVertexTtsVoices(envRec);
    } catch {
      // keep the static Chirp list
    }
  }
  if (hasGrokTtsCredentials(envRec) && readCachedGrokTtsVoices(envRec) === null) {
    try {
      await discoverGrokTtsVoices(envRec);
    } catch {
      // keep the fallback list
    }
  }
  const providers = loadRawTtsProviders(env);
  const publicProviders: Array<Record<string, unknown>> = [];
  for (const p of providers) {
    const [ok, reason] = await preflightTtsProvider(p, repoRoot, env);
    const defaultVoice = p.voices.find((v) => v.default)?.id ?? p.voices[0]!.id;
    publicProviders.push({
      id: p.id,
      label: p.label,
      engine: p.engine,
      defaultVoice,
      costNotice: p.costNotice,
      available: ok,
      unavailableReason: reason,
      voices: p.voices,
    });
  }
  return {
    schemaVersion: 1,
    defaultProvider: "edge",
    capabilities: publicCapabilities(env),
    providers: publicProviders,
    renderLanes: renderLaneOptions(repoRoot, env),
    backgrounds: [...BACKGROUNDS],
    defaultBackground: DEFAULT_BACKGROUND,
    motions: [...MOTIONS],
    defaultMotion: DEFAULT_MOTION,
    limits: {
      maxZipBytes: MAX_ZIP_BYTES,
      maxUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
      maxEntries: MAX_TOTAL_ENTRIES,
      maxNestedArchives: MAX_NESTED_ARCHIVES,
    },
    spendingNotice:
      "Starting a new series runs full ingestion, vision reading, script writing, " +
      "TTS voice synthesis, artwork cleaning, and video rendering across all selected " +
      "chapters. This consumes LLM/TTS quota and runs autonomously on the server.",
  };
}

/**
 * Catalog provider id for a series' persisted `meta.tts` block.
 * `meta.tts.provider` holds the engine provider (`vertex-ai`,
 * `grok-subscription-tts`, or the external provider id), not the catalog id.
 */
export function ttsProviderIdFromMeta(tts: Record<string, unknown>, env?: Env): string | null {
  const engine = String(tts.engine || "").trim().toLowerCase();
  if (!engine) return null;
  let providers: RawTtsProvider[] = [];
  try {
    providers = loadRawTtsProviders(env);
  } catch {
    return null;
  }
  const declared = String(tts.provider || "").trim().toLowerCase();
  if (declared) {
    const hit = providers.find(
      (p) => p.id.toLowerCase() === declared
        || String(p.provider || "").trim().toLowerCase() === declared,
    );
    if (hit) return hit.id;
  }
  // An external provider is identified only by its declared id.
  if (engine === "external") return null;
  return providers.find((p) => p.engine === engine)?.id ?? null;
}

export async function resolveTtsSelection(
  providerId?: string | null,
  voiceId?: string | null,
  repoRoot = REPO_ROOT,
  env?: Env,
  preflight = true,
): Promise<TtsSelection> {
  const providers = loadRawTtsProviders(env);
  let reqProv = String(providerId || "edge").trim().toLowerCase() || "edge";
  if (reqProv === "eleven" || reqProv === "elevenlabs" || reqProv === "gsk") {
    throw new IntakeError(
      "ElevenLabs / GSK TTS is not available. Select 'edge' (default) or a configured external provider such as 'grok'.",
    );
  }
  let matched = providers.find((p) => p.id === reqProv) ?? null;
  if (!matched && reqProv === "external") {
    const ext = providers.filter((p) => p.engine === "external");
    if (ext.length === 1) matched = ext[0]!;
  }
  if (!matched) {
    const avail = providers.map((p) => p.id).join(", ");
    throw new IntakeError(`Unknown TTS provider ${pyReprStr(reqProv)} (available: ${avail})`);
  }
  if (preflight) {
    const [ok, reason] = await preflightTtsProvider(matched, repoRoot, env);
    if (!ok) throw new PreflightError(`TTS provider ${pyReprStr(matched.id)} preflight failed: ${reason}`);
  }
  const voices = matched.voices;
  const reqVoice = String(voiceId || "").trim();
  let chosen = reqVoice
    ? voices.find((v) => v.id.toLowerCase() === reqVoice.toLowerCase()) ?? null
    : voices.find((v) => v.default) ?? voices[0]!;
  if (!chosen) {
    const valid = voices.map((v) => v.id).join(", ");
    throw new IntakeError(
      `Voice ${pyReprStr(reqVoice)} is not in server catalog for provider ${pyReprStr(matched.id)} ` +
        `(available voices: ${valid})`,
    );
  }
  let metaTts: Record<string, unknown>;
  if (matched.engine === "edge") {
    metaTts = { engine: "edge" };
  } else if (matched.engine === "vertex") {
    metaTts = {
      engine: "vertex",
      provider: matched.provider,
      revision: matched.revision,
      voice_id: chosen.id,
      language: matched.language || "en",
      speed: matched.speed ?? 1,
    };
  } else if (matched.engine === "grok") {
    metaTts = {
      engine: "grok",
      provider: matched.provider,
      revision: matched.revision,
      voice_id: chosen.id,
      language: matched.language || "en",
      speed: matched.speed ?? 1,
    };
  } else {
    const cmd = commandArgv(matched.command);
    metaTts = {
      engine: "external",
      provider: matched.provider,
      revision: matched.revision,
      command: cmd,
      voice_id: chosen.id,
      language: matched.language || "en",
      speed: matched.speed ?? 1,
    };
    if (matched.style) metaTts.style = matched.style;
    if (matched.settings && Object.keys(matched.settings).length) metaTts.settings = matched.settings;
  }
  return {
    providerId: matched.id,
    providerLabel: matched.label,
    engine: matched.engine,
    voiceId: chosen.id,
    voiceLabel: chosen.label,
    costNotice: matched.costNotice,
    metaTts,
  };
}

export function parseGdriveUrl(url: unknown): { fileId: string; canonicalUrl: string; downloadUrl: string } {
  if (typeof url !== "string" || !url.trim()) throw new IntakeError("Google Drive URL is required");
  const raw = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new IntakeError(`Malformed URL: ${sanitizeLine(err)}`);
  }
  if (parsed.protocol.toLowerCase() !== "https:") throw new IntakeError("Google Drive link must use https://");
  if (parsed.username || parsed.password) throw new IntakeError("URL must not contain embedded credentials");
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_GDRIVE_INITIAL_HOSTS.has(host)) {
    throw new IntakeError(
      "Only Google Drive file links (https://drive.google.com/file/d/<FILE_ID>/view) are supported",
    );
  }
  if (parsed.port && parsed.port !== "443") {
    throw new IntakeError("Non-standard port is not allowed in Google Drive URL");
  }
  const urlPath = parsed.pathname || "";
  if (/\/folders(?:\/|$)/i.test(urlPath) || urlPath.toLowerCase().includes("drive/folders")) {
    throw new IntakeError(
      "Google Drive folder links are not supported. Compress the chapters into a single .zip file " +
        "and share the file link (https://drive.google.com/file/d/<FILE_ID>/view).",
    );
  }
  if (/\/(?:document|spreadsheets|presentation|forms)(?:\/|$)/i.test(urlPath)) {
    throw new IntakeError(
      "Google Docs/Sheets/Slides links are not supported. Share a direct Google Drive .zip file link.",
    );
  }
  let fileId: string | null = null;
  const m = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(urlPath);
  if (m) {
    fileId = m[1]!;
  } else {
    const trimmed = urlPath.replace(/\/+$/, "");
    if ((trimmed === "/open" || trimmed === "/uc" || trimmed === "/download") && parsed.searchParams.get("id")) {
      fileId = parsed.searchParams.get("id");
    }
  }
  if (!fileId || !GDRIVE_FILE_ID_RE.test(fileId)) {
    throw new IntakeError(
      "Could not extract a valid Google Drive file ID. Expected format: " +
        "https://drive.google.com/file/d/<FILE_ID>/view",
    );
  }
  return {
    fileId,
    canonicalUrl: `https://drive.google.com/file/d/${fileId}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

export function isAllowedDownloadHost(hostname: unknown): boolean {
  const h = String(hostname || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!h) return false;
  if (ALLOWED_DOWNLOAD_EXACT_HOSTS.has(h)) return true;
  return ALLOWED_DOWNLOAD_SUFFIX_HOSTS.some((suf) => h.endsWith(suf));
}

function ipToParts(ip: string): { v: 4 | 6; raw: string } | null {
  const bare = ip.split("%")[0]!.toLowerCase();
  if (bare.startsWith("::ffff:")) {
    const mapped = bare.slice("::ffff:".length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return { v: 4, raw: mapped };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) return { v: 4, raw: bare };
  if (bare.includes(":")) return { v: 6, raw: bare };
  return null;
}

function ipv4Num(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inCidr4(ip: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ip & mask) === (base & mask);
}

function blockedIpv4(ip: string): boolean {
  const n = ipv4Num(ip);
  if (n == null) return true;
  const nets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [base, bits] of nets) {
    const bn = ipv4Num(base);
    if (bn != null && inCidr4(n, bn, bits)) return true;
  }
  return n === 0xffffffff;
}

function blockedIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe80:") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) {
    return true;
  }
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("ff")) return true;
  if (s.startsWith("2001:db8:")) return true;
  if (s === "::" ) return true;
  return false;
}

export function isBlockedPublicIp(ip: string): boolean {
  const parsed = ipToParts(ip);
  if (!parsed) return true;
  if (parsed.v === 4) return blockedIpv4(parsed.raw);
  return blockedIpv6(parsed.raw);
}

function ipsFromResolver(infos: unknown): string[] {
  if (!Array.isArray(infos)) return [];
  const out: string[] = [];
  for (const info of infos) {
    if (typeof info === "string") out.push(info);
    else if (Array.isArray(info) && Array.isArray(info[4])) out.push(String(info[4][0]));
    else if (info && typeof info === "object" && "address" in info) {
      out.push(String((info as { address: unknown }).address));
    }
  }
  return out;
}

export async function verifyHostPublicIp(
  hostname: string,
  port = 443,
  resolver?: HostResolver,
): Promise<string[]> {
  let infos: unknown;
  try {
    if (resolver) infos = resolver(hostname, port);
    else {
      const looked = await lookup(hostname, { all: true });
      infos = looked.map((row) => row.address);
    }
  } catch (err) {
    throw new IntakeError(`DNS resolution failed for ${pyReprStr(hostname)}: ${sanitizeLine(err)}`);
  }
  const addrs = ipsFromResolver(Array.isArray(infos) ? infos : []);
  if (addrs.length === 0) throw new IntakeError(`DNS resolution returned no addresses for ${pyReprStr(hostname)}`);
  for (const ip of addrs) {
    if (isBlockedPublicIp(ip)) {
      throw new IntakeError(`Blocked non-public IP address (${ip}) resolved for host ${pyReprStr(hostname)}`);
    }
  }
  return addrs;
}

export async function validateDownloadTargetUrl(targetUrl: unknown, resolver?: HostResolver): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(String(targetUrl || ""));
  } catch (err) {
    throw new IntakeError(`Invalid download URL: ${sanitizeLine(err)}`);
  }
  if (parsed.protocol.toLowerCase() !== "https:") throw new IntakeError("Redirect or download URL must use https://");
  if (parsed.username || parsed.password) throw new IntakeError("Download URL must not contain credentials");
  if (parsed.port && parsed.port !== "443") throw new IntakeError("Download URL must use standard HTTPS port 443");
  const host = parsed.hostname.toLowerCase();
  if (host === "accounts.google.com" || host === "otti.google.com" || parsed.pathname.toLowerCase().includes("servicelogin")) {
    throw new IntakeError(
      "Google Drive file is private or requires sign-in. Set sharing to 'Anyone with the link'.",
    );
  }
  if (!isAllowedDownloadHost(host)) throw new IntakeError(`Disallowed download/redirect host: ${pyReprStr(host)}`);
  await verifyHostPublicIp(host, 443, resolver);
  return String(targetUrl);
}

function htmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => {
      const cp = Number.parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const cp = Number(n);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function extractGdriveConfirmUrl(htmlText: string, fileId: string): string | null {
  const lower = htmlText.toLowerCase();
  if (
    lower.includes("accounts.google.com") ||
    lower.includes("servicelogin") ||
    lower.includes("you need access") ||
    lower.includes("request access") ||
    lower.includes("sign in to continue")
  ) {
    throw new IntakeError(
      "Google Drive file is private or requires sign-in. Set sharing to 'Anyone with the link'.",
    );
  }
  if (lower.includes("quota exceeded") || lower.includes("too many users have viewed or downloaded")) {
    throw new IntakeError(
      "Google Drive download quota exceeded for this file. Try again later or upload the ZIP directly.",
    );
  }
  let formMatch = /<form[^>]+id="download-form"[^>]+action="([^"]+)"/i.exec(htmlText);
  if (!formMatch) {
    formMatch = /<form[^>]+action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]*)"/i.exec(htmlText);
  }
  if (formMatch) {
    const action = htmlUnescape(formMatch[1]!);
    let inputs = Object.fromEntries(
      [...htmlText.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)].map((m) => [
        m[1]!,
        htmlUnescape(m[2]!),
      ]),
    );
    if (Object.keys(inputs).length === 0) {
      inputs = Object.fromEntries(
        [...htmlText.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)].map((m) => [
          m[1]!,
          htmlUnescape(m[2]!),
        ]),
      );
    }
    if (!("id" in inputs)) inputs.id = fileId;
    if (!("export" in inputs)) inputs.export = "download";
    if (!("confirm" in inputs)) inputs.confirm = "t";
    const parsed = new URL(action);
    const qs = new URLSearchParams(parsed.search);
    for (const [key, value] of Object.entries(inputs)) qs.set(key, value);
    parsed.search = qs.toString();
    return parsed.toString();
  }
  const mConfirm = /confirm=([0-9A-Za-z_-]+)/.exec(htmlText);
  if (mConfirm) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${encodeURIComponent(mConfirm[1]!)}`;
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function readLimited(res: Response, max: number, onRead?: () => void): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < max) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      onRead?.();
      step = await reader.read();
    } catch (err) {
      if (isAbortError(err)) throw new IntakeError("Google Drive download timed out");
      throw err;
    }
    const { done, value } = step;
    if (done) break;
    onRead?.();
    const buf = Buffer.from(value);
    const take = buf.subarray(0, max - total);
    chunks.push(Buffer.from(take));
    total += take.length;
    if (total >= max) {
      try {
        await reader.cancel();
      } catch {
        // already capped
      }
      break;
    }
  }
  return Buffer.concat(chunks);
}

export async function downloadGdriveZip(
  fileId: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const maxZipBytes = opts.maxZipBytes ?? MAX_ZIP_BYTES;
  const timeoutS = opts.timeoutS ?? DOWNLOAD_TIMEOUT_S;
  const maxWallS = opts.maxWallS ?? MAX_DOWNLOAD_WALL_S;
  const resolver = opts.resolver;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!GDRIVE_FILE_ID_RE.test(String(fileId || ""))) throw new IntakeError("Invalid Google Drive file ID");
  const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  await validateDownloadTargetUrl(initialUrl, resolver);
  const dest = path.resolve(destPath);
  ensureDir(path.dirname(dest));
  const tmpDest = `${dest}.${process.pid}.part`;
  const started = performance.now();
  const jar = new Map<string, string>();
  // Stall (inactivity) timeout. A single AbortSignal.timeout() stays attached to
  // res.body in undici and aborts an actively streaming download once the clock
  // runs out, so the deadline is re-armed on every chunk instead.
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const resetStallTimer = () => {
    clearStallTimer();
    if (!(timeoutS > 0)) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      stall.abort(new DOMException("Google Drive download timed out", "TimeoutError"));
    }, timeoutS * 1000);
    stallTimer.unref?.();
  };

  const absorbCookies = (headers: Headers) => {
    const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const single = lines.length ? lines : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
    for (const line of single) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const openUrl = async (targetUrl: string): Promise<{ res: Response; finalUrl: string }> => {
    let current = targetUrl;
    let hops = 0;
    for (;;) {
      await validateDownloadTargetUrl(current, resolver);
      const headers: Record<string, string> = {
        "User-Agent": "manhwa-pipeline-intake/1.0",
        Accept: "application/zip,application/octet-stream,*/*",
      };
      const cookie = cookieHeader();
      if (cookie) headers.Cookie = cookie;
      let res: Response;
      try {
        resetStallTimer();
        res = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          headers,
          signal: stall.signal,
        });
      } catch (err) {
        if (err instanceof IntakeError) throw err;
        if (isAbortError(err)) throw new IntakeError("Google Drive download timed out");
        throw new IntakeError(`Google Drive network error: ${sanitizeLine(err)}`);
      }
      absorbCookies(res.headers);
      if (res.status >= 300 && res.status < 400) {
        hops += 1;
        if (hops > MAX_REDIRECTS) {
          throw new IntakeError(`Exceeded maximum redirects (${MAX_REDIRECTS}) while downloading from Google Drive`);
        }
        const loc = res.headers.get("location");
        if (!loc) throw new IntakeError("Google Drive download failed (redirect without Location)");
        current = new URL(loc, current).href;
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new IntakeError(
          `Google Drive file is private or access was denied (HTTP ${res.status}). Set sharing to 'Anyone with the link'.`,
        );
      }
      if (res.status === 404) {
        throw new IntakeError("Google Drive file not found (HTTP 404). Verify the file ID and sharing permissions.");
      }
      if (res.status >= 400) throw new IntakeError(`Google Drive download failed (HTTP ${res.status})`);
      return { res, finalUrl: current };
    }
  };

  try {
    const first = await openUrl(initialUrl);
    await validateDownloadTargetUrl(first.finalUrl, resolver);
    const ctype = (first.res.headers.get("content-type") || "").toLowerCase();
    let active = first;
    if (ctype.includes("text/html")) {
      const htmlBytes = await readLimited(first.res, 262_144, resetStallTimer);
      const htmlText = htmlBytes.toString("utf8");
      const confirmUrl = extractGdriveConfirmUrl(htmlText, fileId);
      if (!confirmUrl) {
        throw new IntakeError(
          "Google Drive returned an HTML page instead of a ZIP archive. " +
            "Ensure the link points to a public .zip file ('Anyone with the link').",
        );
      }
      active = await openUrl(confirmUrl);
    }
    try {
      await validateDownloadTargetUrl(active.finalUrl, resolver);
      const ctype2 = (active.res.headers.get("content-type") || "").toLowerCase();
      if (ctype2.includes("text/html")) {
        const snippet = (await readLimited(active.res, 65_536, resetStallTimer)).toString("utf8");
        extractGdriveConfirmUrl(snippet, fileId);
        throw new IntakeError(
          "Google Drive returned an HTML page instead of a ZIP archive after confirmation. " +
            "Verify the file is a shared .zip archive.",
        );
      }
      const clen = active.res.headers.get("content-length");
      let expectedTotal: number | null = null;
      if (clen && /^\d+$/.test(clen.trim())) {
        const n = Number(clen);
        if (n > maxZipBytes) {
          throw new IntakeError(`Google Drive file size (${n} B) exceeds maximum allowed (${maxZipBytes} B)`);
        }
        expectedTotal = n;
      }
      const reader = active.res.body?.getReader();
      if (!reader) throw new IntakeError("Downloaded Google Drive file is empty");
      const fh = fs.openSync(tmpDest, "w", 0o640);
      let total = 0;
      let header = Buffer.alloc(0);
      let headerChecked = false;
      try {
        for (;;) {
          if ((performance.now() - started) / 1000 > maxWallS) {
            throw new IntakeError("Google Drive download exceeded maximum time limit");
          }
          resetStallTimer();
          let step: Awaited<ReturnType<typeof reader.read>>;
          try {
            step = await reader.read();
          } catch (err) {
            if (isAbortError(err)) throw new IntakeError("Google Drive download timed out");
            throw err;
          }
          const { done, value } = step;
          if (done) break;
          resetStallTimer();
          const chunk = Buffer.from(value);
          if (!headerChecked) {
            header = Buffer.concat([header, chunk.subarray(0, Math.min(chunk.length, 4 - header.length))]);
            if (header.length >= 4) {
              headerChecked = true;
              if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
                throw new IntakeError("Downloaded Google Drive file is not a valid ZIP archive (bad magic header)");
              }
            }
          }
          total += chunk.length;
          if (total > maxZipBytes) {
            throw new IntakeError(`Downloaded Google Drive file exceeds maximum size limit (${maxZipBytes} B)`);
          }
          fs.writeSync(fh, chunk);
          opts.progressCb?.(total);
        }
        fs.fsyncSync(fh);
      } finally {
        fs.closeSync(fh);
      }
      if (total < 4 || !headerChecked) throw new IntakeError("Downloaded Google Drive file is empty");
      fs.renameSync(tmpDest, dest);
      matchOwner(dest, path.dirname(dest));
      return { bytes: total, path: dest, totalBytes: expectedTotal };
    } finally {
      try {
        await active.res.body?.cancel();
      } catch {
        // stream already consumed
      }
    }
  } finally {
    clearStallTimer();
    try {
      if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
    } catch {
      // best-effort
    }
  }
}

function logStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendJobLog(jobId: string, line: string, env?: Env): void {
  const jdir = ensureDir(jobsDir(env));
  const logFile = path.join(jdir, `${jobId}.log`);
  const clean = sanitizeLine(line, 500);
  if (!clean) return;
  const entry = Buffer.from(`[${logStamp()}] ${clean}\n`, "utf8");
  try {
    fs.appendFileSync(logFile, entry);
    const size = fs.statSync(logFile).size;
    if (size > MAX_LOG_BYTES * 2) {
      const fh = fs.openSync(logFile, "r");
      let tail: Buffer;
      try {
        const start = Math.max(0, size - MAX_LOG_BYTES);
        tail = Buffer.alloc(size - start);
        fs.readSync(fh, tail, 0, tail.length, start);
      } finally {
        fs.closeSync(fh);
      }
      const nl = tail.indexOf(0x0a);
      if (nl >= 0) tail = tail.subarray(nl + 1);
      fs.writeFileSync(logFile, tail);
    }
    matchOwner(logFile, jdir);
  } catch {
    // logging must not fail the job
  }
}

function readJobLogTail(jobId: string, maxLines = MAX_LOG_TAIL_LINES, env?: Env): string[] {
  const logFile = path.join(jobsDir(env), `${jobId}.log`);
  if (!isFile(logFile)) return [];
  try {
    const st = fs.statSync(logFile);
    const start = Math.max(0, st.size - MAX_LOG_BYTES);
    const fh = fs.openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fh, buf, 0, buf.length, start);
      const raw = buf.toString("utf8");
      const lines = raw.split(/\r?\n/).map((l) => sanitizeLine(l, 500)).filter((l) => l);
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fh);
    }
  } catch {
    return [];
  }
}

function saveJob(job: JobRecord, env?: Env): JobRecord {
  return withJobMetaLock(env, () => {
    const jdir = jobsDir(env);
    // A worker holds an in-memory snapshot. Never let its progress writes undo live controls.
    const persisted = loadJobFile(path.join(jdir, `${job.id}.json`));
    if (persisted && Number(persisted.controlRevision || 0) > Number(job.controlRevision || 0)) {
      job.controlRevision = persisted.controlRevision;
      job.paused = persisted.paused;
      job.stopRequested = persisted.stopRequested;
      if (persisted.stopRequested) {
        job.status = "interrupted";
        job.statusNote = persisted.statusNote;
        job.endedAt = persisted.endedAt;
      }
    }
    if (job.stopRequested) {
      job.status = "interrupted";
      job.paused = false;
      job.statusNote = "Stopped by user; completed chapters and caches are preserved";
    }
    job.updatedAt = Date.now() / 1000;
    job.logTail = readJobLogTail(String(job.id), 30, env);
    atomicWriteJson(path.join(jdir, `${job.id}.json`), job, jdir);
    return job;
  });
}

function availableActions(job: JobRecord): string[] {
  const st = job.status;
  const acts: string[] = [];
  if ((RECOVERABLE_JOB_STATES as readonly string[]).includes(st)) acts.push("retry");
  if ((CONTINUABLE_JOB_STATES as readonly string[]).includes(st)) acts.push("continue");
  // Live controls travel with the job so a client can render buttons from one field.
  if (st === "paused" || (st === "running" && job.paused)) acts.push("resume");
  else if (st === "running") acts.push("pause");
  if (st === "running" || st === "downloading" || st === "ingesting" || st === "paused") acts.push("stop", "cancel");
  return acts;
}

function publicProgress(job: JobRecord): Record<string, unknown> | null {
  const p = job.progress;
  if (!p || typeof p !== "object") return null;
  const loaded = p.loadedBytes;
  const total = p.totalBytes;
  const out: Record<string, unknown> = {
    phase: p.phase,
    loadedBytes: typeof loaded === "number" ? Math.trunc(loaded) : null,
    totalBytes: typeof total === "number" && total > 0 ? Math.trunc(total) : null,
    chapter: p.chapter,
    chapterIndex: p.chapterIndex,
    chapterTotal: p.chapterTotal,
  };
  if (typeof out.loadedBytes === "number" && typeof out.totalBytes === "number" && out.totalBytes) {
    out.percent = Math.min(100, Math.trunc((out.loadedBytes * 100) / out.totalBytes));
  } else if (p.chapterIndex && p.chapterTotal) {
    out.percent = Math.min(100, Math.trunc((Number(p.chapterIndex) * 100) / Number(p.chapterTotal)));
  } else {
    out.percent = null;
  }
  return out;
}

export function publicJobView(job: JobRecord, includeLogs = true, env?: Env): Record<string, unknown> {
  const tts = (job.tts && typeof job.tts === "object" ? job.tts : {}) as Record<string, unknown>;
  const ingested = Array.isArray(job.ingestedChapters) ? job.ingestedChapters : [];
  const out: Record<string, unknown> = {
    id: job.id,
    slug: job.slug,
    title: job.title,
    status: job.status,
    paused: Boolean(job.paused),
    stage: job.paused ? "paused" : STAGE_BY_STATUS[job.status] || "unknown",
    progress: publicProgress(job),
    retryCount: Number(job.retryCount || 0),
    actions: availableActions(job),
    controlActions: job.status === "paused" || (job.status === "running" && job.paused)
      ? ["resume", "stop"] : ["queued", "running"].includes(job.status) ? ["pause", "stop"] : [],
    statusNote: sanitizeLine(job.statusNote || "") || null,
    sourceType: job.sourceType,
    sourceSummary: sanitizeLine(job.sourceSummary || ""),
    chapters: job.chapters ?? "all",
    ingestedChapters: ingested,
    tts: {
      providerId: tts.providerId ?? "edge",
      providerLabel: tts.providerLabel ?? "Edge TTS",
      engine: tts.engine ?? "edge",
      voiceId: tts.voiceId ?? "en-US-AndrewMultilingualNeural",
      voiceLabel: tts.voiceLabel ?? "Andrew Multilingual",
    },
    visuals: job.visuals || { background: DEFAULT_BACKGROUND, motion: DEFAULT_MOTION },
    renderLane: renderLaneEnv(job, env),
    renderQuality: job.renderQuality || studioRenderQuality(env),
    outroConfig: job.outroConfig ?? null,
    createdBy: job.createdBy || "cli",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    workerPid: job.workerPid,
    runPid: job.runPid,
    error: job.error ? sanitizeLine(job.error) : null,
    statusUrl: "/status.html",
    libraryUrl:
      job.status === "completed"
        ? `/#/watch/${job.slug}/${(ingested[0] as string | undefined) || "ch1"}`
        : "/",
  };
  if (includeLogs) {
    out.logTail = readJobLogTail(String(job.id), 50, env);
    if (!(out.logTail as string[]).length) out.logTail = job.logTail || [];
  }
  return out;
}

function loadPersistedJobs(jdir: string): JobRecord[] {
  const jobs: JobRecord[] = [];
  for (const name of fs.readdirSync(jdir).filter((n) => n.endsWith(".json")).sort()) {
    const filePath = path.join(jdir, name);
    const job = loadJobFile(filePath) ?? corruptJobRecord(filePath);
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return jobs;
}

function reconcileJobsLocked(jdir: string, env?: Env): JobRecord[] {
  const jobs: JobRecord[] = [];
  for (const name of fs.readdirSync(jdir).filter((n) => n.endsWith(".json")).sort()) {
    const filePath = path.join(jdir, name);
    const job = loadJobFile(filePath) ?? corruptJobRecord(filePath);
    if (!job) continue;
    const state = job.status;
    if (state === "downloading" || state === "ingesting" || state === "running") {
      const wAlive = isPidAlive(job.workerPid, job.workerStartTicks);
      const rAlive = isPidAlive(job.runPid, job.runStartTicks);
      // A dead recorded runPid means the pipeline run itself is gone even when
      // the worker that spawned it is still alive: the job can never progress.
      const runGone = job.runPid != null && !rAlive;
      if ((!wAlive && !rAlive) || runGone) {
        const now = Date.now() / 1000;
        job.status = "interrupted";
        job.paused = false;
        job.endedAt = now;
        job.statusNote = "Interrupted due to worker termination; not auto-rerun.";
        if (!job.error) {
          job.error =
            `Job was in '${state}' state when its worker process terminated unexpectedly. ` +
            "Marked interrupted to prevent duplicate execution.";
        }
        appendJobLog(
          String(job.id),
          `RECONCILE: job marked interrupted (previous state=${state}, workerPid=${job.workerPid}, runPid=${job.runPid})`,
          env,
        );
        const staged = job.stagedZipPath;
        if (staged && (state === "downloading" || state === "ingesting") && isFile(String(staged))) {
          try {
            fs.unlinkSync(String(staged));
          } catch {
            // best-effort
          }
        }
        saveJob(job, env);
      }
    }
    jobs.push(job);
  }
  jobs.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return jobs;
}

export function reconcileJobs(env?: Env, readOnly = false): JobRecord[] {
  const jdir = jobsDir(env);
  if (!isDir(jdir)) return [];
  if (readOnly) {
    try {
      return withJobMetaLock(env, () => reconcileJobsLocked(jdir, env));
    } catch (err) {
      if (err instanceof MetaLockUnavailableError) return loadPersistedJobs(jdir);
      throw err;
    }
  }
  return withJobMetaLock(env, () => reconcileJobsLocked(jdir, env));
}

export function isWorkerLockHeld(env?: Env): boolean {
  const lockPath = path.join(jobsDir(env), "queue.lock");
  if (!lexists(lockPath)) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, "r+");
    const got = tryFlockFd(fd, "ex", true);
    if (got) {
      try {
        flockFd(fd, "un");
      } catch {
        // probe only
      }
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function workerLaunchArgv(): string[] {
  const script = fileURLToPath(import.meta.url);
  if (process.execArgv.length) return [...process.execArgv, script, "worker"];
  const tsxBin = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (isFile(tsxBin)) return [tsxBin, script, "worker"];
  return [script, "worker"];
}

export function spawnWorkerIfNeeded(repoRoot = REPO_ROOT, env?: Env): boolean {
  const e = resolveEnv(env);
  if (e.MANHWA_NO_AUTO_WORKER === "1") return false;
  const jdir = jobsDir(e);
  if (!isDir(jdir)) return false;
  const hasQueued = fs.readdirSync(jdir).some((name) => {
    if (!name.endsWith(".json")) return false;
    const job = loadJobFile(path.join(jdir, name));
    return job?.status === "queued" && !laneBlocksJob(job, e);
  });
  if (!hasQueued || isWorkerLockHeld(e)) return false;
  try {
    withJobMetaLock(e, () => undefined);
  } catch (err) {
    if (err instanceof MetaLockUnavailableError) return false;
    throw err;
  }
  const child = spawn(process.execPath, workerLaunchArgv(), {
    cwd: repoRoot,
    env: childEnv(e),
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
  return (child.pid ?? 0) > 0;
}

function removeIfFile(p: string | null | undefined): void {
  if (p && isFile(p)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

export async function enqueueJob(opts: EnqueueOptions = {}): Promise<Record<string, unknown>> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || opts.repo_root || REPO_ROOT;
  const jdir = ensureDir(jobsDir(env));
  const uploadsDir = ensureDir(path.join(jdir, "uploads"));
  const sRoot = ensureDir(seriesRoot(env));
  const gdriveUrl = opts.gdriveUrl || opts.gdrive_url || null;
  const zipPath = opts.zipPath || opts.zip_path || null;
  if (gdriveUrl && zipPath) throw new IntakeError("Specify either a Google Drive URL or a ZIP file, not both");
  if (!gdriveUrl && !zipPath) throw new IntakeError("A Google Drive file ZIP URL or a ZIP archive is required");
  let sourceType = opts.sourceType || opts.source_type || "";
  if (!sourceType) sourceType = gdriveUrl ? "gdrive" : "local_zip";
  if (sourceType !== "gdrive" && sourceType !== "upload" && sourceType !== "local_zip") {
    throw new IntakeError(`Invalid source_type ${pyReprStr(sourceType)}`);
  }
  const chaptersNorm = validateChaptersSpec(opts.chapters ?? "all");
  const bgNorm = String(opts.background || DEFAULT_BACKGROUND).trim().toLowerCase();
  if (!(BACKGROUNDS as readonly string[]).includes(bgNorm)) {
    throw new IntakeError(`Unknown background preset ${pyReprStr(bgNorm)} (allowed: ${BACKGROUNDS.join(", ")})`);
  }
  const moNorm = String(opts.motion || DEFAULT_MOTION).trim().toLowerCase();
  if (!(MOTIONS as readonly string[]).includes(moNorm)) {
    throw new IntakeError(`Unknown motion preset ${pyReprStr(moNorm)} (allowed: ${MOTIONS.join(", ")})`);
  }
  const ttsResolved = await resolveTtsSelection(opts.provider || "edge", opts.voice, repoRoot, env, true);
  const renderLaneNorm = resolveRenderLane(opts.renderLane ?? opts.render_lane ?? null, env, repoRoot);
  // Persist only an explicit request; an absent value resolves from Studio settings at run time.
  const rawRenderQuality = opts.renderQuality ?? opts.render_quality ?? null;
  const renderQualityNorm = rawRenderQuality === null || String(rawRenderQuality).trim() === ""
    ? null
    : normalizeRenderQuality(rawRenderQuality);
  if (renderQualityNorm === null && rawRenderQuality !== null && String(rawRenderQuality).trim() !== "") {
    throw new IntakeError(`Invalid renderQuality ${pyReprStr(String(rawRenderQuality))} (allowed: ${RENDER_QUALITIES.join(", ")})`);
  }

  let gdriveInfo: ReturnType<typeof parseGdriveUrl> | null = null;
  let localZipAbs: string | null = null;
  let inferredTitle: string | null = null;
  if (sourceType === "gdrive") {
    gdriveInfo = parseGdriveUrl(gdriveUrl);
  } else {
    if (!zipPath || typeof zipPath !== "string") throw new IntakeError("ZIP file path is required");
    localZipAbs = path.resolve(zipPath);
    try {
      const [layout, idx] = archiveIndex(localZipAbs, true);
      const selected = parseChapterSpec(chaptersNorm, idx);
      const present = selected.filter((c) => c in idx);
      if (present.length === 0) {
        const avail = Object.keys(idx).map(Number).sort((a, b) => a - b).map((c) => `ch${c}`).join(", ");
        throw new IntakeError(
          `Requested chapters (${chaptersNorm}) are not present in ZIP archive (available: ${avail})`,
        );
      }
      const firstKey = Object.keys(idx).map(Number).sort((a, b) => a - b)[0];
      const firstCbz = layout === "cbz" && firstKey != null ? String((idx as Record<number, string>)[firstKey]) : null;
      inferredTitle = comicTitle(localZipAbs, firstCbz);
    } catch (err) {
      if (sourceType === "upload") removeIfFile(localZipAbs);
      if (err instanceof IntakeError) throw err;
      if (err instanceof ZipValidationError || err instanceof SystemExit) throw new IntakeError(err.message);
      if (sourceType === "upload") removeIfFile(localZipAbs);
      throw err;
    }
  }

  const uploadFilename = opts.uploadFilename || opts.upload_filename || null;
  let rawTitle = String(opts.title || "").trim();
  if (!rawTitle) {
    if (inferredTitle) rawTitle = inferredTitle;
    else if (uploadFilename) {
      rawTitle = path.basename(uploadFilename).replace(/\.zip$/i, "").replace(/[-_]/g, " ").trim();
    } else if (localZipAbs) {
      rawTitle = path.basename(localZipAbs).replace(/\.zip$/i, "").replace(/[-_]/g, " ").trim();
    }
  }
  let rawSlug = String(opts.slug || "").trim().toLowerCase();
  if (!rawSlug && rawTitle) rawSlug = slugify(rawTitle);
  if (!rawSlug) throw new IntakeError("Series title or slug is required");
  const cleanSlug = validateSlug(rawSlug);
  let cleanTitle = rawTitle || cleanSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (cleanTitle.length > 120) cleanTitle = cleanTitle.slice(0, 120).trim();

  const lockFile = path.join(jdir, "create.lock");
  const lockFd = acquireLockFd(lockFile, "create.lock");
  let job: JobRecord;
  try {
    job = withJobMetaLock(env, () => {
      const existingJobs = reconcileJobs(env);
      const sdir = path.join(sRoot, cleanSlug);
      if (lexists(sdir)) {
        if (sourceType === "upload") removeIfFile(localZipAbs);
        throw new ConflictError(
          `Series ${pyReprStr(cleanSlug)} already exists in ${sRoot}. ` +
            "Existing series are never overwritten; choose a new series slug.",
        );
      }
      for (const j of existingJobs) {
        if (j.slug === cleanSlug && (ACTIVE_JOB_STATES as readonly string[]).includes(j.status)) {
          if (sourceType === "upload") removeIfFile(localZipAbs);
          throw new ConflictError(`Series ${pyReprStr(cleanSlug)} already has an active/queued job (${j.id})`);
        }
      }
      const jobId = `job-${Date.now()}-${randomBytes(4).toString("hex")}`;
      let stagedZipPath: string | null = null;
      let sourceSummary: string;
      if (sourceType === "upload") {
        const destStaged = path.join(uploadsDir, `${jobId}.zip`);
        if (path.resolve(localZipAbs!) !== destStaged) moveFile(localZipAbs!, destStaged);
        matchOwner(destStaged, jdir);
        stagedZipPath = destStaged;
        sourceSummary = `Uploaded ZIP (${path.basename(uploadFilename || "archive.zip")})`;
      } else if (sourceType === "local_zip") {
        stagedZipPath = localZipAbs;
        sourceSummary = `Local ZIP (${path.basename(localZipAbs!)})`;
      } else {
        sourceSummary = `Google Drive ZIP (file ID: ${gdriveInfo!.fileId})`;
      }
      const now = Date.now() / 1000;
      const created: JobRecord = {
        schemaVersion: 1,
        id: jobId,
        slug: cleanSlug,
        title: cleanTitle,
        status: "queued",
        statusNote: "Queued for serialized execution",
        sourceType,
        sourceSummary,
        gdriveFileId: gdriveInfo ? gdriveInfo.fileId : null,
        stagedZipPath,
        chapters: chaptersNorm,
        ingestedChapters: [],
        tts: {
          providerId: ttsResolved.providerId,
          providerLabel: ttsResolved.providerLabel,
          engine: ttsResolved.engine,
          voiceId: ttsResolved.voiceId,
          voiceLabel: ttsResolved.voiceLabel,
          metaTts: ttsResolved.metaTts,
        },
        visuals: { background: bgNorm, motion: moNorm },
        renderLane: renderLaneNorm,
        renderQuality: renderQualityNorm,
        outroConfig: opts.outroConfig ?? null,
        createdBy: String(opts.createdBy || opts.created_by || "cli").slice(0, 64),
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        endedAt: null,
        workerPid: null,
        workerStartTicks: null,
        runPid: null,
        runStartTicks: null,
        error: null,
        logTail: [],
      };
      appendJobLog(
        jobId,
        `Job queued: slug=${cleanSlug} source=${sourceSummary} ` +
          `tts=${ttsResolved.providerId}/${ttsResolved.voiceId} chapters=${chaptersNorm} renderLane=${renderLaneNorm}`,
        env,
      );
      saveJob(created, env);
      return created;
    });
  } finally {
    releaseLockFd(lockFd);
  }
  const spawnFlag = opts.spawnWorker ?? opts.spawn_worker ?? true;
  if (spawnFlag) spawnWorkerIfNeeded(repoRoot, env);
  return publicJobView(job, true, env);
}

/** Create a serialized pipeline job for chapters already extracted into an existing series. */
export async function createJob(opts: EnqueueOptions = {}): Promise<Record<string, unknown>> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const slug = validateSlug(opts.slug);
  const sdir = path.join(seriesRoot(env), slug);
  if (!isDir(sdir) || fs.lstatSync(sdir).isSymbolicLink()) throw new IntakeError("Existing series directory required");
  const spec = validateChaptersSpec(opts.chapters);
  const available = existingChapterNumbers(sdir);
  const requested = parseChapterSpec(spec, available);
  if (!requested.length || requested.some((n) => !available.includes(n))) throw new IntakeError("Requested chapters are not extracted yet");
  let meta: JobRecord = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(sdir, "meta.json"), "utf8")); } catch { /* Defaults. */ }
  const persistedTts = meta.tts && typeof meta.tts === "object" && !Array.isArray(meta.tts)
    ? meta.tts as Record<string, unknown>
    : null;
  // An extension job without an explicit provider continues the series' own TTS
  // (Grok/Vertex/external), so a voice-only override works and preflight checks
  // the provider that will actually synthesize the narration.
  const requestedProvider = String(opts.provider ?? "").trim();
  const persistedProvider = !requestedProvider && persistedTts
    ? ttsProviderIdFromMeta(persistedTts, env)
    : null;
  const persistedVoice = persistedProvider && persistedTts
    ? String(persistedTts.voice_id || "").trim()
    : "";
  const selection = await resolveTtsSelection(
    requestedProvider || persistedProvider,
    String(opts.voice ?? "").trim() || persistedVoice || undefined,
    repoRoot,
    env,
  );
  const renderLane = resolveRenderLane(opts.renderLane, env, repoRoot);
  // Persist only an explicit request; an absent value resolves from Studio settings at run time.
  const rawRenderQuality = opts.renderQuality ?? opts.render_quality ?? null;
  const renderQuality = rawRenderQuality === null || String(rawRenderQuality).trim() === ""
    ? null
    : normalizeRenderQuality(rawRenderQuality);
  if (renderQuality === null && rawRenderQuality !== null && String(rawRenderQuality).trim() !== "") {
    throw new IntakeError(`Invalid renderQuality ${pyReprStr(String(rawRenderQuality))} (allowed: ${RENDER_QUALITIES.join(", ")})`);
  }
  const bgNorm = String(opts.background || meta.visuals?.background || DEFAULT_BACKGROUND).trim().toLowerCase();
  if (!(BACKGROUNDS as readonly string[]).includes(bgNorm)) {
    throw new IntakeError(`Unknown background preset ${pyReprStr(bgNorm)} (allowed: ${BACKGROUNDS.join(", ")})`);
  }
  const moNorm = String(opts.motion || meta.visuals?.motion || DEFAULT_MOTION).trim().toLowerCase();
  if (!(MOTIONS as readonly string[]).includes(moNorm)) {
    throw new IntakeError(`Unknown motion preset ${pyReprStr(moNorm)} (allowed: ${MOTIONS.join(", ")})`);
  }
  const job = withJobMetaLock(env, () => {
    reconcileJobs(env);
    const conflict = activeConflictFor(slug, null, env);
    if (conflict) throw new ConflictError(`Series '${slug}' already has an active/queued job (${conflict.id})`);
    const now = Date.now() / 1000;
    const onlyUnrendered = opts.preserveCompleted !== false;
    const current: JobRecord = {
      schemaVersion: 1, id: `job-${Date.now()}-${randomBytes(4).toString("hex")}`,
      slug, title: opts.title || meta.title || slug, status: "queued",
      statusNote: onlyUnrendered ? "Extension queued (unrendered chapters only)" : "Extension queued (completed chapters re-queued)",
      sourceType: (EXTENSION_SOURCE_TYPES as readonly string[]).includes(String(opts.sourceType)) ? String(opts.sourceType) : "existing",
      sourceSummary: "Existing chapter folders", chapters: spec,
      runChapters: requested, ingestedChapters: available.map((n) => `ch${n}`),
      skipIngest: true, allowExistingSeries: true, onlyUnrendered,
      preserveCompleted: opts.preserveCompleted !== false,
      tts: {
        ...selection,
        providerId: selection.providerId,
        metaTts: !requestedProvider && !String(opts.voice ?? "").trim() && persistedTts
          ? persistedTts
          : selection.metaTts,
      },
      visuals: { background: bgNorm, motion: moNorm },
      renderLane,
      renderQuality,
      createdBy: opts.createdBy || "cli", createdAt: now, updatedAt: now, startedAt: null, endedAt: null,
      workerPid: null, workerStartTicks: null, runPid: null, runStartTicks: null, error: null, logTail: [],
      outroConfig: opts.outroConfig ?? null,
    };
    appendJobLog(current.id, `Extension queued: chapters=${spec}`, env);
    return saveJob(current, env);
  });
  if (opts.spawnWorker !== false) spawnWorkerIfNeeded(repoRoot, env);
  return publicJobView(job, true, env);
}

function signalJobRun(job: JobRecord, signal: NodeJS.Signals): void {
  if (!isPidAlive(job.runPid, job.runStartTicks) || Number(job.runPid) === process.pid) {
    throw new ConflictError("Pipeline process is no longer alive; refresh the job");
  }
  // New runs own a process group, so ffmpeg, Remotion and local children pause together.
  process.kill(job.runProcessGroup ? -Number(job.runPid) : Number(job.runPid), signal);
}

export function pauseJob(jobId: string, env?: Env): Record<string, unknown> {
  const job = withJobMetaLock(env, () => {
    const current = loadJob(jobId, env);
    if (current.paused) return current;
    if (current.status === "running") signalJobRun(current, "SIGSTOP");
    else if (current.status === "queued") current.status = "paused";
    else throw new ConflictError("Only queued or running jobs can be paused");
    current.paused = true;
    current.controlRevision = Number(current.controlRevision || 0) + 1;
    current.statusNote = "Paused by user";
    return saveJob(current, env);
  });
  return publicJobView(job, true, env);
}

export function resumeJob(jobId: string, env?: Env): Record<string, unknown> {
  const job = withJobMetaLock(env, () => {
    const current = loadJob(jobId, env);
    if (!current.paused && current.status !== "paused") throw new ConflictError("Job is not paused");
    if (current.status === "running") signalJobRun(current, "SIGCONT");
    else if (current.status === "paused") current.status = "queued";
    else throw new ConflictError("This job cannot be resumed");
    current.paused = false;
    current.controlRevision = Number(current.controlRevision || 0) + 1;
    current.statusNote = "Resumed by user";
    return saveJob(current, env);
  });
  if (job.status === "queued") spawnWorkerIfNeeded(REPO_ROOT, env);
  return publicJobView(job, true, env);
}

export function stopJob(jobId: string, env?: Env): Record<string, unknown> {
  const job = withJobMetaLock(env, () => {
    const current = loadJob(jobId, env);
    if (current.status === "running") {
      signalJobRun(current, "SIGTERM");
      // A stopped process must continue before it can handle SIGTERM and clean up.
      if (current.paused) signalJobRun(current, "SIGCONT");
    } else if (current.status !== "queued" && current.status !== "paused") {
      throw new ConflictError("Only queued, paused or running jobs can be stopped");
    }
    current.stopRequested = true;
    current.paused = false;
    current.controlRevision = Number(current.controlRevision || 0) + 1;
    current.status = "interrupted";
    current.statusNote = "Stopped by user; completed chapters and caches are preserved";
    current.endedAt = Date.now() / 1000;
    return saveJob(current, env);
  });
  return publicJobView(job, true, env);
}

function laneControlsFile(env?: Env, outDir?: string): string {
  const e = resolveEnv(env);
  return path.join(outDir || e.MANHWA_OUT_DIR || e.PIPELINE_OUT_DIR || (e.PIPELINE_LOG ? path.dirname(e.PIPELINE_LOG) : resolveOutDir()), "config", "lane-controls.json");
}

function readLaneControls(env?: Env, outDir?: string): Record<string, { paused: boolean; updatedAt: number }> {
  try { return JSON.parse(fs.readFileSync(laneControlsFile(env, outDir), "utf8")).lanes || {}; }
  catch { return {}; }
}

function laneBlocksJob(job: JobRecord, env?: Env): boolean {
  const lanes = readLaneControls(env);
  const selector = renderLaneEnv(job, env);
  // An inherited run can dispatch to any enabled lane; hold it while any lane is paused.
  return selector === "inherit" ? Object.values(lanes).some((l) => l.paused) : Boolean(lanes[selector]?.paused);
}

/** Controls queue dispatch and active intake-owned pipeline groups, not unrelated host processes. */
export function controlRenderLane(laneId: string, action: "pause" | "resume" | "stop", env?: Env, outDir?: string) {
  if (!getRegisteredNodes(outDir).some((n) => n.id === laneId) && !["local", "laptop", "cloud"].includes(laneId)) throw new IntakeError("Unknown render lane", 404);
  return withJobMetaLock(env, () => {
    const lanes = readLaneControls(env, outDir);
    if (action !== "stop") {
      lanes[laneId] = { paused: action === "pause", updatedAt: Date.now() / 1000 };
      atomicWriteJson(laneControlsFile(env, outDir), { schemaVersion: 1, lanes });
    }
    const affectedJobs: string[] = [];
    const errors: Array<{ jobId: string; error: string }> = [];
    for (const job of reconcileJobs(env)) {
      const selector = renderLaneEnv(job, env);
      if (selector !== laneId && selector !== "inherit") continue;
      try {
        const pausedByLane: string[] = Array.isArray(job.pausedByLane) ? job.pausedByLane : [];
        if (action === "pause" && ["queued", "paused", "running"].includes(job.status)) {
          if (job.paused && !pausedByLane.length) continue; // Preserve a user's independent pause.
          pauseJob(String(job.id), env);
          const current = loadJob(job.id, env);
          current.pausedByLane = [...new Set([...pausedByLane, laneId])];
          saveJob(current, env);
        } else if (action === "resume" && pausedByLane.includes(laneId)) {
          job.pausedByLane = pausedByLane.filter((id) => id !== laneId);
          saveJob(job, env);
          if (!job.pausedByLane.length && job.paused) resumeJob(String(job.id), env);
        } else if (action === "stop" && job.status === "running") stopJob(String(job.id), env);
        else continue;
        affectedJobs.push(String(job.id));
      } catch (err) { errors.push({ jobId: String(job.id), error: sanitizeLine((err as Error).message) }); }
    }
    if (action === "resume") spawnWorkerIfNeeded(REPO_ROOT, env);
    return { ok: errors.length === 0, laneId, action, paused: Boolean(lanes[laneId]?.paused), affectedJobs, errors,
      scope: "Intake-owned pipeline process groups; inherited jobs are held conservatively" };
  });
}

async function waitForExternalRuns(job: JobRecord, env?: Env, pollInterval = 2, maxWaitS: number | null = null): Promise<void> {
  const started = performance.now();
  let noted = false;
  for (;;) {
    const active = detectActivePipelineRuns(REPO_ROOT);
    if (active.length === 0) {
      if (noted) appendJobLog(String(job.id), "Active external pipeline run finished; proceeding.", env);
      return;
    }
    const cur = active[0]!;
    const note = `Waiting for active pipeline run (${cur.series}, PID ${cur.pid}) to finish`;
    if (job.statusNote !== note) {
      job.statusNote = note;
      appendJobLog(String(job.id), note, env);
      saveJob(job, env);
      noted = true;
    }
    if (maxWaitS != null && (performance.now() - started) / 1000 >= maxWaitS) throw new IntakeError(note);
    await new Promise((r) => setTimeout(r, pollInterval * 1000));
  }
}

function chownTree(rootDir: string, ref: string): void {
  if (!euidIsRoot()) return;
  const walk = (dir: string) => {
    matchOwner(dir, ref);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else matchOwner(full, ref);
    }
  };
  walk(rootDir);
}

function defaultRunCommand(repoRoot: string, env: Env, slug: string, runNames: string[], chapters: string, pinned: boolean): string[] {
  const pyRun = path.join(repoRoot, "pipeline", "run.py");
  const tsRun = path.join(repoRoot, "src", "cli", "run.ts");
  let prefix: string[];
  if (isFile(tsRun)) {
    const tsxBin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    prefix = isFile(tsxBin) ? [process.execPath, tsxBin, tsRun] : [process.execPath, ...process.execArgv, tsRun];
  } else if (isFile(pyRun)) {
    prefix = [resolvePipelinePython(repoRoot, env), pyRun];
  } else {
    throw new IntakeError("Pipeline runner is not available (src/cli/run.ts)");
  }
  if (chapters === "all" && !pinned) return [...prefix, slug, "--video", "--all"];
  return [...prefix, slug, ...runNames, "--video"];
}

export async function executeSingleJob(
  job: JobRecord,
  opts: {
    repoRoot?: string;
    env?: Env;
    downloadFn?: WorkerOptions["downloadFn"];
    runCmdOverride?: string[] | null;
  } = {},
): Promise<void> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const jobId = String(job.id);
  const slug = String(job.slug);
  const jdir = jobsDir(env);
  const uploadsDir = ensureDir(path.join(jdir, "uploads"));
  const sRoot = ensureDir(seriesRoot(env));
  const sdir = path.join(sRoot, slug);
  const maxExtWait = env.MANHWA_EXTERNAL_RUN_WAIT_S
    ? Number(env.MANHWA_EXTERNAL_RUN_WAIT_S)
    : 3600; // bounded default: never wait forever on a foreign pipeline run
  await waitForExternalRuns(job, env, 2, Number.isFinite(maxExtWait) ? maxExtWait : 3600);

  const myPid = process.pid;
  job.workerPid = myPid;
  job.workerStartTicks = getProcStartTicks(myPid);
  job.startedAt = Date.now() / 1000;
  job.error = null;
  let createdSeriesDir = false;
  let zipToIngest: string | null = job.stagedZipPath ? String(job.stagedZipPath) : null;
  const cleanupZipAfter = job.sourceType === "gdrive" || job.sourceType === "upload";
  const skipIngest = Boolean(job.skipIngest);
  let ingestedNames: string[] = [];

  try {
    const [laneOk, laneWhy] = renderLaneRecheck(job, env, repoRoot);
    if (!laneOk) {
      throw new IntakeError(
        `Render lane ${pyReprStr(renderLaneEnv(job, env))} can no longer be used: ${laneWhy}. Re-enable it in lane settings, then retry.`,
      );
    }
    if (job.sourceType === "gdrive" && !skipIngest) {
      const fileId = String(job.gdriveFileId || "");
      const destZip = path.join(uploadsDir, `${jobId}.zip`);
      job.stagedZipPath = destZip;
      job.status = "downloading";
      job.statusNote = `Downloading ZIP from Google Drive (${fileId})…`;
      job.progress = { phase: "download", loadedBytes: 0, totalBytes: null };
      appendJobLog(jobId, `STAGE downloading: Google Drive file_id=${fileId}`, env);
      saveJob(job, env);
      const dl = opts.downloadFn || downloadGdriveZip;
      let lastLoggedMb = 0;
      const dlRes = await dl(fileId, destZip, {
        progressCb: (totalBytes) => {
          job.progress = {
            phase: "download",
            loadedBytes: Math.trunc(totalBytes),
            totalBytes: job.progress?.totalBytes ?? null,
          };
          const mb = Math.trunc(totalBytes / (5 * 1024 * 1024));
          if (mb > lastLoggedMb) {
            lastLoggedMb = mb;
            job.statusNote = `Downloading ZIP (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)…`;
            saveJob(job, env);
          }
        },
      });
      zipToIngest = dlRes.path;
      job.progress = {
        phase: "download",
        loadedBytes: Math.trunc(dlRes.bytes || 0),
        totalBytes: dlRes.totalBytes,
      };
      appendJobLog(jobId, `Download complete: ${dlRes.bytes} bytes -> ${path.basename(zipToIngest)}`, env);
    }

    if (skipIngest) {
      if (!isDir(sdir)) {
        throw new IntakeError(
          `Series directory ${sdir} is missing, so this job cannot resume without re-importing. Start a new series instead.`,
        );
      }
      // Extension/resume jobs never ingest, so persist their visual choice before the run.
      const jobVisuals = job.visuals || {};
      const background = String(jobVisuals.background || "").trim().toLowerCase();
      const motion = String(jobVisuals.motion || "").trim().toLowerCase();
      if (background || motion) {
        mergeSeriesMetaVisuals(sdir, { background, motion });
        appendJobLog(
          jobId,
          `STAGE visuals: meta.json updated (background=${background || "kept"}, motion=${motion || "kept"})`,
          env,
        );
      }
      // A newly selected TTS voice/provider must reach the extended chapters too:
      // `meta.json` is what the audio stage reads, so persist it under the series lock.
      const jobTtsMeta = job.tts && typeof job.tts.metaTts === "object" && job.tts.metaTts
        ? job.tts.metaTts as Record<string, unknown>
        : null;
      if (jobTtsMeta && Object.keys(jobTtsMeta).length > 0) {
        const changed = withExclusiveSeriesLock(sdir, { seriesRoot: sRoot, nonblocking: true }, () => {
          const metaPath = path.join(sdir, "meta.json");
          if (lexists(metaPath) && fs.lstatSync(metaPath).isSymbolicLink()) {
            throw new IntakeError("Series metadata cannot be a symbolic link");
          }
          if (isFile(metaPath)) {
            const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new IntakeError("Invalid series metadata");
            }
          }
          return mergeSeriesMetaTts(sdir, jobTtsMeta);
        });
        if (changed) {
          appendJobLog(
            jobId,
            `STAGE tts: meta.json updated (engine=${String(jobTtsMeta.engine || "edge")}, `
              + `voice_id=${String(jobTtsMeta.voice_id || "default")})`,
            env,
          );
        }
      }
      const onDisk = existingChapterNumbers(sdir);
      if (onDisk.length === 0) {
        throw new IntakeError(
          `No extracted chapters found under ${sdir}, so this job cannot resume. Start a new series instead.`,
        );
      }
      ingestedNames = onDisk.map((n) => `ch${n}`);
      job.ingestedChapters = ingestedNames;
      job.status = "ingesting";
      job.statusNote = `Resuming: ${ingestedNames.length} chapter(s) already extracted (no re-import)…`;
      appendJobLog(jobId, `STAGE resume: ${ingestedNames.join(", ")} already on disk (no re-import)`, env);
      saveJob(job, env);
    } else {
      job.status = "ingesting";
      job.statusNote = "Validating ZIP archive and extracting chapter pages…";
      job.progress = { phase: "extract" };
      appendJobLog(jobId, `STAGE ingesting: validating ${path.basename(String(zipToIngest))}`, env);
      saveJob(job, env);
      const seriesPreExisted = lexists(sdir);
      if (seriesPreExisted && !job.allowExistingSeries) {
        throw new ConflictError(`Refusing to ingest: target series path ${sdir} already exists (never overwrite)`);
      }
      let layout: string;
      let idx: Record<number, unknown>;
      try {
        const indexed = archiveIndex(String(zipToIngest), true);
        layout = indexed[0];
        idx = indexed[1] as Record<number, unknown>;
      } catch (err) {
        if (err instanceof ZipValidationError || err instanceof SystemExit) throw new IntakeError(String(err.message || err));
        throw err;
      }
      const target = parseChapterSpec(String(job.chapters ?? "all"), idx);
      const valid = target.filter((c) => c in idx);
      if (valid.length === 0) {
        const avail = Object.keys(idx).map(Number).sort((a, b) => a - b).map((c) => `ch${c}`).join(", ");
        throw new IntakeError(
          `No matching chapters found in archive for spec ${pyReprStr(String(job.chapters))} (archive has: ${avail})`,
        );
      }
      createdSeriesDir = !seriesPreExisted;
      const ttsMeta = (job.tts && job.tts.metaTts) || { engine: "edge" };
      const visuals = job.visuals || {};
      let doneNums: number[];
      try {
        doneNums = ingest(slug, {
          chapters: valid,
          force: false,
          zipPath: zipToIngest,
          engine: String(ttsMeta.engine || "edge"),
          voiceId: ttsMeta.voice_id ? String(ttsMeta.voice_id) : null,
          background: String(visuals.background || DEFAULT_BACKGROUND),
          motion: String(visuals.motion || DEFAULT_MOTION),
          interactive: false,
          ttsConfig: ttsMeta,
          title: job.title ? String(job.title) : null,
          seriesRoot: sRoot,
        });
      } catch (err) {
        if (err instanceof ZipValidationError || err instanceof SystemExit) throw new IntakeError(err.message);
        throw err;
      }
      if (!doneNums.length) throw new IntakeError("Ingest extracted 0 chapters from ZIP archive");
      chownTree(sdir, sRoot);
      const allNums = [...new Set([...existingChapterNumbers(sdir), ...doneNums])].sort((a, b) => a - b);
      ingestedNames = allNums.map((n) => `ch${n}`);
      job.ingestedChapters = ingestedNames;
      appendJobLog(
        jobId,
        `Ingest complete (${layout}): ${ingestedNames.join(", ")} (${ingestedNames.length} chapter(s))`,
        env,
      );
      if (cleanupZipAfter && zipToIngest && isFile(zipToIngest)) {
        try {
          fs.unlinkSync(zipToIngest);
          job.stagedZipPath = null;
        } catch {
          // keep the path if unlink fails
        }
      }
    }

    await waitForExternalRuns(job, env, 2, Number.isFinite(maxExtWait) ? maxExtWait : null);
    const [laneOk2, laneWhy2] = renderLaneRecheck(job, env, repoRoot);
    if (!laneOk2) {
      throw new IntakeError(
        `Render lane ${pyReprStr(renderLaneEnv(job, env))} can no longer be used: ${laneWhy2}. ` +
          "Re-enable it in lane settings or start a new job that inherits the global policy.",
      );
    }
    if (job.visuals && typeof job.visuals === "object") {
      withExclusiveSeriesLock(sdir, { seriesRoot: sRoot, nonblocking: true }, () => {
        const metaPath = path.join(sdir, "meta.json");
        if (lexists(metaPath) && fs.lstatSync(metaPath).isSymbolicLink()) {
          throw new IntakeError("Series metadata cannot be a symbolic link");
        }
        const meta = isFile(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new IntakeError("Invalid series metadata");
        const visuals = meta.visuals && typeof meta.visuals === "object" && !Array.isArray(meta.visuals) ? meta.visuals : {};
        const background = String(job.visuals.background || visuals.background || DEFAULT_BACKGROUND).trim().toLowerCase();
        const motion = String(job.visuals.motion || visuals.motion || DEFAULT_MOTION).trim().toLowerCase();
        if (!(BACKGROUNDS as readonly string[]).includes(background) || !(MOTIONS as readonly string[]).includes(motion)) {
          throw new IntakeError("Invalid job background or motion preset");
        }
        if (visuals.background !== background || visuals.motion !== motion) {
          atomicWriteJson(metaPath, { ...meta, visuals: { ...visuals, background, motion } }, sdir);
        }
      });
    }
    let pEnv: Env;
    try {
      pEnv = buildPipelineEnv(repoRoot, env);
    } catch (err) {
      if (err instanceof PreflightError && /environment file missing/i.test(err.message)) pEnv = { ...env };
      else throw err;
    }
    const laneSelector = renderLaneEnv(job, env);
    if (laneSelector !== OVERRIDE_INHERIT) pEnv[RENDER_LANE_ENV] = laneSelector;
    // Per-job render quality wins, then an explicit caller/pipeline value. Never invent
    // one here: downstream stages resolve the persisted Studio setting themselves.
    const jobQuality = job.renderQuality === "720p" || job.renderQuality === "1080p" ? job.renderQuality : null;
    const explicitQuality = (raw: unknown): RenderQuality | null =>
      raw === null || raw === undefined || String(raw).trim() === "" ? null : normalizeRenderQuality(raw);
    const resolvedQuality = jobQuality
      ?? explicitQuality(env.MANHWA_RENDER_QUALITY)
      ?? explicitQuality(pEnv.MANHWA_RENDER_QUALITY);
    if (resolvedQuality) pEnv.MANHWA_RENDER_QUALITY = resolvedQuality;
    else delete pEnv.MANHWA_RENDER_QUALITY;

    let runNames: string[];
    const runChapters = job.runChapters;
    if (Array.isArray(runChapters) && runChapters.length) {
      const runNums = [...new Set(runChapters.map((n: unknown) => Number(n)))].sort((a, b) => a - b);
      runNames = runNums.map((n) => `ch${n}`);
    } else {
      runNames = [...ingestedNames];
    }
    if (runNames.length === 0) throw new IntakeError("No chapters selected to run");
    if (job.onlyUnrendered) {
      runNames = runNames.filter((ch) => {
        try { return fs.statSync(path.join(sdir, "out", ch, "video", "video.mp4")).size === 0; }
        catch { return true; }
      });
      if (!runNames.length) {
        job.status = "completed";
        job.statusNote = "All selected chapters already have videos; no chapters rerun";
        job.endedAt = Date.now() / 1000;
        saveJob(job, env);
        return;
      }
    }

    let cmd: string[];
    if (opts.runCmdOverride && opts.runCmdOverride.length) {
      cmd = [...opts.runCmdOverride, slug, ...runNames, "--video"];
    } else if (env.MANHWA_INTAKE_TEST_RUNNER) {
      cmd = [...shlexSplit(env.MANHWA_INTAKE_TEST_RUNNER), slug, ...runNames, "--video"];
    } else {
      cmd = defaultRunCommand(repoRoot, pEnv, slug, runNames, String(job.chapters ?? "all"), Boolean(runChapters));
    }

    job.status = "running";
    job.statusNote = `Running full pipeline (${runNames.length} chapter(s), video lane on)…`;
    job.progress = { phase: "pipeline", chapter: null, chapterIndex: 0, chapterTotal: runNames.length };
    appendJobLog(jobId, `STAGE running: invoking pipeline for ${slug} (${runNames.join(", ")})`, env);
    saveJob(job, env);

    let lastSave = performance.now();
    let lastErr: string | null = null;
    const proc = spawn(cmd[0]!, cmd.slice(1), {
      cwd: repoRoot,
      env: childEnv(pEnv),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    job.runProcessGroup = proc.pid != null;
    job.runPid = proc.pid ?? null;
    job.runStartTicks = proc.pid ? getProcStartTicks(proc.pid) : null;
    saveJob(job, env);

    const onLine = (rawLine: string) => {
      const clean = sanitizeLine(rawLine, 500);
      if (!clean) return;
      appendJobLog(jobId, clean, env);
      if (clean.includes("FAILED") || clean.includes("!!") || clean.includes("Error")) lastErr = clean;
      if (clean.startsWith("== ch")) {
        job.statusNote = clean;
        const mCh = /^== (ch\d+)/.exec(clean);
        if (mCh && runNames.includes(mCh[1]!)) {
          job.progress = {
            phase: "pipeline",
            chapter: mCh[1],
            chapterIndex: runNames.indexOf(mCh[1]!) + 1,
            chapterTotal: runNames.length,
          };
        }
      }
      const nowM = performance.now();
      if (nowM - lastSave >= 1500) {
        lastSave = nowM;
        saveJob(job, env);
      }
    };
    const rc = await new Promise<number>((resolve, reject) => {
      const bind = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          buf += chunk;
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            onLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
          }
        });
      };
      bind(proc.stdout);
      bind(proc.stderr);
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? 1));
    });
    job.runPid = null;
    job.runStartTicks = null;
    job.endedAt = Date.now() / 1000;
    if (rc === 0) {
      job.status = "completed";
      job.progress = { phase: "done", chapterIndex: runNames.length, chapterTotal: runNames.length };
      job.statusNote = `Completed ${runNames.length} chapter(s).`;
      appendJobLog(jobId, `STAGE completed: pipeline exited 0 for ${slug}`, env);
    } else {
      job.status = "failed";
      job.error = lastErr || `Pipeline run exited with code ${rc}`;
      job.statusNote = `Pipeline failed (exit code ${rc})`;
      appendJobLog(jobId, `STAGE failed: rc=${rc} error=${job.error}`, env);
    }
    saveJob(job, env);
    if (rc === 0 && job.outroConfig?.enabled && !loadJob(jobId, env).stopRequested) {
      try {
        const { generateSeriesOutro } = await import("../player/seriesTools.js");
        await generateSeriesOutro({ seriesRoot: sRoot, slug, ...job.outroConfig, customNote: job.outroConfig.customNote || job.outroConfig.customPrompt });
      } catch (err) {
        // Optional outro failure must never turn completed chapter renders into failed work.
        appendJobLog(jobId, `OUTRO warning: ${sanitizeLine((err as Error).message)}`, env);
      }
    }
  } catch (err) {
    if (cleanupZipAfter && zipToIngest && isFile(zipToIngest)) {
      try {
        fs.unlinkSync(zipToIngest);
        job.stagedZipPath = null;
      } catch {
        // keep going
      }
    }
    if (createdSeriesDir && (job.status === "downloading" || job.status === "ingesting") && isDir(sdir)) {
      if (!lexists(path.join(sdir, "out"))) {
        try {
          fs.rmSync(sdir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
    job.runPid = null;
    job.runStartTicks = null;
    job.endedAt = Date.now() / 1000;
    job.status = "failed";
    job.error = sanitizeLine(err, 400);
    job.statusNote = `Failed: ${job.error}`;
    appendJobLog(jobId, `STAGE failed: ${job.error}`, env);
    saveJob(job, env);
  }
}

function prepareRetryOrContinue(
  job: JobRecord,
  env: Env | undefined,
  requireRecoverable: boolean,
  repoRoot: string,
): void {
  const state = job.status;
  if ((ACTIVE_JOB_STATES as readonly string[]).includes(state) || isPidAlive(job.runPid, job.runStartTicks)) {
    throw new ConflictError(
      `Series ${pyReprStr(job.slug)} already has an active/queued job (${job.id}); wait for it to finish before retrying.`,
    );
  }
  const live = activeConflictFor(String(job.slug), String(job.id), env);
  if (live) {
    throw new ConflictError(
      `Series ${pyReprStr(job.slug)} already has an active/queued job (${live.id}); wait for it to finish before retrying.`,
    );
  }
  const allowed = requireRecoverable ? RECOVERABLE_JOB_STATES : CONTINUABLE_JOB_STATES;
  if (!(allowed as readonly string[]).includes(state)) {
    throw new IntakeError(
      `Job ${job.id} is ${pyReprStr(state)}; this action is only available for ${allowed.join(", ")} jobs.`,
    );
  }
  const [laneOk, laneWhy] = renderLaneRecheck(job, env, repoRoot);
  if (!laneOk) {
    throw new IntakeError(
      `Render lane ${pyReprStr(renderLaneEnv(job, env))} can no longer be used: ${laneWhy}. Re-enable it in lane settings before retrying.`,
    );
  }
}

export function retryJob(
  jobId: string,
  opts: { repoRoot?: string; spawnWorker?: boolean; env?: Env } = {},
): Record<string, unknown> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const job = withJobMetaLock(env, () => {
    reconcileJobs(env);
    const current = loadJob(jobId, env);
    prepareRetryOrContinue(current, env, true, repoRoot);
    const sdir = path.join(seriesRoot(env), String(current.slug));
    const onDisk = existingChapterNumbers(sdir);
    const staged = current.stagedZipPath ? String(current.stagedZipPath) : "";
    const hasZip = Boolean(staged) && isFile(staged);
    const hasSource = hasZip || Boolean(current.gdriveFileId);
    if (onDisk.length === 0 && !hasSource) {
      throw new IntakeError(
        "This job cannot be retried: its source ZIP is gone and no chapter pages exist on disk. Start a new series instead.",
      );
    }
    const archiveIdxCache: { idx?: Record<number, unknown> } = {};
    const retainedArchiveIndex = (): Record<number, unknown> => {
      if (!archiveIdxCache.idx) {
        try {
          archiveIdxCache.idx = archiveIndex(staged, true)[1] as Record<number, unknown>;
        } catch (err) {
          throw new IntakeError(
            `Retry cannot resume: the retained source ZIP is unreadable (${sanitizeLine(err)}). Start a new series instead.`,
          );
        }
      }
      return archiveIdxCache.idx;
    };
    let requested: number[];
    const prevRun = current.runChapters;
    if (Array.isArray(prevRun) && prevRun.length) {
      requested = [...new Set(prevRun.map((n: unknown) => Number(n)))].sort((a, b) => a - b);
    } else {
      let spec: string;
      try {
        spec = validateChaptersSpec(current.chapters);
      } catch (err) {
        throw new IntakeError(
          `Retry cannot resume: this job has an unreadable chapter selection (${sanitizeLine(err)}). Start a new series instead.`,
        );
      }
      if (spec === "all") {
        requested = [...onDisk];
        if (hasZip) {
          requested = [...new Set([...requested, ...Object.keys(retainedArchiveIndex()).map(Number)])].sort((a, b) => a - b);
        }
      } else {
        requested = parseChapterSpec(spec, onDisk);
      }
    }
    const onDiskSet = new Set(onDisk);
    const present = requested.filter((n) => onDiskSet.has(n));
    const missing = requested.filter((n) => !onDiskSet.has(n));
    let resumeNote: string;
    if (onDisk.length && missing.length === 0) {
      current.skipIngest = true;
      current.runChapters = present;
      current.ingestedChapters = onDisk.map((n) => `ch${n}`);
      resumeNote = `Retry queued: resuming ${present.length} of ${onDisk.length} extracted chapter(s) (no re-import)`;
    } else {
      if (!hasSource) {
        const shown = missing.map((n) => `ch${n}`).join(", ") || "none";
        throw new IntakeError(
          `Retry cannot resume: the requested chapter(s) (${shown}) are not extracted under ${sdir} and the source ZIP is gone. Start a new series instead.`,
        );
      }
      if (hasZip && missing.length) {
        const idx = retainedArchiveIndex();
        const unavailable = missing.filter((n) => !(n in idx));
        if (unavailable.length) {
          throw new IntakeError(
            `Retry cannot resume: chapter(s) ${unavailable.map((n) => `ch${n}`).join(", ")} are neither extracted under ${sdir} nor present in the retained source ZIP. Start a new series instead.`,
          );
        }
      }
      current.skipIngest = false;
      current.runChapters = requested.length ? requested : null;
      if (requested.length) current.chapters = requested.join(",");
      if (onDisk.length) current.allowExistingSeries = true;
      resumeNote = missing.length
        ? `Retry queued: re-extracting missing chapter(s) ${missing.map((n) => `ch${n}`).join(", ")} from source`
        : "Retry queued: re-downloading/re-extracting from source";
    }
    resetJobForRerun(current, resumeNote);
    current.retryCount = Number(current.retryCount || 0) + 1;
    current.lastAction = "retry";
    appendJobLog(String(current.id), `RETRY #${current.retryCount}: ${resumeNote}`, env);
    saveJob(current, env);
    return current;
  });
  if (opts.spawnWorker !== false) spawnWorkerIfNeeded(repoRoot, env);
  return publicJobView(job, true, env);
}

export function continueJob(
  jobId: string,
  chapters = "all",
  opts: { repoRoot?: string; spawnWorker?: boolean; env?: Env } = {},
): Record<string, unknown> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const job = withJobMetaLock(env, () => {
    reconcileJobs(env);
    const current = loadJob(jobId, env);
    prepareRetryOrContinue(current, env, false, repoRoot);
    const spec = validateChaptersSpec(chapters);
    const sdir = path.join(seriesRoot(env), String(current.slug));
    if (!isDir(sdir)) {
      throw new IntakeError(
        `Series directory ${sdir} does not exist yet, so there is nothing to continue. Start a new series instead.`,
      );
    }
    const onDisk = existingChapterNumbers(sdir);
    if (onDisk.length === 0) {
      throw new IntakeError(`No extracted chapters found under ${sdir}; this job has not ingested yet. Use retry to resume it.`);
    }
    const staged = current.stagedZipPath ? String(current.stagedZipPath) : "";
    const hasZip = Boolean(staged) && isFile(staged);
    let archiveNums: number[] = [];
    if (hasZip) {
      try {
        archiveNums = Object.keys(archiveIndex(staged, true)[1]).map(Number).sort((a, b) => a - b);
      } catch (err) {
        throw new IntakeError(`Cannot read the staged source ZIP: ${sanitizeLine(err)}`);
      }
    }
    const available = [...new Set([...onDisk, ...archiveNums])].sort((a, b) => a - b);
    const basis = archiveNums.length ? archiveNums : onDisk;
    const wanted = spec === "all" ? [...basis] : parseChapterSpec(spec, basis);
    if (wanted.length === 0) {
      const shown = (archiveNums.length ? archiveNums : onDisk).map((n) => `ch${n}`).join(", ");
      throw new IntakeError(`Chapter selection ${pyReprStr(spec)} matched no chapters. Available: ${shown}`);
    }
    const missingFromDisk = wanted.filter((n) => !onDisk.includes(n));
    if (missingFromDisk.length && !hasZip) {
      throw new IntakeError(
        `Chapter(s) ${missingFromDisk.map((n) => `ch${n}`).join(", ")} are not extracted yet and the source ZIP is no longer available. Start a new series or retry from the original archive.`,
      );
    }
    const absent = wanted.filter((n) => !available.includes(n));
    if (absent.length) {
      const shown = available.map((n) => `ch${n}`).join(", ") || "none";
      throw new IntakeError(
        `Chapter(s) ${absent.map((n) => `ch${n}`).join(", ")} are neither extracted under ${sdir} nor present in the source archive (available: ${shown}). Start a new series or retry from the original archive.`,
      );
    }
    const newNums = wanted.filter((n) => !onDisk.includes(n));
    current.chapters = spec;
    current.runChapters = wanted;
    current.allowExistingSeries = true;
    current.skipIngest = !(newNums.length && hasZip);
    const note = `Continue queued: chapters ${spec} (${newNums.length} new, ${wanted.length - newNums.length} already extracted)`;
    resetJobForRerun(current, note);
    current.lastAction = "continue";
    appendJobLog(String(current.id), note, env);
    saveJob(current, env);
    return current;
  });
  if (opts.spawnWorker !== false) spawnWorkerIfNeeded(repoRoot, env);
  return publicJobView(job, true, env);
}

export function reconcileOrphans(env?: Env, dryRun = false): Record<string, unknown> {
  const e = resolveEnv(env);
  const jdir = jobsDir(e);
  const uploads = path.join(jdir, "uploads");
  if (!isDir(uploads)) return { scanned: 0, removed: [], kept: [], dryRun: Boolean(dryRun) };
  const referenced = new Set<string>();
  if (isDir(jdir)) {
    for (const name of fs.readdirSync(jdir)) {
      if (!name.endsWith(".json")) continue;
      const job = loadJobFile(path.join(jdir, name));
      if (!job) continue;
      if (job.stagedZipPath) referenced.add(path.basename(String(job.stagedZipPath)));
      referenced.add(`${job.id}.zip`);
    }
  }
  const minAge = orphanMinAgeS(e);
  const now = Date.now() / 1000;
  const removed: string[] = [];
  const kept: string[] = [];
  let scanned = 0;
  for (const name of fs.readdirSync(uploads).sort()) {
    const entry = path.join(uploads, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(entry);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!name.endsWith(".zip") && !name.endsWith(".part")) continue;
    scanned += 1;
    if (referenced.has(name)) {
      kept.push(name);
      continue;
    }
    const age = now - st.mtimeMs / 1000;
    if (age < minAge) {
      kept.push(name);
      continue;
    }
    if (!dryRun) {
      try {
        fs.unlinkSync(entry);
      } catch {
        kept.push(name);
        continue;
      }
    }
    removed.push(name);
  }
  return { scanned, removed, kept, dryRun: Boolean(dryRun) };
}

export async function runWorker(opts: WorkerOptions = {}): Promise<{ acquired: boolean; processed: number }> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const jdir = ensureDir(jobsDir(env));
  const lockPath = path.join(jdir, "queue.lock");
  const lockFd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o664);
  matchLockFdOwner(lockFd, lockPath);
  let locked = false;
  try {
    if (!tryFlockFd(lockFd, "ex", true)) return { acquired: false, processed: 0 };
    locked = true;
    reconcileJobs(env);
    try {
      reconcileOrphans(env);
    } catch {
      // orphan sweep must not wedge the queue
    }
    let processed = 0;
    for (;;) {
      const queued: JobRecord[] = [];
      for (const name of fs.readdirSync(jdir)) {
        if (!name.endsWith(".json")) continue;
        const j = loadJobFile(path.join(jdir, name));
        if (j && j.status === "queued" && !laneBlocksJob(j, env)) queued.push(j);
      }
      queued.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      if (queued.length === 0) break;
      const candidateId = String(queued[0]!.id);
      const claimed = withJobMetaLock(env, () => {
        const next = loadJobFile(path.join(jdir, `${candidateId}.json`));
        if (!next || next.status !== "queued" || laneBlocksJob(next, env)) return null;
        next.workerPid = process.pid;
        next.workerStartTicks = getProcStartTicks(process.pid);
        next.startedAt = Date.now() / 1000;
        next.status = next.sourceType === "gdrive" && !next.skipIngest ? "downloading" : "ingesting";
        saveJob(next, env);
        return next;
      });
      if (!claimed) continue;
      await executeSingleJob(claimed, {
        repoRoot,
        env,
        downloadFn: opts.downloadFn,
        runCmdOverride: opts.runCmdOverride,
      });
      processed += 1;
      if (opts.once) break;
    }
    return { acquired: true, processed };
  } finally {
    if (locked) {
      try {
        flockFd(lockFd, "un");
      } catch {
        // close drops it
      }
    }
    try {
      fs.closeSync(lockFd);
    } catch {
      // already closed
    }
  }
}

export function runWorkerOnce(opts: WorkerOptions = {}): Promise<{ acquired: boolean; processed: number }> {
  return runWorker({ ...opts, once: true });
}

export function listJobs(opts: { includeLogs?: boolean; repoRoot?: string; env?: Env } = {}): Record<string, unknown> {
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const jobs = reconcileJobs(env, true);
  spawnWorkerIfNeeded(repoRoot, env);
  return {
    schemaVersion: 1,
    at: Date.now(),
    workerActive: isWorkerLockHeld(env),
    externalRuns: detectActivePipelineRuns(repoRoot),
    capabilities: publicCapabilities(env),
    jobs: jobs.slice(0, 40).map((j) => publicJobView(j, Boolean(opts.includeLogs), env)),
  };
}

export function getJob(jobId: string, opts: { repoRoot?: string; env?: Env } = {}): Record<string, unknown> {
  if (!JOB_ID_RE.test(jobId)) throw new IntakeError("Invalid job ID");
  const env = resolveEnv(opts.env);
  const repoRoot = opts.repoRoot || REPO_ROOT;
  reconcileJobs(env, true);
  spawnWorkerIfNeeded(repoRoot, env);
  const filePath = path.join(jobsDir(env), `${jobId}.json`);
  const job = loadJobFile(filePath) ?? corruptJobRecord(filePath);
  if (!job) throw new IntakeError(`Job not found: ${jobId}`);
  return publicJobView(job, true, env);
}

function argValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : "";
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] || "";
  const rest = argv.slice(1);
  const wantJson = hasFlag(rest, "--json");
  try {
    if (cmd === "catalog") {
      const res = await getCatalog();
      if (wantJson) console.log(JSON.stringify(res));
      else {
        console.log(`Default provider: ${res.defaultProvider}`);
        for (const p of res.providers) {
          const st = p.available ? "READY" : `UNAVAILABLE (${p.unavailableReason})`;
          console.log(`  - ${p.id} [${p.engine}] (${p.label}): ${st}`);
        }
      }
      return 0;
    }
    if (cmd === "enqueue") {
      const res = await enqueueJob({
        title: argValue(rest, "--title"),
        slug: argValue(rest, "--slug"),
        sourceType: argValue(rest, "--source-type") || null,
        gdriveUrl: argValue(rest, "--gdrive-url") || null,
        zipPath: argValue(rest, "--zip-path") || null,
        uploadFilename: argValue(rest, "--upload-filename") || null,
        provider: argValue(rest, "--provider") || "edge",
        voice: argValue(rest, "--voice") || null,
        chapters: argValue(rest, "--chapters") || "all",
        background: argValue(rest, "--background") || DEFAULT_BACKGROUND,
        motion: argValue(rest, "--motion") || DEFAULT_MOTION,
        renderLane: argValue(rest, "--render-lane") || OVERRIDE_INHERIT,
        createdBy: argValue(rest, "--created-by") || "cli",
        spawnWorker: !hasFlag(rest, "--no-spawn"),
      });
      if (wantJson) console.log(JSON.stringify(res));
      else console.log(`Queued job ${res.id} for series '${res.slug}' (${res.title})`);
      return 0;
    }
    if (cmd === "list") {
      const res = listJobs({ includeLogs: hasFlag(rest, "--logs") });
      if (wantJson) console.log(JSON.stringify(res));
      else console.log(`Worker active: ${res.workerActive}`);
      return 0;
    }
    if (cmd === "status") {
      const job = argValue(rest, "--job");
      const res = job ? getJob(job) : listJobs({ includeLogs: true });
      if (wantJson) console.log(JSON.stringify(res));
      return 0;
    }
    if (cmd === "worker") {
      const res = await runWorker({ once: hasFlag(rest, "--once") });
      if (wantJson) console.log(JSON.stringify(res));
      return 0;
    }
    if (cmd === "retry") {
      const res = retryJob(argValue(rest, "--job"), { spawnWorker: !hasFlag(rest, "--no-spawn") });
      if (wantJson) console.log(JSON.stringify(res));
      else console.log(`Retry queued: ${res.id}`);
      return 0;
    }
    if (cmd === "continue") {
      const res = continueJob(argValue(rest, "--job"), argValue(rest, "--chapters") || "all", {
        spawnWorker: !hasFlag(rest, "--no-spawn"),
      });
      if (wantJson) console.log(JSON.stringify(res));
      else console.log(`Continue queued: ${res.id}`);
      return 0;
    }
    if (cmd === "orphans") {
      const res = reconcileOrphans(undefined, hasFlag(rest, "--dry-run"));
      if (wantJson) console.log(JSON.stringify(res));
      else console.log(`Orphan sweep: scanned ${res.scanned}`);
      return 0;
    }
    process.stderr.write("usage: intake.ts catalog|enqueue|list|status|worker|retry|continue|orphans\n");
    return 2;
  } catch (err) {
    if (err instanceof IntakeError) {
      const code = err.statusCode;
      if (wantJson) console.log(JSON.stringify({ error: sanitizeLine(err), statusCode: code }));
      else process.stderr.write(`error: ${sanitizeLine(err)}\n`);
      return code === 409 ? 3 : code === 422 ? 4 : 2;
    }
    if (wantJson) console.log(JSON.stringify({ error: sanitizeLine(err), statusCode: 500 }));
    else process.stderr.write(`unexpected error: ${sanitizeLine(err)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`unexpected error: ${sanitizeLine(err)}\n`);
      process.exit(1);
    },
  );
}
