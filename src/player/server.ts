#!/usr/bin/env node
/**
 * Manhwa pipeline player — zero-dep static + streaming server.
 *
 * Serves the player UI and streams rendered chapter videos with Range support.
 * Ported from `player/server.js`; every control-plane dependency now runs
 * in-process in TypeScript (zero `python3` subprocesses):
 *   - `/api/status`      -> `./status.js` (re-exports `telemetry/statusProbe`)
 *   - `/api/lanes*`      -> `./lanes.js` (calls `config/laneConfig` directly)
 *   - `/api/library/delete` -> `./libraryDelete.js` (calls `locks/seriesLock`)
 *   - `/api/intake/*`    -> `./jobs.js` (loaded dynamically; owned by the intake port)
 *
 * External tools (`ffprobe`, and the agy rotator) are still invoked as
 * subprocesses, exactly like v1.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveOutDir } from '../config/secretStore.js';
import { pipelineStatus } from './status.js';
import {
  MAX_DELETE_BODY_BYTES,
  deleteChapterVideo,
  validateChapter,
  validateSlug,
} from './libraryDelete.js';
import {
  MAX_LANE_CONFIG_BODY_BYTES,
  handleLanesRoute,
  readJsonBody,
  verifyCsrf,
} from './lanes.js';
import type { LaneSession, SendJson } from './lanes.js';
import { handleIntakeRoute, initIntakeQueue as initJobsQueue, parseJsonParam, parseOutroConfig, streamUploadToStaging } from './jobs.js';
import { MAX_ZIP_BYTES } from '../intake/ingest.js';
import { extendSeries, generateSeriesOutro, getSeriesMergeState, inspectSeriesOutro, mergeSeriesChapters, resolveSeriesDir, setSeriesOutroAttachment } from './seriesTools.js';
import { getSeriesSettings, patchSeriesSettings } from './seriesSettings.js';
import { getMoviePlanView } from './moviePlanView.js';
import { assertNoSymlinks } from './storageTrash.js';
import { handleSetupRoute, isSetupOpen } from './setup.js';
import { handleStudioRoute } from './studio.js';
import { handleLanguagesMediaRoute, handleLanguagesRoute, initLanguageQueue, languagesApiMatch, stopLanguageQueue } from './languages.js';
import { streamFile } from './stream.js';
export { streamFile } from './stream.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const PUBLIC = process.env.PLAYER_PUBLIC || path.join(ROOT, 'public');
const SERIES_ROOT = process.env.MANHWA_SERIES_ROOT || path.join(REPO_ROOT, 'series');
const PIPELINE_LOG = process.env.PIPELINE_LOG || path.join(REPO_ROOT, 'out', 'pipeline.log');
const THUMBS_ROOT = process.env.MANHWA_THUMBS_ROOT || path.join(REPO_ROOT, 'thumbnails');
const PORT = Number(process.env.PORT || 80);
const HOST = process.env.HOST || '0.0.0.0';
// agy rotation: read quota + token usage straight from the rotator's lib.
const AGY_LIB = process.env.AGYR_LIB || path.join(REPO_ROOT, 'out', 'agy-rotation');
const PYTHON = process.env.PLAYER_PYTHON || 'python3';

export type PlayerSession = LaneSession;

/* ---------- cookie login (replaces nginx basic auth — same htpasswd, stays logged in) ---------- */

const HTPASSWD = process.env.PLAYER_HTPASSWD || path.join(ROOT, '.htpasswd');
// Setup writes here when PLAYER_HTPASSWD is a read-only mount (Docker secret).
const configHtpasswdPath = () => path.join(resolveOutDir(), 'config', 'htpasswd');
function readHtpasswdLines(): string[] | null {
  const files = [HTPASSWD, configHtpasswdPath()].filter(
    (file, index, all) => all.indexOf(file) === index,
  );
  const lines: string[] = [];
  let read = false;
  for (const file of files) {
    try {
      lines.push(...fsSync.readFileSync(file, 'utf8').split('\n'));
      read = true;
    } catch {
      // try the next candidate
    }
  }
  return read ? lines : null;
}
const SECRET_FILE = process.env.PLAYER_SECRET_FILE || path.join(ROOT, '.auth_secret');
const TEMP_USERS_FILE = process.env.PLAYER_TEMP_USERS || path.join(ROOT, '.temp_users.json');
export const COOKIE = 'sr_session';
export const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days

function loadSecret(): string {
  try {
    return fsSync.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    // fall through to generation
  }
  const s = crypto.randomBytes(32).toString('hex');
  fsSync.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// Lazy so importing this module for tests never writes `.auth_secret`.
let SECRET: string | null = null;
function secret(): string {
  if (SECRET === null) SECRET = loadSecret();
  return SECRET;
}

function loadTempUsers(): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fsSync.readFileSync(TEMP_USERS_FILE, 'utf8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT' && !fsSync.existsSync(TEMP_USERS_FILE)) return {};
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tempExpiry(user: string): number | null {
  const tempMap = loadTempUsers();
  if (!tempMap) return null;
  const exp = tempMap[user];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function to64(v: number, n: number): string {
  let s = '';
  while (n-- > 0) {
    s += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return s;
}
const md5b = (bufs: Buffer[]) => crypto.createHash('md5').update(Buffer.concat(bufs)).digest();
const B = (s: string) => Buffer.from(s, 'latin1');

/** Apache `$apr1$` MD5 crypt — byte-compatible with `htpasswd -m`. */
export function apr1(password: string, salt: string): string {
  salt = salt.slice(0, 8);
  const pw = B(password);
  const magic = B('$apr1$');
  const s = B(salt);
  const ctx: Buffer[] = [pw, magic, s];
  const inner = md5b([pw, s, pw]);
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.push(inner.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i > 0; i >>= 1) ctx.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  let final = md5b(ctx);
  for (let i = 0; i < 1000; i++) {
    const c: Buffer[] = [i & 1 ? pw : final];
    if (i % 3) c.push(s);
    if (i % 7) c.push(pw);
    c.push(i & 1 ? final : pw);
    final = md5b(c);
  }
  const trip = (a: number, b: number, c: number) => to64((final[a] << 16) | (final[b] << 8) | final[c], 4);
  const out =
    trip(0, 6, 12) +
    trip(1, 7, 13) +
    trip(2, 8, 14) +
    trip(3, 9, 15) +
    trip(4, 10, 5) +
    to64(final[11], 2);
  return `$apr1$${salt}$${out}`;
}

export function verifyLogin(user: string, pass: string): boolean {
  const tempMap = loadTempUsers();
  if (!tempMap) return false;
  const isTemp = Object.prototype.hasOwnProperty.call(tempMap, user);
  const rawExp = tempMap[user];
  const tExp = typeof rawExp === 'number' && Number.isFinite(rawExp) ? rawExp : null;
  if (isTemp && tExp === null) return false;
  if (tExp != null && Date.now() > tExp) return false; // temp key past expiry
  const lines = readHtpasswdLines();
  if (!lines) return false;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i) !== user) continue;
    const stored = line.slice(i + 1).trim();
    if (stored.startsWith('$apr1$')) {
      const salt = stored.split('$')[2];
      if (apr1(pass, salt) === stored) return true;
    }
  }
  return false;
}

export function makeCookie(user: string): string {
  const tExp = tempExpiry(user);
  const exp = tExp != null ? Math.min(Date.now() + SESSION_MS, tExp) : Date.now() + SESSION_MS;
  const expField = tExp != null ? `t${exp}` : String(exp);
  const sig = crypto.createHmac('sha256', secret()).update(`${user}.${expField}`).digest('hex');
  return `${user}.${expField}.${sig}`;
}

function htpasswdHasUser(user: string): boolean {
  const lines = readHtpasswdLines();
  if (!lines) return false;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i) === user) return true;
  }
  return false;
}

export function parseSession(req: IncomingMessage): PlayerSession | null {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  let val: string;
  try {
    val = decodeURIComponent(raw.slice(COOKIE.length + 1));
  } catch {
    return null;
  }
  const lastDot = val.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const prevDot = val.lastIndexOf('.', lastDot - 1);
  if (prevDot <= 0) return null;
  const user = val.slice(0, prevDot);
  const expField = val.slice(prevDot + 1, lastDot);
  const sig = val.slice(lastDot + 1);
  const issuedTemp = expField.startsWith('t');
  const exp = issuedTemp ? expField.slice(1) : expField;
  if (!user || !exp || !/^\d+$/.test(exp) || !sig || !Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null;
  const tempMap = loadTempUsers();
  if (!tempMap) return null;
  const inTempMap = Object.prototype.hasOwnProperty.call(tempMap, user);
  const isTemp = issuedTemp || inTempMap;
  const tExp = typeof tempMap[user] === 'number' && Number.isFinite(tempMap[user] as number) ? (tempMap[user] as number) : null;
  if (isTemp && (!inTempMap || tExp === null)) return null;
  if (tExp != null) {
    if (Date.now() > tExp) return null; // temp key past expiry
    if (Number(exp) > tExp) return null; // cookie outlives temp key
  }
  const want = crypto.createHmac('sha256', secret()).update(`${user}.${expField}`).digest('hex');
  const sigBuf = Buffer.from(sig);
  const wantBuf = Buffer.from(want);
  if (sigBuf.length !== wantBuf.length || !crypto.timingSafeEqual(sigBuf, wantBuf)) return null;
  if (!htpasswdHasUser(user)) return null;
  const csrfToken = crypto.createHmac('sha256', secret()).update(`csrf:${val}`).digest('hex');
  return { user, exp: Number(exp), isTemp, privileged: !isTemp, csrfToken };
}

export function checkCookie(req: IncomingMessage): boolean {
  return Boolean(parseSession(req));
}

export const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Screening Room</title>
<link rel="icon" type="image/png" href="/icons/icon-192.png">
<meta name="theme-color" content="#ffffff">
<script>(function(){try{var m=localStorage.getItem("sr-theme-mode");var d=m==="dark"||((m===null||m==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.querySelector('meta[name="theme-color"]').content=d?"#1b1b1d":"#ffffff";}catch(e){}})();</script>
<style>
 :root{color-scheme:light;--bg:#fff;--card:#f4f4f5;--fg:#18181b;--muted:#52525b;--input:#b4b4bc;--ring:#18181b;--btn:#18181b;--btn-fg:#fff;--bad:#c81e1e;--bad-soft:#fdeeee}
 .dark{color-scheme:dark;--bg:#1b1b1d;--card:#252527;--fg:#f4f4f5;--muted:#a9a9b1;--input:#55555c;--ring:#f4f4f5;--btn:#f4f4f5;--btn-fg:#18181b;--bad:#f87171;--bad-soft:#3a1e1f}
 *{box-sizing:border-box}html,body{margin:0}body{min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
 main{width:min(100%,400px)}
 .brand{display:flex;align-items:center;gap:10px;margin:0 0 28px;font-weight:600;font-size:16px}
 .mark{display:grid;place-items:center;width:40px;height:40px;border-radius:14px;background:var(--card)}
 h1{margin:0 0 6px;font-size:28px;line-height:1.15;letter-spacing:-.02em;font-weight:650}
 .sub{margin:0 0 24px;color:var(--muted)}
 form{display:grid;gap:14px;padding:22px;border-radius:24px;background:var(--card)}
 label{display:grid;gap:6px;font-size:14px;font-weight:500}
 input{width:100%;min-height:46px;padding:10px 14px;border:1px solid var(--input);border-radius:14px;background:var(--bg);color:var(--fg);font:inherit;font-size:16px}
 input:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent)}
 button{min-height:48px;margin-top:4px;border:0;border-radius:999px;background:var(--btn);color:var(--btn-fg);font:inherit;font-size:15.5px;font-weight:600;cursor:pointer}
 button:focus-visible{outline:2px solid var(--ring);outline-offset:3px}
 .bad{margin:0;padding:10px 14px;border-radius:14px;background:var(--bad-soft);color:var(--fg);font-size:14px}
 .bad:empty{display:none}
 .note{margin:16px 4px 0;color:var(--muted);font-size:13.5px}
</style></head><body><main>
<div class="brand"><span class="mark"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2.5" y="4" width="12" height="16" rx="3" fill="currentColor" opacity=".18"/><rect x="6" y="2.5" width="12" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m10.5 8 5 2.75-5 2.75Z" fill="currentColor"/></svg></span>Screening Room</div>
<h1>Sign in</h1>
<p class="sub">Your manhwa library, pipeline and studio.</p>
<form method="post" action="/login">
 <p class="bad" role="alert">__BAD__</p>
 <label for="user">Username<input id="user" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
 <label for="pass">Password<input id="pass" name="pass" type="password" autocomplete="current-password" required></label>
 <button type="submit">Sign in</button>
</form>
<p class="note">You stay signed in on this device for up to 30 days.</p>
</main></body></html>`;

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let d = '';
    let bytes = 0;
    let exceeded = false;
    req.on('data', (c: Buffer) => {
      if (exceeded) return;
      bytes += c.length;
      if (bytes > 4096) {
        exceeded = true;
        reject(Object.assign(new Error('Login request body too large'), { statusCode: 413 }));
        return;
      }
      d += c;
    });
    req.on('end', () => resolve(new URLSearchParams(d)));
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { statusCode: 400 })));
  });
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const durationCache = new Map<string, Promise<number | null>>();

export function ffprobeDuration(file: string): Promise<number | null> {
  const cached = durationCache.get(file);
  if (cached) return cached;
  const p = new Promise<number | null>((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 15000 },
      (err, stdout) => resolve(err ? null : parseFloat(stdout.trim()) || null),
    );
  });
  durationCache.set(file, p);
  return p;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface LibraryArm {
  name: string;
  url: string;
  size: number;
  duration: number | null;
}

export interface LibraryChapter {
  ch: string;
  num: number;
  url: string;
  poster: string | null;
  size: number;
  duration: number | null;
  mtime: number;
  arms?: LibraryArm[];
}

export interface LibrarySeries {
  slug: string;
  title: string;
  chapters: LibraryChapter[];
  full?: { url: string; size: number; duration: number | null };
}

export interface LibraryThumbnail {
  name: string;
  url: string;
  size: number;
  mtime: number;
}

export interface LibrarySnapshot {
  series: LibrarySeries[];
  thumbnails: LibraryThumbnail[];
  generatedAt: number;
}

export async function scanLibrary(): Promise<LibrarySnapshot> {
  const series: LibrarySeries[] = [];
  let entries: fsSync.Dirent[] = [];
  try {
    entries = await fs.readdir(SERIES_ROOT, { withFileTypes: true });
  } catch {
    return { series, thumbnails: [], generatedAt: Date.now() };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const dir = path.join(SERIES_ROOT, slug);
    let title = slug;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (meta.title) title = meta.title;
    } catch {
      // keep slug as title
    }
    const outDir = path.join(dir, 'out');
    let chDirs: fsSync.Dirent[] = [];
    try {
      chDirs = await fs.readdir(outDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const chapters: LibraryChapter[] = [];
    for (const ch of chDirs) {
      if (!ch.isDirectory() || !/^ch\d+$/i.test(ch.name)) continue;
      const videoPath = path.join(outDir, ch.name, 'video', 'video.mp4');
      try {
        const st = await fs.stat(videoPath);
        if (!st.isFile() || st.size === 0) continue;
        const num = parseInt(ch.name.slice(2), 10);
        const [duration, hasPoster] = await Promise.all([
          ffprobeDuration(videoPath),
          pathExists(path.join(dir, ch.name, '001.webp')),
        ]);
        const entryCh: LibraryChapter = {
          ch: ch.name,
          num,
          url: `/media/${encodeURIComponent(slug)}/${ch.name}/video.mp4`,
          poster: hasPoster ? `/poster/${encodeURIComponent(slug)}/${ch.name}` : null,
          size: st.size,
          duration,
          mtime: st.mtimeMs,
        };
        // Side-by-side comparison arms (video_paths/<name>.mp4) written by the
        // selection bakeoffs. Surfaced as alternate cuts of the same chapter so a
        // human can switch panels without hunting the filesystem.
        try {
          const vpDir = path.join(outDir, ch.name, 'video_paths');
          const arms: LibraryArm[] = [];
          for (const f of await fs.readdir(vpDir)) {
            if (!/\.mp4$/i.test(f)) continue;
            const armPath = path.join(vpDir, f);
            const ast = await fs.stat(armPath).catch(() => null);
            if (!ast || !ast.isFile() || ast.size === 0) continue;
            const name = f.replace(/\.mp4$/i, '');
            arms.push({
              name,
              url: `/media/${encodeURIComponent(slug)}/${ch.name}/vp/${encodeURIComponent(name)}.mp4`,
              size: ast.size,
              duration: await ffprobeDuration(armPath),
            });
          }
          if (arms.length) {
            arms.sort((a, b) => a.name.localeCompare(b.name));
            entryCh.arms = arms;
          }
        } catch {
          // no comparison arms
        }
        chapters.push(entryCh);
      } catch {
        // chapter without a rendered video
      }
    }
    if (chapters.length) {
      chapters.sort((a, b) => a.num - b.num);
      const entry: LibrarySeries = { slug, title, chapters };
      try {
        const fullPath = path.join(outDir, 'full', 'video', 'video.mp4');
        const st = await fs.stat(fullPath);
        if (st.isFile() && st.size > 0) {
          entry.full = {
            url: `/media/${encodeURIComponent(slug)}/full.mp4`,
            size: st.size,
            duration: await ffprobeDuration(fullPath),
          };
        }
      } catch {
        // no full-series video
      }
      series.push(entry);
    }
  }
  series.sort((a, b) => a.title.localeCompare(b.title));
  const thumbnails: LibraryThumbnail[] = [];
  try {
    const files = await fs.readdir(THUMBS_ROOT, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || /_120px\.[a-z]+$/i.test(f.name)) continue;
      if (!/\.(jpe?g|png|webp)$/i.test(f.name)) continue;
      try {
        const st = await fs.stat(path.join(THUMBS_ROOT, f.name));
        if (st.size > 0) {
          thumbnails.push({
            name: f.name,
            url: `/thumbs/${encodeURIComponent(f.name)}`,
            size: st.size,
            mtime: st.mtimeMs,
          });
        }
      } catch {
        // unreadable thumbnail
      }
    }
    thumbnails.sort((a, b) => b.mtime - a.mtime);
  } catch {
    // no thumbnails directory
  }
  return { series, thumbnails, generatedAt: Date.now() };
}

export function send(
  res: ServerResponse,
  code: number,
  body: string | Buffer,
  headers: http.OutgoingHttpHeaders = {},
) {
  res.writeHead(code, headers);
  res.end(body);
}

export const sendJson: SendJson = (res, code, obj) => {
  send(res, code, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
};

export function safeJoin(base: string, ...parts: string[]): string | null {
  const p = path.resolve(base, ...parts);
  return p.startsWith(path.resolve(base) + path.sep) ? p : null;
}

/** Read a small JSON object, returning `{}` when the file is missing or invalid. */
function readJsonFile(file: string): Record<string, any> {
  try {
    assertNoSymlinks(file);
    const data = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Optional `includeOutro` override for one merge request.
 *
 * `undefined` (absent / unparsable) keeps the saved series preference, which falls back
 * to the legacy "include a rendered outro" default when nothing is saved. Only the exact
 * strings `true`/`false` are treated as an explicit, one-off override.
 */
function parseIncludeOutroParam(raw: string | null): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/* ---------- intake queue startup reconcile ---------- */

/** Startup reconcile for the persistent intake queue (best-effort, never fatal). */
export async function initIntakeQueue(): Promise<void> {
  try {
    await initJobsQueue();
  } catch (err) {
    console.error('intake startup reconcile warning:', (err as Error).message);
  }
  try {
    initLanguageQueue();
  } catch (err) {
    console.error('language startup reconcile warning:', (err as Error).message);
  }
}

/* ---------- request handler ---------- */

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', requestId);
  try {
    let u: URL;
    let pathname: string;
    try {
      u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      pathname = decodeURIComponent(u.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Malformed request URL', requestId });
    }
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname === '/login') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'POST') {
        const form = await readBody(req);
        const user = String(form.get('user') || '');
        const pass = String(form.get('pass') || '');
        if (verifyLogin(user, pass)) {
          res.writeHead(303, {
            'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeCookie(user))}; Path=/; HttpOnly; SameSite=Lax;${process.env.PLAYER_COOKIE_SECURE === 'false' ? '' : ' Secure;'} Max-Age=${SESSION_MS / 1000}`,
            'Cache-Control': 'no-store',
            Location: '/',
          });
          return res.end();
        }
        return send(res, 401, LOGIN_PAGE.replace('__BAD__', 'Wrong username or password'), {
          'Content-Type': MIME['.html'],
        });
      }
      return send(res, 200, LOGIN_PAGE.replace('__BAD__', ''), { 'Content-Type': MIME['.html'] });
    }

    if (pathname === '/api/setup' || pathname.startsWith('/api/setup/')) {
      return await handleSetupRoute(req, res, pathname, sendJson, {
        apr1,
        makeCookie,
        cookieName: COOKIE,
        sessionMs: SESSION_MS,
        parseSession,
      });
    }

    if (
      process.env.PLAYER_API_ONLY !== '1' &&
      isSetupOpen() &&
      (pathname === '/setup' || pathname === '/setup.html' || pathname === '/setup.css' || pathname === '/setup.js')
    ) {
      const target = pathname === '/setup' ? 'setup.html' : pathname.slice(1);
      const ext = path.extname(target).toLowerCase();
      return await streamFile(req, res, path.join(PUBLIC, target), MIME[ext] || MIME['.html']);
    }

    // everything below the gate needs a valid session cookie
    const session = parseSession(req);
    if (!session) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'auth required' });
      res.writeHead(303, { Location: isSetupOpen() ? '/setup' : '/login' });
      return res.end();
    }

    if (pathname === '/api/session') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return sendJson(res, 200, {
        user: session.user,
        privileged: session.privileged,
        csrfToken: session.csrfToken,
        needsSetup: isSetupOpen(),
      });
    }

    if (process.env.PLAYER_API_ONLY !== '1' && (pathname === '/' || pathname === '/index.html')) {
      return await streamFile(req, res, path.join(PUBLIC, 'index.html'), MIME['.html']);
    }

    if (process.env.PLAYER_API_ONLY !== '1' && pathname === '/setup') {
      return await streamFile(req, res, path.join(PUBLIC, 'setup.html'), MIME['.html']);
    }

    if (process.env.PLAYER_API_ONLY !== '1' && pathname === '/studio') {
      return await streamFile(req, res, path.join(PUBLIC, 'studio.html'), MIME['.html']);
    }

    // Extensionless SPA routes: `/status` serves `status.html`, and so on.
    const extensionless: Record<string, string> = {
      '/settings': 'studio.html',
      '/status': 'status.html',
      '/meter': 'meter.html',
      '/new-series': 'new-series.html',
    };
    if (process.env.PLAYER_API_ONLY !== '1' && Object.hasOwn(extensionless, pathname)) {
      return await streamFile(req, res, path.join(PUBLIC, extensionless[pathname]!), MIME['.html']);
    }

    if (pathname === '/api/studio' || pathname.startsWith('/api/studio/')) {
      return await handleStudioRoute(req, res, pathname, u, session, sendJson);
    }

    if (languagesApiMatch(pathname)) {
      return await handleLanguagesRoute(req, res, pathname, session, sendJson, u);
    }

    if (pathname.startsWith('/api/intake/')) {
      return await handleIntakeRoute(req, res, pathname, u, session, sendJson);
    }

    if (pathname === '/api/lanes' || pathname.startsWith('/api/lanes/')) {
      return await handleLanesRoute(req, res, pathname, u, session, sendJson);
    }

    if (pathname === '/api/library') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      // csrfToken + privileged travel with the library so the delete UI can
      // confirm identity without a second round-trip.
      return sendJson(res, 200, {
        ...(await scanLibrary()),
        user: session.user,
        privileged: session.privileged,
        csrfToken: session.csrfToken,
      });
    }

    const panelMatch = /^\/api\/series\/([^/]+)\/panels\/(.+)$/.exec(pathname);
    if (panelMatch) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      const slug = validateSlug(panelMatch[1]);
      if (!slug) return sendJson(res, 400, { error: 'Invalid series slug' });
      const dir = resolveSeriesDir({ seriesRoot: SERIES_ROOT, slug });
      const file = safeJoin(dir, panelMatch[2]);
      if (!file || !/\.(png|jpe?g|webp|avif)$/i.test(file)) return sendJson(res, 403, { error: 'forbidden' });
      assertNoSymlinks(file);
      if (!fsSync.existsSync(file) || !fsSync.statSync(file).isFile()) return sendJson(res, 404, { error: 'Panel not found' });
      return await streamFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'image/avif');
    }

    // Positional alias of the same panel stream: index into the saved outro plan.
    const outroPanelMatch = /^\/api\/series\/([^/]+)\/outro\/panel\/(\d+)$/.exec(pathname);
    if (outroPanelMatch) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      const slug = validateSlug(outroPanelMatch[1]);
      if (!slug) return sendJson(res, 400, { error: 'Invalid series slug' });
      const dir = resolveSeriesDir({ seriesRoot: SERIES_ROOT, slug });
      const idx = Number(outroPanelMatch[2]);
      const plan = readJsonFile(path.join(dir, 'out', 'outro', 'outro-plan.json'));
      const shots = readJsonFile(path.join(dir, 'out', 'outro', 'shots.json'));
      const panels = Array.isArray(plan.selectedPanels) ? plan.selectedPanels : Array.isArray(shots.selectedPanels) ? shots.selectedPanels : [];
      const panel = panels[idx];
      const relative = typeof panel?.panelFile === 'string' ? panel.panelFile : typeof panel?.panel === 'string' ? panel.panel : '';
      if (!relative) return sendJson(res, 404, { error: 'Panel not found' });
      const file = safeJoin(dir, relative);
      if (!file || !/\.(png|jpe?g|webp|avif)$/i.test(file)) return sendJson(res, 403, { error: 'forbidden' });
      assertNoSymlinks(file);
      if (!fsSync.existsSync(file) || !fsSync.statSync(file).isFile()) return sendJson(res, 404, { error: 'Panel not found' });
      return await streamFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'image/avif');
    }

    const settingsMatch = /^\/api\/series\/([^/]+)\/settings$/.exec(pathname);
    if (settingsMatch) {
      const slug = validateSlug(settingsMatch[1]);
      if (!slug) { req.resume(); return sendJson(res, 400, { error: 'Invalid series slug' }); }
      const dir = resolveSeriesDir({ seriesRoot: SERIES_ROOT, slug });
      if (req.method === 'GET') return sendJson(res, 200, getSeriesSettings(dir));
      if (req.method !== 'PATCH') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      if (!session.privileged) { req.resume(); return sendJson(res, 403, { error: 'Persistent account required to modify series' }); }
      const body = await readJsonBody(req, MAX_LANE_CONFIG_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'JSON object body required' });
      const csrf = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
      if (!csrf.ok) return sendJson(res, 403, { error: csrf.error });
      const { csrfToken: _token, ...patch } = body;
      return sendJson(res, 200, patchSeriesSettings(dir, patch));
    }
    const moviePlanMatch = /^\/api\/series\/([^/]+)\/movie-plan$/.exec(pathname);
    if (moviePlanMatch) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      const slug = validateSlug(moviePlanMatch[1]);
      if (!slug) return sendJson(res, 400, { error: 'Invalid series slug' });
      const dir = resolveSeriesDir({ seriesRoot: SERIES_ROOT, slug });
      return sendJson(res, 200, getMoviePlanView(dir));
    }
    const seriesMatch = /^\/api\/series\/([^/]+)\/(outro|merge|extend)$/.exec(pathname);
    // Outro attachment: a series-level saved preference, never a rewrite of chapter files.
    const outroAttachmentMatch = /^\/api\/series\/([^/]+)\/outro\/attachment$/.exec(pathname);
    if (outroAttachmentMatch) {
      const slug = validateSlug(outroAttachmentMatch[1]);
      if (!slug) { req.resume(); return sendJson(res, 400, { error: 'Invalid series slug' }); }
      const opts = { seriesRoot: SERIES_ROOT, slug };
      if (req.method === 'GET' || req.method === 'HEAD') {
        const state = getSeriesMergeState(opts);
        return sendJson(res, 200, { ok: true, slug, attachment: state.attachment, merge: state });
      }
      if (req.method !== 'POST') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      if (!session.privileged) { req.resume(); return sendJson(res, 403, { error: 'Persistent account required to modify series' }); }
      const body = await readJsonBody(req, MAX_LANE_CONFIG_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'JSON object body required' });
      const csrf = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
      if (!csrf.ok) return sendJson(res, 403, { error: csrf.error });
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be a boolean' });
      return sendJson(res, 200, await setSeriesOutroAttachment({ ...opts, enabled: body.enabled }));
    }
    if (seriesMatch) {
      const slug = validateSlug(seriesMatch[1]);
      if (!slug) { req.resume(); return sendJson(res, 400, { error: 'Invalid series slug' }); }
      const action = seriesMatch[2];
      const opts = { seriesRoot: SERIES_ROOT, slug };
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      if (isRead) {
        if (action === 'outro') return sendJson(res, 200, inspectSeriesOutro(opts));
        if (action === 'merge') return sendJson(res, 200, getSeriesMergeState({ ...opts, includeOutro: parseIncludeOutroParam(u.searchParams.get('includeOutro')) }));
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (req.method !== 'POST') { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }); }
      if (!session.privileged) { req.resume(); return sendJson(res, 403, { error: 'Persistent account required to modify series' }); }
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (action === 'extend' && (ctype.includes('application/zip') || ctype.includes('application/octet-stream'))) {
        const csrf = verifyCsrf(req, session);
        if (!csrf.ok) { req.resume(); return sendJson(res, 403, { error: csrf.error }); }
        // Verify the destination before accepting a potentially large upload.
        resolveSeriesDir(opts);
        const limit = Number(process.env.MANHWA_MAX_ZIP_BYTES || MAX_ZIP_BYTES);
        const upload = await streamUploadToStaging(req, Number.isFinite(limit) && limit > 0 ? limit : MAX_ZIP_BYTES);
        try {
          return sendJson(res, 201, await extendSeries({ ...opts, zipPath: upload.path,
            chapters: u.searchParams.get('chapters') || 'all', createdBy: session.user,
            sourceType: u.searchParams.get('sourceType') || undefined,
            provider: u.searchParams.get('provider') || undefined, voice: u.searchParams.get('voice') || undefined,
            background: u.searchParams.get('background') || undefined,
            motion: u.searchParams.get('motion') || undefined,
            renderLane: u.searchParams.get('renderLane') || undefined,
            renderQuality: u.searchParams.get('renderQuality') || undefined,
            preserveCompleted: u.searchParams.has('preserveCompleted') ? u.searchParams.get('preserveCompleted') === 'true' : undefined,
            outroConfig: parseOutroConfig(parseJsonParam(u.searchParams.get('outroConfig'))) }));
        } finally { await fs.rm(upload.path, { force: true }); }
      }
      const body = await readJsonBody(req, MAX_LANE_CONFIG_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'JSON object body required' });
      const csrf = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
      if (!csrf.ok) return sendJson(res, 403, { error: csrf.error });
      if (action === 'outro') return sendJson(res, 200, await generateSeriesOutro({ ...opts,
        totalChapters: body.totalChapters, coveredChapters: body.coveredChapters, hookType: body.hookType,
        customNote: typeof (body.customNote ?? body.customPrompt) === 'string' ? body.customNote ?? body.customPrompt : undefined,
        nextSeriesTitle: typeof body.nextSeriesTitle === 'string' ? body.nextSeriesTitle : undefined,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        renderVideo: body.renderVideo !== false, synthesizeAudio: body.synthesizeAudio !== false }));
      if (action === 'merge') return sendJson(res, 200, await mergeSeriesChapters({ ...opts,
        includeOutro: typeof body.includeOutro === 'boolean' ? body.includeOutro : undefined }));
      if (body.zipPath || body.chapterFolders || body.env || body.repoRoot || body.spawnWorker !== undefined) return sendJson(res, 400, { error: 'Host paths and runtime overrides are not accepted; upload a ZIP instead' });
      return sendJson(res, 201, await extendSeries({ ...opts,
        chapters: typeof body.chapters === 'string' ? body.chapters : 'all',
        gdriveUrl: typeof body.gdriveUrl === 'string' ? body.gdriveUrl : undefined,
        sourceType: typeof body.sourceType === 'string' ? body.sourceType : undefined,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        background: typeof body.background === 'string' ? body.background : undefined,
        motion: typeof body.motion === 'string' ? body.motion : undefined,
        renderLane: typeof body.renderLane === 'string' ? body.renderLane : undefined,
        renderQuality: typeof body.renderQuality === 'string' ? body.renderQuality : undefined,
        preserveCompleted: body.preserveCompleted,
        outroConfig: parseOutroConfig(body.outroConfig), createdBy: session.user }));
    }

    // Delete ONE rendered chapter video from the library. The source chapter
    // folder, panel images, narration audio and caches are never touched.
    if (pathname === '/api/library/delete') {
      if (req.method !== 'POST') {
        req.resume();
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      // Only a persistent (non-temporary) account may delete rendered videos.
      if (!session.privileged) {
        req.resume();
        return sendJson(res, 403, {
          error: 'Temporary viewing accounts cannot delete videos. Sign in with a persistent account.',
        });
      }
      const declaredLen = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLen) && declaredLen > MAX_DELETE_BODY_BYTES) {
        req.resume();
        return sendJson(res, 413, { error: 'JSON request body too large' });
      }
      let body: any;
      try {
        body = await readJsonBody(req, MAX_DELETE_BODY_BYTES);
      } catch (err: any) {
        return sendJson(res, err.statusCode || 400, { error: err.message || 'Bad request body' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'JSON object body required' });
      }
      const csrfCheck = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
      if (!csrfCheck.ok) return sendJson(res, 403, { error: csrfCheck.error });

      const slug = validateSlug(body.slug);
      const ch = validateChapter(body.chapter);
      if (!slug || !ch) {
        return sendJson(res, 400, { error: 'A valid series slug and chapter (chN) are required.' });
      }
      // Explicit confirmation must name the exact chapter being deleted.
      const confirm = typeof body.confirm === 'string' ? body.confirm.trim().toLowerCase() : '';
      if (confirm !== `${slug}/${ch}`) {
        return sendJson(res, 400, {
          error: `Confirmation required: send confirm="${slug}/${ch}" to delete this chapter video.`,
        });
      }

      const result = await deleteChapterVideo({ seriesRoot: SERIES_ROOT, slug, ch });
      if (!result.ok) {
        return sendJson(res, result.status || 400, { error: result.error, code: result.code });
      }
      return sendJson(res, 200, {
        ok: true,
        slug: result.slug,
        chapter: result.ch,
        deleted: result.deleted,
        freedBytes: result.freedBytes,
        message: result.message,
        trashId: result.trashId,
      });
    }

    if (pathname === '/api/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return sendJson(res, 200, await pipelineStatus());
    }

    if (pathname === '/api/agy') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (!session.privileged) {
        req.resume();
        return sendJson(res, 403, {
          error: 'Temporary viewing accounts cannot inspect rotator quota.',
        });
      }
      // Quota + token usage for the agy rotator. ?fresh=1 triggers a live
      // `/usage` probe per account (~10s); default serves cached quota and the
      // token ledger, which is instant. External tool: still a subprocess.
      const fresh = u.searchParams.get('fresh') === '1';
      const script = `import sys, json
sys.path.insert(0, ${JSON.stringify(AGY_LIB)})
import agy_rotate as R
print(json.dumps(R.quota_overview(fresh=${fresh ? 'True' : 'False'})))`;
      return execFile(PYTHON, ['-c', script], { timeout: fresh ? 60000 : 15000 }, (err, stdout) => {
        if (err) return sendJson(res, 502, { error: 'agy rotator unavailable' });
        try {
          return sendJson(res, 200, JSON.parse(stdout));
        } catch {
          return sendJson(res, 502, { error: 'bad rotator output' });
        }
      });
    }

    if (pathname.startsWith('/media/')) {
      if (await handleLanguagesMediaRoute(req, res, pathname, u, sendJson)) return undefined;
      // /media/<slug>/<ch>/video.mp4 -> series/<slug>/out/<ch>/video.mp4
      // /media/<slug>/full.mp4 -> series/<slug>/out/full/video/video.mp4
      const parts = pathname.slice('/media/'.length).split('/');
      let file: string | null = null;
      let mediaType = MIME['.mp4'];
      if (parts.length === 3 && parts[2] === 'video.mp4') {
        file = safeJoin(SERIES_ROOT, parts[0], 'out', parts[1], 'video', 'video.mp4');
      } else if (parts.length === 4 && parts[2] === 'vp' && /^[\w.-]+\.mp4$/i.test(parts[3])) {
        // /media/<slug>/<ch>/vp/<arm>.mp4 -> series/<slug>/out/<ch>/video_paths/<arm>.mp4
        file = safeJoin(SERIES_ROOT, parts[0], 'out', parts[1], 'video_paths', parts[3]);
      } else if (parts.length === 2 && parts[1] === 'full.mp4') {
        file = safeJoin(SERIES_ROOT, parts[0], 'out', 'full', 'video', 'video.mp4');
      } else if (parts.length === 3 && parts[1] === 'outro' && parts[2] === 'audio.mp3') {
        file = safeJoin(SERIES_ROOT, parts[0], 'out', 'outro', 'audio', 'narration.mp3');
        mediaType = 'audio/mpeg';
      }
      if (!file) return send(res, 403, 'forbidden');
      if (u.searchParams.get('download') === '1') {
        const name = parts.length === 2 ? `${parts[0]}-full.mp4` : `${parts[0]}-${parts[1]}${mediaType === 'audio/mpeg' ? '.mp3' : '.mp4'}`;
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      }
      return await streamFile(req, res, file, mediaType);
    }

    if (pathname.startsWith('/thumbs/')) {
      // /thumbs/<file> -> thumbnails/<file>
      const name = pathname.slice('/thumbs/'.length);
      const file = name && !name.includes('/') ? safeJoin(THUMBS_ROOT, name) : null;
      if (!file) return send(res, 403, 'forbidden');
      const ext = path.extname(name).toLowerCase();
      if (!MIME[ext]) return send(res, 403, 'forbidden');
      if (u.searchParams.get('download') === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      }
      return await streamFile(req, res, file, MIME[ext]);
    }

    if (pathname.startsWith('/poster/')) {
      // /poster/<slug>/<ch> -> series/<slug>/<ch>/001.webp
      const parts = pathname.slice('/poster/'.length).split('/');
      const file = parts.length === 2 ? safeJoin(SERIES_ROOT, parts[0], parts[1], '001.webp') : null;
      if (!file) return send(res, 403, 'forbidden');
      return await streamFile(req, res, file, MIME['.webp']);
    }

    const asset = safeJoin(PUBLIC, pathname.replace(/^\/+/, ''));
    if (asset && process.env.PLAYER_API_ONLY !== '1') {
      const ext = path.extname(asset).toLowerCase();
      if (MIME[ext]) return await streamFile(req, res, asset, MIME[ext]);
    }

    send(res, 404, 'not found');
  } catch (err) {
    console.error(`[${requestId}]`, err);
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    const status = (err as { statusCode?: number }).statusCode;
    const code = status && status >= 400 && status < 500 ? status : 500;
    sendJson(res, code, { error: code === 500 ? 'server error' : (err as Error).message, requestId });
  }
}

/** Build (but do not start) the player HTTP server. */
export function createPlayerServer(): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      console.error('Unhandled request error:', err);
      res.destroy();
    });
  });
  // Let the intake upload's ten-minute deadline report its own controlled error.
  server.requestTimeout = 610000;
  return server;
}

export const server = createPlayerServer();
server.once('close', stopLanguageQueue);

function ranDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (ranDirectly()) {
  server.listen(PORT, HOST, () => {
    console.log(`player listening on http://${HOST}:${PORT}`);
    console.log(`serving series from ${SERIES_ROOT}`);
    void initIntakeQueue();
  });
}

export {
  PUBLIC,
  SERIES_ROOT,
  PIPELINE_LOG,
  THUMBS_ROOT,
  PORT,
  HOST,
  MAX_LANE_CONFIG_BODY_BYTES,
  MAX_DELETE_BODY_BYTES,
};
