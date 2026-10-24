/**
 * Card animation: zod schema, render-prop normalization, and the Remotion
 * window preset's pure frame math (remotion-studio/src/motions/animation.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CARD_ENTRIES,
  CARD_EXITS,
  CARD_PUSH_INS,
  cardAnimationSchema,
  ingest,
  normalizeCardAnimation,
} from '../src/intake/ingest.js';
import { seriesSettingsPatchSchema } from '../src/player/seriesSettings.js';
import {
  DEFAULT_ANIMATION,
  ENTRIES,
  EXITS,
  PUSH_INS,
  cardFrame,
  planShots,
  pushInEnd,
  resolveAnimation,
  transitionFrames,
} from '../remotion-studio/src/motions/animation.js';

const FPS = 30;
const SIZE = { w: 1280, h: 720 };
const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

describe('card animation schema', () => {
  it('keeps the pipeline and renderer enums in sync', () => {
    expect([...CARD_ENTRIES]).toEqual([...ENTRIES]);
    expect([...CARD_EXITS]).toEqual([...EXITS]);
    expect([...CARD_PUSH_INS]).toEqual([...PUSH_INS]);
  });

  it('accepts empty, partial and full objects', () => {
    expect(cardAnimationSchema.safeParse({}).success).toBe(true);
    expect(cardAnimationSchema.safeParse({ entry: 'fade' }).success).toBe(true);
    expect(cardAnimationSchema.safeParse({
      entry: 'slide-left', exit: 'slide-down', entryS: 0, exitS: 1, pushIn: 'off', drift: false,
    }).success).toBe(true);
  });

  it.each([
    { entry: 'spin' },
    { exit: 'zoom' },
    { entryS: 1.5 },
    { exitS: -0.1 },
    { entryS: '0.2' },
    { pushIn: 'max' },
    { drift: 'yes' },
    { extra: 1 },
  ])('rejects %j', (value) => {
    expect(cardAnimationSchema.safeParse(value).success).toBe(false);
  });

  it('normalizes for render props: invalid or empty becomes null', () => {
    expect(normalizeCardAnimation(undefined)).toBeNull();
    expect(normalizeCardAnimation({})).toBeNull();
    expect(normalizeCardAnimation({ entry: 'nope' })).toBeNull();
    expect(normalizeCardAnimation({ entry: 'fade', exit: undefined })).toEqual({ entry: 'fade' });
  });

  it('settings patch accepts animation, null reset, and rejects bad values', () => {
    expect(seriesSettingsPatchSchema.safeParse({ visuals: { animation: { entry: 'zoom', pushIn: 'subtle' } } }).success).toBe(true);
    expect(seriesSettingsPatchSchema.safeParse({ visuals: { animation: null } }).success).toBe(true);
    expect(seriesSettingsPatchSchema.safeParse({ visuals: { animation: { entry: 'zoom', bogus: 1 } } }).success).toBe(false);
    expect(seriesSettingsPatchSchema.safeParse({ visuals: { animation: { entryS: 2 } } }).success).toBe(false);
  });
});

describe('ingest stores visuals.animation on a new series', () => {
  function zipWithChapter(dir: string): string {
    const zip = new AdmZip();
    zip.addFile('Chapter 1/001.jpg', Buffer.from('jpeg-bytes'));
    const p = path.join(dir, 'src.zip');
    zip.writeZip(p);
    return p;
  }
  it('writes a normalized animation and omits it when absent', () => {
    fs.mkdirSync('/tmp/opencode', { recursive: true });
    const root = fs.mkdtempSync('/tmp/opencode/card-anim-ingest-');
    tmpRoots.push(root);
    const zipPath = zipWithChapter(root);
    ingest('with-anim', { zipPath, seriesRoot: root, interactive: false, animation: { entry: 'fade', drift: false } });
    ingest('no-anim', { zipPath, seriesRoot: root, interactive: false });
    const a = JSON.parse(fs.readFileSync(path.join(root, 'with-anim', 'meta.json'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(root, 'no-anim', 'meta.json'), 'utf8'));
    expect(a.visuals).toEqual({ background: 'starfield', motion: 'window', animation: { entry: 'fade', drift: false } });
    expect(b.visuals).toEqual({ background: 'starfield', motion: 'window' });
  });
});

describe('renderer animation math', () => {
  const shots = [
    { start_s: 0, end_s: 2 },
    { start_s: 2, end_s: 4.5 },
    { start_s: 4.5, end_s: 5 },
  ];

  it('resolveAnimation fills defaults and drops invalid fields', () => {
    expect(resolveAnimation(undefined)).toEqual(DEFAULT_ANIMATION);
    expect(resolveAnimation(null)).toEqual(DEFAULT_ANIMATION);
    expect(resolveAnimation({ entry: 'spin', entryS: 9, pushIn: 'strong' })).toEqual({
      ...DEFAULT_ANIMATION, entryS: 1, pushIn: 'strong',
    });
  });

  it('defaults: back-to-back sequences with no overlap and an untouched card', () => {
    const plans = planShots(shots, FPS, DEFAULT_ANIMATION);
    expect(plans.map((p) => [p.from, p.dur, p.seqDur, p.entryF, p.exitF])).toEqual([
      [0, 60, 60, 0, 0],
      [60, 75, 75, 0, 0],
      [135, 15, 15, 0, 0],
    ]);
    for (let f = 0; f < 75; f++) {
      expect(cardFrame(f, plans[1]!, DEFAULT_ANIMATION, SIZE)).toEqual({ opacity: 1, scale: 1, dx: 0, dy: 0, backdropOpacity: 1 });
    }
  });

  it('entry overlaps the previous shot by the entry length so no frame is empty', () => {
    const anim = resolveAnimation({ entry: 'fade', exit: 'fade' });
    const plans = planShots(shots, FPS, anim);
    // 0.25 s at 30 fps = 8 frames (rounded); the 15-frame shot is clamped to 40% = 6.
    expect(plans[0]).toMatchObject({ from: 0, dur: 60, entryF: 8, exitF: 8, seqDur: 68 });
    expect(plans[1]).toMatchObject({ from: 60, dur: 75, seqDur: 75 + plans[2]!.entryF });
    expect(plans[2]!.entryF + plans[2]!.exitF).toBeLessThanOrEqual(6);
    // Every composition frame is covered by at least one mounted sequence.
    const last = plans[2]!.from + plans[2]!.seqDur;
    for (let f = 0; f < last; f++) {
      expect(plans.some((p) => f >= p.from && f < p.from + p.seqDur)).toBe(true);
    }
  });

  it('fade entry: backdrop is opaque by half the entry, card settles on the last entry frame', () => {
    const anim = resolveAnimation({ entry: 'fade', entryS: 0.3 });
    const plan = { dur: 90, entryF: 9, exitF: 0 };
    const f0 = cardFrame(0, plan, anim, SIZE);
    expect(f0.opacity).toBeGreaterThan(0);
    expect(f0.opacity).toBeLessThan(0.5);
    expect(f0.backdropOpacity).toBeCloseTo(2 / 9, 5);
    expect(cardFrame(4, plan, anim, SIZE).backdropOpacity).toBe(1);
    expect(cardFrame(8, plan, anim, SIZE).opacity).toBe(1);
    expect(cardFrame(9, plan, anim, SIZE)).toEqual({ opacity: 1, scale: 1, dx: 0, dy: 0, backdropOpacity: 1 });
    // The very first shot has nothing underneath: its backdrop never fades.
    expect(cardFrame(0, plan, anim, SIZE, true).backdropOpacity).toBe(1);
  });

  it('entry variants move the card and converge to rest', () => {
    const plan = { dur: 60, entryF: 8, exitF: 0 };
    expect(cardFrame(0, plan, resolveAnimation({ entry: 'zoom' }), SIZE).scale).toBeLessThan(1);
    expect(cardFrame(0, plan, resolveAnimation({ entry: 'slide-up' }), SIZE).dy).toBeGreaterThan(0);
    expect(cardFrame(0, plan, resolveAnimation({ entry: 'slide-left' }), SIZE).dx).toBeGreaterThan(0);
    for (const entry of ['zoom', 'slide-up', 'slide-left'] as const) {
      expect(cardFrame(7, plan, resolveAnimation({ entry }), SIZE)).toMatchObject({ opacity: 1, scale: 1, dx: 0, dy: 0 });
    }
  });

  it('exit reaches zero on the last visible frame and holds through the overlap', () => {
    const plan = { dur: 60, entryF: 0, exitF: 8 };
    const fade = resolveAnimation({ exit: 'fade' });
    expect(cardFrame(51, plan, fade, SIZE).opacity).toBe(1);
    expect(cardFrame(52, plan, fade, SIZE).opacity).toBeLessThan(1);
    expect(cardFrame(59, plan, fade, SIZE).opacity).toBe(0);
    expect(cardFrame(65, plan, fade, SIZE).opacity).toBe(0);
    expect(cardFrame(59, plan, resolveAnimation({ exit: 'zoom-out' }), SIZE).scale).toBeLessThan(1);
    expect(cardFrame(59, plan, resolveAnimation({ exit: 'slide-down' }), SIZE).dy).toBeGreaterThan(0);
    // The exiting shot's backdrop stays opaque, so the frame never goes black.
    expect(cardFrame(59, plan, fade, SIZE).backdropOpacity).toBe(1);
  });

  it('clamps entry + exit to 40% of a short shot', () => {
    const anim = resolveAnimation({ entry: 'fade', exit: 'fade', entryS: 1, exitS: 1 });
    expect(transitionFrames(anim, 20, FPS)).toEqual({ entryF: 4, exitF: 4 });
    expect(transitionFrames(anim, 1, FPS)).toEqual({ entryF: 0, exitF: 0 });
    expect(transitionFrames(resolveAnimation({ entry: 'fade', entryS: 1 }), 20, FPS)).toEqual({ entryF: 8, exitF: 0 });
    expect(transitionFrames(anim, 300, FPS)).toEqual({ entryF: 30, exitF: 30 });
  });

  it('push-in: normal matches the original values, off/subtle/strong scale it, box limit still caps', () => {
    // Original: 1 + min(target, 0.02 * durS)
    expect(pushInEnd(0.06, 0.02, 10, 'normal')).toBeCloseTo(1.06, 10);
    expect(pushInEnd(0.06, 0.02, 1, 'normal')).toBeCloseTo(1.02, 10);
    expect(pushInEnd(0.06, 0.02, 10, 'off')).toBe(1);
    expect(pushInEnd(0.06, 0.02, 10, 'subtle')).toBeCloseTo(1.03, 10);
    expect(pushInEnd(0.06, 0.02, 10, 'strong')).toBeCloseTo(1.09, 10);
    // Long holds never exceed the strong target (no runaway zoom).
    expect(pushInEnd(0.08, 0.02, 600, 'strong')).toBeCloseTo(1.12, 10);
    expect(pushInEnd(0.08, 0.02, 600, 'strong', 1.05)).toBe(1.05);
  });
});
