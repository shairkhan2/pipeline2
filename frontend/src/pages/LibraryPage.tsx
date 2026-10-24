import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Download, Film, HardDrive, Info, Play, Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { LanguageVersions } from "@/components/library/LanguageVersions";
import { MoviePlanPanel } from "@/components/library/MoviePlanPanel";
import { SeriesSettingsEditor } from '@/components/library/SeriesSettingsEditor';
import { StorageTrashDrawer } from "@/components/shared/StorageTrashDrawer";
import { ErrorNotice, Notice, RawDetails } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
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
import {
  api,
  type LibraryChapter,
  type LibrarySeries,
  type LibrarySnapshot,
  type OutroCharacterPanel,
  type OutroHookType,
  type SeriesMergeState,
  type SeriesOutroAttachment,
  type SeriesOutroState,
} from "@/lib/api";
import { describeError, type ErrorInfo } from "@/lib/errors";
import { cn } from "@/lib/utils";

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
const RATE_KEY = "playback-rate";

type LibraryRoute =
  | { view: "home" }
  | { view: "series"; slug: string }
  | { view: "watch"; slug: string; ch: string }
  | { view: "artwork" };

interface DeleteSubject {
  slug: string;
  ch: string;
  title: string;
  num: number;
  size: number;
  arms: number;
}

interface ResumeItem {
  series: LibrarySeries;
  chapter: LibraryChapter;
  pos: number;
  at: number;
}

interface Cut {
  name: string;
  url: string;
  size: number;
  duration: number | null;
}

type FullscreenVideo = HTMLVideoElement & {
  webkitRequestFullscreen?: () => void;
  webkitEnterFullscreen?: () => void;
};

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | number): void {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* Private mode and blocked storage stay in-memory for this view only. */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Ignore. */
    }
  },
};

function posKey(slug: string, ch: string): string {
  return `pos:${slug}:${ch}`;
}
function atKey(slug: string, ch: string): string {
  return `at:${slug}:${ch}`;
}
function doneKey(slug: string, ch: string): string {
  return `done:${slug}:${ch}`;
}

function getPos(slug: string, ch: string): number {
  return Math.max(0, Number(storage.get(posKey(slug, ch))) || 0);
}

function isDone(slug: string, ch: string): boolean {
  return storage.get(doneKey(slug, ch)) === "1";
}

function setPos(slug: string, ch: string, time: number): void {
  storage.set(posKey(slug, ch), time);
  storage.set(atKey(slug, ch), Date.now());
}

function forgetChapter(slug: string, ch: string): void {
  storage.remove(posKey(slug, ch));
  storage.remove(atKey(slug, ch));
  storage.remove(doneKey(slug, ch));
}

function safeDecode(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function parseHash(hash: string): LibraryRoute {
  const series = hash.match(/^#\/series\/([^/]+)\/?$/);
  if (series) return { view: "series", slug: safeDecode(series[1]) };
  const watch = hash.match(/^#\/watch\/([^/]+)\/([^/]+)\/?$/);
  if (watch) return { view: "watch", slug: safeDecode(watch[1]), ch: safeDecode(watch[2]) };
  if (hash.replace(/\/$/, "") === "#/artwork") return { view: "artwork" };
  return { view: "home" };
}

function seriesHref(slug: string): string {
  return `#/series/${encodeURIComponent(slug)}`;
}

function watchHref(slug: string, ch: string): string {
  return `#/watch/${encodeURIComponent(slug)}/${encodeURIComponent(ch)}`;
}

function posterUrl(slug: string, ch: string): string {
  return `/poster/${encodeURIComponent(slug)}/${encodeURIComponent(ch)}`;
}

function thumbUrl(name: string, url?: string): string {
  if (url && url.startsWith("/thumbs/")) return url;
  return `/thumbs/${encodeURIComponent(name)}`;
}

function fmtTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const s = Math.max(0, Math.round(Number(value)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtLength(value: number): string {
  if (!value) return "Ready to watch";
  const m = Math.max(1, Math.round(value / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  return `${Math.max(1, Math.round((bytes || 0) / 1048576))} MB`;
}

function artworkLabel(name: string): string {
  return name.replace(/\.[a-z]+$/i, "").replace(/__dup(\d+)$/, " · version $1").replace(/[_-]+/g, " ");
}

function newest(series: LibrarySeries): number {
  return Math.max(0, ...series.chapters.map((chapter) => chapter.mtime || 0));
}

function totalDuration(series: LibrarySeries): number {
  return series.chapters.reduce((sum, chapter) => sum + (chapter.duration || 0), 0);
}

function coverChapter(series: LibrarySeries): LibraryChapter | undefined {
  return series.chapters.find((chapter) => chapter.poster) ?? series.chapters[0];
}

function progressPct(slug: string, chapter: LibraryChapter): number {
  if (isDone(slug, chapter.ch)) return 100;
  const pos = getPos(slug, chapter.ch);
  if (!chapter.duration || pos <= 0) return 0;
  return Math.min(100, (pos / chapter.duration) * 100);
}

function cutsOf(chapter: LibraryChapter): Cut[] {
  const arms = (chapter as LibraryChapter & { arms?: Cut[] }).arms ?? [];
  return [{ name: "Original cut", url: chapter.url, size: chapter.size, duration: chapter.duration }, ...arms];
}

function readRate(): (typeof RATES)[number] {
  const saved = Number(storage.get(RATE_KEY));
  return RATES.find((rate) => rate === saved) ?? 1;
}

function matchesQuery(series: LibrarySeries, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (series.title.toLowerCase().includes(q) || series.slug.toLowerCase().includes(q)) return true;
  const bare = q.replace(/^(chapter|ch)\s*/, "").trim();
  if (/^\d+$/.test(bare)) return series.chapters.some((chapter) => chapter.num === Number(bare));
  return series.chapters.some((chapter) => chapter.ch.toLowerCase().includes(q));
}

function continueWatching(library: LibrarySnapshot): ResumeItem[] {
  const items: ResumeItem[] = [];
  for (const series of library.series) {
    for (const chapter of series.chapters) {
      const pos = getPos(series.slug, chapter.ch);
      if (pos <= 5 || isDone(series.slug, chapter.ch)) continue;
      if (chapter.duration && pos >= chapter.duration - 8) continue;
      items.push({
        series,
        chapter,
        pos,
        at: Number(storage.get(atKey(series.slug, chapter.ch))) || 0,
      });
    }
  }
  items.sort((a, b) => b.at - a.at);
  return items;
}

function libraryShape(data: LibrarySnapshot | null): string {
  if (!data) return "";
  return JSON.stringify([
    data.series.map((series) => [series.slug, series.chapters.map((chapter) => chapter.ch), series.full?.url ?? ""]),
    data.thumbnails.map((thumb) => thumb.name),
  ]);
}

function requestInfo(error: string | ErrorInfo): ErrorInfo {
  return typeof error === "string" ? describeError(error) : error;
}

async function toggleFullscreen(video: HTMLVideoElement): Promise<void> {
  const node = video as FullscreenVideo;
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
    return;
  }
  if (video.requestFullscreen) {
    await video.requestFullscreen().catch(() => {});
    return;
  }
  node.webkitRequestFullscreen?.();
  node.webkitEnterFullscreen?.();
}

function Poster({
  slug,
  ch,
  alt,
  className,
  eager = false,
}: {
  slug: string;
  ch: string;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className={cn("grid place-items-center bg-muted text-3xl font-semibold tracking-[-0.02em] text-muted-foreground", className)} aria-hidden>
        {(alt || slug).slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={posterUrl(slug, ch)}
      alt={alt}
      className={cn("object-cover", className)}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

function ProgressTrack({ pct, label }: { pct: number; label: string }) {
  return (
    <span
      className="block h-1 overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <span className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

export function LibraryPage() {
  const [route, setRoute] = useState<LibraryRoute>(() => parseHash(window.location.hash || "#/"));
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | ErrorInfo>("");
  const [warning, setWarning] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(() => storage.get("library-sort") || "latest");
  const [toast, setToast] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteSubject | null>(null);
  const [light, setLight] = useState<{ name: string; url: string; size: number } | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const toastTimer = useRef(0);
  const libraryShapeRef = useRef("");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const refresh = useCallback(async (manual: boolean) => {
    if (manual) setRefreshing(true);
    try {
      const next = await api.library();
      const prevShape = libraryShapeRef.current;
      const nextShape = libraryShape(next);
      libraryShapeRef.current = nextShape;
      setLibrary(next);
      if (manual) showToast("Your collection is up to date");
      else if (prevShape && prevShape !== nextShape) showToast("Your collection has been updated");
      setLoadError("");
      setWarning("");
    } catch (error) {
      if (!manual) {
        setWarning("Couldn’t refresh the library. Showing the last copy.");
        return;
      }
      setLoadError(describeError(error, "Couldn’t load the library."));
      showToast("Couldn’t refresh. Please try again.");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash || "#/"));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    let stop = false;
    api
      .library()
      .then((next) => {
        if (stop) return;
        libraryShapeRef.current = libraryShape(next);
        setLibrary(next);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (!stop) setLoadError(describeError(error, "Couldn’t load the library."));
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || route.view === "watch" || deleteTarget) return;
      void refresh(false);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [route.view, deleteTarget, refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (route.view === "watch") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      document.getElementById("library-search")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.view]);

  const routeSlug = route.view === "series" || route.view === "watch" ? route.slug : "";
  const routeCh = route.view === "watch" ? route.ch : "";

  useEffect(() => {
    const series = library?.series.find((item) => item.slug === routeSlug);
    const chapter = route.view === "watch" ? series?.chapters.find((item) => item.ch === routeCh) : undefined;
    const title =
      route.view === "artwork"
        ? "Artwork — Screening Room"
        : route.view === "series"
          ? `${series?.title || "Series"} — Screening Room`
          : route.view === "watch"
            ? routeCh === "full"
              ? `${series?.title || "Series"} — Full compilation`
              : `Chapter ${chapter?.num ?? routeCh} — ${series?.title || "Screening Room"}`
            : "Library — Screening Room";
    document.title = title;
  }, [route.view, routeSlug, routeCh, library]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [route.view, routeSlug, routeCh]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const privileged = library?.privileged === true;
  const series = useMemo(() => {
    const all = [...(library?.series ?? [])];
    all.sort(sort === "title" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => newest(b) - newest(a));
    return all;
  }, [library, sort]);
  const filtered = series.filter((item) => matchesQuery(item, query));
  const resume = library ? continueWatching(library).filter((item) => matchesQuery(item.series, query)) : [];
  const activeSeries = route.view === "series" || route.view === "watch"
    ? library?.series.find((item) => item.slug === route.slug)
    : undefined;

  const shellTitle =
    route.view === "artwork"
      ? "Artwork"
      : route.view === "series"
        ? activeSeries?.title || "Series"
        : route.view === "watch"
          ? route.ch === "full"
            ? "Full compilation"
            : "Now playing"
          : "Library";
  const eyebrow =
    route.view === "artwork" ? "The art of the story" : route.view === "watch" ? activeSeries?.title || "Now playing" : "Your collection";

  function openDelete(subject: DeleteSubject) {
    if (!privileged) return;
    setDeleteTarget(subject);
  }

  async function onDeleted(subject: DeleteSubject, message: string) {
    forgetChapter(subject.slug, subject.ch);
    setDeleteTarget(null);
    showToast(message || "Rendered video deleted.");
    setLibrary((current) => {
      if (!current) return current;
      return {
        ...current,
        series: current.series
          .map((item) =>
            item.slug === subject.slug
              ? { ...item, chapters: item.chapters.filter((chapter) => chapter.ch !== subject.ch) }
              : item,
          )
          .filter((item) => item.chapters.length > 0),
      };
    });
    if (route.view === "watch" && route.slug === subject.slug && route.ch === subject.ch) {
      const remaining = library?.series.find((item) => item.slug === subject.slug)?.chapters.some((chapter) => chapter.ch !== subject.ch);
      window.location.hash = remaining ? seriesHref(subject.slug) : "#/";
    }
    try {
      const next = await api.library();
      libraryShapeRef.current = libraryShape(next);
      setLibrary(next);
      setWarning("");
    } catch {
      setWarning("Video deleted. Couldn’t refresh the library from the server.");
    }
  }

  let body: ReactNode;
  if (!library && loadError) {
    body = (
      <ErrorNotice className="[&_button]:min-h-11" info={requestInfo(loadError)} onRetry={() => void refresh(true)} />
    );
  } else if (!library) {
    body = (
      <div className="py-16" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  } else if (route.view === "artwork") {
    body = (
      <ArtworkView
        library={library}
        query={query}
        onOpen={setLight}
      />
    );
  } else if (route.view === "watch") {
    body = activeSeries ? (
      <WatchView
        key={`${activeSeries.slug}/${route.ch}`}
        series={activeSeries}
        ch={route.ch}
        privileged={privileged}
        blocked={Boolean(deleteTarget)}
        onDelete={openDelete}
      />
    ) : (
      <Missing title="This series isn’t in the library." />
    );
  } else if (route.view === "series") {
    body = activeSeries ? (
      <SeriesView
        key={activeSeries.slug}
        series={activeSeries}
        privileged={privileged}
        query={query}
        onDelete={openDelete}
        onRefresh={() => void refresh(false)}
        onToast={showToast}
      />
    ) : (
      <Missing title="This series isn’t in the library." />
    );
  } else if (series.length === 0) {
    body = (
      <EmptyState
        title="No videos yet"
        text="Rendered chapters show up here on their own. Start a series from a Drive link or ZIP, or connect a model provider in settings first."
      >
        <a className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover" href="/new-series.html">
          Start a series
        </a>
        <a className="inline-flex min-h-11 items-center rounded-full bg-background px-4 text-[14.5px] font-medium hover:bg-muted" href="?settings=providers">
          Open settings
        </a>
      </EmptyState>
    );
  } else {
    body = (
      <HomeView
        series={filtered}
        total={series.length}
        resume={resume}
        query={query}
        sort={sort}
        onSort={(value) => {
          setSort(value);
          storage.set("library-sort", value);
        }}
        onClear={() => setQuery("")}
      />
    );
  }

  const showSearch = route.view !== "watch";

  return (
    <AppShell
      active={route.view === "artwork" ? "artwork" : "library"}
      eyebrow={eyebrow}
      title={shellTitle}
      actions={
        showSearch ? (
          <div className="flex min-w-0 items-center gap-2">
            <label className="relative block min-w-0">
              <span className="sr-only">{route.view === "artwork" ? "Search artwork" : "Search series or chapter"}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="library-search"
                type="search"
                value={query}
                placeholder={route.view === "artwork" ? "Search artwork" : "Search series or chapter"}
                aria-label={route.view === "artwork" ? "Search artwork" : "Search series or chapter"}
                autoComplete="off"
                spellCheck={false}
                className="h-10 w-[min(300px,40vw)] rounded-full border-transparent bg-card pl-9 max-sm:w-[min(200px,44vw)]"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Tooltip label="Storage" side="bottom"><Button
              type="button"
              variant="outline"
              className="max-sm:hidden"
              aria-label="Storage & Trash"
              onClick={() => setStorageOpen(true)}
            >
              <HardDrive className="size-4" aria-hidden />
              <span className="hidden lg:inline">Storage</span>
            </Button></Tooltip>
            <Tooltip label="Refresh" side="bottom"><Button
              type="button"
              variant="outline"
              size="icon"
              className="max-sm:hidden"
              aria-label="Refresh library"
              disabled={refreshing}
              onClick={() => void refresh(true)}
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
            </Button></Tooltip>
          </div>
        ) : null
      }
    >
      {warning ? (
        <Notice tone="warning" title="Library update failed" className="mb-4" details={<RawDetails text={warning} />} />
      ) : null}
      {body}
      <p className="sr-only" role="status" aria-live="polite">{toast}</p>
      {toast ? (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-float md:bottom-6" role="status">
          {toast}
        </div>
      ) : null}
      <DeleteChapterDialog
        subject={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={(subject, message) => void onDeleted(subject, message)}
      />
      <Dialog open={Boolean(light)} onOpenChange={(open) => { if (!open) setLight(null); }}>
        <DialogContent className="[&_[data-slot=dialog-close]]:size-11 sm:max-w-3xl" aria-describedby={undefined}>
          {light ? (
            <>
              <DialogHeader>
                <DialogTitle className="break-words text-2xl font-semibold tracking-[-0.015em]">{artworkLabel(light.name)}</DialogTitle>
                <DialogDescription>{light.name} · {fmtSize(light.size)}</DialogDescription>
              </DialogHeader>
              <img src={light.url} alt={artworkLabel(light.name)} className="max-h-[65vh] w-full rounded-2xl bg-muted object-contain" />
              <DialogFooter>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover" href={`${light.url}?download=1`} download={light.name}>
                  <Download className="size-4" aria-hidden /> Download
                </a>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <StorageTrashDrawer
        open={storageOpen}
        onOpenChange={setStorageOpen}
        privileged={privileged}
        onMessage={showToast}
        onAfterChange={() => refresh(false)}
      />
    </AppShell>
  );
}

function HomeView({
  series,
  total,
  resume,
  query,
  sort,
  onSort,
  onClear,
}: {
  series: LibrarySeries[];
  total: number;
  resume: ResumeItem[];
  query: string;
  sort: string;
  onSort: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-10 pt-2">
      {resume.length ? (
        <section aria-label="Continue watching">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-[-0.01em]">Continue watching</h2>
            <p className="text-[14px] text-muted-foreground">{resume.length} in progress</p>
          </div>
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
            {resume.map((item) => {
              const pct = item.chapter.duration ? Math.min(100, (item.pos / item.chapter.duration) * 100) : 0;
              const left = item.chapter.duration ? fmtTime(item.chapter.duration - item.pos) : fmtTime(item.pos);
              return (
                <a
                  key={`${item.series.slug}/${item.chapter.ch}`}
                  href={watchHref(item.series.slug, item.chapter.ch)}
                  className="w-44 shrink-0 snap-start"
                  aria-label={`Continue ${item.series.title}, chapter ${item.chapter.num}, ${left} remaining`}
                >
                  <span className="relative block aspect-[2/3] overflow-hidden rounded-[20px] bg-muted">
                    <Poster slug={item.series.slug} ch={item.chapter.ch} alt="" className="size-full" />
                    <span className="absolute inset-x-2 bottom-2">
                      <ProgressTrack pct={pct} label="Saved progress" />
                    </span>
                  </span>
                  <span className="mt-2.5 block truncate text-[15px] font-medium">{item.series.title}</span>
                  <span className="block text-[13px] text-muted-foreground">Chapter {item.chapter.num}, {left} left</span>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-label="Series">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.02em] md:text-[32px]">Library</h1>
            <p className="mt-0.5 text-[15px] text-muted-foreground">{total} series</p>
          </div>
          <label className="flex items-center gap-2 text-[14px] text-muted-foreground">
            <span className="max-sm:sr-only">Sort</span>
            <select
              aria-label="Sort library"
              className="field min-h-10 w-auto rounded-full"
              value={sort}
              onChange={(event) => onSort(event.target.value)}
            >
              <option value="latest">Recently added</option>
              <option value="title">Title A–Z</option>
            </select>
          </label>
        </div>
        {query ? (
          <p className="mb-3 text-sm text-muted-foreground" role="status">
            {series.length} series matching “{query.trim()}”
          </p>
        ) : null}
        {series.length === 0 ? (
          <EmptyState title="No stories found" text="Try a series title or a chapter number, like “chapter 12”.">
            <Button type="button" variant="outline" className="min-h-11" onClick={onClear}>Clear search</Button>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {series.map((item) => {
              const cover = coverChapter(item);
              return (
                <a
                  key={item.slug}
                  href={seriesHref(item.slug)}
                  className="group block min-w-0"
                  aria-label={`${item.title}, ${item.chapters.length} chapters`}
                >
                  <span className="relative block aspect-[2/3] overflow-hidden rounded-[22px] bg-muted transition-shadow duration-200 group-hover:shadow-float group-focus-visible:ring-2 group-focus-visible:ring-ring">
                    {cover ? <Poster slug={item.slug} ch={cover.ch} alt="" className="size-full transition-transform duration-300 group-hover:scale-[1.025]" /> : null}
                    <span className="absolute top-2 right-2 rounded-full bg-black/65 px-2 py-0.5 text-[12px] font-medium text-white tabular-nums backdrop-blur-sm">
                      {item.chapters.length} ch
                    </span>
                  </span>
                  <span className="mt-2.5 block truncate text-[15px] font-medium">{item.title}</span>
                  <span className="block text-[13px] text-muted-foreground">{item.chapters.length} {item.chapters.length === 1 ? "chapter" : "chapters"}, {fmtLength(totalDuration(item))}</span>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function describeOutroAttachment(
  attachment: SeriesOutroAttachment | undefined,
  attached: boolean,
  target: string | null,
): string {
  if (!attachment) return attached ? "Outro included in next merge" : "Chapters only";
  if (!attachment.explicit) {
    return attachment.videoAvailable === false ? "No outro generated" : "Outro included automatically";
  }
  if (!attachment.enabled) return "Outro detached";
  if (attachment.missing) return "Outro attached but missing";
  return `Outro attached after ${target ?? "last chapter"}`;
}

/**
 * Attach/re-attach is only pointless when an explicit attachment is enabled and its
 * snapshot still matches the current render. A legacy default (nothing saved), a
 * regenerated render, or a missing render must all be fixable from the UI.
 */
function canAttachOutro(attachment: SeriesOutroAttachment | undefined): boolean {
  if (!attachment) return true;
  // Nothing to attach without a render; detach stays available instead.
  if (attachment.videoAvailable === false) return false;
  if (!attachment.explicit) return true;
  if (!attachment.enabled) return true;
  return Boolean(attachment.stale || attachment.videoChanged || attachment.missing);
}

function SeriesView({
  series,
  privileged,
  query,
  onDelete,
  onRefresh,
  onToast,
}: {
  series: LibrarySeries;
  privileged: boolean;
  query: string;
  onDelete: (subject: DeleteSubject) => void;
  onRefresh: () => void;
  onToast: (message: string) => void;
}) {
  const cover = coverChapter(series);
  const q = query.trim().toLowerCase();
  const bare = q.replace(/^(chapter|ch)\s*/, "").trim();
  const chapters = series.chapters.filter((chapter) => {
    if (!q || series.title.toLowerCase().includes(q) || series.slug.toLowerCase().includes(q)) return true;
    if (/^\d+$/.test(bare)) return chapter.num === Number(bare);
    return chapter.ch.toLowerCase().includes(q);
  });

  const [mergeState, setMergeState] = useState<SeriesMergeState | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<{ error: unknown; force: boolean } | null>(null);

  const [extendOpen, setExtendOpen] = useState(false);
  const [extendChapters, setExtendChapters] = useState(() => {
    const maxCh = Math.max(0, ...series.chapters.map((c) => c.num || 0));
    return maxCh > 0 ? `${maxCh + 1}-${maxCh + 20}` : "21-40";
  });
  const [extendGdriveUrl, setExtendGdriveUrl] = useState("");
  const [extendFile, setExtendFile] = useState<File | null>(null);
  const extendFileInput = useRef<HTMLInputElement>(null);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | ErrorInfo>("");

  const [outroOpen, setOutroOpen] = useState(false);
  const [outroState, setOutroState] = useState<SeriesOutroState | null>(null);
  const [totalChapters, setTotalChapters] = useState(() => Math.max(50, series.chapters.length || 20));
  const [coveredChapters, setCoveredChapters] = useState(() => Math.max(1, series.chapters.length || 20));
  const [hookType, setHookType] = useState<OutroHookType>("part2");
  const [customPrompt, setCustomPrompt] = useState("");
  const [generatingOutro, setGeneratingOutro] = useState(false);
  const [outroError, setOutroError] = useState<string | ErrorInfo>("");
  const [outroCacheBust, setOutroCacheBust] = useState(0);
  const [attachingOutro, setAttachingOutro] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | ErrorInfo>("");
  const activeSlugRef = useRef(series.slug);

  useEffect(() => {
    activeSlugRef.current = series.slug;
    setOutroOpen(false);
    setOutroState(null);
    setOutroError("");
    setOutroCacheBust(0);
    setGeneratingOutro(false);
    setAttachingOutro(false);
    setAttachmentError("");
    setCoveredChapters(Math.max(1, series.chapters.length || 20));
    setTotalChapters(Math.max(50, series.chapters.length || 20));
    setHookType("part2");
    setCustomPrompt("");
    setExtendOpen(false);
    setExtendError("");
    setExtendFile(null);
    return () => {
      activeSlugRef.current = "";
    };
  }, [series.slug]);

  useEffect(() => {
    let stop = false;
    api.series
      .getMerge(series.slug)
      .then((res) => {
        if (!stop) setMergeState(res);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [series.slug, series.chapters, series.full]);

  const hasFullVideo = Boolean(series.full || mergeState?.exists || mergeState?.merged || mergeState?.url);
  const mergeStale = mergeState?.stale === true;
  const mergedSize = Number(mergeState?.sizeBytes ?? mergeState?.size ?? series.full?.size);
  const mergedChapters = mergeState?.chaptersMerged ?? mergeState?.chapters;
  const mergedChapterCount = Array.isArray(mergedChapters)
    ? mergedChapters.length
    : typeof mergedChapters === "number" ? mergedChapters : mergeState?.chapterCount;
  const fullDownloadHref = `/media/${encodeURIComponent(series.slug)}/full.mp4?download=1`;
  const attachment: SeriesOutroAttachment | undefined = mergeState?.attachment;
  const attachmentAttached = attachment ? attachment.nextMergeIncludesOutro : Boolean(mergeState?.includesOutro);
  const attachmentTarget =
    attachment?.targetChapter || mergeState?.outro?.targetChapter || null;
  /** The GET /merge payload reports the rendered outro even before the builder modal opens. */
  const outroRendered = Boolean(mergeState?.outro?.videoUrl);
  const attachmentLabel = describeOutroAttachment(attachment, attachmentAttached, attachmentTarget);

  async function runMergeAll(force = false) {
    if (!privileged || merging) return;
    const requestedSlug = series.slug;
    setMerging(true);
    setMergeError(null);
    try {
      // No includeOutro override: the server applies the saved attachment preference
      // (legacy default: include a rendered outro) so a detached outro stays out.
      const res = await api.series.mergeAll(series.slug, { force });
      if (activeSlugRef.current !== requestedSlug) return;
      setMergeState({ ...res, exists: true, merged: true });
      onToast(res.message || "Merged all chapters into full.mp4.");
      onRefresh();
    } catch (error) {
      if (activeSlugRef.current === requestedSlug) setMergeError({ error, force });
    } finally {
      if (activeSlugRef.current === requestedSlug) setMerging(false);
    }
  }

  async function toggleOutroAttachment(enabled: boolean) {
    if (!privileged || attachingOutro) return;
    const requestedSlug = series.slug;
    setAttachingOutro(true);
    setAttachmentError("");
    try {
      const res = await api.series.setOutroAttachment(requestedSlug, enabled);
      if (activeSlugRef.current !== requestedSlug) return;
      if (res.merge) {
        setMergeState(res.merge);
      } else {
        try {
          const refreshed = await api.series.getMerge(requestedSlug);
          if (activeSlugRef.current === requestedSlug) setMergeState(refreshed);
        } catch {
          if (activeSlugRef.current === requestedSlug) {
            setAttachmentError("Outro preference saved, but the merge state could not be refreshed.");
          }
        }
      }
      if (res.attachment && activeSlugRef.current === requestedSlug) {
        setOutroState((prev) => (prev ? { ...prev, attachment: res.attachment } : prev));
      }
      if (activeSlugRef.current !== requestedSlug) return;
      onToast(
        enabled
          ? `Outro attached after ${res.attachment?.targetChapter ?? "the last chapter"}. Chapter files unchanged.`
          : "Outro detached. Merge All Chapters will include chapters only.",
      );
      onRefresh();
    } catch (error) {
      if (activeSlugRef.current !== requestedSlug) return;
      setAttachmentError(describeError(error, enabled ? "Could not attach the outro." : "Could not detach the outro."));
    } finally {
      if (activeSlugRef.current === requestedSlug) setAttachingOutro(false);
    }
  }

  async function submitExtend(event: FormEvent) {
    event.preventDefault();
    if (!privileged || extending) return;
    const gdriveUrl = extendGdriveUrl.trim();
    const spec = extendChapters.trim() || (extendFile || gdriveUrl ? "all" : "");
    if (!spec) {
      setExtendError("Enter a chapter range like 21-40.");
      return;
    }
    if (extendFile && (!/\.zip$/i.test(extendFile.name) || extendFile.size === 0)) {
      setExtendError("Choose a non-empty .zip archive of new chapters.");
      return;
    }
    if (extendFile && gdriveUrl) {
      setExtendError("Choose either a ZIP upload or a Google Drive URL, not both.");
      return;
    }
    setExtending(true);
    setExtendError("");
    try {
      const res = await api.series.extend(series.slug, {
        chapters: spec,
        file: extendFile,
        filename: extendFile?.name,
        gdriveUrl: gdriveUrl || undefined,
        preserveCompleted: true,
      });
      await api.series.getMerge(series.slug).then((m) => {
        if (activeSlugRef.current === series.slug) setMergeState(m);
      }).catch(() => {});
      if (activeSlugRef.current !== series.slug) return;
      setExtendFile(null);
      if (extendFileInput.current) extendFileInput.current.value = "";
      setExtendOpen(false);
      const baseMsg = res.message || `Extended ${series.title} (${spec}) without rerunning completed chapters.`;
      const extendWarnings = Array.isArray(res.warnings)
        ? res.warnings.map((w) => String(w || "").trim()).filter(Boolean)
        : [];
      onToast(extendWarnings.length ? `${baseMsg} Warning: ${extendWarnings.join(" ")}` : baseMsg);
      onRefresh();
    } catch (error) {
      if (activeSlugRef.current === series.slug) {
        setExtendError(describeError(error, "Could not extend series."));
      }
    } finally {
      if (activeSlugRef.current === series.slug) {
        setExtending(false);
      }
    }
  }

  function openOutroModal() {
    const requestedSlug = series.slug;
    setOutroOpen(true);
    setOutroError("");
    void api.series
      .getOutro(requestedSlug)
      .then((res) => {
        if (activeSlugRef.current !== requestedSlug) return;
        setOutroState(res);
        if (res.videoUpdatedAt || res.updatedAt) {
          setOutroCacheBust(Number(res.videoUpdatedAt || res.updatedAt) || Date.now());
        }
        const cov = typeof res.coveredChapters === "number" && res.coveredChapters > 0
          ? res.coveredChapters
          : Math.max(1, series.chapters.length || 1);
        const availCount = Array.isArray(res.availableChapters) ? res.availableChapters.length : 0;
        const tot = typeof res.totalChapters === "number" && res.totalChapters >= cov
          ? res.totalChapters
          : Math.max(cov, availCount, totalChapters);
        setCoveredChapters(cov);
        setTotalChapters(tot);
        if (res.hookType) setHookType(res.hookType);
      })
      .catch((error) => {
        if (activeSlugRef.current !== requestedSlug) return;
        setOutroError(describeError(error, "Could not inspect series outro state."));
      });
  }

  async function submitGenerateOutro(event: FormEvent) {
    event.preventDefault();
    if (!privileged || generatingOutro) return;
    const requestedSlug = series.slug;
    setGeneratingOutro(true);
    setOutroError("");
    try {
      const res = await api.series.generateOutro(requestedSlug, {
        enabled: true,
        totalChapters,
        coveredChapters,
        hookType,
        customPrompt: customPrompt.trim() || undefined,
        renderVideo: true,
      });
      if (activeSlugRef.current !== requestedSlug) return;
      const panels = res.panels || res.selectedPanels || [];
      const hasRenderedVideo = Boolean(res.videoUrl && res.rendered !== false && res.hasVideo !== false && !res.renderError);
      if (res.ok === false || !panels.length || !hasRenderedVideo) {
        const reason = String(
          res.renderError ||
            res.error ||
            (!panels.length
              ? "No usable character or narrative panels available to generate an outro announcement."
              : "Outro video could not be rendered."),
        );
        setOutroState((prev) => {
          const prevHasVideo = Boolean(prev?.videoUrl && prev?.hasVideo !== false);
          return {
            ...prev,
            ...res,
            rendered: prevHasVideo ? true : false,
            hasVideo: prevHasVideo,
            videoUrl: prevHasVideo ? prev!.videoUrl : null,
            videoUpdatedAt: prevHasVideo ? prev!.videoUpdatedAt : null,
          };
        });
        setOutroError(reason);
        return;
      }
      const stamp = Number(res.videoUpdatedAt || res.updatedAt || Date.now()) || Date.now();
      setOutroCacheBust(stamp);
      setOutroState({ ...res, hasVideo: true });
      const warnings = [
        res.audioError ? `Audio warning: ${String(res.audioError)}` : "",
        typeof res.warning === "string" && res.warning !== res.audioError ? String(res.warning) : "",
      ].filter(Boolean);
      if (warnings.length) {
        setOutroError(`Outro video generated without narration. ${warnings.join(" ")}`);
        onToast("Outro video generated with warnings. See the dialog for details.");
      } else {
        onToast("Generated character-panel outro announcement.");
      }
      void api.series.getMerge(requestedSlug).then((m) => {
        if (activeSlugRef.current === requestedSlug) setMergeState(m);
      }).catch(() => {});
      onRefresh();
    } catch (error) {
      if (activeSlugRef.current === requestedSlug) {
        setOutroError(describeError(error, "Could not generate outro announcement."));
      }
    } finally {
      if (activeSlugRef.current === requestedSlug) {
        setGeneratingOutro(false);
      }
    }
  }

  const outroPanels: OutroCharacterPanel[] =
    outroState?.panels || outroState?.selectedPanels || [];
  const firstOutroPanel = outroPanels[0];
  const outroPosterUrl = firstOutroPanel
    ? String(firstOutroPanel.previewUrl || firstOutroPanel.imageUrl || firstOutroPanel.url || "")
    : "";
  const outroScript =
    outroState?.script ||
    outroState?.narration ||
    outroState?.text ||
    (Array.isArray(outroState?.lines) ? outroState!.lines.join(" ") : "");
  const hasOutroVideo = Boolean(
    outroState?.videoUrl &&
      (outroState.hasVideo === true || (outroState.hasVideo !== false && outroState.rendered !== false)),
  );
  const rawOutroVideoUrl = hasOutroVideo ? String(outroState!.videoUrl) : "";
  const outroRevision =
    outroCacheBust ||
    Number(outroState?.videoUpdatedAt || outroState?.updatedAt || 0) ||
    (typeof outroState?.generatedAt === "string" ? Date.parse(outroState.generatedAt) || 0 : 0);
  const outroVideoSrc = rawOutroVideoUrl
    ? `${rawOutroVideoUrl}${rawOutroVideoUrl.includes("?") ? "&" : "?"}v=${outroRevision || 1}`
    : "";
  const outroVideoDownloadHref = rawOutroVideoUrl
    ? `${rawOutroVideoUrl}${rawOutroVideoUrl.includes("?") ? "&" : "?"}download=1${outroRevision ? `&v=${outroRevision}` : ""}`
    : "";
  /** The modal prefers the freshly inspected attachment, falling back to the merge state. */
  const modalAttachment: SeriesOutroAttachment | undefined =
    (outroState?.attachment as SeriesOutroAttachment | undefined) ?? attachment;
  const modalAttached = modalAttachment
    ? modalAttachment.nextMergeIncludesOutro
    : Boolean(mergeState?.includesOutro);
  const modalTarget = modalAttachment?.targetChapter ?? attachmentTarget;
  const modalCanAttach = canAttachOutro(modalAttachment);
  const modalStatus = (() => {
    if (modalAttachment?.missing) return "The attached outro render is missing. Merge is blocked until you regenerate it or detach the attachment.";
    if (modalAttached) {
      return `Attached after ${modalTarget ?? "the last chapter"}. The compilation includes this outro once, at the end. Original chapter files stay unchanged.`;
    }
    if (modalAttachment?.explicit) return "Not attached. The compilation includes chapters only until you attach this outro.";
    return "The compilation currently includes this outro automatically. Attach it to save your choice.";
  })();

  return (
    <div className="space-y-8 [&_[role=alert]_button]:min-h-11">
      <a className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground" href="#/">
        ← Library
      </a>
      <header className="overflow-hidden rounded-[28px] bg-card">
        <div className="grid gap-0 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="aspect-[16/9] bg-muted md:aspect-auto md:min-h-64">
            {cover ? <Poster slug={series.slug} ch={cover.ch} alt="" className="size-full" eager /> : null}
          </div>
          <div className="flex flex-col justify-end gap-3 p-5 md:p-8">
            <h2 className="break-words text-3xl font-semibold leading-tight tracking-[-0.02em] md:text-4xl">{series.title}</h2>
            <p className="text-sm text-muted-foreground">
              {series.chapters.length} chapter{series.chapters.length === 1 ? "" : "s"} · {fmtLength(totalDuration(series))}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {hasFullVideo ? (
                <>
                  <a
                    className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover"
                    href={fullDownloadHref}
                    download={`${series.slug}-full.mp4`}
                  >
                    <Download className="size-4 shrink-0" aria-hidden /> Download merged video
                  </a>
                  {privileged ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={cn("min-h-11", mergeStale && "border-primary bg-primary-soft text-primary-text")}
                      disabled={merging}
                      onClick={() => void runMergeAll(true)}
                    >
                      <RefreshCw className={cn("size-3.5", merging && "animate-spin")} aria-hidden />
                      {merging ? "Merging…" : mergeStale ? "Re-merge (new chapters)" : "Re-merge"}
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button
                  type="button"
                  className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover"
                  disabled={!privileged || merging || series.chapters.length === 0}
                  onClick={() => void runMergeAll(false)}
                >
                  {merging ? (
                    <>
                      <RefreshCw className="size-4 animate-spin" aria-hidden /> Merging chapters…
                    </>
                  ) : (
                    <>
                      <Film className="size-4" aria-hidden /> Merge all chapters
                    </>
                  )}
                </Button>
              )}

              {privileged ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setExtendError("");
                      setExtendOpen(true);
                    }}
                  >
                    <Plus className="size-4" aria-hidden /> Add chapters
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={openOutroModal}
                  >
                    <Sparkles className="size-4" aria-hidden /> Create outro
                  </Button>
                  <a
                    className="inline-flex min-h-11 items-center px-2 text-sm text-primary-text underline-offset-4 hover:underline"
                    href={`/new-series.html?series=${encodeURIComponent(series.slug)}`}
                  >
                    Manage chapters
                  </a>
                </>
              ) : null}
            </div>
            {hasFullVideo && (mergedChapterCount !== undefined || mergedSize > 0) ? (
              <p className="text-xs text-muted-foreground">
                {mergedChapterCount !== undefined ? `${mergedChapterCount} chapter${mergedChapterCount === 1 ? "" : "s"} merged` : "Merged video"}
                {mergedSize > 0 ? ` · ${fmtSize(mergedSize)}` : ""}
              </p>
            ) : null}
            <div className="mt-2 rounded-2xl bg-muted p-4 text-sm" data-testid="outro-attachment-status">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">Outro</span>
                <span className={cn("font-medium", attachmentAttached ? "text-primary-text" : "text-muted-foreground")}>
                  {attachment?.videoAvailable === false ? "Not created" : attachmentAttached ? "Attached" : "Detached"}
                </span>
                <Tooltip label={attachmentLabel} side="top"><button type="button" aria-label="Outro information" className="grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
                {attachment?.stale ? (
                  <span className="rounded-full bg-warning-soft px-2 py-1 text-xs text-warning">Needs refresh</span>
                ) : null}
                {privileged && (outroRendered || hasOutroVideo || attachment?.explicit) ? (
                  attachment?.explicit && attachment.enabled ? (
                    <div className="ml-auto flex flex-wrap gap-2">
                      {canAttachOutro(attachment) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 px-3 text-xs"
                          disabled={attachingOutro}
                          onClick={() => void toggleOutroAttachment(true)}
                        >
                          {attachingOutro ? "Saving…" : "Use current outro"}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 px-3 text-xs"
                        disabled={attachingOutro}
                        onClick={() => void toggleOutroAttachment(false)}
                      >
                        Detach outro
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto min-h-11 px-3 text-xs"
                      disabled={attachingOutro || !canAttachOutro(attachment)}
                      onClick={() => void toggleOutroAttachment(true)}
                    >
                      {attachingOutro ? "Saving…" : `Use after ${attachment?.tailChapter ?? "last chapter"}`}
                    </Button>
                  )
                ) : null}
              </div>
              {attachmentError ? <ErrorNotice className="mt-3" info={requestInfo(attachmentError)} /> : null}
            </div>
          </div>
        </div>
      </header>

      {mergeError ? <ErrorNotice error={mergeError.error} onRetry={() => void runMergeAll(mergeError.force)} retrying={merging} /> : null}

      <Dialog open={extendOpen} onOpenChange={(open) => { if (!extending) setExtendOpen(open); }}>
        <DialogContent className="[&_[data-slot=dialog-close]]:size-11 [&_[role=alert]_button]:min-h-11 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">Add chapters</DialogTitle>
            <DialogDescription className="sr-only">
              Add new chapters without changing completed videos or story continuity.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submitExtend(event)} className="space-y-3">
            <label className="block text-sm">
              New chapter range
              <Input
                className="mt-1 h-11 font-mono"
                value={extendChapters}
                placeholder="21-40, 21,22,23, or all"
                disabled={extending}
                onChange={(event) => setExtendChapters(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Drive link
              <Input
                className="mt-1 h-11 font-mono"
                type="url"
                value={extendGdriveUrl}
                placeholder="https://drive.google.com/file/d/..."
                disabled={extending || Boolean(extendFile)}
                onChange={(event) => setExtendGdriveUrl(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              ZIP archive
              <Input
                ref={extendFileInput}
                className="mt-1 h-11"
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                disabled={extending || Boolean(extendGdriveUrl.trim())}
                onChange={(event) => {
                  setExtendFile(event.target.files?.[0] || null);
                  setExtendError("");
                }}
              />
            </label>
            {extendFile ? (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{extendFile.name} · {fmtSize(extendFile.size)}</span>
                <Button type="button" variant="ghost" disabled={extending} onClick={() => {
                  setExtendFile(null);
                  if (extendFileInput.current) extendFileInput.current.value = "";
                }}>
                  Remove ZIP
                </Button>
              </div>
            ) : null}
            <Tooltip label="Leave the source empty to reuse the existing archive." side="top"><button type="button" aria-label="Source information" className="grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
            {extendError ? <ErrorNotice info={requestInfo(extendError)} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={extending} onClick={() => setExtendOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={extending}>
                {extending ? extendFile ? "Uploading and queueing…" : "Queueing chapters…" : "Add chapters"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={outroOpen} onOpenChange={(open) => { if (!generatingOutro) setOutroOpen(open); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto [&_[data-slot=dialog-close]]:size-11 [&_[role=alert]_button]:min-h-11 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">Create a series outro</DialogTitle>
            <DialogDescription className="sr-only">
              Create a narrated ending using character panels from this series. Preview it before attaching it to your compilation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submitGenerateOutro(event)} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm">
                Total chapters so far
                <Input
                  type="number"
                  min={1}
                  className="mt-1 h-11 font-mono"
                  value={totalChapters}
                  onChange={(event) => setTotalChapters(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <label className="block text-sm">
                Covered chapters
                <Input
                  type="number"
                  min={1}
                  className="mt-1 h-11 font-mono"
                  value={coveredChapters}
                  onChange={(event) => setCoveredChapters(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <label className="block text-sm">
                Hook type
                <select
                  className="mt-1 h-11 w-full rounded-lg border border-border-strong bg-background px-3 text-sm text-foreground"
                  value={hookType}
                  onChange={(event) => setHookType(event.target.value as OutroHookType)}
                >
                  <option value="part2">Invite viewers to part 2</option>
                  <option value="next_chapter">Tease the next chapter</option>
                  <option value="new_series">Recommend a new series</option>
                  <option value="custom">Custom instruction</option>
                </select>
              </label>
            </div>
            {hookType === "custom" ? (
              <label className="block text-sm">
                Custom outro instruction
                <Input
                  className="mt-1 h-11"
                  value={customPrompt}
                  placeholder="Ask viewers what they think of the protagonist's choice and comment for Part 2"
                  onChange={(event) => setCustomPrompt(event.target.value)}
                />
              </label>
            ) : null}

            {outroVideoSrc ? (
              <div className="rounded-xl bg-background p-3" data-testid="outro-video-section">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[13px] font-medium text-muted-foreground">Outro preview</p>
                  <a
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13.5px] font-medium text-primary-foreground hover:bg-primary-hover"
                    href={outroVideoDownloadHref}
                    download={`${series.slug}-outro.mp4`}
                  >
                    <Download className="size-3.5" aria-hidden /> Download outro
                  </a>
                </div>
                <video
                  key={outroVideoSrc}
                  src={outroVideoSrc}
                  poster={outroPosterUrl || undefined}
                  controls
                  playsInline
                  preload="metadata"
                  className="mt-2 aspect-video w-full rounded-lg bg-black"
                />
              </div>
            ) : null}

            {outroScript ? (
              <div className="rounded-xl bg-background p-3">
                <p className="text-[13px] font-medium text-muted-foreground">Narrator script</p>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground">{outroScript}</p>
              </div>
            ) : null}

            {outroPanels.length > 0 ? (
              <div className="rounded-xl bg-background p-3">
                <p className="text-[13px] font-medium text-muted-foreground">
                  Selected character panels ({outroPanels.length})
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {outroPanels.map((panel, idx) => {
                    const imgSrc = String(panel.previewUrl || panel.imageUrl || panel.url || "");
                    const chLabel = panel.chapter || panel.ch || "";
                    const idLabel = String(panel.panelFile || panel.panelId || panel.id || `panel-${idx + 1}`);
                    const characters = panel.characterNames || panel.characters || (panel.character ? [panel.character] : []);
                    const characterNames = Array.isArray(characters)
                      ? characters.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
                      : [];
                    const charLabel = characterNames.join(", ") || "Character";
                    const reason = panel.reason || panel.caption || panel.visual;
                    return (
                      <div key={`${chLabel}-${idLabel}-${idx}`} className="rounded-xl bg-muted p-2">
                        {imgSrc ? (
                          <img src={imgSrc} alt={charLabel} className="mb-1.5 aspect-[4/3] w-full rounded object-cover bg-black" loading="lazy" />
                        ) : null}
                        <div className="flex flex-wrap gap-1">
                          {(characterNames.length ? characterNames : ["Character"]).map((name, index) => (
                            <span key={`${name}-${index}`} className="rounded-full border border-border-strong px-1.5 py-0.5 text-[12px] text-foreground">{name}</span>
                          ))}
                        </div>
                        <p className="break-all font-mono text-[12px] text-muted-foreground">
                          {chLabel} · {idLabel}{panel.shotType ? ` · ${panel.shotType}` : ""}{panel.weight ? ` · w${panel.weight}` : ""}
                        </p>
                        {reason ? (
                          <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{reason}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {hasOutroVideo || modalAttachment?.explicit ? (
              <div className="rounded-xl bg-background p-3" data-testid="outro-attach-panel">
                <div className="flex items-center gap-2"><p className="text-sm font-medium">Compilation outro</p><Tooltip label={modalStatus} side="top"><button type="button" aria-label="Attachment information" className="grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip></div>
                {privileged ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover"
                      disabled={attachingOutro || !modalCanAttach}
                      onClick={() => void toggleOutroAttachment(true)}
                    >
                      {attachingOutro
                        ? "Saving…"
                        : modalAttachment?.explicit && modalAttachment.enabled
                          ? "Use current outro"
                          : `Use after ${modalAttachment?.tailChapter ?? series.chapters[series.chapters.length - 1]?.ch ?? "last chapter"}`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11"
                      disabled={attachingOutro || !modalAttached}
                      onClick={() => void toggleOutroAttachment(false)}
                    >
                      Detach outro
                    </Button>
                  </div>
                ) : null}
                {attachmentError ? <ErrorNotice className="mt-3" info={requestInfo(attachmentError)} /> : null}
              </div>
            ) : null}

            {outroError ? <ErrorNotice info={requestInfo(outroError)} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={generatingOutro} onClick={() => setOutroOpen(false)}>
                Close
              </Button>
              <Button type="submit" className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-hover" disabled={generatingOutro}>
                {generatingOutro ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" aria-hidden /> Generating outro…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" aria-hidden /> Generate outro
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {series.full ? (
        <article className="sr-group flex flex-wrap items-center justify-between gap-4 p-4 md:p-5">
          <div>
            <p className="text-[13px] font-medium text-muted-foreground">Full compilation</p>
            <h3 className="mt-1 text-2xl font-semibold tracking-[-0.015em]">full.mp4</h3>
            <p className="text-sm text-muted-foreground">{fmtTime(series.full.duration)} · {fmtSize(series.full.size)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover" href={watchHref(series.slug, "full")}>
              <Play className="size-4" aria-hidden /> Play
            </a>
            <a className="inline-flex min-h-11 items-center gap-2 rounded-full bg-background px-4 text-sm hover:bg-raised" href={`${series.full.url}?download=1`} download={`${series.slug}-full.mp4`}>
              <Download className="size-4" aria-hidden /> Download
            </a>
          </div>
        </article>
      ) : null}

      <LanguageVersions
        slug={series.slug}
        title={series.title}
        privileged={privileged}
        onToast={onToast}
      />
      <SeriesSettingsEditor slug={series.slug} privileged={privileged} />
      <MoviePlanPanel slug={series.slug} />

      <section aria-label="Chapters">
        <h3 className="mb-3 text-2xl font-semibold tracking-[-0.015em]">Chapters</h3>
        {chapters.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">No chapters match that search.</p>
        ) : (
          <ol className="sr-group overflow-hidden">
            {chapters.map((chapter) => {
              const pos = getPos(series.slug, chapter.ch);
              const pct = progressPct(series.slug, chapter);
              const done = isDone(series.slug, chapter.ch);
              return (
                <li key={chapter.ch} className="sr-row flex items-stretch">
                  <a
                    href={watchHref(series.slug, chapter.ch)}
                    className="flex min-w-0 flex-1 items-center gap-4 px-4 py-4 hover:bg-raised"
                    aria-label={`Play chapter ${chapter.num}`}
                  >
                    <span className="relative block h-16 w-11 shrink-0 overflow-hidden rounded-md bg-background">
                      <Poster slug={series.slug} ch={chapter.ch} alt="" className="size-full" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">Chapter {String(chapter.num).padStart(2, "0")}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {fmtTime(chapter.duration)} · {fmtSize(chapter.size)}
                        {done ? " · Watched" : pos > 5 ? ` · ${fmtTime(pos)} watched` : ""}
                      </span>
                      <span className="mt-2 block max-w-xs">
                        <ProgressTrack pct={pct} label={`Chapter ${chapter.num} saved progress`} />
                      </span>
                    </span>
                  </a>
                  {privileged ? (
                    <Tooltip label="Delete video" side="top"><button
                      type="button"
                      className="grid min-w-11 place-items-center px-3 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete chapter ${chapter.num} video`}
                      onClick={() =>
                        onDelete({
                          slug: series.slug,
                          ch: chapter.ch,
                          title: series.title,
                          num: chapter.num,
                          size: chapter.size,
                          arms: cutsOf(chapter).length - 1,
                        })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button></Tooltip>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function WatchView({
  series,
  ch,
  privileged,
  blocked,
  onDelete,
}: {
  series: LibrarySeries;
  ch: string;
  privileged: boolean;
  blocked: boolean;
  onDelete: (subject: DeleteSubject) => void;
}) {
  const isFull = ch === "full";
  const index = series.chapters.findIndex((item) => item.ch === ch);
  const chapter = index >= 0 ? series.chapters[index] : undefined;
  const full = isFull ? series.full : undefined;
  const videoRef = useRef<HTMLVideoElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const endCardRef = useRef<HTMLDivElement>(null);
  const saved = getPos(series.slug, ch);
  const [showResume, setShowResume] = useState(saved > 5);
  const [ended, setEnded] = useState(false);
  const [rate, setRate] = useState(readRate);
  const [cutIndex, setCutIndex] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  const cuts = chapter ? cutsOf(chapter) : [];
  const active: Cut | null = full
    ? { name: "full.mp4", url: full.url, size: full.size, duration: full.duration }
    : cuts[cutIndex] ?? null;
  const next = !isFull && index >= 0 ? series.chapters[index + 1] : undefined;
  const prev = !isFull && index > 0 ? series.chapters[index - 1] : undefined;

  useEffect(() => {
    if (blocked || ended) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      // Buttons and fields keep their own keys. The video element does not:
      // capture + stopPropagation so Space does not toggle twice when it has focus.
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      const video = videoRef.current;
      if (!video) return;
      const key = event.key;
      const known = key === " " || key === "k" || key === "K" || key === "ArrowLeft" || key === "ArrowRight" || key === "f" || key === "F" || key === "m" || key === "M";
      if (!known) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === " " || key === "k" || key === "K") {
        if (video.paused || video.ended) void video.play().catch(() => {});
        else video.pause();
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        if (!Number.isFinite(video.duration)) return;
        const delta = key === "ArrowLeft" ? -5 : 5;
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
      } else if (key === "f" || key === "F") {
        void toggleFullscreen(video);
      } else if (key === "m" || key === "M") {
        video.muted = !video.muted;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [blocked, ended]);

  useEffect(() => {
    if (!ended) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEnded(false);
      videoRef.current?.focus();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [ended]);

  useEffect(() => {
    if (!ended) return;
    (nextRef.current ?? endCardRef.current)?.focus();
  }, [ended]);

  function onEndCardKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEnded(false);
      videoRef.current?.focus();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep Tab inside the end card while the dialog is open.
    const actions = endCardRef.current?.querySelectorAll<HTMLElement>(
      "a[href], button:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (!actions || actions.length === 0) return;
    const first = actions[0]!;
    const last = actions[actions.length - 1]!;
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !endCardRef.current?.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !endCardRef.current?.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const save = () => {
      if (video.ended || !video.currentTime || video.seeking) return;
      if (cutIndex !== 0 && !isFull) return;
      setPos(series.slug, ch, video.currentTime);
    };
    const onHide = () => {
      if (document.hidden) save();
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [series.slug, ch, cutIndex, isFull, active?.url]);

  function applyRate(nextRate: (typeof RATES)[number]) {
    setRate(nextRate);
    storage.set(RATE_KEY, nextRate);
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  }

  function onLoaded() {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackError(false);
    if (!showResume) void video.play().catch(() => {});
  }

  function onTime() {
    const video = videoRef.current;
    if (!video || video.seeking || video.ended) return;
    if (cutIndex !== 0 && !isFull) return;
    const previous = getPos(series.slug, ch);
    if (Math.abs(video.currentTime - previous) > 2) setPos(series.slug, ch, video.currentTime);
  }

  function onEnded() {
    if (cutIndex === 0 || isFull) {
      storage.set(doneKey(series.slug, ch), "1");
      storage.remove(posKey(series.slug, ch));
    }
    setEnded(true);
  }

  function resume() {
    const video = videoRef.current;
    setShowResume(false);
    if (!video) return;
    const seek = () => {
      const cap = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : saved;
      video.currentTime = Math.min(saved, cap);
      void video.play().catch(() => {});
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }

  function restart() {
    const video = videoRef.current;
    setShowResume(false);
    storage.remove(posKey(series.slug, ch));
    storage.remove(doneKey(series.slug, ch));
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => {});
  }

  if (!active || (!chapter && !full)) {
    return (
      <Missing title="This chapter isn’t ready yet.">
        <a className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-[14.5px] font-medium text-primary-foreground hover:bg-primary-hover" href={seriesHref(series.slug)}>
          Back to series
        </a>
      </Missing>
    );
  }

  const heading = isFull ? "Full compilation" : `Chapter ${String(chapter?.num ?? 0).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground" href={seriesHref(series.slug)}>
          ← {series.title}
        </a>
        <p className="text-xs text-muted-foreground">{isFull ? "full.mp4" : `${index + 1} of ${series.chapters.length}`}</p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <h2 className="mb-3 break-words text-3xl font-semibold tracking-[-0.02em]">{heading}</h2>
          {showResume ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3" role="region" aria-label="Resume playback">
              <p className="text-sm">Left off at <strong className="font-medium">{fmtTime(saved)}</strong>.</p>
              <div className="flex gap-2">
                <Button type="button" className="min-h-11" onClick={resume}>Resume</Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={restart}>Start over</Button>
              </div>
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-border">
            <video
              key={active.url}
              ref={videoRef}
              className="aspect-video w-full"
              controls
              playsInline
              preload="metadata"
              inert={ended ? true : undefined}
              poster={chapter ? posterUrl(series.slug, chapter.ch) : undefined}
              src={active.url}
              aria-label={`${series.title}, ${heading}`}
              aria-describedby="player-keys"
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTime}
              onPause={onTime}
              onEnded={onEnded}
              onError={() => setPlaybackError(true)}
              onPlay={() => {
                setEnded(false);
                if (cutIndex === 0 || isFull) storage.remove(doneKey(series.slug, ch));
              }}
            />
            {ended ? (
              <div
                ref={endCardRef}
                tabIndex={-1}
                className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-3 text-center text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white sm:p-6"
                role="dialog"
                aria-modal="true"
                aria-live="polite"
                aria-labelledby="endcard-title"
                onKeyDown={onEndCardKey}
              >
                <div>
                  <p id="endcard-title" className="text-xl font-semibold tracking-[-0.02em] sm:text-3xl">
                    {next ? `Up next: Chapter ${next.num}` : "That’s a wrap."}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {next ? (
                      <button
                        ref={nextRef}
                        type="button"
                        autoFocus
                        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-4 text-[14.5px] font-medium text-black hover:bg-white/85"
                        onClick={() => {
                          window.location.hash = watchHref(series.slug, next.ch);
                        }}
                      >
                        <Play className="size-4" aria-hidden /> Play next chapter
                      </button>
                    ) : (
                      <a className="inline-flex min-h-11 items-center rounded-full bg-white px-4 text-[14.5px] font-medium text-black hover:bg-white/85" href={seriesHref(series.slug)}>
                        Back to series
                      </a>
                    )}
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center rounded-full bg-white/15 px-4 text-[14.5px] font-medium text-white hover:bg-white/25"
                      onClick={() => {
                        setEnded(false);
                        const video = videoRef.current;
                        if (!video) return;
                        video.currentTime = 0;
                        void video.play().catch(() => {});
                      }}
                    >
                      Watch again
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          {playbackError ? (
            <Notice className="mt-3" tone="danger" title="Video unavailable" details={<RawDetails text="Retry, or download the video to watch it locally." />}>
              <button
                type="button"
                className="mt-2 inline-flex min-h-11 items-center rounded-full bg-background px-4 font-medium"
                onClick={() => {
                  setPlaybackError(false);
                  const video = videoRef.current;
                  if (!video) return;
                  video.load();
                  void video.play().catch(() => {});
                }}
              >
                Retry
              </button>
            </Notice>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm">{active.name}</p>
              <p className="text-xs text-muted-foreground">{fmtTime(active.duration)} · {fmtSize(active.size)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex min-h-11 items-center gap-2 rounded-full bg-card px-4 text-sm hover:bg-muted" href={`${active.url}?download=1`} download>
                <Download className="size-4" aria-hidden /> Download
              </a>
              {privileged && chapter ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11"
                  onClick={() =>
                    onDelete({
                      slug: series.slug,
                      ch: chapter.ch,
                      title: series.title,
                      num: chapter.num,
                      size: chapter.size,
                      arms: cuts.length - 1,
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden /> Delete video
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Playback speed">
            {RATES.map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  "min-h-11 min-w-11 rounded-full px-3 text-sm",
                  item === rate ? "bg-primary-soft text-primary-text" : "bg-card text-muted-foreground hover:bg-muted",
                )}
                aria-pressed={item === rate}
                onClick={() => applyRate(item)}
              >
                {item}×
              </button>
            ))}
          </div>
          {cuts.length > 1 ? (
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Video cuts">
              {cuts.map((cut, index) => (
                <button
                  key={cut.url}
                  type="button"
                  className={cn("min-h-11 rounded-full px-4 text-sm", index === cutIndex ? "bg-primary-soft text-primary-text" : "bg-card text-muted-foreground")}
                  aria-pressed={index === cutIndex}
                  onClick={() => {
                    setCutIndex(index);
                    setEnded(false);
                  }}
                >
                  {cut.name}
                </button>
              ))}
            </div>
          ) : null}
          <details className="mt-3 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">Shortcuts</summary><p id="player-keys">
            <kbd className="rounded border border-border-strong px-1 font-mono">Space</kbd>{" "}
            <kbd className="rounded border border-border-strong px-1 font-mono">K</kbd> play/pause ·{" "}
            <kbd className="rounded border border-border-strong px-1 font-mono">←</kbd>{" "}
            <kbd className="rounded border border-border-strong px-1 font-mono">→</kbd> seek 5s ·{" "}
            <kbd className="rounded border border-border-strong px-1 font-mono">F</kbd> fullscreen ·{" "}
            <kbd className="rounded border border-border-strong px-1 font-mono">M</kbd> mute
          </p></details>
          <div className="mt-4 flex justify-between gap-2">
            {prev ? (
              <a className="inline-flex min-h-11 items-center text-sm" href={watchHref(series.slug, prev.ch)}>← Chapter {prev.num}</a>
            ) : <span />}
            {next ? (
              <a className="inline-flex min-h-11 items-center text-sm" href={watchHref(series.slug, next.ch)}>Chapter {next.num} →</a>
            ) : null}
          </div>
        </div>
        {!isFull ? (
          <aside className="sr-group p-3" aria-label="Chapters">
            <h3 className="px-2 py-1 text-xl font-semibold tracking-[-0.01em]">Chapters</h3>
            <nav className="max-h-[70vh] overflow-y-auto" aria-label={`Chapters in ${series.title}`}>
              {series.chapters.map((item) => {
                const current = item.ch === ch;
                return (
                  <a
                    key={item.ch}
                    id={current ? "chapter-current" : undefined}
                    href={watchHref(series.slug, item.ch)}
                    aria-current={current ? "true" : undefined}
                    className={cn("flex items-center gap-2 rounded-lg px-2 py-2 text-sm", current ? "bg-primary-soft" : "hover:bg-muted")}
                  >
                    <span className="w-8 text-sm text-muted-foreground">{String(item.num).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{current ? "Now playing" : `Chapter ${item.num}`}</span>
                      <span className="block text-xs text-muted-foreground">{fmtTime(item.duration)}</span>
                    </span>
                  </a>
                );
              })}
            </nav>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function ArtworkView({
  library,
  query,
  onOpen,
}: {
  library: LibrarySnapshot;
  query: string;
  onOpen: (thumb: { name: string; url: string; size: number }) => void;
}) {
  const q = query.trim().toLowerCase();
  const thumbs = (library.thumbnails || []).filter((thumb) => !q || artworkLabel(thumb.name).toLowerCase().includes(q) || thumb.name.toLowerCase().includes(q));
  if (!library.thumbnails.length) {
    return (
      <EmptyState title="A blank canvas, for now." text="Generated thumbnails will find their home here.">
        <a className="inline-flex min-h-11 items-center rounded-full bg-card px-4 text-[14.5px] font-medium hover:bg-muted" href="#/">Back to library</a>
      </EmptyState>
    );
  }
  return (
    <section aria-label="Artwork">
      <div className="mb-4">
        <h2 className="text-3xl font-semibold tracking-[-0.02em]">Artwork</h2>
      </div>
      {q ? <p className="mb-3 text-sm text-muted-foreground" role="status">{thumbs.length} artwork{thumbs.length === 1 ? "" : "s"} matching “{query.trim()}”</p> : null}
      {thumbs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No artwork matches that search.</p>
      ) : (
        <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
          {thumbs.map((thumb) => {
            const label = artworkLabel(thumb.name);
            const url = thumbUrl(thumb.name, thumb.url);
            return (
              <article key={thumb.name} className="mb-4 break-inside-avoid overflow-hidden rounded-[22px] bg-card">
                <button type="button" className="block w-full overflow-hidden rounded-[22px] bg-muted text-left" onClick={() => onOpen({ name: thumb.name, url, size: thumb.size })} aria-label={`Preview ${label}`}>
                  <img src={url} alt={label} className="w-full" loading="lazy" decoding="async" />
                </button>
                <div className="flex items-start justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{label}</p>
                    <p className="text-xs text-muted-foreground">{thumb.name.split(".").pop()?.toUpperCase()} · {fmtSize(thumb.size)}</p>
                  </div>
                  <Tooltip label="Download" side="top"><a className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-foreground" href={`${url}?download=1`} download={thumb.name} aria-label={`Download ${label}`}>
                    <Download className="size-4" aria-hidden />
                  </a></Tooltip>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DeleteChapterDialog({
  subject,
  onOpenChange,
  onDeleted,
}: {
  subject: DeleteSubject | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (subject: DeleteSubject, message: string) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | ErrorInfo>("");
  const [busy, setBusy] = useState(false);
  const expected = subject ? `${subject.slug}/${subject.ch}` : "";
  const ready = confirm.trim().toLowerCase() === expected.toLowerCase() && expected.length > 0;

  useEffect(() => {
    setConfirm("");
    setError("");
    setBusy(false);
  }, [subject?.slug, subject?.ch]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!subject || !ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.deleteChapter({ slug: subject.slug, chapter: subject.ch, confirm: expected });
      onDeleted(subject, result.message);
    } catch (err) {
      setError(describeError(err, "Could not delete this video."));
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(subject)} onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
      <DialogContent className="[&_[data-slot=dialog-close]]:size-11 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">Delete this rendered video?</DialogTitle>
          <DialogDescription>
            Source files stay unchanged.
          </DialogDescription>
        </DialogHeader>
        {subject ? (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-3 [&_[role=alert]_button]:min-h-11">
            <p className="text-sm">
              <strong>{subject.title}</strong> — Chapter {subject.num}
              <span className="mt-1 block font-mono text-xs text-muted-foreground">{expected}</span>
              {subject.size ? <span className="mt-1 block text-xs text-muted-foreground">Rendered file · {fmtSize(subject.size)}</span> : null}
              {subject.arms ? <span className="mt-1 block text-xs text-muted-foreground">{subject.arms} alternate cut{subject.arms === 1 ? "" : "s"} stay on disk.</span> : null}
            </p>
            <label className="block text-sm">
              Type <code className="font-mono text-xs">{expected}</code> to confirm
              <Input
                className="mt-1 h-11 font-mono"
                value={confirm}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-invalid={confirm.length > 0 && !ready}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            {error ? <ErrorNotice info={requestInfo(error)} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => onOpenChange(false)}>
                Keep it
              </Button>
              <Button type="submit" variant="destructive" className="min-h-11" disabled={!ready || busy}>
                {busy ? "Deleting…" : "Delete video"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-[24px] bg-card px-6 py-10 text-center">
      <h2 className="text-2xl font-semibold leading-tight tracking-[-0.015em]">{title}</h2>
      {text ? <Tooltip label={text} side="top"><button type="button" aria-label="More information" className="mx-auto mt-2 grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip> : null}
      {children ? <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

function Missing({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <EmptyState title={title} text="Head back to the library to see what’s available.">
      {children}
      <a className="inline-flex min-h-11 items-center rounded-full bg-card px-4 text-[14.5px] font-medium hover:bg-muted" href="#/">
        Back to library
      </a>
    </EmptyState>
  );
}
