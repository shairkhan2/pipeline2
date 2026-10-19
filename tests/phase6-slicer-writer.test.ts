/**
 * T6.3 Phase 6 tests: page slicer (slicer.ts) + story writer (storyWriter.ts),
 * semantic visual matcher (visualMatcher.ts) and writer helpers (writer.ts).
 *
 * Ported/reasoned from:
 *   manhwa-pipeline/pipeline/slicer.py            -> slicer.ts
 *   manhwa-pipeline/pipeline/story_writer.py      -> storyWriter.ts
 *   manhwa-pipeline/pipeline/visual_matcher.py    -> visualMatcher.ts
 *   manhwa-pipeline/pipeline/writer.py            -> writer.ts
 *   manhwa-pipeline/pipeline/tools/verify_beats.py (selection audit semantics)
 *
 * Offline only: no provider calls, no rendering, no writes into the v1 tree.
 * Every on-disk side effect lives in an isolated temp dir under /tmp/opencode.
 * The v1 series data at /home/shair/manhwa-pipeline/series is only READ.
 */
import fsSync from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  _dropSlivers,
  _foldSlivers,
  _pagesHash,
  _rowRuns,
  _weldBandPx,
  artBounds,
  artRows,
  boundaryContinuous,
  cropRgbRows,
  findCuts,
  interiorFused,
  interiorGutters,
  loadRgbImage,
  MIN_PANEL_PX,
  nearWhiteRows,
  rgbToGray,
  segments,
  shippable,
  shortWidePanel,
  sliceChapter,
  sliceGrayRows,
  SLICER_REV,
  trim,
  weldIsSound,
  type GrayImage,
  type RgbImage,
  type Span,
} from '../src/stages/slicer.js';
import {
  castContext,
  _stepsToScript,
  UNIT_MAX_WORDS,
  validateDraft,
  validatePlan,
  validateReview,
  StoryReviewError,
} from '../src/stages/storyWriter.js';
import {
  _buildDetails,
  _buildSheets,
  _capFor,
  _parseLines,
  _validateSelection,
  FileNotFoundError,
  type ScriptLine,
} from '../src/stages/visualMatcher.js';
import {
  _bestRun,
  _extendRun,
  _hookMoves,
  _novisual,
  _succMap,
  _orderKey,
  HOOK_BEATS,
  panelTranscript,
  previousWindow,
  writerDialogueLookup,
  type PanelRec,
} from '../src/stages/writer.js';
import type { OrderKey } from '../src/domain/panels.js';
import { pagesHash } from '../src/contracts/hashes.js';
import { call } from '../src/llm/client.js';

// ---------------------------------------------------------------------------
// The caption matcher must fail closed here (no network): every `call` throws.
// writer.matchPanels then falls back to the code-side run matcher, which is the
// path under test for "@hold on a continuation line with no visual match".
// ---------------------------------------------------------------------------
vi.mock('../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/client.js')>();
  return {
    ...actual,
    call: vi.fn(async () => {
      throw new Error('mock matcher offline');
    }),
  };
});

const mockedCall = vi.mocked(call);

// ---------------------------------------------------------------------------
// temp scaffolding
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots.splice(0)) {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  fsSync.mkdirSync('/tmp/opencode', { recursive: true });
  const dir = fsSync.mkdtempSync(path.join('/tmp/opencode', `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// GrayImage / mask builders
// ---------------------------------------------------------------------------

/** Per-row-constant grayscale image. */
function rowImage(width: number, rows: number[]): GrayImage {
  const data = new Float32Array(width * rows.length);
  rows.forEach((v, y) => {
    for (let x = 0; x < width; x++) data[y * width + x] = v;
  });
  return { data, width, height: rows.length };
}

/** Grayscale image from a per-pixel function. */
function grayImage(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y);
  }
  return { data, width, height };
}

/** 0/1 mask of `len` with the given [start,end) spans set. */
function mask(len: number, spans: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(len);
  for (const [a, b] of spans) {
    for (let i = a; i < b; i++) out[i] = 1;
  }
  return out;
}

async function writeRawJpeg(
  file: string,
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number],
): Promise<void> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const off = (y * width + x) * 3;
      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toFile(file);
}

// ===========================================================================
// slicer.ts
// ===========================================================================

describe('slicer.ts / findCuts', () => {
  it('returns top/bot trim bounds and merged interior cuts', () => {
    // 300 rows: white [0,50), art [50,100), white [100,150), art [150,300)
    const im = grayImage(8, 300, (_x, y) => {
      if (y < 50) return 255;
      if (y < 100) return y % 2 === 0 ? 60 : 200; // textured art
      if (y < 150) return 255;
      return y % 2 === 0 ? 60 : 200;
    });
    const [top, bot, cuts] = findCuts(im);
    expect(top).toBe(50);
    expect(bot).toBe(300);
    expect(cuts).toEqual([[100, 150]]);
  });

  it('treats a fully flat page as one run (inverted top/bot)', () => {
    const im = rowImage(8, new Array(300).fill(255));
    const [top, bot, cuts] = findCuts(im);
    expect(top).toBe(300);
    expect(bot).toBe(0);
    expect(cuts).toEqual([]);
  });

  it('merges interior cuts closer than MERGE_PX', () => {
    const rows: number[] = [];
    for (let y = 0; y < 400; y++) {
      // white bands [0,40), [100,130), [150,180), [250,400)
      const white = (y >= 0 && y < 40) || (y >= 100 && y < 130) || (y >= 150 && y < 180) || y >= 250;
      rows.push(white ? 255 : y % 2 === 0 ? 60 : 200);
    }
    const im = rowImage(8, rows);
    const [, , cuts] = findCuts(im);
    // [100,130) and [150,180) are 20px apart -> merged into one cut
    expect(cuts).toEqual([[100, 180]]);
  });
});

describe('slicer.ts / trim (dark-page median guard)', () => {
  it('strips near-white edge rows', () => {
    const im = rowImage(8, [255, 255, 255, 128, 128, 255, 255]);
    expect(trim(im, 0, 7)).toEqual([3, 5]);
  });

  it('strips near-black rows when the page background is bright', () => {
    const im = rowImage(8, [10, 10, 10, 128, 128, 10, 10]);
    expect(trim(im, 0, 7, 200)).toEqual([3, 5]);
  });

  it('disables the dark branch when page median rowmean < 25', () => {
    const im = rowImage(8, new Array(100).fill(10));
    // pageMedian 10 (< 25): dark rows ARE the art, nothing is trimmed
    expect(trim(im, 0, 100, 10)).toEqual([0, 100]);
    // pageMedian 200: the same rows are blank padding and are trimmed away
    expect(trim(im, 0, 100, 200)).toEqual([99, 100]);
  });

  it('computes its own median when pageMedian is omitted', () => {
    const im = rowImage(8, [255, 255, 128, 128, 255]);
    expect(trim(im, 0, 5)).toEqual([2, 4]);
  });
});

describe('slicer.ts / artBounds', () => {
  it('returns the sustained content run and ignores sub-run slivers', () => {
    const rows = new Array(200).fill(250);
    for (let y = 50; y < 58; y++) rows[y] = 128; // 8-row run == minRun
    const [a, b] = artBounds(rowImage(8, rows));
    expect(a).toBeCloseTo(50 / 200, 10);
    expect(b).toBeCloseTo(58 / 200, 10);
  });

  it('degrades to [0,1] when only slivers are content', () => {
    const rows = new Array(200).fill(250);
    for (let y = 10; y < 14; y++) rows[y] = 128; // 4 rows < minRun 8
    expect(artBounds(rowImage(8, rows))).toEqual([0.0, 1.0]);
  });

  it('drops the rm>=25 gate on a dark crop (median rowmean < 25)', () => {
    const rows = new Array(200).fill(10);
    for (let y = 0; y < 20; y++) rows[y] = 250; // bright white top
    const [a, b] = artBounds(rowImage(8, rows));
    expect(a).toBeCloseTo(20 / 200, 10);
    expect(b).toBeCloseTo(1.0, 10);
  });

  it('handles a zero-height crop', () => {
    expect(artBounds({ data: new Float32Array(0), width: 4, height: 0 })).toEqual([0.0, 1.0]);
  });
});

describe('slicer.ts / nearWhiteRows & artRows', () => {
  it('marks near-white rows only when wide and bright', () => {
    const wide = rowImage(10, [255, 128, 255]);
    expect(Array.from(nearWhiteRows(wide))).toEqual([1, 0, 1]);
    // a bright row with a dark pixel (90% white) fails the >92% width gate
    const im = grayImage(10, 1, (x) => (x === 0 ? 0 : 255));
    expect(Array.from(nearWhiteRows(im))).toEqual([0]);
  });

  it('marks real art rows by the >=5% dark-pixel rule', () => {
    const im = grayImage(100, 2, (_x, y) => (y === 0 ? 50 : 250));
    expect(Array.from(artRows(im))).toEqual([1, 0]);
  });
});

describe('slicer.ts / interiorGutters', () => {
  it('returns a band only when it clears both edges and is flanked by art', () => {
    const white = mask(200, [[90, 110]]);
    const art = mask(200, [[74, 90], [110, 126]]);
    expect(interiorGutters(white, art, 0, 200)).toEqual([[90, 110]]);
  });

  it('rejects a band with no art on a flank', () => {
    const white = mask(200, [[90, 110]]);
    const art = mask(200, [[74, 90]]); // nothing below
    expect(interiorGutters(white, art, 0, 200)).toEqual([]);
  });

  it('rejects a band that is too short or touches a segment edge', () => {
    expect(interiorGutters(mask(200, [[90, 100]]), mask(200, [[70, 90], [100, 120]]), 0, 200))
      .toEqual([]);
    expect(interiorGutters(mask(200, [[2, 40]]), mask(200, [[0, 2], [40, 60]]), 0, 200))
      .toEqual([]);
  });
});

describe('slicer.ts / shortWidePanel & shippable', () => {
  function landscape(width = 100, height = 60, darkRows: Array<[number, number]> = [[10, 51]], darkCols = 100) {
    return grayImage(width, height, (x, y) => {
      const inRows = darkRows.some(([a, b]) => y >= a && y < b);
      return inRows && x < darkCols ? 50 : 255;
    });
  }

  it('accepts a real short-wide landscape panel', () => {
    expect(shortWidePanel(landscape())).toBe(true);
    expect(shippable(landscape())).toBe(true);
  });

  it('rejects a panel below the art-row floor', () => {
    expect(shortWidePanel(landscape(100, 60, [[10, 20]]))).toBe(false);
  });

  it('rejects ink that does not reach both page edges', () => {
    expect(shortWidePanel(landscape(100, 60, [[10, 51]], 50))).toBe(false);
  });

  it('requires a near-white flanking gutter when a white mask is supplied', () => {
    const blk = landscape();
    const white = mask(120, [[0, 10]]); // gutter above the block (a=10)
    expect(shortWidePanel(blk, white, 10)).toBe(true);
    const noWhite = mask(120, []);
    expect(shortWidePanel(blk, noWhite, 10)).toBe(false);
  });

  it('shippable honours the height floor for numbers and blocks', () => {
    expect(shippable(MIN_PANEL_PX)).toBe(true);
    expect(shippable(MIN_PANEL_PX - 1)).toBe(false);
    expect(shippable(landscape())).toBe(true);
  });
});

describe('slicer.ts / _foldSlivers & _dropSlivers', () => {
  it('folds a leading sliver into its neighbour when no gutter separates them', () => {
    const segs: Span[] = [[0, 50], [50, 300]];
    expect(_foldSlivers(segs)).toEqual([[0, 300]]);
  });

  it('folds a middle sliver into the LARGER (upper) neighbour', () => {
    const segs: Span[] = [[0, 400], [400, 430], [430, 600]];
    expect(_foldSlivers(segs)).toEqual([[0, 430], [430, 600]]);
  });

  it('folds a middle sliver into the LARGER (lower) neighbour', () => {
    const segs: Span[] = [[0, 200], [200, 230], [230, 700]];
    expect(_foldSlivers(segs)).toEqual([[0, 200], [200, 700]]);
  });

  it('drops a sliver rather than fold it across a known gutter', () => {
    const segs: Span[] = [[0, 300], [310, 330], [350, 700]];
    const gutters: Span[] = [[300, 310], [330, 350]];
    expect(_foldSlivers(segs, gutters)).toEqual([[0, 300], [350, 700]]);
  });

  it('respects the ship callback as an alternate floor', () => {
    const segs: Span[] = [[0, 50], [50, 300]];
    const ship = (a: number, b: number): boolean => a === 0 && b - a === 50;
    // the leading 50px block is rescued by ship -> nothing folds
    expect(_foldSlivers(segs, [], ship)).toEqual([[0, 50], [50, 300]]);
    // without the rescue it is a sub-floor sliver and folds into its neighbour
    expect(_foldSlivers(segs)).toEqual([[0, 300]]);
  });

  it('_dropSlivers keeps shippable blocks and drops the rest', () => {
    const blocks: Span[] = [[0, 50], [50, 300]];
    expect(_dropSlivers(blocks, [0, 300])).toEqual([[50, 300]]);
  });

  it('_dropSlivers falls back to the whole span when nothing clears the height floor', () => {
    const blocks: Span[] = [[0, 50], [50, 100]];
    expect(_dropSlivers(blocks, [0, 100])).toEqual([[0, 100]]);
  });
});

describe('slicer.ts / boundaryContinuous', () => {
  it('is true when the two edges are nearly identical', () => {
    const a = rowImage(4, [100, 100, 100, 100, 100, 100, 100, 50, 50, 50]);
    const b = rowImage(4, [50, 50, 50, 200, 200, 200, 200, 200, 200, 200]);
    expect(boundaryContinuous(a, b)).toBe(true);
  });

  it('is false across a brightness step', () => {
    const a = rowImage(4, new Array(10).fill(100));
    const b = rowImage(4, new Array(10).fill(250));
    expect(boundaryContinuous(a, b)).toBe(false);
  });

  it('is false for mismatched widths', () => {
    expect(boundaryContinuous(rowImage(4, [1]), rowImage(5, [1]))).toBe(false);
  });
});

describe('slicer.ts / weldIsSound', () => {
  it('accepts a seam with no interior band and no brightness step', () => {
    const a = rowImage(4, new Array(60).fill(100));
    const b = rowImage(4, new Array(60).fill(100));
    expect(weldIsSound(a, 0, 60, b, 0, 60)).toEqual([true, null]);
  });

  it('rejects on an interior near-white band', () => {
    const rowsA = [...new Array(100).fill(100), ...new Array(100).fill(255), ...new Array(100).fill(100)];
    const a = rowImage(4, rowsA);
    const b = rowImage(4, new Array(100).fill(100));
    expect(_weldBandPx({ data: new Float32Array(0), width: 4, height: 0 })).toBe(0);
    expect(weldIsSound(a, 0, 300, b, 0, 100)).toEqual([false, 'band']);
  });

  it('rejects on a brightness step across the seam', () => {
    const a = rowImage(4, new Array(200).fill(50));
    const b = rowImage(4, new Array(200).fill(200));
    expect(weldIsSound(a, 0, 200, b, 0, 200)).toEqual([false, 'step']);
  });

  it('reports "both" when a band also creates a step', () => {
    const rowsA = [...new Array(100).fill(100), ...new Array(100).fill(255)];
    const a = rowImage(4, rowsA);
    const b = rowImage(4, new Array(200).fill(100));
    expect(weldIsSound(a, 0, 200, b, 0, 200)).toEqual([false, 'both']);
  });
});

describe('slicer.ts / interiorFused', () => {
  it('is true for a strictly interior near-white band', () => {
    const rows = new Array(100).fill(100);
    for (let y = 40; y < 60; y++) rows[y] = 255;
    expect(interiorFused(rowImage(4, rows))).toBe(true);
  });

  it('ignores bands touching the crop edge', () => {
    const rows = new Array(100).fill(100);
    rows[0] = 255;
    rows[99] = 255;
    expect(interiorFused(rowImage(4, rows))).toBe(false);
  });

  it('ignores a band shorter than the floor', () => {
    const rows = new Array(100).fill(100);
    for (let y = 40; y < 43; y++) rows[y] = 255;
    expect(interiorFused(rowImage(4, rows))).toBe(false);
  });
});

describe('slicer.ts / low-level helpers', () => {
  it('_rowRuns returns exclusive spans', () => {
    expect(_rowRuns(mask(10, [[2, 5], [7, 8]]), 10)).toEqual([[2, 5], [7, 8]]);
  });

  it('rgbToGray applies the PIL L24 formula', () => {
    const rgb: RgbImage = { data: new Uint8Array([255, 255, 255, 0, 0, 0]), width: 2, height: 1 };
    const g = rgbToGray(rgb);
    expect(Array.from(g.data)).toEqual([255, 0]);
  });

  it('sliceGrayRows / cropRgbRows bound correctly', () => {
    const im = grayImage(2, 10, (_x, y) => y);
    const sl = sliceGrayRows(im, 3, 6);
    expect(sl.height).toBe(3);
    expect(Array.from(sl.data)).toEqual([3, 3, 4, 4, 5, 5]);
    const rgb: RgbImage = { data: new Uint8Array(2 * 10 * 3), width: 2, height: 10 };
    expect(cropRgbRows(rgb, 0, 4).height).toBe(4);
  });
});

describe('slicer.ts / segments', () => {
  it('returns one segment for a flat page', () => {
    const im = rowImage(8, new Array(300).fill(255));
    expect(segments(im)).toEqual([[0, 300]]);
  });

  it('splits a page at a wide interior gutter', () => {
    const rows: number[] = [];
    for (let y = 0; y < 600; y++) {
      const gutter = y >= 290 && y < 330;
      rows.push(gutter ? 255 : y % 2 === 0 ? 60 : 200);
    }
    const im = rowImage(8, rows);
    const segs = segments(im);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (const [a, b] of segs) expect(b - a).toBeGreaterThan(0);
  });
});

describe('slicer.ts / sliceChapter', () => {
  const TMP_SRC_ROWS = 600;

  async function makeSyntheticChapter(): Promise<{ chdir: string; outRoot: string }> {
    const root = makeTemp('slicer-chap');
    const chdir = path.join(root, 'ch9');
    fsSync.mkdirSync(chdir, { recursive: true });
    const page = (file: string): Promise<void> =>
      writeRawJpeg(file, 120, TMP_SRC_ROWS, (_x, y) => {
        const white = y < 150 || y >= 450;
        if (white) return [255, 255, 255];
        return y % 2 === 0 ? [60, 60, 60] : [200, 200, 200];
      });
    await page(path.join(chdir, '001.jpg'));
    await page(path.join(chdir, '002.jpg'));
    return { chdir, outRoot: makeTemp('slicer-out') };
  }

  it('slices a chapter and writes manifest + sidecar', async () => {
    const { chdir, outRoot } = await makeSyntheticChapter();
    const man = await sliceChapter(chdir, outRoot);
    expect(man.length).toBeGreaterThan(0);
    for (const rec of man) {
      expect(rec.panel.startsWith('ch9/')).toBe(true);
      expect(rec.w).toBe(120);
      expect(rec.h).toBeGreaterThan(0);
      expect(rec.art_top).toBeGreaterThanOrEqual(0);
      expect(rec.art_bottom).toBeLessThanOrEqual(1);
    }
    const pdir = path.join(outRoot, 'panels', 'ch9');
    expect(fsSync.existsSync(path.join(pdir, 'manifest.json'))).toBe(true);
    const meta = JSON.parse(fsSync.readFileSync(path.join(pdir, 'manifest.meta.json'), 'utf8'));
    expect(meta.slicer_rev).toBe(SLICER_REV);
    expect(meta.pages_hash).toBe(_pagesHash(chdir));
  });

  it('returns the cached manifest on a cache hit (no re-slice)', async () => {
    const { chdir, outRoot } = await makeSyntheticChapter();
    await sliceChapter(chdir, outRoot);
    const pdir = path.join(outRoot, 'panels', 'ch9');
    const marker = [{ panel: 'ch9/CACHE-MARKER.jpg', page: 1, idx: 1, w: 1, h: 1, art_top: 0, art_bottom: 1 }];
    fsSync.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify(marker), 'utf8');
    fsSync.writeFileSync(
      path.join(pdir, 'manifest.meta.json'),
      JSON.stringify({ slicer_rev: SLICER_REV, pages_hash: pagesHash(chdir) }, null, 1),
      'utf8',
    );
    const cached = await sliceChapter(chdir, outRoot);
    expect(cached).toEqual(marker);
  });

  it('re-slices when the sidecar carries a stale slicer_rev', async () => {
    const { chdir, outRoot } = await makeSyntheticChapter();
    const fresh = await sliceChapter(chdir, outRoot);
    const pdir = path.join(outRoot, 'panels', 'ch9');
    fsSync.writeFileSync(
      path.join(pdir, 'manifest.meta.json'),
      JSON.stringify({ slicer_rev: SLICER_REV - 1, pages_hash: pagesHash(chdir) }, null, 1),
      'utf8',
    );
    const resliced = await sliceChapter(chdir, outRoot);
    expect(resliced).toEqual(fresh);
    const meta = JSON.parse(fsSync.readFileSync(path.join(pdir, 'manifest.meta.json'), 'utf8'));
    expect(meta.slicer_rev).toBe(SLICER_REV);
  });

  it('re-slices when the sidecar is missing', async () => {
    const { chdir, outRoot } = await makeSyntheticChapter();
    const fresh = await sliceChapter(chdir, outRoot);
    const pdir = path.join(outRoot, 'panels', 'ch9');
    fsSync.rmSync(path.join(pdir, 'manifest.meta.json'), { force: true });
    const resliced = await sliceChapter(chdir, outRoot);
    expect(resliced).toEqual(fresh);
  });

  it('loads a real panel image back as RGB', async () => {
    const { chdir, outRoot } = await makeSyntheticChapter();
    const man = await sliceChapter(chdir, outRoot);
    const first = man[0]!;
    const file = path.join(outRoot, 'panels', first.panel);
    expect(fsSync.existsSync(file)).toBe(true);
    const im = await loadRgbImage(file);
    expect(im.width).toBe(first.w);
    expect(im.height).toBe(first.h);
  });

  const V1 = '/home/shair/manhwa-pipeline/series';
  const parityCases: Array<[string, string]> = [
    ['kill-the-hero', 'ch10'],
    ['my-gf', 'ch1'],
  ];

  it.each(parityCases)('matches the v1 slicer.py manifest for %s/%s', async (series, ch) => {
    const src = path.join(V1, series, ch);
    const refPath = path.join(V1, series, 'out', 'panels', ch, 'manifest.json');
    if (!fsSync.existsSync(src) || !fsSync.existsSync(refPath)) {
      // v1 fixture absent on this host: nothing to compare against.
      return;
    }
    const root = makeTemp('slicer-parity');
    const chdir = path.join(root, ch);
    fsSync.cpSync(src, chdir, { recursive: true });
    const man = await sliceChapter(chdir, makeTemp('slicer-parity-out'));
    const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf8'));
    expect(man).toEqual(ref);
  }, 60000);
});

// ===========================================================================
// storyWriter.ts
// ===========================================================================

describe('storyWriter.ts / castContext', () => {
  it('resolves an observed action through an explicit alias', () => {
    const cast = castContext(
      { characters: [{ name: 'the knight', what_they_do: 'blocked the blade' }] },
      { characters: { hero: { name: 'Aria', aliases: ['the knight'], role: 'protagonist' } } },
    );
    expect(cast).toHaveLength(1);
    expect(cast[0]!.name).toBe('Aria');
    expect(cast[0]!.role).toBe('protagonist');
    expect(cast[0]!.actions).toEqual(['blocked the blade']);
  });

  it('creates an unresolved entry for an unknown observed name and accumulates', () => {
    const obs = {
      characters: [
        { name: 'Ghost', what_they_do: 'whispered' },
        { name: 'Ghost', what_they_do: 'vanished' },
      ],
    };
    const cast = castContext(obs, {});
    expect(cast).toHaveLength(1);
    expect(cast[0]!.name).toBe('Ghost');
    expect(cast[0]!.actions).toEqual(['whispered', 'vanished']);
  });

  it('deduplicates repeated identical actions', () => {
    const cast = castContext(
      { characters: [{ name: 'Aria', what_they_do: 'ran' }, { name: 'Aria', what_they_do: 'ran' }] },
      { characters: { aria: { name: 'Aria' } } },
    );
    expect(cast[0]!.actions).toEqual(['ran']);
  });

  it('rejects a non-string bible name like Python casefold would', () => {
    expect(() => castContext({}, { characters: { x: { name: 42 } } })).toThrow(TypeError);
  });
});

describe('storyWriter.ts / validatePlan', () => {
  function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      premise: 'A knight must choose between duty and mercy.',
      turns: [{ want: 'save the town', obstacle: 'the duke', choice: 'defy orders', change: 'exiled' }],
      moments: [
        { event: 'the duke arrives', source_events: [1], evidence_type: 'visible', detail: 'the duke rides in' },
      ],
      omitted_events: [{ event: 2, reason: 'duplicate of the arrival' }],
      ...overrides,
    };
  }

  it('accepts a plan that accounts for every event', () => {
    expect(validatePlan(plan(), 2).premise).toContain('knight');
  });

  it('rejects a plan that does not account for every source event', () => {
    expect(() => validatePlan(plan(), 3)).toThrow(StoryReviewError);
  });

  it('rejects an event both covered and omitted', () => {
    const p = plan({ omitted_events: [{ event: 1, reason: 'nope' }] });
    expect(() => validatePlan(p, 1)).toThrow(/covered event also marked omitted/);
  });

  it('rejects panel-selection hints in the plan', () => {
    const p = plan({
      moments: [
        { event: 'the duke arrives', source_events: [1], evidence_type: 'visible', detail: 'see p0001_1' },
      ],
    });
    expect(() => validatePlan(p)).toThrow(/panel-selection hints/);
  });

  it('rejects @hold hints too', () => {
    const p = plan({
      moments: [
        { event: 'the duke arrives', source_events: [1], evidence_type: 'visible', detail: 'hold @hold here' },
      ],
    });
    expect(() => validatePlan(p)).toThrow(/panel-selection hints/);
  });

  it('rejects an invalid evidence_type and bad source_events', () => {
    const bad = plan({
      moments: [{ event: 'x', source_events: [1], evidence_type: 'imagined', detail: 'd' }],
    });
    expect(() => validatePlan(bad)).toThrow(/invalid scene moment/);
    const bad2 = plan({
      moments: [{ event: 'x', source_events: [], evidence_type: 'visible', detail: 'd' }],
    });
    expect(() => validatePlan(bad2)).toThrow(/numbered source events/);
  });

  it('rejects a missing premise and a bad shape', () => {
    expect(() => validatePlan({ ...plan(), premise: '   ' })).toThrow(/needs a premise/);
    expect(() => validatePlan({ ...plan(), extra: 1 })).toThrow(/needs a premise/);
  });
});

describe('storyWriter.ts / validateDraft', () => {
  function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      outline: [{ want: 'x', obstacle: 'y', choice: 'z', change: 'w' }],
      steps: [{ beat: 'open', line: 'The knight rides into town.', jab: '' }],
      ...overrides,
    };
  }
  const moments = [{ event: 'a' }, { event: 'b' }];

  it('accepts a well-formed draft without moments', () => {
    expect(validateDraft(draft())).toBeTruthy();
  });

  it('enforces the scene reference when moments are supplied', () => {
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: 'ok', jab: '', scene: 1 }] }, moments),
    ).toThrow(/draft skips planned scenes/);
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: 'ok', jab: '', scene: 5 }] }, moments),
    ).toThrow(/needs an existing scene reference/);
  });

  it('caps a spoken unit at UNIT_MAX_WORDS', () => {
    const long = new Array(UNIT_MAX_WORDS + 1).fill('word').join(' ');
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: long, jab: '', scene: 1 }] }, [{}]),
    ).toThrow(/oversized spoken unit/);
    const exact = new Array(UNIT_MAX_WORDS).fill('word').join(' ');
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: exact, jab: '', scene: 1 }] }, [{}]),
    ).not.toThrow();
  });

  it('does not count emotion tags toward the word cap', () => {
    const line = `[angry] ${new Array(UNIT_MAX_WORDS).fill('word').join(' ')}`;
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line, jab: '', scene: 1 }] }, [{}]),
    ).not.toThrow();
  });

  it('rejects a line containing a newline', () => {
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: 'a\nb', jab: '', scene: 1 }] }, [{}]),
    ).toThrow(/oversized spoken unit/);
  });

  it('rejects @p / @hold panel hints in line or jab', () => {
    expect(() => validateDraft(draft({ steps: [{ beat: 'b', line: 'go @p0001_1', jab: '' }] })))
      .toThrow(/must not choose pictures or holds/);
    expect(() => validateDraft(draft({ steps: [{ beat: 'b', line: 'go', jab: 'wait @hold' }] })))
      .toThrow(/must not choose pictures or holds/);
  });

  it('rejects an empty outline or step and a bad outline row', () => {
    expect(() => validateDraft({ outline: [], steps: [{ beat: 'b', line: 'l', jab: '' }] }))
      .toThrow(/causal outline/);
    expect(() => validateDraft({ outline: draft().outline, steps: [] })).toThrow(/narration steps/);
    expect(() => validateDraft({ outline: [{ foo: 'bar' }], steps: [{ beat: 'b', line: 'l', jab: '' }] }))
      .toThrow(/invalid causal outline row/);
    expect(() => validateDraft({ outline: draft().outline, steps: [{ beat: '', line: 'l', jab: '' }] }))
      .toThrow(/invalid narration step 1/);
  });

  it('rejects extra keys and a missing jab field', () => {
    expect(() => validateDraft({ ...draft(), extra: 1 })).toThrow(/outline and steps only/);
    expect(() => validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: 'l' }] }))
      .toThrow(/invalid narration step 1/);
  });

  it('enforces an oversized reaction cap', () => {
    const jab = new Array(13).fill('w').join(' ');
    expect(() =>
      validateDraft({ outline: draft().outline, steps: [{ beat: 'b', line: 'ok', jab, scene: 1 }] }, [{}]),
    ).toThrow(/oversized reaction/);
  });
});

describe('storyWriter.ts / validateReview', () => {
  const draft = {
    outline: [{ want: 'x' }],
    steps: [
      { beat: 'b1', line: 'Hero draws the sword', jab: '' },
      { beat: 'b2', line: 'The duke retreats', jab: 'Coward' },
    ],
  };

  it('accepts an accept verdict with no issues', () => {
    const r = validateReview({ verdict: 'accept', assessment: 'solid', issues: [] }, 2, { draft });
    expect(r.verdict).toBe('accept');
  });

  it('rejects a verdict that contradicts its issues', () => {
    expect(() =>
      validateReview(
        { verdict: 'accept', assessment: 'x', issues: [{ step: 1, kind: 'caption_tour', quote: 'Hero draws the sword', reason: 'r' }] },
        2,
        { draft },
      ),
    ).toThrow(/verdict contradicts issues/);
    expect(() =>
      validateReview({ verdict: 'reject', assessment: 'x', issues: [] }, 2, { draft }),
    ).toThrow(/verdict contradicts issues/);
  });

  it('validates the issue step range and kind', () => {
    expect(() =>
      validateReview(
        { verdict: 'reject', assessment: 'x', issues: [{ step: 9, kind: 'caption_tour', quote: 'q', reason: 'r' }] },
        2,
        { draft },
      ),
    ).toThrow(/invalid issue step index/);
    expect(() =>
      validateReview(
        { verdict: 'reject', assessment: 'x', issues: [{ step: 1, kind: 'made_up', quote: 'q', reason: 'r' }] },
        2,
        { draft },
      ),
    ).toThrow(/unknown issue kind/);
  });

  it('allows step 0 (whole-draft issue) and rejects an empty quote', () => {
    expect(() =>
      validateReview(
        { verdict: 'reject', assessment: 'x', issues: [{ step: 0, kind: 'continuity', quote: '   ', reason: 'r' }] },
        2,
        { draft },
      ),
    ).toThrow(/issue requires quote and reason/);
  });

  it('flags an unverifiable citation instead of failing', () => {
    const r = validateReview(
      { verdict: 'reject', assessment: 'x', issues: [{ step: 1, kind: 'caption_tour', quote: 'totally absent words', reason: 'r' }] },
      2,
      { draft },
    );
    expect(r.citation_warnings).toHaveLength(1);
    expect(r.citation_warnings![0]!.step).toBe(1);
  });

  it('does not warn when the quote occurs in the row', () => {
    const r = validateReview(
      { verdict: 'reject', assessment: 'x', issues: [{ step: 1, kind: 'caption_tour', quote: 'draws the sword', reason: 'r' }] },
      2,
      { draft },
    );
    expect(r.citation_warnings).toBeUndefined();
  });

  it('checks a causal_omission quote against transcript + source', () => {
    const r = validateReview(
      {
        verdict: 'reject',
        assessment: 'x',
        issues: [{ step: 0, kind: 'causal_omission', quote: 'the bridge collapsed', reason: 'r' }],
      },
      2,
      { draft, transcript: 'the bridge collapsed at dawn', source: '' },
    );
    expect(r.citation_warnings).toBeUndefined();
  });
});

describe('storyWriter.ts / _stepsToScript', () => {
  it('returns null for no steps or bad JSON', () => {
    expect(_stepsToScript('not json')).toEqual([null, 0, 0]);
    expect(_stepsToScript(JSON.stringify({ steps: [] }))).toEqual([null, 0, 0]);
    expect(_stepsToScript(JSON.stringify({}))).toEqual([null, 0, 0]);
  });

  it('emits a beat header and a @hold jab line', () => {
    const [script, nSteps, nJabs] = _stepsToScript(
      JSON.stringify({ steps: [{ beat: 'Open Scene', line: 'Hello there', jab: 'Nice' }] }),
    );
    expect(script).toBe('## BEAT b01_open_scene\nHello there\nNice @hold\n');
    expect(nSteps).toBe(1);
    expect(nJabs).toBe(1);
  });

  it('strips legacy @p tags from line and jab', () => {
    const [script] = _stepsToScript(
      JSON.stringify({ steps: [{ beat: 'b', line: 'A line @p0001_1', jab: 'Ha @p0002_1' }] }),
    );
    expect(script).not.toContain('@p');
    expect(script).toContain('A line');
  });

  it('enforces the jab ceiling of ceil(steps / JAB_GAP)', () => {
    const steps = new Array(5).fill(0).map((_v, i) => ({ beat: 'b', line: `line ${i}`, jab: `jab ${i}` }));
    const [, , nJabs] = _stepsToScript(JSON.stringify({ steps }));
    expect(nJabs).toBe(2); // ceil(5 / 4)
  });

  it('skips steps with an empty line', () => {
    const [script, nSteps] = _stepsToScript(
      JSON.stringify({ steps: [{ beat: 'b', line: '   ', jab: 'x' }, { beat: 'b', line: 'real', jab: '' }] }),
    );
    expect(nSteps).toBe(1);
    expect(script).toBe('## BEAT b01_b\nreal\n');
  });
});

// ===========================================================================
// visualMatcher.ts
// ===========================================================================

describe('visualMatcher.ts / _parseLines', () => {
  const script = [
    '## BEAT b01_open',
    'first line',
    'second line @hold',
    '## BEAT b02_close',
    'third line',
    '',
  ].join('\n');

  it('indexes narration lines and tracks beats and holds', () => {
    const lines = _parseLines(script);
    const nar = lines.filter((l) => l.kind === 'narration');
    expect(nar.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(nar.map((l) => l.text)).toEqual(['first line', 'second line', 'third line']);
    expect(nar.map((l) => Boolean(l.hold))).toEqual([false, true, false]);
    expect(nar.map((l) => l.beat)).toEqual(['b01_open', 'b01_open', 'b02_close']);
  });

  it('does not treat untagged narration as a hold and strips tags from text', () => {
    const lines = _parseLines('plain line @p0001_1\n');
    const nar = lines.filter((l) => l.kind === 'narration');
    expect(nar).toHaveLength(1);
    expect(nar[0]!.hold).toBe(false);
    expect(nar[0]!.text).toBe('plain line');
  });

  it('keeps beat headers as other lines with no narration index', () => {
    const lines = _parseLines('## BEAT b01_x\n');
    expect(lines[0]!.kind).toBe('other');
  });
});

describe('visualMatcher.ts / _capFor', () => {
  it('caps at 2 for a long line and 1 for a short one', () => {
    const long = new Array(24).fill('word').join(' ');
    expect(_capFor(long, 3.2, 1.2)).toBe(2);
    expect(_capFor('two words', 3.2, 1.2)).toBe(1);
  });
});

describe('visualMatcher.ts / _buildSheets & _buildDetails', () => {
  async function panelDir(): Promise<string> {
    const dir = makeTemp('vm-panels');
    await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 180, b: 160 } } })
      .jpeg()
      .toFile(path.join(dir, 'p0001_1.jpg'));
    await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 100, g: 120, b: 140 } } })
      .jpeg()
      .toFile(path.join(dir, 'p0002_1.jpg'));
    return dir;
  }

  it('composes a contact sheet holding every offered id', async () => {
    const panelsDir = await panelDir();
    const outDir = makeTemp('vm-sheets');
    const sheets = await _buildSheets(['p0001_1', 'p0002_1'], panelsDir, outDir);
    expect(sheets).toHaveLength(1);
    expect(fsSync.existsSync(sheets[0]!)).toBe(true);
    expect(fsSync.statSync(sheets[0]!).size).toBeGreaterThan(0);
    const meta = await sharp(sheets[0]!).metadata();
    expect(meta.width).toBeGreaterThan(0);
  });

  it('builds a readable detail card for a finalist', async () => {
    const panelsDir = await panelDir();
    const outDir = makeTemp('vm-details');
    const paths = await _buildDetails(['p0001_1'], panelsDir, outDir);
    expect(paths).toHaveLength(1);
    const meta = await sharp(paths[0]!).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(300);
  });

  it('raises FileNotFoundError for a missing panel image', async () => {
    const panelsDir = await panelDir();
    await expect(_buildSheets(['p9999_9'], panelsDir, makeTemp('vm-missing')))
      .rejects.toBeInstanceOf(FileNotFoundError);
  });
});

describe('visualMatcher.ts / _validateSelection', () => {
  const lines: ScriptLine[] = _parseLines('hero speaks\nvillain replies\n');
  const offer = ['p0001_1', 'p0002_1'];
  const caps = { 1: 2, 2: 2 };
  const noHolds = new Set<number>();

  /** Both narration lines answered; override one entry per test. */
  function both(over: Record<string, unknown> = {}, first: Record<string, unknown> = {}): unknown {
    return {
      lines: [
        { n: 1, panels: ['p0001_1'], basis: 'direct', evidence: 'hero speaking', ...first },
        { n: 2, panels: ['p0002_1'], basis: 'direct', evidence: 'villain replying', ...over },
      ],
    };
  }

  it('accepts a direct selection', () => {
    const res = _validateSelection(both(), lines, offer, caps, noHolds);
    expect(res.ok).toBe(true);
    expect(res.picks![1]!.panels).toEqual(['p0001_1']);
    expect(res.picks![2]!.panels).toEqual(['p0002_1']);
  });

  it('rejects malformed indices and duplicates', () => {
    expect(_validateSelection({ lines: 'x' }, lines, offer, caps, noHolds).ok).toBe(false);
    expect(_validateSelection(both({ n: 5 }), lines, offer, caps, noHolds).error)
      .toMatch(/out of range/);
    expect(_validateSelection(both({ n: 1.5 }), lines, offer, caps, noHolds).error)
      .toMatch(/must be an integer/);
    const dup = {
      lines: [
        { n: 1, panels: ['p0001_1'], basis: 'direct', evidence: 'e' },
        { n: 1, panels: ['p0002_1'], basis: 'direct', evidence: 'e' },
      ],
    };
    expect(_validateSelection(dup, lines, offer, caps, noHolds).error).toMatch(/duplicate index/);
  });

  it('rejects an invalid basis and empty evidence', () => {
    expect(_validateSelection(both({ basis: 'guess' }), lines, offer, caps, noHolds).error)
      .toMatch(/invalid basis/);
    expect(_validateSelection(both({ evidence: '  ' }), lines, offer, caps, noHolds).error)
      .toMatch(/empty evidence/);
  });

  it('rejects unoffered ids, within-line duplicates and over-cap lists', () => {
    expect(_validateSelection(both({ panels: ['p9999_9'] }), lines, offer, caps, noHolds).error)
      .toMatch(/not offered/);
    expect(_validateSelection(both({ panels: ['p0001_1', 'p0001_1'] }), lines, offer, caps, noHolds).error)
      .toMatch(/duplicate panels/);
    expect(_validateSelection(both({ panels: ['p0001_1', 'p0002_1'] }), lines, offer, { 1: 2, 2: 1 }, noHolds).error)
      .toMatch(/cap is 1/);
  });

  it('enforces the source-hold rule', () => {
    const holdLines = _parseLines('hero speaks @hold\nvillain replies\n');
    const holdSet = new Set<number>([1]);
    expect(_validateSelection(both({}, { panels: [], basis: 'hold' }), holdLines, offer, caps, holdSet).ok)
      .toBe(true);
    expect(_validateSelection(both({}, { panels: ['p0001_1'], basis: 'direct' }), holdLines, offer, caps, holdSet).error)
      .toMatch(/must be basis hold/);
    // a line the script does NOT hold may not answer basis hold
    expect(_validateSelection(both({ panels: [], basis: 'hold' }), lines, offer, caps, noHolds).error)
      .toMatch(/cannot be basis hold/);
  });

  it('requires a panel for a non-hold line in the non-semantic contract', () => {
    expect(_validateSelection(both({ panels: [], basis: 'context' }), lines, offer, caps, noHolds).error)
      .toMatch(/has no panel/);
  });

  it('allows context/missing with no panels only in the semantic contract', () => {
    const contextFirst = {
      lines: [
        { n: 1, panels: [], basis: 'context', evidence: 'abstract' },
        { n: 2, panels: ['p0002_1'], basis: 'direct', evidence: 'e' },
      ],
    };
    expect(_validateSelection(contextFirst, lines, offer, caps, noHolds, true).error)
      .toMatch(/no previous displayed scene/);

    const okContext = {
      lines: [
        { n: 1, panels: ['p0001_1'], basis: 'direct', evidence: 'e' },
        { n: 2, panels: [], basis: 'context', evidence: 'abstract' },
      ],
    };
    expect(_validateSelection(okContext, lines, offer, caps, noHolds, true).ok).toBe(true);

    const missing = both({ panels: [], basis: 'missing', evidence: 'not shown' });
    expect(_validateSelection(missing, lines, offer, caps, noHolds, true).ok).toBe(true);
    expect(_validateSelection(both({ panels: ['p0001_1'], basis: 'missing' }), lines, offer, caps, noHolds, true).error)
      .toMatch(/must have no panels/);
  });

  it('reports missing narration indices', () => {
    const res = _validateSelection(
      { lines: [{ n: 1, panels: ['p0001_1'], basis: 'direct', evidence: 'e' }] },
      lines,
      offer,
      caps,
      noHolds,
    );
    expect(res.error).toMatch(/missing indices: 2/);
  });
});

// ===========================================================================
// writer.ts
// ===========================================================================

describe('writer.ts / _novisual', () => {
  it('flags low-art panels', () => {
    expect(_novisual(0.2, 0, 'none')).toBe(true);
    expect(_novisual(0.3, 0, 'none')).toBe(false);
  });

  it('flags mid-art panels only when overlay+world text is heavy', () => {
    expect(_novisual(0.4, 0, 'none', 0)).toBe(false);
    expect(_novisual(0.4, 30, 'none', 30)).toBe(true);
    expect(_novisual(0.5, 100, 'none', 0)).toBe(false);
  });

  it('flags a full-bubble panel below the art threshold', () => {
    expect(_novisual(0.5, 0, 'full')).toBe(true);
    expect(_novisual(0.5, 0, 'none')).toBe(false);
    expect(_novisual(0.9, 0, 'full')).toBe(false);
  });
});

describe('writer.ts / panelTranscript', () => {
  it('folds a NO-VISUAL panel into its nearest showable neighbour', () => {
    const out = panelTranscript({
      panels: [
        { id: 'p0001_1', art: 0.1, overlay: ['HELLO'], world: [], bubble_at: 'none', visual: 'blank' },
        { id: 'p0002_1', art: 1.0, overlay: [], world: [], bubble_at: 'none', visual: 'hero stands' },
      ],
    });
    expect(out).not.toContain('p0001_1 |');
    expect(out).toContain('p0002_1 | art:1');
    expect(out).toContain('OVERLAY:  "HELLO" (from p0001_1)');
  });

  it('marks a bubble-at-corner panel', () => {
    const out = panelTranscript({
      panels: [{ id: 'p0001_1', art: 0.9, overlay: [], world: [], bubble_at: 'corner', visual: 'x' }],
    });
    expect(out).toContain('BUBBLE-AT-CORNER');
  });

  it('carries a hidden panel caption as a CARD when the widened gate hides it', () => {
    const out = panelTranscript({
      panels: [
        { id: 'p0001_1', art: 0.4, overlay: [], world: ['x'.repeat(60)], bubble_at: 'none', visual: 'title card' },
        { id: 'p0002_1', art: 1.0, overlay: [], world: [], bubble_at: 'none', visual: 'hero stands' },
      ],
    });
    expect(out).toContain('CARDS: [p0001_1 card: title card]');
  });

  it('marks every panel NO-VISUAL when the whole chapter is unshowable', () => {
    const out = panelTranscript({
      panels: [
        { id: 'p0001_1', art: 0.1, overlay: ['A'], world: [], bubble_at: 'none', visual: 'a' },
        { id: 'p0002_1', art: 0.1, overlay: ['B'], world: [], bubble_at: 'none', visual: 'b' },
      ],
    });
    expect(out).toContain('p0001_1 | art:0.1 NO-VISUAL');
    expect(out).toContain('p0002_1 | art:0.1 NO-VISUAL');
  });
});

describe('writer.ts / writerDialogueLookup', () => {
  it('emits only dialogue and world text, skipping empty panels', () => {
    const out = writerDialogueLookup({
      panels: [
        { id: 'p0001_1', overlay: ['Hello'], world: ['SIGN'] },
        { id: 'p0002_1', overlay: [], world: [] },
      ],
    });
    expect(out).toBe('p0001_1 | DIALOGUE: "Hello" | SYSTEM/WORLD: "SIGN"');
  });

  it('returns a placeholder when there is no text', () => {
    expect(writerDialogueLookup({ panels: [] })).toBe('(no dialogue or world text)');
  });
});

describe('writer.ts / _hookMoves', () => {
  it('de-slugs the last HOOK_BEATS beat names', () => {
    const txt = [
      '## BEAT b01_setup',
      'line',
      '## BEAT b02_rising',
      'line',
      '## BEAT b03_climax',
      'line',
      '## BEAT b04_orphan_promise',
      'line',
    ].join('\n');
    expect(HOOK_BEATS).toBe(3);
    expect(_hookMoves(txt)).toEqual(['rising', 'climax', 'orphan promise']);
  });

  it('honours an explicit count', () => {
    expect(_hookMoves('## BEAT b01_one\n## BEAT b02_two\n', 1)).toEqual(['two']);
  });
});

describe('writer.ts / previousWindow', () => {
  function makeOutDir(): string {
    const outDir = makeTemp('prev-window');
    const write = (c: string, txt: string): void => {
      fsSync.mkdirSync(path.join(outDir, c), { recursive: true });
      fsSync.writeFileSync(path.join(outDir, c, 'script.md'), txt, 'utf8');
    };
    write('ch1', '## BEAT b01_alpha\nold line one\n');
    write('ch2', '## BEAT b01_beta\nold line two\n');
    write('ch3', '## BEAT b01_gamma\nold line three\n');
    return outDir;
  }

  it('returns empty when there is no earlier chapter', () => {
    const outDir = makeOutDir();
    expect(previousWindow(outDir, 'ch1')).toEqual(['', 0, 0]);
  });

  it('keeps every earlier chapter verbatim under a large budget', () => {
    const outDir = makeOutDir();
    const [text, nVerbatim, nHooks] = previousWindow(outDir, 'ch4');
    expect(nVerbatim).toBe(3);
    expect(nHooks).toBe(0);
    expect(text).toContain('ch1 (verbatim');
    expect(text).toContain('ch3 (verbatim');
  });

  it('evicts older chapters to hooks under a small budget', () => {
    const outDir = makeOutDir();
    const [text, nVerbatim, nHooks] = previousWindow(outDir, 'ch4', 20);
    expect(nVerbatim).toBe(1);
    expect(nHooks).toBe(2);
    expect(text).toContain('ch3 (verbatim');
    expect(text).toContain('ch1 (older than memory; hook only)');
    expect(text).toContain('story moves: alpha');
  });

  it('throws when the chapter name has no digits', () => {
    expect(() => previousWindow(makeOutDir(), 'final')).toThrow(/no digits/);
  });
});

describe('writer.ts / _extendRun', () => {
  function fixtures(): {
    byPid: Record<string, PanelRec>;
    byKey: Record<string, OrderKey>;
    pos: Map<string, string>;
    succ: Map<string, OrderKey>;
  } {
    const byPid: Record<string, PanelRec> = {
      p0001_1: { id: 'p0001_1', visual: 'hero draws sword' },
      p0001_2: { id: 'p0001_2', visual: 'draws sword again' },
      p0002_1: { id: 'p0002_1', visual: 'hero only' },
    };
    const byKey: Record<string, OrderKey> = {
      p0001_1: _orderKey(byPid.p0001_1),
      p0001_2: _orderKey(byPid.p0001_2),
      p0002_1: _orderKey(byPid.p0002_1),
    };
    const pos = new Map<string, string>([['1,1', 'p0001_1'], ['1,2', 'p0001_2'], ['2,1', 'p0002_1']]);
    return { byPid, byKey, pos, succ: _succMap(byKey) };
  }

  it('extends the tail while the next panel adds >=2 shared stems', () => {
    const { byPid, byKey, pos, succ } = fixtures();
    const free = new Set(['p0001_2', 'p0002_1']);
    const [run, added, refused] = _extendRun(
      ['p0001_1'], 'hero draws sword', free, byPid, byKey, pos, succ, 6,
    );
    expect(run).toEqual(['p0001_1', 'p0001_2']);
    expect(added).toBe(1);
    expect(refused).toBe(1); // p0002_1 has only 1 shared stem
  });

  it('declines when the candidate panel has fewer than 2 shared stems', () => {
    const { byPid, byKey, pos, succ } = fixtures();
    // remove the >=2-stem successor so the very first tail candidate is <2 stems
    const free = new Set(['p0002_1']);
    const [run, added] = _extendRun(
      ['p0001_1'], 'hero draws sword', free, byPid, byKey, pos, succ, 6,
    );
    expect(run).toEqual(['p0001_1']);
    expect(added).toBe(0);
  });

  it('refuses to starve a later empty beat (reserve)', () => {
    const { byPid, byKey, pos, succ } = fixtures();
    const free = new Set(['p0001_2', 'p0002_1']);
    const [run, added, refused] = _extendRun(
      ['p0001_1'], 'hero draws sword', free, byPid, byKey, pos, succ, 6, 2,
    );
    expect(run).toEqual(['p0001_1']);
    expect(added).toBe(0);
    expect(refused).toBe(1);
  });

  it('declines cleanly for an unknown anchor id and an empty run', () => {
    const { byPid, byKey, pos, succ } = fixtures();
    expect(_extendRun([], 'x', new Set(), byPid, byKey, pos, succ, 6)).toEqual([[], 0, 0, 0]);
    expect(_extendRun(['p9999_9'], 'x', new Set(), byPid, byKey, pos, succ, 6)).toEqual([['p9999_9'], 0, 0, 0]);
  });
});

describe('writer.ts / _bestRun', () => {
  const byPid: Record<string, PanelRec> = {
    p0001_1: { id: 'p0001_1', visual: 'hero draws sword' },
    p0002_1: { id: 'p0002_1', visual: 'empty corridor' },
  };
  const byKey: Record<string, OrderKey> = {
    p0001_1: _orderKey(byPid.p0001_1),
    p0002_1: _orderKey(byPid.p0002_1),
  };

  it('returns the best overlapping run', () => {
    const run = _bestRun('hero draws the sword', ['p0001_1', 'p0002_1'], byPid, byKey, 6, _succMap(byKey));
    expect(run[0]).toBe('p0001_1');
  });

  it('returns [] when nothing overlaps (no zero-overlap fallback)', () => {
    expect(_bestRun('zzz qqq', ['p0001_1', 'p0002_1'], byPid, byKey, 6, _succMap(byKey))).toEqual([]);
    expect(_bestRun('hero draws the sword', [], byPid, byKey)).toEqual([]);
  });
});

describe('writer.ts / matchPanels @hold fallback', () => {
  it('puts @hold on a continuation line with no visual match', async () => {
    const { matchPanels } = await import('../src/stages/writer.js');
    mockedCall.mockClear();
    const script = '## BEAT b01_open\nhero draws sword\nshe quietly waits\n';
    const obs = {
      panels: [
        { id: 'p0001_1', page: 1, idx: 1, art: 1, bubble_at: 'none', visual: 'hero draws sword', overlay: [], world: [] },
        { id: 'p0002_1', page: 2, idx: 1, art: 1, bubble_at: 'none', visual: 'empty corridor', overlay: [], world: [] },
      ],
    };
    const out = await matchPanels(script, obs, { mode: 'caption' });
    const lines = out.split('\n');
    expect(lines[1]).toContain('hero draws sword');
    expect(lines[1]).toMatch(/@p\d{4}_\d/);
    expect(lines[2]).toContain('she quietly waits');
    expect(lines[2]).toContain('@hold');
    expect(mockedCall).toHaveBeenCalled();
  });
});
