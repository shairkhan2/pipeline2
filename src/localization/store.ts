/**
 * Durable localization state: per-series manifest, job records, glossary.
 *
 * Everything lives under `<series>/out/languages/`. Reads and writes refuse a
 * symlink in ANY path component (leaf included), persisted identifiers are
 * validated before they become path segments, and artifact paths are never
 * trusted from disk: they are re-derived from the canonical locale layout.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateLocale } from "../config/languages.js";
import { languageChapterDir } from "../config/languages.js";
import type {
  LanguageManifest,
  LocaleArtifact,
  LocaleChapterRecord,
  LocaleChapterStatus,
  LocaleJobProgress,
  LocaleStage,
  LocaleVersionRecord,
  LocalizeJobRecord,
} from "./types.js";

export const MANIFEST_FILENAME = "manifest.json";
export const JOBS_DIRNAME = "jobs";
export const GLOSSARY_FILENAME = "glossary.json";
export const GLOSSARY_AUTO_FILENAME = "glossary.auto.json";
export const JOB_LOCK_FILENAME = ".localize.job.lock";
export const STATE_LOCK_FILENAME = ".localize.state.lock";
export const EXPORT_LOCK_FILENAME = ".export.lock";
export const JOB_ID_RE = /^loc-[0-9]{10,16}-[a-f0-9]{8}$/;
export const CHAPTER_RE = /^ch\d{1,4}$/;
export const MAX_ATTEMPTS = 3;
export const QUEUED_GRACE_MS = 30_000;

const STATUSES: readonly LocaleChapterStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
];
const STAGES: readonly LocaleStage[] = [
  "validate",
  "translate",
  "review",
  "render",
  "verify",
];

export function languagesRoot(sdir: string): string {
  return path.join(path.resolve(sdir), "out", "languages");
}

export function manifestPath(sdir: string): string {
  return path.join(languagesRoot(sdir), MANIFEST_FILENAME);
}

export function jobsDir(sdir: string): string {
  return path.join(languagesRoot(sdir), JOBS_DIRNAME);
}

/** Canonical job file path. The id must already be validated. */
export function jobPath(sdir: string, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new LocalizePathError("Invalid language-version job id", 400);
  }
  return path.join(jobsDir(sdir), `${jobId}.json`);
}

export function jobLockPath(sdir: string): string {
  return path.join(languagesRoot(sdir), JOB_LOCK_FILENAME);
}

export function stateLockPath(sdir: string): string {
  return path.join(languagesRoot(sdir), STATE_LOCK_FILENAME);
}

/** Held while a locale merge or outro render runs; a new language job must wait for it. */
export function exportLockPath(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), EXPORT_LOCK_FILENAME);
}

/** Locale outro root: `<series>/out/languages/<locale>/outro`. */
export function localeOutroDir(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), "outro");
}

/** Locale compilation root: `<series>/out/languages/<locale>/full/video`. */
export function localeFullVideoDir(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), "full", "video");
}

export function glossaryPath(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), GLOSSARY_FILENAME);
}

/** Model-suggested names; never part of the translation cache identity. */
export function glossaryAutoPath(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), GLOSSARY_AUTO_FILENAME);
}

export function previewDir(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), requireLocale(locale), "previews");
}

/** Canonical localized chapter directory (validates locale + chapter id). */
export function canonicalChapterDir(sdir: string, locale: string, ch: string): string {
  const loc = requireLocale(locale);
  if (!CHAPTER_RE.test(ch)) throw new LocalizePathError("Invalid chapter id", 400);
  return languageChapterDir(path.join(path.resolve(sdir), "out"), loc, ch);
}

/** Canonical localized video path (single source of truth for published media). */
export function canonicalVideoPath(sdir: string, locale: string, ch: string): string {
  return path.join(canonicalChapterDir(sdir, locale, ch), "video", "video.mp4");
}

export function newJobId(): string {
  return `loc-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function requireLocale(value: unknown): string {
  const locale = validateLocale(value);
  if (!locale) throw new LocalizePathError("Unsupported locale", 400);
  return locale;
}

/* ------------------------------------------------------------------ *
 * Symlink-safe path helpers
 * ------------------------------------------------------------------ */

export class LocalizePathError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "LocalizePathError";
    this.statusCode = statusCode;
  }
}

/**
 * Refuse a symlink in any existing component of `target`, INCLUDING the leaf.
 * Missing components are fine (the caller creates them under a checked parent).
 */
export function assertNoSymlinks(target: string): void {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new LocalizePathError("Refusing to follow a symbolic link in the language path");
    }
  }
}

/** True when `file` is inside `root` and no component (leaf included) is a link. */
export function isInside(root: string, file: string): boolean {
  const rootAbs = path.resolve(root);
  const fileAbs = path.resolve(file);
  if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + path.sep)) return false;
  try {
    assertNoSymlinks(fileAbs);
  } catch {
    return false;
  }
  return true;
}

/** A regular file whose every path component is a real (non-link) entry. */
export function isRegularFile(file: string): boolean {
  try {
    assertNoSymlinks(file);
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() && st.size > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Atomic JSON
 * ------------------------------------------------------------------ */

export function ensureDir(dir: string): string {
  assertNoSymlinks(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = ensureDir(path.dirname(file));
  assertNoSymlinks(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // renamed already
    }
  }
}

/** Read JSON without following a symlink anywhere in the path. Null when absent/bad. */
export function readJson(file: string): unknown {
  try {
    assertNoSymlinks(file);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

export function emptyManifest(): LanguageManifest {
  return { schemaVersion: 1, locales: {} };
}

function validArtifact(raw: unknown, sdir: string, locale: string, ch: string): LocaleArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  const canonical = canonicalVideoPath(sdir, locale, ch);
  // The stored path is only accepted when it IS the canonical artifact path.
  if (raw.video !== canonical) return undefined;
  const duration = Number(raw.duration);
  const size = Number(raw.size);
  const revision = Number(raw.revision);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  if (!Number.isFinite(size) || size <= 0) return undefined;
  if (!Number.isInteger(revision) || revision < 1) return undefined;
  if (typeof raw.videoSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.videoSha256)) return undefined;
  if (typeof raw.renderKey !== "string" || !raw.renderKey) return undefined;
  if (typeof raw.voice !== "string" || !raw.voice) return undefined;
  const speed = Number(raw.speed);
  if (!Number.isFinite(speed) || speed <= 0) return undefined;
  if (!isIso(raw.publishedAt)) return undefined;
  const artifact: LocaleArtifact = {
    video: canonical,
    duration,
    size,
    videoSha256: raw.videoSha256,
    renderKey: raw.renderKey,
    voice: raw.voice,
    speed,
    revision,
    publishedAt: raw.publishedAt,
  };
  // Older artifacts predate the provider identity; absent is legal (the caller
  // derives it from the catalog) but a present value must be a real string.
  assignIdentity(artifact, raw, locale);
  return artifact;
}

/**
 * Copy the optional provider identity fields when they are non-empty strings.
 * `locale` is always the validated locale of the directory the record lives in:
 * a value from disk never overrides it, so a record can never disagree with its
 * own path.
 */
function assignIdentity(
  target: { engine?: string; provider?: string; modelId?: string; locale?: string },
  raw: Record<string, unknown>,
  locale?: string,
): void {
  for (const key of ["engine", "provider", "modelId"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) target[key] = value.trim();
  }
  if (locale) target.locale = locale;
}

function validChapterRecord(
  raw: unknown,
  sdir: string,
  locale: string,
  ch: string,
): LocaleChapterRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const status = raw.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return undefined;
  if (!isIso(raw.updatedAt)) return undefined;
  const rec: LocaleChapterRecord = {
    status: status as LocaleChapterStatus,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.stage === "string" && (STAGES as readonly string[]).includes(raw.stage)) {
    rec.stage = raw.stage as LocaleStage;
  }
  if (typeof raw.error === "string") rec.error = raw.error;
  if (typeof raw.voice === "string" && raw.voice) rec.voice = raw.voice;
  if (Number.isFinite(Number(raw.speed)) && Number(raw.speed) > 0) rec.speed = Number(raw.speed);
  assignIdentity(rec, raw, locale);
  if (Array.isArray(raw.warnings)) rec.warnings = raw.warnings.map(String);
  if (raw.stale === true) rec.stale = true;
  if (isRecord(raw.translation) && typeof raw.translation.key === "string"
    && typeof raw.translation.scriptHash === "string"
    && Number.isInteger(Number(raw.translation.unitCount))) {
    rec.translation = {
      key: raw.translation.key,
      scriptHash: raw.translation.scriptHash,
      unitCount: Number(raw.translation.unitCount),
      reviewedAt: typeof raw.translation.reviewedAt === "string" ? raw.translation.reviewedAt : "",
    };
  }
  const artifact = validArtifact(raw.artifact, sdir, locale, ch);
  if (artifact) rec.artifact = artifact;
  return rec;
}

export function readManifest(sdir: string): LanguageManifest {
  const raw = readJson(manifestPath(sdir));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.locales)) return emptyManifest();
  const locales: Record<string, LocaleVersionRecord> = {};
  for (const [localeRaw, value] of Object.entries(raw.locales)) {
    const locale = validateLocale(localeRaw);
    if (!locale || !isRecord(value)) continue;
    const chapters: Record<string, LocaleChapterRecord> = {};
    if (isRecord(value.chapters)) {
      for (const [ch, rec] of Object.entries(value.chapters)) {
        if (!CHAPTER_RE.test(ch)) continue;
        const parsed = validChapterRecord(rec, sdir, locale, ch);
        if (parsed) chapters[ch] = parsed;
      }
    }
    locales[locale] = {
      updatedAt: isIso(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
      chapters,
    };
  }
  return { schemaVersion: 1, locales };
}

export function writeManifest(sdir: string, manifest: LanguageManifest): void {
  writeJsonAtomic(manifestPath(sdir), manifest);
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

function validProgress(raw: unknown): Record<string, LocaleJobProgress> {
  const out: Record<string, LocaleJobProgress> = {};
  if (!isRecord(raw)) return out;
  for (const [ch, value] of Object.entries(raw)) {
    if (!CHAPTER_RE.test(ch) || !isRecord(value)) continue;
    const status = value.status;
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) continue;
    out[ch] = {
      status: status as LocaleChapterStatus,
      stage: typeof value.stage === "string" && (STAGES as readonly string[]).includes(value.stage)
        ? (value.stage as LocaleStage)
        : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
      updatedAt: isIso(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
    };
  }
  return out;
}

export function writeJob(sdir: string, job: LocalizeJobRecord): void {
  // Path is derived from the validated id, never from caller data.
  const file = jobPath(sdir, job.id);
  writeJsonAtomic(file, job);
}

/** Optional persisted provider identity on a job record. */
function jobIdentity(
  raw: Record<string, unknown>,
  locale: string,
): { engine?: string; provider?: string; modelId?: string } {
  const out: { engine?: string; provider?: string; modelId?: string } = {};
  const identity: { engine?: string; provider?: string; modelId?: string; locale?: string } = {};
  assignIdentity(identity, raw, locale);
  if (identity.engine) out.engine = identity.engine;
  if (identity.provider) out.provider = identity.provider;
  if (identity.modelId) out.modelId = identity.modelId;
  return out;
}

export function readJob(sdir: string, jobId: string): LocalizeJobRecord | null {
  if (!JOB_ID_RE.test(jobId)) return null;
  const file = jobPath(sdir, jobId);
  const raw = readJson(file);
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  // The record must describe the file it was read from.
  if (raw.id !== jobId) return null;
  if (typeof raw.slug !== "string" || raw.slug !== path.basename(path.resolve(sdir))) return null;
  const locale = validateLocale(raw.locale);
  if (!locale) return null;
  if (!Array.isArray(raw.chapters)) return null;
  const chapters: string[] = [];
  for (const ch of raw.chapters) {
    if (typeof ch !== "string" || !CHAPTER_RE.test(ch)) return null;
    if (!chapters.includes(ch)) chapters.push(ch);
  }
  if (chapters.length === 0) return null;
  const status = raw.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
  const voice = typeof raw.voice === "string" ? raw.voice.trim() : "";
  if (!voice) return null;
  const speed = Number(raw.speed);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) return null;
  if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) return null;
  const attempts: Record<string, number> = {};
  if (isRecord(raw.attempts)) {
    for (const [ch, n] of Object.entries(raw.attempts)) {
      if (!CHAPTER_RE.test(ch)) continue;
      attempts[ch] = Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0;
    }
  }
  return {
    schemaVersion: 1,
    id: jobId,
    slug: raw.slug,
    locale,
    chapters,
    voice,
    speed,
    ...jobIdentity(raw, locale),
    status: status as LocaleChapterStatus,
    stage: typeof raw.stage === "string" && (STAGES as readonly string[]).includes(raw.stage)
      ? (raw.stage as LocaleStage)
      : undefined,
    chapter: typeof raw.chapter === "string" && CHAPTER_RE.test(raw.chapter) ? raw.chapter : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : null,
    pidStart: Number.isInteger(Number(raw.pidStart)) ? Number(raw.pidStart) : null,
    pidBootId: typeof raw.pidBootId === "string" ? raw.pidBootId : null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    attempts,
    progress: validProgress(raw.progress),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : undefined,
    ...(Number.isInteger(raw.autoRetryCount) && Number(raw.autoRetryCount) >= 0
      ? { autoRetryCount: Number(raw.autoRetryCount) }
      : {}),
    ...(raw.nextAutoRetryAt === null
      ? { nextAutoRetryAt: null }
      : isIso(raw.nextAutoRetryAt) ? { nextAutoRetryAt: raw.nextAutoRetryAt } : {}),
  };
}

export function listJobs(sdir: string): LocalizeJobRecord[] {
  const dir = jobsDir(sdir);
  let names: string[];
  try {
    assertNoSymlinks(dir);
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs: LocalizeJobRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = readJob(sdir, name.slice(0, -5));
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return jobs;
}

/* ------------------------------------------------------------------ *
 * Process identity
 * ------------------------------------------------------------------ */

/**
 * `/proc/<pid>/stat` field 22 (starttime), or null when the process is gone, a
 * zombie, or the field is not a plain positive integer.
 */
export function procStartTicks(pid: unknown): number | null {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (rest[0] === "Z") return null;
    const field = rest[19];
    // A malformed/absent starttime must never read as "same process".
    if (typeof field !== "string" || !/^[0-9]{1,18}$/.test(field)) return null;
    const ticks = Number(field);
    return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : null;
  } catch {
    return null;
  }
}

export function procBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: unknown, expectedStart?: unknown, expectedBootId?: string | null): boolean {
  const ticks = procStartTicks(pid);
  if (ticks == null) return false;
  if (expectedStart == null || Number(expectedStart) <= 0) return false;
  if (expectedBootId && expectedBootId !== procBootId()) return false;
  if (expectedStart != null && Number(expectedStart) !== ticks) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Hashing + small helpers
 * ------------------------------------------------------------------ */

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function sha256File(file: string): string {
  assertNoSymlinks(file);
  const h = createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new LocalizePathError("Not a regular file", 400);
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    do {
      n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n > 0) h.update(buf.subarray(0, n));
    } while (n > 0);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return `[${v.map(render).join(",")}]`;
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${render(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return render(value);
}

export function sha256Json(value: unknown): string {
  return sha256Text(stableJson(value));
}

export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function naturalChapterKey(ch: string): number {
  const m = /(\d+)/.exec(ch);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

export function sortChapters(chapters: Iterable<string>): string[] {
  return [...chapters].sort((a, b) => naturalChapterKey(a) - naturalChapterKey(b) || a.localeCompare(b));
}
