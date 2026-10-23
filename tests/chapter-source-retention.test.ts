/**
 * Chapter-source retention and existing-series extension.
 *
 * Root cause covered here: a New Series job for a ch1-5 ZIP that selects ch1 used
 * to extract only ch1 and then delete the whole source ZIP, so "Add chapters 2-5"
 * later had no source at all and failed with "Chapter folders are missing".
 *
 * Offline only: every job runner is a stub process, every Drive download is a
 * local file copy, and all writes live under /tmp/opencode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';

import {
  continueJob, enqueueJob, executeSingleJob, existingChapterNumbers, findRecoverableSeriesSource,
  reconcileJobs, reconcileOrphans, retryJob,
} from '../src/intake/intake.js';
import * as sourceArchive from '../src/intake/sourceArchive.js';
import {
  findRetainedSourceForChapters, listRetainedSources, planRetainedExtraction,
  retainSourceArchive, seriesSourceDir,
} from '../src/intake/sourceArchive.js';
import { extendSeries } from '../src/player/seriesTools.js';

const TMP = '/tmp/opencode';
const SLUG = 'retained-hero';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let root: string;
let env: Record<string, string>;
let seriesDir: string;
let jobsDir: string;
let uploadsDir: string;

function makeEnv(): Record<string, string> {
  return {
    MANHWA_JOBS_DIR: jobsDir,
    MANHWA_SERIES_ROOT: path.join(root, 'series'),
    MANHWA_OUT_DIR: path.join(root, 'out'),
    MANHWA_TTS_CATALOG: path.join(root, 'catalog-edge.json'),
    MANHWA_NO_AUTO_WORKER: '1',
    MANHWA_RENDER_REMOTE: '',
    MANHWA_RENDER_CLOUD: '',
    PIPELINE_LOG: path.join(root, 'out', 'pipeline.log'),
    PATH: process.env.PATH ?? '',
  };
}

/** A chapter ZIP whose folder layout carries every requested chapter number. */
function chapterZip(file: string, chapters: number[], tag = 'PAGE'): string {
  const zip = new AdmZip();
  for (const n of chapters) zip.addFile(`ch${n}/001.png`, Buffer.from(`${tag}-${n}`));
  zip.writeZip(file);
  return file;
}

function writeFile(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Stub runner: a Node process that exits with `code` and ignores pipeline args. */
function runner(code = 0): string {
  const file = path.join(root, `runner-${code}.mjs`);
  writeFile(file, `process.stdout.write('== ch1: STUB\\n');\nprocess.exit(${code});\n`);
  return file;
}

function jobFile(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), 'utf8'));
}

function craftJob(patch: Record<string, unknown> = {}): string {
  const id = `job-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const now = Date.now() / 1000;
  const record: Record<string, unknown> = {
    schemaVersion: 1, id, slug: SLUG, title: 'Retained Hero', status: 'failed', statusNote: '',
    sourceType: 'gdrive', sourceSummary: 'Google Drive ZIP (file ID: LEGACYDRI VE01)',
    gdriveFileId: null, stagedZipPath: null, chapters: '1', runChapters: [1], ingestedChapters: ['ch1'],
    skipIngest: true, allowExistingSeries: true,
    tts: { providerId: 'edge', providerLabel: 'Edge', engine: 'edge', voiceId: 'v', voiceLabel: 'V', metaTts: { engine: 'edge' } },
    visuals: { background: 'starfield', motion: 'cut' }, renderLane: 'inherit',
    createdBy: 'tests', createdAt: now, updatedAt: now, startedAt: null, endedAt: now,
    workerPid: null, workerStartTicks: null, runPid: null, runStartTicks: null,
    error: 'boom', logTail: [],
    ...patch,
  };
  fs.mkdirSync(jobsDir, { recursive: true });
  writeFile(path.join(jobsDir, `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}

function seedSeries(chapters: number[], opts: { bible?: string; videos?: number[] } = {}): void {
  fs.mkdirSync(seriesDir, { recursive: true });
  writeFile(path.join(seriesDir, 'meta.json'), JSON.stringify({ title: 'Retained Hero', tts: { engine: 'edge' } }));
  for (const n of chapters) writeFile(path.join(seriesDir, `ch${n}`, '001.png'), `PANEL-${n}`);
  for (const n of opts.videos ?? []) writeFile(path.join(seriesDir, 'out', `ch${n}`, 'video', 'video.mp4'), `VIDEO-ch${n}`);
  if (opts.bible) writeFile(path.join(seriesDir, 'out', 'bible.json'), opts.bible);
}

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  root = fs.mkdtempSync(path.join(TMP, 'chapter-source-'));
  jobsDir = path.join(root, 'out', 'jobs');
  uploadsDir = path.join(jobsDir, 'uploads');
  seriesDir = path.join(root, 'series', SLUG);
  fs.mkdirSync(uploadsDir, { recursive: true });
  writeFile(path.join(root, 'catalog-edge.json'), JSON.stringify({ providers: [] }));
  env = makeEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('retained source: new series keeps the whole archive', () => {
  it('extracts only ch1 of a ch1-5 upload, keeps the archive, then extends 2-5 with no URL or ZIP', async () => {
    const zip = chapterZip(path.join(root, 'source.zip'), [1, 2, 3, 4, 5]);
    const queued = await enqueueJob({
      title: 'Retained Hero', slug: SLUG, zipPath: zip, sourceType: 'upload',
      chapters: '1', env: env as never, spawnWorker: false,
    });
    const jobId = String(queued.id);

    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, runner(0)],
    });

    // Only the selected chapter was rendered/imported...
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
    expect(jobFile(jobId).status).toBe('completed');
    // ...but the staging upload is gone while the series owns the full archive.
    expect(fs.existsSync(path.join(uploadsDir, `${jobId}.zip`))).toBe(false);
    const retained = listRetainedSources(seriesDir);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.chapters).toEqual([1, 2, 3, 4, 5]);
    expect(retained[0]!.sourceType).toBe('upload');

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
      spawnWorker: false, env: env as never,
    });
    expect(extended).toMatchObject({ ok: true, queued: true, chapters: '2-5' });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3, 4, 5]);
    expect(fs.readFileSync(path.join(seriesDir, 'ch1', '001.png'), 'utf8')).toBe('PAGE-1');
    // Extension imports come from the retained archive; no second archive appears.
    expect(listRetainedSources(seriesDir)).toHaveLength(1);
  });

  it('a Drive new-series job downloads once, retains the archive and can extend offline afterwards', async () => {
    const zip = chapterZip(path.join(root, 'drive.zip'), [1, 2, 3]);
    const queued = await enqueueJob({
      title: 'Retained Hero', slug: SLUG,
      gdriveUrl: 'https://drive.google.com/file/d/DRIVEFILE123456/view',
      chapters: '1', env: env as never, spawnWorker: false,
    });
    const jobId = String(queued.id);
    const download = vi.fn(async (_fileId: string, dest: string) => {
      fs.copyFileSync(zip, dest);
      return { path: dest, bytes: fs.statSync(dest).size, totalBytes: null };
    });

    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, downloadFn: download, runCmdOverride: [process.execPath, runner(0)],
    } as never);

    expect(download).toHaveBeenCalledTimes(1);
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
    const retained = listRetainedSources(seriesDir);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ sourceType: 'gdrive', gdriveFileId: 'DRIVEFILE123456' });
    expect(retained[0]!.chapters).toEqual([1, 2, 3]);
    // The downloaded staging ZIP is released once the series owns a copy.
    expect(fs.existsSync(path.join(uploadsDir, `${jobId}.zip`))).toBe(false);

    // Extension must not touch the network at all.
    const noNetwork = vi.fn(async () => { throw new Error('network must not be used'); });
    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-3',
      spawnWorker: false, env: env as never, downloadFn: noNetwork as never,
    });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(extended).toMatchObject({ queued: true, chapters: '2-3' });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3]);
  });

  it('keeps a staging ZIP when the ingest fails before retention, so retry can still import', async () => {
    const zip = chapterZip(path.join(root, 'broken-run.zip'), [1, 2]);
    const queued = await enqueueJob({
      title: 'Retained Hero', slug: SLUG, zipPath: zip, sourceType: 'upload',
      chapters: '1', env: env as never, spawnWorker: false,
    });
    const jobId = String(queued.id);
    const staged = path.join(uploadsDir, `${jobId}.zip`);
    // Corrupt the staged upload after enqueue: ingest now fails before any archive
    // is retained, and the ZIP is still the only copy of ch2.
    fs.writeFileSync(staged, 'not a zip');
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, runner(1)],
    } as never);
    const failed = jobFile(jobId);
    expect(failed.status).toBe('failed');
    expect(String(failed.stagedZipPath)).toBe(staged);
    expect(fs.existsSync(staged)).toBe(true);
    expect(listRetainedSources(seriesDir)).toEqual([]);
  });

  it('releases the staging ZIP only after the archive is retained', async () => {
    const zip = chapterZip(path.join(root, 'retained-run.zip'), [1, 2]);
    const queued = await enqueueJob({
      title: 'Retained Hero', slug: SLUG, zipPath: zip, sourceType: 'upload',
      chapters: '1', env: env as never, spawnWorker: false,
    });
    const jobId = String(queued.id);
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, runner(1)],
    } as never);
    // A failed run with no chapter report gets one delayed auto-retry; it never
    // reruns at once, and it needs no re-import because the archive is retained.
    expect(jobFile(jobId)).toMatchObject({ status: 'queued', skipIngest: true, autoRetry: { count: 1 } });
    expect(Number(jobFile(jobId).notBefore)).toBeGreaterThan(Date.now() / 1000);
    // Ingest succeeded, so the durable copy exists and the staging upload may go.
    expect(listRetainedSources(seriesDir)[0]!.chapters).toEqual([1, 2]);
    expect(fs.existsSync(path.join(uploadsDir, `${jobId}.zip`))).toBe(false);
    expect(jobFile(jobId).stagedZipPath).toBeNull();
  });

  it('reconcile keeps an interrupted ingest ZIP but still drops an aborted download part', () => {
    const ingestZip = path.join(uploadsDir, 'job-1-aaaaaaaa.zip');
    const downloadZip = path.join(uploadsDir, 'job-2-bbbbbbbb.zip');
    writeFile(ingestZip, 'PK');
    writeFile(downloadZip, 'PK');
    const ingestId = craftJob({ status: 'ingesting', workerPid: 999_999_998, stagedZipPath: ingestZip });
    const downloadId = craftJob({ status: 'downloading', workerPid: 999_999_998, stagedZipPath: downloadZip });
    const jobs = reconcileJobs(env as never);
    expect(jobs.find((j) => j.id === ingestId)!.status).toBe('interrupted');
    expect(fs.existsSync(ingestZip)).toBe(true);
    expect(jobs.find((j) => j.id === downloadId)!.status).toBe('interrupted');
    expect(fs.existsSync(downloadZip)).toBe(false);
  });
});

describe('retained source: legacy series recovery', () => {
  it('re-downloads a saved Drive file id for an older series, imports and retains it', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    const zip = chapterZip(path.join(root, 'legacy-drive.zip'), [1, 2, 3, 4, 5]);
    craftJob({
      status: 'completed', sourceType: 'gdrive', gdriveFileId: 'LEGACYFILE123456',
      stagedZipPath: null, chapters: '1', runChapters: [1],
    });
    const download = vi.fn(async (_fileId: string, dest: string) => {
      fs.copyFileSync(zip, dest);
      return { path: dest, bytes: fs.statSync(dest).size, totalBytes: null };
    });

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
      spawnWorker: false, env: env as never, downloadFn: download as never,
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toBe('LEGACYFILE123456');
    expect(extended).toMatchObject({ queued: true, chapters: '2-5', completedChapters: ['ch1'] });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3, 4, 5]);
    // Completed work is untouched and the recovered ZIP is now durable.
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4'), 'utf8')).toBe('VIDEO-ch1');
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
    expect(listRetainedSources(seriesDir)[0]).toMatchObject({ gdriveFileId: 'LEGACYFILE123456' });

    // A second extension never downloads again once the source is retained.
    const firstJobId = String((extended.job as Record<string, unknown>).id);
    const finished = jobFile(firstJobId);
    finished.status = 'completed';
    fs.writeFileSync(path.join(jobsDir, `${firstJobId}.json`), JSON.stringify(finished, null, 2));
    const again = vi.fn(async () => { throw new Error('network must not be used'); });
    const second = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
      spawnWorker: false, env: env as never, downloadFn: again as never,
    });
    expect(again).not.toHaveBeenCalled();
    expect(second).toMatchObject({ ok: true, queued: true });
    expect(listRetainedSources(seriesDir)).toHaveLength(1);
  });

  it('turns an undownloadable saved Drive source into an actionable re-upload request', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    craftJob({ status: 'completed', sourceType: 'gdrive', gdriveFileId: 'GONEFILE12345678', stagedZipPath: null });
    const download = vi.fn(async () => { throw new Error('Google Drive download failed (404)'); });

    await expect(extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
      spawnWorker: false, env: env as never, downloadFn: download as never,
    })).rejects.toThrow(/saved Google Drive source .*GONEFILE12345678.*can no longer be downloaded.*Re-add/s);

    // Nothing was mutated: no chapters, no archive, completed work intact.
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
    expect(listRetainedSources(seriesDir)).toEqual([]);
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
  });

  it('a series with no saved source at all explains what to do instead of "chapter folders are missing"', async () => {
    seedSeries([1], { videos: [1] });
    let message = '';
    try {
      await extendSeries({
        seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
        spawnWorker: false, env: env as never,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/no saved source archive/);
    expect(message).toMatch(/Re-add these chapters/);
    expect(message).toMatch(/completed videos, bible and caches are preserved/);
    expect(message).not.toMatch(/^Chapter folders are missing/);
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
  });

  it('reuses a still-staged legacy job ZIP and retains it for later extensions', async () => {
    seedSeries([1], { videos: [1] });
    const staged = chapterZip(path.join(uploadsDir, 'legacy.zip'), [1, 2, 3]);
    craftJob({ status: 'completed', sourceType: 'upload', stagedZipPath: staged });

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-3',
      spawnWorker: false, env: env as never,
    });
    expect(extended).toMatchObject({ queued: true, chapters: '2-3' });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3]);
    expect(listRetainedSources(seriesDir)).toHaveLength(1);
    expect(fs.existsSync(staged)).toBe(true);
  });
});

describe('retained source: explicit and extension-supplied archives', () => {
  it('imports only new chapters from an explicit extension ZIP and retains it without replacing the first archive', async () => {
    seedSeries([1, 2], { videos: [1, 2], bible: 'PRESERVE-BIBLE' });
    const first = chapterZip(path.join(root, 'first.zip'), [1, 2]);
    retainSourceArchive(seriesDir, first, { sourceType: 'upload', sourceSummary: 'First upload' });
    const extensionZip = chapterZip(path.join(root, 'extension.zip'), [3, 4, 5]);

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '3-5',
      zipPath: extensionZip, sourceType: 'upload', spawnWorker: false, env: env as never,
    });

    expect(extended).toMatchObject({ queued: true, chapters: '3-5', completedChapters: ['ch1', 'ch2'] });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3, 4, 5]);
    expect(fs.readFileSync(path.join(seriesDir, 'ch1', '001.png'), 'utf8')).toBe('PANEL-1');
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
    // Both archives stay readable: nothing was replaced.
    const retained = listRetainedSources(seriesDir);
    expect(retained).toHaveLength(2);
    expect(retained.map((entry) => entry.chapters)).toEqual(
      expect.arrayContaining([[1, 2], [3, 4, 5]]),
    );
  });

  it('rejects an explicit ZIP that lacks the requested chapters before mutating the series', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    const extensionZip = chapterZip(path.join(root, 'wrong.zip'), [7, 8]);
    await expect(extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-3',
      zipPath: extensionZip, spawnWorker: false, env: env as never,
    })).rejects.toThrow(/ch2, ch3 .*Re-add/s);
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
    expect(listRetainedSources(seriesDir)).toEqual([]);
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
  });

  it('renders only new chapters and leaves every completed output byte-identical', async () => {
    seedSeries([1, 2], { videos: [1, 2], bible: 'BIBLE-BYTES' });
    const audio = writeFile(path.join(seriesDir, 'out', 'ch1', 'audio', 'narration.mp3'), 'AUDIO-1');
    const panels = writeFile(path.join(seriesDir, 'out', 'panels', 'ch1', 'p0001_1.png'), 'PANELS-1');
    const cache = writeFile(path.join(seriesDir, 'out', 'batches', 'ch1', 'b00.json'), 'CACHE-1');
    const first = chapterZip(path.join(root, 'source.zip'), [1, 2, 3, 4, 5]);
    retainSourceArchive(seriesDir, first, { sourceType: 'upload' });

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '1-5',
      spawnWorker: false, env: env as never,
    });
    expect(extended).toMatchObject({ queued: true, chapters: '3-5' });
    // The persisted job is what the worker reads: only ch3-5, no re-import.
    expect(jobFile(String((extended.job as Record<string, unknown>).id))).toMatchObject({
      chapters: '3-5', runChapters: [3, 4, 5], skipIngest: true, onlyUnrendered: true,
    });
    for (const [file, body] of [
      [path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4'), 'VIDEO-ch1'],
      [path.join(seriesDir, 'out', 'ch2', 'video', 'video.mp4'), 'VIDEO-ch2'],
      [path.join(seriesDir, 'out', 'bible.json'), 'BIBLE-BYTES'],
      [audio, 'AUDIO-1'], [panels, 'PANELS-1'], [cache, 'CACHE-1'],
    ] as Array<[string, string]>) {
      expect(fs.readFileSync(file, 'utf8')).toBe(body);
    }
  });
});

describe('retained source: cleanup and retry semantics', () => {
  it('retry and continue fall back to the retained archive after job staging cleanup', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'retained.zip'), [1, 2]);
    retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });

    const retryId = craftJob({ status: 'failed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });
    const view = retryJob(retryId, { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const persisted = jobFile(retryId);
    expect(persisted.skipIngest).toBe(true);
    expect(persisted.stagedZipPath).toBeNull();
    // Finish the retried job so the series has no active/queued work left.
    fs.writeFileSync(path.join(jobsDir, `${retryId}.json`), JSON.stringify({ ...persisted, status: 'completed' }, null, 2));

    // A separate completed job continues ch2 straight from the retained archive.
    const continueId = craftJob({ status: 'completed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });
    const cont = continueJob(continueId, '2', { env: env as never, spawnWorker: false });
    expect(cont.status).toBe('queued');
    const afterContinue = jobFile(continueId);
    expect(afterContinue.skipIngest).toBe(false);
    expect(String(afterContinue.stagedZipPath)).toContain('out/source/archives');
    expect(afterContinue.runChapters).toEqual([2]);
    // A retained archive is local: the worker must not re-enter the Drive branch.
    expect(afterContinue.sourceType).toBe('local_zip');
  });

  it('orphan uploads reconcile never deletes a series-retained archive', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'retained.zip'), [1, 2]);
    const entry = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    const archive = path.join(seriesSourceDir(seriesDir), 'archives', entry.file);
    const orphan = path.join(uploadsDir, 'orphan.zip');
    writeFile(orphan, 'PK');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(orphan, old, old);

    const result = reconcileOrphans(env as never, false) as { removed: string[] };
    expect(result.removed).toContain('orphan.zip');
    expect(fs.existsSync(archive)).toBe(true);
    expect(findRetainedSourceForChapters(seriesDir, [2])?.path).toBe(archive);
  });
});

describe('retained source: untrusted metadata cannot escape the series', () => {
  it('ignores index entries with traversal, non-hash names, or a symlinked archive', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'good.zip'), [1, 2]);
    const entry = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    const sourceDir = seriesSourceDir(seriesDir);
    const outside = path.join(root, 'outside.zip');
    fs.copyFileSync(zip, outside);
    fs.symlinkSync(outside, path.join(sourceDir, 'archives', 'deadbeefdeadbeefdeadbeefdeadbeef.zip'));
    fs.writeFileSync(path.join(sourceDir, 'index.json'), JSON.stringify({
      schemaVersion: 1,
      archives: [
        entry,
        { ...entry, file: '../../../../outside.zip' },
        { ...entry, file: 'evil.zip' },
        { ...entry, sha256: 'f'.repeat(64), file: 'deadbeefdeadbeefdeadbeefdeadbeef.zip', chapters: [2] },
      ],
    }));

    const retained = listRetainedSources(seriesDir);
    // Only the real, content-addressed, non-symlinked archive survives validation.
    expect(retained.map((item) => item.file)).toEqual([entry.file]);
    expect(findRetainedSourceForChapters(seriesDir, [2])?.path).toBe(
      path.join(sourceDir, 'archives', entry.file),
    );
  });

  it('refuses to retain an archive through a symlinked series source directory', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'source.zip'), [1, 2]);
    const sourceDir = seriesSourceDir(seriesDir);
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, sourceDir);

    expect(() => retainSourceArchive(seriesDir, zip, { sourceType: 'upload' })).toThrow();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('ignores an index written by an incompatible future schema', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'good.zip'), [1, 2]);
    const entry = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    const index = path.join(seriesSourceDir(seriesDir), 'index.json');
    fs.writeFileSync(index, JSON.stringify({ schemaVersion: 99, archives: [entry] }));
    expect(listRetainedSources(seriesDir)).toEqual([]);
  });

  it('refuses a symlinked job staging ZIP instead of reading through it', () => {
    seedSeries([1]);
    const outside = chapterZip(path.join(root, 'outside.zip'), [1, 2]);
    const staged = path.join(uploadsDir, 'linked.zip');
    fs.symlinkSync(outside, staged);
    craftJob({ status: 'completed', sourceType: 'upload', stagedZipPath: staged });

    expect(findRecoverableSeriesSource(SLUG, [2], env as never)).toBeNull();
  });
});

describe('retained source: fault injection and partial coverage', () => {
  it('keeps the staging ZIP when retention fails, even though an older archive covers the imported chapters', async () => {
    // Existing series already retained ch1-2 (so "some archive exists" is true).
    seedSeries([1, 2], { videos: [1, 2] });
    const oldArchive = chapterZip(path.join(root, 'old.zip'), [1, 2]);
    retainSourceArchive(seriesDir, oldArchive, { sourceType: 'upload' });
    // A job that imports ch3-5 from a fresh ch1-5 ZIP, retention forced to fail.
    const staged = chapterZip(path.join(uploadsDir, 'job-inject-retain.zip'), [1, 2, 3, 4, 5]);
    const jobId = craftJob({
      status: 'queued', sourceType: 'upload', stagedZipPath: staged,
      chapters: '3-5', runChapters: [3, 4, 5], ingestedChapters: [],
      skipIngest: false, allowExistingSeries: true,
    });
    const spy = vi.spyOn(sourceArchive, 'retainSourceArchive').mockImplementation(() => {
      throw new Error('injected retention failure');
    });
    try {
      await executeSingleJob(jobFile(jobId) as never, {
        env: env as never, runCmdOverride: [process.execPath, runner(0)],
      });
    } finally {
      spy.mockRestore();
    }
    // Ingest succeeded from the staging ZIP...
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3, 4, 5]);
    // ...but the ZIP is still the only copy of ch3-5, so it must survive.
    expect(fs.existsSync(staged)).toBe(true);
    expect(jobFile(jobId).stagedZipPath).toBe(staged);
    expect(listRetainedSources(seriesDir)[0]!.chapters).toEqual([1, 2]);
  });

  it('keeps the staging upload after an ingestion failure even when no series directory remains', async () => {
    const zip = chapterZip(path.join(root, 'corrupt.zip'), [1, 2]);
    const queued = await enqueueJob({
      title: 'Retained Hero', slug: SLUG, zipPath: zip, sourceType: 'upload',
      chapters: '1', env: env as never, spawnWorker: false,
    });
    const jobId = String(queued.id);
    const staged = path.join(uploadsDir, `${jobId}.zip`);
    // Break the archive after enqueue so ingest fails before any retention.
    fs.writeFileSync(staged, 'definitely not a zip');
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, runner(0)],
    });
    const failed = jobFile(jobId);
    expect(failed.status).toBe('failed');
    expect(fs.existsSync(staged)).toBe(true);
    expect(failed.stagedZipPath).toBe(staged);
    // Retry is still possible from that upload.
    const retry = retryJob(jobId, { env: env as never, spawnWorker: false });
    expect(retry.status).toBe('queued');
    expect(jobFile(jobId).skipIngest).toBe(false);
  });

  it('rejects partial coverage of an explicit ZIP before importing anything', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    const partial = chapterZip(path.join(root, 'partial.zip'), [2, 3]);
    await expect(extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '2-5',
      zipPath: partial, spawnWorker: false, env: env as never,
    })).rejects.toThrow(/ch4, ch5 .*Nothing was imported/s);
    // Nothing was mutated: ch2/ch3 were not extracted and no archive was kept.
    expect(existingChapterNumbers(seriesDir)).toEqual([1]);
    expect(listRetainedSources(seriesDir)).toEqual([]);
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
  });

  it('does not recreate raw pages for a completed chapter that no longer has its folder', async () => {
    // ch1 is completed but its raw folder is gone; the source still has ch1.
    seedSeries([2], { videos: [1, 2] });
    const zip = chapterZip(path.join(root, 'source.zip'), [1, 2, 3]);
    retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '1-3',
      spawnWorker: false, env: env as never,
    });
    expect(extended).toMatchObject({ queued: true, chapters: '3' });
    expect(fs.existsSync(path.join(seriesDir, 'ch1'))).toBe(false);
    expect(existingChapterNumbers(seriesDir)).toEqual([2, 3]);
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4'), 'utf8')).toBe('VIDEO-ch1');
  });

  it('retry selects a retained archive by the chapters it is actually missing, not the largest one', () => {
    seedSeries([1]);
    // Two archives: a large one without ch2 and a small one with ch2.
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'big.zip'), [7, 8, 9, 10]), { sourceType: 'upload' });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'small.zip'), [2]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'failed', stagedZipPath: null, skipIngest: true, runChapters: [1, 2], chapters: '1-2' });
    retryJob(jobId, { env: env as never, spawnWorker: false });
    const persisted = jobFile(jobId);
    expect(persisted.skipIngest).toBe(false);
    const staged = String(persisted.stagedZipPath);
    // The chosen archive must really contain ch2.
    const idx = JSON.parse(JSON.stringify(
      sourceArchive.planRetainedExtraction(seriesDir, [2]).steps,
    )) as Array<{ path: string; chapters: number[] }>;
    expect(idx.some((step) => step.path === staged && step.chapters.includes(2))).toBe(true);
  });

  it('continue extracts a range spanning two retained archives', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'first.zip'), [2]), { sourceType: 'upload' });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'second.zip'), [3, 4]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'completed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });
    const view = continueJob(jobId, '2-4', { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const persisted = jobFile(jobId);
    expect(persisted.skipIngest).toBe(false);
    expect(persisted.runChapters).toEqual([2, 3, 4]);
    const plan = persisted.sourceArchives as Array<{ path: string; chapters: number[] }>;
    expect(plan).not.toBeNull();
    const covered = [Number(persisted.stagedZipPath ? 0 : 0), ...plan.flatMap((step) => step.chapters)];
    expect(covered).toEqual(expect.arrayContaining([3, 4]));
    // Every planned path is a real retained archive.
    for (const step of plan) expect(fs.existsSync(step.path)).toBe(true);
  });

  it('continue reports uncovered chapters instead of queueing a doomed run', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'only2.zip'), [2]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'completed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });
    expect(() => continueJob(jobId, '2-5', { env: env as never, spawnWorker: false }))
      .toThrow(/ch3, ch4, ch5 .*saved source archives/s);
  });

  it('a legacy staged ZIP covering only the missing chapters is accepted', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    const staged = chapterZip(path.join(uploadsDir, 'legacy-2-3.zip'), [2, 3]);
    craftJob({ status: 'completed', sourceType: 'upload', stagedZipPath: staged });
    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '1-3',
      spawnWorker: false, env: env as never,
    });
    expect(extended).toMatchObject({ queued: true, chapters: '2-3' });
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3]);
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
  });

  it('refuses a job staging ZIP reached through a symlinked parent directory', () => {
    seedSeries([1]);
    const realDir = path.join(root, 'real-uploads');
    fs.mkdirSync(realDir, { recursive: true });
    const realZip = chapterZip(path.join(realDir, 'staged.zip'), [1, 2]);
    const linkedDir = path.join(root, 'linked-uploads');
    fs.symlinkSync(realDir, linkedDir);
    craftJob({ status: 'completed', sourceType: 'upload', stagedZipPath: path.join(linkedDir, 'staged.zip') });
    expect(findRecoverableSeriesSource(SLUG, [2], env as never)).toBeNull();
    // The real path is still fine.
    expect(findRecoverableSeriesSource(SLUG, [], env as never)).toBeNull();
    expect(fs.existsSync(realZip)).toBe(true);
  });

  it('ignores stale index metadata that claims chapters the archive does not contain', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'only1.zip'), [1]);
    const entry = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    // Tamper with metadata only: claim ch2-3 that are not in the archive.
    const index = path.join(seriesSourceDir(seriesDir), 'index.json');
    fs.writeFileSync(index, JSON.stringify({
      schemaVersion: 1,
      archives: [{ ...entry, chapters: [1, 2, 3] }],
    }));
    expect(findRetainedSourceForChapters(seriesDir, [2])).toBeNull();
    expect(planRetainedExtraction(seriesDir, [2]).uncovered).toEqual([2]);
    expect(listRetainedSources(seriesDir)[0]!.chapters).toEqual([1, 2, 3]);
  });

  it('does not reuse a retained file whose bytes were swapped under the same name', () => {
    seedSeries([1]);
    const zip = chapterZip(path.join(root, 'source.zip'), [1, 2]);
    const entry = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    const archive = path.join(seriesSourceDir(seriesDir), 'archives', entry.file);
    const original = fs.readFileSync(archive);
    // Same byte length, different content: only a hash check can catch this.
    fs.writeFileSync(archive, Buffer.alloc(original.length, 0x41));
    const reRetained = retainSourceArchive(seriesDir, zip, { sourceType: 'upload' });
    expect(reRetained.sha256).toBe(entry.sha256);
    expect(fs.readFileSync(archive)).toEqual(original);
  });
});

describe('retained source: all-ranges, coverage validation and download seam', () => {
  it('continue "all" from ch1 imports the retained ch2-5 instead of stopping at what is on disk', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'full.zip'), [1, 2, 3, 4, 5]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'completed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });

    const view = continueJob(jobId, 'all', { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const persisted = jobFile(jobId);
    expect(persisted.runChapters).toEqual([1, 2, 3, 4, 5]);
    expect(persisted.skipIngest).toBe(false);
    expect(persisted.sourceType).toBe('local_zip');
  });

  it('retry of a partially ingested "all" job without runChapters still resumes the missing chapters', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'full.zip'), [1, 2, 3]), { sourceType: 'upload' });
    const jobId = craftJob({
      status: 'failed', stagedZipPath: null, skipIngest: false,
      chapters: 'all', runChapters: null, ingestedChapters: ['ch1'],
    });

    retryJob(jobId, { env: env as never, spawnWorker: false });
    const persisted = jobFile(jobId);
    expect(persisted.runChapters).toEqual([1, 2, 3]);
    expect(persisted.skipIngest).toBe(false);
  });

  it('retry with a partial retained range plus a saved Drive source queues the download instead of pretending coverage', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'part.zip'), [2]), { sourceType: 'gdrive', gdriveFileId: 'DRIVE1234567890' });
    const jobId = craftJob({
      status: 'failed', stagedZipPath: null, skipIngest: false,
      sourceType: 'gdrive', gdriveFileId: 'DRIVE1234567890',
      chapters: '1-3', runChapters: [1, 2, 3],
    });

    retryJob(jobId, { env: env as never, spawnWorker: false });
    const persisted = jobFile(jobId);
    expect(persisted.skipIngest).toBe(false);
    // ch3 is only in the Drive ZIP, so the worker must download it.
    expect(persisted.sourceType).toBe('gdrive');
    expect(persisted.stagedZipPath).toBeNull();
    expect(persisted.gdriveFileId).toBe('DRIVE1234567890');
    expect(persisted.sourceArchives).toEqual([expect.objectContaining({ chapters: [2] })]);
  });

  it('refuses a retry whose range no saved source covers, instead of queueing a doomed run', () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'only2.zip'), [2]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'failed', stagedZipPath: null, skipIngest: false, chapters: '1-4', runChapters: [1, 2, 3, 4] });
    expect(() => retryJob(jobId, { env: env as never, spawnWorker: false }))
      .toThrow(/ch3, ch4 .*saved source archives/);
    expect(jobFile(jobId).status).toBe('failed');
  });

  it('refuses to launch the pipeline when the source archive cannot supply the whole selection', async () => {
    const zip = chapterZip(path.join(root, 'only13.zip'), [1, 3]);
    const staged = path.join(uploadsDir, 'job-partial.zip');
    fs.copyFileSync(zip, staged);
    const jobId = craftJob({
      status: 'queued', sourceType: 'upload', stagedZipPath: staged,
      chapters: '1-3', runChapters: [1, 2, 3], ingestedChapters: [],
      skipIngest: false, allowExistingSeries: false,
    });
    const marker = path.join(root, 'ran.txt');
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never,
      runCmdOverride: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, '--'],
    });
    const failed = jobFile(jobId);
    expect(failed.status).toBe('failed');
    expect(String(failed.error)).toMatch(/ch2 .*Nothing was run/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('re-reads completed chapters under the lock so a render finishing mid-request is never re-extracted', async () => {
    seedSeries([1], { videos: [1], bible: 'PRESERVE-BIBLE' });
    const zip = chapterZip(path.join(root, 'drive-1-3.zip'), [1, 2, 3]);
    const download = vi.fn(async (_fileId: string, dest: string) => {
      fs.copyFileSync(zip, dest);
      // A chapter render completes between the pre-lock snapshot and the import.
      writeFile(path.join(seriesDir, 'out', 'ch2', 'video', 'video.mp4'), 'VIDEO-ch2');
      return { path: dest, bytes: fs.statSync(dest).size, totalBytes: null };
    });

    const extended = await extendSeries({
      seriesRoot: path.join(root, 'series'), slug: SLUG, chapters: '1-3',
      gdriveUrl: 'https://drive.google.com/file/d/DRIVEEXPLICIT01/view',
      spawnWorker: false, env: env as never, downloadFn: download as never,
    });

    // The explicit URL went through the injected seam (no real network).
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toBe('DRIVEEXPLICIT01');
    // ch2 is completed, so its raw pages are not recreated and it is not "missing".
    expect(fs.existsSync(path.join(seriesDir, 'ch2'))).toBe(false);
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 3]);
    expect(extended).toMatchObject({ queued: true, chapters: '3', completedChapters: ['ch1', 'ch2'] });
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'ch2', 'video', 'video.mp4'), 'utf8')).toBe('VIDEO-ch2');
    expect(fs.readFileSync(path.join(seriesDir, 'out', 'bible.json'), 'utf8')).toBe('PRESERVE-BIBLE');
  });
});

describe('retained source: all-range execution across several archives', () => {
  /** Stub runner that records argv and the raw chapter folders present at launch. */
  function captureRunner(): { script: string; capture: string } {
    const capture = path.join(root, 'launch.json');
    const script = path.join(root, 'capture-runner.mjs');
    writeFile(script, `
import fs from 'node:fs';
const seriesRoot = ${JSON.stringify(path.join(root, 'series'))};
const slug = process.argv[2] || '';
const dir = seriesRoot + '/' + slug;
const chapters = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => /^ch\\d+$/.test(n)).sort()
  : [];
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), chapters }));
process.stdout.write('== ch1: STUB\\n');
process.exit(0);
`);
    return { script, capture };
  }

  it('executes continue "all" from ch1 across two retained archives before the runner launches', async () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'a.zip'), [1, 2]), { sourceType: 'upload' });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'b.zip'), [3, 4]), { sourceType: 'upload' });
    const jobId = craftJob({ status: 'completed', stagedZipPath: null, skipIngest: true, runChapters: [1], chapters: '1' });

    const view = continueJob(jobId, 'all', { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const queued = jobFile(jobId);
    expect(queued.runChapters).toEqual([1, 2, 3, 4]);
    expect(queued.chapters).toBe('1,2,3,4');
    // Both archives are recorded; the worker skips the one it opens first.
    expect(queued.sourceArchives).toHaveLength(2);

    const { script, capture } = captureRunner();
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, script],
    });

    expect(jobFile(jobId).status).toBe('completed');
    const launch = JSON.parse(fs.readFileSync(capture, 'utf8')) as { args: string[]; chapters: string[] };
    // Every requested chapter was extracted from its own archive before launch...
    expect(launch.chapters).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
    expect(existingChapterNumbers(seriesDir)).toEqual([1, 2, 3, 4]);
    // ...and the pipeline was asked for exactly those chapters.
    expect(launch.args).toEqual([SLUG, 'ch1', 'ch2', 'ch3', 'ch4', '--video']);
  });

  it('executes retry "all" of a partially ingested job across two retained archives', async () => {
    seedSeries([1], { videos: [1] });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'a.zip'), [1, 2]), { sourceType: 'upload' });
    retainSourceArchive(seriesDir, chapterZip(path.join(root, 'b.zip'), [3, 4]), { sourceType: 'upload' });
    const jobId = craftJob({
      status: 'failed', stagedZipPath: null, skipIngest: false,
      chapters: 'all', runChapters: null, ingestedChapters: ['ch1'],
    });

    const view = retryJob(jobId, { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const queued = jobFile(jobId);
    expect(queued.runChapters).toEqual([1, 2, 3, 4]);
    expect(queued.chapters).toBe('1,2,3,4');

    const { script, capture } = captureRunner();
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never, runCmdOverride: [process.execPath, script],
    });

    expect(jobFile(jobId).status).toBe('completed');
    const launch = JSON.parse(fs.readFileSync(capture, 'utf8')) as { args: string[]; chapters: string[] };
    // Every requested chapter is extracted before launch...
    expect(launch.chapters).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
    // ...but a retry reruns only unfinished chapters: ch1 already has its video.
    expect(launch.args).toEqual([SLUG, 'ch2', 'ch3', 'ch4', '--video']);
  });

  it('refuses a symlinked extra source archive before reading it', async () => {
    seedSeries([1], { videos: [1] });
    const real = chapterZip(path.join(root, 'real-b.zip'), [3, 4]);
    const linked = path.join(root, 'linked-b.zip');
    fs.symlinkSync(real, linked);
    const staged = chapterZip(path.join(uploadsDir, 'job-a.zip'), [1, 2]);
    const jobId = craftJob({
      status: 'queued', sourceType: 'local_zip', stagedZipPath: staged,
      chapters: '1-4', runChapters: [1, 2, 3, 4], ingestedChapters: [],
      skipIngest: false, allowExistingSeries: true,
      sourceArchives: [{ path: linked, chapters: [3, 4] }],
    });
    const marker = path.join(root, 'ran.txt');
    await executeSingleJob(jobFile(jobId) as never, {
      env: env as never,
      runCmdOverride: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, '--'],
    });
    expect(jobFile(jobId).status).toBe('failed');
    expect(String(jobFile(jobId).error)).toMatch(/symbolic link/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
