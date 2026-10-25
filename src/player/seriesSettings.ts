import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { seriesStyleSchema, ttsStyleSchema, STYLE_CATALOG, resolveSeriesStyle, validationMessage } from '../config/seriesStyle.js';
import { BACKGROUNDS, MOTIONS, cardAnimationSchema } from '../intake/ingest.js';
import {
  assertElevenLabsVoiceUsable,
  atomicWriteJson,
  resolveTtsSelection,
  syncSeriesJobsAfterSettings,
  ttsProviderIdFromMeta,
} from '../intake/intake.js';
import { isValidElevenLabsVoiceId } from '../llm/elevenlabsTts.js';
import { BlockingIOError, checkNoActivePipelineRun, withExclusiveSeriesLock } from '../locks/seriesLock.js';

const nullableFields = <T extends z.ZodRawShape>(shape: T) => Object.fromEntries(
  Object.entries(shape).map(([key, schema]) => [key, schema.nullable()]),
) as { [K in keyof T]: z.ZodNullable<T[K]> };
export const seriesSettingsPatchSchema = z.object({
  style: z.object(nullableFields(seriesStyleSchema.shape)).strict().optional(),
  tts: z.object(nullableFields(ttsStyleSchema.shape)).strict().optional(),
  visuals: z.object({
    background: z.enum(BACKGROUNDS).optional(),
    motion: z.enum(MOTIONS).optional(),
    // Whole-object replace; null resets to the renderer defaults.
    animation: cardAnimationSchema.nullable().optional(),
  }).strict().optional(),
  // Switches the narration engine; meta.tts is rebuilt from the catalog selection.
  narration: z.object({
    provider: z.string().trim().min(1).max(100),
    voice: z.string().trim().min(1).max(300),
    model: z.string().trim().regex(/^[a-z0-9_]{2,64}$/).nullable().optional(),
  }).strict().optional(),
}).strict();

type SeriesSettingsPatch = z.infer<typeof seriesSettingsPatchSchema>;

export const NARRATION_LOCKED_MESSAGE = 'Pause the run first, then change narration.';

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function metadata(dir: string): Record<string, any> {
  const file = path.join(dir, 'meta.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw httpError('Series metadata cannot be a symbolic link', 400);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw httpError('Invalid series metadata', 400);
  return meta;
}

function procRoot(): string {
  return process.env.MANHWA_PROC_ROOT || '/proc';
}

/** Message while a live pipeline process holds the series, else null. */
function narrationLock(dir: string): string | null {
  const active = checkNoActivePipelineRun(procRoot(), path.basename(dir));
  if (active.ok) return null;
  return active.status === 409 ? NARRATION_LOCKED_MESSAGE : active.error;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function getSeriesSettings(dir: string) {
  const meta = metadata(dir);
  const tts = meta.tts && typeof meta.tts === 'object' ? meta.tts as Record<string, unknown> : {};
  return { style: meta.style ?? {}, tts: meta.tts ?? {}, visuals: meta.visuals ?? {},
    ttsEngine: seriesTtsEngine(meta),
    narration: {
      provider: ttsProviderIdFromMeta(tts, process.env),
      voice: stringOrNull(tts.voice_id),
      model: stringOrNull(tts.model_id),
    },
    narrationLocked: narrationLock(dir),
    effective: resolveSeriesStyle(meta.style), styleOptions: STYLE_CATALOG };
}

/** Read-only through `tts`; only a `narration` PATCH changes the engine. */
function seriesTtsEngine(meta: Record<string, any>): string | null {
  const engine = meta.tts && typeof meta.tts === 'object' ? String(meta.tts.engine ?? '').trim() : '';
  return engine || null;
}

function parsePatch(input: unknown): SeriesSettingsPatch {
  const result = seriesSettingsPatchSchema.safeParse(input);
  if (!result.success) throw httpError(validationMessage(result.error), 400);
  return result.data;
}

/** Null resets an override; omitted fields preserve the saved value. */
function applyGroups(meta: Record<string, any>, data: SeriesSettingsPatch): void {
  const voiceId = data.tts?.voice_id;
  if (seriesTtsEngine(meta) === 'elevenlabs' && typeof voiceId === 'string' && !isValidElevenLabsVoiceId(voiceId)) {
    throw httpError('tts.voice_id: invalid ElevenLabs voice id (expected 16-40 letters or digits)', 400);
  }
  for (const group of ['style', 'tts', 'visuals'] as const) {
    const patch = data[group];
    if (!patch) continue;
    meta[group] = { ...meta[group] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete meta[group][key];
      else if (value !== undefined) meta[group][key] = value;
    }
  }
}

function syncJobs(dir: string, data: SeriesSettingsPatch, meta: Record<string, any>): void {
  const change: { tts?: Record<string, unknown>; visuals?: Record<string, unknown> } = {};
  if (data.tts || data.narration) change.tts = { ...meta.tts };
  if (data.visuals) change.visuals = { ...meta.visuals };
  if (!change.tts && !change.visuals) return;
  try {
    syncSeriesJobsAfterSettings(path.basename(dir), change, process.env);
  } catch (err) {
    console.warn(`[series-settings] job sync for ${path.basename(dir)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Style, tts and visuals edits only (no engine switch). Synchronous, and allowed
 * while a run is live. Use updateSeriesSettings for a `narration` change.
 */
export function patchSeriesSettings(dir: string, input: unknown) {
  const data = parsePatch(input);
  if (data.narration) throw httpError('narration: use the async settings update', 400);
  const meta = metadata(dir);
  applyGroups(meta, data);
  atomicWriteJson(path.join(dir, 'meta.json'), meta, dir);
  syncJobs(dir, data, meta);
  return getSeriesSettings(dir);
}

async function narrationTts(
  narration: NonNullable<SeriesSettingsPatch['narration']>,
): Promise<{ metaTts: Record<string, unknown>; engine: string }> {
  let selection: Awaited<ReturnType<typeof resolveTtsSelection>>;
  try {
    selection = await resolveTtsSelection(narration.provider, narration.voice, undefined, process.env, true);
  } catch (err) {
    throw httpError(err instanceof Error ? err.message : String(err), 400);
  }
  if (selection.engine === 'elevenlabs') {
    if (!isValidElevenLabsVoiceId(selection.voiceId)) {
      throw httpError('narration.voice: invalid ElevenLabs voice id (expected 16-40 letters or digits)', 400);
    }
    try {
      await assertElevenLabsVoiceUsable(selection.voiceId, process.env);
    } catch (err) {
      throw httpError(err instanceof Error ? err.message : String(err), 400);
    }
  }
  return { metaTts: selection.metaTts, engine: selection.engine };
}

/** Full PATCH: style, tts, visuals and the narration switch. */
export async function updateSeriesSettings(dir: string, input: unknown) {
  const data = parsePatch(input);
  if (!data.narration) return patchSeriesSettings(dir, data);
  if (data.tts?.voice_id !== undefined || data.tts?.model_id !== undefined) {
    throw httpError('Use narration.voice and narration.model when changing narration.', 400);
  }
  if (narrationLock(dir)) throw httpError(NARRATION_LOCKED_MESSAGE, 409);
  const narration = data.narration;
  const next = await narrationTts(narration);
  const write = () => {
    // Re-check under the lock: a run may have started during validation.
    if (narrationLock(dir)) throw httpError(NARRATION_LOCKED_MESSAGE, 409);
    const meta = metadata(dir);
    const old = meta.tts && typeof meta.tts === 'object' ? meta.tts as Record<string, unknown> : {};
    const tts: Record<string, unknown> = { ...next.metaTts };
    if (old.speed !== undefined) tts.speed = old.speed;
    if (old.style !== undefined) tts.style = old.style;
    if (next.engine === 'elevenlabs') {
      const model = narration.model === undefined
        ? (seriesTtsEngine(meta) === 'elevenlabs' ? old.model_id : undefined)
        : narration.model;
      if (typeof model === 'string' && model) tts.model_id = model;
    }
    meta.tts = tts;
    applyGroups(meta, { ...data, narration: undefined });
    atomicWriteJson(path.join(dir, 'meta.json'), meta, dir);
    return meta;
  };
  let meta: Record<string, any>;
  try {
    meta = withExclusiveSeriesLock(dir, { nonblocking: true, seriesRoot: path.dirname(dir) }, write);
  } catch (err) {
    if (err instanceof BlockingIOError) throw httpError('The series is busy right now. Try again in a moment.', 409);
    throw err;
  }
  syncJobs(dir, data, meta);
  return getSeriesSettings(dir);
}
