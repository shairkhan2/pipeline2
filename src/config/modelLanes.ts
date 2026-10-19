/**
 * Canonical default model role lanes.
 *
 * Single source for the static default vision/writer chains shared by
 * `laneConfig` (persisted lane defaults), `llm/client` (runtime lane objects),
 * and `studioConfig` (stage routing defaults). Import-free on purpose so the
 * three consumers never create an import cycle.
 */

export interface DefaultRoleLane {
  kind: string;
  provider: string;
  model: string;
  thinking: boolean | null;
  stream: boolean;
}

export type DefaultRoleLanes = {
  vision: DefaultRoleLane[];
  writer: DefaultRoleLane[];
};

/**
 * Vision chain: free lanes first. thinking=false is set only where measured to
 * take effect on the reader call shape. hy3 is vision-capable and sits below
 * deepseek. Vertex is not listed.
 */
export const DEFAULT_VISION_LANES: DefaultRoleLane[] = [
  { kind: "openai", provider: "agy", model: "gemini-3.8-flash-low", thinking: null, stream: false },
  { kind: "openai", provider: "workbuddy", model: "deepseek-v4.1-flash", thinking: false, stream: true },
  { kind: "openai", provider: "opencode", model: "mimo-v2.5-free", thinking: null, stream: false },
  { kind: "openai", provider: "opencode", model: "muse-spark-1.2-contributor-free", thinking: null, stream: false },
  { kind: "openai", provider: "workbuddy", model: "hy3", thinking: false, stream: true },
];

/**
 * Writer chain: free lanes only. deepseek-v4.1-flash is primary and requires
 * thinking=false on the production writer payload (thinking on returns empty-200).
 * hy3 is absent here: empty-200 on the real writer payload, both thinking on and off.
 */
export const DEFAULT_WRITER_LANES: DefaultRoleLane[] = [
  { kind: "openai", provider: "workbuddy", model: "deepseek-v4.1-flash", thinking: false, stream: true },
  { kind: "openai", provider: "agy", model: "gemini-3.8-flash-medium", thinking: null, stream: false },
  { kind: "openai", provider: "opencode", model: "muse-spark-1.2-contributor-free", thinking: null, stream: false },
  { kind: "openai", provider: "opencode", model: "muse-spark-1.3-contributor-free", thinking: null, stream: false },
];

/** Fresh copy of the canonical default chains. */
export function defaultRoleLanes(): DefaultRoleLanes {
  return {
    vision: DEFAULT_VISION_LANES.map((lane) => ({ ...lane })),
    writer: DEFAULT_WRITER_LANES.map((lane) => ({ ...lane })),
  };
}

/** `provider:model` ids in default priority order. */
export function defaultRoleLaneIds(): { vision: string[]; writer: string[] } {
  const ids = (lanes: DefaultRoleLane[]): string[] => lanes.map((lane) => `${lane.provider}:${lane.model}`);
  return { vision: ids(DEFAULT_VISION_LANES), writer: ids(DEFAULT_WRITER_LANES) };
}
