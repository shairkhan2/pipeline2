/* WindowCard — one webtoon "window" over its own blurred backdrop.
 * The panel is height-fit to the frame (width-fit when wider than 16:9) and
 * centred. Behind it the same image covers the frame, blurred and darkened.
 * Motion: a slow linear push-in about the subject point; the card itself and
 * the backdrop stay still, so the cut between shots is the only hard move.
 * Scaling >= 1 about a point inside the card never bares a card edge.
 */
import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {
  W,
  H,
  WINDOW_MIN_AR,
  WINDOW_ZOOM,
  WINDOW_ZOOM_RATE,
  WINDOW_BOX_ZOOM_FLOOR,
  WINDOW_BG_BLUR,
  WINDOW_BG_BRIGHTNESS,
  WINDOW_BG_SATURATE,
  WINDOW_BG_OVERSCALE,
  WINDOW_BG_DOWNSCALE,
  WINDOW_SHADOW,
} from './tunables';
import type {Shot, ShotBox} from './types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, d: number) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? d : n;
};

function normBox(b?: ShotBox) {
  if (!b) return null;
  const x0 = clamp(num(b.x0, 0), 0, 1);
  const x1 = clamp(num(b.x1, 1), 0, 1);
  const y0 = clamp(num(b.y0, 0), 0, 1);
  const y1 = clamp(num(b.y1, 1), 0, 1);
  return x1 - x0 > 0.01 && y1 - y0 > 0.01 ? {x0, x1, y0, y1} : null;
}

/** Card + art geometry in frame pixels. Pure, so it is easy to reason about. */
export function windowGeometry(s: Shot) {
  const pw = Math.max(1, num(s.pw, 800));
  const ph = Math.max(1, num(s.ph, 1422));
  const ar = pw / ph;
  const box = normBox(s.box);
  const fx = clamp(num(s.focus_x, box ? (box.x0 + box.x1) / 2 : 0.5), 0, 1);
  const fy = clamp(num(s.focus_y ?? s.focusY, box ? (box.y0 + box.y1) / 2 : 0.5), 0, 1);

  // Card: full height, or full width for strips wider than the frame.
  // Very tall strips get a WINDOW_MIN_AR card and the art is cropped on y.
  const cardAr = Math.max(ar, WINDOW_MIN_AR);
  let w = H * cardAr;
  let h = H;
  if (w > W) {
    w = W;
    h = W / cardAr;
  }
  w = Math.round(w);
  h = Math.round(h);

  // Art covers the card; crop window centred on the subject on the cropped axis.
  const cover = Math.max(w / pw, h / ph);
  const iw = pw * cover;
  const ih = ph * cover;
  const left = clamp(w / 2 - fx * iw, w - iw, 0);
  const top = clamp(h / 2 - fy * ih, h - ih, 0);

  // Push-in origin: the subject point, expressed in card pixels.
  const ox = clamp(left + fx * iw, 0, w);
  const oy = clamp(top + fy * ih, 0, h);

  // Largest zoom that still keeps the reader box inside the card.
  let boxLimit = Infinity;
  if (box && s.framed) {
    const bw = ((box.x1 - box.x0) * iw) / w;
    const bh = ((box.y1 - box.y0) * ih) / h;
    boxLimit = Math.max(WINDOW_BOX_ZOOM_FLOOR, 1 / Math.max(bw, bh, 1e-3));
  }
  return {w, h, iw, ih, left, top, ox, oy, boxLimit};
}

/** End zoom for a shot: weight sets the target, duration caps the speed. */
export function windowZoomEnd(s: Shot, durS: number, boxLimit = Infinity) {
  const weight = clamp(Math.round(num(s.weight, 1)), 1, 3);
  const target = WINDOW_ZOOM[weight - 1];
  const z = 1 + Math.min(target, WINDOW_ZOOM_RATE * Math.max(0, durS));
  return Math.max(1, Math.min(z, boxLimit));
}

const Backdrop: React.FC<{src: string}> = ({src}) => {
  // Blur at 1/DOWNSCALE size then scale up: same look, a fraction of the cost.
  const k = WINDOW_BG_DOWNSCALE;
  const bw = W / k;
  const bh = H / k;
  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#000'}}>
      <div
        style={{
          position: 'absolute',
          left: (W - bw) / 2,
          top: (H - bh) / 2,
          width: bw,
          height: bh,
          transform: `scale(${(k * WINDOW_BG_OVERSCALE).toFixed(4)})`,
          transformOrigin: '50% 50%',
        }}
      >
        <Img
          src={src}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: `blur(${(WINDOW_BG_BLUR / k).toFixed(2)}px) brightness(${WINDOW_BG_BRIGHTNESS}) saturate(${WINDOW_BG_SATURATE})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const WindowCard: React.FC<{shot: Shot; durationInFrames: number; fps: number}> = ({
  shot,
  durationInFrames,
  fps,
}) => {
  const frame = useCurrentFrame();
  const src = staticFile(shot.panel);
  const g = windowGeometry(shot);
  const zEnd = windowZoomEnd(shot, durationInFrames / fps, g.boxLimit);
  const z = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [1, zEnd], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill>
      <Backdrop src={src} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            width: g.w,
            height: g.h,
            position: 'relative',
            overflow: 'hidden',
            boxShadow: WINDOW_SHADOW,
          }}
        >
          <Img
            src={src}
            style={{
              position: 'absolute',
              left: g.left,
              top: g.top,
              width: g.iw,
              height: g.ih,
              maxWidth: 'none',
              transformOrigin: `${(g.ox - g.left).toFixed(2)}px ${(g.oy - g.top).toFixed(2)}px`,
              transform: `scale(${z.toFixed(5)})`,
              willChange: 'transform',
            }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
