/**
 * cleaner.ts - optional bubble-text removal for SHOTS the viewer will see.
 *
 * TypeScript port of manhwa-pipeline/pipeline/cleaner.py.
 *
 * Tool: PanelCleaner (VoxelCubes/PanelCleaner) at MANHWA_PCLEANER_DIR (default
 * /opt/panelcleaner), python MANHWA_PCLEANER_PY (default <dir>/venv/bin/python),
 * profile panelcleaner_profile.ini (CTD detector + Tesseract eng + LaMa inpainting).
 * Promo OCR uses the same detector through tools/promo_ocr_export.py.
 *
 * Failure policy (long series runs): one batch = one CLI call, retried once;
 * if it still fails, ordinary panels ship uncleaned (no .rej, retried next run).
 * Repeated failed batches open a circuit breaker that skips cleaning for a
 * cooldown. Promo panels still fail closed in timeline.
 *
 * Rules (approved design):
 * - clean ONLY: overlay text >= 40 chars AND no world text AND art >= 0.5
 *   (world-text/system-window shots are protected - the text IS the shot)
 * - a blocked promo/credit string bypasses BOTH floors and the world-text veto,
 *   and is cleaned by the LOCAL hard-blur branch (cleanPromoMask), never the
 *   all-text inpaint tool
 * - reader/writer always see ORIGINALS; cleaning is render-side only
 * - cache: out/cleaned/<ch>/<panel>.png + stamp; failure -> null (use original)
 *
 * Hooks: pipeline internals call `_hooks.*` for
 * `_runOcrExport`, `_verifyPromoMask`, `_visionFullVsStory`, `_runPanelCleaner`,
 * `residualOverlay`, `promoGone`, and `_runAdapter`. Replace those properties
 * to mock a stage. The exported functions are the real implementations.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  PROMO_ALGO_VERSION,
  PROMO_ROI_PAD_FRAC,
  cfgHash,
  promoCacheHash,
  promoRulesHash,
  pyJsonDumps,
  pySorted,
} from "../contracts/hashes.js";
import { Block, type BlockData } from "../intake/promoBlock.js";
import { call, imgB64, parseJson } from "../llm/client.js";
import {
  PromoMaskError,
  blurPromoRegionsFile,
  type Box,
  type RegionRecord,
  type RgbImage,
} from "./promoMask.js";
import * as lappy from "../workers/lappy.js";

export { PROMO_ALGO_VERSION, PROMO_ROI_PAD_FRAC };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Install root holds `venv/bin/python`, `config/pcleaner/pcleanerrc` and the
 * verified detector + LaMa weights under `cache/model`.
 */
export const PCLEANER_PROFILE = path.join(HERE, "panelcleaner_profile.ini");
export const PCLEANER_DETECTOR = "comictextdetector.pt.onnx";
/** PanelCleaner attempts per batch before shipping originals. */
export const PCLEANER_ATTEMPTS = 2;
/**
 * sha1 of the retired MIT cleaner_config.json. Verified outputs stamped by the
 * old cleaner stay valid, so a switch does not re-clean finished chapters.
 */
const LEGACY_MIT_CONFIG_SHA1 = "ded371ca22ab991d1fe3afc4b9dce8ef7b992e7f";
export const OVERLAY_MIN = 40;
export const ART_MIN = 0.5;
/** Empirical: cleaned px fraction per overlay char (ctd+lama). */
export const PIX_PER_CHAR = 1.1e-4;
export const PROMO_OCR_NAME = "promo_ocr.txt";
export const PROMO_BOXES_SUFFIX = ".promo_boxes.json";
/**
 * v2 adapter lives at repo `tools/promo_ocr_export.py` (ROADMAP: cleaner.ts +
 * that file). Python resolved it next to cleaner.py; this layout does not.
 */
export const PROMO_ADAPTER = path.resolve(HERE, "../../tools/promo_ocr_export.py");
export const PROMO_ADAPTER_TIMEOUT = 900;
/** Boxes-only CTD export used by framing to keep speech bubbles out of the shot. */
export const BUBBLE_ADAPTER = path.resolve(HERE, "../../tools/bubble_boxes_export.py");
/** Fixed start-up allowance plus a per-image budget (CPU, tiled tall strips). */
export const BUBBLE_ADAPTER_BASE_TIMEOUT = 90;
export const BUBBLE_ADAPTER_PER_IMAGE_TIMEOUT = 45;
// PROMO_ROI_PAD_FRAC re-exported from hashes.ts (0.5).

export interface PromoBlockLike {
  matches(s: unknown): boolean;
}

export interface PanelObs {
  overlay?: readonly string[] | null;
  world?: readonly string[] | null;
  art?: number;
}

export interface CleanItem extends PanelObs {
  id: string;
  overlay_chars?: number;
  promo?: readonly string[] | null;
  promo_rules?: Record<string, unknown> | null;
  promo_regions?: unknown;
  promo_page?: boolean | null;
  promo_item?: unknown;
  promo_full?: unknown;
}

export type Matcher = (s: unknown) => boolean;

export interface CleanerHooks {
  _runOcrExport: typeof _runOcrExport;
  _verifyPromoMask: typeof _verifyPromoMask;
  _visionFullVsStory: typeof _visionFullVsStory;
  _runPanelCleaner: typeof _runPanelCleaner;
  residualOverlay: typeof residualOverlay;
  promoGone: typeof promoGone;
  /** Not in the required six, but `_runOcrExport` calls it so scale-back is testable. */
  _runAdapter: typeof _runAdapter;
  /** CTD boxes-only export for framing; replace to mock the detector. */
  _runBubbleAdapter: typeof _runBubbleAdapter;
}

// Assigned after the implementations. Call sites use this object, so a test
// can replace a property and every internal caller sees the replacement.
export const _hooks = {} as CleanerHooks;

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

function elog(msg: string): void {
  process.stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python 3 str.strip() over the Unicode whitespace set (not JS trim). */
const PY_WS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
for (let c = 0x2000; c <= 0x200a; c++) PY_WS.add(c);

function pyStrip(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && PY_WS.has(s.charCodeAt(i)!)) i++;
  while (j > i && PY_WS.has(s.charCodeAt(j - 1)!)) j--;
  return s.slice(i, j);
}

/** Python 3.7+ re.escape: only regex metacharacters, not every punctuation mark. */
const RE_SPECIAL = new Set("()[]{}?*+-|^$\\.&~# \t\n\r\v\f");
function reEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    out += RE_SPECIAL.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t === "string") out.push(t);
  }
  return out;
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "Error";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readStamp(p: string): string | null {
  try {
    return pyStrip(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function removeStale(...paths: (string | null | undefined)[]): void {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }
}

function sourceSha1(srcPath: string): string | null {
  try {
    return createHash("sha1").update(fs.readFileSync(srcPath)).digest("hex");
  } catch {
    return null;
  }
}

function pcleanerDir(): string {
  return process.env.MANHWA_PCLEANER_DIR || "/opt/panelcleaner";
}

function pcleanerPy(): string {
  return process.env.MANHWA_PCLEANER_PY || path.join(pcleanerDir(), "venv", "bin", "python");
}

function pcleanerModel(): string {
  return path.join(pcleanerDir(), "cache", "model", PCLEANER_DETECTOR);
}

export function pcleanerInstalled(): boolean {
  return (
    fs.existsSync(pcleanerPy()) &&
    fs.existsSync(path.join(pcleanerDir(), "config", "pcleaner", "pcleanerrc")) &&
    fs.existsSync(pcleanerModel()) &&
    fs.existsSync(PCLEANER_PROFILE)
  );
}

function pcleanerEnv(cacheRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    XDG_CONFIG_HOME: path.join(pcleanerDir(), "config"),
    // Log/lock files and mask cache per run, so parallel lanes never collide.
    XDG_CACHE_HOME: path.join(cacheRoot, "cache"),
    GUARDED_CLEANER_CACHE: path.join(cacheRoot, "masks"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES ?? "",
    OMP_NUM_THREADS: "4",
    MKL_NUM_THREADS: "4",
    OPENBLAS_NUM_THREADS: "4",
  };
}

/**
 * Circuit breaker for long-running series sessions: after N consecutive batches
 * where the cleaner failed, stop spawning it for a cooldown and ship
 * ordinary panels uncleaned. Promo panels still fail closed in timeline.
 */
export const _breaker = {
  fails: 0,
  openUntil: 0,
  reset(): void {
    this.fails = 0;
    this.openUntil = 0;
  },
};

function breakerLimit(): number {
  const n = Number(process.env.MANHWA_CLEANER_MAX_FAILS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

function breakerCooldownMs(): number {
  const s = Number(process.env.MANHWA_CLEANER_COOLDOWN_S);
  return (Number.isFinite(s) && s >= 0 ? s : 1800) * 1000;
}

export function cleanerCircuitOpen(now = Date.now()): boolean {
  if (_breaker.openUntil && now < _breaker.openUntil) return true;
  if (_breaker.openUntil && now >= _breaker.openUntil) {
    // Half-open: allow the next batch to probe; one more failure re-opens.
    _breaker.openUntil = 0;
    _breaker.fails = Math.max(0, breakerLimit() - 1);
  }
  return false;
}

function recordBatchOutcome(ok: boolean): void {
  if (ok) {
    _breaker.fails = 0;
    _breaker.openUntil = 0;
    return;
  }
  _breaker.fails += 1;
  if (_breaker.fails >= breakerLimit()) {
    _breaker.openUntil = Date.now() + breakerCooldownMs();
    elog(
      `  cleaner: ${_breaker.fails} consecutive batch failures; circuit open for ` +
        `${Math.round(breakerCooldownMs() / 1000)}s, shipping uncleaned panels`,
    );
  }
}

async function loadRgb(file: string): Promise<RgbImage> {
  const decoded = await sharp(file)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) {
    throw new Error(`expected 3 channels, got ${decoded.info.channels}`);
  }
  const data = new Uint8Array(decoded.data.byteLength);
  data.set(decoded.data);
  return { data, width: decoded.info.width, height: decoded.info.height };
}

async function imageSize(file: string): Promise<[number, number]> {
  const m = await sharp(file).metadata();
  return [m.width ?? 0, m.height ?? 0];
}

function rawSharp(img: RgbImage): sharp.Sharp {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 3 },
  });
}

async function saveJpeg(img: RgbImage, dest: string, quality = 92): Promise<void> {
  await rawSharp(img).jpeg({ quality }).toFile(dest);
}

async function savePng(img: RgbImage, dest: string): Promise<void> {
  await rawSharp(img).png().toFile(dest);
}

function copyRgb(img: RgbImage): RgbImage {
  return { data: new Uint8Array(img.data), width: img.width, height: img.height };
}

async function resizeRgb(img: RgbImage, w: number, h: number): Promise<RgbImage> {
  const decoded = await rawSharp(img)
    .resize(w, h, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = new Uint8Array(decoded.data.byteLength);
  data.set(decoded.data);
  return { data, width: decoded.info.width, height: decoded.info.height };
}

/** PIL crop box is exclusive on the right and bottom. */
function cropRgb(img: RgbImage, x0: number, y0: number, x1: number, y1: number): RgbImage {
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 3;
    data.set(img.data.subarray(src, src + w * 3), y * w * 3);
  }
  return { data, width: w, height: h };
}

function pyStem(file: string): string {
  const base = path.posix.basename(file.replaceAll("\\", "/"));
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// --------------------------------------------------------------------------- //
// gates
// --------------------------------------------------------------------------- //

export function hasWorldText(
  worldStrings: readonly unknown[] | null | undefined,
  block?: PromoBlockLike | null,
): boolean {
  for (const w of worldStrings || []) {
    if (typeof w !== "string") continue;
    if (pyStrip(w) && !(block && block.matches(w))) return true;
  }
  return false;
}

export function shouldClean(panelObs: PanelObs, block?: PromoBlockLike | null): boolean {
  const overlay = asStrings(panelObs.overlay);
  const worlds = asStrings(panelObs.world);
  const ov = overlay.join(" ");
  // I-19/B2a: a blocked promo/credit string bypasses BOTH floors AND the
  // non-promo world-text veto. Such a panel is cleaned by the LOCAL hard-blur
  // branch, which never sends the panel through the all-text inpaint tool.
  if (block != null && (overlay.some((t) => block.matches(t)) || worlds.some((t) => block.matches(t)))) {
    return true;
  }
  // I-55: any world string that is NOT promo-blocked makes this panel uncleanable.
  if (hasWorldText(worlds, block)) return false;
  const art = panelObs.art === undefined ? 1.0 : panelObs.art;
  return ov.length >= OVERLAY_MIN && art >= ART_MIN;
}

export function unionFilter(worldSets: readonly (readonly unknown[])[]): string | null {
  const worlds = new Set<string>();
  for (const ws of worldSets) {
    if (!Array.isArray(ws)) continue;
    for (const w of ws) {
      if (typeof w !== "string") continue;
      const s = pyStrip(w);
      if (s) worlds.add(s);
    }
  }
  if (worlds.size === 0) return null;
  const alts = pySorted(worlds).map((w) => reEscape(w) + "\\s*").join("|");
  return `^(${alts})$`;
}

export async function residualOverlay(
  pngPath: string,
  overlayStrings: readonly string[],
): Promise<number> {
  const joined = overlayStrings.filter((t) => t && t.length > 3);
  if (joined.length === 0) return 0.0;
  const q =
    "Transcribe ONLY speech bubble / narration box text still visible in this " +
    "comic panel (ignore signs/screens/art text). Output a JSON array of strings " +
    "as printed, or [] if none.";
  const b64 = await imgB64(pngPath, 1000, 75);
  const content = [
    { type: "text", text: q },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ];
  let found: unknown;
  try {
    const r = await call([{ role: "user", content }], {
      max_tokens: 800,
      temperature: 0.0,
      tag: "clean-verify",
      lane: "vision",
    });
    const text = r.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("malformed completion");
    found = parseJson(text.trim());
  } catch (e) {
    // I-25: a dead verifier must not read as "clean".
    const err = new Error(
      `residual_overlay verifier unavailable: ${errName(e)}: ${errMsg(e)}`,
    );
    err.name = "RuntimeError";
    throw err;
  }
  const foundList = Array.isArray(found) ? found : [];
  let resid = 0.0;
  const totalChars = joined.reduce((n, s) => n + normWs(s).length, 0);
  for (const f of foundList) {
    if (typeof f !== "string") continue;
    const fn = normWs(f);
    if (fn.length < 4) continue;
    if (joined.some((s) => fn.includes(normWs(s)) || normWs(s).includes(fn))) {
      resid += fn.length;
    }
  }
  return Math.min(1.0, resid / Math.max(1, totalChars));
}

export function normWs(s: string): string {
  // Python str.replace replaces every non-overlapping pair once, not in a loop.
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replaceAll("  ", " ").trim();
}

export async function promoGone(
  pngPath: string,
  promoStrings: readonly string[],
): Promise<boolean> {
  const joined = promoStrings.filter((t) => t && t.length > 2);
  if (joined.length === 0) return false;
  const q =
    "Look at this comic panel. Which of these EXACT strings are still " +
    "visible ANYWHERE in the image - corner banners, watermarks, URLs, " +
    "credit blocks? Output a JSON array of the strings still visible " +
    "(copied from the list), or [] if none of them appear:\n" +
    pyJsonDumps(joined, { ensureAscii: false });
  const b64 = await imgB64(pngPath, 1600, 75);
  const content = [
    { type: "text", text: q },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ];
  let found: unknown;
  try {
    const r = await call([{ role: "user", content }], {
      max_tokens: 300,
      temperature: 0.0,
      tag: "promo-verify",
      lane: "vision",
    });
    const text = r.choices?.[0]?.message?.content;
    if (typeof text !== "string") return false;
    found = parseJson(text.trim());
  } catch {
    return false;
  }
  // Only a proper JSON list[str] is a usable verdict. Anything else is
  // malformed, not an all-clear: a promo panel never ships on a garbled answer.
  if (!Array.isArray(found)) return false;
  if (!found.every((f) => typeof f === "string")) return false;
  if (found.length === 0) return true;
  for (const f of found) {
    const fn = normWs(f as string);
    if (!fn) continue;
    for (const s of joined) {
      const sn = normWs(s);
      if (sn && (fn.includes(sn) || sn.includes(fn))) return false;
    }
  }
  return true;
}

export async function _visionFullVsStory(srcPath: string): Promise<boolean | null> {
  const q =
    'Classify this comic page. Answer ONLY with JSON {"full_page_ad": true} ' +
    "if the page is essentially a full-page advert / promo / credits page " +
    "with little or no story art, or {\"full_page_ad\": false} if it is story " +
    "art that merely carries a small corner banner, watermark, or URL.";
  const b64 = await imgB64(srcPath, 1200, 75);
  const content = [
    { type: "text", text: q },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ];
  let v: unknown;
  try {
    const r = await call([{ role: "user", content }], {
      max_tokens: 64,
      temperature: 0.0,
      tag: "promo-page-gate",
      lane: "vision",
    });
    const text = r.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    v = parseJson(text.trim());
  } catch {
    return null;
  }
  if (typeof v === "boolean") return v;
  if (isMapping(v)) {
    for (const k of ["full_page_ad", "full_page", "full_advert", "promo_page"]) {
      if (k in v) return typeof v[k] === "boolean" ? (v[k] as boolean) : null;
    }
  }
  return null;
}

export async function promoPageBoundary(
  it: { promo_page?: unknown },
  srcPath: string,
): Promise<[boolean, string, boolean]> {
  const pp = it.promo_page;
  if (pp === true) return [false, "reader classified FULL promo page", false];
  if (pp === false) return [true, "reader classified partial/corner promo", true];
  if (!fs.existsSync(srcPath)) {
    return [false, "unknown promo_page and no original to classify", false];
  }
  const verdict = await _hooks._visionFullVsStory(srcPath);
  if (verdict === null) {
    return [false, "unknown promo_page; vision gate unavailable/malformed", false];
  }
  if (verdict) return [false, "vision gate classified FULL advert page", false];
  return [true, "vision gate classified story page w/ corner promo", true];
}

function boxesNorm(boxes: readonly Box[], W: number, H: number): number[][] {
  const out: number[][] = [];
  for (const [x1, y1, x2, y2] of boxes) {
    out.push([
      pyRound((x1 * 1000.0) / W),
      pyRound((y1 * 1000.0) / H),
      pyRound((x2 * 1000.0) / W),
      pyRound((y2 * 1000.0) / H),
    ]);
  }
  return out;
}

export async function writePromoSidecar(
  outPath: string,
  srcPath: string,
  pid: string,
  boxes: readonly Box[],
  partial: boolean,
  h: string,
): Promise<string> {
  const [W, H] = await imageSize(srcPath);
  const data = {
    version: PROMO_ALGO_VERSION,
    panel: pid,
    source_sha1: sourceSha1(srcPath),
    width: W,
    height: H,
    partial: Boolean(partial),
    cache_hash: h,
    boxes_px: boxes.map(([a, b, c, d]) => [Math.trunc(a), Math.trunc(b), Math.trunc(c), Math.trunc(d)]),
    boxes_norm: boxesNorm(boxes as Box[], W, H),
  };
  const side = outPath + PROMO_BOXES_SUFFIX;
  const tmp = side + ".tmp";
  fs.writeFileSync(tmp, pyJsonDumps(data, { sortKeys: true }));
  fs.renameSync(tmp, side);
  return side;
}

export function validatePromoSidecar(outPath: string, srcPath: string, h: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(outPath + PROMO_BOXES_SUFFIX, "utf8"));
  } catch {
    return false;
  }
  if (!isMapping(data)) return false;
  if (data.version !== PROMO_ALGO_VERSION) return false;
  if (data.cache_hash !== h) return false;
  const sha = sourceSha1(srcPath);
  if (!data.source_sha1 || data.source_sha1 !== sha) return false;
  const W = data.width;
  const H = data.height;
  if (!(typeof W === "number" && typeof H === "number" && Number.isInteger(W) && Number.isInteger(H) && W > 0 && H > 0)) {
    return false;
  }
  const boxes = data.boxes_px;
  if (!Array.isArray(boxes) || boxes.length === 0) return false;
  for (const b of boxes) {
    if (!Array.isArray(b) || b.length !== 4) return false;
    if (!b.every((v) => typeof v === "number" && Number.isInteger(v))) return false;
  }
  return true;
}

export function _changedFrac(a: RgbImage, b: RgbImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("image size mismatch");
  }
  const n = a.width * a.height;
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const mean =
      (Math.abs(a.data[o]! - b.data[o]!) +
        Math.abs(a.data[o + 1]! - b.data[o + 1]!) +
        Math.abs(a.data[o + 2]! - b.data[o + 2]!)) /
      3;
    if (mean > 25) changed++;
  }
  return changed / n;
}

// --------------------------------------------------------------------------- //
// promo matcher / hash / ROI
// --------------------------------------------------------------------------- //

export function _wholeStringMatcher(known: readonly unknown[] | null | undefined): Matcher {
  const keys = new Set<string>();
  for (const t of known || []) {
    if (!t) continue;
    const k = String(t).trim().toLowerCase().replace(/\s+/g, " ");
    if (k) keys.add(k);
  }
  return (s: unknown) => {
    if (!s) return false;
    return keys.has(String(s).trim().toLowerCase().replace(/\s+/g, " "));
  };
}

export function _promoMatcher(it: CleanItem): Matcher | null {
  const rules = it.promo_rules;
  if (isMapping(rules)) {
    try {
      const block = new Block({ ...rules } as BlockData);
      return (s) => block.matches(s);
    } catch (e) {
      elog(`  cleaner: ${it.id} promo_rules unusable (${errMsg(e)}); keeping original`);
      return null;
    }
  }
  const promo = asStrings(it.promo);
  if (promo.length) return _wholeStringMatcher(promo);
  return null;
}

export function _promoRulesHash(it: Record<string, unknown>): string {
  return promoRulesHash(it);
}

export function _promoCacheHash(it: Record<string, unknown>, srcPath: string): string {
  return promoCacheHash(it, srcPath, { configPath: PCLEANER_PROFILE, adapterPath: PROMO_ADAPTER });
}

function protectedStrings(it: CleanItem, matcher: Matcher): string[] {
  const out: string[] = [];
  for (const t of [...asStrings(it.overlay), ...asStrings(it.world)]) {
    if (t && !matcher(t)) out.push(t);
  }
  return out;
}

export function _roiPixelBoxes(
  it: { promo_regions?: unknown },
  W: number,
  H: number,
  scale = 1,
): Box[] {
  const out: Box[] = [];
  const regions = Array.isArray(it.promo_regions) ? it.promo_regions : [];
  for (const reg of regions) {
    if (!isMapping(reg)) continue;
    const bb = reg.bbox;
    if (!isMapping(bb)) continue;
    const x0 = Number(bb.x0);
    const y0 = Number(bb.y0);
    const x1 = Number(bb.x1);
    const y1 = Number(bb.y1);
    if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) continue;
    if (x1 <= x0 || y1 <= y0) continue;
    const px0 = (x0 / 1000.0) * W * scale;
    const py0 = (y0 / 1000.0) * H * scale;
    const px1 = (x1 / 1000.0) * W * scale;
    const py1 = (y1 / 1000.0) * H * scale;
    const padx = PROMO_ROI_PAD_FRAC * (px1 - px0);
    const pady = PROMO_ROI_PAD_FRAC * (py1 - py0);
    const bx0 = Math.max(0, Math.trunc(px0 - padx));
    const by0 = Math.max(0, Math.trunc(py0 - pady));
    const bx1 = Math.min(W * scale, Math.trunc(px1 + padx));
    const by1 = Math.min(H * scale, Math.trunc(py1 + pady));
    if (bx1 > bx0 && by1 > by0) out.push([bx0, by0, bx1, by1]);
  }
  return out;
}

export function _validRecords(raw: unknown): RegionRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RegionRecord[] = [];
  for (const r of raw) {
    if (!isMapping(r)) continue;
    const text = typeof r.text === "string" ? r.text : "";
    const polys: number[][] = [];
    const lines = r.lines;
    if (Array.isArray(lines)) {
      for (const poly of lines) {
        if (!Array.isArray(poly) || poly.length !== 8) continue;
        const nums: number[] = [];
        let ok = true;
        for (const v of poly) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            ok = false;
            break;
          }
          nums.push(v);
        }
        if (ok) polys.push(nums);
      }
    }
    if (text || polys.length) out.push({ text, lines: polys });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// OCR adapter
// --------------------------------------------------------------------------- //

export async function _runAdapter(srcd: string, outJson: string): Promise<boolean> {
  const jpgs = fs
    .readdirSync(srcd)
    .filter((f) => f.endsWith(".jpg"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => path.join(srcd, f));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pcleaner_ocr_"));
  try {
    const cmd = [pcleanerPy(), PROMO_ADAPTER, "--model", pcleanerModel(), "--output", outJson, ...jpgs];
    const r = await lappy.withHeavy(() =>
      spawnSync(cmd[0]!, cmd.slice(1), {
        cwd: scratch,
        encoding: "utf8",
        timeout: PROMO_ADAPTER_TIMEOUT * 1000,
        env: pcleanerEnv(scratch),
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    if (r.error) throw r.error;
    if (r.status !== 0) {
      elog(`  cleaner: promo OCR adapter rc=${r.status ?? r.signal}: ${(r.stderr ?? "").slice(-300)}`);
      return false;
    }
    return fs.existsSync(outJson);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------- //
// bubble boxes (framing): CTD text blocks per image, cached by image hash
// --------------------------------------------------------------------------- //

/** [x0, y0, x1, y1, conf] in source-image pixels. */
export type BubbleBox = [number, number, number, number, number];

export const BUBBLE_CACHE_SUFFIX = ".bubbles.json";
export const BUBBLE_SCHEMA = "bubble-boxes-1";

function bubbleCachePath(cacheDir: string, sha: string): string {
  return path.join(cacheDir, `${sha}${BUBBLE_CACHE_SUFFIX}`);
}

function validBubbleBoxes(v: unknown): BubbleBox[] | null {
  if (!Array.isArray(v)) return null;
  const out: BubbleBox[] = [];
  for (const b of v) {
    if (!Array.isArray(b) || b.length < 4) return null;
    const n = b.slice(0, 5).map(Number);
    if (n.some((x) => !Number.isFinite(x))) return null;
    if (!(n[2]! > n[0]! && n[3]! > n[1]!)) continue;
    out.push([n[0]!, n[1]!, n[2]!, n[3]!, n.length > 4 ? n[4]! : 1]);
  }
  return out;
}

function readBubbleCache(file: string): BubbleBox[] | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (d.schema !== BUBBLE_SCHEMA || d.detector !== PCLEANER_DETECTOR) return null;
    return validBubbleBoxes(d.boxes);
  } catch {
    return null;
  }
}

/** One CLI call for every uncached image. null = the detector did not run. */
export async function _runBubbleAdapter(images: readonly string[]): Promise<Record<string, BubbleBox[] | null> | null> {
  if (!images.length) return {};
  if (!pcleanerInstalled() || !fs.existsSync(BUBBLE_ADAPTER)) return null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pcleaner_bubbles_"));
  try {
    const outJson = path.join(scratch, "boxes.json");
    const cmd = [pcleanerPy(), BUBBLE_ADAPTER, "--model", pcleanerModel(), "--output", outJson, ...images];
    const timeout = (BUBBLE_ADAPTER_BASE_TIMEOUT + BUBBLE_ADAPTER_PER_IMAGE_TIMEOUT * images.length) * 1000;
    const env = pcleanerEnv(scratch);
    // Detection only: no LaMa, so let OpenCV use the cores it has.
    const threads = String(Math.max(1, os.cpus().length));
    env.OMP_NUM_THREADS = threads;
    const r = await lappy.withHeavy(() =>
      spawnSync(cmd[0]!, cmd.slice(1), { cwd: scratch, encoding: "utf8", timeout, env, maxBuffer: 32 * 1024 * 1024 }),
    );
    if (r.error || r.status !== 0 || !fs.existsSync(outJson)) {
      elog(`  bubbles: CTD export rc=${r.status ?? r.signal ?? errMsg(r.error)}: ${(r.stderr ?? "").slice(-300)}`);
      return null;
    }
    const payload = JSON.parse(fs.readFileSync(outJson, "utf8")) as Record<string, unknown>;
    if (payload.schema !== BUBBLE_SCHEMA || !isMapping(payload.images)) return null;
    const out: Record<string, BubbleBox[] | null> = {};
    for (const p of images) {
      const rec = payload.images[p];
      out[p] = isMapping(rec) ? validBubbleBoxes(rec.boxes) : null;
    }
    return out;
  } catch (e) {
    elog(`  bubbles: CTD export failed (${errName(e)}: ${errMsg(e)})`);
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * CTD text-block boxes for each image, cached on disk by image sha1. A value of
 * null means "no detector result" (tool missing, failed, or disabled by
 * MANHWA_BUBBLE_DETECTOR=off|heuristic); callers fall back to a heuristic.
 * Never throws.
 */
export async function detectBubbleBoxes(
  images: readonly string[],
  cacheDir: string,
): Promise<Record<string, BubbleBox[] | null>> {
  const out: Record<string, BubbleBox[] | null> = {};
  const mode = (process.env.MANHWA_BUBBLE_DETECTOR || "ctd").toLowerCase();
  const todo: { p: string; sha: string }[] = [];
  for (const p of new Set(images)) {
    out[p] = null;
    const sha = sourceSha1(p);
    if (!sha) continue;
    const hit = readBubbleCache(bubbleCachePath(cacheDir, sha));
    if (hit) out[p] = hit;
    else todo.push({ p, sha });
  }
  if (!todo.length || mode === "off" || mode === "heuristic") return out;
  let got: Record<string, BubbleBox[] | null> | null = null;
  try {
    got = await _hooks._runBubbleAdapter(todo.map((t) => t.p));
  } catch (e) {
    elog(`  bubbles: detector failed (${errName(e)}: ${errMsg(e)})`);
  }
  if (!got) return out;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    // caching is best-effort
  }
  for (const { p, sha } of todo) {
    const boxes = got[p] ?? null;
    out[p] = boxes;
    if (!boxes) continue;
    const file = bubbleCachePath(cacheDir, sha);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schema: BUBBLE_SCHEMA, detector: PCLEANER_DETECTOR, boxes }));
      fs.renameSync(tmp, file);
    } catch {
      removeStale(tmp);
    }
  }
  return out;
}

function offsetLines(lines: number[][], ox: number, oy: number, scale: number): number[][] {
  let shifted = lines.map((poly) => poly.map((v, k) => v + (k % 2 === 0 ? ox : oy)));
  if (scale && scale !== 1) shifted = shifted.map((poly) => poly.map((v) => v / scale));
  return shifted;
}

export async function _runOcrExport(
  srcPaths: readonly string[],
  workRoot: string,
  it: CleanItem | null = null,
  scale = 1,
): Promise<Record<string, RegionRecord[]> | null> {
  if (!pcleanerInstalled()) return null;
  if (!fs.existsSync(PROMO_ADAPTER)) {
    elog(`  cleaner: promo OCR adapter missing at ${PROMO_ADAPTER}`);
    return null;
  }
  const srcd = fs.mkdtempSync(path.join(workRoot, "cleaner_ocr_in_"));
  const crops: { pid: string; name: string; ox: number; oy: number }[] = [];
  try {
    for (const p of srcPaths) {
      const pid = pyStem(p);
      let im = await loadRgb(p);
      const OW = im.width;
      const OH = im.height;
      if (scale && scale !== 1) im = await resizeRgb(im, OW * scale, OH * scale);
      const roi = it ? _roiPixelBoxes(it, OW, OH, scale) : [];
      if (roi.length) {
        for (let i = 0; i < roi.length; i++) {
          const [x0, y0, x1, y1] = roi[i]!;
          const name = `${pid}__roi${i}`;
          await saveJpeg(cropRgb(im, x0, y0, x1, y1), path.join(srcd, name + ".jpg"), 92);
          crops.push({ pid, name, ox: x0, oy: y0 });
        }
      } else {
        await saveJpeg(im, path.join(srcd, pid + ".jpg"), 92);
        crops.push({ pid, name: pid, ox: 0, oy: 0 });
      }
    }
    const outJson = path.join(workRoot, `promo_ocr_${scale}x.json`);
    if (fs.existsSync(outJson)) fs.unlinkSync(outJson);
    const ok = Boolean(await _hooks._runAdapter(srcd, outJson));
    if (!ok || !fs.existsSync(outJson)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(fs.readFileSync(outJson, "utf8"));
    } catch {
      return null;
    }
    const panels = isMapping(payload) ? payload.panels : null;
    if (!isMapping(panels)) return null;
    const out: Record<string, RegionRecord[]> = {};
    for (const { pid, name, ox, oy } of crops) {
      const recs = _validRecords(panels[name]);
      if (recs.length === 0) continue;
      const off = recs.map((r) => ({
        text: r.text,
        lines: offsetLines(r.lines, ox, oy, scale),
      }));
      out[pid] = (out[pid] ?? []).concat(off);
    }
    return Object.keys(out).length ? out : null;
  } finally {
    fs.rmSync(srcd, { recursive: true, force: true });
  }
}

export async function _applyPromoMask(
  srcPath: string,
  recs: readonly RegionRecord[],
  matcher: Matcher,
  protectedStrs: readonly string[],
  outPath: string,
): Promise<[Box[] | null, string | null]> {
  try {
    const masked = await blurPromoRegionsFile(srcPath, outPath, recs, matcher, [...protectedStrs]);
    return [masked.boxes, null];
  } catch (e) {
    if (e instanceof PromoMaskError) return [null, e.message];
    return [null, `${errName(e)}: ${errMsg(e)}`];
  }
}

export async function _verifyPromoMask(
  outPath: string,
  it: CleanItem,
  matcher: Matcher,
  recs: readonly RegionRecord[] | null,
): Promise<boolean> {
  let promo = (recs || [])
    .map((r) => r.text ?? "")
    .filter((t) => t && matcher(t));
  if (promo.length === 0) promo = asStrings(it.promo).filter((t) => t);
  if (promo.length === 0) return false;
  return Boolean(await _hooks.promoGone(outPath, promo));
}

export async function cleanPromoMask(
  it: CleanItem,
  panelsDir: string,
  cleanedDir: string,
): Promise<string | null> {
  const pid = it.id;
  const src = path.join(panelsDir, pid + ".jpg");
  const out = path.join(cleanedDir, pid + ".png");
  const stamp = out + ".done";
  const rej = out + ".rej";
  const side = out + PROMO_BOXES_SUFFIX;
  const h = _promoCacheHash(it as unknown as Record<string, unknown>, src);
  // HARD SAFETY BOUNDARY runs BEFORE any matcher/cache/mask work.
  const [ok, reason, partial] = await promoPageBoundary(it, src);
  if (!ok) {
    elog(`  cleaner: ${pid} promo boundary REJECT (${reason}); keeping original`);
    removeStale(out, stamp, rej, side);
    return null;
  }
  const matcher = _promoMatcher(it);
  if (matcher === null) {
    elog(`  cleaner: ${pid} promo item has no usable matcher; keeping original`);
    removeStale(out, stamp, rej, side);
    return null;
  }
  if (
    fs.existsSync(out) &&
    fs.existsSync(stamp) &&
    readStamp(stamp) === h &&
    validatePromoSidecar(out, src, h)
  ) {
    return out;
  }
  if (fs.existsSync(rej) && readStamp(rej) === h) return null;
  for (const old of [stamp, rej]) {
    if (fs.existsSync(old) && readStamp(old) !== h) {
      try {
        fs.unlinkSync(old);
      } catch {
        // ignore
      }
    }
  }
  if (
    fs.existsSync(out) &&
    !(fs.existsSync(stamp) && readStamp(stamp) === h && validatePromoSidecar(out, src, h))
  ) {
    removeStale(out, side);
  }
  if (!fs.existsSync(src)) {
    elog(`  cleaner: ${pid} promo source missing; keeping original`);
    return null;
  }
  const protectedStrs = protectedStrings(it, matcher);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cleaner_promo_"));
  try {
    let boxes: Box[] | null = null;
    let detail: string | null = null;
    let usedRecs: RegionRecord[] | null = null;
    const got = await _hooks._runOcrExport([src], workRoot, it, 1);
    const recs = got ? got[pid] : undefined;
    if (recs && recs.length) {
      [boxes, detail] = await _applyPromoMask(src, recs, matcher, protectedStrs, out);
      usedRecs = recs;
    }
    // 1x unusable/unsafe, or the verifier rejects it -> ONE 2x rescue.
    // `boxes === null` short-circuits: a missing 1x export does not call verify.
    if (boxes === null || !(await _hooks._verifyPromoMask(out, it, matcher, usedRecs))) {
      const got2 = await _hooks._runOcrExport([src], workRoot, it, 2);
      const recs2 = got2 ? got2[pid] : undefined;
      if (recs2 && recs2.length) {
        const [boxes2, detail2] = await _applyPromoMask(src, recs2, matcher, protectedStrs, out);
        if (boxes2 !== null) {
          boxes = boxes2;
          detail = detail2;
          usedRecs = recs2;
        }
      }
    }
    if (boxes === null) {
      removeStale(out, stamp, side);
      // B2a: NO permanent negative cache. A local mask failure must not
      // suppress the panel forever.
      elog(`  cleaner: ${pid} promo mask failed (${detail === null ? "None" : detail}); keeping original`);
      return null;
    }
    if (!(await _hooks._verifyPromoMask(out, it, matcher, usedRecs))) {
      removeStale(out, stamp, side);
      elog(`  cleaner: ${pid} promo STILL VISIBLE after local mask; keeping original`);
      return null;
    }
    // Sidecar BEFORE the .done stamp, so a stamp never exists without provenance.
    await writePromoSidecar(out, src, pid, boxes, partial, h);
    fs.writeFileSync(stamp, h);
    return out;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

async function obscureRegion(src: string, left: number, top: number, w: number, h: number): Promise<Buffer> {
  const small = await sharp(src)
    .removeAlpha()
    .extract({ left, top, width: w, height: h })
    .resize(Math.max(1, Math.round(w / 24)), Math.max(1, Math.round(h / 24)), { fit: "fill" })
    .toBuffer();
  return sharp(small)
    .resize(w, h, { fit: "fill", kernel: "nearest" })
    .blur(Math.max(2, Math.min(w, h) / 20))
    .png()
    .toBuffer();
}

/**
 * Last-resort promo cover: pixelate + blur the reader's promo regions (padded
 * ROI), or the whole panel when there are none or it is a FULL advert page.
 * No OCR, model or network. Written under `covered/` without a stamp, so the
 * next run still tries a proper promo clean.
 */
export async function coverPromoPanel(
  it: CleanItem,
  panelsDir: string,
  cleanedDir: string,
): Promise<string | null> {
  const src = path.join(panelsDir, it.id + ".jpg");
  if (!fs.existsSync(src)) return null;
  const dir = path.join(cleanedDir, "covered");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, it.id + ".png");
  let W = 800;
  let H = 1100;
  try {
    [W, H] = await imageSize(src);
    // Only a reader-confirmed partial promo keeps the rest of the panel visible.
    const boxes = truthy(it.promo_full) || it.promo_page !== false ? [] : _roiPixelBoxes(it, W, H, 1);
    if (boxes.length === 0) {
      fs.writeFileSync(out, await obscureRegion(src, 0, 0, W, H));
      return out;
    }
    const layers = [];
    for (const [x0, y0, x1, y1] of boxes) {
      layers.push({ input: await obscureRegion(src, x0, y0, x1 - x0, y1 - y0), left: x0, top: y0 });
    }
    await sharp(src).removeAlpha().composite(layers).png().toFile(out);
    return out;
  } catch (e) {
    // Unreadable source: a flat dark frame still never shows the advert.
    elog(`  cleaner: ${it.id} promo cover blur failed (${errMsg(e)}); using a blank frame`);
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 16, g: 17, b: 19 } } })
      .png()
      .toFile(out);
    return out;
  }
}

function isPromoItem(it: CleanItem): boolean {
  return Boolean(
    truthy(it.promo_item) ||
      truthy(it.promo_full) ||
      it.promo_page === true ||
      truthy(it.promo),
  );
}

function worldPromoTexts(it: CleanItem): string[] {
  return [...asStrings(it.world), ...asStrings(it.promo)];
}

export async function cleanBatch(
  items: readonly CleanItem[],
  panelsDir: string,
  cleanedDir: string,
): Promise<Record<string, string | null>> {
  if (!pcleanerInstalled()) {
    elog("  cleaner: PanelCleaner not installed, using originals");
    const early: Record<string, string | null> = {};
    for (const it of items) early[it.id] = null;
    return early;
  }
  fs.mkdirSync(cleanedDir, { recursive: true });
  const results: Record<string, string | null> = {};
  const pending: { it: CleanItem; out: string; h: string }[] = [];
  for (const it of items) {
    // Dispatch on actual promo status, never on the mere presence of promo_rules.
    if (isPromoItem(it)) {
      // A promo failure (OCR crash, verifier outage) is retried once; after that
      // timeline covers the panel instead of stopping the run.
      results[it.id] = null;
      for (let attempt = 1; attempt <= PCLEANER_ATTEMPTS; attempt++) {
        try {
          results[it.id] = await cleanPromoMask(it, panelsDir, cleanedDir);
          break;
        } catch (e) {
          elog(`  cleaner: ${it.id} promo clean attempt ${attempt}/${PCLEANER_ATTEMPTS} failed (${errMsg(e).slice(0, 200)})`);
        }
      }
      continue;
    }
    // I-55: a world-text item must never enter a batch.
    if (hasWorldText(it.world)) {
      elog(`  cleaner: ${it.id} carries world text; keeping original`);
      results[it.id] = null;
      continue;
    }
    const out = path.join(cleanedDir, it.id + ".png");
    const stamp = out + ".done";
    const rej = out + ".rej";
    const h = _cleanHash(worldPromoTexts(it));
    const done = fs.existsSync(stamp) ? readStamp(stamp) : null;
    // Verified outputs from the retired MIT cleaner stay valid; its rejections
    // do not match `h`, so those panels get one PanelCleaner retry.
    if (fs.existsSync(out) && (done === h || done === _legacyMitHash(worldPromoTexts(it)))) {
      results[it.id] = out;
    } else if (fs.existsSync(rej) && readStamp(rej) === h) {
      results[it.id] = null;
    } else {
      pending.push({ it, out, h });
    }
  }
  if (pending.length === 0) return results;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cleaner_in_"));
  const cur = new Map<string, RgbImage>();
  const meta = new Map<string, CleanItem>();
  try {
    for (const { it } of pending) {
      const src = path.join(panelsDir, it.id + ".jpg");
      if (!fs.existsSync(src)) {
        results[it.id] = null;
        continue;
      }
      const im = await loadRgb(src);
      cur.set(it.id, im);
      meta.set(it.id, it);
      await saveJpeg(im, path.join(work, it.id + ".jpg"), 92);
    }
    const orig = new Map<string, RgbImage>();
    for (const [pid, im] of cur) orig.set(pid, copyRgb(im));

    const applyPass = async (ids: string[], batch: Record<string, RgbImage>): Promise<void> => {
      for (const pid of ids) {
        const res = batch[pid];
        const prev = cur.get(pid);
        if (!res || !prev) {
          cur.delete(pid);
          continue;
        }
        if (_changedFrac(prev, res) < 0.003 && !truthy(meta.get(pid)?.promo)) continue;
        cur.set(pid, res);
        await saveJpeg(res, path.join(work, pid + ".jpg"), 92);
      }
    };

    // Ordinary bubble text never fails the render: one PanelCleaner call per
    // batch, retried once; if it still fails the panels ship uncleaned (no .rej,
    // so a later run retries them). Repeated failed batches open a circuit so a
    // long series run stops paying for a dead tool.
    if (cur.size && cleanerCircuitOpen()) {
      elog(`  cleaner: circuit open after repeated failures; shipping ${cur.size} panel(s) uncleaned`);
      cur.clear();
    } else if (cur.size) {
      let ran = false;
      for (let attempt = 1; attempt <= PCLEANER_ATTEMPTS && !ran; attempt++) {
        const ids = [...cur.keys()];
        const outd = fs.mkdtempSync(path.join(os.tmpdir(), "cleaner_pc_"));
        try {
          const batch = await _hooks._runPanelCleaner(work, outd);
          if (Object.keys(batch).length === 0) throw new Error("PanelCleaner produced no outputs");
          await applyPass(ids, batch);
          ran = true;
        } catch (e) {
          elog(`  cleaner: PanelCleaner attempt ${attempt}/${PCLEANER_ATTEMPTS} failed (${errMsg(e).slice(0, 200)})`);
          // A hung run already burned its full timeout; retrying would double it.
          if ((e as NodeJS.ErrnoException)?.code === "ETIMEDOUT") break;
        } finally {
          fs.rmSync(outd, { recursive: true, force: true });
        }
      }
      recordBatchOutcome(ran);
      if (!ran) {
        elog(`  cleaner: PanelCleaner failed; shipping ${cur.size} panel(s) uncleaned`);
        cur.clear();
      }
    }

    for (const [pid, im] of [...cur.entries()]) {
      const it = meta.get(pid)!;
      const out = path.join(cleanedDir, pid + ".png");
      const h = _cleanHash(worldPromoTexts(it));
      const base = orig.get(pid)!;
      const coverage = _changedFrac(base, im);
      const chars = typeof it.overlay_chars === "number" ? it.overlay_chars : 0;
      const expected = Math.min(0.05, PIX_PER_CHAR * Math.max(chars, 40)) * 0.5;
      if (coverage < expected) {
        elog(`  cleaner: ${pid} under-cleaned (${(coverage * 100).toFixed(1)}% changed); keeping original`);
        fs.writeFileSync(out + ".rej", h);
        results[pid] = null;
        continue;
      }
      await savePng(im, out);
      const overlay = asStrings(it.overlay);
      let resid = 0.0;
      if (overlay.length) {
        try {
          resid = await _hooks.residualOverlay(out, overlay);
        } catch (e) {
          // Transient outage: no .rej, so the next run retries this panel.
          elog(`  cleaner: ${pid} verifier unavailable (${errMsg(e)}); keeping original`);
          fs.unlinkSync(out);
          results[pid] = null;
          continue;
        }
      }
      if (resid > 0.15) {
        elog(`  cleaner: ${pid} residual ${(resid * 100).toFixed(0)}%; keeping original`);
        fs.unlinkSync(out);
        fs.writeFileSync(out + ".rej", h);
        results[pid] = null;
        continue;
      }
      fs.writeFileSync(out + ".done", h);
      results[pid] = out;
    }
    for (const pid of meta.keys()) {
      if (!(pid in results)) results[pid] = null;
    }
    return results;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function _cleanHash(worldTexts: readonly string[]): string {
  return `pc|${cfgHash(worldTexts, PCLEANER_PROFILE)}`;
}

/** Stamp the retired MIT cleaner wrote (cfgHash over cleaner_config.json). */
export function _legacyMitHash(worldTexts: readonly string[]): string {
  const worlds = createHash("sha1").update(pySorted(worldTexts).join("|"), "utf8").digest("hex");
  return `${LEGACY_MIT_CONFIG_SHA1}|${worlds}`;
}

/**
 * One PanelCleaner CLI run over every JPEG in `srcDir` (always local). Throws on spawn error, non-zero exit or timeout.
 */
export async function _runPanelCleaner(
  srcDir: string,
  outDir: string,
  timeout: number | null = null,
): Promise<Record<string, RgbImage>> {
  const n = fs.readdirSync(srcDir).filter((f) => f.endsWith(".jpg")).length;
  const limit = timeout || 300 + n * 120;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pcleaner_run_"));
  try {
    const cmd = [
      pcleanerPy(), "-m", "pcleaner.main", "clean", srcDir,
      `--output_dir=${outDir}`, `--profile=${PCLEANER_PROFILE}`,
      "--save-only-cleaned", "--hide-analytics",
    ];
    const r = await lappy.withHeavy(() =>
      spawnSync(cmd[0]!, cmd.slice(1), {
        cwd: scratch,
        encoding: "utf8",
        timeout: limit * 1000,
        maxBuffer: 64 * 1024 * 1024,
        env: pcleanerEnv(scratch),
      }),
    );
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const rc = r.status ?? r.signal ?? "killed";
      const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.slice(-300).trim();
      elog(`  cleaner: panelcleaner run failed (rc=${rc}): ${tail}`);
      const err = new Error(`panelcleaner failed (rc=${rc}): ${tail}`);
      err.name = "RuntimeError";
      throw err;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const out: Record<string, RgbImage> = {};
  if (!isDir(outDir)) return out;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith("_clean.png")) continue;
    const pid = f.slice(0, -"_clean.png".length);
    const srcf = path.join(srcDir, pid + ".jpg");
    if (!fs.existsSync(srcf)) continue;
    const im = await loadRgb(path.join(outDir, f));
    const [sw, sh] = await imageSize(srcf);
    if (im.width !== sw || im.height !== sh) continue;
    out[pid] = im;
  }
  return out;
}

export async function ensureClean(
  panelId: string,
  panelsDir: string,
  cleanedDir: string,
  overlayChars = 100,
  worldTexts: readonly string[] = [],
  overlayTexts: readonly string[] = [],
): Promise<string | null> {
  const r = await cleanBatch(
    [{ id: panelId, overlay_chars: overlayChars, world: [...worldTexts], overlay: [...overlayTexts] }],
    panelsDir,
    cleanedDir,
  );
  return r[panelId] ?? null;
}

// Wire hooks to the real implementations. Tests replace properties; they must
// not replace these exports (ESM bindings are not assignable).
_hooks._runOcrExport = _runOcrExport;
_hooks._verifyPromoMask = _verifyPromoMask;
_hooks._visionFullVsStory = _visionFullVsStory;
_hooks._runPanelCleaner = _runPanelCleaner;
_hooks.residualOverlay = residualOverlay;
_hooks.promoGone = promoGone;
_hooks._runAdapter = _runAdapter;
_hooks._runBubbleAdapter = _runBubbleAdapter;

// snake_case aliases (cleaner.py names)
export const has_world_text = hasWorldText;
export const should_clean = shouldClean;
export const union_filter = unionFilter;
export const residual_overlay = residualOverlay;
export const norm_ws = normWs;
export const promo_gone = promoGone;
export const _vision_full_vs_story = _visionFullVsStory;
export const promo_page_boundary = promoPageBoundary;
export const write_promo_sidecar = writePromoSidecar;
export const validate_promo_sidecar = validatePromoSidecar;
export const _changed_frac = _changedFrac;
export const _whole_string_matcher = _wholeStringMatcher;
export const _promo_matcher = _promoMatcher;
export const _promo_rules_hash = _promoRulesHash;
export const _promo_cache_hash = _promoCacheHash;
export const _roi_pixel_boxes = _roiPixelBoxes;
export const _valid_records = _validRecords;
export const _run_adapter = _runAdapter;
export const _run_ocr_export = _runOcrExport;
export const _apply_promo_mask = _applyPromoMask;
export const _verify_promo_mask = _verifyPromoMask;
export const clean_promo_mask = cleanPromoMask;
export const cover_promo_panel = coverPromoPanel;
export const clean_batch = cleanBatch;
export const _clean_hash = _cleanHash;
export const ensure_clean = ensureClean;
