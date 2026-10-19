import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { api, isApiError, type StudioStorageReport, type TrashItem } from "@/lib/api";

export function fmtStorageBytes(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function errText(error: unknown, fallback = "Request failed"): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export interface StorageTrashDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  privileged: boolean;
  onMessage?: (message: string) => void;
  onAfterChange?: () => void | Promise<void>;
  onStateLoaded?: (report: StudioStorageReport | null, trash: TrashItem[]) => void;
}

export function StorageTrashDrawer({
  open,
  onOpenChange,
  privileged,
  onMessage,
  onAfterChange,
  onStateLoaded,
}: StorageTrashDrawerProps) {
  const [storage, setStorage] = useState<StudioStorageReport | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);

  const loadStorage = useCallback(async () => {
    setBusy(true);
    try {
      const [rep, trashRes] = await Promise.all([
        api.studio.getStorage().catch(() => null),
        api.studio.getTrash().catch(() => null),
      ]);
      if (rep) setStorage(rep);
      const list = trashRes?.items || trashRes?.trash || rep?.trash || [];
      setTrash(list);
      onStateLoaded?.(rep, list);
    } finally {
      setBusy(false);
    }
  }, [onStateLoaded]);

  useEffect(() => {
    if (open) void loadStorage();
  }, [open, loadStorage]);

  async function deleteToTrash(payload: { slug: string; chapter?: string; kind?: string }) {
    if (!privileged) return;
    setBusy(true);
    try {
      const res = await api.studio.deleteStorageItem({
        ...payload,
        confirm: payload.chapter ? `${payload.slug}/${payload.chapter}` : payload.slug,
      });
      onMessage?.(res.message || `Moved ${payload.slug}${payload.chapter ? `/${payload.chapter}` : ""} to /tmp trash.`);
      await Promise.all([loadStorage(), onAfterChange?.()]);
    } catch (error) {
      onMessage?.(errText(error, "Could not move item to /tmp trash."));
      setBusy(false);
    }
  }

  async function restoreItem(item: TrashItem) {
    const tid = item.id || item.trashId || "";
    if (!privileged || !tid) return;
    setBusy(true);
    try {
      const res = await api.studio.restoreTrash(tid);
      onMessage?.(
        res.message ||
          `Restored ${res.restoredPath || `${item.slug || ""}${item.chapter ? `/${item.chapter}` : ""}` || tid} from /tmp trash.`,
      );
      await Promise.all([loadStorage(), onAfterChange?.()]);
    } catch (error) {
      onMessage?.(errText(error, "Could not restore item."));
      setBusy(false);
    }
  }

  async function purgeTrash(trashId?: string) {
    if (!privileged) return;
    if (trashId !== undefined && !trashId.trim()) return;
    setBusy(true);
    try {
      const res = await api.studio.purgeTrash(trashId);
      onMessage?.(
        res.message ||
          (trashId
            ? `Purged ${trashId} from /tmp trash (${fmtStorageBytes(res.freedBytes)}).`
            : `Emptied /tmp trash (${fmtStorageBytes(res.freedBytes)}).`),
      );
      await Promise.all([loadStorage(), onAfterChange?.()]);
    } catch (error) {
      onMessage?.(errText(error, "Could not empty /tmp trash."));
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <DrawerTitle className="font-serif text-2xl">Storage &amp; recovery</DrawerTitle>
              <DrawerDescription>
                Review disk usage and restore deleted videos or artifacts. Items in /tmp trash are recoverable until reboot.
              </DrawerDescription>
            </div>
            <DrawerClose
              className="min-h-9 rounded-full border border-[#3c3e44] bg-[#101113] px-3 text-xs text-[#f2efe9]"
              aria-label="Close storage drawer"
            >
              Close
            </DrawerClose>
          </div>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-auto p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#2b2c30] bg-[#191a1d] p-3 text-xs">
            <div className="flex flex-wrap gap-3">
              <span>
                Total disk usage: <strong className="font-mono">{fmtStorageBytes(storage?.totalBytes)}</strong>
              </span>
              {storage?.seriesBytes !== undefined ? (
                <span>
                  Series: <strong className="font-mono">{fmtStorageBytes(storage.seriesBytes)}</strong>
                </span>
              ) : null}
              {storage?.jobsBytes !== undefined ? (
                <span>
                  Jobs: <strong className="font-mono">{fmtStorageBytes(storage.jobsBytes)}</strong>
                </span>
              ) : null}
              <span>
                /tmp Trash: <strong className="font-mono">{fmtStorageBytes(storage?.trashBytes)}</strong>
              </span>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void loadStorage()}>
              Refresh
            </Button>
          </div>

          <section aria-label="Recoverable until reboot (/tmp Trash)" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif text-lg">Deleted items</h3>
              {privileged && trash.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void purgeTrash()}
                >
                  Empty Trash
                </Button>
              ) : null}
            </div>
            {trash.length === 0 ? (
              <p className="text-xs text-[#a2a19f]">No deleted chapter videos or artifacts in /tmp trash.</p>
            ) : (
              trash.map((item) => {
                const tid = item.id || item.trashId || "";
                return (
                  <div
                    key={tid}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#2b2c30] bg-[#191a1d] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-[#f2efe9]">
                        {item.label || `${item.slug || "series"}${item.chapter ? `/${item.chapter}` : ""}`} · {item.kind}
                      </p>
                      <p className="truncate font-mono text-[11px] text-[#a2a19f]">
                        {fmtStorageBytes(item.sizeBytes)} · {item.originalPath}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!privileged || busy}
                        onClick={() => void restoreItem(item)}
                      >
                        <RotateCcw className="size-3.5" aria-hidden /> Restore
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!privileged || busy}
                        onClick={() => void purgeTrash(tid)}
                      >
                        Purge
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section aria-label="Per-series disk usage" className="flex flex-col gap-2">
            <h3 className="font-serif text-lg">Per-series disk usage</h3>
            {(storage?.series || []).length === 0 ? (
              <p className="text-xs text-[#a2a19f]">No series disk usage reported yet.</p>
            ) : (
              (storage?.series || []).map((row) => (
                <div key={row.slug} className="rounded-xl border border-[#2b2c30] bg-[#191a1d] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <strong className="text-sm">{row.title || row.slug}</strong>{" "}
                      <code className="font-mono text-xs text-[#a2a19f]">{row.slug}</code>
                    </div>
                    <span className="font-mono text-xs text-[#f18b6e]">{fmtStorageBytes(row.totalBytes)}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-[#a2a19f]">
                    Videos {fmtStorageBytes(row.videoBytes)} · Audio {fmtStorageBytes(row.audioBytes)} · Panels{" "}
                    {fmtStorageBytes(row.panelsBytes)} · Caches {fmtStorageBytes(row.cacheBytes)}
                  </p>
                  {row.chapters?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {row.chapters
                        .filter((ch) => ch.hasVideo || ch.videoBytes > 0)
                        .map((ch) => (
                          <button
                            key={ch.ch}
                            type="button"
                            className="inline-flex min-h-7 items-center gap-1 rounded-full border border-[#2b2c30] bg-[#101113] px-2 text-[11px] text-[#f2efe9] hover:border-[#f0a096] hover:text-[#f0a096] disabled:opacity-50"
                            disabled={!privileged || busy}
                            onClick={() => void deleteToTrash({ slug: row.slug, chapter: ch.ch, kind: "chapter-video" })}
                            title={`Move ${row.slug}/${ch.ch} video to /tmp trash`}
                          >
                            <Trash2 className="size-3" aria-hidden /> {ch.ch} ({fmtStorageBytes(ch.videoBytes)})
                          </button>
                        ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
