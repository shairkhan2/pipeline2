import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intake from '../src/intake/intake.js';
import { defaultStudioSettings, getStudioSettings, putStudioSettings } from '../src/config/studioConfig.js';
import { handleStudioRoute } from '../src/player/studio.js';

let root: string;
let sdir: string;
let env: Record<string, string>;
let server: http.Server | undefined;

function write(file: string, value: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function craftJob(patch: intake.JobRecord = {}): intake.JobRecord {
  const now = Date.now() / 1000;
  const job: intake.JobRecord = {
    schemaVersion: 1, id: `job-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    slug: 'resume-fan', title: 'Resume Fan', status: 'queued', statusNote: '',
    sourceType: 'local_zip', stagedZipPath: null, chapters: '1', runChapters: [1],
    ingestedChapters: ['ch1'], skipIngest: true, allowExistingSeries: true,
    tts: { providerId: 'edge', engine: 'edge', metaTts: { engine: 'edge' } },
    visuals: { background: 'starfield', motion: 'cut' }, renderLane: 'inherit',
    createdAt: now, updatedAt: now, startedAt: null, endedAt: null,
    workerPid: null, runPid: null, error: null, logTail: [],
    autoRetry: { count: 0, max: 3, lastFailure: null }, ...patch,
  };
  persist(job);
  return job;
}

function persist(job: intake.JobRecord): void {
  write(path.join(env.MANHWA_JOBS_DIR!, `${job.id}.json`), JSON.stringify(job));
}

function stored(job: intake.JobRecord): intake.JobRecord {
  return JSON.parse(fs.readFileSync(path.join(env.MANHWA_JOBS_DIR!, `${job.id}.json`), 'utf8'));
}

function writeRunner(rc = 1, report?: Record<string, unknown>, extra = ''): string[] {
  const file = path.join(root, `runner-${Math.random().toString(16).slice(2)}.mjs`);
  write(file, `import fs from 'node:fs';
    ${report ? `fs.writeFileSync(${JSON.stringify(path.join(sdir, 'out', 'ch1', 'report.json'))}, ${JSON.stringify(JSON.stringify(report))});` : ''}
    console.log('  !! ch1 FAILED (test): HTTP 429');
    console.log('videos: 0 ok | FAILED: ch1');
    ${extra}
    process.exit(${rc});`);
  return [process.execPath, file];
}

async function execute(job: intake.JobRecord, report?: Record<string, unknown>, rc = 1): Promise<intake.JobRecord> {
  await intake.executeSingleJob(job, { env, runCmdOverride: writeRunner(rc, report) });
  return stored(job);
}

beforeEach(() => {
  root = fs.mkdtempSync('/tmp/opencode/self-heal-intake-');
  env = {
    MANHWA_JOBS_DIR: path.join(root, 'jobs'), MANHWA_SERIES_ROOT: path.join(root, 'series'),
    MANHWA_OUT_DIR: path.join(root, 'out'), MANHWA_NO_AUTO_WORKER: '1',
    PIPELINE_LOG: path.join(root, 'pipeline.log'), PIPELINE_STATUS_DIR: path.join(root, 'status'),
    PATH: process.env.PATH ?? '', MANHWA_AUTO_RETRY: '1', MANHWA_AUTO_RETRY_DELAYS_S: '600,1800,3600',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  fs.mkdirSync(env.MANHWA_JOBS_DIR!, { recursive: true });
  sdir = path.join(env.MANHWA_SERIES_ROOT!, 'resume-fan');
  write(path.join(sdir, 'ch1', '001.jpg'), 'page');
  write(path.join(sdir, 'out', 'ch1', 'script.md'), 'Narration');
  const real = fs.readdirSync as unknown as (...args: unknown[]) => unknown;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((target: unknown, opts?: unknown) => {
    if (target === '/proc') return [];
    return real(target, opts);
  }) as never);
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('job-level self healing', () => {
  it('queues transient failures, keeps the pinned error and exposes waiting controls', async () => {
    putStudioSettings({ autoRetry: { maxRetries: 4 } }, env.MANHWA_OUT_DIR);
    const job = craftJob();
    const result = await execute(job, { status: 'video-failed', class: 'transient', error: 'HTTP 429 resource exhausted' });
    expect(result.status).toBe('queued');
    expect(result.notBefore).toBeGreaterThan(Date.now() / 1000 + 590);
    expect(result.autoRetry).toEqual({ count: 1, max: 4, lastFailure: 'HTTP 429 · rate limited' });
    expect(result.error).toBe('videos: 0 ok | FAILED: ch1');
    expect(result.failureDetail).toBe('!! ch1 FAILED (test): HTTP 429');
    expect(result.statusNote).toBe('Auto-retry 1 of 4 · HTTP 429 · rate limited');
    expect(result.onlyUnrendered).toBe(true);
    expect(result.skipIngest).toBe(true);
    expect(result.runChapters).toEqual([1]);
    expect(fs.readFileSync(path.join(env.MANHWA_JOBS_DIR!, `${job.id}.log`), 'utf8')).toContain('AUTO-RETRY 1/4 in 600s');
    expect(intake.publicJobView(result, false, env)).toMatchObject({
      notBefore: result.notBefore, autoRetry: result.autoRetry, failureDetail: result.failureDetail,
      actions: expect.arrayContaining(['retry', 'stop', 'pause']),
    });
  });

  it('does not retry permanent failures', async () => {
    expect((await execute(craftJob(), { status: 'failed', class: 'permanent', error: 'HTTP 403' })).status).toBe('failed');
  });

  it('retries unknown failures once, then fails', async () => {
    let job = await execute(craftJob(), { status: 'failed', class: 'unknown', error: 'unexplained bug' });
    expect(job.status).toBe('queued');
    expect(job.autoRetry.count).toBe(1);
    job = await execute(job, { status: 'failed', class: 'unknown', error: 'unexplained bug' });
    expect(job.status).toBe('failed');
    expect(job.autoRetry.count).toBe(1);
  });

  it('retries exits without report information only once', async () => {
    let job = await execute(craftJob(), undefined, 137);
    expect(job.status).toBe('queued');
    job = await execute(job, undefined, 137);
    expect(job.status).toBe('failed');
  });

  it('ignores stale transient reports', async () => {
    const file = write(path.join(sdir, 'out', 'ch1', 'report.json'), JSON.stringify({ status: 'failed', class: 'transient', error: 'HTTP 429' }));
    fs.utimesSync(file, new Date(0), new Date(0));
    expect((await execute(craftJob({ autoRetry: { count: 1, max: 3 } }))).status).toBe('failed');
  });

  it('honors exhausted budgets', async () => {
    expect((await execute(craftJob({ autoRetry: { count: 3, max: 3, lastFailure: null } }),
      { status: 'failed', class: 'transient', error: 'HTTP 429' })).status).toBe('failed');
  });

  it('preserves legacy jobs without autoRetry', async () => {
    expect((await execute(craftJob({ autoRetry: undefined }), { status: 'failed', class: 'transient', error: 'HTTP 429' })).status).toBe('failed');
  });

  it('does not retry stopped jobs', async () => {
    const result = await execute(craftJob({ stopRequested: true }), { status: 'failed', class: 'transient', error: 'HTTP 429' });
    expect(result.status).toBe('interrupted');
    expect(result.autoRetry.count).toBe(0);
  });

  it('honors disabled settings', async () => {
    putStudioSettings({ autoRetry: { enabled: false } }, env.MANHWA_OUT_DIR);
    expect((await execute(craftJob(), { status: 'failed', class: 'transient', error: 'HTTP 429' })).status).toBe('failed');
  });

  it('honors the environment kill switch', async () => {
    env.MANHWA_AUTO_RETRY = '0';
    expect((await execute(craftJob(), { status: 'failed', class: 'transient', error: 'HTTP 429' })).status).toBe('failed');
  });

  it('supports zero-delay test overrides and classifies reports without a class', async () => {
    env.MANHWA_AUTO_RETRY_DELAYS_S = '0,0,0';
    const job = await execute(craftJob(), { status: 'failed', error: 'HTTP 503' });
    expect(job.status).toBe('queued');
    expect(job.notBefore).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it('retry now clears only the waiting deadline', () => {
    const job = craftJob({ notBefore: Date.now() / 1000 + 600, autoRetry: { count: 2, max: 3, lastFailure: 'Timed out' } });
    intake.retryJob(job.id, { env, spawnWorker: false });
    expect(stored(job)).toMatchObject({ ...job, updatedAt: expect.any(Number), notBefore: null });
  });

  it('manual retry initializes eligibility, resets its budget and preserves finished chapters', () => {
    const job = craftJob({ status: 'failed', autoRetry: { count: 3, max: 3, lastFailure: 'Timed out' } });
    intake.retryJob(job.id, { env, spawnWorker: false });
    expect(stored(job)).toMatchObject({ status: 'queued', onlyUnrendered: true, autoRetry: { count: 0, max: 3, lastFailure: null } });
  });

  it('waiting jobs can be paused, resumed and stopped without another retry', () => {
    const job = craftJob({ notBefore: Date.now() / 1000 + 600 });
    expect(intake.pauseJob(job.id, env).status).toBe('paused');
    expect(intake.resumeJob(job.id, env).status).toBe('queued');
    expect(stored(job).notBefore).toBe(job.notBefore);
    expect(intake.stopJob(job.id, env)).toMatchObject({ status: 'interrupted', notBefore: null });
    expect(stored(job).stopRequested).toBe(true);
  });
});

describe('worker scheduling and dead-run recovery', () => {
  it('skips future jobs while processing a due job', async () => {
    const waiting = craftJob({ notBefore: Date.now() / 1000 + 600, createdAt: 1 });
    const due = craftJob({ createdAt: 2 });
    const result = await intake.runWorkerOnce({ env, runCmdOverride: writeRunner(0) });
    expect(result.processed).toBe(1);
    expect(stored(waiting).status).toBe('queued');
    expect(stored(due).status).toBe('completed');
  });

  it('once returns without sleeping when only future jobs exist', async () => {
    craftJob({ notBefore: Date.now() / 1000 + 600 });
    const sleep = vi.fn();
    expect(await intake.runWorkerOnce({ env, sleep })).toEqual({ acquired: true, processed: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits in short chunks and rescans for newly queued jobs', async () => {
    const waiting = craftJob({ notBefore: Date.now() / 1000 + 600, createdAt: 1 });
    let newJob: intake.JobRecord;
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(5000);
      newJob = craftJob({ createdAt: 2 });
      intake.stopJob(waiting.id, env);
    });
    expect(await intake.runWorker({ env, sleep, runCmdOverride: writeRunner(0) })).toEqual({ acquired: true, processed: 1 });
    expect(stored(newJob!).status).toBe('completed');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reconciles dead running jobs into delayed auto-resume', () => {
    const job = craftJob({ status: 'running', workerPid: 999999, runPid: 999998 });
    intake.reconcileJobs(env);
    const result = stored(job);
    expect(result).toMatchObject({ status: 'queued', onlyUnrendered: true, skipIngest: true,
      autoRetry: { count: 1, max: 3, lastFailure: 'run stopped unexpectedly' },
      statusNote: 'Auto-resume 1 of 3 · run stopped unexpectedly' });
    expect(result.notBefore).toBeGreaterThan(Date.now() / 1000 + 119);
  });

  it('status polling also auto-resumes a dead run, and only once', () => {
    const job = craftJob({ status: 'running', workerPid: 999999, runPid: 999998 });
    intake.reconcileJobs(env, true);
    expect(stored(job)).toMatchObject({ status: 'queued', autoRetry: { count: 1 } });
    intake.reconcileJobs(env, true);
    intake.reconcileJobs(env);
    expect(stored(job).autoRetry.count).toBe(1);
  });

  it.each(['legacy', 'stopped', 'exhausted', 'disabled', 'kill switch'])('keeps dead %s jobs interrupted', (kind) => {
    const patch: intake.JobRecord = { status: 'running', workerPid: 999999 };
    if (kind === 'legacy') patch.autoRetry = undefined;
    if (kind === 'stopped') patch.stopRequested = true;
    if (kind === 'exhausted') patch.autoRetry = { count: 3, max: 3 };
    if (kind === 'disabled') putStudioSettings({ autoRetry: { enabled: false } }, env.MANHWA_OUT_DIR);
    if (kind === 'kill switch') env.MANHWA_AUTO_RETRY = '0';
    const job = craftJob(patch);
    intake.reconcileJobs(env);
    expect(stored(job).status).toBe('interrupted');
  });
});

describe('finished chapter filter', () => {
  it.each([
    ['video-ok', false, false], ['video-failed', false, true],
    ['video-ok', true, true], ['ok', false, true], ['missing', false, false],
  ])('status %s, older video %s, reruns %s', async (status, older, reruns) => {
    const video = write(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'), 'not a valid mp4');
    if (status !== 'missing') write(path.join(sdir, 'out', 'ch1', 'report.json'), JSON.stringify({ status }));
    if (older) fs.utimesSync(video, new Date(0), new Date(0));
    const marker = path.join(root, 'ran');
    const job = craftJob({ onlyUnrendered: true });
    await intake.executeSingleJob(job, { env, runCmdOverride: writeRunner(0, undefined, `fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`) });
    expect(fs.existsSync(marker)).toBe(reruns);
    expect(stored(job).status).toBe('completed');
  });
});

describe('Studio autoRetry settings', () => {
  it('defaults and normalizes malformed stored values', () => {
    expect(defaultStudioSettings().autoRetry).toEqual({ enabled: true, maxRetries: 3 });
    write(path.join(env.MANHWA_OUT_DIR!, 'config', 'settings.json'), JSON.stringify({ autoRetry: { enabled: 'false', maxRetries: 99 } }));
    expect(getStudioSettings().autoRetry).toEqual({ enabled: true, maxRetries: 3 });
  });

  it('merges partial writes and enforces revision conflicts', () => {
    const first = putStudioSettings({ autoRetry: { maxRetries: 5 } });
    expect(first.autoRetry).toEqual({ enabled: true, maxRetries: 5 });
    expect(putStudioSettings({ expectedRevision: first.revision, autoRetry: { enabled: false } }).autoRetry)
      .toEqual({ enabled: false, maxRetries: 5 });
    expect(() => putStudioSettings({ expectedRevision: first.revision, autoRetry: { enabled: true } })).toThrow(/Revision conflict/);
  });

  it.each([null, [], false, { enabled: 'yes' }, { maxRetries: 0 }, { maxRetries: 6 }, { maxRetries: 1.5 }, { maxRetries: '3' }])('rejects invalid setting %j', (value) => {
    expect(() => putStudioSettings({ autoRetry: value as never })).toThrow();
    expect(getStudioSettings().revision).toBe(0);
  });

  it('supports partial PUT and rejects invalid values through the Studio API', async () => {
    server = http.createServer((req, res) => {
      void handleStudioRoute(req, res, '/api/studio/settings', new URL(req.url!, 'http://localhost'),
        { user: 'test', privileged: true, csrfToken: 'test-csrf', exp: Date.now() + 60000, isTemp: false },
        (response, status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/studio/settings`;
    const put = (body: unknown) => fetch(url, { method: 'PUT', headers: { origin: new URL(url).origin, 'content-type': 'application/json', 'x-csrf-token': 'test-csrf' }, body: JSON.stringify(body) });
    const response = await put({ autoRetry: { enabled: false }, revision: 0 });
    expect(response.status).toBe(200);
    expect((await response.json() as { autoRetry: unknown }).autoRetry).toEqual({ enabled: false, maxRetries: 3 });
    expect((await put({ autoRetry: { maxRetries: 0 } })).status).toBe(400);
    expect((await put({ autoRetry: { maxRetries: 2 }, revision: 0 })).status).toBe(409);
  });
});
