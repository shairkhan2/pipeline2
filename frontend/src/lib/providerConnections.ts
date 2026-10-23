export const PROVIDER_ID_MAX_LEN = 64;
export const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ProviderConnectionLike {
  id: string;
  label?: string;
  preset?: string;
  baseUrl?: string;
}

/**
 * Normalize an arbitrary string into a valid provider ID base matching
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
 */
export function normalizeProviderIdBase(raw: unknown, fallback = "custom-openai"): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-_.]+$/, "");
  const seed = cleaned || fallback;
  const sliced = seed.slice(0, PROVIDER_ID_MAX_LEN).replace(/[-_.]+$/, "");
  if (sliced && PROVIDER_ID_RE.test(sliced)) return sliced;
  return "provider";
}

function collectProviderIds(
  existingProviders: ReadonlyArray<ProviderConnectionLike | string> = [],
  excludeId?: string | null,
): { exact: Set<string>; lower: Set<string> } {
  const exact = new Set<string>();
  const lower = new Set<string>();
  const skip = typeof excludeId === "string" ? excludeId.trim() : "";
  const skipLower = skip.toLowerCase();
  for (const entry of existingProviders) {
    const id = typeof entry === "string" ? entry.trim() : String(entry?.id ?? "").trim();
    if (!id) continue;
    if (skip && (id === skip || id.toLowerCase() === skipLower)) continue;
    exact.add(id);
    lower.add(id.toLowerCase());
  }
  return { exact, lower };
}

/**
 * True when `candidateId` collides with any existing provider ID (excluding `excludeId` when editing).
 */
export function hasProviderIdCollision(
  candidateId: string,
  existingProviders: ReadonlyArray<ProviderConnectionLike | string> = [],
  excludeId?: string | null,
): boolean {
  const trimmed = String(candidateId ?? "").trim();
  if (!trimmed) return false;
  const { exact, lower } = collectProviderIds(existingProviders, excludeId);
  return exact.has(trimmed) || lower.has(trimmed.toLowerCase());
}

/**
 * Generate a valid, collision-free provider ID from a preset/base ID and the
 * currently saved providers.
 *
 * - In edit mode (`editingId` supplied), preserves `editingId` verbatim.
 * - For the first instance of a preset, preserves the legacy preset ID (e.g. `custom-openai`).
 * - For subsequent instances, appends `-2`, `-3`, ... while keeping total length <= 64
 *   and matching `PROVIDER_ID_RE`.
 */
export function nextAvailableProviderId(
  presetOrBaseId: string,
  existingProviders: ReadonlyArray<ProviderConnectionLike | string> = [],
  editingId?: string | null,
): string {
  const trimmedEditing = typeof editingId === "string" ? editingId.trim() : "";
  if (trimmedEditing) return trimmedEditing;

  const base = normalizeProviderIdBase(presetOrBaseId, "custom-openai");
  const { exact, lower } = collectProviderIds(existingProviders);
  if (!exact.has(base) && !lower.has(base.toLowerCase())) {
    return base;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const maxPrefixLen = Math.max(1, PROVIDER_ID_MAX_LEN - suffix.length);
    let prefix = base.slice(0, maxPrefixLen).replace(/[-_.]+$/, "");
    if (!prefix || !/^[A-Za-z0-9]/.test(prefix)) {
      prefix = "p";
    }
    const candidate = `${prefix}${suffix}`;
    if (
      PROVIDER_ID_RE.test(candidate) &&
      !exact.has(candidate) &&
      !lower.has(candidate.toLowerCase())
    ) {
      return candidate;
    }
  }

  throw new Error(`Could not allocate available provider ID for '${base}'`);
}

/**
 * Derive a default human-readable connection label for a new provider instance.
 * Preserves `baseLabel` for the first connection, and appends the instance number
 * (e.g. `Custom OpenAI-Compatible 2`) when adding additional connections of the same preset.
 */
export function nextAvailableProviderLabel(
  baseLabel: string,
  resolvedId: string,
  presetId?: string,
  existingProviders: ReadonlyArray<ProviderConnectionLike | string> = [],
): string {
  const cleanLabel = String(baseLabel ?? "").trim() || resolvedId;
  const cleanPreset = normalizeProviderIdBase(presetId || resolvedId, resolvedId);
  const existingLabels = new Set<string>();
  for (const entry of existingProviders) {
    if (typeof entry === "object" && entry && typeof entry.label === "string" && entry.label.trim()) {
      existingLabels.add(entry.label.trim().toLowerCase());
    }
  }
  const suffixMatch = new RegExp(`^${cleanPreset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i").exec(
    resolvedId.trim(),
  );
  if (!suffixMatch && !existingLabels.has(cleanLabel.toLowerCase())) {
    return cleanLabel;
  }
  const startNum = suffixMatch ? Math.max(2, Number.parseInt(suffixMatch[1]!, 10) || 2) : 2;
  for (let index = startNum; index < 10_000; index += 1) {
    const candidate = `${cleanLabel} ${index}`;
    if (!existingLabels.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${cleanLabel} (${resolvedId})`;
}

/**
 * Disambiguate a provider label when multiple connections share the same display name.
 */
export function formatProviderConnectionLabel(
  provider: { id: string; label?: string },
  allProviders: ReadonlyArray<{ id: string; label?: string }> = [],
): string {
  const label = String(provider.label ?? "").trim() || provider.id;
  const duplicateLabel = allProviders.some(
    (other) =>
      other.id !== provider.id &&
      (String(other.label ?? "").trim() || other.id).toLowerCase() === label.toLowerCase(),
  );
  return duplicateLabel ? `${label} (${provider.id})` : label;
}
