/**
 * T2.4 Phase 2 intake tests, ported from the v1 suites:
 *   pipeline/tools/test_promo_block_registry.py  -> promoBlock.ts (registry,
 *     name/domain boundary matching, panel_full_promo matrix, build wiring,
 *     ensure rebuilds, occurrence accumulator)
 *   pipeline/tests/test_intake.py (subset)       -> ingest.ts zip-safety +
 *     extraction + intake.ts queue/security
 *   pipeline/tests/test_voice_preview.py         -> voicePreview.ts
 *
 * Offline only: no provider calls, no rendering, no writes into the v1 tree.
 * Every on-disk side effect lives in an isolated temp dir under /tmp/opencode.
 * The v1 series data at /home/shair/manhwa-pipeline/series is only READ.
 */
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BLOCK_FILE,
  Block,
  buildBlock,
  cmpCodePoints,
  domainMatches,
  ensure,
  extractZipSeeds,
  FULL_PROMO_ART_FULL,
  FULL_PROMO_ART_LOW,
  load,
  loadRegistry,
  MIN_CH_URL,
  nameMatches,
  norm,
  pathFor,
  registryDigest,
  wkey,
} from '../src/intake/promoBlock.js';
import {
  cbzIndex,
  comicTitle,
  ingest,
  parseChapterSpec,
  validateZipArchive,
  ZipValidationError,
  MAX_COMPRESSION_RATIO,
} from '../src/intake/ingest.js';
import {
  cacheKey,
  EDGE_VOICE,
  generatePreview,
  PreviewBusyError,
  PreviewCooldownError,
  PreviewError,
  probeMp3,
  PREVIEW_DIR_NAME,
} from '../src/intake/voicePreview.js';
import { pyJsonDumps } from '../src/contracts/hashes.js';
import {
  ConflictError,
  continueJob,
  enqueueJob,
  getCatalog,
  getJob,
  IntakeError,
  isBlockedPublicIp,
  listJobs,
  loadRawTtsProviders,
  parseGdriveUrl,
  PreflightError,
  reconcileJobs,
  reconcileOrphans,
  resolveTtsSelection,
  retryJob,
  slugify,
  validateChaptersSpec,
  validateDownloadTargetUrl,
  validateSlug,
  verifyHostPublicIp,
  jobsDir,
  seriesRoot,
  existingChapterNumbers,
  downloadGdriveZip,
} from '../src/intake/intake.js';
import { flockFd } from '../src/locks/seriesLock.js';

// ---------------------------------------------------------------------------
// temp scaffolding
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
afterAll(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await fsSync.rmSync(dir, { recursive: true, force: true, });
  }
});

function makeTemp(prefix: string): string {
  fsSync.mkdirSync('/tmp/opencode', { recursive: true });
  const dir = fsSync.mkdtempSync(path.join('/tmp/opencode', `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

/** Replaces process.env for functions that read it at call time. */
function stubProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** obs fixture writer: creates the empty chN dir (what buildBlock enumerates)
 *  plus the obs_chN.json string source the collector reads. */
function writeObs(outDir: string, ch: string, panels: Record<string, unknown>[]): void {
  fsSync.mkdirSync(path.join(outDir, ch), { recursive: true });
  fsSync.writeFileSync(
    path.join(outDir, `obs_${ch}.json`),
    JSON.stringify({ panels }),
  );
}

// ---------------------------------------------------------------------------
// minimal hand-built ZIP writer (for malicious attribute fixtures that adm-zip
// cannot produce: symlink modes, encryption flags, fake sizes)
// ---------------------------------------------------------------------------

interface MzEntry {
  name: string;
  data?: Buffer | null;
  flags?: number;
  method?: number;
  /** unix mode stored in the external-attributes high half; null = msdos */
  mode?: number | null;
  /** override the DECLARED uncompressed size in the headers */
  sizeField?: number;
  /** override the DECLARED compressed size in the headers */
  compSizeField?: number;
}

function buildRawZip(entries: MzEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let cdSize = 0;
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? (data.length > 0 ? 8 : 0);
    let stored = data;
    let crc = 0;
    if (data.length > 0) crc = zlib.crc32(data) >>> 0;
    if (method === 8) stored = zlib.deflateRawSync(data);
    const size = e.sizeField ?? data.length;
    const compSize = e.compSizeField ?? stored.length;
    const flags = e.flags ?? 0;
    const mode = e.mode ?? null;
    const hostVer = mode === null ? 0 : 3;

    const lfh = Buffer.alloc(32);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(23, 4);
    lfh.writeUInt16LE(20, 6);
    lfh.writeUInt16LE(flags, 8);
    lfh.writeUInt16LE(method, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt16LE(0x21, 14);
    lfh.writeUInt32LE(crc, 16);
    lfh.writeUInt32LE(compSize, 20);
    lfh.writeUInt32LE(size, 24);
    lfh.writeUInt16LE(nameBytes.length, 28);
    lfh.writeUInt16LE(0, 30);
    locals.push(lfh, nameBytes, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((hostVer << 8) | 23, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(mode === null ? 0 : (mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBytes);
    cdSize += 46 + nameBytes.length;
    offset += 32 + nameBytes.length + stored.length;
  }
  const body = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const n = entries.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(body.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([body, cdBuf, eocd]);
}

function writeRawZip(dir: string, file: string, entries: MzEntry[]): string {
  const p = path.join(dir, file);
  fsSync.writeFileSync(p, buildRawZip(entries));
  return p;
}

// ---------------------------------------------------------------------------
// ZIP fixtures (nested .cbz + folder layouts) via adm-zip
// ---------------------------------------------------------------------------

const PAGE_A = Buffer.from('jpeg-bytes-page-two');
const PAGE_B = Buffer.from('jpeg-bytes-page-ten');
const PAGE_C = Buffer.from('jpeg-bytes-page-nine');

function makeCbzBlob(pages: Buffer[], comicInfo?: string): Buffer {
  const inner = new AdmZip();
  let i = 0;
  for (const p of pages) {
    inner.addFile(`page ${String(++i).padStart(3, '0')}.jpg`, p);
  }
  if (comicInfo) inner.addFile('ComicInfo.xml', Buffer.from(comicInfo, 'utf8'));
  return inner.toBuffer();
}

function makeNestedCbzZip(dir: string, file: string): string {
  const outer = new AdmZip();
  outer.addFile(
    'Rage scans_Chapter 2_0.cbz',
    makeCbzBlob([PAGE_A, PAGE_B], '<ComicInfo><Series>Natural Parity</Series><Title>Natural Parity</Title></ComicInfo>'),
  );
  outer.addFile('Rage scans_Chapter 10_1.cbz', makeCbzBlob([PAGE_C]));
  const p = path.join(dir, file);
  outer.writeZip(p);
  return p;
}

function makeFolderZip(dir: string, file: string): string {
  const outer = new AdmZip();
  outer.addFile('ComicInfo.xml', Buffer.from('<ComicInfo><Series>Folder Title</Series></ComicInfo>'));
  outer.addFile('Chapter 3/010.jpg', PAGE_B);
  outer.addFile('Chapter 3/2.jpg', PAGE_A);
  const p = path.join(dir, file);
  outer.writeZip(p);
  return p;
}

// V1 corpus source (READ ONLY) for the promo parity test.
const V1_SERIES_DIR = '/home/shair/manhwa-pipeline/series/kill-the-hero';
const V1_OUT_DIR = path.join(V1_SERIES_DIR, 'out');

/* ========================================================================== *
 * promoBlock.ts
 * ========================================================================== */

describe('promoBlock: norm / wkey / codepoint compare', () => {
  it('norm strips everything but [a-z0-9]', () => {
    expect(norm('  Rage--Scans!! ')).toBe('ragescans');
    expect(norm('RAGE_0')).toBe('rage0');
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });

  it('wkey is a python \\s-aware, whitespace-collapsed lower key', () => {
    expect(wkey('  Rage--Scans  ')).toBe('rage--scans');
    expect(wkey('A\t \nB ')).toBe('a b');
    // \f and \x1c are python whitespace but JS \s also covers \f; the BOM is
    // NOT python whitespace so it must survive.
    expect(wkey('\uFEFF')).not.toBe('');
    // \x85 IS python whitespace (JS \s also matches it here)
    expect(wkey('x\u0085y')).toBe('x y');
    expect(wkey(null)).toBe('');
  });

  it('cmpCodePoints orders like python str (not UTF-16 units)', () => {
    expect(cmpCodePoints('a', 'b')).toBe(-1);
    expect(cmpCodePoints('b', 'a')).toBe(1);
    expect(cmpCodePoints('ab', 'ab')).toBe(0);
    expect(cmpCodePoints('ab', 'abc')).toBeLessThan(0);
  });
});

describe('promoBlock: safe boundary matching', () => {
  it('nameMatches is a full-label word boundary match', () => {
    expect(nameMatches('Read at Reaper Scans!', 'reaper scans')).toBe(true);
    expect(nameMatches('Reaper', 'reaper scans')).toBe(false);
    // the guard that exists because of this audit finding: bare substring
    // seeds must never fire inside unrelated prose
    expect(nameMatches('raging over orange juice', 'rage')).toBe(false);
    expect(nameMatches('reapering through the field', 'reaper scans')).toBe(false);
    expect(nameMatches('', 'reaper scans')).toBe(false);
  });

  it('domainMatches is a canonical host-suffix match, not a substring match', () => {
    expect(domainMatches('https://asurascans.com/ch1', 'asurascanscom')).toBe(true);
    expect(domainMatches('m.asurascans.com', 'asurascanscom')).toBe(true);
    expect(domainMatches('http://www.RageScans.com/x', 'ragescanscom')).toBe(true);
    expect(domainMatches('notasurascans.com', 'asurascanscom')).toBe(false);
    expect(domainMatches('asurascans.com.evil.net', 'asurascanscom')).toBe(false);
    expect(domainMatches('myragescanscommunity.net', 'ragescanscom')).toBe(false);
    // old normalized (dotless) payloads still work through HOST_RE recovery
    expect(domainMatches('bato.to/discord', 'batoto')).toBe(true);
    expect(domainMatches('x', 'asurascanscom')).toBe(false);
  });
});

describe('promoBlock: loadRegistry (shared sources)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTemp('reg-fixture');
  });

  it('imports full-label names + dotted real domains, rejects bare tokens', () => {
    const regPath = path.join(dir, 'promo_sources.json');
    fsSync.writeFileSync(regPath, JSON.stringify({
      version: 1,
      sources: [
        { id: 'asura-scans', names: ['Asura Scans'], domains: ['asurascans.com'] },
        { id: 'reaper-scans', names: ['Reaper Scans'], domains: ['reaperscans.com'] },
        // malformed entries are rejected by the loader
        { id: 'bare', names: ['Asura'], domains: ['not a domain'] },
        { id: 'one-word', names: ['Flame'], domains: ['notadomain'] },
      ],
    }));
    const reg = loadRegistry(regPath);
    expect(reg.names).toContain('asura scans');
    expect(reg.names).toContain('reaper scans');
    expect(reg.names).not.toContain('asura');
    expect(reg.names).not.toContain('flame');
    expect(reg.domains).toContain('asurascanscom');
    expect(reg.domains).toContain('reaperscanscom');
    expect(reg.domains).not.toContain('notadomain');
    expect(reg.digest).toMatch(/^[0-9a-f]{16}$/);
    // deterministic sorted like python sorted()
    expect([...reg.names]).toEqual([...reg.names].sort(cmpCodePoints));
  });

  it('digest changes when the registry bytes change', () => {
    const regPath = path.join(dir, 'promo_sources.json');
    fsSync.writeFileSync(regPath, JSON.stringify({
      version: 1,
      sources: [{ id: 'a', names: ['Asura Scans'], domains: [] }],
    }));
    const d1 = loadRegistry(regPath).digest;
    fsSync.writeFileSync(regPath, JSON.stringify({
      version: 1,
      sources: [{ id: 'a', names: ['Asura Scans', 'Flame Scans'], domains: [] }],
    }));
    const d2 = loadRegistry(regPath).digest;
    expect(d2).not.toBe(d1);
    // the default REGISTRY_FILE (repo copy) still loads to a real digest
    expect(registryDigest()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('missing / broken / wrong-version registry contributes nothing', () => {
    expect(loadRegistry(path.join(dir, 'missing.json'))).toEqual({
      names: [], domains: [], digest: '',
    });
    const badJson = path.join(dir, 'bad.json');
    fsSync.writeFileSync(badJson, '{not json');
    expect(loadRegistry(badJson).digest).toBe('');
    const badVersion = path.join(dir, 'v9.json');
    fsSync.writeFileSync(badVersion, JSON.stringify({ version: 9, sources: [] }));
    expect(loadRegistry(badVersion).digest).toBe('');
    const notList = path.join(dir, 'nl.json');
    fsSync.writeFileSync(notList, JSON.stringify({ version: 1, sources: 'nope' }));
    expect(loadRegistry(notList).digest).toBe('');
  });
});

describe('promoBlock: Block matches + panelPromo + panelFullPromo', () => {
  const block = new Block({
    prior_names: ['asura scans'],
    prior_domains: ['asurascanscom'],
  });

  it('matches() fires on full labels and registry domains only', () => {
    expect(block.matches('Read at Asura Scans')).toBe(true);
    expect(block.matches('https://asurascans.com/webtoon')).toBe(true);
    // the audited false positive must NEVER fire
    expect(block.matches('Asura went raging over orange juice')).toBe(false);
    expect(block.matches('Asura')).toBe(false);
    expect(block.matches('')).toBe(false);
  });

  it('panelPromo counts OVERLAY and WORLD text', () => {
    expect(block.panelPromo({ overlay: ['nice panel'], world: [] })).toBe(false);
    expect(block.panelPromo({ overlay: ['nothing'], world: ['Read at Asura Scans'] })).toBe(true);
    expect(block.panelPromo({ overlay: ['asurascans.com banner'] })).toBe(true);
    expect(block.panelPromo(null)).toBe(false);
  });

  it('panelPromoStrings returns the matched strings only', () => {
    expect(block.panelPromoStrings({
      overlay: ['Read at Asura Scans', 'story text'],
      world: ['m.asurascans.com', 'clean'],
    })).toEqual(['Read at Asura Scans', 'm.asurascans.com']);
    expect(block.panelPromoStrings(null)).toEqual([]);
  });

  it('explicit promo_page=true is FULL even with no name hit', () => {
    expect(block.panelFullPromo({
      promo_page: true, overlay: ['some advert'], art: 0.95, bubble_at: 'center',
    })).toBe(true);
  });

  it('promo_page=false with usable metadata keeps the panel (mixed)', () => {
    expect(block.panelFullPromo({
      promo_page: false, overlay: ['Asura Scans'], art: 0.9, bubble_at: 'center',
    })).toBe(false);
    expect(block.panelFullPromo({
      promo_page: false, overlay: ['clean art'], art: 0.9, bubble_at: 'center',
    })).toBe(false);
  });

  it('no detected promo and no explicit true is never full', () => {
    expect(block.panelFullPromo({ overlay: ['hello world'], art: 0.1 })).toBe(false);
    expect(block.panelFullPromo({ promo_page: false, overlay: ['hello world'] })).toBe(false);
  });

  it('unknown flag falls back to the coarse art/bubble_at candidate matrix', () => {
    const promo = 'Asura Scans';
    for (const ba of ['none', 'corner', 'edge', 'top', 'bottom', 'center'] as const) {
      // useful art (0.9 > FULL_PROMO_ART_LOW) with a small bubble is kept
      expect(block.panelFullPromo({ overlay: [promo], art: 0.9, bubble_at: ba })).toBe(false);
    }
    // low art (<= FULL_PROMO_ART_LOW) is a full promo page
    expect(block.panelFullPromo({ overlay: [promo], art: FULL_PROMO_ART_LOW, bubble_at: 'full' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: 0.7, bubble_at: 'full' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: FULL_PROMO_ART_FULL, bubble_at: 'full' })).toBe(false);
    // missing/invalid art or bubble_at is conservative full (fail safe)
    expect(block.panelFullPromo({ overlay: [promo] })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: Number.NaN, bubble_at: 'corner' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: Number.POSITIVE_INFINITY, bubble_at: 'corner' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: 1.5, bubble_at: 'corner' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: -0.1, bubble_at: 'corner' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: 0.9, bubble_at: 5 })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: 0.9, bubble_at: 'bogus' })).toBe(true);
    expect(block.panelFullPromo({ overlay: [promo], art: 'high', bubble_at: 'corner' })).toBe(true);
  });
});

describe('promoBlock: zip seeds', () => {
  it('extracts cbz-filename group prefix + nested ComicInfo <Translator>', () => {
    const dir = makeTemp('promo-zipseed');
    const inner = new AdmZip();
    inner.addFile('pp.jpg', Buffer.from('x'));
    inner.addFile('ComicInfo.xml', Buffer.from('<ComicInfo><Translator> Rage Community </Translator></ComicInfo>'));
    const outer = new AdmZip();
    outer.addFile('Rage scans_Chapter 1_0.cbz', inner.toBuffer());
    outer.addFile('OtherGroup_Chapter 2_x.cbz', Buffer.from('x'));
    const zipPath = path.join(dir, 'src.zip');
    outer.writeZip(zipPath);
    const seeds = extractZipSeeds(zipPath);
    expect([...seeds].sort()).toEqual(['OtherGroup', 'Rage Community', 'Rage scans']);
  });
});

describe('promoBlock: buildBlock R1-R4 rules and guards', () => {
  let seriesDir: string;
  let outDir: string;
  let undoEnv: () => void;

  beforeEach(() => {
    const root = makeTemp('promo-rules');
    seriesDir = root;
    outDir = path.join(root, 'out');
    undoEnv = stubProcessEnv({ MANHWA_DOWNLOADS: path.join(root, 'no-zips') });
    // 7 pages per chapter so pages 3-5 are interior (edge = first/last 2).
    for (const ch of ['ch1', 'ch2', 'ch3']) {
      writeObs(outDir, ch, [
        { id: 'p0001_1', overlay: ['JOIN OUR DISCORD: https://ragescans.com/invite'], world: [] },
        { id: 'p0001_2', overlay: ['Come join our discord channel.'], world: [] },
        { id: 'p0001_3', overlay: ['Rage Team'], world: [] },
        { id: 'p0001_4', overlay: ['STARDUST!'], world: [] },
        { id: 'p0002_1', overlay: ['sang | Studio Redice Production'], world: [] },
        { id: 'p0003_1', overlay: ['The alley stank of rain.'], world: [] },
        { id: 'p0004_1', overlay: ['filler text nobody repeats'], world: [] },
        { id: 'p0005_1', overlay: ['filler b'], world: [] },
        { id: 'p0006_1', overlay: ['filler c'], world: [] },
        { id: 'p0007_1', overlay: ['filler d'], world: [] },
      ]);
    }
    // STARDUST! also appears as WORLD text in ch1 -> must never be blocked.
    const obs = JSON.parse(fsSync.readFileSync(path.join(outDir, 'obs_ch1.json'), 'utf8'));
    obs.panels.push({ id: 'p0002_2', overlay: [], world: ['STARDUST!'] });
    fsSync.writeFileSync(path.join(outDir, 'obs_ch1.json'), JSON.stringify(obs));
    // squash one filler so only the interior control stays corroborated
    for (const ch of ['ch1', 'ch2', 'ch3']) {
      const d = JSON.parse(fsSync.readFileSync(path.join(outDir, `obs_${ch}.json`), 'utf8'));
      d.panels = d.panels.filter((p: { overlay?: string[] }) => p.overlay?.[0] !== 'filler b');
      fsSync.writeFileSync(path.join(outDir, `obs_${ch}.json`), JSON.stringify(d));
    }
    fsSync.writeFileSync(path.join(seriesDir, 'meta.json'), JSON.stringify({ title: 'Rules Fixture' }));
  });

  afterEach(() => undoEnv());

  it('writes promo_block.json with R1/R2/R3/R4 entries and guards the story strings', () => {
    const block = buildBlock(seriesDir, outDir, '', false);
    const blockedEntries = (block.data.blocked ?? []) as Array<{
      string: string; rule: string; chapters: number;
    }>;
    const byKey = new Map(blockedEntries.map((b) => [wkey(b.string), b] as const));
    const blocked = (s: string) => blockedEntries.find((b) => wkey(b.string) === wkey(s));

    // R1: URL family, corroborated across >= MIN_CH_URL chapters
    expect(MIN_CH_URL).toBe(3);
    const r1 = blocked('JOIN OUR DISCORD: https://ragescans.com/invite');
    expect(r1?.rule).toBe('R1-URL');
    expect(r1?.chapters).toBeGreaterThanOrEqual(3);
    expect(block.domains).toContain('ragescanscom');
    expect(block.matches('see ragescans.com/x for more')).toBe(true);

    // R2: promo verb phrase, corroborated across >= 2 chapters
    const r2 = blocked('Come join our discord channel.');
    expect(r2?.rule).toBe('R2-PROMO');
    expect(r2?.chapters).toBeGreaterThanOrEqual(2);

    // R3: pipe-separated credit line, corroborated >= 2 chapters
    const r3 = blocked('sang | Studio Redice Production');
    expect(r3?.rule).toBe('R3-CREDIT');
    expect(r3?.chapters).toBeGreaterThanOrEqual(2);

    // R4: edge-page-only overlay banner, corroborated >= 3 chapters, never WORLD
    const r4 = blocked('Rage Team');
    expect(r4?.rule).toBe('R4-EDGE');
    expect(r4?.chapters).toBe(3);

    // GUARD: STARDUST! repeats 3x but lives in WORLD text -> never blocked by
    // R4, and it is not URL/promo/credit shaped -> survives entirely.
    expect(blocked('STARDUST!')).toBeUndefined();
    expect(block.matches('STARDUST!')).toBe(false);

    // GUARD: the interior story line does not corroborate as edge-only
    const control = byKey.get(wkey('The alley stank of rain.'));
    expect(control).toBeUndefined();

    // ON-DISK parity: load() reads back the same block
    const fromDisk = load(outDir);
    expect(fromDisk).not.toBeNull();
    expect(fromDisk?.hash).toBe(block.hash);
    expect(fsSync.existsSync(pathFor(outDir))).toBe(true);
    expect(pathFor(outDir)).toContain(BLOCK_FILE);
  });
});

describe('promoBlock: ensure() rebuild semantics', () => {
  it('rebuilds only when a new obs chapter or change appears', () => {
    const root = makeTemp('promo-ensure');
    const outDir = path.join(root, 'out');
    writeObs(outDir, 'ch1', [
      { id: 'p0001_1', overlay: ['Come join our discord today.'], world: [] },
    ]);
    fsSync.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ title: 'Ensure Fixture' }));

    const first = ensure(root, outDir);
    expect(first).not.toBeNull();
    expect(first?.data.built_from_chapters).toEqual(['ch1']);
    const onDisk = JSON.parse(
      fsSync.readFileSync(pathFor(outDir), 'utf8'),
    ) as { hash?: string };
    expect(onDisk.hash).toBe(first?.hash);

    // no new chapters -> no rebuild, same hash
    const same = ensure(root, outDir);
    expect(same?.hash).toBe(first?.hash);

    // new chapter -> rebuild, built_from_chapters expands
    writeObs(outDir, 'ch2', [
      { id: 'p0001_1', overlay: ['Come join our discord today.'], world: [] },
    ]);
    const second = ensure(root, outDir);
    expect(second?.data.built_from_chapters).toEqual(['ch1', 'ch2']);
    // the promo phrase is now corroborated across 2 chapters -> blocked
    expect((second?.data.blocked ?? []).some((b) => (b as { rule?: string }).rule === 'R2-PROMO')).toBe(true);
  });
});

describe('promoBlock: parity rebuild of a real v1 series (read-only source)', () => {
  it('reproduces the v1 block rules from the copied obs corpus', () => {
    if (!fsSync.existsSync(path.join(V1_OUT_DIR, 'obs_ch1.json'))) {
      throw new Error(`v1 fixture missing: ${V1_OUT_DIR}`);
    }
    const root = makeTemp('promo-parity-kth');
    const outDir = path.join(root, 'out');
    fsSync.mkdirSync(outDir, { recursive: true });

    // snapshot the v1 artifact we must NOT touch
    const v1BlockPath = path.join(V1_OUT_DIR, BLOCK_FILE);
    const v1Mtime = fsSync.statSync(v1BlockPath).mtimeMs;
    const v1Size = fsSync.statSync(v1BlockPath).size;

    const undone = stubProcessEnv({ MANHWA_DOWNLOADS: path.join(root, 'no-zips') });
    try {
      for (const f of fsSync.readdirSync(V1_OUT_DIR)) {
        if (f.startsWith('obs_') && f.endsWith('.json')) {
          fsSync.mkdirSync(path.join(outDir, f.slice(4, -5)), { recursive: true });
          fsSync.copyFileSync(path.join(V1_OUT_DIR, f), path.join(outDir, f));
        }
      }
      const v1Meta = JSON.parse(fsSync.readFileSync(path.join(V1_SERIES_DIR, 'meta.json'), 'utf8')) as { title?: string };
      fsSync.writeFileSync(path.join(root, 'meta.json'), JSON.stringify(v1Meta));

      const block = buildBlock(root, outDir, '', false);
      // the v1 file recorded these exact rule outcomes for this corpus
      const blocked = (s: string) => ((block.data.blocked ?? []) as Array<{
        string: string; rule: string; chapters: number;
      }>).find((b) => wkey(b.string) === wkey(s));
      const r4 = blocked('DO NOT REPOST');
      expect(r4?.rule).toBe('R4-EDGE');
      expect(r4?.chapters).toBe(3);
      const r1 = blocked('JOIN OUR DISCORD: https://bato.to/discord');
      expect(r1?.rule).toBe('R1-URL');
      expect(r1?.chapters).toBe(3);
      expect(block.domains).toContain('batoto');
      expect(block.matches('DO NOT REPOST')).toBe(true);
      expect(block.matches('JOIN OUR DISCORD: https://bato.to/discord')).toBe(true);
      // shared full-label registry names still fire
      expect(block.matches('Rage Team')).toBe(true);
      expect(block.matches('I HATE THIS WORLD.')).toBe(false);
      expect(block.hash).toMatch(/^[0-9a-f]{16}$/);
      // promotion is idempotent: same corpus -> same hash
      const rebuild = buildBlock(root, outDir, '', false);
      expect(rebuild.hash).toBe(block.hash);
    } finally {
      undone();
      // the v1 tree is untouched
      expect(fsSync.statSync(v1BlockPath).mtimeMs).toBe(v1Mtime);
      expect(fsSync.statSync(v1BlockPath).size).toBe(v1Size);
    }
  });
});

/* ========================================================================== *
 * ingest.ts - validateZipArchive zip-safety
 * ========================================================================== */

describe('ingest: validateZipArchive rejects hostile archives', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTemp('ingest-bad');
  });

  it('rejects missing paths', () => {
    expect(() => validateZipArchive(path.join(dir, 'ghost.zip')))
      .toThrowError(ZipValidationError);
  });

  it('rejects empty (0 byte) archives', () => {
    const p = path.join(dir, 'empty.zip');
    fsSync.writeFileSync(p, Buffer.alloc(0));
    expect(() => validateZipArchive(p)).toThrowError(/ZIP archive is empty/);
  });

  it('rejects a bad magic header before parsing anything', () => {
    const p = path.join(dir, 'magic.zip');
    fsSync.writeFileSync(p, Buffer.from('H4CK', 'ascii'));
    expect(() => validateZipArchive(p))
      .toThrowError(/File is not a valid ZIP archive \(bad magic header\)/);
  });

  it('rejects zip-with-no-entries', () => {
    // starts with PK\x03\x04 and parses, but the central directory declares
    // ZERO entries -> the "no entries" path, not the magic path
    const zipBuf = buildRawZip([{ name: 'orphan.jpg', data: Buffer.from('x') }]);
    const e = zipBuf.length - 22; // EOCD is exactly 22 bytes
    zipBuf.writeUInt16LE(0, e + 8);
    zipBuf.writeUInt32LE(0, e + 12);
    zipBuf.writeUInt32LE(0, e + 16);
    const p = path.join(dir, 'noent.zip');
    fsSync.writeFileSync(p, zipBuf);
    expect(() => validateZipArchive(p)).toThrowError(/contains no entries/);
  });

  it('rejects path traversal entries', () => {
    const p = writeRawZip(dir, 'trav.zip', [{ name: '../evil.jpg' }]);
    expect(() => validateZipArchive(p))
      .toThrowError(/entry contains path traversal \('\.\.'\)/);
  });

  it('rejects backslash path entries', () => {
    const p = writeRawZip(dir, 'back.zip', [{ name: 'evil\\page.jpg' }]);
    expect(() => validateZipArchive(p))
      .toThrowError(/entry contains unsafe backslash path/);
  });

  it('rejects absolute/drive path entries', () => {
    const p = writeRawZip(dir, 'abs.zip', [{ name: '/evil.jpg' }]);
    expect(() => validateZipArchive(p))
      .toThrowError(/uses an absolute or drive path/);
  });

  it('rejects encrypted entries', () => {
    const p = writeRawZip(dir, 'enc.zip', [
      { name: 'p1.jpg', data: Buffer.from('secret bytes'), flags: 0x1, method: 8 },
    ]);
    expect(() => validateZipArchive(p))
      .toThrowError(/contains encrypted entry/);
  });

  it('rejects symlink entries', () => {
    const p = writeRawZip(dir, 'link.zip', [
      { name: 'link.jpg', data: Buffer.from('../..'), mode: 0o120777 },
    ]);
    expect(() => validateZipArchive(p))
      .toThrowError(/contains symbolic link entry/);
  });

  it('rejects absurd compression ratios (zip bombs)', () => {
    const huge = 11 * 1024 * 1024; // > RATIO_MIN_BYTES (10 MiB)
    const p = writeRawZip(dir, 'bomb.zip', [
      { name: 'bomb.jpg', sizeField: huge, compSizeField: 1200, method: 8, flags: 0 },
    ]);
    expect(() => validateZipArchive(p))
      .toThrowError(/exceeds compression ratio limit/);
    expect(MAX_COMPRESSION_RATIO).toBe(200.0);
  });

  it('rejects a nested unsupported archive format next to .cbz', () => {
    const p = writeRawZip(dir, 'rar.zip', [
      { name: 'scene.rar', data: Buffer.from('x') },
    ]);
    expect(() => validateZipArchive(p)).toThrowError(/is not supported/);
  });
});

describe('ingest: extraction of valid archives', () => {
  let dir: string;
  let seriesRootDir: string;
  beforeEach(() => {
    dir = makeTemp('ingest-good');
    seriesRootDir = path.join(dir, 'series');
    fsSync.mkdirSync(seriesRootDir, { recursive: true });
  });

  it('validates and returns stats for a nested .cbz archive', () => {
    const zipPath = makeNestedCbzZip(dir, 'nested.zip');
    const stats = validateZipArchive(zipPath);
    expect(stats.nested_cbz_count).toBe(2);
    expect(stats.total_entries).toBeGreaterThan(0);
    expect(stats.compressed_bytes).toBe(fsSync.statSync(zipPath).size);
  });

  it('extracts nested .cbz chapters in NATURAL chapter order (2 before 10)', () => {
    const zipPath = makeNestedCbzZip(dir, 'nested.zip');
    const slug = 'natural-fan';
    const done = ingest(slug, {
      zipPath,
      seriesRoot: seriesRootDir,
      interactive: false,
    });
    expect(done).toEqual([2, 10]);
    expect(cbzIndex(zipPath)).toEqual({ 2: 'Rage scans_Chapter 2_0.cbz', 10: 'Rage scans_Chapter 10_1.cbz' });
    const ch2 = path.join(seriesRootDir, slug, 'ch2');
    expect(fsSync.readdirSync(ch2).sort()).toEqual(['001.jpg', '002.jpg']);
    // page sort is natural: page 002 -> 001.jpg, page 010 -> 002.jpg
    expect(fsSync.readFileSync(path.join(ch2, '001.jpg'))).toEqual(PAGE_A);
    expect(fsSync.readFileSync(path.join(ch2, '002.jpg'))).toEqual(PAGE_B);
    // ComicInfo <Series> was offered to meta.json
    const meta = JSON.parse(
      fsSync.readFileSync(path.join(seriesRootDir, slug, 'meta.json'), 'utf8'),
    ) as { title?: string; tts?: { engine?: string } };
    expect(meta.title).toBe('Natural Parity');
    expect(meta.tts?.engine).toBe('edge');
    expect(comicTitle(zipPath, 'Rage scans_Chapter 2_0.cbz')).toBe('Natural Parity');
  });

  it('is idempotent: a second run skips complete chapter folders', () => {
    const zipPath = makeNestedCbzZip(dir, 'nested.zip');
    const slug = 'idem-fan';
    ingest(slug, { zipPath, seriesRoot: seriesRootDir, interactive: false });
    const done2 = ingest(slug, { zipPath, seriesRoot: seriesRootDir, interactive: false });
    expect(done2).toEqual([]); // everything was already complete -> nothing re-written
    expect(existingChapterNumbers(path.join(seriesRootDir, slug))).toEqual([2, 10]);
  });

  it('extracts folder-layout ZIPs with natural page ordering and outer ComicInfo', () => {
    const zipPath = makeFolderZip(dir, 'folders.zip');
    const slug = 'folder-fan';
    const done = ingest(slug, {
      zipPath,
      seriesRoot: seriesRootDir,
      interactive: false,
    });
    expect(done).toEqual([3]);
    const ch3 = path.join(seriesRootDir, slug, 'ch3');
    expect(fsSync.readdirSync(ch3).sort()).toEqual(['001.jpg', '002.jpg']);
    expect(fsSync.readFileSync(path.join(ch3, '001.jpg'))).toEqual(PAGE_A); // 2.jpg
    expect(fsSync.readFileSync(path.join(ch3, '002.jpg'))).toEqual(PAGE_B); // 010.jpg
    const meta = JSON.parse(
      fsSync.readFileSync(path.join(seriesRootDir, slug, 'meta.json'), 'utf8'),
    ) as { title?: string };
    expect(meta.title).toBe('Folder Title');
  });

  it('parseChapterSpec expands ranges and rejects junk', () => {
    expect(parseChapterSpec('1-3,5', { 1: 1, 3: 3, 5: 5, 6: 6 })).toEqual([1, 2, 3, 5]);
    expect(parseChapterSpec('all', { 2: 2, 1: 1 })).toEqual([1, 2]);
    expect(parseChapterSpec(null, { 7: 7 })).toEqual([7]);
    expect(() => parseChapterSpec('1x', {})).toThrowError(/invalid literal/);
  });
});

/* ========================================================================== *
 * voicePreview.ts
 * ========================================================================== */

/**
 * Fake external adapter: never touches the network. On --check-auth it prints
 * ok; on a JSON request it copies a real (ffmpeg-generated) MP3 fixture into
 * the requested output path.
 */
function writeFakeAdapter(dir: string, fixtureMp3: string): string {
  const script = path.join(dir, 'fake_tts.js');
  fsSync.writeFileSync(script, `#!/usr/bin/env node
if (process.argv.includes('--check-auth')) {
  process.stdout.write('{"ok":true}');
  process.exit(0);
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw || '{}');
  if (req.output_path) {
    require('node:fs').copyFileSync(${JSON.stringify(fixtureMp3)}, req.output_path);
  }
  process.stdout.write('{"ok":true}');
});
`);
  fsSync.chmodSync(script, 0o755);
  return script;
}

function writeCatalog(dir: string, adapterScript: string, overrides: Record<string, unknown> = {}): string {
  const p = path.join(dir, 'providers.json');
  fsSync.writeFileSync(p, JSON.stringify({
    providers: [
      {
        id: 'grok',
        label: 'Grok Voice',
        engine: 'external',
        provider: 'grok-subscription-tts',
        revision: '1',
        command: ['node', adapterScript],
        language: 'en',
        voices: [
          { id: 'eve', label: 'Eve', default: true },
          { id: 'rex', label: 'Rex' },
        ],
        ...overrides,
      },
    ],
  }));
  return p;
}

describe('voicePreview', () => {
  let root: string;
  let adapterPath: string;
  let fixtureMp3: string;
  beforeAll(() => {
    root = makeTemp('voice-preview');
    fixtureMp3 = path.join(root, 'sine.mp3');
    const r = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
      '-ac', '1', '-ar', '24000', '-b:a', '64k', fixtureMp3,
    ], { timeout: 30000 });
    if (r.status !== 0) {
      throw new Error(`ffmpeg fixture generation failed: ${r.stderr?.toString()}`);
    }
    adapterPath = writeFakeAdapter(root, fixtureMp3);
  });

  function previewEnv(opts: { jobs?: string; catalog?: string; extra?: Record<string, string> } = {}) {
    return {
      MANHWA_JOBS_DIR: opts.jobs ?? path.join(root, 'jobs'),
      MANHWA_TTS_CATALOG: opts.catalog ?? writeCatalog(root, adapterPath),
      PATH: process.env.PATH ?? '',
      ...(opts.extra ?? {}),
    };
  }

  it('probeMp3 accepts the fixture and rejects garbage', () => {
    expect(probeMp3(fixtureMp3)).toBeGreaterThan(0);
    const junk = path.join(root, 'junk.mp3');
    fsSync.writeFileSync(junk, Buffer.from('definitely not audio'));
    expect(probeMp3(junk)).toBe(0);
    expect(probeMp3(path.join(root, 'missing.mp3'))).toBe(0);
  });

  it('cacheKey is stable, order-independent, and rejects junk', () => {
    const a = cacheKey('{"b":2,"a":1}');
    const b = cacheKey('{"a":1,"b":2}');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(cacheKey('{"a":1,"b":3}'));
    expect(() => cacheKey('not json')).toThrowError(PreviewError);
  });

  it('edge cache ids cover the pipeline narration voice payload', () => {
    const payload = pyJsonDumps(
      { engine: 'edge', provider: 'edge', revision: '1', voice: EDGE_VOICE, rate: '+6%' },
      { sortKeys: true, separators: [',', ':'], ensureAscii: false },
    );
    expect(cacheKey(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serves a cached MP3 without any generation call', async () => {
    const env = previewEnv({ jobs: path.join(root, `jobs-cache-${Date.now()}`) });
    const payload = pyJsonDumps(
      { engine: 'edge', provider: 'edge', revision: '1', voice: EDGE_VOICE, rate: '+6%' },
      { sortKeys: true, separators: [',', ':'], ensureAscii: false },
    );
    const id = cacheKey(payload);
    const dir = path.join(env.MANHWA_JOBS_DIR, PREVIEW_DIR_NAME);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, `${id}.mp3`), fsSync.readFileSync(fixtureMp3));
    const res = await generatePreview('edge', EDGE_VOICE, env);
    const blob = JSON.stringify(res);
    expect(res).toEqual({ id, duration: expect.any(Number), cached: true });
    expect(res.duration).toBeGreaterThan(0);
    // contract: {id, duration, cached} ONLY - no paths, no config, no commands
    expect(Object.keys(res).sort()).toEqual(['cached', 'duration', 'id']);
    expect(blob).not.toContain(env.MANHWA_JOBS_DIR);
    expect(blob).not.toContain('command');
  });

  it('cooldown blocks a new voice after uncached generation but cached is free', async () => {
    const env = previewEnv({ jobs: path.join(root, `jobs-cool-${Date.now()}`) });
    const first = await generatePreview('grok', 'eve', env);
    expect(first.cached).toBe(false);

    // miss the cache for a different voice -> bounded-spend cooldown
    await expect(generatePreview('grok', 'rex', env))
      .rejects.toThrowError(PreviewCooldownError);
    try {
      await generatePreview('grok', 'rex', env);
      throw new Error('cooldown should have thrown');
    } catch (err) {
      expect((err as PreviewCooldownError).statusCode).toBe(429);
    }

    // cached request bypasses the cooldown entirely
    const again = await generatePreview('grok', 'eve', env);
    expect(again.cached).toBe(true);
    expect(again.id).toBe(first.id);

    // cooldown is wall-clock bounded: backdate it and generation proceeds
    const cooldownFile = path.join(env.MANHWA_JOBS_DIR, PREVIEW_DIR_NAME, 'cooldown.json');
    const cd = JSON.parse(fsSync.readFileSync(cooldownFile, 'utf8')) as { lastUncachedAt: number };
    expect(cd.lastUncachedAt).toBeLessThanOrEqual(Date.now() / 1000);
    cd.lastUncachedAt = Date.now() / 1000 - 60;
    fsSync.writeFileSync(cooldownFile, JSON.stringify(cd));
    const third = await generatePreview('grok', 'rex', env);
    expect(third.cached).toBe(false);
  });

  it('a held generation lock makes concurrent previews busy (429)', async () => {
    const env = previewEnv({ jobs: path.join(root, `jobs-busy-${Date.now()}`) });
    const ldir = path.join(env.MANHWA_JOBS_DIR, PREVIEW_DIR_NAME);
    fsSync.mkdirSync(ldir, { recursive: true });
    const lp = path.join(ldir, 'generate.lock');
    const fd = fsSync.openSync(lp, fsSync.constants.O_RDWR | fsSync.constants.O_CREAT, 0o664);
    flockFd(fd, 'ex');
    try {
      await expect(generatePreview('grok', 'eve', env))
        .rejects.toThrowError(PreviewBusyError);
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it('provider config change produces a distinct cache id; missing adapter fails preflight', async () => {
    const catalog = writeCatalog(root, adapterPath, { revision: '1' });
    const env = previewEnv({ jobs: path.join(root, `jobs-cfg-${Date.now()}`), catalog });
    const eveA = await generatePreview('grok', 'eve', env);
    // revision bump -> different cache id (cooldown backdated so it can run)
    writeCatalog(root, adapterPath, { revision: '2' });
    const cd = path.join(env.MANHWA_JOBS_DIR, PREVIEW_DIR_NAME, 'cooldown.json');
    fsSync.writeFileSync(cd, JSON.stringify({ lastUncachedAt: Date.now() / 1000 - 60 }));
    const eveB = await generatePreview('grok', 'eve', env);
    expect(eveB.id).not.toBe(eveA.id);
  });

  it('rejects unknown providers, eleven/gsk, and unknown voices', async () => {
    const env = previewEnv({ jobs: path.join(root, `jobs-bad-${Date.now()}`) });
    await expect(generatePreview('nope', 'eve', env)).rejects.toThrowError(/Unknown TTS provider/);
    await expect(generatePreview('eleven', 'sam', env)).rejects.toThrowError(/not available/);
    await expect(generatePreview('', 'eve', env)).rejects.toThrowError(/provider is required/i);
    await expect(generatePreview('grok', 'nope-voice', env)).rejects.toThrowError(/not in server catalog/);
  });

  it('broken adapter command surfaces as preflight failure', async () => {
    const catalog = writeCatalog(root, path.join(root, 'missing-adapter.js'));
    const env = previewEnv({ jobs: path.join(root, `jobs-broken-${Date.now()}`), catalog });
    await expect(generatePreview('grok', 'eve', env)).rejects.toThrowError(PreflightError);
  });
});

/* ========================================================================== *
 * intake.ts - validation + URL/SSRF safety + catalog + job queue
 * ========================================================================== */

describe('intake: slug + chapter validation', () => {
  it('slugify produces url-safe slugs', () => {
    expect(slugify('My Dragon!  Girlfriend.ZIP')).toBe('my-dragon-girlfriend');
    expect(slugify('A--B')).toBe('a-b');
    expect(slugify('')).toBe('');
  });

  it('validateSlug rejects short, uppercase, path, reserved slugs', () => {
    expect(validateSlug('ok-slug-1')).toBe('ok-slug-1');
    expect(() => validateSlug('a')).toThrowError(/between 2 and 64/);
    expect(validateSlug('x'.repeat(64))).toBe('x'.repeat(64));
    expect(() => validateSlug('x'.repeat(65))).toThrowError(/between 2 and 64/);
    expect(() => validateSlug('Not-Lower')).toThrowError(/Invalid series slug/);
    expect(() => validateSlug('../../evil')).toThrowError(/Invalid series slug/);
    expect(() => validateSlug('-lead')).toThrowError(/Invalid series slug/);
    // note: the active check happens before the regex in v2
    expect(() => validateSlug('out')).toThrowError(/is reserved/);
    // non-string input
    expect(() => validateSlug(null)).toThrowError(/Series slug is required/);
  });

  it('validateChaptersSpec accepts the documented grammar', () => {
    expect(validateChaptersSpec('all')).toBe('all');
    expect(validateChaptersSpec('1,2 ,3')).toBe('1,2,3');
    expect(validateChaptersSpec('1-5')).toBe('1-5');
    expect(validateChaptersSpec('2-5,7')).toBe('2-5,7');
    expect(() => validateChaptersSpec('frogs')).toThrowError(/Invalid chapters specification/);
    expect(() => validateChaptersSpec('0')).toThrowError(/Invalid chapter number/);
    expect(() => validateChaptersSpec('5-2')).toThrowError(/Invalid chapter range/);
    expect(() => validateChaptersSpec('1-502')).toThrowError(/Invalid chapter range/);
    expect(() => validateChaptersSpec('5001')).toThrowError(/Invalid chapter number/);
  });
});

describe('intake: parseGdriveUrl hardening', () => {
  it('accepts file links and derives canonical/download urls', () => {
    const r = parseGdriveUrl('https://drive.google.com/file/d/1aBcDeFgHi-_0123456789/view?usp=sharing');
    expect(r.fileId).toBe('1aBcDeFgHi-_0123456789');
    expect(r.canonicalUrl).toBe('https://drive.google.com/file/d/1aBcDeFgHi-_0123456789/view');
    expect(r.downloadUrl).toBe('https://drive.google.com/uc?export=download&id=1aBcDeFgHi-_0123456789');
  });

  it('accepts the /open | /uc | /download?id= forms', () => {
    expect(parseGdriveUrl('https://drive.google.com/open?id=FILEID12345').fileId).toBe('FILEID12345');
    expect(parseGdriveUrl('https://drive.google.com/uc?id=FILEID12345').fileId).toBe('FILEID12345');
    expect(parseGdriveUrl('https://drive.usercontent.google.com/download?id=FILEID12345').fileId).toBe('FILEID12345');
  });

  it('rejects non-https, credentials, ports, folders, docs, hosts, bad ids', () => {
    expect(() => parseGdriveUrl('http://drive.google.com/file/d/FILEID12345/view')).toThrowError(/must use https/);
    expect(() => parseGdriveUrl('https://user:pw@drive.google.com/file/d/FILEID12345/view'))
      .toThrowError(/embedded credentials/);
    expect(() => parseGdriveUrl('https://drive.google.com:8443/file/d/FILEID12345/view'))
      .toThrowError(/Non-standard port/);
    expect(() => parseGdriveUrl('https://evil.example.com/file/d/FILEID12345/view'))
      .toThrowError(/Only Google Drive file links/);
    expect(() => parseGdriveUrl('https://drive.google.com/drive/folders/FILEID12345'))
      .toThrowError(/folder links are not supported/);
    expect(() => parseGdriveUrl('https://docs.google.com/document/d/FILEID12345/edit'))
      .toThrowError(/Docs\/Sheets\/Slides/);
    expect(() => parseGdriveUrl('https://drive.google.com/file/d/has$dots/view'))
      .toThrowError(/Could not extract a valid Google Drive file ID/);
    expect(() => parseGdriveUrl('   ')).toThrowError(/required/i);
    expect(() => parseGdriveUrl('not a url at all')).toThrowError(/Malformed URL/);
  });
});

describe('intake: downloadGdriveZip stall timeout', () => {
  const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const publicResolver = () => ['8.8.8.8'];

  /** Fake fetch whose body streams `chunks` and honours the request signal the
   *  way undici does: aborting rejects the pending read with a TimeoutError. */
  function fakeFetch(chunks: Buffer[], gapMs: number, stallAfter?: number): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
          let aborted = false;
          const onAbort = () => {
            aborted = true;
          };
          signal?.addEventListener('abort', onAbort);
          try {
            for (let i = 0; i < chunks.length; i++) {
              if (stallAfter != null && i === stallAfter) {
                while (!aborted) await sleep(5);
              }
              if (aborted) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
              controller.enqueue(new Uint8Array(chunks[i]!));
              if (i < chunks.length - 1) await sleep(gapMs);
            }
            controller.close();
          } catch (err) {
            try {
              controller.error(err);
            } catch {
              // stream already closed
            }
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/zip' } });
    }) as typeof fetch;
  }

  it('keeps streaming past a short timeoutS as long as chunks keep arriving', async () => {
    const dir = makeTemp('gdrive-stream-');
    const dest = path.join(dir, 'series.zip');
    const chunks = [
      ZIP_HEAD,
      ...Array.from({ length: 7 }, (_, i) => Buffer.from([i, i, i, i])),
    ];
    // 8 chunks, 20ms apart (~140ms total) with a 50ms inactivity timeout: the
    // old single AbortSignal.timeout() would have killed this mid-download.
    const res = await downloadGdriveZip('1AbCdEfGhIjKlMnOpQrStUvWxYz', dest, {
      timeoutS: 0.05,
      resolver: publicResolver,
      fetchImpl: fakeFetch(chunks, 20),
    });
    expect(res.bytes).toBe(32);
    expect(fsSync.readFileSync(dest)).toEqual(Buffer.concat(chunks));
  });

  it('aborts with IntakeError when the stream stalls past timeoutS', async () => {
    const dir = makeTemp('gdrive-stall-');
    const dest = path.join(dir, 'series.zip');
    const err = await downloadGdriveZip('1AbCdEfGhIjKlMnOpQrStUvWxYz', dest, {
      timeoutS: 0.05,
      resolver: publicResolver,
      fetchImpl: fakeFetch([ZIP_HEAD, Buffer.from([1, 2, 3, 4])], 10, 1),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntakeError);
    expect(String((err as Error).message)).toMatch(/Google Drive download timed out/);
    expect(fsSync.existsSync(dest)).toBe(false);
  });
});

describe('intake: SSRF private IP rejection', () => {
  it('isBlockedPublicIp covers the RFC1918/loopback/link-local/cg-nat blocklist', () => {
    for (const blocked of [
      '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.7',
      '0.0.0.0', '169.254.169.254', '100.64.0.1', '192.0.2.9', '198.51.100.7',
      '203.0.113.9', '224.0.0.5', '240.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::7', 'fd12:3456::1', 'ff02::1',
      '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.3',
    ]) {
      expect(isBlockedPublicIp(blocked), blocked).toBe(true);
    }
    for (const allowed of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1']) {
      expect(isBlockedPublicIp(allowed), allowed).toBe(false);
    }
    expect(isBlockedPublicIp('not-an-ip')).toBe(true);
    expect(isBlockedPublicIp('')).toBe(true);
  });

  it('verifyHostPublicIp refuses private DNS answers', async () => {
    // resolver is called SYNCHRONOUSLY (no await); an async stub would return
    // a Promise and collapse to a "no addresses" error
    await expect(verifyHostPublicIp('internal.net', 443, () => ['10.1.2.3']))
      .rejects.toThrowError(/Blocked non-public IP address \(10\.1\.2\.3\)/);
    await expect(verifyHostPublicIp('multi.net', 443, () => ['8.8.8.8', '192.168.0.2']))
      .rejects.toThrowError(/192\.168\.0\.2/);
    // a public answer passes
    await expect(verifyHostPublicIp('public.net', 443, () => ['8.8.8.8']))
      .resolves.toEqual(['8.8.8.8']);
    await expect(verifyHostPublicIp('noanswer.net', 443, () => []))
      .rejects.toThrowError(/no addresses/);
  });

  it('validateDownloadTargetUrl: allowlist + https + SSRF resolver', async () => {
    const publicResolver = () => ['8.8.8.8'];
    // disallowed host
    await expect(validateDownloadTargetUrl('https://evil.example.com/x', publicResolver))
      .rejects.toThrowError(/Disallowed download\/redirect host/);
    // allowed google hosts with a private resolver answer are blocked
    await expect(validateDownloadTargetUrl('https://drive.google.com/uc?x=1', () => ['127.0.0.1']))
      .rejects.toThrowError(/Blocked non-public IP/);
    // .googleusercontent.com suffix stays allowed
    await expect(validateDownloadTargetUrl(
      'https://doc-00-3k-docs.googleusercontent.com/x', publicResolver,
    )).resolves.toBeTruthy();
    // login walls / non-https / credentials / ports
    await expect(validateDownloadTargetUrl('https://accounts.google.com/ServiceLogin', publicResolver))
      .rejects.toThrowError(/private or requires sign-in/);
    await expect(validateDownloadTargetUrl('http://drive.google.com/x', publicResolver))
      .rejects.toThrowError(/must use https/);
    await expect(validateDownloadTargetUrl('https://u:p@drive.google.com/x', publicResolver))
      .rejects.toThrowError(/credentials/);
    // malformed URL
    await expect(validateDownloadTargetUrl('::::', publicResolver))
      .rejects.toThrowError(/Invalid download URL/);
  });
});

describe('intake: TTS catalog resolution', () => {
  let root: string;
  let adapterPath: string;
  beforeAll(() => {
    root = makeTemp('intake-catalog');
    adapterPath = writeFakeAdapter(root, path.join(root, 'unused.mp3'));
  });

  function catEnv(catalogPath?: string): Record<string, string> {
    return {
      MANHWA_TTS_CATALOG: catalogPath ?? writeCatalog(root, adapterPath),
      PATH: process.env.PATH ?? '',
    };
  }

  it('always contains edge and parses external catalog entries', () => {
    const providers = loadRawTtsProviders(catEnv());
    expect(providers[0]?.id).toBe('edge');
    expect(providers.map((p) => p.id)).toContain('grok');
    const grok = providers.find((p) => p.id === 'grok')!;
    expect(grok.engine).toBe('external');
    expect(grok.voices.map((v) => v.default)).toContain(true);
    expect(grok.preflightArgs).toEqual(['--check-auth']);
  });

  it('a broken explicit catalog is a preflight error, defaults are silent', () => {
    const broken = path.join(root, 'broken.json');
    fsSync.writeFileSync(broken, '{nope');
    expect(() => loadRawTtsProviders(catEnv(broken))).toThrowError(/Failed to load MANHWA_TTS_CATALOG/);
  });

  it('resolveTtsSelection returns full public selection for valid input', async () => {
    const sel = await resolveTtsSelection('grok', 'rex', undefined, catEnv());
    expect(sel.providerId).toBe('grok');
    expect(sel.engine).toBe('external');
    expect(sel.voiceId).toBe('rex');
    expect((sel.metaTts as Record<string, unknown>).voice_id).toBe('rex');
    // a missing voice id picks the catalog default
    const def = await resolveTtsSelection('grok', '', undefined, catEnv());
    expect(def.voiceId).toBe('eve');
  });

  it('rejects unknown providers, eleven/gsk, and off-catalog voices', async () => {
    const env = catEnv();
    await expect(resolveTtsSelection('nope', undefined, undefined, env))
      .rejects.toThrowError(/Unknown TTS provider/);
    await expect(resolveTtsSelection('eleven', 'sam', undefined, env))
      .rejects.toThrowError(/ElevenLabs\/GSK TTS is not available|not available/);
    await expect(resolveTtsSelection('elevenlabs', 'sam', undefined, env))
      .rejects.toThrowError(/not available/);
    await expect(resolveTtsSelection('gsk', 'sam', undefined, env))
      .rejects.toThrowError(/not available/);
    await expect(resolveTtsSelection('grok', 'nope', undefined, env))
      .rejects.toThrowError(/not in server catalog/);
  });

  it('getCatalog exposes providers, limits and the spending notice', async () => {
    const cat = await getCatalog(undefined, catEnv());
    expect(cat.schemaVersion).toBe(1);
    expect(cat.defaultProvider).toBe('edge');
    expect(cat.providers.map((p) => p.id)).toEqual(expect.arrayContaining(['edge', 'grok']));
    expect(cat.limits.maxZipBytes).toBeGreaterThan(0);
    expect(cat.spendingNotice).toMatch(/quota/i);
    expect(cat.capabilities).toHaveProperty('jobActions.retry');
  });
});

// ---------------------------------------------------------------------------
// job queue scaffolding: an isolated jobs dir + series root + zip fixtures
// ---------------------------------------------------------------------------

function makeIntakeEnv(tmp: string, CatalogPath?: string): Record<string, string> {
  return {
    MANHWA_JOBS_DIR: path.join(tmp, 'jobs'),
    MANHWA_SERIES_ROOT: path.join(tmp, 'series'),
    MANHWA_TTS_CATALOG: CatalogPath ?? DEFAULT_EDGE_ONLY_CATALOG(tmp),
    MANHWA_NO_AUTO_WORKER: '1',
    PATH: process.env.PATH ?? '',
  };
}

/** edge-only catalog -> zero external adapter preflights in queue tests. */
let edgeCatalogCounter = 0;
function DEFAULT_EDGE_ONLY_CATALOG(tmp: string): string {
  const p = path.join(tmp, `catalog-edge-${++edgeCatalogCounter}.json`);
  fsSync.writeFileSync(p, JSON.stringify({ providers: [] }));
  return p;
}

interface CraftPatch extends Record<string, unknown> { status?: string; slug?: string }

function craftJob(env: Record<string, string>, patch: CraftPatch = {}): { id: string; file: string } {
  const jdir = jobsDir(env as never);
  fsSync.mkdirSync(jdir, { recursive: true });
  const id = `job-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const now = Date.now() / 1000;
  const record = {
    schemaVersion: 1,
    id,
    slug: patch.slug ?? 'crafted-fan',
    title: 'Crafted Fan',
    status: patch.status ?? 'failed',
    statusNote: '',
    sourceType: 'local_zip',
    sourceSummary: 'Local ZIP (fixture.zip)',
    gdriveFileId: null,
    stagedZipPath: null,
    chapters: '1',
    ingestedChapters: [],
    tts: {
      providerId: 'edge',
      providerLabel: 'Edge TTS (Free, Default)',
      engine: 'edge',
      voiceId: 'en-US-AndrewMultilingualNeural',
      voiceLabel: 'Andrew Multilingual',
      metaTts: { engine: 'edge' },
    },
    visuals: { background: 'starfield', motion: 'cut' },
    renderLane: 'inherit',
    createdBy: 'tests',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: now,
    workerPid: null,
    workerStartTicks: null,
    runPid: null,
    runStartTicks: null,
    error: 'boom',
    logTail: [],
    ...patch,
  };
  const file = path.join(jdir, `${id}.json`);
  fsSync.writeFileSync(file, JSON.stringify(record, null, 2));
  return { id, file };
}

describe('intake: job enqueue / list / status', () => {
  let tmp: string;
  let env: Record<string, string>;
  let zipPath: string;
  beforeAll(() => {
    tmp = makeTemp('intake-jobs');
    env = makeIntakeEnv(tmp);
    zipPath = makeNestedCbzZip(tmp, 'enqueue-fixture.zip');
  });

  it('enqueueJob validates and queues a local ZIP (no source spam)', async () => {
    const view = await enqueueJob({
      title: 'Enqueue Fan',
      slug: 'enqueue-fan',
      zipPath,
      env: env as never,
      spawnWorker: false,
    });
    expect(view.status).toBe('queued');
    expect(view.stage).toBe('queued');
    expect(view.id).toMatch(/^job-\d+-[a-f0-9]+$/);
    expect(view.slug).toBe('enqueue-fan');
    expect(view.sourceType).toBe('local_zip');
    expect((view.tts as Record<string, unknown>).providerId).toBe('edge');
    expect(view.actions).toEqual([]);
  });

  it('getJob/status + listJobs surface the persisted job', () => {
    const listed = listJobs({ includeLogs: false, env: env as never });
    const jobs = listed.jobs as Array<Record<string, unknown>>;
    expect(jobs.some((j) => (j.slug as string) === 'enqueue-fan')).toBe(true);
    const ref = jobs.find((j) => (j.slug as string) === 'enqueue-fan')!;
    const got = getJob(ref.id as string, { env: env as never });
    expect(got.status).toBe('queued');
  });

  it('gdrive enqueue stores the parsed file id without downloading', async () => {
    const view = await enqueueJob({
      title: 'Gdrive Fan',
      slug: 'gdrive-fan',
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      env: env as never,
      spawnWorker: false,
    });
    expect(view.sourceType).toBe('gdrive');
    expect(view.sourceSummary).toMatch(/file ID: FILEIDabcdef12/);
  });

  it('enqueue rejects: both sources, no source, bad chapters, bad presets, dup slug', async () => {
    await expect(enqueueJob({ env: env as never })).rejects.toThrowError(/or a ZIP archive is required/);
    await expect(enqueueJob({
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      zipPath,
      env: env as never,
    })).rejects.toThrowError(/not both/);

    await expect(enqueueJob({
      slug: 'bad-chapter-fan', zipPath, chapters: 'frogs', env: env as never,
    })).rejects.toThrowError(/Invalid chapters specification/);
    await expect(enqueueJob({
      slug: 'missing-chapter-fan', zipPath, chapters: '77-80', env: env as never,
    })).rejects.toThrowError(/not present in ZIP archive/);
    await expect(enqueueJob({
      slug: 'bad-bg-fan', zipPath, background: 'nope-bg', env: env as never,
    })).rejects.toThrowError(/Unknown background preset/);
    await expect(enqueueJob({
      slug: 'bad-motion-fan', zipPath, motion: 'wiggle', env: env as never,
    })).rejects.toThrowError(/Unknown motion preset/);

    // duplicate slug can never overwrite an existing series dir
    fsSync.mkdirSync(path.join(seriesRoot(env as never), 'enqueue-fan'), { recursive: true });
    await expect(enqueueJob({
      slug: 'enqueue-fan', zipPath, env: env as never, spawnWorker: false,
    })).rejects.toThrowError(ConflictError);
  });

  it('retry of an active queued job conflicts with the live work', async () => {
    const listed = listJobs({ includeLogs: false, env: env as never });
    const job = (listed.jobs as Array<Record<string, unknown>>).find(
      (j) => (j.slug as string) === 'enqueue-fan',
    ) as { id: string };
    // retryJob is SYNCHRONOUS -- it throws at call time, not via a rejection
    expect(() => retryJob(job.id, { env: env as never, spawnWorker: false }))
      .toThrowError(ConflictError);
  });
});

describe('intake: retry / continue reconciliation', () => {
  let tmp: string;
  let env: Record<string, string>;
  let zipPath: string;
  beforeEach(() => {
    tmp = makeTemp(`intake-retry-${Date.now()}`);
    env = makeIntakeEnv(tmp);
    zipPath = makeNestedCbzZip(tmp, 'resume-fixture.zip');
  });

  function seedExtractedChapters(slug: string, chapters: number[]): void {
    const sdir = path.join(seriesRoot(env as never), slug);
    for (const n of chapters) {
      fsSync.mkdirSync(path.join(sdir, `ch${n}`), { recursive: true });
      fsSync.writeFileSync(path.join(sdir, `ch${n}`, '001.jpg'), PAGE_A);
    }
  }

  it('retry resumes extracted chapters without re-import (skipIngest)', async () => {
    seedExtractedChapters('resume-fan', [1]);
    const staged = path.join(tmp, 'retained.zip');
    fsSync.copyFileSync(zipPath, staged);
    const { id } = craftJob(env as never, {
      slug: 'resume-fan',
      status: 'failed',
      stagedZipPath: staged,
      chapters: '1',
    });
    const view = retryJob(id, { env: env as never, spawnWorker: false } as never);
    expect(view.status).toBe('queued');
    expect(view.statusNote).toMatch(/resuming/i);
    const persisted = JSON.parse(fsSync.readFileSync(
      path.join(jobsDir(env as never), `${id}.json`), 'utf8',
    )) as Record<string, unknown>;
    expect(persisted.skipIngest).toBe(true);
    expect(persisted.retryCount).toBe(1);
    expect(persisted.lastAction).toBe('retry');
  });

  it('retry re-extracts missing chapters from the retained ZIP', async () => {
    seedExtractedChapters('missing-fan', [1]);
    const staged = path.join(tmp, 'retained.zip');
    fsSync.copyFileSync(zipPath, staged);
    const { id } = craftJob(env as never, {
      slug: 'missing-fan',
      status: 'failed',
      stagedZipPath: staged,
      chapters: '2',
    });
    const view = retryJob(id, { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    const persisted = JSON.parse(fsSync.readFileSync(
      path.join(jobsDir(env as never), `${id}.json`), 'utf8',
    )) as Record<string, unknown>;
    expect(persisted.skipIngest).toBe(false);
    expect(persisted.runChapters).toEqual([2]);
    expect(persisted.allowExistingSeries).toBe(true);
  });

  it('retry without source or pages is actionable, not fatal', async () => {
    const { id } = craftJob(env as never, { slug: 'gone-fan', status: 'failed', stagedZipPath: null });
    expect(() => retryJob(id, { env: env as never, spawnWorker: false }))
      .toThrowError(/cannot be retried|cannot resume/);
  });

  it('retry refuses a malformed legacy chapter spec', async () => {
    seedExtractedChapters('badspec-fan', [1]);
    const { id } = craftJob(env as never, {
      slug: 'badspec-fan', status: 'failed', chapters: 'cancer',
    });
    expect(() => retryJob(id, { env: env as never, spawnWorker: false }))
      .toThrowError(/unreadable chapter selection/);
  });

  it('retry rejects completed and inactive-job states', async () => {
    const { id } = craftJob(env as never, { slug: 'queued-fan', status: 'queued' });
    expect(() => retryJob(id, { env: env as never, spawnWorker: false }))
      .toThrowError(ConflictError);
  });

  it('continue adds chapters to an existing series without a new series', async () => {
    seedExtractedChapters('continue-fan', [1]);
    const { id } = craftJob(env as never, { slug: 'continue-fan', status: 'completed' });
    const view = continueJob(id, '1', { env: env as never, spawnWorker: false });
    expect(view.status).toBe('queued');
    expect(view.statusNote).toMatch(/Continue queued/);
    expect(view.actions).toEqual([]); // queued is not retry-able until it runs
    const persisted = JSON.parse(fsSync.readFileSync(
      path.join(jobsDir(env as never), `${id}.json`), 'utf8',
    )) as Record<string, unknown>;
    expect(persisted.runChapters).toEqual([1]);
    expect(persisted.skipIngest).toBe(true);
    expect(persisted.lastAction).toBe('continue');
  });

  it('continue refuses when the series never ingested', async () => {
    const { id } = craftJob(env as never, { slug: 'never-fan', status: 'completed' });
    expect(() => continueJob(id, '1', { env: env as never, spawnWorker: false }))
      .toThrowError(/does not exist yet/);
  });

  it('continue refuses a selection that exists nowhere', async () => {
    seedExtractedChapters('absent-fan', [1]);
    const { id } = craftJob(env as never, {
      slug: 'absent-fan', status: 'completed', stagedZipPath: null,
    });
    expect(() => continueJob(id, '5', { env: env as never, spawnWorker: false }))
      .toThrowError(/not extracted yet and the source ZIP is no longer available|neither extracted/);
  });

  it('getJob validates the id shape and missing jobs', () => {
    expect(() => getJob('$$garbage', { env: env as never })).toThrowError(/Invalid job ID/);
    expect(() => getJob('job-1-deadbeef', { env: env as never })).toThrowError(/Job not found/);
  });

  it('reconcile marks a dead worker job interrupted without auto-rerun', () => {
    const { id } = craftJob(env as never, {
      slug: 'deadpid-fan',
      status: 'running',
      workerPid: 999_999_998,
      workerStartTicks: null,
      runPid: null,
    });
    const jobs = reconcileJobs(env as never);
    const got = jobs.find((j) => String(j.id) === id) as Record<string, unknown>;
    expect(got.status).toBe('interrupted');
    expect(String(got.statusNote)).toMatch(/Interrupted/);
  });

  it('orphan uploads reconcile is safe (referenced kept, stale .part removed)', () => {
    const jdir = jobsDir(env as never);
    const uploads = path.join(jdir, 'uploads');
    fsSync.mkdirSync(uploads, { recursive: true });
    // referenced
    const held = path.join(uploads, 'held.zip');
    fsSync.writeFileSync(held, Buffer.from('held'));
    craftJob(env as never, {
      slug: 'held-fan', status: 'failed', stagedZipPath: held,
    });
    // stale orphans
    const orphan = path.join(uploads, 'orphan.zip');
    fsSync.writeFileSync(orphan, Buffer.from('old'));
    const part = path.join(uploads, 'orphan2.zip.part');
    fsSync.writeFileSync(part, Buffer.from('old'));
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fsSync.utimesSync(orphan, old, old);
    fsSync.utimesSync(part, old, old);
    // fresh (recent) orphan stays
    const fresh = path.join(uploads, 'fresh.zip');
    fsSync.writeFileSync(fresh, Buffer.from('new'));

    const res = reconcileOrphans(env as never, false) as {
      scanned: number; removed: string[]; kept: string[];
    };
    expect(res.removed).toEqual(expect.arrayContaining(['orphan.zip', 'orphan2.zip.part']));
    expect(res.removed).not.toContain('held.zip');
    expect(res.kept).toContain('held.zip');
    expect(res.kept).toContain('fresh.zip');
    expect(fsSync.existsSync(orphan)).toBe(false);
    expect(fsSync.existsSync(part)).toBe(false);
    expect(fsSync.existsSync(held)).toBe(true);
    expect(fsSync.existsSync(fresh)).toBe(true);
    // dry run never deletes
    const dry = reconcileOrphans(env as never, true) as { removed: string[] };
    expect(dry.removed.length).toBe(0);
  });

  it('public job view reports stage + progress + sanitized error', () => {
    const { id } = craftJob(env as never, {
      slug: 'view-fan',
      status: 'failed',
      error: `leaked password=hunter2 ${'x'.repeat(600)}`,
      progress: { phase: 'extract', loadedBytes: 12_345, totalBytes: 100_000 },
    });
    const view = getJob(id, { env: env as never });
    expect(view.stage).toBe('stopped');
    const progress = view.progress as Record<string, unknown>;
    expect(progress.percent).toBe(12);
    // sanitizeText scrubs secret-shaped assignments but keeps the key prefix
    const errStr = String(view.error);
    expect(errStr).toContain('password=');
    expect(errStr).toContain('[REDACTED]');
    expect(errStr).not.toContain('hunter2');
  });
});
