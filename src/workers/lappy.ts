/**
 * Remote worker bridge: offload heavy CPU stages to the laptop over Tailscale ssh.
 *
 * `MANHWA_RENDER_REMOTE=<ssh host>` (env.sh sets `lappy`) enables it; empty -> VM only.
 * Laptop layout (~/render-worker, NOT the laptop's own ~/manhwa checkout):
 *   studio/     remotion-studio copy (+ its own node_modules)       -> render
 *   (bubble cleaning always runs on the VM via PanelCleaner, never here)
 *   jobs/       per-job scratch, removed after each job
 *
 * `healthy()` is the dispatch gate: nothing is sent unless the laptop answers ssh,
 * has the tools installed, and is idle enough (load, RAM, disk). Two remote
 * failures in a row trip a breaker that keeps work on the VM for `BREAKER_S`.
 *
 * `HEAVY` serialises the VM-side heavy stages (local cleaner batch, local render),
 * so the VM never runs two CPU hogs at once, whichever slot asks.
 *
 * Ported from `pipeline/lappy.py`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

import * as telemetry from "../telemetry/telemetry.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");
/** Studio sources streamed to a fresh remote VM during provision. */
const STUDIO_ARCHIVE_ENTRIES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "remotion.config.ts",
  "src",
  "public",
] as const;

export class RuntimeError extends Error {
  override name = "RuntimeError";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** Stand-in for Python's `shlex.quote`. */
export function shQuote(value: string): string {
  const s = String(value);
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export let HOST: string = String(process.env.MANHWA_RENDER_REMOTE ?? "").trim();
export const RDIR: string = String(process.env.MANHWA_RENDER_REMOTE_DIR ?? "render-worker");
export const SSH: readonly string[] = [
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=6",
];
export const MIN_MEM_GB = 4.0; // cleaner peaks ~3.2 GB
export const MIN_DISK_GB = 5.0;
export const MAX_LOAD = 0.6; // x nproc: above this someone else is using the laptop
export const BREAKER_S = 600;
// Real render concurrency this host can honour: a local render is a CPU hog and
// serializes through HEAVY (one at a time), and the laptop runs one whole-chapter
// job while it also serves the remote cleaner. renderlane clamps persisted slot
// values to this so an advertised bound the transport cannot honour is never
// silently implied (`lane_config.RENDER_TRANSPORT_SLOT_CAP`).
export const MAX_RENDER_SLOTS = 1;

export interface LogLike {
  write(chunk: string): unknown;
  flush?(): unknown;
}

function isPromiseLike<T = unknown>(val: unknown): val is PromiseLike<T> {
  return (
    val !== null &&
    (typeof val === "object" || typeof val === "function") &&
    typeof (val as { then?: unknown }).then === "function"
  );
}

/**
 * Async/sync serialising mutex, the port of Python's `threading.RLock`.
 * Reentrant inside one async context (AsyncLocalStorage), so a nested
 * `withHeavy` inside an already-held heavy section never deadlocks.
 */
export class HeavyMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  tryAcquire(): boolean {
    if (!this.locked) {
      this.locked = true;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
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
    this.locked = false;
  }

  get held(): boolean {
    return this.locked;
  }
}

export const HEAVY = new HeavyMutex();

const heldHeavy = new AsyncLocalStorage<true>();

/**
 * Run `fn` while holding `HEAVY`. Returns the callback's value directly when the
 * callback is synchronous and the mutex is free; otherwise returns a Promise.
 */
export function withHeavy<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (heldHeavy.getStore() === true) {
    return fn();
  }
  if (HEAVY.tryAcquire()) {
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        HEAVY.release();
      }
    };
    let result: T | Promise<T>;
    try {
      result = heldHeavy.run(true, fn);
    } catch (err) {
      release();
      throw err;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(release) as Promise<T>;
    }
    release();
    return result;
  }
  return HEAVY.acquire().then(() => {
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        HEAVY.release();
      }
    };
    let result: T | Promise<T>;
    try {
      result = heldHeavy.run(true, fn);
    } catch (err) {
      release();
      throw err;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(release) as Promise<T>;
    }
    release();
    return result;
  });
}

interface RemoteContext {
  remote: boolean;
}

const defaultRemoteContext: RemoteContext = { remote: false };
const remoteAls = new AsyncLocalStorage<RemoteContext>();

/** True if the current async context's job was dispatched to the laptop. */
export function useRemote(): boolean {
  return (remoteAls.getStore() ?? defaultRemoteContext).remote;
}

/** Run `fn` with the current context's remote flag set to `remote`. */
export function withRemote<T>(remote: boolean, fn: () => T): T {
  return remoteAls.run({ remote: Boolean(remote) }, fn);
}

/**
 * Fallback for callers that never wrap work in `withRemote`: set the remote flag
 * on the current context (or the module-level default binding), matching
 * Python's `lappy._tls.remote = bool(remote)`.
 */
export function setRemoteForThread(remote: boolean): void {
  (remoteAls.getStore() ?? defaultRemoteContext).remote = Boolean(remote);
}

export interface LappyState {
  t: number;
  h: ProbeResult | null;
  fails: number;
  until: number;
  said: string | null;
  // laptop load right after OUR job is ours, not a user
  own_until: number;
}

export interface ProbeResult {
  load?: number;
  cpus?: number;
  mem_gb?: number;
  disk_gb?: number;
  ac?: string;
  miss?: string;
  err?: string;
}

export const _state: LappyState = {
  t: 0.0,
  h: null,
  fails: 0,
  until: 0.0,
  said: null,
  own_until: 0.0,
};

/** Synchronous reentrant guard, the port of Python's `threading.Lock`/RLock. */
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

function nowSeconds(): number {
  return Date.now() / 1000;
}

const PROBE = `set -u; cd ~/${RDIR} 2>/dev/null || { echo '{"err":"no worker dir"}'; exit 0; }
miss=""
[ -x studio/node_modules/.bin/remotion ] || miss="$miss studio"
[ -f cleaner.ready ] || miss="$miss cleaner"   # written only after a verified test clean
command -v rsync >/dev/null || miss="$miss rsync"
printf '{"load":%s,"cpus":%s,"mem_gb":%s,"disk_gb":%s,"ac":"%s","miss":"%s"}\\n' \\
  "$(cut -d' ' -f1 /proc/loadavg)" "$(nproc)" \\
  "$(awk '/MemAvailable/{printf "%.1f",$2/1048576}' /proc/meminfo)" \\
  "$(df -Pk . | awk 'NR==2{printf "%.1f",$4/1048576}')" \\
  "$(cat /sys/class/power_supply/A*/online 2>/dev/null | head -1)" "$miss"
`;

function say(msg: string): void {
  if (_state.said !== msg) {
    _state.said = msg;
    process.stdout.write(`[lappy] ${msg}\n`);
  }
}

/** Injectable subprocess layer (offline unit tests swap it). */
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

export function _setHostForTests(host: string | null): void {
  HOST = host === null ? "" : String(host);
}

function _probe(): ProbeResult | null {
  try {
    const r = processRunner([...SSH, HOST, PROBE], 25);
    if (r.status === 0) {
      const lines = r.stdout.trim().split("\n");
      const last = lines[lines.length - 1] ?? "";
      return JSON.parse(last) as ProbeResult;
    }
  } catch {
    // unreachable
  }
  return null;
}

/**
 * `[ok, reason]` - the dispatch gate. Cached for `maxAge` s (0 = fresh probe).
 * `checkLoad=false` inside a job the laptop is already running for us (its load
 * is our own work, not a reason to pull the next step back).
 */
export function healthy(maxAge = 20, checkLoad = true): [boolean, string] {
  if (!HOST) {
    return [false, "no remote configured"];
  }
  let breaker = false;
  const { now, h } = _slock.run(() => {
    const at = nowSeconds();
    if (at < _state.until) {
      telemetry.worker(HOST, {
        kind: "remote",
        available: false,
        reason: "Circuit breaker open",
        retryAt: _state.until,
      });
      breaker = true;
      return { now: at, h: null as ProbeResult | null };
    }
    if (maxAge <= 0 || at - _state.t >= maxAge) {
      _state.t = at;
      _state.h = _probe();
    }
    return { now: at, h: _state.h };
  });
  if (breaker) {
    return [false, `breaker open (${Math.trunc(_state.until - now)}s left)`];
  }

  let ok: boolean;
  let why: string;
  if (h === null) {
    ok = false;
    why = "unreachable over ssh";
  } else if (h.err) {
    ok = false;
    why = h.err;
  } else if ((h.miss ?? "").trim()) {
    ok = false;
    why = `missing tools:${h.miss}`;
  } else if ((h.mem_gb ?? 0) < MIN_MEM_GB) {
    ok = false;
    why = `low RAM ${h.mem_gb}GB`;
  } else if ((h.disk_gb ?? 0) < MIN_DISK_GB) {
    ok = false;
    why = `low disk ${h.disk_gb}GB`;
  } else if (
    checkLoad &&
    nowSeconds() > _state.own_until &&
    (h.load ?? 0) > MAX_LOAD * (h.cpus ?? 0)
  ) {
    ok = false;
    why = `busy (load ${h.load}/${h.cpus} cpus)`;
  } else {
    ok = true;
    why = h.ac === "0" ? "on battery" : "ok";
  }
  if (!why.startsWith("busy")) {
    say(ok ? `UP (${why})` : `DOWN: ${why}`);
  }
  telemetry.worker(HOST, {
    kind: "remote",
    available: ok,
    reason: why,
    metrics: h ? { load: h.load, cpus: h.cpus, mem_gb: h.mem_gb, disk_gb: h.disk_gb } : null,
    probedAt: now,
  });
  return [ok, why];
}

/** Record a remote job outcome; 2 failures in a row open the breaker. */
export function report(ok: boolean): void {
  _slock.run(() => {
    _state.own_until = nowSeconds() + 180; // 1-min loadavg decays from our job
    if (ok) {
      _state.fails = 0;
      return;
    }
    _state.fails += 1;
    _state.t = 0.0;
    if (_state.fails >= 2) {
      _state.until = nowSeconds() + BREAKER_S;
      _state.fails = 0;
      process.stdout.write(
        `[lappy] breaker OPEN: 2 remote failures, VM-only for ${BREAKER_S}s\n`,
      );
    }
  });
}

/** Reset module state for tests. */
export function _resetStateForTests(): void {
  _state.t = 0.0;
  _state.h = null;
  _state.fails = 0;
  _state.until = 0.0;
  _state.said = null;
  _state.own_until = 0.0;
  defaultRemoteContext.remote = false;
}

function writeLog(log: LogLike | null | undefined, chunk: string): void {
  if (!log) return;
  log.write(chunk);
}

export function run(args: readonly string[], log: LogLike | null, timeout = 900): void {
  const r = processRunner(args, timeout);
  if (r.error) throw r.error;
  writeLog(log, r.stdout);
  writeLog(log, r.stderr);
  if (r.status !== 0) {
    throw new RuntimeError(
      `remote step rc=${r.status}: ${args.slice(0, 4).join(" ").slice(0, 120)}`,
    );
  }
}

export function ssh(cmd: string, log: LogLike | null, timeout = 900): void {
  run([...SSH, HOST, cmd], log, timeout);
}

export interface PushOptions {
  /** `--delete` on the remote tree. Python keyword: `delete`. */
  delete?: boolean;
  del?: boolean;
  exclude?: readonly string[];
}

/**
 * `rsync -a` from here to the laptop.
 * Accepts either the positional Python form `push(src, dst, log, delete, exclude)`
 * or an options object `push(src, dst, log, { delete, exclude })`.
 */
export function push(
  src: string,
  dst: string,
  log: LogLike | null,
  del: boolean | PushOptions = false,
  exclude: readonly string[] = [],
): void {
  const opts: PushOptions = typeof del === "object" && del !== null ? del : { delete: del };
  const delFlag = Boolean(opts.delete ?? opts.del ?? false);
  const excludes = opts.exclude ?? exclude;
  const a = ["rsync", "-a", "-e", SSH.join(" ")];
  if (delFlag) a.push("--delete");
  for (const x of excludes) {
    a.push("--exclude", x);
  }
  run([...a, src, `${HOST}:${dst}`], log);
}

export function pull(src: string, dst: string, log: LogLike | null): void {
  run(["rsync", "-a", "-e", SSH.join(" "), `${HOST}:${src}`, dst], log);
}

export function rm(path: string, log: LogLike | null): void {
  try {
    const r = processRunner([...SSH, HOST, `rm -rf ${shQuote(path)}`], 60);
    if (r.error) return;
    writeLog(log, r.stdout);
    writeLog(log, r.stderr);
  } catch {
    // cleanup must never mask a completed job
  }
}

/* ------------------------------------------------------------------ *
 * Multi-instance SSH nodes (`createSshNode`).
 *
 * Same transport as the singleton above (argv-only ssh/rsync), but every node
 * owns its probe cache, circuit breaker, slot semaphore, and limits. The
 * singleton's `_state`, `HEAVY`, and `HOST` are never touched.
 * ------------------------------------------------------------------ */

export interface SshNodeConfig {
  id: string;
  host: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  identityFile?: string;
  slots?: number;
  supportsCleaner?: boolean;
  maxLoadFactor?: number;
  minMemGb?: number;
  minDiskGb?: number;
}

export interface SshNodeState {
  t: number;
  h: ProbeResult | null;
  fails: number;
  until: number;
  active: number;
  slots: number;
}

export interface SshNode {
  readonly id: string;
  readonly host: string;
  readonly user: string | null;
  readonly port: number | null;
  readonly remoteDir: string;
  readonly supportsCleaner: boolean;
  readonly state: SshNodeState;
  /** Per-node slot semaphore: await before a render, call `release()` after. */
  acquire(): Promise<void>;
  release(): void;
  healthy(force?: boolean, checkLoad?: boolean): [boolean, string];
  run(args: readonly string[], log?: LogLike | null, timeout?: number): void;
  /** Run a remote shell command over ssh (argv-only: ssh, flags, target, cmd). */
  exec(cmd: string, log?: LogLike | null, timeout?: number): void;
  push(src: string, dst: string, log?: LogLike | null, del?: boolean | PushOptions, exclude?: readonly string[]): void;
  pull(src: string, dst: string, log?: LogLike | null): void;
  status(): { ok: boolean; status: string; reason: string; host: string };
  /** Fresh-VM bootstrap: install runtimes, stream the studio, npm install, probe. */
  provision(opts?: { studio?: string }): {
    ok: boolean;
    detail: string;
    probe?: Record<string, unknown>;
  };
  /** Alias of `provision` for a one-click bootstrap. */
  bootstrap(opts?: { studio?: string }): {
    ok: boolean;
    detail: string;
    probe?: Record<string, unknown>;
  };
}

const SSH_HOST_RE = /^[A-Za-z0-9._-]+$/;
const SSH_USER_RE = /^[A-Za-z0-9._-]+$/;
const SSH_REMOTE_DIR_RE = /^[A-Za-z0-9._/~-]+$/;

function sshTargetError(field: string, value: string): RuntimeError {
  return new RuntimeError(`invalid ssh ${field} ${JSON.stringify(value)}`);
}

export function createSshNode(
  cfg: SshNodeConfig,
  runner?: ProcessRunner,
): SshNode {
  const id = String(cfg.id ?? "").trim();
  if (!id) throw new RuntimeError("ssh node id is required");
  const host = String(cfg.host ?? "").trim();
  if (!host || host.startsWith("-") || !SSH_HOST_RE.test(host)) {
    throw sshTargetError("host", host);
  }
  const user = cfg.user === undefined || cfg.user === null || String(cfg.user).trim() === ""
    ? null
    : String(cfg.user).trim();
  if (user !== null && (user.startsWith("-") || !SSH_USER_RE.test(user))) {
    throw sshTargetError("user", user);
  }
  const rawPort = cfg.port;
  let port: number | null = null;
  if (rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== "") {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw sshTargetError("port", String(rawPort));
    }
    port = n;
  }
  const remoteDir = cfg.remoteDir === undefined || cfg.remoteDir === null
    ? "render-worker"
    : String(cfg.remoteDir).trim();
  if (
    !remoteDir ||
    !SSH_REMOTE_DIR_RE.test(remoteDir) ||
    remoteDir.split("/").includes("..") ||
    remoteDir.startsWith("-")
  ) {
    throw sshTargetError("remoteDir", remoteDir);
  }
  // Absolute and `~`-rooted paths are honoured as written; a bare relative path
  // stays relative to the remote `$HOME` (`~/render-worker`).
  const remotePath = remoteDir.startsWith("/") || remoteDir.startsWith("~")
    ? remoteDir
    : `~/${remoteDir}`;
  const identityFile = cfg.identityFile ? String(cfg.identityFile) : "";
  if (identityFile.startsWith("-")) throw sshTargetError("identityFile", identityFile);

  const runProc: ProcessRunner = runner ?? ((args, timeout) => processRunner(args, timeout));
  const slots = Math.max(1, Math.trunc(Number(cfg.slots ?? 1)) || 1);
  const maxLoad = Number.isFinite(cfg.maxLoadFactor) ? Number(cfg.maxLoadFactor) : MAX_LOAD;
  const minMemGb = Number.isFinite(cfg.minMemGb) ? Number(cfg.minMemGb) : MIN_MEM_GB;
  const minDiskGb = Number.isFinite(cfg.minDiskGb) ? Number(cfg.minDiskGb) : MIN_DISK_GB;
  const supportsCleaner = cfg.supportsCleaner !== false;
  const target = user ? `${user}@${host}` : host;

  const state: SshNodeState = {
    t: 0,
    h: null,
    fails: 0,
    until: 0,
    active: 0,
    slots,
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

  const baseSsh: string[] = ["ssh"];
  if (port !== null) baseSsh.push("-p", String(port));
  if (identityFile) baseSsh.push("-i", identityFile);
  baseSsh.push(
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=6",
  );

  const probeScript = PROBE.replace(`cd ~/${RDIR}`, `cd ${remotePath}`);

  const probe = (): ProbeResult | null => {
    try {
      const r = runProc([...baseSsh, target, probeScript], 25);
      if (r.status === 0) {
        const lines = r.stdout.trim().split("\n");
        const last = lines[lines.length - 1] ?? "";
        return JSON.parse(last) as ProbeResult;
      }
    } catch {
      // unreachable
    }
    return null;
  };

  const say = (msg: string): void => {
    process.stdout.write(`[ssh ${id}] ${msg}\n`);
  };

  const report = (ok: boolean): void => {
    if (ok) {
      state.fails = 0;
      return;
    }
    state.fails += 1;
    state.t = 0;
    if (state.fails >= 2) {
      state.until = nowSeconds() + BREAKER_S;
      state.fails = 0;
      process.stdout.write(`[ssh ${id}] breaker OPEN: 2 remote failures, ${BREAKER_S}s\n`);
    }
  };

  const runArgs = (args: readonly string[], log: LogLike | null | undefined, timeout: number): void => {
    const r = runProc(args, timeout);
    if (r.error) throw r.error;
    writeLog(log, r.stdout);
    writeLog(log, r.stderr);
    if (r.status !== 0) {
      throw new RuntimeError(
        `remote step rc=${r.status}: ${args.slice(0, 4).join(" ").slice(0, 120)}`,
      );
    }
  };

  const node: SshNode = {
    id,
    host,
    user,
    port,
    remoteDir,
    supportsCleaner,
    state,

    acquire(): Promise<void> {
      return acquire();
    },

    release(): void {
      release();
    },

    healthy(force = false, checkLoad = true): [boolean, string] {
      const at = nowSeconds();
      if (at < state.until) {
        const reason = `breaker open (${Math.trunc(state.until - at)}s left)`;
        telemetry.worker(id, {
          kind: "remote",
          available: false,
          reason: "Circuit breaker open",
          retryAt: state.until,
        });
        return [false, reason];
      }
      if (force || state.t === 0 || at - state.t >= 20) {
        state.t = at;
        state.h = probe();
      }
      const h = state.h;
      // A custom node that does not run the cleaner must not fail readiness for it:
      // only the render environment (`studio/` + rsync) is required there.
      const missing = (h?.miss ?? "")
        .split(/\s+/)
        .filter((token) => token && (supportsCleaner || token !== "cleaner"))
        .join(" ");
      let ok: boolean;
      let why: string;
      if (h === null) {
        ok = false;
        why = "unreachable over ssh";
        report(false);
      } else if (h.err) {
        ok = false;
        why = h.err;
        report(false);
      } else if (missing) {
        ok = false;
        why = `missing tools:${missing}`;
      } else if ((h.mem_gb ?? 0) < minMemGb) {
        ok = false;
        why = `low RAM ${h.mem_gb}GB`;
      } else if ((h.disk_gb ?? 0) < minDiskGb) {
        ok = false;
        why = `low disk ${h.disk_gb}GB`;
      } else if (checkLoad && (h.load ?? 0) > maxLoad * (h.cpus ?? 0)) {
        ok = false;
        why = `busy (load ${h.load}/${h.cpus} cpus)`;
      } else {
        ok = true;
        why = h.ac === "0" ? "on battery" : "ok";
      }
      if (!why.startsWith("busy")) say(ok ? `UP (${why})` : `DOWN: ${why}`);
      telemetry.worker(id, {
        kind: "remote",
        available: ok,
        reason: why,
        metrics: h ? { load: h.load, cpus: h.cpus, mem_gb: h.mem_gb, disk_gb: h.disk_gb } : null,
        probedAt: at,
      });
      return [ok, why];
    },

    run(args: readonly string[], log?: LogLike | null, timeout = 900): void {
      state.active += 1;
      try {
        runArgs(args, log, timeout);
      } finally {
        state.active = Math.max(0, state.active - 1);
      }
    },

    exec(cmd: string, log?: LogLike | null, timeout = 900): void {
      node.run([...baseSsh, target, cmd], log, timeout);
    },

    push(
      src: string,
      dst: string,
      log?: LogLike | null,
      del: boolean | PushOptions = false,
      exclude: readonly string[] = [],
    ): void {
      const pushOpts: PushOptions = typeof del === "object" && del !== null ? del : { delete: del };
      const delFlag = Boolean(pushOpts.delete ?? pushOpts.del ?? false);
      const excludes = pushOpts.exclude ?? exclude;
      const sshArgs = [...baseSsh].join(" ");
      const args = ["rsync", "-a", "-e", sshArgs];
      if (delFlag) args.push("--delete");
      for (const x of excludes) args.push("--exclude", x);
      args.push(src, `${target}:${dst}`);
      runArgs(args, log, 900);
    },

    pull(src: string, dst: string, log?: LogLike | null): void {
      const sshArgs = [...baseSsh].join(" ");
      runArgs(["rsync", "-a", "-e", sshArgs, `${target}:${src}`, dst], log, 900);
    },

    status(): { ok: boolean; status: string; reason: string; host: string } {
      const at = nowSeconds();
      let status: string;
      if (at < state.until) status = "breaker-open";
      else if (state.t === 0) status = "unknown";
      else if (state.active > 0) status = "busy";
      else status = state.h ? "available" : "unavailable";
      const miss = String(state.h?.miss ?? "")
        .split(/\s+/)
        .filter((m) => Boolean(m) && (supportsCleaner || m !== "cleaner"));
      const ok = Boolean(state.h && !state.h.err && status !== "breaker-open" && miss.length === 0);
      const reason = state.h?.err ?? state.h?.miss ?? (state.h ? "ok" : "not probed");
      return { ok, status, reason, host };
    },

    /**
     * Fresh-VM bootstrap for an Ubuntu/Debian host that only has `host`, `user`
     * and `sshKey`: accept the first host key, install node/ffmpeg + Chromium
     * libs, stream the studio over tar, npm install, then probe.
     */
    provision(provOpts?: { studio?: string }) {
      const studio = String(
        provOpts?.studio || process.env.MANHWA_STUDIO || path.join(REPO_ROOT, "remotion-studio"),
      ).replace(/\/+$/, "");
      const steps: string[] = [];
      // A fresh VM has no known_hosts entry: accept the first key for this flow only.
      const bootstrapSsh = [...baseSsh, "-o", "StrictHostKeyChecking=accept-new"];
      const runBootstrap = (args: readonly string[], timeout: number): RawResult => runProc(args, timeout);
      // Quote a remote path for the shell, but keep a leading `~/` expandable.
      const qpath = (p: string): string => {
        if (p === "~") return "~";
        if (p.startsWith("~/")) return `~/${shQuote(p.slice(2))}`;
        return shQuote(p);
      };
      try {
        const mkdir = runBootstrap(
          [...bootstrapSsh, target,
            `mkdir -p ${qpath(`${remotePath}/studio`)} ${qpath(`${remotePath}/jobs`)}` +
            ` && { [ -L ${qpath(`${remotePath}/remotion-studio`)} ] || { rm -rf ${qpath(`${remotePath}/remotion-studio`)}; ln -sfn ${qpath(`${remotePath}/studio`)} ${qpath(`${remotePath}/remotion-studio`)}; }; }`],
          120,
        );
        if (mkdir.status !== 0) {
          return {
            ok: false,
            detail: `cannot reach ${target}: ${(mkdir.stderr || mkdir.stdout).slice(-200).trim()}`,
          };
        }
        steps.push(`created ${remotePath}/studio (with a remotion-studio symlink) and ${remotePath}/jobs`);

        const installScript = [
          "set -u",
          "have() { command -v \"$1\" >/dev/null 2>&1; }",
          "SUDO=''",
          "if [ \"$(id -u)\" != '0' ] && have sudo; then SUDO='sudo -n'; fi",
          "if ! have ffmpeg || ! have rsync || ! have node || ! have npm; then",
          "  if $SUDO apt-get update -y >/dev/null 2>&1 || apt-get update -y >/dev/null 2>&1; then",
          "    $SUDO apt-get install -y ffmpeg rsync nodejs npm >/dev/null 2>&1 || apt-get install -y ffmpeg rsync nodejs npm >/dev/null 2>&1 || true",
          "    $SUDO apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxkbcommon0 libxdamage1 libxfixes3 libxrandr2 >/dev/null 2>&1 || true",
          "  fi",
          "fi",
          "if have node; then node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)' || echo 'node < 20 on the remote host' >&2; fi",
          "have ffmpeg || echo 'ffmpeg missing on the remote host' >&2",
          "have rsync || echo 'rsync missing on the remote host' >&2",
          "true",
        ].join("\n");
        runBootstrap([...bootstrapSsh, target, installScript], 1800);
        steps.push("runtime packages checked");

        const present = STUDIO_ARCHIVE_ENTRIES.filter((entry) =>
          fs.existsSync(path.join(studio, entry)));
        if (present.length === 0) {
          return { ok: false, detail: `no studio sources found under ${studio}` };
        }
        const archive = path.join(
          fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "ssh-provision-")),
          "studio.tar.gz",
        );
        try {
          const tar = runBootstrap(
            ["tar", "-czf", archive, "-C", studio, "--exclude=node_modules", ...present],
            600,
          );
          if (tar.status !== 0) {
            return { ok: false, detail: `local tar failed: ${tar.stderr.slice(-200).trim()}` };
          }
          const copy = runBootstrap(
            ["scp", "-q", "-o", "StrictHostKeyChecking=accept-new", ...(port !== null ? ["-P", String(port)] : []),
              ...(identityFile ? ["-i", identityFile] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
              archive, `${target}:${remotePath}/studio.tar.gz`],
            900,
          );
          if (copy.status !== 0) {
            return { ok: false, detail: `studio upload failed: ${(copy.stderr || copy.stdout).slice(-200).trim()}` };
          }
          const extract = runBootstrap(
            [...bootstrapSsh, target,
              `tar -xzf ${qpath(`${remotePath}/studio.tar.gz`)} -C ${qpath(`${remotePath}/studio`)} && rm -f ${qpath(`${remotePath}/studio.tar.gz`)}`],
            600,
          );
          if (extract.status !== 0) {
            return { ok: false, detail: `studio extract failed: ${(extract.stderr || extract.stdout).slice(-200).trim()}` };
          }
          steps.push(`streamed studio sources (${present.join(", ")})`);
        } finally {
          try {
            fs.rmSync(path.dirname(archive), { recursive: true, force: true });
          } catch {
            // best effort
          }
        }

        const install = runBootstrap(
          [...bootstrapSsh, target,
            `cd ${qpath(`${remotePath}/studio`)} && npm install --no-audit --no-fund`],
          3600,
        );
        if (install.status !== 0) {
          return {
            ok: false,
            detail: `npm install failed on ${target}: ${(install.stderr || install.stdout).slice(-300).trim()}`,
          };
        }
        steps.push("npm install completed");

        const probeRes = runBootstrap([...bootstrapSsh, target, probeScript], 120);
        const probeText = probeRes.stdout.trim().split("\n").pop() || "";
        if (probeRes.status !== 0) {
          return {
            ok: false,
            detail:
              `provisioned ${target} but the final probe exited ${probeRes.status}: ` +
              `${(probeRes.stderr || probeRes.stdout).trim().slice(-300)} (${steps.join("; ")})`,
            probe: { ok: false, raw: probeText.slice(0, 200) },
          };
        }
        let probe: Record<string, unknown>;
        try {
          probe = JSON.parse(probeText || "{}") as Record<string, unknown>;
        } catch {
          return {
            ok: false,
            detail: `provisioned ${target} but the final probe returned invalid JSON: ${probeText.slice(-200)}`,
            probe: { ok: false, raw: probeText.slice(0, 200) },
          };
        }
        const missing = (Array.isArray(probe.miss)
          ? (probe.miss as unknown[]).map(String).filter(Boolean)
          : String(probe.miss ?? "").split(/\s+/).filter(Boolean))
          .filter((m) => Boolean(m) && (supportsCleaner || m !== "cleaner"));
        state.t = 0;
        const probeOk = Boolean(probe && !probe.err && missing.length === 0);
        if (!probeOk) {
          if (probe.err) {
            return {
              ok: false,
              detail: `provisioned ${target} but the final probe reported an error: ${String(probe.err).slice(0, 200)} (${steps.join("; ")})`,
              probe: { ...probe, ok: false },
            };
          }
          return {
            ok: false,
            detail: `provisioned ${target} but the probe is still missing: ${missing.join(", ")} (${steps.join("; ")})`,
            probe: { ...probe, ok: false, miss: missing },
          };
        }
        // A freshly provisioned node must not stay blocked by an earlier breaker trip.
        state.fails = 0;
        state.until = 0;
        return {
          ok: true,
          detail: `provisioned ${target}: ${steps.join("; ")}`,
          probe: { ...probe, ok: true },
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
