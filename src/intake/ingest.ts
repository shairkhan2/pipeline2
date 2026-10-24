/**
 * ingest.ts - source zip (of .cbz files) -> series/<name>/chN/ page folders.
 *
 * TypeScript port of manhwa-pipeline/pipeline/ingest.py. Zero LLM calls.
 *
 *   npx tsx src/intake/ingest.ts <series> [--chapters 1-5|1,2,3|all] [--force]
 *       [--zip PATH] [--engine edge|eleven|external] [--voice ID]
 *       [--background ID] [--motion ID] [--yes]
 *
 * Layout produced (matches what the slicer expects - pages sorted by name):
 *   series/<series>/chN/001.webp, 002.webp, ...   (original extension preserved)
 *
 * Rules (same as ingest.py):
 *   - cbz files inside the zip are ordered by the NUMBER in their filename
 *     ("Rage scans_Chapter 7_x.cbz" -> ch7), never by zip order.
 *   - only image entries are written; ComicInfo.xml and other metadata are skipped.
 *   - page order = natural sort of the image basename (ingest.py pages_of).
 *   - idempotent: a chapter folder whose page count already matches is left
 *     alone unless force. Re-running never half-overwrites a good folder.
 *   - the series title is read from ComicInfo.xml and offered to meta.json.
 *
 * ZIP safety: central-directory headers are inspected before any inflate.
 * Encrypted entries (flags & 0x1), symlinks, fifo/socket/device entries,
 * compression ratio > 200, and size budgets throw ZipValidationError with the
 * same messages as ingest.py. Member bytes are inflated under a hard cap so a
 * falsified uncompressed size cannot exhaust memory.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { z } from "zod";

import { pyFloatRepr, pyReprStr } from "../contracts/hashes.js";
import { seriesStyleSchema } from '../config/seriesStyle.js';
import { ELEVENLABS_DEFAULT_VOICE, isValidElevenLabsVoiceId } from "../llm/elevenlabsTts.js";

// Keep in sync with remotion-studio/src/backgrounds/index.tsx BACKGROUNDS keys.
export const BACKGROUNDS = ["starfield", "storm-valley", "mist-pines"] as const;
export const DEFAULT_BACKGROUND = "starfield";
// Keep in sync with remotion-studio/src/motions/index.tsx MOTIONS keys.
export const MOTIONS = ["window", "cut", "duo"] as const;
export const DEFAULT_MOTION = "window";
// Card animation for the window motion (meta.json visuals.animation).
// Keep in sync with remotion-studio/src/motions/animation.ts. Every field is
// optional; an absent field renders the default hard-cut look.
export const CARD_ENTRIES = ["none", "fade", "zoom", "slide-up", "slide-left"] as const;
export const CARD_EXITS = ["none", "fade", "zoom-out", "slide-down"] as const;
export const CARD_PUSH_INS = ["off", "subtle", "normal", "strong"] as const;
export const cardAnimationSchema = z.object({
  entry: z.enum(CARD_ENTRIES).optional(),
  exit: z.enum(CARD_EXITS).optional(),
  entryS: z.number().finite().min(0).max(1).optional(),
  exitS: z.number().finite().min(0).max(1).optional(),
  pushIn: z.enum(CARD_PUSH_INS).optional(),
  drift: z.boolean().optional(),
}).strict();
export type CardAnimation = z.infer<typeof cardAnimationSchema>;

/** Valid object minus undefined keys; invalid or empty yields null (renderer defaults). */
export function normalizeCardAnimation(value: unknown): CardAnimation | null {
  const parsed = cardAnimationSchema.safeParse(value);
  if (!parsed.success) return null;
  const out = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  ) as CardAnimation;
  return Object.keys(out).length ? out : null;
}

const IMG_RE = /\.(webp|jpg|jpeg|png|gif|bmp)$/i;
const CH_RE = /(?:chapter|ch|chap|ep|episode)[\s._-]*(\d+)/i;
const NUM_RE = /(\d+)/;
const NUM_FOLDER_RE = /^\s*0*(\d+)(?:[\s._-]+.*)?$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DRIVE_RE = /^[A-Za-z]:/;
const NESTED_OUTER_EXTS = [".zip", ".rar", ".7z", ".tar", ".gz", ".tar.gz", ".tgz"];
const NESTED_INNER_EXTS = [".zip", ".cbz", ".rar", ".7z", ".tar", ".gz"];
const RATIO_MIN_BYTES = 10 * 1024 * 1024;
const READ_CHUNK = 65536;
const COMICINFO_MAX_BYTES = 262144;
const EDGE_DEFAULT_VOICE = "en-US-AndrewMultilingualNeural";
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// POSIX file-type bits. Python 3.14 exposes S_IFMT as a function; the mask is
// the traditional 0o170000. S_ISLNK(mode) is (mode & S_IFMT) == S_IFLNK.
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

// CP437 high half (bytes 0x80-0xFF). ASCII 0x00-0x7F is identity.
const CP437_HIGH: readonly number[] = [
  199, 252, 233, 226, 228, 224, 229, 231, 234, 235, 232, 239, 238, 236, 196, 197,
  201, 230, 198, 244, 246, 242, 251, 249, 255, 214, 220, 162, 163, 165, 8359, 402,
  225, 237, 243, 250, 241, 209, 170, 186, 191, 8976, 172, 189, 188, 161, 171, 187,
  9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564,
  9563, 9488, 9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574,
  9568, 9552, 9580, 9575, 9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496,
  9484, 9608, 9604, 9612, 9616, 9600, 945, 223, 915, 960, 931, 963, 181, 964, 934, 920,
  937, 948, 8734, 966, 949, 8745, 8801, 177, 8805, 8804, 8992, 8993, 247, 8776, 176,
  8729, 183, 8730, 8319, 178, 9632, 160,
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new Error(`invalid literal for int() with base 10: ${pyReprStr(raw)}`);
  }
  return Number(t);
}

export const MAX_ZIP_BYTES = envInt("MANHWA_MAX_ZIP_BYTES", 1536 * 1024 * 1024);
export const MAX_TOTAL_UNCOMPRESSED_BYTES = envInt(
  "MANHWA_MAX_UNCOMPRESSED_BYTES",
  4 * 1024 * 1024 * 1024,
);
export const MAX_SINGLE_ENTRY_BYTES = envInt("MANHWA_MAX_ENTRY_BYTES", 512 * 1024 * 1024);
export const MAX_IMAGE_BYTES = envInt("MANHWA_MAX_IMAGE_BYTES", 64 * 1024 * 1024);
export const MAX_TOTAL_ENTRIES = envInt("MANHWA_MAX_ZIP_ENTRIES", 10000);
export const MAX_NESTED_ARCHIVES = envInt("MANHWA_MAX_NESTED_CBZ", 300);
export const MAX_COMPRESSION_RATIO = 200.0;

/**
 * Mutable module paths. Python patches `ingest.SERIES_ROOT` / `ingest.DOWNLOADS`.
 * ES module exports are live but not assignable from importers, so mutate these
 * fields (or pass `seriesRoot` / `downloads` on the ingest options).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const roots = {
  seriesRoot: process.env.MANHWA_SERIES_ROOT ?? path.join(REPO_ROOT, "series"),
  downloads: process.env.MANHWA_DOWNLOADS ?? path.join(REPO_ROOT, "downloads"),
};

export class ZipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipValidationError";
  }
}

/** Python SystemExit. `code` is the argument passed to `raise SystemExit(...)`. */
export class SystemExit extends Error {
  code: string | number;

  constructor(code: string | number = 1) {
    super(typeof code === "string" ? code : `exit ${code}`);
    this.name = "SystemExit";
    this.code = code;
  }
}

/** Python zipfile.BadZipFile. Wrapped into ZipValidationError at the archive boundary. */
class BadZipFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadZipFile";
  }
}

class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}

export interface ZipEntryLike {
  entryName: string;
  rawEntryName: Buffer;
  isDirectory: boolean;
  header: {
    flags: number;
    attr: number;
    size: number;
    compressedSize: number;
    method: number;
    crc: number;
  };
  getCompressedData(): Buffer;
}

export interface ZipStats {
  compressed_bytes: number;
  uncompressed_bytes: number;
  total_entries: number;
  nested_cbz_count: number;
}

export interface ValidateZipOptions {
  maxZipBytes?: number | null;
  maxTotalUncompressedBytes?: number | null;
  maxSingleEntryBytes?: number | null;
  maxImageBytes?: number | null;
  maxTotalEntries?: number | null;
  maxNestedArchives?: number | null;
  max_zip_bytes?: number | null;
  max_total_uncompressed_bytes?: number | null;
  max_single_entry_bytes?: number | null;
  max_image_bytes?: number | null;
  max_total_entries?: number | null;
  max_nested_archives?: number | null;
}

export interface TtsConfig {
  engine?: string;
  provider?: string;
  revision?: string;
  command?: unknown;
  voice_id?: string;
  language?: string;
  speed?: number;
  style?: unknown;
  settings?: unknown;
  [key: string]: unknown;
}

export interface IngestOptions {
  style?: import('../config/seriesStyle.js').SeriesStyle;
  chapters?: number[] | null;
  force?: boolean;
  zipPath?: string | null;
  zip_path?: string | null;
  engine?: string | null;
  voiceId?: string | null;
  voice_id?: string | null;
  background?: string | null;
  motion?: string | null;
  animation?: CardAnimation | null;
  interactive?: boolean | null;
  ttsConfig?: TtsConfig | null;
  tts_config?: TtsConfig | null;
  title?: string | null;
  seriesRoot?: string | null;
  series_root?: string | null;
  downloads?: string | null;
}

export interface FreshConfig {
  engine?: string;
  voice_id?: string;
  voiceId?: string;
  background?: string;
  motion?: string;
}

type NatPart = number | string;
type ChapterMap<T> = Record<number, T>;

function defined<T>(camel: T | null | undefined, snake: T | null | undefined): T | null | undefined {
  return camel !== undefined ? camel : snake;
}

function pySlice(s: string, n: number): string {
  if (n <= 0) return "";
  let i = 0;
  let out = "";
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i++;
  }
  return out;
}

function cmpStr(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0)!;
    const bc = bn.value.codePointAt(0)!;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

/** Python str.strip() for the whitespace ComicInfo titles actually carry. */
function pyStrip(s: string): string {
  return s.replace(
    /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0085\u001c-\u001f]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u0085\u001c-\u001f]+$/g,
    "",
  );
}

function fmtInt(n: number): string {
  if (Number.isSafeInteger(n)) return String(n);
  return n.toFixed(0);
}

function posixBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Python os.path.dirname on POSIX (`""` for a bare filename, not `"."`). */
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  const head = p.slice(0, i).replace(/\/+$/, "");
  return head || "/";
}

function posixExt(p: string): string {
  const base = posixBasename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
}

function endsWithAny(lower: string, exts: readonly string[]): boolean {
  for (const ext of exts) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Python os.path.realpath: resolve symlinks in the existing prefix, then
 * append the missing tail without requiring it to exist.
 */
function pyRealpath(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let cur = abs;
  while (true) {
    try {
      lstatSync(cur);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
  let resolved: string;
  try {
    resolved = realpathSync(cur);
  } catch {
    resolved = cur;
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    resolved = path.join(resolved, missing[i]!);
  }
  return resolved;
}

function commonPath(a: string, b: string): string {
  const as = a.split(path.sep);
  const bs = b.split(path.sep);
  const out: string[] = [];
  for (let i = 0; i < as.length && i < bs.length; i++) {
    if (as[i] !== bs[i]) break;
    out.push(as[i]!);
  }
  if (out.length === 0) return "";
  if (out.length === 1 && out[0] === "") return path.sep;
  return out.join(path.sep);
}

function decodeCp437(buf: Buffer): string {
  let out = "";
  for (const b of buf) {
    out += b < 128 ? String.fromCharCode(b) : String.fromCharCode(CP437_HIGH[b - 128]!);
  }
  return out;
}

function decodeEntryName(entry: ZipEntryLike): string {
  const raw = entry.rawEntryName;
  if (!raw || raw.length === 0) return "";
  // Bit 11: language encoding flag. Python zipfile uses UTF-8 then, else cp437.
  if ((entry.header.flags & 0x800) !== 0) {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  }
  return decodeCp437(raw);
}

function fileType(mode: number): number {
  return mode & S_IFMT;
}

function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new Error(`invalid literal for int() with base 10: ${pyReprStr(s)}`);
  }
  return Number(t);
}

function indexKeys(idx: ChapterMap<unknown>): number[] {
  return Object.keys(idx).map(Number).sort((a, b) => a - b);
}

function natParts(text: string): NatPart[] {
  return text.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function cmpNat(a: NatPart[], b: NatPart[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x !== typeof y) {
      // Mixed number/string segments: numbers sort before strings, deterministically.
      return typeof x === "number" ? -1 : 1;
    }
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

function quoteJson(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else if (cp > 0x7f) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${cp.toString(16).padStart(4, "0")}`;
      }
    } else out += ch;
  }
  return `${out}"`;
}

/**
 * Python json.dumps(..., indent=2, ensure_ascii=True). Whole-number `speed`
 * values are floats in the Python catalog (`1.0`, not `1`).
 */
function dumpMeta(value: unknown): string {
  const padUnit = "  ";
  const render = (v: unknown, level: number, key?: string): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Out of range float values are not JSON compliant");
      if (key === "speed" || !Number.isInteger(v)) return pyFloatRepr(v);
      return String(v);
    }
    if (typeof v === "string") return quoteJson(v);
    const pad = padUnit.repeat(level);
    const padIn = padUnit.repeat(level + 1);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((item) => padIn + render(item, level + 1)).join(",\n")}\n${pad}]`;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return "{}";
      const lines = keys.map((k) => `${padIn}${quoteJson(k)}: ${render(obj[k], level + 1, k)}`);
      return `{\n${lines.join(",\n")}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

function toBadZip(e: unknown): BadZipFile {
  if (e instanceof BadZipFile) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/No END header found|Invalid or unsupported zip format/i.test(msg)) {
    return new BadZipFile("File is not a zip file");
  }
  return new BadZipFile(msg.replace(/^ADM-ZIP:\s*/, ""));
}

function loadZip(source: string | Buffer): AdmZip {
  try {
    const zip = new AdmZip(source, { noSort: true });
    zip.getEntries();
    return zip;
  } catch (e) {
    if (e instanceof ZipValidationError || e instanceof BadZipFile) throw e;
    throw toBadZip(e);
  }
}

function zipEntries(zip: AdmZip): ZipEntryLike[] {
  return zip.getEntries() as ZipEntryLike[];
}

function findEntry(zip: AdmZip, memberName: string): ZipEntryLike {
  let found: ZipEntryLike | null = null;
  for (const entry of zipEntries(zip)) {
    if (decodeEntryName(entry) === memberName) found = entry;
  }
  if (!found) {
    throw new Error(`There is no item named ${pyReprStr(memberName)} in the archive`);
  }
  return found;
}

export function _isIgnoredEntry(name: string): boolean {
  const parts = name.split("/").filter((p) => p !== "");
  if (parts.length === 0) return true;
  if (parts[0] === "__MACOSX" || parts.some((p) => p === "__MACOSX")) return true;
  const base = parts[parts.length - 1]!;
  if (base.startsWith("._") || base.toLowerCase() === ".ds_store" || base.toLowerCase() === "thumbs.db") {
    return true;
  }
  return false;
}

export function _validateEntryName(name: string, label = "ZIP"): void {
  if (typeof name !== "string" || name === "") {
    throw new ZipValidationError(`${label} contains an empty entry name`);
  }
  if (name.includes("\0")) {
    throw new ZipValidationError(`${label} entry contains NUL byte`);
  }
  if (name.includes("\\")) {
    throw new ZipValidationError(
      `${label} entry contains unsafe backslash path: ${pyReprStr(pySlice(name, 80))}`,
    );
  }
  if (name.startsWith("/") || DRIVE_RE.test(name)) {
    throw new ZipValidationError(
      `${label} entry uses an absolute or drive path: ${pyReprStr(pySlice(name, 80))}`,
    );
  }
  const parts = name.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) {
    throw new ZipValidationError(
      `${label} entry contains path traversal ('..'): ${pyReprStr(pySlice(name, 80))}`,
    );
  }
}

export function _validateZinfo(
  entry: ZipEntryLike,
  opts: { label?: string; maxEntryBytes?: number | null; maxRatio?: number } = {},
): void {
  const label = opts.label ?? "ZIP";
  const name = decodeEntryName(entry);
  _validateEntryName(name, label);
  // General-purpose bit 0: traditional PKZIP encryption.
  if ((entry.header.flags & 0x1) !== 0) {
    throw new ZipValidationError(`${label} contains encrypted entry: ${pyReprStr(pySlice(name, 80))}`);
  }
  const mode = (entry.header.attr >>> 16) & 0xffff;
  if (mode) {
    const kind = fileType(mode);
    if (kind === S_IFLNK) {
      throw new ZipValidationError(
        `${label} contains symbolic link entry: ${pyReprStr(pySlice(name, 80))}`,
      );
    }
    if (kind === S_IFIFO || kind === S_IFSOCK || kind === S_IFBLK || kind === S_IFCHR) {
      throw new ZipValidationError(
        `${label} contains special device/socket entry: ${pyReprStr(pySlice(name, 80))}`,
      );
    }
  }
  const limit = opts.maxEntryBytes == null ? MAX_SINGLE_ENTRY_BYTES : opts.maxEntryBytes;
  const fileSize = entry.header.size;
  if (fileSize < 0 || fileSize > limit) {
    throw new ZipValidationError(
      `${label} entry ${pyReprStr(pySlice(posixBasename(name), 60))} uncompressed size ` +
        `(${fmtInt(fileSize)} B) exceeds limit (${fmtInt(limit)} B)`,
    );
  }
  if (fileSize > RATIO_MIN_BYTES) {
    const comp = Math.max(1, Math.trunc(entry.header.compressedSize || 0));
    const maxRatio = opts.maxRatio ?? MAX_COMPRESSION_RATIO;
    if (fileSize / comp > maxRatio) {
      throw new ZipValidationError(
        `${label} entry ${pyReprStr(pySlice(posixBasename(name), 60))} exceeds compression ratio limit`,
      );
    }
  }
}

function decompressedExceeds(memberName: string, maxBytes: number): string {
  return (
    `Entry ${pyReprStr(pySlice(posixBasename(memberName), 60))} decompressed data exceeds ` +
    `maximum allowed size (${fmtInt(maxBytes)} B)`
  );
}

function inflateCapped(compressed: Buffer, maxBytes: number, memberName: string): Buffer {
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ZipValidationError(decompressedExceeds(memberName, maxBytes));
    }
    throw toBadZip(e);
  }
}

/**
 * Read a ZIP member in a size-capped inflate so a falsified uncompressed size
 * cannot exhaust memory. Throws ZipValidationError when the decompressed byte
 * count exceeds `maxBytes` (Python: total > max_bytes).
 */
export function _readMemberBounded(zip: AdmZip, memberName: string, maxBytes: number): Buffer {
  const entry = findEntry(zip, memberName);
  const flags = entry.header.flags;
  if ((flags & 0x1) !== 0) {
    throw new Error(
      `File ${pyReprStr(memberName)} is encrypted, password required for extraction`,
    );
  }
  let compressed: Buffer;
  try {
    compressed = entry.getCompressedData();
  } catch (e) {
    if (e instanceof ZipValidationError || e instanceof BadZipFile) throw e;
    throw toBadZip(e);
  }
  const declared = entry.header.size;
  const method = entry.header.method;
  let data: Buffer;
  if (declared === 0 && compressed.length === 0) {
    data = Buffer.alloc(0);
  } else if (method === 0) {
    if (compressed.length > maxBytes) {
      throw new ZipValidationError(decompressedExceeds(memberName, maxBytes));
    }
    data = compressed;
  } else if (method === 8) {
    data = inflateCapped(compressed, maxBytes, memberName);
  } else {
    throw new Error("That compression method is not supported");
  }
  if (data.length > maxBytes) {
    throw new ZipValidationError(decompressedExceeds(memberName, maxBytes));
  }
  // Python ZipExtFile truncates to the declared uncompressed size, then checks CRC.
  if (declared >= 0 && data.length > declared) {
    data = data.subarray(0, declared);
  }
  const expected = entry.header.crc >>> 0;
  const got = zlib.crc32(data) >>> 0;
  if (got !== expected) {
    throw new BadZipFile(`Bad CRC-32 for file ${pyReprStr(memberName)}`);
  }
  return data;
}

function readMagic(zipPath: string): Buffer {
  const fd = openSync(zipPath, "r");
  try {
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function isPythonDir(name: string): boolean {
  return name.endsWith("/");
}

export function validateZipArchive(zipPath: string, opts: ValidateZipOptions = {}): ZipStats {
  const maxZipBytes = defined(opts.maxZipBytes, opts.max_zip_bytes) ?? MAX_ZIP_BYTES;
  const maxTotalUncompressed = defined(
    opts.maxTotalUncompressedBytes,
    opts.max_total_uncompressed_bytes,
  ) ?? MAX_TOTAL_UNCOMPRESSED_BYTES;
  const maxSingleEntry = defined(opts.maxSingleEntryBytes, opts.max_single_entry_bytes) ?? MAX_SINGLE_ENTRY_BYTES;
  const maxImage = defined(opts.maxImageBytes, opts.max_image_bytes) ?? MAX_IMAGE_BYTES;
  const maxEntries = defined(opts.maxTotalEntries, opts.max_total_entries) ?? MAX_TOTAL_ENTRIES;
  const maxNested = defined(opts.maxNestedArchives, opts.max_nested_archives) ?? MAX_NESTED_ARCHIVES;

  if (typeof zipPath !== "string" || zipPath === "") {
    throw new ZipValidationError("ZIP path is required");
  }
  let st;
  try {
    st = lstatSync(zipPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ZipValidationError(`ZIP file not found: ${zipPath}`);
    }
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new ZipValidationError("ZIP path must not be a symbolic link");
  }
  if (!st.isFile()) {
    throw new ZipValidationError(`ZIP file not found: ${zipPath}`);
  }
  const size = st.size;
  if (size <= 0) {
    throw new ZipValidationError("ZIP archive is empty");
  }
  if (size > maxZipBytes) {
    throw new ZipValidationError(
      `ZIP archive size (${fmtInt(size)} B) exceeds maximum allowed (${fmtInt(maxZipBytes)} B)`,
    );
  }
  const magic = readMagic(zipPath);
  if (magic.length !== 4 || !magic.equals(ZIP_MAGIC)) {
    throw new ZipValidationError("File is not a valid ZIP archive (bad magic header)");
  }

  let totalEntries = 0;
  let totalUncompressed = 0;
  const nestedCbz: string[] = [];

  try {
    const zf = loadZip(zipPath);
    const infos = zipEntries(zf);
    if (infos.length === 0) {
      throw new ZipValidationError("ZIP archive contains no entries");
    }
    for (const zinfo of infos) {
      totalEntries += 1;
      if (totalEntries > maxEntries) {
        throw new ZipValidationError(`ZIP archive entry count exceeds limit (${fmtInt(maxEntries)})`);
      }
      const name = decodeEntryName(zinfo);
      const lower = name.toLowerCase();
      const dir = isPythonDir(name);
      const isCbz = lower.endsWith(".cbz") && !dir;
      const isImg = IMG_RE.test(name) && !dir;
      if (endsWithAny(lower, NESTED_OUTER_EXTS) && !isCbz) {
        throw new ZipValidationError(
          `Nested archive ${pyReprStr(pySlice(posixBasename(name), 60))} is not supported ` +
            "(use .cbz or chapter image folders)",
        );
      }
      const entryLimit = isImg ? maxImage : maxSingleEntry;
      _validateZinfo(zinfo, { label: "ZIP", maxEntryBytes: entryLimit });
      totalUncompressed += zinfo.header.size;
      if (totalUncompressed > maxTotalUncompressed) {
        throw new ZipValidationError(
          `Total uncompressed size exceeds limit (${fmtInt(maxTotalUncompressed)} B)`,
        );
      }
      if (isCbz && !_isIgnoredEntry(name)) nestedCbz.push(name);
    }

    if (nestedCbz.length > maxNested) {
      throw new ZipValidationError(
        `Number of nested .cbz archives (${nestedCbz.length}) exceeds limit (${fmtInt(maxNested)})`,
      );
    }

    for (const cbzName of nestedCbz) {
      const rawCbz = _readMemberBounded(zf, cbzName, maxSingleEntry);
      const cbzBase = posixBasename(cbzName);
      try {
        const inner = loadZip(rawCbz);
        for (const iz of zipEntries(inner)) {
          totalEntries += 1;
          if (totalEntries > maxEntries) {
            throw new ZipValidationError(
              `Total archive entry count exceeds limit (${fmtInt(maxEntries)})`,
            );
          }
          const iname = decodeEntryName(iz);
          const ilower = iname.toLowerCase();
          if (endsWithAny(ilower, NESTED_INNER_EXTS)) {
            throw new ZipValidationError(
              `Nested archive inside CBZ (${pyReprStr(cbzBase)}) is forbidden`,
            );
          }
          const iLimit = IMG_RE.test(iname) ? maxImage : maxSingleEntry;
          _validateZinfo(iz, { label: `CBZ(${cbzBase})`, maxEntryBytes: iLimit });
          totalUncompressed += iz.header.size;
          if (totalUncompressed > maxTotalUncompressed) {
            throw new ZipValidationError(
              `Total uncompressed size exceeds limit (${fmtInt(maxTotalUncompressed)} B)`,
            );
          }
        }
      } catch (e) {
        if (e instanceof ZipValidationError) throw e;
        if (e instanceof BadZipFile) {
          throw new ZipValidationError(
            `Corrupt nested CBZ archive ${pyReprStr(cbzBase)}: ${e.message}`,
          );
        }
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof ZipValidationError) throw e;
    if (e instanceof BadZipFile) {
      throw new ZipValidationError(`Corrupt or invalid ZIP archive: ${e.message}`);
    }
    throw e;
  }

  return {
    compressed_bytes: size,
    uncompressed_bytes: totalUncompressed,
    total_entries: totalEntries,
    nested_cbz_count: nestedCbz.length,
  };
}

function listZips(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".zip") && !n.startsWith("."))
    .map((n) => path.join(dir, n))
    .sort(cmpStr);
}

export function findZip(series: string, explicit?: string | null, downloadsDir?: string): string {
  if (explicit) return explicit;
  const downloads = downloadsDir ?? roots.downloads;
  const cands = listZips(downloads);
  if (cands.length === 0) {
    throw new SystemExit(`no zip found in ${downloads}`);
  }
  if (cands.length === 1) return cands[0]!;
  const needle = series.replaceAll("-", "");
  for (const p of cands) {
    if (needle === "" || posixBasename(p).replaceAll("-", "").toLowerCase().includes(needle)) {
      return p;
    }
  }
  for (const p of cands) {
    try {
      const zf = loadZip(p);
      if (zipEntries(zf).some((e) => decodeEntryName(e).toLowerCase().endsWith(".cbz"))) return p;
    } catch {
      continue;
    }
  }
  return cands[0]!;
}

export function cbzIndex(zipPath: string): ChapterMap<string> {
  const out: ChapterMap<string> = {};
  const zf = loadZip(zipPath);
  for (const entry of zipEntries(zf)) {
    const n = decodeEntryName(entry);
    if (_isIgnoredEntry(n) || !n.toLowerCase().endsWith(".cbz")) continue;
    const base = posixBasename(n);
    const m = CH_RE.exec(base) ?? NUM_RE.exec(base);
    if (!m) {
      console.log(`  !! cannot parse chapter number from ${base}; skipped`);
      continue;
    }
    out[Number(m[1])] = n;
  }
  return out;
}

function chapterFromDirs(dirParts: string[]): number | null {
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const m = CH_RE.exec(dirParts[i]!);
    if (m) return Number(m[1]);
  }
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const m = NUM_FOLDER_RE.exec(dirParts[i]!);
    if (m) return Number(m[1]);
  }
  return null;
}

export function folderIndex(zipPath: string): ChapterMap<string[]> {
  const out: ChapterMap<string[]> = {};
  const zf = loadZip(zipPath);
  for (const zinfo of zipEntries(zf)) {
    const n = decodeEntryName(zinfo);
    if (isPythonDir(n)) continue;
    if (_isIgnoredEntry(n) || !IMG_RE.test(n)) continue;
    const parts = n.split("/").filter((p) => p !== "");
    const dirParts = parts.slice(0, -1);
    const chNum = chapterFromDirs(dirParts);
    if (chNum === null) continue;
    const list = out[chNum] ?? [];
    list.push(n);
    out[chNum] = list;
  }
  for (const chNum of Object.keys(out)) {
    out[Number(chNum)]!.sort((a, b) => {
      const c = cmpNat(natParts(posixDirname(a)), natParts(posixDirname(b)));
      if (c !== 0) return c;
      return cmpNat(natParts(posixBasename(a)), natParts(posixBasename(b)));
    });
  }
  return out;
}

export function archiveIndex(
  zipPath: string,
  validate = true,
): ["cbz", ChapterMap<string>] | ["folders", ChapterMap<string[]>] {
  if (validate) validateZipArchive(zipPath);
  const cIdx = cbzIndex(zipPath);
  if (Object.keys(cIdx).length > 0) return ["cbz", cIdx];
  const fIdx = folderIndex(zipPath);
  if (Object.keys(fIdx).length > 0) return ["folders", fIdx];
  throw new ZipValidationError(
    `no chapter .cbz archives or chapter image folders found inside ${posixBasename(zipPath)}`,
  );
}

function imageNames(zip: AdmZip): string[] {
  const names: string[] = [];
  for (const entry of zipEntries(zip)) {
    const n = decodeEntryName(entry);
    if (IMG_RE.test(n) && !_isIgnoredEntry(n) && !isPythonDir(n)) names.push(n);
  }
  names.sort((a, b) => cmpNat(natParts(posixBasename(a)), natParts(posixBasename(b))));
  return names;
}

export function pagesOf(zipPath: string, cbzEntry: string): { zip: AdmZip; names: string[] } {
  const outer = loadZip(zipPath);
  const raw = _readMemberBounded(outer, cbzEntry, MAX_SINGLE_ENTRY_BYTES);
  const inner = loadZip(raw);
  return { zip: inner, names: imageNames(inner) };
}

function seriesFromXml(txt: string): string | null {
  const m = /<Series>(.*?)<\/Series>/s.exec(txt);
  if (!m) return null;
  const title = pyStrip(m[1] ?? "");
  return title ? title : null;
}

export function comicTitle(zipPath: string, cbzEntry?: string | null): string | null {
  try {
    const zf = loadZip(zipPath);
    const names = zipEntries(zf).map(decodeEntryName);
    if (cbzEntry && names.includes(cbzEntry)) {
      const rawCbz = _readMemberBounded(zf, cbzEntry, MAX_SINGLE_ENTRY_BYTES);
      const inner = loadZip(rawCbz);
      for (const entry of zipEntries(inner)) {
        const n = decodeEntryName(entry);
        if (n.toLowerCase().endsWith("comicinfo.xml") && !_isIgnoredEntry(n)) {
          const txt = _readMemberBounded(inner, n, COMICINFO_MAX_BYTES).toString("utf8");
          const title = seriesFromXml(txt);
          if (title) return title;
        }
      }
    }
    for (const entry of zipEntries(zf)) {
      const n = decodeEntryName(entry);
      if (n.toLowerCase().endsWith("comicinfo.xml") && !_isIgnoredEntry(n)) {
        const txt = _readMemberBounded(zf, n, COMICINFO_MAX_BYTES).toString("utf8");
        const title = seriesFromXml(txt);
        if (title) return title;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function availableNumbers(
  available: Iterable<number> | ReadonlyMap<number, unknown> | Record<string, unknown>,
): number[] {
  if (available instanceof Map) return [...available.keys()].sort((a, b) => a - b);
  if (available instanceof Set) return [...available].sort((a, b) => a - b);
  if (Array.isArray(available)) return [...available].sort((a, b) => a - b);
  if (typeof available === "object" && available !== null && Symbol.iterator in available) {
    return [...(available as Iterable<number>)].sort((a, b) => a - b);
  }
  return Object.keys(available as Record<string, unknown>).map(Number).sort((a, b) => a - b);
}

export function parseChapterSpec(
  spec: string | null | undefined,
  available: Iterable<number> | ReadonlyMap<number, unknown> | Record<string, unknown>,
): number[] {
  if (!spec || spec === "all") return availableNumbers(available);
  const out = new Set<number>();
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (part.includes("-")) {
      const dash = part.indexOf("-");
      const a = pyInt(part.slice(0, dash));
      const b = pyInt(part.slice(dash + 1));
      for (let n = a; n < b + 1; n++) out.add(n);
    } else if (part) {
      out.add(pyInt(part));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function readPromptLine(prompt: string): string {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1);
  const chunks: Buffer[] = [];
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN" || (e as NodeJS.ErrnoException).code === "EWOULDBLOCK") {
        throw new EOFError();
      }
      throw e;
    }
    if (n === 0) {
      if (chunks.length === 0) throw new EOFError();
      break;
    }
    if (buf[0] === 0x0a) break;
    chunks.push(Buffer.from(buf));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function askFreshConfig(
  defaults?: FreshConfig | null,
  input: (prompt: string) => string = readPromptLine,
): [string, string, string, string] {
  const d = defaults ?? {};
  const dEngine = d.engine ?? "edge";
  const dBg = d.background ?? DEFAULT_BACKGROUND;
  const dMotion = d.motion ?? DEFAULT_MOTION;
  let engine: string;
  try {
    engine = input(`TTS engine [edge/eleven/elevenlabs/external] (default ${dEngine}): `).trim().toLowerCase() || dEngine;
  } catch (e) {
    if (!(e instanceof EOFError)) throw e;
    engine = dEngine;
  }
  if (engine !== "edge" && engine !== "eleven" && engine !== "elevenlabs" && engine !== "external") {
    console.log(`  unknown engine ${pyReprStr(engine)} - using ${dEngine}`);
    engine = dEngine;
  }
  let voiceId = d.voice_id ?? d.voiceId ?? "";
  if ((engine === "eleven" || engine === "elevenlabs" || engine === "external") && !voiceId) {
    const promptLbl = engine === "eleven"
      ? "ElevenLabs voice (gsk preset name or voice id)"
      : engine === "elevenlabs"
        ? `ElevenLabs voice id (default ${ELEVENLABS_DEFAULT_VOICE})`
        : "External TTS voice id";
    try {
      voiceId = input(`${promptLbl}: `).trim();
    } catch (e) {
      if (!(e instanceof EOFError)) throw e;
      voiceId = "";
    }
    if (!voiceId && engine === "elevenlabs") voiceId = ELEVENLABS_DEFAULT_VOICE;
    if (!voiceId) {
      throw new SystemExit(`engine=${engine} needs a voice - rerun with --voice <id>`);
    }
  }
  if (engine === "elevenlabs" && !isValidElevenLabsVoiceId(voiceId)) {
    throw new SystemExit(`invalid ElevenLabs voice id ${pyReprStr(voiceId)} (expected 16-40 letters or digits)`);
  }
  let bg: string;
  try {
    bg = input(`Background preset [${BACKGROUNDS.join("/")}] (default ${dBg}): `).trim().toLowerCase() || dBg;
  } catch (e) {
    if (!(e instanceof EOFError)) throw e;
    bg = dBg;
  }
  if (!(BACKGROUNDS as readonly string[]).includes(bg)) {
    console.log(`  unknown background ${pyReprStr(bg)} - using ${dBg}`);
    bg = dBg;
  }
  let motion: string;
  try {
    motion = input(`Motion preset [${MOTIONS.join("/")}] (default ${dMotion}): `).trim().toLowerCase() || dMotion;
  } catch (e) {
    if (!(e instanceof EOFError)) throw e;
    motion = dMotion;
  }
  if (!(MOTIONS as readonly string[]).includes(motion)) {
    console.log(`  unknown motion ${pyReprStr(motion)} - using ${dMotion}`);
    motion = dMotion;
  }
  return [engine, voiceId, bg, motion];
}

function ensureSafeSeriesDir(seriesRoot: string, series: string): string {
  if (typeof series !== "string" || !SLUG_RE.test(series) || series === "." || series === "..") {
    const shown = typeof series === "string" ? pyReprStr(series) : String(series);
    throw new SystemExit(`invalid series slug: ${shown}`);
  }
  const rootReal = pyRealpath(seriesRoot);
  const sdir = path.join(seriesRoot, series);
  if (isLink(sdir)) {
    throw new SystemExit(`refusing to write to symlinked series path: ${sdir}`);
  }
  const sdirReal = pyRealpath(sdir);
  if (commonPath(rootReal, sdirReal) !== rootReal || sdirReal === rootReal) {
    throw new SystemExit(`series path escapes SERIES_ROOT: ${sdir}`);
  }
  return sdir;
}

function countImages(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (IMG_RE.test(f)) n += 1;
  }
  return n;
}

export function ingest(series: string, options: IngestOptions = {}): number[] {
  const style = seriesStyleSchema.optional().parse(options.style);
  const zipExplicit = defined(options.zipPath, options.zip_path);
  const downloads = options.downloads ?? roots.downloads;
  const zipPath = findZip(series, zipExplicit, downloads);
  let layout: "cbz" | "folders";
  let idx: ChapterMap<string> | ChapterMap<string[]>;
  try {
    [layout, idx] = archiveIndex(zipPath, true);
  } catch (e) {
    if (e instanceof ZipValidationError) throw new SystemExit(e.message);
    throw e;
  }
  const seriesRoot = defined(options.seriesRoot, options.series_root) ?? roots.seriesRoot;
  const sdir = ensureSafeSeriesDir(seriesRoot, series);
  mkdirSync(sdir, { recursive: true });
  console.log(`ingest: ${posixBasename(zipPath)} (${layout}) -> ${sdir}`);
  const found = indexKeys(idx);
  console.log(`  chapters found: [${found.join(", ")}]`);
  const chapters = options.chapters == null ? found : options.chapters;
  const done: number[] = [];
  const skipped: number[] = [];
  const outer = loadZip(zipPath);
  for (const n of chapters) {
    if (!(n in idx)) {
      console.log(`  ch${n}: NOT IN ZIP - skipped`);
      continue;
    }
    const dest = path.join(sdir, `ch${n}`);
    if (isLink(dest)) {
      throw new SystemExit(`refusing to overwrite symlink chapter path: ${dest}`);
    }
    let names: string[];
    let reader: AdmZip;
    if (layout === "cbz") {
      const member = (idx as ChapterMap<string>)[n]!;
      const raw = _readMemberBounded(outer, member, MAX_SINGLE_ENTRY_BYTES);
      reader = loadZip(raw);
      names = imageNames(reader);
    } else {
      names = [...(idx as ChapterMap<string[]>)[n]!];
      reader = outer;
    }
    if (names.length === 0) {
      console.log(`  ch${n}: no image entries - skipped`);
      continue;
    }
    if (isDir(dest) && !options.force) {
      const have = countImages(dest);
      if (have === names.length) {
        console.log(`  ch${n}: already ingested (${have} pages) - skipped`);
        skipped.push(n);
        continue;
      }
    }
    if (isDir(dest)) rmSync(dest, { recursive: true });
    mkdirSync(dest, { recursive: true });
    for (let i = 0; i < names.length; i++) {
      const member = names[i]!;
      let ext = posixExt(member).toLowerCase();
      if (ext === ".jpeg") ext = ".jpg";
      const outFile = path.join(dest, `${String(i + 1).padStart(3, "0")}${ext}`);
      const data = _readMemberBounded(reader, member, MAX_IMAGE_BYTES);
      writeFileSync(outFile, data);
    }
    console.log(`  ch${n}: ${names.length} pages -> ${dest}`);
    done.push(n);
  }

  let engine = options.engine ?? null;
  let voiceId = defined(options.voiceId, options.voice_id) ?? null;
  let background = options.background ?? null;
  let motion = options.motion ?? null;
  const animation = options.animation == null ? null : normalizeCardAnimation(cardAnimationSchema.parse(options.animation));
  let interactive = options.interactive ?? null;
  const ttsConfig = defined(options.ttsConfig, options.tts_config) ?? null;
  const title = options.title ?? null;
  const mp = path.join(sdir, "meta.json");
  if (!existsSync(mp)) {
    if (ttsConfig && typeof ttsConfig === "object" && ttsConfig.engine) {
      engine = String(ttsConfig.engine).trim().toLowerCase();
      voiceId = String(ttsConfig.voice_id || voiceId || "").trim();
    }
    if (interactive == null) {
      interactive = process.stdin.isTTY === true &&
        ![engine, background, motion, ttsConfig].some((v) => v != null);
    }
    if (interactive && (engine == null || background == null || motion == null)) {
      [engine, voiceId, background, motion] = askFreshConfig({
        engine: engine || "edge",
        voice_id: voiceId || "",
        background: background || DEFAULT_BACKGROUND,
        motion: motion || DEFAULT_MOTION,
      });
    }
    engine = engine || "edge";
    background = background || DEFAULT_BACKGROUND;
    motion = motion || DEFAULT_MOTION;
    if (!(BACKGROUNDS as readonly string[]).includes(background)) {
      console.log(`  !! unknown background ${pyReprStr(background)} - using ${DEFAULT_BACKGROUND}`);
      background = DEFAULT_BACKGROUND;
    }
    if (!(MOTIONS as readonly string[]).includes(motion)) {
      console.log(`  !! unknown motion ${pyReprStr(motion)} - using ${DEFAULT_MOTION}`);
      motion = DEFAULT_MOTION;
    }
    if (
      engine !== "edge" && engine !== "eleven" && engine !== "external"
      && engine !== "vertex" && engine !== "grok" && engine !== "elevenlabs"
    ) {
      throw new SystemExit(`unknown engine ${pyReprStr(engine)} (expected edge, eleven, elevenlabs, external, vertex, or grok)`);
    }
    if (
      (engine === "eleven" || engine === "elevenlabs" || engine === "external" || engine === "vertex" || engine === "grok")
      && !voiceId
    ) {
      throw new SystemExit(`engine=${engine} needs --voice <id> (non-interactive)`);
    }
    if (engine === "elevenlabs" && !isValidElevenLabsVoiceId(voiceId!)) {
      throw new SystemExit(`invalid ElevenLabs voice id ${pyReprStr(voiceId!)} (expected 16-40 letters or digits)`);
    }
    const firstKey = found[0];
    const firstCbz = layout === "cbz" && firstKey !== undefined
      ? (idx as ChapterMap<string>)[firstKey]
      : null;
    const strippedTitle = title ? pyStrip(String(title)) : "";
    const detected = strippedTitle || comicTitle(zipPath, firstCbz);
    const ttsBlock: Record<string, unknown> = { engine };
    if (ttsConfig && typeof ttsConfig === "object") {
      for (const k of ["provider", "revision", "command", "voice_id", "model_id", "language", "speed", "style", "settings"]) {
        if (k in ttsConfig && ttsConfig[k] != null && ttsConfig[k] !== "") {
          ttsBlock[k] = ttsConfig[k];
        }
      }
    }
    if (engine === "elevenlabs") {
      ttsBlock.provider ??= "elevenlabs";
      ttsBlock.revision ??= "v1";
    }
    if (voiceId && (engine !== "edge" || voiceId !== EDGE_DEFAULT_VOICE)) {
      ttsBlock.voice_id = voiceId;
    } else if (engine === "edge") {
      delete ttsBlock.voice_id;
    }
    const meta = {
      tts: ttsBlock,
      visuals: { background, motion, ...(animation ? { animation } : {}) },
      title: detected || series,
      ...(style ? { style } : {}),
    };
    writeFileSync(mp, dumpMeta(meta), { encoding: "utf8" });
    console.log(
      `  meta.json written (title=${pyReprStr(String(meta.title))}, engine=${engine}, ` +
        `background=${background}, motion=${motion})`,
    );
  } else {
    try {
      const cur = JSON.parse(readFileSync(mp, "utf8")) as {
        tts?: { engine?: string };
        visuals?: { background?: string; motion?: string };
      };
      const eng = cur?.tts?.engine ?? "edge";
      const bg = cur?.visuals?.background ?? DEFAULT_BACKGROUND;
      const mo = cur?.visuals?.motion ?? DEFAULT_MOTION;
      console.log(`  meta.json kept (engine=${eng}, background=${bg}, motion=${mo})`);
    } catch {
      console.log("  meta.json kept (unreadable - left alone)");
    }
  }
  console.log(`ingest done: ${done.length} written, ${skipped.length} already present`);
  return done;
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1]!;
  return null;
}

const USAGE = `ingest.ts - source zip (of .cbz files) -> series/<name>/chN/ page folders.

  npx tsx src/intake/ingest.ts <series> [--chapters 1-5|1,2,3|all] [--force] [--zip PATH]
      [--engine edge|eleven|external] [--voice ID] [--background ID]
      [--motion ID] [--yes] [--title TEXT] [--tts-config-json JSON]
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length < 1) {
    process.stderr.write(USAGE);
    return 1;
  }
  const series = argv[0]!;
  const args = argv.slice(1);
  const spec = argValue(args, "--chapters");
  let zp = argValue(args, "--zip");
  const eng = argValue(args, "--engine");
  const voice = argValue(args, "--voice");
  const bg = argValue(args, "--background");
  const mo = argValue(args, "--motion");
  const titleArg = argValue(args, "--title");
  const ttsRaw = argValue(args, "--tts-config-json");
  const ttsCfg = ttsRaw ? JSON.parse(ttsRaw) as TtsConfig : null;
  zp = zp || findZip(series);
  let idx: ChapterMap<string> | ChapterMap<string[]>;
  try {
    [, idx] = archiveIndex(zp, true);
  } catch (e) {
    if (e instanceof ZipValidationError) throw new SystemExit(e.message);
    throw e;
  }
  ingest(series, {
    chapters: parseChapterSpec(spec, idx),
    force: args.includes("--force"),
    zipPath: zp,
    engine: eng,
    voiceId: voice,
    background: bg,
    motion: mo,
    interactive: !args.includes("--yes"),
    ttsConfig: ttsCfg,
    title: titleArg,
  });
  return 0;
}

export const parse_chapters = parseChapterSpec;
export const validate_zip_archive = validateZipArchive;
export const archive_index = archiveIndex;
export const comic_title = comicTitle;
export const find_zip = findZip;
export const cbz_index = cbzIndex;
export const folder_index = folderIndex;

const isDirect = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    process.exit(main());
  } catch (e) {
    if (e instanceof SystemExit) {
      if (e.message) process.stderr.write(`${e.message}\n`);
      process.exit(typeof e.code === "number" ? e.code : 1);
    }
    throw e;
  }
}
