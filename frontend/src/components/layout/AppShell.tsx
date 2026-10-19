import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Clapperboard,
  Gauge,
  Image,
  Plus,
  SlidersHorizontal,
} from "lucide-react";

import { api, type PipelineStatus, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";

export type AppRoute = "library" | "artwork" | "new-series" | "studio" | "status" | "meter";

export interface AppShellProps {
  active?: AppRoute;
  title?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
}

interface NavItem {
  id: AppRoute;
  href: string;
  label: string;
  icon: typeof Clapperboard;
  group: "collection" | "workspace";
}

const NAV: NavItem[] = [
  { id: "library", href: "/", label: "Library", icon: Clapperboard, group: "collection" },
  { id: "artwork", href: "/#/artwork", label: "Artwork", icon: Image, group: "collection" },
  { id: "new-series", href: "/new-series.html", label: "New series", icon: Plus, group: "workspace" },
  { id: "studio", href: "/studio.html", label: "Studio", icon: SlidersHorizontal, group: "workspace" },
  { id: "status", href: "/status.html", label: "Pipeline", icon: Activity, group: "workspace" },
  { id: "meter", href: "/meter.html", label: "Meter room", icon: Gauge, group: "workspace" },
];

export function detectAppRoute(loc: { pathname: string; hash: string } = window.location): AppRoute | null {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const hash = loc.hash || "";
  if (path === "/setup" || path.endsWith("/setup.html")) return null;
  if (path === "/studio" || path.endsWith("/studio.html")) return "studio";
  if (path === "/status" || path.endsWith("/status.html")) return "status";
  if (path === "/meter" || path.endsWith("/meter.html")) return "meter";
  if (path === "/new-series" || path.endsWith("/new-series.html")) return "new-series";
  if (path === "/" || path.endsWith("/index.html")) {
    if (hash.startsWith("#/setup")) return null;
    if (hash.startsWith("#/studio")) return "studio";
    if (hash.startsWith("#/status")) return "status";
    if (hash.startsWith("#/meter")) return "meter";
    if (hash.startsWith("#/new-series")) return "new-series";
    if (hash.startsWith("#/artwork")) return "artwork";
    return "library";
  }
  return null;
}

export function navigateClient(href: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.dispatchEvent(
    typeof HashChangeEvent === "function" ? new HashChangeEvent("hashchange") : new Event("hashchange"),
  );
}

function isSetupLocation(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/setup" || path.endsWith("/setup.html") || window.location.hash.startsWith("#/setup");
}

function statusTone(status: PipelineStatus | null): "running" | "quiet" | "idle" {
  if (!status) return "idle";
  if (status.running && status.progress) return "running";
  if (status.running) return "quiet";
  return "idle";
}

export function AppShell({ active, title, eyebrow, actions, children }: AppShellProps) {
  const [route, setRoute] = useState<AppRoute | null>(active ?? null);
  const [session, setSession] = useState<Session | null>(null);
  const [seriesCount, setSeriesCount] = useState<number | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [studioAlert, setStudioAlert] = useState(false);

  useEffect(() => {
    if (active) setRoute(active);
    else if (typeof window !== "undefined") setRoute(detectAppRoute());
  }, [active]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncRoute = () => {
      const detected = detectAppRoute();
      if (detected) setRoute(detected);
    };
    window.addEventListener("popstate", syncRoute);
    window.addEventListener("hashchange", syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    api
      .session()
      .then((next) => {
        if (stop) return;
        setSession(next);
        if (next.needsSetup && !isSetupLocation()) window.location.assign("/setup.html");
      })
      .catch(() => {
        /* 401 redirect is handled by the client. */
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const loadLibrary = () => {
      api
        .library()
        .then((library) => {
          if (!stop) setSeriesCount(library.series?.length ?? 0);
        })
        .catch(() => {});
    };
    const loadStatus = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      api
        .status()
        .then((next) => {
          if (!stop) setStatus(next);
        })
        .catch(() => {});
    };
    const loadAlert = () => {
      api
        .studio.catalog()
        .then((catalog) => {
          if (stop) return;
          const failed = catalog.providers?.some((provider) => provider.lastTest && provider.lastTest.ok === false);
          setStudioAlert(Boolean(failed));
        })
        .catch(() => {});
    };
    loadLibrary();
    loadStatus();
    loadAlert();
    const cur = active ?? route;
    const statusTimer = cur === "status" ? null : window.setInterval(loadStatus, 5000);
    const libraryTimer = cur === "library" || cur === "artwork" ? null : window.setInterval(loadLibrary, 20000);
    return () => {
      stop = true;
      if (statusTimer !== null) window.clearInterval(statusTimer);
      if (libraryTimer !== null) window.clearInterval(libraryTimer);
    };
  }, [active, route]);

  const tone = statusTone(status);
  const privileged = session?.privileged !== false;
  const role = session ? (session.privileged ? "Admin" : "Read-only") : "…";
  const currentRoute = route ?? active ?? null;
  const section = NAV.find((item) => item.id === currentRoute)?.label ?? title ?? "Library";

  function handleNavClick(item: NavItem) {
    setRoute(item.id);
    navigateClient(item.href);
  }

  return (
    <div className="screening-shell min-h-dvh bg-[#101113] text-[#f2efe9]" style={{ fontFamily: '"DM Sans", system-ui, sans-serif' }}>
      <style>{SHELL_CSS}</style>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-[#f18b6e] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[#201713] focus:outline-none"
      >
        Skip to content
      </a>
      <div className="shell-frame">
        <aside className="shell-side" aria-label="Workspace">
          <a
            className="shell-brand"
            href="/"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              setRoute("library");
              navigateClient("/");
            }}
          >
            <span className="shell-mark" aria-hidden>
              <svg viewBox="0 0 24 24" className="size-3.5 fill-current">
                <path d="M8 5.5v13l11-6.5-11-6.5z" />
              </svg>
            </span>
            <span className="shell-brand-name">
              Screening
              <br />
              Room<span className="text-[#f18b6e]">.</span>
            </span>
          </a>

          <nav className="shell-nav" aria-label="Main">
            <p className="shell-caption">Your collection</p>
            {NAV.filter((item) => item.group === "collection").map((item) => (
              <ShellLink
                key={item.id}
                item={item}
                current={item.id === currentRoute}
                count={item.id === "library" ? seriesCount : null}
                onNavigate={handleNavClick}
              />
            ))}
            <p className="shell-caption">Workspace</p>
            {NAV.filter((item) => item.group === "workspace").map((item) => (
              <ShellLink
                key={item.id}
                item={item}
                current={item.id === currentRoute}
                statusTone={item.id === "status" ? tone : undefined}
                statusLabel={item.id === "status" ? status?.state : undefined}
                alert={item.id === "studio" ? studioAlert : false}
                readOnly={item.id === "studio" && session ? !privileged : false}
                onNavigate={handleNavClick}
              />
            ))}
          </nav>

          <div className="mt-auto px-3 pb-4">
            <div className="shell-user" title={session ? `${session.user} · ${role}` : "Session"}>
              <span className="shell-user-dot" data-role={session?.privileged ? "admin" : "viewer"} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11px] tracking-wide text-[#f2efe9]">
                  {session?.user ?? "—"}
                </span>
                <span className="block text-[10px] tracking-[0.14em] text-[#a2a19f] uppercase">{role}</span>
              </span>
            </div>
            <p className="mt-4 px-1 font-serif text-[13px] leading-snug text-[#a2a19f]">
              Made for the stories
              <br />
              you get lost in.
            </p>
          </div>
        </aside>

        <div className="shell-main">
          <header className="shell-top">
            <div className="min-w-0">
              <p className="text-[10px] tracking-[0.18em] text-[#a2a19f] uppercase">{eyebrow ?? "Screening Room"}</p>
              <p className="truncate font-serif text-lg text-[#f2efe9]">
                {title ?? section}
              </p>
            </div>
            <div className="flex items-center gap-2">{actions}</div>
          </header>
          <main id="main-content" tabIndex={-1} className="shell-content">
            {children}
          </main>
        </div>
      </div>

      <nav className="shell-bottom" aria-label="Mobile">
        {NAV.map((item) => (
          <ShellLink
            key={item.id}
            item={item}
            current={item.id === currentRoute}
            compact
            count={item.id === "library" ? seriesCount : null}
            statusTone={item.id === "status" ? tone : undefined}
            alert={item.id === "studio" ? studioAlert : false}
            onNavigate={handleNavClick}
          />
        ))}
      </nav>
    </div>
  );
}

function ShellLink({
  item,
  current,
  compact = false,
  count = null,
  statusTone: tone,
  statusLabel,
  alert = false,
  readOnly = false,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  compact?: boolean;
  count?: number | null;
  statusTone?: "running" | "quiet" | "idle";
  statusLabel?: string;
  alert?: boolean;
  readOnly?: boolean;
  onNavigate?: (item: NavItem) => void;
}) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      className={cn("shell-link", current && "is-on", compact && "is-compact")}
      aria-current={current ? "page" : undefined}
      title={tone ? `Pipeline: ${(statusLabel || tone).toLowerCase()}` : item.label}
      onClick={(event) => {
        if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(item);
      }}
    >
      <span className="relative grid size-5 place-items-center">
        <Icon className="size-4" strokeWidth={1.75} aria-hidden />
        {tone ? <span className="shell-dot" data-state={tone} /> : null}
        {alert ? <span className="shell-alert" /> : null}
      </span>
      <span className="shell-link-label">{item.label}</span>
      {typeof count === "number" ? (
        <span className="shell-count" aria-label={`${count} series`}>
          {count}
        </span>
      ) : null}
      {readOnly ? <span className="shell-readonly">Read-only</span> : null}
    </a>
  );
}

const SHELL_CSS = `
.screening-shell { color-scheme: dark; }
.shell-frame {
  display: grid;
  grid-template-columns: 218px minmax(0, 1fr);
  min-height: 100dvh;
}
.shell-side {
  position: sticky;
  top: 0;
  display: flex;
  height: 100dvh;
  flex-direction: column;
  border-right: 1px solid #2b2c30;
  background: #17181a;
}
.shell-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px 18px 16px;
  color: #f2efe9;
  text-decoration: none;
}
.shell-mark {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 10px;
  background: #f18b6e;
  color: #201713;
}
.shell-brand-name {
  font-family: Fraunces, Georgia, serif;
  font-size: 17px;
  line-height: 1.05;
  letter-spacing: -0.02em;
}
.shell-caption {
  margin: 14px 18px 6px;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a2a19f;
}
.shell-nav { display: flex; flex-direction: column; padding: 0 10px; }
.shell-link {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  border-radius: 10px;
  padding: 8px 10px;
  color: #a2a19f;
  text-decoration: none;
  font-size: 14px;
}
.shell-link:hover { color: #f2efe9; background: #1e2024; }
.shell-link.is-on {
  color: #f2efe9;
  background: rgba(241, 139, 110, 0.14);
  box-shadow: inset 2px 0 0 #f18b6e;
}
.shell-link-label { min-width: 0; }
.shell-count, .shell-readonly {
  margin-left: auto;
  border-radius: 999px;
  background: #1e2024;
  padding: 1px 7px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  color: #f2efe9;
}
.shell-readonly { letter-spacing: 0.04em; text-transform: uppercase; color: #d6b57b; }
.shell-dot, .shell-alert {
  position: absolute;
  right: -3px;
  bottom: -2px;
  width: 7px;
  height: 7px;
  border-radius: 99px;
  border: 1px solid #17181a;
}
.shell-dot[data-state="running"] { background: #5eead4; box-shadow: 0 0 0 3px rgba(94, 234, 212, 0.16); }
.shell-dot[data-state="quiet"] { background: #d6b57b; }
.shell-dot[data-state="idle"] { background: #3c3e44; }
.shell-alert { background: #f18b6e; }
.shell-user {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #2b2c30;
  border-radius: 12px;
  background: #101113;
  padding: 8px 10px;
}
.shell-user-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 99px;
  background: #3c3e44;
}
.shell-user-dot[data-role="admin"] { background: #aed1a8; }
.shell-user-dot[data-role="viewer"] { background: #d6b57b; }
.shell-main { min-width: 0; }
.shell-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #2b2c30;
  padding: 16px 28px;
}
.shell-content { padding: 24px 28px 40px; }
.shell-bottom { display: none; }
.font-serif { font-family: Fraunces, Georgia, serif; }
@media (pointer: coarse) {
  .shell-link { min-height: 44px; }
}
@media (max-width: 960px) {
  .shell-frame { grid-template-columns: 1fr; }
  .shell-side { display: none; }
  .shell-top, .shell-content { padding-left: 16px; padding-right: 16px; }
  .shell-content { padding-bottom: 88px; }
  .shell-bottom {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    display: grid;
    grid-template-columns: repeat(6, minmax(44px, 1fr));
    border-top: 1px solid #2b2c30;
    background: #17181a;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .shell-link.is-compact {
    min-height: 44px;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    border-radius: 0;
    padding: 6px 2px 7px;
    font-size: 10px;
    box-shadow: none;
  }
  .shell-link.is-compact .shell-link-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .shell-link.is-compact.is-on { box-shadow: inset 0 2px 0 #f18b6e; }
  .shell-link.is-compact .shell-count,
  .shell-link.is-compact .shell-readonly { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .shell-dot[data-state="running"] { box-shadow: none; }
}
`;
