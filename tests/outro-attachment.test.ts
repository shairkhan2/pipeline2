/**
 * Series outro attachment ("Use after Chapter N" / "Use as series outro").
 *
 * Covers the non-destructive contract: a saved series-level preference decides whether
 * Merge All Chapters appends the rendered outro exactly once at the end. Chapter MP4s are
 * never rewritten, and the legacy "include a rendered outro" default is preserved when no
 * explicit choice has been saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import {
  getSeriesMergeState, inspectSeriesOutro, mergeSeriesChapters, setSeriesOutroAttachment,
} from '../src/player/seriesTools.js';
import { withExclusiveSeriesLock } from '../src/locks/seriesLock.js';
import * as intakeMod from '../src/intake/intake.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let root: string;
let seriesRoot: string;
let dir: string;
const slug = 'outro-attach';
let servers: http.Server[] = [];

function write(file: string, contents: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function json(file: string, value: unknown): string {
  return write(file, JSON.stringify(value, null, 2));
}

function chapterVideo(ch: string, color: string, size = '64x64'): string {
  const file = path.join(dir, 'out', ch, 'video', 'video.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=0.4`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '0.4', file,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(res.status, res.stderr).toBe(0);
  return file;
}

function outroVideo(color = 'green', size = '64x64'): string {
  const file = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=0.4`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '0.4', file,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(res.status, res.stderr).toBe(0);
  return file;
}

function probe(file: string): { duration: number; video: Array<{ width: number; height: number }>; hasAudio: boolean } {
  const res = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,width,height', '-of', 'json', file], { encoding: 'utf8', timeout: 15_000 });
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  return {
    duration: Number(parsed.format?.duration),
    video: streams.filter((s: any) => s.codec_type === 'video').map((s: any) => ({ width: s.width, height: s.height })),
    hasAudio: streams.some((s: any) => s.codec_type === 'audio'),
  };
}

/** Decode one frame at `at` seconds and return its centre RGB triplet. */
function centerPixel(file: string, at: number): [number, number, number] {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  expect(res.status).toBe(0);
  const buf = res.stdout as Buffer;
  const info = probe(file);
  const width = info.video[0]?.width ?? 64;
  const height = info.video[0]?.height ?? 64;
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
  return [buf[offset] ?? 0, buf[offset + 1] ?? 0, buf[offset + 2] ?? 0];
}

function isGreen(pixel: [number, number, number]): boolean {
  return pixel[1] > 90 && pixel[0] < 70 && pixel[2] < 70;
}

function isRed(pixel: [number, number, number]): boolean {
  return pixel[0] > 90 && pixel[1] < 70 && pixel[2] < 70;
}

function isBlue(pixel: [number, number, number]): boolean {
  return pixel[2] > 90 && pixel[0] < 70 && pixel[1] < 70;
}

const attachmentFile = () => path.join(dir, 'out', 'outro', 'attachment.json');

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/outro-attach-');
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
  json(path.join(dir, 'meta.json'), { title: 'Attached Outro', tts: { engine: 'edge' } });
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

describe('outro attachment preference', () => {
  it('keeps the legacy auto-include default when nothing has been saved', async () => {
    chapterVideo('ch1', 'red');
    chapterVideo('ch2', 'blue');
    outroVideo('green');
    expect(fs.existsSync(attachmentFile())).toBe(false);
    const state = getSeriesMergeState({ seriesRoot, slug });
    expect(state.attachment.explicit).toBe(false);
    expect(state.attachment.nextMergeIncludesOutro).toBe(true);
    expect(state.includesOutro).toBe(true);
    expect(state.outro).toMatchObject({ included: true, targetChapter: 'ch2', position: 3 });
    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    expect(merged.includesOutro).toBe(true);
    // No attachment.json is invented by a merge.
    expect(fs.existsSync(attachmentFile())).toBe(false);
  });

  it('attaches after the newest rendered chapter, persists across reloads, and detaches', async () => {
    chapterVideo('ch1', 'red');
    chapterVideo('ch3', 'blue');
    outroVideo('green');
    const attached = await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    expect(attached.ok).toBe(true);
    expect(attached.attachment).toMatchObject({ explicit: true, enabled: true, targetChapter: 'ch3', stale: false });
    // GET /outro reports the same attachment so the builder modal can show it.
    expect(inspectSeriesOutro({ seriesRoot, slug }).attachment).toMatchObject({
      explicit: true, enabled: true, targetChapter: 'ch3',
    });
    const saved = JSON.parse(fs.readFileSync(attachmentFile(), 'utf8'));
    expect(saved).toMatchObject({ enabled: true, targetChapter: 'ch3' });
    expect(saved.video.size).toBeGreaterThan(100);

    // A fresh read (new request / process) sees the saved choice.
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment).toMatchObject({
      explicit: true, enabled: true, targetChapter: 'ch3', nextMergeIncludesOutro: true,
    });

    const detached = await setSeriesOutroAttachment({ seriesRoot, slug, enabled: false });
    expect(detached.attachment).toMatchObject({ explicit: true, enabled: false, nextMergeIncludesOutro: false });
    expect(getSeriesMergeState({ seriesRoot, slug })).toMatchObject({ includesOutro: false, attachment: { enabled: false } });
    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    expect(merged.includesOutro).toBe(false);
    expect(merged.chaptersMerged).toEqual(['ch1', 'ch3']);
    // Detaching after a merge that included the outro makes that compilation stale.
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await mergeSeriesChapters({ seriesRoot, slug });
    expect(getSeriesMergeState({ seriesRoot, slug }).stale).toBe(false);
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: false });
    expect(getSeriesMergeState({ seriesRoot, slug })).toMatchObject({ stale: true, includesOutro: false });
  });

  it('refuses to attach without a readable outro render or without a rendered chapter', async () => {
    chapterVideo('ch1', 'red');
    await expect(setSeriesOutroAttachment({ seriesRoot, slug, enabled: true }))
      .rejects.toThrow('Generate the outro video before attaching');
    write(path.join(dir, 'out', 'outro', 'video', 'video.mp4'), 'not an mp4');
    await expect(setSeriesOutroAttachment({ seriesRoot, slug, enabled: true }))
      .rejects.toThrow('not a readable MP4 stream');
    expect(fs.existsSync(attachmentFile())).toBe(false);

    fs.rmSync(path.join(dir, 'out', 'ch1'), { recursive: true, force: true });
    outroVideo('green');
    await expect(setSeriesOutroAttachment({ seriesRoot, slug, enabled: true }))
      .rejects.toThrow('Render at least one chapter video');
  });

  it('rejects a busy series instead of writing a partial preference', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await expect(withExclusiveSeriesLock(dir, async () => {
      await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    })).rejects.toThrow('Series is busy');
    expect(fs.existsSync(attachmentFile())).toBe(false);
  });

  it('refuses a symlinked attachment path', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    const outside = write(path.join(root, 'outside.json'), '{"enabled":true}');
    fs.symlinkSync(outside, attachmentFile());
    await expect(setSeriesOutroAttachment({ seriesRoot, slug, enabled: false }))
      .rejects.toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"enabled":true}');
  });

  it('tracks a newly added final chapter and reports regeneration as stale', async () => {
    chapterVideo('ch1', 'red');
    chapterVideo('ch2', 'blue');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await mergeSeriesChapters({ seriesRoot, slug });
    expect(getSeriesMergeState({ seriesRoot, slug }).stale).toBe(false);

    // A regenerated outro changes the compiled sources: the compilation is stale.
    await new Promise((r) => setTimeout(r, 15));
    outroVideo('green', '96x96');
    const afterRegen = getSeriesMergeState({ seriesRoot, slug });
    expect(afterRegen.stale).toBe(true);
    expect(afterRegen.attachment).toMatchObject({ videoChanged: true, stale: true, nextMergeIncludesOutro: true });

    // A new final chapter moves the target: the outro still stays last, exactly once.
    chapterVideo('ch3', 'red');
    const afterAdd = getSeriesMergeState({ seriesRoot, slug });
    expect(afterAdd.attachment).toMatchObject({ enabled: true, targetChapter: 'ch3', addedSinceAttach: true });
    expect(afterAdd.outro).toMatchObject({ included: true, targetChapter: 'ch3', position: 4 });
    expect(afterAdd.stale).toBe(true);

    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    expect(merged.chaptersMerged).toEqual(['ch1', 'ch2', 'ch3']);
    expect(merged.sources.map((s) => s.file)).toEqual([
      path.join('out', 'ch1', 'video', 'video.mp4'),
      path.join('out', 'ch2', 'video', 'video.mp4'),
      path.join('out', 'ch3', 'video', 'video.mp4'),
      path.join('out', 'outro', 'video', 'video.mp4'),
    ]);
    expect(getSeriesMergeState({ seriesRoot, slug }).stale).toBe(false);
  });

  it('clears the regeneration snapshot after a successful merge that used the outro', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await new Promise((r) => setTimeout(r, 15));
    outroVideo('green', '96x96');
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment).toMatchObject({
      videoChanged: true, stale: true,
    });
    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    expect(merged.attachment).toMatchObject({ videoChanged: false, stale: false, enabled: true });
    const after = getSeriesMergeState({ seriesRoot, slug });
    expect(after.attachment).toMatchObject({ videoChanged: false, stale: false, explicit: true });
    expect(after.stale).toBe(false);
  });

  it('lets re-attaching acknowledge a regenerated outro without a merge', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await new Promise((r) => setTimeout(r, 15));
    outroVideo('green', '96x96');
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment.videoChanged).toBe(true);
    const refreshed = await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    expect(refreshed.attachment).toMatchObject({ videoChanged: false, stale: false, enabled: true });
  });

  it('detaches idempotently even when out/outro was deleted with the render', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    fs.rmSync(path.join(dir, 'out', 'outro'), { recursive: true, force: true });
    expect(fs.existsSync(path.join(dir, 'out', 'outro'))).toBe(false);
    const detached = await setSeriesOutroAttachment({ seriesRoot, slug, enabled: false });
    expect(detached.attachment).toMatchObject({ explicit: true, enabled: false, nextMergeIncludesOutro: false });
    // Detaching again is a no-op, not an error.
    const again = await setSeriesOutroAttachment({ seriesRoot, slug, enabled: false });
    expect(again.attachment).toMatchObject({ explicit: true, enabled: false });
    expect(JSON.parse(fs.readFileSync(attachmentFile(), 'utf8'))).toMatchObject({ enabled: false });
  });

  it('reports no outro generated for the legacy default when no render exists', () => {
    chapterVideo('ch1', 'red');
    const state = getSeriesMergeState({ seriesRoot, slug });
    expect(state.attachment).toMatchObject({
      explicit: false, videoAvailable: false, nextMergeIncludesOutro: false, blocked: false, stale: false,
    });
    expect(state.includesOutro).toBe(false);
  });

  it('allows the UI to attach when nothing is saved or the attachment needs refreshing', async () => {
    // Mirrors canAttachOutro() in LibraryPage: the disabled state is only for an
    // explicit, enabled attachment whose snapshot still matches the render.
    chapterVideo('ch1', 'red');
    outroVideo('green');
    const legacy = getSeriesMergeState({ seriesRoot, slug }).attachment;
    expect(legacy).toMatchObject({ explicit: false, nextMergeIncludesOutro: true });

    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const fresh = getSeriesMergeState({ seriesRoot, slug }).attachment;
    expect(fresh).toMatchObject({ explicit: true, enabled: true, stale: false, videoChanged: false });

    await new Promise((r) => setTimeout(r, 15));
    outroVideo('green', '96x96');
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment.stale).toBe(true);
  });

  it('lets an explicit API override win for one merge without changing the saved preference', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    expect((await mergeSeriesChapters({ seriesRoot, slug, includeOutro: false })).includesOutro).toBe(false);
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment.enabled).toBe(true);

    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: false });
    expect((await mergeSeriesChapters({ seriesRoot, slug, includeOutro: true })).includesOutro).toBe(true);
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment.enabled).toBe(false);
  });
});

describe('merge output with an attached outro', () => {
  it.skipIf(!ffmpegAvailable)('concatenates chapters numerically then the outro exactly once and leaves chapter files untouched', async () => {
    const ch1 = chapterVideo('ch1', 'red');
    const ch2 = chapterVideo('ch2', 'blue');
    const outro = outroVideo('green');
    const before = new Map([ch1, ch2, outro].map((file) => [file, {
      bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs,
    }]));
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const info = probe(full);
    // 0.4s chapters + 0.4s outro; a duplicated outro would make this 1.6s.
    expect(info.duration).toBeGreaterThan(1.1);
    expect(info.duration).toBeLessThan(1.5);
    expect(info.hasAudio).toBe(true);
    // Order: chapter 1, chapter 2, then the outro at the very end.
    expect(isRed(centerPixel(full, 0.1))).toBe(true);
    expect(isBlue(centerPixel(full, 0.5))).toBe(true);
    expect(isGreen(centerPixel(full, 0.9))).toBe(true);
    expect(isGreen(centerPixel(full, 1.15))).toBe(true);
    // The outro occupies only its own tail segment, so the midpoint is still a chapter.
    expect(isGreen(centerPixel(full, 0.2))).toBe(false);
    expect(merged.outro).toMatchObject({ included: true, targetChapter: 'ch2', position: 3 });
    expect(merged.includesOutro).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'full', 'video', 'merge.json'), 'utf8'));
    expect(manifest.includesOutro).toBe(true);
    expect(manifest.sources.filter((s: { file: string }) => s.file.endsWith(path.join('outro', 'video', 'video.mp4')))).toHaveLength(1);
    // Non-destructive: every source file is byte-identical with an unchanged mtime.
    for (const [file, snapshot] of before) {
      expect(fs.readFileSync(file)).toEqual(snapshot.bytes);
      expect(fs.statSync(file).mtimeMs).toBe(snapshot.mtimeMs);
    }
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('merges an outro with different dimensions, keeping it last', async () => {
    chapterVideo('ch1', 'red', '64x64');
    chapterVideo('ch2', 'blue', '96x48');
    outroVideo('green', '128x72');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const merged = await mergeSeriesChapters({ seriesRoot, slug });
    expect(merged.includesOutro).toBe(true);
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const info = probe(full);
    expect(info.video).toHaveLength(1);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(1.1);
    expect(isGreen(centerPixel(full, 1.15))).toBe(true);
    expect(isBlue(centerPixel(full, 0.5))).toBe(true);
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('keeps the last good compilation when the attached outro is unreadable', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await mergeSeriesChapters({ seriesRoot, slug });
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const good = fs.readFileSync(full);
    write(path.join(dir, 'out', 'outro', 'video', 'video.mp4'), 'not an mp4');
    await expect(mergeSeriesChapters({ seriesRoot, slug })).rejects.toThrow(/ffmpeg failed|readable MP4/);
    expect(fs.readFileSync(full)).toEqual(good);
    expect(fs.readdirSync(path.dirname(full)).some((f) => f.startsWith('.merge-'))).toBe(false);
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('refuses to merge silently without an attached outro whose render vanished', async () => {
    chapterVideo('ch1', 'red');
    chapterVideo('ch2', 'blue');
    const outro = outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    await mergeSeriesChapters({ seriesRoot, slug });
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const good = fs.readFileSync(full);

    // The attached render disappears (deleted with the storage drawer, or a lost volume).
    fs.rmSync(outro);
    const state = getSeriesMergeState({ seriesRoot, slug });
    expect(state.attachment).toMatchObject({ explicit: true, enabled: true, missing: true, blocked: true });
    expect(state.attachment.nextMergeIncludesOutro).toBe(false);

    // Merging must fail with an actionable 409 rather than quietly compiling chapters only.
    await expect(mergeSeriesChapters({ seriesRoot, slug })).rejects.toThrow(/attached outro video is missing/);
    await expect(mergeSeriesChapters({ seriesRoot, slug })).rejects.toMatchObject({ statusCode: 409 });
    expect(fs.readFileSync(full)).toEqual(good);
    expect(fs.readdirSync(path.dirname(full)).some((f) => f.startsWith('.merge-'))).toBe(false);

    // An explicit one-off chapters-only merge is still allowed and keeps the attachment.
    const chaptersOnly = await mergeSeriesChapters({ seriesRoot, slug, includeOutro: false });
    expect(chaptersOnly.includesOutro).toBe(false);
    expect(getSeriesMergeState({ seriesRoot, slug }).attachment).toMatchObject({ enabled: true, blocked: true });
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('merges an attached outro with mono 44.1 kHz audio and one with no audio track', async () => {
    chapterVideo('ch1', 'red');
    const outro = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
    fs.mkdirSync(path.dirname(outro), { recursive: true });
    const mono = spawnSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=green:s=128x72:r=24:d=0.4',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-t', '0.4', outro], { encoding: 'utf8', timeout: 20_000 });
    expect(mono.status, mono.stderr).toBe(0);
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const mergedMono = await mergeSeriesChapters({ seriesRoot, slug });
    expect(mergedMono.includesOutro).toBe(true);
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    expect(probe(full).hasAudio).toBe(true);
    expect(isGreen(centerPixel(full, 0.6))).toBe(true);

    // Same again with a silent-free outro: the concat demuxer has to normalise it.
    const silent = spawnSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=green:s=96x64:r=24:d=0.4',
      '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-t', '0.4', outro], { encoding: 'utf8', timeout: 20_000 });
    expect(silent.status, silent.stderr).toBe(0);
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const mergedSilent = await mergeSeriesChapters({ seriesRoot, slug });
    expect(mergedSilent.includesOutro).toBe(true);
    expect(probe(full).hasAudio).toBe(true);
    expect(isGreen(centerPixel(full, 0.6))).toBe(true);
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('rejects a merged output that lost the short attached outro tail', async () => {
    // 0.4s chapters plus a 0.4s outro: a proportional tolerance would hide the loss.
    chapterVideo('ch1', 'red');
    chapterVideo('ch2', 'blue');
    outroVideo('green');
    await setSeriesOutroAttachment({ seriesRoot, slug, enabled: true });
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const realRun = intakeMod.runCommand;
    const spy = vi.spyOn(intakeMod, 'runCommand').mockImplementation(async (cmd, opts) => {
      const isMergeConcat = path.basename(cmd[0] || '') === 'ffmpeg'
        && cmd.includes('-f') && cmd.includes('concat') && String(cmd[cmd.length - 1]).endsWith('.mp4');
      if (isMergeConcat) {
        // Produce a *valid* MP4 that only contains the chapters: the outro tail is gone.
        const target = String(cmd[cmd.length - 1]);
        const trimmed = spawnSync('ffmpeg', ['-y', '-v', 'error',
          '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=0.8',
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-t', '0.8', target], { encoding: 'utf8', timeout: 20_000 });
        return { code: trimmed.status ?? 1, stdout: '', stderr: trimmed.stderr ?? '', timedOut: false };
      }
      return realRun(cmd, opts);
    });
    try {
      await expect(mergeSeriesChapters({ seriesRoot, slug }))
        .rejects.toThrow(/segments total/);
    } finally {
      spy.mockRestore();
    }
    // Nothing was published: no full video, no leftover temp directory.
    expect(fs.existsSync(full)).toBe(false);
    expect(fs.readdirSync(path.dirname(full)).some((f) => f.startsWith('.merge-'))).toBe(false);
  }, 60_000);

});

describe('outro attachment HTTP contract', () => {
  async function startServer() {
    vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
    vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
    vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
    vi.stubEnv('PLAYER_API_ONLY', '1');
    vi.resetModules();
    const mod = await import('../src/player/server.js');
    write(path.join(root, 'users'), `admin:${mod.apr1('password', 'fixture')}\nviewer:${mod.apr1('password', 'fixture')}\n`);
    json(path.join(root, 'temp-users'), { viewer: Date.now() + 60_000 });
    const server = mod.createPlayerServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = `sr_session=${encodeURIComponent(mod.makeCookie('admin'))}`;
    const csrf = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as { csrfToken: string }).csrfToken;
    const request = (route: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(base + route, {
      method, headers: { cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}),
    });
    return { base, cookie, csrf, request, viewerCookie: `sr_session=${encodeURIComponent(mod.makeCookie('viewer'))}` };
  }

  it('requires a persistent account and CSRF, validates the body, and persists through the API', async () => {
    chapterVideo('ch1', 'red');
    outroVideo('green');
    const { request, viewerCookie } = await startServer();
    const url = `/api/series/${slug}/outro/attachment`;
    const anon = await fetch(`http://127.0.0.1:${new URL((await request('/api/session')).url).port}${url}`, { method: 'POST' });
    expect([401, 403]).toContain(anon.status);
    expect((await request(url, 'POST', { enabled: true }, { cookie: viewerCookie })).status).toBe(403);
    expect((await request(url, 'POST', { enabled: true }, { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await request(url, 'POST', { enabled: 'yes' })).status).toBe(400);
    expect((await request(url, 'GET')).status).toBe(200);
    const read = await (await request(url, 'GET')).json() as any;
    expect(read.attachment).toMatchObject({ explicit: false, nextMergeIncludesOutro: true });

    const attached = await request(url, 'POST', { enabled: true });
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({ ok: true, attachment: { enabled: true, targetChapter: 'ch1' } });
    expect(await (await request(url, 'GET')).json()).toMatchObject({ attachment: { explicit: true, enabled: true } });
    expect(await (await request(`/api/series/${slug}/merge`)).json()).toMatchObject({ includesOutro: true });

    const detached = await request(url, 'POST', { enabled: false });
    expect(detached.status).toBe(200);
    expect(await (await request(url, 'GET')).json()).toMatchObject({ attachment: { explicit: true, enabled: false } });
    expect(await (await request(`/api/series/${slug}/merge`)).json()).toMatchObject({ includesOutro: false });

    // Legacy query override still works, and an absent one keeps the saved choice.
    expect(await (await request(`/api/series/${slug}/merge?includeOutro=true`)).json()).toMatchObject({ includesOutro: true });
    expect(await (await request(`/api/series/${slug}/merge?includeOutro=false`)).json()).toMatchObject({ includesOutro: false });
  });

  it('reports a conflict for a missing outro instead of creating a broken preference', async () => {
    chapterVideo('ch1', 'red');
    const { request } = await startServer();
    const res = await request(`/api/series/${slug}/outro/attachment`, 'POST', { enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Generate the outro video') });
    expect(fs.existsSync(attachmentFile())).toBe(false);
  });
});
