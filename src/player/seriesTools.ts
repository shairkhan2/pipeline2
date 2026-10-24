/** Existing-series extension, character-focused outro plans and atomic video merging. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  IntakeError, ConflictError, createJob, downloadGdriveZip, existingChapterNumbers,
  findRecoverableSeriesSource, parseGdriveUrl, resolveTtsSelection, runCommand, validateChaptersSpec,
  withJobMetaLock, reconcileJobs,
  type EnqueueOptions, type Env,
} from '../intake/intake.js';
import { archiveIndex, ingest, parseChapterSpec } from '../intake/ingest.js';
import { retainSourceArchive, listRetainedSources, retainedArchivePath } from '../intake/sourceArchive.js';
import { BlockingIOError, validateSlug, withExclusiveSeriesLock } from '../locks/seriesLock.js';
import { load as loadPromoBlock } from '../intake/promoBlock.js';
import { assertNoSymlinks } from './storageTrash.js';
import sharp from 'sharp';

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
  /** Overall bounded operation deadline in ms for outro generation (default 90s). */
  timeoutMs?: number;
  /** Bounded timeout in ms for narration synthesis (default 25s). */
  ttsTimeoutMs?: number;
  /** Bounded timeout in ms for ffmpeg video rendering (default 45s). */
  renderTimeoutMs?: number;
}
type Json = Record<string, any>;
const imageRe = /\.(png|jpe?g|webp|avif)$/i;
const imageExts = ['.png', '.webp', '.jpg', '.jpeg', '.avif'];
const promoFileRe = /^(credit|credits|promo|system|banner|watermark|skip|ad|advert)([-_.\d].*)?\.[a-z0-9]+$/i;

function readJsonValue(file: string): unknown {
  assertNoSymlinks(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readJson(file: string): Json {
  const data = readJsonValue(file);
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Json : {};
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

function bareStem(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function discoverChapters(dir: string): number[] {
  const nums = new Set<number>(existingChapterNumbers(dir));
  const out = path.join(dir, 'out');
  for (const sub of [out, path.join(out, 'panels'), path.join(out, 'cleaned')]) {
    for (const name of namesIn(sub)) {
      const m = /^(?:obs_)?ch(\d+)(?:\.json)?$/i.exec(name);
      if (m) nums.add(Number(m[1]));
    }
  }
  return [...nums].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

function readManifestMap(dir: string, chapter: string): Map<string, Json> {
  const map = new Map<string, Json>();
  const raw = readJsonValue(path.join(dir, 'out', 'panels', chapter, 'manifest.json'));
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (Array.isArray((raw as Json).panels) ? (raw as Json).panels : Array.isArray((raw as Json).recs) ? (raw as Json).recs : [])
      : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Json;
    const stem = bareStem(String(rec.id || rec.panel || rec.file || '')).toLowerCase();
    if (stem) map.set(stem, rec);
  }
  return map;
}

/** Build the panel record with both key spellings the frontends read. */
function selectedPanel(chapter: string, panelFile: string, characterNames: string[], reason: string, slug: string): SelectedOutroPanel {
  const previewUrl = `/api/series/${encodeURIComponent(slug)}/panels/${panelFile.split('/').map(encodeURIComponent).join('/')}`;
  return { chapter, panelFile, panel: panelFile, characterNames, characters: characterNames, reason, previewUrl, url: previewUrl };
}

function characterList(bible: Json, obsCharacters: Json[] = []): Array<{ name: string; description: string; aliases: string[]; role: string }> {
  const raw = bible.characters || bible.mainCharacters || bible.main_characters || {};
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v] as const) : Object.entries(raw);
  const out: Array<{ name: string; description: string; aliases: string[]; role: string }> = [];
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (/^unknown[_-]/i.test(key)) continue;
    const c = typeof value === 'string' ? { name: value } : value as Json;
    const name = String(c?.name || key).trim();
    if (!name || /^unknown\b/i.test(name)) continue;
    const aliases = Array.isArray(c?.aliases) ? c.aliases.map(String).filter(Boolean) : [];
    const norm = name.toLowerCase();
    if (seen.has(norm) || aliases.some((a) => seen.has(a.toLowerCase()))) continue;
    seen.add(norm);
    for (const a of aliases) seen.add(a.toLowerCase());
    out.push({
      name,
      description: String(c?.description || c?.visual || c?.visual_now || c?.role || c?.status || ''),
      aliases,
      role: String(c?.role || c?.status || ''),
    });
  }
  if (!out.length) {
    for (const c of obsCharacters) {
      if (!c || typeof c !== 'object') continue;
      const name = String(c.name || '').trim();
      if (!name || /^unknown\b/i.test(name)) continue;
      const aliases = Array.isArray(c.aliases) ? c.aliases.map(String).filter(Boolean) : [];
      const norm = name.toLowerCase();
      if (seen.has(norm) || aliases.some((a) => seen.has(a.toLowerCase()))) continue;
      seen.add(norm);
      for (const a of aliases) seen.add(a.toLowerCase());
      out.push({
        name,
        description: String(c.description || c.visual || c.what_they_do || c.role || ''),
        aliases,
        role: String(c.role || c.what_they_do || ''),
      });
    }
  }
  return out.sort((a, b) => Number(/main|protagonist|hero/i.test(b.role)) - Number(/main|protagonist|hero/i.test(a.role)));
}

function findPanel(dir: string, chapter: string, panel: Json, manifestRec?: Json): string | null {
  const rawValues = [
    panel.panelFile, panel.file, panel.image, panel.path, panel.src, panel.panel,
    manifestRec?.panel, manifestRec?.file, panel.id, panel.panelId,
  ]
    .map((v) => String(v || '').trim())
    .filter((raw) => Boolean(raw) && !path.isAbsolute(raw) && !raw.split(/[\\/]/).includes('..'));
  if (!rawValues.length) return null;
  const candidates: string[] = [];
  const bases = [
    path.join(dir, 'out', 'panels', chapter),
    path.join(dir, 'out', 'cleaned', chapter),
    path.join(dir, 'out', chapter, 'panels'),
    path.join(dir, chapter),
  ];
  for (const raw of rawValues) {
    candidates.push(
      path.join(dir, raw),
      path.join(dir, 'out', raw),
      path.join(dir, 'out', 'panels', raw),
      path.join(dir, 'out', 'cleaned', raw),
    );
    const stem = bareStem(raw);
    for (const base of bases) {
      for (const target of [raw, path.basename(raw)]) {
        if (!target) continue;
        if (imageRe.test(target)) {
          candidates.push(path.join(base, target));
          if (stem) {
            for (const ext of imageExts) candidates.push(path.join(base, stem + ext));
          }
        } else {
          for (const ext of imageExts) candidates.push(path.join(base, target + ext));
        }
      }
    }
  }
  return candidates.find((f) => f.startsWith(dir + path.sep) && imageRe.test(f) && regularFile(f)) || null;
}

/** Inspect cached reader observations without making LLM calls or changing series caches. */
export function inspectSeriesOutro(opts: OutroOptions) {
  const dir = resolveSeriesDir(opts);
  const meta = readJson(path.join(dir, 'meta.json'));
  const bible = readJson(path.join(dir, 'out', 'bible.json'));
  let promoBlock: ReturnType<typeof loadPromoBlock> = null;
  try { promoBlock = loadPromoBlock(path.join(dir, 'out')); } catch { promoBlock = null; }
  const obsFiles = namesIn(path.join(dir, 'out'))
    .filter((name) => /^obs_ch\d+\.json$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const parsedObs: Array<{ chapter: string; panels: Json[]; manifestMap: Map<string, Json> }> = [];
  const obsCharacters: Json[] = [];
  for (const name of obsFiles) {
    const chapter = /^obs_(ch\d+)\.json$/i.exec(name)![1].toLowerCase();
    const rawCache = readJsonValue(path.join(dir, 'out', name));
    if (!rawCache || typeof rawCache !== 'object') continue;
    const payload = !Array.isArray(rawCache) && (rawCache as Json).data && typeof (rawCache as Json).data === 'object'
      ? (rawCache as Json).data
      : rawCache;
    if (!Array.isArray(payload) && Array.isArray((payload as Json).characters)) {
      obsCharacters.push(...((payload as Json).characters as Json[]));
    }
    const panels = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Json).panels)
        ? (payload as Json).panels
        : Array.isArray((rawCache as Json).panels)
          ? (rawCache as Json).panels
          : null;
    if (!Array.isArray(panels)) continue;
    parsedObs.push({ chapter, panels: panels as Json[], manifestMap: readManifestMap(dir, chapter) });
  }
  const characters = characterList(bible, obsCharacters);
  const candidates: Array<SelectedOutroPanel & { score: number }> = [];
  const rejectedFiles = new Set<string>();
  const rejectedIds = new Set<string>();
  const rejectedPages = new Set<string>();
  for (const { chapter, panels, manifestMap } of parsedObs) {
    for (const p of panels) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      const bareId = bareStem(String(p.id || p.panelId || p.panel || p.file || p.panelFile || '')).toLowerCase();
      const manifestRec = bareId ? manifestMap.get(bareId) : undefined;
      const kindStr = String(p.kind || p.type || '');
      const visualText = String(p.visual || p.description || p.caption || '');
      const isFullPagePromo =
        p.promo_page === true ||
        p.promo_page === 'full' ||
        p.promo_full === true ||
        p.promo === true ||
        Boolean(promoBlock?.panelFullPromo(p as any)) ||
        (p.promo_page !== false && (
          /^(credit|credits|promo|ad|advert|banner|watermark)$/i.test(kindStr) ||
          /\b(scanlation credit|promotional card|credit page|discord server)\b/i.test(visualText)
        ));
      const isSingleSkippedOrSystem =
        p.skip === true ||
        p.skipped === true ||
        /^(system|skip)$/i.test(kindStr);
      const artVal = typeof p.art === 'number' && Number.isFinite(p.art) ? p.art : null;
      const bubbleAt = String(p.bubble_at || '').trim().toLowerCase();
      const isLowArtTextCard = artVal !== null && (artVal <= 0.2 || (bubbleAt === 'full' && artVal < 0.5));
      if (isFullPagePromo || isSingleSkippedOrSystem || isLowArtTextCard) {
        if (bareId) rejectedIds.add(`${chapter}:${bareId}`);
        if (isFullPagePromo) {
          const pgFromId = /^p?0*(\d+)_\d+$/i.exec(bareId) || /^0*(\d+)$/.exec(bareId);
          if (pgFromId && Number(pgFromId[1]) > 0) rejectedPages.add(`${chapter}:${Number(pgFromId[1])}`);
          if (typeof p.page === 'number' && Number.isInteger(p.page) && p.page > 0) {
            rejectedPages.add(`${chapter}:${p.page}`);
          }
          if (typeof manifestRec?.page === 'number' && Number.isInteger(manifestRec.page) && manifestRec.page > 0) {
            rejectedPages.add(`${chapter}:${manifestRec.page}`);
          }
        }
        const rejFile = findPanel(dir, chapter, p, manifestRec);
        if (rejFile) {
          rejectedFiles.add(path.relative(dir, rejFile).split(path.sep).join('/'));
          rejectedIds.add(`${chapter}:${bareStem(rejFile).toLowerCase()}`);
        }
        continue;
      }
      const file = findPanel(dir, chapter, p, manifestRec);
      if (!file) continue;
      const declared = Array.isArray(p.characters) ? p.characters.map((c: any) => String(typeof c === 'string' ? c : c?.name || c?.id || '')).filter(Boolean) : [];
      const text = [...declared, p.visual || '', p.description || '', p.caption || ''].join(' ').toLowerCase();
      const characterNames = characters.filter((c) => [c.name, ...c.aliases].some((n) => n.length > 1 && text.includes(n.toLowerCase()))).map((c) => c.name);
      const framing = String(p.framing || p.shot || p.shotType || '').toLowerCase().replace(/[\s_-]/g, '');
      const focused = framing === 'closeup' || framing === 'medium';
      const weight = Math.max(0, Math.min(10, Number(p.weight || p.visualWeight || 0) || 0));
      const mw = Number(manifestRec?.w || p.w || p.width || 0);
      const mh = Number(manifestRec?.h || p.h || p.height || 0);
      const sliverPenalty = mw > 0 && mh > 0 && mh < 220 && mw / mh > 3 ? 250 : 0;
      const artBonus = artVal !== null ? Math.round(Math.max(0, Math.min(1, artVal)) * 5) : 0;
      const score = characterNames.length * 100 + (declared.length ? 20 : 0) + (focused ? 30 : 0) + weight + artBonus - sliverPenalty;
      const panelFile = path.relative(dir, file).split(path.sep).join('/');
      candidates.push({ ...selectedPanel(chapter, panelFile, characterNames,
        [characterNames.length ? `Named character: ${characterNames.join(', ')}` : 'Narrative artwork', focused ? `${framing} character framing` : '', weight ? 'High visual weight' : ''].filter(Boolean).join('; '),
        opts.slug), score });
    }
  }
  const availableNums = discoverChapters(dir);
  if (!candidates.length) {
    const isRejectedCandidate = (chapter: string, absFile: string, manifestMap: Map<string, Json>): boolean => {
      const rel = path.relative(dir, absFile).split(path.sep).join('/');
      const stem = bareStem(absFile).toLowerCase();
      const rawPageMatch = /^0*(\d+)$/.exec(stem);
      const slicedPageMatch = /^p?0*(\d+)_\d+$/i.exec(stem);
      const mRec = manifestMap.get(stem);
      const mPage = typeof mRec?.page === 'number' && Number.isInteger(mRec.page) && mRec.page > 0 ? mRec.page : null;
      return (
        rejectedFiles.has(rel) ||
        rejectedIds.has(`${chapter}:${stem}`) ||
        Boolean(rawPageMatch && rejectedPages.has(`${chapter}:${Number(rawPageMatch[1])}`)) ||
        Boolean(slicedPageMatch && rejectedPages.has(`${chapter}:${Number(slicedPageMatch[1])}`)) ||
        Boolean(mPage && rejectedPages.has(`${chapter}:${mPage}`)) ||
        promoFileRe.test(path.basename(absFile))
      );
    };
    for (const n of availableNums) {
      const chapter = `ch${n}`;
      const manifestMap = readManifestMap(dir, chapter);
      const slicedBases = [
        path.join(dir, 'out', 'panels', chapter),
        path.join(dir, 'out', 'cleaned', chapter),
        path.join(dir, 'out', chapter, 'panels'),
      ];
      let hadSlicedImages = false;
      let chosenFiles: string[] = [];
      for (const base of slicedBases) {
        const allImgs = namesIn(base)
          .filter((f) => imageRe.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => path.join(base, f))
          .filter((abs) => regularFile(abs));
        if (allImgs.length) hadSlicedImages = true;
        const usable = allImgs.filter((abs) => !isRejectedCandidate(chapter, abs, manifestMap));
        if (usable.length) {
          chosenFiles = usable;
          break;
        }
      }
      if (!chosenFiles.length && !hadSlicedImages) {
        const rawBase = path.join(dir, chapter);
        chosenFiles = namesIn(rawBase)
          .filter((f) => imageRe.test(f))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => path.join(rawBase, f))
          .filter((abs) => regularFile(abs) && !isRejectedCandidate(chapter, abs, manifestMap));
      }
      if (!chosenFiles.length && manifestMap.size) {
        for (const rec of manifestMap.values()) {
          const abs = findPanel(dir, chapter, rec, rec);
          if (abs && !isRejectedCandidate(chapter, abs, manifestMap)) chosenFiles.push(abs);
        }
      }
      const middle = Math.floor(chosenFiles.length / 2);
      for (const i of [middle, middle - 1, middle + 1]) {
        if (!chosenFiles[i] || (chosenFiles.length > 2 && (i === 0 || i === chosenFiles.length - 1))) continue;
        const file = chosenFiles[i]!;
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
  const videoFile = path.join(dir, 'out', 'outro', 'video', 'video.mp4');
  const hasVideo = regularFile(videoFile);
  const videoUpdatedAt = hasVideo ? Math.trunc(fs.statSync(videoFile).mtimeMs) : null;
  const attachment = resolveOutroAttachment(dir, renderedChapters(dir));
  return { slug: opts.slug, title: String(meta.title || bible.title || opts.slug), characters, selectedPanels,
    panels: selectedPanels,
    availableChapters: availableNums.map((n) => `ch${n}`),
    plan: Object.keys(plan).length ? plan : null,
    script: typeof plan.script === 'string' ? plan.script : '',
    hookType: plan.hookType ?? null, totalChapters: plan.totalChapters ?? null, coveredChapters: plan.coveredChapters ?? null,
    nextSeriesTitle: typeof plan.nextSeriesTitle === 'string' ? plan.nextSeriesTitle : null,
    provider: typeof plan.provider === 'string' ? plan.provider : null,
    voice: typeof plan.voice === 'string' ? plan.voice : null,
    hasOutro: Object.keys(plan).length > 0,
    audioUrl: regularFile(path.join(dir, 'out', 'outro', 'audio', 'narration.mp3')) ? `/media/${encodeURIComponent(opts.slug)}/outro/audio.mp3` : null,
    hasVideo,
    videoUrl: hasVideo ? `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4` : null,
    videoUpdatedAt, attachment };
}

function positiveCount(raw: number | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || raw < 0 || raw > 5000) throw new IntakeError(`${name} must be an integer between 0 and 5000`);
  return raw;
}

function clampTimeout(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function withBoundedTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new IntakeError(message, 422);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    fn(controller.signal).then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function writeJson(file: string, data: unknown): void {
  assertNoSymlinks(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function checkedCommand(cmd: string[], timeoutMs = 600_000): Promise<string> {
  const result = await runCommand(cmd, { timeoutMs });
  if (result.timedOut) {
    throw new IntakeError(`${path.basename(cmd[0])} timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`, 422);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(-1200);
    throw new IntakeError(`${path.basename(cmd[0])} failed: ${detail}`, 422);
  }
  return result.stdout;
}

async function mediaDuration(file: string, timeoutMs = 15_000): Promise<number | null> {
  try {
    const text = await checkedCommand(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], timeoutMs);
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
    const persistedProvider = tts.engine === 'external' || tts.engine === 'vertex' || tts.engine === 'grok' || tts.engine === 'elevenlabs'
      ? String(tts.provider || '').trim()
      : '';
    if (persistedProvider) {
      try {
        const selection = await resolveTtsSelection(persistedProvider, voice, undefined, undefined, false);
        // ElevenLabs keeps the series model when only the voice changes.
        if (tts.engine === 'elevenlabs' && tts.model_id) {
          return { ...selection.metaTts, model_id: tts.model_id, voice_id: selection.voiceId };
        }
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
  overrides: { provider?: string; voice?: string; timeoutMs?: number } = {},
): Promise<number> {
  const totalBudgetMs = clampTimeout(overrides.timeoutMs ?? Number(process.env.MANHWA_OUTRO_TTS_TIMEOUT_MS), 25_000, 100, 60_000);
  const startedAt = Date.now();
  const remMs = (floor = 50) => Math.max(floor, totalBudgetMs - (Date.now() - startedAt));
  const meta = readJson(path.join(dir, 'meta.json'));
  // An explicit provider/voice on the request wins over the persisted series TTS.
  const tts = await withBoundedTimeout(
    () => resolveOutroTts(meta.tts || { engine: 'edge' }, overrides),
    remMs(),
    'Outro narration voice resolution timed out; generated a silent panel showcase',
  );
  if (tts.engine === 'vertex') {
    const { synthesizeVertexTtsToFile } = await import('../llm/vertexTts.js');
    const voiceId = String(tts.voice_id || '').trim();
    if (!voiceId) throw new IntakeError('Outro narration voice is empty', 422);
    try {
      await withBoundedTimeout(
        (signal) =>
          synthesizeVertexTtsToFile({
            text,
            voiceId,
            destPath: output,
            speed: Number(tts.speed ?? 1) || 1,
            signal,
          }),
        remMs(),
        'Outro narration timed out; generated a silent panel showcase',
      );
    } catch (err) {
      throw new IntakeError(`Outro narration failed: ${(err as Error).message}`, 422);
    }
  } else if (tts.engine === 'grok') {
    const { synthesizeGrokTtsToFile } = await import('../llm/grokTts.js');
    const voiceId = String(tts.voice_id || '').trim();
    if (!voiceId) throw new IntakeError('Outro narration voice is empty', 422);
    try {
      await withBoundedTimeout(
        (signal) =>
          synthesizeGrokTtsToFile({
            text,
            voiceId,
            destPath: output,
            speed: Number(tts.speed ?? 1) || 1,
            signal,
          }),
        remMs(),
        'Outro narration timed out; generated a silent panel showcase',
      );
    } catch (err) {
      throw new IntakeError(`Outro narration failed: ${(err as Error).message}`, 422);
    }
  } else if (tts.engine === 'elevenlabs') {
    const { synthesizeElevenLabsToFile, ELEVENLABS_DEFAULT_MODEL } = await import('../llm/elevenlabsTts.js');
    const voiceId = String(tts.voice_id || '').trim();
    if (!voiceId) throw new IntakeError('Outro narration voice is empty', 422);
    try {
      await withBoundedTimeout(
        (signal) =>
          synthesizeElevenLabsToFile({
            text,
            voiceId,
            modelId: String(tts.model_id || ELEVENLABS_DEFAULT_MODEL),
            destPath: output,
            speed: Number(tts.speed ?? 1) || 1,
            signal,
          }),
        remMs(),
        'Outro narration timed out; generated a silent panel showcase',
      );
    } catch (err) {
      throw new IntakeError(`Outro narration failed: ${(err as Error).message}`, 422);
    }
  } else if (tts.engine === 'external') {
    const { _resolveExternalTtsConfig } = await import('../stages/audio.js');
    const cfg = _resolveExternalTtsConfig(tts);
    const request = { protocol: 'manhwa-tts-v1', line_index: 0, text, output_path: output,
      voice_id: cfg.voice_id, language: cfg.language, speed: cfg.speed, style: cfg.style,
      provider: cfg.provider, revision: cfg.revision, settings: cfg.settings };
    const result = await runCommand(cfg.command, { timeoutMs: remMs(), input: JSON.stringify(request) });
    if (result.timedOut) {
      throw new IntakeError('Outro narration adapter timed out; generated a silent panel showcase', 422);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().slice(-200);
      throw new IntakeError(`Outro narration adapter failed${detail ? `: ${detail}` : ''}; generated a silent panel showcase`, 422);
    }
  } else if (tts.engine === 'edge' || !tts.engine) {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const candidates = process.env.MANHWA_EDGE_TTS_BIN !== undefined
      ? [process.env.MANHWA_EDGE_TTS_BIN].filter(Boolean)
      : [...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'edge-tts')),
        path.join(repo, '.venv', 'bin', 'edge-tts'),
        path.resolve(repo, '..', 'manhwa-pipeline', '.venv', 'bin', 'edge-tts'),
        '/opt/tts/bin/edge-tts'];
    const bin = candidates.find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
    if (!bin) throw new IntakeError('edge-tts is not installed; generated a silent panel showcase', 422);
    await checkedCommand([bin, '--voice', String(tts.voice_id || 'en-US-AndrewMultilingualNeural'), '--rate=+6%',
      '--file', scriptFile, '--write-media', output], remMs());
  } else throw new IntakeError(`Unsupported outro narration engine (${String(tts.engine)}); generated a silent panel showcase`, 422);
  const probeBudget = Math.min(10_000, remMs(200));
  const duration = regularFile(output) ? await mediaDuration(output, probeBudget) : null;
  if (!duration || duration > 300) throw new IntakeError('Outro narration produced invalid or oversized audio; generated a silent panel showcase', 422);
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

/** English outro narration text; shared so a language outro translates the same words. */
export function buildOutroScript(input: {
  title: string;
  characters: Array<{ name: string }>;
  coveredChapters: number;
  totalChapters: number;
  hookType: NonNullable<OutroOptions['hookType']>;
  customNote?: string;
  nextSeriesTitle?: string;
}): string {
  const { title, coveredChapters, totalChapters } = input;
  const cast = input.characters.slice(0, 2).map((c) => c.name).join(' and ');
  const recap = `We've covered ${coveredChapters ? `the first ${coveredChapters} chapters` : 'the opening'}${totalChapters ? ` out of ${totalChapters}` : ''} in ${title}.`;
  const characterLine = cast ? ` Thanks for following ${cast}'s story with us.` : '';
  const hooks = {
    part2: ' Drop a comment for Part 2 if you want the continuation!',
    next_chapter: ` Join us for ${coveredChapters < totalChapters ? `chapter ${coveredChapters + 1}` : 'the next chapter'} of ${title}; subscribe so you catch what happens next.`,
    new_series: input.nextSeriesTitle?.trim()
      ? ` A new series is coming next: ${input.nextSeriesTitle.trim()}. Tell us which story you want to discover together!`
      : ' A new series is coming next. Tell us which story you want to discover together!',
    custom: ` ${input.customNote?.trim() || ''}`,
  };
  return recap + characterLine + hooks[input.hookType];
}

/** Letterbox each selected panel to 1280x720 PNG; unreadable images are skipped. */
export async function normalizeOutroPanels(
  dir: string,
  panels: SelectedOutroPanel[],
  tempDir: string,
  checkBudget: () => void,
): Promise<{ normalizedPanels: string[]; usablePanels: SelectedOutroPanel[] }> {
  const normalizedPanels: string[] = [];
  const usablePanels: SelectedOutroPanel[] = [];
  for (let i = 0; i < panels.length; i++) {
    checkBudget();
    const panel = panels[i]!;
    const srcFile = path.join(dir, String(panel.panelFile || ''));
    if (!srcFile.startsWith(dir + path.sep)) continue;
    try { if (!regularFile(srcFile)) continue; } catch { continue; }
    const normFile = path.join(tempDir, `panel-${String(i).padStart(2, '0')}.png`);
    try {
      await sharp(srcFile)
        .rotate()
        .resize(1280, 720, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
        .removeAlpha()
        .png()
        .toFile(normFile);
      if (regularFile(normFile)) {
        normalizedPanels.push(normFile);
        usablePanels.push(panel);
      }
    } catch {
      // Skip unreadable image; fail below if none decode.
    }
  }
  if (!normalizedPanels.length) {
    throw new IntakeError('Selected panel images could not be decoded for outro video rendering', 422);
  }
  return { normalizedPanels, usablePanels };
}

/**
 * Encode the outro panel showcase. Without `encode` this is the historical English
 * command byte-for-byte; a caller may pass explicit encoder settings so the outro
 * stream matches its chapter videos (stream-copy concat).
 */
export async function encodeOutroShowcase(
  normalizedPanels: string[],
  audio: string | null,
  duration: number,
  tempDir: string,
  timeoutMs: number,
  encode?: { width: number; height: number; fps: number | string; videoArgs: string[]; audioArgs: string[] },
): Promise<string> {
  const list = path.join(tempDir, 'images.txt');
  const panelDuration = duration / normalizedPanels.length;
  fs.writeFileSync(
    list,
    normalizedPanels.map((p) => concatLine(p) + `\nduration ${panelDuration}`).join('\n')
      + '\n' + concatLine(normalizedPanels[normalizedPanels.length - 1]!) + '\n',
  );
  const tempVideo = path.join(tempDir, 'video.mp4');
  const w = encode?.width ?? 1280;
  const h = encode?.height ?? 720;
  // The `fps` filter holds every panel, the last one included, for its full share.
  // Output `-r` alone ends the video after one frame for a single panel and cuts
  // the last panel of a two-panel outro to two frames (ffmpeg n9 concat timing).
  const tail = encode ? `,fps=${encode.fps}` : ',fps=30,format=yuv420p';
  await checkedCommand(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    ...(audio ? ['-i', audio] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']), '-vf',
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1${tail}`,
    ...(encode ? [] : ['-r', '30']),
    ...(encode ? encode.videoArgs : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    ...(encode ? encode.audioArgs : ['-c:a', 'aac']),
    '-t', String(duration), '-movflags', '+faststart', tempVideo], timeoutMs);
  return tempVideo;
}

/** Bounded narration synthesis for a series outro (same engines as the English outro). */
export const synthesizeSeriesOutroAudio = synthesizeOutroAudio;
export { checkedCommand as runCheckedCommand, mediaDuration as probeMediaDuration, clampTimeout, withBoundedTimeout };

export async function generateSeriesOutro(opts: OutroOptions) {
  const dir = resolveSeriesDir(opts);
  return seriesWrite(dir, async () => {
    const totalTimeoutMs = clampTimeout(opts.timeoutMs ?? Number(process.env.MANHWA_OUTRO_TIMEOUT_MS), 90_000, 300, 105_000);
    const deadline = Date.now() + totalTimeoutMs;
    const remainingBudget = (maxPhaseMs: number, label = 'Outro generation'): number => {
      const rem = deadline - Date.now();
      if (rem <= 50) throw new IntakeError(`${label} timed out`, 422);
      return Math.min(maxPhaseMs, rem);
    };

    const inspected = inspectSeriesOutro(opts);
    const completed = getSeriesMergeState(opts).chapters.length;
    const coveredChapters = positiveCount(opts.coveredChapters, completed, 'coveredChapters');
    const totalChapters = positiveCount(opts.totalChapters, Math.max(coveredChapters, inspected.availableChapters.length), 'totalChapters');
    if (totalChapters < coveredChapters) throw new IntakeError('totalChapters cannot be smaller than coveredChapters');
    const hookType = opts.hookType || 'part2';
    if (!['part2', 'next_chapter', 'new_series', 'custom'].includes(hookType)) throw new IntakeError('Invalid outro hookType');
    if (hookType === 'custom' && !opts.customNote?.trim()) throw new IntakeError('customNote is required for a custom outro');
    if (!inspected.selectedPanels.length) {
      throw new IntakeError('No usable character or narrative panels available to generate an outro announcement', 422);
    }
    const script = buildOutroScript({ title: inspected.title, characters: inspected.characters,
      coveredChapters, totalChapters, hookType, customNote: opts.customNote, nextSeriesTitle: opts.nextSeriesTitle });
    const outroDir = path.join(dir, 'out', 'outro');
    const videoDir = path.join(outroDir, 'video');
    const finalVideo = path.join(videoDir, 'video.mp4');
    const audioDir = path.join(outroDir, 'audio');
    const finalAudio = path.join(audioDir, 'narration.mp3');
    const finalPlan = path.join(outroDir, 'outro-plan.json');
    const finalScript = path.join(outroDir, 'script.md');
    const finalShots = path.join(outroDir, 'shots.json');
    for (const target of [outroDir, videoDir, finalVideo, audioDir, finalAudio, finalPlan, finalScript, finalShots]) {
      assertNoSymlinks(target);
    }
    fs.mkdirSync(outroDir, { recursive: true });
    const plan = { schemaVersion: 1, slug: opts.slug, title: inspected.title, totalChapters, coveredChapters, hookType,
      customNote: opts.customNote || '', nextSeriesTitle: opts.nextSeriesTitle?.trim() || null,
      provider: opts.provider || null, voice: opts.voice || null,
      script, characters: inspected.characters,
      selectedPanels: inspected.selectedPanels, generatedAt: new Date().toISOString() };
    if (opts.renderVideo === false) {
      writeJson(finalPlan, plan);
      assertNoSymlinks(finalScript);
      fs.writeFileSync(finalScript, script + '\n');
      writeJson(finalShots, { fps: 30, width: 1280, height: 720, selectedPanels: inspected.selectedPanels,
        shots: inspected.selectedPanels.map((p, i) => ({ ...p, start: i * 2, duration: 2 })) });
      const hasVideo = regularFile(finalVideo);
      const videoUpdatedAt = hasVideo ? Math.trunc(fs.statSync(finalVideo).mtimeMs) : null;
      return { ok: true as const, ...plan, panels: inspected.selectedPanels, rendered: false, hasVideo,
        renderError: null, audioError: null, warning: null,
        audioUrl: regularFile(finalAudio) ? `/media/${encodeURIComponent(opts.slug)}/outro/audio.mp3` : null,
        videoUrl: hasVideo ? `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4` : null,
        videoUpdatedAt,
        attachment: resolveOutroAttachment(dir, renderedChapters(dir)) };
    }

    fs.mkdirSync(videoDir, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(videoDir, '.outro-'));
    try {
      await checkedCommand(['ffmpeg', '-version'], remainingBudget(10_000, 'ffmpeg check'));
      const { normalizedPanels, usablePanels } = await normalizeOutroPanels(
        dir, inspected.selectedPanels, tempDir, () => remainingBudget(1_000, 'Panel normalization'));

      const tmpScript = path.join(tempDir, 'script.md');
      fs.writeFileSync(tmpScript, script + '\n');
      let duration = usablePanels.length * 2;
      let tmpAudio: string | null = null;
      let audioError: string | null = null;
      if (opts.synthesizeAudio !== false) {
        try {
          const candidateAudio = path.join(tempDir, 'narration.mp3');
          const requestedTtsMs = clampTimeout(opts.ttsTimeoutMs ?? Number(process.env.MANHWA_OUTRO_TTS_TIMEOUT_MS), 25_000, 100, 45_000);
          const renderReserveMs = opts.ttsTimeoutMs !== undefined ? 0 : Math.min(20_000, Math.floor(totalTimeoutMs * 0.25));
          const availForTts = Math.max(100, (deadline - Date.now()) - renderReserveMs);
          duration = await synthesizeOutroAudio(dir, script, tmpScript, candidateAudio,
            { provider: opts.provider, voice: opts.voice, timeoutMs: Math.min(requestedTtsMs, availForTts) });
          tmpAudio = candidateAudio;
        } catch (err) {
          audioError = (err as Error).message || 'Narration synthesis failed; generated a silent panel showcase';
        }
      }

      const panelDuration = duration / normalizedPanels.length;
      const requestedRenderMs = clampTimeout(opts.renderTimeoutMs ?? Number(process.env.MANHWA_OUTRO_RENDER_TIMEOUT_MS), 45_000, 100, 60_000);
      const renderTimeoutMs = remainingBudget(requestedRenderMs, 'Outro video render');
      const tempVideo = await encodeOutroShowcase(normalizedPanels, tmpAudio, duration, tempDir, renderTimeoutMs);
      if (!regularFile(tempVideo)) throw new IntakeError('Outro video render produced an empty file', 422);
      const probedDuration = await mediaDuration(tempVideo, remainingBudget(10_000, 'Outro video verification'));
      if (!probedDuration) throw new IntakeError('Outro video render produced an unreadable MP4 stream', 422);

      remainingBudget(100, 'Outro commit');
      const audioUrl = tmpAudio ? `/media/${encodeURIComponent(opts.slug)}/outro/audio.mp3` : null;
      const committedPlan = { ...plan, selectedPanels: usablePanels };
      const committedShots = { fps: 30, width: 1280, height: 720, duration, audioUrl,
        selectedPanels: usablePanels,
        shots: usablePanels.map((p, i) => ({ ...p, start: i * panelDuration, duration: panelDuration })) };
      const tmpPlan = path.join(tempDir, 'outro-plan.json');
      const tmpShots = path.join(tempDir, 'shots.json');
      fs.writeFileSync(tmpPlan, JSON.stringify(committedPlan, null, 2) + '\n');
      fs.writeFileSync(tmpShots, JSON.stringify(committedShots, null, 2) + '\n');

      // Validate all commit destination paths before replacing any existing output.
      for (const target of [outroDir, videoDir, finalVideo, audioDir, finalAudio, finalPlan, finalScript, finalShots]) {
        assertNoSymlinks(target);
      }
      if (tmpAudio) {
        fs.mkdirSync(audioDir, { recursive: true });
        assertNoSymlinks(audioDir);
        assertNoSymlinks(finalAudio);
        fs.renameSync(tmpAudio, finalAudio);
      } else if (fs.existsSync(finalAudio)) {
        assertNoSymlinks(finalAudio);
        fs.rmSync(finalAudio, { force: true });
      }
      fs.renameSync(tempVideo, finalVideo);
      fs.renameSync(tmpPlan, finalPlan);
      fs.renameSync(tmpScript, finalScript);
      fs.renameSync(tmpShots, finalShots);
      const videoUpdatedAt = Math.trunc(fs.statSync(finalVideo).mtimeMs);
      return { ok: true as const, ...committedPlan, panels: usablePanels, rendered: true, hasVideo: true,
        renderError: null, audioError, warning: audioError, audioUrl,
        videoUrl: `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4`,
        videoUpdatedAt,
        attachment: resolveOutroAttachment(dir, renderedChapters(dir)) };
    } catch (err) {
      if (err instanceof IntakeError) throw err;
      throw new IntakeError(`Outro video render failed: ${(err as Error).message}`, 422);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

/* ------------------------------------------------------------------ *
 * Series outro attachment (non-destructive "use after Chapter N")
 * ------------------------------------------------------------------ */

/**
 * Persisted, series-level preference saying "this rendered outro belongs at the end of
 * the series compilation". It is pure bookkeeping: no chapter video is ever rewritten.
 */
interface OutroAttachmentRecord {
  schemaVersion: number;
  enabled: boolean;
  /** Newest rendered chapter at the moment the attachment was saved (audit snapshot). */
  targetChapter: string | null;
  attachedAt: string | null;
  detachedAt: string | null;
  /** Size/mtime of the attached outro render, so a regeneration is detectable. */
  video: { size: number; mtimeMs: number } | null;
}

export interface OutroAttachmentState {
  /** An explicit saved preference exists (attachment.json). False means legacy default. */
  explicit: boolean;
  enabled: boolean;
  /** Chapter the outro currently follows: always the newest rendered chapter. */
  targetChapter: string | null;
  /** Newest rendered chapter right now. */
  tailChapter: string | null;
  /** Chapters were added after the saved snapshot; the outro still stays last. */
  addedSinceAttach: boolean;
  /** The rendered outro changed after it was attached (regenerated). */
  videoChanged: boolean;
  /** Attached but the outro video is absent or empty. */
  missing: boolean;
  /** Attached and enabled, but the render is gone: merging would silently drop it. */
  blocked: boolean;
  /** A readable outro render exists right now. */
  videoAvailable: boolean;
  /** The saved preference no longer matches the artifacts on disk. */
  stale: boolean;
  attachedAt: string | null;
  /** What a Merge All Chapters click will do right now. */
  nextMergeIncludesOutro: boolean;
  /** Human-readable summary for the UI. */
  message: string;
}

const OUTRO_REL = path.join('out', 'outro', 'video', 'video.mp4');
const OUTRO_ATTACHMENT_REL = path.join('out', 'outro', 'attachment.json');

function renderedChapters(dir: string): string[] {
  const out = path.join(dir, 'out');
  return namesIn(out)
    .filter((name) => /^ch\d+$/.test(name) && regularFile(path.join(out, name, 'video', 'video.mp4')))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

function readOutroAttachment(dir: string): OutroAttachmentRecord | null {
  const file = path.join(dir, OUTRO_ATTACHMENT_REL);
  assertNoSymlinks(file);
  const raw = readJsonValue(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Json;
  if (typeof rec.enabled !== 'boolean') return null;
  const target = typeof rec.targetChapter === 'string' && /^ch\d+$/.test(rec.targetChapter) ? rec.targetChapter : null;
  const video = rec.video && typeof rec.video === 'object' && !Array.isArray(rec.video)
    && Number.isFinite(Number((rec.video as Json).size)) && Number.isFinite(Number((rec.video as Json).mtimeMs))
    ? { size: Number((rec.video as Json).size), mtimeMs: Number((rec.video as Json).mtimeMs) }
    : null;
  return {
    schemaVersion: Number(rec.schemaVersion) || 1,
    enabled: rec.enabled,
    targetChapter: target,
    attachedAt: typeof rec.attachedAt === 'string' ? rec.attachedAt : null,
    detachedAt: typeof rec.detachedAt === 'string' ? rec.detachedAt : null,
    video,
  };
}

function outroVideoSignature(dir: string): { size: number; mtimeMs: number } | null {
  const file = path.join(dir, OUTRO_REL);
  if (!regularFile(file)) return null;
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
}

/**
 * Resolve the effective outro attachment.
 *
 * Backward compatibility: when no `attachment.json` exists the legacy behaviour is
 * kept — a rendered outro is included by Merge All Chapters automatically. An explicit
 * saved preference (enabled or disabled) always wins over that default.
 */
function resolveOutroAttachment(dir: string, chapters: string[]): OutroAttachmentState {
  const tailChapter = chapters.length ? chapters[chapters.length - 1]! : null;
  const record = readOutroAttachment(dir);
  const explicit = record !== null;
  const enabled = explicit ? record.enabled : true;
  const signature = outroVideoSignature(dir);
  const videoOk = signature !== null;
  const addedSinceAttach = Boolean(explicit && enabled && record.targetChapter && tailChapter && record.targetChapter !== tailChapter);
  const videoChanged = Boolean(explicit && enabled && signature && record.video
    && (record.video.size !== signature.size || record.video.mtimeMs !== signature.mtimeMs));
  const missing = Boolean(enabled && !videoOk);
  const nextMergeIncludesOutro = Boolean(enabled && videoOk);
  // An enabled attachment whose render vanished must not merge silently without it.
  const blocked = Boolean(explicit && enabled && !videoOk);
  const stale = Boolean(explicit && enabled && (missing || videoChanged));
  const targetChapter = enabled ? tailChapter : null;
  let message: string;
  if (!explicit) {
    message = videoOk
      ? 'No explicit choice saved: Merge All Chapters includes the generated outro automatically (legacy default).'
      : 'No explicit choice saved, and no outro video is rendered yet.';
  } else if (!enabled) {
    message = 'Detached: Merge All Chapters includes chapters only.';
  } else if (missing) {
    message = 'Attached, but the outro video is missing. Merge is blocked until you regenerate it or detach the attachment.';
  } else if (videoChanged) {
    message = `Attached outro after ${targetChapter ?? 'the last chapter'}, but the rendered outro changed. Merge uses the current render.`;
  } else if (addedSinceAttach) {
    message = `Attached after ${record.targetChapter}, and ${targetChapter} is now the last chapter. The outro still stays at the very end.`;
  } else {
    message = `Attached as series outro after ${targetChapter ?? 'the last chapter'}. Original chapter files are unchanged.`;
  }
  return {
    explicit, enabled,
    targetChapter, tailChapter, addedSinceAttach, videoChanged, missing, blocked,
    videoAvailable: videoOk, stale,
    attachedAt: record?.attachedAt ?? null,
    nextMergeIncludesOutro, message,
  };
}

/** Attach or detach the rendered outro for a series. Never rewrites chapter videos. */
export async function setSeriesOutroAttachment(opts: SeriesOptions & { enabled: boolean }) {
  const dir = resolveSeriesDir(opts);
  if (typeof opts.enabled !== 'boolean') throw new IntakeError('enabled must be a boolean');
  return seriesWrite(dir, async () => {
    const chapters = renderedChapters(dir);
    const attachmentFile = path.join(dir, OUTRO_ATTACHMENT_REL);
    assertNoSymlinks(attachmentFile);
    const previous = readOutroAttachment(dir);
    const now = new Date().toISOString();
    if (opts.enabled) {
      if (!chapters.length) throw new IntakeError('Render at least one chapter video before attaching an outro', 409);
      const signature = outroVideoSignature(dir);
      if (!signature) throw new IntakeError('Generate the outro video before attaching it to the series', 409);
      const duration = await mediaDuration(path.join(dir, OUTRO_REL));
      if (!duration) throw new IntakeError('The outro video is not a readable MP4 stream; regenerate it before attaching', 409);
      const record: OutroAttachmentRecord = {
        schemaVersion: 1, enabled: true,
        targetChapter: chapters[chapters.length - 1]!,
        attachedAt: now, detachedAt: previous?.detachedAt ?? null,
        // Re-enabling an already-attached outro re-snapshots the current render, which
        // is the explicit "use current outro" acknowledgement for a regenerated video.
        video: signature,
      };
      writeJson(attachmentFile, record);
    } else {
      const record: OutroAttachmentRecord = {
        schemaVersion: 1, enabled: false, targetChapter: null,
        attachedAt: null, detachedAt: now, video: null,
      };
      // Detaching must work even when out/outro/ was removed with the render.
      fs.mkdirSync(path.dirname(attachmentFile), { recursive: true });
      assertNoSymlinks(path.dirname(attachmentFile));
      writeJson(attachmentFile, record);
    }
    const attachment = resolveOutroAttachment(dir, renderedChapters(dir));
    return { ok: true as const, slug: opts.slug, attachment, merge: getSeriesMergeState(opts) };
  });
}

export function getSeriesMergeState(opts: SeriesOptions & { includeOutro?: boolean }) {
  const dir = resolveSeriesDir(opts);
  const out = path.join(dir, 'out');
  const chapters = renderedChapters(dir);
  const attachment = resolveOutroAttachment(dir, chapters);
  const outroFile = path.join(dir, OUTRO_REL);
  const outroAvailable = regularFile(outroFile);
  // An explicit API override wins for this one merge; otherwise the saved preference
  // (or the legacy default when nothing is saved) decides.
  const includesOutro = typeof opts.includeOutro === 'boolean'
    ? Boolean(opts.includeOutro && outroAvailable)
    : attachment.nextMergeIncludesOutro;
  const sources = chapters.map((ch) => path.join(out, ch, 'video', 'video.mp4'));
  if (includesOutro && !sources.some((file) => path.resolve(file) === path.resolve(outroFile))) {
    sources.push(outroFile);
  }
  const full = path.join(out, 'full', 'video', 'video.mp4');
  const merged = regularFile(full);
  const sizeBytes = merged ? fs.statSync(full).size : 0;
  const signature = sources.map((file) => ({ file: path.relative(dir, file), size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }));
  const previous = readJson(path.join(out, 'full', 'video', 'merge.json'));
  const stale = merged && (previous.sources ? JSON.stringify(previous.sources) !== JSON.stringify(signature) : sources.some((f) => fs.statSync(f).mtimeMs > fs.statSync(full).mtimeMs));
  return { slug: opts.slug, chapters, chaptersMerged: chapters, includesOutro, merged, stale,
    canMerge: chapters.length > 0, sizeBytes, size: sizeBytes,
    attachment,
    outro: {
      included: includesOutro,
      // With a one-off API override the saved target may be absent; report the actual tail.
      targetChapter: includesOutro ? (attachment.targetChapter ?? (chapters.length ? chapters[chapters.length - 1]! : null)) : null,
      /** Position in the concatenation, 1-based; the outro is always the final segment. */
      position: includesOutro ? sources.length : null,
      videoUrl: outroAvailable ? `/media/${encodeURIComponent(opts.slug)}/outro/video.mp4` : null,
    },
    downloadUrl: merged ? `/media/${encodeURIComponent(opts.slug)}/full.mp4` : null,
    sources: signature };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Concatenate verified MP4 segments into `tempOut`. Streams are copied when every
 * segment has the same stream signature; otherwise the compilation is re-encoded.
 * Shared by the English and language merges.
 */
export async function concatVideoSegments(
  sources: string[],
  temp: string,
  tempOut: string,
  options: { compareExtradata?: boolean } = {},
): Promise<{ sizeBytes: number; duration: number; copied: boolean; expected: number }> {
  const list = path.join(temp, 'concat.txt');
  fs.writeFileSync(list, sources.map(concatLine).join('\n') + '\n');
  // The concat demuxer silently skips an unreadable input and still exits 0, which
  // would drop the attached outro from the compilation. Validate every segment first.
  const segmentDurations: number[] = [];
  for (const file of sources) {
    const duration = await mediaDuration(file);
    if (!duration) {
      throw new IntakeError(`ffmpeg failed: ${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)} is not a readable MP4 stream`, 422);
    }
    segmentDurations.push(duration);
  }
  // `compareExtradata` also pins the H.264 parameter sets (SPS/PPS), so a stream
  // copy is only attempted when every video segment decodes with the same headers.
  // AAC config bytes may differ by encoder version (explicit "no SBR" signalling)
  // while codec, profile, rate and layout match, which the fields above already pin.
  // A 100-chapter language merge would otherwise spawn hundreds of ffprobe at once; a
  // timed-out probe reads as "streams differ" and forces a full re-encode of ~19 GB.
  const probeLimit = options.compareExtradata ? 8 : Math.max(1, sources.length);
  const signatures = await mapLimit(sources, probeLimit, async (file) => {
    try {
      const streams = await checkedCommand(['ffprobe', '-v', 'error', '-show_entries',
        'stream=codec_name,codec_type,width,height,pix_fmt,time_base,sample_rate,channel_layout'
          + (options.compareExtradata ? ',profile' : ''), '-of', 'json', file], 15_000);
      if (!options.compareExtradata) return streams;
      // Project the decode-relevant fields only: container side data (an ICC
      // profile, for one) is carried by the first segment and never changes decoding.
      const keys = ['codec_name', 'profile', 'codec_type', 'width', 'height', 'pix_fmt', 'time_base', 'sample_rate', 'channel_layout'];
      const parsed = (JSON.parse(streams) as { streams?: Json[] }).streams ?? [];
      const projected = JSON.stringify(parsed.map((s) => keys.map((k) => s[k] ?? null)));
      const headers = await checkedCommand(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_data_hash', 'sha256',
        '-show_entries', 'stream=extradata_hash', '-of', 'json', file], 15_000);
      const hashes = ((JSON.parse(headers) as { streams?: Json[] }).streams ?? []).map((s) => s.extradata_hash ?? null);
      return `${projected}\n${JSON.stringify(hashes)}`;
    } catch { return ''; }
  });
  const base = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  let copy = false;
  if (signatures.every((s) => s && s === signatures[0])) {
    try { await checkedCommand([...base, '-c', 'copy', '-movflags', '+faststart', tempOut]); copy = true; } catch { /* Re-encode below. */ }
  }
  if (!copy) await checkedCommand([...base, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', tempOut]);
  const sizeBytes = fs.statSync(tempOut).size;
  if (!sizeBytes) throw new IntakeError('Merged video is empty', 422);
  const duration = await mediaDuration(tempOut);
  if (!duration) throw new IntakeError('Merged video is not a readable MP4 stream', 422);
  // A silently skipped segment would shrink the output; refuse to publish that.
  // Bounded tolerance: encoder/container rounding is tens of milliseconds, so a
  // purely proportional allowance would let a whole short outro vanish unnoticed
  // from a long compilation. Scale per segment, then cap well below any real outro.
  const expected = segmentDurations.reduce((sum, value) => sum + value, 0);
  const timingTolerance = Math.min(0.4, 0.05 + sources.length * 0.002);
  if (duration < expected - timingTolerance) {
    throw new IntakeError(
      `ffmpeg failed: merged video is ${duration.toFixed(2)}s but its segments total ${expected.toFixed(2)}s`,
      422,
    );
  }
  if (options.compareExtradata) {
    // The container duration is the longest stream, so a segment whose video ends
    // early (audio still running) would pass the check above. Pin the video track.
    const videoOut = await videoStreamDuration(tempOut);
    const videoParts = await mapLimit(sources, probeLimit, (file) => videoStreamDuration(file));
    const videoExpected = videoParts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (!videoOut || videoParts.some((v) => !v) || videoOut < videoExpected - timingTolerance) {
      throw new IntakeError(
        `ffmpeg failed: merged video track is ${(videoOut ?? 0).toFixed(2)}s but its segments total ${videoExpected.toFixed(2)}s`,
        422,
      );
    }
  }
  return { sizeBytes, duration, copied: copy, expected };
}

/** Duration of the first video stream (frames / rate when the header has none). */
export async function videoStreamDuration(file: string, timeoutMs = 15_000): Promise<number | null> {
  try {
    const text = await checkedCommand(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], timeoutMs);
    const n = Number(text.trim().split(/[\s,]+/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export async function mergeSeriesChapters(opts: SeriesOptions & { includeOutro?: boolean }) {
  const dir = resolveSeriesDir(opts);
  return seriesWrite(dir, async () => {
    const state = getSeriesMergeState(opts);
    if (!state.chapters.length) throw new IntakeError('No rendered chapter videos to merge', 409);
    // An enabled attachment whose render disappeared would otherwise be dropped silently.
    // Only an explicit one-off includeOutro:false may merge chapters-only in that state.
    if (state.attachment.blocked && opts.includeOutro !== false) {
      throw new IntakeError(
        'The attached outro video is missing. Regenerate it, detach the outro, or merge with includeOutro=false to compile chapters only.',
        409,
      );
    }
    const dest = path.join(dir, 'out', 'full', 'video');
    assertNoSymlinks(dest);
    fs.mkdirSync(dest, { recursive: true });
    const temp = fs.mkdtempSync(path.join(dest, '.merge-'));
    const tempOut = path.join(temp, 'video.mp4');
    try {
      const sources = state.sources.map((s) => path.join(dir, s.file));
      // The outro is appended exactly once: reject a duplicate source list outright.
      const seen = new Set<string>();
      for (const file of sources) {
        const key = path.resolve(file);
        if (seen.has(key)) throw new IntakeError('Refusing to merge a duplicated source segment', 422);
        seen.add(key);
      }
      const { sizeBytes, duration } = await concatVideoSegments(sources, temp, tempOut);
      const manifest = {
        sources: state.sources,
        includesOutro: state.includesOutro,
        outroTargetChapter: state.outro.targetChapter,
        attachmentExplicit: state.attachment.explicit,
        duration,
        mergedAt: new Date().toISOString(),
      };
      const tempManifest = path.join(temp, 'merge.json');
      fs.writeFileSync(tempManifest, JSON.stringify(manifest, null, 2) + '\n');
      assertNoSymlinks(path.join(dest, 'video.mp4'));
      assertNoSymlinks(path.join(dest, 'merge.json'));
      // Commit the video first, then its manifest: a crash between the two leaves a
      // signature mismatch, which the state reader reports as stale rather than "fresh".
      fs.renameSync(tempOut, path.join(dest, 'video.mp4'));
      fs.renameSync(tempManifest, path.join(dest, 'merge.json'));
      // A successful merge that used the attached outro re-snapshots it, so a regenerated
      // render stops being reported stale forever (still under the same exclusive lock).
      if (state.attachment.explicit && state.attachment.enabled && state.includesOutro) {
        const signature = outroVideoSignature(dir);
        const previous = readOutroAttachment(dir);
        if (signature && previous) {
          writeJson(path.join(dir, OUTRO_ATTACHMENT_REL), {
            ...previous,
            targetChapter: state.chapters[state.chapters.length - 1] ?? previous.targetChapter,
            video: signature,
          } as OutroAttachmentRecord);
        }
      }
      return { ok: true as const, merged: true as const, slug: opts.slug,
        downloadUrl: `/media/${encodeURIComponent(opts.slug)}/full.mp4`,
        chaptersMerged: state.chapters, chapters: state.chapters,
        includesOutro: state.includesOutro, sizeBytes, size: sizeBytes,
        attachment: resolveOutroAttachment(dir, state.chapters),
        outro: state.outro, sources: state.sources,
        duration };
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
  /** Test/offline seam for the saved-Drive recovery download; defaults to downloadGdriveZip. */
  downloadFn?: typeof downloadGdriveZip;
}

/**
 * Short, single-line reason for an extension failure. Server paths are stripped:
 * the message reaches API clients, so it must not disclose the host layout.
 */
function sanitizeExtendError(err: unknown, stripRoots: string[] = []): string {
  let raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  for (const root of stripRoots) {
    if (!root) continue;
    raw = raw.split(root).join('<series>');
  }
  raw = raw.replace(/(?:^|\s)\/[^\s,;:]+/g, ' <path>');
  return raw.split(/\s+/).filter(Boolean).join(' ').slice(0, 300);
}

interface ExtensionArchive {
  path: string;
  /** Retain this archive in the series after a successful read. */
  retain: boolean;
  sourceType: string;
  sourceSummary: string;
  gdriveFileId: string | null;
  jobId: string | null;
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
  // Ranges are resolved without the on-disk list: this is the set the user asked
  // for, including chapters that are not imported yet.
  const requested = spec === 'all' ? [] : parseChapterSpec(spec, []);
  const completedNums = new Set(getSeriesMergeState(opts).chapters.map((ch) => Number(ch.slice(2))));
  // Non-fatal notes (for example a source that imported but could not be retained).
  const warnings: string[] = [];
  // Download into a bounded temporary directory, never into completed chapter outputs.
  let downloadDir: string | null = null;
  let explicitZip = opts.zipPath;
  const downloadSource = opts.downloadFn ?? downloadGdriveZip;
  const scratch = (): string => {
    const scratchBase = process.env.MANHWA_SCRATCH_DIR || os.tmpdir();
    fs.mkdirSync(scratchBase, { recursive: true });
    downloadDir = downloadDir ?? fs.mkdtempSync(path.join(scratchBase, 'series-extension-'));
    return downloadDir;
  };
  try {
    if (opts.gdriveUrl) {
      explicitZip = path.join(scratch(), 'source.zip');
      // Same seam as the legacy recovery path, so an explicit URL is testable
      // offline and never reaches the network when a downloadFn is supplied.
      await downloadSource(parseGdriveUrl(opts.gdriveUrl).fileId, explicitZip);
    }
    // Legacy recovery needs the network, so decide and download before the series
    // lock is taken (the lock callback itself must stay synchronous).
    let recovered: { path: string; fileId: string; jobId: string | null } | null = null;
    // Snapshot before the lock so the locked callback does not re-index archives.
    const retainedBeforeLock = explicitZip ? [] : listRetainedSources(dir);
    // Only genuinely missing chapters decide whether a saved source is good enough:
    // a legacy ZIP holding ch2-3 is fine for request 1-3 when ch1 is already done.
    const onDiskBeforeLock = existingChapterNumbers(dir);
    const missingBeforeLock = requested.filter(
      (n) => !onDiskBeforeLock.includes(n) && !completedNums.has(n),
    );
    const savedBeforeLock = explicitZip
      ? null
      : findRecoverableSeriesSource(opts.slug, missingBeforeLock, env);
    if (!explicitZip && savedBeforeLock) {
      const legacy = savedBeforeLock;
      // A retained archive may cover only part of the range; its entry still names
      // the original Drive file, which can fill the rest in one download.
      const fileId = legacy.gdriveFileId;
      const needed = legacy.origin === 'job_gdrive' ? missingBeforeLock : legacy.uncovered;
      const wantsRecovery = fileId
        ? legacy.origin === 'job_gdrive'
          // "all" with no usable local source is exactly when the remote copy matters.
          ? (requested.length ? needed.length > 0 : retainedBeforeLock.length === 0)
          : needed.length > 0
        : false;
      if (fileId && wantsRecovery) {
        const dest = path.join(scratch(), 'recovered-source.zip');
        try {
          await downloadSource(fileId, dest);
        } catch (err) {
          const shown = needed.length ? needed.map((n) => `ch${n}`).join(', ') : 'the new chapters';
          throw new IntakeError(
            `This series' saved Google Drive source (file ID ${fileId}) can no longer be downloaded: ` +
              `${sanitizeExtendError(err)}. Re-add ${shown} with the original ZIP or a fresh Drive link; ` +
              'completed videos, bible and caches are preserved.',
            409,
          );
        }
        recovered = { path: dest, fileId, jobId: legacy.jobId };
      }
    }
    await seriesWrite(dir, async () => {
      withJobMetaLock(env, () => {
        const conflict = reconcileJobs(env).find((j) => j.slug === opts.slug && ['queued', 'paused', 'downloading', 'ingesting', 'running'].includes(j.status));
        if (conflict) throw new ConflictError(`Series already has an active/queued job (${conflict.id})`);
        const onDisk = new Set(existingChapterNumbers(dir));
        // Re-read the authoritative completed set under the series lock: a render
        // may have finished between the pre-lock snapshot and this import, and its
        // chapter must not be treated as missing or have its pages recreated.
        const completedNow = new Set(getSeriesMergeState(opts).chapters.map((ch) => Number(ch.slice(2))));
        for (const n of completedNow) completedNums.add(n);

        // Chapter folders are validated up front: they are a source like any other,
        // and their coverage must be known before anything is imported.
        const folderSources: Array<{ name: string; chapters: number[] }> = [];
        for (const folder of opts.chapterFolders || []) {
          assertNoSymlinks(folder);
          const name = path.basename(folder);
          if (!/^ch\d+$/.test(name) || !fs.statSync(folder).isDirectory()) throw new IntakeError('Each chapter folder must be named chN');
          if (spec !== 'all' && !requested.includes(Number(name.slice(2)))) continue;
          folderSources.push({ name, chapters: [Number(name.slice(2))] });
        }

        // Sources this request may read, best first. A series-level retained
        // archive is the durable copy of the original ZIP; the explicit upload
        // wins because the user just supplied it.
        const archives: ExtensionArchive[] = [];
        if (explicitZip) {
          assertNoSymlinks(explicitZip);
          archives.push({
            path: explicitZip,
            retain: true,
            sourceType: opts.sourceType || (opts.gdriveUrl ? 'gdrive' : 'upload'),
            // Never persist a server staging filename in series metadata.
            sourceSummary: opts.gdriveUrl
              ? `Google Drive ZIP (file ID: ${parseGdriveUrl(opts.gdriveUrl).fileId})`
              : 'Uploaded extension ZIP',
            gdriveFileId: opts.gdriveUrl ? parseGdriveUrl(opts.gdriveUrl).fileId : null,
            jobId: null,
          });
        } else {
          for (const entry of listRetainedSources(dir)) {
            const archivePath = retainedArchivePath(dir, entry);
            if (!archivePath) continue;
            archives.push({
              path: archivePath,
              retain: false,
              sourceType: entry.sourceType,
              sourceSummary: entry.sourceSummary || `Retained source ZIP (${entry.file})`,
              gdriveFileId: entry.gdriveFileId,
              jobId: entry.jobId,
            });
          }
          // Older series never retained a source, but their original job may still
          // hold a staging ZIP. Recover it once and retain it so the next extension
          // does not depend on job history. (A retained archive is already listed
          // above, so only a staged job ZIP is added here.)
          const legacy = savedBeforeLock;
          if (legacy?.origin === 'job_staged' && legacy.zipPath
            && !archives.some((a) => path.resolve(a.path) === path.resolve(legacy.zipPath!))) {
            archives.push({
              path: legacy.zipPath,
              retain: true,
              sourceType: 'upload',
              sourceSummary: legacy.sourceSummary,
              gdriveFileId: legacy.gdriveFileId,
              jobId: legacy.jobId,
            });
          }
          // A re-downloaded Drive ZIP complements partial retained coverage.
          if (recovered) {
            archives.push({
              path: recovered.path,
              retain: true,
              sourceType: 'gdrive',
              sourceSummary: `Recovered Google Drive ZIP (file ID: ${recovered.fileId})`,
              gdriveFileId: recovered.fileId,
              jobId: recovered.jobId,
            });
          }
        }

        // Index every archive before mutating anything, so a hostile or corrupt
        // ZIP cannot leave the series half-imported.
        const indexes = archives.map((archive) => {
          try {
            return { archive, idx: archiveIndex(archive.path, true)[1] as Record<number, unknown> };
          } catch (err) {
            throw new IntakeError(
              `Cannot read the supplied source ZIP: ${sanitizeExtendError(err, [dir, opts.seriesRoot])}`,
              422,
            );
          }
        });
        const sourceNums = new Set<number>();
        for (const { idx } of indexes) for (const key of Object.keys(idx)) sourceNums.add(Number(key));
        const folderNums = new Set<number>(folderSources.flatMap((source) => source.chapters));
        const wanted = spec === 'all'
          ? [...new Set([...onDisk, ...sourceNums, ...folderNums])].sort((a, b) => a - b)
          : requested;
        // Coverage is validated across every source BEFORE any ingestion: a partial
        // archive must not leave the series half-mutated and then fail.
        const covered = new Set<number>([...onDisk, ...sourceNums, ...folderNums, ...completedNums]);
        const uncovered = wanted.filter((n) => !covered.has(n));
        if (uncovered.length) {
          const shown = uncovered.map((n) => `ch${n}`).join(', ');
          const have = [...covered].sort((a, b) => a - b).map((n) => `ch${n}`).join(', ') || 'none';
          const saved = sourceNums.size || folderNums.size
            ? 'the supplied source does not contain them'
            : listRetainedSources(dir).length
              ? 'the saved source archive does not contain them'
              : 'this series has no saved source archive (older series deleted the original ZIP)';
          throw new IntakeError(
            `Chapter(s) ${shown} are not in this series and ${saved}. ` +
              `Available: ${have}. Nothing was imported. ` +
              `Re-add these chapters with the original ZIP or its Google Drive link in Add Chapters; ` +
              'completed videos, bible and caches are preserved.',
            409,
          );
        }
        // Import only chapters that are genuinely absent and not already rendered.
        // A completed chapter may have no raw folder left; never recreate its pages.
        const missing = wanted.filter((n) => !onDisk.has(n) && !completedNums.has(n));
        for (const { archive, idx } of indexes) {
          const take = missing.filter((n) => n in idx && !onDisk.has(n) && !completedNums.has(n));
          if (!take.length) continue;
          ingest(opts.slug, { seriesRoot: opts.seriesRoot, zipPath: archive.path, chapters: take, interactive: false, force: false });
          for (const n of take) onDisk.add(n);
        }
        for (const source of folderSources) {
          const n = source.chapters[0]!;
          if (onDisk.has(n) || completedNums.has(n)) continue;
          const folder = (opts.chapterFolders || []).find((candidate) => path.basename(candidate) === source.name)!;
          const dest = path.join(dir, source.name);
          assertNoSymlinks(dest);
          if (fs.existsSync(dest)) { onDisk.add(n); continue; }
          fs.cpSync(folder, dest, { recursive: true, force: false, errorOnExist: true, filter: (src) => {
            if (fs.lstatSync(src).isSymbolicLink()) throw new IntakeError('Chapter folders cannot contain symlinks');
            return true;
          } });
          onDisk.add(n);
        }
        // Retain only after the request succeeded: a rejected request must not leave
        // a new archive behind, and an explicit upload is deleted by the caller.
        // A retention failure must not fail an import that already worked: the
        // chapters are on disk, so report a warning instead of discarding success.
        for (const { archive } of indexes) {
          if (!archive.retain) continue;
          try {
            retainSourceArchive(dir, archive.path, {
              sourceType: archive.sourceType,
              sourceSummary: archive.sourceSummary,
              gdriveFileId: archive.gdriveFileId,
              jobId: archive.jobId,
            });
          } catch (err) {
            warnings.push(
              `Chapters were imported, but the source archive could not be saved for later extensions: ` +
                `${sanitizeExtendError(err, [dir, opts.seriesRoot])}. Re-upload the ZIP when adding more chapters.`,
            );
          }
        }
      });
    });
    const completedChapters = getSeriesMergeState(opts).chapters;
    const available = existingChapterNumbers(dir);
    const wanted = spec === 'all' ? available : parseChapterSpec(spec, available);
    const missing = wanted.filter((n) => !available.includes(n) && !completedChapters.includes(`ch${n}`));
    if (missing.length) {
      throw new IntakeError(
        `Chapter(s) ${missing.map((n) => `ch${n}`).join(', ')} could not be imported. ` +
          'Re-add them with the original ZIP or its Google Drive link in Add Chapters; ' +
          'completed videos, bible and caches are preserved.',
        409,
      );
    }
    // Only chapters without a finished video are queued; completed work stays untouched.
    const pending = wanted.filter((n) => available.includes(n) && !completedChapters.includes(`ch${n}`));
    if (!pending.length) return { ok: true as const, slug: opts.slug, queued: false, chapters: '', completedChapters,
      preservedChapters: completedChapters, newChapters: [], targetChapters: '', job: null,
      ...(warnings.length ? { warnings } : {}) };
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
      preservedChapters: completedChapters, newChapters: pending.map((n) => `ch${n}`), targetChapters: chapters, job,
      ...(warnings.length ? { warnings } : {}) };
  } finally { if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true }); }
}
