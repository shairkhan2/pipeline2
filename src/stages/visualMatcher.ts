/**
 * visualMatcher.ts - TypeScript port of manhwa-pipeline/pipeline/visual_matcher.py.
 *
 * Generic automatic full-chapter image matching (OPT-IN candidate selector).
 *
 * One vision call per attempt (max two) picks the panels that visibly show each line of a
 * frozen narration script. The caller owns eligibility/promo/no-visual filtering; this
 * module imports no writer code and makes no live call until wired.
 *
 * Corrects the scratch probe: explicit @hold is the ONLY hold signal, old @tags are
 * stripped from model input, the full raw narration is enumerated, at most TWO grounded
 * panels per multiclause line, and every choice is validated - malformed output is retried
 * once, never silently truncated or replaced by adjacent art.
 *
 * PARITY NOTES (Python/PIL -> sharp)
 *  - Contact sheets and detail cards are composed with `sharp` + an SVG header layer.
 *    Cell geometry, label placement, thumbnail fit (`fit: inside`, no enlargement) and
 *    centring match `_build_sheets` / `_build_details`; JPEG quality 92 / 90 match.
 *  - PIL `Image.LANCZOS` -> sharp kernel `lanczos3`.
 *  - Python `str.splitlines()` / `str.strip()` / `str.split()` use Python whitespace, so
 *    `PY_WS`, `pySplitLines`, `pySplit`, `pyStrip` carry the class explicitly.
 *  - Python `\d` is Unicode `\p{Nd}`; the tag regexes use `u` + `\p{Nd}` and a Unicode
 *    word-boundary lookaround (JS `\b` is ASCII-only).
 *  - Python `%`-formatting with `%(name)s` / `%(name)d` is reproduced by `pyPercentFormat`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { call, log, pageBlocks, parseJson, type ChatMessage, type Completion } from "../llm/client.js";

// ---------------------------------------------------------------------------
// Constants (verbatim from visual_matcher.py)
// ---------------------------------------------------------------------------
// ---- Prompt strings: VERBATIM from manhwa-pipeline/pipeline/visual_matcher.py ----
export const SYS = "You match story narration to comic panel images. You answer in strict JSON.";
export const SEMANTIC_RULES = "\nSEMANTIC SELECTION CONTRACT (overrides the mandatory-picture rule above):\n- Match WHO does WHAT, to WHOM, in the CURRENT scene. A shared name or prop is\n  not action evidence. Preserve the primary action before considering a reaction.\n- BEAT COHERENCE: lines sharing the same [beat: ...] tag belong to ONE scene turn.\n  Keep their panels within that scene's visual sequence (progressing through setup,\n  arrival, reaction, exchange and reveal) rather than jumping to an unrelated\n  scene's setting mid-beat.\n- Source facts below establish history and motives, NOT that an assigned image\n  literally depicts them. Do not confuse a memory, an intention and present action.\n- An ABSTRACT continuation may use basis \"context\" with panels [] ONLY when\n  continuing the immediately previous displayed scene is appropriate; this becomes\n  a hold. Never do this to hide a concrete action with missing evidence.\n- If no offered image supports a concrete action, use basis \"missing\", panels [],\n  and explain the missing action in evidence. Do not invent a match or pad the line.\n- The reviewer may correct a missing proposal. Any missing action still present\n  after review blocks publication; it never silently borrows adjacent artwork.\n- Repeated justified panels and non-adjacent action/reaction pairs are allowed.\n- Evidence must quote the supported spoken clause and describe the visible act,\n  participants and setting. Captions are fallible lookup, not visual proof.\n- A reported offscreen event is NOT direct visual evidence. For explicit recollections\n  or accounts, use basis \"context\" with the appropriate source scene/aftermath and\n  say what is NOT visible. Never claim an unseen creature or action is in the image.\nSOURCE FACTS (observations, dialogue and events; not selection hints):\n%s\n";
export const PROMPT = "You are shown %(nids)d comic (manhwa) panels from ONE chapter on %(ns)d contact-sheet\nimage(s). Each panel's exact id is printed directly ABOVE its artwork; sheets are laid\nout left-to-right, top-to-bottom. Only ids printed on the sheets may be used.\n\nFULL STORY (beat headers and narration, old tags stripped; beat headers are context\nonly and are NOT lines to answer):\n%(story)s\n\nThe full narration, in spoken order (%(nl)d lines; [HOLD] lines are spoken\ninterjections that introduce no new visual):\n%(narr)s\n\nFor EVERY line choose the panel(s) whose VISIBLE artwork best supports it.\n- \"direct\": the artwork literally shows the line's action, object or expression.\n- \"context\": the line is abstract (a feeling, intention or consequence) with no\n  literal picture; choose the scene that best carries it. Never claim a picture\n  literally shows an intent, and never treat a caption as proof - the art controls.\n- [HOLD] lines: panels [] and basis \"hold\".\n- Lines sharing the same [beat: ...] label belong to the same scene turn; keep\n  their panels within that scene's progression unless the line explicitly flashes\n  back or shifts setting.\n- A non-hold line needs at least one panel. Use TWO panels ONLY when the line\n  contains distinct clauses that depict, say, an action plus a setting or a\n  reaction; list them in spoken-clause order, not as unrelated adjacent art.\n- Cover the line's PRIMARY action. Do not settle for a mere prop, a leg or a\n  background when a panel shows the full action.\n- No arbitrary fill: if one panel genuinely covers the line, one is enough.\n- A wordless panel is fine; a panel where someone merely talks is weaker.\n- Prefer the correct panel even if another line already used it; repeated panels\n  are allowed when justified. Do NOT force page order or uniqueness to hide a\n  mismatch, and do NOT leave a relevant panel unused.\n%(fix)s\nReply with STRICT JSON ONLY (no prose, no fence):\n{\"lines\":[{\"n\":<int>,\"panels\":[\"<printed pid>\",...],\"basis\":\"direct\"|\"context\"|\"hold\",\"evidence\":\"<visible action/object>\"}]}\n- exactly one entry for EVERY line, in order; evidence must be non-empty.\n- panels: [] for [HOLD] lines, 1..max ids otherwise.\n\nPANEL LEGEND (id — full visual caption; may be wrong or incomplete):\n%(legend)s";
export const REVIEW_PROMPT = "You are REVISING a first-pass panel assignment. You are shown %(nids)d comic (manhwa)\npanels from ONE chapter on %(ns)d contact-sheet image(s). Each panel's exact id is\nprinted directly ABOVE its artwork; sheets are left-to-right, top-to-bottom. Only ids\nprinted on the sheets may be used.\n\nFULL STORY (beat headers and narration, old tags stripped; beat headers are context\nonly and are NOT lines to answer):\n%(story)s\n\nThe full narration, in spoken order (%(nl)d lines; [HOLD] lines are spoken\ninterjections that introduce no new visual):\n%(narr)s\n\nFIRST-PASS PROPOSALS (FALLIBLE - do NOT trust them; each is one unverified guess):\n%(proposals)s\n\nInspect the ACTUAL images and produce the CORRECT assignment for EVERY line.\n- The first pass is only a guess. Reject any proposal whose image does not visibly\n  support the line. You may KEEP, DROP or REPLACE any proposed image, and you may\n  choose ANY offered image - never only the proposed one.\n- Each retained image must VISIBLY support a specific spoken clause: in \"evidence\",\n  quote the clause it supports and name the visible action/object that shows it.\n- \"context\": for an abstract clause with no literal picture, choose the scene that\n  best carries it; the image must match the CURRENT setting. Never match a\n  scene-context to the NEXT beat's setting (e.g. a later bedroom) or to unrelated\n  worldbuilding.\n- Lines sharing the same [beat: ...] label belong to the same scene turn; reject\n  a proposal that jumps to an unrelated scene's setting mid-beat.\n- Reject SECONDARY FILLER: an extra image added only to pad a line. At most TWO\n  grounded panels, and only when the line has distinct clauses; two is never a quota.\n- Reject the WRONG EVENT or REACTION, and reject a ground-rumble/warning image shown\n  BEFORE its trigger, unless the line explicitly previews or flashes back.\n- Use the ACTUAL narrative causality and beat context - not hard page chronology.\n- [HOLD] lines: panels [] and basis \"hold\".\n- A non-hold line needs at least one panel. Do not leave a relevant panel unused,\n  and do not force uniqueness.\n%(fix)s\nReply with STRICT JSON ONLY (no prose, no fence):\n{\"lines\":[{\"n\":<int>,\"panels\":[\"<printed pid>\",...],\"basis\":\"direct\"|\"context\"|\"hold\",\"evidence\":\"<quoted clause + visible action>\"}]}\n- exactly one entry for EVERY line, in order; evidence must be non-empty.\n- panels: [] for [HOLD] lines, 1..max ids otherwise.\n\nPANEL LEGEND (id — full visual caption; may be wrong or incomplete):\n%(legend)s";

export const COLS = 4;
export const ROWS = 3;
export const TW = 448;
export const TH = 560;
export const LABEL_H = 34;
/** Selection (<=2) + review (<=1) incl. parse/schema retries. */
export const VISION_BUDGET = 3;

// ---------------------------------------------------------------------------
// Python string helpers
// ---------------------------------------------------------------------------
const PY_WS =
  "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_SPLIT_RE = new RegExp(`[${PY_WS}]+`, "g");
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const PY_W = "[\\p{L}\\p{Nd}\\p{Nl}\\p{No}_]";
const UWB = `(?:(?<=${PY_W})(?!${PY_W})|(?<!${PY_W})(?=${PY_W}))`;

/** Python `str.strip()`. */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/** Python `str.split()` with no args. */
function pySplit(s: string): string[] {
  return s.split(PY_SPLIT_RE).filter((x) => x !== "");
}

/** Python `str.splitlines()`: \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029. */
function pySplitLines(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
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

/** Python `repr()` for the scalars these messages carry. */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const hasSingle = v.includes("'");
    const hasDouble = v.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    const body = v.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`);
    return `${quote}${body}${quote}`;
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (isRecord(v)) {
    return `{${Object.entries(v).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  }
  return String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python `str(x)` for the `or ""` idiom used on panel captions. */
function strOrEmpty(v: unknown): string {
  if (v === undefined || v === null || v === "" || v === 0 || v === false) return "";
  return String(v);
}

/** Python `%`-formatting for the two vision templates: `%(name)s` / `%(name)d` only. */
export function pyPercentFormat(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/%\((\w+)\)([sd])/g, (_m, name: string, conv: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`KeyError: '${name}'`);
    }
    const value = params[name]!;
    if (conv === "d") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`%d format: a number is required, not str`);
      return String(Math.trunc(n));
    }
    return typeof value === "string" ? value : String(value);
  });
}

/** Python `template % arg` for the single positional `%s` in SEMANTIC_RULES. */
export function pyPercentArgs(template: string, args: ReadonlyArray<string | number>): string {
  let k = 0;
  return template.replace(/%(?:%|([sd]))/g, (m, conv?: string) => {
    if (m === "%%") return "%";
    if (k >= args.length) throw new Error("not enough arguments for format string");
    const value = args[k++]!;
    if (conv === "d") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error("%d format: a number is required, not str");
      return String(Math.trunc(n));
    }
    return typeof value === "string" ? value : String(value);
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

export class SemanticMatchError extends ValueError {
  /** Stop a chapter, not a whole-writer retry or adjacent-art fallback. */
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "SemanticMatchError";
  }
}

// ---------------------------------------------------------------------------
// Regexes (Python parity: \d -> \p{Nd}, \b -> UWB, `u` flag)
// ---------------------------------------------------------------------------
const TAG_RE = new RegExp(`[${PY_WS}]*@(?:p\\p{Nd}+(?:_\\p{Nd}+)?|hold)${UWB}`, "gu");
const HOLD_RE = new RegExp(`@hold${UWB}`, "u");
const EMO_RE = /\[[a-z ]+\]/g;

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------
export interface ScriptLine {
  raw: string;
  kind: "other" | "narration";
  n?: number;
  text?: string;
  hold?: boolean;
  beat?: string | null;
}

/**
 * Raw lines. Narration lines (nonblank, not '#'-headed) get a 1..n index over the COMPLETE
 * raw narration, holds included. A line is a hold only when it carries an explicit @hold;
 * untagged narration is not.
 */
export function _parseLines(script: string): ScriptLine[] {
  const lines: ScriptLine[] = [];
  let n = 0;
  let curBeat: string | null = null;
  for (const raw of pySplitLines(script)) {
    const s = pyStrip(raw);
    if (!s || s.startsWith("#")) {
      if (s.startsWith("## BEAT")) curBeat = pyStrip(s.slice(7)) || null;
      lines.push({ raw, kind: "other" });
      continue;
    }
    n += 1;
    lines.push({
      raw,
      kind: "narration",
      n,
      text: pyStrip(s.replace(TAG_RE, "")),
      hold: HOLD_RE.test(s),
      beat: curBeat,
    });
  }
  return lines;
}

export const _parse_lines = _parseLines;

export function _spokenWords(text: string): number {
  return pySplit(text.replace(EMO_RE, "")).length;
}

export const _spoken_words = _spokenWords;

/** At most TWO grounded panels; shorter lines get one. */
export function _capFor(text: string, wps: number, minPanelS: number): number {
  return Math.min(2, Math.max(1, Math.trunc(_spokenWords(text) / wps / minPanelS)));
}

export const _cap_for = _capFor;

/** Python `float()` for a JSON scalar: bool -> 1/0, str with inf/nan/underscores allowed. */
function pyFloat(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(t)) return NaN;
    if (/^[+-]?(?:\d(?:_?\d)*)?(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(t)) {
      const digits = t.replace(/_/g, "");
      if (/\d/.test(digits)) return Number(digits);
    }
    throw new ValueError(`could not convert string to float: ${pyRepr(value)}`);
  }
  throw new ValueError(`float() argument must be a string or a number, not '${typeof value}'`);
}

/** Coerce a words/sec or min-seconds rate to a finite positive float. */
export function _rate(value: unknown, name: string): number {
  let v: number;
  try {
    v = pyFloat(value);
  } catch {
    throw new ValueError(`${name} must be a finite positive number, got ${pyRepr(value)}`);
  }
  if (!Number.isFinite(v) || v <= 0) {
    throw new ValueError(`${name} must be a finite positive number, got ${pyRepr(value)}`);
  }
  return v;
}

export const _rate_ = _rate;

const PANEL_EXTS = [".jpg", ".png", ".jpeg", ".webp"] as const;

export function _panelFile(pid: string, panelsDir: string): string | null {
  for (const ext of PANEL_EXTS) {
    const p = join(panelsDir, pid + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

export const _panel_file = _panelFile;

// ---------------------------------------------------------------------------
// Contact sheets + detail cards (sharp composite + SVG text header)
// ---------------------------------------------------------------------------
const LABEL_FONT = "DejaVu Sans, Liberation Sans, sans-serif";
const LABEL_SIZE = 26;
/** PIL draws with a TOP-LEFT anchor; librsvg ignores `dominant-baseline`, so the SVG
 * baseline is offset by the digit/cap height (~0.77em) to land the ink at the same y. */
const LABEL_ASCENT = Math.round(0.77 * LABEL_SIZE); // 20 at size 26

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Decode a panel, shrink it to fit `boxW` x `boxH` preserving aspect (never enlarging),
 * and return its JPEG pixels plus the fitted size.
 */
async function fitted(file: string, boxW: number, boxH: number): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const out = await sharp(file, { limitInputPixels: false })
    .rotate()
    .toColorspace("srgb")
    .resize({ width: boxW, height: boxH, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .jpeg({ quality: 95 })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
}

/**
 * One labelled, uncropped cell per offered panel; id printed above the art.
 * Every offered id appears exactly once across the sheets.
 */
export async function _buildSheets(
  ids: string[],
  panelsDir: string,
  outDir: string,
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const per = COLS * ROWS;
  const sheets: string[] = [];
  for (let si = 0; si < ids.length; si += per) {
    const composites: sharp.OverlayOptions[] = [];
    const svg: string[] = [];
    for (const [k, pid] of ids.slice(si, si + per).entries()) {
      const r = Math.floor(k / COLS);
      const c = k % COLS;
      const x0 = c * TW;
      const y0 = r * TH;
      svg.push(
        `<rect x="${x0 + 0.5}" y="${y0 + 0.5}" width="${TW - 1}" height="${TH - 1}" ` +
          `fill="none" stroke="rgb(170,170,170)" stroke-width="1" shape-rendering="crispEdges"/>`,
      );
      svg.push(
        `<text x="${x0 + 6}" y="${y0 + 4 + LABEL_ASCENT}" font-family="${LABEL_FONT}" ` +
          `font-size="${LABEL_SIZE}" font-weight="bold" fill="rgb(0,0,0)">${xmlEscape(pid)}</text>`,
      );
      const file = _panelFile(pid, panelsDir);
      if (!file) throw new FileNotFoundError(`missing panel image: ${pid}`);
      const im = await fitted(file, TW - 8, TH - LABEL_H - 6);
      composites.push({
        input: im.data,
        left: x0 + Math.floor((TW - im.width) / 2),
        top: y0 + LABEL_H + Math.floor((TH - LABEL_H - 6 - im.height) / 2),
      });
    }
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * TW}" height="${ROWS * TH}">${svg.join("")}</svg>`,
        "utf8",
      ),
      left: 0,
      top: 0,
    });
    const p = join(outDir, `gallery_${String(Math.floor(si / per) + 1).padStart(2, "0")}.jpg`);
    await sharp({
      create: {
        width: COLS * TW,
        height: ROWS * TH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 92 })
      .toFile(p);
    sheets.push(p);
  }
  return sheets;
}

export const _build_sheets = _buildSheets;

/** Readable, uncropped finalist images. Labels stay separate from artwork. */
export async function _buildDetails(
  ids: string[],
  panelsDir: string,
  outDir: string,
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (const pid of ids) {
    const file = _panelFile(pid, panelsDir);
    if (!file) throw new FileNotFoundError(`missing panel image: ${pid}`);
    const im = await fitted(file, 1000, 1600);
    const width = Math.max(300, im.width);
    const height = im.height + 44;
    const header =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="0" width="${width}" height="44" fill="rgb(255,255,255)"/>` +
      `<text x="8" y="${4 + LABEL_ASCENT}" font-family="${LABEL_FONT}" font-size="${LABEL_SIZE}" ` +
      `font-weight="bold" fill="rgb(0,0,0)">${xmlEscape(pid)}</text></svg>`;
    const path = join(outDir, `${pid}.jpg`);
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        { input: im.data, left: 0, top: 44 },
        { input: Buffer.from(header, "utf8"), left: 0, top: 0 },
      ])
      .jpeg({ quality: 90 })
      .toFile(path);
    paths.push(path);
  }
  return paths;
}

export const _build_details = _buildDetails;

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------
/** Tag-stripped original story for the model: beat headers KEPT, narration with old @tags
 * removed, raw line numbering preserved as context. */
export function _storyText(lines: ScriptLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === "narration") out.push(`${l.n}. ${l.text}`);
    else out.push(pyStrip(l.raw));
  }
  return out.join("\n");
}

export const _story_text = _storyText;

export function _beatTag(l: ScriptLine): string {
  return l.beat ? `[beat: ${l.beat}] ` : "";
}

export const _beat_tag = _beatTag;

export type Legend = ReadonlyArray<readonly [string, string]>;

export function _buildPrompt(
  nar: ScriptLine[],
  holds: ReadonlySet<number>,
  legend: Legend,
  nSheets: number,
  nIds: number,
  caps: Record<number, number>,
  story: string,
  error?: string | null,
): string {
  const rows = nar.map(
    (l) =>
      `${l.n}. ${_beatTag(l)}${holds.has(l.n as number) ? "[HOLD] " : `[max ${caps[l.n as number]}] `}${l.text}`,
  );
  let fix = "";
  if (error) {
    fix =
      `\nYOUR PREVIOUS ANSWER WAS REJECTED: ${error}\n` +
      "Resubmit the COMPLETE JSON for every line, fixing only that. Do not invent panel ids.\n";
  }
  return pyPercentFormat(PROMPT, {
    nids: nIds,
    ns: nSheets,
    nl: nar.length,
    story,
    narr: rows.join("\n"),
    fix,
    legend: legend.map(([p, c]) => `${p} — ${c}`).join("\n"),
  });
}

export const _build_prompt = _buildPrompt;

export function _buildReviewPrompt(
  nar: ScriptLine[],
  holds: ReadonlySet<number>,
  legend: Legend,
  nSheets: number,
  nIds: number,
  caps: Record<number, number>,
  story: string,
  picks: Record<number, Pick>,
  error?: string | null,
): string {
  const rows = nar.map(
    (l) =>
      `${l.n}. ${_beatTag(l)}${holds.has(l.n as number) ? "[HOLD] " : `[max ${caps[l.n as number]}] `}${l.text}`,
  );
  const prows = nar.map((l) => {
    const rec = picks[l.n as number]!;
    return `${l.n}. ${_beatTag(l)}${l.text} -> ${rec.panels.join(" ") || "(none)"} [${rec.basis}]`;
  });
  let fix = "";
  if (error) {
    fix =
      `\nYOUR PREVIOUS REVIEW WAS REJECTED: ${error}\n` +
      "Resubmit the COMPLETE JSON for every line, fixing only that. Do not invent panel ids.\n";
  }
  return pyPercentFormat(REVIEW_PROMPT, {
    nids: nIds,
    ns: nSheets,
    nl: nar.length,
    story,
    narr: rows.join("\n"),
    proposals: prows.join("\n"),
    fix,
    legend: legend.map(([p, c]) => `${p} — ${c}`).join("\n"),
  });
}

export const _build_review_prompt = _buildReviewPrompt;

// ---------------------------------------------------------------------------
// Vision call
// ---------------------------------------------------------------------------
async function _vision(prompt: string, sheets: string[]): Promise<Completion> {
  const msg: ChatMessage[] = [
    { role: "system", content: SYS },
    {
      role: "user",
      content: [{ type: "text", text: prompt }, ...(await pageBlocks(sheets, 1680))],
    },
  ];
  return call(msg, { maxTokens: 4000, temperature: 0.0, retries: 1, tag: "visual_match", lane: "vision" });
}

function completionContent(c: Completion): string {
  const v = c?.choices?.[0]?.message?.content;
  if (typeof v !== "string") throw new Error("missing message content");
  return v;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export interface Pick {
  n: number;
  panels: string[];
  basis: string;
  evidence: string;
  _coalesce?: boolean;
}

export interface ValidateResult {
  ok: boolean;
  error: string | null;
  picks: Record<number, Pick> | null;
}

function _reject(reason: string): ValidateResult {
  return { ok: false, error: reason, picks: null };
}

const BASIS = ["direct", "context", "hold"] as const;
const BASIS_SEMANTIC = ["direct", "context", "hold", "missing"] as const;

/**
 * Strict validation. Returns {"ok","error","picks"}. Any duplicate / out-of-range / float /
 * bool index, invalid basis, empty evidence, unoffered id, within-line duplicate, over-cap
 * or hold violation is rejected with a reason the retry prompt can quote. Nothing is
 * silently fixed.
 *
 * Python `_validate`. The review phase reuses this SAME validator, so `_validateReview` is
 * a named alias for it rather than a second contract.
 */
export function _validateSelection(
  data: unknown,
  lines: ScriptLine[],
  offer: readonly string[],
  caps: Record<number, number>,
  holds: ReadonlySet<number>,
  semantic = false,
): ValidateResult {
  const nar = lines.filter((l) => l.kind === "narration");
  const ns = new Set<number>(nar.map((l) => l.n as number));
  if (!isRecord(data) || !Array.isArray(data.lines)) {
    return _reject("output is not an object with a lines list");
  }
  const offerSet = new Set(offer);
  const seen: Record<number, Pick> = {};
  for (const x of data.lines as unknown[]) {
    if (!isRecord(x)) return _reject("a line entry is not an object");
    const n = x.n;
    if (typeof n === "boolean" || typeof n !== "number" || !Number.isInteger(n)) {
      return _reject(`index n must be an integer, got ${pyRepr(n)}`);
    }
    if (!ns.has(n)) return _reject(`index n=${n} is out of range`);
    if (Object.prototype.hasOwnProperty.call(seen, n)) return _reject(`duplicate index n=${n}`);
    const basis = x.basis;
    const allowed: readonly string[] = semantic ? BASIS_SEMANTIC : BASIS;
    if (typeof basis !== "string" || !allowed.includes(basis)) {
      return _reject(`invalid basis ${pyRepr(basis)} at n=${n}`);
    }
    const ev = x.evidence;
    if (typeof ev !== "string" || !pyStrip(ev)) return _reject(`empty evidence at n=${n}`);
    const rawPans = x.panels;
    if (!Array.isArray(rawPans) || rawPans.some((p) => typeof p !== "string")) {
      return _reject(`panels must be a list of ids at n=${n}`);
    }
    const pans = (rawPans as string[]).map((p) => pyStrip(p));
    if (holds.has(n)) {
      if (basis !== "hold" || pans.length) {
        return _reject(`source hold n=${n} must be basis hold with no panels`);
      }
      seen[n] = { n, panels: [], basis: "hold", evidence: pyStrip(ev) };
      continue;
    }
    if (basis === "hold") return _reject(`non-hold line n=${n} cannot be basis hold`);
    if (semantic && basis === "missing") {
      if (pans.length) return _reject(`missing action n=${n} must have no panels`);
      seen[n] = { n, panels: [], basis, evidence: pyStrip(ev) };
      continue;
    }
    if (semantic && basis === "context" && pans.length === 0) {
      seen[n] = { n, panels: [], basis, evidence: pyStrip(ev) };
      continue;
    }
    if (pans.length === 0) return _reject(`non-hold line n=${n} has no panel`);
    for (const p of pans) {
      if (!offerSet.has(p)) return _reject(`panel ${pyRepr(p)} at n=${n} is not offered`);
    }
    if (pans.length !== new Set(pans).size) return _reject(`duplicate panels within n=${n}`);
    if (pans.length > caps[n]!) {
      return _reject(`n=${n} offers ${pans.length} panels, cap is ${caps[n]}`);
    }
    seen[n] = { n, panels: pans, basis, evidence: pyStrip(ev) };
  }
  const missing = [...ns].filter((n) => !Object.prototype.hasOwnProperty.call(seen, n)).sort((a, b) => a - b);
  if (missing.length) return _reject(`missing indices: ${missing.join(",")}`);
  let displayed = false;
  for (const l of nar) {
    const rec = seen[l.n as number]!;
    if (semantic && rec.basis === "context" && rec.panels.length === 0 && !displayed) {
      return _reject(`context hold n=${l.n} has no previous displayed scene`);
    }
    if (rec.panels.length) displayed = true;
  }
  return { ok: true, error: null, picks: seen };
}

export const _validate_selection = _validateSelection;

/** The independent-review phase is validated by the SAME contract (Python `_validate`). */
export function _validateReview(
  data: unknown,
  lines: ScriptLine[],
  offer: readonly string[],
  caps: Record<number, number>,
  holds: ReadonlySet<number>,
  semantic = false,
): ValidateResult {
  return _validateSelection(data, lines, offer, caps, holds, semantic);
}

export const _validate_review = _validateReview;

// ---------------------------------------------------------------------------
// match_panels
// ---------------------------------------------------------------------------
export interface PanelRecord {
  id: string;
  visual?: unknown;
  [k: string]: unknown;
}

export interface MatchOptions {
  wps?: unknown;
  /** Python kwarg name; wins over `minPanelS` when both are given. */
  min_panel_s?: unknown;
  minPanelS?: unknown;
  diagnostics_dir?: string | null;
  diagnosticsDir?: string | null;
  verify?: boolean;
  semantic?: boolean;
  source_context?: string;
  sourceContext?: string;
}

export interface MatchDiagnostics {
  offer: string[];
  choices: Record<string, string[]>;
  usage: Array<Record<string, unknown>>;
  calls: number;
  phases: string[];
  semantic: boolean;
  records: Record<number, Pick>;
  inferred_context_holds: number[];
  spoken_units: boolean;
}

const UNITS_EDIT =
  "\nSPOKEN-UNIT EDIT: each numbered line is a separately voiced event-sized unit with " +
  "its own real audio duration. Choose ONE image for that exact moment, not two images " +
  "split equally. A BEAT can span many units/images. Match first appearances, reactions, " +
  "exchanges and reveals individually in spoken order. Do not anticipate the next event. " +
  "Reuse only when the same image really carries the continuing event; choose an available " +
  "more specific moment when the narration progresses.\n";
const FINALIST_NOTE =
  "\nAdditional individually labelled finalist images follow the full gallery. Inspect " +
  "these readable originals, not only thumbnails. You may still choose ANY gallery image.\n";
const RESELECTED = "Inspect the newly reselected closeups before approving them.";
const FINAL_CLOSEUP_PREFIX =
  "\nFINAL CLOSEUP CHECK: the proposal has already been revised against the full gallery. " +
  "Inspect its new closeups now. KEEP supported choices, DROP filler, or mark a concrete " +
  "action missing. Do not begin another gallery search. Only select images with readable " +
  "closeups already supplied: ";
const FINAL_CLOSEUP_SUFFIX =
  ". Never approve an unsupported choice just to fit the call budget.\n";

/**
 * Return the narration script with validated @pid tags (holds keep @hold).
 *
 * panels: already-eligible list of {"id", "visual", ...} dicts, in offer order.
 * Raises before any call when a panel image is missing; raises after at most two vision
 * calls when the model cannot produce a valid answer.
 *
 * verify=false (default) is byte-for-byte the old behaviour: at most two selection calls.
 * verify=true adds an OPTIONAL second, INDEPENDENT review phase: after the first valid
 * selection the same eligible pool + full story is re-sent in ONE fresh user message (never
 * a continuation of the first chat), and the reviewer may keep, drop or reselect ANY offered
 * image. The review is validated by the SAME validator before use; if it is unavailable,
 * malformed or invalid the whole match FAILS - the unverified first pass is never returned.
 * Total vision budget <= 3 calls including parse/schema retries.
 */
export async function matchPanels(
  script: string,
  panels: PanelRecord[],
  panelsDir: string,
  opts: MatchOptions = {},
): Promise<string> {
  const wps = _rate(opts.wps === undefined ? 3.2 : opts.wps, "wps");
  const rawMin = opts.min_panel_s !== undefined ? opts.min_panel_s : opts.minPanelS;
  const minPanelS = _rate(rawMin === undefined ? 1.2 : rawMin, "min_panel_s");
  const diagnosticsDir = opts.diagnostics_dir ?? opts.diagnosticsDir ?? null;
  const verify = Boolean(opts.verify);
  const semantic = Boolean(opts.semantic);
  const sourceContext = opts.source_context ?? opts.sourceContext ?? "";
  const matchError = semantic ? SemanticMatchError : ValueError;
  if (semantic && !verify) {
    throw new ValueError("semantic selection requires independent review");
  }
  const lines = _parseLines(script);
  const nar = lines.filter((l) => l.kind === "narration");
  const holds = new Set<number>(nar.filter((l) => l.hold).map((l) => l.n as number));
  const units = semantic && pySplitLines(script).includes("# STORY_UNITS v1");
  if (units && nar.some((l) => !l.hold && _spokenWords(l.text as string) > 24)) {
    throw new SemanticMatchError("oversized story unit: split the spoken event before matching");
  }
  const caps: Record<number, number> = {};
  for (const l of nar) {
    caps[l.n as number] = units ? 1 : _capFor(l.text as string, wps, minPanelS);
  }
  const offer = panels.map((p) => p.id);
  if (offer.length !== new Set(offer).size) throw new ValueError("duplicate panel ids in offer");
  if (offer.length === 0) throw new ValueError("no panels offered");
  const missing = offer.filter((pid) => _panelFile(pid, panelsDir) === null);
  if (missing.length) {
    throw new FileNotFoundError(`missing panel image(s): ${missing.join(",")}`);
  }

  let tmp: string | null = null;
  let work: string;
  if (diagnosticsDir) {
    work = diagnosticsDir;
    mkdirSync(work, { recursive: true });
  } else {
    const base = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();
    tmp = mkdtempSync(join(base, "visual-matcher-"));
    work = tmp;
  }
  try {
    const sheets = await _buildSheets(offer, panelsDir, join(work, "galleries"));
    const legend: Legend = panels.map((p) => [p.id, pyStrip(strOrEmpty(p.visual))]);
    const story = _storyText(lines);
    const usage: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const attempts: Array<{ phase: string; prompt: string; response: string }> = [];
    let calls = 0;
    let picks: Record<number, Pick> | null = null;
    let error: string | null = null;

    const _attempt = async (
      basePrompt: string,
      phase: string,
      images?: string[],
    ): Promise<[Record<number, Pick> | null, string | null]> => {
      let prompt = basePrompt;
      if (semantic) prompt += pyPercentArgs(SEMANTIC_RULES, [sourceContext]);
      if (units) prompt += UNITS_EDIT;
      const r = await _vision(prompt, images ?? sheets);
      calls += 1;
      phases.push(phase);
      usage.push((r.usage as Record<string, unknown>) ?? {});
      attempts.push({ phase, prompt, response: completionContent(r) });
      if (diagnosticsDir) {
        writeFileSync(join(work, "attempts.json"), JSON.stringify(attempts, null, 1), "utf8");
      }
      let data: unknown;
      try {
        data = parseJson(completionContent(r));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return [null, `unparseable JSON: ${msg.slice(0, 120)}`];
      }
      const res = _validateSelection(data, lines, offer, caps, holds, semantic);
      return [res.ok ? res.picks : null, res.error];
    };

    // --- phase 1: selection (at most 2 calls) -------------------------
    for (let i = 0; i < 2; i++) {
      const prompt = _buildPrompt(nar, holds, legend, sheets.length, offer.length, caps, story, error);
      [picks, error] = await _attempt(prompt, "select");
      if (picks !== null) break;
    }
    log(`visual_matcher: ${calls} call(s), usage=${JSON.stringify(usage)}`);
    if (picks === null) {
      throw new matchError(`visual matcher failed after ${calls} call(s): ${error}`);
    }

    // --- phase 2 (opt-in): independent review of the first proposals ---
    if (verify) {
      let first = picks;
      let reviewImages = sheets;
      const detailSeen = new Set<string>();
      if (semantic) {
        const finalists = offer.filter((pid) =>
          Object.values(first).some((rec) => rec.panels.includes(pid)),
        );
        for (const pid of finalists) detailSeen.add(pid);
        reviewImages = sheets.concat(
          await _buildDetails(finalists, panelsDir, join(work, "details")),
        );
      }
      let reviewed = false;
      for (let i = 0; i < 2; i++) {
        if (calls >= VISION_BUDGET) break;
        let prompt = _buildReviewPrompt(
          nar, holds, legend, sheets.length, offer.length, caps, story, first, error,
        );
        if (semantic) {
          prompt += FINALIST_NOTE;
          if (error === RESELECTED) {
            prompt +=
              FINAL_CLOSEUP_PREFIX +
              [...detailSeen].sort().join(", ") +
              FINAL_CLOSEUP_SUFFIX;
          }
        }
        const [rev, rerr] = await _attempt(prompt, "review", reviewImages);
        if (rev !== null) {
          const unseen = semantic
            ? new Set(
                Object.values(rev).flatMap((rec) => rec.panels).filter((pid) => !detailSeen.has(pid)),
              )
            : new Set<string>();
          if (unseen.size) {
            // A re-selection needs readable inspection too. No unbounded loop: if the
            // remaining budget cannot cover it, fail closed below.
            reviewImages = reviewImages.concat(
              await _buildDetails([...unseen].sort(), panelsDir, join(work, "details")),
            );
            for (const pid of unseen) detailSeen.add(pid);
            first = rev;
            error = RESELECTED;
            continue;
          }
          picks = rev;
          reviewed = true;
          break;
        }
        error = rerr;
      }
      if (!reviewed) {
        throw new matchError(`visual review failed after ${calls} call(s): ${error}`);
      }
    }
    const unresolved = Object.values(picks)
      .filter((rec) => rec.basis === "missing")
      .map((rec) => rec.n)
      .sort((a, b) => a - b);
    if (unresolved.length) {
      throw new matchError(
        `semantic matcher: unsupported visual actions at lines ${unresolved.join(",")}`,
      );
    }

    // A CONTEXT line that exactly repeats the immediately preceding single-panel choice
    // becomes @hold, so downstream never borrows that (unseen) art again.
    let prevPick: string | null = null;
    const inferred: number[] = [];
    for (const l of nar) {
      const rec = picks[l.n as number]!;
      if (l.hold) continue; // explicit hold: the last displayed panel is unchanged
      if (semantic && rec.basis === "context" && rec.panels.length === 0) {
        rec._coalesce = true;
        inferred.push(l.n as number);
        continue;
      }
      if (rec.basis === "context" && rec.panels.length === 1 && prevPick === rec.panels[0]) {
        rec._coalesce = true;
        inferred.push(l.n as number);
        continue; // coalesced hold: the last displayed panel is unchanged
      }
      prevPick = rec.panels[rec.panels.length - 1]!; // normal line: it displays its last panel
    }

    const out: string[] = [];
    for (const l of lines) {
      if (l.kind !== "narration") {
        out.push(l.raw);
        continue;
      }
      const rec = picks[l.n as number]!;
      const tag =
        l.hold || rec._coalesce
          ? "@hold"
          : rec.panels.map((p) => `@${p}`).join(" ");
      out.push(`${l.text} ${tag}`);
    }
    const result = out.join("\n") + "\n";
    let nPanels = 0;
    for (const l of nar) {
      const rec = picks[l.n as number]!;
      if (!(l.hold || rec._coalesce)) nPanels += rec.panels.length;
    }
    const nStory = nar.filter((l) => !l.hold).length;
    console.log(
      `   matcher [${semantic ? "semantic" : "visual"}]: ${nPanels} panel(s) on ${nStory} ` +
        `story line(s) (${inferred.length} context hold(s), ${calls} vision call(s))`,
    );

    if (diagnosticsDir) {
      const choices: Record<string, string[]> = {};
      for (const n of Object.keys(picks).map(Number).sort((a, b) => a - b)) {
        choices[String(n)] = picks[n]!.panels;
      }
      const diag: MatchDiagnostics = {
        offer,
        choices,
        usage,
        calls,
        phases,
        semantic,
        records: picks,
        inferred_context_holds: inferred,
        spoken_units: units,
      };
      writeFileSync(join(work, "diagnostics.json"), JSON.stringify(diag, null, 1), "utf8");
    }
    return result;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

export const match_panels = matchPanels;
export const matchScript = matchPanels;
export const match_script = matchPanels;

export default {
  matchPanels,
  _parseLines,
  _buildSheets,
  _buildDetails,
  _validateSelection,
  _validateReview,
  _capFor,
  _rate,
  _panelFile,
  _storyText,
  _beatTag,
  _buildPrompt,
  _buildReviewPrompt,
  _spokenWords,
};
