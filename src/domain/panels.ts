/**
 * Panel order and adjacency. Ports reader.panel_order_key, reader.panel_positions,
 * reader._needs_positions, timeline._pid, timeline._keymap, timeline._adj_keys,
 * timeline._is_adj, timeline._chain. MIN_PANEL_S = 0.8.
 *
 * adjKeys / isAdj share one encoding: successor lookup is by `${page},${idx}`,
 * not by panel id. Pass adjKeys(keymap(...)) into isAdj / isChain.
 */

export const SHOT_MIN_S = 0.8;

/** Unparseable id sorts last. reader.panel_order_key / timeline._FAR. */
export const FAR_KEY: readonly [number, number] = Object.freeze([1 << 30, 1 << 30]);

/** Lowest reading-order key. "No lower bound". Not FAR_KEY. timeline._NEG. */
export const NEG_KEY: readonly [number, number] = Object.freeze([-1, -1]);

export type OrderKey = readonly [number, number];

const PANEL_ID_RE = /^p?(\d+)_(\d+)$/;
const PID_RE = /^p\d+_\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python int, not bool. JSON true is a boolean here, so the extra bool check is free. */
function isPyInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function orderKeyId(k: OrderKey): string {
  return `${k[0]},${k[1]}`;
}

function sameKey(a: OrderKey | undefined, b: OrderKey): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

function barePanelId(panel: string): string {
  const base = panel.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

/**
 * (page, idx) of a bare panel id. "p0043_2" and "0043_2" both parse.
 * Unparseable ("", null, "promo", a filename) sorts last. Never throws.
 */
export function panelOrderKey(panelId: unknown): OrderKey {
  const m = PANEL_ID_RE.exec(String(panelId || "").trim());
  if (!m) return [FAR_KEY[0], FAR_KEY[1]];
  return [Number(m[1]), Number(m[2])];
}

/**
 * {bare panel id: (page, idx)} from slicer manifest recs.
 * page/idx on the rec win. A rec missing either falls back to panelOrderKey.
 */
export function panelPositions(manifest: unknown): Record<string, OrderKey> {
  const out: Record<string, OrderKey> = {};
  const recs = Array.isArray(manifest) ? manifest : [];
  for (const r of recs) {
    if (!isRecord(r)) continue;
    const pid = barePanelId(String(r.panel ?? ""));
    if (!pid) continue;
    const pg = r.page;
    const ix = r.idx;
    out[pid] = isPyInt(pg) && isPyInt(ix) ? [pg, ix] : panelOrderKey(pid);
  }
  return out;
}

/**
 * True when an assembled obs predates adjacency: a panel lacks int page and idx.
 * Empty or non-dict panels return false (nothing to heal). A bool page/idx counts as missing.
 */
export function needsPositions(obs: unknown): boolean {
  if (!isRecord(obs)) return false;
  const panels = obs.panels;
  if (!Array.isArray(panels) || panels.length === 0) return false;
  for (const p of panels) {
    if (!isRecord(p)) return false;
    if (!isPyInt(p.page) || !isPyInt(p.idx)) return true;
  }
  return false;
}

/** A real panel id (`pNNNN_N`), or null. Page tokens and junk are null. Leading `p` is required. */
export function isPid(p: unknown): string | null {
  return typeof p === "string" && PID_RE.test(p) ? p : null;
}

/**
 * {panel id: (page, idx)}. Obs page/idx win when both are ints.
 * Otherwise the id parse. Same authority as writer order, kept local so this
 * module does not import the reader.
 */
export function keymap(
  byId: Record<string, {page?: unknown; idx?: unknown} | null | undefined>,
): Record<string, OrderKey> {
  const out: Record<string, OrderKey> = {};
  for (const [pid, rec] of Object.entries(byId)) {
    const pg = isRecord(rec) ? rec.page : undefined;
    const ix = isRecord(rec) ? rec.idx : undefined;
    out[pid] = isPyInt(pg) && isPyInt(ix) ? [pg, ix] : panelOrderKey(pid);
  }
  return out;
}

/**
 * {order key: next picture that exists}. Keyed by `${page},${idx}`, not panel id.
 * Duplicate keys: last assignment wins, same as a dict comprehension over sorted keys.
 */
export function adjKeys(km: Record<string, OrderKey>): Record<string, OrderKey> {
  const ks = Object.values(km).map((k) => [k[0], k[1]] as [number, number]);
  ks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Record<string, OrderKey> = {};
  for (let i = 0; i < ks.length - 1; i++) {
    out[orderKeyId(ks[i]!)] = ks[i + 1]!;
  }
  return out;
}

/** True when a and b are neighbours in either direction. a and b are order keys, not panel ids. */
export function isAdj(a: OrderKey, b: OrderKey, succ: Record<string, OrderKey>): boolean {
  return sameKey(succ[orderKeyId(a)], b) || sameKey(succ[orderKeyId(b)], a);
}

/**
 * True when pids is one unbroken reading-order slice.
 * Fewer than 2 ids is a chain. Missing km or succ is not, for 2+ ids.
 */
export function isChain(
  pids: readonly string[],
  km?: Record<string, OrderKey> | null,
  succ?: Record<string, OrderKey> | null,
): boolean {
  if (pids.length < 2) return true;
  if (km == null || succ == null) return false;
  for (let i = 0; i < pids.length - 1; i++) {
    const a = km[pids[i]!] ?? FAR_KEY;
    const b = km[pids[i + 1]!] ?? FAR_KEY;
    if (!isAdj(a, b, succ)) return false;
  }
  return true;
}
