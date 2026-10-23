/**
 * Job-level auto-retry for language versions: schedule, cap, one job per due
 * retry, no duplicates, superseded/rejected/legacy jobs left alone, state on
 * disk, and a dead worker reconciled then resumed. Injected clock, temp dirs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import * as languages from '../src/player/languages.js';
import * as localize from '../src/stages/localize.js';
import { listJobs, pidAlive, procBootId, procStartTicks, readJob, writeJob } from '../src/localization/store.js';
import { putStudioSettings } from '../src/config/studioConfig.js';
import type { LocalizeJobRecord } from '../src/localization/types.js';

const slug = 'lang-retry-fixture';
let root: string;
let sdir: string;
const spawned: string[] = [];

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

function buildChapter(ch: string): void {
  const out = path.join(sdir, 'out');
  json(path.join(out, `obs_${ch}.json`), {
    data: { panels: [{ id: 'p0001_1', visual: 'Night artwork.', overlay: [], world: [], art: 0.9 }], characters: [], gags: [], events: [] },
  });
  write(path.join(out, 'panels', ch, 'p0001_1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  write(path.join(out, ch, 'script.md'), '## BEAT b01_gate\nA gate at night. @p0001_1\n');
  json(path.join(out, ch, 'report.json'), { series: slug, ch, status: 'ok', lines: 1, issues: [], window_holes: [] });
}

const T0 = Date.parse('2026-10-23T22:00:00.000Z');
const at = (s: number) => () => new Date(T0 + s * 1000);

/** Persist a finished job as the worker would leave it. */
function finishedJob(patch: Partial<LocalizeJobRecord> & { id: string }): LocalizeJobRecord {
  const job: LocalizeJobRecord = {
    schemaVersion: 1,
    slug,
    locale: 'hi-IN',
    chapters: ['ch1', 'ch2'],
    voice: 'hi-IN-SwaraNeural',
    speed: 1.25,
    status: 'failed',
    error: 'one or more chapters failed; retry to resume',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    attempts: {},
    progress: {
      ch1: { status: 'completed', updatedAt: new Date(T0).toISOString() },
      ch2: { status: 'failed', error: 'HTTP 503', updatedAt: new Date(T0).toISOString() },
    },
    autoRetryCount: 0,
    pid: null,
    pidStart: null,
    ...patch,
  };
  writeJob(sdir, job);
  return job;
}

let seq = 0;
const jobId = () => `loc-${T0 + ++seq}-${'0000000'.concat(String(seq)).slice(-8)}`;

/** Mark the newest job failed exactly as the worker does, at clock `s`. */
function failLatest(s: number): LocalizeJobRecord {
  const job = listJobs(sdir).at(-1)!;
  const updated = {
    ...job,
    status: 'failed' as const,
    error: 'one or more chapters failed; retry to resume',
    updatedAt: new Date(T0 + s * 1000).toISOString(),
    progress: Object.fromEntries(job.chapters.map((ch) => [ch, { status: 'failed' as const, updatedAt: new Date(T0).toISOString() }])),
  };
  writeJob(sdir, updated);
  return updated;
}

beforeAll(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-retry-');
  sdir = path.join(root, 'series', slug);
  json(path.join(sdir, 'meta.json'), { title: 'Retry Fixture', tts: { engine: 'edge' } });
  json(path.join(sdir, 'out', 'bible.json'), { characters: {} });
  buildChapter('ch1');
  buildChapter('ch2');
  vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series'));
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_AUTO_RETRY', '1');
  vi.stubEnv('MANHWA_AUTO_RETRY_DELAYS_S', '');
  vi.stubEnv('MANHWA_AUTO_RESUME_DELAY_S', '');
  languages._setJobSpawnerForTests((_dir, id) => {
    spawned.push(id);
  });
});

afterAll(() => {
  languages.stopLanguageQueue();
  languages._setJobSpawnerForTests(null);
  localize._clearSourceCheckCache();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(sdir, 'out', 'languages'), { recursive: true, force: true });
  spawned.length = 0;
});

describe('language job auto-retry', () => {
  it.each(['environment', 'settings'])('honours %s disable after a retry was scheduled', async (switchName) => {
    const source = finishedJob({ id: jobId() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    if (switchName === 'environment') vi.stubEnv('MANHWA_AUTO_RETRY', '0');
    else putStudioSettings({ autoRetry: { enabled: false } }, path.join(root, 'out'));
    try {
      expect(await languages.languageQueueTick(at(600))).toEqual([]);
      expect(localize.languagesState(sdir, slug, { now: at(600) }).versions[0]?.autoRetry).toBeUndefined();
      await expect(localize.planLocalizeJob(sdir, { locale: source.locale, chapters: '2', voice: source.voice,
        speed: source.speed, autoRetryOf: source.id }, at(600))).rejects.toMatchObject({ code: 'auto_retry_superseded' });
      expect(spawned).toEqual([]);
    } finally {
      vi.stubEnv('MANHWA_AUTO_RETRY', '1');
      putStudioSettings({ autoRetry: { enabled: true } }, path.join(root, 'out'));
    }
  });

  it.each(['completed', 'cancelled'] as const)('ignores a stale pending schedule on a %s job', async (status) => {
    const job = finishedJob({ id: jobId(), nextAutoRetryAt: new Date(T0).toISOString() });
    json(path.join(sdir, 'out/languages/jobs', `${job.id}.json`), { ...job, status });
    expect(await languages.languageQueueTick(at(600))).toEqual([]);
    expect(localize.languagesState(sdir, slug, { now: at(600) }).versions[0]?.autoRetry).toBeUndefined();
  });

  it('does not revive legacy running jobs after deployment', async () => {
    const source = finishedJob({ id: jobId(), status: 'running', autoRetryCount: undefined, pid: 999_999_999 });
    expect(await languages.languageQueueTick(at(0))).toEqual([]);
    expect(readJob(sdir, source.id)).toMatchObject({ status: 'interrupted', nextAutoRetryAt: null });
    expect(await languages.languageQueueTick(at(100_000))).toEqual([]);
  });

  it('bounds deterministic dead-worker crashes to three retries, including an unspawned queued job', async () => {
    finishedJob({ id: jobId(), status: 'running', pid: 999_999_999, pidStart: 1 });
    let clock = 0;
    for (let count = 0; count <= 3; count++) {
      expect(await languages.languageQueueTick(at(clock))).toEqual([]);
      const job = listJobs(sdir).at(-1)!;
      expect(job.autoRetryCount).toBe(count);
      if (count === 3) {
        expect(job.nextAutoRetryAt).toBeNull();
        break;
      }
      const due = (Date.parse(job.nextAutoRetryAt!) - T0) / 1000;
      expect(await languages.languageQueueTick(at(due))).toHaveLength(1);
      clock = due + 1000;
    }
    expect(spawned).toHaveLength(3);
  });

  it('serializes overlapping ticks and a manual request', async () => {
    finishedJob({ id: jobId() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    const results = await Promise.allSettled([
      languages.languageQueueTick(at(600)), languages.languageQueueTick(at(600)),
      localize.planLocalizeJob(sdir, { locale: 'hi-IN', chapters: '2', voice: 'hi-IN-SwaraNeural' }, at(600)),
    ]);
    expect(results).toHaveLength(3);
    expect(listJobs(sdir).filter(job => job.status === 'queued' || job.status === 'running')).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it('rejects a delayed old worker after its queued job was replaced', async () => {
    const old = finishedJob({ id: jobId(), status: 'queued', progress: {} });
    expect(await languages.languageQueueTick(at(1000))).toEqual([]);
    const retry = await languages.languageQueueTick(at(1120));
    expect(retry).toHaveLength(1);
    await expect(localize.runLocalizeJob(sdir, old.id, { skipPipelineConflictCheck: true, now: at(1121) }))
      .rejects.toMatchObject({ code: 'job_superseded' });
    expect(listJobs(sdir).filter(job => job.status === 'queued' || job.status === 'running')).toHaveLength(1);
  });

  it('rejects PID reuse and identities from another boot', () => {
    const ticks = procStartTicks(process.pid)!;
    expect(pidAlive(process.pid, ticks, procBootId())).toBe(true);
    expect(pidAlive(process.pid, ticks + 1)).toBe(false);
    expect(pidAlive(process.pid, ticks, 'previous-boot')).toBe(false);
    expect(pidAlive(process.pid, null)).toBe(false);
  });

  it('keeps the language cap at three even when Studio permits five retries', async () => {
    putStudioSettings({ autoRetry: { maxRetries: 5 } }, path.join(root, 'out'));
    try {
      const job = finishedJob({ id: jobId(), autoRetryCount: 3, status: 'running', pid: 999_999_999 });
      expect(await languages.languageQueueTick(at(0))).toEqual([]);
      expect(readJob(sdir, job.id)?.nextAutoRetryAt).toBeNull();
      expect(await languages.languageQueueTick(at(100_000))).toEqual([]);
    } finally {
      putStudioSettings({ autoRetry: { maxRetries: 3 } }, path.join(root, 'out'));
    }
  });

  it('never expands an empty unfinished list to all chapters', async () => {
    finishedJob({ id: jobId(), nextAutoRetryAt: new Date(T0).toISOString(), progress: {
      ch1: { status: 'completed', updatedAt: new Date(T0).toISOString() },
      ch2: { status: 'completed', updatedAt: new Date(T0).toISOString() },
    } });
    expect(await languages.languageQueueTick(at(600))).toEqual([]);
    expect(listJobs(sdir)).toHaveLength(1);
  });

  it('refuses automatic provider drift rather than silently billing another provider', async () => {
    const job = finishedJob({ id: jobId(), engine: 'edge', provider: 'former-provider', modelId: 'edge-tts' });
    expect(await languages.languageQueueTick(at(0))).toEqual([]);
    expect(await languages.languageQueueTick(at(600))).toEqual([]);
    expect(readJob(sdir, job.id)?.nextAutoRetryAt).toBeNull();
    expect(readJob(sdir, job.id)?.error).toContain('Saved retry settings');
  });

  it('keeps the permanent rejection reason even after a long worker error', () => {
    const job = finishedJob({ id: jobId(), error: 'x'.repeat(500), nextAutoRetryAt: new Date(T0).toISOString() });
    localize.dropAutoRetry(sdir, job.id, 'voice is unavailable');
    expect(readJob(sdir, job.id)?.error).toContain('Automatic retry stopped: voice is unavailable');
  });

  it('survives corrupt job JSON and a non-directory series root', async () => {
    write(path.join(sdir, 'out/languages/jobs', `${jobId()}.json`), '{broken');
    finishedJob({ id: jobId() });
    expect(await languages.languageQueueTick(at(0))).toEqual([]);
    expect(await languages.languageQueueTick(at(600))).toHaveLength(1);
    vi.stubEnv('MANHWA_SERIES_ROOT', path.join(sdir, 'meta.json'));
    try { expect(await languages.languageQueueTick(at(600))).toEqual([]); }
    finally { vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series')); }
  });

  it('starts one unrefed watchdog and cleans it up', async () => {
    vi.useFakeTimers();
    try {
      languages.initLanguageQueue();
      languages.initLanguageQueue();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      languages.stopLanguageQueue();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      languages.stopLanguageQueue();
      vi.useRealTimers();
    }
  });

  it('schedules +600, +1800, +3600 s and stops after 3 retries', async () => {
    finishedJob({ id: jobId() });
    const delays: number[] = [];
    let clock = 0;
    for (let i = 0; i < 4; i++) {
      localize.reconcileLocalizeJobs(sdir, at(clock));
      const latest = listJobs(sdir).at(-1)!;
      if (latest.nextAutoRetryAt === null) break;
      const due = (Date.parse(latest.nextAutoRetryAt!) - T0) / 1000;
      delays.push(due - clock);
      expect(await languages.languageQueueTick(at(due - 1))).toEqual([]);
      const started = await languages.languageQueueTick(at(due));
      expect(started).toHaveLength(1);
      expect(readJob(sdir, started[0]!)?.autoRetryCount).toBe(i + 1);
      clock = due + 5;
      failLatest(clock);
    }
    expect(delays).toEqual([600, 1800, 3600]);
    const last = listJobs(sdir).at(-1)!;
    expect(last.autoRetryCount).toBe(3);
    expect(last.nextAutoRetryAt).toBeNull();
    expect(await languages.languageQueueTick(at(clock + 100_000))).toEqual([]);
  });

  it('a due retry creates exactly one job with the same unfinished chapters, voice and speed', async () => {
    const source = finishedJob({ id: jobId() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    const started = await languages.languageQueueTick(at(600));
    expect(started).toHaveLength(1);
    expect(spawned).toEqual(started);
    const job = readJob(sdir, started[0]!)!;
    expect(job).toMatchObject({ chapters: ['ch2'], voice: source.voice, speed: 1.25, status: 'queued', autoRetryCount: 1 });
    expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBeNull();
    // Another tick while it is queued never adds a second job.
    expect(await languages.languageQueueTick(at(700))).toEqual([]);
    expect(listJobs(sdir)).toHaveLength(2);
  });

  it('waits instead of duplicating while another job is active', async () => {
    const source = finishedJob({ id: jobId(), createdAt: new Date(T0 + 1).toISOString() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    // A live, older job for the same series blocks planning; the retry waits.
    writeJob(sdir, { ...source, id: jobId(), locale: 'hi-IN', status: 'running', pid: process.pid,
      pidStart: procStartTicks(process.pid), createdAt: new Date(T0).toISOString(), nextAutoRetryAt: undefined });
    expect(await languages.languageQueueTick(at(600))).toEqual([]);
    expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBeTruthy();
    expect(listJobs(sdir)).toHaveLength(2);
  });

  it('drops the pending retry when a manual retry or new job comes first', async () => {
    const source = finishedJob({ id: jobId() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBeTruthy();
    const manual = await localize.planLocalizeJob(sdir, { locale: 'hi-IN', chapters: '2', voice: 'hi-IN-MadhurNeural' }, at(10));
    expect(manual.job.autoRetryCount).toBe(0);
    expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBeNull();
    failLatest(20);
    expect(await languages.languageQueueTick(at(600))).toEqual([]);
    // The manual job starts its own chain.
    expect(listJobs(sdir).at(-1)?.nextAutoRetryAt).toBeTruthy();
  });

  it('never retries a superseded job, a legacy job or a completed job', async () => {
    finishedJob({ id: jobId(), createdAt: new Date(T0).toISOString() });
    const newer = finishedJob({ id: jobId(), createdAt: new Date(T0 + 5).toISOString(), status: 'completed',
      error: undefined, progress: { ch1: { status: 'completed', updatedAt: new Date(T0).toISOString() },
        ch2: { status: 'completed', updatedAt: new Date(T0).toISOString() } } });
    localize.reconcileLocalizeJobs(sdir, at(0));
    expect(await languages.languageQueueTick(at(10_000))).toEqual([]);
    expect(readJob(sdir, newer.id)?.nextAutoRetryAt).toBeUndefined();

    fs.rmSync(path.join(sdir, 'out', 'languages'), { recursive: true, force: true });
    const legacy = finishedJob({ id: jobId(), autoRetryCount: undefined });
    localize.reconcileLocalizeJobs(sdir, at(0));
    expect(readJob(sdir, legacy.id)?.nextAutoRetryAt).toBeNull();
    expect(await languages.languageQueueTick(at(10_000))).toEqual([]);
  });

  it('stops the chain on a pre-start rejection such as an ineligible source', async () => {
    const source = finishedJob({ id: jobId() });
    localize.reconcileLocalizeJobs(sdir, at(0));
    fs.rmSync(path.join(sdir, 'out', 'ch2', 'script.md'));
    localize._clearSourceCheckCache();
    try {
      expect(await languages.languageQueueTick(at(600))).toEqual([]);
      const after = readJob(sdir, source.id)!;
      expect(after.nextAutoRetryAt).toBeNull();
      expect(after.error).toMatch(/Automatic retry stopped/);
      expect(listJobs(sdir)).toHaveLength(1);
    } finally {
      buildChapter('ch2');
      localize._clearSourceCheckCache();
    }
  });

  it('keeps the schedule across a reload from disk', async () => {
    const source = finishedJob({ id: jobId(), autoRetryCount: 1 });
    localize.reconcileLocalizeJobs(sdir, at(0));
    const raw = JSON.parse(fs.readFileSync(path.join(sdir, 'out', 'languages', 'jobs', `${source.id}.json`), 'utf8'));
    expect(raw).toMatchObject({ autoRetryCount: 1, nextAutoRetryAt: new Date(T0 + 1800_000).toISOString() });
    // A fresh reconcile (server restart) neither moves nor re-arms it.
    localize.reconcileLocalizeJobs(sdir, at(900));
    expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBe(raw.nextAutoRetryAt);
    const view = localize.languagesState(sdir, slug, { now: at(900) }).versions[0];
    expect(view?.autoRetry).toEqual({ count: 2, max: 3, at: raw.nextAutoRetryAt });
    expect(await languages.languageQueueTick(at(1800))).toHaveLength(1);
  });

  it('reconciles a dead worker, then resumes it after the auto-resume delay', async () => {
    const dead = finishedJob({
      id: jobId(), status: 'running', error: undefined, pid: 999_999_999, pidStart: 1,
      progress: { ch1: { status: 'completed', updatedAt: new Date(T0).toISOString() },
        ch2: { status: 'running', stage: 'render', updatedAt: new Date(T0).toISOString() } },
    });
    // The tick alone (nobody polling the UI) notices the dead worker.
    expect(await languages.languageQueueTick(at(30))).toEqual([]);
    const marked = readJob(sdir, dead.id)!;
    expect(marked.status).toBe('interrupted');
    expect(Date.parse(marked.nextAutoRetryAt!) - Date.parse(marked.updatedAt)).toBe(120_000);
    const started = await languages.languageQueueTick(() => new Date(Date.parse(marked.nextAutoRetryAt!)));
    expect(started).toHaveLength(1);
    expect(readJob(sdir, started[0]!)).toMatchObject({ chapters: ['ch2'], voice: dead.voice, speed: dead.speed, autoRetryCount: 1 });
  });

  it('honours the Studio kill switch', async () => {
    vi.stubEnv('MANHWA_AUTO_RETRY', '0');
    try {
      const source = finishedJob({ id: jobId() });
      localize.reconcileLocalizeJobs(sdir, at(0));
      expect(readJob(sdir, source.id)?.nextAutoRetryAt).toBeUndefined();
      expect(await languages.languageQueueTick(at(10_000))).toEqual([]);
    } finally {
      vi.stubEnv('MANHWA_AUTO_RETRY', '1');
    }
  });
});
