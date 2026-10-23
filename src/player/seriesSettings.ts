import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { seriesStyleSchema, ttsStyleSchema, STYLE_CATALOG, resolveSeriesStyle, validationMessage } from '../config/seriesStyle.js';
import { BACKGROUNDS, MOTIONS } from '../intake/ingest.js';
import { atomicWriteJson } from '../intake/intake.js';

const nullableFields = <T extends z.ZodRawShape>(shape: T) => Object.fromEntries(
  Object.entries(shape).map(([key, schema]) => [key, schema.nullable()]),
) as { [K in keyof T]: z.ZodNullable<T[K]> };
export const seriesSettingsPatchSchema = z.object({
  style: z.object(nullableFields(seriesStyleSchema.shape)).strict().optional(),
  tts: z.object(nullableFields(ttsStyleSchema.shape)).strict().optional(),
  visuals: z.object({
    background: z.enum(BACKGROUNDS).optional(),
    motion: z.enum(MOTIONS).optional(),
  }).strict().optional(),
}).strict();

function metadata(dir: string): Record<string, any> {
  const file = path.join(dir, 'meta.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('Series metadata cannot be a symbolic link'), { statusCode: 400 });
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw Object.assign(new Error('Invalid series metadata'), { statusCode: 400 });
  return meta;
}

export function getSeriesSettings(dir: string) {
  const meta = metadata(dir);
  return { style: meta.style ?? {}, tts: meta.tts ?? {}, visuals: meta.visuals ?? {},
    effective: resolveSeriesStyle(meta.style), styleOptions: STYLE_CATALOG };
}

/** Null resets an override; omitted fields preserve the saved value. */
export function patchSeriesSettings(dir: string, input: unknown) {
  const result = seriesSettingsPatchSchema.safeParse(input);
  if (!result.success) throw Object.assign(new Error(validationMessage(result.error)), { statusCode: 400 });
  const meta = metadata(dir);
  for (const group of ['style', 'tts', 'visuals'] as const) {
    const patch = result.data[group];
    if (!patch) continue;
    meta[group] = { ...meta[group] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete meta[group][key];
      else if (value !== undefined) meta[group][key] = value;
    }
  }
  atomicWriteJson(path.join(dir, 'meta.json'), meta, dir);
  return getSeriesSettings(dir);
}
