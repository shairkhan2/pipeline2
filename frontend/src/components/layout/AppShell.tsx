import { useEffect, useState, type ReactNode } from "react";
import { Activity, Images, LibraryBig, Plus, Settings } from "lucide-react";

import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { api, type PipelineStatus, type Session } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { SettingsSheet } from "./SettingsSheet";

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
  icon: typeof LibraryBig;
}

const NAV: NavItem[] = [
  { id: "library", href: "/", label: "Library", icon: LibraryBig },
  { id: "artwork", href: "/#/artwork", label: "Artwork", icon: Images },
  { id: "new-series", href: "/new-series.html", label: "New series", icon: Plus },
  { id: "status", href: "/status.html", label: "Pipeline", icon: Activity },
];
const SETTINGS: NavItem = { id: "studio", href: "/studio.html", label: "Settings", icon: Settings };

export function detectAppRoute(loc: { pathname: string; hash: string } = window.location): AppRoute | null {
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const hash = loc.hash || "";
  if (path === "/setup" || path.endsWith("/setup.html")) return null;
  if (path === "/settings" || path === "/studio" || path.endsWith("/studio.html")) return "studio";
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

type Tone = "running" | "quiet" | "idle";

function statusTone(status: PipelineStatus | null): Tone {
  if (!status) return "idle";
  if (status.running && status.progress) return "running";
  if (status.running) return "quiet";
  return "idle";
}

export function AppShell({ active, title, eyebrow, actions, children }: AppShellProps) {
  const [route, setRoute] = useState<AppRoute | null>(active ?? null);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [studioAlert, setStudioAlert] = useState(false);
  // Apply persisted appearance and keep system/theme changes in sync across every page.
  useTheme();

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
      api.studio
        .catalog()
        .then((catalog) => {
          if (stop) return;
          setStudioAlert(Boolean(catalog.providers?.some((provider) => provider.lastTest && provider.lastTest.ok === false)));
        })
        .catch(() => {});
    };
    loadStatus();
    loadAlert();
    const cur = active ?? route;
    const statusTimer = cur === "status" ? null : window.setInterval(loadStatus, 5000);
    return () => {
      stop = true;
      if (statusTimer !== null) window.clearInterval(statusTimer);
    };
  }, [active, route]);

  const tone = statusTone(status);
  const currentRoute = route ?? active ?? null;
  const section = NAV.find((item) => item.id === currentRoute)?.label ?? title ?? "Library";
  const heading = title ?? section;
  const privileged = session?.privileged !== false;

  function handleNavClick(item: NavItem) {
    if (item.id === "studio") {
      window.dispatchEvent(new Event("open-settings"));
      return;
    }
    setRoute(item.id);
    navigateClient(item.href);
  }

  return (
    <TooltipProvider>
      <div className="app-shell min-h-dvh bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-full focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-background"
        >
          Skip to content
        </a>

        <aside
          className="fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col items-center border-r border-border bg-rail py-3 md:flex"
          aria-label="Workspace"
        >
          <a
            href="/"
            aria-label="Screening Room, library"
            className="mb-2 grid size-11 place-items-center rounded-2xl text-foreground transition-colors hover:bg-card"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              setRoute("library");
              navigateClient("/");
            }}
          >
            <BrandMark />
          </a>
          <nav aria-label="Main" className="flex flex-1 flex-col items-center justify-center gap-1.5">
            {NAV.map((item) => (
              <RailLink
                key={item.id}
                item={item}
                current={item.id === currentRoute}
                tone={item.id === "status" ? tone : undefined}
                statusLabel={item.id === "status" ? status?.state : undefined}
                alert={item.id === "studio" ? studioAlert : false}
                onNavigate={handleNavClick}
              />
            ))}
          </nav>
          <Tooltip label="Settings"><button type="button" aria-label="Settings" className="grid size-11 place-items-center rounded-full hover:bg-muted" onClick={() => handleNavClick(SETTINGS)}><Settings size={21} strokeWidth={1.75} aria-hidden /></button></Tooltip>
        </aside>

        <div className="min-w-0 md:pl-[72px]">
          <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 bg-background/85 px-4 py-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 md:px-8">
            <div className="flex min-w-0 items-center gap-2">
              <a
                href="/"
                aria-label="Screening Room, library"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-card md:hidden"
              >
                <BrandMark small />
              </a>
              <div className="flex min-w-0 items-center gap-2 rounded-full bg-card py-2 pr-4 pl-3 shadow-float max-md:shadow-none">
                {eyebrow && eyebrow !== "Workspace" ? (
                  <>
                    <span className="truncate text-[14px] text-muted-foreground max-sm:hidden">{eyebrow}</span>
                    <span className="text-muted-foreground/60 max-sm:hidden" aria-hidden>/</span>
                  </>
                ) : null}
                <span className="truncate text-[15px] font-medium">{heading}</span>
              </div>
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {actions ? <div className="flex min-w-0 items-center gap-2">{actions}</div> : null}
              {!privileged ? (
                <span className="rounded-full bg-card px-3 py-2 text-[13px] text-muted-foreground max-sm:hidden" title="Temporary viewing account">
                  View only
                </span>
              ) : null}
            </div>
          </header>
          <main id="main-content" tabIndex={-1} className="shell-content mx-auto w-full max-w-[1320px] px-4 pt-2 pb-28 outline-none md:px-8 md:pb-14">
            {children}
          </main>
        </div>

        <nav
          aria-label="Mobile"
          className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-[22px] bg-card/95 p-1.5 shadow-float backdrop-blur-md md:hidden"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        >
          {[...NAV, SETTINGS].map((item) => (
            <MobileLink
              key={item.id}
              item={item}
              current={item.id === currentRoute || (item.id === "studio" && currentRoute === "meter")}
              tone={item.id === "status" ? tone : undefined}
              alert={item.id === "studio" ? studioAlert : false}
              onNavigate={handleNavClick}
            />
          ))}
        </nav>
        <SettingsSheet />
      </div>
    </TooltipProvider>
  );
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={small ? "size-[18px]" : "size-[22px]"} aria-hidden>
      <rect x="2.5" y="4" width="12" height="16" rx="3" fill="currentColor" opacity="0.18" />
      <rect x="6" y="2.5" width="12" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m10.5 8 5 2.75-5 2.75Z" fill="currentColor" />
    </svg>
  );
}

function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  if (tone === "idle") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute size-2 rounded-full ring-2 ring-rail",
        tone === "running" ? "bg-success" : "bg-warning",
        className,
      )}
    />
  );
}

function linkClick(item: NavItem, onNavigate?: (item: NavItem) => void) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(item);
  };
}

function RailLink({
  item,
  current,
  tone,
  statusLabel,
  alert,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  tone?: Tone;
  statusLabel?: string;
  alert: boolean;
  onNavigate?: (item: NavItem) => void;
}) {
  const Icon = item.icon;
  const label = tone && tone !== "idle" ? `${item.label}: ${tone === "running" ? "run in progress" : (statusLabel || "busy").toLowerCase()}` : alert ? `${item.label}: a provider failed its last test` : item.label;
  return (
    <Tooltip label={label}>
      <a
        href={item.href}
        aria-label={label}
        aria-current={current ? "page" : undefined}
        onClick={linkClick(item, onNavigate)}
        className={cn(
          "relative grid size-11 place-items-center rounded-full text-foreground transition-colors",
          current ? "bg-muted" : "hover:bg-card",
        )}
      >
        <Icon className="size-[21px]" strokeWidth={current ? 2 : 1.7} aria-hidden />
        {tone ? <StatusDot tone={tone} className="top-2 right-2" /> : null}
        {alert ? <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-destructive ring-2 ring-rail" /> : null}
      </a>
    </Tooltip>
  );
}

function MobileLink({
  item,
  current,
  tone,
  alert,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  tone?: Tone;
  alert: boolean;
  onNavigate?: (item: NavItem) => void;
}) {
  const Icon = item.icon;
  if (item.id === "studio") return <button type="button" onClick={() => onNavigate?.(item)} className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-[12px] font-medium text-muted-foreground"><Icon className="size-5" strokeWidth={1.75} aria-hidden /><span>Settings</span></button>;
  return (
    <a
      href={item.href}
      aria-current={current ? "page" : undefined}
      onClick={linkClick(item, onNavigate)}
      className={cn(
        "relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-[12px] font-medium transition-colors",
        current ? "bg-background text-foreground shadow-float" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        <Icon className="size-5" strokeWidth={current ? 2 : 1.7} aria-hidden />
        {tone ? <StatusDot tone={tone} className="-top-0.5 -right-1 ring-card" /> : null}
        {alert ? <span aria-hidden className="absolute -top-0.5 -right-1 size-2 rounded-full bg-destructive ring-2 ring-card" /> : null}
      </span>
      <span className="max-w-full truncate px-0.5">{item.label}</span>
    </a>
  );
}
