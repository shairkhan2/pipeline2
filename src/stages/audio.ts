/**
 * audio.ts - port of gskbin.py, say.py, audio_check.py, and the TTS half of timeline.py.
 *
 * gsk() routes through gskr when present. narration/synth speak a script with edge-tts.
 * sweep() is the ASR drift check (SequenceMatcher ratio >= 0.7, name-exempt).
 * ttsLines / ttsLinesEleven / ttsLinesExternal write per-line mp3s with I-24 sidecars.
 *
 * Cache-key formulas live in contracts/hashes.ts. Do not reimplement them here.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pyRound } from "./factCheck.js";
import {
  externalCachePayload,
  lineProofToken,
  narrationCacheKey,
  pyFloat,
  pyFloatRepr,
  pyJsonDumps,
  pyReprStr,
  parsePyJson,
  type ExternalTtsConfig,
} from "../contracts/hashes.js";
import { stageCurrent } from "../telemetry/telemetry.js";
import { failureNote, httpStatusOf, retryableHttpStatus } from "../domain/failure.js";
import {
  findVertexTtsVoice,
  GEMINI_LOCALE_REQUEST_REV,
  isDefaultVertexLocale,
  localizedSpeechText,
  stripEmotionControls,
  synthesizeVertexTtsToFile,
} from "../llm/vertexTts.js";
import { findGrokTtsVoice, synthesizeGrokTtsToFile } from "../llm/grokTts.js";

export type { ExternalTtsConfig };

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export const VOICE = "en-US-AndrewMultilingualNeural";
export const RATE = "+6%";
export const TRANS_CACHE = ".asr_cache";

const ROTATOR = join(homedir(), "genspark-rotation/gskr");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Repo-local virtualenv, then the container-wide TTS install. */
const REPO_VENV = join(REPO_ROOT, ".venv", "bin");
/** Sibling v1 checkout venv, used when this repo has no local .venv. */
const SIBLING_VENV = resolve(REPO_ROOT, "..", "manhwa-pipeline", ".venv", "bin");

const PY_WS = "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

function pyLstrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+`), "");
}

/** Python open() universal newlines: \\n, \\r\\n, \\r. No extra trailing empty line kept. */
function splitUniversal(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|\n|\r/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") return pyReprStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj).map((k) => `${pyReprStr(k)}: ${pyRepr(obj[k])}`).join(", ")}}`;
  }
  return String(v);
}

function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expanduser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

function run(
  cmd: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: "utf8",
    timeout: opts.timeout,
    env: opts.env,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: (r.error as NodeJS.ErrnoException | undefined) ?? undefined,
  };
}

function raiseSpawn(error: NodeJS.ErrnoException, what: string): never {
  if (error.code === "ETIMEDOUT") {
    const e = new Error(`${what} timed out`);
    e.name = "TimeoutExpired";
    throw e;
  }
  if (error.code === "ENOENT") {
    const e = new Error(`spawn ${what} ENOENT`);
    e.name = "FileNotFoundError";
    throw e;
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    const e = new Error(`spawn ${what} EACCES`);
    e.name = "PermissionError";
    throw e;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// gskbin.py
// ---------------------------------------------------------------------------

/** Route every gsk call through the gskr key rotator when present. */
export function gsk(...args: string[]): string[] {
  let b = process.env.GSK_BIN || "";
  if (!b) b = which("gskr") ?? "";
  if (!b) b = executable(ROTATOR) ? ROTATOR : "gsk";
  return [b, ...args];
}

// ---------------------------------------------------------------------------
// say.py
// ---------------------------------------------------------------------------

/** Strip headers, blank lines, and @p tags. Spoken text only. */
export function narration(path: string): string {
  const out: string[] = [];
  for (const l of splitUniversal(readFileSync(path, "utf8"))) {
    if (!pyStrip(l) || pyLstrip(l).startsWith("#")) continue;
    out.push(pyStrip(l.replace(/@p\d+/g, "")));
  }
  return out.join(" ");
}

let edgeCmdCache: { mode: "python" | "cli"; bin: string } | null = null;

function resolveEdge(): { mode: "python" | "cli"; bin: string } {
  if (edgeCmdCache) return edgeCmdCache;
  const candidates = [
    process.env.EDGE_TTS_PYTHON,
    process.env.MANHWA_PYTHON,
    "/opt/tts/bin/python",
    join(REPO_VENV, "python"),
    join(SIBLING_VENV, "python"),
    which("python3"),
    "python3",
  ].filter((p): p is string => Boolean(p));
  const seen = new Set<string>();
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (bin !== "python3" && bin.includes("/") && !existsSync(bin)) continue;
    const r = run([bin, "-c", "import edge_tts"], { timeout: 30_000 });
    if (!r.error && r.status === 0) {
      edgeCmdCache = { mode: "python", bin };
      return edgeCmdCache;
    }
  }
  const cli = which("edge-tts")
    ?? (executable(join(REPO_VENV, "edge-tts"))
      ? join(REPO_VENV, "edge-tts")
      : executable(join(SIBLING_VENV, "edge-tts"))
        ? join(SIBLING_VENV, "edge-tts")
        : "edge-tts");
  edgeCmdCache = { mode: "cli", bin: cli };
  return edgeCmdCache;
}

const EDGE_PY = `
import asyncio, json, sys, edge_tts
req = json.loads(sys.stdin.read())
async def main():
    await edge_tts.Communicate(req["text"], req["voice"], rate=req["rate"]).save(req["path"])
asyncio.run(main())
`;

/**
 * Convert a numeric TTS speed into the edge-tts rate string (`+10%`, `-5%`).
 * A non-finite or missing speed keeps the caller's fallback rate.
 */
export function edgeRateFromSpeed(speed: unknown, fallback: string = RATE): string {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return fallback;
  if (Math.abs(speed - 1) < 1e-9) return fallback;
  const pct = Math.round((speed - 1) * 100);
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct)}%`;
}

/**
 * Edge rate for a LANGUAGE version at speed 1.
 *
 * The English pipeline's legacy default is `+6%` (RATE), which is an English
 * pacing choice. A localized version must speak at the rate the Studio preview
 * used for the same voice, and that preview maps speed 1 to `+0%`. Keeping the
 * two identical means a preview sounds like the final render.
 */
export const LOCALE_EDGE_RATE = "+0%";

/**
 * Remove inline delivery controls (`[deadpan]`, `[whispers]`, ...) from text
 * that is about to be spoken by a voice that cannot perform them.
 *
 * Edge and Vertex TTS read brackets literally, so a localized render must speak
 * the prose only. The STORED script keeps its controls: this only shapes the
 * synthesis input. The implementation lives beside the Vertex synthesizer so
 * every engine shares one tag shape; it is re-exported here for the audio stage
 * and its existing importers.
 */
export { stripEmotionControls };
export { stripEmotionControls as _stripEmotionControls };
function edgeSaveOnce(text: string, outPath: string, voice: string = VOICE, rate: string = RATE): void {  const edge = resolveEdge();
  if (edge.mode === "python") {
    const r = run([edge.bin, "-c", EDGE_PY], {
      timeout: 180_000,
      input: pyJsonDumps({ text, voice, rate, path: outPath }, { ensureAscii: false }),
    });
    if (r.error) raiseSpawn(r.error, edge.bin);
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || `rc=${r.status}`).trim();
      throw new RuntimeError(detail || `edge-tts rc=${r.status}`);
    }
    return;
  }
  const tf = join(tmpdir(), `edge-text-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
  try {
    writeFileSync(tf, text, "utf8");
    const r = run(
      [edge.bin, "--voice", voice, "--rate", rate, "--file", tf, "--write-media", outPath, "--no-progress"],
      { timeout: 180_000 },
    );
    if (r.error) raiseSpawn(r.error, edge.bin);
    if (r.status !== 0) {
      throw new RuntimeError((r.stderr || r.stdout || `edge-tts rc=${r.status}`).trim());
    }
  } finally {
    try { unlinkSync(tf); } catch { /* already gone */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * I-18: edge flakes (NoAudioReceived) on good lines. Three tries, backoff 2s/4s/6s.
 */
export async function _edgeLine(
  text: string,
  f: string,
  tries = 3,
  voice: string = VOICE,
  rate: string = RATE,
): Promise<void> {
  let last: unknown = null;
  for (let a = 0; a < tries; a++) {
    try {
      edgeSaveOnce(text, f, voice, rate);
      if (existsSync(f) && statSync(f).size > 500) return;
      const n = existsSync(f) ? statSync(f).size : 0;
      throw new RuntimeError(`edge produced ${n} bytes`);
    } catch (e) {
      last = e;
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
      await sleep(2000 * (a + 1));
    }
  }
  throw new RuntimeError(`edge-tts line failed x${tries}: ${last}`);
}

/** Speak path into mp3. Returns the spoken character count (Python len). */
export async function synth(path: string, mp3: string): Promise<number> {
  const text = narration(path);
  edgeSaveOnce(text, mp3);
  return Array.from(text).length;
}

// ---------------------------------------------------------------------------
// difflib.SequenceMatcher(None, a, b).ratio()
// ---------------------------------------------------------------------------

/**
 * Python difflib.SequenceMatcher(None, a, b).ratio().
 * autojunk is on (popular chars drop only when len(b) >= 200). isjunk is None.
 * Compared as code points, matching Python str indexing.
 */
export function sequenceMatcherRatio(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const la = A.length;
  const lb = B.length;
  if (la + lb === 0) return 1.0;
  const matches = matchingSize(A, B);
  return (2.0 * matches) / (la + lb);
}

function matchingSize(A: string[], B: string[]): number {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < B.length; i++) {
    const elt = B[i]!;
    let idxs = b2j.get(elt);
    if (!idxs) {
      idxs = [];
      b2j.set(elt, idxs);
    }
    idxs.push(i);
  }
  if (B.length >= 200) {
    const ntest = Math.floor(B.length / 100) + 1;
    for (const [elt, idxs] of [...b2j.entries()]) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }
  const blocks: Array<[number, number, number]> = [];
  const queue: Array<[number, number, number, number]> = [[0, A.length, 0, B.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longestMatch(A, B, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let i1 = 0, j1 = 0, k1 = 0;
  let total = 0;
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) total += k1;
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) total += k1;
  return total;
}

function longestMatch(
  A: string[],
  B: string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const idxs = b2j.get(A[i]!) ?? [];
    for (const j of idxs) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  while (
    besti > alo && bestj > blo &&
    A[besti - 1] === B[bestj - 1]
  ) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi && bestj + bestsize < bhi &&
    A[besti + bestsize] === B[bestj + bestsize]
  ) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

// ---------------------------------------------------------------------------
// audio_check.py
// ---------------------------------------------------------------------------

function normWords(t: string): string[] {
  let s = t.toLowerCase().replaceAll("\u2019", "'").replaceAll("\u2018", "'");
  s = s.replace(/[^a-z0-9' ]+/g, " ");
  return s.split(/[ \t\n\r\f\v]+/).filter((w) => w !== "");
}

function sim(a: string, b: string): number {
  return sequenceMatcherRatio(a, b);
}

/** gsk ASR, cached by sha256 of the file bytes (24 hex chars). */
export function transcribe(path: string, cacheDir: string): { text: string } {
  mkdirSync(cacheDir, { recursive: true });
  const key = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 24) + ".json";
  const cf = join(cacheDir, key);
  if (existsSync(cf)) {
    return JSON.parse(readFileSync(cf, "utf8")) as { text: string };
  }
  const up = run(gsk("upload", path), { timeout: 120_000 });
  if (up.error) raiseSpawn(up.error, "gsk upload");
  const m = /https:\/\/[^\s"]+/.exec(up.stdout);
  if (!m) {
    throw new RuntimeError(`gsk upload failed: ${up.stdout.slice(0, 120)}${up.stderr.slice(0, 120)}`);
  }
  const tr = run(gsk("transcribe", "-i", m[0]), { timeout: 300_000 });
  if (tr.error) raiseSpawn(tr.error, "gsk transcribe");
  const parsed = parsePyJson(pyLstrip(tr.stdout)) as { data?: Record<string, { segments?: string }> };
  const data = parsed?.data;
  if (!data || typeof data !== "object") {
    throw new RuntimeError(`gsk transcribe failed: ${tr.stdout.slice(0, 120)}${tr.stderr.slice(0, 120)}`);
  }
  const first = Object.values(data)[0];
  const seg = typeof first?.segments === "string" ? first.segments : "";
  const text = seg
    .split(/\r\n|\n|\r/)
    .filter((l) => pyStrip(l))
    .map((l) => l.replace(/^[\d.]+-[\d.]+:[ \t]*/, ""))
    .join(" ");
  writeFileSync(cf, pyJsonDumps({ text }, {}));
  return { text };
}

export interface DriftWord {
  want: string;
  got: string;
}

/**
 * Word-diff every produced line file against its script text.
 * Returns {index: drift words} for lines with errors. Tags stripped before compare.
 */
export function sweep(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  names: readonly string[] = [],
  engine = "eleven",
  outDir?: string | null,
): Record<number, DriftWord[]> {
  const cacheDir = join(outDir || tmpdirPath, TRANS_CACHE, engine);
  const exempt = new Set<string>();
  for (const n of names) {
    for (const w of normWords(n)) exempt.add(w);
  }
  const bad: Record<number, DriftWord[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]![0];
    const f = join(tmpdirPath, `line_${String(i).padStart(3, "0")}.mp3`);
    if (!existsSync(f)) continue;
    const want = normWords(text.toLowerCase().replace(/\[[a-z0-9 _-]+\]/g, " "));
    let heard: string[];
    try {
      heard = normWords(transcribe(f, cacheDir).text);
    } catch (e) {
      const msg = String(e).slice(0, 80);
      console.error(`  audio_check: line ${i} ASR failed (${msg}) - skipping`);
      continue;
    }
    const drift: DriftWord[] = [];
    let j = 0;
    for (const w of want) {
      if (j >= heard.length) break;
      const h = heard[j]!;
      if (h === w || sim(h, w) >= 0.7 || exempt.has(w) || exempt.has(h)) {
        j += 1;
        continue;
      }
      if (j + 1 < heard.length && (heard[j + 1] === w || sim(heard[j + 1]!, w) >= 0.7)) {
        j += 1;
        continue;
      }
      drift.push({ want: w, got: h });
      j += 1;
    }
    if (drift.length) bad[i] = drift;
  }
  return bad;
}

// ---------------------------------------------------------------------------
// timeline.py TTS helpers
// ---------------------------------------------------------------------------

/** Strip outer silence only. Interior pauses survive. */
export function _trimSilence(f: string, env: NodeJS.ProcessEnv = process.env): void {
  const tmp = f + ".trim.mp3";
  const r = run(
    ["ffmpeg", "-v", "error", "-y", "-i", f, "-af",
      "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-32dB:"
      + "stop_periods=-1:stop_duration=0.25:stop_threshold=-32dB", tmp],
    { timeout: 120_000, env },
  );
  if (!r.error && r.status === 0 && existsSync(tmp) && statSync(tmp).size >= 600) {
    // os.replace
    renameSync(tmp, f);
  } else if (existsSync(tmp)) {
    unlinkSync(tmp);
  }
}

/** Finite ffprobe duration in seconds (> 0), or 0 when missing/invalid. */
export function _probeDuration(path: string): number {
  if (!path || !existsSync(path)) return 0;
  try {
    if (statSync(path).size <= 0) return 0;
  } catch {
    return 0;
  }
  try {
    const r = run(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { timeout: 30_000 },
    );
    if (r.error || r.status !== 0) return 0;
    const d = Number.parseFloat(pyStrip(r.stdout) || "0");
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

/** POSIX shlex.split. Quotes stripped, backslash escapes outside quotes. */
export function shlexSplit(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
  while (i < n) {
    while (i < n && isWs(s[i]!)) i++;
    if (i >= n) break;
    let token = "";
    let quote: "'" | '"' | null = null;
    while (i < n) {
      const c = s[i]!;
      if (quote === null) {
        if (c === "'" || c === '"') {
          quote = c;
          i++;
          continue;
        }
        if (c === "\\") {
          i++;
          if (i < n) token += s[i++]!;
          continue;
        }
        if (isWs(c)) break;
        token += c;
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      if (quote === '"' && c === "\\") {
        i++;
        if (i >= n) break;
        const e = s[i]!;
        if (e === "\\" || e === '"' || e === "$" || e === "`" || e === "\n") token += e;
        else token += "\\" + e;
        i++;
        continue;
      }
      token += c;
      i++;
    }
    out.push(token);
  }
  return out;
}

/** Normalize an external TTS command into a non-empty argv list. Never a shell string. */
export function _parseExternalCommand(raw: unknown): string[] {
  let argv: string[] = [];
  if (Array.isArray(raw)) {
    argv = raw.map((x) => String(x).trim()).filter((x) => x !== "");
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) {
      argv = [];
    } else if (s.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        throw new ValueError(`invalid JSON command array: ${e}`);
      }
      if (!Array.isArray(parsed)) throw new ValueError("JSON command must be a list of strings");
      argv = parsed.map((x) => String(x).trim()).filter((x) => x !== "");
    } else {
      argv = shlexSplit(s);
    }
  }
  if (argv.length === 0) {
    throw new ValueError("meta.json says engine=external but tts.command / MANHWA_TTS_COMMAND is empty");
  }
  return argv;
}

function isBlankCommand(raw: unknown): boolean {
  if (raw == null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function pyInt(v: unknown): number {
  if (typeof v === "boolean") {
    throw new TypeError("int() argument must be a string, a bytes-like object or a real number, not 'bool'");
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValueError(`invalid literal for int(): ${v}`);
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d+$/.test(s)) throw new ValueError(`invalid literal for int() with base 10: ${pyReprStr(s)}`);
    return Number.parseInt(s, 10);
  }
  throw new TypeError(`int() argument must be a string or a real number, not '${typeof v}'`);
}

/**
 * Validate external TTS settings from meta['tts'] + env.
 * Requires explicit voice_id and command. No silent fallback.
 */
export function _resolveExternalTtsConfig(
  meta: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ExternalTtsConfig {
  const m = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {};
  const voiceRaw = m.voice_id;
  if (typeof voiceRaw !== "string" || !voiceRaw.trim()) {
    throw new ValueError("meta.json says engine=external but voice_id is empty - shair sets the voice");
  }
  const voiceId = voiceRaw.trim();
  let rawCmd = m.command;
  if (isBlankCommand(rawCmd)) rawCmd = env.MANHWA_TTS_COMMAND ?? "";
  const cmd = _parseExternalCommand(rawCmd);
  const provider = String(
    m.provider || env.MANHWA_TTS_PROVIDER || basenameOf(cmd[cmd.length - 1]!),
  ).trim();
  const revRaw = m.revision !== undefined && m.revision !== null
    ? m.revision
    : (env.MANHWA_TTS_REVISION || "1");
  const revision = String(revRaw).trim();
  const language = String(m.language || env.MANHWA_TTS_LANGUAGE || "en").trim();
  const rawSpeed = m.speed !== undefined && m.speed !== null
    ? m.speed
    : (env.MANHWA_TTS_SPEED || 1.0);
  let speed: number;
  try {
    speed = typeof rawSpeed === "number" ? rawSpeed : Number(rawSpeed);
    if (typeof rawSpeed === "string" && rawSpeed.trim() === "") throw new Error("empty");
    if (typeof rawSpeed !== "number" && typeof rawSpeed !== "string") throw new Error("type");
    if (typeof rawSpeed === "string" && Number.isNaN(speed)) throw new Error("nan");
  } catch (e) {
    throw new ValueError(`invalid tts.speed ${pyRepr(rawSpeed)}`);
  }
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ValueError(`tts.speed must be > 0, got ${pyRepr(speed)}`);
  }
  const style = String(m.style || env.MANHWA_TTS_STYLE || "").trim();
  let settings = m.settings;
  if (settings === undefined || settings === null) settings = {};
  if (typeof settings !== "object" || Array.isArray(settings)) {
    throw new ValueError("tts.settings must be a JSON object");
  }
  return {
    engine: "external",
    provider,
    revision,
    command: cmd,
    voice_id: voiceId,
    language,
    speed: pyRound(speed, 4),
    style,
    settings: settings as Record<string, unknown>,
  };
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function _externalCachePayload(cfg: ExternalTtsConfig): string {
  return externalCachePayload(cfg);
}

export function _narrationCacheKey(
  lines: ReadonlyArray<readonly [string, readonly string[]]>,
  engine: string,
  voiceId: unknown,
  extCfg?: ExternalTtsConfig,
  speed?: number,
): string {
  return narrationCacheKey(lines, engine, voiceId as string | number, extCfg, speed);
}

export function _lineProofToken(text: string, extCfg?: ExternalTtsConfig): string {
  return lineProofToken(text, extCfg);
}

/**
 * I-24: a cached line mp3 is reusable only if its .txt sidecar proves this exact
 * text (and provider config for external TTS). Stale files are deleted.
 * Returns [mp3Path, sidecarPath].
 */
export function _lineFile(
  tmpdirPath: string,
  i: number,
  text: string,
  proof?: string | null,
): [string, string] {
  const expected = proof == null ? text : proof;
  const f = join(tmpdirPath, `line_${String(i).padStart(3, "0")}.mp3`);
  const side = f.slice(0, -4) + ".txt";
  if (existsSync(f)) {
    let stale = true;
    try {
      stale = readFileSync(side, "utf8") !== expected;
    } catch {
      /* no sidecar = unproven = stale */
    }
    if (stale) {
      unlinkSync(f);
      if (existsSync(side)) unlinkSync(side);
    }
  } else if (existsSync(side)) {
    unlinkSync(side);
  }
  return [f, side];
}

function loadGskKey(env: NodeJS.ProcessEnv): string {
  let key = env.GSK_API_KEY ?? "";
  if (!key) {
    const p = expanduser(env.PIPELINE_ENV || "~/.hermes/.env");
    try {
      const text = readFileSync(p, "utf8");
      for (const line of text.split("\n")) {
        if (line.startsWith("GSK_API_KEY=")) {
          key = line.slice("GSK_API_KEY=".length).trim();
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return env.GSK_API_KEY || key || "";
}

function popenDuration(f: string): number {
  const r = run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
    { timeout: 30_000 },
  );
  const raw = pyStrip(r.stdout || "");
  if (!raw) return 0;
  const d = Number.parseFloat(raw);
  if (!Number.isFinite(d)) {
    throw new Error(`could not convert string to float: '${raw}'`);
  }
  return d;
}

/**
 * ElevenLabs v3 via GSK, one call per line. Emotion tags ride in the prompt.
 * voiceId is a GSK preset name or a raw elevenlabs voice id. Pipeline never picks it.
 * outPrefix is unused (kept so the Python signature stays).
 */
export async function ttsLinesEleven(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  voiceId: string,
  _outPrefix = "eleven",
): Promise<Array<[number, number]>> {
  mkdirSync(tmpdirPath, { recursive: true });
  const spans: Array<[number, number]> = [];
  let t = 0;
  const env: NodeJS.ProcessEnv = { ...process.env, GSK_API_KEY: loadGskKey(process.env) };
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]![0]);
    const [f, side] = _lineFile(tmpdirPath, i, text);
    if (!existsSync(f) || statSync(f).size < 600) {
      const pid = voiceId.length >= 16 && !voiceId.includes(" ")
        ? { custom_voice_id: voiceId, output_format: "mp3_44100_128" }
        : { speaker: voiceId, output_format: "mp3_44100_128" };
      const af = join(tmpdir(), `gsk-args-${process.pid}-${randomBytes(6).toString("hex")}.json`);
      writeFileSync(af, pyJsonDumps(
        { prompt: text, model: "elevenlabs/v3-tts", params: pid },
        {},
      ));
      let r: RunResult;
      try {
        r = run(gsk("audio", "--args-file", af, "-o", f), { timeout: 300_000, env });
      } finally {
        try { unlinkSync(af); } catch { /* ignore */ }
      }
      if (r.error) raiseSpawn(r.error, "gsk audio");
      if (!(existsSync(f) && statSync(f).size >= 600)) {
        const m = /"audio_urls":\s*\[\s*"([^"]+)"/.exec(r.stdout);
        if (m) {
          const dl = run(gsk("download", "-o", f, m[1]!), { timeout: 180_000, env });
          if (!(existsSync(f) && statSync(f).size >= 600)) {
            const mu = /https?:\/\/\S+/.exec(dl.stdout);
            if (mu) {
              run(["curl", "-sfL", "-o", f, mu[0]], { timeout: 180_000 });
            }
          }
        }
      }
      if (!existsSync(f) || statSync(f).size < 600) {
        if (existsSync(f)) unlinkSync(f);
        const tail = (r.stdout + r.stderr).slice(-240);
        throw new RuntimeError(`gsk audio line ${i} failed: rc=${r.status} ${tail}`);
      }
      _trimSilence(f, env);
      writeFileSync(side, text, "utf8");
    }
    const d = popenDuration(f);
    spans.push([t, t + d]);
    t += d;
    stageCurrent("audio", "running", { completed: i + 1, total: lines.length, unit: "lines" });
  }
  return spans;
}

function invocationFailed(i: number, error: NodeJS.ErrnoException): never {
  const code = error.code;
  if (code === "ETIMEDOUT") throw new RuntimeError(`external tts line ${i} invocation failed: timeout`);
  if (code === "ENOENT") throw new RuntimeError(`external tts line ${i} invocation failed: executable not found`);
  if (code === "EACCES" || code === "EPERM") {
    throw new RuntimeError(`external tts line ${i} invocation failed: permission denied`);
  }
  throw new RuntimeError(`external tts line ${i} invocation failed: ${error.name || "Error"}`);
}

/**
 * Generic external TTS via subprocess argv (no shell) + JSON on stdin.
 * Validates every file with ffprobe (duration > 0) before committing the cache.
 * Does not trim silence.
 */
export async function ttsLinesExternal(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  meta: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<Array<[number, number]>> {
  const cfg = _resolveExternalTtsConfig(meta, env ?? process.env);
  mkdirSync(tmpdirPath, { recursive: true });
  const spans: Array<[number, number]> = [];
  let t = 0;
  const runEnv = env ?? process.env;
  const timeout = pyInt(
    Object.prototype.hasOwnProperty.call(cfg.settings, "timeout") ? cfg.settings.timeout : 180,
  );
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]![0]);
    const proof = _lineProofToken(text, cfg);
    const [f, side] = _lineFile(tmpdirPath, i, text, proof);
    let d = existsSync(f) ? _probeDuration(f) : 0;
    if (d <= 0) {
      if (existsSync(f)) unlinkSync(f);
      if (existsSync(side)) unlinkSync(side);
      const tmpOut = join(tmpdirPath, `.line_${String(i).padStart(3, "0")}.${process.pid}.tmp.mp3`);
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
      const req = {
        protocol: "manhwa-tts-v1",
        line_index: i,
        text,
        output_path: resolve(tmpOut),
        voice_id: cfg.voice_id,
        language: cfg.language,
        speed: pyFloat(cfg.speed),
        style: cfg.style,
        provider: cfg.provider,
        revision: cfg.revision,
        settings: cfg.settings,
      };
      const payload = pyJsonDumps(req, { ensureAscii: false });
      let r: RunResult;
      try {
        r = run(cfg.command, { input: payload, timeout: timeout * 1000, env: runEnv });
      } catch (e) {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
        const name = (e as Error).name || "Error";
        throw new RuntimeError(`external tts line ${i} invocation failed: ${name}`);
      }
      if (r.error) {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
        invocationFailed(i, r.error);
      }
      if (r.status !== 0) {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
        throw new RuntimeError(`external tts line ${i} failed: rc=${r.status}`);
      }
      d = _probeDuration(tmpOut);
      if (d <= 0) {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
        throw new RuntimeError(
          `external tts line ${i} produced invalid audio (ffprobe duration=${pyFloatRepr(d)})`,
        );
      }
      renameSync(tmpOut, f);
      writeFileSync(side, proof, "utf8");
    }
    spans.push([t, t + d]);
    t += d;
    stageCurrent("audio", "running", { completed: i + 1, total: lines.length, unit: "lines" });
  }
  return spans;
}

/** Retry only the unfinished provider line; callers commit its cache after validation. */
async function synthesizeLineWithRetry(
  engine: string, i: number, total: number, tmpOut: string, env: NodeJS.ProcessEnv,
  synthesize: () => Promise<unknown>,
): Promise<number> {
  const override = env.MANHWA_TTS_RETRY_DELAYS_S;
  const parsed = override?.split(",").map((s) => Number(s.trim()));
  const delays = parsed?.length && parsed.every((n) => Number.isFinite(n) && n >= 0)
    ? parsed : [10, 20, 40, 80, 150];
  // Ops overrides may lower the waits but never to a zero-delay burst on a rate limit.
  if (parsed?.length && delays === parsed && !process.env.VITEST) delays.forEach((d, k) => { delays[k] = Math.max(1, d); });
  let invalidFailures = 0;
  for (let attempt = 0; ; attempt++) {
    let providerError: unknown;
    if (existsSync(tmpOut)) unlinkSync(tmpOut);
    stageCurrent("audio", "running", { completed: i, total, unit: "lines", note: "Synthesizing narration" });
    try {
      try { await synthesize(); }
      catch (e) {
        providerError = e;
        throw new RuntimeError(`${engine} tts line ${i} failed: ${(e as Error).message || String(e)}`);
      }
      const duration = _probeDuration(tmpOut);
      if (duration <= 0) throw new RuntimeError(
        `${engine} tts line ${i} produced invalid audio (ffprobe duration=${pyFloatRepr(duration)})`,
      );
      return duration;
    } catch (error) {
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
      const text = `${(providerError as Error | undefined)?.name ?? ""}: ${String(error)}`;
      const status = httpStatusOf(text);
      if (status !== null && !retryableHttpStatus(status)) throw error;
      const invalid = /missing inline audio data|returned empty audio|invalid audio.*ffprobe duration/i.test(text);
      if (invalid) invalidFailures++;
      const transient = status !== null ? retryableHttpStatus(status)
        : /timeout|timed out|network|connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i.test(text);
      if (attempt >= delays.length || (!transient && !invalid) || (invalid && invalidFailures > 2)) throw error;
      const delay = delays[attempt]!;
      const note = failureNote(providerError ?? error);
      const maxAttempts = invalid
        ? Math.min(delays.length + 1, attempt + 1 + (3 - invalidFailures))
        : delays.length + 1;
      stageCurrent("audio", "retrying", {
        note, retryAt: Date.now() / 1000 + delay, attempt: attempt + 1,
        maxAttempts,
      });
      console.log(`   audio: ${engine} line ${i} retry ${attempt + 1}/${maxAttempts} in ${delay}s: ${note}`);
      await sleep(delay * 1000);
    }
  }
}

/**
 * Vertex AI TTS (Chirp 3 HD / Gemini 3.8 Flash TTS), one file per line.
 * Validates every file with ffprobe before committing the cache, like the
 * external adapter path, so a bad API answer never poisons narration.mp3.
 */
export async function ttsLinesVertex(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  meta: unknown,
  env?: NodeJS.ProcessEnv,
  localeHint?: string | null,
): Promise<Array<[number, number]>> {
  const m = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {};
  const voiceId = typeof m.voice_id === "string" ? m.voice_id.trim() : "";
  if (!voiceId) {
    throw new ValueError("meta.json says engine=vertex but voice_id is empty - shair sets the voice");
  }
  const runEnv = env ?? process.env;
  // Optional locale-scoped lookup: an English/unset language keeps the original
  // catalog (and its cache file); a localized language sees only its own voices.
  //
  // The RUN locale (from timeline.main, already validated and used for the
  // narration cache key) wins over `meta.language`, so the voice lookup, the
  // per-line proof and the cache key can never disagree.
  const hint = typeof localeHint === "string" ? localeHint.trim() : "";
  const rawLanguage = hint || (typeof m.language === "string" ? m.language.trim() : "");
  const locale = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(rawLanguage) ? rawLanguage : null;
  const voice = findVertexTtsVoice(voiceId, runEnv, locale);
  if (!voice) {
    throw new ValueError(`Voice '${voiceId}' is not a Vertex AI TTS voice`);
  }
  const rawSpeed = m.speed !== undefined && m.speed !== null ? m.speed : 1;
  const speed = Number(rawSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ValueError(`tts.speed must be > 0, got ${pyRepr(rawSpeed)}`);
  }
  mkdirSync(tmpdirPath, { recursive: true });
  const spans: Array<[number, number]> = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i]![0]);
    // A localized take speaks prose only: Vertex reads bracket controls
    // literally. The stored script keeps its controls; only synthesis input
    // changes, exactly like the locale Edge path.
    const text = locale ? localizedSpeechText(raw) : raw;
    // English keeps the historical proof byte-for-byte. A localized proof also
    // carries the locale and the resolved model, so a Hindi take can never prove
    // an English line (or another model's line) even for a shared voice id.
    // A localized Gemini line additionally carries the request revision: takes
    // cached while the request still held an instruction wrapper are re-synthesized.
    // English (`en`/`en-US`, which a plain English series stores in meta.language)
    // never carried the wrapper, so its proof must stay byte-identical.
    const geminiRev = locale && !isDefaultVertexLocale(locale) && voice.engine === "gemini"
      ? GEMINI_LOCALE_REQUEST_REV
      : null;
    const proof = pyJsonDumps(
      locale
        ? {
          text: raw,
          tts: {
            engine: "vertex",
            voice: voiceId,
            speed: pyFloat(pyRound(speed, 4)),
            language: locale,
            model: voice.modelId,
            ...(geminiRev === null ? {} : { request_rev: geminiRev }),
          },
        }
        : { text, tts: { engine: "vertex", voice: voiceId, speed: pyFloat(pyRound(speed, 4)) } },
      { sortKeys: true },
    );
    const [f, side] = _lineFile(tmpdirPath, i, raw, proof);
    let d = existsSync(f) ? _probeDuration(f) : 0;
    if (d <= 0) {
      if (existsSync(f)) unlinkSync(f);
      if (existsSync(side)) unlinkSync(side);
      const tmpOut = join(tmpdirPath, `.line_${String(i).padStart(3, "0")}.${process.pid}.tmp.mp3`);
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
      d = await synthesizeLineWithRetry("vertex", i, lines.length, tmpOut, runEnv, async () => {
        await synthesizeVertexTtsToFile({
          text,
          voiceId,
          destPath: tmpOut,
          speed,
          env: runEnv,
          ...(locale ? { locale } : {}),
        });
      });
      renameSync(tmpOut, f);
      writeFileSync(side, proof, "utf8");
    }
    spans.push([t, t + d]);
    t += d;
    stageCurrent("audio", "running", { completed: i + 1, total: lines.length, unit: "lines" });
  }
  return spans;
}

/**
 * xAI / Grok subscription TTS, one file per line. Same per-line cache proof and
 * ffprobe validation as the Vertex path, so a bad API answer never poisons
 * narration.mp3.
 */
export async function ttsLinesGrok(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  meta: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<Array<[number, number]>> {
  const m = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {};
  const voiceId = typeof m.voice_id === "string" ? m.voice_id.trim() : "";
  if (!voiceId) {
    throw new ValueError("meta.json says engine=grok but voice_id is empty - shair sets the voice");
  }
  const runEnv = env ?? process.env;
  if (!findGrokTtsVoice(voiceId, runEnv)) {
    throw new ValueError(`Voice '${voiceId}' is not a Grok TTS voice`);
  }
  const rawSpeed = m.speed !== undefined && m.speed !== null ? m.speed : 1;
  const speed = Number(rawSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ValueError(`tts.speed must be > 0, got ${pyRepr(rawSpeed)}`);
  }
  mkdirSync(tmpdirPath, { recursive: true });
  const spans: Array<[number, number]> = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]![0]);
    const proof = pyJsonDumps(
      { text, tts: { engine: "grok", voice: voiceId, speed: pyFloat(pyRound(speed, 4)) } },
      { sortKeys: true },
    );
    const [f, side] = _lineFile(tmpdirPath, i, text, proof);
    let d = existsSync(f) ? _probeDuration(f) : 0;
    if (d <= 0) {
      if (existsSync(f)) unlinkSync(f);
      if (existsSync(side)) unlinkSync(side);
      const tmpOut = join(tmpdirPath, `.line_${String(i).padStart(3, "0")}.${process.pid}.tmp.mp3`);
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
      d = await synthesizeLineWithRetry("grok", i, lines.length, tmpOut, runEnv, async () => {
        await synthesizeGrokTtsToFile({
          text,
          voiceId,
          destPath: tmpOut,
          speed,
          env: runEnv,
        });
      });
      renameSync(tmpOut, f);
      writeFileSync(side, proof, "utf8");
    }
    spans.push([t, t + d]);
    t += d;
    stageCurrent("audio", "running", { completed: i + 1, total: lines.length, unit: "lines" });
  }
  return spans;
}

/**
 * edge-tts, one file per line. Returns [spans, concatListPath, totalSeconds].
 *
 * With `locale` set this is a language-version render: inline delivery controls
 * (`[deadpan]`, ...) are stripped from the SPOKEN text, because Edge reads
 * brackets literally. The stored script keeps its controls; only the synthesis
 * input changes. English (no locale) is untouched.
 */
export async function ttsLines(
  lines: ReadonlyArray<readonly [string, unknown]>,
  tmpdirPath: string,
  opts?: { voice?: string; rate?: string; locale?: string | null },
): Promise<[Array<[number, number]>, string, number]> {
  mkdirSync(tmpdirPath, { recursive: true });
  const voice = opts?.voice || VOICE;
  const rate = opts?.rate || RATE;
  // A locale tag scopes the per-line proof: a Hindi take can never prove an
  // English line (and vice versa) even if the same voice id were reused. Absent
  // locale keeps the original proof string byte-for-byte.
  const localeTag = opts?.locale ? `${opts.locale}|strip-v1|` : "";
  const spans: Array<[number, number]> = [];
  const files: string[] = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i]![0]);
    const text = opts?.locale ? localizedSpeechText(raw) : raw;
    // The sidecar proves the exact text AND voice/rate: a cached line from a
    // previous voice must not be reused after the series voice changes.
    const proof = `${localeTag}${voice}|${rate}|${raw}`;
    const [f, side] = _lineFile(tmpdirPath, i, raw, proof);
    if (!(existsSync(f) && statSync(f).size > 500)) {
      await _edgeLine(text, f, 3, voice, rate);
      writeFileSync(side, proof, "utf8");
    }
    const d = popenDuration(f);
    spans.push([t, t + d]);
    t += d;
    files.push(f);
    stageCurrent("audio", "running", { completed: i + 1, total: lines.length, unit: "lines" });
  }
  const lst = join(tmpdirPath, "concat.txt");
  writeFileSync(lst, files.map((f) => `file '${resolve(f)}'`).join("\n"));
  return [spans, lst, t];
}

/** ffmpeg concat demuxer, copy codec. Throws when ffmpeg fails or writes an empty file. */
export function ttsConcat(lst: string, mp3Path: string): void {
  const r = run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", mp3Path]);
  if (r.error || r.status !== 0 || !existsSync(mp3Path) || statSync(mp3Path).size === 0) {
    const detail = (r.stderr || r.stdout || `rc=${r.status}`).trim().slice(0, 240);
    throw new RuntimeError(`ffmpeg concat failed: ${detail}`);
  }
}

export const gsk_bin = gsk;
export {
  _trimSilence as _trim_silence,
  _probeDuration as _probe_duration,
  _parseExternalCommand as _parse_external_command,
  _resolveExternalTtsConfig as _resolve_external_tts_config,
  _externalCachePayload as _external_cache_payload,
  _narrationCacheKey as _narration_cache_key,
  _lineProofToken as _line_proof_token,
  _lineFile as _line_file,
  _edgeLine as _edge_line,
  ttsLinesEleven as tts_lines_eleven,
  ttsLinesExternal as tts_lines_external,
  ttsLinesVertex as tts_lines_vertex,
  ttsLinesGrok as tts_lines_grok,
  ttsLines as tts_lines,
  ttsConcat as tts_concat,
};
