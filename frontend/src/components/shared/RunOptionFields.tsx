import { Cloud, Monitor, Server } from "lucide-react";

import { Notice, RawDetails } from "@/components/ui/notice";
import type { OutroConfigInput, OutroHookType, RenderQuality } from "@/lib/api";
import { DEFAULT_LANE_ID, RENDER_KIND_META, type IntakeLaneOption, type RenderLaneKind } from "@/lib/renderLanes";
import { cn } from "@/lib/utils";

/** Run options shared by New Series and the Change settings dialog: chapters, render lane, quality and outro. */

const CHAPTERS_RE = /^(all|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/i;

export function normalizeChapters(raw: string): { ok: true; spec: string } | { ok: false; error: string } {
  const spec = String(raw || "").trim().toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s*-\s*/g, "-");
  if (!spec) return { ok: false, error: "Enter a chapter range, for example 2-5, or “all”." };
  if (!CHAPTERS_RE.test(spec)) return { ok: false, error: "Use “all”, a range like 2-5, or a list like 1,2,3." };
  for (const part of spec.split(",")) {
    if (part === "all") continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!(a >= 1) || !(b >= a)) return { ok: false, error: `“${part}” is not a valid range. Use 2-5.` };
    } else if (!(Number(part) >= 1)) {
      return { ok: false, error: `“${part}” is not a valid chapter number.` };
    }
  }
  return { ok: true, spec };
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  return (
    <div id={id} hidden={!message} className="mt-2">
      {message ? <Notice tone="danger" title="Check input" details={<RawDetails text={message} />} /> : null}
    </div>
  );
}

export function ChaptersField({ id, errorId, value, error, disabled, onChange }: {
  id: string; errorId: string; value: string; error?: string; disabled?: boolean; onChange: (value: string) => void;
}) {
  return (
    <>
      <label className="mt-4 block text-sm" htmlFor={id}>
        Chapters
        <input
          id={id}
          className="field mt-1 min-h-11 font-mono"
          value={value}
          disabled={disabled}
          placeholder="all, 1-5, or 1,2,3"
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="mt-2 flex gap-2" role="group" aria-label="Chapter presets">
        {["all", "1"].map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            className="min-h-11 rounded-full border border-border px-3 text-sm"
            aria-pressed={value.trim() === preset}
            onClick={() => onChange(preset)}
          >
            {preset === "all" ? "All chapters" : "Chapter 1"}
          </button>
        ))}
      </div>
      <FieldError id={errorId} message={error} />
    </>
  );
}

function LaneIcon({ kind }: { kind: RenderLaneKind }) {
  if (kind === "docker-sbx") return <Cloud className="size-3.5" aria-hidden />;
  if (kind === "ssh") return <Server className="size-3.5" aria-hidden />;
  if (kind === "local") return <Monitor className="size-3.5" aria-hidden />;
  return null;
}

const LANE_GROUPS: Array<{ kind: RenderLaneKind; label: string }> = [
  { kind: "inherit", label: RENDER_KIND_META.inherit.groupLabel },
  { kind: "local", label: RENDER_KIND_META.local.groupLabel },
  { kind: "docker-sbx", label: RENDER_KIND_META["docker-sbx"].groupLabel },
  { kind: "ssh", label: RENDER_KIND_META.ssh.groupLabel },
  { kind: "custom", label: RENDER_KIND_META.custom.groupLabel },
];

export function RenderLaneField({ id, noteId, errorId, lanes, value, error, disabled, onChange }: {
  id: string; noteId: string; errorId: string; lanes: IntakeLaneOption[]; value: string; error?: string; disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const chosenLane = lanes.find((lane) => lane.id === value) || lanes[0];
  const unavailableLanes = lanes.filter((lane) => !lane.available && lane.id !== chosenLane?.id);
  return (
    <>
      <label className="mt-4 block text-sm" htmlFor={id}>
        Render lane
        <select
          id={id}
          className="field mt-1 min-h-11"
          value={chosenLane?.id || DEFAULT_LANE_ID}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${noteId} ${errorId}`}
          onChange={(event) => onChange(event.target.value)}
        >
          {LANE_GROUPS.map((group) => {
            const options = lanes.filter((lane) => lane.kind === group.kind);
            if (!options.length) return null;
            return (
              <optgroup key={group.kind} label={group.label}>
                {options.map((lane) => (
                  <option key={lane.id} value={lane.id} disabled={!lane.available}>
                    {lane.label}{lane.available ? "" : " (Unavailable)"}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>
      <span id={noteId} className="sr-only">
        <LaneIcon kind={chosenLane?.kind || "inherit"} />
        {chosenLane && chosenLane.id !== DEFAULT_LANE_ID
          ? chosenLane.available
            ? `${chosenLane.label} only · waits if offline`
            : `Default lane ${chosenLane.label} is unavailable (${chosenLane.unavailableReason || "disabled or removed"}). Choose Auto or another available lane.`
          : "Follows lane policy"}
      </span>
      {chosenLane && !chosenLane.available ? (
        <Notice className="mt-2" tone="danger" title="Lane unavailable" details={<RawDetails text={`${chosenLane.label}: ${chosenLane.unavailableReason || "disabled or removed"}`} />} />
      ) : null}
      {unavailableLanes.length ? (
        <details className="mt-2 text-sm">
          <summary>Unavailable: {unavailableLanes.map((lane) => lane.label).join(", ")}</summary>
          <ul className="mt-2 text-warning">
            {unavailableLanes.map((lane) => (
              <li key={lane.id}><strong>{lane.label}</strong> — {lane.unavailableReason || "unavailable"}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <FieldError id={errorId} message={error} />
    </>
  );
}

export function RenderQualityField({ value, disabled, onChange }: {
  value: RenderQuality; disabled?: boolean; onChange: (value: RenderQuality) => void;
}) {
  return (
    <div className="mt-4 rounded-xl bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Render quality</p>
          <p className="text-xs text-muted-foreground">
            {value === "720p" ? "1280×720" : "1920×1080"}
          </p>
        </div>
        <div className="flex gap-2" role="radiogroup" aria-label="Render quality">
          {(["1080p", "720p"] as const).map((q) => (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={value === q}
              disabled={disabled}
              className={cn(
                "min-h-11 rounded-full px-4 text-sm",
                value === q ? "bg-primary-soft text-primary-text" : "bg-muted",
              )}
              onClick={() => onChange(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface OutroDraft {
  enabled: boolean;
  totalChapters: number;
  coveredChapters: number;
  hookType: OutroHookType;
  customPrompt: string;
}

export const DEFAULT_OUTRO_DRAFT: OutroDraft = { enabled: false, totalChapters: 50, coveredChapters: 20, hookType: "part2", customPrompt: "" };

const HOOK_TYPES: OutroHookType[] = ["part2", "next_chapter", "new_series", "custom"];

/** Job record outroConfig (customNote on the server, customPrompt at create) to the form draft. */
export function outroDraftFrom(raw: unknown): OutroDraft {
  if (!raw || typeof raw !== "object") return DEFAULT_OUTRO_DRAFT;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback);
  const hook = HOOK_TYPES.includes(r.hookType as OutroHookType) ? (r.hookType as OutroHookType) : "part2";
  const prompt = typeof r.customPrompt === "string" ? r.customPrompt : typeof r.customNote === "string" ? r.customNote : "";
  return {
    enabled: r.enabled === true,
    totalChapters: num(r.totalChapters, DEFAULT_OUTRO_DRAFT.totalChapters),
    coveredChapters: num(r.coveredChapters, DEFAULT_OUTRO_DRAFT.coveredChapters),
    hookType: hook,
    customPrompt: prompt,
  };
}

/** The create-time payload: undefined when the outro is off. */
export function outroConfigFrom(draft: OutroDraft): OutroConfigInput | undefined {
  return draft.enabled
    ? {
        enabled: true,
        totalChapters: Math.max(1, draft.totalChapters),
        coveredChapters: Math.max(1, draft.coveredChapters),
        hookType: draft.hookType,
        customPrompt: draft.customPrompt.trim() || undefined,
      }
    : undefined;
}

export function OutroFields({ value, disabled, onChange }: { value: OutroDraft; disabled?: boolean; onChange: (value: OutroDraft) => void }) {
  const set = <K extends keyof OutroDraft>(key: K, next: OutroDraft[K]) => onChange({ ...value, [key]: next });
  return (
    <fieldset disabled={disabled} className="mt-4 min-w-0 rounded-xl border-0 bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Episode outro</p>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => set("enabled", event.target.checked)}
          />
          Enable outro
        </label>
      </div>
      {value.enabled ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-muted-foreground">
              Total chapters so far
              <input
                type="number"
                min={1}
                className="mt-1 min-h-11 w-full rounded-xl bg-card px-3 font-mono text-sm text-foreground"
                value={value.totalChapters}
                onChange={(event) => set("totalChapters", Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Covered chapters
              <input
                type="number"
                min={1}
                className="mt-1 min-h-11 w-full rounded-xl bg-card px-3 font-mono text-sm text-foreground"
                value={value.coveredChapters}
                onChange={(event) => set("coveredChapters", Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Hook type
              <select
                className="mt-1 min-h-11 w-full rounded-xl bg-card px-3 text-sm text-foreground"
                value={value.hookType}
                onChange={(event) => set("hookType", event.target.value as OutroHookType)}
              >
                <option value="part2">Part 2</option>
                <option value="next_chapter">Next chapter</option>
                <option value="new_series">New series</option>
                <option value="custom">Custom</option>
              </select>
            </label>
          </div>
          {value.hookType === "custom" ? (
            <label className="block text-xs text-muted-foreground">
              Custom outro call-to-action
              <input
                className="mt-1 min-h-11 w-full rounded-xl bg-card px-3 text-sm text-foreground"
                value={value.customPrompt}
                placeholder="Ask viewers to drop a comment for Part 2"
                onChange={(event) => set("customPrompt", event.target.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
