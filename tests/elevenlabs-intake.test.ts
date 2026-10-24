/**
 * ElevenLabs (direct API, key pool) intake wiring: catalog, selection, job create
 * voice check, series settings, and voice preview. The pool module is mocked;
 * no network call is made.
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({
  hasKeys: false,
  check: null as null | Record<string, unknown> | Error,
  synth: vi.fn(),
}));

vi.mock('../src/llm/elevenlabsTts.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/llm/elevenlabsTts.js')>();
  return {
    ...orig,
    hasElevenLabsKeys: () => pool.hasKeys,
    checkElevenLabsVoice: async (voiceId: string) => {
      if (pool.check instanceof Error) throw pool.check;
      return {
        voiceId, found: true, library: false, needsPaidKey: false, paidKeyAvailable: false,
        ...(pool.check ?? {}),
      };
    },
    synthesizeElevenLabsToFile: pool.synth,
  };
});

const { createJob, enqueueJob, getCatalog, loadRawTtsProviders, resolveTtsSelection, ttsProviderIdFromMeta } =
  await import('../src/intake/intake.js');
const { getSeriesSettings, patchSeriesSettings } = await import('../src/player/seriesSettings.js');
const { generatePreview } = await import('../src/intake/voicePreview.js');
const {
  ELEVENLABS_DEFAULT_MODEL, ELEVENLABS_DEFAULT_VOICE, ELEVENLABS_MODELS, ElevenLabsKeyError, ElevenLabsRequestError,
} = await import('../src/llm/elevenlabsTts.js');

const tmpRoots: string[] = [];
function makeTemp(prefix: string): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `el-intake-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) fsSync.rmSync(d, { recursive: true, force: true });
});

function makeEnv(tmp: string, catalog?: unknown): Record<string, string> {
  const cat = path.join(tmp, 'catalog.json');
  fsSync.writeFileSync(cat, JSON.stringify(catalog ?? { providers: [] }));
  return {
    MANHWA_JOBS_DIR: path.join(tmp, 'jobs'),
    MANHWA_SERIES_ROOT: path.join(tmp, 'series'),
    MANHWA_OUT_DIR: path.join(tmp, 'out'),
    MANHWA_TTS_CATALOG: cat,
    MANHWA_NO_AUTO_WORKER: '1',
    PATH: process.env.PATH ?? '',
  };
}

const CUSTOM_VOICE = 'J2FGlQG8Gd7x8uEDt2H8';
let slugCounter = 0;
function gdriveJob(env: Record<string, string>, extra: Record<string, unknown> = {}) {
  slugCounter += 1;
  return enqueueJob({
    title: `El Fan ${slugCounter}`,
    slug: `el-fan-${slugCounter}`,
    gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
    provider: 'elevenlabs',
    env: env as never,
    spawnWorker: false,
    ...extra,
  });
}

function savedJob(env: Record<string, string>, id: string): Record<string, any> {
  return JSON.parse(fsSync.readFileSync(path.join(env.MANHWA_JOBS_DIR!, `${id}.json`), 'utf8'));
}

beforeEach(() => {
  pool.hasKeys = false;
  pool.check = null;
  pool.synth.mockReset();
});

describe('elevenlabs: catalog', () => {
  it('always lists the built-in provider, unavailable without keys', async () => {
    const env = makeEnv(makeTemp('cat'));
    const raw = loadRawTtsProviders(env);
    expect(raw.map((p) => p.id)).toContain('elevenlabs');
    const cat = await getCatalog(undefined, env);
    const el = cat.providers.find((p) => p.id === 'elevenlabs')!;
    expect(el).toMatchObject({
      label: 'ElevenLabs',
      engine: 'elevenlabs',
      defaultVoice: ELEVENLABS_DEFAULT_VOICE,
      available: false,
      unavailableReason: 'No ElevenLabs API keys. Add one in Studio > Voice.',
      allowCustomVoice: true,
      defaultModel: ELEVENLABS_DEFAULT_MODEL,
    });
    expect(el.models).toEqual(ELEVENLABS_MODELS);
    expect(String(el.costNotice)).toMatch(/10,000 characters/);
    expect((el.voices as Array<{ id: string }>).length).toBeGreaterThanOrEqual(6);
    // Only the elevenlabs entry carries the extra fields.
    expect(cat.providers.find((p) => p.id === 'edge')).not.toHaveProperty('allowCustomVoice');
  });

  it('is available when the pool has a key', async () => {
    pool.hasKeys = true;
    const cat = await getCatalog(undefined, makeEnv(makeTemp('cat-on')));
    const el = cat.providers.find((p) => p.id === 'elevenlabs')!;
    expect(el.available).toBe(true);
    expect(el.unavailableReason).toBeNull();
  });

  it('an external catalog entry with id elevenlabs cannot shadow the built-in', () => {
    const env = makeEnv(makeTemp('shadow'), {
      providers: [{ id: 'elevenlabs', engine: 'external', command: '/bin/true', voices: [{ id: 'x' }] }],
    });
    const hits = loadRawTtsProviders(env).filter((p) => p.id === 'elevenlabs');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.engine).toBe('elevenlabs');
  });
});

describe('elevenlabs: resolveTtsSelection', () => {
  it('defaults to George and builds the v1 meta block', async () => {
    pool.hasKeys = true;
    const sel = await resolveTtsSelection('elevenlabs', undefined, undefined, makeEnv(makeTemp('sel')));
    expect(sel.voiceId).toBe(ELEVENLABS_DEFAULT_VOICE);
    expect(sel.voiceLabel).toMatch(/George/);
    expect(sel.metaTts).toEqual({
      engine: 'elevenlabs', provider: 'elevenlabs', revision: 'v1',
      voice_id: ELEVENLABS_DEFAULT_VOICE, language: 'en', speed: 1,
    });
  });

  it('accepts a custom voice id exactly (case-sensitive), label = id', async () => {
    const env = makeEnv(makeTemp('sel-custom'));
    const sel = await resolveTtsSelection('elevenlabs', CUSTOM_VOICE, undefined, env, false);
    expect(sel.voiceId).toBe(CUSTOM_VOICE);
    expect(sel.voiceLabel).toBe(CUSTOM_VOICE);
    // A premade id in another case is a different (custom) id, not the premade voice.
    const lower = await resolveTtsSelection('elevenlabs', ELEVENLABS_DEFAULT_VOICE.toLowerCase(), undefined, env, false);
    expect(lower.voiceId).toBe(ELEVENLABS_DEFAULT_VOICE.toLowerCase());
    expect(lower.voiceLabel).toBe(ELEVENLABS_DEFAULT_VOICE.toLowerCase());
  });

  it('rejects malformed voice ids and fails preflight without keys', async () => {
    const env = makeEnv(makeTemp('sel-bad'));
    await expect(resolveTtsSelection('elevenlabs', 'bad id!', undefined, env, false))
      .rejects.toThrowError(/Invalid ElevenLabs voice id/);
    await expect(resolveTtsSelection('elevenlabs', 'short', undefined, env, false))
      .rejects.toThrowError(/Invalid ElevenLabs voice id/);
    await expect(resolveTtsSelection('elevenlabs', undefined, undefined, env))
      .rejects.toThrowError(/No ElevenLabs API keys/);
  });

  it('legacy eleven and gsk stay rejected', async () => {
    const env = makeEnv(makeTemp('sel-legacy'));
    await expect(resolveTtsSelection('eleven', 'sam', undefined, env)).rejects.toThrowError(/not available/);
    await expect(resolveTtsSelection('gsk', 'sam', undefined, env)).rejects.toThrowError(/not available/);
  });

  it('ttsProviderIdFromMeta maps an elevenlabs meta back to elevenlabs', () => {
    const env = makeEnv(makeTemp('meta'));
    expect(ttsProviderIdFromMeta({ engine: 'elevenlabs', provider: 'elevenlabs', voice_id: CUSTOM_VOICE }, env))
      .toBe('elevenlabs');
    expect(ttsProviderIdFromMeta({ engine: 'elevenlabs' }, env)).toBe('elevenlabs');
  });
});

describe('elevenlabs: enqueueJob', () => {
  it('persists model_id and the custom voice in meta.tts', async () => {
    pool.hasKeys = true;
    const env = makeEnv(makeTemp('job'));
    const view = await gdriveJob(env, { voice: CUSTOM_VOICE, tts: { model_id: 'eleven_v4_turbo', speed: 1.1 } });
    const job = savedJob(env, String(view.id));
    expect(job.tts.providerId).toBe('elevenlabs');
    expect(job.tts.voiceId).toBe(CUSTOM_VOICE);
    expect(job.tts.metaTts).toMatchObject({
      engine: 'elevenlabs', provider: 'elevenlabs', revision: 'v1',
      voice_id: CUSTOM_VOICE, model_id: 'eleven_v4_turbo', speed: 1.1,
    });
  });

  it('a tts.voice_id override is validated and becomes the job voice', async () => {
    pool.hasKeys = true;
    const env = makeEnv(makeTemp('job-override'));
    const view = await gdriveJob(env, { tts: { voice_id: 'nPczCjzI2devNBz1zQrb' } });
    const job = savedJob(env, String(view.id));
    expect(job.tts.voiceId).toBe('nPczCjzI2devNBz1zQrb');
    expect(job.tts.voiceLabel).toMatch(/Brian/);
    await expect(gdriveJob(env, { tts: { voice_id: 'not a voice' } }))
      .rejects.toThrowError(/Invalid ElevenLabs voice id/);
  });

  it('rejects an invalid model_id through the tts style schema', async () => {
    pool.hasKeys = true;
    await expect(gdriveJob(makeEnv(makeTemp('job-model')), { tts: { model_id: 'Bad-Model' } }))
      .rejects.toThrowError(/model_id/);
  });

  it('rejects a voice that does not exist', async () => {
    pool.hasKeys = true;
    pool.check = { found: false, library: false };
    await expect(gdriveJob(makeEnv(makeTemp('job-404')), { voice: CUSTOM_VOICE }))
      .rejects.toThrowError(/was not found/);
  });

  it('rejects a library voice when only free-tier keys exist', async () => {
    pool.hasKeys = true;
    pool.check = { found: false, library: true, needsPaidKey: true, paidKeyAvailable: false, name: 'The Pharaoh' };
    await expect(gdriveJob(makeEnv(makeTemp('job-lib')), { voice: CUSTOM_VOICE }))
      .rejects.toThrowError(/free-tier keys cannot use Voice Library voices over the API; add a paid-tier key or pick a premade voice/);
  });

  it('passes a library voice when a paid key is available', async () => {
    pool.hasKeys = true;
    pool.check = { found: true, library: true, needsPaidKey: true, paidKeyAvailable: true };
    const view = await gdriveJob(makeEnv(makeTemp('job-paid')), { voice: CUSTOM_VOICE });
    expect(view.status).toBe('queued');
  });

  it('a network failure in the voice check only warns', async () => {
    pool.hasKeys = true;
    pool.check = new Error('fetch failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const view = await gdriveJob(makeEnv(makeTemp('job-net')), { voice: CUSTOM_VOICE });
      expect(view.status).toBe('queued');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/voice check .* skipped/));
    } finally {
      warn.mockRestore();
    }
  });

  it('fails preflight at job create without keys', async () => {
    await expect(gdriveJob(makeEnv(makeTemp('job-nokey'))))
      .rejects.toThrowError(/No ElevenLabs API keys/);
  });

  it('rejects the job when no key is usable (not_found key error)', async () => {
    pool.hasKeys = true;
    pool.check = new ElevenLabsKeyError('no usable key', 'not_found');
    await expect(gdriveJob(makeEnv(makeTemp('job-nousable')), { voice: CUSTOM_VOICE }))
      .rejects.toThrowError(
        'No usable ElevenLabs key: every key in Studio > Voice is invalid or disabled. Add a working key, then try again.',
      );
  });

  it('an inconclusive lookup (request error) only warns', async () => {
    pool.hasKeys = true;
    pool.check = new ElevenLabsRequestError('ElevenLabs HTTP 503 unavailable: down', 503, 'unavailable', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const view = await gdriveJob(makeEnv(makeTemp('job-503')), { voice: CUSTOM_VOICE });
      expect(view.status).toBe('queued');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/voice check .* skipped/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('elevenlabs: createJob (extension)', () => {
  function extensionEnv(name: string, tts: Record<string, unknown>) {
    const env = makeEnv(makeTemp(name));
    const sdir = path.join(env.MANHWA_SERIES_ROOT!, 'el-ext');
    fsSync.mkdirSync(path.join(sdir, 'ch1'), { recursive: true });
    fsSync.writeFileSync(path.join(sdir, 'meta.json'), JSON.stringify({ title: 'Ext', tts }));
    return env;
  }
  const persisted = { engine: 'elevenlabs', provider: 'elevenlabs', revision: 'v1', voice_id: CUSTOM_VOICE, speed: 1 };

  it('rejects a library voice when only free-tier keys exist', async () => {
    pool.hasKeys = true;
    pool.check = { found: false, library: true, needsPaidKey: true, paidKeyAvailable: false };
    const env = extensionEnv('ext-lib', persisted);
    await expect(createJob({ slug: 'el-ext', chapters: '1', env: env as never, spawnWorker: false }))
      .rejects.toThrowError(/free-tier keys cannot use Voice Library voices/);
    expect(fsSync.existsSync(env.MANHWA_JOBS_DIR!)
      ? fsSync.readdirSync(env.MANHWA_JOBS_DIR!).filter((n) => n.endsWith('.json'))
      : []).toEqual([]);
  });

  it('rejects a malformed persisted voice id and queues a usable one', async () => {
    pool.hasKeys = true;
    const bad = extensionEnv('ext-bad', { ...persisted, voice_id: 'not a voice' });
    await expect(createJob({ slug: 'el-ext', chapters: '1', env: bad as never, spawnWorker: false }))
      .rejects.toThrowError(/Invalid ElevenLabs voice id/);
    const ok = extensionEnv('ext-ok', persisted);
    const view = await createJob({ slug: 'el-ext', chapters: '1', env: ok as never, spawnWorker: false });
    expect(view.status).toBe('queued');
  });
});

describe('elevenlabs: series settings', () => {
  function seriesDir(tts: Record<string, unknown> | null): string {
    const dir = makeTemp('series');
    fsSync.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(tts ? { title: 'S', tts } : { title: 'S' }));
    return dir;
  }

  it('GET exposes a read-only ttsEngine', () => {
    expect(getSeriesSettings(seriesDir({ engine: 'elevenlabs', voice_id: CUSTOM_VOICE })).ttsEngine).toBe('elevenlabs');
    expect(getSeriesSettings(seriesDir(null)).ttsEngine).toBeNull();
    expect(() => patchSeriesSettings(seriesDir(null), { ttsEngine: 'edge' })).toThrowError(/ttsEngine|Unrecognized/i);
  });

  it('PATCH validates voice_id for elevenlabs series and accepts model_id', () => {
    const dir = seriesDir({ engine: 'elevenlabs', provider: 'elevenlabs', voice_id: ELEVENLABS_DEFAULT_VOICE });
    expect(() => patchSeriesSettings(dir, { tts: { voice_id: 'not a voice' } }))
      .toThrowError(/invalid ElevenLabs voice id/);
    const out = patchSeriesSettings(dir, { tts: { voice_id: CUSTOM_VOICE, model_id: 'eleven_v3' } });
    expect(out.tts).toMatchObject({ engine: 'elevenlabs', voice_id: CUSTOM_VOICE, model_id: 'eleven_v3' });
    expect(() => patchSeriesSettings(dir, { tts: { model_id: 'NOPE!' } })).toThrowError(/model_id/);
    const reset = patchSeriesSettings(dir, { tts: { model_id: null } });
    expect(reset.tts).not.toHaveProperty('model_id');
  });

  it('PATCH keeps free-form voice ids for other engines', () => {
    const dir = seriesDir({ engine: 'external', voice_id: 'rex' });
    expect(patchSeriesSettings(dir, { tts: { voice_id: 'eve' } }).tts.voice_id).toBe('eve');
  });
});

describe('elevenlabs: voice preview', () => {
  it('synthesizes through the pool with the requested model; cache key includes the model', async () => {
    pool.hasKeys = true;
    const env = makeEnv(makeTemp('preview'));
    // Writes a non-audio file: installAudio rejects it, which proves the call shape without ffprobe audio.
    pool.synth.mockImplementation(async (opts: { destPath: string }) => {
      fsSync.writeFileSync(opts.destPath, 'not audio');
      return { keyId: 'k1' };
    });
    await expect(generatePreview('elevenlabs', CUSTOM_VOICE, env, { model: 'eleven_flash_v2_5' }))
      .rejects.toThrowError(/invalid audio/);
    expect(pool.synth).toHaveBeenCalledTimes(1);
    expect(pool.synth.mock.calls[0]![0]).toMatchObject({
      voiceId: CUSTOM_VOICE, modelId: 'eleven_flash_v2_5',
    });
    // Second uncached request hits the cooldown, so preview spend stays bounded.
    await expect(generatePreview('elevenlabs', CUSTOM_VOICE, env)).rejects.toThrowError(/cooling down/);
  });

  it('never waits on an exhausted pool and scrubs secrets from the error', async () => {
    pool.hasKeys = true;
    const env = makeEnv(makeTemp('preview-fast'));
    pool.synth.mockRejectedValue(
      new Error('ElevenLabs key pool exhausted: Authorization: Bearer abcdefSECRETtoken123 rejected'),
    );
    const err = await generatePreview('elevenlabs', CUSTOM_VOICE, env).catch((e) => e);
    expect(String(err.message)).toMatch(/Voice preview generation failed: ElevenLabs key pool exhausted/);
    expect(String(err.message)).not.toContain('abcdefSECRETtoken123');
    expect(String(err.message)).toContain('[REDACTED]');
    expect(pool.synth.mock.calls[0]![0].env).toMatchObject({ MANHWA_ELEVENLABS_POOL_WAIT_S: '0' });
  });

  it('defaults to the default model and rejects a bad model id', async () => {
    pool.hasKeys = true;
    const env = makeEnv(makeTemp('preview-def'));
    pool.synth.mockImplementation(async (opts: { destPath: string }) => {
      fsSync.writeFileSync(opts.destPath, 'x');
      return { keyId: 'k1' };
    });
    await expect(generatePreview('elevenlabs', ELEVENLABS_DEFAULT_VOICE, env)).rejects.toThrow();
    expect(pool.synth.mock.calls[0]![0]).toMatchObject({ modelId: ELEVENLABS_DEFAULT_MODEL });
    await expect(generatePreview('elevenlabs', ELEVENLABS_DEFAULT_VOICE, env, { model: 'Bad Model' }))
      .rejects.toThrowError(/Invalid ElevenLabs model id/);
  });
});
