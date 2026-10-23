/**
 * Render lane - timeline (TTS/cleaner/shots) + Remotion render, per chapter.
 *
 * run.ts --video pipelines chapters through this module:
 *   script lane (serial): reader -> bible -> writer -> fact_check
 *   video lane: chapter -> free slot -> timeline + render -> out/<ch>/video/video.mp4
 *
 * Two chapter slots (2026-09-28, shair's laptop bridge, see lappy.ts):
 *   - lappy: whole chapter's heavy work on the laptop (bubble cleaner + Remotion,
 *     ~2.4x realtime render vs ~4.3x here). TTS / LLM verify stay on this box
 *     (network-bound). Only dispatched when lappy.healthy() passes.
 *   - local: this VM. Takes a chapter when the laptop is busy, down, or failing.
 *   So cp1 cleans/renders on one machine while cp2 does the same on the other.
 *   Any remote step that fails falls back to this box for that step. Local heavy
 *   stages share lappy.HEAVY, so the VM never stacks two CPU hogs.
 *   MANHWA_RENDER_REMOTE= (empty) -> old single local worker.
 *
 *   Optional render-only overflow: MANHWA_RENDER_CLOUD=<sbx name>. After preparation,
 *   try the assigned healthy laptop, then Docker cloud, then local. A second LOCAL
 *   preparation consumer feeds the sandbox's two render slots when enabled. Cloud
 *   never cleans; local heavy stages still serialize through lappy.HEAVY.
 *
 *   Persisted render lanes (Chunk C1, config/renderPolicy.ts): when a VALID
 *   lanes.json exists, the persisted render array (order, enabled, slots) drives
 *   selection instead of the env switches above. Order is the array order; a
 *   disabled lane is never selected or used as a fallback; each lane's real
 *   concurrency is `slots` clamped to the transport cap. With NO persisted config
 *   the legacy path below runs unchanged (including an explicitly env-enabled cloud
 *   lane, which the catalog's `cloud: enabled=false` default must not disable).
 *   MANHWA_RENDER_LANE=inherit|local|laptop|cloud is the validated per-run override:
 *   a pinned lane must be configured AND enabled and never falls back elsewhere.
 *
 *   standalone: npx tsx src/workers/renderlane.ts <series> <ch> [ch...]   (assumes scripts exist)
 *
 * Ported from `pipeline/renderlane.py`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as renderPolicyMod from "../config/renderPolicy.js";
import { RenderOverrideError, type PlanLane, type RenderPlan } from "../config/renderPolicy.js";
import { getStudioSettings, type RenderQuality } from "../config/studioConfig.js";
import { assertNoSymlinkPath, languageChapterDir, SUPPORTED_LOCALES, validateLocale } from "../config/languages.js";
import { pyFloatRepr } from "../contracts/hashes.js";
import { pyRoundFixed } from "../stages/factCheck.js";
import { withSharedSeriesLock } from "../locks/seriesLock.js";
import * as telemetryMod from "../telemetry/telemetry.js";
import { failClass, failureNote, type FailClass } from "../domain/failure.js";
import * as cloudlaneMod from "./cloudlane.js";
import * as lappyMod from "./lappy.js";
import * as nodeRegistryMod from "./nodeRegistry.js";

export { RenderOverrideError };
export type { PlanLane, RenderPlan };

export class RuntimeError extends Error {
  override name = "RuntimeError";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export const DOC = `Render lane - timeline (TTS/cleaner/shots) + Remotion render, per chapter.

run.py --video pipelines chapters through this module:
  script lane (serial): reader -> bible -> writer -> fact_check
  video lane: chapter -> free slot -> timeline + render -> out/<ch>/video/video.mp4

Two chapter slots (2026-09-28, shair's laptop bridge, see lappy.py):
  - lappy: whole chapter's heavy work on the laptop (bubble cleaner + Remotion,
    ~2.4x realtime render vs ~4.3x here). TTS / LLM verify stay on this box
    (network-bound). Only dispatched when lappy.healthy() passes.
  - local: this VM. Takes a chapter when the laptop is busy, down, or failing.
  So cp1 cleans/renders on one machine while cp2 does the same on the other.
  Any remote step that fails falls back to this box for that step. Local heavy
  stages share lappy.HEAVY, so the VM never stacks two CPU hogs.
  MANHWA_RENDER_REMOTE= (empty) -> old single local worker.

  Optional render-only overflow: MANHWA_RENDER_CLOUD=<sbx name>. After preparation,
  try the assigned healthy laptop, then Docker cloud, then local. A second LOCAL
  preparation consumer feeds the sandbox's two render slots when enabled. Cloud
  never cleans; local heavy stages still serialize through lappy.HEAVY.

  Persisted render lanes (Chunk C1, pipeline/render_policy.py): when a VALID
  lanes.json exists, the persisted render array (order, enabled, slots) drives
  selection instead of the env switches above. Order is the array order; a
  disabled lane is never selected or used as a fallback; each lane's real
  concurrency is \`slots\` clamped to the transport cap. With NO persisted config
  the legacy path below runs unchanged (including an explicitly env-enabled cloud
  lane, which the catalog's \`cloud: enabled=false\` default must not disable).
  MANHWA_RENDER_LANE=inherit|local|laptop|cloud is the validated per-run override:
  a pinned lane must be configured AND enabled and never falls back elsewhere.

  standalone: python3 renderlane.py <series> <ch> [ch...]   (assumes scripts exist)
`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_STUDIO = path.join(REPO_ROOT, "remotion-studio");
const DEFAULT_SERIES_ROOT = path.join(REPO_ROOT, "series");
export let STUDIO: string = process.env.MANHWA_STUDIO || DEFAULT_STUDIO;

export function _setStudioForTests(studio: string | null): void {
  STUDIO = studio === null ? (process.env.MANHWA_STUDIO || DEFAULT_STUDIO) : String(studio);
}

/* ------------------------------------------------------------------ *
 * Queue & Sync / Async helpers
 * ------------------------------------------------------------------ */

function isPromiseLike<T = unknown>(val: unknown): val is PromiseLike<T> {
  return (
    val !== null &&
    (typeof val === "object" || typeof val === "function") &&
    typeof (val as { then?: unknown }).then === "function"
  );
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("'") && !value.includes('"')) return `"${value}"`;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .map((k) => `${pyRepr(k)}: ${pyRepr(obj[k])}`)
      .join(", ")}}`;
  }
  return String(value);
}

export class QueueEmpty extends Error {
  override name = "QueueEmpty";
  constructor(message = "Queue is empty") {
    super(message);
    this.name = "QueueEmpty";
  }
}

export interface QueueLike<T = string | null> {
  put(item: T): void;
  push?(item: T): void;
  get?(timeoutSec?: number): Promise<T> | T;
  get_nowait?(): T;
  getNowait?(): T;
  shift?(): T | undefined;
  empty?(): boolean;
  qsize?(): number;
  length?: number;
  task_done?(): void;
  taskDone?(): void;
  join?(): Promise<void> | void;
  unfinished_tasks?: number;
  unfinishedTasks?: number;
}

/**
 * Port of Python's `queue.Queue`. Works with both async consumers (`await q.get(timeout)`)
 * and synchronous callers (`q.put(item)`, `q.getNowait()`, `q.taskDone()`, `await q.join()`).
 */
export class RenderQueue<T = string | null> implements QueueLike<T> {
  private items: T[] = [];
  private getters: Array<{
    resolve: (item: T) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private joinWaiters: Array<() => void> = [];
  public unfinished_tasks = 0;

  get unfinishedTasks(): number {
    return this.unfinished_tasks;
  }

  get length(): number {
    return this.items.length;
  }

  put(item: T): void {
    this.unfinished_tasks += 1;
    const waiter = this.getters.shift();
    if (waiter) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  push(item: T): void {
    this.put(item);
  }

  getNowait(): T {
    if (this.items.length === 0) {
      throw new QueueEmpty();
    }
    return this.items.shift() as T;
  }

  get_nowait(): T {
    return this.getNowait();
  }

  shift(): T | undefined {
    if (this.items.length === 0) return undefined;
    return this.items.shift();
  }

  get(timeoutSec?: number): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (item: T) => void; timer?: ReturnType<typeof setTimeout> } = {
        resolve,
      };
      if (timeoutSec !== undefined && Number.isFinite(timeoutSec)) {
        entry.timer = setTimeout(() => {
          const idx = this.getters.indexOf(entry);
          if (idx >= 0) this.getters.splice(idx, 1);
          reject(new QueueEmpty());
        }, Math.max(0, timeoutSec) * 1000);
      }
      this.getters.push(entry);
    });
  }

  empty(): boolean {
    return this.items.length === 0;
  }

  qsize(): number {
    return this.items.length;
  }

  taskDone(): void {
    const next = this.unfinished_tasks - 1;
    if (next < 0) {
      throw new Error("task_done() called too many times");
    }
    this.unfinished_tasks = next;
    if (this.unfinished_tasks === 0) {
      const waiters = this.joinWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  task_done(): void {
    this.taskDone();
  }

  join(): Promise<void> {
    if (this.unfinished_tasks === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.joinWaiters.push(resolve);
    });
  }
}

export { RenderQueue as Queue };

function normalizeQueue<T = string | null>(q: QueueLike<T> | T[]): RenderQueue<T> & { raw: QueueLike<T> | T[] } {
  if (q instanceof RenderQueue) {
    return Object.assign(q, { raw: q });
  }
  if (Array.isArray(q)) {
    const rq = new RenderQueue<T>();
    for (const item of q.splice(0)) {
      rq.put(item);
    }
    return Object.assign(rq, { raw: q });
  }
  const rq = new RenderQueue<T>();
  const raw = q as QueueLike<T> & { items?: T[]; _items?: T[] };
  // Drain any pre-populated array-backed custom queue or wrap methods
  const wrapper = {
    raw: q,
    get unfinished_tasks(): number {
      return (
        (q as { unfinished_tasks?: number }).unfinished_tasks ??
        (q as { unfinishedTasks?: number }).unfinishedTasks ??
        rq.unfinished_tasks
      );
    },
    set unfinished_tasks(v: number) {
      if ("unfinished_tasks" in q) (q as { unfinished_tasks: number }).unfinished_tasks = v;
      if ("unfinishedTasks" in q) (q as { unfinishedTasks: number }).unfinishedTasks = v;
      rq.unfinished_tasks = v;
    },
    get unfinishedTasks(): number {
      return wrapper.unfinished_tasks;
    },
    get length(): number {
      return wrapper.qsize();
    },
    put(item: T): void {
      if (typeof q.put === "function") {
        q.put(item);
        return;
      }
      if (typeof q.push === "function") {
        q.push(item);
        return;
      }
      rq.put(item);
    },
    push(item: T): void {
      wrapper.put(item);
    },
    getNowait(): T {
      if (typeof q.get_nowait === "function") return q.get_nowait();
      if (typeof q.getNowait === "function") return q.getNowait();
      if (typeof q.shift === "function") {
        if (wrapper.empty()) throw new QueueEmpty();
        return q.shift() as T;
      }
      if (Array.isArray(raw.items)) {
        if (raw.items.length === 0) throw new QueueEmpty();
        return raw.items.shift() as T;
      }
      if (Array.isArray(raw._items)) {
        if (raw._items.length === 0) throw new QueueEmpty();
        return raw._items.shift() as T;
      }
      return rq.getNowait();
    },
    get_nowait(): T {
      return wrapper.getNowait();
    },
    shift(): T | undefined {
      try {
        return wrapper.getNowait();
      } catch {
        return undefined;
      }
    },
    async get(timeoutSec?: number): Promise<T> {
      if (typeof q.get === "function") {
        const res = q.get(timeoutSec);
        return isPromiseLike(res) ? await res : res;
      }
      const deadline =
        timeoutSec !== undefined && Number.isFinite(timeoutSec)
          ? _hooks.time.now() + Math.max(0, timeoutSec)
          : Number.POSITIVE_INFINITY;
      for (;;) {
        try {
          return wrapper.getNowait();
        } catch (err) {
          if (_hooks.time.now() >= deadline) throw err;
          await _hooks.time.sleep(0.01);
        }
      }
    },
    empty(): boolean {
      if (typeof q.empty === "function") return q.empty();
      if (typeof q.qsize === "function") return q.qsize() === 0;
      if (typeof q.length === "number") return q.length === 0;
      if (Array.isArray(raw.items)) return raw.items.length === 0;
      if (Array.isArray(raw._items)) return raw._items.length === 0;
      return rq.empty();
    },
    qsize(): number {
      if (typeof q.qsize === "function") return q.qsize();
      if (typeof q.length === "number") return q.length;
      if (Array.isArray(raw.items)) return raw.items.length;
      if (Array.isArray(raw._items)) return raw._items.length;
      return rq.qsize();
    },
    taskDone(): void {
      if (typeof q.task_done === "function") {
        q.task_done();
        return;
      }
      if (typeof q.taskDone === "function") {
        q.taskDone();
        return;
      }
      if (typeof (q as { unfinished_tasks?: number }).unfinished_tasks === "number") {
        (q as { unfinished_tasks: number }).unfinished_tasks = Math.max(
          0,
          (q as { unfinished_tasks: number }).unfinished_tasks - 1,
        );
      }
      if (typeof (q as { unfinishedTasks?: number }).unfinishedTasks === "number") {
        (q as { unfinishedTasks: number }).unfinishedTasks = Math.max(
          0,
          (q as { unfinishedTasks: number }).unfinishedTasks - 1,
        );
      }
    },
    task_done(): void {
      wrapper.taskDone();
    },
    async join(): Promise<void> {
      if (typeof q.join === "function") {
        const r = q.join();
        if (isPromiseLike(r)) await r;
        return;
      }
      await rq.join();
    },
  };
  return wrapper as unknown as RenderQueue<T> & { raw: QueueLike<T> | T[] };
}

/* ------------------------------------------------------------------ *
 * Subprocess & Time & Hooks layer
 * ------------------------------------------------------------------ */

export interface SubprocessResult {
  returncode: number;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface SubprocessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  captureOutput?: boolean;
  capture_output?: boolean;
  text?: boolean;
  stdoutFd?: number | null;
  stdoutPath?: string | null;
}

function defaultSubprocessRun(
  args: readonly string[],
  options: SubprocessRunOptions = {},
): SubprocessResult {
  const timeoutMs =
    options.timeout !== undefined && Number.isFinite(options.timeout)
      ? options.timeout * 1000
      : undefined;

  if (options.stdoutFd !== undefined && options.stdoutFd !== null) {
    const res = spawnSync(args[0] as string, args.slice(1), {
      cwd: options.cwd,
      env: options.env,
      timeout: timeoutMs,
      stdio: ["ignore", options.stdoutFd, options.stdoutFd],
    });
    return {
      returncode: res.status ?? 1,
      status: res.status,
      stdout: "",
      stderr: "",
      error: res.error ?? undefined,
    };
  }

  const res = spawnSync(args[0] as string, args.slice(1), {
    cwd: options.cwd,
    env: options.env,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    // A signal-killed child has status === null: never report that as success.
    returncode: res.status ?? 1,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? undefined,
  };
}

export const subprocess = {
  run: defaultSubprocessRun,
};

export const time = {
  now(): number {
    return Date.now() / 1000;
  },
  time(): number {
    return Date.now() / 1000;
  },
  sleep(seconds: number): Promise<void> {
    const ms =
      process.env.VITEST || process.env.MANHWA_FAST_RENDERLANE_POLL === "1"
        ? Math.min(Math.max(0, seconds) * 1000, 15)
        : Math.max(0, seconds) * 1000;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

export interface LappyHookLike {
  HOST: string;
  RDIR: string;
  HEAVY: lappyMod.HeavyMutex;
  withHeavy: typeof lappyMod.withHeavy;
  withRemote?: typeof lappyMod.withRemote;
  useRemote: () => boolean;
  use_remote?: () => boolean;
  setRemoteForThread: (remote: boolean) => void;
  healthy: (maxAge?: number, checkLoad?: boolean) => [boolean, string];
  report: (ok: boolean) => void;
  ssh: typeof lappyMod.ssh;
  push: typeof lappyMod.push;
  pull: typeof lappyMod.pull;
  rm: typeof lappyMod.rm;
  _tls?: { remote: boolean };
}

export interface CloudlaneHookLike {
  NAME: string;
  STUDIO: string;
  healthy: (maxAge?: number) => [boolean, string];
  report: (ok: boolean) => void;
  render: (
    props: string,
    video: string,
    studio: string,
    log?: cloudlaneMod.LogLike | null,
  ) => void | Promise<void>;
}

export interface RenderPolicyHookLike {
  RenderOverrideError: typeof RenderOverrideError;
  resolveRenderPlan: typeof renderPolicyMod.resolveRenderPlan;
  resolve_render_plan?: typeof renderPolicyMod.resolveRenderPlan;
  eligibleLanes: typeof renderPolicyMod.eligibleLanes;
  eligible_lanes?: typeof renderPolicyMod.eligibleLanes;
  laneAvailability: typeof renderPolicyMod.laneAvailability;
  lane_availability?: typeof renderPolicyMod.laneAvailability;
  fallbackChain?: typeof renderPolicyMod.fallbackChain;
  fallback_chain?: typeof renderPolicyMod.fallbackChain;
  resetRenderPlan: typeof renderPolicyMod.resetRenderPlan;
  reset_render_plan?: typeof renderPolicyMod.resetRenderPlan;
  setTransportDefaults: typeof renderPolicyMod.setTransportDefaults;
  setHealthProbes: typeof renderPolicyMod.setHealthProbes;
}

function createDefaultLappyProxy(): LappyHookLike {
  const tlsProxy = {
    get remote(): boolean {
      return lappyMod.useRemote();
    },
    set remote(v: boolean) {
      lappyMod.setRemoteForThread(Boolean(v));
    },
  };
  return {
    get HOST(): string {
      return lappyMod.HOST;
    },
    set HOST(v: string) {
      lappyMod._setHostForTests(v);
    },
    get RDIR(): string {
      return lappyMod.RDIR;
    },
    HEAVY: lappyMod.HEAVY,
    withHeavy: (...args) => lappyMod.withHeavy(...args),
    withRemote: (remote, fn) => lappyMod.withRemote(remote, fn),
    useRemote: () => lappyMod.useRemote(),
    use_remote: () => lappyMod.useRemote(),
    setRemoteForThread: (remote: boolean) => lappyMod.setRemoteForThread(remote),
    healthy: (maxAge?: number, checkLoad?: boolean) => lappyMod.healthy(maxAge, checkLoad),
    report: (ok: boolean) => lappyMod.report(ok),
    ssh: (cmd, log, timeout) => lappyMod.ssh(cmd, log, timeout),
    push: (src, dst, log, del, exclude) => lappyMod.push(src, dst, log, del, exclude),
    pull: (src, dst, log) => lappyMod.pull(src, dst, log),
    rm: (p, log) => lappyMod.rm(p, log),
    _tls: tlsProxy,
  };
}

function createDefaultCloudlaneProxy(): CloudlaneHookLike {
  return {
    get NAME(): string {
      return cloudlaneMod.NAME;
    },
    set NAME(v: string) {
      cloudlaneMod._setNameForTests(v);
    },
    get STUDIO(): string {
      return cloudlaneMod.STUDIO;
    },
    set STUDIO(v: string) {
      cloudlaneMod._setStudioForTests(v);
    },
    healthy: (maxAge?: number) => cloudlaneMod.healthy(maxAge),
    report: (ok: boolean) => cloudlaneMod.report(ok),
    render: (props, video, studio, log) => cloudlaneMod.render(props, video, studio, log),
  };
}

function createDefaultRenderPolicyProxy(): RenderPolicyHookLike {
  return {
    RenderOverrideError: renderPolicyMod.RenderOverrideError,
    resolveRenderPlan: (...args) => {
      syncPolicyTransports();
      return renderPolicyMod.resolveRenderPlan(...args);
    },
    get resolve_render_plan() {
      return this.resolveRenderPlan;
    },
    set resolve_render_plan(fn) {
      if (fn) this.resolveRenderPlan = fn;
    },
    eligibleLanes: (plan) => renderPolicyMod.eligibleLanes(plan),
    get eligible_lanes() {
      return this.eligibleLanes;
    },
    set eligible_lanes(fn) {
      if (fn) this.eligibleLanes = fn;
    },
    laneAvailability: (plan, probes) => {
      syncPolicyTransports();
      const avail = renderPolicyMod.laneAvailability(
        plan,
        probes ?? {
          laptop: () => callLappyHealthy(20, true),
          cloud: () => callCloudHealthy(20),
        },
      );
      // Inherit routing must not hand a chapter to an offline custom node: the
      // policy above reports every custom id as available. A pinned plan is an
      // explicit operator choice and _renderOnLane probes it (healthy(true)),
      // failing fast instead of waiting out the unavailable grace.
      if (!probes && !plan.override) {
        for (const lane of renderPolicyMod.eligibleLanes(plan)) {
          if (lane.id !== "local" && lane.id !== "laptop" && lane.id !== "cloud") {
            const node = nodeRegistryMod.getNodeInstance(lane.id);
            if (node) avail[lane.id] = node.healthy(false);
          }
        }
      }
      return avail;
    },
    get lane_availability() {
      return this.laneAvailability;
    },
    set lane_availability(fn) {
      if (fn) this.laneAvailability = fn;
    },
    fallbackChain: (plan, lane) => renderPolicyMod.fallbackChain(plan, lane),
    get fallback_chain() {
      return this.fallbackChain;
    },
    set fallback_chain(fn) {
      if (fn) this.fallbackChain = fn;
    },
    resetRenderPlan: () => renderPolicyMod.resetRenderPlan(),
    get reset_render_plan() {
      return this.resetRenderPlan;
    },
    set reset_render_plan(fn) {
      if (fn) this.resetRenderPlan = fn;
    },
    setTransportDefaults: (next) => renderPolicyMod.setTransportDefaults(next),
    setHealthProbes: (next) => renderPolicyMod.setHealthProbes(next),
  };
}

export const lappy: LappyHookLike = createDefaultLappyProxy();
export const cloudlane: CloudlaneHookLike = createDefaultCloudlaneProxy();
export const renderPolicy: RenderPolicyHookLike = createDefaultRenderPolicyProxy();
export const render_policy = renderPolicy;

function syncPolicyTransports(): void {
  const activeLappy = _hooks.lappy;
  const activeCloud = _hooks.cloudlane;
  renderPolicyMod.setTransportDefaults({
    laptopHost: activeLappy.HOST,
    cloudName: activeCloud.NAME,
  });
}

function callLappyUseRemote(): boolean {
  const lp = _hooks.lappy as LappyHookLike & { use_remote?: () => boolean };
  if (lp.useRemote && lp.useRemote !== defaultUseRemoteCamelRef) {
    return lp.useRemote();
  }
  if (lp.use_remote && lp.use_remote !== defaultUseRemoteRef) {
    return lp.use_remote();
  }
  return lp.useRemote();
}

function callLappyHealthy(maxAge?: number, checkLoad?: boolean): [boolean, string] {
  const lp = _hooks.lappy;
  if (maxAge === undefined && checkLoad === undefined) {
    return lp.healthy();
  }
  return lp.healthy(maxAge, checkLoad);
}

function callCloudHealthy(maxAge?: number): [boolean, string] {
  const cl = _hooks.cloudlane;
  if (maxAge === undefined) {
    return cl.healthy();
  }
  return cl.healthy(maxAge);
}

/* ------------------------------------------------------------------ *
 * Core renderlane functions
 * ------------------------------------------------------------------ */

export interface PrepareOptions {
  /** Language version to prepare (`hi-IN`). Absent/null = English, unchanged. */
  locale?: string | null;
  /** Per-run TTS override for the locale; never written to series meta.json. */
  tts?: Record<string, unknown> | null;
  /** Environment for TTS credentials/commands (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export async function prepare(
  sdir: string,
  ch: string,
  out: string,
  options: PrepareOptions = {},
): Promise<[string, string]> {
  /**
   * TTS + cleaner + shots.json for one scripted chapter. The cleaner step
   * goes to the laptop when this thread's job is remote (`lappy.useRemote()`).
   *
   * `options.locale` renders a language version: obs/panels stay SHARED
   * (`out/obs_<ch>.json`), the localized script and every output live under
   * `out/languages/<locale>/<ch>/`, and the timeline gets the locale + `tts`
   * override. Without `locale` this is byte-for-byte the old behaviour.
   */
  const locale = options.locale ?? null;
  if (locale !== null && validateLocale(locale) === null) {
    throw new RuntimeError(
      `unsupported locale ${pyRepr(String(locale))} (supported: ${SUPPORTED_LOCALES.join(", ")})`,
    );
  }
  const timeline = await _hooks.loadTimeline();
  return await withSharedSeriesLock(
    out,
    { directSdir: sdir, requireExists: false },
    async (): Promise<[string, string]> => {
      if (locale === null) {
        const vdir = path.join(out, ch, "video");
        fs.mkdirSync(vdir, { recursive: true });
        // timeline.main resolves engine/voice + script_eleven.md from meta.json itself
        await timeline.main(
          sdir,
          ch,
          path.join(out, ch, "script.md"),
          path.join(out, `obs_${ch}.json`),
          vdir,
        );
        return [
          path.resolve(path.join(vdir, "shots.json")),
          path.resolve(path.join(vdir, "video.mp4")),
        ];
      }

      // Locale: validate the FULL component path (languages/<locale>/<ch>/video)
      // BEFORE mkdir or any other write, so a symlinked component can never
      // redirect a locale write onto shared English artifacts.
      const localeDir = languageChapterDir(out, locale, ch);
      const vdir = path.join(localeDir, "video");
      assertNoSymlinkPath(out, vdir);
      // Shared inputs, locale outputs. The locale script must exist: rendering
      // the English script with a Hindi voice would silently ship English text.
      const localeScript = path.join(localeDir, "script.md");
      if (!fs.existsSync(localeScript)) {
        throw new RuntimeError(
          `${locale} script missing: ${localeScript} - run the localize stage first`,
        );
      }
      fs.mkdirSync(vdir, { recursive: true });
      // A component could have become a link between the check and the mkdir;
      // re-assert now that every directory exists.
      assertNoSymlinkPath(out, vdir);
      const localeOpts: Record<string, unknown> = { locale };
      if (options.tts !== undefined && options.tts !== null) localeOpts.tts = options.tts;
      if (options.env !== undefined && options.env !== null) localeOpts.env = options.env;
      await timeline.main(
        sdir,
        ch,
        localeScript,
        path.join(out, `obs_${ch}.json`),
        vdir,
        localeOpts,
      );
      return [
        path.resolve(path.join(vdir, "shots.json")),
        path.resolve(path.join(vdir, "video.mp4")),
      ];
    },
  );
}

export function _probe(video: string): number {
  const r = _hooks.subprocess.run(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      video,
    ],
    { captureOutput: true, text: true },
  );
  const s = (r.stdout ?? "").trim();
  const dur = Number.parseFloat(s);
  return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

export function _renderRoot(video: string): string {
  /**
   * ROOT disk dir that per-render private temp children are created under.
   *
   * On this host /tmp is an exhausted-quota tmpfs and node is installed with
   * the file capability cap_net_bind_service=ep. That capability puts exec into
   * glibc secure-execution mode, whose `unsecvars` list drops TMPDIR from
   * node's environ; Remotion's Chrome (always run with --disable-dev-shm-usage)
   * then writes its shm file under /tmp and dies with SIGTRAP (rc 133).
   * MANHWA_RENDER_TMPDIR overrides the root; the default is per-chapter on the
   * same (root) disk as the output, so the quota'd tmpfs is never used. This
   * root is only a parent - never chmod'd, and never used directly as TMPDIR.
   */
  const base =
    process.env.MANHWA_RENDER_TMPDIR ||
    path.join(path.dirname(path.resolve(video)), ".render-tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}
export const _render_root = _renderRoot;

export function _fileSha256(filePath: string): string {
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
export const _file_sha256 = _fileSha256;

function whichSync(cmd: string, pathEnv?: string): string | null {
  if (path.isAbsolute(cmd)) {
    try {
      const st = fs.statSync(cmd);
      if (st.isFile() && (st.mode & 0o111) !== 0) return cmd;
    } catch {
      return null;
    }
    return null;
  }
  const dirs = (pathEnv ?? process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const cand = path.join(dir, cmd);
    try {
      const st = fs.statSync(cand);
      if (st.isFile() && (st.mode & 0o111) !== 0) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

function listXattrNames(filePath: string): string[] {
  try {
    const res = spawnSync("getfattr", ["-d", "-m", "-", "--", filePath], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (res.error || res.status !== 0) return [];
    const attrs: string[] = [];
    for (const line of (res.stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        attrs.push(trimmed.slice(0, eq));
      }
    }
    return attrs;
  } catch {
    return [];
  }
}

function removeXattrName(filePath: string, attr: string): void {
  try {
    spawnSync("setfattr", ["-x", attr, "--", filePath], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    // ignore
  }
}

export function _capfreeNode(scratch: string): string | null {
  /**
   * Return a directory holding a CONTENT-ONLY, capability-free copy of the
   * node binary, to be prepended to PATH.
   *
   * The copy is made fresh from the currently-configured `node` each render:
   * bytes are copied (not metadata/xattrs), so the file capability
   * `security.capability` is NOT carried over - a privilege reduction with no
   * global cap/node change - and glibc no longer runs in secure-execution mode,
   * so TMPDIR survives into node and Chrome. The copy is verified to be
   * byte-identical to the source (SHA256) and forced mode 0755 with all xattrs
   * (including any capability) absent before it is used. Returns null if node
   * cannot be copied or verified (render then falls back unchanged).
   */
  const node = whichSync("node");
  if (!node) return null;
  try {
    const src = fs.realpathSync(node); // copy the real file, not a shim
    const dst = path.join(scratch, "bin", "node");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // content-only copy: read bytes -> write new inode, NO metadata/xattrs.
    const sfd = fs.openSync(src, "r");
    try {
      const dfd = fs.openSync(dst, "w", 0o755);
      try {
        const buf = Buffer.alloc(1024 * 1024);
        let n: number;
        do {
          n = fs.readSync(sfd, buf, 0, buf.length, null);
          if (n > 0) fs.writeSync(dfd, buf, 0, n);
        } while (n > 0);
      } finally {
        fs.closeSync(dfd);
      }
    } finally {
      fs.closeSync(sfd);
    }
    fs.chmodSync(dst, 0o755);
    for (const a of listXattrNames(dst)) {
      removeXattrName(dst, a);
    }
    // verify the copy is exactly the currently-configured node bytes
    if (_hooks._fileSha256(src) !== _hooks._fileSha256(dst)) {
      return null;
    }
    if (listXattrNames(dst).length > 0 || (fs.statSync(dst).mode & 0o111) === 0) {
      return null;
    }
    return path.dirname(dst);
  } catch {
    return null;
  }
}
export const _capfree_node = _capfreeNode;

/**
 * Render quality for this render: env override wins, then the persisted Studio
 * setting, then "1080p" (v1 behaviour).
 */
export function resolveRenderQuality(): RenderQuality {
  const envValue = (process.env.MANHWA_RENDER_QUALITY ?? "").trim().toLowerCase();
  if (envValue === "720p" || envValue === "720") return "720p";
  if (envValue === "1080p" || envValue === "1080") return "1080p";
  try {
    return getStudioSettings().renderQuality;
  } catch {
    return "1080p";
  }
}

/**
 * True when this render was explicitly asked for 1080p: the props file carries
 * `quality` (written by the timeline stage) or the env override says 1080.
 * Defaults to false so an offline props file of `{}` renders at native 720p
 * instead of upscaling.
 */
export function renderQualityWants1080(props: string): boolean {
  // An explicit environment choice wins over whatever the props file recorded.
  const envValue = (process.env.MANHWA_RENDER_QUALITY ?? "").trim().toLowerCase();
  if (envValue.startsWith("720")) return false;
  if (envValue.startsWith("1080")) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(props, "utf8")) as { quality?: unknown };
    if (parsed?.quality === "720p") return false;
    if (parsed?.quality === "1080p") return true;
    return false;
  } catch {
    return false;
  }
}

export function renderLocal(props: string, video: string): void | Promise<void> {
  return withSharedSeriesLock(
    [video, props],
    { requireExists: false },
    () => {
      const renderlog = path.join(path.dirname(video), "render.log");
      const root = _hooks._renderRoot(video);
      // PRIVATE per-render temp: a fresh mkdtemp under the disk root. No cross-run
      // reuse, so a mtime-only cache can never hand out a stale/mismatched node
      // copy, and no two concurrent renders ever collide on the same path.
      const scratch = fs.mkdtempSync(path.join(root, ".render-"));
      const cleanup = () => {
        // remove ONLY this invocation's private temp; render.log + video.mp4 live
        // in the video dir and persist.
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
          // ignore
        }
      };

      const runBody = (): void => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
        };
        const nodedir = _hooks._capfreeNode(scratch);
        if (nodedir) {
          env.PATH = nodedir + path.delimiter + (env.PATH ?? "");
        }
        const lf = fs.openSync(renderlog, "w");
        let r: SubprocessResult;
        try {
          _hooks.telemetry.stageCurrent("render", "running", { note: "Rendering frames" });
          const renderArgs = [
            "npx",
            "remotion",
            "render",
            "src/index.ts",
            "Recap",
            video,
            `--props=${props}`,
            "--log=info",
          ];
          // The Recap composition is natively 1280x720, so 720p renders at scale 1
          // and needs no flag. 1080p is an exact 1.5x upscale (1920x1080 integers).
          // A fractional scale would give remotion a non-integer height and crash.
          // Gate on the props/env decision, not on the current Studio setting, so
          // a later settings change cannot rescale an already-planned render.
          const wants1080 = renderQualityWants1080(props);
          if (wants1080) renderArgs.push("--scale=1.5");
          r = _hooks.subprocess.run(
            renderArgs,
            {
              cwd: _hooks.STUDIO,
              stdoutFd: lf,
              stdoutPath: renderlog,
              timeout: 3600,
              env,
            },
          );
        } finally {
          try {
            fs.closeSync(lf);
          } catch {
            // ignore
          }
        }
        if (r.returncode !== 0 || !fs.existsSync(video)) {
          let tail = "";
          try {
            tail = fs.readFileSync(renderlog, "utf8").slice(-400);
          } catch {
            tail = "";
          }
          throw new RuntimeError(`remotion render failed rc=${r.returncode}: ${tail}`);
        }
        let size = 0;
        try {
          size = fs.statSync(video).size;
        } catch {
          size = 0;
        }
        if (size <= 0) {
          let tail = "";
          try {
            tail = fs.readFileSync(renderlog, "utf8").slice(-400);
          } catch {
            tail = "";
          }
          throw new RuntimeError(
            `remotion render failed rc=${r.returncode}: empty video (0 bytes): ${tail}`,
          );
        }
      };

      let heavyRes: void | Promise<void>;
      try {
        heavyRes = _hooks.lappy.withHeavy(runBody);
      } catch (err) {
        cleanup();
        throw err;
      }
      if (isPromiseLike(heavyRes)) {
        return Promise.resolve(heavyRes).finally(cleanup);
      }
      cleanup();
      return;
    },
  );
}
export const render_local = renderLocal;

class FileLog implements lappyMod.LogLike {
  private fd: number;
  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
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

export function renderRemote(props: string, video: string): void {
  /** Ship staged assets + props to the laptop, render there, pull the mp4 back. */
  withSharedSeriesLock([video, props], { requireExists: false }, () => {
    let parsed: { audio?: unknown; quality?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(props, "utf8")) as { audio?: unknown; quality?: unknown };
    } catch (err) {
      throw new RuntimeError(
        `cannot read render props ${props}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const proj = String(parsed.audio ?? "").split("/")[0]!; // "<series>_<ch>"
    if (!proj) {
      throw new RuntimeError(`render props ${props} has no audio path`);
    }
    // The Recap composition is 1280x720; 1080p is an exact 1.5x upscale.
    const scale = parsed.quality === "1080p" ? " --scale=1.5" : "";
    const lp = _hooks.lappy;
    const rstudio = `${lp.RDIR}/studio`;
    const job = `${lp.RDIR}/jobs/${proj}`;
    const renderlog = path.join(path.dirname(video), "render.log");
    const lf = new FileLog(renderlog);
    try {
      lf.write(`[remote ${lp.HOST}] ${proj}\n`);
      lf.flush();
      try {
        lp.ssh(
          `mkdir -p ${lappyMod.shQuote(`${rstudio}/public`)} ${lappyMod.shQuote(job)}`,
          lf,
          60,
        );
        // keep remote composition code identical to ours (node_modules stay remote)
        lp.push(
          _hooks.STUDIO.replace(/\/+$/, "") + "/",
          `${rstudio}/`,
          lf,
          true,
          ["node_modules", "public"],
        );
        lp.push(
          path.join(_hooks.STUDIO, "public", proj) + "/",
          `${rstudio}/public/${proj}/`,
          lf,
          true,
        );
        lp.push(props, `${job}/shots.json`, lf);
        lp.ssh(
          `cd ${lappyMod.shQuote(rstudio)} && npx remotion render src/index.ts Recap ` +
            `${lappyMod.shQuote(`../jobs/${proj}/video.mp4`)} ` +
            `--props=${lappyMod.shQuote(`../jobs/${proj}/shots.json`)} ` +
            `--log=info${scale}`,
          lf,
          3600,
        );
        const tmp = `${video}.part`;
        lp.pull(`${job}/video.mp4`, tmp, lf);
        fs.renameSync(tmp, video);
      } finally {
        lp.rm(job, lf);
        lp.rm(`${rstudio}/public/${proj}`, lf);
      }
    } finally {
      lf.close();
    }
  });
}
export const render_remote = renderRemote;

export function renderCloud(props: string, video: string): void | Promise<void> {
  /** Same staged-assets contract as renderRemote, using Docker cloud cp/exec. */
  return withSharedSeriesLock([video, props], { requireExists: false }, () => {
    return _hooks.cloudlane.render(props, video, _hooks.STUDIO);
  });
}
export const render_cloud = renderCloud;

function errClassName(e: unknown): string {
  return (
    (e as { name?: string; constructor?: { name?: string } } | null | undefined)?.name ||
    (e as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ||
    "Error"
  );
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function _render(
  ch: string,
  props: string,
  video: string,
  log: (msg: string) => void = (m) => console.log(m),
  lane: string | null = null,
): [string, number] | Promise<[string, number]> {
  /**
   * Route one chapter. `lane=null` = legacy health-driven routing (unchanged).
   * A lane id = persisted-plan routing: that exact lane, no fallback to another.
   */
  if (lane !== null && lane !== undefined) {
    return _hooks._renderOnLane(ch, props, video, log, lane);
  }
  return withSharedSeriesLock([video, props], { requireExists: false }, () => {
    const t0 = _hooks.time.now();
    let where = "local";
    const lp = _hooks.lappy;
    const cl = _hooks.cloudlane;
    const tel = _hooks.telemetry;

    tel.stage(ch, "render", "queued", { note: "Waiting for render slot" });

    const finishRender = (): [string, number] => {
      const dur = _hooks._probe(video);
      if (!(dur > 0)) {
        throw new RuntimeError(
          `render produced an empty video (duration ${dur}s): ${video}`,
        );
      }
      const elapsed = _hooks.time.now() - t0;
      log(
        `   render: ${ch} DONE ${pyFloatRepr(Number(dur))}s video in ${pyRoundFixed(elapsed, 0)}s wall ` +
          `[${where}] -> ${video}`,
      );
      tel.stage(ch, "render", "done", { duration: dur, wallSeconds: elapsed });
      return [video, dur];
    };

    const runLocalStep = (): [string, number] | Promise<[string, number]> => {
      if (where === "local") {
        tel.bind({ chapter: ch, worker: "local" });
        tel.worker("local", { kind: "local", status: "busy" });
        tel.stage(ch, "render", "queued", { note: "Waiting for the local CPU slot" });
        log(`   render: ${ch} starting on local`);
        const res = _hooks.renderLocal(props, video);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then(finishRender);
        }
      }
      return finishRender();
    };

    const runCloudStep = (): [string, number] | Promise<[string, number]> => {
      if (where === "local" && cl.NAME) {
        const [ok, why] = callCloudHealthy();
        if (ok) {
          log(`   render: ${ch} starting on ${cl.NAME}`);
          try {
            tel.bind({ chapter: ch, worker: cl.NAME });
            tel.stage(ch, "render", "queued", { note: "Waiting for a Docker cloud slot" });
            const res = _hooks.renderCloud(props, video);
            if (isPromiseLike(res)) {
              return Promise.resolve(res).then(
                () => {
                  cl.report(true);
                  where = cl.NAME;
                  return runLocalStep();
                },
                (e) => {
                  tel.worker(cl.NAME, { lastError: errClassName(e) });
                  cl.report(false);
                  log(`   render: ${ch} cloud failed (${errText(e).slice(0, 120)}) -> local fallback`);
                  return runLocalStep();
                },
              );
            }
            cl.report(true);
            where = cl.NAME;
          } catch (e) {
            tel.worker(cl.NAME, { lastError: errClassName(e) });
            cl.report(false);
            log(`   render: ${ch} cloud failed (${errText(e).slice(0, 120)}) -> local fallback`);
          }
        } else {
          log(`   render: ${ch} cloud unavailable (${why}) -> local fallback`);
        }
      }
      return runLocalStep();
    };

    if (callLappyUseRemote() && callLappyHealthy(0, false)[0]) {
      log(`   render: ${ch} starting on ${lp.HOST}`);
      try {
        tel.stage(ch, "render", "running", { note: "Uploading assets and rendering remotely" });
        const res = _hooks.renderRemote(props, video);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then(
            () => {
              lp.report(true);
              where = lp.HOST;
              return runCloudStep();
            },
            (e) => {
              tel.worker(lp.HOST, { lastError: errClassName(e) });
              lp.report(false);
              const fallback = cl.NAME ? "cloud/local fallback" : "local fallback";
              log(`   render: ${ch} remote failed (${errText(e).slice(0, 120)}) -> ${fallback}`);
              return runCloudStep();
            },
          );
        }
        lp.report(true);
        where = lp.HOST;
      } catch (e) {
        tel.worker(lp.HOST, { lastError: errClassName(e) });
        lp.report(false);
        const fallback = cl.NAME ? "cloud/local fallback" : "local fallback";
        log(`   render: ${ch} remote failed (${errText(e).slice(0, 120)}) -> ${fallback}`);
      }
    }

    return runCloudStep();
  });
}

export function _renderOnLane(
  ch: string,
  props: string,
  video: string,
  log: (msg: string) => void,
  lane: string,
): [string, number] | Promise<[string, number]> {
  /**
   * Render on exactly `lane` (persisted-plan selection). No silent fallback:
   * an unavailable or failing lane raises, so the chapter fails deterministically
   * instead of quietly routing to another (possibly disabled or paid) lane.
   */
  return withSharedSeriesLock([video, props], { requireExists: false }, () => {
    const t0 = _hooks.time.now();
    const lp = _hooks.lappy;
    const cl = _hooks.cloudlane;
    const tel = _hooks.telemetry;

    tel.stage(ch, "render", "queued", { note: `Waiting for the ${lane} render slot` });

    const finish = (where: string): [string, number] => {
      const dur = _hooks._probe(video);
      if (!(dur > 0)) {
        throw new RuntimeError(
          `render on ${where} produced an empty video (duration ${dur}s): ${video}`,
        );
      }
      const elapsed = _hooks.time.now() - t0;
      log(
        `   render: ${ch} DONE ${pyFloatRepr(Number(dur))}s video in ${pyRoundFixed(elapsed, 0)}s wall ` +
          `[${where}] -> ${video}`,
      );
      tel.stage(ch, "render", "done", { duration: dur, wallSeconds: elapsed });
      return [video, dur];
    };

    if (lane === "laptop") {
      if (!lp.HOST) {
        throw new RuntimeError(
          "render lane 'laptop' is not configured (MANHWA_RENDER_REMOTE is empty)",
        );
      }
      const [ok, why] = callLappyHealthy(0, false);
      if (!ok) {
        throw new RuntimeError(`render lane 'laptop' unavailable: ${why}`);
      }
      tel.bind({ chapter: ch, worker: lp.HOST });
      tel.worker(lp.HOST, { kind: "remote", status: "busy" });
      log(`   render: ${ch} starting on ${lp.HOST}`);
      try {
        tel.stage(ch, "render", "running", { note: "Uploading assets and rendering remotely" });
        const res = _hooks.renderRemote(props, video);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then(
            () => {
              lp.report(true);
              return finish(lp.HOST);
            },
            (e) => {
              tel.worker(lp.HOST, { lastError: errClassName(e) });
              lp.report(false);
              throw e;
            },
          );
        }
        lp.report(true);
      } catch (e) {
        tel.worker(lp.HOST, { lastError: errClassName(e) });
        lp.report(false);
        throw e;
      }
      return finish(lp.HOST);
    } else if (lane === "cloud") {
      if (!cl.NAME) {
        throw new RuntimeError(
          "render lane 'cloud' is not configured (MANHWA_RENDER_CLOUD is empty)",
        );
      }
      const [ok, why] = callCloudHealthy();
      if (!ok) {
        throw new RuntimeError(`render lane 'cloud' unavailable: ${why}`);
      }
      tel.bind({ chapter: ch, worker: cl.NAME });
      tel.worker(cl.NAME, { kind: "cloud", status: "busy" });
      log(`   render: ${ch} starting on ${cl.NAME}`);
      try {
        tel.stage(ch, "render", "running", {
          note: "Uploading assets and rendering in Docker cloud",
        });
        const res = _hooks.renderCloud(props, video);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then(
            () => {
              cl.report(true);
              return finish(cl.NAME);
            },
            (e) => {
              tel.worker(cl.NAME, { lastError: errClassName(e) });
              cl.report(false);
              throw e;
            },
          );
        }
        cl.report(true);
      } catch (e) {
        tel.worker(cl.NAME, { lastError: errClassName(e) });
        cl.report(false);
        throw e;
      }
      return finish(cl.NAME);
    } else if (lane === "local") {
      tel.bind({ chapter: ch, worker: "local" });
      tel.worker("local", { kind: "local", status: "busy" });
      log(`   render: ${ch} starting on local`);
      const res = _hooks.renderLocal(props, video);
      if (isPromiseLike(res)) {
        return Promise.resolve(res).then(() => finish("local"));
      }
      return finish("local");
    } else {
      // A registered custom node (`docker-sbx`, `ssh`, or a second `local`) owns
      // its own breaker and slots; dispatch to its instance. The built-in ids
      // above keep the singleton hook path unchanged.
      const node = nodeRegistryMod.getNodeInstance(lane);
      if (!node) {
        throw new RuntimeError(`unknown render lane ${pyRepr(lane)}`);
      }
      const [ok, why] = node.healthy(true);
      if (!ok) {
        throw new RuntimeError(`render lane '${lane}' unavailable: ${why}`);
      }
      tel.bind({ chapter: ch, worker: lane });
      tel.worker(lane, { kind: node.kind === "docker-sbx" ? "cloud" : "remote", status: "busy" });
      log(`   render: ${ch} starting on ${lane}`);
      try {
        tel.stage(ch, "render", "running", { note: `Rendering on ${lane}` });
        if (node.kind === "local") {
          // A registered extra local node is still this host: local heavy stages
          // serialize through lappy.HEAVY, so reuse the local render path.
          const res = _hooks.renderLocal(props, video);
          if (isPromiseLike(res)) {
            return Promise.resolve(res).then(() => finish(lane));
          }
          return finish(lane);
        }
        return Promise.resolve(node.render(props, video, log)).then(
          () => finish(lane),
          (e) => {
            tel.worker(lane, { lastError: errClassName(e) });
            throw e;
          },
        );
      } catch (e) {
        tel.worker(lane, { lastError: errClassName(e) });
        throw e;
      }
    }
  });
}
export const _render_on_lane = _renderOnLane;

/** Telemetry worker kind for a render node kind. */
export function _nodeWorkerKind(kind: string | null | undefined): string {
  if (kind === "docker-sbx") return "cloud";
  if (kind === "ssh") return "remote";
  return "local";
}

/** True when the plan carries an enabled lane that is not a built-in transport. */
function hasCustomRenderLanes(plan: RenderPlan): boolean {
  return (plan.lanes ?? []).some(
    (lane) => lane.enabled
      && lane.id !== "local"
      && lane.id !== "laptop"
      && lane.id !== "cloud",
  );
}

/** Registered custom node for a lane id, or null for built-ins/unknown ids. */
function customNodeRecord(lane: string | null | undefined): nodeRegistryMod.RenderNodeRecord | null {
  if (!lane || (lane === "local" || lane === "laptop" || lane === "cloud")) return null;
  try {
    const nodes = nodeRegistryMod.getRegisteredNodes();
    return (
      nodes.find((node) => node.id === lane) ??
      nodes.find((node) => node.id.toLowerCase() === lane.toLowerCase()) ??
      null
    );
  } catch {
    return null;
  }
}

export function _laneWorkerKind(lane: string | null | undefined, remote: boolean): string {
  if (lane === "cloud") return "cloud";
  if (lane === "local" || lane === null || lane === undefined) return "local";
  const custom = customNodeRecord(lane);
  // A custom node keeps its own identity: kind comes from the registry record.
  if (custom) return _nodeWorkerKind(String(custom.kind));
  if (lane === "laptop") return remote ? "remote" : "local";
  return remote ? "remote" : "local";
}
export const _lane_worker_kind = _laneWorkerKind;

export interface ProduceOptions {
  log?: (msg: string) => void;
  remote?: boolean | null;
  workerId?: string | null;
  worker_id?: string | null;
  lane?: string | null;
  /** Language version to produce (`hi-IN`). Absent/null = English, unchanged. */
  locale?: string | null;
  /** Per-run TTS override (engine/voice_id/language/speed/...). Never persists. */
  tts?: Record<string, unknown> | null;
  /** Environment for TTS credentials/commands (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/** `[video, duration]`, plus locale warnings when a language version was rendered. */
export type ProduceResult = [string, number] | [string, number, string[]];

export async function produce(
  sdir: string,
  ch: string,
  out: string,
  logOrOpts: ((msg: string) => void) | ProduceOptions = (m) => console.log(m),
  remoteArg: boolean | null = null,
  workerIdArg: string | null = null,
  laneArg: string | null = null,
): Promise<ProduceResult> {
  /**
   * Full video for one already-scripted chapter. Returns [path, dur].
   *
   * remote=null -> decide by the health gate now (legacy). `lane` = persisted-plan
   * selection: preparation stays wherever it belongs (a cloud render is prepared
   * locally - cloud never cleans; a laptop render is prepared on the laptop).
   *
   * `locale` renders a language version into `out/languages/<locale>/<ch>/video`;
   * English callers (no locale) get the original behaviour exactly.
   */
  let log: (msg: string) => void;
  let remote: boolean | null;
  let workerId: string | null;
  let lane: string | null;
  let prepareOptions: PrepareOptions | undefined;

  if (typeof logOrOpts === "object" && logOrOpts !== null) {
    log = logOrOpts.log ?? ((m) => console.log(m));
    remote = logOrOpts.remote ?? null;
    workerId = logOrOpts.workerId ?? logOrOpts.worker_id ?? null;
    lane = logOrOpts.lane ?? null;
    const locale = logOrOpts.locale ?? null;
    if (locale !== null || logOrOpts.tts != null || logOrOpts.env != null) {
      const opts: PrepareOptions = {};
      if (locale !== null) opts.locale = locale;
      if (logOrOpts.tts != null) opts.tts = logOrOpts.tts;
      if (logOrOpts.env != null) opts.env = logOrOpts.env;
      prepareOptions = opts;
    }
  } else {
    log = logOrOpts ?? ((m) => console.log(m));
    remote = remoteArg;
    workerId = workerIdArg;
    lane = laneArg;
  }

  return await withSharedSeriesLock(
    out,
    { directSdir: sdir, requireExists: false },
    async (): Promise<ProduceResult> => {
      const lp = _hooks.lappy;
      const tel = _hooks.telemetry;
      if (lane !== null && lane !== undefined) {
        remote = lane === "laptop";
      }
      if (remote === null || remote === undefined) {
        remote = callLappyHealthy(0)[0];
      }
      const wid = workerId || (remote ? lp.HOST : "local");
      const isRemote = Boolean(remote);
      const runScoped = async (): Promise<ProduceResult> => {
        tel.bind({ chapter: ch, worker: wid });
        // Several slots can share one worker id: only the last one to finish may
        // publish "idle", otherwise a busy worker looks free.
        const active = (_activeProduceByWorker.get(wid) ?? 0) + 1;
        _activeProduceByWorker.set(wid, active);
        tel.worker(wid, { kind: _laneWorkerKind(lane, isRemote), status: "busy" });
        lp.setRemoteForThread(isRemote);
        try {
          const [props, video] = prepareOptions === undefined
            ? await _hooks.prepare(sdir, ch, out)
            : await _hooks.prepare(sdir, ch, out, prepareOptions);
          if (prepareOptions?.locale == null) {
            // English: original behaviour, the lane writes the canonical path.
            return await _hooks._render(ch, props, video, log, lane);
          }
          // Locale: ATOMIC publish. The render target is a unique sibling
          // candidate, never the published file, so the last good mp4 keeps
          // serving throughout the render and even through a hard crash
          // (SIGKILL) - the canonical inode is never opened for writing.
          _clearStaleLocaleCandidates(video);
          const candidate = _localeCandidatePath(video);
          let rendered: [string, number];
          try {
            rendered = await _hooks._render(ch, props, candidate, log, lane);
            // Validate the candidate itself (the lane already rejected an empty
            // output; re-probe so a truncated file can never be published).
            const dur = _hooks._probe(candidate);
            if (!(dur > 0)) {
              throw new RuntimeError(
                `locale render produced an empty candidate (duration ${dur}s): ${candidate}`,
              );
            }
            if (!fs.existsSync(candidate) || fs.statSync(candidate).size <= 0) {
              throw new RuntimeError(
                `locale render produced an empty candidate (0 bytes): ${candidate}`,
              );
            }
            fs.renameSync(candidate, video);
            rendered = [video, dur];
            log(`   render: ${ch} published ${pyFloatRepr(Number(dur))}s -> ${video}`);
          } catch (err) {
            // Caught failure: drop the candidate, leave the published file as is.
            try {
              if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
            } catch {
              // a leftover candidate is never served; cleanup must not mask err
            }
            throw err;
          }
          const warnings = _readLocaleWarnings(video);
          return warnings.length
            ? [rendered[0], rendered[1], warnings]
            : rendered;
        } finally {
          const left = Math.max(0, (_activeProduceByWorker.get(wid) ?? 1) - 1);
          if (left === 0) _activeProduceByWorker.delete(wid);
          else _activeProduceByWorker.set(wid, left);
          if (left === 0) tel.worker(wid, { status: "idle" });
          lp.setRemoteForThread(false);
        }
      };
      // Isolate remote routing and telemetry per render: concurrent slots must not
      // clobber each other's AsyncLocalStorage context.
      const scoped = (): Promise<ProduceResult> =>
        typeof tel.run === "function"
          ? (tel.run({ chapter: ch, worker: wid }, runScoped) as Promise<ProduceResult>)
          : runScoped();
      if (typeof lp.withRemote === "function") {
        return await (lp.withRemote(isRemote, scoped) as Promise<ProduceResult>);
      }
      return await scoped();
    },
  );
}

/**
 * Non-fatal findings the locale timeline recorded next to its own output
 * (dropped panel assignments, held lines). Absent/unreadable -> [].
 */
export function _readLocaleWarnings(video: string): string[] {
  const file = path.join(path.dirname(video), "locale_warnings.json");
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { warnings?: unknown };
    return Array.isArray(doc.warnings)
      ? doc.warnings.map((w) => String(w)).filter((w) => w.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

/**
 * Unique sibling candidate for an atomic locale render: `<video>.<pid>.<rand>.candidate.mp4`.
 *
 * It lives in the same directory as the published file so the final
 * `renameSync` is a same-filesystem, atomic replace. It is never the published
 * path, so a crash mid-encode can only leave a candidate behind - the old
 * published mp4 keeps its bytes and inode.
 */
export function _localeCandidatePath(video: string): string {
  const abs = path.resolve(video);
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${rand}.candidate.mp4`);
}

/** True when `name` looks like a locale render candidate for this video basename. */
function isLocaleCandidate(name: string, base: string): boolean {
  return name.startsWith(`.${base}.`) && name.endsWith(".candidate.mp4");
}

/**
 * Remove candidate files a previous crashed locale render left behind.
 *
 * Only candidates for THIS video are touched, and only ones older than the
 * current call could create (i.e. not the one about to be used): the caller
 * runs this before generating a fresh candidate name, so every match is stale.
 */
export function _clearStaleLocaleCandidates(video: string): number {
  const abs = path.resolve(video);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isLocaleCandidate(name, base)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // an undeletable stale candidate is never served; ignore
    }
  }
  return removed;
}

export interface VideoResult {
  status: "video-ok" | "video-failed";
  video?: string;
  duration?: number;
  error?: string;
  video_attempts?: number;
  class?: FailClass;
}

const VIDEO_RETRY_DELAYS_S = [120, 600] as const;
const VIDEO_MAX_ATTEMPTS = VIDEO_RETRY_DELAYS_S.length + 1;

export async function worker(
  sdir: string,
  out: string,
  q: QueueLike<string | null> | Array<string | null>,
  results: Record<string, VideoResult>,
  failcounts: Record<string, number> = {},
): Promise<void> {
  /**
   * Video-lane consumer, driven by the render plan (persisted config or legacy).
   */
  let plan: RenderPlan | null = null;
  let overrideError: string | null = null;
  try {
    const resolveFn =
      _hooks.renderPolicy.resolve_render_plan ?? _hooks.renderPolicy.resolveRenderPlan;
    plan = resolveFn();
  } catch (e) {
    if (e instanceof RenderOverrideError || (e as Error)?.name === "RenderOverrideError") {
      // A pinned lane that is not configured+enabled must fail deterministically,
      // never hang the queue and never route to another lane.
      overrideError = errText(e);
    } else {
      throw e;
    }
  }
  if (overrideError !== null) {
    return await _hooks._workerOverrideRefused(sdir, out, q, results, failcounts, overrideError);
  }
  if (!plan!.legacy || plan!.override || hasCustomRenderLanes(plan!)) {
    // A pinned override must be honored in BOTH modes: the legacy path's
    // laptop-first health routing would otherwise ignore the pin. Registered
    // custom render nodes (Studio SSH / Docker Sandbox) are only schedulable
    // through the plan consumer, so they take that path too.
    return await _hooks._workerPlan(sdir, out, q, results, failcounts, plan!);
  }
  await withSharedSeriesLock(
    out,
    { directSdir: sdir, requireExists: false },
    async (): Promise<void> => {
      const log = (m: string) => {
        console.log(`[video] ${m}`);
      };
      const lp = _hooks.lappy;
      const cl = _hooks.cloudlane;
      const tel = _hooks.telemetry;
      const wq = normalizeQueue(q);
      const busy = { lappy: false };
      let stopped = false;
      const pending = new RenderQueue<string>();
      let waitingRetries = 0;
      const attempts: Record<string, number> = { ...failcounts };

      const runOne = async (ch: string, remote: boolean, tag: string): Promise<void> => {
        let final = true;
        attempts[ch] = (attempts[ch] ?? 0) + 1;
        try {
          const [v, dur] = await _hooks.produce(
            sdir,
            ch,
            out,
            log,
            remote,
            remote ? lp.HOST : tag,
          );
          results[ch] = { status: "video-ok", video: v, duration: dur, video_attempts: attempts[ch] };
        } catch (e) {
          failcounts[ch] = (failcounts[ch] ?? 0) + 1;
          if (failClass(e) === "transient" && failcounts[ch] < VIDEO_MAX_ATTEMPTS) {
            final = false;
            const delay = VIDEO_RETRY_DELAYS_S[failcounts[ch] - 1]!;
            tel.retrying?.(ch, e, { retryAt: _hooks.time.now() + delay, attempt: failcounts[ch], maxAttempts: VIDEO_MAX_ATTEMPTS });
            log(`~~ ${ch} retry ${failcounts[ch]}/${VIDEO_MAX_ATTEMPTS} in ${delay}s: ${failureNote(e)}`);
            waitingRetries++;
            // The chapter must come back even if the timer fails, or join() would never resolve.
            void Promise.resolve().then(() => _hooks.time.sleep(delay)).catch(() => undefined)
              .then(() => { pending.put(ch); }).finally(() => { waitingRetries--; });
            return;
          }
          tel.failed(ch, e);
          process.stderr.write(
            `[video] !! ${ch} FAILED (${failcounts[ch]}x) [${tag}]: ${errText(e).slice(0, 200)}\n`,
          );
          results[ch] = {
            status: "video-failed",
            class: failClass(e),
            error: errText(e).slice(0, 400),
            // failcounts[ch] was just incremented, so it IS the attempt count.
            video_attempts: attempts[ch],
          };
        } finally {
          if (final) wq.taskDone();
        }
      };

      const slot = async (name: string): Promise<void> => {
        while (!(stopped && pending.empty() && waitingRetries === 0)) {
          if (name === "lappy" && !callLappyHealthy()[0]) {
            await _hooks.time.sleep(5);
            continue;
          }
          if (name === "local-2" && !callCloudHealthy()[0]) {
            await _hooks.time.sleep(1);
            continue; // don't stack prep when cloud is unavailable
          }
          if (
            name !== "lappy" &&
            lp.HOST &&
            !busy.lappy &&
            callLappyHealthy()[0]
          ) {
            await _hooks.time.sleep(2);
            continue; // laptop is free - let it take the next one
          }
          let ch: string;
          try {
            const timeout =
              process.env.VITEST || process.env.MANHWA_FAST_RENDERLANE_POLL === "1"
                ? 0.02
                : 1;
            ch = await pending.get(timeout);
          } catch (e) {
            if (e instanceof QueueEmpty) continue;
            throw e;
          }
          if (name === "lappy") {
            busy.lappy = true;
          }
          log(`   dispatch: ${ch} -> ${name === "lappy" ? lp.HOST : "local"}`);
          try {
            await runOne(ch, name === "lappy", name);
          } finally {
            if (name === "lappy") {
              busy.lappy = false;
            }
          }
        }
      };

      const names = [...(lp.HOST ? ["lappy"] : []), "local"];
      if (cl.NAME) {
        names.push("local-2");
        tel.worker(cl.NAME, { kind: "cloud", reason: "Configured cloud render lane" });
      }
      for (const name of names) {
        tel.worker(name === "lappy" ? lp.HOST : name, {
          kind: name === "lappy" ? "remote" : "local",
          status: "idle",
        });
      }
      const tasks = names.map((n) => slot(n));
      for (;;) {
        const ch = await wq.get();
        if (ch === null || ch === undefined) {
          wq.taskDone();
          break;
        }
        pending.put(ch);
      }
      stopped = true;
      await Promise.all(tasks);
    },
  );
}

export async function _workerOverrideRefused(
  sdir: string,
  out: string,
  q: QueueLike<string | null> | Array<string | null>,
  results: Record<string, VideoResult>,
  failcounts: Record<string, number>,
  reason: string,
): Promise<void> {
  /**
   * A pinned per-run lane that cannot be honored: fail every chapter at once.
   */
  await withSharedSeriesLock(
    out,
    { directSdir: sdir, requireExists: false },
    async (): Promise<void> => {
      process.stderr.write(`[video] !! render override refused: ${reason}\n`);
      const wq = normalizeQueue(q);
      for (;;) {
        const ch = await wq.get();
        if (ch === null || ch === undefined) {
          wq.taskDone();
          break;
        }
        failcounts[ch] = (failcounts[ch] ?? 0) + 1;
        results[ch] = {
          status: "video-failed",
          error: `render override refused: ${reason}`,
          class: failClass(new RuntimeError(`render override refused: ${reason}`)),
          video_attempts: 0,
        };
        wq.taskDone();
      }
    },
  );
}
export const _worker_override_refused = _workerOverrideRefused;

export async function _workerPlan(
  sdir: string,
  out: string,
  q: QueueLike<string | null> | Array<string | null>,
  results: Record<string, VideoResult>,
  failcounts: Record<string, number>,
  plan: RenderPlan,
): Promise<void> {
  /**
   * Persisted-plan consumer: one worker task per REAL render slot.
   */
  await withSharedSeriesLock(
    out,
    { directSdir: sdir, requireExists: false },
    async (): Promise<void> => {
      const log = (m: string) => {
        console.log(`[video] ${m}`);
      };
      const lp = _hooks.lappy;
      const cl = _hooks.cloudlane;
      const tel = _hooks.telemetry;
      const rp = _hooks.renderPolicy;
      const wq = normalizeQueue(q);

      const lanes = plan.lanes;
      const pinned = plan.override;
      const eligibleFn = rp.eligible_lanes ?? rp.eligibleLanes;
      const eligible = eligibleFn(plan);
      if (!eligible || eligible.length === 0) {
        throw new RuntimeError(
          "render plan has no eligible lane; refusing to route a chapter anywhere",
        );
      }
      const eff: Record<string, number> = {};
      const busy: Record<string, number> = {};
      for (const l of lanes) {
        eff[l.id] = l.effectiveSlots;
        busy[l.id] = 0;
      }
      const grace = plan.unavailableGraceS;
      const idleSince: [number] = [_hooks.time.now()];

      const _workerId = (lid: string): string => {
        if (lid === "laptop") return lp.HOST || "laptop";
        if (lid === "cloud") return cl.NAME || "cloud";
        if (lid === "local") return "local";
        // A registered custom node keeps its node id as the worker id.
        const custom = customNodeRecord(lid);
        return custom ? String(custom.id) : lid;
      };

      for (const l of lanes) {
        const custom = customNodeRecord(l.id);
        tel.worker(_workerId(l.id), {
          kind: custom
            ? _nodeWorkerKind(String(custom.kind))
            : (({ laptop: "remote", cloud: "cloud" } as Record<string, string>)[l.id] ?? "local"),
          status: "idle",
          enabled: l.enabled,
          slots: l.slots,
          effectiveSlots: l.effectiveSlots,
        });
      }
      log(
        `   plan: ${plan.source}` +
          (pinned ? ` pinned=${pinned}` : "") +
          " order=" +
          eligible.map((l) => `${l.id}(${eff[l.id]})`).join(","),
      );

      const runOne = async (ch: string, lane: string): Promise<void> => {
        // Attempts made by THIS call (primary lane + any fallback lanes). The
        // reported count is prior failures plus these, so the first failure is
        // 1 and a second failure of the same chapter is 2.
        const priorFailures = failcounts[ch] ?? 0;
        const priorAttempts = attempts[ch] ?? 0;
        let final = true;
        let tries = 0;
        try {
          tries += 1;
          const [v, dur] = await _hooks.produce(sdir, ch, out, {
            log,
            lane,
            workerId: _workerId(lane),
          });
          results[ch] = { status: "video-ok", video: v, duration: dur, video_attempts: priorAttempts + tries };
        } catch (e) {
          // Unpinned (`inherit`) plans may overflow to the next eligible lane;
          // a pinned plan stays strictly pinned and fails here.
          let lastErr: unknown = e;
          if (pinned === null || pinned === undefined) {
            const chainFn = rp.fallback_chain ?? rp.fallbackChain;
            const chain = chainFn ? chainFn(plan, lane) : [];
            const availFn = rp.lane_availability ?? rp.laneAvailability;
            const avail = chain.length > 1 ? availFn(plan) : {};
            for (const cand of chain.slice(1)) {
              const cid = cand.id;
              if (cid === lane) continue;
              const [ok] = avail[cid] ?? [false, "unknown"];
              if (!ok) continue;
              log(
                `   render: ${ch} ${lane} failed (${errText(lastErr).slice(0, 120)}) -> ${cid} fallback`,
              );
              try {
                tries += 1;
                const [v, dur] = await _hooks.produce(sdir, ch, out, {
                  log,
                  lane: cid,
                  workerId: _workerId(cid),
                });
                results[ch] = {
                  status: "video-ok",
                  video: v,
                  duration: dur,
                  video_attempts: priorAttempts + tries,
                };
                return;
              } catch (e2) {
                lastErr = e2;
              }
            }
          }
          failcounts[ch] = priorFailures + 1;
          if (failClass(lastErr) === "transient" && failcounts[ch] < VIDEO_MAX_ATTEMPTS) {
            final = false;
            const delay = VIDEO_RETRY_DELAYS_S[failcounts[ch] - 1]!;
            tel.retrying?.(ch, lastErr, { retryAt: _hooks.time.now() + delay, attempt: failcounts[ch], maxAttempts: VIDEO_MAX_ATTEMPTS });
            log(`~~ ${ch} retry ${failcounts[ch]}/${VIDEO_MAX_ATTEMPTS} in ${delay}s: ${failureNote(lastErr)}`);
            waitingRetries++;
            // The chapter must come back even if the timer fails, or join() would never resolve.
            void Promise.resolve().then(() => _hooks.time.sleep(delay)).catch(() => undefined)
              .then(() => { pending.put(ch); }).finally(() => { waitingRetries--; });
            return;
          }
          tel.failed(ch, lastErr);
          process.stderr.write(
            `[video] !! ${ch} FAILED (${failcounts[ch]}x) [${lane}]: ${errText(lastErr).slice(0, 200)}\n`,
          );
          results[ch] = {
            status: "video-failed",
            class: failClass(lastErr),
            error: errText(lastErr).slice(0, 400),
            video_attempts: priorAttempts + Math.max(1, tries),
          };
        } finally {
          attempts[ch] = priorAttempts + tries;
          if (final) wq.taskDone();
        }
      };

      let stopped = false;
      const pending = new RenderQueue<string>();
      let waitingRetries = 0;
      const attempts: Record<string, number> = { ...failcounts };

      const slotWorker = async (_name: string): Promise<void> => {
        while (!(stopped && pending.empty() && waitingRetries === 0)) {
          // Availability is probed OUTSIDE the lock (non-waking, cached health
          // gates); busy counters and the grace clock are updated atomically.
          const availFn = rp.lane_availability ?? rp.laneAvailability;
          const avail = availFn(plan);
          let lane: string | null = null;
          for (const l of eligible) {
            const lid = l.id;
            const [ok] = avail[lid] ?? [false, "unknown"];
            if (ok && (busy[lid] ?? 0) < (eff[lid] ?? 1)) {
              lane = lid;
              break;
            }
          }
          const anyAvailable = eligible.some((l) => (avail[l.id] ?? [false, "unknown"])[0]);
          if (lane !== null) {
            busy[lane] = (busy[lane] ?? 0) + 1;
          } else if (!anyAvailable) {
            // Every eligible lane is UNAVAILABLE (not merely busy): start
            // the grace clock that ends in deterministic failure.
            idleSince[0] = Math.min(idleSince[0], _hooks.time.now());
          }

          if (lane === null) {
            if (anyAvailable) {
              // A lane is up but at capacity: renders are progressing, so
              // this is normal waiting, never a failure.
              idleSince[0] = _hooks.time.now();
            } else if (pending.qsize() > 0 && _hooks.time.now() - idleSince[0] > grace) {
              _hooks._drainPending(pending, results, failcounts, wq, eligible, plan, attempts);
              idleSince[0] = _hooks.time.now();
            }
            const waitS =
              process.env.VITEST || process.env.MANHWA_FAST_RENDERLANE_POLL === "1"
                ? Math.min(0.02, Math.max(0.005, grace / 10))
                : 1;
            await _hooks.time.sleep(waitS);
            continue;
          }

          idleSince[0] = _hooks.time.now();
          let ch: string;
          try {
            const timeout =
              process.env.VITEST || process.env.MANHWA_FAST_RENDERLANE_POLL === "1"
                ? 0.02
                : 1;
            ch = await pending.get(timeout);
          } catch (e) {
            if (e instanceof QueueEmpty) {
              busy[lane] = Math.max(0, (busy[lane] ?? 1) - 1);
              continue;
            }
            busy[lane] = Math.max(0, (busy[lane] ?? 1) - 1);
            throw e;
          }
          log(`   dispatch: ${ch} -> ${lane}`);
          try {
            await runOne(ch, lane);
          } finally {
            busy[lane] = Math.max(0, (busy[lane] ?? 1) - 1);
          }
        }
      };

      const names: string[] = [];
      for (const l of eligible) {
        const count = eff[l.id] ?? 1;
        for (let i = 0; i < count; i++) {
          names.push(`${l.id}#${i}`);
        }
      }
      const tasks = names.map((n) => slotWorker(n));
      for (;;) {
        const ch = await wq.get();
        if (ch === null || ch === undefined) {
          wq.taskDone();
          break;
        }
        pending.put(ch);
        idleSince[0] = _hooks.time.now(); // grace starts when work actually arrives
      }
      stopped = true;
      await Promise.all(tasks);
    },
  );
}
export const _worker_plan = _workerPlan;

export function _drainPending(
  pending: QueueLike<string>,
  results: Record<string, VideoResult>,
  failcounts: Record<string, number>,
  q: QueueLike<string | null>,
  eligible: ReadonlyArray<PlanLane>,
  plan: RenderPlan,
  attempts: Record<string, number> = {},
): void {
  /** Deterministic failure for chapters that no eligible lane could serve. */
  const ids = eligible.map((l) => l.id).join(",");
  const reason = `no render lane available (eligible: ${ids}; waited ${plan.unavailableGraceS}s)`;
  const wp = normalizeQueue(pending);
  const wq = normalizeQueue(q);
  for (;;) {
    let ch: string;
    try {
      ch = wp.getNowait();
    } catch (e) {
      if (e instanceof QueueEmpty) return;
      throw e;
    }
    failcounts[ch] = (failcounts[ch] ?? 0) + 1;
    results[ch] = { status: "video-failed", error: reason, class: failClass(new RuntimeError(reason)), video_attempts: attempts[ch] ?? 0 };
    process.stderr.write(`[video] !! ${ch} FAILED [${reason}]\n`);
    wq.taskDone();
  }
}
export const _drain_pending = _drainPending;

/* ------------------------------------------------------------------ *
 * Injectable hooks (`_hooks`) for offline unit tests
 * ------------------------------------------------------------------ */

export interface TimelineModuleLike {
  main: (
    sdir: string,
    ch: string,
    scriptPath: string,
    obsPath: string,
    vdir: string,
    options?: Record<string, unknown>,
  ) => Promise<string> | string;
}

async function defaultLoadTimeline(): Promise<TimelineModuleLike> {
  return (await import("../stages/timeline.js")) as unknown as TimelineModuleLike;
}

let defaultUseRemoteRef = lappy.use_remote;
let defaultUseRemoteCamelRef = lappy.useRemote;

/** In-flight produce() count per worker id (multi-slot workers share one id). */
const _activeProduceByWorker = new Map<string, number>();

export interface RenderlaneHooks {
  STUDIO: string;
  prepare: typeof prepare;
  _probe: typeof _probe;
  _renderRoot: typeof _renderRoot;
  _render_root: typeof _renderRoot;
  _fileSha256: typeof _fileSha256;
  _file_sha256: typeof _fileSha256;
  _capfreeNode: typeof _capfreeNode;
  _capfree_node: typeof _capfreeNode;
  renderLocal: typeof renderLocal;
  render_local: typeof renderLocal;
  renderRemote: typeof renderRemote;
  render_remote: typeof renderRemote;
  renderCloud: typeof renderCloud;
  render_cloud: typeof renderCloud;
  _render: typeof _render;
  _renderOnLane: typeof _renderOnLane;
  _render_on_lane: typeof _renderOnLane;
  produce: typeof produce;
  worker: typeof worker;
  _workerOverrideRefused: typeof _workerOverrideRefused;
  _worker_override_refused: typeof _workerOverrideRefused;
  _workerPlan: typeof _workerPlan;
  _worker_plan: typeof _workerPlan;
  _drainPending: typeof _drainPending;
  _drain_pending: typeof _drainPending;
  lappy: LappyHookLike;
  cloudlane: CloudlaneHookLike;
  renderPolicy: RenderPolicyHookLike;
  render_policy: RenderPolicyHookLike;
  telemetry: typeof telemetryMod;
  subprocess: typeof subprocess;
  time: typeof time;
  loadTimeline: () => Promise<TimelineModuleLike> | TimelineModuleLike;
}

const hookStore = {
  prepare,
  _probe,
  _renderRoot,
  _fileSha256,
  _capfreeNode,
  renderLocal,
  renderRemote,
  renderCloud,
  _render,
  _renderOnLane,
  produce,
  worker,
  _workerOverrideRefused,
  _workerPlan,
  _drainPending,
  lappy,
  cloudlane,
  renderPolicy,
  telemetry: telemetryMod,
  subprocess,
  time,
  loadTimeline: defaultLoadTimeline,
};

export const _hooks: RenderlaneHooks = {
  get STUDIO(): string {
    return STUDIO;
  },
  set STUDIO(v: string) {
    STUDIO = v;
  },
  get prepare() {
    return hookStore.prepare;
  },
  set prepare(fn) {
    hookStore.prepare = fn;
  },
  get _probe() {
    return hookStore._probe;
  },
  set _probe(fn) {
    hookStore._probe = fn;
  },
  get _renderRoot() {
    return hookStore._renderRoot;
  },
  set _renderRoot(fn) {
    hookStore._renderRoot = fn;
  },
  get _render_root() {
    return hookStore._renderRoot;
  },
  set _render_root(fn) {
    hookStore._renderRoot = fn;
  },
  get _fileSha256() {
    return hookStore._fileSha256;
  },
  set _fileSha256(fn) {
    hookStore._fileSha256 = fn;
  },
  get _file_sha256() {
    return hookStore._fileSha256;
  },
  set _file_sha256(fn) {
    hookStore._fileSha256 = fn;
  },
  get _capfreeNode() {
    return hookStore._capfreeNode;
  },
  set _capfreeNode(fn) {
    hookStore._capfreeNode = fn;
  },
  get _capfree_node() {
    return hookStore._capfreeNode;
  },
  set _capfree_node(fn) {
    hookStore._capfreeNode = fn;
  },
  get renderLocal() {
    return hookStore.renderLocal;
  },
  set renderLocal(fn) {
    hookStore.renderLocal = fn;
  },
  get render_local() {
    return hookStore.renderLocal;
  },
  set render_local(fn) {
    hookStore.renderLocal = fn;
  },
  get renderRemote() {
    return hookStore.renderRemote;
  },
  set renderRemote(fn) {
    hookStore.renderRemote = fn;
  },
  get render_remote() {
    return hookStore.renderRemote;
  },
  set render_remote(fn) {
    hookStore.renderRemote = fn;
  },
  get renderCloud() {
    return hookStore.renderCloud;
  },
  set renderCloud(fn) {
    hookStore.renderCloud = fn;
  },
  get render_cloud() {
    return hookStore.renderCloud;
  },
  set render_cloud(fn) {
    hookStore.renderCloud = fn;
  },
  get _render() {
    return hookStore._render;
  },
  set _render(fn) {
    hookStore._render = fn;
  },
  get _renderOnLane() {
    return hookStore._renderOnLane;
  },
  set _renderOnLane(fn) {
    hookStore._renderOnLane = fn;
  },
  get _render_on_lane() {
    return hookStore._renderOnLane;
  },
  set _render_on_lane(fn) {
    hookStore._renderOnLane = fn;
  },
  get produce() {
    return hookStore.produce;
  },
  set produce(fn) {
    hookStore.produce = fn;
  },
  get worker() {
    return hookStore.worker;
  },
  set worker(fn) {
    hookStore.worker = fn;
  },
  get _workerOverrideRefused() {
    return hookStore._workerOverrideRefused;
  },
  set _workerOverrideRefused(fn) {
    hookStore._workerOverrideRefused = fn;
  },
  get _worker_override_refused() {
    return hookStore._workerOverrideRefused;
  },
  set _worker_override_refused(fn) {
    hookStore._workerOverrideRefused = fn;
  },
  get _workerPlan() {
    return hookStore._workerPlan;
  },
  set _workerPlan(fn) {
    hookStore._workerPlan = fn;
  },
  get _worker_plan() {
    return hookStore._workerPlan;
  },
  set _worker_plan(fn) {
    hookStore._workerPlan = fn;
  },
  get _drainPending() {
    return hookStore._drainPending;
  },
  set _drainPending(fn) {
    hookStore._drainPending = fn;
  },
  get _drain_pending() {
    return hookStore._drainPending;
  },
  set _drain_pending(fn) {
    hookStore._drainPending = fn;
  },
  get lappy() {
    return hookStore.lappy;
  },
  set lappy(v) {
    hookStore.lappy = v;
  },
  get cloudlane() {
    return hookStore.cloudlane;
  },
  set cloudlane(v) {
    hookStore.cloudlane = v;
  },
  get renderPolicy() {
    return hookStore.renderPolicy;
  },
  set renderPolicy(v) {
    hookStore.renderPolicy = v;
  },
  get render_policy() {
    return hookStore.renderPolicy;
  },
  set render_policy(v) {
    hookStore.renderPolicy = v;
  },
  get telemetry() {
    return hookStore.telemetry;
  },
  set telemetry(v) {
    hookStore.telemetry = v;
  },
  get subprocess() {
    return hookStore.subprocess;
  },
  set subprocess(v) {
    hookStore.subprocess = v;
  },
  get time() {
    return hookStore.time;
  },
  set time(v) {
    hookStore.time = v;
  },
  get loadTimeline() {
    return hookStore.loadTimeline;
  },
  set loadTimeline(fn) {
    hookStore.loadTimeline = fn;
  },
};

export function _resetHooksForTests(): void {
  STUDIO = process.env.MANHWA_STUDIO || DEFAULT_STUDIO;
  _activeProduceByWorker.clear();
  subprocess.run = defaultSubprocessRun;
  time.now = () => Date.now() / 1000;
  time.time = () => Date.now() / 1000;
  time.sleep = (seconds: number): Promise<void> => {
    const ms =
      process.env.VITEST || process.env.MANHWA_FAST_RENDERLANE_POLL === "1"
        ? Math.min(Math.max(0, seconds) * 1000, 15)
        : Math.max(0, seconds) * 1000;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  };
  Object.defineProperties(
    lappy,
    Object.getOwnPropertyDescriptors(createDefaultLappyProxy()),
  );
  Object.defineProperties(
    cloudlane,
    Object.getOwnPropertyDescriptors(createDefaultCloudlaneProxy()),
  );
  Object.defineProperties(
    renderPolicy,
    Object.getOwnPropertyDescriptors(createDefaultRenderPolicyProxy()),
  );
  defaultUseRemoteRef = lappy.use_remote;
  defaultUseRemoteCamelRef = lappy.useRemote;
  hookStore.prepare = prepare;
  hookStore._probe = _probe;
  hookStore._renderRoot = _renderRoot;
  hookStore._fileSha256 = _fileSha256;
  hookStore._capfreeNode = _capfreeNode;
  hookStore.renderLocal = renderLocal;
  hookStore.renderRemote = renderRemote;
  hookStore.renderCloud = renderCloud;
  hookStore._render = _render;
  hookStore._renderOnLane = _renderOnLane;
  hookStore.produce = produce;
  hookStore.worker = worker;
  hookStore._workerOverrideRefused = _workerOverrideRefused;
  hookStore._workerPlan = _workerPlan;
  hookStore._drainPending = _drainPending;
  hookStore.lappy = lappy;
  hookStore.cloudlane = cloudlane;
  hookStore.renderPolicy = renderPolicy;
  hookStore.telemetry = telemetryMod;
  hookStore.subprocess = subprocess;
  hookStore.time = time;
  hookStore.loadTimeline = defaultLoadTimeline;
}

/* ------------------------------------------------------------------ *
 * Standalone CLI entrypoint
 * ------------------------------------------------------------------ */

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length < 2) {
    process.stderr.write(`${DOC}\n`);
    return 1;
  }
  const series = argv[0]!;
  const chs = argv.slice(1);
  const seriesRoot = process.env.MANHWA_SERIES_ROOT || DEFAULT_SERIES_ROOT;
  const sdir = path.join(seriesRoot, series);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(sdir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory() || st.isSymbolicLink()) {
    process.stderr.write(`no such series: ${sdir}\n`);
    return 1;
  }
  return await withSharedSeriesLock({ directSdir: sdir }, async (): Promise<number> => {
    _hooks.telemetry.start(series, [...chs], true);
    const out = path.join(sdir, "out");
    const q = new RenderQueue<string | null>();
    const res: Record<string, VideoResult> = {};
    const workerTask = _hooks.worker(sdir, out, q, res);
    for (const ch of chs) {
      q.put(ch);
    }
    await q.join();
    q.put(null);
    await workerTask;
    for (const ch of chs) {
      console.log(ch, pyRepr(res[ch]));
    }
    const allOk = Object.values(res).every((r) => r.status === "video-ok");
    _hooks.telemetry.finish(allOk);
    return allOk ? 0 : 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
