import { useEffect, useRef, useState } from "react";
import type { AnimatedTab } from "@/components/ui/animated-tabs";
import { Palette, UserRound, Plug, GitBranch, Server, AudioLines, FileText, Sparkles, Gauge, HardDrive, Keyboard, ChevronLeft, ChevronRight, LogIn } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

const ICONS: Record<string, typeof Palette> = {
  appearance: Palette, account: UserRound, providers: Plug, routing: GitBranch, nodes: Server,
  voice: AudioLines, prompts: FileText, outro: Sparkles, usage: Gauge, storage: HardDrive, shortcuts: Keyboard,
};

/** Keep visited panels mounted so switching sections does not discard a draft. */
export function StudioTabs({ tabs }: { tabs: AnimatedTab[] }) {
  const read = () => new URLSearchParams(window.location.search).get("settings") || "appearance";
  const [active, setActive] = useState(read);
  const [visited, setVisited] = useState(() => new Set([active]));
  const [detail, setDetail] = useState(!window.history.state?.settingsList);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => {
      const next = read();
      setActive(next);
      setVisited(current => new Set([...current, next]));
      setDetail(!window.history.state?.settingsList);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    workspace.current?.querySelectorAll<HTMLMediaElement>("[role=tabpanel][hidden] audio, [role=tabpanel][hidden] video").forEach(media => media.pause());
  }, [active]);
  function select(id: string) {
    setActive(id);
    setVisited(current => new Set([...current, id]));
    setDetail(true);
    const url = new URL(window.location.href);
    url.searchParams.set("settings", id);
    window.history.replaceState({ ...window.history.state, settingsList: false }, "", url);
  }
  return <div className="settings-workspace" data-detail={detail} ref={workspace}>
    <aside className="settings-sidebar">
      <h2 className="mb-4 px-3 text-[22px] font-semibold">Settings</h2>
      <nav className="settings-sections" aria-label="Settings sections">
        {tabs.map(tab => { const Icon = ICONS[tab.id] ?? Palette; return <button
          key={tab.id} id={`studio-tab-${tab.id}`} type="button"
          aria-current={active === tab.id ? "true" : undefined}
          aria-controls={`studio-panel-${tab.id}`} onClick={() => select(tab.id)}>
          <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="flex-1">{tab.label}</span><ChevronRight className="size-4 sm:hidden" aria-hidden />
        </button>; })}
      </nav>
      <a href="/login" className="settings-switch"><LogIn size={18} strokeWidth={1.75} aria-hidden />Switch account</a>
    </aside>
    <div className="settings-content">
      <Tooltip label="Back to settings"><button type="button" aria-label="Back to settings" className="settings-back" onClick={() => setDetail(false)}><ChevronLeft size={20} strokeWidth={1.75} aria-hidden />Settings</button></Tooltip>
      {tabs.map(tab => <section key={tab.id} id={`studio-panel-${tab.id}`} role="tabpanel" aria-labelledby={`studio-tab-${tab.id}`} hidden={active !== tab.id}>
        <header className="mb-5 pr-8"><h2 className="text-[22px] font-semibold">{tab.label}</h2></header>
        {visited.has(tab.id) ? tab.content : null}
      </section>)}
    </div>
  </div>;
}
