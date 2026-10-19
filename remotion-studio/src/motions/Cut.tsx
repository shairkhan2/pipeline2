/* Cut — the original motion v5: one card at a time, alternating entry sides,
 * fast slide in, slow hold, snap out the opposite side.
 */
import React from 'react';
import {Sequence, useVideoConfig} from 'remotion';
import {SoloCard} from './SoloCard';
import type {Shot} from './types';

export const CutLayout: React.FC<{shots: Shot[]; glowRgb: string}> = ({shots, glowRgb}) => {
  const {fps} = useVideoConfig();
  return (
    <>
      {shots.map((s, i) => {
        const from = Math.round(s.start_s * fps);
        const dur = Math.max(1, Math.round((s.end_s - s.start_s) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur} name={`shot-${i}`}>
            <SoloCard shot={s} index={i} glowRgb={glowRgb} />
          </Sequence>
        );
      })}
    </>
  );
};
