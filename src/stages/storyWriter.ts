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
  /** ElevenLabs v3 inline delivery tags on the drafting call. */
  emotion?: boolean;
  /** Directory for prompt/response diagnostics; null disables every write. */
  diagnosticsDir?: string | null;
}

export const UNIT_MAX_WORDS = 24;
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

/** `moments` null/undefined -> skip timing, per-scene and coverage checks. */
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
      if (words.length > UNIT_MAX_WORDS || (raw.line as string).includes("\n")) {
        throw new StoryReviewError(
          `step ${n} is an oversized spoken unit (${words.length} words, max ${UNIT_MAX_WORDS})`,
        );
      }
      if (pySplit(raw.jab as string).length > 12) {
        throw new StoryReviewError(`step ${n} has an oversized reaction`);
      }
    }
  });
  if (moments != null) {
    const covered = new Set(steps.map((row) => (row as Step).scene));
    const missing: number[] = [];
    for (let s = 1; s <= moments.length; s++) if (!covered.has(s)) missing.push(s);
    if (missing.length) {
      throw new StoryReviewError(`draft skips planned scenes: [${missing.join(", ")}]`);
    }
  }
  return data as unknown as Draft;
}

export const validate_draft = validateDraft;

export function validatePlan(data: unknown, nEvents?: number | null): StoryPlan {
  if (
    !isRecord(data) ||
    !exactKeys(data, ["premise", "turns", "moments", "omitted_events"]) ||
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
  if (!Array.isArray(data.omitted_events)) {
    throw new StoryReviewError("omitted_events must explicitly explain source exclusions");
  }
  for (const raw of data.omitted_events) {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["event", "reason"]) ||
      typeof raw.event !== "number" ||
      !Number.isInteger(raw.event) ||
      raw.event < 1 ||
      typeof raw.reason !== "string" ||
      !pyStrip(raw.reason)
    ) {
      throw new StoryReviewError("invalid omitted event");
    }
    if (accounted.has(raw.event)) throw new StoryReviewError("covered event also marked omitted");
    accounted.add(raw.event);
  }
  if (nEvents) {
    const want = new Set<number>();
    for (let i = 1; i <= nEvents; i++) want.add(i);
    const same = accounted.size === want.size && [...want].every((i) => accounted.has(i));
    if (!same) {
      throw new StoryReviewError(
        "plan must account for every original event, with no invented references",
      );
    }
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
    return validatePlan(parseJson(completionContent(planned)), events.length);
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
    previous,
    opening,
    delivery,
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
    return { draft: validateDraft(parseJson(raw)), prompt, source };
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
    previous,
    opening,
    draft: pyJsonDumps(numbered, { ensureAscii: false }),
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
    // Timing/coverage is repairable within the SAME single-correction budget.
    // This is a structural diagnostic, not a fabricated LLM semantic verdict.
    structural = {
      verdict: "reject",
      structural_error: errMessage(e),
      instruction:
        "Check ALL units and cover ALL scene references; split, do not delete story facts.",
    } as unknown as StoryReview;
    writeDiag(diag, "draft-structure-error.json", jsonIndent1(structural));
  }
  verdict = structural ?? (await reviewStory(draft, plan, obs, bible, transcript, opts));
  if (verdict.verdict !== "accept") {
    // One content correction, not reroll-until-accept. Keep all original evidence.
    // A missed exchange may not be represented in the reader's events; original
    // dialogue is needed here, not an instruction to merely obey a fallible judge.
    const repairPrompt =
      prompt +
      "\n\nSOURCE-BACKED CORRECTION (one attempt):\n" +
      "Revise the supplied draft using the original facts. Preserve correct " +
      "scenes and chronology. Address genuine omissions or unsupported claims. " +
      "The review is fallible: if a claim is already paraphrased, do not duplicate " +
      "it or invent facts to appease the reviewer. Give distinct spoken units " +
      "to questions, consequential responses and reveals. Remove decorative " +
      "caption-tour wording while keeping substantive exchanges. Same strict " +
      "JSON contract, all scene references, 24-word unit maximum.\n" +
      "ORIGINAL SOURCE:\n" +
      transcript +
      "\nORIGINAL EVENTS:\n" +
      source +
      "\nFALLIBLE REVIEW:\n" +
      pyJsonDumps(verdict, { ensureAscii: false }) +
      "\nDRAFT TO CORRECT:\n" +
      pyJsonDumps(draft, { ensureAscii: false });
    writeDiag(diag, "revision-prompt.txt", repairPrompt);
    const revised = await call([{ role: "user", content: repairPrompt }], {
      maxTokens: 6000,
      temperature: 0.2,
      tag: "story correction",
      lane: "writer",
      stage: "writer",
      retries: 1,
    });
    writeDiag(diag, "revision-response.json", jsonIndent1(revised));
    try {
      draft = validateDraft(parseJson(completionContent(revised)), plan.moments);
    } catch (e) {
      throw new StoryReviewError(`story correction contract: ${errMessage(e)}`);
    }
    verdict = await reviewStory(draft, plan, obs, bible, transcript, { ...opts, prefix: "revision-" });
    if (verdict.verdict !== "accept") {
      throw new StoryReviewError(
        "story review rejected corrected draft: " +
          pyJsonDumps(verdict.issues, { ensureAscii: false }),
      );
    }
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
