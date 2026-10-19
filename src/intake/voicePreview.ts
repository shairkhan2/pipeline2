/**
 * voicePreview.ts - server-side TTS voice preview samples.
 *
 * Port of pipeline/voice_preview.py. Callers cannot supply text. The JSON
 * contract is exactly {id, duration, cached}. Paths, effective config, and
 * credentials are never returned.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  externalCachePayload,
  parsePyJson,
  pyFloat,
  pyJsonDumps,
  type ExternalTtsConfig,
} from "../contracts/hashes.js";
import {
  IntakeError,
  PreflightError,
  atomicWriteJson,
  ensureDir,
  jobsDir,
  matchOwner,
  resolveTtsSelection,
  sanitizeLine,
  shlexSplit,
  type Env,
} from "./intake.js";
import { flockFd, tryFlockFd } from "../locks/seriesLock.js";
import { findVertexTtsVoice, synthesizeVertexTtsToFile } from "../llm/vertexTts.js";
import { findGrokTtsVoice, synthesizeGrokTtsToFile } from "../llm/grokTts.js";

export const SAMPLE_TEXT =
  "She thought the danger had passed. Then the gate opened again, " +
  "and this time, someone was waiting for her.";

export const PREVIEW_DIR_NAME = "voice-previews";
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const GENERATION_TIMEOUT_S = 90;
export const COOLDOWN_S = 10.0;

/** Pipeline narration voice/rate. Matches timeline.py VOICE / RATE. */
export const EDGE_VOICE = "en-US-AndrewMultilingualNeural";
export const EDGE_RATE = "+6%";

export class PreviewError extends IntakeError {
  constructor(message: string, statusCode = 400) {
    super(message, statusCode);
    this.name = "PreviewError";
  }
}

export class PreviewBusyError extends PreviewError {
  constructor(message: string) {
    super(message, 429);
    this.name = "PreviewBusyError";
  }
}

export class PreviewCooldownError extends PreviewError {
  constructor(message: string) {
    super(message, 429);
    this.name = "PreviewCooldownError";
  }
}

export interface PreviewResult {
  id: string;
  duration: number;
  cached: boolean;
}

function resolveEnv(env?: Env): Env {
  return env ?? process.env;
}

export function previewDir(env?: Env): string {
  return path.join(jobsDir(env), PREVIEW_DIR_NAME);
}

function ensurePreviewDir(env?: Env): string {
  return ensureDir(previewDir(env), jobsDir(env));
}

function lockPath(env?: Env): string {
  return path.join(previewDir(env), "generate.lock");
}

function cooldownPath(env?: Env): string {
  return path.join(previewDir(env), "cooldown.json");
}

export function cacheKey(configPayload: string): string {
  let cfg: unknown;
  try {
    JSON.parse(configPayload);
    cfg = parsePyJson(configPayload);
  } catch {
    throw new PreviewError("Invalid TTS configuration for preview");
  }
  const raw = pyJsonDumps(
    { sample: SAMPLE_TEXT, config: cfg },
    { sortKeys: true, separators: [",", ":"], ensureAscii: false },
  );
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function finiteSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new PreviewError("invalid tts.speed");
  return Math.round(n * 10000) / 10000;
}

function resolveExternalConfig(meta: Record<string, unknown>, env?: Env): ExternalTtsConfig {
  const e = resolveEnv(env);
  const voiceId = meta.voice_id;
  if (typeof voiceId !== "string" || !voiceId.trim()) {
    throw new PreviewError("external TTS voice_id is empty");
  }
  let rawCmd = meta.command;
  if (rawCmd == null || rawCmd === "" || (Array.isArray(rawCmd) && rawCmd.length === 0)) {
    rawCmd = e.MANHWA_TTS_COMMAND || "";
  }
  let cmd: string[] = [];
  if (Array.isArray(rawCmd)) cmd = rawCmd.map((x) => String(x).trim()).filter((x) => x);
  else if (typeof rawCmd === "string") {
    const s = rawCmd.trim();
    if (s.startsWith("[")) {
      const parsed = JSON.parse(s) as unknown;
      if (!Array.isArray(parsed)) throw new PreviewError("JSON command must be a list of strings");
      cmd = parsed.map((x) => String(x).trim()).filter((x) => x);
    } else if (s) {
      cmd = shlexSplit(s);
    }
  }
  if (cmd.length === 0) throw new PreviewError("external TTS command is empty");
  const provider = String(meta.provider || e.MANHWA_TTS_PROVIDER || path.basename(cmd[cmd.length - 1]!)).trim();
  const revision = String(meta.revision != null ? meta.revision : e.MANHWA_TTS_REVISION || "1").trim();
  const language = String(meta.language || e.MANHWA_TTS_LANGUAGE || "en").trim();
  const speed = finiteSpeed(meta.speed != null ? meta.speed : e.MANHWA_TTS_SPEED || 1);
  const style = String(meta.style || e.MANHWA_TTS_STYLE || "").trim();
  const settings = meta.settings == null ? {} : meta.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new PreviewError("tts.settings must be a JSON object");
  }
  return {
    engine: "external",
    provider,
    revision,
    command: cmd,
    voice_id: voiceId.trim(),
    language,
    speed,
    style,
    settings: settings as Record<string, unknown>,
  };
}

interface EffectiveConfig {
  engine: string;
  voiceId: string;
  metaTts: Record<string, unknown> | null;
  payload: string;
}

async function effectiveConfig(
  providerId: string,
  voiceId: string,
  env?: Env,
  preflight = false,
): Promise<EffectiveConfig> {
  const sel = await resolveTtsSelection(providerId, voiceId, undefined, env, preflight);
  if (sel.engine === "edge") {
    if (String(sel.voiceId).toLowerCase() !== EDGE_VOICE.toLowerCase()) {
      throw new IntakeError("Edge previews are only available for the pipeline narration voice");
    }
    const cfg = {
      engine: "edge",
      provider: "edge",
      revision: String((sel.metaTts && sel.metaTts.revision) || "1"),
      voice: EDGE_VOICE,
      rate: EDGE_RATE,
    };
    return {
      engine: "edge",
      voiceId: String(sel.voiceId),
      metaTts: null,
      payload: pyJsonDumps(cfg, { sortKeys: true, separators: [",", ":"], ensureAscii: false }),
    };
  }
  if (sel.engine === "vertex") {
    const vertexVoice = findVertexTtsVoice(String(sel.voiceId), resolveEnv(env) as NodeJS.ProcessEnv);
    if (!vertexVoice) {
      throw new PreviewError(`Voice '${sel.voiceId}' is not a Vertex AI TTS voice`);
    }
    const effectiveSpeed = finiteSpeed(sel.metaTts?.speed != null ? sel.metaTts.speed : 1);
    const cfg = {
      engine: "vertex",
      provider: "vertex",
      revision: String((sel.metaTts && sel.metaTts.revision) || "1"),
      voice: vertexVoice.id,
      // A speed change must not reuse the previous preview file.
      speed: String(effectiveSpeed),
    };
    return {
      engine: "vertex",
      voiceId: vertexVoice.id,
      metaTts: { ...(sel.metaTts || {}) },
      payload: pyJsonDumps(cfg, { sortKeys: true, separators: [",", ":"], ensureAscii: false }),
    };
  }
  if (sel.engine === "grok") {
    const envRec = resolveEnv(env) as NodeJS.ProcessEnv;
    const grokVoice = findGrokTtsVoice(String(sel.voiceId), envRec);
    if (!grokVoice) {
      throw new PreviewError(`Voice '${sel.voiceId}' is not a Grok TTS voice`);
    }
    const effectiveSpeed = finiteSpeed(sel.metaTts?.speed != null ? sel.metaTts.speed : 1);
    const cfg = {
      engine: "grok",
      provider: "grok",
      revision: String((sel.metaTts && sel.metaTts.revision) || "1"),
      voice: grokVoice.id,
      // A speed change must not reuse the previous preview file.
      speed: String(effectiveSpeed),
    };
    return {
      engine: "grok",
      voiceId: grokVoice.id,
      metaTts: { ...(sel.metaTts || {}) },
      payload: pyJsonDumps(cfg, { sortKeys: true, separators: [",", ":"], ensureAscii: false }),
    };
  }
  const meta: Record<string, unknown> = { ...(sel.metaTts || {}) };
  const settings = { ...((meta.settings as Record<string, unknown> | undefined) || {}) };
  settings.timeout = GENERATION_TIMEOUT_S;
  meta.settings = settings;
  const cfg = resolveExternalConfig(meta, env);
  return {
    engine: "external",
    voiceId: cfg.voice_id,
    metaTts: meta,
    payload: externalCachePayload(cfg),
  };
}

export function probeMp3(filePath: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return 0;
  }
  const size = stat.size;
  if (!stat.isFile() || size <= 0 || size > MAX_PREVIEW_BYTES) return 0;
  try {
    const r = spawnSyncSafe(
      ["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", filePath],
      30_000,
    );
    if (r.code !== 0) return 0;
    const fmt = ((JSON.parse(r.stdout || "{}") as { format?: Record<string, unknown> }).format) || {};
    const name = String(fmt.format_name || "").toLowerCase();
    const d = Number(fmt.duration || 0);
    if (!name.includes("mp3") || !Number.isFinite(d) || d <= 0) return 0;
    return d;
  } catch {
    return 0;
  }
}

function spawnSyncSafe(cmd: string[], timeoutMs: number, input?: string, env?: Env): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    env: env ? stringifyEnv(env) : process.env,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: 124, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function stringifyEnv(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

function cacheFile(cacheId: string, env?: Env): string {
  return path.join(previewDir(env), `${cacheId}.mp3`);
}

function readCache(cacheId: string, env?: Env): number | null {
  const f = cacheFile(cacheId, env);
  const duration = probeMp3(f);
  if (duration > 0) return duration;
  if (fs.existsSync(f)) {
    try {
      fs.unlinkSync(f);
    } catch {
      // leave a broken file rather than throw
    }
  }
  return null;
}

function acquireGenerationLock(env?: Env): number {
  ensurePreviewDir(env);
  const lp = lockPath(env);
  const fd = fs.openSync(lp, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o664);
  matchOwner(lp, jobsDir(env));
  if (!tryFlockFd(fd, "ex", true)) {
    try {
      fs.closeSync(fd);
    } catch {
      // already failing
    }
    throw new PreviewBusyError("A voice preview is already being generated; try again shortly");
  }
  return fd;
}

function releaseGenerationLock(fd: number): void {
  try {
    flockFd(fd, "un");
  } catch {
    // close drops the lock
  }
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

function cooldownRemaining(env?: Env): number {
  try {
    const data = JSON.parse(fs.readFileSync(cooldownPath(env), "utf8")) as { lastUncachedAt?: number };
    const last = Number(data?.lastUncachedAt || 0);
    return Math.max(0, COOLDOWN_S - (Date.now() / 1000 - last));
  } catch {
    return 0;
  }
}

function markCooldown(env?: Env): void {
  atomicWriteJson(cooldownPath(env), { lastUncachedAt: Date.now() / 1000 }, jobsDir(env));
}

function installAudio(src: string, dest: string, env?: Env): number {
  let size = 0;
  try {
    size = fs.statSync(src).size;
  } catch {
    throw new PreviewError("Voice preview produced no audio");
  }
  if (size <= 0) throw new PreviewError("Voice preview produced empty audio");
  if (size > MAX_PREVIEW_BYTES) throw new PreviewError("Voice preview audio exceeds the 4 MiB cap");
  const duration = probeMp3(src);
  if (duration <= 0) throw new PreviewError("Voice preview produced invalid audio");
  fs.renameSync(src, dest);
  matchOwner(dest, jobsDir(env));
  return duration;
}

function runCollected(
  cmd: string[],
  opts: { timeoutMs: number; input?: string; env?: Env; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? stringifyEnv(opts.env) : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    // The child may exit before the input is written; swallow EPIPE so it never
    // surfaces as an unhandled 'error' event on stdin.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        error,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
  });
}

async function generateEdge(dest: string, env?: Env): Promise<number> {
  const dir = ensurePreviewDir(env);
  const tmpdir = fs.mkdtempSync(path.join(dir, ".gen-"));
  const tmp = path.join(tmpdir, "preview.mp3");
  try {
    const edgeBin = commandOnPath("edge-tts", env);
    let ran = false;
    if (edgeBin) {
      const r = await runCollected(
        [edgeBin, `--voice=${EDGE_VOICE}`, `--rate=${EDGE_RATE}`, `--text=${SAMPLE_TEXT}`, `--write-media=${tmp}`],
        { timeoutMs: GENERATION_TIMEOUT_S * 1000, env },
      );
      if (r.timedOut) throw new PreviewError("Voice preview generation timed out");
      if (r.code === 0 && fs.existsSync(tmp)) ran = true;
    }
    if (!ran) {
      const e = resolveEnv(env);
      const script =
        "import asyncio,sys,edge_tts\n" +
        "text,voice,rate,dest=sys.argv[1:5]\n" +
        "async def main():\n" +
        "    await edge_tts.Communicate(text, voice, rate=rate).save(dest)\n" +
        "asyncio.run(main())\n";
      const explicitCandidates = [e.EDGE_TTS_PYTHON, e.MANHWA_PIPELINE_PYTHON].filter(
        (p): p is string => Boolean(p && p.trim() && (p === "python3" || !p.includes("/") || fs.existsSync(p))),
      );
      const candidates =
        explicitCandidates.length > 0
          ? [...explicitCandidates, "python3"]
          : [
              "/opt/tts/bin/python",
              path.resolve(".venv", "bin", "python"),
              path.resolve("..", "manhwa-pipeline", ".venv", "bin", "python"),
              "python3",
            ];
      const seen = new Set<string>();
      for (const py of candidates) {
        if (seen.has(py)) continue;
        seen.add(py);
        if (py !== "python3" && py.includes("/") && !fs.existsSync(py)) continue;
        const r = await runCollected([py, "-c", script, SAMPLE_TEXT, EDGE_VOICE, EDGE_RATE, tmp], {
          timeoutMs: GENERATION_TIMEOUT_S * 1000,
          env,
        });
        if (r.timedOut) throw new PreviewError("Voice preview generation timed out");
        if (r.code === 0 && fs.existsSync(tmp)) {
          ran = true;
          break;
        }
      }
      if (!ran) {
        throw new PreviewError("Voice preview generation failed: edge-tts is not available");
      }
    }
    return installAudio(tmp, dest, env);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

function commandOnPath(name: string, env?: Env): string | null {
  const resolved = resolveEnv(env);
  const pathEnv = resolved.PATH || process.env.PATH || "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      const st = fs.statSync(cand);
      if (st.isFile() && (st.mode & 0o111)) return cand;
    } catch {
      continue;
    }
  }
  // PATH often lacks the repo venv (systemd/docker units, jobs spawned without
  // env.sh). Only consult the well-known install locations when the caller did
  // not pin an interpreter explicitly, so an explicit pin is never bypassed.
  if (resolved.EDGE_TTS_PYTHON || resolved.MANHWA_PIPELINE_PYTHON) return null;
  const fallbacks = [
    path.resolve(".venv", "bin", name),
    path.resolve("..", "manhwa-pipeline", ".venv", "bin", name),
    path.join("/opt/tts/bin", name),
  ];
  for (const cand of fallbacks) {
    try {
      const st = fs.statSync(cand);
      if (st.isFile() && (st.mode & 0o111)) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

async function generateExternal(dest: string, meta: Record<string, unknown>, env?: Env): Promise<number> {
  const dir = ensurePreviewDir(env);
  const tmpdir = fs.mkdtempSync(path.join(dir, ".gen-"));
  try {
    const cfg = resolveExternalConfig(meta, env);
    const timeout = Number((cfg.settings.timeout as number | undefined) ?? 180);
    const tmpOut = path.join(tmpdir, `.line_000.${process.pid}.tmp.mp3`);
    const req = {
      protocol: "manhwa-tts-v1",
      line_index: 0,
      text: SAMPLE_TEXT,
      output_path: path.resolve(tmpOut),
      voice_id: cfg.voice_id,
      language: cfg.language,
      speed: pyFloat(cfg.speed),
      style: cfg.style,
      provider: cfg.provider,
      revision: cfg.revision,
      settings: cfg.settings,
    };
    const input = pyJsonDumps(req, { sortKeys: false, separators: [", ", ": "], ensureAscii: false });
    let r: { code: number; timedOut: boolean; error?: NodeJS.ErrnoException };
    try {
      r = await runCollected(cfg.command, {
        timeoutMs: (Number.isFinite(timeout) ? timeout : 180) * 1000,
        input,
        env,
      });
    } catch (err) {
      throw new PreviewError(`Voice preview generation failed: ${sanitizeLine(err)}`);
    }
    if (r.error) throw new PreviewError(`Voice preview generation failed: ${sanitizeLine(r.error.message)}`);
    if (r.timedOut) throw new PreviewError("Voice preview generation failed: timeout");
    if (r.code !== 0) throw new PreviewError(`Voice preview generation failed: rc=${r.code}`);
    const produced = path.join(tmpdir, "line_000.mp3");
    if (!fs.existsSync(produced)) {
      if (fs.existsSync(tmpOut)) fs.renameSync(tmpOut, produced);
    }
    if (!fs.existsSync(produced) || !fs.statSync(produced).isFile()) {
      throw new PreviewError("Voice preview produced no audio");
    }
    return installAudio(produced, dest, env);
  } catch (err) {
    if (err instanceof PreviewError) throw err;
    throw new PreviewError(`Voice preview generation failed: ${sanitizeLine(err)}`);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

async function generateVertex(dest: string, meta: Record<string, unknown>, env?: Env): Promise<number> {
  const dir = ensurePreviewDir(env);
  const tmpdir = fs.mkdtempSync(path.join(dir, ".gen-"));
  try {
    const voiceId = String(meta.voice_id ?? "").trim();
    if (!voiceId) throw new PreviewError("Vertex TTS voice_id is empty");
    const speed = finiteSpeed(meta.speed != null ? meta.speed : 1);
    const tmpOut = path.join(tmpdir, "preview.mp3");
    try {
      await synthesizeVertexTtsToFile({
        text: SAMPLE_TEXT,
        voiceId,
        destPath: tmpOut,
        speed,
        env: stringifyEnv(resolveEnv(env)),
      });
    } catch (err) {
      throw new PreviewError(`Voice preview generation failed: ${sanitizeLine(err)}`);
    }
    return installAudio(tmpOut, dest, env);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

async function generateGrok(dest: string, meta: Record<string, unknown>, env?: Env): Promise<number> {
  const dir = ensurePreviewDir(env);
  const tmpdir = fs.mkdtempSync(path.join(dir, ".gen-"));
  try {
    const voiceId = String(meta.voice_id ?? "").trim();
    if (!voiceId) throw new PreviewError("Grok TTS voice_id is empty");
    const speed = finiteSpeed(meta.speed != null ? meta.speed : 1);
    const tmpOut = path.join(tmpdir, "preview.mp3");
    try {
      await synthesizeGrokTtsToFile({
        text: SAMPLE_TEXT,
        voiceId,
        destPath: tmpOut,
        speed,
        env: stringifyEnv(resolveEnv(env)),
      });
    } catch (err) {
      throw new PreviewError(`Voice preview generation failed: ${sanitizeLine(err)}`);
    }
    return installAudio(tmpOut, dest, env);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

async function generate(cacheId: string, eff: EffectiveConfig, env?: Env): Promise<number> {
  const dest = cacheFile(cacheId, env);
  if (eff.engine === "edge") return generateEdge(dest, env);
  if (eff.engine === "vertex") return generateVertex(dest, eff.metaTts || {}, env);
  if (eff.engine === "grok") return generateGrok(dest, eff.metaTts || {}, env);
  return generateExternal(dest, eff.metaTts || {}, env);
}

function result(cacheId: string, duration: number, cached: boolean): PreviewResult {
  return { id: cacheId, duration: Math.round(Number(duration) * 1000) / 1000, cached: Boolean(cached) };
}

export async function generatePreview(providerId: string, voiceId: string, env?: Env): Promise<PreviewResult> {
  const e = resolveEnv(env);
  if (typeof providerId !== "string" || !providerId.trim()) throw new IntakeError("TTS provider is required");
  if (typeof voiceId !== "string" || !voiceId.trim()) throw new IntakeError("TTS voice is required");
  const provider = providerId.trim();
  const voice = voiceId.trim();
  let eff = await effectiveConfig(provider, voice, e, false);
  const id = cacheKey(eff.payload);
  const cached = readCache(id, e);
  if (cached != null) return result(id, cached, true);

  const lockFd = acquireGenerationLock(e);
  try {
    const again = readCache(id, e);
    if (again != null) return result(id, again, true);
    const remaining = cooldownRemaining(e);
    if (remaining > 0) {
      throw new PreviewCooldownError(
        `Voice preview is cooling down for ${remaining.toFixed(0)}s to bound TTS spend; try again shortly`,
      );
    }
    eff = await effectiveConfig(provider, voice, e, true);
    if (cacheKey(eff.payload) !== id) {
      throw new PreflightError("TTS provider configuration changed during preview; try again");
    }
    markCooldown(e);
    const duration = await generate(id, eff, e);
    return result(id, duration, false);
  } finally {
    releaseGenerationLock(lockFd);
  }
}

export const preview = generatePreview;
