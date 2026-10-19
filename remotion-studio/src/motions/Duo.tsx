/* Duo — two cards share the frame, side by side with a gutter gap.
 * Left card slides in from the left with shake, right card follows from the
 * right. Each card leaves back out the side it came from (same-side exits);
 * which card leaves first flips per pair so exits never sync.
 * Tops and bottoms sit on one common line. A weight-3 panel, an odd leftover,
 * or a pair that would shrink each other (fit.ts duoFits) goes solo full-size.
 */
import React from 'react';
import {Sequence, useVideoConfig} from 'remotion';
import {EXIT_S} from './tunables';
import {SoloCard} from './SoloCard';
import {duoFit, duoFits} from './fit';
import type {Shot} from './types';

const ENTER_GAP_S = 0.22;

type Unit = {kind: 'solo'; i: number} | {kind: 'pair'; i: number; j: number};

export function units(shots: Shot[]): Unit[] {
  const out: Unit[] = [];
  let k = 0;
  while (k < shots.length) {
    const a = shots[k];
    const b = shots[k + 1];
    // pair only when both panels stay big side by side AND share one valid narration
    // line; otherwise solo fills the frame. `!b` guards b before b.line_id is read.
    if (
      (a.weight ?? 2) === 3 ||
      !b ||
      (b.weight ?? 2) === 3 ||
      !(
        typeof a.line_id === 'number' &&
        Number.isInteger(a.line_id) &&
        a.line_id >= 0 &&
        a.line_id === b.line_id
      ) ||
      !duoFits(a, b)
    ) {
      out.push({kind: 'solo', i: k});
      k += 1;
    } else {
      out.push({kind: 'pair', i: k, j: k + 1});
      k += 2;
    }
  }
  return out;
}

export const DuoLayout: React.FC<{shots: Shot[]; glowRgb: string}> = ({shots, glowRgb}) => {
  const {fps} = useVideoConfig();
  const us = units(shots);
  return (
    <>
      {us.map((u, pi) => {
        if (u.kind === 'solo') {
          const s = shots[u.i];
          const from = Math.round(s.start_s * fps);
          const dur = Math.max(1, Math.round((s.end_s - s.start_s) * fps));
          return (
            <Sequence key={pi} from={from} durationInFrames={dur} name={`solo-${u.i}`}>
              <SoloCard shot={s} index={u.i} glowRgb={glowRgb} />
            </Sequence>
          );
        }
        const a = shots[u.i];
        const b = shots[u.j];
        const from = Math.round(a.start_s * fps);
        const dur = Math.max(1, Math.round((b.end_s - a.start_s) * fps));
        const exitF = EXIT_S * fps;
        const delayF = Math.min(ENTER_GAP_S * fps, dur * 0.15);
        const {w1, w2, ch, totalW} = duoFit(a, b);
        const cx1 = -totalW / 2 + w1 / 2;
        const cx2 = totalW / 2 - w2 / 2;
        // Exit order flips per pair: exits stay mirrored, never synced.
        const leftFirst = pi % 2 === 0;
        const eL = leftFirst ? [dur - 2 * exitF, dur - exitF] : [dur - exitF, dur];
        const eR = leftFirst ? [dur - exitF, dur] : [dur - 2 * exitF, dur - exitF];
        return (
          <Sequence key={pi} from={from} durationInFrames={dur} name={`duo-${u.i}-${u.j}`}>
            <SoloCard
              shot={a}
              index={u.i}
              glowRgb={glowRgb}
              from="left"
              exitTo="left"
              entryDelayF={0}
              exitStartF={Math.max(0, eL[0])}
              exitEndF={eL[1]}
              cardW={w1}
              cardH={ch}
              centerX={cx1}
            />
            <SoloCard
              shot={b}
              index={u.j}
              glowRgb={glowRgb}
              from="right"
              exitTo="right"
              entryDelayF={delayF}
              exitStartF={Math.max(0, eR[0])}
              exitEndF={eR[1]}
              cardW={w2}
              cardH={ch}
              centerX={cx2}
            />
          </Sequence>
        );
      })}
    </>
  );
};
