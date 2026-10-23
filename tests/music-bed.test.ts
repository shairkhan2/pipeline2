import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MUSIC_VOLUME, MAX_MUSIC_VOLUME, MUSIC_PROVIDERS, resolveMusicBed } from '../src/stages/music.js';

describe('music bed (disabled by default)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/opencode/music-');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(MUSIC_PROVIDERS)) delete MUSIC_PROVIDERS[k];
  });

  it('is off when nothing opts in', async () => {
    expect((await resolveMusicBed({}, dir, {})).bed).toBeNull();
    expect((await resolveMusicBed({ music: { file: 'x.mp3' } }, dir, {})).reason).toBe('music disabled');
  });

  it('MUSIC_BED=off always wins over meta', async () => {
    fs.writeFileSync(path.join(dir, 'bed.mp3'), 'x');
    const d = await resolveMusicBed({ music: { enabled: true, file: 'bed.mp3' } }, dir, { MUSIC_BED: 'off' });
    expect(d.bed).toBeNull();
  });

  it('uses a local file when enabled, with clamped volume', async () => {
    fs.writeFileSync(path.join(dir, 'bed.mp3'), 'x');
    const d = await resolveMusicBed({ music: { enabled: true, file: 'bed.mp3', volume: 5 } }, dir, {});
    expect(d.bed).toEqual({ file: path.join(dir, 'bed.mp3'), volume: MAX_MUSIC_VOLUME });
    const e = await resolveMusicBed({ music: { enabled: true, file: 'bed.mp3' } }, dir, {});
    expect(e.bed?.volume).toBe(DEFAULT_MUSIC_VOLUME);
  });

  it('degrades with a reason when the file or provider is missing', async () => {
    expect((await resolveMusicBed({ music: { enabled: true, file: 'nope.mp3' } }, dir, {})).reason).toMatch(/missing/);
    expect((await resolveMusicBed({ music: { enabled: true, provider: 'suno' } }, dir, {})).reason).toMatch(/not available yet/);
    expect((await resolveMusicBed({ music: { enabled: true } }, dir, {})).reason).toMatch(/no file or provider/);
  });

  it('calls a registered provider and never throws when it fails', async () => {
    const out = path.join(dir, 'gen.mp3');
    MUSIC_PROVIDERS.fake = async () => {
      fs.writeFileSync(out, 'x');
      return out;
    };
    MUSIC_PROVIDERS.broken = async () => {
      throw new Error('quota');
    };
    expect((await resolveMusicBed({ music: { enabled: true, provider: 'fake' } }, dir, {})).bed?.file).toBe(out);
    expect((await resolveMusicBed({ music: { enabled: true, provider: 'broken' } }, dir, {})).reason).toMatch(/quota/);
  });
});
