/**
 * T0.4 parity and contract tests for the phase-0 ported modules:
 *   src/contracts/{briefs,hashes,schemas}.ts, src/domain/panels.ts,
 *   src/locks/seriesLock.ts
 *
 * Hash digests are cache keys for paid artifacts. The values asserted here come
 * from the live v1 pipeline and its on-disk caches; a drift means re-billing.
 *
 * Read-only against /home/shair/manhwa-pipeline: the real-series validation
 * step opens files from the v1 tree and never writes there. Every mutable test
 * (locking, deletion, page fixtures) lives in a fresh temp dir under /tmp/opencode.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CAPTION_VERSION,
  SLICER_REV,
  PROMO_ALGO_VERSION,
  PROMO_ROI_PAD_FRAC,
  cfgHash,
  batchDir,
  briefHash,
  lineProofToken,
  narrationCacheKey,
  pagesHash,
  promoCacheHash,
  promoRulesHash,
  pyFloat,
  pyFloatDeep,
  pyFloatRepr,
  pyJsonDumps,
  pyReprStr,
  schemaHash,
  type ExternalTtsConfig,
} from '../src/contracts/hashes.js';
import {
  READER_BATCH,
  captionVersion,
  readerBatch,
} from '../src/contracts/briefs.js';
import {
  applyPromoMeta,
  normBox,
  normPromoBbox,
  toPromoPageStatus,
  validBox,
  validFocusX,
  ManifestSchema,
  CachedBlobSchema,
  BibleSchema,
  RecapPropsSchema,
} from '../src/contracts/schemas.js';
import {
  adjKeys,
  isAdj,
  isChain,
  isPid,
  keymap,
  needsPositions,
  NEG_KEY,
  panelOrderKey,
  panelPositions,
  FAR_KEY,
} from '../src/domain/panels.js';
import {
  BlockingIOError,
  LockPathError,
  acquireExclusiveSeriesLock,
  acquireSharedSeriesLock,
  deleteChapterVideo,
  deleteChapterVideoLocked,
  lockFileForSeries,
  pendingKey,
  releaseExclusiveSeriesLock,
  releaseSharedSeriesLock,
  tryFlockFd,
  flockFd,
  validateChapter,
  validateSlug,
  withExclusiveSeriesLock,
  withSharedSeriesLock,
} from '../src/locks/seriesLock.js';

const V1_SERIES = '/home/shair/manhwa-pipeline/series';
/** Real series that satisfy the current on-disk contracts (legacy blobs with
 *  non-`event` object rows in plot_ledger/events are excluded by design). */
const VALID_SERIES = [
  'kill-the-hero',
  'deserted-island',
  'my-dragon-girlfriend-has-returned',
  'reality-quest',
];

const tmpRoots: string[] = [];
afterAll(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeTemp(prefix: string): string {
  fsSync.mkdirSync('/tmp/opencode', { recursive: true });
  const dir = fsSync.mkdtempSync(path.join('/tmp/opencode', `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ *
 * Frozen hash contracts
 * ------------------------------------------------------------------ */

describe('frozen hash contracts (paid-cache keys)', () => {
  it('pins the reader schema fingerprint', () => {
    expect(schemaHash()).toBe('1276d1f8');
  });

  it('pins every caption-version brief hash', () => {
    expect(briefHash(1)).toBe('9529b2f7');
    expect(briefHash(2)).toBe('342ea2db');
    expect(briefHash(4)).toBe('821ef7aa');
    // The ACTIVE default is v4 (covers reader.py FinallyReader default).
    expect(briefHash()).toBe(briefHash(CAPTION_VERSION));
    expect(CAPTION_VERSION).toBe(4);
  });

  it('rejects caption versions outside READER_CAPTIONS like Python KeyError', () => {
    expect(() => briefHash(5)).toThrow(/caption version/);
    expect(() => readerBatch(9)).toThrow(/caption version/);
    expect(() => captionVersion('v-not-a-version')).toThrow();
  });

  it('composes readerBatch v4 from schema + caption + card + promo blocks', () => {
    expect(READER_BATCH).toBe(readerBatch(1));
    const b4 = readerBatch(4);
    expect(b4.length).toBeGreaterThan(readerBatch(2).length); // card+promo rules appended
    expect(b4).not.toContain('@@CAPTION@@');
  });

  it('keeps the historical batch directory shape', () => {
    expect(batchDir('/out', 'ch7', 1)).toBe(path.join('/out', 'batches', 'ch7'));
    expect(batchDir('/out', 'ch7', 4)).toBe(path.join('/out', 'batches', 'ch7', 'v4'));
  });

  it('pins the slicer and cleaner revision constants', () => {
    expect(SLICER_REV).toBe(3);
    expect(PROMO_ALGO_VERSION).toBe('pmask-v4');
    expect(PROMO_ROI_PAD_FRAC).toBe(0.5);
  });
});

describe('python-compatible serialization primitives', () => {
  it('renders floats exactly as python repr does', () => {
    expect(pyFloatRepr(0.0)).toBe('0.0');
    expect(pyFloatRepr(-0.0)).toBe('-0.0');
    expect(pyFloatRepr(0.1)).toBe('0.1');
    expect(pyFloatRepr(1.0)).toBe('1.0');
    expect(pyFloatRepr(288.0)).toBe('288.0');
    expect(pyFloatRepr(1e-5)).toBe('1e-05');
    expect(pyFloatRepr(1e20)).toBe('1e+20');
    expect(pyFloatRepr(123.456)).toBe('123.456');
  });

  it('marks py floats so they serialize with the trailing .0', () => {
    expect(pyJsonDumps({ s: pyFloat(1.0) }, { sortKeys: true })).toBe('{"s": 1.0}');
    expect(
      pyJsonDumps({ pad: pyFloat(0.5), regions: pyFloatDeep([{ x0: 10.0, y0: 20.0 }]) }, { sortKeys: true }),
    ).toBe('{"pad": 0.5, "regions": [{"x0": 10.0, "y0": 20.0}]}');
  });

  it('python repr string quirk: double quotes only with an apostrophe present', () => {
    expect(pyReprStr('plain')).toBe("'plain'");
    expect(pyReprStr("it's")).toBe('"it\'s"');
    expect(pyReprStr('a "b"')).toBe("'a \"b\"'");
  });

  it('sorts by code point like python, not by UTF-16 unit', () => {
    const out = pyJsonDumps({ b: 1, a: 2, '\u{10FFF0}': 3 }, { sortKeys: true });
    expect(Object.keys(JSON.parse(out)).sort()).toEqual(Object.keys(JSON.parse(out)).sort());
    expect(out.startsWith('{"a"')).toBe(true);
  });
});

describe('pagesHash / promoRulesHash / promoCacheHash / cfgHash', () => {
  let pagesDir: string;

  beforeEach(() => {
    pagesDir = makeTemp('phase0-pages');
    fsSync.writeFileSync(path.join(pagesDir, '001.webp'), 'A');
    fsSync.writeFileSync(path.join(pagesDir, '002.webp'), 'BB');
  });

  it('hashes sorted "<filename>:<size>\\n" rows of the chapter dir', () => {
    const expected = createHash('sha256')
      .update('001.webp:1\n002.webp:2\n')
      .digest('hex');
    expect(pagesHash(pagesDir)).toBe(expected);
    expect(pagesHash(pagesDir)).toBe(
      '493e778209ae2d2bd40de184bb58fc85ac108c997d2c4c24ae5d1924ae9dd88e',
    );
  });

  it('ignores subdirectories and follows symlinks to regular files', () => {
    fsSync.mkdirSync(path.join(pagesDir, 'subdir'));
    fsSync.symlinkSync(path.join(pagesDir, '001.webp'), path.join(pagesDir, 'link.webp'));
    const base =
      '493e778209ae2d2bd40de184bb58fc85ac108c997d2c4c24ae5d1924ae9dd88e';
    // os.path.isfile follows symlinks, so link.webp adds its own row.
    expect(pagesHash(pagesDir)).toBe(
      createHash('sha256').update('001.webp:1\n002.webp:2\nlink.webp:1\n').digest('hex'),
    );
    expect(pagesHash(pagesDir)).not.toBe(base);
  });

  it('changes when a page byte count changes', () => {
    const before = pagesHash(pagesDir);
    fsSync.writeFileSync(path.join(pagesDir, '002.webp'), 'BBB');
    expect(pagesHash(pagesDir)).not.toBe(before);
  });

  it('pins promoRulesHash digests', () => {
    expect(promoRulesHash({})).toBe('aa3b4efb3453d802f2e6d7e5d29ee857a151ce1f');
    expect(
      promoRulesHash({
        promo: ['b', 'a'],
        promo_rules: {
          hash: 'h1',
          registry_hash: 'r1',
          blocked: [{ string: 'xyz' }, { string: 'abc' }, null, 'junk'],
        },
      }),
    ).toBe('a346a19ec117b3da099e085a48b4b7b4800e6b76');
  });

  it('promoCacheHash folds source bytes, adapter bytes, regions, rules and texts', () => {
    const dir = makeTemp('phase0-promo');
    fsSync.writeFileSync(path.join(dir, 'cfg.json'), 'CONFIG-BYTES');
    fsSync.writeFileSync(path.join(dir, 'adapter.js'), 'ADAPTER-BYTES');
    // src.jpg intentionally absent -> "<no-source>" fallback bytes
    const it = {
      promo_regions: [{ text: 'READ', bbox: { x0: 10.0, y0: 20.0, x1: 110.0, y1: 40.0 } }],
      overlay: ['WHSSSH'],
      world: ['STATUS'],
    };
    expect(
      promoCacheHash(it, path.join(dir, 'src.jpg'), {
        configPath: path.join(dir, 'cfg.json'),
        adapterPath: path.join(dir, 'adapter.js'),
      }),
    ).toBe('540073965a212946f49a4a71eb5069aa5f0d7676');

    // A promotion-region float drift or a config byte drift must move the mask cache.
    const it2 = {
      promo_regions: [{ text: 'READ', bbox: [10, 20, 110, 40] }],
      overlay: ['WHSSSH'],
      world: ['STATUS'],
    };
    expect(
      promoCacheHash(it2, path.join(dir, 'src.jpg'), {
        configPath: path.join(dir, 'cfg.json'),
        adapterPath: path.join(dir, 'adapter.js'),
      }),
    ).not.toBe('540073965a212946f49a4a71eb5069aa5f0d7676');
  });

  it('cfgHash is a sha1 pair over config bytes and sorted world strings', () => {
    const dir = makeTemp('phase0-cfghash');
    fsSync.writeFileSync(path.join(dir, 'cfg.json'), 'CONFIG-BYTES');
    expect(cfgHash(['b world', 'a world'], path.join(dir, 'cfg.json'))).toBe(
      'ca24e5b07e7c6a1508b3097866d48c522eabdb23|abc612f0a757502e37821dc14290f7ed6b76b78b',
    );
  });
});

describe('narration cache keys and line proof tokens', () => {
  const lines: Array<readonly [string, readonly string[]]> = [
    ['Hello world', ['excited']],
    ['Second line', []],
  ];
  const extCfg: ExternalTtsConfig = {
    engine: 'external',
    provider: 'grok',
    revision: 'rev-2',
    command: ['tts'],
    voice_id: 'v9',
    language: 'en',
    speed: 1.0,
    style: 'calm',
    settings: { st: 1 },
  };

  it('openai-family engine keys the script repr + engine + voice', () => {
    expect(narrationCacheKey(lines, 'edge', 'en-US-Guy')).toBe('e388fde91c7d80e3');
    expect(narrationCacheKey(lines, 'eleven', 42)).not.toBe('e388fde91c7d80e3');
    expect(narrationCacheKey(lines, 'edge', 'en-US-Guy')).toBe(
      narrationCacheKey(lines, 'edge', 'en-US-Guy'),
    );
  });

  it('external engine keys the full provider payload', () => {
    expect(narrationCacheKey(lines, 'external', 'ignored', extCfg)).toBe('31d2eee74823bfca');
    expect(() =>
      narrationCacheKey(lines, 'external', 'ignored'),
    ).toThrow(/external engine cache key requires ext_cfg/);
    expect(narrationCacheKey(lines, 'external', 'ignored', { ...extCfg, speed: 1.25 })).not.toBe(
      '31d2eee74823bfca',
    );
  });

  it('lineProofToken: plain text proves itself, external adds the tts payload', () => {
    expect(lineProofToken('TEXT')).toBe('TEXT');
    const proof = lineProofToken('TEXT', extCfg);
    expect(JSON.parse(proof)).toEqual({
      text: 'TEXT',
      tts: {
        command: ['tts'],
        engine: 'external',
        language: 'en',
        provider: 'grok',
        revision: 'rev-2',
        settings: { st: 1 },
        speed: 1.0,
        style: 'calm',
        voice_id: 'v9',
      },
    });
    expect(proof).toContain('"speed": 1.0'); // pyFloat rendering, not "1"
    expect(lineProofToken('OTHER', extCfg)).not.toBe(proof);
  });
});

/* ------------------------------------------------------------------ *
 * Read-only validation against the real v1 series tree
 * ------------------------------------------------------------------ */

describe('real v1 artifacts parse cleanly with schemas.ts (read-only)', () => {
  const readJson = (file: string): unknown => JSON.parse(fsSync.readFileSync(file, 'utf8'));
  const listChapters = (dir: string): string[] =>
    fsSync
      .readdirSync(dir)
      .filter((name) => /^ch\d+/.test(name))
      .sort();

  it('every panel manifest of the real series parses as a Manifest record list', () => {
    let checked = 0;
    for (const slug of VALID_SERIES) {
      const panelsDir = path.join(V1_SERIES, slug, 'out', 'panels');
      for (const ch of listChapters(panelsDir)) {
        const file = path.join(panelsDir, ch, 'manifest.json');
        if (!fsSync.existsSync(file)) continue;
        const parsed = ManifestSchema.parse(readJson(file));
        expect(parsed.length).toBeGreaterThan(0);
        for (const rec of parsed) {
          expect(rec.page).toBeGreaterThan(0);
          expect(rec.w).toBeGreaterThan(0);
          expect(rec.h).toBeGreaterThan(0);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('every paid obs blob parses as a CachedBlob', () => {
    let checked = 0;
    let withPromoRegions = 0;
    for (const slug of VALID_SERIES) {
      const outDir = path.join(V1_SERIES, slug, 'out');
      for (const name of fsSync.readdirSync(outDir)) {
        if (!(name.startsWith('obs_') && name.endsWith('.json'))) continue;
        const blob = CachedBlobSchema.parse(readJson(path.join(outDir, name)));
        expect(blob.brief_hash).toMatch(/^[0-9a-f]{8}$/);
        expect(blob.data.panels.length).toBeGreaterThan(0);
        for (const panel of blob.data.panels) {
          if (panel.promo_regions?.length) withPromoRegions++;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(withPromoRegions).toBeGreaterThan(0); // reader promo contract present in real data
  });

  it('the series bible parses as a Bible record', () => {
    for (const slug of VALID_SERIES) {
      const file = path.join(V1_SERIES, slug, 'out', 'bible.json');
      const bible = BibleSchema.parse(readJson(file));
      expect(Object.keys(bible.characters).length).toBeGreaterThan(0);
      expect(bible.plot_ledger.length).toBeGreaterThan(0);
      for (const entry of bible.plot_ledger) {
        expect(entry.ch).toMatch(/^ch\d+$/);
        expect(entry.events.length).toBeGreaterThan(0);
      }
    }
  });

  it('every manifest-adjacent shots file parses as RecapProps', () => {
    let checked = 0;
    for (const slug of VALID_SERIES) {
      const outDir = path.join(V1_SERIES, slug, 'out');
      for (const ch of listChapters(outDir)) {
        const file = path.join(outDir, ch, 'video', 'shots.json');
        if (!fsSync.existsSync(file)) continue;
        const props = RecapPropsSchema.parse(readJson(file));
        expect(props.shots.length).toBeGreaterThan(0);
        expect(typeof props.audio).toBe('string');
        for (const shot of props.shots) {
          expect(shot.end_s).toBeGreaterThanOrEqual(shot.start_s);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('series that never wrote shots.json are skipped, not twisted green', () => {
    const missing = listChapters(path.join(V1_SERIES, 'reality-quest', 'out')).filter(
      (ch) =>
        !fsSync.existsSync(path.join(V1_SERIES, 'reality-quest', 'out', ch, 'video', 'shots.json')),
    );
    expect(Array.isArray(missing)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Box / promo sanitizers
 * ------------------------------------------------------------------ */

describe('normBox', () => {
  it('accepts the dict and array forms and returns clamped floats in 0..1', () => {
    expect(normBox({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 })).toEqual({
      x0: 0.1,
      y0: 0.2,
      x1: 0.9,
      y1: 0.8,
    });
    expect(normBox([0.1, 0.2, 0.9, 0.8])).toEqual({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 });
    expect(normBox({ x0: -0.5, y0: '0', x1: '1.5', y1: 1 })).toEqual({
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
    });
  });

  it('swaps inverted edges and rejects zero-area boxes', () => {
    expect(normBox({ x0: 0.9, y0: 0.8, x1: 0.1, y1: 0.2 })).toEqual({
      x0: 0.1,
      y0: 0.2,
      x1: 0.9,
      y1: 0.8,
    });
    expect(normBox({ x0: 0.5, y0: 0, x1: 0.5, y1: 1 })).toBeNull();
    expect(normBox({ x0: 0, y0: 0.5, x1: 1, y1: 0.5 })).toBeNull();
  });

  it('never throws: junk is null', () => {
    expect(normBox(null)).toBeNull();
    expect(normBox(undefined)).toBeNull();
    expect(normBox('junk')).toBeNull();
    expect(normBox([1, 2, 3])).toBeNull();
    expect(normBox({ x0: 0, y0: 0, x1: 1 })).toBeNull();
    expect(normBox({ x0: NaN, y0: 0, x1: 1, y1: 1 })).toBeNull();
    expect(normBox({ x0: Number.POSITIVE_INFINITY, y0: 0, x1: 1, y1: 1 })).toBeNull();
    expect(normBox({ x0: true, y0: 0, x1: 1, y1: 1 })).toBeNull();
    expect(normBox({ x0: ' 0.2 ', y0: 0, x1: 1, y1: 1 })).toEqual({ x0: 0.2, y0: 0, x1: 1, y1: 1 });
  });
});

describe('normPromoBbox', () => {
  it('lands inside 0..1000 with positive area', () => {
    expect(normPromoBbox({ x0: 10.0, y0: 20.0, x1: 110.0, y1: 40.0 })).toEqual({
      x0: 10.0,
      y0: 20.0,
      x1: 110.0,
      y1: 40.0,
    });
    expect(normPromoBbox([0, 0, 1000, 1000])).toEqual({ x0: 0, y0: 0, x1: 1000, y1: 1000 });
  });

  it('rejects (never clamps): out of range is null even though normBox clamps', () => {
    expect(normPromoBbox({ x0: -1, y0: 0, x1: 100, y1: 100 })).toBeNull();
    expect(normPromoBbox({ x0: 0, y0: 0, x1: 1001, y1: 100 })).toBeNull();
    expect(normPromoBbox({ x0: 10, y0: 0, x1: 1001, y1: 100 })).toBeNull();
  });

  it('does not swap and rejects inverted edges and zero area', () => {
    expect(normPromoBbox({ x0: 110, y0: 20, x1: 10, y1: 40 })).toBeNull();
    expect(normPromoBbox({ x0: 10, y0: 40, x1: 10, y1: 40 })).toBeNull();
    expect(normPromoBbox({ x0: 10, y0: 20, x1: 10, y1: 40 })).toBeNull();
  });
});

describe('applyPromoMeta', () => {
  it('keeps a valid boolean promo_page and cleans promo_regions', () => {
    const panel: any = {
      id: 'p0001_1',
      promo_page: true,
      promo_regions: [
        { text: 'READ ON', bbox: { x0: 10, y0: 20, x1: 110.0, y1: 40.0 } },
        { text: 'BAD', bbox: { x0: 5000, y0: 20, x1: 110, y1: 40 } }, // out of range -> dropped
        { text: 5, bbox: [1, 2, 3, 4] }, // non-string text -> "" kept
        'not-an-object',
        { text: 'BAD SHAPE', bbox: { x0: 1, y0: 2, x1: 3 } }, // missing y1 -> dropped
      ],
    };
    expect(applyPromoMeta(panel)).toBe(panel);
    expect(panel.promo_page).toBe(true);
    expect(panel.promo_regions).toEqual([
      { text: 'READ ON', bbox: { x0: 10, y0: 20, x1: 110, y1: 40 } },
      { text: '', bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
    ]);
  });

  it('drops non-boolean promo_page unknown (never coerces to false)', () => {
    const panel: any = { id: 'x', promo_page: 'yes', promo_regions: [] };
    applyPromoMeta(panel);
    expect('promo_page' in panel).toBe(false);
    expect(panel.promo_regions).toEqual([]); // present list with no survivor becomes []
  });

  it('removes non-array promo_regions and tolerates null / missing fields', () => {
    const panel: any = { id: 'x', promo_regions: 'junk' };
    applyPromoMeta(panel);
    expect('promo_regions' in panel).toBe(false);

    const bare: any = { id: 'x' };
    applyPromoMeta(bare);
    expect(Object.keys(bare)).toEqual(['id']);

    const nully: any = { id: 'x', promo_regions: null };
    applyPromoMeta(nully);
    expect(nully.promo_regions).toBeNull();
  });

  it('toPromoPageStatus maps the reader contract incl. legacy spellings', () => {
    expect(toPromoPageStatus(true)).toBe('full');
    expect(toPromoPageStatus(false)).toBe('partial');
    expect(toPromoPageStatus('full')).toBe('full');
    expect(toPromoPageStatus('partial')).toBe('partial');
    expect(toPromoPageStatus('unknown')).toBe('unknown');
    expect(toPromoPageStatus('junk')).toBe('unknown');
    expect(toPromoPageStatus(1)).toBe('unknown');
  });

  it('timeline validators: validBox is strict, validFocusX is scalar only', () => {
    expect(validBox({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 })).toEqual({
      x0: 0.1,
      y0: 0.2,
      x1: 0.9,
      y1: 0.8,
    });
    expect(validBox([0.1, 0.2, 0.9, 0.8])).toBeNull(); // array form is for normBox only
    expect(validBox({ x0: -0.1, y0: 0.2, x1: 0.9, y1: 0.8 })).toBeNull(); // no clamp
    expect(validBox({ x0: 0.9, y0: 0.2, x1: 0.1, y1: 0.8 })).toBeNull(); // no swap
    expect(validFocusX(0.5)).toBe(0.5);
    expect(validFocusX('0.5')).toBeNull();
    expect(validFocusX(true)).toBeNull();
    expect(validFocusX(1.5)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Panel order and adjacency (domain)
 * ------------------------------------------------------------------ */

describe('panelOrderKey', () => {
  it('parses (page, idx) from pNNNN_N ids', () => {
    expect(panelOrderKey('p0021_1')).toEqual([21, 1]);
    expect(panelOrderKey('0043_2')).toEqual([43, 2]);
    expect(panelOrderKey('p2_10')).toEqual([2, 10]);
  });

  it('sorts unparseable ids last with FAR_KEY, never throws', () => {
    expect(panelOrderKey('promo')).toEqual(FAR_KEY);
    expect(panelOrderKey('')).toEqual(FAR_KEY);
    expect(panelOrderKey(null)).toEqual(FAR_KEY);
    expect(panelOrderKey('path/to/p0005_3.jpg')).toEqual(FAR_KEY); // bare-id regex only: filenames sort FAR
  });
});

describe('keymap / adjKeys / isAdj / isChain', () => {
  const byId = {
    'p0006_2': { page: 6, idx: 2 },
    'p0006_1': { page: 6, idx: 1 },
    'p0007_1': { page: 7, idx: 1 },
    'p0005_1': null as null, // falls back to the id parse
    'p0099_1': { page: null, idx: Number.NaN }, // junk -> id parse
  } as Record<string, { page?: unknown; idx?: unknown } | null>;

  it('keymap prefers int page/idx on the rec, then the bare id parse', () => {
    const km = keymap(byId);
    expect(km['p0006_2']).toEqual([6, 2]);
    expect(km['p0006_2']![0]).toEqual(6);
    expect(km['p0005_1']).toEqual([5, 1]);
    expect(km['p0099_1']).toEqual([99, 1]);
  });

  it('adjKeys maps each order key to the next existing picture, keyed "page,idx"', () => {
    const km = keymap(byId);
    const succ = adjKeys(km);
    expect(succ['5,1']).toEqual([6, 1]);
    expect(succ['6,1']).toEqual([6, 2]);
    expect(succ['6,2']).toEqual([7, 1]);
    expect(succ['7,1']).toEqual([99, 1]);
    expect(succ['99,1']).toBeUndefined(); // last picture has no successor
  });

  it('duplicate order keys: last assignment wins, matching the python dict walk', () => {
    const succ = adjKeys(keymap({ a: { page: 1, idx: 1 }, b: { page: 1, idx: 1 }, c: { page: 1, idx: 2 } }));
    expect(succ['1,1']).toEqual([1, 2]);
  });

  it('isAdj accepts neighbours in either direction only', () => {
    const km = keymap(byId);
    const succ = adjKeys(km);
    expect(isAdj([6, 1], [6, 2], succ)).toBe(true);
    expect(isAdj([6, 2], [6, 1], succ)).toBe(true);
    expect(isAdj([6, 1], [7, 1], succ)).toBe(false);
  });

  it('isChain: len<2 is trivially a chain; len>=2 needs an unbroken slice', () => {
    const km = keymap(byId);
    const succ = adjKeys(km);
    expect(isChain(['p0006_1'], km, succ)).toBe(true);
    expect(isChain(['p0006_1'], undefined, undefined)).toBe(true);
    expect(isChain(['p0005_1', 'p0006_1', 'p0006_2', 'p0007_1'], km, succ)).toBe(true);
    expect(isChain(['p0006_1', 'p0007_1'], km, succ)).toBe(false);
    expect(isChain(['p0006_1', 'p0007_1'], km, undefined)).toBe(false);
    expect(isChain(['p0006_1', 'p0007_1'], undefined, succ)).toBe(false);
  });

  it('missing km entries sort FAR, so unknown ids break the chain', () => {
    const km = keymap({ a: { page: 1, idx: 1 }, b: { page: 1, idx: 2 } });
    const succ = adjKeys(km);
    expect(isChain(['a', 'b'], km, succ)).toBe(true);
    expect(isChain(['a', 'unknown'], km, succ)).toBe(false);
  });
});

describe('panelPositions / needsPositions / isPid', () => {
  it('panelPositions uses manifest page/idx and these drive sorting downstream', () => {
    const manifest = [
      { panel: 'ch40/p0001_1.jpg', page: 1, idx: 1, w: 940, h: 1685 },
      { panel: 'ch40/p0003_1.jpg', page: 3, idx: 1, w: 940, h: 1893 },
      { panel: 'junk' },
    ];
    const positions = panelPositions(manifest);
    expect(positions['p0001_1']).toEqual([1, 1]);
    expect(positions['p0003_1']).toEqual([3, 1]);
    expect(positions['junk']).toEqual(FAR_KEY);
  });

  it('needsPositions flags only obs that predate adjacency bookkeeping', () => {
    expect(needsPositions({ panels: [{ id: 'p2_1' }] })).toBe(true);
    expect(needsPositions({ panels: [{ id: 'p2_1', page: 2, idx: 1 }] })).toBe(false);
    expect(needsPositions({ panels: [] })).toBe(false);
    expect(needsPositions(null)).toBe(false);
    expect(needsPositions({ panels: [{ page: true, idx: 1 }] })).toBe(true); // bool is missing
  });

  it('isPid requires the leading p; page tokens and junk are null', () => {
    expect(isPid('p0001_1')).toBe('p0001_1');
    expect(isPid('0021_1')).toBeNull();
    expect(isPid('ch1')).toBeNull();
    expect(isPid(21)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * seriesLock helpers
 * ------------------------------------------------------------------ */

describe('validateSlug / validateChapter', () => {
  it('slugs: lowercase alnum words separated by single hyphens, 2..64 chars', () => {
    expect(validateSlug('kill-the-hero')).toBe('kill-the-hero');
    expect(validateSlug('ab')).toBe('ab');
    expect(validateSlug('  kill-the-hero  ')).toBe('kill-the-hero'); // trim
    expect(validateSlug('a')).toBeNull();
    expect(validateSlug('Kill-The-Hero')).toBeNull();
    expect(validateSlug('kill--hero')).toBeNull();
    expect(validateSlug('-kill-')).toBeNull();
    expect(validateSlug('kill_the-hero')).toBeNull();
    expect(validateSlug('x'.repeat(65))).toBeNull();
    expect(validateSlug(123)).toBeNull();
  });

  it('chapters: ch + 1..4 digits, case-insensitive, lowercased', () => {
    expect(validateChapter('ch12')).toBe('ch12');
    expect(validateChapter('CH99')).toBe('ch99');
    expect(validateChapter(' ch1 ')).toBe('ch1');
    expect(validateChapter('ch')).toBeNull();
    expect(validateChapter('ch12345')).toBeNull();
    expect(validateChapter('chapter1')).toBeNull();
    expect(validateChapter(1)).toBeNull();
  });
});

describe('series lock: nested shared refcounting (in-process)', () => {
  let root: string;
  let sdir: string;
  let lockPath: string;

  beforeEach(() => {
    root = makeTemp('phase0-lock-nested');
    sdir = path.join(root, 'alpha-series');
    fsSync.mkdirSync(sdir, { recursive: true });
    lockPath = lockFileForSeries(sdir);
    expect(lockPath).toBe(path.join(sdir, '.series.lock'));
  });

  it('multiple inner shared acquisitions refcount; the kernel lock drops only at zero', () => {
    const outer = acquireSharedSeriesLock({ directSdir: sdir, requireExists: true });
    expect(outer).toBe(lockPath);
    expect(() => acquireExclusiveSeriesLock(sdir, { nonblocking: true })).toThrow(BlockingIOError);

    // Nested acquisitions inside the same process: refcount only.
    const innerA = acquireSharedSeriesLock(sdir);
    const innerB = acquireSharedSeriesLock({ directSdir: sdir, requireExists: true });
    // Two refs remain even after the outer application lock is handed back.
    releaseSharedSeriesLock(outer);
    expect(() => acquireExclusiveSeriesLock(sdir, { nonblocking: true })).toThrow(BlockingIOError);
    releaseSharedSeriesLock(innerA);
    // One ref left: the kernel flock must still be held.
    expect(() => acquireExclusiveSeriesLock(sdir, { nonblocking: true })).toThrow(BlockingIOError);
    releaseSharedSeriesLock(innerB);

    // Only now the registry is empty and an exclusive lock can be taken.
    const handle = acquireExclusiveSeriesLock(sdir, { nonblocking: true });
    expect(handle.lockPath).toBe(lockPath);
    releaseExclusiveSeriesLock(handle);
  });

  it('withSharedSeriesLock releases on a throwing sync callback and never on null', () => {
    expect(() =>
      withSharedSeriesLock(sdir, () => {
        throw new Error('writer exploded');
      }),
    ).toThrow('writer exploded');
    const handle = acquireExclusiveSeriesLock(sdir, { nonblocking: true });
    releaseExclusiveSeriesLock(handle); // proves the shared flock above was released
  });

  it('requireExists=false resolves null for a missing series dir instead of throwing', () => {
    const absent = path.join(root, 'ghost-series');
    const mp: string | null = withSharedSeriesLock(
      { directSdir: absent, requireExists: false },
      (lp) => lp,
    );
    expect(mp).toBeNull();
    // ...and a discovered candidate dud throws when requireExists stays true.
    expect(() => acquireSharedSeriesLock({ directSdir: absent, requireExists: true })).toThrow(
      LockPathError,
    );
  });

  it('releaseSharedSeriesLock on unknown targets is a silent no-op', () => {
    expect(() => releaseSharedSeriesLock(undefined)).not.toThrow();
    expect(() => releaseSharedSeriesLock({ key: 'nope' })).not.toThrow();
    expect(() =>
      releaseSharedSeriesLock(path.join(root, 'not-a-locked-series', '.series.lock')),
    ).not.toThrow();
  });
});

describe('series lock: real kernel contention', () => {
  let root: string;
  let sdir: string;
  let lockPath: string;

  beforeEach(() => {
    root = makeTemp('phase0-lock-kernel');
    sdir = path.join(root, 'alpha-series');
    fsSync.mkdirSync(sdir, { recursive: true });
    lockPath = lockFileForSeries(sdir);
  });

  it('same process, separate fds: exclusive beats a later shared attempt and vice versa', () => {
    const fdA = fsSync.openSync(lockPath, 'a+');
    try {
      expect(tryFlockFd(fdA, 'ex')).toBe(true);
      const fdB = fsSync.openSync(lockPath, 'a+');
      try {
        expect(tryFlockFd(fdB, 'sh')).toBe(false); // EAGAIN, nonblocking shared
        expect(() => flockFd(fdB, 'sh', true)).toThrow(BlockingIOError);
      } finally {
        fsSync.closeSync(fdB);
      }
    } finally {
      flockFd(fdA, 'un');
      fsSync.closeSync(fdA);
    }
  });

  it('exclusive held by an orphan (different process) blocks a shared acquisition here', async () => {
    const readyFile = path.join(root, 'child-ready');
    fsSync.writeFileSync(lockPath, '', { mode: 0o664 });
    const child = spawn(
      'bash',
      ['-c', `exec 3>"${lockPath}"; flock -s 3; touch "${readyFile}"; sleep 1.0; exit 0`],
      { stdio: 'ignore', detached: false },
    );
    const deadline = Date.now() + 5000;
    while (!fsSync.existsSync(readyFile)) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('child lock holder never became ready');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const fd = fsSync.openSync(lockPath, 'a+');
    try {
      expect(tryFlockFd(fd, 'ex')).toBe(false); // child's LOCK_SH wins
    } finally {
      fsSync.closeSync(fd);
    }
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const fd2 = fsSync.openSync(lockPath, 'a+');
    try {
      expect(tryFlockFd(fd2, 'ex')).toBe(true);
    } finally {
      flockFd(fd2, 'un');
      fsSync.closeSync(fd2);
    }
  }, 15000);

  it('a held exclusive lock blocks withExclusiveSeriesLock nested in a delete hold', async () => {
    const out = path.join(sdir, 'out', 'ch1', 'video');
    fsSync.mkdirSync(out, { recursive: true });
    fsSync.writeFileSync(path.join(out, 'video.mp4'), 'VIDEO-BYTES');
    const procRoot = makeTemp('phase0-proc-table');
    fsSync.mkdirSync(procRoot, { recursive: true });
    const readyFile = path.join(root, 'delete-ready');

    const task = deleteChapterVideoLocked(path.join(root), 'alpha-series', 'ch1', {
      procRoot,
      lockHoldMs: 250,
      lockReadyFile: readyFile,
    });
    const deadline = Date.now() + 5000;
    while (!fsSync.existsSync(readyFile)) {
      if (Date.now() > deadline) throw new Error('delete never acquired LOCK_EX');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() =>
      withSharedSeriesLock({ directSdir: sdir, requireExists: true, nonblocking: true }, () => {}),
    ).toThrow(BlockingIOError);
    const result = await task;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.freedBytes).toBe('VIDEO-BYTES'.length);
    }
  }, 15000);

  it('withExclusiveSeriesLock wrapper takes and releases LOCK_EX', async () => {
    const result = await withExclusiveSeriesLock(
      sdir,
      { nonblocking: true },
      (lp) => lp,
    );
    expect(result).toBe(lockPath);
    // Released: shared lock now acquires cleanly.
    const mp = withSharedSeriesLock(sdir, (lp) => lp);
    expect(mp).toBe(lockPath);
  });
});

describe('series lock: symlink refusal', () => {
  let root: string;

  beforeEach(() => {
    root = makeTemp('phase0-lock-symlink');
  });

  it('refuses a symlinked .series.lock for shared acquisition and deletion', async () => {
    const sdir = path.join(root, 'sym-series');
    fsSync.mkdirSync(path.join(sdir, 'out', 'ch1', 'video'), { recursive: true });
    fsSync.writeFileSync(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'), 'AVI');
    const outside = path.join(root, 'outside-target.txt');
    fsSync.writeFileSync(outside, 'DO-NOT-TOUCH');
    fsSync.symlinkSync(outside, path.join(sdir, '.series.lock'));

    expect(() => acquireSharedSeriesLock({ directSdir: sdir })).toThrow(
      expect.objectContaining({ code: 'escaped_symlink' }) as Error,
    );
    const res = await deleteChapterVideo(root, 'sym-series', 'ch1', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.code).toBe('escaped_symlink');
    }
    expect(fsSync.readFileSync(outside, 'utf8')).toBe('DO-NOT-TOUCH');
    expect(fsSync.existsSync(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'))).toBe(true);
  });

  it('refuses a symlinked series directory', async () => {
    const outsideSeries = path.join(root, 'outside-series');
    fsSync.mkdirSync(path.join(outsideSeries, 'out', 'ch1', 'video'), { recursive: true });
    fsSync.writeFileSync(path.join(outsideSeries, 'out', 'ch1', 'video', 'video.mp4'), 'MP4');
    fsSync.symlinkSync(outsideSeries, path.join(root, 'aliased-series'));

    try {
      acquireSharedSeriesLock({ directSdir: path.join(root, 'aliased-series') });
      throw new Error('expected LockPathError');
    } catch (err) {
      expect((err as LockPathError).code).toBe('escaped_symlink');
    }
    const res = await deleteChapterVideo(root, 'aliased-series', 'ch1', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.code).toBe('escaped_symlink');
    }
    // The stash outside the tree was never touched.
    expect(fsSync.existsSync(path.join(outsideSeries, 'out', 'ch1', 'video', 'video.mp4'))).toBe(true);
  });

  it('refuses a symlinked video.mp4 target (no follow, no delete)', async () => {
    const sdir = path.join(root, 'victim-series');
    fsSync.mkdirSync(path.join(sdir, 'out', 'ch1', 'video'), { recursive: true });
    const outside = path.join(root, 'prize.mp4');
    fsSync.writeFileSync(outside, 'KEEP');
    fsSync.symlinkSync(outside, path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'));

    const res = await deleteChapterVideo(root, 'victim-series', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.code).toBe('escaped_symlink');
    }
    expect(fsSync.existsSync(outside)).toBe(true);
    expect(fsSync.lstatSync(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4')).isSymbolicLink()).toBe(true);
  });
});

describe('deleteChapterVideo in /tmp/opencode', () => {
  let root: string;

  beforeEach(() => {
    root = makeTemp('phase0-delete');
  });

  function makeSeries(
    slug = 'alpha-series',
    ch = 'ch1',
    videoBytes = Buffer.from('RENDERED-VIDEO-BYTES'),
  ): { sdir: string; videoPath: string } {
    const sdir = path.join(root, slug);
    fsSync.mkdirSync(path.join(sdir, ch), { recursive: true });
    fsSync.writeFileSync(path.join(sdir, ch, '001.webp'), 'PANEL');
    const videoPath = path.join(sdir, 'out', ch, 'video', 'video.mp4');
    fsSync.mkdirSync(path.dirname(videoPath), { recursive: true });
    fsSync.writeFileSync(videoPath, videoBytes);
    fsSync.writeFileSync(
      path.join(sdir, 'out', ch, 'video', 'shots.json'),
      JSON.stringify({ audio: `${slug}_${ch}/narration.mp3` }),
    );
    return { sdir, videoPath };
  }

  it('deletes the rendered video while holding LOCK_EX and frees its bytes', async () => {
    const { sdir, videoPath } = makeSeries();
    const res = await deleteChapterVideo(root, 'alpha-series', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.slug).toBe('alpha-series');
      expect(res.ch).toBe('ch1');
      expect(res.freedBytes).toBe('RENDERED-VIDEO-BYTES'.length);
      expect(res.deleted).toEqual([path.join('alpha-series', 'out', 'ch1', 'video', 'video.mp4')]);
    }
    expect(fsSync.existsSync(videoPath)).toBe(false);
    // other chapter artifacts survive: source pages, video dir, shots sidecar
    expect(fsSync.existsSync(path.join(sdir, 'out', 'ch1', 'video', 'shots.json'))).toBe(true);
    const again = await deleteChapterVideo(root, 'alpha-series', 'ch1', { procRoot: path.join(root) });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.status).toBe(404);
      expect(again.code).toBe('not_found');
    }
  });

  it('rejects invalid slug or chapter immediately (400 invalid_path)', async () => {
    for (const [slug, ch] of [
      ['Kill', 'ch1'],
      ['alpha-series', 'episode'],
      ['', 'ch1'],
    ]) {
      const res = await deleteChapterVideo(root, slug, ch, {});
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(400);
        expect(res.code).toBe('invalid_path');
      }
    }
    expect(fsSync.readdirSync(root).length <= 1).toBe(true);
  });

  it('404 when the video was never rendered', async () => {
    const sdir = path.join(root, 'naked-series');
    fsSync.mkdirSync(path.join(sdir, 'out', 'ch1', 'video'), { recursive: true });
    const res = await deleteChapterVideo(root, 'naked-series', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.code).toBe('not_found');
    }
  });

  it('409 render_in_progress while video.mp4.part or scratch exist', async () => {
    const { videoPath } = makeSeries('busy-series', 'ch1');
    fsSync.writeFileSync(`${videoPath}.part`, Buffer.from('part'));
    const res = await deleteChapterVideo(root, 'busy-series', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.code).toBe('render_in_progress');
    }
    fsSync.unlinkSync(`${videoPath}.part`);
    // Path obstructions go but scratch dirs still block after retry
    fsSync.mkdirSync(path.join(path.dirname(videoPath), '.render-tmp'), { recursive: true });
    fsSync.writeFileSync(path.join(path.dirname(videoPath), '.render-tmp', '.render-9'), 'x');
    const res2 = await deleteChapterVideo(root, 'busy-series', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.status).toBe(409);
      expect(res2.code).toBe('render_in_progress');
    }
  });

  it('409 when an active pipeline writer is discovered under the proc table', async () => {
    const { videoPath } = makeSeries('watched-series', 'ch1');
    const procRoot = path.join(root, 'proc');
    const pidDir = path.join(procRoot, '999999');
    fsSync.mkdirSync(path.join(pidDir), { recursive: true });
    fsSync.writeFileSync(path.join(pidDir, 'stat'), '999999 (python) R 1 999999 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1\n');
    fsSync.writeFileSync(
      path.join(pidDir, 'cmdline'),
      'python\x00/home/shair/manhwa-pipeline/pipeline/run.py\x00watched-series\x00ch1\x00',
    );
    const res = await deleteChapterVideo(root, 'watched-series', 'ch1', { procRoot });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.code).toBe('pipeline_active');
    }
    expect(fsSync.existsSync(videoPath)).toBe(true); // protected
  });

  it('pendingKey is slug + lowercased chapter', () => {
    expect(pendingKey('alpha-series', 'ch9')).toBe('alpha-series/ch9');
    expect(pendingKey('alpha-series', 'CH9')).toBe('alpha-series/ch9');
  });

  it('a slug that never rendered points straight at not_found', async () => {
    const res = await deleteChapterVideo(root, 'nonexistent-slug', 'ch1', {
      procRoot: path.join(root),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.code).toBe('not_found');
    }
  });

  it('cross-series locks are independent in deleteChapterVideoLocked', async () => {
    makeSeries('series-alpha', 'ch1');
    const { videoPath: videoB } = makeSeries('series-bravo', 'ch1');
    // Alpha has NO video to delete (not_found); bravo's delete still goes through lock path.
    const resA = await deleteChapterVideo(root, 'series-alpha', 'ch2', { procRoot: path.join(root) });
    expect(resA.ok).toBe(false);
    if (!resA.ok) expect(resA.code).toBe('not_found');
    const resB = await deleteChapterVideo(root, 'series-bravo', 'ch1', { procRoot: path.join(root) });
    expect(resB.ok).toBe(true);
    expect(fsSync.existsSync(videoB)).toBe(false);
  });
});

describe('deleteChapterVideo: expected inode/mtime revalidation', () => {
  it('409 when video.mp4 changed between resolution and the critical section', async () => {
    const root = makeTemp('phase0-delete-race');
    const videoPath = path.join(root, 'racing-series', 'out', 'ch1', 'video', 'video.mp4');
    fsSync.mkdirSync(path.dirname(videoPath), { recursive: true });
    fsSync.writeFileSync(videoPath, Buffer.from('OLD-VIDEO'));
    const res = await deleteChapterVideo(root, 'racing-series', 'ch1', {
      procRoot: path.join(root),
      expectedSize: 3, // forces render_in_progress, since the real bytes differ
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.code).toBe('render_in_progress');
    }
    expect(fsSync.existsSync(videoPath)).toBe(true);
  });
});

describe('pyFloat reconciliation', () => {
  it('pyFloat marks whole values so serialization keeps ".0" for python floats', () => {
    expect(pyJsonDumps({ v: 288 }, {})).toBe('{"v": 288}'); // int stays int
    expect(pyJsonDumps({ v: pyFloat(288) }, {})).toBe('{"v": 288.0}'); // python float stays float
  });
});
