/**
 * Language-version (localization) shared types.
 *
 * `config/languages.ts` is the catalog/path authority; these shapes describe
 * the durable state and the HTTP view.
 */

export interface LanguageVoice {
  id: string;
  label: string;
  engine: string;
  /** Provider identity: `edge`, `vertex`, ... */
  provider?: string;
  /** Picker grouping, e.g. `chirp-3-hd`, `gemini-3.8-flash-tts`. */
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
  nativeLabel: string;
  voices: LanguageVoice[];
}

export type LocaleChapterStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type LocaleStage =
  | "validate"
  | "translate"
  | "review"
  | "render"
  | "verify";

/** A verified, published video. This is LAST-KNOWN-GOOD state: it survives a
 * failed or in-flight regeneration so the previous video keeps streaming.
 */
export interface LocaleArtifact {
  /** Always the canonical locale video path, re-derived on read. */
  video: string;
  duration: number;
  size: number;
  videoSha256: string;
  renderKey: string;
  voice: string;
  speed: number;
  /** Authoritative render identity, persisted so a retry/cache hit never guesses. */
  engine?: string;
  provider?: string;
  modelId?: string;
  locale?: string;
  /** Monotonic per chapter; changes only when a NEW verified video is published. */
  revision: number;
  publishedAt: string;
}

/** Proof that the Hindi script on disk is the reviewed output of a translation run. */
export interface LocaleTranslationProof {
  /** Translation identity (source + prompt + model + used glossary snapshot). */
  key: string;
  /** sha256 of the exact localized script bytes that were reviewed. */
  scriptHash: string;
  unitCount: number;
  reviewedAt: string;
}

/** Attempt state for the CURRENT run. Never destroys `artifact`. */
export interface LocaleChapterRecord {
  status: LocaleChapterStatus;
  stage?: LocaleStage;
  error?: string;
  updatedAt: string;
  voice?: string;
  speed?: number;
  /** Provider identity of the saved settings (derived from the voice when absent). */
  engine?: string;
  provider?: string;
  modelId?: string;
  locale?: string;
  /** Last good published video, if any. */
  artifact?: LocaleArtifact;
  /** Proof for the on-disk localized script, if any. */
  translation?: LocaleTranslationProof;
  /** Last good video does not match current source/settings. */
  stale?: boolean;
  warnings?: string[];
}

export interface LocaleVersionRecord {
  updatedAt: string;
  chapters: Record<string, LocaleChapterRecord>;
}

export interface LanguageManifest {
  schemaVersion: 1;
  locales: Record<string, LocaleVersionRecord>;
}

export interface LocaleJobProgress {
  status: LocaleChapterStatus;
  stage?: LocaleStage;
  error?: string;
  updatedAt: string;
}

export interface LocalizeJobRecord {
  schemaVersion: 1;
  id: string;
  slug: string;
  locale: string;
  chapters: string[];
  voice: string;
  speed: number;
  /**
   * Authoritative provider identity of the saved voice. Persisted so a restart,
   * retry or preview resolves the SAME engine/model instead of guessing from the
   * voice id. Older jobs without it are derived from the catalog.
   */
  engine?: string;
  provider?: string;
  modelId?: string;
  status: LocaleChapterStatus;
  stage?: LocaleStage;
  chapter?: string;
  error?: string;
  pid?: number | null;
  pidStart?: number | null;
  pidBootId?: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: Record<string, number>;
  /** Per-chapter status of THIS job, including chapters not yet started. */
  progress?: Record<string, LocaleJobProgress>;
  warnings?: string[];
  /** Automatic retries already spent in this job's chain (0 for a user-started job). */
  autoRetryCount?: number;
  /** When the server retries this job by itself; null once dropped, absent when not scheduled yet. */
  nextAutoRetryAt?: string | null;
}

export interface LanguageSourceChapter {
  chapter: string;
  eligible: boolean;
  reason?: string;
}

export interface LanguageChapterView {
  chapter: string;
  status: LocaleChapterStatus;
  stage?: string;
  error?: string;
  videoUrl?: string;
  duration?: number;
  updatedAt?: string;
  stale?: boolean;
  voice?: string;
  speed?: number;
  /** Saved provider identity, so a retry resends exactly what rendered. */
  engine?: string;
  provider?: string;
  modelId?: string;
  warnings?: string[];
}

export interface LanguageVersionView {
  locale: string;
  label: string;
  status: LocaleChapterStatus;
  stage?: string;
  error?: string;
  updatedAt: string;
  voice?: string;
  speed?: number;
  engine?: string;
  provider?: string;
  modelId?: string;
  /** Pending server-side retry of the latest job: `count` is the retry about to run. */
  autoRetry?: { count: number; max: number; at: string };
  chapters: LanguageChapterView[];
}

export interface LanguagesState {
  ok: true;
  slug: string;
  catalog: LanguageCatalogEntry[];
  sourceChapters: LanguageSourceChapter[];
  versions: LanguageVersionView[];
}

/** The locale-aware renderer contract implemented by `workers/renderlane.ts`. */
export interface LocaleTtsOptions {
  engine: "edge" | "vertex";
  voice_id: string;
  language: string;
  speed: number;
  /** Provider identity; the renderer passes it through to the TTS adapter. */
  provider?: string;
  /** Model family the voice belongs to (`chirp-3-hd`, `gemini-3.8-flash-tts`). */
  model?: string;
}

export interface LocaleProduceOptions {
  locale: string;
  tts: LocaleTtsOptions;
  lane: "local";
  log?: (msg: string) => void;
}

export type LocaleProduceFn = (
  sdir: string,
  ch: string,
  out: string,
  opts: LocaleProduceOptions,
) => Promise<[string, number] | [string, number, string[]]>;
