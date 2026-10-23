/**
 * framing.ts - TypeScript port of manhwa-pipeline/pipeline/framing.py.
 *
 * Render-only art crops. Original panels/observations remain writer context.
 * Use the reader's existing interest box, not dialogue extent, as the shot
 * target. A subject cut at a page seam may borrow ONE verified, dialogue-free
 * continuation. No new vision/TTS calls and no changes to panel IDs in
 * reader/writer caches.
 *
 * PARITY NOTES (Python/PIL -> sharp)
 *  - sharp's JPEG decode is byte-identical to PIL's `convert('RGB')` for the
 *    RGB JPEG panels the pipeline stores (verified on 25 random corpus panels).
 *  - PIL's `convert('L')` is NOT the same as sharp's `greyscale()`: it is the
 *    integer `L24` luma below. Grayscale is computed here from the RGB buffer so
 *    `boundaryContinuous` / `weldIsSound` see PIL's exact bytes.
 *  - PIL's `thumbnail((180, 900))` on an already-decoded RGB image never uses
 *    libjpeg shrink-on-load (draft() is a no-op on a converted image). It is
 *    reproduced exactly: integer box `reduce()` (PIL Reduce.c, 8-bit, 2^22
 *    coefficient precision) then a two-pass bicubic `resize()` (PIL Resample.c).
 *    sharp's own resampler differs by LSBs, which would flip white-mask pixels.
 *  - PIL `MaxFilter(5)` is a 5x5 max with replicate borders; implemented as an
 *    OR of the white mask over the clamped window.
 *  - `Image.crop()` and `paste()` are plain byte copies.
 *
 * Async: sharp decodes asynchronously, so `frameShots` returns a Promise.
 */
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import {normBox, type NormBox} from "../contracts/schemas.js";
import {detectBubbleBoxes, type BubbleBox} from "./cleaner.js";

// ---------------------------------------------------------------------------
// Python-compatible primitives
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python truthiness: None/False/0/""/[]/{} are false. NaN is true. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python isinstance(v, int): booleans ARE ints, floats are not. */
function pyIsInt(v: unknown): boolean {
  return typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v));
}

/** Python int(v) for a value pyIsInt accepted. */
function pyInt(v: unknown): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : (v as number);
}

/** Python ==, but only for the int comparisons this module makes (True == 1). */
function pyEqInt(a: unknown, b: number): boolean {
  if (typeof a === "boolean") return (a ? 1 : 0) === b;
  return a === b;
}

/** PurePath.name: the final component, "" for a root or empty path. */
function pyName(p: string): string {
  let s = p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/** PurePath.stem: final component minus its last suffix (dotfile rules). */
export function pyStem(p: string): string {
  const name = pyName(p);
  const i = name.lastIndexOf(".");
  if (i !== -1) {
    const stem = name.slice(0, i);
    if (stem.replace(/^\.+/, "") !== "") return stem;
  }
  return name;
}

// ---------------------------------------------------------------------------
// RGB buffers
// ---------------------------------------------------------------------------

/** Tightly packed interleaved RGB, row-major. Same bytes as numpy asarray(RGB). */
export interface Rgb {
  w: number;
  h: number;
  data: Uint8Array;
}

function decodeRawToRgb(data: Uint8Array, w: number, h: number, channels: number): Rgb {
  if (channels === 3) return {w, h, data};
  const out = new Uint8Array(w * h * 3);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (channels === 1 || channels === 2) {
      const g = data[i * channels];
      out[i * 3] = g;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = g;
    } else {
      out[i * 3] = data[i * channels];
      out[i * 3 + 1] = data[i * channels + 1];
      out[i * 3 + 2] = data[i * channels + 2];
    }
  }
  return {w, h, data: out};
}

/** Image.open(path).convert('RGB') */
export async function loadRgb(file: string): Promise<Rgb> {
  const {data, info} = await sharp(file, {limitInputPixels: false})
    .removeAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});
  return decodeRawToRgb(data, info.width, info.height, info.channels);
}

/** PIL rgb2l / L24: (r*19595 + g*38470 + b*7471 + 0x8000) >> 16, as float32. */
export function pilGray(img: Rgb): Float32Array {
  const out = new Float32Array(img.w * img.h);
  const src = img.data;
  for (let i = 0; i < out.length; i++) {
    out[i] =
      ((src[i * 3] * 19595 + src[i * 3 + 1] * 38470 + src[i * 3 + 2] * 7471 + 0x8000) >> 16) | 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// crop_window
// ---------------------------------------------------------------------------

export interface Size {
  w: number;
  h: number;
}

export type Rect = [number, number, number, number];

/**
 * Pad the main visual, then buy screen area without shrinking to a strip.
 * Padding is source-width bounded: a long stitched torso must not pull a
 * distant speech bubble back into the shot. Clipped edge padding is NOT
 * transferred onto the opposite edge. Expand, never cut the interest box.
 */
export function cropWindow(size: Size, box: NormBox): Rect {
  const w = size.w;
  const h = size.h;
  const x0 = box.x0 * w;
  const y0 = box.y0 * h;
  const x1 = box.x1 * w;
  const y1 = box.y1 * h;
  const px = Math.min((x1 - x0) * 0.12, w * 0.06);
  const py = Math.min((y1 - y0) * 0.12, w * 0.06);
  let left = Math.max(0, x0 - px);
  let top = Math.max(0, y0 - py);
  let right = Math.min(w, x1 + px);
  let bottom = Math.min(h, y1 + py);
  const cw = right - left;
  const ch = bottom - top;
  if (cw / ch < 1) {
    const extra = (Math.min(w, ch) - cw) / 2;
    left = Math.max(0, left - extra);
    right = Math.min(w, right + extra);
  } else if (cw / ch > 1.8) {
    const extra = (Math.min(h, cw / 1.8) - ch) / 2;
    top = Math.max(0, top - extra);
    bottom = Math.min(h, bottom + extra);
  }
  return [
    Math.floor(left),
    Math.floor(top),
    Math.min(w, Math.ceil(right)),
    Math.min(h, Math.ceil(bottom)),
  ];
}

// ---------------------------------------------------------------------------
// PIL thumbnail: integer reduce + two-pass bicubic resample
// ---------------------------------------------------------------------------

const PRECISION_BITS = 22;
const COEFF_ONE = 1 << PRECISION_BITS;

function bicubicFilter(x: number): number {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a;
  return 0.0;
}

interface Coeffs {
  ksize: number;
  bounds: Int32Array;
  k: Int32Array;
}

function precomputeCoeffs(
  inSize: number,
  in0: number,
  in1: number,
  outSize: number,
  support: number,
): Coeffs {
  // PIL passes `float box[4]` into the C kernel and computes
  // `(double)(in1 - in0) / outSize`, so the box difference is a float32
  // subtraction widened to double; the scale/center/support math follows.
  const f0 = Math.fround(in0);
  const f1 = Math.fround(in1);
  const scale = Math.fround(f1 - f0) / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const sup = support * filterscale;
  const ksize = Math.ceil(sup) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const k = new Int32Array(outSize * ksize);
  const pre = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = f0 + (xx + 0.5) * scale;
    let ww = 0.0;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - sup + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + sup + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const ko = xx * ksize;
    for (let x = 0; x < xmax; x++) {
      const wgt = bicubicFilter((x + xmin - center + 0.5) * ss);
      pre[ko + x] = wgt;
      ww += wgt;
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0.0) pre[ko + x] /= ww;
    }
    for (let x = 0; x < ksize; x++) {
      const v = pre[ko + x];
      k[ko + x] = v < 0 ? Math.trunc(-0.5 + v * COEFF_ONE) : Math.trunc(0.5 + v * COEFF_ONE);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return {ksize, bounds, k};
}

/** PIL clip8: the value is already offset by 2^21, so this rounds to nearest. */
function clip8(v: number): number {
  const i = Math.floor(v / COEFF_ONE);
  if (i <= 0) return 0;
  if (i >= 255) return 255;
  return i;
}

/** PIL Image.resize(size, BICUBIC, box) on the whole image. `box` is float. */
function pilResizeBoxed(src: Rgb, outW: number, outH: number, box: Rect): Rgb {
  const needH = outW !== src.w || box[0] !== 0 || box[2] !== outW;
  const needV = outH !== src.h || box[1] !== 0 || box[3] !== outH;
  if (!needH && !needV) return {w: outW, h: outH, data: src.data.slice()};
  const hc = precomputeCoeffs(src.w, box[0], box[2], outW, 2.0);
  const vc = precomputeCoeffs(src.h, box[1], box[3], outH, 2.0);
  let vertSrc = src;
  let vShift = 0;
  if (needH) {
    const yFirst = vc.bounds[0];
    const yLast = vc.bounds[(outH - 1) * 2] + vc.bounds[(outH - 1) * 2 + 1];
    const th = yLast - yFirst;
    const tmp = new Uint8Array(outW * th * 3);
    for (let yy = 0; yy < th; yy++) {
      const sy = yy + yFirst;
      for (let xx = 0; xx < outW; xx++) {
        const xmin = hc.bounds[xx * 2];
        const xmax = hc.bounds[xx * 2 + 1];
        const ko = xx * hc.ksize;
        for (let c = 0; c < 3; c++) {
          let ss = 1 << (PRECISION_BITS - 1);
          for (let x = 0; x < xmax; x++) {
            ss += src.data[(sy * src.w + xmin + x) * 3 + c] * hc.k[ko + x];
          }
          tmp[(yy * outW + xx) * 3 + c] = clip8(ss);
        }
      }
    }
    vertSrc = {w: outW, h: th, data: tmp};
    vShift = yFirst;
  }
  if (!needV) return vertSrc;
  const out = new Uint8Array(outW * outH * 3);
  for (let yy = 0; yy < outH; yy++) {
    const ymin = vc.bounds[yy * 2] - vShift;
    const ymax = vc.bounds[yy * 2 + 1];
    const ko = yy * vc.ksize;
    for (let xx = 0; xx < outW; xx++) {
      for (let c = 0; c < 3; c++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y++) {
          ss += vertSrc.data[((ymin + y) * outW + xx) * 3 + c] * vc.k[ko + y];
        }
        out[(yy * outW + xx) * 3 + c] = clip8(ss);
      }
    }
  }
  return {w: outW, h: outH, data: out};
}

/** PIL Image.reduce((fx, fy)) over the whole image (Reduce.c, 8-bit path). */
export function _pilReduce(src: Rgb, fx: number, fy: number): Rgb {
  const outW = Math.ceil(src.w / fx);
  const outH = Math.ceil(src.h / fy);
  const out = new Uint8Array(outW * outH * 3);
  const mult = Math.trunc(4294967296 / (256 * fx * fy));
  const amend = Math.trunc((fx * fy) / 2);
  for (let y = 0; y < outH; y++) {
    const y0 = y * fy;
    const ch = Math.min(fy, src.h - y0);
    for (let x = 0; x < outW; x++) {
      const x0 = x * fx;
      const cw = Math.min(fx, src.w - x0);
      // Partial edge tiles use the corner formula: floor(sum * mult / 2^24).
      const scale = cw * ch;
      const cmult = Math.trunc(4294967296 / (256 * scale));
      const camend = Math.trunc(scale / 2);
      const mult2 = scale === fx * fy ? mult : cmult;
      const amend2 = scale === fx * fy ? amend : camend;
      for (let c = 0; c < 3; c++) {
        let ss = amend2;
        for (let yy = y0; yy < y0 + ch; yy++) {
          for (let xx = x0; xx < x0 + cw; xx++) ss += src.data[(yy * src.w + xx) * 3 + c];
        }
        // UINT32 wraparound, then >> 24.
        out[(y * outW + x) * 3 + c] = Math.floor(((ss * mult2) % 4294967296) / 16777216);
      }
    }
  }
  return {w: outW, h: outH, data: out};
}

/** Python min/max with key: ties keep the first candidate. */
function roundAspect(number: number, key: (n: number) => number): number {
  const fl = Math.floor(number);
  const ce = Math.ceil(number);
  const mn = key(ce) < key(fl) ? ce : fl;
  return Math.max(mn, 1);
}

/** PIL Image.thumbnail((maxW, maxH)) with the default reducing_gap=2.0. */
export function _pilThumbnail(img: Rgb, maxW: number, maxH: number): Rgb {
  const px = Math.floor(maxW);
  const py = Math.floor(maxH);
  if (px >= img.w && py >= img.h) return img;
  const aspect = img.w / img.h;
  let fw = px;
  let fh = py;
  if (px / py >= aspect) {
    fw = roundAspect(py * aspect, (n) => Math.abs(aspect - n / py));
  } else {
    fh = roundAspect(px / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - px / n)));
  }
  const fx = Math.trunc(img.w / fw / 2.0) || 1;
  const fy = Math.trunc(img.h / fh / 2.0) || 1;
  let cur = img;
  let box: Rect = [0, 0, img.w, img.h];
  if (fx > 1 || fy > 1) {
    // PIL _get_safe_box: expand so resampling neighbours survive the reduce.
    const supX = 1.5 * (box[2] / fw);
    const supY = 1.5 * (box[3] / fh);
    const rb: Rect = [
      Math.max(0, Math.trunc(box[0] - supX)),
      Math.max(0, Math.trunc(box[1] - supY)),
      Math.min(img.w, Math.ceil(box[2] + supX)),
      Math.min(img.h, Math.ceil(box[3] + supY)),
    ];
    cur = _pilReduce(cur, fx, fy);
    box = [
      (box[0] - rb[0]) / fx,
      (box[1] - rb[1]) / fy,
      (box[2] - rb[0]) / fx,
      (box[3] - rb[1]) / fy,
    ];
  }
  if (cur.w !== fw || cur.h !== fh || box[0] !== 0 || box[1] !== 0 || box[2] !== fw || box[3] !== fh) {
    // PIL's extreme-aspect branch: taller than 100:1 is resized in two passes,
    // height first (with the vertical box) then width (with the horizontal box).
    if (cur.h > cur.w * 100 && fh < cur.h) {
      const s1 = pilResizeBoxed(cur, cur.w, fh, [0, box[1], cur.w, box[3]]);
      cur = pilResizeBoxed(s1, fw, fh, [box[0], 0, box[2], fh]);
    } else {
      cur = pilResizeBoxed(cur, fw, fh, box);
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// _trim_blank_padding
// ---------------------------------------------------------------------------

/**
 * Remove only uniform white/black padding OUTSIDE the reader's main visual.
 * `row > 242` / `row < 12` are per-pixel all-channel tests.
 */
export function _trimBlankPadding(img: Rgb, rect: Rect, box: NormBox): Rect {
  let [left, top, right, bottom] = rect;
  left = Math.max(0, Math.min(img.w, left));
  top = Math.max(0, Math.min(img.h, top));
  right = Math.max(0, Math.min(img.w, right));
  bottom = Math.max(0, Math.min(img.h, bottom));
  const protectedTop = Math.floor(box.y0 * img.h);
  const protectedBottom = Math.ceil(box.y1 * img.h);
  const width = right - left;
  const blank = (row: number): boolean => {
    if (width <= 0) return false;
    if (row < 0 || row >= img.h) return false;
    let white = 0;
    let black = 0;
    for (let x = left; x < right; x++) {
      const i = (row * img.w + x) * 3;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (r > 242 && g > 242 && b > 242) white++;
      if (r < 12 && g < 12 && b < 12) black++;
    }
    return white / width > 0.96 || black / width > 0.98;
  };
  while (top < protectedTop && blank(top)) top += 1;
  while (bottom > protectedBottom && blank(bottom - 1)) bottom -= 1;
  return [left, top, right, bottom];
}

// ---------------------------------------------------------------------------
// _focus
// ---------------------------------------------------------------------------

/** bool, non-number, NaN and inf are rejected; otherwise clamped to 0..1. */
export function _focus(value: unknown, defaultVal: number): number {
  if (typeof value === "boolean") return defaultVal;
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(0.0, Math.min(1.0, value));
}

// ---------------------------------------------------------------------------
// _speech_edges
// ---------------------------------------------------------------------------

/** 5x5 max (PIL MaxFilter) as an OR over the replicate-clamped window. */
export function dilateOr(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          if (mask[yy * w + xx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/** Neutral-white mask: min channel > 220 AND channel spread < 42. */
export function _whiteMask(small: Rgb): Uint8Array {
  const n = small.w * small.h;
  const white = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = small.data[i * 3];
    const g = small.data[i * 3 + 1];
    const b = small.data[i * 3 + 2];
    const mn = Math.min(r, Math.min(g, b));
    const mx = Math.max(r, Math.max(g, b));
    white[i] = mn > 220 && mx - mn < 42 ? 1 : 0;
  }
  return white;
}

/** Per-row band: the dilated mask covers more than 38% of the row. */
export function _rowBand(mask: Uint8Array, w: number, h: number): Uint8Array {
  const rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += mask[y * w + x];
    rows[y] = n / w > 0.38 ? 1 : 0;
  }
  return rows;
}

/**
 * Exclude large neutral-white EDGE bubbles, only where the reader says one is.
 * This is framing, not inpainting: world/system text stays on the retained art.
 * Center/overlapping bubbles are not guessed away.
 */
export function _speechEdges(img: Rgb, location: unknown): [number, number] {
  if (location !== "top" && location !== "bottom") return [0, img.h];
  const small = _pilThumbnail(img, 180, 900);
  const sw = small.w;
  const sh = small.h;
  const white = _whiteMask(small);
  // Close lettering holes inside the white bubble before measuring its band.
  const mask = dilateOr(white, sw, sh, 2);
  const rows = _rowBand(mask, sw, sh);
  const hits: number[] = [];
  if (location === "bottom") {
    for (let y = sh - 1; y >= 0; y--) if (rows[y]) hits.push(sh - 1 - y);
  } else {
    for (let y = 0; y < sh; y++) if (rows[y]) hits.push(y);
  }
  if (hits.length === 0 || hits[0] > 0.08 * sh) return [0, img.h];
  let last = hits[0];
  const gap = Math.max(2, Math.trunc(0.025 * sh));
  for (let i = 1; i < hits.length; i++) {
    if (hits[i] - last > gap) break;
    last = hits[i];
  }
  // A white background is not a bubble: don't erase half of the image.
  if (last < 0.03 * sh || last > 0.5 * sh) return [0, img.h];
  const extent = Math.ceil(((last + 1) / sh) * img.h) + Math.ceil(img.w * 0.008);
  return location === "top" ? [extent, img.h] : [0, img.h - extent];
}

// ---------------------------------------------------------------------------
// slicer helpers (ported from slicer.py; slicer.ts re-uses these)
// ---------------------------------------------------------------------------

const WHITE_THR = 235;
const WHITE_SPLIT_WIDTH_FRAC = 0.92;
const WELD_BAND_PX = 100;
const WELD_BAND_FRAC = 0.06;
const WELD_STEP = 25;
const WELD_STEP_WINDOW = 60;

/** slicer.near_white_rows: rowmean > 235 AND >92% of the row above 235. */
function nearWhiteRows(gray: Float32Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    let n = 0;
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const v = gray[off + x];
      sum += v;
      if (v > WHITE_THR) n++;
    }
    // numpy: the float32 row mean is correctly rounded; keep that rounding.
    out[y] = Math.fround(sum / w) > WHITE_THR && n / w > WHITE_SPLIT_WIDTH_FRAC ? 1 : 0;
  }
  return out;
}

/** Longest INTERIOR near-white run in the joined weld panel, in px. */
function weldBandPx(white: Uint8Array, h: number): number {
  let band = 0;
  let i = 0;
  while (i < h) {
    if (!white[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < h && white[j]) j++;
    // Interior: touching neither the first nor the last row.
    if (i >= 1 && j <= h - 1) band = Math.max(band, j - i);
    i = j;
  }
  return band;
}

/**
 * Bottom rows of page N vs top rows of page N+1: a panel cut mid-way has nearly
 * identical pixels across the boundary; two separate flush panels do not.
 */
export function boundaryContinuous(a: Float32Array, b: Float32Array, w: number, ha: number, hb: number): boolean {
  const na = Math.min(3, ha);
  const nb = Math.min(3, hb);
  if (na === 0 || nb === 0) return false;
  let total = 0;
  for (let x = 0; x < w; x++) {
    let sa = 0;
    for (let y = 0; y < na; y++) sa += a[(ha - na + y) * w + x];
    let sb = 0;
    for (let y = 0; y < nb; y++) sb += b[y * w + x];
    total += Math.abs(sa / na - sb / nb);
  }
  return total / w < 28;
}

/**
 * True when joining these two segments would produce one panel rather than a
 * fused pair. Returns [sound, reason] with reason in (null, "band", "step",
 * "both").
 */
export function weldIsSound(
  a: Float32Array,
  y0a: number,
  y1a: number,
  b: Float32Array,
  y0b: number,
  y1b: number,
  w: number,
): [boolean, string | null] {
  const h1 = y1a - y0a;
  const h2 = y1b - y0b;
  const h = h1 + h2;
  const joined = new Float32Array(h * w);
  for (let y = 0; y < h1; y++) {
    joined.set(a.subarray((y0a + y) * w, (y0a + y) * w + w), y * w);
  }
  for (let y = 0; y < h2; y++) {
    joined.set(b.subarray((y0b + y) * w, (y0b + y) * w + w), (h1 + y) * w);
  }
  const white = nearWhiteRows(joined, w, h);
  const band = weldBandPx(white, h);
  const lim = Math.max(WELD_BAND_PX, Math.trunc(WELD_BAND_FRAC * h));
  const hasBand = band >= lim;
  const upStart = Math.max(0, h1 - WELD_STEP_WINDOW);
  const dnEnd = Math.min(h, h1 + WELD_STEP_WINDOW);
  let step = 0.0;
  if (upStart < h1 && h1 < dnEnd) {
    let su = 0;
    for (let i = upStart * w; i < h1 * w; i++) su += joined[i];
    let sd = 0;
    for (let i = h1 * w; i < dnEnd * w; i++) sd += joined[i];
    step = Math.abs(su / ((h1 - upStart) * w) - sd / ((dnEnd - h1) * w));
  }
  const hasStep = step > WELD_STEP;
  if (hasBand && hasStep) return [false, "both"];
  if (hasBand) return [false, "band"];
  if (hasStep) return [false, "step"];
  return [true, null];
}

// ---------------------------------------------------------------------------
// _continuation
// ---------------------------------------------------------------------------

interface Donor {
  nextId: string;
  other: Rgb;
  nb: NormBox;
}

function pyGet(rec: Rec, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : fallback;
}

/**
 * Only join a main visual touching the bottom into the very next source page.
 * PROMO DONOR GUARD (runs BEFORE the donor image is opened/borrowed): a
 * continuation donor must be a reader-CONFIRMED ordinary story panel. Any full
 * page (promo_page True), any UNKNOWN page (promo_page absent/None - the reader
 * did not vouch for it), or any advisory promo region forbids borrowing, so no
 * unverified promo/credit pixels can enter the composite. Only an explicit
 * promo_page is False with no advisory regions qualifies.
 */
export async function _continuation(
  pid: string,
  box: NormBox,
  img: Rgb,
  records: Map<string, [Rec, Rec | null]>,
  byId: Map<string, Rec>,
  panelsDir: string,
  selected: Set<string>,
): Promise<Donor | null> {
  if (box.y1 < 0.96 || !records.has(pid)) return null;
  const [rec, nxt] = records.get(pid)!;
  if (!nxt) return null;
  const nextId = pyStem(String(nxt["panel"]));
  const span = pyTruthy(rec["page_span"]) ? (rec["page_span"] as unknown[]) : [rec["page"]];
  const lastPage = span[span.length - 1];
  const pg = byId.get(nextId) ?? {};
  const nb = normBox(pg["box"]);
  if (
    !pyIsInt(lastPage) ||
    !pyEqInt(nxt["page"], pyInt(lastPage) + 1) ||
    !pyEqInt(nxt["idx"], 1) ||
    selected.has(nextId) ||
    pyTruthy(pg["overlay"]) ||
    pyTruthy(pg["world"]) ||
    Number(pg["art"] ?? 0) < 0.7 ||
    pg["promo_page"] !== false ||
    pyTruthy(pg["promo_regions"]) ||
    !nb ||
    nb.y0 > 0.08
  ) {
    return null;
  }
  const file = path.join(panelsDir, nextId + ".jpg");
  if (!existsSync(file)) return null;
  const other = await loadRgb(file);
  if (other.w !== img.w) return null;
  const w = img.w;
  const ha = img.h;
  const hb = other.h;
  // White/black gutters and lookalike brightness with different colors are not joins.
  const eRows = Math.min(8, ha);
  let eSum = 0;
  let eSum2 = 0;
  let eN = 0;
  for (let y = ha - eRows; y < ha; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      eSum += v;
      eSum2 += v * v;
      eN++;
    }
  }
  const eMean = eSum / eN;
  const eStd = Math.sqrt(Math.max(0, eSum2 / eN - eMean * eMean));
  if (!(eMean > 25 && eMean < 235) || !(eStd >= 4)) return null;
  const tailRows = Math.min(3, ha);
  const headRows = Math.min(3, hb);
  let colorDiff = 0;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sa = 0;
      for (let y = 0; y < tailRows; y++) sa += img.data[(ha - tailRows + y) * w * 3 + x * 3 + c];
      let sb = 0;
      for (let y = 0; y < headRows; y++) sb += other.data[y * w * 3 + x * 3 + c];
      colorDiff += Math.abs(sa / tailRows - sb / headRows);
    }
  }
  colorDiff /= w * 3;
  if (colorDiff >= 24) return null;
  const ag = pilGray(img);
  const bg = pilGray(other);
  const start = Math.trunc(box.y0 * ha);
  if (!boundaryContinuous(ag, bg, w, ha, hb)) return null;
  if (!weldIsSound(ag, start, ha, bg, 0, hb, w)[0]) return null;
  return {nextId, other, nb};
}

// ---------------------------------------------------------------------------
// bubble boxes: CTD detector -> white-blob heuristic -> reader bubble_at
// ---------------------------------------------------------------------------

/** Pixel rect [x0, y0, x1, y1] of one speech bubble (or text block) in the image. */
export type BubbleRect = [number, number, number, number];

export type BubbleSource = "ctd" | "heuristic" | "bubble_at" | "none";

export interface BubbleSet {
  source: BubbleSource;
  rects: BubbleRect[];
}

/**
 * CTD returns TEXT blocks; the balloon outline sits a margin outside them.
 * Grow each block by a fraction of its short side and of the strip width.
 */
export function _bubbleFromText(b: BubbleBox, w: number, h: number): BubbleRect {
  const [x0, y0, x1, y1] = b;
  const m = Math.max(0.03 * w, 0.3 * Math.min(x1 - x0, y1 - y0));
  return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(w, x1 + m), Math.min(h, y1 + m)];
}

/**
 * Deterministic fallback: near-white connected blobs of bubble size that hold
 * dark lettering. White backgrounds/gutters (spanning the strip width) and
 * blank fields (no dark strokes) are rejected. Returns source-pixel rects.
 */
export function _heuristicBubbles(img: Rgb): BubbleRect[] {
  const small = _pilThumbnail(img, 240, 2400);
  const sw = small.w;
  const sh = small.h;
  const white = _whiteMask(small);
  const label = new Int32Array(sw * sh).fill(-1);
  const out: BubbleRect[] = [];
  const stack: number[] = [];
  const scaleX = img.w / sw;
  const scaleY = img.h / sh;
  const minArea = 0.01 * sw * sw;
  const maxArea = 0.6 * sw * sw;
  let next = 0;
  for (let start = 0; start < sw * sh; start++) {
    if (!white[start] || label[start] !== -1) continue;
    const id = next++;
    label[start] = id;
    stack.push(start);
    let count = 0;
    let minX = sw;
    let minY = sh;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const p = stack.pop()!;
      count++;
      const x = p % sw;
      const y = (p - x) / sw;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && white[p - 1] && label[p - 1] === -1) (label[p - 1] = id), stack.push(p - 1);
      if (x < sw - 1 && white[p + 1] && label[p + 1] === -1) (label[p + 1] = id), stack.push(p + 1);
      if (y > 0 && white[p - sw] && label[p - sw] === -1) (label[p - sw] = id), stack.push(p - sw);
      if (y < sh - 1 && white[p + sw] && label[p + sw] === -1) (label[p + sw] = id), stack.push(p + sw);
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const area = bw * bh;
    if (count < 0.4 * minArea || area < minArea || area > maxArea) continue;
    if (bw > 0.92 * sw || (minX === 0 && maxX === sw - 1)) continue;
    if (count / area < 0.45) continue;
    let dark = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = (y * sw + x) * 3;
        const l = (small.data[i] * 299 + small.data[i + 1] * 587 + small.data[i + 2] * 114) / 1000;
        if (l < 110 && label[y * sw + x] !== id) dark++;
      }
    }
    const df = dark / area;
    if (df < 0.004 || df > 0.35) continue;
    out.push([
      Math.max(0, Math.floor(minX * scaleX)),
      Math.max(0, Math.floor(minY * scaleY)),
      Math.min(img.w, Math.ceil((maxX + 1) * scaleX)),
      Math.min(img.h, Math.ceil((maxY + 1) * scaleY)),
    ]);
  }
  return out;
}

/** Reader-only fallback: an edge band from the existing white-mask scan. */
export function _bubbleAtRects(img: Rgb, location: unknown): BubbleRect[] {
  const [top, bottom] = _speechEdges(img, location);
  if (top > 0) return [[0, 0, img.w, top]];
  if (bottom < img.h) return [[0, bottom, img.w, img.h]];
  return [];
}

/**
 * Pick the bubble set for one panel. `ctd` is the detector result for this
 * image: an array (possibly empty) is trusted, null means unavailable.
 * Never throws: a failing stage drops to the next one.
 */
export function bubbleSet(img: Rgb, ctd: BubbleBox[] | null | undefined, bubbleAt: unknown): BubbleSet {
  if (Array.isArray(ctd)) {
    const rects = ctd.map((b) => _bubbleFromText(b, img.w, img.h));
    if (rects.length) return {source: "ctd", rects};
    // CTD saw no lettering, but the reader placed an edge bubble: trust a
    // white-mask band there (lettering CTD misses, e.g. huge display type).
    try {
      const band = _bubbleAtRects(img, bubbleAt);
      if (band.length) return {source: "bubble_at", rects: band};
    } catch {
      // keep the empty CTD answer
    }
    return {source: "ctd", rects: []};
  }
  try {
    const rects = _heuristicBubbles(img);
    if (rects.length) return {source: "heuristic", rects};
  } catch {
    // fall through to the reader's hint
  }
  try {
    const rects = _bubbleAtRects(img, bubbleAt);
    if (rects.length) return {source: "bubble_at", rects};
  } catch {
    // no bubble information at all
  }
  return {source: "none", rects: []};
}

// ---------------------------------------------------------------------------
// window picker (recap-channel framing)
// ---------------------------------------------------------------------------

/** "window": full-width sliding window (default). "fit": legacy cropWindow. */
export type FramingMode = "window" | "fit";
export const DEFAULT_FRAMING_MODE: FramingMode = "window";
/** Window aspect (w/h) bounds: tall full-body strip .. wide close-up. */
export const WINDOW_MIN_ASPECT = 0.42;
export const WINDOW_MAX_ASPECT = 1.9;
/** Context padding per side, as a fraction of the subject height, by weight. */
export const WINDOW_PAD: Record<number, number> = {1: 0.1, 2: 0.16, 3: 0.28};

export function framingMode(): FramingMode {
  const v = (process.env.MANHWA_FRAMING_MODE || "").toLowerCase();
  return v === "fit" ? "fit" : v === "window" ? "window" : DEFAULT_FRAMING_MODE;
}

/**
 * A reader box often swallows the bubble at its top or bottom. Cut the box
 * back to the bubble's far edge when the bubble sits in that end of the box,
 * keeping at least 55% of the original subject height.
 */
export function _trimSubject(box: Rect, bubbles: readonly BubbleRect[]): Rect {
  let [x0, y0, x1, y1] = box;
  const h0 = y1 - y0;
  const sorted = [...bubbles].sort((a, b) => a[1] - b[1]);
  for (const b of sorted) {
    const ix = Math.min(x1, b[2]) - Math.max(x0, b[0]);
    if (ix <= 0 || b[3] <= y0 || b[1] >= y1) continue;
    const cy = (b[1] + b[3]) / 2;
    if (cy < y0 + 0.35 * (y1 - y0) && y1 - b[3] >= 0.55 * h0) y0 = Math.max(y0, b[3]);
  }
  for (const b of sorted.reverse()) {
    const ix = Math.min(x1, b[2]) - Math.max(x0, b[0]);
    if (ix <= 0 || b[3] <= y0 || b[1] >= y1) continue;
    const cy = (b[1] + b[3]) / 2;
    if (cy > y1 - 0.35 * (y1 - y0) && b[1] - y0 >= 0.55 * h0) y1 = Math.min(y1, b[1]);
  }
  return [x0, y0, x1, y1];
}

export interface WindowInput {
  w: number;
  h: number;
  /** Subject rect in pixels. */
  subject: Rect;
  bubbles: readonly BubbleRect[];
  weight?: number;
  /** Anchor row (pixels) used when the subject is taller than the window. */
  focusY?: number;
}

/**
 * Choose a full-width window [0, top, w, bottom].
 * Height = subject height + weight-scaled context, bounded by the aspect
 * limits and the image. Candidate windows (several heights from the
 * tight fit up to the target, every vertical offset that keeps the subject
 * inside) are scored on bubble pixels inside, then subject centring, then
 * lost context. A subject taller than the tallest window keeps focusY inside.
 */
export function pickWindow(inp: WindowInput): Rect {
  const {w, h, bubbles} = inp;
  const [, sy0r, , sy1r] = inp.subject;
  const sy0 = Math.max(0, Math.min(h, sy0r));
  const sy1 = Math.max(sy0 + 1, Math.min(h, sy1r));
  const subjH = sy1 - sy0;
  const pad = WINDOW_PAD[Math.round(inp.weight ?? 2)] ?? WINDOW_PAD[2]!;
  const minH = Math.min(h, Math.ceil(w / WINDOW_MAX_ASPECT));
  const maxH = Math.min(h, Math.floor(w / WINDOW_MIN_ASPECT));
  const clampH = (v: number) => Math.max(minH, Math.min(maxH, Math.round(v)));
  const target = clampH(subjH * (1 + 2 * pad) + 0.04 * w);
  const tight = clampH(subjH * (1 + 2 * Math.min(0.05, pad)));
  // Bubble coverage per row (summed widths, capped at the strip width).
  const rows = new Float64Array(h);
  for (const b of bubbles) {
    const bx = Math.max(0, Math.min(w, b[2]) - Math.max(0, b[0]));
    if (bx <= 0) continue;
    for (let y = Math.max(0, Math.floor(b[1])); y < Math.min(h, Math.ceil(b[3])); y++) rows[y] += bx;
  }
  const pre = new Float64Array(h + 1);
  for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + Math.min(w, rows[y]);
  const anchor = subjH > maxH && inp.focusY !== undefined ? inp.focusY : (sy0 + sy1) / 2;
  const heights = new Set<number>();
  const steps = 8;
  for (let i = 0; i <= steps; i++) heights.add(Math.round(tight + ((target - tight) * i) / steps));
  let best: [number, number] = [Math.max(0, Math.min(h - target, Math.round(anchor - target / 2))), target];
  let bestScore = Infinity;
  for (const wh of heights) {
    let lo: number;
    let hi: number;
    if (wh >= subjH) {
      lo = Math.max(0, sy1 - wh);
      hi = Math.min(h - wh, sy0);
    } else {
      // Subject does not fit: stay within it and keep the anchor inside.
      lo = Math.max(sy0, Math.ceil(anchor - wh * 0.85));
      hi = Math.min(sy1 - wh, Math.floor(anchor - wh * 0.15));
      if (lo > hi) {
        lo = sy0;
        hi = Math.max(sy0, sy1 - wh);
      }
      lo = Math.max(0, Math.min(h - wh, lo));
      hi = Math.max(lo, Math.min(h - wh, hi));
    }
    if (lo > hi) continue;
    const step = Math.max(1, Math.floor((hi - lo) / 160));
    for (let t = lo; ; t = Math.min(hi, t + step)) {
      const bubble = (pre[t + wh] - pre[t]) / (w * wh);
      const centre = Math.abs(t + wh / 2 - anchor) / wh;
      const lost = 1 - wh / target;
      const score = 4 * bubble + 0.5 * centre + 0.6 * lost;
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = [t, wh];
      }
      if (t >= hi) break;
    }
  }
  const [top, wh] = best;
  return [0, Math.max(0, top), w, Math.min(h, top + wh)];
}

/** Trim uniform white/black side columns outside the subject, at most 12% per side. */
export function _trimBlankColumns(img: Rgb, rect: Rect, subject: Rect): Rect {
  let [left, top, right, bottom] = rect;
  const height = bottom - top;
  if (height <= 0) return rect;
  const blank = (col: number): boolean => {
    let white = 0;
    let black = 0;
    for (let y = top; y < bottom; y++) {
      const i = (y * img.w + col) * 3;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (r > 242 && g > 242 && b > 242) white++;
      if (r < 12 && g < 12 && b < 12) black++;
    }
    return white / height > 0.97 || black / height > 0.98;
  };
  const maxCut = Math.floor(0.12 * img.w);
  const leftLimit = Math.min(Math.floor(subject[0]), left + maxCut);
  const rightLimit = Math.max(Math.ceil(subject[2]), right - maxCut);
  while (left < leftLimit && blank(left)) left++;
  while (right > rightLimit && blank(right - 1)) right--;
  return [left, top, right, bottom];
}

// ---------------------------------------------------------------------------
// frame_shots
// ---------------------------------------------------------------------------

export interface FramingStats {
  cropped: number;
  continued: number;
  unchanged: number;
  /** Window mode: how many framed panels got bubbles from each source. */
  bubbles?: Partial<Record<BubbleSource, number>>;
}

export interface FrameOptions {
  /** Default: MANHWA_FRAMING_MODE, else DEFAULT_FRAMING_MODE. */
  mode?: FramingMode;
  /** On-disk cache for detector boxes. Default: <cropsDir>/.bubbles */
  bubbleCacheDir?: string;
  /** Detector override (tests). Default: cleaner.detectBubbleBoxes (CTD). */
  detect?: (images: readonly string[], cacheDir: string) => Promise<Record<string, BubbleBox[] | null>>;
}

export type FrameShot = Rec;

export interface FrameObs {
  panels?: unknown;
}

function pyGetOr(rec: Rec, key: string, fallback: unknown): unknown {
  const v = pyGet(rec, key, undefined);
  return pyTruthy(v) ? v : fallback;
}

function clamp01(v: number): number {
  return Math.max(0.0, Math.min(1.0, v));
}

/**
 * Update video shots in place, leaving timing, narration and source files alone.
 * Called AFTER optional text cleaning and BEFORE staging assets for Remotion.
 * Missing/full-panel boxes keep their existing framing; never guess a face box.
 */
export async function frameShots(
  shots: FrameShot[],
  obs: FrameObs,
  panelsDir: string,
  cropsDir: string,
  opts: FrameOptions = {},
): Promise<FramingStats> {
  const byId = new Map<string, Rec>();
  const panels = Array.isArray(obs?.panels) ? obs.panels : [];
  for (const p of panels) {
    if (isRec(p) && typeof p["id"] === "string") byId.set(p["id"], p);
  }
  const selected = new Set<string>();
  for (const s of shots) {
    selected.add(pyStem(String(pyGet(s, "source_panel", s["panel"]) ?? "")));
  }
  let manifest: unknown = [];
  try {
    manifest = JSON.parse(readFileSync(path.join(panelsDir, "manifest.json"), "utf8"));
  } catch {
    manifest = [];
  }
  const records = new Map<string, [Rec, Rec | null]>();
  const recs = Array.isArray(manifest) ? manifest : [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!isRec(r) || typeof r["panel"] !== "string") continue;
    const nxt = i + 1 < recs.length && isRec(recs[i + 1]) ? recs[i + 1] : null;
    records.set(pyStem(r["panel"]), [r, nxt]);
  }
  const stats: FramingStats = {cropped: 0, continued: 0, unchanged: 0, bubbles: {}};
  const mode = opts.mode ?? framingMode();
  const sourceOf = (shot: Rec, pid: string): string =>
    pyGetOr(shot, "_src", path.join(panelsDir, pid + ".jpg")) as string;
  // One detector call for every image this chapter frames (cached per image hash).
  let ctd: Record<string, BubbleBox[] | null> = {};
  if (mode === "window") {
    const wanted: string[] = [];
    for (const shot of shots) {
      if (!isRec(shot) || pyTruthy(shot["framed"])) continue;
      const pid = pyStem(String(pyGet(shot, "source_panel", shot["panel"]) ?? ""));
      const pg = byId.get(pid) ?? {};
      if (!normBox(pyGet(shot, "box", pg["box"])) || Number(pg["art"] ?? 0) < 0.5) continue;
      const src = sourceOf(shot, pid);
      if (existsSync(src)) wanted.push(src);
    }
    try {
      ctd = await (opts.detect ?? detectBubbleBoxes)(wanted, opts.bubbleCacheDir ?? path.join(cropsDir, ".bubbles"));
    } catch {
      ctd = {};
    }
  }
  for (const shot of shots) {
    if (!isRec(shot)) continue;
    const pid = pyStem(String(pyGet(shot, "source_panel", shot["panel"]) ?? ""));
    const pg = byId.get(pid) ?? {};
    let box = normBox(pyGet(shot, "box", pg["box"]));
    const fullBox = !!box && (box.x1 - box.x0) * (box.y1 - box.y0) > 0.95;
    if (
      pyTruthy(shot["framed"]) ||
      !box ||
      Number(pg["art"] ?? 0) < 0.5 ||
      (mode === "fit" && fullBox)
    ) {
      stats.unchanged += 1;
      continue;
    }
    const source = sourceOf(shot, pid);
    let image = await loadRgb(source);
    const w = image.w;
    const originalH = image.h;
    let speechTop = 0;
    let speechBottom = originalH;
    let bubbles: BubbleRect[] = [];
    if (mode === "window") {
      const set = bubbleSet(image, ctd[source], pg["bubble_at"]);
      bubbles = set.rects;
      stats.bubbles![set.source] = (stats.bubbles![set.source] ?? 0) + 1;
      // A whole-panel subject that already fits the frame, with no bubble to
      // dodge, is shown as it is; a huge tall strip is still windowed.
      if (fullBox && originalH <= w / WINDOW_MIN_ASPECT && bubbles.length === 0) {
        stats.unchanged += 1;
        continue;
      }
      const [, ty0, , ty1] = _trimSubject([box.x0 * w, box.y0 * originalH, box.x1 * w, box.y1 * originalH], bubbles);
      box = {x0: box.x0, y0: ty0 / originalH, x1: box.x1, y1: ty1 / originalH};
    } else {
      [speechTop, speechBottom] = _speechEdges(image, pg["bubble_at"]);
      box = {
        x0: box.x0,
        y0: Math.max(box.y0, speechTop / originalH),
        x1: box.x1,
        y1: Math.min(box.y1, speechBottom / originalH),
      };
    }
    if (box.y1 <= box.y0) {
      stats.unchanged += 1;
      continue;
    }
    const fx = _focus(pyGet(shot, "focus_x", undefined), (box.x0 + box.x1) / 2) * w;
    const fy = _focus(pyGet(shot, "focus_y", pyGet(shot, "focusY", undefined)), (box.y0 + box.y1) / 2) * originalH;
    const sources = [pid];
    const continuation = await _continuation(pid, box, image, records, byId, panelsDir, selected);
    if (continuation) {
      const {nextId, other, nb} = continuation;
      const joined: Rgb = {w, h: originalH + other.h, data: new Uint8Array(w * (originalH + other.h) * 3)};
      joined.data.set(image.data, 0);
      joined.data.set(other.data, originalH * w * 3);
      box = {
        x0: Math.min(box.x0, nb.x0),
        x1: Math.max(box.x1, nb.x1),
        y0: (box.y0 * originalH) / joined.h,
        y1: (originalH + nb.y1 * other.h) / joined.h,
      };
      image = joined;
      sources.push(nextId);
      stats.continued += 1;
    }
    let rect: Rect;
    if (mode === "window") {
      const subjectPx: Rect = [box.x0 * image.w, box.y0 * image.h, box.x1 * image.w, box.y1 * image.h];
      rect = pickWindow({
        w: image.w,
        h: image.h,
        subject: subjectPx,
        bubbles,
        weight: Number(pyGet(shot, "weight", pg["weight"] ?? 2)),
        focusY: fy,
      });
      // Blank-trim may only eat rows of the window that lie outside the subject.
      const keep: NormBox = {
        x0: box.x0,
        x1: box.x1,
        y0: Math.max(box.y0, rect[1] / image.h),
        y1: Math.min(box.y1, rect[3] / image.h),
      };
      rect = _trimBlankPadding(image, rect, keep);
      rect = _trimBlankColumns(image, rect, subjectPx);
      if (rect[3] - rect[1] < 2 || rect[2] - rect[0] < 2) {
        stats.unchanged += 1;
        continue;
      }
    } else {
      rect = _trimBlankPadding(image, cropWindow({w: image.w, h: image.h}, box), box);
      if (!continuation) {
        rect = [rect[0], Math.max(rect[1], speechTop), rect[2], Math.min(rect[3], speechBottom)];
      }
    }
    const [left, top, right, bottom] = rect;
    const cropW = right - left;
    const cropH = bottom - top;
    const crop = new Uint8Array(cropW * cropH * 3);
    for (let y = 0; y < cropH; y++) {
      const srcStart = ((top + y) * image.w + left) * 3;
      crop.set(image.data.subarray(srcStart, srcStart + cropW * 3), y * cropW * 3);
    }
    const subject: Rec = {};
    const rawSubject: Record<string, number> = {
      x0: (box.x0 * image.w - left) / cropW,
      x1: (box.x1 * image.w - left) / cropW,
      y0: (box.y0 * image.h - top) / cropH,
      y1: (box.y1 * image.h - top) / cropH,
    };
    for (const k of ["x0", "x1", "y0", "y1"]) subject[k] = clamp01(rawSubject[k]);
    // v2 (2026-10-10): bump so crops built BEFORE the continuation promo-donor
    // guard (which could have welded an unverified promo donor into a composite)
    // can never be reused; the digest is the sole crop-cache key.
    const digest = createHash("sha256")
      .update(Buffer.from(mode === "window" ? "render-crop-v3-window" : "render-crop-v2"))
      .update(Buffer.from(strRect(rect)))
      .update(Buffer.from(crop))
      .digest("hex")
      .slice(0, 12);
    mkdirSync(cropsDir, {recursive: true});
    const name = `${pid}-${digest}.png`;
    const target = path.join(cropsDir, name);
    if (!existsSync(target)) {
      const png = await sharp(Buffer.from(crop), {
        raw: {width: cropW, height: cropH, channels: 3},
      })
        .png()
        .toBuffer();
      const tmp = path.join(cropsDir, `${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        writeFileSync(tmp, png);
        renameSync(tmp, target);
      } finally {
        if (existsSync(tmp)) rmSync(tmp, {force: true});
      }
    }
    shot["panel"] = name;
    shot["_src"] = target;
    shot["source_panel"] = pid + ".jpg";
    shot["render_sources"] = sources;
    shot["crop"] = [left, top, right, bottom];
    shot["framed"] = true;
    shot["pw"] = cropW;
    shot["ph"] = cropH;
    shot["box"] = subject;
    shot["art_top"] = 0;
    shot["art_bottom"] = 1;
    shot["focus_x"] = Math.max(0, Math.min(1, (fx - left) / cropW));
    shot["focus_y"] = Math.max(0, Math.min(1, (fy - top) / cropH));
    stats.cropped += 1;
  }
  return stats;
}

/** Python str() of a 4-int tuple, e.g. "(0, 536, 400, 1000)". */
export function strRect(rect: Rect): string {
  return `(${rect[0]}, ${rect[1]}, ${rect[2]}, ${rect[3]})`;
}
