import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PACING, resolveSeriesStyle, seriesStyleSchema, ttsStyleSchema } from '../src/config/seriesStyle.js';
import { JAB_GAP, MAX_RUN, RUN_S, SHOT_MIN_S, SHOT_S } from '../src/stages/writer.js';
import { narrationCacheKey } from '../src/contracts/hashes.js';

describe('series style contract', () => {
  it('validates enum values and rejects unknown keys', () => {
    expect(seriesStyleSchema.parse({ writerMode: 'story', pacing: 'fast', emotionTags: 'off', matchMode: 'auto' })).toEqual({ writerMode: 'story', pacing: 'fast', emotionTags: 'off', matchMode: 'auto' });
    for (const value of [{ pacing: 'faster' }, { writerMode: 'anything' }, { emotionTags: true }, { matchMode: 'random' }, { other: 'value' }, null]) {
      expect(seriesStyleSchema.safeParse(value).success).toBe(false);
    }
    for (const speed of [0, -1, 3, '1.2', Infinity]) expect(ttsStyleSchema.safeParse({ speed }).success).toBe(false);
    expect(ttsStyleSchema.parse({ speed: 1.2, style: 'Calm', language: 'en', voice_id: 'voice' }).speed).toBe(1.2);
  });
  it('uses series overrides before environment and built-in defaults', () => {
    const env = { WRITER_MODE: 'story', MATCH_MODE: 'visual', EMOTION_TAGS: 'on', PACING: 'slow' };
    expect(resolveSeriesStyle({}, env)).toMatchObject({ writerMode: 'story', matchMode: 'visual', emotionTags: 'on', pacing: PACING.slow });
    expect(resolveSeriesStyle({ writerMode: 'legacy', matchMode: 'auto', emotionTags: 'auto', pacing: 'normal' }, env)).toMatchObject({ writerMode: 'legacy', matchMode: 'auto', emotionTags: 'auto', pacing: PACING.normal });
    expect(resolveSeriesStyle({}, {})).toMatchObject({ writerMode: 'legacy', matchMode: 'auto', emotionTags: 'auto', pacing: PACING.normal });
  });
  it('keeps normal pacing and legacy narration hashes unchanged', () => {
    expect(PACING.normal).toEqual({ SHOT_S, RUN_S, SHOT_MIN_S, JAB_GAP, MAX_RUN });
    expect(PACING.normal).toEqual({ SHOT_S: 2.5, RUN_S: 1.25, SHOT_MIN_S: 0.8, JAB_GAP: 4, MAX_RUN: 6 });
    expect(narrationCacheKey([['Hello', ['p0001_1']]], 'edge', 'voice')).toBe(narrationCacheKey([['Hello', ['p0001_1']]], 'edge', 'voice', undefined, 1));
  });
});

describe('series settings HTTP route', () => {
  let root: string;
  let server: http.Server;
  let base: string;
  let cookie: string;
  let csrf: string;
  beforeAll(async () => {
    root = fs.mkdtempSync('/tmp/opencode/series-settings-');
    vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
    vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
    vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
    vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series'));
    vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
    vi.stubEnv('PLAYER_API_ONLY', '1');
    const dir = path.join(root, 'series', 'test-series');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Keep title', tts: { engine: 'edge', provider: 'keep-provider' }, visuals: { background: 'starfield', motion: 'cut' }, unrelated: 123 }));
    const mod = await import('../src/player/server.js');
    fs.writeFileSync(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
    server = mod.createPlayerServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'test-password' }), redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string }).csrfToken;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const patch = (body: unknown, token = true) => fetch(`${base}/api/series/test-series/settings`, {
    method: 'PATCH', headers: { cookie, Origin: base, ...(token ? { 'X-CSRF-Token': csrf } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  it('requires authentication and CSRF for writes', async () => {
    expect((await fetch(`${base}/api/series/test-series/settings`)).status).toBe(401);
    expect((await patch({ style: { pacing: 'fast' } }, false)).status).toBe(403);
  });
  it('reads, patches and resets settings without clobbering other metadata', async () => {
    const before = await fetch(`${base}/api/series/test-series/settings`, { headers: { cookie } });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ style: {}, styleOptions: { pacing: expect.any(Array) } });
    const response = await patch({ style: { writerMode: 'story', matchMode: 'caption', pacing: 'fast', emotionTags: 'off' }, tts: { speed: 1.2, style: 'Calm', language: 'en', voice_id: 'voice' }, visuals: { background: 'mist-pines', motion: 'cut' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ style: { pacing: 'fast' }, tts: { speed: 1.2, engine: 'edge', provider: 'keep-provider' } });
    const metaFile = path.join(root, 'series/test-series/meta.json');
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf8'))).toMatchObject({ title: 'Keep title', unrelated: 123 });
    expect((await patch({ style: { pacing: null }, tts: { speed: null } })).status).toBe(200);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    expect(meta.style.pacing).toBeUndefined(); expect(meta.tts.speed).toBeUndefined();
    expect(fs.readdirSync(path.dirname(metaFile))).toEqual(['meta.json']);
  });
  it('returns clear validation errors and leaves the file unchanged', async () => {
    const metaFile = path.join(root, 'series/test-series/meta.json');
    const before = fs.readFileSync(metaFile, 'utf8');
    for (const body of [{ style: { pacing: 'invalid' } }, { tts: { speed: 0 } }, { visuals: { background: '../bad' } }, { tts: { command: ['sh'] } }]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
      expect((await response.json()) as object).toHaveProperty('error', expect.any(String));
    }
    expect(fs.readFileSync(metaFile, 'utf8')).toBe(before);
    const invalidSlug = await fetch(`${base}/api/series/bad%20slug/settings`, { headers: { cookie } });
    expect(invalidSlug.status).toBe(400);
  });
  it('rejects invalid style and TTS in intake JSON before launching a job', async () => {
    for (const body of [{ style: { matchMode: 'bad' } }, { tts: { speed: -1 } }]) {
      const response = await fetch(`${base}/api/intake/jobs`, { method: 'POST', headers: { cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceType: 'gdrive', gdriveUrl: 'https://drive.google.com/file/d/test/view', title: 'Test', ...body }) });
      expect(response.status).toBe(400);
      expect((await response.json()) as object).toHaveProperty('error', expect.any(String));
    }
  });
});
