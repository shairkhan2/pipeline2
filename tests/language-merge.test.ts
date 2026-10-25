/**
 * Language-version export: merge finished Hindi chapters (numeric order, gaps
 * and stale chapters listed), a Hindi outro appended at the end, the export
 * lock against language jobs, download headers and traversal refusal. Real
 * ffmpeg on tiny clips; the writer lane and TTS are stubbed (no provider spend).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

import * as languages from '../src/player/languages.js';
import * as localize from '../src/stages/localize.js';
import * as exportsMod from '../src/player/languageExport.js';
import { generateLocaleOutro, localeExportState, mergeLocaleChapters } from '../src/player/languageExport.js';
import { getSeriesMergeState, mergeSeriesChapters } from '../src/player/seriesTools.js';
import { canonicalVideoPath, writeJob } from '../src/localization/store.js';

const slug = 'lang-merge-fixture';
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const LOCALE = 'hi-IN';
const VOICE = 'hi-IN-SwaraNeural';
const CHAPTERS = ['ch1', 'ch2', 'ch3', 'ch10'];

let root: string;
let sdir: string;
let server: http.Server;
let base: string;
let cookie: string;
let csrf: string;
const llmCalls: string[] = [];
let ttsCalls = 0;
let ttsFailuresLeft = 0;

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

/** Chapter clips share one encoder setup, as the real renderer's do. */
function makeClip(dest: string, color: string, seconds: number): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:r=10:d=${seconds}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(seconds), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', dest,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function makeMp3(dest: string, seconds = 0.8): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, dest],
    { encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function probeDuration(file: string): number {
  const res = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(res.stdout.trim());
}

function videoTrackDuration(file: string): number {
  const res = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  return Number(res.stdout.trim());
}

/** Center pixel colour at `at` seconds. */
function pixel(file: string, at: number): [number, number, number] {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const buf = res.stdout as Buffer;
  const off = (60 * 160 + 80) * 3;
  return [buf[off] ?? 0, buf[off + 1] ?? 0, buf[off + 2] ?? 0];
}

const COLORS: Record<string, string> = { ch1: 'red', ch2: 'blue', ch3: 'yellow', ch10: 'green' };
const SECONDS: Record<string, number> = { ch1: 0.6, ch2: 0.8, ch3: 0.5, ch10: 1.0 };

async function buildSeries(): Promise<void> {
  const out = path.join(sdir, 'out');
  json(path.join(sdir, 'meta.json'), { title: 'Merge Fixture', tts: { engine: 'edge' } });
  json(path.join(out, 'bible.json'), { characters: { hero: { name: 'Jin', role: 'protagonist' } } });
  for (const ch of CHAPTERS) {
    const n = Number(ch.slice(2));
    const ids = [`p${String(n).padStart(4, '0')}_1`, `p${String(n).padStart(4, '0')}_2`];
    json(path.join(out, `obs_${ch}.json`), {
      data: {
        panels: ids.map((id) => ({ id, visual: `Jin stands at the gate ${n}.`, characters: ['Jin'], overlay: [], world: [], art: 0.9, framing: 'closeup' })),
        characters: [{ name: 'Jin' }], gags: [], events: [],
      },
    });
    for (const id of ids) {
      const file = path.join(out, 'panels', ch, `${id}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 200, g: 40 * n % 255, b: 90 } } }).jpeg().toFile(file);
    }
    write(path.join(out, ch, 'script.md'), `## BEAT b01_gate\nJin reaches the gate. @${ids[0]}\n`);
    json(path.join(out, ch, 'report.json'), { series: slug, ch, status: 'ok', lines: 1, issues: [], window_holes: [] });
    // English chapter video, so the English merge has something to join.
    makeClip(path.join(out, ch, 'video', 'video.mp4'), 'white', 0.4);
  }
}

/** Deterministic writer lane: keep placeholders and digits, write Devanagari. */
function fakeLlm() {
  return vi.fn(async (messages: unknown, options: { tag?: string }) => {
    const tag = String(options?.tag ?? '');
    llmCalls.push(tag);
    if (tag.includes('review')) {
      return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', issues: [] }) } }] };
    }
    const raw = (messages as Array<{ content: string }>)[0]!.content;
    const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
    if (!block) throw new Error('translate prompt missing units');
    const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            units: units.map((u) => {
              // Separate kept digits with a word: "4 4" would read as the compound 8.
              const keep = [...u.text.matchAll(/⟦[ETH]\d*⟧|\d+/g)].map((m) => m[0]).join(' फिर ');
              return { id: u.id, text: `जिन गेट तक पहुँचता है ${keep}`.trim() };
            }),
            glossary: { names: {}, terms: {} },
          }),
        },
      }],
    };
  });
}

function fakeRenderer() {
  return vi.fn(async (_s: string, ch: string, out: string, opts: { locale: string }) => {
    const video = canonicalVideoPath(path.dirname(out), opts.locale, ch);
    makeClip(video, COLORS[ch] ?? 'gray', SECONDS[ch] ?? 0.5);
    return [video, SECONDS[ch] ?? 0.5] as [string, number];
  });
}

async function renderHindi(chapters: string[]): Promise<void> {
  const planned = await localize.planLocalizeJob(sdir, { locale: LOCALE, chapters: chapters.map((c) => c.slice(2)).join(','), voice: VOICE, speed: 1 });
  await localize.runLocalizeJob(sdir, planned.job.id, { skipPipelineConflictCheck: true, log: () => {} });
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extra };
}

async function api(route: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method,
    // Synchronous media probes between requests can outlast the server's idle
    // timeout before fetch processes the socket close. Use a fresh connection.
    headers: authHeaders({ connection: 'close' }),
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
  });
}

/** Hold every background export at its start until `release()` (no real waiting). */
function holdExports(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  exportsMod._setExportRunHookForTests(async () => { entered(); await gate; });
  return {
    entered: inside,
    release: () => {
      exportsMod._setExportRunHookForTests(null);
      release();
    },
  };
}

async function exportsSettled(): Promise<void> {
  await exportsMod._settleExportsForTests();
}

/** The UI's loop: the POST answered 202, poll the export GET until nothing is busy. */
async function pollUntilIdle(): Promise<Record<string, any>> {
  await exportsSettled();
  const res = await api(exportRoute);
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, any>;
  expect(body.busy.merge || body.busy.outro).toBe(false);
  return body;
}

const exportRoute = `/api/series/${slug}/languages/${LOCALE}/export`;
const mergeRoute = `/api/series/${slug}/languages/${LOCALE}/merge`;
const outroRoute = `/api/series/${slug}/languages/${LOCALE}/outro`;

beforeAll(async () => {
  if (!ffmpegAvailable) return;
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-merge-');
  const seriesRoot = path.join(root, 'series');
  sdir = path.join(seriesRoot, slug);
  fs.mkdirSync(sdir, { recursive: true });
  await buildSeries();

  vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
  vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
  vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
  vi.stubEnv('PLAYER_API_ONLY', '1');
  vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  vi.stubEnv('MANHWA_TRASH_DIR', path.join(root, 'trash'));
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
  vi.stubEnv('MANHWA_AUTO_RETRY', '0');

  const mod = await import('../src/player/server.js');
  write(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
  server = mod.createPlayerServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = `sr_session=${encodeURIComponent(mod.makeCookie('admin'))}`;
  csrf = ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string }).csrfToken;

  languages._setJobSpawnerForTests(() => {});
  localize._setLlmCallForTests(fakeLlm() as never);
  localize._setRendererForTests(fakeRenderer() as never);
  localize._setSleepForTests(async () => {});
  localize._setPreviewSynthForTests(async (_text, dest) => {
    ttsCalls += 1;
    if (ttsFailuresLeft > 0) {
      ttsFailuresLeft -= 1;
      throw new Error('503 service temporarily unavailable');
    }
    makeMp3(dest);
  });
}, 120_000);

afterAll(async () => {
  languages._setJobSpawnerForTests(null);
  localize._setLlmCallForTests(null);
  localize._setRendererForTests(null);
  localize._setPreviewSynthForTests(null);
  localize._setSleepForTests(null);
  localize._clearSourceCheckCache();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!ffmpegAvailable)('language merge', () => {
  it('refuses to merge before any Hindi chapter is finished', async () => {
    const res = await api(mergeRoute, 'POST', {});
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('nothing_to_merge');
    const state = await (await api(exportRoute)).json() as Record<string, any>;
    expect(state.canMerge).toBe(false);
    expect(state.reason).toMatch(/No finished Hindi chapters/);
    expect(state.chapters.missing.map((m: any) => m.chapter)).toEqual(CHAPTERS);
  });

  it('merges ch1, ch2, ch10 in numeric order and lists the ch3 gap', async () => {
    await renderHindi(['ch10', 'ch2', 'ch1']);
    const state = localeExportState(sdir, slug, LOCALE);
    expect(state.chapters.finished).toEqual(['ch1', 'ch2', 'ch10']);
    expect(state.chapters.missing).toEqual([{ chapter: 'ch3', reason: 'No Hindi video yet.' }]);
    expect(state.canMerge).toBe(true);
    expect(state.nextMerge.filename).toBe(`${slug}-hindi-ch1-2_10.mp4`);

    const res = await api(mergeRoute, 'POST', {});
    expect(res.status).toBe(202);
    const accepted = await res.json() as Record<string, any>;
    expect(accepted.busy.merge).toBe(true);
    expect(accepted.lastMerge.status).toBe('running');
    const body = await pollUntilIdle();
    expect(body.lastMerge).toMatchObject({ status: 'done', code: null, message: 'Merged 3 chapters.' });
    expect(body.merged.exists).toBe(true);
    expect(body.merged.chapters).toEqual(['ch1', 'ch2', 'ch10']);
    expect(body.merged.includesOutro).toBe(false);
    expect(body.merged.stale).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'merge.json'), 'utf8'));
    expect(manifest.copied).toBe(true);

    const full = path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4');
    expect(probeDuration(full)).toBeGreaterThan(2.3);
    // Red (ch1), then blue (ch2), then green (ch10).
    expect(pixel(full, 0.2)[0]).toBeGreaterThan(150);
    expect(pixel(full, 0.9)[2]).toBeGreaterThan(150);
    expect(pixel(full, 2.0)[1]).toBeGreaterThan(90);
    expect(fs.readdirSync(path.dirname(full)).filter((n) => n.startsWith('.merge-'))).toEqual([]);
  });

  it('marks the merge stale when a new chapter finishes, and Merge again picks it up', async () => {
    await renderHindi(['ch3']);
    const stale = localeExportState(sdir, slug, LOCALE);
    expect(stale.merged.stale).toBe(true);
    expect(stale.merged.staleReason).toMatch(/Merge again/);
    expect(stale.chapters.missing).toEqual([]);
    const merged = await mergeLocaleChapters(sdir, slug, LOCALE);
    expect(merged.merged.chapters).toEqual(['ch1', 'ch2', 'ch3', 'ch10']);
    expect(merged.merged.stale).toBe(false);
  });

  it('keeps a stale chapter in the merge (like English) and lists it', async () => {
    const script = path.join(sdir, 'out', 'ch2', 'script.md');
    const original = fs.readFileSync(script, 'utf8');
    fs.writeFileSync(script, original.replace('reaches', 'finally reaches'));
    localize._clearSourceCheckCache();
    try {
      const state = localeExportState(sdir, slug, LOCALE);
      expect(state.chapters.stale.map((c) => c.chapter)).toEqual(['ch2']);
      expect(state.chapters.stale[0]!.reason).toMatch(/re-render/);
      expect(state.chapters.finished).toEqual(['ch1', 'ch2', 'ch3', 'ch10']);
      expect(state.canMerge).toBe(true);
      // The video itself did not change, so the merged file is still current.
      expect(state.merged.stale).toBe(false);
    } finally {
      fs.writeFileSync(script, original);
      localize._clearSourceCheckCache();
    }
    expect(localeExportState(sdir, slug, LOCALE).chapters.stale).toEqual([]);
  });

  it('refuses with 409 while a language job is active', async () => {
    const id = `loc-${Date.now()}-abcdef12`;
    writeJob(sdir, {
      schemaVersion: 1, id, slug, locale: LOCALE, chapters: ['ch1'], voice: VOICE, speed: 1,
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: {},
    });
    try {
      const state = await (await api(exportRoute)).json() as Record<string, any>;
      expect(state.busy.job).toBe(true);
      expect(state.canMerge).toBe(false);
      const merge = await api(mergeRoute, 'POST', {});
      expect(merge.status).toBe(409);
      expect((await merge.json() as any).code).toBe('job_active');
      const outro = await api(outroRoute, 'POST', {});
      expect(outro.status).toBe(409);
    } finally {
      writeJob(sdir, {
        schemaVersion: 1, id, slug, locale: LOCALE, chapters: ['ch1'], voice: VOICE, speed: 1,
        status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: {},
      });
    }
  });

  it('holds the lock for a background merge: no job start, no second merge from another tab', async () => {
    const gate = holdExports();
    const first = await api(mergeRoute, 'POST', {});
    expect(first.status).toBe(202);
    await first.arrayBuffer();
    try {
      expect(localeExportState(sdir, slug, LOCALE).busy.merge).toBe(true);
      await expect(localize.planLocalizeJob(sdir, { locale: LOCALE, chapters: '1', voice: VOICE, speed: 1 }))
        .rejects.toMatchObject({ statusCode: 409, code: 'export_busy' });
      const job = await api(`/api/series/${slug}/languages`, 'POST', { locale: LOCALE, chapters: '1', voice: VOICE });
      expect(job.status).toBe(409);
      expect((await job.json() as any).code).toBe('export_busy');
      const second = await api(mergeRoute, 'POST', {});
      expect(second.status).toBe(409);
      expect((await second.json() as any).code).toBe('export_busy');
      const outro = await api(outroRoute, 'POST', {});
      expect(outro.status).toBe(409);
      await outro.arrayBuffer();
      // The first run is still the one on record.
      expect(localeExportState(sdir, slug, LOCALE).lastMerge?.status).toBe('running');
    } finally {
      gate.release();
      await exportsSettled();
    }
    const after = localeExportState(sdir, slug, LOCALE);
    expect(after.busy.merge).toBe(false);
    expect(after.lastMerge?.status).toBe('done');
  });

  it('keeps merging after the client disconnects', async () => {
    const gate = holdExports();
    const before = fs.statSync(path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4')).mtimeMs;
    const controller = new AbortController();
    const pending = fetch(`${base}${mergeRoute}`, {
      method: 'POST', headers: authHeaders(), body: '{}', signal: controller.signal,
    }).catch(() => null);
    await gate.entered;
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(localeExportState(sdir, slug, LOCALE).busy.merge).toBe(true);
    gate.release();
    await exportsSettled();
    const after = localeExportState(sdir, slug, LOCALE);
    expect(after.lastMerge?.status).toBe('done');
    expect(fs.statSync(path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4')).mtimeMs).toBeGreaterThan(before);
  });

  it('a run killed mid-merge reads as interrupted, leaves no busy flag, temp files or damage', async () => {
    const full = path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video');
    const before = fs.statSync(path.join(full, 'video.mp4')).mtimeMs;
    const statusFile = path.join(sdir, 'out', 'languages', LOCALE, 'export-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // What a server killed mid-merge leaves: a "running" record, a temp dir and an
    // export lock file nobody holds (the kernel dropped the flock with the process).
    fs.writeFileSync(statusFile, JSON.stringify({
      ...status,
      lastMerge: { status: 'running', code: null, message: 'Merging now.', detail: null,
        startedAt: new Date().toISOString(), finishedAt: null, pid: 999999 },
    }));
    fs.mkdirSync(path.join(full, '.merge-dead'), { recursive: true });
    fs.writeFileSync(path.join(full, '.merge-dead', 'video.mp4'), 'partial');

    const state = await (await api(exportRoute)).json() as Record<string, any>;
    expect(state.busy.merge).toBe(false);
    expect(state.canMerge).toBe(true);
    expect(state.lastMerge.status).toBe('interrupted');
    expect(state.lastMerge.code).toBe('interrupted');
    expect(state.lastMerge.message).toMatch(/server restarted/);
    expect(state.lastMerge.pid).toBeUndefined();
    expect(fs.existsSync(path.join(full, '.merge-dead'))).toBe(false);
    expect(fs.statSync(path.join(full, 'video.mp4')).mtimeMs).toBe(before);
    expect(state.merged.exists).toBe(true);
    // And a new merge is accepted straight away.
    const again = await api(mergeRoute, 'POST', {});
    expect(again.status).toBe(202);
    await again.arrayBuffer();
    await exportsSettled();
    expect(localeExportState(sdir, slug, LOCALE).lastMerge?.status).toBe('done');
  });

  it('a failed background merge is recorded with code, message and detail', async () => {
    const chapter = canonicalVideoPath(sdir, LOCALE, 'ch1');
    const original = fs.readFileSync(chapter);
    const gate = holdExports();
    const res = await api(mergeRoute, 'POST', {});
    expect(res.status).toBe(202);
    await res.arrayBuffer();
    // Corrupt a source after the up-front checks passed: only the background run sees it.
    fs.writeFileSync(chapter, Buffer.from('not an mp4 at all'));
    gate.release();
    const body = await pollUntilIdle();
    fs.writeFileSync(chapter, original);
    expect(body.lastMerge.status).toBe('failed');
    expect(body.lastMerge.code).toBe('merge_failed');
    expect(body.lastMerge.message).toBe('The chapter videos could not be joined.');
    expect(body.lastMerge.detail).toMatch(/not a readable MP4/);
    expect(body.lastMerge.detail).not.toContain(root);
    expect(body.merged.exists).toBe(true);
  });
});

describe.skipIf(!ffmpegAvailable)('language outro', () => {
  it('builds a Hindi outro without an English plan, retrying one transient TTS failure', async () => {
    expect(fs.existsSync(path.join(sdir, 'out', 'outro'))).toBe(false);
    llmCalls.length = 0;
    ttsCalls = 0;
    ttsFailuresLeft = 1;
    const res = await api(outroRoute, 'POST', {});
    const accepted = await res.json() as Record<string, any>;
    expect(res.status, JSON.stringify(accepted)).toBe(202);
    expect(accepted.busy.outro).toBe(true);
    expect(accepted.canMerge).toBe(false);
    const body = await pollUntilIdle();
    expect(body.lastOutro, JSON.stringify(body.lastOutro)).toMatchObject({ status: 'done', code: null });
    expect(body.outro.source).toBe('generated');
    expect(ttsCalls).toBe(2);
    expect(llmCalls.filter((t) => t.includes('review'))).toHaveLength(1);
    expect(body.outro.exists).toBe(true);
    expect(body.outro.voice).toBe(VOICE);
    expect(body.outro.script).toMatch(/[\u0900-\u097F]/);
    // Nothing is written under the English outro directory.
    expect(fs.existsSync(path.join(sdir, 'out', 'outro'))).toBe(false);
    // The merged video now lacks the outro: it is stale and the next merge includes it.
    expect(body.merged.stale).toBe(true);
    expect(body.nextMerge.includesOutro).toBe(true);
  });

  it('fails clearly on a persistent TTS error, keeps the old outro, and reuses the translation', async () => {
    const video = path.join(sdir, 'out', 'languages', LOCALE, 'outro', 'video', 'video.mp4');
    const before = fs.statSync(video).mtimeMs;
    llmCalls.length = 0;
    ttsFailuresLeft = 5;
    // A new speed changes the narration, so TTS runs (and fails); the translation is still cached.
    const res = await api(outroRoute, 'POST', { speed: 1.2 });
    expect(res.status).toBe(202);
    await res.arrayBuffer();
    const body = await pollUntilIdle();
    ttsFailuresLeft = 0;
    expect(body.lastOutro.status).toBe('failed');
    expect(body.lastOutro.code).toBe('outro_tts_failed');
    expect(body.lastOutro.message).toMatch(/previous outro is unchanged/);
    expect(body.lastOutro.detail).toMatch(/503/);
    expect(body.lastOutro.finishedAt).toBeTruthy();
    expect(body.outro.exists).toBe(true);
    expect(llmCalls).toEqual([]);
    expect(fs.statSync(video).mtimeMs).toBe(before);
    // Persisted: a fresh read of the status file says the same thing.
    const file = JSON.parse(fs.readFileSync(path.join(sdir, 'out', 'languages', LOCALE, 'export-status.json'), 'utf8'));
    expect(file.lastOutro).toMatchObject({ status: 'failed', code: 'outro_tts_failed' });
    // The merge outcome is kept beside it, untouched by the outro run.
    expect(file.lastMerge.code).toBe('merge_failed');
  });

  it('does not pay TTS or the writer lane again when nothing changed', async () => {
    llmCalls.length = 0;
    ttsCalls = 0;
    const res = await api(outroRoute, 'POST', {});
    expect(res.status).toBe(202);
    await res.arrayBuffer();
    const body = await pollUntilIdle();
    expect(body.lastOutro).toMatchObject({ status: 'done' });
    expect(ttsCalls).toBe(0);
    expect(llmCalls).toEqual([]);
  });

  it('refuses a merge up front when the disk cannot hold the output', async () => {
    const spy = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1, bsize: 1 } as never);
    try {
      const res = await api(mergeRoute, 'POST', {});
      const body = await res.json() as Record<string, any>;
      expect(res.status).toBe(507);
      expect(body.code).toBe('insufficient_space');
      expect(body.error).toMatch(/Not enough disk space/);
    } finally {
      spy.mockRestore();
    }
    const state = localeExportState(sdir, slug, LOCALE);
    expect(state.busy.merge).toBe(false);
    expect(state.canMerge).toBe(true);
  });

  it('appends the outro once, at the end, and the stream-copy path still holds', async () => {
    const merged = await mergeLocaleChapters(sdir, slug, LOCALE);
    expect(merged.merged.includesOutro).toBe(true);
    expect(merged.merged.stale).toBe(false);
    // The outro is encoded like the chapters, so a large batch never re-encodes.
    expect(merged.result.copied).toBe(true);
    const full = path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4');
    const chapters = SECONDS.ch1 + SECONDS.ch2 + SECONDS.ch3 + SECONDS.ch10;
    const outro = merged.outro.duration!;
    expect(outro).toBeGreaterThan(0.5);
    expect(Math.abs(probeDuration(full) - (chapters + outro))).toBeLessThan(0.4);
    // The picture lasts as long as the narration: a single held panel must not end after one frame.
    const outroFile = path.join(sdir, 'out', 'languages', LOCALE, 'outro', 'video', 'video.mp4');
    expect(Math.abs(videoTrackDuration(outroFile) - outro)).toBeLessThan(0.2);
    expect(Math.abs(videoTrackDuration(full) - (chapters + outro))).toBeLessThan(0.4);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(full), 'merge.json'), 'utf8'));
    expect(manifest.sources.at(-1).file).toBe(`out/languages/${LOCALE}/outro/video/video.mp4`);
    expect(manifest.sources.filter((s: any) => s.file.includes('/outro/'))).toHaveLength(1);

    const chaptersOnly = await mergeLocaleChapters(sdir, slug, LOCALE, { includeOutro: false });
    expect(chaptersOnly.merged.includesOutro).toBe(false);
  });

  it('reuses the English outro plan when one exists and flags staleness when it changes', async () => {
    const englishPlan = path.join(sdir, 'out', 'outro', 'outro-plan.json');
    const panel = 'out/panels/ch1/p0001_1.jpg';
    json(englishPlan, {
      schemaVersion: 1, slug, script: "We've covered the first 4 chapters in Merge Fixture. Drop a comment for Part 2!",
      hookType: 'part2', totalChapters: 10, coveredChapters: 4,
      selectedPanels: [{ chapter: 'ch1', panelFile: panel, panel, characterNames: ['Jin'], characters: ['Jin'], reason: 'x', previewUrl: '', url: '' }],
    });
    try {
      const out = await generateLocaleOutro(sdir, slug, LOCALE, { speed: 1.2 });
      expect(out.result.source).toBe('english-plan');
      expect(out.outro.speed).toBe(1.2);
      expect(out.outro.stale).toBe(false);
      const plan = JSON.parse(fs.readFileSync(englishPlan, 'utf8'));
      json(englishPlan, { ...plan, script: `${plan.script} Subscribe!` });
      const state = localeExportState(sdir, slug, LOCALE);
      expect(state.outro.stale).toBe(true);
      expect(state.outro.staleReason).toMatch(/English outro changed/);
    } finally {
      fs.rmSync(path.join(sdir, 'out', 'outro'), { recursive: true, force: true });
    }
  });

  it('validates voice and speed exactly like the job POST', async () => {
    const badVoice = await api(outroRoute, 'POST', { voice: 'en-US-Nope' });
    expect(badVoice.status).toBe(400);
    expect((await badVoice.json() as any).code).toBe('unsupported_voice');
    const badSpeed = await api(outroRoute, 'POST', { speed: 9 });
    expect(badSpeed.status).toBe(400);
    expect((await badSpeed.json() as any).code).toBe('invalid_speed');
    const extra = await api(outroRoute, 'POST', { env: { X: '1' } });
    expect(extra.status).toBe(400);
  });
});

describe.skipIf(!ffmpegAvailable)('language downloads', () => {
  it('serves the merged video with a friendly attachment name, ranges and HEAD', async () => {
    await mergeLocaleChapters(sdir, slug, LOCALE);
    const state = localeExportState(sdir, slug, LOCALE);
    const dl = await fetch(`${base}${state.merged.downloadUrl}`, { headers: { cookie } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('video/mp4');
    expect(dl.headers.get('content-disposition')).toBe(`attachment; filename="${slug}-hindi-ch1-3_10.mp4"`);
    expect((await dl.arrayBuffer()).byteLength).toBe(state.merged.sizeBytes);

    const ranged = await fetch(`${base}${state.merged.url}`, { headers: { cookie, range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-disposition')).toBeNull();
    await ranged.arrayBuffer();

    const head = await fetch(`${base}${state.merged.url}`, { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);

    const outro = await fetch(`${base}${state.outro.downloadUrl}`, { headers: { cookie } });
    expect(outro.status).toBe(200);
    expect(outro.headers.get('content-disposition')).toBe(`attachment; filename="${slug}-hindi-outro.mp4"`);
    await outro.arrayBuffer();
  });

  it('requires a login for media and the export API', async () => {
    // Media outside /api/ redirects an anonymous request to the login page.
    const anon = await fetch(`${base}/media/${slug}/languages/${LOCALE}/full.mp4`, { redirect: 'manual' });
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toMatch(/\/(login|setup)$/);
    expect((await fetch(`${base}${exportRoute}`)).status).toBe(401);
    const noCsrf = await fetch(`${base}${mergeRoute}`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    });
    expect(noCsrf.status).toBe(403);
  });

  it('refuses traversal, unknown locales and symlinked outputs', async () => {
    for (const route of [
      `/media/${slug}/languages/..%2F..%2Fout/full.mp4`,
      `/media/${slug}/languages/en-US/full.mp4`,
      `/media/..%2F${slug}/languages/${LOCALE}/full.mp4`,
      `/api/series/${slug}/languages/..%2Fjobs/export`,
    ]) {
      const res = await fetch(`${base}${route}`, { headers: { cookie } });
      expect([400, 403, 404]).toContain(res.status);
      await res.arrayBuffer();
    }
    const fullDir = path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video');
    const real = path.join(fullDir, 'video.mp4');
    const moved = path.join(root, 'moved.mp4');
    fs.renameSync(real, moved);
    fs.symlinkSync(moved, real);
    try {
      const res = await fetch(`${base}/media/${slug}/languages/${LOCALE}/full.mp4`, { headers: { cookie } });
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    } finally {
      fs.unlinkSync(real);
      fs.renameSync(moved, real);
    }
  });
});

describe.skipIf(!ffmpegAvailable)('English merge is unchanged', () => {
  it('still merges English chapters into out/full without touching language files', async () => {
    const before = fs.statSync(path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4')).mtimeMs;
    const result = await mergeSeriesChapters({ seriesRoot: path.dirname(sdir), slug });
    expect(result.chapters).toEqual(['ch1', 'ch2', 'ch3', 'ch10']);
    expect(result.includesOutro).toBe(false);
    expect(result.downloadUrl).toBe(`/media/${slug}/full.mp4`);
    expect(Math.abs(result.duration - 1.6)).toBeLessThan(0.3);
    expect(getSeriesMergeState({ seriesRoot: path.dirname(sdir), slug }).stale).toBe(false);
    expect(fs.statSync(path.join(sdir, 'out', 'languages', LOCALE, 'full', 'video', 'video.mp4')).mtimeMs).toBe(before);
  });
});
