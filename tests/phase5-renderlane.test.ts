/**
 * T5.3 Phase 5 worker/render-lane tests, ported from the v1 suites:
 *   pipeline/tests/test_cloudlane.py        -> src/workers/cloudlane.ts
 *   pipeline/tests/test_cloud_lifecycle.py  -> src/workers/cloudlane.ts
 *   pipeline/tests/test_renderlane_cloud.py -> src/workers/renderlane.ts
 * plus src/workers/lappy.ts (probe/health/breaker/HEAVY/withRemote) and
 * src/cli/run.ts helpers (_withHook, _dropHookEcho, failClass,
 * _pullReaderCaptions, status output parity).
 *
 * Offline only: every subprocess is injected through the module runners; every
 * on-disk side effect lives in an isolated temp dir under /tmp/opencode. The v1
 * tree at /home/shair/manhwa-pipeline is never written to.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as cloudlane from '../src/workers/cloudlane.js';
import * as lappy from '../src/workers/lappy.js';
import * as renderlane from '../src/workers/renderlane.js';
import * as runCli from '../src/cli/run.js';
import { CAPTION_VERSION, briefHash, schemaHash } from '../src/contracts/hashes.js';
import { flockFd, tryFlockFd } from '../src/locks/seriesLock.js';

const ORIGINAL_CONSOLE_LOG = console.log;

const TMP_ROOT = '/tmp/opencode';

function tmpdir(prefix: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, prefix));
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ================================================================== *
 * cloudlane: health / breaker / probe cache
 * ================================================================== */

type CaptureCall = { args: string[]; timeout: number | undefined };

function captureMock(impl: (args: string[], timeout?: number) => string): {
  fn: (args: string[], timeout?: number) => string;
  calls: CaptureCall[];
  called: () => boolean;
} {
  const calls: CaptureCall[] = [];
  const fn = (args: string[], timeout?: number): string => {
    calls.push({ args: [...args], timeout });
    return impl(args, timeout);
  };
  return { fn, calls, called: () => calls.length > 0 };
}

describe('cloudlane health and breaker', () => {
  beforeEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
  });

  const probe = (changes: Record<string, unknown> = {}): string =>
    JSON.stringify({ cpus: 8, mem_gb: 12, disk_gb: 29, miss: '', ...changes });

  it('default off does not call sbx', () => {
    const cap = captureMock(() => '');
    cloudlane._ops.capture = cap.fn;
    cloudlane._setNameForTests('');
    expect(cloudlane.healthy()[0]).toBe(false);
    expect(cap.called()).toBe(false);
  });

  it('stopped box check is cached and never wakes it', () => {
    const listing = JSON.stringify({
      sandboxes: [{ name: 'render-box', status: 'stopped' }],
    });
    const cap = captureMock(() => listing);
    cloudlane._ops.capture = cap.fn;
    expect(cloudlane.healthy(0)[0]).toBe(true);
    expect(cloudlane.healthy()[1]).toContain('paused');
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].args).toEqual(['ls', '--json']);
  });

  it('id is supported', () => {
    const listing = JSON.stringify({
      sandboxes: [{ name: 'other', id: 'render-box', status: 'running' }],
    });
    cloudlane._ops.capture = captureMock(() => listing).fn;
    expect(cloudlane.healthy(0)[0]).toBe(true);
  });

  it('missing box opens the breaker after two probes', () => {
    const cap = captureMock(() => '{"sandboxes": []}');
    cloudlane._ops.capture = cap.fn;
    expect(cloudlane.healthy(0)[1]).toContain('not found');
    expect(cloudlane.healthy(0)[0]).toBe(false);
    expect(cloudlane.healthy(0)[1]).toContain('breaker open');
    expect(cap.calls).toHaveLength(2);
  });

  it('missing tools and low resources are rejected by _ready', () => {
    for (const changes of [
      { miss: ' kit-ready' },
      { cpus: 0 },
      { mem_gb: 1 },
      { disk_gb: 1 },
    ]) {
      cloudlane._ops.capture = captureMock(() => probe(changes)).fn;
      expect(() => cloudlane._ready()).toThrow(cloudlane.RuntimeError);
    }
  });

  it('cli failure is fail-open', () => {
    cloudlane._ops.capture = () => {
      throw new cloudlane.FileNotFoundError('sbx');
    };
    expect(cloudlane.healthy(0)[0]).toBe(false);
  });

  it('success resets consecutive job failures', () => {
    cloudlane.report(false);
    cloudlane.report(true);
    cloudlane.report(false);
    expect(cloudlane._state.until).toBe(0);
    cloudlane.report(false);
    expect(cloudlane._state.until).toBeGreaterThan(0);
  });

  it('healthy caches a successful probe until maxAge expires', () => {
    const listing = JSON.stringify({
      sandboxes: [{ name: 'render-box', status: 'running' }],
    });
    const cap = captureMock(() => listing);
    cloudlane._ops.capture = cap.fn;
    expect(cloudlane.healthy(0)).toEqual([true, 'ok']);
    expect(cloudlane.healthy(20)).toEqual([true, 'ok']);
    expect(cap.calls).toHaveLength(1);
    expect(cloudlane.healthy(0)).toEqual([true, 'ok']);
    expect(cap.calls).toHaveLength(2);
  });

  it('exposes the public sbx wrappers through _ops', () => {
    const cap = captureMock(() => 'listing');
    cloudlane._ops.capture = cap.fn;
    expect(cloudlane._capture(['ls', '--json'])).toBe('listing');
    expect(cap.calls[0].args).toEqual(['ls', '--json']);

    const runs: string[][] = [];
    cloudlane._ops.run = (args) => {
      runs.push([...args]);
    };
    cloudlane.exec('true', null);
    expect(runs[0]).toEqual(['exec', 'render-box', 'sh', '-c', 'true']);

    const pushed: string[][] = [];
    cloudlane._ops.push = (src, dst) => {
      pushed.push([src, dst]);
    };
    cloudlane.push('a', 'b', null);
    expect(pushed[0]).toEqual(['a', 'b']);
  });
});

describe('cloudlane TTL budget', () => {
  beforeEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
  });

  const ttl = (changes: Record<string, unknown> = {}): string =>
    JSON.stringify({
      expires_in_seconds: 7200,
      max_remaining_seconds: 80000,
      stopped: false,
      ttl_paused: false,
      ...changes,
    });

  it('paused TTL never gets extended', () => {
    const cap = captureMock(() => ttl({ stopped: true, ttl_paused: true }));
    cloudlane._ops.capture = cap.fn;
    cloudlane._ensureTtl();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].args).toEqual(['ttl', 'render-box', '--json']);
  });

  it('sufficient running deadline is left alone', () => {
    const cap = captureMock(() => ttl());
    cloudlane._ops.capture = cap.fn;
    cloudlane._ensureTtl();
    expect(cap.calls).toHaveLength(1);
  });

  it('only the needed active-job extension is requested', () => {
    const responses = [ttl({ expires_in_seconds: 1200 }), ''];
    const cap = captureMock(() => responses.shift() ?? '');
    cloudlane._ops.capture = cap.fn;
    cloudlane._ensureTtl();
    expect(cap.calls[1].args).toEqual(['ttl', '+4200s', 'render-box']);
  });

  it('hard extension ceiling is not bypassed', () => {
    const cap = captureMock(() => ttl({ expires_in_seconds: 300, max_remaining_seconds: 1200 }));
    cloudlane._ops.capture = cap.fn;
    expect(() => cloudlane._ensureTtl()).toThrow(/ceiling/);
    expect(cap.calls).toHaveLength(1);
  });
});

describe('cloudlane state waits', () => {
  beforeEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
  });

  it('waits through stopping without resuming', async () => {
    const statuses = [{ status: 'stopping' }, { status: 'stopped' }];
    cloudlane._ops.listedBox = () => statuses.shift() ?? { status: 'stopped' };
    const slept: number[] = [];
    const originalSleep = cloudlane.time.sleep;
    cloudlane.time.sleep = async (seconds: number) => {
      slept.push(seconds);
    };
    try {
      const box = await cloudlane._waitState(new Set(['running', 'stopped']));
      expect(box.status).toBe('stopped');
      expect(slept).toEqual([1]);
    } finally {
      cloudlane.time.sleep = originalSleep;
    }
  });

  it('state wait has a deadline', async () => {
    cloudlane._ops.listedBox = () => ({ status: 'stopping' });
    const originalMonotonic = cloudlane.time.monotonic;
    const ticks = [0, 121];
    cloudlane.time.monotonic = () => ticks.shift() ?? 121;
    try {
      await expect(cloudlane._waitState(new Set(['stopped']))).rejects.toThrow(/still stopping/);
    } finally {
      cloudlane.time.monotonic = originalMonotonic;
    }
  });
});

/* ================================================================== *
 * cloudlane: .gate / .use flock lease + auto-pause
 * ================================================================== */

describe('cloudlane lease lifecycle', () => {
  let lockdir: string;
  let captureCalls: string[][];
  let waitStateCalls: Array<Set<string>>;
  let readyCount: number;
  let previousLockdir: string | undefined;

  beforeEach(() => {
    lockdir = tmpdir('p5-cloud-locks-');
    previousLockdir = process.env.MANHWA_RENDER_CLOUD_LOCKDIR;
    process.env.MANHWA_RENDER_CLOUD_LOCKDIR = lockdir;

    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');

    captureCalls = [];
    waitStateCalls = [];
    readyCount = 0;
    cloudlane._ops.listedBox = () => ({
      name: 'render-box',
      id: 'sbx_same',
      status: 'stopped',
    });
    cloudlane._ops.waitState = async (allowed: Set<string>) => {
      waitStateCalls.push(allowed);
      return { name: 'render-box', id: 'sbx_same', status: 'stopped' };
    };
    cloudlane._ops.ready = () => {
      readyCount += 1;
    };
    cloudlane._ops.ensureTtl = () => {};
    cloudlane._ops.capture = (args: string[]) => {
      captureCalls.push([...args]);
      return '';
    };
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
    if (previousLockdir === undefined) delete process.env.MANHWA_RENDER_CLOUD_LOCKDIR;
    else process.env.MANHWA_RENDER_CLOUD_LOCKDIR = previousLockdir;
    rmrf(lockdir);
  });

  it('last job pauses but first completion does not', async () => {
    await cloudlane._lease(async () => {
      await cloudlane._lease(async () => {});
      expect(captureCalls).toHaveLength(0);
    });
    expect(captureCalls).toEqual([['stop', 'render-box']]);
    expect(readyCount).toBe(2);
  });

  it('failed start still pauses the box', async () => {
    cloudlane._ops.ready = () => {
      throw new cloudlane.RuntimeError('kit probe failed');
    };
    await expect(
      cloudlane._lease(async () => {
        throw new Error('job must not begin');
      }),
    ).rejects.toThrow(/kit probe failed/);
    expect(captureCalls).toEqual([['stop', 'render-box']]);
  });

  it('job exception is preserved and the box paused', async () => {
    await expect(
      cloudlane._lease(async () => {
        throw new cloudlane.RuntimeError('render failed');
      }),
    ).rejects.toThrow(/render failed/);
    expect(captureCalls).toEqual([['stop', 'render-box']]);
  });

  it('pause failure does not mask the job result', async () => {
    cloudlane._ops.capture = (args: string[]) => {
      captureCalls.push([...args]);
      throw new cloudlane.RuntimeError('stop API down');
    };
    await cloudlane._lease(async () => {});
    expect(captureCalls).toHaveLength(1);
  });

  it('a remaining shared holder prevents premature pause', async () => {
    // A second holder on the same .use file (another pipeline process or thread)
    // keeps the exclusive pause flock from being taken.
    const useFile = path.join(lockdir, `${sha256('sbx_same')}.use`);
    fs.mkdirSync(lockdir, { recursive: true });
    const extraHolder = fs.openSync(useFile, 'a');
    flockFd(extraHolder, 'sh', false);
    try {
      await cloudlane._lease(async () => {});
      expect(captureCalls).toHaveLength(0);
    } finally {
      try {
        flockFd(extraHolder, 'un');
      } catch {
        // ignore
      }
      fs.closeSync(extraHolder);
    }
    // Once the extra holder is gone the next lease may pause again.
    await cloudlane._lease(async () => {});
    expect(captureCalls).toEqual([['stop', 'render-box']]);
  });

  it('another OS process lease prevents premature pause', async () => {
    const scriptPath = path.join(lockdir, 'lease-child.mjs');
    const outFile = path.join(lockdir, 'child-calls.jsonl');
    const modulePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../src/workers/cloudlane.ts',
    );
    fs.writeFileSync(
      scriptPath,
      [
        `import fs from 'node:fs';`,
        `import * as cloudlane from ${JSON.stringify(modulePath)};`,
        `const outFile = process.argv[2];`,
        `const record = (args) => fs.appendFileSync(outFile, JSON.stringify(args) + '\\n');`,
        `cloudlane._setNameForTests('render-box');`,
        `cloudlane._ops.listedBox = () => ({ name: 'render-box', id: 'sbx_same', status: 'stopped' });`,
        `cloudlane._ops.waitState = async () => ({ status: 'stopped' });`,
        `cloudlane._ops.ready = () => {};`,
        `cloudlane._ops.ensureTtl = () => {};`,
        `cloudlane._ops.capture = (args) => { record(args); return ''; };`,
        `await cloudlane._lease(() => new Promise((resolve) => {`,
        `  process.stdout.write('ENTERED\\n');`,
        `  process.stdin.once('data', () => resolve());`,
        `}));`,
        `process.stdout.write('DONE\\n');`,
      ].join('\n'),
      'utf8',
    );

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, outFile], {
      env: { ...process.env, MANHWA_RENDER_CLOUD_LOCKDIR: lockdir },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      await waitForLine(child, 'ENTERED');
      await cloudlane._lease(async () => {});
      expect(captureCalls).toHaveLength(0);
      child.stdin?.end('go\n');
      await waitForLine(child, 'DONE');
      await waitForExit(child);
      const recorded = fs
        .readFileSync(outFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as string[]);
      expect(recorded).toEqual([['stop', 'render-box']]);
      expect(child.exitCode).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a new job cannot resume during a pending pause', async () => {
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const pausing = new Set<string>();

    // The pause path awaits waitState({'stopped'}), which stays pending until the
    // test releases it, so the .gate is held across the whole pause.
    cloudlane._ops.waitState = async (allowed: Set<string>) => {
      waitStateCalls.push(allowed);
      if (allowed.size === 1 && allowed.has('stopped')) {
        await stopGate;
      }
      return { status: 'stopped' };
    };

    const first = cloudlane._lease(async () => {});
    for (let i = 0; i < 400 && captureCalls.length === 0; i += 1) await sleep(5);
    expect(captureCalls).toEqual([['stop', 'render-box']]);

    // The gate really is held exclusively while the pause is pending.
    const gateFile = path.join(lockdir, `${sha256('sbx_same')}.gate`);
    const probeFd = fs.openSync(gateFile, 'a');
    expect(tryFlockFd(probeFd, 'ex', true)).toBe(false);
    fs.closeSync(probeFd);

    // A second job started now must wait for the pause, not resume the box.
    const childScript = path.join(lockdir, 'waiter.mjs');
    const modulePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../src/workers/cloudlane.ts',
    );
    fs.writeFileSync(
      childScript,
      [
        `import * as cloudlane from ${JSON.stringify(modulePath)};`,
        `cloudlane._setNameForTests('render-box');`,
        `cloudlane._ops.listedBox = () => ({ name: 'render-box', id: 'sbx_same', status: 'stopped' });`,
        `cloudlane._ops.waitState = async () => ({ status: 'stopped' });`,
        `cloudlane._ops.ready = () => process.stdout.write('READY\\n');`,
        `cloudlane._ops.ensureTtl = () => {};`,
        `cloudlane._ops.capture = () => '';`,
        `await cloudlane._lease(async () => {});`,
        `process.stdout.write('DONE\\n');`,
      ].join('\n'),
      'utf8',
    );
    const waiter = spawn(process.execPath, ['--import', 'tsx', childScript], {
      env: { ...process.env, MANHWA_RENDER_CLOUD_LOCKDIR: lockdir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let waiterOut = '';
    waiter.stdout?.on('data', (chunk: Buffer) => {
      waiterOut += chunk.toString('utf8');
    });
    try {
      await sleep(400);
      expect(waiterOut).not.toContain('READY');
      releaseStop();
      await first;
      await waitForLine(waiter, 'DONE');
      await waitForExit(waiter);
      expect(waiterOut).toContain('READY');
      expect(waiter.exitCode).toBe(0);
    } finally {
      releaseStop();
      pausing.clear();
      waiter.kill('SIGKILL');
    }
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function waitForLine(child: ChildProcess, line: string, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child line ${line}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(line)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`child exited (${code}) before printing ${line}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ================================================================== *
 * cloudlane: composition sync and validation
 * ================================================================== */

interface RenderFixture {
  root: string;
  studio: string;
  proj: string;
  props: string;
  video: string;
  log: { write(chunk: string): void };
  render(): Promise<void>;
}

function makeRenderFixture(proj = 'series_ch1'): RenderFixture {
  const root = tmpdir('p5-cloud-');
  const studio = path.join(root, 'studio');
  fs.mkdirSync(path.join(studio, 'src'), { recursive: true });
  fs.writeFileSync(path.join(studio, 'src', 'index.ts'), 'composition');
  for (const name of ['package.json', 'package-lock.json', 'remotion.config.ts', 'tsconfig.json']) {
    fs.writeFileSync(path.join(studio, name), name);
  }
  fs.mkdirSync(path.join(studio, 'public', proj), { recursive: true });
  const props = path.join(root, 'shots.json');
  fs.writeFileSync(props, JSON.stringify({ audio: `${proj}/narration.mp3` }));
  const video = path.join(root, 'video.mp4');
  fs.writeFileSync(video, Buffer.from('original-good-video'));
  const log = { write: (): void => {} };
  return {
    root,
    studio,
    proj,
    props,
    video,
    log,
    render: () => cloudlane.render(props, video, studio, log),
  };
}

describe('cloudlane sync and validation', () => {
  let fixture: RenderFixture;
  let leaseCalls: number;
  let previousStudio: string | undefined;

  beforeEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');
    fixture = makeRenderFixture();
    leaseCalls = 0;
    cloudlane._ops.lease = (fn) => {
      leaseCalls += 1;
      return Promise.resolve(fn());
    };
    previousStudio = undefined;
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
    cloudlane._setStudioForTests(null);
    rmrf(fixture.root);
    void previousStudio;
  });

  it('sync copies only composition and skips the same signature', async () => {
    let remoteMarker = '';
    const captureCalls: string[][] = [];
    const pushSources: string[][] = [];
    const execCommands: string[] = [];
    cloudlane._ops.capture = (args: string[]) => {
      captureCalls.push([...args]);
      return remoteMarker;
    };
    cloudlane._ops.exec = (cmd: string) => {
      execCommands.push(cmd);
    };
    cloudlane._ops.push = (src: string, dst: string) => {
      pushSources.push([src, dst]);
    };

    await cloudlane._syncStudio(fixture.studio, fixture.log);
    expect(pushSources.map((call) => call[0])).toEqual([
      path.join(fixture.studio, 'src'),
      path.join(fixture.studio, 'remotion.config.ts'),
      path.join(fixture.studio, 'tsconfig.json'),
    ]);
    expect(pushSources[0][1]).toBe(cloudlane.STUDIO);
    expect(execCommands).toHaveLength(2);

    // The marker write carries the signature; a second sync with that signature
    // uploaded to the sandbox must skip the copy entirely.
    remoteMarker = execCommands[1].split(' ')[2];
    pushSources.length = 0;
    await cloudlane._syncStudio(fixture.studio, fixture.log);
    expect(pushSources).toHaveLength(0);
  });

  it('dependency mismatch fails before upload', async () => {
    cloudlane._ops.capture = () => {
      throw new cloudlane.RuntimeError('lock mismatch');
    };
    const pushes: string[] = [];
    cloudlane._ops.push = (src: string) => {
      pushes.push(src);
    };
    await expect(cloudlane._syncStudio(fixture.studio, fixture.log)).rejects.toThrow(
      /lock mismatch/,
    );
    expect(pushes).toHaveLength(0);
  });

  it('composition change waits for running jobs', async () => {
    let waiting = false;
    const originalWaitFor = cloudlane._idle.waitFor.bind(cloudlane._idle);
    cloudlane._idle.waitFor = async (predicate: () => boolean) => {
      waiting = true;
      return originalWaitFor(predicate);
    };
    const execCommands: string[] = [];
    cloudlane._ops.capture = captureMock(() => '').fn;
    cloudlane._ops.exec = (cmd: string) => {
      execCommands.push(cmd);
    };
    cloudlane._ops.push = () => {};
    cloudlane._setActiveForTests(1);
    try {
      const sync = cloudlane._syncStudio(fixture.studio, fixture.log);
      for (let i = 0; i < 200 && !waiting; i += 1) await sleep(5);
      expect(waiting).toBe(true);
      expect(execCommands).toHaveLength(0);
      cloudlane._setActiveForTests(0);
      cloudlane._idle.notifyAll();
      await sync;
      expect(execCommands.length).toBeGreaterThan(0);
    } finally {
      cloudlane._idle.waitFor = originalWaitFor;
      cloudlane._setActiveForTests(0);
    }
  });

  it('validation rejects bad, empty and non-finite media', () => {
    const cases: Array<[string, number]> = [
      ['', 1],
      ['0', 0],
      ['nan', 0],
      ['inf', 0],
      ['garbage', 0],
    ];
    for (const [output, status] of cases) {
      cloudlane._setRunnerForTests(() => ({ status, stdout: output, stderr: '' }));
      expect(() => cloudlane._validate(fixture.video)).toThrow(cloudlane.RuntimeError);
    }
    cloudlane._setRunnerForTests(() => ({ status: 0, stdout: '42.0', stderr: '' }));
    expect(() => cloudlane._validate(fixture.video)).not.toThrow();
    cloudlane._setRunnerForTests(null);
  });

  it('digest hashes file bytes', () => {
    const file = path.join(fixture.root, 'bytes.bin');
    fs.writeFileSync(file, Buffer.from('abc'));
    expect(cloudlane._digest(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('cloudlane render', () => {
  let fixture: RenderFixture;

  beforeEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('render-box');
    fixture = makeRenderFixture();
    cloudlane._ops.lease = (fn) => Promise.resolve(fn());
  });

  afterEach(() => {
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
    cloudlane._setStudioForTests(null);
    rmrf(fixture.root);
  });

  const downloaded = (src: string, dst: string): void => {
    fs.writeFileSync(dst, Buffer.from('downloaded-video'));
  };

  it('success uses disk tmpdir, atomic pull and correct nesting', async () => {
    const execCommands: string[] = [];
    const pushCalls: string[][] = [];
    const validateCalls: string[] = [];
    const rmCalls: string[] = [];
    cloudlane._ops.syncStudio = async () => {};
    cloudlane._ops.exec = (cmd: string) => {
      execCommands.push(cmd);
    };
    cloudlane._ops.push = (src: string, dst: string) => {
      pushCalls.push([src, dst]);
    };
    cloudlane._ops.pull = downloaded;
    cloudlane._ops.validate = (video: string) => {
      validateCalls.push(video);
    };
    cloudlane._ops.rm = (remote: string) => {
      rmCalls.push(remote);
    };

    await fixture.render();
    expect(fs.readFileSync(fixture.video, 'utf8')).toBe('downloaded-video');
    expect(fs.existsSync(`${fixture.video}.part`)).toBe(false);
    expect(validateCalls).toEqual([`${fixture.video}.part`]);
    expect(pushCalls[0]).toEqual([
      path.join(fixture.studio, 'public', fixture.proj),
      `${cloudlane.STUDIO}/public`,
    ]);
    const command = execCommands.at(-1) as string;
    expect(command).toContain('TMPDIR=/home/agent/jobs/');
    expect(command).toContain('/tmp TMP=');
    expect(command).toContain('--props=/home/agent/jobs/');
    expect(command).toContain('for slot in 0 1');
    expect(command).toContain('flock -n -E 75');
    expect(rmCalls).toHaveLength(2);
  });

  it('partial download failure keeps the good video and cleans up', async () => {
    const rmCalls: string[] = [];
    cloudlane._ops.syncStudio = async () => {};
    cloudlane._ops.exec = () => {};
    cloudlane._ops.push = () => {};
    cloudlane._ops.pull = (src: string, dst: string) => {
      fs.writeFileSync(dst, Buffer.from('partial'));
      throw new cloudlane.RuntimeError('transfer interrupted');
    };
    cloudlane._ops.rm = (remote: string) => {
      rmCalls.push(remote);
    };
    await expect(fixture.render()).rejects.toThrow(/transfer interrupted/);
    expect(fs.readFileSync(fixture.video, 'utf8')).toBe('original-good-video');
    expect(fs.existsSync(`${fixture.video}.part`)).toBe(false);
    expect(rmCalls).toHaveLength(2);
  });

  it('a bad video is not published', async () => {
    cloudlane._ops.syncStudio = async () => {};
    cloudlane._ops.exec = () => {};
    cloudlane._ops.push = () => {};
    cloudlane._ops.pull = downloaded;
    cloudlane._ops.validate = () => {
      throw new cloudlane.RuntimeError('bad video');
    };
    cloudlane._ops.rm = () => {};
    await expect(fixture.render()).rejects.toThrow(/bad video/);
    expect(fs.readFileSync(fixture.video, 'utf8')).toBe('original-good-video');
    expect(fs.existsSync(`${fixture.video}.part`)).toBe(false);
  });

  it('render failure cleans both remote directories', async () => {
    const rmCalls: string[] = [];
    cloudlane._ops.syncStudio = async () => {};
    cloudlane._ops.exec = () => {
      throw new cloudlane.RuntimeError('render failed');
    };
    cloudlane._ops.rm = (remote: string) => {
      rmCalls.push(remote);
    };
    await expect(fixture.render()).rejects.toThrow(/render failed/);
    expect(rmCalls).toHaveLength(2);
    expect(fs.readFileSync(fixture.video, 'utf8')).toBe('original-good-video');
  });

  it('traversal is rejected before any remote action', async () => {
    for (const audio of ['../narration.mp3', '/absolute.mp3', 'bad name/audio.mp3']) {
      fs.writeFileSync(fixture.props, JSON.stringify({ audio }));
      let execCalls = 0;
      cloudlane._ops.exec = () => {
        execCalls += 1;
      };
      await expect(fixture.render()).rejects.toThrow(cloudlane.ValueError);
      expect(execCalls).toBe(0);
    }
  });

  it('two-render cap and unique remote jobs', async () => {
    let active = 0;
    let peak = 0;
    const jobs: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    cloudlane._ops.syncStudio = async () => {};
    cloudlane._ops.exec = async (cmd: string) => {
      if (!cmd.includes('npx remotion render')) return;
      jobs.push(cmd.split('TMPDIR=')[1].split('/tmp')[0]);
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) entered();
      await gate;
      active -= 1;
    };
    cloudlane._ops.push = () => {};
    cloudlane._ops.pull = downloaded;
    cloudlane._ops.validate = () => {};
    cloudlane._ops.rm = () => {};

    const runs: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i += 1) {
      const proj = `series_ch${i}`;
      fs.mkdirSync(path.join(fixture.studio, 'public', proj), { recursive: true });
      const props = path.join(fixture.root, `shots${i}.json`);
      fs.writeFileSync(props, JSON.stringify({ audio: `${proj}/audio.mp3` }));
      const video = path.join(fixture.root, `video${i}.mp4`);
      runs.push(cloudlane.render(props, video, fixture.studio, fixture.log));
    }
    await enteredPromise;
    expect(active).toBe(2);
    release();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(new Set(jobs).size).toBe(3);
  });
});

/* ================================================================== *
 * lappy: probe / health / breaker / HEAVY / withRemote
 * ================================================================== */

describe('lappy health and breaker', () => {
  type RunnerCall = { args: string[]; timeout: number };

  function runnerMock(impl: (args: readonly string[]) => lappy.RawResult): {
    calls: RunnerCall[];
    runner: lappy.ProcessRunner;
  } {
    const calls: RunnerCall[] = [];
    const runner: lappy.ProcessRunner = (args, timeout) => {
      calls.push({ args: [...args], timeout });
      return impl(args);
    };
    return { calls, runner };
  }

  function probeLine(changes: Record<string, unknown> = {}): string {
    return JSON.stringify({
      load: 0.5,
      cpus: 8,
      mem_gb: 12,
      disk_gb: 29,
      ac: '1',
      miss: '',
      ...changes,
    });
  }

  beforeEach(() => {
    lappy._resetStateForTests();
    lappy._setHostForTests('lappy');
  });

  afterEach(() => {
    lappy._setRunnerForTests(null);
    lappy._resetStateForTests();
    lappy._setHostForTests(null);
  });

  it('parses the last probe line and reports ok', () => {
    const mock = runnerMock(() => ({
      status: 0,
      stdout: `noise line\n${probeLine()}\n`,
      stderr: '',
    }));
    lappy._setRunnerForTests(mock.runner);
    expect(lappy.healthy(0)).toEqual([true, 'ok']);
    expect(mock.calls[0].args).toEqual([...lappy.SSH, 'lappy', expect.any(String)]);
  });

  it('reports on battery but stays available', () => {
    lappy._setRunnerForTests(runnerMock(() => ({
      status: 0,
      stdout: probeLine({ ac: '0' }),
      stderr: '',
    })).runner);
    expect(lappy.healthy(0)).toEqual([true, 'on battery']);
  });

  it('no remote configured is refused without probing', () => {
    const mock = runnerMock(() => ({ status: 0, stdout: probeLine(), stderr: '' }));
    lappy._setRunnerForTests(mock.runner);
    lappy._setHostForTests('');
    expect(lappy.healthy(0)).toEqual([false, 'no remote configured']);
    expect(mock.calls).toHaveLength(0);
  });

  it('unreachable and error probes are rejected', () => {
    lappy._setRunnerForTests(runnerMock(() => ({ status: 255, stdout: '', stderr: 'nope' })).runner);
    expect(lappy.healthy(0)).toEqual([false, 'unreachable over ssh']);
    lappy._resetStateForTests();
    lappy._setRunnerForTests(runnerMock(() => ({
      status: 0,
      stdout: JSON.stringify({ err: 'no worker dir' }),
      stderr: '',
    })).runner);
    expect(lappy.healthy(0)).toEqual([false, 'no worker dir']);
  });

  it('missing tools, low RAM and low disk are rejected', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ miss: ' studio cleaner' }, 'missing tools: studio cleaner'],
      [{ mem_gb: 1 }, 'low RAM 1GB'],
      [{ disk_gb: 1 }, 'low disk 1GB'],
    ];
    for (const [changes, reason] of cases) {
      lappy._resetStateForTests();
      lappy._setRunnerForTests(runnerMock(() => ({
        status: 0,
        stdout: probeLine(changes),
        stderr: '',
      })).runner);
      expect(lappy.healthy(0)).toEqual([false, reason]);
    }
  });

  it('load threshold marks the laptop busy unless load checking is off', () => {
    lappy._setRunnerForTests(runnerMock(() => ({
      status: 0,
      stdout: probeLine({ load: 9, cpus: 8 }),
      stderr: '',
    })).runner);
    expect(lappy.healthy(0)).toEqual([false, 'busy (load 9/8 cpus)']);
    lappy._resetStateForTests();
    lappy._setRunnerForTests(runnerMock(() => ({
      status: 0,
      stdout: probeLine({ load: 9, cpus: 8 }),
      stderr: '',
    })).runner);
    expect(lappy.healthy(0, false)).toEqual([true, 'ok']);
  });

  it('our own job load does not count as busy', () => {
    lappy._setRunnerForTests(runnerMock(() => ({
      status: 0,
      stdout: probeLine({ load: 9, cpus: 8 }),
      stderr: '',
    })).runner);
    lappy.report(true); // own_until = now + 180
    expect(lappy.healthy(0)).toEqual([true, 'ok']);
  });

  it('caches a healthy probe for maxAge seconds', () => {
    const mock = runnerMock(() => ({ status: 0, stdout: probeLine(), stderr: '' }));
    lappy._setRunnerForTests(mock.runner);
    expect(lappy.healthy(0)).toEqual([true, 'ok']);
    expect(lappy.healthy(20)).toEqual([true, 'ok']);
    expect(mock.calls).toHaveLength(1);
    expect(lappy.healthy(0)).toEqual([true, 'ok']);
    expect(mock.calls).toHaveLength(2);
  });

  it('two failures in a row open the breaker', () => {
    lappy._setRunnerForTests(runnerMock(() => ({ status: 0, stdout: probeLine(), stderr: '' })).runner);
    lappy.report(false);
    lappy.report(false);
    const [ok, why] = lappy.healthy(0);
    expect(ok).toBe(false);
    expect(why).toContain('breaker open');
  });

  it('a success resets consecutive failures', () => {
    lappy._setRunnerForTests(runnerMock(() => ({ status: 0, stdout: probeLine(), stderr: '' })).runner);
    lappy.report(false);
    lappy.report(true);
    lappy.report(false);
    expect(lappy._state.until).toBe(0);
    lappy.report(false);
    expect(lappy._state.until).toBeGreaterThan(0);
  });

  it('run, ssh and rsync build the expected commands', () => {
    const calls: string[][] = [];
    lappy._setRunnerForTests((args) => {
      calls.push([...args]);
      return { status: 0, stdout: 'out', stderr: 'err' };
    });
    const written: string[] = [];
    const log = { write: (chunk: string) => written.push(chunk) };

    lappy.ssh('echo hi', log, 30);
    expect(calls[0]).toEqual([...lappy.SSH, 'lappy', 'echo hi']);
    expect(written).toEqual(['out', 'err']);

    lappy.push('src/', 'dst/', log, { delete: true, exclude: ['node_modules', 'public'] });
    expect(calls[1]).toEqual([
      'rsync',
      '-a',
      '-e',
      lappy.SSH.join(' '),
      '--delete',
      '--exclude',
      'node_modules',
      '--exclude',
      'public',
      'src/',
      'lappy:dst/',
    ]);

    lappy.pull('job/video.mp4', 'video.mp4.part', log);
    expect(calls[2]).toEqual(['rsync', '-a', '-e', lappy.SSH.join(' '), 'lappy:job/video.mp4', 'video.mp4.part']);
  });

  it('a failed remote step raises RuntimeError with the rc', () => {
    lappy._setRunnerForTests(() => ({ status: 7, stdout: '', stderr: 'boom' }));
    expect(() => lappy.ssh('false', null)).toThrow(lappy.RuntimeError);
    expect(() => lappy.ssh('false', null)).toThrow(/rc=7/);
  });

  it('rm never masks a completed job', () => {
    lappy._setRunnerForTests(() => {
      throw new Error('ssh died');
    });
    expect(() => lappy.rm('/tmp/x', null)).not.toThrow();
  });

  it('shQuote matches shlex.quote', () => {
    expect(lappy.shQuote('plain')).toBe('plain');
    expect(lappy.shQuote('')).toBe("''");
    expect(lappy.shQuote("a b")).toBe("'a b'");
    expect(lappy.shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('lappy HEAVY and remote context', () => {
  it('serialises heavy sections one at a time', async () => {
    const order: string[] = [];
    const first = lappy.withHeavy(async () => {
      order.push('a-start');
      await sleep(30);
      order.push('a-end');
      return 'a';
    });
    const second = lappy.withHeavy(async () => {
      order.push('b-start');
      await sleep(1);
      order.push('b-end');
      return 'b';
    });
    const [a, b] = await Promise.all([first, second]);
    expect([a, b]).toEqual(['a', 'b']);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(lappy.HEAVY.held).toBe(false);
  });

  it('is reentrant inside one async context', async () => {
    const value = await lappy.withHeavy(async () =>
      lappy.withHeavy(() => 'inner'),
    );
    expect(value).toBe('inner');
    expect(lappy.HEAVY.held).toBe(false);
  });

  it('returns a synchronous value directly when the mutex is free', () => {
    expect(lappy.withHeavy(() => 42)).toBe(42);
    expect(lappy.HEAVY.held).toBe(false);
  });

  it('releases the mutex when the callback throws', () => {
    expect(() =>
      lappy.withHeavy(() => {
        throw new Error('boom');
      }),
    ).toThrow(/boom/);
    expect(lappy.HEAVY.held).toBe(false);
  });

  it('withRemote scopes the remote flag per async context', async () => {
    expect(lappy.useRemote()).toBe(false);
    expect(lappy.withRemote(true, () => lappy.useRemote())).toBe(true);
    expect(lappy.useRemote()).toBe(false);
    const nested = await lappy.withRemote(true, async () => {
      expect(lappy.useRemote()).toBe(true);
      return lappy.useRemote();
    });
    expect(nested).toBe(true);
  });

  it('setRemoteForThread updates the current context', () => {
    lappy.setRemoteForThread(true);
    expect(lappy.useRemote()).toBe(true);
    lappy._resetStateForTests();
    expect(lappy.useRemote()).toBe(false);
  });
});

/* ================================================================== *
 * renderlane: _capfreeNode content-only copy
 * ================================================================== */

function xattrNames(file: string): string[] {
  const res = spawnSync('getfattr', ['-d', '-m', '-', '--', file], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return (res.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0] as string);
}

describe('renderlane _capfreeNode', () => {
  let scratch: string;
  let bindir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    scratch = tmpdir('p5-capfree-');
    bindir = tmpdir('p5-nodebin-');
    previousPath = process.env.PATH;
    renderlane._resetHooksForTests();
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    renderlane._resetHooksForTests();
    rmrf(scratch);
    rmrf(bindir);
  });

  it('copies node content-only, strips xattrs and forces 0755', () => {
    const fakeNode = path.join(bindir, 'node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\necho fake-node\n');
    fs.chmodSync(fakeNode, 0o755);
    const setRes = spawnSync('setfattr', ['-n', 'user.capability', '-v', 'ep', '--', fakeNode], {
      encoding: 'utf8',
    });
    expect(setRes.status).toBe(0);
    expect(xattrNames(fakeNode)).toContain('user.capability');

    process.env.PATH = bindir;
    const out = renderlane._capfreeNode(scratch);
    expect(out).toBe(path.join(scratch, 'bin'));

    const copied = path.join(scratch, 'bin', 'node');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf8')).toBe(fs.readFileSync(fakeNode, 'utf8'));
    expect(fs.statSync(copied).mode & 0o777).toBe(0o755);
    expect(xattrNames(copied)).toEqual([]);
    expect(renderlane._fileSha256(copied)).toBe(renderlane._fileSha256(fakeNode));
  });

  it('returns null when node cannot be found', () => {
    process.env.PATH = tmpdir('p5-empty-path-');
    expect(renderlane._capfreeNode(scratch)).toBeNull();
  });
});

/* ================================================================== *
 * renderlane: _renderRoot, _probe, _fileSha256, renderLocal
 * ================================================================== */

describe('renderlane local render helpers', () => {
  let root: string;

  beforeEach(() => {
    root = tmpdir('p5-renderlane-');
    renderlane._resetHooksForTests();
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
    delete process.env.MANHWA_RENDER_TMPDIR;
    rmrf(root);
  });

  it('_renderRoot defaults next to the video and honours MANHWA_RENDER_TMPDIR', () => {
    const video = path.join(root, 'ch1', 'video', 'video.mp4');
    fs.mkdirSync(path.dirname(video), { recursive: true });
    const def = renderlane._renderRoot(video);
    expect(def).toBe(path.join(path.dirname(video), '.render-tmp'));
    expect(fs.statSync(def).isDirectory()).toBe(true);

    const override = path.join(root, 'custom-tmp');
    process.env.MANHWA_RENDER_TMPDIR = override;
    expect(renderlane._renderRoot(video)).toBe(override);
  });

  it('_probe parses ffprobe duration', () => {
    const calls: string[][] = [];
    renderlane._hooks.subprocess = {
      run: (args: readonly string[]) => {
        calls.push([...args]);
        return { returncode: 0, status: 0, stdout: '42.0\n', stderr: '' };
      },
    } as typeof renderlane.subprocess;
    expect(renderlane._probe('video.mp4')).toBe(42);
    expect(calls[0][0]).toBe('ffprobe');
    renderlane._hooks.subprocess = {
      run: () => ({ returncode: 0, status: 0, stdout: '', stderr: '' }),
    } as typeof renderlane.subprocess;
    expect(renderlane._probe('video.mp4')).toBe(0);
  });

  it('renderLocal renders in a private temp under HEAVY and cleans up', async () => {
    const videoDir = path.join(root, 'ch1', 'video');
    fs.mkdirSync(videoDir, { recursive: true });
    const video = path.join(videoDir, 'video.mp4');
    const props = path.join(videoDir, 'shots.json');
    fs.writeFileSync(props, '{}');
    const nodedir = path.join(root, 'fake-node-bin');
    fs.mkdirSync(nodedir, { recursive: true });

    const seen: { args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
    renderlane._hooks._capfreeNode = () => nodedir;
    renderlane._hooks.subprocess = {
      run: (args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
        seen.push({ args: [...args], env: options.env ?? {}, cwd: options.cwd });
        fs.writeFileSync(video, Buffer.from('rendered'));
        return { returncode: 0, status: 0, stdout: '', stderr: '' };
      },
    } as typeof renderlane.subprocess;

    await renderlane.renderLocal(props, video);

    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.args.slice(0, 5)).toEqual(['npx', 'remotion', 'render', 'src/index.ts', 'Recap']);
    expect(call.args).toContain(`--props=${props}`);
    expect(call.args).toContain('--log=info');
    const scratch = call.env.TMPDIR as string;
    expect(path.dirname(scratch)).toBe(renderlane._renderRoot(video));
    expect(call.env.TMP).toBe(scratch);
    expect(call.env.TEMP).toBe(scratch);
    expect((call.env.PATH as string).startsWith(nodedir + path.delimiter)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false); // private temp removed
    expect(fs.existsSync(path.join(videoDir, 'render.log'))).toBe(true);
    expect(fs.readFileSync(video, 'utf8')).toBe('rendered');
    expect(lappy.HEAVY.held).toBe(false);
  });

  it('renderLocal raises with the render.log tail on failure', async () => {
    const videoDir = path.join(root, 'ch1', 'video');
    fs.mkdirSync(videoDir, { recursive: true });
    const video = path.join(videoDir, 'video.mp4');
    const props = path.join(videoDir, 'shots.json');
    fs.writeFileSync(props, '{}');
    renderlane._hooks._capfreeNode = () => null;
    renderlane._hooks.subprocess = {
      run: () => ({ returncode: 133, status: 133, stdout: '', stderr: '' }),
    } as typeof renderlane.subprocess;

    expect(() => renderlane.renderLocal(props, video)).toThrow(/rc=133/);
    expect(lappy.HEAVY.held).toBe(false);
  });
});

/* ================================================================== *
 * renderlane: routing (ported from test_renderlane_cloud.py)
 * ================================================================== */

interface LappyFake {
  HOST: string;
  RDIR: string;
  HEAVY: typeof lappy.HEAVY;
  withHeavy: typeof lappy.withHeavy;
  useRemote: () => boolean;
  use_remote: () => boolean;
  setRemoteForThread: (remote: boolean) => void;
  healthy: (maxAge?: number, checkLoad?: boolean) => [boolean, string];
  report: (ok: boolean) => void;
  ssh: typeof lappy.ssh;
  push: typeof lappy.push;
  pull: typeof lappy.pull;
  rm: typeof lappy.rm;
  _tls: { remote: boolean };
}

interface CloudFake {
  NAME: string;
  STUDIO: string;
  healthy: (maxAge?: number) => [boolean, string];
  report: (ok: boolean) => void;
  render: (
    props: string,
    video: string,
    studio: string,
    log?: unknown,
  ) => void | Promise<void>;
}

function makeLappyFake(): LappyFake {
  return {
    HOST: 'laptop',
    RDIR: 'render-worker',
    HEAVY: lappy.HEAVY,
    withHeavy: lappy.withHeavy,
    useRemote: () => false,
    use_remote: () => false,
    setRemoteForThread: () => {},
    healthy: () => [true, 'ok'],
    report: () => {},
    ssh: (() => {}) as unknown as typeof lappy.ssh,
    push: (() => {}) as unknown as typeof lappy.push,
    pull: (() => {}) as unknown as typeof lappy.pull,
    rm: (() => {}) as unknown as typeof lappy.rm,
    _tls: { remote: false },
  };
}

function makeCloudFake(): CloudFake {
  return {
    NAME: 'render-box',
    STUDIO: renderlane.STUDIO,
    healthy: () => [true, 'ok'],
    report: () => {},
    render: () => {},
  };
}

describe('renderlane routing', () => {
  let lp: LappyFake;
  let cl: CloudFake;
  let messages: string[];
  let laptopCalls: string[];
  let cloudCalls: string[];
  let localCalls: string[];
  let laptopReports: boolean[];
  let cloudReports: boolean[];

  beforeEach(() => {
    renderlane._resetHooksForTests();
    lp = makeLappyFake();
    cl = makeCloudFake();
    messages = [];
    laptopCalls = [];
    cloudCalls = [];
    localCalls = [];
    laptopReports = [];
    cloudReports = [];

    lp.report = (ok: boolean) => {
      laptopReports.push(ok);
    };
    cl.report = (ok: boolean) => {
      cloudReports.push(ok);
    };
    renderlane._hooks.lappy = lp as unknown as typeof renderlane.lappy;
    renderlane._hooks.cloudlane = cl as unknown as typeof renderlane.cloudlane;
    renderlane._hooks._probe = () => 42;
    renderlane._hooks.renderLocal = (props: string) => {
      localCalls.push(props);
    };
    renderlane._hooks.renderRemote = (props: string) => {
      laptopCalls.push(props);
    };
    renderlane._hooks.renderCloud = (props: string) => {
      cloudCalls.push(props);
    };
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
  });

  const render = (): Promise<[string, number]> | [string, number] =>
    renderlane._render('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m));

  it('cloud disabled preserves the local path without a probe', async () => {
    cl.NAME = '';
    expect(await render()).toEqual(['video.mp4', 42]);
    expect(localCalls).toHaveLength(1);
    expect(cloudCalls).toHaveLength(0);
  });

  it('laptop worker keeps first priority', async () => {
    lp.use_remote = () => true;
    lp.useRemote = () => true;
    await render();
    expect(laptopCalls).toHaveLength(1);
    expect(laptopReports).toEqual([true]);
    expect(cloudCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(0);
  });

  it('local chapter uses cloud overflow, not a busy laptop', async () => {
    await render();
    expect(cloudCalls).toHaveLength(1);
    expect(cloudReports).toEqual([true]);
    expect(laptopCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(0);
    expect(messages.at(-1)).toContain('[render-box]');
  });

  it('down laptop uses cloud', async () => {
    lp.use_remote = () => true;
    lp.useRemote = () => true;
    lp.healthy = () => [false, 'down'];
    await render();
    expect(cloudCalls).toHaveLength(1);
    expect(laptopCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(0);
  });

  it('laptop failure can use cloud next', async () => {
    lp.use_remote = () => true;
    lp.useRemote = () => true;
    renderlane._hooks.renderRemote = () => {
      throw new Error('SSH lost');
    };
    await render();
    expect(laptopReports).toEqual([false]);
    expect(cloudCalls).toHaveLength(1);
    expect(localCalls).toHaveLength(0);
  });

  it('unavailable cloud uses local', async () => {
    cl.healthy = () => [false, 'breaker open'];
    await render();
    expect(cloudCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(1);
  });

  it('cloud failure goes directly local without retrying the laptop', async () => {
    renderlane._hooks.renderCloud = () => {
      throw new Error('download failed');
    };
    await render();
    expect(cloudReports).toEqual([false]);
    expect(localCalls).toHaveLength(1);
    expect(laptopCalls).toHaveLength(0);
    expect(messages.some((m) => m.includes('cloud failed'))).toBe(true);
  });

  it('both remote failures still reach local', async () => {
    lp.use_remote = () => true;
    lp.useRemote = () => true;
    renderlane._hooks.renderRemote = () => {
      throw new Error('SSH lost');
    };
    renderlane._hooks.renderCloud = () => {
      throw new Error('sbx failed');
    };
    await render();
    expect(laptopCalls).toHaveLength(0);
    expect(cloudCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(1);
    expect(laptopReports).toEqual([false]);
    expect(cloudReports).toEqual([false]);
  });

  it('wrapper passes the configured studio', async () => {
    const forwarded: Array<[string, string, string]> = [];
    cl.render = (props, video, studio) => {
      forwarded.push([props, video, studio]);
    };
    await renderlane.renderCloud('shots.json', 'video.mp4');
    expect(forwarded).toEqual([['shots.json', 'video.mp4', renderlane.STUDIO]]);
  });

  it('renderCloud forwards props, video and STUDIO to the cloud lane', async () => {
    const forwarded: Array<[string, string, string]> = [];
    renderlane._hooks.renderCloud = () => {};
    renderlane._hooks.cloudlane = {
      ...(renderlane._hooks.cloudlane as unknown as Record<string, unknown>),
      render: (props: string, video: string, studio: string) => {
        forwarded.push([props, video, studio]);
      },
    } as unknown as typeof renderlane.cloudlane;
    renderlane._hooks.STUDIO = '/tmp/opencode/studio';
    try {
      await renderlane.renderCloud('shots.json', 'video.mp4');
      expect(forwarded).toEqual([['shots.json', 'video.mp4', '/tmp/opencode/studio']]);
    } finally {
      renderlane._hooks.STUDIO = renderlane.STUDIO;
    }
  });
});

describe('renderlane pinned lanes and override refusal', () => {
  let lp: LappyFake;
  let cl: CloudFake;
  let messages: string[];

  beforeEach(() => {
    renderlane._resetHooksForTests();
    lp = makeLappyFake();
    cl = makeCloudFake();
    messages = [];
    renderlane._hooks.lappy = lp as unknown as typeof renderlane.lappy;
    renderlane._hooks.cloudlane = cl as unknown as typeof renderlane.cloudlane;
    renderlane._hooks._probe = () => 7;
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
  });

  it('refuses a pinned laptop lane that is not configured', () => {
    lp.HOST = '';
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'laptop'),
    ).toThrow(/not configured/);
  });

  it('refuses a pinned laptop lane that is unavailable', () => {
    lp.healthy = () => [false, 'unreachable over ssh'];
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'laptop'),
    ).toThrow(/unavailable: unreachable over ssh/);
  });

  it('refuses a pinned cloud lane that is not configured', () => {
    cl.NAME = '';
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'cloud'),
    ).toThrow(/not configured/);
  });

  it('refuses a pinned cloud lane that is unavailable', () => {
    cl.healthy = () => [false, 'breaker open'];
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'cloud'),
    ).toThrow(/unavailable: breaker open/);
  });

  it('rejects an unknown lane', () => {
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'wat'),
    ).toThrow(/unknown render lane 'wat'/);
  });

  it('never falls back from a pinned lane', () => {
    const local: string[] = [];
    const cloud: string[] = [];
    renderlane._hooks.renderLocal = (props: string) => {
      local.push(props);
    };
    renderlane._hooks.renderCloud = (props: string) => {
      cloud.push(props);
    };
    lp.healthy = () => [false, 'down'];
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', (m) => messages.push(m), 'laptop'),
    ).toThrow(/unavailable/);
    expect(local).toHaveLength(0);
    expect(cloud).toHaveLength(0);
  });

  it('a pinned local lane renders locally', async () => {
    const local: string[] = [];
    renderlane._hooks.renderLocal = (props: string) => {
      local.push(props);
    };
    const res = await renderlane._renderOnLane(
      'ch1',
      'shots.json',
      'video.mp4',
      (m) => messages.push(m),
      'local',
    );
    expect(res).toEqual(['video.mp4', 7]);
    expect(local).toEqual(['shots.json']);
  });

  it('_workerOverrideRefused fails every pending chapter at once', async () => {
    const q = new renderlane.RenderQueue<string | null>();
    q.put('ch1');
    q.put('ch2');
    q.put(null);
    const results: Record<string, renderlane.VideoResult> = {};
    const failcounts: Record<string, number> = {};
    await renderlane._workerOverrideRefused(
      'scratch',
      'scratch',
      q,
      results,
      failcounts,
      "render lane 'cloud' is disabled by the current lane config; a pinned lane must be configured and enabled",
    );
    expect(q.unfinished_tasks).toBe(0);
    expect(Object.keys(results).sort()).toEqual(['ch1', 'ch2']);
    for (const ch of ['ch1', 'ch2']) {
      expect(results[ch]!.status).toBe('video-failed');
      expect(results[ch]!.error).toContain('render override refused');
      expect(failcounts[ch]).toBe(1);
    }
  });

  it('_laneWorkerKind maps lanes to worker kinds', () => {
    expect(renderlane._laneWorkerKind('cloud', true)).toBe('cloud');
    expect(renderlane._laneWorkerKind('laptop', true)).toBe('remote');
    expect(renderlane._laneWorkerKind('local', false)).toBe('local');
    expect(renderlane._laneWorkerKind(null, false)).toBe('local');
  });
});

describe('renderlane worker legacy plan', () => {
  let lp: LappyFake;
  let cl: CloudFake;
  let previousSnapshot: string | undefined;

  beforeEach(() => {
    renderlane._resetHooksForTests();
    previousSnapshot = process.env.MANHWA_RENDER_PLAN_SNAPSHOT;
    process.env.MANHWA_RENDER_PLAN_SNAPSHOT = '0';
    renderlane.renderPolicy.resetRenderPlan();
    lp = makeLappyFake();
    cl = makeCloudFake();
    renderlane._hooks.lappy = lp as unknown as typeof renderlane.lappy;
    renderlane._hooks.cloudlane = cl as unknown as typeof renderlane.cloudlane;
    renderlane._hooks._probe = () => 42;
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
    renderlane.renderPolicy.resetRenderPlan();
    renderlane.renderPolicy.setTransportDefaults(null);
    if (previousSnapshot === undefined) delete process.env.MANHWA_RENDER_PLAN_SNAPSHOT;
    else process.env.MANHWA_RENDER_PLAN_SNAPSHOT = previousSnapshot;
  });

  async function runWorker(enabled: boolean, available = true): Promise<{
    results: Record<string, renderlane.VideoResult>;
    cloudSeen: string[];
    localCalls: number;
    healthCalls: number;
  }> {
    const q = new renderlane.RenderQueue<string | null>();
    for (const ch of ['ch1', 'ch2', null]) q.put(ch);
    const results: Record<string, renderlane.VideoResult> = {};
    const cloudSeen: string[] = [];
    let localCalls = 0;
    let healthCalls = 0;
    let entered = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    cl.NAME = enabled ? 'render-box' : '';
    lp.HOST = '';
    lp.healthy = () => [false, 'disabled'];
    cl.healthy = () => {
      healthCalls += 1;
      return [available, 'ok'];
    };
    cl.render = async () => {
      cloudSeen.push('cloud');
      entered += 1;
      if (entered >= 2) release();
      await barrier;
    };
    renderlane._hooks.prepare = async (_sdir: string, ch: string) => [ch, `${ch}.mp4`] as [string, string];
    renderlane._hooks.renderLocal = () => {
      localCalls += 1;
    };

    await renderlane.worker('scratch', 'scratch', q, results, {});
    return { results, cloudSeen, localCalls, healthCalls };
  }

  it('two chapters reach the cloud together without the laptop', async () => {
    const { results, cloudSeen, localCalls, healthCalls } = await runWorker(true);
    expect(Object.keys(results).sort()).toEqual(['ch1', 'ch2']);
    expect(Object.values(results).every((r) => r.status === 'video-ok')).toBe(true);
    expect(cloudSeen).toHaveLength(2);
    expect(localCalls).toBe(0);
    expect(healthCalls).toBeGreaterThan(0);
  });

  it('default off keeps the original local worker', async () => {
    const { results, cloudSeen, localCalls, healthCalls } = await runWorker(false);
    expect(cloudSeen).toHaveLength(0);
    expect(localCalls).toBe(2);
    expect(healthCalls).toBe(0);
    expect(Object.values(results).every((r) => r.status === 'video-ok')).toBe(true);
  });

  it('unavailable cloud does not deadlock the queue', async () => {
    const { results, cloudSeen, localCalls } = await runWorker(true, false);
    expect(cloudSeen).toHaveLength(0);
    expect(localCalls).toBe(2);
    expect(Object.values(results).every((r) => r.status === 'video-ok')).toBe(true);
  });
});

/* ================================================================== *
 * cli/run.ts: failClass, hook helpers, reader-captions, status parity
 * ================================================================== */

describe('run failClass', () => {
  it('classifies permanent failures', () => {
    expect(runCli.failClass(new Error('moderation blocked'))).toBe('permanent');
    expect(runCli.failClass(new Error('unknown tts.engine'))).toBe('permanent');
    expect(runCli.failClass(new Error('continuity gate: hole'))).toBe('permanent');
    expect(runCli.failClass({ permanent: true })).toBe('permanent');
  });

  it('classifies transient failures', () => {
    expect(runCli.failClass(new Error('429 too many requests'))).toBe('transient');
    expect(runCli.failClass(new Error('connection reset by peer'))).toBe('transient');
    expect(runCli.failClass(new Error('provider returned 503'))).toBe('transient');
    expect(runCli.failClass(new Error('request timed out'))).toBe('transient');
  });

  it('classifies anything else as unknown', () => {
    expect(runCli.failClass(new Error('something else entirely'))).toBe('unknown');
  });
});

describe('run hook helpers', () => {
  it('_withHook returns the script unchanged without a hook', () => {
    const script = '## BEAT b01\nLine one\n';
    expect(runCli._withHook(script, {})).toBe(script);
    expect(runCli._withHook(script, { hook: '   ' })).toBe(script);
  });

  it('_withHook prepends the hook as the first beat', () => {
    const hook = 'The demon king wakes in a school uniform';
    const script = '## BEAT b01\nUnrelated narration line here\n';
    const out = runCli._withHook(script, { hook });
    expect(out.startsWith(`## BEAT b00_opening\n${hook}\n\n`)).toBe(true);
    expect(out).toContain('## BEAT b01');
    expect(out).toContain('Unrelated narration line here');
  });

  it('_dropHookEcho drops a restated hook and any jab riding on it', () => {
    const hook = 'The demon king wakes in a school uniform';
    const script = [
      '## BEAT b01',
      'The demon king wakes in a school uniform today',
      '@hold',
      'A completely new line of narration',
      '',
    ].join('\n');
    const out = runCli._dropHookEcho(script, hook);
    expect(out).not.toContain('demon king wakes');
    expect(out).not.toContain('@hold');
    expect(out).toContain('A completely new line of narration');
  });

  it('_dropHookEcho removes a beat header left with no lines', () => {
    const hook = 'The demon king wakes in a school uniform';
    const script = [
      '## BEAT b01',
      'The demon king wakes in a school uniform',
      '## BEAT b02',
      'Other text that stays',
      '',
    ].join('\n');
    const out = runCli._dropHookEcho(script, hook);
    expect(out).not.toContain('## BEAT b01');
    expect(out).toContain('## BEAT b02');
    expect(out).toContain('Other text that stays');
  });

  it('_dropHookEcho only inspects the first few narration lines', () => {
    const hook = 'The demon king wakes in a school uniform';
    const script = [
      'Line one is different',
      'Line two is different',
      'Line three is different',
      'Line four is different',
      'The demon king wakes in a school uniform',
      '',
    ].join('\n');
    const out = runCli._dropHookEcho(script, hook);
    expect(out).toContain('The demon king wakes in a school uniform');
  });
});

describe('run _pullReaderCaptions', () => {
  it('leaves argv untouched without the flag', () => {
    const [cv, rest] = runCli._pullReaderCaptions(['demo', 'ch1']);
    expect(cv).toBe(CAPTION_VERSION);
    expect(rest).toEqual(['demo', 'ch1']);
  });

  it('pulls the separated value and its flag', () => {
    const [cv, rest] = runCli._pullReaderCaptions(['demo', '--reader-captions', 'v2', 'ch1']);
    expect(cv).toBe(2);
    expect(rest).toEqual(['demo', 'ch1']);
  });

  it('pulls the inline value form', () => {
    const [cv, rest] = runCli._pullReaderCaptions(['--reader-captions=v4', 'demo']);
    expect(cv).toBe(4);
    expect(rest).toEqual(['demo']);
  });

  it('refuses a version with no caption prompt', () => {
    expect(() => runCli._pullReaderCaptions(['--reader-captions', 'v3'])).toThrow(
      runCli.SystemExit,
    );
  });

  it('refuses a missing value', () => {
    expect(() => runCli._pullReaderCaptions(['demo', '--reader-captions'])).toThrow(
      runCli.SystemExit,
    );
  });

  it('refuses an unknown version', () => {
    expect(() => runCli._pullReaderCaptions(['--reader-captions', 'v99'])).toThrow(
      runCli.SystemExit,
    );
  });
});

describe('run status output parity', () => {
  let root: string;
  let logged: string[];

  beforeEach(() => {
    root = tmpdir('p5-status-');
    runCli._resetHooksForTests();
    runCli._setSeriesRootForTests(root);
    logged = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = ORIGINAL_CONSOLE_LOG;
    runCli._resetHooksForTests();
    rmrf(root);
  });

  it('prints the header, a chapter row and the legend', () => {
    const sdir = path.join(root, 'demo');
    fs.mkdirSync(path.join(sdir, 'ch1'), { recursive: true });
    fs.mkdirSync(path.join(sdir, 'out', 'ch1'), { recursive: true });
    fs.writeFileSync(path.join(sdir, 'ch1', '1.jpg'), 'page one');
    fs.writeFileSync(path.join(sdir, 'ch1', '2.jpg'), 'page two');
    fs.writeFileSync(path.join(sdir, 'out', 'ch1', 'script.md'), 'script');
    runCli._hooks._loadCached = (file: string) =>
      file.includes('obs_') ? [null, 'ok'] : [null, 'stale'];

    runCli.status('demo', CAPTION_VERSION);

    const cv: number = CAPTION_VERSION;
    const first = `series: demo   brief_hash: ${briefHash(cv)}   schema_hash: ${schemaHash()}` +
      (cv !== 1 ? `   CAPTIONS v${cv}` : '');
    expect(logged[0]).toBe(first);
    expect(logged[1]).toBe('ch     pages batches ok/stale/tot   obs  script calls if run');
    expect(logged[2]).toBe('ch1        2                0/1/1 fresh     yes            0');
    expect(logged[3]).toBe(
      "\nlegend: 'calls if run' = vision API calls a plain `run.py` would make now",
    );
  });

  it('counts vision calls when obs is not fresh', () => {
    const sdir = path.join(root, 'demo');
    fs.mkdirSync(path.join(sdir, 'ch1'), { recursive: true });
    fs.mkdirSync(path.join(sdir, 'out', 'ch1'), { recursive: true });
    fs.writeFileSync(path.join(sdir, 'ch1', '1.jpg'), 'page one');
    runCli._hooks._loadCached = (file: string) =>
      file.includes('obs_') ? [null, 'miss'] : [null, 'ok'];

    runCli.status('demo', CAPTION_VERSION);

    // 1 page -> 1 batch; obs missing -> calls = total - ok = 1 - 1 = 0
    expect(logged[2]).toBe('ch1        1                1/0/1    no      no            0');
  });
});
