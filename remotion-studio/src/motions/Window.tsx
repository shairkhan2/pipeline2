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
import type {Shot} from './types';

export const WindowLayout: React.FC<{shots: Shot[]; glowRgb: string}> = ({shots}) => {
  const {fps} = useVideoConfig();
  const premountFor = Math.round(WINDOW_PREMOUNT_S * fps);
  return (
    <>
      {shots.map((s, i) => {
        const from = Math.round(s.start_s * fps);
        const next = shots[i + 1];
        // Close any gap: run to the next shot's first frame, else to our own end.
        const to = next ? Math.round(next.start_s * fps) : Math.round(s.end_s * fps);
        const dur = Math.max(1, to - from);
        return (
          <Sequence
            key={i}
            from={from}
            durationInFrames={dur}
            premountFor={premountFor}
            name={`shot-${i}`}
          >
            <WindowCard shot={s} durationInFrames={dur} fps={fps} />
          </Sequence>
        );
      })}
    </>
  );
};
