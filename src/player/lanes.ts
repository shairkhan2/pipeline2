/**
 * Lane configuration API bridge for the Screening Room player.
 *
 * Ported from `player/lanes.js`. The v1 bridge shelled out to
 * `pipeline/lane_config.py` via `execFile`; this port calls
 * `getLanesState` / `putLanesState` / `resetLanesState` from
 * `../config/laneConfig.js` directly, in-process (zero Python subprocesses).
 *
 * Also owns the shared request helpers (`readJsonBody`, `verifyCsrf`) that the
 * player server uses for every authenticated JSON mutation, so the CSRF and
 * body-cap semantics live in exactly one place.
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  FORBIDDEN_KEYS,
  LaneConfigError,
  getLanesState,
  putLanesState,
  resetLanesState,
  sanitizeLine,
} from '../config/laneConfig.js';

/** Body cap for lane-config mutations (PUT /api/lanes, POST /api/lanes/reset). */
export const MAX_LANE_CONFIG_BODY_BYTES = 16384;

export const FORBIDDEN_FIELDS: ReadonlySet<string> = FORBIDDEN_KEYS;

/** Minimal authenticated-session shape shared with `server.ts`. */
export interface LaneSession {
  user: string;
  exp: number;
  isTemp: boolean;
  privileged: boolean;
  csrfToken: string;
}

export type SendJson = (res: ServerResponse, code: number, obj: unknown) => unknown;

/** Recursively reject credentials, endpoints, and commands anywhere in the payload. */
export function checkForbiddenLaneKeys(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = checkForbiddenLaneKeys(item);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const norm = String(key).trim().toLowerCase().replace(/^x[-_]/, '').replace(/-/g, '_');
    if (FORBIDDEN_FIELDS.has(norm)) {
      return `Forbidden configuration field: ${key}`;
    }
    const nested = checkForbiddenLaneKeys(val);
    if (nested) return nested;
  }
  return null;
}

export const checkForbiddenKeys = checkForbiddenLaneKeys;

/** Read a bounded JSON request body. Rejects with `statusCode` on cap/invalid JSON. */
export function readJsonBody(req: IncomingMessage, maxBytes = 16384): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        const err = new Error('JSON request body too large') as Error & { statusCode?: number };
        err.statusCode = 413;
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        const err = new Error('Invalid JSON request body') as Error & { statusCode?: number };
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    req.on('aborted', () => {
      if (!done) {
        done = true;
        reject(Object.assign(new Error('Request aborted'), { statusCode: 400 }));
      }
    });
  });
}

function normalizeHostForProtocol(host: string, protocol: string): string {
  const h = host.trim().toLowerCase();
  if (protocol === 'https:' && h.endsWith(':443')) return h.slice(0, -4);
  if (protocol === 'http:' && h.endsWith(':80')) return h.slice(0, -3);
  return h;
}

/**
 * Same-origin CSRF gate: rejects cross-site fetches, host-mismatched Origin/Referer,
 * missing Origin+Referer, and a missing/mismatched `X-CSRF-Token`.
 */
export function verifyCsrf(
  req: IncomingMessage,
  session: LaneSession | null | undefined,
  bodyToken = '',
): { ok: boolean; error?: string } {
  if (!session || !session.csrfToken) {
    return { ok: false, error: 'CSRF check failed: invalid session' };
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, error: 'CSRF check failed: cross-site request blocked' };
  }
  const expectedHost = String(req.headers.host || '').toLowerCase();
  if (!expectedHost) {
    return { ok: false, error: 'CSRF check failed: missing Host header' };
  }
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (!origin && !referer) {
    return { ok: false, error: 'CSRF check failed: Origin or Referer header required' };
  }
  if (origin) {
    if (origin === 'null') {
      return { ok: false, error: 'CSRF check failed: null Origin rejected' };
    }
    try {
      const ou = new URL(String(origin));
      if (ou.host.toLowerCase() !== normalizeHostForProtocol(expectedHost, ou.protocol)) {
        return { ok: false, error: 'CSRF check failed: Origin host mismatch' };
      }
    } catch {
      return { ok: false, error: 'CSRF check failed: malformed Origin header' };
    }
  } else if (referer) {
    try {
      const ru = new URL(String(referer));
      if (ru.host.toLowerCase() !== normalizeHostForProtocol(expectedHost, ru.protocol)) {
        return { ok: false, error: 'CSRF check failed: Referer host mismatch' };
      }
    } catch {
      return { ok: false, error: 'CSRF check failed: malformed Referer header' };
    }
  }

  const provided = String(req.headers['x-csrf-token'] || bodyToken || '').trim();
  if (!provided) {
    return { ok: false, error: 'CSRF check failed: missing X-CSRF-Token' };
  }
  const wantBuf = Buffer.from(session.csrfToken, 'utf8');
  const gotBuf = Buffer.from(provided, 'utf8');
  if (wantBuf.length !== gotBuf.length || !crypto.timingSafeEqual(wantBuf, gotBuf)) {
    return { ok: false, error: 'CSRF check failed: invalid CSRF token' };
  }
  return { ok: true };
}

interface LaneErrorLike {
  statusCode?: number;
  code?: string;
  currentRevision?: number | null;
  message?: string;
}

function sendLaneError(res: ServerResponse, err: unknown, sendJson: SendJson) {
  if (err instanceof LaneConfigError) {
    const e = err as LaneConfigError & LaneErrorLike;
    const status = Number(e.statusCode) || 400;
    const payload: Record<string, unknown> = { error: sanitizeLine(e.message) };
    if (e.code) payload.code = e.code;
    if (e.currentRevision !== undefined && e.currentRevision !== null) {
      payload.currentRevision = e.currentRevision;
    }
    return sendJson(res, status, payload);
  }
  const e = err as LaneErrorLike;
  return sendJson(res, 500, { error: e?.message ? sanitizeLine(e.message) : 'Lane configuration request failed' });
}

function withSession(state: Record<string, unknown>, session: LaneSession) {
  return {
    ...state,
    user: session.user,
    privileged: session.privileged,
    csrfToken: session.csrfToken,
  };
}

/** Route `/api/lanes` and `/api/lanes/reset`. Always answers; never throws. */
export async function handleLanesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _urlObj: URL,
  session: LaneSession | null,
  sendJson: SendJson,
) {
  if (!session) {
    return sendJson(res, 401, { error: 'auth required' });
  }

  if (pathname === '/api/lanes' && req.method === 'GET') {
    try {
      const state = await getLanesState();
      return sendJson(res, 200, withSession(state as unknown as Record<string, unknown>, session));
    } catch (err) {
      return sendLaneError(res, err, sendJson);
    }
  }

  if (pathname === '/api/lanes' && req.method === 'PUT') {
    if (!session.privileged) {
      req.resume();
      return sendJson(res, 403, {
        error: 'Temporary viewing accounts cannot change lane settings. Sign in with a persistent account.',
      });
    }

    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_LANE_CONFIG_BODY_BYTES) {
      req.resume();
      return sendJson(res, 413, { error: 'JSON request body too large' });
    }

    let body: any;
    try {
      body = await readJsonBody(req, MAX_LANE_CONFIG_BODY_BYTES);
    } catch (err: any) {
      return sendJson(res, err.statusCode || 400, { error: err.message || 'Bad request body' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON object body required' });
    }

    const csrfCheck = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
    if (!csrfCheck.ok) {
      return sendJson(res, 403, { error: csrfCheck.error });
    }

    const forbidden = checkForbiddenLaneKeys(body);
    if (forbidden) {
      return sendJson(res, 400, { error: forbidden });
    }

    try {
      const updated = await putLanesState(body, String(session.user || ''));
      return sendJson(res, 200, withSession(updated as unknown as Record<string, unknown>, session));
    } catch (err) {
      return sendLaneError(res, err, sendJson);
    }
  }

  if (pathname === '/api/lanes/reset') {
    if (req.method !== 'POST') {
      req.resume();
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (!session.privileged) {
      req.resume();
      return sendJson(res, 403, {
        error: 'Temporary viewing accounts cannot change lane settings. Sign in with a persistent account.',
      });
    }

    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_LANE_CONFIG_BODY_BYTES) {
      req.resume();
      return sendJson(res, 413, { error: 'JSON request body too large' });
    }

    let body: any;
    try {
      body = await readJsonBody(req, MAX_LANE_CONFIG_BODY_BYTES);
    } catch (err: any) {
      return sendJson(res, err.statusCode || 400, { error: err.message || 'Bad request body' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON object body required' });
    }

    const csrfCheck = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
    if (!csrfCheck.ok) {
      return sendJson(res, 403, { error: csrfCheck.error });
    }

    const forbidden = checkForbiddenLaneKeys(body);
    if (forbidden) {
      return sendJson(res, 400, { error: forbidden });
    }

    const allowedKeys = new Set(['revision', 'reset', 'csrfToken']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return sendJson(res, 400, { error: `Unknown reset field: ${key}` });
      }
    }
    if ('reset' in body && body.reset !== true) {
      return sendJson(res, 400, { error: 'reset must be true when calling /api/lanes/reset' });
    }

    let expectedRevision: number | null = null;
    if (body.revision !== undefined && body.revision !== null) {
      if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 0) {
        return sendJson(res, 400, { error: 'revision must be a non-negative integer' });
      }
      expectedRevision = body.revision;
    }

    try {
      const resetState = await resetLanesState(expectedRevision, String(session.user || ''));
      return sendJson(res, 200, withSession(resetState as unknown as Record<string, unknown>, session));
    } catch (err) {
      return sendLaneError(res, err, sendJson);
    }
  }

  if (pathname === '/api/lanes') {
    req.resume();
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  req.resume();
  return sendJson(res, 404, { error: 'not found' });
}
