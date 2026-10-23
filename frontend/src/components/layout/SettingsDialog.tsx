import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { Session } from "@/lib/api";
import { THEME_ACCENTS, THEME_MODES, useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

const MODE_ICON: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const SHORTCUTS = [
  ["Play or pause", "Space or K"], ["Back or forward 5 seconds", "← or →"],
  ["Fullscreen", "F"], ["Mute", "M"], ["Close a dialog", "Esc"],
];

export function AppearanceSection() {
  const { mode, accent, resolved, setMode, setAccent } = useTheme();
  return <>
    <div className="sr-group">
      <div className="sr-row flex-wrap justify-between">
        <span id="theme-mode-label" className="text-[15px]">Mode</span>
        <div role="radiogroup" aria-labelledby="theme-mode-label" className="flex gap-1 rounded-full bg-muted p-1">
          {THEME_MODES.map(item => { const Icon = MODE_ICON[item.id]; return <Tooltip key={item.id} label={item.label}><button
            type="button" role="radio" aria-checked={mode === item.id} aria-label={item.label}
            onClick={() => setMode(item.id)}
            className={cn("grid size-11 place-items-center rounded-full", mode === item.id ? "bg-background text-foreground shadow-float" : "text-muted-foreground hover:text-foreground")}
          ><Icon className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>; })}
        </div>
      </div>
      <div className="sr-row flex-wrap justify-between gap-y-3">
        <span id="theme-accent-label" className="text-[15px]">Theme colour</span>
        <div role="radiogroup" aria-labelledby="theme-accent-label" className="flex flex-wrap gap-1">
          {THEME_ACCENTS.map(item => <Tooltip key={item.id} label={item.label}><button type="button" role="radio" aria-checked={accent === item.id}
            aria-label={item.label} title={item.label} onClick={() => setAccent(item.id)} className="grid size-11 place-items-center rounded-full">
            <span className={cn("grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-card", accent === item.id && "ring-2 ring-foreground")}
              style={{ background: resolved === "dark" ? item.dark : item.light }}>
              {accent === item.id ? <Check className="size-4" style={{ color: "var(--primary-foreground)" }} aria-hidden /> : null}
            </span>
          </button></Tooltip>)}
        </div>
      </div>
    </div>
  </>;
}

export function AccountSection({ session }: { session: Session | null }) {
  return <>
    <div className="sr-group">
      <div className="sr-row">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-[15px] font-semibold" aria-hidden>{(session?.user || "?").slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0"><span className="block truncate text-[15px] font-medium">{session?.user || "Signed in"}</span>
          <span className="block text-[13px] text-muted-foreground">{session?.privileged === true ? "Admin" : "Viewer"}</span></span>
      </div>
      <div className="sr-row flex-wrap justify-between"><span>Session</span><span className="text-[13px] text-muted-foreground">30 days</span></div>
    </div>
  </>;
}

export function ShortcutsSection() {
  return <div className="sr-group">{SHORTCUTS.map(([what, keys]) => <div key={what} className="sr-row flex-wrap justify-between">
    <span className="text-[15px]">{what}</span><kbd className="rounded-md bg-muted px-2 py-1 font-sans text-[13px] text-muted-foreground">{keys}</kbd>
  </div>)}</div>;
}
