/**
 * Shared advisory series lock helper for pipeline writers and player video deletion.
 *
 * Lock file:
 *   `<seriesRoot>/<slug>/.series.lock`
 *
 * Protocol:
 *   - Pipeline writers (`run.ts`, `renderlane.ts`, `cloudlane.ts`) hold a shared
 *     advisory flock (`LOCK_SH`) on `<seriesRoot>/<slug>/.series.lock` for their
 *     entire output-writing lifetime. Nested shared acquisitions inside the same
 *     process are refcounted in-process per `(pid, realSdir)` so inner exits never
 *     release the outer lock early and nested calls never deadlock.
 *   - Chapter video deletion (`deleteChapterVideo`) scans `/proc` for active
 *     pipeline writers, validates every path component without following symlinks,
 *     acquires a nonblocking exclusive advisory flock (`LOCK_EX | LOCK_NB`) on
 *     `<seriesRoot>/<slug>/.series.lock`, and holds it across final path/symlink/
 *     inode/scratch re-validation and `fs.unlinkSync(videoPath)`.
 *
 * Ported from `pipeline/series_lock.py` and `player/library-delete.js`.
 */
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERIES_LOCK_SCRIPT = fileURLToPath(import.meta.url);

export const LOCK_FILENAME = '.series.lock';
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CH_RE = /^ch[0-9]{1,4}$/i;
export const CAPTION_VAL_RE = /^v[0-9]+$/i;
export const MAX_DELETE_JSON_BYTES = 2048;
export const MAX_DELETE_BODY_BYTES = MAX_DELETE_JSON_BYTES;

export const VIDEO_REL = (slug: string, ch: string): string =>
  path.join(slug, 'out', ch, 'video', 'video.mp4');

export const pendingKey = (slug: string, ch: string): string =>
  `${slug}/${String(ch).toLowerCase()}`;

const PIPELINE_BOOLEAN_FLAGS = new Set([
  '--force',
  '--all',
  '--keep-stale',
  '--video',
  '--write-anyway',
  '--scout',
  '--status',
  '--clear-cache',
  '--no-audio-check',
  '--yes',
  '--json',
  '--once',
  '--dry-run',
  '-u',
  '-B',
  '-v',
  '-y',
]);

const PIPELINE_VALUE_FLAGS = new Set([
  '--reader-captions',
  '--scout-range',
  '--captions',
  '--chapters',
  '--provider',
  '--voice',
  '--engine',
  '--background',
  '--motion',
  '--zip',
  '--zip-path',
  '--gdrive-url',
  '--title',
  '--job',
  '--created-by',
  '--source-type',
  '--upload-filename',
  '--props',
  '--log',
  '--config',
  '--config-file',
  '--output',
  '--save-text-file',
  '-f',
  '-o',
  '-c',
]);

const READONLY_PIPELINE_FLAGS = new Set(['--status', '--help', '-h']);

/**
 * Structured path/symlink validation error for series locking and deletion.
 */
export class LockPathError extends Error {
  code: string;
  override message: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'LockPathError';
    this.code = code;
    this.message = message;
    this.status = status;
  }
}

/**
 * Raised when a nonblocking flock acquisition finds the lock already held.
 */
export class BlockingIOError extends Error {
  code: string;
  errno: number;
  syscall: string;

  constructor(message = 'Resource temporarily unavailable', errno = os.constants.errno.EAGAIN) {
    super(message);
    this.name = 'BlockingIOError';
    this.code = 'EAGAIN';
    this.errno = errno;
    this.syscall = 'flock';
  }
}

export type FlockMode =
  | 'sh'
  | 'ex'
  | 'un'
  | 'shared'
  | 'exclusive'
  | 'unlock'
  | 's'
  | 'x'
  | 'u'
  | '-s'
  | '-x'
  | '-u'
  | number;

function resolveFlockFlags(mode: FlockMode, nonblocking: boolean): string[] {
  if (typeof mode === 'number') {
    const nb = nonblocking || (mode & LOCK_NB) !== 0;
    if ((mode & LOCK_UN) !== 0) return ['-u'];
    if ((mode & LOCK_EX) !== 0) return nb ? ['-x', '-n'] : ['-x'];
    if ((mode & LOCK_SH) !== 0) return nb ? ['-s', '-n'] : ['-s'];
    throw new TypeError(`Invalid numeric flock mode: ${mode}`);
  }
  const norm = String(mode).trim().toLowerCase();
  if (norm === 'un' || norm === 'unlock' || norm === 'u' || norm === '-u') {
    return ['-u'];
  }
  if (norm === 'ex' || norm === 'exclusive' || norm === 'x' || norm === '-x') {
    return nonblocking ? ['-x', '-n'] : ['-x'];
  }
  if (norm === 'sh' || norm === 'shared' || norm === 's' || norm === '-s') {
    return nonblocking ? ['-s', '-n'] : ['-s'];
  }
  throw new TypeError(`Invalid flock mode: ${String(mode)}`);
}

/**
 * Acquire or release a real Linux kernel `flock(2)` lock on open file descriptor `fd`
 * via the `flock(1)` utility (`stdio[3] = fd`), interoperable with Python `fcntl.flock`
 * until `fs.closeSync(fd)` or `flockFd(fd, 'un')`.
 *
 * Throws `BlockingIOError` (`code === 'EAGAIN'`) when `flock` cannot acquire the lock.
 */
export function flockFd(fd: number, mode: FlockMode, nonblocking = false): boolean {
  if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0) {
    throw new TypeError(`Invalid file descriptor for flock: ${String(fd)}`);
  }
  const flags = resolveFlockFlags(mode, nonblocking);
  const res = spawnSync('flock', [...flags, '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new BlockingIOError('Series lock is busy');
  }
  return true;
}

/**
 * Non-throwing wrapper around `flockFd` that returns `false` when a nonblocking
 * lock is already held.
 */
export function tryFlockFd(fd: number, mode: FlockMode, nonblocking = true): boolean {
  try {
    return flockFd(fd, mode, nonblocking);
  } catch (err) {
    if (
      err instanceof BlockingIOError ||
      (err && typeof err === 'object' && ('code' in err) && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK'))
    ) {
      return false;
    }
    throw err;
  }
}

export function validateSlug(slug: unknown): string | null {
  if (typeof slug !== 'string') return null;
  const s = slug.trim();
  if (s.length < 2 || s.length > 64) return null;
  if (!SLUG_RE.test(s)) return null;
  return s;
}
export const validate_slug = validateSlug;

export function validateChapter(ch: unknown): string | null {
  if (typeof ch !== 'string') return null;
  const c = ch.trim().toLowerCase();
  if (!CH_RE.test(c)) return null;
  return c;
}
export const validate_chapter = validateChapter;

async function lstatOrNull(p: string): Promise<fsSync.Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

function lstatSyncOrNull(p: string): fsSync.Stats | null {
  try {
    return fsSync.lstatSync(p);
  } catch {
    return null;
  }
}

function lstatBigSyncOrNull(p: string): fsSync.BigIntStats | null {
  try {
    return fsSync.lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
}

export function matchOwnerAndMode(fd: number, lockPath: string, refDir: string): void {
  try {
    fsSync.fchmodSync(fd, 0o664);
  } catch {
    // ignore
  }
  if (typeof process.geteuid === 'function' && process.geteuid() !== 0) {
    return;
  }
  try {
    const st = fsSync.lstatSync(refDir);
    if (st.uid !== 0) {
      fsSync.fchownSync(fd, st.uid, st.gid);
    }
  } catch {
    try {
      const st = fsSync.lstatSync(refDir);
      if (st.uid !== 0) {
        fsSync.lchownSync(lockPath, st.uid, st.gid);
      }
    } catch {
      // ignore
    }
  }
}
export const _match_owner_and_mode = matchOwnerAndMode;

function toPathString(cand: unknown): string | null {
  if (typeof cand === 'string') {
    const raw = cand.trim();
    return raw.length > 0 ? raw : null;
  }
  if (cand instanceof URL) {
    return fileURLToPath(cand);
  }
  return null;
}

/**
 * Resolve the `<seriesRoot>/<slug>` directory from a series dir, `out` dir,
 * or any artifact path under `<seriesRoot>/<slug>/out/...`.
 */
export function inferSeriesDir(...candidates: unknown[]): string | null {
  for (const cand of candidates) {
    const raw = toPathString(cand);
    if (!raw) continue;
    const absPath = path.resolve(raw);
    let cur = absPath;
    while (cur && cur !== path.dirname(cur)) {
      if (path.basename(cur) === 'out') {
        const parent = path.dirname(cur);
        if (parent && parent !== cur) {
          return parent;
        }
      }
      cur = path.dirname(cur);
    }
  }
  for (const cand of candidates) {
    const raw = toPathString(cand);
    if (!raw) continue;
    const absPath = path.resolve(raw);
    const base = path.basename(absPath);
    if (base !== 'out' && validateSlug(base) !== null) {
      return absPath;
    }
  }
  return null;
}
export const infer_series_dir = inferSeriesDir;

export function lockFileForSeries(sdir: string): string {
  return path.join(path.resolve(String(sdir)), LOCK_FILENAME);
}
export const lock_file_for_series = lockFileForSeries;

export function validateSeriesDir(sdir: string, seriesRoot?: string | null): string {
  if (seriesRoot !== undefined && seriesRoot !== null) {
    const rootAbs = path.resolve(String(seriesRoot));
    const stRoot = lstatSyncOrNull(rootAbs);
    if (stRoot === null) {
      throw new LockPathError('not_found', 'The series library is unavailable.', 404);
    }
    if (stRoot.isSymbolicLink()) {
      throw new LockPathError(
        'escaped_symlink',
        'Refusing to follow a symbolic link in the video path.',
        400,
      );
    }
    if (!stRoot.isDirectory()) {
      throw new LockPathError('not_found', 'The series library is unavailable.', 404);
    }
  }

  const sdirAbs = path.resolve(String(sdir));
  const stSdir = lstatSyncOrNull(sdirAbs);
  if (stSdir === null) {
    throw new LockPathError('not_found', `Series directory not found: ${sdirAbs}`, 404);
  }
  if (stSdir.isSymbolicLink()) {
    throw new LockPathError(
      'escaped_symlink',
      'Refusing to follow a symbolic link in the video path.',
      400,
    );
  }
  if (!stSdir.isDirectory()) {
    throw new LockPathError('not_found', `Series path is not a directory: ${sdirAbs}`, 404);
  }
  return sdirAbs;
}
export const _validate_series_dir = validateSeriesDir;

export function openAndFlock(
  sdir: string,
  mode: FlockMode,
  nonblocking = false,
  seriesRoot?: string | null,
): { fd: number; lockPath: string } {
  const sdirAbs = validateSeriesDir(sdir, seriesRoot);
  const lockPath = path.join(sdirAbs, LOCK_FILENAME);

  for (let attempt = 0; attempt < 3; attempt++) {
    const stBefore = lstatSyncOrNull(lockPath);
    if (stBefore !== null) {
      if (stBefore.isSymbolicLink()) {
        throw new LockPathError(
          'escaped_symlink',
          'Refusing to follow a symbolic link in the video path.',
          400,
        );
      }
      if (!stBefore.isFile()) {
        throw new LockPathError(
          'escaped_symlink',
          'Refusing to lock a non-regular file in the series directory.',
          400,
        );
      }
    }

    let fd: number | null = null;
    try {
      try {
        fd = fsSync.openSync(lockPath, 'a+', 0o664);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        if (code === 'EACCES' || code === 'EPERM') {
          fd = fsSync.openSync(lockPath, 'r');
        } else {
          throw err;
        }
      }
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'ELOOP') {
        throw new LockPathError(
          'escaped_symlink',
          'Refusing to follow a symbolic link in the video path.',
          400,
        );
      }
      throw err;
    }

    try {
      const stFd = fsSync.fstatSync(fd);
      if (!stFd.isFile()) {
        throw new LockPathError(
          'escaped_symlink',
          'Refusing to lock a non-regular file in the series directory.',
          400,
        );
      }
      matchOwnerAndMode(fd, lockPath, sdirAbs);
      flockFd(fd, mode, nonblocking);
      const stAfter = lstatSyncOrNull(lockPath);
      if (
        stAfter !== null &&
        !stAfter.isSymbolicLink() &&
        stAfter.isFile() &&
        stAfter.dev === stFd.dev &&
        stAfter.ino === stFd.ino
      ) {
        return { fd, lockPath };
      }
    } catch (err) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // ignore
      }
      throw err;
    }

    try {
      fsSync.closeSync(fd);
    } catch {
      // ignore
    }
  }

  throw new Error(`Could not stabilize series lock file at ${lockPath}`);
}
export const _open_and_flock = openAndFlock;

interface SharedLockEntry {
  key: string;
  pid: number;
  realSdir: string;
  sdirAbs: string;
  lockPath: string;
  fd: number;
  count: number;
}

const _SHARED_LOCKS = new Map<string, SharedLockEntry>();

export interface SharedSeriesLockOptions {
  directSdir?: string | null;
  direct_sdir?: string | null;
  requireExists?: boolean;
  require_exists?: boolean;
  nonblocking?: boolean;
  candidates?: Array<string | null | undefined>;
  seriesRoot?: string | null;
  series_root?: string | null;
}

export interface ExclusiveSeriesLockOptions {
  sdir?: string;
  seriesRoot?: string | null;
  series_root?: string | null;
  nonblocking?: boolean;
}

function isPlainOptionsObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== 'object' || Array.isArray(val) || val instanceof URL) {
    return false;
  }
  return true;
}

function parseSharedLockArgs(args: unknown[]): {
  candidates: unknown[];
  directSdir: string | null;
  requireExists: boolean;
  nonblocking: boolean;
  seriesRoot: string | null;
} {
  let candidates: unknown[] = [];
  let directSdir: string | null = null;
  let requireExists = true;
  let nonblocking = false;
  let seriesRoot: string | null = null;

  if (
    args.length >= 2 &&
    (typeof args[0] === 'string' || args[0] instanceof URL) &&
    typeof args[1] === 'boolean'
  ) {
    candidates.push(args[0]);
    requireExists = args[1];
    if (typeof args[2] === 'boolean') {
      nonblocking = args[2];
    }
    return { candidates, directSdir, requireExists, nonblocking, seriesRoot };
  }

  for (const arg of args) {
    if (Array.isArray(arg)) {
      candidates.push(...arg);
    } else if (isPlainOptionsObject(arg)) {
      const opts = arg as SharedSeriesLockOptions;
      const ds = opts.directSdir ?? opts.direct_sdir;
      if (typeof ds === 'string' && ds.trim()) {
        directSdir = ds.trim();
      }
      const req = opts.requireExists ?? opts.require_exists;
      if (typeof req === 'boolean') {
        requireExists = req;
      }
      if (typeof opts.nonblocking === 'boolean') {
        nonblocking = opts.nonblocking;
      }
      if (Array.isArray(opts.candidates)) {
        candidates.push(...opts.candidates);
      }
      const sr = opts.seriesRoot ?? opts.series_root;
      if (typeof sr === 'string' && sr.trim()) {
        seriesRoot = sr.trim();
      }
    } else if (arg !== undefined && arg !== null) {
      candidates.push(arg);
    }
  }

  return { candidates, directSdir, requireExists, nonblocking, seriesRoot };
}

function resolveSharedTargetSdir(
  candidates: unknown[],
  directSdir: string | null,
): string | null {
  if (directSdir !== null) {
    return path.resolve(directSdir);
  }
  const inferred = inferSeriesDir(...candidates);
  if (inferred !== null) {
    return inferred;
  }
  // If a single directory path was passed directly (e.g. acquireSharedSeriesLock(sdir)),
  // allow resolving it as directSdir when it is not an `out` directory or file path.
  if (candidates.length === 1) {
    const single = toPathString(candidates[0]);
    if (single) {
      const abs = path.resolve(single);
      const base = path.basename(abs);
      if (base !== 'out' && !base.includes('.')) {
        return abs;
      }
    }
  }
  return null;
}

/**
 * Acquire a refcounted in-process shared advisory lock (`LOCK_SH`) on `<sdir>/.series.lock`.
 * Returns the resolved `lockPath` (or `null` when `requireExists: false` and the series directory is absent).
 */
export function acquireSharedSeriesLock(...args: unknown[]): string | null {
  const { candidates, directSdir, requireExists, nonblocking, seriesRoot } =
    parseSharedLockArgs(args);

  const sdir = resolveSharedTargetSdir(candidates, directSdir);
  if (!sdir) {
    if (requireExists) {
      throw new LockPathError('not_found', 'Could not resolve series directory for lock.', 404);
    }
    return null;
  }

  const stLex = lstatSyncOrNull(sdir);
  if (stLex === null) {
    if (requireExists) {
      throw new LockPathError('not_found', `Series directory not found: ${sdir}`, 404);
    }
    return null;
  }

  const sdirAbs = validateSeriesDir(sdir, seriesRoot);
  const realSdir = fsSync.realpathSync(sdirAbs);
  const key = `${process.pid}:${realSdir}`;

  const existing = _SHARED_LOCKS.get(key);
  if (existing !== undefined && existing.count > 0) {
    existing.count += 1;
    return existing.lockPath;
  }

  const { fd, lockPath } = openAndFlock(sdirAbs, 'sh', nonblocking, seriesRoot);
  const raced = _SHARED_LOCKS.get(key);
  if (raced !== undefined && raced.count > 0) {
    raced.count += 1;
    try {
      fsSync.closeSync(fd);
    } catch {
      // ignore
    }
    return raced.lockPath;
  }

  _SHARED_LOCKS.set(key, {
    key,
    pid: process.pid,
    realSdir,
    sdirAbs,
    lockPath,
    fd,
    count: 1,
  });
  return lockPath;
}

function findSharedLockEntry(target: unknown): SharedLockEntry | undefined {
  if (target === null || target === undefined) return undefined;
  if (typeof target === 'object' && !Array.isArray(target) && !(target instanceof URL)) {
    const obj = target as { key?: unknown; lockPath?: unknown; sdir?: unknown };
    return (
      findSharedLockEntry(obj.key) ??
      findSharedLockEntry(obj.lockPath) ??
      findSharedLockEntry(obj.sdir)
    );
  }
  const raw = toPathString(target);
  if (!raw) return undefined;

  const direct = _SHARED_LOCKS.get(raw);
  if (direct && direct.pid === process.pid) {
    return direct;
  }

  const abs = path.resolve(raw);
  const candidateSdir =
    path.basename(abs) === LOCK_FILENAME
      ? path.dirname(abs)
      : inferSeriesDir(abs) ?? abs;

  let realCand: string | null = null;
  try {
    realCand = fsSync.realpathSync(candidateSdir);
  } catch {
    realCand = null;
  }

  if (realCand) {
    const byKey = _SHARED_LOCKS.get(`${process.pid}:${realCand}`);
    if (byKey) return byKey;
  }

  for (const entry of _SHARED_LOCKS.values()) {
    if (entry.pid !== process.pid) continue;
    if (
      entry.lockPath === abs ||
      entry.sdirAbs === abs ||
      entry.sdirAbs === candidateSdir ||
      entry.realSdir === abs ||
      entry.realSdir === candidateSdir
    ) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Release one refcount on a shared advisory series lock acquired via `acquireSharedSeriesLock`.
 * Closes the underlying file descriptor (dropping the kernel `flock`) only when the
 * in-process reference count reaches zero.
 */
export function releaseSharedSeriesLock(target: unknown): void {
  const entry = findSharedLockEntry(target);
  if (!entry) return;

  entry.count -= 1;
  if (entry.count <= 0) {
    _SHARED_LOCKS.delete(entry.key);
    try {
      flockFd(entry.fd, 'un');
    } catch {
      // ignore
    }
    try {
      fsSync.closeSync(entry.fd);
    } catch {
      // ignore
    }
  }
}

function isPromiseLike<T = unknown>(val: unknown): val is PromiseLike<T> {
  return (
    val !== null &&
    (typeof val === 'object' || typeof val === 'function') &&
    typeof (val as { then?: unknown }).then === 'function'
  );
}

/**
 * Execute `fn` while holding a refcounted shared advisory lock (`LOCK_SH`) on `<sdir>/.series.lock`.
 * Supports both synchronous and asynchronous (`Promise`-returning) callbacks.
 */
export function withSharedSeriesLock<T>(
  sdirOrOptions: string | SharedSeriesLockOptions | Array<string | null | undefined>,
  fn: (lockPath: string | null) => T,
): T;
export function withSharedSeriesLock<T>(
  sdirOrCandidates: string | Array<string | null | undefined>,
  options: SharedSeriesLockOptions,
  fn: (lockPath: string | null) => T,
): T;
export function withSharedSeriesLock<T>(...args: unknown[]): T {
  const fnIdx = args.findIndex((a) => typeof a === 'function');
  if (fnIdx < 0) {
    throw new TypeError('withSharedSeriesLock requires a callback function');
  }
  const fn = args[fnIdx] as (lockPath: string | null) => T;
  const lockArgs = [...args.slice(0, fnIdx), ...args.slice(fnIdx + 1)];
  const lockPath = acquireSharedSeriesLock(...lockArgs);

  let isAsync = false;
  try {
    const result = fn(lockPath);
    if (isPromiseLike(result)) {
      isAsync = true;
      return Promise.resolve(result).finally(() => {
        if (lockPath !== null) {
          releaseSharedSeriesLock(lockPath);
        }
      }) as unknown as T;
    }
    return result;
  } finally {
    if (!isAsync && lockPath !== null) {
      releaseSharedSeriesLock(lockPath);
    }
  }
}
export const sharedSeriesLock = withSharedSeriesLock;
export const shared_series_lock = withSharedSeriesLock;

export interface ExclusiveLockHandle {
  fd: number;
  lockPath: string;
  sdirAbs: string;
}

function parseExclusiveLockArgs(args: unknown[]): {
  sdir: string;
  seriesRoot: string | null;
  nonblocking: boolean;
} {
  let sdir = '';
  let seriesRoot: string | null = null;
  let nonblocking = true;

  for (const arg of args) {
    if (typeof arg === 'string' || arg instanceof URL) {
      const str = toPathString(arg) ?? '';
      if (!sdir) {
        sdir = str;
      } else if (seriesRoot === null) {
        seriesRoot = str;
      }
    } else if (typeof arg === 'boolean') {
      nonblocking = arg;
    } else if (isPlainOptionsObject(arg)) {
      const opts = arg as ExclusiveSeriesLockOptions;
      if (typeof opts.sdir === 'string' && opts.sdir.trim()) {
        sdir = opts.sdir.trim();
      }
      const sr = opts.seriesRoot ?? opts.series_root;
      if (typeof sr === 'string' && sr.trim()) {
        seriesRoot = sr.trim();
      }
      if (typeof opts.nonblocking === 'boolean') {
        nonblocking = opts.nonblocking;
      }
    }
  }

  return { sdir, seriesRoot, nonblocking };
}

export function acquireExclusiveSeriesLock(
  sdir: string,
  options?: ExclusiveSeriesLockOptions | boolean,
): ExclusiveLockHandle {
  const parsed =
    typeof options === 'boolean'
      ? { sdir, seriesRoot: null, nonblocking: options }
      : parseExclusiveLockArgs([sdir, options]);

  const sdirAbs = validateSeriesDir(parsed.sdir, parsed.seriesRoot);
  const realSdir = fsSync.realpathSync(sdirAbs);
  const key = `${process.pid}:${realSdir}`;

  if (parsed.nonblocking) {
    const existing = _SHARED_LOCKS.get(key);
    if (existing !== undefined && existing.count > 0) {
      throw new BlockingIOError('Series shared lock is active');
    }
  }

  const { fd, lockPath } = openAndFlock(
    sdirAbs,
    'ex',
    parsed.nonblocking,
    parsed.seriesRoot,
  );
  return { fd, lockPath, sdirAbs };
}

export function releaseExclusiveSeriesLock(handle: ExclusiveLockHandle | number | null | undefined): void {
  if (handle === null || handle === undefined) return;
  const fd = typeof handle === 'number' ? handle : handle.fd;
  try {
    flockFd(fd, 'un');
  } catch {
    // ignore
  }
  try {
    fsSync.closeSync(fd);
  } catch {
    // ignore
  }
}

/**
 * Execute `fn` while holding an exclusive advisory lock (`LOCK_EX`) on `<sdir>/.series.lock`.
 * Supports both synchronous and asynchronous (`Promise`-returning) callbacks.
 */
export function withExclusiveSeriesLock<T>(
  sdir: string,
  fn: (lockPath: string) => T,
): T;
export function withExclusiveSeriesLock<T>(
  sdir: string,
  options: ExclusiveSeriesLockOptions | boolean,
  fn: (lockPath: string) => T,
): T;
export function withExclusiveSeriesLock<T>(
  options: ExclusiveSeriesLockOptions,
  fn: (lockPath: string) => T,
): T;
export function withExclusiveSeriesLock<T>(...args: unknown[]): T {
  const fnIdx = args.findIndex((a) => typeof a === 'function');
  if (fnIdx < 0) {
    throw new TypeError('withExclusiveSeriesLock requires a callback function');
  }
  const fn = args[fnIdx] as (lockPath: string) => T;
  const lockArgs = [...args.slice(0, fnIdx), ...args.slice(fnIdx + 1)];
  const parsed = parseExclusiveLockArgs(lockArgs);
  const handle = acquireExclusiveSeriesLock(parsed.sdir, {
    seriesRoot: parsed.seriesRoot,
    nonblocking: parsed.nonblocking,
  });

  let isAsync = false;
  try {
    const result = fn(handle.lockPath);
    if (isPromiseLike(result)) {
      isAsync = true;
      return Promise.resolve(result).finally(() => {
        releaseExclusiveSeriesLock(handle);
      }) as unknown as T;
    }
    return result;
  } finally {
    if (!isAsync) {
      releaseExclusiveSeriesLock(handle);
    }
  }
}
export const exclusiveSeriesLock = withExclusiveSeriesLock;
export const exclusive_series_lock = withExclusiveSeriesLock;

export function hasActiveLocalRenderScratch(videoFilePath: string): boolean {
  const renderTmpDir = path.join(path.dirname(videoFilePath), '.render-tmp');
  let st: fsSync.Stats;
  try {
    st = fsSync.statSync(renderTmpDir);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    return true;
  }
  if (!st.isDirectory() || (st.mode & 0o444) === 0 || (st.mode & 0o111) === 0) {
    return true;
  }
  try {
    const entries = fsSync.readdirSync(renderTmpDir);
    return entries.some((name) => name.startsWith('.render-'));
  } catch {
    return true;
  }
}
export const _has_active_local_render_scratch = hasActiveLocalRenderScratch;

export interface ResolvedChapterVideoSuccess {
  ok: true;
  status: 200;
  path: string;
  realPath: string;
  rel: string;
  stat: fsSync.Stats;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  mtimeNs: bigint;
}

export interface ResolvedChapterVideoFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type ResolvedChapterVideoResult =
  | ResolvedChapterVideoSuccess
  | ResolvedChapterVideoFailure;

/**
 * Synchronous chapter video path validator used inside the exclusive lock critical section.
 */
export function resolveChapterVideoSync(
  seriesRoot: string,
  slug: string,
  ch: string,
): ResolvedChapterVideoResult {
  const s = validateSlug(slug);
  const c = validateChapter(ch);
  if (!s || !c) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_path',
      error: 'Series slug or chapter name is invalid.',
    };
  }
  const root = path.resolve(String(seriesRoot || ''));
  const rootSt = lstatSyncOrNull(root);
  if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    const isSym = Boolean(rootSt && rootSt.isSymbolicLink());
    return {
      ok: false,
      status: isSym ? 400 : 404,
      code: isSym ? 'escaped_symlink' : 'not_found',
      error: isSym
        ? 'Refusing to follow a symbolic link in the video path.'
        : 'The series library is unavailable.',
    };
  }
  let rootReal: string;
  try {
    rootReal = fsSync.realpathSync(root);
  } catch {
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      error: 'The series library is unavailable.',
    };
  }

  const parts = [s, 'out', c, 'video', 'video.mp4'];
  let cur = root;
  let lastStat: fsSync.Stats | null = null;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstatSyncOrNull(cur);
    if (!st) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        status: 400,
        code: 'escaped_symlink',
        error: 'Refusing to follow a symbolic link in the video path.',
      };
    }
    if (i === parts.length - 1) {
      if (!st.isFile()) {
        return {
          ok: false,
          status: 400,
          code: 'not_a_video',
          error: 'The target is not a regular video file.',
        };
      }
      lastStat = st;
    } else if (!st.isDirectory()) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
  }

  if (path.extname(cur).toLowerCase() !== '.mp4' || !lastStat) {
    return {
      ok: false,
      status: 400,
      code: 'not_a_video',
      error: 'The target is not an MP4 video file.',
    };
  }

  const rel = path.relative(root, cur);
  const expected = VIDEO_REL(s, c);
  if (!rel || rel !== expected || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_path',
      error: 'Refusing to delete outside the series library.',
    };
  }
  if (!cur.startsWith(root + path.sep)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_path',
      error: 'Refusing to delete outside the series library.',
    };
  }

  let real: string;
  try {
    real = fsSync.realpathSync(cur);
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'escaped_symlink',
      error: 'Refusing to delete a file outside the series library.',
    };
  }
  if (real !== path.join(rootReal, rel)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_symlink',
      error: 'Refusing to delete a file outside the series library.',
    };
  }

  const lockStat = lstatSyncOrNull(path.join(root, s, LOCK_FILENAME));
  if (lockStat && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_symlink',
      error: 'Refusing to follow a symbolic link in the video path.',
    };
  }

  const bigStat = lstatBigSyncOrNull(cur);
  return {
    ok: true,
    status: 200,
    path: cur,
    realPath: real,
    rel,
    stat: lastStat,
    size: lastStat.size,
    dev: lastStat.dev,
    ino: lastStat.ino,
    mtimeMs: lastStat.mtimeMs,
    mtimeNs: bigStat ? bigStat.mtimeNs : BigInt(Math.trunc(lastStat.mtimeMs * 1e6)),
  };
}
export const _resolve_chapter_video_sync = resolveChapterVideoSync;

/**
 * Resolve the rendered video path for one chapter asynchronously, refusing anything
 * that is not `<seriesRoot>/<slug>/out/<ch>/video/video.mp4` reachable without
 * following a symlink.
 */
export async function resolveChapterVideo(
  seriesRoot: string,
  slug: string,
  ch: string,
): Promise<ResolvedChapterVideoResult> {
  const s = validateSlug(slug);
  const c = validateChapter(ch);
  if (!s || !c) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_path',
      error: 'Series slug or chapter name is invalid.',
    };
  }
  const root = path.resolve(String(seriesRoot || ''));
  const rootStat = await lstatOrNull(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    const isSym = Boolean(rootStat && rootStat.isSymbolicLink());
    return {
      ok: false,
      status: isSym ? 400 : 404,
      code: isSym ? 'escaped_symlink' : 'not_found',
      error: isSym
        ? 'Refusing to follow a symbolic link in the video path.'
        : 'The series library is unavailable.',
    };
  }
  const rootReal = await fs.realpath(root).catch(() => null);
  if (!rootReal) {
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      error: 'The series library is unavailable.',
    };
  }

  const parts = [s, 'out', c, 'video', 'video.mp4'];
  let cur = root;
  let lastStat: fsSync.Stats | null = null;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = await lstatOrNull(cur);
    if (!st) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        status: 400,
        code: 'escaped_symlink',
        error: 'Refusing to follow a symbolic link in the video path.',
      };
    }
    const last = i === parts.length - 1;
    if (last) {
      if (!st.isFile()) {
        return {
          ok: false,
          status: 400,
          code: 'not_a_video',
          error: 'The target is not a regular video file.',
        };
      }
      lastStat = st;
    } else if (!st.isDirectory()) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
  }

  if (path.extname(cur).toLowerCase() !== '.mp4' || !lastStat) {
    return {
      ok: false,
      status: 400,
      code: 'not_a_video',
      error: 'The target is not an MP4 video file.',
    };
  }
  const rel = path.relative(root, cur);
  const expected = VIDEO_REL(s, c);
  if (!rel || rel !== expected || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_path',
      error: 'Refusing to delete outside the series library.',
    };
  }
  if (!cur.startsWith(root + path.sep)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_path',
      error: 'Refusing to delete outside the series library.',
    };
  }
  const real = await fs.realpath(cur).catch(() => null);
  if (!real || real !== path.join(rootReal, rel)) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_symlink',
      error: 'Refusing to delete a file outside the series library.',
    };
  }
  const lockStat = await lstatOrNull(path.join(root, s, LOCK_FILENAME));
  if (lockStat && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
    return {
      ok: false,
      status: 400,
      code: 'escaped_symlink',
      error: 'Refusing to follow a symbolic link in the video path.',
    };
  }
  const bigStat = lstatBigSyncOrNull(cur);
  return {
    ok: true,
    status: 200,
    path: cur,
    realPath: real,
    rel,
    stat: lastStat,
    size: lastStat.size,
    dev: lastStat.dev,
    ino: lastStat.ino,
    mtimeMs: lastStat.mtimeMs,
    mtimeNs: bigStat ? bigStat.mtimeNs : BigInt(Math.trunc(lastStat.mtimeMs * 1e6)),
  };
}

export interface ProcUnreadableError extends Error {
  code: 'proc_unreadable';
  cause?: unknown;
}

function procUnreadableError(message: string, cause?: unknown): ProcUnreadableError {
  const err = new Error(message) as ProcUnreadableError;
  err.code = 'proc_unreadable';
  if (cause !== undefined) {
    err.cause = cause;
  }
  return err;
}

function isPipelinePath(candidate: string): boolean {
  const norm = path.posix.normalize(String(candidate || '').replace(/\\/g, '/'));
  return (
    norm === 'pipeline/run.py' ||
    norm === 'pipeline/renderlane.py' ||
    norm.endsWith('/pipeline/run.py') ||
    norm.endsWith('/pipeline/renderlane.py') ||
    norm === 'src/cli/run.ts' ||
    norm === 'src/workers/renderlane.ts' ||
    norm.endsWith('/src/cli/run.ts') ||
    norm.endsWith('/src/workers/renderlane.ts')
  );
}

function readProcCwd(pidDir: string): { ok: boolean; cwd?: string; code?: string } {
  const cwdPath = path.join(pidDir, 'cwd');
  try {
    return { ok: true, cwd: fsSync.readlinkSync(cwdPath) };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
    if (code === 'EINVAL') {
      try {
        const txt = fsSync.readFileSync(cwdPath, 'utf8').trim();
        if (txt) return { ok: true, cwd: txt };
      } catch {
        // ignore
      }
    }
    return { ok: false, code };
  }
}

function isPipelineScriptArg(arg: string, pidDir: string): boolean {
  if (!arg || typeof arg !== 'string' || arg.startsWith('-')) return false;
  if (isPipelinePath(arg)) return true;
  const norm = path.posix.normalize(arg.replace(/\\/g, '/'));
  const base = path.posix.basename(norm);
  if (
    base !== 'run.py' &&
    base !== 'renderlane.py' &&
    base !== 'run.ts' &&
    base !== 'renderlane.ts'
  ) {
    return false;
  }

  const cwdInfo = readProcCwd(pidDir);
  if (cwdInfo.ok && cwdInfo.cwd) {
    const joined = path.posix.resolve(cwdInfo.cwd.replace(/\\/g, '/'), norm);
    return isPipelinePath(joined);
  }
  // When /proc/<pid>/cwd is absent in a synthetic fixture (ENOENT) or unreadable across
  // UIDs (EACCES/EPERM), treat bare run.py / renderlane.py conservatively as a match.
  return (
    norm === 'run.py' ||
    norm === 'renderlane.py' ||
    norm === 'run.ts' ||
    norm === 'renderlane.ts'
  );
}

function isLikelySeriesToken(tok: string): boolean {
  if (!tok || typeof tok !== 'string' || tok.startsWith('-')) return false;
  if (CH_RE.test(tok) || CAPTION_VAL_RE.test(tok) || /^\d+$/.test(tok)) return false;
  return validateSlug(tok) !== null;
}

function parsePipelineRunArgs(rest: string[]): { series: string; args: string[] } | null {
  if (!Array.isArray(rest) || !rest.length) return null;
  const flags: string[] = [];
  const positionals: string[] = [];
  let endOfOpts = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok) continue;
    if (endOfOpts) {
      positionals.push(tok);
      continue;
    }
    if (tok === '--') {
      endOfOpts = true;
      continue;
    }
    if (tok.startsWith('-')) {
      const eqIdx = tok.indexOf('=');
      const flagName = eqIdx >= 0 ? tok.slice(0, eqIdx) : tok;
      flags.push(flagName);
      if (eqIdx >= 0 || PIPELINE_BOOLEAN_FLAGS.has(flagName)) {
        continue;
      }
      if (PIPELINE_VALUE_FLAGS.has(flagName)) {
        if (i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
          i += 1;
        }
        continue;
      }
      if (i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        const nextTok = rest[i + 1];
        const laterHasSlug = rest.slice(i + 2).some((t) => isLikelySeriesToken(t));
        if (!isLikelySeriesToken(nextTok) || laterHasSlug) {
          i += 1;
        }
      }
      continue;
    }
    positionals.push(tok);
  }

  // Only read-only invocations (--status / --help) are skipped.
  // --clear-cache removes files under <series>/out/ and must block concurrent deletes.
  if (flags.some((f) => READONLY_PIPELINE_FLAGS.has(f))) return null;
  if (!positionals.length) return null;

  const series = positionals.find((t) => isLikelySeriesToken(t)) || positionals[0] || 'unknown';
  return { series, args: rest.slice(0, 8) };
}

export interface ActivePipelineRun {
  pid: number;
  series: string;
  args: string[];
}

/**
 * Scan `/proc` for live `pipeline/run.py`, `pipeline/renderlane.py`, `src/cli/run.ts`,
 * or `src/workers/renderlane.ts` writers.
 * Throws an error with `code === 'proc_unreadable'` when the process table
 * cannot be inspected so callers fail closed instead of assuming no writer exists.
 */
export function detectActivePipelineRuns(
  procRoot: string = process.env.MANHWA_PROC_ROOT || '/proc',
): ActivePipelineRun[] {
  if (typeof procRoot !== 'string' || !procRoot.trim()) {
    throw procUnreadableError('Process table path is missing.');
  }
  let entries: string[];
  try {
    const rootStat = fsSync.statSync(procRoot);
    if (
      !rootStat.isDirectory() ||
      (rootStat.mode & 0o444) === 0 ||
      (rootStat.mode & 0o111) === 0
    ) {
      throw procUnreadableError(`Process table ${procRoot} is not a readable directory.`);
    }
    entries = fsSync.readdirSync(procRoot);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'proc_unreadable') {
      throw err;
    }
    throw procUnreadableError(`Could not scan process table at ${procRoot}.`, err);
  }

  const active: ActivePipelineRun[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const pidDir = path.join(procRoot, name);
    let rawStat: string;
    let rawCmdline: string;
    try {
      const pidStat = fsSync.statSync(pidDir);
      if (
        !pidStat.isDirectory() ||
        (pidStat.mode & 0o444) === 0 ||
        (pidStat.mode & 0o111) === 0
      ) {
        throw procUnreadableError(`Process entry ${pidDir} is not a readable directory.`);
      }
      const statPath = path.join(pidDir, 'stat');
      const cmdPath = path.join(pidDir, 'cmdline');
      const stStat = fsSync.statSync(statPath);
      const cmdStat = fsSync.statSync(cmdPath);
      if ((stStat.mode & 0o444) === 0 || (cmdStat.mode & 0o444) === 0) {
        throw procUnreadableError(`Process entry ${pidDir} files are not readable.`);
      }
      rawStat = fsSync.readFileSync(statPath, 'utf8');
      rawCmdline = fsSync.readFileSync(cmdPath, 'utf8');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
      if (code === 'proc_unreadable') throw err;
      if ((code === 'ENOENT' || code === 'ESRCH') && !fsSync.existsSync(pidDir)) {
        continue; // transient PID exited mid-scan
      }
      throw procUnreadableError(`Could not inspect process entry ${pidDir}.`, err);
    }

    const closeParen = rawStat.lastIndexOf(')');
    if (closeParen < 0) {
      throw procUnreadableError(`Malformed stat entry in ${pidDir}.`);
    }
    const state = rawStat.slice(closeParen + 2).trimStart().split(/\s+/)[0];
    if (!state) {
      throw procUnreadableError(`Missing process state in ${pidDir}.`);
    }
    if (state === 'Z') continue; // zombie: not writing anything

    const cmd = rawCmdline.replace(/\0+$/, '').split('\0');
    if (!cmd.length || !cmd[0]) continue;
    for (let i = 0; i < cmd.length; i++) {
      if (!isPipelineScriptArg(cmd[i], pidDir)) continue;
      const parsed = parsePipelineRunArgs(cmd.slice(i + 1));
      if (parsed) {
        active.push({ pid, series: parsed.series, args: parsed.args });
      }
      break;
    }
  }
  return active;
}

/**
 * Find active pipeline processes from `/proc`.
 * Can be called as:
 * - `findActiveSeriesProcesses(procRoot?)` -> all active pipeline runs
 * - `findActiveSeriesProcesses(procRoot, seriesSlug)` -> active runs filtered to `seriesSlug`
 * - `findActiveSeriesProcesses(seriesSlug, procRoot)` -> active runs filtered to `seriesSlug`
 */
export function findActiveSeriesProcesses(
  procRootOrSlug?: string,
  slugOrProcRoot?: string,
): ActivePipelineRun[] {
  if (procRootOrSlug === undefined) {
    return detectActivePipelineRuns();
  }
  if (slugOrProcRoot !== undefined) {
    const firstLooksLikePath =
      procRootOrSlug.includes('/') ||
      procRootOrSlug.includes('\\') ||
      procRootOrSlug.startsWith('.');
    const procRoot = firstLooksLikePath ? procRootOrSlug : slugOrProcRoot;
    const slug = firstLooksLikePath ? slugOrProcRoot : procRootOrSlug;
    return detectActivePipelineRuns(procRoot).filter((r) => r.series === slug);
  }
  return detectActivePipelineRuns(procRootOrSlug);
}

export function checkNoActivePipelineRun(
  procRoot: string,
  seriesSlug: string,
): { ok: true } | { ok: false; status: number; code: string; error: string } {
  let runs: ActivePipelineRun[];
  try {
    runs = detectActivePipelineRuns(procRoot);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'proc_unreadable';
    return {
      ok: false,
      status: 503,
      code,
      error:
        'Could not verify active pipeline processes. Refusing to delete while process state is unknown.',
    };
  }
  const activeForSeries = runs.find((r) => r.series === seriesSlug);
  if (activeForSeries) {
    return {
      ok: false,
      status: 409,
      code: 'pipeline_active',
      error: `The pipeline is writing ${seriesSlug} right now (PID ${activeForSeries.pid}). Wait for it to finish before deleting.`,
    };
  }
  return { ok: true };
}

const inFlight = new Set<string>();
export function isPending(slug: string, ch: string): boolean {
  return inFlight.has(pendingKey(slug, ch));
}

export interface DeleteChapterVideoOptions {
  seriesRoot?: string;
  slug?: string;
  ch?: string;
  chapter?: string;
  procRoot?: string;
  lockHoldMs?: number;
  holdMs?: number;
  lockReadyFile?: string | null;
  readyFile?: string | null;
  expectedDev?: number | bigint | null;
  expectedIno?: number | bigint | null;
  expectedSize?: number | bigint | null;
  expectedMtimeNs?: number | bigint | null;
}

export interface DeleteChapterVideoSuccess {
  ok: true;
  status: 200;
  slug: string;
  ch: string;
  freedBytes: number;
  deleted: string[];
  message: string;
}

export interface DeleteChapterVideoFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type DeleteChapterVideoResult =
  | DeleteChapterVideoSuccess
  | DeleteChapterVideoFailure;

/**
 * Acquire nonblocking exclusive series lock, re-validate path/symlinks/scratch/inode,
 * and unlink `<seriesRoot>/<slug>/out/<ch>/video/video.mp4` while holding `LOCK_EX`.
 */
export async function deleteChapterVideoLocked(
  seriesRoot: string,
  slug: string,
  ch: string,
  options: DeleteChapterVideoOptions = {},
): Promise<DeleteChapterVideoResult> {
  const s = validateSlug(slug);
  const c = validateChapter(ch);
  if (!s || !c) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_path',
      error: 'Series slug or chapter name is invalid.',
    };
  }

  const pre = resolveChapterVideoSync(seriesRoot, s, c);
  if (!pre.ok) {
    return { ok: false, status: pre.status, code: pre.code, error: pre.error };
  }

  const root = path.resolve(String(seriesRoot || ''));
  const sdir = path.join(root, s);
  const holdMs = Number(options.lockHoldMs ?? options.holdMs ?? 0);
  const readyFile = options.lockReadyFile ?? options.readyFile ?? null;
  const expectedDev = options.expectedDev ?? null;
  const expectedIno = options.expectedIno ?? null;
  const expectedSize = options.expectedSize ?? null;
  const expectedMtimeNs = options.expectedMtimeNs ?? null;

  try {
    return await withExclusiveSeriesLock(
      sdir,
      { seriesRoot: root, nonblocking: true },
      async (): Promise<DeleteChapterVideoResult> => {
        if (readyFile && typeof readyFile === 'string') {
          try {
            fsSync.writeFileSync(readyFile, 'locked\n', 'utf8');
          } catch {
            // ignore
          }
        }
        if (holdMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
        }

        const resolved = resolveChapterVideoSync(seriesRoot, s, c);
        if (!resolved.ok) {
          return {
            ok: false,
            status: resolved.status,
            code: resolved.code,
            error: resolved.error,
          };
        }

        const videoPath = resolved.path;
        if (
          lstatSyncOrNull(`${videoPath}.part`) !== null ||
          hasActiveLocalRenderScratch(videoPath)
        ) {
          return {
            ok: false,
            status: 409,
            code: 'render_in_progress',
            error: `A render for ${s} ${c} is still writing video.mp4. Try again once it finishes.`,
          };
        }

        const stBig = lstatBigSyncOrNull(videoPath);
        if (!stBig) {
          return {
            ok: false,
            status: 404,
            code: 'not_found',
            error: `No rendered video found for ${s} ${c}.`,
          };
        }

        if (
          (expectedDev !== null && stBig.dev !== BigInt(expectedDev)) ||
          (expectedIno !== null && stBig.ino !== BigInt(expectedIno)) ||
          (expectedSize !== null && stBig.size !== BigInt(expectedSize)) ||
          (expectedMtimeNs !== null && stBig.mtimeNs !== BigInt(expectedMtimeNs))
        ) {
          return {
            ok: false,
            status: 409,
            code: 'render_in_progress',
            error: `A render for ${s} ${c} modified video.mp4 while deletion was being prepared. Try again once it finishes.`,
          };
        }

        fsSync.unlinkSync(videoPath);
        return {
          ok: true,
          status: 200,
          slug: s,
          ch: c,
          freedBytes: Number(stBig.size),
          deleted: [resolved.rel],
          message: `Deleted the rendered video for ${s} ${c}. Source chapters, images and caches were not touched.`,
        };
      },
    );
  } catch (err) {
    if (err instanceof LockPathError) {
      return { ok: false, status: err.status, code: err.code, error: err.message };
    }
    if (
      err instanceof BlockingIOError ||
      (err && typeof err === 'object' && 'code' in err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK'))
    ) {
      return {
        ok: false,
        status: 409,
        code: 'pipeline_active',
        error: `The pipeline is writing ${s} right now. Wait for it to finish before deleting.`,
      };
    }
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
    return {
      ok: false,
      status: 500,
      code: 'delete_failed',
      error: 'Could not delete the rendered video.',
    };
  }
}
export const delete_chapter_video_locked = deleteChapterVideoLocked;

/**
 * Delete the rendered video for one chapter completely in-process in TypeScript.
 * Accepts either:
 *   - `deleteChapterVideo(seriesRoot, slug, ch, options?)`
 *   - `deleteChapterVideo({ seriesRoot, slug, ch, procRoot, lockHoldMs, lockReadyFile })`
 */
export async function deleteChapterVideo(
  options: DeleteChapterVideoOptions,
): Promise<DeleteChapterVideoResult>;
export async function deleteChapterVideo(
  seriesRoot: string,
  slug: string,
  ch: string,
  options?: DeleteChapterVideoOptions,
): Promise<DeleteChapterVideoResult>;
export async function deleteChapterVideo(
  seriesRootOrOptions: string | DeleteChapterVideoOptions = {},
  slugArg?: string,
  chArg?: string,
  optionsArg: DeleteChapterVideoOptions = {},
): Promise<DeleteChapterVideoResult> {
  const opts: DeleteChapterVideoOptions =
    typeof seriesRootOrOptions === 'object' && seriesRootOrOptions !== null
      ? seriesRootOrOptions
      : {
          ...optionsArg,
          seriesRoot: String(seriesRootOrOptions),
          slug: slugArg,
          ch: chArg,
        };

  const seriesRoot = String(opts.seriesRoot ?? '');
  const rawSlug = opts.slug;
  const rawCh = opts.ch ?? opts.chapter;
  const procRoot = opts.procRoot ?? process.env.MANHWA_PROC_ROOT ?? '/proc';
  const lockHoldMs = Number(opts.lockHoldMs ?? opts.holdMs ?? 0);
  const lockReadyFile = opts.lockReadyFile ?? opts.readyFile ?? null;

  const s = validateSlug(rawSlug);
  const c = validateChapter(rawCh);
  if (!s || !c) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_path',
      error: 'Series slug or chapter name is invalid.',
    };
  }

  const key = pendingKey(s, c);
  if (inFlight.has(key)) {
    return {
      ok: false,
      status: 409,
      code: 'pending',
      error: `A delete for ${s} ${c} is already in progress.`,
    };
  }
  inFlight.add(key);

  try {
    const preCheck = checkNoActivePipelineRun(procRoot, s);
    if (!preCheck.ok) {
      return {
        ok: false,
        status: preCheck.status,
        code: preCheck.code,
        error: preCheck.error,
      };
    }

    const resolved = await resolveChapterVideo(seriesRoot, s, c);
    if (!resolved.ok) {
      return {
        ok: false,
        status: resolved.status,
        code: resolved.code,
        error: resolved.error,
      };
    }

    const part = await lstatOrNull(`${resolved.path}.part`);
    if (part || hasActiveLocalRenderScratch(resolved.path)) {
      return {
        ok: false,
        status: 409,
        code: 'render_in_progress',
        error: `A render for ${s} ${c} is still writing video.mp4. Try again once it finishes.`,
      };
    }

    // Re-verify process table and target file synchronously after all async awaits
    // so an older uncoordinated writer that started during path resolution is refused.
    const postCheck = checkNoActivePipelineRun(procRoot, s);
    if (!postCheck.ok) {
      return {
        ok: false,
        status: postCheck.status,
        code: postCheck.code,
        error: postCheck.error,
      };
    }

    if (lstatSyncOrNull(`${resolved.path}.part`) || hasActiveLocalRenderScratch(resolved.path)) {
      return {
        ok: false,
        status: 409,
        code: 'render_in_progress',
        error: `A render for ${s} ${c} is still writing video.mp4. Try again once it finishes.`,
      };
    }

    const curStat = lstatSyncOrNull(resolved.path);
    const curStatBig = lstatBigSyncOrNull(resolved.path);
    if (!curStat || !curStatBig) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
    if (curStat.isSymbolicLink()) {
      return {
        ok: false,
        status: 400,
        code: 'escaped_symlink',
        error: 'Refusing to follow a symbolic link in the video path.',
      };
    }
    if (
      !curStat.isFile() ||
      curStat.dev !== resolved.dev ||
      curStat.ino !== resolved.ino ||
      curStat.mtimeMs !== resolved.mtimeMs ||
      curStat.size !== resolved.size
    ) {
      return {
        ok: false,
        status: 409,
        code: 'render_in_progress',
        error: `A render for ${s} ${c} modified video.mp4 while deletion was being prepared. Try again once it finishes.`,
      };
    }

    return await deleteChapterVideoLocked(seriesRoot, s, c, {
      expectedDev: opts.expectedDev ?? curStatBig.dev,
      expectedIno: opts.expectedIno ?? curStatBig.ino,
      expectedSize: opts.expectedSize ?? curStatBig.size,
      expectedMtimeNs: opts.expectedMtimeNs ?? curStatBig.mtimeNs,
      lockHoldMs,
      lockReadyFile,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        error: `No rendered video found for ${s} ${c}.`,
      };
    }
    return {
      ok: false,
      status: 500,
      code: 'delete_failed',
      error: 'Could not delete the rendered video.',
    };
  } finally {
    inFlight.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Optional CLI compatibility (`delete-video` and `hold-shared`)
 * ------------------------------------------------------------------ */

function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const cmd = argv[0];
  if (cmd) out._cmd = cmd;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'nonblocking') {
      out[key] = true;
    } else if (i + 1 < argv.length) {
      out[key] = argv[++i];
    }
  }
  return out;
}

export async function cliMain(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  const cmd = parsed._cmd;

  if (cmd === 'delete-video') {
    const res = await deleteChapterVideoLocked(
      String(parsed['series-root'] ?? ''),
      String(parsed.slug ?? ''),
      String(parsed.chapter ?? ''),
      {
        expectedDev:
          parsed['expected-dev'] !== undefined ? BigInt(String(parsed['expected-dev'])) : null,
        expectedIno:
          parsed['expected-ino'] !== undefined ? BigInt(String(parsed['expected-ino'])) : null,
        expectedSize:
          parsed['expected-size'] !== undefined ? BigInt(String(parsed['expected-size'])) : null,
        expectedMtimeNs:
          parsed['expected-mtime-ns'] !== undefined
            ? BigInt(String(parsed['expected-mtime-ns']))
            : null,
        lockHoldMs:
          parsed['hold-ms'] !== undefined ? Number(parsed['hold-ms']) : 0,
        lockReadyFile:
          parsed['ready-file'] !== undefined ? String(parsed['ready-file']) : null,
      },
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return 0;
  }

  if (cmd === 'hold-shared') {
    let sdir = parsed['series-dir'] ? String(parsed['series-dir']) : '';
    if (!sdir && parsed['series-root'] && parsed.slug) {
      sdir = path.join(String(parsed['series-root']), String(parsed.slug));
    }
    if (!sdir) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: 'invalid_path', error: 'Missing series dir' })}\n`,
      );
      return 1;
    }
    try {
      await withSharedSeriesLock(
        {
          directSdir: sdir,
          requireExists: true,
          nonblocking: Boolean(parsed.nonblocking),
        },
        async (lp) => {
          let videoExistedOnEnter: boolean | null = null;
          if (parsed['write-video-chapter']) {
            const vpath = path.join(
              sdir,
              'out',
              String(parsed['write-video-chapter']),
              'video',
              'video.mp4',
            );
            videoExistedOnEnter = fsSync.existsSync(vpath);
            if (parsed['write-video-content'] !== undefined) {
              fsSync.mkdirSync(path.dirname(vpath), { recursive: true });
              fsSync.writeFileSync(vpath, String(parsed['write-video-content']), 'utf8');
            }
          }
          process.stdout.write(
            `${JSON.stringify({
              ok: true,
              locked: true,
              pid: process.pid,
              lockPath: lp,
              videoExistedOnEnter,
            })}\n`,
          );
          const durationMs =
            parsed['duration-ms'] !== undefined ? Number(parsed['duration-ms']) : 0;
          if (durationMs > 0) {
            await new Promise<void>((r) => setTimeout(r, durationMs));
          } else {
            await new Promise<void>((resolve) => {
              process.stdin.resume();
              process.stdin.once('end', () => resolve());
              process.stdin.once('close', () => resolve());
              process.stdin.once('error', () => resolve());
            });
          }
        },
      );
      return 0;
    } catch (err) {
      if (err instanceof LockPathError) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, status: err.status, code: err.code, error: err.message })}\n`,
        );
        return 2;
      }
      if (err instanceof BlockingIOError) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, status: 409, code: 'lock_busy', error: 'Exclusive lock is active' })}\n`,
        );
        return 3;
      }
      throw err;
    }
  }

  return 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  cliMain().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
