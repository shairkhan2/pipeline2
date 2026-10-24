/* Card animation — pure frame math for the window preset's entry/exit and
 * push-in strength. No Remotion/React imports so the pipeline tests can load it.
 *
 * Defaults (entry/exit 'none', pushIn 'normal', drift true) reproduce the
 * original window look exactly: hard cuts, no overlap, today's push-in.
 *
 * Gap-free transitions: a shot with an entry animation starts on its own first
 * frame, and the PREVIOUS shot's Sequence is extended by that entry length so
 * it stays painted underneath. The new shot's blurred backdrop crossfades over
 * the old frame (fully opaque by half the entry) while the card animates in on
 * top, so no frame ever shows the black composition background between shots.
 */

export const ENTRIES = ['none', 'fade', 'zoom', 'slide-up', 'slide-left'] as const;
export const EXITS = ['none', 'fade', 'zoom-out', 'slide-down'] as const;
export const PUSH_INS = ['off', 'subtle', 'normal', 'strong'] as const;
export type CardEntry = (typeof ENTRIES)[number];
export type CardExit = (typeof EXITS)[number];
export type PushIn = (typeof PUSH_INS)[number];

export type CardAnimation = {
  entry?: CardEntry;
  exit?: CardExit;
  entryS?: number;
  exitS?: number;
  pushIn?: PushIn;
  drift?: boolean;
};
export type ResolvedAnimation = Required<CardAnimation>;

export const DEFAULT_ANIMATION: ResolvedAnimation = {
  entry: 'none',
  exit: 'none',
  entryS: 0.25,
  exitS: 0.25,
  pushIn: 'normal',
  drift: true,
};
/** entry + exit never take more than this share of a shot's own length. */
export const MAX_TRANSITION_SHARE = 0.4;
/** Push-in multiplier on both the per-weight target and the per-second rate cap. */
export const PUSH_IN_SCALE: Record<PushIn, number> = {off: 0, subtle: 0.5, normal: 1, strong: 1.5};

const ZOOM_FROM = 0.92; // 'zoom' entry starts at this card scale
const ZOOM_OUT_TO = 0.92; // 'zoom-out' exit ends at this card scale
const SLIDE_Y = 0.12; // share of frame height for slide-up / slide-down
const SLIDE_X = 0.15; // share of frame width for slide-left

const oneOf = <T extends string>(list: readonly T[], v: unknown, d: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d;
const secs = (v: unknown, d: number) => {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
};

/** Tolerant normalize: unknown/invalid fields fall back to the defaults. */
export function resolveAnimation(a?: unknown): ResolvedAnimation {
  const o = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
  return {
    entry: oneOf(ENTRIES, o.entry, DEFAULT_ANIMATION.entry),
    exit: oneOf(EXITS, o.exit, DEFAULT_ANIMATION.exit),
    entryS: secs(o.entryS, DEFAULT_ANIMATION.entryS),
    exitS: secs(o.exitS, DEFAULT_ANIMATION.exitS),
    pushIn: oneOf(PUSH_INS, o.pushIn, DEFAULT_ANIMATION.pushIn),
    drift: typeof o.drift === 'boolean' ? o.drift : DEFAULT_ANIMATION.drift,
  };
}

/** Entry/exit frame counts for a shot of durF frames, clamped to 40% of it. */
export function transitionFrames(anim: ResolvedAnimation, durF: number, fps: number) {
  let entryF = anim.entry === 'none' ? 0 : Math.round(anim.entryS * fps);
  let exitF = anim.exit === 'none' ? 0 : Math.round(anim.exitS * fps);
  const budget = Math.floor(Math.max(0, durF) * MAX_TRANSITION_SHARE);
  if (entryF + exitF > budget) {
    const total = entryF + exitF;
    entryF = Math.floor((entryF * budget) / total);
    exitF = Math.max(0, budget - entryF);
    if (anim.exit === 'none') exitF = 0;
  }
  return {entryF, exitF};
}

export type ShotPlan = {
  from: number; // first frame of the shot on the composition grid
  dur: number; // visible length: up to the next shot's first frame
  seqDur: number; // Sequence length: dur + the next shot's entry overlap
  entryF: number;
  exitF: number;
};

/** Frame plan for the window layout. With default animation seqDur === dur. */
export function planShots(
  shots: ReadonlyArray<{start_s: number; end_s: number}>,
  fps: number,
  anim: ResolvedAnimation,
): ShotPlan[] {
  const base = shots.map((s, i) => {
    const from = Math.round(s.start_s * fps);
    const next = shots[i + 1];
    const to = next ? Math.round(next.start_s * fps) : Math.round(s.end_s * fps);
    const dur = Math.max(1, to - from);
    return {from, dur, ...transitionFrames(anim, dur, fps)};
  });
  return base.map((p, i) => {
    const next = base[i + 1];
    // The next shot paints over us from its own first frame; keep us mounted
    // underneath while it animates in. Shot 0 has nothing under it to cover.
    const tail = next && next.from === p.from + p.dur ? next.entryF : 0;
    return {...p, seqDur: p.dur + tail};
  });
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t * t;

export type CardFrame = {
  opacity: number;
  scale: number;
  dx: number; // px
  dy: number; // px
  backdropOpacity: number;
};

/**
 * Card + backdrop state at a local frame of a shot. `first` disables the
 * backdrop crossfade (nothing underneath shot 0 but the black frame).
 */
export function cardFrame(
  frame: number,
  plan: Pick<ShotPlan, 'dur' | 'entryF' | 'exitF'>,
  anim: ResolvedAnimation,
  size: {w: number; h: number},
  first = false,
): CardFrame {
  const out: CardFrame = {opacity: 1, scale: 1, dx: 0, dy: 0, backdropOpacity: 1};
  if (plan.entryF > 0 && anim.entry !== 'none' && frame < plan.entryF) {
    // p reaches 1 on the last entry frame, so frame entryF is fully settled.
    const p = clamp01((frame + 1) / plan.entryF);
    const e = easeOut(p);
    out.opacity = e;
    if (anim.entry === 'zoom') out.scale = ZOOM_FROM + (1 - ZOOM_FROM) * e;
    if (anim.entry === 'slide-up') out.dy = (1 - e) * SLIDE_Y * size.h;
    if (anim.entry === 'slide-left') out.dx = (1 - e) * SLIDE_X * size.w;
    if (!first) out.backdropOpacity = clamp01(p * 2);
  }
  const exitStart = plan.dur - plan.exitF;
  if (plan.exitF > 0 && anim.exit !== 'none' && frame >= exitStart) {
    // Reaches 0 on the shot's last visible frame and holds through the overlap tail.
    const p = clamp01((frame - exitStart + 1) / plan.exitF);
    const e = easeIn(p);
    out.opacity *= 1 - e;
    if (anim.exit === 'zoom-out') out.scale *= 1 - (1 - ZOOM_OUT_TO) * e;
    if (anim.exit === 'slide-down') out.dy += e * SLIDE_Y * size.h;
  }
  return out;
}

/** Push-in end zoom: weight target and per-second rate both scaled by strength. */
export function pushInEnd(
  weightTarget: number,
  rate: number,
  durS: number,
  pushIn: PushIn,
  boxLimit = Infinity,
) {
  const k = PUSH_IN_SCALE[pushIn] ?? 1;
  const z = 1 + Math.min(weightTarget * k, rate * k * Math.max(0, durS));
  return Math.max(1, Math.min(z, boxLimit));
}
