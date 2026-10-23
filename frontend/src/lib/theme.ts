import { useCallback, useEffect, useState } from "react";

/**
 * Appearance: light/dark/system mode plus a theme colour. Both live in
 * localStorage and are applied to <html> as `.dark`, `data-theme` and
 * `data-accent`. The inline script in each HTML entry applies them before
 * first paint, so pages never flash the wrong mode.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAccent = "ink" | "blue" | "violet" | "pink" | "coral" | "teal";

export const THEME_MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match system" },
];

/** Swatch colours mirror `--primary` for each accent in index.css. */
export const THEME_ACCENTS: ReadonlyArray<{ id: ThemeAccent; label: string; light: string; dark: string }> = [
  { id: "ink", label: "Graphite", light: "#18181b", dark: "#f4f4f5" },
  { id: "blue", label: "Blue", light: "#2563eb", dark: "#8ab4f8" },
  { id: "violet", label: "Violet", light: "#7c3aed", dark: "#c4a7ff" },
  { id: "pink", label: "Pink", light: "#db2777", dark: "#f9a8d4" },
  { id: "coral", label: "Coral", light: "#c2410c", dark: "#fda47e" },
  { id: "teal", label: "Teal", light: "#0f766e", dark: "#5eead4" },
];

export const THEME_MODE_KEY = "sr-theme-mode";
export const THEME_ACCENT_KEY = "sr-theme-accent";
const CHANGE_EVENT = "sr-theme-change";
const CANVAS = { light: "#ffffff", dark: "#1b1b1d" } as const;

function isMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function isAccent(value: unknown): value is ThemeAccent {
  return THEME_ACCENTS.some((accent) => accent.id === value);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readThemeMode(): ThemeMode {
  const value = read(THEME_MODE_KEY);
  return isMode(value) ? value : "system";
}

export function readThemeAccent(): ThemeAccent {
  const value = read(THEME_ACCENT_KEY);
  return isAccent(value) ? value : "ink";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** Apply mode + accent to <html> and the browser chrome colour. Returns the resolved mode. */
export function applyTheme(mode: ThemeMode = readThemeMode(), accent: ThemeAccent = readThemeAccent()): "light" | "dark" {
  const resolved = resolveThemeMode(mode);
  if (typeof document === "undefined") return resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.accent = accent;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = CANVAS[resolved];
  });
  return resolved;
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode: the choice still applies to this page. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Current appearance plus setters. Every mounted copy stays in sync, across tabs too. */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(readThemeMode);
  const [accent, setAccentState] = useState<ThemeAccent>(readThemeAccent);
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveThemeMode(readThemeMode()));

  useEffect(() => {
    const sync = () => {
      const nextMode = readThemeMode();
      const nextAccent = readThemeAccent();
      setModeState(nextMode);
      setAccentState(nextAccent);
      setResolved(applyTheme(nextMode, nextAccent));
    };
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const onMedia = () => {
      if (readThemeMode() === "system") sync();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_MODE_KEY || event.key === THEME_ACCENT_KEY) sync();
    };
    media?.addEventListener?.("change", onMedia);
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, sync);
    sync();
    return () => {
      media?.removeEventListener?.("change", onMedia);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => store(THEME_MODE_KEY, next), []);
  const setAccent = useCallback((next: ThemeAccent) => store(THEME_ACCENT_KEY, next), []);

  return { mode, accent, resolved, setMode, setAccent };
}
