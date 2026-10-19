import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AnimatedTab } from "@/components/ui/animated-tabs";

const descriptions: Record<string, string> = {
  providers: "Connect your AI services and manage the models available to your pipeline.",
  routing: "Choose the model for each stage. Order fallbacks in the sequence they should run.",
  nodes: "Set output quality and manage the machines that render your chapters.",
  voice: "Listen to a narration sample before choosing a voice for your next series.",
  prompts: "Shape how each stage reads, matches, and narrates your chapters.",
};

/** Keep visited panels mounted so switching sections does not discard a draft. */
export function StudioTabs({ tabs }: { tabs: AnimatedTab[] }) {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const readTab = () => {
    const value = new URLSearchParams(window.location.search).get("tab");
    return tabsRef.current.find((tab) => tab.id === value)?.id ?? tabsRef.current[0]?.id ?? "";
  };
  const [active, setActive] = useState(readTab);
  const [visited, setVisited] = useState(() => new Set([active]));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const workspace = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    workspace.current?.querySelectorAll<HTMLMediaElement>("[role=tabpanel][hidden] audio, [role=tabpanel][hidden] video")
      .forEach((media) => media.pause());
  }, [active]);

  useEffect(() => {
    const sync = () => {
      const next = readTab();
      setActive(next);
      setVisited((current) => new Set([...current, next]));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function select(id: string) {
    if (id === active) return;
    setActive(id);
    setVisited((current) => new Set([...current, id]));
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    window.history.pushState(null, "", url);
  }

  function onKey(event: KeyboardEvent, index: number) {
    const positions: Record<string, number> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    if (!(event.key in positions)) return;
    event.preventDefault();
    const next = positions[event.key];
    select(tabs[next].id);
    buttons.current[next]?.focus();
  }

  return (
    <div className="studio-workspace" ref={workspace}>
      <div className="studio-tabs" role="tablist" aria-label="Studio sections">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => { buttons.current[index] = node; }}
            id={`studio-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`studio-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => select(tab.id)}
            onKeyDown={(event) => onKey(event, index)}
          >
            {tab.icon}<span>{tab.label}</span>
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <section
          key={tab.id}
          id={`studio-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`studio-tab-${tab.id}`}
          hidden={active !== tab.id}
          tabIndex={0}
        >
          {visited.has(tab.id) && <>
            <header className="studio-section-heading">
              <h2>{tab.label}</h2>
              <p>{descriptions[tab.id]}</p>
            </header>
            {tab.content}
          </>}
        </section>
      ))}
    </div>
  );
}
