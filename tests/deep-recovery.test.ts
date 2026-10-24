/**
 * DEEP RECOVERY / FAULT-INJECTION SUITE (test-only; no production changes).
 *
 * Scope: batch/chapter failure, retry, resume and recovery across
 *   run.ts chapter loop -> reader batches -> writer/check -> audio/timeline
 *   (cleaner) -> renderlane worker -> intake job/report/retry.
 *
 * Nothing here calls a real LLM, TTS provider, ML tool or remote render lane.
 * - reader: `_setCallForTests`
 * - writer / fact check / promo block / renderlane worker: injected `_hooks`
 * - audio: a local fake external-TTS python command (real subprocess, real ffmpeg)
 * - cleaner: a fake PanelCleaner python that exits non-zero (real subprocess path)
 * - render: injected subprocess runner (no Remotion)
 * - intake: real child processes running tiny local node scripts
 *
 * Every filesystem write is under /tmp/opencode. The v1 tree is never touched.
 * Regression tests pin the previously-defective recovery behaviour as fixed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import * as runCli from '../src/cli/run.js';
import * as renderlane from '../src/workers/renderlane.js';
import * as reader from '../src/stages/reader.js';
import * as writer from '../src/stages/writer.js';
import * as audio from '../src/stages/audio.js';
import * as telemetry from '../src/telemetry/telemetry.js';
import * as intake from '../src/intake/intake.js';
import { CAPTION_VERSION, batchDir } from '../src/contracts/hashes.js';
import { flockFd } from '../src/locks/seriesLock.js';

/* ------------------------------------------------------------------ *
 * global scratch
 * ------------------------------------------------------------------ */

const TMP_ROOT = '/tmp/opencode';
fs.mkdirSync(TMP_ROOT, { recursive: true });
// cleaner.ts / audio.ts call os.tmpdir(); keep their scratch inside the approved root.
process.env.TMPDIR = TMP_ROOT;

/**
 * Fake PanelCleaner install: the real cleaner `_runPanelCleaner` spawns its python
 * and it exits non-zero. With PC_FAKE_SIGNAL=1 it kills itself instead, so
 * `spawnSync.status` is null and only `signal` is set.
 */
const PC_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'pcleaner-'));
const PC_PY = path.join(PC_DIR, 'venv', 'bin', 'python');
fs.mkdirSync(path.dirname(PC_PY), { recursive: true });
fs.mkdirSync(path.join(PC_DIR, 'config', 'pcleaner'), { recursive: true });
fs.mkdirSync(path.join(PC_DIR, 'cache', 'model'), { recursive: true });
fs.writeFileSync(path.join(PC_DIR, 'config', 'pcleaner', 'pcleanerrc'), '[General]\n');
fs.writeFileSync(path.join(PC_DIR, 'cache', 'model', 'comictextdetector.pt.onnx'), 'fake');
fs.writeFileSync(
  PC_PY,
  [
    '#!/usr/bin/env python3',
    'import os, signal, sys',
    'if os.environ.get("PC_FAKE_SIGNAL"):',
    '    os.kill(os.getpid(), signal.SIGKILL)',
    'sys.stderr.write("fake-pcleaner: detector crashed\\n")',
    'sys.exit(3)',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
process.env.MANHWA_PCLEANER_DIR = PC_DIR;
delete process.env.MANHWA_PCLEANER_PY;

/** timeline.ts captures STUDIO_PUBLIC at import; set it before the dynamic import. */
const STUDIO = fs.mkdtempSync(path.join(TMP_ROOT, 'studio-'));
process.env.MANHWA_STUDIO = STUDIO;
process.env.MANHWA_STUDIO_PUBLIC = path.join(STUDIO, 'public');

const tmpRoots: string[] = [];
const ORIGINAL_ENV = { ...process.env };

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: { mockRestore: () => void };
let logs: string[] = [];
let stderr: string[] = [];
let TTS_FIXTURE = '';

function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function completion(content: string): unknown {
  return { choices: [{ message: { content } }], usage: { total_tokens: 1 } };
}

beforeAll(() => {
  TTS_FIXTURE = path.join(TMP_ROOT, 'fixture-440.mp3');
  if (!fs.existsSync(TTS_FIXTURE)) {
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-q:a', '9', TTS_FIXTURE],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`);
  }
});

beforeEach(async () => {
  (await import('../src/stages/cleaner.js'))._breaker.reset();
  logs = [];
  stderr = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never) as unknown as { mockRestore: () => void };
  telemetry._reset();
  runCli._resetHooksForTests();
  renderlane._resetHooksForTests();
});

afterEach(() => {
  runCli._resetHooksForTests();
  renderlane._resetHooksForTests();
  telemetry._reset();
  vi.restoreAllMocks();
  // restore only the keys this suite mutates
  for (const key of [
    'PIPELINE_STATUS_DIR',
    'PIPELINE_LOG',
    'MANHWA_SERIES_ROOT',
    'MANHWA_JOBS_DIR',
    'MANHWA_NO_AUTO_WORKER',
    'MANHWA_RENDER_LANE',
    'MANHWA_RENDER_REMOTE',
    'MANHWA_RENDER_CLOUD',
    'TTS_LOG',
    'TTS_FAIL',
    'TTS_FIXTURE',
    'TTS_CALLS',
  ]) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

afterAll(() => {
  for (const dir of tmpRoots.splice(0)) rmrf(dir);
});

/* ------------------------------------------------------------------ *
 * run.ts harness: real orchestrator, injected stage hooks
 * ------------------------------------------------------------------ */

interface SeriesFixture {
  root: string;
  sdir: string;
  out: string;
}

function makeSeries(root: string, series: string, chapters: string[], pages = 2): SeriesFixture {
  const sdir = path.join(root, series);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(
    path.join(sdir, 'meta.json'),
    JSON.stringify({ title: series, tts: { engine: 'edge' } }),
  );
  for (const ch of chapters) {
    const chdir = path.join(sdir, ch);
    fs.mkdirSync(chdir, { recursive: true });
    for (let i = 1; i <= pages; i++) {
      fs.writeFileSync(path.join(chdir, `p${String(i).padStart(4, '0')}.jpg`), Buffer.from('x'));
    }
  }
  const out = path.join(sdir, 'out');
  fs.mkdirSync(out, { recursive: true });
  return { root, sdir, out };
}

interface RunHooksOptions {
  readChapter?: (chdir: string, outDir: string) => Promise<unknown>;
  writeScript?: (outPath: string, ch: string) => Promise<string>;
  worker?: (
    sdir: string,
    out: string,
    q: renderlane.RenderQueue<string | null>,
    results: Record<string, renderlane.VideoResult>,
  ) => Promise<void>;
  sleeps?: number[];
}

function installRunHooks(opts: RunHooksOptions = {}): { sleeps: number[] } {
  const sleeps = opts.sleeps ?? [];
  const defaultRead = async (): Promise<unknown> => ({
    panels: [{ id: 'p0001_1', visual: 'v', art: 0.9 }, { id: 'p0001_2', visual: 'v', art: 0.9 }],
    characters: [],
    gags: [],
    events: [],
  });
  const defaultWrite = async (outPath: string): Promise<string> => {
    const script = '## BEAT b01\nHe runs. @p0001_1\nShe waits. @p0001_2\n';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, script);
    return script;
  };
  const defaultWorker = async (
    _sdir: string,
    _out: string,
    q: renderlane.RenderQueue<string | null>,
    results: Record<string, renderlane.VideoResult>,
  ): Promise<void> => {
    for (;;) {
      const ch = await q.get();
      if (ch === null) {
        q.taskDone();
        return;
      }
      results[ch] = { status: 'video-ok', video: `${ch}.mp4`, duration: 12 };
      q.taskDone();
    }
  };
  runCli._hooks.readChapter = (async (chdir: string, outDir: string) =>
    opts.readChapter ? opts.readChapter(chdir, outDir) : defaultRead()) as unknown as typeof runCli._hooks.readChapter;
  runCli._hooks.writeScript = (async (
    _obs: unknown,
    _bible: unknown,
    _panelsDir: string,
    outPath: string,
  ) => {
    const ch = path.basename(path.dirname(outPath));
    return opts.writeScript ? opts.writeScript(outPath, ch) : defaultWrite(outPath);
  }) as unknown as typeof runCli._hooks.writeScript;
  runCli._hooks.panelTranscript = (() => 'p0001_1 | transcript') as unknown as typeof runCli._hooks.panelTranscript;
  runCli._hooks.factCheck = { check: () => [] } as unknown as typeof runCli._hooks.factCheck;
  runCli._hooks.promoBlock = { ensure: () => null } as unknown as typeof runCli._hooks.promoBlock;
  runCli._hooks.renderlane = {
    worker: opts.worker ?? defaultWorker,
  } as unknown as typeof runCli._hooks.renderlane;
  runCli._hooks.time = {
    now: () => Date.now() / 1000,
    sleep: async (seconds: number) => {
      sleeps.push(seconds);
    },
  } as unknown as typeof runCli._hooks.time;
  return { sleeps };
}

function installTelemetryEnv(): void {
  const dir = makeTemp('telemetry');
  setEnv({
    PIPELINE_STATUS_DIR: path.join(dir, 'status'),
    PIPELINE_LOG: path.join(dir, 'pipeline.log'),
  });
}

/* ================================================================== *
 * 1. run.ts chapter retry / classification / chain policy
 * ================================================================== */

describe('run.ts chapter retry and chain policy', () => {
  it('transient reader failure retries in place and then succeeds', async () => {
    const root = makeTemp('run-retry');
    const series = makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let calls = 0;
    const { sleeps } = installRunHooks({
      readChapter: async () => {
        calls += 1;
        if (calls === 1) throw new Error('429 too many requests');
        return { panels: [{ id: 'p0001_1' }], characters: [], gags: [], events: [] };
      },
    });

    const code = await runCli._runLocked(series.sdir.split(path.sep).pop()!, ['ch1'], {
      video: false,
    });

    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60]);
    const report = readJson(path.join(series.out, 'ch1', 'report.json'));
    expect(report.status).toBe('ok');
    expect(fs.existsSync(path.join(series.out, 'ch1', 'script.md'))).toBe(true);
  });

  it('persistent transient failure exhausts exactly RETRY_ROUNDS with [60,240] waits, halts the chain', async () => {
    expect(runCli.RETRY_ROUNDS).toBe(2);
    expect(runCli.RETRY_WAITS).toEqual([60, 240]);
    const root = makeTemp('run-exhaust');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2', 'ch3']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let calls = 0;
    const { sleeps } = installRunHooks({
      readChapter: async () => {
        calls += 1;
        throw new Error('provider returned 503');
      },
    });

    const code = await runCli._runLocked(series.sdir.split(path.sep).pop()!, ['ch1', 'ch2', 'ch3'], {
      video: false,
    });

    expect(code).toBe(1);
    expect(calls).toBe(3); // one chapter, three attempts
    expect(sleeps).toEqual([60, 240]);
    const report = readJson(path.join(series.out, 'ch1', 'report.json'));
    expect(report.status).toBe('failed');
    expect(report.class).toBe('transient');
    expect(String(report.error)).toContain('503');
    // chain policy: later chapters were never started
    expect(fs.existsSync(path.join(series.out, 'ch2', 'script.md'))).toBe(false);
    expect(fs.existsSync(path.join(series.out, 'ch3', 'script.md'))).toBe(false);
    expect(logs.join('\n')).toContain('HALTED at ch1 per chain policy');
  });

  it('permanent failure halts at once with no retry and no sleep', async () => {
    const root = makeTemp('run-permanent');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let calls = 0;
    const { sleeps } = installRunHooks({
      readChapter: async () => {
        calls += 1;
        throw new Error('moderation blocked by provider');
      },
    });

    const code = await runCli._runLocked('demo', ['ch1', 'ch2'], { video: false });

    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(readJson(path.join(series.out, 'ch1', 'report.json')).class).toBe('permanent');
    expect(fs.existsSync(path.join(series.out, 'ch2', 'script.md'))).toBe(false);
  });

  it('writer failure retries the chapter; the reader hook is called again (cache contract owned by reader)', async () => {
    const root = makeTemp('run-writer-retry');
    const series = makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let reads = 0;
    let writes = 0;
    const { sleeps } = installRunHooks({
      readChapter: async () => {
        reads += 1;
        return { panels: [{ id: 'p0001_1' }], characters: [], gags: [], events: [] };
      },
      writeScript: async (outPath: string) => {
        writes += 1;
        if (writes === 1) throw new Error('writer returned empty content (not saving)');
        const script = '## BEAT b01\nLine. @p0001_1\n';
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, script);
        return script;
      },
    });

    const code = await runCli._runLocked('demo', ['ch1'], { video: false });

    expect(code).toBe(0);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    expect(sleeps).toEqual([60]);
    expect(readJson(path.join(series.out, 'ch1', 'report.json')).status).toBe('ok');
  });

  it('--force is forwarded to readChapter only on attempt 0, so retries resume paid batches', async () => {
    const root = makeTemp('run-force-retry');
    const series = makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    const forces: boolean[] = [];
    runCli._hooks.readChapter = (async (
      _chdir: string,
      _out: string,
      force: boolean,
    ) => {
      forces.push(Boolean(force));
      throw new Error('request timed out');
    }) as unknown as typeof runCli._hooks.readChapter;
    runCli._hooks.time = {
      now: () => Date.now() / 1000,
      sleep: async () => {},
    } as unknown as typeof runCli._hooks.time;

    const code = await runCli._runLocked('demo', ['ch1'], { force: true });

    expect(code).toBe(1);
    // reader.readChapter deletes out/panels/<ch>, out/batches/<ch>/v<cv> and
    // obs_<ch>.json when force is true (src/stages/reader.ts:548-553), so only
    // attempt 0 may force; retries resume from the batches attempt 0 wrote.
    expect(forces).toEqual([true, false, false]);
  });

  it('zero-narration writer output is permanent: one attempt, no sleep', async () => {
    const root = makeTemp('run-zero');
    const series = makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let writes = 0;
    const { sleeps } = installRunHooks({
      writeScript: async (outPath: string) => {
        writes += 1;
        const script = '## BEAT b01\n';
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, script);
        return script;
      },
    });

    const code = await runCli._runLocked('demo', ['ch1'], { video: false });

    expect(code).toBe(1);
    expect(writes).toBe(1);
    expect(sleeps).toEqual([]);
    const report = readJson(path.join(series.out, 'ch1', 'report.json'));
    expect(report.class).toBe('permanent');
    expect(String(report.error)).toContain('0 narration lines');
  });

  it('continuity gate is permanent, writes a failed report, and does not touch later chapters', async () => {
    const root = makeTemp('run-gate');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2', 'ch3']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    installRunHooks();

    const code = await runCli._runLocked('demo', ['ch2', 'ch3'], { video: false });

    expect(code).toBe(1);
    const report = readJson(path.join(series.out, 'ch2', 'report.json'));
    expect(report.status).toBe('failed');
    expect(report.class).toBe('permanent');
    expect(String(report.error)).toContain('continuity gate');
    expect(fs.existsSync(path.join(series.out, 'ch3', 'report.json'))).toBe(false);
    expect(fs.existsSync(path.join(series.out, 'ch1', 'script.md'))).toBe(false);
  });

  it('a rerun failure preserves prior report.json success fields', async () => {
    const root = makeTemp('run-report-clobber');
    const series = makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    const priorDir = path.join(series.out, 'ch1');
    fs.mkdirSync(priorDir, { recursive: true });
    fs.writeFileSync(path.join(priorDir, 'script.md'), '## BEAT b01\nOld line. @p0001_1\n');
    fs.writeFileSync(
      path.join(priorDir, 'report.json'),
      JSON.stringify({ series: 'demo', ch: 'ch1', status: 'ok', lines: 42, issues: ['prior'] }, null, 1),
    );
    const scriptBefore = sha(path.join(priorDir, 'script.md'));
    installRunHooks({
      readChapter: async () => {
        throw new Error('connection reset by peer');
      },
    });

    const code = await runCli._runLocked('demo', ['ch1'], { video: false });

    expect(code).toBe(1);
    const report = readJson(path.join(priorDir, 'report.json'));
    expect(report.status).toBe('failed');
    // prior success evidence (lines/issues) survives the failed rerun
    expect(report.lines).toBe(42);
    expect(report.issues).toEqual(['prior']);
    expect(report.previous_status).toBe('ok');
    expect(String(report.error)).toContain('connection reset by peer');
    // completed work itself is retained
    expect(sha(path.join(priorDir, 'script.md'))).toBe(scriptBefore);
  });

  it('a cached ch2 gets its OWN continuity window, not ch1 stale LAST_WINDOW', async () => {
    const root = makeTemp('run-window-cache');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    // ch2 script is cached: the run must reuse it and never call writeScript for ch2.
    const ch2dir = path.join(series.out, 'ch2');
    fs.mkdirSync(ch2dir, { recursive: true });
    fs.writeFileSync(path.join(ch2dir, 'script.md'), '## BEAT b01\nCached ch2 line. @p0001_1\n');

    const windows: string[] = [];
    let writes = 0;
    installRunHooks({
      writeScript: async (outPath: string) => {
        writes += 1;
        const script = '## BEAT b01\nFresh ch1 line. @p0001_1\n';
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, script);
        // what the real writeScript does: publish THIS chapter's window
        writer.setLastWindow('STALE_CH1_WINDOW');
        return script;
      },
    });
    runCli._hooks.factCheck = {
      check: (_script: unknown, _transcript: unknown, opts: { windowTxt?: string }) => {
        windows.push(String(opts.windowTxt ?? ''));
        return [];
      },
    } as unknown as typeof runCli._hooks.factCheck;

    const code = await runCli._runLocked('demo', ['ch1', 'ch2'], { video: false });

    expect(code).toBe(0);
    expect(writes).toBe(1); // ch2 came from cache
    expect(windows).toHaveLength(2);
    const ch2Window = windows[1]!;
    const expected = writer.previousWindow(series.out, 'ch2')[0];
    expect(expected).toContain('--- ch1 (verbatim');
    expect(ch2Window).toBe(expected);
    expect(ch2Window).not.toContain('STALE_CH1_WINDOW');
  });

  it('telemetry records retrying, then done, for a recovered chapter', async () => {
    const root = makeTemp('run-telemetry');
    makeSeries(root, 'demo', ['ch1']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    let calls = 0;
    installRunHooks({
      readChapter: async () => {
        calls += 1;
        if (calls === 1) throw new Error('request timed out');
        return { panels: [{ id: 'p0001_1' }], characters: [], gags: [], events: [] };
      },
    });

    await runCli._runLocked('demo', ['ch1'], { video: false });

    const data = telemetry._data()!;
    expect(data.state).toBe('completed');
    const stages = data.chapters.ch1!.stages as Record<string, Record<string, unknown>>;
    expect(stages.reader!.state).toBe('done');
    const events = data.events.map((e) => e.message);
    expect(events).toContain('ch1 · reader · retrying');
    expect(events).toContain('ch1 · reader · done');
  });
});

/* ================================================================== *
 * 2. run.ts video lane: merge, failure visibility, no halt
 * ================================================================== */

describe('run.ts video lane failure/report handling', () => {
  it('merges video-ok/video-failed into report.json and returns 1', async () => {
    const root = makeTemp('run-video-merge');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    const { sleeps } = installRunHooks({
      worker: async (_sdir, _out, q, results) => {
        for (;;) {
          const ch = await q.get();
          if (ch === null) {
            q.taskDone();
            return;
          }
          if (ch === 'ch2') {
            results[ch] = { status: 'video-failed', error: 'remotion render failed rc=1' };
          } else {
            results[ch] = { status: 'video-ok', video: 'ch1.mp4', duration: 31 };
          }
          q.taskDone();
        }
      },
    });

    const code = await runCli._runLocked('demo', ['ch1', 'ch2'], { video: true });

    expect(sleeps).toEqual([]);
    expect(code).toBe(1);
    const r1 = readJson(path.join(series.out, 'ch1', 'report.json'));
    const r2 = readJson(path.join(series.out, 'ch2', 'report.json'));
    expect(r1.status).toBe('video-ok');
    expect(r1.duration).toBe(31);
    expect(r2.status).toBe('video-failed');
    expect(String(r2.error)).toContain('remotion render failed');
    expect(logs.join('\n')).toContain('videos: 1 ok | FAILED: ch2');
  });

  it('a video-lane failure does not halt the script lane for later chapters', async () => {
    const root = makeTemp('run-video-no-halt');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2', 'ch3']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    installRunHooks({
      worker: async (_sdir, _out, q, results) => {
        for (;;) {
          const ch = await q.get();
          if (ch === null) {
            q.taskDone();
            return;
          }
          results[ch] = { status: ch === 'ch1' ? 'video-failed' : 'video-ok', error: 'boom' };
          q.taskDone();
        }
      },
    });

    const code = await runCli._runLocked('demo', ['ch1', 'ch2', 'ch3'], { video: true });

    expect(code).toBe(1);
    for (const ch of ['ch1', 'ch2', 'ch3']) {
      expect(fs.existsSync(path.join(series.out, ch, 'script.md'))).toBe(true);
    }
    expect(logs.join('\n')).toContain('videos: 2 ok | FAILED: ch1');
  });
});

/* ================================================================== *
 * 3. renderlane queue: hang / bounded failure / single attempt
 * ================================================================== */

function planLocal(): renderlane.RenderPlan {
  return {
    source: 'persisted',
    legacy: false,
    revision: 1,
    configError: null,
    override: null,
    unavailableGraceS: 5,
    lanes: [
      {
        id: 'local',
        order: 0,
        enabled: true,
        configured: true,
        slots: 1,
        effectiveSlots: 1,
        minSlots: 1,
        maxSlots: 1,
        costTier: 'free',
      },
    ],
  };
}

describe('renderlane worker failure supervision', () => {
  it('a worker that rejects before draining is supervised: queued chapters fail and run.ts exits', async () => {
    const root = makeTemp('run-worker-crash');
    const series = makeSeries(root, 'demo', ['ch1', 'ch2']);
    installTelemetryEnv();
    runCli._setSeriesRootForTests(root);
    installRunHooks({
      worker: async () => {
        throw new Error('no eligible lane');
      },
    });

    // run.ts must not hang at vq.join() when the video worker dies early.
    const code = await runCli._runLocked('demo', ['ch1', 'ch2'], { video: true });

    expect(code).toBe(1);
    for (const ch of ['ch1', 'ch2']) {
      const report = readJson(path.join(series.out, ch, 'report.json'));
      expect(report.status).toBe('video-failed');
      expect(String(report.error)).toContain('no eligible lane');
    }
    expect(stderr.join('\n')).toContain('render worker failed');
  });

  it('grace-expiry drain fails queued chapters deterministically and releases join()', async () => {
    const plan: renderlane.RenderPlan = {
      ...planLocal(),
      unavailableGraceS: 0,
      lanes: [
        {
          id: 'cloud',
          order: 0,
          enabled: true,
          configured: true,
          slots: 1,
          effectiveSlots: 1,
          minSlots: 1,
          maxSlots: 1,
          costTier: 'paid',
        },
      ],
    };
    renderlane.renderPolicy.setTransportDefaults({ cloudName: 'render-box' });
    renderlane._hooks.cloudlane = {
      NAME: 'render-box',
      STUDIO,
      healthy: () => [false, 'box stopped'],
      report: () => {},
      render: () => {},
    } as unknown as typeof renderlane.cloudlane;
    renderlane._hooks.time = {
      now: () => Date.now() / 1000,
      time: () => Date.now() / 1000,
      sleep: async () => {},
    } as unknown as typeof renderlane.time;

    const q = new renderlane.RenderQueue<string | null>();
    q.put('ch1');
    q.put(null);
    const results: Record<string, renderlane.VideoResult> = {};
    const failcounts: Record<string, number> = {};

    await renderlane._workerPlan('scratch', 'scratch', q, results, failcounts, plan);

    expect(results.ch1!.status).toBe('video-failed');
    expect(String(results.ch1!.error)).toContain('no render lane available');
    expect(failcounts.ch1).toBe(1);
    expect(q.unfinished_tasks).toBe(0);
    renderlane.renderPolicy.setTransportDefaults(null);
  });

  it('a failed chapter is attempted exactly once (no video-lane retry) and the queue completes', async () => {
    const plan = planLocal();
    let attempts = 0;
    renderlane._hooks.produce = (async () => {
      attempts += 1;
      throw new Error('cleaner exploded');
    }) as unknown as typeof renderlane.produce;
    renderlane._hooks.time = {
      now: () => Date.now() / 1000,
      time: () => Date.now() / 1000,
      sleep: async () => {},
    } as unknown as typeof renderlane.time;

    const q = new renderlane.RenderQueue<string | null>();
    q.put('ch1');
    q.put(null);
    const results: Record<string, renderlane.VideoResult> = {};
    const failcounts: Record<string, number> = {};

    await renderlane._workerPlan('scratch', 'scratch', q, results, failcounts, plan);

    expect(attempts).toBe(1);
    expect(failcounts.ch1).toBe(1);
    expect(results.ch1!.status).toBe('video-failed');
    // one failure must be recorded as one attempt, not two
    expect(results.ch1!.video_attempts).toBe(1);
    expect(q.unfinished_tasks).toBe(0);
  });

  it('a multi-slot worker is only marked idle after the last in-flight render', async () => {
    const root = makeTemp('produce-idle');
    const series = makeSeries(root, 'demo', ['ch1']);
    const events: Array<{ id: string; status?: unknown }> = [];
    const releases: Array<() => void> = [];
    renderlane._hooks.telemetry = {
      bind: () => {},
      worker: (id: string, details: Record<string, unknown>) =>
        events.push({ id, status: details.status }),
      failed: () => {},
      run: (_ctx: unknown, fn: () => unknown) => fn(),
    } as unknown as typeof telemetry;
    renderlane._hooks.prepare = (async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return ['props.json', 'video.mp4'];
    }) as unknown as typeof renderlane.prepare;
    renderlane._hooks._render = (() => ['video.mp4', 3]) as unknown as typeof renderlane._render;

    const first = renderlane.produce(series.sdir, 'ch1', series.out, {
      log: () => {},
      remote: false,
      workerId: 'local',
    });
    const second = renderlane.produce(series.sdir, 'ch1', series.out, {
      log: () => {},
      remote: false,
      workerId: 'local',
    });
    for (let i = 0; i < 100 && releases.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(releases).toHaveLength(2);
    expect(events.filter((e) => e.status === 'busy')).toHaveLength(2);
    expect(events.filter((e) => e.status === 'idle')).toHaveLength(0);

    releases[0]!();
    await first;
    // the second slot is still rendering: the worker must not look idle yet
    expect(events.filter((e) => e.status === 'idle')).toHaveLength(0);

    releases[1]!();
    await second;
    expect(events.filter((e) => e.status === 'idle')).toHaveLength(1);
  });

  it('prepare() failure propagates through produce() and releases the worker/remote binding', async () => {
    const root = makeTemp('produce-fail');
    const series = makeSeries(root, 'demo', ['ch1']);
    renderlane._hooks.prepare = (async () => {
      throw new Error('timeline: external tts line 1 failed');
    }) as unknown as typeof renderlane.prepare;
    const remoteCalls: boolean[] = [];
    renderlane._hooks.lappy = {
      HOST: '',
      RDIR: '',
      HEAVY: undefined as never,
      withHeavy: ((fn: () => unknown) => fn()) as never,
      useRemote: () => false,
      use_remote: () => false,
      setRemoteForThread: (v: boolean) => remoteCalls.push(v),
      healthy: () => [false, 'off'],
      report: () => {},
      ssh: (() => {}) as never,
      push: (() => {}) as never,
      pull: (() => {}) as never,
      rm: (() => {}) as never,
    } as unknown as typeof renderlane.lappy;

    await expect(
      renderlane.produce(series.sdir, 'ch1', series.out, { log: () => {}, remote: false }),
    ).rejects.toThrow(/external tts line 1 failed/);
    expect(remoteCalls).toEqual([false, false]);
  });
});

/* ================================================================== *
 * 4. reader batch fault injection (real reader, mocked provider)
 * ================================================================== */

async function makeChapterPages(prefix: string, n: number): Promise<string> {
  const parent = makeTemp(prefix);
  const dir = path.join(parent, prefix);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    await sharp({
      create: { width: 40, height: 60, channels: 3, background: { r: 20, g: 30, b: 40 } },
    })
      .jpeg()
      .toFile(path.join(dir, `p0001_${i}.jpg`));
  }
  return dir;
}

function manifestFor(n: number, ch: string): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    panel: `${ch}/p0001_${i + 1}.jpg`,
    page: 1,
    idx: i + 1,
  }));
}

/**
 * reader.loadManifest resolves panel image paths from `<out>/panels/<ch>/`, not
 * from the chapter dir; the real slicer creates them. Copy the page images so the
 * injected `sliceChapter` only has to return the manifest.
 */
function stagePanels(chdir: string, out: string, ch: string): void {
  const target = path.join(out, 'panels', ch);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(chdir)) {
    fs.copyFileSync(path.join(chdir, name), path.join(target, name));
  }
}

function panelsFor(manifest: Array<Record<string, unknown>>, from: number, to: number): unknown[] {
  return manifest.slice(from, to).map((m) => ({
    id: path.basename(String(m.panel)).replace(/\.jpg$/, ''),
    visual: `seen-${String(m.panel)}`,
    art: 0.8,
  }));
}

describe('reader batch failure/resume/corrupt state', () => {
  it('keeps paid batch 0 on disk when batch 1 fails, then resumes with only the missing batch', async () => {
    const chdir = await makeChapterPages('reader-resume', 13);
    const out = makeTemp('reader-resume-out');
    stagePanels(chdir, out, 'reader-resume');
    const manifest = manifestFor(13, 'reader-resume');
    let calls = 0;
    const call = async (_m: unknown, options: { tag?: string }): Promise<unknown> => {
      calls += 1;
      if (String(options.tag).endsWith('b2') && calls === 2) {
        throw new Error('429 too many requests');
      }
      const idx = Number(/b(\d+)$/.exec(String(options.tag))![1]!);
      return completion(JSON.stringify({ panels: panelsFor(manifest, (idx - 1) * 12, idx * 12) }));
    };
    reader._setCallForTests(call as never);
    reader._resetApiCalls();

    await expect(
      reader.readChapter(chdir, out, false, false, null, CAPTION_VERSION, async () => manifest),
    ).rejects.toThrow(/429/);

    const b0 = path.join(batchDir(out, 'reader-resume', CAPTION_VERSION), 'b00.json');
    const b1 = path.join(batchDir(out, 'reader-resume', CAPTION_VERSION), 'b01.json');
    expect(fs.existsSync(b0)).toBe(true);
    expect(fs.existsSync(b1)).toBe(false);
    const b0Hash = sha(b0);

    const obs = await reader.readChapter(
      chdir,
      out,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );

    expect(calls).toBe(3); // b1 ok, b2 failed, b2 resumed
    expect(sha(b0)).toBe(b0Hash); // paid cache byte-identical
    expect(fs.existsSync(b1)).toBe(true);
    expect(obs.panels).toHaveLength(13);
    expect(logs.join('\n')).toContain('batch 1/2 cached');
    const saved = readJson(b0) as { brief_hash?: string };
    expect(saved.brief_hash).toBe(reader.briefHash(CAPTION_VERSION));
    reader._setCallForTests(null);
  });

  it('an unparseable batch is retried twice at two temperatures, then fails without touching batch 0', async () => {
    const chdir = await makeChapterPages('reader-parse', 13);
    const out = makeTemp('reader-parse-out');
    stagePanels(chdir, out, 'reader-parse');
    const manifest = manifestFor(13, 'reader-parse');
    let calls = 0;
    reader._setCallForTests((async (_m: unknown, options: { tag?: string }) => {
      calls += 1;
      if (String(options.tag).endsWith('b2')) return completion('this is not json');
      return completion(JSON.stringify({ panels: panelsFor(manifest, 0, 12) }));
    }) as never);
    reader._resetApiCalls();

    await expect(
      reader.readChapter(chdir, out, false, false, null, CAPTION_VERSION, async () => manifest),
    ).rejects.toThrow(/failed twice/);
    expect(calls).toBe(3); // b1 + two b2 attempts
    expect(fs.existsSync(path.join(batchDir(out, 'reader-parse', CAPTION_VERSION), 'b00.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'obs_reader-parse.json'))).toBe(false);
    reader._setCallForTests(null);
  });

  it('a corrupt batch file is a cache miss and is repaired', async () => {
    const chdir = await makeChapterPages('reader-corrupt-batch', 2);
    const out = makeTemp('reader-corrupt-batch-out');
    stagePanels(chdir, out, 'reader-corrupt-batch');
    const manifest = manifestFor(2, 'reader-corrupt-batch');
    const bdir = batchDir(out, 'reader-corrupt-batch', CAPTION_VERSION);
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'b00.json'), '{');
    let calls = 0;
    reader._setCallForTests((async () =>
      completion(JSON.stringify({ panels: panelsFor(manifest, 0, 2) }))) as never);
    reader._resetApiCalls();

    const obs = await reader.readChapter(
      chdir,
      out,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    calls = reader._apiCallCount();
    expect(calls).toBe(1);
    expect(obs.panels).toHaveLength(2);
    expect(reader._loadCached(path.join(bdir, 'b00.json'))[1]).toBe('ok');
    reader._setCallForTests(null);
  });

  it('a poisoned batch (wrong ids) is deleted and re-read', async () => {
    const chdir = await makeChapterPages('reader-poison', 2);
    const out = makeTemp('reader-poison-out');
    stagePanels(chdir, out, 'reader-poison');
    const manifest = manifestFor(2, 'reader-poison');
    const bdir = batchDir(out, 'reader-poison', CAPTION_VERSION);
    reader._save(path.join(bdir, 'b00.json'), {
      panels: [{ id: 'p0001_99' }],
      characters: [],
      gags: [],
      events: [],
    });
    reader._setCallForTests((async () =>
      completion(JSON.stringify({ panels: panelsFor(manifest, 0, 2) }))) as never);
    reader._resetApiCalls();

    const obs = await reader.readChapter(
      chdir,
      out,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(reader._apiCallCount()).toBe(1);
    expect(obs.panels.map((p) => p.id)).toEqual(['p0001_1', 'p0001_2']);
    expect(reader._loadCached(path.join(bdir, 'b00.json'))[1]).toBe('ok');
    reader._setCallForTests(null);
  });

  it('a stale obs is re-read unless --keep-stale, which returns it with 0 calls', async () => {
    const chdir = await makeChapterPages('reader-stale', 2);
    const out = makeTemp('reader-stale-out');
    stagePanels(chdir, out, 'reader-stale');
    const manifest = manifestFor(2, 'reader-stale');
    fs.writeFileSync(
      path.join(out, 'obs_reader-stale.json'),
      JSON.stringify({ brief_hash: 'deadbeef', caption_version: CAPTION_VERSION, data: { panels: [], characters: [], gags: [], events: [] } }),
    );
    reader._setCallForTests((async () =>
      completion(JSON.stringify({ panels: panelsFor(manifest, 0, 2) }))) as never);
    reader._resetApiCalls();

    const kept = await reader.readChapter(
      chdir,
      out,
      false,
      true,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(reader._apiCallCount()).toBe(0);
    expect(kept.panels).toEqual([]);

    const fresh = await reader.readChapter(
      chdir,
      out,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(reader._apiCallCount()).toBe(1);
    expect(fresh.panels).toHaveLength(2);
    reader._setCallForTests(null);
  });

  it('a corrupt obs file is rebuilt from cached batches with 0 API calls', async () => {
    const chdir = await makeChapterPages('reader-corrupt-obs', 2);
    const out = makeTemp('reader-corrupt-obs-out');
    stagePanels(chdir, out, 'reader-corrupt-obs');
    const manifest = manifestFor(2, 'reader-corrupt-obs');
    reader._save(path.join(batchDir(out, 'reader-corrupt-obs', CAPTION_VERSION), 'b00.json'), {
      panels: panelsFor(manifest, 0, 2),
      characters: [],
      gags: [],
      events: [],
    });
    fs.writeFileSync(path.join(out, 'obs_reader-corrupt-obs.json'), '{');
    reader._setCallForTests(async () => {
      throw new Error('corrupt obs rebuild called the model');
    });
    reader._resetApiCalls();

    const obs = await reader.readChapter(
      chdir,
      out,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(reader._apiCallCount()).toBe(0);
    expect(obs.panels).toHaveLength(2);
    expect(reader._loadCached(path.join(out, 'obs_reader-corrupt-obs.json'))[1]).toBe('ok');
    reader._setCallForTests(null);
  });
});

/* ================================================================== *
 * 5. audio: per-line cache survives a mid-run failure (real process)
 * ================================================================== */

function writeTtsFake(name: string): { script: string; failFile: string; logFile: string } {
  const dir = makeTemp(name);
  const script = path.join(dir, 'fake_tts.py');
  const failFile = path.join(dir, 'fail_from.txt');
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(failFile, '0');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env python3',
      'import json, os, shutil, sys',
      'req = json.load(sys.stdin)',
      'open(os.environ["TTS_LOG"], "a").write(str(req["line_index"]) + "\\n")',
      'limit = int(open(os.environ["TTS_FAIL"]).read().strip())',
      'if req["line_index"] >= limit:',
      '    open(req["output_path"], "wb").write(b"partial")',
      '    sys.exit(1)',
      'shutil.copyfile(os.environ["TTS_FIXTURE"], req["output_path"])',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { script, failFile, logFile };
}

describe('audio external TTS line failure and resume', () => {
  it('keeps completed line mp3s and only synthesizes the missing line on retry', async () => {
    const fake = writeTtsFake('audio-resume');
    fs.writeFileSync(fake.failFile, '1');
    const work = makeTemp('audio-resume-work');
    const env = {
      ...process.env,
      TTS_LOG: fake.logFile,
      TTS_FAIL: fake.failFile,
      TTS_FIXTURE,
    };
    const meta = { engine: 'external', voice_id: 'voice-x', command: [process.env.PYTHON ?? 'python3', fake.script] };
    const lines: Array<[string, string[]]> = [
      ['one', []],
      ['two', []],
      ['three', []],
    ];

    await expect(audio.ttsLinesExternal(lines, work, meta, env)).rejects.toThrow(/external tts line 1 failed/);
    const line0 = path.join(work, 'line_000.mp3');
    expect(fs.existsSync(line0)).toBe(true);
    expect(fs.existsSync(path.join(work, 'line_000.txt'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'line_001.mp3'))).toBe(false);
    const line0Mtime = fs.statSync(line0).mtimeMs;

    fs.writeFileSync(fake.failFile, '99');
    const spans = await audio.ttsLinesExternal(lines, work, meta, env);
    expect(spans).toHaveLength(3);
    const invoked = fs.readFileSync(fake.logFile, 'utf8').trim().split('\n');
    expect(invoked).toEqual(['0', '1', '1', '2']);
    expect(fs.statSync(line0).mtimeMs).toBe(line0Mtime);
  });

  it('rejects a zero-duration provider output and commits no cache entry', async () => {
    const fake = writeTtsFake('audio-zero');
    fs.writeFileSync(fake.failFile, '0');
    fs.writeFileSync(TTS_FIXTURE + '.empty', '');
    const work = makeTemp('audio-zero-work');
    const env = {
      ...process.env,
      TTS_LOG: fake.logFile,
      TTS_FAIL: fake.failFile,
      TTS_FIXTURE: TTS_FIXTURE + '.empty',
    };
    const meta = { engine: 'external', voice_id: 'v', command: ['python3', fake.script] };

    await expect(audio.ttsLinesExternal([['one', []]], work, meta, env)).rejects.toThrow(
      /produced invalid audio|failed/,
    );
    expect(fs.existsSync(path.join(work, 'line_000.mp3'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'line_000.txt'))).toBe(false);
  });

  it('a missing TTS executable fails loudly instead of silently reusing nothing', async () => {
    const work = makeTemp('audio-missing');
    const meta = { engine: 'external', voice_id: 'v', command: ['/nonexistent/tts-binary'] };
    await expect(audio.ttsLinesExternal([['one', []]], work, meta, { ...process.env })).rejects.toThrow(
      /executable not found|invocation failed/,
    );
  });
});

/* ================================================================== *
 * 6. timeline: audio cache, partial output, cleaner failure
 * ================================================================== */

interface TimelineFixture {
  root: string;
  sdir: string;
  out: string;
  ch: string;
  script: string;
  obs: string;
  vdir: string;
  fake: { script: string; failFile: string; logFile: string };
  env: NodeJS.ProcessEnv;
}

async function makeTimelineFixture(name: string, longOverlay = false): Promise<TimelineFixture> {
  const root = makeTemp(name);
  const sdir = path.join(root, 'series');
  const out = path.join(sdir, 'out');
  const ch = 'ch1';
  const panelsDir = path.join(out, 'panels', ch);
  const vdir = path.join(out, ch, 'video');
  fs.mkdirSync(panelsDir, { recursive: true });
  fs.mkdirSync(path.join(out, ch), { recursive: true });
  const panels: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 3; i++) {
    const id = `p0001_${i}`;
    await sharp({
      create: { width: 60, height: 90, channels: 3, background: { r: 40 + i * 10, g: 50, b: 60 } },
    })
      .jpeg()
      .toFile(path.join(panelsDir, `${id}.jpg`));
    panels.push({
      id,
      art: 0.9,
      bubble_at: 'none',
      overlay: longOverlay && i === 1 ? ['this bubble text is definitely longer than forty characters'] : [],
      world: [],
    });
  }
  fs.writeFileSync(
    path.join(panelsDir, 'manifest.json'),
    JSON.stringify(
      panels.map((p, i) => ({
        panel: `${String(p.id)}.jpg`,
        page: 1,
        idx: i + 1,
        art_top: 0,
        art_bottom: 1,
      })),
    ),
  );
  const script = path.join(out, ch, 'script.md');
  const scriptBody =
    '## BEAT b01\nHe runs fast. @p0001_1\nShe waits here. @p0001_2\nThey leave now. @p0001_3\n';
  fs.writeFileSync(script, scriptBody);
  // engine=external reads script_voice.md (timeline.main swaps the path)
  fs.writeFileSync(path.join(out, ch, 'script_voice.md'), scriptBody);
  const obs = path.join(out, `obs_${ch}.json`);
  fs.writeFileSync(obs, JSON.stringify({ panels, characters: [], gags: [], events: [] }));
  const fake = writeTtsFake(`${name}-tts`);
  fs.writeFileSync(fake.failFile, '99');
  fs.writeFileSync(
    path.join(sdir, 'meta.json'),
    JSON.stringify({
      title: name,
      tts: {
        engine: 'external',
        voice_id: 'voice-x',
        command: ['python3', fake.script],
        settings: { timeout: 30 },
      },
      visuals: { background: 'starfield', motion: 'cut' },
    }),
  );
  return {
    root,
    sdir,
    out,
    ch,
    script,
    obs,
    vdir,
    fake,
    env: { ...process.env, TTS_LOG: fake.logFile, TTS_FAIL: fake.failFile, TTS_FIXTURE },
  };
}

describe('timeline audio/cleaner recovery', () => {
  it('writes shots.json only after audio succeeds and reuses the narration cache on rerun', async () => {
    const timeline = await import('../src/stages/timeline.js');
    const fx = await makeTimelineFixture('timeline-ok');
    const props = await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(fs.existsSync(props)).toBe(true);
    expect(fs.existsSync(path.join(fx.vdir, 'narration.mp3'))).toBe(true);
    expect(fs.readFileSync(fx.fake.logFile, 'utf8').trim().split('\n')).toEqual(['0', '1', '2']);
    const callsAfterFirst = fs.readFileSync(fx.fake.logFile, 'utf8');

    const again = await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(again).toBe(props);
    expect(fs.readFileSync(fx.fake.logFile, 'utf8')).toBe(callsAfterFirst);
    expect(logs.join('\n')).toContain('tts: cache hit');
  });

  it('passes a valid visuals.animation into shots.json props and drops an invalid one', async () => {
    const timeline = await import('../src/stages/timeline.js');
    const fx = await makeTimelineFixture('timeline-animation');
    const metaPath = path.join(fx.sdir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.visuals = { background: 'starfield', motion: 'window', animation: { entry: 'fade', exit: 'zoom-out', entryS: 0.3, pushIn: 'strong', drift: false } };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const props = JSON.parse(fs.readFileSync(await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env }), 'utf8'));
    expect(props.animation).toEqual({ entry: 'fade', exit: 'zoom-out', entryS: 0.3, pushIn: 'strong', drift: false });
    expect(props.motion).toBe('window');

    meta.visuals.animation = { entry: 'spin' };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const again = JSON.parse(fs.readFileSync(await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env }), 'utf8'));
    expect('animation' in again).toBe(false);
  });

  it('a mid-audio failure leaves no shots.json, retains completed lines, and resumes without re-billing line 0', async () => {
    const timeline = await import('../src/stages/timeline.js');
    const fx = await makeTimelineFixture('timeline-audio-fail');
    fs.writeFileSync(fx.fake.failFile, '1');
    const shots = path.join(fx.vdir, 'shots.json');

    await expect(
      timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env }),
    ).rejects.toThrow(/external tts line 1 failed/);
    expect(fs.existsSync(shots)).toBe(false);
    const lineDir = path.join(fx.vdir, 'tts_lines_external');
    expect(fs.existsSync(path.join(lineDir, 'line_000.mp3'))).toBe(true);
    const line0Mtime = fs.statSync(path.join(lineDir, 'line_000.mp3')).mtimeMs;

    fs.writeFileSync(fx.fake.failFile, '99');
    await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(fs.existsSync(shots)).toBe(true);
    const invoked = fs.readFileSync(fx.fake.logFile, 'utf8').trim().split('\n');
    expect(invoked).toEqual(['0', '1', '1', '2']);
    expect(fs.statSync(path.join(lineDir, 'line_000.mp3')).mtimeMs).toBe(line0Mtime);
  });

  it('a cleaner non-zero exit ships the ordinary panel uncleaned instead of failing the chapter', async () => {
    const timeline = await import('../src/stages/timeline.js');
    const fx = await makeTimelineFixture('timeline-cleaner-fail', true);
    const telemetryDir = makeTemp('timeline-cleaner-telemetry');
    setEnv({
      PIPELINE_STATUS_DIR: path.join(telemetryDir, 'status'),
      PIPELINE_LOG: path.join(telemetryDir, 'pipeline.log'),
    });
    telemetry.start('timeline-cleaner-fail', [fx.ch], true);

    const props = await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(fs.existsSync(props)).toBe(true);

    // original ships; no cleaned artifact and no permanent rejection stamp
    expect(fs.existsSync(path.join(fx.out, 'cleaned', fx.ch, 'p0001_1.png'))).toBe(false);
    expect(fs.existsSync(path.join(fx.out, 'cleaned', fx.ch, 'p0001_1.png.done'))).toBe(false);
    expect(fs.existsSync(path.join(fx.out, 'cleaned', fx.ch, 'p0001_1.png.rej'))).toBe(false);

    // the failure is logged, not silent
    const err = stderr.join('\n');
    expect(err).toContain('panelcleaner run failed (rc=3)');
    expect(err).toContain('shipping 1 panel(s) uncleaned');
    const stages = telemetry._data()!.chapters[fx.ch]!.stages as Record<string, Record<string, unknown>>;
    expect(stages.clean!.state).toBe('done');
    telemetry._reset();
  });

  it('a failed promo clean is covered instead of stopping the run', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const root = makeTemp('promo-cover');
    const panels = path.join(root, 'panels');
    fs.mkdirSync(panels, { recursive: true });
    await sharp({ create: { width: 60, height: 90, channels: 3, background: { r: 200, g: 50, b: 50 } } })
      .jpeg()
      .toFile(path.join(panels, 'p0001_1.jpg'));
    const out = await cleaner.coverPromoPanel(
      { id: 'p0001_1', promo_item: true, promo_full: true },
      panels,
      path.join(root, 'cleaned'),
    );
    expect(out).toContain('/covered/');
    expect(fs.existsSync(out!)).toBe(true);
    // no stamp: the next run still tries a proper promo clean
    expect(fs.existsSync(path.join(root, 'cleaned', 'p0001_1.png.done'))).toBe(false);
    const timeline = await import('../src/stages/timeline.js');
    expect(
      timeline._applyCleaned(
        [{ panel: 'p0001_1.jpg' }],
        { p0001_1: { id: 'p0001_1', promo_item: true, promo_full: true } },
        { p0001_1: out },
      ),
    ).toBe(1);
  });

  it('a cleaner crash still fails closed for a promo panel', async () => {
    const timeline = await import('../src/stages/timeline.js');
    expect(() =>
      timeline._applyCleaned(
        [{ panel: 'p0001_1.jpg' }],
        { p0001_1: { id: 'p0001_1', promo_item: true } },
        { p0001_1: null },
      ),
    ).toThrow(/promo safety/);
  });

  it('timeline awaits cleanBatch so a successful clean is applied', async () => {
    const timeline = await import('../src/stages/timeline.js');
    // Shape of the real call site: cleanBatch is async, `res` is awaited and
    // `_applyCleaned` consumes the resolved record.
    const shots = [{ panel: 'p0001_1.jpg' }];
    const items = { p0001_1: { id: 'p0001_1', overlay: ['x'] } };
    const resolved = await Promise.resolve({ p0001_1: '/tmp/cleaned/p0001_1.png' });
    expect(timeline._applyCleaned(shots, items, resolved as never)).toBe(1);
    expect(shots[0]!.panel).toBe('p0001_1.png');

    // A resolved record keeps the promo safety gate armed.
    expect(() =>
      timeline._applyCleaned(
        [{ panel: 'p0001_1.jpg' }],
        { p0001_1: { id: 'p0001_1', promo_item: true } },
        resolved as never,
      ),
    ).not.toThrow();
  });
});

/* ================================================================== *
 * 7. render: incomplete output, fallback, pinned lane
 * ================================================================== */

function installRenderHooks(): void {
  renderlane._hooks.STUDIO = STUDIO;
  renderlane._hooks._capfreeNode = (() => null) as unknown as typeof renderlane._capfreeNode;
  renderlane._hooks._renderRoot = (() => makeTemp('render-root')) as unknown as typeof renderlane._renderRoot;
}

describe('render incomplete output and lane fallback', () => {
  it('a non-zero Remotion exit raises', () => {
    installRenderHooks();
    const video = path.join(makeTemp('render-rc'), 'video.mp4');
    renderlane._hooks.subprocess = {
      run: () => ({ returncode: 1, status: 1, stdout: '', stderr: 'boom' }),
    } as unknown as typeof renderlane.subprocess;
    expect(() => renderlane.renderLocal('shots.json', video)).toThrow(/remotion render failed rc=1/);
    expect(fs.existsSync(video)).toBe(false);
  });

  it('a signal-killed child (status null) is reported as a non-zero returncode', () => {
    // defaultSubprocessRun: res.status === null and res.error === undefined.
    const r = renderlane.subprocess.run([
      process.execPath,
      '-e',
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    expect(r.status).toBeNull();
    expect(r.returncode).toBe(1);
  });

  it('a signal-killed Remotion child (status null) raises instead of accepting the video', () => {
    installRenderHooks();
    const video = path.join(makeTemp('render-killed'), 'video.mp4');
    renderlane._hooks.subprocess = {
      run: () => ({ returncode: 1, status: null, stdout: '', stderr: 'killed' }),
    } as unknown as typeof renderlane.subprocess;
    expect(() => renderlane.renderLocal('shots.json', video)).toThrow(/remotion render failed rc=1/);
    expect(fs.existsSync(video)).toBe(false);
  });

  it('rc=0 with no output file raises (incomplete output is detected)', () => {
    installRenderHooks();
    const video = path.join(makeTemp('render-nofile'), 'video.mp4');
    renderlane._hooks.subprocess = {
      run: () => ({ returncode: 0, status: 0, stdout: '', stderr: '' }),
    } as unknown as typeof renderlane.subprocess;
    expect(() => renderlane.renderLocal('shots.json', video)).toThrow(/remotion render failed rc=0/);
  });

  it('rc=0 with a zero-byte video is rejected instead of accepted as video-ok', () => {
    installRenderHooks();
    const dir = makeTemp('render-empty');
    const video = path.join(dir, 'video.mp4');
    renderlane._hooks.subprocess = {
      run: () => {
        fs.writeFileSync(video, '');
        return { returncode: 0, status: 0, stdout: '', stderr: '' };
      },
    } as unknown as typeof renderlane.subprocess;
    renderlane._hooks.lappy = {
      HOST: '',
      RDIR: '',
      HEAVY: undefined as never,
      withHeavy: ((fn: () => unknown) => fn()) as never,
      useRemote: () => false,
      use_remote: () => false,
      setRemoteForThread: () => {},
      healthy: () => [false, 'off'],
      report: () => {},
      ssh: (() => {}) as never,
      push: (() => {}) as never,
      pull: (() => {}) as never,
      rm: (() => {}) as never,
    } as unknown as typeof renderlane.lappy;
    expect(() => renderlane._render('ch1', 'shots.json', video, () => {})).toThrow(
      /empty video|rc=0/,
    );
  });

  it('laptop then cloud failure falls back to local and reports both lanes down', () => {
    installRenderHooks();
    const video = path.join(makeTemp('render-fallback'), 'video.mp4');
    const order: string[] = [];
    const reports: boolean[] = [];
    renderlane._hooks._probe = (() => 12) as unknown as typeof renderlane._probe;
    renderlane._hooks.lappy = {
      HOST: 'laptop',
      RDIR: 'rw',
      HEAVY: undefined as never,
      withHeavy: ((fn: () => unknown) => fn()) as never,
      useRemote: () => true,
      use_remote: () => true,
      setRemoteForThread: () => {},
      healthy: () => [true, 'ok'],
      report: (ok: boolean) => reports.push(ok),
      ssh: (() => {}) as never,
      push: (() => {}) as never,
      pull: (() => {}) as never,
      rm: (() => {}) as never,
    } as unknown as typeof renderlane.lappy;
    renderlane._hooks.cloudlane = {
      NAME: 'render-box',
      STUDIO,
      healthy: () => [true, 'ok'],
      report: (ok: boolean) => reports.push(ok),
      render: () => {
        order.push('cloud');
        throw new Error('cloud exploded');
      },
    } as unknown as typeof renderlane.cloudlane;
    renderlane._hooks.renderRemote = (() => {
      order.push('laptop');
      throw new Error('ssh died');
    }) as unknown as typeof renderlane.renderRemote;
    renderlane._hooks.renderCloud = (() => {
      order.push('cloud');
      throw new Error('cloud exploded');
    }) as unknown as typeof renderlane.renderCloud;
    renderlane._hooks.renderLocal = (() => {
      order.push('local');
    }) as unknown as typeof renderlane.renderLocal;

    const res = renderlane._render('ch1', 'shots.json', video, () => {}) as [string, number];
    expect(res).toEqual([video, 12]);
    expect(order).toEqual(['laptop', 'cloud', 'local']);
    expect(reports).toEqual([false, false]);
  });

  it('a pinned cloud lane failure raises and never falls back to local', () => {
    installRenderHooks();
    const video = path.join(makeTemp('render-pinned'), 'video.mp4');
    let local = 0;
    renderlane._hooks.lappy = {
      HOST: '',
      RDIR: '',
      HEAVY: undefined as never,
      withHeavy: ((fn: () => unknown) => fn()) as never,
      useRemote: () => false,
      use_remote: () => false,
      setRemoteForThread: () => {},
      healthy: () => [false, 'off'],
      report: () => {},
      ssh: (() => {}) as never,
      push: (() => {}) as never,
      pull: (() => {}) as never,
      rm: (() => {}) as never,
    } as unknown as typeof renderlane.lappy;
    renderlane._hooks.cloudlane = {
      NAME: 'render-box',
      STUDIO,
      healthy: () => [true, 'ok'],
      report: () => {},
      render: () => {
        throw new Error('cloud exploded');
      },
    } as unknown as typeof renderlane.cloudlane;
    renderlane._hooks.renderLocal = (() => {
      local += 1;
    }) as unknown as typeof renderlane.renderLocal;

    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', video, () => {}, 'cloud'),
    ).toThrow(/cloud exploded/);
    expect(local).toBe(0);
  });
});

/* ================================================================== *
 * 8. cleaner unit-level: silent fallback vs loud failure
 * ================================================================== */

describe('cleaner fallback semantics (real cleanBatch, real subprocess)', () => {
  async function onePanel(name: string): Promise<{ panels: string; cleaned: string }> {
    const root = makeTemp(name);
    const panels = path.join(root, 'panels');
    const cleaned = path.join(root, 'cleaned');
    fs.mkdirSync(panels, { recursive: true });
    await sharp({ create: { width: 50, height: 70, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toFile(path.join(panels, 'p0001_1.jpg'));
    return { panels, cleaned };
  }
  const item = [{ id: 'p0001_1', overlay: ['x'.repeat(60)], overlay_chars: 60, world: [] }];
  const whiteOut = async (srcDir: string) => {
    const d = await sharp(path.join(srcDir, 'p0001_1.jpg')).linear(0, 255).raw().toBuffer({ resolveWithObject: true });
    return { p0001_1: { data: new Uint8Array(d.data), width: d.info.width, height: d.info.height } };
  };

  it('a non-zero cleaner exit is retried once, then ships the original with no stamp', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-exit');
    const res = await cleaner.cleanBatch(item, panels, cleaned);
    expect(res).toEqual({ p0001_1: null });
    expect(fs.existsSync(path.join(cleaned, 'p0001_1.png'))).toBe(false);
    expect(fs.existsSync(path.join(cleaned, 'p0001_1.png.done'))).toBe(false);
    // no .rej: the next run retries the panel instead of skipping it forever
    expect(fs.existsSync(path.join(cleaned, 'p0001_1.png.rej'))).toBe(false);
    const err = stderr.join('\n');
    expect(err).toContain('panelcleaner run failed (rc=3)');
    expect(err).toContain(`attempt ${cleaner.PCLEANER_ATTEMPTS}/${cleaner.PCLEANER_ATTEMPTS} failed`);
    expect(err).toContain('shipping 1 panel(s) uncleaned');
  });

  it('a signal-killed cleaner ships the original instead of silently succeeding', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-signal');
    process.env.PC_FAKE_SIGNAL = '1';
    try {
      expect(await cleaner.cleanBatch(item, panels, cleaned)).toEqual({ p0001_1: null });
    } finally {
      delete process.env.PC_FAKE_SIGNAL;
    }
    expect(fs.existsSync(path.join(cleaned, 'p0001_1.png'))).toBe(false);
    expect(stderr.join('\n')).toContain('rc=SIGKILL');
  });

  it('a spawn error (unexecutable python) ships the original and logs it', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-spawn');
    const originalMode = fs.statSync(PC_PY).mode;
    fs.chmodSync(PC_PY, 0o000);
    try {
      expect(await cleaner.cleanBatch(item, panels, cleaned)).toEqual({ p0001_1: null });
    } finally {
      fs.chmodSync(PC_PY, originalMode);
    }
    expect(stderr.join('\n')).toMatch(/EACCES|permission denied|spawn/i);
  });

  it('a failed first attempt is retried and the retry result is used', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-retry');
    const realPc = cleaner._hooks._runPanelCleaner;
    const realVerify = cleaner._hooks.residualOverlay;
    let calls = 0;
    cleaner._hooks._runPanelCleaner = async (srcDir: string) => {
      calls += 1;
      if (calls === 1) throw new Error('panelcleaner failed (rc=1): boom');
      return whiteOut(srcDir);
    };
    cleaner._hooks.residualOverlay = async () => 0;
    try {
      const res = await cleaner.cleanBatch(item, panels, cleaned);
      expect(res.p0001_1).toBe(path.join(cleaned, 'p0001_1.png'));
      expect(calls).toBe(2);
      expect(fs.readFileSync(path.join(cleaned, 'p0001_1.png.done'), 'utf8').trim()).toBe(cleaner._cleanHash([]));
    } finally {
      cleaner._hooks._runPanelCleaner = realPc;
      cleaner._hooks.residualOverlay = realVerify;
    }
  });

  it('a timed-out run is not retried (it already burned its full timeout)', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-timeout');
    const realPc = cleaner._hooks._runPanelCleaner;
    let calls = 0;
    cleaner._hooks._runPanelCleaner = async () => {
      calls += 1;
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    };
    try {
      expect(await cleaner.cleanBatch(item, panels, cleaned)).toEqual({ p0001_1: null });
      expect(calls).toBe(1);
    } finally {
      cleaner._hooks._runPanelCleaner = realPc;
    }
  });

  it('keeps verified outputs stamped by the retired MIT cleaner', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-legacy');
    fs.mkdirSync(cleaned, { recursive: true });
    fs.copyFileSync(path.join(panels, 'p0001_1.jpg'), path.join(cleaned, 'p0001_1.png'));
    fs.writeFileSync(path.join(cleaned, 'p0001_1.png.done'), cleaner._legacyMitHash([]));
    const realPc = cleaner._hooks._runPanelCleaner;
    let calls = 0;
    cleaner._hooks._runPanelCleaner = async () => {
      calls += 1;
      return {};
    };
    try {
      expect((await cleaner.cleanBatch(item, panels, cleaned)).p0001_1).toBe(path.join(cleaned, 'p0001_1.png'));
      expect(calls).toBe(0);
    } finally {
      cleaner._hooks._runPanelCleaner = realPc;
    }
  });

  it('opens the circuit after repeated failed batches and stops spawning the cleaner', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const realPc = cleaner._hooks._runPanelCleaner;
    const realVerify = cleaner._hooks.residualOverlay;
    let calls = 0;
    cleaner._hooks._runPanelCleaner = async () => {
      calls += 1;
      throw new Error('panelcleaner failed (rc=3)');
    };
    process.env.MANHWA_CLEANER_MAX_FAILS = '2';
    try {
      for (let i = 0; i < 4; i++) {
        const { panels, cleaned } = await onePanel(`cleaner-breaker-${i}`);
        expect(await cleaner.cleanBatch(item, panels, cleaned)).toEqual({ p0001_1: null });
      }
      // 2 failed batches x 2 attempts, then the circuit skips the next 2 batches
      expect(calls).toBe(2 * cleaner.PCLEANER_ATTEMPTS);
      expect(cleaner.cleanerCircuitOpen()).toBe(true);
      expect(stderr.join('\n')).toContain('circuit open');
      // half-open after the cooldown: one probe runs, success closes the circuit
      cleaner._breaker.openUntil = Date.now() - 1;
      cleaner._hooks._runPanelCleaner = async (srcDir: string) => whiteOut(srcDir);
      cleaner._hooks.residualOverlay = async () => 0;
      const { panels, cleaned } = await onePanel('cleaner-breaker-probe');
      expect((await cleaner.cleanBatch(item, panels, cleaned)).p0001_1).toBeTruthy();
      expect(cleaner._breaker.fails).toBe(0);
    } finally {
      delete process.env.MANHWA_CLEANER_MAX_FAILS;
      cleaner._hooks._runPanelCleaner = realPc;
      cleaner._hooks.residualOverlay = realVerify;
    }
  });

  it('a verifier outage keeps the original without a permanent .rej', async () => {
    const cleaner = await import('../src/stages/cleaner.js');
    const { panels, cleaned } = await onePanel('cleaner-verifier-down');
    const realPc = cleaner._hooks._runPanelCleaner;
    const realVerify = cleaner._hooks.residualOverlay;
    cleaner._hooks._runPanelCleaner = async (srcDir: string) => whiteOut(srcDir);
    cleaner._hooks.residualOverlay = async () => {
      throw new Error('residual_overlay verifier unavailable: HTTP 429');
    };
    try {
      expect(await cleaner.cleanBatch(item, panels, cleaned)).toEqual({ p0001_1: null });
      expect(fs.existsSync(path.join(cleaned, 'p0001_1.png'))).toBe(false);
      expect(fs.existsSync(path.join(cleaned, 'p0001_1.png.rej'))).toBe(false);
    } finally {
      cleaner._hooks._runPanelCleaner = realPc;
      cleaner._hooks.residualOverlay = realVerify;
    }
  });
});

/* ================================================================== *
 * 9. intake: job failure, retry, crash, reconciliation
 * ================================================================== */

interface JobEnv {
  env: Record<string, string>;
  root: string;
  sdir: string;
}

function makeJobEnv(name: string): JobEnv {
  const root = makeTemp(name);
  const env: Record<string, string> = {
    MANHWA_JOBS_DIR: path.join(root, 'jobs'),
    MANHWA_SERIES_ROOT: path.join(root, 'series'),
    MANHWA_NO_AUTO_WORKER: '1',
    PIPELINE_LOG: path.join(root, 'pipeline.log'),
    PATH: process.env.PATH ?? '',
  };
  fs.mkdirSync(env.MANHWA_JOBS_DIR!, { recursive: true });
  const sdir = path.join(env.MANHWA_SERIES_ROOT!, 'resume-fan');
  fs.mkdirSync(path.join(sdir, 'ch1'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'ch1', '001.jpg'), Buffer.from('page'));
  fs.mkdirSync(path.join(sdir, 'out', 'ch1'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'out', 'ch1', 'script.md'), '## BEAT b01\nLine. @p0001_1\n');
  fs.mkdirSync(path.join(sdir, 'out', 'batches', 'ch1'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'out', 'batches', 'ch1', 'b00.json'), '{"paid":"cache"}');
  return { env, root, sdir };
}

function craftJob(env: Record<string, string>, patch: Record<string, unknown> = {}): string {
  const id = `job-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const now = Date.now() / 1000;
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    slug: 'resume-fan',
    title: 'Resume Fan',
    status: 'queued',
    statusNote: '',
    sourceType: 'local_zip',
    sourceSummary: 'Local ZIP',
    gdriveFileId: null,
    stagedZipPath: null,
    chapters: '1',
    runChapters: [1],
    ingestedChapters: ['ch1'],
    skipIngest: true,
    allowExistingSeries: true,
    tts: { providerId: 'edge', providerLabel: 'Edge', engine: 'edge', voiceId: 'v', voiceLabel: 'V', metaTts: { engine: 'edge' } },
    visuals: { background: 'starfield', motion: 'cut' },
    renderLane: 'inherit',
    createdBy: 'tests',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    workerPid: null,
    workerStartTicks: null,
    runPid: null,
    runStartTicks: null,
    error: null,
    logTail: [],
    ...patch,
  };
  fs.writeFileSync(path.join(env.MANHWA_JOBS_DIR!, `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}

function jobFile(env: Record<string, string>, id: string): Record<string, unknown> {
  return readJson(path.join(env.MANHWA_JOBS_DIR!, `${id}.json`));
}

function writeRunner(name: string, exitCode: number, lines: string[]): string {
  const dir = makeTemp(name);
  const script = path.join(dir, 'runner.mjs');
  fs.writeFileSync(
    script,
    `${lines.map((l) => `process.stdout.write(${JSON.stringify(l + '\n')});`).join('\n')}\nprocess.exit(${exitCode});\n`,
  );
  return script;
}

/**
 * intake.executeSingleJob waits for every "active pipeline run" it can see by
 * scanning /proc before it starts, and that wait has no timeout by default. A
 * real v1 pipeline may be live on this host, so these tests hide foreign
 * processes from the scanner. This mirrors finding R-08 in
 * docs/deep-test-recovery.md; production code is untouched.
 */
function withoutForeignPipelineRuns(): void {
  const real = fs.readdirSync as unknown as (...args: unknown[]) => unknown;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((target: unknown, opts?: unknown) => {
    if (target === '/proc') return [];
    return real(target, opts);
  }) as never);
}

describe('intake job failure, retry, crash and reconciliation', () => {
  beforeEach(() => {
    withoutForeignPipelineRuns();
  });

  it('a pipeline exit 1 marks the job failed, keeps the error and the paid cache, and retry resumes without re-import', async () => {
    const { env, sdir } = makeJobEnv('intake-fail');
    const id = craftJob(env);
    const runner = writeRunner('intake-fail-runner', 1, ['== ch1: READER', '  !! ch1 FAILED (transient): boom']);
    const batchBefore = sha(path.join(sdir, 'out', 'batches', 'ch1', 'b00.json'));

    await intake.executeSingleJob(jobFile(env, id) as never, {
      env: env as never,
      runCmdOverride: [process.execPath, runner],
    });

    const failed = jobFile(env, id);
    expect(failed.status).toBe('failed');
    expect(String(failed.error)).toContain('boom');
    expect(failed.runChapters).toEqual([1]);
    expect(sha(path.join(sdir, 'out', 'batches', 'ch1', 'b00.json'))).toBe(batchBefore);
    expect(fs.existsSync(path.join(sdir, 'out', 'ch1', 'script.md'))).toBe(true);

    const view = intake.retryJob(id, { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const retried = jobFile(env, id);
    expect(retried.retryCount).toBe(1);
    expect(retried.skipIngest).toBe(true);
    expect(retried.runChapters).toEqual([1]);
    expect(sha(path.join(sdir, 'out', 'batches', 'ch1', 'b00.json'))).toBe(batchBefore);
  });

  it('a killed run (exit 137) is failed with the exit code and remains retryable', async () => {
    const { env } = makeJobEnv('intake-crash');
    const id = craftJob(env);
    const runner = writeRunner('intake-crash-runner', 137, ['== ch1: READER']);

    await intake.executeSingleJob(jobFile(env, id) as never, {
      env: env as never,
      runCmdOverride: [process.execPath, runner],
    });

    const failed = jobFile(env, id);
    expect(failed.status).toBe('failed');
    expect(String(failed.error)).toContain('exited with code 137');
    expect(intake.publicJobView(failed, false, env as never).actions).toEqual(['retry', 'continue']);
  });

  it('a successful runner completes the job and keeps the chapter progress', async () => {
    const { env } = makeJobEnv('intake-ok');
    const id = craftJob(env);
    const runner = writeRunner('intake-ok-runner', 0, ['== ch1: WRITER', '   -> queued for video lane']);

    await intake.executeSingleJob(jobFile(env, id) as never, {
      env: env as never,
      runCmdOverride: [process.execPath, runner],
    });

    const done = jobFile(env, id);
    expect(done.status).toBe('completed');
    expect(done.runPid).toBeNull();
    expect(done.ingestedChapters).toEqual(['ch1']);
    expect(String(done.statusNote)).toContain('Completed 1 chapter(s)');
  });

  it('reconcile marks a dead running job interrupted (not auto-rerun) and offers retry', () => {
    const { env } = makeJobEnv('intake-reconcile');
    const id = craftJob(env, { status: 'running', workerPid: 999_999, runPid: null });
    const jobs = intake.reconcileJobs(env as never);
    const job = jobs.find((j) => j.id === id)!;
    expect(job.status).toBe('interrupted');
    expect(String(job.statusNote)).toContain('Interrupted due to worker termination');
    expect(String(job.error)).toContain("'running' state");
    const view = intake.publicJobView(job, true, env as never);
    expect(view.actions).toContain('retry');
    expect((view.logTail as string[]).join('\n')).toContain('RECONCILE');
  });

  it('a running job whose worker PID is alive but whose run PID is dead is reconciled as interrupted', () => {
    const { env } = makeJobEnv('intake-stuck');
    const ticks = intake.getProcStartTicks(process.pid);
    const id = craftJob(env, {
      status: 'running',
      workerPid: process.pid,
      workerStartTicks: ticks,
      runPid: 999_999,
      runStartTicks: null,
    });
    const jobs = intake.reconcileJobs(env as never);
    const job = jobs.find((j) => j.id === id)!;
    expect(job.status).toBe('interrupted');
    expect(String(job.statusNote)).toContain('Interrupted due to worker termination');
    expect(intake.publicJobView(job, false, env as never).actions).toContain('retry');
  });

  it('a corrupt job JSON stays visible as a failed job instead of vanishing', () => {
    const { env } = makeJobEnv('intake-corrupt');
    const id = craftJob(env);
    fs.writeFileSync(path.join(env.MANHWA_JOBS_DIR!, `${id}.json`), '{ not json');
    const listed = intake.listJobs({ includeLogs: false, env: env as never });
    const found = (listed.jobs as Array<{ id: string; status: string }>).find((j) => j.id === id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('failed');
    const view = intake.getJob(id, { env: env as never });
    expect(view.status).toBe('failed');
    expect(String(view.error)).toContain('Corrupt job file');
  });

  it('retryJob on a corrupt job file reports corruption (400), not "Job not found" (404)', () => {
    const { env } = makeJobEnv('intake-corrupt-retry');
    const id = craftJob(env);
    fs.writeFileSync(path.join(env.MANHWA_JOBS_DIR!, `${id}.json`), '{ not json');

    let caught: unknown = null;
    try {
      intake.retryJob(id, { env: env as never, spawnWorker: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(intake.IntakeError);
    const err = caught as { message: string; statusCode: number };
    expect(err.message).toContain('corrupted');
    expect(err.message).not.toContain('not found');
    expect(err.statusCode).toBe(400);
  });

  it('runWorker processes one queued job and the queue lock excludes a second worker', async () => {
    const { env } = makeJobEnv('intake-worker');
    const id = craftJob(env);
    const runner = writeRunner('intake-worker-runner', 0, ['== ch1: READER']);
    const lockPath = path.join(env.MANHWA_JOBS_DIR!, 'queue.lock');
    const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o664);
    flockFd(fd, 'ex', true);
    try {
      const blocked = await intake.runWorkerOnce({ env: env as never, runCmdOverride: [process.execPath, runner] });
      expect(blocked).toEqual({ acquired: false, processed: 0 });
      expect(jobFile(env, id).status).toBe('queued');
    } finally {
      flockFd(fd, 'un');
      fs.closeSync(fd);
    }

    const ran = await intake.runWorkerOnce({ env: env as never, runCmdOverride: [process.execPath, runner] });
    expect(ran).toEqual({ acquired: true, processed: 1 });
    expect(jobFile(env, id).status).toBe('completed');
  });
});
