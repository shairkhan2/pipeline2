/**
 * Orchestrator - the pipeline is SERIES-AGNOSTIC; this file is the only place paths live.
 *
 *   npx tsx src/cli/run.ts <series> [ch1 ch2 ...] [--force] [--all] [--keep-stale]
 *   npx tsx src/cli/run.ts <series> --video --all        # pipelined: scripts keep flowing while videos render
 *   npx tsx src/cli/run.ts <series> --status
 *   npx tsx src/cli/run.ts <series> --clear-cache [ch1 ...]
 *   npx tsx src/cli/run.ts <series> ch1 --reader-captions v2      # opt-in caption re-read, see below
 *
 * --reader-captions v2 (2026-10-04, OPT-IN, default v1) re-reads the vision cache with new caption
 *   wording. COSTS MONEY: ~48k tokens per vision call, ~17 calls and ~0.8M tokens for ONE chapter,
 *   ~7M tokens for an 8-10 chapter series. It is per chapter, so opt in one series at a time:
 *   `run.py <series> ch1 ch2 --reader-captions v2`, then drop the flag - v1 batch caches are never
 *   overwritten. Add --force to rewrite the script too (a cached script.md is reused as-is).
 *
 * A chapter whose EARLIER chapters lack a script is refused by the continuity gate
 * (its window would carry a hole); --write-anyway overrides it deliberately.
 *
 * Layout convention (created automatically for new series):
 *   <series-root>/<series>/               <- drop chapter folders (ch1/, ch2/, ...) here
 *   <series-root>/<series>/out/           <- bible.json, obs_<ch>.json, batches/<ch>/, chNN/
 *
 * Resilience (2026-09-11 revision, shair): a chapter failure RETRIES in place and,
 * if it persists, HALTS the run - it never skips ahead. Reason: the chain. cp2
 * failing while cp3 reads means cp3's vision context (the bible) and continuity
 * window (writer) are both missing cp2 - and the cached results then LOOK fresh.
 * "19 chapters failed but the other 11 kept going" is exactly what I-15 forbids.
 * --status shows cache state + how many API calls a run would cost.
 *
 * --video (2026-09-11, shair's pipeline ask): two lanes. Script lane runs serially
 * (reader is bible-sequential anyway); each chapter whose script passes joins a
 * video-lane queue (renderlane.worker) that renders WHILE later chapters are being
 * read/written. ch1 renders while ch2 writes. One video worker: cleaner peaks
 * ~3.2 GB, render saturates cores - overlap with the network lane is the win.
 *
 * Ported from `pipeline/run.py`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTION_VERSIONS,
  OPENING_BLOCK,
  captionVersion as _parseCv,
} from "../contracts/briefs.js";
import {
  CAPTION_VERSION,
  batchDir,
  briefHash,
  pyFloatRepr,
  pyReprStr,
  schemaHash,
  type PyFloatMarker,
} from "../contracts/hashes.js";
import * as promoBlockMod from "../intake/promoBlock.js";
import { failClass } from "../domain/failure.js";
import { LANES, log, pagesIn } from "../llm/client.js";
import { withSharedSeriesLock } from "../locks/seriesLock.js";
import * as factCheckMod from "../stages/factCheck.js";
import { pyRoundFixed } from "../stages/factCheck.js";
import {
  BATCH,
  _loadCached,
  castBlock,
  mergeBible,
  readChapter,
  type ChapterObs,
} from "../stages/reader.js";
import * as scoutMod from "../stages/scout.js";
import * as writerMod from "../stages/writer.js";
import {
  _scriptOf,
  panelTranscript,
  writeScript,
  type BibleLike,
  type BlockLike,
  type ObsLike,
} from "../stages/writer.js";
import * as telemetry from "../telemetry/telemetry.js";
import * as renderlaneMod from "../workers/renderlane.js";
import { RenderQueue, type VideoResult } from "../workers/renderlane.js";

export const DOC = `Orchestrator - the pipeline is SERIES-AGNOSTIC; this file is the only place paths live.

  python3 run.py <series> [ch1 ch2 ...] [--force] [--all] [--keep-stale]
  python3 run.py <series> --video --all        # pipelined: scripts keep flowing while videos render
  python3 run.py <series> --status
  python3 run.py <series> --clear-cache [ch1 ...]
  python3 run.py <series> ch1 --reader-captions v2      # opt-in caption re-read, see below

--reader-captions v2 (2026-10-04, OPT-IN, default v1) re-reads the vision cache with new caption
  wording. COSTS MONEY: ~48k tokens per vision call, ~17 calls and ~0.8M tokens for ONE chapter,
  ~7M tokens for an 8-10 chapter series. It is per chapter, so opt in one series at a time:
  \`run.py <series> ch1 ch2 --reader-captions v2\`, then drop the flag - v1 batch caches are never
  overwritten. Add --force to rewrite the script too (a cached script.md is reused as-is).

A chapter whose EARLIER chapters lack a script is refused by the continuity gate
(its window would carry a hole); --write-anyway overrides it deliberately.

Layout convention (created automatically for new series):
  <series-root>/<series>/               <- drop chapter folders (ch1/, ch2/, ...) here
  <series-root>/<series>/out/           <- bible.json, obs_<ch>.json, batches/<ch>/, chNN/

Resilience (2026-09-11 revision, shair): a chapter failure RETRIES in place and,
if it persists, HALTS the run - it never skips ahead. Reason: the chain. cp2
failing while cp3 reads means cp3's vision context (the bible) and continuity
window (writer) are both missing cp2 - and the cached results then LOOK fresh.
"19 chapters failed but the other 11 kept going" is exactly what I-15 forbids.
--status shows cache state + how many API calls a run would cost.

--video (2026-09-11, shair's pipeline ask): two lanes. Script lane runs serially
(reader is bible-sequential anyway); each chapter whose script passes joins a
video-lane queue (renderlane.worker) that renders WHILE later chapters are being
read/written. ch1 renders while ch2 writes. One video worker: cleaner peaks
~3.2 GB, render saturates cores - overlap with the network lane is the win.`;

const DEFAULT_SERIES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "series");
export let SERIES_ROOT: string = process.env.MANHWA_SERIES_ROOT || DEFAULT_SERIES_ROOT;

export function _setSeriesRootForTests(root: string | null): void {
  SERIES_ROOT = root === null ? (process.env.MANHWA_SERIES_ROOT || DEFAULT_SERIES_ROOT) : String(root);
}

export class SystemExit extends Error {
  readonly code: string | number;
  constructor(code: string | number = 0) {
    super(typeof code === "string" ? code : String(code));
    this.name = "SystemExit";
    this.code = code;
  }
}

export class RuntimeError extends Error {
  override name = "RuntimeError";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

// I-15 policy: classify a chapter failure. Permanent = retrying cannot help the
// provider (moderation, auth, gate, structural) -> halt at once. Everything else
// (timeouts, 429, connection, empty-200, unparseable) is transient -> retry here.
export { failClass, failClass as fail_class, PERMANENT, TRANSIENT, type FailClass } from "../domain/failure.js";

export const RETRY_ROUNDS = 2; // in-place retries for transient/unknown failures
export const RETRY_WAITS: number[] = [60, 240]; // seconds before each retry (provider needs air)

export function natkey(name: string): [number, string] {
  const m = /(\d+)/.exec(name);
  return [m ? Number.parseInt(m[1]!, 10) : 0, name];
}

/* ------------------------------------------------------------------ *
 * Python-compatible string / JSON helpers
 * ------------------------------------------------------------------ */

const PY_WS =
  "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

function pyLstrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+`), "");
}

function pySplit(s: string): string[] {
  return s.split(new RegExp(`[${PY_WS}]+`, "g")).filter((x) => x !== "");
}

function pySplitLines(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\r") {
      out.push(cur);
      cur = "";
      if (s[i + 1] === "\n") i++;
    } else if (
      c === "\n" ||
      c === "\v" ||
      c === "\f" ||
      c === "\x1c" ||
      c === "\x1d" ||
      c === "\x1e" ||
      c === "\u0085" ||
      c === "\u2028" ||
      c === "\u2029"
    ) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const as = Array.from(a);
  const bs = Array.from(b);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ca = as[i]!.codePointAt(0)!;
    const cb = bs[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPyFloat(v: unknown): v is PyFloatMarker {
  return isRecord(v) && Object.prototype.hasOwnProperty.call(v, "__pyFloat__");
}

function jsonQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else if (cp > 0x7f) {
      if (cp > 0xffff) {
        const u = cp - 0x10000;
        const hi = 0xd800 + (u >> 10);
        const lo = 0xdc00 + (u & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${cp.toString(16).padStart(4, "0")}`;
      }
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

/** Python `json.dumps(..., indent=1)` (ensure_ascii=True, no trailing newline). */
function pyJsonPretty(value: unknown, indent = 1): string {
  const render = (v: unknown, level: number): string => {
    const pad = " ".repeat(indent * level);
    const padIn = " ".repeat(indent * (level + 1));
    if (v === null || v === undefined) return "null";
    if (isPyFloat(v)) return pyFloatRepr(v.__pyFloat__);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    if (typeof v === "string") return jsonQuote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => padIn + render(x, level + 1)).join(",\n")}\n${pad}]`;
    }
    if (isRecord(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      return `{\n${keys
        .map((k) => `${padIn}${jsonQuote(k)}: ${render(v[k], level + 1)}`)
        .join(",\n")}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyReprStr(v);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return String(v);
}

function pyFormat(template: string, fields: Record<string, string>): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    const next = template[i + 1];
    if (ch === "{" && next === "{") {
      out += "{";
      i++;
      continue;
    }
    if (ch === "}" && next === "}") {
      out += "}";
      i++;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) throw new Error("unmatched '{' in format string");
      const key = template.slice(i + 1, end);
      if (!(key in fields)) throw new Error(`format missing key ${key}`);
      out += fields[key]!;
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Hook injection & echo dropper
 * ------------------------------------------------------------------ */

export function _hookWords(txt: string): Set<string> {
  const cleaned = txt.toLowerCase().replace(/@\S+|\[[a-z ]+\]/g, "");
  const matches = cleaned.match(/[a-z']+/g) ?? [];
  return new Set(matches);
}
export const _hook_words = _hookWords;

export function _dropHookEcho(script: string, hook: string, thresh = 0.6): string {
  /**
   * The writer is told not to repeat the hook, but it sometimes restates it as its own
   * first lines, so the video says the premise twice back to back. Deterministic guard:
   * among the first few narration lines, drop any whose words mostly overlap the hook's
   * (a jab riding on a dropped line goes with it). Works on any series - it compares
   * against this episode's own hook text, nothing else.
   */
  const hw = _hookWords(hook);
  if (hw.size === 0) return script;
  const out: string[] = [];
  let checked = 0;
  let dropping = false;
  const dropped: string[] = [];

  for (const l of pySplitLines(script)) {
    const st = pyStrip(l);
    if (!st || st.startsWith("#") || checked >= 4) {
      out.push(l);
      continue;
    }
    if (st.includes("@hold")) {
      if (dropping) {
        dropped.push(st);
        continue;
      }
      out.push(l);
      continue;
    }
    checked += 1;
    const lw = _hookWords(st);
    let overlap = 0;
    for (const w of lw) {
      if (hw.has(w)) overlap += 1;
    }
    dropping = lw.size > 0 && overlap / lw.size >= thresh;
    if (dropping) {
      dropped.push(st);
      continue;
    }
    out.push(l);
  }

  for (const d of dropped) {
    console.log(`   hook echo dropped: ${d.slice(0, 80)}`);
  }

  // a beat header left with no lines under it is removed
  const tidy: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const l = out[i]!;
    if (pyStrip(l).startsWith("## BEAT")) {
      let nxt = "";
      for (let j = i + 1; j < out.length; j++) {
        if (pyStrip(out[j]!)) {
          nxt = out[j]!;
          break;
        }
      }
      if (!nxt || pyStrip(nxt).startsWith("## BEAT")) {
        continue;
      }
    }
    tidy.push(l);
  }

  return tidy.join("\n") + (script.endsWith("\n") ? "\n" : "");
}
export const _drop_hook_echo = _dropHookEcho;

export function _withHook(script: string, op: Record<string, unknown>): string {
  /**
   * Insert the scout's hook as the FIRST beat of the episode script. The writer was
   * told the hook and told not to repeat it, so this is the only copy in the file; the
   * timeline voices line 1 first and tags it with the hook's own panel, so the opening
   * shot is exact. Returns the rewritten script text.
   */
  const hook = pyStrip(String(op.hook || ""));
  if (!hook) return script;
  const body = pyLstrip(_dropHookEcho(script, hook));
  const head = `## BEAT b00_opening\n${hook}\n\n`;
  return head + body;
}
export const _with_hook = _withHook;

/* ------------------------------------------------------------------ *
 * Chapters, batch state, status, clearCache
 * ------------------------------------------------------------------ */

export function chaptersIn(sdir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sdir);
  } catch {
    return [];
  }
  const dirs = entries.filter((d) => {
    if (d === "out") return false;
    try {
      return fs.statSync(path.join(sdir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  return dirs.sort((a, b) => {
    const ka = natkey(a);
    const kb = natkey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return cmpCodePoints(ka[1], kb[1]);
  });
}
export const chapters_in = chaptersIn;

export function _batchState(
  bdir: string,
  nPages: number,
  ch: string | null = null,
  out: string | null = null,
  cv: number = CAPTION_VERSION,
): [number, number, number] {
  /** (cached_ok, cached_stale, total_batches) for one chapter (panel-based). */
  let n = nPages;
  const man = path.join(out || "", "panels", ch || "", "manifest.json");
  if (out && ch && fs.existsSync(man)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(man, "utf8"));
      if (Array.isArray(parsed)) n = parsed.length;
    } catch {
      // fallback to nPages
    }
  }
  const total = Math.floor((n + BATCH - 1) / BATCH);
  let ok = 0;
  let stale = 0;
  for (let bi = 0; bi < total; bi++) {
    const [, st] = _hooks._loadCached(
      path.join(bdir, `b${String(bi).padStart(2, "0")}.json`),
      cv,
    );
    if (st === "ok") ok += 1;
    else if (st === "stale") stale += 1;
  }
  return [ok, stale, total];
}
export const _batch_state = _batchState;

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function status(series: string, captionVersion: number = CAPTION_VERSION): void {
  const sdir = path.join(_hooks.SERIES_ROOT, series);
  const out = path.join(sdir, "out");
  const cv = captionVersion;
  console.log(
    `series: ${series}   brief_hash: ${briefHash(cv)}   schema_hash: ${schemaHash()}` +
      (cv !== 1 ? `   CAPTIONS v${cv}` : ""),
  );
  console.log(
    `${padRight("ch", 6)} ${padLeft("pages", 5)} ${padLeft("batches ok/stale/tot", 20)} ${padLeft("obs", 5)} ${padLeft("script", 7)} ${padLeft("calls if run", 12)}`,
  );
  for (const ch of chaptersIn(sdir)) {
    const n = pagesIn(path.join(sdir, ch)).length;
    const [ok, stale, total] = _batchState(batchDir(out, ch, cv), n, ch, out, cv);
    const [, obsSt] = _hooks._loadCached(path.join(out, `obs_${ch}.json`), cv);
    const obsMap: Record<string, string> = { ok: "fresh", stale: "STALE", miss: "no" };
    const obs = obsMap[obsSt] ?? "no";
    const scr = ["script.md", "script_eleven.md", "script_voice.md"].some((s) =>
      fs.existsSync(path.join(out, ch, s)),
    )
      ? "yes"
      : "no";
    // fresh obs = 0 calls; otherwise every not-ok batch must be read
    const calls = obsSt === "ok" ? 0 : total - ok;
    console.log(
      `${padRight(ch, 6)} ${padLeft(String(n), 5)} ${padLeft(`${ok}/${stale}/${total}`, 20)} ${padLeft(obs, 5)} ${padLeft(scr, 7)} ${padLeft(String(calls), 12)}`,
    );
  }
  console.log("\nlegend: 'calls if run' = vision API calls a plain `run.py` would make now");
}

export function clearCache(
  series: string,
  chs: readonly string[],
  captionVersion: number = CAPTION_VERSION,
): void {
  /**
   * Wipe a chapter's reader cache FOR ONE CAPTION VERSION. It clears only that version's
   * batch dir, so `--reader-captions v2 --clear-cache ch1` cannot destroy the v1 batches a
   * plain run still serves (the default path clears exactly what it always did).
   */
  const sdir = path.join(_hooks.SERIES_ROOT, series);
  const out = path.join(sdir, "out");
  withSharedSeriesLock({ directSdir: sdir, requireExists: false }, () => {
    for (const ch of chs) {
      fs.rmSync(batchDir(out, ch, captionVersion), { recursive: true, force: true });
      const p = path.join(out, `obs_${ch}.json`);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
      console.log(
        `cleared cache: ${ch}` + (captionVersion !== 1 ? ` (captions v${captionVersion})` : ""),
      );
    }
  });
}
export const clear_cache = clearCache;

/* ------------------------------------------------------------------ *
 * Run options & orchestrator
 * ------------------------------------------------------------------ */

export interface RunOptions {
  force?: boolean;
  keepStale?: boolean;
  keep_stale?: boolean;
  video?: boolean;
  writeAnyway?: boolean;
  write_anyway?: boolean;
  scoutOnly?: boolean;
  scout_only?: boolean;
  scoutRange?: number;
  scout_range?: number;
  captionVersion?: number;
  caption_version?: number;
  all?: boolean;
}

function normalizeRunArgs(
  forceOrOpts: boolean | RunOptions = false,
  keepStale = false,
  video = false,
  writeAnyway = false,
  scoutOnly = false,
  scoutRange = 5,
  captionVersion: number = CAPTION_VERSION,
): Required<
  Pick<
    RunOptions,
    | "force"
    | "keepStale"
    | "video"
    | "writeAnyway"
    | "scoutOnly"
    | "scoutRange"
    | "captionVersion"
    | "all"
  >
> {
  if (typeof forceOrOpts === "object" && forceOrOpts !== null) {
    return {
      force: Boolean(forceOrOpts.force ?? false),
      keepStale: Boolean(forceOrOpts.keepStale ?? forceOrOpts.keep_stale ?? false),
      video: Boolean(forceOrOpts.video ?? false),
      writeAnyway: Boolean(forceOrOpts.writeAnyway ?? forceOrOpts.write_anyway ?? false),
      scoutOnly: Boolean(forceOrOpts.scoutOnly ?? forceOrOpts.scout_only ?? false),
      scoutRange: Number(forceOrOpts.scoutRange ?? forceOrOpts.scout_range ?? 5),
      captionVersion: Number(
        forceOrOpts.captionVersion ?? forceOrOpts.caption_version ?? CAPTION_VERSION,
      ),
      all: Boolean(forceOrOpts.all ?? false),
    };
  }
  return {
    force: Boolean(forceOrOpts),
    keepStale: Boolean(keepStale),
    video: Boolean(video),
    writeAnyway: Boolean(writeAnyway),
    scoutOnly: Boolean(scoutOnly),
    scoutRange: Number(scoutRange),
    captionVersion: Number(captionVersion),
    all: false,
  };
}

function isRealDirectory(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function run(
  series: string,
  chs: readonly string[] = [],
  forceOrOpts: boolean | RunOptions = false,
  keepStale = false,
  video = false,
  writeAnyway = false,
  scoutOnly = false,
  scoutRange = 5,
  captionVersion: number = CAPTION_VERSION,
): Promise<number> {
  /**
   * captionVersion is opt-in and defaults to CAPTION_VERSION.
   */
  const sdir = path.join(_hooks.SERIES_ROOT, series);
  if (!isRealDirectory(sdir)) {
    throw new SystemExit(`no such series: ${sdir} (create it and drop chapter folders inside)`);
  }
  const opts = normalizeRunArgs(
    forceOrOpts,
    keepStale,
    video,
    writeAnyway,
    scoutOnly,
    scoutRange,
    captionVersion,
  );
  return await withSharedSeriesLock({ directSdir: sdir }, async (): Promise<number> => {
    return await _hooks._runLocked(series, chs, opts);
  });
}

export async function _runLocked(
  series: string,
  chsArg: readonly string[] = [],
  forceOrOpts: boolean | RunOptions = false,
  keepStaleArg = false,
  videoArg = false,
  writeAnywayArg = false,
  scoutOnlyArg = false,
  scoutRangeArg = 5,
  captionVersionArg: number = CAPTION_VERSION,
): Promise<number> {
  const opts = normalizeRunArgs(
    forceOrOpts,
    keepStaleArg,
    videoArg,
    writeAnywayArg,
    scoutOnlyArg,
    scoutRangeArg,
    captionVersionArg,
  );
  const {
    force,
    keepStale,
    video,
    writeAnyway,
    scoutOnly,
    scoutRange,
    captionVersion: cv,
  } = opts;

  const sdir = path.join(_hooks.SERIES_ROOT, series);
  const out = path.join(sdir, "out");
  const biblePath = path.join(out, "bible.json");
  if (!isDirectory(sdir)) {
    throw new SystemExit(`no such series: ${sdir} (create it and drop chapter folders inside)`);
  }
  fs.mkdirSync(out, { recursive: true });
  let chs: string[] = [...chsArg];
  if (chs.length === 0 || opts.all || process.argv.includes("--all")) {
    chs = chaptersIn(sdir);
  }
  _hooks.telemetry.start(series, chs, video, cv);
  const modelMap: Record<string, Array<Record<string, unknown>>> = {};
  for (const [k, v] of LANES.items()) {
    if (k !== "text") {
      modelMap[k] = v as unknown as Array<Record<string, unknown>>;
    }
  }
  _hooks.telemetry.models(modelMap);

  // SCOUT PHASE (2026-09-26, shair's design): a new series does not have to start at
  // ch1. --scout reads the first few chapters (vision, cached) and picks the chapter +
  // scene that opens hardest -> out/opening.json. That chapter becomes episode 1; the
  // chapters before it are CONTEXT ONLY (read into the bible, never scripted).
  if (scoutOnly) {
    for (const ch of chs.slice(0, scoutRange)) {
      const chdir = path.join(sdir, ch);
      if (!isDirectory(chdir)) continue;
      let _cast = "";
      try {
        if (fs.existsSync(biblePath)) {
          _cast = castBlock(JSON.parse(fs.readFileSync(biblePath, "utf8")));
        }
      } catch {
        // ignore
      }
      console.log(`== ${ch}: READER (scout range)`);
      _hooks.telemetry.bind({ chapter: ch });
      _hooks.telemetry.stage(ch, "reader");
      const obs = await _hooks.readChapter(chdir, out, force, keepStale, _cast, cv);
      await _hooks.mergeBible(biblePath, ch, obs);
      _hooks.telemetry.stage(ch, "reader", "done");
    }
    await _hooks.scout.scout(sdir, out, null, scoutRange, force);
    _hooks.telemetry.finish();
    return 0;
  }

  let op: Record<string, unknown> = {};
  const opPath = path.join(out, "opening.json");
  if (fs.existsSync(opPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(opPath, "utf8"));
      if (isRecord(parsed)) op = parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`  !! opening.json unreadable (${msg}) - starting at ch1\n`);
    }
  }
  const hasOp = Object.keys(op).length > 0;
  const startN = Number.parseInt(String(op.start_at || 1), 10) || 1;
  const startCh = String(op.start_ch || "ch1");
  if (hasOp) {
    console.log(
      `series: ${series} | EPISODE 1 = ${startCh} (scout) | ` +
        `hook panel ${String(op.panel ?? "None")} | chapters: ${chs.join(", ")}` +
        (video ? "  [VIDEO LANE ON]" : "") +
        (cv !== 1 ? `  [CAPTIONS v${cv} - ~48k tokens/vision call, ~0.8M/chapter]` : ""),
    );
  } else {
    console.log(
      `series: ${series} | chapters: ${chs.join(", ")}` +
        (video ? "  [VIDEO LANE ON]" : "") +
        (cv !== 1 ? `  [CAPTIONS v${cv} - ~48k tokens/vision call, ~0.8M/chapter]` : ""),
    );
  }

  // video lane: queue + one worker task (renderlane.worker guards RAM/CPU)
  const vq = new RenderQueue<string | null>();
  const vresults: Record<string, VideoResult> = new Proxy({}, {
    set(target: Record<string, VideoResult>, ch: string, result: VideoResult) {
      target[ch] = result;
      // Persist every final outcome immediately; telemetry/report I/O is fail-open.
      try {
        const report = path.join(out, ch, "report.json");
        let prior = {};
        try { prior = JSON.parse(fs.readFileSync(report, "utf8")); } catch { /* no prior report */ }
        fs.mkdirSync(path.dirname(report), { recursive: true });
        const tmp = `${report}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, pyJsonPretty({ ...prior, ...result }, 1));
        fs.renameSync(tmp, report);
      } catch { /* a report write must not break queue accounting */ }
      return true;
    },
  });
  let vt: Promise<void> | null = null;
  let videoWorkerError: string | null = null;
  /** Drain chapters still queued after the worker died so vq.join() can resolve. */
  const failQueuedVideoChapters = (): void => {
    for (;;) {
      let ch: string | null;
      try {
        ch = vq.getNowait();
      } catch {
        return;
      }
      if (ch === null) {
        vq.taskDone();
        continue;
      }
      vresults[ch] = {
        status: "video-failed",
        error: `render worker failed: ${(videoWorkerError ?? "unknown error").slice(0, 300)}`,
        class: failClass(new Error(videoWorkerError ?? "unknown error")),
        video_attempts: 0,
      };
      vq.taskDone();
    }
  };
  if (video) {
    const onWorkerFailure = (err: unknown): void => {
      videoWorkerError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[video] !! render worker failed: ${videoWorkerError.slice(0, 200)}\n`,
      );
      failQueuedVideoChapters();
    };
    try {
      vt = Promise.resolve(_hooks.renderlane.worker(sdir, out, vq, vresults)).catch(
        onWorkerFailure,
      );
    } catch (err) {
      // a synchronous throw before the first await never reaches .catch
      onWorkerFailure(err);
      vt = Promise.resolve();
    }
  }

  const results: Array<[string, "ok" | "failed"]> = [];
  let halted: string | null = null;

  for (const ch of chs) {
    if (halted) {
      break; // chain policy: a hard failure stops the WHOLE run
    }
    const chdir = path.join(sdir, ch);
    if (!isDirectory(chdir)) {
      _hooks.telemetry.stage(ch, "reader", "skipped", { note: "Chapter folder missing" });
      console.log(`skip ${ch}: no folder`);
      continue;
    }
    // chapters before the scout's episode 1 are CONTEXT ONLY: they are read into
    // the bible (done in the scout phase) but never scripted as episodes.
    const chNumMatch = /\d+/.exec(ch);
    const chN = chNumMatch ? Number.parseInt(chNumMatch[0], 10) : 0;
    if (chN < startN) {
      _hooks.telemetry.stage(ch, "reader", "skipped", { note: "Context-only chapter" });
      console.log(`skip ${ch}: before episode 1 (${startCh}) - context only`);
      continue;
    }

    let scriptStage = "reader";
    for (let attempt = 0; attempt <= RETRY_ROUNDS; attempt++) {
      try {
        if (attempt > 0) _hooks.telemetry.stage(ch, scriptStage, "queued");
        scriptStage = "reader";
        const tag = attempt === 0 ? "" : ` (retry ${attempt}/${RETRY_ROUNDS})`;
        console.log(`== ${ch}: READER${tag}`);
        _hooks.telemetry.bind({ chapter: ch });
        _hooks.telemetry.stage(ch, "reader", "running", { attempt: attempt + 1 });

        let _cast = "";
        try {
          if (fs.existsSync(biblePath)) {
            _cast = castBlock(JSON.parse(fs.readFileSync(biblePath, "utf8")));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`   cast: WARN could not build cast block (${msg})\n`);
        }
        if (_cast) {
          const count = pySplitLines(_cast).filter((l) => l.startsWith("  ")).length;
          console.log(`   cast: ${count} named character(s) injected into the reader brief`);
        }

        const obs = await _hooks.readChapter(chdir, out, force && attempt === 0, keepStale, _cast, cv);
        const bible = await _hooks.mergeBible(biblePath, ch, obs);
        const panelsList = Array.isArray(obs.panels) ? obs.panels : [];
        _hooks.telemetry.stage(ch, "reader", "done", { panels: panelsList.length });

        const charsObj = isRecord(bible.characters) ? bible.characters : {};
        const linksArr = Array.isArray(bible.links) ? bible.links : [];
        const covArr = Array.isArray(bible.covered) ? (bible.covered as string[]) : [];
        console.log(
          `   bible: ${Object.keys(charsObj).length} characters, ${linksArr.length} links` +
            ` | covered: ${covArr.join(",") || "NONE!"}`,
        );
        if (!covArr.includes(ch)) {
          // I-04: silence here would hide a merge bug - make it loud
          process.stderr.write(`  !! WARNING: ${ch} merged but bible.covered lacks it\n`);
        }

        let meta: Record<string, unknown> = {};
        let seriesStyle: import('../config/seriesStyle.js').SeriesStyle | undefined;
        try {
          const parsedMeta = JSON.parse(fs.readFileSync(path.join(sdir, "meta.json"), "utf8"));
          if (isRecord(parsedMeta)) seriesStyle = parsedMeta.style as typeof seriesStyle;
          if (isRecord(parsedMeta) && isRecord(parsedMeta.tts)) {
            meta = parsedMeta.tts;
          }
        } catch {
          meta = {};
        }

        const engine = String(meta.engine || "edge");
        if (
          engine !== "edge" && engine !== "eleven" && engine !== "external"
          && engine !== "vertex" && engine !== "grok"
        ) {
          throw new RuntimeError(
            `unknown tts.engine=${pyRepr(engine)} in meta.json (expected edge, eleven, external, vertex, or grok)`,
          );
        }
        if (
          (engine === "eleven" || engine === "external" || engine === "vertex" || engine === "grok") &&
          !pyStrip(String(meta.voice_id || ""))
        ) {
          throw new RuntimeError(
            `meta.json says engine=${engine} but voice_id is empty - shair sets the voice`,
          );
        }
        const eleven = engine === "eleven";
        const external = engine === "external";
        const emotionSetting = seriesStyle?.emotionTags ?? process.env.EMOTION_TAGS ?? 'auto';
        const expressive = emotionSetting === 'auto' ? eleven || external : emotionSetting === 'on';

        // I-15 CONTINUITY GATE
        const n = chN;
        const missing: string[] = [];
        for (let i = startN; i < n; i++) {
          const ci = `ch${i}`;
          const hasScript =
            fs.existsSync(path.join(out, ci, "script.md")) ||
            fs.existsSync(path.join(out, ci, "script_eleven.md")) ||
            fs.existsSync(path.join(out, ci, "script_voice.md"));
          if (!hasScript && isDirectory(path.join(sdir, ci))) {
            missing.push(ci);
          }
        }
        if (missing.length > 0 && !writeAnyway) {
          throw new RuntimeError(
            `continuity gate: earlier chapters have NO script yet ` +
              `(${missing.slice(0, 8).join(",")}${missing.length > 8 ? "..." : ""}) - ` +
              `fill them first, or pass --write-anyway to override`,
          );
        }

        const writerModeLabel = eleven
          ? "v2 EMOTION-TAGGED for elevenlabs"
          : external
            ? "v2 EMOTION-TAGGED for external voice"
            : "one shot";
        console.log(`== ${ch}: WRITER (${writerModeLabel})`);
        scriptStage = "writer";
        _hooks.telemetry.stage(ch, "writer");

        const cdir = path.join(out, ch);
        fs.mkdirSync(cdir, { recursive: true });
        const panelsDir = path.join(out, "panels", ch);
        const scriptName = eleven
          ? "script_eleven.md"
          : external
            ? "script_voice.md"
            : "script.md";
        const scriptTarget = path.join(cdir, scriptName);

        // EP1 OPENING
        let opening = "";
        if (hasOp && ch === startCh) {
          const ctx = _hooks.scout.contextDigest(out, startCh);
          const hookStr = String(op.hook || "");
          const takenList = [...hookStr.matchAll(/@(p\d{4}_\d+)/g)].map((m) => `@${m[1]}`);
          const taken = takenList.join(", ") || "none";
          opening = pyFormat(OPENING_BLOCK, { hook: hookStr, context: ctx, taken });
          console.log(
            `   EP1 opening: hook panel ${String(op.panel ?? "None")} + context digest ` +
              `(${Array.from(ctx).length} chars from ch1..${startN - 1})`,
          );
        }

        const block = _hooks.promoBlock.ensure(sdir, out); // I-19: mechanical, built once, cached
        let repair = false;
        if (!force && fs.existsSync(scriptTarget)) {
          const rp0 = path.join(cdir, "report.json");
          let holesPrev: string[] = [];
          try {
            const parsedRp = JSON.parse(fs.readFileSync(rp0, "utf8"));
            if (isRecord(parsedRp) && Array.isArray(parsedRp.window_holes)) {
              holesPrev = parsedRp.window_holes.map(String);
            }
          } catch {
            holesPrev = [];
          }
          const filled = holesPrev.filter(
            (h) =>
              fs.existsSync(path.join(out, h, "script.md")) ||
              fs.existsSync(path.join(out, h, "script_eleven.md")) ||
              fs.existsSync(path.join(out, h, "script_voice.md")),
          );
          if (holesPrev.length > 0 && filled.length === holesPrev.length) {
            repair = true;
            console.log(
              `   continuity REPAIR: script written with holes ${holesPrev.join(",")} - all filled now, rewriting`,
            );
          }
        }

        const hookTaken = opening
          ? [...String(op.hook || "").matchAll(/@(p\d{4}_\d+)/g)].map((m) => m[1]!)
          : [];

        // I-21: writeScript publishes this chapter's continuity window in LAST_WINDOW.
        // Reset it per chapter so a cached chapter (which never calls writeScript)
        // cannot inherit the PREVIOUS chapter's window in factCheck.check.
        writerMod.setLastWindow("");

        let script: string;
        if (force || repair || !fs.existsSync(scriptTarget)) {
          script = await _hooks.writeScript(
            obs as unknown as ObsLike,
            bible as unknown as BibleLike,
            panelsDir,
            scriptTarget,
            {
              outDir: out,
              emotion: expressive,
              style: seriesStyle,
              block: block as unknown as BlockLike | null,
              opening,
              taken: hookTaken,
            },
          );
          if (opening) {
            script = _withHook(script, op);
            fs.writeFileSync(scriptTarget, script);
          }
        } else {
          script = fs.readFileSync(scriptTarget, "utf8");
          const hasNarration = pySplitLines(script).some(
            (l) => pyStrip(l) && !pyLstrip(l).startsWith("#"),
          );
          if (!hasNarration) {
            console.log("   cached script has 0 narration lines - rewriting (not reusing)");
            script = await _hooks.writeScript(
              obs as unknown as ObsLike,
              bible as unknown as BibleLike,
              panelsDir,
              scriptTarget,
              {
                outDir: out,
                emotion: expressive,
                style: seriesStyle,
                block: block as unknown as BlockLike | null,
                opening,
                taken: hookTaken,
              },
            );
            if (opening) {
              script = _withHook(script, op);
              fs.writeFileSync(scriptTarget, script);
            }
          } else {
            console.log("   script exists - reusing (--force to rewrite)");
            if (opening && !script.includes("## BEAT b00_opening")) {
              script = _withHook(script, op);
              fs.writeFileSync(scriptTarget, script);
              console.log("   EP1 opening: hook injected as beat 1 (cached script)");
            }
          }
        }

        const transcript = _hooks.panelTranscript(
          obs as unknown as ObsLike,
          block as unknown as BlockLike | null,
        );
        fs.writeFileSync(path.join(cdir, "transcript.md"), transcript);

        let prevScript = "";
        for (let _i = chN - 1; _i > 0; _i--) {
          const _p = _scriptOf(out, `ch${_i}`);
          if (_p) {
            prevScript = fs.readFileSync(_p, "utf8");
            break;
          }
        }

        _hooks.telemetry.stage(ch, "writer", "done");
        scriptStage = "check";
        _hooks.telemetry.stage(ch, "check");

        const charNames: string[] = [];
        for (const c of Object.values(charsObj)) {
          if (isRecord(c) && typeof c.name === "string") {
            charNames.push(c.name);
          }
        }
        for (const c of Object.values(charsObj)) {
          if (isRecord(c) && Array.isArray(c.aliases)) {
            for (const a of c.aliases) {
              charNames.push(String(a));
            }
          }
        }

        // Cached script: writeScript never ran, so LAST_WINDOW is empty after the reset
        // above. Recompute THIS chapter's window from the out dir instead of passing ""
        // (or, before the reset, the previous chapter's stale window).
        let windowTxt = writerMod.LAST_WINDOW;
        if (!windowTxt && /\d/.test(ch)) {
          windowTxt = writerMod.previousWindow(out, ch)[0];
        }

        const issues = _hooks.factCheck.check(script, transcript, {
          windowTxt,
          promo: block,
          prevScript,
          characterNames: charNames,
        });

        const nlines = pySplitLines(script).filter(
          (l) => pyStrip(l) && !pyLstrip(l).startsWith("#"),
        ).length;
        if (nlines === 0) {
          // I-14: a zero-line script is a FAILURE, never a PASS with a queue slot
          throw new RuntimeError("writer produced 0 narration lines");
        }

        let nwords = 0;
        for (const l of pySplitLines(script)) {
          if (pyStrip(l) && !pyLstrip(l).startsWith("#")) {
            const strippedLine = l.replace(/@p\d+(?:_\d+)?|\[[a-z ]+\]/g, "");
            nwords += pySplit(strippedLine).length;
          }
        }
        const ntags = (script.match(/@p\d{4}_\d+/g) ?? []).length || 1;
        console.log(
          `   words: ${nwords}` +
            (writerMod.LAST_BUDGET ? ` (budget ${writerMod.LAST_BUDGET})` : "") +
            ` | ${pyRoundFixed(nwords / ntags, 1)} words per tagged panel`,
        );
        console.log(
          `   script: ${nlines} lines | fact_check: ` +
            (issues.length === 0 ? "PASS" : `FAIL (${issues.length})`),
        );
        // UNGROUNDED is advisory: factCheck.ts documents its measured F1 of 0.35.
        const flagged = issues.filter((issue) => !/^UNGROUNDED\b/.test(String(issue)));
        _hooks.telemetry.stage(ch, "check", flagged.length > 0 ? "warning" : "done", {
          findings: issues.length,
          flagged: flagged.length,
          lines: nlines,
          words: nwords,
        });
        for (const i of issues.slice(0, 8)) {
          console.log("     -", i);
        }

        fs.writeFileSync(
          path.join(cdir, "report.json"),
          pyJsonPretty(
            {
              series,
              ch,
              status: "ok",
              lines: nlines,
              issues,
              window_holes: !repair ? missing : [],
            },
            1,
          ),
        );
        results.push([ch, "ok"]);
        if (video) {
          _hooks.telemetry.stage(ch, "audio", "queued");
          vq.put(ch); // script lane CONTINUES - render happens off-thread
          console.log("   -> queued for video lane (renders while next chapter reads)");
        }
        break; // success: leave the retry loop
      } catch (e) {
        const cls = failClass(e);
        const errMsg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`  !! ${ch} FAILED (${cls}): ${errMsg.slice(0, 200)}\n`);
        log(`CHAPTERFAIL ${series}/${ch} attempt=${attempt + 1} class=${cls}: ${errMsg}`);
        if (cls !== "permanent" && attempt < RETRY_ROUNDS) {
          const w = RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)]!;
          console.log(`     retrying ${ch} in ${w}s (per-batch cache resumes)...`);
          _hooks.telemetry.retrying(ch, e, {
            retryAt: _hooks.time.now() + w,
            attempt: attempt + 1,
            maxAttempts: RETRY_ROUNDS + 1,
          });
          await _hooks.time.sleep(w);
          continue;
        }
        _hooks.telemetry.failed(ch, e);
        const cdir = path.join(out, ch);
        fs.mkdirSync(cdir, { recursive: true });
        const reportPath = path.join(cdir, "report.json");
        let prior: Record<string, unknown> = {};
        if (fs.existsSync(reportPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
            if (isRecord(parsed)) prior = parsed;
          } catch {
            prior = {};
          }
        }
        fs.writeFileSync(
          reportPath,
          pyJsonPretty(
            {
              ...prior,
              series,
              ch,
              status: "failed",
              class: cls,
              error: errMsg.slice(0, 500),
              previous_status: prior.status ?? null,
            },
            1,
          ),
        );
        results.push([ch, "failed"]);
        halted = ch;
        break;
      }
    }
  }

  const ok = results.filter(([, s]) => s === "ok").map(([c]) => c);
  let bad = results.filter(([, s]) => s === "failed").map(([c]) => c);
  console.log(`\nsummary: ${ok.length} ok` + (bad.length > 0 ? ` | FAILED: ${bad.join(", ")}` : ""));
  if (halted) {
    const idx = chs.indexOf(halted);
    const remaining = idx >= 0 ? chs.slice(idx + 1) : [];
    if (remaining.length > 0) {
      console.log(
        `HALTED at ${halted} per chain policy - later chapters NOT touched (${pyRepr(remaining).slice(0, 120)})`,
      );
    } else {
      console.log(`HALTED at ${halted} per chain policy (last chapter).`);
    }
    console.log("Fix the blocker and rerun: caches resume exactly where they stopped.");
  }

  if (video && vt) {
    console.log("video lane: waiting for queue to drain...");
    // If the worker dies first, join() would never resolve: race it and drain.
    await Promise.race([vq.join(), vt]);
    failQueuedVideoChapters(); // no-op when the queue already drained
    if (videoWorkerError === null) {
      vq.put(null); // stop the worker
    }
    await vt;
    const vok = Object.entries(vresults)
      .filter(([, r]) => r.status === "video-ok")
      .map(([c]) => c)
      .sort(cmpCodePoints);
    const vbad = Object.entries(vresults)
      .filter(([, r]) => r.status === "video-failed")
      .map(([c]) => c)
      .sort(cmpCodePoints);
    for (const c of [...vok, ...vbad]) {
      const rp = path.join(out, c, "report.json");
      let rep: Record<string, unknown> = {};
      if (fs.existsSync(rp)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(rp, "utf8"));
          if (isRecord(parsed)) rep = parsed;
        } catch {
          rep = {};
        }
      }
      Object.assign(rep, vresults[c]);
      const tmp = `${rp}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, pyJsonPretty(rep, 1));
      fs.renameSync(tmp, rp);
    }
    console.log(
      `videos: ${vok.length} ok` + (vbad.length > 0 ? ` | FAILED: ${vbad.join(", ")}` : ""),
    );
    for (const c of vok) {
      const vr = vresults[c]!;
      console.log(`   ${c}: ${vr.video}  (${pyRoundFixed(Number(vr.duration ?? 0), 0)}s)`);
    }
    if (vbad.length > 0) {
      bad = [...new Set([...bad, ...vbad])].sort(cmpCodePoints);
    }
  }

  _hooks.telemetry.finish(bad.length === 0);
  return bad.length === 0 ? 0 : 1;
}
export const _run_locked = _runLocked;

/* ------------------------------------------------------------------ *
 * CLI flag parsing & main
 * ------------------------------------------------------------------ */

export function _pullReaderCaptions(argv: readonly string[]): [number, string[]] {
  /**
   * Pull `--reader-captions vN` (or `--reader-captions=vN`) out of argv.
   *
   * This runner hand-parses flags and treats every non-`--` token as a positional, so an
   * un-stripped value would be read as a CHAPTER NAME. Returns [caption_version, argv
   * without the flag and its value]; argv is otherwise untouched, so every other flag and
   * every existing chapter argument behaves exactly as before.
   */
  let cv: number = CAPTION_VERSION;
  const rest: string[] = [];
  let i = 0;
  const allowed = CAPTION_VERSIONS.map((v) => `v${v}`).join(", ");
  while (i < argv.length) {
    const a = argv[i]!;
    let val: string;
    if (a === "--reader-captions") {
      if (i + 1 >= argv.length) {
        throw new SystemExit(`--reader-captions needs a value (${allowed})`);
      }
      val = argv[i + 1]!;
      i += 2;
    } else if (a.startsWith("--reader-captions=")) {
      val = a.slice("--reader-captions=".length);
      i += 1;
    } else {
      rest.push(a);
      i += 1;
      continue;
    }
    try {
      cv = _parseCv(val);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SystemExit(`${msg}; allowed: ${allowed}`);
    }
  }
  return [cv, rest];
}
export const _pull_reader_captions = _pullReaderCaptions;

export const time = {
  now(): number {
    return Date.now() / 1000;
  },
  sleep(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, seconds) * 1000);
    });
  },
};

export interface RunHooks {
  SERIES_ROOT: string;
  readChapter: typeof readChapter;
  read_chapter: typeof readChapter;
  mergeBible: typeof mergeBible;
  merge_bible: typeof mergeBible;
  writeScript: typeof writeScript;
  write_script: typeof writeScript;
  panelTranscript: typeof panelTranscript;
  panel_transcript: typeof panelTranscript;
  _loadCached: typeof _loadCached;
  _load_cached: typeof _loadCached;
  _runLocked: typeof _runLocked;
  _run_locked: typeof _runLocked;
  factCheck: typeof factCheckMod;
  fact_check: typeof factCheckMod;
  promoBlock: typeof promoBlockMod;
  promo_block: typeof promoBlockMod;
  scout: typeof scoutMod;
  renderlane: typeof renderlaneMod;
  telemetry: typeof telemetry;
  time: typeof time;
}

const runHookStore = {
  readChapter,
  mergeBible,
  writeScript,
  panelTranscript,
  _loadCached,
  _runLocked,
  factCheck: factCheckMod,
  promoBlock: promoBlockMod,
  scout: scoutMod,
  renderlane: renderlaneMod,
  telemetry,
  time,
};

export const _hooks: RunHooks = {
  get SERIES_ROOT(): string {
    return SERIES_ROOT;
  },
  set SERIES_ROOT(v: string) {
    SERIES_ROOT = v;
  },
  get readChapter() {
    return runHookStore.readChapter;
  },
  set readChapter(fn) {
    runHookStore.readChapter = fn;
  },
  get read_chapter() {
    return runHookStore.readChapter;
  },
  set read_chapter(fn) {
    runHookStore.readChapter = fn;
  },
  get mergeBible() {
    return runHookStore.mergeBible;
  },
  set mergeBible(fn) {
    runHookStore.mergeBible = fn;
  },
  get merge_bible() {
    return runHookStore.mergeBible;
  },
  set merge_bible(fn) {
    runHookStore.mergeBible = fn;
  },
  get writeScript() {
    return runHookStore.writeScript;
  },
  set writeScript(fn) {
    runHookStore.writeScript = fn;
  },
  get write_script() {
    return runHookStore.writeScript;
  },
  set write_script(fn) {
    runHookStore.writeScript = fn;
  },
  get panelTranscript() {
    return runHookStore.panelTranscript;
  },
  set panelTranscript(fn) {
    runHookStore.panelTranscript = fn;
  },
  get panel_transcript() {
    return runHookStore.panelTranscript;
  },
  set panel_transcript(fn) {
    runHookStore.panelTranscript = fn;
  },
  get _loadCached() {
    return runHookStore._loadCached;
  },
  set _loadCached(fn) {
    runHookStore._loadCached = fn;
  },
  get _load_cached() {
    return runHookStore._loadCached;
  },
  set _load_cached(fn) {
    runHookStore._loadCached = fn;
  },
  get _runLocked() {
    return runHookStore._runLocked;
  },
  set _runLocked(fn) {
    runHookStore._runLocked = fn;
  },
  get _run_locked() {
    return runHookStore._runLocked;
  },
  set _run_locked(fn) {
    runHookStore._runLocked = fn;
  },
  get factCheck() {
    return runHookStore.factCheck;
  },
  set factCheck(v) {
    runHookStore.factCheck = v;
  },
  get fact_check() {
    return runHookStore.factCheck;
  },
  set fact_check(v) {
    runHookStore.factCheck = v;
  },
  get promoBlock() {
    return runHookStore.promoBlock;
  },
  set promoBlock(v) {
    runHookStore.promoBlock = v;
  },
  get promo_block() {
    return runHookStore.promoBlock;
  },
  set promo_block(v) {
    runHookStore.promoBlock = v;
  },
  get scout() {
    return runHookStore.scout;
  },
  set scout(v) {
    runHookStore.scout = v;
  },
  get renderlane() {
    return runHookStore.renderlane;
  },
  set renderlane(v) {
    runHookStore.renderlane = v;
  },
  get telemetry() {
    return runHookStore.telemetry;
  },
  set telemetry(v) {
    runHookStore.telemetry = v;
  },
  get time() {
    return runHookStore.time;
  },
  set time(v) {
    runHookStore.time = v;
  },
};

export function _resetHooksForTests(): void {
  SERIES_ROOT = process.env.MANHWA_SERIES_ROOT || DEFAULT_SERIES_ROOT;
  runHookStore.readChapter = readChapter;
  runHookStore.mergeBible = mergeBible;
  runHookStore.writeScript = writeScript;
  runHookStore.panelTranscript = panelTranscript;
  runHookStore._loadCached = _loadCached;
  runHookStore._runLocked = _runLocked;
  runHookStore.factCheck = factCheckMod;
  runHookStore.promoBlock = promoBlockMod;
  runHookStore.scout = scoutMod;
  runHookStore.renderlane = renderlaneMod;
  runHookStore.telemetry = telemetry;
  runHookStore.time = time;
}

function parseScoutRange(flag: string): number {
  const raw = flag.split("=")[1] ?? "";
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SystemExit(`--scout-range needs a positive integer, got ${flag}`);
  }
  return value;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [_cv, _argv] = _pullReaderCaptions(argv);
  const flags = _argv.filter((a) => a.startsWith("--"));
  const args = _argv.filter((a) => !a.startsWith("--"));
  if (args.length === 0) {
    throw new SystemExit(DOC);
  }
  const series = args[0]!;
  const chs = args.slice(1);
  if (flags.includes("--status")) {
    status(series, _cv);
    return 0;
  }
  if (flags.includes("--clear-cache")) {
    const sdir = path.join(_hooks.SERIES_ROOT, series);
    withSharedSeriesLock({ directSdir: sdir, requireExists: false }, () => {
      clearCache(series, chs.length > 0 ? chs : chaptersIn(sdir), _cv);
    });
    return 0;
  }
  const scoutRangeFlag = flags.find((a) => a.startsWith("--scout-range="));
  const scoutRange = scoutRangeFlag ? parseScoutRange(scoutRangeFlag) : 5;
  return await run(series, chs, {
    force: flags.includes("--force"),
    keepStale: flags.includes("--keep-stale"),
    video: flags.includes("--video"),
    writeAnyway: flags.includes("--write-anyway"),
    scoutOnly: flags.includes("--scout"),
    scoutRange,
    captionVersion: _cv,
    all: flags.includes("--all"),
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      if (err instanceof SystemExit) {
        if (typeof err.code === "number") {
          process.exit(err.code);
        }
        process.stderr.write(`${err.code}\n`);
        process.exit(1);
      }
      console.error(err);
      process.exit(1);
    },
  );
}
