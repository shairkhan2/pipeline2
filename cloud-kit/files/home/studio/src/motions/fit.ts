/* Fit — size the card to the PANEL, then move the panel a little inside it.
 *
 * The rules below are the user's correction (2026-10-03), intent verbatim:
 * "I once told to make card bigger, try to fill left and right side, fill as
 * much as you can — crop panel so it can fit that way. Ah that was MY
 * mistake. Now when a single panel comes in I only see their BODY portion.
 * Aggressive slide — fuck that. Don't try to fit that much screen. Don't make
 * it a heavy slideshow, viewer's brain will fly. So when one panel, crop the
 * panel ~15% and slide to the focus point via minor position. Don't start with
 * the opposite direction just to slide."
 *
 * 1. NATURAL FRAMING (FILL_MODE = 'natural'). The card's aspect IS the panel's
 *    own aspect, so the art fills the card edge to edge and nothing is
 *    letterboxed inside it. Inside the frame's sane band
 *    (SOLO_MIN_AR..SOLO_MAX_AR = 1.33..2.0) that means the panel is shown WHOLE
 *    — identical to what the old clamp produced, so those shots do not move.
 *    OUTSIDE the band, i.e. the tall and the very wide webtoon strips, the card
 *    follows the panel and only the crop budget is spent. That inversion is the
 *    correction: the old code clamped those strips into 4:3 and hid 43-79% of
 *    the art, which is what made "I only see their BODY portion" true. A 1:2.7
 *    portrait therefore gets a tall narrow card with black either side of it,
 *    because "fill as much as you can" was the mistake, not the goal.
 *    PAN_SPAN is dead with the old clamp and is no longer read here.
 * 2. THE ~15% CROP, QUANTIFIED (MAX_CROP_FRAC). MAX_CROP_FRAC is the share of
 *    the panel's CROPPED dimension we are allowed to hide, so 0.15 means the
 *    visible window covers >= 85% of it. "Cropped dimension" is the single
 *    panel axis the card is short of — height when the panel is taller than
 *    its card, width when it is wider; the other axis is always 100% visible,
 *    so a shot never loses content on both axes at once. The share the card is
 *    actually built for is `visibleShare()` below, which also budgets for the
 *    push-in hold.ts applies (MAX_CROP_FRAC_TOTAL).
 * 3. NEUTRAL START (PAN_START = 'neutral'). The window STARTS centred on the
 *    subject (reader box centre, else focus_x/focus_y, else the panel centre)
 *    and drifts a SMALL distance TOWARD the focus point — it never starts at
 *    the far end of the panel to have something to slide. The old expression
 *    `lo = clamp(f - PAN_SPAN/2, 0, 1-PAN_SPAN); y = (lo + p*PAN_SPAN)*100`
 *    did exactly that: a 70%-of-the-cropped-axis traverse that began up to 35%
 *    of the panel away from the focus and only arrived at the end. It was live
 *    on 9198 of 9314 real shots in every series' out/ch<N>/video/shots.json
 *    (every shot that predates the reader `box`), i.e. the "aggressive slide".
 *    It is deleted, not merely reduced: PAN_START's 'opposite' branch is the
 *    only way to get it back, and it is bounded by the crop budget like
 *    everything else. Old series need no data migration — the pan is computed at
 *    render time from the same shots.json.
 * 4. THE SLIDE IS A BREATH, NOT A MOVE: capped by PAN_BUDGET and by the room the
 *    subject containment leaves — measured over 143 real panels, fit's own slide
 *    is at most 6% of the panel, and exactly 0% on every shot without a reader
 *    box, because there the subject IS the focus point and there is nothing to
 *    slide to. Eased in-out. Duo mode is untouched (duoFit/duoFits below are
 *    byte-identical): it already gives both panels their own aspect, so its
 *    cards show 100% of each panel and panPosition returns '50% 50%' for them.
 *
 * ART MOTION IS NO LONGER THIS FILE'S PROBLEM (2026-10-04). The block of
 * artInsets()/ART_RESERVE that used to sit here is gone: it reserved room for
 * hold.ts's -driftDir*DRIFT_ART*cardH art counter-move so that counter-move
 * could not walk the art off the card edge. That reservation could never have
 * worked, because whether an edge goes bare does not depend on this file at
 * all: the img fills the card's content box, the browser clips the cover-painted
 * art to THAT box and only then applies the transform, so a black band appears
 * iff zoom*|artY| > (zoom-1)/2 * cardH — the push-in's own coverage, full stop.
 * Measured over all 9314 real shots that bare 4171 of them (44.8%, median 21px,
 * max 35px) at the hold's last frame, and this file's ART_RESERVE = 0.5 could
 * not have touched a single one of them, because it moved the window and the
 * window cannot move an edge. hold.ts now ships artY = shuttle only
 * (|artY| <= 1.5% of cardH against a 4.5%+ allowance), so the counter-move is
 * gone and the two files no longer fight over the same pixels: the only art
 * motion left to reserve is the SHUTTLE, which is symmetric, tiny and safe
 * inside the push-in's margin on its own. What this file reserved for it is one
 * number, SHUTTLE_ART_X*vis, and only so the window never parks on the panel's
 * outermost pixel row; the slide keeps the rest of its range.
 */
import {Easing, interpolate} from 'remotion';
import {W, H, SOLO_BOX, SOLO_MIN_AR, SOLO_MAX_AR, HOLD_ZOOM, DRIFT_ART, SHUTTLE_ART_X,
  DUO_MIN_AR, DUO_MAX_AR, DUO_BOX_H, DUO_GROUP_W, DUO_GAP, DUO_MAX_CROP,
  DUO_MIN_AREA} from './tunables';
import type {Shot} from './types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Lenient number: restores the ORIGINAL arithmetic coercion (a numeric string
// or boolean degrades via ToNumber, so focus_y="0.9" still aims high), but
// anything else degrades to the default, never to NaN%.
const num = (v: unknown, dflt: number) => {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' || typeof v === 'boolean' ? Number(v) : NaN;
  return isFinite(n) ? n : dflt;
};
const arOf = (s: Shot) => (s.pw ?? 800) / (s.ph ?? 1422);

/** Which of the two framings soloFit builds. 'natural' = rule 1 above (the card
 *  tracks the panel's own aspect; the crop budget is spent only outside the
 *  frame's sane aspect band). 'contain' = the panel's aspect verbatim and 100%
 *  visible for EVERY panel, the smallest card that still shows it all — the
 *  documented opposite of the rule, kept as a switch, not the default. */
export type FillMode = 'natural' | 'contain';
export const FILL_MODE: FillMode = 'natural';

/** Read FILL_MODE through a parameter instead of comparing the const in place.
 *  TypeScript narrows a `const` that has a literal initializer down to that
 *  literal at every use site inside the declaring file, so `FILL_MODE ===
 *  'contain'` written inline is reported as TS2367 ("this comparison appears to
 *  be unintentional") even though the knob is a live switch that soloFit and
 *  visibleShare both branch on. Handing the value to a function parameter gives
 *  the comparison the DECLARED union to check against, which is the truth: no
 *  cast, no widening lie, and flipping FILL_MODE still takes both branches. */
const isContain = (m: FillMode) => m === 'contain';

/** Share of the panel's cropped dimension that may be hidden, i.e. the visible
 *  window covers >= 1 - MAX_CROP_FRAC of it. 0.15 = the user's "crop the panel
 *  ~15%". Binds whenever the art is not pushed in (see visibleShare). */
export const MAX_CROP_FRAC = 0.15;

/** Same budget, but counted over the WHOLE shot: hold.ts scales the art by
 *  HOLD_ZOOM + DRIFT_ART across the hold (1.09 at the first frame, 1.14 at the
 *  last), which eats (zoom-1)/zoom of whatever the window showed, so a window
 *  of share v ends up showing v/zoom. Solving v/1.14 >= 1 - this is the second
 *  term below. 0.20 keeps every instant of every shot inside the ~15-20% the
 *  user asked for; 0.15 would too, but leaves the slide only 3% of the panel. */
export const MAX_CROP_FRAC_TOTAL = 0.2;

/** Where the window starts: 'neutral' = centred on the subject (rule 3).
 *  'opposite' = start at the far end of the admissible range so the slide has
 *  distance to cover — the behaviour that was just retracted, kept only as a
 *  named switch, and still bounded by MAX_CROP_FRAC. */
export const PAN_START: 'neutral' | 'opposite' = 'neutral';

/** The slide travels at most this share of the panel's cropped dimension. It
 *  is also structurally bounded by the window's own range (1 - visibleShare(),
 *  i.e. 0.088 with the numbers above), so this is a policy cap, not the
 *  binding one. */
export const PAN_BUDGET = 0.15;

/** Largest art zoom the hold applies: 1 + HOLD_ZOOM*holdP + DRIFT_ART. */
const ART_ZOOM_END = 1 + HOLD_ZOOM + DRIFT_ART;

/** Card aspect within this relative distance of the panel's means the card
 *  already has the panel's framing and there is nothing to reveal. */
const FIT_EPS = 0.03;

/** Share of the panel's cropped dimension that stays on screen all shot. */
const visibleShare = () => (isContain(FILL_MODE)
  ? 1
  : Math.max(1 - MAX_CROP_FRAC, (1 - MAX_CROP_FRAC_TOTAL) * ART_ZOOM_END));

type NormBox = {x0: number; y0: number; x1: number; y1: number};
/** Reader interest box, sanitized: finite, clamped to 0..1, strictly positive
 * area, and not the degenerate full-panel box (which carries no signal).
 * Anything else returns null and the caller falls back to focus_y/focus_x. */
const normBox = (b: Shot['box']): NormBox | null => {
  if (!b) return null;
  const vs = [b.x0, b.y0, b.x1, b.y1];
  if (!vs.every(v => typeof v === 'number' && isFinite(v))) return null;
  const [x0, y0, x1, y1] = vs.map(v => clamp(v as number, 0, 1));
  if (!(x1 > x0 && y1 > y0)) return null;
  if (x0 <= 0 && y0 <= 0 && x1 >= 1 && y1 >= 1) return null;
  return {x0, y0, x1, y1};
};

/** Card that shows `vis` of a panel of aspect `ar`, largest one that fits the
 * solo box (weight 1 sits a touch smaller). A card of aspect c shows vis of the
 * panel iff c = ar/vis (card wider than the panel: vertical crop) or
 * c = ar*vis (card narrower: horizontal crop); in both cases the OTHER axis is
 * exact, which is what "natural framing" means here. The candidate with the
 * bigger card wins, so the crop is only ever spent where it buys size: for a
 * panel that is wider than its card, c = ar*vis (a taller card); for one that is
 * taller, c = ar/vis (a wider card). */
export function soloFit(s: Shot) {
  const ar = Math.max(0.02, arOf(s));
  const k = SOLO_BOX[((s.weight ?? 2) - 1) as 0 | 1 | 2];
  const bw = W * k;
  const bh = H * k;
  const box = normBox(s.box);
  const pick = (vis: number) => {
    const area = (c: number) => { const w = Math.min(bw, bh * c); return (w * w) / c; };
    // Tie (a panel already about as wide as the box) keeps the vertical crop, so
    // tall webtoon art always pans the way the reader expects.
    const c = area(ar / vis) >= area(ar * vis) ? ar / vis : ar * vis;
    const w = Math.min(bw, bh * c);
    return {w, h: w / c, c};
  };
  // A panel whose own aspect already lands in the frame's sane band
  // (SOLO_MIN_AR..SOLO_MAX_AR, 1.33..2.0) is shown WHOLE: its natural framing IS
  // the card, nothing is cropped and there is nothing to slide — byte-identical
  // to what the old clamp produced for those panels. Only OUTSIDE that band, the
  // tall and the very wide webtoon strips, does the card follow the panel at the
  // cost of the crop budget. That inversion is the whole correction: the old
  // code clamped those strips into 4:3 and hid 43-79% of the art, which is what
  // "I only see their BODY portion" meant.
  let vis = isContain(FILL_MODE) || (ar >= SOLO_MIN_AR && ar <= SOLO_MAX_AR)
    ? 1 : visibleShare();
  let fit = pick(vis);
  if (box) {
    // A window narrower than the reader's own interest box can never hold it, so
    // widen the window to the box. vis = 1 is the honest end of that: the card
    // takes the panel's aspect exactly, nothing is cropped, and panPosition
    // returns '50% 50%'. One extra pass only — the wider window can in principle
    // pick the other crop axis, which we do not re-visit.
    const vertical = fit.c > ar;
    const need = vertical ? box.y1 - box.y0 : box.x1 - box.x0;
    if (need > vis) {
      vis = Math.min(1, need);
      fit = pick(vis);
    }
  }
  return {w: fit.w, h: fit.h};
}

/** Two cards on one shared height, spending the full group width between them. */
export function duoFit(a: Shot, b: Shot) {
  const ar1 = clamp(arOf(a), DUO_MIN_AR, DUO_MAX_AR);
  const ar2 = clamp(arOf(b), DUO_MIN_AR, DUO_MAX_AR);
  const ch = Math.min(H * DUO_BOX_H, (W * DUO_GROUP_W - DUO_GAP) / (ar1 + ar2));
  const w1 = ch * ar1;
  const w2 = ch * ar2;
  return {w1, w2, ch, totalW: w1 + DUO_GAP + w2, area: ((w1 + w2) * ch) / (W * H)};
}

/** Pair only when both panels survive the crop and the pair still fills the frame. */
export function duoFits(a: Shot, b: Shot) {
  const kept = (s: Shot) => {
    const ar = arOf(s);
    const c = clamp(ar, DUO_MIN_AR, DUO_MAX_AR);
    return ar > c ? c / ar : ar / c;   // share of the panel visible at once
  };
  const mainFits = (s: Shot) => {
    if (!s.framed) return true;
    const box = normBox(s.box);
    if (!box) return true;
    const ar = arOf(s);
    const c = clamp(ar, DUO_MIN_AR, DUO_MAX_AR);
    const need = ar < c ? box.y1 - box.y0 : box.x1 - box.x0;
    return need <= kept(s) + 1e-6;
  };
  return kept(a) >= DUO_MAX_CROP && kept(b) >= DUO_MAX_CROP
    && mainFits(a) && mainFits(b) && duoFit(a, b).area >= DUO_MIN_AREA;
}

/** Subject on one axis: centre c plus the extent that should stay framed
 * (lo === hi for a bare focus point). */
type Subj = {c: number; lo: number; hi: number};

/** The crop window on one axis, in panel fractions: the visible slice of the
 * panel is [w, w + vis]. Three nested ranges, and each one only binds when the
 * one above it leaves room:
 *   1. the SUBJECT  — the whole reader box (else its centre) stays visible;
 *   2. the ART     — the window stays inside [art_top, art_bottom];
 *   3. the HOLD    — the room hold.ts's own art shuttle needs (artInsets).
 * The window starts on the subject and drifts TOWARD the focus point by at most
 * PAN_BUDGET. Content beats cosmetics: level 3 is the first to be given up, and
 * the slide is what disappears before the subject does. */
function slide(vis: number, subj: Subj, target: number, artLo: number, artHi: number,
  insetLo: number, insetHi: number) {
  const span = Math.max(0, 1 - vis);
  const rangeLo = Math.max(0, clamp(artLo, 0, 1));
  const rangeHi = Math.min(span, clamp(artHi, 0, 1) - vis);
  // The panel bounds always win: a window that leaves the panel shows blank at
  // the card edge, and neither the art bounds nor the hold's motion may push it
  // out (keep() also collapses an inverted range onto its low end).
  const keep = (v: number) => clamp(clamp(v, rangeLo, Math.max(rangeLo, rangeHi)), 0, span);
  const whole = subj.hi - subj.lo <= vis;
  const eLo = Math.max(whole ? subj.hi - vis : subj.c - vis, rangeLo);
  const eHi = Math.min(whole ? subj.lo : subj.c, rangeHi);
  const fLo = Math.max(eLo, rangeLo + insetLo);
  const fHi = Math.min(eHi, rangeHi - insetHi);
  const useF = fHi > fLo;
  const lo = useF ? fLo : eLo;
  const hi = useF ? fHi : eHi;
  const wSubj = keep(clamp(subj.c - vis / 2, lo, hi));
  const w0 = PAN_START === 'opposite' ? (wSubj <= (lo + hi) / 2 ? hi : lo) : wSubj;
  const w1 = keep(clamp(w0 + clamp(target - subj.c, -PAN_BUDGET, PAN_BUDGET), lo, hi));
  return {start: w0, end: w1, vis, span};
}

/** Room to leave for hold.ts's remaining art motion on each edge of the crop
 * axis, in panel fractions: hold.ts shuttles the art inside the card by
 * +-SHUTTLE_ART_X*cardW / +-SHUTTLE_ART_X*cardH, and a card pixel is `vis` of
 * the panel on the cropped axis, so those card pixels are SHUTTLE_ART_X*vis of
 * the panel and they move the crop WINDOW exactly as much as they move the art.
 * Reserving them keeps the window off the panel's outermost pixel row, and it
 * costs the same share on both sides, so it never shifts where the slide
 * starts or ends.
 *
 * This used to carry a second, 6x larger term (DRIFT_ART*vis*ART_RESERVE, the
 * room the vertical art counter-move needed). It is gone because it was
 * provably unable to do the job it was written for: the browser clips the art to
 * the img box before the transform, so a bare card edge is decided by
 * zoom*|artY| vs (zoom-1)/2*cardH and by nothing this file controls -- see the
 * header. hold.ts fixed that side; this file stops guessing at it and hands the
 * range back to the slide. */
function artInsets(vis: number) {
  const sway = SHUTTLE_ART_X * vis;                 // symmetric: reserved whole
  return {lo: sway, hi: sway};
}

/** object-position for the hold. The p interpolation runs 0 -> 1 across the
 * shot (entry -> exit), so the window is fixed at the neutral start for the
 * first frame and eases into the focus by the last. Returns the CSS
 * object-position; the visible slice in panel fractions is
 * [start, start + vis] before the hold's own push-in. */
export function panPosition(s: Shot, cardW: number, cardH: number, frame: number, startF: number, endF: number) {
  const imgAr = arOf(s);
  const cardAr = cardW / Math.max(1, cardH);
  const safeStartF = Number.isFinite(startF) ? startF : 0;
  const safeEndF = Math.max(safeStartF + 1, Number.isFinite(endF) ? endF : safeStartF + 1);
  const p = interpolate(frame, [safeStartF, safeEndF], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.sin),
  });
  // Card already has the panel's framing (soloFit, or a duo card): nothing to
  // reveal, and a static window is exactly the "no heavy slideshow" answer.
  if (Math.abs(imgAr - cardAr) / cardAr < FIT_EPS) return '50% 50%';
  const box = normBox(s.box);
  if (imgAr < cardAr) {
    // Taller art: the card is short of height, so the window slides on y.
    const vis = clamp(imgAr / cardAr, 0.05, 1);
    if (!(vis < 1)) return '50% 50%';
    const fy = num(s.focus_y ?? s.focusY, NaN);
    const c = box ? (box.y0 + box.y1) / 2 : isFinite(fy) ? clamp(fy, 0, 1) : 0.5;
    const inset = artInsets(vis);
    const sl = slide(vis, box ? {c, lo: box.y0, hi: box.y1} : {c, lo: c, hi: c},
      isFinite(fy) ? clamp(fy, 0, 1) : c, num(s.art_top, 0), num(s.art_bottom, 1),
      inset.lo, inset.hi);
    const w = sl.start + p * (sl.end - sl.start);
    return `50% ${((w / sl.span) * 100).toFixed(2)}%`;
  }
  // Wider art: the card is short of width, so the window slides on x. There are
  // no horizontal art bounds in the shot schema, so it may use the full width.
  const vis = clamp(cardAr / imgAr, 0.05, 1);
  if (!(vis < 1)) return '50% 50%';
  const fx = num(s.focus_x, NaN);
  const c = box ? (box.x0 + box.x1) / 2 : isFinite(fx) ? clamp(fx, 0, 1) : 0.5;
  const inset = artInsets(vis);
  const sl = slide(vis, box ? {c, lo: box.x0, hi: box.x1} : {c, lo: c, hi: c},
    isFinite(fx) ? clamp(fx, 0, 1) : c, 0, 1, inset.lo, inset.hi);
  const w = sl.start + p * (sl.end - sl.start);
  return `${((w / sl.span) * 100).toFixed(2)}% 50%`;
}

/** Explicit source-image placement for art-focused shots. Keep the push-in, but
 * limit it at the main visual instead of scaling an already-clipped img box.
 * Both solo and duo use this same source-space geometry. Old shots are untouched. */
export function framedArt(s: Shot, w: number, h: number, zoom: number, dx: number, dy: number) {
  if (!s.framed) return null;
  const pw = Math.max(1, num(s.pw, 800));
  const ph = Math.max(1, num(s.ph, 1422));
  const b = normBox(s.box);
  const cover = Math.max(w / pw, h / ph);
  const limit = b ? Math.min(w / ((b.x1 - b.x0) * pw), h / ((b.y1 - b.y0) * ph)) / cover : zoom;
  const z = clamp(zoom, 1, Math.max(1, limit));
  const iw = pw * cover * z;
  const ih = ph * cover * z;
  const aim = (size: number, image: number, focus: number, lo: number, hi: number, motion: number) => {
    const low = Math.max(size - image, -lo * image);
    const high = Math.min(0, size - hi * image);
    const desired = size / 2 - focus * image + motion;
    // The card is always covered; subject wins over shuttle distance.
    return low <= high + 1e-6
      ? clamp(desired, Math.min(low, high), Math.max(low, high))
      : clamp(desired, size - image, 0);
  };
  const fx = clamp(num(s.focus_x, b ? (b.x0 + b.x1) / 2 : .5), 0, 1);
  const fy = clamp(num(s.focus_y ?? s.focusY, b ? (b.y0 + b.y1) / 2 : .5), 0, 1);
  return {width: iw, height: ih,
    left: aim(w, iw, fx, b?.x0 ?? fx, b?.x1 ?? fx, dx),
    top: aim(h, ih, fy, b?.y0 ?? fy, b?.y1 ?? fy, dy)};
}
