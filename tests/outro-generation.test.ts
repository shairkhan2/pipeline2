import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { generateSeriesOutro, inspectSeriesOutro, mergeSeriesChapters } from '../src/player/seriesTools.js';
import * as intakeMod from '../src/intake/intake.js';
import * as grokTtsMod from '../src/llm/grokTts.js';
import * as vertexTtsMod from '../src/llm/vertexTts.js';
import { upsertProvider } from '../src/config/studioConfig.js';
import { putSecret } from '../src/config/secretStore.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let root: string;
let seriesRoot: string;
let dir: string;
const slug = 'outro-fixture';
let servers: http.Server[] = [];

function write(file: string, contents: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function json(file: string, value: unknown): string {
  return write(file, JSON.stringify(value, null, 2));
}

function probeVideo(file: string): {
  streams: Array<{ codec_name?: string; codec_type?: string; width?: number; height?: number; pix_fmt?: string }>;
  format: { duration?: string; size?: string };
} {
  const res = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt:format=duration,size',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/outro-gen-');
  seriesRoot = path.join(root, 'series');
  dir = path.join(seriesRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('MANHWA_TRASH_DIR', path.join(root, 'trash'));
  vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_THUMBS_ROOT', path.join(root, 'thumbs'));
  vi.stubEnv('PIPELINE_LOG', path.join(root, 'out', 'pipeline.log'));
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
  json(path.join(dir, 'meta.json'), { title: 'Chronicles of Dawn', tts: { engine: 'edge' } });
});

afterEach(async () => {
  for (const srv of servers) {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  servers = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Library outro announcement generation regressions', () => {
  it('resolves actual v2 reader obs_chN.json + manifest.json schema, filters promos/text cards, and penalizes slivers', async () => {
    const imgNormal = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#225588' } }).jpeg().toBuffer();
    const imgSliver = await sharp({ create: { width: 160, height: 16, channels: 3, background: '#446622' } }).jpeg().toBuffer();
    const imgCleaned = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#884422' } }).png().toBuffer();

    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.jpg'), imgNormal);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0002_1.jpg'), imgNormal);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0003_1.jpg'), imgNormal);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0004_1.jpg'), imgSliver);
    write(path.join(dir, 'out', 'cleaned', 'ch1', 'p0005_1.png'), imgCleaned);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0006_1.jpg'), imgNormal);

    json(path.join(dir, 'out', 'panels', 'ch1', 'manifest.json'), [
      { panel: 'ch1/p0001_1.jpg', page: 1, idx: 1, w: 800, h: 1200, art_top: 0, art_bottom: 1 },
      { panel: 'ch1/p0002_1.jpg', page: 2, idx: 1, w: 800, h: 1200, art_top: 0, art_bottom: 1 },
      { panel: 'ch1/p0003_1.jpg', page: 3, idx: 1, w: 800, h: 1200, art_top: 0, art_bottom: 1 },
      { panel: 'ch1/p0004_1.jpg', page: 4, idx: 1, w: 800, h: 85, art_top: 0, art_bottom: 1 },
      { panel: 'ch1/p0005_1.jpg', page: 5, idx: 1, w: 800, h: 1300, art_top: 0, art_bottom: 1 },
      { panel: 'ch1/p0006_1.jpg', page: 6, idx: 1, w: 800, h: 1100, art_top: 0, art_bottom: 1 },
    ]);

    json(path.join(dir, 'out', 'bible.json'), {
      characters: {
        lin_zichen: {
          name: 'Lin Zichen',
          aliases: ['Chenchen'],
          visual: 'Spiky teal hair, bright hazel eyes',
          role: 'Main protagonist',
        },
        shen_qinghan: {
          name: 'Shen Qinghan',
          aliases: ['Hanhan'],
          visual: 'Purple twin-tails',
          role: 'Childhood friend',
        },
        unknown_passerby: {
          name: 'UNKNOWN-passerby',
          visual: 'Random crowd member',
        },
      },
    });

    json(path.join(dir, 'out', 'obs_ch1.json'), {
      brief_hash: 'abc123',
      caption_version: 2,
      data: {
        panels: [
          {
            id: 'p0001_1',
            visual: 'Scanlation credit and website promotional card',
            overlay: [],
            world: ['ELFTOON.COM'],
            art: 0.1,
            bubble_at: 'full',
            weight: 3,
            promo_page: true,
            page: 1,
            idx: 1,
          },
          {
            id: 'p0002_1',
            visual: 'Inner monologue text card panel with Lin Zichen narration.',
            overlay: ['I MUST GROW STRONGER!'],
            world: [],
            art: 0.1,
            bubble_at: 'full',
            weight: 3,
            promo_page: false,
            page: 2,
            idx: 1,
          },
          {
            id: 'p0003_1',
            visual: 'Chenchen and Shen Qinghan smile together under the courtyard trees.',
            overlay: ['LET US GO!'],
            world: [],
            art: 0.95,
            bubble_at: 'top',
            weight: 2,
            promo_page: false,
            page: 3,
            idx: 1,
          },
          {
            id: 'p0004_1',
            visual: 'Lin Zichen and Shen Qinghan in a narrow sliver strip.',
            overlay: [],
            world: [],
            art: 0.9,
            bubble_at: 'none',
            weight: 3,
            promo_page: false,
            page: 4,
            idx: 1,
          },
          {
            id: 'p0005_1',
            visual: 'Lin Zichen practices martial arts in the training hall.',
            overlay: [],
            world: [],
            art: 0.9,
            bubble_at: 'none',
            weight: 2,
            promo_page: false,
            page: 5,
            idx: 1,
          },
          {
            id: 'p0006_1',
            visual: 'Panoramic mountain landscape at dawn.',
            overlay: [],
            world: [],
            art: 1.0,
            bubble_at: 'none',
            weight: 1,
            promo_page: false,
            page: 6,
            idx: 1,
          },
        ],
        characters: [
          { name: 'UNKNOWN-guard', what_they_do: 'Stands watch', visual: 'Armor' },
          { name: 'Lin Zichen', what_they_do: 'Protagonist', visual: 'Teal hair' },
        ],
        gags: [],
        events: ['Chapter 1 unfolds.'],
      },
    });

    const state = inspectSeriesOutro({ seriesRoot, slug });
    expect(state.hasVideo).toBe(false);
    expect(state.videoUrl).toBeNull();
    expect(state.characters.map((c) => c.name)).toEqual(['Lin Zichen', 'Shen Qinghan']);
    const files = state.selectedPanels.map((p) => p.panelFile);
    expect(files).not.toContain('out/panels/ch1/p0001_1.jpg');
    expect(files).not.toContain('out/panels/ch1/p0002_1.jpg');
    expect(files[0]).toBe('out/panels/ch1/p0003_1.jpg');
    expect(files[1]).toBe('out/cleaned/ch1/p0005_1.png');
    expect(files.indexOf('out/panels/ch1/p0004_1.jpg')).toBeGreaterThan(files.indexOf('out/panels/ch1/p0006_1.jpg'));
  });

  it('falls back safely when obs_chN.json is malformed, empty, or references missing files without picking rejected promo/credit/skipped panels', () => {
    for (const name of ['p0001_1.png', 'p0002_1.png', 'p0003_1.png', 'p0004_1.png', 'p0005_1.png', 'credit_page.png']) {
      write(path.join(dir, 'out', 'panels', 'ch1', name), `IMG-${name}`);
    }

    // 1. Malformed JSON in obs_ch1.json
    write(path.join(dir, 'out', 'obs_ch1.json'), '{not-valid-json');
    let state = inspectSeriesOutro({ seriesRoot, slug });
    expect(state.selectedPanels.length).toBeGreaterThan(0);
    expect(state.selectedPanels.every((p) => !p.panelFile.includes('credit_page'))).toBe(true);

    // 2. Empty panels array in obs_ch1.json
    json(path.join(dir, 'out', 'obs_ch1.json'), { data: { panels: [] } });
    state = inspectSeriesOutro({ seriesRoot, slug });
    expect(state.selectedPanels.length).toBeGreaterThan(0);

    // 3. obs_ch1.json marks p0002_1, p0003_1, p0004_1 as promo/credit/skip and points narrative panel to a missing file
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [
          { id: 'p0002_1', promo_page: true, visual: 'Promo banner' },
          { id: 'p0003_1', skip: true, visual: 'Skipped panel' },
          { id: 'p0004_1', kind: 'credit', visual: 'Credits' },
          { id: 'p9999_1', visual: 'Missing narrative panel on disk', weight: 3 },
        ],
      },
    });
    state = inspectSeriesOutro({ seriesRoot, slug });
    const picked = state.selectedPanels.map((p) => path.basename(p.panelFile));
    expect(picked).not.toContain('p0002_1.png');
    expect(picked).not.toContain('p0003_1.png');
    expect(picked).not.toContain('p0004_1.png');
    expect(picked).not.toContain('credit_page.png');
    expect(picked.length).toBeGreaterThan(0);
  });

  it('fails explicitly when zero usable panels exist instead of returning silent success', async () => {
    write(path.join(dir, 'ch1', '001.webp'), 'POSTER');
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), 'PROMO');
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0002_1.png'), 'CREDIT');
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [
          { id: 'p0001_1', promo_page: true },
          { id: 'p0002_1', kind: 'credit' },
        ],
      },
    });

    expect(inspectSeriesOutro({ seriesRoot, slug }).selectedPanels).toEqual([]);
    await expect(generateSeriesOutro({ seriesRoot, slug, renderVideo: true, synthesizeAudio: false }))
      .rejects.toThrow(/no usable.*panel/i);
    await expect(generateSeriesOutro({ seriesRoot, slug, renderVideo: false }))
      .rejects.toThrow(/no usable.*panel/i);
    expect(fs.existsSync(path.join(dir, 'out', 'outro', 'outro-plan.json'))).toBe(false);
  });

  it.skipIf(!ffmpegAvailable)('renders mixed image formats and dimensions (PNG/JPEG/WebP/AVIF) into a valid 1280x720 yuv420p MP4', async () => {
    const pngBuf = await sharp({ create: { width: 63, height: 95, channels: 4, background: { r: 220, g: 50, b: 50, alpha: 0.9 } } }).png().toBuffer();
    const jpgBuf = await sharp({ create: { width: 140, height: 80, channels: 3, background: { r: 40, g: 180, b: 90 } } }).jpeg().toBuffer();
    const webpBuf = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 50, g: 90, b: 210 } } }).webp().toBuffer();
    const avifBuf = await sharp({ create: { width: 80, height: 130, channels: 3, background: { r: 180, g: 140, b: 40 } } }).avif().toBuffer();

    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), pngBuf);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0002_1.jpg'), jpgBuf);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0003_1.webp'), webpBuf);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0004_1.avif'), avifBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [
          { id: 'p0001_1', visual: 'Panel 1', art: 0.9, weight: 3 },
          { id: 'p0002_1', visual: 'Panel 2', art: 0.9, weight: 3 },
          { id: 'p0003_1', visual: 'Panel 3', art: 0.9, weight: 2 },
          { id: 'p0004_1', visual: 'Panel 4', art: 0.9, weight: 2 },
        ],
      },
    });

    const result = await generateSeriesOutro({ seriesRoot, slug, renderVideo: true, synthesizeAudio: false });
    expect(result.ok).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.hasVideo).toBe(true);
    expect(result.videoUrl).toBe(`/media/${slug}/outro/video.mp4`);
    expect(typeof result.videoUpdatedAt).toBe('number');

    const videoFile = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
    const probed = probeVideo(videoFile);
    const vStream = probed.streams.find((s) => s.codec_type === 'video');
    const aStream = probed.streams.find((s) => s.codec_type === 'audio');
    expect(vStream).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p' });
    expect(aStream).toMatchObject({ codec_name: 'aac' });
    expect(Number(probed.format.duration)).toBeGreaterThanOrEqual(7.5);
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('completes a silent panel showcase video with an explicit warning when narration fails or times out', async () => {
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#335577' } }).png().toBuffer();
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0002_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [
          { id: 'p0001_1', visual: 'Hero stands ready', art: 0.9, weight: 3 },
          { id: 'p0002_1', visual: 'Hero draws blade', art: 0.9, weight: 2 },
        ],
      },
    });

    // External TTS adapter that hangs past the bounded timeout
    const hangingAdapter = write(path.join(root, 'hang-tts.cjs'), 'setTimeout(() => {}, 10000);');
    json(path.join(dir, 'meta.json'), {
      title: 'Chronicles of Dawn',
      tts: { engine: 'external', voice_id: 'rex', command: [process.execPath, hangingAdapter] },
    });

    const started = Date.now();
    const result = await generateSeriesOutro({
      seriesRoot,
      slug,
      renderVideo: true,
      synthesizeAudio: true,
      ttsTimeoutMs: 250,
    });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(15_000);
    expect(result.ok).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.hasVideo).toBe(true);
    expect(result.videoUrl).toBe(`/media/${slug}/outro/video.mp4`);
    expect(result.audioUrl).toBeNull();
    expect(result.audioError).toMatch(/timed out|silent/i);
    expect(result.warning).toMatch(/timed out|silent/i);

    const videoFile = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
    const probed = probeVideo(videoFile);
    expect(probed.streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264')).toBe(true);
    expect(probed.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
    expect(Number(probed.format.duration)).toBeGreaterThanOrEqual(3.5);
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('preserves the last good outro video and plan when a subsequent regeneration fails', async () => {
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#227755' } }).png().toBuffer();
    const panelPath = write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [{ id: 'p0001_1', visual: 'Hero portrait', art: 0.95, weight: 3 }],
      },
    });

    const first = await generateSeriesOutro({
      seriesRoot,
      slug,
      totalChapters: 10,
      coveredChapters: 5,
      hookType: 'part2',
      renderVideo: true,
      synthesizeAudio: false,
    });
    expect(first.rendered).toBe(true);
    const videoFile = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
    const planFile = path.join(dir, 'out', 'outro', 'outro-plan.json');
    const goodVideoBytes = fs.readFileSync(videoFile);
    const goodPlanText = fs.readFileSync(planFile, 'utf8');

    // Corrupt the panel image so decoding fails on the next render
    write(panelPath, 'CORRUPT-NOT-AN-IMAGE');
    await expect(
      generateSeriesOutro({
        seriesRoot,
        slug,
        totalChapters: 20,
        coveredChapters: 10,
        hookType: 'next_chapter',
        renderVideo: true,
        synthesizeAudio: false,
      }),
    ).rejects.toThrow(/could not be decoded/i);

    expect(fs.readFileSync(videoFile)).toEqual(goodVideoBytes);
    expect(fs.readFileSync(planFile, 'utf8')).toBe(goodPlanText);
    const inspected = inspectSeriesOutro({ seriesRoot, slug });
    expect(inspected.hasVideo).toBe(true);
    expect(inspected.videoUrl).toBe(`/media/${slug}/outro/video.mp4`);
    expect(inspected.hookType).toBe('part2');
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('serves playable /media/<slug>/outro/video.mp4, download attachment, and 422 JSON errors over HTTP', async () => {
    const htpasswd = write(path.join(root, '.htpasswd'), '');
    const secret = write(path.join(root, '.secret'), '0123456789abcdef0123456789abcdef');
    const tempUsers = json(path.join(root, '.temp.json'), {});
    vi.stubEnv('PLAYER_HTPASSWD', htpasswd);
    vi.stubEnv('PLAYER_SECRET_FILE', secret);
    vi.stubEnv('PLAYER_TEMP_USERS', tempUsers);
    vi.resetModules();
    const mod = await import('../src/player/server.js');
    fs.writeFileSync(htpasswd, `admin:${mod.apr1('pw', 'saltsalt')}\n`);
    const cookie = `${mod.COOKIE}=${encodeURIComponent(mod.makeCookie('admin'))}`;
    const session = mod.parseSession({ headers: { cookie } } as unknown as http.IncomingMessage)!;
    const srv = mod.createPlayerServer();
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const req = (url: string, method = 'GET', body?: unknown) =>
      fetch(`${base}${url}`, {
        method,
        headers: {
          cookie,
          Origin: base,
          'X-CSRF-Token': session.csrfToken,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    // Zero panels initially -> POST /outro returns 422 with explicit error
    const failZero = await req(`/api/series/${slug}/outro`, 'POST', {
      totalChapters: 10,
      coveredChapters: 5,
      hookType: 'part2',
      renderVideo: true,
    });
    expect(failZero.status).toBe(422);
    const failZeroJson = (await failZero.json()) as any;
    expect(String(failZeroJson.error)).toMatch(/no usable.*panel/i);

    // Add real panel and generate outro with silent fallback
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#445599' } }).png().toBuffer();
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: { panels: [{ id: 'p0001_1', visual: 'Hero stands tall', art: 0.95, weight: 3 }] },
    });

    const genRes = await req(`/api/series/${slug}/outro`, 'POST', {
      totalChapters: 10,
      coveredChapters: 5,
      hookType: 'part2',
      renderVideo: true,
      synthesizeAudio: false,
    });
    expect(genRes.status).toBe(200);
    const genJson = (await genRes.json()) as any;
    expect(genJson).toMatchObject({
      ok: true,
      rendered: true,
      hasVideo: true,
      videoUrl: `/media/${slug}/outro/video.mp4`,
    });
    expect(typeof genJson.videoUpdatedAt).toBe('number');

    const streamRes = await req(`/media/${slug}/outro/video.mp4`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('video/mp4');
    const streamBytes = Buffer.from(await streamRes.arrayBuffer());
    expect(streamBytes.length).toBeGreaterThan(500);

    const dlRes = await req(`/media/${slug}/outro/video.mp4?download=1`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toContain(`filename="${slug}-outro.mp4"`);
  }, 30_000);

  it('rejects all sliced and manifest-mapped panels on a known full-page promo without treating a single skipped crop as a full-page promo', () => {
    for (const name of ['p0001_1.png', 'p0001_2.png', 'custom_p1.png', 'p0002_1.png', 'p0002_2.png', 'p0003_1.png']) {
      write(path.join(dir, 'out', 'panels', 'ch1', name), `IMG-${name}`);
    }
    json(path.join(dir, 'out', 'panels', 'ch1', 'manifest.json'), [
      { panel: 'ch1/p0001_1.png', page: 1, idx: 1, w: 800, h: 1200 },
      { panel: 'ch1/p0001_2.png', page: 1, idx: 2, w: 800, h: 1200 },
      { panel: 'ch1/custom_p1.png', page: 1, idx: 3, w: 800, h: 1200 },
      { panel: 'ch1/p0002_1.png', page: 2, idx: 1, w: 800, h: 1200 },
      { panel: 'ch1/p0002_2.png', page: 2, idx: 2, w: 800, h: 1200 },
      { panel: 'ch1/p0003_1.png', page: 3, idx: 1, w: 800, h: 1200 },
    ]);
    // Page 1 is a known full-page promo via p0001_1; p0002_1 is a single skipped crop on page 2;
    // narrative panel p9999_1 is missing on disk so fallback runs.
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: {
        panels: [
          { id: 'p0001_1', promo_page: true, page: 1, visual: 'Full advert page' },
          { id: 'p0002_1', skip: true, page: 2, visual: 'Single skipped crop on story page 2' },
          { id: 'p9999_1', visual: 'Missing narrative panel', weight: 3 },
        ],
      },
    });

    const state = inspectSeriesOutro({ seriesRoot, slug });
    const picked = state.selectedPanels.map((p) => path.basename(p.panelFile));
    // All panels on full-promo page 1 (p0001_1, sibling p0001_2, manifest page 1 custom_p1) are rejected
    expect(picked).not.toContain('p0001_1.png');
    expect(picked).not.toContain('p0001_2.png');
    expect(picked).not.toContain('custom_p1.png');
    // The single skipped crop p0002_1 is rejected, but sibling story panel p0002_2 on page 2 is NOT rejected
    expect(picked).not.toContain('p0002_1.png');
    expect(picked).toContain('p0002_2.png');
  });

  it.skipIf(!ffmpegAvailable)('keeps mergeSeriesChapters default command timeout at 600_000ms while bounding outro calls', async () => {
    const chVideo = path.join(dir, 'out', 'ch1', 'video', 'video.mp4');
    fs.mkdirSync(path.dirname(chVideo), { recursive: true });
    const gen = spawnSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=0.25',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '0.25', chVideo,
    ], { encoding: 'utf8' });
    expect(gen.status, gen.stderr).toBe(0);

    const realRun = intakeMod.runCommand;
    const seenTimeouts: Array<{ bin: string; args: string[]; timeoutMs?: number }> = [];
    const spy = vi.spyOn(intakeMod, 'runCommand').mockImplementation((cmd, opts) => {
      seenTimeouts.push({ bin: path.basename(cmd[0] || ''), args: cmd.slice(1), timeoutMs: opts?.timeoutMs });
      return realRun(cmd, opts);
    });
    try {
      const merged = await mergeSeriesChapters({ seriesRoot, slug, includeOutro: false });
      expect(merged.ok).toBe(true);
      const ffmpegMergeCalls = seenTimeouts.filter((c) => c.bin === 'ffmpeg' && c.args.includes('-f') && c.args.includes('concat'));
      expect(ffmpegMergeCalls.length).toBeGreaterThan(0);
      expect(ffmpegMergeCalls.every((c) => c.timeoutMs === 600_000)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('enforces a single overall operation deadline across phases and aborts before committing if render exceeds remaining budget', async () => {
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#336699' } }).png().toBuffer();
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: { panels: [{ id: 'p0001_1', visual: 'Hero stands', art: 0.9, weight: 3 }] },
    });

    const realRun = intakeMod.runCommand;
    const spy = vi.spyOn(intakeMod, 'runCommand').mockImplementation(async (cmd, opts) => {
      if (path.basename(cmd[0] || '') === 'ffmpeg' && cmd.includes('concat')) {
        // Simulate a slow render that hits the remaining operation budget
        await new Promise((r) => setTimeout(r, (opts?.timeoutMs ?? 500) + 50));
        return { code: 1, stdout: '', stderr: '', timedOut: true };
      }
      return realRun(cmd, opts);
    });
    try {
      await expect(
        generateSeriesOutro({
          seriesRoot,
          slug,
          renderVideo: true,
          synthesizeAudio: false,
          timeoutMs: 400,
        }),
      ).rejects.toThrow(/timed out/i);
      expect(fs.existsSync(path.join(dir, 'out', 'outro', 'video', 'video.mp4'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('aborts Vertex and Grok TTS via AbortSignal on timeout and never leaks .outro-* directories on late completion', async () => {
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#447788' } }).png().toBuffer();
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: { panels: [{ id: 'p0001_1', visual: 'Hero portrait', art: 0.95, weight: 3 }] },
    });

    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', 'xai-studio-token', outDir);
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);

    for (const engine of ['grok', 'vertex'] as const) {
      json(path.join(dir, 'meta.json'), {
        title: 'Chronicles of Dawn',
        tts: { engine, voice_id: engine === 'grok' ? 'ara' : 'en-US-Chirp3-HD-Charon', speed: 1 },
      });

      let capturedSignal: AbortSignal | undefined;
      let resolveLateBody!: () => void;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: any, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true });
          resolveLateBody = () =>
            resolve(
              new Response(JSON.stringify({ audioContent: Buffer.from('FAKE').toString('base64') }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        });
      }) as typeof fetch);

      try {
        const res = await generateSeriesOutro({
          seriesRoot,
          slug,
          renderVideo: true,
          synthesizeAudio: true,
          ttsTimeoutMs: 150,
        });
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(true);
        if (resolveLateBody) resolveLateBody();
        expect(res.rendered).toBe(true);
        expect(res.hasVideo).toBe(true);
        expect(res.audioError).toMatch(/timed out|silent/i);
        await new Promise((r) => setTimeout(r, 50));
        const videoDirEntries = fs.readdirSync(path.join(dir, 'out', 'outro', 'video'));
        expect(videoDirEntries.filter((e) => e.startsWith('.outro-'))).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    }
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('validates all commit destination paths before replacing existing video or audio', async () => {
    const imgBuf = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#226644' } }).png().toBuffer();
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), imgBuf);
    json(path.join(dir, 'out', 'obs_ch1.json'), {
      data: { panels: [{ id: 'p0001_1', visual: 'Hero stands', art: 0.95, weight: 3 }] },
    });

    const audioFixture = path.join(root, 'valid.mp3');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', audioFixture]);
    const adapter = write(
      path.join(root, 'copy-tts.cjs'),
      `const fs = require('node:fs'); const req = JSON.parse(fs.readFileSync(0, 'utf8')); fs.copyFileSync(${JSON.stringify(audioFixture)}, req.output_path);`,
    );
    json(path.join(dir, 'meta.json'), {
      title: 'Chronicles of Dawn',
      tts: { engine: 'external', voice_id: 'v1', command: [process.execPath, adapter] },
    });

    const first = await generateSeriesOutro({
      seriesRoot,
      slug,
      totalChapters: 10,
      coveredChapters: 5,
      hookType: 'part2',
      renderVideo: true,
      synthesizeAudio: true,
    });
    expect(first.rendered).toBe(true);

    const videoFile = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
    const audioFile = path.join(dir, 'out', 'outro', 'audio', 'narration.mp3');
    const planFile = path.join(dir, 'out', 'outro', 'outro-plan.json');
    const scriptFile = path.join(dir, 'out', 'outro', 'script.md');
    const shotsFile = path.join(dir, 'out', 'outro', 'shots.json');

    const prevVideo = fs.readFileSync(videoFile);
    const prevAudio = fs.readFileSync(audioFile);
    const prevPlan = fs.readFileSync(planFile);

    // Replace shots.json with a symlink after initial generation (or during render before commit)
    const outsideTarget = write(path.join(root, 'outside-shots.json'), '{}');
    fs.rmSync(shotsFile, { force: true });
    fs.symlinkSync(outsideTarget, shotsFile);

    await expect(
      generateSeriesOutro({
        seriesRoot,
        slug,
        totalChapters: 20,
        coveredChapters: 10,
        hookType: 'next_chapter',
        renderVideo: true,
        synthesizeAudio: false,
      }),
    ).rejects.toThrow(/symbolic link/i);

    // Also test when shots.json is turned into a symlink mid-render (after initial check, before commit)
    fs.rmSync(shotsFile, { force: true });
    fs.writeFileSync(shotsFile, '{}');
    const realRun = intakeMod.runCommand;
    const spy = vi.spyOn(intakeMod, 'runCommand').mockImplementation(async (cmd, opts) => {
      const res = await realRun(cmd, opts);
      if (path.basename(cmd[0] || '') === 'ffmpeg' && cmd.includes('concat')) {
        fs.rmSync(shotsFile, { force: true });
        fs.symlinkSync(outsideTarget, shotsFile);
      }
      return res;
    });
    try {
      await expect(
        generateSeriesOutro({
          seriesRoot,
          slug,
          totalChapters: 30,
          coveredChapters: 15,
          hookType: 'next_chapter',
          renderVideo: true,
          synthesizeAudio: false,
        }),
      ).rejects.toThrow(/symbolic link/i);
      expect(fs.readFileSync(videoFile)).toEqual(prevVideo);
      expect(fs.readFileSync(audioFile)).toEqual(prevAudio);
      expect(fs.readFileSync(planFile)).toEqual(prevPlan);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('directly aborts Grok and Vertex synthesizeToFile fetch calls and prevents any post-abort disk writes', async () => {
    const missingDir = path.join(root, 'never-created-dir');
    const destGrok = path.join(missingDir, 'grok.mp3');
    const destVertex = path.join(missingDir, 'vertex.mp3');

    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', 'xai-studio-token', outDir);
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);

    const ac = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let resolveLateBody!: (buf: ArrayBuffer) => void;
    const fakeFetch: typeof fetch = (async (_input: any, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            resolveLateBody = (buf: ArrayBuffer) => {
              controller.enqueue(new Uint8Array(buf));
              controller.close();
            };
          },
        }),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      );
    }) as typeof fetch;

    const grokPromise = grokTtsMod.synthesizeGrokTtsToFile({
      text: 'Hello world',
      voiceId: 'ara',
      destPath: destGrok,
      env: { ...process.env, MANHWA_OUT_DIR: outDir },
      fetchImpl: fakeFetch,
      signal: ac.signal,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSignal).toBeDefined();
    ac.abort(new Error('caller timed out'));
    expect(fetchSignal?.aborted).toBe(true);
    if (resolveLateBody) resolveLateBody(new Uint8Array([1, 2, 3, 4]).buffer);

    await expect(grokPromise).rejects.toThrow(/timed out|abort/i);

    // Also verify Vertex Chirp with an already-aborted or mid-flight aborted signal never creates missingDir
    await expect(
      vertexTtsMod.synthesizeVertexTtsToFile({
        text: 'Hello world',
        voiceId: 'en-US-Chirp3-HD-Charon',
        destPath: destVertex,
        env: { ...process.env, MANHWA_OUT_DIR: outDir },
        fetchImpl: fakeFetch,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/timed out|abort/i);

    expect(fs.existsSync(missingDir)).toBe(false);
    expect(fs.existsSync(destGrok)).toBe(false);
    expect(fs.existsSync(destVertex)).toBe(false);
  });

  it('preserves prior video visibility in UI state contract when a legacy response returns rendered=false', () => {
    const librarySource = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/pages/LibraryPage.tsx'),
      'utf8',
    );
    expect(librarySource).toContain('rendered: prevHasVideo ? true : false');
    expect(librarySource).toContain('outroState.hasVideo === true');

    // Simulate the state transition in submitGenerateOutro when prev has a valid video
    // and a malformed/legacy response arrives with rendered: false and videoUrl: null
    const prev = {
      slug,
      hasVideo: true,
      rendered: true,
      videoUrl: `/media/${slug}/outro/video.mp4`,
      videoUpdatedAt: 1700000000000,
    };
    const legacyFailedRes = {
      ok: true,
      slug,
      rendered: false,
      renderError: 'ffmpeg exited with 1',
      videoUrl: null,
      panels: [{ chapter: 'ch1', panelFile: 'out/panels/ch1/p0001_1.png' }],
    };
    const prevHasVideo = Boolean(prev?.videoUrl && prev?.hasVideo !== false);
    const merged = {
      ...prev,
      ...legacyFailedRes,
      rendered: prevHasVideo ? true : false,
      hasVideo: prevHasVideo,
      videoUrl: prevHasVideo ? prev.videoUrl : null,
      videoUpdatedAt: prevHasVideo ? prev.videoUpdatedAt : null,
    };
    const hasOutroVideo = Boolean(
      merged?.videoUrl &&
        (merged.hasVideo === true || (merged.hasVideo !== false && merged.rendered !== false)),
    );
    expect(hasOutroVideo).toBe(true);
    expect(merged.videoUrl).toBe(`/media/${slug}/outro/video.mp4`);
    expect(librarySource).toContain('key={activeSeries.slug}');
    expect(librarySource).toContain('activeSlugRef.current !== requestedSlug');
    expect(librarySource).toContain('res.warnings');
    expect(librarySource).toContain('poster={outroPosterUrl || undefined}');
  });

  it('cancels a hanging Gemini TTS ffmpeg transcode subprocess via AbortSignal without blocking the event loop or leaking scratch dirs', async () => {
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);

    const fakeFfmpeg = write(
      path.join(root, 'hang-ffmpeg.sh'),
      '#!/bin/sh\nsleep 15\n',
    );
    fs.chmodSync(fakeFfmpeg, 0o755);

    const transcodeDir = path.join(root, 'gemini-transcode-out');
    fs.mkdirSync(transcodeDir, { recursive: true });
    const dest = path.join(transcodeDir, 'gemini.mp3');

    const fakeFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: Buffer.alloc(64, 1).toString('base64'),
                      mimeType: 'audio/pcm',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('transcode timed out')), 120);
    const started = Date.now();
    try {
      await expect(
        vertexTtsMod.synthesizeVertexTtsToFile({
          text: 'Gemini TTS test',
          voiceId: 'gemini-tts:Charon',
          destPath: dest,
          env: { ...process.env, MANHWA_OUT_DIR: outDir, MANHWA_FFMPEG_BIN: fakeFfmpeg },
          fetchImpl: fakeFetch,
          signal: ac.signal,
        }),
      ).rejects.toThrow(/timed out|abort/i);
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3_000);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(transcodeDir).filter((e) => e.startsWith('.vertex-tts-'))).toEqual([]);
  });
});

describe('English outro picture length (B25)', () => {
  /** One distinct colour per panel, so the decoded frames show each panel's hold. */
  async function panels(n: number): Promise<void> {
    const recs = [];
    for (let i = 1; i <= n; i++) {
      const id = `p000${i}_1`;
      const file = path.join(dir, 'out', 'panels', 'ch1', `${id}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 40 * i, g: 20, b: 20 } } }).jpeg().toFile(file);
      recs.push({ id, visual: 'Jin closeup', characters: ['Jin'], framing: 'closeup', art: 0.9 });
    }
    json(path.join(dir, 'out', 'obs_ch1.json'), { data: { panels: recs, characters: [{ name: 'Jin' }] } });
  }

  /** Run lengths of identical decoded frames (1x1 downscale, red channel). */
  function holds(file: string): number[] {
    const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=neighbor',
      '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1024 * 1024 });
    expect(res.status).toBe(0);
    const buf = res.stdout as Buffer;
    const runs: number[] = [];
    let prev = -1;
    for (let i = 0; i + 2 < buf.length; i += 3) {
      const red = Math.round(buf[i]! / 20);
      if (red === prev) runs[runs.length - 1]! += 1;
      else runs.push(1);
      prev = red;
    }
    return runs;
  }

  function videoTrack(file: string): number {
    const res = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration',
      '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return Number(res.stdout.trim());
  }

  for (const n of [1, 2, 3]) {
    it(`holds every one of ${n} panel(s) for its full share, the last one included`, async () => {
      if (!ffmpegAvailable) return;
      await panels(n);
      const result = await generateSeriesOutro({ seriesRoot, slug, renderVideo: true, synthesizeAudio: false });
      expect(result.panels).toHaveLength(n);
      const video = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
      // Silent showcase: 2 s per panel at 30 fps, 1280x720 as before.
      expect(Math.abs(videoTrack(video) - 2 * n)).toBeLessThan(0.05);
      expect(holds(video)).toEqual(Array.from({ length: n }, () => 60));
      const info = probeVideo(video);
      expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 1280, height: 720, pix_fmt: 'yuv420p' });
    });
  }
});
