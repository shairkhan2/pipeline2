/**
 * Movie mode: one continuous narration across many chapters.
 *
 * Per-chapter story writing produces standalone episodes (cold open + closing hook)
 * that seam audibly when merged into a 1-3 h video. Movie mode adds an ARC PLAN that
 * looks across chapters in blocks and decides, per chapter, its role, a time budget
 * (filler 20-45 s, a climax several minutes), how its narration enters from the
 * previous chapter and whether it exits mid-flow (almost always) or on an act break.
 * Each chapter is then written as a continuation of the narration already spoken:
 * the writer sees the previous chapter's last lines and must follow straight on.
 *
 * Long context is handled by sliding blocks: the planner sees the compact arc summary
 * and open threads of everything before, the full events of the next ARC_BLOCK
 * chapters and a short look-ahead past them. Nothing ever needs the whole series in
 * one prompt.
 *
 * Persisted at out/movie_plan.json (versioned; a version change replans).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ARC_PLAN_TASK,
  SHAPE_EXIT,
  SHAPE_MOVIE_CONTINUE,
  SHAPE_MOVIE_OPEN,
} from "../contracts/briefs.js";
import { call, parseJson } from "../llm/client.js";
import type { StoryShape } from "./storyWriter.js";

export const MOVIE_PLAN_FILE = "movie_plan.json";
export const MOVIE_PLAN_VERSION = 1;
export const ARC_BLOCK = 8;
export const ARC_AHEAD = 3;
export const BUDGET_MIN_S = 20;
export const BUDGET_MAX_S = 300;
export const BUDGET_AVG_S = 110;
/** Narration words per second (matches the writer's TTS pacing estimate). */
export const WORDS_PER_S = 3.2;
export const HANDOFF_LINES = 3;

export const ROLES = ["opening", "setup", "rising", "climax", "payoff", "aftermath", "filler"] as const;
export const EXITS = ["flow", "act_break", "finale"] as const;
export type Role = (typeof ROLES)[number];
export type Exit = (typeof EXITS)[number];

export interface ChapterPlan {
  ch: string;
  role: Role;
  budget_s: number;
  entry: string;
  focus: string;
  exit: Exit;
  threads_open: string[];
  threads_paid: string[];
}

export interface MoviePlan {
  version: number;
  chapters: Record<string, ChapterPlan>;
  /** Arc summary after each planned block, keyed by the block's last chapter. */
  arc: Record<string, string>;
  open_threads: string[];
}

const chNum = (ch: string): number => {
  const m = /\d+/.exec(ch);
  return m ? Number.parseInt(m[0], 10) : 0;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strList = (v: unknown, cap = 8): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).slice(0, cap) : [];

export function readMoviePlan(outDir: string): MoviePlan {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(outDir, MOVIE_PLAN_FILE), "utf8")) as MoviePlan;
    if (d && d.version === MOVIE_PLAN_VERSION && isRec(d.chapters)) {
      return { version: d.version, chapters: { ...d.chapters }, arc: { ...(d.arc ?? {}) }, open_threads: strList(d.open_threads, 30) };
    }
  } catch {
    // missing/corrupt: replan
  }
  return { version: MOVIE_PLAN_VERSION, chapters: {}, arc: {}, open_threads: [] };
}

function writeMoviePlan(outDir: string, plan: MoviePlan): void {
  const dest = path.join(outDir, MOVIE_PLAN_FILE);
  const tmp = path.join(outDir, `.movie-plan-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 1));
    fs.renameSync(tmp, dest);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** Validate one planner row; clamp numbers, never trust enums blindly. */
export function normalizeChapterPlan(raw: unknown, ch: string, isFirst: boolean, isLast: boolean): ChapterPlan {
  const r = isRec(raw) ? raw : {};
  let role = (ROLES as readonly string[]).includes(String(r.role)) ? (r.role as Role) : "rising";
  if (isFirst) role = "opening";
  else if (role === "opening") role = "setup";
  let exit = (EXITS as readonly string[]).includes(String(r.exit)) ? (r.exit as Exit) : "flow";
  if (exit === "finale" && !isLast) exit = "act_break";
  const b = Number(r.budget_s);
  const budget = Number.isFinite(b) ? Math.round(Math.min(BUDGET_MAX_S, Math.max(BUDGET_MIN_S, b))) : BUDGET_AVG_S;
  const entry = typeof r.entry === "string" && r.entry.trim() ? r.entry.trim().slice(0, 120) : isFirst ? "movie opening" : "right after that";
  const focus = typeof r.focus === "string" ? r.focus.trim().slice(0, 500) : "";
  return { ch, role, budget_s: budget, entry, focus, exit, threads_open: strList(r.threads_open), threads_paid: strList(r.threads_paid) };
}

/** Deterministic plan when the planner is unavailable: even budget, flowing exits. */
export function fallbackPlan(ch: string, isFirst: boolean, isLast = false): ChapterPlan {
  // No planner verdict: never invent a finale (the series may be ongoing).
  return normalizeChapterPlan({ exit: "flow" }, ch, isFirst, isLast);
}

/** Single-pass {name} substitution: injected text is never re-scanned. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (m, k?: string) =>
    m === "{{" ? "{" : m === "}}" ? "}" : k !== undefined && k in values ? values[k]! : m,
  );
}

export interface ArcInput {
  /** Ordered chapter ids of the whole run (e.g. ch1..chN). */
  chapters: string[];
  /** Events for a chapter (from obs); [] when not read yet. */
  events: (ch: string) => string[];
}

function blockEvents(chs: string[], events: ArcInput["events"], cap: number): string {
  return chs
    .map((c) => {
      const ev = events(c);
      const lines = ev.slice(0, cap).map((e) => `- ${e.replace(/\s+/g, " ").trim()}`);
      if (ev.length > cap) lines.push(`- (+${ev.length - cap} smaller events)`);
      return `${c}:\n${lines.join("\n") || "- (not read yet)"}`;
    })
    .join("\n");
}

/**
 * Ensure every chapter in `chapters` has a plan, planning in blocks of ARC_BLOCK.
 * Existing plans are kept (a rerun never reshuffles budgets already spoken).
 */
export async function ensureMoviePlan(outDir: string, input: ArcInput, opts: { diagnosticsDir?: string | null } = {}): Promise<MoviePlan> {
  const plan = readMoviePlan(outDir);
  const order = [...input.chapters].sort((a, b) => chNum(a) - chNum(b));
  const first = order[0];
  const last = order[order.length - 1];
  // The series grew since an earlier plan: only the current last chapter may close it.
  for (const [c, cp] of Object.entries(plan.chapters)) {
    if (cp.exit === "finale" && c !== last) plan.chapters[c] = { ...cp, exit: "act_break" };
  }
  for (let i = 0; i < order.length; i += ARC_BLOCK) {
    // Only chapters already read can be planned; unread ones are planned on a later
    // call (the writer uses an unsaved fallback for them meanwhile).
    const block = order.slice(i, i + ARC_BLOCK).filter((c) => !plan.chapters[c] && input.events(c).length > 0);
    if (!block.length) continue;
    const before = order.slice(0, order.indexOf(block[0]!));
    const arcKeys = Object.keys(plan.arc).filter((k) => chNum(k) < chNum(block[0]!)).sort((a, b) => chNum(a) - chNum(b));
    const arcSoFar = arcKeys.length ? plan.arc[arcKeys[arcKeys.length - 1]!]! : before.length ? "(earlier chapters planned without a summary)" : "(this block opens the movie)";
    const ahead = order.slice(i + ARC_BLOCK, i + ARC_BLOCK + ARC_AHEAD);
    const prompt = fill(ARC_PLAN_TASK, {
      arc_so_far: arcSoFar,
      threads: plan.open_threads.length ? plan.open_threads.map((t) => `- ${t}`).join("\n") : "(none)",
      chapters: blockEvents(block, input.events, 40),
      ahead: ahead.length ? blockEvents(ahead, input.events, 8) : "(none: this block reaches the end of the available chapters)",
      min_s: String(BUDGET_MIN_S),
      max_s: String(BUDGET_MAX_S),
      avg_s: String(BUDGET_AVG_S),
    });
    if (opts.diagnosticsDir) {
      fs.mkdirSync(opts.diagnosticsDir, { recursive: true });
      fs.writeFileSync(path.join(opts.diagnosticsDir, `arc-${block[0]}-prompt.txt`), prompt);
    }
    let rows: Record<string, unknown> = {};
    let summary = "";
    let threads: string[] = plan.open_threads;
    try {
      const r = await call([{ role: "user", content: prompt }], {
        maxTokens: 6000,
        temperature: 0.2,
        tag: "movie arc plan",
        lane: "writer",
        stage: "writer",
        retries: 1,
      });
      const content = r?.choices?.[0]?.message?.content ?? "";
      if (opts.diagnosticsDir) fs.writeFileSync(path.join(opts.diagnosticsDir, `arc-${block[0]}-response.txt`), String(content));
      const d = parseJson(String(content)) as Record<string, unknown>;
      for (const row of Array.isArray(d.chapters) ? d.chapters : []) {
        if (isRec(row) && typeof row.ch === "string") rows[row.ch] = row;
      }
      summary = typeof d.arc_summary === "string" ? d.arc_summary.trim().slice(0, 1200) : "";
      threads = strList(d.open_threads, 30);
    } catch (e) {
      process.stderr.write(`   movie: arc plan for ${block[0]}..${block[block.length - 1]} unavailable (${e instanceof Error ? e.message : String(e)}); using even budgets\n`);
      rows = {};
    }
    for (const c of block) {
      plan.chapters[c] = rows[c] ? normalizeChapterPlan(rows[c], c, c === first, c === last) : fallbackPlan(c, c === first, c === last);
    }
    if (summary) plan.arc[block[block.length - 1]!] = summary;
    plan.open_threads = threads;
    writeMoviePlan(outDir, plan);
  }
  return plan;
}

/** Narration lines (no headers/tags) of a written script. */
export function spokenLines(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/@p\d+(?:_\d+)?\b|@hold\b|\[[a-z ]+\]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The previous chapter's last spoken lines, the bridge the next chapter continues from. */
export function handoffLines(outDir: string, ch: string, n = HANDOFF_LINES): string {
  const k = chNum(ch);
  for (let i = k - 1; i > 0; i--) {
    const p = path.join(outDir, `ch${i}`, "script.md");
    if (fs.existsSync(p)) {
      const lines = spokenLines(fs.readFileSync(p, "utf8"));
      return lines.slice(-n).join("\n");
    }
  }
  return "";
}

/** Prompt shape blocks for one chapter of the movie. */
export function movieShape(cp: ChapterPlan, handoff: string): StoryShape {
  const words = Math.round(cp.budget_s * WORDS_PER_S);
  const lines = Math.max(2, Math.round(words / 26));
  const exit = SHAPE_EXIT[cp.exit];
  const budgetPlan =
    `- TIME BUDGET: about ${cp.budget_s}s of narration (~${words} words, ~${lines} lines). ` +
    (cp.role === "filler"
      ? "This chapter is filler for the movie: keep only its 1-3 moments that matter."
      : `Role in the movie: ${cp.role}. Keep only the moments that fit this budget.`);
  const budgetDraft = `- LENGTH: about ${words} words in total (~${lines} lines); never pad to fill it.`;
  const opening = cp.role === "opening";
  if (opening) {
    return {
      plan: SHAPE_MOVIE_OPEN.plan.replace("@@BUDGET_PLAN@@", budgetPlan),
      draft: SHAPE_MOVIE_OPEN.draft.replace("@@BUDGET_DRAFT@@", budgetDraft),
      review: SHAPE_MOVIE_OPEN.review,
    };
  }
  const fill = (t: string) =>
    t
      .replace(/@@ENTRY@@/g, cp.entry)
      .replace(/@@ROLE@@/g, cp.role)
      .replace(/@@FOCUS@@/g, cp.focus || "deliver this chapter's turn and skip the rest")
      .replace(/@@HANDOFF@@/g, handoff || "(unavailable: continue the story naturally from STORY SO FAR)")
      .replace(/@@EXIT_PLAN@@/g, exit.plan)
      .replace(/@@EXIT_DRAFT@@/g, exit.draft)
      .replace(/@@EXIT_REVIEW@@/g, exit.review)
      .replace(/@@BUDGET_PLAN@@/g, budgetPlan)
      .replace(/@@BUDGET_DRAFT@@/g, budgetDraft);
  return { plan: fill(SHAPE_MOVIE_CONTINUE.plan), draft: fill(SHAPE_MOVIE_CONTINUE.draft), review: fill(SHAPE_MOVIE_CONTINUE.review) };
}

/** Story mode is a movie unless a series opts out (style.storyShape = "episode") or STORY_SHAPE=episode. */
export function storyShapeMode(style: { storyShape?: string } | undefined, env: NodeJS.ProcessEnv = process.env): "movie" | "episode" {
  const v = String(style?.storyShape ?? env.STORY_SHAPE ?? "movie").toLowerCase();
  return v === "episode" ? "episode" : "movie";
}

/** Arc summary and open threads the writer sees for `ch` (movie memory beyond the window). */
export function arcContext(plan: MoviePlan, ch: string): string {
  const keys = Object.keys(plan.arc).filter((k) => chNum(k) < chNum(ch)).sort((a, b) => chNum(a) - chNum(b));
  const parts: string[] = [];
  if (keys.length) parts.push(`MOVIE SO FAR: ${plan.arc[keys[keys.length - 1]!]}`);
  if (plan.open_threads.length) parts.push(`OPEN THREADS: ${plan.open_threads.slice(0, 12).join("; ")}`);
  return parts.join("\n");
}
