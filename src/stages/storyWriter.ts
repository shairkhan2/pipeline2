/**
 * storyWriter.ts - TypeScript port of manhwa-pipeline/pipeline/story_writer.py,
 * plus writer.py's `_steps_to_script` (the story-mode script assembler).
 *
 * Opt-in story-first drafting and independent source/style review. No image-selection
 * hints, no panel-derived word budget, no unbounded rewrite loop and no imports from
 * writer/timeline. The caller matches and atomically saves only after review.
 *
 * Phases (Python `generate` split into reusable entry points):
 *   planStory         - STORY_PLAN_TASK -> validatePlan
 *   draftStory        - STORY_TASK      -> validateDraft
 *   reviewStory       - STORY_REVIEW_TASK -> validateReview
 *   writeStoryScript  - all three, with ONE bounded source-backed correction
 *
 * PARITY NOTES (Python -> JS)
 *  - Python `str.strip()` / `str.split()` use Python whitespace (incl. \x1c-\x1f, \x85);
 *    JS trim/split do not, so PY_WS is carried explicitly.
 *  - Python `str.casefold()` differs from `toLowerCase()` only for a few ligatures
 *    (sharp s); `casefold()` below covers the sharp-s case.
 *  - Python `re` `\d` is Unicode `\p{Nd}`; every digit class uses `u` + `\p{Nd}`.
 *  - Python `str.format` escaped braces (`{{` / `}}`) are reproduced by `pyStrFormat`.
 *  - `json.dumps(..., indent=1)` / `json.dumps(...)` byte shapes come from `jsonIndent1`
 *    and `pyJsonDumps` (contracts/hashes.ts); diagnostics files are debug-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMOTION_TAGS,
  SHAPE_EPISODE,
  STORY_PLAN_TASK,
  STORY_REVIEW_TASK,
  STORY_TASK,
} from "../contracts/briefs.js";
import { pyJsonDumps, pyStr } from "../contracts/hashes.js";
import { call, parseJson, type Completion } from "../llm/client.js";

// ---------------------------------------------------------------------------
// Python string helpers
// ---------------------------------------------------------------------------
const PY_WS =
  "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_SPLIT_RE = new RegExp(`[${PY_WS}]+`, "g");
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Python `str.strip()`. */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/** Python `str.split()` with no args: runs of whitespace, leading/trailing dropped. */
function pySplit(s: string): string[] {
  return s.split(PY_SPLIT_RE).filter((x) => x !== "");
}

/** Python `' '.join(x.split())`: collapse every whitespace run to one space. */
function pyJoinWS(s: string): string {
  return pySplit(s).join(" ");
}

/** Python `str.casefold()` (covers the sharp-s ligature; other cases are exotic). */
function casefold(s: string): string {
  return s.replace(/ß/g, "ss").replace(/ẞ/g, "ss").toLowerCase();
}

/** Python `json.dumps(value, indent=1)`: same layout as `JSON.stringify(v, null, 1)`. */
function jsonIndent1(value: unknown): string {
  return JSON.stringify(value, null, 1) ?? "null";
}

/** Python `str.format` for the briefs: `{{`/`}}` unescape, `{name}` substitutes. */
export function pyStrFormat(template: string, params: Record<string, string>): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i += 1;
        continue;
      }
      const end = template.indexOf("}", i);
      if (end < 0) throw new Error("Single '{' encountered in format string");
      const name = template.slice(i + 1, end);
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`KeyError: '${name}'`);
      }
      out += params[name];
      i = end;
      continue;
    }
    if (ch === "}") {
      if (template[i + 1] === "}") {
        out += "}";
        i += 1;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    }
    out += ch;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python iteration over a JSON value: str -> chars, list -> items, dict -> keys. */
function pyIter(value: unknown): unknown[] {
  if (typeof value === "string") return Array.from(value);
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.keys(value);
  throw new TypeError(`'${typeof value}' object is not iterable`);
}
/** Python truthiness for the values JSON.parse can produce. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Python `set(row) <= allowed` (subset, duplicates impossible after JSON parse). */
function keysSubsetOf(row: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(row).every((k) => allowed.includes(k));
}

/** Python `set(row) == {..}` (exact key set). */
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const got = Object.keys(row);
  if (got.length !== keys.length) return false;
  return keys.every((k) => hasOwn(row, k));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `completion['choices'][0]['message']['content']`, raising like the Python index chain. */
function completionContent(c: Completion): string {
  const v = c?.choices?.[0]?.message?.content;
  if (typeof v !== "string") throw new Error("missing message content");
  return v;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
export class StoryReviewError extends Error {
  /** Permanent content/contract failure; never an invitation to retry a chapter. */
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "StoryReviewError";
  }
}

export interface BibleCharacter {
  name?: unknown;
  aliases?: unknown;
  role?: unknown;
  [k: string]: unknown;
}
export interface Bible {
  characters?: unknown;
  [k: string]: unknown;
}
export interface Obs {
  events?: unknown;
  characters?: unknown;
  [k: string]: unknown;
}

export interface CastEntry {
  name: string;
  /** Python passes `record.get('aliases', [])` through RAW, so this is unvalidated. */
  aliases: unknown;
  /** Python passes `record.get('role', '')` through RAW, so this is unvalidated. */
  role: unknown;
  actions: string[];
}

export interface OutlineRow {
  want?: string;
  obstacle?: string;
  choice?: string;
  change?: string;
  [k: string]: unknown;
}

export interface Step {
  beat: string;
  line: string;
  jab: string;
  scene?: number;
  [k: string]: unknown;
}

export interface Draft {
  outline: OutlineRow[];
  steps: Step[];
}

export interface PlanMoment {
  event: string;
  source_events: number[];
  evidence_type: string;
  detail: string;
}

export interface OmittedEvent {
  event: number;
  reason: string;
}

export interface StoryPlan {
  premise: string;
  turns: OutlineRow[];
  moments: PlanMoment[];
  omitted_events: OmittedEvent[];
}

export const REVIEW_ISSUE_KINDS = [
  "caption_tour",
  "causal_omission",
  "unsupported_fact",
  "continuity",
  "jab_fact",
] as const;

export interface ReviewIssue {
  step: number;
  kind: string;
  quote: string;
  reason: string;
}

export interface CitationWarning {
  step: number;
  quote: string;
  warning: string;
}

export interface StoryReview {
  verdict: "accept" | "reject";
  assessment: string;
  issues: ReviewIssue[];
  citation_warnings?: CitationWarning[];
  [k: string]: unknown;
}

export interface StoryCallOptions {
  /** Previous-episode continuity window (writer.previousWindow output). */
  previous?: string;
  /** Already spoken opening (episode 1 hook); never repeated by the draft. */
  opening?: string;
  /** Running series synopsis ("STORY SO FAR"), continuity only. */
  soFar?: string;
  /** Look-ahead block of later chapters' events; planner only, never narrated. */
  upcoming?: string;
  /** Receives the validated plan (series memory records it). */
  onPlan?: (plan: StoryPlan) => void;
  /** Story shape blocks (episode vs movie); defaults to the standalone episode shape. */
  shape?: StoryShape;
  /** ElevenLabs v3 inline delivery tags on the drafting call. */
  emotion?: boolean;
  /** Directory for prompt/response diagnostics; null disables every write. */
  diagnosticsDir?: string | null;
}

export const UNIT_MAX_WORDS = 32;
/** Validation ceiling: a line that cannot be split cleanly may run this long. */
export const UNIT_HARD_MAX = 40;

/** Resolved prompt blocks that set the chapter's shape inside the whole story. */
export interface StoryShape {
  plan: string;
  draft: string;
  review: string;
}
/** Review kinds that may ship after the repair budget; everything else blocks. */
export const SOFT_REVIEW_KINDS = new Set(["caption_tour"]);
export const SOFT_ISSUE_LIMIT = 1;
export const JAB_MAX_WORDS = 12;
export const JAB_GAP = 4;

const OUTLINE_FIELDS = ["want", "obstacle", "choice", "change"] as const;
const STEP_FIELDS = ["beat", "line", "jab"] as const;
const MOMENT_FIELDS = ["event", "source_events", "evidence_type", "detail"] as const;
const EMO_RE = /\[[a-z ]+\]/g;
const PANEL_HINT_RE = /@(?:p\p{Nd}|hold)/u;
const PLAN_HINT_RE = /\bp\p{Nd}{4}_\p{Nd}+\b|@hold/iu;

// ---------------------------------------------------------------------------
// story_writer.cast_context
// ---------------------------------------------------------------------------

/** Keep all observed actions, resolving only unambiguous explicit aliases. */
export function castContext(obs: Obs, bible: Bible): CastEntry[] {
  interface Internal extends CastEntry {
    _labels: Set<string>;
    _unresolved?: boolean;
  }
  const cast: Internal[] = [];
  const characters = isRecord(bible?.characters) ? bible.characters : {};
  for (const [key, raw] of Object.entries(characters)) {
    const record = isRecord(raw) ? raw : {};
    // Python `record.get('name', key)` and `record.get('aliases', [])` are used RAW in the
    // output record; the labels set casefolds the name and iterates the aliases value
    // (Python iteration: a string goes char-by-char, a dict yields its keys).
    const name = hasOwn(record, "name") ? record.name : key;
    if (typeof name !== "string") {
      throw new TypeError(`'${typeof name}' object has no attribute 'casefold'`);
    }
    const rawAliases = hasOwn(record, "aliases") ? record.aliases : [];
    const labels = new Set<string>([
      casefold(name),
      ...pyIter(rawAliases).map((a) => casefold(a as string)),
    ]);
    cast.push({
      name,
      aliases: rawAliases,
      role: hasOwn(record, "role") ? record.role : "",
      actions: [],
      _labels: labels,
    });
  }
  const observed = Array.isArray(obs?.characters) ? obs.characters : [];
  for (const raw of observed) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    const action = pyStrip(typeof raw.what_they_do === "string" ? raw.what_they_do : "");
    if (!name || !action) continue;
    let matches = cast.filter((c) => c._labels.has(casefold(name)));
    if (matches.length !== 1) {
      matches = cast.filter((c) => c.name === name && c._unresolved);
      if (matches.length === 0) {
        const fresh: Internal = {
          name,
          aliases: [],
          role: "",
          actions: [],
          _labels: new Set([casefold(name)]),
          _unresolved: true,
        };
        cast.push(fresh);
        matches = [fresh];
      }
    }
    const actions = (matches[0] as Internal).actions;
    if (!actions.includes(action)) actions.push(action);
  }
  return cast.map((c) => ({
    name: c.name,
    aliases: c.aliases,
    role: c.role,
    actions: c.actions,
  }));
}

export const cast_context = castContext;

// ---------------------------------------------------------------------------
// story_writer.validate_draft / validate_plan / validate_review
// ---------------------------------------------------------------------------

/**
 * `moments` null/undefined -> skip scene-reference and unit-size checks. Selection is
 * the point of story mode: a draft may skip planned scenes, so there is no coverage check.
 */
/**
 * Split one over-long spoken line, but only where both halves stay real sentences:
 * at a sentence end, or before a clause-opening "but"/"so"/"yet". A line with no
 * such break stays whole (validation allows up to UNIT_HARD_MAX words) instead of
 * being cut into broken fragments.
 */
export function splitLongLine(line: string, max: number = UNIT_MAX_WORDS): string[] {
  const words = pySplit(line.replace(EMO_RE, ""));
  if (words.length <= max) return [line];
  const tokens = line.trim().split(/\s+/);
  const mid = tokens.length / 2;
  let cut = -1;
  let conj = false;
  let bestScore = Infinity;
  for (let i = 4; i <= tokens.length - 4; i++) {
    const tok = tokens[i - 1]!;
    const next = (tokens[i] ?? "").toLowerCase().replace(/[^a-z]/g, "");
    let rank: number;
    if (/[.!?;]["')\]]?$/.test(tok)) rank = 0;
    else if (/,$/.test(tok) && ["but", "so", "yet"].includes(next)) rank = 1;
    else continue;
    const score = rank * tokens.length + Math.abs(i - mid);
    if (score < bestScore) {
      bestScore = score;
      cut = i;
      conj = rank === 1;
    }
  }
  if (cut < 0) return [line];
  let head = tokens.slice(0, cut).join(" ");
  if (conj) head = head.replace(/,$/, ".");
  else if (/;$/.test(head)) head = head.replace(/;$/, ".");
  let tail = tokens.slice(cut).join(" ");
  tail = tail.charAt(0).toUpperCase() + tail.slice(1);
  return [...splitLongLine(head, max), ...splitLongLine(tail, max)];
}

/**
 * Deterministic unit repair: split over-long or multi-line narration into units
 * that share the step's beat and scene (the jab stays on the last unit). Spares a
 * whole chapter from failing on one wordy sentence.
 */
export function normalizeUnits(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.steps)) return data;
  const steps: unknown[] = [];
  for (const raw of data.steps) {
    if (!isRecord(raw) || typeof raw.line !== "string") {
      steps.push(raw);
      continue;
    }
    const parts = raw.line
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((s) => splitLongLine(s));
    if (parts.length <= 1) {
      steps.push(parts.length ? { ...raw, line: parts[0] } : raw);
      continue;
    }
    parts.forEach((line, i) => {
      steps.push({ ...raw, line, jab: i === parts.length - 1 ? raw.jab : "" });
    });
  }
  return { ...data, steps };
}

export function validateDraft(data: unknown, moments?: unknown[] | null): Draft {
  if (!isRecord(data) || !exactKeys(data, ["outline", "steps"])) {
    throw new StoryReviewError("draft must contain outline and steps only");
  }
  const outline = data.outline;
  const steps = data.steps;
  if (!Array.isArray(outline) || outline.length === 0) {
    throw new StoryReviewError("draft needs a causal outline");
  }
  for (const raw of outline) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).length === 0 ||
      !keysSubsetOf(raw, OUTLINE_FIELDS) ||
      Object.values(raw).some((v) => typeof v !== "string") ||
      !Object.values(raw).some((v) => pyStrip(v as string) !== "")
    ) {
      throw new StoryReviewError("invalid causal outline row");
    }
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new StoryReviewError("draft needs narration steps");
  }
  steps.forEach((raw, i) => {
    const n = i + 1;
    if (
      !isRecord(raw) ||
      !(exactKeys(raw, STEP_FIELDS) || exactKeys(raw, [...STEP_FIELDS, "scene"])) ||
      STEP_FIELDS.some((k) => typeof raw[k] !== "string") ||
      !pyStrip(raw.beat as string) ||
      !pyStrip(raw.line as string)
    ) {
      throw new StoryReviewError(`invalid narration step ${n}`);
    }
    if (PANEL_HINT_RE.test((raw.line as string) + (raw.jab as string))) {
      throw new StoryReviewError("narration must not choose pictures or holds");
    }
    if (moments != null) {
      const scene = raw.scene;
      if (
        typeof scene !== "number" ||
        !Number.isInteger(scene) ||
        !(scene >= 1 && scene <= moments.length)
      ) {
        throw new StoryReviewError(`step ${n} needs an existing scene reference`);
      }
      const words = pySplit((raw.line as string).replace(EMO_RE, ""));
      if (words.length > UNIT_HARD_MAX || (raw.line as string).includes("\n")) {
        throw new StoryReviewError(
          `step ${n} is an oversized spoken unit (${words.length} words, max ${UNIT_HARD_MAX})`,
        );
      }
      if (pySplit(raw.jab as string).length > JAB_MAX_WORDS) {
        throw new StoryReviewError(`step ${n} has an oversized reaction`);
      }
    }
  });
  return data as unknown as Draft;
}

export const validate_draft = validateDraft;

/**
 * Structural plan contract. The plan SELECTS: it need not account for every source
 * event, and omitted_events is optional. `nEvents` only bounds references so a moment
 * cannot cite an event that does not exist.
 */
export function validatePlan(data: unknown, nEvents?: number | null): StoryPlan {
  if (
    !isRecord(data) ||
    !(exactKeys(data, ["premise", "turns", "moments", "omitted_events"]) ||
      exactKeys(data, ["premise", "turns", "moments"])) ||
    typeof data.premise !== "string" ||
    !pyStrip(data.premise)
  ) {
    throw new StoryReviewError("plan needs a premise and grounded causal turns");
  }
  // Same optional causal-field contract, without inventing decisions for a schema.
  validateDraft({
    outline: data.turns,
    steps: [{ beat: "validation", line: "Plan validation only.", jab: "" }],
  });
  if (PLAN_HINT_RE.test(pyJsonDumps(data, {}))) {
    throw new StoryReviewError("causal plan must not carry panel-selection hints");
  }
  if (!Array.isArray(data.moments) || data.moments.length === 0) {
    throw new StoryReviewError("plan needs source-backed scene moments, not only a synopsis");
  }
  const accounted = new Set<number>();
  for (const raw of data.moments) {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, MOMENT_FIELDS) ||
      typeof raw.event !== "string" ||
      !pyStrip(raw.event) ||
      typeof raw.detail !== "string" ||
      !pyStrip(raw.detail) ||
      typeof raw.evidence_type !== "string" ||
      !["visible", "reported", "internal"].includes(raw.evidence_type)
    ) {
      throw new StoryReviewError("invalid scene moment");
    }
    const refs = raw.source_events;
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some(
        (i) => typeof i !== "number" || !Number.isInteger(i) || i < 1,
      )
    ) {
      throw new StoryReviewError("scene moment needs numbered source events");
    }
    for (const i of refs) accounted.add(i as number);
  }
  const rawOmitted = hasOwn(data, "omitted_events") ? data.omitted_events : [];
  if (!Array.isArray(rawOmitted)) {
    throw new StoryReviewError("omitted_events must be a list when given");
  }
  // Selection mode: omissions are informational. An entry that a moment already
  // uses is a harmless contradiction, so it is dropped instead of failing the plan.
  const omitted: Array<Record<string, unknown>> = [];
  for (const raw of rawOmitted) {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["event", "reason"]) ||
      typeof raw.event !== "number" ||
      !Number.isInteger(raw.event) ||
      raw.event < 1 ||
      typeof raw.reason !== "string"
    ) {
      throw new StoryReviewError("invalid omitted event");
    }
    if (accounted.has(raw.event)) continue;
    accounted.add(raw.event);
    omitted.push(raw);
  }
  data.omitted_events = omitted;
  if (nEvents && [...accounted].some((i) => i > nEvents)) {
    throw new StoryReviewError("plan references a source event that does not exist");
  }
  return data as unknown as StoryPlan;
}

export const validate_plan = validatePlan;

export function validateReview(
  data: unknown,
  nsteps: number,
  opts: { draft?: Draft | null; transcript?: string; source?: string } = {},
): StoryReview {
  const draft = opts.draft ?? null;
  const transcript = opts.transcript ?? "";
  const source = opts.source ?? "";
  if (!isRecord(data) || !exactKeys(data, ["verdict", "assessment", "issues"])) {
    throw new StoryReviewError("invalid independent review object");
  }
  if (data.verdict !== "accept" && data.verdict !== "reject") {
    throw new StoryReviewError("invalid story verdict");
  }
  if (typeof data.assessment !== "string" || !pyStrip(data.assessment)) {
    throw new StoryReviewError("missing independent assessment");
  }
  if (!Array.isArray(data.issues)) {
    throw new StoryReviewError("review issues must be a list");
  }
  const quoteWarnings: CitationWarning[] = [];
  for (const raw of data.issues) {
    if (!isRecord(raw) || !exactKeys(raw, ["step", "kind", "quote", "reason"])) {
      throw new StoryReviewError("invalid issue row");
    }
    const step = raw.step;
    if (
      typeof step === "boolean" ||
      !Number.isInteger(step) ||
      !((step as number) >= 0 && (step as number) <= nsteps)
    ) {
      throw new StoryReviewError("invalid issue step index");
    }
    if (
      typeof raw.kind !== "string" ||
      !(REVIEW_ISSUE_KINDS as readonly string[]).includes(raw.kind)
    ) {
      throw new StoryReviewError("unknown issue kind");
    }
    if (
      typeof raw.quote !== "string" ||
      !pyStrip(raw.quote) ||
      typeof raw.reason !== "string" ||
      !pyStrip(raw.reason)
    ) {
      throw new StoryReviewError("issue requires quote and reason");
    }
    if (draft) {
      const quote = pyJoinWS(raw.quote);
      let authority: string;
      if (raw.kind === "causal_omission") {
        authority = transcript + "\n" + source;
      } else {
        const rows = step === 0 ? draft.steps : [draft.steps[(step as number) - 1]];
        authority = rows.map((row) => `${row.line}\n${row.jab}`).join("\n");
      }
      if (!pyJoinWS(authority).includes(quote)) {
        quoteWarnings.push({
          step: step as number,
          quote: raw.quote,
          warning: "Unverified reviewer citation; check original source, not this paraphrase.",
        });
      }
    }
  }
  if ((data.verdict === "accept") !== (data.issues.length === 0)) {
    throw new StoryReviewError("story verdict contradicts issues");
  }
  let out = data as unknown as StoryReview;
  if (quoteWarnings.length) {
    out = { ...data, citation_warnings: quoteWarnings } as unknown as StoryReview;
  }
  return out;
}

export const validate_review = validateReview;

// ---------------------------------------------------------------------------
// story_writer.generate, split into plan / draft / review / orchestration
// ---------------------------------------------------------------------------

/** `json.dumps({'events':[...], 'cast':...}, ensure_ascii=False, indent=1)`. */
function buildSource(obs: Obs, bible: Bible): string {
  const events = Array.isArray(obs?.events) ? obs.events : [];
  return jsonIndent1({
    events: events.map((event, i) => ({ n: i + 1, event })),
    cast: castContext(obs, bible),
  });
}

/** Optional ElevenLabs delivery-tag contract, or the plain "no tags" sentence. */
function buildDelivery(emotion: boolean): string {
  if (!emotion) return "No bracketed delivery tags.";
  return (
    "Optional 3rd-person narrator delivery tags (narration-style storytelling tone only; " +
    "NEVER act out a character's emotion or match an emotion word in the line such as " +
    '"she was crying in her room" with a crying voice - the words carry the character\'s ' +
    "feeling, while tags only set the 3rd-person narrator tone; most lines need no tag): " +
    EMOTION_TAGS.map((t) => `[${t}]`).join(", ")
  );
}

function writeDiag(dir: string | null | undefined, name: string, text: string): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, "utf8");
}

export interface DraftResult {
  draft: Draft;
  /** The exact drafting prompt; the repair prompt is built from it. */
  prompt: string;
  source: string;
}

/**
 * Phase 1: the factual causal backbone. No raw captions, panel ids, event micro-steps
 * or images may reach this call.
 */
export async function planStory(
  obs: Obs,
  bible: Bible,
  transcript: string,
  opts: StoryCallOptions = {},
): Promise<StoryPlan> {
  const previous = opts.previous ?? "";
  const opening = opts.opening ?? "";
  const source = buildSource(obs, bible);
  const planPrompt = pyStrFormat(STORY_PLAN_TASK, {
    source,
    transcript,
    previous,
    opening,
    so_far: opts.soFar || "(none yet)",
    upcoming: opts.upcoming ? opts.upcoming.replace(/\n*$/, "\n") : "",
    shape_plan: (opts.shape ?? SHAPE_EPISODE).plan,
  });
  writeDiag(opts.diagnosticsDir, "plan-prompt.txt", planPrompt);
  const planned = await call([{ role: "user", content: planPrompt }], {
    maxTokens: 8000,
    temperature: 0.0,
    tag: "story plan",
    lane: "writer",
    stage: "writer",
    retries: 1,
  });
  writeDiag(opts.diagnosticsDir, "plan-response.json", jsonIndent1(planned));
  try {
    const events = Array.isArray(obs?.events) ? obs.events : [];
    const plan = validatePlan(parseJson(completionContent(planned)), events.length);
    try {
      opts.onPlan?.(plan);
    } catch {
      // a caller-side hook failure must not be blamed on the model's plan
    }
    return plan;
  } catch (e) {
    throw new StoryReviewError(`story plan contract: ${errMessage(e)}`);
  }
}

export const plan_story = planStory;

/**
 * Phase 2: the spoken draft. The writer sees ONLY the plan's premise/turns/scenes and
 * the cast - never the raw source. The reviewer, NOT the writer, gets full source again.
 */
export async function draftStory(
  plan: StoryPlan,
  obs: Obs,
  bible: Bible,
  transcript: string,
  opts: StoryCallOptions = {},
): Promise<DraftResult> {
  const previous = opts.previous ?? "";
  const opening = opts.opening ?? "";
  const delivery = buildDelivery(Boolean(opts.emotion));
  const source = buildSource(obs, bible);
  const narrativeSource = jsonIndent1({
    premise: plan.premise,
    turns: plan.turns,
    scenes: plan.moments.map((moment, i) => ({ scene: i + 1, ...moment })),
    cast: castContext(obs, bible).map((c) => ({
      name: c.name,
      aliases: c.aliases,
      role: c.role,
    })),
  });
  const prompt = pyStrFormat(STORY_TASK, {
    source: narrativeSource,
    transcript: "Original facts are checked independently after drafting.",
    so_far: opts.soFar || "(none yet)",
    previous,
    opening,
    delivery,
    shape_draft: (opts.shape ?? SHAPE_EPISODE).draft,
  });
  writeDiag(opts.diagnosticsDir, "draft-prompt.txt", prompt);
  const r = await call([{ role: "user", content: prompt }], {
    maxTokens: 6000,
    temperature: 0.7,
    tag: "story writer",
    lane: "writer",
    stage: "writer",
    retries: 1,
  });
  const raw = completionContent(r);
  writeDiag(opts.diagnosticsDir, "draft-response.json", jsonIndent1(r));
  try {
    return { draft: validateDraft(normalizeUnits(parseJson(raw))), prompt, source };
  } catch (e) {
    throw new StoryReviewError(`story draft contract: ${errMessage(e)}`);
  }
}

export const draft_story = draftStory;

/**
 * Phase 3: independent review of one draft against the FULL source. `prefix` selects the
 * diagnostics filenames and the call tag (revision review vs first review), exactly as
 * Python's `review_draft(candidate, prefix)`.
 */
export async function reviewStory(
  draft: Draft,
  plan: StoryPlan,
  obs: Obs,
  bible: Bible,
  transcript: string,
  opts: StoryCallOptions & { prefix?: string } = {},
): Promise<StoryReview> {
  const previous = opts.previous ?? "";
  const opening = opts.opening ?? "";
  const prefix = opts.prefix ?? "";
  const source = buildSource(obs, bible);
  const numbered = {
    source_plan: plan,
    outline: draft.outline,
    narration: draft.steps.map((row, i) => ({ step: i + 1, ...row })),
  };
  const reviewPrompt = pyStrFormat(STORY_REVIEW_TASK, {
    source,
    transcript,
    so_far: opts.soFar || "(none yet)",
    previous,
    opening,
    draft: pyJsonDumps(numbered, { ensureAscii: false }),
    shape_review: (opts.shape ?? SHAPE_EPISODE).review,
  });
  writeDiag(opts.diagnosticsDir, `${prefix}review-prompt.txt`, reviewPrompt);
  const reviewed = await call([{ role: "user", content: reviewPrompt }], {
    maxTokens: 4000,
    temperature: 0.0,
    tag: prefix ? "story correction review" : "story review",
    lane: "writer",
    stage: "writer",
    retries: 1,
  });
  writeDiag(opts.diagnosticsDir, `${prefix}review-response.json`, jsonIndent1(reviewed));
  try {
    return validateReview(parseJson(completionContent(reviewed)), draft.steps.length, {
      draft,
      transcript,
      source,
    });
  } catch (e) {
    throw new StoryReviewError(`story review contract: ${errMessage(e)}`);
  }
}

export const review_story = reviewStory;

/** 1-based steps a review flags, or null when it names the whole draft (step 0) / none. */
export function flaggedSteps(review: StoryReview, nSteps: number): number[] | null {
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const steps = new Set<number>();
  for (const i of issues) {
    const n = Number(i.step);
    if (!Number.isInteger(n) || n < 1 || n > nSteps) return null;
    steps.add(n);
  }
  return steps.size ? [...steps].sort((a, b) => a - b) : null;
}

/** Drop the helper `step` numbers a model may echo back from the numbered draft. */
function stripStepNumbers(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.steps)) return data;
  return {
    ...data,
    steps: data.steps.map((r) => {
      if (!isRecord(r) || !hasOwn(r, "step")) return r;
      const { step: _drop, ...rest } = r;
      return rest;
    }),
  };
}

/**
 * Apply a PATCH-mode reply: each flagged step is replaced by the given steps (or
 * cut); unflagged steps are kept verbatim. A patch for an unflagged step is ignored.
 */
export function applyPatches(draft: Draft, reply: unknown, flagged: number[]): Draft {
  if (!isRecord(reply) || !Array.isArray(reply.patches)) {
    throw new StoryReviewError("patch reply must contain patches");
  }
  const allowed = new Set(flagged);
  const repl = new Map<number, unknown[]>();
  for (const p of reply.patches) {
    if (!isRecord(p) || !Number.isInteger(p.step) || !Array.isArray(p.steps)) {
      throw new StoryReviewError("invalid patch entry");
    }
    if (allowed.has(p.step as number)) repl.set(p.step as number, p.steps as unknown[]);
  }
  const steps: unknown[] = [];
  draft.steps.forEach((row, i) => {
    const r = repl.get(i + 1);
    if (r === undefined) steps.push(row);
    else steps.push(...r);
  });
  if (!steps.length) throw new StoryReviewError("patches removed every step");
  return { ...draft, steps } as Draft;
}

/**
 * Scene planning -> drafting -> source review, with ONE bounded source-backed repair.
 * Returns the accepted draft, or raises StoryReviewError.
 */
export async function writeStoryScript(
  obs: Obs,
  bible: Bible,
  transcript: string,
  opts: StoryCallOptions = {},
): Promise<Draft> {
  const plan = await planStory(obs, bible, transcript, opts);
  const { draft: firstDraft, prompt, source } = await draftStory(plan, obs, bible, transcript, opts);
  let draft = firstDraft;
  const diag = opts.diagnosticsDir;
  let verdict: StoryReview;
  let structural: StoryReview | null = null;
  try {
    validateDraft(draft, plan.moments);
  } catch (e) {
    // Unit size / scene reference is repairable within the SAME single-correction budget.
    // This is a structural diagnostic, not a fabricated LLM semantic verdict.
    structural = {
      verdict: "reject",
      structural_error: errMessage(e),
      instruction:
        `Every step needs an existing scene reference; split any line over ${UNIT_MAX_WORDS} words or any jab over ${JAB_MAX_WORDS}.`,
    } as unknown as StoryReview;
    writeDiag(diag, "draft-structure-error.json", jsonIndent1(structural));
  }
  verdict = structural ?? (await reviewStory(draft, plan, obs, bible, transcript, opts));
  // Bounded source-backed repair. Round 1 may restructure the whole draft (a
  // structural error or a missing cause can need it); later rounds PATCH only the
  // flagged steps, so lines already accepted cannot regress into new issues.
  // STORY_REPAIRS (default 3, max 4) sets the budget.
  const rounds = Math.min(4, Math.max(1, Number.parseInt(process.env.STORY_REPAIRS ?? "3", 10) || 3));
  for (let round = 1; verdict.verdict !== "accept"; round++) {
    if (round > rounds) {
      // Budget spent. Only a lone caption-tour note may ship (a wording nit);
      // invented facts, broken continuity, factual jabs and missing causes block.
      const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
      const blocking = issues.filter((i) => !SOFT_REVIEW_KINDS.has(String(i.kind)));
      if (blocking.length === 0 && issues.length <= SOFT_ISSUE_LIMIT) {
        writeDiag(diag, "accepted-with-soft-issues.json", jsonIndent1(issues));
        process.stderr.write(
          `   story: accepted with ${issues.length} soft review note(s): ` +
            issues.map((i) => `step ${i.step} ${i.kind}`).join(", ") + "\n",
        );
        verdict = { ...verdict, verdict: "accept", soft_issues: issues, issues: [] };
        break;
      }
      throw new StoryReviewError(
        "story review rejected corrected draft: " +
          pyJsonDumps(verdict.issues, { ensureAscii: false }),
      );
    }
    const tag = round === 1 ? "revision-" : `revision${round}-`;
    const flagged = flaggedSteps(verdict, draft.steps.length);
    const patch = round > 1 && flagged !== null;
    const contract = patch
      ? "PATCH MODE: rewrite ONLY the flagged steps listed below; every other step is " +
        "accepted and must stay word-for-word. Reply STRICT JSON only: " +
        '{"patches":[{"step":<1-based step number>,"steps":[{"beat":"...","line":"...","jab":"","scene":<int>}]}]}. ' +
        "A patch replaces that one step with 1-3 steps (or [] to cut it). Keep the step's " +
        `scene unless the review shows it is wrong; ${UNIT_MAX_WORDS}-word unit maximum.\n` +
        `FLAGGED STEPS: ${flagged!.join(", ")}\n`
      : "Same strict JSON contract, every step " +
        `with an existing scene reference, ${UNIT_MAX_WORDS}-word unit maximum.\n`;
    // Keep all original evidence: original dialogue is needed here, not an
    // instruction to merely obey a fallible judge.
    const repairPrompt =
      prompt +
      `\n\nSOURCE-BACKED CORRECTION (attempt ${round} of ${rounds}):\n` +
      "Revise the supplied draft using the original facts. Fix only the flagged " +
      "problems: unsupported claims, false intervals or order, fused or misplaced " +
      "moments, unclear jumps or pronouns, caption-tour or 'then'-chain lines, factual " +
      "jabs, and a missing pivotal cause or payoff. For a continuity issue, re-read the " +
      "source around that moment and state the real place, time and order in a few " +
      "words (\"later that night\", \"back home\"). Rewrite a flagged line rather than " +
      "padding it; cut it if it carries nothing. Replace every 'and then' / ', then' " +
      "with a causal link (so, but, because) or a new sentence. The review is fallible: " +
      "if a claim is already paraphrased, do not duplicate it or invent facts to appease " +
      "the reviewer. Stay selective: do not add scenes, reactions or exchanges back just " +
      "to cover the source. Keep the cold open, causal glue and closing hook. " +
      contract +
      "ORIGINAL SOURCE:\n" +
      transcript +
      "\nORIGINAL EVENTS:\n" +
      source +
      "\nFALLIBLE REVIEW:\n" +
      pyJsonDumps(verdict, { ensureAscii: false }) +
      "\nDRAFT TO CORRECT:\n" +
      pyJsonDumps(
        { ...draft, steps: draft.steps.map((row, i) => ({ step: i + 1, ...row })) },
        { ensureAscii: false },
      );
    writeDiag(diag, `${tag}prompt.txt`, repairPrompt);
    const revised = await call([{ role: "user", content: repairPrompt }], {
      maxTokens: 6000,
      temperature: 0.2,
      tag: "story correction",
      lane: "writer",
      stage: "writer",
      retries: 1,
    });
    writeDiag(diag, `${tag}response.json`, jsonIndent1(revised));
    try {
      const parsed = parseJson(completionContent(revised));
      const next = patch ? applyPatches(draft, parsed, flagged!) : parsed;
      draft = validateDraft(normalizeUnits(stripStepNumbers(next)), plan.moments);
    } catch (e) {
      throw new StoryReviewError(`story correction contract: ${errMessage(e)}`);
    }
    verdict = await reviewStory(draft, plan, obs, bible, transcript, { ...opts, prefix: tag });
  }
  writeDiag(diag, "accepted-draft.json", jsonIndent1(draft));
  writeDiag(diag, "accepted-review.json", jsonIndent1(verdict));
  return draft;
}

export const write_story_script = writeStoryScript;

// ---------------------------------------------------------------------------
// writer.py: _steps_to_script (story-mode script assembler)
// ---------------------------------------------------------------------------
const STEP_TAG_RE = new RegExp(`[${PY_WS}]*@p\\p{Nd}+(?:_\\p{Nd}+)?`, "gu");

/**
 * STEPS (line + optional jab) -> script lines. A jab becomes its own short line right
 * after its step, so the fact-then-comment rhythm comes from the output shape.
 * Returns `[script, nSteps, nJabs]`, or `[null, 0, 0]` when there are no steps.
 *
 * JAB CEILING: the brief asks for <= 1 jab per 4 steps; code enforces it - a jab is kept
 * only when the last JAB_GAP steps carried none, and never beyond ceil(steps / JAB_GAP).
 */
export function _stepsToScript(txt: string): [string | null, number, number] {
  let parsed: unknown;
  try {
    parsed = parseJson(txt);
  } catch {
    return [null, 0, 0];
  }
  const steps = isRecord(parsed) ? parsed.steps : undefined;
  // Python: `if not steps: return None, 0, 0`. Python truthiness differs from JS for `[]`
  // and `{}` (both falsy in Python), so use an explicit check. A truthy non-list (a
  // string, a dict) then iterates to no dict entries and still yields the empty script.
  if (!pyTruthy(steps)) return [null, 0, 0];
  const list = Array.isArray(steps) ? steps : [];
  const out: string[] = [];
  let beat: string | null = null;
  let n = 0;
  let ns = 0;
  let nj = 0;
  const cap = Math.ceil(list.length / JAB_GAP);
  let since = JAB_GAP;
  for (const st of list) {
    if (!isRecord(st)) continue;
    const lineRaw = hasOwn(st, "line") ? pyStr(st.line) : "";
    const line = pyStrip(lineRaw.replace(STEP_TAG_RE, ""));
    if (!line) continue;
    const beatRaw = hasOwn(st, "beat") && st.beat ? pyStr(st.beat) : "beat";
    const b = beatRaw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    if (b !== beat) {
      n += 1;
      beat = b;
      out.push(`\n## BEAT b${String(n).padStart(2, "0")}_${b}`);
    }
    out.push(line);
    ns += 1;
    const jabRaw = hasOwn(st, "jab") ? pyStr(st.jab) : "";
    let jab = pyStrip(jabRaw.replace(STEP_TAG_RE, ""));
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

export const _steps_to_script = _stepsToScript;

export default {
  castContext,
  validateDraft,
  validatePlan,
  validateReview,
  planStory,
  draftStory,
  reviewStory,
  writeStoryScript,
  _stepsToScript,
};
