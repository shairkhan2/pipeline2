/**
 * Studio API for the ElevenLabs key pool (`/api/studio/elevenlabs/*`).
 *
 * The caller (`handleStudioRoute`) has already enforced the session, the
 * privileged check for mutations and CSRF, and parsed the JSON body.
 * Responses carry key summaries only: never a plaintext key or secretRef.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_MODELS,
  ElevenLabsKeyError,
  ElevenLabsRequestError,
  addElevenLabsKey,
  checkElevenLabsVoice,
  isValidElevenLabsVoiceId,
  listElevenLabsKeys,
  listElevenLabsVoices,
  refreshElevenLabsKey,
  removeElevenLabsKey,
  reorderElevenLabsKeys,
  updateElevenLabsKey,
} from "../llm/elevenlabsTts.js";
import { scrubSecrets } from "../config/secretStore.js";
import type { SendJson } from "./lanes.js";

export const ELEVENLABS_ROUTE_PREFIX = "/api/studio/elevenlabs/";

/** Every error message leaving the process: strip plaintext keys and stored secrets. */
function safeMessage(message: string): string {
  return scrubSecrets(String(message ?? "").replace(/\bsk_[A-Za-z0-9]{12,}\b/g, "[REDACTED]"));
}

function sendError(res: ServerResponse, sendJson: SendJson, status: number, message: string): unknown {
  if (res.headersSent) return undefined;
  return sendJson(res, status, { error: safeMessage(message) });
}

function sendKeyError(res: ServerResponse, sendJson: SendJson, err: unknown): unknown {
  if (res.headersSent) return undefined;
  if (err instanceof ElevenLabsKeyError) {
    const status = err.code === "duplicate" ? 409 : err.code === "network" ? 502 : err.code === "not_found" ? 404 : 400;
    return sendError(res, sendJson, status, err.message);
  }
  if (err instanceof ElevenLabsRequestError) {
    return sendError(res, sendJson, err.retryable ? 502 : 400, err.message);
  }
  return sendError(res, sendJson, 500, "ElevenLabs request failed");
}

/** Voice routes report a missing usable key as 409 instead of 404. */
function sendVoiceError(res: ServerResponse, sendJson: SendJson, err: unknown): unknown {
  if (err instanceof ElevenLabsKeyError && err.code === "not_found") {
    return sendError(res, sendJson, 409, err.message);
  }
  return sendKeyError(res, sendJson, err);
}

export async function handleElevenLabsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  body: Record<string, unknown>,
  sendJson: SendJson,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const method = req.method || "GET";
  const isRead = method === "GET" || method === "HEAD";
  const parts = pathname.slice(ELEVENLABS_ROUTE_PREFIX.length).split("/").filter(Boolean);

  try {
    if (parts[0] === "keys") {
      if (parts.length === 1) {
        if (isRead) {
          return sendJson(res, 200, {
            keys: listElevenLabsKeys(env),
            models: ELEVENLABS_MODELS,
            defaultModel: ELEVENLABS_DEFAULT_MODEL,
            defaultVoice: ELEVENLABS_DEFAULT_VOICE,
          });
        }
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (typeof body.key !== "string" || !body.key.trim()) return sendJson(res, 400, { error: "key is required" });
        if (body.label !== undefined && typeof body.label !== "string") {
          return sendJson(res, 400, { error: "label must be a string" });
        }
        const key = await addElevenLabsKey(body.key, body.label as string | undefined, env);
        return sendJson(res, 201, { key });
      }

      if (parts.length === 2 && parts[1] === "order") {
        if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: "ids must be an array" });
        return sendJson(res, 200, { keys: reorderElevenLabsKeys(body.ids as string[], env) });
      }

      const id = decodeURIComponent(parts[1] || "");
      if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id)) return sendJson(res, 400, { error: "invalid key id" });

      if (parts.length === 2) {
        if (method === "PATCH") {
          const patch: { label?: string; enabled?: boolean; allowOverage?: boolean } = {};
          if (body.label !== undefined) patch.label = body.label as string;
          if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
          if (body.allowOverage !== undefined) patch.allowOverage = body.allowOverage as boolean;
          return sendJson(res, 200, { key: updateElevenLabsKey(id, patch, env) });
        }
        if (method === "DELETE") {
          if (!removeElevenLabsKey(id, env)) return sendJson(res, 404, { error: `ElevenLabs key '${id}' not found` });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      if (parts.length === 3 && parts[2] === "refresh") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { key: await refreshElevenLabsKey(id, env) });
      }
      return sendJson(res, 404, { error: "not found" });
    }

    if (parts.length === 1 && parts[0] === "voices") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      try {
        return sendJson(res, 200, { voices: await listElevenLabsVoices(env) });
      } catch (err) {
        return sendVoiceError(res, sendJson, err);
      }
    }

    if (parts.length === 1 && parts[0] === "voice-check") {
      if (!isRead) return sendJson(res, 405, { error: "method not allowed" });
      const voiceId = String(url.searchParams.get("voiceId") ?? "").trim();
      if (!isValidElevenLabsVoiceId(voiceId)) return sendJson(res, 400, { error: "invalid ElevenLabs voice id" });
      try {
        return sendJson(res, 200, await checkElevenLabsVoice(voiceId, env));
      } catch (err) {
        // Inconclusive lookup (auth/plan/rate/server/network): upstream problem, not a bad request.
        if (err instanceof ElevenLabsRequestError) return sendError(res, sendJson, 502, err.message);
        return sendVoiceError(res, sendJson, err);
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) return undefined;
    return sendKeyError(res, sendJson, err);
  }
}
