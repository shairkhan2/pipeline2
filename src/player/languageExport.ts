/**
 * Language-version export: merge finished locale chapters into one video, add a
 * locale outro, and describe both for the UI.
 *
 * Layout (all under `<series>/out/languages/<locale>/`, never touching English):
 *   full/video/video.mp4   merged compilation (atomic rename from a temp dir)
 *   full/video/merge.json  source signature, so a changed chapter marks it stale
 *   outro/video/video.mp4  locale outro (same panel showcase renderer as English)
 *   outro/outro-plan.json  what the outro was built from (English plan or generated)
 *   outro/translation.json reviewed narration translation cache (no repeat spend)
 *
 * Concurrency: every merge/outro holds the locale export lock (taken inside the
 * language state lock after proving no language job is active) plus a shared
 * series lock. `planLocalizeJob` refuses a new job while the export lock is held.
 */
import fs from "node:fs";
import path from "node:path";

import { acquireSharedSeriesLock, BlockingIOError, releaseSharedSeriesLock } from "../locks/seriesLock.js";
import { catalogEntry, resolveVoice, UnsupportedVoiceError, validateLocale } from "../localization/catalog.js";
import {
  assertNoSymlinks,
  canonicalVideoPath,
  CHAPTER_RE,
  ensureDir,
  isRegularFile,
  languagesRoot,
  listJobs,
  localeFullVideoDir,
  localeOutroDir,
  readJson,
  sha256Text,
  sortChapters,
  writeJsonAtomic,
} from "../localization/store.js";
import type { LanguageChapterView, LocalizeJobRecord } from "../localization/types.js";
import {
  clampLocaleSpeed,
  isRetryableLocalizeError,
  languagesState,
  localeExportActivity,
  localizeSleep,
  LocalizeError,
  MODEL_RETRY_WAIT_MS,
  outroTranslationKey,
  synthesizeLocaleNarration,
  acquireLocaleExportLock,
  translateOutroNarration,
  withStateLock,
} from "../stages/localize.js";
import {
  buildOutroScript,
  concatVideoSegments,
  encodeOutroShowcase,
  inspectSeriesOutro,
  normalizeOutroPanels,
  probeMediaDuration,
  runCheckedCommand,
  videoStreamDuration,
  type OutroOptions,
  type SelectedOutroPanel,
} from "./seriesTools.js";

type Json = Record<string, unknown>;
type HookType = NonNullable<OutroOptions["hookType"]>;

const HOOK_TYPES: readonly HookType[] = ["part2", "next_chapter", "new_series", "custom"];
/** English outro budget (90 s) plus the translate step. */
const DEFAULT_OUTRO_TIMEOUT_MS = 180_000;
const MAX_OUTRO_TIMEOUT_MS = 240_000;
const TRANSLATE_BUDGET_MS = 90_000;
const TTS_BUDGET_MS = 45_000;
const RENDER_BUDGET_MS = 45_000;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readObject(file: string): Json {
  const raw = readJson(file);
  return isRecord(raw) ? raw : {};
}

function chapterNum(ch: string): number {
  return Number.parseInt(ch.slice(2), 10);
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** Strip host paths from a technical error before it reaches the UI. */
function sanitizeDetail(err: unknown, sdir: string): string {
  let raw = err instanceof Error ? err.message : String(err ?? "unknown error");
  raw = raw.split(path.dirname(sdir)).join("<series>");
  raw = raw.replace(/(?:^|\s)\/[^\s,;:'"]+/g, " <path>");
  return raw.replace(/\s+/g, " ").trim().slice(0, 600);
}

function fileSignature(file: string): { size: number; mtimeMs: number } | null {
  try {
    assertNoSymlinks(file);
    const st = fs.lstatSync(file);
    return st.isFile() && st.size > 0 ? { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Paths + URLs
 * ------------------------------------------------------------------ */

function outroPaths(sdir: string, locale: string) {
  const dir = localeOutroDir(sdir, locale);
  return {
    dir,
    videoDir: path.join(dir, "video"),
    video: path.join(dir, "video", "video.mp4"),
    audioDir: path.join(dir, "audio"),
    audio: path.join(dir, "audio", "narration.mp3"),
    plan: path.join(dir, "outro-plan.json"),
    script: path.join(dir, "script.md"),
    translation: path.join(dir, "translation.json"),
  };
}

function fullPaths(sdir: string, locale: string) {
  const dir = localeFullVideoDir(sdir, locale);
  return { dir, video: path.join(dir, "video.mp4"), manifest: path.join(dir, "merge.json") };
}

export function localeFullUrl(slug: string, locale: string): string {
  return `/media/${enc(slug)}/languages/${enc(locale)}/full.mp4`;
}

export function localeOutroUrl(slug: string, locale: string): string {
  return `/media/${enc(slug)}/languages/${enc(locale)}/outro/video.mp4`;
}

function languageWord(locale: string): string {
  const label = catalogEntry(locale)?.label ?? locale;
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lang";
}

/** `ch1-25` for a contiguous run, `ch1-3_7` for a set with gaps, `ch4` for one chapter. */
function chapterSpecLabel(chapters: readonly string[]): string {
  const nums = [...new Set(chapters.map(chapterNum))].filter(Number.isFinite).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    const first = nums[i]!;
    let last = first;
    while (i + 1 < nums.length && nums[i + 1] === last + 1) last = nums[++i]!;
    parts.push(first === last ? String(first) : `${first}-${last}`);
  }
  return `ch${parts.join("_")}`;
}

/** Friendly download name, e.g. `solo-leveling-hindi-ch1-25.mp4`. Only safe characters. */
export function localeMergeFilename(slug: string, locale: string, chapters: readonly string[]): string {
  return `${slug}-${languageWord(locale)}-${chapters.length ? chapterSpecLabel(chapters) : "full"}.mp4`;
}

export function localeOutroFilename(slug: string, locale: string): string {
  return `${slug}-${languageWord(locale)}-outro.mp4`;
}


/* ------------------------------------------------------------------ *
 * Chapter classification
 * ------------------------------------------------------------------ */

function englishRenderedChapters(sdir: string): string[] {
  const out = path.join(sdir, "out");
  let names: string[] = [];
  try {
    names = fs.readdirSync(out);
  } catch {
    return [];
  }
  return sortChapters(names.filter((n) => CHAPTER_RE.test(n) && isRegularFile(path.join(out, n, "video", "video.mp4"))));
}

interface ChapterSets {
  /** Every verified locale video in numeric chapter order: what Merge joins. */
  finished: string[];
  /** Chapters with an English video (or a locale attempt) but no usable locale video. */
  missing: Array<{ chapter: string; reason: string }>;
  /**
   * Subset of `finished` whose video no longer matches its source or settings.
   * Merged anyway, like the English merge joins every rendered chapter; listed so
   * the UI can offer a re-render.
   */
  stale: Array<{ chapter: string; reason: string }>;
}

function classifyChapters(sdir: string, chapters: readonly LanguageChapterView[]): ChapterSets {
  const finished: string[] = [];
  const stale: ChapterSets["stale"] = [];
  const missing: ChapterSets["missing"] = [];
  const seen = new Set<string>();
  for (const view of chapters) {
    seen.add(view.chapter);
    if (!view.videoUrl) {
      const reason = view.status === "running" || view.status === "queued"
        ? "Still rendering."
        : view.status === "failed" || view.status === "interrupted"
          ? "The last attempt failed. Retry this chapter."
          : "No Hindi video yet.";
      missing.push({ chapter: view.chapter, reason });
      continue;
    }
    if (view.stale) {
      stale.push({ chapter: view.chapter, reason: "Made with older settings or source. Merge uses it as is; re-render to update." });
    }
    finished.push(view.chapter);
  }
  for (const ch of englishRenderedChapters(sdir)) {
    if (!seen.has(ch)) missing.push({ chapter: ch, reason: "No Hindi video yet." });
  }
  const order = (a: { chapter: string }, b: { chapter: string }) => chapterNum(a.chapter) - chapterNum(b.chapter);
  return { finished: sortChapters(finished), missing: missing.sort(order), stale: stale.sort(order) };
}

/* ------------------------------------------------------------------ *
 * Outro bookkeeping
 * ------------------------------------------------------------------ */

function englishOutroPlan(sdir: string): Json | null {
  const plan = readObject(path.join(sdir, "out", "outro", "outro-plan.json"));
  if (typeof plan.script !== "string" || !plan.script.trim()) return null;
  if (!Array.isArray(plan.selectedPanels) || plan.selectedPanels.length === 0) return null;
  return plan;
}

function newestCompletedJob(sdir: string, locale: string): LocalizeJobRecord | null {
  let latest: LocalizeJobRecord | null = null;
  for (const job of listJobs(sdir)) {
    if (job.locale === locale && job.status === "completed") latest = job;
  }
  return latest;
}

function activeJob(sdir: string, locale: string): LocalizeJobRecord | null {
  return listJobs(sdir).find((j) => j.locale === locale && (j.status === "running" || j.status === "queued")) ?? null;
}

interface OutroInfo {
  exists: boolean;
  videoUrl: string | null;
  downloadUrl: string | null;
  filename: string;
  duration: number | null;
  voice: string | null;
  speed: number | null;
  engine: string | null;
  /** `english-plan`: panels + narration of the English outro; `generated`: built for this language. */
  source: "english-plan" | "generated" | null;
  generatedAt: string | null;
  script: string | null;
  /** The English outro plan changed after this outro was made. */
  stale: boolean;
  staleReason: string | null;
  hasEnglishPlan: boolean;
  /** Voice/speed a new outro uses when the request names none (newest finished language job). */
  defaultVoice: string | null;
  defaultSpeed: number | null;
}

function outroInfo(sdir: string, slug: string, locale: string): OutroInfo {
  const p = outroPaths(sdir, locale);
  const plan = readObject(p.plan);
  const sig = fileSignature(p.video);
  const exists = Boolean(sig) && typeof plan.generatedAt === "string";
  const english = englishOutroPlan(sdir);
  let stale = false;
  let staleReason: string | null = null;
  if (exists && plan.source === "english-plan") {
    const current = english ? sha256Text(String(english.script)) : null;
    if (!current) {
      stale = true;
      staleReason = "The English outro was removed.";
    } else if (current !== plan.englishScriptHash) {
      stale = true;
      staleReason = "The English outro changed. Generate the Hindi outro again.";
    }
  }
  const job = newestCompletedJob(sdir, locale);
  const rev = sig ? `?rev=${sig.mtimeMs}` : "";
  return {
    exists,
    videoUrl: exists ? `${localeOutroUrl(slug, locale)}${rev}` : null,
    downloadUrl: exists ? `${localeOutroUrl(slug, locale)}?download=1` : null,
    filename: localeOutroFilename(slug, locale),
    duration: exists && typeof plan.duration === "number" ? plan.duration : null,
    voice: exists && typeof plan.voice === "string" ? plan.voice : null,
    speed: exists && typeof plan.speed === "number" ? plan.speed : null,
    engine: exists && typeof plan.engine === "string" ? plan.engine : null,
    source: exists && (plan.source === "english-plan" || plan.source === "generated") ? plan.source : null,
    generatedAt: exists ? String(plan.generatedAt) : null,
    script: exists && typeof plan.script === "string" ? plan.script : null,
    stale,
    staleReason,
    hasEnglishPlan: english !== null,
    defaultVoice: job?.voice ?? null,
    defaultSpeed: job ? job.speed : null,
  };
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface LocaleExportState {
  ok: true;
  slug: string;
  locale: string;
  label: string;
  chapters: ChapterSets;
  canMerge: boolean;
  /** Short human reason when `canMerge` is false. */
  reason: string | null;
  canGenerateOutro: boolean;
  outroReason: string | null;
  busy: { job: boolean; jobId: string | null; merge: boolean; outro: boolean; message: string | null };
  nextMerge: { chapters: string[]; includesOutro: boolean; filename: string };
  merged: {
    exists: boolean;
    url: string | null;
    downloadUrl: string | null;
    filename: string | null;
    chapters: string[];
    includesOutro: boolean;
    sizeBytes: number;
    duration: number | null;
    mergedAt: string | null;
    /** The merged file no longer matches what Merge would produce now. */
    stale: boolean;
    staleReason: string | null;
  };
  outro: OutroInfo & { includedInNextMerge: boolean };
  /** Outcome of the latest background merge / outro run, or null before the first one. */
  lastMerge: ExportOutcome | null;
  lastOutro: ExportOutcome | null;
}

interface MergeSource {
  file: string;
  size: number;
  mtimeMs: number;
}

function mergeSources(sdir: string, locale: string, chapters: readonly string[], withOutro: boolean): MergeSource[] {
  const files = chapters.map((ch) => canonicalVideoPath(sdir, locale, ch));
  if (withOutro) files.push(outroPaths(sdir, locale).video);
  return files.map((file) => {
    const sig = fileSignature(file);
    return { file: path.relative(sdir, file).split(path.sep).join("/"), size: sig?.size ?? 0, mtimeMs: sig?.mtimeMs ?? 0 };
  });
}

export function localeExportState(
  sdir: string,
  slug: string,
  localeRaw: string,
  opts: { includeOutro?: boolean } = {},
): LocaleExportState {
  const locale = validateLocale(localeRaw);
  if (!locale) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  const label = catalogEntry(locale)?.label ?? locale;
  const languages = languagesState(sdir, slug);
  const version = languages.versions.find((v) => v.locale === locale);
  const chapters = classifyChapters(sdir, version?.chapters ?? []);
  const job = activeJob(sdir, locale);
  reconcileLocaleExport(sdir, locale);
  const activity = localeExportActivity(sdir, locale);
  const status = readStatus(sdir, locale);
  const outro = outroInfo(sdir, slug, locale);
  const includesOutro = typeof opts.includeOutro === "boolean" ? opts.includeOutro && outro.exists : outro.exists;

  const busyMessage = job
    ? `${label} chapters are still rendering. Merge and outro unlock when the job finishes.`
    : activity === "merge"
      ? "Merging now. This can take a few minutes."
      : activity === "outro"
        ? `The ${label} outro is being made.`
        : null;

  let reason: string | null = null;
  if (busyMessage) reason = busyMessage;
  else if (!chapters.finished.length) reason = `No finished ${label} chapters yet.`;

  let outroReason: string | null = busyMessage;
  if (!outroReason && !chapters.finished.length) outroReason = `Finish at least one ${label} chapter first.`;
  if (!outroReason && !outro.defaultVoice) outroReason = `Pick a ${label} voice for the outro.`;

  const full = fullPaths(sdir, locale);
  const fullSig = fileSignature(full.video);
  const manifest = readObject(full.manifest);
  const mergedChapters = Array.isArray(manifest.chapters) ? manifest.chapters.map(String).filter((c) => CHAPTER_RE.test(c)) : [];
  const current = mergeSources(sdir, locale, chapters.finished, includesOutro);
  let mergedStale = false;
  let staleReason: string | null = null;
  if (fullSig) {
    const previous = Array.isArray(manifest.sources) ? manifest.sources : null;
    if (!previous) {
      mergedStale = true;
      staleReason = "The merged video has no record of its chapters. Merge again.";
    } else if (JSON.stringify(previous) !== JSON.stringify(current)) {
      mergedStale = true;
      const prevFiles = new Set(previous.map((s) => (isRecord(s) ? String(s.file) : "")));
      const added = current.filter((s) => !prevFiles.has(s.file));
      staleReason = added.length
        ? "New chapters or an outro are ready. Merge again to include them."
        : "A chapter or the outro changed since the merge. Merge again.";
    }
  }

  return {
    ok: true,
    slug,
    locale,
    label,
    chapters,
    canMerge: reason === null,
    reason,
    canGenerateOutro: outroReason === null,
    outroReason,
    busy: { job: Boolean(job), jobId: job?.id ?? null, merge: activity === "merge", outro: activity === "outro", message: busyMessage },
    nextMerge: {
      chapters: chapters.finished,
      includesOutro,
      filename: localeMergeFilename(slug, locale, chapters.finished),
    },
    merged: {
      exists: Boolean(fullSig),
      url: fullSig ? `${localeFullUrl(slug, locale)}?rev=${fullSig.mtimeMs}` : null,
      downloadUrl: fullSig ? `${localeFullUrl(slug, locale)}?download=1` : null,
      filename: fullSig ? localeMergeFilename(slug, locale, mergedChapters) : null,
      chapters: mergedChapters,
      includesOutro: manifest.includesOutro === true,
      sizeBytes: fullSig?.size ?? 0,
      duration: typeof manifest.duration === "number" ? manifest.duration : null,
      mergedAt: typeof manifest.mergedAt === "string" ? manifest.mergedAt : null,
      stale: mergedStale,
      staleReason,
    },
    outro: { ...outro, includedInNextMerge: includesOutro },
    lastMerge: publicOutcome(status.lastMerge),
    lastOutro: publicOutcome(status.lastOutro),
  };
}

function publicOutcome(rec: ExportOutcome | undefined): ExportOutcome | null {
  if (!rec) return null;
  const { pid: _pid, ...rest } = rec;
  return rest;
}

/* ------------------------------------------------------------------ *
 * Locks
 * ------------------------------------------------------------------ */

/*
 * Background export. Cloudflare drops a request with no response headers after
 * 100 s, so the HTTP POST only validates, takes the locks and answers 202; the
 * work then runs in this process, detached from the request (a client
 * disconnect never aborts it). Its outcome lands in `export-status.json`.
 *
 * Restart safety: the export lock is a kernel flock on an open descriptor, so it
 * dies with the process. A status record still saying "running" while nobody
 * holds the lock is therefore a crashed run: it reads as "interrupted", and its
 * temp dirs are removed. Finished files are only ever swapped in by rename, so
 * the previous merged video and outro stay intact.
 */

type ExportKind = "merge" | "outro";

export interface ExportOutcome {
  status: "running" | "done" | "failed" | "interrupted";
  /** Error code for `failed`/`interrupted`, null otherwise. */
  code: string | null;
  /** Short human text for the UI. */
  message: string;
  /** Raw technical cause (paths stripped), for a "details" disclosure. */
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Owner of a running record (for diagnostics; the lock decides liveness). */
  pid?: number;
}

interface ExportStatusFile {
  lastMerge?: ExportOutcome;
  lastOutro?: ExportOutcome;
}

function statusPath(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), locale, "export-status.json");
}

function readStatus(sdir: string, locale: string): ExportStatusFile {
  const raw = readObject(statusPath(sdir, locale));
  const pick = (v: unknown): ExportOutcome | undefined => {
    if (!isRecord(v)) return undefined;
    const status = v.status;
    if (status !== "running" && status !== "done" && status !== "failed" && status !== "interrupted") return undefined;
    return {
      status,
      code: typeof v.code === "string" ? v.code : null,
      message: typeof v.message === "string" ? v.message : "",
      detail: typeof v.detail === "string" ? v.detail : null,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      finishedAt: typeof v.finishedAt === "string" ? v.finishedAt : null,
      ...(Number.isInteger(v.pid) ? { pid: Number(v.pid) } : {}),
    };
  };
  return { lastMerge: pick(raw.lastMerge), lastOutro: pick(raw.lastOutro) };
}

function writeOutcome(sdir: string, locale: string, kind: ExportKind, outcome: ExportOutcome): void {
  const current = readStatus(sdir, locale);
  const next: ExportStatusFile = { ...current, [kind === "merge" ? "lastMerge" : "lastOutro"]: outcome };
  writeJsonAtomic(statusPath(sdir, locale), next);
}

/** Remove temp dirs a crashed run left behind. Only call with no export running. */
function cleanExportTemps(sdir: string, locale: string): void {
  const dirs: Array<[string, string]> = [
    [fullPaths(sdir, locale).dir, ".merge-"],
    [outroPaths(sdir, locale).videoDir, ".outro-"],
  ];
  for (const [dir, prefix] of dirs) {
    let names: string[] = [];
    try {
      assertNoSymlinks(dir);
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

const INTERRUPTED_MESSAGE: Record<ExportKind, string> = {
  merge: "The merge stopped when the server restarted. The previous merged video is unchanged. Merge again.",
  outro: "The outro stopped when the server restarted. The previous outro is unchanged. Generate it again.",
};

/**
 * Turn a "running" record whose run is gone into "interrupted". The check and
 * the write happen inside the language state lock, the same lock a new run takes
 * before it records "running", so a fresh run is never overwritten.
 */
export function reconcileLocaleExport(sdir: string, locale: string): void {
  const status = readStatus(sdir, locale);
  if (status.lastMerge?.status !== "running" && status.lastOutro?.status !== "running") return;
  if (localeExportActivity(sdir, locale)) return;
  try {
    withStateLock(sdir, () => {
      if (localeExportActivity(sdir, locale)) return;
      const fresh = readStatus(sdir, locale);
      for (const kind of ["merge", "outro"] as const) {
        const rec = kind === "merge" ? fresh.lastMerge : fresh.lastOutro;
        if (rec?.status !== "running") continue;
        writeOutcome(sdir, locale, kind, {
          ...rec,
          status: "interrupted",
          code: "interrupted",
          message: INTERRUPTED_MESSAGE[kind],
          detail: rec.pid ? `worker pid ${rec.pid} is gone` : null,
          finishedAt: new Date().toISOString(),
        });
      }
      cleanExportTemps(sdir, locale);
    });
  } catch {
    // Busy state lock: the next poll reconciles.
  }
}

interface ExportRun<T> {
  /** The export state right after the locks were taken (busy flag set). */
  state: LocaleExportState;
  /** Resolves with the result, rejects with a LocalizeError; always records the outcome. */
  done: Promise<T>;
}

let beforeRunHook: ((kind: ExportKind) => Promise<void>) | null = null;
const runningExports = new Set<Promise<unknown>>();

/** Test seam: awaited at the start of each background run (hold it busy, simulate slowness). */
export function _setExportRunHookForTests(fn: ((kind: ExportKind) => Promise<void>) | null): void {
  beforeRunHook = fn;
}

/** Test seam: settle every background run started so far. */
export async function _settleExportsForTests(): Promise<void> {
  await Promise.allSettled([...runningExports]);
}

/**
 * Take the export lock and the shared series lock, run `precheck` (errors there
 * reach the caller as their own HTTP status), then start `work` in the
 * background. Locks are released only when `work` settles.
 */
function startExport<T>(
  sdir: string,
  slug: string,
  locale: string,
  kind: ExportKind,
  precheck: () => void,
  work: () => Promise<T>,
  successMessage: (result: T) => string,
): ExportRun<T> {
  const startedAt = new Date().toISOString();
  let previous: ExportOutcome | undefined;
  const releaseExport = acquireLocaleExportLock(sdir, locale, kind, () => new Date(), () => {
    const before = readStatus(sdir, locale);
    previous = kind === "merge" ? before.lastMerge : before.lastOutro;
    // A crashed run's "running" record must not be restored as if it were live.
    if (previous?.status === "running") {
      previous = { ...previous, status: "interrupted", code: "interrupted", message: INTERRUPTED_MESSAGE[kind], finishedAt: startedAt };
    }
    // Inside the state lock with the export lock held: no reconcile can race this.
    cleanExportTemps(sdir, locale);
    writeOutcome(sdir, locale, kind, {
      status: "running", code: null, message: kind === "merge" ? "Merging now." : "Making the outro.",
      detail: null, startedAt, finishedAt: null, pid: process.pid,
    });
  });
  const restore = (previous: ExportOutcome | undefined) => {
    try {
      const status = readStatus(sdir, locale);
      const next: ExportStatusFile = { ...status, [kind === "merge" ? "lastMerge" : "lastOutro"]: previous };
      writeJsonAtomic(statusPath(sdir, locale), next);
    } catch {
      // A leftover "running" record reads as interrupted once the lock is free.
    }
  };
  let seriesLock: string | null;
  try {
    seriesLock = acquireSharedSeriesLock(sdir, { nonblocking: true, seriesRoot: path.dirname(sdir) });
  } catch (err) {
    restore(previous);
    releaseExport();
    if (err instanceof BlockingIOError) {
      throw new LocalizeError("The series is busy with an English merge or edit. Try again shortly.", 409, "series_busy");
    }
    throw err;
  }
  const releaseAll = () => {
    if (seriesLock) releaseSharedSeriesLock(seriesLock);
    seriesLock = null;
    releaseExport();
  };
  let state: LocaleExportState;
  try {
    precheck();
    state = localeExportState(sdir, slug, locale);
  } catch (err) {
    // Nothing ran: put back the previous outcome instead of a fake failure.
    restore(previous);
    releaseAll();
    throw err;
  }
  const done = (async () => {
    try {
      if (beforeRunHook) await beforeRunHook(kind);
      const result = await work();
      writeOutcome(sdir, locale, kind, {
        status: "done", code: null, message: successMessage(result), detail: null,
        startedAt, finishedAt: new Date().toISOString(),
      });
      return result;
    } catch (raw) {
      const err = raw instanceof LocalizeError
        ? raw
        : new LocalizeError(
          kind === "merge" ? "The merge failed. The previous merged video is unchanged." : "The outro failed. The previous outro is unchanged.",
          500, kind === "merge" ? "merge_failed" : "outro_failed", sanitizeDetail(raw, sdir));
      try {
        writeOutcome(sdir, locale, kind, {
          status: "failed", code: err.code, message: err.message, detail: err.detail ?? null,
          startedAt, finishedAt: new Date().toISOString(),
        });
      } catch {
        // The lock is released below; the GET then reports the run as interrupted.
      }
      throw err;
    } finally {
      releaseAll();
    }
  })();
  runningExports.add(done);
  void done.then(() => runningExports.delete(done), () => runningExports.delete(done));
  return { state, done };
}


/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

const SPACE_MARGIN = 1.05;

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Fail fast when the disk cannot hold the new merged file next to the old one
 * (the temp file is renamed over it only at the end). A chapter is ~190 MB, so
 * a 100-chapter merge is ~19 GB; discovering that mid-ffmpeg wastes minutes.
 */
function assertMergeFits(dir: string, sources: readonly string[]): void {
  let needed = 0;
  for (const file of sources) needed += fs.statSync(file).size;
  needed = Math.ceil(needed * SPACE_MARGIN);
  let free: number;
  try {
    const st = fs.statfsSync(dir);
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    return; // Cannot tell: let the merge try.
  }
  if (free < needed) {
    throw new LocalizeError(
      `Not enough disk space to merge: about ${gigabytes(needed)} needed, ${gigabytes(free)} free. Free some space and try again.`,
      507, "insufficient_space");
  }
}

export interface LocaleMergeResult { duration: number; sizeBytes: number; copied: boolean }

/**
 * Start a merge in the background. Throws (with its HTTP status) for anything
 * detectable up front; otherwise returns the busy state and a `done` promise.
 */
export function startLocaleMerge(
  sdir: string,
  slug: string,
  localeRaw: string,
  opts: { includeOutro?: boolean } = {},
): ExportRun<LocaleMergeResult> {
  const locale = validateLocale(localeRaw);
  if (!locale) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  if (opts.includeOutro !== undefined && typeof opts.includeOutro !== "boolean") {
    throw new LocalizeError("includeOutro must be true or false", 400, "invalid_include_outro");
  }
  reconcileLocaleExport(sdir, locale);
  let plan: { state: LocaleExportState; sources: string[]; signature: MergeSource[] } | null = null;
  return startExport(sdir, slug, locale, "merge", () => {
    // Re-read under the lock: a chapter may have finished since the last GET.
    const state = localeExportState(sdir, slug, locale, opts);
    if (!state.chapters.finished.length) {
      // `state.reason` would read "Merging now" here: this request holds the lock.
      throw new LocalizeError(`No finished ${state.label} chapters yet.`, 409, "nothing_to_merge");
    }
    if (opts.includeOutro === true && !state.outro.exists) {
      throw new LocalizeError(`Generate the ${state.label} outro first, or merge without it.`, 409, "outro_missing");
    }
    const sources = state.chapters.finished.map((ch) => canonicalVideoPath(sdir, locale, ch));
    if (state.nextMerge.includesOutro) sources.push(outroPaths(sdir, locale).video);
    for (const file of sources) {
      if (!isRegularFile(file)) {
        throw new LocalizeError("A chapter video disappeared during the merge. Refresh and try again.", 409, "source_missing");
      }
    }
    const full = fullPaths(sdir, locale);
    ensureDir(full.dir);
    assertNoSymlinks(full.video);
    assertNoSymlinks(full.manifest);
    assertMergeFits(full.dir, sources);
    plan = { state, sources, signature: mergeSources(sdir, locale, state.chapters.finished, state.nextMerge.includesOutro) };
  }, () => runMerge(sdir, locale, plan!), (r) => {
    const n = plan!.state.chapters.finished.length;
    return `Merged ${n} chapter${n === 1 ? "" : "s"}${plan!.state.nextMerge.includesOutro ? " and the outro" : ""}.`
      + (r.copied ? "" : " Streams differed, so it was re-encoded.");
  });
}

/** Merge and wait for it (CLI, scripts, tests). The HTTP route uses `startLocaleMerge`. */
export async function mergeLocaleChapters(
  sdir: string,
  slug: string,
  localeRaw: string,
  opts: { includeOutro?: boolean } = {},
): Promise<LocaleExportState & { result: LocaleMergeResult }> {
  const run = startLocaleMerge(sdir, slug, localeRaw, opts);
  const result = await run.done;
  return { ...localeExportState(sdir, slug, run.state.locale, opts), result };
}

async function runMerge(
  sdir: string,
  locale: string,
  plan: { state: LocaleExportState; sources: string[]; signature: MergeSource[] },
): Promise<LocaleMergeResult> {
  const { state, sources, signature } = plan;
  {
    const full = fullPaths(sdir, locale);
    const temp = fs.mkdtempSync(path.join(full.dir, ".merge-"));
    try {
      const tempOut = path.join(temp, "video.mp4");
      let joined: Awaited<ReturnType<typeof concatVideoSegments>>;
      try {
        joined = await concatVideoSegments(sources, temp, tempOut, { compareExtradata: true });
      } catch (err) {
        const detail = sanitizeDetail(err, sdir);
        if (/no space left|ENOSPC/i.test(detail)) {
          throw new LocalizeError("The disk filled up during the merge. The previous merged video is unchanged.", 507, "insufficient_space", detail);
        }
        throw new LocalizeError("The chapter videos could not be joined.", 422, "merge_failed", detail);
      }
      const manifest = {
        schemaVersion: 1,
        locale,
        chapters: state.chapters.finished,
        includesOutro: state.nextMerge.includesOutro,
        missing: state.chapters.missing.map((m) => m.chapter),
        staleIncluded: state.chapters.stale.map((m) => m.chapter),
        sources: signature,
        duration: joined.duration,
        copied: joined.copied,
        mergedAt: new Date().toISOString(),
      };
      const tempManifest = path.join(temp, "merge.json");
      fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      // Video first, then its manifest: a crash in between reads as stale, never as fresh.
      fs.renameSync(tempOut, full.video);
      fs.renameSync(tempManifest, full.manifest);
      return { duration: joined.duration, sizeBytes: joined.sizeBytes, copied: joined.copied };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Outro
 * ------------------------------------------------------------------ */

export interface LocaleOutroInput {
  voice?: string;
  speed?: number;
  hookType?: string;
  totalChapters?: number;
  coveredChapters?: number;
  customNote?: string;
  nextSeriesTitle?: string;
  /** Overall deadline (default: English 90 s budget + 90 s translate). */
  timeoutMs?: number;
}

interface EncodeProfile {
  width: number;
  height: number;
  fps: number | string;
  videoArgs: string[];
  audioArgs: string[];
}

/** Encode the outro like the chapter videos so the merge can stream-copy. */
async function chapterEncodeProfile(file: string): Promise<EncodeProfile> {
  const raw = await runCheckedCommand(["ffprobe", "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,time_base,color_space,color_range,chroma_location,sample_rate,channels",
    "-of", "json", file], 15_000);
  const streams = (JSON.parse(raw) as { streams?: Json[] }).streams ?? [];
  const v = streams.find((s) => s.codec_type === "video") ?? {};
  const a = streams.find((s) => s.codec_type === "audio") ?? {};
  const width = Number(v.width) || 1920;
  const height = Number(v.height) || 1080;
  const fps = typeof v.r_frame_rate === "string" && /^\d+\/\d+$/.test(v.r_frame_rate) ? v.r_frame_rate : 30;
  const known = (val: unknown) => typeof val === "string" && /^[a-z0-9_]+$/i.test(val) && val !== "unknown";
  const videoArgs = ["-c:v", "libx264", "-crf", "18"];
  if (known(v.pix_fmt)) videoArgs.push("-pix_fmt", String(v.pix_fmt));
  else videoArgs.push("-pix_fmt", "yuv420p");
  if (known(v.color_space)) videoArgs.push("-colorspace", String(v.color_space));
  if (known(v.color_range)) videoArgs.push("-color_range", String(v.color_range));
  if (known(v.chroma_location)) videoArgs.push("-chroma_sample_location", String(v.chroma_location));
  const tb = typeof v.time_base === "string" ? /^1\/(\d+)$/.exec(v.time_base) : null;
  if (tb) videoArgs.push("-video_track_timescale", tb[1]!);
  const audioArgs = ["-c:a", "aac", "-ar", String(Number(a.sample_rate) || 48000), "-ac", String(Number(a.channels) || 2)];
  return { width, height, fps, videoArgs, audioArgs };
}

export const __chapterEncodeProfileForTests = chapterEncodeProfile;

/** Run `fn` once more on a transient provider error, inside the remaining budget. */
async function withOneRetry<T>(fn: () => Promise<T>, remaining: () => number): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const wait = MODEL_RETRY_WAIT_MS[0];
    if (!isRetryableLocalizeError(err) || remaining() < wait + 1_000) throw err;
    await localizeSleep(wait);
    return fn();
  }
}

function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, message: string, code: string): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new LocalizeError(message, 504, code);
      controller.abort(err);
      reject(err);
    }, Math.max(50, ms));
    fn(controller.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function positiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > 5000) {
    throw new LocalizeError(`${name} must be a whole number between 0 and 5000`, 400, "invalid_outro_field");
  }
  return raw as number;
}

export interface LocaleOutroResult {
  duration: number;
  source: "english-plan" | "generated";
  warnings: string[];
  translationReused: boolean;
  narrationReused: boolean;
}

/** Start an outro render in the background (validation and locks happen now). */
export function startLocaleOutro(
  sdir: string,
  slug: string,
  localeRaw: string,
  input: LocaleOutroInput = {},
): ExportRun<LocaleOutroResult> {
  const locale = validateLocale(localeRaw);
  if (!locale) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  const label = catalogEntry(locale)?.label ?? locale;

  // Voice/speed: request override (validated exactly like the job POST), else the newest finished job.
  const job = newestCompletedJob(sdir, locale);
  const voiceId = typeof input.voice === "string" && input.voice.trim() ? input.voice.trim() : job?.voice;
  if (!voiceId) throw new LocalizeError(`Pick a ${label} voice for the outro.`, 400, "missing_voice");
  let resolved: ReturnType<typeof resolveVoice>;
  try {
    resolved = resolveVoice(locale, voiceId);
  } catch (err) {
    if (err instanceof UnsupportedVoiceError) throw new LocalizeError(err.message, err.statusCode, err.code);
    throw err;
  }
  const speed = clampLocaleSpeed(input.speed ?? job?.speed ?? 1);

  const overrides = input.hookType !== undefined || input.totalChapters !== undefined
    || input.coveredChapters !== undefined || input.customNote !== undefined || input.nextSeriesTitle !== undefined;
  if (input.hookType !== undefined && !HOOK_TYPES.includes(input.hookType as HookType)) {
    throw new LocalizeError("Invalid outro hookType", 400, "invalid_outro_field");
  }
  if (input.hookType === "custom" && !(typeof input.customNote === "string" && input.customNote.trim())) {
    throw new LocalizeError("customNote is required for a custom outro", 400, "invalid_outro_field");
  }

  const totalMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
    ? Math.min(MAX_OUTRO_TIMEOUT_MS, Math.trunc(input.timeoutMs))
    : Math.min(MAX_OUTRO_TIMEOUT_MS, Number(process.env.MANHWA_LOCALE_OUTRO_TIMEOUT_MS) || DEFAULT_OUTRO_TIMEOUT_MS);

  if (input.totalChapters !== undefined) positiveInt(input.totalChapters, 0, "totalChapters");
  if (input.coveredChapters !== undefined) positiveInt(input.coveredChapters, 0, "coveredChapters");
  if (typeof input.totalChapters === "number" && typeof input.coveredChapters === "number"
    && input.totalChapters < input.coveredChapters) {
    throw new LocalizeError("totalChapters cannot be smaller than coveredChapters", 400, "invalid_outro_field");
  }

  reconcileLocaleExport(sdir, locale);
  let firstChapter = "";
  return startExport(sdir, slug, locale, "outro", () => {
    const state = localeExportState(sdir, slug, locale);
    const first = state.chapters.finished[0];
    if (!first) throw new LocalizeError(`Finish at least one ${label} chapter first.`, 409, "nothing_to_merge");
    firstChapter = first;
  }, async () => {
    const deadline = Date.now() + totalMs;
    const remaining = () => deadline - Date.now();
    const budget = (max: number, label2: string) => {
      const rem = remaining();
      if (rem <= 100) throw new LocalizeError(`${label} outro took too long (${label2}). Try again.`, 504, "outro_timeout");
      return Math.min(max, rem);
    };
    const state = localeExportState(sdir, slug, locale);

    // 1. Panels + English narration: the English outro plan when there is one, else
    //    the same read-only panel selection and script template, written only here.
    const english = overrides ? null : englishOutroPlan(sdir);
    let panels: SelectedOutroPanel[];
    let englishScript: string;
    let source: "english-plan" | "generated";
    let planMeta: Json = {};
    if (english) {
      panels = (english.selectedPanels as unknown[]).filter(isRecord) as unknown as SelectedOutroPanel[];
      englishScript = String(english.script);
      source = "english-plan";
      planMeta = {
        hookType: english.hookType ?? null,
        totalChapters: english.totalChapters ?? null,
        coveredChapters: english.coveredChapters ?? null,
      };
    } else {
      const inspected = inspectSeriesOutro({ seriesRoot: path.dirname(sdir), slug });
      if (!inspected.selectedPanels.length) {
        throw new LocalizeError("No usable panels for an outro in this series.", 422, "outro_no_panels");
      }
      const covered = positiveInt(input.coveredChapters, state.chapters.finished.length, "coveredChapters");
      const total = positiveInt(input.totalChapters, Math.max(covered, inspected.availableChapters.length), "totalChapters");
      if (total < covered) throw new LocalizeError("totalChapters cannot be smaller than coveredChapters", 400, "invalid_outro_field");
      const hookType = (input.hookType as HookType | undefined) ?? "part2";
      panels = inspected.selectedPanels;
      englishScript = buildOutroScript({
        title: inspected.title,
        characters: inspected.characters,
        coveredChapters: covered,
        totalChapters: total,
        hookType,
        customNote: input.customNote,
        nextSeriesTitle: input.nextSeriesTitle,
      });
      source = "generated";
      planMeta = { hookType, totalChapters: total, coveredChapters: covered };
    }

    const p = outroPaths(sdir, locale);
    for (const target of [p.dir, p.videoDir, p.video, p.audioDir, p.audio, p.plan, p.script, p.translation]) {
      assertNoSymlinks(target);
    }
    ensureDir(p.videoDir);

    // 2. Translate (cached by identity, so a TTS failure never repays the writer lane).
    const key = outroTranslationKey(sdir, locale, englishScript);
    const cached = readObject(p.translation);
    let translatedText: string;
    let translatedScript: string;
    let warnings: string[] = [];
    let translationReused = false;
    if (cached.key === key && typeof cached.text === "string" && cached.text.trim() && typeof cached.script === "string") {
      translatedText = cached.text;
      translatedScript = cached.script;
      translationReused = true;
    } else {
      let translated: Awaited<ReturnType<typeof translateOutroNarration>>;
      try {
        translated = await withOneRetry(
          () => bounded(() => translateOutroNarration(sdir, locale, englishScript), budget(TRANSLATE_BUDGET_MS, "translation"),
            `${label} outro translation took too long. Try again.`, "outro_timeout"),
          remaining,
        );
      } catch (err) {
        if (err instanceof LocalizeError && err.code === "outro_timeout") throw err;
        throw new LocalizeError(`The ${label} outro narration could not be translated. The previous outro is unchanged.`,
          502, "outro_translate_failed", sanitizeDetail(err, sdir));
      }
      translatedText = translated.text;
      translatedScript = translated.translatedScript;
      warnings = translated.warnings;
      writeJsonAtomic(p.translation, { key, text: translatedText, script: translatedScript, englishScript, translatedAt: new Date().toISOString() });
    }

    const tempDir = fs.mkdtempSync(path.join(p.videoDir, ".outro-"));
    try {
      const profile = await chapterEncodeProfile(canonicalVideoPath(sdir, locale, firstChapter));
      const { normalizedPanels, usablePanels } = await normalizeOutroPanels(
        sdir, panels, tempDir, () => { budget(1_000, "panels"); });

      // 3. Narration. A TTS failure fails clearly (no silent Hindi outro) and keeps the old one.
      //    The narration is cached by its inputs, so a retry after a render failure, or a
      //    regenerate with nothing changed, never pays the TTS provider twice.
      const tmpAudio = path.join(tempDir, "narration.mp3");
      const audioKey = sha256Text(JSON.stringify({
        v: 1, locale, engine: resolved.engine, voice: resolved.voice.id, speed, text: translatedText,
      }));
      const audioKeyFile = path.join(p.audioDir, "narration.key");
      let audioReused = false;
      try {
        if (isRegularFile(p.audio) && fs.readFileSync(audioKeyFile, "utf8").trim() === audioKey) {
          fs.copyFileSync(p.audio, tmpAudio);
          audioReused = true;
        }
      } catch {
        audioReused = false;
      }
      try {
        if (!audioReused) {
          await withOneRetry(async () => {
            fs.rmSync(tmpAudio, { force: true });
            await bounded((signal) => synthesizeLocaleNarration({
              text: translatedText, dest: tmpAudio, locale, engine: resolved.engine, voice: resolved.voice.id, speed, signal,
            }), budget(TTS_BUDGET_MS, "narration"), `${label} outro narration took too long. Try again.`, "outro_timeout");
          }, remaining);
        }
      } catch (err) {
        if (err instanceof LocalizeError && err.code === "outro_timeout") throw err;
        throw new LocalizeError(`The ${label} outro narration failed. The previous outro is unchanged.`,
          502, "outro_tts_failed", sanitizeDetail(err, sdir));
      }
      const audioDuration = isRegularFile(tmpAudio) ? await probeMediaDuration(tmpAudio, Math.min(10_000, budget(10_000, "narration check"))) : null;
      if (!audioDuration || audioDuration > 300) {
        throw new LocalizeError(`The ${label} outro narration was empty or too long. The previous outro is unchanged.`,
          502, "outro_tts_failed", `narration duration ${audioDuration ?? "unreadable"}`);
      }

      if (!audioReused) {
        // Key removed first, written last: a crash in between never pairs new audio with an old key.
        ensureDir(p.audioDir);
        for (const target of [p.audio, audioKeyFile]) assertNoSymlinks(target);
        fs.rmSync(audioKeyFile, { force: true });
        const stagedAudio = path.join(p.audioDir, `.narration.${process.pid}.tmp`);
        fs.copyFileSync(tmpAudio, stagedAudio);
        fs.renameSync(stagedAudio, p.audio);
        fs.writeFileSync(audioKeyFile, `${audioKey}\n`);
      }

      // 4. Render with the English panel-showcase renderer, encoded like the chapters.
      let tempVideo: string;
      try {
        tempVideo = await encodeOutroShowcase(normalizedPanels, tmpAudio, audioDuration, tempDir,
          budget(RENDER_BUDGET_MS, "render"),
          profile);
      } catch (err) {
        if (err instanceof LocalizeError && err.code === "outro_timeout") throw err;
        throw new LocalizeError(`The ${label} outro video could not be rendered. The previous outro is unchanged.`,
          422, "outro_render_failed", sanitizeDetail(err, sdir));
      }
      const videoDuration = isRegularFile(tempVideo) ? await probeMediaDuration(tempVideo, Math.min(10_000, budget(10_000, "verify"))) : null;
      const pictureDuration = videoDuration ? await videoStreamDuration(tempVideo, Math.min(10_000, budget(10_000, "verify"))) : null;
      if (!videoDuration || !pictureDuration || pictureDuration < audioDuration - 0.5) {
        throw new LocalizeError(`The ${label} outro video could not be rendered. The previous outro is unchanged.`,
          422, "outro_render_failed",
          `rendered outro picture ${pictureDuration?.toFixed(2) ?? "unreadable"}s vs narration ${audioDuration.toFixed(2)}s`);
      }

      // 5. Commit: every file renamed into place; the plan goes last and marks it complete.
      budget(100, "commit");
      const plan = {
        schemaVersion: 1,
        slug,
        locale,
        source,
        ...planMeta,
        englishScript,
        englishScriptHash: sha256Text(englishScript),
        script: translatedText,
        voice: resolved.voice.id,
        speed,
        engine: resolved.engine,
        provider: resolved.provider,
        modelId: resolved.modelId,
        selectedPanels: usablePanels,
        duration: videoDuration,
        warnings,
        generatedAt: new Date().toISOString(),
      };
      const tmpPlan = path.join(tempDir, "outro-plan.json");
      const tmpScript = path.join(tempDir, "script.md");
      fs.writeFileSync(tmpPlan, `${JSON.stringify(plan, null, 2)}\n`);
      fs.writeFileSync(tmpScript, translatedScript);
      for (const target of [p.video, p.plan, p.script]) assertNoSymlinks(target);
      fs.renameSync(tempVideo, p.video);
      fs.renameSync(tmpScript, p.script);
      fs.renameSync(tmpPlan, p.plan);
      return { duration: videoDuration, source, warnings, translationReused, narrationReused: audioReused };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, (r) => `${label} outro ready (${r.duration.toFixed(1)} s).`);
}

/** Generate the outro and wait for it (scripts, tests). The HTTP route uses `startLocaleOutro`. */
export async function generateLocaleOutro(
  sdir: string,
  slug: string,
  localeRaw: string,
  input: LocaleOutroInput = {},
): Promise<LocaleExportState & { result: LocaleOutroResult }> {
  const run = startLocaleOutro(sdir, slug, localeRaw, input);
  const result = await run.done;
  return { ...localeExportState(sdir, slug, run.state.locale), result };
}

/* ------------------------------------------------------------------ *
 * Media resolution
 * ------------------------------------------------------------------ */

/** Merged locale video, or null. Only the canonical path, never a link. */
export function resolveLocaleFullVideo(sdir: string, locale: string): { file: string; chapters: string[] } | null {
  const loc = validateLocale(locale);
  if (!loc) return null;
  const full = fullPaths(sdir, loc);
  if (!full.video.startsWith(languagesRoot(sdir) + path.sep) || !isRegularFile(full.video)) return null;
  const manifest = readObject(full.manifest);
  const chapters = Array.isArray(manifest.chapters) ? manifest.chapters.map(String).filter((c) => CHAPTER_RE.test(c)) : [];
  return { file: full.video, chapters };
}

/** Locale outro video, or null while it is missing or its plan is incomplete. */
export function resolveLocaleOutroVideo(sdir: string, locale: string): string | null {
  const loc = validateLocale(locale);
  if (!loc) return null;
  const p = outroPaths(sdir, loc);
  if (!isRegularFile(p.video) || !isRegularFile(p.plan)) return null;
  return p.video;
}
