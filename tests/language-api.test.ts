/**
 * Language-version HTTP contract: exact response shape, auth/CSRF/temporary
 * account rules, chapter/locale/voice validation, safe media streaming, path
 * traversal refusal and last-known-good video behaviour across real job
 * transitions (no mocks hiding them).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import * as languages from '../src/player/languages.js';
import * as localize from '../src/stages/localize.js';
import { canonicalVideoPath, jobPath, readJob, sha256File, writeJob } from '../src/localization/store.js';

const slug = 'lang-api-fixture';
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let root: string;
let sdir: string;
let server: http.Server;
let base: string;
let cookie: string;
let csrf: string;
const spawned: Array<{ sdir: string; jobId: string }> = [];

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

function makeMp4(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
      '-t', '0.6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', dest,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function makeMp3(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', dest],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function buildSeries(): void {
  const out = path.join(sdir, 'out');
  json(path.join(sdir, 'meta.json'), { title: 'Language API Fixture', tts: { engine: 'edge' } });
  json(path.join(out, 'bible.json'), { characters: {} });
  json(path.join(out, 'obs_ch1.json'), {
    data: {
      panels: [
        { id: 'p0001_1', visual: 'Night artwork.', overlay: [], world: [], art: 0.9 },
        {
          id: 'p0009_1',
          visual: 'Vocabulary artwork.',
          overlay: ['gate night'],
          world: [],
          art: 0.9,
        },
      ],
      characters: [],
      gags: [],
      events: [],
    },
  });
  for (const id of ['p0001_1', 'p0009_1']) {
    write(path.join(out, 'panels', 'ch1', `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  write(path.join(out, 'ch1', 'script.md'), '## BEAT b01_gate\nA gate at night. @p0001_1\n');
  json(path.join(out, 'ch1', 'report.json'), {
    series: slug, ch: 'ch1', status: 'ok', lines: 1, issues: [], window_holes: [],
  });
  // ch2 exists but has no script: the source list must say why.
  fs.mkdirSync(path.join(out, 'ch2'), { recursive: true });
}

/** Deterministic fake writer lane for the API fixture (no paid provider). */
function fakeLlm(): ReturnType<typeof vi.fn> {
  return vi.fn(async (messages: unknown, options: { tag?: string }) => {
    const tag = String(options?.tag ?? '');
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
            units: units.map((u) => ({
              id: u.id,
              text: u.text.replace('A gate at night.', 'रात में एक दरवाज़ा।'),
            })),
            glossary: { names: {}, terms: {} },
          }),
        },
      }],
    };
  });
}

function fakeRenderer(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_s: string, ch: string, out: string, opts: { locale: string }) => {
    const video = canonicalVideoPath(path.dirname(out), opts.locale, ch);
    makeMp4(video);
    return [video, 0.6] as [string, number];
  });
}

/** Run a job synchronously in-process (the HTTP route only spawns it). */
async function runJob(jobId: string): Promise<void> {
  await localize.runLocalizeJob(sdir, jobId, { skipPipelineConflictCheck: true, log: () => {} });
}

beforeAll(async () => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-api-');
  const seriesRoot = path.join(root, 'series');
  sdir = path.join(seriesRoot, slug);
  fs.mkdirSync(sdir, { recursive: true });
  buildSeries();

  vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
  vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
  vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
  vi.stubEnv('PLAYER_API_ONLY', '1');
  vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');

  const mod = await import('../src/player/server.js');
  write(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
  server = mod.createPlayerServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ user: 'admin', pass: 'test-password' }),
    redirect: 'manual',
  });
  expect(login.status).toBe(303);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string })
    .csrfToken;

  languages._setJobSpawnerForTests((dir, jobId) => {
    spawned.push({ sdir: dir, jobId });
  });
  localize._setLlmCallForTests(fakeLlm() as never);
  localize._setRendererForTests(fakeRenderer() as never);
  localize._setSleepForTests(async () => {});
  localize._setPreviewSynthForTests(async (_text, dest) => {
    makeMp3(dest);
  });
});

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
  fs.rmSync(root, { recursive: true, force: true });
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, origin: base, 'content-type': 'application/json', ...extra };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/series/${slug}/languages`, {
    method: 'POST',
    headers: authHeaders({ 'x-csrf-token': csrf, ...headers }),
    body: JSON.stringify(body),
  });
}

async function state(): Promise<Record<string, any>> {
  const res = await fetch(`${base}/api/series/${slug}/languages`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function releaseActiveJobs(status: 'failed' | 'interrupted' = 'failed'): void {
  const jobsDir = path.join(sdir, 'out', 'languages', 'jobs');
  if (!fs.existsSync(jobsDir)) return;
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(jobsDir, name);
    const rec = readJob(sdir, name.slice(0, -5));
    if (!rec || (rec.status !== 'queued' && rec.status !== 'running')) continue;
    writeJob(sdir, {
      ...rec,
      status,
      pid: null,
      pidStart: null,
      updatedAt: new Date().toISOString(),
    });
  }
}

describe('GET /api/series/:slug/languages', () => {
  it('returns the exact state shape', async () => {
    const body = await state();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe(slug);
    expect(body.catalog).toEqual([
      {
        locale: 'hi-IN',
        label: 'Hindi',
        nativeLabel: 'हिन्दी',
        voices: [
          { id: 'hi-IN-MadhurNeural', label: 'Madhur', engine: 'edge', provider: 'edge', modelId: 'edge', modelLabel: 'Edge', available: true },
          { id: 'hi-IN-SwaraNeural', label: 'Swara', engine: 'edge', provider: 'edge', modelId: 'edge', modelLabel: 'Edge', available: true },
          // Vertex voices are listed with their real configured state: no
          // credentials here means an actionable hint, never a silent Edge swap.
          ...['hi-IN-Chirp3-HD-Aoede', 'hi-IN-Chirp3-HD-Charon', 'hi-IN-Chirp3-HD-Kore', 'hi-IN-Chirp3-HD-Puck']
            .map((id) => ({
              id,
              label: `${id.slice('hi-IN-Chirp3-HD-'.length)} · Chirp 3 HD`,
              engine: 'vertex',
              provider: 'vertex',
              modelId: 'chirp-3-hd',
              modelLabel: 'Chirp 3 HD',
              available: false,
              unavailableReason: expect.stringContaining('connect a vertex-ai provider in Studio'),
            })),
          ...['Charon', 'Kore', 'Puck', 'Aoede'].map((name) => ({
            id: `gemini-tts:${name}`,
            label: `${name} · Gemini 3.8 Flash TTS`,
            engine: 'vertex',
            provider: 'vertex',
            modelId: 'gemini-3.8-flash-tts',
            modelLabel: 'Gemini 3.8 Flash TTS',
            available: false,
            unavailableReason: expect.stringContaining('connect a vertex-ai provider in Studio'),
          })),
        ],
      },
    ]);
    expect(body.sourceChapters).toEqual([
      { chapter: 'ch1', eligible: true },
      { chapter: 'ch2', eligible: false, reason: expect.stringContaining('Generate/review the English script first') },
    ]);
    expect(body.versions).toEqual([]);
  });

  it('requires a session', async () => {
    expect((await fetch(`${base}/api/series/${slug}/languages`)).status).toBe(401);
  });

  it('rejects an invalid slug without leaking host paths', async () => {
    const res = await fetch(`${base}/api/series/..%2Fetc/languages`, { headers: { cookie } });
    expect([400, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain('/etc/');
    expect(text).not.toContain(root);
  });
});

describe('POST /api/series/:slug/languages', () => {
  it('rejects missing CSRF, cross-site origin and a temporary account', async () => {
    const noCsrf = await fetch(`${base}/api/series/${slug}/languages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural' }),
    });
    expect(noCsrf.status).toBe(403);

    expect((await post(
      { locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural' },
      { origin: 'https://evil.example' },
    )).status).toBe(403);
  });

  it('rejects runtime overrides, unsupported locale/provider/voice and malformed chapters', async () => {
    expect((await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural', command: 'rm -rf /' })).status)
      .toBe(400);
    expect((await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural', model: 'x' })).status).toBe(400);
    expect((await post({ locale: 'fr-FR', chapters: '1', voice: 'hi-IN-MadhurNeural' })).status).toBe(400);
    expect((await post({ locale: 'hi-IN', chapters: '1', voice: 'en-US-AndrewMultilingualNeural' })).status).toBe(400);
    expect((await post({ locale: 'hi-IN', chapters: 'one', voice: 'hi-IN-MadhurNeural' })).status).toBe(400);
    expect((await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural', speed: 99 })).status).toBe(400);
  });

  it('returns 422 with an actionable reason when the source chapter is not eligible', async () => {
    const res = await post({ locale: 'hi-IN', chapters: '2', voice: 'hi-IN-MadhurNeural' });
    expect(res.status).toBe(422);
    expect(String(((await res.json()) as Record<string, unknown>).error))
      .toMatch(/Generate\/review the English script first/);
  });

  it('accepts a valid request with 202 and the state shape, spawning one job', async () => {
    const res = await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural', speed: 1 });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].locale).toBe('hi-IN');
    expect(['queued', 'running']).toContain(body.versions[0].status);
    expect(body.versions[0].chapters[0]).toMatchObject({
      chapter: 'ch1',
      status: 'queued',
      voice: 'hi-IN-MadhurNeural',
      speed: 1,
    });
    expect(spawned).toHaveLength(1);
    expect(fs.existsSync(jobPath(sdir, spawned[0]!.jobId))).toBe(true);
  });

  it('rejects an active duplicate with 409', async () => {
    expect((await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-SwaraNeural' })).status).toBe(409);
  });

  it('runs the job, then reports completed with a cache-busted verified URL', async () => {
    await runJob(spawned[0]!.jobId);
    const body = await state();
    const view = body.versions[0];
    expect(view.status).toBe('completed');
    expect(view.voice).toBe('hi-IN-MadhurNeural');
    expect(view.speed).toBe(1);
    expect(view.chapters[0]).toMatchObject({
      chapter: 'ch1',
      status: 'completed',
      voice: 'hi-IN-MadhurNeural',
      speed: 1,
    });
    expect(view.chapters[0].videoUrl).toBe(`/media/${slug}/languages/hi-IN/ch1/video.mp4?rev=1`);
    expect(view.chapters[0].duration).toBeGreaterThan(0);
  });

  it('keeps serving the last good video while a retry fails, and reports the new attempt', async () => {
    localize._setRendererForTests((async () => {
      throw new Error('render provider exploded');
    }) as never);
    try {
      const res = await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-SwaraNeural' });
      expect(res.status).toBe(202);
      const pending = (await res.json()) as Record<string, any>;
      // The new attempt is what the UI must poll, not the old completed record.
      expect(pending.versions[0].chapters[0].status).toBe('queued');
      expect(pending.versions[0].chapters[0].videoUrl).toBe(`/media/${slug}/languages/hi-IN/ch1/video.mp4?rev=1`);

      await runJob(spawned[spawned.length - 1]!.jobId);
      const body = await state();
      const chapter = body.versions[0].chapters[0];
      expect(chapter.status).toBe('failed');
      expect(chapter.error).toMatch(/exploded/);
      expect(chapter.stale).toBe(true);
      expect(chapter.videoUrl).toBe(`/media/${slug}/languages/hi-IN/ch1/video.mp4?rev=1`);
    } finally {
      localize._setRendererForTests(fakeRenderer() as never);
    }
  });

  it('still streams 200/206 for the last good video while the chapter is failed', async () => {
    if (!ffmpegAvailable) return;
    const body = await state();
    const url = body.versions[0].chapters[0].videoUrl as string;
    expect(url).toBeTruthy();

    const full = await fetch(`${base}${url}`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect((await full.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const ranged = await fetch(`${base}${url}`, { headers: { cookie, range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\//);

    const download = await fetch(`${base}${url}&download=1`, { headers: { cookie } });
    expect(download.headers.get('content-disposition')).toContain('attachment');

    const head = await fetch(`${base}${url}`, { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);
  });

  it('recovers a job whose worker died: interrupted, retryable, video still served', async () => {
    releaseActiveJobs('interrupted');
    const jobsDir = path.join(sdir, 'out', 'languages', 'jobs');
    const id = `loc-${Date.now()}-deadbeef`;
    writeJob(sdir, {
      schemaVersion: 1,
      id,
      slug,
      locale: 'hi-IN',
      chapters: ['ch1'],
      voice: 'hi-IN-SwaraNeural',
      speed: 1,
      status: 'running',
      stage: 'render',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: {},
      pid: 999_999_999,
      pidStart: 1,
      progress: { ch1: { status: 'running', stage: 'render', updatedAt: new Date().toISOString() } },
    });
    expect(fs.existsSync(path.join(jobsDir, `${id}.json`))).toBe(true);

    const body = await state();
    const chapter = body.versions[0].chapters[0];
    expect(chapter.status).toBe('interrupted');
    expect(chapter.error).toMatch(/exited before finishing/);
    expect(chapter.videoUrl).toBeTruthy();
    expect(readJob(sdir, id)?.status).toBe('interrupted');

    // A retry after the interruption is accepted (no stuck active job).
    const retry = await post({ locale: 'hi-IN', chapters: '1', voice: 'hi-IN-MadhurNeural' });
    expect(retry.status).toBe(202);
  });

  it('accepts a comma-separated retry list and rejects only the missing chapter', async () => {
    releaseActiveJobs();
    const res = await post({ locale: 'hi-IN', chapters: '1,3', voice: 'hi-IN-SwaraNeural' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain('ch3');
    expect(String(body.error)).not.toContain('ch2');
  });

  it('rejects a Vertex voice with no Studio credential instead of falling back to Edge', async () => {
    releaseActiveJobs();
    const before = spawned.length;
    for (const voice of ['gemini-tts:Charon', 'hi-IN-Chirp3-HD-Aoede']) {
      const res = await post({ locale: 'hi-IN', chapters: '1', voice });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe('provider_unavailable');
      expect(String(body.error)).toMatch(/Vertex/);
      expect(String(body.error)).toMatch(/Studio/);
    }
    // No job was created or spawned for the rejected requests.
    expect(spawned).toHaveLength(before);
  });
});

describe('POST /api/series/:slug/languages/preview', () => {
  it('returns a URL for a bounded Hindi sample and serves it', async () => {
    const res = await fetch(`${base}/api/series/${slug}/languages/preview`, {
      method: 'POST',
      headers: authHeaders({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ locale: 'hi-IN', voice: 'hi-IN-SwaraNeural', speed: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string };
    expect(body.url).toMatch(/^\/media\/lang-api-fixture\/languages\/hi-IN\/preview\/[a-f0-9]{64}\.mp3$/);
    const audio = await fetch(`${base}${body.url}`, { headers: { cookie } });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('rejects an unsupported voice with a clean JSON error', async () => {
    const res = await fetch(`${base}/api/series/${slug}/languages/preview`, {
      method: 'POST',
      headers: authHeaders({ 'x-csrf-token': csrf }),
      body: JSON.stringify({ locale: 'hi-IN', voice: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Record<string, unknown>).error)).not.toContain('/');
  });

  it('rejects GET and unauthenticated requests', async () => {
    expect((await fetch(`${base}/api/series/${slug}/languages/preview`, { headers: { cookie } })).status).toBe(405);
    expect((await fetch(`${base}/api/series/${slug}/languages/preview`, { method: 'POST' })).status).toBe(401);
  });
});

describe('localized media safety', () => {
  it('404s a chapter with no verified artifact and never serves English', async () => {
    expect((await fetch(`${base}/media/${slug}/languages/hi-IN/ch2/video.mp4`, { headers: { cookie } })).status)
      .toBe(404);
    expect((await fetch(`${base}/media/${slug}/ch1/video.mp4`, { headers: { cookie } })).status).toBe(404);
  });

  it('rejects traversal and symlinked localized media', async () => {
    const traversal = await fetch(`${base}/media/${slug}/languages/hi-IN/..%2F..%2Fch1/video.mp4`, {
      headers: { cookie },
    });
    expect([400, 403, 404]).toContain(traversal.status);

    const outside = path.join(root, 'outside.mp4');
    makeMp4(outside);
    const chapterDir = path.join(sdir, 'out', 'languages', 'hi-IN', 'ch9', 'video');
    fs.mkdirSync(chapterDir, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(chapterDir, 'video.mp4'));
    } catch {
      return; // symlinks unsupported here
    }
    const manifestFile = path.join(sdir, 'out', 'languages', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, any>;
    manifest.locales['hi-IN'].chapters.ch9 = {
      status: 'completed',
      updatedAt: new Date().toISOString(),
      artifact: {
        video: canonicalVideoPath(sdir, 'hi-IN', 'ch9'),
        duration: 0.6,
        size: fs.statSync(outside).size,
        videoSha256: sha256File(outside),
        renderKey: 'x',
        voice: 'hi-IN-MadhurNeural',
        speed: 1,
        revision: 1,
        publishedAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const res = await fetch(`${base}/media/${slug}/languages/hi-IN/ch9/video.mp4`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});
