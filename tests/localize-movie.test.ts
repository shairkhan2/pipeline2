/**
 * Movie-mode parity for language versions: the dub's render identity uses the
 * same visual defaults as the English timeline, and the translation prompt keeps
 * a movie chapter continuous (no per-chapter openings, recaps or hooks).
 * No real LLM, TTS or render runs here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import * as localize from '../src/stages/localize.js';
import { parseLocaleScript } from '../src/stages/localeScript.js';

let root: string;
let sdir: string;

function writeMeta(meta: unknown): void {
  fs.writeFileSync(path.join(sdir, 'meta.json'), JSON.stringify(meta, null, 2));
}

const check = { panelHash: 'panels' } as never;

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/lang-movie-');
  sdir = path.join(root, 'series', 'movie-fixture');
  fs.mkdirSync(path.join(sdir, 'out'), { recursive: true });
  vi.stubEnv('MANHWA_RENDER_QUALITY', '1080p');
});

afterEach(() => {
  localize._setLlmCallForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('locale render config matches the English movie defaults', () => {
  it('defaults motion to window when meta.json has no motion', () => {
    writeMeta({ title: 'x' });
    const config = localize.renderConfig(sdir, check);
    expect(config.motion).toBe('window');
    expect(config.background).toBe('starfield');
    expect(config.animation).toBeUndefined();
    expect(config.music).toBeUndefined();
  });

  it('keeps a saved motion and background', () => {
    writeMeta({ visuals: { motion: 'cut', background: 'blur' } });
    const config = localize.renderConfig(sdir, check);
    expect(config.motion).toBe('cut');
    expect(config.background).toBe('blur');
  });

  it('puts visuals.animation and music into the render key', () => {
    writeMeta({ visuals: { motion: 'window' } });
    const plain = localize.renderConfig(sdir, check);
    const plainKey = localize.renderKeyFor('tk', 'v', 1, plain);

    writeMeta({ visuals: { motion: 'window', animation: { entry: 'fade', pushIn: 'subtle' } } });
    const anim = localize.renderConfig(sdir, check);
    expect(anim.animation).toEqual(expect.any(String));
    const animKey = localize.renderKeyFor('tk', 'v', 1, anim);
    expect(animKey).not.toBe(plainKey);

    writeMeta({ visuals: { motion: 'window', animation: { entry: 'slide-up', pushIn: 'subtle' } } });
    expect(localize.renderKeyFor('tk', 'v', 1, localize.renderConfig(sdir, check))).not.toBe(animKey);

    writeMeta({ visuals: { motion: 'window', animation: { pushIn: 'subtle', entry: 'fade' } } });
    expect(localize.renderKeyFor('tk', 'v', 1, localize.renderConfig(sdir, check))).toBe(animKey);

    writeMeta({ visuals: { motion: 'window', animation: { bogus: true } } });
    const invalid = localize.renderConfig(sdir, check);
    expect(invalid.animation).toBeUndefined();
    expect(localize.renderKeyFor('tk', 'v', 1, invalid)).toBe(plainKey);

    writeMeta({ visuals: { motion: 'window' }, music: { enabled: true, file: 'music/bed.mp3', volume: 0.1 } });
    const music = localize.renderConfig(sdir, check);
    expect(music.music).toEqual(expect.any(String));
    expect(localize.renderKeyFor('tk', 'v', 1, music)).not.toBe(plainKey);
  });

  it('keeps the historical render key when animation and music are unset', () => {
    const config = {
      background: 'starfield', motion: 'cut', quality: '1080p', cleaner: 'c', promo: 'p', panels: 'x',
    };
    const withUndefined = { ...config, animation: undefined, music: undefined };
    expect(localize.renderKeyFor('tk', 'v', 1, withUndefined)).toBe(localize.renderKeyFor('tk', 'v', 1, config));
  });
});

describe('movie-mode translation prompt', () => {
  const MOVIE = '# STORY_UNITS v1\n## BEAT b01_turn\nShe keeps walking toward the gate. @p0001_1\n';
  const EPISODE = '## BEAT b01_turn\nShe keeps walking toward the gate. @p0001_1\n';

  function sourceCheck(scriptText: string) {
    return {
      eligible: true,
      chapter: 'ch2',
      parsed: parseLocaleScript(scriptText),
      scriptText,
      scriptHash: 'h',
      bible: {},
      obs: { events: [{ event: 'She walks toward the gate.' }] },
      transcript: '',
      advisories: [],
      warnings: [],
    } as never;
  }

  async function promptFor(scriptText: string): Promise<string> {
    const prompts: string[] = [];
    localize._setLlmCallForTests(vi.fn(async (messages: unknown, options: { tag?: string }) => {
      const content = (messages as Array<{ content: string }>)[0]!.content;
      if (String(options?.tag ?? '').includes('review')) {
        return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', issues: [] }) } }] };
      }
      prompts.push(content);
      const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(content)!;
      const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              units: units.map((u) => ({ id: u.id, text: u.text.replace('She keeps walking toward the gate.', 'वो गेट की तरफ़ चलती रहती है।') })),
              glossary: { names: {}, terms: {} },
            }),
          },
        }],
      };
    }) as never);
    await localize.translateChapter(sdir, 'hi-IN', sourceCheck(scriptText), 'key', {
      previousChapterEnding: 'वो रुक गई।',
    });
    return prompts[0]!;
  }

  it('detects the movie script header', () => {
    expect(localize.isMovieScript(MOVIE)).toBe(true);
    expect(localize.isMovieScript(EPISODE)).toBe(false);
    expect(localize.isMovieScript(undefined)).toBe(false);
  });

  it('adds the continuity rule for a movie chapter, before the previous ending and units', async () => {
    const prompt = await promptFor(MOVIE);
    const ruleIdx = prompt.indexOf(localize.MOVIE_CONTINUITY_RULE);
    const endingIdx = prompt.indexOf('PREVIOUS CHAPTER ENDING');
    const unitsIdx = prompt.indexOf('ENGLISH UNITS (JSON):');
    expect(ruleIdx).toBeGreaterThan(0);
    expect(ruleIdx).toBeLessThan(endingIdx);
    expect(endingIdx).toBeLessThan(unitsIdx);
    expect(localize.MOVIE_CONTINUITY_RULE).toMatch(/Do NOT add an opening/);
    expect(localize.MOVIE_CONTINUITY_RULE).toMatch(/closing hook/);
  });

  it('leaves episode-style prompts unchanged', async () => {
    const prompt = await promptFor(EPISODE);
    expect(prompt).not.toContain('MOVIE MODE');
    expect(prompt).toContain('PREVIOUS CHAPTER ENDING');
  });
});
