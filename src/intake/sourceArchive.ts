/**
 * Durable per-series source archive retention.
 *
 * A new-series job historically downloaded (Drive) or staged (browser upload) the
 * whole ZIP, extracted only the chapters the user selected, then deleted the ZIP.
 * Every chapter the user did not select was therefore lost, so "Add chapters"
 * later failed with "chapter folders are missing".
 *
 * This module keeps the complete archive inside the series it belongs to:
 *
 *   <series>/out/source/index.json          metadata index (untrusted input)
 *   <series>/out/source/archives/<sha>.zip  one validated archive per content hash
 *
 * Rules:
 *   - `out/` is never a chapter folder, so retention cannot be mistaken for chN.
 *   - archives are content-addressed and never replaced: adding a second archive
 *     (for example an extension-only ZIP) can only append, never destroy an
 *     archive an earlier extension may still need.
 *   - every path comes from this module, never from the index body: the index is
 *     treated as untrusted and an entry is ignored unless its basename matches a
 *     strict hash pattern and resolves inside this series' archives directory.
 *   - symlinks are refused everywhere so a tampered series cannot redirect reads
 *     outside its own `out/source`.
 *   - an archive is validated (ZIP safety limits + chapter index) before it is
 *     retained, and validated again before it is used.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { archiveIndex } from "./ingest.js";

export const SOURCE_DIR = "source";
export const SOURCE_ARCHIVES_DIR = "archives";
export const SOURCE_INDEX_FILE = "index.json";
export const SOURCE_INDEX_SCHEMA = 1;
/** Content-addressed archive names; anything else in the index is ignored. */
export const SOURCE_ARCHIVE_NAME_RE = /^[a-f0-9]{16,64}\.zip$/;
/** Upper bound on entries parsed from a (possibly tampered) index file. */
export const MAX_INDEXED_ARCHIVES = 1024;

export interface RetainedSourceMeta {
  sourceType?: string | null;
  sourceSummary?: string | null;
  gdriveFileId?: string | null;
  jobId?: string | null;
}

export interface RetainedSourceArchive {
  /** Basename inside `out/source/archives`. */
  file: string;
  sha256: string;
  bytes: number;
  chapters: number[];
  layout: "cbz" | "folders";
  addedAt: string;
  sourceType: string;
  sourceSummary: string;
  gdriveFileId: string | null;
  jobId: string | null;
}

export interface RetainedSourceHit {
  path: string;
  entry: RetainedSourceArchive;
}

/** `<series>/out/source` (not created). */
export function seriesSourceDir(sdir: string): string {
  return path.join(sdir, "out", SOURCE_DIR);
}

function archivesDir(sdir: string): string {
  return path.join(seriesSourceDir(sdir), SOURCE_ARCHIVES_DIR);
}

function indexPath(sdir: string): string {
  return path.join(seriesSourceDir(sdir), SOURCE_INDEX_FILE);
}

function isLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when any existing component of `target` (from the filesystem root down) is
 * a symbolic link. Used for untrusted paths such as job `stagedZipPath`, where
 * only checking the leaf would still follow a linked parent directory.
 */
export function pathHasSymlink(target: string): boolean {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (isLink(current)) return true;
  }
  return false;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuse a symlinked path component under the series root. Returns false when a
 * component exists and is a link; missing components are fine (nothing to follow).
 */
function hasSymlinkComponent(from: string, to: string): boolean {
  const rel = path.relative(from, to);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  // The root of the relative walk can itself sit behind a linked parent.
  if (pathHasSymlink(from)) return true;
  let current = from;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (isLink(current)) return true;
  }
  return false;
}

function ensureOwnedDir(dir: string, ref: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try {
    const st = fs.statSync(ref);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      const dst = fs.statSync(dir);
      if (dst.uid !== st.uid) fs.chownSync(dir, st.uid, st.gid);
    }
  } catch {
    // Ownership is best-effort; mode already restricts writes.
  }
}

/** Streaming SHA-256 of a file (never buffers a whole archive in memory). */
export function hashFile(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const GDRIVE_ID_RE = /^[A-Za-z0-9_-]{10,120}$/;
const JOB_ID_RE = /^job-[0-9]+-[a-f0-9]+$/;
const MAX_CHAPTER_NUMBER = 5000;

/** Chapter numbers are bounded everywhere so an index re-read cannot drop them. */
function chapterNumbers(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_CHAPTER_NUMBER))]
    .sort((a, b) => a - b);
}

/** One sanitizer for entries read from the index and entries written to it. */
function makeEntry(raw: Record<string, unknown>, file: string, sha256: string): RetainedSourceArchive {
  const bytes = Number(raw.bytes);
  const gdriveFileId = typeof raw.gdriveFileId === "string" && GDRIVE_ID_RE.test(raw.gdriveFileId)
    ? raw.gdriveFileId
    : null;
  return {
    file,
    sha256,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.trunc(bytes) : 0,
    chapters: chapterNumbers(raw.chapters),
    layout: raw.layout === "cbz" ? "cbz" : "folders",
    addedAt: typeof raw.addedAt === "string" ? raw.addedAt.slice(0, 40) : "",
    sourceType: typeof raw.sourceType === "string" ? raw.sourceType.slice(0, 40) : "unknown",
    sourceSummary: typeof raw.sourceSummary === "string" ? raw.sourceSummary.slice(0, 200) : "",
    gdriveFileId,
    jobId: typeof raw.jobId === "string" && JOB_ID_RE.test(raw.jobId) ? raw.jobId : null,
  };
}

function normalizeEntry(raw: unknown): RetainedSourceArchive | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const file = typeof value.file === "string" ? value.file : "";
  if (!SOURCE_ARCHIVE_NAME_RE.test(file)) return null;
  if (file.includes("/") || file.includes("\\") || file.includes("..")) return null;
  const sha256 = typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : "";
  if (!sha256) return null;
  if (path.basename(file, ".zip") !== sha256.slice(0, 32)) return null;
  const entry = makeEntry(value, file, sha256);
  return entry.chapters.length ? entry : null;
}

function readIndex(sdir: string): RetainedSourceArchive[] {
  const file = indexPath(sdir);
  if (hasSymlinkComponent(sdir, file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const body = raw as Record<string, unknown>;
  // A future/incompatible schema is ignored rather than misread as schema 1.
  if (body.schemaVersion !== undefined && Number(body.schemaVersion) !== SOURCE_INDEX_SCHEMA) return [];
  const list = body.archives;
  if (!Array.isArray(list)) return [];
  const out: RetainedSourceArchive[] = [];
  for (const item of list.slice(0, MAX_INDEXED_ARCHIVES * 2)) {
    const entry = normalizeEntry(item);
    if (entry && !out.some((e) => e.sha256 === entry.sha256)) out.push(entry);
    if (out.length >= MAX_INDEXED_ARCHIVES) break;
  }
  return out;
}

/**
 * Commit the index. The caller should hold the series lock where one exists;
 * entries are merged with whatever is on disk at write time so a concurrent
 * appender of a *different* archive is not silently dropped.
 */
function writeIndex(sdir: string, entries: RetainedSourceArchive[]): void {
  const dir = seriesSourceDir(sdir);
  ensureOwnedDir(dir, sdir);
  const file = indexPath(sdir);
  const merged = new Map<string, RetainedSourceArchive>();
  for (const entry of readIndex(sdir)) merged.set(entry.sha256, entry);
  for (const entry of entries) merged.set(entry.sha256, entry);
  const archives = [...merged.values()]
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));
  if (hasSymlinkComponent(sdir, file)) throw new Error("series source index cannot be a symbolic link");
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: SOURCE_INDEX_SCHEMA, archives }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  fs.renameSync(tmp, file);
}

/**
 * Absolute path for an indexed archive, or null when the entry does not resolve
 * to a regular file inside this series' own archives directory.
 */
export function retainedArchivePath(sdir: string, entry: RetainedSourceArchive): string | null {
  const dir = archivesDir(sdir);
  const file = path.join(dir, entry.file);
  if (path.dirname(file) !== dir) return null;
  if (hasSymlinkComponent(sdir, file)) return null;
  if (!isFile(file)) return null;
  return file;
}

/** Every archive the index claims, restricted to entries that are really there. */
export function listRetainedSources(sdir: string): RetainedSourceArchive[] {
  return readIndex(sdir).filter((entry) => retainedArchivePath(sdir, entry) !== null);
}

interface ParsedArchive {
  size: number;
  mtimeMs: number;
  chapters: number[];
}

/**
 * Chapter numbers read from the archive itself, cached by path+size+mtime.
 * `entry.chapters` is metadata and may be stale or tampered with, so coverage is
 * always decided from this.
 */
const parsedCache = new Map<string, ParsedArchive>();

function actualArchiveChapters(file: string): number[] | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = parsedCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.chapters;
  let chapters: number[];
  try {
    const [, idx] = archiveIndex(file, true);
    chapters = Object.keys(idx).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  } catch {
    return null;
  }
  parsedCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, chapters });
  return chapters;
}

/** One usable retained archive and the chapters it really contains. */
export interface RetainedSourceContents {
  path: string;
  entry: RetainedSourceArchive;
  chapters: number[];
}

/** Usable retained archives with coverage verified against each archive's index. */
export function listRetainedSourceContents(sdir: string): RetainedSourceContents[] {
  const out: RetainedSourceContents[] = [];
  for (const entry of listRetainedSources(sdir)) {
    const file = retainedArchivePath(sdir, entry);
    if (!file) continue;
    const chapters = actualArchiveChapters(file);
    if (!chapters || !chapters.length) continue;
    out.push({ path: file, entry, chapters });
  }
  return out;
}

/**
 * Which retained archive supplies each chapter, verified against the archive.
 * A range may legitimately span several archives, so this returns a plan rather
 * than one "best" archive.
 */
export function planRetainedExtraction(
  sdir: string,
  chapters: number[],
): { steps: Array<{ path: string; chapters: number[] }>; uncovered: number[] } {
  const wanted = [...new Set(chapters.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const contents = listRetainedSourceContents(sdir);
  const steps: Array<{ path: string; chapters: number[] }> = [];
  const uncovered: number[] = [];
  const remaining = new Set(wanted);
  // Largest archive first: fewer steps, fewer re-reads of the same file.
  for (const source of [...contents].sort((a, b) => b.chapters.length - a.chapters.length)) {
    const take = [...remaining].filter((n) => source.chapters.includes(n)).sort((a, b) => a - b);
    if (!take.length) continue;
    steps.push({ path: source.path, chapters: take });
    for (const n of take) remaining.delete(n);
  }
  for (const n of [...remaining].sort((a, b) => a - b)) uncovered.push(n);
  return { steps, uncovered };
}

/**
 * Best archive covering every requested chapter. A larger archive wins so one
 * lookup can satisfy several missing chapters from the same ZIP.
 */
export function findRetainedSourceForChapters(sdir: string, chapters: number[]): RetainedSourceHit | null {
  const wanted = [...new Set(chapters.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  let best: RetainedSourceHit | null = null;
  for (const source of listRetainedSourceContents(sdir)) {
    // Coverage is decided from the archive's own index, never from the metadata.
    if (wanted.length && !wanted.every((n) => source.chapters.includes(n))) continue;
    if (!best || source.chapters.length > best.entry.chapters.length) {
      best = { path: source.path, entry: { ...source.entry, chapters: source.chapters } };
    }
  }
  return best;
}

/** True when `target` is the series' own retained source (never a cleanup victim). */
export function isRetainedSourcePath(sdir: string, target: string): boolean {
  const dir = path.resolve(archivesDir(sdir));
  const resolved = path.resolve(target);
  return resolved.startsWith(dir + path.sep);
}

/**
 * Copy a validated archive into the series. Never throws away a *different*
 * archive: the new one is added under its content hash, and an identical hash is
 * reused. Validation happens on the temporary copy, so a corrupt or hostile ZIP
 * cannot replace a good retained source.
 */
export function retainSourceArchive(
  sdir: string,
  zipPath: string,
  meta: RetainedSourceMeta = {},
): RetainedSourceArchive {
  if (!isFile(zipPath)) throw new Error(`source archive is missing: ${path.basename(zipPath)}`);
  const sha256 = hashFile(zipPath);
  const file = `${sha256.slice(0, 32)}.zip`;
  const dir = archivesDir(sdir);
  // A symlinked source directory would write outside the series; refuse before
  // creating or copying anything.
  if (hasSymlinkComponent(sdir, path.join(dir, file))) {
    throw new Error("series source directory cannot be a symbolic link");
  }
  const existing = readIndex(sdir).find((entry) => entry.sha256 === sha256);
  const dest = path.join(dir, file);
  if (existing) {
    const reusable = retainedArchivePath(sdir, existing);
    // Prove the durable copy is this exact content: a swapped or truncated file
    // under the expected name must never be treated as already retained.
    if (reusable && fs.statSync(reusable).size === existing.bytes && hashFile(reusable) === existing.sha256) {
      return { ...existing, chapters: chapterNumbers(Object.keys(archiveIndex(reusable, true)[1])) };
    }
  }
  ensureOwnedDir(seriesSourceDir(sdir), sdir);
  ensureOwnedDir(dir, sdir);
  const tmp = path.join(dir, `.${sha256.slice(0, 12)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.copyFileSync(zipPath, tmp, fs.constants.COPYFILE_EXCL);
    const sourceBytes = fs.statSync(zipPath).size;
    if (fs.statSync(tmp).size !== sourceBytes) throw new Error("source archive copy was truncated");
    // Validate the copy, not the original: the file that will be served later is
    // the one that must be sound.
    const [layout, idx] = archiveIndex(tmp, true);
    const chapters = chapterNumbers(Object.keys(idx));
    if (!chapters.length) throw new Error("source archive contains no chapters");
    // Re-check right before the commit: the directory must still not be a link.
    if (hasSymlinkComponent(sdir, dest)) throw new Error("series source directory cannot be a symbolic link");
    // Commit exclusively. `rename` would silently replace whatever sits at this
    // content-addressed name; a hard link fails with EEXIST instead and is atomic,
    // so no reader ever sees a partially written archive.
    commitExclusive(tmp, dest, sha256);
    const entry = makeEntry({
      bytes: sourceBytes,
      chapters,
      layout,
      addedAt: new Date().toISOString(),
      sourceType: meta.sourceType || "unknown",
      sourceSummary: meta.sourceSummary || "",
      gdriveFileId: meta.gdriveFileId,
      jobId: meta.jobId,
    }, file, sha256);
    // Never drop an older entry: its archive is still on disk and an extension may
    // depend on it. Entries are append-only, keyed by content hash.
    writeIndex(sdir, [entry]);
    try {
      const st = fs.statSync(sdir);
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        for (const target of [dest, indexPath(sdir), seriesSourceDir(sdir), dir]) fs.chownSync(target, st.uid, st.gid);
      }
    } catch {
      // Ownership is best-effort.
    }
    return entry;
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Temp already renamed.
    }
  }
}

/**
 * Publish the validated temp copy at its content-addressed name without ever
 * replacing a good archive. A concurrent writer of the same content wins the
 * link race; an existing file that does not hash to `sha256` is corrupt and is
 * replaced by this verified copy.
 */
function commitExclusive(tmp: string, dest: string, sha256: string): void {
  try {
    fs.linkSync(tmp, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (isFile(dest) && hashFile(dest) === sha256) return;
  // The name is derived from the content, so a mismatching file is damage, not a
  // different archive: drop it and publish this validated copy.
  fs.rmSync(dest, { force: true });
  fs.linkSync(tmp, dest);
}

/** Short human description for logs and job notes. */
export function describeRetainedSources(sdir: string): string {
  const entries = listRetainedSources(sdir);
  if (!entries.length) return "none";
  return entries
    .map((entry) => `${entry.file} (${entry.chapters.map((n) => `ch${n}`).join(", ")})`)
    .join("; ");
}

/** `out/source` exists and holds at least one usable archive. */
export function hasRetainedSource(sdir: string): boolean {
  return listRetainedSources(sdir).length > 0;
}
