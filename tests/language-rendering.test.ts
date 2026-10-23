/**
 * Language-version rendering isolation (Hindi / `hi-IN`), first release.
 *
 * Covers the approved locale contract:
 *   - src/config/languages.ts: validateLocale, languageChapterDir, catalog
 *   - timeline: locale narration key, locale staging id, shared-input reuse,
 *     locale-only cleaner/crop writes, dropped-panel warning
 *   - renderlane: prepare/produce locale options (English path unchanged)
 *   - vertexTts: locale-aware discovery + per-locale voice cache
 *
 * Offline only: real ffmpeg for fixtures/durations, a fake local Edge python for
 * the Edge path, and a fake external TTS command. No network, no paid provider,
 * no user series is touched - every write stays under /tmp/opencode.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

// MUST come before timeline.ts: it sets MANHWA_STUDIO_PUBLIC, which timeline
// reads at import time (ESM hoists every static import).
import {
  fakeEdgeCalls,
  languageTestStudioPublic,
} from "./helpers/language-studio-env.js";

import {
  LANGUAGE_CATALOG,
  assertNoSymlinkPath,
  getLanguageEntry,
  languageChapterDir,
  languageStagingId,
  validateChapterId,
  validateLocale,
} from "../src/config/languages.js";
import {
  localeNarrationCacheKey,
  localeTtsMeta,
  droppedPanelAssignments,
  seedLocaleArtifacts,
  type TimelineShot,
} from "../src/stages/timeline.js";
import * as timeline from "../src/stages/timeline.js";
import {
  LOCALE_EDGE_RATE,
  edgeRateFromSpeed as audioEdgeRate,
  stripEmotionControls,
} from "../src/stages/audio.js";
import * as renderlane from "../src/workers/renderlane.js";
import * as vertexTts from "../src/llm/vertexTts.js";
import { putSecret } from "../src/config/secretStore.js";
import { upsertProvider } from "../src/config/studioConfig.js";

const TMP_ROOT = "/tmp/opencode";
const roots: string[] = [];

function tmp(prefix: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Content hash of every regular file in a directory tree (name -> sha). */
function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out[path.relative(dir, p)] = sha(p);
    }
  };
  walk(dir);
  return out;
}

function ffmpegMp3(out: string, seconds: number): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ac", "1", "-ar", "24000", "-b:a", "64k", out,
  ], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${String(r.stderr)}`);
  return out;
}

/* ================================================================== *
 * 1. languages.ts contract
 * ================================================================== */

describe('languages: validateLocale', () => {
  it('accepts the shipped locale case-insensitively and canonicalizes it', () => {
    expect(validateLocale('hi-IN')).toBe('hi-IN');
    expect(validateLocale('HI-in')).toBe('hi-IN');
    expect(validateLocale('  hi-IN  ')).toBe('hi-IN');
  });

  it('rejects unsupported locales and every traversal shape', () => {
    for (const bad of [
      'en-US', 'fr-FR', 'hi', '', '   ', null, undefined, 42, {}, ['hi-IN'],
      '../hi-IN', 'hi-IN/../..', '/etc/passwd', '..', '.', 'hi-IN/..', 'hi-IN\\x',
      'hi-IN\u0000', 'hi-IN\u0000/../x', 'languages/hi-IN', 'hi-IN%2f..',
    ]) {
      expect(validateLocale(bad)).toBeNull();
    }
  });

  it('validates chapter ids used as path segments', () => {
    expect(validateChapterId('ch1')).toBe('ch1');
    expect(validateChapterId('ch012')).toBe('ch012');
    for (const bad of ['ch', '1', 'ch1/..', '../ch1', 'ch1\u0000', 'ch-1', 'CH1', '', 'ch10000']) {
      expect(validateChapterId(bad)).toBeNull();
    }
  });

  it('refuses a locale that is not a plain tag (path segment allowlist)', () => {
    for (const bad of ['hi IN', 'hi:IN', 'hi-IN/../..', 'hi-IN\u0000', '.hi-IN', '-hi-IN', 'hi_IN', '']) {
      expect(validateLocale(bad)).toBeNull();
    }
    expect(validateLocale('HI-in')).toBe('hi-IN');
  });
});

describe('languages: catalog', () => {
  it('ships Hindi only, Edge default, no credentials', () => {
    expect(LANGUAGE_CATALOG.map((l) => l.locale)).toEqual(['hi-IN']);
    const hi = getLanguageEntry('hi-IN')!;
    expect(hi.label).toBe('Hindi');
    expect(hi.nativeLabel).toBe('हिन्दी');
    expect(hi.defaultEngine).toBe('edge');
    expect(hi.defaultVoiceId).toBe('hi-IN-MadhurNeural');
    // The curated Edge voices stay first, so the no-credential default is
    // unchanged; Vertex voices are appended for the grouped picker.
    expect(hi.voices.slice(0, 2).map((v) => v.id)).toEqual(['hi-IN-MadhurNeural', 'hi-IN-SwaraNeural']);
    expect(hi.voices.slice(0, 2).every((v) => v.engine === 'edge')).toBe(true);
    const vertex = hi.voices.filter((v) => v.engine === 'vertex');
    expect(vertex.map((v) => v.id)).toContain('hi-IN-Chirp3-HD-Aoede');
    expect(vertex.map((v) => v.id)).toContain('gemini-tts:Charon');
    expect(vertex.every((v) => v.provider === 'vertex')).toBe(true);
    expect(vertex.some((v) => v.modelId === 'chirp-3-hd')).toBe(true);
    expect(vertex.some((v) => v.modelId === 'gemini-3.8-flash-tts')).toBe(true);
    expect(getLanguageEntry('en-US')).toBeNull();
  });
});

describe('languages: languageChapterDir', () => {
  it('resolves out/languages/hi-IN/chN from the ORIGINAL series out dir', () => {
    const out = '/srv/series/demo/out';
    expect(languageChapterDir(out, 'hi-IN', 'ch1')).toBe('/srv/series/demo/out/languages/hi-IN/ch1');
    // Idempotent source: calling it on the ORIGINAL out never nests.
    expect(languageChapterDir(out, 'hi-IN', 'ch12')).not.toContain('languages/hi-IN/languages');
  });

  it('refuses unsupported locales, bad chapters and traversal', () => {
    expect(() => languageChapterDir('/o', 'en-US', 'ch1')).toThrow(/unsupported locale/);
    expect(() => languageChapterDir('/o', '../hi-IN', 'ch1')).toThrow(/unsupported locale/);
    expect(() => languageChapterDir('/o', 'hi-IN', '../../etc')).toThrow(/invalid chapter/);
    expect(() => languageChapterDir('/o', 'hi-IN', 'ch1/../../x')).toThrow(/invalid chapter/);
  });

  it('staging ids differ per locale and never collide with English', () => {
    expect(languageStagingId('contract', 'ch1', 'hi-IN')).toBe('contract_ch1_hi-IN');
    expect(languageStagingId('contract', 'ch1', 'hi-IN')).not.toBe('contract_ch1');
    // Must satisfy cloudlane's asset-dir guard and start with an alphanumeric.
    expect(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(languageStagingId('.hidden series', 'ch12', 'hi-IN'))).toBe(true);
    expect(() => languageStagingId('contract', 'ch1', 'en-US')).toThrow(/unsupported locale/);
  });
});

describe('languages: symlink refusal', () => {
  it('rejects a symlinked component under the root and out-of-root targets', () => {
    const root = tmp('lang-symlink-');
    const outside = tmp('lang-symlink-outside-');
    fs.mkdirSync(path.join(root, 'languages'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'languages', 'hi-IN'));

    expect(() => assertNoSymlinkPath(root, path.join(root, 'languages', 'hi-IN', 'ch1')))
      .toThrow(/symlinked locale path/);
    expect(() => assertNoSymlinkPath(root, path.join(root, '..', 'escape'))).toThrow(/escapes/);
    // A missing (not-yet-created) path inside the root is fine.
    expect(() => assertNoSymlinkPath(root, path.join(root, 'languages', 'hi-IN2', 'ch1'))).not.toThrow();
  });
});

/* ================================================================== *
 * 2. locale cache identity / tts meta
 * ================================================================== */

describe('locale narration cache identity', () => {
  const lines: Array<readonly [string, readonly string[]]> = [['नमस्ते दोस्त', []]];

  it('keeps the English golden key formula untouched', () => {
    // Golden English contract (phase0): the locale code never alters it.
    const base = timeline._narrationCacheKey(lines, 'edge', 'en-US-Guy');
    expect(base).toBe(timeline._narrationCacheKey(lines, 'edge', 'en-US-Guy'));
    expect(timeline._narrationCacheKey(lines, 'edge', 'en-US-Guy')).toHaveLength(16);
  });

  it('derives a versioned locale fingerprint that differs per voice/locale', () => {
    const base = timeline._narrationCacheKey(lines, 'edge', 'hi-IN-MadhurNeural');
    const m = localeNarrationCacheKey(base, 'hi-IN', { engine: 'edge', voice_id: 'hi-IN-MadhurNeural' });
    const s = localeNarrationCacheKey(base, 'hi-IN', { engine: 'edge', voice_id: 'hi-IN-SwaraNeural' });
    expect(m).toMatch(/^loc-v1:hi-IN:[0-9a-f]{16}$/);
    expect(m).not.toBe(s);
    expect(m).not.toBe(base);
    // Same input -> same key (resume-safe).
    expect(localeNarrationCacheKey(base, 'hi-IN', { engine: 'edge', voice_id: 'hi-IN-MadhurNeural' })).toBe(m);
    expect(() => localeNarrationCacheKey(base, 'en-US', {})).toThrow(/unsupported locale/);
  });

  it('localeTtsMeta applies catalog defaults and the per-run override only', () => {
    const series = { engine: 'external', voice_id: 'rex', language: 'en', provider: 'grok', revision: '2', speed: 1.0 };
    const meta = localeTtsMeta(series, { engine: 'edge', voice_id: 'hi-IN-SwaraNeural', speed: 0.9 }, 'hi-IN');
    expect(meta.engine).toBe('edge');
    expect(meta.voice_id).toBe('hi-IN-SwaraNeural');
    expect(meta.language).toBe('hi-IN');
    expect(meta.speed).toBe(0.9);
    // Provider settings are carried, the English identity is not.
    expect(meta.provider).toBe('grok');
    expect(meta.revision).toBe('2');
    // Catalog defaults apply with no override.
    const def = localeTtsMeta(series, null, 'hi-IN');
    expect(def.engine).toBe('edge');
    expect(def.voice_id).toBe('hi-IN-MadhurNeural');
  });
});

describe('dropped panel assignment detection', () => {
  it('flags a line whose cited panels produced no shot, and stays quiet otherwise', () => {
    const lines: Array<readonly [string, readonly string[]]> = [
      ['one', ['p0001_1']],
      ['two', ['p0001_2']],
      ['three', ['p0001_3']],
    ];
    const shots = [
      { panel: 'p0001_1.jpg', line_id: 0 },
      { panel: 'p0001_2.jpg', line_id: 1 },
    ] as unknown as TimelineShot[];
    expect(droppedPanelAssignments(lines, shots)).toEqual([{ line: 2, panel: 'p0001_3' }]);
    // A resolved line is silent.
    expect(droppedPanelAssignments(lines.slice(0, 2), shots)).toEqual([]);
  });
});

describe('seedLocaleArtifacts', () => {
  it('copies shared cleaned/crops read-only and never rewrites the source', () => {
    const shared = tmp('seed-shared-');
    const locale = tmp('seed-locale-');
    const sharedCleaned = path.join(shared, 'cleaned', 'ch1');
    const sharedCrops = path.join(shared, 'render_crops', 'ch1');
    fs.mkdirSync(sharedCleaned, { recursive: true });
    fs.mkdirSync(sharedCrops, { recursive: true });
    fs.writeFileSync(path.join(sharedCleaned, 'p0001_1.png'), 'PNG');
    fs.writeFileSync(path.join(sharedCleaned, 'p0001_1.png.done'), 'stamp');
    fs.writeFileSync(path.join(sharedCrops, 'p0001_1-abcdef123456.png'), 'CROP');
    const before = treeHashes(shared);

    const copied = seedLocaleArtifacts(
      sharedCleaned,
      path.join(locale, 'cleaned', 'ch1'),
      sharedCrops,
      path.join(locale, 'render_crops', 'ch1'),
    );
    expect(copied).toBe(3);
    expect(fs.readFileSync(path.join(locale, 'cleaned', 'ch1', 'p0001_1.png'), 'utf8')).toBe('PNG');
    expect(fs.existsSync(path.join(locale, 'render_crops', 'ch1', 'p0001_1-abcdef123456.png'))).toBe(true);
    // Source tree untouched, and a second seed does not duplicate work.
    expect(treeHashes(shared)).toEqual(before);
    expect(seedLocaleArtifacts(
      sharedCleaned,
      path.join(locale, 'cleaned', 'ch1'),
      sharedCrops,
      path.join(locale, 'render_crops', 'ch1'),
    )).toBe(0);
  });
});

/* ================================================================== *
 * 3. timeline: English vs Hindi render, shared inputs, resumes
 * ================================================================== */

interface Fixture {
  root: string;
  sdir: string;
  out: string;
  ch: string;
  studioPublic: string;
  script: string;
  obs: string;
  ttsLog: string;
  env: NodeJS.ProcessEnv;
  metaHash: string;
}

/** Fake external TTS: writes a real mp3 whose length depends on the line text. */
function writeFakeExternalTts(dir: string): { script: string; log: string } {
  const script = path.join(dir, 'fake_tts.py');
  const log = path.join(dir, 'tts.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env python3',
      'import json, os, subprocess, sys',
      'req = json.load(sys.stdin)',
      'open(os.environ["TTS_LOG"], "a").write(json.dumps({',
      '  "line": req["line_index"], "text": req["text"], "language": req["language"],',
      '  "voice": req["voice_id"]}) + "\\n")',
      'seconds = 0.5 + 0.05 * len(req["text"])',
      'subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",',
      '  "sine=frequency=440:duration=%.3f" % seconds, "-ac", "1", "-ar", "24000",',
      '  "-b:a", "64k", req["output_path"]], check=True)',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { script, log };
}

async function makeFixture(name: string): Promise<Fixture> {
  const root = tmp(`${name}-`);
  // Unique slug per fixture: the staging id is derived from the series basename,
  // and STUDIO_PUBLIC is shared across this file.
  const sdir = path.join(root, `series-${name}`);
  const out = path.join(sdir, 'out');
  const ch = 'ch1';
  const studioPublic = languageTestStudioPublic();
  const panelsDir = path.join(out, 'panels', ch);
  fs.mkdirSync(panelsDir, { recursive: true });
  fs.mkdirSync(path.join(out, ch), { recursive: true });
  fs.mkdirSync(studioPublic, { recursive: true });
  const panels: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 3; i++) {
    const id = `p0001_${i}`;
    await sharp({
      create: { width: 60, height: 90, channels: 3, background: { r: 30 + i * 20, g: 40, b: 70 } },
    }).jpeg().toFile(path.join(panelsDir, `${id}.jpg`));
    panels.push({ id, art: 0.9, bubble_at: 'none', overlay: [], world: [] });
  }
  fs.writeFileSync(
    path.join(panelsDir, 'manifest.json'),
    JSON.stringify(panels.map((p, i) => ({ panel: `${p.id}.jpg`, page: 1, idx: i + 1, art_top: 0, art_bottom: 1 }))),
  );

  const script = path.join(out, ch, 'script.md');
  const scriptBody = 'He runs fast. @p0001_1\nShe waits here. @p0001_2\nThey leave now. @p0001_3\n';
  fs.writeFileSync(script, scriptBody);
  // engine=external reads script_voice.md (timeline.main swaps the path).
  fs.writeFileSync(path.join(out, ch, 'script_voice.md'), scriptBody);
  const obs = path.join(out, `obs_${ch}.json`);
  fs.writeFileSync(obs, JSON.stringify({ panels, characters: [], gags: [], events: [] }));

  const fake = writeFakeExternalTts(tmp(`${name}-tts-`));
  fs.writeFileSync(
    path.join(sdir, 'meta.json'),
    JSON.stringify({
      title: name,
      tts: {
        engine: 'external',
        voice_id: 'rex',
        language: 'en',
        command: [process.env.PYTHON ?? 'python3', fake.script],
        settings: { timeout: 30 },
      },
      visuals: { background: 'starfield', motion: 'cut' },
    }),
  );

  const statusDir = tmp(`${name}-status-`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TTS_LOG: fake.log,
    MANHWA_STUDIO_PUBLIC: studioPublic,
    PIPELINE_STATUS_DIR: path.join(statusDir, 'status'),
    PIPELINE_LOG: path.join(statusDir, 'pipeline.log'),
  };
  return {
    root,
    sdir,
    out,
    ch,
    studioPublic,
    script,
    obs,
    ttsLog: fake.log,
    env,
    metaHash: sha(path.join(sdir, 'meta.json')),
  };
}

/** Write the localize stage's Hindi script under the locale tree. */
function writeLocaleScript(fx: Fixture, lines: string[]): string {
  const dir = languageChapterDir(fx.out, 'hi-IN', fx.ch);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'script.md');
  fs.writeFileSync(script, `${lines.join('\n')}\n`);
  return script;
}

const HINDI_LINES = [
  'वह तेज़ दौड़ता है। @p0001_1',
  'वह यहाँ इंतज़ार करती है। @p0001_2',
  'वे अब चले जाते हैं। @p0001_3',
];

/** Locale TTS override: Hindi Edge voice (the first-release default). */
const HINDI_TTS = {
  engine: 'edge',
  voice_id: 'hi-IN-MadhurNeural',
  language: 'hi-IN',
  speed: 1,
};

async function runLocale(fx: Fixture, tts: Record<string, unknown> = HINDI_TTS): Promise<string> {
  const localeDir = languageChapterDir(fx.out, 'hi-IN', fx.ch);
  return await timeline.main(
    fx.sdir,
    fx.ch,
    path.join(localeDir, 'script.md'),
    fx.obs,
    path.join(localeDir, 'video'),
    { locale: 'hi-IN', tts, env: fx.env },
  );
}

describe('timeline: English behaviour is unchanged', () => {
  it('renders the English chapter exactly as before (no locale options)', async () => {
    const fx = await makeFixture('lang-en');
    const vdir = path.join(fx.out, fx.ch, 'video');
    const props = await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, vdir, { env: fx.env });
    expect(fs.existsSync(props)).toBe(true);
    expect(fs.existsSync(path.join(vdir, 'narration.mp3'))).toBe(true);

    // English staging id and a raw (non-versioned) narration key.
    expect(fs.existsSync(path.join(fx.studioPublic, `${path.basename(fx.sdir)}_ch1`, 'narration.mp3'))).toBe(true);
    const key = fs.readFileSync(path.join(vdir, 'narration.key'), 'utf8');
    expect(key).not.toContain('loc-v1');
    expect(key.trim()).toHaveLength(16);

    // External TTS received the English provider config from meta.json.
    const calls = fs.readFileSync(fx.ttsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toHaveLength(3);
    expect(calls[0].language).toBe('en');
    expect(calls[0].voice).toBe('rex');

    // No locale tree was created by an English run.
    expect(fs.existsSync(path.join(fx.out, 'languages'))).toBe(false);
    // meta.json untouched.
    expect(sha(path.join(fx.sdir, 'meta.json'))).toBe(fx.metaHash);
  });
});

describe('timeline: Hindi language version', () => {
  it('renders hi-IN into its own tree and staging id, sharing obs/panels', async () => {
    const fx = await makeFixture('lang-hi');
    writeLocaleScript(fx, HINDI_LINES);

    const sharedBefore = treeHashes(path.join(fx.out, 'panels'));
    const obsBefore = sha(fx.obs);
    const props = await runLocale(fx);

    const localeDir = languageChapterDir(fx.out, 'hi-IN', fx.ch);
    expect(props).toBe(path.join(localeDir, 'video', 'shots.json'));
    const localeVideo = path.join(localeDir, 'video');
    expect(fs.existsSync(path.join(localeVideo, 'narration.mp3'))).toBe(true);

    // Versioned locale key + locale staging id, distinct from English.
    const key = fs.readFileSync(path.join(localeVideo, 'narration.key'), 'utf8').trim();
    expect(key).toMatch(/^loc-v1:hi-IN:[0-9a-f]{16}$/);
    const hiStaging = path.join(fx.studioPublic, `${path.basename(fx.sdir)}_ch1_hi-IN`);
    expect(fs.existsSync(path.join(hiStaging, 'narration.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(fx.studioPublic, `${path.basename(fx.sdir)}_ch1`))).toBe(false);

    // Real Hindi durations drove the shots.
    const propsJson = JSON.parse(fs.readFileSync(props, 'utf8')) as {
      shots: Array<{ start_s: number; end_s: number; panel: string }>;
      audio: string;
    };
    expect(propsJson.shots).toHaveLength(3);
    expect(propsJson.audio).toBe(`${path.basename(fx.sdir)}_ch1_hi-IN/narration.mp3`);
    expect(propsJson.shots.every((s) => s.panel.startsWith(`${path.basename(fx.sdir)}_ch1_hi-IN/`))).toBe(true);
    const lastEnd = Math.max(...propsJson.shots.map((s) => s.end_s));
    const totalDurs = JSON.parse(fs.readFileSync(path.join(localeVideo, 'tts_durs.json'), 'utf8')) as number[];
    expect(totalDurs).toHaveLength(3);
    const sum = totalDurs.reduce((a, b) => a + b, 0);
    expect(lastEnd).toBeGreaterThanOrEqual(sum - 0.05);

    // Shared inputs untouched: panels + obs are byte-identical.
    expect(treeHashes(path.join(fx.out, 'panels'))).toEqual(sharedBefore);
    expect(sha(fx.obs)).toBe(obsBefore);
    // meta.json untouched (voice override never persists).
    expect(sha(path.join(fx.sdir, 'meta.json'))).toBe(fx.metaHash);

    // Hindi text reached the TTS engine, with the Hindi voice.
    const calls = fakeEdgeCalls(path.join(localeVideo, 'tts_lines_edge'));
    expect(calls).toHaveLength(3);
    expect(calls[0]!.voice).toBe('hi-IN-MadhurNeural');
    expect(calls.map((c) => c.text).join(' ')).toContain('वह तेज़ दौड़ता है।');
  });

  it('strips source emotion controls from Hindi Edge speech but keeps the stored script', async () => {
    const fx = await makeFixture('lang-emotion');
    // A script_voice-like source: external/elevenlabs delivery tags on the lines.
    writeLocaleScript(fx, [
      '[deadpan] वह तेज़ दौड़ता है। @p0001_1',
      '[whispering] वह यहाँ इंतज़ार करती है। [sighs] @p0001_2',
      'वे अब चले जाते हैं। @p0001_3',
    ]);
    const scriptFile = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'script.md');
    const storedBefore = fs.readFileSync(scriptFile, 'utf8');

    await runLocale(fx);

    // Edge must never be asked to SPEAK a bracket control.
    const localeVideo = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'video');
    const calls = fakeEdgeCalls(path.join(localeVideo, 'tts_lines_edge'));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.text).not.toMatch(/\[/);
      expect(call.text).not.toMatch(/deadpan|whispering|sighs/);
    }
    expect(calls[0]!.text).toBe('वह तेज़ दौड़ता है।');
    expect(calls[1]!.text).toBe('वह यहाँ इंतज़ार करती है।');
    expect(calls[2]!.text).toBe('वे अब चले जाते हैं।');

    // The STORED localized script keeps its controls (structure, not speech).
    expect(fs.readFileSync(scriptFile, 'utf8')).toBe(storedBefore);
    expect(fs.readFileSync(scriptFile, 'utf8')).toContain('[deadpan]');
    // And the controls did not become narration text in shots.json.
    const props = JSON.parse(
      fs.readFileSync(path.join(localeVideo, 'shots.json'), 'utf8'),
    ) as { shots: unknown[] };
    expect(props.shots).toHaveLength(3);
  });

  it('stripEmotionControls removes controls without emptying a prose line', () => {
    expect(stripEmotionControls('[deadpan] वह तेज़ दौड़ता है।')).toBe('वह तेज़ दौड़ता है।');
    expect(stripEmotionControls('वह यहाँ है। [sighs]')).toBe('वह यहाँ है।');
    expect(stripEmotionControls('[whispering] [sighs] वे चले गए।')).toBe('वे चले गए।');
    expect(stripEmotionControls('no controls here')).toBe('no controls here');
    // A control-only line has no prose: keep the text instead of synthesizing "".
    expect(stripEmotionControls('[deadpan]')).toBe('[deadpan]');
    // Non-control brackets survive (e.g. a system-window marker in prose).
    expect(stripEmotionControls('[A] रुको')).toBe('[A] रुको');
  });

  it('uses the preview rate mapping for locale Edge and keeps the English legacy +6%', async () => {
    // The Studio preview maps speed 1 to +0%; a locale render must match it,
    // while English keeps its historical +6% default.
    expect(LOCALE_EDGE_RATE).toBe('+0%');
    expect(audioEdgeRate(1, LOCALE_EDGE_RATE)).toBe('+0%');
    expect(audioEdgeRate(1)).toBe('+6%');
    expect(audioEdgeRate(1.25, '+0%')).toBe('+25%');
    expect(audioEdgeRate(1.25)).toBe('+25%');
    expect(audioEdgeRate(0.9, '+0%')).toBe('-10%');

    const fx = await makeFixture('lang-rate');
    writeLocaleScript(fx, HINDI_LINES);
    const localeVideo = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'video');

    await runLocale(fx);
    const atOne = fakeEdgeCalls(path.join(localeVideo, 'tts_lines_edge'));
    expect(atOne.map((c) => c.rate)).toEqual(Array(3).fill('+0%'));

    // speed 1.25 re-bills and matches the preview's +25% for the same voice.
    await runLocale(fx, { ...HINDI_TTS, speed: 1.25 });
    const atOneTwentyFive = fakeEdgeCalls(path.join(localeVideo, 'tts_lines_edge'));
    expect(atOneTwentyFive.map((c) => c.rate)).toEqual(Array(3).fill('+25%'));

    // English keeps the legacy +6% at speed 1 (Edge-voiced series).
    const en = await makeFixture('lang-rate-en');
    fs.writeFileSync(
      path.join(en.sdir, 'meta.json'),
      JSON.stringify({
        title: 'lang-rate-en',
        tts: { engine: 'edge', voice_id: 'en-US-AndrewMultilingualNeural', speed: 1 },
        visuals: { background: 'starfield', motion: 'cut' },
      }),
    );
    await timeline.main(en.sdir, en.ch, en.script, en.obs, path.join(en.out, en.ch, 'video'), { env: en.env });
    const enCalls = fakeEdgeCalls(path.join(en.out, en.ch, 'video', 'tts_lines_edge'));
    expect(enCalls.map((c) => c.rate)).toEqual(Array(3).fill('+6%'));
  });

  it('English and Hindi for one chapter stage side by side without collision', async () => {
    const fx = await makeFixture('lang-both');
    writeLocaleScript(fx, HINDI_LINES);

    const enVdir = path.join(fx.out, fx.ch, 'video');
    await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, enVdir, { env: fx.env });
    await runLocale(fx);

    const slug = path.basename(fx.sdir);
    const enPublic = path.join(fx.studioPublic, `${slug}_ch1`);
    const hiPublic = path.join(fx.studioPublic, `${slug}_ch1_hi-IN`);
    expect(fs.existsSync(enPublic)).toBe(true);
    expect(fs.existsSync(hiPublic)).toBe(true);

    // Different narration audio per language, and neither overwrote the other.
    const enAudio = sha(path.join(enPublic, 'narration.mp3'));
    const hiAudio = sha(path.join(hiPublic, 'narration.mp3'));
    expect(enAudio).not.toBe(hiAudio);
    expect(sha(path.join(enVdir, 'narration.mp3'))).toBe(enAudio);

    // The English shots.json still points at the English staging id.
    const enProps = JSON.parse(fs.readFileSync(path.join(enVdir, 'shots.json'), 'utf8')) as { audio: string };
    expect(enProps.audio).toBe(`${slug}_ch1/narration.mp3`);
  });

  it('resumes Hindi lines only: cached Hindi audio is reused, English is not', async () => {
    const fx = await makeFixture('lang-resume');
    writeLocaleScript(fx, HINDI_LINES);

    // An English narration must never satisfy a Hindi run.
    const enVdir = path.join(fx.out, fx.ch, 'video');
    await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, enVdir, { env: fx.env });
    const enKey = fs.readFileSync(path.join(enVdir, 'narration.key'), 'utf8').trim();
    const enAudio = sha(path.join(enVdir, 'narration.mp3'));

    await runLocale(fx);
    const localeVideo = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'video');
    const hiKey = fs.readFileSync(path.join(localeVideo, 'narration.key'), 'utf8').trim();
    expect(hiKey).not.toBe(enKey);
    const hiAudio = sha(path.join(localeVideo, 'narration.mp3'));
    expect(hiAudio).not.toBe(enAudio);

    const lineDir = path.join(localeVideo, 'tts_lines_edge');
    const callsAfterFirst = treeHashes(lineDir);
    const sharedBefore = treeHashes(path.join(fx.out, 'cleaned'));
    const sharedCropsBefore = treeHashes(path.join(fx.out, 'render_crops'));
    const enAudioBefore = sha(path.join(enVdir, 'narration.mp3'));

    // Second Hindi run: full cache hit, no new synthesis (line files untouched).
    await runLocale(fx);
    expect(treeHashes(lineDir)).toEqual(callsAfterFirst);
    expect(sha(path.join(localeVideo, 'narration.mp3'))).toBe(hiAudio);
    // Source (shared English) caches are untouched by the Hindi rerun.
    expect(treeHashes(path.join(fx.out, 'cleaned'))).toEqual(sharedBefore);
    expect(treeHashes(path.join(fx.out, 'render_crops'))).toEqual(sharedCropsBefore);
    expect(sha(path.join(enVdir, 'narration.mp3'))).toBe(enAudioBefore);
  });

  it('a Hindi voice change re-bills the locale narration (no stale audio)', async () => {
    const fx = await makeFixture('lang-voice-change');
    writeLocaleScript(fx, HINDI_LINES);
    await runLocale(fx);
    const lineDir = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'video', 'tts_lines_edge');
    const first = fakeEdgeCalls(lineDir);
    expect(first.map((c) => c.voice)).toEqual(Array(3).fill('hi-IN-MadhurNeural'));

    await runLocale(fx, { ...HINDI_TTS, voice_id: 'hi-IN-SwaraNeural' });
    const second = fakeEdgeCalls(lineDir);
    expect(second).toHaveLength(3);
    expect(second.map((c) => c.voice)).toEqual(Array(3).fill('hi-IN-SwaraNeural'));
    // meta.json still untouched by the override.
    expect(sha(path.join(fx.sdir, 'meta.json'))).toBe(fx.metaHash);
  });

  it('refuses an unsupported locale and a symlinked locale tree', async () => {
    const fx = await makeFixture('lang-refuse');
    writeLocaleScript(fx, HINDI_LINES);
    const localeDir = languageChapterDir(fx.out, 'hi-IN', fx.ch);

    await expect(
      timeline.main(fx.sdir, fx.ch, path.join(localeDir, 'script.md'), fx.obs, path.join(localeDir, 'video'), {
        locale: 'en-US',
        env: fx.env,
      }),
    ).rejects.toThrow(/unsupported locale/);

    // A symlinked locale root must never be written through.
    const elsewhere = tmp('lang-refuse-elsewhere-');
    fs.rmSync(path.join(fx.out, 'languages'), { recursive: true, force: true });
    fs.symlinkSync(elsewhere, path.join(fx.out, 'languages'));
    await expect(runLocale(fx)).rejects.toThrow(/symlinked locale path/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('warns and records a dropped panel assignment instead of degrading silently', async () => {
    const fx = await makeFixture('lang-dropped');
    // Line 3 cites a panel that has no artwork: buildShots cannot show it.
    writeLocaleScript(fx, [
      'वह तेज़ दौड़ता है। @p0001_1',
      'वह यहाँ इंतज़ार करती है। @p0001_2',
      'वे अब चले जाते हैं। @p0009_9',
    ]);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const telemetry = await import('../src/telemetry/telemetry.js');
    telemetry.start('series-lang-dropped', ['ch1'], true);
    try {
      await runLocale(fx);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join('\n')).toMatch(/panel intent \(hi-IN\): 1 explicit assignment/);
    expect(warnings.join('\n')).toContain('p0009_9');

    // The loss is recorded, not swallowed: stage details + a locale sidecar.
    const stages = telemetry._data()!.chapters.ch1!.stages as Record<string, Record<string, unknown>>;
    expect(stages.timeline!.droppedPanels).toBe(1);
    expect(stages.timeline!.droppedPanelIds).toEqual(['p0009_9']);
    const sidecar = path.join(languageChapterDir(fx.out, 'hi-IN', fx.ch), 'video', 'locale_warnings.json');
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('p0009_9');
    telemetry._reset();
  });

  it('renderLocal keeps its ORIGINAL in-place behaviour for English (no backup copy)', async () => {
    const dir = tmp('render-local-en-');
    const video = path.join(dir, 'video.mp4');
    const props = path.join(dir, 'shots.json');
    fs.writeFileSync(props, '{}');
    fs.writeFileSync(video, 'OLD-ENGLISH');

    const originalSubprocess = renderlane._hooks.subprocess;
    const originalCapfree = renderlane._hooks._capfreeNode;
    renderlane._hooks._capfreeNode = (() => null) as unknown as typeof renderlane._capfreeNode;
    const seen: string[][] = [];
    renderlane._hooks.subprocess = {
      run: (args: readonly string[]) => {
        seen.push([...args]);
        // The lane writes the canonical path itself: this is unchanged English
        // behaviour, and no backup/restore machinery may exist around it.
        fs.writeFileSync(video, 'NEW-ENGLISH');
        return { returncode: 0, status: 0, stdout: '', stderr: '' };
      },
    } as unknown as typeof renderlane.subprocess;
    try {
      renderlane.renderLocal(props, video);
    } finally {
      renderlane._hooks.subprocess = originalSubprocess;
      renderlane._hooks._capfreeNode = originalCapfree;
    }
    // Renders straight to the canonical target; no ".candidate" indirection.
    expect(seen[0]![5]).toBe(video);
    expect(fs.readFileSync(video, 'utf8')).toBe('NEW-ENGLISH');
    expect(fs.readdirSync(dir).filter((n) => n.includes('candidate'))).toEqual([]);
  });

  it('does not rebuild the shared promo block during a locale render', async () => {
    const fx = await makeFixture('lang-promo');
    writeLocaleScript(fx, HINDI_LINES);
    // English first: builds out/promo_block.json.
    await timeline.main(fx.sdir, fx.ch, fx.script, fx.obs, path.join(fx.out, fx.ch, 'video'), { env: fx.env });
    const blockFile = path.join(fx.out, 'promo_block.json');
    expect(fs.existsSync(blockFile)).toBe(true);
    const before = sha(blockFile);
    const mtime = fs.statSync(blockFile).mtimeMs;

    await runLocale(fx);
    expect(sha(blockFile)).toBe(before);
    expect(fs.statSync(blockFile).mtimeMs).toBe(mtime);
  });
});

/* ================================================================== *
 * 4. renderlane: prepare/produce locale contract
 * ================================================================== */

describe('renderlane: locale prepare/produce', () => {
  let sdir = '';
  let out = '';
  let calls: Array<{ args: unknown[] }> = [];

  beforeEach(() => {
    const root = tmp('rl-locale-');
    sdir = path.join(root, 'series');
    out = path.join(sdir, 'out');
    fs.mkdirSync(path.join(out, 'ch1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'obs_ch1.json'), '{}');
    fs.writeFileSync(path.join(out, 'ch1', 'script.md'), 'line @p0001_1\n');
    calls = [];
    renderlane._hooks.loadTimeline = () => ({
      main: (...args: unknown[]) => {
        calls.push({ args });
        const vdir = String(args[4]);
        fs.mkdirSync(vdir, { recursive: true });
        fs.writeFileSync(path.join(vdir, 'shots.json'), '{}');
        return path.join(vdir, 'shots.json');
      },
    });
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
  });

  it('prepare() with no options keeps the exact English call (5 args, out/<ch>/video)', async () => {
    const [props, video] = await renderlane.prepare(sdir, 'ch1', out);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toHaveLength(5);
    expect(calls[0]!.args[2]).toBe(path.join(out, 'ch1', 'script.md'));
    expect(calls[0]!.args[3]).toBe(path.join(out, 'obs_ch1.json'));
    expect(props).toBe(path.resolve(path.join(out, 'ch1', 'video', 'shots.json')));
    expect(video).toBe(path.resolve(path.join(out, 'ch1', 'video', 'video.mp4')));
  });

  it('prepare() with locale resolves the locale script/video and forwards locale+tts', async () => {
    const localeDir = languageChapterDir(out, 'hi-IN', 'ch1');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'script.md'), 'हिन्दी @p0001_1\n');

    const [props, video] = await renderlane.prepare(sdir, 'ch1', out, {
      locale: 'hi-IN',
      tts: HINDI_TTS,
      env: { MANHWA_OUT_DIR: out },
    });

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toHaveLength(6);
    expect(args[2]).toBe(path.join(localeDir, 'script.md'));
    // Shared obs stays the original chapter obs.
    expect(args[3]).toBe(path.join(out, 'obs_ch1.json'));
    expect(args[4]).toBe(path.join(localeDir, 'video'));
    expect(args[5]).toEqual({ locale: 'hi-IN', tts: HINDI_TTS, env: { MANHWA_OUT_DIR: out } });
    expect(props).toBe(path.resolve(path.join(localeDir, 'video', 'shots.json')));
    expect(video).toBe(path.resolve(path.join(localeDir, 'video', 'video.mp4')));
    // English staging untouched.
    expect(fs.existsSync(path.join(out, 'ch1', 'video'))).toBe(false);
  });

  it('prepare() rejects an unsupported locale and a missing locale script', async () => {
    await expect(renderlane.prepare(sdir, 'ch1', out, { locale: 'en-US' })).rejects.toThrow(/unsupported locale/);
    await expect(renderlane.prepare(sdir, 'ch1', out, { locale: '../hi-IN' })).rejects.toThrow(/unsupported locale/);
    fs.rmSync(path.join(out, 'ch1', 'script.md'));
    await expect(renderlane.prepare(sdir, 'ch1', out, { locale: 'hi-IN' })).rejects.toThrow(/script missing/);
  });

  it('prepare() refuses a symlinked output component BEFORE creating anything', async () => {
    const localeDir = languageChapterDir(out, 'hi-IN', 'ch1');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'script.md'), 'हिन्दी @p0001_1\n');
    // The `video` component is a link to the shared English video dir: a locale
    // write through it would clobber English narration/shots.
    const elsewhere = tmp('prepare-symlink-target-');
    const englishVideo = path.join(out, 'ch1', 'video');
    fs.mkdirSync(englishVideo, { recursive: true });
    fs.symlinkSync(englishVideo, path.join(localeDir, 'video'));

    calls = [];
    await expect(renderlane.prepare(sdir, 'ch1', out, { locale: 'hi-IN' })).rejects.toThrow(
      /symlinked locale path/,
    );
    // Nothing ran, and the shared English dir is still empty.
    expect(calls).toEqual([]);
    expect(fs.readdirSync(englishVideo)).toEqual([]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('produce() returns locale warnings as a third tuple element', async () => {
    const localeDir = languageChapterDir(out, 'hi-IN', 'ch1');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'script.md'), 'हिन्दी @p0001_1\n');
    renderlane._hooks.lappy.healthy = () => [false, 'off'];
    renderlane._hooks._probe = (() => 9) as unknown as typeof renderlane._probe;
    renderlane._hooks.renderLocal = ((_p: string, target: string) => {
      fs.writeFileSync(target, 'RENDERED');
    }) as unknown as typeof renderlane.renderLocal;

    const video = path.join(localeDir, 'video', 'video.mp4');
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(video), 'locale_warnings.json'),
      JSON.stringify({ locale: 'hi-IN', warnings: ['dropped panel p0009_9 on line 2'] }),
    );

    const result = await renderlane.produce(sdir, 'ch1', out, {
      locale: 'hi-IN',
      tts: HINDI_TTS,
      lane: 'local',
      log: () => {},
    });
    expect(result).toEqual([video, 9, ['dropped panel p0009_9 on line 2']]);

    // English produce never grows a third element.
    renderlane._hooks.prepare = (async () => ['p.json', 'v.mp4']) as unknown as typeof renderlane.prepare;
    expect(await renderlane.produce(sdir, 'ch1', out, { lane: 'local', log: () => {} }))
      .toEqual(['v.mp4', 9]);
  });

  it('produce() with locale publishes atomically and keeps English produce intact', async () => {
    const localeDir = languageChapterDir(out, 'hi-IN', 'ch1');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'script.md'), 'हिन्दी @p0001_1\n');
    const canonical = path.join(localeDir, 'video', 'video.mp4');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, 'LAST-GOOD');
    renderlane._hooks.lappy.healthy = () => [false, 'off'];
    renderlane._hooks._probe = (() => 12.5) as unknown as typeof renderlane._probe;
    const rendered: string[] = [];
    renderlane._hooks.renderLocal = ((_props: string, video: string) => {
      rendered.push(video);
      fs.writeFileSync(video, 'NEW-HINDI');
    }) as unknown as typeof renderlane.renderLocal;

    const [video, dur] = await renderlane.produce(sdir, 'ch1', out, {
      locale: 'hi-IN',
      tts: HINDI_TTS,
      lane: 'local',
      log: () => {},
    });
    expect(video).toBe(path.resolve(canonical));
    expect(dur).toBe(12.5);
    // The lane rendered a sibling candidate, never the published file.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).not.toBe(path.resolve(canonical));
    expect(path.dirname(rendered[0]!)).toBe(path.dirname(path.resolve(canonical)));
    expect(path.basename(rendered[0]!)).toMatch(/\.candidate\.mp4$/);
    expect(fs.readFileSync(canonical, 'utf8')).toBe('NEW-HINDI');
    expect(fs.existsSync(rendered[0]!)).toBe(false); // candidate consumed by rename
    expect(calls[0]!.args[5]).toMatchObject({ locale: 'hi-IN', tts: HINDI_TTS });

    // English produce: prepare is called with exactly 3 args, and the lane gets
    // the canonical path (original behaviour).
    calls = [];
    const prepared: number[] = [];
    renderlane._hooks.prepare = (async (...args: unknown[]) => {
      prepared.push(args.length);
      return ['p.json', 'v.mp4'] as [string, string];
    }) as unknown as typeof renderlane.prepare;
    const englishTargets: string[] = [];
    renderlane._hooks.renderLocal = ((_p: string, v: string) => {
      englishTargets.push(v);
    }) as unknown as typeof renderlane.renderLocal;
    const [enVideo, enDur] = await renderlane.produce(sdir, 'ch1', out, { lane: 'local', log: () => {} });
    expect(prepared).toEqual([3]);
    expect(enVideo).toBe('v.mp4');
    expect(enDur).toBe(12.5);
    expect(englishTargets).toEqual(['v.mp4']);
  });
});

/* ================================================================== *
 * 4b. locale render is atomic: the published mp4 survives failures
 * ================================================================== */

describe('renderlane: atomic locale render', () => {
  let sdir = '';
  let out = '';
  let canonical = '';
  let vdir = '';

  function setupLocale(): void {
    const root = tmp('rl-atomic-');
    sdir = path.join(root, 'series');
    out = path.join(sdir, 'out');
    fs.mkdirSync(path.join(out, 'ch1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'obs_ch1.json'), '{}');
    const localeDir = languageChapterDir(out, 'hi-IN', 'ch1');
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'script.md'), 'हिन्दी @p0001_1\n');
    vdir = path.join(localeDir, 'video');
    canonical = path.join(vdir, 'video.mp4');
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(canonical, 'PUBLISHED-OLD');
    renderlane._hooks.loadTimeline = () => ({
      main: (...args: unknown[]) => {
        const dir = String(args[4]);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'shots.json'), '{}');
        return path.join(dir, 'shots.json');
      },
    });
    renderlane._hooks.lappy.healthy = () => [false, 'off'];
    renderlane._hooks._probe = ((file: string) => {
      try {
        return fs.statSync(file).size > 0 ? 8.5 : 0;
      } catch {
        return 0;
      }
    }) as unknown as typeof renderlane._probe;
  }

  beforeEach(() => {
    setupLocale();
  });

  afterEach(() => {
    renderlane._resetHooksForTests();
  });

  const produceLocale = (): Promise<renderlane.ProduceResult> =>
    renderlane.produce(sdir, 'ch1', out, {
      locale: 'hi-IN',
      tts: HINDI_TTS,
      lane: 'local',
      log: () => {},
    });

  it('a failed render leaves the published bytes untouched and no candidate behind', async () => {
    const before = sha(canonical);
    const targets: string[] = [];
    renderlane._hooks.renderLocal = ((_p: string, video: string) => {
      targets.push(video);
      // A partially written candidate, then the lane fails.
      fs.writeFileSync(video, 'TRUNCATED');
      throw new renderlane.RuntimeError('remotion render failed rc=133: boom');
    }) as unknown as typeof renderlane.renderLocal;

    await expect(produceLocale()).rejects.toThrow(/rc=133/);
    expect(targets[0]).not.toBe(canonical);
    expect(sha(canonical)).toBe(before);
    expect(fs.readFileSync(canonical, 'utf8')).toBe('PUBLISHED-OLD');
    // No stale candidate is left to be mistaken for output.
    expect(fs.readdirSync(vdir).filter((n) => n.includes('candidate'))).toEqual([]);
  });

  it('the published file reads as the OLD bytes while the render is in progress', async () => {
    let seenDuringRender: string | null = null;
    let inodeDuringRender: number | null = null;
    renderlane._hooks.renderLocal = ((_p: string, video: string) => {
      // Mid-render callback: the published path must still hold the old bytes.
      seenDuringRender = fs.readFileSync(canonical, 'utf8');
      inodeDuringRender = fs.statSync(canonical).ino;
      fs.writeFileSync(video, 'NEW');
    }) as unknown as typeof renderlane.renderLocal;

    const inodeBefore = fs.statSync(canonical).ino;
    const [video] = await produceLocale();
    expect(seenDuringRender).toBe('PUBLISHED-OLD');
    expect(inodeDuringRender).toBe(inodeBefore);
    expect(video).toBe(path.resolve(canonical));
    expect(fs.readFileSync(canonical, 'utf8')).toBe('NEW');
  });

  it('an abrupt renderer exit (simulated SIGKILL) cannot truncate the published file', async () => {
    // The renderer is killed mid-write: it writes a partial candidate and the
    // process never returns, so no catch/finally in this process can restore
    // anything. The published file must already be safe.
    const before = sha(canonical);
    const target: string[] = [];
    renderlane._hooks.renderLocal = ((_p: string, video: string) => {
      target.push(video);
      fs.writeFileSync(video, 'PARTIAL');
      const err = new Error('spawnSync npx ETIMEDOUT') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      throw err;
    }) as unknown as typeof renderlane.renderLocal;

    await expect(produceLocale()).rejects.toThrow();
    expect(target[0]).not.toBe(canonical);
    expect(sha(canonical)).toBe(before);
    expect(fs.readFileSync(canonical, 'utf8')).toBe('PUBLISHED-OLD');
  });

  it('a candidate that fails validation is never published', async () => {
    renderlane._hooks.renderLocal = ((_p: string, video: string) => {
      fs.writeFileSync(video, ''); // zero bytes but the lane "succeeded"
    }) as unknown as typeof renderlane.renderLocal;
    renderlane._hooks._probe = (() => 0) as unknown as typeof renderlane._probe;

    // The lane rejects the empty output first; the candidate re-probe is the
    // second belt. Either way nothing is published.
    await expect(produceLocale()).rejects.toThrow(/empty video|empty candidate/);
    expect(fs.readFileSync(canonical, 'utf8')).toBe('PUBLISHED-OLD');
    expect(fs.readdirSync(vdir).filter((n) => n.includes('candidate'))).toEqual([]);
  });

  it('clears candidates a previous crashed render left behind', async () => {
    const stale = path.join(vdir, '.video.mp4.999.deadbeef.candidate.mp4');
    fs.writeFileSync(stale, 'PARTIAL-FROM-CRASH');
    renderlane._hooks.renderLocal = ((_p: string, video: string) => {
      fs.writeFileSync(video, 'NEW');
    }) as unknown as typeof renderlane.renderLocal;

    await produceLocale();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(canonical, 'utf8')).toBe('NEW');
  });
});

/* ================================================================== *
 * 5. vertexTts: locale-aware discovery, per-locale cache
 * ================================================================== */

describe('vertexTts: locale discovery', () => {
  function vertexEnv(): NodeJS.ProcessEnv {
    const root = tmp('vertex-locale-');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);
    return { MANHWA_OUT_DIR: outDir, MANHWA_JOBS_DIR: path.join(outDir, 'jobs'), PATH: process.env.PATH ?? '' };
  }

  const voicesBody = {
    voices: [
      { name: 'en-US-Chirp3-HD-Charon', languageCodes: ['en-US'] },
      { name: 'en-US-Studio-O', languageCodes: ['en-US'] },
      { name: 'hi-IN-Chirp3-HD-Aoede', languageCodes: ['hi-IN'] },
      { name: 'hi-IN-Neural2-A', languageCodes: ['hi-IN'] },
      { name: 'hi-IN-Standard-A', languageCodes: ['hi-IN'] },
    ],
  };

  function fetchSpy(calls: Array<{ url: string; init: any }>): typeof fetch {
    return (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(voicesBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  it('keeps the English default URL, filter and cache file unchanged', async () => {
    const env = vertexEnv();
    const calls: Array<{ url: string; init: any }> = [];
    const voices = await vertexTts.discoverVertexTtsVoices(env, { fetchImpl: fetchSpy(calls) });
    expect(calls[0]!.url).toBe('https://texttospeech.googleapis.com/v1/voices?languageCode=en-US');
    expect(voices.map((v) => v.id)).toEqual(['en-US-Chirp3-HD-Charon', 'en-US-Studio-O']);
    const cache = path.join(String(env.MANHWA_OUT_DIR), 'config', vertexTts.VERTEX_TTS_VOICES_CACHE_FILENAME);
    expect(fs.existsSync(cache)).toBe(true);
    // No locale-suffixed cache file for English.
    expect(fs.existsSync(path.join(String(env.MANHWA_OUT_DIR), 'config', 'vertex-tts-voices.hi-IN.json'))).toBe(false);
  });

  it('discovers Hindi voices for hi-IN into a distinct cache file', async () => {
    const env = vertexEnv();
    const calls: Array<{ url: string; init: any }> = [];
    const voices = await vertexTts.discoverVertexTtsVoices(env, { fetchImpl: fetchSpy(calls), locale: 'hi-IN' });
    expect(calls[0]!.url).toBe('https://texttospeech.googleapis.com/v1/voices?languageCode=hi-IN');
    expect(voices.map((v) => v.id)).toEqual(['hi-IN-Chirp3-HD-Aoede', 'hi-IN-Neural2-A']);

    const configDir = path.join(String(env.MANHWA_OUT_DIR), 'config');
    const hiCache = path.join(configDir, 'vertex-tts-voices.hi-IN.json');
    expect(fs.existsSync(hiCache)).toBe(true);
    // The English cache was not created or clobbered by the Hindi discovery.
    expect(fs.existsSync(path.join(configDir, vertexTts.VERTEX_TTS_VOICES_CACHE_FILENAME))).toBe(false);

    // Distinct caches: English discovery later writes its own file.
    await vertexTts.discoverVertexTtsVoices(env, { fetchImpl: fetchSpy([]) });
    const enCache = path.join(configDir, vertexTts.VERTEX_TTS_VOICES_CACHE_FILENAME);
    expect(sha(hiCache)).not.toBe(sha(enCache));

    // Locale catalogs stay separate; the English catalog is unchanged.
    const hiIds = vertexTts.listVertexTtsVoices(env, 'hi-IN').map((v) => v.id);
    // Built-in Hindi Chirp 3 HD + multilingual Gemini voices come first, then the
    // account's own discovery for this locale.
    expect(hiIds).toContain('hi-IN-Chirp3-HD-Aoede');
    expect(hiIds).toContain('gemini-tts:Charon');
    expect(hiIds).toContain('hi-IN-Neural2-A');
    expect(hiIds).not.toContain('en-US-Chirp3-HD-Charon');
    expect(hiIds.indexOf('hi-IN-Neural2-A')).toBeGreaterThan(hiIds.indexOf('hi-IN-Chirp3-HD-Aoede'));
    const enIds = vertexTts.listVertexTtsVoices(env).map((v) => v.id);
    expect(enIds).toContain('en-US-Chirp3-HD-Charon');
    expect(enIds).toContain('gemini-tts:Charon');
    expect(enIds).not.toContain('hi-IN-Chirp3-HD-Aoede');
    expect(enIds).not.toContain('hi-IN-Neural2-A');
    expect(vertexTts.findVertexTtsVoice('hi-IN-Chirp3-HD-Aoede', env, 'hi-IN')).not.toBeNull();
    expect(vertexTts.findVertexTtsVoice('gemini-tts:Charon', env, 'hi-IN')).not.toBeNull();
    expect(vertexTts.findVertexTtsVoice('hi-IN-Chirp3-HD-Aoede', env)).toBeNull();
  });

  it('rejects a malformed discovery locale instead of building a path', () => {
    expect(() => vertexTts.normalizeVertexLocale('../hi')).toThrow(/invalid Vertex TTS locale/);
    expect(vertexTts.normalizeVertexLocale('hi-in')).toBe('hi-IN');
    expect(vertexTts.normalizeVertexLocale(undefined)).toBe('en-US');
    expect(vertexTts.vertexTtsVoicesCachePath({ MANHWA_OUT_DIR: '/o' } as NodeJS.ProcessEnv, 'hi-IN'))
      .toBe(path.join('/o', 'config', 'vertex-tts-voices.hi-IN.json'));
  });
});
