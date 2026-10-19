/**
 * Opt-in Docker cloud render backend; no cleaner, agent, or LLM credentials.
 *
 * `MANHWA_RENDER_CLOUD` names an existing sandbox baked with cloud-kit/. Run
 * `sbx login` as the same OS user that runs the pipeline. Resume only for jobs;
 * pause after the last job, retaining the bake. Never create, delete, or resize
 * a box.
 *
 * Ported from `pipeline/cloudlane.py`. Python `threading` primitives become
 * async equivalents; every subprocess call funnels through one injectable
 * runner so the ported unit tests run offline.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

import { withSharedSeriesLock, flockFd, tryFlockFd } from "../locks/seriesLock.js";
import * as telemetry from "../telemetry/telemetry.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

export class RuntimeError extends Error {
  override name = "RuntimeError";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class ValueError extends Error {
  override name = "ValueError";
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class FileNotFoundError extends Error {
  override name = "FileNotFoundError";
  code = "ENOENT";
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
    this.code = "ENOENT";
  }
}

/** Stand-in for Python's `shlex.quote`. */
export function shQuote(value: string): string {
  const s = String(value);
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export let NAME: string = String(process.env.MANHWA_RENDER_CLOUD ?? "").trim();
export const RDIR = "/home/agent";
export let STUDIO = `${RDIR}/studio`;
export const MIN_MEM_GB = 4.0;
export const MIN_DISK_GB = 5.0;
export const BREAKER_S = 600;
// Real cloud render concurrency: the host-side semaphore and the remote
// `for slot in 0 1` flock pair are the same two slots. renderlane clamps persisted
// slot values to this (`lane_config.RENDER_TRANSPORT_SLOT_CAP`).
export const MAX_RENDER_SLOTS = 2;
export const TTL_BUDGET_S = 5400; // render timeout + transfers; not an idle keepalive

export interface LogLike {
  write(chunk: string): unknown;
  flush?(): unknown;
}

/** Minimal mutable state bag, patchable by tests field by field. */
export interface CloudState {
  t: number;
  h: { result: [boolean, string]; box: Box | null } | null;
  fails: number;
  until: number;
}

export const _state: CloudState = { t: 0.0, h: null, fails: 0, until: 0.0 };

export interface Box {
  name?: string;
  id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ProbeInfo {
  cpus: number;
  mem_gb: number;
  disk_gb: number;
  miss: string;
}

const PROBE = `set -eu
cd /home/agent/studio
miss=""
[ -f .kit-ready ] || miss="$miss kit-ready"
[ -x node_modules/.bin/remotion ] || miss="$miss remotion"
command -v flock >/dev/null || miss="$miss flock"
printf '{"cpus":%s,"mem_gb":%s,"disk_gb":%s,"miss":"%s"}\\n' \\
  "$(nproc)" "$(awk '/MemAvailable/{printf "%.1f",$2/1048576}' /proc/meminfo)" \\
  "$(df -Pk . | awk 'NR==2{printf "%.1f",$4/1048576}')" "$miss"
`;

/* ------------------------------------------------------------------ *
 * Injectable subprocess layer.
 * ------------------------------------------------------------------ */

export interface RawResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ProcessRunner = (args: readonly string[], timeout: number) => RawResult;

function defaultProcessRunner(args: readonly string[], timeout: number): RawResult {
  const res = spawnSync(args[0] as string, args.slice(1), {
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? undefined,
  };
}

let processRunner: ProcessRunner = defaultProcessRunner;

/** Replace the subprocess runner (offline unit tests). Pass null to restore. */
export function _setRunnerForTests(runner: ProcessRunner | null): void {
  processRunner = runner ?? defaultProcessRunner;
}

/* ------------------------------------------------------------------ *
 * Async primitives (ports of the Python threading primitives).
 * ------------------------------------------------------------------ */

/** Counting semaphore with FIFO handoff, the port of `threading.BoundedSemaphore`. */
export class Semaphore {
  private free: number;
  private waiters: Array<() => void> = [];

  constructor(size: number) {
    this.free = size;
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.free += 1;
  }
}

export const SLOTS = new Semaphore(MAX_RENDER_SLOTS);

/** Non-reentrant async mutex, the port of `threading.Lock`. */
export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    } else {
      this.locked = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    }
  }
}

/** Reentrant async mutex, the port of `threading.RLock` (used for `_sync_lock`). */
export class ReentrantMutex {
  private locked = false;
  private waiters: Array<() => void> = [];
  private readonly held = new AsyncLocalStorage<true>();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.held.getStore() === true) {
      return await fn();
    }
    if (this.locked) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    } else {
      this.locked = true;
    }
    try {
      return await this.held.run(true, fn);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    }
  }
}

/**
 * Condition variable, the port of `threading.Condition`.
 * `waitFor(pred)` blocks until `pred()` is true; `notifyAll()` wakes waiters.
 */
export class AsyncCondition {
  private waiters: Array<() => void> = [];

  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  notifyAll(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }
}

/** Synchronous reentrant guard, the port of `threading.RLock` for `_slock`. */
class SyncReentrantLock {
  private depth = 0;
  run<T>(fn: () => T): T {
    this.depth += 1;
    try {
      return fn();
    } finally {
      this.depth -= 1;
    }
  }
}

const _slock = new SyncReentrantLock();
const _syncLock = new ReentrantMutex();
export const _idle = new AsyncCondition();
export let _active = 0;

const _projectLock = new Mutex();
const _projects = new Map<string, Mutex>();

/** Injectable time layer; tests patch `time.sleep` / `time.monotonic`. */
export const time = {
  monotonic(): number {
    return performance.now() / 1000;
  },
  sleep(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, seconds) * 1000);
    });
  },
  now(): number {
    return Date.now() / 1000;
  },
};

/* ------------------------------------------------------------------ *
 * Leaf operations (capture/run/exec/push/pull/rm/...). Tests may replace
 * any entry of `_ops`; internal call sites always go through `_ops`.
 * ------------------------------------------------------------------ */

export type CaptureFn = (args: string[], timeout?: number) => string;
export type RunFn = (args: string[], log: LogLike | null, timeout?: number) => void;
export type ExecFn = (cmd: string, log: LogLike | null, timeout?: number) => void;
export type TransferFn = (src: string, dst: string, log: LogLike | null) => void;
export type RmFn = (remotePath: string, log: LogLike | null) => void;
export type SyncStudioFn = (studio: string, log: LogLike | null) => Promise<void>;
export type ValidateFn = (video: string) => void;
export type ListedBoxFn = () => Box;
export type WaitStateFn = (allowed: Set<string>, timeout?: number) => Promise<Box>;
export type ReadyFn = () => void;
export type EnsureTtlFn = () => void;
export type PauseIfIdleFn = (usePath: string) => Promise<void>;
export type LeaseFn = <T>(fn: () => T | Promise<T>) => Promise<T>;

export interface CloudOps {
  capture: CaptureFn;
  run: RunFn;
  exec: ExecFn;
  push: TransferFn;
  pull: TransferFn;
  rm: RmFn;
  syncStudio: SyncStudioFn;
  validate: ValidateFn;
  listedBox: ListedBoxFn;
  waitState: WaitStateFn;
  ready: ReadyFn;
  ensureTtl: EnsureTtlFn;
  pauseIfIdle: PauseIfIdleFn;
  lease: LeaseFn;
}

function captureImpl(args: string[], timeout = 60): string {
  const r = processRunner(["sbx", "--cloud", ...args], timeout);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new RuntimeError(
      `sbx ${args[0]} rc=${r.status}: ${r.stderr.slice(-300).trim()}`,
    );
  }
  return r.stdout.trim();
}

function runImpl(args: string[], log: LogLike | null, timeout = 900): void {
  const r = processRunner(["sbx", "--cloud", ...args], timeout);
  if (r.error) throw r.error;
  if (log) {
    log.write(r.stdout);
    log.write(r.stderr);
  }
  if (r.status !== 0) {
    throw new RuntimeError(`sbx ${args[0]} rc=${r.status}; see render.log`);
  }
}

function execImpl(cmd: string, log: LogLike | null, timeout = 900): void {
  _ops.run(["exec", NAME, "sh", "-c", cmd], log, timeout);
}

function pushImpl(src: string, dst: string, log: LogLike | null): void {
  // sbx cp nests directories. Callers copy a dir to its PARENT, not itself.
  _ops.run(["cp", src, `${NAME}:${dst}`], log);
}

function pullImpl(src: string, dst: string, log: LogLike | null): void {
  _ops.run(["cp", `${NAME}:${src}`, dst], log);
}

function rmImpl(remotePath: string, log: LogLike | null): void {
  try {
    _ops.exec(`rm -rf ${shQuote(remotePath)}`, log, 60);
  } catch {
    // cleanup must not mask a completed render
  }
}

function listedBoxImpl(): Box {
  const listing = JSON.parse(_ops.capture(["ls", "--json"])) as { sandboxes?: Box[] };
  for (const box of listing.sandboxes ?? []) {
    if (box.name === NAME || box.id === NAME) return box;
  }
  throw new RuntimeError("sandbox not found (create it with cloud-kit first)");
}

function waitStateImpl(allowed: Set<string>, timeout = 120): Promise<Box> {
  const deadline = time.monotonic() + timeout;
  const loop = async (): Promise<Box> => {
    const box = _ops.listedBox();
    if (allowed.has(String(box.status))) return box;
    if (time.monotonic() >= deadline) {
      throw new RuntimeError(`sandbox still ${box.status} after ${timeout}s`);
    }
    await time.sleep(1);
    return loop();
  };
  return loop();
}

function readyImpl(): void {
  const h = JSON.parse(_ops.capture(["exec", NAME, "sh", "-c", PROBE], 120)) as ProbeInfo;
  if (String(h.miss ?? "").trim()) {
    throw new RuntimeError(`missing tools:${h.miss}`);
  }
  if (h.cpus < 1) {
    throw new RuntimeError("no CPUs available");
  }
  if (h.mem_gb < MIN_MEM_GB || h.disk_gb < MIN_DISK_GB) {
    throw new RuntimeError(`low RAM/disk (${h.mem_gb}/${h.disk_gb}GB)`);
  }
  telemetry.worker(NAME, { kind: "cloud", metrics: h, available: true });
}

interface TtlInfo {
  expires_in_seconds?: number | string;
  max_remaining_seconds?: number | string;
  stopped?: boolean;
  ttl_paused?: boolean;
}

function ensureTtlImpl(): void {
  const ttl = JSON.parse(_ops.capture(["ttl", NAME, "--json"])) as TtlInfo;
  if (ttl.ttl_paused || ttl.stopped) {
    return;
  }
  if (
    ttl.expires_in_seconds === undefined ||
    ttl.expires_in_seconds === null ||
    ttl.expires_in_seconds === "" ||
    ttl.max_remaining_seconds === undefined ||
    ttl.max_remaining_seconds === null ||
    ttl.max_remaining_seconds === ""
  ) {
    throw new RuntimeError("invalid cloud TTL payload");
  }
  const rawRemaining = Number(ttl.expires_in_seconds);
  const rawMaxRemaining = Number(ttl.max_remaining_seconds);
  if (!Number.isFinite(rawRemaining) || !Number.isFinite(rawMaxRemaining)) {
    throw new RuntimeError("invalid cloud TTL payload");
  }
  const remaining = Math.trunc(rawRemaining);
  if (remaining >= TTL_BUDGET_S) {
    return;
  }
  if (Math.trunc(rawMaxRemaining) < TTL_BUDGET_S) {
    throw new RuntimeError("cloud TTL extension ceiling too close for this job");
  }
  _ops.capture(["ttl", `+${TTL_BUDGET_S - remaining}s`, NAME]);
}

function pauseIfIdleImpl(usePath: string): Promise<void> {
  return (async () => {
    // Caller holds the gate; shared leases include uploads, pulls and waiters.
    const fd = fs.openSync(usePath, "a");
    try {
      if (!tryFlockFd(fd, "ex", true)) {
        return; // another process/thread still needs the box
      }
      try {
        _ops.capture(["stop", NAME], 60);
        await _ops.waitState(new Set(["stopped"]), 240);
        _slock.run(() => {
          _state.t = 0.0;
          _state.h = null;
        });
        telemetry.worker(NAME, {
          kind: "cloud",
          status: "paused",
          reason: "No pending render jobs",
        });
      } catch (err) {
        const name = (err as Error)?.name ?? "Error";
        const msg = (err as Error)?.message ? `: ${(err as Error).message}` : "";
        process.stdout.write(
          `[cloud] WARNING: automatic pause failed (${name}${msg}); stop the sandbox manually\n`,
        );
        telemetry.worker(NAME, { reason: "Automatic pause failed", lastError: `${name}${msg}` });
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  })();
}

/**
 * Serialize resume/pause and protect jobs across processes on this host.
 *
 * All controllers must share this lock directory; don't manually use the box
 * while the pipeline owns it. No API credentials are written to lock files.
 */
function leaseImpl<T>(fn: () => T | Promise<T>): Promise<T> {
  return (async () => {
    const box = _ops.listedBox();
    const key = createHash("sha256")
      .update(String(box.id ?? NAME))
      .digest("hex");
    const root =
      process.env.MANHWA_RENDER_CLOUD_LOCKDIR ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "cloud-locks");
    fs.mkdirSync(root, { recursive: true });
    const gate = path.join(root, `${key}.gate`);
    const use = path.join(root, `${key}.use`);
    const holder = fs.openSync(use, "a");
    let acquired = false;
    try {
      await withGate(gate, async () => {
        flockFdShared(holder);
        acquired = true;
        await _ops.waitState(new Set(["running", "stopped"]), 240);
        _ops.ready();
        _ops.ensureTtl();
      });
      return await fn();
    } finally {
      if (acquired) {
        await withGate(gate, async () => {
          try {
            fs.closeSync(holder);
          } catch {
            // ignore
          }
          await _ops.pauseIfIdle(use);
        });
      } else {
        try {
          fs.closeSync(holder);
        } catch {
          // ignore
        }
      }
    }
  })();
}

export const _ops: CloudOps = {
  capture: captureImpl,
  run: runImpl,
  exec: execImpl,
  push: pushImpl,
  pull: pullImpl,
  rm: rmImpl,
  syncStudio: (studio, log) => syncStudioImpl(studio, log),
  validate: (video) => validateImpl(video),
  listedBox: listedBoxImpl,
  waitState: waitStateImpl,
  ready: readyImpl,
  ensureTtl: ensureTtlImpl,
  pauseIfIdle: pauseIfIdleImpl,
  lease: leaseImpl,
};

/** Restore every injectable op to its real implementation. */
export function _resetOpsForTests(): void {
  _ops.capture = captureImpl;
  _ops.run = runImpl;
  _ops.exec = execImpl;
  _ops.push = pushImpl;
  _ops.pull = pullImpl;
  _ops.rm = rmImpl;
  _ops.syncStudio = (studio, log) => syncStudioImpl(studio, log);
  _ops.validate = (video) => validateImpl(video);
  _ops.listedBox = listedBoxImpl;
  _ops.waitState = waitStateImpl;
  _ops.ready = readyImpl;
  _ops.ensureTtl = ensureTtlImpl;
  _ops.pauseIfIdle = pauseIfIdleImpl;
  _ops.lease = leaseImpl;
}

/** Public named exports, mirroring the Python module API. */
export const _capture: CaptureFn = (args, timeout) => _ops.capture(args, timeout);
export const run: RunFn = (args, log, timeout) => _ops.run(args, log, timeout);
export const exec: ExecFn = (cmd, log, timeout) => _ops.exec(cmd, log, timeout);
export const push: TransferFn = (src, dst, log) => _ops.push(src, dst, log);
export const pull: TransferFn = (src, dst, log) => _ops.pull(src, dst, log);
export const rm: RmFn = (remotePath, log) => _ops.rm(remotePath, log);

/* ------------------------------------------------------------------ *
 * File-descriptor flocks (kernel flock via the `flock(1)` utility).
 * ------------------------------------------------------------------ */

function flockFdShared(fd: number): void {
  flockFd(fd, "sh", false);
}

async function withGate<T>(gatePath: string, fn: () => T | Promise<T>): Promise<T> {
  const fd = fs.openSync(gatePath, "a");
  try {
    flockFd(fd, "ex", false);
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // closing the fd releases the flock
    }
  }
}

/** Port of Python's `_gate(path)` contextmanager: hold `LOCK_EX` for the callback. */
export function _gate<T>(gatePath: string, fn: () => T | Promise<T>): Promise<T> {
  return withGate(gatePath, fn);
}

/* ------------------------------------------------------------------ *
 * Probe / health / breaker.
 * ------------------------------------------------------------------ */

export function report(ok: boolean): void {
  /** Two consecutive probe/job failures open the breaker for ten minutes. */
  _slock.run(() => {
    if (ok) {
      _state.fails = 0;
    } else {
      _state.fails += 1;
      _state.t = 0.0;
      if (_state.fails >= 2) {
        _state.until = time.now() + BREAKER_S;
        _state.fails = 0;
        process.stdout.write(`[cloud] breaker OPEN: local-only for ${BREAKER_S}s\n`);
      }
    }
  });
}

export function _listedBox(): Box {
  return _ops.listedBox();
}

/** Non-waking availability check. Kit/resource checks happen inside a job. */
export function healthy(maxAge = 20): [boolean, string] {
  if (!NAME) {
    return [false, "no cloud configured"];
  }
  const { now, ok, why } = _slock.run(() => {
    const at = time.now();
    if (at < _state.until) {
      const reason = `breaker open (${Math.trunc(_state.until - at)}s left)`;
      telemetry.worker(NAME, {
        kind: "cloud",
        available: false,
        reason,
        retryAt: _state.until,
      });
      return { now: at, ok: false, why: reason };
    }
    if (maxAge <= 0 || at - _state.t >= maxAge) {
      let h: Box | null = null;
      let result: [boolean, string];
      try {
        h = _ops.listedBox();
        if (h.status === "running" || h.status === "ready") {
          result = [true, "ok"];
          _state.fails = 0;
        } else if (h.status === "stopped") {
          result = [true, "paused; checked on render"];
          _state.fails = 0;
        } else {
          result = [false, `sandbox status: ${h.status}`];
          report(false);
        }
      } catch (e) {
        result = [false, String((e as Error).message).slice(0, 200)];
        report(false);
      }
      _state.t = at;
      _state.h = { result, box: h };
    }
    const cached = _state.h;
    return {
      now: at,
      ok: cached ? cached.result[0] : false,
      why: cached ? cached.result[1] : "",
    };
  });
  telemetry.worker(NAME, { kind: "cloud", available: ok, reason: why, probedAt: now });
  return [ok, why];
}

export function _ready(): void {
  /** Exec resumes a paused box. Only call while holding a job lease. */
  _ops.ready();
}

export function _ensureTtl(): void {
  _ops.ensureTtl();
}

export function _waitState(allowed: Set<string>, timeout = 120): Promise<Box> {
  return _ops.waitState(allowed, timeout);
}

export async function _pauseIfIdle(usePath: string): Promise<void> {
  await _ops.pauseIfIdle(usePath);
}

export function _lease<T>(fn: () => T | Promise<T>): Promise<T> {
  return _ops.lease(fn);
}

/* ------------------------------------------------------------------ *
 * Composition sync / validation.
 * ------------------------------------------------------------------ */

export function _digest(filePath: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    do {
      n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n > 0) h.update(buf.subarray(0, n));
    } while (n > 0);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function walkFiles(root: string): string[] {
  // Matches Python's `os.walk` ordering: this directory's files (sorted) first,
  // then each subdirectory (sorted) recursively.
  const out: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else {
      out.push(path.join(root, entry.name));
    }
  }
  for (const dir of dirs) {
    out.push(...walkFiles(path.join(root, dir)));
  }
  return out;
}

async function syncStudioImpl(studio: string, log: LogLike | null): Promise<void> {
  /** Copy composition only when changed; never send dependencies or public/. */
  await _syncLock.run(async () => {
    const files: string[] = ["remotion.config.ts", "tsconfig.json"];
    const srcRoot = path.join(studio, "src");
    if (fs.existsSync(srcRoot)) {
      for (const full of walkFiles(srcRoot)) {
        files.push(path.relative(studio, full));
      }
    }
    const signature = createHash("sha256")
      .update(files.map((p) => `${p}:${_digest(path.join(studio, p))}`).join("\n"))
      .digest("hex");
    // A different dependency tree requires rebaking, not a half-copied npm update.
    const checks = ["package.json", "package-lock.json"]
      .map(
        (p) =>
          `[ "$(sha256sum ${shQuote(p)} | cut -d' ' -f1)" = ` +
          `${shQuote(_digest(path.join(studio, p)))} ]`,
      )
      .join(" && ");
    const marker = ".pipeline-src-sha256";
    const remote = _ops.capture([
      "exec",
      NAME,
      "sh",
      "-c",
      `cd ${STUDIO} && { if ! { ${checks}; }; then ` +
        "echo 'studio dependencies differ; rebake cloud-kit' >&2; exit 1; fi; " +
        `cat ${marker} 2>/dev/null || true; }`,
    ]);
    if (remote === signature) {
      return;
    }
    // Do not change the shared composition underneath another cloud render.
    // Starting jobs hold _sync_lock until registered in _active; finishing
    // jobs need only _idle, so they can release this wait without deadlocking.
    await _idle.waitFor(() => _active === 0);
    _ops.exec(`rm -f ${STUDIO}/${marker} && rm -rf ${STUDIO}/src`, log, 60);
    _ops.push(path.join(studio, "src"), STUDIO, log);
    for (const p of ["remotion.config.ts", "tsconfig.json"]) {
      _ops.push(path.join(studio, p), `${STUDIO}/${p}`, log);
    }
    _ops.exec(`printf '%s' ${signature} > ${STUDIO}/${marker}`, log, 60);
  });
}

export function _syncStudio(studio: string, log: LogLike | null): Promise<void> {
  return _ops.syncStudio(studio, log);
}

function validateImpl(video: string): void {
  const r = processRunner(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
    30,
  );
  const raw = (r.stdout ?? "").trim();
  const duration = raw ? Number(raw) : 0;
  if (r.status || !Number.isFinite(duration) || duration <= 0) {
    throw new RuntimeError("cloud download is not a valid video; original output kept");
  }
}

export function _validate(video: string): void {
  _ops.validate(video);
}

async function projectRun<T>(proj: string, fn: () => Promise<T>): Promise<T> {
  // A retry of the same chapter must not overwrite/remove another job's assets.
  let lock: Mutex;
  lock = await _projectLock.run(() => {
    let existing = _projects.get(proj);
    if (!existing) {
      existing = new Mutex();
      _projects.set(proj, existing);
    }
    return existing;
  });
  return lock.run(fn);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

class FileLog implements LogLike {
  private fd: number;
  constructor(filePath: string) {
    this.fd = fs.openSync(filePath, "w");
  }
  write(chunk: string): void {
    fs.writeSync(this.fd, chunk);
  }
  flush(): void {
    // Node writes are unbuffered through fs.writeSync.
  }
  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore
    }
  }
}

/** Staged chapter -> cloud -> validated .part -> atomic local replacement. */
export async function render(
  props: string,
  video: string,
  studio: string,
  log?: LogLike | null,
): Promise<void> {
  if (!NAME) {
    throw new RuntimeError("MANHWA_RENDER_CLOUD is empty");
  }
  const parsed = JSON.parse(fs.readFileSync(props, "utf8")) as { audio?: string; quality?: string };
  const proj = String(parsed.audio ?? "").split("/")[0] ?? "";
  // The Recap composition is 1280x720; 1080p is an exact 1.5x upscale.
  const scale = parsed.quality === "1080p" ? " --scale=1.5" : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(proj)) {
    throw new ValueError("invalid chapter asset directory");
  }
  const assets = path.join(studio, "public", proj);
  if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) {
    throw new FileNotFoundError(assets);
  }
  const videoAbs = path.resolve(video);

  await withSharedSeriesLock([videoAbs, props], { requireExists: false }, async () => {
    fs.mkdirSync(path.dirname(videoAbs), { recursive: true });
    if (log === undefined || log === null) {
      const fileLog = new FileLog(path.join(path.dirname(videoAbs), "render.log"));
      try {
        await render(props, videoAbs, studio, fileLog);
      } finally {
        fileLog.close();
      }
      return;
    }
    const job = `${RDIR}/jobs/${proj}-${randomUUID().replace(/-/g, "")}`;
    const publicDir = `${STUDIO}/public/${proj}`;
    const tmp = videoAbs + ".part";
    telemetry.stageCurrent("render", "queued", { note: "Waiting for a Docker cloud slot" });
    // Register before waiting for a slot: pending jobs must prevent idle pause.
    await projectRun(proj, async () =>
      _ops.lease(async () => {
        await SLOTS.acquire();
        try {
          log.write(`[cloud ${NAME}] ${proj}\n`);
          log.flush?.();
          telemetry.stageCurrent("render", "running", {
            note: "Uploading assets and rendering in Docker cloud",
          });
          let registered = false;
          try {
            await _syncLock.run(async () => {
              await _ops.syncStudio(studio, log);
              _active += 1;
              registered = true;
              telemetry.worker(NAME, {
                kind: "cloud",
                status: "busy",
                activeRenders: _active,
              });
            });
            _ops.exec(
              `mkdir -p ${STUDIO}/public ${job}/tmp && rm -rf -- ${shQuote(publicDir)}`,
              log,
              60,
            );
            _ops.push(assets, `${STUDIO}/public`, log);
            _ops.push(props, `${job}/shots.json`, log);
            const command =
              `cd ${STUDIO} && TMPDIR=${job}/tmp TMP=${job}/tmp TEMP=${job}/tmp ` +
              `npx remotion render src/index.ts Recap ${job}/video.mp4 ` +
              `--props=${job}/shots.json --log=info${scale}`;
            // Host-side semaphore bounds transfers too. Remote locks enforce
            // the two-render cap even across separate pipeline processes.
            _ops.exec(
              "while :; do for slot in 0 1; do " +
                `flock -n -E 75 ${RDIR}/.manhwa-render-$slot.lock ` +
                `sh -c ${shQuote(command)}; rc=$?; ` +
                '[ "$rc" -eq 75 ] || exit "$rc"; done; sleep 1; done',
              log,
              3600,
            );
            // sbx cp must not see an existing destination as a directory.
            if (isFile(tmp)) {
              fs.unlinkSync(tmp);
            }
            _ops.pull(`${job}/video.mp4`, tmp, log);
            _ops.validate(tmp);
            fs.renameSync(tmp, videoAbs);
          } finally {
            try {
              if (isFile(tmp)) {
                fs.unlinkSync(tmp);
              }
              _ops.rm(job, log);
              _ops.rm(publicDir, log);
            } finally {
              if (registered) {
                _active -= 1;
                telemetry.worker(NAME, {
                  status: _active ? "busy" : "idle",
                  activeRenders: _active,
                });
                _idle.notifyAll();
              }
            }
          }
        } finally {
          SLOTS.release();
        }
      }),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Test helpers.
 * ------------------------------------------------------------------ */

export function _setNameForTests(name: string | null): void {
  NAME = name === null ? "" : String(name);
}

export function _setStudioForTests(studio: string | null): void {
  STUDIO = studio === null ? `${RDIR}/studio` : String(studio);
}

export function _setActiveForTests(active: number): void {
  _active = active;
}

export function _resetStateForTests(): void {
  _state.t = 0.0;
  _state.h = null;
  _state.fails = 0;
  _state.until = 0.0;
  _active = 0;
  _projects.clear();
}

/* ------------------------------------------------------------------ *
 * Multi-instance cloud nodes (`createCloudNode`).
 *
 * The module-level singleton above stays the default `cloud` lane. A cloud
 * node is the same transport (sbx over argv) with its OWN state: probe cache,
 * circuit breaker, slot semaphore, idle pause timer, and TTL budget. Nothing
 * here touches the module singleton's `_state`, `SLOTS`, or `_active`.
 * ------------------------------------------------------------------ */

export interface CloudNodeConfig {
  id: string;
  box: string;
  template?: string;
  slots?: number;
  maxHours?: number;
  idlePauseS?: number;
  minMemGb?: number;
  minDiskGb?: number;
  remoteDir?: string;
}

export interface CloudNodeOptions {
  /** Explicit opt-in for start/stop/create (same effect as the env switch). */
  allowControl?: boolean;
}

export interface CloudNodeState {
  ok: boolean;
  why: string;
  ts: number;
  fails: number;
  openUntil: number;
  active: number;
  slots: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface CloudNode {
  readonly id: string;
  readonly box: string;
  readonly state: CloudNodeState;
  healthy(force?: boolean): [boolean, string];
  render(propsPath: string, outVideo: string, log?: (msg: string) => void): Promise<void>;
  pauseIfIdle(): void;
  ensureTtl(): void;
  status(): { ok: boolean; status: string; reason: string; box: string };
  start(): { ok: boolean; detail: string };
  stop(): { ok: boolean; detail: string };
  create(): { ok: boolean; detail: string };
  /** Create the box if missing and deploy the render environment into it. */
  provision(opts?: { studio?: string }): {
    ok: boolean;
    detail: string;
    probe?: Record<string, unknown>;
  };
  /** Alias of `provision` for a fresh-account one-click bootstrap. */
  bootstrap(opts?: { studio?: string }): {
    ok: boolean;
    detail: string;
    probe?: Record<string, unknown>;
  };
}

const CLOUD_BOX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const CLOUD_TEMPLATE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,127}$/;
const CLOUD_NODE_PROBE_CACHE_S = 20;
/** Directory inside the sandbox that receives the Remotion studio during provision. */
export const SANDBOX_STUDIO_DIR = "/work/remotion-studio";
/** Files/dirs streamed into the sandbox studio (node_modules excluded). */
export const STUDIO_ARCHIVE_ENTRIES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "remotion.config.ts",
  "src",
  "public",
] as const;

function controlAllowed(opts: CloudNodeOptions | undefined): boolean {
  if (process.env.MANHWA_ALLOW_SANDBOX_CONTROL === "1") return true;
  return opts?.allowControl === true;
}

function nodeCapture(
  runner: ProcessRunner,
  args: string[],
  timeout = 60,
): string {
  const r = runner(["sbx", "--cloud", ...args], timeout);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new RuntimeError(`sbx ${args[0]} rc=${r.status}: ${r.stderr.slice(-300).trim()}`);
  }
  return r.stdout.trim();
}

function nodeRun(
  runner: ProcessRunner,
  args: string[],
  timeout = 900,
): void {
  const r = runner(["sbx", "--cloud", ...args], timeout);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    // Surface the CLI's own message: a bare "rc=1" hides things like
    // "create requires a command when --template is not used".
    const detail = (r.stderr || r.stdout || "").trim().slice(-240);
    throw new RuntimeError(
      detail
        ? `sbx ${args[0]} rc=${r.status}: ${detail}; see render.log`
        : `sbx ${args[0]} rc=${r.status}; see render.log`,
    );
  }
}

function findBox(listing: string, box: string): Box | null {
  let parsed: { sandboxes?: Box[] };
  try {
    parsed = JSON.parse(listing) as { sandboxes?: Box[] };
  } catch {
    return null;
  }
  for (const item of parsed.sandboxes ?? []) {
    if (item.name === box || item.id === box) return item;
  }
  return null;
}

export function createCloudNode(
  cfg: CloudNodeConfig,
  runner?: ProcessRunner,
  opts?: CloudNodeOptions,
): CloudNode {
  const id = String(cfg.id ?? "").trim();
  const box = String(cfg.box ?? "").trim();
  if (!id) throw new ValueError("cloud node id is required");
  if (!CLOUD_BOX_RE.test(box)) {
    throw new ValueError(`invalid cloud node box ${JSON.stringify(box)}`);
  }
  const run: ProcessRunner = runner ?? ((args, timeout) => processRunner(args, timeout));
  const slots = Math.max(1, Math.trunc(Number(cfg.slots ?? 1)) || 1);
  const minMemGb = Number.isFinite(cfg.minMemGb) ? Number(cfg.minMemGb) : MIN_MEM_GB;
  const minDiskGb = Number.isFinite(cfg.minDiskGb) ? Number(cfg.minDiskGb) : MIN_DISK_GB;
  const maxHours = Number.isFinite(cfg.maxHours) && Number(cfg.maxHours) > 0 ? Number(cfg.maxHours) : 0;
  const idlePauseS = Number.isFinite(cfg.idlePauseS) ? Math.max(0, Number(cfg.idlePauseS)) : 0;
  const remoteDir = cfg.remoteDir ? String(cfg.remoteDir) : `${RDIR}/studio`;

  const state: CloudNodeState = {
    ok: false,
    why: "not probed",
    ts: 0,
    fails: 0,
    openUntil: 0,
    active: 0,
    slots,
    idleTimer: null,
  };

  let free = slots;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (free > 0) {
      free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    free += 1;
  };

  const noteResult = (ok: boolean): void => {
    if (ok) {
      state.fails = 0;
      return;
    }
    state.ts = 0;
    state.fails += 1;
    if (state.fails >= 2) {
      state.openUntil = time.now() + BREAKER_S;
      state.fails = 0;
      process.stdout.write(`[cloud ${id}] breaker OPEN: local-only for ${BREAKER_S}s\n`);
    }
  };

  const probe = (): void => {
    try {
      const listing = nodeCapture(run, ["ls", "--json"]);
      const found = findBox(listing, box);
      if (!found) {
        state.ok = false;
        state.why = "sandbox not found";
        noteResult(false);
      } else if (found.status === "running" || found.status === "ready") {
        state.ok = true;
        state.why = "ok";
        state.fails = 0;
      } else if (found.status === "stopped") {
        state.ok = true;
        state.why = "paused; checked on render";
        state.fails = 0;
      } else {
        state.ok = false;
        state.why = `sandbox status: ${found.status}`;
        noteResult(false);
      }
    } catch (err) {
      state.ok = false;
      state.why = String((err as Error)?.message ?? err).slice(0, 200);
      noteResult(false);
    }
    state.ts = time.now();
  };

  const clearIdleTimer = (): void => {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  };

  const pauseNow = (): void => {
    state.idleTimer = null;
    if (state.active > 0) return;
    try {
      nodeRun(run, ["stop", box], 60);
      state.ts = 0;
      state.ok = false;
      state.why = "paused";
      telemetry.worker(id, { kind: "cloud", status: "paused", box });
    } catch (err) {
      process.stdout.write(
        `[cloud ${id}] WARNING: automatic pause failed (${(err as Error)?.message ?? err})\n`,
      );
    }
  };

  const node: CloudNode = {
    id,
    box,
    state,

    healthy(force = false): [boolean, string] {
      const at = time.now();
      if (at < state.openUntil) {
        const reason = `breaker open (${Math.trunc(state.openUntil - at)}s left)`;
        telemetry.worker(id, {
          kind: "cloud",
          available: false,
          reason,
          retryAt: state.openUntil,
        });
        return [false, reason];
      }
      if (force || state.ts === 0 || at - state.ts >= CLOUD_NODE_PROBE_CACHE_S) {
        probe();
      }
      telemetry.worker(id, { kind: "cloud", available: state.ok, reason: state.why });
      return [state.ok, state.why];
    },

    async render(
      propsPath: string,
      outVideo: string,
      log?: (msg: string) => void,
    ): Promise<void> {
      const parsed = JSON.parse(fs.readFileSync(propsPath, "utf8")) as { audio?: string; quality?: string };
      const proj = String(parsed.audio ?? "").split("/")[0] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(proj)) {
        throw new ValueError("invalid chapter asset directory");
      }
      // The Recap composition is 1280x720; 1080p is an exact 1.5x upscale.
      const scale = parsed.quality === "1080p" ? " --scale=1.5" : "";
      const studioLocal = process.env.MANHWA_STUDIO || path.join(REPO_ROOT, "remotion-studio");
      const assets = path.join(studioLocal, "public", proj);
      if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) {
        throw new FileNotFoundError(assets);
      }
      const videoAbs = path.resolve(outVideo);
      fs.mkdirSync(path.dirname(videoAbs), { recursive: true });
      const say = (msg: string): void => {
        log?.(msg);
      };
      const job = `${RDIR}/jobs/${proj}-${randomUUID().replace(/-/g, "")}`;
      const publicDir = `${remoteDir}/public/${proj}`;
      const tmp = videoAbs + ".part";

      await withSharedSeriesLock([videoAbs, propsPath], { requireExists: false }, async () => {
        const write = log ? undefined : new FileLog(path.join(path.dirname(videoAbs), "render.log"));
        try {
          await acquire();
        } catch (err) {
          write?.close();
          throw err;
        }
        state.active += 1;
        try {
          // Custom docker-sbx nodes must extend their sandbox TTL before a long
          // render. A TTL probe failure is not a render failure: log and continue.
          try {
            await node.ensureTtl();
          } catch (err) {
            say(`[cloud ${id} ${box}] WARNING: TTL extension failed (${(err as Error)?.message ?? err})`);
          }
          say(`[cloud ${id} ${box}] ${proj}`);
          write?.write(`[cloud ${id} ${box}] ${proj}\n`);
          nodeRun(run, ["exec", box, "sh", "-c", `mkdir -p ${shQuote(`${remoteDir}/public`)} ${shQuote(`${job}/tmp`)} && rm -rf -- ${shQuote(publicDir)}`], 60);
          nodeRun(run, ["cp", assets, `${box}:${remoteDir}/public`], 900);
          nodeRun(run, ["cp", propsPath, `${box}:${job}/shots.json`], 900);
          const command =
            `cd ${shQuote(remoteDir)} && TMPDIR=${job}/tmp TMP=${job}/tmp TEMP=${job}/tmp ` +
            `npx remotion render src/index.ts Recap ${job}/video.mp4 ` +
            `--props=${job}/shots.json --log=info${scale}`;
          nodeRun(
            run,
            [
              "exec",
              box,
              "sh",
              "-c",
              "while :; do for slot in 0 1; do " +
                `flock -n -E 75 ${RDIR}/.manhwa-render-$slot.lock ` +
                `sh -c ${shQuote(command)}; rc=$?; ` +
                '[ "$rc" -eq 75 ] || exit "$rc"; done; sleep 1; done',
            ],
            3600,
          );
          if (isFile(tmp)) fs.unlinkSync(tmp);
          nodeRun(run, ["cp", `${box}:${job}/video.mp4`, tmp], 900);
          const probeVideo = run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp],
            30,
          );
          const duration = Number((probeVideo.stdout ?? "").trim() || 0);
          if (probeVideo.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
            throw new RuntimeError("cloud download is not a valid video; original output kept");
          }
          fs.renameSync(tmp, videoAbs);
        } finally {
          try {
            if (isFile(tmp)) fs.unlinkSync(tmp);
            nodeRun(run, ["exec", box, "sh", "-c", `rm -rf ${shQuote(job)} ${shQuote(publicDir)}`], 60);
          } catch {
            // cleanup must not mask a completed render
          }
          state.active = Math.max(0, state.active - 1);
          release();
          write?.close();
          if (state.active === 0) node.pauseIfIdle();
        }
      });
    },

    pauseIfIdle(): void {
      clearIdleTimer();
      if (state.active > 0) return;
      if (idlePauseS <= 0) return;
      state.idleTimer = setTimeout(pauseNow, idlePauseS * 1000);
      state.idleTimer.unref?.();
    },

    ensureTtl(): void {
      const budget = maxHours > 0 ? Math.trunc(maxHours * 3600) : TTL_BUDGET_S;
      const ttl = JSON.parse(nodeCapture(run, ["ttl", box, "--json"])) as TtlInfo;
      if (ttl.ttl_paused || ttl.stopped) return;
      const rawRemaining = Number(ttl.expires_in_seconds);
      const rawMaxRemaining = Number(ttl.max_remaining_seconds);
      if (
        ttl.expires_in_seconds === undefined ||
        ttl.expires_in_seconds === null ||
        ttl.expires_in_seconds === "" ||
        ttl.max_remaining_seconds === undefined ||
        ttl.max_remaining_seconds === null ||
        ttl.max_remaining_seconds === "" ||
        !Number.isFinite(rawRemaining) ||
        !Number.isFinite(rawMaxRemaining)
      ) {
        throw new RuntimeError("invalid cloud TTL payload");
      }
      const remaining = Math.trunc(rawRemaining);
      if (remaining >= budget) return;
      if (Math.trunc(rawMaxRemaining) < budget) {
        throw new RuntimeError("cloud TTL extension ceiling too close for this job");
      }
      nodeCapture(run, ["ttl", `+${budget - remaining}s`, box]);
    },

    status(): { ok: boolean; status: string; reason: string; box: string } {
      const at = time.now();
      let status: string;
      if (at < state.openUntil) status = "breaker-open";
      else if (state.ts === 0) status = "unknown";
      else if (state.active > 0) status = "busy";
      else status = state.ok ? "available" : "unavailable";
      return { ok: state.ok, status, reason: state.why, box };
    },

    start(): { ok: boolean; detail: string } {
      if (!controlAllowed(opts)) {
        return {
          ok: false,
          detail: "sandbox control disabled (set MANHWA_ALLOW_SANDBOX_CONTROL=1 to allow start)",
        };
      }
      try {
        nodeRun(run, ["start", box], 240);
        state.ts = 0;
        return { ok: true, detail: `started ${box}` };
      } catch (err) {
        return { ok: false, detail: String((err as Error)?.message ?? err) };
      }
    },

    stop(): { ok: boolean; detail: string } {
      if (!controlAllowed(opts)) {
        return {
          ok: false,
          detail: "sandbox control disabled (set MANHWA_ALLOW_SANDBOX_CONTROL=1 to allow stop)",
        };
      }
      try {
        nodeRun(run, ["stop", box], 240);
        state.ts = 0;
        state.ok = false;
        state.why = "stopped";
        clearIdleTimer();
        return { ok: true, detail: `stopped ${box}` };
      } catch (err) {
        return { ok: false, detail: String((err as Error)?.message ?? err) };
      }
    },

    create(): { ok: boolean; detail: string } {
      if (!CLOUD_BOX_RE.test(box)) {
        return { ok: false, detail: `invalid sandbox name ${JSON.stringify(box)}` };
      }
      const template = String(cfg.template ?? "").trim();
      if (!CLOUD_TEMPLATE_RE.test(template)) {
        return { ok: false, detail: `invalid sandbox template ${JSON.stringify(template)}` };
      }
      if (!controlAllowed(opts)) {
        return {
          ok: false,
          detail: "sandbox control disabled (set MANHWA_ALLOW_SANDBOX_CONTROL=1 to allow create)",
        };
      }
      try {
        nodeRun(run, ["create", "--name", box, "--template", template], 900);
        return { ok: true, detail: `created ${box} from ${template}` };
      } catch (err) {
        return { ok: false, detail: String((err as Error)?.message ?? err) };
      }
    },

    /**
     * Fresh-account bootstrap: create the box when missing (template first, then a
     * plain base sandbox) and deploy the render environment into it.
     */
    provision(provOpts?: { studio?: string }) {
      const studio = String(
        provOpts?.studio || process.env.MANHWA_STUDIO || path.join(REPO_ROOT, "remotion-studio"),
      ).replace(/\/+$/, "");
      const steps: string[] = [];
      const template = String(cfg.template ?? "").trim();

      let created = false;
      // Every later call (healthy/render/start/stop) looks up `box`, so provision
      // must provision exactly that box. A box named after the template is not a
      // substitute: reusing it leaves `box` missing and every call fails.
      const targetBox = box;
      try {
        const listing = nodeCapture(run, ["ls", "--json"]);
        const existingBox = findBox(listing, box);
        if (!existingBox) {
          if (CLOUD_TEMPLATE_RE.test(template)) {
            try {
              nodeRun(run, ["create", "--name", box, "--template", template], 900);
              created = true;
              steps.push(`created ${box} from ${template}`);
            } catch {
              steps.push(`template ${template} unavailable; using a base sandbox`);
            }
          }
          if (!created) {
            // A real `sbx --cloud create` requires an agent subcommand when
            // `--template` is not used, so always pass `shell`.
            const allowHosts = [
              "registry.npmjs.org",
              "remotion.media",
              "playwright.azureedge.net",
              "storage.googleapis.com",
              "archive.ubuntu.com",
              "security.ubuntu.com",
              "ports.ubuntu.com",
              "download.docker.com",
            ];
            const netFlags = allowHosts.flatMap((h) => ["--allow-network", h]);
            try {
              nodeRun(run, ["create", "--name", box, "--cpus", "8", "--memory", "16g", "--ttl", "2h", "--on-timeout", "stop", ...netFlags, "shell"], 900);
              created = true;
              steps.push(`created ${box} from the default base template`);
            } catch {
              try {
                nodeRun(run, ["create", "--name", box, "--cpus", "8", "--memory", "16g", "shell"], 900);
                created = true;
                steps.push(`created ${box} from the default base template`);
              } catch {
                try {
                  nodeRun(run, ["create", "--name", box, "shell"], 900);
                  created = true;
                  steps.push(`created ${box} from the default base template`);
                } catch (err) {
                  return {
                    ok: false,
                    detail: `sandbox ${box} is missing and could not be created: ${String((err as Error)?.message ?? err)}`,
                  };
                }
              }
            }
          }
        } else {
          steps.push(`sandbox ${targetBox} already exists`);
        }

        // Render environment: studio tree + ffmpeg + node deps. Install into the
        // same directory rendering and health checks use (`remoteDir`), then keep
        // the historical `/work/remotion-studio` path as a compatibility symlink.
        nodeRun(
          run,
          ["exec", targetBox, "sh", "-c",
            `mkdir -p ${shQuote(`${remoteDir}/public`)} ${shQuote(`${RDIR}/jobs`)}` +
            (remoteDir === SANDBOX_STUDIO_DIR
              ? ""
              : ` && mkdir -p $(dirname ${shQuote(SANDBOX_STUDIO_DIR)})` +
                ` && { [ -L ${shQuote(SANDBOX_STUDIO_DIR)} ] || { rm -rf ${shQuote(SANDBOX_STUDIO_DIR)}; ln -sfn ${shQuote(remoteDir)} ${shQuote(SANDBOX_STUDIO_DIR)}; }; }`)],
          120,
        );
        steps.push(`prepared ${remoteDir}`);

        const archive = path.join(
          fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sbx-provision-")),
          "studio.tar.gz",
        );
        try {
          const present = STUDIO_ARCHIVE_ENTRIES.filter((entry) =>
            fs.existsSync(path.join(studio, entry)));
          if (present.length === 0) {
            return { ok: false, detail: `no studio sources found under ${studio}` };
          }
          const tar = run(["tar", "-czf", archive, "-C", studio, "--exclude=node_modules", ...present], 600);
          if (tar.status !== 0) {
            return { ok: false, detail: `local tar failed: ${tar.stderr.slice(-200).trim()}` };
          }
          nodeRun(run, ["cp", archive, `${targetBox}:${RDIR}/studio.tar.gz`], 900);
          nodeRun(
            run,
            ["exec", targetBox, "sh", "-c",
              `tar -xzf ${shQuote(`${RDIR}/studio.tar.gz`)} -C ${shQuote(remoteDir)} && rm -f ${shQuote(`${RDIR}/studio.tar.gz`)}`],
            600,
          );
          steps.push(`streamed studio sources (${present.join(", ")})`);
        } finally {
          try {
            fs.rmSync(path.dirname(archive), { recursive: true, force: true });
          } catch {
            // best effort
          }
        }

        nodeRun(
          run,
          ["exec", targetBox, "sh", "-c",
            "command -v ffmpeg >/dev/null 2>&1 || " +
            "(sudo -n apt-get update -y >/dev/null 2>&1 || apt-get update -y >/dev/null 2>&1 || true); " +
            "command -v ffmpeg >/dev/null 2>&1 || " +
            "(sudo -n apt-get install -y ffmpeg >/dev/null 2>&1 || apt-get install -y ffmpeg >/dev/null 2>&1 || true)"],
          1800,
        );
        steps.push("ffmpeg checked");

        nodeRun(
          run,
          ["exec", targetBox, "sh", "-c",
            `cd ${shQuote(remoteDir)} && npm install --no-audit --no-fund && npx remotion browser ensure && touch .kit-ready`],
          3600,
        );
        steps.push("npm install completed");

        const probe = nodeCapture(
          run,
          ["exec", targetBox, "sh", "-c",
            `cd ${shQuote(remoteDir)} || exit 1; miss=""; ` +
            `[ -x node_modules/.bin/remotion ] || miss="$miss remotion"; ` +
            `command -v flock >/dev/null || miss="$miss flock"; ` +
            `printf '{"cpus":%s,"mem_gb":%s,"disk_gb":%s,"ffmpeg":%s,"studio":%s,"miss":"%s"}\\n' ` +
            `"$(nproc)" "$(awk '/MemAvailable/{printf "%.1f",$2/1048576}' /proc/meminfo)" ` +
            `"$(df -Pk . | awk 'NR==2{printf "%.1f",$4/1048576}')" ` +
            `"$(command -v ffmpeg >/dev/null && echo true || echo false)" ` +
            `"$([ -d node_modules ] && echo true || echo false)" "$miss"`],
          120,
        );
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(probe.trim().split("\n").pop() || "{}") as Record<string, unknown>;
        } catch {
          return {
            ok: false,
            detail: `provisioned ${targetBox}, but the final probe returned invalid JSON: ${probe.trim().slice(-200)}`,
            probe: { ok: false, raw: probe.trim().slice(0, 200) },
          };
        }
        const missing: string[] = [];
        const rawMiss = Array.isArray(parsed.miss)
          ? (parsed.miss as unknown[]).map(String)
          : String(parsed.miss ?? "").split(/\s+/).filter(Boolean);
        missing.push(...rawMiss);
        if (parsed.ffmpeg !== true) missing.push("ffmpeg");
        if (parsed.studio !== true) missing.push("studio");
        const ok = missing.length === 0;
        state.ts = 0;
        return {
          ok,
          detail: ok
            ? `provisioned ${targetBox}: ${steps.join("; ")}`
            : `provisioned ${targetBox} but the probe is still missing: ${missing.join(", ")} (${steps.join("; ")})`,
          probe: { ...parsed, ok, miss: missing },
        };
      } catch (err) {
        return { ok: false, detail: String((err as Error)?.message ?? err) };
      }
    },

    bootstrap(provOpts?: { studio?: string }) {
      return node.provision(provOpts);
    },
  };

  return node;
}
