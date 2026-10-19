/** Recoverable, reboot-scoped artifact deletion and symlink-safe storage accounting. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveOutDir } from '../config/secretStore.js';
import { BlockingIOError, checkNoActivePipelineRun, hasActiveLocalRenderScratch, inferSeriesDir, withExclusiveSeriesLock } from '../locks/seriesLock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPIRES_NOTE = 'Recoverable until system reboot (/tmp)' as const;
export type TrashKind = 'chapter-video' | 'full-video' | 'series-cache' | 'series' | 'artifact';
export interface TrashItem {
  id: string;
  kind: TrashKind;
  slug?: string;
  chapter?: string;
  label?: string;
  originalPath: string;
  trashPath: string;
  sizeBytes: number;
  deletedAt: string;
  expiresNote: typeof EXPIRES_NOTE;
}

export function trashRoot(): string {
  const root = path.resolve(process.env.MANHWA_TRASH_DIR || '/tmp/opencode/manhwa-trash');
  if (root === path.parse(root).root) throw storageError('Invalid trash root');
  return root;
}

function storageError(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Refuse symlinks in existing components, including parents of a missing restore target. */
export function assertNoSymlinks(file: string): void {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw storageError('Refusing to follow a symbolic link');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

function filesUnder(root: string): Array<{ file: string; size: number }> {
  const files: Array<{ file: string; size: number }> = [];
  const walk = (file: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) files.push({ file, size: st.size });
    else if (st.isDirectory()) {
      let names: string[];
      try { names = fs.readdirSync(file); } catch { return; }
      for (const name of names) walk(path.join(file, name));
    }
  };
  assertNoSymlinks(root);
  walk(root);
  return files;
}

export function storageBytes(root: string): number {
  return filesUnder(root).reduce((sum, f) => sum + f.size, 0);
}

function move(src: string, dest: string): void {
  try { fs.renameSync(src, dest); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // cp preserves links without following them, including links inside directory payloads.
    try {
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false });
    } catch (copyError) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw copyError;
    }
    fs.rmSync(src, { recursive: true });
  }
}

export function moveToTmpTrash(
  targetPath: string,
  meta: { kind: TrashKind; slug?: string; chapter?: string; label?: string },
): TrashItem {
  const originalPath = path.resolve(targetPath);
  assertNoSymlinks(originalPath);
  const st = fs.lstatSync(originalPath);
  if (!st.isFile() && !st.isDirectory()) throw storageError('Only regular files and directories can be trashed');
  const root = trashRoot();
  assertNoSymlinks(root);
  if (originalPath === path.parse(originalPath).root || root === originalPath || root.startsWith(originalPath + path.sep) || originalPath.startsWith(root + path.sep)) {
    throw storageError('Cannot trash the trash directory or one of its parents');
  }
  const sizeBytes = storageBytes(originalPath);
  const id = `${Date.now()}-${randomUUID()}`;
  const entry = path.join(root, id);
  fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
  const item: TrashItem = {
    id, ...meta, originalPath, trashPath: path.join(entry, 'payload'), sizeBytes,
    deletedAt: new Date().toISOString(), expiresNote: EXPIRES_NOTE,
  };
  try {
    fs.writeFileSync(path.join(entry, 'manifest.json'), JSON.stringify(item, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    move(originalPath, item.trashPath);
  } catch (err) {
    // Never remove a payload when the source removal failed after an EXDEV copy.
    if (!fs.existsSync(item.trashPath)) fs.rmSync(entry, { recursive: true, force: true });
    throw err;
  }
  return item;
}

function readItem(id: string): TrashItem {
  if (!/^\d+-[a-f0-9-]{36}$/.test(id)) throw storageError('Invalid trash ID');
  const entry = path.join(trashRoot(), id);
  assertNoSymlinks(path.join(entry, 'manifest.json'));
  assertNoSymlinks(path.join(entry, 'payload'));
  let item: TrashItem;
  try { item = JSON.parse(fs.readFileSync(path.join(entry, 'manifest.json'), 'utf8')); }
  catch { throw storageError('Trash item not found or invalid', 404); }
  if (item.id !== id || item.trashPath !== path.join(entry, 'payload') || typeof item.originalPath !== 'string' || !path.isAbsolute(item.originalPath) ||
    typeof item.deletedAt !== 'string' || !Number.isFinite(Date.parse(item.deletedAt)) ||
    typeof item.sizeBytes !== 'number' || !Number.isFinite(item.sizeBytes) || item.sizeBytes < 0 ||
    !['chapter-video', 'full-video', 'series-cache', 'series', 'artifact'].includes(item.kind) || !fs.existsSync(item.trashPath)) {
    throw storageError('Trash item not found or invalid', 404);
  }
  return item;
}

export function listTmpTrash(): TrashItem[] {
  const root = trashRoot();
  assertNoSymlinks(root);
  if (!fs.existsSync(root)) return [];
  const items: TrashItem[] = [];
  for (const id of fs.readdirSync(root)) {
    try { items.push(readItem(id)); } catch { /* Ignore incomplete or foreign entries. */ }
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || b.id.localeCompare(a.id));
}

export function restoreFromTmpTrash(trashId: string): { ok: true; restoredPath: string; item: TrashItem } {
  const item = readItem(trashId);
  const restore = () => {
    assertNoSymlinks(item.originalPath);
    if (fs.existsSync(item.originalPath)) throw storageError('Restore destination already exists; refusing to overwrite it', 409);
    const root = trashRoot();
    if (item.originalPath === root || item.originalPath.startsWith(root + path.sep) || root.startsWith(item.originalPath + path.sep)) {
      throw storageError('Invalid restore destination');
    }
    if (item.slug && (item.kind === 'chapter-video' || item.kind === 'full-video')) {
      const active = checkNoActivePipelineRun(process.env.MANHWA_PROC_ROOT || '/proc', item.slug);
      if (!active.ok) throw storageError(active.error, active.status);
      if (fs.existsSync(item.originalPath + '.part') || hasActiveLocalRenderScratch(item.originalPath)) throw storageError('A render is writing the restore destination', 409);
    }
    fs.mkdirSync(path.dirname(item.originalPath), { recursive: true });
    move(item.trashPath, item.originalPath);
    fs.rmSync(path.dirname(item.trashPath), { recursive: true });
    return { ok: true as const, restoredPath: item.originalPath, item };
  };
  const sdir = item.kind === 'chapter-video' || item.kind === 'full-video' ? inferSeriesDir(item.originalPath) : null;
  try {
    return sdir && fs.existsSync(sdir) ? withExclusiveSeriesLock(sdir, { nonblocking: true }, restore) : restore();
  } catch (err) {
    if (err instanceof BlockingIOError) throw storageError('Series is busy; wait before restoring its video', 409);
    throw err;
  }
}

export function purgeTmpTrash(trashId?: string): { ok: true; purgedCount: number; freedBytes: number } {
  const items = trashId !== undefined ? [readItem(trashId)] : listTmpTrash();
  let freedBytes = 0;
  for (const item of items) {
    freedBytes += storageBytes(item.trashPath);
    fs.rmSync(path.dirname(item.trashPath), { recursive: true });
  }
  return { ok: true, purgedCount: items.length, freedBytes };
}

export function getStorageSummary(opts: { seriesRoot?: string; outDir?: string; thumbsRoot?: string } = {}) {
  const seriesRoot = path.resolve(opts.seriesRoot || process.env.MANHWA_SERIES_ROOT || path.join(REPO_ROOT, 'series'));
  const outDir = path.resolve(opts.outDir || resolveOutDir());
  const thumbsRoot = path.resolve(opts.thumbsRoot || process.env.MANHWA_THUMBS_ROOT || path.join(REPO_ROOT, 'thumbnails'));
  const series: Array<{
    slug: string; title: string; totalBytes: number; videoBytes: number; fullVideoBytes: number;
    audioBytes: number; panelsBytes: number; cacheBytes: number;
    chapters: Array<{ ch: string; videoBytes: number; audioBytes: number; panelsBytes: number; hasVideo: boolean }>;
  }> = [];
  assertNoSymlinks(seriesRoot);
  const entries = fs.existsSync(seriesRoot) ? fs.readdirSync(seriesRoot, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = path.join(seriesRoot, slug);
    let title = slug;
    try {
      assertNoSymlinks(path.join(dir, 'meta.json'));
      const value = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).title;
      if (typeof value === 'string' && value) title = value;
    } catch { /* Slug fallback. */ }
    const row = { slug, title, totalBytes: 0, videoBytes: 0, fullVideoBytes: 0, audioBytes: 0, panelsBytes: 0, cacheBytes: 0, chapters: [] as Array<{ ch: string; videoBytes: number; audioBytes: number; panelsBytes: number; hasVideo: boolean }> };
    const chapters = new Map<string, (typeof row.chapters)[number]>();
    for (const { file, size } of filesUnder(dir)) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      row.totalBytes += size;
      const ch = /(?:^|\/)(ch\d+)(?:\/|$)/i.exec(rel)?.[1];
      const chapter = ch ? chapters.get(ch) || { ch, videoBytes: 0, audioBytes: 0, panelsBytes: 0, hasVideo: false } : null;
      if (chapter) chapters.set(ch!, chapter);
      if (/\.(mp4|mkv|webm|mov)$/i.test(rel)) {
        row.videoBytes += size;
        if (rel.startsWith('out/full/')) row.fullVideoBytes += size;
        if (chapter) { chapter.videoBytes += size; if (/\/video\/video\.mp4$/.test(rel) && size > 0) chapter.hasVideo = true; }
      } else if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(rel)) {
        row.audioBytes += size;
        if (chapter) chapter.audioBytes += size;
      } else if (/\.(png|jpe?g|webp|avif)$/i.test(rel)) {
        row.panelsBytes += size;
        if (chapter) chapter.panelsBytes += size;
      } else row.cacheBytes += size;
    }
    row.chapters = [...chapters.values()].sort((a, b) => Number(a.ch.slice(2)) - Number(b.ch.slice(2)));
    series.push(row);
  }
  series.sort((a, b) => a.slug.localeCompare(b.slug));
  const seriesBytes = series.reduce((sum, s) => sum + s.totalBytes, 0);
  const jobsRoot = opts.outDir ? path.join(outDir, 'jobs') : process.env.MANHWA_JOBS_DIR || path.join(outDir, 'jobs');
  const nestedPreviews = storageBytes(path.join(jobsRoot, 'voice-previews'));
  const jobsBytes = storageBytes(jobsRoot) - nestedPreviews;
  const previewsBytes = storageBytes(path.join(outDir, 'voice-previews')) + nestedPreviews;
  const configBytes = storageBytes(path.join(outDir, 'config'));
  const thumbsBytes = storageBytes(thumbsRoot);
  const trashBytes = storageBytes(trashRoot());
  return { totalBytes: seriesBytes + jobsBytes + previewsBytes + configBytes + thumbsBytes + trashBytes,
    seriesBytes, jobsBytes, previewsBytes, configBytes, thumbsBytes, trashBytes, series, trash: listTmpTrash() };
}
