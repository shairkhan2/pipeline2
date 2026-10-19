/* Motion registry — plug-and-play like backgrounds.
 * To add a preset: create ./MyMotion.tsx exporting a Layout component,
 * add one line below. Swap per render via props: {"motion": "duo"}.
 */
import React from 'react';
import {CutLayout} from './Cut';
import {DuoLayout} from './Duo';
import type {Shot} from './types';

export type MotionId = 'cut' | 'duo';

type Layout = React.FC<{shots: Shot[]; glowRgb: string}>;

export const MOTIONS: Record<MotionId, {label: string; Layout: Layout}> = {
  cut: {label: 'Cut (default: one card, alternating slide + shake)', Layout: CutLayout},
  duo: {label: 'Duo (two cards side by side, same-side exits; weight-3 goes solo)', Layout: DuoLayout},
};

export const DEFAULT_MOTION: MotionId = 'cut';

export const isMotionId = (v: unknown): v is MotionId =>
  typeof v === 'string' && (v as string) in MOTIONS;

export const MotionLayout: React.FC<{id?: string; shots: Shot[]; glowRgb: string}> = ({
  id,
  shots,
  glowRgb,
}) => {
  const key = (isMotionId(id) ? id : DEFAULT_MOTION) as MotionId;
  const {Layout} = MOTIONS[key];
  return <Layout shots={shots} glowRgb={glowRgb} />;
};
