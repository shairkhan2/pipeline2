import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import {
  getStorageSummary, listTmpTrash, moveToTmpTrash, purgeTmpTrash,
  restoreFromTmpTrash, storageBytes,
} from '../src/player/storageTrash.js';
import { deleteChapterVideo } from '../src/player/libraryDelete.js';
import {
  extendSeries, generateSeriesOutro, getSeriesMergeState, inspectSeriesOutro, mergeSeriesChapters,
} from '../src/player/seriesTools.js';
import {
  atomicWriteJson, controlRenderLane, createJob, getJob, getProcStartTicks, pauseJob,
  resumeJob, runWorkerOnce, stopJob,
} from '../src/intake/intake.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let root: string;
let seriesRoot: string;
let dir: string;
const slug = 'hero-story';
let servers: http.Server[] = [];
let children: ChildProcess[] = [];

function write(file: string, contents: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function json(file: string, value: unknown) { return write(file, JSON.stringify(value)); }
function video(ch: string, content = 'VIDEO-' + ch) { return write(path.join(dir, 'out', ch, 'video', 'video.mp4'), content); }
function chapter(n: number) { return write(path.join(dir, `ch${n}`, '001.png'), `PANEL-${n}`); }
function jobFile(id: string) { return path.join(root, 'out', 'jobs', `${id}.json`); }

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/studio-v2-');
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
  vi.stubEnv('MANHWA_RENDER_REMOTE', '');
  vi.stubEnv('MANHWA_RENDER_CLOUD', '');
  json(path.join(dir, 'meta.json'), { title: 'The Azure Hero', tts: { engine: 'edge' } });
});

afterEach(async () => {
  for (const child of children) {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  }
  children = [];
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('recoverable temporary trash and storage inspector', () => {
  it('accounts for series, chapter, full video, audio, panels, caches and global storage', () => {
    chapter(1);
    video('ch1');
    video('full', 'FULL');
    write(path.join(dir, 'out', 'ch1', 'audio', 'narration.mp3'), 'AUDIO');
    write(path.join(dir, 'out', 'panels', 'ch1', 'p0001_1.png'), 'SLICED');
    json(path.join(dir, 'out', 'obs_ch1.json'), { panels: [] });
    write(path.join(root, 'out', 'jobs', 'job.log'), 'JOB');
    write(path.join(root, 'out', 'jobs', 'voice-previews', 'a.mp3'), 'NESTED-PREVIEW');
    write(path.join(root, 'out', 'voice-previews', 'b.mp3'), 'PREVIEW');
    write(path.join(root, 'out', 'config', 'settings.json'), '{}');
    write(path.join(root, 'thumbs', 'hero.png'), 'THUMB');
    const trash = moveToTmpTrash(write(path.join(root, 'old-artifact'), 'OLD'), { kind: 'artifact' });
    const summary = getStorageSummary();
    expect(summary.seriesBytes).toBe(storageBytes(dir));
    expect(summary.jobsBytes).toBe(3);
    expect(summary.previewsBytes).toBe('NESTED-PREVIEWPREVIEW'.length);
    expect(summary.thumbsBytes).toBe(5);
    expect(summary.trashBytes).toBeGreaterThanOrEqual(trash.sizeBytes);
    expect(summary.totalBytes).toBe(summary.seriesBytes + summary.jobsBytes + summary.previewsBytes + summary.configBytes + summary.thumbsBytes + summary.trashBytes);
    expect(summary.series[0]).toMatchObject({ slug, title: 'The Azure Hero', videoBytes: 13, fullVideoBytes: 4, audioBytes: 5, panelsBytes: 13 });
    expect(summary.series[0].chapters).toEqual([{ ch: 'ch1', videoBytes: 9, audioBytes: 5, panelsBytes: 13, hasVideo: true }]);
    expect(summary.trash[0].id).toBe(trash.id);
  });

  it('moves chapter video to default /tmp trash and restores every byte without touching caches', async () => {
    vi.stubEnv('MANHWA_TRASH_DIR', '');
    chapter(1);
    const bytes = Buffer.from([0, 255, 2, 128, 4, 0, 9]);
    const file = write(path.join(dir, 'out', 'ch1', 'video', 'video.mp4'), bytes);
    write(file + '.done', 'complete');
    write(path.join(path.dirname(file), '.done'), 'complete');
    json(path.join(dir, 'out', 'ch1', 'report.json'), { status: 'ok', video: true, lines: 7 });
    const result = await deleteChapterVideo({ seriesRoot, slug, ch: 'ch1', procRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    try {
      expect(result.trashId).toBeTruthy();
      const item = listTmpTrash().find((t) => t.id === result.trashId)!;
      expect(item.trashPath).toBe(`/tmp/opencode/manhwa-trash/${result.trashId}/payload`);
      expect(item).toMatchObject({ kind: 'chapter-video', slug, chapter: 'ch1', sizeBytes: bytes.length, expiresNote: 'Recoverable until system reboot (/tmp)' });
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(file + '.done')).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(file), '.done'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'ch1', 'report.json'), 'utf8'))).toMatchObject({ status: 'ok', video: false, lines: 7 });
      expect(fs.readFileSync(path.join(dir, 'ch1', '001.png'), 'utf8')).toBe('PANEL-1');
      expect(restoreFromTmpTrash(result.trashId).restoredPath).toBe(file);
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(listTmpTrash().some((t) => t.id === result.trashId)).toBe(false);
    } finally {
      if (listTmpTrash().some((t) => t.id === result.trashId)) restoreFromTmpTrash(result.trashId);
    }
  });

  it('purges one item or all items and refuses restore collisions and traversal', () => {
    const first = moveToTmpTrash(write(path.join(root, 'one'), '123'), { kind: 'artifact' });
    const second = moveToTmpTrash(write(path.join(root, 'two'), '4567'), { kind: 'artifact' });
    write(first.originalPath, 'new');
    expect(() => restoreFromTmpTrash(first.id)).toThrow('already exists');
    expect(fs.readFileSync(first.trashPath, 'utf8')).toBe('123');
    expect(() => restoreFromTmpTrash('../other')).toThrow('Invalid trash ID');
    expect(purgeTmpTrash(first.id)).toEqual({ ok: true, purgedCount: 1, freedBytes: 3 });
    expect(listTmpTrash().map((t) => t.id)).toEqual([second.id]);
    expect(purgeTmpTrash()).toEqual({ ok: true, purgedCount: 1, freedBytes: 4 });
    expect(listTmpTrash()).toEqual([]);
  });

  it('does not follow symlinks or remove videos with live render scratch', async () => {
    const outside = write(path.join(root, 'outside'), 'KEEP');
    fs.symlinkSync(outside, path.join(dir, 'linked.mp4'));
    expect(() => moveToTmpTrash(path.join(dir, 'linked.mp4'), { kind: 'artifact' })).toThrow('symbolic link');
    const file = video('ch1');
    write(file + '.part', 'busy');
    expect(await deleteChapterVideo({ seriesRoot, slug, ch: 'ch1', procRoot: root })).toMatchObject({ ok: false, status: 409, code: 'render_in_progress' });
    expect(listTmpTrash()).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('KEEP');
  });
});

function characterFixture() {
  chapter(1);
  json(path.join(dir, 'out', 'bible.json'), { characters: {
    hero: { name: 'Jin', role: 'main protagonist', visual: 'Blue-haired swordsman', aliases: ['Azure Blade'] },
    friend: { name: 'Mira', role: 'ally', visual: 'Silver-haired mage' },
  } });
  for (const name of ['wide', 'hero', 'mira', 'credit', 'skip', 'system']) write(path.join(dir, 'out', 'panels', 'ch1', `${name}.png`), 'IMAGE-' + name);
  json(path.join(dir, 'out', 'obs_ch1.json'), { data: { panels: [
    { id: 'wide', visual: 'A distant empty castle', shot: 'wide', weight: 10 },
    { id: 'hero', characters: ['Jin'], framing: 'closeup', weight: 7, kind: 'narrative' },
    { id: 'mira', visual: 'Mira raises her staff', shot: 'medium', weight: 8 },
    { id: 'credit', characters: ['Jin'], framing: 'closeup', kind: 'credit', weight: 10 },
    { id: 'skip', characters: ['Jin'], framing: 'closeup', skip: true },
    { id: 'system', characters: ['Jin'], framing: 'closeup', kind: 'system' },
  ] } });
}

describe('character-panel outros', () => {
  it('prefers named characters, closeup/medium framing, and filters credit/system/skipped panels', () => {
    characterFixture();
    const state = inspectSeriesOutro({ seriesRoot, slug });
    expect(state.selectedPanels[0]).toMatchObject({ chapter: 'ch1', characterNames: ['Jin'], reason: expect.stringContaining('closeup') });
    expect(state.selectedPanels[1].characterNames).toEqual(['Mira']);
    expect(state.selectedPanels.map((p) => path.basename(p.panelFile))).toEqual(['hero.png', 'mira.png', 'wide.png']);
    expect(state.characters[0]).toMatchObject({ name: 'Jin', description: 'Blue-haired swordsman' });
    expect(state.selectedPanels[0].previewUrl).toContain(`/api/series/${slug}/panels/`);
  });

  it('writes contextual Part 2 and Next Chapter scripts and a panel-referenced plan', async () => {
    characterFixture();
    const part2 = await generateSeriesOutro({ seriesRoot, slug, totalChapters: 50, coveredChapters: 20, hookType: 'part2', renderVideo: false });
    expect(part2.script).toContain('first 20 chapters out of 50 in The Azure Hero');
    expect(part2.script).toContain('Jin and Mira');
    expect(part2.script).toContain('Part 2');
    expect(part2.selectedPanels[0].characterNames).toEqual(['Jin']);
    expect(fs.readFileSync(path.join(dir, 'out', 'outro', 'script.md'), 'utf8')).toBe(part2.script + '\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'outro', 'shots.json'), 'utf8')).selectedPanels).toEqual(part2.selectedPanels);
    const next = await generateSeriesOutro({ seriesRoot, slug, totalChapters: 50, coveredChapters: 20, hookType: 'next_chapter', renderVideo: false });
    expect(next.script).toContain('chapter 21 of The Azure Hero');
    const custom = await generateSeriesOutro({ seriesRoot, slug, hookType: 'custom', customNote: 'Tell us your favorite battle!', renderVideo: false });
    expect(custom.script).toContain('Tell us your favorite battle!');
    expect(inspectSeriesOutro({ seriesRoot, slug }).plan?.hookType).toBe('custom');
    await expect(generateSeriesOutro({ seriesRoot, slug, totalChapters: 2, coveredChapters: 3 })).rejects.toThrow('cannot be smaller');
  });

  it('falls back to middle narrative images when no observations exist', () => {
    for (let i = 1; i <= 5; i++) write(path.join(dir, 'ch1', `${i}.png`), 'IMAGE');
    const panels = inspectSeriesOutro({ seriesRoot, slug }).selectedPanels;
    expect(panels[0].panelFile).toBe('ch1/3.png');
    expect(panels.every((p) => !['1.png', '5.png'].includes(path.basename(p.panelFile)))).toBe(true);
    expect(panels[0].reason).toContain('observations not available');
  });

  it.skipIf(!ffmpegAvailable)('renders a watchable character-panel showcase', async () => {
    characterFixture();
    const image = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#336699' } }).png().toBuffer();
    for (const name of ['hero', 'mira', 'wide']) write(path.join(dir, 'out', 'panels', 'ch1', `${name}.png`), image);
    const result = await generateSeriesOutro({ seriesRoot, slug, renderVideo: true, synthesizeAudio: false });
    expect(result.renderError).toBeNull();
    expect(result.rendered).toBe(true);
    expect(fs.statSync(path.join(dir, 'out', 'outro', 'video', 'video.mp4')).size).toBeGreaterThan(100);
    expect(getSeriesMergeState({ seriesRoot, slug }).includesOutro).toBe(true);
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('synthesizes narration through the existing external TTS protocol and fits the showcase to its duration', async () => {
    characterFixture();
    const image = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#336699' } }).png().toBuffer();
    for (const name of ['hero', 'mira', 'wide']) write(path.join(dir, 'out', 'panels', 'ch1', `${name}.png`), image);
    const audio = path.join(root, 'fixture.mp3');
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', audio], { encoding: 'utf8' });
    expect(generated.status, generated.stderr).toBe(0);
    const capture = path.join(root, 'tts-request.json');
    const adapter = write(path.join(root, 'adapter.cjs'), `const fs = require('node:fs'); const req = JSON.parse(fs.readFileSync(0, 'utf8')); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(req)); fs.copyFileSync(${JSON.stringify(audio)}, req.output_path);`);
    json(path.join(dir, 'meta.json'), { title: 'The Azure Hero', tts: { engine: 'external', voice_id: 'fixture', command: [process.execPath, adapter] } });
    const result = await generateSeriesOutro({ seriesRoot, slug, totalChapters: 50, coveredChapters: 20 });
    expect(result.audioError).toBeNull();
    expect(result.rendered).toBe(true);
    expect(result.audioUrl).toBe(`/media/${slug}/outro/audio.mp3`);
    const request = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(request).toMatchObject({ protocol: 'manhwa-tts-v1', voice_id: 'fixture', text: expect.stringContaining('first 20 chapters out of 50') });
    expect(fs.readFileSync(path.join(dir, 'out', 'outro', 'audio', 'narration.mp3'))).toEqual(fs.readFileSync(audio));
    const shots = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'outro', 'shots.json'), 'utf8'));
    expect(shots.duration).toBeGreaterThanOrEqual(0.5);
    expect(shots.duration).toBeLessThan(1);
  }, 30_000);
});

function renderTestVideo(ch: string, color: string, size = '64x64') {
  const file = path.join(dir, 'out', ch, 'video', 'video.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=0.25`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '0.25', file], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  return file;
}

describe('one-click chapter merge', () => {
  it.skipIf(!ffmpegAvailable)('merges chapters numerically and optionally includes the outro', async () => {
    renderTestVideo('ch2', 'blue');
    renderTestVideo('ch1', 'red');
    const first = await mergeSeriesChapters({ seriesRoot, slug });
    expect(first).toMatchObject({ ok: true, merged: true, chaptersMerged: ['ch1', 'ch2'], includesOutro: false, downloadUrl: `/media/${slug}/full.mp4` });
    expect(first.sizeBytes).toBeGreaterThan(100);
    expect(first.duration).toBeGreaterThanOrEqual(0.5);
    expect(fs.existsSync(path.join(dir, 'out', 'full', 'video', 'video.mp4'))).toBe(true);
    expect(getSeriesMergeState({ seriesRoot, slug })).toMatchObject({ merged: true, stale: false });
    renderTestVideo('outro', 'green');
    expect(getSeriesMergeState({ seriesRoot, slug }).stale).toBe(true);
    expect((await mergeSeriesChapters({ seriesRoot, slug })).includesOutro).toBe(true);
    expect((await mergeSeriesChapters({ seriesRoot, slug, includeOutro: false })).includesOutro).toBe(false);
  }, 30_000);

  it.skipIf(!ffmpegAvailable)('re-encodes differing stream parameters and preserves the last full video on failure', async () => {
    renderTestVideo('ch1', 'red');
    renderTestVideo('ch2', 'blue', '96x64');
    const result = await mergeSeriesChapters({ seriesRoot, slug });
    expect(result.merged).toBe(true);
    const full = path.join(dir, 'out', 'full', 'video', 'video.mp4');
    const before = fs.readFileSync(full);
    video('ch1', 'not an mp4');
    await expect(mergeSeriesChapters({ seriesRoot, slug })).rejects.toThrow('ffmpeg failed');
    expect(fs.readFileSync(full)).toEqual(before);
    expect(fs.readdirSync(path.dirname(full)).some((f) => f.startsWith('.merge-'))).toBe(false);
  }, 30_000);
});

describe('extend existing series without rerunning completed chapters', () => {
  it('queues only ch3..ch4 and preserves completed videos and bible byte-for-byte', async () => {
    for (let n = 1; n <= 4; n++) chapter(n);
    const first = video('ch1');
    const second = video('ch2');
    const bible = write(path.join(dir, 'out', 'bible.json'), '{"characters":{"Jin":{"name":"Jin"}}}');
    const result = await extendSeries({ seriesRoot, slug, chapters: '1-4', spawnWorker: false });
    expect(result).toMatchObject({ ok: true, queued: true, chapters: '3-4', completedChapters: ['ch1', 'ch2'] });
    const persisted = JSON.parse(fs.readFileSync(jobFile(String(result.job!.id)), 'utf8'));
    expect(persisted).toMatchObject({ chapters: '3-4', runChapters: [3, 4], skipIngest: true, onlyUnrendered: true });
    expect(fs.readFileSync(first, 'utf8')).toBe('VIDEO-ch1');
    expect(fs.readFileSync(second, 'utf8')).toBe('VIDEO-ch2');
    expect(fs.readFileSync(bible, 'utf8')).toBe('{"characters":{"Jin":{"name":"Jin"}}}');
    await expect(extendSeries({ seriesRoot, slug, spawnWorker: false })).rejects.toThrow('active/queued');
  });

  it('imports only new ZIP chapters and never overwrites existing pages, outputs or bible', async () => {
    chapter(1); chapter(2); video('ch1'); video('ch2');
    const bible = write(path.join(dir, 'out', 'bible.json'), 'PRESERVE-BIBLE');
    const archive = new AdmZip();
    for (const n of [1, 2, 3, 4]) archive.addFile(`ch${n}/001.png`, Buffer.from(`NEW-PAGE-${n}`));
    const zipPath = path.join(root, 'new.zip');
    archive.writeZip(zipPath);
    const result = await extendSeries({ seriesRoot, slug, zipPath, spawnWorker: false });
    expect(result.chapters).toBe('3-4');
    expect(fs.readFileSync(path.join(dir, 'ch1', '001.png'), 'utf8')).toBe('PANEL-1');
    expect(fs.readFileSync(path.join(dir, 'ch3', '001.png'), 'utf8')).toBe('NEW-PAGE-3');
    expect(fs.readFileSync(bible, 'utf8')).toBe('PRESERVE-BIBLE');
  });

  it('returns no job when every chapter already has a video', async () => {
    chapter(1); video('ch1');
    expect(await extendSeries({ seriesRoot, slug, spawnWorker: false })).toMatchObject({ ok: true, queued: false, job: null });
  });
});

describe('live job and lane controls', () => {
  it('pauses queued jobs and resumes them without spawning a worker when disabled', async () => {
    chapter(1);
    const job = await createJob({ slug, chapters: '1', spawnWorker: false });
    expect(pauseJob(String(job.id))).toMatchObject({ status: 'paused', paused: true, controlActions: ['resume', 'stop', 'cancel', 'settings'] });
    expect(resumeJob(String(job.id))).toMatchObject({ status: 'queued', paused: false });
    expect(stopJob(String(job.id))).toMatchObject({ status: 'interrupted', paused: false });
    expect(() => resumeJob(String(job.id))).toThrow('not paused');
  });

  it('sends SIGSTOP/SIGCONT to a live run and refuses recycled PIDs', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    const id = 'job-1234-aabbccdd';
    const ticks = getProcStartTicks(child.pid)!;
    atomicWriteJson(jobFile(id), { schemaVersion: 1, id, slug, status: 'running', runPid: child.pid, runStartTicks: ticks, runProcessGroup: true });
    expect(pauseJob(id)).toMatchObject({ status: 'running', paused: true });
    await vi.waitFor(() => expect(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1][0]).toBe('T'));
    expect(resumeJob(id)).toMatchObject({ status: 'running', paused: false });
    await vi.waitFor(() => expect(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1][0]).not.toBe('T'));
    const raw = JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    raw.runStartTicks = ticks + 1;
    atomicWriteJson(jobFile(id), raw);
    expect(() => pauseJob(id)).toThrow('no longer alive');
  });

  it('refuses lane-wide control and leaves every job untouched', async () => {
    chapter(1);
    const job = await createJob({ slug, chapters: '1', spawnWorker: false });
    const before = fs.readFileSync(jobFile(String(job.id)), 'utf8');
    for (const action of ['pause', 'resume', 'stop'] as const) {
      const result = controlRenderLane('local', action);
      expect(result).toMatchObject({
        ok: false, supported: false, statusCode: 409, laneId: 'local', action, affectedJobs: [],
      });
      expect(String(result.error)).toMatch(/run/i);
    }
    // No job mutation, no lane-controls.json side effect.
    expect(fs.readFileSync(jobFile(String(job.id)), 'utf8')).toBe(before);
    expect(getJob(String(job.id))).toMatchObject({ status: 'queued', paused: false });
    expect(fs.existsSync(path.join(root, 'out', 'config', 'lane-controls.json'))).toBe(false);
    // A legacy lane-controls.json can no longer hold queued jobs.
    json(path.join(root, 'out', 'config', 'lane-controls.json'), { schemaVersion: 1, lanes: { local: { paused: true, updatedAt: 1 } } });
    expect(getJob(String(job.id))).toMatchObject({ status: 'queued' });
    const result = await runWorkerOnce({ runCmdOverride: [process.execPath, '-e', 'process.exit(0)', '--'] });
    expect(result.processed).toBe(1);
    expect(getJob(String(job.id))).not.toMatchObject({ status: 'queued' });
  });

  it('keeps live control state across worker progress writes and stops its process group', async () => {
    chapter(1);
    const job = await createJob({ slug, chapters: '1', spawnWorker: false });
    const task = runWorkerOnce({ runCmdOverride: [process.execPath, '-e', 'setInterval(() => console.log("progress"), 30)', '--'] });
    let pid = 0;
    try {
      await vi.waitFor(() => {
        const raw = JSON.parse(fs.readFileSync(jobFile(String(job.id)), 'utf8'));
        expect(raw.runPid).toBeGreaterThan(0);
        pid = raw.runPid;
      }, { timeout: 10_000 });
      pauseJob(String(job.id));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // New runs pause cooperatively: the request waits for the next safe point.
      expect(getJob(String(job.id))).toMatchObject({ pauseRequested: true, paused: false, status: 'running' });
      resumeJob(String(job.id));
      expect(stopJob(String(job.id))).toMatchObject({ status: 'interrupted' });
      await task;
      expect(getJob(String(job.id))).toMatchObject({ status: 'interrupted', paused: false });
    } finally {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
      await task;
    }
  }, 20_000);
});

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

describe('Studio V2 HTTP boundaries', () => {
  it('reads, edits and resets prompts; reads and updates settings with CSRF and privilege checks', async () => {
    const { request, viewerCookie } = await startServer();
    const prompts = await (await request('/api/studio/prompts')).json() as any;
    expect(prompts.prompts.reader.content).toBeTruthy();
    const edited = await request('/api/studio/prompts', 'PUT', { expectedRevision: prompts.revision, prompts: { reader: 'Custom reader brief' }, preserveCacheHashes: true });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ preserveCacheHashes: true, prompts: { reader: { content: 'Custom reader brief', isCustom: true } } });
    const reset = await request('/api/studio/prompts/reset', 'POST', { stage: 'reader' });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ prompts: { reader: { content: prompts.defaults.reader, isCustom: false } } });
    const settings = await (await request('/api/studio/settings')).json() as any;
    expect(settings.defaultRenderLane).toBe('inherit');
    const changed = await request('/api/studio/settings', 'PUT', { expectedRevision: settings.revision, renderQuality: '720p' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ renderQuality: '720p', defaultRenderLane: 'inherit' });
    expect((await request('/api/studio/settings', 'PUT', { renderQuality: '1080p' }, { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await request('/api/studio/prompts', 'PUT', {}, { cookie: viewerCookie })).status).toBe(403);
    expect((await request('/api/studio/settings', 'PUT', { renderQuality: 'bad' })).status).toBe(400);
    // Lane validation: built-ins and registered nodes only.
    const laneSet = await request('/api/studio/settings', 'PUT', { defaultRenderLane: 'local' });
    expect(laneSet.status).toBe(200);
    expect(await laneSet.json()).toMatchObject({ defaultRenderLane: 'local' });
    expect((await request('/api/studio/settings', 'PUT', { defaultRenderLane: 'not-a-lane' })).status).toBe(400);
    expect((await request('/api/studio/settings', 'PUT', { defaultRenderLane: '../etc' })).status).toBe(400);
    expect((await request('/api/studio/settings', 'PUT', { defaultRenderLane: 42 })).status).toBe(400);
    // An omitted field keeps the stored lane; explicit inherit resets it.
    const kept = await request('/api/studio/settings', 'PUT', { renderQuality: '720p' });
    expect(await kept.json()).toMatchObject({ defaultRenderLane: 'local' });
    const inherited = await request('/api/studio/settings', 'PUT', { defaultRenderLane: 'inherit' });
    expect(await inherited.json()).toMatchObject({ defaultRenderLane: 'inherit' });
  });

  it('publishes defaultRenderQuality and defaultRenderLane on the intake catalog', async () => {
    const { request } = await startServer();
    const catalog = await (await request('/api/intake/catalog')).json() as any;
    expect(catalog.defaultRenderQuality).toBe('1080p');
    expect(catalog.defaultRenderLane).toBe('inherit');
    await request('/api/studio/settings', 'PUT', { renderQuality: '720p', defaultRenderLane: 'local' });
    const updated = await (await request('/api/intake/catalog')).json() as any;
    expect(updated.defaultRenderQuality).toBe('720p');
    expect(updated.defaultRenderLane).toBe('local');
  });

  it('exposes job pause/resume/stop only to privileged CSRF-checked requests and retires lane control', async () => {
    chapter(1);
    const job = await createJob({ slug, chapters: '1', spawnWorker: false });
    const { request, viewerCookie } = await startServer();
    const url = `/api/intake/jobs/${job.id}`;
    expect((await request(url + '/pause', 'POST', {}, { 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await request(url + '/pause', 'POST', {}, { cookie: viewerCookie })).status).toBe(403);
    expect(await (await request(url + '/pause', 'POST')).json()).toMatchObject({ job: { status: 'paused', paused: true } });
    expect(await (await request(url + '/resume', 'POST')).json()).toMatchObject({ job: { status: 'queued', paused: false } });
    // The legacy lane route answers 409 and never touches the queued job.
    const lane = await request('/api/studio/lanes/control', 'POST', { laneId: 'local', action: 'pause' });
    expect(lane.status).toBe(409);
    expect(await lane.json()).toMatchObject({ ok: false, supported: false, affectedJobs: [] });
    expect(getJob(String(job.id))).toMatchObject({ status: 'queued', paused: false });
    expect((await request('/api/studio/lanes/control', 'POST', { laneId: 'local', action: 'invalid' })).status).toBe(400);
    expect((await request(url + '/stop', 'POST')).status).toBe(200);
  });

  it('exposes storage deletion, listing, restore and purge while refusing arbitrary host paths', async () => {
    const file = video('ch1');
    const { request } = await startServer();
    expect((await request('/api/studio/storage')).status).toBe(200);
    const removed = await request('/api/studio/storage/delete', 'POST', { kind: 'chapter-video', slug, chapter: 'ch1' });
    expect(removed.status).toBe(200);
    const result = await removed.json() as any;
    const trash = await (await request('/api/studio/storage/trash')).json() as any;
    expect(trash.trash[0].id).toBe(result.trashId);
    expect((await request('/api/studio/storage/restore', 'POST', { trashId: result.trashId })).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('VIDEO-ch1');
    expect((await request('/api/studio/storage/delete', 'POST', { kind: 'artifact', path: '/etc/passwd' })).status).toBe(400);
    const again = await (await request('/api/studio/storage/delete', 'POST', { kind: 'chapter-video', slug, chapter: 'ch1' })).json() as any;
    expect(await (await request('/api/studio/storage/purge', 'POST', { trashId: again.trashId })).json()).toMatchObject({ ok: true, purgedCount: 1 });
  });

  it('serves selected panel previews and queues extensions through series routes', async () => {
    characterFixture();
    chapter(2); chapter(3); chapter(4); video('ch1'); video('ch2');
    const { request } = await startServer();
    const state = await (await request(`/api/series/${slug}/outro`)).json() as any;
    expect((await request(state.selectedPanels[0].previewUrl)).status).toBe(200);
    expect((await request(`/api/series/${slug}/outro`, 'POST', { coveredChapters: 2, totalChapters: 4, renderVideo: false })).status).toBe(200);
    expect((await request(`/api/series/${slug}/merge`)).status).toBe(200);
    const extended = await request(`/api/series/${slug}/extend`, 'POST', { chapters: '1-4' });
    expect(extended.status).toBe(201);
    expect(await extended.json()).toMatchObject({ queued: true, chapters: '3-4', job: { chapters: '3-4' } });
  });
});
