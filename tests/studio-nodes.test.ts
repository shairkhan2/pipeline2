/**
 * Track 2 Creative Studio backend: multi-instance render nodes.
 *
 * Covers the isolated `createCloudNode` / `createSshNode` factories, the
 * `render-nodes.json` registry, and dispatch of a custom node id through
 * `renderlane._renderOnLane`. Offline only: every subprocess goes through an
 * injected runner and every path lives under /tmp/opencode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as cloudlane from '../src/workers/cloudlane.js';
import * as lappy from '../src/workers/lappy.js';
import * as nodeRegistry from '../src/workers/nodeRegistry.js';
import * as renderlane from '../src/workers/renderlane.js';
import * as jobs from '../src/player/jobs.js';
import * as laneConfig from '../src/config/laneConfig.js';
import * as renderPolicy from '../src/config/renderPolicy.js';
import { putSecret } from '../src/config/secretStore.js';

const TMP_ROOT = '/tmp/opencode';

function tmpdir(prefix: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmrf(dir);
});

function makeTmp(prefix: string): string {
  const dir = tmpdir(prefix);
  created.push(dir);
  return dir;
}

type Call = { args: readonly string[]; timeout: number };

function fakeRunner(impl: (args: readonly string[]) => cloudlane.RawResult): {
  fn: cloudlane.ProcessRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn: cloudlane.ProcessRunner = (args, timeout) => {
    calls.push({ args: [...args], timeout });
    return impl(args);
  };
  return { fn, calls };
}

function ok(stdout = ''): cloudlane.RawResult {
  return { status: 0, stdout, stderr: '' };
}

function listing(name: string, status: string): string {
  return JSON.stringify({ sandboxes: [{ name, id: `${name}-id`, status }] });
}

/* ================================================================== *
 * createCloudNode
 * ================================================================== */

describe('createCloudNode: isolated multi-instance sandboxes', () => {
  afterEach(() => {
    cloudlane._setRunnerForTests(null);
  });

  it('keeps probe cache, breaker, and slots independent per node', () => {
    const arm1 = cloudlane.createCloudNode(
      { id: 'sbx-arm-1', box: 'sbx-arm-1', slots: 2 },
      (args) => {
        if (args[2] === 'ls') return ok(listing('sbx-arm-1', 'starting'));
        return ok();
      },
    );
    const arm2 = cloudlane.createCloudNode(
      { id: 'sbx-arm-2', box: 'sbx-arm-2', slots: 1 },
      (args) => {
        if (args[2] === 'ls') return ok(listing('sbx-arm-2', 'running'));
        return ok();
      },
    );

    // arm2 is healthy; arm1 fails twice and trips only its own breaker.
    expect(arm2.healthy(true)).toEqual([true, 'ok']);
    expect(arm1.healthy(true)[0]).toBe(false);
    expect(arm1.healthy(true)[0]).toBe(false);
    expect(arm1.healthy()[0]).toBe(false);
    expect(arm1.healthy()[1]).toMatch(/breaker open/);
    expect(arm2.healthy()[0]).toBe(true);

    expect(arm1.state.openUntil).toBeGreaterThan(0);
    expect(arm2.state.openUntil).toBe(0);
    expect(arm1.state.slots).toBe(2);
    expect(arm2.state.slots).toBe(1);
    expect(arm1.state.active).toBe(0);
    expect(arm2.state.active).toBe(0);
    expect(arm1.status().status).toBe('breaker-open');
    expect(arm2.status().status).toBe('available');
  });

  it('keeps TTL budgets independent (maxHours per node)', () => {
    const ttl = (remaining: string) =>
      JSON.stringify({ expires_in_seconds: remaining, max_remaining_seconds: '20000' });
    const arm1Calls: string[][] = [];
    const arm2Calls: string[][] = [];
    const arm1 = cloudlane.createCloudNode({ id: 'sbx-arm-1', box: 'sbx-arm-1', maxHours: 1 }, (args) => {
      arm1Calls.push([...args]);
      if (args[2] === 'ttl' && args[4] === '--json') return ok(ttl('100'));
      return ok();
    });
    const arm2 = cloudlane.createCloudNode({ id: 'sbx-arm-2', box: 'sbx-arm-2', maxHours: 4 }, (args) => {
      arm2Calls.push([...args]);
      if (args[2] === 'ttl' && args[4] === '--json') return ok(ttl('15000'));
      return ok();
    });

    // arm1 has 100s left of a 3600s budget -> extend.
    arm1.ensureTtl();
    // arm2 has 15000s left of a 14400s budget -> already enough.
    arm2.ensureTtl();

    expect(arm1Calls.filter((args) => args[2] === 'ttl' && args[4] !== '--json')).toEqual([
      ['sbx', '--cloud', 'ttl', '+3500s', 'sbx-arm-1'],
    ]);
    expect(arm2Calls.filter((args) => args[2] === 'ttl' && args[4] !== '--json')).toEqual([]);
    expect(arm1.state.ok).toBe(false); // ensureTtl never flips health
    expect(arm2.state.ok).toBe(false);
  });

  it('records the ttl extension per box, not globally', () => {
    const calls: string[][] = [];
    const runner: cloudlane.ProcessRunner = (args) => {
      calls.push([...args]);
      if (args[2] === 'ttl' && args[4] === '--json') {
        return ok(JSON.stringify({ expires_in_seconds: '60', max_remaining_seconds: '9000' }));
      }
      return ok();
    };
    const arm1 = cloudlane.createCloudNode({ id: 'sbx-arm-1', box: 'sbx-arm-1', maxHours: 1 }, runner);
    const arm2 = cloudlane.createCloudNode({ id: 'sbx-arm-2', box: 'sbx-arm-2', maxHours: 1 }, runner);
    arm1.ensureTtl();
    arm2.ensureTtl();
    const extensions = calls.filter((args) => args[2] === 'ttl' && args[4] !== '--json');
    expect(extensions.map((args) => args[4])).toEqual(['sbx-arm-1', 'sbx-arm-2']);
    expect(extensions.map((args) => args[3])).toEqual(['+3540s', '+3540s']);
  });

  it('gates start/stop/create behind MANHWA_ALLOW_SANDBOX_CONTROL or allowControl', () => {
    const runner = fakeRunner(() => ok());
    const previous = process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
    delete process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
    try {
      const denied = cloudlane.createCloudNode(
        { id: 'sbx-arm-1', box: 'sbx-arm-1', template: 'manhwa-render-arm' },
        runner.fn,
      );
      expect(denied.start().ok).toBe(false);
      expect(denied.stop().ok).toBe(false);
      expect(denied.create().ok).toBe(false);
      expect(denied.start().detail).toContain('MANHWA_ALLOW_SANDBOX_CONTROL');
      expect(runner.calls).toHaveLength(0);

      const allowed = cloudlane.createCloudNode(
        { id: 'sbx-arm-1', box: 'sbx-arm-1', template: 'manhwa-render-arm' },
        runner.fn,
        { allowControl: true },
      );
      expect(allowed.start()).toEqual({ ok: true, detail: 'started sbx-arm-1' });
      expect(allowed.stop()).toEqual({ ok: true, detail: 'stopped sbx-arm-1' });
      expect(allowed.create()).toEqual({
        ok: true,
        detail: 'created sbx-arm-1 from manhwa-render-arm',
      });
      const verbs = runner.calls.map((c) => c.args[2]);
      expect(verbs).toEqual(['start', 'stop', 'create']);

      process.env.MANHWA_ALLOW_SANDBOX_CONTROL = '1';
      const envAllowed = cloudlane.createCloudNode(
        { id: 'sbx-arm-2', box: 'sbx-arm-2', template: 'manhwa-render-arm' },
        runner.fn,
      );
      expect(envAllowed.start().ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
      else process.env.MANHWA_ALLOW_SANDBOX_CONTROL = previous;
    }
  });

  it('rejects an unsafe box or template even with control enabled', () => {
    const runner = fakeRunner(() => ok());
    expect(() => cloudlane.createCloudNode({ id: 'bad', box: '--rm' }, runner.fn)).toThrow(
      /invalid cloud node box/,
    );
    expect(() => cloudlane.createCloudNode({ id: 'bad', box: 'box; rm -rf /' }, runner.fn)).toThrow(
      /invalid cloud node box/,
    );
    const node = cloudlane.createCloudNode(
      { id: 'sbx-arm-1', box: 'sbx-arm-1', template: '$(rm -rf /)' },
      runner.fn,
      { allowControl: true },
    );
    const res = node.create();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/invalid sandbox template/);
    expect(runner.calls).toHaveLength(0);
  });

  it('renders through argv-only sbx calls and pulls the video back', async () => {
    const dir = makeTmp('cloudnode');
    const studio = path.join(dir, 'studio');
    fs.mkdirSync(path.join(studio, 'public', 'series_1'), { recursive: true });
    const props = path.join(dir, 'shots.json');
    fs.writeFileSync(props, JSON.stringify({ audio: 'series_1/audio.mp3' }));
    const video = path.join(dir, 'video', 'video.mp4');

    const runner: cloudlane.ProcessRunner = (args) => {
      if (args[0] === 'ffprobe') return ok('12.5\n');
      if (args[2] === 'cp') {
        const dst = args[4];
        if (args[3].startsWith('sbx-arm-1:') && args[3].endsWith('video.mp4')) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, 'mp4');
        }
        return ok();
      }
      return ok();
    };
    const previousStudio = process.env.MANHWA_STUDIO;
    process.env.MANHWA_STUDIO = studio;
    try {
      const node = cloudlane.createCloudNode({ id: 'sbx-arm-1', box: 'sbx-arm-1' }, runner);
      await node.render(props, video, () => {});
      expect(fs.readFileSync(video, 'utf8')).toBe('mp4');
      expect(node.state.active).toBe(0);
    } finally {
      if (previousStudio === undefined) delete process.env.MANHWA_STUDIO;
      else process.env.MANHWA_STUDIO = previousStudio;
    }
  });
});

/* ================================================================== *
 * createSshNode
 * ================================================================== */

describe('createSshNode: isolated multi-instance ssh workers', () => {
  it('validates host, user, port, and remoteDir against strict allowlists', () => {
    expect(() =>
      lappy.createSshNode({ id: 'x', host: '-oProxyCommand=curl attacker' }),
    ).toThrow(/invalid ssh host/);
    expect(() => lappy.createSshNode({ id: 'x', host: 'host; rm -rf /' })).toThrow(
      /invalid ssh host/,
    );
    expect(() => lappy.createSshNode({ id: 'x', host: 'host with space' })).toThrow(
      /invalid ssh host/,
    );
    expect(() => lappy.createSshNode({ id: 'x', host: 'ok', user: '-oProxyCommand=x' })).toThrow(
      /invalid ssh user/,
    );
    expect(() => lappy.createSshNode({ id: 'x', host: 'ok', port: 0 })).toThrow(/invalid ssh port/);
    expect(() => lappy.createSshNode({ id: 'x', host: 'ok', port: 70000 })).toThrow(
      /invalid ssh port/,
    );
    expect(() =>
      lappy.createSshNode({ id: 'x', host: 'ok', remoteDir: '../../etc' }),
    ).toThrow(/invalid ssh remoteDir/);
    expect(() => lappy.createSshNode({ id: 'x', host: 'ok', remoteDir: '/a b' })).toThrow(
      /invalid ssh remoteDir/,
    );
  });

  it('keeps probe caches and breakers independent, with custom port and user in argv', () => {
    const euCalls: string[][] = [];
    const eu = lappy.createSshNode(
      { id: 'worker-eu', host: 'eu.example', user: 'deploy', port: 2222 },
      (args) => {
        euCalls.push([...args]);
        if (args[0] === 'ssh') {
          return ok('{"load":0.1,"cpus":8,"mem_gb":16,"disk_gb":100,"ac":"1","miss":""}\n');
        }
        return ok();
      },
    );
    const us = lappy.createSshNode({ id: 'worker-us', host: 'us.example' }, (args) => {
      if (args[0] === 'ssh') return { status: 255, stdout: '', stderr: 'no route' };
      return ok();
    });

    expect(eu.healthy(true)).toEqual([true, 'ok']);
    expect(eu.healthy(true)).toEqual([true, 'ok']);
    // Two failures open only worker-us's breaker.
    expect(us.healthy(true)).toEqual([false, 'unreachable over ssh']);
    expect(us.healthy(true)).toEqual([false, 'unreachable over ssh']);
    expect(us.healthy(true)[1]).toMatch(/breaker open/);
    expect(eu.healthy(true)).toEqual([true, 'ok']);
    expect(us.state.until).toBeGreaterThan(0);
    expect(eu.state.until).toBe(0);

    const probe = euCalls.find((args) => args[0] === 'ssh')!;
    expect(probe.slice(0, 4)).toEqual(['ssh', '-p', '2222', '-o']);
    expect(probe).toContain('deploy@eu.example');

    const pushCalls: string[][] = [];
    const withKey = lappy.createSshNode(
      { id: 'worker-eu', host: 'eu.example', user: 'deploy', port: 2222, identityFile: '/keys/eu' },
      (args) => {
        pushCalls.push([...args]);
        return ok();
      },
    );
    withKey.push('/local/src/', '/remote/dst/', null, true, ['node_modules']);
    const rsync = pushCalls.find((args) => args[0] === 'rsync')!;
    const eIdx = rsync.indexOf('-e');
    expect(eIdx).toBeGreaterThan(0);
    expect(rsync[eIdx + 1]).toContain('-p 2222');
    expect(rsync[eIdx + 1]).toContain('-i /keys/eu');
    expect(rsync).toContain('--delete');
    expect(rsync).toContain('--exclude');
    expect(rsync[rsync.length - 1]).toBe('deploy@eu.example:/remote/dst/');
  });

  it('reports per-node status and slot counts', () => {
    const eu = lappy.createSshNode(
      { id: 'worker-eu', host: 'eu.example', slots: 3 },
      () => ok('{"load":0,"cpus":4,"mem_gb":8,"disk_gb":50,"ac":"1","miss":""}\n'),
    );
    const us = lappy.createSshNode({ id: 'worker-us', host: 'us.example', slots: 1 }, () =>
      ok('{"load":0,"cpus":4,"mem_gb":8,"disk_gb":50,"ac":"1","miss":""}\n'),
    );
    expect(eu.state.slots).toBe(3);
    expect(us.state.slots).toBe(1);
    eu.healthy(true);
    expect(eu.status()).toMatchObject({ ok: true, status: 'available', host: 'eu.example' });
    expect(us.status().status).toBe('unknown');
  });
});

/* ================================================================== *
 * nodeRegistry
 * ================================================================== */

function writeNodes(outDir: string, nodes: unknown[]): void {
  fs.mkdirSync(path.join(outDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'config', 'render-nodes.json'), JSON.stringify({ nodes }));
}

describe('nodeRegistry', () => {
  let outDir: string;
  const previousOut = process.env.MANHWA_OUT_DIR;
  const previousStudio = process.env.MANHWA_STUDIO;

  beforeEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    outDir = makeTmp('nodes');
    process.env.MANHWA_OUT_DIR = outDir;
  });

  afterEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    cloudlane._setRunnerForTests(null);
    renderlane._resetHooksForTests();
    if (previousOut === undefined) delete process.env.MANHWA_OUT_DIR;
    else process.env.MANHWA_OUT_DIR = previousOut;
    if (previousStudio === undefined) delete process.env.MANHWA_STUDIO;
    else process.env.MANHWA_STUDIO = previousStudio;
  });

  it('loads render-nodes.json and merges the built-in local node', () => {
    writeNodes(outDir, [
      { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1', slots: 2 },
      { id: 'worker-eu', kind: 'ssh', host: 'eu.example', user: 'deploy', port: 2222 },
      { id: 'local', kind: 'local', slots: 2 },
      { id: 'bad id!', kind: 'ssh', host: 'x' },
      { id: 'weird', kind: 'quantum' },
    ]);
    const nodes = nodeRegistry.getRegisteredNodes(outDir);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('sbx-arm-1');
    expect(ids).toContain('worker-eu');
    expect(ids).toContain('local');
    expect(ids).not.toContain('bad id!');
    expect(ids).not.toContain('weird');
    expect(ids.filter((id) => id === 'local')).toHaveLength(1);
    const local = nodes.find((n) => n.id === 'local')!;
    expect(local.slots).toBe(2);

    const instance = nodeRegistry.getNodeInstance('worker-eu', outDir);
    expect(instance?.kind).toBe('ssh');
    expect(instance?.slots).toBe(1);
    expect(nodeRegistry.getNodeInstance('nope', outDir)).toBeNull();

    const unknown = nodeRegistry.testNodeConnection('nope', outDir);
    expect(unknown.ok).toBe(false);
    expect(unknown.kind).toBe('unknown');
  });

  it('refuses start/stop/create without the control guard', () => {
    writeNodes(outDir, [{ id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1', template: 'manhwa-render-arm' }]);
    const previous = process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
    delete process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
    try {
      const start = nodeRegistry.runNodeAction('sbx-arm-1', 'start', { outDir });
      expect(start.ok).toBe(false);
      expect(start.detail).toContain('MANHWA_ALLOW_SANDBOX_CONTROL');
      const unknown = nodeRegistry.runNodeAction('nope', 'status', { outDir });
      expect(unknown.ok).toBe(false);
      expect(unknown.detail).toContain('unknown render node');
    } finally {
      if (previous === undefined) delete process.env.MANHWA_ALLOW_SANDBOX_CONTROL;
      else process.env.MANHWA_ALLOW_SANDBOX_CONTROL = previous;
    }
  });

  it('dispatches a custom node through renderlane._renderOnLane', async () => {
    writeNodes(outDir, [
      { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1', slots: 2 },
    ]);
    const studio = path.join(outDir, 'studio');
    fs.mkdirSync(path.join(studio, 'public', 'series_1'), { recursive: true });
    process.env.MANHWA_STUDIO = studio;

    const props = path.join(outDir, 'shots.json');
    fs.writeFileSync(props, JSON.stringify({ audio: 'series_1/audio.mp3' }));
    const video = path.join(outDir, 'video', 'video.mp4');

    const runner: cloudlane.ProcessRunner = (args) => {
      if (args[0] === 'ffprobe') return ok('9.0\n');
      if (args[2] === 'ls') return ok(listing('sbx-arm-1', 'running'));
      if (args[2] === 'cp') {
        const dst = args[4];
        if (args[3].startsWith('sbx-arm-1:') && args[3].endsWith('video.mp4')) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, 'mp4');
        }
      }
      return ok();
    };
    cloudlane._setRunnerForTests(runner);

    renderlane._resetHooksForTests();
    renderlane._hooks._probe = () => 9;
    const messages: string[] = [];
    const res = await renderlane._renderOnLane(
      'ch1',
      props,
      video,
      (m) => messages.push(m),
      'sbx-arm-1',
    );
    expect(res).toEqual([video, 9]);
    expect(messages.join('\n')).toContain('starting on sbx-arm-1');
    expect(fs.readFileSync(video, 'utf8')).toBe('mp4');
  });

  it('keeps built-in lanes on the existing singleton hooks', () => {
    renderlane._resetHooksForTests();
    renderlane._hooks._probe = () => 3;
    const local: string[] = [];
    renderlane._hooks.renderLocal = (p: string) => {
      local.push(p);
    };
    const res = renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', () => {}, 'local');
    expect(res).toEqual(['video.mp4', 3]);
    expect(local).toEqual(['shots.json']);
    expect(() =>
      renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', () => {}, 'wat'),
    ).toThrow(/unknown render lane 'wat'/);
  });

  it('routes a second registered local node through the local render path', async () => {
    writeNodes(outDir, [{ id: 'local-b', kind: 'local', slots: 2 }]);
    renderlane._resetHooksForTests();
    renderlane._hooks._probe = () => 5;
    const local: string[] = [];
    renderlane._hooks.renderLocal = (p: string) => {
      local.push(p);
    };
    const res = await renderlane._renderOnLane(
      'ch1',
      'shots.json',
      'video.mp4',
      () => {},
      'local-b',
    );
    expect(res).toEqual(['video.mp4', 5]);
    expect(local).toEqual(['shots.json']);
  });

  it('refuses a registered node that is offline, without falling back', async () => {
    writeNodes(outDir, [{ id: 'worker-eu', kind: 'ssh', host: 'eu.example' }]);
    renderlane._resetHooksForTests();
    renderlane._hooks._probe = () => 5;
    const local: string[] = [];
    renderlane._hooks.renderLocal = (p: string) => {
      local.push(p);
    };
    lappy._setRunnerForTests(() => ({ status: 255, stdout: '', stderr: 'no route' }));
    try {
      expect(() =>
        renderlane._renderOnLane('ch1', 'shots.json', 'video.mp4', () => {}, 'worker-eu'),
      ).toThrow(/unavailable: unreachable over ssh/);
      expect(local).toEqual([]);
    } finally {
      lappy._setRunnerForTests(null);
    }
  });

  it('accepts a registered node id as a job render lane', () => {
    writeNodes(outDir, [{ id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1' }]);
    expect(jobs.normalizeRenderLane('sbx-arm-1')).toBe('sbx-arm-1');
    expect(jobs.normalizeRenderLane(' SBX-ARM-1 ')).toBe('sbx-arm-1');
    expect(jobs.renderLaneValues()).toContain('sbx-arm-1');
    expect(jobs.normalizeRenderLane('not-registered')).toBeNull();
    for (const builtin of ['inherit', 'local', 'laptop', 'cloud']) {
      expect(jobs.normalizeRenderLane(builtin)).toBe(builtin);
    }
  });
});

/* ================================================================== *
 * Custom render lanes are first-class end-to-end
 * ================================================================== */

describe('custom render lanes end-to-end', () => {
  let outDir: string;
  const previousOut = process.env.MANHWA_OUT_DIR;
  const previousLane = process.env.MANHWA_RENDER_LANE;

  beforeEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    outDir = makeTmp('custom-lane');
    process.env.MANHWA_OUT_DIR = outDir;
    delete process.env.MANHWA_LANE_CONFIG;
    delete process.env.MANHWA_LANE_CONFIG_DIR;
    delete process.env.MANHWA_RENDER_LANE;
    writeNodes(outDir, [
      {
        id: 'worker-eu',
        label: 'EU SSH Worker',
        kind: 'ssh',
        host: 'eu.example',
        user: 'deploy',
        slots: 3,
        enabled: true,
        priority: 1,
      },
      { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1', slots: 4, enabled: true },
    ]);
  });

  afterEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    lappy._setRunnerForTests(null);
    renderlane._resetHooksForTests();
    renderPolicy.resetRenderPlan();
    if (previousOut === undefined) delete process.env.MANHWA_OUT_DIR;
    else process.env.MANHWA_OUT_DIR = previousOut;
    if (previousLane === undefined) delete process.env.MANHWA_RENDER_LANE;
    else process.env.MANHWA_RENDER_LANE = previousLane;
  });

  it('accepts a registered node in putLanesState and exposes its slots', () => {
    const defaults = laneConfig.getDefaultConfig();
    const state = laneConfig.putLanesState(
      {
        revision: 0,
        render: [{ id: 'worker-eu', enabled: true, slots: 3 }],
        models: defaults.models,
      },
      'admin',
    );
    const entry = state.config.render.find((row) => row.id === 'worker-eu');
    expect(entry).toEqual({ id: 'worker-eu', enabled: true, slots: 3 });
    // Built-ins stay in the list (disabled), so the catalog never loses a lane.
    expect(state.config.render.map((row) => row.id)).toContain('laptop');

    const runtime = state.renderRuntime.lanes.find((lane) => lane.id === 'worker-eu');
    expect(runtime).toMatchObject({ enabled: true, slots: 3, effectiveSlots: 3, maxSlots: 4 });
    expect(state.renderRuntime.order).toContain('worker-eu');

    // docker-sbx custom node is capped at 2, ssh/local at 4.
    expect(
      laneConfig.renderRuntimeContract(
        [
          { id: 'worker-eu', enabled: true, slots: 9 },
          { id: 'sbx-arm-1', enabled: true, slots: 9 },
        ],
        outDir,
      ).map((lane) => [lane.id, lane.slots, lane.effectiveSlots]),
    ).toEqual([
      ['worker-eu', 9, 4],
      ['sbx-arm-1', 9, 2],
    ]);
  });

  it('synthesizes catalog entries for registered nodes', () => {
    const catalog = laneConfig.getCatalog(undefined, { MANHWA_OUT_DIR: outDir });
    const eu = catalog.render.find((entry) => entry.id === 'worker-eu');
    expect(eu).toMatchObject({
      label: 'EU SSH Worker',
      kind: 'ssh',
      maxSlots: 4,
      defaultSlots: 3,
      costTier: 'free',
    });
    expect(catalog.render.find((entry) => entry.id === 'sbx-arm-1')?.maxSlots).toBe(2);
    // Built-ins keep their static entries.
    expect(catalog.render.find((entry) => entry.id === 'laptop')?.kind).toBe('remote');
  });

  it('pins a custom node through MANHWA_RENDER_LANE and routes _workerPlan to it', async () => {
    const defaults = laneConfig.getDefaultConfig();
    laneConfig.putLanesState(
      {
        revision: 0,
        render: [{ id: 'worker-eu', enabled: true, slots: 2 }],
        models: defaults.models,
      },
      'admin',
    );
    renderPolicy.resetRenderPlan();
    process.env.MANHWA_RENDER_LANE = 'worker-eu';

    const plan = renderPolicy.buildRenderPlan();
    expect(plan.override).toBe('worker-eu');
    expect(renderPolicy.eligibleLanes(plan).map((lane) => lane.id)).toEqual(['worker-eu']);
    expect(renderPolicy.selectRenderLane(plan, { 'worker-eu': [true, 'ok'] }, {})).toBe('worker-eu');

    const dispatched: Array<{ lane: string; workerId: string | null }> = [];
    renderlane._hooks.produce = (async (
      _sdir: string,
      ch: string,
      _out: string,
      opts: { lane?: string | null; workerId?: string | null },
    ) => {
      dispatched.push({ lane: String(opts.lane), workerId: opts.workerId ?? null });
      return [`${ch}.mp4`, 7] as [string, number];
    }) as unknown as typeof renderlane.produce;

    const q = new renderlane.RenderQueue<string | null>();
    q.put('ch1');
    q.put(null);
    const results: Record<string, renderlane.VideoResult> = {};
    const failcounts: Record<string, number> = {};

    await renderlane._workerPlan(outDir, path.join(outDir, 'out'), q, results, failcounts, plan);

    expect(results.ch1?.status).toBe('video-ok');
    expect(dispatched).toEqual([{ lane: 'worker-eu', workerId: 'worker-eu' }]);
  });

  it('maps a custom node kind to its worker kind', () => {
    expect(renderlane._laneWorkerKind('worker-eu', true)).toBe('remote');
    expect(renderlane._laneWorkerKind('sbx-arm-1', false)).toBe('cloud');
    expect(renderlane._laneWorkerKind('local', false)).toBe('local');
    expect(renderlane._laneWorkerKind('laptop', true)).toBe('remote');
    expect(renderlane._laneWorkerKind('cloud', false)).toBe('cloud');
  });
});

describe('nodeRegistry ssh key materialization', () => {  let outDir: string;
  const previousOut = process.env.MANHWA_OUT_DIR;

  beforeEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    outDir = makeTmp('ssh-keys');
    process.env.MANHWA_OUT_DIR = outDir;
  });

  afterEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    lappy._setRunnerForTests(null);
    if (previousOut === undefined) delete process.env.MANHWA_OUT_DIR;
    else process.env.MANHWA_OUT_DIR = previousOut;
  });

  it('materializes the uploaded key to a 0o600 file and passes -i to ssh', () => {
    writeNodes(outDir, [
      {
        id: 'worker-key',
        kind: 'ssh',
        host: 'eu.example',
        user: 'deploy',
        remoteDir: '/tmp/manhwa-worker',
        slots: 1,
      },
    ]);
    putSecret('render-node:worker-key', 'PRIVATE-KEY-BODY\n', outDir);

    const calls: string[][] = [];
    lappy._setRunnerForTests((args) => {
      calls.push([...args]);
      return ok('{"load":0.1,"cpus":8,"mem_gb":16,"disk_gb":100,"ac":"1","miss":""}\n');
    });

    const instance = nodeRegistry.getNodeInstance('worker-key', outDir)!;
    expect(instance.healthy(true)).toEqual([true, 'ok']);

    const keyPath = nodeRegistry.nodeKeyPath('worker-key', outDir);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('PRIVATE-KEY-BODY\n');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);

    const probe = calls.find((args) => args[0] === 'ssh')!;
    expect(probe[probe.indexOf('-i') + 1]).toBe(keyPath);
    // Absolute remoteDir is honoured verbatim (no `~/` prefix).
    expect(probe[probe.length - 1]).toContain('cd /tmp/manhwa-worker');
    expect(probe[probe.length - 1]).not.toContain('~/tmp');
  });

  it('keeps an explicit identityFile when no key was uploaded', () => {
    writeNodes(outDir, [
      {
        id: 'worker-file',
        kind: 'ssh',
        host: 'eu.example',
        remoteDir: 'render-worker',
        identityFile: '/keys/explicit',
      },
    ]);
    const calls: string[][] = [];
    lappy._setRunnerForTests((args) => {
      calls.push([...args]);
      return ok('{"load":0,"cpus":4,"mem_gb":8,"disk_gb":50,"ac":"1","miss":""}\n');
    });
    nodeRegistry.getNodeInstance('worker-file', outDir)!.healthy(true);
    const probe = calls.find((args) => args[0] === 'ssh')!;
    expect(probe[probe.indexOf('-i') + 1]).toBe('/keys/explicit');
    // A bare relative remoteDir stays relative to $HOME.
    expect(probe[probe.length - 1]).toContain('cd ~/render-worker');
  });
});

/* ================================================================== *
 * Fresh-account provisioning & sandbox CLI auth
 * ================================================================== */

describe('nodeRegistry provision: fresh docker-sbx and ssh accounts', () => {
  let outDir: string;
  const previousOut = process.env.MANHWA_OUT_DIR;
  const previousStudio = process.env.MANHWA_STUDIO;

  beforeEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    outDir = makeTmp('provision');
    process.env.MANHWA_OUT_DIR = outDir;
    const studio = path.join(outDir, 'remotion-studio');
    fs.mkdirSync(path.join(studio, 'src'), { recursive: true });
    fs.writeFileSync(path.join(studio, 'package.json'), '{"name":"studio"}');
    fs.writeFileSync(path.join(studio, 'src', 'index.ts'), '// studio');
    process.env.MANHWA_STUDIO = studio;
  });

  afterEach(() => {
    nodeRegistry._resetNodeRegistryForTests();
    nodeRegistry._setLocalRunnerForTests(null);
    cloudlane._setRunnerForTests(null);
    lappy._setRunnerForTests(null);
    if (previousOut === undefined) delete process.env.MANHWA_OUT_DIR;
    else process.env.MANHWA_OUT_DIR = previousOut;
    if (previousStudio === undefined) delete process.env.MANHWA_STUDIO;
    else process.env.MANHWA_STUDIO = previousStudio;
  });

  it('reports sbx CLI auth status from `which sbx` and `sbx ls`', () => {
    const calls: string[][] = [];
    nodeRegistry._setLocalRunnerForTests((args) => {
      calls.push([...args]);
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx\n', stderr: '' };
      return { status: 0, stdout: '{"sandboxes":[]}', stderr: '' };
    });
    const status = nodeRegistry.sandboxAuthStatus();
    expect(status).toMatchObject({ ok: true, installed: true, authenticated: true });
    expect(calls[1]).toEqual(['sbx', '--cloud', 'ls', '--json']);

    nodeRegistry._setLocalRunnerForTests(() => ({ status: 1, stdout: '', stderr: 'not logged in' }));
    expect(nodeRegistry.sandboxAuthStatus()).toMatchObject({ ok: false, installed: false });
  });

  it('returns a login URL when `sbx login` prints one', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[0]).includes('sh')) return { status: 0, stdout: '/usr/bin/sbx', stderr: '' };
      return { status: 1, stdout: 'open https://sbx.dev/device?code=ABCD\n', stderr: '' };
    });
    const started = nodeRegistry.sandboxAuthStart();
    expect(started.verificationUrl).toBe('https://sbx.dev/device?code=ABCD');
    expect(started.userCode).toBe('ABCD');
    expect(started.instructions).toContain('sbx login');
  });

  it('extracts Docker device confirmation code and skips legal agreement URL', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[0]).includes('sh')) return { status: 0, stdout: '/usr/bin/sbx', stderr: '' };
      return {
        status: 1,
        stdout: [
          'By logging in, you agree to our Subscription Service Agreement. For more details, see https://www.docker.com/legal/docker-subscription-service-agreement/',
          '',
          'Your one-time device confirmation code is: MCRN-XWZP',
          'Complete sign-in in your browser, then return to this terminal.',
          'Open this URL to sign in: https://login.docker.com/activate?user_code=MCRN-XWZP',
          '',
          'Waiting for authentication...',
        ].join('\n'),
        stderr: '',
      };
    });
    const started = nodeRegistry.sandboxAuthStart();
    expect(started.verificationUrl).toBe('https://login.docker.com/activate?user_code=MCRN-XWZP');
    expect(started.userCode).toBe('MCRN-XWZP');
    expect(started.instructions).toContain('MCRN-XWZP');
    expect(started.instructions).toContain('sbx login');
  });

  it('reports no fake link when `sbx login` prints no URL, and strips ANSI escapes', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[0]).includes('sh')) return { status: 0, stdout: '/usr/bin/sbx', stderr: '' };
      return { status: 1, stdout: 'Run `sbx login` to authenticate.\nDocs: https://docs.sbx.dev/start\n', stderr: '' };
    });
    const none = nodeRegistry.sandboxAuthStart();
    expect(none.verificationUrl).toBeNull();
    expect(none.userCode).toBeNull();
    expect(none.instructions).not.toMatch(/https?:\/\//);
    expect(none.instructions).toContain('no sign-in link');

    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[0]).includes('sh')) return { status: 0, stdout: '/usr/bin/sbx', stderr: '' };
      return {
        status: 1,
        stdout: '\u001b[36mOpen this URL to sign in: https://login.docker.com/activate?user_code=ANSI-CODE\u001b[0m\n',
        stderr: '',
      };
    });
    const ansi = nodeRegistry.sandboxAuthStart();
    expect(ansi.verificationUrl).toBe('https://login.docker.com/activate?user_code=ANSI-CODE');
    expect(ansi.userCode).toBe('ANSI-CODE');
  });

  it('falls back to `sbx exec` when `sbx start` is unsupported and probes on `status` action', () => {
    const calls: string[][] = [];
    cloudlane._setRunnerForTests((args) => {
      calls.push([...args]);
      if (args[2] === 'start') {
        return { status: 1, stdout: '', stderr: 'error: sbx: unknown command: sbx start' };
      }
      if (args[2] === 'ls') {
        return ok(JSON.stringify({ sandboxes: [{ name: 'sbx-arm-1', status: 'running' }] }));
      }
      return ok();
    });
    writeNodes(outDir, [{ id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1' }]);
    const started = nodeRegistry.runNodeAction('sbx-arm-1', 'start', { outDir, allowControl: true });
    expect(started).toEqual({ ok: true, detail: 'started sbx-arm-1' });
    expect(calls.some((args) => args[2] === 'exec' && args[3] === 'sbx-arm-1')).toBe(true);

    const status = nodeRegistry.runNodeAction('sbx-arm-1', 'status', { outDir });
    expect(status).toEqual({ ok: true, detail: 'ok', status: 'available' });
  });

  it('creates a base sandbox when the template is missing and deploys the studio', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx', stderr: '' };
      return { status: 0, stdout: '{"sandboxes":[]}', stderr: '' };
    });
    const calls: string[][] = [];
    const cloudRunner: cloudlane.ProcessRunner = (args) => {
      calls.push([...args]);
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return ok();
      }
      if (args[2] === 'ls') return ok(JSON.stringify({ sandboxes: [] }));
      if (args[2] === 'create' && args.includes('--template')) {
        return { status: 1, stdout: '', stderr: 'template manhwa-render-arm not found' };
      }
      if (args[2] === 'exec' && String(args[6]).includes('printf')) {
        return ok('{"cpus":8,"mem_gb":16,"disk_gb":40,"ffmpeg":true,"studio":true,"miss":""}\n');
      }
      return ok();
    };
    cloudlane._setRunnerForTests(cloudRunner);

    writeNodes(outDir, [
      {
        id: 'sbx-fresh', kind: 'docker-sbx', box: 'sbx-fresh', template: 'manhwa-render-arm',
        remoteDir: '/tmp/manhwa-cloud/studio',
      },
    ]);
    const res = nodeRegistry.runNodeAction('sbx-fresh', 'provision', { outDir });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('provisioned');
    expect(res.detail).toContain('base');
    expect(res.probe).toMatchObject({ ffmpeg: true, studio: true, ok: true });

    const verbs = calls.map((args) => args[2]);
    expect(verbs).toContain('create');
    // Template attempt first, then the base sandbox.
    expect(calls.some((args) => args[2] === 'create' && args.includes('--template'))).toBe(true);
    expect(calls.some((args) => args[2] === 'create' && !args.includes('--template'))).toBe(true);
    // Installs into the node's own remoteDir (the same path rendering probes).
    expect(calls.some((args) => String(args[6] ?? '').includes('mkdir -p /tmp/manhwa-cloud/studio/public'))).toBe(true);
    // ...and keeps the legacy /work/remotion-studio path as a symlink.
    expect(calls.some((args) => String(args[6] ?? '').includes('ln -sfn /tmp/manhwa-cloud/studio /work/remotion-studio'))).toBe(true);
    expect(calls.some((args) => String(args[6] ?? '').includes('cd /tmp/manhwa-cloud/studio && npm install'))).toBe(true);
    expect(calls.some((args) => args[2] === 'cp' && String(args[4]).endsWith('studio.tar.gz'))).toBe(true);
    expect(calls.some((args) => String(args[6] ?? '').includes('tar -xzf') && String(args[6]).includes('-C /tmp/manhwa-cloud/studio'))).toBe(true);
  });

  it('fails provision when the cloud probe still reports missing tools', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx', stderr: '' };
      return { status: 0, stdout: '{"sandboxes":[]}', stderr: '' };
    });
    const cloudRunner: cloudlane.ProcessRunner = (args) => {
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return ok();
      }
      if (args[2] === 'ls') return ok(JSON.stringify({ sandboxes: [{ name: 'sbx-fresh', status: 'running' }] }));
      if (args[2] === 'exec' && String(args[6]).includes('printf')) {
        return ok('{"cpus":8,"mem_gb":16,"disk_gb":40,"ffmpeg":true,"studio":true,"miss":"remotion flock"}\n');
      }
      return ok();
    };
    cloudlane._setRunnerForTests(cloudRunner);

    writeNodes(outDir, [{ id: 'sbx-fresh', kind: 'docker-sbx', box: 'sbx-fresh' }]);
    const res = nodeRegistry.runNodeAction('sbx-fresh', 'provision', { outDir });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/missing: remotion, flock/);
  });

  it('refuses provision when the sandbox CLI is not authenticated', () => {
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/bin/sbx', stderr: '' };
      return { status: 1, stdout: '', stderr: 'login required' };
    });
    writeNodes(outDir, [{ id: 'sbx-fresh', kind: 'docker-sbx', box: 'sbx-fresh' }]);
    const res = nodeRegistry.runNodeAction('sbx-fresh', 'provision', { outDir });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('unauthenticated');
    expect(res.detail).toMatch(/login/);
  });

  it('bootstraps a fresh ssh VM with accept-new host keys and streams the studio', () => {
    const calls: string[][] = [];
    lappy._setRunnerForTests((args) => {
      calls.push([...args]);
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return ok();
      }
      if (args[0] === 'scp') return ok();
      if (args[0] === 'ssh' && String(args[args.length - 1]).includes('printf')) {
        return ok('{"load":0,"cpus":4,"mem_gb":8,"disk_gb":50,"ac":"1","miss":""}\n');
      }
      return ok();
    });
    writeNodes(outDir, [
      { id: 'worker-new', kind: 'ssh', host: 'vm.example', user: 'ubuntu', remoteDir: '/home/ubuntu/worker' },
    ]);
    const res = nodeRegistry.runNodeAction('worker-new', 'provision', { outDir });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('provisioned');
    expect(res.detail).toContain('npm install');
    expect(res.probe).toMatchObject({ cpus: 4, ok: true });

    const sshCalls = calls.filter((args) => args[0] === 'ssh');
    expect(sshCalls.length).toBeGreaterThan(0);
    for (const args of sshCalls) expect(args).toContain('StrictHostKeyChecking=accept-new');
    // Installs into `${remotePath}/studio` and keeps `remotion-studio` as a symlink.
    expect(sshCalls.some((args) => String(args[args.length - 1]).includes('mkdir -p /home/ubuntu/worker/studio /home/ubuntu/worker/jobs'))).toBe(true);
    expect(sshCalls.some((args) => String(args[args.length - 1]).includes('ln -sfn /home/ubuntu/worker/studio /home/ubuntu/worker/remotion-studio'))).toBe(true);
    // rsync is part of both the package check and the install list.
    expect(sshCalls.some((args) => String(args[args.length - 1]).includes('have rsync'))).toBe(true);
    expect(sshCalls.some((args) => String(args[args.length - 1]).includes('apt-get install -y ffmpeg rsync nodejs npm'))).toBe(true);
    expect(sshCalls.some((args) => String(args[args.length - 1]).includes('cd /home/ubuntu/worker/studio && npm install --no-audit --no-fund'))).toBe(true);
    expect(calls.some((args) => args[0] === 'scp' && args.includes('ubuntu@vm.example:/home/ubuntu/worker/studio.tar.gz'))).toBe(true);
  });

  it('fails ssh provision when the final probe reports missing tools', () => {
    lappy._setRunnerForTests((args) => {
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return ok();
      }
      if (args[0] === 'scp') return ok();
      if (args[0] === 'ssh' && String(args[args.length - 1]).includes('printf')) {
        return ok('{"load":0,"cpus":4,"mem_gb":8,"disk_gb":50,"ac":"1","miss":"studio rsync"}\n');
      }
      return ok();
    });
    writeNodes(outDir, [
      { id: 'worker-new', kind: 'ssh', host: 'vm.example', user: 'ubuntu', remoteDir: '/home/ubuntu/worker' },
    ]);
    const res = nodeRegistry.runNodeAction('worker-new', 'provision', { outDir });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/missing: studio, rsync/);
  });

  it('fails ssh provision when the final probe returns invalid JSON', () => {
    lappy._setRunnerForTests((args) => {
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return ok();
      }
      if (args[0] === 'scp') return ok();
      if (args[0] === 'ssh' && String(args[args.length - 1]).includes('printf')) {
        return { status: 0, stdout: 'not json\n', stderr: '' };
      }
      return ok();
    });
    writeNodes(outDir, [
      { id: 'worker-new', kind: 'ssh', host: 'vm.example', user: 'ubuntu', remoteDir: '/home/ubuntu/worker' },
    ]);
    const res = nodeRegistry.runNodeAction('worker-new', 'provision', { outDir });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/invalid JSON/);
  });

  it('reports a local node as not applicable', () => {
    writeNodes(outDir, [{ id: 'local-b', kind: 'local' }]);
    const res = nodeRegistry.runNodeAction('local-b', 'provision', { outDir });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('not-applicable');
  });
});
