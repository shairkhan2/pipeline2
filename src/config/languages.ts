/**
 * languages.ts - language-version catalog and locale-safe path helpers.
 *
 * First release supports ONE language version: Hindi (`hi-IN`). The catalog is
 * curated and offline: the default Hindi voice is Edge (no credentials, no paid
 * provider call), and the Vertex AI voices that also speak Hindi (Chirp 3 HD and
 * Gemini TTS) are listed alongside it so the picker can show them with their real
 * configured/unavailable status instead of silently substituting Edge. A locale
 * string is only ever accepted after `validateLocale`, so a value from an API/CLI
 * can never become a path segment (`../`, absolute paths, NUL, separators are all
 * rejected by the tag allowlist).
 *
 * Layout (per ORIGINAL series out dir):
 *   <out>/languages/hi-IN/ch1/script.md          localized script (localize stage)
 *   <out>/languages/hi-IN/ch1/video/             narration + shots + mp4
 *   <out>/languages/hi-IN/cleaned/ch1/           locale-only cleaner writes
 *   <out>/languages/hi-IN/render_crops/ch1/      locale-only crop writes
 *
 * Shared, English-owned artifacts stay where they are (out/cleaned, out/panels,
 * out/obs_<ch>.json, out/bible.json) and are reused READ-ONLY.
 */

import fs from "node:fs";
import path from "node:path";

/** Locales shipped by this release. Keep in sync with LANGUAGE_CATALOG. */
export const SUPPORTED_LOCALES = ["hi-IN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** TTS engines the pipeline knows how to run for a language voice. */
export type LanguageVoiceEngine = "edge" | "vertex";

export interface LanguageVoice {
  /** Voice id passed to the engine (Edge: `hi-IN-MadhurNeural`). */
  id: string;
  /** Short picker label. */
  label: string;
  engine: LanguageVoiceEngine;
  /** Grouping id for the picker: `edge`, `chirp-3-hd`, `gemini-3.8-flash-tts`, ... */
  modelId?: string;
  /** Human model name for a grouped picker, e.g. `Chirp 3 HD`. */
  modelLabel?: string;
  /** Provider the voice belongs to; derived from `engine` when absent. */
  provider?: string;
  /** False when the provider has no usable credentials in this install. */
  available?: boolean;
  /** Actionable setup hint for an unavailable provider. */
  unavailableReason?: string;
}

export interface LanguageEntry {
  locale: SupportedLocale;
  label: string;
  nativeLabel: string;
  /** Curated voices that work without network discovery or credentials. */
  voices: readonly LanguageVoice[];
  /** Voice used when a caller does not pass `tts.voice_id`. */
  defaultVoiceId: string;
  /** Engine used when a caller does not pass `tts.engine`. */
  defaultEngine: LanguageVoiceEngine;
}

/**
 * Curated, offline catalog. `hi-IN-MadhurNeural` / `hi-IN-SwaraNeural` are the
 * standard multilingual Edge neural voices for Hindi; Edge needs no API key.
 * Quality is NOT claimed as verified live here - this list only says the voice
 * id is a supported Edge Hindi voice.
 *
 * Vertex entries follow the vendor's own naming: Chirp 3 HD ids are
 * `<locale>-Chirp3-HD-<voice>` and Gemini TTS voices are language-agnostic voice
 * NAMES (`Charon`), reached through `gemini-tts:<name>`. Both are GA for hi-IN
 * (cloud.google.com/text-to-speech/docs/chirp3-hd and /gemini-tts). They are
 * listed unconditionally so the picker can show them with their real
 * configured/unavailable status instead of silently falling back to Edge.
 */
const VERTEX_HINDI_VOICES: readonly LanguageVoice[] = [
  {
    id: "hi-IN-Chirp3-HD-Aoede",
    label: "Aoede · Chirp 3 HD",
    engine: "vertex",
    modelId: "chirp-3-hd",
    modelLabel: "Chirp 3 HD",
    provider: "vertex",
  },
  {
    id: "hi-IN-Chirp3-HD-Charon",
    label: "Charon · Chirp 3 HD",
    engine: "vertex",
    modelId: "chirp-3-hd",
    modelLabel: "Chirp 3 HD",
    provider: "vertex",
  },
  {
    id: "hi-IN-Chirp3-HD-Kore",
    label: "Kore · Chirp 3 HD",
    engine: "vertex",
    modelId: "chirp-3-hd",
    modelLabel: "Chirp 3 HD",
    provider: "vertex",
  },
  {
    id: "hi-IN-Chirp3-HD-Puck",
    label: "Puck · Chirp 3 HD",
    engine: "vertex",
    modelId: "chirp-3-hd",
    modelLabel: "Chirp 3 HD",
    provider: "vertex",
  },
  {
    id: "gemini-tts:Charon",
    label: "Charon · Gemini 3.8 Flash TTS",
    engine: "vertex",
    modelId: "gemini-3.8-flash-tts",
    modelLabel: "Gemini 3.8 Flash TTS",
    provider: "vertex",
  },
  {
    id: "gemini-tts:Kore",
    label: "Kore · Gemini 3.8 Flash TTS",
    engine: "vertex",
    modelId: "gemini-3.8-flash-tts",
    modelLabel: "Gemini 3.8 Flash TTS",
    provider: "vertex",
  },
  {
    id: "gemini-tts:Puck",
    label: "Puck · Gemini 3.8 Flash TTS",
    engine: "vertex",
    modelId: "gemini-3.8-flash-tts",
    modelLabel: "Gemini 3.8 Flash TTS",
    provider: "vertex",
  },
  {
    id: "gemini-tts:Aoede",
    label: "Aoede · Gemini 3.8 Flash TTS",
    engine: "vertex",
    modelId: "gemini-3.8-flash-tts",
    modelLabel: "Gemini 3.8 Flash TTS",
    provider: "vertex",
  },
];

export const LANGUAGE_CATALOG: readonly LanguageEntry[] = [
  {
    locale: "hi-IN",
    label: "Hindi",
    nativeLabel: "हिन्दी",
    voices: [
      {
        id: "hi-IN-MadhurNeural",
        label: "Madhur",
        engine: "edge",
        modelId: "edge",
        modelLabel: "Edge",
        provider: "edge",
      },
      {
        id: "hi-IN-SwaraNeural",
        label: "Swara",
        engine: "edge",
        modelId: "edge",
        modelLabel: "Edge",
        provider: "edge",
      },
      ...VERTEX_HINDI_VOICES,
    ],
    defaultVoiceId: "hi-IN-MadhurNeural",
    defaultEngine: "edge",
  },
];

/** Locale used when a caller asks for "a language version" without naming one. */
export const DEFAULT_LANGUAGE_LOCALE: SupportedLocale = "hi-IN";

/** `hi-IN` -> entry; null for anything unsupported. */
export function getLanguageEntry(locale: unknown): LanguageEntry | null {
  const canonical = validateLocale(locale);
  if (canonical === null) return null;
  return LANGUAGE_CATALOG.find((entry) => entry.locale === canonical) ?? null;
}

/**
 * Validate a locale coming from an API/CLI/JSON value.
 * Returns the canonical catalog id (`hi-IN`) or null. Case-insensitive input,
 * but the returned value is always the catalog spelling.
 *
 * The shape is an ALLOWLIST (BCP-47-ish tag), not a denylist: the value later
 * becomes a path segment, so anything outside `xx(-YYY)` is refused outright.
 */
export function validateLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || raw.length > 16) return null;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(raw)) return null;
  const lower = raw.toLowerCase();
  for (const entry of LANGUAGE_CATALOG) {
    if (entry.locale.toLowerCase() === lower) return entry.locale;
  }
  return null;
}

/** True when `value` names a shipped language version. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return validateLocale(value) !== null;
}

/**
 * Validate a chapter id used as a path segment: `ch1`, `ch02`, ... No separators,
 * no dots, no traversal. Returns the id unchanged (callers keep their own naming)
 * or null.
 *
 * One rule for every caller (catalog paths, manifest keys, job records, routes):
 * `ch` plus 1-4 digits, which is also `store.CHAPTER_RE`'s shape. A 5-digit id
 * used to pass here but be refused by the store mid-render.
 */
export function validateChapterId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || raw.length > 16) return null;
  if (!/^ch[0-9]{1,4}$/.test(raw)) return null;
  return raw;
}

function resolveUnder(root: string, target: string): string {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const rel = path.relative(rootAbs, targetAbs);
  // `rel === ""` is the root itself, which is allowed.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes its root: ${targetAbs} not under ${rootAbs}`);
  }
  return targetAbs;
}

/**
 * Refuse a symlinked locale output / staging path.
 *
 * Every existing component under `root` down to `target` must be a real
 * directory/file, not a link, and `target` must stay under `root`. Missing
 * components are fine: they are created later by the caller, inside the root.
 * `root` itself is a trusted configured base and is not checked.
 */
export function assertNoSymlinkPath(root: string, target: string): void {
  const rootAbs = path.resolve(root);
  const targetAbs = resolveUnder(rootAbs, target);
  const rel = path.relative(rootAbs, targetAbs);
  const parts = rel === "" ? [] : rel.split(path.sep);
  const check = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symlinked locale path: ${p}`);
    }
  };
  let cur = rootAbs;
  for (const part of parts) {
    cur = path.join(cur, part);
    check(cur);
  }
}

/**
 * Output directory for one localized chapter:
 * `<out>/languages/<locale>/<ch>`.
 *
 * `out` is the ORIGINAL series out dir (`series/<slug>/out`), never a locale dir,
 * so calling this twice can never nest `languages/languages`. Throws on an
 * unsupported locale, an invalid chapter id, or a traversal attempt.
 */
export function languageChapterDir(out: string, locale: string, ch: string): string {
  const loc = validateLocale(locale);
  if (loc === null) {
    throw new Error(`unsupported locale: ${JSON.stringify(String(locale))}`);
  }
  const chapter = validateChapterId(ch);
  if (chapter === null) {
    throw new Error(`invalid chapter id: ${JSON.stringify(String(ch))}`);
  }
  if (typeof out !== "string" || out.trim() === "") {
    throw new Error("languageChapterDir: out dir is required");
  }
  const root = path.resolve(out);
  const dir = resolveUnder(root, path.join(root, "languages", loc, chapter));
  return dir;
}

/** Locale working root: `<out>/languages/<locale>`. Throws on unsupported locale/traversal. */
export function languageRootDir(out: string, locale: string): string {
  const loc = validateLocale(locale);
  if (loc === null) throw new Error(`unsupported locale: ${JSON.stringify(String(locale))}`);
  const root = path.resolve(out);
  return resolveUnder(root, path.join(root, "languages", loc));
}

/** Remotion staging id for a localized chapter, e.g. `my-series_ch1_hi-IN`. */
export function languageStagingId(slug: string, ch: string, locale: string): string {
  const loc = validateLocale(locale);
  if (loc === null) throw new Error(`unsupported locale: ${JSON.stringify(String(locale))}`);
  const chapter = validateChapterId(ch);
  if (chapter === null) throw new Error(`invalid chapter id: ${JSON.stringify(String(ch))}`);
  const clean = String(slug ?? "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!clean) throw new Error("languageStagingId: empty series slug");
  return `${clean}_${chapter}_${loc}`;
}
