/* Recap.tsx — clean-cut style (motion v5, user-tuned 2026-09-08).
 * Contract: docs/remotion-renderer.md in the pipeline repo.
 * A panel is a physical card with NATIVE aspect. Motion is plug-and-play:
 * src/motions/ (default window). Background is plug-and-play: src/backgrounds/,
 * drawn only behind motions that do not paint their own backdrop.
 * Sharp corners, hairline edge.
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Loop,
  staticFile,
  useVideoConfig,
  type CalculateMetadataFunction,
} from 'remotion';
import {Background, backgroundGlow, type BackgroundId} from './backgrounds';
import {MotionLayout, motionOwnsBackdrop, type MotionId} from './motions';
import {W, H} from './motions/tunables';

export type {Shot, ShotBox} from './motions/types';
import type {Shot} from './motions/types';
import type {CardAnimation} from './motions/animation';
export type {CardAnimation} from './motions/animation';

export type RecapProps = {
  shots: Shot[];
  audio: string;
  volume?: number;
  background?: BackgroundId | string;
  motion?: MotionId | string;
  /** Card entry/exit/push-in (window motion only). Absent = hard cuts, today's push-in. */
  animation?: CardAnimation | null;
  /** Optional music bed (off unless the pipeline sets it). Loops under the narration. */
  music?: {src: string; volume?: number; loopS?: number} | null;
};

const MusicBed: React.FC<{src: string; volume: number; loopS?: number}> = ({src, volume, loopS}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const fade = Math.round(fps * 1.5);
  const vol = (f: number) =>
    volume * Math.max(0, Math.min(1, f / fade, (durationInFrames - f) / fade));
  const audio = <Audio src={staticFile(src)} volume={vol} />;
  return loopS && loopS > 0 ? <Loop durationInFrames={Math.round(loopS * fps)}>{audio}</Loop> : audio;
};

export const Recap: React.FC<RecapProps> = ({shots, audio, volume, background, motion, animation, music}) => {
  const glowRgb = backgroundGlow(background);
  return (
    <AbsoluteFill>
      {motionOwnsBackdrop(motion) ? <AbsoluteFill style={{background: '#000'}} /> : <Background id={background} />}
      <MotionLayout id={motion} shots={shots} glowRgb={glowRgb} animation={animation} />
      {audio ? <Audio src={staticFile(audio)} volume={volume ?? 1} /> : null}
      {music?.src ? <MusicBed src={music.src} volume={music.volume ?? 0.12} loopS={music.loopS} /> : null}
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
