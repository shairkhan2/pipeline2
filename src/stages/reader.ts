/**
 * Stage 1: READER. Port of pipeline/reader.py.
 *
 * Cache (do not "clean up" — these keys are paid artifacts):
 *   out/panels/<ch>/manifest.json   slicer output. Reuse when manifest.meta.json
 *                                   is slicer_rev 3 and pagesHash matches.
 *   out/batches/<ch>/v<cv>/bNN.json one file per 12-panel batch (v1 stays flat).
 *   out/obs_<ch>.json               assembled chapter. Shared path, stamped with
 *                                   whichever caption version wrote it.
 * Wrapped as {"brief_hash","caption_version","data"}. A v1 file has no
 * caption_version key and is read as v1.
 *
 * page/idx are injected here from the manifest at assembly time. READER_BATCH
 * stays byte-identical so briefHash does not move. An obs file that predates
 * adjacency is rebuilt from cached batches (0 API calls) when every batch is fresh.
 *
 * Judge cache signature is sha256(pyJsonDumps([named, unknown], {sortKeys:true}))[:24].
 * `unknown` stays {} so existing judge_cache.json entries still hit.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { READER_MERGE, readerBatch } from "../contracts/briefs.js";
import {
  batchDir,
  briefHash,
  CAPTION_VERSION,
  pagesHash,
  pyFloatRepr,
  pyJsonDumps,
  pyReprStr,
  pySorted,
  schemaHash,
  SLICER_REV,
  type PyFloatMarker,
} from "../contracts/hashes.js";
import { applyPromoMeta, normBox, normPromoBbox } from "../contracts/schemas.js";
import { needsPositions, panelOrderKey, panelPositions } from "../domain/panels.js";
import {
  call as llmCall,
  FilterBlocked,
  log,
  pageBlocks,
  parseJson,
  type CallOptions,
  type ChatMessage,
  type Completion,
} from "../llm/client.js";
import { pyRound } from "./factCheck.js";
import * as telemetry from "../telemetry/telemetry.js";

export const BATCH = 12;
export const LEDGER_KEEP = 3;

export {
  CAPTION_VERSION,
  schemaHash,
  briefHash,
  batchDir,
  schemaHash as schema_hash,
  briefHash as brief_hash,
  batchDir as batch_dir,
  panelOrderKey,
  panelPositions,
  panelOrderKey as panel_order_key,
  panelPositions as panel_positions,
  needsPositions as _needsPositions,
  needsPositions as _needs_positions,
  normBox,
  normPromoBbox,
  applyPromoMeta,
  normBox as norm_box,
  normPromoBbox as norm_promo_bbox,
  applyPromoMeta as apply_promo_meta,
};

export type SliceChapter = (
  chdir: string,
  outDir: string,
  minArea?: number,
) => Promise<unknown[]> | unknown[];

export interface ReaderDeps {
  sliceChapter?: SliceChapter;
  call?: typeof llmCall;
}

/** Test hook. A cache-hit run must never reach `call`. */
const deps: ReaderDeps = {};
let apiCalls = 0;

export function setReaderDeps(next: ReaderDeps | null): void {
  deps.sliceChapter = next?.sliceChapter;
  deps.call = next?.call;
}

export function _setCallForTests(fn: typeof llmCall | null): void {
  deps.call = fn ?? undefined;
}

export function _apiCallCount(): number {
  return apiCalls;
}

export function _resetApiCalls(): void {
  apiCalls = 0;
}

export interface ChapterObs {
  panels: Array<Record<string, unknown>>;
  characters: Array<Record<string, unknown>>;
  gags: Array<Record<string, unknown>>;
  events: unknown[];
}

type CacheStatus = "ok" | "stale" | "miss";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPyFloat(v: unknown): v is PyFloatMarker {
  return isRecord(v) && Object.prototype.hasOwnProperty.call(v, "__pyFloat__");
}

/** Code-point order. Python str / sorted(). */
function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const as = Array.from(a);
  const bs = Array.from(b);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ca = as[i]!.codePointAt(0)!;
    const cb = bs[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

function cmpList(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpStr(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function pySlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

function pyList(xs: readonly unknown[]): string {
  return `[${xs.map((x) => (typeof x === "string" ? pyReprStr(x) : String(x))).join(", ")}]`;
}

/** Python int(). Throws on a non-integer token so the caller can mark the stamp stale. */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("invalid int");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d+$/.test(s)) throw new Error("invalid int");
    return Number.parseInt(s, 10);
  }
  throw new Error("invalid int");
}

function chapterName(chdir: string): string {
  return basename(chdir.replace(/[/\\]+$/, ""));
}

function stem(file: string): string {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function strOr(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null || v === false) return fallback;
  return String(v);
}

/** Python str.format for `{name}` plus `{{` / `}}`. Single pass. */
function pyFormat(template: string, fields: Record<string, unknown>): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    const next = template[i + 1];
    if (ch === "{" && next === "{") {
      out += "{";
      i++;
      continue;
    }
    if (ch === "}" && next === "}") {
      out += "}";
      i++;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) throw new Error("unmatched '{' in format string");
      const key = template.slice(i + 1, end);
      if (!(key in fields)) throw new Error(`format missing key ${key}`);
      out += formatValue(fields[key]);
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (v == null) return "None";
  if (Array.isArray(v)) {
    return `[${v.map((x) => (typeof x === "string" ? pyReprStr(x) : formatValue(x))).join(", ")}]`;
  }
  return String(v);
}

function jsonQuote(s: string): string {
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
        const u = cp - 0x10000;
        const hi = 0xd800 + (u >> 10);
        const lo = 0xdc00 + (u & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** Python json.dumps(..., indent=1), ensure_ascii=True. No trailing newline. */
function pyJsonPretty(value: unknown, indent = 1): string {
  const render = (v: unknown, level: number): string => {
    const pad = " ".repeat(indent * level);
    const padIn = " ".repeat(indent * (level + 1));
    if (v === null || v === undefined) return "null";
    if (isPyFloat(v)) return pyFloatRepr(v.__pyFloat__);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    if (typeof v === "string") return jsonQuote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => padIn + render(x, level + 1)).join(",\n")}\n${pad}]`;
    }
    if (isRecord(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      return `{\n${keys.map((k) => `${padIn}${jsonQuote(k)}: ${render(v[k], level + 1)}`).join(",\n")}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

function atomicWrite(path: string, text: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

async function llm(messages: ChatMessage[], options: CallOptions = {}): Promise<Completion> {
  apiCalls += 1;
  const fn = deps.call ?? llmCall;
  return fn(messages, options);
}

function isBlockedError(err: unknown): boolean {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const raw = String(err);
  return (
    raw.includes("data_inspection_failed") ||
    s.includes("data_inspection_failed") ||
    raw.includes("inappropriate content") ||
    s.includes("inappropriate content") ||
    raw.toLowerCase().includes("moderation") ||
    s.toLowerCase().includes("moderation") ||
    raw.includes("content_policy") ||
    s.includes("content_policy") ||
    err instanceof FilterBlocked
  );
}

/**
 * Binary-search which panels trip the provider image filter.
 * Returns the set of paths. Port of writer.find_blocked (owned here so the
 * reader rescue path does not import writer).
 */
export async function findBlocked(paths: string[], maxH: number): Promise<Set<string>> {
  const probe = async (ps: string[]): Promise<boolean> => {
    try {
      const blocks = await pageBlocks(ps, maxH);
      await llm(
        [{ role: "user", content: [{ type: "text", text: "Reply OK." }, ...blocks] }],
        { max_tokens: 5, retries: 1, stage: "reader" },
      );
      return false;
    } catch (e) {
      return isBlockedError(e);
    }
  };
  if (paths.length === 0 || !(await probe(paths))) return new Set();
  if (paths.length === 1) return new Set(paths);
  const mid = Math.floor(paths.length / 2);
  const left = await findBlocked(paths.slice(0, mid), maxH);
  const right = await findBlocked(paths.slice(mid), maxH);
  return new Set([...left, ...right]);
}

/** Filter is resolution-dependent. Try alternate encodings before giving up. */
export async function unblock(filePath: string): Promise<number | null> {
  for (const h of [1200, 1400, 1000, 1600]) {
    try {
      const blocks = await pageBlocks([filePath], h);
      await llm(
        [{ role: "user", content: [{ type: "text", text: "Reply OK." }, ...blocks] }],
        { max_tokens: 5, retries: 1, stage: "reader" },
      );
      return h;
    } catch {
      continue;
    }
  }
  return null;
}

export const find_blocked = findBlocked;

/**
 * (data, "ok"|"stale"|"miss"). A file written before caption versioning carries
 * no caption_version key; it is a v1 file and is read as one.
 */
export function _loadCached(path: string, cv: number = CAPTION_VERSION): [unknown, CacheStatus] {
  if (!existsSync(path)) return [null, "miss"];
  let blob: unknown;
  try {
    blob = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [null, "miss"];
  }
  if (isRecord(blob) && "data" in blob && "brief_hash" in blob) {
    if (blob.brief_hash !== briefHash(cv)) return [blob.data, "stale"];
    let ver: number;
    try {
      ver = pyInt(blob.caption_version ?? 1);
    } catch {
      return [blob.data, "stale"];
    }
    if (ver !== cv) return [blob.data, "stale"];
    return [blob.data, "ok"];
  }
  return [blob, "stale"];
}

export function _save(path: string, data: unknown, cv: number = CAPTION_VERSION): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(
    path,
    pyJsonDumps({ brief_hash: briefHash(cv), caption_version: cv, data }, {}),
  );
}

/**
 * True when all n batch caches exist and are fresh. Pure check, no writes.
 */
export function _batchesCached(bdir: string, n: number, cv: number = CAPTION_VERSION): boolean {
  if (!(n > 0)) return false;
  for (let bi = 0; bi < n; bi++) {
    const file = join(bdir, `b${String(bi).padStart(2, "0")}.json`);
    if (_loadCached(file, cv)[1] !== "ok") return false;
  }
  return true;
}

/**
 * I-17: a batch is trustworthy only when returned panel ids are EXACTLY the
 * ones sent. Returns [ok, missing, extra].
 */
export function idAudit(part: unknown, ids: readonly string[]): [boolean, string[], string[]] {
  const rec = isRecord(part) ? part : null;
  const panels = rec && Array.isArray(rec.panels) ? rec.panels : [];
  const got = panels.map((p) => String((isRecord(p) ? p.id : "") ?? "").trim());
  const want = new Set(ids);
  const have = new Set(got);
  const missing = pySorted([...want].filter((id) => !have.has(id)));
  const extra = pySorted([...have].filter((id) => !want.has(id)));
  return [missing.length === 0 && extra.length === 0, missing, extra];
}

/**
 * Named characters only, most recently seen first, capped. UNKNOWN-* tags are
 * the reader's guesses and are never carried forward.
 */
export function castBlock(bible: Record<string, unknown>, limit = 12): string {
  const chars = isRecord(bible.characters) ? bible.characters : {};
  const rows: Array<[string, string, string, string]> = [];
  for (const [k, raw] of Object.entries(chars)) {
    if (k.startsWith("unknown_")) continue;
    if (!isRecord(raw)) continue;
    const nm = strOr(raw.name).trim();
    if (!nm) continue;
    const vis = strOr(raw.visual_now || raw.visual).trim();
    const now = strOr(raw.status).trim();
    rows.push([strOr(raw.last_seen), nm, vis, now]);
  }
  rows.sort((a, b) => {
    const c0 = cmpStr(b[0], a[0]);
    return c0 !== 0 ? c0 : cmpStr(b[1], a[1]);
  });
  const kept = rows.slice(0, limit);
  if (kept.length === 0) return "";
  const lines = kept.map(([seen, nm, vis, now]) => {
    const tail = now ? ` | as of ${seen}: ${now}` : "";
    return `  ${nm}: ${vis}${tail}`;
  });
  return (
    "KNOWN CAST (characters already introduced in earlier chapters - if one of " +
    "them appears, use the NAME given here instead of inventing an UNKNOWN- tag. " +
    "A changed look after 'as of' is the SAME person, not a new one):\n" +
    lines.join("\n")
  );
}

function readCachedManifest(chdir: string, outDir: string): unknown[] | null {
  const ch = chapterName(chdir);
  const pdir = join(outDir, "panels", ch);
  const manPath = join(pdir, "manifest.json");
  const metaPath = join(pdir, "manifest.meta.json");
  if (!existsSync(manPath) || !existsSync(metaPath)) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(meta) || meta.slicer_rev !== SLICER_REV) return null;
  let phash: string;
  try {
    phash = pagesHash(chdir);
  } catch {
    return null;
  }
  if (meta.pages_hash !== phash) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manPath, "utf8"));
  } catch {
    return null;
  }
  return Array.isArray(manifest) ? manifest : null;
}

async function importSliceChapter(): Promise<SliceChapter> {
  const mod = (await import("./slicer.js")) as {
    sliceChapter?: SliceChapter;
    slice_chapter?: SliceChapter;
  };
  const fn = mod.sliceChapter ?? mod.slice_chapter;
  if (!fn) throw new Error("reader: ./slicer.js has no sliceChapter");
  return fn;
}

async function loadManifest(
  chdir: string,
  outDir: string,
  sliceChapterFn?: SliceChapter,
): Promise<unknown[]> {
  const cached = readCachedManifest(chdir, outDir);
  if (cached) return cached;
  const fn = sliceChapterFn ?? deps.sliceChapter ?? (await importSliceChapter());
  const manifest = await fn(chdir, outDir);
  if (!Array.isArray(manifest)) {
    throw new Error("reader: sliceChapter did not return a manifest list");
  }
  return manifest;
}

function batchIds(batch: unknown[]): string[] {
  return batch.map((m) => stem(String(isRecord(m) ? m.panel ?? "" : "")));
}

function stampPanel(p: Record<string, unknown>, pos: Record<string, readonly [number, number]>): void {
  const box = normBox(p.box);
  if (box === null) {
    delete p.box;
  } else {
    p.box = box;
    const fx = p.focus_x;
    if (typeof fx !== "number" || !Number.isFinite(fx)) {
      p.focus_x = pyRound((box.x0 + box.x1) / 2, 4);
    }
  }
  applyPromoMeta(p);
  const id = String(p.id || "").trim();
  const at = pos[id];
  if (at) {
    p.page = at[0];
    p.idx = at[1];
  }
}

/**
 * Panel observations for one chapter dir. Resumable per batch.
 * captionVersion defaults to CAPTION_VERSION (v4). A fresh obs file whose
 * brief_hash matches is returned with 0 API calls.
 */
export async function readChapter(
  chdir: string,
  outDir: string,
  force = false,
  keepStale = false,
  cast: string | null = null,
  captionVersion: number = CAPTION_VERSION,
  sliceChapterFn?: SliceChapter,
): Promise<ChapterObs> {
  const cv = captionVersion;
  const prompt = readerBatch(cv);
  const ch = chapterName(chdir);
  if (force) {
    rmSync(join(outDir, "panels", ch), { recursive: true, force: true });
    rmSync(batchDir(outDir, ch, cv), { recursive: true, force: true });
    const obsPath = join(outDir, `obs_${ch}.json`);
    if (existsSync(obsPath)) unlinkSync(obsPath);
  }
  const manifest = await loadManifest(chdir, outDir, sliceChapterFn);
  const pdir = join(outDir, "panels");
  const assembled = join(outDir, `obs_${ch}.json`);
  const bdir = batchDir(outDir, ch, cv);
  const batches: unknown[][] = [];
  for (let i = 0; i < manifest.length; i += BATCH) batches.push(manifest.slice(i, i + BATCH));
  telemetry.stage(ch, "reader", "running", {
    completed: 0,
    total: batches.length,
    unit: "batches",
    panels: manifest.length,
  });
  if (!force) {
    const [data, status] = _loadCached(assembled, cv);
    if (status === "ok" && data) {
      // Rebuild only when the obs predates adjacency AND every batch is cached.
      // Otherwise a free run must not turn into a paid re-read.
      if (!(needsPositions(data) && _batchesCached(bdir, batches.length, cv))) {
        const n = isRecord(data) && Array.isArray(data.panels) ? data.panels.length : 0;
        console.log(`  cache hit: ${ch} (${n} panels, 0 API calls)`);
        telemetry.stage(ch, "reader", "running", {
          completed: batches.length,
          total: batches.length,
          note: "Cached observations reused",
        });
        return data as ChapterObs;
      }
      console.log(
        `  ${ch}: cached obs has no page/idx -> re-assembling from ` +
          `${batches.length} cached batch(es), 0 API calls`,
      );
    }
    if (status === "stale") {
      const msg = `STALE cache for ${ch}: reader brief changed since it was written`;
      if (keepStale) {
        console.error(`  !! ${msg} (using anyway per --keep-stale)`);
        return data as ChapterObs;
      }
      console.error(`  !! ${msg} -> re-reading`);
    }
  }

  const obs: ChapterObs = { panels: [], characters: [], gags: [], events: [] };
  const pos = panelPositions(manifest);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!;
    telemetry.stage(ch, "reader", "running", { completed: bi, total: batches.length });
    const cache = join(bdir, `b${String(bi).padStart(2, "0")}.json`);
    let [data, status] = _loadCached(cache, cv);
    const ids = batchIds(batch);
    let part: Record<string, unknown> | null = null;
    if (status === "ok" && data) {
      const [ok, miss, extra] = idAudit(data, ids);
      if (ok) {
        console.log(`  batch ${bi + 1}/${batches.length} cached`);
        part = data as Record<string, unknown>;
      } else {
        console.error(
          `  !! batch ${bi + 1} cache POISON (missing ${pyList(miss.slice(0, 3))} extra ${pyList(extra.slice(0, 3))}) -> re-reading`,
        );
        unlinkSync(cache);
        status = "miss";
      }
    }
    if (!(status === "ok" && data && part)) {
      if (status === "stale") {
        console.error(`  !! batch ${bi + 1} stale -> re-reading`);
      }
      const paths = batch.map((m) => join(pdir, String(isRecord(m) ? m.panel ?? "" : "")));
      let content: unknown[] = [
        { type: "text", text: pyFormat(prompt, { ids, ch, cast: cast || "" }) },
      ];
      content.push(...(await pageBlocks(paths)));
      part = null;
      const temps = [0.2, 0.0];
      for (let attempt = 0; attempt < temps.length; attempt++) {
        const temp = temps[attempt]!;
        let r: Completion;
        try {
          r = await llm([{ role: "user", content }], {
            max_tokens: 8000,
            temperature: temp,
            tag: `reader ${ch} b${bi + 1}`,
            lane: "vision",
            stage: "reader",
          });
        } catch (e) {
          if (!(e instanceof FilterBlocked)) throw e;
          const blocked = await findBlocked(paths, 1200);
          const keep: string[] = [];
          const rescue: Array<[string, number]> = [];
          const tOnly: string[] = [];
          for (const p of paths) {
            if (!blocked.has(p)) {
              keep.push(p);
              continue;
            }
            const h = await unblock(p);
            if (h) rescue.push([p, h]);
            else tOnly.push(p);
          }
          console.error(
            `  reader ${ch} b${bi + 1}: ${blocked.size} filtered panel(s) -> ` +
              `${rescue.length} re-encoded, ${tOnly.length} transcript-only`,
          );
          content = [{ type: "text", text: pyFormat(prompt, { ids, ch, cast: cast || "" }) }];
          content.push(...(await pageBlocks(keep, 1200)));
          for (const [p, h] of rescue) content.push(...(await pageBlocks([p], h)));
          for (const p of tOnly) {
            const pid = stem(p);
            content.push({
              type: "text",
              text:
                `[${pid}: image withheld by provider filter - describe from ` +
                `surrounding panels only; mark art:0.1]`,
            });
          }
          r = await llm([{ role: "user", content }], {
            max_tokens: 8000,
            temperature: temp,
            tag: `reader ${ch} b${bi + 1} rescued`,
            lane: "vision",
            stage: "reader",
          });
        }
        try {
          const parsed = parseJson(String(r.choices[0]?.message?.content ?? ""));
          const rec = isRecord(parsed) ? parsed : {};
          const hasPanels = Array.isArray(rec.panels) && rec.panels.length > 0;
          const [ok, miss, extra] = hasPanels ? idAudit(rec, ids) : [false, [...ids], []];
          if (ok) {
            part = rec;
            break;
          }
          console.error(
            `  !! batch ${ids[0]}..${ids[ids.length - 1]} id mismatch ` +
              `(missing ${pyList(miss.slice(0, 3))} extra ${pyList(extra.slice(0, 3))}); retry`,
          );
          log(`IDMISMATCH ${ch} b${bi + 1} attempt=${attempt + 1} missing=${pyList(miss)} extra=${pyList(extra)}`);
          part = null;
        } catch (e) {
          console.error(
            `  !! batch ${ids[0]}..${ids[ids.length - 1]} unparseable (${e}); retry`,
          );
          log(`PARSEFAIL ${ch} b${bi + 1} attempt=${attempt + 1}: ${e}`);
          part = null;
        }
      }
      if (!part || !Array.isArray(part.panels) || part.panels.length === 0) {
        throw new Error(
          `reader: batch ${ch} b${bi + 1} failed twice (unparseable or mislabeled); rerun resumes here`,
        );
      }
      _save(cache, part, cv);
      const tag = cv !== 1 ? ` [captions v${cv}]` : "";
      console.log(
        `  batch ${bi + 1}/${batches.length} read (${ids[0]}..${ids[ids.length - 1]})${tag}`,
      );
    }
    telemetry.stage(ch, "reader", "running", { completed: bi + 1, total: batches.length });
    const panels = Array.isArray(part.panels) ? part.panels : [];
    for (const p of panels) {
      if (!isRecord(p)) continue;
      stampPanel(p, pos);
    }
    for (const k of ["panels", "characters", "gags", "events"] as const) {
      const extra = part[k];
      if (extra === undefined) continue;
      if (!Array.isArray(extra)) throw new TypeError(`reader: ${k} is not a list`);
      if (k === "events") obs.events.push(...extra);
      else (obs[k] as unknown[]).push(...extra);
    }
  }
  const got = new Set(obs.panels.map((p) => String(p.id)));
  const expect = new Set(manifest.map((m) => stem(String(isRecord(m) ? m.panel ?? "" : ""))));
  const lost = pySorted([...expect].filter((id) => !got.has(id)));
  if (lost.length > 0) {
    throw new Error(`reader ${ch}: panels ${pyList(lost.slice(0, 5))} missing after assembly; rerun resumes`);
  }
  const noPos = obs.panels.filter((p) => !("page" in p) || !("idx" in p)).map((p) => String(p.id));
  if (noPos.length > 0) {
    throw new Error(
      `reader ${ch}: ${noPos.length} panel(s) lost page/idx ` +
        `(e.g. ${pyList(noPos.slice(0, 5))}); manifest/slicer mismatch, rerun with --force`,
    );
  }
  _save(assembled, obs, cv);
  return obs;
}

/**
 * I-27: an alias names exactly one character. A contested real name merges
 * (evidence quality, never alias count). A contested UNKNOWN-* guess is dropped
 * from the weaker entry. Returns the notes.
 */
export function enforceAliasUniqueness(bible: Record<string, unknown>, verbose = true): string[] {
  const notes: string[] = [];
  const chars = bible.characters;
  if (!isRecord(chars)) throw new TypeError("bible.characters is not a dict");

  const evidence = (s: string): [number, number, string] => {
    const c = chars[s];
    const rec = isRecord(c) ? c : {};
    const seen = rec.last_seen && rec.last_seen === rec.first_seen ? 1 : 2;
    return [-_seenRank(rec), seen, s];
  };
  const cmpEv = (a: [number, number, string], b: [number, number, string]): number => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return cmpStr(a[2], b[2]);
  };

  for (let pass = 0; pass < 8; pass++) {
    const owner: Record<string, string[]> = {};
    for (const [s, raw] of Object.entries(chars)) {
      const aliases = isRecord(raw) && Array.isArray(raw.aliases) ? raw.aliases : [];
      for (const a of aliases) {
        const key = String(a).toLowerCase();
        (owner[key] ??= []).push(s);
      }
    }
    for (const [s, raw] of Object.entries(chars)) {
      if (!isRecord(raw)) continue;
      const al = Array.isArray(raw.aliases) ? raw.aliases : [];
      const keep = al.filter((a) => slug(String(a)) !== s);
      if (keep.length !== al.length) raw.aliases = keep;
    }
    const contested: Record<string, string[]> = {};
    for (const [a, slugs] of Object.entries(owner)) {
      if (new Set(slugs).size > 1) contested[a] = slugs;
    }
    if (Object.keys(contested).length === 0) break;
    const real: Record<string, string[]> = {};
    for (const [a, slugs] of Object.entries(contested)) {
      if (!a.startsWith("unknown")) real[a] = slugs;
    }
    const pool = Object.keys(real).length > 0 ? real : contested;
    const entries = Object.entries(pool).sort((x, y) => {
      const c = cmpStr(x[0], y[0]);
      return c !== 0 ? c : cmpList(x[1], y[1]);
    });
    const [a, rawSlugs] = entries[0]!;
    const slugs = pySorted([...new Set(rawSlugs)]);
    if (Object.keys(real).length > 0) {
      let keep = slugs[0]!;
      let best = evidence(keep);
      for (const s of slugs.slice(1)) {
        const ev = evidence(s);
        if (cmpEv(ev, best) > 0) {
          keep = s;
          best = ev;
        }
      }
      for (const loserSlug of slugs) {
        if (loserSlug === keep) continue;
        const kc = chars[keep];
        if (!isRecord(kc)) continue;
        const loser = chars[loserSlug];
        delete chars[loserSlug];
        if (!isRecord(loser)) continue;
        const merged = [
          ...(Array.isArray(kc.aliases) ? kc.aliases.map(String) : []),
          String(loser.name ?? ""),
          ...(Array.isArray(loser.aliases) ? loser.aliases.map(String) : []),
        ];
        kc.aliases = pySorted([...new Set(merged)]);
        if (!kc.visual && loser.visual) kc.visual = loser.visual;
        if (loser.first_seen) {
          const cur = kc.first_seen || loser.first_seen;
          kc.first_seen = cmpStr(String(cur), String(loser.first_seen)) <= 0 ? cur : loser.first_seen;
        }
        const links = Array.isArray(bible.links) ? bible.links : [];
        bible.links = links.filter((l) => !(isRecord(l) && l.who === loser.name));
        (bible.links as unknown[]).push({
          who: kc.name,
          alias: loser.name,
          evidence: `I-27 merge: contested name '${a}' on both entries`,
        });
        notes.push(`MERGED ${String(loser.name)} -> ${String(kc.name)} (both claimed '${a}')`);
      }
      continue;
    }
    let drop = slugs[0]!;
    const dropKey = (s: string): [number, number, string] => {
      const c = chars[s];
      const n = isRecord(c) && Array.isArray(c.aliases) ? c.aliases.length : 0;
      return [n, _seenRank(isRecord(c) ? c : {}), s];
    };
    const cmpDrop = (x: [number, number, string], y: [number, number, string]): number => {
      if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
      if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
      return cmpStr(x[2], y[2]);
    };
    let worst = dropKey(drop);
    for (const s of slugs.slice(1)) {
      const k = dropKey(s);
      if (cmpDrop(k, worst) < 0) {
        drop = s;
        worst = k;
      }
    }
    const victim = chars[drop];
    if (isRecord(victim) && Array.isArray(victim.aliases)) {
      victim.aliases = victim.aliases.filter((x) => String(x).toLowerCase() !== a);
    }
    const others = slugs.filter((s) => s !== drop).join(", ");
    const name = isRecord(victim) ? String(victim.name) : drop;
    notes.push(`DROPPED guess '${a}' from ${name} (also claimed by ${others})`);
  }
  if (verbose) {
    for (const n of notes) console.log(`  bible: ${n}`);
  }
  return notes;
}

/** Earlier first_seen is a larger (less negative) rank only after negation at the call site. Missing sorts last. */
export function _seenRank(c: Record<string, unknown>): number {
  const digits = String(c.first_seen || "9999").replace(/\D/g, "");
  const n = Number.parseInt(digits || "9999", 10);
  return -n;
}

/**
 * Deterministic fold. LLM only for alias judgment, and only on a judge-cache miss.
 * Signature uses pyJsonDumps([named, {}], {sortKeys:true}) so an existing
 * judge_cache.json entry hits and bills nothing.
 */
export async function mergeBible(
  biblePath: string,
  ch: string,
  obs: { characters?: unknown; events?: unknown; gags?: unknown },
): Promise<Record<string, unknown>> {
  let bible: Record<string, unknown>;
  if (existsSync(biblePath)) {
    bible = JSON.parse(readFileSync(biblePath, "utf8")) as Record<string, unknown>;
  } else {
    bible = { characters: {}, plot_ledger: [], links: [] };
  }
  if (!isRecord(bible.characters)) bible.characters = {};
  if (!Array.isArray(bible.plot_ledger)) bible.plot_ledger = [];
  if (!Array.isArray(bible.links)) bible.links = [];

  bible.plot_ledger = (bible.plot_ledger as unknown[]).filter(
    (e) => !(isRecord(e) && e.ch === ch),
  );
  const priorGags = Array.isArray(bible.gags) ? bible.gags : [];
  bible.gags = priorGags.filter((g) => !(isRecord(g) && g.ch === ch));

  let droppedUnknown = 0;
  const characters = bible.characters as Record<string, Record<string, unknown>>;
  const incoming = Array.isArray(obs.characters) ? obs.characters : [];
  for (const raw of incoming) {
    if (!isRecord(raw)) continue;
    const name = strOr(raw.name).trim();
    if (!name) continue;
    const s = slug(name);
    if (s.startsWith("unknown")) {
      droppedUnknown += 1;
      continue;
    }
    if (s in characters) {
      const e = characters[s]!;
      e.last_seen = ch;
      if (raw.visual) {
        e.visual_now = raw.visual;
        if (!e.visual) e.visual = raw.visual;
      }
      if (raw.what_they_do) e.status = raw.what_they_do;
    } else {
      const visual = strOr(raw.visual);
      const role = strOr(raw.what_they_do);
      characters[s] = {
        name,
        aliases: [],
        visual,
        visual_now: visual,
        role,
        status: role,
        first_seen: ch,
        last_seen: ch,
      };
    }
  }
  if (droppedUnknown) {
    console.log(
      `   bible: ignored ${droppedUnknown} UNKNOWN-* sighting(s) ` +
        `(named-only rule; they stay in obs_${ch}.json)`,
    );
  }
  (bible.plot_ledger as unknown[]).push({ ch, events: obs.events });
  const cov = Array.isArray(bible.covered) ? [...(bible.covered as string[])] : [];
  if (!cov.includes(ch)) cov.push(ch);
  bible.covered = cov.sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10));
  const ledger = bible.plot_ledger as Array<Record<string, unknown>>;
  ledger.sort((a, b) => cmpStr(String(a.ch), String(b.ch)));
  if (LEDGER_KEEP >= 0) {
    bible.plot_ledger = LEDGER_KEEP ? ledger.slice(-LEDGER_KEEP) : [];
  }
  const gags = bible.gags as unknown[];
  const obsGags = Array.isArray(obs.gags) ? obs.gags : [];
  for (const g of obsGags) {
    if (isRecord(g)) gags.push({ ...g, ch });
    else gags.push(g);
  }
  if (LEDGER_KEEP >= 0) {
    const keepCh = new Set(
      (bible.plot_ledger as Array<Record<string, unknown>>).map((e) => e.ch),
    );
    bible.gags = LEDGER_KEEP
      ? gags.filter((g) => isRecord(g) && keepCh.has(g.ch))
      : [];
  }

  const named: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(characters)) {
    if (k.startsWith("unknown")) continue;
    named[k] = v.visual;
  }
  // Kept empty on purpose: half of the judge cache signature. Do not drop it.
  const unknown: Record<string, never> = {};
  const namedKeys = Object.keys(named);
  if (namedKeys.length > 1) {
    const cj = join(dirname(biblePath), "judge_cache.json");
    let jcache: Record<string, unknown> = {};
    try {
      const loaded = JSON.parse(readFileSync(cj, "utf8"));
      if (isRecord(loaded)) jcache = loaded;
    } catch {
      jcache = {};
    }
    const sig = createHash("sha256")
      .update(pyJsonDumps([named, unknown], { sortKeys: true }), "utf8")
      .digest("hex")
      .slice(0, 24);
    let verdict: Record<string, unknown> = {};
    if (sig in jcache) {
      console.log("   judge: cache hit (inputs unchanged since the call)");
      verdict = isRecord(jcache[sig]) ? (jcache[sig] as Record<string, unknown>) : {};
    } else {
      const prompt = pyFormat(READER_MERGE, { ch, named: pyJsonPretty(named, 1) });
      try {
        const r = await llm(
          [{ role: "user", content: [{ type: "text", text: prompt }] }],
          {
            max_tokens: 1500,
            temperature: 0.1,
            tag: `judge ${ch}`,
            timeout: 150,
            retries: 1,
            lane: "vision",
          },
        );
        const parsed = parseJson(String(r.choices[0]?.message?.content ?? ""));
        verdict = isRecord(parsed) ? parsed : {};
        jcache[sig] = verdict;
        atomicWrite(cj, pyJsonPretty(jcache, 1));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  !! judge call failed (${msg}); keeping bible unmerged`);
        log(`JUDGEFAIL ${ch}: ${msg}`);
      }
    }
    const groups = Array.isArray(verdict.alias_groups) ? verdict.alias_groups : [];
    for (const grp of groups) {
      if (!Array.isArray(grp) || grp.length === 0) continue;
      const head = grp[0];
      for (const x of grp.slice(1)) {
        const sa = slug(String(head));
        const sb = slug(String(x));
        if (sa in characters && sb in characters) {
          const loser = characters[sb]!;
          delete characters[sb];
          const keep = characters[sa]!;
          const aliases = [
            ...(Array.isArray(keep.aliases) ? keep.aliases.map(String) : []),
            String(loser.name ?? ""),
            ...(Array.isArray(loser.aliases) ? loser.aliases.map(String) : []),
          ];
          keep.aliases = pySorted([...new Set(aliases)]);
          const links = Array.isArray(bible.links) ? bible.links : [];
          bible.links = links.filter((l) => !(isRecord(l) && l.who === loser.name));
          (bible.links as unknown[]).push({
            who: keep.name,
            alias: loser.name,
            evidence: "alias group from judge",
          });
        }
      }
    }
    const resolve = isRecord(verdict.resolve) ? verdict.resolve : {};
    for (const [uk, target] of Object.entries(resolve)) {
      const sk = slug(uk);
      const st = slug(String(target));
      if (sk === st) continue;
      if (sk in characters && st in characters) {
        const loser = characters[sk]!;
        delete characters[sk];
        const keep = characters[st]!;
        const aliases = [
          ...(Array.isArray(keep.aliases) ? keep.aliases.map(String) : []),
          String(loser.name ?? ""),
        ];
        keep.aliases = pySorted([...new Set(aliases)]);
        if (!Array.isArray(bible.links)) bible.links = [];
        (bible.links as unknown[]).push({
          who: target,
          matched_unknown: uk,
          evidence: "visual match from judge",
        });
      }
    }
  }
  const notes = enforceAliasUniqueness(bible);
  if (!isRecord(bible.merge_log)) bible.merge_log = {};
  (bible.merge_log as Record<string, unknown>)[ch] = notes;
  atomicWrite(biblePath, pyJsonPretty(bible, 1));
  return bible;
}

export const read_chapter = readChapter;
export const merge_bible = mergeBible;
export const cast_block = castBlock;
export const _load_cached = _loadCached;
export const enforce_alias_uniqueness = enforceAliasUniqueness;
export const id_audit = idAudit;
export const _seen_rank = _seenRank;
export const _batches_cached = _batchesCached;
