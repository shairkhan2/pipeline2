import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { api, isApiError, type ProviderView } from "@/lib/api";

const POOL_NAME: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  other: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  deepseek: "DeepSeek",
  xai: "xAI Grok",
  grok: "Grok",
  vertex: "Vertex AI",
  copilot: "Copilot",
  local: "Local",
  any: "All models",
  "?": "Unclassified",
};

function formatPoolName(pool: string): string {
  const key = String(pool || "").trim().toLowerCase();
  if (POOL_NAME[key]) return POOL_NAME[key];
  if (!pool) return "Unclassified";
  return String(pool)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function inferFamilyKey(raw: string): string {
  const text = String(raw || "").toLowerCase();
  if (/gemini|google|vertex/.test(text)) return "gemini";
  if (/claude|anthropic/.test(text)) return "claude";
  if (/codex/.test(text)) return "codex";
  if (/openai|gpt|o1|o3|o4/.test(text)) return "openai";
  if (/deepseek/.test(text)) return "deepseek";
  if (/xai|grok/.test(text)) return "xai";
  if (/copilot|github/.test(text)) return "copilot";
  if (/ollama|lmstudio|vllm|local/.test(text)) return "local";
  return String(raw || "other").trim().toLowerCase() || "other";
}

function groupProvidersByFamily(providers: ProviderView[]): Array<{ pool: string; label: string; count: number }> {
  const groups = new Map<string, { pool: string; label: string; count: number }>();
  for (const provider of providers) {
    const modelFamilies = (provider.models || [])
      .filter((m) => m.enabled !== false)
      .map((m) => inferFamilyKey(m.id));
    const keys =
      modelFamilies.length > 0
        ? Array.from(new Set(modelFamilies))
        : [inferFamilyKey(`${provider.id} ${provider.preset || ""} ${provider.label}`)];
    for (const key of keys) {
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, {
          pool: key,
          label: POOL_NAME[key] || provider.label || formatPoolName(key),
          count: 1,
        });
      }
    }
  }
  return [...groups.values()];
}

interface PoolInfo {
  remaining: number | null;
  reset_ts?: number;
}

interface AgyAccount {
  label: string;
  email?: string;
  active: string[];
  parked: Array<[string, number]>;
  pools: Record<string, PoolInfo | null>;
}

interface SpendBucket {
  total: number;
  calls: number;
}

interface UsageWindow {
  label: string;
  total: number;
  calls: number;
  input: number;
  output: number;
  thinking: number;
  cache_read: number;
  failed: number;
  quota_switches: number;
  wall_s: number;
  by_pool: Record<string, SpendBucket>;
  by_account: Record<string, SpendBucket>;
  by_model: Record<string, SpendBucket>;
  unknown_token_calls: number;
}

interface DailyBar {
  day: string;
  calls: number;
  total: number;
  gemini: number;
  other: number;
}

interface AgyData {
  hasAccounts: boolean;
  accounts: AgyAccount[];
  windows: UsageWindow[];
  daily: DailyBar[];
  usageLog: string;
  generatedAt: number;
}

type Source = "agy" | "providers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bucketMap(value: unknown): Record<string, SpendBucket> {
  if (!isRecord(value)) return {};
  const out: Record<string, SpendBucket> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    out[key] = { total: num(raw.total), calls: num(raw.calls) };
  }
  return out;
}

function readWindow(value: unknown, index: number): UsageWindow | null {
  if (!isRecord(value)) return null;
  return {
    label: typeof value.label === "string" ? value.label : `Window ${index + 1}`,
    total: num(value.total),
    calls: num(value.calls),
    input: num(value.input),
    output: num(value.output),
    thinking: num(value.thinking),
    cache_read: num(value.cache_read ?? value.cacheRead),
    failed: num(value.failed),
    quota_switches: num(value.quota_switches ?? value.quotaSwitches),
    wall_s: num(value.wall_s ?? value.wallS),
    by_pool: bucketMap(value.by_pool ?? value.byPool),
    by_account: bucketMap(value.by_account ?? value.byAccount),
    by_model: bucketMap(value.by_model ?? value.byModel),
    unknown_token_calls: num(value.unknown_token_calls ?? value.unknownTokenCalls),
  };
}

function readPool(value: unknown): PoolInfo | null {
  if (!isRecord(value)) return null;
  const remaining = value.remaining == null ? null : num(value.remaining);
  const reset = value.reset_ts ?? value.resetTs;
  return { remaining, reset_ts: reset == null ? undefined : num(reset) };
}

function readAgy(payload: unknown): AgyData | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.error === "string" && !payload.accounts && !payload.windows && !payload.daily) return null;
  const accountsRaw = Array.isArray(payload.accounts) ? payload.accounts : [];
  const accounts: AgyAccount[] = accountsRaw.filter(isRecord).map((account) => {
    const parkedRaw = isRecord(account.parked) ? account.parked : {};
    const poolsRaw = isRecord(account.pools) ? account.pools : {};
    const pools: Record<string, PoolInfo | null> = {};
    for (const [key, val] of Object.entries(poolsRaw)) {
      pools[key] = readPool(val);
    }
    if (!("gemini" in pools)) pools.gemini = null;
    if (!("other" in pools) && Object.keys(pools).length <= 1) pools.other = null;
    return {
      label: typeof account.label === "string" ? account.label : "Account",
      email: typeof account.email === "string" ? account.email : undefined,
      active: Array.isArray(account.active) ? account.active.filter((item): item is string => typeof item === "string") : [],
      parked: Object.entries(parkedRaw).map(([key, ts]) => [key, num(ts)] as [string, number]),
      pools,
    };
  });
  const windows = (Array.isArray(payload.windows) ? payload.windows : []).map(readWindow).filter((item): item is UsageWindow => Boolean(item));
  const daily = (Array.isArray(payload.daily) ? payload.daily : []).filter(isRecord).map((day) => ({
    day: typeof day.day === "string" ? day.day : "",
    calls: num(day.calls),
    total: num(day.total),
    gemini: num(day.gemini),
    other: num(day.other),
  }));
  const hasAccounts = payload.has_accounts === true || payload.hasAccounts === true || accounts.length > 0;
  if (!hasAccounts && windows.length === 0 && daily.length === 0 && accounts.length === 0 && payload.has_accounts == null && payload.hasAccounts == null) {
    return null;
  }
  return {
    hasAccounts,
    accounts,
    windows,
    daily,
    usageLog: typeof payload.usage_log === "string" ? payload.usage_log : typeof payload.usageLog === "string" ? payload.usageLog : "usage.jsonl",
    generatedAt: num(payload.generatedAt ?? payload.generated_at),
  };
}

function human(value: number): string {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function dur(seconds: number): string {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function when(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `resets ${time}`;
  return `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function stampFrom(ts: number): string {
  if (!ts) return new Date().toLocaleTimeString();
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString();
}

function last30(daily: DailyBar[]): DailyBar[] {
  const byDay = new Map(daily.filter((day) => day.day).map((day) => [day.day, day]));
  const today = new Date();
  const days: DailyBar[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    days.push(byDay.get(key) ?? { day: key, calls: 0, total: 0, gemini: 0, other: 0 });
  }
  return days;
}

function QuotaRing({ pool, info, labelOverride }: { pool: string; info: PoolInfo | null; labelOverride?: string }) {
  const remaining = info ? info.remaining : null;
  const known = remaining != null;
  const pct = known ? Math.max(0, Math.min(100, remaining)) : 0;
  const low = known && remaining <= 20;
  const empty = known && remaining <= 0;
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const arc = known && !empty ? (circumference * pct) / 100 : 0;
  const displayPool = labelOverride || formatPoolName(pool);
  const label = `${displayPool}: ${known ? `${remaining}% left` : "quota unavailable"}${known && info?.reset_ts ? `, ${when(info.reset_ts)}` : ""}`;
  const stroke = !known || empty ? "transparent" : low ? "#ef6b5b" : pool === "gemini" ? "#f18b6e" : "#d6b57b";
  return (
    <div className="grid w-14 justify-items-center gap-0.5" role="img" aria-label={label} title={label}>
      <svg className="size-10" viewBox="0 0 34 34" aria-hidden>
        <circle cx="17" cy="17" r={radius} fill="none" stroke="#101113" strokeWidth="3.5" />
        <circle
          cx="17"
          cy="17"
          r={radius}
          fill="none"
          stroke={known && !empty ? stroke : "transparent"}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${arc.toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 17 17)"
        />
        <text x="17" y="18.5" textAnchor="middle" fill={low ? "#ef6b5b" : "#f2efe9"} fontSize="8" fontFamily="JetBrains Mono, ui-monospace, monospace">
          {known ? `${Math.round(remaining)}` : "—"}
        </text>
      </svg>
      <span className={`truncate max-w-full text-[10px] ${low ? "text-[#ef6b5b]" : "text-[#a2a19f]"}`}>{displayPool}</span>
    </div>
  );
}

function BreakdownTable({
  caption,
  rows,
}: {
  caption: string;
  rows: Array<{ name: string; kind: string; total: number; calls: number; share: number }>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#2b2c30]">
      <table className="w-full min-w-[520px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-[#191a1d] text-xs tracking-[0.14em] text-[#a2a19f] uppercase">
          <tr>
            <th className="px-3 py-2 font-medium" scope="col">Name</th>
            <th className="px-3 py-2 font-medium" scope="col">Kind</th>
            <th className="px-3 py-2 font-medium" scope="col">Tokens</th>
            <th className="px-3 py-2 font-medium" scope="col">Calls</th>
            <th className="px-3 py-2 font-medium" scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-[#a2a19f]" colSpan={5}>Nothing recorded yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={`${row.kind}:${row.name}`} className="border-t border-[#2b2c30]">
                <th className="max-w-[240px] truncate px-3 py-2 font-normal" scope="row" title={row.name}>{row.name}</th>
                <td className="px-3 py-2 text-[#a2a19f]">{row.kind}</td>
                <td className="px-3 py-2 font-mono text-xs">{human(row.total)}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.calls}</td>
                <td className="px-3 py-2">
                  <span className="mb-1 block font-mono text-xs text-[#a2a19f]">{row.share.toFixed(0)}%</span>
                  <span className="block h-1 overflow-hidden rounded-full bg-[#101113]" aria-hidden>
                    <span className="block h-full bg-[#f18b6e]" style={{ width: `${row.share}%` }} />
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function rowsFrom(map: Record<string, SpendBucket>, kind: string, labels?: Record<string, string>): Array<{ name: string; kind: string; total: number; calls: number; share: number }> {
  const entries = Object.entries(map);
  const sum = entries.reduce((n, [, value]) => n + value.total, 0) || 1;
  return entries
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, value]) => ({
      name: labels ? labels[key] || formatPoolName(key) : key,
      kind,
      total: value.total,
      calls: value.calls,
      share: (value.total / sum) * 100,
    }));
}

export function MeterPage() {
  const [data, setData] = useState<AgyData | null>(null);
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState("");
  const [stamp, setStamp] = useState("reading the meters…");
  const [busy, setBusy] = useState(false);
  const [windowIdx, setWindowIdx] = useState(0);

  const seen = useRef(false);
  const windowTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    try {
      const payload = await api.agy(fresh);
      const parsed = readAgy(payload);
      if (!parsed) throw new Error("agy rotator unavailable");
      setData(parsed);
      setSource("agy");
      setError("");
      setStamp(`updated ${stampFrom(parsed.generatedAt)}`);
      seen.current = true;
      if (!parsed.hasAccounts) {
        const state = await api.studio.providers();
        setProviders(state.providers ?? []);
      } else {
        setProviders(null);
      }
    } catch (err) {
      try {
        const state = await api.studio.providers();
        setProviders(state.providers ?? []);
        setData(null);
        setSource("providers");
        setError("");
        setStamp("Studio providers updated");
        seen.current = true;
      } catch (fallback) {
        if (!seen.current) {
          setError(isApiError(fallback) ? fallback.message : isApiError(err) ? err.message : "The meter endpoint didn’t answer.");
        }
        setStamp("Could not update provider status");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(false);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const windowStat = data?.windows[Math.min(windowIdx, Math.max(0, data.windows.length - 1))] ?? data?.windows[0];
  const days = useMemo(() => last30(data?.daily ?? []), [data]);
  const maxDay = Math.max(1, ...days.map((day) => day.total));
  const breakdown = windowStat
    ? [
        ...rowsFrom(windowStat.by_pool, "meter", POOL_NAME),
        ...rowsFrom(windowStat.by_account, "account"),
        ...rowsFrom(windowStat.by_model, "model"),
      ]
    : [];

  function onWindowTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const count = data?.windows.length ?? 0;
    if (count === 0) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? count - 1
        : event.key === "ArrowLeft"
          ? (windowIdx - 1 + count) % count
          : (windowIdx + 1) % count;
    setWindowIdx(next);
    windowTabRefs.current[next]?.focus();
  }

  return (
    <AppShell
      active="meter"
      eyebrow="Quota and spend"
      title="Meter Room"
      actions={
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#a2a19f]" role="status">{stamp}</span>
          <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void load(true)}>
            <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} aria-hidden />
            {busy ? "Checking…" : "Check live quota"}
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="max-w-xl py-8" role="alert">
          <h2 className="font-serif text-3xl">The meter endpoint didn’t answer</h2>
          <p className="mt-2 text-sm text-[#a2a19f]">{error}</p>
          <Button type="button" className="mt-4 min-h-11" onClick={() => void load(true)}>Retry</Button>
        </div>
      ) : null}

      {!error && !data && !providers ? (
        <div className="py-10" aria-busy="true">
          <p className="font-serif text-3xl">Reading the meters</p>
          <p className="mt-2 text-sm text-[#a2a19f]">Asking each account how much is left.</p>
        </div>
      ) : null}

      {source === "agy" && data && !data.hasAccounts ? (
        <div className="mb-8 max-w-xl">
          <h2 className="font-serif text-3xl">Provider status</h2>
          <p className="mt-2 text-sm text-[#a2a19f]">Live quota is not available. Check your connected accounts below.</p>
        </div>
      ) : null}

      {source === "agy" && data?.hasAccounts ? (
        <div className="space-y-8">
          <section aria-label="Quota left">
            <div className="mb-3">
              <h2 className="font-serif text-2xl">Quota left</h2>
              <p className="text-sm text-[#a2a19f]">One ring per meter. The arc length is the quota still left.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.accounts.map((account) => {
                const mono = account.label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "•";
                const parkedUntil = account.parked.length ? Math.min(...account.parked.map(([, ts]) => ts)) : 0;
                return (
                  <article key={account.email || account.label} className="rounded-xl border border-[#2b2c30] bg-[#191a1d] p-3" title={account.email ? `${account.label} — ${account.email}` : account.label}>
                    <div className="flex items-center gap-2">
                      <span className="grid size-7 place-items-center rounded-md bg-[#101113] font-mono text-[10px] text-[#f18b6e]" aria-hidden>{mono}</span>
                      <span className="min-w-0 truncate text-sm">{account.label}</span>
                    </div>
                    <p className={`mt-1 truncate text-xs ${account.parked.length ? "text-[#ef6b5b]" : account.active.length ? "text-[#d6b57b]" : "text-[#a2a19f]"}`}>
                      {account.parked.length
                        ? `Parked until ${new Date(parkedUntil * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
                        : account.active.length
                          ? `Carrying ${account.active.map((pool) => formatPoolName(pool)).join(" and ")}`
                          : "Idle"}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      {Object.entries(account.pools).map(([poolKey, poolInfo]) => (
                        <QuotaRing key={poolKey} pool={poolKey} info={poolInfo} />
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section aria-label="Tokens spent">
            <div className="mb-3">
              <h2 className="font-serif text-2xl">Tokens spent</h2>
              <p className="text-sm text-[#a2a19f]">Usage per call over the last 30 days.</p>
            </div>
            {data.windows.length ? (
              <div className="mb-3 flex gap-1 overflow-x-auto" role="tablist" aria-label="Usage window" onKeyDown={onWindowTabKey}>
                {data.windows.map((item, index) => (
                  <button
                    key={`${item.label}-${index}`}
                    id={`usage-tab-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={index === windowIdx}
                    aria-controls="usage-window-panel"
                    tabIndex={index === windowIdx ? 0 : -1}
                    ref={(node) => {
                      windowTabRefs.current[index] = node;
                    }}
                    className={`min-h-11 shrink-0 rounded-lg border px-3 text-sm ${index === windowIdx ? "border-[#f18b6e] bg-[#30231f]" : "border-[#3c3e44] text-[#a2a19f]"}`}
                    onClick={() => setWindowIdx(index)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            {windowStat ? (
              <div
                id="usage-window-panel"
                role="tabpanel"
                aria-labelledby={data.windows.length ? `usage-tab-${windowIdx}` : undefined}
                className="mb-4 grid gap-4 rounded-xl border border-[#2b2c30] bg-[#191a1d] p-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <div className="sm:col-span-2 lg:col-span-1">
                  <p className="font-serif text-4xl leading-none">{human(windowStat.total)}</p>
                  <p className="mt-1 text-xs text-[#a2a19f]">tokens across {windowStat.calls} call{windowStat.calls === 1 ? "" : "s"}</p>
                </div>
                {[
                  ["Input", human(windowStat.input)],
                  ["Output", human(windowStat.output)],
                  ["Thinking", human(windowStat.thinking)],
                  ["Cache read", human(windowStat.cache_read)],
                  ["Failed calls", String(windowStat.failed)],
                  ["Quota switches", String(windowStat.quota_switches)],
                  ["Processing time", dur(windowStat.wall_s)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-[#a2a19f]">{label}</p>
                    <p className="font-mono text-sm">{value}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <LedgerChart days={days} maxDay={maxDay} />
            <div className="mt-4">
              <BreakdownTable caption="Token spend by meter, account, and model" rows={breakdown} />
            </div>
            {windowStat?.unknown_token_calls ? (
              <p className="mt-3 text-xs text-[#a2a19f]">
                {windowStat.unknown_token_calls} call(s) in this window had no token data. The ACP lane doesn’t report counts, so it is logged by volume and time instead.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {source === "providers" || (source === "agy" && data && !data.hasAccounts) ? (
        <ProviderFallback providers={providers} />
      ) : null}

      <p className="mt-8 text-xs leading-5 text-[#a2a19f]">
        Account quotas refresh every minute when available. Token usage stays on this machine.
      </p>
    </AppShell>
  );
}

function LedgerChart({ days, maxDay }: { days: DailyBar[]; maxDay: number }) {
  const summary = days.some((day) => day.total)
    ? `Token spend over the last 30 days. Peak day ${human(maxDay)} tokens.`
    : "No tokens recorded in the last 30 days.";
  return (
    <div className="rounded-xl border border-[#2b2c30] bg-[#191a1d] p-4">
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-[#a2a19f]">
        <span><span className="mr-1 inline-block size-2 bg-[#f18b6e]" aria-hidden />Gemini</span>
        <span><span className="mr-1 inline-block size-2 bg-[#d6b57b]" aria-hidden />Claude</span>
        <span>last 30 days</span>
      </div>
      <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={summary}>
        {days.map((day) => {
          const gemini = (day.gemini / maxDay) * 100;
          const other = (day.other / maxDay) * 100;
          const label = day.total
            ? `${day.day} — ${human(day.total)} tokens, ${day.calls} call${day.calls === 1 ? "" : "s"}`
            : `${day.day} — nothing recorded`;
          return (
            <div key={day.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={label}>
              <div className="flex h-full flex-col justify-end">
                <div className="bg-[#d6b57b]" style={{ height: `${other.toFixed(2)}%` }} />
                <div className="bg-[#f18b6e]" style={{ height: `${gemini.toFixed(2)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <ul className="sr-only">
        {days.map((day) => (
          <li key={day.day}>{day.day}: Gemini {human(day.gemini)}, Claude {human(day.other)}, {day.calls} calls</li>
        ))}
      </ul>
    </div>
  );
}

function ProviderFallback({ providers }: { providers: ProviderView[] | null }) {
  const rows = providers ?? [];
  return (
    <section className="mt-8" aria-label="Studio providers">
      <h2 className="font-serif text-2xl">Providers</h2>
      <div className="overflow-x-auto rounded-xl border border-[#2b2c30]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">Studio provider connections</caption>
          <thead className="bg-[#191a1d] text-xs tracking-[0.14em] text-[#a2a19f] uppercase">
            <tr>
              <th className="px-3 py-2 font-medium" scope="col">Provider</th>
              <th className="px-3 py-2 font-medium" scope="col">Account / Plan</th>
              <th className="px-3 py-2 font-medium" scope="col">Models</th>
              <th className="px-3 py-2 font-medium" scope="col">Latency</th>
              <th className="px-3 py-2 font-medium" scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-[#a2a19f]" colSpan={5}>Nothing connected yet. Add a provider in Studio.</td>
              </tr>
            ) : (
              rows.map((provider) => (
                <tr key={provider.id} className="border-t border-[#2b2c30]">
                  <th className="px-3 py-2 font-normal" scope="row">{provider.label}</th>
                  <td className="px-3 py-2 text-[#a2a19f]">{provider.auth.accountEmail || provider.auth.accountName || "—"}{provider.auth.accountPlan ? <span className="ml-2 inline-flex rounded-full border border-[#3c3e44] px-2 py-0.5 text-xs text-[#aed1a8]">{provider.auth.accountPlan}</span> : null}</td>
                  <td className="px-3 py-2 font-mono text-xs">{provider.models?.length ?? 0}</td>
                  <td className="px-3 py-2 font-mono text-xs">{provider.lastTest ? `${provider.lastTest.latencyMs} ms` : "—"}</td>
                  <td className="px-3 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${!provider.enabled ? "border-[#3c3e44] text-[#a2a19f]" : provider.lastTest && !provider.lastTest.ok ? "border-[#69453e] text-[#f0a096]" : provider.lastTest?.ok || provider.auth.hasSecret || provider.auth.mode === "none" ? "border-[#3d523b] text-[#aed1a8]" : "border-[#605139] text-[#d6b57b]"}`}>{!provider.enabled ? "Off" : provider.lastTest ? (provider.lastTest.ok ? "Connected" : "Error") : provider.auth.hasSecret || provider.auth.mode === "none" ? "Connected" : "Not connected"}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
