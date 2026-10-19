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
import { execFileSync } from "node:child_process";
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

const GEMINI_VOICES: Array<[string, string]> = [
  ["Charon", "Charon · Gemini 3.8 Flash TTS"],
  ["Puck", "Puck · Gemini 3.8 Flash TTS"],
  ["Fenrir", "Fenrir · Gemini 3.8 Flash TTS"],
  ["Kore", "Kore · Gemini 3.8 Flash TTS"],
  ["Aoede", "Aoede · Gemini 3.8 Flash TTS"],
];

const STATIC_VERTEX_TTS_VOICES: VertexTtsVoice[] = [
  ...CHIRP_VOICES.map(([id, label, isDefault]) => ({
    id,
    label,
    engine: "chirp" as const,
    voiceName: id,
    ...(isDefault ? { default: true } : {}),
  })),
  ...GEMINI_VOICES.map(([voiceName, label]) => ({
    id: `gemini-tts:${voiceName}`,
    label,
    engine: "gemini" as const,
    voiceName,
  })),
];

/** Built-in fallback catalog; discovery extends it (never replaces Gemini). */
export const VERTEX_TTS_VOICES: VertexTtsVoice[] = STATIC_VERTEX_TTS_VOICES;

export const VERTEX_TTS_DEFAULT_VOICE = "en-US-Chirp3-HD-Charon";
export const CHIRP_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
export const VERTEX_TTS_VOICES_URL = "https://texttospeech.googleapis.com/v1/voices?languageCode=en-US";
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_TTS_LOCATION = "global";
export const GEMINI_TTS_AUDIO_RATE = 24_000;
/** Discovered voices are cached here so synchronous catalog reads can use them. */
export const VERTEX_TTS_VOICES_CACHE_FILENAME = "vertex-tts-voices.json";

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

export function vertexTtsVoicesCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(envOutDir(env), "config", VERTEX_TTS_VOICES_CACHE_FILENAME);
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

function familyLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("chirp3-hd")) return "Chirp 3 HD";
  if (lower.includes("neural2")) return "Neural2";
  return "Studio";
}

function shortVoiceName(name: string): string {
  const parts = name.split("-");
  return parts.length > 2 ? parts.slice(2).join("-") : name;
}

/** Read the cached discovered voice list. Synchronous, never throws. */
export function readCachedVertexTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
): VertexTtsVoice[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(vertexTtsVoicesCachePath(env), "utf8");
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
      out.push({
        id,
        voiceName,
        label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : id,
        engine: rec.engine === "gemini" ? "gemini" : "chirp",
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
): void {
  const file = vertexTtsVoicesCachePath(env);
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
 */
export async function discoverVertexTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fetchImpl?: typeof fetch },
): Promise<VertexTtsVoice[]> {
  const credentials = await resolveVertexTtsCredentials(env, { fetchImpl: opts?.fetchImpl });
  const doFetch = resolveFetch(opts?.fetchImpl);
  const res = await doFetch(VERTEX_TTS_VOICES_URL, {
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
    if (languageCodes.length > 0 && !languageCodes.some((c) => c.toLowerCase().startsWith("en"))) continue;
    voices.push({
      id: name,
      label: `${shortVoiceName(name)} · ${familyLabel(name)}`,
      engine: "chirp",
      voiceName: name,
    });
  }
  if (voices.length > 0) {
    voices[0]!.default = true;
    writeCachedVertexTtsVoices(env, credentials.projectId, voices);
  }
  return voices;
}

/** Static Gemini voices are always available; discovery covers the rest. */
function geminiVoices(): VertexTtsVoice[] {
  return STATIC_VERTEX_TTS_VOICES.filter((v) => v.engine === "gemini");
}

/**
 * Full catalog for a directory: cached discovery (or the static Chirp list)
 * plus the Gemini voices.
 */
export function listVertexTtsVoices(env: NodeJS.ProcessEnv = process.env): VertexTtsVoice[] {
  const discovered = readCachedVertexTtsVoices(env);
  const base = discovered && discovered.length > 0
    ? discovered
    : STATIC_VERTEX_TTS_VOICES.filter((v) => v.engine === "chirp");
  return [...base, ...geminiVoices()];
}

export function findVertexTtsVoice(
  voiceId: string,
  env: NodeJS.ProcessEnv = process.env,
): VertexTtsVoice | null {
  const wanted = String(voiceId ?? "").trim();
  if (!wanted) return null;
  const staticHit = STATIC_VERTEX_TTS_VOICES.find(
    (v) => v.id.toLowerCase() === wanted.toLowerCase(),
  );
  if (staticHit) return staticHit;
  const cached = readCachedVertexTtsVoices(env);
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
  },
): Promise<void> {
  const languageCode = opts.voice.voiceName.split("-").slice(0, 2).join("-") || "en-US";
  const res = await opts.fetchImpl(CHIRP_TTS_URL, {
    method: "POST",
    headers: {
      ...authHeaders(opts.credentials.accessToken),
      "x-goog-user-project": opts.credentials.projectId,
    },
    body: JSON.stringify({
      input: { text: opts.text },
      voice: { languageCode, name: opts.voice.voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate: opts.speed },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Vertex Chirp 3 HD synthesis failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
  }
  const body = (await res.json().catch(() => null)) as { audioContent?: unknown } | null;
  const audioContent = typeof body?.audioContent === "string" ? body.audioContent : "";
  if (!audioContent) throw new Error("Vertex Chirp 3 HD response missing audioContent");
  const audio = decodeBase64(audioContent);
  if (audio.length === 0) throw new Error("Vertex Chirp 3 HD returned empty audio");
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

function transcodeToMp3(raw: Buffer, mimeType: string, destPath: string, speed?: number): void {
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
    execFileSync("ffmpeg", args, { timeout: 120_000, stdio: ["ignore", "ignore", "pipe"] });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw new Error("ffmpeg produced no MP3 for the Gemini TTS audio");
    }
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
  },
): Promise<void> {
  const url =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(opts.credentials.projectId)}` +
    `/locations/${GEMINI_TTS_LOCATION}/publishers/google/models/${GEMINI_TTS_MODEL}:generateContent`;
  const res = await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      ...authHeaders(opts.credentials.accessToken),
      "x-goog-user-project": opts.credentials.projectId,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: opts.text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice.voiceName } },
        },
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`Vertex Gemini 3.8 Flash TTS failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
  }
  const body = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown; mimeType?: unknown } }> } }>;
  } | null;
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
  transcodeToMp3(raw, mimeType.toLowerCase(), opts.destPath, opts.speed);
}

/**
 * Synthesize `text` with a Vertex voice straight to `destPath` (MP3).
 * Unknown voices fail loudly; there is no silent fallback.
 */
export async function synthesizeVertexTtsToFile(opts: SynthesizeVertexTtsOptions): Promise<void> {
  const text = String(opts.text ?? "");
  if (!text.trim()) throw new Error("Vertex TTS text is empty");
  const env = opts.env ?? process.env;
  const voice = findVertexTtsVoice(opts.voiceId, env);
  if (!voice) {
    const valid = listVertexTtsVoices(env).map((v) => v.id).join(", ");
    throw new Error(`Voice '${opts.voiceId}' is not a Vertex TTS voice (available: ${valid})`);
  }
  const speedRaw = typeof opts.speed === "number" && Number.isFinite(opts.speed) ? opts.speed : 1;
  const speed = Math.min(4, Math.max(0.25, speedRaw));
  const credentials = await resolveVertexTtsCredentials(env, { fetchImpl: opts.fetchImpl });
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const destPath = path.resolve(opts.destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (voice.engine === "chirp") {
    await synthesizeChirp({ text, destPath, voice, speed, credentials, fetchImpl });
  } else {
    await synthesizeGemini({ text, destPath, voice, speed, credentials, fetchImpl });
  }
}
