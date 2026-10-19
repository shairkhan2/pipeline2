/**
 * T1.4 control-plane tests, ported from the v1 suites:
 *   pipeline/tests/test_lane_config.py   -> lanes state store (defaults, revision
 *     optimistic concurrency, forbidden keys, secret scrubbing, unreliable lock)
 *   pipeline/tests/test_render_policy.py -> legacy vs persisted plan, per-run override
 *   player/tests/test_status.py          -> telemetry snapshot lifecycle + status probe
 *
 * Offline only: no provider calls, no rendering, no writes into the v1 tree.
 * Every on-disk side effect lives in an isolated temp dir under /tmp/opencode.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LANE_CONFIG_FILENAME,
  LaneConfigValidationError,
  RevisionConflictError,
  checkForbiddenKeys,
  configPath,
  effectiveRenderSlots,
  getCatalog,
  getDefaultConfig,
  getLanesState,
  loadEffectiveLaneConfig,
  putLanesState,
  resetLanesState,
  renderRuntimeContract,
  scrubSecrets,
  sanitizeLine,
} from '../src/config/laneConfig.js';
import {
  RENDER_LANE_ENV,
  buildRenderPlan,
  checkRenderLaneAvailable,
  eligibleLanes,
  fallbackChain,
  laneAvailability,
  normalizeRenderLane,
  normalizeRenderOverride,
  parseRenderOverride,
  planStatus,
  renderEnvSwitches,
  renderOverrideOptions,
  renderLanes,
  renderPolicySemantics,
  resetRenderPlan,
  resolveRenderPlan,
  selectRenderLane,
  setTransportDefaults,
} from '../src/config/renderPolicy.js';
import * as telemetry from '../src/telemetry/telemetry.js';
import {
  batteryInfo,
  collectStatus,
  cloudLane,
  enrichRun,
  mergeWorker,
  observeLog,
  parseCalls,
  sampleRates,
  _resetStatusCache,
} from '../src/telemetry/statusProbe.js';

const tmpRoots: string[] = [];
afterAll(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeTemp(prefix: string): string {
  fsSync.mkdirSync('/tmp/opencode', { recursive: true });
  const dir = fsSync.mkdtempSync(path.join('/tmp/opencode', `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

/** env map isolating the lane config under a throwaway dir */
function laneEnv(cfgDir: string): Record<string, string> {
  return { MANHWA_LANE_CONFIG_DIR: cfgDir, PATH: process.env.PATH ?? '' };
}

/** Replaces process.env for modules that read it at call time (telemetry). */
function stubProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = { ...process.env } as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) process.env[k] = undefined as never;
    else process.env[k] = v;
  }
  return () => {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  };
}

const RENDER_SWITCHES = { MANHWA_RENDER_REMOTE: 'lappy-host', MANHWA_RENDER_CLOUD: 'render-box' };

/* ------------------------------------------------------------------ *
 * Lane config: default state
 * ------------------------------------------------------------------ */

describe('lanes state: read-only defaults', () => {
  it('absent config dir -> defaults, never touched on disk (v1 test_lane_config)', () => {
    const root = makeTemp('t14-defaults');
    const cfgDir = path.join(root, 'config');
    const env = laneEnv(cfgDir);
    const state = getLanesState(env);
    expect(fsSync.existsSync(cfgDir)).toBe(false); // read-only path must not create anything
    expect(state.schemaVersion).toBe(1);
    expect(state.revision).toBe(0);
    expect(state.source).toBe('defaults');
    expect(state.persisted).toBe(false);
    expect(state.persistedValid).toBe(true);
    expect(state.persistedActive).toBe(false);
    expect(state.isDefault).toBe(true);
    expect(state.configError).toBeNull();
    expect(state.appliesTo).toBe('next-run');
    const rti = state.runtimeIntegration;
    expect(rti.modelLanesIntegrated).toBe(true);
    expect(rti.modelLanesActive).toBe(false);
    expect(rti.renderSchedulerIntegrated).toBe(true);
    expect(rti.renderLanesActive).toBe(false);
    expect(rti.perJobRenderOverrideIntegrated).toBe(true);
    expect(rti.liveRunsInterrupted).toBe(false);
    expect(rti.status).toBe('model-render-runtime-wired');
    expect(state.config).toEqual(state.defaults);
  });

  it('default chains are the static llm.py snapshot; render preserves laptop -> cloud(disabled) -> local', () => {
    const env = laneEnv(path.join(makeTemp('t14-chains'), 'config'));
    const defaults = getLanesState(env).defaults;
    const vision = defaults.models.vision;
    const writer = defaults.models.writer;
    expect(vision.map((m) => m.id).slice(0, 5)).toEqual([
      'agy:gemini-3.8-flash-low',
      'workbuddy:deepseek-v4.1-flash',
      'opencode:mimo-v2.5-free',
      'opencode:muse-spark-1.2-contributor-free',
      'workbuddy:hy3',
    ]);
    expect(writer.map((m) => m.id).slice(0, 4)).toEqual([
      'workbuddy:deepseek-v4.1-flash',
      'agy:gemini-3.8-flash-medium',
      'opencode:muse-spark-1.2-contributor-free',
      'opencode:muse-spark-1.3-contributor-free',
    ]);
    expect(vision.every((m) => m.enabled && m.concurrency === 1)).toBe(true);
    expect(writer.every((m) => m.enabled && m.concurrency === 1)).toBe(true);
    expect(defaults.render).toEqual([
      { id: 'laptop', enabled: true, slots: 1 },
      { id: 'cloud', enabled: false, slots: 2 },
      { id: 'local', enabled: true, slots: 1 },
    ]);
  });

  it('catalog is credential-free and the static default chains are the head of modelsByRole', () => {
    const env = laneEnv(path.join(makeTemp('t14-catalog'), 'config'));
    const state = getLanesState(env);
    const catalog = state.catalog;
    expect(catalog.roles).toEqual(['vision', 'writer']);
    expect(catalog.modelConcurrencyBounds).toEqual({ min: 1, max: 4, default: 1 });
    expect(catalog.modelsByRole.vision[0]).toBe('agy:gemini-3.8-flash-low');
    expect(catalog.modelsByRole.writer[0]).toBe('workbuddy:deepseek-v4.1-flash');
    const serialized = JSON.stringify(state);
    for (const forbidden of ['127.0.0.1', 'openrouter.ai', 'codebuddy.ai', 'googleapis.com', 'WORKBUDDY_API_KEY', 'OPENROUTER_API_KEY', 'AGY_PROXY_API_KEY', 'key_env']) {
      expect(serialized).not.toContain(forbidden);
    }
    // Grok text/vision must appear ONLY as a documented unavailable lane.
    const grok = catalog.unavailableModels;
    expect(grok.map((m) => m.model)).toContain('grok-4.7');
    expect(grok.every((m) => m.available === false && m.reason.length > 0)).toBe(true);
  });

  it('loadEffectiveLaneConfig(strict) throws on a corrupt file and falls back without strict', () => {
    const root = makeTemp('t14-effective');
    const cfgDir = path.join(root, 'config');
    fsSync.mkdirSync(cfgDir, { recursive: true });
    fsSync.writeFileSync(path.join(cfgDir, LANE_CONFIG_FILENAME), '{corrupt-json');
    const env = laneEnv(cfgDir);
    expect(() => loadEffectiveLaneConfig(env, true)).toThrow(LaneConfigValidationError);
    expect(loadEffectiveLaneConfig(env)).toEqual(getDefaultConfig());
  });
});

/* ------------------------------------------------------------------ *
 * Lane config: put / revision / reset
 * ------------------------------------------------------------------ */

describe('lanes state: optimistic concurrency (putLanesState / resetLanesState)', () => {
  let root: string;
  let cfgDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = makeTemp('t14-lanestore');
    cfgDir = path.join(root, 'config');
    fsSync.mkdirSync(cfgDir, { recursive: true });
    env = laneEnv(cfgDir);
  });

  const persistedPayload = () => {
    const defaults = getDefaultConfig();
    return {
      revision: 0,
      render: [
        { id: 'local', enabled: true, slots: 1 },
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'cloud', enabled: true, slots: 2 },
      ],
      models: {
        vision: [
          { id: 'workbuddy:deepseek-v4.1-flash', enabled: true, concurrency: 2 },
          { id: 'agy:gemini-3.8-flash-low', enabled: true, concurrency: 1 },
          { id: 'opencode:mimo-v2.5-free', enabled: false, concurrency: 1 },
          { id: 'opencode:muse-spark-1.2-contributor-free', enabled: true, concurrency: 1 },
          { id: 'workbuddy:hy3', enabled: false, concurrency: 1 },
        ],
        writer: [
          { id: 'agy:gemini-3.8-flash-medium', enabled: true, concurrency: 2 },
          { id: 'workbuddy:deepseek-v4.1-flash', enabled: true, concurrency: 1 },
          { id: 'opencode:muse-spark-1.2-contributor-free', enabled: false, concurrency: 1 },
          { id: 'opencode:muse-spark-1.3-contributor-free', enabled: false, concurrency: 1 },
        ],
      },
    };
  };

  it('update -> persisted active; stale revision 409s with the current revision', () => {
    const s1 = putLanesState(persistedPayload(), 'admin', env);
    expect(s1.revision).toBe(1);
    expect(s1.source).toBe('persisted');
    expect(s1.persisted).toBe(true);
    expect(s1.persistedValid).toBe(true);
    expect(s1.persistedActive).toBe(true);
    expect(s1.isDefault).toBe(false);
    expect(s1.updatedBy).toBe('admin');
    expect(s1.updatedAt).toBeGreaterThan(0);
    expect(s1.config.render.map((r) => r.id)).toEqual(['local', 'laptop', 'cloud']);
    expect(s1.config.render[2].slots).toBe(2);
    expect(s1.config.models.vision[0]).toEqual({
      id: 'workbuddy:deepseek-v4.1-flash',
      enabled: true,
      concurrency: 2,
    });

    // Stale revision 0 now conflicts: 409 + revision 1 reported.
    let conflict: RevisionConflictError | null = null;
    try {
      putLanesState({ ...persistedPayload(), revision: 0 }, null, env);
    } catch (err) {
      conflict = err as RevisionConflictError;
    }
    expect(conflict).toBeInstanceOf(RevisionConflictError);
    expect(conflict!.statusCode).toBe(409);
    expect(conflict!.status_code).toBe(409);
    expect(conflict!.code).toBe('revision_conflict');
    expect(conflict!.currentRevision).toBe(1);
    expect(conflict!.current_revision).toBe(1);
  });

  it('partial lists normalize: omitted catalog entries append as disabled', () => {
    putLanesState(persistedPayload(), 'admin', env);
    const s2 = putLanesState(
      {
        revision: 1,
        config: {
          render: [{ id: 'local', enabled: true, slots: 1 }],
          models: {
            vision: ['opencode:mimo-v2.5-free'],
            writer: ['opencode:muse-spark-1.3-contributor-free'],
          },
        },
      },
      'admin',
      env,
    );
    expect(s2.revision).toBe(2);
    expect(s2.config.render).toEqual([
      { id: 'local', enabled: true, slots: 1 },
      { id: 'laptop', enabled: false, slots: 1 },
      { id: 'cloud', enabled: false, slots: 2 },
    ]);
    expect(s2.config.models.vision[0]).toEqual({
      id: 'opencode:mimo-v2.5-free',
      enabled: true,
      concurrency: 1,
    });
    expect(Array.from(s2.config.models.vision.slice(1), (m) => m.enabled).every((e) => !e)).toBe(true);
    expect(s2.config.models.vision.length).toBe(5);
    expect(s2.config.models.writer.length).toBe(4);
  });

  it('reset: wrong revision 409s, accepted reset publishes the defaults under revision 3', () => {
    putLanesState(persistedPayload(), 'admin', env);
    putLanesState(
      {
        revision: 1,
        config: {
          render: [{ id: 'local', enabled: true, slots: 1 }],
          models: {
            vision: ['opencode:mimo-v2.5-free'],
            writer: ['opencode:muse-spark-1.3-contributor-free'],
          },
        },
      },
      'admin',
      env,
    );
    // Reset with a stale revision fails with 409 and the current revision.
    expect(() => resetLanesState(1, null, env)).toThrow(RevisionConflictError);
    let current: number | null = null;
    try {
      resetLanesState(1, null, env);
    } catch (err) {
      current = (err as RevisionConflictError).currentRevision;
    }
    expect(current).toBe(2);

    // Reset via update(reset=true, revision=2) -> revision 3, defaults restored.
    const s3 = putLanesState({ reset: true, revision: 2 }, 'admin', env);
    expect(s3.revision).toBe(3);
    expect(s3.isDefault).toBe(true);
    expect(s3.config).toEqual(s3.defaults);
  });

  it('put revision above the current is a clean 409 (no "future" overwrite)', () => {
    const defaults = getDefaultConfig();
    expect(() =>
      putLanesState({ revision: 7, render: defaults.render, models: defaults.models }, null, env),
    ).toThrow(RevisionConflictError);
  });

  it('update interleaved with reset keeps revision strictly increasing across actors', () => {
    const defaults = getDefaultConfig();
    const s1 = putLanesState({ revision: 0, render: defaults.render, models: defaults.models }, 'a', env);
    const s2 = resetLanesState(s1.revision, 'b', env);
    const s3 = putLanesState({ revision: s2.revision, render: defaults.render, models: defaults.models }, 'a', env);
    const s4 = resetLanesState(s3.revision, 'b', env);
    expect([s1.revision, s2.revision, s3.revision, s4.revision]).toEqual([1, 2, 3, 4]);
    expect(s4.updatedBy).toBe('b');
  });

  it('resetLanesState validates the expected revision shape', () => {
    expect(() => resetLanesState(Number.NaN, null, env)).toThrow(LaneConfigValidationError);
    expect(() => resetLanesState(-3, null, env)).toThrow(LaneConfigValidationError);
  });
});

describe('lane config: validation rejections (v1 bad-case table)', () => {
  let env: Record<string, string>;

  beforeEach(() => {
    const root = makeTemp('t14-validate');
    fsSync.mkdirSync(path.join(root, 'config'), { recursive: true });
    env = laneEnv(path.join(root, 'config'));
  });

  const validPayload = (overrides: Record<string, unknown> = {}) => {
    const defaults = getDefaultConfig();
    const payload: Record<string, unknown> = {
      revision: 0,
      render: defaults.render,
      models: defaults.models,
    };
    return Object.assign(payload, overrides);
  };

  it('rejects every documented bad payload with a lane validation error', () => {
    const defaults = getDefaultConfig();
    const badCases: Array<[Record<string, unknown>, RegExp]> = [
      // Missing revision
      [{ render: defaults.render, models: defaults.models }, /revision is required/],
      // Boolean revision (the isinstance(True, int) trap)
      [validPayload({ revision: true }), /revision must be a non-negative integer/],
      // Negative revision
      [validPayload({ revision: -1 }), /revision must be a non-negative integer/],
      // Unknown top level field
      [validPayload({ extraField: 123 }), /Unknown request field/],
      // Forbidden keys at top level or nested
      [validPayload({ api_key: 'sk-secret' }), /Forbidden configuration field/],
      [validPayload({ endpoint: 'https://evil.example/v1' }), /Forbidden configuration field/],
      [validPayload({ command: 'rm -rf /' }), /Forbidden configuration field/],
      [
        validPayload({
          render: [{ id: 'local', enabled: true, slots: 1, ssh: 'root@evil' }],
        }),
        /Forbidden configuration field/,
      ],
      [
        validPayload({
          models: {
            vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: true, url: 'http://127.0.0.1' }],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /Forbidden configuration field/,
      ],
      // Unknown render field
      [
        validPayload({ render: [{ id: 'local', enabled: true, slots: 1, priority: 1 }] }),
        /Unknown field 'priority'/,
      ],
      // Unknown render lane id
      [
        validPayload({ render: [{ id: 'gpu-cluster', enabled: true, slots: 1 }] }),
        /Unknown render lane ID 'gpu-cluster'/,
      ],
      // Duplicate render lane id
      [
        validPayload({
          render: [
            { id: 'local', enabled: true, slots: 1 },
            { id: 'local', enabled: false, slots: 1 },
          ],
        }),
        /Duplicate render lane ID 'local'/,
      ],
      // Real transport caps bound the offered slots
      [validPayload({ render: [{ id: 'local', enabled: true, slots: 0 }] }), /must be between 1 and 1/],
      [validPayload({ render: [{ id: 'local', enabled: true, slots: 2 }] }), /must be between 1 and 1/],
      [validPayload({ render: [{ id: 'laptop', enabled: true, slots: 2 }] }), /must be between 1 and 1/],
      [validPayload({ render: [{ id: 'cloud', enabled: true, slots: 3 }] }), /must be between 1 and 2/],
      [validPayload({ render: [{ id: 'cloud', enabled: true, slots: 5 }] }), /must be between 1 and 2/],
      [validPayload({ render: [{ id: 'local', enabled: true, slots: true }] }), /must be an integer/],
      // All render lanes disabled
      [
        validPayload({
          render: [
            { id: 'laptop', enabled: false, slots: 1 },
            { id: 'cloud', enabled: false, slots: 2 },
            { id: 'local', enabled: false, slots: 1 },
          ],
        }),
        /At least one render lane must remain enabled/,
      ],
      [validPayload({ render: [] }), /render cannot be empty/],
      // Unknown model role
      [
        validPayload({
          models: {
            vision: ['agy:gemini-3.8-flash-low'],
            writer: ['workbuddy:deepseek-v4.1-flash'],
            tts: ['edge'],
          },
        }),
        /Unknown model role 'tts'/,
      ],
      // Missing model role
      [
        validPayload({ models: { vision: ['agy:gemini-3.8-flash-low'] } }),
        /Missing required model role 'writer'/,
      ],
      // Unknown model catalog ID
      [
        validPayload({
          models: {
            vision: ['grok:grok-vision-beta'],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /Unknown model catalog ID 'grok:grok-vision-beta'/,
      ],
      // Role capability mismatch
      [
        validPayload({
          models: {
            vision: ['opencode:muse-spark-1.3-contributor-free'],
            writer: ['agy:gemini-3.8-flash-medium'],
          },
        }),
        /does not support role 'vision'/,
      ],
      // Duplicate model id in one role
      [
        validPayload({
          models: {
            vision: ['agy:gemini-3.8-flash-low', 'agy:gemini-3.8-flash-low'],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /Duplicate model lane ID/,
      ],
      // Model concurrency out of bounds or bool
      [
        validPayload({
          models: {
            vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: true, concurrency: 0 }],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /must be between 1 and 4/,
      ],
      [
        validPayload({
          models: {
            vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: true, concurrency: 5 }],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /must be between 1 and 4/,
      ],
      [
        validPayload({
          models: {
            vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: true, concurrency: true }],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /must be an integer/,
      ],
      // Empty usable chain (all disabled in one role)
      [
        validPayload({
          models: {
            vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: false }],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        }),
        /Model role 'vision' must keep at least one enabled lane/,
      ],
      [
        validPayload({
          models: {
            vision: ['agy:gemini-3.8-flash-low'],
            writer: [{ id: 'workbuddy:deepseek-v4.1-flash', enabled: false }],
          },
        }),
        /Model role 'writer' must keep at least one enabled lane/,
      ],
      // reset=true combined with render/models
      [
        { reset: true, revision: 0, render: [{ id: 'local', enabled: true, slots: 1 }] },
        /Cannot combine reset=true/,
      ],
      // normalize rejects the misbehaving top-level request
      [
        { revision: 0, render: defaults.render, models: defaults.models, bogus: true },
        /Unknown request field/,
      ],
    ];

    for (const [payload, pattern] of badCases) {
      expect(() => putLanesState(payload, null, env), pattern.source).toThrow(pattern);
    }
  });

  it('denies a Grok lane outright: xAI text/vision are not wired on this host', () => {
    expect(() =>
      putLanesState(
        {
          revision: 0,
          render: getDefaultConfig().render,
          models: {
            vision: ['grok:grok-4.7'],
            writer: ['workbuddy:deepseek-v4.1-flash'],
          },
        },
        null,
        env,
      ),
    ).toThrow(/grok:grok-4\.7.*not available for role 'vision'/);
    expect(() =>
      putLanesState(
        {
          revision: 0,
          render: getDefaultConfig().render,
          models: {
            vision: ['agy:gemini-3.8-flash-low'],
            writer: ['grok:grok-4.6'],
          },
        },
        null,
        env,
      ),
    ).toThrow(/grok:grok-4\.6.*not available for role 'writer'/);
    // The catalog documents *why* it is unavailable (never a generic 404).
    const catalog = getCatalog();
    const grokEntry = catalog.unavailableModels.find((m) => m.model === 'grok-4.7');
    expect(grokEntry?.reason).toMatch(/Grok Voice TTS/);
  });

  it('x_-prefixed and hyphenated disguises of forbidden keys still fail', () => {
    expect(() => checkForbiddenKeys({ 'x-command': 'ls' }, 'body')).toThrow(LaneConfigValidationError);
    expect(() => checkForbiddenKeys({ 'base-url': 'http://x' }, 'body')).toThrow(LaneConfigValidationError);
    checkForbiddenKeys({ allowed: { nested: { never_forbidden: 1 } } }, 'body'); // unknown keys pass
  });
});

describe('secret scrubbing (v1 scrubSecrets + sanitizeLine)', () => {
  it('redacts bearer tokens, JWTs, xai/sk keys and key=value pairs', () => {
    expect(scrubSecrets('Bearer abc.def.ghi')).toBe('Bearer [REDACTED]');
    expect(scrubSecrets('jwt eyJpayload.eyJmore.sig over')).not.toContain('eyJmore');
    expect(scrubSecrets('openid xai-123456789abcdef')).not.toContain('123456789abcdef');
    expect(scrubSecrets('serve sk-0123456789abcdef')).not.toContain('0123456789abcdef');
    expect(scrubSecrets('api_key=super-secret-value here')).toBe('api_key=[REDACTED] here');
    expect(scrubSecrets('{"token":"hunter2"}')).not.toContain('hunter2');
    expect(scrubSecrets('secret=x; host=y')).toBe('secret=[REDACTED] host=y');
    expect(scrubSecrets('auth=x; host=y')).toBe('auth=x; host=y'); // bare "auth" is not a kv secret
  });

  it('ANSI escapes are stripped and sanitizeLine collapses whitespace with a length cap', () => {
    expect(sanitizeLine('\x1b[31mboom\x1b[0m  key=secret-value\n\t tail')).not.toMatch(/\x1b/);
    expect(sanitizeLine('a \x20 b\t c   d')).toBe('a b c d');
    expect(sanitizeLine('x'.repeat(500)).length).toBe(320);
  });

  it('scrubSecrets tolerates non-string input', () => {
    expect(scrubSecrets(undefined)).toBe('');
    expect(scrubSecrets(null)).toBe('');
    expect(scrubSecrets(42)).toBe('42');
  });
});

describe('lane config: corrupt persisted file surfacing and repair (v1 story)', () => {
  it('invalid_persisted is reported, defaults stay active, reset repairs and bumps revision', () => {
    const root = makeTemp('t14-corrupt');
    const cfgDir = path.join(root, 'config');
    fsSync.mkdirSync(cfgDir, { recursive: true });
    const env = laneEnv(cfgDir);
    const cpath = configPath(env);

    // 1. corrupt non-JSON on disk
    fsSync.writeFileSync(cpath, '{corrupt-json');
    const state = getLanesState(env);
    expect(state.source).toBe('invalid_persisted');
    expect(state.persisted).toBe(true);
    expect(state.persistedValid).toBe(false);
    expect(state.persistedActive).toBe(false);
    expect(state.revision).toBe(0);
    expect(state.configError).toContain('invalid JSON');
    expect(state.config).toEqual(state.defaults);

    // 2. schema-invalid JSON with revision 4 (all render lanes disabled)
    fsSync.writeFileSync(
      cpath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        render: [{ id: 'local', enabled: false, slots: 1 }],
        models: getDefaultConfig().models,
      }),
    );
    const state2 = getLanesState(env);
    expect(state2.source).toBe('invalid_persisted');
    expect(state2.persistedValid).toBe(false);
    expect(state2.revision).toBe(4);
    expect(state2.configError).toContain('Invalid persisted lane config');
    expect(state2.config).toEqual(state2.defaults);

    // 3. reset repairs the corrupt file and publishes revision 5
    const repaired = resetLanesState(4, 'admin', env);
    expect(repaired.revision).toBe(5);
    expect(repaired.persistedValid).toBe(true);
    expect(repaired.source).toBe('persisted');
    expect(repaired.configError).toBeNull();
  });

  it('an oversized persisted file is likewise refused (64 KiB ceiling)', () => {
    const root = makeTemp('t14-oversize');
    const cfgDir = path.join(root, 'config');
    fsSync.mkdirSync(cfgDir, { recursive: true });
    const env = laneEnv(cfgDir);
    fsSync.writeFileSync(configPath(env), 'x'.repeat(70000));
    const state = getLanesState(env);
    expect(state.persistedValid).toBe(false);
    expect(state.configError).toContain('bytes');
  });

  it('an unusable lock (directory instead of file) fails mutations closed, reads survive', () => {
    const root = makeTemp('t14-lockdir');
    const cfgDir = path.join(root, 'config');
    fsSync.mkdirSync(cfgDir, { recursive: true });
    fsSync.mkdirSync(path.join(cfgDir, 'lanes.lock'));
    const env = laneEnv(cfgDir);
    expect(getLanesState(env).revision).toBe(0);
    let thrown: unknown = null;
    try {
      resetLanesState(null, null, env);
    } catch (err) {
      thrown = err;
    }
    // Code must be lock_unavailable / 503-shaped: fail closed, never silent.
    expect((thrown as { code?: string; statusCode?: number }).code).toBe('lock_unavailable');
    expect((thrown as { statusCode?: number }).statusCode).toBe(503);
    expect(fsSync.readdirSync(cfgDir)).toEqual(['lanes.lock']); // no lanes.json was written
  });
});

/* ------------------------------------------------------------------ *
 * Render policy
 * ------------------------------------------------------------------ */

describe('render policy: legacy vs persisted plan', () => {
  let root: string;
  let cfgDir: string;

  beforeEach(() => {
    resetRenderPlan();
    setTransportDefaults({ laptopHost: '', cloudName: '' });
  });

  function envWith(extra: Record<string, string> = {}): Record<string, string> {
    root = makeTemp('t14-policy');
    cfgDir = path.join(root, 'config');
    return {
      MANHWA_LANE_CONFIG_DIR: cfgDir,
      PIPELINE_LOG: path.join(root, 'pipeline.log'),
      ...extra,
    };
  }

  function persist(
    render: Array<{ id: string; enabled: boolean; slots: number }>,
    env: Record<string, string>,
  ) {
    const payload = {
      revision: getLanesState(env).revision,
      render,
      models: getDefaultConfig().models,
    };
    return putLanesState(payload, 'test', env);
  }

  it('legacy plan with env switches set: all three lanes eligible even though catalog cloud is off by default', () => {
    const env = envWith({ ...RENDER_SWITCHES });
    const plan = buildRenderPlan(env);
    expect(plan.legacy).toBe(true);
    expect(plan.source).toBe('legacy');
    expect(plan.lanes.map((l) => l.id)).toEqual(['laptop', 'cloud', 'local']);
    expect(plan.lanes.every((l) => l.enabled && l.configured)).toBe(true);
    expect(plan.override).toBeNull();
    expect(eligibleLanes(plan)).toEqual(plan.lanes);
  });

  it('legacy plan without env switches is local-only', () => {
    const env = envWith({});
    const plan = buildRenderPlan(env);
    expect(plan.legacy).toBe(true);
    expect(plan.lanes.map((l) => l.id)).toEqual(['laptop', 'cloud', 'local']);
    expect(plan.lanes.filter((l) => l.enabled).map((l) => l.id)).toEqual(['local']);
  });

  it('persisted order/enablement/slots drive the plan, independent of catalog priority', () => {
    const env = envWith({ ...RENDER_SWITCHES });
    persist(
      [
        { id: 'local', enabled: true, slots: 1 },
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'cloud', enabled: false, slots: 2 },
      ],
      env,
    );
    const plan = buildRenderPlan(env);
    expect(plan.legacy).toBe(false);
    expect(plan.source).toBe('persisted');
    expect(plan.lanes.map((l) => l.id)).toEqual(['local', 'laptop', 'cloud']); // persisted order, not catalog order
    expect(plan.lanes.filter((l) => l.enabled).map((l) => l.id)).toEqual(['local', 'laptop']);
    expect(plan.lanes.map((l) => l.effectiveSlots)).toEqual([1, 1, 2]);
    expect(plan.lanes.map((l) => l.slots)).toEqual([1, 1, 2]);
    // The advertised catalog bounds ARE the real transport caps.
    for (const lane of plan.lanes) {
      expect(lane.maxSlots).toEqual(lane.id === 'cloud' ? 2 : 1);
    }
  });

  it('selection and overflow: first available with free slots, never stacking on full lanes', () => {
    setTransportDefaults({ laptopHost: 'lappy-host', cloudName: 'render-box' });
    const env = envWith({ ...RENDER_SWITCHES });
    persist(
      [
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'local', enabled: true, slots: 1 },
      ],
      env,
    );
    const plan = buildRenderPlan(env);
    const avail = { laptop: [true, 'ok'] as [boolean, string], local: [true, 'ok'] as [boolean, string] };
    expect(selectRenderLane(plan, avail)).toBe('laptop');
    expect(selectRenderLane(plan, avail, { laptop: 1 })).toBe('local'); // overflow
    expect(selectRenderLane(plan, avail, { laptop: 1, local: 1 })).toBeNull(); // wait, never stack
    const avail2 = { laptop: [false, 'down'] as [boolean, string], local: [true, 'ok'] as [boolean, string] };
    expect(selectRenderLane(plan, avail2)).toBe('local');
    // Offline but configured laptop is genuinely in the availability map
    const probed = laneAvailability(plan, { laptop: () => [false, 'offline'] });
    expect(probed.laptop).toEqual([false, 'offline']);
    expect(probed.local).toEqual([true, 'local']); // local host never probes
  });

  it('resolved plan is a snapshot: config edits mid-run do not disturb it, next resolution sees them', () => {
    const env = envWith({ ...RENDER_SWITCHES });
    persist(
      [
        { id: 'local', enabled: true, slots: 1 },
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'cloud', enabled: false, slots: 2 },
      ],
      env,
    );
    const first = resolveRenderPlan(env);
    expect(eligibleLanes(first).map((l) => l.id)).toEqual(['local', 'laptop']);
    // Rewrite the file underneath the resolved plan.
    persist(
      [
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'local', enabled: true, slots: 1 },
        { id: 'cloud', enabled: true, slots: 2 },
      ],
      env,
    );
    const second = resolveRenderPlan(env);
    expect(second).toEqual(first); // an in-flight run keeps its resolved plan
    resetRenderPlan();
    const third = resolveRenderPlan(env);
    expect(eligibleLanes(third).map((l) => l.id)).toEqual(['laptop', 'local', 'cloud']);
  });

  it('resolveRenderPlan returns a defensive clone (mutating it cannot poison the cache)', () => {
    const env = envWith({});
    const plan = resolveRenderPlan(env);
    (plan.lanes as unknown[]).length = 0;
    expect(resolveRenderPlan(env).lanes.length).toBe(3);
  });

  it('renderRuntimeContract clamps even a hand-edited list onto real transport caps', () => {
    const lanes = renderRuntimeContract([
      { id: 'cloud', enabled: true, slots: 4 },
      { id: 'local', enabled: true, slots: 2 },
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['cloud', 'local']);
    expect(lanes.map((l) => l.order)).toEqual([0, 1]);
    expect(lanes.map((l) => [l.slots, l.effectiveSlots])).toEqual([
      [4, 2],
      [2, 1],
    ]);
    expect(effectiveRenderSlots([{ id: 'laptop', slots: 9 }, { id: 'cloud', slots: 1 }])).toEqual({
      laptop: 1,
      cloud: 1,
    });
  });

  it('runtime state flags stay truthful whether defaults or persisted are active', () => {
    const env = envWith({ ...RENDER_SWITCHES });
    const state = getLanesState(env);
    expect(state.runtimeIntegration.renderLanesActive).toBe(false);
    expect(state.persistedActive).toBe(false);
    expect(state.renderRuntime.order).toEqual(['laptop', 'local']);

    persist(
      [
        { id: 'local', enabled: true, slots: 1 },
        { id: 'laptop', enabled: true, slots: 1 },
        { id: 'cloud', enabled: false, slots: 2 },
      ],
      env,
    );
    const state2 = getLanesState(env);
    expect(state2.persistedActive).toBe(true);
    expect(state2.runtimeIntegration.renderLanesActive).toBe(true);
    expect(state2.renderRuntime.order).toEqual(['local', 'laptop']);
    expect(state2.renderRuntime.lanes.map((l) => [l.id, l.slots, l.effectiveSlots])).toEqual([
      ['local', 1, 1],
      ['laptop', 1, 1],
      ['cloud', 2, 2],
    ]);
  });

  it('policy semantics: a persisted default echo names the env-configured lane it disables', () => {
    const env = envWith({ ...RENDER_SWITCHES });
    const cfg = getDefaultConfig(); // laptop on, cloud OFF, local on
    const legacy = renderPolicySemantics(cfg, env, 'defaults');
    expect(legacy.persistedRenderPolicy).toBe(false);
    expect(legacy.envRenderSwitches).toEqual({ laptop: true, cloud: true });
    expect(legacy.envEnabledButDisabled).toEqual([]);
    expect(legacy.note).toContain('legacy');
    // Never auto-enables anything from the report.
    expect(Object.keys(legacy)).not.toContain('enabled');

    const persisted = renderPolicySemantics(cfg, env, 'persisted');
    expect(persisted.persistedRenderPolicy).toBe(true);
    expect(persisted.envEnabledButDisabled).toEqual(['cloud']);
    expect(persisted.note).toContain('envEnabledButDisabled');

    // A persisted config that matches the env reports no conflict.
    const matching = { ...cfg, render: dataCloudOn() };
    expect(renderPolicySemantics(matching, env, 'persisted').envEnabledButDisabled).toEqual([]);
  });

  function dataCloudOn() {
    return [
      { id: 'laptop', enabled: true, slots: 1 },
      { id: 'cloud', enabled: true, slots: 2 },
      { id: 'local', enabled: true, slots: 1 },
    ];
  }
});

describe('per-run render override (MANHWA_RENDER_LANE)', () => {
  let env: Record<string, string>;

  beforeEach(() => {
    resetRenderPlan();
    setTransportDefaults({ laptopHost: 'lappy-host', cloudName: 'render-box' });
    const root = makeTemp('t14-override');
    fsSync.mkdirSync(path.join(root, 'config'), { recursive: true });
    env = {
      MANHWA_LANE_CONFIG_DIR: path.join(root, 'config'),
      ...RENDER_SWITCHES,
    };
    putLanesState(
      {
        revision: 0,
        render: [
          { id: 'laptop', enabled: true, slots: 1 },
          { id: 'local', enabled: true, slots: 1 },
          { id: 'cloud', enabled: true, slots: 2 },
        ],
        models: getDefaultConfig().models,
      },
      'test',
      env,
    );
  });

  it('inherit and enum override round-trip; env value honored with no explicit override', () => {
    expect(buildRenderPlan(env).override).toBeNull();
    expect(buildRenderPlan(env, 'inherit').override).toBeNull();
    expect(buildRenderPlan(env, 'laptop').override).toBe('laptop');
    expect(buildRenderPlan(env, 'local').override).toBe('local');
    // env value honored when no explicit override passed
    const envOverride = { ...env, [RENDER_LANE_ENV]: 'local' };
    expect(buildRenderPlan(envOverride).override).toBe('local');
  });

  it('a pinned lane narrows the eligible set to exactly one lane, and has no fallback chain', () => {
    const plan = buildRenderPlan(env, 'cloud');
    expect(eligibleLanes(plan).map((l) => l.id)).toEqual(['cloud']);
    expect(fallbackChain(plan, 'cloud').map((l) => l.id)).toEqual(['cloud']);
  });

  it('pinned disabled or unknown lanes are rejected loudly, never silently re-routed', () => {
    putLanesState(
      {
        revision: getLanesState(env).revision,
        render: [
          { id: 'laptop', enabled: true, slots: 1 },
          { id: 'cloud', enabled: false, slots: 2 },
          { id: 'local', enabled: true, slots: 1 },
        ],
        models: getDefaultConfig().models,
      },
      'test',
      env,
    );
    try {
      buildRenderPlan(env, 'cloud');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String((err as Error).message)).toContain('disabled');
    }
    // parseRenderOverride against an unconfigured lane list
    expect(() => parseRenderOverride('gpu', [])).toThrow(/unknown render lane override/);
    expect(() =>
      parseRenderOverride('nope', [{ id: 'local', enabled: true }]),
    ).toThrow(/unknown render lane override/);
  });

  it('normalizeRenderOverride canonicalizes for persistence', () => {
    expect(normalizeRenderOverride(null)).toBe('inherit');
    expect(normalizeRenderOverride('')).toBe('inherit');
    expect(normalizeRenderOverride(' LOCAL ')).toBe('local');
    expect(normalizeRenderOverride('cloud')).toBe('cloud');
    expect(() => normalizeRenderOverride('rm -rf /')).toThrow();
    expect(() => normalizeRenderOverride(5)).toThrow();
  });

  it('normalizeRenderLane accepts only the inherit|local|laptop|cloud enum', () => {
    expect(normalizeRenderLane(null)).toBe('inherit');
    expect(normalizeRenderLane('')).toBe('inherit');
    expect(normalizeRenderLane(' INHERIT ')).toBe('inherit');
    expect(normalizeRenderLane('Local')).toBe('local');
    expect(normalizeRenderLane('laptop')).toBe('laptop');
    for (const bad of ['gpu', 'rm -rf /', 'local; cloud', 5, true, ['local'], { id: 'local' }]) {
      expect(() => normalizeRenderLane(bad as never)).toThrow();
    }
  });

  it('checkRenderLaneAvailable consults configuration and policy, never a network probe', () => {
    const envNoCloud = { ...env, MANHWA_RENDER_CLOUD: '' };
    expect(checkRenderLaneAvailable('inherit', envNoCloud)).toBe('inherit');
    expect(checkRenderLaneAvailable('laptop', envNoCloud)).toBe('laptop');
    expect(checkRenderLaneAvailable('local', envNoCloud)).toBe('local');
    expect(() => checkRenderLaneAvailable('cloud', envNoCloud)).toThrow(/not configured/);
    // Sanitizer round-trips the normalized lane id.
    expect(normalizeRenderLane(' LOCAL ')).toBe('local');
  });

  it('fallbackChain walks eligible lanes in persisted order until the end', () => {
    const plan = buildRenderPlan(env);
    expect(fallbackChain(plan, 'local').map((l) => l.id)).toEqual(['local', 'cloud']);
    expect(fallbackChain(plan, 'laptop').map((l) => l.id)).toEqual(['laptop', 'local', 'cloud']);
    expect(fallbackChain(plan, 'cloud-lane-not-present')).toEqual([]);
  });

  it('override options report unavailable lanes honestly and never leak hosts', () => {
    putLanesState(
      {
        revision: getLanesState(env).revision,
        render: [
          { id: 'laptop', enabled: false, slots: 1 },
          { id: 'cloud', enabled: true, slots: 2 },
          { id: 'local', enabled: true, slots: 1 },
        ],
        models: getDefaultConfig().models,
      },
      'test',
      env,
    );
    const opts = renderOverrideOptions(env);
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    expect(Object.keys(byId).sort()).toEqual(['cloud', 'inherit', 'laptop', 'local']);
    expect(byId['inherit']!.available).toBe(true);
    expect(byId['inherit']!.unavailableReason).toBeNull();
    expect(byId['cloud']!.available).toBe(true);
    expect(byId['local']!.available).toBe(true);
    expect(byId['laptop']!.available).toBe(false);
    expect(byId['laptop']!.unavailableReason).toContain('disabled');
    const raw = JSON.stringify(opts).toLowerCase();
    for (const forbidden of ['http', 'token', 'password', '/home/', '/root/', 'lappy-host', 'render-box']) {
      expect(raw).not.toContain(forbidden);
    }
    expect(opts.every((o) => o.label.length > 0)).toBe(true);
  });

  it('offline-vs-disabled: a configured lane stays available; only policy disables the picker entry', () => {
    const opts = renderOverrideOptions(env);
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    // Runtime owns the offline case with a bounded wait: availability here is config-only.
    expect(byId['cloud']!.available).toBe(true);
    expect(byId['cloud']!.unavailableReason).toBeNull();
    expect(byId['laptop']!.available).toBe(true);
  });

  it('legacy renderLanes track env switches exactly, MANHWA_RENDER_PLAN_SNAPSHOT=0 forces legacy', () => {
    const legacyEnv = {
      MANHWA_RENDER_PLAN_SNAPSHOT: '0',
      MANHWA_LANE_CONFIG_DIR: env.MANHWA_LANE_CONFIG_DIR,
    };
    const lanesQuiet = Object.fromEntries(
      renderLanes({ ...legacyEnv, MANHWA_RENDER_REMOTE: '', MANHWA_RENDER_CLOUD: '' }).map((l) => [l.id, l]),
    );
    expect(lanesQuiet['laptop']!.enabled).toBe(false);
    expect(lanesQuiet['laptop']!.configured).toBe(false);
    expect(lanesQuiet['cloud']!.enabled).toBe(false);
    expect(lanesQuiet['local']!.enabled).toBe(true);
    const lanesLoud = Object.fromEntries(
      renderLanes({ ...legacyEnv, ...RENDER_SWITCHES }).map((l) => [l.id, l]),
    );
    expect(lanesLoud['laptop']!.enabled).toBe(true);
    expect(lanesLoud['cloud']!.enabled).toBe(true);

    // The same flag makes the whole plan legacy even with a valid persisted file.
    const envLegacy = { ...env, MANHWA_RENDER_PLAN_SNAPSHOT: '0' };
    const plan = buildRenderPlan(envLegacy);
    expect(plan.legacy).toBe(true);
    expect(plan.source).toBe('legacy');
    expect(plan.revision).toBe(0);
  });

  it('planStatus is serializable and secret-free', () => {
    putLanesState(
      {
        revision: getLanesState(env).revision,
        render: [
          { id: 'local', enabled: true, slots: 1 },
          { id: 'cloud', enabled: false, slots: 2 },
          { id: 'laptop', enabled: true, slots: 1 },
        ],
        models: getDefaultConfig().models,
      },
      'test',
      env,
    );
    resetRenderPlan();
    const raw = JSON.stringify(planStatus(buildRenderPlan(env))).toLowerCase();
    for (const forbidden of ['http', 'ssh', 'key', 'token', 'password', '/home/', '/root/']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('renderEnvSwitches reads only its own env map, never the real process env', () => {
    expect(renderEnvSwitches({ MANHWA_RENDER_REMOTE: 'x' })).toEqual({ laptop: true, cloud: false });
    expect(renderEnvSwitches({ MANHWA_RENDER_REMOTE: 'x', MANHWA_RENDER_CLOUD: 'y' })).toEqual({
      laptop: true,
      cloud: true,
    });
    expect(renderEnvSwitches({})).toEqual({ laptop: false, cloud: false });
  });
});

/* ------------------------------------------------------------------ *
 * Telemetry lifecycle
 * ------------------------------------------------------------------ */

describe('telemetry snapshot lifecycle (v1 test_status port)', () => {
  let statusDir: string;
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    statusDir = path.join(makeTemp('t14-telemetry'), 'status');
    restoreEnv?.();
    restoreEnv = stubProcessEnv({ PIPELINE_STATUS_DIR: statusDir });
    telemetry._reset();
  });

  afterEach(() => {
    // Mirror the python tearDown so module state never leaks between tests.
    telemetry._reset();
    restoreEnv?.();
    restoreEnv = null;
  });

  it('no emission until a run starts (v1 test_no_emission_until_run_starts)', () => {
    expect(telemetry.callStart({ name: 'x', model: 'y' }, 'probe', 1)).toBeNull();
    telemetry.worker('cloud-new'); // fail-open no-op without data
    expect(telemetry._data()).toBeNull();
    // no snapshot file exists before start()
    expect(fsSync.existsSync(statusDir)).toBe(false);
    expect(telemetry._path()).toBeNull();
  });

  it('run stages, calls and totals are written atomically per update', () => {
    telemetry.start('test-story', ['ch1', 'ch2'], true);
    const statusPath = telemetry._path()!;
    expect(statusPath.startsWith(statusDir)).toBe(true);
    expect(fsSync.existsSync(statusDir)).toBe(true);

    telemetry.bind({ chapter: 'ch1' });
    telemetry.bind({ worker: 'cloud-aux', role: 'vision' });
    telemetry.stage('ch1', 'reader', 'running', { completed: 2, total: 8 });
    const ident = telemetry.callStart({ name: 'test', model: 'vision-1' }, 'reader ch1', 1);
    expect(ident).toMatch(/^[0-9a-f]{12}$/);
    telemetry.callEnd(ident, 'ok', 25);
    expect(telemetry.callEnd('missing-id', 'ok')).toBeUndefined(); // unknown call id is a no-op

    const snap = JSON.parse(fsSync.readFileSync(statusPath, 'utf8'));
    expect(snap.schemaVersion).toBe(1);
    expect(snap.pid).toBe(process.pid);
    expect(snap.state).toBe('running');
    expect(snap.series).toBe('test-story');
    expect(snap.video).toBe(true);
    expect(snap.captionVersion).toBe(1);
    expect(Object.keys(snap.chapters).sort()).toEqual(['ch1', 'ch2']);
    expect(snap.chapters.ch1.worker).toBe('cloud-aux');
    expect(snap.chapters.ch1.stages.reader.state).toBe('running');
    expect(snap.totals).toEqual({ calls: 1, errors: 0, tokens: 25 });
    expect(snap.recentCalls[0].model).toBe('vision-1');
    expect(snap.recentCalls[0].state).toBe('ok');
    expect(fsSync.existsSync(statusPath + '.tmp')).toBe(false);

    // events trail records stage transitions
    expect(snap.events.some((e: { message: string }) => e.message.includes('ch1 · reader · running'))).toBe(true);
  });

  it('AsyncLocalStorage context isolation: concurrent scoped runs never cross chapters', () => {
    telemetry.start('test-story', ['ch1', 'ch2'], true);
    const lane = { name: 'test', model: 'vision-1', base: 'SECRET_URL', key_env: 'SECRET_KEY' };
    const act = (ch: string) => () => {
      telemetry.bind({ chapter: ch, worker: `cloud-${ch}`, role: 'vision' });
      telemetry.worker(`cloud-${ch}`, { kind: 'cloud' });
      telemetry.stage(ch, 'reader', 'running', { completed: 2, total: 8 });
      const ident = telemetry.callStart(lane, `reader ${ch}`, 1);
      telemetry.callEnd(ident, 'ok', 25);
    };
    telemetry.run({ chapter: 'ch1' }, act('ch1'));
    telemetry.run({ chapter: 'ch2' }, act('ch2'));

    const snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(Object.values(snap.activeCalls)).toEqual([]);
    expect(snap.chapters.ch1.worker).toBe('cloud-ch1');
    expect(snap.chapters.ch2.worker).toBe('cloud-ch2');
    expect(snap.totals).toEqual({ calls: 2, errors: 0, tokens: 50 });
    expect(JSON.stringify(snap)).not.toContain('SECRET'); // lane never carries its secret into telemetry
  });

  it('stageCurrent drives the bound chapter, pipeline failure records the stage note, finish closes the run', () => {
    telemetry.start('test-story', ['ch1']);
    telemetry.bind({ chapter: 'ch1' });
    // No bound stage yet: failure lands on 'pipeline' with the error class name.
    telemetry.failed('ch1', new RangeError('grounding violation'));
    let snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.chapters.ch1.stages.pipeline.state).toBe('failed');
    expect(snap.chapters.ch1.stages.pipeline.note).toBe('RangeError');

    telemetry.stageCurrent('render', 'running', { completed: 30, total: 100, unit: 'frames' });
    snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.chapters.ch1.stages.render.state).toBe('running');
    expect(snap.chapters.ch1.stages.render.unit).toBe('frames');
    // Without a bound chapter this must be a no-op, never a crash.
    telemetry.run({ chapter: null }, () => telemetry.stageCurrent('audit'));
    snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.chapters.ch1.stages.audit).toBeUndefined();
    expect(snap.totals.errors).toBe(0); // errors counts paid calls, not stage failures

    telemetry.finish();
    snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.state).toBe('completed');
    expect(snap.endedAt).toBeGreaterThan(0);
  });

  it('models()/provider() registration updates future dashboards without crashing when absent', () => {
    // Before any run: writes are no-ops (fail-open), nothing throws.
    expect(() => telemetry.models({ vision: [{ name: 'x', model: 'm', kind: 'openai' }] })).not.toThrow();
    expect(() => telemetry.provider('agy', { status: 'idle' })).not.toThrow();

    telemetry.start('test-story', ['ch1']);
    telemetry.models({
      vision: [{ name: 'agy', model: 'gemini-3.8-flash-low', kind: 'openai' }],
      writer: [{ name: 'workbuddy', model: 'deepseek-v4.1-flash', kind: 'openai' }],
    });
    telemetry.provider('agy', { status: 'healthy' });
    const snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.models.vision[0]).toEqual({ name: 'agy', model: 'gemini-3.8-flash-low', kind: 'openai' });
    expect(snap.providers.agy).toEqual({ status: 'healthy' });
  });

  it('call state errors bump totals.errors, and tokens only count finite numbers', () => {
    telemetry.start('test-story', ['ch1']);
    telemetry.bind({ chapter: 'ch1', role: 'writer' });
    const okId = telemetry.callStart({ name: 'test', model: 'a' }, 'writer ch1', 1)!;
    telemetry.callEnd(okId, 'ok', 11);
    const errId = telemetry.callStart({ name: 'test', model: 'b' }, 'writer ch1', 2)!;
    telemetry.callEnd(errId, 'error', Number.NaN); // non-finite tokens are recorded, never summed
    const snap = JSON.parse(fsSync.readFileSync(telemetry._path()!, 'utf8'));
    expect(snap.totals).toEqual({ calls: 2, errors: 1, tokens: 11 });
    expect(snap.recentCalls[1].tokens).toBeNull();
  });

  it('observability write failures are nonfatal (v1 test_observability_write_failure_is_nonfatal)', () => {
    telemetry.start('test-story', ['ch1'], true);
    const spy = vi.spyOn(fsSync, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    });
    try {
      telemetry.stage('ch1', 'writer');
      const ident = telemetry.callStart({ name: 'test', model: 'test' }, 'test', 1);
      telemetry.callEnd(ident, 'ok');
      telemetry.finish();
    } finally {
      spy.mockRestore();
    }
    expect(telemetry._data()!.state).toBe('completed');
  });

  it('test hooks reset everything, so tests can start clean repeatedly', () => {
    telemetry.start('start-a', ['ch1']);
    expect(telemetry._path()).not.toBeNull();
    telemetry._reset();
    expect(telemetry._path()).toBeNull();
    expect(telemetry._data()).toBeNull();
    telemetry.start('start-b', ['ch1']);
    expect(telemetry._data()!.series).toBe('start-b');
    expect(telemetry._data()!.events[0].message).toContain('Run started · start-b');
  });
});

/* ------------------------------------------------------------------ *
 * Status probe
 * ------------------------------------------------------------------ */

describe('status probe collection (v1 test_status port)', () => {
  let root: string;
  let seriesDir: string;
  let statusDir: string;
  let logPath: string;

  beforeEach(() => {
    _resetStatusCache();
    root = makeTemp('t14-probe');
    seriesDir = path.join(root, 'series');
    statusDir = path.join(root, 'status');
    logPath = path.join(root, 'pipeline.log');
    fsSync.mkdirSync(seriesDir, { recursive: true });
  });

  function selfStartTicks(): number {
    const raw = fsSync.readFileSync('/proc/self/stat', 'utf8');
    return Number(raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
  }

  function writeSnapshot(name: string, workers: unknown, chapters: unknown = {}, state = 'running', alive = true) {
    fsSync.mkdirSync(statusDir, { recursive: true });
    let pid = 999999;
    let startTicks = 1;
    if (alive) {
      startTicks = selfStartTicks();
      pid = process.pid;
    }
    const now = Date.now() / 1000;
    const snap = {
      schemaVersion: 1,
      id: `${pid}-${startTicks}`,
      pid,
      startTicks,
      startedAt: now,
      updatedAt: now,
      state,
      series: 'test-story',
      video: true,
      chapters,
      workers,
      models: {},
      providers: {},
      activeCalls: {},
      recentCalls: [],
      events: [],
      totals: {},
    };
    fsSync.writeFileSync(path.join(statusDir, name), JSON.stringify(snap));
    return snap as Record<string, any>;
  }

  const probePaths = () => ({ series: seriesDir, status: statusDir, log: logPath, root });

  function matchingSelfProcs(snap: Record<string, any>) {
    return {
      [snap.pid]: {
        pid: snap.pid,
        startTicks: snap.startTicks,
        state: 'R',
        startedAt: snap.startedAt,
        ticks: 0,
        args: [],
        name: 'vitest',
        ppid: 0,
        rss: 0,
      },
    };
  }

  it('a dead or reused pid clears active calls and interrupts stages (v1 story)', () => {
    const run = writeSnapshot('run.json', {}, { ch1: { stages: { writer: { state: 'running' } } } });
    run.activeCalls = { abc: { id: 'abc', provider: 'test', model: 'test' } };
    const procs = matchingSelfProcs(run); // capture the LIVE ticks before faking reuse
    run.startTicks = run.startTicks + 1; // pid reuse suspicion
    const observed = enrichRun(run, procs, Date.now() / 1000, probePaths());
    expect(observed.alive).toBe(false);
    expect(observed.state).toBe('interrupted');
    expect(observed.activeCalls).toEqual({});
    expect(observed.chapters.ch1.stages.writer.state).toBe('interrupted');
  });

  it('interrupted stages flip on a dead run', () => {
    const snap = writeSnapshot(
      'run.json',
      { local: {} },
      { ch1: { stages: { render: { state: 'running' } } } },
    );
    const observed = enrichRun(snap, {} as never, Date.now() / 1000, probePaths());
    expect(observed.chapters.ch1.stages.render.state).toBe('interrupted');
    expect(observed.state).toBe('interrupted');
  });

  it('a live run with a healthy pid stays alive and keeps stages untouched', () => {
    const snap = writeSnapshot(
      'run.json',
      { local: { kind: 'local' } },
      { ch1: { stages: { reader: { state: 'done' } } } },
    );
    const observed = enrichRun(snap, matchingSelfProcs(snap), Date.now() / 1000, probePaths());
    expect(observed.alive).toBe(true);
    expect(observed.state).toBe('running');
    expect(observed.chapters.ch1.stages.reader.state).toBe('done');
    expect(typeof observed.elapsed).toBe('number');
  });

  it('observeLog recovers runs and workers from a legacy stdout log', () => {
    const run: Record<string, any> = {
      pid: 123,
      startTicks: 1,
      startedAt: 1,
      series: 'story',
      chapters: { ch1: { stages: {} } },
      workers: {},
      activeCalls: {},
      events: [],
    };
    observeLog(
      run,
      '== ch1: READER\n  batch 1/2 read\n== ch1: WRITER\n   script: 8 lines | fact_check: FAIL (2)\n[video] dispatch: ch1 -> new-cloud-node\n[video] render: ch1 starting on new-cloud-node\n',
    );
    expect(Object.keys(run.workers)).toContain('new-cloud-node');
    expect(run.chapters.ch1.stages.check.state).toBe('warning');
    expect(run.activeCalls).toEqual({});
    // events capture every nonempty line with a kind
    expect(run.events.length).toBeGreaterThan(4);
    expect(run.events.some((e: { kind: string }) => e.kind === 'warning')).toBe(true);
  });

  it('observeLog stage transitions (writer done implies reader done; video failure marks stage failed)', () => {
    const run: Record<string, any> = {
      pid: 1,
      startTicks: 1,
      startedAt: 1,
      series: 'story',
      chapters: {},
      workers: {},
      activeCalls: {},
      events: [],
    };
    observeLog(run, '== ch2: READER\n== ch2: WRITER\nvideos: 1 ok\n[video] !! ch2 FAILED');
    expect(run.chapters.ch2.stages.reader.state).toBe('done');
    expect(run.chapters.ch2.stages.writer.state).toBe('running');
    expect(run.chapters.ch2.stages.render.state).toBe('failed');
  });

  it('events keep history but scrub stays bounded by character count', () => {
    const run: Record<string, any> = {
      pid: 1,
      startTicks: 1,
      startedAt: 1,
      series: 'story',
      chapters: {},
      workers: {},
      activeCalls: {},
      events: [],
    };
    observeLog(run, `Bearer ${'A'.repeat(500)}\n`);
    expect(run.events[0].message.length).toBeLessThanOrEqual(500);
    expect(run.events[0].message).not.toContain('A'.repeat(400));
  });

  it('parseCalls recovers the completed call ledger with duration, tokens and history', () => {
    const calls = parseCalls(
      '2026-10-13 00:01:02 OK   writer ch1 [workbuddy] attempt=2 10s tokens=99\n2026-10-13 00:03:00 ERR  reader ch2 [agy] attempt=1 30s boom\n',
    );
    expect(calls.length).toBe(2);
    expect(calls[0].provider).toBe('workbuddy');
    expect(calls[0].model).toBeNull(); // legacy log has no model identity
    expect(calls[0].state).toBe('ok');
    expect(calls[0].attempt).toBe(2);
    expect(calls[0].duration).toBe(10);
    expect(calls[0].tokens).toBe(99);
    expect(calls[1].state).toBe('error');
    expect(calls[1].chapter).toBe('ch2');
    expect(calls[1].tokens).toBeNull();
    expect(typeof calls[0].endedAt).toBe('number');
    // Non-timing lines are dropped
    expect(parseCalls('lorem ipsum dolor').length).toBe(0);
  });

  it('worker normalization: partial records get safe defaults, non-dicts never break collection', () => {
    writeSnapshot('run.json', { local: { lastError: 'OSError', updatedAt: 1 } });
    const workers: Array<Record<string, any>> = collectStatus({ ...probePaths(), procs: {}, now: Date.now() / 1000 }).workers;
    const local = workers.find((w) => w.id === 'local');
    expect(local?.kind).toBe('local');
    expect(local?.jobs).toEqual([]);
    expect(local?.lastError).toBe('OSError');
    expect(local?.status).toBe('idle');
  });

  it('worker records with missing kind default to discovered; non-dict containers ignored', () => {
    // Non-dict workers list: collection just normalizes the local worker.
    writeSnapshot('run.json', ['not', 'a', 'mapping']);
    const workers: Array<Record<string, any>> = collectStatus({ ...probePaths(), procs: {}, now: Date.now() / 1000 }).workers;
    expect(workers.map((w) => w.id)).toEqual(['local']);
    // String-backed record with an available flag
    writeSnapshot('run.json', { mystery: 'vector node' });
    const mystery = (collectStatus({ ...probePaths(), procs: {}, now: Date.now() / 1000 }).workers as Array<Record<string, any>>).find(
      (w) => w.id === 'mystery',
    );
    expect(mystery?.kind).toBe('discovered');
  });

  it('mergeWorker tolerates partial input and inherits id/kind coherently', () => {
    const workers: Record<string, Record<string, unknown>> = {};
    expect(mergeWorker(workers, '', { kind: 'x' } as never)).toBeNull();
    mergeWorker(workers, 'local', { kind: 'remote' } as never); // wrong kind is re-derived
    expect(workers['local']!.kind).toBe('local');
    mergeWorker(workers, 'remote-1', { available: true } as never);
    expect(workers['remote-1']!.kind).toBe('discovered');
    expect(workers['remote-1']!.available).toBe(true);
    // jobs on the record are ignored (chapter routing owns them): only a
    // preexisting current.jobs list survives the merge.
    const withJobs: Record<string, Record<string, unknown>> = { 'remote-1': { jobs: ['a'] } };
    mergeWorker(withJobs, 'remote-1', { available: true } as never);
    expect(withJobs['remote-1']!.kind).toBe('discovered');
    expect(withJobs['remote-1']!.jobs).toEqual(['a']);
  });

  it('inactive runs mark remote workers last-seen while local stays idle', () => {
    writeSnapshot(
      'run.json',
      { lappy: { kind: 'remote', available: true }, local: { status: 'busy' } },
      {},
      'completed',
      false,
    );
    const byId = Object.fromEntries(
      (collectStatus({ ...probePaths(), procs: {}, now: Date.now() / 1000 }).workers as Array<Record<string, any>>).map((w) => [w.id, w]),
    );
    expect(byId['lappy']!.kind).toBe('remote');
    expect(byId['lappy']!.status).toBe('last-seen');
    expect(byId['local']!.kind).toBe('local');
    expect(byId['local']!.status).toBe('idle');
  });

  it('an active run keeps remote/cloud kinds and availability, and routes chapter jobs to the worker lane', () => {
    const chapters = { ch1: { stages: { render: { state: 'running' } }, worker: 'lappy' } };
    writeSnapshot(
      'run.json',
      { lappy: { kind: 'remote', available: true }, 'render-box': { kind: 'cloud', available: false } },
      chapters,
    );
    // Omit procs so processes(now) reads the real /proc: this snapshot IS live.
    const byId = Object.fromEntries(
      (collectStatus({ ...probePaths(), now: Date.now() / 1000 }).workers as Array<Record<string, any>>).map((w) => [w.id, w]),
    );
    expect(byId['lappy']!.kind).toBe('remote');
    expect(byId['lappy']!.status).toBe('busy');
    expect(byId['lappy']!.jobs[0].chapter).toBe('ch1');
    expect(byId['render-box']!.kind).toBe('cloud');
    expect(byId['render-box']!.status).toBe('unavailable');
  });

  it('a malformed snapshot never hides a valid live run (v1 story)', () => {
    // Live run from the process itself
    writeSnapshot('run.json', {});
    // Malformed snapshots: unparsable JSON and a startedAt python-None run
    fsSync.writeFileSync(path.join(statusDir, 'bad.json'), '{oops');
    const valid = JSON.parse(fsSync.readFileSync(path.join(statusDir, 'run.json'), 'utf8'));
    fsSync.writeFileSync(
      path.join(statusDir, 'bad2.json'),
      JSON.stringify({ ...valid, id: 'bad', pid: 'bad', startedAt: null }),
    );
    const result = collectStatus({ ...probePaths(), now: Date.now() / 1000 });
    expect(result.runs.length).toBe(1);
    expect(result.runs[0].series).toBe('test-story');
    expect(result.runs[0].alive).toBe(true);
  });

  it('file inventory: video.mp4 with an in-flight chapter is not counted (v1 story)', () => {
    const now = Date.now() / 1000;
    const videoDir = path.join(seriesDir, 'test-story', 'out', 'ch1', 'video');
    fsSync.mkdirSync(videoDir, { recursive: true });
    fsSync.writeFileSync(path.join(videoDir, 'video.mp4'), Buffer.from('partial'));
    writeSnapshot('run.json', {}, { ch1: { stages: { render: { state: 'running' } } } });
    const result = collectStatus({ ...probePaths(), now });
    expect(result.videos).toBe(0);
    expect(result.chapters).toBe(1);
    expect(result.runs[0].completed).toBe(0);
  });

  it('render.log shows encoding progress but never implies completion (v1 story)', () => {
    const now = Date.now() / 1000;
    writeSnapshot('run.json', {}, { ch1: { stages: { render: { state: 'running' } } } });
    const videoDir = path.join(seriesDir, 'test-story', 'out', 'ch1', 'video');
    fsSync.mkdirSync(videoDir, { recursive: true });
    // Written after the snapshot so its mtime is fresh (>= startedAt) by construction;
    // utimesSync clears the same-millisecond mtime/startedAt race.
    fsSync.writeFileSync(
      path.join(videoDir, 'render.log'),
      '\x1b[2KRendered 100/100\rEncoded 60/100, time remaining 2s\n',
    );
    fsSync.utimesSync(path.join(videoDir, 'render.log'), now + 1, now + 1);
    const state = collectStatus({ ...probePaths(), now });
    const run = state.runs[0];
    expect(run.chapters.ch1.stages.render.phase).toBe('Encoding');
    expect(run.chapters.ch1.stages.render.completed).toBe(60);
    expect(run.chapters.ch1.stages.render.unit).toBe('frames');
    expect(run.chapters.ch1.complete).toBe(false);
  });

  it('battery reads percent, charge state and discharge seconds from the sysfs tree', () => {
    const makePower = (base: string, name: string, fields: Record<string, string>) => {
      const dir = path.join(base, name);
      fsSync.mkdirSync(dir, { recursive: true });
      for (const [k, v] of Object.entries(fields)) fsSync.writeFileSync(path.join(dir, k), `${v}\n`);
    };

    const power1 = path.join(root, 'power');
    makePower(power1, 'ADP1', { type: 'Mains', online: '0' });
    makePower(power1, 'BAT0', {
      type: 'Battery',
      present: '1',
      status: 'Discharging',
      capacity: '42',
      energy_now: '20000000',
      energy_full: '50000000',
      power_now: '10000000',
    });
    expect(batteryInfo(power1)).toEqual({
      percent: 42,
      status: 'Discharging',
      ac: false,
      seconds: 7200,
    });

    // charge/current fallback when capacity and energy are absent
    const power2 = path.join(root, 'power2');
    makePower(power2, 'AC', { type: 'Mains', online: '1' });
    makePower(power2, 'BAT1', {
      type: 'Battery',
      status: 'Charging',
      charge_now: '1000000',
      charge_full: '4000000',
      current_now: '2000000',
    });
    const second = batteryInfo(power2);
    expect(second?.percent).toBe(25);
    expect(second?.ac).toBe(true);
    expect(second?.status).toBe('Charging');
    expect(second?.seconds).toBe(5400);
  });

  it('no battery tree (or skipped packs) yields null', () => {
    expect(batteryInfo(path.join(root, 'missing'))).toBeNull();
    const power2 = path.join(root, 'power2');
    const makePower = (name: string, fields: Record<string, string>) => {
      const dir = path.join(power2, name);
      fsSync.mkdirSync(dir, { recursive: true });
      for (const [k, v] of Object.entries(fields)) fsSync.writeFileSync(path.join(dir, k), `${v}\n`);
    };
    makePower('ADP1', { type: 'Mains', online: '1' });
    makePower('BAT0', { type: 'Battery', present: '0', capacity: '10', status: 'Discharging' });
    expect(batteryInfo(power2)).toBeNull();
  });

  it('cloud lane shows a stopped sandbox without waking it, and caches the listing for 30s', () => {
    const box = {
      name: 'manhwa-render-arm',
      id: 'sbx_test',
      status: 'stopped',
      cpus: 8,
      memory_mib: 16384,
    };
    const listSandbox = vi.fn(() => [box, null] as [unknown, null]);
    const paths = probePaths();
    const restore = stubProcessEnv({ MANHWA_RENDER_CLOUD: 'manhwa-render-arm' });
    try {
      const lane = cloudLane(1000, { ...paths, status: statusDir }, listSandbox as never);
      expect(lane).not.toBeNull();
      expect(lane!.id).toBe('manhwa-render-arm');
      expect(lane!.kind).toBe('cloud');
      expect(lane!.status).toBe('paused');
      expect(lane!.available).toBe(true);
      expect(lane!.reason).toBe('Stopped · warm, not billed');
      expect(lane!.metrics).toEqual({ cpus: 8, mem_gb: 16, disk_gb: null, load: null });
      expect(lane!.boxStatus).toBe('stopped');
      expect(listSandbox).toHaveBeenCalledTimes(1);

      // Cached listing: no second probe within the 30 s window.
      const again = cloudLane(1010, { ...paths, status: statusDir }, listSandbox as never);
      expect(again!.status).toBe('paused');
      expect(listSandbox).toHaveBeenCalledTimes(1);
      // After the window, another probe fires
      cloudLane(2000, { ...paths, status: statusDir }, listSandbox as never);
      expect(listSandbox).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('cloud lane keeps the last sandbox when the probe just failed (never wakes it)', () => {
    const cachePath = path.join(path.dirname(statusDir), 'cloud-list.json');
    fsSync.writeFileSync(
      cachePath,
      JSON.stringify({
        at: 10,
        name: 'manhwa-render-arm',
        box: { name: 'manhwa-render-arm', status: 'stopped', cpus: 8, memory_mib: 16384 },
      }),
    );
    const listSandbox = vi.fn(() => [null, 'not signed in'] as [null, string]);
    const paths = probePaths();
    const lane = cloudLane(1000, paths, listSandbox as never);
    const again = cloudLane(1010, paths, listSandbox as never);
    expect(listSandbox).toHaveBeenCalledWith('manhwa-render-arm');
    expect(lane?.status).toBe('paused');
    expect(lane?.reason).toBe('Stopped · warm, not billed');
    expect(again?.status).toBe('paused');
    expect(listSandbox).toHaveBeenCalledTimes(1); // cache still fresh
    const raw = fsSync.readFileSync(cachePath, 'utf8');
    expect(raw).toContain('manhwa-render-arm'); // refreshed cache kept the stale box
  });

  it('collectStatus lifecycle: snapshot + workers + inventory + cloud, secrets never surface', () => {
    const now = Date.now() / 1000;
    fsSync.mkdirSync(path.join(seriesDir, 'test-story', 'out', 'ch1', 'video'), { recursive: true });
    writeSnapshot(
      'run.json',
      { 'render-box': { kind: 'cloud', available: true } },
      { ch1: { stages: { reader: { state: 'done' } } } },
    );
    const box = { name: 'render-box', id: 'sbx_x', status: 'running', cpus: 8, memory_mib: 16384 };
    const listSandbox = vi.fn(() => [box, null] as [unknown, null]);
    const restoreCloud = stubProcessEnv({ MANHWA_RENDER_CLOUD: 'render-box' });
    let state: Record<string, any>;
    try {
      state = collectStatus({
        ...probePaths(),
        now,
        listSandbox: listSandbox as never,
      });
    } finally {
      restoreCloud();
    }
    expect(state.schemaVersion).toBe(2);
    expect(state.state).toBe('RUNNING');
    expect(state.running).toBe(true);
    expect(state.series).toBe('test-story');
    expect(state.chapters).toBe(1);
    expect(state.videos).toBe(0); // chapter in flight
    expect(state.stageOrder).toEqual(['reader', 'writer', 'check', 'audio', 'clean', 'timeline', 'render']);
    expect((state.workers as Array<Record<string, any>>).map((w) => w.id)).toContain('local');
    expect((state.workers as Array<Record<string, any>>).map((w) => w.id)).toContain('render-box');
    expect(state.cloud?.id).toBe('render-box');
    expect(listSandbox).toHaveBeenCalledTimes(1);
    const raw = JSON.stringify(state);
    for (const forbidden of ['Bearer', 'api_key', 'password']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('sampleRates derives cpu/idle percent deltas only from a prior snapshot', () => {
    const next: Record<string, any> = {
      at: 0,
      system: {
        cpuTicks: { total: 2000, idle: 900 },
        clockTicks: 100,
        interfaces: [{ name: 'eth0', rx: 300, tx: 100 }],
        processes: [{ pid: 1, startTicks: 5, ticks: 120 }],
      },
    };
    const base: Record<string, any> = {
      at: 0,
      system: {
        cpuTicks: { total: 1000, idle: 400 },
        clockTicks: 100,
        interfaces: [{ name: 'eth0', rx: 100, tx: 100 }],
        processes: [{ pid: 1, startTicks: 5, ticks: 20 }],
      },
    };
    // pin both timestamps so second === 1.0 exactly
    const baseAt = Date.now() - 1000;
    base.at = baseAt;
    next.at = baseAt + 1000;
    sampleRates(next as never, base as never);
    expect(next.system.cpuPercent).toBe(50); // (1600-500)/2000 busy => 50%
    expect(next.system.interfaces[0].rxPerSecond).toBe(200);
    expect(next.system.processes[0].cpuPercent).toBe(100); // 1 s of cpu in 1 s
    // No prior: no derived values, no crash
    const first = structuredClone(next) as typeof next;
    first.system.cpuPercent = 444;
    sampleRates(first as never, null);
    expect(first.system.cpuPercent).toBeNull();
    expect(first.system.interfaces[0].rxPerSecond).toBeNull();
    expect(first.system.processes[0].cpuPercent).toBeNull();
  });
});
