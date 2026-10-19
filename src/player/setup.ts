/**
 * First-run bootstrap & onboarding setup routes (`/api/setup/*`).
 *
 * When a fresh container install has no `.htpasswd` entries and no
 * `<outDir>/config/.setup-complete` marker (or when `MANHWA_SETUP_MODE=1`),
 * setup mode is open and protected by a one-time setup token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOutDir } from "../config/secretStore.js";
import { listProviders, listRenderNodesConfig } from "../config/studioConfig.js";
import { readJsonBody, verifyCsrf, type LaneSession, type SendJson } from "./lanes.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_SETUP_BODY_BYTES = 16 * 1024;
const USER_RE = /^[A-Za-z0-9._-]{3,64}$/;

let generatedSetupToken: string | null = null;

export function getSetupToken(): string {
  const envTok = process.env.MANHWA_SETUP_TOKEN?.trim();
  if (envTok) return envTok;
  if (!generatedSetupToken) {
    generatedSetupToken = crypto.randomBytes(16).toString("hex");
    if (process.env.NODE_ENV !== "test") {
      console.log(`[setup] one-time bootstrap setup token: ${generatedSetupToken}`);
    }
  }
  return generatedSetupToken;
}

export function _resetSetupForTests(): void {
  generatedSetupToken = null;
}

export function resolveHtpasswdPath(): string {
  return process.env.PLAYER_HTPASSWD || path.join(ROOT, ".htpasswd");
}

/**
 * Writable fallback when `PLAYER_HTPASSWD` points at a read-only mount (for
 * example `/run/secrets/player_htpasswd` in Docker): `<outDir>/config/htpasswd`.
 */
export function fallbackHtpasswdPath(outDir?: string): string {
  return path.join(resolveOutDir(outDir), "config", "htpasswd");
}

export function setupCompleteMarkerPath(outDir?: string): string {
  return path.join(resolveOutDir(outDir), "config", ".setup-complete");
}

export function hasAnyHtpasswdUser(htpasswdPath = resolveHtpasswdPath()): boolean {
  const has = (filePath: string): boolean => {
    try {
      const lines = fs.readFileSync(filePath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf(":");
        if (idx > 0 && trimmed.slice(idx + 1).trim().length > 0) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };
  if (has(htpasswdPath)) return true;
  const fallback = fallbackHtpasswdPath();
  return fallback !== htpasswdPath && has(fallback);
}

/** Write `user:hash` into `target`, replacing any existing line for `user`. */
function writeHtpasswdEntry(target: string, username: string, hash: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let existingLines: string[] = [];
  try {
    existingLines = fs
      .readFileSync(target, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith(`${username}:`));
  } catch {
    existingLines = [];
  }
  existingLines.push(`${username}:${hash}`);
  fs.writeFileSync(target, `${existingLines.join("\n")}\n`, { mode: 0o600 });
}

/** Docker's default read-only htpasswd secret mount (`docker/backend/Dockerfile`). */
export const CONTAINER_HTPASSWD_PATH = "/run/secrets/player_htpasswd";

export function isSetupOpen(outDir?: string): boolean {
  const marker = setupCompleteMarkerPath(outDir);
  if (fs.existsSync(marker)) return false;
  if (process.env.MANHWA_SETUP_MODE === "1") return true;
  if (process.env.MANHWA_SETUP_MODE === "0") return false;
  const configured = process.env.PLAYER_HTPASSWD;
  // Docker mounts an empty read-only secret on first run: nothing can log in, so
  // first-run setup must stay reachable. Custom test paths stay fail-closed.
  if (configured !== undefined) {
    if (configured !== CONTAINER_HTPASSWD_PATH) return false;
    return !hasAnyHtpasswdUser();
  }
  return !hasAnyHtpasswdUser();
}

function randomApr1Salt(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ITOA64[bytes[i]! & 0x3f];
  }
  return out;
}

export interface SetupRouteDeps {
  apr1: (password: string, salt: string) => string;
  makeCookie: (user: string) => string;
  cookieName: string;
  sessionMs: number;
  parseSession: (req: IncomingMessage) => LaneSession | null;
}

export async function handleSetupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  sendJson: SendJson,
  deps: SetupRouteDeps,
): Promise<unknown> {
  const outDir = resolveOutDir();

  if (pathname === "/api/setup/state") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      return sendJson(res, 405, { error: "method not allowed" });
    }
    const open = isSetupOpen(outDir);
    const hasAdmin = hasAnyHtpasswdUser();
    const providers = listProviders(outDir);
    const nodes = listRenderNodesConfig(outDir);
    if (open) {
      getSetupToken();
    }
    return sendJson(res, 200, {
      needsSetup: open,
      hasAdmin,
      providerCount: providers.length,
      nodeCount: nodes.length,
      setupTokenRequired: open,
    });
  }

  if (pathname === "/api/setup/admin") {
    if (req.method !== "POST") {
      req.resume();
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (!isSetupOpen(outDir)) {
      req.resume();
      return sendJson(res, 403, { error: "First-run setup is already closed." });
    }
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req, MAX_SETUP_BODY_BYTES)) as Record<string, unknown>;
    } catch (err: any) {
      return sendJson(res, err.statusCode || 400, { error: err.message || "Invalid JSON body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { error: "JSON object body required" });
    }

    const providedToken = String(body.setupToken ?? body.token ?? "").trim();
    const expectedToken = getSetupToken();
    const aBuf = Buffer.from(providedToken);
    const bBuf = Buffer.from(expectedToken);
    if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
      return sendJson(res, 403, { error: "Invalid setup token. Check container startup logs for the one-time setup token." });
    }

    const username = String(body.username ?? body.user ?? "").trim();
    const password = String(body.password ?? body.pass ?? "");
    if (!USER_RE.test(username)) {
      return sendJson(res, 400, {
        error: "Username must be 3-64 characters (letters, digits, '.', '_', '-').",
      });
    }
    if (password.length < 8 || password.length > 256) {
      return sendJson(res, 400, {
        error: "Password must be between 8 and 256 characters.",
      });
    }

    const htpasswdPath = resolveHtpasswdPath();
    const hash = deps.apr1(password, randomApr1Salt());
    try {
      writeHtpasswdEntry(htpasswdPath, username, hash);
    } catch (err: any) {
      const code = err?.code;
      if (code !== "EROFS" && code !== "EACCES") throw err;
      // Read-only mount (e.g. `/run/secrets/player_htpasswd` in Docker):
      // persist the admin into the writable config dir instead.
      const fallback = fallbackHtpasswdPath(outDir);
      if (path.resolve(fallback) === path.resolve(htpasswdPath)) throw err;
      writeHtpasswdEntry(fallback, username, hash);
    }

    const cookieVal = deps.makeCookie(username);
    const secureFlag = process.env.PLAYER_COOKIE_SECURE === "false" ? "" : " Secure;";
    res.setHeader(
      "Set-Cookie",
      `${deps.cookieName}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax;${secureFlag} Max-Age=${deps.sessionMs / 1000}`,
    );
    return sendJson(res, 200, {
      ok: true,
      user: username,
      privileged: true,
    });
  }

  if (pathname === "/api/setup/complete") {
    if (req.method !== "POST") {
      req.resume();
      return sendJson(res, 405, { error: "method not allowed" });
    }
    const session = deps.parseSession(req);
    if (!session || !session.privileged) {
      req.resume();
      return sendJson(res, 403, { error: "Admin session required to complete setup." });
    }
    let body: Record<string, unknown> = {};
    try {
      body = ((await readJsonBody(req, MAX_SETUP_BODY_BYTES)) ?? {}) as Record<string, unknown>;
    } catch (err: any) {
      return sendJson(res, err.statusCode || 400, { error: err.message || "Invalid JSON body" });
    }
    const csrf = verifyCsrf(req, session, typeof body.csrfToken === "string" ? body.csrfToken : "");
    if (!csrf.ok) {
      return sendJson(res, 403, { error: csrf.error });
    }

    const marker = setupCompleteMarkerPath(outDir);
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ completedAt: Date.now(), completedBy: session.user })}\n`,
      { mode: 0o600 },
    );
    return sendJson(res, 200, { ok: true, needsSetup: false });
  }

  return sendJson(res, 404, { error: "not found" });
}
