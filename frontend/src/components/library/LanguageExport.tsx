import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Download, Film, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Notice, RawDetails } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import {
  compressChapterNumbers, isLanguageExportBusy, languageChapterNumber, languageExportControls,
  languageExportErrorLabel, languageVoiceGroups, LANGUAGE_SPEED_MIN, LANGUAGE_SPEED_MAX,
  type LanguageExportState, type LanguageOutroInput, type SeriesLanguagesState,
} from "@/lib/languages";

const linkClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-muted px-4 text-sm hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const selectClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 text-sm";
const chaptersLabel = (chapters: string[]) => compressChapterNumbers(chapters.map(languageChapterNumber));

interface Props {
  slug: string;
  locale: string;
  privileged: boolean;
  snapshot: SeriesLanguagesState | null;
  onToast: (message: string) => void;
  onBusy: (busy: boolean) => void;
  onPlay: (src: string, label: string) => void;
}

/** Async Hindi exports share one guarded read and stop polling in hidden tabs. */
export function LanguageExport({ slug, locale, privileged, snapshot, onToast, onBusy, onPlay }: Props) {
  const [state, setState] = useState<LanguageExportState | null>(null);
  const [includeOutro, setIncludeOutro] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string; action: "merge" | "outro" | "load"; code?: string } | null>(null);
  const [outroOpen, setOutroOpen] = useState(false);
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState("1");
  const [hook, setHook] = useState<NonNullable<LanguageOutroInput["hookType"]> | "">("");
  const [total, setTotal] = useState("50");
  const [covered, setCovered] = useState("1");
  const [note, setNote] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const live = useRef(true);
  const read = useRef<AbortController | null>(null);
  const posting = useRef(false);
  const selectedOutro = useRef(true);
  const latest = useRef(state);
  const polling = isLanguageExportBusy(state);
  const callbacks = useRef({ onToast, onBusy });
  callbacks.current = { onToast, onBusy };
  const seen = useRef(new Set<string>());
  const accept = useCallback((next: LanguageExportState) => {
    if (!live.current) return;
    latest.current = next;
    setState(next);
    for (const [kind, outcome] of [["merge", next.lastMerge], ["outro", next.lastOutro]] as const) {
      if (!outcome?.finishedAt || outcome.status !== "done") continue;
      const key = `${kind}|${outcome.finishedAt}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      callbacks.current.onToast(outcome.message);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!live.current || read.current || posting.current || document.hidden) return;
    const controller = new AbortController();
    read.current = controller;
    try {
      const next = await api.series.languageExport(slug, locale, controller.signal, selectedOutro.current);
      if (!controller.signal.aborted) {
        accept(next);
        setError(current => current?.action === "load" ? null : current);
      }
    } catch (cause) {
      if (live.current && !controller.signal.aborted) setError(current => current ?? {
        title: "Couldn’t load export", detail: String(cause), action: "load",
      });
    } finally {
      if (read.current === controller) read.current = null;
    }
  }, [slug, locale, accept]);

  useEffect(() => {
    live.current = true;
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      live.current = false;
      read.current?.abort();
      read.current = null;
      callbacks.current.onBusy(false);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (!cancelled && isLanguageExportBusy(latest.current)) timer = globalThis.setTimeout(tick, 3000);
    };
    if (polling) timer = globalThis.setTimeout(tick, 3000);
    else void tick();
    return () => { cancelled = true; globalThis.clearTimeout(timer); };
  }, [refresh, polling]);
  // Reuse the chapter panel's successful polls as well as the export lock poll.
  useEffect(() => { if (!isLanguageExportBusy(latest.current)) void refresh(); }, [snapshot, includeOutro, refresh]);
  const controls = state ? languageExportControls(state, pending) : null;
  useEffect(() => { callbacks.current.onBusy(Boolean(controls?.busy)); }, [controls?.busy]);

  async function run(action: "merge" | "outro", input: LanguageOutroInput = {}) {
    if (!privileged || posting.current || !state || controls?.busy) return;
    read.current?.abort();
    read.current = null;
    posting.current = true;
    setPending(true);
    setError(null);
    try {
      const next = action === "merge"
        ? await api.series.mergeLanguage(slug, locale, { includeOutro: includeOutro && state.outro.exists })
        : await api.series.generateLanguageOutro(slug, locale, input);
      if (!live.current) return;
      accept(next);
      if (action === "outro") setOutroOpen(false);
    } catch (cause) {
      if (!live.current) return;
      const code = cause instanceof ApiError ? cause.code : undefined;
      const payload = cause instanceof ApiError ? cause.payload as { detail?: string } | null : null;
      setError({ title: languageExportErrorLabel(code), detail: [String(cause), payload?.detail].filter(Boolean).join("\n"), action, code });
      if (code === "outro_missing") openOutro();
    } finally {
      posting.current = false;
      if (live.current) { setPending(false); void refresh(); }
    }
  }

  function openOutro() {
    if (!state || outroOpen) return;
    setVoice(state.outro.defaultVoice ?? "");
    setSpeed(String(state.outro.defaultSpeed ?? 1));
    setHook(state.outro.hasEnglishPlan ? "" : "part2");
    setCovered(String(Math.max(1, state.chapters.finished.length)));
    setTotal(String(Math.max(50, snapshot?.sourceChapters.length ?? 0, state.chapters.finished.length)));
    setOutroOpen(true);
  }
  function submitOutro(event: FormEvent) {
    event.preventDefault();
    const input: LanguageOutroInput = { ...(voice ? { voice } : {}), speed: Number(speed) };
    if (hook) Object.assign(input, { hookType: hook, totalChapters: Number(total), coveredChapters: Number(covered),
      ...(hook === "custom" ? { customNote: note } : {}), ...(hook === "new_series" ? { nextSeriesTitle: nextTitle } : {}) });
    void run("outro", input);
  }

  const voices = snapshot?.catalog.find(entry => entry.locale === locale)?.voices ?? [];
  const voiceBlocked = Boolean(voice && !voices.some(item => item.id === voice && item.available !== false));
  const fieldError = error?.action === "outro"
    ? /voice|provider/.test(error.code ?? "") ? "voice" : error.code === "invalid_speed" ? "speed" : /field/.test(error.code ?? "") ? "hook" : null
    : null;
  const errorRow = error ? <Notice tone="danger" title={error.title}
    actions={<Button variant="ghost" className="min-h-11" disabled={controls?.busy} onClick={() => {
      if (error.action === "load") { setError(null); void refresh(); }
      else if (error.action === "outro" || error.code === "outro_missing") openOutro();
      else void run("merge");
    }}>{error.code === "outro_missing" ? "Generate outro" : "Retry"}</Button>}
    details={<RawDetails text={error.detail} />} /> : null;
  const formErrorRow = error?.action === "outro" ? <Notice tone="danger" title={error.title}
    details={<RawDetails text={error.detail} />} /> : null;

  if (!state?.chapters.finished.length) return error ? <div className="mt-4">{errorRow}</div> : null;
  return <section className="mt-5 space-y-3 border-t border-border pt-4" aria-label="Hindi export" aria-busy={controls?.busy}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm font-medium"><Film className="size-[18px]" strokeWidth={1.75} aria-hidden />Full video</span>
      {privileged ? <Button className="min-h-11" disabled={controls?.mergeDisabled} onClick={() => void run("merge")}>
        {state.busy.merge || pending ? <LoaderCircle className="size-[18px] motion-safe:animate-spin" aria-hidden /> : <Film className="size-[18px]" strokeWidth={1.75} aria-hidden />}{controls?.mergeLabel}
      </Button> : null}
    </div>
    <div aria-live="polite" className="space-y-2 text-sm text-muted-foreground">
      {controls?.status ? <p role="status" className="flex items-center gap-2">{isLanguageExportBusy(state) ? <LoaderCircle className="size-[18px] shrink-0 motion-safe:animate-spin" aria-hidden /> : null}{controls.status}</p> : null}
      {state.busy.outro ? <p className="text-xs">About 3 minutes</p> : null}
      {!controls?.busy && !state.canMerge && state.reason ? <p>{state.reason}</p> : null}
      {state.merged.stale ? <p>{state.merged.staleReason || "New chapters are ready. Merge again."}</p> : null}
      {state.chapters.missing.length ? <details><summary className="flex min-h-11 cursor-pointer items-center">Missing: {chaptersLabel(state.chapters.missing.map(item => item.chapter))}</summary>
        <ul>{state.chapters.missing.map(item => <li key={item.chapter}>Chapter {languageChapterNumber(item.chapter)}: {item.reason}</li>)}</ul></details> : null}
      {state.chapters.stale.length ? <Notice tone="warning" title={state.chapters.stale.length === 1 ? "1 chapter on older settings" : `${state.chapters.stale.length} chapters on older settings`} details={<RawDetails text="Merge uses these chapters as is. Generate the chapters again to update them." />} /> : null}
    </div>
    {state.merged.exists ? <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Chapters {chaptersLabel(state.merged.chapters)}</span><span>{(state.merged.sizeBytes / 1e9).toFixed(2)} GB</span>
        {state.merged.includesOutro ? <span className="rounded-full bg-muted px-2 py-1">With outro</span> : null}
      </div>
      {state.merged.url ? <video aria-label="Merged Hindi video" src={state.merged.url} controls playsInline preload="none" className="aspect-video w-full max-w-3xl rounded-lg bg-background" /> : null}
      {state.merged.downloadUrl ? <a className={linkClass} href={state.merged.downloadUrl} download={state.merged.filename || true}><Download className="size-[18px]" strokeWidth={1.75} aria-hidden />Download</a> : null}
    </div> : null}
    <div className="sr-row flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-sm">{state.outro.exists ? "Outro ready" : "Add Hindi outro"}</span>
      <div className="flex flex-wrap items-center gap-1">
        {state.outro.videoUrl ? <Tooltip label="Play Hindi outro"><Button variant="ghost" className="size-11 p-0" aria-label="Play Hindi outro" onClick={() => onPlay(state.outro.videoUrl!, "Hindi outro")}><Play className="size-[18px]" strokeWidth={1.75} aria-hidden /></Button></Tooltip> : null}
        {state.outro.downloadUrl ? <Tooltip label="Download Hindi outro"><a className={`${linkClass} w-11 px-0`} aria-label="Download Hindi outro" href={state.outro.downloadUrl} download={state.outro.filename}><Download className="size-[18px]" strokeWidth={1.75} aria-hidden /></a></Tooltip> : null}
        {privileged ? <Button variant="outline" className="min-h-11" disabled={controls?.outroDisabled} onClick={openOutro}>{state.outro.exists ? <><RotateCcw className="size-[18px]" strokeWidth={1.75} aria-hidden />Generate again</> : "Generate Hindi outro"}</Button> : null}
      </div>
    </div>
    {state.outro.exists ? <>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm">Include outro<input type="checkbox" className="size-5 accent-primary" checked={includeOutro} disabled={controls?.busy || !privileged} onChange={event => { selectedOutro.current = event.target.checked; setIncludeOutro(event.target.checked); }} /></label>
      <p className="text-xs text-muted-foreground">{voices.find(item => item.id === state.outro.voice)?.label || "Hindi voice"}{state.outro.speed ? ` · ${state.outro.speed}×` : ""}</p>
    </> : null}
    {state.outro.stale ? <p className="text-sm text-warning">English outro changed. Generate again.</p> : null}
    {!controls?.busy && !state.canGenerateOutro && state.outroReason ? <p className="text-sm text-muted-foreground">{state.outroReason}</p> : null}
    {([ ["merge", state.lastMerge], ["outro", state.lastOutro] ] as const).map(([kind, outcome]) =>
      outcome && (outcome.status === "failed" || outcome.status === "interrupted") ? <Notice key={`${kind}|${outcome.finishedAt}`} tone="danger"
        title={outcome.status === "interrupted" ? "Export interrupted" : kind === "merge" ? "Merge failed" : "Hindi outro failed"}
        actions={privileged ? <Button className="min-h-11" variant="ghost" disabled={controls?.busy} onClick={() => kind === "merge" ? void run("merge") : openOutro()}>Retry</Button> : undefined}
        details={<RawDetails text={[outcome.message, outcome.detail].filter(Boolean).join("\n")} />} /> : null)}
    {errorRow}
    <Dialog open={outroOpen} onOpenChange={open => { if (!pending) setOutroOpen(open); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto [&_[data-slot=dialog-close]]:size-11 sm:max-w-lg">
        <DialogHeader><DialogTitle>Hindi outro</DialogTitle></DialogHeader>
        <form onSubmit={submitOutro} className="space-y-4" aria-busy={pending}>
          <label className="block text-sm">Hindi voice<select className={selectClass} value={voice} disabled={controls?.busy} onChange={event => setVoice(event.target.value)}>
            <option value="">Chapter voice</option>
            {voice && !voices.some(item => item.id === voice) ? <option value={voice} disabled>Voice unavailable</option> : null}
            {languageVoiceGroups(voices).map(group => <optgroup key={`${group.provider}|${group.id}`} label={group.label}>{group.voices.map(item => <option key={item.id} value={item.id} disabled={item.available === false}>{item.label}</option>)}</optgroup>)}
          </select></label>
          {fieldError === "voice" ? formErrorRow : null}
          <label className="block text-sm">Speed<Input className="mt-1 h-11" type="number" min={LANGUAGE_SPEED_MIN} max={LANGUAGE_SPEED_MAX} step="0.05" required value={speed} disabled={controls?.busy} onChange={event => setSpeed(event.target.value)} /></label>
          {fieldError === "speed" ? formErrorRow : null}
          <label className="block text-sm">Hook type<select className={selectClass} value={hook} disabled={controls?.busy} onChange={event => setHook(event.target.value as typeof hook)}>
            {state.outro.hasEnglishPlan ? <option value="">Use English outro</option> : null}
            <option value="part2">Invite viewers to part 2</option><option value="next_chapter">Tease the next chapter</option><option value="new_series">Recommend a new series</option><option value="custom">Custom instruction</option>
          </select></label>
          {!hook ? <p className="text-xs text-muted-foreground">English panels, Hindi narration</p> : <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Total chapters<Input className="mt-1 h-11" type="number" min={covered || 1} required value={total} disabled={controls?.busy} onChange={event => setTotal(event.target.value)} /></label>
            <label className="block text-sm">Covered chapters<Input className="mt-1 h-11" type="number" min="1" max={total} required value={covered} disabled={controls?.busy} onChange={event => setCovered(event.target.value)} /></label>
          </div>}
          {hook === "custom" ? <label className="block text-sm">Custom instruction<Input className="mt-1 h-11" required maxLength={2000} value={note} disabled={controls?.busy} onChange={event => setNote(event.target.value)} /></label> : null}
          {hook === "new_series" ? <label className="block text-sm">Next series<Input className="mt-1 h-11" required maxLength={300} value={nextTitle} disabled={controls?.busy} onChange={event => setNextTitle(event.target.value)} /></label> : null}
          {fieldError === "hook" || !fieldError ? formErrorRow : null}
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={pending} onClick={() => setOutroOpen(false)}>Cancel</Button><Button type="submit" className="min-h-11" disabled={controls?.outroDisabled || voiceBlocked}>{pending ? "Starting…" : "Generate Hindi outro"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
