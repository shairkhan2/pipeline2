/**
 * writer.ts - port of manhwa-pipeline/pipeline/writer.py.
 *
 * Stage 2: WRITER - bible + panel transcript + RAW PANELS -> script.md. One shot, no
 * retry loop.
 *
 * SEQUENCE (2026-10-03, stage 2): reading order is a pure id parse, so importing it costs
 * nothing and no manifest/obs round-trip is needed. Python's reader imports writer LAZILY
 * (inside read_chapter), so this edge cannot cycle; here `panelOrderKey` comes from
 * domain/panels.ts, which imports nothing from the stages.
 *
 * storyWriter.ts / visualMatcher.ts are loaded LAZILY (dynamic import) exactly where
 * Python imports story_writer / visual_matcher, so this module is loadable and testable
 * without them.
 *
 * Ported fixes from TODO.md Section 2.1 (already present in v1 writer.py):
 *   - the matcher offer carries the FULL `visual` caption, never `[:140]`;
 *   - Phase 1 validates against `offered_set` (the filtered showable offer), not `by_pid`;
 *   - `_extend_run` refuses a tail candidate whose overlap is < 2 stems;
 *   - `_best_run` returns [] when nothing in the pool overlaps the line (the stale
 *     docstring's "wrong picture beats a frozen frame" fallback is gone from the code);
 *   - a continuation line with no visual match gets `@hold` instead of an arbitrary panel.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  EMOTION_BLOCK,
  EMOTION_TAGS,
  EVENT_MAP_BLOCK,
  LAWS,
  MATCH_TASK,
  WRITER_TASK,
  WRITER_V2_TASK,
} from "../contracts/briefs.js";
import { pyFloatRepr } from "../contracts/hashes.js";
import { FAR_KEY, panelOrderKey, type OrderKey } from "../domain/panels.js";
import { FilterBlocked, RuntimeError, call, pageBlocks, parseJson } from "../llm/client.js";

// ---------------------------------------------------------------------------
// Local types (loose on purpose: obs/bible arrive straight from JSON)
// ---------------------------------------------------------------------------

export interface PanelRec {
  id: string;
  visual?: unknown;
  overlay?: unknown;
  world?: unknown;
  art?: unknown;
  bubble_at?: unknown;
  page?: unknown;
  idx?: unknown;
  promo_page?: unknown;
  [key: string]: unknown;
}

export interface ObsLike {
  panels?: PanelRec[];
  characters?: Array<Record<string, unknown>>;
  gags?: unknown[];
  events?: unknown[];
  [key: string]: unknown;
}

export interface BibleLike {
  characters?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** promo_block.Block, structurally. */
export interface BlockLike {
  matches(s: unknown): boolean;
  panelFullPromo(p?: unknown): boolean;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

// ---------------------------------------------------------------------------
// Python string / number helpers
// ---------------------------------------------------------------------------

const PY_WS =
  "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";

/** Python str.strip() (Python whitespace, not JS). */
function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** Python str.rstrip(). */
function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`), "");
}

/** Python str.split() with no args. */
function pySplit(s: string): string[] {
  return s.split(new RegExp(`[${PY_WS}]+`, "g")).filter((x) => x !== "");
}

/**
 * Python str.splitlines(): \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029.
 * No trailing empty element after a final terminator.
 */
function pySplitLines(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "\r") {
      out.push(cur);
      cur = "";
      if (s[i + 1] === "\n") i++;
    } else if (
      c === "\n" || c === "\v" || c === "\f" ||
      c === "\x1c" || c === "\x1d" || c === "\x1e" ||
      c === "\u0085" || c === "\u2028" || c === "\u2029"
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

/** Python len(str) = code points, not UTF-16 units. */
function pyLen(s: string): number {
  return Array.from(s).length;
}

/** Python str() for the scalars that reach a prompt or a beat slug. */
function pyStrVal(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (isPyFloat(v)) return pyFloatRepr(v.__pyFloat__);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (v === null || v === undefined) return "None";
  return pyRepr(v);
}

/** Python repr() for the odd non-scalar (a cached `{"event": ...}` in obs["events"]). */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const hasSingle = v.includes("'");
    const hasDouble = v.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    let out = quote;
    for (const ch of v) {
      const cp = ch.codePointAt(0) as number;
      if (ch === "\\") out += "\\\\";
      else if (ch === quote) out += "\\" + quote;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
      else out += ch;
    }
    return out + quote;
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj).map((k) => `${pyRepr(k)}: ${pyRepr(obj[k])}`).join(", ")}}`;
  }
  return String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python int check: JSON `true` is a boolean here, so it never passes. */
function isPyInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** hashes.ts marker for a number Python held as a `float` (so `1.0` prints, not `1`). */
function isPyFloat(v: unknown): v is { __pyFloat__: number } {
  return isRecord(v) && Object.prototype.hasOwnProperty.call(v, "__pyFloat__")
    && typeof v.__pyFloat__ === "number";
}

/** A Python number as a JS number, unwrapping the pyFloat marker. `null` when not one. */
function pyNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (isPyFloat(v)) return v.__pyFloat__;
  return null;
}

/** A Python number field, with Python's `d.get(k, default)` fallback. */
function pyNumOr(v: unknown, def: number): number {
  return pyNum(v) ?? def;
}

/** Python `str(x).isdigit()`. */
function isDigitStr(v: unknown): boolean {
  const s = typeof v === "string" ? v : pyStrVal(v);
  return s.length > 0 && [...s].every((c) => /\p{Nd}/u.test(c));
}

/** Python float floor division (`4.0 // 0.8` is 4.0, not 5.0). */
function pyFloorDiv(vx: number, wx: number): number {
  const mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod && wx < 0 !== mod < 0) div -= 1.0;
  if (!div) return 0;
  let floordiv = Math.floor(div);
  if (div - floordiv > 0.5) floordiv += 1.0;
  return floordiv;
}

/** Code-point lexicographic compare (Python str ordering). */
function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const as = Array.from(a);
  const bs = Array.from(b);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ca = as[i]!.codePointAt(0) as number;
    const cb = bs[i]!.codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

function pySorted(values: Iterable<string>): string[] {
  return [...values].sort(cmpCodePoints);
}

/**
 * Python `json.dumps(value, indent=...)`. `indent=null` is the compact-ish default
 * (`", "` / `": "`); `indent=1` puts one item per line. ensure_ascii defaults to True.
 */
function pyJson(
  value: unknown,
  opts: { indent?: number | null; ensureAscii?: boolean } = {},
): string {
  const indent = opts.indent ?? null;
  const ensureAscii = opts.ensureAscii ?? true;
  const quote = (s: string): string => {
    let out = '"';
    for (const ch of s) {
      const cp = ch.codePointAt(0) as number;
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else if (ensureAscii && cp > 0x7f) {
        if (cp > 0xffff) {
          const v = cp - 0x10000;
          out += `\\u${(0xd800 + (v >> 10)).toString(16).padStart(4, "0")}`;
          out += `\\u${(0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0")}`;
        } else {
          out += `\\u${cp.toString(16).padStart(4, "0")}`;
        }
      } else out += ch;
    }
    return `${out}"`;
  };
  const render = (v: unknown, level: number): string => {
    const pad = indent === null ? "" : " ".repeat(indent * level);
    const padIn = indent === null ? "" : " ".repeat(indent * (level + 1));
    const sep = indent === null ? ", " : ",\n";
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    if (typeof v === "string") return quote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const items = v.map((x) => render(x, level + 1));
      if (indent === null) return `[${items.join(sep)}]`;
      return `[\n${items.map((x) => padIn + x).join(sep)}\n${pad}]`;
    }
    if (isRecord(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      const items = keys.map((k) => `${quote(k)}: ${render(v[k], level + 1)}`);
      if (indent === null) return `{${items.join(sep)}}`;
      return `{\n${items.map((x) => padIn + x).join(sep)}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

/**
 * Python `str.format` for the named-field templates in contracts/briefs.ts.
 * `{{`/`}}` unescape; `{name}` is replaced; a missing field throws like Python.
 */
export function pyFormat(template: string, kwargs: Record<string, unknown>): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i++;
        continue;
      }
      const end = template.indexOf("}", i);
      if (end < 0) throw new ValueError("Single '{' encountered in format string");
      const name = template.slice(i + 1, end);
      if (!Object.prototype.hasOwnProperty.call(kwargs, name)) {
        throw new KeyError(`'${name}'`);
      }
      out += pyStrVal(kwargs[name]);
      i = end;
      continue;
    }
    if (ch === "}") {
      if (template[i + 1] === "}") {
        i++;
        out += "}";
        continue;
      }
      throw new ValueError("Single '}' encountered in format string");
    }
    out += ch;
  }
  return out;
}

/** Python KeyError (a `str.format` miss). */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

// ---------------------------------------------------------------------------
// Blocked (moderation) detection
// ---------------------------------------------------------------------------

export function _blocked(err: unknown): boolean {
  const s = err instanceof Error ? err.message : pyStrVal(err);
  return (
    s.includes("data_inspection_failed") ||
    s.includes("inappropriate content") ||
    s.toLowerCase().includes("moderation") ||
    s.includes("content_policy") ||
    err instanceof FilterBlocked
  );
}

/** Binary-search which panels trip the provider image filter. Returns set of paths. */
export async function findBlocked(paths: string[], maxH: number): Promise<Set<string>> {
  const probe = async (ps: string[]): Promise<boolean> => {
    try {
      await call(
        [{
          role: "user",
          content: [{ type: "text", text: "Reply OK." }, ...(await pageBlocks(ps, maxH))],
        }],
        { maxTokens: 5, retries: 1, stage: "matcher" },
      );
      return false;
    } catch (e) {
      return _blocked(e);
    }
  };
  if (!paths.length || !(await probe(paths))) return new Set();
  if (paths.length === 1) return new Set(paths);
  const mid = Math.floor(paths.length / 2);
  const left = await findBlocked(paths.slice(0, mid), maxH);
  const right = await findBlocked(paths.slice(mid), maxH);
  for (const p of right) left.add(p);
  return left;
}

/** Filter is resolution-dependent; try alternate encodings before giving up. */
export async function unblock(p: string): Promise<number | null> {
  for (const h of [1200, 1400, 1000, 1600]) {
    try {
      await call(
        [{
          role: "user",
          content: [{ type: "text", text: "Reply OK." }, ...(await pageBlocks([p], h))],
        }],
        { maxTokens: 5, retries: 1, stage: "matcher" },
      );
      return h;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * I-43 evidence layer: is there ARTWORK to show? The reader is not always
 * self-consistent (it returned art:0.9 WITH bubble_at 'full' on a drawn broadcast
 * screen), so require BOTH signals before declaring a panel unshowable. When they
 * disagree, trust the art score - a drawn panel with a bubble on it is still a
 * drawn panel.
 *
 * WORLD TEXT COUNTS (2026-10-05). The length test read OVERLAY chars only, so a
 * panel whose text the reader filed as `world` (a title card, a sign filling the
 * frame) with bubble_at 'none' had nothing to stop it. The default 0 keeps every
 * existing caller byte-compatible, and the panel that the fold used to drop
 * captionless now keeps its caption (see panelTranscript).
 */
export function _novisual(art: number, ovChars: number, ba: string, wdChars = 0): boolean {
  return art <= 0.2 || (art < 0.5 && ovChars + wdChars >= 60) || (ba === "full" && art < 0.8);
}

interface TranscriptRow {
  id: string;
  visual: string;
  art: unknown;
  ov: string[];
  wd: string[];
  novisual: boolean;
  keep_caption: boolean;
  ba: string;
  folds: TranscriptRow[];
  folded?: boolean;
}

/**
 * Reader observations -> the transcript text the writer reads.
 * I-19: blocked promo/credit strings never enter writer context - a model shown a
 * banner paraphrases a banner; the block list stays mechanical data.
 *
 * I-42: bubble-heavy panels are marked explicitly. The writer is asked to avoid them,
 * and a bare 'art:0.5' is easy to read past as 'half-fine' - the tag makes the bad ones
 * unmissable so avoidance does not depend on the writer doing arithmetic on a float.
 *
 * NO-VISUAL FOLD: a NO-VISUAL panel never appears as a taggable line. Its overlay/world
 * text is folded into the NEAREST showable neighbour with a (from pXXXX_N) note, so the
 * writer keeps every fact and quote but structurally cannot tag an empty rectangle.
 */
export function panelTranscript(obs: ObsLike, block: BlockLike | null = null): string {
  const rows: TranscriptRow[] = [];
  for (const p of obs.panels ?? []) {
    const ovL = (Array.isArray(p.overlay) ? (p.overlay as string[]) : []).filter(
      (t) => !(block && block.matches(t)),
    );
    const wdL = (Array.isArray(p.world) ? (p.world as string[]) : []).filter(
      (t) => !(block && block.matches(t)),
    );
    const artRaw = p.art === undefined ? 1 : p.art;
    const art = pyNumOr(artRaw, 1);
    const ovChars = ovL.reduce((n, t) => n + pyLen(t), 0);
    const wdChars = wdL.reduce((n, t) => n + pyLen(t), 0);
    const ba = String(p.bubble_at ?? "").trim().toLowerCase();
    rows.push({
      id: String(p.id),
      visual: typeof p.visual === "string" ? p.visual : String(p.visual ?? ""),
      art: artRaw,
      ov: ovL,
      wd: wdL,
      novisual: _novisual(art, ovChars, ba, wdChars),
      // the OLD gate (overlay chars only) IS _novisual(..., wd=0): a panel it would have
      // SHOWN and the widened gate now hides must keep its caption, or widening the gate
      // deletes the only record of what a sign/title card showed.
      keep_caption: _novisual(art, ovChars, ba, wdChars) && !_novisual(art, ovChars, ba),
      ba,
      folds: [],
    });
  }
  const showable: number[] = [];
  rows.forEach((r, i) => {
    if (!r.novisual) showable.push(i);
  });
  rows.forEach((r, i) => {
    if (!r.novisual || (!r.ov.length && !r.wd.length)) return;
    if (!showable.length) return; // whole chapter unshowable: keep lines as-is
    let tgt = showable[0]!;
    let bestKey: [number, number] = [Math.abs(tgt - i), tgt < i ? 1 : 0];
    for (const j of showable) {
      const k: [number, number] = [Math.abs(j - i), j < i ? 1 : 0];
      if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
        bestKey = k;
        tgt = j;
      }
    }
    rows[tgt]!.folds.push(r);
    r.folded = true;
  });
  const out: string[] = [];
  for (const r of rows) {
    if (r.folded) continue;
    let flag = "";
    if (r.novisual) flag = " NO-VISUAL";
    else if (
      ["corner", "edge", "top", "bottom", "center"].includes(r.ba) && pyNumOr(r.art, 1) >= 0.8
    ) {
      flag = " BUBBLE-AT-CORNER";
    }
    let ov = r.ov.map((t) => `"${t}"`).join(" ");
    let wd = r.wd.map((t) => `"${t}"`).join(" ");
    for (const f of r.folds) {
      for (const t of f.ov) ov += ` "${t}" (from ${f.id})`;
      for (const t of f.wd) wd += ` "${t}" (from ${f.id})`;
    }
    // CARDS (2026-10-05): the fold carries a hidden panel's overlay and world text to
    // its neighbour but drops that panel's `visual` caption with the row. Fine for
    // panels the gate already hid, wrong for the ones the WIDENED gate newly hides
    // (world chars now count): the writer keeps every fact, so it must keep the
    // caption too.
    const cards = r.folds
      .filter((f) => f.visual && f.keep_caption)
      .map((f) => `[${f.id} card: ${f.visual}]`)
      .join(" ");
    out.push(
      `${r.id} | art:${pyStrVal(r.art)}${flag} | ${r.visual} `
      + `| OVERLAY: ${ov || "-"} | WORLD: ${wd || "-"}`
      + (cards ? ` | CARDS: ${cards}` : ""),
    );
  }
  return out.join("\n");
}

/**
 * Story-only lookup for the writer: dialogue (OVERLAY) and in-world text (WORLD)
 * WITHOUT raw vision pose/body/camera descriptions (`visual`). Keeps `panelTranscript`
 * unchanged for fact_check and matcher source_context while preventing the writer from
 * paraphrasing vision captions into an audiobook.
 */
export function writerDialogueLookup(obs: ObsLike, block: BlockLike | null = null): string {
  const out: string[] = [];
  for (const p of obs.panels ?? []) {
    const ov = (Array.isArray(p.overlay) ? (p.overlay as string[]) : []).filter(
      (t) => !(block && block.matches(t)),
    );
    const wd = (Array.isArray(p.world) ? (p.world as string[]) : []).filter(
      (t) => !(block && block.matches(t)),
    );
    if (!ov.length && !wd.length) continue;
    const ovS = ov.map((t) => `"${t}"`).join(" ") || "-";
    const wdS = wd.map((t) => `"${t}"`).join(" ") || "-";
    out.push(`${p.id} | DIALOGUE: ${ovS} | SYSTEM/WORLD: ${wdS}`);
  }
  return out.join("\n") || "(no dialogue or world text)";
}

// ---------------------------------------------------------------------------
// Continuity window
// ---------------------------------------------------------------------------

/**
 * The episode the viewer actually heard: expressive series voice script_voice.md or
 * script_eleven.md, so a window that only looked for script.md saw NO previous episodes
 * on expressive series.
 */
export function _scriptOf(outDir: string, c: string): string | null {
  for (const name of ["script_voice.md", "script_eleven.md", "script.md"]) {
    const p = path.join(outDir, c, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export const HOOK_BEATS = 3; // story moves kept per evicted episode (see previousWindow)

/**
 * The LAST n beat names of an evicted episode, de-slugged (b07_orphan_promise ->
 * orphan promise). Measured: the hook block carried EVERY beat of every episode -
 * 972 beat slugs over 38 evicted episodes on wk ch42, 20,982 chars = 22.4% of the
 * whole writer prompt against a ~30-token-per-episode design budget. The newest moves
 * are the open threads, which is the only thing the hook exists to carry.
 */
export function _hookMoves(txt: string, n: number = HOOK_BEATS): string[] {
  const beats = [...txt.matchAll(/## BEAT (\S+)/g)].map((m) => m[1] as string);
  return beats.slice(-n).map((b) => b.replace(/^b\d+_/, "").replace(/_/g, " "));
}

/**
 * Context layering (I-01): feed the writer the previous episodes the way a chat session
 * carries history - newest scripts VERBATIM until the budget is spent, and every chapter
 * that gets evicted leaves a short HOOK (its last 3 story moves + its final line) so open
 * loops survive to chapter 60 instead of vanishing.
 *
 * Budget is 25k chars: a giant verbatim window invites the writer to 'remember' details
 * that aren't there; smaller keeps everything in window quotable truth. Facts still come
 * from THIS chapter's transcript - CONTINUITY LAW says so explicitly.
 */
export function previousWindow(
  outDir: string,
  ch: string,
  budget = 25000,
): [string, number, number] {
  const m = /\d+/.exec(ch);
  if (!m) throw new Error(`no digits in chapter name: ${ch}`);
  const chNum = Number.parseInt(m[0], 10);
  const chapters = fs
    .readdirSync(outDir)
    .filter((c) => /^ch\d+$/.test(c) && Number.parseInt(c.slice(2), 10) < chNum && _scriptOf(outDir, c))
    .sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10));
  if (!chapters.length) return ["", 0, 0];
  const verbatim: Array<[string, string]> = [];
  let used = 0;
  const evicted: string[] = [];
  for (const c of [...chapters].reverse()) {          // newest first
    const txt = pyStrip(fs.readFileSync(_scriptOf(outDir, c) as string, "utf8"));
    if (used && used + pyLen(txt) > budget) {
      evicted.push(c);
      continue;
    }
    verbatim.push([c, txt]);
    used += pyLen(txt);
  }
  verbatim.reverse();                                 // back to chronological
  const parts: string[] = [];
  for (const [c, txt] of verbatim) {
    parts.push(`--- ${c} (verbatim, what the viewer already saw) ---\n${txt}`);
  }
  const hooks = chapters.filter((c) => evicted.includes(c));
  for (const c of hooks) {                            // oldest -> newest
    const txt = pyStrip(fs.readFileSync(_scriptOf(outDir, c) as string, "utf8"));
    const moves = _hookMoves(txt);
    const last = pySplitLines(txt).filter((l) => pyStrip(l) && !l.startsWith("#"));
    parts.push(
      `--- ${c} (older than memory; hook only) ---\n`
      + `story moves: ${moves.join(", ")}\nlast line: ${last.length ? last[last.length - 1] : ""}`,
    );
  }
  const header =
    "PREVIOUS EPISODES - continuity material. Match their voice and refer to "
    + "characters the way they do; honour open hooks; DO NOT import facts, "
    + "numbers, or events from these into your chapter (this chapter's transcript "
    + "is your only fact source):\n";
  return [header + parts.join("\n\n") + "\n", verbatim.length, hooks.length];
}

// ---------------------------------------------------------------------------
// Pacing constants
// ---------------------------------------------------------------------------

export const JAB_GAP = 4; // at most one jab per this many steps (see stepsToScript)
/** BUDGET divisor, seconds of narration one PICTURE's worth of words buys. Sets the
 *  chapter word budget, so it sets VIDEO LENGTH. The editorial pace per line is RUN_S. */
export const SHOT_S = 2.5;
/** EDITORIAL divisor, seconds of narration one CUT INSIDE A LINE may cost. Governs
 *  pictures per LINE only; the word budget above is untouched. See `_runCap`. */
export const RUN_S = 1.25;
/** Physical floor: a picture cannot be on screen for less than this or
 *  timeline.build_shots drops the tag (its MIN_PANEL_S). MIRRORS timeline.MIN_PANEL_S. */
export const SHOT_MIN_S = 0.8;
/** Word budget of the last writeScript call (run.py reports it). */
export let LAST_BUDGET = 0;
/** Module default: run.py imports it even when writer is SKIPPED (I-13). */
export let LAST_WINDOW = "";

export function setLastBudget(v: number): void {
  LAST_BUDGET = v;
}
export function setLastWindow(v: string): void {
  LAST_WINDOW = v;
}

export interface WriteScriptOptions {
  maxPanels?: number;
  maxH?: number;
  outDir?: string | null;
  emotion?: boolean;
  block?: BlockLike | null;
  opening?: string;
  taken?: Iterable<string>;
  mode?: string | null;
  diagnosticsDir?: string | null;
}

/**
 * One writer pass: generate the narration, then match panels, then write.
 *
 * `taken` (the scout hook's panel ids) is accepted and DELIBERATELY unused: run.py passes
 * it on episode 1, and excluding those panels from the matcher was considered and rejected
 * - when the story reaches the moment the hook previewed, re-showing its picture is the
 * payoff, not a duplicate. The parameter stays because run.py passes it.
 */
export async function writeScript(
  obs: ObsLike,
  bible: BibleLike,
  panelsDir: string,
  outPath: string,
  opts: WriteScriptOptions = {},
): Promise<string> {
  const {
    outDir = null,
    emotion = false,
    block = null,
    opening = "",
    mode: modeOpt = null,
    diagnosticsDir: diagnosticsOpt = null,
  } = opts;
  const mode = modeOpt ?? process.env.WRITER_MODE ?? "legacy";
  if (mode !== "legacy" && mode !== "story") {
    throw new ValueError("WRITER_MODE must be legacy or story");
  }
  if (mode === "story") {
    const storyWriter = await loadModule("./storyWriter.js");
    let diagnosticsDir = diagnosticsOpt;
    if (diagnosticsDir === null || diagnosticsDir === undefined) {
      diagnosticsDir = path.join(path.dirname(path.resolve(outPath)), "story_diagnostics");
    }
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    LAST_BUDGET = 0; // story scope, never a function of panel inventory
    LAST_WINDOW = outDir
      ? previousWindow(outDir, path.basename(panelsDir.replace(/\/+$/, "")))[0]
      : "";
    // story_writer.generate: v2 exposes the same orchestration as writeStoryScript and
    // keeps `generate` as an alias for callers ported from Python.
    const generate = (storyWriter.generate ?? storyWriter.writeStoryScript) as StoryGenerate;
    if (typeof generate !== "function") {
      throw new RuntimeError("storyWriter.ts exports neither generate nor writeStoryScript");
    }
    const draft = await generate(obs, bible, panelTranscript(obs, block), {
      previous: LAST_WINDOW,
      opening,
      emotion,
      diagnosticsDir,
      diagnostics_dir: diagnosticsDir,
    });
    let [script, ns] = stepsToScript(pyJson(draft));
    if (script === null || !ns) {
      throw new ValueError("story writer produced no narration");
    }
    script = "# STORY_UNITS v1\n" + script;
    if (diagnosticsDir) {
      fs.writeFileSync(path.join(diagnosticsDir, "draft-script.md"), script);
    }
    // Generation and source/style review complete BEFORE image selection.
    script = await matchPanels(script, obs, {
      block,
      wps: emotion ? 3.7 : 3.2,
      panelsDir,
      mode: "semantic",
      diagnosticsDir: diagnosticsDir ? path.join(diagnosticsDir, "match") : null,
    });
    // Never replace a previous script with a partial draft or failed match.
    const parent = path.dirname(path.resolve(outPath));
    const tmp = path.join(parent, `.story-${randomUUID()}`);
    try {
      fs.writeFileSync(tmp, script);
      fs.renameSync(tmp, outPath);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    return script;
  }

  const ch = path.basename(panelsDir.replace(/\/+$/, ""));
  const byPid: Record<string, PanelRec> = {};
  for (const p of obs.panels ?? []) byPid[String(p.id)] = p;
  const lookup = writerDialogueLookup(obs, block);
  const events =
    (obs.events ?? []).map((e) => `- ${pyStrValueForPrompt(e)}`).join("\n")
    || "- (none reported)";
  const storyWriter = await loadModule("./storyWriter.js");
  const slim = (storyWriter.cast_context as CastContext)(obs, bible);
  const gags = pyJson(obs.gags ?? [], { indent: 1 }) || "[]";
  let prev = "";
  LAST_WINDOW = "";
  if (outDir) {
    const [p, nV, nH] = previousWindow(outDir, ch);
    console.log(
      `   continuity window: ${nV} episodes verbatim, ${nH} as hooks (${pyLen(p)} chars)`,
    );
    prev = p; // fact_check LORE-IMPORT needs the exact window text
    LAST_WINDOW = prev;
  }
  const emotionBlock = emotion
    ? pyFormat(EMOTION_BLOCK, { tag_list: EMOTION_TAGS.map((t) => `[${t}]`).join(", ") })
    : "";
  const task = emotion ? WRITER_V2_TASK : WRITER_TASK;
  const wps = emotion ? 3.7 : 3.2;
  const runPanel = Math.round(RUN_S * wps); // words one extra cut inside a line must pay for
  const nEvents = Math.max(8, (obs.events ?? []).length);
  const budget = Math.min(340, Math.max(220, nEvents * 11));
  LAST_BUDGET = budget;
  console.log(
    `   word budget: ${budget} (story-driven from ${(obs.events ?? []).length} events, `
    + `no vision-row padding) | line cut pace: ${runPanel} words (~${RUN_S}s)`,
  );
  const prompt = pyFormat(task, {
    ch,
    bible: pyJson(slim, { indent: 1, ensureAscii: false }),
    transcript: lookup,
    gags,
    laws: LAWS,
    previous: prev,
    emotion: emotionBlock,
    events,
    opening,
    budget,
  });
  const content = [{ type: "text", text: prompt }];
  const r = await call([{ role: "user", content }], {
    maxTokens: 6000,
    temperature: 0.7,
    tag: `writer ${ch}`,
    stage: "writer",
  });
  let txt = r.choices[0]?.message?.content ?? "";
  if (!pyStrip(txt)) {
    throw new RuntimeError("writer returned empty content (not saving)");
  }
  let [script, nSteps, nJabs] = stepsToScript(txt);
  if (script === null) {
    const r2 = await call([{ role: "user", content }], {
      maxTokens: 6000,
      temperature: 0.2,
      tag: `writer ${ch} retry`,
      stage: "writer",
    });
    txt = r2.choices[0]?.message?.content ?? "";
    [script, nSteps, nJabs] = stepsToScript(txt);
  }
  if (script === null) {
    throw new RuntimeError("writer output did not contain valid JSON steps (not saving)");
  }
  console.log(`   writer: ${nSteps} steps, ${nJabs} with a jab`);
  if (!pySplitLines(script).some((l) => pyStrip(l) && !pyStrip(l).startsWith("#"))) {
    throw new RuntimeError("writer produced 0 narration lines (not saving)");
  }
  const matchDiag = diagnosticsOpt
    ?? (outPath ? path.join(path.dirname(path.resolve(outPath)), "match_diagnostics") : null);
  script = await matchPanels(script, obs, {
    block,
    perPanel: runPanel,
    wps,
    panelsDir,
    diagnosticsDir: matchDiag,
  });
  fs.writeFileSync(outPath, script);
  return script;
}

type StoryGenerate = (
  obs: ObsLike,
  bible: BibleLike,
  transcript: string,
  opts: Record<string, unknown>,
) => Promise<unknown>;
type CastContext = (obs: ObsLike, bible: BibleLike) => Array<Record<string, unknown>>;

/** Lazy module load, matching Python's function-local imports. */
async function loadModule(spec: string): Promise<Record<string, unknown>> {
  return (await import(spec)) as Record<string, unknown>;
}

function sumLen(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  return v.reduce((n, t) => n + pyLen(String(t)), 0);
}

/** `f"- {e}"`: a string stays as-is, a cached `{"event": ...}` prints Python repr. */
function pyStrValueForPrompt(e: unknown): string {
  if (isRecord(e) && typeof e.event === "string") return e.event;
  return pyStrVal(e);
}

// ---------------------------------------------------------------------------
// Steps -> script
// ---------------------------------------------------------------------------

const TAG_RE = /\s*@p\d+(?:_\d+)?/g;

/**
 * STEPS (line + optional jab) -> script lines. A jab becomes its own short line right
 * after its step, so the fact-then-comment rhythm comes from the output shape.
 * Returns (script, n_steps, n_jabs) or (null, 0, 0) when there are no steps.
 */
export function stepsToScript(txt: string): [string | null, number, number] {
  let d: unknown;
  try {
    d = parseJson(txt);
  } catch {
    return [null, 0, 0];
  }
  const steps = isRecord(d) ? (d.steps as unknown[]) : null;
  // Python truthiness: an empty list is falsy too.
  if (!steps || (Array.isArray(steps) && steps.length === 0)) return [null, 0, 0];
  const out: string[] = [];
  let beat: string | null = null;
  let n = 0;
  let ns = 0;
  let nj = 0;
  // JAB CEILING (shair, 2026-09-27: "a joke at every beat feels like trying too hard"):
  // the brief asks for <= 1 jab per 4 steps; code enforces it - a jab is kept only when
  // the last JAB_GAP steps carried none, and never beyond ceil(steps / JAB_GAP).
  const cap = Math.ceil(steps.length / JAB_GAP);
  let since = JAB_GAP;
  for (const st of steps) {
    if (!isRecord(st)) continue;
    const line = pyStrip(pyStrVal(st.line ?? "").replace(TAG_RE, ""));
    if (!line) continue;
    const b = pyStrip(
      pyStrVal(st.beat || "beat").toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    ).replace(/^_+|_+$/g, "").slice(0, 32);
    if (b !== beat) {
      n += 1;
      beat = b;
      out.push(`\n## BEAT b${String(n).padStart(2, "0")}_${b}`);
    }
    out.push(line);
    ns += 1;
    let jab = pyStrip(pyStrVal(st.jab ?? "").replace(TAG_RE, ""));
    since += 1;
    if (jab && (since < JAB_GAP || nj >= cap)) jab = "";
    if (jab) {
      since = 0;
      // @hold: a jab reacts to what is on screen, so the timeline keeps the previous
      // picture instead of cutting to a new one (and the matcher skips it).
      out.push(jab + " @hold");
      nj += 1;
    }
  }
  return [pyStrip(out.join("\n")) + "\n", ns, nj];
}

// ---------------------------------------------------------------------------
// Matcher constants
// ---------------------------------------------------------------------------

export const MATCH_ATTEMPTS = 3; // parse-level retries PER SAMPLE for the panel matcher
export const MATCH_SAMPLES = 1; // K - independent samples; the MODAL first panel wins
export const MATCH_CALL_BUDGET = 3; // hard ceiling on matcher CALLS per chapter
export const MATCH_AGREE_EARLY = 2; // stop sampling once this many agree on every anchor
export const USE_EVENT_PRIOR = false; // optional heuristic, OFF by default

/** Spoken word count (emotion tags like [angry] are not spoken). */
export function _spokenWords(line: string): number {
  return pySplit(line.replace(/\[[a-z ]+\]/g, "")).length;
}

/**
 * VISUAL MATCHING (opt-in MATCH_MODE=visual): route the ENTIRE eligible pool, in
 * reading order, to `visual_matcher.match_script` with `verify=True` and return its
 * fully validated script DIRECTLY.
 *
 * BOUNDED PROPOSAL + REVIEW, not a one-call promise. If the review is unavailable,
 * malformed or invalid the whole match FAILS - the unverified proposal is never
 * returned. There is NO fallback to the caption matcher on a missing image, moderation,
 * transport or validation failure: the exception propagates so the caller sees it.
 *
 * A script with no narration, or one whose every narration line is an explicit @hold,
 * has nothing to ground: it returns unchanged and makes no call. A non-hold script with
 * an empty eligible pool is a hard error, never a silently untagged story.
 */
export async function _matchPanelsVisual(
  script: string,
  obs: ObsLike,
  block: BlockLike | null,
  taken: Iterable<string>,
  wps: number,
  panelsDir: string | null | undefined,
  diagnosticsDir: string | null | undefined,
  semantic = false,
): Promise<string> {
  if (!panelsDir) throw new ValueError("visual mode requires panels_dir");
  const lines = pySplitLines(script);
  const nar = lines.filter((l) => pyStrip(l) && !pyStrip(l).startsWith("#"));
  if (!nar.length) return script;
  if (nar.every((l) => l.includes("@hold"))) return script;
  const takenSet = new Set(taken);
  const eligible: PanelRec[] = [];
  for (const p of obs.panels ?? []) {
    if (takenSet.has(String(p.id))) continue;
    if (_novisual(
      pyNumOr(p.art === undefined ? 1 : p.art, 1),
      sumLen(p.overlay),
      String(p.bubble_at ?? "").trim().toLowerCase(),
      sumLen(p.world),
    )) continue;
    if (p.promo_page === true || (block && block.panelFullPromo(p))) continue;
    eligible.push(p);
  }
  if (!eligible.length) throw new ValueError("visual mode: no eligible panels to offer");
  const visualMatcher = await loadModule("./visualMatcher.js");
  const extra: Record<string, unknown> = {};
  if (semantic) {
    extra.semantic = true;
    extra.source_context =
      panelTranscript(obs, block)
      + "\nEVENTS:\n"
      + pyJson(obs.events ?? [], { ensureAscii: false });
  }
  return (visualMatcher.match_script as VisualMatch)(script, eligible, panelsDir, {
    wps,
    min_panel_s: 1.2,
    diagnostics_dir: diagnosticsDir,
    verify: true,
    ...extra,
  });
}

type VisualMatch = (
  script: string,
  panels: PanelRec[],
  panelsDir: string,
  opts: Record<string, unknown>,
) => Promise<string>;

export interface MatchPanelsOptions {
  block?: BlockLike | null;
  taken?: Iterable<string>;
  perPanel?: number | null;
  wps?: number;
  panelsDir?: string | null;
  mode?: string | null;
  diagnosticsDir?: string | null;
}

/**
 * PANEL MATCHER. The DEFAULT (caption) route makes one meaning-based matcher call and
 * validates contiguity in code. The OPT-IN visual route (MATCH_MODE=visual) instead
 * forwards the whole eligible pool to `visual_matcher.match_script(..., verify=True)`.
 * Jab lines (@hold) are skipped on either route - they keep the picture already on screen.
 *
 * SEQUENCE (2026-10-03, stage 2). The offer is grouped BY PAGE so reading order is
 * structural in the prompt, and a code-side validator enforces the run rule afterwards.
 * Code validates: real ids, each used once (at RUN granularity), contiguity - then
 * EXTENDS the validated run forward, because validating alone made the slideshow worse.
 */
export async function matchPanels(
  script: string,
  obs: ObsLike,
  opts: MatchPanelsOptions = {},
): Promise<string> {
  const {
    block = null,
    taken = [],
    perPanel = null,
    wps = 3.2,
    panelsDir = null,
    diagnosticsDir = null,
  } = opts;
  const mode = opts.mode ?? process.env.MATCH_MODE ?? (panelsDir ? "semantic" : "caption");
  if (!["caption", "visual", "semantic"].includes(mode)) {
    throw new ValueError(`MATCH_MODE must be caption, visual or semantic, got ${pyRepr(mode)}`);
  }
  if (mode === "visual" || mode === "semantic") {
    return _matchPanelsVisual(
      script, obs, block, taken, wps, panelsDir, diagnosticsDir, mode === "semantic",
    );
  }
  const lines = pySplitLines(script);
  const idx: number[] = [];
  lines.forEach((l, i) => {
    if (pyStrip(l) && !pyStrip(l).startsWith("#") && !l.includes("@hold")) idx.push(i);
  });
  const byPid: Record<string, PanelRec> = {};
  const byKey: Record<string, OrderKey> = {};
  for (const p of obs.panels ?? []) {
    byPid[String(p.id)] = p;
    byKey[String(p.id)] = _orderKey(p);
  }
  const takenSet = new Set(taken);
  const showable: string[] = [];
  const rows: string[] = [];
  let curPage: number | null = null;
  for (const p of obs.panels ?? []) {
    const pid = String(p.id);
    if (takenSet.has(pid)) continue;
    if (_novisual(
      pyNumOr(p.art === undefined ? 1 : p.art, 1),
      sumLen(p.overlay),
      String(p.bubble_at ?? "").trim().toLowerCase(),
      sumLen(p.world),
    )) continue;
    if (p.promo_page === true || (block && block.panelFullPromo(p))) continue;
    showable.push(pid);
    // EVIDENCE = ARTWORK (shair, 2026-09-26): the matcher sees what each panel SHOWS,
    // never its bubble text - matching on bubble words picked the panel that SAYS a
    // thing instead of the one whose picture shows it.
    const ba = String(p.bubble_at ?? "none").trim().toLowerCase();
    // PAGE HEADING: MATCH_TASK promises "p43:" opens a page and the panels under it are
    // that page's panels in reading order. obs["panels"] arrives in slicer order, so
    // iterating it IS reading order - the heading is printed when the page changes.
    const pg = (byKey[pid] ?? FAR_KEY)[0];
    if (pg !== curPage) {
      curPage = pg;
      rows.push(`p${pg}:`);
    }
    const artRaw = p.art === undefined ? 1 : p.art;
    rows.push(
      `  ${pid} | art:${pyStrVal(artRaw)} | bubble:${ba} | `
      + `${String(p.visual ?? "").trim()}`,
    );
  }
  const emoRe = /\[[a-z ]+\]/g;
  const idxRank = new Map<number, number>();
  idx.forEach((i, k) => idxRank.set(i, k + 1));
  const numRows: string[] = [];
  lines.forEach((l, i) => {
    const st = pyStrip(l);
    if (st.startsWith("## BEAT")) numRows.push(st);
    else if (idxRank.has(i)) numRows.push(`${idxRank.get(i)}. ${pyStrip(l.replace(emoRe, ""))}`);
  });
  const numbered = numRows.join("\n");
  // EVENT MAP (2026-10-05, OPTIONAL - USE_EVENT_PRIOR=False by default). obs["events"] is
  // the reader's ORDERED list of what happens; the matcher, the one stage that picks the
  // picture, never saw it. Free: no call, no token, only words the reader already paid for.
  const epages = USE_EVENT_PRIOR
    ? _eventPages(obs.events ?? [], byKey, byPid, showable)
    : [];
  const evBlock = epages
    .map(([t, lo, hi], j) => `  E${j + 1} p${lo}-p${hi}  ${t}`)
    .join("\n") || "  (none reported)";
  // MATCH_TASK has placeholders {ch},{lines},{panels},{events_block}. USE_EVENT_PRIOR=False
  // (default) passes an empty events_block, so the prompt carries no event-map guidance.
  const prompt = pyFormat(MATCH_TASK, {
    ch: "this chapter",
    lines: numbered,
    panels: rows.join("\n"),
    events_block: USE_EVENT_PRIOR ? pyFormat(EVENT_MAP_BLOCK, { events: evBlock }) : "",
  });
  // CONSENSUS (2026-10-05, OPTIONAL EXPERIMENT). K samples of the same prompt, MODAL first
  // panel per line. Parse-retry semantics are unchanged and still per sample: an unparseable
  // answer retries MATCH_ATTEMPTS times and, if it never parses, casts NO VOTE.
  const votes: Array<Map<number, string[]>> = [];
  let lastErr: unknown = null;
  let calls = 0;
  while (votes.length < MATCH_SAMPLES && calls < MATCH_CALL_BUDGET) {
    const sample = votes.length + 1;
    let gotS: Map<number, string[]> | null = null;
    for (let attempt = 1; attempt <= MATCH_ATTEMPTS; attempt++) {
      if (calls >= MATCH_CALL_BUDGET) break;
      calls += 1;
      let r: Awaited<ReturnType<typeof call>>;
      try {
        r = await call([{ role: "user", content: [{ type: "text", text: prompt }] }], {
          maxTokens: 4000,
          temperature: 0.2,
          tag: "panel matcher",
          stage: "matcher",
        });
      } catch (e) {
        if (e instanceof FilterBlocked) throw e; // moderation: the caller's rescue path
        if (_blocked(e)) throw e;                // moderation-shaped error: same path
        lastErr = e;
        if (attempt < MATCH_ATTEMPTS) {
          console.error(
            `   matcher: sample ${sample} attempt ${attempt} call failed (${e}) - retrying`,
          );
        }
        continue;
      }
      try {
        const d = parseJson(r.choices[0]?.message?.content ?? "");
        gotS = new Map();
        const linesArr = isRecord(d) && Array.isArray(d.lines) ? (d.lines as unknown[]) : [];
        for (const x of linesArr) {
          if (!isRecord(x) || !isDigitStr(x.n)) continue;
          const ps = Array.isArray(x.panels) ? (x.panels as string[]) : [];
          gotS.set(Number.parseInt(pyStrVal(x.n), 10), ps);
        }
        if (!gotS.size) throw new Error("model returned 0 usable panel lines");
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < MATCH_ATTEMPTS) {
          console.error(
            `   matcher: sample ${sample} attempt ${attempt} unparseable output (${e}) - retrying`,
          );
        }
      }
    }
    if (!gotS) {
      console.error(
        `   matcher: sample ${sample} produced no parseable answer (${lastErr}) - no vote`,
      );
      continue;
    }
    votes.push(gotS);
    if (votes.length >= MATCH_AGREE_EARLY && _unanimous(votes)) {
      console.log(
        `   matcher: ${votes.length} samples already agree on every line's anchor `
        + `- stopping early (${calls} call(s) spent)`,
      );
      break;
    }
  }
  const matched = votes.length > 0;
  // writer_tag: a tag the CALLER already put on the line. Production hands matchPanels
  // lines with no tags (writeScript matches before _with_hook prepends the scout's hook),
  // but a hand-edited script and the writer-run-rule arms do carry one, and an explicit
  // choice is worth more than a tie between samples.
  const writerTag = new Map<number, string[]>();
  idx.forEach((i, k) => {
    writerTag.set(k + 1, [...lines[i]!.matchAll(/@(p\d+(?:_\d+)?)/g)].map((m) => m[1] as string));
  });
  const offered: Record<string, PanelRec> = {};
  for (const q of showable) offered[q] = byPid[q]!;
  let got: Map<number, string[]>;
  if (!matched) {
    got = new Map();
  } else {
    const [g, priorPicks] = _modalPanels(
      votes, idx.length, idx.map((i) => lines[i]!), offered, byKey, writerTag, epages,
    );
    got = g;
    console.log(
      `   matcher: CONSENSUS over ${votes.length}/${MATCH_SAMPLES} sample(s) `
      + `(${calls} call(s)) - modal first panel per line; ${priorPicks} line(s) needed `
      + `a tiebreak (writer's own tag, then the event-map prior, then lowest variance)`,
    );
  }
  const seen = new Set<string>(takenSet);
  let bad = 0, rep = 0, gap = 0, filled = 0, extra = 0;
  const assigned = new Map<number, string[]>();
  // pos = reading-order key -> id over EVERY obs panel (not just the showable offer),
  // and succ = key -> the key of the next picture that EXISTS (see `_succMap`). Both are
  // built over the FULL panel list on purpose: an unusable panel (NO-VISUAL, promo,
  // already spent) must still WALL the run, so `_extendRun` sees it, counts a refusal and
  // stops there, rather than stepping over it to the next picture.
  const pos = new Map<string, string>();
  for (const p of obs.panels ?? []) {
    const k = keyId(_orderKey(p));
    if (!pos.has(k)) pos.set(k, String(p.id));
  }
  const succ = _succMap(byKey);
  const offeredSet = new Set(showable);
  // PHASE 1 - VALIDATE the model's picks: eligible showable id, not yet spent, contiguous
  // run rule.
  let empties = 0;
  idx.forEach((i, k) => {
    const ok: string[] = [];
    for (let pid of got.get(k + 1) ?? []) {
      pid = pyStrip(String(pid).replace(/^@/, ""));
      if (!offeredSet.has(pid)) {
        bad += 1;
        continue;
      }
      if (seen.has(pid)) {
        rep += 1;
        continue;
      }
      ok.push(pid);
    }
    const [keptAll, dropped] = _contiguous(ok, byKey, succ);
    let kept = keptAll;
    const capI = _runCap(lines[i]!, perPanel, wps);
    if (kept.length > capI) kept = kept.slice(0, capI);
    gap += dropped.length;
    // ONLY the kept run is spent. A panel the model offered and the run rule rejected is
    // untouched supply, not a used panel.
    for (const q of kept) seen.add(q);
    assigned.set(i, kept);
    if (!kept.length) empties += 1;
  });
  // PHASE 2 - EXTEND single-panel anchors only when the model did not already return a
  // multi-panel run and the adjacent panel carries >=2 shared content stems.
  const free = new Set(showable.filter((q) => !seen.has(q)));
  let extAdded = 0, extRefused = 0, headAdded = 0;
  idx.forEach((i, k) => {
    const cur = assigned.get(i) ?? [];
    if (!cur.length || cur.length > 1 || (got.get(k + 1) ?? []).length > 1) return;
    const [run, added, refused, atHead] = _extendRun(
      cur, lines[i]!, free, byPid, byKey, pos, succ,
      _runCap(lines[i]!, perPanel, wps), empties,
    );
    assigned.set(i, run);
    for (const q of run) seen.add(q);
    extAdded += added;
    headAdded += atHead;
    extRefused += refused;
  });
  console.log(
    `   matcher: run extension +${extAdded} panel(s) into validated runs `
    + `(adjacent+unused, mean overlap within KEEP_TOL=${KEEP_TOL} of the anchor, `
    + `capped by the line's own word count and MAX_RUN=${MAX_RUN}); `
    + `${headAdded} prepended at the head; ${extRefused} candidate(s) refused`
    + (empties ? `; reserved ${empties} panel(s) for ${empties} empty beat(s)` : ""),
  );
  for (const i of idx) {
    if ((assigned.get(i) ?? []).length) continue;
    const run = _bestRun(
      lines[i]!, showable.filter((q) => !seen.has(q)), byPid, byKey,
      _runCap(lines[i]!, perPanel, wps), succ,
    );
    if (!run.length) continue;
    for (const q of run) seen.add(q);
    assigned.set(i, run);
    filled += 1;
    extra += run.length - 1;
  }
  if (!matched && showable.length) {
    const ordered = [...idx].sort((a, b) => {
      const d = _spokenWords(lines[b]!) - _spokenWords(lines[a]!);
      return d !== 0 ? d : a - b;
    });
    for (const i of ordered) {
      if (!showable.some((q) => !seen.has(q))) break;
      const run = _bestRun(
        lines[i]!, showable.filter((q) => !seen.has(q)), byPid, byKey,
        _runCap(lines[i]!, perPanel, wps), succ,
      );
      if (!run.length) continue;
      for (const q of run) seen.add(q);
      assigned.set(i, run);
      filled += 1;
      extra += run.length - 1;
    }
  }
  if (!matched) {
    console.error(
      `   matcher: LLM panel matcher FAILED - no parseable answer in `
      + `${MATCH_SAMPLES} sample(s) / ${MATCH_CALL_BUDGET} call budget `
      + `(${lastErr}) - ${filled} of ${idx.length} story lines filled by `
      + `contiguous-run word match (+${extra} extra panels); check matcher/model health`,
    );
  }
  let hasPriorPanel = false;
  for (const i of idx) {
    if (!(assigned.get(i) ?? []).length) {
      if (hasPriorPanel) {
        // Continuation/reaction line with zero visual match holds the active beat's
        // panel instead of displaying an arbitrary zero-evidence panel.
        lines[i] = pyRstrip(lines[i]!) + " @hold";
        continue;
      }
      // Very first story line needs an opening image if showable pool is non-empty.
      const fallback = showable.filter((q) => !seen.has(q)).slice(0, 1);
      if (fallback.length) {
        assigned.set(i, fallback);
        for (const q of fallback) seen.add(q);
        filled += 1;
      }
    }
    const a = assigned.get(i) ?? [];
    if (a.length) {
      hasPriorPanel = true;
      lines[i] = pyRstrip(lines[i]!) + a.map((p) => ` @${p}`).join("");
    }
  }
  let total = 0;
  for (const v of assigned.values()) total += v.length;
  console.log(
    `   matcher: ${total} panels on ${idx.length} story `
    + `lines | dropped ${bad} unknown, ${rep} repeat, ${gap} non-contiguous | `
    + `${filled} filled by run match`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Sequence helpers
// ---------------------------------------------------------------------------

const _STOPW = new Set(
  ("a an the to of in on is it was that this and but for with as at so he she his "
    + "her him they them their its be been by from up out into over just then when "
    + "while all one who what which there").split(" "),
);

/** (page, idx) of a panel record: the manifest-derived value reader stamps at assembly
 *  time, else the pure id parse. Same authority order as reader.panel_positions. */
const _FAR: OrderKey = FAR_KEY;

function keyId(k: OrderKey): string {
  return `${k[0]},${k[1]}`;
}

function sameKey(a: OrderKey | undefined, b: OrderKey): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

function cmpKey(a: OrderKey, b: OrderKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * The SAME 4-char content-word stems `_overlap` counts, so every comparison in this
 * module is over one word set and not three different ones.
 */
export function _textStems(t: unknown): Set<string> {
  const out = new Set<string>();
  const src = (typeof t === "string" ? t : "").toLowerCase();
  for (const m of src.matchAll(/[a-z]+/g)) {
    const w = m[0];
    if (!_STOPW.has(w) && w.length > 2) out.add(w.slice(0, 4));
  }
  return out;
}

/** one event may claim at most this FRACTION of the chapter's page span */
export const EVENT_PAGE_SPAN = 0.25;

/**
 * obs["events"] (reading order) -> [(text, lo_page, hi_page)] over the OFFER.
 *
 * THE PRIOR THE MATCHER NEVER HAD. This is free: no call, no new tokens, only words a
 * paid vision call already wrote. Two rules make it a MAP rather than a guess:
 *   1. an event's pages are the pages of the ARTWORK whose caption overlaps the event's
 *      own words (the same evidence rule as the offer: captions, never bubble text);
 *   2. the assignment is STRICTLY FORWARD - event j may only choose pages at or after
 *      event j-1's - and with no candidate left it INHERITS the previous page.
 * Each range is then widened by one page of REAL neighbours on each side. A PRIOR ONLY.
 */
export function _eventPages(
  events: unknown[],
  byKey: Record<string, OrderKey>,
  byPid: Record<string, PanelRec>,
  offer: string[],
): Array<[string, number, number]> {
  const order = [...offer].sort((a, b) => cmpKey(byKey[a] ?? _FAR, byKey[b] ?? _FAR));
  if (!order.length || !events.length) return [];
  const pages = [...new Set(order.map((q) => (byKey[q] ?? _FAR)[0]))].sort((a, b) => a - b);
  const span = Math.max(1, pages[pages.length - 1]! - pages[0]!);
  const scored: Array<[Array<[number, number]>, number]> = [];
  for (const e of events) {
    const ws = _textStems(e);
    const ovs = order.map(
      (q) => [(byKey[q] ?? _FAR)[0], _overlap(ws, byPid[q]?.visual)] as [number, number],
    );
    let best = 0;
    for (const [, o] of ovs) if (o > best) best = o;
    scored.push([ovs, best]);
  }
  const out: Array<[string, number, number]> = [];
  let prev = pages[0]!;
  scored.forEach(([ovs, best], j) => {
    // 60% of the best overlap, not just the argmax: a scene often gets two good panels
    // on two pages and the honest answer is "either".
    const ks = best > 0
      ? ovs.filter(([k, o]) => o >= Math.max(1, 0.6 * best) && k >= prev).map(([k]) => k)
      : [];
    let lo: number;
    let hi: number;
    if (ks.length) {
      lo = Math.min(...ks);
      hi = Math.max(...ks);
      if (hi - lo > EVENT_PAGE_SPAN * span) hi = lo + EVENT_PAGE_SPAN * span;
    } else {
      lo = hi = prev; // no evidence ahead: hold the last known page
    }
    prev = lo;
    // `events[j]`, NOT the `e` left over from the scoring loop above: the same
    // loop-variable-shadowing slip once made every event map to the last event.
    out.push([pyStrVal(events[j]), _pageNear(pages, lo, -1), _pageNear(pages, hi, 1)]);
  });
  return out;
}

/** The next page that EXISTS in `step` direction from pg (pages are numbered by 2 across
 *  the corpus, so arithmetic neighbours are usually absent - same defect `_succMap` names). */
export function _pageNear(pages: number[], pg: number, step: number): number {
  const ns = pages.filter((p) => (step > 0 ? p > pg : p < pg));
  if (!ns.length) return pg;
  return ns.reduce((a, b) => (Math.abs(b - pg) < Math.abs(a - pg) ? b : a));
}

/** The page range of the event this narration line is telling, or null when it matches no
 *  event. Overlap only, on the same stems, and only when it is a REAL overlap. */
export function _lineEventRange(
  line: string,
  epages: Array<[string, number, number]>,
): [number, number] | null {
  if (!epages.length) return null;
  const ws = _textStems(line);
  let best = 0;
  let bk: [number, number] | null = null;
  for (const [t, lo, hi] of epages) {
    const o = _overlap(ws, t);
    if (o > best) {
      best = o;
      bk = [lo, hi];
    }
  }
  return bk;
}

export function _firstPid(panels: readonly unknown[] | null | undefined): string | null {
  for (const p of panels ?? []) {
    const pid = pyStrip(String(p).replace(/^@/, ""));
    if (pid) return pid;
  }
  return null;
}

/** True when every sample that voted picked the SAME first panel for every line they all
 *  answered - the early-stop test. Requires the same line set as well as the same picks. */
export function _unanimous(votes: Array<Map<number, string[]>>): boolean {
  const keys = votes.map((v) => new Set(v.keys()));
  if (keys.some((k) => !sameNumSet(k, keys[0]!))) return false;
  for (const k of keys[0]!) {
    if (new Set(votes.map((v) => _firstPid(v.get(k)))).size !== 1) return false;
  }
  return true;
}

function sameNumSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * K samples -> one panel list per line, decided by the MODAL FIRST PANEL.
 *
 * Each line returns the WINNING SAMPLE'S FULL valid sequence (its anchor is the modal
 * first panel), never a truncated [pick]. A line with no VALID first panel in any sample
 * is left EMPTY so the caller's existing empty-line fallback fills it.
 *
 * Ties (every sample disagreed) resolve in this order:
 *   (a) a tag the CALLER already put on the line;
 *   (b) the event-map prior: the anchor that sits on a page of the event this line tells;
 *   (c) the LOWEST-VARIANCE pick - nearest the MEDIAN page of all the samples' answers.
 *
 * Returns [got, prior_picks].
 */
export function _modalPanels(
  votes: Array<Map<number, string[]>>,
  nLines: number,
  lineTexts: string[],
  byPid: Record<string, PanelRec>,
  byKey: Record<string, OrderKey>,
  writerTag: Map<number, string[]> | null = null,
  epages: Array<[string, number, number]> = [],
): [Map<number, string[]>, number] {
  const tags = writerTag ?? new Map<number, string[]>();
  const got = new Map<number, string[]>();
  let priorPicks = 0;
  for (let k = 1; k <= nLines; k++) {
    const cleaned: string[][] = [];
    for (const v of votes) {
      const seq: string[] = [];
      for (const p of v.get(k) ?? []) {
        const pid = pyStrip(String(p).replace(/^@/, ""));
        if (pid in byPid && !seq.includes(pid)) seq.push(pid);
      }
      if (seq.length) cleaned.push(seq);
    }
    if (!cleaned.length) {
      got.set(k, []); // no sample anchored this line: leave it empty
      continue;
    }
    const firsts = cleaned.map((seq) => seq[0]!);
    const cnt = new Map<string, number>();
    for (const p of firsts) cnt.set(p, (cnt.get(p) ?? 0) + 1);
    const top = Math.max(...cnt.values());
    const tied = pySorted([...cnt.entries()].filter(([, c]) => c === top).map(([q]) => q));
    const pick = tied.length === 1
      ? tied[0]!
      : _tiebreakPick(
        k, tied, firsts, byKey, tags.get(k) ?? [], epages,
        k - 1 < lineTexts.length ? lineTexts[k - 1]! : "",
      );
    if (tied.length > 1) priorPicks += 1;
    got.set(k, cleaned.find((seq) => seq[0] === pick) ?? [pick]);
  }
  return [got, priorPicks];
}

export function _tiebreakPick(
  _k: number,
  tiedIn: string[],
  firsts: string[],
  byKey: Record<string, OrderKey>,
  writerTags: string[],
  epages: Array<[string, number, number]>,
  line: string,
): string {
  for (const w of writerTags) {
    const q = pyStrip(String(w).replace(/^@/, ""));
    if (tiedIn.includes(q)) return q;
  }
  let tied = tiedIn;
  const rng = _lineEventRange(line, epages);
  if (rng) {
    const inside = tied.filter((q) => rng[0] <= (byKey[q] ?? _FAR)[0] && (byKey[q] ?? _FAR)[0] <= rng[1]);
    if (inside.length) tied = inside;
  }
  const sortedFirsts = firsts.map((q) => (byKey[q] ?? _FAR)[0]).sort((a, b) => a - b);
  const med = sortedFirsts[Math.floor(firsts.length / 2)]!;
  return tied.reduce((best, q) => {
    const a = Math.abs((byKey[q] ?? _FAR)[0] - med);
    const b = Math.abs((byKey[best] ?? _FAR)[0] - med);
    if (a !== b) return a < b ? q : best;
    return cmpKey(byKey[q] ?? _FAR, byKey[best] ?? _FAR) < 0 ? q : best;
  });
}

/** (page, idx) of a panel record: obs page/idx when both are ints, else the id parse. */
export function _orderKey(panel: PanelRec | null | undefined): OrderKey {
  const pg = (panel ?? {}).page;
  const ix = (panel ?? {}).idx;
  if (isPyInt(pg) && isPyInt(ix)) return [pg, ix];
  return panelOrderKey((panel ?? {}).id);
}

/**
 * The panels allowed to FOLLOW `key` on one narration line, by PURE PAGE ARITHMETIC:
 * the next panel inside its page, or the first panel of the next page (idx is 1..n per
 * page in every sliced page measured - 13,127 pages, 0 exceptions). Returns a tuple, not
 * one key. KEPT as the strict definition, and KEPT because `_contiguous` was measured
 * with it. It is NOT the successor rule in force: see `_succMap`.
 */
export function _succKeys(key: OrderKey): OrderKey[] {
  const [pg, ix] = key;
  return [[pg, ix + 1], [pg + 1, 1]];
}

/**
 * reading-order key -> the key of the NEXT PICTURE THAT EXISTS in the chapter.
 *
 * WHY NOT PAGE ARITHMETIC. `_succKeys` guesses the successor from the page number, which
 * is only right when the sliced page numbers have no holes. They have holes: measured
 * over the 146 chapters' 14,549 reading-order adjacent panel pairs, only 61.4% are
 * (pg, ix+1)/(pg+1, 1) neighbours, and 5,571 of the 5,595 misses are a page delta of
 * exactly 2 - the sliced corpus has no panel at all on most even pages. So p0003_1's real
 * next picture is p0005_1, and (2, 1) does not exist.
 *
 * WHAT IT STILL REFUSES: the successor is resolved against the panels that EXIST, so this
 * can never skip over, invent, or reorder a picture. A panel that exists but is unusable
 * (NO-VISUAL, promo, already spent) IS in this map and therefore still walls the run.
 * `pos`/`_succMap` are built over ALL obs panels, never over the showable subset.
 */
export function _succMap(byKey: Record<string, OrderKey>): Map<string, OrderKey> {
  const ks = Object.values(byKey).map((k) => [k[0], k[1]] as OrderKey).sort(cmpKey);
  const out = new Map<string, OrderKey>();
  for (let i = 0; i < ks.length - 1; i++) out.set(keyId(ks[i]!), ks[i + 1]!);
  return out;
}

/**
 * RUN RULE, enforced in code (a prompt is not a guarantee). Keep the FIRST panel - the
 * anchor, which may be from anywhere - then walk forward keeping only panels that are the
 * immediate reading-order successor of the previous KEPT panel. Never bridge a gap, never
 * restart mid-run, never reorder: a rejected panel and everything after it is cut.
 * Returns [kept, dropped]; a non-empty input always yields a non-empty kept.
 *
 * `succ` is the successor map from `_succMap`. It defaults to the strict page arithmetic
 * of `_succKeys`, so a caller with no chapter map keeps exactly the pre-stage-2 behaviour.
 */
export function _contiguous(
  pids: string[],
  byKey: Record<string, OrderKey>,
  succ: Map<string, OrderKey> | null = null,
): [string[], string[]] {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const pid of pids) {
    if (!kept.length) {
      kept.push(pid);
      continue;
    }
    const tail = byKey[kept[kept.length - 1]!] ?? _FAR;
    const key = byKey[pid] ?? _FAR;
    const good = succ === null
      ? _succKeys(tail).some((k) => sameKey(k, key))
      : sameKey(succ.get(keyId(tail)), key);
    if (good) kept.push(pid);
    else dropped.push(pid);
  }
  return [kept, dropped];
}

/**
 * RUN EXTENSION - grow a validated run at the TAIL instead of stopping at the cut.
 *
 * A panel joins the run while ALL of these hold:
 *   1. it is the immediate reading-order successor of the last kept panel;
 *   2. it is showable (in `free`) and UNUSED at run granularity;
 *   3. it adds word evidence: running MEAN overlap vs the line stays >= KEEP_TOL x the
 *      ANCHOR's overlap, and the panel's own overlap is >= 2 stems;
 *   4. the line stays inside its own `_runCap`;
 *   5. RESERVE: taking this panel must leave at least `reserve` unused showable panels.
 *
 * HEAD EXTENSION IS DISABLED (2026-10-05, branch experiment): nothing can precede
 * kept[0]. `pred`/`posmap` stay in the signature for callers.
 *
 * THE RUNNING MEAN IS `(m*n + o)/(n+1)`, NOT `(m + o)/(n+1)`: the shipped code used the
 * second form, which is the mean of a TWO-element list no matter how long the run is, and
 * silently capped every run at 2 panels. The same line in `_bestRun` had the same defect
 * and both are fixed together: they must agree, or the fill would hand out runs the
 * extension refuses.
 *
 * Returns [run, added, refused, at_head].
 */
export function _extendRun(
  keptIn: string[],
  line: string,
  free: Set<string>,
  byPid: Record<string, PanelRec>,
  byKey: Record<string, OrderKey>,
  pos: Map<string, string>,
  succ: Map<string, OrderKey>,
  cap: number,
  reserve = 0,
  _pred: Map<string, string> | null = null,
  _posmap: Record<string, string> | null = null,
): [string[], number, number, number] {
  let kept = keptIn;
  if (!kept.length) return [kept, 0, 0, 0];
  // A shipped script can cite an id this obs does not carry (an obs written before a
  // re-slice renumbered or dropped that panel). Extension has no anchor to measure
  // against in that case, so it must decline rather than raise.
  if (!(kept[0]! in byPid)) return [kept, 0, 0, 0];
  const ws = _lineWords(line);
  const anchor = _overlap(ws, byPid[kept[0]!]!.visual);
  let m = anchor;
  let n = kept.length;
  let added = 0;
  let refused = 0;
  const atHead = 0;
  // ---- 1. TAIL (forward) - the stage-2b rule, unchanged ----
  let tail = kept[kept.length - 1]!;
  while (n < cap) {
    const nkey = succ.get(keyId(byKey[tail] ?? _FAR));
    const nxt = nkey === undefined ? undefined : pos.get(keyId(nkey));
    if (nxt === undefined) break; // end of chapter: nothing to refuse
    if (!free.has(nxt)) {
      refused += 1; // spent (run-granular) or not showable
      break;
    }
    if (free.size - 1 < reserve) {
      refused += 1; // would starve a later empty beat
      break;
    }
    const o = _overlap(ws, byPid[nxt]?.visual);
    if (o < 2 || (m * n + o) / (n + 1) < KEEP_TOL * anchor) {
      refused += 1; // insufficient evidence (<2 stems), or dilutes the run
      break;
    }
    kept = kept.concat([nxt]);
    free.delete(nxt);
    m = (m * n + o) / (n + 1); // TRUE running mean
    n += 1;
    added += 1;
    tail = nxt;
  }
  return [kept, added, refused, atHead];
}

/** hard ceiling on one line's run, whatever its word count would justify */
export const MAX_RUN = 6;
/** LENGTH PRIOR: an extra panel multiplies a run's score by 1.5, so a longer run only
 *  wins where its MEAN overlap holds up. */
export const RUN_BONUS = 0.5;
/** keep extending only while the running mean stays within this of the anchor's overlap */
export const KEEP_TOL = 0.7;

/**
 * Unused showable panels -> the maximal contiguous reading-order runs they form.
 * Adjacency is the `_succMap` successor (next picture that exists), falling back to strict
 * `_succKeys` page arithmetic when no map is passed. A spent panel, a no-visual panel or a
 * missing PICTURE ends a run: one narration line is an unbroken slice of the chapter, so a
 * hole is a hole. (A hole in the page NUMBERING is not a hole in the pictures.)
 */
export function _runs(
  candidates: string[],
  byKey: Record<string, OrderKey>,
  succ: Map<string, OrderKey> | null = null,
): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  const ordered = [...candidates].sort((a, b) => cmpKey(byKey[a] ?? _FAR, byKey[b] ?? _FAR));
  for (const pid of ordered) {
    if (cur.length) {
      const tail = byKey[cur[cur.length - 1]!] ?? _FAR;
      const nxt = succ !== null
        ? (succ.get(keyId(tail)) ?? _FAR)
        : (_succKeys(tail).some((k) => sameKey(k, byKey[pid] ?? _FAR)) ? tail : _FAR);
      if (!sameKey(nxt, byKey[pid] ?? _FAR)) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(pid);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Content-word stems of a narration line (4-char stems, tags and emotion tags out). One
 *  word-set definition (`_textStems`) is shared with the event-map prior. */
export function _lineWords(line: string): Set<string> {
  return _textStems(line.replace(/@\S+/g, ""));
}

export function _overlap(ws: Set<string>, visual: unknown): number {
  const vs = _textStems(visual);
  let n = 0;
  for (const w of ws) if (vs.has(w)) n += 1;
  return n;
}

/**
 * How many pictures this line can HONESTLY hold. Two DIFFERENT divisors meet here:
 *
 *   - `run_panel` = words per CUT inside one line = RUN_S * voice speed (RUN_S = 1.25s).
 *     This is EDITORIAL: how finely the line's own seconds may be cut. It does NOT feed
 *     the chapter word budget, so raising it buys cuts without buying length.
 *   - `SHOT_MIN_S` (0.8s) = the PHYSICAL floor, mirrored from timeline.MIN_PANEL_S. Below
 *     it, timeline.build_shots drops the overflow tag - so a cap computed only from words
 *     will promise cuts the render cannot deliver.
 *
 * cap = max(1, min(physical, MAX_RUN, editorial))
 */
export function _runCap(line: string, runPanel: number | null = null, wps = 3.2): number {
  const wpp = runPanel || Math.round(RUN_S * wps);
  const w = _spokenWords(line);
  const editorial = Math.min(MAX_RUN, Math.floor(w / Math.max(1, wpp)));
  const physical = Math.max(1, Math.trunc(pyFloorDiv(w / wps, SHOT_MIN_S)));
  return Math.max(1, Math.min(physical, MAX_RUN, editorial));
}

/**
 * The CONTIGUOUS RUN of unused showable panels that best illustrates `line`.
 *
 * Scoring, on artwork only: 4-char-stem content-word overlap between the line and each
 * panel's `visual`. For every run, and for every panel in it as the anchor, walk FORWARD
 * while the next panel adds word evidence AND the running mean stays within KEEP_TOL of
 * the anchor's overlap, then score the slice as mean_overlap x (1 + RUN_BONUS per extra
 * panel). Longer therefore wins only when its mean holds.
 *
 * Returns [] when nothing in the pool overlaps the line at all (TODO.md 2.1: the old
 * `runs[0][:1]` zero-overlap fallback put unrelated art on screen and is gone).
 */
export function _bestRun(
  line: string,
  candidates: string[],
  byPid: Record<string, PanelRec>,
  byKey: Record<string, OrderKey>,
  cap: number = MAX_RUN,
  succ: Map<string, OrderKey> | null = null,
): string[] {
  if (!candidates.length) return [];
  const ws = _lineWords(line);
  const capN = Math.max(1, cap);
  let best: string[] = [];
  let bscore = 0.0;
  for (const run of _runs(candidates, byKey, succ)) {
    const ovs = run.map((q) => _overlap(ws, byPid[q]?.visual));
    for (let s = 0; s < ovs.length; s++) {
      const anchor = ovs[s]!;
      if (!anchor) continue; // no evidence for this anchor: nothing to extend
      let m = anchor;
      let n = 1;
      while (n < Math.min(capN, run.length - s)) {
        const nxt = ovs[s + n]!;
        if (!nxt || (m * n + nxt) / (n + 1) < KEEP_TOL * anchor) break;
        m = (m * n + nxt) / (n + 1); // TRUE running mean (see _extendRun)
        n += 1;
      }
      const sc = m * (1 + RUN_BONUS * (n - 1));
      if (sc > bscore) {
        best = run.slice(s, s + n);
        bscore = sc;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// snake_case aliases (callers ported from writer.py)
// ---------------------------------------------------------------------------

export const find_blocked = findBlocked;
export const panel_transcript = panelTranscript;
export const writer_dialogue_lookup = writerDialogueLookup;
export const _script_of = _scriptOf;
export const _hook_moves = _hookMoves;
export const previous_window = previousWindow;
export const _steps_to_script = stepsToScript;
export const _stepsToScript = stepsToScript;
export const _match_panels_visual = _matchPanelsVisual;
export const match_panels = matchPanels;
export const write_script = writeScript;
export const _spoken_words = _spokenWords;
export const _text_stems = _textStems;
export const _event_pages = _eventPages;
export const _page_near = _pageNear;
export const _line_event_range = _lineEventRange;
export const _first_pid = _firstPid;
export const _modal_panels = _modalPanels;
export const _tiebreak_pick = _tiebreakPick;
export const _order_key = _orderKey;
export const _succ_keys = _succKeys;
export const _succ_map = _succMap;
export const _extend_run = _extendRun;
export const _line_words = _lineWords;
export const _run_cap = _runCap;
export const _best_run = _bestRun;
export const _blocked_ = _blocked;
export { _novisual as novisual };
