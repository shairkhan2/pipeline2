/* Recap.tsx — clean-cut style (motion v5, user-tuned 2026-09-08).
 * Contract: docs/remotion-renderer.md in the pipeline repo.
 * A panel is a physical card with NATIVE aspect. Motion is plug-and-play:
 * src/motions/ (default cut). Background is plug-and-play: src/backgrounds/.
 * Sharp corners, hairline edge.
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  staticFile,
  type CalculateMetadataFunction,
} from 'remotion';
import {Background, backgroundGlow, type BackgroundId} from './backgrounds';
import {MotionLayout, type MotionId} from './motions';
import {W, H} from './motions/tunables';

export type {Shot, ShotBox} from './motions/types';
import type {Shot} from './motions/types';

export type RecapProps = {
  shots: Shot[];
  audio: string;
  volume?: number;
  background?: BackgroundId | string;
  motion?: MotionId | string;
};

export const Recap: React.FC<RecapProps> = ({shots, audio, volume, background, motion}) => {
  const glowRgb = backgroundGlow(background);
  return (
    <AbsoluteFill>
      <Background id={background} />
      <MotionLayout id={motion} shots={shots} glowRgb={glowRgb} />
      {audio ? <Audio src={staticFile(audio)} volume={volume ?? 1} /> : null}
    </AbsoluteFill>
  );
};

export const calculateRecapMetadata: CalculateMetadataFunction<RecapProps> = async ({props}) => {
  const shots = props.shots ?? [];
  const maxEnd = shots.reduce((m, s) => Math.max(m, s.end_s ?? 0), 0);
  return {
    durationInFrames: Math.max(1, Math.ceil(maxEnd * 30)),
    fps: 30,
    width: W,
    height: H,
  };
};
