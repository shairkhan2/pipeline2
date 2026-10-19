import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Download, Film, HardDrive, Play, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { StorageTrashDrawer } from "@/components/shared/StorageTrashDrawer";
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
  isApiError,
  type LibraryChapter,
  type LibrarySeries,
  type LibrarySnapshot,
  type OutroCharacterPanel,
  type OutroHookType,
  type SeriesMergeState,
  type SeriesOutroState,
} from "@/lib/api";
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

function errText(error: unknown, fallback: string): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
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
      <span className={cn("grid place-items-center bg-[#202125] font-serif text-3xl text-[#a2a19f]", className)} aria-hidden>
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
      className="block h-1 overflow-hidden rounded-full bg-[#2b2c30]"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <span className="block h-full bg-[#f18b6e]" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

export function LibraryPage() {
  const [route, setRoute] = useState<LibraryRoute>(() => parseHash(window.location.hash || "#/"));
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
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
      setLoadError(errText(error, "Couldn’t load the library."));
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
        if (!stop) setLoadError(errText(error, "Couldn’t load the library."));
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
      <EmptyState title="We lost the connection." text={loadError}>
        <Button type="button" className="min-h-11" onClick={() => void refresh(true)}>
          <RefreshCw className="size-4" aria-hidden /> Try again
        </Button>
      </EmptyState>
    );
  } else if (!library) {
    body = (
      <div className="py-16" aria-busy="true">
        <p className="font-serif text-3xl">Setting the scene…</p>
        <p className="mt-2 text-sm text-[#a2a19f]">Loading your collection.</p>
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
        title="The screen is ready. Your stories are on their way."
        text="Finished chapters appear here automatically. Start a series, or open the studio to connect a provider."
      >
        <a className="inline-flex min-h-11 items-center rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]" href="/new-series.html">
          New series
        </a>
        <a className="inline-flex min-h-11 items-center rounded-lg border border-[#3c3e44] px-3 text-sm" href="/studio.html">
          Studio
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
          <div className="flex items-center gap-2">
            <label className="relative block">
              <span className="sr-only">{route.view === "artwork" ? "Search artwork" : "Search series or chapter"}</span>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[#a2a19f]" aria-hidden />
              <Input
                id="library-search"
                type="search"
                value={query}
                placeholder={route.view === "artwork" ? "Search artwork" : "Search series or chapter"}
                aria-label={route.view === "artwork" ? "Search artwork" : "Search series or chapter"}
                autoComplete="off"
                spellCheck={false}
                className="h-11 w-[min(280px,46vw)] pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-label="Storage & Trash"
              onClick={() => setStorageOpen(true)}
            >
              <HardDrive className="size-4" aria-hidden />
              <span className="hidden sm:inline">Storage &amp; Trash</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-label="Refresh library"
              disabled={refreshing}
              onClick={() => void refresh(true)}
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
            </Button>
          </div>
        ) : null
      }
    >
      {warning ? (
        <p className="mb-4 rounded-xl border border-[#3c3e44] bg-[#191a1d] px-4 py-3 text-sm text-[#d6b57b]" role="status">
          {warning}
        </p>
      ) : null}
      {body}
      <p className="sr-only" role="status" aria-live="polite">{toast}</p>
      {toast ? (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#f2efe9] px-4 py-2 text-sm text-[#201713] shadow-lg md:bottom-6" role="status">
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
        <DialogContent className="sm:max-w-3xl" aria-describedby={undefined}>
          {light ? (
            <>
              <DialogHeader>
                <DialogTitle className="font-serif text-2xl">{artworkLabel(light.name)}</DialogTitle>
                <DialogDescription>{light.name} · {fmtSize(light.size)}</DialogDescription>
              </DialogHeader>
              <img src={light.url} alt={artworkLabel(light.name)} className="max-h-[70vh] w-full rounded-lg object-contain bg-black" />
              <DialogFooter>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]" href={`${light.url}?download=1`} download={light.name}>
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
    <div className="space-y-8">
      {resume.length ? (
        <section aria-label="Continue watching">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-2xl">Continue watching</h2>
            <p className="text-xs tracking-[0.14em] text-[#a2a19f] uppercase">{resume.length} in progress</p>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
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
                  <span className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-[#191a1d]">
                    <Poster slug={item.series.slug} ch={item.chapter.ch} alt="" className="size-full" />
                    <span className="absolute inset-x-2 bottom-2">
                      <ProgressTrack pct={pct} label="Saved progress" />
                    </span>
                  </span>
                  <span className="mt-2 block truncate text-sm">{item.series.title}</span>
                  <span className="block text-xs text-[#a2a19f]">Chapter {item.chapter.num} · {left} left</span>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-label="Series">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-2xl">Series</h2>
            <p className="text-sm text-[#a2a19f]">{total} in the library</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-[#a2a19f]">
            Sort
            <select
              aria-label="Sort library"
              className="h-11 rounded-lg border border-[#3c3e44] bg-[#191a1d] px-2 text-[#f2efe9]"
              value={sort}
              onChange={(event) => onSort(event.target.value)}
            >
              <option value="latest">Recently added</option>
              <option value="title">Title A–Z</option>
            </select>
          </label>
        </div>
        {query ? (
          <p className="mb-3 text-sm text-[#a2a19f]" role="status">
            {series.length} series matching “{query.trim()}”
          </p>
        ) : null}
        {series.length === 0 ? (
          <EmptyState title="No stories found" text="Try a series title or a chapter number, like “chapter 12”.">
            <Button type="button" variant="outline" className="min-h-11" onClick={onClear}>Clear search</Button>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {series.map((item) => {
              const cover = coverChapter(item);
              return (
                <a
                  key={item.slug}
                  href={seriesHref(item.slug)}
                  className="group block min-w-0"
                  aria-label={`${item.title}, ${item.chapters.length} chapters`}
                >
                  <span className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-[#191a1d] ring-1 ring-[#2b2c30]">
                    {cover ? <Poster slug={item.slug} ch={cover.ch} alt="" className="size-full transition duration-300 group-hover:scale-[1.03]" /> : null}
                    <span className="absolute top-2 right-2 rounded-full bg-black/70 px-2 py-0.5 font-mono text-[10px] tracking-wide text-[#f2efe9]">
                      {item.chapters.length} ch
                    </span>
                  </span>
                  <span className="mt-2 block truncate text-sm font-medium">{item.title}</span>
                  <span className="block text-xs text-[#a2a19f]">{fmtLength(totalDuration(item))}</span>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
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

  const [extendOpen, setExtendOpen] = useState(false);
  const [extendChapters, setExtendChapters] = useState(() => {
    const maxCh = Math.max(0, ...series.chapters.map((c) => c.num || 0));
    return maxCh > 0 ? `${maxCh + 1}-${maxCh + 20}` : "21-40";
  });
  const [extendGdriveUrl, setExtendGdriveUrl] = useState("");
  const [extendFile, setExtendFile] = useState<File | null>(null);
  const extendFileInput = useRef<HTMLInputElement>(null);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState("");

  const [outroOpen, setOutroOpen] = useState(false);
  const [outroState, setOutroState] = useState<SeriesOutroState | null>(null);
  const [totalChapters, setTotalChapters] = useState(50);
  const [coveredChapters, setCoveredChapters] = useState(() => Math.max(1, series.chapters.length || 20));
  const [hookType, setHookType] = useState<OutroHookType>("part2");
  const [customPrompt, setCustomPrompt] = useState("");
  const [generatingOutro, setGeneratingOutro] = useState(false);
  const [outroError, setOutroError] = useState("");

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

  async function runMergeAll(force = false) {
    if (!privileged || merging) return;
    setMerging(true);
    try {
      const res = await api.series.mergeAll(series.slug, { includeOutro: true, force });
      setMergeState({ ...res, exists: true, merged: true });
      onToast(res.message || "Merged all chapters into full.mp4.");
      onRefresh();
    } catch (error) {
      onToast(errText(error, "Could not merge chapters."));
    } finally {
      setMerging(false);
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
      await api.series.getMerge(series.slug).then(setMergeState).catch(() => {});
      setExtendFile(null);
      if (extendFileInput.current) extendFileInput.current.value = "";
      setExtendOpen(false);
      onToast(res.message || `Extended ${series.title} (${spec}) without rerunning completed chapters.`);
      onRefresh();
    } catch (error) {
      setExtendError(errText(error, "Could not extend series."));
    } finally {
      setExtending(false);
    }
  }

  function openOutroModal() {
    setOutroOpen(true);
    setOutroError("");
    void api.series
      .getOutro(series.slug)
      .then((res) => {
        setOutroState(res);
        if (typeof res.totalChapters === "number" && res.totalChapters > 0) setTotalChapters(res.totalChapters);
        if (typeof res.coveredChapters === "number" && res.coveredChapters > 0) setCoveredChapters(res.coveredChapters);
        if (res.hookType) setHookType(res.hookType);
      })
      .catch(() => {});
  }

  async function submitGenerateOutro(event: FormEvent) {
    event.preventDefault();
    if (!privileged || generatingOutro) return;
    setGeneratingOutro(true);
    setOutroError("");
    try {
      const res = await api.series.generateOutro(series.slug, {
        enabled: true,
        totalChapters,
        coveredChapters,
        hookType,
        customPrompt: customPrompt.trim() || undefined,
        renderVideo: true,
      });
      setOutroState(res);
      const warnings = [
        res.renderError ? `Video render warning: ${String(res.renderError)}` : "",
        res.audioError ? `Audio warning: ${String(res.audioError)}` : "",
      ].filter(Boolean);
      if (warnings.length) {
        setOutroError(`Outro generated with warnings. ${warnings.join(" ")}`);
        onToast("Outro generated with warnings. See the dialog for details.");
      } else {
        onToast("Generated character-panel outro announcement.");
      }
      await api.series.getMerge(series.slug).then(setMergeState).catch(() => {});
      onRefresh();
    } catch (error) {
      setOutroError(errText(error, "Could not generate outro announcement."));
    } finally {
      setGeneratingOutro(false);
    }
  }

  const outroPanels: OutroCharacterPanel[] =
    outroState?.panels || outroState?.selectedPanels || [];
  const outroScript =
    outroState?.script ||
    outroState?.narration ||
    outroState?.text ||
    (Array.isArray(outroState?.lines) ? outroState!.lines.join(" ") : "");

  return (
    <div className="space-y-8">
      <a className="inline-flex min-h-11 items-center text-sm text-[#a2a19f] hover:text-[#f2efe9]" href="#/">
        ← Library
      </a>
      <header className="overflow-hidden rounded-2xl border border-[#2b2c30] bg-[#191a1d]">
        <div className="grid gap-0 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="aspect-[2/3] bg-[#101113] md:aspect-auto md:min-h-64">
            {cover ? <Poster slug={series.slug} ch={cover.ch} alt="" className="size-full" eager /> : null}
          </div>
          <div className="flex flex-col justify-end gap-3 p-5 md:p-8">
            <p className="text-[10px] tracking-[0.18em] text-[#a2a19f] uppercase">Series</p>
            <h2 className="font-serif text-4xl leading-none">{series.title}</h2>
            <p className="text-sm text-[#a2a19f]">
              {series.chapters.length} chapter{series.chapters.length === 1 ? "" : "s"} · {fmtLength(totalDuration(series))}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {hasFullVideo ? (
                <>
                  <a
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]"
                    href={fullDownloadHref}
                    download={`${series.slug}-full.mp4`}
                  >
                    <Download className="size-4" aria-hidden /> Download Merged Video (full.mp4)
                  </a>
                  {privileged ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={cn("min-h-11", mergeStale && "border-[#f18b6e] bg-[#f18b6e]/10 text-[#f18b6e]")}
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
                  className="min-h-11 bg-[#f18b6e] text-[#201713] hover:bg-[#f5a087]"
                  disabled={!privileged || merging || series.chapters.length === 0}
                  onClick={() => void runMergeAll(false)}
                >
                  {merging ? (
                    <>
                      <RefreshCw className="size-4 animate-spin" aria-hidden /> Merging chapters…
                    </>
                  ) : (
                    <>
                      <Film className="size-4" aria-hidden /> Merge All Chapters
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
                    <Plus className="size-4" aria-hidden /> + Add Chapters
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={openOutroModal}
                  >
                    <Sparkles className="size-4" aria-hidden /> Outro Announcement
                  </Button>
                  <a
                    className="inline-flex min-h-11 items-center px-2 text-sm text-[#f18b6e] underline-offset-4 hover:underline"
                    href={`/new-series.html?series=${encodeURIComponent(series.slug)}`}
                  >
                    Manage chapters
                  </a>
                </>
              ) : null}
            </div>
            {hasFullVideo && (mergedChapterCount !== undefined || mergedSize > 0) ? (
              <p className="text-xs text-[#a2a19f]">
                {mergedChapterCount !== undefined ? `${mergedChapterCount} chapter${mergedChapterCount === 1 ? "" : "s"} merged` : "Merged video"}
                {mergedSize > 0 ? ` · ${fmtSize(mergedSize)}` : ""}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <Dialog open={extendOpen} onOpenChange={(open) => { if (!extending) setExtendOpen(open); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Extend Series (+ Add Chapters)</DialogTitle>
            <DialogDescription>
              Preserves <code>bible.json</code>, continuity windows, and already-completed chapters ({series.chapters.map((c) => c.ch).join(", ") || "none"}), running only the new chapters.
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
              Optional Google Drive ZIP URL (leave empty to reuse existing series source)
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
              Optional ZIP archive of new chapters
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
              <div className="flex items-center justify-between gap-2 text-xs text-[#a2a19f]">
                <span className="min-w-0 truncate">{extendFile.name} · {fmtSize(extendFile.size)}</span>
                <Button type="button" variant="ghost" disabled={extending} onClick={() => {
                  setExtendFile(null);
                  if (extendFileInput.current) extendFileInput.current.value = "";
                }}>
                  Remove ZIP
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-[#a2a19f]">Use either a ZIP upload or a Drive URL. Leave the range empty to include all new source chapters.</p>
            {extendError ? <p className="text-sm text-[#ef6b5b]" role="alert">{extendError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={extending} onClick={() => setExtendOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={extending}>
                {extending ? extendFile ? "Uploading and queueing…" : "Queueing extension…" : "Extend Series"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={outroOpen} onOpenChange={(open) => { if (!generatingOutro) setOutroOpen(open); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Series Outro Announcement Builder</DialogTitle>
            <DialogDescription>
              Selects the best character-focused panels from <code>bible.json</code> and <code>obs_ch*.json</code> and synthesizes a natural narrator outro.
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
                  className="mt-1 h-11 w-full rounded-lg border border-[#3c3e44] bg-[#101113] px-3 text-sm text-[#f2efe9]"
                  value={hookType}
                  onChange={(event) => setHookType(event.target.value as OutroHookType)}
                >
                  <option value="part2">Part 2 call-out (part2)</option>
                  <option value="next_chapter">Next chapter tease (next_chapter)</option>
                  <option value="new_series">New series recommendation (new_series)</option>
                  <option value="custom">Custom prompt (custom)</option>
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

            {outroScript ? (
              <div className="rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
                <p className="text-[10px] tracking-[0.14em] text-[#a2a19f] uppercase">Generated Narrator Script</p>
                <p className="mt-1.5 text-sm leading-relaxed text-[#f2efe9]">{outroScript}</p>
              </div>
            ) : null}

            {outroPanels.length > 0 ? (
              <div className="rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
                <p className="text-[10px] tracking-[0.14em] text-[#a2a19f] uppercase">
                  Auto-Selected Character Showcase Panels ({outroPanels.length})
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
                      <div key={`${chLabel}-${idLabel}-${idx}`} className="rounded-lg border border-[#2b2c30] bg-[#191a1d] p-2">
                        {imgSrc ? (
                          <img src={imgSrc} alt={charLabel} className="mb-1.5 aspect-[4/3] w-full rounded object-cover bg-black" loading="lazy" />
                        ) : null}
                        <div className="flex flex-wrap gap-1">
                          {(characterNames.length ? characterNames : ["Character"]).map((name, index) => (
                            <span key={`${name}-${index}`} className="rounded-full border border-[#3c3e44] px-1.5 py-0.5 text-[10px] text-[#f2efe9]">{name}</span>
                          ))}
                        </div>
                        <p className="break-all font-mono text-[10px] text-[#a2a19f]">
                          {chLabel} · {idLabel}{panel.shotType ? ` · ${panel.shotType}` : ""}{panel.weight ? ` · w${panel.weight}` : ""}
                        </p>
                        {reason ? (
                          <p className="mt-1 line-clamp-2 text-[11px] text-[#a2a19f]">{reason}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {outroError ? <p className="text-sm text-[#ef6b5b]" role="alert">{outroError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={generatingOutro} onClick={() => setOutroOpen(false)}>
                Close
              </Button>
              <Button type="submit" className="min-h-11 bg-[#f18b6e] text-[#201713] hover:bg-[#f5a087]" disabled={generatingOutro}>
                {generatingOutro ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" aria-hidden /> Generating Outro…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" aria-hidden /> Generate Character-Panel Outro
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {series.full ? (
        <article className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#2b2c30] bg-[#191a1d] p-4 md:p-5">
          <div>
            <p className="text-[10px] tracking-[0.16em] text-[#a2a19f] uppercase">Full compilation</p>
            <h3 className="mt-1 font-serif text-2xl">full.mp4</h3>
            <p className="text-sm text-[#a2a19f]">{fmtTime(series.full.duration)} · {fmtSize(series.full.size)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]" href={watchHref(series.slug, "full")}>
              <Play className="size-4" aria-hidden /> Play
            </a>
            <a className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#3c3e44] px-3 text-sm" href={`${series.full.url}?download=1`} download={`${series.slug}-full.mp4`}>
              <Download className="size-4" aria-hidden /> Download
            </a>
          </div>
        </article>
      ) : null}

      <section aria-label="Chapters">
        <h3 className="mb-3 font-serif text-2xl">Chapters</h3>
        {chapters.length === 0 ? (
          <p className="text-sm text-[#a2a19f]" role="status">No chapters match that search.</p>
        ) : (
          <ol className="divide-y divide-[#2b2c30] overflow-hidden rounded-2xl border border-[#2b2c30]">
            {chapters.map((chapter) => {
              const pos = getPos(series.slug, chapter.ch);
              const pct = progressPct(series.slug, chapter);
              const done = isDone(series.slug, chapter.ch);
              return (
                <li key={chapter.ch} className="flex items-stretch bg-[#191a1d]">
                  <a
                    href={watchHref(series.slug, chapter.ch)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 hover:bg-[#202125]"
                    aria-label={`Play chapter ${chapter.num}`}
                  >
                    <span className="relative block h-16 w-11 shrink-0 overflow-hidden rounded-md bg-[#101113]">
                      <Poster slug={series.slug} ch={chapter.ch} alt="" className="size-full" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">Chapter {String(chapter.num).padStart(2, "0")}</span>
                      <span className="mt-1 block text-xs text-[#a2a19f]">
                        {fmtTime(chapter.duration)} · {fmtSize(chapter.size)}
                        {done ? " · Watched" : pos > 5 ? ` · ${fmtTime(pos)} watched` : ""}
                      </span>
                      <span className="mt-2 block max-w-xs">
                        <ProgressTrack pct={pct} label={`Chapter ${chapter.num} saved progress`} />
                      </span>
                    </span>
                  </a>
                  {privileged ? (
                    <button
                      type="button"
                      className="grid min-w-11 place-items-center px-3 text-[#a2a19f] hover:text-[#ef6b5b]"
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
                    </button>
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
        <a className="inline-flex min-h-11 items-center rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]" href={seriesHref(series.slug)}>
          Back to series
        </a>
      </Missing>
    );
  }

  const heading = isFull ? "Full compilation" : `Chapter ${String(chapter?.num ?? 0).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a className="inline-flex min-h-11 items-center text-sm text-[#a2a19f] hover:text-[#f2efe9]" href={seriesHref(series.slug)}>
          ← {series.title}
        </a>
        <p className="text-xs text-[#a2a19f]">{isFull ? "full.mp4" : `${index + 1} of ${series.chapters.length}`}</p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <h2 className="mb-3 font-serif text-3xl">{heading}</h2>
          {showResume ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#2b2c30] bg-[#191a1d] px-4 py-3" role="region" aria-label="Resume playback">
              <p className="text-sm">Left off at <strong className="font-medium">{fmtTime(saved)}</strong>.</p>
              <div className="flex gap-2">
                <Button type="button" className="min-h-11" onClick={resume}>Resume</Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={restart}>Start over</Button>
              </div>
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-[#2b2c30]">
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
                className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-6 text-center outline-none"
                role="dialog"
                aria-modal="true"
                aria-live="polite"
                aria-labelledby="endcard-title"
                onKeyDown={onEndCardKey}
              >
                <div>
                  <p id="endcard-title" className="font-serif text-3xl">
                    {next ? `Up next: Chapter ${next.num}` : "That’s a wrap."}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {next ? (
                      <button
                        ref={nextRef}
                        type="button"
                        autoFocus
                        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]"
                        onClick={() => {
                          window.location.hash = watchHref(series.slug, next.ch);
                        }}
                      >
                        <Play className="size-4" aria-hidden /> Play next chapter
                      </button>
                    ) : (
                      <a className="inline-flex min-h-11 items-center rounded-lg bg-[#f18b6e] px-3 text-sm font-medium text-[#201713]" href={seriesHref(series.slug)}>
                        Back to series
                      </a>
                    )}
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center rounded-lg border border-[#3c3e44] px-3 text-sm"
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
            <p className="mt-3 text-sm text-[#ef6b5b]" role="alert">
              We couldn’t play this video.{" "}
              <button
                type="button"
                className="underline"
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
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm">{active.name}</p>
              <p className="text-xs text-[#a2a19f]">{fmtTime(active.duration)} · {fmtSize(active.size)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#3c3e44] px-3 text-sm" href={`${active.url}?download=1`} download>
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
                  "min-h-11 min-w-11 rounded-lg border px-2 font-mono text-xs",
                  item === rate ? "border-[#f18b6e] bg-[#30231f] text-[#f2efe9]" : "border-[#3c3e44] text-[#a2a19f]",
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
                  className={cn("min-h-11 rounded-lg border px-3 text-sm", index === cutIndex ? "border-[#f18b6e]" : "border-[#3c3e44] text-[#a2a19f]")}
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
          <p id="player-keys" className="mt-4 text-xs text-[#a2a19f]">
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">Space</kbd>{" "}
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">K</kbd> play/pause ·{" "}
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">←</kbd>{" "}
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">→</kbd> seek 5s ·{" "}
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">F</kbd> fullscreen ·{" "}
            <kbd className="rounded border border-[#3c3e44] px-1 font-mono">M</kbd> mute
          </p>
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
          <aside className="rounded-2xl border border-[#2b2c30] bg-[#191a1d] p-3" aria-label="Chapters">
            <h3 className="px-2 py-1 font-serif text-xl">Chapters</h3>
            <nav className="max-h-[70vh] overflow-y-auto" aria-label={`Chapters in ${series.title}`}>
              {series.chapters.map((item) => {
                const current = item.ch === ch;
                return (
                  <a
                    key={item.ch}
                    id={current ? "chapter-current" : undefined}
                    href={watchHref(series.slug, item.ch)}
                    aria-current={current ? "true" : undefined}
                    className={cn("flex items-center gap-2 rounded-lg px-2 py-2 text-sm", current ? "bg-[#30231f]" : "hover:bg-[#202125]")}
                  >
                    <span className="w-8 font-mono text-xs text-[#a2a19f]">{String(item.num).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{current ? "Now playing" : `Chapter ${item.num}`}</span>
                      <span className="block text-xs text-[#a2a19f]">{fmtTime(item.duration)}</span>
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
        <a className="inline-flex min-h-11 items-center rounded-lg border border-[#3c3e44] px-3 text-sm" href="#/">Back to library</a>
      </EmptyState>
    );
  }
  return (
    <section aria-label="Artwork">
      <div className="mb-4">
        <h2 className="font-serif text-3xl">Beyond the frame.</h2>
        <p className="mt-1 text-sm text-[#a2a19f]">{library.thumbnails.length} artwork{library.thumbnails.length === 1 ? "" : "s"} from the collection.</p>
      </div>
      {q ? <p className="mb-3 text-sm text-[#a2a19f]" role="status">{thumbs.length} artwork{thumbs.length === 1 ? "" : "s"} matching “{query.trim()}”</p> : null}
      {thumbs.length === 0 ? (
        <p className="text-sm text-[#a2a19f]">No artwork matches that search.</p>
      ) : (
        <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
          {thumbs.map((thumb) => {
            const label = artworkLabel(thumb.name);
            const url = thumbUrl(thumb.name, thumb.url);
            return (
              <article key={thumb.name} className="mb-4 break-inside-avoid">
                <button type="button" className="block w-full overflow-hidden rounded-xl bg-[#191a1d] text-left" onClick={() => onOpen({ name: thumb.name, url, size: thumb.size })} aria-label={`Preview ${label}`}>
                  <img src={url} alt={label} className="w-full" loading="lazy" decoding="async" />
                </button>
                <div className="mt-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{label}</p>
                    <p className="text-xs text-[#a2a19f]">{thumb.name.split(".").pop()?.toUpperCase()} · {fmtSize(thumb.size)}</p>
                  </div>
                  <a className="inline-flex min-h-11 min-w-11 items-center justify-center text-[#a2a19f] hover:text-[#f2efe9]" href={`${url}?download=1`} download={thumb.name} aria-label={`Download ${label}`}>
                    <Download className="size-4" aria-hidden />
                  </a>
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
  const [error, setError] = useState("");
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
      setError(errText(err, "Could not delete this video."));
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(subject)} onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">Delete this rendered video?</DialogTitle>
          <DialogDescription>
            This removes the rendered <code>video.mp4</code> only. Source chapters, panel images, narration audio, and caches stay.
          </DialogDescription>
        </DialogHeader>
        {subject ? (
          <form onSubmit={(event) => void onSubmit(event)} className="space-y-3">
            <p className="text-sm">
              <strong>{subject.title}</strong> — Chapter {subject.num}
              <span className="mt-1 block font-mono text-xs text-[#a2a19f]">{expected}</span>
              {subject.size ? <span className="mt-1 block text-xs text-[#a2a19f]">Rendered file · {fmtSize(subject.size)}</span> : null}
              {subject.arms ? <span className="mt-1 block text-xs text-[#a2a19f]">{subject.arms} alternate cut{subject.arms === 1 ? "" : "s"} stay on disk.</span> : null}
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
            {error ? <p className="text-sm text-[#ef6b5b]" role="alert">{error}</p> : null}
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
    <div className="max-w-xl py-12">
      <h2 className="font-serif text-3xl leading-tight">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#a2a19f]">{text}</p>
      {children ? <div className="mt-5 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

function Missing({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <EmptyState title={title} text="Head back to the library to see what’s available.">
      {children}
      <a className="inline-flex min-h-11 items-center rounded-lg border border-[#3c3e44] px-3 text-sm" href="#/">
        <X className="mr-1 size-4" aria-hidden /> Library
      </a>
    </EmptyState>
  );
}
