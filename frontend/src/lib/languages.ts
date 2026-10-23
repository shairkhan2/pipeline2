/**
 * Pure Hindi language-version types and helpers.
 *
 * Nothing here touches the DOM, `window`, `fetch`, or any browser global, so
 * backend test suites can import it under the Node `ES2023` lib. The HTTP
 * client in `api.ts` re-exports everything below.
 */

export type LanguageVersionStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface LanguageVoice {
  id: string;
  label: string;
  engine?: string;
  /** Provider identity: `edge`, `vertex`, ... */
  provider?: string;
  /** Picker grouping, e.g. `edge`, `chirp-3-hd`, `gemini-3.8-flash-tts`. */
  modelId?: string;
  /** Human model name for the group header. */
  modelLabel?: string;
  /** False when this install has no usable credentials for the provider. */
  available?: boolean;
  /** Actionable setup hint when `available` is false. */
  unavailableReason?: string;
}

export interface LanguageCatalogEntry {
  locale: string;
  label: string;
  nativeLabel?: string;
  voices: LanguageVoice[];
}

export interface LanguageSourceChapter {
  chapter: string;
  eligible: boolean;
  reason?: string;
}

export interface LanguageChapterVersion {
  chapter: string;
  status: LanguageVersionStatus;
  stage?: string;
  error?: string;
  /** Canonical media URL from the server, already carrying its `?rev=` bust. */
  videoUrl?: string;
  duration?: number;
  updatedAt?: string;
  stale?: boolean;
  /** Voice the chapter was last requested with. Retry reuses it instead of the modal choice. */
  voice?: string;
  /** Narration speed the chapter was last requested with. */
  speed?: number;
  /** Saved provider identity of that voice, so a retry resends exactly it. */
  engine?: string;
  provider?: string;
  modelId?: string;
  /** Non-fatal render warnings and advisory English-script review findings. */
  warnings?: string[];
}

export interface LanguageVersion {
  locale: string;
  label?: string;
  status: LanguageVersionStatus;
  stage?: string;
  error?: string;
  updatedAt?: string;
  chapters: LanguageChapterVersion[];
  /** Version-level fallback for chapters that do not carry their own request settings. */
  voice?: string;
  speed?: number;
  engine?: string;
  provider?: string;
  modelId?: string;
  /** Pending server-side retry: `count` is the retry about to run, `at` is ISO time. */
  autoRetry?: { count: number; max: number; at: string };
}

export interface SeriesLanguagesState {
  ok: boolean;
  slug: string;
  catalog: LanguageCatalogEntry[];
  sourceChapters: LanguageSourceChapter[];
  versions: LanguageVersion[];
}

export interface LanguageGenerateInput {
  locale: string;
  chapters: string;
  voice: string;
  speed?: number;
}

export interface LanguagePreviewResult {
  ok: boolean;
  url: string;
}

/** A chapter left out of the next merge, with a short human reason. */
export interface LanguageExportChapterNote {
  chapter: string;
  reason: string;
}

/**
 * `GET /api/series/:slug/languages/:locale/export`: everything the merge,
 * outro and download UI needs for one language version.
 */
export interface LanguageExportState {
  ok: true;
  slug: string;
  locale: string;
  label: string;
  chapters: {
    /** Every verified chapter in numeric order: exactly what Merge joins. */
    finished: string[];
    /** No usable video yet (not started, rendering, or failed). Merge skips them. */
    missing: LanguageExportChapterNote[];
    /** Subset of `finished` made with older settings/source. Merged as is (like English); offer a re-render. */
    stale: LanguageExportChapterNote[];
  };
  canMerge: boolean;
  /** Short reason when `canMerge` is false. */
  reason: string | null;
  canGenerateOutro: boolean;
  outroReason: string | null;
  busy: { job: boolean; jobId: string | null; merge: boolean; outro: boolean; message: string | null };
  /** What a Merge click does right now. */
  nextMerge: { chapters: string[]; includesOutro: boolean; filename: string };
  merged: {
    exists: boolean;
    /** Player URL with a `?rev=` cache bust. */
    url: string | null;
    /** Same file with `?download=1` (Content-Disposition: attachment). */
    downloadUrl: string | null;
    filename: string | null;
    chapters: string[];
    includesOutro: boolean;
    sizeBytes: number;
    duration: number | null;
    mergedAt: string | null;
    /** The file no longer matches what Merge would produce now: offer "Merge again". */
    stale: boolean;
    staleReason: string | null;
  };
  outro: {
    exists: boolean;
    videoUrl: string | null;
    downloadUrl: string | null;
    filename: string;
    duration: number | null;
    voice: string | null;
    speed: number | null;
    engine: string | null;
    /** `english-plan`: same panels + translated English narration; `generated`: built for this language. */
    source: "english-plan" | "generated" | null;
    generatedAt: string | null;
    /** Translated narration text. */
    script: string | null;
    /** The English outro changed or was removed after this outro was made. */
    stale: boolean;
    staleReason: string | null;
    hasEnglishPlan: boolean;
    /** Voice/speed used when the request names none (newest finished language job). */
    defaultVoice: string | null;
    defaultSpeed: number | null;
    includedInNextMerge: boolean;
  };
  /** Latest background merge outcome; null before the first merge. */
  lastMerge: LanguageExportOutcome | null;
  /** Latest background outro outcome; null before the first outro. */
  lastOutro: LanguageExportOutcome | null;
}

/**
 * Outcome of the latest background merge or outro run (`lastMerge` / `lastOutro`).
 * `running`: in progress. `done`: finished. `failed`: the run hit an error.
 * `interrupted`: the server restarted mid-run. Previous files are unchanged in
 * every non-`done` case.
 */
export interface LanguageExportOutcome {
  status: "running" | "done" | "failed" | "interrupted";
  /** Error code for failed/interrupted (`merge_failed`, `outro_tts_failed`, `interrupted`, ...), else null. */
  code: string | null;
  /** Short human text to show. */
  message: string;
  /** Raw technical cause for a "details" disclosure. */
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** True while a merge or outro runs: poll `languageExport` every 3 s. */
export function isLanguageExportBusy(state: LanguageExportState | null | undefined): boolean {
  return Boolean(state && (state.busy.merge || state.busy.outro));
}

/** Compact export controls; server capability flags remain authoritative. */
export function languageExportControls(state: LanguageExportState, pending = false) {
  const busy = pending || isLanguageExportBusy(state) || state.busy.job;
  return {
    busy,
    mergeDisabled: busy || !state.canMerge || !state.chapters.finished.length,
    outroDisabled: busy || !state.canGenerateOutro,
    mergeLabel: state.busy.merge ? "Merging…" : state.merged.stale ? "Merge again" : `Merge ${state.chapters.finished.length}`,
    status: state.busy.outro ? "Making Hindi outro…" : state.busy.message,
  };
}

/** Recovery copy for all immediate export conflicts and field errors. */
export function languageExportErrorLabel(code?: string): string {
  const labels: Record<string, string> = {
    job_active: "Wait for Hindi chapters", export_busy: "Export in progress", series_busy: "Try again shortly",
    nothing_to_merge: "No finished chapters", outro_missing: "Generate outro", source_missing: "Chapter video missing",
    unsupported_voice: "Choose another voice", provider_unavailable: "Voice unavailable", missing_voice: "Choose a voice",
    invalid_speed: "Check speed", invalid_outro_field: "Check outro settings", invalid_field: "Check outro settings",
  };
  return labels[code ?? ""] ?? "Export couldn’t start";
}

export interface LanguageMergeInput {
  /** Omit to include the outro when one exists. `false` merges chapters only. */
  includeOutro?: boolean;
}

export interface LanguageOutroInput {
  /** Defaults to the newest finished language job's voice. */
  voice?: string;
  /** 0.5-2; defaults to that job's speed. */
  speed?: number;
  /** Setting any of these builds a fresh outro instead of reusing the English plan. */
  hookType?: "part2" | "next_chapter" | "new_series" | "custom";
  totalChapters?: number;
  coveredChapters?: number;
  customNote?: string;
  nextSeriesTitle?: string;
}

/** Error body of every language export endpoint: short `error`, optional raw `detail`. */
export interface LanguageExportError {
  error: string;
  code?: string;
  detail?: string;
}

/** Lowest and highest narration speed the language renderer accepts. */
export const LANGUAGE_SPEED_MIN = 0.5;
export const LANGUAGE_SPEED_MAX = 2;

/**
 * Chapter selection accepted by `POST /api/series/:slug/languages`:
 * a single chapter (`1`), an inclusive range (`1-3`), an explicit list
 * (`1,3`), or `all`. Comma lists are always sent as exact chapter numbers so a
 * non-contiguous retry never widens into a range that re-renders good chapters.
 */
export type LanguageChapterSpec =
  | { ok: true; value: string; numbers: number[] }
  | { ok: false; error: string };

export function languageChapterSpec(spec: string): LanguageChapterSpec {
  const raw = spec.trim();
  if (!raw) return { ok: false, error: "Choose at least one chapter, for example 1." };
  if (raw.toLowerCase() === "all") return { ok: true, value: "all", numbers: [] };

  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.some((token) => !token)) return { ok: false, error: "Use chapters like 1, 1-3, 1,3, or all." };

  const numbers: number[] = [];
  for (const token of tokens) {
    const single = token.match(/^(\d+)$/);
    if (single) {
      const value = Number(single[1]);
      if (!Number.isInteger(value) || value < 1) return { ok: false, error: "Chapter numbers start at 1." };
      numbers.push(value);
      if (numbers.length > 500) return { ok: false, error: "Pick 500 chapters or fewer." };
      continue;
    }
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!range) return { ok: false, error: "Use chapters like 1, 1-3, 1,3, or all." };
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from < 1 || to < 1) return { ok: false, error: "Chapter numbers start at 1." };
    if (from > to) return { ok: false, error: "The range ends before it starts. Try 1-3." };
    if (to - from > 500) return { ok: false, error: "Pick a range of 500 chapters or fewer." };
    for (let value = from; value <= to; value += 1) {
      numbers.push(value);
      // The cap is global, not per token: `1-300,1-300` must not build a huge body.
      if (numbers.length > 500) return { ok: false, error: "Pick 500 chapters or fewer." };
    }
  }

  const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
  if (!unique.length) return { ok: false, error: "Choose at least one chapter, for example 1." };
  // A single typed range keeps its compact form; anything else is exact numbers.
  const compact = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (compact) return { ok: true, value: `${Number(compact[1])}-${Number(compact[2])}`, numbers: unique };
  return { ok: true, value: unique.join(","), numbers: unique };
}

/** Default selection: the first chapter whose English render can be reused. */
export function defaultLanguageChapters(sourceChapters: readonly LanguageSourceChapter[]): string {
  const first = sourceChapters.find((chapter) => chapter.eligible);
  if (!first) return "";
  const digits = String(first.chapter).match(/(\d+)/);
  return digits ? String(Number(digits[1])) : "";
}

/** Sorted, unique chapter numbers expressed as inclusive ranges without gaps. */
export function compressChapterNumbers(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers.filter((number) => Number.isSafeInteger(number) && number > 0))]
    .sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index]!;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index]!;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(",");
}

export interface ResolvedLanguageChapters {
  numbers: number[];
  skipped: number[];
  value: string;
  error?: string;
}

/** Resolve a typed batch against English renders before sending any request. */
export function resolveLanguageChapters(
  spec: string,
  sourceChapters: readonly LanguageSourceChapter[],
): ResolvedLanguageChapters {
  const empty = { numbers: [], skipped: [], value: "" };
  if (!spec.trim()) return empty;
  const eligible = new Set(sourceChapters.filter((chapter) => chapter.eligible)
    .map((chapter) => languageChapterNumber(chapter.chapter))
    .filter((number) => Number.isSafeInteger(number) && number > 0));
  let requested: number[];
  if (spec.trim().toLowerCase() === "all") {
    requested = [...eligible].sort((a, b) => a - b);
  } else {
    // Reject unsafe integers before the legacy parser can expand a range.
    if ((spec.match(/\d+/g) ?? []).some((token) => !Number.isSafeInteger(Number(token)))) {
      return { ...empty, error: "Use valid chapter numbers." };
    }
    const parsed = languageChapterSpec(spec);
    if (!parsed.ok) return { ...empty, error: parsed.error };
    requested = parsed.numbers;
  }
  if (requested.length > 500) return { ...empty, error: "Pick 500 chapters or fewer." };
  const numbers = requested.filter((number) => eligible.has(number));
  const skipped = requested.filter((number) => !eligible.has(number));
  return { numbers, skipped, value: compressChapterNumbers(numbers) };
}

/** True while the server is still working on any chapter of this version. */
export function isLanguageVersionActive(version: LanguageVersion): boolean {
  if (version.status === "queued" || version.status === "running") return true;
  return version.chapters.some((chapter) => chapter.status === "queued" || chapter.status === "running");
}

/** Chapters whose work stopped without a usable result. */
export function isLanguageChapterRetryable(chapter: LanguageChapterVersion): boolean {
  return chapter.status === "failed" || chapter.status === "interrupted";
}

/** Chapter number as the API spells it (`ch3` -> `3`), or 0 when unparseable. */
export function languageChapterNumber(chapter: string): number {
  const digits = String(chapter).match(/(\d+)/);
  return digits ? Number(digits[1]) : 0;
}

export interface LanguageRetrySettings {
  voice?: string;
  speed?: number;
  /** Provider identity of the saved voice; echoed back so a retry cannot drift. */
  engine?: string;
  provider?: string;
  modelId?: string;
}

/**
 * Request settings a chapter was last rendered with. The server records them on
 * the chapter and falls back to the version; nothing is guessed from the modal.
 */
export function languageChapterSettings(
  version: LanguageVersion,
  chapter: LanguageChapterVersion,
): LanguageRetrySettings {
  const voice = chapter.voice || version.voice || undefined;
  const speed =
    typeof chapter.speed === "number" && Number.isFinite(chapter.speed)
      ? chapter.speed
      : typeof version.speed === "number" && Number.isFinite(version.speed)
        ? version.speed
        : undefined;
  const engine = chapter.engine || version.engine || undefined;
  const provider = chapter.provider || version.provider || undefined;
  const modelId = chapter.modelId || version.modelId || undefined;
  return {
    voice,
    speed,
    ...(engine ? { engine } : {}),
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

export interface LanguageRetryGroup {
  locale: string;
  voice: string;
  speed: number;
  engine?: string;
  provider?: string;
  modelId?: string;
  /** Exact chapter numbers, comma separated: `1,3`. */
  chapters: string;
  chapterNames: string[];
}

/**
 * Group retryable chapters by their saved voice, speed and provider identity. A
 * retry must resend the original settings, so a range is never used and chapters
 * with different settings are never merged into one request.
 */
export function languageRetryGroups(
  version: LanguageVersion,
  voices: readonly LanguageVoice[],
): { groups: LanguageRetryGroup[]; unknown: LanguageChapterVersion[] } {
  const known = new Set(voices.map((voice) => voice.id));
  const groups = new Map<string, LanguageRetryGroup>();
  const unknown: LanguageChapterVersion[] = [];
  for (const chapter of version.chapters) {
    if (!isLanguageChapterRetryable(chapter)) continue;
    const { voice, speed, engine, provider, modelId } = languageChapterSettings(version, chapter);
    const number = languageChapterNumber(chapter.chapter);
    if (
      !voice ||
      !known.has(voice) ||
      speed === undefined ||
      speed < LANGUAGE_SPEED_MIN ||
      speed > LANGUAGE_SPEED_MAX ||
      !number
    ) {
      unknown.push(chapter);
      continue;
    }
    const key = `${voice}|${speed}`;
    const group = groups.get(key) ?? {
      locale: version.locale,
      voice,
      speed,
      ...(engine ? { engine } : {}),
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      chapters: "",
      chapterNames: [],
    };
    group.chapterNames.push(chapter.chapter);
    groups.set(key, group);
  }
  // Chapter numbers are derived once per group, after the loop.
  for (const group of groups.values()) {
    const numbers = group.chapterNames.map(languageChapterNumber).sort((a, b) => a - b);
    group.chapters = numbers.join(",");
  }
  return { groups: Array.from(groups.values()), unknown };
}

/**
 * Media URL for a language chapter. The server's own `videoUrl` is canonical:
 * it carries the artifact revision (`?rev=`) and must not be rebuilt here. The
 * fallback path is only for older payloads that omit `videoUrl`.
 */
export function languageMediaUrl(
  videoUrl: string | undefined,
  fallback: { slug: string; locale: string; chapter: string },
  download = false,
): string {
  const base =
    videoUrl && videoUrl.trim()
      ? videoUrl
      : `/media/${encodeURIComponent(fallback.slug)}/languages/${encodeURIComponent(fallback.locale)}/${encodeURIComponent(fallback.chapter)}/video.mp4`;
  if (!download) return base;
  return `${base}${base.includes("?") ? "&" : "?"}download=1`;
}

/** True when the chapter still has a playable video from an earlier render. */
export function hasLanguageVideo(chapter: LanguageChapterVersion): boolean {
  return Boolean(chapter.videoUrl && chapter.videoUrl.trim());
}

/**
 * Merge a quiet poll result without letting an older snapshot undo a fresher
 * one: an older version never replaces a newer one, and it never stops an active
 * run on its own. A snapshot with no usable timestamp cannot replace a dated one.
 */
export function mergeNewerSnapshot(
  current: SeriesLanguagesState | null,
  incoming: SeriesLanguagesState,
): SeriesLanguagesState {
  if (!current) return incoming;
  const versions = incoming.versions.map((next) => {
    const prev = current.versions.find((version) => version.locale === next.locale);
    if (!prev) return next;
    const prevTime = Date.parse(prev.updatedAt ?? "") || 0;
    const nextTime = Date.parse(next.updatedAt ?? "") || 0;
    if (!nextTime && prevTime) return prev;
    if (nextTime < prevTime) return prev;
    if (isLanguageVersionActive(prev) && !isLanguageVersionActive(next) && nextTime <= prevTime) return prev;
    return next;
  });
  return { ...incoming, versions };
}

/** All chapter notes, including source-review advisories mixed in by the server. */
export function languageChapterWarnings(chapter: LanguageChapterVersion): string[] {
  return Array.isArray(chapter.warnings)
    ? chapter.warnings.map((warning) => String(warning ?? "").trim()).filter(Boolean)
    : [];
}

/** Known deterministic source heuristics are review context, not render problems. */
export function languageChapterNotes(chapter: LanguageChapterVersion): { actionable: string[]; review: string[] } {
  const actionable: string[] = [];
  const review: string[] = [];
  for (const warning of new Set(languageChapterWarnings(chapter))) {
    const advisory = /^(?:UNGROUNDED|LORE IMPORT|DUB|SCREENREADER|CAPTION|MULTI)\b/i.test(warning)
      || /^report\.json listed \d+ issue\(s\), but the deterministic check on the current script passes\./i.test(warning);
    (advisory ? review : actionable).push(warning);
  }
  return { actionable, review };
}

/** Only known stage names may appear outside Details. */
export function languageChapterStage(stage?: string): string {
  const labels: Record<string, string> = {
    queued: "Queued", source: "Checking source", translate: "Translating", review: "Reviewing",
    audio: "Making audio", tts: "Making audio", timing: "Timing", timeline: "Timing",
    render: "Rendering", verify: "Verifying",
  };
  return labels[stage ?? ""] ?? "";
}

/** One short notice, ordered by the action most relevant to the chapter. */
export function languageChapterNotice(chapter: LanguageChapterVersion): { tone: "danger" | "warning"; text: string } | null {
  if (chapter.error || chapter.status === "failed" || chapter.status === "interrupted") {
    const knownStage = languageChapterStage(chapter.stage);
    return { tone: "danger", text: chapter.status === "interrupted" ? "Generation interrupted"
      : knownStage && chapter.stage !== "queued" ? `Failed at ${chapter.stage}` : "Generation failed" };
  }
  if (chapter.stale) return { tone: "warning", text: "Older version · Generate again to update" };
  if (languageChapterNotes(chapter).actionable.length) return { tone: "warning", text: "Check generated video" };
  return null;
}

/* ------------------------------------------------------------------ *
 * Voice picker grouping (pure: no DOM, no fetch)
 * ------------------------------------------------------------------ */

export interface LanguageVoiceModelGroup {
  /** Stable group id: `edge`, `chirp-3-hd`, `gemini-3.8-flash-tts`. */
  id: string;
  /** Group header, e.g. `Edge`, `Vertex · Chirp 3 HD`. */
  label: string;
  provider: string;
  providerLabel: string;
  voices: LanguageVoice[];
  /** False when no voice in this group can be rendered right now. */
  available: boolean;
  /** Actionable setup hint when the whole group is unavailable. */
  unavailableReason?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  edge: "Edge",
  vertex: "Vertex",
};

/** Display name for a provider id. */
export function languageProviderLabel(provider: string | undefined, engine?: string): string {
  const id = String(provider || engine || "").trim().toLowerCase();
  if (!id) return "Voice";
  return PROVIDER_LABELS[id] ?? (id.charAt(0).toUpperCase() + id.slice(1));
}

/** Model group id for a voice; falls back to provider then engine. */
export function languageVoiceModelId(voice: LanguageVoice): string {
  const explicit = String(voice.modelId ?? "").trim();
  if (explicit) return explicit;
  const provider = String(voice.provider ?? voice.engine ?? "").trim();
  return provider || "voice";
}

/** True unless the server explicitly reports the provider as unconfigured. */
export function isLanguageVoiceAvailable(voice: LanguageVoice): boolean {
  return voice.available !== false;
}

/**
 * Group a locale's voices by provider and model for a picker.
 *
 * Unavailable groups are kept (with their setup hint) so the UI can explain the
 * missing credentials instead of quietly offering Edge as if it were the only
 * option. Order follows the catalog, which lists Edge first.
 */
export function languageVoiceGroups(voices: readonly LanguageVoice[]): LanguageVoiceModelGroup[] {
  const groups = new Map<string, LanguageVoiceModelGroup>();
  for (const voice of voices) {
    const provider = String(voice.provider ?? voice.engine ?? "voice");
    const id = languageVoiceModelId(voice);
    const key = `${provider}|${id}`;
    const providerLabel = languageProviderLabel(provider, voice.engine);
    const existing = groups.get(key);
    if (existing) {
      existing.voices.push(voice);
      // A partially configured group must not read as fully configured.
      if (!isLanguageVoiceAvailable(voice)) {
        existing.available = false;
        existing.unavailableReason = existing.unavailableReason ?? voice.unavailableReason;
      }
      continue;
    }
    const modelLabel = String(voice.modelLabel ?? "").trim();
    groups.set(key, {
      id,
      label: provider === "edge" || !modelLabel || modelLabel === providerLabel
        ? providerLabel
        : `${providerLabel} · ${modelLabel}`,
      provider,
      providerLabel,
      voices: [voice],
      available: isLanguageVoiceAvailable(voice),
      ...(isLanguageVoiceAvailable(voice) ? {} : { unavailableReason: voice.unavailableReason }),
    });
  }
  return [...groups.values()];
}

/** The first voice that can actually be rendered, or "" when none can. */
export function firstAvailableLanguageVoice(voices: readonly LanguageVoice[]): string {
  return voices.find((voice) => isLanguageVoiceAvailable(voice))?.id ?? "";
}

/** Why a specific voice cannot be used, or "" when it can. */
export function languageVoiceUnavailableReason(voices: readonly LanguageVoice[], id: string): string {
  const voice = voices.find((item) => item.id === id);
  if (!voice || isLanguageVoiceAvailable(voice)) return "";
  return voice.unavailableReason || `${languageProviderLabel(voice.provider, voice.engine)} is not configured on this server.`;
}
