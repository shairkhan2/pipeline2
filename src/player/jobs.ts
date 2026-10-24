/**
 * Intake API for the Screening Room player.
 *
 * Port of player/jobs.js. Calls intake.ts and voicePreview.ts in-process.
 * Clients never send commands, hosts, URLs, or env names for the render lane.
 */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { MAX_ZIP_BYTES } from '../intake/ingest.js';
import {
  IntakeError,
  RENDER_QUALITIES,
  continueJob,
  enqueueJob,
  getCatalog,
  getJob,
  jobsDir,
  listJobs,
  normalizeRenderQuality,
  pauseJob,
  resumeJob,
  stopJob,
  reconcileJobs,
  reconcileOrphans,
  retryJob,
  sanitizeLine,
  spawnWorkerIfNeeded,
  type EnqueueOptions,
} from '../intake/intake.js';
import { PREVIEW_DIR_NAME, generatePreview } from '../intake/voicePreview.js';
import { FORBIDDEN_FIELDS, checkForbiddenKeys, readJsonBody, verifyCsrf } from './lanes.js';
import type { LaneSession, SendJson } from './lanes.js';
import { streamFile } from './stream.js';
import { getRegisteredNodes } from '../workers/nodeRegistry.js';

export { FORBIDDEN_FIELDS, checkForbiddenKeys, readJsonBody, verifyCsrf };
export type { LaneSession, SendJson };

const PREVIEW_ID_RE = /^[a-f0-9]{64}$/;
const PREVIEW_ROUTE_RE = /^\/api\/intake\/preview\/([a-f0-9]{64})\.mp3$/;
const MAX_PREVIEW_JSON_BYTES = 2048;

export const RENDER_LANE_VALUES = ['inherit', 'local', 'laptop', 'cloud'] as const;
export const DEFAULT_RENDER_LANE = 'inherit';

/**
 * Lane ids a job may pin: the four built-in selectors plus every node currently
 * registered in `render-nodes.json`. Never returns hosts or credentials.
 */
export function renderLaneValues(): string[] {
  const out = new Set<string>(RENDER_LANE_VALUES);
  try {
    for (const node of getRegisteredNodes()) {
      const id = String(node.id ?? '').trim().toLowerCase();
      if (id) out.add(id);
    }
  } catch {
    // an unreadable registry leaves only the built-in selectors
  }
  return [...out];
}

export function normalizeRenderLane(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_RENDER_LANE;
  if (!renderLaneValues().includes(value)) return null;
  return value;
}

/**
 * True when a request field was absent or blank, so it must not override a
 * persisted default. Applies to `renderQuality`, where `null` means "resolve at
 * run time"; `renderLane` handles `null` separately because it is a valid value.
 */
function isBlankField(raw: unknown): boolean {
  return raw === null || raw === undefined || String(raw).trim() === '';
}

export function resolveJobsDir(): string {
  return jobsDir();
}

function getMaxZipBytes(): number {
  const raw = Number(process.env.MANHWA_MAX_ZIP_BYTES || MAX_ZIP_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_ZIP_BYTES;
}

function errorStatus(err: unknown, fallback: number): { status: number; error: string } {
  const e = err as Error & { statusCode?: number };
  const msg = e?.message || 'Intake command failed';
  if (err instanceof IntakeError) {
    const status = /not found/i.test(msg) ? 404 : e.statusCode || fallback;
    return { status, error: msg };
  }
  return { status: e.statusCode || fallback, error: sanitizeLine(msg) || 'Intake command failed' };
}

let queueWatchdog: ReturnType<typeof setInterval> | null = null;

export async function initIntakeQueue(): Promise<void> {
  try {
    reconcileJobs();
    reconcileOrphans();
    spawnWorkerIfNeeded();
  } catch (err) {
    console.error('intake startup reconcile warning:', (err as Error).message);
  }
  // Overnight runs heal without a browser open: a dead run is requeued and a
  // worker is spawned for any due retry, even when nobody polls the UI.
  if (!queueWatchdog) {
    queueWatchdog = setInterval(() => {
      try {
        reconcileJobs(undefined, true);
        spawnWorkerIfNeeded();
      } catch (err) {
        console.error('intake watchdog warning:', (err as Error).message);
      }
    }, 60_000);
    queueWatchdog.unref();
  }
}

export function resolvePreviewAudioPath(id: string): string | null {
  if (typeof id !== 'string' || !PREVIEW_ID_RE.test(id)) return null;
  const base = path.resolve(jobsDir(), PREVIEW_DIR_NAME);
  const file = path.resolve(base, `${id}.mp3`);
  if (!file.startsWith(base + path.sep)) return null;
  try {
    if (!fsSync.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

async function servePreviewAudio(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sendJson: SendJson,
): Promise<unknown> {
  const file = resolvePreviewAudioPath(id);
  if (!file) return sendJson(res, 404, { error: 'Preview not found' });
  res.setHeader('Cache-Control', 'no-store');
  return streamFile(req, res, file, 'audio/mpeg');
}

export async function streamUploadToStaging(
  req: IncomingMessage,
  maxZipBytes: number,
  timeoutMs = 600000,
): Promise<{ path: string; bytes: number }> {
  const contentLength = req.headers['content-length'];
  if (contentLength && /^\d+$/.test(String(contentLength))) {
    const declared = Number(contentLength);
    if (declared <= 0) {
      const err = new Error('Uploaded ZIP file is empty') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (declared > maxZipBytes) {
      const err = new Error(`Uploaded ZIP exceeds maximum allowed size (${maxZipBytes} bytes)`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 413;
      throw err;
    }
  }

  const uploadsDir = path.join(jobsDir(), 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const id = `upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const partPath = path.join(uploadsDir, `${id}.zip.part`);
  const finalPath = path.join(uploadsDir, `${id}.zip`);

  return new Promise((resolve, reject) => {
    let total = 0;
    let headerBuf = Buffer.alloc(0);
    let headerChecked = false;
    let settled = false;
    let fd: number | null = null;
    try {
      fd = fsSync.openSync(partPath, 'w', 0o640);
    } catch (err) {
      reject(err);
      return;
    }
    // `out.destroy()` closes `fd` because the stream defaults to autoClose: true,
    // so cleanup must not close it a second time.
    let streamOpened = false;
    const out = fsSync.createWriteStream(partPath, { fd });
    streamOpened = true;

    // Declared before cleanupFail: a failure before the timer exists must not
    // hit a temporal-dead-zone ReferenceError while unwinding.
    let timer: NodeJS.Timeout | null = null;

    const cleanupFail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        out.destroy();
      } catch {
        // already dead
      }
      if (fd !== null && !streamOpened) {
        try {
          fsSync.closeSync(fd);
        } catch {
          // already closed
        }
        fd = null;
      }
      try {
        fsSync.unlinkSync(partPath);
      } catch {
        // missing
      }
      try {
        fsSync.unlinkSync(finalPath);
      } catch {
        // missing
      }
      reject(err);
    };

    timer = setTimeout(() => {
      const err = new Error('Upload timed out') as Error & { statusCode?: number };
      err.statusCode = 408;
      cleanupFail(err);
    }, timeoutMs);

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxZipBytes) {
        const err = new Error(`Uploaded ZIP exceeds maximum allowed size (${maxZipBytes} bytes)`) as Error & {
          statusCode?: number;
        };
        err.statusCode = 413;
        req.resume();
        cleanupFail(err);
        return;
      }
      if (!headerChecked) {
        headerBuf = Buffer.concat([headerBuf, chunk.subarray(0, Math.min(chunk.length, 4 - headerBuf.length))]);
        if (headerBuf.length >= 4) {
          headerChecked = true;
          if (headerBuf[0] !== 0x50 || headerBuf[1] !== 0x4b || headerBuf[2] !== 0x03 || headerBuf[3] !== 0x04) {
            const err = new Error('Uploaded file is not a valid ZIP archive (bad magic header)') as Error & {
              statusCode?: number;
            };
            err.statusCode = 400;
            req.resume();
            cleanupFail(err);
            return;
          }
        }
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });

    req.on('aborted', () => {
      const err = new Error('Upload aborted by client') as Error & { statusCode?: number };
      err.statusCode = 400;
      cleanupFail(err);
    });
    req.on('error', (err) => cleanupFail(err));
    out.on('error', (err) => cleanupFail(err));
    req.on('end', () => {
      if (settled) return;
      if (total < 4 || !headerChecked) {
        const err = new Error('Uploaded file is not a valid ZIP archive') as Error & { statusCode?: number };
        err.statusCode = 400;
        cleanupFail(err);
        return;
      }
      out.end(() => {
        fd = null;
        if (settled) return;
        if (timer) clearTimeout(timer);
        try {
          fsSync.renameSync(partPath, finalPath);
          settled = true;
          resolve({ path: finalPath, bytes: total });
        } catch (err) {
          cleanupFail(err as Error);
        }
      });
    });
  });
}

export async function handleIntakeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  urlObj: URL,
  session: LaneSession | null,
  sendJson: SendJson,
): Promise<unknown> {
  if (!session) return sendJson(res, 401, { error: 'auth required' });

  if (pathname === '/api/intake/catalog' && req.method === 'GET') {
    try {
      const catalog = await getCatalog();
      return sendJson(res, 200, {
        ...catalog,
        user: session.user,
        privileged: session.privileged,
        csrfToken: session.csrfToken,
      });
    } catch (err) {
      const mapped = errorStatus(err, 500);
      return sendJson(res, mapped.status, { error: mapped.error || 'Catalog unavailable' });
    }
  }

  if (pathname === '/api/intake/jobs' && req.method === 'GET') {
    try {
      const list = listJobs({ includeLogs: true });
      return sendJson(res, 200, {
        ...list,
        privileged: session.privileged,
        csrfToken: session.csrfToken,
      });
    } catch (err) {
      const mapped = errorStatus(err, 500);
      return sendJson(res, mapped.status, { error: mapped.error || 'Jobs list unavailable' });
    }
  }

  if (pathname.startsWith('/api/intake/jobs/') && req.method === 'GET') {
    const jobId = pathname.slice('/api/intake/jobs/'.length);
    if (!/^job-\d+-[a-f0-9]+$/.test(jobId)) return sendJson(res, 400, { error: 'Invalid job ID' });
    try {
      return sendJson(res, 200, getJob(jobId));
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Job lookup failed' });
    }
  }

  if (pathname.startsWith('/api/intake/jobs/') && req.method === 'POST') {
    const rest = pathname.slice('/api/intake/jobs/'.length);
    const m = /^(job-\d+-[a-f0-9]+)\/(retry|continue|pause|resume|stop|cancel)$/.exec(rest);
    if (!m) {
      if (/^[^/]+\/(retry|continue|pause|resume|stop|cancel)$/.test(rest)) return sendJson(res, 400, { error: 'Invalid job ID' });
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const [, jobId, action] = m;
    if (!session.privileged) {
      req.resume();
      return sendJson(res, 403, {
        error: 'Temporary viewing accounts cannot change pipeline jobs. Sign in with a persistent account.',
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, MAX_PREVIEW_JSON_BYTES);
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Bad request body' });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON object body required' });
    }
    const csrfCheck = verifyCsrf(req, session, typeof body.csrfToken === 'string' ? body.csrfToken : '');
    if (!csrfCheck.ok) return sendJson(res, 403, { error: csrfCheck.error });
    const forbiddenBody = checkForbiddenKeys(body);
    if (forbiddenBody) return sendJson(res, 400, { error: forbiddenBody });

    try {
      if (action === 'pause' || action === 'resume' || action === 'stop' || action === 'cancel') {
        const extra = Object.keys(body).filter((key) => key !== 'csrfToken');
        if (extra.length) return sendJson(res, 400, { error: `Unsupported ${action} field: ${extra[0]}` });
        const job = action === 'pause'
          ? pauseJob(jobId)
          : action === 'resume'
            ? resumeJob(jobId)
            : stopJob(jobId);
        return sendJson(res, 200, { job });
      }
      if (action === 'retry') {
        if (Object.prototype.hasOwnProperty.call(body, 'renderLane')) {
          return sendJson(res, 400, {
            error: 'renderLane cannot be changed by retry; the job keeps the render lane it was created with.',
          });
        }
        const extra = Object.keys(body).filter((k) => k !== 'csrfToken');
        if (extra.length) return sendJson(res, 400, { error: `Unsupported retry field: ${extra[0]}` });
        const job = retryJob(jobId!);
        return sendJson(res, 200, { job });
      }
      if (Object.prototype.hasOwnProperty.call(body, 'renderLane')) {
        return sendJson(res, 400, {
          error: 'renderLane cannot be changed by continue; the job keeps the render lane it was created with.',
        });
      }
      const allowed = new Set(['chapters', 'csrfToken']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) return sendJson(res, 400, { error: `Unsupported continue field: ${key}` });
      }
      const chapters = String(body.chapters || 'all').trim();
      if (!chapters) return sendJson(res, 400, { error: 'chapters is required (for example 2-5 or all)' });
      const job = continueJob(jobId!, chapters);
      return sendJson(res, 200, { job });
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Job action failed' });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const audioMatch = PREVIEW_ROUTE_RE.exec(pathname);
    if (audioMatch) {
      const id = audioMatch[1]!;
      if (!PREVIEW_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid preview ID' });
      return servePreviewAudio(req, res, id, sendJson);
    }
  }

  if (pathname === '/api/intake/preview') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!session.privileged) {
      req.resume();
      return sendJson(res, 403, {
        error: 'Temporary viewing accounts cannot generate voice previews. Sign in with a persistent account.',
      });
    }
    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_PREVIEW_JSON_BYTES) {
      req.resume();
      return sendJson(res, 413, { error: 'JSON request body too large' });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, MAX_PREVIEW_JSON_BYTES);
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Bad request body' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON object body required' });
    }
    const csrfCheck = verifyCsrf(req, session);
    if (!csrfCheck.ok) return sendJson(res, 403, { error: csrfCheck.error });
    const allowedKeys = new Set(['provider', 'voice']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) return sendJson(res, 400, { error: `Unsupported preview field: ${key}` });
    }
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const voice = typeof body.voice === 'string' ? body.voice.trim() : '';
    if (!provider || !voice) return sendJson(res, 400, { error: 'provider and voice are required' });
    try {
      const result = await generatePreview(provider, voice);
      return sendJson(res, 200, {
        id: result.id,
        duration: result.duration,
        cached: result.cached,
        audioUrl: `/api/intake/preview/${result.id}.mp3`,
      });
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Voice preview failed' });
    }
  }

  if (pathname === '/api/intake/jobs' && req.method === 'POST') {
    if (!session.privileged) {
      req.resume();
      return sendJson(res, 403, {
        error: 'Temporary viewing accounts cannot start pipeline jobs. Sign in with a persistent account.',
      });
    }
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    const isUploadStream =
      ctype.includes('application/zip') ||
      ctype.includes('application/octet-stream') ||
      urlObj.searchParams.get('sourceType') === 'upload';

    if (isUploadStream) {
      const csrfCheck = verifyCsrf(req, session);
      if (!csrfCheck.ok) {
        req.resume();
        return sendJson(res, 403, { error: csrfCheck.error });
      }
      const queryObj = Object.fromEntries(urlObj.searchParams.entries());
      const forbiddenQuery = checkForbiddenKeys(queryObj);
      if (forbiddenQuery) {
        req.resume();
        return sendJson(res, 400, { error: forbiddenQuery });
      }
      for (const hKey of Object.keys(req.headers)) {
        if (hKey.startsWith('x-')) {
          const fErr = checkForbiddenKeys({ [hKey]: req.headers[hKey] });
          if (fErr) {
            req.resume();
            return sendJson(res, 400, { error: fErr });
          }
        }
      }
      const decodeHeader = (name: string) => {
        const raw = req.headers[name];
        if (!raw) return '';
        try {
          return decodeURIComponent(String(raw));
        } catch {
          return String(raw);
        }
      };
      const title = String(urlObj.searchParams.get('title') || decodeHeader('x-series-title') || '').trim();
      const slug = String(urlObj.searchParams.get('slug') || decodeHeader('x-series-slug') || '').trim();
      const provider = String(urlObj.searchParams.get('provider') || decodeHeader('x-tts-provider') || 'edge').trim();
      const voice = String(urlObj.searchParams.get('voice') || decodeHeader('x-tts-voice') || '').trim();
      const chapters = String(urlObj.searchParams.get('chapters') || decodeHeader('x-chapters') || 'all').trim();
      const background = String(urlObj.searchParams.get('background') || decodeHeader('x-background') || 'starfield').trim();
      const motion = String(urlObj.searchParams.get('motion') || decodeHeader('x-motion') || 'window').trim();
      const filename = String(urlObj.searchParams.get('filename') || decodeHeader('x-upload-filename') || 'upload.zip').trim();
      const rawRenderLane = urlObj.searchParams.get('renderLane') ?? decodeHeader('x-render-lane');
      const renderLane = isBlankField(rawRenderLane) ? undefined : normalizeRenderLane(rawRenderLane);
      if (renderLane === null) {
        req.resume();
        return sendJson(res, 400, {
          error: `Unsupported renderLane: ${String(rawRenderLane).slice(0, 32)} (allowed: ${RENDER_LANE_VALUES.join(', ')})`,
        });
      }
      const rawRenderQuality = urlObj.searchParams.get('renderQuality') ?? decodeHeader('x-render-quality');
      const renderQuality = isBlankField(rawRenderQuality) ? undefined : normalizeRenderQuality(rawRenderQuality);
      if (renderQuality === null) {
        req.resume();
        return sendJson(res, 400, {
          error: `Unsupported renderQuality: ${String(rawRenderQuality).slice(0, 16)} (allowed: ${RENDER_QUALITIES.join(', ')})`,
        });
      }
      let outroConfig: ReturnType<typeof parseOutroConfig>;
      try {
        outroConfig = parseOutroConfig(parseJsonParam(urlObj.searchParams.get('outroConfig')));
      } catch (err) {
        req.resume();
        return sendJson(res, 400, { error: errorStatus(err, 400).error || 'Invalid outroConfig' });
      }
      let staged: { path: string; bytes: number } | null = null;
      try {
        staged = await streamUploadToStaging(req, getMaxZipBytes());
        const job = await enqueueJob({
          sourceType: 'upload',
          zipPath: staged.path,
          uploadFilename: filename,
          title,
          slug,
          provider,
          voice,
          chapters,
          background,
          motion,
          renderLane,
          renderQuality,
          createdBy: session.user,
          outroConfig,
          style: parseJsonParam(urlObj.searchParams.get('style')) as import('../config/seriesStyle.js').SeriesStyle | undefined,
          tts: parseJsonParam(urlObj.searchParams.get('tts')) as import('../intake/intake.js').EnqueueOptions['tts'],
          animation: parseJsonParam(urlObj.searchParams.get('animation')) as import('../intake/intake.js').EnqueueOptions['animation'],
        });
        return sendJson(res, 201, job);
      } catch (err) {
        if (staged?.path) {
          try {
            await fs.unlink(staged.path);
          } catch {
            // already moved or removed
          }
        }
        const mapped = errorStatus(err, 400);
        return sendJson(res, mapped.status, { error: mapped.error || 'Upload intake failed' });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Bad request body' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'JSON object body required' });
    }
    const csrfCheck = verifyCsrf(req, session, typeof body?.csrfToken === 'string' ? body.csrfToken : '');
    if (!csrfCheck.ok) return sendJson(res, 403, { error: csrfCheck.error });
    const forbiddenBody = checkForbiddenKeys(body);
    if (forbiddenBody) return sendJson(res, 400, { error: forbiddenBody });
    const sourceType = String(body.sourceType || 'gdrive').trim();
    if (sourceType !== 'gdrive') {
      return sendJson(res, 400, {
        error: 'JSON intake endpoint only accepts sourceType="gdrive". For ZIP uploads, stream the archive body.',
      });
    }
    // A JSON `null` lane is an explicit "inherit" (see normalizeRenderLane); only
    // an absent or blank field defers to the Studio default.
    const renderLane = body.renderLane === undefined || (typeof body.renderLane === 'string' && !body.renderLane.trim())
      ? undefined
      : normalizeRenderLane(body.renderLane);
    if (renderLane === null) {
      return sendJson(res, 400, {
        error: `Unsupported renderLane: ${String(body.renderLane).slice(0, 32)} (allowed: ${RENDER_LANE_VALUES.join(', ')})`,
      });
    }
    const renderQuality = isBlankField(body.renderQuality) ? undefined : normalizeRenderQuality(body.renderQuality);
    if (renderQuality === null) {
      return sendJson(res, 400, {
        error: `Unsupported renderQuality: ${String(body.renderQuality).slice(0, 16)} (allowed: ${RENDER_QUALITIES.join(', ')})`,
      });
    }
    try {
      const job = await enqueueJob({
        sourceType: 'gdrive',
        gdriveUrl: String(body.gdriveUrl || body.url || '').trim(),
        title: String(body.title || '').trim(),
        slug: String(body.slug || '').trim(),
        provider: String(body.provider || body.engine || 'edge').trim(),
        voice: String(body.voice || body.voiceId || '').trim(),
        chapters: String(body.chapters || 'all').trim(),
        background: String(body.background || 'starfield').trim(),
        motion: String(body.motion || 'window').trim(),
        renderLane,
        renderQuality,
        createdBy: session.user,
        outroConfig: parseOutroConfig(body.outroConfig),
        style: body.style as import('../config/seriesStyle.js').SeriesStyle | undefined,
        tts: body.tts as import('../intake/intake.js').EnqueueOptions['tts'],
        animation: body.animation as import('../intake/intake.js').EnqueueOptions['animation'],
      });
      return sendJson(res, 201, job);
    } catch (err) {
      const mapped = errorStatus(err, 400);
      return sendJson(res, mapped.status, { error: mapped.error || 'Failed to enqueue job' });
    }
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

/** Parse a JSON query parameter, treating an empty value as absent. */
export function parseJsonParam(raw: string | null): unknown {
  if (raw === null || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new IntakeError('outroConfig must be valid JSON') as IntakeError & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
}

/** Accept content-only outro settings, never runtime commands or environment overrides. */
export function parseOutroConfig(value: unknown): EnqueueOptions['outroConfig'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new IntakeError('outroConfig must be an object');
  const body = value as Record<string, unknown>;
  const hookType = body.hookType ?? 'part2';
  if (!['part2', 'next_chapter', 'new_series', 'custom'].includes(String(hookType))) throw new IntakeError('Invalid outro hookType');
  for (const key of ['totalChapters', 'coveredChapters']) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isInteger(body[key]) || Number(body[key]) < 0 || Number(body[key]) > 5000)) {
      throw new IntakeError(`${key} must be an integer between 0 and 5000`);
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new IntakeError('outroConfig.enabled must be a boolean');
  return { enabled: body.enabled === true, hookType: hookType as NonNullable<EnqueueOptions['outroConfig']>['hookType'],
    totalChapters: body.totalChapters as number | undefined, coveredChapters: body.coveredChapters as number | undefined,
    customNote: typeof (body.customNote ?? body.customPrompt) === 'string' ? String(body.customNote ?? body.customPrompt).slice(0, 8000) : undefined,
    nextSeriesTitle: typeof body.nextSeriesTitle === 'string' ? body.nextSeriesTitle.slice(0, 200) : undefined,
    provider: typeof body.provider === 'string' ? body.provider.slice(0, 64) : undefined,
    voice: typeof body.voice === 'string' ? body.voice.slice(0, 128) : undefined };
}
