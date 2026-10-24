import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getMoviePlanView } from '../src/player/moviePlanView.js';

fs.mkdirSync('/tmp/opencode', { recursive: true });

const plan = {
  version: 1,
  chapters: {
    ch2: { ch: 'ch2', role: 'climax', budget_s: 150, entry: 'Back home', focus: 'Fight', exit: 'finale', threads_open: [], threads_paid: ['sword'], secret: 'drop me' },
    ch1: { ch: 'ch1', role: 'opening', budget_s: 110, entry: 'movie opening', focus: 'Grief', exit: 'flow', threads_open: ['sword', 7], threads_paid: [] },
    bogus: { role: 'opening' },
  },
  arc: { ch1: 'early', ch2: 'latest summary' },
  open_threads: ['sword'],
  extra: { leak: true },
};

function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

describe('movie plan view', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync('/tmp/opencode/movie-plan-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports exists:false when the plan is missing or corrupt', () => {
    expect(getMoviePlanView(dir)).toEqual({ exists: false, chapters: [], arc_summary: '', open_threads: [] });
    write(path.join(dir, 'out', 'movie_plan.json'), '{not json');
    expect(getMoviePlanView(dir).exists).toBe(false);
    write(path.join(dir, 'out', 'movie_plan.json'), { version: 1, chapters: [] });
    expect(getMoviePlanView(dir).exists).toBe(false);
  });

  it('sanitizes the plan and joins render state, duration and style', () => {
    const out = path.join(dir, 'out');
    write(path.join(out, 'movie_plan.json'), plan);
    write(path.join(out, 'ch1', 'video', 'video.mp4'), 'x');
    write(path.join(out, 'ch1', 'video', 'shots.json'), { shots: [{ end_s: 10 }, { end_s: 129.94 }] });
    write(path.join(out, 'ch1', 'report.json'), { style: { metrics: [{ key: 'a', ok: true }, { key: 'then-chains', ok: false }, { key: 'b', ok: true }] } });
    write(path.join(out, 'ch2', 'video', 'tts_durs.json'), [1.25, 2.5]);
    write(path.join(out, 'ch2', 'report.json'), 'corrupt');

    const view = getMoviePlanView(dir);
    expect(view.exists).toBe(true);
    expect(view.arc_summary).toBe('latest summary');
    expect(view.open_threads).toEqual(['sword']);
    expect(view.chapters.map((c) => c.ch)).toEqual(['ch1', 'ch2']);
    expect(view.chapters[0]).toMatchObject({ role: 'opening', budget_s: 110, rendered: true, durationS: 129.9, threads_open: ['sword'], style: { onTarget: 2, total: 3, misses: ['then-chains'] } });
    expect(view.chapters[1]).toMatchObject({ role: 'climax', exit: 'finale', rendered: false, durationS: 3.8 });
    expect(view.chapters[1]!.style).toBeUndefined();
    expect(view.plan!.chapters.ch2).not.toHaveProperty('secret');
    expect(view.plan).not.toHaveProperty('extra');
    expect(view.plan!.chapters).not.toHaveProperty('bogus');
  });

  it('coerces unknown role/exit values', () => {
    write(path.join(dir, 'out', 'movie_plan.json'), { chapters: { ch1: { role: 'weird', exit: 'nope', budget_s: 'x' } } });
    expect(getMoviePlanView(dir).chapters[0]).toMatchObject({ role: 'filler', exit: 'flow', budget_s: 0, rendered: false });
  });

  it('does not follow symlinks out of the series directory', () => {
    const outside = fs.mkdtempSync('/tmp/opencode/movie-plan-outside-');
    try {
      write(path.join(outside, 'movie_plan.json'), plan);
      fs.mkdirSync(path.join(dir, 'out'));
      fs.symlinkSync(path.join(outside, 'movie_plan.json'), path.join(dir, 'out', 'movie_plan.json'));
      expect(getMoviePlanView(dir).exists).toBe(false);
      fs.rmSync(path.join(dir, 'out'), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, 'out'));
      expect(getMoviePlanView(dir).exists).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('movie plan HTTP route', () => {
  let root: string;
  let server: http.Server;
  let base: string;
  let cookie: string;
  beforeAll(async () => {
    root = fs.mkdtempSync('/tmp/opencode/movie-plan-http-');
    vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
    vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
    vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
    vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series'));
    vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
    vi.stubEnv('PLAYER_API_ONLY', '1');
    write(path.join(root, 'series', 'movie-series', 'out', 'movie_plan.json'), plan);
    fs.mkdirSync(path.join(root, 'series', 'plain-series'), { recursive: true });
    const mod = await import('../src/player/server.js');
    fs.writeFileSync(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
    server = mod.createPlayerServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'test-password' }), redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires a session and is read-only', async () => {
    expect((await fetch(`${base}/api/series/movie-series/movie-plan`)).status).toBe(401);
    const post = await fetch(`${base}/api/series/movie-series/movie-plan`, { method: 'POST', headers: { cookie, Origin: base } });
    expect([403, 405]).toContain(post.status);
  });

  it('returns the plan view, exists:false without a plan, and validates the slug', async () => {
    const res = await fetch(`${base}/api/series/movie-series/movie-plan`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean; chapters: Array<{ ch: string }>; arc_summary: string };
    expect(body.exists).toBe(true);
    expect(body.chapters.map((c) => c.ch)).toEqual(['ch1', 'ch2']);
    expect(body.arc_summary).toBe('latest summary');
    const none = await fetch(`${base}/api/series/plain-series/movie-plan`, { headers: { cookie } });
    expect(await none.json()).toMatchObject({ exists: false });
    expect((await fetch(`${base}/api/series/bad%20slug/movie-plan`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/api/series/missing-series/movie-plan`, { headers: { cookie } })).status).toBe(404);
  });
});
