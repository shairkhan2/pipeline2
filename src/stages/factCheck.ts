/**
 * factCheck.ts - TypeScript port of manhwa-pipeline/pipeline/fact_check.py.
 *
 * Fact-trace + dubbing checker for panel-unit scripts.
 * - every number/age in prose must exist in the transcript
 * - every @pXXXX_N tag must exist
 * - DUB: >=8 consecutive OVERLAY-bubble words reproduced in a narration line,
 *   UNLESS the run sits inside quotation marks in that line (an attributed, deliberate
 *   LAW 4 quote). WORLD text (system windows/screens) is exempt: showing+voicing it
 *   together is the design. Plus an advisory (never an issue) count of the connective tic.
 * - ATTITUDE TAIL + MIND-READ FRAME: printed advisories, never issues.
 * - PERSONA LAW: P1 is an ISSUE; P2/P3/P4 and the STRUCTURE signature are advisories.
 *
 * Hiring-test tool + slip catcher. NOT a per-script correction loop (user principle).
 * The UNGROUNDED lint below is regex word-matching and is MEASURED TO MISLEAD (F1 0.35
 * on a 189-line hand-labelled set). See pipeline/tools/ground_judge.py for the paid,
 * opt-in per-line grounding audit; it deliberately does NOT replace this check - this
 * one runs on every chapter and must stay free, offline and deterministic.
 *
 * PARITY NOTES (Python -> JS regex)
 *  - Python `(?i)`/re.I  -> the `i` flag.
 *  - Python `\d` is Unicode `\p{Nd}`; Python `\w` is `str.isalnum()` + '_', i.e.
 *    `[\p{L}\p{Nd}\p{Nl}\p{No}_]`; Python `\b` is a boundary on THAT class. JS `\b`
 *    is ASCII-only, so every Python `\b` becomes the UWB/UWBE lookarounds and every
 *    `\d`/`\w` becomes its Unicode class, with the `u` flag enabled.
 *  - Python `\s` is `str.isspace()` (includes \x1c-\x1f and \x85, excludes BOM); JS
 *    `\s` differs, so `WS`/`WSP` carry the Python class explicitly.
 *  - Python `$` (no MULTILINE) also matches just before a trailing newline; JS `$`
 *    does not, so trailing anchors use PY_END.
 *  - `round(x, n)` / `f"{x:.nf}"` use correctly-rounded round-half-even on the exact
 *    binary value; `pyRoundFixed` reproduces it with BigInt exact arithmetic.
 *  - `sorted()` is code-point order (see cmpCodePoints).
 */
import { EMOTION_TAGS } from "../contracts/briefs.js";

// ---------------------------------------------------------------------------
// Python character classes and anchors
// ---------------------------------------------------------------------------
const PY_WS =
  "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const WS = `[${PY_WS}]`;          // Python \s
const WSP = `[${PY_WS}]+`;        // Python \s+
const PY_W = "[\\p{L}\\p{Nd}\\p{Nl}\\p{No}_]"; // Python \w
const WP = `${PY_W}+`;            // Python \w+
const DP = "\\p{Nd}+";            // Python \d+
// Python \b is a real BOUNDARY (word char on exactly one side), not "not followed
// by a word char": the difference shows up after a construct that can match a
// non-word character, e.g. `\bcut\s+to\s+(?!the chase)\b` in "Cut to a high-end ...".
const UWB = `(?:(?<=${PY_W})(?!${PY_W})|(?<!${PY_W})(?=${PY_W}))`;
const UWBE = UWB;
const PY_END = "(?=\\n?$)";       // Python $ (no MULTILINE)

// ---------------------------------------------------------------------------
// Python string helpers
// ---------------------------------------------------------------------------

/** Code-point lexicographic compare (Python str ordering). */
export function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const as = Array.from(a);
  const bs = Array.from(b);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ca = as[i].codePointAt(0) as number;
    const cb = bs[i].codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

/** Python str.strip() (Python whitespace, not JS). */
function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** Python str.lstrip(). */
function pyLstrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+`), "");
}

/** Python str.split() with no args: runs of whitespace, leading/trailing dropped. */
function pySplit(s: string): string[] {
  return s.split(new RegExp(WSP, "g")).filter((x) => x !== "");
}

/** Python str.splitlines(): \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029. */
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

/** Python slicing by code points. */
function pySlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

/** Python repr() for a str (single quotes unless it holds ' and no "). */
function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = quote;
  for (const ch of s) {
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Exact Python float rounding / fixed formatting (round-half-even)
// ---------------------------------------------------------------------------

function doubleParts(x: number): { neg: boolean; num: bigint; den: bigint } {
  if (x === 0) return { neg: Object.is(x, -0), num: 0n, den: 1n };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const sign = (hi >>> 31) === 1;
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (expBits === 0) {
    exp = -1074; // subnormal
  } else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  let num = mant;
  let den = 1n;
  if (exp >= 0) num = mant << BigInt(exp);
  else den = 1n << BigInt(-exp);
  return { neg: sign, num, den };
}

/**
 * Python `f"{x:.n}"` / `round(x, n)` rendered as a string: correctly rounded,
 * half-to-even, on the exact binary value of `x`.
 */
export function pyRoundFixed(x: number, n: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const { neg, num, den } = doubleParts(x);
  const scale = 10n ** BigInt(n);
  const scaled = num * scale;
  let q = scaled / den;
  const r = scaled % den;
  const twice = r * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && q % 2n === 1n) q += 1n;
  let s = q.toString();
  if (n > 0) {
    s = s.padStart(n + 1, "0");
    s = s.slice(0, s.length - n) + "." + s.slice(s.length - n);
  }
  return (neg ? "-" : "") + s;
}

/** Python round(x, n). */
export function pyRound(x: number, n: number): number {
  return Number(pyRoundFixed(x, n));
}

// ---------------------------------------------------------------------------
// Constants (verbatim from Python)
// ---------------------------------------------------------------------------
export const STOPWORD: ReadonlySet<string> = new Set(
  ("the and for with from that this these those then there here what when how why " +
    "because but about into over under not just like would could should than them they " +
    "your their what's isn't aren't wasn't weren't doesn't didn't won't can't said says " +
    "himself herself").split(" "));

export const WORD_NUMS: Readonly<Record<string, string>> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", eleven: "11", twelve: "12", "thirty-three": "33", "thirty-day": "33",
};

export const PHRASES: Readonly<Record<string, string>> = { "ten thousand": "10000" };

const PANEL_TAG_SRC = `@p(${DP.slice(0, -1)}{4})_(${DP})`;

// ---------------------------------------------------------------------------
// norm / stripEmotion
// ---------------------------------------------------------------------------

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

const KNOWN_EMOTION = new Set<string>(EMOTION_TAGS as readonly string[]);

/**
 * Emotion tags are delivery, not prose - remove before fact checks.
 * Unknown bracket items stay visible for the tag lint.
 */
export function stripEmotion(scriptTxt: string): { text: string; bad: string[] } {
  const bad: string[] = [];
  const text = scriptTxt.replace(/\[([a-z][a-z ]{2,20})\]/g, (m, g1: string) => {
    const inner = pyStrip(g1).toLowerCase();
    if (KNOWN_EMOTION.has(inner)) return " ";
    bad.push(inner);
    return m;
  });
  return { text, bad };
}

// ---------------------------------------------------------------------------
// CONNECTIVES (the connective tic, counted)
// ---------------------------------------------------------------------------
export const CONNECTIVES: readonly string[] = ["because", "so", "but", "until", "which is why"];

export interface ConnectiveReport {
  /** lines read (no blank lines, no # headers) */
  nLines: number;
  /** per-token counts, in CONNECTIVES order */
  counts: Record<string, number>;
  /** lines carrying at least one connective */
  withAny: number;
  /** lines OPENING with one */
  openAny: number;
}

/**
 * THE CONNECTIVE TIC, counted. LAW 6 used to name these five tokens as the
 * mechanism; a closed list of surface tokens is the most actionable text in the
 * whole brief. LAW 6 now requires the link in the MEANING and names none of them,
 * so this is how we see whether that worked.
 */
export function connectives(scriptTxt: string): ConnectiveReport {
  const lines = pySplitLines(scriptTxt).filter(
    (l) => l.trim() !== "" && !pyLstrip(l).startsWith("#"));
  const counts: Record<string, number> = {};
  for (const t of CONNECTIVES) counts[t] = 0;
  let withAny = 0;
  let openAny = 0;
  const openRe = new RegExp(
    `^${WS}*(because|so|but|until|which is why)${UWBE}`, "u");
  for (const l of lines) {
    const low = l.replace(new RegExp(`@p${DP}(?:_${DP})?|\\[[a-z ]+\\]`, "gu"), "")
      .toLowerCase();
    for (const t of CONNECTIVES) {
      const n = (low.match(new RegExp(`${UWB}${escapeRegex(t)}${UWBE}`, "gu")) ?? []).length;
      counts[t] += n;
      if (n) {
        withAny += 1;
        break;
      }
    }
    if (openRe.test(low)) openAny += 1;
  }
  return { nLines: lines.length, counts, withAny, openAny };
}

// ---------------------------------------------------------------------------
// ATTITUDE TAIL + MIND-READ FRAME (2026-10-04) - ADVISORY, NEVER AN ISSUE.
// ---------------------------------------------------------------------------

const _HEAD =
  "(?:vow|vows|vowing|swear|swears|swearing|promise|promises|promising|" +
  "resolve|resolves|resolving|decide|decides|deciding|refuse|refuses|refusing|" +
  "intend|intends|intending|determine|determines|determining|pledge|pledges|" +
  "realize|realizes|realizing|realise|realises|realising)";

export const STANCE = new RegExp(`${UWB}(?:is determined|are determined|${_HEAD})${UWBE}`, "giu");
export const RIDER = new RegExp(
  `${UWB}(?:vowing|swearing|promising|resolving|deciding|refusing|` +
  `intending|determining|pledging|realizing|realising)${UWBE}`, "iu");
export const VOWHEAD = new RegExp(
  `${UWB}(?:vow|vows|swear|swears|promise|promises|pledge|pledges|` +
  `resolve|resolves)${UWBE}`, "iu");
export const STATE_RIDER = new RegExp(
  `${UWB}(?:leaving|sending|setting|putting)${WSP}(?:him|her|them|me|us|it|[a-z]+)${WSP}` +
  `(?:screaming|crying|sobbing|laughing|smiling|standing|sitting|waiting|watching|` +
  `looking|holding|burning|shaking|free|loose|alone|helpless|grieving|hanging|` +
  `bleeding|drowning|gasping|staring|behind)${UWBE}`, "iu");
export const NOMORE = new RegExp(
  `^(?:and${WSP}|so${WSP}|then${WSP})?no (?:more|longer)${WSP}${WP}ing${UWBE}`, "iu");
export const RELPRON = new RegExp(`${UWB}(?:that|which|who|whose)${UWBE}[^,]{0,24}${PY_END}`, "iu");
export const SUBORD = new RegExp(
  `${UWB}(?:if|when|because|whether|than|after|before|since|unless|until|` +
  `once|as|instead of|the moment|whenever)${UWBE}`, "iu");
export const SUBORD_OPEN = new RegExp(
  `^(?:and${WSP}|so${WSP}|then${WSP}|but${WSP})?(?:if|when|because|whether|` +
  `than|after|before|since|unless|until|once|as|whenever)${UWBE}`, "iu");
export const WHCLAUSE = new RegExp(`${UWB}(?:how|what|who|where|why)${UWBE}`, "iu");
const PERSON = "(?:he|she|they|him|her|his|hers|their|them|i|me|we|us|you)";
const FINITE =
  "(?:will|won't|'ll|is|are|was|were|can|could|must|would|should|'s|" +
  "has|have|had|does|do|did|doesn't|can't|cannot|needs|needs|plan|plans)" + PY_W + "*";
export const PASTFACT = new RegExp(
  `^(?:(?:${PERSON})${WSP})?(?:was|were|did|had|saw|took|made|` +
  `gave|got|came|went|said|told|killed|ordered|sent|paid|left|ran|` +
  `hit|found|knew|meant|helped|owned|fought|lost|won|broke|brought|` +
  `caught|held|sold|wrote|stood|slew|wore|tore|ate|drank|drove|` +
  `burned|built|died|never|always|he'd|she'd|they'd|'d)${UWBE}`, "iu");
export const STANDING = new RegExp(
  `${UWB}(?:protect|saves?|saving|avenge|revenge|defend|defends|guard|` +
  `stands?|fight|fights|honour|honor|trust|prove|forgive|remember|` +
  `owe|survive|last|answer|serve|keep|belong|stay|stays|show|shows|` +
  `win|wins|lose|loses|take|takes|tell|tells|give|gives|pay|pays|` +
  `find|finds|make|makes|come|comes)${UWBE}`, "iu");
export const KEEPING_POST = new RegExp(
  `${UWB}keep(?:s|ing)?${WSP}(?:watch|guard|guards|watching|his post|` +
  `the line|going|at it|track|tabs? on)${UWBE}`, "iu");
export const TAILSEP = new RegExp(
  `${WS}*(?:,|;|${UWB}and${UWBE}|${UWB}but${UWBE}|${UWB}then${UWBE}|${UWB}so${UWBE}|` +
  `${UWB}because${UWBE}|${UWB}which${UWBE}|[-\u2013\u2014])${WS}*`, "iu");
export const SPEECH = new RegExp(
  `${UWB}(?:say|says|said|saying|shout|shouts|shouted|shouting|yell|yells|` +
  `yelled|scream|screams|screamed|ask|asks|asked|tell|tells|told|reply|` +
  `replies|argue|argues|beg|begs|bark|barks|order|orders|mutter|mutters|` +
  `grunt|grunts|roar|roars|warn|warns|answer|answers|respond|responds|` +
  `cry|cries|whisper|whispers|snarl|snarls|chant|chants|insist|insists|` +
  `repeat|repeats|add|adds|announce|announces|announcing|declare|declares|` +
  `boast|boasts|claim|claims)${PY_W}*${UWBE}`, "iu");
export const SIMILE = new RegExp(
  `${UWB}(?:like|as if|as though)${WSP}(?:${WP}['\u2019]?${WSP}){0,3}${PY_END}`, "iu");
export const MINDFRAME = new RegExp(
  `${UWB}it hits (?:him|her|them|me|us)${UWBE}` +
  `|${UWB}(?:realiz|realis)${WP}${WSP}(?:that${WSP}|he${WS}|she${WS}|it${WS}|they${WS}|his${WS}|her${WS}|their${WS}|` +
  `the${WS}|this${WS}|why${WS}|how${WS}|what${WS}|only${WS}|has${WS}|was${WS}|just${WS}|already${WS})` +
  `|${UWB}understands?${WSP}(?:that|why|how|what)${UWBE}` +
  `|${UWB}knows${WSP}(?:that|why|how|what|now|who|where)${UWBE}` +
  `|${UWB}(?:realiz|realis)${WP}ing${UWBE}` +
  `|${UWB}finally gets it${UWBE}` +
  `|${UWB}it clicks${UWBE}` +
  `|${UWB}makes? (?:him|her|them) (?:realiz|realis)e${UWBE}`, "giu");
export const CLAUSE_START = new RegExp(
  `(?:,|;|${UWB}and${UWBE}|${UWB}but${UWBE}|${UWB}while${UWBE}|${UWB}because${UWBE}|${UWB}since${UWBE}|${UWB}so${UWBE}|` +
  `${UWB}then${UWBE}|${UWB}as${UWBE}|${UWB}though${UWBE})${WS}*[^,]*${PY_END}`, "iu");
export const FINITED = new RegExp(
  `${UWB}(?:is|are|was|were|has|have|had|says?|said|tells?|told|asks?|` +
  `asked|shouts?|yells?|screams?|begs?|roars?|grunts?)${UWBE}`, "iu");

// ---------------------------------------------------------------------------
// PERSONA LAW
// ---------------------------------------------------------------------------
export type OutsideFrameRule = readonly [RegExp, string];

export const OUTSIDE_FRAME: readonly OutsideFrameRule[] = [
  [new RegExp(`${UWB}we${WSP}(?:see|watch|get to see|are watching)${UWBE}`, "iu"), "we-as-viewer"],
  [new RegExp(`${UWB}first thing we${UWBE}`, "iu"), "we-as-viewer"],
  [new RegExp(`${UWB}(?:this|the)${WSP}(?:chapter|episode|webtoon)${UWBE}`, "iu"), "media-word"],
  [new RegExp(`${UWB}in this (?:episode|video|chapter)${UWBE}`, "iu"), "media-word"],
  [new RegExp(
    `${UWB}(?:the|this)${WSP}scene${WSP}(?:cuts?|shifts?|opens|closes|begins|ends|goes|is|was)${UWBE}`,
    "iu"), "media-word"],
  [new RegExp(
    `${UWB}cuts?${WSP}(?:away|back)${UWBE}|${UWB}cut${WSP}to${WSP}(?!the chase)${UWBE}`, "iu"),
  "edit-word"],
  [new RegExp(`${UWB}camera${UWBE}`, "iu"), "edit-word"],
  [new RegExp(`${UWB}which is (?:where|how|why) we${UWBE}`, "iu"), "meta-question"],
  [new RegExp(`${UWB}we (?:get|learn|find out)${UWBE}`, "iu"), "meta-question"],
  [new RegExp(`${UWB}that is how we${UWBE}`, "iu"), "meta-question"],
  [new RegExp(`${UWB}the lesson${UWBE}`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}the moral (?:is|of)${UWBE}`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}the point (?:is|of)${UWBE}(?!${WSP}(?:of view|${WP}ing))`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}in stark contrast${UWBE}`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}which (?:tells|shows) (?:you|us)${UWBE}`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}at the end of the day${UWBE}`, "iu"), "essay-frame"],
  [new RegExp(`${UWB}which proves${UWBE}`, "iu"), "critic-frame"],
  [new RegExp(`${UWB}this is (?:where|how|why)${UWBE}`, "iu"), "critic-frame"],
];

export const PERSONA_MEANING: readonly RegExp[] = [
  new RegExp(`${UWB}the answer (?:is|was|landed|came|finally)${UWBE}`, "iu"),
  new RegExp(`${UWB}(?:he|she|they|it)${WSP}(?:realizes?|realises?|figures? out|understands?|knows?)${WSP}(?:that|it|why)${UWBE}`, "iu"),
  new RegExp(`${UWB}it (?:all )?clicks?${UWBE}`, "iu"),
  new RegExp(`${UWB}that (?:all )?means${UWBE}`, "iu"),
  new RegExp(`${UWB}meaning${UWBE}`, "iu"),
  new RegExp(`${UWB}which is to say${UWBE}`, "iu"),
  new RegExp(`${UWB}in other words${UWBE}`, "iu"),
];

export const PERSONA_SIZE: readonly RegExp[] = [
  new RegExp(`${UWB}the (?:most|strongest|greatest|biggest|only) ${WP} (?:in|of) the (?:world|entire)${UWBE}`, "iu"),
  new RegExp(`${UWB}unprecedented${UWBE}`, "iu"),
  new RegExp(`${UWB}this changes? everything${UWBE}`, "iu"),
  new RegExp(`${UWB}the strongest yet${UWBE}`, "iu"),
  new RegExp(`${UWB}history was made${UWBE}`, "iu"),
  new RegExp(`${UWB}nothing like (?:this|it) has${UWBE}`, "iu"),
];

function firstCharged(step: string, pat: RegExp, tag: string): RegExpExecArray | null {
  const scan = pat.global ? pat : new RegExp(pat.source, pat.flags + "g");
  for (const m of step.matchAll(scan)) {
    if ((tag === "critic-frame" || tag === "essay-frame") &&
      inReportedSpeech(step, m.index)) continue;
    if (tag === "media-word" &&
      (inReportedSpeech(step, m.index) || inQuotedText(step, m.index))) continue;
    return m;
  }
  return null;
}

/** True when the span before `upto` is inside something a character SAYS. */
function inReportedSpeech(step: string, upto: number): boolean {
  const cl = step.slice(0, upto).split(/[,;:]/);
  return cl.slice(-3).some((c) => SPEECH.test(c));
}

/** True when the hit sits inside a LAW 4 attributed quotation. */
function inQuotedText(step: string, upto: number): boolean {
  const before = step.slice(0, upto).split('"').length - 1;
  const total = step.split('"').length - 1;
  return before % 2 === 1 && total % 2 === 0;
}

// ---------------------------------------------------------------------------
// narration_steps
// ---------------------------------------------------------------------------

/**
 * The steps these reports read: no # headers, no @hold jabs, emotion tags and
 * panel tags already gone or stripped here.
 */
export function narrationSteps(scriptTxt: string): string[] {
  const out: string[] = [];
  for (const line of pySplitLines(scriptTxt)) {
    if (line.trim() === "" || pyLstrip(line).startsWith("#") || line.includes("@hold")) continue;
    const t = line.replace(new RegExp(`@p${DP}(?:_${DP})?|\\[[a-zA-Z ]+\\]`, "gu"), " ");
    out.push(pyStrip(t.replace(new RegExp(WSP, "gu"), " ")));
  }
  return out.filter((t) => t !== "");
}

// ---------------------------------------------------------------------------
// PERSONA (P1 issues + P2/P3/P4 advisories)
// ---------------------------------------------------------------------------

/** P1 only. One hit per step, first matching phrase. */
export function personaCheck(scriptTxt: string): string[] {
  const issues: string[] = [];
  for (const s of narrationSteps(scriptTxt)) {
    for (const [pat, tag] of OUTSIDE_FRAME) {
      if (firstCharged(s, pat, tag) === null) continue;
      issues.push(`OUTSIDE (${tag}): ${pySlice(pyStrip(s), 0, 72)}`);
      break;
    }
  }
  return issues;
}

/** P2/P3/P4 - printed, never returned. */
export function personaAdvisory(
  scriptTxt: string,
  windowTxt = "",
): { p2: [string, string][]; p3: [string, string][]; refs: string[] } {
  const ss = narrationSteps(scriptTxt);
  const p2: [string, string][] = [];
  const p3: [string, string][] = [];
  for (const s of ss) {
    for (const p of PERSONA_MEANING) {
      const m = s.match(p);
      if (m) p2.push([pyStrip(m[0]), s]);
    }
  }
  for (const s of ss) {
    for (const p of PERSONA_SIZE) {
      const m = s.match(p);
      if (m) p3.push([pyStrip(m[0]), s]);
    }
  }
  const refs: string[] = [];
  if (windowTxt) {
    const wlow = windowTxt.toLowerCase();
    const tlow = ss.join(" ").toLowerCase();
    const re = new RegExp(
      `${UWB}([A-Z][a-z]+(?:-[A-Za-z][a-z]+)?(?: [A-Z][a-z]+(?:-[A-Za-z][a-z]+)?){1,2})${UWBE}`,
      "gu");
    for (const m of ss.join(" ").matchAll(re)) {
      const tl = m[1].toLowerCase();
      if (tlow.includes(tl) || !wlow.includes(tl)) continue;
      if (!refs.includes(tl)) refs.push(tl);
    }
  }
  console.log(`   persona P2 (advisory): ${p2.length}/${ss.length} steps name what a moment means ` +
    `(e.g. ${pySlice(p2.length ? p2[0][1] : "none", 0, 60)})`);
  console.log(`   persona P3 (advisory): ${p3.length}/${ss.length} steps borrow the story's own size ` +
    `(e.g. ${pySlice(p3.length ? p3[0][1] : "none", 0, 60)})`);
  console.log(`   persona P4 (advisory): ${refs.length} cross-episode reference(s), cap 1 ` +
    `(${refs.slice(0, 4).join(", ") || "none"})`);
  return { p2, p3, refs };
}

// ---------------------------------------------------------------------------
// STRUCTURE LAW (briefs.py 11): a shape SIGNATURE, never a schema.
// ---------------------------------------------------------------------------

export interface EntrySignature {
  meta: string;
  conn: string;
  cold: string;
  mid: string;
}
export interface ExitSignature {
  thread: string;
  small: string;
  reframe: string;
  words: number;
}

export function entrySignature(scriptTxt: string): EntrySignature {
  const ss = narrationSteps(scriptTxt);
  if (ss.length === 0) return { meta: "EMPTY", conn: "EMPTY", cold: "EMPTY", mid: "EMPTY" };
  const first = ss[0];
  const meta = new RegExp(
    `${UWB}(last (?:time|episode|chapter)|this (?:episode|chapter|video)|` +
    `first (?:thing|, the recap)|the recap${UWBE}|picks? up (?:right )?where|` +
    `we (?:left|were watching)|we (?:see|watch))${UWBE}`, "iu").test(first);
  const conn = new RegExp(
    `^(?:so|and|then|but|because|meanwhile|which|except|back|` +
    `right now|in the${UWBE})`, "iu").test(first);
  const cold = new RegExp(
    `${UWB}(?:is|are|has been|have been|stands|sits|waits|walks|opens|` +
    `holds|looks|comes|runs|grabs|pulls|wakes|finds)${UWBE}`, "iu").test(first);
  const mid = new RegExp(`${UWB}(?:when|mid|already|just|still)${UWBE}`, "iu").test(first);
  const y = (b: boolean): string => (b ? "Y" : "n");
  return { meta: y(meta), conn: y(conn), cold: y(cold), mid: y(mid) };
}

export function exitSignature(scriptTxt: string): ExitSignature {
  const ss = narrationSteps(scriptTxt);
  if (ss.length === 0) return { thread: "EMPTY", small: "EMPTY", reframe: "EMPTY", words: 0 };
  const last = ss[ss.length - 1];
  const thread = new RegExp(
    `${UWB}(?:still|has ?n[o']t|not yet|whether|nobody|no one|` +
    `somewhere|until|before (?:he|she|they|it))${UWBE}`, "iu").test(last);
  const small = new RegExp(
    `${UWB}(?:walks?|puts?|sits?|stands?|turns?|closes|stares?|pockets?|` +
    `sets?|quiet|silence|exhales?|sighs?)${UWBE}`, "iu").test(last);
  const reframe = new RegExp(
    `${UWB}(?:turns out|which means|now|after that|from now|it was ` +
    `never|wasn't|had been)${UWBE}`, "iu").test(last);
  const words = last.replace(new RegExp(`@p${DP}`, "gu"), "").split(/\s+/)
    .filter((x) => x !== "").length;
  const y = (b: boolean): string => (b ? "Y" : "n");
  return { thread: y(thread), small: y(small), reframe: y(reframe), words };
}

export function structureSignature(
  scriptTxt: string,
  prevScriptTxt = "",
): { entry: EntrySignature; exit: ExitSignature } {
  const ss = narrationSteps(scriptTxt);
  const e = entrySignature(scriptTxt);
  const x = exitSignature(scriptTxt);
  const pe = prevScriptTxt ? entrySignature(prevScriptTxt) : null;
  const px = prevScriptTxt ? exitSignature(prevScriptTxt) : null;
  const sameEntry = pe !== null &&
    e.meta === pe.meta && e.conn === pe.conn && e.cold === pe.cold && e.mid === pe.mid &&
    (e.meta === "Y" || e.conn === "Y" || e.cold === "Y" || e.mid === "Y");
  const rep = sameEntry ? "  <-- SAME DISTINCTIVE ENTRY SIGNATURE AS LAST EPISODE" : "";
  console.log(`   structure entry (advisory): meta=${e.meta} connective=${e.conn} cold=${e.cold} ` +
    `mid=${e.mid}` + (pe ? ` | previous episode ${pe.meta}${pe.conn}${pe.cold}${pe.mid}` : ""));
  console.log(`   structure exit (advisory): thread=${x.thread} small=${x.small} reframe=${x.reframe} | ` +
    `last step ${x.words}w, ${ss.length} steps` +
    (px ? ` | previous episode ${px.thread}${px.small}${px.reframe}` : "") + rep);
  return { entry: e, exit: x };
}

// ---------------------------------------------------------------------------
// step_tail / narrated_future / reported
// ---------------------------------------------------------------------------

/**
 * The clause the step LANDS on. A reason is not a landing, so a trailing
 * because/since clause is dropped before the split. Quoted spans go first.
 */
export function stepTail(step: string): string {
  let s = step.replace(/"[^"]*"/g, " ");
  const cut = new RegExp(`,${WS}*(?:because|since|so that)${UWBE}`, "iu").exec(s);
  const lead = new RegExp(`^${WS}*(?:because|since)${UWBE}[^,]*,${WS}*`, "iu").exec(s);
  if (cut) s = s.slice(0, cut.index);
  else if (lead) s = s.slice(lead.index + lead[0].length);
  const parts = s.split(TAILSEP).map((x) => x.trim()).filter((x) => x !== "");
  const t = parts.length ? parts[parts.length - 1] : s;
  return pyStrip(t.replace(new RegExp(`${WSP}(?:and|but|so|then|with|to)${PY_END}`, "giu"), ""));
}

/**
 * True when the whole step is written in the future. The tell only exists when
 * the step opens on something and CLOSES on a commitment.
 */
export function narratedFuture(step: string, tail: string): boolean {
  const outside = step.replace(tail, " ");
  if (new RegExp(
    `^${WS}*(?:and${WSP}|so${WSP}|then${WSP})?(?:when|if|once|as soon as|after|before|` +
    `the moment)${UWBE}`, "iu").test(outside)) return true;
  return new RegExp(
    `${UWB}(?:${PERSON})${UWBE}${WS}*(?:'ll${UWBE}|(?:will|won't|is going to|are ` +
    `going to|going to)${WSP}${WP})`, "iu").test(outside);
}

/** A speech verb governing the clause in front of `upto`, or in the `back` words before it. */
export function reported(step: string, upto: number, back = 10): boolean {
  const cl = CLAUSE_START.exec(step.slice(0, upto));
  if (SPEECH.test(cl ? step.slice(cl.index + cl[0].length, upto) : step.slice(0, upto))) {
    return true;
  }
  const words = pySplit(step.slice(0, upto));
  return SPEECH.test(words.slice(Math.max(0, words.length - back)).join(" "));
}

// ---------------------------------------------------------------------------
// attitude_tail / mind_read
// ---------------------------------------------------------------------------

export type AttitudeKind =
  | "rider" | "state-rider" | "nomore" | "vow" | "decision" | "determined" | "bare-vow";

/**
 * [kind, tail] if this step ENDS on a named decision/vow/resolve, else null.
 */
export function attitudeTail(step: string): [AttitudeKind, string] | null {
  const t = stepTail(step);
  if (!t) return null;
  const stanceScan = STANCE.global ? STANCE : new RegExp(STANCE.source, STANCE.flags + "g");
  for (const m of t.matchAll(stanceScan)) {
    const head = m[0].toLowerCase();
    const after = pyStrip(t.slice(m.index + m[0].length));
    const pre = t.slice(0, m.index);
    if (new RegExp(`${UWB}(?:a|an|the|his|her|their|this|that|my|our|its|one|no|some|any)${WSP}${PY_END}`, "iu").test(pre)) {
      return null; // "with a PROMISE that ...", not a verb
    }
    if (RELPRON.test(pre) || SUBORD.test(pre)) return null;
    if (RIDER.test(head)) return PASTFACT.test(after) ? null : ["rider", t];
    if (head.startsWith("is determined") || head.startsWith("are determined")) {
      return ["determined", t];
    }
    if (WHCLAUSE.test(pre)) return null;
    const to = new RegExp(`^to${WSP}(${PY_W})`, "iu").exec(after);
    if (to) {
      if (KEEPING_POST.test(after)) return null;
      return VOWHEAD.test(head) || STANDING.test(to[1]) ? ["vow", t] : null;
    }
    if (new RegExp(`^that${UWBE}`, "iu").test(after)) {
      return PASTFACT.test(pyStrip(after.slice(4))) ? null : ["decision", t];
    }
    if (new RegExp(`^(?:${PERSON})${WSP}(?:${FINITE})`, "iu").test(after)) {
      return PASTFACT.test(after) ? null : ["decision", t];
    }
    return null;
  }
  if (STATE_RIDER.test(t)) return ["state-rider", t];
  if (NOMORE.test(t)) return ["nomore", t];
  if (!FINITED.test(t) && !SUBORD_OPEN.test(t) && !WHCLAUSE.test(t) &&
    !SIMILE.test(t) && !narratedFuture(step, t) &&
    !reported(step, step.length - t.length) &&
    new RegExp(
      `^(?:${PERSON})${WS}*(?:'ll${WSP}${WP}|(?:will|won't|is going to|` +
      `are going to|going to)${WSP}${WP})`, "iu").test(t)) {
    return ["bare-vow", t];
  }
  return null;
}

/**
 * The epistemic FRAME's token if this step announces the act of understanding in
 * the narrator's own voice (not reported speech, not a simile), else null.
 */
export function mindRead(step: string): string | null {
  const scan = MINDFRAME.global ? MINDFRAME : new RegExp(MINDFRAME.source, MINDFRAME.flags + "g");
  for (const m of step.matchAll(scan)) {
    if (SIMILE.test(step.slice(0, m.index))) continue;
    if (reported(step, m.index)) continue;
    return m[0];
  }
  return null;
}

/** Alias mirroring the task/checker name for the mind-read frame lint. */
export const mindReadFrames = mindRead;

export interface TailReport {
  nSteps: number;
  att: [string, string][];
  mind: [string, string][];
  dash: number;
  rider: number;
  tail: number;
}

/**
 * The three migrating surfaces, counted. Measurement only.
 */
export function attitudeTails(scriptTxt: string): TailReport {
  const att: [string, string][] = [];
  const mind: [string, string][] = [];
  let dash = 0;
  let rider = 0;
  let tail = 0;
  const steps = narrationSteps(scriptTxt);
  for (const s of steps) {
    const a = attitudeTail(s);
    if (a) {
      att.push([a[1], s]);
      tail += 1;
      if (a[0] === "rider" || a[0] === "state-rider") rider += 1;
    }
    const mr = mindRead(s);
    if (mr) mind.push([mr, s]);
    if (/(?:\s[-\u2013\u2014]\s|[\u2013\u2014])/.test(s)) dash += 1;
  }
  return { nSteps: steps.length, att, mind, dash, rider, tail };
}

/** Alias mirroring Python's `tail_reports`. */
export const tailReports = attitudeTails;

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** Anything with the promo Block's `matches()` API (see intake/promoBlock.ts). */
export interface PromoMatcher {
  matches(s: string): boolean;
}

export interface FactCheckOptions {
  windowTxt?: string | null;
  promo?: PromoMatcher | null;
  prevScript?: string | null;
  characterNames?: Iterable<string> | null;
}

/**
 * The gate. Returns the sorted, de-duplicated issue list (Python's return value).
 *
 * Accepts both the positional form `check(script, transcript, window, names, promo, prev)`
 * and the options object `{ windowTxt, promo, prevScript, characterNames }`.
 */
export function check(
  scriptTxt: string,
  transcriptTxt: string,
  windowTxtOrOptions: string | FactCheckOptions = "",
  characterNames: Iterable<string> = [],
  promo: PromoMatcher | null = null,
  prevScript: string | null = null,
): string[] {
  let windowTxt: string;
  let names: Iterable<string>;
  let promoMatcher: PromoMatcher | null;
  let prev: string | null;
  if (typeof windowTxtOrOptions === "object" && windowTxtOrOptions !== null) {
    const o = windowTxtOrOptions;
    windowTxt = o.windowTxt ?? "";
    names = o.characterNames ?? [];
    promoMatcher = o.promo ?? null;
    prev = o.prevScript ?? null;
  } else {
    windowTxt = windowTxtOrOptions;
    names = characterNames;
    promoMatcher = promo;
    prev = prevScript;
  }

  scriptTxt = scriptTxt.split(" @hold").join("").split("@hold").join("");
  const stripped = stripEmotion(scriptTxt);
  scriptTxt = stripped.text;
  const badTags = stripped.bad;

  const readNorm = transcriptTxt.toLowerCase()
    .replace(new RegExp(`(${DP.slice(0, -1)}),(${DP.slice(0, -1)})`, "gu"), "$1$2");
  const nums = new Set(readNorm.match(new RegExp(`${DP}(?:\\.${DP})?`, "gu")) ?? []);
  for (const [w, d] of Object.entries(WORD_NUMS)) {
    if (new RegExp(`${UWB}${escapeRegex(w)}${UWBE}`, "u").test(readNorm)) nums.add(d);
  }
  for (const [ph, d] of Object.entries(PHRASES)) {
    if (readNorm.includes(ph)) nums.add(d);
  }

  let body = pySplitLines(scriptTxt)
    .filter((l) => !pyLstrip(l).startsWith("#")).join("\n");
  body = body.replace(new RegExp(`@p${DP}(?:_${DP})?`, "gu"), "");

  const issues: string[] = [];

  // LANGUAGE GATE: norm() strips every non-[a-z0-9 ] character, so a narration
  // written in Korean/Japanese normalises to EMPTY and every other check passes
  // vacuously. This is the only check that sees the raw characters.
  const spoken = pySplitLines(body)
    .map((l) => pyStrip(l))
    .filter((l) => l !== "" && !l.startsWith("##"));
  const foreign = spoken.filter((l) => {
    const cps = Array.from(l);
    const nonAscii = cps.filter((c) => (c.codePointAt(0) as number) > 127).length;
    return nonAscii > 0.10 * Math.max(cps.length, 1);
  });
  if (spoken.length) {
    const ratio = (100.0 * foreign.length) / spoken.length;
    if (foreign.length) {
      issues.unshift(`NON-ENGLISH NARRATION (${foreign.length}/${spoken.length} ` +
        `lines = ${pyRoundFixed(ratio, 0)}% foreign script, e.g. ${pyRepr(pySlice(foreign[0], 0, 60))})`);
    }
  }
  for (const t of [...new Set(badTags)].sort(cmpCodePoints)) {
    issues.push(`UNKNOWN emotion tag [${t}] (not in the writer's allowed set)`);
  }

  const lowBody = body.toLowerCase();
  for (const m of lowBody.matchAll(new RegExp(`(?:age|month|day|year|week)s?${UWBE}`, "giu"))) {
    const start = m.index;
    const ctx = pySlice(lowBody, Math.max(0, start - 30), m.index + m[0].length + 30);
    for (const num of ctx.match(new RegExp(DP, "gu")) ?? []) {
      if (!nums.has(num)) {
        issues.push(`number ${num} not in transcript: ...${pyStrip(ctx)}...`);
      }
    }
    for (const [ph, num] of Object.entries(PHRASES)) {
      if (ctx.includes(ph) && !nums.has(num)) {
        issues.push(`phrase '${ph}' not in transcript: ...${pyStrip(ctx)}...`);
      }
    }
    for (const w of ctx.match(/[a-z]+(?:-[a-z]+)?/g) ?? []) {
      if (w in WORD_NUMS && !nums.has(WORD_NUMS[w])) {
        issues.push(`word-number '${w}' not in transcript: ...${pyStrip(ctx)}...`);
      }
    }
  }

  // panel tags must exist
  const valid = new Set<string>();
  for (const m of transcriptTxt.matchAll(
    new RegExp(`${UWB}p(${DP.slice(0, -1)}{4})_(${DP})${UWBE}`, "gu"))) {
    valid.add(`${m[1]}_${m[2]}`);
  }
  for (const m of scriptTxt.matchAll(new RegExp(PANEL_TAG_SRC, "gu"))) {
    if (!valid.has(`${m[1]}_${m[2]}`)) issues.push(`bad tag @p${m[1]}_${m[2]}`);
  }
  for (const m of scriptTxt.matchAll(new RegExp(`@p(${DP.slice(0, -1)}{4})(?!_${DP.slice(0, -1)})`, "gu"))) {
    issues.push(`page-level tag @p${m[1]} (writer slip: use @pXXXX_N)`);
  }

  // DUB against OVERLAY only
  const STOP = new Set(("a an the to of in on is it was that this and but for you your i he she him " +
    "her his my me we with as at so do not").split(" "));
  let overlay: string[] = [];
  for (const line of pySplitLines(transcriptTxt)) {
    const m = new RegExp(`OVERLAY: (.*?) \\| WORLD:`).exec(line);
    if (m && pyStrip(m[1]) !== "-") {
      overlay = overlay.concat(
        (m[1].match(/"(?:[^"]{4,})"/gu) ?? []).map((x) => norm(pySlice(x, 1, -1))));
    }
  }
  overlay = overlay.filter((b) => b.length >= 10);
  for (const line of pySplitLines(body)) {
    const nw = pySplit(line ? norm(line) : "");
    if (nw.length === 0) continue;
    // ATTRIBUTED QUOTE (2026-10-03): a run that sits inside quotation marks in the
    // line is a deliberate LAW 4 quote and is exempt; every unattributed run is
    // still charged, same 8-word bar, same STOP-word filter.
    const quoted = " " + (line.match(/"(?:[^"]{4,})"/gu) ?? [])
      .map((q) => norm(pySlice(q, 1, -1))).join(" ") + " ";
    for (const b of overlay) {
      const bw = pySplit(b);
      let best = 0;
      let bestRun: string[] = [];
      const bstr = " " + nw.join(" ") + " ";
      for (let k = 8; k <= bw.length; k++) {
        for (let i = 0; i + k <= bw.length; i++) {
          const run = bw.slice(i, i + k);
          if (run.every((w) => STOP.has(w))) continue;
          if (bstr.includes(` ${run.join(" ")} `) && k > best) {
            best = k;
            bestRun = run;
          }
        }
      }
      if (best >= 8) {
        if (bestRun.length && quoted.includes(` ${bestRun.join(" ")} `)) {
          break; // attributed quote: LAW 4 obeyed
        }
        issues.push(`DUB (${best}w overlay): ${pySlice(pyStrip(line), 0, 70)}`);
        break;
      }
    }
  }

  // SCREENREADER lint (SHOW-DON'T-DESCRIBE LAW)
  const visuals: Record<string, string> = {};
  for (const line of pySplitLines(transcriptTxt)) {
    const m = new RegExp(`^(${UWB}p${DP.slice(0, -1)}{4}_${DP}) \\| art:[^|]*\\| (.*?) \\| OVERLAY:`, "u").exec(line);
    if (m) visuals[m[1]] = norm(m[2]);
  }
  for (const line of pySplitLines(scriptTxt)) {
    if (pyLstrip(line).startsWith("#")) continue;
    const nw = pySplit(norm(line.replace(new RegExp(PANEL_TAG_SRC, "gu"), "")));
    if (nw.length === 0) continue;
    const bstr = " " + nw.join(" ") + " ";
    for (const m of line.matchAll(new RegExp(PANEL_TAG_SRC, "gu"))) {
      const vw = pySplit(visuals[`p${m[1]}_${m[2]}`] ?? "");
      let best = 0;
      for (let k = 6; k <= vw.length; k++) {
        for (let i = 0; i + k <= vw.length; i++) {
          const run = vw.slice(i, i + k);
          if (run.every((w) => STOP.has(w))) continue;
          if (bstr.includes(` ${run.join(" ")} `)) best = Math.max(best, k);
        }
      }
      if (best >= 6) {
        issues.push(`SCREENREADER (${best}w visual of p${m[1]}_${m[2]}): ${pySlice(pyStrip(line), 0, 70)}`);
        break;
      }
    }
  }

  // I-08: LORE IMPORT
  if (windowTxt) {
    const wlow = windowTxt.toLowerCase();
    const tlow = transcriptTxt.toLowerCase();
    const known = new Set<string>();
    for (const n of names) if (n) known.add(n.toLowerCase());
    const found = new Set<string>();
    for (const m of body.matchAll(new RegExp(
      `${UWB}([A-Z][a-z]+(?:-[A-Za-z][a-z]+)?(?: [A-Z][a-z]+(?:-[A-Za-z][a-z]+)?){1,3})${UWBE}`,
      "gu"))) {
      const term = m[1];
      const tl = term.toLowerCase();
      if (tlow.includes(tl)) continue;
      let isKnown = false;
      for (const k of known) if (tl.includes(k) || k.includes(tl)) { isKnown = true; break; }
      if (isKnown) continue;
      if (wlow.includes(tl)) found.add(term);
    }
    for (const term of [...found].sort(cmpCodePoints)) {
      issues.push(`LORE IMPORT '${term}': appears in a previous script but ` +
        `nowhere in this chapter's transcript`);
    }
  }

  // UNGROUNDED lint (GROUNDING LAW)
  const tlow = transcriptTxt.toLowerCase();
  const known = new Set<string>();
  for (const n of names) if (n) known.add(n.toLowerCase());
  const INSIDE = new Set(("think thinks thinking thought feel feels feeling " +
    "felt know knows knowing knew wonder wonders wondering " +
    "realize realizes realizing realized remember remembers " +
    "remembering remembered decide decides deciding decided " +
    "want wants wanting wanted fear fears fearing feared " +
    "hope hopes hoping hoped love loves loving loved " +
    "hate hates hating hated need needs needing needed").split(" "));
  const stem = (w: string): string => {
    for (const suf of ["ies", "ing", "ers", "ed", "es", "s"]) {
      if (w.endsWith(suf) && w.length - suf.length >= 4) {
        return w.slice(0, w.length - suf.length) + (suf === "ies" ? "y" : "");
      }
    }
    return w;
  };
  const grounded = (w: string): boolean => {
    if (INSIDE.has(w)) return true;
    for (const p of w.split("-")) {
      for (const cand of [p, stem(p)]) {
        if (cand && cand.length >= 4 && tlow.includes(cand)) return true;
      }
    }
    return false;
  };
  const USTOP = new Set<string>(STOP);
  for (const w of STOPWORD) USTOP.add(w);
  for (const w of ("yourself itself himself herself themselves this that these those " +
    "there here what when how why because about into over under just like than them " +
    "they their said says would could should very really quite rather still even also " +
    "back away around again never always every each such much more most own same " +
    "another while until though whether both either doesn don isn aren wasn weren " +
    "haven hasn hadn didn won can cannot t").split(" ")) USTOP.add(w);
  for (const line of pySplitLines(body)) {
    const words = (line.toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? [])
      .filter((w) => !USTOP.has(w) && !w.startsWith("@") && w.length >= 4);
    if (words.length < 6) continue;
    const missing = words.filter((w) => {
      if (grounded(w) !== false) return false;
      for (const k of known) if (w.includes(k) || k.includes(w)) return false;
      return true;
    });
    if (missing.length >= 4) {
      issues.push(`UNGROUNDED (${missing.length}w): ${pySlice(pyStrip(line), 0, 70)} ` +
        `[${missing.slice(0, 6).join(", ")}]`);
    }
  }

  // CAPTION lint (MIND-READER LAW)
  const CSTOP = new Set<string>(STOP);
  for (const w of ("be been by from up out they them their its").split(" ")) CSTOP.add(w);
  const capLines: string[] = [];
  let capTotal = 0;
  for (const line of pySplitLines(scriptTxt)) {
    if (pyLstrip(line).startsWith("#")) continue;
    const tags = [...line.matchAll(new RegExp(PANEL_TAG_SRC, "gu"))].map((m) => `p${m[1]}_${m[2]}`);
    if (tags.length !== 1 || !(tags[0] in visuals)) continue;
    const words = pySplit(norm(line.replace(new RegExp(PANEL_TAG_SRC, "gu"), "")))
      .filter((w) => !CSTOP.has(w) && w.length > 2);
    if (words.length < 3) continue;
    capTotal += 1;
    const vis = visuals[tags[0]];
    const hit = words.filter((w) => vis.includes(pySlice(w, 0, 5)));
    if (hit.length / words.length >= 0.5) capLines.push(pySlice(pyStrip(line), 0, 70));
  }
  if (capTotal && capLines.length / capTotal > 0.2) {
    issues.push(`CAPTION: ${capLines.length}/${capTotal} lines restate their own panel ` +
      `(e.g. ${capLines[0]})`);
  }

  // MULTI-PANEL CAPTION (2026-10-04)
  const mWords: { score: number; str: string; line: string }[] = [];
  let mHits = 0;
  let mTotal = 0;
  for (const line of pySplitLines(scriptTxt)) {
    if (pyLstrip(line).startsWith("#") || line.includes("@hold")) continue;
    const tags = [...line.matchAll(new RegExp(PANEL_TAG_SRC, "gu"))].map((m) => `p${m[1]}_${m[2]}`);
    if (tags.length < 2 || !tags.some((t) => t in visuals)) continue;
    const prose = line.replace(new RegExp(PANEL_TAG_SRC, "gu"), "");
    const words: string[] = [];
    for (const w of prose.match(/[A-Za-z][a-z'-]+/g) ?? []) {
      if (CSTOP.has(w.toLowerCase()) || w.length < 4) continue;
      const at = prose.indexOf(w);
      if (at > 0 && /[A-Za-z]/.test(prose[at - 1])) continue;
      if (at > 0 && ".,!?\"'".includes(prose[at - 1]) && /[A-Z]/.test(w[0])) continue;
      words.push(norm(w));
    }
    if (words.length < 4) continue;
    mTotal += 1;
    let best = 0;
    for (const t of tags) {
      if (!(t in visuals)) continue;
      const vis = visuals[t];
      const share = words.filter((w) => vis.includes(pySlice(w, 0, 5))).length / words.length;
      if (share > best) best = share;
    }
    if (best >= 0.5) {
      mHits += 1;
      mWords.push({ score: pyRound(best, 2), str: pyRoundFixed(best, 2), line: pySlice(pyStrip(line), 0, 70) });
    }
  }
  if (mTotal && mHits / mTotal > 0.2) {
    mWords.sort((a, b) =>
      a.score !== b.score ? b.score - a.score : cmpCodePoints(b.line, a.line));
    issues.push(`CAPTION/MULTI (${mHits}/${mTotal} lines with 2+ panels restate their ` +
      `own pictures, best ${mWords[0].str} e.g. ${mWords[0].line})`);
  }

  // RHYTHM REPORT (PACE LAW) - ADVISORY, NEVER AN ISSUE
  const rl = pySplitLines(scriptTxt)
    .filter((l) => l.trim() !== "" && !pyLstrip(l).startsWith("#") && !l.includes("@hold"))
    .map((l) => pySplit(l.replace(new RegExp(`@p${DP}(?:_${DP})?|\\[[a-z ]+\\]`, "gu"), "")).length);
  if (rl.length >= 8) {
    const mean = rl.reduce((a, b) => a + b, 0) / rl.length;
    const cv = Math.sqrt(rl.reduce((a, b) => a + (b - mean) ** 2, 0) / rl.length) /
      Math.max(mean, 0.001);
    const short = rl.filter((x) => x <= 9).length;
    const sortedRl = [...rl].sort((a, b) => a - b);
    console.log(`   rhythm (advisory): line-length CV ${pyRoundFixed(cv, 2)} over ${rl.length} lines, ` +
      `${short} punchy (<=9w), median ${sortedRl[Math.floor(rl.length / 2)]}w`);
  }

  // I-19 PROMO lint
  if (promoMatcher !== null) {
    for (const line of pySplitLines(body)) {
      const prose = line.replace(new RegExp(`@p${DP}(?:_${DP})?`, "gu"), "");
      if (promoMatcher.matches(prose)) {
        issues.push(`PROMO in narration: ${pySlice(pyStrip(line), 0, 80)}`);
      }
    }
  }

  // E1 TIC REPORT - ADVISORY, NEVER AN ISSUE
  const cc = connectives(scriptTxt);
  const top = Object.entries(cc.counts).filter(([, v]) => v)
    .map(([k, v]) => `${k} x${v}`).join(", ") || "none";
  console.log(`   connective tic (advisory): ${cc.withAny}/${cc.nLines} lines carry a stock linking word ` +
    `(${top}); ${cc.openAny} open with one`);

  // ATTITUDE TAIL + MIND-READ FRAME - ADVISORY, NEVER AN ISSUE
  const tr = attitudeTails(scriptTxt);
  const aEx = tr.att.length ? tr.att[0][0] : "none";
  const mEx = tr.mind.length ? tr.mind[0][0] : "none";
  console.log(`   attitude tail (advisory): ${tr.att.length}/${tr.nSteps} steps end on a named ` +
    `decision/vow/resolve (e.g. ${pySlice(aEx, 0, 64)})`);
  console.log(`   mind-read frame (advisory): ${tr.mind.length}/${tr.nSteps} steps announce the act of ` +
    `understanding in the narrator's voice (e.g. ${pySlice(mEx, 0, 64)})`);
  console.log(`   tell surfaces (advisory): dash ${tr.dash}, -ing rider ${tr.rider}, ` +
    `decision tail ${tr.tail} of ${tr.nSteps} steps - the migration, per script`);

  // PERSONA LAW + STRUCTURE LAW
  for (const i of personaCheck(scriptTxt)) issues.push(i);
  personaAdvisory(scriptTxt, windowTxt);
  structureSignature(scriptTxt, prev ?? "");

  return [...new Set(issues)].sort(cmpCodePoints);
}
