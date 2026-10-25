import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intake from '../src/intake/intake.js';
import { pauseFileFor } from '../src/domain/runControl.js';

let root: string;
let sdir: string;
let env: Record<string, string>;

function write(file: string, value: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function craftJob(patch: intake.JobRecord = {}): intake.JobRecord {
  const now = Date.now() / 1000;
  const job: intake.JobRecord = {
    schemaVersion: 1, id: `job-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    slug: 'pause-fan', title: 'Pause Fan', status: 'queued', statusNote: '',
    sourceType: 'local_zip', stagedZipPath: null, chapters: '1-2', runChapters: [1, 2],
    ingestedChapters: ['ch1', 'ch2'], skipIngest: true, allowExistingSeries: true,
    tts: { providerId: 'edge', engine: 'edge', metaTts: { engine: 'edge' } },
    visuals: { background: 'starfield', motion: 'cut' }, renderLane: 'inherit',
    createdAt: now, updatedAt: now, startedAt: null, endedAt: null,
    workerPid: null, runPid: null, error: null, logTail: [],
    autoRetry: { count: 0, max: 3, lastFailure: null }, ...patch,
  };
  write(jobFile(job), JSON.stringify(job));
  return job;
}

function jobFile(job: intake.JobRecord): string {
  return path.join(env.MANHWA_JOBS_DIR!, `${job.id}.json`);
}

function stored(job: intake.JobRecord): intake.JobRecord {
  return JSON.parse(fs.readFileSync(jobFile(job), 'utf8'));
}

/** A fake run: `body` runs after helpers that watch MANHWA_PAUSE_FILE. */
function runner(body: string): string {
  const file = path.join(root, `runner-${Math.random().toString(16).slice(2)}.mjs`);
  write(file, `import fs from 'node:fs';
const pf = process.env.MANHWA_PAUSE_FILE;
fs.writeFileSync(${JSON.stringify(path.join(root, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), pf, jobId: process.env.MANHWA_JOB_ID }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn) => { for (let i = 0; i < 500; i++) { if (fn()) return true; await sleep(20); } return false; };
${body}
`);
  return `${process.execPath} ${file}`;
}

const PAUSING_RUNNER = `await waitFor(() => fs.existsSync(pf));
console.log('== PAUSED at ch2');
process.exit(75);`;

/** Start a run; resolves once the fake run is live, with `task` settling at its exit. */
async function startRun(job: intake.JobRecord, body = PAUSING_RUNNER): Promise<{ task: Promise<void> }> {
  env.MANHWA_INTAKE_TEST_RUNNER = runner(body);
  const task = intake.executeSingleJob(job, { env });
  await vi.waitFor(() => expect(stored(job).runPid).toBeGreaterThan(0), { timeout: 10_000 });
  return { task };
}

/** Run to the end. */
async function runToEnd(job: intake.JobRecord, body: string): Promise<void> {
  env.MANHWA_INTAKE_TEST_RUNNER = runner(body);
  await intake.executeSingleJob(job, { env });
}

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/job-pause-');
  env = {
    MANHWA_JOBS_DIR: path.join(root, 'jobs'), MANHWA_SERIES_ROOT: path.join(root, 'series'),
    MANHWA_OUT_DIR: path.join(root, 'out'), MANHWA_NO_AUTO_WORKER: '1',
    PIPELINE_LOG: path.join(root, 'pipeline.log'), PIPELINE_STATUS_DIR: path.join(root, 'status'),
    PATH: process.env.PATH ?? '', MANHWA_AUTO_RETRY: '1', MANHWA_AUTO_RETRY_DELAYS_S: '600,1800,3600',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  fs.mkdirSync(env.MANHWA_JOBS_DIR!, { recursive: true });
  sdir = path.join(env.MANHWA_SERIES_ROOT!, 'pause-fan');
  for (const n of [1, 2]) write(path.join(sdir, `ch${n}`, '001.jpg'), 'page');
  write(path.join(sdir, 'meta.json'), JSON.stringify({
    title: 'Pause Fan', tts: { engine: 'edge' }, visuals: { background: 'starfield', motion: 'window' },
  }));
  // Never see real pipeline runs on this host.
  const real = fs.readdirSync as unknown as (...args: unknown[]) => unknown;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((target: unknown, opts?: unknown) => {
    if (target === '/proc') return [];
    return real(target, opts);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cooperative pause', () => {
  it('pauses at a safe point: status paused with pausedWhere and pauseReason', async () => {
    const job = craftJob();
    const { task } = await startRun(job);
    const view = intake.pauseJob(job.id, env);
    expect(view).toMatchObject({ status: 'running', pauseRequested: true, controlActions: ['resume', 'stop', 'cancel'] });
    expect(view.statusNote).toBe('Pausing: finishing the current step…');
    const pf = pauseFileFor(env.MANHWA_JOBS_DIR!, job.id);
    expect(fs.statSync(pf).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(pf, 'utf8'))).toMatchObject({ by: 'user' });
    await task;
    const done = stored(job);
    expect(done).toMatchObject({
      status: 'paused', paused: true, pauseRequested: false, pausedWhere: 'ch2', pauseReason: 'Paused by user',
      runPid: null, workerPid: null, pauseFile: pf,
    });
    expect(done.pausedAt).toBeGreaterThan(0);
    expect(done.statusNote).toBe('Paused at ch2. Change settings if you want, then Resume.');
    expect(done.autoRetry.count).toBe(0);
    expect(fs.existsSync(pf)).toBe(false);
    const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'));
    expect(argv).toMatchObject({ pf, jobId: job.id });
  }, 20_000);

  it('resumes a paused job as queued, continuing from saved work', async () => {
    const ran = craftJob();
    const { task } = await startRun(ran);
    intake.pauseJob(ran.id, env);
    await task;
    const raw = stored(ran);
    raw.skipIngest = false;
    raw.onlyUnrendered = false;
    write(jobFile(ran), JSON.stringify(raw));
    const view = intake.resumeJob(ran.id, env);
    expect(view).toMatchObject({ status: 'queued', paused: false, pauseRequested: false, pausedWhere: null, pauseReason: null });
    expect(view.statusNote).toBe('Resumed; continuing from saved work');
    expect(stored(ran)).toMatchObject({ onlyUnrendered: true, skipIngest: true, notBefore: null, pausedAt: null });
  }, 20_000);

  it('a resume before the run exits cancels the pause', async () => {
    const job = craftJob();
    const seen = path.join(root, 'seen');
    const { task } = await startRun(job, `await waitFor(() => fs.existsSync(pf));
fs.writeFileSync(${JSON.stringify(seen)}, '1');
await waitFor(() => !fs.existsSync(pf));
console.log('pause cancelled, finishing');
process.exit(0);`);
    intake.pauseJob(job.id, env);
    const pf = pauseFileFor(env.MANHWA_JOBS_DIR!, job.id);
    expect(fs.existsSync(pf)).toBe(true);
    await vi.waitFor(() => expect(fs.existsSync(seen)).toBe(true), { timeout: 10_000 });
    expect(intake.resumeJob(job.id, env)).toMatchObject({ status: 'running', pauseRequested: false, statusNote: 'Pause cancelled' });
    expect(fs.existsSync(pf)).toBe(false);
    await task;
    expect(stored(job)).toMatchObject({ status: 'completed', pauseRequested: false });
  }, 20_000);

  it('stop clears the pause file', async () => {
    const job = craftJob();
    const { task } = await startRun(job, 'await sleep(15000); process.exit(0);');
    intake.pauseJob(job.id, env);
    const pf = pauseFileFor(env.MANHWA_JOBS_DIR!, job.id);
    expect(fs.existsSync(pf)).toBe(true);
    expect(intake.stopJob(job.id, env)).toMatchObject({ status: 'interrupted', pauseRequested: false });
    expect(fs.existsSync(pf)).toBe(false);
    await task;
    expect(stored(job)).toMatchObject({ status: 'interrupted', pauseRequested: false, paused: false });
  }, 20_000);

  it('an auto pause file reason reaches pauseReason', async () => {
    const job = craftJob();
    const reason = 'Vertex TTS rejected the account (HTTP 403: billing disabled). Fix the account in Studio, then Resume.';
    await runToEnd(job, `fs.writeFileSync(pf, JSON.stringify({ at: Date.now(), by: 'auto', reason: ${JSON.stringify(reason)} }), { mode: 0o600 });
console.log('== PAUSED at ch1 narration');
process.exit(75);`);
    expect(stored(job)).toMatchObject({ status: 'paused', pauseReason: reason, pausedWhere: 'ch1 narration' });
  }, 20_000);

  it('rc 1 with a pause requested ends paused without an auto-retry', async () => {
    const job = craftJob();
    const { task } = await startRun(job, `await waitFor(() => fs.existsSync(pf));
console.log('Error: writer exploded');
process.exit(1);`);
    intake.pauseJob(job.id, env);
    await task;
    const done = stored(job);
    expect(done).toMatchObject({ status: 'paused', paused: true, notBefore: null });
    expect(done.autoRetry.count).toBe(0);
    expect(done.statusNote).toBe('Paused. The run stopped on an error first: Error: writer exploded. Resume to try again.');
    expect(fs.existsSync(pauseFileFor(env.MANHWA_JOBS_DIR!, job.id))).toBe(false);
  }, 20_000);

  it('removes a pause file on completion', async () => {
    const job = craftJob();
    const { task } = await startRun(job, `await waitFor(() => fs.existsSync(pf)); process.exit(0);`);
    intake.pauseJob(job.id, env);
    await task;
    expect(stored(job).status).toBe('completed');
    expect(fs.existsSync(pauseFileFor(env.MANHWA_JOBS_DIR!, job.id))).toBe(false);
  }, 20_000);
});

describe('meta re-apply', () => {
  const meta = () => JSON.parse(fs.readFileSync(path.join(sdir, 'meta.json'), 'utf8'));
  const jobTts = { providerId: 'vertex', engine: 'vertex', metaTts: { engine: 'vertex', voice_id: 'Old-Voice' } };

  it('metaApplied stops a re-apply of tts and visuals on resume', async () => {
    const job = craftJob({ metaApplied: true, tts: jobTts, visuals: { background: 'mist-pines', motion: 'duo' } });
    await runToEnd(job, 'process.exit(0);');
    expect(meta()).toMatchObject({ tts: { engine: 'edge' }, visuals: { background: 'starfield', motion: 'window' } });
    expect(meta().tts.voice_id).toBeUndefined();
  }, 20_000);

  it('applies once without metaApplied, then records it', async () => {
    const job = craftJob({ tts: jobTts, visuals: { background: 'mist-pines', motion: 'duo' } });
    await runToEnd(job, 'process.exit(0);');
    expect(meta()).toMatchObject({ tts: { engine: 'vertex', voice_id: 'Old-Voice' }, visuals: { background: 'mist-pines', motion: 'duo' } });
    expect(stored(job).metaApplied).toBe(true);
  }, 20_000);
});

describe('reconcile and legacy controls', () => {
  it('a dead run while paused stays paused', () => {
    const asked = craftJob({ status: 'running', runPid: 999_999_999, workerPid: 999_999_998, pauseRequested: true });
    const frozen = craftJob({ status: 'running', runPid: 999_999_997, workerPid: 999_999_996, paused: true });
    const plain = craftJob({ status: 'running', runPid: 999_999_995, workerPid: 999_999_994, autoRetry: { count: 9, max: 3, lastFailure: null } });
    intake.reconcileJobs(env);
    for (const job of [asked, frozen]) {
      expect(stored(job)).toMatchObject({
        status: 'paused', paused: true, pauseRequested: false, runPid: null, notBefore: null,
        statusNote: 'Paused (the run was restarted). Resume to continue.',
      });
    }
    expect(stored(plain).status).toBe('interrupted');
  });

  it('a legacy job without pauseFile still uses SIGSTOP and SIGCONT', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const job = craftJob({ status: 'running', runPid: process.ppid, runStartTicks: null, runProcessGroup: false });
    expect(intake.pauseJob(job.id, env)).toMatchObject({ status: 'running', paused: true, controlActions: ['resume', 'stop', 'cancel'] });
    expect(kill).toHaveBeenCalledWith(process.ppid, 'SIGSTOP');
    expect(fs.existsSync(pauseFileFor(env.MANHWA_JOBS_DIR!, job.id))).toBe(false);
    expect(intake.resumeJob(job.id, env)).toMatchObject({ status: 'running', paused: false });
    expect(kill).toHaveBeenCalledWith(process.ppid, 'SIGCONT');
  });

  it('controlActions and actions follow each state', () => {
    const now = Date.now() / 1000;
    const view = (patch: intake.JobRecord) => intake.publicJobView({ schemaVersion: 1, id: 'job-1-ab', ...patch }, false, env);
    expect(view({ status: 'running' })).toMatchObject({ controlActions: ['pause', 'stop', 'cancel'], settingsEditable: false });
    expect(view({ status: 'running', pauseRequested: true }).controlActions).toEqual(['resume', 'stop', 'cancel']);
    expect(view({ status: 'running', paused: true }).controlActions).toEqual(['resume', 'stop', 'cancel']);
    expect(view({ status: 'paused', paused: true })).toMatchObject({
      controlActions: ['resume', 'stop', 'cancel', 'settings'], settingsEditable: true,
      actions: ['resume', 'stop', 'cancel', 'settings'],
    });
    expect(view({ status: 'queued' })).toMatchObject({ controlActions: ['pause', 'stop'], settingsEditable: true });
    expect(view({ status: 'queued', notBefore: now + 60 }).actions).toEqual(['retry', 'pause', 'stop', 'cancel']);
    expect(view({ status: 'failed' })).toMatchObject({ actions: ['retry', 'continue', 'settings'], controlActions: ['settings'], settingsEditable: true });
    expect(view({ status: 'interrupted' }).actions).toEqual(['retry', 'continue', 'settings']);
    expect(view({ status: 'completed' })).toMatchObject({ actions: ['continue'], controlActions: [], settingsEditable: false });
    expect(view({ status: 'running', pauseRequested: true }).actions).toEqual(['resume', 'stop', 'cancel']);
  });
});

describe('syncSeriesJobsAfterSettings', () => {
  it('updates only the eligible jobs of the slug', () => {
    const paused = craftJob({ status: 'paused', paused: true });
    const failed = craftJob({ status: 'failed' });
    const done = craftJob({ status: 'completed' });
    const running = craftJob({ status: 'running' });
    const other = craftJob({ status: 'paused', slug: 'other-fan' });
    const tts = { engine: 'vertex', provider: 'vertex-ai', voice_id: 'en-US-Chirp3-HD-Puck' };
    const visuals = { background: 'mist-pines', motion: 'duo' };
    expect(intake.syncSeriesJobsAfterSettings('pause-fan', { tts, visuals }, env)).toBe(2);
    for (const job of [paused, failed]) {
      const after = stored(job);
      expect(after).toMatchObject({ metaApplied: true, visuals, tts: { metaTts: tts, engine: 'vertex', providerId: 'vertex', voiceId: tts.voice_id } });
      expect(after.controlRevision).toBe(1);
    }
    for (const job of [done, running, other]) expect(stored(job).metaApplied).toBeUndefined();
    expect(intake.syncSeriesJobsAfterSettings('pause-fan', { visuals: { background: 'starfield', motion: 'cut' } }, env)).toBe(2);
    expect(stored(paused)).toMatchObject({ tts: { metaTts: tts }, visuals: { background: 'starfield', motion: 'cut' }, controlRevision: 2 });
  });
});

describe('PATCH /api/intake/jobs/:id/settings', () => {
  async function patch(id: string, body: Record<string, unknown>, privileged = true) {
    const { handleIntakeRoute } = await import('../src/player/jobs.js');
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
    req.method = 'PATCH';
    req.headers = { host: 'player.local', origin: 'http://player.local', 'x-csrf-token': 'csrf-1' };
    let result!: { status: number; body: any };
    const route = `/api/intake/jobs/${id}/settings`;
    await handleIntakeRoute(
      req, {} as never, route, new URL(route, 'http://player.local'),
      { user: 'admin', exp: Date.now() + 60_000, isTemp: false, privileged, csrfToken: 'csrf-1' } as never,
      (_res, status, payload) => { result = { status, body: payload }; },
    );
    return result;
  }

  it('validates, refuses running jobs and feeds the next run', async () => {
    const job = craftJob({ status: 'paused', paused: true, chapters: '1', runChapters: [1] });
    expect((await patch(job.id, { renderQuality: 'bad' })).status).toBe(400);
    expect((await patch(job.id, { chapters: 'one;two' })).status).toBe(400);
    expect((await patch(job.id, { renderLane: '../etc' })).status).toBe(400);
    expect((await patch(job.id, { outroConfig: { hookType: 'nope' } })).status).toBe(400);
    expect((await patch(job.id, { command: 'rm' })).status).toBe(400);
    expect((await patch(job.id, { chapters: '9' })).status).toBe(400);
    expect((await patch(job.id, { chapters: '2' }, false)).status).toBe(403);
    const running = craftJob({ status: 'running', slug: 'other-fan', runPid: process.ppid });
    expect(await patch(running.id, { chapters: '2' })).toEqual({ status: 409, body: { error: 'Pause the run first.' } });

    const ok = await patch(job.id, { chapters: '2', renderQuality: '720p', outroConfig: { enabled: false, hookType: 'part2' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: job.id, chapters: '2', renderQuality: '720p', outroConfig: { enabled: false, hookType: 'part2' } });
    expect(stored(job)).toMatchObject({ chapters: '2', runChapters: [2], controlRevision: 1 });
    expect(fs.readFileSync(path.join(env.MANHWA_JOBS_DIR!, `${job.id}.log`), 'utf8')).toContain('SETTINGS: job run settings changed (chapters=2');

    intake.resumeJob(job.id, env);
    await runToEnd(stored(job), 'process.exit(0);');
    const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')).argv as string[];
    expect(argv).toEqual(['pause-fan', 'ch2', '--video']);
  }, 20_000);
});
