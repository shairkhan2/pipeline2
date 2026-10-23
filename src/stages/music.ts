/**
 * Background music bed (DISABLED by default).
 *
 * A quiet looping track under the narration, the way top recap channels mix it.
 * Nothing here runs unless a series opts in AND a source is available:
 *
 *   meta.json  "music": { "enabled": true, "file": "music/bed.mp3", "volume": 0.12 }
 *   env        MUSIC_BED=on   (global switch; MUSIC_BED=off always wins)
 *
 * Sources, in order: an explicit local file, then a generation provider. No
 * provider is wired yet (music generation access is still being researched), so
 * `provider` resolves to null with a reason instead of failing the render.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MUSIC_VOLUME = 0.12;
export const MAX_MUSIC_VOLUME = 0.35;

export interface MusicBed {
  /** Absolute path of the audio file to loop under the narration. */
  file: string;
  /** Linear gain 0..MAX_MUSIC_VOLUME; narration stays at 1. */
  volume: number;
}

export interface MusicDecision {
  bed: MusicBed | null;
  /** Why there is no bed (for the run log); empty when a bed is used. */
  reason: string;
}

/** Providers that can generate a bed. Empty until one is chosen. */
export const MUSIC_PROVIDERS: Record<string, (seriesDir: string) => Promise<string | null>> = {};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function resolveMusicBed(
  meta: unknown,
  seriesDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MusicDecision> {
  const sw = String(env.MUSIC_BED ?? "").trim().toLowerCase();
  if (sw === "off" || sw === "0" || sw === "false") return { bed: null, reason: "MUSIC_BED=off" };
  const cfg = isRecord(meta) && isRecord(meta.music) ? meta.music : {};
  const enabled = cfg.enabled === true || sw === "on" || sw === "1" || sw === "true";
  if (!enabled) return { bed: null, reason: "music disabled" };

  const raw = Number(cfg.volume);
  const volume = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_MUSIC_VOLUME) : DEFAULT_MUSIC_VOLUME;

  if (typeof cfg.file === "string" && cfg.file.trim()) {
    const file = path.resolve(seriesDir, cfg.file.trim());
    if (!existsSync(file)) return { bed: null, reason: `music file missing: ${file}` };
    return { bed: { file, volume }, reason: "" };
  }

  const name = typeof cfg.provider === "string" ? cfg.provider.trim() : "";
  if (!name) return { bed: null, reason: "music enabled but no file or provider configured" };
  const gen = MUSIC_PROVIDERS[name];
  if (!gen) return { bed: null, reason: `music provider ${JSON.stringify(name)} not available yet` };
  try {
    const file = await gen(seriesDir);
    return file && existsSync(file)
      ? { bed: { file, volume }, reason: "" }
      : { bed: null, reason: `music provider ${name} returned no file` };
  } catch (e) {
    return { bed: null, reason: `music provider ${name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
