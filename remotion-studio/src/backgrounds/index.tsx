/* Background registry — plug-and-play.
 * To add a preset: create ./MyPreset.tsx, add one line below.
 * Swap per render via props: {"background": "storm-valley"}
 * or per series via meta.json: {"visuals": {"background": "storm-valley"}}
 */
import React from 'react';
import {Starfield} from './Starfield';
import {StormValley} from './StormValley';
import {MistPines} from './MistPines';

export type BackgroundId = 'starfield' | 'storm-valley' | 'mist-pines';

export const BACKGROUNDS: Record<BackgroundId, {label: string; glow: string; Comp: React.FC}> = {
  'starfield': {label: 'Deep-blue starfield (default)', glow: '34,211,238', Comp: Starfield},
  'storm-valley': {label: 'Storm valley ember (dark mountains + red foliage)', glow: '255,82,30', Comp: StormValley},
  'mist-pines': {label: 'Violet mist pines (fog valley + dark forest)', glow: '167,139,250', Comp: MistPines},
};

export const DEFAULT_BACKGROUND: BackgroundId = 'starfield';

export const isBackgroundId = (v: unknown): v is BackgroundId =>
  typeof v === 'string' && (v as string) in BACKGROUNDS;

export const Background: React.FC<{id?: string}> = ({id}) => {
  const key = (isBackgroundId(id) ? id : DEFAULT_BACKGROUND) as BackgroundId;
  const {Comp} = BACKGROUNDS[key];
  return <Comp />;
};

export const backgroundGlow = (id?: string): string =>
  BACKGROUNDS[isBackgroundId(id) ? (id as BackgroundId) : DEFAULT_BACKGROUND].glow;
