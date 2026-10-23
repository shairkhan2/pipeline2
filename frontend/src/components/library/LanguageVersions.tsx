import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronDown, CircleAlert, Download, Info, Languages, Play, RefreshCw, RotateCcw, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ErrorNotice, Notice, RawDetails } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
import { describeError, type ErrorInfo } from "@/lib/errors";
import {
  api,
  defaultLanguageChapters,
  firstAvailableLanguageVoice,
  isLanguageVersionActive,
  LANGUAGE_SPEED_MAX,
  mergeNewerSnapshot,
  LANGUAGE_SPEED_MIN,
  languageChapterNumber,
  hasLanguageVideo,
  languageMediaUrl,
  languageProviderLabel,
  languageRetryGroups,
  languageVoiceGroups,
  languageVoiceUnavailableReason,
  type LanguageChapterVersion,
  type LanguageRetryGroup,
  type LanguageSourceChapter,
  type LanguageVersion,
  type SeriesLanguagesState,
} from "@/lib/api";
import { compressChapterNumbers, languageChapterNotes, languageChapterNotice, languageChapterStage, resolveLanguageChapters } from "@/lib/languages";
import { retryCountdown, useRetryClock } from "@/lib/retry";
import { cn } from "@/lib/utils";
import { LanguageExport } from "./LanguageExport";

/** Only locales with a shipped narration pipeline are offered. */
const SUPPORTED_LOCALES = ["hi-IN"] as const;

const POLL_MS = 4000;

function RetryIndicator({ retry }: { retry: NonNullable<LanguageVersion["autoRetry"]> }) {
  const at = Date.parse(retry.at) / 1000;
  const now = useRetryClock(Number.isFinite(at) ? at : 0);
  if (!Number.isFinite(at)) return null;
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs text-warning">
    <RotateCcw className="size-3.5" aria-hidden />
    Retry {retry.count} of {retry.max} · {at > now
      ? <span role="timer">in {retryCountdown(at, now)}</span>
      : "starting"}
  </span>;
}

const STATUS_COPY: Record<string, string> = {
  queued: "Queued",
  running: "Generating",
  completed: "Ready",
  failed: "Failed",
  interrupted: "Interrupted",
};

function localeLabel(state: SeriesLanguagesState | null, locale: string): string {
  const hit = state?.catalog.find((entry) => entry.locale === locale);
  return hit?.label || locale;
}

function supportedCatalog(state: SeriesLanguagesState | null) {
  return (state?.catalog ?? []).filter((entry) =>
    (SUPPORTED_LOCALES as readonly string[]).includes(entry.locale),
  );
}

function chapterLabel(chapter: string): string {
  const digits = chapter.match(/(\d+)/);
  return digits ? `Chapter ${Number(digits[1])}` : chapter;
}

function statusTone(status: string): string {
  if (status === "completed") return "bg-success-soft text-success";
  if (status === "failed") return "bg-destructive-soft text-destructive";
  if (status === "interrupted") return "bg-warning-soft text-warning";
  return "bg-muted text-muted-foreground";
}

function chapterTone(chapter: LanguageChapterVersion): string {
  if (chapter.error || chapter.status === "failed" || chapter.status === "interrupted") return statusTone(chapter.status === "interrupted" ? "interrupted" : "failed");
  if (chapter.stale) return "bg-warning-soft text-warning";
  return statusTone(chapter.status);
}

function errorText(error: unknown, fallback: string): ErrorInfo {
  return describeError(error, fallback);
}

function requestInfo(error: string | ErrorInfo): ErrorInfo {
  return typeof error === "string" ? describeError(error) : error;
}

function retryGroupKey(group: LanguageRetryGroup): string {
  return `${group.locale}|${group.voice}|${group.speed}|${group.chapters}`;
}

interface Props {
  slug: string;
  title: string;
  privileged: boolean;
  onToast: (message: string) => void;
}

/**
 * Hindi language versions for one series. English renders stay the source of
 * truth: this panel only reuses their script and panel selection, then creates
 * separate Hindi audio, timing, and video.
 */
export function LanguageVersions({ slug, title, privileged, onToast }: Props) {
  const [state, setState] = useState<SeriesLanguagesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | ErrorInfo>("");
  const [locale, setLocale] = useState<string>(SUPPORTED_LOCALES[0]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [chapters, setChapters] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState("1");
  const [formError, setFormError] = useState<string | ErrorInfo>("");
  const [submitting, setSubmitting] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [retryErrors, setRetryErrors] = useState<Record<string, string | ErrorInfo>>({});

  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState<string | ErrorInfo>("");
  const [previewing, setPreviewing] = useState(false);
  const [openVideo, setOpenVideo] = useState<{ src: string; label: string } | null>(null);

  const mounted = useRef(true);
  const slugRef = useRef(slug);
  const loadSeq = useRef(0);
  const submitSeq = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const previewKey = useRef("");
  const pollTimer = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSeq.current += 1;
      loadAbort.current?.abort();
      loadAbort.current = null;
      previewAbort.current?.abort();
      previewAbort.current = null;
    };
  }, []);

  /** Drop in-flight reads so their late answers cannot paint over newer state. */
  const invalidateReads = useCallback(() => {
    loadSeq.current += 1;
    loadAbort.current?.abort();
    loadAbort.current = null;
  }, []);

  const load = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const requested = slug;
      const seq = ++loadSeq.current;
      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      if (!options.quiet) setLoading(true);
      try {
        const next = await api.series.languages(requested, controller.signal);
        if (!mounted.current || slugRef.current !== requested || seq !== loadSeq.current) return;
        setState((current) => (options.quiet ? mergeNewerSnapshot(current, next) : next));
        setLoadError("");
      } catch (error) {
        if (!mounted.current || slugRef.current !== requested || seq !== loadSeq.current) return;
        if (controller.signal.aborted) return;
        setLoadError(errorText(error, "Couldn’t load language versions."));
      } finally {
        if (loadAbort.current === controller) loadAbort.current = null;
        if (mounted.current && slugRef.current === requested && seq === loadSeq.current) setLoading(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    slugRef.current = slug;
    invalidateReads();
    previewAbort.current?.abort();
    previewAbort.current = null;
    previewKey.current = "";
    window.clearTimeout(pollTimer.current);
    setState(null);
    setLoading(true);
    setLoadError("");
    setDialogOpen(false);
    setOpenVideo(null);
    setChapters("");
    setVoice("");
    setSpeed("1");
    setFormError("");
    setSubmitting(false);
    setRetryErrors({});
    setPreviewUrl("");
    setPreviewError("");
    setPreviewing(false);
    setLocale(SUPPORTED_LOCALES[0]);
    void load();
  }, [slug, load, invalidateReads]);

  useEffect(() => () => window.clearTimeout(pollTimer.current), []);

  /** A voice, speed, or language change makes any previewed sample obsolete. */
  useEffect(() => {
    previewAbort.current?.abort();
    previewAbort.current = null;
    previewKey.current = "";
    setPreviewing(false);
    setPreviewUrl("");
    setPreviewError("");
  }, [locale, voice, speed]);

  const catalog = useMemo(() => supportedCatalog(state), [state]);
  const activeVersion = useMemo<LanguageVersion | null>(
    () => state?.versions.find((version) => version.locale === locale) ?? null,
    [state, locale],
  );
  const active = Boolean(activeVersion && isLanguageVersionActive(activeVersion));
  const selectedCatalog = catalog.find((entry) => entry.locale === locale) ?? null;
  const autoRetry = !active && (activeVersion?.status === "failed" || activeVersion?.status === "interrupted")
    ? activeVersion.autoRetry : undefined;
  const autoRetryAt = autoRetry ? Date.parse(autoRetry.at) / 1000 || 0 : 0;

  /** Refresh once the server's automatic retry is due, so the new run shows up. */
  useEffect(() => {
    if (!autoRetryAt) return;
    const timer = window.setTimeout(() => void load({ quiet: true }), Math.max(0, autoRetryAt * 1000 - Date.now()) + 65_000);
    return () => window.clearTimeout(timer);
  }, [autoRetryAt, load]);

  useEffect(() => {
    if (!active && !autoRetryAt) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        pollTimer.current = window.setTimeout(tick, POLL_MS);
        return;
      }
      void load({ quiet: true }).finally(() => {
        if (!cancelled) pollTimer.current = window.setTimeout(tick, POLL_MS);
      });
    };
    pollTimer.current = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer.current);
    };
  }, [active, autoRetryAt, load, slug]);

  const eligibleChapters = useMemo<LanguageSourceChapter[]>(
    () => (state?.sourceChapters ?? []).filter((chapter) => chapter.eligible),
    [state],
  );
  const ineligibleChapters = useMemo<LanguageSourceChapter[]>(
    () => (state?.sourceChapters ?? []).filter((chapter) => !chapter.eligible),
    [state],
  );
  const chapterSelection = useMemo(
    () => resolveLanguageChapters(chapters, state?.sourceChapters ?? []),
    [chapters, state?.sourceChapters],
  );
  const selectedNumbers = new Set(chapterSelection.numbers);
  const allChapters = resolveLanguageChapters("all", state?.sourceChapters ?? []);

  function openDialog() {
    if (!privileged) return;
    const nextLocale = catalog[0]?.locale ?? SUPPORTED_LOCALES[0];
    const voices = state?.catalog.find((entry) => entry.locale === nextLocale)?.voices ?? [];
    setLocale(nextLocale);
    setChapters(defaultLanguageChapters(state?.sourceChapters ?? []));
    setVoice(firstAvailableLanguageVoice(voices));
    setSpeed("1");
    setFormError("");
    setPreviewUrl("");
    setPreviewError("");
    setDialogOpen(true);
  }

  function onLocaleChange(nextLocale: string) {
    setLocale(nextLocale);
    setFormError("");
    setPreviewUrl("");
    setPreviewError("");
    const voices = state?.catalog.find((entry) => entry.locale === nextLocale)?.voices ?? [];
    setVoice(firstAvailableLanguageVoice(voices));
  }

  async function onPreview() {
    if (!privileged || previewing) return;
    const nextSpeed = Number(speed);
    if (!Number.isFinite(nextSpeed) || nextSpeed < LANGUAGE_SPEED_MIN || nextSpeed > LANGUAGE_SPEED_MAX) {
      setPreviewError(`Speed must be between ${LANGUAGE_SPEED_MIN} and ${LANGUAGE_SPEED_MAX}.`);
      return;
    }
    if (!voice) {
      setPreviewError("Choose a Hindi voice first.");
      return;
    }
    const requested = slug;
    const requestKey = `${slug}|${locale}|${voice}|${nextSpeed}`;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    previewKey.current = requestKey;
    setPreviewing(true);
    setPreviewError("");
    setPreviewUrl("");
    try {
      const result = await api.series.previewLanguage(
        requested,
        { locale, voice, speed: nextSpeed },
        controller.signal,
      );
      if (!mounted.current || slugRef.current !== requested || previewKey.current !== requestKey) return;
      if (!result?.url) {
        setPreviewError("The preview came back empty. Try another voice.");
        return;
      }
      setPreviewUrl(result.url);
    } catch (error) {
      if (!mounted.current || slugRef.current !== requested || previewKey.current !== requestKey) return;
      if (controller.signal.aborted) return;
      setPreviewError(errorText(error, "Couldn’t generate a Hindi voice preview."));
    } finally {
      if (mounted.current && slugRef.current === requested && previewKey.current === requestKey) {
        setPreviewing(false);
      }
    }
  }

  async function submit(
    event: FormEvent,
    override?: { chapters: string; locale: string; voice: string; speed: number },
    retryKey?: string,
  ) {
    event.preventDefault();
    if (!privileged || submitting || exportBusy) return;
    const reportError = (error: string | ErrorInfo) => {
      if (retryKey) setRetryErrors(current => ({ ...current, [retryKey]: error }));
      else setFormError(error);
    };
    const targetLocale = override?.locale ?? locale;
    const targetVoice = override?.voice ?? voice;
    const spec = resolveLanguageChapters(override?.chapters ?? chapters, state?.sourceChapters ?? []);
    if (spec.error || !spec.numbers.length) {
      reportError(spec.error || "Choose at least one eligible chapter.");
      return;
    }
    // A retry list is honoured exactly: never narrow it silently.
    if (override && spec.skipped.length) {
      reportError(`Chapter ${compressChapterNumbers(spec.skipped)} can't be retried. Generate it again.`);
      return;
    }
    if (!targetVoice) {
      reportError("Choose a Hindi voice.");
      return;
    }
    const nextSpeed = override?.speed ?? Number(speed);
    if (!Number.isFinite(nextSpeed) || nextSpeed < LANGUAGE_SPEED_MIN || nextSpeed > LANGUAGE_SPEED_MAX) {
      reportError(`Speed must be between ${LANGUAGE_SPEED_MIN} and ${LANGUAGE_SPEED_MAX}.`);
      return;
    }
    const requested = slug;
    // A POST result outranks any read already in flight, so cancel those first.
    invalidateReads();
    const seq = ++submitSeq.current;
    setSubmitting(true);
    setFormError("");
    try {
      const result = await api.series.generateLanguage(requested, {
        locale: targetLocale,
        chapters: spec.value,
        voice: targetVoice,
        speed: nextSpeed,
      });
      if (!mounted.current || slugRef.current !== requested || seq !== submitSeq.current) return;
      invalidateReads();
      setState(result);
      setDialogOpen(false);
      setPreviewUrl("");
      onToast(`Hindi generation queued for ${title}.`);
    } catch (error) {
      if (!mounted.current || slugRef.current !== requested || seq !== submitSeq.current) return;
      reportError(errorText(error, "Couldn’t start Hindi generation."));
    } finally {
      if (mounted.current && slugRef.current === requested && seq === submitSeq.current) setSubmitting(false);
    }
  }

  const retryPlan = useMemo(() => {
    if (!activeVersion) return { groups: [], unknown: [] };
    const voices = state?.catalog.find((entry) => entry.locale === activeVersion.locale)?.voices ?? [];
    return languageRetryGroups(activeVersion, voices);
  }, [activeVersion, state]);

  async function retry(event: FormEvent, group: LanguageRetryGroup) {
    event.preventDefault();
    if (!privileged || submitting) return;
    const key = retryGroupKey(group);
    setRetryErrors(current => ({ ...current, [key]: "" }));
    // Resend the saved request settings verbatim: never the modal's current
    // voice or speed, which would re-bill completed chapters. The voice is the
    // identity the server resolves provider/model from, so a saved provider that
    // no longer matches the catalog is refused instead of silently rendering
    // with a different engine (never a silent Edge fallback).
    const current = voiceOptions.find((item) => item.id === group.voice);
    const drifted = group.provider && current?.provider && group.provider !== current.provider;
    if (drifted) {
      setRetryErrors(errors => ({ ...errors, [key]:
        `${voiceName(group.locale, group.voice)} is now served by ${languageProviderLabel(current!.provider, current!.engine)}, ` +
          `not ${languageProviderLabel(group.provider, group.engine)}. Generate the chapter again to choose settings.`,
      }));
      return;
    }
    await submit(event, {
      chapters: group.chapters,
      locale: group.locale,
      voice: group.voice,
      speed: group.speed,
    }, key);
  }

  const voiceOptions = selectedCatalog?.voices ?? [];
  const voiceMeta = voiceOptions.find((item) => item.id === voice);
  const voiceGroups = useMemo(() => languageVoiceGroups(voiceOptions), [voiceOptions]);
  const voiceBlockedReason = languageVoiceUnavailableReason(voiceOptions, voice);

  function voiceName(locale: string, id: string): string {
    const entry = state?.catalog.find((item) => item.locale === locale);
    return entry?.voices.find((item) => item.id === id)?.label || id;
  }

  return (
    <section
      aria-labelledby="language-versions-heading"
      className="sr-group p-4 [&_[role=alert]_button]:min-h-11 md:p-5"
      data-testid="language-versions"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h3 id="language-versions-heading" className="text-lg font-medium">Hindi</h3>
            <Tooltip label="English chapters stay untouched. Original artwork text stays unchanged." side="top"><button type="button" className="grid size-11 place-items-center text-muted-foreground" aria-label="Language information"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
          </div>
        </div>
        {privileged ? (
          <Button
            type="button"
            className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover"
            onClick={openDialog}
            disabled={loading || !catalog.length || exportBusy}
          >
            <Languages className="size-[18px]" strokeWidth={1.75} aria-hidden /> Create Hindi
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">View only</span>
        )}
      </div>

      {catalog.length > 1 ? (
        <div className="mt-4">
          <label className="block text-sm" htmlFor="language-version-locale">
            Language
            <select
              id="language-version-locale"
              className="mt-1 h-11 w-full rounded-lg border border-border-strong bg-background px-3 text-sm text-foreground sm:w-64"
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
            >
              {catalog.map((entry) => (
                <option key={entry.locale} value={entry.locale}>
                  {entry.label}
                  {entry.nativeLabel && entry.nativeLabel !== entry.label ? ` (${entry.nativeLabel})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {loading && !state ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      ) : null}

      {loadError ? (
        <ErrorNotice className="mt-4" info={requestInfo(loadError)} onRetry={() => void load()} retrying={loading} />
      ) : null}

      {!loading && !loadError && state && !catalog.length ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Not configured
        </p>
      ) : null}

      {activeVersion ? (
        <div className="mt-4 space-y-3" data-testid="language-version-current">
          {!activeVersion.error ? <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{activeVersion.label || localeLabel(state, activeVersion.locale)}</span>
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs",
                statusTone(activeVersion.status),
              )}
            >
              {STATUS_COPY[activeVersion.status] ?? activeVersion.status}
            </span>
            {active && languageChapterStage(activeVersion.stage) ? <span className="text-xs text-muted-foreground">{languageChapterStage(activeVersion.stage)}</span> : null}
            {active ? (
              <span className="sr-only" role="status">Live</span>
            ) : null}
            {autoRetry ? <RetryIndicator retry={autoRetry} /> : null}
          </div> : null}
          {activeVersion.error ? (
            <Notice className="[&>div:first-child>div:last-child]:w-full [&>div:first-child>div:last-child]:justify-between sm:[&>div:first-child>div:last-child]:w-auto" tone="danger" title="Hindi version failed" actions={autoRetry ? <RetryIndicator retry={autoRetry} /> : undefined} details={<RawDetails text={activeVersion.error} />} />
          ) : null}

          <ul className="sr-group overflow-hidden bg-background">
            {activeVersion.chapters.map((chapter) => {
              const playable = hasLanguageVideo(chapter);
               const notes = languageChapterNotes(chapter);
               const notice = languageChapterNotice(chapter);
               const failed = Boolean(chapter.error) || chapter.status === "failed" || chapter.status === "interrupted";
               const hasDetails = Boolean(chapter.error || chapter.stale || chapter.stage || notes.actionable.length || notes.review.length);
              const media = { slug, locale: activeVersion.locale, chapter: chapter.chapter };
              return (
                <li key={chapter.chapter} className="sr-row min-w-0 flex-col items-stretch gap-0 p-4" data-testid="language-chapter-row">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                      <p className="text-sm font-medium">{chapterLabel(chapter.chapter)}</p>
                      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs", chapterTone(chapter))}>
                        <span className="size-1.5 rounded-full bg-current" aria-hidden />
                        {failed ? chapter.status === "interrupted" ? "Interrupted" : "Failed" : chapter.stale ? "Stale" : STATUS_COPY[chapter.status] ?? "Pending"}
                      </span>
                      {chapter.status === "running" && languageChapterStage(chapter.stage) ? <span className="text-xs text-muted-foreground">{languageChapterStage(chapter.stage)}</span> : null}
                      {chapter.duration ? <span className="text-xs text-muted-foreground">{Math.round(chapter.duration)}s</span> : null}
                    </div>
                    {playable ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover"
                          onClick={() =>
                            setOpenVideo({
                              src: languageMediaUrl(chapter.videoUrl, media),
                              label: `${title} · Hindi ${chapterLabel(chapter.chapter)}`,
                            })
                          }
                        >
                          <Play className="size-[18px]" strokeWidth={1.75} aria-hidden /> Watch
                        </Button>
                        <Tooltip label={`Download ${chapterLabel(chapter.chapter)}`}><a
                          aria-label={`Download ${chapterLabel(chapter.chapter)}`}
                          className="inline-flex size-11 items-center justify-center rounded-full bg-muted text-sm hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={languageMediaUrl(chapter.videoUrl, media, true)}
                          download={`${slug}-${activeVersion.locale}-${chapter.chapter}.mp4`}
                        >
                          <Download className="size-[18px]" strokeWidth={1.75} aria-hidden />
                        </a></Tooltip>
                      </div>
                    ) : null}
                  </div>
                  {notice ? <p className={cn("mt-2 flex items-start gap-2 text-xs", notice.tone === "danger" ? "text-destructive" : "text-warning")}>
                    {notice.tone === "danger" ? <CircleAlert className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden /> : <AlertTriangle className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />}
                    <span className="min-w-0 pt-0.5">{notice.text}</span>
                  </p> : null}
                  {hasDetails ? <details className="group mt-1 min-w-0 text-xs text-muted-foreground">
                    <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      Details <ChevronDown className="size-3.5 group-open:rotate-180" aria-hidden />
                    </summary>
                    <div className="min-w-0 space-y-3 pb-2 [overflow-wrap:anywhere]">
                      {chapter.error ? <RawDetails text={chapter.error} /> : null}
                      {chapter.stage ? <RawDetails text={`Stage: ${chapter.stage}`} /> : null}
                      {chapter.stale ? <p>{playable
                        ? "The old Hindi video is still playable. Use Create Hindi and choose this chapter to update it."
                        : "Use Create Hindi and choose this chapter to update it."}</p> : null}
                      {notes.actionable.length ? <div><p className="mb-1 font-medium">Video notes ({notes.actionable.length})</p><RawDetails text={notes.actionable.join("\n")} /></div> : null}
                      {notes.review.length ? <div><p className="mb-1 font-medium">Review notes ({notes.review.length})</p><RawDetails text={notes.review.join("\n")} /></div> : null}
                    </div>
                  </details> : null}
                </li>
              );
            })}
          </ul>

          {privileged && (retryPlan.groups.length > 0 || retryPlan.unknown.length > 0) ? (
            <div className="space-y-2">
              {retryPlan.groups.map((group) => (
                <form
                  key={retryGroupKey(group)}
                  onSubmit={(event) => void retry(event, group)}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button type="submit" variant="outline" className="min-h-11" disabled={submitting || active || exportBusy}>
                    <RotateCcw className={cn("size-4", submitting && "animate-spin")} aria-hidden />
                    {submitting ? "Retrying…" : `Retry ${group.chapterNames.map(chapterLabel).join(", ")}`}
                  </Button>
                  <Tooltip side="top" label={
                    active
                      ? "Wait for the current run to finish before retrying."
                      : `Resends ${voiceName(group.locale, group.voice)} at speed ${group.speed}; completed chapters are reused when their source and settings are unchanged.`
                  }><button type="button" className="grid size-11 place-items-center text-muted-foreground" aria-label="Retry information"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
                  {retryErrors[retryGroupKey(group)] ? <ErrorNotice className="w-full" info={requestInfo(retryErrors[retryGroupKey(group)])} /> : null}
                </form>
              ))}
              {retryPlan.unknown.length ? (
                <Notice tone="warning" title="Choose a voice" details={<RawDetails text={`${retryPlan.unknown.map((chapter) => chapterLabel(chapter.chapter)).join(", ")}: no saved voice or speed. Generate again to choose settings.`} />} />
              ) : null}
              {formError ? (
                <ErrorNotice className="w-full" info={requestInfo(formError)} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : state && !loading && catalog.length ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Not created
        </p>
      ) : null}

      <LanguageExport key={`${slug}|${locale}`} slug={slug} locale={locale} privileged={privileged}
        snapshot={state} onToast={onToast} onBusy={setExportBusy} onPlay={(src, label) => setOpenVideo({ src, label })} />

      <Dialog open={Boolean(openVideo)} onOpenChange={(open) => { if (!open) setOpenVideo(null); }}>
        <DialogContent className="[&_[data-slot=dialog-close]]:size-11 sm:max-w-3xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">{openVideo?.label || "Hindi chapter"}</DialogTitle>
          </DialogHeader>
          {openVideo ? (
            <video
              key={openVideo.src}
              src={openVideo.src}
              controls
              playsInline
              preload="metadata"
              className="aspect-video w-full rounded-lg bg-black"
            />
          ) : null}
          <DialogFooter>
            {openVideo ? (
              <a
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-muted px-4 text-sm hover:bg-raised"
                href={`${openVideo.src}${openVideo.src.includes("?") ? "&" : "?"}download=1`}
                download
              >
                <Download className="size-4" aria-hidden /> Download
              </a>
            ) : null}
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setOpenVideo(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (submitting) return;
          setDialogOpen(open);
          if (!open) {
            previewAbort.current?.abort();
            previewAbort.current = null;
            previewKey.current = "";
            setPreviewing(false);
            setPreviewUrl("");
            setPreviewError("");
            setFormError("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto [&_[data-slot=dialog-close]]:size-11 [&_[role=alert]_button]:min-h-11 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">Create Hindi version</DialogTitle>
            <DialogDescription className="sr-only">Hindi audio and video for {title}.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            {catalog.length > 1 ? (
              <label className="block text-sm">
                Language
                <select
                  className="mt-1 h-11 w-full rounded-lg border border-border-strong bg-background px-3 text-sm text-foreground"
                  value={locale}
                  disabled={submitting}
                  onChange={(event) => onLocaleChange(event.target.value)}
                >
                  {catalog.map((entry) => (
                    <option key={entry.locale} value={entry.locale}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div>
              <div className="flex items-center justify-between gap-2">
                <label className="block text-sm" htmlFor="language-chapters">Chapters</label>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" className="min-h-11" disabled={submitting || !eligibleChapters.length}
                    onClick={() => { setChapters(allChapters.error ? "all" : allChapters.value); setFormError(""); }}>
                    All {allChapters.numbers.length || eligibleChapters.length}
                  </Button>
                  <Button type="button" variant="ghost" className="min-h-11" disabled={submitting || !chapters}
                    onClick={() => { setChapters(""); setFormError(""); }}>
                    Clear
                  </Button>
                </div>
              </div>
              <Input
                id="language-chapters"
                className="mt-1 h-11"
                value={chapters}
                placeholder="1-25"
                disabled={submitting}
                aria-describedby="language-chapters-count language-chapters-help"
                aria-invalid={Boolean(chapterSelection.error)}
                onChange={(event) => {
                  setChapters(event.target.value);
                  setFormError("");
                }}
              />
              <p id="language-chapters-count" className={cn("mt-2 text-xs", chapterSelection.error ? "text-destructive" : "text-muted-foreground")} role="status">
                {chapterSelection.error || `${chapterSelection.numbers.length} ${chapterSelection.numbers.length === 1 ? "chapter" : "chapters"}`}
                {chapterSelection.skipped.length ? ` · ch${compressChapterNumbers(chapterSelection.skipped)} skipped` : ""}
              </p>
              <span id="language-chapters-help" className="sr-only">
                One chapter (1), a range (1-3), a list (1,3), or all. Default is the first eligible chapter only.
              </span>
            </div>

            {eligibleChapters.length ? (
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto p-1" role="group" aria-label="Eligible chapters">
                {eligibleChapters.map((chapter) => {
                  const num = languageChapterNumber(chapter.chapter);
                  const selected = selectedNumbers.has(num);
                  return (
                    <button
                      key={chapter.chapter}
                      type="button"
                      className={cn("min-h-11 min-w-11 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-foreground bg-foreground text-background" : "border-transparent bg-muted hover:bg-raised")}
                      aria-pressed={selected}
                      disabled={submitting}
                      onClick={() => {
                        setChapters(compressChapterNumbers(selected
                          ? chapterSelection.numbers.filter((number) => number !== num)
                          : [...chapterSelection.numbers, num]));
                        setFormError("");
                      }}
                    >
                      {chapterLabel(chapter.chapter)}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {ineligibleChapters.length ? (
              <details className="rounded-xl bg-background p-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm text-warning">
                  <AlertTriangle className="size-4" aria-hidden />
                  {ineligibleChapters.length} unavailable
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {ineligibleChapters.map((chapter) => (
                    <li key={chapter.chapter}>
                      <span className="text-foreground">{chapterLabel(chapter.chapter)}</span>:{" "}
                      {chapter.reason || "Not rendered in English yet."}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div>
              <label className="block text-sm" htmlFor="language-voice">Hindi voice</label>
              <select
                id="language-voice"
                className="mt-1 h-11 w-full rounded-lg border border-border-strong bg-background px-3 text-sm text-foreground"
                value={voice}
                disabled={submitting || !voiceOptions.length}
                aria-describedby="language-voice-help"
                onChange={(event) => {
                  setVoice(event.target.value);
                  setPreviewUrl("");
                  setPreviewError("");
                  setFormError("");
                }}
              >
                {voiceOptions.length ? null : <option value="">No Hindi voice available</option>}
                {voiceGroups.map((group) => (
                  <optgroup
                    key={`${group.provider}|${group.id}`}
                    label={group.available ? group.label : `${group.label} · not configured`}
                  >
                    {group.voices.map((item) => (
                      <option key={item.id} value={item.id} disabled={item.available === false}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span id="language-voice-help" className="sr-only">
                {voiceMeta
                  ? [
                    voiceMeta.provider
                      ? languageProviderLabel(voiceMeta.provider, voiceMeta.engine)
                      : voiceMeta.engine ?? "",
                    voiceMeta.modelLabel ?? "",
                  ].filter(Boolean).join(" · ")
                  : "Choose the provider and model for this language."}
              </span>
            </div>

            {voiceBlockedReason ? (
              <Notice tone="warning" title="Voice unavailable" details={<RawDetails text={voiceBlockedReason} />} />
            ) : null}

            <div>
              <label className="block text-sm" htmlFor="language-speed">Speed</label>
              <Input
                id="language-speed"
                type="number"
                className="mt-1 h-11 font-mono"
                min={LANGUAGE_SPEED_MIN}
                max={LANGUAGE_SPEED_MAX}
                step={0.05}
                value={speed}
                disabled={submitting}
                aria-describedby="language-speed-help"
                onChange={(event) => {
                  setSpeed(event.target.value);
                  setFormError("");
                }}
              />
              <span id="language-speed-help" className="sr-only">
                {LANGUAGE_SPEED_MIN}–{LANGUAGE_SPEED_MAX}. 1 is this Hindi voice’s normal speed.
              </span>
            </div>

            <div className="rounded-xl bg-background p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={submitting || previewing || !voice || Boolean(voiceBlockedReason)}
                  onClick={() => void onPreview()}
                >
                  <Volume2 className={cn("size-4", previewing && "animate-pulse")} aria-hidden />
                  {previewing ? "Preparing sample…" : "Preview Hindi voice"}
                </Button>
              </div>
              {previewError ? (
                <ErrorNotice className="mt-2" info={requestInfo(previewError)} onRetry={() => void onPreview()} />
              ) : null}
              {previewUrl ? (
                <audio
                  key={previewUrl}
                  src={previewUrl}
                  controls
                  preload="metadata"
                  className="mt-2 w-full"
                  aria-label="Hindi voice preview"
                />
              ) : null}
            </div>

            <details className="text-xs text-muted-foreground"><summary className="flex min-h-11 cursor-pointer items-center">Cost</summary><p>
              Cost: one Hindi narration and render per chapter whose source or voice/provider/speed settings
              changed. A chapter is reused from cache only when its English source and its saved voice,
              provider, and speed are unchanged. The English version is never re-rendered.
            </p></details>

            {formError ? (
              <ErrorNotice info={requestInfo(formError)} />
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={submitting}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover"
                disabled={submitting || exportBusy || !voice || Boolean(voiceBlockedReason) || Boolean(chapterSelection.error) || !chapterSelection.numbers.length}
              >
                {submitting ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" aria-hidden /> Starting…
                  </>
                ) : (
                  <>
                    <Languages className="size-4" aria-hidden /> Generate Hindi version
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
