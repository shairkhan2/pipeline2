/**
 * grokTts.ts - xAI / Grok subscription text-to-speech.
 *
 * Credentials resolve from the app's own Studio store only:
 *  - the enabled `grok-subscription` (or `xai`) provider in
 *    `<outDir>/config/providers.json`;
 *  - its secret in `<outDir>/config/secrets.json` (`provider:<id>`): a pasted
 *    API key/bearer token or the JSON blob written by the device-code login.
 *
 * Voices are discovered from `GET https://api.x.ai/v1/tts/voices` and cached in
 * `<outDir>/config/grok-tts-voices.json`, so the synchronous TTS catalog can
 * offer them immediately. Synthesis posts to `POST https://api.x.ai/v1/tts`.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { listProviders, type ProviderView } from "../config/studioConfig.js";
import { getSecret, putSecret, resolveOutDir, scrubSecrets } from "../config/secretStore.js";

export const GROK_TTS_URL = "https://api.x.ai/v1/tts";
export const GROK_TTS_VOICES_URL = "https://api.x.ai/v1/tts/voices";
export const GROK_TTS_VOICES_CACHE_FILENAME = "grok-tts-voices.json";

export interface GrokTtsVoice {
  id: string;
  label: string;
  default?: boolean;
}

/** Fallback voices used until discovery caches the account's real list. */
const FALLBACK_GROK_VOICES: GrokTtsVoice[] = [
  { id: "ara", label: "Ara", default: true },
  { id: "eve", label: "Eve" },
  { id: "leo", label: "Leo" },
  { id: "rex", label: "Rex" },
  { id: "sal", label: "Sal" },
];

export interface GrokTtsCredentials {
  accessToken: string;
  source: string;
}

function envOutDir(env: NodeJS.ProcessEnv): string {
  return resolveOutDir(env.MANHWA_OUT_DIR || env.PIPELINE_OUT_DIR);
}

export function grokTtsVoicesCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(envOutDir(env), "config", GROK_TTS_VOICES_CACHE_FILENAME);
}

function isGrokProvider(p: ProviderView): boolean {
  const ids = [p.id, p.preset].filter((v): v is string => typeof v === "string");
  return ids.some((id) => {
    const lower = id.trim().toLowerCase();
    return lower === "grok-subscription" || lower === "xai";
  });
}

interface StudioGrokConfig {
  providerId: string;
  secret: string;
  secretRef: string;
  outDir: string;
  tokenUrl?: string;
  clientId?: string;
}

/** First enabled Studio Grok/xAI provider that actually holds a secret, or null. */
function readStudioGrokConfig(env: NodeJS.ProcessEnv): StudioGrokConfig | null {
  const outDir = envOutDir(env);
  let providers: ProviderView[] = [];
  try {
    providers = listProviders(outDir).filter((p) => p.enabled !== false && isGrokProvider(p));
  } catch {
    providers = [];
  }
  for (const provider of providers) {
    const secretRef = provider.auth.secretRef || `provider:${provider.id}`;
    let secret: string | null = null;
    try {
      secret = getSecret(secretRef, outDir);
    } catch {
      secret = null;
    }
    if (!secret || !secret.trim()) continue;
    return {
      providerId: provider.id,
      secret,
      secretRef,
      outDir,
      tokenUrl: provider.auth.tokenUrl,
      clientId: provider.auth.clientId,
    };
  }
  return null;
}

/** True when a Studio Grok/xAI provider with a secret is configured. No network. */
export function hasGrokTtsCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return readStudioGrokConfig(env) !== null;
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/**
 * Refresh requests currently in flight, keyed by `<outDir>:<providerId>` so two
 * callers that see the same expired blob share one rotation: a second refresh
 * with the same (now-consumed) refresh_token would fail upstream.
 */
const inFlightRefreshes = new Map<string, Promise<{ token: string; secretRef: string }>>();

/** Cache key scoped to the store, provider, and the exact secret bytes. */
function grokTokenCacheKey(outDir: string, providerId: string, rawSecret: string): string {
  const digest = crypto.createHash("sha256").update(rawSecret).digest("hex").slice(0, 16);
  return `${outDir}:${providerId}:${digest}`;
}

/**
 * Resolve a bearer token from a stored secret: a raw key, or the JSON blob the
 * device-code login writes (refreshed when the access token is near expiry).
 */
export async function resolveGrokAccessToken(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fetchImpl?: typeof fetch; nowSec?: number; signal?: AbortSignal },
): Promise<GrokTtsCredentials> {
  opts?.signal?.throwIfAborted();
  const studio = readStudioGrokConfig(env);
  if (!studio) {
    throw new Error("No Grok TTS credentials: connect a grok-subscription or xai provider in Studio");
  }
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const cacheKey = grokTokenCacheKey(studio.outDir, studio.providerId, studio.secret);
  const cached = tokenCache.get(cacheKey);
  if (cached && nowSec < cached.expiresAt - 60) {
    return { accessToken: cached.accessToken, source: `studio:${studio.providerId}` };
  }
  const trimmed = studio.secret.trim();
  if (!trimmed.startsWith("{")) {
    tokenCache.set(cacheKey, { accessToken: trimmed, expiresAt: nowSec + 86_400 });
    return { accessToken: trimmed, source: `studio:${studio.providerId}` };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const accessToken = typeof parsed.access_token === "string"
    ? parsed.access_token.trim()
    : typeof parsed.accessToken === "string"
      ? parsed.accessToken.trim()
      : "";
  const refreshToken = typeof parsed.refresh_token === "string"
    ? parsed.refresh_token.trim()
    : typeof parsed.refreshToken === "string"
      ? parsed.refreshToken.trim()
      : "";
  const rawExp = parsed.expires_at ?? parsed.expiresAt;
  const expiresAt = typeof rawExp === "number" ? rawExp : null;
  if (accessToken && (expiresAt === null || nowSec < expiresAt - 60)) {
    tokenCache.set(cacheKey, { accessToken, expiresAt: expiresAt ?? nowSec + 3600 });
    return { accessToken, source: `studio:${studio.providerId}` };
  }
  if (!refreshToken) {
    if (accessToken) {
      tokenCache.set(cacheKey, { accessToken, expiresAt: nowSec + 3600 });
      return { accessToken, source: `studio:${studio.providerId}` };
    }
    throw new Error("Grok TTS secret has neither an API key nor an access_token");
  }
  const tokenUrl = (typeof parsed.token_url === "string" && parsed.token_url.trim())
    || studio.tokenUrl
    || "https://auth.x.ai/oauth2/token";
  const clientId = (typeof parsed.client_id === "string" && parsed.client_id.trim()) || studio.clientId || "";
  const doFetch = opts?.fetchImpl ?? fetch;

  const inFlightKey = `${studio.outDir}:${studio.providerId}`;
  const pending = inFlightRefreshes.get(inFlightKey);
  if (pending) {
    const shared = await pending;
    return { accessToken: shared.token, source: `studio:${studio.providerId}` };
  }

  const refresh = (async (): Promise<{ token: string; secretRef: string }> => {
    const res = await doFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...(clientId ? { client_id: clientId } : {}),
      }),
      redirect: "error",
      signal: opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
      throw new Error(`Grok token refresh failed (HTTP ${res.status}): ${detail}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
      | null;
    const next = typeof data?.access_token === "string" ? data.access_token.trim() : "";
    if (!next) throw new Error("Grok token refresh response missing access_token");
    const ttl = typeof data?.expires_in === "number" ? data.expires_in : 3600;
    const nextExpiresAt = nowSec + ttl;
    // xAI rotates the refresh token; keep the new one so the next refresh works.
    const rotatedRefreshToken = typeof data?.refresh_token === "string" && data.refresh_token.trim()
      ? data.refresh_token.trim()
      : refreshToken;
    const persisted = {
      ...parsed,
      access_token: next,
      refresh_token: rotatedRefreshToken,
      expires_at: nextExpiresAt,
    };
    let persistedOk = false;
    try {
      putSecret(studio.secretRef, JSON.stringify(persisted), studio.outDir);
      persistedOk = true;
      // The old secret bytes no longer exist on disk: drop their stale cache entry.
      tokenCache.delete(cacheKey);
    } catch {
      // A failed write must not break synthesis: the refreshed token is still usable now.
    }
    const nextCacheKey = persistedOk
      ? grokTokenCacheKey(studio.outDir, studio.providerId, JSON.stringify(persisted))
      : cacheKey;
    tokenCache.set(nextCacheKey, { accessToken: next, expiresAt: nextExpiresAt });
    return { token: next, secretRef: studio.secretRef };
  })();

  inFlightRefreshes.set(inFlightKey, refresh);
  try {
    const shared = await refresh;
    return { accessToken: shared.token, source: `studio:${studio.providerId}` };
  } finally {
    inFlightRefreshes.delete(inFlightKey);
  }
}

interface GrokVoiceCacheDoc {
  updatedAt: number;
  voices: GrokTtsVoice[];
}

/** Read the cached discovered voice list. Synchronous, never throws. */
export function readCachedGrokTtsVoices(env: NodeJS.ProcessEnv = process.env): GrokTtsVoice[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(grokTtsVoicesCachePath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw) as Partial<GrokVoiceCacheDoc>;
    const list = Array.isArray(doc?.voices) ? doc.voices : [];
    const out: GrokTtsVoice[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as unknown as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      if (!id) continue;
      out.push({
        id,
        label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : id,
        ...(rec.default === true ? { default: true } : {}),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function writeCachedGrokTtsVoices(env: NodeJS.ProcessEnv, voices: GrokTtsVoice[]): void {
  const file = grokTtsVoicesCachePath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ updatedAt: Date.now(), voices } satisfies GrokVoiceCacheDoc),
      "utf8",
    );
  } catch {
    // A cache write failure must never break synthesis or the catalog.
  }
}

/** Discover the account's TTS voices and cache them for synchronous catalog reads. */
export async function discoverGrokTtsVoices(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fetchImpl?: typeof fetch },
): Promise<GrokTtsVoice[]> {
  const credentials = await resolveGrokAccessToken(env, { fetchImpl: opts?.fetchImpl });
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(GROK_TTS_VOICES_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = scrubSecrets(await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Grok voice discovery failed (HTTP ${res.status}): ${detail}`);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { voices?: unknown }).voices)
      ? (body as { voices: unknown[] }).voices
      : [];
  const voices: GrokTtsVoice[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let id = "";
    let label = "";
    if (typeof item === "string") {
      id = item.trim();
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as unknown as Record<string, unknown>;
      id = typeof rec.voice_id === "string"
        ? rec.voice_id.trim()
        : typeof rec.id === "string"
          ? rec.id.trim()
          : typeof rec.name === "string"
            ? rec.name.trim()
            : "";
      label = typeof rec.label === "string" ? rec.label.trim() : "";
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    voices.push({ id, label: label || id });
  }
  if (voices.length > 0) {
    voices[0]!.default = true;
    writeCachedGrokTtsVoices(env, voices);
  }
  return voices;
}

/** Catalog voices for a directory: cached discovery, else the fallback list. */
export function listGrokTtsVoices(env: NodeJS.ProcessEnv = process.env): GrokTtsVoice[] {
  const cached = readCachedGrokTtsVoices(env);
  return cached && cached.length > 0 ? cached : FALLBACK_GROK_VOICES.map((v) => ({ ...v }));
}

export function findGrokTtsVoice(
  voiceId: string,
  env: NodeJS.ProcessEnv = process.env,
): GrokTtsVoice | null {
  const wanted = String(voiceId ?? "").trim();
  if (!wanted) return null;
  const voices = listGrokTtsVoices(env);
  return voices.find((v) => v.id.toLowerCase() === wanted.toLowerCase()) ?? null;
}

export interface SynthesizeGrokTtsOptions {
  text: string;
  voiceId: string;
  destPath: string;
  speed?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Synthesize `text` to `destPath` (MP3) with the xAI TTS endpoint.
 * Unknown voices fail loudly; there is no silent fallback.
 */
export async function synthesizeGrokTtsToFile(opts: SynthesizeGrokTtsOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const text = String(opts.text ?? "");
  if (!text.trim()) throw new Error("Grok TTS text is empty");
  const env = opts.env ?? process.env;
  const voice = findGrokTtsVoice(opts.voiceId, env);
  if (!voice) {
    const valid = listGrokTtsVoices(env).map((v) => v.id).join(", ");
    throw new Error(`Voice '${opts.voiceId}' is not a Grok TTS voice (available: ${valid})`);
  }
  const speedRaw = typeof opts.speed === "number" && Number.isFinite(opts.speed) ? opts.speed : 1;
  const speed = Math.min(4, Math.max(0.25, speedRaw));
  const credentials = await resolveGrokAccessToken(env, { fetchImpl: opts.fetchImpl, signal: opts.signal });
  opts.signal?.throwIfAborted();
  const doFetch = opts.fetchImpl ?? fetch;
  const destPath = path.resolve(opts.destPath);
  const res = await doFetch(GROK_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg, application/json",
    },
    body: JSON.stringify({
      input: text,
      text,
      voice_id: voice.id,
      voice: voice.id,
      response_format: "mp3",
      speed,
    }),
    redirect: "error",
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const detail = scrubSecrets(await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Grok TTS synthesis failed (HTTP ${res.status}): ${detail}`);
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  let audio: Buffer;
  if (contentType.includes("json")) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const b64 = typeof body?.audio === "string"
      ? body.audio
      : typeof body?.audioContent === "string"
        ? body.audioContent
        : typeof body?.data === "string"
          ? body.data
          : "";
    if (!b64) throw new Error("Grok TTS response missing audio");
    const cleaned = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
    audio = Buffer.from(cleaned, "base64");
  } else {
    audio = Buffer.from(await res.arrayBuffer());
  }
  opts.signal?.throwIfAborted();
  if (audio.length === 0) throw new Error("Grok TTS returned empty audio");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Atomic write: a killed process must never leave a truncated MP3 behind.
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  try {
    opts.signal?.throwIfAborted();
    fs.writeFileSync(tmpPath, audio);
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}
