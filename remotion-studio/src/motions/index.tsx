/* Motion registry — plug-and-play like backgrounds.
 * To add a preset: create ./MyMotion.tsx exporting a Layout component,
 * add one line below. Swap per render via props: {"motion": "duo"}.
 */
import React from 'react';
import {CutLayout} from './Cut';
import {DuoLayout} from './Duo';
import {WindowLayout} from './Window';
import type {Shot} from './types';

export type MotionId = 'window' | 'cut' | 'duo';

type Layout = React.FC<{shots: Shot[]; glowRgb: string}>;

// ownsBackdrop: the layout paints its own full-frame backdrop per shot, so the
// procedural background (src/backgrounds/) is not rendered behind it.
export const MOTIONS: Record<MotionId, {label: string; Layout: Layout; ownsBackdrop: boolean}> = {
  window: {label: 'Window (default: height-fit panel over its own blurred copy, hard cuts, slow push-in)', Layout: WindowLayout, ownsBackdrop: true},
  cut: {label: 'Cut (one card, alternating slide + shake)', Layout: CutLayout, ownsBackdrop: false},
  duo: {label: 'Duo (two cards side by side, same-side exits; weight-3 goes solo)', Layout: DuoLayout, ownsBackdrop: false},
};

export const DEFAULT_MOTION: MotionId = 'window';

export const isMotionId = (v: unknown): v is MotionId =>
  typeof v === 'string' && (v as string) in MOTIONS;

export const resolveMotion = (id?: string): MotionId =>
  isMotionId(id) ? id : DEFAULT_MOTION;

export const motionOwnsBackdrop = (id?: string): boolean => MOTIONS[resolveMotion(id)].ownsBackdrop;

export const MotionLayout: React.FC<{id?: string; shots: Shot[]; glowRgb: string}> = ({
  id,
  shots,
  glowRgb,
}) => {
  const {Layout} = MOTIONS[resolveMotion(id)];
  return <Layout shots={shots} glowRgb={glowRgb} />;
};
