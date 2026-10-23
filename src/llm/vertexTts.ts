/**
 * vertexTts.ts - real Google Vertex AI text-to-speech.
 *
 * Two families, one voice catalog:
 *  - Chirp 3 HD / Studio / Neural2: `POST https://texttospeech.googleapis.com/v1/text:synthesize`
 *    (MP3 in the response, sub-second latency).
 *  - Gemini 3.8 Flash TTS: `POST .../models/gemini-3.8-flash-tts:generateContent`
 *    with `responseModalities: ["AUDIO"]`; the response carries 24 kHz audio
 *    (WAV or raw L16 PCM) that ffmpeg transcodes to MP3.
 *
 * Credentials resolve from the app's own Studio store only:
 *  1. The enabled `vertex-ai` provider (or a provider using the Vertex preset /
 *     protocol) in `<outDir>/config/providers.json`.
 *  2. Its secret in `<outDir>/config/secrets.json` (`provider:<id>`): a service
 *     account JSON or a stored OAuth access/refresh token blob.
 *  3. `projectId` from the provider `auth.projectId`, else the service account
 *     `project_id`.
 *
 * No host gcloud ADC file and no hardcoded host path is ever consulted.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isVertexOAuthSecret,
  listProviders,
  mintVertexAccessToken,
  resolveVertexOAuthAccessToken,
  type ProviderView,
} from "../config/studioConfig.js";
import { getSecret, putSecret, resolveOutDir, scrubSecrets } from "../config/secretStore.js";

export type VertexTtsEngine = "chirp" | "gemini";

export interface VertexTtsVoice {
  id: string;
  label: string;
  engine: VertexTtsEngine;
  /** Chirp 3 HD / Studio / Neural2 voice name, or Gemini prebuilt voice name. */
  voiceName: string;
  /** Underlying model family: `chirp-3-hd`, `studio`, `neural2`, or the Gemini TTS model id. */
  modelId: string;
  /** Human model name for grouped pickers, e.g. `Chirp 3 HD`. */
  modelLabel: string;
  default?: boolean;
}

const CHIRP_VOICES: Array<[string, string, boolean?]> = [
  ["en-US-Chirp3-HD-Charon", "Charon · Chirp 3 HD", true],
  ["en-US-Chirp3-HD-Puck", "Puck · Chirp 3 HD"],
  ["en-US-Chirp3-HD-Fenrir", "Fenrir · Chirp 3 HD"],
  ["en-US-Chirp3-HD-Kore", "Kore · Chirp 3 HD"],
  ["en-US-Chirp3-HD-Aoede", "Aoede · Chirp 3 HD"],
  ["en-US-Chirp3-HD-Zephyr", "Zephyr · Chirp 3 HD"],
];

/**
 * Built-in Chirp 3 HD voices for a shipped localized locale. Names follow the
 * vendor format `<locale>-<model>-<voice>` and Chirp 3 HD is GA for hi-IN
 * (cloud.google.com/text-to-speech/docs/chirp3-hd). Only locales the pipeline
 * ships are listed: an unknown locale gets the multilingual Gemini voices only.
 */
const LOCALIZED_CHIRP_VOICES: Record<string, Array<[string, string, boolean?]>> = {
  "hi-IN": [
    ["hi-IN-Chirp3-HD-Aoede", "Aoede · Chirp 3 HD"],
    ["hi-IN-Chirp3-HD-Charon", "Charon · Chirp 3 HD"],
    ["hi-IN-Chirp3-HD-Kore", "Kore · Chirp 3 HD"],
    ["hi-IN-Chirp3-HD-Puck", "Puck · Chirp 3 HD"],
  ],
};

/**
 * Locales Gemini TTS speaks per the vendor's GA language table. Gemini voices
 * are language-agnostic voice NAMES (`Charon`), not `<locale>-...` ids, so the
 * English-prefix filter must never hide them from a localized picker.
 */
export const GEMINI_TTS_LOCALES: ReadonlySet<string> = new Set(["en-US", "hi-IN"]);

const GEMINI_VOICES: Array<[string, string]> = [
  ["Charon", "Charon · Gemini 3.8 Flash TTS"],
  ["Puck", "Puck · Gemini 3.8 Flash TTS"],
  ["Fenrir", "Fenrir · Gemini 3.8 Flash TTS"],
  ["Kore", "Kore · Gemini 3.8 Flash TTS"],
  ["Aoede", "Aoede · Gemini 3.8 Flash TTS"],
];

/** Model id for a Chirp/Studio/Neural2 voice name. */
export function chirpModelId(voiceName: string): string {
  const lower = voiceName.toLowerCase();
  if (lower.includes("chirp3-hd")) return "chirp-3-hd";
  if (lower.includes("neural2")) return "neural2";
  if (lower.includes("studio")) return "studio";
  return "chirp-3-hd";
}

export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_TTS_LOCATION = "global";
export const GEMINI_TTS_AUDIO_RATE = 24_000;
export const GEMINI_TTS_MODEL_LABEL = "Gemini 3.8 Flash TTS";

/**
 * Revision of the localized Gemini TTS request shape.
 *
 * Gemini TTS speaks `parts[].text` verbatim, so the localized request carries the
 * transcript only (no instruction wrapper). Any cache entry written under an
 * older shape holds audio that speaks that wrapper, so localized Gemini proofs
 * and narration keys embed this revision and a bump regenerates them. English
 * requests never carried the wrapper and stay byte-identical.
 */
export const GEMINI_LOCALE_REQUEST_REV = 2;

/** True for a Gemini TTS voice id (`gemini-tts:Charon`). */
export function isGeminiTtsVoiceId(voiceId: unknown): boolean {
  return typeof voiceId === "string" && voiceId.trim().toLowerCase().startsWith("gemini-tts:");
}

/**
 * Remove bracketed delivery controls (`[deadpan]`, `[sighs]`) from text spoken
 * by a TTS engine that reads brackets literally. A control is a short lowercase
 * tag; a line that was ONLY a control keeps its original text so the spoken
 * line count never desyncs from the shots.
 *
 * Single source of truth: `stages/audio.ts` re-uses this for Edge/Vertex lines.
 */
export function stripEmotionControls(text: string): string {
  const stripped = text
    .replace(/\[[a-z][a-z ]{1,20}\]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return stripped === "" ? text : stripped;
}

/**
 * Spoken text for a LOCALIZED take, on every engine (Edge, Chirp, Gemini).
 *
 * `stripEmotionControls` only knows lowercase ASCII tags, so a translator-made
 * tag such as `[आह]` or `[Sighs]` would be read aloud. A localized line is prose:
 * any square-bracket segment (ASCII or full-width) left after the control strip
 * is dropped. Parentheses are NOT touched, because a parenthetical aside can be
 * real narration. `⟦T1⟧`-style placeholders use other brackets and never reach
 * TTS. English never calls this, so its requests, proofs and keys are unchanged.
 * A line that is nothing but brackets keeps its words (brackets removed), so the
 * spoken line count never desyncs from the shots.
 */
export function localizedSpeechText(text: string): string {
  const base = stripEmotionControls(text);
  const stripped = base
    .replace(/[\[［][^\[\]［］]*[\]］]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (stripped !== "") return stripped;
  const unbracketed = base.replace(/[\[\]［］]/g, "").replace(/[ \t]{2,}/g, " ").trim();
  return unbracketed === "" ? base : unbracketed;
}

/** Model label for a Chirp/Studio/Neural2 voice name. */
export function chirpModelLabel(voiceName: string): string {
  switch (chirpModelId(voiceName)) {
    case "neural2":
      return "Neural2";
    case "studio":
      return "Studio";
    default:
      return "Chirp 3 HD";
  }
}

const STATIC_VERTEX_TTS_VOICES: VertexTtsVoice[] = [
  ...CHIRP_VOICES.map(([id, label, isDefault]) => ({
    id,
    label,
    engine: "chirp" as const,
    voiceName: id,
    modelId: chirpModelId(id),
    modelLabel: chirpModelLabel(id),
    ...(isDefault ? { default: true } : {}),
  })),
  ...GEMINI_VOICES.map(([voiceName, label]) => ({
    id: `gemini-tts:${voiceName}`,
    label,
    engine: "gemini" as const,
    voiceName,
    modelId: GEMINI_TTS_MODEL,
    modelLabel: GEMINI_TTS_MODEL_LABEL,
  })),
];

/** Built-in fallback catalog; discovery extends it (never replaces Gemini). */
export const VERTEX_TTS_VOICES: VertexTtsVoice[] = STATIC_VERTEX_TTS_VOICES;

function chirpVoiceEntry(
  id: string,
  label: string,
  isDefault?: boolean,
): VertexTtsVoice {
  return {
    id,
    label,
    engine: "chirp",
    voiceName: id,
    modelId: chirpModelId(id),
    modelLabel: chirpModelLabel(id),
    ...(isDefault ? { default: true } : {}),
  };
}

/**
 * Built-in voices that belong to `locale`, before any discovery cache.
 *
 * English returns the historical static list (same objects, same order). A
 * localized locale returns its own Chirp 3 HD names plus the multilingual Gemini
 * voices, because Gemini voice names carry no locale prefix and are shared by
 * every supported language. Nothing else from the English list leaks in.
 */
export function staticVertexTtsVoices(locale?: string | null): VertexTtsVoice[] {
  if (locale == null || isDefaultVertexLocale(locale)) return STATIC_VERTEX_TTS_VOICES;
  const loc = normalizeVertexLocale(locale);
  const chirp = (LOCALIZED_CHIRP_VOICES[loc] ?? []).map(([id, label]) => chirpVoiceEntry(id, label));
  const gemini: VertexTtsVoice[] = GEMINI_TTS_LOCALES.has(loc)
    ? GEMINI_VOICES.map(([voiceName, label]) => ({
      id: `gemini-tts:${voiceName}`,
      label,
      engine: "gemini" as const,
      voiceName,
      modelId: GEMINI_TTS_MODEL,
      modelLabel: GEMINI_TTS_MODEL_LABEL,
    }))
    : [];
  const merged = [...chirp, ...gemini];
  // Exactly one stable default per locale: the first built-in voice, so a later
  // discovery cache cannot silently move it.
  if (merged.length > 0 && !merged.some((v) => v.default)) merged[0]!.default = true;
  return merged;
}

export const VERTEX_TTS_DEFAULT_VOICE = "en-US-Chirp3-HD-Charon";
export const CHIRP_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
/** Default discovery locale. Kept as a constant so the English URL is unchanged. */
export const VERTEX_TTS_DEFAULT_LOCALE = "en-US";
export const VERTEX_TTS_VOICES_URL = `https://texttospeech.googleapis.com/v1/voices?languageCode=${VERTEX_TTS_DEFAULT_LOCALE}`;
/** Discovered voices are cached here so synchronous catalog reads can use them. */
export const VERTEX_TTS_VOICES_CACHE_FILENAME = "vertex-tts-voices.json";

/**
 * Voice-discovery URL for a locale. The English locale keeps the historical URL
 * exactly (`?languageCode=en-US`).
 */
export function vertexTtsVoicesUrl(locale: string = VERTEX_TTS_DEFAULT_LOCALE): string {
  const loc = normalizeVertexLocale(locale);
  return `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(loc)}`;
}

/** Canonical discovery locale: default en-US, otherwise the primary tag (`hi-IN`). */
export function normalizeVertexLocale(locale?: string | null): string {
  const raw = typeof locale === "string" ? locale.trim() : "";
  if (!raw) return VERTEX_TTS_DEFAULT_LOCALE;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(raw)) {
    throw new Error(`invalid Vertex TTS locale: ${JSON.stringify(raw)}`);
  }
  const [lang, region] = raw.split("-");
  return region ? `${lang!.toLowerCase()}-${region.toUpperCase()}` : lang!.toLowerCase();
}

/** True when `locale` is the historical English default (no cache split needed). */
export function isDefaultVertexLocale(locale?: string | null): boolean {
  const loc = normalizeVertexLocale(locale);
  // `en` and `en-US` are the same discovery pool; both keep the original cache.
  return loc === VERTEX_TTS_DEFAULT_LOCALE || loc === "en";
}

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

export interface VertexTtsCredentials {
  accessToken: string;
  projectId: string;
  source: string;
}

export interface VertexTtsAvailability {
  available: boolean;
  projectId?: string;
  reason?: string;
}

function envOutDir(env: NodeJS.ProcessEnv): string {
  return resolveOutDir(env.MANHWA_OUT_DIR || env.PIPELINE_OUT_DIR);
}

export function vertexTtsVoicesCachePath(
  env: NodeJS.ProcessEnv = process.env,
  locale?: string | null,
): string {
  // English (the default) keeps the original filename so existing caches and
  // tests are untouched; any other locale gets its own file, never shared.
  if (locale == null || isDefaultVertexLocale(locale)) {
    return path.join(envOutDir(env), "config", VERTEX_TTS_VOICES_CACHE_FILENAME);
  }
  const loc = normalizeVertexLocale(locale);
  return path.join(envOutDir(env), "config", `vertex-tts-voices.${loc}.json`);
}

interface StudioVertexConfig {
  providerId: string;
  secret: string;
  secretRef: string;
  outDir: string;
  projectId?: string;
  clientId?: string;
  location?: string;
  tokenUrl?: string;
}

function isVertexProvider(p: ProviderView): boolean {
  return p.id === "vertex-ai"
    || p.preset === "vertex-ai"
    || p.protocol === "vertex-openai"
    || p.auth?.mode === "vertex-service-account"
    || p.auth?.mode === "vertex-oauth";
}

/** First enabled Studio Vertex provider that actually holds a secret, or null. */
function readStudioVertexConfig(env: NodeJS.ProcessEnv): StudioVertexConfig | null {
  const outDir = envOutDir(env);
  let providers: ProviderView[] = [];
  try {
    providers = listProviders(outDir).filter((p) => p.enabled !== false && isVertexProvider(p));
  } catch {
    providers = [];
  }
  for (const provider of providers) {
    let secret: string | null = null;
    try {
      secret = getSecret(provider.auth.secretRef || `provider:${provider.id}`, outDir);
    } catch {
      secret = null;
    }
    if (!secret || !secret.trim()) continue;
    return {
      providerId: provider.id,
      secret,
      secretRef: provider.auth.secretRef || `provider:${provider.id}`,
      outDir,
      projectId: provider.auth.projectId,
      clientId: provider.auth.clientId,
      location: provider.auth.location,
      tokenUrl: provider.auth.tokenUrl,
    };
  }
  return null;
}

/** `project_id` from a service account JSON secret, without any network call. */
function staticProjectIdFromSecret(secret: string): string | undefined {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const projectId = parsed.project_id ?? parsed.projectId;
    return typeof projectId === "string" && projectId.trim() ? projectId.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cheap synchronous probe: is a Studio Vertex credential configured?
 * Never performs a network call.
 */
export function hasVertexTtsCredentials(env: NodeJS.ProcessEnv = process.env): VertexTtsAvailability {
  const studio = readStudioVertexConfig(env);
  if (!studio) {
    return {
      available: false,
      reason: "No Vertex AI credentials: connect a vertex-ai provider in Studio",
    };
  }
  return {
    available: true,
    projectId: studio.projectId || staticProjectIdFromSecret(studio.secret),
  };
}

/**
 * Short, non-reversible fingerprint of the EFFECTIVE Vertex configuration
 * (provider, project and secret material). It is safe to hash into a cache id:
 * no token, key or project id is exposed, but any credential change invalidates
 * audio cached under the old account.
 */
export function vertexTtsConfigFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const studio = readStudioVertexConfig(env);
  if (!studio) return "unconfigured";
  return crypto
    .createHash("sha256")
    .update([studio.providerId, studio.projectId ?? "", studio.secretRef, studio.secret].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * OAuth refresh requests in flight, keyed by `<outDir>:<providerId>`. Two
 * concurrent TTS calls that see the same expiring blob must share one refresh:
 * a second rotation with the same refresh_token would fail upstream.
 */
const inFlightRefreshes = new Map<string, Promise<VertexTtsCredentials>>();

function parseStoredOAuth(secret: string): {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
} {
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const accessToken = typeof parsed.access_token === "string"
      ? parsed.access_token
      : typeof parsed.accessToken === "string"
        ? parsed.accessToken
        : undefined;
    const refreshToken = typeof parsed.refresh_token === "string"
      ? parsed.refresh_token
      : typeof parsed.refreshToken === "string"
        ? parsed.refreshToken
        : undefined;
    const rawExp = parsed.expires_at ?? parsed.expiresAt;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: typeof rawExp === "number" ? rawExp : undefined,
    };
  } catch {
    return {};
  }
}

/** Persist a refreshed OAuth access token back to the Studio secret store. */
function persistRefreshedOAuthSecret(
  studio: StudioVertexConfig,
  accessToken: string,
  expiresAt: number | null,
): void {
  const current = parseStoredOAuth(studio.secret);
  // Spread the original blob so client_id, client_secret, token_uri and
  // quota_project_id survive the refresh: the next process needs them to
  // refresh again (and to attribute the quota).
  let original: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(studio.secret) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      original = parsed as Record<string, unknown>;
    }
  } catch {
    original = {};
  }
  try {
    putSecret(
      studio.secretRef,
      JSON.stringify({
        ...original,
        access_token: accessToken,
        ...(current.refresh_token ? { refresh_token: current.refresh_token } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      }),
      studio.outDir,
    );
  } catch {
    // A failed write must not break synthesis: the fresh token is usable now.
  }
}

/**
 * Resolve an access token + project id for Vertex TTS from the Studio store.
 * Throws when no credential is usable; the message never carries secret material.
 */
export async function resolveVertexTtsCredentials(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fetchImpl?: typeof fetch; nowSec?: number },
): Promise<VertexTtsCredentials> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const studio = readStudioVertexConfig(env);
  if (!studio) {
    throw new Error("No Vertex AI credentials: connect a vertex-ai provider in Studio");
  }
  const cacheKey = [
    studio.outDir,
    studio.providerId,
    crypto.createHash("sha256").update(studio.secret).digest("hex").slice(0, 16),
  ].join(":");
  const cached = tokenCache.get(cacheKey);
  if (cached && nowSec < cached.expiresAt - 60) {
    const projectId = studio.projectId || staticProjectIdFromSecret(studio.secret);
    if (projectId) {
      return { accessToken: cached.accessToken, projectId, source: `studio:${studio.providerId}` };
    }
  }
  if (isVertexOAuthSecret(studio.secret)) {
    const inFlightKey = `${studio.outDir}:${studio.providerId}`;
    const pending = inFlightRefreshes.get(inFlightKey);
    if (pending) return pending;
    const task = resolveOAuthTtsCredentials(studio, cacheKey, nowSec, opts);
    inFlightRefreshes.set(inFlightKey, task);
    try {
      return await task;
    } finally {
      inFlightRefreshes.delete(inFlightKey);
    }
  }
  return resolveServiceAccountTtsCredentials(studio, cacheKey, nowSec, opts);
}

async function resolveOAuthTtsCredentials(
  studio: StudioVertexConfig,
  cacheKey: string,
  nowSec: number,
  opts?: { fetchImpl?: typeof fetch; nowSec?: number },
): Promise<VertexTtsCredentials> {
  const resolved = await resolveVertexOAuthAccessToken(studio.secret, {
    fetchFn: opts?.fetchImpl,
    clientId: studio.clientId,
    tokenUrl: studio.tokenUrl,
    nowSec,
  });
  const accessToken = resolved.accessToken;
  const expiresAt = resolved.expiresAt ?? nowSec + 1800;
  const projectId = studio.projectId || resolved.projectId || staticProjectIdFromSecret(studio.secret);
  if (!projectId) {
    throw new Error("Vertex AI project id is missing (set the provider projectId or use a service account key)");
  }
  const stored = parseStoredOAuth(studio.secret);
  // Keep the refreshed token on disk so the next process skips the round trip.
  if (
    stored.access_token !== accessToken
    || (resolved.expiresAt != null && stored.expires_at !== resolved.expiresAt)
  ) {
    persistRefreshedOAuthSecret(studio, accessToken, resolved.expiresAt);
  }
  tokenCache.set(cacheKey, { accessToken, expiresAt });
  return { accessToken, projectId, source: `studio:${studio.providerId}` };
}

async function resolveServiceAccountTtsCredentials(
  studio: StudioVertexConfig,
  cacheKey: string,
  nowSec: number,
  opts?: { fetchImpl?: typeof fetch; nowSec?: number },
): Promise<VertexTtsCredentials> {
  const minted = await mintVertexAccessToken(studio.secret, {
    fetchFn: opts?.fetchImpl,
    nowSec,
  });
  const accessToken = minted.accessToken;
  const expiresAt = minted.expiresAt;
  const projectId = studio.projectId || minted.projectId || staticProjectIdFromSecret(studio.secret);
  if (!projectId) {
    throw new Error("Vertex AI project id is missing (set the provider projectId or use a service account key)");
  }
  tokenCache.set(cacheKey, { accessToken, expiresAt });
  return { accessToken, projectId, source: `studio:${studio.providerId}` };
}

/** Resolve the fetch implementation: explicit option, then the global fetch. */
function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

/* ------------------------------------------------------------------ *
 * Dynamic voice discovery
 * ------------------------------------------------------------------ */

interface VertexVoicesCacheDoc {
  updatedAt: number;
  projectId?: string;
  voices: VertexTtsVoice[];
}

function isNaturalNarrationVoice(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("chirp3-hd") || lower.includes("studio") || lower.includes("neural2");
}

function shortVoiceName(name: string): string {
  const parts = name.split("-");
  return parts.length > 2 ? parts.slice(2).join("-") : name;
}

/** Read the cached discovered voice list. Synchronous, never throws. */
export function readCachedVertexTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
  locale?: string | null,
): VertexTtsVoice[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(vertexTtsVoicesCachePath(env, locale), "utf8");
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw) as Partial<VertexVoicesCacheDoc>;
    const list = Array.isArray(doc?.voices) ? doc.voices : [];
    const out: VertexTtsVoice[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as unknown as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      const voiceName = typeof rec.voiceName === "string" ? rec.voiceName.trim() : id;
      if (!id || !voiceName) continue;
      const engine = rec.engine === "gemini" ? "gemini" : "chirp";
      const cachedModelId = typeof rec.modelId === "string" ? rec.modelId.trim() : "";
      const cachedModelLabel = typeof rec.modelLabel === "string" ? rec.modelLabel.trim() : "";
      out.push({
        id,
        voiceName,
        label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : id,
        engine,
        // Older cache files predate the model metadata; derive it from the name.
        modelId: cachedModelId || (engine === "gemini" ? GEMINI_TTS_MODEL : chirpModelId(voiceName)),
        modelLabel: cachedModelLabel
          || (engine === "gemini" ? GEMINI_TTS_MODEL_LABEL : chirpModelLabel(voiceName)),
        ...(rec.default === true ? { default: true } : {}),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function writeCachedVertexTtsVoices(
  env: NodeJS.ProcessEnv,
  projectId: string,
  voices: VertexTtsVoice[],
  locale?: string | null,
): void {
  const file = vertexTtsVoicesCachePath(env, locale);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ updatedAt: Date.now(), projectId, voices } satisfies VertexVoicesCacheDoc),
      "utf8",
    );
  } catch {
    // A cache write failure must never break synthesis or the catalog.
  }
}

/**
 * Discover the account's natural narration voices from the Text-to-Speech API
 * and cache them for synchronous catalog reads.
 *
 * `locale` defaults to en-US: the English request URL, filter and cache file are
 * unchanged. Any other locale (e.g. `hi-IN`) queries that language, keeps only
 * voices whose languageCodes match it, and caches to its own file.
 */
export async function discoverVertexTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fetchImpl?: typeof fetch; locale?: string | null },
): Promise<VertexTtsVoice[]> {
  const locale = normalizeVertexLocale(opts?.locale);
  const english = isDefaultVertexLocale(locale);
  const credentials = await resolveVertexTtsCredentials(env, { fetchImpl: opts?.fetchImpl });
  const doFetch = resolveFetch(opts?.fetchImpl);
  const res = await doFetch(english ? VERTEX_TTS_VOICES_URL : vertexTtsVoicesUrl(locale), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "x-goog-user-project": credentials.projectId,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Vertex voice discovery failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
  }
  const body = (await res.json().catch(() => null)) as { voices?: unknown } | null;
  const list = Array.isArray(body?.voices) ? body.voices : [];
  const wantedPrefix = locale.split("-")[0]!.toLowerCase();
  const voices: VertexTtsVoice[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as unknown as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name || !isNaturalNarrationVoice(name) || seen.has(name)) continue;
    seen.add(name);
    const languageCodes = Array.isArray(rec.languageCodes)
      ? rec.languageCodes.filter((c): c is string => typeof c === "string")
      : [];
    if (languageCodes.length > 0) {
      if (english) {
        if (!languageCodes.some((c) => c.toLowerCase().startsWith("en"))) continue;
      } else if (!languageCodes.some((c) => c.toLowerCase() === locale.toLowerCase())) {
        // A localized version must not adopt a voice the API did not list for it.
        continue;
      }
    } else if (!english) {
      continue;
    }
    if (!english && !name.toLowerCase().startsWith(`${wantedPrefix}-`)) continue;
    voices.push({
      id: name,
      label: `${shortVoiceName(name)} · ${chirpModelLabel(name)}`,
      engine: "chirp",
      voiceName: name,
      modelId: chirpModelId(name),
      modelLabel: chirpModelLabel(name),
    });
  }
  if (voices.length > 0) {
    voices[0]!.default = true;
    writeCachedVertexTtsVoices(env, credentials.projectId, voices, english ? null : locale);
  }
  return voices;
}

/**
 * Full catalog for a directory: the static Chirp/Gemini list stays authoritative
 * (so the built-in default voice is stable), and discovered account voices are
 * appended. Discovery adds voices; it never removes a supported model.
 *
 * `locale` is optional and defaults to English: the returned list is then
 * byte-identical to the historical catalog. A non-English locale returns only
 * voices that belong to it (its own discovery cache + static entries in that
 * language), so a Hindi picker never offers English voices.
 */
export function listVertexTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
  locale?: string | null,
): VertexTtsVoice[] {
  const english = locale == null || isDefaultVertexLocale(locale);
  const loc = normalizeVertexLocale(locale);
  const discovered = readCachedVertexTtsVoices(env, english ? null : loc) ?? [];
  const base = staticVertexTtsVoices(locale);
  const merged: VertexTtsVoice[] = [];
  const seen = new Set<string>();
  for (const voice of [...base, ...discovered]) {
    const key = voice.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...voice });
  }
  // Exactly one default: the first entry (the static default) keeps it, so a
  // discovery cache cannot silently move the default voice.
  let defaultSeen = false;
  for (const voice of merged) {
    if (!voice.default) continue;
    if (defaultSeen) delete voice.default;
    defaultSeen = true;
  }
  return merged;
}

export function findVertexTtsVoice(
  voiceId: string,
  env: NodeJS.ProcessEnv = process.env,
  locale?: string | null,
): VertexTtsVoice | null {
  const wanted = String(voiceId ?? "").trim();
  if (!wanted) return null;
  const english = locale == null || isDefaultVertexLocale(locale);
  const loc = normalizeVertexLocale(locale);
  const staticHit = staticVertexTtsVoices(locale).find((v) => v.id.toLowerCase() === wanted.toLowerCase());
  if (staticHit) return staticHit;
  // A non-English locale never resolves an English cached voice: discovery for
  // that locale lives in its own cache file.
  const cached = readCachedVertexTtsVoices(env, english ? null : loc);
  if (!cached) return null;
  return cached.find((v) => v.id.toLowerCase() === wanted.toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ *
 * Synthesis
 * ------------------------------------------------------------------ */

export interface SynthesizeVertexTtsOptions {
  text: string;
  voiceId: string;
  destPath: string;
  speed?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Optional discovery locale for the voice lookup. Absent = English (unchanged). */
  locale?: string | null;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return scrubSecrets(text).slice(0, 300);
}

function decodeBase64(data: string): Buffer {
  const cleaned = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  return Buffer.from(cleaned, "base64");
}

async function synthesizeChirp(
  opts: Required<Pick<SynthesizeVertexTtsOptions, "text" | "destPath">> & {
    voice: VertexTtsVoice;
    speed: number;
    credentials: VertexTtsCredentials;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    locale?: string | null;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  // The voice name already carries its locale (`hi-IN-Chirp3-HD-Aoede`); an
  // explicit localized request keeps that locale even for a differently named
  // (discovered) voice.
  const english = opts.locale == null || isDefaultVertexLocale(opts.locale);
  const languageCode = english
    ? opts.voice.voiceName.split("-").slice(0, 2).join("-") || "en-US"
    : normalizeVertexLocale(opts.locale);
  const res = await opts.fetchImpl(CHIRP_TTS_URL, {
    method: "POST",
    headers: {
      ...authHeaders(opts.credentials.accessToken),
      "x-goog-user-project": opts.credentials.projectId,
    },
    body: JSON.stringify({
      input: { text: english ? opts.text : localizedSpeechText(opts.text) },
      voice: { languageCode, name: opts.voice.voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate: opts.speed },
    }),
    redirect: "error",
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Vertex Chirp 3 HD synthesis failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
  }
  const body = (await res.json().catch(() => null)) as { audioContent?: unknown } | null;
  opts.signal?.throwIfAborted();
  const audioContent = typeof body?.audioContent === "string" ? body.audioContent : "";
  if (!audioContent) throw new Error("Vertex Chirp 3 HD response missing audioContent");
  const audio = decodeBase64(audioContent);
  if (audio.length === 0) throw new Error("Vertex Chirp 3 HD returned empty audio");
  opts.signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });
  fs.writeFileSync(opts.destPath, audio);
}

/**
 * Build an ffmpeg `atempo` chain for `speed`. A single atempo stage is limited
 * to 0.5..2.0, so a wider rate is split into several stages.
 */
export function buildAtempoFilter(speed: number): string {
  const clamped = Math.max(0.25, Math.min(4.0, speed));
  const stages: number[] = [];
  let rem = clamped;
  while (rem < 0.5 - 1e-9) {
    stages.push(0.5);
    rem /= 0.5;
  }
  while (rem > 2.0 + 1e-9) {
    stages.push(2.0);
    rem /= 2.0;
  }
  stages.push(Number(rem.toFixed(6)));
  return stages.map((s) => `atempo=${s}`).join(",");
}

async function transcodeToMp3(
  raw: Buffer,
  mimeType: string,
  destPath: string,
  speed?: number,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  signal?.throwIfAborted();
  // Keep the scratch directory beside the destination so the final move never
  // crosses filesystems (`/tmp` -> `/home/...` would fail with EXDEV).
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(destDir, ".vertex-tts-"));
  const inputExt = mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : "pcm";
  const inputPath = path.join(dir, `in.${inputExt}`);
  const outPath = path.join(dir, "out.mp3");
  try {
    fs.writeFileSync(inputPath, raw);
    const args = ["-v", "error", "-y"];
    if (inputExt === "pcm") {
      args.push("-f", "s16le", "-ar", String(GEMINI_TTS_AUDIO_RATE), "-ac", "1");
    }
    args.push("-i", inputPath);
    // Gemini TTS has no speakingRate knob: apply the requested speed in ffmpeg.
    if (typeof speed === "number" && Number.isFinite(speed) && Math.abs(speed - 1) > 0.01) {
      args.push("-filter:a", buildAtempoFilter(speed));
    }
    args.push("-codec:a", "libmp3lame", "-b:a", "128k", outPath);
    const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    const ffmpegBin = env.MANHWA_FFMPEG_BIN || process.env.MANHWA_FFMPEG_BIN || "ffmpeg";
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegBin,
        args,
        { signal: combinedSignal, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    signal?.throwIfAborted();
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw new Error("ffmpeg produced no MP3 for the Gemini TTS audio");
    }
    signal?.throwIfAborted();
    try {
      fs.renameSync(outPath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
      fs.copyFileSync(outPath, destPath);
      fs.unlinkSync(outPath);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function synthesizeGemini(
  opts: Required<Pick<SynthesizeVertexTtsOptions, "text" | "destPath">> & {
    voice: VertexTtsVoice;
    speed: number;
    credentials: VertexTtsCredentials;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    /** Normalized locale; the English default keeps the historical request. */
    locale?: string | null;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(opts.credentials.projectId)}` +
    `/locations/${GEMINI_TTS_LOCATION}/publishers/google/models/${GEMINI_TTS_MODEL}:generateContent`;
  const english = opts.locale == null || isDefaultVertexLocale(opts.locale);
  const locale = english ? null : normalizeVertexLocale(opts.locale);
  // Gemini TTS treats part text as a verbatim transcript: any instruction text
  // inside it is SPOKEN. A localized request therefore carries the bare
  // transcript (bracketed delivery controls stripped) and relies on
  // `speechConfig.languageCode` alone to pick the language. Speed is unaffected:
  // it never lived in the wrapper, `transcodeToMp3` applies it with ffmpeg
  // atempo because Gemini has no speakingRate knob.
  const contentsText = locale === null ? opts.text : localizedSpeechText(opts.text);
  const res = await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      ...authHeaders(opts.credentials.accessToken),
      "x-goog-user-project": opts.credentials.projectId,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: contentsText }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          // English omits languageCode exactly as before; a localized voice
          // must state its language so the model does not default to English.
          ...(locale === null ? {} : { languageCode: locale }),
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice.voiceName } },
        },
      },
    }),
    redirect: "error",
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`Vertex Gemini 3.8 Flash TTS failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
  }
  const body = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown; mimeType?: unknown } }> } }>;
  } | null;
  opts.signal?.throwIfAborted();
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  let data = "";
  let mimeType = "audio/wav";
  for (const part of parts) {
    const inline = part?.inlineData;
    if (inline && typeof inline.data === "string" && inline.data) {
      data = inline.data;
      if (typeof inline.mimeType === "string" && inline.mimeType.trim()) mimeType = inline.mimeType.trim();
      break;
    }
  }
  if (!data) throw new Error("Vertex Gemini 3.8 Flash TTS response missing inline audio data");
  const raw = decodeBase64(data);
  if (raw.length === 0) throw new Error("Vertex Gemini 3.8 Flash TTS returned empty audio");
  opts.signal?.throwIfAborted();
  await transcodeToMp3(raw, mimeType.toLowerCase(), opts.destPath, opts.speed, opts.signal, opts.env);
}

/**
 * Synthesize `text` with a Vertex voice straight to `destPath` (MP3).
 * Unknown voices fail loudly; there is no silent fallback.
 */
export async function synthesizeVertexTtsToFile(opts: SynthesizeVertexTtsOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const text = String(opts.text ?? "");
  if (!text.trim()) throw new Error("Vertex TTS text is empty");
  const env = opts.env ?? process.env;
  const voice = findVertexTtsVoice(opts.voiceId, env, opts.locale ?? null);
  if (!voice) {
    const valid = listVertexTtsVoices(env, opts.locale ?? null).map((v) => v.id).join(", ");
    throw new Error(`Voice '${opts.voiceId}' is not a Vertex TTS voice (available: ${valid})`);
  }
  const speedRaw = typeof opts.speed === "number" && Number.isFinite(opts.speed) ? opts.speed : 1;
  const speed = Math.min(4, Math.max(0.25, speedRaw));
  const credentials = await resolveVertexTtsCredentials(env, { fetchImpl: opts.fetchImpl });
  opts.signal?.throwIfAborted();
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const destPath = path.resolve(opts.destPath);
  if (voice.engine === "chirp") {
    await synthesizeChirp({
      text,
      destPath,
      voice,
      speed,
      credentials,
      fetchImpl,
      signal: opts.signal,
      locale: opts.locale ?? null,
    });
  } else {
    await synthesizeGemini({
      text,
      destPath,
      voice,
      speed,
      credentials,
      fetchImpl,
      signal: opts.signal,
      env,
      locale: opts.locale ?? null,
    });
  }
}
