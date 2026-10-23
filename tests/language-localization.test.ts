/**
 * Core Hindi language-version feature.
 *
 * Covers: script skeleton/controls, source gating on the CURRENT bytes, split
 * translation/render identities, durable jobs with restart reconciliation, and
 * last-known-good video survival across failed/interrupted regeneration.
 *
 * The LLM and the renderer are fakes (no paid provider); MP4/MP3 fixtures and
 * every duration check use real ffmpeg/ffprobe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as localize from '../src/stages/localize.js';
import {
  numberValues,
  parseLocaleScript,
  rebuildScript,
  validateTranslation,
} from '../src/stages/localeScript.js';
import {
  canonicalChapterDir,
  canonicalVideoPath,
  jobPath,
  languagesRoot,
  readJob,
  readManifest,
  sha256File,
  sortChapters,
  writeJob,
} from '../src/localization/store.js';
import type { LocalizeJobRecord } from '../src/localization/types.js';

const slug = 'hindi-fixture';

let root: string;
let sdir: string;

const ENGLISH_SCRIPT = `## BEAT b00_opening
The gate opens at midnight, and Zichen counts ten thousand steps before dawn. @p0001_1 @p0001_2

## BEAT b01_the_first_friend
Shen Qinghan waits by the library door with two books under her arm. @p0002_1
Convenient timing. @hold
`;

function writeFile(file: string, contents: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function json(file: string, value: unknown): string {
  return writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function makeMp4(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', dest,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function makeMp3(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', dest],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function buildSeries(): void {
  const out = path.join(sdir, 'out');
  json(path.join(sdir, 'meta.json'), { title: 'Hindi Fixture', tts: { engine: 'edge' } });
  json(path.join(out, 'bible.json'), {
    characters: { zichen: { name: 'Zichen', aliases: [], role: 'protagonist' } },
  });
  // Tagged panels carry neutral captions; a separate vocabulary panel grounds
  // every word of the English script so the real fact check passes.
  json(path.join(out, 'obs_ch1.json'), {
    brief_hash: 'test',
    caption_version: 4,
    data: {
      panels: [
        { id: 'p0001_1', visual: 'Night artwork.', overlay: [], world: [], art: 0.9 },
        { id: 'p0001_2', visual: 'Boy artwork.', overlay: [], world: [], art: 0.9 },
        { id: 'p0002_1', visual: 'Girl artwork.', overlay: [], world: [], art: 0.9 },
        {
          id: 'p0009_1',
          visual: 'Vocabulary artwork.',
          overlay: ['gate midnight opens counts thousand steps'],
          world: ['shen qinghan waits library door books arm convenient timing'],
          art: 0.9,
        },
      ],
      characters: [],
      gags: [],
      events: [{ event: 'Zichen counts steps before dawn.' }],
    },
  });
  for (const id of ['p0001_1', 'p0001_2', 'p0002_1', 'p0009_1']) {
    writeFile(path.join(out, 'panels', 'ch1', `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  writeFile(path.join(out, 'ch1', 'script.md'), ENGLISH_SCRIPT);
  json(path.join(out, 'ch1', 'report.json'), {
    series: slug,
    ch: 'ch1',
    status: 'ok',
    lines: 3,
    issues: [],
    window_holes: [],
  });
}

function hindiFor(text: string): string {
  return text
    .replace('The gate opens at midnight, and Zichen counts ten thousand steps before dawn.', 'आधी रात को दरवाज़ा खुलता है, और ज़िचेन भोर से पहले दस हज़ार क़दम गिनता है।')
    .replace('Shen Qinghan waits by the library door with two books under her arm.', 'शेन चिंगहान पुस्तकालय के दरवाज़े पर दो किताबें दबाए खड़ी है।')
    .replace('Convenient timing.', 'सुविधाजनक समय।');
}

interface FakeLlm {
  fn: ReturnType<typeof vi.fn>;
  translateCalls: () => number;
  reviewVerdict: (verdict: 'accept' | 'reject') => void;
  failTranslate: (message: string) => void;
}

function fakeLlm(): FakeLlm {
  let verdict: 'accept' | 'reject' = 'accept';
  let translateError: string | null = null;
  let translateCount = 0;
  const fn = vi.fn(async (messages: unknown, options: { tag?: string }) => {
    const tag = String(options?.tag ?? '');
    if (tag.includes('review')) {
      return {
        choices: [{
          message: {
            content: JSON.stringify(
              verdict === 'accept'
                ? { verdict: 'accept', issues: [] }
                : { verdict: 'reject', issues: [{ unit: 'u0001', reason: 'meaning changed' }] },
            ),
          },
        }],
      };
    }
    if (translateError) throw new Error(translateError);
    translateCount += 1;
    const raw = (messages as Array<{ content: string }>)[0]!.content;
    const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
    if (!block) throw new Error('translate prompt missing units');
    const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            units: units.map((u) => ({ id: u.id, text: hindiFor(u.text) })),
            glossary: { names: { Zichen: 'ज़िचेन', 'Shen Qinghan': 'शेन चिंगहान' }, terms: {} },
          }),
        },
      }],
    };
  });
  return {
    fn,
    translateCalls: () => translateCount,
    reviewVerdict: (next) => {
      verdict = next;
    },
    failTranslate: (message) => {
      translateError = message;
    },
  };
}

interface FakeRenderer {
  fn: ReturnType<typeof vi.fn>;
  calls: Array<{ ch: string; voice: string; speed: number; locale: string }>;
  failNext: (n: number, message?: string) => void;
  setWarnings: (warnings: string[]) => void;
  corruptEnglish: (on: boolean) => void;
  roguePath: (on: boolean) => void;
}

function fakeRenderer(): FakeRenderer {
  const calls: FakeRenderer['calls'] = [];
  let failures = 0;
  let failureMessage = 'temporary render timeout';
  let warnings: string[] = [];
  let corrupt = false;
  let rogue = false;
  const fn = vi.fn(async (_sdir: string, ch: string, out: string, opts: {
    locale: string;
    tts: { voice_id: string; speed: number };
  }) => {
    calls.push({ ch, voice: opts.tts.voice_id, speed: opts.tts.speed, locale: opts.locale });
    if (failures > 0) {
      failures -= 1;
      throw new Error(failureMessage);
    }
    if (corrupt) {
      fs.appendFileSync(path.join(_sdir, 'out', ch, 'script.md'), '\nSneaky change.\n');
    }
    const video = rogue
      ? path.join(root, 'rogue.mp4')
      : path.join(localize.__testCanonicalDir(path.dirname(out), opts.locale, ch), 'video', 'video.mp4');
    makeMp4(video);
    return [video, 1, warnings] as [string, number, string[]];
  });
  return {
    fn,
    calls,
    failNext(n, message) {
      failures = n;
      failureMessage = message ?? 'temporary render timeout';
    },
    setWarnings(next) {
      warnings = next;
    },
    corruptEnglish(on) {
      corrupt = on;
    },
    roguePath(on) {
      rogue = on;
    },
  };
}

async function plan(chapters = 'all', voice = 'hi-IN-MadhurNeural', speed = 1): Promise<LocalizeJobRecord> {
  const planned = await localize.planLocalizeJob(sdir, { locale: 'hi-IN', chapters, voice, speed });
  return planned.job;
}

async function run(jobId: string): Promise<localize.RunJobResult> {
  return localize.runLocalizeJob(sdir, jobId, { skipPipelineConflictCheck: true, log: () => {} });
}

function chapterRecord(ch = 'ch1') {
  return readManifest(sdir).locales['hi-IN']?.chapters[ch];
}

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-core-');
  sdir = path.join(root, 'series', slug);
  fs.mkdirSync(sdir, { recursive: true });
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  buildSeries();
});

afterEach(() => {
  localize._setLlmCallForTests(null);
  localize._setRendererForTests(null);
  localize._setPreviewSynthForTests(null);
  localize._setProbeForTests(null);
  localize._setSleepForTests(null);
  localize._clearSourceCheckCache();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('locale script skeleton', () => {
  it('round-trips tags, holds, emotion controls and beat headers', () => {
    const script = `## BEAT b01_open
[deadpan] He counts ten thousand steps. @p0001_1 @p0001_2
Convenient. @hold
`;
    const parsed = parseLocaleScript(script);
    expect(parsed.units).toHaveLength(2);
    expect(parsed.beats).toEqual(['## BEAT b01_open']);
    expect(parsed.units[0]!.tags).toEqual(['@p0001_1', '@p0001_2']);
    expect(parsed.units[0]!.emotions).toEqual(['[deadpan]']);
    expect(parsed.units[1]!.hold).toBe(true);
    expect(rebuildScript(parsed, parsed.units.map((u) => u.template))).toBe(script);

    const hindi = parsed.units.map((u) =>
      u.template.replace('He counts ten thousand steps.', 'वह दस हज़ार क़दम गिनता है।').replace('Convenient.', 'सुविधाजनक।'),
    );
    expect(validateTranslation(parsed, hindi)).toEqual([]);
  });

  it('rejects dropped tags, invented holds, untranslated lines and lost numbers', () => {
    const parsed = parseLocaleScript('He counts ten thousand steps. @p0001_1\nConvenient. @hold\n');
    expect(
      validateTranslation(parsed, ['वह दस हज़ार क़दम गिनता है।', 'सुविधाजनक। ⟦H⟧'])
        .some((i) => i.code === 'tag_sequence'),
    ).toBe(true);
    expect(
      validateTranslation(parsed, ['वह दस हज़ार क़दम गिनता है। ⟦T1⟧', 'सुविधाजनक।'])
        .some((i) => i.code === 'hold_mismatch'),
    ).toBe(true);
    expect(
      validateTranslation(parsed, ['He counts ten thousand steps. ⟦T1⟧', 'सुविधाजनक। ⟦H⟧'])
        .some((i) => i.code === 'not_hindi'),
    ).toBe(true);

    const numbers = parseLocaleScript('Ten thousand kicks unlock the skill. @p0001_1\n');
    expect(validateTranslation(numbers, ['दस हज़ार क़दम से कौशल खुलता है। ⟦T1⟧'])
      .filter((i) => i.code === 'number_lost')).toEqual([]);
    expect(validateTranslation(numbers, ['कुछ क़दमों से कौशल खुलता है। ⟦T1⟧'])
      .some((i) => i.code === 'number_lost')).toBe(true);
  });

  it('compares compound Hindi numbers and Devanagari digits by value', () => {
    const parsed = parseLocaleScript('Ten thousand kicks unlock the skill. @p0001_1\n');
    for (const text of [
      'दस हज़ार क़दमों से कौशल खुलता है। ⟦T1⟧',
      'दसहज़ार क़दमों से कौशल खुलता है। ⟦T1⟧',
      '१०,००० क़दमों से कौशल खुलता है। ⟦T1⟧',
    ]) {
      expect(validateTranslation(parsed, [text]).filter((i) => i.code === 'number_lost')).toEqual([]);
    }
    // A changed magnitude is still rejected.
    expect(validateTranslation(parsed, ['एक हज़ार क़दमों से कौशल खुलता है। ⟦T1⟧'])
      .some((i) => i.code === 'number_lost')).toBe(true);
    expect(validateTranslation(parsed, ['बीस हज़ार क़दमों से कौशल खुलता है। ⟦T1⟧'])
      .some((i) => i.code === 'number_lost')).toBe(true);
  });

  it('keeps comma-separated numbers and dates as separate values (B27)', () => {
    const line =
      'A year ago on August 25, 2023, six months after Yun Minjun became a hunter, he went to meet Jeong Sia for his birthday.';
    expect([...numberValues(line)].sort((a, b) => a - b)).toEqual([6, 25, 2023]);
    const parsed = parseLocaleScript(`${line} @p0007_1\n`);
    for (const text of [
      'एक साल पहले 25 अगस्त, 2023 को, युन मिनजुन के हंटर बनने के छह महीने बाद, वह जियोंग सिया से उसके जन्मदिन पर मिलने गया। ⟦T1⟧',
      'एक साल पहले पच्चीस अगस्त, दो हज़ार तेईस को, युन मिनजुन के हंटर बनने के 6 महीने बाद, वह जियोंग सिया से मिलने गया। ⟦T1⟧',
    ]) {
      expect(validateTranslation(parsed, [text]).filter((i) => i.code === 'number_lost')).toEqual([]);
    }
    // Dropping the year is still caught.
    expect(validateTranslation(parsed, ['एक साल पहले 25 अगस्त को, छह महीने बाद, वह मिलने गया। ⟦T1⟧'])
      .find((i) => i.code === 'number_lost')?.message).toBe('number value(s) missing: 2023');
  });

  it('extracts standalone digits and only real compound number words', () => {
    const values = (text: string) => [...numberValues(text)].sort((a, b) => a - b);
    expect(values('1, 2, 3')).toEqual([1, 2, 3]);
    expect(values('August 25, 2023')).toEqual([25, 2023]);
    expect(values('3-5 days')).toEqual([3, 5]);
    expect(values('at 10:30')).toEqual([10, 30]);
    expect(values('2.5 meters')).toEqual([2.5]);
    expect(values('the 1st floor')).toEqual([1]);
    expect(values('a year ago')).toEqual([]);
    expect(values('one, two and three')).toEqual([1, 2, 3]);
    expect(values('twenty-five')).toEqual([25]);
    expect(values('two thousand twenty-three')).toEqual([2023]);
    expect(values('two hundred and five')).toEqual([205]);
    expect(values('5 thousand coins')).toEqual([5000]);
    expect(values('10,000 steps and 1,00,000 coins')).toEqual([10000, 100000]);
    expect(values('दो हज़ार तेईस')).toEqual([2023]);
    expect(values('दो लाख पचास हज़ार')).toEqual([250000]);
    expect(values('दो सौ पाँच')).toEqual([205]);
    expect(values('5 हज़ार')).toEqual([5000]);
    expect(values('दस हज़ार।')).toEqual([10000]);
    expect(values('पच्चीस, दो हज़ार तेईस')).toEqual([25, 2023]);
    expect(values('नब्बे डिग्री')).toEqual([90]);
  });

  it('still rejects a changed number', () => {
    const parsed = parseLocaleScript('He waited twenty-five days. @p0001_1\n');
    expect(validateTranslation(parsed, ['उसने 24 दिन इंतज़ार किया। ⟦T1⟧'])
      .some((i) => i.code === 'number_lost')).toBe(true);
    expect(validateTranslation(parsed, ['उसने पच्चीस दिन इंतज़ार किया। ⟦T1⟧'])
      .filter((i) => i.code === 'number_lost')).toEqual([]);
  });

  it('warns on length without blocking', () => {
    const parsed = parseLocaleScript('He walks slowly to the door and waits. @p0001_1\n');
    const issues = validateTranslation(parsed, ['वह जाता है। ⟦T1⟧']);
    expect(issues.some((i) => i.code === 'length_warning')).toBe(true);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('chapter selection', () => {
  it('accepts ranges and comma lists, honouring a retry list exactly', () => {
    const available = ['ch1', 'ch2', 'ch3', 'ch4'];
    expect(localize.parseChapterSelection('all', available)).toEqual(available);
    expect(localize.parseChapterSelection('1-2', available)).toEqual(['ch1', 'ch2']);
    expect(localize.parseChapterSelection('1,3', available)).toEqual(['ch1', 'ch3']);
    expect(localize.parseChapterSelection('1,3', available)).not.toContain('ch2');
    expect(localize.parseChapterSelection('1-2,4', available)).toEqual(['ch1', 'ch2', 'ch4']);
    expect(localize.parseChapterSelection('3,1,3', available)).toEqual(['ch1', 'ch3']);
    expect(() => localize.parseChapterSelection('1,,2', available)).toThrow(/chapters must be/);
    expect(() => localize.parseChapterSelection('1,9', available)).toThrow(/not found/);
  });
});

describe('source eligibility on the current bytes', () => {
  it('accepts a clean reviewed English source', () => {
    const check = localize.checkSourceChapter(sdir, 'ch1');
    expect(check.eligible).toBe(true);
    expect(check.scriptName).toBe('script.md');
    expect(check.parsed?.units).toHaveLength(3);
  });

  it('refuses a missing script with an actionable reason', () => {
    fs.rmSync(path.join(sdir, 'out', 'ch1', 'script.md'));
    const check = localize.checkSourceChapter(sdir, 'ch1');
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/Generate\/review the English script first/);
  });

  it('refuses a script that references unobserved panels or missing images', () => {
    writeFile(path.join(sdir, 'out', 'ch1', 'script.md'), 'The gate opens. @p9999_1\n');
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/panels the reader did not observe/);

    writeFile(path.join(sdir, 'out', 'ch1', 'script.md'), 'The gate opens. @p0001_1\n');
    fs.rmSync(path.join(sdir, 'out', 'panels', 'ch1', 'p0001_1.jpg'));
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/Panel image files are missing/);
  });

  it('re-checks the CURRENT script even when the report is clean', () => {
    // A clean report left over from an older, reviewed pass.
    json(path.join(sdir, 'out', 'ch1', 'report.json'), {
      status: 'ok', lines: 1, issues: [],
    });
    writeFile(
      path.join(sdir, 'out', 'ch1', 'script.md'),
      '## BEAT b01_gate\nHe orders the orbital cannon battery fired at the floating fortress. @p0001_1\n',
    );
    const check = localize.checkSourceChapter(sdir, 'ch1');
    // Advisories (UNGROUNDED) do not block: they are surfaced for review.
    expect(check.eligible).toBe(true);
    expect(check.advisories?.join(' ')).toMatch(/UNGROUNDED/);
  });

  it('classifies hard source findings apart from advisory style findings', () => {
    expect(localize.isHardSourceFinding('bad tag @p9999_1')).toBe(true);
    expect(localize.isHardSourceFinding('page-level tag @p0012 (writer slip: use @pXXXX_N)')).toBe(true);
    expect(localize.isHardSourceFinding('UNKNOWN emotion tag [furious] (not in the writer\'s allowed set)')).toBe(true);
    expect(localize.isHardSourceFinding('NON-ENGLISH NARRATION (3/20 lines = 15% foreign script)')).toBe(true);
    expect(localize.isHardSourceFinding('number 42 not in transcript: ...age 42...')).toBe(true);
    for (const advisory of [
      'DUB (10w overlay): The only certainty is that the weak are prey',
      'SCREENREADER (6w visual of p0066_1): A small yellow herb pouch lies dropped',
      'CAPTION/MULTI (3/10 lines with 2+ panels restate their own pictures)',
      'CAPTION: 4/12 lines restate their own panel',
      "UNGROUNDED (5w): His dad predicts he'll become a gene fuser",
      "LORE IMPORT 'Kang Min': appears in a previous script",
    ]) {
      expect(localize.isHardSourceFinding(advisory)).toBe(false);
    }
  });

  it('accepts a realistic advisory-laden report as eligible with warnings', () => {
    // Mirrors the shape of real approved chapters (DUB/SCREENREADER/UNGROUNDED).
    json(path.join(sdir, 'out', 'ch1', 'report.json'), {
      status: 'ok',
      lines: 3,
      issues: [
        'DUB (10w overlay): The only certainty is that the weak are nothing but prey',
        'SCREENREADER (6w visual of p0001_1): A small yellow herb pouch lies dropped',
        'UNGROUNDED (5w): His dad predicts he will become a gene fuser',
        'CAPTION/MULTI (3/10 lines with 2+ panels restate their own pictures)',
      ],
    });
    const check = localize.checkSourceChapter(sdir, 'ch1');
    expect(check.eligible).toBe(true);
    expect(check.advisories?.length).toBeGreaterThanOrEqual(3);
  });

  it('still blocks a hard numeric contradiction in the report', () => {
    json(path.join(sdir, 'out', 'ch1', 'report.json'), {
      status: 'ok',
      lines: 3,
      issues: ['number 42 not in transcript: ...age 42...'],
    });
    const check = localize.checkSourceChapter(sdir, 'ch1');
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/hard source problem/);
  });

  it('rejects a malformed report schema', () => {
    json(path.join(sdir, 'out', 'ch1', 'report.json'), { status: 'ok', issues: 'not-a-list' });
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/issues must be a list/);
    json(path.join(sdir, 'out', 'ch1', 'report.json'), { issues: [] });
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/missing status/);
    json(path.join(sdir, 'out', 'ch1', 'report.json'), { status: 'weird', issues: [] });
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/unknown status/);
  });

  it('refuses a failed English report', () => {
    json(path.join(sdir, 'out', 'ch1', 'report.json'), {
      status: 'failed', error: 'writer produced 0 narration lines', issues: [],
    });
    expect(localize.checkSourceChapter(sdir, 'ch1').reason).toMatch(/failed its check/);
  });

  it('uses the script the configured engine actually voiced', () => {
    json(path.join(sdir, 'meta.json'), { tts: { engine: 'edge' } });
    // A stale expressive script must not shadow script.md on an edge series.
    writeFile(path.join(sdir, 'out', 'ch1', 'script_voice.md'), 'Stale expressive line. @p0001_1\n');
    expect(localize.checkSourceChapter(sdir, 'ch1').scriptName).toBe('script.md');

    json(path.join(sdir, 'meta.json'), { tts: { engine: 'external', voice_id: 'v', command: ['x'] } });
    expect(localize.checkSourceChapter(sdir, 'ch1').scriptName).toBe('script_voice.md');
  });

  it('detects a same-size panel image replacement without clearing the memo', () => {
    const first = localize.checkSourceChapter(sdir, 'ch1');
    expect(first.eligible).toBe(true);
    const original = first.panelHash;
    // Same byte length, different content: only ino/ctime change.
    const panel = path.join(sdir, 'out', 'panels', 'ch1', 'p0001_1.jpg');
    fs.writeFileSync(panel, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const second = localize.checkSourceChapter(sdir, 'ch1');
    expect(second.panelHash).not.toBe(original);
    expect(second.eligible).toBe(true);
    // And the memo did not return the old object.
    expect(second).not.toBe(first);
  });

  it('refuses a symlinked source component', () => {
    const realPanels = path.join(root, 'panels-real');
    fs.mkdirSync(realPanels, { recursive: true });
    fs.rmSync(path.join(sdir, 'out', 'panels'), { recursive: true, force: true });
    fs.symlinkSync(realPanels, path.join(sdir, 'out', 'panels'));
    const check = localize.checkSourceChapter(sdir, 'ch1');
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/missing|not clean|observations/);
  });
});

describe('translation contract', () => {
  it('rejects extra, missing and reordered units instead of silently re-sorting', () => {
    const parsed = parseLocaleScript('One line here. @p0001_1\nTwo lines here. @p0001_1\n');
    expect(() => localize.parseTranslationAnswer(
      JSON.stringify({ units: [{ id: 'u0001', text: 'एक' }] }), parsed,
    )).toThrow(/1 units|units but the script has 2/);
    expect(() => localize.parseTranslationAnswer(
      JSON.stringify({ units: [{ id: 'u0001', text: 'एक' }, { id: 'u0003', text: 'तीन' }] }), parsed,
    )).toThrow(/must be u0002/);
    expect(() => localize.parseTranslationAnswer(
      JSON.stringify({ units: [{ id: 'u0002', text: 'दो' }, { id: 'u0001', text: 'एक' }] }), parsed,
    )).toThrow(/must be u0001/);
    expect(() => localize.parseTranslationAnswer(
      JSON.stringify({ units: [{ id: 'u0001', text: 'एक' }, { id: 'u0002', text: 'दो' }, { id: 'u0003', text: 'तीन' }] }),
      parsed,
    )).toThrow(/3 units/);
  });

  it('persists the repaired answer glossary and never overwrites agreed auto entries', async () => {
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});
    const job = await plan();
    await run(job.id);

    const autoFile = path.join(languagesRoot(sdir), 'hi-IN', 'glossary.auto.json');
    const first = JSON.parse(fs.readFileSync(autoFile, 'utf8')) as { names: Record<string, string> };
    expect(first.names.Zichen).toBe('ज़िचेन');

    // A later chapter suggesting a different pronunciation must not win.
    localize.mergeGlossary(sdir, 'hi-IN', { names: { Zichen: 'ज़ीचेन' } });
    const second = JSON.parse(fs.readFileSync(autoFile, 'utf8')) as { names: Record<string, string> };
    expect(second.names.Zichen).toBe('ज़िचेन');
  });

  it('exposes v3 prompt/renderer constants, casual Hinglish sample text and register guidance', () => {
    expect(localize.TRANSLATION_PROMPT_VERSION).toBe('hi-translate-v3');
    expect(localize.REVIEW_PROMPT_VERSION).toBe('hi-review-v3');
    expect(localize.RENDERER_REVISION).toBe('locale-render-v3');
    expect(localize.SAMPLE_TEXT_HI).toMatch(/[\u0900-\u097F]/);
    expect(localize.SAMPLE_TEXT_HI).toContain('पोर्टल');
    expect(localize.TRANSLATE_PROMPT).toContain('वो');
    expect(localize.TRANSLATE_PROMPT).toContain('पावर');
    expect(localize.TRANSLATE_PROMPT).toContain('लेवल');
    expect(localize.TRANSLATE_PROMPT).toContain('सिस्टम');
    expect(localize.TRANSLATE_PROMPT).toContain('डिसाइड करना');
    expect(localize.REVIEW_PROMPT).toContain('DETERMINISTIC ADVISORY FINDINGS');
    expect(localize.REVIEW_PROMPT).toContain('UNGROUNDED');
    expect(localize.REVIEW_PROMPT).toContain('SOURCE EVIDENCE');
    expect(localize.REVIEW_PROMPT).toContain('पावर');
  });

  it('injects the previous Hindi chapter ending before ENGLISH UNITS only when an earlier script exists, without changing translationKey', async () => {
    const out = path.join(sdir, 'out');
    fs.cpSync(path.join(out, 'obs_ch1.json'), path.join(out, 'obs_ch3.json'));
    fs.cpSync(path.join(out, 'panels', 'ch1'), path.join(out, 'panels', 'ch3'), { recursive: true });
    writeFile(path.join(out, 'ch3', 'script.md'), ENGLISH_SCRIPT);
    json(path.join(out, 'ch3', 'report.json'), {
      series: slug, ch: 'ch3', status: 'ok', lines: 3, issues: [], window_holes: [],
    });

    const prompts: string[] = [];
    const baseLlm = fakeLlm();
    localize._setLlmCallForTests(vi.fn(async (messages: unknown, options: { tag?: string }) => {
      const tag = String(options?.tag ?? '');
      if (!tag.includes('review')) {
        prompts.push((messages as Array<{ content: string }>)[0]!.content);
      }
      return baseLlm.fn(messages, options);
    }) as never);

    const checkCh3 = localize.checkSourceChapter(sdir, 'ch3');
    const keyWithoutHint = localize.translationKeyFor(checkCh3, 'hi-IN', sdir);
    await localize.translateChapter(sdir, 'hi-IN', checkCh3, keyWithoutHint);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('PREVIOUS CHAPTER ENDING');

    // Write a finished Hindi script for an earlier chapter (ch1) with 10 lines + markup.
    const ch1Lines = Array.from({ length: 10 }, (_, idx) =>
      `[deadpan] लाइन नंबर ${idx + 1} में ज़िचेन का पावर लेवल बढ़ा। @p0001_1 @hold`,
    ).join('\n');
    writeFile(
      path.join(canonicalChapterDir(sdir, 'hi-IN', 'ch1'), 'script.md'),
      `## BEAT b00_open\n${ch1Lines}\n`,
    );

    const keyWithHint = localize.translationKeyFor(checkCh3, 'hi-IN', sdir);
    expect(keyWithHint).toBe(keyWithoutHint);

    await localize.translateChapter(sdir, 'hi-IN', checkCh3, keyWithHint);
    expect(prompts).toHaveLength(2);
    const withHintPrompt = prompts[1]!;
    const contIdx = withHintPrompt.indexOf('PREVIOUS CHAPTER ENDING');
    const unitsIdx = withHintPrompt.indexOf('ENGLISH UNITS (JSON):');
    expect(contIdx).toBeGreaterThan(0);
    expect(contIdx).toBeLessThan(unitsIdx);
    // Only the last 8 narration lines, stripped of @p / [emotion] / @hold / ## BEAT.
    const contSection = withHintPrompt.slice(contIdx, unitsIdx);
    expect(contSection).not.toContain('लाइन नंबर 2 ');
    expect(contSection).toContain('लाइन नंबर 3 में ज़िचेन का पावर लेवल बढ़ा।');
    expect(contSection).toContain('लाइन नंबर 10 में ज़िचेन का पावर लेवल बढ़ा।');
    expect(contSection).not.toContain('@p0001_1');
    expect(contSection).not.toContain('@hold');
    expect(contSection).not.toContain('[deadpan]');
    expect(contSection).not.toContain('## BEAT');
  });

  it('uses [60s, 240s] retryable backoff and continues to later chapters when one chapter fails', async () => {
    const out = path.join(sdir, 'out');
    fs.cpSync(path.join(out, 'obs_ch1.json'), path.join(out, 'obs_ch2.json'));
    fs.cpSync(path.join(out, 'panels', 'ch1'), path.join(out, 'panels', 'ch2'), { recursive: true });
    writeFile(path.join(out, 'ch2', 'script.md'), ENGLISH_SCRIPT);
    json(path.join(out, 'ch2', 'report.json'), {
      series: slug, ch: 'ch2', status: 'ok', lines: 3, issues: [], window_holes: [],
    });

    const sleeps: number[] = [];
    localize._setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    localize._setLlmCallForTests(fakeLlm().fn as never);
    const renderer = fakeRenderer();
    // Fail all 3 attempts of ch1 with a retryable 503 error, then succeed on ch2.
    renderer.failNext(3, 'HTTP 503 Service Unavailable');
    localize._setRendererForTests(renderer.fn as never);

    const job = await plan('all');
    const result = await run(job.id);
    expect(sleeps).toEqual([60_000, 240_000]);
    expect(result.chapters).toEqual({ ch1: 'failed', ch2: 'completed' });
    expect(chapterRecord('ch1')?.status).toBe('failed');
    expect(chapterRecord('ch2')?.status).toBe('completed');
  });

  it('uses short waits for non-transient model failures and long waits only for transient ones', async () => {
    const sleeps: number[] = [];
    localize._setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    localize._setLlmCallForTests((async () => ({ choices: [{ message: { content: 'not json at all' } }] })) as never);
    localize._setRendererForTests(fakeRenderer().fn as never);

    const result = await run((await plan('all')).id);
    expect(result.chapters).toEqual({ ch1: 'failed' });
    expect(sleeps).toEqual([...localize.MODEL_RETRY_WAIT_MS]);
    expect(Math.max(...sleeps)).toBeLessThan(localize.RETRY_WAIT_MS[0]);
  });

  it('picks the nearest earlier finished script by chapter number and ignores temp files', () => {
    const write = (ch: string, text: string, file = 'script.md') =>
      writeFile(path.join(canonicalChapterDir(sdir, 'hi-IN', ch), file), `## BEAT b00_open\n${text}\n`);
    write('ch9', 'नौ का आखिरी सीन।');
    write('ch10', 'दस का आखिरी सीन।');
    write('ch11', 'ग्यारह अधूरा।', 'script.md.123.tmp');
    expect(localize.previousChapterEndingFor(sdir, 'hi-IN', 'ch11')).toBe('दस का आखिरी सीन।');
    expect(localize.previousChapterEndingFor(sdir, 'hi-IN', 'ch10')).toBe('नौ का आखिरी सीन।');
    expect(localize.previousChapterEndingFor(sdir, 'hi-IN', 'ch14')).toBe('दस का आखिरी सीन।');
    expect(localize.previousChapterEndingFor(sdir, 'hi-IN', 'ch9')).toBe('');
    expect(localize.previousChapterEndingFor(sdir, 'hi-IN', 'bogus')).toBe('');
    expect(localize.previousChapterEndingFor(path.join(root, 'missing'), 'hi-IN', 'ch5')).toBe('');
  });

  it('feeds chapter 1 Hindi output into chapter 2 within the same job', async () => {
    const out = path.join(sdir, 'out');
    fs.cpSync(path.join(out, 'obs_ch1.json'), path.join(out, 'obs_ch2.json'));
    fs.cpSync(path.join(out, 'panels', 'ch1'), path.join(out, 'panels', 'ch2'), { recursive: true });
    writeFile(path.join(out, 'ch2', 'script.md'), ENGLISH_SCRIPT);
    json(path.join(out, 'ch2', 'report.json'), {
      series: slug, ch: 'ch2', status: 'ok', lines: 3, issues: [], window_holes: [],
    });
    const prompts: string[] = [];
    const baseLlm = fakeLlm();
    localize._setLlmCallForTests(vi.fn(async (messages: unknown, options: { tag?: string }) => {
      if (!String(options?.tag ?? '').includes('review')) {
        prompts.push((messages as Array<{ content: string }>)[0]!.content);
      }
      return baseLlm.fn(messages, options);
    }) as never);
    localize._setSleepForTests(async () => {});
    localize._setRendererForTests(fakeRenderer().fn as never);

    const result = await run((await plan('all')).id);
    expect(result.chapters).toEqual({ ch1: 'completed', ch2: 'completed' });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('PREVIOUS CHAPTER ENDING');
    expect(prompts[1]).toContain('PREVIOUS CHAPTER ENDING');
    expect(prompts[1]).toContain('दरवाज़ा');
  });
});

describe('localize job', () => {
  it('translates, renders, verifies and leaves English artifacts byte-identical', async () => {
    const englishScript = path.join(sdir, 'out', 'ch1', 'script.md');
    const englishObs = path.join(sdir, 'out', 'obs_ch1.json');
    const before = { script: sha256File(englishScript), obs: sha256File(englishObs) };
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    const job = await plan();
    expect(job.chapters).toEqual(['ch1']);
    expect(fs.existsSync(jobPath(sdir, job.id))).toBe(true);
    const result = await run(job.id);
    expect(result.status).toBe('completed');

    const rec = chapterRecord()!;
    expect(rec.status).toBe('completed');
    expect(rec.artifact?.renderKey).toBeTruthy();
    expect(rec.artifact?.duration).toBeGreaterThan(0);
    expect(rec.artifact?.video).toBe(canonicalVideoPath(sdir, 'hi-IN', 'ch1'));
    expect(rec.artifact?.videoSha256).toBe(sha256File(rec.artifact!.video));
    expect(rec.translation?.scriptHash).toBe(
      sha256File(path.join(canonicalChapterDir(sdir, 'hi-IN', 'ch1'), 'script.md')),
    );

    const hindi = fs.readFileSync(path.join(canonicalChapterDir(sdir, 'hi-IN', 'ch1'), 'script.md'), 'utf8');
    expect(hindi).toMatch(/[\u0900-\u097F]/);
    expect(hindi).toContain('## BEAT b00_opening');
    expect(hindi).toContain('@p0001_1 @p0001_2');
    expect(hindi).toContain('@hold');
    expect(hindi).not.toContain('The gate opens at midnight');

    expect(sha256File(englishScript)).toBe(before.script);
    expect(sha256File(englishObs)).toBe(before.obs);
    expect(fs.existsSync(path.join(sdir, 'out', 'ch1', 'video', 'video.mp4'))).toBe(false);

    const state = localize.languagesState(sdir, slug, { reconcile: false });
    expect(state.versions[0]!.status).toBe('completed');
    expect(state.versions[0]!.chapters[0]!.videoUrl).toMatch(
      new RegExp(`^/media/${slug}/languages/hi-IN/ch1/video\\.mp4\\?rev=1$`),
    );
    expect(llm.translateCalls()).toBe(1);
  });

  it('calls the real renderlane.produce locale contract', async () => {
    const renderlane = await import('../src/workers/renderlane.js');
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setSleepForTests(async () => {});
    const seen: Array<{ ch: string; locale?: string | null; script: string; outDir: string }> = [];
    const originalLoad = renderlane._hooks.loadTimeline;
    const originalProbe = renderlane._hooks._probe;
    const originalRender = renderlane._hooks.renderLocal;
    renderlane._hooks.loadTimeline = async () => ({
      main: (_s: string, ch: string, script: string, _obs: string, vdir: string, opts?: Record<string, unknown>) => {
        seen.push({ ch, locale: (opts?.locale as string | undefined) ?? null, script, outDir: vdir });
        fs.mkdirSync(vdir, { recursive: true });
        fs.writeFileSync(path.join(vdir, 'shots.json'), JSON.stringify({ shots: [], audio: 'x.mp3' }));
        return path.join(vdir, 'shots.json');
      },
    });
    renderlane._hooks._probe = () => 7.5;
    renderlane._hooks.renderLocal = (_props: string, video: string) => {
      makeMp4(video);
    };
    try {
      const job = await plan('all', 'hi-IN-SwaraNeural', 1.1);
      const result = await run(job.id);
      expect(result.status).toBe('completed');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.locale).toBe('hi-IN');
      expect(seen[0]!.script).toContain(path.join('languages', 'hi-IN', 'ch1'));
      expect(seen[0]!.outDir).toBe(path.join(canonicalChapterDir(sdir, 'hi-IN', 'ch1'), 'video'));
      const rec = chapterRecord()!;
      expect(rec.artifact?.video).toBe(canonicalVideoPath(sdir, 'hi-IN', 'ch1'));
      expect(rec.artifact?.voice).toBe('hi-IN-SwaraNeural');
      expect(rec.artifact?.duration).toBeGreaterThan(0.5);
    } finally {
      renderlane._hooks.loadTimeline = originalLoad;
      renderlane._hooks._probe = originalProbe;
      renderlane._hooks.renderLocal = originalRender;
    }
  });

  it('reuses the reviewed translation when only the voice changes', async () => {
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan('all', 'hi-IN-MadhurNeural')).id);
    await run((await plan('all', 'hi-IN-SwaraNeural')).id);
    expect(llm.translateCalls()).toBe(1);
    expect(renderer.calls.map((c) => c.voice)).toEqual(['hi-IN-MadhurNeural', 'hi-IN-SwaraNeural']);
    expect(chapterRecord()!.artifact?.revision).toBe(2);
  });

  it('retranslates when the English script changes and marks the old video stale', async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    writeFile(
      path.join(sdir, 'out', 'ch1', 'script.md'),
      ENGLISH_SCRIPT.replace('@p0002_1', '@p0002_1 @p0001_1'),
    );
    const stale = localize.languagesState(sdir, slug, { reconcile: false });
    expect(stale.versions[0]!.chapters[0]!.stale).toBe(true);
    expect(stale.versions[0]!.chapters[0]!.videoUrl).toBeTruthy();

    await run((await plan()).id);
    expect(llm.translateCalls()).toBe(2);
  });

  it('re-renders (without retranslating) when the promo block changes', async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    json(path.join(sdir, 'out', 'promo_block.json'), { rules: [{ text: 'READ ON SITE' }] });
    await run((await plan()).id);
    const first = chapterRecord()!.artifact!;

    json(path.join(sdir, 'out', 'promo_block.json'), { rules: [{ text: 'READ ON SITE' }, { text: 'NEW BANNER' }] });
    localize._clearSourceCheckCache();
    expect(localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!.chapters[0]!.stale).toBe(true);

    await run((await plan()).id);
    expect(llm.translateCalls()).toBe(1);
    expect(chapterRecord()!.artifact!.revision).toBe(first.revision + 1);
  });

  it('rejects a same-sized replacement of a published video', async () => {
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});
    await run((await plan()).id);
    const artifact = chapterRecord()!.artifact!;
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')?.revision).toBe(artifact.revision);

    // Overwrite with different bytes of the SAME length.
    const bytes = fs.readFileSync(artifact.video);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(artifact.video, bytes);
    expect(fs.statSync(artifact.video).size).toBe(artifact.size);

    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')).toBeNull();
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!.chapters[0]!;
    expect(view.videoUrl).toBeUndefined();
  });

  it('retranslates when a panel image changes, without a translation for a voice-only change', async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    writeFile(
      path.join(sdir, 'out', 'panels', 'ch1', 'p0001_1.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0xd9]),
    );
    const stale = localize.languagesState(sdir, slug, { reconcile: false });
    expect(stale.versions[0]!.chapters[0]!.stale).toBe(true);
    // Translation identity excludes panels, so the cached translation is reused.
    await run((await plan()).id);
    expect(llm.translateCalls()).toBe(1);
  });

  it('keeps the last good video streaming after a failed regeneration', async () => {
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    const first = chapterRecord()!.artifact!;

    // Force a regeneration (new voice) that fails every attempt.
    renderer.failNext(10, 'render provider exploded');
    const failed = await run((await plan('all', 'hi-IN-SwaraNeural')).id);
    expect(failed.status).toBe('failed');

    const rec = chapterRecord()!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/exploded/);
    expect(rec.artifact?.video).toBe(first.video);
    expect(rec.artifact?.revision).toBe(first.revision);
    expect(rec.stale).toBe(true);

    // The API still advertises the previous video, and it is still streamable.
    const state = localize.languagesState(sdir, slug, { reconcile: false });
    const view = state.versions[0]!.chapters[0]!;
    expect(view.status).toBe('failed');
    expect(view.videoUrl).toContain(`rev=${first.revision}`);
    expect(view.stale).toBe(true);
    const resolved = localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1');
    expect(resolved?.file).toBe(first.video);
    expect(fs.statSync(resolved!.file).size).toBe(first.size);
  });

  it('keeps the last good video after a translation failure', async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    const first = chapterRecord()!.artifact!;

    // New English script + a translator that cannot produce valid Hindi.
    writeFile(
      path.join(sdir, 'out', 'ch1', 'script.md'),
      ENGLISH_SCRIPT.replace('@p0002_1', '@p0002_1 @p0001_1'),
    );
    llm.reviewVerdict('reject');
    const failed = await run((await plan()).id);
    expect(failed.status).toBe('failed');
    const rec = chapterRecord()!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/semantic review/);
    expect(rec.artifact?.video).toBe(first.video);
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')?.file).toBe(first.video);
  });

  it('lets the semantic reviewer reject an invented source fact behind advisories', async () => {
    // Realistic approved-shape report: advisory findings only.
    json(path.join(sdir, 'out', 'ch1', 'report.json'), {
      status: 'ok',
      lines: 3,
      issues: ['UNGROUNDED (5w): Zichen activates the orbital cannon battery'],
    });
    let reviewerPrompt = '';
    const fn = vi.fn(async (messages: unknown, options: { tag?: string }) => {
      const raw = (messages as Array<{ content: string }>)[0]!.content;
      if (String(options?.tag ?? '').includes('review')) {
        reviewerPrompt = raw;
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                verdict: 'reject',
                issues: [{ unit: 'source', reason: 'orbital cannon is not in the source evidence' }],
              }),
            },
          }],
        };
      }
      const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
      const units = JSON.parse(block![1]!) as Array<{ id: string; text: string }>;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              units: units.map((u) => ({ id: u.id, text: hindiFor(u.text) })),
              glossary: { names: {}, terms: {} },
            }),
          },
        }],
      };
    });
    localize._setLlmCallForTests(fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    const result = await run((await plan()).id);
    expect(result.status).toBe('failed');
    expect(chapterRecord()!.error).toMatch(/semantic review/);
    // The reviewer saw the advisory AND the source evidence, not just English text.
    expect(reviewerPrompt).toContain('DETERMINISTIC ADVISORY FINDINGS');
    expect(reviewerPrompt).toContain('UNGROUNDED');
    expect(reviewerPrompt).toContain('SOURCE EVIDENCE');
    expect(reviewerPrompt).toContain('Zichen counts steps before dawn');
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')).toBeNull();
  });

  it('never renders an edited or unverified localized script from cache', async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    const script = path.join(canonicalChapterDir(sdir, 'hi-IN', 'ch1'), 'script.md');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('आधी रात', 'दोपहर'));
    // Same identity, but the bytes no longer match the reviewed proof.
    await run((await plan()).id);
    expect(llm.translateCalls()).toBe(2);
    expect(fs.readFileSync(script, 'utf8')).toContain('आधी रात');
  });

  it('retries a transient render failure without retranslating', async () => {
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    renderer.failNext(1);
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    const result = await run((await plan()).id);
    expect(result.status).toBe('completed');
    expect(renderer.calls).toHaveLength(2);
    expect(llm.translateCalls()).toBe(1);
  });

  it('surfaces renderer warnings in the state', async () => {
    const renderer = fakeRenderer();
    renderer.setWarnings(['dropped 2 unshowable panels']);
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.voice).toBe('hi-IN-MadhurNeural');
    expect(view.speed).toBe(1);
    expect(view.chapters[0]!.warnings).toContain('dropped 2 unshowable panels');
  });

  it('refuses a renderer path outside the locale directory', async () => {
    const renderer = fakeRenderer();
    renderer.roguePath(true);
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    const result = await run((await plan()).id);
    expect(result.status).toBe('failed');
    expect(chapterRecord()!.error).toMatch(/instead of the locale video/);
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')).toBeNull();
  });

  it('refuses to publish when a renderer mutates English artifacts', async () => {
    const renderer = fakeRenderer();
    renderer.corruptEnglish(true);
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    const result = await run((await plan()).id);
    expect(result.status).toBe('failed');
    expect(chapterRecord()!.error).toMatch(/modified English artifacts/);
  });
});

describe('job state transitions', () => {
  it('reports the newest job attempt over an older completed record', async () => {
    localize._setLlmCallForTests(fakeLlm().fn as never);
    const renderer = fakeRenderer();
    localize._setRendererForTests(renderer.fn as never);
    localize._setSleepForTests(async () => {});

    await run((await plan()).id);
    expect(localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!.status).toBe('completed');

    // A retry that fails must NOT keep showing "completed" from the old record.
    renderer.failNext(10, 'render failed');
    await run((await plan('all', 'hi-IN-SwaraNeural')).id);
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.status).toBe('failed');
    expect(view.chapters[0]!.status).toBe('failed');
    expect(view.chapters[0]!.videoUrl).toBeTruthy();
  });

  it('shows queued chapters of an in-flight job, not the old record', async () => {
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});
    await run((await plan()).id);

    const job = await plan('all', 'hi-IN-SwaraNeural');
    // Simulate the job having started but not yet reached ch1.
    writeJob(sdir, {
      ...job,
      status: 'running',
      stage: 'validate',
      pid: process.pid,
      pidStart: null,
      progress: { ch1: { status: 'queued', updatedAt: new Date().toISOString() } },
    });
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.status).toBe('queued');
    expect(view.chapters[0]!.status).toBe('queued');
  });

  it('marks a dead running job interrupted in BOTH the job and the manifest', () => {
    const job: LocalizeJobRecord = {
      schemaVersion: 1,
      id: 'loc-1700000000000-abcdef01',
      slug,
      locale: 'hi-IN',
      chapters: ['ch1'],
      voice: 'hi-IN-MadhurNeural',
      speed: 1,
      status: 'running',
      stage: 'render',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: {},
      pid: 999_999_999,
      pidStart: 1,
      progress: { ch1: { status: 'running', stage: 'render', updatedAt: new Date().toISOString() } },
    };
    writeJob(sdir, job);
    localize.reconcileLocalizeJobs(sdir);
    expect(readJob(sdir, job.id)?.status).toBe('interrupted');
    const rec = chapterRecord()!;
    expect(rec.status).toBe('interrupted');
    expect(rec.error).toMatch(/exited before finishing/);
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.status).toBe('interrupted');
  });

  it('marks a never-started queued job interrupted after the grace period', () => {
    const stale = new Date(Date.now() - 600_000).toISOString();
    const job: LocalizeJobRecord = {
      schemaVersion: 1,
      id: 'loc-1700000000001-abcdef02',
      slug,
      locale: 'hi-IN',
      chapters: ['ch1'],
      voice: 'hi-IN-MadhurNeural',
      speed: 1,
      status: 'queued',
      createdAt: stale,
      updatedAt: stale,
      attempts: {},
      progress: { ch1: { status: 'queued', updatedAt: stale } },
    };
    writeJob(sdir, job);
    localize.reconcileLocalizeJobs(sdir);
    expect(readJob(sdir, job.id)?.status).toBe('interrupted');
    expect(chapterRecord()!.status).toBe('interrupted');
  });

  it('rejects a second job while one is active and an English pipeline conflict', async () => {
    const first = await plan();
    await expect(plan('all', 'hi-IN-SwaraNeural')).rejects.toMatchObject({ code: 'job_active' });

    fs.rmSync(jobPath(sdir, first.id));
    json(path.join(root, 'out', 'jobs', 'job-1-aaaaaaaa.json'), {
      schemaVersion: 1, id: 'job-1-aaaaaaaa', slug, status: 'running', createdAt: 1, updatedAt: 1,
    });
    await expect(plan()).rejects.toMatchObject({ statusCode: 409, code: 'pipeline_conflict' });
  });

  it('rejects a persisted job whose ids/paths do not match its file', () => {
    const file = jobPath(sdir, 'loc-1700000000002-abcdef03');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      id: 'loc-9999999999999-ffffffff',
      slug,
      locale: 'hi-IN',
      chapters: ['ch1'],
      voice: 'hi-IN-MadhurNeural',
      speed: 1,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    expect(readJob(sdir, 'loc-1700000000002-abcdef03')).toBeNull();
    expect(() => jobPath(sdir, '../escape')).toThrow(/Invalid language-version job id/);
  });

  it('rejects unsupported locale, voice and speed', async () => {
    await expect(localize.planLocalizeJob(sdir, {
      locale: 'fr-FR', chapters: 'all', voice: 'hi-IN-MadhurNeural',
    })).rejects.toMatchObject({ code: 'unsupported_locale' });
    await expect(localize.planLocalizeJob(sdir, {
      locale: 'hi-IN', chapters: 'all', voice: 'en-US-AndrewMultilingualNeural',
    })).rejects.toMatchObject({ code: 'unsupported_voice' });
    await expect(localize.planLocalizeJob(sdir, {
      locale: 'hi-IN', chapters: 'all', voice: 'hi-IN-MadhurNeural', speed: 9,
    })).rejects.toMatchObject({ code: 'invalid_speed' });
  });

  it('refuses to plan when a chapter source is not eligible', async () => {
    fs.rmSync(path.join(sdir, 'out', 'ch1', 'script.md'));
    await expect(plan()).rejects.toMatchObject({ statusCode: 422, code: 'source_not_eligible' });
  });
});

describe('media + preview', () => {
  it('serves only the verified artifact and rejects a size mismatch', async () => {
    localize._setLlmCallForTests(fakeLlm().fn as never);
    localize._setRendererForTests(fakeRenderer().fn as never);
    localize._setSleepForTests(async () => {});
    await run((await plan()).id);

    const good = localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1');
    expect(good?.file).toBe(canonicalVideoPath(sdir, 'hi-IN', 'ch1'));
    expect(good?.duration).toBeGreaterThan(0);

    fs.appendFileSync(good!.file, Buffer.alloc(16));
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')).toBeNull();
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch2')).toBeNull();
  });

  it('refuses a manifest artifact path that is not canonical', () => {
    const elsewhere = path.join(root, 'elsewhere.mp4');
    makeMp4(elsewhere);
    const manifestFile = path.join(languagesRoot(sdir), 'manifest.json');
    json(manifestFile, {
      schemaVersion: 1,
      locales: {
        'hi-IN': {
          updatedAt: new Date().toISOString(),
          chapters: {
            ch1: {
              status: 'completed',
              updatedAt: new Date().toISOString(),
              artifact: {
                video: elsewhere,
                duration: 1,
                size: fs.statSync(elsewhere).size,
                videoSha256: sha256File(elsewhere),
                renderKey: 'x',
                voice: 'hi-IN-MadhurNeural',
                speed: 1,
                revision: 1,
                publishedAt: new Date().toISOString(),
              },
            },
          },
        },
      },
    });
    expect(readManifest(sdir).locales['hi-IN']?.chapters.ch1?.artifact).toBeUndefined();
    expect(localize.resolveLocaleVideo(sdir, 'hi-IN', 'ch1')).toBeNull();
  });

  it('generates a cached Hindi preview through the synth seam', async () => {
    localize._setPreviewSynthForTests(async (_text, dest) => {
      makeMp3(dest);
    });
    const first = await localize.generateLanguagePreview(sdir, slug, {
      locale: 'hi-IN', voice: 'hi-IN-MadhurNeural', speed: 1,
    });
    expect(first.cached).toBe(false);
    expect(first.url).toMatch(/^\/media\/hindi-fixture\/languages\/hi-IN\/preview\/[a-f0-9]{64}\.mp3$/);
    expect(localize.resolvePreviewFile(sdir, 'hi-IN', first.id)).toBeTruthy();
    const second = await localize.generateLanguagePreview(sdir, slug, {
      locale: 'hi-IN', voice: 'hi-IN-MadhurNeural', speed: 1,
    });
    expect(second.cached).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('bounds a hanging preview generation, keeps the server responsive and cleans up', async () => {
    localize._setPreviewTimeoutForTests(150);
    const pending: Array<() => void> = [];
    localize._setPreviewSynthForTests(() => new Promise<void>((resolve) => {
      pending.push(resolve);
    }));
    try {
      const started = Date.now();
      const hanging = localize.generateLanguagePreview(sdir, slug, {
        locale: 'hi-IN', voice: 'hi-IN-MadhurNeural', speed: 1,
      });
      // The event loop stays free while generation hangs.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(Date.now() - started).toBeLessThan(1000);

      // A second request while the first holds the lock is refused, not queued.
      await expect(localize.generateLanguagePreview(sdir, slug, {
        locale: 'hi-IN', voice: 'hi-IN-MadhurNeural', speed: 1,
      })).rejects.toMatchObject({ statusCode: 429 });

      await expect(hanging).rejects.toMatchObject({ statusCode: 504, code: 'preview_timeout' });
      const dir = path.join(languagesRoot(sdir), 'hi-IN', 'previews');
      const leftovers = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      for (const resolve of pending) resolve();
      localize._setPreviewTimeoutForTests(null);
    }
  });
});

describe('store safety', () => {
  it('keeps state under out/languages and sorts chapters naturally', () => {
    expect(languagesRoot(sdir)).toBe(path.join(sdir, 'out', 'languages'));
    expect(sortChapters(['ch10', 'ch2', 'ch1'])).toEqual(['ch1', 'ch2', 'ch10']);
  });

  it('refuses to write through a symlinked language directory', async () => {
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(sdir, 'out'), { recursive: true });
    fs.symlinkSync(target, path.join(sdir, 'out', 'languages'));
    await expect(plan()).rejects.toMatchObject({
      message: expect.stringMatching(/symbolic link/),
    });
  });

  it('refuses a symlinked leaf job file', () => {
    const jobs = path.join(languagesRoot(sdir), 'jobs');
    fs.mkdirSync(jobs, { recursive: true });
    const outside = path.join(root, 'job.json');
    fs.writeFileSync(outside, JSON.stringify({ schemaVersion: 1 }));
    fs.symlinkSync(outside, path.join(jobs, 'loc-1700000000003-abcdef04.json'));
    expect(readJob(sdir, 'loc-1700000000003-abcdef04')).toBeNull();
  });
});
