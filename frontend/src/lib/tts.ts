export interface TtsCatalogLike {
  defaultProvider?: string;
  providers?: Array<Record<string, unknown>>;
}

export interface StudioProviderLike {
  id: string;
  label?: string;
  preset?: string;
  kind?: string;
  protocol?: string;
  enabled?: boolean;
  auth?: {
    mode?: string;
    hasSecret?: boolean;
  };
}

export interface TtsVoiceItem {
  /** Canonical voice ID submitted to preview and job creation (e.g. "en-US-Chirp3-HD-Charon", "gemini-tts:Charon"). */
  id: string;
  /** Concise human voice name only (e.g. "Charon", "Andrew Multilingual"). */
  label: string;
  rawLabel: string;
  modelId: string;
  modelLabel: string;
  default: boolean;
}

export interface TtsModelGroup {
  id: string;
  label: string;
  voices: TtsVoiceItem[];
}

export interface TtsProviderGroup {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string;
  costNotice: string;
  engine: string;
  hasExplicitModels: boolean;
  models: TtsModelGroup[];
  voices: TtsVoiceItem[];
  /** Engine-level synthesis models (ElevenLabs), separate from the voice grouping in `models`. */
  synthModels?: TtsSynthModel[];
  defaultSynthModel?: string;
  allowCustomVoice?: boolean;
}

export interface TtsSynthModel {
  id: string;
  label: string;
  tags: boolean;
}

export const ELEVENLABS_VOICE_ID_RE = /^[A-Za-z0-9]{16,40}$/;

export function isElevenLabsProvider(provider: { id?: string; engine?: string } | null | undefined): boolean {
  return Boolean(provider && (provider.engine === "elevenlabs" || provider.id === "elevenlabs"));
}

export function parseSynthModels(raw: unknown): TtsSynthModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: unknown) => {
    if (!m || typeof m !== "object") return [];
    const rec = m as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) return [];
    return [{ id, label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : id, tags: rec.tags === true }];
  });
}

export interface PreferredVoiceRecord {
  providerId: string;
  modelId?: string;
  voiceId: string;
  engine?: string;
  voiceLabel?: string;
}

const MODEL_LABEL_MAP: Record<string, string> = {
  "chirp-3-hd": "Chirp 3 HD",
  chirp: "Chirp 3 HD",
  "chirp3-hd": "Chirp 3 HD",
  "gemini-3.8-flash-tts": "Gemini 3.8 Flash TTS",
  "gemini-tts": "Gemini 3.8 Flash TTS",
  gemini: "Gemini 3.8 Flash TTS",
  studio: "Studio",
  neural2: "Neural2",
  journey: "Journey",
  polyglot: "Polyglot",
  news: "News",
  wavenet: "WaveNet",
  standard: "Standard",
  default: "Default",
};

const MODEL_ID_CANONICAL: Record<string, string> = {
  "chirp-3-hd": "chirp-3-hd",
  chirp: "chirp-3-hd",
  "chirp3-hd": "chirp-3-hd",
  "gemini-3.8-flash-tts": "gemini-3.8-flash-tts",
  "gemini-tts": "gemini-3.8-flash-tts",
  gemini: "gemini-3.8-flash-tts",
  studio: "studio",
  neural2: "neural2",
  journey: "journey",
  polyglot: "polyglot",
  news: "news",
  wavenet: "wavenet",
  standard: "standard",
  default: "default",
};

export function conciseProviderLabel(id: string, rawLabel?: unknown, engine?: unknown): string {
  const normId = String(id || "").trim().toLowerCase();
  const normEngine = String(engine || "").trim().toLowerCase();
  if (normId === "edge" || normId === "edge-tts" || normEngine === "edge" || normEngine === "edge-tts") {
    return "Edge";
  }
  if (normId === "vertex" || normId === "vertex-ai" || normEngine === "vertex") {
    return "Vertex";
  }
  if (normId === "grok" || normId.startsWith("grok-") || normEngine === "grok") {
    return "Grok";
  }
  const cleaned = String(rawLabel || id || "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\bTTS\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || id;
}

export function inferVoiceModel(
  voiceId: string,
  raw: Record<string, unknown>,
  providerId: string,
): { modelId: string; modelLabel: string } {
  const rawModelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const rawModelLabel = typeof raw.modelLabel === "string" ? raw.modelLabel.trim() : "";
  const rawEngine = typeof raw.engine === "string" ? raw.engine.trim().toLowerCase() : "";
  const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";

  if (rawModelId) {
    const key = rawModelId.toLowerCase();
    const canonicalId = MODEL_ID_CANONICAL[key] || rawModelId;
    const label = MODEL_LABEL_MAP[canonicalId.toLowerCase()] || rawModelLabel || rawModelId;
    return { modelId: canonicalId, modelLabel: label };
  }

  const lowerId = voiceId.toLowerCase();
  const lowerLabel = rawLabel.toLowerCase();
  const isVertex = providerId.toLowerCase() === "vertex" || providerId.toLowerCase() === "vertex-ai";

  if (lowerId.startsWith("gemini-tts:") || rawEngine === "gemini" || lowerLabel.includes("gemini")) {
    return {
      modelId: "gemini-3.8-flash-tts",
      modelLabel: rawModelLabel || "Gemini 3.8 Flash TTS",
    };
  }
  // Check specific family IDs (Studio, Neural2, etc.) before generic rawEngine === "chirp"
  if (lowerId.includes("-studio-") || lowerId.startsWith("studio-") || /\bstudio\b/i.test(rawLabel)) {
    return { modelId: "studio", modelLabel: rawModelLabel || "Studio" };
  }
  if (lowerId.includes("-neural2-") || lowerId.startsWith("neural2-") || lowerLabel.includes("neural2")) {
    return { modelId: "neural2", modelLabel: rawModelLabel || "Neural2" };
  }
  if (lowerId.includes("-journey-") || lowerId.startsWith("journey-") || lowerLabel.includes("journey")) {
    return { modelId: "journey", modelLabel: rawModelLabel || "Journey" };
  }
  if (lowerId.includes("-polyglot-") || lowerId.startsWith("polyglot-") || lowerLabel.includes("polyglot")) {
    return { modelId: "polyglot", modelLabel: rawModelLabel || "Polyglot" };
  }
  if (lowerId.includes("-news-") || lowerId.startsWith("news-") || lowerLabel.includes("news")) {
    return { modelId: "news", modelLabel: rawModelLabel || "News" };
  }
  if (lowerId.includes("-wavenet-") || lowerId.startsWith("wavenet-") || lowerLabel.includes("wavenet")) {
    return { modelId: "wavenet", modelLabel: rawModelLabel || "WaveNet" };
  }
  if (lowerId.includes("-standard-") || lowerId.startsWith("standard-") || lowerLabel.includes("standard")) {
    return { modelId: "standard", modelLabel: rawModelLabel || "Standard" };
  }
  if (
    lowerId.includes("chirp3-hd") ||
    lowerId.includes("chirp") ||
    rawEngine === "chirp" ||
    lowerLabel.includes("chirp")
  ) {
    return {
      modelId: "chirp-3-hd",
      modelLabel: rawModelLabel || "Chirp 3 HD",
    };
  }
  if (isVertex && rawModelLabel) {
    const slug = rawModelLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
    return { modelId: MODEL_ID_CANONICAL[slug] || slug, modelLabel: rawModelLabel };
  }
  return { modelId: "default", modelLabel: rawModelLabel || "Default" };
}

export function conciseVoiceName(voiceId: string, rawLabel?: unknown, rawVoiceName?: unknown): string {
  const labelStr = typeof rawLabel === "string" ? rawLabel.trim() : "";
  const beforeDot = labelStr.includes("·") ? labelStr.split("·")[0]!.trim() : labelStr;
  let candidate = beforeDot.replace(/\s*\([^)]*\)/g, "").trim();

  if (!candidate) {
    candidate = typeof rawVoiceName === "string" && rawVoiceName.trim() ? rawVoiceName.trim() : voiceId;
  }

  candidate = candidate
    .replace(/^gemini-tts:/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Chirp3-HD-/i, "")
    .replace(/^Chirp3-HD-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Chirp-HD-/i, "")
    .replace(/^Chirp-HD-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Studio-/i, "")
    .replace(/^Studio-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Neural2-/i, "")
    .replace(/^Neural2-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Wavenet-/i, "")
    .replace(/^Wavenet-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-Standard-/i, "")
    .replace(/^Standard-/i, "")
    .replace(/^[a-z]{2,3}-[A-Z]{2}-/i, "");

  if (/Neural$/i.test(candidate) && !candidate.includes(" ")) {
    candidate = candidate
      .replace(/Neural$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
  }

  return candidate || voiceId;
}

function groupModelsForVoices(voices: TtsVoiceItem[]): TtsModelGroup[] {
  const groups = new Map<string, TtsModelGroup>();
  for (const voice of voices) {
    const existing = groups.get(voice.modelId);
    if (existing) {
      existing.voices.push(voice);
    } else {
      groups.set(voice.modelId, {
        id: voice.modelId,
        label: voice.modelLabel,
        voices: [voice],
      });
    }
  }
  const preferredOrder = ["chirp-3-hd", "gemini-3.8-flash-tts", "studio", "neural2"];
  return [...groups.values()].sort((a, b) => {
    const ai = preferredOrder.indexOf(a.id);
    const bi = preferredOrder.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.label.localeCompare(b.label);
  });
}

function findConnectedStudioVertexProvider(studioProviders?: StudioProviderLike[]): StudioProviderLike | null {
  if (!Array.isArray(studioProviders)) return null;
  for (const p of studioProviders) {
    if (!p || typeof p !== "object") continue;
    const isExplicitVertex =
      p.id === "vertex-ai" ||
      p.preset === "vertex-ai" ||
      p.protocol === "vertex-openai" ||
      p.auth?.mode === "vertex-service-account" ||
      p.auth?.mode === "vertex-oauth";
    if (isExplicitVertex && p.enabled !== false && p.auth?.hasSecret) {
      return p;
    }
  }
  return null;
}

export function buildTtsProviders(
  catalog: TtsCatalogLike | null,
  studioProviders?: StudioProviderLike[],
): TtsProviderGroup[] {
  if (!catalog || !Array.isArray(catalog.providers)) {
    return [];
  }

  const byId = new Map<string, TtsProviderGroup>();

  for (const item of catalog.providers) {
    if (!item || typeof item !== "object") continue;
    const rawId = String(item.id || "").trim();
    if (!rawId) continue;
    const id = rawId.toLowerCase() === "vertex-ai" ? "vertex" : rawId;
    const engine = typeof item.engine === "string" && item.engine.trim() ? item.engine.trim() : id;
    const label = conciseProviderLabel(id, item.label, engine);
    const catalogDefaultVoice = typeof item.defaultVoice === "string" ? item.defaultVoice.trim() : "";
    const rawVoices: unknown[] = Array.isArray(item.voices) ? item.voices : [];

    const voices: TtsVoiceItem[] = rawVoices.flatMap((v: unknown) => {
      if (!v || typeof v !== "object") return [];
      const rec = v as Record<string, unknown>;
      const voiceId = String(rec.id || "").trim();
      if (!voiceId) return [];
      const { modelId, modelLabel } = inferVoiceModel(voiceId, rec, id);
      const shortName = conciseVoiceName(voiceId, rec.label, rec.voiceName);
      return [
        {
          id: voiceId,
          label: shortName,
          rawLabel: String(rec.label || voiceId),
          modelId,
          modelLabel,
          default: rec.default === true,
        },
      ];
    });

    if (voices.length > 0 && !voices.some((v) => v.default)) {
      const matchedDefault = catalogDefaultVoice
        ? voices.find((v) => v.id === catalogDefaultVoice)
        : undefined;
      if (matchedDefault) {
        matchedDefault.default = true;
      } else {
        voices[0]!.default = true;
      }
    }

    const models = groupModelsForVoices(voices);
    const available = item.available !== false && voices.length > 0;
    const unavailableReason =
      typeof item.unavailableReason === "string" && item.unavailableReason.trim()
        ? item.unavailableReason.trim()
        : !available && voices.length === 0
          ? "No voices returned in catalog"
          : "";
    const costNotice = typeof item.costNotice === "string" ? item.costNotice.trim() : "";
    const synthModels = parseSynthModels(item.models);
    const defaultSynthModel = typeof item.defaultModel === "string" ? item.defaultModel.trim() : "";

    byId.set(id, {
      id,
      label,
      available,
      unavailableReason,
      costNotice,
      engine,
      hasExplicitModels: (id === "vertex" || engine === "vertex" || models.length > 1) && models.length > 0,
      models,
      voices,
      ...(synthModels.length ? { synthModels, defaultSynthModel: defaultSynthModel || synthModels[0]!.id } : {}),
      ...(item.allowCustomVoice === true ? { allowCustomVoice: true } : {}),
    });
  }

  // If Vertex is connected in Studio but missing from a stale catalog response,
  // expose only a disabled explanatory option (no fabricated voices, not usable).
  if (!byId.has("vertex") && findConnectedStudioVertexProvider(studioProviders)) {
    byId.set("vertex", {
      id: "vertex",
      label: "Vertex",
      available: false,
      unavailableReason: "Vertex is connected in Studio, but not in the current TTS catalog. Refresh or restart the server.",
      costNotice: "",
      engine: "vertex",
      hasExplicitModels: false,
      models: [],
      voices: [],
    });
  }

  return [...byId.values()];
}

export function isPaidTtsProvider(provider: TtsProviderGroup | null | undefined): boolean {
  if (!provider) return false;
  const engine = provider.engine.toLowerCase();
  const id = provider.id.toLowerCase();
  return engine !== "edge" && engine !== "edge-tts" && id !== "edge" && id !== "edge-tts";
}

function getStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } | null {
  try {
    const ls = (globalThis as { localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export function readPreferredVoice(): PreferredVoiceRecord | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem("screeningroom.preferredVoice");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PreferredVoiceRecord>;
      const providerId = String(parsed.providerId || parsed.engine || "").trim();
      const voiceId = String(parsed.voiceId || "").trim();
      if (providerId && voiceId) {
        return {
          providerId: providerId === "vertex-ai" ? "vertex" : providerId,
          modelId: typeof parsed.modelId === "string" ? parsed.modelId : undefined,
          voiceId,
          engine: typeof parsed.engine === "string" ? parsed.engine : undefined,
          voiceLabel: typeof parsed.voiceLabel === "string" ? parsed.voiceLabel : undefined,
        };
      }
    }
    const legacyProvider = (storage.getItem("screeningroom.voice.provider") || "").trim();
    const legacyVoice = (storage.getItem("screeningroom.voice.id") || "").trim();
    if (legacyProvider && legacyVoice) {
      return {
        providerId: legacyProvider === "vertex-ai" ? "vertex" : legacyProvider,
        voiceId: legacyVoice,
      };
    }
  } catch {
    /* Storage blocked */
  }
  return null;
}

export function writePreferredVoice(record: PreferredVoiceRecord): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem("screeningroom.preferredVoice", JSON.stringify(record));
    storage.setItem("screeningroom.voice.provider", record.providerId);
    storage.setItem("screeningroom.voice.id", record.voiceId);
  } catch {
    /* Storage blocked */
  }
}

export function normalizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
