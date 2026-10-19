/* Shared hold feel — every preset breathes the same way once on screen:
 * focus-following drift + a small art shuttle + micro-shake + push-in.
 * The vertical ART COUNTER-MOVE is deliberately NOT here any more: the img box
 * is the clip, so any art translate that outruns the push-in's coverage bares
 * a black band on the card (see artY below). artX/artY now only ever shuttle.
 */
import {interpolate} from 'remotion';
import {
  DRIFT_CARD,
  DRIFT_ART,
  SHUTTLE_ART_X,
  SHAKE_AMP,
  SHAKE_TILT,
  SHAKE_HZ,
  HOLD_ZOOM,
  GLOW_MAX,
  GLOW_CALM,
} from './tunables';

export function holdParts(
  frame: number,
  fps: number,
  index: number,
  focusY: number,
  cardW: number,
  cardH: number,
  entryF: number,
  holdEndF: number,
) {
  const t = frame / fps;
  const safeEntryF = Number.isFinite(entryF) ? entryF : 0;
  const safeHoldEndF = Math.max(safeEntryF + 0.001, Number.isFinite(holdEndF) ? holdEndF : safeEntryF + 0.001);
  const holdP = interpolate(frame, [safeEntryF, safeHoldEndF], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const driftDir = focusY > 0.55 ? 1 : focusY < 0.45 ? -1 : 0;
  const driftY = driftDir * holdP * DRIFT_CARD * cardH;
  const phase = index * 1.7;
  const shakeX = Math.sin(t * Math.PI * 2 * SHAKE_HZ + phase) * SHAKE_AMP;
  const shakeY = Math.cos(t * Math.PI * 2 * SHAKE_HZ * 0.9 + phase) * SHAKE_AMP;
  const tilt = Math.sin(t * Math.PI * 2 * SHAKE_HZ + phase * 2) * SHAKE_TILT;
  const zoom = 1 + HOLD_ZOOM * holdP + DRIFT_ART;
  // artY is SHUTTLE ONLY. The old -driftDir*holdP*DRIFT_ART*cardH is gone
  // because it is arithmetically unable not to bare a card edge:
  //   the img fills the card's content box, the browser clips the cover-painted
  //   art to THAT box, and only then applies the transform, so a band appears
  //   iff  z*|artY| > (z-1)/2 * cardH  (z*|artY| is how far the clip box moves
  //   out, (z-1)/2*cardH is how far the push-in grew it).
  //   z = 1 + HOLD_ZOOM*holdP + DRIFT_ART runs 1.09 -> 1.14, so the allowance
  //   is 4.5% -> 7% of cardH, while DRIFT_ART*cardH = 9% (+-1.5% shuttle) sat
  //   OUTSIDE it on every frame from the first third of the hold on: measured
  //   over all 9314 real shots (series/*/out/ch*/video/shots.json, crossed with
  //   the real panel files) 4171 shots bare a band at the hold's last frame -
  //   exactly the shots with focus_y < 0.45 (2087, band at the top) or
  //   focus_y > 0.55 (2084, band at the bottom), because driftDir is 0 in
  //   between - 44.8% of shots, median 21px, max 35px.
  //   What that term actually moved was the CROP WINDOW, and fit.ts already
  //   owns that pan (bounded by PAN_BUDGET and the subject box); this one was a
  //   second, unbounded one that fought it. With it gone the only vertical art
  //   motion left is the shuttle, |artY| <= SHUTTLE_ART_X*cardH = 1.5% of cardH,
  //   so z*|artY| <= 1.7% < the 4.5% floor of the allowance: a bare edge is now
  //   impossible by a 2.6x margin, whatever the pan or the focus does.
  const artY = Math.sin(t * Math.PI * 2 * SHAKE_HZ + phase) * -SHUTTLE_ART_X * cardH;
  const artX = Math.cos(t * Math.PI * 2 * SHAKE_HZ * 0.8 + phase) * -SHUTTLE_ART_X * cardW;
  return {driftY, shakeX, shakeY, tilt, zoom, artX, artY};
}

export function glowOf(entryFlare: number, exitP: number) {
  return GLOW_CALM + entryFlare * (GLOW_MAX - GLOW_CALM) + exitP * (GLOW_MAX - GLOW_CALM);
}
