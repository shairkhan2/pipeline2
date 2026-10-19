/**
 * slicer.ts - split webtoon PAGES into PANELS at gutter bands.
 *
 * TypeScript port of manhwa-pipeline/pipeline/slicer.py (T6.1).
 *
 * Algorithm (tuned on real ch1 pages):
 *   1. row is gutter-candidate if near-white OR near-black AND low variance (flat band)
 *   2. runs >= MIN_RUN px become cuts
 *   3. cuts closer than MERGE_PX merge (kills sliver segments between double gutters)
 *   4. segments shorter than MIN_PANEL_PX fold into the larger neighbor
 *   5. leading/trailing bands trim instead of splitting
 *   6. any remaining interior near-white band >= 10% of the segment, clearing both
 *      segment edges by 2% and flanked by real art rows, splits the segment
 *      (interiorGutters, the rule pipeline/tools/panel_audit.py also audits)
 *   7. blocks left under the panel floor are DROPPED, not folded across the band -
 *      folding is what re-fused panels (the cut being undone in the same breath)
 *   8. the floor is ASPECT-AWARE (shippable): h >= MIN_PANEL_PX OR a real
 *      short-wide panel (shortWidePanel), so a 900x100 landscape panel is not
 *      deleted for being short. Thin edge slivers still die - the test requires
 *      sustained art reaching BOTH page edges.
 *   9. a page-straddling panel is welded only when the JOINED crop is one panel
 *      (weldIsSound): no interior near-white band the gutter gate would cut and
 *      no brightness step across the seam. Welded panels carry page_span.
 *  10. every interior gutter band is EXCLUDED from both neighbouring segments -
 *      the bounds pair (top,c1[0]), (c1[1],c2[0]), ... so no band is emitted
 *      inside two panels at once. See segments().
 *  11. trim()'s near-black branch is gated on the page's own median rowmean: on a
 *      night page dark rows ARE the drawing, and the unguarded test walked
 *      through it. See trim().
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';

import { pagesHash, pyJsonDumps, pySorted, SLICER_REV as HASHES_SLICER_REV } from '../contracts/hashes.js';
import type { Manifest, ManifestRec } from '../contracts/schemas.js';

// ---------------------------------------------------------------------------
// Constants (verbatim from slicer.py)
// ---------------------------------------------------------------------------

export const SLICER_REV = HASHES_SLICER_REV;
export const RESLICE_FUSED = true;

export const MIN_RUN = 25;        // px: minimum flat band to count as a gutter
export const MERGE_PX = 40;       // px: cuts closer than this are one gutter
export const MIN_PANEL_PX = 120;  // px: HEIGHT floor - see shippable()/shortWidePanel()
export const THR_HI = 242;
export const THR_LO = 18;
export const VAR_MAX = 60;

export const SHORT_WIDE_MIN_PX = 40;       // nothing under this is ever a panel
export const SHORT_WIDE_ART_ROWS = 24;     // real drawing rows, not a rule/scanline
export const SHORT_WIDE_ART_RUN = 12;      // sustained art run
export const SHORT_WIDE_INK_COLS = 0.70;   // ink covers >=70% of the page width
export const SHORT_WIDE_EDGE = 0.90;       // ...reaching within 10% of BOTH page edges
export const SHORT_WIDE_FLANK_GUT = 1;     // a near-white gutter on >=1 vertical flank
export const SHORT_WIDE_MIN_STD = 6.0;     // row-mean std: at or below this it is a bar, not drawing

export const ART_MIN_RUN_PX = 8;           // runs shorter than this never define an edge
export const ART_MIN_RUN_FRAC = 0.01;      // ... or shorter than 1% of the crop height

export const WHITE_THR = 235;              // row pixel > this is white (same as trim())
export const WHITE_SPLIT_WIDTH_FRAC = 0.92; // row must be white across >92% of its width
export const WHITE_SPLIT_MIN_FRAC = 0.15;  // LEGACY band gate: >= 15% of the segment height

export const GUTTER_MIN_FRAC = 0.10;       // band must be >= 10% of the segment height ...
export const GUTTER_MIN_PX = 16;           // ... and never shorter than this
export const GUTTER_EDGE_FRAC = 0.02;      // band must clear EACH segment edge by >= 2% of height ...
export const GUTTER_EDGE_MIN_PX = 8;       // ... floor 8px
export const GUTTER_FLANK_PX = 16;         // a real art row must sit this close above AND below the band
export const GUTTER_ART_PX = 200;          // "real art row": >= GUTTER_ART_ROW_FRAC of its pixels < this
export const GUTTER_ART_ROW_FRAC = 0.05;

export const WELD_BAND_PX = 100;           // interior near-white band this tall = a real gutter
export const WELD_BAND_FRAC = 0.06;        // ...or this fraction of the joined panel
export const WELD_STEP = 25;               // brightness step (levels) tolerated across the seam
export const WELD_STEP_WINDOW = 60;        // rows averaged on each side of the seam

export const FUSED_MIN_PX = 8;             // px: shortest interior band that counts as a fused gutter
export const FUSED_MIN_FRAC = 0.08;        // ... or 8% of the crop height, whichever is larger

export interface SlicerStats {
  fused_panels: number;
  resplit_panels: number;
  welds?: number;
  weld_rejected?: Record<string, number>;
}

/** Per-run instrumentation for tests/audits (callers only ever get the list back). */
export const LAST_STATS: SlicerStats = {
  fused_panels: 0,
  resplit_panels: 0,
};

// ---------------------------------------------------------------------------
// 2D Grayscale / RGB Image Helpers
// ---------------------------------------------------------------------------

/** 2D grayscale array matching numpy `np.asarray(im.convert("L"), dtype=np.float32)`. */
export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/** In-memory RGB image (3 bytes per pixel, row-major). */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export type Span = [number, number];

/**
 * Convert an RGB image to a 2D grayscale array using PIL's exact integer L24 formula:
 * `L = (R * 19595 + G * 38470 + B * 7471 + 0x8000) >> 16`
 */
export function rgbToGray(rgb: RgbImage): GrayImage {
  const { width, height, data } = rgb;
  const out = new Float32Array(width * height);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]!;
    const g = data[i * 3 + 1]!;
    const b = data[i * 3 + 2]!;
    out[i] = ((r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16) | 0;
  }
  return { data: out, width, height };
}

/** Slice rows `[y0, y1)` of a GrayImage without copying underlying memory. */
export function sliceGrayRows(im: GrayImage, y0: number, y1: number): GrayImage {
  const top = Math.max(0, Math.min(im.height, y0));
  const bot = Math.max(top, Math.min(im.height, y1));
  return {
    data: im.data.subarray(top * im.width, bot * im.width),
    width: im.width,
    height: bot - top,
  };
}

/** Crop rows `[y0, y1)` of an RgbImage. */
export function cropRgbRows(im: RgbImage, y0: number, y1: number): RgbImage {
  const top = Math.max(0, Math.min(im.height, y0));
  const bot = Math.max(top, Math.min(im.height, y1));
  const h = bot - top;
  const out = new Uint8Array(im.width * h * 3);
  out.set(im.data.subarray(top * im.width * 3, bot * im.width * 3));
  return { data: out, width: im.width, height: h };
}

/** Decode an image file to RGB matching `Image.open(path).convert("RGB")`. */
export async function loadRgbImage(file: string): Promise<RgbImage> {
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  if (ch === 3) {
    const out3 = new Uint8Array(w * h * 3);
    out3.set(data.subarray(0, w * h * 3));
    return { data: out3, width: w, height: h };
  }
  const out = new Uint8Array(w * h * 3);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (ch === 1 || ch === 2) {
      const g = data[i * ch]!;
      out[i * 3] = g;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = g;
    } else {
      out[i * 3] = data[i * ch]!;
      out[i * 3 + 1] = data[i * ch + 1]!;
      out[i * 3 + 2] = data[i * ch + 2]!;
    }
  }
  return { data: out, width: w, height: h };
}

/** Save an RgbImage as JPEG with quality=88. */
async function saveJpeg(im: RgbImage, outPath: string): Promise<void> {
  await sharp(Buffer.from(im.data.buffer, im.data.byteOffset, im.data.byteLength), {
    raw: { width: im.width, height: im.height, channels: 3 },
  })
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

// ---------------------------------------------------------------------------
// Numeric / Array Helpers (matching numpy float32 semantics)
// ---------------------------------------------------------------------------

/** Mean of a single row `y` in `im`, rounded to float32 like `im[y].mean()`. */
function rowMeanAt(im: GrayImage, y: number): number {
  const w = im.width;
  if (w === 0) return Number.NaN;
  const off = y * w;
  const data = im.data;
  let sum = 0;
  for (let x = 0; x < w; x++) {
    sum += data[off + x]!;
  }
  return Math.fround(sum / w);
}

/** Per-row mean of `im` (`im.mean(axis=1)`), stored as Float32Array. */
function rowMeans(im: GrayImage): Float32Array {
  const { width: w, height: h, data } = im;
  const out = new Float32Array(h);
  if (w === 0) return out;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += data[off + x]!;
    }
    out[y] = Math.fround(sum / w);
  }
  return out;
}

/** Per-row variance of `im` (`im.var(axis=1)`), stored as Float32Array. */
function rowVars(im: GrayImage, means?: Float32Array): Float32Array {
  const { width: w, height: h, data } = im;
  const rm = means ?? rowMeans(im);
  const out = new Float32Array(h);
  if (w === 0) return out;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    const m = rm[y]!;
    let sumSq = 0;
    for (let x = 0; x < w; x++) {
      const d = Math.fround(data[off + x]! - m);
      sumSq += Math.fround(d * d);
    }
    out[y] = Math.fround(sumSq / w);
  }
  return out;
}

/** Exact `float(np.median(arr))` for a 1D Float32Array. */
function medianFloat32(arr: Float32Array): number {
  const n = arr.length;
  if (n === 0) return Number.NaN;
  const sorted = Float32Array.from(arr).sort();
  const mid = n >> 1;
  if ((n & 1) === 1) {
    return sorted[mid]!;
  }
  return Math.fround((sorted[mid - 1]! + sorted[mid]!) * 0.5);
}

/** Standard deviation of a 1D Float32Array (`float(arr.std())`). */
function stdFloat32(arr: Float32Array): number {
  const n = arr.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i]!;
  const mean = Math.fround(sum / n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.fround(arr[i]! - mean);
    sumSq += Math.fround(d * d);
  }
  return Math.fround(Math.sqrt(Math.fround(sumSq / n)));
}

/** Mean of a 0/1 mask (`mask.mean()`). */
function maskMean(mask: Uint8Array | ReadonlyArray<number | boolean>, start = 0, end = mask.length): number {
  const s = Math.max(0, start);
  const e = Math.min(mask.length, Math.max(s, end));
  const len = e - s;
  if (len === 0) return Number.NaN;
  let count = 0;
  for (let i = s; i < e; i++) {
    if (mask[i]) count++;
  }
  return count / len;
}

/** True if any element in `mask[start:end]` is truthy (`mask[start:end].any()`). */
function maskAny(mask: Uint8Array | ReadonlyArray<number | boolean>, start = 0, end = mask.length): boolean {
  const s = Math.max(0, start);
  const e = Math.min(mask.length, Math.max(s, end));
  for (let i = s; i < e; i++) {
    if (mask[i]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core Slicer Functions
// ---------------------------------------------------------------------------

/**
 * Find flat near-white or near-black horizontal bands of height >= MIN_RUN,
 * separating leading/trailing page bands (`top`, `bot`) and merging interior
 * cuts closer than `MERGE_PX`.
 */
export function findCuts(im: GrayImage): [number, number, Span[]] {
  const h = im.height;
  const rm = rowMeans(im);
  const rv = rowVars(im, rm);
  const band = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const m = rm[y]!;
    const v = rv[y]!;
    band[y] = (m > THR_HI || m < THR_LO) && v < VAR_MAX ? 1 : 0;
  }
  const runs: Span[] = [];
  let start: number | null = null;
  for (let y = 0; y < h; y++) {
    if (band[y] && start === null) {
      start = y;
    } else if (!band[y] && start !== null) {
      if (y - start >= MIN_RUN) runs.push([start, y]);
      start = null;
    }
  }
  if (start !== null && h - start >= MIN_RUN) {
    runs.push([start, h]);
  }
  const top = runs.length > 0 && runs[0]![0] === 0 ? runs[0]![1] : 0;
  const bot = runs.length > 0 && runs[runs.length - 1]![1] === h ? runs[runs.length - 1]![0] : h;
  const inner = runs.filter((r) => r[0] > 0 && r[1] < h);
  const merged: Span[] = [];
  for (const r of inner) {
    if (merged.length > 0 && r[0] - merged[merged.length - 1]![1] < MERGE_PX) {
      merged[merged.length - 1]![1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return [top, bot, merged];
}

/**
 * Trim residual white/black rows at segment edges (thin bands the run
 * detector missed); stop at the first content row.
 *
 * THE DARK-BRANCH GUARD (`pageMedian`): the near-black side of the blank
 * test is disabled whenever the page's own median rowmean is below 25.
 */
export function trim(
  im: GrayImage,
  y0: number,
  y1: number,
  pageMedian: number | null = null,
): Span {
  const med = pageMedian ?? medianFloat32(rowMeans(im));
  const darkBlank = med >= 25;
  while (y0 < y1 - 1) {
    const m = rowMeanAt(im, y0);
    if (m > 235 || (darkBlank && m < 25)) y0 += 1;
    else break;
  }
  while (y1 > y0 + 1) {
    const m = rowMeanAt(im, y1 - 1);
    if (m > 235 || (darkBlank && m < 25)) y1 -= 1;
    else break;
  }
  return [y0, y1];
}

/**
 * Tight bbox of art rows in a panel crop, normalized to [0, 1].
 * Returns `[art_top, art_bottom]` with `0.0 <= art_top < art_bottom <= 1.0`.
 */
export function artBounds(gray: GrayImage): [number, number] {
  const h = gray.height;
  if (h === 0) return [0.0, 1.0];
  const rm = rowMeans(gray);
  const med = medianFloat32(rm);
  const content = new Uint8Array(h);
  let anyContent = false;
  if (med < 25) {
    for (let y = 0; y < h; y++) {
      if (rm[y]! <= 235) {
        content[y] = 1;
        anyContent = true;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const v = rm[y]!;
      if (v <= 235 && v >= 25) {
        content[y] = 1;
        anyContent = true;
      }
    }
  }
  if (!anyContent) return [0.0, 1.0];
  const minRun = Math.max(ART_MIN_RUN_PX, Math.trunc(ART_MIN_RUN_FRAC * h));
  const runs = _rowRuns(content, h);
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  for (const [s, e] of runs) {
    if (e - s >= minRun) {
      if (firstStart === null) firstStart = s;
      lastEnd = e;
    }
  }
  if (firstStart === null || lastEnd === null) return [0.0, 1.0];
  const a = firstStart / h;
  const b = lastEnd / h;
  if (a >= b) return [0.0, 1.0];
  return [a, b];
}

/**
 * Per-row mask of near-white rows: rowmean > 235 AND > WHITE_SPLIT_WIDTH_FRAC
 * of its pixels exceed 235.
 */
export function nearWhiteRows(im: GrayImage): Uint8Array {
  const { width: w, height: h, data } = im;
  const out = new Uint8Array(h);
  if (w === 0) return out;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let sum = 0;
    let whiteCount = 0;
    for (let x = 0; x < w; x++) {
      const v = data[off + x]!;
      sum += v;
      if (v > WHITE_THR) whiteCount++;
    }
    const rm = Math.fround(sum / w);
    const wfrac = whiteCount / w;
    out[y] = rm > WHITE_THR && wfrac > WHITE_SPLIT_WIDTH_FRAC ? 1 : 0;
  }
  return out;
}

/**
 * Per-row mask of REAL art rows: >= GUTTER_ART_ROW_FRAC of the row's pixels
 * darker than GUTTER_ART_PX.
 */
export function artRows(im: GrayImage): Uint8Array {
  const { width: w, height: h, data } = im;
  const out = new Uint8Array(h);
  if (w === 0) return out;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let darkCount = 0;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! < GUTTER_ART_PX) darkCount++;
    }
    out[y] = darkCount / w >= GUTTER_ART_ROW_FRAC ? 1 : 0;
  }
  return out;
}

/** `[(y0, y1)]` runs of True in a per-row mask (`y1` exclusive). */
export function _rowRuns(
  mask: Uint8Array | ReadonlyArray<number | boolean>,
  n: number = mask.length,
): Span[] {
  const limit = Math.min(n, mask.length);
  const runs: Span[] = [];
  let start: number | null = null;
  for (let i = 0; i < limit; i++) {
    const v = Boolean(mask[i]);
    if (v && start === null) {
      start = i;
    } else if (!v && start !== null) {
      runs.push([start, i]);
      start = null;
    }
  }
  if (start !== null) {
    runs.push([start, limit]);
  }
  return runs;
}

export { _rowRuns as rowRuns };

/**
 * `[(y0, y1)]` page coords of the REAL interior white gutters inside segment `[a, b)`.
 */
export function interiorGutters(
  white: Uint8Array | ReadonlyArray<number | boolean>,
  art: Uint8Array | ReadonlyArray<number | boolean>,
  a: number,
  b: number,
): Span[] {
  const h = b - a;
  const minRun = Math.max(GUTTER_MIN_PX, Math.trunc(GUTTER_MIN_FRAC * h));
  const edge = Math.max(GUTTER_EDGE_MIN_PX, Math.trunc(GUTTER_EDGE_FRAC * h));
  const out: Span[] = [];
  const subWhite =
    white instanceof Uint8Array ? white.subarray(a, b) : white.slice(a, b);
  for (const [x, y] of _rowRuns(subWhite, h)) {
    if (y - x < minRun || x < edge || h - y < edge) continue;
    const up = a + x;
    const dn = a + y;
    if (!maskAny(art, Math.max(0, up - GUTTER_FLANK_PX), up)) continue;
    if (!maskAny(art, dn, dn + GUTTER_FLANK_PX)) continue;
    out.push([up, dn]);
  }
  return out;
}

/**
 * True if any known gutter `[a, b)` overlaps the open span `(y0, y1)`.
 */
export function _gutterIn(
  gutters: Iterable< readonly [number, number] >,
  y0: number,
  y1: number,
): boolean {
  for (const [a, b] of gutters) {
    if (a < y1 && b > y0) return true;
  }
  return false;
}

export { _gutterIn as gutterIn };

/** Longest run of True in a 1-D boolean mask. */
export function _longestRun(
  mask: Uint8Array | ReadonlyArray<number | boolean>,
): number {
  const n = mask.length;
  if (n === 0) return 0;
  let best = 0;
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

export { _longestRun as longestRun };

/**
 * True when a sub-MIN_PANEL_PX block is a real LANDSCAPE panel rather than a sliver.
 */
export function shortWidePanel(
  blk: GrayImage,
  white: Uint8Array | ReadonlyArray<number | boolean> | null = null,
  a = 0,
): boolean {
  const h = blk.height;
  if (h < SHORT_WIDE_MIN_PX) return false;
  const w = blk.width;
  if (w === 0) return false;
  const data = blk.data;
  const art = new Uint8Array(h);
  const colInk = new Uint8Array(w);
  let artSum = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let darkRow = 0;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! < GUTTER_ART_PX) {
        darkRow++;
        colInk[x] = 1;
      }
    }
    if (darkRow / w >= GUTTER_ART_ROW_FRAC) {
      art[y] = 1;
      artSum++;
    }
  }
  if (artSum < SHORT_WIDE_ART_ROWS) return false;
  if (_longestRun(art) < SHORT_WIDE_ART_RUN) return false;
  let inkedCols = 0;
  let firstInked = -1;
  let lastInked = -1;
  for (let x = 0; x < w; x++) {
    if (colInk[x]) {
      inkedCols++;
      if (firstInked === -1) firstInked = x;
      lastInked = x;
    }
  }
  if (inkedCols / w < SHORT_WIDE_INK_COLS) return false;
  if (firstInked === -1) return false;
  if (firstInked > (1.0 - SHORT_WIDE_EDGE) * w) return false;
  if (lastInked < SHORT_WIDE_EDGE * w) return false;
  if (white !== null && white !== undefined) {
    const upStart = Math.max(0, a - MERGE_PX);
    const upEnd = Math.max(upStart, Math.min(white.length, a));
    const dnStart = Math.max(0, Math.min(white.length, a + h));
    const dnEnd = Math.max(dnStart, Math.min(white.length, a + h + MERGE_PX));
    let gut = 0;
    if (upEnd > upStart && maskMean(white, upStart, upEnd) >= 0.8) gut += 1;
    if (dnEnd > dnStart && maskMean(white, dnStart, dnEnd) >= 0.8) gut += 1;
    if (gut < SHORT_WIDE_FLANK_GUT) return false;
  }
  if (stdFloat32(rowMeans(blk)) <= SHORT_WIDE_MIN_STD) return false;
  return true;
}

/**
 * THE aspect-aware panel floor: height >= MIN_PANEL_PX, OR real short-wide panel.
 */
export function shippable(
  blk: GrayImage | number,
  white: Uint8Array | ReadonlyArray<number | boolean> | null = null,
  a = 0,
): boolean {
  const h = typeof blk === 'number' ? blk : blk.height;
  if (h >= MIN_PANEL_PX) return true;
  if (typeof blk === 'number') return false;
  return shortWidePanel(blk, white, a);
}

/**
 * Fold segments shorter than the aspect-aware floor into the larger neighbor.
 * NEVER across a known gutter.
 */
export function _foldSlivers(
  segs: Span[],
  gutters: Iterable<readonly [number, number]> = [],
  ship: ((y0: number, y1: number) => boolean) | null = null,
): Span[] {
  const out: Span[] = segs.map(([a, b]) => [a, b]);
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const [a, b] = out[i]!;
      if (b - a < MIN_PANEL_PX && !(ship && ship(a, b))) {
        if (i === 0) {
          if (_gutterIn(gutters, b, out[1]![0])) {
            out.shift();
          } else {
            out[1] = [a, out[1]![1]];
            out.shift();
          }
        } else if (i === out.length - 1) {
          if (_gutterIn(gutters, out[out.length - 2]![1], a)) {
            out.pop();
          } else {
            out[out.length - 2] = [out[out.length - 2]![0], b];
            out.pop();
          }
        } else {
          const up = out[i - 1]![1] - out[i - 1]![0];
          const dn = out[i + 1]![1] - out[i + 1]![0];
          if (up >= dn) {
            if (_gutterIn(gutters, out[i - 1]![1], a)) {
              out.splice(i, 1);
            } else {
              out[i - 1] = [out[i - 1]![0], b];
              out.splice(i, 1);
            }
          } else {
            if (_gutterIn(gutters, b, out[i + 1]![0])) {
              out.splice(i, 1);
            } else {
              out[i + 1] = [a, out[i + 1]![1]];
              out.splice(i, 1);
            }
          }
        }
        changed = true;
        break;
      }
    }
  }
  return out;
}

export { _foldSlivers as foldSlivers };

/**
 * Keep the blocks that pass the aspect-aware floor; DROP the rest.
 * Falls back to `[whole]` if nothing in the segment clears the HEIGHT floor alone.
 */
export function _dropSlivers(
  blocks: Span[],
  whole: Span,
  ship: ((y0: number, y1: number) => boolean) | null = null,
): Span[] {
  const keep = blocks.filter(
    (b) => shippable(b[1] - b[0]) || Boolean(ship && ship(b[0], b[1])),
  );
  if (blocks.some((b) => shippable(b[1] - b[0]))) {
    return keep;
  }
  return [[whole[0], whole[1]]];
}

export { _dropSlivers as dropSlivers };

/**
 * Cut `[a, b)` at every interior white band the slicer considers a real gutter
 * and return the TRIMMED art blocks between them.
 */
export function _splitOnWhite(
  im: GrayImage,
  white: Uint8Array | ReadonlyArray<number | boolean>,
  art: Uint8Array | ReadonlyArray<number | boolean>,
  a: number,
  b: number,
  pageMedian: number | null = null,
): Span[] {
  const bands: Span[] = interiorGutters(white, art, a, b);
  const segH = b - a;
  const oldMin = Math.max(MIN_RUN, Math.trunc(WHITE_SPLIT_MIN_FRAC * segH));
  const subWhite =
    white instanceof Uint8Array ? white.subarray(a, b) : white.slice(a, b);
  for (const [x, y] of _rowRuns(subWhite, segH)) {
    if (x > 0 && y < segH && y - x >= oldMin) {
      bands.push([a + x, a + y]);
    }
  }
  bands.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const blocks: Span[] = [];
  let cur = a;
  for (const [x, y] of bands) {
    if (x >= cur) {
      blocks.push(trim(im, cur, x, pageMedian));
    }
    cur = Math.max(cur, y);
  }
  blocks.push(trim(im, cur, b, pageMedian));
  return blocks.filter((blk) => blk[1] > blk[0]);
}

export { _splitOnWhite as splitOnWhite };

/**
 * Return `[(y0, y1)]` panel segments after folding slivers.
 */
export function segments(im: GrayImage): Span[] {
  const h = im.height;
  const [top, bot, cuts] = findCuts(im);
  if (top >= bot) {
    return [[0, h]];
  }
  const pageMedian = medianFloat32(rowMeans(im));
  const bounds: number[] = [top];
  for (const r of cuts) {
    bounds.push(r[0], r[1]);
  }
  bounds.push(bot);
  let segs: Span[] = [];
  for (let i = 0; i < bounds.length - 1; i += 2) {
    segs.push(trim(im, bounds[i]!, bounds[i + 1]!, pageMedian));
  }
  const white = nearWhiteRows(im);
  const art = artRows(im);
  const ship = (a: number, b: number): boolean =>
    shippable(sliceGrayRows(im, a, b), white, a);
  const gutters = cuts.filter((r) => maskMean(white, r[0], r[1]) >= 0.8);
  segs = _foldSlivers(segs, gutters, ship);

  const split: Span[] = [];
  for (const [a, b] of segs) {
    split.push(
      ..._dropSlivers(
        _splitOnWhite(im, white, art, a, b, pageMedian),
        [a, b],
        ship,
      ),
    );
  }
  segs = split;

  if (
    segs.length === 1 &&
    segs[0]![1] - segs[0]![0] < MIN_PANEL_PX &&
    !ship(segs[0]![0], segs[0]![1])
  ) {
    return [[0, h]];
  }
  const keep = segs.filter(([a, b]) => ship(a, b));
  if (segs.some(([a, b]) => shippable(b - a))) {
    return keep;
  }
  return [[0, h]];
}

/**
 * True if the segment touches the page edge with real content (no gutter),
 * i.e. the panel likely continues onto the neighboring page.
 */
export function edgeContent(
  im: GrayImage,
  y0: number,
  y1: number,
  at: 'top' | 'bottom' = 'top',
): boolean {
  const y = at === 'top' ? y0 : y1 - 1;
  const m = rowMeanAt(im, y);
  return !(m > 235 || m < 25);
}

/**
 * Bottom rows of page N vs top rows of page N+1: a panel cut mid-way has
 * nearly identical pixels across the boundary; two separate flush panels do not.
 */
export function boundaryContinuous(a: GrayImage, b: GrayImage): boolean {
  const w = a.width;
  if (w === 0 || b.width !== w) return false;
  const na = Math.min(3, a.height);
  const nb = Math.min(3, b.height);
  if (na === 0 || nb === 0) return false;
  let total = 0;
  for (let x = 0; x < w; x++) {
    let sa = 0;
    for (let y = 0; y < na; y++) {
      sa += a.data[(a.height - na + y) * w + x]!;
    }
    let sb = 0;
    for (let y = 0; y < nb; y++) {
      sb += b.data[y * w + x]!;
    }
    const ma = Math.fround(sa / na);
    const mb = Math.fround(sb / nb);
    total += Math.fround(Math.abs(Math.fround(ma - mb)));
  }
  return Math.fround(total / w) < 28;
}

/**
 * Longest INTERIOR near-white run in the joined weld panel, in px.
 */
export function _weldBandPx(joined: GrayImage): number {
  const h = joined.height;
  const white = nearWhiteRows(joined);
  let best = 0;
  for (const [s, e] of _rowRuns(white, h)) {
    if (s >= 1 && e <= h - 1) {
      if (e - s > best) best = e - s;
    }
  }
  return best;
}

export { _weldBandPx as weldBandPx };

export type WeldReason = 'band' | 'step' | 'both' | null;

/**
 * True when joining these two segments would produce one panel rather than
 * a fused pair. Returns `[sound, reason]` with reason in `(null, "band", "step", "both")`.
 */
export function weldIsSound(
  arrA: GrayImage,
  y0a: number,
  y1a: number,
  arrB: GrayImage,
  y0b: number,
  y1b: number,
): [boolean, WeldReason] {
  const w = arrA.width;
  const h1 = y1a - y0a;
  const h2 = y1b - y0b;
  const h = h1 + h2;
  const joinedData = new Float32Array(h * w);
  joinedData.set(arrA.data.subarray(y0a * w, y1a * w), 0);
  joinedData.set(arrB.data.subarray(y0b * w, y1b * w), h1 * w);
  const joined: GrayImage = { data: joinedData, width: w, height: h };

  const band = _weldBandPx(joined);
  const lim = Math.max(WELD_BAND_PX, Math.trunc(WELD_BAND_FRAC * h));
  const hasBand = band >= lim;

  const win = WELD_STEP_WINDOW;
  const upStart = Math.max(0, h1 - win);
  const dnEnd = Math.min(h, h1 + win);
  const upLen = (h1 - upStart) * w;
  const dnLen = (dnEnd - h1) * w;
  let step = 0.0;
  if (upLen > 0 && dnLen > 0) {
    let su = 0;
    for (let i = upStart * w; i < h1 * w; i++) su += joinedData[i]!;
    let sd = 0;
    for (let i = h1 * w; i < dnEnd * w; i++) sd += joinedData[i]!;
    step = Math.abs(Math.fround(su / upLen) - Math.fround(sd / dnLen));
  }
  const hasStep = step > WELD_STEP;
  if (hasBand && hasStep) return [false, 'both'];
  if (hasBand) return [false, 'band'];
  if (hasStep) return [false, 'step'];
  return [true, null];
}

/**
 * True when the crop still contains a strictly interior near-white band
 * of height >= max(FUSED_MIN_PX, 8% of height).
 */
export function interiorFused(gray: GrayImage): boolean {
  const h = gray.height;
  const white = nearWhiteRows(gray);
  const minRun = Math.max(FUSED_MIN_PX, Math.trunc(FUSED_MIN_FRAC * h));
  for (const [s, e] of _rowRuns(white, h)) {
    if (s >= 1 && e <= h - 1 && e - s >= minRun) {
      return true;
    }
  }
  return false;
}

/**
 * True when `pieces` is a >=2-piece contiguous partition of `[y0, y1)`.
 */
export function _covers(
  pieces: ReadonlyArray<readonly [number, number]>,
  y0: number,
  y1: number,
): boolean {
  if (pieces.length < 2) return false;
  if (pieces[0]![0] !== y0 || pieces[pieces.length - 1]![1] !== y1) return false;
  for (let i = 0; i < pieces.length - 1; i++) {
    if (pieces[i]![1] !== pieces[i + 1]![0]) return false;
  }
  return true;
}

export { _covers as covers };

/**
 * Deterministic fingerprint of the source pages: sorted `"<filename>:<size>\n"`
 * of every regular file in the chapter dir (delegates to `pagesHash` in `contracts/hashes.ts`).
 */
export function _pagesHash(chdir: string): string {
  return pagesHash(chdir);
}

export { pagesHash };

/** Format `manifest.json` / `manifest.meta.json` identically to `json.dump(..., indent=1)`. */
function dumpJsonIndent1(value: unknown): string {
  const raw = JSON.stringify(value, null, 1);
  // Ensure art_top / art_bottom whole-number floats keep `.0` like Python json.dump
  return raw.replace(
    /("art_(?:top|bottom)": )(-?\d+)(?=[,\n])/g,
    '$1$2.0',
  );
}

/**
 * Slice every page of a chapter dir, stitching panels that straddle page boundaries.
 * Returns manifest list. Cached per chapter; the cache is validated by the
 * `manifest.meta.json` sidecar (`slicer_rev` + `pages_hash`).
 */
export async function sliceChapter(
  chdir: string,
  outRoot: string,
  _minArea = 0,
): Promise<Manifest> {
  const cleanChdir = chdir.replace(/\/+$/, '') || chdir;
  const ch = basename(cleanChdir);
  const pdir = join(outRoot, 'panels', ch);
  const manPath = join(pdir, 'manifest.json');
  const metaPath = join(pdir, 'manifest.meta.json');
  const phash = _pagesHash(chdir);

  if (existsSync(manPath)) {
    let meta: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      meta = null;
    }
    const rev = meta ? meta['slicer_rev'] : null;
    if (rev === SLICER_REV && meta?.['pages_hash'] === phash) {
      return JSON.parse(readFileSync(manPath, 'utf8')) as Manifest;
    }
    const why =
      rev === null || rev === undefined
        ? 'missing sidecar'
        : rev !== SLICER_REV
          ? `slicer_rev ${String(rev)} != ${SLICER_REV}`
          : 'source pages changed';
    console.log(`slicer: ${ch}: stale manifest (${why}) -> re-slicing`);
    for (const f of readdirSync(pdir)) {
      if (f.endsWith('.jpg')) {
        rmSync(join(pdir, f), { force: true });
      }
    }
    rmSync(manPath, { force: true });
    if (existsSync(metaPath)) {
      rmSync(metaPath, { force: true });
    }
  }

  mkdirSync(pdir, { recursive: true });
  const files = pySorted(readdirSync(chdir)).filter((f) => {
    const stem = f.split('.')[0] ?? '';
    return /^\d+$/.test(stem);
  });

  interface PageEntry {
    pid: number;
    file: string;
    im: RgbImage;
    arr: GrayImage;
    segs: Span[];
  }

  const perPage: PageEntry[] = [];
  for (const f of files) {
    const pid = Number.parseInt(f.split('.')[0]!, 10);
    const im = await loadRgbImage(join(chdir, f));
    const arr = rgbToGray(im);
    perPage.push({ pid, file: f, im, arr, segs: segments(arr) });
  }

  const manifest: ManifestRec[] = [];

  const emit = async (
    pid: number,
    im: RgbImage,
    k: number,
    y0: number,
    y1: number,
    pageSpan?: [number, number],
  ): Promise<void> => {
    const crop = cropRgbRows(im, y0, y1);
    const name = `p${String(pid).padStart(4, '0')}_${k}.jpg`;
    await saveJpeg(crop, join(pdir, name));
    const [at, ab] = artBounds(rgbToGray(crop));
    const rec: ManifestRec = {
      panel: `${ch}/${name}`,
      page: pid,
      idx: k,
      w: im.width,
      h: y1 - y0,
      art_top: at,
      art_bottom: ab,
    };
    if (pageSpan) {
      rec.page_span = pageSpan;
    }
    manifest.push(rec);
  };

  let i = 0;
  let fused = 0;
  let resplit = 0;
  let welds = 0;
  const weldReject: Record<string, number> = {};

  while (i < perPage.length) {
    const cur = perPage[i]!;
    const { pid, im, arr, segs } = cur;
    let straddle = false;

    if (
      i + 1 < perPage.length &&
      segs.length > 0 &&
      segs[segs.length - 1]![1] >= im.height - 2 &&
      edgeContent(arr, segs[segs.length - 1]![0], segs[segs.length - 1]![1], 'bottom')
    ) {
      const nxt = perPage[i + 1]!;
      if (
        nxt.segs.length > 0 &&
        nxt.segs[0]![0] <= 2 &&
        edgeContent(nxt.arr, nxt.segs[0]![0], nxt.segs[0]![1], 'top') &&
        boundaryContinuous(arr, nxt.arr)
      ) {
        straddle = true;
      }
      if (straddle) {
        const lastSeg = segs[segs.length - 1]!;
        const firstNext = nxt.segs[0]!;
        const [sound, reason] = weldIsSound(
          arr,
          lastSeg[0],
          lastSeg[1],
          nxt.arr,
          firstNext[0],
          firstNext[1],
        );
        if (!sound && reason !== null) {
          weldReject[reason] = (weldReject[reason] ?? 0) + 1;
          straddle = false;
        }
      }
    }

    const keep = straddle ? segs.slice(0, -1) : segs;
    const ranges: Span[] = [];
    let reseg: Span[] | null = null;
    for (const [y0, y1] of keep) {
      if (RESLICE_FUSED) {
        const cropGray = sliceGrayRows(arr, y0, y1);
        if (interiorFused(cropGray)) {
          fused += 1;
          if (reseg === null) {
            reseg = segments(arr);
          }
          const pieces = reseg.filter((s) => s[0] >= y0 && s[1] <= y1);
          if (_covers(pieces, y0, y1)) {
            resplit += 1;
            ranges.push(...pieces);
            continue;
          }
        }
      }
      ranges.push([y0, y1]);
    }

    for (let k = 0; k < ranges.length; k++) {
      const [y0, y1] = ranges[k]!;
      await emit(pid, im, k + 1, y0, y1);
    }

    if (straddle) {
      const nxt = perPage[i + 1]!;
      const nsegs = nxt.segs;
      const [y0a, y1a] = segs[segs.length - 1]!;
      const [y0b, y1b] = nsegs[0]!;
      const h1 = y1a - y0a;
      const h2 = y1b - y0b;
      const stitchedData = new Uint8Array(im.width * (h1 + h2) * 3);
      const cropA = cropRgbRows(im, y0a, y1a);
      const cropB = cropRgbRows(nxt.im, y0b, y1b);
      stitchedData.set(cropA.data, 0);
      if (nxt.im.width === im.width) {
        stitchedData.set(cropB.data, h1 * im.width * 3);
      } else {
        const copyW = Math.min(im.width, nxt.im.width);
        for (let r = 0; r < h2; r++) {
          const srcOff = r * nxt.im.width * 3;
          const dstOff = (h1 + r) * im.width * 3;
          stitchedData.set(cropB.data.subarray(srcOff, srcOff + copyW * 3), dstOff);
        }
      }
      const stitched: RgbImage = { data: stitchedData, width: im.width, height: h1 + h2 };
      const idx = ranges.length + 1;
      const name = `p${String(pid).padStart(4, '0')}_${idx}.jpg`;
      await saveJpeg(stitched, join(pdir, name));
      const [at, ab] = artBounds(rgbToGray(stitched));
      manifest.push({
        panel: `${ch}/${name}`,
        page: pid,
        idx,
        w: im.width,
        h: h1 + h2,
        art_top: at,
        art_bottom: ab,
        page_span: [pid, nxt.pid],
        stitched_with: nxt.pid,
      });
      welds += 1;
      perPage[i + 1] = {
        pid: nxt.pid,
        file: nxt.file,
        im: nxt.im,
        arr: nxt.arr,
        segs: nsegs.slice(1),
      };
    }

    i += 1;
  }

  LAST_STATS.fused_panels = fused;
  LAST_STATS.resplit_panels = resplit;
  LAST_STATS.welds = welds;
  LAST_STATS.weld_rejected = { ...weldReject };

  writeFileSync(manPath, dumpJsonIndent1(manifest), 'utf8');
  writeFileSync(
    metaPath,
    dumpJsonIndent1({ slicer_rev: SLICER_REV, pages_hash: phash }),
    'utf8',
  );
  return manifest;
}

export { pyJsonDumps };
