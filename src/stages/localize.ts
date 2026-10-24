/**
 * localize.ts - Hindi (hi-IN) language version of a REVIEWED English script.
 *
 * Pipeline for one chapter:
 *   validate  read-only source gate: exact engine script + obs + panels + report
 *   translate structured narration units through the configured writer lane
 *   review    independent semantic check of the translation against the source
 *   render    renderlane.produce(..., { locale, tts, lane: "local" })
 *   verify    ffprobe + hash the produced MP4 before publishing
 *
 * English artifacts are only ever READ. Every localized artifact lives under
 * `<series>/out/languages/<locale>/<ch>/`.
 *
 * Two independent identities:
 *   translationKey = source script/obs/bible + approved glossary + prompt version + model config
 *   renderKey      = translationKey + voice/speed + effective render config + panel revision
 * so a voice or background change never repays translation, and a script change
 * never reuses stale audio.
 *
 * Chapter state keeps ATTEMPT status and the LAST-KNOWN-GOOD artifact apart: a
 * failed or in-flight regeneration never removes the previously published video.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getStudioSettings } from "../config/studioConfig.js";
import { resolveOutDir } from "../config/secretStore.js";
import { PROMO_ALGO_VERSION } from "../contracts/hashes.js";
import { call, laneSnapshotStatus, type ChatMessage } from "../llm/client.js";
import { localizedSpeechText, synthesizeVertexTtsToFile, vertexTtsConfigFingerprint } from "../llm/vertexTts.js";
import { load as loadPromoBlock } from "../intake/promoBlock.js";
import { detectActivePipelineRuns, flockFd, tryFlockFd, withSharedSeriesLock } from "../locks/seriesLock.js";
import {
  catalog as catalogEntries,
  catalogEntry,
  findVoice,
  languageChapterDir,
  resolveVoice,
  UnsupportedVoiceError,
  validateLocale,
  voiceProvider,
  type ResolvedVoice,
} from "../localization/catalog.js";
import {
  CHAPTER_RE,
  canonicalChapterDir,
  canonicalVideoPath,
  assertNoSymlinks as assertNoSymlinksStore,
  ensureDir,
  exportLockPath,
  glossaryAutoPath,
  glossaryPath,
  isInside,
  isRegularFile,
  jobLockPath,
  jobPath,
  languagesRoot,
  listJobs,
  MAX_ATTEMPTS,
  newJobId,
  nowIso,
  pidAlive,
  procBootId,
  procStartTicks,
  QUEUED_GRACE_MS,
  readJob,
  readJson,
  readManifest,
  sha256File,
  sha256Json,
  sha256Text,
  sortChapters,
  stateLockPath,
  writeJob,
  writeJsonAtomic,
  writeManifest,
  type LocalizePathError,
} from "../localization/store.js";
import type {
  LanguageCatalogEntry,
  LanguageChapterView,
  LanguageManifest,
  LanguageSourceChapter,
  LanguageVersionView,
  LanguagesState,
  LocaleArtifact,
  LocaleChapterRecord,
  LocaleChapterStatus,
  LocaleProduceFn,
  LocaleStage,
  LocalizeJobRecord,
} from "../localization/types.js";
import * as factCheckMod from "./factCheck.js";
import {
  errorsOf,
  parseLocaleScript,
  rebuildScript,
  validateTranslation,
  warningsOf,
  type LocaleScriptIssue,
  type ParsedLocaleScript,
} from "./localeScript.js";
import * as writerMod from "./writer.js";

export const TRANSLATION_PROMPT_VERSION = "hi-translate-v3";
export const REVIEW_PROMPT_VERSION = "hi-review-v3";
export const RENDERER_REVISION = "locale-render-v3";
export const CLEANER_REVISION = `promo-${PROMO_ALGO_VERSION}`;
export const SAMPLE_TEXT_HI =
  "उसे लगा था ये बस एक नॉर्मल पोर्टल है, लेकिन तभी सिस्टम की वॉर्निंग लाल होकर चमकने लगी। " +
  "इस एक पल में उसकी पूरी लाइफ बदलने वाली थी।";
export const RETRY_WAIT_MS = [60_000, 240_000] as const;
export const MODEL_RETRY_WAIT_MS = [2_000, 5_000] as const;
export const PREVIEW_COOLDOWN_MS = 10_000;
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const PREVIEW_TIMEOUT_MS = 60_000;
/** Bound on waiting for the short state lock (a transaction is milliseconds). */
export const STATE_LOCK_WAIT_MS = 2_000;

export class LocalizeError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Raw technical cause for the UI's "details" disclosure; `message` stays short. */
  readonly detail?: string;
  constructor(message: string, statusCode = 400, code = "localize_error", detail?: string) {
    super(message);
    this.name = "LocalizeError";
    this.statusCode = statusCode;
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * Test seams (production never sets these)
 * ------------------------------------------------------------------ */

type LlmCall = typeof call;
let llmCallImpl: LlmCall | null = null;
let rendererImpl: LocaleProduceFn | null = null;
let previewSynthImpl: ((text: string, dest: string, voice: string, rate: string) => Promise<void>) | null = null;
let vertexPreviewSynthImpl: typeof synthesizeVertexTtsToFile | null = null;
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let probeImpl: ((file: string) => number) | null = null;
let sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep;
let previewTimeoutMs = PREVIEW_TIMEOUT_MS;

export function _setLlmCallForTests(fn: LlmCall | null): void {
  llmCallImpl = fn;
}
export function _setRendererForTests(fn: LocaleProduceFn | null): void {
  rendererImpl = fn;
}
export function _setPreviewSynthForTests(
  fn: ((text: string, dest: string, voice: string, rate: string) => Promise<void>) | null,
): void {
  previewSynthImpl = fn;
}
/** Replace the Vertex preview synthesizer (no network in tests). */
export function _setVertexPreviewSynthForTests(fn: typeof synthesizeVertexTtsToFile | null): void {
  vertexPreviewSynthImpl = fn;
}
export function _setProbeForTests(fn: ((file: string) => number) | null): void {
  probeImpl = fn;
}
export function _setSleepForTests(fn: ((ms: number, signal?: AbortSignal) => Promise<void>) | null): void {
  sleepImpl = fn ?? defaultSleep;
}
export function _setPreviewTimeoutForTests(ms: number | null): void {
  previewTimeoutMs = ms && ms > 0 ? ms : PREVIEW_TIMEOUT_MS;
}

async function llm(messages: ChatMessage[], options: Parameters<LlmCall>[1]): Promise<string> {
  const fn = llmCallImpl ?? call;
  const res = await fn(messages, options);
  const content = res.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new LocalizeError("writer lane returned empty content", 502, "llm_empty");
  }
  return content;
}

/* ------------------------------------------------------------------ *
 * JSON helpers
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a JSON answer, tolerating a fenced block around it. */
export function parseModelJson(text: string): unknown {
  const raw = text.trim();
  const attempts = [raw];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) attempts.push(fence[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next shape
    }
  }
  throw new LocalizeError("writer lane returned unparseable JSON", 502, "llm_parse");
}

/* ------------------------------------------------------------------ *
 * Series / chapter selection
 * ------------------------------------------------------------------ */

export function seriesDir(seriesRoot: string, slug: string): string {
  const dir = path.resolve(seriesRoot, slug);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new LocalizeError("Series not found", 404, "series_not_found");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new LocalizeError("Series path is not a safe directory", 400, "invalid_series");
  }
  return dir;
}

/** Chapter folders that exist as real directories under `out/`. */
export function availableChapters(sdir: string): string[] {
  const out = path.join(sdir, "out");
  let names: string[];
  try {
    names = fs.readdirSync(out);
  } catch {
    return [];
  }
  const chapters: string[] = [];
  for (const name of names) {
    if (!CHAPTER_RE.test(name)) continue;
    try {
      const st = fs.lstatSync(path.join(out, name));
      if (st.isDirectory() && !st.isSymbolicLink()) chapters.push(name);
    } catch {
      // skip
    }
  }
  return sortChapters(chapters);
}

/**
 * Resolve `all` | `1` | `1-3` | `1,3` | `1-3,7` against existing chapters.
 * A retry list is honoured exactly: `1,3` never expands to include `2`.
 */
export function parseChapterSelection(spec: unknown, available: readonly string[]): string[] {
  const raw = String(spec ?? "all").trim().toLowerCase();
  if (!raw || raw === "all") return sortChapters(available);
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) {
    throw new LocalizeError(
      "chapters must be 'all', a chapter number like '1', a range like '1-3', " +
        "or a comma-separated list like '1,3' or '1-3,7'",
      400,
      "invalid_chapters",
    );
  }
  const nums: number[] = [];
  for (const part of raw.split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b < a || b - a > 500) {
        throw new LocalizeError("Invalid chapter range", 400, "invalid_chapters");
      }
      for (let n = a; n <= b; n++) nums.push(n);
    } else {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0 || n > 5000) {
        throw new LocalizeError("Invalid chapter number", 400, "invalid_chapters");
      }
      nums.push(n);
    }
  }
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  if (unique.length > 500) {
    throw new LocalizeError("Too many chapters requested (max 500)", 400, "invalid_chapters");
  }
  const have = new Set(available.map((c) => c.toLowerCase()));
  const missing = unique.filter((n) => !have.has(`ch${n}`));
  if (missing.length > 0) {
    throw new LocalizeError(
      `Chapter${missing.length > 1 ? "s" : ""} ${missing.map((n) => `ch${n}`).join(", ")} not found in this series`,
      422,
      "chapter_missing",
    );
  }
  return sortChapters(unique.map((n) => `ch${n}`));
}

/* ------------------------------------------------------------------ *
 * Source eligibility (read-only)
 * ------------------------------------------------------------------ */

const SCRIPT_BY_ENGINE: Record<string, string> = {
  eleven: "script_eleven.md",
  external: "script_voice.md",
};
const PANEL_EXTS = [".jpg", ".png", ".jpeg", ".webp"] as const;

export interface SourceCheck {
  eligible: boolean;
  chapter: string;
  reason?: string;
  scriptName?: string;
  scriptPath?: string;
  scriptText?: string;
  parsed?: ParsedLocaleScript;
  scriptHash?: string;
  obsHash?: string;
  bibleHash?: string;
  panelHash?: string;
  obs?: Record<string, unknown>;
  bible?: Record<string, unknown>;
  transcript?: string;
  /** Advisory source findings for the UI and the semantic reviewer. */
  advisories?: string[];
  /** Panel stat identity the check was computed from. */
  panelSignature?: string;
  warnings: string[];
}

function readJsonObject(file: string): Record<string, unknown> | null {
  const raw = readJson(file);
  return isRecord(raw) ? raw : null;
}

function seriesEngine(sdir: string): string {
  const meta = readJsonObject(path.join(sdir, "meta.json"));
  const tts = meta && isRecord(meta.tts) ? meta.tts : {};
  const engine = typeof tts.engine === "string" ? tts.engine.trim().toLowerCase() : "";
  return engine || "edge";
}

/**
 * The script the ENGLISH pipeline actually voiced for this series' engine.
 * A leftover `script_voice.md` must not shadow `script.md` on an edge series.
 */
export function engineScriptPath(outDir: string, ch: string, engine: string): string {
  const name = SCRIPT_BY_ENGINE[engine] ?? "script.md";
  const primary = path.join(outDir, ch, name);
  if (isRegularFile(primary)) return primary;
  // A legacy/renamed engine script is only a fallback when the engine-specific
  // one is absent; the caller still validates content.
  for (const candidate of ["script.md", "script_voice.md", "script_eleven.md"]) {
    const file = path.join(outDir, ch, candidate);
    if (isRegularFile(file)) return file;
  }
  return primary;
}

function observedPanels(obs: Record<string, unknown>): Array<Record<string, unknown>> {
  const panels = Array.isArray(obs.panels) ? obs.panels : [];
  return panels.filter(isRecord);
}

function panelFileExists(panelsDir: string, pid: string): boolean {
  for (const ext of PANEL_EXTS) {
    if (isRegularFile(path.join(panelsDir, pid + ext))) return true;
  }
  return false;
}

/** Fresh panel transcript from obs, exactly like the writer/fact-check input. */
function freshTranscript(obs: Record<string, unknown>, promo: { matches(s: string): boolean } | null): string {
  try {
    return writerMod.panelTranscript(
      obs as unknown as Parameters<typeof writerMod.panelTranscript>[0],
      promo as unknown as Parameters<typeof writerMod.panelTranscript>[1],
    );
  } catch {
    return "";
  }
}

interface ReportShape {
  status: string;
  issues: string[];
  lines: number | null;
}

/** Strict report schema: a malformed report is a refusal, not an empty pass. */
function readReport(file: string): { report: ReportShape | null; error: string | null } {
  const raw = readJson(file);
  if (raw === null) return { report: null, error: "missing or unreadable" };
  if (!isRecord(raw)) return { report: null, error: "not a JSON object" };
  const status = raw.status;
  if (typeof status !== "string" || !status.trim()) {
    return { report: null, error: "missing status" };
  }
  if (!["ok", "failed", "video-ok", "video-failed"].includes(status)) {
    return { report: null, error: `unknown status ${JSON.stringify(status)}` };
  }
  if (!Array.isArray(raw.issues) || raw.issues.some((i) => typeof i !== "string")) {
    return { report: null, error: "issues must be a list of strings" };
  }
  const lines = raw.lines === undefined || raw.lines === null ? null : Number(raw.lines);
  if (lines !== null && (!Number.isInteger(lines) || lines < 0)) {
    return { report: null, error: "lines must be a non-negative integer" };
  }
  return { report: { status, issues: raw.issues as string[], lines }, error: null };
}

/**
 * Findings that mean the source itself is unusable: invalid/missing panel tags,
 * unknown emotion tags, non-English narration, and numeric contradictions with
 * the transcript. These block a language version.
 */
const HARD_FINDING = [
  /^bad tag @p\d+_\d+/,
  /^page-level tag @p\d+/,
  /^UNKNOWN emotion tag/,
  /^NON-ENGLISH NARRATION/,
  /^number \d+ not in transcript/,
  /^word-number '[^']+' not in transcript/,
  /^phrase '[^']+' not in transcript/,
];

/**
 * Advisory style/overlap heuristics (DUB, SCREENREADER, CAPTION, MULTI,
 * UNGROUNDED, LORE IMPORT). Measured to mislead (F1 0.35 on the UNGROUNDED
 * lint), so they never block on their own: they are surfaced to the user and
 * handed to the independent semantic review, which judges the actual meaning.
 */
export function isHardSourceFinding(issue: string): boolean {
  return HARD_FINDING.some((re) => re.test(issue.trim()));
}

export function splitSourceFindings(issues: readonly string[]): { hard: string[]; advisory: string[] } {
  const hard: string[] = [];
  const advisory: string[] = [];
  for (const issue of issues) (isHardSourceFinding(issue) ? hard : advisory).push(issue);
  return { hard, advisory };
}

const sourceCheckCache = new Map<string, SourceCheck>();
const SOURCE_CHECK_CACHE_LIMIT = 32;

/**
 * Cheap stat identity for a panel file: dev/ino/size/mtime/ctime. A replaced
 * image (even same size) changes ino/ctime, so the memo can never serve stale
 * panel evidence.
 */
function statIdentity(file: string): string {
  try {
    const st = fs.lstatSync(file, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink()) return "absent";
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return "absent";
  }
}

function panelFileFor(panelsDir: string, pid: string): string | null {
  for (const ext of PANEL_EXTS) {
    const file = path.join(panelsDir, pid + ext);
    if (isRegularFile(file)) return file;
  }
  return null;
}

/** Content hash of the exact panel bytes a render will use (render identity). */
function panelContextHash(sdir: string, ch: string, obs: Record<string, unknown>): string {
  const panelsDir = path.join(sdir, "out", "panels", ch);
  const rows: string[] = [];
  for (const panel of observedPanels(obs)) {
    const id = String(panel.id ?? "");
    if (!id) continue;
    const file = panelFileFor(panelsDir, id);
    rows.push(`${id}|${file ? sha256File(file) : "absent"}`);
  }
  const manifest = path.join(panelsDir, "manifest.json");
  let manifestStamp = "-";
  try {
    const st = fs.lstatSync(manifest);
    manifestStamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // no manifest
  }
  return sha256Text(`${rows.join("\n")}\nmanifest:${manifestStamp}`);
}

function sourceCheckSignature(sdir: string, ch: string): string {
  const out = path.join(sdir, "out");
  const files = [
    path.join(sdir, "meta.json"),
    path.join(out, ch, "script.md"),
    path.join(out, ch, "script_voice.md"),
    path.join(out, ch, "script_eleven.md"),
    path.join(out, ch, "report.json"),
    path.join(out, `obs_${ch}.json`),
    path.join(out, "bible.json"),
    path.join(out, "promo_block.json"),
    path.join(out, "panels", ch, "manifest.json"),
  ];
  const stamps = files.map((file) => {
    try {
      const st = fs.lstatSync(file);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "-";
    }
  });
  const panelsDir = path.join(out, "panels", ch);
  let panelStamps = "";
  try {
    panelStamps = fs
      .readdirSync(panelsDir)
      .filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name))
      .sort()
      .map((name) => `${name}:${statIdentity(path.join(panelsDir, name))}`)
      .join(",");
  } catch {
    panelStamps = "-";
  }
  return `${path.resolve(sdir)}|${ch}|${stamps.join(",")}|${panelStamps}`;
}

/**
 * Decide whether a chapter's English source may be localized.
 * Memoized on source stamps for the polled GET; the memo re-validates the
 * critical files (script, obs, panels) on every hit.
 */
export function checkSourceChapter(sdir: string, ch: string): SourceCheck {
  const key = sourceCheckSignature(sdir, ch);
  const cached = sourceCheckCache.get(key);
  if (cached && cached.panelSignature === panelSignatureOf(sdir, ch) && cacheStillValid(sdir, ch, cached)) {
    return cached;
  }
  const result = computeSourceCheck(sdir, ch);
  if (sourceCheckCache.size >= SOURCE_CHECK_CACHE_LIMIT) sourceCheckCache.clear();
  sourceCheckCache.set(key, result);
  return result;
}

export function _clearSourceCheckCache(): void {
  sourceCheckCache.clear();
}

function panelSignatureOf(sdir: string, ch: string): string {
  const panelsDir = path.join(sdir, "out", "panels", ch);
  try {
    return fs
      .readdirSync(panelsDir)
      .filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name))
      .sort()
      .map((name) => `${name}:${statIdentity(path.join(panelsDir, name))}`)
      .join(",");
  } catch {
    return "-";
  }
}

function cacheStillValid(sdir: string, ch: string, cached: SourceCheck): boolean {
  if (!cached.eligible || !cached.scriptPath || !cached.obs) return true;
  if (!isRegularFile(cached.scriptPath)) return false;
  if (!isRegularFile(path.join(sdir, "out", `obs_${ch}.json`))) return false;
  const panelsDir = path.join(sdir, "out", "panels", ch);
  for (const unit of cached.parsed?.units ?? []) {
    for (const tag of unit.tags) {
      if (!panelFileExists(panelsDir, tag.slice(1))) return false;
    }
  }
  return true;
}

function computeSourceCheck(sdir: string, ch: string): SourceCheck {
  const warnings: string[] = [];
  const out = path.join(sdir, "out");
  const base: SourceCheck = { eligible: false, chapter: ch, warnings };

  if (!CHAPTER_RE.test(ch)) {
    return { ...base, reason: "Invalid chapter id." };
  }
  const engine = seriesEngine(sdir);
  const scriptPath = engineScriptPath(out, ch, engine);
  if (!isRegularFile(scriptPath)) {
    return {
      ...base,
      reason:
        `Generate/review the English script first: no ${path.basename(scriptPath)} for this chapter ` +
        `(series TTS engine is ${engine}).`,
    };
  }
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const parsed = parseLocaleScript(scriptText);
  if (parsed.units.length === 0) {
    return {
      ...base,
      reason: `The English script ${path.basename(scriptPath)} has no narration lines; rewrite it before creating a language version.`,
    };
  }

  const obsFile = path.join(out, `obs_${ch}.json`);
  const obsRaw = readJsonObject(obsFile);
  if (!obsRaw) {
    return {
      ...base,
      reason: `Reader observations are missing or unreadable (out/obs_${ch}.json); run the English reader again before localizing.`,
    };
  }
  const obs = isRecord(obsRaw.data) ? (obsRaw.data as Record<string, unknown>) : obsRaw;
  const panels = observedPanels(obs);
  if (panels.length === 0) {
    return { ...base, reason: `Reader observations for ${ch} contain no panels; the source is incomplete.` };
  }
  const observedIds = new Set(panels.map((p) => String(p.id ?? "")));
  const panelsDir = path.join(out, "panels", ch);
  const unknownTags: string[] = [];
  const missingImages: string[] = [];
  for (const unit of parsed.units) {
    for (const tag of unit.tags) {
      const id = tag.slice(1);
      if (!observedIds.has(id)) unknownTags.push(tag);
      else if (!panelFileExists(panelsDir, id)) missingImages.push(tag);
    }
  }
  if (unknownTags.length > 0) {
    const shown = [...new Set(unknownTags)].slice(0, 6).join(", ");
    return {
      ...base,
      reason: `The English script references panels the reader did not observe (${shown}); re-run the matcher or fix the script first.`,
    };
  }
  if (missingImages.length > 0) {
    const shown = [...new Set(missingImages)].slice(0, 6).join(", ");
    return {
      ...base,
      reason: `Panel image files are missing for ${shown}; the English render would fail too. Restore them first.`,
    };
  }

  const reportFile = path.join(out, ch, "report.json");
  const { report, error: reportError } = readReport(reportFile);
  if (!report) {
    return {
      ...base,
      reason: `The English check report is ${reportError} (out/${ch}/report.json); run the English pipeline check before localizing.`,
    };
  }
  if (report.status === "failed" || report.status === "video-failed") {
    const detail = report.issues[0] ?? `status ${report.status}`;
    return {
      ...base,
      reason: `The English script failed its check (${detail.slice(0, 180)}). Fix and re-check it first.`,
    };
  }
  if (report.lines !== null && report.lines !== parsed.units.length) {
    warnings.push(
      `report.json records ${report.lines} lines but the script has ${parsed.units.length}; the report may be stale.`,
    );
  }

  // Deterministic re-check on EVERY source: the report's own status is not
  // proof that the current bytes were reviewed.
  let promo = null;
  try {
    promo = loadPromoBlock(out);
  } catch {
    promo = null;
  }
  const promoMatcher = promo ? { matches: (s: string) => promo!.matches(s) } : null;
  const transcript = freshTranscript(obs, promoMatcher);
  if (!transcript.trim()) {
    return {
      ...base,
      reason: `A fresh transcript could not be derived from out/obs_${ch}.json; the reader output is incomplete.`,
    };
  }
  const bible = readJsonObject(path.join(out, "bible.json")) ?? {};
  const charNames: string[] = [];
  const characters = isRecord(bible.characters) ? bible.characters : {};
  for (const value of Object.values(characters)) {
    if (!isRecord(value)) continue;
    if (typeof value.name === "string") charNames.push(value.name);
    if (Array.isArray(value.aliases)) charNames.push(...value.aliases.map(String));
  }
  let windowTxt = "";
  let prevScript: string | null = null;
  try {
    windowTxt = writerMod.previousWindow(out, ch)[0];
  } catch {
    windowTxt = "";
  }
  try {
    const prevPath = writerMod._scriptOf(out, `ch${Number.parseInt(ch.slice(2), 10) - 1}`);
    prevScript = prevPath ? fs.readFileSync(prevPath, "utf8") : null;
  } catch {
    prevScript = null;
  }
  let recomputed: string[] = [];
  try {
    recomputed = factCheckMod.check(scriptText, transcript, {
      windowTxt,
      promo: promoMatcher,
      prevScript,
      characterNames: charNames,
    });
  } catch (err) {
    return {
      ...base,
      reason: `The English check could not be recomputed (${(err as Error).message.slice(0, 160)}).`,
    };
  }
  // Recomputation on the CURRENT bytes is the stale-report detector: advisory
  // findings may pass, but a hard finding (invalid tag, non-English, numeric
  // contradiction) always blocks.
  const current = splitSourceFindings(recomputed);
  const reported = splitSourceFindings(report.issues);
  const hard = [...new Set([...current.hard, ...reported.hard])];
  if (hard.length > 0) {
    return {
      ...base,
      reason:
        `The English script has ${hard.length} hard source problem(s) on the current bytes. ` +
        `Fix and re-check it first. First issue: ${hard[0]!.slice(0, 180)}`,
    };
  }
  // Style/overlap advisories are surfaced, not treated as factual verdicts.
  const advisories = [...new Set([...current.advisory, ...reported.advisory])];
  for (const advisory of advisories) warnings.push(advisory);
  if (report.issues.length > 0 && advisories.length === 0) {
    warnings.push(
      `report.json listed ${report.issues.length} issue(s), but the deterministic check on the current script passes.`,
    );
  }

  return {
    ...base,
    eligible: true,
    scriptName: path.basename(scriptPath),
    scriptPath,
    scriptText,
    parsed,
    scriptHash: sha256Text(scriptText),
    obsHash: sha256File(obsFile),
    bibleHash: isRegularFile(path.join(out, "bible.json"))
      ? sha256File(path.join(out, "bible.json"))
      : sha256Text(""),
    panelHash: panelContextHash(sdir, ch, obs),
    obs,
    bible,
    transcript,
    advisories,
    panelSignature: panelSignatureOf(sdir, ch),
  };
}

export function sourceChapters(sdir: string): LanguageSourceChapter[] {
  return availableChapters(sdir).map((ch) => {
    const check = checkSourceChapter(sdir, ch);
    return check.eligible
      ? { chapter: ch, eligible: true }
      : { chapter: ch, eligible: false, reason: check.reason ?? "source not eligible" };
  });
}

/* ------------------------------------------------------------------ *
 * Glossary
 * ------------------------------------------------------------------ */

interface Glossary {
  names: Record<string, string>;
  terms: Record<string, string>;
}

function mergeGlossaryInto(target: Glossary, raw: unknown): void {
  if (!isRecord(raw)) return;
  for (const key of ["names", "terms"] as const) {
    const bucket = raw[key];
    if (!isRecord(bucket)) continue;
    for (const [k, v] of Object.entries(bucket)) {
      const name = k.trim();
      const value = typeof v === "string" ? v.trim() : "";
      if (name && value) target[key][name] = value;
    }
  }
}

/** Approved glossary first, then model-suggested entries for names not yet decided. */
export function readGlossary(sdir: string, locale: string): Glossary {
  const approved: Glossary = { names: {}, terms: {} };
  mergeGlossaryInto(approved, readJson(glossaryPath(sdir, locale)));
  const merged: Glossary = { names: { ...approved.names }, terms: { ...approved.terms } };
  const auto: Glossary = { names: {}, terms: {} };
  mergeGlossaryInto(auto, readJson(glossaryAutoPath(sdir, locale)));
  for (const key of ["names", "terms"] as const) {
    for (const [k, v] of Object.entries(auto[key])) {
      if (!(k in merged[key])) merged[key][k] = v;
    }
  }
  return merged;
}

/**
 * Persist model-suggested names. Entries are IMMUTABLE: an existing auto entry
 * is never overwritten, so a later chapter cannot silently change a
 * pronunciation that earlier chapters already used.
 */
export function mergeGlossary(sdir: string, locale: string, incoming: unknown): void {
  const auto: Glossary = { names: {}, terms: {} };
  mergeGlossaryInto(auto, readJson(glossaryAutoPath(sdir, locale)));
  const additions: Glossary = { names: {}, terms: {} };
  mergeGlossaryInto(additions, incoming);
  let changed = false;
  for (const key of ["names", "terms"] as const) {
    for (const [k, v] of Object.entries(additions[key])) {
      if (!(k in auto[key])) {
        auto[key][k] = v;
        changed = true;
      }
    }
  }
  if (!changed) return;
  const file = glossaryAutoPath(sdir, locale);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, auto);
}

function approvedGlossaryHash(sdir: string, locale: string): string {
  const file = glossaryPath(sdir, locale);
  return isRegularFile(file) ? sha256File(file) : sha256Text("{}");
}

/* ------------------------------------------------------------------ *
 * Grounding context + identity
 * ------------------------------------------------------------------ */

function groundingContext(check: SourceCheck): string {
  const parts: string[] = [];
  const bible = check.bible ?? {};
  const characters = isRecord(bible.characters) ? bible.characters : {};
  const cast: string[] = [];
  for (const [key, value] of Object.entries(characters)) {
    if (!isRecord(value)) continue;
    const name = typeof value.name === "string" ? value.name : key;
    const role = typeof value.role === "string" ? value.role : "";
    const aliases = Array.isArray(value.aliases) ? value.aliases.map(String).join("/") : "";
    cast.push(`- ${name}${aliases ? ` (${aliases})` : ""}${role ? `: ${role}` : ""}`);
  }
  if (cast.length) parts.push(`CAST:\n${cast.slice(0, 24).join("\n")}`);
  const obs = check.obs ?? {};
  const events = Array.isArray(obs.events) ? obs.events : [];
  if (events.length) {
    const lines = events.slice(0, 40).map((e, i) => {
      if (isRecord(e) && typeof e.event === "string") return `${i + 1}. ${e.event}`;
      return `${i + 1}. ${String(e)}`;
    });
    parts.push(`CHAPTER EVENTS:\n${lines.join("\n")}`);
  }
  const transcript = (check.transcript ?? "").trim();
  if (transcript) {
    parts.push(`SOURCE DIALOGUE (read-only, for meaning only):\n${transcript.slice(0, 6000)}`);
  }
  return parts.join("\n\n") || "(no extra context available)";
}

function modelConfigIdentity(): string {
  try {
    const status = laneSnapshotStatus();
    return sha256Json({ source: status.source, revision: status.revision, roles: status.roles });
  } catch {
    return sha256Text("lane-snapshot-unavailable");
  }
}

/**
 * Translation identity. The model-suggested auto glossary is deliberately
 * EXCLUDED (it is written by the translation itself); only the operator-approved
 * glossary, prompt versions and model configuration invalidate it.
 */
export function translationKeyFor(check: SourceCheck, locale: string, sdir: string): string {
  return sha256Json({
    version: 2,
    locale,
    prompt: TRANSLATION_PROMPT_VERSION,
    review: REVIEW_PROMPT_VERSION,
    script: check.scriptHash ?? "",
    obs: check.obsHash ?? "",
    bible: check.bibleHash ?? "",
    glossary: approvedGlossaryHash(sdir, locale),
    model: modelConfigIdentity(),
  });
}

interface RenderConfig {
  background: string;
  motion: string;
  quality: string;
  cleaner: string;
  /** Hash of the effective promo block the cleaner uses (rules, not just a rev). */
  promo: string;
  panels: string;
  /** Hash of `visuals.animation` (forwarded opaquely to the props); absent when unset. */
  animation?: string;
  /** Hash of the top-level `music` config; absent when unset. */
  music?: string;
}

/**
 * Hash of the effective promo/cleaner rules the render will apply.
 * `out/promo_block.json` is the shared block; a changed rule set changes the
 * cleaned artwork, so it belongs in the render identity.
 */
function promoBlockHash(sdir: string): string {
  const file = path.join(sdir, "out", "promo_block.json");
  if (!isRegularFile(file)) return sha256Text("no-promo-block");
  return sha256File(file);
}

/**
 * Effective render configuration read from the same sources the renderer uses.
 * Defaults mirror the English timeline (motion "window"), so a dub of a series
 * with no saved motion renders and caches like the English movie.
 */
export function renderConfig(sdir: string, check: SourceCheck): RenderConfig {
  const meta = readJsonObject(path.join(sdir, "meta.json")) ?? {};
  const visuals = isRecord(meta.visuals) ? meta.visuals : {};
  const background = String(visuals.background ?? meta.background ?? "starfield");
  const motion = String(visuals.motion ?? meta.motion ?? "window");
  const animation = isRecord(visuals.animation) ? sha256Json(visuals.animation) : undefined;
  const music = isRecord(meta.music) ? sha256Json(meta.music) : undefined;
  let quality = "1080p";
  const envQuality = (process.env.MANHWA_RENDER_QUALITY ?? "").trim().toLowerCase();
  if (envQuality.startsWith("720")) quality = "720p";
  else if (envQuality.startsWith("1080")) quality = "1080p";
  else {
    try {
      quality = getStudioSettings(resolveOutDir()).renderQuality;
    } catch {
      quality = "1080p";
    }
  }
  return {
    background,
    motion,
    quality,
    cleaner: CLEANER_REVISION,
    promo: promoBlockHash(sdir),
    panels: check.panelHash ?? "",
    ...(animation ? { animation } : {}),
    ...(music ? { music } : {}),
  };
}

/** Voice/provider identity that belongs in the render key. */
export interface RenderVoiceIdentity {
  engine: "edge" | "vertex";
  provider?: string;
  modelId?: string;
  locale?: string;
}

/**
 * Render identity: everything that changes the pictures or the audio, nothing else.
 *
 * An Edge render keeps the historical object shape byte-for-byte (so existing
 * published artifacts stay cache-valid); a Vertex render additionally pins the
 * provider, model and locale, so a provider-only change re-renders the audio
 * without retranslating.
 */
export function renderKeyFor(
  translationKey: string,
  voice: string,
  speed: number,
  config: RenderConfig,
  identity?: RenderVoiceIdentity,
): string {
  const engine = identity?.engine ?? "edge";
  const providerIdentity = engine === "edge"
    ? {}
    : {
      provider: identity?.provider ?? engine,
      model: identity?.modelId ?? null,
      locale: identity?.locale ?? null,
    };
  return sha256Json({
    version: 2,
    translation: translationKey,
    engine,
    voice,
    speed,
    ...providerIdentity,
    lane: "local",
    renderer: RENDERER_REVISION,
    background: config.background,
    motion: config.motion,
    quality: config.quality,
    cleaner: config.cleaner,
    promo: config.promo,
    panels: config.panels,
    // Only hashed when set, so keys of series without them stay byte-identical.
    ...(config.animation ? { animation: config.animation } : {}),
    ...(config.music ? { music: config.music } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * Translation + semantic review
 * ------------------------------------------------------------------ */

export const TRANSLATE_PROMPT = `You are a Hindi (hi-IN) voice-over writer for a manhwa/anime recap YouTube channel (18-28 Indian narrator).
Translate the ENGLISH narration units below into casual spoken Hinglish written 100% in Devanagari.

HARD CONTRACT - the JSON skeleton is fixed:
- Return EVERY unit, exactly once, in the same order, with the same "id".
- Keep every ⟦T1⟧, ⟦T2⟧, ... placeholder exactly where its panel tag belongs.
- Keep every ⟦E1⟧, ⟦E2⟧, ... placeholder exactly where its emotion control belongs.
- Keep ⟦H⟧ on exactly the units that carry it.
- Do NOT add, remove, merge or split units. Do NOT reorder them. No headers, notes or markdown.
- Never translate a placeholder. Never move a placeholder into another unit.

REGISTER & LANGUAGE RULES (spoken Hinglish in Devanagari - NO textbook/Sanskritized/news Hindi):
- Voice: 18-28 Indian recap YouTuber. Hindi grammar/verbs + everyday English loanwords phonetically in Devanagari (NO Roman/Latin script).
- Spoken pronouns & active voice: use वो/ये (never वह/यह/वे). Prefer active voice; avoid stiff passive "किया गया"/"द्वारा" (keep who-did-what exact).
- Everyday English in Devanagari: पावर, लेवल, सिस्टम, पोर्टल, गेट, नॉर्मल, वॉर्निंग, मिशन, टीम, प्लान, स्किल, अटैक, बॉस, मॉन्स्टर, रैंक, सीन, शॉक, ट्विस्ट, लाइफ, आइडिया, एक्चुअली, सीरियसली, फाइनली, डिसाइड करना, रियलाइज़ करना, कंट्रोल करना.
- Bookish -> spoken: अत्यंत/अत्यधिक->बहुत/एकदम; किंतु/परंतु->लेकिन/पर; तत्पश्चात/उपरांत->फिर/उसके बाद; अतः->इसलिए/तो; स्वयं->खुद; शक्ति->पावर; स्तर->लेवल; प्रणाली->सिस्टम; युद्ध->लड़ाई/फाइट; आक्रमण->अटैक/हमला; निर्णय लेना->डिसाइड करना/फ़ैसला करना; प्रयास->कोशिश; सहायता->मदद; आवश्यक->ज़रूरी; प्रारंभ/आरंभ->शुरू; समाप्त->खत्म; केवल->बस/सिर्फ; सम्पूर्ण->पूरा; जीवन->ज़िंदगी/लाइफ; प्राप्त->मिला; ज्ञात होना->पता चलना; प्रतीत होना->लगना; आश्चर्यचकित->शॉक्ड/हैरान; भयभीत->डरा हुआ; क्रोधित->गुस्से में; मित्र->दोस्त; शत्रु->दुश्मन; क्षण->पल; स्थिति->हालत/सिचुएशन; रहस्यमय->अजीब/मिस्टीरियस; अप्रत्याशित->"जिसकी किसी ने उम्मीद नहीं की थी"; परिवर्तित करना->बदलना.
- Balance: keep natural everyday Hindi words (दरवाज़ा, आँखें, डर, गुस्सा, दोस्त, लड़ाई, रात). No English grammar calques.
- Recap rhythm & fidelity: short punchy lines, connectors (तो, अब, बस, फिर, लेकिन तभी), match source energy. Faithful 1:1 per unit: no added facts or greetings like "दोस्तों"; keep dialogue as dialogue and narration as narration.
- Names & numbers: follow glossary (or transliterate once and add to "glossary"). Write numbers as digits or Hindi words ("दस हज़ार") with exact value - never transliterate English number words.
- Examples (Bad -> Good):
  "He had no idea this portal would change his life forever." Bad: "उसे ज़रा भी अंदाज़ा नहीं था कि यह द्वार उसके जीवन को सदा के लिए परिवर्तित कर देगा।" Good: "उसे ज़रा भी आइडिया नहीं था कि ये पोर्टल उसकी पूरी लाइफ बदल देने वाला है।"
  "Her power level was off the charts." Bad: "उसकी शक्ति का स्तर अत्यधिक ऊँचा था।" Good: "उसका पावर लेवल तो एकदम चार्ट से बाहर था।"
  "He decided to fight alone." Bad: "उसने अकेले युद्ध करने का निर्णय लिया।" Good: "उसने डिसाइड किया कि वो अकेले ही लड़ेगा।"

GROUNDING CONTEXT (facts, not translation hints):
{context}

GLOSSARY (already agreed names/terms - follow exactly):
{glossary}

ENGLISH UNITS (JSON):
{units}

Reply STRICT JSON only:
{"units":[{"id":"u0001","text":"हिन्दी पंक्ति ⟦T1⟧ ⟦T2⟧"}],
 "glossary":{"names":{"English name":"हिन्दी नाम"},"terms":{}}}`;

export const REVIEW_PROMPT = `You are an independent reviewer. You did NOT write this translation.
Two jobs, in this order:

1. SOURCE FACTS. The English script below is the narration a viewer hears. Judge
   whether it states anything the supplied source evidence does not support:
   an invented event, mechanism, motive, identity, relationship, number, time
   interval or outcome. The deterministic advisory findings (e.g. UNGROUNDED) are
   quoted with the source evidence; they are HEURISTICS that also fire on legitimate
   paraphrases, deliberate quotes and world text, so decide on the evidence, not on
   the label. Reject only a genuine unsupported claim; do not reject fluent
   paraphrase, summarised dialogue, or a fact the evidence clearly supports.

2. TRANSLATION & REGISTER. Decide whether the Hindi faithfully conveys the English
   in natural spoken Hinglish (18-28 Indian recap YouTuber register, all in Devanagari).
   Check each unit: meaning, facts, numbers and who-did-what preserved; nothing
   invented, added, dropped or merged; names follow the glossary; placeholders are
   structural, not content.
   REGISTER RULES: Devanagari English loanwords (पावर, लेवल, सिस्टम, पोर्टल, वॉर्निंग,
   मिशन, स्किल, अटैक, बॉस, लाइफ, आइडिया, डिसाइड करना, etc.) and spoken pronouns
   (वो/ये) are REQUIRED style - NEVER reject them or "correct" them back to pure
   Hindi. Flag a unit written in bookish, Sanskritized or news-style wording
   (वह/यह/किंतु/परंतु/अत्यधिक/प्रणाली/स्तर/निर्णय लेना/किया गया/द्वारा) and give the
   spoken Hinglish fix in Devanagari. Do not flag a single stray word in an
   otherwise spoken line.

SOURCE EVIDENCE (read-only; captions are fallible, dialogue is authoritative):
{evidence}

DETERMINISTIC ADVISORY FINDINGS (may be false positives - verify each):
{advisories}

ENGLISH UNITS:
{source}

HINDI UNITS:
{target}

GLOSSARY:
{glossary}

Reply STRICT JSON only:
{"verdict":"accept" or "reject",
 "issues":[{"unit":"u0001","reason":"specific problem"}]}
Use unit "source" for a source-fact problem that is not tied to one translated
unit. Accept only when the source claims are supported AND the translation is
faithful and in spoken Hinglish register.`;

export interface TranslationResult {
  units: string[];
  issues: LocaleScriptIssue[];
  warnings: string[];
  translatedScript: string;
  scriptHash: string;
  glossary: unknown;
}

function unitsForPrompt(parsed: ParsedLocaleScript): string {
  return JSON.stringify(
    parsed.units.map((u) => ({ id: u.id, beat: u.beat, text: u.template, source: u.spoken })),
    null,
    1,
  );
}

/**
 * Parse a translation answer with a STRICT unit contract: ids must match the
 * source ids exactly, in order. Extra, missing, duplicated or reordered units
 * are rejected rather than silently re-sorted into place.
 */
export function parseTranslationAnswer(
  raw: string,
  parsed: ParsedLocaleScript,
): { units: string[]; glossary: unknown } {
  const data = parseModelJson(raw);
  if (!isRecord(data) || !Array.isArray(data.units)) {
    throw new LocalizeError("translation answer has no units array", 502, "translation_shape");
  }
  const want = parsed.units.map((u) => u.id);
  const got: Array<{ id: string; text: string }> = [];
  for (const row of data.units) {
    if (!isRecord(row)) {
      throw new LocalizeError("translation answer has a non-object unit", 502, "translation_shape");
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const text = typeof row.text === "string" ? row.text : "";
    if (!id) throw new LocalizeError("translation answer has a unit without id", 502, "translation_shape");
    if (!text.trim()) throw new LocalizeError(`translation unit ${id} is empty`, 502, "translation_shape");
    got.push({ id, text });
  }
  if (got.length !== want.length) {
    throw new LocalizeError(
      `translation returned ${got.length} units but the script has ${want.length}`,
      502,
      "translation_missing_unit",
    );
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i]!.id !== want[i]) {
      throw new LocalizeError(
        `translation unit ${i + 1} must be ${want[i]}, got ${got[i]!.id} (units must not be reordered)`,
        502,
        "translation_order",
      );
    }
  }
  return { units: got.map((row) => row.text), glossary: data.glossary };
}

function validateHindiAnswer(
  parsed: ParsedLocaleScript,
  units: string[],
  glossary: Glossary,
): LocaleScriptIssue[] {
  const allowLatin = [...Object.values(glossary.names), ...Object.values(glossary.terms), "ok"];
  return validateTranslation(parsed, units, { allowLatin });
}

/** Header the English story writer puts on movie-mode scripts. */
const MOVIE_SCRIPT_HEADER = "# STORY_UNITS v1";

/** True when the English source is one chapter of a continuous movie narration. */
export function isMovieScript(scriptText: string | undefined | null): boolean {
  return String(scriptText ?? "").trimStart().startsWith(MOVIE_SCRIPT_HEADER);
}

/**
 * Movie-mode rule for the translation prompt. The units are translated 1:1, so
 * continuity is inherited from the English; this keeps the model from adding
 * the per-chapter framing an episode-style dub would have.
 */
export const MOVIE_CONTINUITY_RULE = `MOVIE MODE - this chapter is one part of a single continuous movie narration:
- Its first unit continues directly from the previous chapter's last line. Do NOT add an opening, greeting, welcome back, re-introduction of characters, "previously"/"पिछले चैप्टर में" recap, or a closing hook / "next time" teaser.
- Translate only what each unit says; no chapter titles or episode framing.`;

export interface TranslateChapterOptions {
  previousChapterEnding?: string;
}

const MAX_CONTINUITY_LINES = 8;
const MAX_CONTINUITY_CHARS = 1200;

function chapterNumber(ch: string): number {
  const m = /^ch(\d{1,4})$/.exec(String(ch ?? "").trim());
  return m ? Number.parseInt(m[1]!, 10) : NaN;
}

/**
 * Find the nearest earlier chapter (by number, across the whole locale dir)
 * that already has a finished Hindi script on disk, and return its last ~8
 * narration lines (~1200 chars max) stripped of controls/markup.
 */
export function previousChapterEndingFor(sdir: string, locale: string, ch: string): string {
  const targetNum = chapterNumber(ch);
  if (!Number.isInteger(targetNum) || targetNum <= 1) return "";
  const loc = validateLocale(locale);
  if (!loc) return "";
  const localeDir = path.join(languagesRoot(sdir), loc);
  let names: string[];
  try {
    names = fs.readdirSync(localeDir);
  } catch {
    return "";
  }
  const candidates = names
    .filter((name) => CHAPTER_RE.test(name))
    .map((name) => ({ name, num: chapterNumber(name) }))
    .filter((c) => Number.isInteger(c.num) && c.num > 0 && c.num < targetNum)
    .sort((a, b) => b.num - a.num || a.name.localeCompare(b.name));

  for (const cand of candidates) {
    let scriptFile: string;
    try {
      scriptFile = path.join(canonicalChapterDir(sdir, loc, cand.name), "script.md");
    } catch {
      continue;
    }
    if (!isRegularFile(scriptFile)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(scriptFile, "utf8");
    } catch {
      continue;
    }
    const parsed = parseLocaleScript(raw);
    const lines = parsed.units
      .map((u) =>
        u.spoken
          .replace(/⟦[^⟧]*⟧/g, " ")
          .replace(/\[[^\]]*\]/g, " ")
          .replace(/@p\d{4}_\d+/g, " ")
          .replace(/(?:^|\s)@hold(?=\s|$)/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((line) => line.length > 0 && /[\u0900-\u097F]/.test(line));
    if (lines.length === 0) continue;
    const tail = lines.slice(-MAX_CONTINUITY_LINES);
    const kept: string[] = [];
    let total = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i]!.slice(0, MAX_CONTINUITY_CHARS);
      const added = kept.length === 0 ? line.length : line.length + 1;
      if (kept.length > 0 && total + added > MAX_CONTINUITY_CHARS) break;
      kept.unshift(line);
      total += added;
    }
    const block = kept.join("\n").trim();
    if (block) return block;
  }
  return "";
}

/**
 * Translate one chapter. Deterministic validation runs before the semantic
 * review; only a translation that passes BOTH may be rendered.
 */
export async function translateChapter(
  sdir: string,
  locale: string,
  check: SourceCheck,
  translationKey: string,
  opts: TranslateChapterOptions = {},
): Promise<TranslationResult> {
  if (!check.parsed) throw new LocalizeError("source script was not parsed", 400, "source_invalid");
  const parsed = check.parsed;
  const glossary = readGlossary(sdir, locale);
  const ending = (opts.previousChapterEnding !== undefined
    ? opts.previousChapterEnding
    : previousChapterEndingFor(sdir, locale, check.chapter)).trim();
  const continuityBlock = ending
    ? `PREVIOUS CHAPTER ENDING (Hindi; for continuity of names, terms and tone only. Do not translate, repeat or continue it):\n${ending}\n\n`
    : "";
  const movieBlock = isMovieScript(check.scriptText) ? `${MOVIE_CONTINUITY_RULE}\n\n` : "";
  const prompt = TRANSLATE_PROMPT
    .replace("{context}", groundingContext(check))
    .replace("{glossary}", JSON.stringify(glossary, null, 1))
    .replace("ENGLISH UNITS (JSON):", () => `${movieBlock}${continuityBlock}ENGLISH UNITS (JSON):`)
    .replace("{units}", unitsForPrompt(parsed));

  const raw = await llm([{ role: "user", content: prompt }], {
    maxTokens: 8000,
    temperature: 0.2,
    lane: "writer",
    stage: "writer",
    tag: `localize ${locale}`,
    retries: 1,
  });
  let answer = parseTranslationAnswer(raw, parsed);
  let issues = validateHindiAnswer(parsed, answer.units, glossary);
  let units = answer.units;

  if (errorsOf(issues).length > 0) {
    const repair = `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED:\n${errorsOf(issues)
      .slice(0, 12)
      .map((i) => `- ${i.line ? `unit at line ${i.line}: ` : ""}${i.message}`)
      .join("\n")}\nResubmit the COMPLETE JSON, fixing only these problems.`;
    const raw2 = await llm([{ role: "user", content: repair }], {
      maxTokens: 8000,
      temperature: 0.1,
      lane: "writer",
      stage: "writer",
      tag: `localize ${locale} repair`,
      retries: 1,
    });
    // The REPAIRED answer owns the persisted glossary.
    answer = parseTranslationAnswer(raw2, parsed);
    units = answer.units;
    issues = validateHindiAnswer(parsed, units, glossary);
    if (errorsOf(issues).length > 0) {
      throw new LocalizeError(
        `Hindi translation failed structural validation: ${errorsOf(issues)[0]!.message}`,
        422,
        "translation_invalid",
      );
    }
  }

  const advisories = check.advisories ?? [];
  const reviewRaw = await llm(
    [
      {
        role: "user",
        content: REVIEW_PROMPT
          .replace("{evidence}", groundingContext(check))
          .replace(
            "{advisories}",
            advisories.length ? advisories.map((a) => `- ${a}`).join("\n") : "(none)",
          )
          .replace("{source}", unitsForPrompt(parsed))
          .replace(
            "{target}",
            JSON.stringify(parsed.units.map((u, i) => ({ id: u.id, text: units[i] ?? "" })), null, 1),
          )
          .replace("{glossary}", JSON.stringify(glossary, null, 1)),
      },
    ],
    {
      maxTokens: 4000,
      temperature: 0,
      lane: "writer",
      stage: "writer",
      tag: `localize ${locale} review`,
      retries: 1,
    },
  );
  const review = parseModelJson(reviewRaw);
  if (!isRecord(review) || (review.verdict !== "accept" && review.verdict !== "reject")) {
    throw new LocalizeError(
      "semantic review returned an invalid verdict; refusing to render an unverified translation",
      502,
      "translation_review_invalid",
    );
  }
  const reviewIssues = Array.isArray(review.issues) ? review.issues : [];
  if (review.verdict !== "accept" || reviewIssues.length > 0) {
    const first = isRecord(reviewIssues[0])
      ? `${String(reviewIssues[0].unit ?? "")}: ${String(reviewIssues[0].reason ?? "")}`
      : "semantic review rejected the translation";
    throw new LocalizeError(
      `Hindi translation failed semantic review: ${first.slice(0, 240)}`,
      422,
      "translation_review_rejected",
    );
  }

  const translatedScript = rebuildScript(parsed, units);
  return {
    units,
    issues,
    warnings: warningsOf(issues).map((i) => i.message),
    translatedScript,
    scriptHash: sha256Text(translatedScript),
    glossary: answer.glossary,
  };
}

/** Cache identity of a translated outro narration (same inputs that change a chapter translation). */
export function outroTranslationKey(sdir: string, locale: string, englishScript: string): string {
  return sha256Json({
    version: 1,
    kind: "outro",
    locale,
    prompt: TRANSLATION_PROMPT_VERSION,
    review: REVIEW_PROMPT_VERSION,
    script: sha256Text(englishScript),
    glossary: approvedGlossaryHash(sdir, locale),
    model: modelConfigIdentity(),
  });
}

/** One narration unit per sentence, so the translator's unit contract stays short and exact. */
export function outroScriptUnits(englishScript: string): string {
  const sentences = englishScript
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.join("\n") + "\n";
}

/**
 * Translate an outro narration with the chapter translator: the same v3
 * prompt, deterministic validation (`validateTranslation`) and independent
 * semantic review. The English text is a channel announcement, which the
 * grounding context says explicitly so the reviewer does not reject its calls
 * to action as "unsupported story facts".
 */
export async function translateOutroNarration(
  sdir: string,
  locale: string,
  englishScript: string,
): Promise<{ key: string; units: string[]; text: string; translatedScript: string; scriptHash: string; warnings: string[] }> {
  const loc = validateLocale(locale);
  if (!loc) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  const source = outroScriptUnits(englishScript);
  const parsed = parseLocaleScript(source);
  if (parsed.units.length === 0) {
    throw new LocalizeError("The outro has no narration to translate", 422, "outro_empty");
  }
  const bible = readJsonObject(path.join(sdir, "out", "bible.json")) ?? {};
  const check: SourceCheck = {
    eligible: true,
    chapter: "outro",
    parsed,
    scriptText: source,
    scriptHash: sha256Text(source),
    bible,
    obs: {
      events: [
        {
          event:
            "This is the channel's own outro announcement, not story narration: a recap of how many chapters were covered, " +
            "thanks to the viewers and a call to action. Its counts, titles and calls to action are supported by definition.",
        },
      ],
    },
    transcript: "",
    advisories: [],
    warnings: [],
  };
  const key = outroTranslationKey(sdir, loc, englishScript);
  const result = await translateChapter(sdir, loc, check, key, { previousChapterEnding: "" });
  return {
    key,
    units: result.units,
    text: result.units.map((u) => u.replace(/⟦[ETH]\d*⟧/g, " ").replace(/\s+/g, " ").trim()).join(" ").trim(),
    translatedScript: result.translatedScript,
    scriptHash: result.scriptHash,
    warnings: result.warnings,
  };
}

/**
 * Prove the localized script on disk is the reviewed output of THIS identity.
 * Any mismatch (edited file, different key, wrong unit count, structural break)
 * is a cache miss and forces a fresh translation.
 */
export function translationCacheValid(
  sdir: string,
  locale: string,
  check: SourceCheck,
  translationKey: string,
  record: LocaleChapterRecord | undefined,
  scriptFile: string,
): boolean {
  if (!record?.translation || record.translation.key !== translationKey) return false;
  if (!isRegularFile(scriptFile)) return false;
  if (sha256File(scriptFile) !== record.translation.scriptHash) return false;
  const parsed = parseLocaleScript(fs.readFileSync(scriptFile, "utf8"));
  const source = check.parsed;
  if (!source) return false;
  if (parsed.units.length !== source.units.length) return false;
  if (parsed.beats.join("\n") !== source.beats.join("\n")) return false;
  if (record.translation.unitCount !== parsed.units.length) return false;
  const glossary = readGlossary(sdir, locale);
  return errorsOf(validateHindiAnswer(source, parsed.units.map((u) => u.template), glossary)).length === 0;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

interface RendererModuleLike {
  produce: (
    sdir: string,
    ch: string,
    out: string,
    opts: Record<string, unknown>,
  ) => Promise<[string, number] | [string, number, string[]]>;
}

let rendererModule: RendererModuleLike | null = null;

async function loadRenderer(): Promise<RendererModuleLike> {
  if (rendererModule === null) {
    rendererModule = (await import("../workers/renderlane.js")) as unknown as RendererModuleLike;
  }
  return rendererModule;
}

function probeDuration(file: string): number {
  if (probeImpl) return probeImpl(file);
  if (!isRegularFile(file)) return 0;
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) return 0;
  const n = Number.parseFloat((res.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LocalizeError) {
    return err.code === "llm_parse" || err.code === "llm_empty" || err.statusCode === 429 || err.statusCode >= 500;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|timed out|429|503|502|connection|reset|temporarily|overload|econn|empty/.test(msg);
}

/** Rate limits, 5xx, timeouts and network drops heal with time; bad model output does not. */
function isTransientError(err: unknown): boolean {
  if (err instanceof LocalizeError) {
    if (/^(llm_|translation_)/.test(err.code)) return false;
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  return isRetryable(err);
}

interface EnglishSnapshot {
  script: string | null;
  video: string | null;
  narration: string;
  shots: string;
}

function fileFingerprint(file: string): string {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return "absent";
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

function snapshotEnglish(out: string, ch: string): EnglishSnapshot {
  const chDir = path.join(out, ch);
  const scriptFile = ["script_voice.md", "script_eleven.md", "script.md"]
    .map((n) => path.join(chDir, n))
    .find((f) => isRegularFile(f)) ?? null;
  const videoFile = path.join(chDir, "video", "video.mp4");
  return {
    script: scriptFile ? sha256File(scriptFile) : null,
    video: isRegularFile(videoFile) ? sha256File(videoFile) : null,
    narration: fileFingerprint(path.join(chDir, "video", "narration.mp3")),
    shots: fileFingerprint(path.join(chDir, "video", "shots.json")),
  };
}

function assertEnglishUnchanged(out: string, ch: string, before: EnglishSnapshot): void {
  const after = snapshotEnglish(out, ch);
  if (after.script !== before.script || after.video !== before.video
    || after.narration !== before.narration || after.shots !== before.shots) {
    throw new LocalizeError(
      "The locale renderer modified English artifacts; refusing to publish the language version.",
      502,
      "english_artifacts_mutated",
    );
  }
}

export interface RenderOutcome {
  video: string;
  duration: number;
  size: number;
  sha256: string;
  warnings: string[];
}

async function renderChapter(
  sdir: string,
  ch: string,
  locale: string,
  voice: string,
  speed: number,
  identity?: RenderVoiceIdentity,
): Promise<RenderOutcome> {
  const out = path.join(sdir, "out");
  const expectedDir = canonicalChapterDir(sdir, locale, ch);
  const expectedVideo = canonicalVideoPath(sdir, locale, ch);
  const produce = rendererImpl ?? (await loadRenderer()).produce;
  if (typeof produce !== "function") {
    throw new LocalizeError("The render lane does not expose produce()", 503, "renderer_missing");
  }
  const engine = identity?.engine ?? "edge";
  const englishBefore = snapshotEnglish(out, ch);
  const produced = (await produce(sdir, ch, out, {
    locale,
    tts: {
      engine,
      voice_id: voice,
      language: locale,
      speed,
      ...(engine === "edge"
        ? {}
        : { provider: identity?.provider ?? engine, model: identity?.modelId }),
    },
    lane: "local",
  })) as unknown;
  assertEnglishUnchanged(out, ch, englishBefore);
  const tuple = Array.isArray(produced) ? produced : [];
  const video = tuple[0];
  const duration = tuple[1];
  const rendererWarnings = Array.isArray(tuple[2])
    ? (tuple[2] as unknown[]).map((w) => String(w)).filter((w) => w.trim() !== "")
    : [];
  const videoAbs = path.resolve(String(video ?? ""));
  if (!isInside(expectedDir, videoAbs) || videoAbs !== expectedVideo) {
    throw new LocalizeError(
      `locale renderer returned ${path.basename(videoAbs) || "no path"} instead of the locale video; refusing to publish it`,
      502,
      "renderer_wrong_path",
    );
  }
  if (!isRegularFile(videoAbs)) {
    throw new LocalizeError("locale renderer produced no video file", 502, "renderer_no_output");
  }
  const probed = probeDuration(videoAbs);
  if (!(probed > 0)) {
    throw new LocalizeError("locale renderer produced an unreadable video", 502, "renderer_bad_video");
  }
  const size = fs.statSync(videoAbs).size;
  if (size <= 0) {
    throw new LocalizeError("locale renderer produced an empty video", 502, "renderer_bad_video");
  }
  const warnings: string[] = [...rendererWarnings];
  if (typeof duration === "number" && duration > 0 && Math.abs(duration - probed) > 2) {
    warnings.push(`renderer reported ${duration.toFixed(1)}s but ffprobe measured ${probed.toFixed(1)}s`);
  }
  return { video: videoAbs, duration: probed, size, sha256: sha256File(videoAbs), warnings };
}

/* ------------------------------------------------------------------ *
 * State lock + manifest transactions
 * ------------------------------------------------------------------ */

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Short cross-process transaction on the per-series localization state.
 * Synchronous on purpose: the critical section is a read-modify-write of a JSON
 * file, so no async waiter can deadlock the event loop.
 */
export function withStateLock<T>(sdir: string, fn: () => T): T {
  const file = stateLockPath(sdir);
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "a+", 0o664);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  try {
    for (;;) {
      if (tryFlockFd(fd, "ex", true)) break;
      if (Date.now() >= deadline) {
        throw new LocalizeError(
          "Language-version state is busy; try again in a moment",
          409,
          "state_busy",
        );
      }
      syncSleep(10);
    }
    return fn();
  } finally {
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
}

/**
 * Merge a chapter update into the manifest WITHOUT destroying the last good
 * artifact or translation proof. Called inside the state lock.
 */
export function mergeChapterRecord(
  sdir: string,
  locale: string,
  ch: string,
  patch: Partial<LocaleChapterRecord>,
): LocaleChapterRecord {
  const manifest = readManifest(sdir);
  const version = manifest.locales[locale] ?? { updatedAt: patch.updatedAt ?? nowIso(), chapters: {} };
  const previous = version.chapters[ch];
  const voice = patch.voice ?? previous?.voice;
  // Provider identity follows the saved voice: the catalog is the authority, so
  // a record can never claim Vertex for an Edge voice (or the reverse). A patch
  // that states the identity explicitly (a planned job) still wins. The catalog
  // is only consulted when something is still missing, so a steady-state write
  // stays cheap.
  const stated = {
    engine: patch.engine ?? previous?.engine,
    provider: patch.provider ?? previous?.provider,
    modelId: patch.modelId ?? previous?.modelId,
  };
  const derived = !stated.engine || !stated.provider || !stated.modelId
    ? (voice ? findVoice(locale, voice) : null)
    : null;
  const identity: Pick<LocaleChapterRecord, "engine" | "provider" | "modelId"> = {
    engine: stated.engine ?? (derived ? derived.engine : undefined),
    provider: stated.provider ?? (derived ? voiceProvider(derived) : undefined),
    modelId: stated.modelId ?? derived?.modelId,
  };
  const next: LocaleChapterRecord = {
    status: patch.status ?? previous?.status ?? "queued",
    stage: patch.stage ?? undefined,
    error: patch.error,
    updatedAt: patch.updatedAt ?? nowIso(),
    voice,
    speed: patch.speed ?? previous?.speed,
    ...identity,
    locale,
    artifact: patch.artifact ?? previous?.artifact,
    translation: patch.translation ?? previous?.translation,
    stale: patch.stale,
    warnings: patch.warnings,
  };
  version.chapters[ch] = next;
  version.updatedAt = next.updatedAt;
  manifest.locales[locale] = version;
  writeManifest(sdir, manifest);
  return next;
}

/** Verify a stored artifact still matches the file on disk. */
/**
 * Hash verification cache keyed by stat identity. The content hash is only
 * recomputed when dev/ino/size/mtime/ctime change, so a same-sized replacement
 * is still detected while GET/media/reuse stay cheap.
 */
const artifactHashCache = new Map<string, { identity: string; sha256: string }>();

export function _clearArtifactHashCache(): void {
  artifactHashCache.clear();
}

function artifactIdentity(file: string): { identity: string; size: number } | null {
  try {
    const st = fs.lstatSync(file, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return {
      identity: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`,
      size: Number(st.size),
    };
  } catch {
    return null;
  }
}

/** sha256 of the artifact bytes, reused only while the stat identity is stable. */
function artifactSha256(file: string, identity: string): string | null {
  const cached = artifactHashCache.get(file);
  if (cached && cached.identity === identity) return cached.sha256;
  try {
    const sha256 = sha256File(file);
    if (artifactHashCache.size > 256) artifactHashCache.clear();
    artifactHashCache.set(file, { identity, sha256 });
    return sha256;
  } catch {
    return null;
  }
}

/**
 * A published artifact is served/reused only when the file still exists at the
 * canonical path, matches the recorded size, AND hashes to the recorded digest.
 * A same-sized replacement is therefore never accepted.
 */
export function verifiedArtifact(artifact: LocaleArtifact | undefined): LocaleArtifact | null {
  if (!artifact) return null;
  const stat = artifactIdentity(artifact.video);
  if (!stat) return null;
  if (stat.size !== artifact.size) return null;
  const sha256 = artifactSha256(artifact.video, stat.identity);
  if (!sha256 || sha256 !== artifact.videoSha256) return null;
  const duration = probeDuration(artifact.video);
  if (!(duration > 0)) return null;
  return artifact;
}

/* ------------------------------------------------------------------ *
 * English pipeline conflict
 * ------------------------------------------------------------------ */

function activeIntakeJobs(slug: string): string | null {
  const dir = path.join(resolveOutDir(), "jobs");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = readJson(path.join(dir, name));
    if (!isRecord(raw)) continue;
    if (String(raw.slug ?? "") !== slug) continue;
    const status = String(raw.status ?? "");
    if (["queued", "paused", "downloading", "ingesting", "running"].includes(status)) {
      return String(raw.id ?? name.replace(/\.json$/, ""));
    }
  }
  return null;
}

/** English pipeline conflict: intake jobs + live pipeline processes for this slug. */
export function englishPipelineConflict(slug: string): string | null {
  const active = activeIntakeJobs(slug);
  if (active) {
    return `the English pipeline has an active job for ${slug} (${active}); wait for it to finish`;
  }
  try {
    const runs = detectActivePipelineRuns();
    const hit = runs.find((r) => r.series === slug);
    if (hit) {
      return `the English pipeline is writing ${slug} right now (PID ${hit.pid}); wait for it to finish`;
    }
  } catch {
    // Unreadable process table: the shared series lock still guards deletion.
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Job reconciliation
 * ------------------------------------------------------------------ */

/**
 * Mark dead `running` jobs `interrupted` and never-started `queued` jobs
 * `interrupted` after the grace period, updating the job record AND the
 * manifest attempt status in ONE state transaction. The last good artifact is
 * preserved and marked stale.
 */
export function reconcileLocalizeJobs(sdir: string, now: () => Date = () => new Date()): void {
  withStateLock(sdir, () => reconcileLocked(sdir, now));
}

/* ------------------------------------------------------------------ *
 * Job-level auto-retry (mirrors the English pipeline's intake queue)
 * ------------------------------------------------------------------ */

/** Same switches as the intake queue: Studio autoRetry, MANHWA_AUTO_RETRY=0, delay overrides. */
function autoRetryPolicy(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  max: number;
  delaysS: number[];
  resumeDelayS: number;
} {
  let settings = { enabled: true, maxRetries: 3 };
  try {
    settings = getStudioSettings(resolveOutDir()).autoRetry;
  } catch {
    // unreadable settings keep the defaults
  }
  const parsed = env.MANHWA_AUTO_RETRY_DELAYS_S
    ? env.MANHWA_AUTO_RETRY_DELAYS_S.split(",").map((v) => (v.trim() === "" ? NaN : Number(v)))
    : [];
  const resumeRaw = env.MANHWA_AUTO_RESUME_DELAY_S;
  const resume = resumeRaw === undefined || resumeRaw.trim() === "" ? 120 : Number(resumeRaw);
  return {
    enabled: settings.enabled && env.MANHWA_AUTO_RETRY !== "0",
    max: Math.min(3, settings.maxRetries),
    delaysS: parsed.length && parsed.every((v) => Number.isFinite(v) && v >= 0) ? parsed : [600, 1800, 3600],
    resumeDelayS: Number.isFinite(resume) && resume >= 0 ? resume : 120,
  };
}

/** Chapters of a job that did not finish (a missing progress row counts as unfinished). */
export function unfinishedChapters(job: LocalizeJobRecord): string[] {
  return job.chapters.filter((ch) => job.progress?.[ch]?.status !== "completed");
}

/** Newest job for a locale: only it may carry a pending auto-retry. */
function latestJobFor(jobs: readonly LocalizeJobRecord[], locale: string): LocalizeJobRecord | null {
  let latest: LocalizeJobRecord | null = null;
  for (const job of jobs) {
    if (job.locale === locale) latest = job;
  }
  return latest;
}

/**
 * Jobs planned before auto-retry existed carry no count: an old failure is
 * never revived, including a legacy worker that dies during deployment.
 */
function canAutoRetry(
  job: LocalizeJobRecord,
  policy: ReturnType<typeof autoRetryPolicy>,
): boolean {
  if (!Number.isInteger(job.autoRetryCount)) return false;
  if (job.status !== "failed" && job.status !== "interrupted") return false;
  return policy.enabled && (job.autoRetryCount ?? 0) < policy.max && unfinishedChapters(job).length > 0;
}

/**
 * Decide, once, whether the newest failed/interrupted job of each locale gets
 * an automatic retry. Runs inside the state lock. `null` records "no retry".
 */
function scheduleAutoRetriesLocked(sdir: string, deadIds: ReadonlySet<string>): void {
  const policy = autoRetryPolicy();
  if (!policy.enabled) return;
  const jobs = listJobs(sdir);
  for (const locale of new Set(jobs.map((j) => j.locale))) {
    const job = latestJobFor(jobs, locale);
    if (!job || job.nextAutoRetryAt !== undefined) continue;
    if (job.status !== "failed" && job.status !== "interrupted") continue;
    const count = job.autoRetryCount ?? 0;
    // A worker that died (crash, OOM, service restart) resumes as soon as the
    // English queue resumes its runs; a job that ran and failed backs off.
    const delayS = deadIds.has(job.id)
      ? policy.resumeDelayS
      : policy.delaysS[Math.min(count, policy.delaysS.length - 1)]!;
    writeJob(sdir, {
      ...job,
      nextAutoRetryAt: canAutoRetry(job, policy)
        ? new Date(Date.parse(job.updatedAt) + delayS * 1000).toISOString()
        : null,
    });
  }
}

/** Jobs whose automatic retry is due now (newest job per locale only). */
export function dueAutoRetries(sdir: string, now: () => Date = () => new Date()): LocalizeJobRecord[] {
  const policy = autoRetryPolicy();
  const jobs = listJobs(sdir);
  const t = now().getTime();
  const due: LocalizeJobRecord[] = [];
  for (const locale of new Set(jobs.map((j) => j.locale))) {
    const job = latestJobFor(jobs, locale);
    if (job?.nextAutoRetryAt && canAutoRetry(job, policy) && Date.parse(job.nextAutoRetryAt) <= t) due.push(job);
  }
  return due;
}

/** Give up on a pending auto-retry (a permanent pre-start rejection), keeping the reason. */
export function dropAutoRetry(sdir: string, jobId: string, reason: string): void {
  withStateLock(sdir, () => {
    const job = readJob(sdir, jobId);
    if (!job?.nextAutoRetryAt) return;
    writeJob(sdir, {
      ...job,
      nextAutoRetryAt: null,
      error: `${job.error ? `${job.error.slice(0, 250)} ` : ""}Automatic retry stopped: ${reason}`.slice(0, 500),
    });
  });
}

function reconcileLocked(sdir: string, now: () => Date): void {
  scheduleAutoRetriesLocked(sdir, reconcileDeadLocked(sdir, now));
}

/** Mark dead jobs interrupted; returns the ids it just marked. */
function reconcileDeadLocked(sdir: string, now: () => Date): Set<string> {
  const dead = new Set<string>();
  const jobs = listJobs(sdir);
  if (jobs.length === 0) return dead;
  const t = now().getTime();
  for (const job of jobs) {
    if (job.status !== "running" && job.status !== "queued") continue;
    const alive = pidAlive(job.pid, job.pidStart, job.pidBootId);
    const age = t - Date.parse(job.updatedAt || job.createdAt);
    let patch: Partial<LocalizeJobRecord> | null = null;
    if (job.status === "running" && !alive) {
      patch = {
        status: "interrupted",
        error:
          "The language-version worker exited before finishing. Retry to resume from the last completed chapter.",
        pid: null,
        pidStart: null,
      };
    } else if (job.status === "queued" && !alive && age > QUEUED_GRACE_MS) {
      patch = {
        status: "interrupted",
        error: "The queued language-version job was never started (server restart). Retry to run it.",
        pid: null,
        pidStart: null,
      };
    }
    if (!patch) continue;
    const progress = { ...(job.progress ?? {}) };
    for (const ch of job.chapters) {
      const row = progress[ch];
      if (!row || row.status === "completed") continue;
      if (row.status === "running" || row.status === "queued") {
        progress[ch] = {
          status: "interrupted",
          stage: row.stage,
          error: patch.error,
          updatedAt: nowIso(now),
        };
      }
    }
    const updated: LocalizeJobRecord = { ...job, ...patch, progress, updatedAt: nowIso(now) };
    writeJob(sdir, updated);
    dead.add(job.id);
    for (const ch of job.chapters) {
      const progress = job.progress?.[ch];
      if (progress?.status === "completed") continue;
      mergeChapterRecord(sdir, job.locale, ch, {
        status: "interrupted",
        stage: progress?.stage,
        error: patch.error,
        updatedAt: updated.updatedAt,
        stale: true,
      });
    }
  }
  return dead;
}

/* ------------------------------------------------------------------ *
 * Job execution
 * ------------------------------------------------------------------ */

/**
 * Effective render identity of a persisted job.
 *
 * A new job stores engine/provider/modelId at planning time. An OLDER job (or a
 * record whose catalog entry changed) falls back to the catalog, and finally to
 * Edge, which is what every pre-Vertex job actually rendered with. Nothing here
 * needs a network call, so a restart or retry resolves the same identity.
 */
export function jobVoiceIdentity(
  job: Pick<LocalizeJobRecord, "locale" | "voice" | "engine" | "provider" | "modelId">,
  env?: NodeJS.ProcessEnv,
): RenderVoiceIdentity {
  const engine = job.engine === "vertex" ? "vertex" : job.engine === "edge" ? "edge" : null;
  const catalogVoice = findVoice(job.locale, job.voice, env);
  const catalogEngine = catalogVoice?.engine === "vertex"
    ? "vertex"
    : catalogVoice?.engine === "edge"
      ? "edge"
      : null;
  const resolvedEngine = engine ?? catalogEngine ?? "edge";
  const provider = job.provider
    ?? (catalogVoice ? voiceProvider(catalogVoice) : resolvedEngine);
  const modelId = job.modelId ?? catalogVoice?.modelId ?? provider;
  return {
    engine: resolvedEngine,
    provider,
    modelId,
    locale: job.locale,
  };
}

export interface RunJobOptions {
  now?: () => Date;
  log?: (msg: string) => void;
  /** Skip the English-pipeline probe (tests that own the fixture). */
  skipPipelineConflictCheck?: boolean;
  signal?: AbortSignal;
}

export interface RunJobResult {
  status: LocaleChapterStatus;
  chapters: Record<string, LocaleChapterStatus>;
  error?: string;
}

function acquireJobLock(sdir: string): number {
  const file = jobLockPath(sdir);
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "a+", 0o664);
  if (!tryFlockFd(fd, "ex", true)) {
    fs.closeSync(fd);
    throw new LocalizeError(
      "Another language-version job is already running for this series",
      409,
      "localize_busy",
    );
  }
  return fd;
}

/** True while another process (or request) holds the locale export lock. */
export function localeExportBusy(sdir: string, locale: string): boolean {
  const file = exportLockPath(sdir, locale);
  if (!isRegularFileOrEmpty(file)) return false;
  const fd = fs.openSync(file, "a+", 0o664);
  try {
    if (!tryFlockFd(fd, "ex", true)) return true;
    return false;
  } finally {
    releaseFd(fd);
  }
}

function isRegularFileOrEmpty(file: string): boolean {
  try {
    assertNoSymlinksStore(file);
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Run a locale merge/outro with the export lock held. The "no active language
 * job" check and the lock acquisition happen inside the state lock, the same
 * transaction `planLocalizeJob` uses, so a job and an export can never overlap.
 */
export async function withLocaleExportLock<T>(
  sdir: string,
  locale: string,
  kind: "merge" | "outro",
  fn: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const release = acquireLocaleExportLock(sdir, locale, kind, now);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Take the locale export lock and return its release function, so background
 * work can hold it past the HTTP request. The lock is a kernel `flock` on an
 * open descriptor: if this process dies, the kernel drops it, so a crash can
 * never leave the export permanently busy.
 */
export function acquireLocaleExportLock(
  sdir: string,
  locale: string,
  kind: "merge" | "outro",
  now: () => Date = () => new Date(),
  /** Runs inside the state lock once the export lock is held (e.g. persist "running"). */
  inLock?: () => void,
): () => void {
  const file = exportLockPath(sdir, locale);
  const marker = exportMarkerPath(sdir, locale);
  const fd = withStateLock(sdir, () => {
    reconcileLocked(sdir, now);
    const active = listJobs(sdir).find(
      (j) => j.locale === locale && (j.status === "running" || j.status === "queued"),
    );
    if (active) {
      throw new LocalizeError(
        "Hindi chapters are still rendering. Wait for the language job to finish.",
        409,
        "job_active",
        `job ${active.id} is ${active.status}`,
      );
    }
    ensureDir(path.dirname(file));
    assertNoSymlinksStore(file);
    const handle = fs.openSync(file, "a+", 0o664);
    // A status read probes the same lock for a few milliseconds; a short retry
    // keeps that probe from reading as "another export is running".
    let locked = false;
    for (let i = 0; i < 5 && !locked; i++) {
      locked = tryFlockFd(handle, "ex", true);
      if (!locked) syncSleep(10);
    }
    if (!locked) {
      fs.closeSync(handle);
      throw new LocalizeError(
        "A merge or outro is already running for this language. Wait for it to finish.",
        409,
        "export_busy",
      );
    }
    try {
      inLock?.();
    } catch (err) {
      releaseFd(handle);
      throw err;
    }
    return handle;
  });
  try {
    writeJsonAtomic(marker, { kind, startedAt: nowIso(now), pid: process.pid });
  } catch {
    // The marker only labels the busy state; the lock itself is authoritative.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseFd(fd);
  };
}

function exportMarkerPath(sdir: string, locale: string): string {
  return path.join(path.dirname(exportLockPath(sdir, locale)), ".export.json");
}

/** What holds the export lock right now, or null when nothing does. */
export function localeExportActivity(sdir: string, locale: string): "merge" | "outro" | null {
  if (!localeExportBusy(sdir, locale)) return null;
  const raw = readJson(exportMarkerPath(sdir, locale));
  const kind = isRecord(raw) ? raw.kind : null;
  return kind === "outro" ? "outro" : "merge";
}

/** Back-off sleep through the same seam the job runner uses (instant in tests). */
export function localizeSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepImpl(ms, signal);
}

/** Transient provider/network failure worth one more bounded attempt. */
export function isRetryableLocalizeError(err: unknown): boolean {
  return isRetryable(err);
}

/**
 * Synthesize localized narration with the same engines (and test seams) the
 * language preview uses. Vertex receives the locale, so its own text prep
 * (`localizedSpeechText`) applies; Edge gets the same prep here.
 */
export async function synthesizeLocaleNarration(opts: {
  text: string;
  dest: string;
  locale: string;
  engine: "edge" | "vertex";
  voice: string;
  speed: number;
  signal: AbortSignal;
}): Promise<void> {
  if (opts.engine === "vertex") {
    const synthesize = vertexPreviewSynthImpl ?? synthesizeVertexTtsToFile;
    await synthesize({
      text: opts.text,
      voiceId: opts.voice,
      destPath: opts.dest,
      speed: opts.speed,
      env: process.env,
      locale: opts.locale,
      signal: opts.signal,
    });
    return;
  }
  const rate = opts.speed === 1
    ? "+0%"
    : `${opts.speed > 1 ? "+" : "-"}${Math.round(Math.abs(opts.speed - 1) * 100)}%`;
  await synthesizePreview(localizedSpeechText(opts.text), opts.dest, opts.voice, rate, opts.signal);
}

function releaseFd(fd: number): void {
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

/** Write job + per-chapter attempt state in one state transaction. */
function updateJob(
  sdir: string,
  job: LocalizeJobRecord,
  patch: Partial<LocalizeJobRecord>,
  now: () => Date,
): LocalizeJobRecord {
  return withStateLock(sdir, () => {
    if (patch.status === "running") {
      const current = readJob(sdir, job.id);
      if (!current || latestJobFor(listJobs(sdir), job.locale)?.id !== job.id ||
          (current.status === "interrupted" && current.nextAutoRetryAt !== undefined)) {
        throw new LocalizeError("Language-version job was superseded before its worker started", 409, "job_superseded");
      }
    }
    const next: LocalizeJobRecord = {
      ...job,
      ...patch,
      progress: { ...(job.progress ?? {}), ...(patch.progress ?? {}) },
      updatedAt: nowIso(now),
    };
    writeJob(sdir, next);
    Object.assign(job, next);
    return next;
  });
}

function setProgress(
  sdir: string,
  job: LocalizeJobRecord,
  ch: string,
  status: LocaleChapterStatus,
  stage: LocaleStage | undefined,
  now: () => Date,
  error?: string,
): void {
  updateJob(sdir, job, {
    chapter: ch,
    stage,
    progress: {
      [ch]: { status, stage, error, updatedAt: nowIso(now) },
    },
  }, now);
}

/**
 * Run one persisted job in THIS process. The whole job holds a SHARED series
 * lock (compatible with the renderer's own shared lock, and it blocks the
 * library's exclusive delete) plus the localization job lock.
 */
export async function runLocalizeJob(
  sdir: string,
  jobId: string,
  opts: RunJobOptions = {},
): Promise<RunJobResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));
  const job = readJob(sdir, jobId);
  if (!job) throw new LocalizeError("Language-version job not found", 404, "job_not_found");
  if (job.status === "completed") return { status: "completed", chapters: {} };
  if (job.status === "running" && pidAlive(job.pid, job.pidStart, job.pidBootId) && job.pid !== process.pid) {
    throw new LocalizeError("Language-version job is already running", 409, "job_busy");
  }
  const slug = path.basename(sdir);
  if (!opts.skipPipelineConflictCheck) {
    const conflict = englishPipelineConflict(slug);
    if (conflict) {
      updateJob(sdir, job, {
        status: "interrupted",
        error: `Cannot start while ${conflict}.`,
        pid: null,
        pidStart: null,
      }, now);
      throw new LocalizeError(`Cannot start while ${conflict}.`, 409, "pipeline_conflict");
    }
  }

  return withSharedSeriesLock(sdir, async () => {
    const lockFd = acquireJobLock(sdir);
    const results: Record<string, LocaleChapterStatus> = {};
    try {
      // Every selected chapter gets an explicit attempt row, including the ones
      // this run has not reached yet, so the API never shows a stale status.
      const progress: Record<string, { status: LocaleChapterStatus; updatedAt: string }> = {};
      for (const ch of job.chapters) {
        const previous = job.progress?.[ch];
        progress[ch] = {
          status: previous?.status === "completed" ? "completed" : "queued",
          updatedAt: nowIso(now),
        };
      }
      updateJob(sdir, job, {
        status: "running",
        stage: "validate",
        error: undefined,
        chapter: undefined,
        pid: process.pid,
        pidStart: procStartTicks(process.pid),
        pidBootId: procBootId(),
        progress,
      }, now);

      for (const ch of job.chapters) {
        if (job.progress?.[ch]?.status === "completed") {
          results[ch] = "completed";
          continue;
        }
        setProgress(sdir, job, ch, "running", "validate", now);
        const record = readManifest(sdir).locales[job.locale]?.chapters[ch];
        const check = checkSourceChapter(sdir, ch);
        if (!check.eligible) {
          mergeChapterRecord(sdir, job.locale, ch, {
            status: "failed",
            stage: "validate",
            error: check.reason ?? "source not eligible",
            updatedAt: nowIso(now),
            voice: job.voice,
            speed: job.speed,
            stale: Boolean(record?.artifact),
            warnings: check.warnings.length ? check.warnings : undefined,
          });
          setProgress(sdir, job, ch, "failed", "validate", now, check.reason ?? "source not eligible");
          results[ch] = "failed";
          log(`[localize] ${ch}: source not eligible - ${check.reason}`);
          continue;
        }

        const translationKey = translationKeyFor(check, job.locale, sdir);
        const config = renderConfig(sdir, check);
        const identity = jobVoiceIdentity(job);
        const renderKey = renderKeyFor(translationKey, job.voice, job.speed, config, identity);
        const chapterDir = canonicalChapterDir(sdir, job.locale, ch);
        ensureDir(chapterDir);
        const scriptOut = path.join(chapterDir, "script.md");

        // Already published with the exact current identity: nothing to do.
        const artifact = verifiedArtifact(record?.artifact);
        if (artifact && artifact.renderKey === renderKey && artifact.voice === job.voice
          && artifact.speed === job.speed && record?.status === "completed"
          && translationCacheValid(sdir, job.locale, check, translationKey, record, scriptOut)) {
          mergeChapterRecord(sdir, job.locale, ch, {
            status: "completed",
            stage: "verify",
            updatedAt: nowIso(now),
            voice: job.voice,
            speed: job.speed,
            ...identity,
            artifact,
            stale: undefined,
          });
          setProgress(sdir, job, ch, "completed", "verify", now);
          results[ch] = "completed";
          log(`[localize] ${ch}: verified render reused`);
          continue;
        }

        let attempts = job.attempts[ch] ?? 0;
        let lastError: unknown = null;
        let done = false;
        while (attempts < MAX_ATTEMPTS && !done) {
          attempts += 1;
          job.attempts[ch] = attempts;
          try {
            setProgress(sdir, job, ch, "running", "translate", now);
            mergeChapterRecord(sdir, job.locale, ch, {
              status: "running",
              stage: "translate",
              updatedAt: nowIso(now),
              voice: job.voice,
              speed: job.speed,
              stale: Boolean(record?.artifact && record.artifact.renderKey !== renderKey),
            });

            let translated: { scriptHash: string; warnings: string[] } | null = null;
            const currentRecord = readManifest(sdir).locales[job.locale]?.chapters[ch];
            if (translationCacheValid(sdir, job.locale, check, translationKey, currentRecord, scriptOut)) {
              translated = { scriptHash: currentRecord!.translation!.scriptHash, warnings: [] };
              log(`[localize] ${ch}: reviewed translation cache reused`);
            } else {
              const previousChapterEnding = previousChapterEndingFor(sdir, job.locale, ch);
              const result = await translateChapter(sdir, job.locale, check, translationKey, {
                previousChapterEnding,
              });
              const tmp = `${scriptOut}.${process.pid}.tmp`;
              fs.writeFileSync(tmp, result.translatedScript, { mode: 0o644 });
              fs.renameSync(tmp, scriptOut);
              // Persist the REPAIRED answer's glossary, never the first one.
              mergeGlossary(sdir, job.locale, result.glossary);
              translated = { scriptHash: result.scriptHash, warnings: result.warnings };
              mergeChapterRecord(sdir, job.locale, ch, {
                status: "running",
                stage: "translate",
                updatedAt: nowIso(now),
                translation: {
                  key: translationKey,
                  scriptHash: result.scriptHash,
                  unitCount: check.parsed!.units.length,
                  reviewedAt: nowIso(now),
                },
                voice: job.voice,
                speed: job.speed,
                warnings: result.warnings.length ? result.warnings : undefined,
              });
            }

            setProgress(sdir, job, ch, "running", "render", now);
            mergeChapterRecord(sdir, job.locale, ch, {
              status: "running",
              stage: "render",
              updatedAt: nowIso(now),
              voice: job.voice,
              speed: job.speed,
              ...identity,
            });
            if (!opts.skipPipelineConflictCheck) {
              const conflict = englishPipelineConflict(slug);
              if (conflict) {
                throw new LocalizeError(`Cannot render while ${conflict}.`, 409, "pipeline_conflict");
              }
            }

            const outcome = await renderChapter(sdir, ch, job.locale, job.voice, job.speed, identity);
            const warnings = [...check.warnings, ...(translated?.warnings ?? []), ...outcome.warnings];
            const previousRevision = record?.artifact?.revision ?? 0;
            const nextArtifact: LocaleArtifact = {
              video: outcome.video,
              duration: outcome.duration,
              size: outcome.size,
              videoSha256: outcome.sha256,
              renderKey,
              voice: job.voice,
              speed: job.speed,
              engine: identity.engine,
              provider: identity.provider,
              modelId: identity.modelId,
              locale: job.locale,
              revision: previousRevision + 1,
              publishedAt: nowIso(now),
            };
            mergeChapterRecord(sdir, job.locale, ch, {
              status: "completed",
              stage: "verify",
              updatedAt: nowIso(now),
              translation: {
                key: translationKey,
                scriptHash: translated!.scriptHash,
                unitCount: check.parsed!.units.length,
                reviewedAt: nowIso(now),
              },
              artifact: nextArtifact,
              voice: job.voice,
              speed: job.speed,
              ...identity,
              stale: undefined,
              warnings: warnings.length ? warnings : undefined,
            });
            setProgress(sdir, job, ch, "completed", "verify", now);
            results[ch] = "completed";
            done = true;
            log(`[localize] ${ch}: completed ${outcome.duration.toFixed(1)}s`);
          } catch (err) {
            lastError = err;
            const message = err instanceof Error ? err.message : String(err);
            if (!isRetryable(err) || attempts >= MAX_ATTEMPTS) {
              mergeChapterRecord(sdir, job.locale, ch, {
                status: "failed",
                stage: job.stage ?? "render",
                error: message.slice(0, 500),
                updatedAt: nowIso(now),
                voice: job.voice,
                speed: job.speed,
                stale: Boolean(record?.artifact),
              });
              setProgress(sdir, job, ch, "failed", job.stage ?? "render", now, message.slice(0, 500));
              results[ch] = "failed";
              updateJob(sdir, job, {
                attempts: { ...job.attempts },
                error: message.slice(0, 500),
              }, now);
              log(`[localize] ${ch}: FAILED - ${message.slice(0, 200)}`);
              break;
            }
            const waits = isTransientError(err) ? RETRY_WAIT_MS : MODEL_RETRY_WAIT_MS;
            const waitMs = waits[attempts - 1] ?? waits[waits.length - 1]!;
            log(`[localize] ${ch}: attempt ${attempts} failed (${message.slice(0, 160)}); retrying in ${Math.round(waitMs / 1000)}s`);
            if (opts.signal?.aborted) {
              throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted");
            }
            await sleepImpl(waitMs, opts.signal);
            if (opts.signal?.aborted) {
              throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted");
            }
          }
        }
        if (!done) {
          results[ch] = results[ch] ?? "failed";
          updateJob(sdir, job, {
            attempts: { ...job.attempts },
            error: (lastError instanceof Error ? lastError.message : "language version failed").slice(0, 500),
          }, now);
        }
      }

      const values = job.chapters.map((ch) => results[ch] ?? "failed");
      const allOk = values.every((v) => v === "completed");
      const status: LocaleChapterStatus = allOk ? "completed" : "failed";
      updateJob(sdir, job, {
        status,
        stage: undefined,
        chapter: undefined,
        pid: null,
        pidStart: null,
        error: allOk ? undefined : job.error ?? "one or more chapters failed; retry to resume",
      }, now);
      return { status, chapters: results, error: job.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateJob(sdir, job, {
        status: "interrupted",
        error: message.slice(0, 500),
        pid: null,
        pidStart: null,
      }, now);
      throw err;
    } finally {
      releaseFd(lockFd);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Planning (cross-process transaction)
 * ------------------------------------------------------------------ */

export interface PlanLocalizeInput {
  locale: string;
  chapters: string;
  voice: string;
  speed?: number;
  /** Server-only: the failed job whose pending automatic retry this plan runs. */
  autoRetryOf?: string;
}

export interface PlannedJob {
  job: LocalizeJobRecord;
  existing: boolean;
}

/** Same speed validation as the job POST (0.5-2, two decimals). */
export function clampLocaleSpeed(raw: unknown): number {
  return clampSpeed(raw);
}

function clampSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 1);
  if (!Number.isFinite(n)) throw new LocalizeError("speed must be a finite number", 400, "invalid_speed");
  const clamped = Math.round(n * 100) / 100;
  if (clamped < 0.5 || clamped > 2) {
    throw new LocalizeError("speed must be between 0.5 and 2", 400, "invalid_speed");
  }
  return clamped;
}

/**
 * Validate a request and persist a job in ONE state transaction, so two
 * concurrent requests can never both pass the "no active job" check.
 */
export async function planLocalizeJob(
  sdir: string,
  input: PlanLocalizeInput,
  now: () => Date = () => new Date(),
): Promise<PlannedJob> {
  const locale = validateLocale(input.locale);
  if (!locale) {
    const supported = catalogEntries().map((e) => e.locale).join(", ") || "none";
    throw new LocalizeError(
      `Unsupported language ${JSON.stringify(String(input.locale ?? ""))}. Supported: ${supported}`,
      400,
      "unsupported_locale",
    );
  }
  const entry: LanguageCatalogEntry | null = catalogEntry(locale);
  if (!entry) throw new LocalizeError("Language catalog entry missing", 400, "unsupported_locale");
  // Preflight BEFORE any translation spend: the voice, its engine AND its
  // provider credentials are validated here. A missing Vertex credential is an
  // actionable 400, never a silent Edge substitution.
  let resolved: ResolvedVoice;
  try {
    resolved = resolveVoice(locale, input.voice);
  } catch (err) {
    if (err instanceof UnsupportedVoiceError) {
      throw new LocalizeError(err.message, err.statusCode, err.code);
    }
    throw err;
  }
  const voice = resolved.voice;
  const speed = clampSpeed(input.speed ?? 1);
  const chapters = parseChapterSelection(input.chapters, availableChapters(sdir));
  if (chapters.length === 0) {
    throw new LocalizeError("This series has no chapter folders to localize", 422, "no_chapters");
  }
  const ineligible: string[] = [];
  for (const ch of chapters) {
    const check = checkSourceChapter(sdir, ch);
    if (!check.eligible) ineligible.push(`${ch}: ${check.reason ?? "source not eligible"}`);
  }
  if (ineligible.length > 0) {
    throw new LocalizeError(
      `Cannot create a language version yet. ${ineligible.slice(0, 4).join(" | ")}`,
      422,
      "source_not_eligible",
    );
  }
  const slug = path.basename(sdir);
  const conflict = englishPipelineConflict(slug);
  if (conflict) {
    throw new LocalizeError(`Cannot start a language version while ${conflict}.`, 409, "pipeline_conflict");
  }

  return withStateLock(sdir, () => {
    // Re-read under the lock: another request may have created a job meanwhile.
    reconcileLocked(sdir, now);
    const active = listJobs(sdir).find((j) => j.status === "running" || j.status === "queued");
    if (active) {
      throw new LocalizeError(
        `A language-version job is already ${active.status} for this series (${active.id}); wait for it to finish.`,
        409,
        "job_active",
      );
    }
    // A merge or outro render reads the published chapter videos: no new job
    // may replace them until it finishes (checked under the state lock, which
    // the export also takes before it starts).
    if (localeExportBusy(sdir, locale)) {
      throw new LocalizeError(
        "The language version is being merged or its outro is rendering; try again when it finishes.",
        409,
        "export_busy",
      );
    }
    let autoRetryCount = 0;
    if (input.autoRetryOf) {
      // The pending retry must still belong to the newest job of this locale:
      // a manual retry or new job in between drops it.
      const source = readJob(sdir, input.autoRetryOf);
      if (!source?.nextAutoRetryAt || latestJobFor(listJobs(sdir), locale)?.id !== source.id) {
        throw new LocalizeError("The automatic retry was superseded", 409, "auto_retry_superseded");
      }
      if (!canAutoRetry(source, autoRetryPolicy()) || Date.parse(source.nextAutoRetryAt) > now().getTime()) {
        throw new LocalizeError("The automatic retry is no longer eligible", 409, "auto_retry_superseded");
      }
      if (chapters.join(",") !== unfinishedChapters(source).join(",") || source.voice !== voice.id || source.speed !== speed ||
          jobVoiceIdentity(source).engine !== resolved.engine || jobVoiceIdentity(source).provider !== resolved.provider ||
          jobVoiceIdentity(source).modelId !== resolved.modelId) {
        throw new LocalizeError("Saved retry settings or unfinished chapters changed; generate again to choose settings", 409, "auto_retry_changed");
      }
      autoRetryCount = (source.autoRetryCount ?? 0) + 1;
    }
    // Any new job for this locale, manual or automatic, replaces a pending retry.
    for (const old of listJobs(sdir)) {
      if (old.locale === locale && old.nextAutoRetryAt) writeJob(sdir, { ...old, nextAutoRetryAt: null });
    }
    const job: LocalizeJobRecord = {
      schemaVersion: 1,
      id: newJobId(),
      slug,
      locale,
      chapters,
      voice: voice.id,
      speed,
      // Authoritative identity: a restart or retry renders the SAME provider and
      // model, even if the catalog later gains another voice with this id.
      engine: resolved.engine,
      provider: resolved.provider,
      modelId: resolved.modelId,
      status: "queued",
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      attempts: {},
      progress: Object.fromEntries(
        chapters.map((ch) => [ch, { status: "queued" as LocaleChapterStatus, updatedAt: nowIso(now) }]),
      ),
      autoRetryCount,
    };
    writeJob(sdir, job);
    return { job, existing: false };
  });
}

/* ------------------------------------------------------------------ *
 * State for the HTTP contract
 * ------------------------------------------------------------------ */

function aggregateStatus(statuses: readonly LocaleChapterStatus[]): LocaleChapterStatus {
  if (statuses.length === 0) return "queued";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "queued")) return "queued";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "interrupted")) return "interrupted";
  return "completed";
}

export function videoUrlFor(slug: string, locale: string, ch: string, revision?: number): string {
  const base = `/media/${encodeURIComponent(slug)}/languages/${encodeURIComponent(locale)}/${encodeURIComponent(
    ch,
  )}/video.mp4`;
  return revision && revision > 0 ? `${base}?rev=${revision}` : base;
}

/** Attempt status for one chapter: the LATEST job that selected it wins. */
function attemptFor(
  jobs: readonly LocalizeJobRecord[],
  locale: string,
  ch: string,
): { status: LocaleChapterStatus; stage?: LocaleStage; error?: string; updatedAt: string; job: LocalizeJobRecord } | null {
  let latest: LocalizeJobRecord | null = null;
  for (const job of jobs) {
    if (job.locale !== locale || !job.chapters.includes(ch)) continue;
    if (!latest || job.createdAt >= latest.createdAt) latest = job;
  }
  if (!latest) return null;
  const progress = latest.progress?.[ch];
  if (progress) {
    // A terminal job status wins over a progress row left mid-flight by a crash.
    if ((latest.status === "interrupted" || latest.status === "failed")
      && (progress.status === "running" || progress.status === "queued")) {
      return {
        status: latest.status,
        stage: progress.stage,
        error: latest.error ?? progress.error,
        updatedAt: latest.updatedAt,
        job: latest,
      };
    }
    return { ...progress, job: latest };
  }
  // A legacy job without progress rows: the job's own status is the best signal.
  if (latest.chapter === ch) {
    return {
      status: latest.status,
      stage: latest.stage,
      error: latest.error,
      updatedAt: latest.updatedAt,
      job: latest,
    };
  }
  return {
    status: latest.status === "completed" ? "completed" : "queued",
    updatedAt: latest.updatedAt,
    job: latest,
  };
}

/**
 * Build the languages state. The last good artifact is reported (and its URL
 * served) even while a retry is running or has failed; `stale` marks a video
 * that no longer matches the current source or settings.
 */
export function languagesState(
  sdir: string,
  slug: string,
  opts: { reconcile?: boolean; now?: () => Date } = {},
): LanguagesState {
  const now = opts.now ?? (() => new Date());
  if (opts.reconcile !== false) reconcileLocalizeJobs(sdir, now);
  const manifest: LanguageManifest = readManifest(sdir);
  const jobs = listJobs(sdir);
  const source = sourceChapters(sdir);
  const sourceByChapter = new Map(source.map((row) => [row.chapter, row]));

  const versions: LanguageVersionView[] = [];
  for (const entry of catalogEntries()) {
    const version = manifest.locales[entry.locale];
    const records = version?.chapters ?? {};
    const jobChapters = jobs.filter((j) => j.locale === entry.locale).flatMap((j) => j.chapters);
    const names = sortChapters(
      [...new Set([...Object.keys(records), ...jobChapters])].filter((c) => CHAPTER_RE.test(c)),
    );
    if (names.length === 0) continue;

    const viewChapters: LanguageChapterView[] = [];
    for (const ch of names) {
      const rec = records[ch];
      const attempt = attemptFor(jobs, entry.locale, ch);
      const check = sourceByChapter.get(ch);
      // The saved identity of the render (or in-flight job). Old records/jobs
      // without it derive the same engine/provider from the catalog.
      const savedIdentity: RenderVoiceIdentity | null = rec?.artifact || attempt
        ? jobVoiceIdentity({
          locale: entry.locale,
          voice: rec?.artifact?.voice ?? attempt?.job.voice ?? "",
          engine: rec?.artifact?.engine ?? attempt?.job.engine ?? rec?.engine,
          provider: rec?.artifact?.provider ?? attempt?.job.provider ?? rec?.provider,
          modelId: rec?.artifact?.modelId ?? attempt?.job.modelId ?? rec?.modelId,
        })
        : null;
      let currentRenderKey: string | null = null;
      // One memoized source check per chapter: its advisories are reused below
      // instead of re-walking the panel directory a second time.
      const full = check?.eligible ? checkSourceChapter(sdir, ch) : null;
      if (full?.eligible && savedIdentity) {
        const translationKey = translationKeyFor(full, entry.locale, sdir);
        currentRenderKey = renderKeyFor(
          translationKey,
          rec?.artifact?.voice ?? attempt?.job.voice ?? "",
          rec?.artifact?.speed ?? attempt?.job.speed ?? 1,
          renderConfig(sdir, full),
          savedIdentity,
        );
      }
      const artifact = verifiedArtifact(rec?.artifact);
      const stale = Boolean(artifact) && (
        !check?.eligible
        || currentRenderKey === null
        || artifact!.renderKey !== currentRenderKey
      );
      const status = attempt?.status ?? rec?.status ?? "queued";
      const view: LanguageChapterView = {
        chapter: ch,
        status,
        stage: attempt?.stage ?? rec?.stage,
        error: attempt?.error ?? rec?.error,
        updatedAt: attempt?.updatedAt ?? rec?.updatedAt,
        voice: rec?.voice ?? attempt?.job.voice ?? undefined,
        speed: typeof rec?.speed === "number" ? rec.speed : attempt?.job.speed,
        ...(savedIdentity
          ? { engine: savedIdentity.engine, provider: savedIdentity.provider, modelId: savedIdentity.modelId }
          : {}),
        warnings: rec?.warnings && rec.warnings.length ? rec.warnings : undefined,
        stale: stale || rec?.stale || undefined,
      };
      // Advisory source findings travel with the chapter so the UI can show why
      // a version is worth reviewing without blocking creation.
      if (full?.eligible) {
        const advisories = full.advisories ?? [];
        if (advisories.length) {
          view.warnings = [...(view.warnings ?? []), ...advisories];
        }
      }
      if (artifact) {
        view.videoUrl = videoUrlFor(slug, entry.locale, ch, artifact.revision);
        view.duration = artifact.duration;
      }
      viewChapters.push(view);
    }
    if (viewChapters.length === 0) continue;

    const statuses = viewChapters.map((c) => c.status);
    const latestJob = [...jobs].reverse().find((j) => j.locale === entry.locale);
    const updatedAt = viewChapters
      .map((c) => c.updatedAt ?? "")
      .sort()
      .pop() || version?.updatedAt || new Date(0).toISOString();
    const versionIdentity = latestJob ? jobVoiceIdentity(latestJob) : null;
    const pendingRetry = latestJob?.nextAutoRetryAt && canAutoRetry(latestJob, autoRetryPolicy())
      ? { count: (latestJob.autoRetryCount ?? 0) + 1, max: autoRetryPolicy().max, at: latestJob.nextAutoRetryAt }
      : undefined;
    versions.push({
      locale: entry.locale,
      label: entry.label,
      status: aggregateStatus(statuses),
      stage: latestJob?.stage,
      error: latestJob?.error,
      voice: latestJob?.voice || undefined,
      speed: latestJob ? latestJob.speed : undefined,
      ...(versionIdentity
        ? { engine: versionIdentity.engine, provider: versionIdentity.provider, modelId: versionIdentity.modelId }
        : {}),
      updatedAt,
      ...(pendingRetry ? { autoRetry: pendingRetry } : {}),
      chapters: viewChapters,
    });
  }
  return { ok: true, slug, catalog: catalogEntries(), sourceChapters: source, versions };
}

/* ------------------------------------------------------------------ *
 * Preview (bounded, cancellable TTS sample)
 * ------------------------------------------------------------------ */

/**
 * Preview cache identity. The Edge formula is unchanged, so a preview generated
 * before this change is still found. A Vertex sample also pins provider, model,
 * locale, effective speed and a HASHED credential fingerprint: a different
 * account/project must not serve another account's audio.
 */
function previewCacheId(
  locale: string,
  identity: { engine: string; provider?: string; modelId?: string; voice: string; speed: number },
  env: NodeJS.ProcessEnv,
): string {
  if (identity.engine === "edge") {
    return sha256Json({ locale, voice: identity.voice, speed: identity.speed, text: SAMPLE_TEXT_HI, engine: "edge", rev: 2 });
  }
  return sha256Json({
    locale,
    voice: identity.voice,
    speed: identity.speed,
    text: SAMPLE_TEXT_HI,
    engine: identity.engine,
    provider: identity.provider ?? identity.engine,
    model: identity.modelId ?? null,
    config: vertexTtsConfigFingerprint(env),
    rev: 4,
  });
}

export function previewFilePath(sdir: string, locale: string, id: string): string {
  const loc = validateLocale(locale);
  if (!loc) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  if (!/^[a-f0-9]{64}$/.test(id)) throw new LocalizeError("Invalid preview id", 400, "invalid_preview_id");
  return path.join(languagesRoot(sdir), loc, "previews", `${id}.mp3`);
}

export function resolvePreviewFile(sdir: string, locale: string, id: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const loc = validateLocale(locale);
  if (!loc) return null;
  const file = previewFilePath(sdir, loc, id);
  if (!isInside(languagesRoot(sdir), file)) return null;
  return isRegularFile(file) ? file : null;
}

function cooldownFile(sdir: string, locale: string): string {
  return path.join(languagesRoot(sdir), locale, "previews", "cooldown.json");
}

function cooldownRemaining(sdir: string, locale: string): number {
  const raw = readJson(cooldownFile(sdir, locale));
  const last = isRecord(raw) && typeof raw.lastAt === "number" ? raw.lastAt : 0;
  return Math.max(0, PREVIEW_COOLDOWN_MS - (Date.now() - last));
}

function markCooldown(sdir: string, locale: string): void {
  writeJsonAtomic(cooldownFile(sdir, locale), { lastAt: Date.now() });
}

function edgeCandidates(): string[] {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return [
    process.env.EDGE_TTS_PYTHON ?? "",
    process.env.MANHWA_PYTHON ?? "",
    "/opt/tts/bin/python",
    path.join(repo, ".venv", "bin", "python"),
    path.resolve(repo, "..", "manhwa-pipeline", ".venv", "bin", "python"),
    "python3",
  ].filter((p) => p !== "");
}

/**
 * Synthesize the sample with a cancellable ASYNC subprocess.
 * A synchronous child (spawnSync) cannot be aborted and would block the whole
 * server, so the deadline must own a real process it can kill.
 */
function synthesizePreview(
  text: string,
  dest: string,
  voice: string,
  rate: string,
  signal: AbortSignal,
): Promise<void> {
  if (previewSynthImpl) {
    // The seam is abortable too: a hanging fake must not outlive the deadline.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        reject(new LocalizeError("Language preview timed out", 504, "preview_timeout"));
      }, { once: true });
      previewSynthImpl!(text, dest, voice, rate).then(
        () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  }
  return new Promise<void>((resolve, reject) => {
    const script =
      "import asyncio,sys,edge_tts\n" +
      "text,voice,rate,dest=sys.argv[1:5]\n" +
      "async def main():\n" +
      "    await edge_tts.Communicate(text, voice, rate=rate).save(dest)\n" +
      "asyncio.run(main())\n";
    const candidates = edgeCandidates();
    let index = 0;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        // nothing to clean
      }
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (signal.aborted) {
      fail(new LocalizeError("Language preview timed out", 504, "preview_timeout"));
      return;
    }
    signal.addEventListener("abort", () => {
      fail(new LocalizeError("Language preview timed out", 504, "preview_timeout"));
    }, { once: true });

    const tryNext = (): void => {
      if (settled) return;
      const py = candidates[index++];
      if (!py) {
        fail(new LocalizeError("Language preview generation failed: edge-tts is not available", 502, "preview_unavailable"));
        return;
      }
      if (py !== "python3" && py.includes("/") && !fs.existsSync(py)) {
        tryNext();
        return;
      }
      child = spawn(py, ["-c", script, text, voice, rate, dest], {
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString("utf8");
      });
      child.once("error", () => tryNext());
      child.once("close", (code) => {
        if (settled) return;
        if (code === 0 && fs.existsSync(dest)) succeed();
        else tryNext();
      });
    };
    tryNext();
  });
}

export interface PreviewResult {
  id: string;
  url: string;
  duration: number;
  cached: boolean;
}

export async function generateLanguagePreview(
  sdir: string,
  slug: string,
  input: { locale: string; voice: string; speed?: number },
): Promise<PreviewResult> {
  const locale = validateLocale(input.locale);
  if (!locale) throw new LocalizeError("Unsupported language", 400, "unsupported_locale");
  let resolved: ResolvedVoice;
  try {
    resolved = resolveVoice(locale, input.voice);
  } catch (err) {
    if (err instanceof UnsupportedVoiceError) {
      throw new LocalizeError(err.message, err.statusCode, err.code);
    }
    throw err;
  }
  const voice = resolved.voice;
  const speed = clampSpeed(input.speed ?? 1);
  const env = process.env;
  const id = previewCacheId(
    locale,
    { engine: resolved.engine, provider: resolved.provider, modelId: resolved.modelId, voice: voice.id, speed },
    env,
  );
  const file = previewFilePath(sdir, locale, id);
  const existing = probeDuration(file);
  if (existing > 0) {
    return { id, url: previewUrl(slug, locale, id), duration: existing, cached: true };
  }
  const dir = path.dirname(file);
  ensureDir(dir);
  const lockFile = path.join(dir, "generate.lock");
  const fd = fs.openSync(lockFile, "a+", 0o664);
  try {
    if (!tryFlockFd(fd, "ex", true)) {
      throw new LocalizeError("A language preview is already being generated; try again shortly", 429, "preview_busy");
    }
    const again = probeDuration(file);
    if (again > 0) return { id, url: previewUrl(slug, locale, id), duration: again, cached: true };
    const remaining = cooldownRemaining(sdir, locale);
    if (remaining > 0) {
      throw new LocalizeError(
        `Language preview is cooling down for ${Math.ceil(remaining / 1000)}s; try again shortly`,
        429,
        "preview_cooldown",
      );
    }
    markCooldown(sdir, locale);
    const rate = speed === 1 ? "+0%" : `${speed > 1 ? "+" : "-"}${Math.round(Math.abs(speed - 1) * 100)}%`;
    const tmp = path.join(dir, `.${id}.${process.pid}.${Date.now()}.tmp.mp3`);
    // The deadline owns the async child: it aborts the process and clears state.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), previewTimeoutMs);
    try {
      try {
        if (resolved.engine === "vertex") {
          // Same synthesis function and locale the chapter render uses, so the
          // sample's pronunciation and speed match the final audio.
          const synthesize = vertexPreviewSynthImpl ?? synthesizeVertexTtsToFile;
          await synthesize({
            text: SAMPLE_TEXT_HI,
            voiceId: voice.id,
            destPath: tmp,
            speed,
            env,
            locale,
            signal: controller.signal,
          });
        } else {
          await synthesizePreview(SAMPLE_TEXT_HI, tmp, voice.id, rate, controller.signal);
        }
      } catch (err) {
        // An aborted request is a deadline, not a provider failure: report the
        // bounded-preview contract so the UI can offer "try again".
        if (controller.signal.aborted) {
          throw new LocalizeError("Language preview timed out", 504, "preview_timeout");
        }
        throw err;
      }
      if (controller.signal.aborted) {
        throw new LocalizeError("Language preview timed out", 504, "preview_timeout");
      }
      const duration = probeDuration(tmp);
      if (!(duration > 0)) {
        throw new LocalizeError("Language preview produced invalid audio", 502, "preview_invalid");
      }
      const size = fs.statSync(tmp).size;
      if (size <= 0 || size > MAX_PREVIEW_BYTES) {
        throw new LocalizeError("Language preview audio is empty or too large", 502, "preview_invalid");
      }
      fs.renameSync(tmp, file);
      return { id, url: previewUrl(slug, locale, id), duration, cached: false };
    } finally {
      clearTimeout(deadline);
      // Cancel a still-running request before the scratch file is removed, so a
      // late write cannot recreate it after cleanup.
      controller.abort();
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // renamed
      }
    }
  } finally {
    releaseFd(fd);
  }
}

export function previewUrl(slug: string, locale: string, id: string): string {
  return `/media/${encodeURIComponent(slug)}/languages/${encodeURIComponent(locale)}/preview/${id}.mp3`;
}

/* ------------------------------------------------------------------ *
 * Media resolution
 * ------------------------------------------------------------------ */

export interface ResolvedLocaleVideo {
  file: string;
  size: number;
  duration: number;
  revision: number;
}

/**
 * Resolve a localized video for streaming. Serves the LAST VERIFIED artifact
 * even while a retry is running or has failed; only the canonical path is ever
 * served, and the recorded size must still match the file.
 */
export function resolveLocaleVideo(
  sdir: string,
  locale: string,
  ch: string,
): ResolvedLocaleVideo | null {
  const loc = validateLocale(locale);
  if (!loc || !CHAPTER_RE.test(ch)) return null;
  const manifest = readManifest(sdir);
  const rec = manifest.locales[loc]?.chapters[ch];
  const artifact = verifiedArtifact(rec?.artifact);
  if (!artifact) return null;
  return {
    file: artifact.video,
    size: artifact.size,
    duration: artifact.duration,
    revision: artifact.revision,
  };
}

export { parseLocaleScript, validateTranslation, errorsOf, warningsOf };
export type { LocaleScriptIssue, LocalizePathError };

/** Test-only alias so fixtures can build the exact canonical locale path. */
export const __testCanonicalDir = canonicalChapterDir;
