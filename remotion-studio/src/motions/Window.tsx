/* Window — recap-channel layout: one height-fit panel per shot over its own
 * blurred backdrop, hard cuts, slow push-in. Shots are laid end to end on the
 * frame grid (each Sequence starts where the previous one ends), so there is
 * never an empty frame between them; the next shot is premounted so its image
 * is decoded before the cut.
 */
import React from 'react';
import {Sequence, useVideoConfig} from 'remotion';
import {WindowCard} from './WindowCard';
import {WINDOW_PREMOUNT_S} from './tunables';
import {planShots, resolveAnimation, type CardAnimation} from './animation';
import type {Shot} from './types';

export const WindowLayout: React.FC<{shots: Shot[]; glowRgb: string; animation?: CardAnimation | null}> = ({
  shots,
  animation,
}) => {
  const {fps} = useVideoConfig();
  const premountFor = Math.round(WINDOW_PREMOUNT_S * fps);
  const anim = resolveAnimation(animation);
  // Close any gap: each shot runs to the next shot's first frame (else its own
  // end), plus the next shot's entry length so it stays painted underneath.
  const plans = planShots(shots, fps, anim);
  return (
    <>
      {shots.map((s, i) => {
        const plan = plans[i];
        return (
          <Sequence
            key={i}
            from={plan.from}
            durationInFrames={plan.seqDur}
            premountFor={premountFor}
            name={`shot-${i}`}
          >
            <WindowCard shot={s} durationInFrames={plan.dur} fps={fps} plan={plan} animation={anim} first={i === 0} />
          </Sequence>
        );
      })}
    </>
  );
};
