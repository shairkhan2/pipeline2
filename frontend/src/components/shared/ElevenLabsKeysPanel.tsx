import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { api, isApiError, type ElevenLabsKeySummary } from '@/lib/api';
import { errorLine } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const POLL_MS = 30000;

function fmtDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(value: number): string {
  return value.toLocaleString();
}

function addError(err: unknown): string {
  if (isApiError(err)) {
    if (err.status === 409) return 'This key is already in the pool.';
    if (err.status === 400) return err.message && err.message !== 'Bad Request' ? err.message : 'ElevenLabs rejected this key. Check it and try again.';
    if (err.status === 502 || err.status === 0) return 'Could not reach ElevenLabs to validate the key. Try again.';
  }
  return errorLine(err);
}

/** Blocked entries are voice ids or "model:<id>". */
function blockedLabel(entry: string) {
  if (entry.startsWith('model:')) return <>model <span className="font-mono">{entry.slice(6)}</span></>;
  return <>voice <span className="font-mono break-all">{entry}</span></>;
}

function StatusBadge({ item }: { item: ElevenLabsKeySummary }) {
  const tone: Record<ElevenLabsKeySummary['status'], string> = {
    ok: 'bg-success-soft text-success',
    exhausted: 'bg-warning-soft text-warning',
    cooldown: 'bg-info-soft text-info',
    invalid: 'bg-destructive-soft text-destructive',
    disabled: 'bg-muted text-muted-foreground',
  };
  const until = fmtDate(item.statusUntil);
  const text = item.status === 'exhausted' && until ? `exhausted until ${until}` : item.status === 'cooldown' && until ? `cooldown until ${until}` : item.status;
  return <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap', tone[item.status])}>{text}</span>;
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  const labelId = useId();
  return <div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
    <span id={labelId}>{label}</span>
    <button type="button" role="switch" aria-labelledby={labelId} aria-checked={checked} disabled={disabled}
      className="flex min-h-11 min-w-11 items-center justify-center disabled:opacity-50"
      onClick={() => onChange(!checked)}>
      <span className={cn('flex h-6 w-10 items-center rounded-full p-0.5 transition-colors', checked ? 'bg-primary' : 'bg-border-strong')}>
        <span className={cn('size-5 rounded-full bg-primary-foreground transition-transform motion-reduce:transition-none', checked && 'translate-x-4')} />
      </span>
    </button>
  </div>;
}

function KeyRow({ item, index, total, privileged, busy, onMove, onPatch, onRefresh, onRemove }: {
  item: ElevenLabsKeySummary; index: number; total: number; privileged: boolean; busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onPatch: (patch: { enabled?: boolean; allowOverage?: boolean }) => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = item.label || `Key ${item.hint}`;
  const limit = item.characterLimit;
  const used = item.characterCount;
  const pct = limit && limit > 0 && used != null ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const reset = fmtDate(item.resetAt ? item.resetAt * 1000 : undefined);
  const lock = !privileged || busy;
  const blocked = item.blockedVoices ?? [];
  return <li className="rounded-xl bg-muted p-3" aria-label={`${index + 1}. ${name}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="grid size-7 place-items-center rounded-full bg-card font-mono text-xs tabular-nums" aria-hidden>{index + 1}</span>
      <strong className="text-sm">{name}</strong>
      <span className="font-mono text-xs text-muted-foreground">{item.hint}</span>
      {item.tier ? <span className="inline-flex h-6 items-center rounded-full bg-card px-2.5 text-[12.5px] text-muted-foreground">{item.tier}</span> : null}
      <StatusBadge item={item} />
    </div>
    <div className="mt-2 flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full border border-border bg-card" role="progressbar" aria-label={`${name} usage`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cn('h-full rounded-full', pct != null && pct >= 100 ? 'bg-destructive' : pct != null && pct >= 85 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {used != null && limit != null ? `${fmtNum(used)} / ${fmtNum(limit)} characters` : 'usage unknown'}
      </span>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">
      {reset ? `Resets ${reset}` : 'Reset date unknown'}
      {item.statusReason ? <> · {item.statusReason}</> : null}
    </p>
    {blocked.length ? <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{blocked.length} blocked voice{blocked.length === 1 ? '' : 's'}/model{blocked.length === 1 ? '' : 's'}</summary>
      <ul className="mt-1 list-disc pl-5">{blocked.map(v => <li key={v}>{blockedLabel(v)}</li>)}</ul>
    </details> : null}
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="button" variant="outline" size="icon" className="size-11 md:size-9" aria-label={`Move ${name} up`} disabled={lock || index === 0} onClick={() => onMove(-1)}><ArrowUp className="size-4" aria-hidden /></Button>
      <Button type="button" variant="outline" size="icon" className="size-11 md:size-9" aria-label={`Move ${name} down`} disabled={lock || index === total - 1} onClick={() => onMove(1)}><ArrowDown className="size-4" aria-hidden /></Button>
      <Toggle label="Enabled" checked={item.enabled} disabled={lock} onChange={enabled => onPatch({ enabled })} />
      {item.tier && item.tier !== 'free' && item.canExtend
        ? <Toggle label="Allow overage" checked={item.allowOverage} disabled={lock} onChange={allowOverage => onPatch({ allowOverage })} />
        : null}
      <Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={lock} onClick={onRefresh}><RefreshCw className="size-4" aria-hidden /> Refresh</Button>
      {confirming
        ? <span className="flex items-center gap-2" role="group" aria-label={`Confirm removing ${name}`}>
            <span className="text-xs">Remove this key?</span>
            <Button type="button" variant="destructive" className="min-h-11 md:min-h-9" disabled={lock} onClick={() => { setConfirming(false); onRemove(); }}>Remove</Button>
            <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => setConfirming(false)}>Cancel</Button>
          </span>
        : <Button type="button" variant="ghost" className="min-h-11 text-destructive md:min-h-9" disabled={lock} onClick={() => setConfirming(true)}>Remove</Button>}
    </div>
  </li>;
}

export function ElevenLabsKeysPanel({ privileged, onPoolChange }: { privileged: boolean; onPoolChange?: () => void }) {
  const [keys, setKeys] = useState<ElevenLabsKeySummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState('');
  const [addOk, setAddOk] = useState('');
  const rootRef = useRef<HTMLElement | null>(null);
  const formIds = { label: useId(), key: useId(), err: useId() };

  const seqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const reorderingRef = useRef(false);
  const mountedRef = useRef(true);

  /** Drop any in-flight load so its (older) response is never applied. */
  const cancelLoad = useCallback(() => {
    seqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
  }, []);

  const load = useCallback(async () => {
    if (reorderingRef.current || !mountedRef.current) return;
    cancelLoad();
    const seq = seqRef.current;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    try {
      const res = await api.studio.elevenlabs.keys(controller.signal);
      if (seq !== seqRef.current || controller.signal.aborted) return;
      setKeys(Array.isArray(res?.keys) ? res.keys : []);
      setLoadError('');
    } catch (err) {
      if (seq !== seqRef.current || controller.signal.aborted) return;
      setLoadError(errorLine(err));
    } finally {
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [cancelLoad]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const visible = () => !document.hidden && Boolean(rootRef.current && !rootRef.current.closest('[hidden]'));
    const id = window.setInterval(() => { if (visible()) void load(); }, POLL_MS);
    const onVis = () => { if (visible()) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      cancelLoad();
    };
  }, [load, cancelLoad]);

  async function mutate(id: string, run: () => Promise<unknown>) {
    setBusyId(id); setActionError('');
    try { await run(); if (mountedRef.current) onPoolChange?.(); }
    catch (err) { if (mountedRef.current) setActionError(errorLine(err)); }
    finally { if (mountedRef.current) { setBusyId(''); await load(); } }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const key = secret.trim();
    if (!key || adding) { if (!key) setAddErr('Paste an ElevenLabs API key.'); return; }
    setAdding(true); setAddErr(''); setAddOk('');
    try {
      const res = await api.studio.elevenlabs.addKey({ key, ...(label.trim() ? { label: label.trim() } : {}) });
      setSecret(''); setLabel('');
      setAddOk(`Added key ${res?.key?.hint ?? ''}`.trim());
      onPoolChange?.();
    } catch (err) {
      setAddErr(addError(err));
    } finally {
      if (mountedRef.current) { setAdding(false); await load(); }
    }
  }

  async function move(index: number, dir: -1 | 1) {
    if (!keys || reorderingRef.current || busyId) return;
    const snapshot = keys;
    const next = [...keys];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorderingRef.current = true;
    cancelLoad();
    setKeys(next);
    setBusyId(next[target]!.id); setActionError('');
    try {
      const res = await api.studio.elevenlabs.reorder(next.map(k => k.id));
      if (!mountedRef.current) return;
      if (Array.isArray(res?.keys)) setKeys(res.keys);
      setLoadError('');
      onPoolChange?.();
    } catch (err) {
      if (!mountedRef.current) return;
      setKeys(snapshot);
      setActionError(errorLine(err));
    } finally {
      reorderingRef.current = false;
      if (mountedRef.current) setBusyId('');
    }
  }

  return <section ref={rootRef} className="desk-card mt-4" aria-labelledby="elevenlabsKeysHeading">
    <h3 id="elevenlabsKeysHeading" className="text-base font-semibold">ElevenLabs keys</h3>
    <p className="mt-1 text-sm text-muted-foreground">Runs use these keys in order. When a key runs out, the run moves to the next key.</p>

    <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-3" autoComplete="off">
      <label className="min-w-[140px] flex-1 text-sm" htmlFor={formIds.label}>
        Label (optional)
        <input id={formIds.label} className="field mt-1 min-h-11" value={label} maxLength={80} disabled={!privileged || adding} onChange={e => setLabel(e.target.value)} />
      </label>
      <label className="min-w-[220px] flex-[2] text-sm" htmlFor={formIds.key}>
        API key
        <input id={formIds.key} type="password" autoComplete="off" spellCheck={false} className="field mt-1 min-h-11 font-mono" value={secret}
          aria-invalid={addErr ? true : undefined} aria-describedby={formIds.err} disabled={!privileged || adding}
          onChange={e => { setSecret(e.target.value); setAddErr(''); }} />
      </label>
      <Button type="submit" className="min-h-11" disabled={!privileged || adding || !secret.trim()}>{adding ? 'Checking key…' : 'Add key'}</Button>
    </form>
    <div id={formIds.err} aria-live="polite" className="mt-2 text-xs">
      {addErr ? <p className="text-destructive">{addErr}</p> : addOk ? <p className="text-success">{addOk}</p> : null}
    </div>
    {!privileged ? <p className="mt-1 text-xs text-muted-foreground">Temporary accounts cannot change keys.</p> : null}

    {loadError
      ? keys === null
        ? <p className="mt-3 text-xs text-destructive" role="alert">{loadError}</p>
        : <p className="mt-3 text-xs text-muted-foreground" role="status">Could not refresh keys: {loadError}</p>
      : null}
    {actionError ? <p className="mt-3 text-xs text-destructive" role="alert">{actionError}</p> : null}
    {keys === null && !loadError ? <p className="mt-3 text-xs text-muted-foreground" role="status">Loading keys…</p> : null}
    {keys && keys.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">No keys yet. ElevenLabs narration needs at least one enabled key.</p> : null}
    {keys && keys.length ? <ol className="mt-3 flex flex-col gap-2" aria-label="ElevenLabs keys in priority order">
      {keys.map((item, index) => <KeyRow key={item.id} item={item} index={index} total={keys.length} privileged={privileged} busy={busyId !== ''}
        onMove={dir => void move(index, dir)}
        onPatch={patch => void mutate(item.id, () => api.studio.elevenlabs.updateKey(item.id, patch))}
        onRefresh={() => void mutate(item.id, () => api.studio.elevenlabs.refreshKey(item.id))}
        onRemove={() => void mutate(item.id, () => api.studio.elevenlabs.removeKey(item.id))} />)}
    </ol> : null}
  </section>;
}
