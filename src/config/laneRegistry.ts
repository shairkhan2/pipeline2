/**
 * Static, credential-free model lane registry.
 *
 * No base URLs, credential environment names, or secrets. A lane id is only
 * `provider:model`. A role is declared only where a wired transport can serve it.
 * Grok/xAI text and vision are unavailable: Grok Voice TTS does not grant that access.
 *
 * Default active chains live in laneConfig (`_STATIC_ROLE_LANES`). This module only
 * adds selectable candidates and the unavailable list.
 */

export interface ModelCandidate {
  id: string;
  provider: string;
  model: string;
  kind: string;
  roles: readonly string[];
  capabilities: { vision: boolean; writer: boolean; tts: boolean };
  roleSettings: Record<string, { thinking: boolean | null; stream: boolean }>;
  costTier: string;
  note: string;
}

export interface UnavailableModelCandidate {
  id: string;
  provider: string;
  model: string;
  roles: readonly string[];
  reason: string;
}

/**
 * Additional role-compatible model lanes an operator may enable, over and above
 * the default active chains. Every entry is served by a transport already wired
 * on this host. roleSettings mirror the per-(model x role) call shape.
 */
export const MODEL_CANDIDATES: readonly ModelCandidate[] = [
  {
    id: "agy:gemini-3.8-flash-high",
    provider: "agy",
    model: "gemini-3.8-flash-high",
    kind: "openai",
    roles: ["vision", "writer"],
    capabilities: { vision: true, writer: true, tts: false },
    roleSettings: {
      vision: { thinking: null, stream: false },
      writer: { thinking: null, stream: false },
    },
    costTier: "free",
    note:
      "AGY local rotator high-effort variant of the same gemini-3.8-flash family as the default low/medium lanes (effort selected by the -low/-medium/-high id).",
  },
  {
    id: "agy:gemini-3.7-flash-medium",
    provider: "agy",
    model: "gemini-3.7-flash-medium",
    kind: "openai",
    roles: ["vision", "writer"],
    capabilities: { vision: true, writer: true, tts: false },
    roleSettings: {
      vision: { thinking: null, stream: false },
      writer: { thinking: null, stream: false },
    },
    costTier: "free",
    note: "AGY local rotator, gemini-3.7-flash family, medium effort variant.",
  },
  {
    id: "opencode:mimo-v2.6-flash-free",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
    kind: "openai",
    roles: ["vision"],
    capabilities: { vision: true, writer: false, tts: false },
    roleSettings: {
      vision: { thinking: null, stream: false },
    },
    costTier: "free",
    note:
      "Upstream id the local opencode shim aliases mimo-v2.5-free to (shims/opencode_shim.py ALIASES). Declared vision-only to match the existing mimo lane's measured role.",
  },
];

/**
 * Models an operator may ask for that this host cannot serve for text or vision.
 * Config validation rejects them, so a Grok lane can never be selected and can
 * never silently attempt a paid call.
 */
export const UNAVAILABLE_MODEL_CANDIDATES: readonly UnavailableModelCandidate[] = [
  {
    id: "grok:grok-4.7",
    provider: "grok",
    model: "grok-4.7",
    roles: ["vision", "writer"],
    reason:
      "No Grok/xAI text or vision transport is wired in pipeline/llm.py. Grok Voice TTS uses a separate subscription adapter and does not grant text or vision model access.",
  },
  {
    id: "grok:grok-4.6",
    provider: "grok",
    model: "grok-4.6",
    roles: ["vision", "writer"],
    reason:
      "No Grok/xAI text or vision transport is wired in pipeline/llm.py. Grok Voice TTS uses a separate subscription adapter and does not grant text or vision model access.",
  },
  {
    id: "grok:grok-4.3",
    provider: "grok",
    model: "grok-4.3",
    roles: ["vision", "writer"],
    reason:
      "No Grok/xAI text or vision transport is wired in pipeline/llm.py. Grok Voice TTS uses a separate subscription adapter and does not grant text or vision model access.",
  },
];

export const MODEL_CANDIDATES_BY_ID: Record<string, ModelCandidate> = Object.fromEntries(
  MODEL_CANDIDATES.map((spec) => [spec.id, spec]),
);

export const UNAVAILABLE_MODEL_CANDIDATES_BY_ID: Record<string, UnavailableModelCandidate> =
  Object.fromEntries(UNAVAILABLE_MODEL_CANDIDATES.map((spec) => [spec.id, spec]));
