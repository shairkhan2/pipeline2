/**
 * timeline.ts - port of timeline.py (script + obs + per-line durations -> shots).
 *
 * TTS and external-config helpers live in audio.ts and are re-exported here so a
 * caller importing from timeline.ts finds everything timeline.py exports.
 *
 * buildShots is synchronous. Panel pixel size is read from the JPEG/PNG header
 * (PIL Image.size, no EXIF transpose), not from async sharp().metadata().
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pyRound, pyRoundFixed } from "./factCheck.js";
import {
  _edgeLine,
  _externalCachePayload,
  _lineFile,
  _lineProofToken,
  _narrationCacheKey,
  _parseExternalCommand,
  _probeDuration,
  _resolveExternalTtsConfig,
  _trimSilence,
  gsk,
  narration,
  RuntimeError,
  sequenceMatcherRatio,
  shlexSplit,
  sweep,
  synth,
  TRANS_CACHE,
  transcribe,
  ttsConcat,
  ttsLines,
  ttsLinesEleven,
  ttsLinesExternal,
  ttsLinesVertex,
  ttsLinesGrok,
  edgeRateFromSpeed,
  LOCALE_EDGE_RATE,
  stripEmotionControls,
  ValueError,
  VOICE,
  RATE,
  type DriftWord,
  type ExternalTtsConfig,
} from "./audio.js";
import { pyFloat, pyFloatRepr, pyJsonDumps, pyReprStr, type PyFloatMarker } from "../contracts/hashes.js";
import { validBox, validFocusX, type Shot } from "../contracts/schemas.js";
import {
  adjKeys,
  FAR_KEY,
  isAdj,
  isChain,
  isPid,
  keymap,
  NEG_KEY,
  type OrderKey,
} from "../domain/panels.js";
import { Block, ensure as ensurePromoBlock, load as loadPromoBlock } from "../intake/promoBlock.js";
import { getStudioSettings, type RenderQuality } from "../config/studioConfig.js";
import { GEMINI_LOCALE_REQUEST_REV, isGeminiTtsVoiceId } from "../llm/vertexTts.js";
import {
  assertNoSymlinkPath,
  getLanguageEntry,
  languageRootDir,
  languageStagingId,
  SUPPORTED_LOCALES,
  validateLocale,
} from "../config/languages.js";
import { stage } from "../telemetry/telemetry.js";
import { resolveMusicBed } from "./music.js";
import { normalizeCardAnimation } from "../intake/ingest.js";

export {
  gsk,
  VOICE,
  RATE,
  narration,
  synth,
  transcribe,
  sweep,
  sequenceMatcherRatio,
  shlexSplit,
  TRANS_CACHE,
  ValueError,
  RuntimeError,
  _trimSilence,
  _probeDuration,
  _parseExternalCommand,
  _resolveExternalTtsConfig,
  _externalCachePayload,
  _narrationCacheKey,
  _lineProofToken,
  _lineFile,
  _edgeLine,
  ttsLinesEleven,
  ttsLinesExternal,
  ttsLinesVertex,
  ttsLinesGrok,
  ttsLines,
  ttsConcat,
  edgeRateFromSpeed as edge_rate_from_speed,
  LOCALE_EDGE_RATE as locale_edge_rate,
  stripEmotionControls as strip_emotion_controls,
  _trimSilence as _trim_silence,
  _probeDuration as _probe_duration,
  _parseExternalCommand as _parse_external_command,
  _resolveExternalTtsConfig as _resolve_external_tts_config,
  _externalCachePayload as _external_cache_payload,
  _narrationCacheKey as _narration_cache_key,
  _lineProofToken as _line_proof_token,
  _lineFile as _line_file,
  _edgeLine as _edge_line,
  ttsLinesEleven as tts_lines_eleven,
  ttsLinesExternal as tts_lines_external,
  ttsLinesVertex as tts_lines_vertex,
  ttsLinesGrok as tts_lines_grok,
  ttsLines as tts_lines,
  ttsConcat as tts_concat,
};
export type { DriftWord, ExternalTtsConfig };
export { validBox as _validBox, validFocusX as _validFocusX, validBox as _valid_box, validFocusX as _valid_focus_x };
export {
  FAR_KEY as _FAR,
  NEG_KEY as _NEG,
  keymap as _keymap,
  isPid as _pid,
  adjKeys as _adj_keys,
  isAdj as _is_adj,
  isChain as _chain,
};

/** Shortest on-screen time per panel when a line splits across several panels. */
export const MIN_PANEL_S = 1.5;
/** v1 Python floor (timeline.py MIN_PANEL_S); golden parity runs pass it explicitly. */
export const LEGACY_MIN_PANEL_S = 0.8;
export const ART_MIN = 0.5;
export const SWAP_FLOOR = 0.6;

/** Render quality for this chapter: env override wins, then persisted Studio settings. */
export function resolveRenderQuality(): RenderQuality {
  const envValue = (process.env.MANHWA_RENDER_QUALITY ?? "").trim().toLowerCase();
  if (envValue === "720p" || envValue === "720") return "720p";
  if (envValue === "1080p" || envValue === "1080") return "1080p";
  try {
    return getStudioSettings().renderQuality;
  } catch {
    return "1080p";
  }
}

const DEFAULT_STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "remotion-studio");
export const STUDIO_PUBLIC = process.env.MANHWA_STUDIO_PUBLIC
  ?? join(process.env.MANHWA_STUDIO ?? DEFAULT_STUDIO, "public");

const PY_W = "[\\p{L}\\p{Nd}\\p{Nl}\\p{No}_]";
const UWB = `(?:(?<=${PY_W})(?!${PY_W})|(?<!${PY_W})(?=${PY_W}))`;

/** Overlay-about-text: showing the text panel is allowed, max 2 consecutive. */
export const ABOUT_TEXT = new RegExp(
  `${UWB}(system|window|status|achievement|skill|quest|title|attribute|level|tier|energy|\\+1)${UWB}`,
  "iu",
);

export type ScriptLine = [string, string[]];
export type Span = [number, number];

export interface TimelineShot extends Shot {
  _src?: string;
}

export class SystemExit extends Error {
  readonly code: string | number;
  constructor(code: string | number = 0) {
    super(typeof code === "string" ? code : String(code));
    this.name = "SystemExit";
    this.code = code;
  }
}

export interface MainOptions {
  /** Skip the eleven ASR sweep. Python: "--no-audio-check" in sys.argv. */
  noAudioCheck?: boolean;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Language version to render (`hi-IN`). Absent/null = English, unchanged.
   * The caller supplies `scriptPath`/`obsPath`/`outDir` already resolved for the
   * locale (see `languageChapterDir`); `outDir` is the LOCALE output dir.
   */
  locale?: string | null;
  /**
   * Per-run TTS override for the locale (engine/voice_id/language/speed/...).
   * Merged over the series meta for THIS run only; meta.json is never written.
   */
  tts?: Record<string, unknown> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numGet(rec: Record<string, unknown> | null | undefined, key: string, def: number): number {
  if (!rec || !Object.prototype.hasOwnProperty.call(rec, key) || rec[key] == null) return def;
  const v = rec[key];
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

function keyId(k: OrderKey): string {
  return `${k[0]},${k[1]}`;
}

function sameKey(a: OrderKey | undefined, b: OrderKey): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

function keyLess(a: OrderKey, b: OrderKey): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function keyGreater(a: OrderKey, b: OrderKey): boolean {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

/** Python float floor division. Not Math.floor(a/b): 4.0 // 0.8 is 4, not 5. */
function pyFloorDiv(vx: number, wx: number): number {
  const mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod && (wx < 0) !== (mod < 0)) div -= 1.0;
  if (!div) return 0;
  let floordiv = Math.floor(div);
  if (div - floordiv > 0.5) floordiv += 1.0;
  return floordiv;
}

function pyGet(obj: unknown, key: string, def: unknown): unknown {
  if (isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return def;
}

/**
 * PIL Image.size, synchronous. JPEG SOF width/height (no EXIF transpose) or PNG IHDR.
 * Throws if the header cannot be read, same as Image.open on a bad file.
 */
export function imageSizeSync(path: string): [number, number] {
  const buf = readFileSync(path);
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 1 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) break;
      const marker = buf[i]!;
      i++;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      if (i + 1 >= buf.length) break;
      const len = buf.readUInt16BE(i);
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        if (i + 6 >= buf.length) break;
        const h = buf.readUInt16BE(i + 3);
        const w = buf.readUInt16BE(i + 5);
        return [w, h];
      }
      if (len < 2) break;
      i += len;
    }
    throw new Error(`cannot read JPEG size: ${path}`);
  }
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  throw new Error(`cannot identify image file: ${path}`);
}

function splitextBase(panel: string): string {
  const base = panel.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

// ---------------------------------------------------------------------------
// parse_script
// ---------------------------------------------------------------------------

const TAG_SRC = /@p(\d{4})(?:_(\d+))?/g;
const STRIP_TAG_SRC = /@p\d+(?:_\d+)?/g;

function pyStripLine(s: string): string {
  return s.replace(/^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0085]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0085]+$/g, "");
}

function pyLstripLine(s: string): string {
  return s.replace(/^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0085]+/, "");
}

/**
 * Tags: @pXXXX_N (panel) or @pXXXX (page-level, resolved to the artiest panel).
 * All @p tokens are stripped before TTS. Tag-only lines attach to the previous
 * narration line; leading ones attach to the next.
 */
export function parseScript(path: string): ScriptLine[] {
  const raw = readFileSync(path, "utf8");
  const rawLines = raw === "" ? [] : raw.split(/\r\n|\n|\r/);
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: ScriptLine[] = [];
  let pending: string[] = [];
  for (let l of rawLines) {
    if (!pyStripLine(l) || pyLstripLine(l).startsWith("#")) continue;
    const hold = l.includes("@hold");
    l = l.replaceAll("@hold", "");
    const tags: string[] = hold ? ["@hold"] : [];
    TAG_SRC.lastIndex = 0;
    for (const m of l.matchAll(TAG_SRC)) {
      tags.push(m[2] !== undefined ? `p${m[1]}_${m[2]}` : `page:${m[1]}`);
    }
    STRIP_TAG_SRC.lastIndex = 0;
    const text = pyStripLine(l.replace(STRIP_TAG_SRC, ""));
    if (!text) {
      if (lines.length) lines[lines.length - 1]![1].push(...tags);
      else pending.push(...tags);
      continue;
    }
    lines.push([text, pending.concat(tags)]);
    pending = [];
  }
  if (pending.length && lines.length) lines[lines.length - 1]![1].push(...pending);
  return lines;
}

// ---------------------------------------------------------------------------
// pick_panels
// ---------------------------------------------------------------------------

export function _explicitFullPromo(pg: Record<string, unknown> | null | undefined): boolean {
  return (pg ?? {}).promo_page === true;
}

/**
 * Resolve tags and apply the layer rule. Returns [panelIds, swaps, newConsec].
 *
 * Adjacency-first ladder (do not reorder):
 *   1. immediate reading-order neighbour, if not already tagged and it passes the gate
 *   2. other sibling on the same page, best art, prefer unseen
 *   3. shrink the run from an end (never the middle, never to zero)
 *   4. a panel on an adjacent page, only when this line has a single panel
 *   5. keep the cited panel and log why
 * A destination on a multi-panel line must sort strictly between the neighbouring tags.
 */
export function pickPanels(
  byId: Record<string, Record<string, unknown>>,
  tags: readonly string[],
  lineText: string,
  consec: number,
  block: Block | null = null,
  seen: Set<string> | null = null,
): [string[], string[], number] {
  const out: string[] = [];
  const swaps: string[] = [];
  const km = keymap(byId);
  const succ = adjKeys(km);
  const tagged = new Set(tags);
  const runN = tags.length;
  let dropped = 0;

  const promo = (q: string | Record<string, unknown>): boolean => {
    const pg = typeof q === "string" ? (byId[q] ?? {}) : q;
    if (_explicitFullPromo(pg)) return true;
    if (!block) return false;
    return block.panelFullPromo(pg);
  };
  const gate = (q: string, needFloor: boolean, seenFirst: boolean): boolean => {
    if (promo(q)) return false;
    const a = numGet(byId[q], "art", 0.5);
    // timeline.py line: `if not need_floor and a < SWAP_FLOOR`. Polarity is the
    // source of truth for the golden shots. Do not invert it.
    if (!needFloor && a < SWAP_FLOOR) return false;
    if (seenFirst && seen != null && seen.has(q) && !tagged.has(q)) return false;
    return true;
  };

  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti]!;
    const explicit = !t.startsWith("page:");
    let pid: string;
    if (t.startsWith("page:")) {
      const page = t.split(":")[1] ?? "";
      const sibs = Object.keys(byId).filter((q) => q.startsWith(`p${page}_`));
      if (sibs.length === 0) continue;
      const clean = sibs.filter((q) => !promo(q));
      const cand = clean.length ? clean : sibs;
      let best = cand[0]!;
      let bestA = numGet(byId[best], "art", 0.5);
      for (const q of cand.slice(1)) {
        const a = numGet(byId[q], "art", 0.5);
        if (a > bestA) {
          best = q;
          bestA = a;
        }
      }
      pid = best;
      swaps.push(`@p${page}->best panel ${pid}`);
    } else {
      pid = t;
    }
    let p = byId[pid];
    if (!p) continue;
    let art = numGet(p, "art", 1.0);
    let needFloor = true;
    if (promo(p)) needFloor = false;
    if (((art < ART_MIN && !explicit) || !needFloor) && !(ABOUT_TEXT.test(lineText) && consec < 2)) {
      const key = km[pid] ?? FAR_KEY;
      const prevT = ti ? tags[ti - 1] : undefined;
      const nextT = ti + 1 < runN ? tags[ti + 1] : undefined;
      const inWindow = (q: string): boolean => {
        const k = km[q] ?? FAR_KEY;
        const lo = isPid(prevT ?? "") ? (km[prevT!] ?? FAR_KEY) : NEG_KEY;
        const hi = isPid(nextT ?? "") ? (km[nextT!] ?? FAR_KEY) : FAR_KEY;
        return keyLess(lo, k) && keyLess(k, hi);
      };
      const keepsRun = (q: string): boolean => {
        if (runN === 1 || !isChain(tags, km, succ)) return true;
        return isChain(tags.map((tag) => (tag === pid ? q : tag)), km, succ);
      };
      const rank = (q: string): number => {
        if (isAdj(key, km[q] ?? FAR_KEY, succ)) return 0;
        if ((km[q] ?? FAR_KEY)[0] === key[0]) return 1;
        return runN === 1 ? 2 : 9;
      };
      const pool: Array<[number, number, number, string]> = [];
      for (const q of Object.keys(byId)) {
        if (!isPid(q) || q === pid || tagged.has(q) || !inWindow(q)) continue;
        if (!keepsRun(q) || rank(q) > 2) continue;
        const qKey = km[q] ?? FAR_KEY;
        pool.push([
          rank(q),
          -numGet(byId[q], "art", 0.5),
          keyGreater(qKey, key) ? 0 : 1,
          q,
        ]);
      }
      let gated = pool.filter((row) => gate(row[3], needFloor, true));
      if (gated.length === 0) gated = pool.filter((row) => gate(row[3], needFloor, false));
      if (gated.length) {
        let bestRow = gated[0]!;
        for (const row of gated.slice(1)) {
          if (row[0] !== bestRow[0] ? row[0] < bestRow[0]
            : row[1] !== bestRow[1] ? row[1] < bestRow[1]
            : row[2] !== bestRow[2] ? row[2] < bestRow[2]
            : row[3] < bestRow[3]) {
            bestRow = row;
          }
        }
        const best = bestRow[3];
        const bart = numGet(byId[best], "art", 0.5);
        if (bart > art || !needFloor) {
          const inRun = isAdj(key, km[best] ?? FAR_KEY, succ);
          swaps.push(
            `${pid}->${best} (art ${pyFloatRepr(art)}->${pyFloatRepr(bart)}`
            + (needFloor ? "" : ", promo-escape")
            + (inRun ? ", in-run" : ", same-page")
            + ")",
          );
          p = byId[best]!;
          pid = best;
          art = numGet(p, "art", 1.0);
        } else {
          swaps.push(`${pid} kept (adjacent alt ${best} art ${pyFloatRepr(bart)} not better)`);
        }
      } else if (runN - dropped > 1 && (ti === 0 || ti === runN - 1)) {
        swaps.push(`${pid} dropped (run end, no showable neighbour)`);
        dropped += 1;
        continue;
      } else {
        swaps.push(
          `${pid} kept (no showable neighbour`
          + (runN === 1 ? "" : "; last member of the run, dropping it would empty the line")
          + ")",
        );
      }
    }
    consec = art < ART_MIN ? consec + 1 : 0;
    out.push(pid);
  }
  return [out, swaps, consec];
}

// ---------------------------------------------------------------------------
// borrow
// ---------------------------------------------------------------------------

export function _borrowable(
  pg: Record<string, unknown>,
  block: Block | null = null,
): boolean {
  if (_explicitFullPromo(pg)) return false;
  if (block && block.panelFullPromo(pg)) return false;
  if (numGet(pg, "art", 1.0) < ART_MIN) return false;
  return String(pg.bubble_at ?? "").trim().toLowerCase() !== "full";
}

export function _nearestUnseen(
  byId: Record<string, Record<string, unknown>>,
  pid: string,
  seen: Set<string>,
  block: Block | null = null,
  prev: string | null = null,
  reserved: Iterable<string> = [],
): string | null {
  const reservedSet = reserved instanceof Set ? reserved : new Set(reserved);
  const m = /^p(\d+)/.exec(pid || "");
  const page = m ? Number.parseInt(m[1]!, 10) : 0;
  const cands: Array<[number, string]> = [];
  for (const q of Object.keys(byId)) {
    const qm = /^p(\d+)/.exec(q);
    if (!qm || reservedSet.has(q) || !_borrowable(byId[q]!, block)) continue;
    cands.push([Math.abs(Number.parseInt(qm[1]!, 10) - page), q]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, q] of cands) {
    if (!seen.has(q) && q !== prev) return q;
  }
  for (const [, q] of cands) {
    if (q !== prev) return q;
  }
  if (prev != null && !reservedSet.has(prev)) return prev;
  return reservedSet.has(pid) ? null : pid;
}

export function _borrowRun(
  byId: Record<string, Record<string, unknown>>,
  want: readonly string[],
  seen: Set<string>,
  block: Block | null = null,
  prev: string | null = null,
  n = 1,
  reserved: Iterable<string> = [],
): string[] {
  const need = Math.max(1, Math.trunc(n));
  const reservedSet = reserved instanceof Set ? reserved : new Set(reserved);
  const km = keymap(byId);
  const succ = adjKeys(km);
  const key = want.length ? (km[want[0]!] ?? FAR_KEY) : FAR_KEY;
  const pool = Object.keys(byId).filter((q) =>
    isPid(q) && !seen.has(q) && q !== prev && !reservedSet.has(q) && _borrowable(byId[q]!, block));
  if (pool.length === 0) {
    const near = _nearestUnseen(byId, want[0] ?? "", seen, block, prev, reservedSet);
    return near != null ? [near] : [];
  }
  const sorted = [...pool].sort((a, b) => {
    const ka = km[a] ?? FAR_KEY;
    const kb = km[b] ?? FAR_KEY;
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  const chains: string[][] = [];
  let cur: string[] = [];
  for (const q of sorted) {
    if (cur.length) {
      const prevK = km[cur[cur.length - 1]!] ?? FAR_KEY;
      const qk = km[q] ?? FAR_KEY;
      if (!sameKey(succ[keyId(prevK)], qk)) {
        chains.push(cur);
        cur = [];
      }
    }
    cur.push(q);
  }
  if (cur.length) chains.push(cur);
  const order = [...chains].sort((a, b) => {
    const da = Math.abs((km[a[0]!] ?? FAR_KEY)[0] - key[0]);
    const db = Math.abs((km[b[0]!] ?? FAR_KEY)[0] - key[0]);
    if (da !== db) return da - db;
    return b.length - a.length;
  });
  for (const c of order) {
    if (c.length >= need) return c.slice(0, need);
  }
  return order[0]!.slice(0, need);
}

// ---------------------------------------------------------------------------
// art map + build_shots
// ---------------------------------------------------------------------------

export interface ArtStat {
  manifest: "ok" | "missing" | "bad";
  invalid: number;
}

export function _artMap(panelsDir: string): [Record<string, [number, number]>, ArtStat] {
  let recs: unknown;
  try {
    recs = JSON.parse(readFileSync(join(panelsDir, "manifest.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [{}, { manifest: "missing", invalid: 0 }];
    return [{}, { manifest: "bad", invalid: 0 }];
  }
  if (isRecord(recs)) recs = recs.panels ?? recs.recs ?? [];
  if (!Array.isArray(recs)) return [{}, { manifest: "bad", invalid: 0 }];
  const m: Record<string, [number, number]> = {};
  let bad = 0;
  for (const r of recs) {
    if (!isRecord(r)) {
      bad += 1;
      continue;
    }
    const pid = splitextBase(String(r.panel ?? ""));
    if (!pid) {
      bad += 1;
      continue;
    }
    const at = r.art_top;
    const ab = r.art_bottom;
    if (typeof at === "boolean" || typeof ab === "boolean"
      || typeof at !== "number" || typeof ab !== "number"
      || !Number.isFinite(at) || !Number.isFinite(ab)
      || !(at >= 0 && at < ab && ab <= 1)) {
      bad += 1;
      continue;
    }
    m[pid] = [at, ab];
  }
  return [m, { manifest: "ok", invalid: bad }];
}

export function buildShots(
  lines: ReadonlyArray<readonly [string, readonly string[]]>,
  spans: ReadonlyArray<readonly [number, number]>,
  obs: { panels: ReadonlyArray<Record<string, unknown>> },
  panelsDir: string,
  block: Block | null = null,
  hookFirst = false,
  minPanelS: number = MIN_PANEL_S,
): TimelineShot[] {
  const byId: Record<string, Record<string, unknown>> = {};
  for (const p of obs.panels) byId[String(p.id)] = p;
  const [art, artStat] = _artMap(panelsDir);

  const promoPid = (q: string): boolean => {
    const pg = byId[q] ?? {};
    if (_explicitFullPromo(pg)) return true;
    return Boolean(block && block.panelFullPromo(pg));
  };

  let dropBox = 0, dropFx = 0, missPid = 0, noManifest = 0;
  const hookPanels = new Set<string>();
  if (hookFirst && lines.length) {
    for (const t of lines[0]![1]) if (t !== "@hold") hookPanels.add(t);
  }
  const calledBack = new Set<string>();
  const shots: TimelineShot[] = [];
  const allSwaps: string[] = [];
  let consec = 0;
  let last: string | null = null;
  const seen = new Set<string>();
  let deduped = 0;
  let repeated = 0;
  let runOverlap = 0;
  const explicitCounts = new Map<string, number>();
  for (const [, tags] of lines) {
    if (tags.includes("@hold")) continue;
    for (const tag of tags) {
      if (isPid(tag) && tag in byId && !promoPid(tag)) {
        explicitCounts.set(tag, (explicitCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const n = Math.min(lines.length, spans.length);
  for (let li = 0; li < n; li++) {
    const [text, rawTags] = lines[li]!;
    const [s, e] = spans[li]!;
    const dur = Math.max(e - s, minPanelS);
    if (rawTags.includes("@hold")) {
      if (shots.length) shots[shots.length - 1]!.end_s = pyRound(e, 2);
      continue;
    }
    let tags = rawTags.filter((t) => t !== "@hold");
    if (tags.length === 0 && shots.length) {
      shots[shots.length - 1]!.end_s = pyRound(e, 2);
      continue;
    }
    for (const t of tags) {
      if (isPid(t) && t in byId && !promoPid(t)) {
        explicitCounts.set(t, (explicitCounts.get(t) ?? 0) - 1);
      }
    }
    const reserved = new Set<string>();
    for (const [q, c] of explicitCounts) if (c > 0) reserved.add(q);
    const explicitValid = new Set(tags.filter((t) => isPid(t) && t in byId && !promoPid(t)));
    let panels: string[] = tags.length
      ? [...tags]
      : (last && !seen.has(last) ? [last] : []);
    if (panels.length === 0 && last) {
      const near = _nearestUnseen(byId, last, seen, block, last, reserved);
      panels = near ? [near] : [];
    }
    if (panels.length === 0) continue;
    const callback = panels.filter((p) => hookPanels.has(p) && !calledBack.has(p) && shots.length > 0);
    let rest = panels.filter((p) => !callback.includes(p));
    if (rest.length) {
      const picked = pickPanels(byId, rest, text, consec, block, seen);
      rest = picked[0];
      allSwaps.push(...picked[1]);
      consec = picked[2];
    }
    if (callback.length) {
      const it = rest[Symbol.iterator]();
      const merged: string[] = [];
      for (const p of panels) {
        if (callback.includes(p)) merged.push(p);
        else {
          const nxt = it.next();
          if (!nxt.done && nxt.value) merged.push(nxt.value);
        }
      }
      panels = merged;
    } else {
      panels = rest;
    }
    if (panels.length === 0) continue;
    const spent = panels.filter((p) => seen.has(p) && !callback.includes(p));
    if (spent.length === panels.length) {
      if (!panels.every((p) => explicitValid.has(p) || callback.includes(p))) {
        deduped += panels.length;
        const borrowed = _borrowRun(byId, panels, seen, block, last, panels.length, reserved);
        panels = borrowed.length ? borrowed : panels;
      }
    } else if (spent.length) {
      runOverlap += spent.length;
    }
    let per = dur / panels.length;
    if (per < minPanelS && panels.length > 1) {
      const keepN = Math.max(1, pyFloorDiv(dur, minPanelS));
      const ranked = panels.map((_, idx) => idx).sort((a, b) => {
        const wa = numGet(byId[panels[a]!], "weight", 2);
        const wb = numGet(byId[panels[b]!], "weight", 2);
        if (wa !== wb) return wb - wa;
        const la = a === panels.length - 1 ? 1 : 0;
        const lb = b === panels.length - 1 ? 1 : 0;
        if (la !== lb) return lb - la;
        return a - b;
      }).slice(0, keepN).sort((a, b) => a - b);
      panels = ranked.map((idx) => panels[idx]!);
      per = dur / panels.length;
    }
    const shown: string[] = [];
    for (let i = 0; i < panels.length; i++) {
      const pid = panels[i]!;
      const f = join(panelsDir, `${pid}.jpg`);
      if (!existsSync(f)) continue;
      const [pw, ph] = imageSizeSync(f);
      const pg = byId[pid]!;
      let at: number, ab: number;
      const bounds = art[pid];
      if (bounds) {
        at = bounds[0];
        ab = bounds[1];
      } else {
        at = 0;
        ab = 1;
        if (artStat.manifest === "ok") missPid += 1;
        else noManifest += 1;
      }
      const rawBox = Object.prototype.hasOwnProperty.call(pg, "box") ? pg.box : undefined;
      const rawFx = Object.prototype.hasOwnProperty.call(pg, "focus_x") ? pg.focus_x : undefined;
      const box = validBox(rawBox);
      const fx = validFocusX(rawFx);
      if (box === null && rawBox != null) dropBox += 1;
      if (fx === null && rawFx != null) dropFx += 1;
      const focusY = Object.prototype.hasOwnProperty.call(pg, "focus_y") && pg.focus_y != null
        ? pg.focus_y as number
        : 0.5;
      const weight = Object.prototype.hasOwnProperty.call(pg, "weight") && pg.weight != null
        ? pg.weight as number
        : 2;
      const shot: TimelineShot = {
        panel: pid + ".jpg",
        start_s: pyRound(s + i * per, 2),
        end_s: pyRound(Math.min(s + (i + 1) * per, e), 2),
        line_id: li,
        focus_y: focusY,
        art_top: at,
        art_bottom: ab,
        weight: weight as 1 | 2 | 3,
        pw,
        ph,
      };
      if (box !== null) shot.box = box;
      if (fx !== null) shot.focus_x = fx;
      shots.push(shot);
      shown.push(pid);
      last = pid;
    }
    repeated += shown.filter((p) => seen.has(p) && !callback.includes(p)).length;
    for (const p of shown) seen.add(p);
    for (const p of shown) if (hookPanels.has(p)) calledBack.add(p);
  }
  if (allSwaps.length) console.log("panel swaps:", allSwaps.join("; "));
  shots.sort((a, b) => a.start_s - b.start_s);
  if (deduped || runOverlap) {
    console.log(
      `panel dedupe: ${deduped} whole run(s) replaced by a contiguous borrow, `
      + `${runOverlap} run member(s) re-shown intact to keep the run unbroken`,
    );
  }
  if (repeated) {
    console.log(
      `panel repeat: ${repeated} forced re-show(s) - every showable panel was `
      + `already used (unavoidable; nearest non-adjacent chosen)`,
    );
  }
  if (dropBox || dropFx || missPid || noManifest) {
    console.log(
      `shot-fields: ${shots.length} shots, dropped box=${dropBox} focus_x=${dropFx}, `
      + `art manifest=${artStat.manifest} bad_recs=${artStat.invalid} `
      + `missing_pid=${missPid} no_manifest=${noManifest}`,
    );
  }
  for (let i = 0; i < shots.length - 1; i++) {
    const a = shots[i]!;
    const b = shots[i + 1]!;
    if (b.start_s < a.end_s) b.start_s = a.end_s;
    if (b.start_s > a.end_s) a.end_s = b.start_s;
  }
  if (shots.length) {
    shots[0]!.start_s = 0.0;
    for (let i = 0; i < shots.length - 1; i++) {
      const a = shots[i]!;
      const b = shots[i + 1]!;
      if (b.start_s > a.end_s) a.end_s = b.start_s;
    }
  }
  return shots;
}

export interface DroppedPanelAssignment {
  /** Script line index that cited the panel. */
  line: number;
  /** Panel id the script asked for. */
  panel: string;
}

/**
 * Explicit `@pXXXX` assignments that produced no shot on their line.
 *
 * buildShots drops a tag when the panel is unknown, its artwork is missing, or
 * the whole line resolved to nothing. That silently changes the creative intent,
 * so the caller warns instead of shipping the degraded cut. A panel swapped by
 * `pickPanels` for a legitimate neighbour is NOT reported as long as one of the
 * line's cited panels is still shown.
 */
export function droppedPanelAssignments(
  lines: ReadonlyArray<readonly [string, readonly string[]]>,
  shots: ReadonlyArray<TimelineShot>,
): DroppedPanelAssignment[] {
  const byLine = new Map<number, Set<string>>();
  for (const s of shots) {
    const pid = String(s.panel).replace(/\.(?:jpg|jpeg|png)$/i, "");
    const lineId = s.line_id;
    if (typeof lineId !== "number") continue;
    let set = byLine.get(lineId);
    if (!set) {
      set = new Set<string>();
      byLine.set(lineId, set);
    }
    set.add(pid);
  }
  const dropped: DroppedPanelAssignment[] = [];
  for (let li = 0; li < lines.length; li++) {
    const tags = lines[li]![1];
    if (tags.includes("@hold")) continue;
    const cited = tags.filter((t) => isPid(t));
    if (cited.length === 0) continue;
    const shown = byLine.get(li) ?? new Set<string>();
    if (cited.some((p) => shown.has(p))) continue;
    for (const pid of cited) {
      // The line cited this panel and the finished cut shows none of them: the
      // resolver dropped the assignment (unknown id, missing artwork, empty run).
      dropped.push({ line: li, panel: pid });
    }
  }
  return dropped;
}

export function seriesMeta(seriesDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(seriesDir, "meta.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Version tag for locale narration cache identity. Bump only with a layout change. */
export const LOCALE_CACHE_VERSION = "loc-v1";

/**
 * Per-locale narration cache identity.
 *
 * The English key formula (`narrationCacheKey` in contracts/hashes.ts) is a paid
 * artifact contract and MUST NOT change. A localized run therefore derives its
 * own versioned key from the unchanged English base key plus the locale and the
 * effective provider settings, so a Hindi narration can never be mistaken for an
 * English one (and a voice/provider change re-bills).
 */
export function localeNarrationCacheKey(
  baseKey: string,
  locale: string,
  tts?: Record<string, unknown> | null,
): string {
  const entry = getLanguageEntry(locale);
  if (entry === null) {
    throw new ValueError(`unsupported locale ${pyRepr(String(locale))}`);
  }
  const t = tts ?? {};
  const speed = typeof t.speed === "number" && Number.isFinite(t.speed) ? t.speed : 1;
  const model = typeof t.model === "string" && t.model.trim() ? t.model.trim() : "";
  const engine = typeof t.engine === "string" && t.engine ? t.engine : entry.defaultEngine;
  const voiceId = typeof t.voice_id === "string" && t.voice_id ? t.voice_id : entry.defaultVoiceId;
  // Only a localized Vertex Gemini take embeds the request revision: those takes
  // were once billed with an instruction wrapper Gemini spoke aloud, so an old
  // key must never satisfy the new transcript-only request. Edge (and every
  // other engine) keeps its key byte-identical.
  const geminiRev = engine === "vertex" && isGeminiTtsVoiceId(voiceId) ? GEMINI_LOCALE_REQUEST_REV : null;
  const identity: Record<string, unknown> = {
    locale: entry.locale,
    engine,
    voice_id: voiceId,
    language: typeof t.language === "string" && t.language ? t.language : entry.locale,
    speed,
    provider: typeof t.provider === "string" ? t.provider : null,
    // Only a provider that names a model contributes it, so every existing
    // Edge (and pre-Vertex) Hindi narration key stays byte-identical.
    ...(model ? { model } : {}),
    ...(geminiRev === null ? {} : { request_rev: geminiRev }),
    revision: typeof t.revision === "string" ? t.revision : null,
    command: t.command ?? null,
    style: t.style ?? null,
    settings: t.settings ?? null,
  };
  const digest = createHash("sha256")
    .update(`${pyJsonDumps(identity, { sortKeys: true })}|${baseKey}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${LOCALE_CACHE_VERSION}:${entry.locale}:${digest}`;
}

/**
 * Effective `tts` block for a localized run: catalog defaults, plus the shared
 * series' provider settings, then the per-run override.
 *
 * The series' English identity fields (engine / voice_id / language) are dropped:
 * a Hindi render must never inherit the English voice. `meta.json` is not written.
 */
export function localeTtsMeta(
  seriesTts: Record<string, unknown> | null | undefined,
  override: Record<string, unknown> | null | undefined,
  locale: string,
): Record<string, unknown> {
  const entry = getLanguageEntry(locale);
  if (entry === null) {
    throw new ValueError(`unsupported locale ${pyRepr(String(locale))}`);
  }
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seriesTts ?? {})) {
    if (k === "engine" || k === "voice_id" || k === "language") continue;
    base[k] = v;
  }
  const merged: Record<string, unknown> = {
    ...base,
    engine: entry.defaultEngine,
    voice_id: entry.defaultVoiceId,
    language: entry.locale,
    speed: typeof base.speed === "number" ? base.speed : 1,
  };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

export function _applyCleaned(
  shots: Array<Record<string, unknown>>,
  items: Record<string, Record<string, unknown>>,
  res: Record<string, string | null | undefined>,
): number {
  let nClean = 0;
  for (const s of shots) {
    const pid = String(s.panel).slice(0, -4);
    const it = items[pid];
    const c = res[pid];
    if (it != null && it.promo_full && !(c && c.includes("/covered/"))) {
      throw new RuntimeError(
        `promo safety: ${pid} is a reader-classified FULL advert page and no `
        + `obscured cover exists; refusing to display it`,
      );
    }
    if (c) {
      s.panel = basename(c);
      s._src = c;
      nClean += 1;
    } else if (it != null && it.promo_item) {
      // Last resort only: both the promo mask and the cover fallback failed.
      throw new RuntimeError(
        `promo safety: ${pid} could not be cleaned or covered (promo text `
        + `present, no result); refusing to render the original advert`,
      );
    }
  }
  return nClean;
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") return pyReprStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v).map((k) => `${pyReprStr(k)}: ${pyRepr(v[k])}`).join(", ")}}`;
  }
  return String(v);
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
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else if (cp > 0x7f) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** Python json.dumps(..., indent=1), ensure_ascii=True, float via pyFloat markers. */
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
      return `{\n${keys.map((k) => `${padIn}${jsonQuote(k)}: ${render(v[k], level + 1)}`).join(",\n")}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

function dumpShot(s: TimelineShot): Record<string, unknown> {
  const o: Record<string, unknown> = {
    panel: s.panel,
    start_s: pyFloat(s.start_s),
    end_s: pyFloat(s.end_s),
    line_id: s.line_id,
    focus_y: typeof s.focus_y === "number" && !Number.isInteger(s.focus_y) ? pyFloat(s.focus_y) : s.focus_y,
    art_top: pyFloat(s.art_top ?? 0),
    art_bottom: pyFloat(s.art_bottom ?? 1),
    weight: s.weight,
    pw: s.pw,
    ph: s.ph,
  };
  if (s.box) {
    o.box = {
      x0: pyFloat(s.box.x0),
      y0: pyFloat(s.box.y0),
      x1: pyFloat(s.box.x1),
      y1: pyFloat(s.box.y1),
    };
  }
  if (s.focus_x !== undefined) o.focus_x = pyFloat(s.focus_x);
  return o;
}

async function loadSibling(name: string): Promise<Record<string, unknown> | null> {
  const spec = `./${name}.js`;
  try {
    return await import(spec) as Record<string, unknown>;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || msg.includes("Cannot find module") || msg.includes("Cannot find package")) {
      return null;
    }
    throw e;
  }
}

function writeIndexConcat(tmpdirPath: string, nLines: number): string {
  const lst = join(tmpdirPath, "concat.txt");
  const rows: string[] = [];
  for (let i = 0; i < nLines; i++) {
    const f = resolve(tmpdirPath, `line_${String(i).padStart(3, "0")}.mp3`);
    rows.push(`file '${f}'`);
  }
  writeFileSync(lst, rows.join("\n"));
  return lst;
}

/**
 * script + obs + TTS -> shots.json + narration.mp3, then clean/frame/stage.
 * options.noAudioCheck matches "--no-audio-check" in sys.argv.
 * cleaner.ts / framing.ts are loaded when present; a missing module stops the
 * run instead of shipping uncleaned or unframed panels.
 */
export async function main(
  seriesDir: string,
  ch: string,
  scriptPath: string,
  obsPath: string,
  outDir: string,
  options: MainOptions = {},
): Promise<string> {
  stage(ch, "audio");
  const localeRaw = options.locale ?? null;
  const locale = localeRaw === null ? null : validateLocale(localeRaw);
  if (localeRaw !== null && locale === null) {
    throw new SystemExit(
      `unsupported locale ${pyRepr(String(localeRaw))} (supported: ${SUPPORTED_LOCALES.join(", ")})`,
    );
  }
  // Staging id must be locale-unique: an English and a Hindi render of ch1 must
  // never share public/<id> (audio, panels and narration would clobber each other).
  const proj = locale === null
    ? `${basename(seriesDir)}_${ch}`
    : languageStagingId(basename(seriesDir), ch, locale);
  // obs/panels/bible and the promo block are SHARED, English-owned inputs. A
  // locale run reads them; it never rebuilds the shared block (no cache rewrite).
  const sharedOut = dirname(obsPath);
  const localeRoot = locale === null ? null : languageRootDir(sharedOut, locale);
  if (localeRoot !== null) {
    // Refuse a symlinked locale tree before reading or writing anything in it:
    // a link here could redirect locale writes onto the shared English cache.
    assertNoSymlinkPath(sharedOut, localeRoot);
    // The output dir must live inside the locale tree. A caller that points it at
    // the English video dir would overwrite English narration/shots.
    const relOut = relative(localeRoot, resolve(outDir));
    if (relOut === "" || relOut.startsWith("..") || isAbsolute(relOut)) {
      throw new SystemExit(
        `${locale} output dir must be inside ${localeRoot}, got ${outDir}`,
      );
    }
    assertNoSymlinkPath(localeRoot, outDir);
  }
  const block = locale === null
    ? ensurePromoBlock(seriesDir, sharedOut)
    : loadPromoBlock(sharedOut);
  if (locale !== null && block === null) {
    console.warn(
      `promo_block: no shared ${join(sharedOut, "promo_block.json")} for the ${locale} render; `
      + `continuing with explicit promo pages only (shared cache left untouched)`,
    );
  }
  const fullMeta = seriesMeta(seriesDir);
  const seriesTts = (pyGet(fullMeta, "tts", {}) ?? {}) as Record<string, unknown>;
  // Per-run override only; meta.json is never written.
  const meta = locale === null ? seriesTts : localeTtsMeta(seriesTts, options.tts, locale);
  const engineRaw = pyGet(meta, "engine", "edge");
  if (
    engineRaw !== "edge" && engineRaw !== "eleven" && engineRaw !== "external"
    && engineRaw !== "vertex" && engineRaw !== "grok"
  ) {
    throw new SystemExit(
      `meta.json has unknown tts.engine=${pyRepr(engineRaw)} (expected edge, eleven, external, vertex, or grok)`,
    );
  }
  const engine = engineRaw as "edge" | "eleven" | "external" | "vertex" | "grok";
  // English keeps the original pass-through; a locale run requires a usable voice.
  const voiceId = (locale === null
    ? meta.voice_id
    : (typeof meta.voice_id === "string" && meta.voice_id.trim() ? meta.voice_id : undefined)
  ) as string | undefined;
  const ttsSpeed = typeof meta.speed === "number" && Number.isFinite(meta.speed) ? meta.speed : 1;
  if (locale !== null && voiceId === undefined) {
    throw new SystemExit(
      `${locale} render has no tts.voice_id and the catalog default could not be applied`,
    );
  }
  const visuals = pyGet(fullMeta, "visuals", {});
  const background = String(pyGet(visuals, "background", pyGet(fullMeta, "background", "starfield")));
  const motion = String(pyGet(visuals, "motion", pyGet(fullMeta, "motion", "window")));
  // Card animation (window motion). Invalid or empty -> omitted -> renderer defaults.
  const animation = normalizeCardAnimation(pyGet(visuals, "animation", null));
  let extCfg: ExternalTtsConfig | undefined;
  if (engine === "eleven" && !voiceId) {
    throw new SystemExit("meta.json says engine=eleven but voice_id is empty - shair sets the voice");
  }
  if (engine === "external") {
    try {
      extCfg = _resolveExternalTtsConfig(meta, options.env);
    } catch (e) {
      if (e instanceof ValueError) throw new SystemExit(e.message);
      throw e;
    }
  }
  if (engine === "eleven") {
    const cand = scriptPath.replaceAll("script.md", "script_eleven.md");
    if (existsSync(cand)) {
      scriptPath = cand;
    } else if (locale === null) {
      throw new SystemExit(
        `engine=eleven but ${cand} missing - run the writer first (python run.py <series> ${ch})`,
      );
    }
    // Locale run: the localize stage writes script.md only, so fall back to it.
  } else if (engine === "external") {
    const cand = scriptPath.replaceAll("script.md", "script_voice.md");
    if (existsSync(cand)) {
      scriptPath = cand;
    } else if (locale === null) {
      throw new SystemExit(
        `engine=external but ${cand} missing - run the writer first (python run.py <series> ${ch})`,
      );
    }
    // Locale run: the localize stage writes script.md only, so fall back to it.
  }
  if (locale !== null && !existsSync(scriptPath)) {
    throw new SystemExit(
      `${locale} script missing: ${scriptPath} - run the localize stage first`,
    );
  }
  const lines = parseScript(scriptPath);
  stage(ch, "audio", "running", { total: lines.length, unit: "lines", engine });
  let opensWithHook = false;
  try {
    opensWithHook = readFileSync(scriptPath, "utf8").slice(0, 400).includes("## BEAT b00_opening");
  } catch {
    opensWithHook = false;
  }
  if (engine === "eleven" || engine === "external") {
    const joined = lines.map((x) => x[0]).join(" ");
    const tags = [...joined.matchAll(/\[[a-z ]+\]/g)].map((m) => m[0]);
    const uniq = [...new Set(tags)].sort();
    const shown = uniq.length
      ? `[${uniq.map((t) => pyReprStr(t)).join(", ")}]`
      : "NONE (valid per EMOTION LAW)";
    console.log(
      `${engine} mode: voicing ${basename(scriptPath)} - ${tags.length} emotion tags: ${shown}`,
    );
  }
  let obs = JSON.parse(readFileSync(obsPath, "utf8")) as Record<string, unknown>;
  if (isRecord(obs) && "data" in obs) obs = obs.data as Record<string, unknown>;
  const panelsDir = join(dirname(obsPath), "panels", ch);
  mkdirSync(outDir, { recursive: true });
  const mp3 = join(outDir, "narration.mp3");
  const tmpdir = join(outDir, "tts_lines_" + engine);
  const baseKey = _narrationCacheKey(lines, engine, voiceId, extCfg, ttsSpeed);
  // English keeps the golden key formula verbatim. A locale run wraps it in a
  // versioned locale fingerprint, so Hindi audio can never satisfy an English
  // narration.key (or vice versa) and a voice/provider change re-bills.
  const key = locale === null ? baseKey : localeNarrationCacheKey(baseKey, locale, meta);
  const stamp = join(outDir, "narration.key");
  const argv = options.argv ?? process.argv;
  const noAudioCheck = options.noAudioCheck ?? argv.includes("--no-audio-check");

  let spans: Array<[number, number]> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(mp3) && existsSync(stamp) && pyStripLine(readFileSync(stamp, "utf8")) === key
      && ((engine !== "external" && engine !== "vertex" && engine !== "grok") || _probeDuration(mp3) > 0)) {
      const durs = _readTtsDurs(join(outDir, "tts_durs.json"), lines.length);
      if (durs) {
        spans = [];
        let t = 0;
        for (const du of durs) {
          spans.push([t, t + du]);
          t += du;
        }
        console.log("tts: cache hit (narration.mp3 reused)");
        break;
      }
      console.log("tts: cache incomplete (tts_durs.json missing/invalid) -> regenerating");
    }
    let lst: string;
    if (engine === "eleven") {
      spans = await ttsLinesEleven(lines, tmpdir, voiceId!);
      lst = writeIndexConcat(tmpdir, lines.length);
    } else if (engine === "external") {
      spans = await ttsLinesExternal(lines, tmpdir, meta, options.env);
      lst = writeIndexConcat(tmpdir, lines.length);
    } else if (engine === "vertex") {
      spans = await ttsLinesVertex(lines, tmpdir, meta, options.env, locale);
      lst = writeIndexConcat(tmpdir, lines.length);
    } else if (engine === "grok") {
      spans = await ttsLinesGrok(lines, tmpdir, meta, options.env);
      lst = writeIndexConcat(tmpdir, lines.length);
    } else {
      // Series-selected Edge voice and speed must actually reach edge-tts.
      // English keeps the legacy +6% default; a locale version must match the
      // Studio preview's mapping (speed 1 -> +0%) so preview == final render.
      const gen = await ttsLines(lines, tmpdir, {
        voice: voiceId || VOICE,
        rate: locale === null
          ? edgeRateFromSpeed(ttsSpeed)
          : edgeRateFromSpeed(ttsSpeed, LOCALE_EDGE_RATE),
        locale,
      });
      spans = gen[0];
      lst = gen[1];
    }
    if (engine === "eleven" && !noAudioCheck) {
      let names: string[] = [];
      try {
        const b = JSON.parse(readFileSync(join(dirname(obsPath), "bible.json"), "utf8")) as {
          characters: Record<string, { name: string; aliases?: string[] }>;
        };
        names = Object.values(b.characters).map((c) => c.name);
        for (const c of Object.values(b.characters)) names.push(...(c.aliases ?? []));
      } catch {
        names = [];
      }
      const bad = sweep(lines, tmpdir, names, engine, outDir);
      const ids = Object.keys(bad).map(Number).sort((a, b) => a - b);
      if (ids.length) {
        const shown = ids.slice(0, 6).map((i) => {
          const bits = bad[i]!.slice(0, 3).map((d) => d.want + ">" + d.got.slice(0, 12));
          return `#${i}(${bits.join("|")})`;
        });
        console.log(`  audio_check: ${ids.length} line(s) drifted: ${shown.join(", ")}`);
        if (attempt === 0) {
          for (let i = 0; i < lines.length; i++) {
            if (bad[i] === undefined) continue;
            const [lf, sd] = _lineFile(tmpdir, i, lines[i]![0]);
            for (const junk of [lf, sd]) if (existsSync(junk)) unlinkSyncSafe(junk);
          }
          for (const junk of [mp3, stamp, join(outDir, "tts_durs.json")]) {
            if (existsSync(junk)) unlinkSyncSafe(junk);
          }
          console.log("  audio_check: re-rolling drifted takes (once)...");
          continue;
        }
        console.error(
          `  !! audio_check: ${ids.length} line(s) STILL drifted after re-roll - `
          + `keeping takes, FLAGGED for human listen: [${ids.join(", ")}]`,
        );
      }
    }
    ttsConcat(lst, mp3);
    if ((engine === "external" || engine === "vertex" || engine === "grok") && _probeDuration(mp3) <= 0) {
      if (existsSync(mp3)) unlinkSyncSafe(mp3);
      throw new RuntimeError(`${engine} tts concat produced invalid narration.mp3 (ffprobe duration<=0)`);
    }
    writeFileSync(stamp, key);
    writeFileSync(
      join(outDir, "tts_durs.json"),
      pyJsonDumps(spans.map(([a, b]) => pyFloat(b - a)), {}),
    );
    break;
  }
  stage(ch, "audio", "done", { completed: lines.length, total: lines.length });
  stage(ch, "timeline");
  const shots = buildShots(
    lines,
    spans,
    obs as { panels: Array<Record<string, unknown>> },
    panelsDir,
    block,
    opensWithHook,
  );
  if (shots.length === 0) throw new Error("max() arg is an empty sequence");
  // A dropped panel assignment silently changes the creative intent. Detect it
  // (missing artwork, a line whose every tag resolved to nothing) and surface it.
  const droppedPanels = droppedPanelAssignments(lines, shots);
  if (locale !== null && droppedPanels.length) {
    // A localized cut must not silently lose a cited panel: warn, record it in
    // the chapter's timeline stage, and leave a machine-readable sidecar next to
    // the locale output (never in the shared English tree).
    const detail = droppedPanels.slice(0, 8).map((d) => `${d.line}:${d.panel}`).join(", ");
    console.warn(
      `panel intent (${locale}): ${droppedPanels.length} explicit assignment(s) produced no shot: `
      + detail + (droppedPanels.length > 8 ? ", ..." : ""),
    );
    stage(ch, "timeline", "running", {
      droppedPanels: droppedPanels.length,
      droppedPanelIds: droppedPanels.slice(0, 20).map((d) => d.panel),
    });
    writeFileSync(
      join(outDir, "locale_warnings.json"),
      pyJsonPretty({
        locale,
        warnings: droppedPanels.map((d) => `dropped panel ${d.panel} on line ${d.line}`),
      }),
    );
  } else if (locale !== null) {
    // A clean rerun must not leave a stale warning sidecar behind.
    const stale = join(outDir, "locale_warnings.json");
    if (existsSync(stale)) unlinkSyncSafe(stale);
  }
  const dReal = _probeDuration(mp3);
  const totalSpans = Math.max(...shots.map((s) => s.end_s));
  if (dReal > totalSpans + 0.05) {
    console.log(
      `i-11 fix: narration ${pyRoundFixed(dReal, 2)}s > shots ${pyRoundFixed(totalSpans, 2)}s -> `
      + `extending last shot (mp3 concat drift)`,
    );
    shots[shots.length - 1]!.end_s = dReal + 0.15;
  }
  // Locale runs write their cleaner/crop artifacts under the locale tree and
  // reuse valid SHARED artifacts read-only (copy, never move or rewrite). The
  // English cache stays byte-identical.
  const cleanedDir = localeRoot === null
    ? join(sharedOut, "cleaned", ch)
    : join(localeRoot, "cleaned", ch);
  const cropsDir = localeRoot === null
    ? join(sharedOut, "render_crops", ch)
    : join(localeRoot, "render_crops", ch);
  const byId: Record<string, Record<string, unknown>> = {};
  for (const p of (obs as { panels: Array<Record<string, unknown>> }).panels) byId[String(p.id)] = p;
  const cleaner = await loadSibling("cleaner");
  const shouldClean = cleaner
    ? (cleaner.shouldClean ?? cleaner.should_clean) as
      ((pg: Record<string, unknown>, block: Block | null) => boolean) | undefined
    : undefined;
  const cleanBatch = cleaner
    ? (cleaner.cleanBatch ?? cleaner.clean_batch) as
      ((items: unknown[], panelsDir: string, cleanedDir: string) => Record<string, string | null>) | undefined
    : undefined;
  const items: Record<string, Record<string, unknown>> = {};
  if (!shouldClean) {
    throw new RuntimeError("cleaner.ts is not ported yet (need shouldClean); refusing to render unverified panels");
  }
  if (localeRoot !== null) {
    // Reuse paid SHARED artifacts read-only, then write any missing one under
    // the locale tree. The English caches are never touched.
    const seeded = seedLocaleArtifacts(
      join(sharedOut, "cleaned", ch),
      cleanedDir,
      join(sharedOut, "render_crops", ch),
      cropsDir,
    );
    if (seeded) console.log(`locale ${locale}: reused ${seeded} shared cleaned/crop artifact(s)`);
  }
  for (const s of shots) {
    const pid = s.panel.slice(0, -4);
    const pg = byId[pid];
    if (!pg || pid in items) continue;
    const explicitFull = _explicitFullPromo(pg);
    const isPromo = Boolean(explicitFull || (block && (block.panelPromo(pg) || block.panelFullPromo(pg))));
    if (!(shouldClean(pg, block) || isPromo)) continue;
    const overlay = (pg.overlay as unknown[]) ?? [];
    const worldRaw = (pg.world as unknown[]) ?? [];
    items[pid] = {
      id: pid,
      overlay_chars: Array.from(overlay.map((t) => String(t)).join(" ")).length,
      world: worldRaw.filter((w) => !(block && block.matches(w))),
      overlay,
      promo: block ? block.panelPromoStrings(pg) : [],
      promo_page: Object.prototype.hasOwnProperty.call(pg, "promo_page") ? pg.promo_page : null,
      promo_regions: pg.promo_regions || [],
      promo_rules: block ? block.data : null,
      promo_item: isPromo,
      promo_full: explicitFull,
    };
  }
  if (Object.keys(items).length) {
    if (!cleanBatch) {
      throw new RuntimeError("cleaner.ts is not ported yet (need cleanBatch); refusing to render unverified panels");
    }
    stage(ch, "timeline", "done", { shots: shots.length });
    stage(ch, "clean", "running", { total: Object.keys(items).length, unit: "panels" });
    let res: Record<string, string | null>;
    try {
      res = await cleanBatch(Object.values(items), panelsDir, cleanedDir);
    } catch (e) {
      // Ordinary panels ship uncleaned; promo items get the cover fallback below.
      console.error(`bubble-cleaner: failed (${e instanceof Error ? e.message : String(e)}); using originals`);
      res = {};
      for (const pid of Object.keys(items)) res[pid] = null;
    }
    // Promo panels never stop the run: a failed mask (or a FULL advert page) is
    // replaced by an obscured cover of the reader's promo regions / whole panel.
    const coverPromo = cleaner
      ? (cleaner.coverPromoPanel ?? cleaner.cover_promo_panel) as
        ((it: unknown, panelsDir: string, cleanedDir: string) => Promise<string | null>) | undefined
      : undefined;
    for (const [pid, it] of Object.entries(items)) {
      if (!(it.promo_item || it.promo_full)) continue;
      if (res[pid] && !it.promo_full) continue;
      if (!coverPromo) continue;
      try {
        const covered = await coverPromo(it, panelsDir, cleanedDir);
        if (covered) {
          res[pid] = covered;
          console.error(`promo-cover: ${pid} covered (promo clean unavailable or full advert page)`);
        }
      } catch (e) {
        console.error(`promo-cover: ${pid} failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const nClean = _applyCleaned(shots as unknown as Array<Record<string, unknown>>, items, res);
    if (nClean) console.log(`bubble-cleaner: ${nClean} shots cleaned`);
    stage(ch, "clean", "done", { completed: Object.keys(items).length, cleaned: nClean });
  } else {
    stage(ch, "clean", "skipped", { note: "No panels require cleaning" });
  }
  const framingMod = await loadSibling("framing");
  const frameShots = framingMod
    ? (framingMod.frameShots ?? framingMod.frame_shots) as
      ((shots: TimelineShot[], obs: unknown, panelsDir: string, cropsDir: string) => unknown) | undefined
    : undefined;
  if (!frameShots) {
    throw new RuntimeError("framing.ts is not ported yet (need frameShots); refusing to stage unframed panels");
  }
  stage(ch, "timeline", "running", { note: "Framing and staging artwork" });
  const framing = await frameShots(
    shots,
    obs,
    panelsDir,
    cropsDir,
  );
  console.log(`visual framing: ${pyRepr(framing)}`);
  const pub = join(STUDIO_PUBLIC, proj);
  if (localeRoot !== null) {
    // A symlinked staging dir could silently overwrite the English render assets.
    assertNoSymlinkPath(STUDIO_PUBLIC, pub);
  }
  mkdirSync(pub, { recursive: true });
  for (const s of shots) {
    const src = s._src ?? join(panelsDir, s.panel);
    delete s._src;
    copyFileSync(src, join(pub, s.panel));
    s.panel = `${proj}/${s.panel}`;
  }
  copyFileSync(mp3, join(pub, "narration.mp3"));
  const quality = resolveRenderQuality();
  // Music bed: disabled unless the series opts in (meta.music) or MUSIC_BED=on.
  const music = await resolveMusicBed(fullMeta, seriesDir);
  let musicProp: { src: string; volume: number } | null = null;
  if (music.bed) {
    const name = `music${extname(music.bed.file) || ".mp3"}`;
    copyFileSync(music.bed.file, join(pub, name));
    musicProp = { src: `${proj}/${name}`, volume: music.bed.volume };
    console.log(`music bed: ${basename(music.bed.file)} at volume ${music.bed.volume}`);
  } else if (music.reason !== "music disabled") {
    console.log(`music bed: off (${music.reason})`);
  }
  const props = {
    shots: shots.map(dumpShot),
    audio: `${proj}/narration.mp3`,
    volume: 1,
    background,
    motion,
    ...(animation ? { animation } : {}),
    quality,
    ...(musicProp ? { music: musicProp } : {}),
  };
  const propsPath = join(outDir, "shots.json");
  writeFileSync(propsPath, pyJsonPretty(props));
  const total = Math.max(...shots.map((s) => s.end_s));
  console.log(`lines=${lines.length} shots=${shots.length} duration=${pyRoundFixed(total, 1)}s`);
  stage(ch, "timeline", "done", { shots: shots.length, duration: total });
  console.log(`props: ${propsPath}`);
  const studio = process.env.MANHWA_STUDIO ?? DEFAULT_STUDIO;
  console.log(
    `render: cd ${studio} && npx remotion render src/index.ts Recap `
    + `${join(outDir, "video.mp4")} --props=${propsPath} --log=error`,
  );
  return propsPath;
}

/**
 * Copy the SHARED English cleaner/crop artifacts into the locale tree so a
 * localization reuses paid work READ-ONLY. Never moves, never rewrites, never
 * deletes a shared file: the English cache stays byte-identical.
 *
 * Only files that already exist in the shared cache are seeded, and only when
 * the locale has no copy yet (a locale-specific re-clean always wins).
 */
export function seedLocaleArtifacts(
  sharedCleanedDir: string,
  localeCleanedDir: string,
  sharedCropsDir: string,
  localeCropsDir: string,
): number {
  let copied = 0;
  const seedDir = (srcDir: string, dstDir: string, accept: (name: string) => boolean): void => {
    let names: string[];
    try {
      names = readdirSyncSafe(srcDir);
    } catch {
      return;
    }
    mkdirSync(dstDir, { recursive: true });
    for (const name of names) {
      if (!accept(name)) continue;
      const src = join(srcDir, name);
      const dst = join(dstDir, name);
      if (existsSync(dst)) continue;
      try {
        copyFileSync(src, dst);
        copied += 1;
      } catch {
        // A failed seed only costs a recompute; never fail the render for it.
      }
    }
  };
  // Cleaner: png + its .done/.rej stamp + the promo sidecar. Hashes are content
  // based (source panel + config), so a copied stamp is exactly as valid here.
  seedDir(
    sharedCleanedDir,
    localeCleanedDir,
    (n) => n.endsWith(".png") || n.endsWith(".png.done") || n.endsWith(".png.rej")
      || n.endsWith(".promo_boxes.json"),
  );
  // Framing: crop files are content-addressed (<pid>-<digest>.png).
  seedDir(sharedCropsDir, localeCropsDir, (n) => n.endsWith(".png"));
  return copied;
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

function unlinkSyncSafe(p: string): void {
  unlinkSync(p);
}

/** Read a cached tts_durs.json; null when missing, corrupt, or not n finite non-negative numbers. */
function _readTtsDurs(p: string, n: number): number[] | null {
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length !== n) return null;
    const out: number[] = [];
    for (const v of raw) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      out.push(v);
    }
    return out;
  } catch {
    return null;
  }
}

export const MIN_PANEL_S_PY = MIN_PANEL_S;
export {
  parseScript as parse_script,
  pickPanels as pick_panels,
  _explicitFullPromo as _explicit_full_promo,
  _nearestUnseen as _nearest_unseen,
  _borrowRun as _borrow_run,
  _artMap as _art_map,
  buildShots as build_shots,
  seriesMeta as series_meta,
  _applyCleaned as _apply_cleaned,
};
