/**
 * Language-version HTTP routes for the Screening Room player.
 *
 * Contract:
 *   GET  /api/series/:slug/languages
 *        -> { ok:true, slug, catalog[], sourceChapters[], versions[] }
 *   POST /api/series/:slug/languages
 *        body { locale, chapters:'1'|'1-3'|'1,3'|'all', voice, speed? }
 *        -> 202 with the same state shape (rendering continues in a CLI job)
 *   POST /api/series/:slug/languages/preview
 *        body { locale, voice, speed? } -> { ok:true, url }
 *   GET|HEAD /media/:slug/languages/:locale/:ch/video.mp4[?download=1]
 *   GET      /media/:slug/languages/:locale/preview/:id.mp3
 *
 * Security: persistent (non-temporary) account + CSRF for POSTs, only the
 * documented fields, every path validated without following a symlink, and
 * only verified artifacts are served.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_LANE_CONFIG_BODY_BYTES, readJsonBody, verifyCsrf } from "./lanes.js";
import type { LaneSession, SendJson } from "./lanes.js";
import { streamFile } from "./stream.js";
import { validateLocale } from "../config/languages.js";
import {
  LocalizeError,
  availableChapters,
  dropAutoRetry,
  dueAutoRetries,
  generateLanguagePreview,
  languagesState,
  parseChapterSelection,
  planLocalizeJob,
  reconcileLocalizeJobs,
  resolveLocaleVideo,
  resolvePreviewFile,
  seriesDir,
  unfinishedChapters,
  type PlanLocalizeInput,
} from "../stages/localize.js";
import { jobsDir as languageJobsDir, readJob, writeJob } from "../localization/store.js";
import {
  localeExportState,
  localeMergeFilename,
  localeOutroFilename,
  startLocaleMerge,
  startLocaleOutro,
  resolveLocaleFullVideo,
  resolveLocaleOutroVideo,
} from "./languageExport.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MAX_LANGUAGES_BODY_BYTES = MAX_LANE_CONFIG_BODY_BYTES;

export type JobSpawner = (sdir: string, jobId: string) => void;

let spawner: JobSpawner | null = null;

export function _setJobSpawnerForTests(fn: JobSpawner | null): void {
  spawner = fn;
}

/**
 * Spawn the serial localize CLI for a persisted job. A spawn failure is
 * recorded on the job immediately, so the UI sees `interrupted` (retryable)
 * instead of a `queued` job that never starts.
 */
function defaultSpawner(sdir: string, jobId: string): void {
  const script = path.join(REPO_ROOT, "src", "cli", "localize.ts");
  const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const argv = fs.existsSync(tsx) ? [tsx, script] : [script];
  const markFailed = (reason: string) => {
    const job = readJob(sdir, jobId);
    if (!job || job.status !== "queued") return;
    try {
      writeJob(sdir, {
        ...job,
        status: "interrupted",
        error: `Could not start the language-version worker: ${reason}. Retry to run it.`,
        pid: null,
        pidStart: null,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // The queued grace window still recovers this job.
    }
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [...argv, path.basename(sdir), "--job", jobId], {
      cwd: REPO_ROOT,
      env: { ...process.env, MANHWA_SERIES_ROOT: path.dirname(sdir) },
      detached: true,
      stdio: "ignore",
      shell: false,
    });
  } catch (err) {
    markFailed((err as Error).message.slice(0, 160));
    return;
  }
  child.once("error", (err) => {
    markFailed((err as Error).message.slice(0, 160));
  });
  child.unref();
}

function spawnJob(sdir: string, jobId: string): void {
  (spawner ?? defaultSpawner)(sdir, jobId);
}

function seriesRoot(): string {
  return process.env.MANHWA_SERIES_ROOT || path.join(REPO_ROOT, "series");
}

/**
 * The one way a language job starts: the POST route (Generate and the UI
 * Retry) and the server's automatic retry share the same guards.
 */
async function startLanguageJob(
  sdir: string,
  input: PlanLocalizeInput,
  now: () => Date = () => new Date(),
): Promise<string> {
  parseChapterSelection(input.chapters, availableChapters(sdir));
  const planned = await planLocalizeJob(sdir, input, now);
  spawnJob(sdir, planned.job.id);
  return planned.job.id;
}

/** Codes that heal by themselves: the pending retry stays and runs on a later tick. */
const WAIT_CODES = new Set(["job_active", "pipeline_conflict", "state_busy", "localize_busy"]);

/**
 * One watchdog pass over every series with language jobs: dead workers are
 * marked interrupted (which schedules their retry) and every due retry is
 * started with the job's own chapters, voice and speed.
 */
export async function languageQueueTick(now: () => Date = () => new Date()): Promise<string[]> {
  const started: string[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdirSync(seriesRoot());
  } catch {
    return started;
  }
  for (const slug of slugs) {
    let sdir: string;
    try {
      sdir = seriesDir(seriesRoot(), slug);
      if (!fs.existsSync(languageJobsDir(sdir))) continue;
      reconcileLocalizeJobs(sdir, now);
    } catch {
      continue;
    }
    let due: ReturnType<typeof dueAutoRetries>;
    try {
      due = dueAutoRetries(sdir, now);
    } catch {
      continue;
    }
    for (const job of due) {
      const chapters = unfinishedChapters(job).map((ch) => ch.slice(2)).join(",");
      try {
        started.push(await startLanguageJob(sdir, {
          locale: job.locale,
          chapters,
          voice: job.voice,
          speed: job.speed,
          autoRetryOf: job.id,
        }, now));
      } catch (err) {
        const code = err instanceof LocalizeError ? err.code : "";
        if (WAIT_CODES.has(code) || code === "auto_retry_superseded") continue;
        try {
          dropAutoRetry(sdir, job.id, (err as Error).message || "request rejected");
        } catch {
          // the next tick tries again
        }
      }
    }
  }
  return started;
}

let languageWatchdog: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

/** Start the overnight watchdog for language jobs; works with nobody polling the UI. */
export function initLanguageQueue(): void {
  const tick = () => {
    if (tickRunning) return;
    tickRunning = true;
    languageQueueTick()
      .catch((err) => console.error("language watchdog warning:", (err as Error).message))
      .finally(() => {
        tickRunning = false;
      });
  };
  tick();
  if (!languageWatchdog) {
    languageWatchdog = setInterval(tick, 60_000);
    languageWatchdog.unref();
  }
}

/** Release the watchdog during server shutdown or test teardown. */
export function stopLanguageQueue(): void {
  if (languageWatchdog) clearInterval(languageWatchdog);
  languageWatchdog = null;
}

function sendLocalizeError(res: ServerResponse, err: unknown, sendJson: SendJson): unknown {
  if (err instanceof LocalizeError) {
    return sendJson(res, err.statusCode || 400, {
      error: err.message,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    });
  }
  const e = err as { statusCode?: number; message?: string; name?: string };
  if (e?.name === "LocalizePathError" || e?.name === "LockPathError") {
    return sendJson(res, 400, { error: "Invalid language-version path" });
  }
  const status = Number(e?.statusCode) || 500;
  return sendJson(res, status, {
    error: status === 500 ? "language version request failed" : e?.message || "request failed",
  });
}

export type LanguagesExportAction = "export" | "merge" | "outro";

/** Path prefix match for `/api/series/<slug>/languages[...]`. */
export function languagesApiMatch(
  pathname: string,
): { slug: string; preview: boolean; locale?: string; action?: LanguagesExportAction } | null {
  const m = /^\/api\/series\/([^/]+)\/languages(?:\/(preview))?$/.exec(pathname);
  if (m) return { slug: m[1]!, preview: m[2] === "preview" };
  const e = /^\/api\/series\/([^/]+)\/languages\/([^/]+)\/(export|merge|outro)$/.exec(pathname);
  if (e) return { slug: e[1]!, preview: false, locale: e[2]!, action: e[3] as LanguagesExportAction };
  return null;
}

const JOB_FIELDS = ["locale", "chapters", "voice", "speed", "csrfToken"] as const;
const MERGE_FIELDS = ["includeOutro", "csrfToken"] as const;
const OUTRO_FIELDS = [
  "voice", "speed", "hookType", "totalChapters", "coveredChapters", "customNote", "nextSeriesTitle", "csrfToken",
] as const;

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new LocalizeError(`${key} must be a string`, 400, "invalid_field");
  return v;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new LocalizeError(`${key} must be a number`, 400, "invalid_field");
  return v;
}

/** Locale export routes: state, merge and outro for one language version. */
async function handleExportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  target: { sdir: string; slug: string },
  localeRaw: string,
  action: LanguagesExportAction,
  urlObj: URL | null,
  session: LaneSession,
  sendJson: SendJson,
): Promise<unknown> {
  const locale = validateLocale(localeRaw);
  if (!locale) {
    req.resume();
    return sendJson(res, 404, { error: "Language version not found", code: "unsupported_locale" });
  }
  if (action === "export") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      return sendJson(res, 405, { error: "method not allowed" });
    }
    const raw = urlObj?.searchParams.get("includeOutro");
    const includeOutro = raw === "true" ? true : raw === "false" ? false : undefined;
    try {
      return sendJson(res, 200, localeExportState(target.sdir, target.slug, locale, { includeOutro }));
    } catch (err) {
      return sendLocalizeError(res, err, sendJson);
    }
  }
  if (req.method !== "POST") {
    req.resume();
    return sendJson(res, 405, { error: "method not allowed" });
  }
  if (!requirePrivileged(req, res, session, sendJson)) return undefined;
  const body = await readBody(req, res, session, sendJson, action === "merge" ? MERGE_FIELDS : OUTRO_FIELDS);
  if (!body) return undefined;
  try {
    if (action === "merge") {
      const includeOutro = body.includeOutro;
      if (includeOutro !== undefined && typeof includeOutro !== "boolean") {
        throw new LocalizeError("includeOutro must be true or false", 400, "invalid_field");
      }
      // 202: the merge runs in the background (Cloudflare drops responses after
      // 100 s). Its outcome is `lastMerge` in the export GET.
      const run = startLocaleMerge(target.sdir, target.slug, locale, {
        includeOutro: includeOutro as boolean | undefined,
      });
      void run.done.catch(() => {});
      return sendJson(res, 202, run.state);
    }
    const run = startLocaleOutro(target.sdir, target.slug, locale, {
      voice: optionalString(body, "voice"),
      speed: optionalNumber(body, "speed"),
      hookType: optionalString(body, "hookType"),
      totalChapters: optionalNumber(body, "totalChapters"),
      coveredChapters: optionalNumber(body, "coveredChapters"),
      customNote: optionalString(body, "customNote"),
      nextSeriesTitle: optionalString(body, "nextSeriesTitle"),
    });
    void run.done.catch(() => {});
    return sendJson(res, 202, run.state);
  } catch (err) {
    return sendLocalizeError(res, err, sendJson);
  }
}

function resolveSafeSeries(slugRaw: string): { sdir: string; slug: string } {
  const slug = String(slugRaw || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 64) {
    throw new LocalizeError("Invalid series slug", 400, "invalid_slug");
  }
  const sdir = seriesDir(seriesRoot(), slug);
  return { sdir, slug };
}

function requirePrivileged(
  req: IncomingMessage,
  res: ServerResponse,
  session: LaneSession,
  sendJson: SendJson,
): boolean {
  if (session.privileged) return true;
  req.resume();
  sendJson(res, 403, {
    error: "Temporary viewing accounts cannot create language versions. Sign in with a persistent account.",
  });
  return false;
}

async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  session: LaneSession,
  sendJson: SendJson,
  fields: readonly string[] = JOB_FIELDS,
): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_LANGUAGES_BODY_BYTES) {
    req.resume();
    sendJson(res, 413, { error: "JSON request body too large" });
    return null;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_LANGUAGES_BODY_BYTES);
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    sendJson(res, e.statusCode || 400, { error: e.message || "Bad request body" });
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "JSON object body required" });
    return null;
  }
  const record = body as Record<string, unknown>;
  const csrf = verifyCsrf(req, session, typeof record.csrfToken === "string" ? record.csrfToken : "");
  if (!csrf.ok) {
    sendJson(res, 403, { error: csrf.error });
    return null;
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      sendJson(res, 400, { error: `Unsupported field: ${key}` });
      return null;
    }
  }
  return record;
}

/** Route handler for both languages API endpoints. Always answers. */
export async function handleLanguagesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  session: LaneSession | null,
  sendJson: SendJson,
  urlObj: URL | null = null,
): Promise<unknown> {
  if (!session) {
    req.resume();
    return sendJson(res, 401, { error: "auth required" });
  }
  const match = languagesApiMatch(pathname);
  if (!match) {
    req.resume();
    return sendJson(res, 404, { error: "not found" });
  }
  let target: { sdir: string; slug: string };
  try {
    target = resolveSafeSeries(match.slug);
  } catch (err) {
    req.resume();
    return sendLocalizeError(res, err, sendJson);
  }

  if (match.action && match.locale !== undefined) {
    return handleExportRoute(req, res, target, match.locale, match.action, urlObj, session, sendJson);
  }

  if (match.preview) {
    if (req.method !== "POST") {
      req.resume();
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (!requirePrivileged(req, res, session, sendJson)) return undefined;
    const body = await readBody(req, res, session, sendJson);
    if (!body) return undefined;
    try {
      const result = await generateLanguagePreview(target.sdir, target.slug, {
        locale: String(body.locale ?? ""),
        voice: String(body.voice ?? ""),
        speed: body.speed === undefined ? undefined : Number(body.speed),
      });
      return sendJson(res, 200, { ok: true, url: result.url });
    } catch (err) {
      return sendLocalizeError(res, err, sendJson);
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    try {
      return sendJson(res, 200, languagesState(target.sdir, target.slug));
    } catch (err) {
      return sendLocalizeError(res, err, sendJson);
    }
  }

  if (req.method !== "POST") {
    req.resume();
    return sendJson(res, 405, { error: "method not allowed" });
  }
  if (!requirePrivileged(req, res, session, sendJson)) return undefined;
  const body = await readBody(req, res, session, sendJson);
  if (!body) return undefined;

  try {
    const locale = validateLocale(body.locale);
    if (!locale) {
      throw new LocalizeError(
        `Unsupported language ${JSON.stringify(String(body.locale ?? ""))}. Supported: hi-IN`,
        400,
        "unsupported_locale",
      );
    }
    const voice = String(body.voice ?? "").trim();
    if (!voice) throw new LocalizeError("voice is required", 400, "missing_voice");
    await startLanguageJob(target.sdir, {
      locale,
      chapters: String(body.chapters ?? "all"),
      voice,
      speed: body.speed === undefined ? undefined : Number(body.speed),
    });
    return sendJson(res, 202, languagesState(target.sdir, target.slug));
  } catch (err) {
    return sendLocalizeError(res, err, sendJson);
  }
}

/* ------------------------------------------------------------------ *
 * Media
 * ------------------------------------------------------------------ */

export interface LanguagesMediaMatch {
  kind: "video" | "preview" | "full" | "outro";
  slug: string;
  locale: string;
  ch?: string;
  id?: string;
}

export function languagesMediaMatch(pathname: string): LanguagesMediaMatch | null {
  if (!pathname.startsWith("/media/")) return null;
  const parts = pathname.slice("/media/".length).split("/");
  if (parts.length === 4 && parts[1] === "languages" && parts[3] === "full.mp4") {
    return { kind: "full", slug: parts[0]!, locale: parts[2]! };
  }
  if (parts.length === 5 && parts[1] === "languages" && parts[3] === "outro" && parts[4] === "video.mp4") {
    return { kind: "outro", slug: parts[0]!, locale: parts[2]! };
  }
  if (parts.length === 5 && parts[1] === "languages" && parts[4] === "video.mp4") {
    return { kind: "video", slug: parts[0]!, locale: parts[2]!, ch: parts[3]! };
  }
  if (parts.length === 5 && parts[1] === "languages" && parts[3] === "preview" && parts[4]!.endsWith(".mp3")) {
    return { kind: "preview", slug: parts[0]!, locale: parts[2]!, id: parts[4]!.slice(0, -4) };
  }
  return null;
}

/**
 * Serve a localized video or preview. Returns true when the request was
 * handled (including its error response), false when it is not a language path.
 */
export async function handleLanguagesMediaRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  urlObj: URL,
  sendJson: SendJson,
): Promise<boolean> {
  const match = languagesMediaMatch(pathname);
  if (!match) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.resume();
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  let target: { sdir: string; slug: string };
  try {
    target = resolveSafeSeries(match.slug);
  } catch (err) {
    sendLocalizeError(res, err, sendJson);
    return true;
  }
  const locale = validateLocale(match.locale);
  if (!locale) {
    sendJson(res, 404, { error: "Language version not found" });
    return true;
  }

  if (match.kind === "preview") {
    const file = resolvePreviewFile(target.sdir, locale, match.id ?? "");
    if (!file) {
      sendJson(res, 404, { error: "Preview not found" });
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    await streamFile(req, res, file, "audio/mpeg");
    return true;
  }

  const download = urlObj.searchParams.get("download") === "1";
  if (match.kind === "full") {
    const full = resolveLocaleFullVideo(target.sdir, locale);
    if (!full) {
      sendJson(res, 404, { error: "No merged video for this language yet" });
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    if (download) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${localeMergeFilename(target.slug, locale, full.chapters)}"`,
      );
    }
    await streamFile(req, res, full.file, "video/mp4");
    return true;
  }
  if (match.kind === "outro") {
    const file = resolveLocaleOutroVideo(target.sdir, locale);
    if (!file) {
      sendJson(res, 404, { error: "No outro for this language yet" });
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="${localeOutroFilename(target.slug, locale)}"`);
    }
    await streamFile(req, res, file, "video/mp4");
    return true;
  }

  const ch = String(match.ch ?? "").toLowerCase();
  if (!/^ch\d{1,4}$/.test(ch)) {
    sendJson(res, 400, { error: "Invalid chapter" });
    return true;
  }
  const resolved = resolveLocaleVideo(target.sdir, locale, ch);
  if (!resolved) {
    sendJson(res, 404, { error: "No verified language version video for this chapter" });
    return true;
  }
  if (urlObj.searchParams.get("download") === "1") {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${target.slug}-${locale}-${ch}.mp4"`,
    );
  }
  await streamFile(req, res, resolved.file, "video/mp4");
  return true;
}
