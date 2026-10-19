/* SoloCard — one physical card, native aspect. The cut preset's atom and the
 * duo preset's fallback for big (weight 3) or leftover panels.
 * from = screen side it enters from; exitTo = side it leaves to (default:
 * opposite of entry, like the original cut). entryDelayF staggers entrances;
 * exitStartF/exitEndF place a custom exit window; cardW/cardH/centerX place it.
 */
import React from 'react';
import {
  AbsoluteFill,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';
import {ENTRY_S, EXIT_S, SHUTTLE_X, W} from './tunables';
import {holdParts, glowOf} from './hold';
import {soloFit, panPosition, framedArt} from './fit';
import type {Shot} from './types';

type Props = {
  shot: Shot;
  index: number;
  glowRgb: string;
  from?: 'left' | 'right';
  exitTo?: 'left' | 'right';
  entryDelayF?: number;
  exitStartF?: number;
  exitEndF?: number;
  cardW?: number;
  cardH?: number;
  centerX?: number;
};

export const SoloCard: React.FC<Props> = ({
  shot,
  index,
  glowRgb,
  from,
  exitTo,
  entryDelayF = 0,
  exitStartF,
  exitEndF,
  cardW,
  cardH,
  centerX = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const durS = Math.max(0.1, shot.end_s - shot.start_s);
  const totalF = Math.max(1, Math.round(durS * fps));

  const focusY = shot.focus_y ?? shot.focusY ?? 0.5;

  // Clamped-aspect card that uses the frame; cropped art pans into view (fit.ts).
  const fit = soloFit(shot);
  const w = cardW ?? fit.w;
  const h = cardH ?? fit.h;

  const inSide = from ?? (index % 2 === 0 ? 'left' : 'right');
  const outSide = exitTo ?? (inSide === 'left' ? 'right' : 'left');
  const inSign = inSide === 'left' ? 1 : -1;
  const outSign = outSide === 'left' ? -1 : 1;
  const entryF = ENTRY_S * fps;
  const exitF = EXIT_S * fps;
  const eStart = exitStartF ?? totalF - exitF;
  const eEnd = exitEndF ?? totalF;

  const lframe = frame - entryDelayF;
  const entryP = interpolate(lframe, [0, entryF], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const exitP = interpolate(frame, [eStart, eEnd], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  // Horizontal: off-screen -> center -> off-screen opposite side.
  const offX = W / 2 + w / 2 + 80;
  const shuttle = Math.sin((frame / fps) * Math.PI * 2 * 0.12 + index) * SHUTTLE_X * W;
  const entryX = (1 - entryP) * -inSign * offX;
  const x = shuttle * entryP * (1 - exitP) + exitP * outSign * offX;

  const hp = holdParts(frame, fps, index, focusY, w, h, entryF + entryDelayF, eStart);

  // Glow flares on entry/exit, calm on hold.
  const entryFlare =
    lframe < entryF ? 1 - Math.max(0, lframe) / Math.max(1, entryF) : 0;
  const glow = glowOf(entryFlare, exitP);
  const objectPosition = panPosition(shot, w, h, frame, entryDelayF, eEnd);
  const art = framedArt(shot, w, h, hp.zoom, hp.artX, hp.artY);

  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      <div
        style={{
          width: w,
          height: h,
          position: 'relative',
          transform: `translateX(${centerX + entryX + x + hp.shakeX}px) translateY(${hp.driftY + hp.shakeY}px) rotate(${hp.tilt}deg)`,
          background: '#000',
          border: '3px solid #0a0a0c',
          outline: '1px solid rgba(255,255,255,0.9)',
          boxShadow: `0 18px 60px rgba(0,0,0,0.7), 0 0 42px rgba(${glowRgb},${glow.toFixed(3)})`,
          overflow: 'hidden',
        }}
      >
        <img
          src={staticFile(shot.panel)}
          style={art ? {position: 'absolute', ...art, maxWidth: 'none'} : {
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition,
            transform: `scale(${hp.zoom.toFixed(4)}) translateX(${hp.artX.toFixed(2)}px) translateY(${hp.artY.toFixed(2)}px)`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
