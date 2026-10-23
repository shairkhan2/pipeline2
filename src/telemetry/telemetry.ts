/**
 * Best-effort, local status snapshots. Never store prompts, credentials or payloads.
 *
 * Snapshots are per process, atomically replaced, and tied to /proc start ticks so
 * an old run cannot look live after PID reuse. All public writers are fail-open:
 * an unavailable dashboard must never interrupt a paid pipeline operation.
 *
 * Ported from `pipeline/telemetry.py`. Python `threading.local()` `_tls` is replaced
 * by Node's `AsyncLocalStorage`, with a module-level default binding so callers that
 * never wrap work in `AsyncLocalStorage.run(...)` behave exactly like the Python
 * thread-local (attributes read as unset -> None).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureNote } from '../domain/failure.js';

export type StageState =
  | 'running'
  | 'done'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'queued'
  | 'retrying'
  | (string & {});

interface TraceContext {
  chapter: string | null | undefined;
  worker: string | null | undefined;
  role: string | null | undefined;
  stage: string | null | undefined;
}

interface ChapterEntry {
  stages: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface TelemetryData {
  schemaVersion: number;
  id: string;
  pid: number;
  startTicks: number;
  startedAt: number;
  state: string;
  series: string;
  video: boolean;
  captionVersion: number;
  chapters: Record<string, ChapterEntry>;
  workers: Record<string, Record<string, unknown>>;
  models: Record<string, unknown>;
  providers: Record<string, unknown>;
  activeCalls: Record<string, Record<string, unknown>>;
  recentCalls: Array<Record<string, unknown>>;
  events: Array<{ at: number; message: string; kind: string }>;
  totals: { calls: number; errors: number; tokens: number };
  updatedAt?: number;
  endedAt?: number;
  [key: string]: unknown;
}

export interface CallLane {
  name?: string;
  model?: string;
  [key: string]: unknown;
}

export const als = new AsyncLocalStorage<TraceContext>();

// Fallback binding for callers that never enter an AsyncLocalStorage.run scope.
// `undefined` means "attribute never set", matching Python getattr defaults.
const defaultContext: TraceContext = {
  chapter: undefined,
  worker: undefined,
  role: undefined,
  stage: undefined,
};

/**
 * Run `fn` inside an isolated trace context (the AsyncLocalStorage equivalent of
 * one Python thread's `_tls`). Concurrent `run` scopes never see each other's
 * chapter/worker/role/stage. Callers that skip this keep using `defaultContext`,
 * which behaves like the module-level thread-local of the Python original.
 */
export function run<T>(
  ctx: Partial<TraceContext>,
  fn: () => T,
): T {
  return als.run({ ...defaultContext, ...ctx }, fn);
}

let data: TelemetryData | null = null;
let statusPath: string | null = null;

function context(): TraceContext {
  return als.getStore() ?? defaultContext;
}

function now(): number {
  return Date.now() / 1000;
}

/** Fail-open wrapper: an unavailable dashboard never interrupts a paid operation. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function write(): void {
  if (!data || !statusPath) return;
  data.updatedAt = now();
  const tmp = statusPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, statusPath);
}

function event(message: string, kind = 'info'): void {
  if (!data) return;
  data.events.push({ at: now(), message, kind });
  data.events = data.events.slice(-60);
}

/** Public event hook (e.g. "all lanes busy, retrying in 90s") for the Status feed. */
export function notice(message: string, kind = 'info'): void {
  safe(() => {
    event(message, kind);
    write();
  });
}

/** `/proc/self/stat` start ticks: `rsplit(')', 1)[1].split()[19]`. */
function selfStartTicks(): number {
  const raw = fs.readFileSync('/proc/self/stat', 'utf8');
  const idx = raw.lastIndexOf(')');
  const parts = raw.slice(idx + 1).trim().split(/\s+/);
  const ticks = Number(parts[19]);
  if (!Number.isFinite(ticks)) throw new Error('startTicks unavailable');
  return ticks;
}

export function start(series: string, chapters: string[], video = false, captionVersion = 1): void {
  safe(() => {
    const startTicks = selfStartTicks();
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const logPath = process.env.PIPELINE_LOG || path.join(projectRoot, 'out', 'pipeline.log');
    const root = process.env.PIPELINE_STATUS_DIR || path.join(path.dirname(logPath), 'status');
    fs.mkdirSync(root, { recursive: true });
    const runId = `${process.pid}-${startTicks}`;
    statusPath = path.join(root, runId + '.json');

    defaultContext.chapter = null;
    defaultContext.worker = null;
    defaultContext.role = null;
    defaultContext.stage = null;
    const store = als.getStore();
    if (store) {
      store.chapter = null;
      store.worker = null;
      store.role = null;
      store.stage = null;
    }

    data = {
      schemaVersion: 1,
      id: runId,
      pid: process.pid,
      startTicks,
      startedAt: now(),
      state: 'running',
      series,
      video,
      captionVersion,
      chapters: Object.fromEntries(chapters.map((ch) => [ch, { stages: {} } as ChapterEntry])),
      workers: {},
      models: {},
      providers: {},
      activeCalls: {},
      recentCalls: [],
      events: [],
      totals: { calls: 0, errors: 0, tokens: 0 },
    };
    event(`Run started · ${series} · ${chapters.length} chapters`);
    write();
  });
}

export function bind(opts: {
  chapter?: string | null;
  worker?: string | null;
  role?: string | null;
} = {}): void {
  safe(() => {
    const ctx = context();
    if (opts.chapter !== undefined && opts.chapter !== null) ctx.chapter = opts.chapter;
    if (opts.worker !== undefined && opts.worker !== null) ctx.worker = opts.worker;
    if (opts.role !== undefined && opts.role !== null) ctx.role = opts.role;
  });
}

export function models(groups: Record<string, Array<Record<string, unknown>>>): void {
  safe(() => {
    if (!data) return;
    for (const [role, lanes] of Object.entries(groups)) {
      data.models[role] = lanes.map((ln) => ({
        name: ln?.name ?? null,
        model: ln?.model ?? null,
        kind: ln?.kind ?? null,
      }));
    }
    write();
  });
}

export function stage(
  chapter: string,
  name: string,
  state: StageState = 'running',
  details: Record<string, unknown> = {},
): void {
  safe(() => {
    if (!data) return;
    let ch = data.chapters[chapter];
    if (!ch) {
      ch = { stages: {} };
      data.chapters[chapter] = ch;
    }
    if (!ch.stages) ch.stages = {};
    const previous = ch.stages[name] ?? {};
    const entry: Record<string, unknown> = { ...previous, ...details, state, updatedAt: now() };
    if (state === 'running' && previous.state !== 'running') {
      entry.startedAt = now();
      delete entry.endedAt;
    }
    if (state === 'done' || state === 'warning' || state === 'failed' || state === 'skipped') {
      entry.endedAt = now();
    }
    ch.stages[name] = entry;

    const ctx = context();
    ctx.chapter = chapter;
    if (ctx.worker) ch.worker = ctx.worker;
    ctx.stage = name;
    if (state !== previous.state) {
      event(`${chapter} · ${name} · ${state}`, state === 'failed' ? 'error' : 'info');
    }
    write();
  });
}

export function stageCurrent(
  name: string,
  state: StageState = 'running',
  details: Record<string, unknown> = {},
): void {
  safe(() => {
    const chapter = context().chapter;
    if (chapter) stage(chapter, name, state, details);
  });
}

function failureStage(chapter: string, error: unknown, state: StageState, details: Record<string, unknown> = {}): void {
  safe(() => {
    if (!data) return;
    const ctx = context();
    // Outside `run(...)` the trace context still points at the stage that ran
    // first (typically "audio"), which is already "done". Prefer the stage that
    // is actually in flight for this chapter so a render crash never rewrites
    // audio and leaves render stuck on "running".
    const chStages = (data.chapters[chapter]?.stages ?? {}) as Record<
      string,
      { state?: string } | undefined
    >;
    const stageOrder = ['render', 'timeline', 'clean', 'audio', 'check', 'writer', 'reader'];
    const activeStage = stageOrder.find((s) => {
      const st = chStages[s]?.state;
      return st === 'running' || st === 'retrying' || st === 'queued';
    });
    const ctxStage = ctx.chapter === chapter || !ctx.chapter ? ctx.stage : undefined;
    const TERMINAL = new Set(['done', 'warning', 'skipped']);
    const validCtxStage =
      ctxStage && !TERMINAL.has(String(chStages[ctxStage]?.state ?? '')) ? ctxStage : undefined;
    const targetStage = activeStage || validCtxStage || 'pipeline';
    stage(chapter, targetStage, state, { ...details, note: failureNote(error) });
  });
}

export function failed(chapter: string, error: unknown): void {
  failureStage(chapter, error, 'failed');
}

export function retrying(chapter: string, error: unknown, details: { retryAt: number; attempt: number; maxAttempts: number }): void {
  failureStage(chapter, error, 'retrying', details);
}

/** Register/update ANY worker id. Future backends use the same function. */
export function worker(name: string, details: Record<string, unknown> = {}): void {
  safe(() => {
    if (!data || !name) return;
    const old = data.workers[name] ?? {};
    data.workers[name] = { ...old, ...details, id: name, updatedAt: now() };
    write();
  });
}

export function provider(name: string, details: Record<string, unknown> = {}): void {
  safe(() => {
    if (!data) return;
    const old = (data.providers[name] as Record<string, unknown> | undefined) ?? {};
    data.providers[name] = { ...old, ...details };
    write();
  });
}

export function callStart(lane: CallLane, tag: unknown, attempt: unknown): string | null {
  return safe(() => {
    if (!data) return null;
    const ident = randomUUID().replace(/-/g, '').slice(0, 12);
    const ctx = context();
    data.activeCalls[ident] = {
      id: ident,
      provider: lane?.name ?? null,
      model: lane?.model ?? null,
      role: ctx.role === undefined ? 'unknown' : ctx.role,
      chapter: ctx.chapter ?? null,
      tag: String(tag).slice(0, 120),
      attempt,
      startedAt: now(),
    };
    write();
    return ident;
  });
}

export function callEnd(
  ident: string | null | undefined,
  state: string,
  tokens?: number | null,
  note?: string | null,
): void {
  safe(() => {
    if (!data || !ident) return;
    const call = data.activeCalls[ident];
    if (!call) return;
    delete data.activeCalls[ident];
    call.state = state;
    call.endedAt = now();
    call.tokens = tokens ?? null;
    call.note = note ?? null;
    call.duration = (call.endedAt as number) - (call.startedAt as number);
    data.recentCalls.push(call);
    data.recentCalls = data.recentCalls.slice(-40);
    data.totals.calls += 1;
    data.totals.errors += state !== 'ok' ? 1 : 0;
    if (typeof tokens === 'number' && Number.isFinite(tokens)) data.totals.tokens += tokens;
    write();
  });
}

export function finish(success = true): void {
  safe(() => {
    if (!data) return;
    data.state = success ? 'completed' : 'failed';
    data.endedAt = now();
    event('Run ' + data.state, success ? 'info' : 'error');
    write();
  });
}

/** Process exit: a run that is still 'running' is 'interrupted', never left live. */
function exitHandler(): void {
  safe(() => {
    if (data && data.state === 'running') {
      data.state = 'interrupted';
      data.endedAt = now();
      write();
    }
  });
}

process.on('exit', exitHandler);

/* ------------------------------------------------------------------ *
 * Test hooks. Mirror Python's direct access to `telemetry._data` /
 * `telemetry._path` so parity suites can reset and inspect state.
 * ------------------------------------------------------------------ */

export function _reset(): void {
  data = null;
  statusPath = null;
  defaultContext.chapter = undefined;
  defaultContext.worker = undefined;
  defaultContext.role = undefined;
  defaultContext.stage = undefined;
}

export function _path(): string | null {
  return statusPath;
}

export function _data(): TelemetryData | null {
  return data;
}
