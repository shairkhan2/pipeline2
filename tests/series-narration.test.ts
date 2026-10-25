/**
 * Series settings narration switch: GET shape, PATCH narration rewrites
 * meta.tts, validation, live-run / busy-lock guards, and job sync. The intake
 * catalog and the lock module are mocked; every write goes to a temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VOICE_11 = 'JBFqnCBsd6RMkjVDRZzb';

const h = vi.hoisted(() => ({
  active: false,
  lockBusy: false,
  voiceUsable: true,
  sync: vi.fn((_slug: string, _change: unknown, _env?: unknown) => 1),
}));

vi.mock('../src/intake/intake.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/intake/intake.js')>();
  const catalog: Record<string, { engine: string; voices: string[] }> = {
    edge: { engine: 'edge', voices: ['en-US-AndrewNeural'] },
    'vertex-tts': { engine: 'vertex', voices: ['Charon', 'Kore'] },
    elevenlabs: { engine: 'elevenlabs', voices: [VOICE_11] },
  };
  return {
    ...orig,
    syncSeriesJobsAfterSettings: h.sync,
    ttsProviderIdFromMeta: (tts: Record<string, unknown>) => {
      const engine = String(tts.engine || '');
      return Object.entries(catalog).find(([, p]) => p.engine === engine)?.[0] ?? null;
    },
    assertElevenLabsVoiceUsable: async (voiceId: string) => {
      if (!h.voiceUsable) throw new orig.IntakeError(`ElevenLabs voice '${voiceId}' was not found.`);
    },
    resolveTtsSelection: async (providerId?: string | null, voiceId?: string | null) => {
      const prov = catalog[String(providerId)];
      if (!prov) throw new orig.IntakeError(`Unknown TTS provider '${providerId}'`);
      const voice = String(voiceId || '');
      const ok = prov.voices.includes(voice) || (prov.engine === 'elevenlabs' && /^[A-Za-z0-9]{16,40}$/.test(voice));
      if (!ok) throw new orig.IntakeError(`Voice '${voice}' is not in server catalog for provider '${providerId}'`);
      const metaTts: Record<string, unknown> = prov.engine === 'edge'
        ? { engine: 'edge' }
        : prov.engine === 'vertex'
          ? { engine: 'vertex', provider: 'vertex-ai', revision: '1', voice_id: voice, language: 'en', speed: 1 }
          : { engine: 'elevenlabs', provider: 'elevenlabs', revision: 'v1', voice_id: voice, language: 'en', speed: 1 };
      return { providerId, providerLabel: providerId, engine: prov.engine, voiceId: voice, voiceLabel: voice, costNotice: null, metaTts };
    },
  };
});

vi.mock('../src/locks/seriesLock.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/locks/seriesLock.js')>();
  return {
    ...orig,
    checkNoActivePipelineRun: (_procRoot: string, slug: string) => h.active
      ? { ok: false, status: 409, code: 'pipeline_active', error: `The pipeline is writing ${slug} right now (PID 1).` }
      : { ok: true },
    withExclusiveSeriesLock: (...args: unknown[]) => {
      if (h.lockBusy) throw new orig.BlockingIOError('Series lock is busy');
      const fn = args.find((a) => typeof a === 'function') as (p: string) => unknown;
      return fn('/dev/null');
    },
  };
});

const { getSeriesSettings, patchSeriesSettings, updateSeriesSettings } = await import('../src/player/seriesSettings.js');

const roots: string[] = [];
let seriesRoot: string;
const savedOut = process.env.MANHWA_OUT_DIR;

function series(tts: Record<string, unknown> | null, extra: Record<string, unknown> = {}): string {
  const dir = path.join(seriesRoot, `s${roots.length}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'S', ...(tts ? { tts } : {}), ...extra }));
  return dir;
}
const readMeta = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

async function status(p: Promise<unknown>): Promise<number | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? -1;
  }
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'series-narration-'));
  roots.push(root);
  process.env.MANHWA_OUT_DIR = path.join(root, 'out');
  seriesRoot = path.join(root, 'series');
  fs.mkdirSync(seriesRoot);
  h.active = false;
  h.lockBusy = false;
  h.voiceUsable = true;
  h.sync.mockClear();
});
afterEach(() => {
  if (savedOut === undefined) delete process.env.MANHWA_OUT_DIR;
  else process.env.MANHWA_OUT_DIR = savedOut;
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const vertexTts = {
  engine: 'vertex', provider: 'vertex-ai', revision: '1', voice_id: 'Charon', language: 'en', speed: 1.15, style: 'calm narrator',
};

describe('series settings: narration', () => {
  it('rejects legacy voice and model overrides alongside a narration switch', async () => {
    const dir = series(vertexTts);
    for (const tts of [{ voice_id: 'stale-voice' }, { model_id: 'stale_model' }]) {
      expect(await status(updateSeriesSettings(dir, {
        narration: { provider: 'edge', voice: 'en-US-AndrewNeural' }, tts,
      }))).toBe(400);
      expect(readMeta(dir).tts).toEqual(vertexTts);
    }
  });
  it('GET adds narration and narrationLocked', () => {
    const dir = series({ engine: 'elevenlabs', provider: 'elevenlabs', voice_id: VOICE_11, model_id: 'eleven_v3' });
    const out = getSeriesSettings(dir);
    expect(out.narration).toEqual({ provider: 'elevenlabs', voice: VOICE_11, model: 'eleven_v3' });
    expect(out.narrationLocked).toBeNull();
    expect(getSeriesSettings(series(null)).narration).toEqual({ provider: null, voice: null, model: null });
    h.active = true;
    expect(getSeriesSettings(dir).narrationLocked).toBe('Pause the run first, then change narration.');
  });

  it('vertex -> elevenlabs rewrites meta.tts, keeps speed and style, no stale keys', async () => {
    const dir = series({ ...vertexTts, command: ['old'], settings: { x: 1 } });
    const out = await updateSeriesSettings(dir, { narration: { provider: 'elevenlabs', voice: VOICE_11, model: 'eleven_v3' } });
    expect(readMeta(dir).tts).toEqual({
      engine: 'elevenlabs', provider: 'elevenlabs', revision: 'v1', voice_id: VOICE_11, language: 'en',
      speed: 1.15, style: 'calm narrator', model_id: 'eleven_v3',
    });
    expect(out.narration).toEqual({ provider: 'elevenlabs', voice: VOICE_11, model: 'eleven_v3' });
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync.mock.calls[0]![0]).toBe(path.basename(dir));
    expect(h.sync.mock.calls[0]![1]).toEqual({ tts: readMeta(dir).tts });
  });

  it('elevenlabs -> edge drops model_id and voice; vertex keeps no elevenlabs model', async () => {
    const dir = series({ engine: 'elevenlabs', provider: 'elevenlabs', voice_id: VOICE_11, model_id: 'eleven_v3', speed: 0.9 });
    await updateSeriesSettings(dir, { narration: { provider: 'edge', voice: 'en-US-AndrewNeural' } });
    expect(readMeta(dir).tts).toEqual({ engine: 'edge', speed: 0.9 });
    await updateSeriesSettings(dir, { narration: { provider: 'vertex-tts', voice: 'Kore', model: 'eleven_v3' } });
    expect(readMeta(dir).tts).not.toHaveProperty('model_id');
    expect(readMeta(dir).tts).toMatchObject({ engine: 'vertex', voice_id: 'Kore', speed: 0.9 });
  });

  it('invalid provider, voice or model gives 400 and leaves meta.json alone', async () => {
    const dir = series(vertexTts);
    const before = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'nope', voice: 'Charon' } }))).toBe(400);
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'vertex-tts', voice: 'Nobody' } }))).toBe(400);
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'elevenlabs', voice: 'bad voice!' } }))).toBe(400);
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'elevenlabs', voice: VOICE_11, model: 'NOPE!' } }))).toBe(400);
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'elevenlabs', voice: VOICE_11, extra: 1 } }))).toBe(400);
    h.voiceUsable = false;
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'elevenlabs', voice: VOICE_11 } }))).toBe(400);
    expect(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).toBe(before);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('a live run gives 409; a busy exclusive lock gives 409', async () => {
    const dir = series(vertexTts);
    h.active = true;
    await expect(updateSeriesSettings(dir, { narration: { provider: 'edge', voice: 'en-US-AndrewNeural' } }))
      .rejects.toMatchObject({ statusCode: 409, message: 'Pause the run first, then change narration.' });
    h.active = false;
    h.lockBusy = true;
    expect(await status(updateSeriesSettings(dir, { narration: { provider: 'edge', voice: 'en-US-AndrewNeural' } }))).toBe(409);
    expect(readMeta(dir).tts).toEqual(vertexTts);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('tts-only edits still work during a run and sync tts; visuals sync visuals; style syncs nothing', async () => {
    const dir = series(vertexTts, { visuals: { background: 'starfield' } });
    h.active = true;
    const out = await updateSeriesSettings(dir, { tts: { voice_id: 'Kore', speed: 1.3, style: null } });
    expect(out.tts).toMatchObject({ engine: 'vertex', voice_id: 'Kore', speed: 1.3 });
    expect(out.tts).not.toHaveProperty('style');
    expect(h.sync).toHaveBeenLastCalledWith(path.basename(dir), { tts: readMeta(dir).tts }, expect.anything());
    patchSeriesSettings(dir, { visuals: { motion: 'cut' } });
    expect(h.sync).toHaveBeenLastCalledWith(path.basename(dir), { visuals: readMeta(dir).visuals }, expect.anything());
    h.sync.mockClear();
    patchSeriesSettings(dir, { style: {} });
    expect(h.sync).not.toHaveBeenCalled();
    expect(() => patchSeriesSettings(dir, { ttsEngine: 'edge' })).toThrowError(/ttsEngine|Unrecognized/i);
  });

  it('narration plus visuals in one PATCH syncs both', async () => {
    const dir = series(vertexTts);
    await updateSeriesSettings(dir, { narration: { provider: 'edge', voice: 'en-US-AndrewNeural' }, visuals: { motion: 'cut' } });
    const meta = readMeta(dir);
    expect(meta.visuals).toEqual({ motion: 'cut' });
    expect(h.sync).toHaveBeenCalledWith(path.basename(dir), { tts: meta.tts, visuals: meta.visuals }, expect.anything());
  });
});
