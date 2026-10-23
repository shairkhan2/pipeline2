/**
 * Catalog adapter for the language-version API.
 *
 * `config/languages.ts` is the single source of truth for supported locales,
 * voices and the locale output layout. This module only reshapes that catalog
 * into the HTTP contract, resolves each voice's provider availability, and
 * appends the account's already-discovered Vertex voices (read from the local
 * discovery cache, never a network call), so there is no second registry to
 * drift.
 *
 * Every read here is synchronous and offline: the polled GET must never spend
 * a provider call or block on discovery.
 */
import fs from "node:fs";
import path from "node:path";

import {
  LANGUAGE_CATALOG,
  getLanguageEntry,
  languageChapterDir,
  validateLocale,
  type LanguageVoice as ConfigVoice,
} from "../config/languages.js";
import { resolveOutDir } from "../config/secretStore.js";
import {
  hasVertexTtsCredentials,
  listVertexTtsVoices,
  VERTEX_TTS_DEFAULT_LOCALE,
} from "../llm/vertexTts.js";
import type { LanguageCatalogEntry, LanguageVoice } from "./types.js";

/** Setup hint shown instead of silently substituting a free Edge voice. */
export const VERTEX_SETUP_HINT =
  "Connect a Vertex AI provider in Studio (Providers → Vertex AI) to use Vertex voices.";

function envOf(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? process.env;
}

/** Provider identity for a catalog voice: explicit, else derived from engine. */
export function voiceProvider(voice: { engine: string; provider?: string }): string {
  if (voice.provider) return voice.provider;
  return voice.engine === "vertex" ? "vertex" : voice.engine;
}

interface Availability {
  available: boolean;
  reason?: string;
}

type AvailabilityCache = Map<string, Availability>;

/**
 * Availability memo for the polled GET path. `voicesFor` runs once per chapter
 * via `jobVoiceIdentity`, and each probe would otherwise re-read the provider
 * and secret stores from disk. The memo is keyed by the out dir and dropped as
 * soon as that store's mtime changes, so a credential edit is picked up on the
 * next request without a network call.
 */
let availabilityMemo: { outDir: string; stamp: string; value: Availability } | null = null;

function vertexStoreStamp(outDir: string): string {
  const parts: string[] = [];
  for (const name of ["providers.json", "secrets.json"]) {
    try {
      const st = fs.statSync(path.join(outDir, "config", name));
      parts.push(`${name}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${name}:-`);
    }
  }
  return parts.join("|");
}

/** Cheap credential probe per provider. No network, no synthesis. */
function providerAvailability(provider: string, env: NodeJS.ProcessEnv, cache?: AvailabilityCache): Availability {
  if (provider !== "vertex") return { available: true };
  const hit = cache?.get(provider);
  if (hit) return hit;
  let outDir = "";
  try {
    outDir = resolveOutDir(env.MANHWA_OUT_DIR || env.PIPELINE_OUT_DIR);
  } catch {
    outDir = "";
  }
  const stamp = outDir ? vertexStoreStamp(outDir) : "";
  let result: Availability;
  if (outDir && availabilityMemo && availabilityMemo.outDir === outDir && availabilityMemo.stamp === stamp) {
    result = availabilityMemo.value;
  } else {
    const probe = hasVertexTtsCredentials(env);
    result = probe.available
      ? { available: true }
      : { available: false, reason: probe.reason || VERTEX_SETUP_HINT };
    if (outDir) availabilityMemo = { outDir, stamp, value: result };
  }
  cache?.set(provider, result);
  return result;
}

function toLanguageVoice(voice: ConfigVoice, env: NodeJS.ProcessEnv, cache?: AvailabilityCache): LanguageVoice {
  const provider = voiceProvider(voice);
  const availability = providerAvailability(provider, env, cache);
  const modelId = voice.modelId ?? (provider === "edge" ? "edge" : provider);
  const modelLabel = voice.modelLabel ?? (provider === "edge" ? "Edge" : provider);
  return {
    id: voice.id,
    label: voice.label,
    engine: voice.engine,
    provider,
    modelId,
    modelLabel,
    available: availability.available,
    ...(availability.available ? {} : { unavailableReason: availability.reason ?? VERTEX_SETUP_HINT }),
  };
}

/** True when the Vertex discovery cache has a voice the curated list omits. */
function discoveredVertexVoices(
  locale: string,
  env: NodeJS.ProcessEnv,
  known: Set<string>,
  cache?: AvailabilityCache,
): LanguageVoice[] {
  if (!providerAvailability("vertex", env, cache).available) return [];
  const english = locale === VERTEX_TTS_DEFAULT_LOCALE;
  let list: ReturnType<typeof listVertexTtsVoices>;
  try {
    list = listVertexTtsVoices(env, english ? null : locale);
  } catch {
    return [];
  }
  const out: LanguageVoice[] = [];
  for (const voice of list) {
    const key = voice.id.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    // Only voices the account actually listed for this locale are added; the
    // English catalog stays exactly the static list plus its own discovery.
    if (english) continue;
    out.push({
      id: voice.id,
      label: voice.label,
      engine: "vertex",
      provider: "vertex",
      modelId: voice.modelId,
      modelLabel: voice.modelLabel,
      available: true,
    });
  }
  return out;
}

function entryVoices(locale: string, env: NodeJS.ProcessEnv, cache?: AvailabilityCache): LanguageVoice[] {
  const entry = getLanguageEntry(locale);
  if (!entry) return [];
  const voices = entry.voices.map((voice) => toLanguageVoice(voice, env, cache));
  const known = new Set(voices.map((voice) => voice.id.toLowerCase()));
  voices.push(...discoveredVertexVoices(entry.locale, env, known, cache));
  return voices;
}

/** Catalog in the exact shape the language API returns. */
export function catalog(env?: NodeJS.ProcessEnv): LanguageCatalogEntry[] {
  const runEnv = envOf(env);
  const cache: AvailabilityCache = new Map();
  return LANGUAGE_CATALOG.map((entry) => ({
    locale: entry.locale,
    label: entry.label,
    nativeLabel: entry.nativeLabel,
    voices: entryVoices(entry.locale, runEnv, cache),
  }));
}

export function catalogEntry(locale: string, env?: NodeJS.ProcessEnv): LanguageCatalogEntry | null {
  const entry = getLanguageEntry(locale);
  if (!entry) return null;
  return {
    locale: entry.locale,
    label: entry.label,
    nativeLabel: entry.nativeLabel,
    voices: entryVoices(entry.locale, envOf(env), new Map()),
  };
}

export function voicesFor(locale: string, env?: NodeJS.ProcessEnv): LanguageVoice[] {
  return catalogEntry(locale, env)?.voices ?? [];
}

export function findVoice(locale: string, voiceId: unknown, env?: NodeJS.ProcessEnv): LanguageVoice | null {
  if (typeof voiceId !== "string") return null;
  const id = voiceId.trim();
  if (!id) return null;
  return voicesFor(locale, env).find((voice) => voice.id === id) ?? null;
}

export function defaultVoice(locale: string): string | null {
  return getLanguageEntry(locale)?.defaultVoiceId ?? null;
}

/** Engines a language version may render with today. */
export const SUPPORTED_VOICE_ENGINES: readonly string[] = ["edge", "vertex"];

/**
 * Voice + provider identity for a render. The provider is authoritative: it is
 * persisted with the job so a retry cannot silently switch engines.
 */
export interface ResolvedVoice {
  voice: LanguageVoice;
  engine: "edge" | "vertex";
  provider: string;
  modelId: string;
  modelLabel: string;
}

/**
 * Validate a requested voice for a locale and resolve its render identity.
 * Throws a caller-visible error when the voice is unknown, its engine is not
 * supported, or its provider has no usable credentials (never a silent Edge
 * substitution).
 */
export function resolveVoice(
  locale: string,
  voiceId: unknown,
  env?: NodeJS.ProcessEnv,
): ResolvedVoice {
  const runEnv = envOf(env);
  const voice = findVoice(locale, voiceId, runEnv);
  if (!voice) {
    const available = voicesFor(locale, runEnv).map((v) => v.id);
    throw new UnsupportedVoiceError(
      `Voice ${JSON.stringify(String(voiceId ?? ""))} is not available for ${locale}. Choose: ${available.join(", ")}`,
      "unsupported_voice",
    );
  }
  if (!SUPPORTED_VOICE_ENGINES.includes(voice.engine)) {
    throw new UnsupportedVoiceError(
      `Voice ${voice.id} uses engine ${voice.engine}; language versions support ${SUPPORTED_VOICE_ENGINES.join(" and ")}.`,
      "unsupported_provider",
    );
  }
  const provider = voiceProvider(voice);
  const availability = providerAvailability(provider, runEnv);
  if (!availability.available) {
    throw new UnsupportedVoiceError(
      `Voice ${voice.id} needs ${provider} credentials: ${availability.reason ?? VERTEX_SETUP_HINT}`,
      "provider_unavailable",
    );
  }
  return {
    voice,
    engine: voice.engine as "edge" | "vertex",
    provider,
    modelId: voice.modelId ?? provider,
    modelLabel: voice.modelLabel ?? provider,
  };
}

/** Voice validation failure with the HTTP code the route should return. */
export class UnsupportedVoiceError extends Error {
  readonly code: string;
  readonly statusCode = 400;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UnsupportedVoiceError";
    this.code = code;
  }
}

export { validateLocale, languageChapterDir };
