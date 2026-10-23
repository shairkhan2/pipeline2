/**
 * End-to-end language version on the REAL backend.
 *
 * The real `player/server.ts` is imported and started on an ephemeral port.
 * A POST creates a persisted job (the server spawner is replaced so the test
 * can run that exact job in-process). The job then runs the REAL
 * `renderlane.produce` -> `renderlane.prepare` -> `timeline.main` path with
 * offline synthetic Edge TTS (the shared fake-edge helper), real ffmpeg audio,
 * and a real ffmpeg render seam in place of Remotion (the expensive step).
 * Finally the MP4 is fetched back over HTTP through the media Range route.
 *
 * No paid provider, no network, no real series touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// MUST come before timeline.ts: it sets MANHWA_STUDIO_PUBLIC / EDGE_TTS_PYTHON
// at import time and installs the offline fake Edge "python".
import { fakeEdgeCalls, languageTestStudioPublic } from './helpers/language-studio-env.js';

import * as languages from '../src/player/languages.js';
import * as localize from '../src/stages/localize.js';
import * as renderlane from '../src/workers/renderlane.js';
import { canonicalVideoPath, readManifest } from '../src/localization/store.js';

const slug = 'hi-e2e';
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let root: string;
let seriesRoot: string;
let sdir: string;
let server: http.Server;
let base: string;
let cookie: string;
let csrf: string;
let jobId = '';

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

/** Deterministic offline writer lane: Hindi line per source unit + accept. */
function offlineLlm(): ReturnType<typeof vi.fn> {
  return vi.fn(async (messages: unknown, options: { tag?: string }) => {
    const raw = (messages as Array<{ content: string }>)[0]!.content;
    if (String(options?.tag ?? '').includes('review')) {
      return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', issues: [] }) } }] };
    }
    const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
    if (!block) throw new Error('translate prompt missing units');
    const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
    const hindi: Record<string, string> = {
      'He runs fast.': 'वह तेज़ दौड़ता है।',
      'She waits here.': 'वह यहाँ इंतज़ार करती है।',
      'They leave now.': 'वे अब चले जाते हैं।',
    };
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            units: units.map((u) => {
              const plain = u.text.replace(/⟦[ETH]\d*⟧/g, '').trim();
              const translated = hindi[plain];
              if (!translated) throw new Error(`no offline Hindi for ${plain}`);
              return { id: u.id, text: u.text.replace(plain, translated) };
            }),
            glossary: { names: {}, terms: {} },
          }),
        },
      }],
    };
  });
}

function buildSeries(): void {
  const out = path.join(sdir, 'out');
  const ch = 'ch1';
  const panelsDir = path.join(out, 'panels', ch);
  fs.mkdirSync(panelsDir, { recursive: true });
  // Real, decodable panel images (the cleaner/framing stages read them).
  for (let i = 1; i <= 3; i++) {
    const res = spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=0x${(0x203040 + i * 0x101010).toString(16)}:s=320x480:d=1`,
      '-frames:v', '1', path.join(panelsDir, `p0001_${i}.jpg`),
    ], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`panel fixture failed: ${res.stderr}`);
  }
  json(path.join(panelsDir, 'manifest.json'), [1, 2, 3].map((i) => ({
    panel: `p0001_${i}.jpg`, page: 1, idx: i, art_top: 0, art_bottom: 1,
  })));
  const panels = [1, 2, 3].map((i) => ({
    id: `p0001_${i}`, art: 0.9, bubble_at: 'none', overlay: [], world: [],
    page: 1, idx: i, focus_y: 0.5, weight: 2,
  }));
  json(path.join(out, `obs_${ch}.json`), { panels, characters: [], gags: [], events: [] });
  const script = 'He runs fast. @p0001_1\nShe waits here. @p0001_2\nThey leave now. @p0001_3\n';
  write(path.join(out, ch, 'script.md'), script);
  // The series uses edge TTS, so the edge script is authoritative.
  json(path.join(sdir, 'meta.json'), {
    title: 'Hindi E2E',
    tts: { engine: 'edge', voice_id: 'en-US-AndrewMultilingualNeural', speed: 1 },
    visuals: { background: 'starfield', motion: 'cut' },
  });
  // A real English render first: builds the shared promo block and the cleaned
  // panels the locale render reuses read-only.
  json(path.join(out, ch, 'report.json'), { series: slug, ch, status: 'ok', lines: 3, issues: [] });
}

beforeAll(async () => {
  if (!ffmpegAvailable) return;
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-e2e-');
  seriesRoot = path.join(root, 'series');
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
  vi.stubEnv('PIPELINE_LOG', path.join(root, 'out', 'pipeline.log'));
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
  vi.stubEnv('MANHWA_STUDIO_PUBLIC', languageTestStudioPublic());

  const mod = await import('../src/player/server.js');
  write(path.join(root, 'users'), `admin:${mod.apr1('e2e-password', 'fixture')}\n`);
  server = mod.createPlayerServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ user: 'admin', pass: 'e2e-password' }),
    redirect: 'manual',
  });
  expect(login.status).toBe(303);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string })
    .csrfToken;

  // The server's only job is to persist + spawn. Capture the spawn so this test
  // can execute the persisted job deterministically.
  languages._setJobSpawnerForTests((_dir, id) => {
    jobId = id;
  });
  localize._setLlmCallForTests(offlineLlm() as never);
  localize._setSleepForTests(async () => {});

  // Real render seam: replace ONLY the Remotion step with ffmpeg. The locale
  // timeline (TTS/timing/cleaner/framing/props) runs for real.
  renderlane._hooks.renderLocal = (_props: string, video: string) => {
    fs.mkdirSync(path.dirname(video), { recursive: true });
    const props = JSON.parse(fs.readFileSync(_props, 'utf8')) as {
      audio: string;
      shots: Array<{ end_s: number }>;
    };
    const publicDir = languageTestStudioPublic();
    const audio = path.join(publicDir, props.audio);
    const duration = Math.max(0.5, Math.max(...props.shots.map((s) => s.end_s)));
    const res = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x101820:s=320x240:d=${duration}`,
      '-i', audio,
      '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', video,
    ], { encoding: 'utf8', timeout: 120_000 });
    if (res.status !== 0) throw new Error(`ffmpeg render seam failed: ${res.stderr}`);
  };
});

afterAll(async () => {
  languages._setJobSpawnerForTests(null);
  localize._setLlmCallForTests(null);
  localize._setSleepForTests(null);
  renderlane._resetHooksForTests();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function authHeaders(): Record<string, string> {
  return {
    cookie,
    origin: base,
    'content-type': 'application/json',
    'x-csrf-token': csrf,
  };
}

describe.skipIf(!ffmpegAvailable)('language version end to end on the real backend', () => {
  it('POST -> persisted job -> real locale render -> state -> MP4 over Range', async () => {
    // 1. POST through the real route: 202 + queued state.
    const created = await fetch(`${base}/api/series/${slug}/languages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        locale: 'hi-IN',
        chapters: '1',
        voice: 'hi-IN-MadhurNeural',
        speed: 1,
      }),
    });
    expect(created.status).toBe(202);
    const queued = (await created.json()) as Record<string, any>;
    expect(queued.versions[0].chapters[0].status).toBe('queued');
    expect(jobId).toMatch(/^loc-\d+-[a-f0-9]{8}$/);
    const jobFile = path.join(sdir, 'out', 'languages', 'jobs', `${jobId}.json`);
    expect(fs.existsSync(jobFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(jobFile, 'utf8')).status).toBe('queued');

    // 2. Execute that persisted job: real localize stage + real renderlane.
    const result = await localize.runLocalizeJob(sdir, jobId, {
      skipPipelineConflictCheck: true,
      log: () => {},
    });
    expect(result.status).toBe('completed');

    // 3. The Hindi script was voiced by the offline Edge fake with the Hindi voice.
    const localeDir = path.join(sdir, 'out', 'languages', 'hi-IN', 'ch1');
    const calls = fakeEdgeCalls(path.join(localeDir, 'video', 'tts_lines_edge'));
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.voice === 'hi-IN-MadhurNeural')).toBe(true);
    expect(calls.map((c) => c.text).join(' ')).toMatch(/[\u0900-\u097F]/);
    // English artifacts were not touched.
    expect(fs.existsSync(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'))).toBe(false);

    // 4. State now reports the published artifact.
    const stateRes = await fetch(`${base}/api/series/${slug}/languages`, { headers: { cookie } });
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as Record<string, any>;
    const version = state.versions[0];
    expect(version.status).toBe('completed');
    const chapter = version.chapters[0];
    expect(chapter.status).toBe('completed');
    expect(chapter.videoUrl).toBe(`/media/${slug}/languages/hi-IN/ch1/video.mp4?rev=1`);
    expect(chapter.duration).toBeGreaterThan(0);

    // 5. Real MP4 over the media route, with Range.
    const full = await fetch(`${base}${chapter.videoUrl}`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');

    const ranged = await fetch(`${base}${chapter.videoUrl}`, {
      headers: { cookie, range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\//);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const head = await fetch(`${base}${chapter.videoUrl}`, { method: 'HEAD', headers: { cookie } });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBe(bytes.length);

    // 6. The artifact on disk is the canonical locale video and is ffprobe-readable.
    const canonical = canonicalVideoPath(sdir, 'hi-IN', 'ch1');
    expect(chapter.videoUrl).toContain('/languages/hi-IN/ch1/video.mp4');
    expect(fs.existsSync(canonical)).toBe(true);
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', canonical,
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(probe.status).toBe(0);
    expect(Number.parseFloat(probe.stdout.trim())).toBeGreaterThan(0);
    expect(readManifest(sdir).locales['hi-IN']?.chapters.ch1?.status).toBe('completed');
  }, 180_000);
});
