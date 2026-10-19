/**
 * promoMask.ts - deterministic LOCAL masking of promo/credit OCR regions.
 *
 * TypeScript port of manhwa-pipeline/pipeline/promo_mask.py (T4.1a). Zero
 * LLM / network / OCR calls: reads a manga-image-translator TEXT EXPORT
 * (`*_translations.txt`) and a caller-supplied image, and hard-blurs the OCR
 * regions whose text the caller's matcher flags as promo. It never touches
 * the MIT all-text-inpainted image: the source is always the caller's
 * original pixels.
 *
 * Export format (mode/local.py:_save_text_to_file):
 *
 *   [path/to/panel.jpg]
 *   -- 1 --
 *   color: #1: white (fg, bg: #ffffff #000000)
 *   text:  <ocr text, possibly spanning multiple lines>
 *   trans: <translation>
 *   coords: [x1,y1,x2,y2,x3,y3,x4,y4]   # one line per TextBlock.lines polygon
 *   coords: [...]
 *
 * Public API
 * ----------
 * parseTextExport(text)
 *   panel_id -> [{ text, lines }]. panel_id is the input basename with its
 *   extension stripped (input paths are used ONLY to derive that id).
 *   Repeated panel sections keep the NEWEST. Multiline `text:` is preserved.
 *   Only strictly safe, finite 8-number polygons are accepted (regex
 *   tokenizer, no eval); malformed coords lines are skipped rather than
 *   trusted. Unknown headers are ignored.
 *
 * blurPromoRegions(image, regions, matches, protectedStrings)
 *   Returns { image, boxes }. Blurs ONLY regions whose OCR text satisfies
 *   `matches`; a non-matching region is never touched. Fail-closed
 *   PromoMaskError when a matching region cannot be safely localized/masked,
 *   or when it is unsafe (zero-area, missing/NaN/malformed coords, union of
 *   masks > MAX_UNION_FRAC of the image, or an overlap with OCR-localized
 *   protected non-promo text). A matching region whose own text contains a
 *   protected non-promo string is rejected as a mixed region. If nothing
 *   matches, this raises rather than returning the original.
 *
 *   `image` is either an in-memory RGB object `{ data: Uint8Array, width,
 *   height }` (3 bytes/px, row-major; used for fast synchronous tests) or a
 *   `sharp` instance (decoded to sRGB/3-channel raw first). The returned
 *   image is ALWAYS a new buffer: every pixel outside the returned `boxes`
 *   is byte-identical to the source and the source object is never mutated.
 *
 * blurPromoRegionsFile(srcPath, outPath, regions, matches, protectedStrings)
 *   sharp-driven variant: decodes srcPath, masks, encodes PNG to outPath.
 *
 * Blur is deliberately destructive (strong pixelation + Gaussian smoothing)
 * so glyph detail inside a box does not survive; everything OUTSIDE the
 * returned boxes is pixel-identical to the source. No guarantee is made
 * about artwork UNDER the masked promo text.
 *
 * PARITY NOTES (Python -> JS)
 *  - Python round() is round-half-EVEN; Math.round rounds .5 up. Box edges
 *    for odd line heights hit exact .5 doubles (e.g. 1.5*43=64.5 -> Python
 *    64, Math.round 65), so pyRound reproduces the banker's rounding.
 *  - PIL GaussianBlur(radius) uses radius as the sigma; the JS port runs an
 *    exact separable Gaussian (sigma as std, window 3*sigma, edge clamped).
 *    Inside-box pixels are therefore PIL-equivalent, not PIL-bit-identical;
 *    the OUTSIDE-BOXES-ARE-BYTE-IDENTICAL guarantee is exact and tested.
 *  - Python groups the per-box overlap rejection explicitly (raise on the
 *    expanded box); T4.1a specifies the softer shrink-back: an expanded box
 *    hitting a protected region's padded box first shrinks to the unexpanded
 *    padded box, and only throws when the padded box still overlaps. All
 *    test_promo_mask.py cases reject under both rules.
 *  - sharp `flatten()` composites alpha over black when decoding file input;
 *    PIL's Image.convert("RGB") merely drops alpha. Opaque panels agree.
 */
import sharp, { type Sharp } from "sharp";

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

export const PAD_FRAC = 0.03; // modest, clipped padding around each line bbox
export const MAX_UNION_FRAC = 0.30; // refuse to mask more than 30% of the image
// Font-height-scaled expansion so a matched text line's mask also covers the
// adjoining banner/logo, not just the OCR glyph rect. Proved on DGF p0022_1:
// the ASURASCANS.COM URL's purple banner + owl logo extend well past the text
// line (text 58,1453..285,1488 -> banner ~0,1427..330,1498) and SURVIVE a
// text-only mask. The union and protected-overlap guards below then reject any
// expansion that is unsafe rather than blindly blurring.
export const EXPAND_TOP_FRAC = 0.6; // of the line-box height
export const EXPAND_BOTTOM_FRAC = 0.3;
export const EXPAND_SIDE_FRAC = 1.5;

const BLUR_GRID = 2; // deterministic pixelation grid: collapse each masked
// patch to a 2x2 color field before upsampling + heavy Gaussian. Proved
// necessary on DGF p0022_1: the old block=max(4,m//8) pixelation left
// ASURASCANS.COM legible after the previous mask.

// --------------------------------------------------------------------------- //
// types / errors
// --------------------------------------------------------------------------- //

/** One region record as produced by parseTextExport / the OCR export. */
export interface RegionRecord {
  text: string;
  lines: number[][];
}

/** Clipped, integral pixel box [x1, y1, x2, y2) (x2/y2 exclusive). */
export type Box = [number, number, number, number];

/** In-memory RGB image (3 bytes per pixel, row-major). */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface BlurResult {
  image: RgbImage;
  boxes: Box[];
}

/** Fail-closed error: cannot safely localize/mask a matching promo region. */
export class PromoMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromoMaskError";
  }
}

// --------------------------------------------------------------------------- //
// Python helpers
// --------------------------------------------------------------------------- //

/** Python round(): correctly-rounded half-EVEN on the exact double. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** os.path.basename on POSIX (paths in the export use forward slashes). */
function posixBasename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** os.path.splitext(...)[0]: strip the last extension, but never a leading
 * dot (Python's special case for ".cshrc"-style names). */
function pyStem(path: string): string {
  const base = posixBasename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Python str.splitlines(): recognizes \n, \r, \r\n, \v, \f, \x1c-\x1e,
 * \x85, U+2028, U+2029; a trailing terminator adds no final "" line, but a
 * blank line before it is kept ("a\n\n" -> ["a", ""]). */
function pySplitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/);
  const last = text[text.length - 1]!;
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    const isSep =
      last === "\n" ||
      last === "\r" ||
      last === "\v" ||
      last === "\f" ||
      last === "\u001c" ||
      last === "\u001d" ||
      last === "\u001e" ||
      last === "\u0085" ||
      last === "\u2028" ||
      last === "\u2029";
    if (isSep) lines.pop();
  }
  return lines;
}

// --------------------------------------------------------------------------- //
// export text parsing
// --------------------------------------------------------------------------- //

const PANEL_RE = /^\s*\[([^\[\]]+)\]\s*$/;
const REGION_RE = /^\s*--\s*(\d+)\s*--\s*$/;
// Accept a bare number OR a numpy scalar wrapper ("np.int32(10)"); the
// wrapper form is what modern numpy's str() emits inside the real export.
const NUM_SRC = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const TOKEN_RE = new RegExp(
  `np\\.[A-Za-z0-9_]+\\s*\\(\\s*(${NUM_SRC})\\s*\\)|(${NUM_SRC})`,
  "g",
);

/**
 * Extract exactly 8 finite numbers from a coords payload, else null.
 *
 * Bounded and eval-free: numeric tokens are matched by regex; a numpy scalar
 * wrapper contributes its inner value only (the type digits are consumed by
 * the wrapper pattern, so `np.int32(10)` yields 10, never 32).
 */
function parsePoly(payload: string): number[] | null {
  const vals: number[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const m of payload.matchAll(TOKEN_RE)) {
    const tok = m[1] !== undefined ? m[1] : m[2];
    if (tok === undefined) return null;
    const v = parseFloat(tok);
    if (Number.isNaN(v)) return null;
    vals.push(v);
  }
  if (vals.length !== 8) return null;
  if (!vals.every((v) => Number.isFinite(v))) return null;
  return vals;
}

/**
 * Parse an MIT text export into `{ panel_id: [region, ...] }` (see module).
 */
export function parseTextExport(
  text: string,
): Record<string, RegionRecord[]> {
  if (typeof text !== "string") {
    throw new PromoMaskError("text export must be a string");
  }
  const panels: Record<string, RegionRecord[]> = {};
  let cur: RegionRecord[] | null = null; // current panel's region list
  let reg: RegionRecord | null = null; // current region record
  let inText = false; // accumulating a possibly-multiline text: value
  for (const line of pySplitLines(text)) {
    const panel = line.match(PANEL_RE);
    if (panel) {
      const pid = pyStem(panel[1]!.trim());
      if (pid) {
        cur = [];
        panels[pid] = cur; // newest section wins
      } else {
        cur = null;
      }
      reg = null;
      inText = false;
      continue;
    }
    const s = line.trim();
    if (REGION_RE.test(s)) {
      if (cur !== null) {
        reg = { text: "", lines: [] };
        cur.push(reg);
      } else {
        reg = null;
      }
      inText = false;
      continue;
    }
    if (s.startsWith("coords:")) {
      inText = false;
      if (reg !== null) {
        const nums = parsePoly(s.slice(s.indexOf(":") + 1));
        if (nums !== null) reg.lines.push(nums);
      }
      continue;
    }
    if (s.startsWith("trans:") || s.startsWith("color:")) {
      inText = false;
      continue;
    }
    if (s.startsWith("text:")) {
      inText = true;
      if (reg !== null) {
        // line.split(":", 1)[1].lstrip(" ")  (spaces only, like Python)
        reg.text = line.slice(line.indexOf(":") + 1).replace(/^ +/, "");
      }
      continue;
    }
    if (inText && reg !== null) {
      reg.text += "\n" + line;
    }
    // any other header/blank line is irrelevant -> ignored safely
  }
  return panels;
}

// --------------------------------------------------------------------------- //
// masking
// --------------------------------------------------------------------------- //

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accept a single panel's record list, or a 1-entry {panel_id: [...]} map. */
function coerceRegions(regions: unknown): RegionRecord[] {
  if (isPlainObject(regions)) {
    const keys = Object.keys(regions);
    if (keys.length !== 1) {
      throw new PromoMaskError(
        "regions mapping must contain exactly one panel's records",
      );
    }
    regions = (regions as Record<string, unknown>)[keys[0]!];
  }
  if (!Array.isArray(regions)) {
    throw new PromoMaskError("regions must be a list of region records");
  }
  for (const rec of regions) {
    if (!isPlainObject(rec)) {
      throw new PromoMaskError("each region record must be a mapping");
    }
  }
  return regions as RegionRecord[];
}

function normalizeProtected(protectedStrings: unknown): string[] {
  if (protectedStrings === null || protectedStrings === undefined) return [];
  if (typeof protectedStrings === "string") {
    protectedStrings = [protectedStrings];
  }
  const out: string[] = [];
  if (!Array.isArray(protectedStrings)) return out;
  for (const s of protectedStrings) {
    if (typeof s === "string") {
      const k = s.trim().toLowerCase().replace(/\s+/g, " ");
      if (k) out.push(k);
    }
  }
  return out;
}

function normText(s: unknown): string {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function containsProtected(text: unknown, protectedList: string[]): boolean {
  const n = normText(text);
  return protectedList.some((p) => n.includes(p));
}

/** Validate a polygon as exactly 8 finite real numbers, else null. */
function polyNumbers(poly: unknown): number[] | null {
  if (typeof poly === "string" || !Array.isArray(poly)) return null;
  if (poly.length !== 8) return null;
  const nums: number[] = [];
  for (const v of poly) {
    if (typeof v !== "number") return null; // bools are not "number" in JS
    const f = v;
    if (!Number.isFinite(f)) return null;
    nums.push(f);
  }
  return nums;
}

/**
 * Padded, clipped pixel boxes for a region's line polygons (fail-closed).
 *
 * Each line box gets a modest uniform pad PLUS a font-height-scaled expansion
 * (EXPAND_*) so a matched URL/credit text also covers the adjoining
 * banner/logo that a text-only rect leaves readable. All expansion is clipped
 * to the image; the caller's union/protected guards still apply.
 * `expand=false` yields the unexpanded padded box (used by the protected-
 * overlap shrink-back only).
 */
function regionBoxes(
  rec: RegionRecord,
  W: number,
  H: number,
  what: string,
  expand: boolean,
): Box[] {
  const lines = rec.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PromoMaskError(`${what} region has no localized coordinates`);
  }
  const boxes: Box[] = [];
  for (const poly of lines) {
    const nums = polyNumbers(poly);
    if (nums === null) {
      throw new PromoMaskError(`${what} region has malformed coordinates`);
    }
    const xs = [nums[0]!, nums[2]!, nums[4]!, nums[6]!];
    const ys = [nums[1]!, nums[3]!, nums[5]!, nums[7]!];
    let x1 = Math.min(...xs);
    let x2 = Math.max(...xs);
    let y1 = Math.min(...ys);
    let y2 = Math.max(...ys);
    if (x2 <= x1 || y2 <= y1) {
      throw new PromoMaskError(`${what} region has zero-area coordinates`);
    }
    const bw = x2 - x1;
    const bh = y2 - y1;
    const pad = Math.max(1, pyRound(PAD_FRAC * Math.max(bw, bh)));
    // font-height-scaled banner/logo expansion
    const ex = expand ? pyRound(EXPAND_SIDE_FRAC * bh) : 0;
    const et = expand ? pyRound(EXPAND_TOP_FRAC * bh) : 0;
    const eb = expand ? pyRound(EXPAND_BOTTOM_FRAC * bh) : 0;
    x1 = Math.max(0, Math.floor(x1 - pad - ex));
    y1 = Math.max(0, Math.floor(y1 - pad - et));
    x2 = Math.min(W, Math.ceil(x2 + pad + ex));
    y2 = Math.min(H, Math.ceil(y2 + pad + eb));
    if (x2 <= x1 || y2 <= y1) {
      throw new PromoMaskError(
        `${what} region has zero-area/out-of-bounds coordinates`,
      );
    }
    boxes.push([x1, y1, x2, y2]);
  }
  return boxes;
}

function overlaps(a: Box, b: Box): boolean {
  return !(
    a[2] <= b[0] ||
    b[2] <= a[0] ||
    a[3] <= b[1] ||
    b[3] <= a[1]
  );
}

/** Exact union area of axis-aligned rectangles (coordinate sweep). */
function unionArea(rects: Box[]): number {
  if (rects.length === 0) return 0;
  const xset = new Set<number>();
  for (const r of rects) {
    xset.add(r[0]);
    xset.add(r[2]);
  }
  const xs = [...xset].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i]!;
    const xb = xs[i + 1]!;
    if (xb <= xa) continue;
    const spans: Box[] = [];
    for (const r of rects) {
      if (r[0] < xb && r[2] > xa) spans.push([r[1], r[1], r[3], r[3]]);
    }
    spans.sort((a, b) => a[0] - b[0] || a[3] - b[3]); // Python tuple order
    let covered = 0;
    let cy: number | null = null;
    let ce: number | null = null;
    for (const span of spans) {
      const y1 = span[0];
      const y2 = span[3];
      if (cy === null) {
        cy = y1;
        ce = y2;
      } else if (y1 > ce!) {
        covered += ce! - cy;
        cy = y1;
        ce = y2;
      } else if (y2 > ce!) {
        ce = y2;
      }
    }
    if (cy !== null) covered += ce! - cy;
    area += (xb - xa) * covered;
  }
  return area;
}

// --------------------------------------------------------------------------- //
// destructive hard blur (pure JS on the RGB buffer)
// --------------------------------------------------------------------------- //

/**
 * Deterministic 2x2 pixelation -> NEAREST upsample -> strong Gaussian, in
 * place on `out` for the box. The patch is collapsed to a 2x2 color grid,
 * upsampled with NEAREST, then smoothed with a Gaussian whose sigma scales
 * with the patch. No original high-frequency detail (glyph edges) or alpha
 * blend survives, so letterforms cannot be reconstructed from the masked
 * pixels. (sigma = PIL ImageFilter.GaussianBlur(radius) formula: PIL's
 * radius IS the standard deviation.)
 */
function hardBlurInPlace(
  out: Uint8Array,
  W: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const w = x2 - x1;
  const h = y2 - y1;
  // PIL BOX downsample: output cell i averages every input pixel whose
  // center falls inside window [i*w/gw, (i+1)*w/gw), i.e. the pixel's cell
  // index is floor((center * gw) / w) — same rule NEAREST upsample inverts.
  const gw = Math.max(1, Math.min(BLUR_GRID, w));
  const gh = Math.max(1, Math.min(BLUR_GRID, h));
  const sums = new Float64Array(gw * gh * 3);
  const counts = new Float64Array(gw * gh);
  const cellOf = (center: number, n: number, g: number): number => {
    const c = Math.floor((center * g) / n);
    return c < g ? c : g - 1;
  };
  for (let y = y1; y < y2; y++) {
    const gy = cellOf(y - y1 + 0.5, h, gh);
    for (let x = x1; x < x2; x++) {
      const gx = cellOf(x - x1 + 0.5, w, gw);
      const cell = gy * gw + gx;
      const src = (y * W + x) * 3;
      sums[cell * 3] += out[src]!;
      sums[cell * 3 + 1] += out[src + 1]!;
      sums[cell * 3 + 2] += out[src + 2]!;
      counts[cell]++;
    }
  }
  const grid = new Float64Array(gw * gh * 3);
  for (let c = 0; c < gw * gh; c++) {
    const n = counts[c]!;
    for (let ch = 0; ch < 3; ch++) grid[c * 3 + ch] = sums[c * 3 + ch] / n;
  }
  // NEAREST upsample into the patch buffer (tile the color grid)
  const patch = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const gy = cellOf(y + 0.5, h, gh);
    for (let x = 0; x < w; x++) {
      const gx = cellOf(x + 0.5, w, gw);
      const cell = gy * gw + gx;
      const dst = (y * w + x) * 3;
      patch[dst] = grid[cell * 3]!;
      patch[dst + 1] = grid[cell * 3 + 1]!;
      patch[dst + 2] = grid[cell * 3 + 2]!;
    }
  }
  // strong Gaussian; PIL: ImageFilter.GaussianBlur(max(6.0, min(w, h)/6.0))
  const sigma = Math.max(6.0, Math.min(w, h) / 6.0);
  gaussianBlurPatch(patch, w, h, sigma);
  // write back (clamp to uint8)
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const src = ((y - y1) * w + (x - x1)) * 3;
      const dst = (y * W + x) * 3;
      out[dst] = clampByte(patch[src]!);
      out[dst + 1] = clampByte(patch[src + 1]!);
      out[dst + 2] = clampByte(patch[src + 2]!);
    }
  }
}

function clampByte(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/** Exact separable Gaussian (sigma = std dev, edge clamped), in place. */
function gaussianBlurPatch(
  px: Float64Array,
  w: number,
  h: number,
  sigma: number,
): void {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const klen = 2 * radius + 1;
  const kernel = new Float64Array(klen);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < klen; i++) kernel[i]! /= ksum;
  const tmp = new Float64Array(w * h * 3);
  // horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = -radius; i <= radius; i++) {
        let sx = x + i;
        if (sx < 0) sx = 0;
        else if (sx >= w) sx = w - 1;
        const wt = kernel[i + radius]!;
        const src = (y * w + sx) * 3;
        r += px[src]! * wt;
        g += px[src + 1]! * wt;
        b += px[src + 2]! * wt;
      }
      const dst = (y * w + x) * 3;
      tmp[dst] = r;
      tmp[dst + 1] = g;
      tmp[dst + 2] = b;
    }
  }
  // vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = -radius; i <= radius; i++) {
        let sy = y + i;
        if (sy < 0) sy = 0;
        else if (sy >= h) sy = h - 1;
        const wt = kernel[i + radius]!;
        const src = (sy * w + x) * 3;
        r += tmp[src]! * wt;
        g += tmp[src + 1]! * wt;
        b += tmp[src + 2]! * wt;
      }
      const dst = (y * w + x) * 3;
      px[dst] = r;
      px[dst + 1] = g;
      px[dst + 2] = b;
    }
  }
}

// --------------------------------------------------------------------------- //
// main entry points
// --------------------------------------------------------------------------- //

function isRgbImage(v: unknown): v is RgbImage {
  return (
    isPlainObject(v) &&
    v.data instanceof Uint8Array &&
    typeof v.width === "number" &&
    typeof v.height === "number"
  );
}

/**
 * Hard-blur ONLY the promo regions; return { image, boxes }.
 *
 * `regions` is one panel's list of {text, lines} records (a 1-entry
 * {panel_id: [...]} mapping is also accepted). matches(text) decides which
 * regions are promo (e.g. Block.matches). protectedStrings are known
 * non-promo overlay/world strings that must not be erased; a matching region
 * whose text contains one is rejected, as is any geometric overlap with an
 * OCR-localized protected non-promo region.
 */
export async function blurPromoRegions(
  image: RgbImage | Sharp,
  regions: unknown,
  matches: (text: string) => boolean,
  protectedStrings?: string[] | string | null,
): Promise<BlurResult> {
  if (typeof matches !== "function") {
    throw new PromoMaskError("matches must be callable");
  }
  const recs = coerceRegions(regions);
  const protectedList = normalizeProtected(protectedStrings);

  let W: number;
  let H: number;
  let srcData: Uint8Array;
  if (isRgbImage(image)) {
    W = image.width;
    H = image.height;
    if (W <= 0 || H <= 0) throw new PromoMaskError("image has zero area");
    const need = W * H * 3;
    if (image.data.length < need) {
      throw new PromoMaskError(
        "image data must be RGB (3 bytes per pixel)",
      );
    }
    // copy: source (and caller's buffer) untouched
    srcData = new Uint8Array(image.data.buffer, image.data.byteOffset, need);
  } else if (typeof (image as Sharp).toBuffer === "function") {
    const decoded = await (image as Sharp)
      .clone()
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    W = decoded.info.width;
    H = decoded.info.height;
    if (W <= 0 || H <= 0) throw new PromoMaskError("image has zero area");
    if (decoded.info.channels !== 3) {
      throw new PromoMaskError(
        "image must decode to RGB (got channels: " +
          JSON.stringify(decoded.info.channels) +
          ")",
      );
    }
    srcData = decoded.data;
  } else {
    throw new PromoMaskError(
      "image must be a RGB { data, width, height } or a sharp instance",
    );
  }
  const out = new Uint8Array(W * H * 3);
  out.set(srcData);

  const matched: { box: Box; padded: Box }[] = [];
  const protectedBoxes: Box[] = [];
  for (const rec of recs) {
    const text = typeof rec.text === "string" ? rec.text : "";
    const isPromo = Boolean(matches(text));
    const isProt = containsProtected(text, protectedList);
    if (isPromo) {
      if (isProt) {
        throw new PromoMaskError(
          "matching region text also contains a protected " +
            "non-promo string; refusing to blur a mixed region",
        );
      }
      const expanded = regionBoxes(rec, W, H, "matching promo", true);
      const padded = regionBoxes(rec, W, H, "matching promo", false);
      for (let i = 0; i < expanded.length; i++) {
        matched.push({ box: expanded[i]!, padded: padded[i]! });
      }
    } else if (isProt) {
      // T4.1a: protected comparison uses the PADDED (unexpanded) box, so an
      // expanded promo box can shrink back before we fail closed.
      protectedBoxes.push(
        ...regionBoxes(rec, W, H, "protected", false),
      );
    }
  }

  if (matched.length === 0) {
    throw new PromoMaskError("no matching promo region to mask");
  }

  if (unionArea(matched.map((m) => m.box)) > MAX_UNION_FRAC * W * H) {
    throw new PromoMaskError(
      "promo mask union exceeds 30% of the image",
    );
  }

  const final: Box[] = [];
  const seen = new Set<string>();
  for (const { box, padded } of matched) {
    let use = box;
    if (protectedBoxes.some((pb) => overlaps(use, pb))) {
      if (protectedBoxes.some((pb) => overlaps(padded, pb))) {
        throw new PromoMaskError(
          "promo mask overlaps protected non-promo text",
        );
      }
      use = padded; // shrink back to the unexpanded padded box
    }
    const key = use.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    final.push(use);
  }

  for (const [x1, y1, x2, y2] of final) {
    hardBlurInPlace(out, W, x1, y1, x2, y2);
  }

  return { image: { data: out, width: W, height: H }, boxes: final };
}

/**
 * sharp-driven variant: decode `srcPath` (alpha flattened over black), mask,
 * and encode the result as PNG at `outPath`. Only the `boxes` change; every
 * other pixel comes from the source file unchanged.
 */
export async function blurPromoRegionsFile(
  srcPath: string,
  outPath: string,
  regions: unknown,
  matches: (text: string) => boolean,
  protectedStrings?: string[] | string | null,
): Promise<BlurResult> {
  const decoded = await sharp(srcPath)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) {
    throw new PromoMaskError(
      "expected 3 srgb channels, got " +
        JSON.stringify(decoded.info.channels),
    );
  }
  const result = await blurPromoRegions(
    {
      data: new Uint8Array(
        decoded.data.buffer,
        decoded.data.byteOffset,
        decoded.data.byteLength,
      ),
      width: decoded.info.width,
      height: decoded.info.height,
    },
    regions,
    matches,
    protectedStrings,
  );
  await sharp(Buffer.from(result.image.data.buffer), {
    raw: {
      width: result.image.width,
      height: result.image.height,
      channels: 3,
    },
  })
    .png()
    .toFile(outPath);
  return result;
}
