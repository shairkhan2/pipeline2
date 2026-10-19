/** Existing-series extension, character-focused outro plans and atomic video merging. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  IntakeError, ConflictError, createJob, downloadGdriveZip, existingChapterNumbers,
  parseGdriveUrl, resolveTtsSelection, runCommand, validateChaptersSpec, withJobMetaLock, reconcileJobs,
  type EnqueueOptions, type Env,
} from '../intake/intake.js';
import { archiveIndex, ingest, parseChapterSpec } from '../intake/ingest.js';
import { BlockingIOError, validateSlug, withExclusiveSeriesLock } from '../locks/seriesLock.js';
import { assertNoSymlinks } from './storageTrash.js';

export interface SeriesOptions { seriesRoot: string; slug: string }
export interface SelectedOutroPanel {
  chapter: string;
  panelFile: string;
  /** Alias of `panelFile` so either frontend key lookup resolves. */
  panel: string;
  characterNames: string[];
  /** Alias of `characterNames` so either frontend key lookup resolves. */
  characters: string[];
  reason: string;
  previewUrl: string;
  /** Alias of `previewUrl` so either frontend key lookup resolves. */
  url: string;
}
export interface OutroOptions extends SeriesOptions {
  totalChapters?: number;
  coveredChapters?: number;
  hookType?: 'part2' | 'next_chapter' | 'new_series' | 'custom';
  customNote?: string;
  /** Title of the next series announced by a `new_series` hook. */
  nextSeriesTitle?: string;
  /** TTS provider and voice override for the outro narration. */
  provider?: string;
  voice?: string;
  renderVideo?: boolean;
  /** Disable narration for an offline, silent panel showcase. */
  synthesizeAudio?: boolean;
}
type Json = Record<string, any>;
const imageRe = /\.(png|jpe?g|webp|avif)$/i;

function readJson(file: string): Json {
  assertNoSymlinks(file);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function resolveSeriesDir(opts: SeriesOptions): string {
  if (!validateSlug(opts.slug)) throw new IntakeError('Invalid series slug');
  const dir = path.resolve(opts.seriesRoot, opts.slug);
  assertNoSymlinks(dir);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) throw new IntakeError('Series not found', 404);
  return dir;
}

function regularFile(file: string): boolean {
  assertNoSymlinks(file);
  try { return fs.lstatSync(file).isFile() && fs.lstatSync(file).size > 0; } catch { return false; }
}

function namesIn(dir: string): string[] {
  assertNoSymlinks(dir);
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Build the panel record with both key spellings the frontends read. */
function selectedPanel(chapter: string, panelFile: string, characterNames: string[], reason: string, slug: string): SelectedOutroPanel {
  const previewUrl = `/api/series/${encodeURIComponent(slug)}/panels/${panelFile.split('/').map(encodeURIComponent).join('/')}`;
  return { chapter, panelFile, panel: panelFile, characterNames, characters: characterNames, reason, previewUrl, url: previewUrl };
}

function characterList(bible: Json): Array<{ name: string; description: string; aliases: string[]; role: string }> {
  const raw = bible.characters || bible.mainCharacters || bible.main_characters || {};
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v] as const) : Object.entries(raw);
  return entries.map(([key, value]) => {
    const c = typeof value === 'string' ? { name: value } : value as Json;
    return { name: String(c?.name || key), description: String(c?.description || c?.visual || c?.role || ''),
      aliases: Array.isArray(c?.aliases) ? c.aliases.map(String) : [], role: String(c?.role || '') };
  }).sort((a, b) => Number(/main|protagonist|hero/i.test(b.role)) - Number(/main|protagonist|hero/i.test(a.role)));
}

function findPanel(dir: string, chapter: string, panel: Json): string | null {
  const raw = String(panel.panelFile || panel.file || panel.image || panel.panel || panel.id || '');
  if (!raw || path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) return null;
  const candidates: string[] = [path.join(dir, raw)];
  for (const base of [path.join(dir, 'out', 'panels', chapter), path.join(dir, 'out', chapter, 'panels'), path.join(dir, chapter)]) {
    for (const name of imageRe.test(raw) ? [raw] : [raw + '.png', raw + '.webp', raw + '.jpg', raw + '.jpeg']) {
      candidates.push(path.join(base, name));
    }
  }
  return candidates.find((f) => f.startsWith(dir + path.sep) && imageRe.test(f) && regularFile(f)) || null;
}

/** Inspect cached reader observations without making LLM calls or changing series caches. */
export function inspectSeriesOutro(opts: OutroOptions) {
  const dir = resolveSeriesDir(opts);
  const meta = readJson(path.join(dir, 'meta.json'));
  const bible = readJson(path.join(dir, 'out', 'bible.json'));
  const characters = characterList(bible);
  const candidates: Array<SelectedOutroPanel & { score: number }> = [];
  const obsFiles = namesIn(path.join(dir, 'out')).filter((name) => /^obs_ch\d+\.json$/i.test(name));
  for (const name of obsFiles) {
    const chapter = /^obs_(ch\d+)\.json$/i.exec(name)![1];
    const cache = readJson(path.join(dir, 'out', name));
    const panels = (cache.data || cache).panels;
    if (!Array.isArray(panels)) continue;
    for (const p of panels as Json[]) {
      if (!p || p.skip === true || p.promo_page === true || /^(credit|credits|promo|system)$/i.test(String(p.kind || ''))) continue;
      const file = findPanel(dir, chapter, p);
      if (!file) continue;
      const declared = Array.isArray(p.characters) ? p.characters.map((c: any) => String(typeof c === 'string' ? c : c?.name || c?.id || '')) : [];
      const text = [...declared, p.visual || '', p.description || '', p.caption || ''].join(' ').toLowerCase();
      const characterNames = characters.filter((c) => [c.name, ...c.aliases].some((n) => n.length > 1 && text.includes(n.toLowerCase()))).map((c) => c.name);
      const framing = String(p.framing || p.shot || '').toLowerCase().replace(/[\s_-]/g, '');
      const focused = framing === 'closeup' || framing === 'medium';
      const weight = Math.max(0, Math.min(10, Number(p.weight || p.visualWeight || 0) || 0));
      const score = characterNames.length * 100 + (declared.length ? 20 : 0) + (focused ? 30 : 0) + weight;
      const panelFile = path.relative(dir, file).split(path.sep).join('/');
      candidates.push({ ...selectedPanel(chapter, panelFile, characterNames,
        [characterNames.length ? `Named character: ${characterNames.join(', ')}` : 'Narrative artwork', focused ? `${framing} character framing` : '', weight ? 'High visual weight' : ''].filter(Boolean).join('; '),
        opts.slug), score });
    }
  }
  if (!obsFiles.length) {
    for (const n of existingChapterNumbers(dir)) {
      const chapter = `ch${n}`;
      const sliced = namesIn(path.join(dir, 'out', 'panels', chapter)).filter((f) => imageRe.test(f));
      const base = sliced.length ? path.join(dir, 'out', 'panels', chapter) : path.join(dir, chapter);
      const images = (sliced.length ? sliced : namesIn(base).filter((f) => imageRe.test(f))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const middle = Math.floor(images.length / 2);
      for (const i of [middle, middle - 1, middle + 1]) {
        if (!images[i] || (images.length > 2 && (i === 0 || i === images.length - 1))) continue;
        const file = path.join(base, images[i]);
        if (!regularFile(file)) continue;
        const panelFile = path.relative(dir, file).split(path.sep).join('/');
        candidates.push({ ...selectedPanel(chapter, panelFile, [],
          'Middle narrative panel (reader observations not available yet)', opts.slug),
          score: 10 - Math.abs(i - middle) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || Number(a.chapter.slice(2)) - Number(b.chapter.slice(2)) || a.panelFile.localeCompare(b.panelFile));
  const seen = new Set<string>();
  const selectedPanels = candidates.filter((p) => !seen.has(p.panelFile) && Boolean(seen.add(p.panelFile))).slice(0, 6).map(({ score: _score, ...p }) => p);
  const plan = readJson(path.join(dir, 'out', 'outro', 'outro-plan.json'));
  return { slug: opts.slug, title: String(meta.title || bible.title || opts.slug), characters, selectedPanels,
    panels: selectedPanels,
    availableChapters: existingChapterNumbers(dir).map((n) => `ch${n}`),
    plan: Object.keys(plan).length ? plan : null,
    script: typeof plan.script === 'string' ? plan.script : '',
    hookType: plan.hookType ?? null, totalChapters: plan.totalChapters ?? null, coveredChapters: plan.coveredChapters ?? null,
    nextSeriesTitle: typeof plan.nextSeriesTitle === 'string' ? plan.nextSeriesTitle : null,
    provider: typeof plan.provider === 'string' ? plan.provider : null,
    voice: typeof plan.voice === 'string' ? plan.voice : null,
    hasOutro: Object.keys(plan).length > 0,
    audioUrl: regularFile(path.join(dir, 'out', 'outro', 'audio', 'narration.mp3')) ? `/media/${encodeURIComponent(opts.slug)}/outro/audio.mp3` : null,
    hasVideo: regularFile(path.join(dir, 'out', 'outro', 'video', 'video.mp4')),
    videoUrl: `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4` };
}

function positiveCount(raw: number | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || raw < 0 || raw > 5000) throw new IntakeError(`${name} must be an integer between 0 and 5000`);
  return raw;
}

function writeJson(file: string, data: unknown): void {
  assertNoSymlinks(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function checkedCommand(cmd: string[], timeoutMs = 600_000): Promise<string> {
  const result = await runCommand(cmd, { timeoutMs });
  if (result.code !== 0) throw new IntakeError(`${path.basename(cmd[0])} failed: ${result.stderr.slice(-1200)}`, 422);
  return result.stdout;
}

async function mediaDuration(file: string): Promise<number | null> {
  try {
    const text = await checkedCommand(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 15_000);
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Resolve provider overrides to their own engine, adapter, settings, and voice. */
export async function resolveOutroTts(tts: Json, overrides: { provider?: string; voice?: string } = {}): Promise<Json> {
  const provider = (overrides.provider || '').trim();
  const voice = (overrides.voice || '').trim();
  // An explicit provider on the request wins over the persisted series TTS block.
  if (provider) {
    const selection = await resolveTtsSelection(provider, voice || undefined, undefined, undefined, false);
    return { ...selection.metaTts, voice_id: selection.voiceId };
  }
  if (voice) {
    // A voice-only override resolves against the persisted external provider so a
    // foreign voice id cannot slip through; an unknown provider keeps the old merge.
    const persistedProvider = tts.engine === 'external' || tts.engine === 'vertex' || tts.engine === 'grok'
      ? String(tts.provider || '').trim()
      : '';
    if (persistedProvider) {
      try {
        const selection = await resolveTtsSelection(persistedProvider, voice, undefined, undefined, false);
        return { ...selection.metaTts, voice_id: selection.voiceId };
      } catch {
        // Fall through to the stored block with the requested voice.
      }
    }
    return { ...tts, voice_id: voice };
  }
  return tts;
}

async function synthesizeOutroAudio(
  dir: string,
  text: string,
  scriptFile: string,
  output: string,
  overrides: { provider?: string; voice?: string } = {},
): Promise<number> {
  const meta = readJson(path.join(dir, 'meta.json'));
  // An explicit provider/voice on the request wins over the persisted series TTS.
  const tts = await resolveOutroTts(meta.tts || { engine: 'edge' }, overrides);
  if (tts.engine === 'vertex') {
    const { synthesizeVertexTtsToFile } = await import('../llm/vertexTts.js');
    const voiceId = String(tts.voice_id || '').trim();
    if (!voiceId) throw new IntakeError('Outro narration voice is empty', 422);
    try {
      await synthesizeVertexTtsToFile({
        text,
        voiceId,
        destPath: output,
        speed: Number(tts.speed ?? 1) || 1,
      });
    } catch (err) {
      throw new IntakeError(`Outro narration failed: ${(err as Error).message}`, 422);
    }
  } else if (tts.engine === 'grok') {
    const { synthesizeGrokTtsToFile } = await import('../llm/grokTts.js');
    const voiceId = String(tts.voice_id || '').trim();
    if (!voiceId) throw new IntakeError('Outro narration voice is empty', 422);
    try {
      await synthesizeGrokTtsToFile({
        text,
        voiceId,
        destPath: output,
        speed: Number(tts.speed ?? 1) || 1,
      });
    } catch (err) {
      throw new IntakeError(`Outro narration failed: ${(err as Error).message}`, 422);
    }
  } else if (tts.engine === 'external') {
    const { _resolveExternalTtsConfig } = await import('../stages/audio.js');
    const cfg = _resolveExternalTtsConfig(tts);
    const request = { protocol: 'manhwa-tts-v1', line_index: 0, text, output_path: output,
      voice_id: cfg.voice_id, language: cfg.language, speed: cfg.speed, style: cfg.style,
      provider: cfg.provider, revision: cfg.revision, settings: cfg.settings };
    const result = await runCommand(cfg.command, { timeoutMs: 90_000, input: JSON.stringify(request) });
    if (result.code !== 0) throw new IntakeError('Outro narration adapter failed', 422);
  } else if (tts.engine === 'edge' || !tts.engine) {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const candidates = [...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'edge-tts')),
      path.join(repo, '.venv', 'bin', 'edge-tts'),
      path.resolve(repo, '..', 'manhwa-pipeline', '.venv', 'bin', 'edge-tts'),
      '/opt/tts/bin/edge-tts'];
    const bin = candidates.find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
    if (!bin) throw new IntakeError('edge-tts is not installed; generated a silent panel showcase', 503);
    await checkedCommand([bin, '--voice', String(tts.voice_id || 'en-US-AndrewMultilingualNeural'), '--rate=+6%',
      '--file', scriptFile, '--write-media', output], 90_000);
  } else throw new IntakeError('Unsupported outro narration engine', 422);
  const duration = regularFile(output) ? await mediaDuration(output) : null;
  if (!duration || duration > 300) throw new IntakeError('Outro narration produced invalid or oversized audio', 422);
  return duration;
}

function concatLine(file: string): string {
  if (/[\r\n]/.test(file)) throw new IntakeError('Media paths cannot contain newlines');
  return `file '${file.replaceAll("'", "'\\''")}'`;
}

async function seriesWrite<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  try { return await withExclusiveSeriesLock(dir, { nonblocking: true }, fn); }
  catch (err) { if (err instanceof BlockingIOError) throw new ConflictError('Series is busy; wait for its active pipeline or edit to finish'); throw err; }
}

export async function generateSeriesOutro(opts: OutroOptions) {
  const dir = resolveSeriesDir(opts);
  return seriesWrite(dir, async () => {
    const inspected = inspectSeriesOutro(opts);
    const completed = getSeriesMergeState(opts).chapters.length;
    const coveredChapters = positiveCount(opts.coveredChapters, completed, 'coveredChapters');
    const totalChapters = positiveCount(opts.totalChapters, Math.max(coveredChapters, inspected.availableChapters.length), 'totalChapters');
    if (totalChapters < coveredChapters) throw new IntakeError('totalChapters cannot be smaller than coveredChapters');
    const hookType = opts.hookType || 'part2';
    if (!['part2', 'next_chapter', 'new_series', 'custom'].includes(hookType)) throw new IntakeError('Invalid outro hookType');
    if (hookType === 'custom' && !opts.customNote?.trim()) throw new IntakeError('customNote is required for a custom outro');
    const cast = inspected.characters.slice(0, 2).map((c) => c.name).join(' and ');
    const recap = `We've covered ${coveredChapters ? `the first ${coveredChapters} chapters` : 'the opening'}${totalChapters ? ` out of ${totalChapters}` : ''} in ${inspected.title}.`;
    const characterLine = cast ? ` Thanks for following ${cast}'s story with us.` : '';
    const hooks = {
      part2: ' Drop a comment for Part 2 if you want the continuation!',
      next_chapter: ` Join us for ${coveredChapters < totalChapters ? `chapter ${coveredChapters + 1}` : 'the next chapter'} of ${inspected.title}; subscribe so you catch what happens next.`,
      new_series: opts.nextSeriesTitle?.trim()
        ? ` A new series is coming next: ${opts.nextSeriesTitle.trim()}. Tell us which story you want to discover together!`
        : ' A new series is coming next. Tell us which story you want to discover together!',
      custom: ` ${opts.customNote?.trim() || ''}`,
    };
    const script = recap + characterLine + hooks[hookType];
    const outroDir = path.join(dir, 'out', 'outro');
    assertNoSymlinks(outroDir);
    fs.mkdirSync(outroDir, { recursive: true });
    const plan = { schemaVersion: 1, slug: opts.slug, title: inspected.title, totalChapters, coveredChapters, hookType,
      customNote: opts.customNote || '', nextSeriesTitle: opts.nextSeriesTitle?.trim() || null,
      provider: opts.provider || null, voice: opts.voice || null,
      script, characters: inspected.characters,
      selectedPanels: inspected.selectedPanels, generatedAt: new Date().toISOString() };
    writeJson(path.join(outroDir, 'outro-plan.json'), plan);
    assertNoSymlinks(path.join(outroDir, 'script.md'));
    fs.writeFileSync(path.join(outroDir, 'script.md'), script + '\n');
    writeJson(path.join(outroDir, 'shots.json'), { fps: 30, width: 1280, height: 720, selectedPanels: inspected.selectedPanels,
      shots: inspected.selectedPanels.map((p, i) => ({ ...p, start: i * 2, duration: 2 })) });
    let rendered = false;
    let renderError: string | null = null;
    let audioError: string | null = null;
    let audioUrl: string | null = null;
    if (opts.renderVideo !== false && inspected.selectedPanels.length) {
      const videoDir = path.join(outroDir, 'video');
      assertNoSymlinks(videoDir);
      fs.mkdirSync(videoDir, { recursive: true });
      const tempDir = fs.mkdtempSync(path.join(videoDir, '.outro-'));
      try {
        await checkedCommand(['ffmpeg', '-version'], 15_000);
        let duration = inspected.selectedPanels.length * 2;
        let audio: string | null = null;
        if (opts.synthesizeAudio !== false) {
          try {
            const tmpAudio = path.join(tempDir, 'narration.mp3');
            duration = await synthesizeOutroAudio(dir, script, path.join(outroDir, 'script.md'), tmpAudio,
              { provider: opts.provider, voice: opts.voice });
            const audioDir = path.join(outroDir, 'audio');
            assertNoSymlinks(audioDir);
            fs.mkdirSync(audioDir, { recursive: true });
            audio = path.join(audioDir, 'narration.mp3');
            assertNoSymlinks(audio);
            fs.renameSync(tmpAudio, audio);
            audioUrl = `/media/${encodeURIComponent(opts.slug)}/outro/audio.mp3`;
          } catch (err) { audioError = (err as Error).message; }
        }
        const list = path.join(tempDir, 'images.txt');
        const panels = inspected.selectedPanels.map((p) => path.join(dir, p.panelFile));
        const panelDuration = duration / panels.length;
        fs.writeFileSync(list, panels.map((p) => concatLine(p) + `\nduration ${panelDuration}`).join('\n') + '\n' + concatLine(panels[panels.length - 1]) + '\n');
        const tempVideo = path.join(tempDir, 'video.mp4');
        await checkedCommand(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list,
          ...(audio ? ['-i', audio] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']), '-vf',
          'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
          '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
          '-t', String(duration), '-movflags', '+faststart', tempVideo]);
        assertNoSymlinks(path.join(videoDir, 'video.mp4'));
        fs.renameSync(tempVideo, path.join(videoDir, 'video.mp4'));
        writeJson(path.join(outroDir, 'shots.json'), { fps: 30, width: 1280, height: 720, duration, audioUrl,
          selectedPanels: inspected.selectedPanels,
          shots: inspected.selectedPanels.map((p, i) => ({ ...p, start: i * panelDuration, duration: panelDuration })) });
        rendered = true;
      } catch (err) { renderError = (err as Error).message; }
      finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
    }
    return { ok: true as const, ...plan, rendered, renderError, audioError, audioUrl,
      videoUrl: rendered ? `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4` : null };
  });
}

export function getSeriesMergeState(opts: SeriesOptions & { includeOutro?: boolean }) {
  const dir = resolveSeriesDir(opts);
  const out = path.join(dir, 'out');
  const chapters = namesIn(out).filter((name) => /^ch\d+$/.test(name) && regularFile(path.join(out, name, 'video', 'video.mp4')))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const includesOutro = opts.includeOutro !== false && regularFile(path.join(out, 'outro', 'video', 'video.mp4'));
  const sources = chapters.map((ch) => path.join(out, ch, 'video', 'video.mp4'));
  if (includesOutro) sources.push(path.join(out, 'outro', 'video', 'video.mp4'));
  const full = path.join(out, 'full', 'video', 'video.mp4');
  const merged = regularFile(full);
  const sizeBytes = merged ? fs.statSync(full).size : 0;
  const signature = sources.map((file) => ({ file: path.relative(dir, file), size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }));
  const previous = readJson(path.join(out, 'full', 'video', 'merge.json'));
  const stale = merged && (previous.sources ? JSON.stringify(previous.sources) !== JSON.stringify(signature) : sources.some((f) => fs.statSync(f).mtimeMs > fs.statSync(full).mtimeMs));
  return { slug: opts.slug, chapters, chaptersMerged: chapters, includesOutro, merged, stale,
    canMerge: chapters.length > 0, sizeBytes, size: sizeBytes,
    downloadUrl: merged ? `/media/${encodeURIComponent(opts.slug)}/full.mp4` : null,
    sources: signature };
}

export async function mergeSeriesChapters(opts: SeriesOptions & { includeOutro?: boolean }) {
  const dir = resolveSeriesDir(opts);
  return seriesWrite(dir, async () => {
    const state = getSeriesMergeState(opts);
    if (!state.chapters.length) throw new IntakeError('No rendered chapter videos to merge', 409);
    const dest = path.join(dir, 'out', 'full', 'video');
    assertNoSymlinks(dest);
    fs.mkdirSync(dest, { recursive: true });
    const temp = fs.mkdtempSync(path.join(dest, '.merge-'));
    const tempOut = path.join(temp, 'video.mp4');
    try {
      const sources = state.sources.map((s) => path.join(dir, s.file));
      const list = path.join(temp, 'concat.txt');
      fs.writeFileSync(list, sources.map(concatLine).join('\n') + '\n');
      const signatures = await Promise.all(sources.map(async (file) => {
        try { return await checkedCommand(['ffprobe', '-v', 'error', '-show_entries',
          'stream=codec_name,codec_type,width,height,pix_fmt,time_base,sample_rate,channel_layout', '-of', 'json', file], 15_000); }
        catch { return ''; }
      }));
      const base = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list];
      let copy = false;
      if (signatures.every((s) => s && s === signatures[0])) {
        try { await checkedCommand([...base, '-c', 'copy', '-movflags', '+faststart', tempOut]); copy = true; } catch { /* Re-encode below. */ }
      }
      if (!copy) await checkedCommand([...base, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', tempOut]);
      const sizeBytes = fs.statSync(tempOut).size;
      if (!sizeBytes) throw new IntakeError('Merged video is empty', 422);
      assertNoSymlinks(path.join(dest, 'video.mp4'));
      fs.renameSync(tempOut, path.join(dest, 'video.mp4'));
      writeJson(path.join(dest, 'merge.json'), { sources: state.sources, includesOutro: state.includesOutro, mergedAt: new Date().toISOString() });
      return { ok: true as const, merged: true as const, slug: opts.slug,
        downloadUrl: `/media/${encodeURIComponent(opts.slug)}/full.mp4`,
        chaptersMerged: state.chapters, chapters: state.chapters,
        includesOutro: state.includesOutro, sizeBytes, size: sizeBytes,
        duration: await mediaDuration(path.join(dest, 'video.mp4')) };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

function chapterSpec(nums: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    const first = nums[i];
    let last = first;
    while (i + 1 < nums.length && nums[i + 1] === last + 1 && nums[i + 1] - first <= 500) last = nums[++i];
    parts.push(first === last ? String(first) : `${first}-${last}`);
  }
  return parts.join(',');
}

export interface ExtendSeriesOptions extends SeriesOptions {
  chapters?: string;
  zipPath?: string;
  chapterFolders?: string[];
  gdriveUrl?: string;
  sourceType?: string;
  provider?: string;
  voice?: string;
  background?: string;
  motion?: string;
  renderLane?: string;
  renderQuality?: string;
  preserveCompleted?: boolean;
  createdBy?: string;
  spawnWorker?: boolean;
  env?: Env;
  outroConfig?: EnqueueOptions['outroConfig'];
}

export async function extendSeries(opts: ExtendSeriesOptions) {
  const dir = resolveSeriesDir(opts);
  // Completed chapters are always preserved: re-queueing rendered chapters would
  // discard finished videos, so the request is rejected before anything is imported.
  if (opts.preserveCompleted === false) {
    throw new IntakeError('preserveCompleted must be true when extending an existing series');
  }
  const preserveCompleted = true;
  const env = { ...process.env, ...opts.env, MANHWA_SERIES_ROOT: path.resolve(opts.seriesRoot) };
  const spec = validateChaptersSpec(opts.chapters || 'all');
  if (opts.zipPath && opts.gdriveUrl) throw new IntakeError('Specify either a ZIP or a Drive URL, not both');
  // Download into a bounded temporary directory, never into completed chapter outputs.
  let downloadDir: string | null = null;
  let zipPath = opts.zipPath;
  try {
    if (opts.gdriveUrl) {
      const scratchBase = process.env.MANHWA_SCRATCH_DIR || os.tmpdir();
      fs.mkdirSync(scratchBase, { recursive: true });
      downloadDir = fs.mkdtempSync(path.join(scratchBase, 'series-extension-'));
      zipPath = path.join(downloadDir, 'source.zip');
      await downloadGdriveZip(parseGdriveUrl(opts.gdriveUrl).fileId, zipPath);
    }
    await seriesWrite(dir, async () => {
      withJobMetaLock(env, () => {
        const conflict = reconcileJobs(env).find((j) => j.slug === opts.slug && ['queued', 'paused', 'downloading', 'ingesting', 'running'].includes(j.status));
        if (conflict) throw new ConflictError(`Series already has an active/queued job (${conflict.id})`);
        if (zipPath) {
          assertNoSymlinks(zipPath);
          const idx = archiveIndex(zipPath, true)[1];
          const requested = parseChapterSpec(spec, idx);
          const fresh = requested.filter((n) => n in idx && !fs.existsSync(path.join(dir, `ch${n}`)) && !regularFile(path.join(dir, 'out', `ch${n}`, 'video', 'video.mp4')));
          if (fresh.length) ingest(opts.slug, { seriesRoot: opts.seriesRoot, zipPath, chapters: fresh, interactive: false, force: false });
        }
        for (const folder of opts.chapterFolders || []) {
          assertNoSymlinks(folder);
          const name = path.basename(folder);
          if (!/^ch\d+$/.test(name) || !fs.statSync(folder).isDirectory()) throw new IntakeError('Each chapter folder must be named chN');
          if (spec !== 'all' && !parseChapterSpec(spec, []).includes(Number(name.slice(2)))) continue;
          const dest = path.join(dir, name);
          assertNoSymlinks(dest);
          if (fs.existsSync(dest) || regularFile(path.join(dir, 'out', name, 'video', 'video.mp4'))) continue;
          fs.cpSync(folder, dest, { recursive: true, force: false, errorOnExist: true, filter: (src) => {
            if (fs.lstatSync(src).isSymbolicLink()) throw new IntakeError('Chapter folders cannot contain symlinks');
            return true;
          } });
        }
      });
    });
    const completedChapters = getSeriesMergeState(opts).chapters;
    const available = existingChapterNumbers(dir);
    const wanted = spec === 'all' ? available : parseChapterSpec(spec, available);
    const missing = wanted.filter((n) => !available.includes(n) && !completedChapters.includes(`ch${n}`));
    if (missing.length) throw new IntakeError(`Chapter folders are missing: ${missing.map((n) => `ch${n}`).join(', ')}`);
    // Only chapters without a finished video are queued; completed work stays untouched.
    const pending = wanted.filter((n) => available.includes(n) && !completedChapters.includes(`ch${n}`));
    if (!pending.length) return { ok: true as const, slug: opts.slug, queued: false, chapters: '', completedChapters,
      preservedChapters: completedChapters, newChapters: [], targetChapters: '', job: null };
    const chapters = chapterSpec(pending);
    // Forward every render-affecting choice to the extension job it creates.
    const job = await createJob({
      ...opts, slug: opts.slug, chapters, env,
      background: opts.background,
      motion: opts.motion,
      renderQuality: opts.renderQuality,
      sourceType: opts.sourceType,
      preserveCompleted,
    });
    return { ok: true as const, slug: opts.slug, queued: true, chapters, completedChapters,
      preservedChapters: completedChapters, newChapters: pending.map((n) => `ch${n}`), targetChapters: chapters, job };
  } finally { if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true }); }
}
