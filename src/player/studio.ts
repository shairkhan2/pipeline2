/**
 * Creative Studio HTTP API routes (`/api/studio/*`).
 *
 * Provides UI-driven management of:
 *   - LLM & Subscription Providers (`/api/studio/providers*`, `/api/studio/oauth/*`)
 *   - Stage-to-Model Routing Matrix (`/api/studio/stages`)
 *   - Render Worker Nodes (`local`, `docker-sbx`, `ssh` at `/api/studio/nodes*`)
 *   - Merged Studio Catalog (`/api/studio/catalog`)
 *
 * Security:
 *   - All routes require an authenticated session.
 *   - All mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) AND live probe/discovery
 *     routes (`/test`, `/models/discover`, `/action`, `/oauth/*`) require a
 *     privileged admin session (`session.privileged === true`) and `verifyCsrf`.
 *   - Secrets are strictly write-only and never returned in GET responses.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deleteSecret, getSecret, putSecret, resolveOutDir } from "../config/secretStore.js";
import {
  PROVIDER_PRESETS,
  STAGES,
  StudioConfigError,
  StudioProviderConflictError,
  VERTEX_OAUTH_AUTHORIZE_URL,
  VERTEX_OAUTH_DEFAULT_CLIENT_ID,
  VERTEX_OAUTH_DEFAULT_CLIENT_SECRET,
  VERTEX_OAUTH_REDIRECT_URI,
  VERTEX_OAUTH_SCOPES,
  VERTEX_OAUTH_TOKEN_URL,
  createPkceChallenge,
  deleteProvider,
  deleteRenderNodeConfig,
  discoverProviderModels,
  discoverVertexProjects,
  exchangePkceToken,
  getProvider,
  getProviderRecord,
  getProvidersState,
  getStagesConfig,
  getPromptsConfig,
  isVertexOAuthSecret,
  mintVertexAccessToken,
  persistDiscoveredModels,
  putPromptsConfig,
  resetPromptStage,
  getStudioSettings,
  putStudioSettings,
  listProviders,
  listRenderNodesConfig,
  probeProviderInference,
  putStagesConfig,
  readStudioAuditLog,
  resolveVertexOAuthAccessToken,
  resolveVertexOAuthClientId,
  restoreProviderRecord,
  testProviderConnection,
  upsertProvider,
  upsertRenderNodeConfig,
  validateProviderUpsertInput,
  type DiscoveredModel,
  type ProviderUpsertInput,
  type RenderNodeUpsertInput,
} from "../config/studioConfig.js";
import { _resetSnapshotForTests as resetLlmSnapshot } from "../llm/client.js";
import {
  getRegisteredNodes,
  registerNodeForRuntime,
  removeNodeFromRuntime,
  runNodeAction,
  sandboxAuthStart,
  sandboxAuthStatus,
  testNodeConnection,
} from "../workers/nodeRegistry.js";
import { readJsonBody, verifyCsrf, type LaneSession, type SendJson } from "./lanes.js";
import { controlRenderLane, reconcileJobs } from "../intake/intake.js";
import { assertNoSymlinks, getStorageSummary, listTmpTrash, moveToTmpTrash, purgeTmpTrash, restoreFromTmpTrash, type TrashKind } from "./storageTrash.js";
import { deleteChapterVideo, validateChapter, validateSlug } from "./libraryDelete.js";
import { checkNoActivePipelineRun, hasActiveLocalRenderScratch, withExclusiveSeriesLock } from "../locks/seriesLock.js";

export const MAX_STUDIO_BODY_BYTES = 64 * 1024;

/** Anthropic's console callback, required by the Claude subscription OAuth client. */
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

function extractCodeFromInput(codeOrUrl: string): string {
  const trimmed = codeOrUrl.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const codeParam = parsed.searchParams.get("code");
      if (codeParam) return codeParam.trim();
      // A callback URL without `?code=` is never a code: exchanging it would
      // send the whole URL as the authorization code and fail upstream.
      throw new StudioConfigError(
        "Redirect URL does not contain a ?code= parameter. Complete sign-in first or paste the authorization code.",
        400,
        "invalid_oauth_code",
      );
    } catch (err) {
      if (err instanceof StudioConfigError) throw err;
      // Unparsable URL: treat as raw code.
    }
  }
  return trimmed;
}

interface ParsedOAuthTokenBundle {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenUri?: string;
  clientId?: string;
  clientSecret?: string;
  quotaProjectId?: string;
}

/**
 * Parse a pasted JSON OAuth bundle (`access_token`/`refresh_token`/`expires_at`/
 * `token_uri`, or gcloud's `~/.config/gcloud/application_default_credentials.json`
 * `authorized_user` shape, which carries only a refresh_token). Returns `null`
 * when the text is not JSON at all.
 */
function parseOAuthTokenBundle(raw: string): ParsedOAuthTokenBundle | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    throw new StudioConfigError(
      "The pasted token looks like JSON but could not be parsed. Paste the full JSON object.",
      400,
      "invalid_oauth_token",
    );
  }
  const pickString = (...keys: string[]): string => {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const accessToken = pickString("access_token", "accessToken");
  const refreshToken = pickString("refresh_token", "refreshToken");
  if (!accessToken && !refreshToken) {
    throw new StudioConfigError(
      "The pasted JSON bundle has neither an access_token nor a refresh_token.",
      400,
      "invalid_oauth_token",
    );
  }
  const rawExpires = parsed.expires_at ?? parsed.expiresAt ?? parsed.expiry_date;
  const expiresAt = typeof rawExpires === "number" && Number.isFinite(rawExpires)
    ? rawExpires > 10_000_000_000 ? Math.floor(rawExpires / 1000) : Math.floor(rawExpires)
    : undefined;
  const tokenUri = pickString("token_uri", "tokenUri", "token_url", "tokenUrl");
  const clientId = pickString("client_id", "clientId");
  const clientSecret = pickString("client_secret", "clientSecret");
  const quotaProjectId = pickString("quota_project_id", "quotaProjectId", "projectId");
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(tokenUri ? { tokenUri } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(quotaProjectId ? { quotaProjectId } : {}),
  };
}

/* ---------- OAuth helper plumbing ---------- */

/** OpenCode's release User-Agent, required by the OpenAI and xAI device endpoints. */
const OPENCODE_USER_AGENT = "opencode/production/2.0.26/opencode";

const OPENAI_DEVICE_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

type PendingDeviceCode = {
  deviceCode: string;
  clientId: string;
  tokenUrl: string;
  expiresAt: number;
  /** Preset that started the flow, so a custom provider id keeps its preset. */
  presetId?: string;
  /** `openai-device` uses OpenAI's JSON deviceauth protocol; default is RFC 8628. */
  kind?: "openai-device" | "device";
  userCode?: string;
};

/** Device codes started upstream, polled by `/oauth/device-poll`. */
const pendingDeviceCodes = new Map<string, PendingDeviceCode>();

/** True when the provider speaks OpenAI's JSON deviceauth protocol. */
function isOpenAiDeviceFlow(providerId: string, preset?: { id?: string; deviceCodeUrl?: string }): boolean {
  return providerId === "codex-oauth"
    || preset?.id === "codex-oauth"
    || Boolean(preset?.deviceCodeUrl?.includes("auth.openai.com"));
}

/** True when the provider speaks xAI's OpenCode OAuth2 device protocol. */
function isGrokDeviceFlow(providerId: string, deviceCodeUrl: string): boolean {
  return providerId === "grok-subscription" || deviceCodeUrl.includes("auth.x.ai");
}

/**
 * Client id for a device flow: explicit request value, then the preset.
 *
 * `GITHUB_COPILOT_CLIENT_ID` belongs to the Copilot device flow only. It must
 * never override the ChatGPT (`codex-oauth`) or xAI (`grok-subscription`)
 * subscription clients, which register their own client ids.
 */
function resolveDeviceClientId(
  providerId: string,
  body: Record<string, unknown>,
  preset?: { id?: string; clientId?: string; client_id?: string },
): string {
  const explicit = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (explicit) return explicit;
  const presetClientId = (preset?.clientId ?? preset?.client_id ?? "").trim();
  const isCopilot = providerId === "github-copilot" || preset?.id === "github-copilot";
  if (isCopilot) {
    // Copilot's client id comes from the deployment env, never from the preset.
    return (process.env.GITHUB_COPILOT_CLIENT_ID ?? "").trim();
  }
  return presetClientId;
}

/** Fabricated local device code for tests and explicit mock requests only. */
function localDeviceCode(providerId: string) {
  return {
    ok: true,
    providerId,
    deviceCode: `dev_${providerId}_${Date.now()}`,
    userCode: "STDIO-4700",
    verificationUri: "https://github.com/login/device",
    interval: 5,
    expiresIn: 900,
    upstream: false,
  };
}

async function requestDeviceCode(
  deviceCodeUrl: string,
  clientId: string,
  scope = "read:user",
  providerId = "",
): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
} | null> {
  try {
    const grok = isGrokDeviceFlow(providerId, deviceCodeUrl);
    const form = grok
      ? new URLSearchParams({
          client_id: clientId,
          scope: "openid profile email offline_access grok-cli:access api:access",
          referrer: "opencode",
        })
      : new URLSearchParams({ client_id: clientId, scope });
    const res = await fetch(deviceCodeUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OPENCODE_USER_AGENT,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    const userCode = typeof data.user_code === "string" ? data.user_code.trim() : "";
    const verificationUri = typeof data.verification_uri === "string" ? data.verification_uri.trim() : "";
    if (!deviceCode || !userCode || !verificationUri) return null;
    const verificationUriComplete = typeof data.verification_uri_complete === "string"
      ? data.verification_uri_complete.trim()
      : undefined;
    return {
      deviceCode,
      userCode,
      verificationUri,
      ...(verificationUriComplete ? { verificationUriComplete } : {}),
      interval: typeof data.interval === "number" ? data.interval : 5,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
    };
  } catch {
    return null; // offline or blocked: caller reports the upstream failure
  }
}

/** OpenAI ChatGPT device-code start: JSON `{ client_id }` -> `{ device_auth_id, user_code }`. */
async function requestOpenAiDeviceCode(
  clientId: string,
): Promise<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number } | null> {
  try {
    const res = await fetch(OPENAI_DEVICE_USERCODE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": OPENCODE_USER_AGENT,
      },
      body: JSON.stringify({ client_id: clientId || OPENAI_DEVICE_CLIENT_ID }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceCode = typeof data.device_auth_id === "string" ? data.device_auth_id.trim() : "";
    const userCode = typeof data.user_code === "string" ? data.user_code.trim() : "";
    if (!deviceCode || !userCode) return null;
    return {
      deviceCode,
      userCode,
      verificationUri: OPENAI_DEVICE_VERIFICATION_URI,
      interval: Number(data.interval) || 5,
      expiresIn: 900,
    };
  } catch {
    return null;
  }
}

/**
 * OpenAI ChatGPT device-code poll.
 *
 * Pending is `403`/`404`, `deviceauth_authorization_pending` or
 * `authorization_pending`. Approval returns `{ authorization_code, code_verifier }`,
 * which is exchanged for OAuth tokens immediately.
 */
async function pollOpenAiDeviceToken(
  pending: PendingDeviceCode,
): Promise<{ status: "pending" } | { status: "slow_down" } | { status: "failed"; error: string } | {
  status: "authorized";
  tokens: { accessToken: string; refreshToken?: string; expiresIn: number };
  idToken?: string;
} | null> {
  try {
    const res = await fetch(OPENAI_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": OPENCODE_USER_AGENT,
      },
      body: JSON.stringify({ device_auth_id: pending.deviceCode, user_code: pending.userCode }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof data.code === "string" ? data.code : "";
    const error = typeof data.error === "string" ? data.error : "";
    if (error === "slow_down" || code === "slow_down") {
      return { status: "slow_down" };
    }
    if (
      res.status === 403
      || res.status === 404
      || code === "deviceauth_authorization_pending"
      || error === "authorization_pending"
    ) {
      return { status: "pending" };
    }
    if (!res.ok) return { status: "failed", error: error || code || `deviceauth_http_${res.status}` };
    const authorizationCode = typeof data.authorization_code === "string" ? data.authorization_code.trim() : "";
    const codeVerifier = typeof data.code_verifier === "string" ? data.code_verifier.trim() : "";
    if (!authorizationCode) return { status: "pending" };
    const exchange = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": OPENCODE_USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
        client_id: pending.clientId || OPENAI_DEVICE_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = (await exchange.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    if (!exchange.ok || !accessToken) {
      const detail = typeof tokens.error === "string" ? tokens.error : `token_http_${exchange.status}`;
      return { status: "failed", error: detail };
    }
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
    const expiresIn = Number(tokens.expires_in) || 3600;
    const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    return {
      status: "authorized",
      tokens: { accessToken, ...(refreshToken ? { refreshToken } : {}), expiresIn },
      ...(idToken ? { idToken } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort GitHub account lookup for a freshly minted Copilot token.
 * Never throws: a failed lookup just leaves the account fields absent.
 */
async function fetchGitHubAccountInfo(
  accessToken: string,
): Promise<{ accountEmail?: string; accountName?: string; accountPlan?: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "GithubCopilot/1.155.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return {};
    const user = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const login = typeof user.login === "string" ? user.login.trim() : "";
    const email = typeof user.email === "string" && user.email.trim() ? user.email.trim() : login;
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : login;
    return {
      ...(email ? { accountEmail: email } : {}),
      ...(name ? { accountName: name } : {}),
      ...(login ? { accountPlan: "GitHub Copilot" } : {}),
    };
  } catch {
    return {};
  }
}

async function pollDeviceToken(
  tokenUrl: string,
  clientId: string,
  deviceCode: string,
): Promise<{ accessToken?: string; refreshToken?: string; idToken?: string; expiresIn?: number; error?: string } | null> {
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OPENCODE_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
    if (res.ok && accessToken) {
      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token.trim() : "";
      const idToken = typeof data.id_token === "string" ? data.id_token.trim() : "";
      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(idToken ? { idToken } : {}),
        expiresIn: Number(data.expires_in) || 3600,
      };
    }
    return { error: typeof data.error === "string" ? data.error : "device_token_failed" };
  } catch {
    return null; // offline: caller reports a retryable upstream failure
  }
}

/**
 * True when the request or the saved provider selects Google Vertex OAuth.
 * Custom provider ids (for example `my-vertex`) carry the Vertex preset, protocol
 * or auth mode instead of the literal `vertex-ai` id.
 */
function isVertexProvider(providerId: string, body: Record<string, unknown>, outDir: string): boolean {
  if (providerId === "vertex-ai") return true;
  if (body.mode === "vertex-oauth" || body.preset === "vertex-ai" || body.protocol === "vertex-openai") return true;
  const bodyAuth = (body.auth && typeof body.auth === "object" && !Array.isArray(body.auth)
    ? body.auth
    : {}) as Record<string, unknown>;
  if (bodyAuth.mode === "vertex-oauth") return true;
  const saved = getProvider(providerId, outDir);
  return Boolean(
    saved
    && (saved.preset === "vertex-ai"
      || saved.protocol === "vertex-openai"
      || saved.auth?.mode === "vertex-oauth"),
  );
}

/**
 * Exchange an authorization code for a provider token when a PKCE verifier is
 * supplied with `codeOrUrl` / `oauthToken`. Without a verifier the body is
 * returned unchanged so a pasted access token still stores as-is.
 */
function resolveOauthPreset(providerId: string, body: Record<string, unknown>, outDir: string) {
  const saved = getProvider(providerId, outDir);
  const presetKey = String(body.preset ?? saved?.preset ?? providerId).trim();
  return (
    PROVIDER_PRESETS[presetKey]
    ?? PROVIDER_PRESETS[providerId]
    ?? (saved?.protocol === "anthropic-messages" ? PROVIDER_PRESETS["claude-oauth"] : undefined)
    ?? PROVIDER_PRESETS["codex-oauth"]!
  );
}

async function exchangeCodeForProvider(
  body: Record<string, unknown>,
  providerId: string,
  outDir: string,
): Promise<Record<string, unknown>> {
  const verifier = String(body.codeVerifier ?? body.verifier ?? "").trim();
  if (!verifier) return body;
  const rawCode = body.codeOrUrl ?? body.code ?? body.oauthToken ?? body.accessToken;
  if (typeof rawCode !== "string" || !rawCode.trim()) return body;
  const auth = (body.auth && typeof body.auth === "object" && !Array.isArray(body.auth)
    ? body.auth
    : {}) as Record<string, unknown>;
  const isVertex = isVertexProvider(providerId, body, outDir);
  const preset = resolveOauthPreset(providerId, body, outDir);
  const isClaudeOauth = providerId === "claude-oauth" || preset.id === "claude-oauth";
  const tokenUrl = typeof body.tokenUrl === "string" && body.tokenUrl.trim()
    ? body.tokenUrl
    : isVertex
      ? VERTEX_OAUTH_TOKEN_URL
      : preset.tokenUrl;
  const clientId = typeof body.clientId === "string" && body.clientId.trim()
    ? body.clientId
    : isVertex
      ? resolveVertexOAuthClientId()
      : preset.clientId;
  const googleTokenEndpoint = Boolean(
    tokenUrl && (tokenUrl.includes("googleapis.com") || tokenUrl.includes("accounts.google.com")),
  );
  // Mirrors exchangePkceToken's own default: Google's installed-app clients need
  // the shipped secret, so keep it in the persisted bundle instead of dropping it.
  const clientSecret = (isVertex || googleTokenEndpoint)
    && clientId === VERTEX_OAUTH_DEFAULT_CLIENT_ID
    ? VERTEX_OAUTH_DEFAULT_CLIENT_SECRET
    : undefined;
  const exchanged = await exchangePkceToken({
    providerId,
    code: extractCodeFromInput(rawCode),
    codeVerifier: verifier,
    redirectUri: typeof body.redirectUri === "string" && body.redirectUri.trim()
      ? body.redirectUri
      : isVertex
        ? VERTEX_OAUTH_REDIRECT_URI
        : isClaudeOauth
          ? CLAUDE_OAUTH_REDIRECT_URI
          : "http://localhost:1455/auth/callback",
    tokenUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    persistSecret: false,
    outDir,
  });
  // Persist the full bundle whenever the exchange returned any renewable or
  // inspectable credential. `refresh_token` is optional inside the JSON: a
  // provider may return only `id_token` / `expires_at`, and dropping the
  // bundle then would lose `id_token`, `expires_at`, `client_id`,
  // `client_secret` and `token_url`.
  const stored = exchanged.refreshToken || exchanged.idToken || exchanged.expiresAt
    ? JSON.stringify({
        access_token: exchanged.accessToken,
        ...(exchanged.refreshToken ? { refresh_token: exchanged.refreshToken } : {}),
        ...(exchanged.expiresAt ? { expires_at: exchanged.expiresAt } : {}),
        ...(tokenUrl ? { token_url: tokenUrl } : {}),
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(exchanged.idToken ? { id_token: exchanged.idToken } : {}),
      })
    : exchanged.accessToken;
  return {
    ...body,
    oauthToken: stored,
    auth: { ...auth, accessToken: stored },
  };
}

function sendStudioError(res: ServerResponse, sendJson: SendJson, err: unknown): unknown {
  if (err instanceof StudioConfigError) {
    return sendJson(res, err.statusCode || 400, {
      error: err.message,
      code: err.code,
    });
  }
  const status = (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return sendJson(res, status, { error: (err as Error).message || "Request failed" });
  }
  return sendJson(res, 400, { error: (err as Error)?.message || "Invalid studio request" });
}

/**
 * Live `/models` discovery after a provider create/update.
 *
 * Runs when the caller passes `autoDiscoverModels: true`, or when no `models`
 * array was supplied and the caller did not opt out. Any failure (offline, mock,
 * 401, timeout) is silent: the preset/existing model list stays in place.
 */
async function maybeAutoDiscoverModels(
  providerId: string,
  body: Record<string, unknown>,
  outDir: string,
): Promise<{ models: unknown[] | null; error: string | null }> {
  const explicitModels = body.models !== undefined;
  const explicit = body.autoDiscoverModels === true;
  // Default-on only for a create/update that carried credentials; never for a
  // toggle-only patch, and never when the caller supplied its own model list.
  const requested = explicit
    || (!explicitModels && body.autoDiscoverModels !== false && hasProviderCredentials(body));
  if (!requested || !providerId) return { models: null, error: null };
  try {
    const models = await discoverProviderModels(providerId, { outDir, timeoutMs: 5000 });
    if (models.length === 0) return { models: null, error: null };
    return { models, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { models: null, error: msg.slice(0, 240) };
  }
}

/** True when the request body carries provider credentials to store. */
function hasProviderCredentials(body: Record<string, unknown>): boolean {
  const auth = (body.auth && typeof body.auth === "object" && !Array.isArray(body.auth)
    ? body.auth
    : {}) as Record<string, unknown>;
  const keys = ["apiKey", "secret", "oauthToken", "serviceAccountJson"] as const;
  if (keys.some((k) => typeof body[k] === "string" && String(body[k]).trim())) return true;
  return ["apiKey", "secret", "token", "accessToken", "serviceAccountJson"]
    .some((k) => typeof auth[k] === "string" && String(auth[k]).trim());
}

/**
 * Live verification for `verifyBeforeSave: true`.
 *
 * Probes the candidate provider configuration in memory (`persist: false`) before
 * any secret or provider record is written, so a failed verification never mutates
 * `providers.json`, `secrets.json`, `stages.json`, or `studio-audit.log`.
 */
async function verifyProviderBeforeSave(
  target: string | ProviderUpsertInput,
  outDir: string,
  extraOpts?: { ignoreStoredSecret?: boolean },
): Promise<{ failure: string | null; models: DiscoveredModel[] | null }> {
  const probeOpts = {
    outDir,
    timeoutMs: 8000,
    persist: false,
    ...(extraOpts?.ignoreStoredSecret ? { ignoreStoredSecret: true } : {}),
  };
  try {
    const models = await discoverProviderModels(target, probeOpts);
    if (models.length > 0) return { failure: null, models };
  } catch {
    // `/models` may be unsupported by this endpoint: fall back to a connection probe.
  }
  try {
    // A minimal inference turn proves the credential even when the endpoint has
    // no `GET /models` (Anthropic messages, custom gateways that 404 there).
    const probe = await probeProviderInference(target, probeOpts);
    if (probe.ok) return { failure: null, models: null };
    return { failure: probe.error || `HTTP ${probe.status}`, models: null };
  } catch (err) {
    return {
      failure: (err instanceof Error ? err.message : String(err)).slice(0, 240),
      models: null,
    };
  }
}

/**
 * Auto-detect the Vertex `projectId` from the Google Cloud Resource Manager API.
 *
 * Runs only when the provider is Vertex and the caller supplied no `projectId`.
 * Stores the first ACTIVE project on `auth.projectId` and returns the list so a
 * UI can offer a picker. Any discovery failure (offline, missing scope) leaves
 * the provider untouched: the login itself must never depend on it.
 */
async function maybeAutoDetectVertexProject(
  providerId: string,
  body: Record<string, unknown>,
  outDir: string,
  accessToken?: string,
): Promise<{ projects: Array<{ projectId: string; name: string }>; projectId?: string }> {
  const auth = (body.auth && typeof body.auth === "object" && !Array.isArray(body.auth)
    ? body.auth
    : {}) as Record<string, unknown>;
  const saved = getProvider(providerId, outDir);
  // A project id supplied by the request wins, then a project id already stored on
  // the provider (a service account key's own `project_id`, or a previous pick).
  // Only a provider with no project id at all is auto-detected.
  const supplied = String(body.projectId ?? auth.projectId ?? saved?.auth?.projectId ?? "").trim();
  let token = String(accessToken ?? "").trim();
  if (!token) {
    const rawSecret = getSecret(saved?.auth.secretRef || `provider:${providerId}`, outDir);
    if (!rawSecret) return { projects: [], projectId: supplied || undefined };
    try {
      token = await vertexAccessTokenFromSecret(rawSecret);
    } catch {
      return { projects: [], projectId: supplied || undefined };
    }
  }
  let projects: Array<{ projectId: string; name: string }> = [];
  try {
    projects = await discoverVertexProjects(token);
  } catch {
    return { projects: [], projectId: supplied || undefined };
  }
  if (supplied) {
    persistVertexProjects(providerId, saved, supplied, projects, outDir);
    return { projects, projectId: supplied };
  }
  const detected = projects[0]?.projectId;
  if (!detected) return { projects };
  persistVertexProjects(providerId, saved, detected, projects, outDir);
  return { projects, projectId: detected };
}

/**
 * Store the discovered project list on `provider.auth.projects` so a later
 * `getProvider` / `listProviders` serves the picker without another discovery
 * round trip. Skips the write when nothing changed.
 */
function persistVertexProjects(
  providerId: string,
  saved: ReturnType<typeof getProvider>,
  projectId: string,
  projects: Array<{ projectId: string; name: string }>,
  outDir: string,
): void {
  if (!saved || projects.length === 0) return;
  const unchanged = saved.auth?.projectId === projectId
    && JSON.stringify(saved.auth?.projects ?? []) === JSON.stringify(projects);
  if (unchanged) return;
  upsertProvider(
    {
      id: providerId,
      preset: saved.preset ?? "vertex-ai",
      auth: { ...saved.auth, projectId, projects },
    },
    outDir,
  );
}

/** Access token from a stored Vertex secret blob (service account or OAuth). */
async function vertexAccessTokenFromSecret(rawSecret: string): Promise<string> {
  if (isVertexOAuthSecret(rawSecret)) {
    const resolved = await resolveVertexOAuthAccessToken(rawSecret, {
      clientId: resolveVertexOAuthClientId(),
    });
    return resolved.accessToken;
  }
  const minted = await mintVertexAccessToken(rawSecret);
  return minted.accessToken;
}

export async function handleStudioRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _u: URL,
  session: LaneSession,
  sendJson: SendJson,
): Promise<unknown> {
  const method = req.method || "GET";
  const isRead = method === "GET" || method === "HEAD";
  const outDir = resolveOutDir();

  // Require privileged admin account for any mutation or live test/discovery/oauth call.
  if (!isRead && !session.privileged) {
    req.resume();
    return sendJson(res, 403, {
      error: "Temporary viewing accounts cannot modify Creative Studio settings or run live probes.",
    });
  }

  let body: Record<string, unknown> = {};
  if (!isRead) {
    const declaredLen = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_STUDIO_BODY_BYTES) {
      req.resume();
      return sendJson(res, 413, { error: "JSON request body too large" });
    }
    try {
      const parsed = await readJsonBody(req, MAX_STUDIO_BODY_BYTES);
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          return sendJson(res, 400, { error: "JSON object body required" });
        }
        body = parsed as Record<string, unknown>;
      }
    } catch (err: any) {
      return sendJson(res, err.statusCode || 400, { error: err.message || "Bad request body" });
    }
    const csrf = verifyCsrf(req, session, typeof body.csrfToken === "string" ? body.csrfToken : "");
    if (!csrf.ok) {
      return sendJson(res, 403, { error: csrf.error });
    }
  }

  try {
    if (pathname === "/api/studio/prompts") {
      if (isRead) return sendJson(res, 200, getPromptsConfig(outDir));
      if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, putPromptsConfig({ ...body, expectedRevision: (body.expectedRevision ?? body.revision) as number | undefined, updatedBy: session.user }, outDir));
    }
    if (pathname === "/api/studio/prompts/reset") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, resetPromptStage(String(body.stage || "all") as Parameters<typeof resetPromptStage>[0], { outDir, updatedBy: session.user }));
    }
    if (pathname === "/api/studio/settings") {
      if (isRead) return sendJson(res, 200, getStudioSettings(outDir));
      if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, putStudioSettings({ ...body, expectedRevision: (body.expectedRevision ?? body.revision) as number | undefined, updatedBy: session.user }, outDir));
    }
    if (pathname === "/api/studio/storage") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, getStorageSummary({ outDir }));
    }
    if (pathname === "/api/studio/storage/trash") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { trash: listTmpTrash() });
    }
    if (pathname === "/api/studio/storage/delete") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, await deleteStorageArtifact(body));
    }
    if (pathname === "/api/studio/storage/restore") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, restoreFromTmpTrash(String(body.trashId || body.id || "")));
    }
    if (pathname === "/api/studio/storage/purge") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const id = body.trashId ?? body.id;
      if (id !== undefined && typeof id !== "string") return sendJson(res, 400, { error: "trashId must be a string" });
      return sendJson(res, 200, purgeTmpTrash(id as string | undefined));
    }
    if (pathname === "/api/studio/lanes/control") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      if (!["pause", "resume", "stop"].includes(String(body.action))) return sendJson(res, 400, { error: "action must be pause, resume or stop" });
      // Retired: a lane is a placement hint, not a switchboard. This route never
      // signals or mutates a job; run-scoped controls replace it.
      const result = controlRenderLane(String(body.laneId || ""), body.action as "pause" | "resume" | "stop", undefined, outDir);
      return sendJson(res, Number(result.statusCode) || 409, result);
    }
    /* ---------- GET /api/studio/catalog ---------- */
    if (pathname === "/api/studio/catalog") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      const providersState = getProvidersState(outDir);
      const stagesState = getStagesConfig(outDir);
      const configuredNodes = listRenderNodesConfig(outDir);
      const runtimeNodes = getRegisteredNodes(outDir);
      return sendJson(res, 200, {
        presets: PROVIDER_PRESETS,
        providers: providersState.providers,
        providersRevision: providersState.revision,
        stages: stagesState,
        nodes: configuredNodes,
        runtimeNodes,
        stageList: STAGES,
        prompts: getPromptsConfig(outDir),
        settings: getStudioSettings(outDir),
      });
    }

    /* ---------- GET /api/studio/vertex/projects ---------- */
    if (pathname === "/api/studio/vertex/projects") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      const providerId = String(_u.searchParams.get("providerId") ?? "vertex-ai").trim() || "vertex-ai";
      const provider = getProvider(providerId, outDir);
      if (!provider) {
        return sendJson(res, 404, { error: `Provider '${providerId}' not found` });
      }
      const rawSecret = getSecret(provider.auth.secretRef || `provider:${providerId}`, outDir);
      if (!rawSecret) {
        return sendJson(res, 400, { error: `Provider '${providerId}' has no credential configured` });
      }
      let accessToken: string;
      try {
        accessToken = await vertexAccessTokenFromSecret(rawSecret);
      } catch (err) {
        return sendJson(res, 502, { error: `Vertex token resolution failed: ${(err as Error).message}` });
      }
      const projects = await discoverVertexProjects(accessToken);
      return sendJson(res, 200, {
        ok: true,
        providerId,
        projectId: provider.auth.projectId ?? projects[0]?.projectId ?? null,
        projects,
      });
    }

    /* ---------- GET / POST /api/studio/providers ---------- */
    if (pathname === "/api/studio/providers") {
      if (isRead) {
        return sendJson(res, 200, getProvidersState(outDir));
      }
      if (method === "POST") {
        const createOnly = body.createOnly === true;
        const initialId = String(body.id ?? body.preset ?? "").trim();
        if (createOnly && initialId && getProvider(initialId, outDir)) {
          throw new StudioProviderConflictError(initialId);
        }
        const input = await exchangeCodeForProvider(body, initialId, outDir);
        const providerId = String((input as Record<string, unknown>).id ?? "").trim();
        if (createOnly && providerId && getProvider(providerId, outDir)) {
          throw new StudioProviderConflictError(providerId);
        }
        const upsertInput: ProviderUpsertInput = {
          ...(input as unknown as ProviderUpsertInput),
          ...(createOnly ? { createOnly: true } : {}),
          updatedBy: session.user,
        };
        const verifyBeforeSave = body.verifyBeforeSave === true;
        let preDiscoveredModels: DiscoveredModel[] | null = null;
        if (verifyBeforeSave) {
          if (providerId) {
            const presetKey = String(
              (input as Record<string, unknown>).preset ?? providerId,
            ).trim();
            const authMode = String(
              ((input as Record<string, unknown>).auth as Record<string, unknown> | undefined)?.mode
                ?? PROVIDER_PRESETS[presetKey]?.authMode
                ?? PROVIDER_PRESETS[providerId]?.authMode
                ?? "bearer",
            );
            const hasSecretInput = hasProviderCredentials(input as Record<string, unknown>)
              || (!createOnly && Boolean(getSecret(`provider:${providerId}`, outDir)));
            if (authMode === "bearer" && !hasSecretInput) {
              return sendJson(res, 400, { error: "API key is required to verify and add this provider." });
            }
          }
          validateProviderUpsertInput(upsertInput, outDir);
          const verification = await verifyProviderBeforeSave(upsertInput, outDir, {
            ignoreStoredSecret: createOnly,
          });
          if (verification.failure) {
            resetLlmSnapshot();
            return sendJson(res, 400, { error: `Provider verification failed: ${verification.failure}` });
          }
          preDiscoveredModels = verification.models;
        }
        let provider = upsertProvider(upsertInput, outDir);
        if (preDiscoveredModels && preDiscoveredModels.length > 0 && body.models === undefined) {
          persistDiscoveredModels(provider.id, preDiscoveredModels, outDir);
          provider = getProvider(provider.id, outDir) ?? provider;
        }
        const discovered = verifyBeforeSave
          ? { models: preDiscoveredModels, error: null }
          : await maybeAutoDiscoverModels(provider.id, body, outDir);
        if (!verifyBeforeSave && discovered.models) {
          provider = getProvider(provider.id, outDir) ?? provider;
        }
        const vertex = isVertexProvider(provider.id, body, outDir)
          ? await maybeAutoDetectVertexProject(provider.id, body, outDir)
          : null;
        if (vertex?.projectId) provider = getProvider(provider.id, outDir) ?? provider;
        resetLlmSnapshot();
        return sendJson(res, 201, {
          ok: true,
          provider,
          providers: listProviders(outDir),
          ...(discovered.error ? { discoveryError: discovered.error } : {}),
          ...(vertex ? { projects: vertex.projects } : {}),
          ...(vertex?.projectId ? { projectId: vertex.projectId } : {}),
        });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    /* ---------- /api/studio/providers/:id[/test | /models/discover] ---------- */
    if (pathname.startsWith("/api/studio/providers/")) {
      const rest = pathname.slice("/api/studio/providers/".length);
      const parts = rest.split("/").filter(Boolean);
      const providerId = decodeURIComponent(parts[0] || "");
      if (!providerId) {
        return sendJson(res, 400, { error: "Provider ID required" });
      }

      if (parts.length === 1) {
        if (isRead) {
          const found = getProvider(providerId, outDir);
          if (!found) return sendJson(res, 404, { error: `Provider '${providerId}' not found` });
          return sendJson(res, 200, { provider: found });
        }
        if (method === "PATCH" || method === "PUT") {
          const existing = getProvider(providerId, outDir);
          if (!existing && method === "PATCH") {
            return sendJson(res, 404, { error: `Provider '${providerId}' not found` });
          }
          const revokeSecret = body.revokeSecret === true;
          const verifyBeforeSave = body.verifyBeforeSave === true;
          validateProviderUpsertInput(
            {
              ...(body as unknown as ProviderUpsertInput),
              id: providerId,
              updatedBy: session.user,
            },
            outDir,
          );
          const input = await exchangeCodeForProvider(body, providerId, outDir);
          const upsertInput: ProviderUpsertInput = {
            ...(input as unknown as ProviderUpsertInput),
            id: providerId,
            updatedBy: session.user,
          };
          let preDiscoveredModels: DiscoveredModel[] | null = null;
          if (verifyBeforeSave) {
            const presetKey = String(
              (input as Record<string, unknown>).preset ?? existing?.preset ?? providerId,
            ).trim();
            const authMode = String(
              ((input as Record<string, unknown>).auth as Record<string, unknown> | undefined)?.mode
                ?? existing?.auth?.mode
                ?? PROVIDER_PRESETS[presetKey]?.authMode
                ?? PROVIDER_PRESETS[providerId]?.authMode
                ?? "bearer",
            );
            const existingSecretRef = existing?.auth?.secretRef || `provider:${providerId}`;
            const hasSecretInput = hasProviderCredentials(input as Record<string, unknown>)
              || (!revokeSecret && Boolean(getSecret(existingSecretRef, outDir)));
            if (authMode === "bearer" && !hasSecretInput) {
              return sendJson(res, 400, { error: "API key is required to verify and add this provider." });
            }
            validateProviderUpsertInput(upsertInput, outDir);
            const verification = await verifyProviderBeforeSave(upsertInput, outDir, {
              ignoreStoredSecret: revokeSecret,
            });
            if (verification.failure) {
              resetLlmSnapshot();
              return sendJson(res, 400, { error: `Provider verification failed: ${verification.failure}` });
            }
            preDiscoveredModels = verification.models;
          }
          validateProviderUpsertInput(upsertInput, outDir);
          if (revokeSecret) {
            const secretRef = existing?.auth?.secretRef || `provider:${providerId}`;
            deleteSecret(secretRef, outDir);
          }
          let updated = upsertProvider(upsertInput, outDir);
          if (preDiscoveredModels && preDiscoveredModels.length > 0 && body.models === undefined) {
            persistDiscoveredModels(updated.id, preDiscoveredModels, outDir);
            updated = getProvider(updated.id, outDir) ?? updated;
          }
          const discovered = verifyBeforeSave
            ? { models: preDiscoveredModels, error: null }
            : await maybeAutoDiscoverModels(updated.id, body, outDir);
          if (!verifyBeforeSave && discovered.models) {
            updated = getProvider(updated.id, outDir) ?? updated;
          }
          const vertex = isVertexProvider(updated.id, body, outDir)
            ? await maybeAutoDetectVertexProject(updated.id, body, outDir)
            : null;
          if (vertex?.projectId) updated = getProvider(updated.id, outDir) ?? updated;
          resetLlmSnapshot();
          return sendJson(res, 200, {
            ok: true,
            provider: updated,
            providers: listProviders(outDir),
            ...(discovered.error ? { discoveryError: discovered.error } : {}),
            ...(vertex ? { projects: vertex.projects } : {}),
            ...(vertex?.projectId ? { projectId: vertex.projectId } : {}),
          });
        }
        if (method === "DELETE") {
          if (_u.searchParams.get("revokeSecretOnly") === "1") {
            const existing = getProvider(providerId, outDir);
            if (!existing) return sendJson(res, 404, { error: `Provider '${providerId}' not found` });
            deleteSecret(existing.auth.secretRef || `provider:${providerId}`, outDir);
            resetLlmSnapshot();
            return sendJson(res, 200, { ok: true, provider: getProvider(providerId, outDir) });
          }
          const removed = deleteProvider(providerId, { outDir, updatedBy: session.user });
          if (!removed) return sendJson(res, 404, { error: `Provider '${providerId}' not found` });
          resetLlmSnapshot();
          return sendJson(res, 200, { ok: true, providers: listProviders(outDir) });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      if (parts.length === 2 && parts[1] === "test") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const probeResult = await testProviderConnection(providerId, outDir);
        return sendJson(res, 200, {
          ...probeResult,
          modelsCount: probeResult.models.length,
          provider: getProvider(providerId, outDir),
        });
      }

      if (
        (parts.length === 2 && parts[1] === "discover") ||
        (parts.length === 3 && parts[1] === "models" && parts[2] === "discover")
      ) {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const persist = body.save !== false;
        const discovered = await discoverProviderModels(providerId, { outDir, persist });
        if (persist) resetLlmSnapshot();
        return sendJson(res, 200, {
          ok: true,
          models: discovered,
          provider: getProvider(providerId, outDir),
        });
      }
    }

    /* ---------- OAuth PKCE & Device Code flows ---------- */
    if (pathname === "/api/studio/oauth/pkce-start") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const providerId = String(body.providerId ?? body.preset ?? "codex-oauth").trim();
      const vertexMode = isVertexProvider(providerId, body, outDir);
      const preset = resolveOauthPreset(providerId, body, outDir);
      const isClaudeOauth = providerId === "claude-oauth" || preset.id === "claude-oauth";
      const redirectUri = typeof body.redirectUri === "string" && body.redirectUri.trim()
        ? body.redirectUri.trim()
        : vertexMode
          ? VERTEX_OAUTH_REDIRECT_URI
          : isClaudeOauth
            ? CLAUDE_OAUTH_REDIRECT_URI
            : "http://localhost:1455/auth/callback";
      const challenge = createPkceChallenge({
        authorizeUrl: typeof body.authorizeUrl === "string" && body.authorizeUrl.trim()
          ? body.authorizeUrl
          : vertexMode
            ? VERTEX_OAUTH_AUTHORIZE_URL
            : preset.authorizeUrl,
        clientId: typeof body.clientId === "string" && body.clientId.trim()
          ? body.clientId
          : vertexMode
            ? resolveVertexOAuthClientId()
            : preset.clientId,
        redirectUri,
        scopes: Array.isArray(body.scopes) && body.scopes.length
          ? (body.scopes as string[])
          : vertexMode
            ? [...VERTEX_OAUTH_SCOPES]
            : preset.scopes,
      });
      return sendJson(res, 200, {
        ok: true,
        providerId,
        redirectUri,
        ...challenge,
      });
    }

    if (pathname === "/api/studio/oauth/pkce-exchange") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const providerId = String(body.providerId ?? "codex-oauth").trim();
      const rawCodeOrUrl = String(body.codeOrUrl ?? body.code ?? "").trim();
      const directToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      const codeVerifier = String(body.codeVerifier ?? body.verifier ?? "").trim();
      const isVertex = isVertexProvider(providerId, body, outDir);
      const preset = resolveOauthPreset(providerId, body, outDir);
      const isClaudeOauth = providerId === "claude-oauth" || preset.id === "claude-oauth";
      const defaultRedirectUri = isVertex
        ? VERTEX_OAUTH_REDIRECT_URI
        : isClaudeOauth
          ? CLAUDE_OAUTH_REDIRECT_URI
          : "http://localhost:1455/auth/callback";
      // `claude setup-token` emits a long-lived token (`sk-ant-oat...`) instead of a
      // code; accept it directly so subscription login needs no extra config.
      const setupToken = /^sk-ant-(oat|sid)/.test(rawCodeOrUrl) ? rawCodeOrUrl : "";
      // A pasted JSON OAuth bundle (Google's `authorized_user` file, gcloud ADC,
      // an exported token doc) is a token, never an authorization code: parse it
      // so the raw JSON never lands inside `access_token`.
      const rawDirect = directToken || (!codeVerifier ? rawCodeOrUrl : "");
      const tokenBundle = rawDirect.startsWith("{") ? parseOAuthTokenBundle(rawDirect) : null;
      const bodyRefreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";

      // A verifier plus a code means a real PKCE exchange, even when a token is also present.
      if (tokenBundle || (directToken && !codeVerifier) || setupToken) {
        const ref = `provider:${providerId}`;
        const directAccessToken = tokenBundle?.accessToken ?? (setupToken || directToken);
        const refreshToken = tokenBundle?.refreshToken ?? bodyRefreshToken;
        const expiresAt = tokenBundle?.expiresAt ?? Math.floor(Date.now() / 1000) + 3600 * 24 * 30;
        const storedSecret = {
          ...(directAccessToken ? { access_token: directAccessToken } : {}),
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          expires_at: expiresAt,
          ...(tokenBundle?.tokenUri ? { token_uri: tokenBundle.tokenUri } : {}),
          ...(tokenBundle?.clientId ? { client_id: tokenBundle.clientId } : {}),
          ...(tokenBundle?.clientSecret ? { client_secret: tokenBundle.clientSecret } : {}),
        };
        putSecret(ref, JSON.stringify(storedSecret), outDir);
        const existing = getProvider(providerId, outDir);
        const provider = existing ?? upsertProvider({ id: providerId, preset: preset.id, updatedBy: session.user }, outDir);
        // OAuth completion only discovers live models when explicitly requested:
        // the login itself must never depend on a second network round trip.
        if (body.autoDiscoverModels === true) {
          await maybeAutoDiscoverModels(provider.id, body, outDir);
        }
        // A refresh-only bundle (gcloud `authorized_user` JSON) carries no access
        // token: mint one now so project discovery can authenticate.
        let vertexAccessToken = directAccessToken;
        if (isVertex && !vertexAccessToken && refreshToken) {
          try {
            const resolved = await resolveVertexOAuthAccessToken(JSON.stringify(storedSecret), {
              clientId: tokenBundle?.clientId,
              clientSecret: tokenBundle?.clientSecret,
              tokenUrl: tokenBundle?.tokenUri,
            });
            vertexAccessToken = resolved.accessToken;
            // Keep the minted token so the next call skips the refresh round trip.
            putSecret(
              ref,
              JSON.stringify({
                ...storedSecret,
                access_token: resolved.accessToken,
                ...(resolved.expiresAt ? { expires_at: resolved.expiresAt } : {}),
              }),
              outDir,
            );
          } catch {
            // Keep the login usable; the first real call refreshes again.
          }
        }
        if (isVertex && tokenBundle?.quotaProjectId) {
          upsertProvider(
            { id: provider.id, preset: provider.preset ?? "vertex-ai", auth: { projectId: tokenBundle.quotaProjectId } },
            outDir,
          );
        }
        const vertex = isVertex
          ? await maybeAutoDetectVertexProject(
              provider.id,
              body,
              outDir,
              vertexAccessToken,
            )
          : null;
        resetLlmSnapshot();
        return sendJson(res, 200, {
          ok: true,
          provider: getProvider(provider.id, outDir),
          ...(vertex ? { projects: vertex.projects } : {}),
          ...(vertex?.projectId ? { projectId: vertex.projectId } : {}),
        });
      }

      const code = extractCodeFromInput(rawCodeOrUrl) || directToken;
      const exchanged = await exchangePkceToken({
        providerId,
        code,
        codeVerifier,
        redirectUri: typeof body.redirectUri === "string" && body.redirectUri.trim()
          ? body.redirectUri
          : defaultRedirectUri,
        tokenUrl: typeof body.tokenUrl === "string" && body.tokenUrl.trim()
          ? body.tokenUrl
          : isVertex
            ? VERTEX_OAUTH_TOKEN_URL
            : preset.tokenUrl,
        clientId: typeof body.clientId === "string" && body.clientId.trim()
          ? body.clientId
          : isVertex
            ? resolveVertexOAuthClientId()
            : preset.clientId,
        ...(typeof body.clientSecret === "string" && body.clientSecret.trim()
          ? { clientSecret: body.clientSecret.trim() }
          : typeof body.client_secret === "string" && body.client_secret.trim()
            ? { clientSecret: body.client_secret.trim() }
            : isVertex
              && resolveVertexOAuthClientId(
                typeof body.clientId === "string" ? body.clientId : undefined,
              ) === VERTEX_OAUTH_DEFAULT_CLIENT_ID
              ? { clientSecret: VERTEX_OAUTH_DEFAULT_CLIENT_SECRET }
              : {}),
        outDir,
      });
      const existing = getProvider(providerId, outDir);
      if (!existing) {
        upsertProvider({ id: providerId, preset: preset.id, updatedBy: session.user }, outDir);
      }
      if (body.autoDiscoverModels === true) {
        await maybeAutoDiscoverModels(providerId, body, outDir);
      }
      const vertex = isVertex
        ? await maybeAutoDetectVertexProject(providerId, body, outDir, exchanged.accessToken)
        : null;
      resetLlmSnapshot();
      return sendJson(res, 200, {
        ok: true,
        expiresAt: exchanged.expiresAt,
        provider: getProvider(providerId, outDir),
        ...(vertex ? { projects: vertex.projects } : {}),
        ...(vertex?.projectId ? { projectId: vertex.projectId } : {}),
      });
    }

    if (pathname === "/api/studio/oauth/device-start") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const providerId = String(body.providerId ?? "github-copilot").trim();
      // A custom provider id may carry a subscription preset (`my-codex` with
      // `preset: "codex-oauth"`); resolve the preset, not just the literal id.
      const saved = getProvider(providerId, outDir);
      const presetKey = String(body.preset ?? saved?.preset ?? providerId).trim();
      const preset = PROVIDER_PRESETS[presetKey] ?? PROVIDER_PRESETS[providerId];
      const presetId = preset?.id || providerId;
      const clientId = resolveDeviceClientId(providerId, body, preset);
      pendingDeviceCodes.delete(providerId);
      // Only an explicit mock request may fabricate a local code; a real deployment must
      // report the missing configuration instead of handing out an unusable login.
      const mockAllowed = body.allowMockDeviceFlow === true;
      if (isOpenAiDeviceFlow(providerId, preset)) {
        const upstream = await requestOpenAiDeviceCode(clientId);
        if (upstream) {
          pendingDeviceCodes.set(providerId, {
            deviceCode: upstream.deviceCode,
            userCode: upstream.userCode,
            clientId: clientId || OPENAI_DEVICE_CLIENT_ID,
            tokenUrl: OPENAI_OAUTH_TOKEN_URL,
            expiresAt: Date.now() + 900_000,
            presetId,
            kind: "openai-device",
          });
          return sendJson(res, 200, {
            ok: true,
            providerId,
            deviceCode: upstream.deviceCode,
            userCode: upstream.userCode,
            verificationUri: upstream.verificationUri,
            interval: upstream.interval,
            expiresIn: 900,
            upstream: true,
          });
        }
        if (mockAllowed) return sendJson(res, 200, localDeviceCode(providerId));
        return sendJson(res, 502, { error: "Device login could not start upstream; retry or paste an access token." });
      }
      if (!clientId || !preset?.deviceCodeUrl) {
        if (mockAllowed) return sendJson(res, 200, localDeviceCode(providerId));
        return sendJson(res, 400, { error: "Device login is not configured; set a client ID or paste an access token." });
      }
      if (clientId && preset?.deviceCodeUrl) {
        const upstream = await requestDeviceCode(preset.deviceCodeUrl, clientId, "read:user", providerId);
        if (upstream) {
          pendingDeviceCodes.set(providerId, {
            deviceCode: upstream.deviceCode,
            clientId,
            tokenUrl: preset.tokenUrl || "https://github.com/login/oauth/access_token",
            expiresAt: Date.now() + upstream.expiresIn * 1000,
            presetId,
            kind: "device",
          });
          return sendJson(res, 200, {
            ok: true,
            providerId,
            deviceCode: upstream.deviceCode,
            userCode: upstream.userCode,
            verificationUri: upstream.verificationUri,
            ...(upstream.verificationUriComplete
              ? { verificationUriComplete: upstream.verificationUriComplete }
              : {}),
            interval: upstream.interval,
            expiresIn: upstream.expiresIn,
            upstream: true,
          });
        }
      }
      // Offline or unconfigured: report the failure instead of returning unusable local codes.
      if (mockAllowed) return sendJson(res, 200, localDeviceCode(providerId));
      return sendJson(res, 502, { error: "Device login could not start upstream; retry or paste an access token." });
    }

    if (pathname === "/api/studio/oauth/device-poll") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const providerId = String(body.providerId ?? "github-copilot").trim();
      const saved = getProvider(providerId, outDir);
      const presetKey = String(body.preset ?? saved?.preset ?? providerId).trim();
      const preset = PROVIDER_PRESETS[presetKey] ?? PROVIDER_PRESETS[providerId];
      const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      if (token) {
        pendingDeviceCodes.delete(providerId);
        putSecret(`provider:${providerId}`, token, outDir);
        const existing = getProvider(providerId, outDir);
        if (!existing) {
          upsertProvider({ id: providerId, preset: preset?.id || presetKey, updatedBy: session.user }, outDir);
        }
        if (body.autoDiscoverModels === true) {
          await maybeAutoDiscoverModels(providerId, body, outDir);
        }
        resetLlmSnapshot();
        return sendJson(res, 200, {
          ok: true,
          status: "authorized",
          provider: getProvider(providerId, outDir),
        });
      }
      const pending = pendingDeviceCodes.get(providerId);
      if (!pending) return sendJson(res, 400, { error: "Start device login before polling." });
      if (pending.expiresAt <= Date.now()) {
        pendingDeviceCodes.delete(providerId);
        return sendJson(res, 410, { error: "Device login expired; start device login again." });
      }
      if (pending.kind === "openai-device") {
        const polled = await pollOpenAiDeviceToken(pending);
        if (!polled) return sendJson(res, 502, { error: "Device login polling failed upstream; retry." });
        if (polled.status === "pending") {
          return sendJson(res, 200, { ok: true, providerId, status: "pending" });
        }
        if (polled.status === "slow_down") {
          return sendJson(res, 200, {
            ok: true,
            providerId,
            status: "pending",
            slowDown: true,
            interval: 10,
          });
        }
        if (polled.status === "failed") {
          pendingDeviceCodes.delete(providerId);
          return sendJson(res, 400, { ok: false, status: "failed", error: polled.error });
        }
        pendingDeviceCodes.delete(providerId);
        const expiresAt = Math.floor(Date.now() / 1000) + polled.tokens.expiresIn;
        putSecret(
          `provider:${providerId}`,
          JSON.stringify({
            access_token: polled.tokens.accessToken,
            ...(polled.tokens.refreshToken ? { refresh_token: polled.tokens.refreshToken } : {}),
            ...(polled.idToken ? { id_token: polled.idToken } : {}),
            expires_at: expiresAt,
            token_url: OPENAI_OAUTH_TOKEN_URL,
            client_id: pending.clientId,
          }),
          outDir,
        );
        if (!getProvider(providerId, outDir)) {
          upsertProvider(
            { id: providerId, preset: pending.presetId || preset?.id || presetKey, updatedBy: session.user },
            outDir,
          );
        }
        if (body.autoDiscoverModels === true) {
          await maybeAutoDiscoverModels(providerId, body, outDir);
        }
        resetLlmSnapshot();
        return sendJson(res, 200, {
          ok: true,
          status: "authorized",
          provider: getProvider(providerId, outDir),
        });
      }
      if (pending) {
        const polled = await pollDeviceToken(pending.tokenUrl, pending.clientId, pending.deviceCode);
        if (!polled) return sendJson(res, 502, { error: "Device login polling failed upstream; retry." });
        if (polled?.accessToken) {
          pendingDeviceCodes.delete(providerId);
          // A refresh token means the flow issues OAuth tokens: keep the full JSON
          // secret so the LLM client can refresh it. Plain device flows (GitHub
          // Copilot) still store the raw token, with the account lookup merged in.
          const isCopilot = providerId === "github-copilot"
            || pending.presetId === "github-copilot"
            || pending.tokenUrl.includes("github.com");
          const accountInfo = isCopilot
            ? await fetchGitHubAccountInfo(polled.accessToken)
            : {};
          const storedSecret = polled.refreshToken
            ? JSON.stringify({
                access_token: polled.accessToken,
                refresh_token: polled.refreshToken,
                ...(polled.idToken ? { id_token: polled.idToken } : {}),
                expires_at: Math.floor(Date.now() / 1000) + (polled.expiresIn ?? 3600),
                token_url: pending.tokenUrl,
                client_id: pending.clientId,
                ...(accountInfo.accountEmail ? { account_email: accountInfo.accountEmail } : {}),
                ...(accountInfo.accountName ? { account_name: accountInfo.accountName } : {}),
                ...(accountInfo.accountPlan ? { account_plan: accountInfo.accountPlan } : {}),
              })
            : Object.keys(accountInfo).length > 0
              ? JSON.stringify({
                  access_token: polled.accessToken,
                  ...(polled.idToken ? { id_token: polled.idToken } : {}),
                  ...(accountInfo.accountEmail ? { account_email: accountInfo.accountEmail } : {}),
                  ...(accountInfo.accountName ? { account_name: accountInfo.accountName } : {}),
                  ...(accountInfo.accountPlan ? { account_plan: accountInfo.accountPlan } : {}),
                })
              : polled.accessToken;
          putSecret(`provider:${providerId}`, storedSecret, outDir);
          if (!getProvider(providerId, outDir)) {
            upsertProvider(
              { id: providerId, preset: pending.presetId || preset?.id || presetKey, updatedBy: session.user },
              outDir,
            );
          }
          if (body.autoDiscoverModels === true) {
            await maybeAutoDiscoverModels(providerId, body, outDir);
          }
          resetLlmSnapshot();
          return sendJson(res, 200, {
            ok: true,
            status: "authorized",
            provider: getProvider(providerId, outDir),
          });
        }
        if (polled?.error === "slow_down") {
          // RFC 8628: the client must back off by 5s per `slow_down`. Report it
          // instead of silently ignoring the requested interval.
          return sendJson(res, 200, {
            ok: true,
            providerId,
            status: "pending",
            slowDown: true,
            interval: 10,
          });
        }
        if (polled?.error && !["authorization_pending", "slow_down"].includes(polled.error)) {
          pendingDeviceCodes.delete(providerId);
          return sendJson(res, 400, { ok: false, status: "failed", error: polled.error });
        }
      }
      return sendJson(res, 200, { ok: true, status: "pending" });
    }

    /* ---------- GET / PUT /api/studio/stages ---------- */
    if (pathname === "/api/studio/stages") {
      if (isRead) {
        return sendJson(res, 200, getStagesConfig(outDir));
      }
      if (method === "PUT" || method === "POST") {
        const updated = putStagesConfig(
          {
            ...body,
            updatedBy: session.user,
          },
          outDir,
        );
        resetLlmSnapshot();
        return sendJson(res, 200, updated);
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    /* ---------- GET / POST /api/studio/nodes ---------- */
    if (pathname === "/api/studio/nodes") {
      if (isRead) {
        return sendJson(res, 200, {
          nodes: listRenderNodesConfig(outDir),
          runtimeNodes: getRegisteredNodes(outDir),
        });
      }
      if (method === "POST") {
        // A fresh install has no render node configured. Default the docker-sbx
        // box to a sandbox that already exists on this host instead of a name
        // that was never created, so the node is usable out of the box.
        if (String(body.kind ?? "docker-sbx") === "docker-sbx") {
          const requestedBox = String(body.box ?? "").trim();
          if (typeof body.box === "string" && requestedBox === "manhwa-box-1") {
            const sbxAuth = sandboxAuthStatus();
            const firstBox = sbxAuth.sandboxes?.[0]?.name;
            if (
              firstBox
              && /^[a-z0-9][a-z0-9-]{1,62}$/.test(firstBox)
              && !sbxAuth.sandboxes.some((s) => s.name === requestedBox)
            ) {
              body.box = firstBox;
            }
          }
        }
        const node = upsertRenderNodeConfig(
          {
            ...(body as unknown as RenderNodeUpsertInput),
            updatedBy: session.user,
          },
          outDir,
        );
        registerNodeForRuntime({
          id: node.id,
          label: node.label,
          kind: node.kind,
          enabled: node.enabled,
          slots: node.slots,
          supportsCleaner: node.supportsCleaner,
          box: node.box,
          template: node.template,
          maxHours: node.maxHours,
          idlePauseS: node.idlePauseS,
          host: node.host,
          user: node.user,
          port: node.port,
          remoteDir: node.remoteDir,
          identityFile: node.identityFile,
          secretRef: node.secretRef,
          maxLoadFactor: node.maxLoadFactor,
          minMemGb: node.minMemGb,
          minDiskGb: node.minDiskGb,
        }, outDir);
        return sendJson(res, 201, {
          ok: true,
          node,
          nodes: listRenderNodesConfig(outDir),
        });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    /* ---------- /api/studio/nodes/:id[/test | /action] ---------- */
    if (pathname.startsWith("/api/studio/nodes/")) {
      const rest = pathname.slice("/api/studio/nodes/".length);
      const parts = rest.split("/").filter(Boolean);
      const nodeId = decodeURIComponent(parts[0] || "");
      if (!nodeId) {
        return sendJson(res, 400, { error: "Node ID required" });
      }

      if (parts.length === 1) {
        if (method === "PATCH" || method === "PUT") {
          const existing = listRenderNodesConfig(outDir).find((n) => n.id === nodeId);
          if (!existing && method === "PATCH") {
            return sendJson(res, 404, { error: `Render node '${nodeId}' not found` });
          }
          const node = upsertRenderNodeConfig(
            {
              ...(body as unknown as RenderNodeUpsertInput),
              id: nodeId,
              kind: ((body.kind as any) ?? existing?.kind ?? "docker-sbx"),
              updatedBy: session.user,
            },
            outDir,
          );
          registerNodeForRuntime({
            id: node.id,
            label: node.label,
            kind: node.kind,
            enabled: node.enabled,
            slots: node.slots,
            supportsCleaner: node.supportsCleaner,
            box: node.box,
            template: node.template,
            maxHours: node.maxHours,
            idlePauseS: node.idlePauseS,
            host: node.host,
            user: node.user,
            port: node.port,
            remoteDir: node.remoteDir,
            identityFile: node.identityFile,
            secretRef: node.secretRef,
            maxLoadFactor: node.maxLoadFactor,
            minMemGb: node.minMemGb,
            minDiskGb: node.minDiskGb,
          }, outDir);
          return sendJson(res, 200, {
            ok: true,
            node,
            nodes: listRenderNodesConfig(outDir),
          });
        }
        if (method === "DELETE") {
          const removed = deleteRenderNodeConfig(nodeId, { outDir, updatedBy: session.user });
          removeNodeFromRuntime(nodeId);
          if (!removed) return sendJson(res, 404, { error: `Render node '${nodeId}' not found` });
          return sendJson(res, 200, {
            ok: true,
            nodes: listRenderNodesConfig(outDir),
          });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      if (parts.length === 2 && parts[1] === "test") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const resProbe = testNodeConnection(nodeId, outDir);
        return sendJson(res, 200, resProbe);
      }

      if (parts.length === 2 && parts[1] === "action") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const action = String(body.action ?? "status").trim();
        const allowed = ["start", "stop", "create", "status", "provision", "bootstrap", "auth-status", "auth-start"] as const;
        if (!(allowed as readonly string[]).includes(action)) {
          return sendJson(res, 400, { error: `Unsupported node action '${action}'` });
        }
        const resAction = runNodeAction(nodeId, action as (typeof allowed)[number], {
          outDir,
          // This route already required an admin session above, so UI Start /
          // Stop / Create must actually be allowed to touch the sandbox.
          allowControl: true,
        });
        return sendJson(res, 200, resAction);
      }
    }

    /* ---------- Sandbox (sbx) CLI auth: status / start ---------- */
    if (pathname === "/api/studio/sbx/auth") {
      if (method === "GET") {
        const st = sandboxAuthStatus();
        return sendJson(res, 200, {
          ok: st.ok,
          installed: st.installed,
          authenticated: st.authenticated,
          detail: st.detail,
          sandboxes: st.sandboxes,
        });
      }
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const mode = String(body.mode ?? body.action ?? "start").trim();
      if (mode === "status") {
        const st = sandboxAuthStatus();
        return sendJson(res, 200, {
          ok: st.ok,
          installed: st.installed,
          authenticated: st.authenticated,
          detail: st.detail,
          sandboxes: st.sandboxes,
        });
      }
      const token = typeof body.token === "string" ? body.token : undefined;
      const started = sandboxAuthStart(token);
      return sendJson(res, 200, {
        ok: started.ok,
        authenticated: started.authenticated,
        verificationUrl: started.verificationUrl,
        userCode: started.userCode,
        instructions: started.instructions,
        detail: started.detail,
        sandboxes: sandboxAuthStatus().sandboxes,
      });
    }

    /* ---------- GET /api/studio/audit ---------- */
    if (pathname === "/api/studio/audit") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      if (!session.privileged) return sendJson(res, 403, { error: "Admin session required" });
      return sendJson(res, 200, { entries: readStudioAuditLog(outDir, 100) });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendStudioError(res, sendJson, err);
  }
}

/** Resolve server-owned storage scopes; clients cannot trash arbitrary host paths. */
async function deleteStorageArtifact(body: Record<string, unknown>) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const root = path.resolve(process.env.MANHWA_SERIES_ROOT || path.join(repo, "series"));
  const out = resolveOutDir();
  const thumbs = path.resolve(process.env.MANHWA_THUMBS_ROOT || path.join(repo, "thumbnails"));
  const kind = String(body.kind || "artifact") as TrashKind;
  if (!["chapter-video", "full-video", "series-cache", "series", "artifact"].includes(kind)) throw Object.assign(new Error("Invalid storage kind"), { statusCode: 400 });
  const slug = validateSlug(body.slug);
  const ch = validateChapter(body.chapter ?? body.ch);
  if (kind === "chapter-video") {
    if (!slug || !ch) throw Object.assign(new Error("Valid slug and chapter required"), { statusCode: 400 });
    const result = await deleteChapterVideo({ seriesRoot: root, slug, ch });
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: result.status });
    return result;
  }
  let target: string;
  if (kind !== "artifact" && !slug) throw Object.assign(new Error("Valid series slug required"), { statusCode: 400 });
  if (kind === "series") target = path.join(root, slug!);
  else if (kind === "full-video") target = path.join(root, slug!, "out", "full", "video", "video.mp4");
  else if (kind === "series-cache") {
    const relative = String(body.path ?? body.target ?? body.targetPath ?? "out/cache");
    if (!/^out\/(?:cache|cleaned|panels|reader)(?:\/[^.][^\\]*)?$/.test(relative) || relative.split("/").includes("..")) {
      throw Object.assign(new Error("Cache path must be under out/cache, out/cleaned, out/panels or out/reader"), { statusCode: 400 });
    }
    target = path.resolve(root, slug!, relative);
    if (!target.startsWith(path.join(root, slug!) + path.sep)) throw Object.assign(new Error("Invalid cache path"), { statusCode: 400 });
  } else {
    const raw = body.targetPath ?? body.path ?? body.target;
    if (typeof raw !== "string" || !raw.trim()) throw Object.assign(new Error("Artifact path required"), { statusCode: 400 });
    target = path.resolve(slug ? path.join(root, slug) : repo, raw);
    const allowed = [slug ? path.join(root, slug) : root, path.join(out, "jobs"), path.join(out, "voice-previews"), thumbs];
    if (!allowed.some((base) => target.startsWith(path.resolve(base) + path.sep)) || target.split(path.sep).includes(".series.lock")) {
      throw Object.assign(new Error("Artifact must be inside the series, jobs, previews or thumbnails directories"), { statusCode: 400 });
    }
    if (target.startsWith(root + path.sep) && !slug) throw Object.assign(new Error("Series artifact deletion requires its slug"), { statusCode: 400 });
  }
  assertNoSymlinks(target);
  const perform = () => {
    if (slug) {
      const active = checkNoActivePipelineRun(process.env.MANHWA_PROC_ROOT || "/proc", slug);
      if (!active.ok) throw Object.assign(new Error(active.error), { statusCode: active.status });
    }
    if (reconcileJobs().some((job) => (!slug || job.slug === slug) && ["queued", "paused", "running", "ingesting", "downloading"].includes(job.status))) {
      throw Object.assign(new Error("Storage is in use by an active or queued job"), { statusCode: 409 });
    }
    if (fs.existsSync(target + ".part") || (kind === "full-video" && hasActiveLocalRenderScratch(target))) throw Object.assign(new Error("Render is still writing this artifact"), { statusCode: 409 });
    const item = moveToTmpTrash(target, { kind, slug: slug || undefined, chapter: ch || undefined,
      label: typeof body.label === "string" ? body.label.slice(0, 200) : undefined });
    return { ok: true, trashId: item.id, item, freedBytes: item.sizeBytes };
  };
  return slug ? withExclusiveSeriesLock(path.join(root, slug), { nonblocking: true, seriesRoot: root }, perform) : perform();
}
