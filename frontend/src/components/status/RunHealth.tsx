import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { RawDetails } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
import { parseFailureNote, type FailureNote } from "@/lib/errors";
import { cn } from "@/lib/utils";

export interface HealthCall {
  state?: string;
  tag?: string;
  role?: string;
  chapter?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  tokens?: number | null;
  note?: string | null;
  duration?: number;
  endedAt?: number;
}

export interface HealthEvent {
  at?: number;
  message?: string;
  kind?: string;
}

export interface HealthRun {
  alive?: boolean;
  state?: string;
  providers?: Record<string, { coolingUntil?: number }>;
  recentCalls?: HealthCall[];
  events?: HealthEvent[];
  totals?: { calls?: number; errors?: number; tokens?: number };
  models?: Record<string, Array<{ name?: string; model?: string }>>;
}

/** Wall clock that ticks once a second only until the last cooling lane expires. */
function useNow(coolingUntil: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (coolingUntil <= Date.now()) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= coolingUntil) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [coolingUntil]);
  return Math.max(now, Date.now());
}

/** Epoch seconds or milliseconds to milliseconds. */
function toMs(value: number): number {
  return value < 1e11 ? value * 1000 : value;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function clock(at?: number): string {
  if (!at) return "";
  return new Date(toMs(at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface LaneState {
  provider: string;
  models: string[];
  coolingMs: number;
  lastError: FailureNote | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
}

const DOT = { ok: "bg-success", wait: "bg-warning", bad: "bg-destructive" } as const;
const WORD = { ok: "text-muted-foreground", wait: "text-warning", bad: "text-destructive" } as const;

/** One row per provider: dot, name, one-word status. Hover a row for the reason. */
export function LaneHealth({ run }: { run: HealthRun }) {
  const live = run.alive !== false && run.state === "running";
  const coolingUntil = live
    ? Math.max(0, ...Object.values(run.providers || {}).map((info) => (typeof info.coolingUntil === "number" && Number.isFinite(info.coolingUntil) ? toMs(info.coolingUntil) : 0)))
    : 0;
  const now = useNow(coolingUntil);
  const lanes = new Map<string, LaneState>();
  const touch = (provider: string) => {
    let lane = lanes.get(provider);
    if (!lane) {
      lane = { provider, models: [], coolingMs: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
      lanes.set(provider, lane);
    }
    return lane;
  };
  for (const group of Object.values(run.models || {})) {
    for (const row of group || []) {
      if (!row?.name) continue;
      const lane = touch(row.name);
      if (row.model && !lane.models.includes(row.model)) lane.models.push(row.model);
    }
  }
  for (const call of run.recentCalls || []) {
    if (!call.provider) continue;
    const lane = touch(call.provider);
    if (call.model && !lane.models.includes(call.model)) lane.models.push(call.model);
    const endedAt = toMs(call.endedAt ?? 0);
    if (call.state === "ok") lane.lastOkAt = Math.max(lane.lastOkAt ?? 0, endedAt);
    if (call.state === "error" && (lane.lastErrorAt === null || endedAt >= lane.lastErrorAt)) {
      lane.lastError = parseFailureNote(call.note);
      lane.lastErrorAt = endedAt;
    }
  }
  for (const [provider, info] of Object.entries(run.providers || {})) {
    const lane = touch(provider);
    if (live && typeof info?.coolingUntil === "number") lane.coolingMs = Math.max(0, toMs(info.coolingUntil) - now);
  }
  const rows = [...lanes.values()];
  if (!rows.length) return null;

  return (
    <section aria-labelledby="laneHealthHeading">
      <h2 id="laneHealthHeading" className="sr-section-label">Models</h2>
      <ul className="sr-group">
        {rows.map((lane) => {
          const cooling = lane.coolingMs > 0;
          const failed = !cooling && lane.lastError && (lane.lastOkAt === null || (lane.lastErrorAt ?? 0) >= lane.lastOkAt);
          const state = cooling ? "wait" : failed ? "bad" : "ok";
          const word = cooling ? countdown(lane.coolingMs) : failed ? lane.lastError!.label : "Ready";
          const why = cooling || failed ? lane.lastError?.title : undefined;
          return (
            <li key={lane.provider} className="sr-row min-h-12 py-2.5" title={why}>
              <span className={cn("size-2 shrink-0 rounded-full", DOT[state])} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[15px]">
                {lane.provider}
                {lane.models[0] ? <span className="ml-2 text-[13px] text-muted-foreground">{lane.models[0]}{lane.models.length > 1 ? ` +${lane.models.length - 1}` : ""}</span> : null}
              </span>
              <span className={cn("shrink-0 text-[14px] font-medium tabular-nums", WORD[state])} role={cooling ? "timer" : undefined}>
                {word}
                {why ? <span className="sr-only">, {why}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Calls, failures and tokens as three quiet numbers. */
export function RunTotals({ run }: { run: HealthRun }) {
  const totals = run.totals || {};
  const calls = totals.calls ?? 0;
  if (!calls && !totals.tokens) return null;
  const errors = totals.errors ?? 0;
  const items: Array<[string, string, string?]> = [
    ["Calls", String(calls)],
    ["Failed", String(errors), errors ? "text-destructive" : undefined],
    ["Tokens", compact(totals.tokens ?? 0)],
  ];
  return (
    <dl className="flex gap-6">
      {items.map(([label, value, tone]) => (
        <div key={label}>
          <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</dd>
          <dt className="text-[13px] text-muted-foreground">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

export interface FeedItem {
  at?: number;
  kind: "call" | "stage" | "event";
  tone: "danger" | "warning" | "info";
  where: string;
  note?: FailureNote;
  message?: string;
}

/** Build the activity feed: all problems, plus successful calls and other events when requested. */
export function buildFeed(
  run: (HealthRun & { chapters?: Record<string, { stages?: Record<string, { state?: string; note?: string; startedAt?: number; updatedAt?: number }> }> }) | null,
  issuesOnly: boolean,
  stageName: (id: string) => string,
  retryLabel?: string,
): FeedItem[] {
  if (!run) return [];
  const out: FeedItem[] = [];
  for (const call of run.recentCalls || []) {
    const where = [call.provider, call.tag || call.chapter].filter(Boolean).join(" · ");
    if (call.state === "ok" && !issuesOnly) {
      out.push({
        at: call.endedAt,
        kind: "call",
        tone: "info",
        where,
        message: [typeof call.duration === "number" ? `${call.duration.toFixed(0)}s` : "", call.tokens == null ? "" : `${compact(call.tokens)} tokens`].filter(Boolean).join(" · "),
      });
    }
    if (call.state !== "error") continue;
    if (call.chapter && Object.values(run.chapters?.[call.chapter]?.stages || {}).some((stage) => stage.state === "failed" || stage.state === "retrying")) continue;
    const note = parseFailureNote(call.note);
    out.push({ at: call.endedAt, kind: "call", tone: note.tone, where: [call.provider, call.chapter || call.tag].filter(Boolean).join(" · "), note });
  }
  for (const [chapter, row] of Object.entries(run.chapters || {})) {
    for (const [name, stage] of Object.entries(row.stages || {})) {
      if (stage.state !== "failed" && stage.state !== "interrupted" && stage.state !== "retrying") continue;
      out.push({
        at: stage.updatedAt ?? stage.startedAt,
        kind: "stage",
        tone: stage.state === "failed" ? "danger" : "warning",
        where: stageName(name),
        note: stage.note ? parseFailureNote(stage.note) : undefined,
        message: `${chapter.replace(/^ch/i, "Chapter ")} ${stage.state === "failed" ? "failed" : stage.state === "retrying" ? "retrying" : "stopped"}`,
      });
    }
  }
  for (const event of run.events || []) {
    const duplicate = /^ch(\d+)\s*·\s*(\w+)\s*·\s*(failed|retrying)/i.exec(event.message || "");
    const duplicateStage = duplicate ? run.chapters?.[`ch${duplicate[1]}`]?.stages?.[duplicate[2]!] : undefined;
    if (duplicateStage && (duplicateStage.state === "failed" || duplicateStage.state === "retrying")) continue;
    if (retryLabel && /run failed/i.test(event.message || "")) {
      out.push({ at: event.at, kind: "event", tone: "warning", where: "", message: retryLabel });
      continue;
    }
    const kind = event.kind === "warn" ? "warning" : event.kind;
    if (issuesOnly && kind !== "error" && kind !== "warning") continue;
    out.push({ at: event.at, kind: "event", tone: kind === "error" ? "danger" : kind === "warning" ? "warning" : "info", where: "", message: event.message, note: kind === "error" || kind === "warning" ? parseFailureNote(event.message) : undefined });
  }
  return out.sort((a, b) => toMs(b.at ?? 0) - toMs(a.at ?? 0)).slice(0, 40);
}

const TONE_DOT: Record<FeedItem["tone"], string> = { danger: "bg-destructive", warning: "bg-warning", info: "bg-raised" };

/** One line per item: dot, short title, where, time. Raw provider text opens on demand. */
export function FeedRow({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const note = item.note;
  const title = item.kind === "stage" ? item.message : note ? note.title : item.message;
  const sub = item.kind === "stage" ? [item.where, note?.title].filter(Boolean).join(" · ") : item.where;
  const raw = note?.raw;
  return (
    <li className="sr-row block py-2.5">
      <div className="flex items-center gap-3">
        <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[item.tone])} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate", item.tone === "info" && item.kind === "call" ? "text-[14px] text-muted-foreground" : "text-[15px]")}>{title}</p>
          {sub ? <p className="truncate text-[13px] text-muted-foreground">{sub}</p> : null}
        </div>
        {raw ? (
          <Tooltip label={open ? "Hide details" : "Show details"} side="top"><button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((value) => !value)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
          </button></Tooltip>
        ) : null}
        <time className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{clock(item.at)}</time>
      </div>
      {raw ? (
        <div id={id} hidden={!open} className="mt-2 ml-5 rounded-xl bg-background px-3 py-2 text-muted-foreground">
          <RawDetails text={raw} />
        </div>
      ) : null}
    </li>
  );
}
