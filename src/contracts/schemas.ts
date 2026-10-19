/**
 * On-disk contracts ported from the v1 pipeline.
 *
 * Shapes: slicer manifest, reader obs/bible, scout opening, cleaner promo
 * sidecar, timeline shots (Remotion `Shot` / `RecapProps`), run.py report.
 * Sanitizers match reader.norm_box, reader.norm_promo_bbox,
 * reader.apply_promo_meta, timeline._valid_box, timeline._valid_focus_x.
 */
import {z} from "zod";
import type {
  Shot as StudioShot,
  ShotBox as StudioShotBox,
} from "../../remotion-studio/src/motions/types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python float() for a JSON scalar. Rejects bool, blank, hex, non-finite. */
function pyFloat(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

function readBoxVals(raw: unknown): [number, number, number, number] | null {
  let vals: unknown[];
  if (Array.isArray(raw)) {
    if (raw.length !== 4) return null;
    vals = raw;
  } else if (isRecord(raw)) {
    if (!("x0" in raw) || !("y0" in raw) || !("x1" in raw) || !("y1" in raw)) return null;
    vals = [raw.x0, raw.y0, raw.x1, raw.y1];
  } else {
    return null;
  }
  const out: number[] = [];
  for (const v of vals) {
    const f = pyFloat(v);
    if (f === null) return null;
    out.push(f);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

const finite = z.number().finite();

export const NormBoxSchema = z.object({
  x0: finite.min(0).max(1),
  y0: finite.min(0).max(1),
  x1: finite.min(0).max(1),
  y1: finite.min(0).max(1),
}).refine((b) => b.x0 < b.x1 && b.y0 < b.y1, {message: "norm box needs positive area"});
export type NormBox = z.infer<typeof NormBoxSchema>;

export const PromoBboxSchema = z.object({
  x0: finite.min(0).max(1000),
  y0: finite.min(0).max(1000),
  x1: finite.min(0).max(1000),
  y1: finite.min(0).max(1000),
}).refine((b) => b.x0 < b.x1 && b.y0 < b.y1, {message: "promo bbox needs positive area inside 0..1000"});
export type PromoBbox = z.infer<typeof PromoBboxSchema>;

export const PromoRegionSchema = z.object({
  text: z.string(),
  bbox: PromoBboxSchema,
});
export type PromoRegion = z.infer<typeof PromoRegionSchema>;

/** true = full advert page, false = story page with a corner promo, else unknown. */
export type PromoPageStatus = "full" | "partial" | "unknown";

export function toPromoPageStatus(val: unknown): PromoPageStatus {
  if (val === true || val === "full") return "full";
  if (val === false || val === "partial") return "partial";
  if (val === "unknown") return "unknown";
  return "unknown";
}

/**
 * Sanitize one interest box to floats in 0..1.
 * Accepts {x0,y0,x1,y1} or [x0,y0,x1,y1]. Clamps, swaps inverted edges.
 * Returns null on missing/non-numeric/NaN/inf or zero area. Never throws.
 */
export function normBox(raw: unknown): NormBox | null {
  const vals = readBoxVals(raw);
  if (!vals) return null;
  let [x0, y0, x1, y1] = vals.map((f) => Math.min(1, Math.max(0, f))) as [number, number, number, number];
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 <= x0 || y1 <= y0) return null;
  return {x0, y0, x1, y1};
}

/**
 * Sanitize one promo text box to floats in 0..1000.
 * Rejects, never clamps. No swap. Out-of-range, inverted, or zero-area -> null.
 */
export function normPromoBbox(raw: unknown): PromoBbox | null {
  const vals = readBoxVals(raw);
  if (!vals) return null;
  for (const f of vals) {
    if (f < 0 || f > 1000) return null;
  }
  const [x0, y0, x1, y1] = vals;
  if (x1 <= x0 || y1 <= y0) return null;
  return {x0, y0, x1, y1};
}

/**
 * Validate promo metadata in place. Non-bool promo_page is removed (unknown,
 * never false). Bad regions are dropped. A present list with no survivor becomes [].
 */
export function applyPromoMeta<T>(panel: T): T {
  if (!isRecord(panel)) return panel;
  const rec = panel as Record<string, unknown>;
  if ("promo_page" in rec && typeof rec.promo_page !== "boolean") {
    delete rec.promo_page;
  }
  if (!("promo_regions" in rec) || rec.promo_regions == null) return panel;
  if (!Array.isArray(rec.promo_regions)) {
    delete rec.promo_regions;
    return panel;
  }
  const clean: PromoRegion[] = [];
  for (const reg of rec.promo_regions) {
    if (!isRecord(reg)) continue;
    const bbox = normPromoBbox(reg.bbox);
    if (!bbox) continue;
    clean.push({text: typeof reg.text === "string" ? reg.text : "", bbox});
  }
  rec.promo_regions = clean;
  return panel;
}

/** timeline._valid_box: dict only, finite numbers already inside 0..1, positive area. No clamp, no swap. */
export function validBox(raw: unknown): NormBox | null {
  if (!isRecord(raw)) return null;
  if (!("x0" in raw) || !("y0" in raw) || !("x1" in raw) || !("y1" in raw)) return null;
  const vs = [raw.x0, raw.y0, raw.x1, raw.y1];
  const out: number[] = [];
  for (const v of vs) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
    out.push(v);
  }
  if (!(out[0]! < out[2]! && out[1]! < out[3]!)) return null;
  return {x0: out[0]!, y0: out[1]!, x1: out[2]!, y1: out[3]!};
}

/** timeline._valid_focus_x: finite number in 0..1, else null. Strings and bools rejected. */
export function validFocusX(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return null;
  return raw;
}

export const ManifestRecSchema = z.object({
  panel: z.string(),
  page: z.number().int(),
  idx: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  art_top: finite.optional(),
  art_bottom: finite.optional(),
  page_span: z.tuple([z.number().int(), z.number().int()]).optional(),
  stitched_with: z.number().int().optional(),
});
export type ManifestRec = z.infer<typeof ManifestRecSchema>;

export const ManifestSchema = z.array(ManifestRecSchema);
export type Manifest = z.infer<typeof ManifestSchema>;

export const ManifestMetaSchema = z.object({
  slicer_rev: z.number().int(),
  pages_hash: z.string(),
});
export type ManifestMeta = z.infer<typeof ManifestMetaSchema>;

export const CharacterObsSchema = z.object({
  name: z.string(),
  what_they_do: z.string(),
  visual: z.string(),
});
export type CharacterObs = z.infer<typeof CharacterObsSchema>;

export const GagObsSchema = z.object({
  panel: z.string(),
  why: z.string(),
});
export type GagObs = z.infer<typeof GagObsSchema>;

/** Reader contract is a string line. One cached chapter stored `{event}` objects mixed in. */
export const PlotEventSchema = z.union([
  z.string(),
  z.object({event: z.string()}).passthrough(),
]);
export type PlotEvent = z.infer<typeof PlotEventSchema>;

export const PanelObsSchema = z.object({
  id: z.string(),
  visual: z.string(),
  overlay: z.array(z.string()),
  world: z.array(z.string()).optional(),
  art: finite,
  bubble_at: z.string(),
  focus_y: finite,
  box: NormBoxSchema.optional(),
  weight: finite,
  promo_page: z.boolean().optional(),
  promo_regions: z.array(PromoRegionSchema).optional(),
  focus_x: finite.optional(),
  page: z.number().int().optional(),
  idx: z.number().int().optional(),
});
export type PanelObs = z.infer<typeof PanelObsSchema>;

export const ChapterObsDataSchema = z.object({
  panels: z.array(PanelObsSchema),
  characters: z.array(CharacterObsSchema),
  gags: z.array(GagObsSchema),
  events: z.array(PlotEventSchema),
});
export type ChapterObsData = z.infer<typeof ChapterObsDataSchema>;

export const CachedBlobSchema = z.object({
  brief_hash: z.string(),
  caption_version: z.number().int().optional(),
  data: ChapterObsDataSchema,
});
export type CachedBlob = z.infer<typeof CachedBlobSchema>;

export const BibleCharacterSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  visual: z.string(),
  visual_now: z.string().optional(),
  role: z.string(),
  status: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
});
export type BibleCharacter = z.infer<typeof BibleCharacterSchema>;

export const BibleLinkSchema = z.object({
  who: z.string(),
  alias: z.string().optional(),
  matched_unknown: z.string().optional(),
  evidence: z.string(),
});
export type BibleLink = z.infer<typeof BibleLinkSchema>;

export const BiblePlotLedgerEntrySchema = z.object({
  ch: z.string(),
  events: z.array(PlotEventSchema),
});
export type BiblePlotLedgerEntry = z.infer<typeof BiblePlotLedgerEntrySchema>;

export const BibleGagSchema = GagObsSchema.extend({
  ch: z.string(),
});
export type BibleGag = z.infer<typeof BibleGagSchema>;

export const BibleSchema = z.object({
  characters: z.record(BibleCharacterSchema),
  plot_ledger: z.array(BiblePlotLedgerEntrySchema),
  links: z.array(BibleLinkSchema),
  gags: z.array(BibleGagSchema).optional(),
  covered: z.array(z.string()).optional(),
  merge_log: z.record(z.array(z.string())).optional(),
});
export type Bible = z.infer<typeof BibleSchema>;

export const OpeningSchema = z.object({
  start_ch: z.string(),
  start_at: z.number().int(),
  scene: z.string(),
  why: z.string(),
  panel: z.string(),
  hook: z.string(),
  introduces: z.array(z.string()),
  search: z.array(z.string()),
});
export type Opening = z.infer<typeof OpeningSchema>;

const PxBoxSchema = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);

export const PromoSidecarSchema = z.object({
  version: z.string(),
  panel: z.string(),
  source_sha1: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  partial: z.boolean(),
  cache_hash: z.string(),
  boxes_px: z.array(PxBoxSchema),
  boxes_norm: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
});
export type PromoSidecar = z.infer<typeof PromoSidecarSchema>;

export const ShotBoxSchema = z.object({
  x0: finite,
  y0: finite,
  x1: finite,
  y1: finite,
});
export type ShotBox = StudioShotBox;

export const ShotSchema = z.object({
  panel: z.string(),
  start_s: finite,
  end_s: finite,
  from: z.enum(["left", "right"]).optional(),
  focus_y: finite.optional(),
  focusY: finite.optional(),
  focus_x: finite.optional(),
  box: ShotBoxSchema.optional(),
  art_top: finite.optional(),
  art_bottom: finite.optional(),
  weight: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  pw: finite.optional(),
  ph: finite.optional(),
  framed: z.boolean().optional(),
  source_panel: z.string().optional(),
  render_sources: z.array(z.string()).optional(),
  crop: z.array(finite).optional(),
  line_id: z.number().int().optional(),
});
export type Shot = StudioShot;

type _AssertEqual<A, B extends A> = [A] extends [B] ? true : never;
type _ShotBoxParity = _AssertEqual<z.infer<typeof ShotBoxSchema>, StudioShotBox>;
type _ShotParity = _AssertEqual<z.infer<typeof ShotSchema>, StudioShot>;

/** remotion-studio RecapProps. shots.json is this object, not a bare shot list. */
export const RecapPropsSchema = z.object({
  shots: z.array(ShotSchema),
  audio: z.string(),
  volume: finite.optional(),
  background: z.string().optional(),
  motion: z.string().optional(),
});
export type RecapProps = z.infer<typeof RecapPropsSchema>;

export const ChapterReportSchema = z.object({
  series: z.string(),
  ch: z.string(),
  status: z.enum(["ok", "failed", "video-ok", "video-failed"]),
  lines: z.number().int().optional(),
  issues: z.array(z.string()).optional(),
  window_holes: z.array(z.string()).optional(),
  class: z.string().optional(),
  error: z.string().optional(),
  video: z.string().optional(),
  duration: finite.optional(),
});
export type ChapterReport = z.infer<typeof ChapterReportSchema>;
