import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { StudioSettingsSections } from "@/pages/StudioPage";

const SECTIONS = new Set(["appearance", "account", "providers", "routing", "nodes", "voice", "prompts", "outro", "usage", "storage", "shortcuts"]);

/** Normalize old bookmarks without replacing the page underneath the sheet. */
function readSettings() {
  const url = new URL(window.location.href);
  const legacy = /\/(studio|settings|meter)(\.html)?\/?$/.test(url.pathname) || /^#\/(studio|meter)/.test(url.hash);
  let section = url.searchParams.get("settings");
  if (!section && legacy) section = /meter/.test(url.pathname + url.hash) ? "usage" : url.searchParams.get("tab") || "appearance";
  if (legacy) {
    url.pathname = "/";
    url.hash = "";
    url.searchParams.delete("tab");
  }
  if (section) {
    section = SECTIONS.has(section) ? section : "appearance";
    url.searchParams.set("settings", section);
  }
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  return Boolean(section);
}

export function SettingsSheet() {
  const [open, setOpen] = useState(readSettings);
  const returnFocus = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sync = () => setOpen(readSettings());
    const show = () => {
      returnFocus.current = document.activeElement as HTMLElement;
      const url = new URL(window.location.href);
      url.searchParams.set("settings", "appearance");
      window.history.pushState({ ...window.history.state, settingsList: true }, "", url);
      setOpen(true);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    window.addEventListener("open-settings", show);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("open-settings", show);
    };
  }, []);
  function change(next: boolean) {
    setOpen(next);
    if (!next) {
      const url = new URL(window.location.href);
      url.searchParams.delete("settings");
      window.history.replaceState(null, "", url);
    }
  }
  return <Dialog.Root open={open} onOpenChange={change}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--overlay)]" />
      <Dialog.Popup ref={popup} className="settings-sheet" initialFocus={popup} finalFocus={() => returnFocus.current}>
        <Dialog.Title className="sr-only">Settings</Dialog.Title>
        <StudioSettingsSections />
        <Tooltip label="Close settings"><Dialog.Close aria-label="Close settings" className="settings-close"><X size={18} strokeWidth={1.75} aria-hidden /></Dialog.Close></Tooltip>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
