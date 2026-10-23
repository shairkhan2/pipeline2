/**
 * Regression coverage for the backend fixes:
 *   - lane-wide control is retired (409, no job mutation or signal),
 *   - StudioSettings persists `defaultRenderLane` and validates it,
 *   - an omitted renderLane/renderQuality reaches the persisted defaults,
 *   - Vertex voices carry model metadata and keep the Gemini family visible,
 *   - `sbx login` output parsing returns only real browser URLs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  controlRenderLane,
  createJob,
  enqueueJob,
  getCatalog,
  getJob,
  loadRawTtsProviders,
  renderLaneEnv,
  resolveRequestedRenderLane,
  retryJob,
  runWorkerOnce,
} from '../src/intake/intake.js';
import { getStudioSettings, putStudioSettings } from '../src/config/studioConfig.js';
import {
  GEMINI_TTS_MODEL,
  listVertexTtsVoices,
  VERTEX_TTS_VOICES,
} from '../src/llm/vertexTts.js';
import { parseSbxLoginOutput } from '../src/workers/nodeRegistry.js';

let root: string;
let outDir: string;
let seriesRoot: string;
const slug = 'lane-fan';

function write(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function json(file: string, value: unknown) {
  return write(file, JSON.stringify(value));
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    MANHWA_OUT_DIR: outDir,
    MANHWA_JOBS_DIR: path.join(outDir, 'jobs'),
    MANHWA_SERIES_ROOT: seriesRoot,
    MANHWA_NO_AUTO_WORKER: '1',
    MANHWA_RENDER_REMOTE: '',
    MANHWA_RENDER_CLOUD: '',
    PATH: process.env.PATH ?? '',
    ...extra,
  };
}

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/backend-fixes-');
  outDir = path.join(root, 'out');
  seriesRoot = path.join(root, 'series');
  fs.mkdirSync(path.join(seriesRoot, slug, 'ch1'), { recursive: true });
  write(path.join(seriesRoot, slug, 'ch1', '001.png'), 'PANEL');
  json(path.join(seriesRoot, slug, 'meta.json'), { title: 'Lane Fan', tts: { engine: 'edge' } });
  // Edge-only external catalog: no adapter preflights in these tests.
  json(path.join(outDir, 'config', 'tts-providers.json'), { providers: [] });
  vi.stubEnv('MANHWA_OUT_DIR', outDir);
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(outDir, 'jobs'));
  vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('lane-wide control is retired', () => {
  it('answers unsupported without mutating, signalling or writing lane state', async () => {
    const job = await createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never });
    const jobPath = path.join(outDir, 'jobs', `${job.id}.json`);
    const before = fs.readFileSync(jobPath, 'utf8');
    const killSpy = vi.spyOn(process, 'kill');

    for (const action of ['pause', 'resume', 'stop'] as const) {
      expect(controlRenderLane('local', action, env() as never, outDir)).toMatchObject({
        ok: false,
        supported: false,
        statusCode: 409,
        code: 'lane_control_unsupported',
        affectedJobs: [],
      });
    }

    expect(killSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(jobPath, 'utf8')).toBe(before);
    expect(getJob(String(job.id), { env: env() as never })).toMatchObject({ status: 'queued', paused: false });
    expect(fs.existsSync(path.join(outDir, 'config', 'lane-controls.json'))).toBe(false);
  });
});

describe('a saved pin is never demoted to inherit after its node disappears', () => {
  const node = { id: 'worker-eu', kind: 'ssh' as const, host: 'eu.example' };

  function writeNodes(nodes: unknown[]) {
    json(path.join(outDir, 'config', 'render-nodes.json'), { schemaVersion: 1, revision: 1, nodes });
  }

  it('keeps the pin, then fails the worker with an actionable error and no run', async () => {
    writeNodes([{ id: 'local', kind: 'local' }, node]);
    putStudioSettings({ defaultRenderLane: 'worker-eu' }, outDir);

    // Enqueue while the node is still registered: the pin is persisted.
    const job = await createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never });
    expect(job.renderLane).toBe('worker-eu');
    expect(renderLaneEnv(getJob(String(job.id), { env: env() as never }) as never)).toBe('worker-eu');

    // The node is removed after enqueue.
    writeNodes([{ id: 'local', kind: 'local' }]);

    // The saved pin survives on the public job view instead of becoming inherit.
    const view = getJob(String(job.id), { env: env() as never });
    expect(view.renderLane).toBe('worker-eu');

    // The worker refuses to start it and never invokes a run command.
    const marker = path.join(root, 'run-invoked.txt');
    await runWorkerOnce({
      env: env() as never,
      runCmdOverride: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        '--',
      ],
    });
    expect(fs.existsSync(marker)).toBe(false);

    const failed = getJob(String(job.id), { env: env() as never });
    expect(failed.status).toBe('failed');
    expect(String(failed.error)).toMatch(/Render lane 'worker-eu' can no longer be used/);
    expect(String(failed.error)).toMatch(/no longer configured on this host/);
    expect(failed.renderLane).toBe('worker-eu');
  });

  it('fails retry with the same actionable error instead of another machine', () => {
    writeNodes([{ id: 'local', kind: 'local' }, node]);
    putStudioSettings({ defaultRenderLane: 'worker-eu' }, outDir);
    return createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never }).then((job) => {
      writeNodes([{ id: 'local', kind: 'local' }]);
      // Make the job retryable without pretending a run happened.
      const file = path.join(outDir, 'jobs', `${job.id}.json`);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.status = 'failed';
      record.error = 'boom';
      json(file, record);

      expect(() => retryJob(String(job.id), { env: env() as never, spawnWorker: false }))
        .toThrowError(/Render lane 'worker-eu' can no longer be used.*no longer configured on this host/s);
      expect(getJob(String(job.id), { env: env() as never }).renderLane).toBe('worker-eu');
    });
  });

  it('still treats absent, legacy-empty and malformed saved lanes as inherit', () => {
    expect(renderLaneEnv({} as never)).toBe('inherit');
    expect(renderLaneEnv({ renderLane: '' } as never)).toBe('inherit');
    expect(renderLaneEnv({ renderLane: null } as never)).toBe('inherit');
    expect(renderLaneEnv({ renderLane: '../etc/passwd' } as never)).toBe('inherit');
    expect(renderLaneEnv({ renderLane: 'worker-eu' } as never)).toBe('worker-eu');
  });
});

describe('StudioSettings defaultRenderLane', () => {
  it('defaults to inherit and round-trips a built-in lane', () => {
    expect(getStudioSettings(outDir)).toMatchObject({ defaultRenderLane: 'inherit', renderQuality: '1080p' });
    const saved = putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    expect(saved).toMatchObject({ defaultRenderLane: 'local', renderQuality: '720p', revision: 1 });
    expect(getStudioSettings(outDir)).toMatchObject({ defaultRenderLane: 'local', renderQuality: '720p' });
    // An omitted field keeps the stored value; explicit inherit resets it.
    expect(putStudioSettings({ renderQuality: '720p' }, outDir).defaultRenderLane).toBe('local');
    expect(putStudioSettings({ defaultRenderLane: 'inherit' }, outDir).defaultRenderLane).toBe('inherit');
  });

  it('accepts a registered node id case-insensitively and rejects unknown or malformed ids', () => {
    json(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1,
      revision: 1,
      nodes: [
        { id: 'local', kind: 'local' },
        { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1' },
      ],
    });
    expect(putStudioSettings({ defaultRenderLane: 'SBX-ARM-1' }, outDir).defaultRenderLane).toBe('sbx-arm-1');
    for (const bad of ['not-registered', '../etc', 'local; rm -rf /', 42 as unknown as string]) {
      expect(() => putStudioSettings({ defaultRenderLane: bad }, outDir)).toThrowError(/defaultRenderLane/);
    }
  });

  it('preserves a stale but syntactically valid lane id instead of failing', () => {
    json(path.join(outDir, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 3, renderQuality: '1080p', defaultRenderLane: 'deleted-node',
    });
    // Kept so the UI can show the stored choice as unavailable.
    expect(getStudioSettings(outDir)).toMatchObject({
      revision: 3,
      renderQuality: '1080p',
      defaultRenderLane: 'deleted-node',
    });
    // Only malformed values fall back.
    json(path.join(outDir, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 4, renderQuality: '720p', defaultRenderLane: '../etc/passwd',
    });
    expect(getStudioSettings(outDir)).toMatchObject({
      revision: 4,
      renderQuality: '720p',
      defaultRenderLane: 'inherit',
    });
  });
});

describe('enqueue uses persisted defaults only when the request omits them', () => {
  it('applies the saved default lane to a new job', async () => {
    putStudioSettings({ defaultRenderLane: 'local' }, outDir);
    expect(resolveRequestedRenderLane(null, env() as never)).toBe('local');
    const job = await createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never });
    expect(job.renderLane).toBe('local');
  });

  it('keeps an explicit inherit and an explicit valid lane over the default', async () => {
    putStudioSettings({ defaultRenderLane: 'local' }, outDir);
    expect(resolveRequestedRenderLane('inherit', env() as never)).toBe('inherit');
    expect(resolveRequestedRenderLane('local', env() as never)).toBe('local');
    const job = await createJob({
      slug, chapters: '1', spawnWorker: false, renderLane: 'inherit', env: env() as never,
    });
    expect(job.renderLane).toBe('inherit');
  });

  it('fails an omitted enqueue when the saved lane is unavailable, and preserves the pin on read', async () => {
    // `cloud` is a valid stored id but this host has no cloud transport configured.
    json(path.join(outDir, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 1, renderQuality: '1080p', defaultRenderLane: 'cloud',
    });
    expect(getStudioSettings(outDir)).toMatchObject({
      defaultRenderLane: 'cloud',
      renderQuality: '1080p',
    });
    // No silent fallback to another machine: the request fails with guidance.
    expect(() => resolveRequestedRenderLane(undefined, env() as never))
      .toThrowError(/Studio default render lane 'cloud' is not available.*Choose another lane/s);
    await expect(createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never }))
      .rejects.toThrowError(/Studio default render lane 'cloud' is not available/);
    // Explicit inherit is always allowed and does not consult the stored pin.
    expect(resolveRequestedRenderLane('inherit', env() as never)).toBe('inherit');
    const job = await createJob({
      slug, chapters: '1', spawnWorker: false, renderLane: 'inherit', env: env() as never,
    });
    expect(job.renderLane).toBe('inherit');
  });

  it('preserves a removed or disabled saved lane across unrelated settings updates', () => {
    json(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1,
      revision: 1,
      nodes: [
        { id: 'local', kind: 'local' },
        { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1' },
      ],
    });
    putStudioSettings({ defaultRenderLane: 'sbx-arm-1', renderQuality: '720p' }, outDir);

    // Node disappears (deleted or disabled): the stored pin must survive.
    json(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1, revision: 2, nodes: [{ id: 'local', kind: 'local' }],
    });
    expect(getStudioSettings(outDir)).toMatchObject({
      defaultRenderLane: 'sbx-arm-1',
      renderQuality: '720p',
    });

    // An unrelated update keeps the pin and the quality intact.
    const updated = putStudioSettings({ defaultOutro: { enabled: true, hookType: 'part2', customNote: '' } }, outDir);
    expect(updated).toMatchObject({ defaultRenderLane: 'sbx-arm-1', renderQuality: '720p' });
    expect(getStudioSettings(outDir)).toMatchObject({
      defaultRenderLane: 'sbx-arm-1',
      renderQuality: '720p',
      defaultOutro: { enabled: true },
    });

    // A disabled (not deleted) node is also preserved, not rewritten.
    json(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1, revision: 3,
      nodes: [{ id: 'local', kind: 'local' }, { id: 'sbx-arm-1', kind: 'docker-sbx', box: 'sbx-arm-1', enabled: false }],
    });
    expect(getStudioSettings(outDir).defaultRenderLane).toBe('sbx-arm-1');

    // Writes still reject an unknown lane, and only explicit inherit resets.
    expect(() => putStudioSettings({ defaultRenderLane: 'ghost-node' }, outDir)).toThrowError(/defaultRenderLane/);
    expect(putStudioSettings({ defaultRenderLane: 'inherit' }, outDir).defaultRenderLane).toBe('inherit');
    expect(getStudioSettings(outDir)).toMatchObject({ defaultRenderLane: 'inherit', renderQuality: '720p' });
  });

  it('leaves renderQuality unset when omitted so the run resolves the saved default', async () => {
    putStudioSettings({ renderQuality: '720p' }, outDir);
    const job = await createJob({ slug, chapters: '1', spawnWorker: false, env: env() as never });
    const persisted = JSON.parse(fs.readFileSync(path.join(outDir, 'jobs', `${job.id}.json`), 'utf8'));
    expect(persisted.renderQuality ?? null).toBeNull();
    expect(job.renderQuality).toBe('720p');
  });

  it('keeps an explicit renderQuality over the saved default on a distinct series', async () => {
    putStudioSettings({ renderQuality: '720p' }, outDir);
    const other = 'explicit-fan';
    fs.mkdirSync(path.join(seriesRoot, other, 'ch1'), { recursive: true });
    write(path.join(seriesRoot, other, 'ch1', '001.png'), 'PANEL');
    json(path.join(seriesRoot, other, 'meta.json'), { title: 'Explicit Fan', tts: { engine: 'edge' } });
    const explicit = await createJob({
      slug: other, chapters: '1', spawnWorker: false, renderQuality: '1080p', env: env() as never,
    });
    expect(explicit.renderQuality).toBe('1080p');
    const persisted = JSON.parse(fs.readFileSync(path.join(outDir, 'jobs', `${explicit.id}.json`), 'utf8'));
    expect(persisted.renderQuality).toBe('1080p');
  });

  it('reaches the persisted defaults through a fresh ZIP enqueue', async () => {
    putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    const AdmZip = (await import('adm-zip')).default;
    const archive = new AdmZip();
    archive.addFile('ch1/001.png', Buffer.from('PAGE'));
    const zipPath = path.join(root, 'fresh.zip');
    archive.writeZip(zipPath);
    const view = await enqueueJob({
      slug: 'fresh-fan', zipPath, spawnWorker: false, env: env() as never,
    });
    expect(view.renderLane).toBe('local');
    expect(view.renderQuality).toBe('720p');
  });
});

describe('Vertex catalog metadata', () => {
  it('exposes modelId/modelLabel per voice and keeps Gemini visible', () => {
    const voices = listVertexTtsVoices({ MANHWA_OUT_DIR: outDir } as NodeJS.ProcessEnv);
    const chirp = voices.find((v) => v.id === 'en-US-Chirp3-HD-Charon')!;
    expect(chirp).toMatchObject({ modelId: 'chirp-3-hd', modelLabel: 'Chirp 3 HD' });
    const gemini = voices.find((v) => v.id === 'gemini-tts:Charon')!;
    expect(gemini).toMatchObject({ modelId: GEMINI_TTS_MODEL, modelLabel: 'Gemini 3.8 Flash TTS' });
    expect(VERTEX_TTS_VOICES.every((v) => v.modelId && v.modelLabel)).toBe(true);
    // Exactly one default voice.
    expect(voices.filter((v) => v.default)).toHaveLength(1);
  });

  it('keeps Chirp and Gemini when the discovered cache only holds Studio/Neural2', () => {
    json(path.join(outDir, 'config', 'vertex-tts-voices.json'), {
      updatedAt: Date.now(),
      projectId: 'p',
      voices: [
        { id: 'en-US-Studio-O', voiceName: 'en-US-Studio-O', label: 'Studio-O · Studio', engine: 'chirp' },
        { id: 'en-US-Neural2-D', voiceName: 'en-US-Neural2-D', label: 'Neural2-D · Neural2', engine: 'chirp' },
      ],
    });
    const voices = listVertexTtsVoices({ MANHWA_OUT_DIR: outDir } as NodeJS.ProcessEnv);
    const ids = voices.map((v) => v.id);
    expect(ids).toContain('en-US-Studio-O');
    expect(ids).toContain('en-US-Neural2-D');
    expect(ids).toContain('en-US-Chirp3-HD-Charon');
    expect(ids).toContain('gemini-tts:Charon');
    expect(voices.find((v) => v.id === 'en-US-Studio-O')).toMatchObject({ modelId: 'studio', modelLabel: 'Studio' });
    expect(voices.find((v) => v.id === 'en-US-Neural2-D')).toMatchObject({ modelId: 'neural2', modelLabel: 'Neural2' });
  });

  it('keeps provider labels short and the paid notice explicit', () => {
    const providers = loadRawTtsProviders(env() as never);
    const edge = providers.find((p) => p.id === 'edge')!;
    expect(edge.label).toBe('Edge');
    expect(edge.costNotice).toMatch(/free/i);
    // Vertex only appears with Studio credentials, so check the built-in entry.
    return import('../src/intake/intake.js').then((mod) => {
      expect(mod.BUILTIN_VERTEX_PROVIDER.label).toBe('Vertex');
      expect(mod.BUILTIN_VERTEX_PROVIDER.costNotice).toMatch(/paid/i);
      expect(mod.BUILTIN_GROK_PROVIDER.label).toBe('Grok');
      expect(mod.BUILTIN_GROK_PROVIDER.costNotice).toMatch(/paid/i);
    });
  });
});

describe('getCatalog contract', () => {
  it('publishes the persisted defaults', async () => {
    putStudioSettings({ renderQuality: '720p', defaultRenderLane: 'local' }, outDir);
    const catalog = await getCatalog(undefined, env() as never);
    expect(catalog.defaultRenderQuality).toBe('720p');
    expect(catalog.defaultRenderLane).toBe('local');
    const vertex = catalog.providers.find((p) => p.id === 'vertex');
    expect(vertex).toBeUndefined(); // no Studio Vertex credential configured here
  });

  it('lists a configured Vertex provider with Chirp and Gemini metadata (offline)', async () => {
    const { upsertProvider } = await import('../src/config/studioConfig.js');
    const { putSecret } = await import('../src/config/secretStore.js');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-token' }), outDir);
    // Seed the discovery cache so the catalog never reaches the network, and make
    // any accidental fetch fail the test instead of writing after cleanup.
    json(path.join(outDir, 'config', 'vertex-tts-voices.json'), {
      updatedAt: Date.now(),
      projectId: 'studio-project',
      voices: [
        { id: 'en-US-Studio-O', voiceName: 'en-US-Studio-O', label: 'Studio-O · Studio', engine: 'chirp' },
      ],
    });
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchSpy);

    const catalog = await getCatalog(undefined, env() as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    const vertex = catalog.providers.find((p) => p.id === 'vertex') as Record<string, any>;
    expect(vertex).toMatchObject({ label: 'Vertex', engine: 'vertex', available: true });
    const voices = vertex.voices as Array<Record<string, unknown>>;
    expect(voices.find((v) => v.id === 'en-US-Chirp3-HD-Charon')).toMatchObject({
      modelId: 'chirp-3-hd', modelLabel: 'Chirp 3 HD',
    });
    expect(voices.find((v) => v.id === 'gemini-tts:Charon')).toMatchObject({
      modelId: GEMINI_TTS_MODEL, modelLabel: 'Gemini 3.8 Flash TTS',
    });

    // The selection keeps the canonical voice id the synthesizer expects.
    const { resolveTtsSelection } = await import('../src/intake/intake.js');
    const sel = await resolveTtsSelection('vertex', 'gemini-tts:Puck', undefined, env() as never, true);
    expect(sel).toMatchObject({ providerId: 'vertex', engine: 'vertex', voiceId: 'gemini-tts:Puck' });
  });
});

describe('intake HTTP enqueue reaches persisted defaults', () => {
  async function post(body: Record<string, unknown>) {
    const { handleIntakeRoute } = await import('../src/player/jobs.js');
    const { Readable } = await import('node:stream');
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
    req.method = 'POST';
    req.headers = { host: 'player.local', origin: 'http://player.local', 'x-csrf-token': 'csrf-1' };
    let result!: { status: number; body: any };
    await handleIntakeRoute(
      req,
      {} as never,
      '/api/intake/jobs',
      new URL('/api/intake/jobs', 'http://player.local'),
      { user: 'admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'csrf-1' } as never,
      (_res, status, payload) => { result = { status, body: payload }; },
    );
    return result;
  }

  /** POST a real ZIP body through the upload branch, with query params. */
  async function postZip(
    zipPath: string,
    query: Record<string, string>,
  ) {
    const { handleIntakeRoute } = await import('../src/player/jobs.js');
    const { Readable } = await import('node:stream');
    const payload = fs.readFileSync(zipPath);
    const req = Readable.from([payload]) as any;
    req.method = 'POST';
    req.headers = {
      host: 'player.local',
      origin: 'http://player.local',
      'x-csrf-token': 'csrf-1',
      'content-type': 'application/zip',
      'content-length': String(payload.length),
    };
    const search = new URLSearchParams(query).toString();
    const url = `/api/intake/jobs?${search}`;
    let result!: { status: number; body: any };
    await handleIntakeRoute(
      req,
      {} as never,
      '/api/intake/jobs',
      new URL(url, 'http://player.local'),
      { user: 'admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'csrf-1' } as never,
      (_res, status, response) => { result = { status, body: response }; },
    );
    return result;
  }

  it('uses the saved lane and quality when the JSON request omits both', async () => {
    putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    const res = await post({
      sourceType: 'gdrive',
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      title: 'Http Fan',
      slug: 'http-fan',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ renderLane: 'local', renderQuality: '720p' });
  });

  it('keeps an explicit valid quality and an explicit inherit lane', async () => {
    putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    const res = await post({
      sourceType: 'gdrive',
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      title: 'Http Fan Two',
      slug: 'http-fan-two',
      renderLane: 'inherit',
      renderQuality: '1080p',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ renderLane: 'inherit', renderQuality: '1080p' });
  });

  it('uses the saved lane and quality when a ZIP upload omits both query params', async () => {
    putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    const AdmZip = (await import('adm-zip')).default;
    const archive = new AdmZip();
    archive.addFile('ch1/001.png', Buffer.from('PAGE'));
    const zipPath = path.join(root, 'upload-defaults.zip');
    archive.writeZip(zipPath);

    const res = await postZip(zipPath, { title: 'Zip Defaults', slug: 'zip-defaults', filename: 'defaults.zip' });
    expect(res.status).toBe(201);
    // Proves the upload branch ran, not the JSON fallback.
    expect(res.body.sourceType).toBe('upload');
    expect(String(res.body.sourceSummary)).toMatch(/Uploaded ZIP \(defaults\.zip\)/);
    expect(res.body).toMatchObject({ renderLane: 'local', renderQuality: '720p' });
  });

  it('honours explicit ZIP query lane and quality over the saved defaults', async () => {
    putStudioSettings({ defaultRenderLane: 'local', renderQuality: '720p' }, outDir);
    const AdmZip = (await import('adm-zip')).default;
    const archive = new AdmZip();
    archive.addFile('ch1/001.png', Buffer.from('PAGE'));
    const zipPath = path.join(root, 'upload-explicit.zip');
    archive.writeZip(zipPath);

    const res = await postZip(zipPath, {
      title: 'Zip Explicit', slug: 'zip-explicit', filename: 'explicit.zip',
      renderLane: 'inherit', renderQuality: '1080p',
    });
    expect(res.status).toBe(201);
    expect(res.body.sourceType).toBe('upload');
    expect(res.body).toMatchObject({ renderLane: 'inherit', renderQuality: '1080p' });
  });

  it('still rejects an unknown lane or quality', async () => {
    const badLane = await post({
      sourceType: 'gdrive',
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      title: 'Http Fan Three', slug: 'http-fan-three', renderLane: 'nope',
    });
    expect(badLane.status).toBe(400);
    expect(String(badLane.body.error)).toMatch(/renderLane/);
    const badQuality = await post({
      sourceType: 'gdrive',
      gdriveUrl: 'https://drive.google.com/file/d/FILEIDabcdef12/view',
      title: 'Http Fan Four', slug: 'http-fan-four', renderQuality: '4k',
    });
    expect(badQuality.status).toBe(400);
    expect(String(badQuality.body.error)).toMatch(/renderQuality/);
  });
});

describe('external TTS catalog shares the Studio directory', () => {
  const ADAPTER = {
    id: 'acme',
    engine: 'external',
    label: 'Acme',
    command: ['/bin/true'],
    // No preflight command: keeps these tests offline and free of child pipes.
    preflightArgs: [] as string[],
    voices: [{ id: 'v1', label: 'V1', default: true }],
  };

  /** An env object with no explicit out dir, so the ambient chain decides. */
  function ambientEnv(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: process.env.PATH ?? '', ...extra };
  }

  it('uses MANHWA_LANE_CONFIG_DIR for both settings and TTS adapters', async () => {
    const cfgDir = path.join(root, 'lane-config');
    json(path.join(cfgDir, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 1, renderQuality: '720p', defaultRenderLane: 'inherit',
    });
    json(path.join(cfgDir, 'config', 'tts-providers.json'), { providers: [ADAPTER] });
    vi.stubEnv('MANHWA_LANE_CONFIG_DIR', cfgDir);
    vi.stubEnv('MANHWA_OUT_DIR', '');
    vi.stubEnv('MANHWA_JOBS_DIR', '');
    vi.stubEnv('MANHWA_TTS_CATALOG', '');

    expect(getStudioSettings()).toMatchObject({ renderQuality: '720p' });
    const catalog = await getCatalog(undefined, ambientEnv());
    expect(catalog.defaultRenderQuality).toBe('720p');
    const providers = loadRawTtsProviders(ambientEnv());
    expect(providers.map((p) => p.id)).toEqual(expect.arrayContaining(['edge', 'acme']));
  });

  it('uses MANHWA_LANE_CONFIG for both settings and TTS adapters', async () => {
    const cfgDir = path.join(root, 'lane-file-config');
    json(path.join(cfgDir, 'lanes.json'), { schemaVersion: 1 });
    json(path.join(cfgDir, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 1, renderQuality: '720p', defaultRenderLane: 'inherit',
    });
    json(path.join(cfgDir, 'config', 'tts-providers.json'), { providers: [ADAPTER] });
    vi.stubEnv('MANHWA_LANE_CONFIG', path.join(cfgDir, 'lanes.json'));
    vi.stubEnv('MANHWA_OUT_DIR', '');
    vi.stubEnv('MANHWA_JOBS_DIR', '');
    vi.stubEnv('MANHWA_TTS_CATALOG', '');

    expect(getStudioSettings().renderQuality).toBe('720p');
    expect(loadRawTtsProviders(ambientEnv()).map((p) => p.id)).toContain('acme');
  });

  it('uses MANHWA_JOBS_DIR for both settings and TTS adapters', async () => {
    const jobsRoot = path.join(root, 'ambient');
    json(path.join(jobsRoot, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 1, renderQuality: '720p', defaultRenderLane: 'inherit',
    });
    json(path.join(jobsRoot, 'config', 'tts-providers.json'), { providers: [ADAPTER] });
    vi.stubEnv('MANHWA_JOBS_DIR', path.join(jobsRoot, 'jobs'));
    vi.stubEnv('MANHWA_OUT_DIR', '');
    vi.stubEnv('MANHWA_LANE_CONFIG_DIR', '');
    vi.stubEnv('MANHWA_LANE_CONFIG', '');
    vi.stubEnv('MANHWA_TTS_CATALOG', '');

    expect(getStudioSettings().renderQuality).toBe('720p');
    expect(loadRawTtsProviders(ambientEnv()).map((p) => p.id)).toContain('acme');
  });

  it('honours PIPELINE_OUT_DIR for both, and an explicit catalog still wins', async () => {
    const outRoot = path.join(root, 'pipeline-out');
    json(path.join(outRoot, 'config', 'settings.json'), {
      schemaVersion: 1, revision: 1, renderQuality: '1080p', defaultRenderLane: 'inherit',
    });
    json(path.join(outRoot, 'config', 'tts-providers.json'), { providers: [ADAPTER] });
    vi.stubEnv('PIPELINE_OUT_DIR', outRoot);
    vi.stubEnv('MANHWA_OUT_DIR', '');
    vi.stubEnv('MANHWA_JOBS_DIR', '');
    vi.stubEnv('MANHWA_LANE_CONFIG_DIR', '');
    vi.stubEnv('MANHWA_LANE_CONFIG', '');

    expect(getStudioSettings().renderQuality).toBe('1080p');
    expect(loadRawTtsProviders(ambientEnv()).map((p) => p.id)).toContain('acme');

    // An explicit MANHWA_TTS_CATALOG keeps priority over the shared directory.
    const explicitPath = path.join(root, 'explicit-catalog.json');
    json(explicitPath, {
      providers: [{ ...ADAPTER, id: 'explicit-provider' }],
    });
    const explicit = loadRawTtsProviders(ambientEnv({ MANHWA_TTS_CATALOG: explicitPath }));
    expect(explicit.map((p) => p.id)).toContain('explicit-provider');
    expect(explicit.map((p) => p.id)).not.toContain('acme');
  });
});

describe('sbx login output parsing', () => {
  it('strips ANSI escapes and trailing punctuation from the sign-in URL', () => {
    const text = [
      '\u001b[1mYour one-time device confirmation code is: MCRN-XWZP\u001b[0m',
      '\u001b[32mOpen this URL to sign in: https://login.docker.com/activate?user_code=MCRN-XWZP\u001b[0m.',
      'Waiting for authentication...',
    ].join('\n');
    expect(parseSbxLoginOutput(text)).toEqual({
      verificationUrl: 'https://login.docker.com/activate?user_code=MCRN-XWZP',
      userCode: 'MCRN-XWZP',
    });
  });

  it('handles a closing parenthesis or quote after the URL', () => {
    const text = 'Open this URL to sign in: https://login.docker.com/activate?user_code=ABCD-EFGH)';
    expect(parseSbxLoginOutput(text).verificationUrl).toBe(
      'https://login.docker.com/activate?user_code=ABCD-EFGH',
    );
  });

  it('preserves a balanced bracket that is part of the URL', () => {
    // Percent-encoded brackets stay as-is; a balanced literal pair is kept too.
    const encoded = 'Open this URL to sign in: https://login.docker.com/activate?user_code=ABCD&state=%5Bx%5D';
    expect(parseSbxLoginOutput(encoded).verificationUrl).toBe(
      'https://login.docker.com/activate?user_code=ABCD&state=%5Bx%5D',
    );
    const balanced = 'Open this URL to sign in: https://login.docker.com/activate?user_code=ABCD[1]';
    expect(parseSbxLoginOutput(balanced).verificationUrl).toBe(
      'https://login.docker.com/activate?user_code=ABCD[1]',
    );
  });

  it('drops an unbalanced trailing bracket', () => {
    const text = 'Open this URL to sign in: https://login.docker.com/activate?user_code=ABCD[';
    expect(parseSbxLoginOutput(text).verificationUrl).toBe(
      'https://login.docker.com/activate?user_code=ABCD',
    );
  });

  it('ignores legal and documentation URLs and never returns the bare command', () => {
    const text = [
      'By logging in you agree to https://www.docker.com/legal/docker-subscription-service-agreement/',
      'Run `sbx login` to authenticate. Docs: https://docs.sbx.dev/getting-started',
    ].join('\n');
    expect(parseSbxLoginOutput(text)).toEqual({ verificationUrl: null, userCode: null });
  });

  it('returns null rather than a homepage when no sign-in link is printed', () => {
    expect(parseSbxLoginOutput('sbx login\nWaiting for authentication...\n')).toEqual({
      verificationUrl: null,
      userCode: null,
    });
    expect(parseSbxLoginOutput('').verificationUrl).toBeNull();
  });

  it('prefers the Docker device link over an unrelated URL in the same output', () => {
    const text = [
      'See https://example.com/status for service status.',
      'Complete sign-in in your browser: https://login.docker.com/activate?user_code=ZZZZ-YYYY',
    ].join('\n');
    expect(parseSbxLoginOutput(text)).toMatchObject({
      verificationUrl: 'https://login.docker.com/activate?user_code=ZZZZ-YYYY',
      userCode: 'ZZZZ-YYYY',
    });
  });

  it('extracts a device code from a query string', () => {
    const text = 'Visit https://sbx.dev/device?code=WXYZ-1234 to continue';
    expect(parseSbxLoginOutput(text)).toMatchObject({ userCode: 'WXYZ-1234' });
  });
});
