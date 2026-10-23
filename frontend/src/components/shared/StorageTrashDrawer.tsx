import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ErrorNotice, Notice } from "@/components/ui/notice";
import { api, type StudioStorageReport, type TrashItem } from "@/lib/api";
import { errorLine } from "@/lib/errors";

export function fmtStorageBytes(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function errText(error: unknown, fallback = "Request failed"): string {
  return errorLine(error, fallback);
}

export interface StorageTrashDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  privileged: boolean;
  onMessage?: (message: string, tone?: "success" | "danger") => void;
  onAfterChange?: () => void | Promise<void>;
  onStateLoaded?: (report: StudioStorageReport | null, trash: TrashItem[]) => void;
}

type Pending = { kind: "purge-one"; item: TrashItem } | { kind: "purge-all" } | null;
type Feedback = { tone: "success" | "danger"; text: string } | null;

export function StorageTrashDrawer({
  open, onOpenChange, ...props
}: StorageTrashDrawerProps) {
  return <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
    <DrawerContent>
      <DrawerHeader className="p-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div><DrawerTitle className="text-xl">Storage and trash</DrawerTitle>
            <DrawerDescription className="mt-1 text-[14.5px]">Deleted videos wait in the trash until the server restarts. Restore them before then, or delete them for good.</DrawerDescription></div>
          <DrawerClose className="grid size-11 shrink-0 place-items-center rounded-full bg-card hover:bg-muted" aria-label="Close storage drawer"><X className="size-4" aria-hidden /></DrawerClose>
        </div>
      </DrawerHeader>
      <div className="overflow-auto px-5 pb-8"><StorageTrashPanel {...props} open={open} /></div>
    </DrawerContent>
  </Drawer>;
}

export function StorageTrashPanel({
  open = true,
  privileged,
  onMessage,
  onAfterChange,
  onStateLoaded,
}: Omit<StorageTrashDrawerProps, "open" | "onOpenChange"> & { open?: boolean }) {
  const [storage, setStorage] = useState<StudioStorageReport | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [trashFailed, setTrashFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const onStateLoadedRef = useRef(onStateLoaded);
  onStateLoadedRef.current = onStateLoaded;

  const report = useCallback(
    (tone: "success" | "danger", text: string) => {
      setFeedback({ tone, text });
      onMessage?.(text, tone);
    },
    [onMessage],
  );

  const loadStorage = useCallback(async (manageBusy = true) => {
    if (manageBusy) setBusy(true);
    try {
      const [rep, trashRes] = await Promise.allSettled([api.studio.getStorage(), api.studio.getTrash()]);
      const repValue = rep.status === "fulfilled" ? rep.value : null;
      const trashValue = trashRes.status === "fulfilled" ? trashRes.value : null;
      // A failed request must not look like an empty trash.
      setLoadError(rep.status === "rejected" ? rep.reason : trashRes.status === "rejected" ? trashRes.reason : null);
      setTrashFailed(trashRes.status === "rejected" && !repValue?.trash);
      if (repValue) setStorage(repValue);
      const list = trashValue?.items || trashValue?.trash || repValue?.trash || [];
      if (trashValue || repValue) setTrash(list);
      setLoaded(true);
      onStateLoadedRef.current?.(repValue, list);
    } finally {
      if (manageBusy) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setFeedback(null);
      setPending(null);
      void loadStorage();
    }
  }, [open, loadStorage]);

  async function deleteToTrash(payload: { slug: string; chapter?: string; kind?: string }) {
    if (!privileged) return;
    setBusy(true);
    try {
      const res = await api.studio.deleteStorageItem({
        ...payload,
        confirm: payload.chapter ? `${payload.slug}/${payload.chapter}` : payload.slug,
      });
      report("success", res.message || `Moved ${payload.slug}${payload.chapter ? `/${payload.chapter}` : ""} to the trash.`);
      await Promise.all([loadStorage(false), onAfterChange?.()]);
    } catch (error) {
      report("danger", errText(error, "Could not move the item to the trash."));
    } finally {
      setBusy(false);
    }
  }

  async function restoreItem(item: TrashItem) {
    const tid = item.id || item.trashId || "";
    if (!privileged || !tid) return;
    setBusy(true);
    try {
      const res = await api.studio.restoreTrash(tid);
      report(
        "success",
        res.message || `Restored ${res.restoredPath || `${item.slug || ""}${item.chapter ? `/${item.chapter}` : ""}` || tid}.`,
      );
      await Promise.all([loadStorage(false), onAfterChange?.()]);
    } catch (error) {
      report("danger", errText(error, "Could not restore the item."));
    } finally {
      setBusy(false);
    }
  }

  async function purgeTrash(trashId?: string) {
    if (!privileged) return;
    if (trashId !== undefined && !trashId.trim()) return;
    setPending(null);
    setBusy(true);
    try {
      const res = await api.studio.purgeTrash(trashId);
      report(
        "success",
        res.message ||
          (trashId
            ? `Deleted for good, freed ${fmtStorageBytes(res.freedBytes)}.`
            : `Trash emptied, freed ${fmtStorageBytes(res.freedBytes)}.`),
      );
      await Promise.all([loadStorage(false), onAfterChange?.()]);
    } catch (error) {
      report("danger", errText(error, "Could not empty the trash."));
    } finally {
      setBusy(false);
    }
  }

  const totals: Array<[string, number | undefined]> = [
    ["Total", storage?.totalBytes],
    ["Series", storage?.seriesBytes],
    ["Jobs", storage?.jobsBytes],
    ["Trash", storage?.trashBytes],
  ];

  return (
        <div className="flex min-w-0 flex-col gap-6">
          {loadError ? <ErrorNotice error={loadError} onRetry={() => void loadStorage()} retrying={busy} /> : null}
          {feedback ? <Notice tone={feedback.tone} onDismiss={() => setFeedback(null)}>{feedback.text}</Notice> : null}
          {!privileged ? <Notice tone="info">Viewer accounts can see storage but can’t delete or restore anything.</Notice> : null}

          <section aria-label="Disk usage">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="sr-section-label mb-0">Disk usage</h3>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void loadStorage()}>
                <RotateCcw className={busy ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden /> Refresh
              </Button>
            </div>
            <dl className="sr-group">
              {totals.map(([label, value]) => (
                <div key={label} className="sr-row justify-between">
                  <dt className="text-[15px]">{label}</dt>
                  <dd className="text-[15px] text-muted-foreground tabular-nums">{loaded && storage ? fmtStorageBytes(value) : "—"}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-label="Recoverable until reboot (/tmp Trash)">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="sr-section-label mb-0">Trash</h3>
              {privileged && trash.length > 0 ? (
                pending?.kind === "purge-all" ? (
                  <span className="flex items-center gap-1.5">
                    <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void purgeTrash()}>
                      Delete {trash.length} for good
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPending({ kind: "purge-all" })}>
                    Empty trash
                  </Button>
                )
              ) : null}
            </div>
            {trash.length === 0 ? (
              <p className="rounded-2xl bg-card px-4 py-4 text-[14.5px] text-muted-foreground">
                {!loaded ? "Loading…" : trashFailed ? "Trash contents are unknown until the request succeeds." : "The trash is empty."}
              </p>
            ) : (
              <ul className="sr-group">
                {trash.map((item) => {
                  const tid = item.id || item.trashId || "";
                  const confirming = pending?.kind === "purge-one" && (pending.item.id || pending.item.trashId) === tid;
                  return (
                    <li key={tid} className="sr-row flex-wrap">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-medium">
                          {item.label || `${item.slug || "series"}${item.chapter ? ` · ${item.chapter}` : ""}`}
                        </p>
                        <p className="truncate text-[13px] text-muted-foreground">
                          {item.kind} · {fmtStorageBytes(item.sizeBytes)}
                        </p>
                      </div>
                      {confirming ? (
                        <div className="flex gap-1.5">
                          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void purgeTrash(tid)}>
                            Delete for good
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex gap-1.5">
                          <Button type="button" size="sm" variant="outline" disabled={!privileged || busy} onClick={() => void restoreItem(item)}>
                            <RotateCcw className="size-3.5" aria-hidden /> Restore
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={!privileged || busy}
                            onClick={() => setPending({ kind: "purge-one", item })}
                          >
                            Purge
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Per-series disk usage">
            <h3 className="sr-section-label">By series</h3>
            {(storage?.series || []).length === 0 ? (
              <p className="rounded-2xl bg-card px-4 py-4 text-[14.5px] text-muted-foreground">
                {loaded && !loadError ? "No series on disk yet." : "—"}
              </p>
            ) : (
              <ul className="sr-group">
                {(storage?.series || []).map((row) => {
                  const videos = (row.chapters || []).filter((ch) => ch.hasVideo || ch.videoBytes > 0);
                  return (
                    <li key={row.slug} className="sr-row block">
                      <div className="flex items-baseline justify-between gap-3">
                        <strong className="min-w-0 truncate text-[15px] font-medium">{row.title || row.slug}</strong>
                        <span className="shrink-0 text-[14px] font-semibold tabular-nums">{fmtStorageBytes(row.totalBytes)}</span>
                      </div>
                      <details className="mt-1 text-[13px] text-muted-foreground"><summary className="cursor-pointer">Details</summary><p className="mt-1 tabular-nums">
                        Videos {fmtStorageBytes(row.videoBytes)}, audio {fmtStorageBytes(row.audioBytes)}, panels{" "}
                        {fmtStorageBytes(row.panelsBytes)}, caches {fmtStorageBytes(row.cacheBytes)}
                      </p></details>
                      {videos.length && privileged ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[13.5px] text-primary-text select-none">
                            Chapter videos ({videos.length})
                          </summary>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {videos.map((ch) => (
                              <button
                                key={ch.ch}
                                type="button"
                                className="inline-flex min-h-8 items-center gap-1 rounded-full bg-muted px-3 text-[13px] text-foreground hover:bg-destructive-soft hover:text-destructive disabled:opacity-50"
                                disabled={busy}
                                onClick={() => void deleteToTrash({ slug: row.slug, chapter: ch.ch, kind: "chapter-video" })}
                                title={`Move ${row.slug}/${ch.ch} video to the trash`}
                              >
                                <Trash2 className="size-3" aria-hidden /> {ch.ch} · {fmtStorageBytes(ch.videoBytes)}
                              </button>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
  );
}
