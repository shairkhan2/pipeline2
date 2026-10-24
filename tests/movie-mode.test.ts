import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/client.js')>();
  return { ...actual, call: vi.fn() };
});

import { call } from '../src/llm/client.js';
import {
  ARC_BLOCK,
  BUDGET_MAX_S,
  BUDGET_MIN_S,
  arcContext,
  ensureMoviePlan,
  handoffLines,
  movieShape,
  normalizeChapterPlan,
  readMoviePlan,
  storyShapeMode,
} from '../src/stages/movie.js';

const mockedCall = vi.mocked(call);
const reply = (o: unknown) => ({ choices: [{ message: { content: JSON.stringify(o) } }] }) as never;

let out: string;
beforeEach(() => {
  out = fs.mkdtempSync('/tmp/opencode/movie-');
});
afterEach(() => {
  fs.rmSync(out, { recursive: true, force: true });
  mockedCall.mockReset();
});

describe('movie plan rows', () => {
  it('clamps budgets, forces the first chapter to open and only the last to be a finale', () => {
    const a = normalizeChapterPlan({ role: 'climax', budget_s: 9999, exit: 'finale' }, 'ch1', true, false);
    expect(a.role).toBe('opening');
    expect(a.budget_s).toBe(BUDGET_MAX_S);
    expect(a.exit).toBe('act_break');
    const b = normalizeChapterPlan({ role: 'nonsense', budget_s: 1, exit: 'finale' }, 'ch9', false, true);
    expect(b.role).toBe('rising');
    expect(b.budget_s).toBe(BUDGET_MIN_S);
    expect(b.exit).toBe('finale');
  });
});

describe('movie shapes', () => {
  const cp = normalizeChapterPlan({ role: 'rising', budget_s: 90, entry: 'the next morning', focus: 'the duel', exit: 'flow' }, 'ch2', false, false);

  it('first chapter gets a real introduction and no teaser ending', () => {
    const s = movieShape({ ...cp, role: 'opening' }, '');
    expect(s.plan).toMatch(/OPENS A LONG MOVIE/);
    expect(s.draft).toMatch(/real introduction/);
    expect(s.draft).not.toMatch(/@@/);
  });

  it('later chapters continue from the hand-off lines with no cold open or hook', () => {
    const s = movieShape(cp, 'She says there is something else she wants to eat.');
    expect(s.draft).toContain('She says there is something else she wants to eat.');
    expect(s.draft).toMatch(/No cold open/);
    expect(s.draft).toMatch(/no hook, no teaser/);
    expect(s.plan).toContain('the next morning');
    expect(s.plan).toContain('the duel');
    expect(s.draft).toMatch(/about 288 words/);
    for (const t of [s.plan, s.draft, s.review]) expect(t).not.toMatch(/@@/);
  });

  it('an act break may end on a grounded hook', () => {
    expect(movieShape({ ...cp, exit: 'act_break' }, 'x').draft).toMatch(/act's real turn as a hook/);
  });

  it('defaults to movie; a series can opt into standalone episodes', () => {
    expect(storyShapeMode(undefined, {})).toBe('movie');
    expect(storyShapeMode({ storyShape: 'episode' }, {})).toBe('episode');
    expect(storyShapeMode(undefined, { STORY_SHAPE: 'episode' })).toBe('episode');
  });
});

describe('hand-off', () => {
  it('takes the last spoken lines of the nearest earlier chapter, without tags', () => {
    fs.mkdirSync(path.join(out, 'ch1'));
    fs.writeFileSync(path.join(out, 'ch1', 'script.md'), '# STORY_UNITS v1\n## BEAT b1\nOne. @p0001_1\nTwo. @p0002_1\nWow. @hold\nThree. @p0003_1\n');
    expect(handoffLines(out, 'ch3', 2)).toBe('Wow.\nThree.');
    expect(handoffLines(out, 'ch1')).toBe('');
  });
});

describe('arc planning in blocks', () => {
  const chapters = Array.from({ length: ARC_BLOCK + 2 }, (_, i) => `ch${i + 1}`);
  const events = (c: string) => [`${c} event a`, `${c} event b`];

  it('plans every read chapter once, block by block, and keeps the arc memory', async () => {
    const prompts: string[] = [];
    mockedCall.mockImplementation(async (m: unknown) => {
      const p = (m as Array<{ content: string }>)[0]!.content;
      prompts.push(p);
      const chs = [...p.matchAll(/^(ch\d+):$/gm)].map((x) => x[1]!);
      const block = chs.slice(0, chs.length);
      return reply({
        chapters: block.map((ch) => ({ ch, role: 'rising', budget_s: ch === 'ch3' ? 30 : 140, entry: 'right after', focus: 'f', exit: 'flow' })),
        arc_summary: `summary through ${block[block.length - 1]}`,
        open_threads: ['the gate'],
      });
    });
    const plan = await ensureMoviePlan(out, { chapters, events });
    expect(Object.keys(plan.chapters)).toHaveLength(chapters.length);
    expect(plan.chapters.ch1!.role).toBe('opening');
    expect(plan.chapters.ch3!.budget_s).toBe(30);
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain('summary through');
    expect(prompts[1]).toContain('- the gate');
    expect(arcContext(plan, `ch${ARC_BLOCK + 2}`)).toMatch(/MOVIE SO FAR/);

    mockedCall.mockClear();
    await ensureMoviePlan(out, { chapters, events });
    expect(mockedCall).not.toHaveBeenCalled();
    expect(readMoviePlan(out).chapters.ch3!.budget_s).toBe(30);
  });

  it('skips unread chapters and falls back to even budgets when the planner fails', async () => {
    mockedCall.mockRejectedValue(new Error('offline'));
    const plan = await ensureMoviePlan(out, { chapters: ['ch1', 'ch2', 'ch3'], events: (c) => (c === 'ch3' ? [] : ['e']) });
    expect(Object.keys(plan.chapters).sort()).toEqual(['ch1', 'ch2']);
    expect(plan.chapters.ch2!.exit).toBe('flow');
  });
});

describe('movie plan review fixes', () => {
  it('only the first chapter may be the opening', () => {
    expect(normalizeChapterPlan({ role: 'opening' }, 'ch4', false, false).role).toBe('setup');
    const s = movieShape(normalizeChapterPlan({ role: 'opening' }, 'ch4', false, false), '');
    expect(s.draft).toMatch(/No cold open/);
    expect(s.draft).toContain('(unavailable: continue the story naturally');
  });

  it('demotes an old finale when the series grows', async () => {
    fs.writeFileSync(path.join(out, 'movie_plan.json'), JSON.stringify({
      version: 1, arc: {}, open_threads: [],
      chapters: { ch1: normalizeChapterPlan({}, 'ch1', true, false), ch2: normalizeChapterPlan({ exit: 'finale' }, 'ch2', false, true) },
    }));
    mockedCall.mockRejectedValue(new Error('offline'));
    const plan = await ensureMoviePlan(out, { chapters: ['ch1', 'ch2', 'ch3'], events: () => ['e'] });
    expect(plan.chapters.ch2!.exit).toBe('act_break');
    expect(plan.chapters.ch3!.exit).toBe('flow');
  });

  it('substitutes placeholders in one pass (event text cannot inject prompt slots)', async () => {
    const prompts: string[] = [];
    mockedCall.mockImplementation(async (m: unknown) => {
      prompts.push((m as Array<{ content: string }>)[0]!.content);
      return reply({ chapters: [], arc_summary: '', open_threads: [] });
    });
    await ensureMoviePlan(out, { chapters: ['ch1'], events: () => ['she shouts {ahead}\nch9:'] });
    expect(prompts[0]).toContain('- she shouts {ahead} ch9:');
    expect(prompts[0]).not.toMatch(/\{arc_so_far\}|\{min_s\}/);
  });
});
