/**
 * Read-only view of a series' movie plan (out/movie_plan.json) joined with
 * per-chapter render state. Never writes; tolerates missing or corrupt files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertNoSymlinks } from './storageTrash.js';

export const MOVIE_ROLES = ['opening', 'setup', 'rising', 'climax', 'payoff', 'aftermath', 'filler'] as const;
export const MOVIE_EXITS = ['flow', 'act_break', 'finale'] as const;
export type MovieRole = typeof MOVIE_ROLES[number];
export type MovieExit = typeof MOVIE_EXITS[number];

export interface MoviePlanChapter {
  ch: string;
  role: MovieRole;
  budget_s: number;
  entry: string;
  focus: string;
  exit: MovieExit;
  threads_open: string[];
  threads_paid: string[];
}

export interface MoviePlanChapterView extends MoviePlanChapter {
  rendered: boolean;
  durationS?: number;
  style?: { onTarget: number; total: number; misses: string[] };
}

export interface MoviePlanView {
  exists: boolean;
  plan?: { version: number; chapters: Record<string, MoviePlanChapter>; arc: Record<string, string>; open_threads: string[] };
  chapters: MoviePlanChapterView[];
  arc_summary: string;
  open_threads: string[];
}

const EMPTY: MoviePlanView = { exists: false, chapters: [], arc_summary: '', open_threads: [] };
const CH_RE = /^ch(\d{1,4})$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 2000;

function chapterNumber(key: string): number | null {
  const m = CH_RE.exec(key);
  return m ? Number(m[1]) : null;
}

/** Resolve `parts` inside `base`, refusing traversal and symlinks anywhere on the path. */
function inside(base: string, ...parts: string[]): string | null {
  const root = path.resolve(base);
  const file = path.resolve(root, ...parts);
  if (!file.startsWith(root + path.sep)) return null;
  try { assertNoSymlinks(file); } catch { return null; }
  return file;
}

function readJson(file: string | null): unknown {
  if (!file) return null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, MAX_TEXT)).slice(0, 200) : [];
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function sanitizeChapter(key: string, raw: unknown): MoviePlanChapter | null {
  if (!isObject(raw)) return null;
  const role = MOVIE_ROLES.includes(raw.role as MovieRole) ? raw.role as MovieRole : 'filler';
  const exit = MOVIE_EXITS.includes(raw.exit as MovieExit) ? raw.exit as MovieExit : 'flow';
  return {
    ch: key,
    role,
    budget_s: Math.round(finiteNumber(raw.budget_s) ?? 0),
    entry: text(raw.entry),
    focus: text(raw.focus),
    exit,
    threads_open: strings(raw.threads_open),
    threads_paid: strings(raw.threads_paid),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Duration from render metadata only (no ffprobe): shots.json last end_s, then tts_durs.json sum, then report.duration. */
function chapterDuration(outDir: string, key: string, report: unknown): number | undefined {
  // The rendered video's duration wins: shots.json can be newer than the published video.
  if (isObject(report)) {
    const d = finiteNumber(report.duration);
    if (d !== undefined && d > 0) return round1(d);
  }
  const shots = readJson(inside(outDir, key, 'video', 'shots.json'));
  const list = isObject(shots) && Array.isArray(shots.shots) ? shots.shots : Array.isArray(shots) ? shots : null;
  if (list && list.length) {
    const ends = list.map((s) => (isObject(s) ? finiteNumber(s.end_s) : undefined)).filter((n): n is number => n !== undefined);
    if (ends.length) return round1(Math.max(...ends));
  }
  const durs = readJson(inside(outDir, key, 'video', 'tts_durs.json'));
  if (Array.isArray(durs) && durs.length) {
    const nums = durs.map(finiteNumber);
    if (nums.every((n) => n !== undefined)) return round1((nums as number[]).reduce((a, b) => a + b, 0));
  }
  return undefined;
}

function chapterStyle(report: unknown): MoviePlanChapterView['style'] {
  if (!isObject(report) || !isObject(report.style) || !Array.isArray(report.style.metrics)) return undefined;
  const metrics = report.style.metrics.filter(isObject);
  if (!metrics.length) return undefined;
  const misses = metrics.filter((m) => m.ok !== true).map((m) => text(m.key) || '?');
  return { onTarget: metrics.length - misses.length, total: metrics.length, misses };
}

function isRendered(outDir: string, key: string): boolean {
  const file = inside(outDir, key, 'video', 'video.mp4');
  if (!file) return false;
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Build the movie plan view for an already-resolved series directory. */
export function getMoviePlanView(seriesDir: string): MoviePlanView {
  const outDir = inside(seriesDir, 'out');
  if (!outDir) return { ...EMPTY };
  const raw = readJson(inside(outDir, 'movie_plan.json'));
  if (!isObject(raw) || !isObject(raw.chapters)) return { ...EMPTY };

  const chapters: Record<string, MoviePlanChapter> = {};
  for (const [key, value] of Object.entries(raw.chapters)) {
    if (chapterNumber(key) === null) continue;
    const ch = sanitizeChapter(key, value);
    if (ch) chapters[key] = ch;
  }
  const keys = Object.keys(chapters).sort((a, b) => chapterNumber(a)! - chapterNumber(b)!);
  if (!keys.length) return { ...EMPTY };

  const arc: Record<string, string> = {};
  if (isObject(raw.arc)) {
    for (const [key, value] of Object.entries(raw.arc)) {
      if (chapterNumber(key) !== null && typeof value === 'string') arc[key] = text(value);
    }
  }
  const arcKeys = Object.keys(arc).sort((a, b) => chapterNumber(a)! - chapterNumber(b)!);
  const arc_summary = arcKeys.length ? arc[arcKeys[arcKeys.length - 1]!]! : '';
  const open_threads = strings(raw.open_threads);

  const views: MoviePlanChapterView[] = keys.map((key) => {
    const report = readJson(inside(outDir, key, 'report.json'));
    const view: MoviePlanChapterView = { ...chapters[key]!, rendered: isRendered(outDir, key) };
    const durationS = chapterDuration(outDir, key, report);
    if (durationS !== undefined) view.durationS = durationS;
    const style = chapterStyle(report);
    if (style) view.style = style;
    return view;
  });

  return {
    exists: true,
    plan: { version: finiteNumber(raw.version) ?? 1, chapters, arc, open_threads },
    chapters: views,
    arc_summary,
    open_threads,
  };
}
