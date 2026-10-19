/**
 * Creative Studio persistence and provider/stage/render-node configuration store.
 *
 * Manages:
 * - `<outDir>/config/providers.json` (`0o600`, monotonic `revision`)
 * - `<outDir>/config/stages.json` (`0o600`, monotonic `revision`)
 * - `<outDir>/config/render-nodes.json` (`0o600`, monotonic `revision`)
 * - `<outDir>/config/studio-audit.log` (`0o600`, append-only secret-scrubbed log)
 *
 * Raw secrets are never persisted in `providers.json` or `render-nodes.json` and
 * never returned from `listProviders` or `getProvider`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getDefaultBriefs } from "../contracts/briefs.js";
import { defaultRoleLaneIds } from "./modelLanes.js";
import {
  deleteSecret,
  getSecret,
  getSecretMeta,
  putSecret,
  resolveOutDir,
  scrubSecrets,
} from "./secretStore.js";

export const STUDIO_SCHEMA_VERSION = 1;
export const PROVIDERS_FILENAME = "providers.json";
export const STAGES_FILENAME = "stages.json";
export const RENDER_NODES_FILENAME = "render-nodes.json";
export const STUDIO_AUDIT_FILENAME = "studio-audit.log";

export const STAGES = ["reader", "matcher", "writer", "scout", "fact_check"] as const;
export type StageId = (typeof STAGES)[number];

export type ProviderProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "vertex-openai";

export type ProviderAuthMode =
  | "bearer"
  | "oauth-pkce"
  | "device-code"
  | "vertex-service-account"
  | "vertex-oauth"
  | "none";

export type ProviderCategory =
  | "cloud-api"
  | "subscription"
  | "cloud-iam"
  | "local";

export interface ProviderModelCapabilities {
  vision: boolean;
  writer: boolean;
  json: boolean;
  reasoning: boolean;
  streaming: boolean;
  tts: boolean;
  /** Image generation (e.g. Vertex Imagen). Optional: older stored configs omit it. */
  image?: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ProviderModelConfig {
  id: string;
  label: string;
  enabled: boolean;
  roles: Array<"vision" | "writer">;
  capabilities: ProviderModelCapabilities;
  thinking: boolean | null;
  stream: boolean;
  reasoningEffort?: ReasoningEffort | null;
  contextWindow?: number;
  maxOutputTokens?: number;
  costTier?: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  category: ProviderCategory;
  kind: ProviderCategory;
  protocol: ProviderProtocol;
  baseUrl: string;
  authMode: ProviderAuthMode;
  allowPrivateNetwork: boolean;
  client_id?: string;
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  defaultModels: ProviderModelConfig[];
  description: string;
}

function presetModel(
  id: string,
  label: string,
  opts: Partial<{
    vision: boolean;
    writer: boolean;
    json: boolean;
    reasoning: boolean;
    streaming: boolean;
    tts: boolean;
    image: boolean;
    thinking: boolean | null;
    stream: boolean;
    reasoningEffort: ReasoningEffort | null;
    contextWindow: number;
    maxOutputTokens: number;
    costTier: string;
  }> = {},
): ProviderModelConfig {
  const vision = Boolean(opts.vision ?? false);
  const writer = Boolean(opts.writer ?? true);
  const roles: Array<"vision" | "writer"> = [];
  if (vision) roles.push("vision");
  if (writer) roles.push("writer");
  return {
    id,
    label,
    enabled: true,
    roles,
    capabilities: {
      vision,
      writer,
      json: Boolean(opts.json ?? true),
      reasoning: Boolean(opts.reasoning ?? false),
      streaming: Boolean(opts.streaming ?? true),
      tts: Boolean(opts.tts ?? false),
      image: Boolean(opts.image ?? false),
    },
    thinking: opts.thinking ?? null,
    stream: Boolean(opts.stream ?? false),
    reasoningEffort: opts.reasoningEffort ?? null,
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens,
    costTier: opts.costTier ?? "paid",
  };
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("google/gemini-2.5-flash", "Gemini 2.5 Flash", { vision: true, writer: true }),
      presetModel("deepseek/deepseek-chat-v3-0324", "DeepSeek V3", { vision: true, writer: true }),
    ],
    description: "Unified OpenAI-compatible router for 300+ cloud and open-weight models.",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("gpt-4o", "GPT-4o", { vision: true, writer: true }),
      presetModel("gpt-4o-mini", "GPT-4o Mini", { vision: true, writer: true }),
    ],
    description: "Official OpenAI platform API.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("claude-sonnet-4-20250514", "Claude Sonnet 4", { vision: true, writer: true }),
      presetModel("claude-3-5-haiku-latest", "Claude 3.5 Haiku", { vision: true, writer: true }),
    ],
    description: "Anthropic Messages API (/v1/messages) with vision and text support.",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini API",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("gemini-2.5-flash", "Gemini 2.5 Flash", { vision: true, writer: true }),
      presetModel("gemini-2.5-pro", "Gemini 2.5 Pro", { vision: true, writer: true, reasoning: true }),
    ],
    description: "Google AI Studio Gemini OpenAI-compatible endpoint.",
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("grok-4.7", "Grok 4.7", { vision: true, writer: true, reasoning: true }),
      presetModel("grok-2-vision-latest", "Grok 2 Vision", { vision: true, writer: true }),
    ],
    description: "xAI official Grok API (https://api.x.ai/v1).",
  },
  "grok-subscription": {
    id: "grok-subscription",
    label: "xAI SuperGrok / Grok Subscription",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authMode: "device-code",
    allowPrivateNetwork: false,
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    defaultModels: [
      presetModel("grok-4", "Grok 4", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("grok-3", "Grok 3", { vision: false, writer: true, costTier: "free" }),
      presetModel("grok-2-vision-latest", "Grok 2 Vision", {
        vision: true, writer: true, costTier: "free",
      }),
    ],
    description:
      "Grok subscription access, either way: paste an xAI API key / bearer token for the " +
      "OpenAI-compatible https://api.x.ai/v1 endpoint, or point baseUrl at a local Grok " +
      "subscription bridge (for example http://127.0.0.1:8317/v1) and tick allowPrivateNetwork.",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
        vision: true, writer: true, reasoning: true,
      }),
      presetModel("deepseek-chat", "DeepSeek Chat", { vision: true, writer: true }),
      presetModel("deepseek-reasoner", "DeepSeek Reasoner", { vision: true, writer: true, reasoning: true }),
    ],
    description: "DeepSeek official API (https://api.deepseek.com/v1).",
  },
  dashscope: {
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("qwen-vl-max", "Qwen VL Max", { vision: true, writer: true }),
      presetModel("qwen-plus", "Qwen Plus", { vision: false, writer: true }),
    ],
    description: "Alibaba Cloud DashScope OpenAI-compatible endpoint.",
  },
  groq: {
    id: "groq",
    label: "Groq Cloud",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [
      presetModel("meta-llama/llama-4-scout-17b-16e-instruct", "Llama 4 Scout 17B", { vision: true, writer: true }),
      presetModel("llama-3.3-70b-versatile", "Llama 3.3 70B", { vision: false, writer: true }),
    ],
    description: "Groq LPU low-latency OpenAI-compatible API.",
  },
  "custom-openai": {
    id: "custom-openai",
    label: "Custom OpenAI-Compatible",
    category: "cloud-api",
    kind: "cloud-api",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    authMode: "bearer",
    allowPrivateNetwork: false,
    defaultModels: [],
    description: "Any custom OpenAI-compatible /v1/chat/completions endpoint.",
  },
  "codex-oauth": {
    id: "codex-oauth",
    label: "OpenAI Codex (ChatGPT Subscription OAuth)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    // ChatGPT subscription login prefers the headless device-code flow; PKCE stays
    // available as a fallback through `/oauth/pkce-start` + `/oauth/pkce-exchange`.
    authMode: "device-code",
    allowPrivateNetwork: false,
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email", "offline_access"],
    // Exact catalog returned by `GET https://chatgpt.com/backend-api/codex/models`
    // (visibility: "list") for a ChatGPT subscription token.
    defaultModels: [
      presetModel("gpt-6.1-sol", "GPT-6.1 Sol", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gpt-6-astra", "GPT-6 Astra", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gpt-6-sol", "GPT-6 Sol", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gpt-6-luna", "GPT-6 Luna", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium", costTier: "free",
      }),
      presetModel("gpt-5.6-sol", "GPT-5.6 Sol", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gpt-5.6-terra", "GPT-5.6 Terra", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium", costTier: "free",
      }),
      presetModel("gpt-5.6-luna", "GPT-5.6 Luna", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "low", costTier: "free",
      }),
    ],
    description: "OpenAI device-code OAuth flow via https://auth.openai.com (PKCE fallback).",
  },
  "claude-oauth": {
    id: "claude-oauth",
    label: "Claude Pro / Max (Subscription OAuth)",
    category: "subscription",
    kind: "subscription",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "oauth-pkce",
    allowPrivateNetwork: false,
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    defaultModels: [
      presetModel("claude-sonnet-4-20250514", "Claude Sonnet 4", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("claude-opus-4-20250514", "Claude Opus 4", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "xhigh", costTier: "free",
      }),
      presetModel("claude-3-5-haiku-latest", "Claude 3.5 Haiku (Fast)", {
        vision: true, writer: true, reasoningEffort: "low", costTier: "free",
      }),
    ],
    description: "Anthropic Claude subscription OAuth via /v1/messages.",
  },
  "github-copilot": {
    id: "github-copilot",
    label: "GitHub Copilot (Device Code)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.githubcopilot.com",
    authMode: "device-code",
    allowPrivateNetwork: false,
    client_id: "Ov23li8tweQw6odWQebz",
    clientId: "Ov23li8tweQw6odWQebz",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultModels: [
      presetModel("gpt-4o", "Copilot GPT-4o", { vision: true, writer: true, costTier: "free" }),
      presetModel("gpt-4.1", "Copilot GPT-4.1", { vision: true, writer: true, costTier: "free" }),
      presetModel("claude-3.7-sonnet", "Copilot Claude 3.7 Sonnet", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium", costTier: "free",
      }),
      presetModel("claude-sonnet-4", "Copilot Claude Sonnet 4", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gemini-2.5-pro", "Copilot Gemini 2.5 Pro", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium", costTier: "free",
      }),
      presetModel("gpt-4o-mini", "Copilot GPT-4o Mini (Fast)", {
        vision: true, writer: true, reasoningEffort: "low", costTier: "free",
      }),
    ],
    description: "GitHub Copilot device-code subscription provider.",
  },
  "vertex-ai": {
    id: "vertex-ai",
    label: "Google Cloud Vertex AI (Service Account or OAuth)",
    category: "cloud-iam",
    kind: "cloud-iam",
    protocol: "vertex-openai",
    baseUrl: "https://aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/endpoints/openapi",
    authMode: "vertex-service-account",
    allowPrivateNetwork: false,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    // Model ids stay unprefixed in config/UI. The Vertex OpenAI-compatible
    // endpoint wants `google/<model>`; `client.ts` adds that prefix only in the
    // outbound request payload.
    defaultModels: [
      presetModel("gemini-4-argon", "Vertex Gemini 4 Argon", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high",
      }),
      presetModel("gemini-3.8-flash", "Vertex Gemini 3.8 Flash", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium",
      }),
      presetModel("gemini-2.5-flash", "Vertex Gemini 2.5 Flash", { vision: true, writer: true }),
      presetModel("gemini-2.5-pro", "Vertex Gemini 2.5 Pro", { vision: true, writer: true, reasoning: true }),
      presetModel("gemini-3.8-flash-tts", "Vertex Gemini 3.8 Flash TTS", {
        vision: false, writer: false, json: false, streaming: false, tts: true,
      }),
      presetModel("chirp-3-hd", "Vertex Chirp 3 HD (TTS)", {
        vision: false, writer: false, json: false, streaming: false, tts: true,
      }),
      presetModel("imagen-3.0-generate-002", "Vertex Imagen 3.0", {
        vision: false, writer: false, json: false, image: true,
      }),
    ],
    description: "GCP Vertex AI via Service Account JSON RS256 JWT exchange or Google OAuth (projectId + location).",
  },
  "subscription-bridge": {
    id: "subscription-bridge",
    label: "Local Subscription Bridge (CLIProxyAPI / OpenCode / AGY)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8317/v1",
    authMode: "bearer",
    allowPrivateNetwork: true,
    defaultModels: [
      presetModel("gpt-5", "Bridge GPT-5", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("claude-sonnet-4", "Bridge Claude Sonnet 4", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "high", costTier: "free",
      }),
      presetModel("gemini-2.5-pro", "Bridge Gemini 2.5 Pro", {
        vision: true, writer: true, reasoning: true, reasoningEffort: "medium", costTier: "free",
      }),
      presetModel("gemini-2.5-flash", "Bridge Gemini 2.5 Flash (Fast)", {
        vision: true, writer: true, reasoningEffort: "low", costTier: "free",
      }),
      presetModel("gpt-4o-mini", "Bridge GPT-4o Mini (Fast)", {
        vision: true, writer: true, reasoningEffort: "low", costTier: "free",
      }),
    ],
    description: "Local or LAN subscription proxy bridge exposing an OpenAI-compatible API.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (Local)",
    category: "local",
    kind: "local",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    authMode: "none",
    allowPrivateNetwork: true,
    defaultModels: [
      presetModel("qwen2.5vl:7b", "Qwen 2.5 VL 7B", { vision: true, writer: true, costTier: "free" }),
      presetModel("llama3.2:latest", "Llama 3.2", { vision: false, writer: true, costTier: "free" }),
    ],
    description: "Local Ollama server at http://127.0.0.1:11434/v1.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio (Local)",
    category: "local",
    kind: "local",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    authMode: "none",
    allowPrivateNetwork: true,
    defaultModels: [],
    description: "Local LM Studio OpenAI server at http://127.0.0.1:1234/v1.",
  },
  vllm: {
    id: "vllm",
    label: "vLLM (Local / Self-Hosted)",
    category: "local",
    kind: "local",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    authMode: "none",
    allowPrivateNetwork: true,
    defaultModels: [],
    description: "Self-hosted vLLM OpenAI server at http://127.0.0.1:8000/v1.",
  },
};

export class StudioConfigError extends Error {
  statusCode = 400;
  status_code = 400;
  code = "studio_config_error";

  constructor(message: string, statusCode = 400, code = "studio_config_error") {
    super(message);
    this.name = "StudioConfigError";
    this.statusCode = statusCode;
    this.status_code = statusCode;
    this.code = code;
  }
}

export class StudioValidationError extends StudioConfigError {
  constructor(message: string) {
    super(message, 400, "validation_error");
    this.name = "StudioValidationError";
  }
}

export class StudioRevisionConflictError extends StudioConfigError {
  currentRevision: number;
  current_revision: number;

  constructor(expected: number, current: number) {
    super(
      `Revision conflict: expected revision ${expected}, current revision is ${current}.`,
      409,
      "revision_conflict",
    );
    this.name = "StudioRevisionConflictError";
    this.currentRevision = current;
    this.current_revision = current;
  }
}

export interface ValidateUrlOptions {
  allowPrivateNetwork?: boolean;
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function extractMappedIpv4FromIpv6(ipv6Host: string): [number, number, number, number] | null {
  const low = ipv6Host.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(low);
  if (dotted?.[1]) return parseIpv4Octets(dotted[1]);
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (hexMatch?.[1] && hexMatch?.[2]) {
    const hi = Number.parseInt(hexMatch[1], 16);
    const lo = Number.parseInt(hexMatch[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function checkIpv4Ssrf(
  octets: [number, number, number, number],
  allowPrivateNetwork: boolean,
): void {
  const [a, b] = octets;
  if (a === 0) {
    throw new StudioValidationError("Blocked unspecified IPv4 address (0.0.0.0/8)");
  }
  if (a === 169 && b === 254) {
    throw new StudioValidationError("Blocked link-local / cloud metadata address (169.254.0.0/16)");
  }
  if (a === 100 && b === 100 && octets[2] === 100 && octets[3] === 200) {
    throw new StudioValidationError("Blocked cloud metadata address (100.100.100.200)");
  }
  if (!allowPrivateNetwork) {
    if (a === 127) {
      throw new StudioValidationError("Loopback address (127.0.0.0/8) requires allowPrivateNetwork");
    }
    if (a === 10) {
      throw new StudioValidationError("Private network address (10.0.0.0/8) requires allowPrivateNetwork");
    }
    if (a === 172 && b >= 16 && b <= 31) {
      throw new StudioValidationError("Private network address (172.16.0.0/12) requires allowPrivateNetwork");
    }
    if (a === 192 && b === 168) {
      throw new StudioValidationError("Private network address (192.168.0.0/16) requires allowPrivateNetwork");
    }
  }
}

/**
 * Validates a provider URL against SSRF rules.
 * - Only `http:` and `https:` protocols are permitted.
 * - Always rejects `169.254.169.254`, `metadata.google.internal`, `169.254.0.0/16`, `0.0.0.0`, `[::]`.
 * - Rejects `localhost`, `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 *   unless `opts?.allowPrivateNetwork === true`.
 */
export function validateProviderUrl(urlStr: string, opts?: ValidateUrlOptions): string {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    throw new StudioValidationError("Provider URL must be a non-empty string");
  }
  const allowPrivate = Boolean(opts?.allowPrivateNetwork);
  const candidateStr = urlStr
    .trim()
    .replace(/\{projectId\}/g, "project")
    .replace(/\{location\}/g, "global");

  let parsed: URL;
  try {
    parsed = new URL(candidateStr);
  } catch {
    throw new StudioValidationError(`Invalid URL: ${urlStr}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new StudioValidationError(`Unsupported URL protocol ${parsed.protocol} (only http: and https: are allowed)`);
  }
  if (parsed.username || parsed.password) {
    throw new StudioValidationError("Provider URL must not embed credentials");
  }

  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) {
    throw new StudioValidationError("Provider URL is missing a hostname");
  }

  if (
    rawHost === "metadata.google.internal"
    || rawHost.endsWith(".metadata.google.internal")
    || rawHost === "metadata.goog"
    || rawHost === "metadata"
  ) {
    throw new StudioValidationError(`Blocked cloud metadata hostname: ${rawHost}`);
  }

  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    const ipv6 = rawHost.slice(1, -1).toLowerCase();
    if (ipv6 === "::" || ipv6 === "::0" || ipv6 === "0:0:0:0:0:0:0:0") {
      throw new StudioValidationError("Blocked unspecified IPv6 address ([::])");
    }
    if (/^fe[89ab][0-9a-f]:/.test(ipv6)) {
      throw new StudioValidationError("Blocked IPv6 link-local address (fe80::/10)");
    }
    const mappedV4 = extractMappedIpv4FromIpv6(ipv6);
    if (mappedV4) {
      checkIpv4Ssrf(mappedV4, allowPrivate);
    }
    if (!allowPrivate) {
      if (ipv6 === "::1" || ipv6 === "0:0:0:0:0:0:0:1") {
        throw new StudioValidationError("IPv6 loopback (::1) requires allowPrivateNetwork");
      }
      if (/^f[cd][0-9a-f]{2}:/.test(ipv6)) {
        throw new StudioValidationError("IPv6 private address (fc00::/7) requires allowPrivateNetwork");
      }
    }
  } else {
    const ipv4 = parseIpv4Octets(rawHost);
    if (ipv4) {
      checkIpv4Ssrf(ipv4, allowPrivate);
    } else if (!allowPrivate) {
      if (rawHost === "localhost" || rawHost.endsWith(".localhost") || rawHost.endsWith(".local")) {
        throw new StudioValidationError(`Local hostname (${rawHost}) requires allowPrivateNetwork`);
      }
    }
  }

  return urlStr.trim().replace(/\/+$/, "");
}

export interface ProviderAuthStored {
  mode: ProviderAuthMode;
  secretRef?: string;
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  projectId?: string;
  location?: string;
  /** Google Cloud projects discovered during Vertex OAuth sign-in. */
  projects?: Array<{ projectId: string; name: string }>;
}

export interface ProviderAuthView extends ProviderAuthStored {
  hasSecret: boolean;
  secretHint: string | null;
  updatedAt: number | null;
  /** Signed-in account identity, decoded from the stored credential. */
  accountEmail?: string;
  accountName?: string;
  accountPlan?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface ProviderTestSummary {
  ok: boolean;
  status: number;
  latencyMs: number;
  testedAt: number;
  modelCount?: number;
  error?: string | null;
}

export interface ProviderStored {
  id: string;
  label: string;
  preset?: string;
  kind: ProviderCategory | string;
  protocol: ProviderProtocol;
  baseUrl: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth: ProviderAuthStored;
  models: ProviderModelConfig[];
  lastTest?: ProviderTestSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderView extends Omit<ProviderStored, "auth"> {
  auth: ProviderAuthView;
  revision: number;
}

export interface ProviderUpsertInput {
  id: string;
  label?: string;
  preset?: string;
  kind?: ProviderCategory | string;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  enabled?: boolean;
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  apiKey?: string;
  secret?: string;
  serviceAccountJson?: string;
  oauthToken?: string;
  auth?: Partial<ProviderAuthStored> & {
    apiKey?: string;
    secret?: string;
    token?: string;
    accessToken?: string;
    refreshToken?: string;
    serviceAccountJson?: string;
  };
  models?: Array<string | Partial<ProviderModelConfig> & { id: string }>;
  expectedRevision?: number;
  updatedBy?: string;
}

interface ProvidersFileDoc {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
  providers: ProviderStored[];
}

export interface StudioAuditEntry {
  at: number;
  user: string;
  action: string;
  target: string;
  revision: number;
}

type OutDirOrOpts =
  | string
  | {
      outDir?: string;
      expectedRevision?: number;
      updatedBy?: string;
    }
  | undefined;

/**
 * Config root for one call. An explicit `outDir` wins; an implicit call always
 * resolves from the environment (`resolveOutDir`). No module-level memory: a
 * previous caller's directory can never leak into this one.
 */
function extractOutDir(arg?: OutDirOrOpts): string {
  if (typeof arg === "string" && arg.trim()) return path.resolve(arg.trim());
  if (arg && typeof arg === "object" && typeof arg.outDir === "string" && arg.outDir.trim()) {
    return path.resolve(arg.outDir.trim());
  }
  return resolveOutDir();
}

function configFilePath(filename: string, outDir?: OutDirOrOpts): string {
  return path.join(extractOutDir(outDir), "config", filename);
}

function atomicWriteJson0600(filePath: string, data: unknown): void {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`,
  );
  const payload = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tmpPath, flags, 0o600);
    try {
      let offset = 0;
      while (offset < payload.length) {
        const written = fs.writeSync(fd, payload, offset, payload.length - offset);
        if (written <= 0) throw new Error("Short write to studio config temp file");
        offset += written;
      }
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function appendAuditLog(
  action: string,
  target: string,
  revision: number,
  user = "admin",
  outDir?: OutDirOrOpts,
): void {
  const logPath = configFilePath(STUDIO_AUDIT_FILENAME, outDir);
  const dirPath = path.dirname(logPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const entry: StudioAuditEntry = {
    at: Date.now(),
    user: scrubSecrets(user || "admin").slice(0, 64) || "admin",
    action: scrubSecrets(action),
    target: scrubSecrets(target),
    revision,
  };
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // ignore
  }
}

export function readStudioAuditLog(outDir?: string, limit = 100): StudioAuditEntry[] {
  const logPath = configFilePath(STUDIO_AUDIT_FILENAME, outDir);
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .map((line) => JSON.parse(line) as StudioAuditEntry);
  } catch {
    return [];
  }
}

function readProvidersDoc(outDir?: OutDirOrOpts): ProvidersFileDoc {
  const filePath = configFilePath(PROVIDERS_FILENAME, outDir);
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { schemaVersion: STUDIO_SCHEMA_VERSION, revision: 0, updatedAt: 0, updatedBy: null, providers: [] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProvidersFileDoc>;
    return {
      schemaVersion: STUDIO_SCHEMA_VERSION,
      revision: typeof parsed.revision === "number" && Number.isInteger(parsed.revision) ? parsed.revision : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    };
  } catch {
    return { schemaVersion: STUDIO_SCHEMA_VERSION, revision: 0, updatedAt: 0, updatedBy: null, providers: [] };
  }
}

function toProviderView(stored: ProviderStored, revision: number, outDir?: OutDirOrOpts): ProviderView {
  const resolvedOut = extractOutDir(outDir);
  const secretRef = stored.auth?.secretRef || `provider:${stored.id}`;
  const meta = getSecretMeta(secretRef, resolvedOut);
  const rawSecret = meta.hasSecret ? getSecret(secretRef, resolvedOut) : null;
  const account = extractStoredAccountInfo(rawSecret, stored);
  return {
    ...structuredClone(stored),
    revision,
    auth: {
      mode: stored.auth?.mode ?? "bearer",
      secretRef,
      clientId: stored.auth?.clientId,
      authorizeUrl: stored.auth?.authorizeUrl,
      tokenUrl: stored.auth?.tokenUrl,
      deviceCodeUrl: stored.auth?.deviceCodeUrl,
      scopes: stored.auth?.scopes,
      projectId: stored.auth?.projectId,
      location: stored.auth?.location,
      projects: stored.auth?.projects,
      hasSecret: meta.hasSecret,
      secretHint: meta.hint,
      updatedAt: meta.updatedAt,
      ...account,
    },
  };
}

/** Decode a JWT payload (middle segment) without verifying it. */
function decodeJwtClaims(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return claims as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Read the signed-in account identity out of a stored credential blob.
 * Handles Service Account JSON, OpenAI ChatGPT OAuth JWTs (profile/auth
 * namespaces) and plain OIDC JWTs, plus explicit `account_*` fields written by
 * the device flows. Never throws: a malformed blob yields an empty result.
 */
export function extractStoredAccountInfo(
  rawSecret: string | null,
  provider: ProviderStored,
): {
  accountEmail?: string;
  accountName?: string;
  accountPlan?: string;
  accountId?: string;
  expiresAt?: number;
} {
  const trimmed = (rawSecret ?? "").trim();
  if (!trimmed || !trimmed.startsWith("{")) return {};
  let obj: Record<string, any>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    obj = parsed as Record<string, any>;
  } catch {
    return {};
  }

  const pick = (value: unknown): string | undefined => (
    typeof value === "string" && value.trim() ? value.trim() : undefined
  );

  let accountEmail: string | undefined;
  let accountName: string | undefined;
  let accountPlan: string | undefined;
  let accountId: string | undefined;
  let expiresAt: number | undefined;

  // Service Account key JSON.
  if (pick(obj.client_email)) {
    accountEmail = pick(obj.client_email);
    accountPlan = pick(obj.project_id) ? `Service Account · ${pick(obj.project_id)}` : "Service Account";
    accountId = pick(obj.project_id);
  }

  // OpenAI ChatGPT OAuth JWTs (id_token first, then access_token).
  for (const raw of [obj.id_token, obj.access_token]) {
    const claims = decodeJwtClaims(raw);
    if (!claims) continue;
    const profile = claims["https://api.openai.com/profile"];
    const auth = claims["https://api.openai.com/auth"];
    const email = pick(claims.email) ?? pick(profile?.email);
    const name = pick(claims.name) ?? pick(profile?.name);
    const sub = pick(auth?.chatgpt_account_id) ?? pick(claims.sub);
    if (email && !accountEmail) accountEmail = email;
    if (name && !accountName) accountName = name;
    if (sub && !accountId) accountId = sub;
    const plan = pick(auth?.chatgpt_plan_type);
    if (plan && !accountPlan) accountPlan = `ChatGPT ${plan.toUpperCase()}`;
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && expiresAt === undefined) {
      expiresAt = claims.exp;
    }
  }

  // Explicit fields written by the device / OAuth flows win over JWT guesses.
  if (pick(obj.account_email)) accountEmail = pick(obj.account_email);
  if (pick(obj.account_name)) accountName = pick(obj.account_name);
  if (pick(obj.account_plan)) accountPlan = pick(obj.account_plan);
  if (pick(obj.account_id)) accountId = pick(obj.account_id);
  if (typeof obj.expires_at === "number" && Number.isFinite(obj.expires_at)) {
    expiresAt = obj.expires_at;
  } else if (typeof obj.expiresAt === "number" && Number.isFinite(obj.expiresAt)) {
    expiresAt = obj.expiresAt;
  }

  if (provider.id === "vertex-ai" || provider.preset === "vertex-ai") {
    const project = pick(provider.auth?.projectId) ?? pick(obj.quota_project_id);
    if (!accountPlan && project) accountPlan = `GCP Project: ${project}`;
  }

  return {
    ...(accountEmail ? { accountEmail } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountPlan ? { accountPlan } : {}),
    ...(accountId ? { accountId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * Normalize a stored `auth.projects` list (Vertex project picker). Invalid
 * entries are dropped rather than failing the whole provider update, so an
 * older or hand-edited providers.json still loads.
 */
function normalizeProjectList(
  raw: unknown,
): Array<{ projectId: string; name: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ projectId: string; name: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const projectId = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : projectId;
    out.push({ projectId, name });
  }
  return out;
}

function normalizeModelEntry(
  raw: string | (Partial<ProviderModelConfig> & { id: string }),
): ProviderModelConfig {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (!id) throw new StudioValidationError("Model ID cannot be empty");
    const lower = id.toLowerCase();
    const looksVision = lower.includes("deepseek")
      || lower.includes("gpt-5")
      || lower.includes("gpt-6")
      || lower.includes("gpt-4o")
      || lower.includes("claude")
      || lower.includes("gemini")
      || lower.includes("grok")
      || lower.includes("vl")
      || lower.includes("vision")
      || lower.includes("scout")
      || lower.includes("qwen")
      || lower.includes("kimi")
      || lower.includes("pixtral")
      || lower.includes("llama-4");
    return presetModel(id, id, { vision: looksVision, writer: true });
  }
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim()) {
    throw new StudioValidationError("Each model entry must include a non-empty id");
  }
  const id = raw.id.trim();
  const caps = raw.capabilities ?? ({} as Partial<ProviderModelCapabilities>);
  const rolesFromInput = Array.isArray(raw.roles)
    ? raw.roles.filter((r): r is "vision" | "writer" => r === "vision" || r === "writer")
    : [];
  const vision = Boolean(caps.vision ?? rolesFromInput.includes("vision"));
  const writer = Boolean(caps.writer ?? (rolesFromInput.length === 0 || rolesFromInput.includes("writer")));
  const roles: Array<"vision" | "writer"> = [];
  if (vision || rolesFromInput.includes("vision")) roles.push("vision");
  if (writer || rolesFromInput.includes("writer")) roles.push("writer");
  if (roles.length === 0 && !caps.tts && !caps.image) roles.push("writer");

  return {
    id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    roles,
    capabilities: {
      vision: roles.includes("vision"),
      writer: roles.includes("writer"),
      json: Boolean(caps.json ?? true),
      reasoning: Boolean(caps.reasoning ?? false),
      streaming: Boolean(caps.streaming ?? raw.stream ?? true),
      tts: Boolean(caps.tts ?? false),
      image: Boolean(caps.image ?? false),
    },
    thinking: raw.thinking === undefined ? null : raw.thinking,
    stream: Boolean(raw.stream ?? false),
    reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort),
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
    maxOutputTokens: typeof raw.maxOutputTokens === "number" ? raw.maxOutputTokens : undefined,
    costTier: typeof raw.costTier === "string" ? raw.costTier : "paid",
  };
}

function normalizeReasoningEffort(raw: unknown): ReasoningEffort | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new StudioValidationError(`reasoningEffort must be one of low, medium, high, xhigh (got ${JSON.stringify(raw)})`);
}

function validateProviderId(id: unknown): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new StudioValidationError("Provider id must be a non-empty string");
  }
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new StudioValidationError(`Invalid provider id '${trimmed}'`);
  }
  return trimmed;
}

export function listProviders(outDir?: OutDirOrOpts): ProviderView[] {
  const doc = readProvidersDoc(outDir);
  return doc.providers.map((p) => toProviderView(p, doc.revision, outDir));
}

export function getProvidersState(outDir?: OutDirOrOpts): {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
  providers: ProviderView[];
  presets: Record<string, ProviderPreset>;
} {
  const doc = readProvidersDoc(outDir);
  return {
    schemaVersion: doc.schemaVersion,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    providers: doc.providers.map((p) => toProviderView(p, doc.revision, outDir)),
    presets: PROVIDER_PRESETS,
  };
}

export function getProvider(id: string, outDir?: OutDirOrOpts): ProviderView | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const doc = readProvidersDoc(outDir);
  const found = doc.providers.find((p) => p.id === id.trim());
  if (!found) return null;
  return toProviderView(found, doc.revision, outDir);
}

/**
 * Raw stored provider record (no secret value), for rollback snapshots.
 * `getProvider` returns a view with secret metadata; this returns the exact
 * record so a failed verification can restore the previous state.
 */
export function getProviderRecord(id: string, outDir?: OutDirOrOpts): ProviderStored | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const doc = readProvidersDoc(outDir);
  const found = doc.providers.find((p) => p.id === id.trim());
  return found ? structuredClone(found) : null;
}

/** Write back a record captured by `getProviderRecord`. */
export function restoreProviderRecord(
  record: ProviderStored,
  outDir?: OutDirOrOpts,
  updatedBy?: string,
): ProviderView {
  const resolvedOut = extractOutDir(outDir);
  const id = validateProviderId(record.id);
  const doc = readProvidersDoc(resolvedOut);
  const restored: ProviderStored = { ...structuredClone(record), id, updatedAt: Date.now() };
  const idx = doc.providers.findIndex((p) => p.id === id);
  if (idx >= 0) doc.providers[idx] = restored;
  else doc.providers.push(restored);
  doc.revision += 1;
  doc.updatedAt = restored.updatedAt;
  const actor = updatedBy
    ?? (typeof outDir === "object" && outDir ? outDir.updatedBy : undefined)
    ?? "admin";
  doc.updatedBy = actor;
  atomicWriteJson0600(configFilePath(PROVIDERS_FILENAME, resolvedOut), doc);
  appendAuditLog("provider.restore", id, doc.revision, actor, resolvedOut);
  return toProviderView(restored, doc.revision, resolvedOut);
}

export function upsertProvider(
  input: ProviderUpsertInput,
  outDir?: OutDirOrOpts,
): ProviderView {
  if (!input || typeof input !== "object") {
    throw new StudioValidationError("Provider payload must be an object");
  }
  const resolvedOut = extractOutDir(outDir);
  const id = validateProviderId(input.id);
  const presetKey = input.preset || (id in PROVIDER_PRESETS ? id : undefined);
  const preset = presetKey ? PROVIDER_PRESETS[presetKey] : undefined;

  const doc = readProvidersDoc(resolvedOut);
  const expectedRevision = input.expectedRevision
    ?? (typeof outDir === "object" && outDir ? outDir.expectedRevision : undefined);
  if (expectedRevision !== undefined && expectedRevision !== doc.revision) {
    throw new StudioRevisionConflictError(expectedRevision, doc.revision);
  }

  const existingIdx = doc.providers.findIndex((p) => p.id === id);
  const existing = existingIdx >= 0 ? doc.providers[existingIdx] : undefined;

  const kind = input.kind ?? existing?.kind ?? preset?.kind ?? "cloud-api";
  const protocol: ProviderProtocol = input.protocol
    ?? existing?.protocol
    ?? preset?.protocol
    ?? "openai-compatible";
  if (
    protocol !== "openai-compatible"
    && protocol !== "anthropic-messages"
    && protocol !== "vertex-openai"
  ) {
    throw new StudioValidationError(`Unsupported provider protocol '${String(protocol)}'`);
  }

  const allowPrivateNetwork = input.allowPrivateNetwork
    ?? existing?.allowPrivateNetwork
    ?? preset?.allowPrivateNetwork
    ?? (kind === "local");

  const rawBaseUrl = input.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl ?? "";
  let baseUrl = rawBaseUrl.trim();
  if (baseUrl) {
    baseUrl = validateProviderUrl(baseUrl, { allowPrivateNetwork });
  } else if (protocol !== "vertex-openai") {
    throw new StudioValidationError(`Provider '${id}' requires a valid baseUrl`);
  } else {
    baseUrl = PROVIDER_PRESETS["vertex-ai"]!.baseUrl;
  }

  const authMode: ProviderAuthMode = input.auth?.mode
    ?? existing?.auth?.mode
    ?? preset?.authMode
    ?? (kind === "local" ? "none" : "bearer");

  const secretRef = input.auth?.secretRef ?? existing?.auth?.secretRef ?? `provider:${id}`;

  // Validate/normalize models BEFORE any secret write: a bad model entry must
  // never replace an existing provider's stored credential.
  const models: ProviderModelConfig[] = input.models !== undefined
    ? input.models.map((m) => normalizeModelEntry(m))
    : existing?.models ?? (preset ? structuredClone(preset.defaultModels) : []);

  const rawSecret = input.apiKey
    ?? input.secret
    ?? input.serviceAccountJson
    ?? input.oauthToken
    ?? input.auth?.apiKey
    ?? input.auth?.secret
    ?? input.auth?.token
    ?? input.auth?.serviceAccountJson
    ?? (input.auth?.accessToken
      ? JSON.stringify({
          access_token: input.auth.accessToken,
          refresh_token: input.auth.refreshToken,
        })
      : undefined);

  let parsedProjectId = input.auth?.projectId ?? existing?.auth?.projectId;
  if (typeof rawSecret === "string" && rawSecret.trim().length > 0) {
    if (authMode === "vertex-service-account" || input.serviceAccountJson || input.auth?.serviceAccountJson) {
      try {
        const sa = JSON.parse(rawSecret) as { project_id?: string; client_email?: string; private_key?: string };
        if (sa.project_id && !parsedProjectId) parsedProjectId = sa.project_id;
      } catch {
        // validated on mintVertexAccessToken
      }
    }
    putSecret(secretRef, rawSecret, resolvedOut);
  }

  const now = Date.now();
  const stored: ProviderStored = {
    id,
    label: (input.label ?? existing?.label ?? preset?.label ?? id).trim(),
    preset: presetKey ?? existing?.preset,
    kind,
    protocol,
    baseUrl,
    enabled: input.enabled ?? existing?.enabled ?? true,
    allowPrivateNetwork: Boolean(allowPrivateNetwork),
    headers: input.headers ?? existing?.headers,
    extraBody: input.extraBody ?? existing?.extraBody,
    auth: {
      mode: authMode,
      secretRef,
      clientId: input.auth?.clientId ?? existing?.auth?.clientId ?? preset?.clientId,
      authorizeUrl: input.auth?.authorizeUrl ?? existing?.auth?.authorizeUrl ?? preset?.authorizeUrl,
      tokenUrl: input.auth?.tokenUrl ?? existing?.auth?.tokenUrl ?? preset?.tokenUrl,
      deviceCodeUrl: input.auth?.deviceCodeUrl ?? existing?.auth?.deviceCodeUrl ?? preset?.deviceCodeUrl,
      scopes: input.auth?.scopes ?? existing?.auth?.scopes ?? preset?.scopes,
      projectId: parsedProjectId,
      location: input.auth?.location ?? existing?.auth?.location ?? (protocol === "vertex-openai" ? "global" : undefined),
      projects: normalizeProjectList(input.auth?.projects) ?? existing?.auth?.projects,
    },
    models,
    lastTest: existing?.lastTest ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIdx >= 0) {
    doc.providers[existingIdx] = stored;
  } else {
    doc.providers.push(stored);
  }
  doc.revision += 1;
  doc.updatedAt = now;
  const actor = input.updatedBy ?? (typeof outDir === "object" && outDir ? outDir.updatedBy : undefined) ?? "admin";
  doc.updatedBy = actor;

  atomicWriteJson0600(configFilePath(PROVIDERS_FILENAME, resolvedOut), doc);
  appendAuditLog(existing ? "provider.update" : "provider.create", id, doc.revision, actor, resolvedOut);
  reconcileStagesWithProviders(resolvedOut);

  return toProviderView(stored, doc.revision, resolvedOut);
}

export function deleteProvider(id: string, outDir?: OutDirOrOpts): boolean {
  if (typeof id !== "string" || !id.trim()) return false;
  const resolvedOut = extractOutDir(outDir);
  const targetId = id.trim();
  const doc = readProvidersDoc(resolvedOut);
  const idx = doc.providers.findIndex((p) => p.id === targetId);
  if (idx < 0) return false;
  const [removed] = doc.providers.splice(idx, 1);
  if (removed?.auth?.secretRef) {
    deleteSecret(removed.auth.secretRef, resolvedOut);
  } else {
    deleteSecret(`provider:${targetId}`, resolvedOut);
  }
  doc.revision += 1;
  doc.updatedAt = Date.now();
  const actor = typeof outDir === "object" && outDir?.updatedBy ? outDir.updatedBy : "admin";
  doc.updatedBy = actor;
  atomicWriteJson0600(configFilePath(PROVIDERS_FILENAME, resolvedOut), doc);
  appendAuditLog("provider.delete", targetId, doc.revision, actor, resolvedOut);
  reconcileStagesWithProviders(resolvedOut);
  return true;
}

/* ------------------------------------------------------------------ *
 * OAuth2 PKCE & Vertex Service Account JWT helpers
 * ------------------------------------------------------------------ */

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
  verifier: string;
  challenge: string;
  authorizeUrl?: string;
}

export function createPkceChallenge(
  verifierOrOpts?: string | { verifier?: string; authorizeUrl?: string; clientId?: string; redirectUri?: string; scopes?: string[] },
): PkceChallenge {
  const opts = typeof verifierOrOpts === "object" && verifierOrOpts !== null ? verifierOrOpts : {};
  const rawVerifier = typeof verifierOrOpts === "string" ? verifierOrOpts : opts.verifier;
  const codeVerifier = rawVerifier && rawVerifier.trim().length >= 32
    ? rawVerifier.trim()
    : crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  let authorizeUrl: string | undefined;
  const baseAuthUrl = opts.authorizeUrl;
  if (baseAuthUrl) {
    const u = new URL(baseAuthUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", opts.clientId || PROVIDER_PRESETS["codex-oauth"]!.client_id!);
    if (opts.redirectUri) u.searchParams.set("redirect_uri", opts.redirectUri);
    u.searchParams.set("scope", (opts.scopes ?? ["openid", "profile", "email", "offline_access"]).join(" "));
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    // Anthropic's console callback shows `<code>#<state>`; `code=true` selects it.
    if (baseAuthUrl.includes("claude.ai")) u.searchParams.set("code", "true");
    // Google only returns a `refresh_token` with an offline grant plus explicit consent.
    if (baseAuthUrl.includes("accounts.google.com")) {
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("token_usage", "remote");
    }
    authorizeUrl = u.toString();
  }

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
    state,
    verifier: codeVerifier,
    challenge: codeChallenge,
    authorizeUrl,
  };
}

export interface ExchangePkceParams {
  tokenUrl?: string;
  token_url?: string;
  clientId?: string;
  client_id?: string;
  clientSecret?: string;
  client_secret?: string;
  code: string;
  codeVerifier?: string;
  code_verifier?: string;
  verifier?: string;
  redirectUri?: string;
  redirect_uri?: string;
  providerId?: string;
  secretRef?: string;
  outDir?: string;
  fetchFn?: typeof fetch;
}

export interface ExchangePkceResult {
  accessToken: string;
  access_token: string;
  refreshToken?: string;
  refresh_token?: string;
  idToken?: string;
  id_token?: string;
  expiresIn?: number;
  expiresAt?: number;
  tokenType: string;
  secretMeta?: { hasSecret: boolean; hint: string; updatedAt: number };
}

export async function exchangePkceToken(params: ExchangePkceParams): Promise<ExchangePkceResult> {
  if (!params || typeof params.code !== "string" || !params.code.trim()) {
    throw new StudioValidationError("Authorization code is required for PKCE token exchange");
  }
  const verifier = params.codeVerifier ?? params.code_verifier ?? params.verifier ?? "";
  if (!verifier.trim()) {
    throw new StudioValidationError("codeVerifier is required for PKCE token exchange");
  }
  const preset = params.providerId ? PROVIDER_PRESETS[params.providerId] : PROVIDER_PRESETS["codex-oauth"];
  const tokenUrl = params.tokenUrl ?? params.token_url ?? preset?.tokenUrl ?? "https://auth.openai.com/oauth/token";
  validateProviderUrl(tokenUrl, { allowPrivateNetwork: false });

  const clientId = params.clientId
    ?? params.client_id
    ?? preset?.client_id
    ?? preset?.clientId
    ?? (params.providerId === "vertex-ai" ? resolveVertexOAuthClientId() : PROVIDER_PRESETS["codex-oauth"]!.client_id!);
  const redirectUri = params.redirectUri ?? params.redirect_uri;

  // Google's installed-app clients require the client secret on the code
  // exchange. The public Cloud SDK client ships one, so default to it.
  const googleTokenEndpoint = tokenUrl.includes("googleapis.com")
    || tokenUrl.includes("accounts.google.com");
  const clientSecret = (
    params.clientSecret
    ?? params.client_secret
    ?? (params.providerId === "vertex-ai" || googleTokenEndpoint
      ? (clientId === VERTEX_OAUTH_DEFAULT_CLIENT_ID ? VERTEX_OAUTH_DEFAULT_CLIENT_SECRET : undefined)
      : undefined)
    ?? ""
  ).trim();

  // Anthropic's callback page returns `<code>#<state>`. Split it, and send JSON
  // because the console token endpoint rejects a form-encoded body.
  const anthropic = params.providerId === "claude-oauth" || tokenUrl.includes("anthropic.com");
  const [cleanCode, statePart] = anthropic ? params.code.trim().split("#") : [params.code.trim(), undefined];
  const useJsonBody = anthropic && (Boolean(statePart) || tokenUrl.includes("anthropic.com"));

  const doFetch = params.fetchFn ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | URLSearchParams;
  if (useJsonBody) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      code: cleanCode,
      ...(statePart ? { state: statePart } : {}),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      code_verifier: verifier.trim(),
    });
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: cleanCode ?? params.code.trim(),
      code_verifier: verifier.trim(),
    });
    if (redirectUri) form.set("redirect_uri", redirectUri);
    if (clientSecret) form.set("client_secret", clientSecret);
    body = form;
  }

  const res = await doFetch(tokenUrl, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
    throw new StudioConfigError(`PKCE token exchange failed (HTTP ${res.status}): ${errText}`, 502, "oauth_exchange_failed");
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    id_token?: string;
  };
  if (!data.access_token || typeof data.access_token !== "string") {
    throw new StudioConfigError("PKCE token response did not include access_token", 502, "oauth_exchange_failed");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const ref = params.secretRef ?? (params.providerId ? `provider:${params.providerId}` : undefined);
  let secretMeta: { hasSecret: boolean; hint: string; updatedAt: number } | undefined;
  if (ref) {
    secretMeta = putSecret(
      ref,
      JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
        token_url: tokenUrl,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(typeof data.id_token === "string" && data.id_token.trim()
          ? { id_token: data.id_token.trim() }
          : {}),
      }),
      params.outDir,
    );
  }

  return {
    accessToken: data.access_token,
    access_token: data.access_token,
    refreshToken: data.refresh_token,
    refresh_token: data.refresh_token,
    ...(data.id_token ? { idToken: data.id_token, id_token: data.id_token } : {}),
    expiresIn,
    expiresAt,
    tokenType: data.token_type ?? "Bearer",
    secretMeta,
  };
}

interface VertexTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
  projectId?: string;
  clientEmail: string;
}

const vertexJwtCache = new Map<string, VertexTokenCacheEntry>();

export interface MintVertexTokenOptions {
  fetchFn?: typeof fetch;
  scope?: string;
  nowSec?: number;
  forceRefresh?: boolean;
}

export interface MintVertexTokenResult {
  accessToken: string;
  access_token: string;
  expiresAt: number;
  expiresIn: number;
  projectId?: string;
  clientEmail: string;
  jwtAssertion: string;
}

export async function mintVertexAccessToken(
  serviceAccountInput: string | Record<string, unknown>,
  opts?: MintVertexTokenOptions,
): Promise<MintVertexTokenResult> {
  let parsed: Record<string, unknown>;
  if (typeof serviceAccountInput === "string") {
    try {
      parsed = JSON.parse(serviceAccountInput) as Record<string, unknown>;
    } catch {
      throw new StudioValidationError("Invalid Vertex Service Account JSON");
    }
  } else if (serviceAccountInput && typeof serviceAccountInput === "object") {
    parsed = serviceAccountInput;
  } else {
    throw new StudioValidationError("Vertex Service Account credentials are required");
  }

  const clientEmail = String(parsed.client_email ?? parsed.clientEmail ?? "").trim();
  const privateKey = String(parsed.private_key ?? parsed.privateKey ?? "").replace(/\\n/g, "\n").trim();
  const projectId = typeof (parsed.project_id ?? parsed.projectId) === "string"
    ? String(parsed.project_id ?? parsed.projectId).trim()
    : undefined;
  const tokenUri = String(parsed.token_uri ?? parsed.tokenUri ?? "https://oauth2.googleapis.com/token").trim();

  if (!clientEmail || !clientEmail.includes("@")) {
    throw new StudioValidationError("Vertex Service Account JSON is missing a valid client_email");
  }
  if (!privateKey || !privateKey.includes("PRIVATE KEY")) {
    throw new StudioValidationError("Vertex Service Account JSON is missing a PEM private_key");
  }
  validateProviderUrl(tokenUri, { allowPrivateNetwork: false });

  const scope = opts?.scope ?? "https://www.googleapis.com/auth/cloud-platform";
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const cacheKey = `${clientEmail}:${scope}:${tokenUri}`;

  if (!opts?.forceRefresh && !opts?.fetchFn && opts?.nowSec === undefined) {
    const cached = vertexJwtCache.get(cacheKey);
    if (cached && nowSec < cached.expiresAt - 120) {
      return {
        accessToken: cached.accessToken,
        access_token: cached.accessToken,
        expiresAt: cached.expiresAt,
        expiresIn: Math.max(0, cached.expiresAt - nowSec),
        projectId: cached.projectId,
        clientEmail: cached.clientEmail,
        jwtAssertion: "",
      };
    }
  }

  const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
  const claimB64 = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      scope,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
    "utf8",
  ).toString("base64url");

  const signingInput = `${headerB64}.${claimB64}`;
  let signatureB64: string;
  try {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signatureB64 = signer.sign(privateKey, "base64url");
  } catch (err) {
    throw new StudioValidationError(
      `Failed to sign Vertex Service Account JWT: ${scrubSecrets((err as Error).message)}`,
    );
  }

  const jwtAssertion = `${signingInput}.${signatureB64}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtAssertion,
  });

  const doFetch = opts?.fetchFn ?? fetch;
  const res = await doFetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
    throw new StudioConfigError(`Vertex token exchange failed (HTTP ${res.status}): ${errText}`, 502, "vertex_auth_failed");
  }

  const tokenData = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!tokenData.access_token || typeof tokenData.access_token !== "string") {
    throw new StudioConfigError("Vertex token response missing access_token", 502, "vertex_auth_failed");
  }

  const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
  const expiresAt = nowSec + expiresIn;
  vertexJwtCache.set(cacheKey, {
    accessToken: tokenData.access_token,
    expiresAt,
    projectId,
    clientEmail,
  });

  return {
    accessToken: tokenData.access_token,
    access_token: tokenData.access_token,
    expiresAt,
    expiresIn,
    projectId,
    clientEmail,
    jwtAssertion,
  };
}

/* ------------------------------------------------------------------ *
 * Vertex AI OAuth sign-in (mode B: Google OAuth token + projectId/location)
 * ------------------------------------------------------------------ */

export const VERTEX_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/auth";
export const VERTEX_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
/**
 * Hosted callback of the Google Cloud SDK (`gcloud auth application-default
 * login --no-launch-browser`). Google shows the authorization code there, so a
 * phone or a headless host never lands on a dead `localhost` page.
 */
export const VERTEX_OAUTH_REDIRECT_URI = "https://sdk.cloud.google.com/applicationdefaultauthcode.html";
export const VERTEX_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Scopes the Google Cloud SDK requests for application-default credentials. */
export const VERTEX_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/sqlservice.login",
];
/** Public OAuth client used by the Google Cloud CLI; overridable per request or by env. */
export const VERTEX_OAUTH_DEFAULT_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
/** Installed-app secret shipped with the same public CLI client. */
export const VERTEX_OAUTH_DEFAULT_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";

/** Resolve the Google OAuth client_id: env first, then the public CLI default. */
export function resolveVertexOAuthClientId(explicit?: string): string {
  const chosen = (explicit ?? "").trim() || (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  return chosen || VERTEX_OAUTH_DEFAULT_CLIENT_ID;
}

/**
 * Build the Google OAuth consent URL for Vertex AI mode B.
 * The user signs in, then pastes the authorization code or the access/refresh token.
 */
export function buildVertexOAuthUrl(params?: {
  clientId?: string;
  redirectUri?: string;
  state?: string;
  scope?: string;
  prompt?: string;
  accessType?: string;
}): string {
  const clientId = resolveVertexOAuthClientId(params?.clientId);
  const url = new URL(VERTEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params?.redirectUri ?? VERTEX_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params?.scope ?? VERTEX_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", params?.accessType ?? "offline");
  url.searchParams.set("prompt", params?.prompt ?? "consent");
  // Google's SDK callback page shows the code; `remote` keeps the flow headless.
  url.searchParams.set("token_usage", "remote");
  if (params?.state) url.searchParams.set("state", params.state);
  return url.toString();
}

export interface VertexOAuthSecret {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  expires_at?: number;
  expiresAt?: number;
  token_type?: string;
  client_id?: string;
  clientId?: string;
  client_secret?: string;
  clientSecret?: string;
}

/** True when the stored secret is a Google OAuth token blob, not a Service Account key. */
export function isVertexOAuthSecret(rawSecret: string | null | undefined): boolean {
  if (typeof rawSecret !== "string") return false;
  const trimmed = rawSecret.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const hasSa = Boolean(parsed.client_email || parsed.private_key);
    if (hasSa) return false;
    const accessToken = [parsed.access_token, parsed.accessToken]
      .find((v): v is string => typeof v === "string")
      ?.trim() ?? "";
    const refreshToken = [parsed.refresh_token, parsed.refreshToken]
      .find((v): v is string => typeof v === "string")
      ?.trim() ?? "";
    return Boolean(accessToken || refreshToken);
  } catch {
    return false;
  }
}

/**
 * Resolve a usable Vertex AI access token from an OAuth secret blob.
 * Refreshes with the stored refresh_token when the access token is missing or near expiry.
 */
export async function resolveVertexOAuthAccessToken(
  rawSecret: string | null | undefined,
  opts?: {
    fetchFn?: typeof fetch;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    nowSec?: number;
    forceRefresh?: boolean;
  },
): Promise<{ accessToken: string; access_token: string; expiresAt: number | null; projectId?: string }> {
  const trimmed = (rawSecret ?? "").trim();
  if (!trimmed) {
    throw new StudioValidationError("Vertex OAuth token is required");
  }
  if (!trimmed.startsWith("{")) {
    return { accessToken: trimmed, access_token: trimmed, expiresAt: null };
  }
  let parsed: VertexOAuthSecret;
  try {
    parsed = JSON.parse(trimmed) as VertexOAuthSecret;
  } catch {
    return { accessToken: trimmed, access_token: trimmed, expiresAt: null };
  }
  const accessToken = (parsed.access_token ?? parsed.accessToken ?? "").trim();
  const refreshToken = (parsed.refresh_token ?? parsed.refreshToken ?? "").trim();
  const expiresAt = typeof parsed.expires_at === "number"
    ? parsed.expires_at
    : typeof parsed.expiresAt === "number"
      ? parsed.expiresAt
      : null;
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);

  if (!opts?.forceRefresh && accessToken && (expiresAt === null || nowSec < expiresAt - 60)) {
    return { accessToken, access_token: accessToken, expiresAt };
  }
  if (!refreshToken) {
    if (accessToken) return { accessToken, access_token: accessToken, expiresAt };
    throw new StudioValidationError("Vertex OAuth secret has neither an access_token nor a refresh_token");
  }

  const tokenUrl = opts?.tokenUrl ?? VERTEX_OAUTH_TOKEN_URL;
  validateProviderUrl(tokenUrl, { allowPrivateNetwork: false });
  // A stored blob carries the client that minted the refresh token, so it wins
  // over the provider/env value; the public CLI default is the last resort.
  const storedClientId = [parsed.client_id, parsed.clientId]
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const clientId = resolveVertexOAuthClientId(storedClientId ?? opts?.clientId);
  const storedClientSecret = [parsed.client_secret, parsed.clientSecret]
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  // The public Cloud SDK client needs its shipped secret; a stored blob carries
  // the client that minted the refresh token, so it wins over env/default.
  const defaultClientSecret = clientId === VERTEX_OAUTH_DEFAULT_CLIENT_ID
    ? VERTEX_OAUTH_DEFAULT_CLIENT_SECRET
    : "";
  const clientSecret = (
    storedClientSecret
    ?? opts?.clientSecret
    ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET
    ?? defaultClientSecret
    ?? ""
  ).trim();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const doFetch = opts?.fetchFn ?? fetch;
  const res = await doFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const errText = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
    throw new StudioConfigError(
      `Vertex OAuth token refresh failed (HTTP ${res.status}): ${errText}`,
      502,
      "vertex_auth_failed",
    );
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token || typeof data.access_token !== "string") {
    throw new StudioConfigError("Vertex OAuth refresh response missing access_token", 502, "vertex_auth_failed");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    access_token: data.access_token,
    expiresAt: nowSec + expiresIn,
  };
}

/* ------------------------------------------------------------------ *
 * Vertex project discovery (Google Cloud Resource Manager)
 * ------------------------------------------------------------------ */

export const CLOUD_RESOURCE_MANAGER_PROJECTS_URL =
  "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE";

export interface VertexProject {
  projectId: string;
  name: string;
}

/**
 * List the caller's ACTIVE Google Cloud projects with a Bearer access token.
 * Returns `[]` when the API answers a non-2xx (no scope, revoked token), so a
 * login flow can still finish and let the user type a project id by hand.
 */
export async function discoverVertexProjects(
  accessToken: string,
  fetchFn?: typeof fetch,
): Promise<VertexProject[]> {
  const token = String(accessToken ?? "").trim();
  if (!token) throw new StudioValidationError("A Google access token is required to list Cloud projects");
  const doFetch = fetchFn ?? fetch;
  const out: VertexProject[] = [];
  const seen = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  // Resource Manager pages at 50 projects; follow `nextPageToken` until the API
  // stops returning one. The token set guards against an upstream loop.
  for (let page = 0; page < 50; page += 1) {
    const url = pageToken
      ? `${CLOUD_RESOURCE_MANAGER_PROJECTS_URL}&pageToken=${encodeURIComponent(pageToken)}`
      : CLOUD_RESOURCE_MANAGER_PROJECTS_URL;
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return out;
    const body = (await res.json().catch(() => null)) as { projects?: unknown; nextPageToken?: unknown } | null;
    const list = Array.isArray(body?.projects) ? body.projects : [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const projectId = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
      if (!projectId || seen.has(projectId)) continue;
      seen.add(projectId);
      const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : projectId;
      out.push({ projectId, name });
    }
    const next = typeof body?.nextPageToken === "string" ? body.nextPageToken.trim() : "";
    if (!next || seenPageTokens.has(next)) break;
    seenPageTokens.add(next);
    pageToken = next;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Provider connection test & model discovery
 * ------------------------------------------------------------------ */

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: ProviderModelCapabilities;
  contextWindow?: number;
  /** Reasoning effort the endpoint/preset declares, carried into persistence. */
  reasoningEffort?: ReasoningEffort | null;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  testedAt: number;
  models: DiscoveredModel[];
  error: string | null;
}

export interface ProviderProbeOptions {
  outDir?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Persist discovered models into `providers.json` (default true for stored providers). */
  persist?: boolean;
}

function normalizeProbeOpts(opts?: string | ProviderProbeOptions): ProviderProbeOptions {
  if (typeof opts === "string") return { outDir: opts };
  return opts ?? {};
}

/**
 * Decode a JWT payload without verifying the signature. Only used to read
 * public claims (the ChatGPT account id) out of a subscription access token.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.trim().split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * ChatGPT account id of an OAuth access token: `chatgpt_account_id` at the top
 * level, or under the `https://api.openai.com/auth` claim.
 */
export function extractChatGptAccountId(jwt: string): string | undefined {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return undefined;
  const direct = typeof payload.chatgpt_account_id === "string" ? payload.chatgpt_account_id.trim() : "";
  if (direct) return direct;
  const auth = payload["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const nested = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return undefined;
}

/** True for a ChatGPT subscription access token (OAuth JWT carrying the OpenAI auth claim). */
export function isChatGptSubscriptionToken(token: string | null | undefined): boolean {
  if (typeof token !== "string" || token.trim().split(".").length < 3) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  return Boolean(payload["https://api.openai.com/auth"]) || Boolean(extractChatGptAccountId(token));
}

/** True when the provider is the ChatGPT subscription preset (`codex-oauth`). */
export function isCodexOauthProvider(provider: { id?: string; preset?: string } | null | undefined): boolean {
  return Boolean(provider && (provider.id === "codex-oauth" || provider.preset === "codex-oauth"));
}

/** Real Codex model catalog for ChatGPT subscription tokens (not the billed API). */
const CHATGPT_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
const OPENCODE_USER_AGENT = "opencode/production/2.0.26/opencode";

/** Access token from a raw secret: a bare token or an OAuth JSON blob. */
function extractBearerAccessToken(rawSecret: string | null | undefined): string {
  if (typeof rawSecret !== "string") return "";
  const trimmed = rawSecret.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { access_token?: unknown; accessToken?: unknown };
      const token = typeof parsed.access_token === "string"
        ? parsed.access_token
        : typeof parsed.accessToken === "string"
          ? parsed.accessToken
          : "";
      if (token.trim()) return token.trim();
    } catch {
      // fall through: treat as a plain token
    }
  }
  return trimmed;
}

/**
 * `GET https://chatgpt.com/backend-api/codex/models` with a ChatGPT JWT.
 * Returns `[]` on any failure so the caller can fall back to the preset catalog.
 */
async function discoverCodexModels(
  rawSecret: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<DiscoveredModel[]> {
  const accessToken = extractBearerAccessToken(rawSecret);
  if (!accessToken) return [];
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    originator: "opencode",
    "User-Agent": OPENCODE_USER_AGENT,
  };
  const accountId = extractChatGptAccountId(accessToken);
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const res = await doFetch(CHATGPT_CODEX_MODELS_URL, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!res || !res.ok) return [];

  type RawCodexModel = {
    id?: string;
    slug?: string;
    title?: string;
    display_name?: string;
    visibility?: string;
    context_window?: number;
    contextWindow?: number;
  };
  const body = (await res.json().catch(() => null)) as
    | { models?: RawCodexModel[]; data?: RawCodexModel[] }
    | null;
  if (!body) return [];
  const list: RawCodexModel[] = Array.isArray(body.models)
    ? body.models
    : Array.isArray(body.data)
      ? body.data
      : [];

  return list
    .filter((item) => String(item.visibility ?? "").trim().toLowerCase() !== "hide")
    .map((item) => {
      const id = String(item.slug ?? item.id ?? "").trim();
      if (!id) return null;
      const label = String(item.title ?? item.display_name ?? item.slug ?? id).trim() || id;
      // Every Codex backend model is a reasoning model. Prefer the preset's
      // exact capability set and effort when the id is known there.
      const preset = (PROVIDER_PRESETS["codex-oauth"]?.defaultModels ?? []).find((m) => m.id === id);
      return {
        id,
        label,
        capabilities: preset
          ? { ...preset.capabilities }
          : inferDiscoveredCapabilities(id, { vision: true, writer: true, reasoning: true }),
        contextWindow: item.context_window ?? item.contextWindow,
        reasoningEffort: preset?.reasoningEffort ?? "high",
      } as DiscoveredModel;
    })
    .filter((item): item is DiscoveredModel => item !== null);
}

async function resolveProviderProbeTarget(
  idOrInput: string | ProviderUpsertInput,
  opts: ProviderProbeOptions,
): Promise<{
  providerId: string;
  persisted: boolean;
  protocol: ProviderProtocol;
  baseUrl: string;
  headers: Record<string, string>;
  defaultModels: ProviderModelConfig[];
  preset?: string;
  /** Raw secret as stored, so probes can tell a ChatGPT JWT from an API key. */
  rawSecret: string | null;
}> {
  const outDir = extractOutDir(opts.outDir);
  const doc = readProvidersDoc(outDir);
  let stored: ProviderStored | undefined;
  let inlineSecret: string | undefined;

  if (typeof idOrInput === "string") {
    stored = doc.providers.find((p) => p.id === idOrInput.trim());
    if (!stored) {
      throw new StudioValidationError(`Unknown provider '${idOrInput}'`);
    }
  } else if (idOrInput && typeof idOrInput === "object") {
    const existing = idOrInput.id ? doc.providers.find((p) => p.id === idOrInput.id.trim()) : undefined;
    const presetKey = idOrInput.preset || (idOrInput.id && idOrInput.id in PROVIDER_PRESETS ? idOrInput.id : undefined);
    const preset = presetKey ? PROVIDER_PRESETS[presetKey] : undefined;
    const kind = idOrInput.kind ?? existing?.kind ?? preset?.kind ?? "cloud-api";
    const protocol = idOrInput.protocol ?? existing?.protocol ?? preset?.protocol ?? "openai-compatible";
    const allowPrivateNetwork = idOrInput.allowPrivateNetwork
      ?? existing?.allowPrivateNetwork
      ?? preset?.allowPrivateNetwork
      ?? (kind === "local");
    const baseUrl = validateProviderUrl(
      idOrInput.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl ?? "",
      { allowPrivateNetwork },
    );
    inlineSecret = idOrInput.apiKey
      ?? idOrInput.secret
      ?? idOrInput.serviceAccountJson
      ?? idOrInput.oauthToken
      ?? idOrInput.auth?.apiKey
      ?? idOrInput.auth?.secret
      ?? idOrInput.auth?.token
      ?? idOrInput.auth?.serviceAccountJson
      ?? (idOrInput.auth?.accessToken
        ? JSON.stringify({
            access_token: idOrInput.auth.accessToken,
            refresh_token: idOrInput.auth.refreshToken,
          })
        : undefined);
    stored = {
      id: idOrInput.id || "probe",
      label: idOrInput.label ?? existing?.label ?? preset?.label ?? "probe",
      preset: presetKey,
      kind,
      protocol,
      baseUrl,
      enabled: true,
      allowPrivateNetwork: Boolean(allowPrivateNetwork),
      headers: idOrInput.headers ?? existing?.headers,
      auth: {
        mode: idOrInput.auth?.mode ?? existing?.auth?.mode ?? preset?.authMode ?? "bearer",
        secretRef: idOrInput.auth?.secretRef ?? existing?.auth?.secretRef ?? `provider:${idOrInput.id || "probe"}`,
        clientId: idOrInput.auth?.clientId ?? existing?.auth?.clientId ?? preset?.clientId,
        tokenUrl: idOrInput.auth?.tokenUrl ?? existing?.auth?.tokenUrl ?? preset?.tokenUrl,
        projectId: idOrInput.auth?.projectId ?? existing?.auth?.projectId,
        location: idOrInput.auth?.location ?? existing?.auth?.location ?? "global",
      },
      models: existing?.models ?? preset?.defaultModels ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else {
    throw new StudioValidationError("Provider id or config object required");
  }

  validateProviderUrl(stored.baseUrl, { allowPrivateNetwork: stored.allowPrivateNetwork });

  const rawSecret = inlineSecret ?? getSecret(stored.auth.secretRef || `provider:${stored.id}`, outDir);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(stored.headers ?? {}),
  };

  let resolvedBaseUrl = stored.baseUrl;
  let vertexSecretOrNull: string | null = null;

  if (
    stored.auth.mode === "vertex-service-account"
    || stored.auth.mode === "vertex-oauth"
    || stored.protocol === "vertex-openai"
  ) {
    // Credentials come only from the Studio store (`providers.json` +
    // `secrets.json`). No host ADC file and no hardcoded host path.
    const vertexSecret = rawSecret;
    if (!vertexSecret) {
      throw new StudioValidationError(`Provider '${stored.id}' has no Vertex credential configured`);
    }
    vertexSecretOrNull = vertexSecret;
    const oauthMode = stored.auth.mode === "vertex-oauth" || isVertexOAuthSecret(vertexSecret);
    let accessToken: string;
    let mintedProjectId: string | undefined;
    if (oauthMode) {
      const resolved = await resolveVertexOAuthAccessToken(vertexSecret, {
        fetchFn: opts.fetchFn,
        clientId: stored.auth.clientId ?? PROVIDER_PRESETS["vertex-ai"]?.clientId,
        tokenUrl: stored.auth.tokenUrl,
      });
      accessToken = resolved.accessToken;
      mintedProjectId = resolved.projectId;
    } else {
      const minted = await mintVertexAccessToken(vertexSecret, { fetchFn: opts.fetchFn });
      accessToken = minted.accessToken;
      mintedProjectId = minted.projectId;
    }
    const projectId = stored.auth.projectId || mintedProjectId;
    if (!projectId) {
      throw new StudioValidationError(`Provider '${stored.id}' is missing Vertex projectId`);
    }
    const location = stored.auth.location || "global";
    resolvedBaseUrl = stored.baseUrl
      .replace(/\{projectId\}/g, projectId)
      .replace(/\{p\}/g, projectId)
      .replace(/\{location\}/g, location)
      .replace(/\{r\}/g, location);
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (stored.protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (rawSecret) {
      let token = rawSecret;
      try {
        const parsed = JSON.parse(rawSecret) as { access_token?: string };
        if (parsed.access_token) token = parsed.access_token;
      } catch {
        // raw key string
      }
      if (stored.auth.mode === "oauth-pkce" || stored.preset === "claude-oauth" || token.startsWith("sk-ant-oat")) {
        headers.Authorization = `Bearer ${token}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
      } else {
        headers["x-api-key"] = token;
        headers.Authorization = `Bearer ${token}`;
      }
    }
  } else if (stored.auth.mode !== "none" && rawSecret) {
    let token = rawSecret;
    try {
      const parsed = JSON.parse(rawSecret) as { access_token?: string };
      if (parsed.access_token) token = parsed.access_token;
    } catch {
      // raw key string
    }
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    providerId: stored.id,
    persisted: doc.providers.some((p) => p.id === stored!.id),
    protocol: stored.protocol,
    baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
    headers,
    defaultModels: stored.models,
    preset: stored.preset,
    rawSecret: rawSecret ?? vertexSecretOrNull,
  };
}

export async function discoverProviderModels(
  idOrInput: string | ProviderUpsertInput,
  rawOpts?: string | ProviderProbeOptions,
): Promise<DiscoveredModel[]> {
  const opts = normalizeProbeOpts(rawOpts);
  const target = await resolveProviderProbeTarget(idOrInput, opts);
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const modelsUrl = `${target.baseUrl}/models`;

  // ChatGPT subscription OAuth tokens are not billed API keys: `GET /models`
  // answers 401/403/429 (or the token is a ChatGPT JWT). Fall back to the
  // preset catalog instead of failing discovery.
  const codexOauth = isCodexOauthProvider({ id: target.providerId, preset: target.preset })
    || isChatGptSubscriptionToken(target.rawSecret);
  const codexFallback = (): DiscoveredModel[] =>
    (PROVIDER_PRESETS["codex-oauth"]?.defaultModels ?? []).map((m) => ({
      id: m.id,
      label: m.label,
      capabilities: { ...m.capabilities },
      contextWindow: m.contextWindow,
    }));

  // Vertex's OpenAI-compatible endpoint has no `GET /models` route. When a real
  // inference probe succeeds, advertise the known catalog instead of failing
  // discovery on a route the provider never had.
  const vertexOpenAi = target.protocol === "vertex-openai"
    || target.baseUrl.includes("endpoints/openapi");
  const vertexCatalogFallback = async (): Promise<DiscoveredModel[] | null> => {
    if (!vertexOpenAi) return null;
    const probe = await probeProviderInference(idOrInput, opts);
    if (!probe.ok) return null;
    const catalog = target.defaultModels.length > 0
      ? target.defaultModels
      : (PROVIDER_PRESETS["vertex-ai"]?.defaultModels ?? []);
    const discovered = catalog.map((m) => ({
      id: m.id,
      label: m.label,
      capabilities: { ...m.capabilities },
      contextWindow: m.contextWindow,
      reasoningEffort: m.reasoningEffort ?? null,
    })) as DiscoveredModel[];
    if (discovered.length > 0 && target.persisted && opts.persist !== false) {
      persistDiscoveredModels(target.providerId, discovered, opts.outDir);
    }
    return discovered;
  };

  // A ChatGPT subscription token lists its real catalog on the Codex backend,
  // not on `api.openai.com/v1/models`. Ask that endpoint first.
  if (
    isCodexOauthProvider({ id: target.providerId, preset: target.preset })
    && isChatGptSubscriptionToken(extractBearerAccessToken(target.rawSecret))
    && (target.baseUrl === "https://api.openai.com/v1" || target.baseUrl.includes("chatgpt.com"))
  ) {
    const codexModels = await discoverCodexModels(target.rawSecret!, doFetch, timeoutMs);
    if (codexModels.length === 0) return codexFallback();
    if (target.persisted && opts.persist !== false) {
      persistDiscoveredModels(target.providerId, codexModels, opts.outDir);
    }
    return codexModels;
  }

  const res = await doFetch(modelsUrl, {
    method: "GET",
    headers: target.headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    if (codexOauth || vertexOpenAi) return null;
    throw err;
  });

  if (!res) {
    if (codexOauth) return codexFallback();
    if (vertexOpenAi) {
      const fallback = await vertexCatalogFallback().catch(() => null);
      if (fallback) return fallback;
    }
    throw new StudioConfigError(
      `Model discovery failed for '${target.providerId}': endpoint unreachable`,
      502,
      "discovery_failed",
    );
  }

  if (!res.ok) {
    const bodyText = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
    if (codexOauth && (res.status === 401 || res.status === 403 || res.status === 429)) {
      return codexFallback();
    }
    if (vertexOpenAi && res.status !== 401 && res.status !== 403) {
      const fallback = await vertexCatalogFallback().catch(() => null);
      if (fallback) return fallback;
    }
    if (res.status === 404 || res.status === 405) {
      const catalogFallback = await vertexCatalogFallback();
      if (catalogFallback) return catalogFallback;
    }
    throw new StudioConfigError(
      `Model discovery failed for '${target.providerId}' (HTTP ${res.status}): ${bodyText}`,
      502,
      "discovery_failed",
    );
  }

  type RawDiscoveredModel = {
    id?: string;
    name?: string;
    display_name?: string;
    displayName?: string;
    context_length?: number;
    contextWindow?: number;
    inputTokenLimit?: number;
    capabilities?: Partial<ProviderModelCapabilities>;
  };
  const payload = (await res.json()) as {
    data?: RawDiscoveredModel[];
    models?: RawDiscoveredModel[];
  };

  const list: RawDiscoveredModel[] = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  const discovered = list
    .map((item) => {
      const raw = String(item.id ?? item.name ?? "").replace(/^models\//, "").trim();
      if (!raw) return null;
      // `/models` already returns bare ids; strip only a redundant `<providerId>/` prefix.
      const id = stripProviderPrefix(raw, target.providerId);
      if (!id) return null;
      const label = String(item.display_name ?? item.displayName ?? "").trim() || id;
      const capabilities = inferDiscoveredCapabilities(id, item.capabilities);
      return {
        id,
        label,
        capabilities,
        contextWindow: item.context_length ?? item.contextWindow ?? item.inputTokenLimit,
      } as DiscoveredModel;
    })
    .filter((item): item is DiscoveredModel => item !== null);

  if (discovered.length > 0 && target.persisted && opts.persist !== false) {
    persistDiscoveredModels(target.providerId, discovered, opts.outDir);
  }
  return discovered;
}

/** Drop a redundant `<providerId>/` prefix so ids match what `/models` returns bare. */
function stripProviderPrefix(modelId: string, providerId: string): string {
  if (providerId.toLowerCase() === "openrouter" && modelId.toLowerCase() === "openrouter/auto") {
    return modelId;
  }
  const prefix = `${providerId}/`;
  if (providerId && modelId.toLowerCase().startsWith(prefix.toLowerCase())) {
    const stripped = modelId.slice(prefix.length).trim();
    if (stripped) return stripped;
  }
  return modelId;
}

/** Vision/writer inference for a discovered model id, honouring explicit capability flags. */
function inferDiscoveredCapabilities(
  id: string,
  declared?: Partial<ProviderModelCapabilities>,
): ProviderModelCapabilities {
  const norm = normalizeModelEntry(id);
  const base = norm.capabilities;
  if (!declared) return base;
  const vision = declared.vision === undefined ? base.vision : Boolean(declared.vision);
  return {
    vision,
    writer: declared.writer === undefined ? true : Boolean(declared.writer),
    json: declared.json === undefined ? true : Boolean(declared.json),
    reasoning: declared.reasoning === undefined ? base.reasoning : Boolean(declared.reasoning),
    streaming: declared.streaming === undefined ? true : Boolean(declared.streaming),
    tts: declared.tts === undefined ? false : Boolean(declared.tts),
    image: declared.image === undefined ? false : Boolean(declared.image),
  };
}

/** Replace the stored provider's model list, keeping operator flags for surviving ids. */
function persistDiscoveredModels(
  providerId: string,
  models: DiscoveredModel[],
  outDir?: OutDirOrOpts,
): void {
  const doc = readProvidersDoc(outDir);
  const found = doc.providers.find((p) => p.id === providerId);
  if (!found) return;
  // The provider's own preset is the authority for capability/effort defaults,
  // so a discovery pass never downgrades a known reasoning model.
  const presetModels = (found.preset && PROVIDER_PRESETS[found.preset]?.defaultModels) || [];
  found.models = models.map((m) => {
    const previous = found.models.find((p) => p.id === m.id);
    const preset = presetModels.find((p) => p.id === m.id);
    return normalizeModelEntry({
      id: m.id,
      label: previous?.label ?? m.label,
      enabled: previous?.enabled ?? true,
      capabilities: {
        ...(preset ? { ...preset.capabilities } : {}),
        ...m.capabilities,
        vision: m.capabilities.vision
          || Boolean(previous?.capabilities?.vision)
          || Boolean(preset?.capabilities.vision),
        reasoning: m.capabilities.reasoning
          || Boolean(previous?.capabilities?.reasoning)
          || Boolean(preset?.capabilities.reasoning),
      },
      contextWindow: m.contextWindow ?? previous?.contextWindow ?? preset?.contextWindow,
      maxOutputTokens: previous?.maxOutputTokens ?? preset?.maxOutputTokens,
      reasoningEffort: previous?.reasoningEffort ?? m.reasoningEffort ?? preset?.reasoningEffort ?? null,
      thinking: previous?.thinking ?? null,
      stream: previous?.stream ?? false,
      costTier: previous?.costTier ?? preset?.costTier ?? "paid",
    });
  });
  found.updatedAt = Date.now();
  doc.revision += 1;
  doc.updatedAt = found.updatedAt;
  atomicWriteJson0600(configFilePath(PROVIDERS_FILENAME, outDir), doc);
  appendAuditLog("provider.models.discover", providerId, doc.revision, "system", outDir);
  // A discovery pass can drop a model a stage chain still points at; remap the
  // chain now so the next run does not fail at model resolution.
  reconcileStagesWithProviders(outDir);
}

/**
 * Minimal inference probe for endpoints that do not expose `GET /models`
 * (`anthropic-messages`, or a custom endpoint that 404s on `/models`).
 *
 * Sends one `max_tokens: 1` turn to `/messages` or `/chat/completions` and
 * reports whether the provider answered with a 2xx.
 */
export async function probeProviderInference(
  idOrInput: string | ProviderUpsertInput,
  rawOpts?: string | ProviderProbeOptions,
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const opts = normalizeProbeOpts(rawOpts);
  const target = await resolveProviderProbeTarget(idOrInput, opts);
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const rawModel = target.defaultModels.find(
    (m) => m.enabled !== false && !m.capabilities?.tts && !m.capabilities?.image,
  )?.id
    ?? target.defaultModels[0]?.id
    ?? PROVIDER_PRESETS["vertex-ai"]?.defaultModels[0]?.id
    ?? "gemini-2.5-flash";
  // The Vertex OpenAI-compatible endpoint expects `<publisher>/<model>` and
  // rejects a bare id with HTTP 400 "Malformed publisher model".
  const vertexOpenAi = target.protocol === "vertex-openai"
    || target.baseUrl.includes("endpoints/openapi");
  const model = vertexOpenAi && !rawModel.includes("/") ? `google/${rawModel}` : rawModel;
  const anthropic = target.protocol === "anthropic-messages";
  const url = anthropic
    ? target.baseUrl.endsWith("/messages")
      ? target.baseUrl
      : `${target.baseUrl}/messages`
    : target.baseUrl.endsWith("/chat/completions")
      ? target.baseUrl
      : `${target.baseUrl}/chat/completions`;
  const body = anthropic
    ? { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
    : { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status, error: null };
    const detail = scrubSecrets(await res.text().catch(() => "")).slice(0, 240);
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

export async function testProviderConnection(
  idOrInput: string | ProviderUpsertInput,
  rawOpts?: string | ProviderProbeOptions,
): Promise<ProviderTestResult> {
  const opts = normalizeProbeOpts(rawOpts);
  const outDir = extractOutDir(opts.outDir);
  const started = Date.now();
  let result: ProviderTestResult;
  let providerId = typeof idOrInput === "string" ? idOrInput.trim() : idOrInput.id;

  try {
    const models = await discoverProviderModels(idOrInput, opts);
    result = {
      ok: true,
      status: 200,
      latencyMs: Math.max(1, Date.now() - started),
      testedAt: Date.now(),
      models,
      error: null,
    };
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err));
    const statusMatch = /HTTP (\d{3})/.exec(msg);
    // Some endpoints have no `GET /models` (Anthropic messages, or a custom
    // gateway that 404s there). Probe one real inference turn before failing.
    const probe = await probeProviderInference(idOrInput, opts);
    result = {
      ok: probe.ok,
      status: probe.ok ? 200 : probe.status || (statusMatch ? Number(statusMatch[1]) : 502),
      latencyMs: Math.max(1, Date.now() - started),
      testedAt: Date.now(),
      models: [],
      error: probe.ok ? null : (probe.error || msg),
    };
  }

  if (providerId) {
    const doc = readProvidersDoc(outDir);
    const found = doc.providers.find((p) => p.id === providerId);
    if (found) {
      found.lastTest = {
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        testedAt: result.testedAt,
        modelCount: result.models.length,
        error: result.error,
      };
      if (result.ok && result.models.length > 0 && found.models.length === 0) {
        found.models = result.models.map((m) =>
          normalizeModelEntry({
            id: m.id,
            label: m.label,
            capabilities: m.capabilities,
            contextWindow: m.contextWindow,
          }));
      }
      atomicWriteJson0600(configFilePath(PROVIDERS_FILENAME, outDir), doc);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Stage Routing CRUD (`<outDir>/config/stages.json`)
 * ------------------------------------------------------------------ */

export interface StageRouteConfig {
  stage: StageId | "tts";
  primary: string | null;
  fallbacks: string[];
  chain: string[];
  concurrency: number;
  temperature: number;
  llmVerify?: boolean;
  inheritFrom?: StageId | null;
}

export interface StagesConfigState {
  schemaVersion: number;
  revision: number;
  persisted: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  stages: Record<StageId, StageRouteConfig>;
  reader: StageRouteConfig;
  matcher: StageRouteConfig;
  writer: StageRouteConfig;
  scout: StageRouteConfig;
  fact_check: StageRouteConfig;
  /** Optional TTS narration route; RoutingTab edits persist here. */
  tts?: StageRouteConfig;
}

function defaultStagesRecord(): Record<StageId, StageRouteConfig> {
  // One canonical chain definition, shared with laneConfig and llm/client.
  const { vision: visionDefault, writer: writerDefault } = defaultRoleLaneIds();
  return {
    reader: {
      stage: "reader",
      primary: visionDefault[0]!,
      fallbacks: visionDefault.slice(1),
      chain: [...visionDefault],
      concurrency: 1,
      temperature: 0.2,
      inheritFrom: null,
    },
    matcher: {
      stage: "matcher",
      primary: visionDefault[0]!,
      fallbacks: visionDefault.slice(1),
      chain: [...visionDefault],
      concurrency: 1,
      temperature: 0.0,
      inheritFrom: "reader",
    },
    writer: {
      stage: "writer",
      primary: writerDefault[0]!,
      fallbacks: writerDefault.slice(1),
      chain: [...writerDefault],
      concurrency: 1,
      temperature: 0.7,
      inheritFrom: null,
    },
    scout: {
      stage: "scout",
      primary: visionDefault[0]!,
      fallbacks: visionDefault.slice(1),
      chain: [...visionDefault],
      concurrency: 1,
      temperature: 0.2,
      inheritFrom: "reader",
    },
    fact_check: {
      stage: "fact_check",
      primary: writerDefault[0]!,
      fallbacks: writerDefault.slice(1),
      chain: [...writerDefault],
      concurrency: 1,
      temperature: 0.0,
      llmVerify: false,
      inheritFrom: null,
    },
  };
}

function defaultTtsRoute(): StageRouteConfig {
  return {
    stage: "tts",
    primary: null,
    fallbacks: [],
    chain: [],
    concurrency: 1,
    temperature: 1,
    inheritFrom: null,
  };
}

function normalizeStageRoute(
  stage: StageId | "tts",
  raw: unknown,
  fallback: StageRouteConfig,
): StageRouteConfig {
  if (Array.isArray(raw)) {
    const chain = raw
      .map((item) => (typeof item === "string" ? item.trim() : typeof item === "object" && item && "id" in item ? String((item as { id: unknown }).id).trim() : ""))
      .filter(Boolean);
    return {
      ...fallback,
      stage,
      primary: chain[0] ?? null,
      fallbacks: chain.slice(1),
      chain,
      inheritFrom: null,
    };
  }
  if (!raw || typeof raw !== "object") {
    return structuredClone(fallback);
  }
  const obj = raw as Record<string, unknown>;
  let chain: string[] = [];
  if (Array.isArray(obj.chain)) {
    chain = obj.chain.map((x) => String(x).trim()).filter(Boolean);
  } else if (Array.isArray(obj.models)) {
    chain = obj.models
      .map((x) => (typeof x === "string" ? x.trim() : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id).trim() : ""))
      .filter(Boolean);
  } else if (typeof obj.primary === "string" || Array.isArray(obj.fallbacks)) {
    const primary = typeof obj.primary === "string" && obj.primary.trim() ? obj.primary.trim() : null;
    const fallbacks = Array.isArray(obj.fallbacks)
      ? obj.fallbacks.map((x) => String(x).trim()).filter(Boolean)
      : [];
    chain = primary ? [primary, ...fallbacks.filter((f) => f !== primary)] : fallbacks;
  } else {
    chain = [...fallback.chain];
  }

  const concurrencyRaw = obj.concurrency !== undefined ? Number(obj.concurrency) : fallback.concurrency;
  if (!Number.isInteger(concurrencyRaw) || concurrencyRaw < 1 || concurrencyRaw > 8) {
    throw new StudioValidationError(`stages.${stage}.concurrency must be an integer between 1 and 8`);
  }
  const tempRaw = obj.temperature !== undefined ? Number(obj.temperature) : fallback.temperature;
  if (!Number.isFinite(tempRaw) || tempRaw < 0 || tempRaw > 2) {
    throw new StudioValidationError(`stages.${stage}.temperature must be between 0 and 2`);
  }

  return {
    stage,
    primary: chain[0] ?? null,
    fallbacks: chain.slice(1),
    chain,
    concurrency: concurrencyRaw,
    temperature: tempRaw,
    llmVerify: stage === "fact_check" ? Boolean(obj.llmVerify ?? fallback.llmVerify ?? false) : undefined,
    inheritFrom:
      obj.inheritFrom === null || typeof obj.inheritFrom === "string"
        ? (obj.inheritFrom as StageId | null)
        : fallback.inheritFrom ?? null,
  };
}

export function getStagesConfig(outDir?: OutDirOrOpts): StagesConfigState {
  const filePath = configFilePath(STAGES_FILENAME, outDir);
  const defaults = defaultStagesRecord();
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink() && st.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        revision?: number;
        updatedAt?: number;
        updatedBy?: string | null;
        stages?: Partial<Record<StageId, unknown>>;
      };
      const rawStages = parsed.stages ?? (parsed as Partial<Record<StageId, unknown>>);
      const stages = {} as Record<StageId, StageRouteConfig>;
      for (const stg of STAGES) {
        stages[stg] = normalizeStageRoute(stg, rawStages[stg], defaults[stg]);
      }
      const revision = typeof parsed.revision === "number" && Number.isInteger(parsed.revision) ? parsed.revision : 1;
      return {
        schemaVersion: STUDIO_SCHEMA_VERSION,
        revision,
        persisted: true,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
        updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
        stages,
        reader: stages.reader,
        matcher: stages.matcher,
        writer: stages.writer,
        scout: stages.scout,
        fact_check: stages.fact_check,
        tts: normalizeStageRoute("tts", (rawStages as Record<string, unknown>).tts, defaultTtsRoute()),
      };
    }
  } catch {
    // return defaults below
  }
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: 0,
    persisted: false,
    updatedAt: null,
    updatedBy: null,
    stages: defaults,
    reader: defaults.reader,
    matcher: defaults.matcher,
    writer: defaults.writer,
    scout: defaults.scout,
    fact_check: defaults.fact_check,
    tts: defaultTtsRoute(),
  };
}

export function putStagesConfig(
  input: Record<string, unknown>,
  outDir?: OutDirOrOpts,
): StagesConfigState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StudioValidationError("Stages config payload must be an object");
  }
  const resolvedOut = extractOutDir(outDir);
  const current = getStagesConfig(resolvedOut);

  const expectedRev = input.revision !== undefined
    ? Number(input.revision)
    : input.expectedRevision !== undefined
      ? Number(input.expectedRevision)
      : typeof outDir === "object" && outDir?.expectedRevision !== undefined
        ? outDir.expectedRevision
        : undefined;

  if (expectedRev !== undefined) {
    if (!Number.isInteger(expectedRev) || expectedRev < 0) {
      throw new StudioValidationError("revision must be a non-negative integer");
    }
    if (expectedRev !== current.revision) {
      throw new StudioRevisionConflictError(expectedRev, current.revision);
    }
  }

  const rawStages = (
    input.stages && typeof input.stages === "object" && !Array.isArray(input.stages)
      ? input.stages
      : input
  ) as Record<string, unknown>;

  const nextStages = {} as Record<StageId, StageRouteConfig>;
  for (const stg of STAGES) {
    if (stg in rawStages) {
      nextStages[stg] = normalizeStageRoute(stg, rawStages[stg], current.stages[stg]);
    } else {
      nextStages[stg] = structuredClone(current.stages[stg]);
    }
  }

  // An inherited route always mirrors the reader chain, even when the payload
  // also sent its own (stale) primary/fallbacks/chain for that stage.
  for (const inheritedStage of ["matcher", "scout"] as const) {
    const route = nextStages[inheritedStage];
    if (route.inheritFrom === "reader") {
      nextStages[inheritedStage] = {
        ...route,
        primary: nextStages.reader.primary,
        fallbacks: [...nextStages.reader.fallbacks],
        chain: [...nextStages.reader.chain],
      };
    }
  }

  const nextTts = "tts" in rawStages
    ? normalizeStageRoute("tts", rawStages.tts, current.tts ?? defaultTtsRoute())
    : structuredClone(current.tts ?? defaultTtsRoute());

  const nextRevision = current.revision + 1;
  const now = Date.now();
  const actor = typeof input.updatedBy === "string"
    ? input.updatedBy
    : typeof outDir === "object" && outDir?.updatedBy
      ? outDir.updatedBy
      : "admin";

  atomicWriteJson0600(configFilePath(STAGES_FILENAME, resolvedOut), {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: nextRevision,
    updatedAt: now,
    updatedBy: actor,
    stages: { ...nextStages, tts: nextTts },
  });
  appendAuditLog("stages.update", "stages", nextRevision, actor, resolvedOut);

  return getStagesConfig(resolvedOut);
}

/* ------------------------------------------------------------------ *
 * Stage reconciliation after provider/model changes
 * ------------------------------------------------------------------ */

/** Lane ids owned by the CLI bridges, not by `providers.json`. */
const EXTERNAL_LANE_PROVIDERS = new Set(["agy", "workbuddy", "opencode"]);

/**
 * Provider ids that were deleted (learned from the audit log, minus providers
 * that exist again). A chain entry with a colon is only a Studio reference when
 * its prefix is a known provider or one of these; a bare colon model id such as
 * an Ollama tag (`qwen2.5vl:7b`) must never be split.
 */
function deletedStudioProviders(outDir?: OutDirOrOpts): Set<string> {
  const deleted = new Set<string>();
  try {
    for (const entry of readStudioAuditLog(extractOutDir(outDir), 5000)) {
      if (entry.action === "provider.delete") deleted.add(entry.target);
      else if (
        entry.action === "provider.create"
        || entry.action === "provider.restore"
        || entry.action === "provider.update"
      ) {
        deleted.delete(entry.target);
      }
    }
  } catch {
    // fail-open: an unreadable audit log only means "unknown", not "deleted"
  }
  return deleted;
}

const VISION_STAGES = new Set<StageId>(["reader", "matcher", "scout"]);

function modelSupportsStage(model: ProviderModelConfig, stage: StageId): boolean {
  if (model.enabled === false) return false;
  if (model.capabilities?.tts || model.capabilities?.image) return false;
  return VISION_STAGES.has(stage)
    ? Boolean(model.capabilities?.vision)
    : Boolean(model.capabilities?.writer);
}

function pickReplacementModel(
  prov: ProviderStored,
  stage: StageId,
): ProviderModelConfig | undefined {
  // Only a model that really serves this stage: falling back to any enabled
  // model could route a vision stage to a text-only, TTS, or image model.
  const enabled = prov.models.filter((m) => m.enabled !== false);
  return enabled.find((m) => modelSupportsStage(m, stage));
}

function findFallbackEntry(
  providers: ProviderStored[],
  stage: StageId,
): string | null {
  for (const prov of providers) {
    if (prov.enabled === false) continue;
    const model = pickReplacementModel(prov, stage);
    if (model) return `${prov.id}:${model.id}`;
  }
  return null;
}

/**
 * Re-point every `stages.json` chain entry at a model that still exists after a
 * provider or its model list changed. Without this a deleted provider (or a
 * re-synced catalog) leaves the reader/writer chain pointing at a dead lane and
 * the next run fails at model resolution instead of falling back.
 */
export function reconcileStagesWithProviders(outDir?: OutDirOrOpts): void {
  const resolvedOut = extractOutDir(outDir);
  const stagesPath = configFilePath(STAGES_FILENAME, resolvedOut);
  try {
    const st = fs.lstatSync(stagesPath);
    if (st.isSymbolicLink() || !st.isFile()) return;
  } catch {
    return; // no stages.json yet: nothing to reconcile
  }

  const current = getStagesConfig(resolvedOut);
  const doc = readProvidersDoc(resolvedOut);
  const providers = doc.providers;
  let changed = false;

  const nextStages = {} as Record<StageId, StageRouteConfig>;
  for (const stg of STAGES) {
    const route = current.stages[stg];
    const mapped: string[] = [];
    for (const entry of route.chain) {
      const raw = String(entry ?? "").trim();
      if (!raw) continue;
      const sep = raw.indexOf(":");
      if (sep <= 0) {
        // Not a `<providerId>:<modelId>` ref: leave it alone.
        if (!mapped.includes(raw)) mapped.push(raw);
        continue;
      }
      const providerId = raw.slice(0, sep);
      const modelId = raw.slice(sep + 1);
      if (EXTERNAL_LANE_PROVIDERS.has(providerId)) {
        if (!mapped.includes(raw)) mapped.push(raw);
        continue;
      }
      const prov = providers.find((p) => p.id === providerId);
      if (prov) {
        // A merely disabled provider keeps its routes: the runtime skips it and
        // re-enabling the provider restores them. Only a removed model remaps.
        if (prov.enabled === false) {
          if (!mapped.includes(raw)) mapped.push(raw);
          continue;
        }
        const model = prov.models.find((m) => m.id === modelId && m.enabled !== false);
        if (model) {
          if (!mapped.includes(raw)) mapped.push(raw);
          continue;
        }
        const replacement = pickReplacementModel(prov, stg);
        if (replacement) {
          const next = `${prov.id}:${replacement.id}`;
          if (!mapped.includes(next)) mapped.push(next);
        }
        continue;
      }
      if (!deletedStudioProviders(resolvedOut).has(providerId)) {
        // Not a Studio `<providerId>:<modelId>` ref at all (a bare colon model
        // id such as an Ollama tag): leave it alone.
        if (!mapped.includes(raw)) mapped.push(raw);
        continue;
      }
      // Provider deleted: fall back to another Studio provider.
      const fallback = findFallbackEntry(providers, stg);
      if (fallback && !mapped.includes(fallback)) mapped.push(fallback);
    }

    const same = mapped.length === route.chain.length
      && mapped.every((entry, i) => entry === route.chain[i]);
    if (same) {
      nextStages[stg] = route;
      continue;
    }
    changed = true;
    nextStages[stg] = {
      ...route,
      chain: mapped,
      primary: mapped[0] ?? null,
      fallbacks: mapped.slice(1),
    };
  }

  if (!changed) return;

  // Inherited stages mirror the reader chain, exactly like putStagesConfig.
  for (const inheritedStage of ["matcher", "scout"] as const) {
    const route = nextStages[inheritedStage];
    if (route.inheritFrom === "reader") {
      nextStages[inheritedStage] = {
        ...route,
        primary: nextStages.reader.primary,
        fallbacks: [...nextStages.reader.fallbacks],
        chain: [...nextStages.reader.chain],
      };
    }
  }

  atomicWriteJson0600(stagesPath, {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: Date.now(),
    updatedBy: "system",
    stages: { ...nextStages, tts: current.tts ?? defaultTtsRoute() },
  });
  appendAuditLog("stages.reconcile", "stages", current.revision + 1, "system", resolvedOut);
}

/* ------------------------------------------------------------------ *
 * Render Node Config CRUD (`<outDir>/config/render-nodes.json`)
 * ------------------------------------------------------------------ */
export type RenderNodeKind = "local" | "docker-sbx" | "ssh";

export interface RenderNodeConfigStored {
  id: string;
  label: string;
  kind: RenderNodeKind;
  enabled: boolean;
  slots: number;
  supportsCleaner: boolean;
  priority: number;
  box?: string;
  template?: string;
  maxHours?: number;
  idlePauseS?: number;
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  /** Optional explicit SSH private key path (else the uploaded key is used). */
  identityFile?: string;
  secretRef?: string;
  maxLoadFactor?: number;
  minMemGb?: number;
  minDiskGb?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RenderNodeConfigView extends RenderNodeConfigStored {
  revision: number;
  auth: {
    secretRef: string | null;
    hasSecret: boolean;
    secretHint: string | null;
    updatedAt: number | null;
  };
}

export interface RenderNodeUpsertInput {
  id: string;
  label?: string;
  kind: RenderNodeKind;
  enabled?: boolean;
  slots?: number;
  supportsCleaner?: boolean;
  priority?: number;
  box?: string;
  template?: string;
  maxHours?: number;
  idlePauseS?: number;
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  identityFile?: string;
  secretRef?: string;
  sshKey?: string;
  privateKey?: string;
  maxLoadFactor?: number;
  minMemGb?: number;
  minDiskGb?: number;
  expectedRevision?: number;
  updatedBy?: string;
}

interface RenderNodesFileDoc {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
  nodes: RenderNodeConfigStored[];
}

function defaultLocalRenderNode(): RenderNodeConfigStored {
  return {
    id: "local",
    label: "Local Host Worker",
    kind: "local",
    enabled: true,
    slots: 1,
    supportsCleaner: true,
    priority: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

function readRenderNodesDoc(outDir?: OutDirOrOpts): RenderNodesFileDoc {
  const filePath = configFilePath(RENDER_NODES_FILENAME, outDir);
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink() && st.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RenderNodesFileDoc>;
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      if (!nodes.some((n) => n.id === "local")) {
        nodes.unshift(defaultLocalRenderNode());
      }
      return {
        schemaVersion: STUDIO_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" && Number.isInteger(parsed.revision) ? parsed.revision : 0,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
        nodes,
      };
    }
  } catch {
    // return defaults below
  }
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    updatedBy: null,
    nodes: [defaultLocalRenderNode()],
  };
}

function toRenderNodeView(
  node: RenderNodeConfigStored,
  revision: number,
  outDir?: OutDirOrOpts,
): RenderNodeConfigView {
  const resolvedOut = extractOutDir(outDir);
  const secretRef = node.kind === "ssh" ? node.secretRef || `render-node:${node.id}` : null;
  const meta = secretRef ? getSecretMeta(secretRef, resolvedOut) : { hasSecret: false, hint: null, updatedAt: null };
  return {
    ...structuredClone(node),
    revision,
    auth: {
      secretRef,
      hasSecret: meta.hasSecret,
      secretHint: meta.hint,
      updatedAt: meta.updatedAt,
    },
  };
}

export function listRenderNodesConfig(outDir?: OutDirOrOpts): RenderNodeConfigView[] {
  const doc = readRenderNodesDoc(outDir);
  return doc.nodes.map((node) => toRenderNodeView(node, doc.revision, outDir));
}

export function upsertRenderNodeConfig(
  input: RenderNodeUpsertInput,
  outDir?: OutDirOrOpts,
): RenderNodeConfigView {
  if (!input || typeof input !== "object") {
    throw new StudioValidationError("Render node payload must be an object");
  }
  const resolvedOut = extractOutDir(outDir);
  const id = validateProviderId(input.id);
  const kind = input.kind;
  if (kind !== "local" && kind !== "docker-sbx" && kind !== "ssh") {
    throw new StudioValidationError(`Unsupported render node kind '${String(kind)}' (allowed: local, docker-sbx, ssh)`);
  }

  const doc = readRenderNodesDoc(resolvedOut);
  const expectedRevision = input.expectedRevision
    ?? (typeof outDir === "object" && outDir ? outDir.expectedRevision : undefined);
  if (expectedRevision !== undefined && expectedRevision !== doc.revision) {
    throw new StudioRevisionConflictError(expectedRevision, doc.revision);
  }

  const existingIdx = doc.nodes.findIndex((n) => n.id === id);
  const existing = existingIdx >= 0 ? doc.nodes[existingIdx] : undefined;

  const maxSlots = kind === "docker-sbx" ? 2 : 4;
  const slots = input.slots ?? existing?.slots ?? (kind === "docker-sbx" ? 2 : 1);
  if (!Number.isInteger(slots) || slots < 1 || slots > maxSlots) {
    throw new StudioValidationError(`Render node '${id}' slots must be an integer between 1 and ${maxSlots}`);
  }

  const now = Date.now();
  const stored: RenderNodeConfigStored = {
    id,
    label: (input.label ?? existing?.label ?? id).trim(),
    kind,
    enabled: input.enabled ?? existing?.enabled ?? true,
    slots,
    supportsCleaner: input.supportsCleaner ?? existing?.supportsCleaner ?? (kind !== "docker-sbx"),
    priority: input.priority ?? existing?.priority ?? (existingIdx >= 0 ? existing!.priority : doc.nodes.length + 1),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (kind === "docker-sbx") {
    const boxInput = (input.box ?? existing?.box ?? "").trim();
    // Default the box name to the node id so a fresh docker-sbx node works
    // without inventing a box name; fall back to a shared default box.
    const box = boxInput
      || (/^[a-z0-9][a-z0-9-]{1,62}$/.test(id) ? id : "manhwa-box-1");
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(box)) {
      throw new StudioValidationError("Docker sandbox 'box' name must match ^[a-z0-9][a-z0-9-]{1,62}$");
    }
    const rawTemplate = input.template !== undefined ? String(input.template).trim() : "";
    const template = rawTemplate || (existing?.template ?? "").trim() || "manhwa-render-arm";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,127}$/.test(template)) {
      throw new StudioValidationError("Invalid sandbox template name");
    }
    stored.box = box;
    stored.template = template;
    stored.maxHours = Number(input.maxHours ?? existing?.maxHours ?? 5);
    stored.idlePauseS = Number(input.idlePauseS ?? existing?.idlePauseS ?? 300);
  } else if (kind === "ssh") {
    const host = (input.host ?? existing?.host ?? "").trim();
    if (!host || host.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(host)) {
      throw new StudioValidationError("SSH host must be a valid hostname or IP address without leading '-'");
    }
    const user = (input.user ?? existing?.user ?? "ubuntu").trim();
    if (!user || user.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(user)) {
      throw new StudioValidationError("SSH user must be a valid username without leading '-'");
    }
    const port = Number(input.port ?? existing?.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new StudioValidationError("SSH port must be between 1 and 65535");
    }
    const remoteDir = (input.remoteDir ?? existing?.remoteDir ?? "/tmp/manhwa-worker").trim();
    if (!remoteDir || /[;&|$`<>\\\n\r\0]/.test(remoteDir)) {
      throw new StudioValidationError("SSH remoteDir contains forbidden characters");
    }
    const secretRef = input.secretRef ?? existing?.secretRef ?? `render-node:${id}`;
    const rawKey = input.sshKey ?? input.privateKey;
    if (typeof rawKey === "string" && rawKey.trim()) {
      putSecret(secretRef, rawKey, resolvedOut);
    }
    const identityFile = (input.identityFile ?? existing?.identityFile ?? "").trim();
    if (identityFile && (identityFile.startsWith("-") || /[\n\r\0]/.test(identityFile))) {
      throw new StudioValidationError("SSH identityFile must be a plain path without leading '-'");
    }
    if (identityFile) stored.identityFile = identityFile;
    stored.host = host;
    stored.user = user;
    stored.port = port;
    stored.remoteDir = remoteDir;
    stored.secretRef = secretRef;
    stored.maxLoadFactor = Number(input.maxLoadFactor ?? existing?.maxLoadFactor ?? 0.85);
    stored.minMemGb = Number(input.minMemGb ?? existing?.minMemGb ?? 2);
    stored.minDiskGb = Number(input.minDiskGb ?? existing?.minDiskGb ?? 5);
  }

  if (existingIdx >= 0) {
    doc.nodes[existingIdx] = stored;
  } else {
    doc.nodes.push(stored);
  }
  doc.revision += 1;
  doc.updatedAt = now;
  const actor = input.updatedBy ?? (typeof outDir === "object" && outDir ? outDir.updatedBy : undefined) ?? "admin";
  doc.updatedBy = actor;

  atomicWriteJson0600(configFilePath(RENDER_NODES_FILENAME, resolvedOut), doc);
  appendAuditLog(existing ? "render_node.update" : "render_node.create", id, doc.revision, actor, resolvedOut);

  return toRenderNodeView(stored, doc.revision, resolvedOut);
}

export function deleteRenderNodeConfig(id: string, outDir?: OutDirOrOpts): boolean {
  if (typeof id !== "string" || !id.trim()) return false;
  const targetId = id.trim();
  if (targetId === "local") {
    throw new StudioValidationError("The built-in 'local' render node cannot be deleted");
  }
  const resolvedOut = extractOutDir(outDir);
  const doc = readRenderNodesDoc(resolvedOut);
  const idx = doc.nodes.findIndex((n) => n.id === targetId);
  if (idx < 0) return false;
  const [removed] = doc.nodes.splice(idx, 1);
  if (removed?.secretRef) {
    deleteSecret(removed.secretRef, resolvedOut);
  } else {
    deleteSecret(`render-node:${targetId}`, resolvedOut);
  }
  doc.revision += 1;
  doc.updatedAt = Date.now();
  const actor = typeof outDir === "object" && outDir?.updatedBy ? outDir.updatedBy : "admin";
  doc.updatedBy = actor;
  atomicWriteJson0600(configFilePath(RENDER_NODES_FILENAME, resolvedOut), doc);
  appendAuditLog("render_node.delete", targetId, doc.revision, actor, resolvedOut);
  return true;
}

/* ------------------------------------------------------------------ *
 * Editable stage prompts (`<outDir>/config/prompts.json`)
 *
 * The prompts are the v1 briefs by default. Editing a prompt never changes a
 * cache hash unless `preserveCacheHashes` is turned OFF, so existing series
 * caches stay valid.
 * ------------------------------------------------------------------ */

export const PROMPTS_FILENAME = "prompts.json";

export const PROMPT_STAGES = ["reader", "writer", "story_writer", "matcher", "outro"] as const;
export type PromptStageId = (typeof PROMPT_STAGES)[number];

export interface StagePromptEntry {
  stage: PromptStageId;
  content: string;
  isCustom: boolean;
  preserveCacheHashes: boolean;
  updatedAt: number | null;
}

export interface PromptsConfigState {
  revision: number;
  preserveCacheHashes: boolean;
  prompts: Record<PromptStageId, StagePromptEntry>;
  defaults: Record<PromptStageId, string>;
}

interface PromptsFileDoc {
  schemaVersion: number;
  revision: number;
  preserveCacheHashes: boolean;
  updatedAt: number;
  updatedBy: string | null;
  prompts: Partial<Record<PromptStageId, { content?: string; updatedAt?: number }>>;
}

function defaultPromptsRecord(): Record<PromptStageId, string> {
  return getDefaultBriefs();
}

function isPromptStageId(value: unknown): value is PromptStageId {
  return typeof value === "string" && (PROMPT_STAGES as readonly string[]).includes(value);
}

function readPromptsDoc(outDir?: OutDirOrOpts): PromptsFileDoc {
  const filePath = configFilePath(PROMPTS_FILENAME, outDir);
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink() && st.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PromptsFileDoc>;
      return {
        schemaVersion: STUDIO_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" && Number.isInteger(parsed.revision) ? parsed.revision : 0,
        preserveCacheHashes: parsed.preserveCacheHashes === undefined ? true : Boolean(parsed.preserveCacheHashes),
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
        prompts: parsed.prompts && typeof parsed.prompts === "object" && !Array.isArray(parsed.prompts)
          ? parsed.prompts
          : {},
      };
    }
  } catch {
    // return defaults below
  }
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: 0,
    preserveCacheHashes: true,
    updatedAt: 0,
    updatedBy: null,
    prompts: {},
  };
}

export function getPromptsConfig(outDir?: OutDirOrOpts): PromptsConfigState {
  const doc = readPromptsDoc(outDir);
  const defaults = defaultPromptsRecord();
  const prompts = {} as Record<PromptStageId, StagePromptEntry>;
  for (const stage of PROMPT_STAGES) {
    const stored = doc.prompts[stage];
    const custom = typeof stored?.content === "string" && stored.content.trim().length > 0;
    prompts[stage] = {
      stage,
      content: custom ? String(stored!.content) : defaults[stage],
      isCustom: Boolean(custom),
      preserveCacheHashes: doc.preserveCacheHashes,
      updatedAt: custom && typeof stored?.updatedAt === "number" ? stored.updatedAt : null,
    };
  }
  return {
    revision: doc.revision,
    preserveCacheHashes: doc.preserveCacheHashes,
    prompts,
    defaults,
  };
}

export interface PutPromptsInput {
  prompts?: Partial<Record<PromptStageId, string | { content?: string; reset?: boolean }>>;
  /** Shorthand form: a single stage with its new prompt text. */
  stage?: string;
  prompt?: string;
  content?: string;
  preserveCacheHashes?: boolean;
  expectedRevision?: number;
  updatedBy?: string;
}

/**
 * Fold the `{ stage, prompt | content }` shorthand into the canonical
 * `{ prompts: { [stage]: text } }` form. An explicit `prompts` map wins.
 */
function normalizePromptsShorthand(input: PutPromptsInput): PutPromptsInput {
  if (input.prompts !== undefined || typeof input.stage !== "string" || !input.stage.trim()) return input;
  const stage = input.stage.trim();
  const text = typeof input.prompt === "string" ? input.prompt : input.content;
  if (typeof text !== "string") return input;
  return { ...input, prompts: { [stage]: text } as PutPromptsInput["prompts"] };
}

export function putPromptsConfig(
  rawInput: PutPromptsInput,
  outDir?: OutDirOrOpts,
): PromptsConfigState {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? normalizePromptsShorthand(rawInput)
    : rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StudioValidationError("Prompts payload must be an object");
  }
  const resolvedOut = extractOutDir(outDir);
  const current = getPromptsConfig(resolvedOut);
  const expectedRevision = input.expectedRevision
    ?? (typeof outDir === "object" && outDir ? outDir.expectedRevision : undefined);
  if (expectedRevision !== undefined) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new StudioValidationError("revision must be a non-negative integer");
    }
    if (expectedRevision !== current.revision) {
      throw new StudioRevisionConflictError(expectedRevision, current.revision);
    }
  }

  const doc = readPromptsDoc(resolvedOut);
  const now = Date.now();
  const defaults = current.defaults;

  if (input.prompts !== undefined) {
    if (!input.prompts || typeof input.prompts !== "object" || Array.isArray(input.prompts)) {
      throw new StudioValidationError("prompts must be an object keyed by stage");
    }
    for (const [rawStage, rawValue] of Object.entries(input.prompts)) {
      if (!isPromptStageId(rawStage)) {
        throw new StudioValidationError(
          `Unknown prompt stage '${rawStage}' (allowed: ${PROMPT_STAGES.join(", ")})`,
        );
      }
      const stage = rawStage;
      if (rawValue === undefined) continue;
      if (typeof rawValue === "string") {
        const content = rawValue.trim() ? rawValue : defaults[stage];
        if (content === defaults[stage]) delete doc.prompts[stage];
        else doc.prompts[stage] = { content, updatedAt: now };
        continue;
      }
      if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
        throw new StudioValidationError(`prompts.${stage} must be a string or an object`);
      }
      if (rawValue.reset) {
        delete doc.prompts[stage];
        continue;
      }
      if (rawValue.content !== undefined) {
        if (typeof rawValue.content !== "string") {
          throw new StudioValidationError(`prompts.${stage}.content must be a string`);
        }
        const content = rawValue.content.trim() ? rawValue.content : defaults[stage];
        if (content === defaults[stage]) delete doc.prompts[stage];
        else doc.prompts[stage] = { content, updatedAt: now };
      }
    }
  }

  if (input.preserveCacheHashes !== undefined) {
    doc.preserveCacheHashes = Boolean(input.preserveCacheHashes);
  }

  doc.revision = current.revision + 1;
  doc.updatedAt = now;
  const actor = typeof input.updatedBy === "string"
    ? input.updatedBy
    : typeof outDir === "object" && outDir?.updatedBy
      ? outDir.updatedBy
      : "admin";
  doc.updatedBy = actor;

  atomicWriteJson0600(configFilePath(PROMPTS_FILENAME, resolvedOut), doc);
  appendAuditLog("prompts.update", "prompts", doc.revision, actor, resolvedOut);
  return getPromptsConfig(resolvedOut);
}

export function resetPromptStage(
  stage: PromptStageId | "all",
  outDir?: OutDirOrOpts,
): PromptsConfigState;
export function resetPromptStage(
  stage: string,
  outDir?: OutDirOrOpts,
): PromptsConfigState;
export function resetPromptStage(
  stage: string,
  outDir?: OutDirOrOpts,
): PromptsConfigState {
  const resolvedOut = extractOutDir(outDir);
  if (stage !== "all" && !isPromptStageId(stage)) {
    throw new StudioValidationError(
      `Unknown prompt stage '${String(stage)}' (allowed: all, ${PROMPT_STAGES.join(", ")})`,
    );
  }
  const doc = readPromptsDoc(resolvedOut);
  const current = getPromptsConfig(resolvedOut);
  const now = Date.now();
  if (stage === "all") {
    doc.prompts = {};
  } else {
    delete doc.prompts[stage];
  }
  doc.revision = current.revision + 1;
  doc.updatedAt = now;
  doc.updatedBy = "admin";
  atomicWriteJson0600(configFilePath(PROMPTS_FILENAME, resolvedOut), doc);
  appendAuditLog("prompts.reset", stage, doc.revision, "admin", resolvedOut);
  return getPromptsConfig(resolvedOut);
}

export function getActivePrompt(stage: PromptStageId, outDir?: OutDirOrOpts): string {
  if (!isPromptStageId(stage)) {
    throw new StudioValidationError(
      `Unknown prompt stage '${String(stage)}' (allowed: ${PROMPT_STAGES.join(", ")})`,
    );
  }
  return getPromptsConfig(outDir).prompts[stage].content;
}

/* ------------------------------------------------------------------ *
 * Studio settings (`<outDir>/config/settings.json`)
 * ------------------------------------------------------------------ */

export const SETTINGS_FILENAME = "settings.json";

export type RenderQuality = "1080p" | "720p";

export type OutroHookType = "part2" | "next_chapter" | "new_series" | "custom";

export interface StudioSettings {
  schemaVersion: number;
  revision: number;
  renderQuality: RenderQuality;
  defaultOutro: {
    enabled: boolean;
    hookType: OutroHookType;
    customNote: string;
  };
  updatedAt: number | null;
}

const OUTRO_HOOK_TYPES: readonly OutroHookType[] = ["part2", "next_chapter", "new_series", "custom"];

function defaultStudioSettings(): StudioSettings {
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: 0,
    renderQuality: "1080p",
    defaultOutro: { enabled: false, hookType: "part2", customNote: "" },
    updatedAt: null,
  };
}

function normalizeRenderQuality(value: unknown, fallback: RenderQuality): RenderQuality {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1080p" || normalized === "1080") return "1080p";
  if (normalized === "720p" || normalized === "720") return "720p";
  throw new StudioValidationError(`renderQuality must be "1080p" or "720p" (got ${JSON.stringify(value)})`);
}

function normalizeHookType(value: unknown, fallback: OutroHookType): OutroHookType {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  const found = OUTRO_HOOK_TYPES.find((h) => h === normalized);
  if (!found) {
    throw new StudioValidationError(
      `defaultOutro.hookType must be one of ${OUTRO_HOOK_TYPES.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return found;
}

export function getStudioSettings(outDir?: OutDirOrOpts): StudioSettings {
  const filePath = configFilePath(SETTINGS_FILENAME, outDir);
  const defaults = defaultStudioSettings();
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isSymbolicLink() && st.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        revision?: number;
        renderQuality?: unknown;
        updatedAt?: number;
        defaultOutro?: { enabled?: unknown; hookType?: unknown; customNote?: unknown };
      };
      const outro = parsed.defaultOutro ?? {};
      return {
        schemaVersion: STUDIO_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" && Number.isInteger(parsed.revision) ? parsed.revision : 0,
        renderQuality: normalizeRenderQuality(parsed.renderQuality, defaults.renderQuality),
        defaultOutro: {
          enabled: outro.enabled === undefined ? defaults.defaultOutro.enabled : Boolean(outro.enabled),
          hookType: normalizeHookType(outro.hookType, defaults.defaultOutro.hookType),
          customNote: typeof outro.customNote === "string" ? outro.customNote : "",
        },
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
      };
    }
  } catch (err) {
    if (err instanceof StudioConfigError) throw err;
    // fall through to defaults on unreadable/corrupt settings
  }
  return defaults;
}

export function putStudioSettings(
  input: Partial<StudioSettings> & { updatedBy?: string; expectedRevision?: number },
  outDir?: OutDirOrOpts,
): StudioSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StudioValidationError("Settings payload must be an object");
  }
  const resolvedOut = extractOutDir(outDir);
  const current = getStudioSettings(resolvedOut);
  const expectedRevision = input.expectedRevision
    ?? (typeof outDir === "object" && outDir ? outDir.expectedRevision : undefined);
  if (expectedRevision !== undefined) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new StudioValidationError("revision must be a non-negative integer");
    }
    if (expectedRevision !== current.revision) {
      throw new StudioRevisionConflictError(expectedRevision, current.revision);
    }
  }

  const nextOutro = input.defaultOutro ?? current.defaultOutro;
  const next: StudioSettings = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    revision: current.revision + 1,
    renderQuality: normalizeRenderQuality(input.renderQuality, current.renderQuality),
    defaultOutro: {
      enabled: nextOutro.enabled === undefined ? current.defaultOutro.enabled : Boolean(nextOutro.enabled),
      hookType: normalizeHookType(nextOutro.hookType, current.defaultOutro.hookType),
      customNote: typeof nextOutro.customNote === "string" ? nextOutro.customNote : current.defaultOutro.customNote,
    },
    updatedAt: Date.now(),
  };

  const actor = typeof input.updatedBy === "string"
    ? input.updatedBy
    : typeof outDir === "object" && outDir?.updatedBy
      ? outDir.updatedBy
      : "admin";
  atomicWriteJson0600(configFilePath(SETTINGS_FILENAME, resolvedOut), next);
  appendAuditLog("settings.update", "settings", next.revision, actor, resolvedOut);
  return next;
}
