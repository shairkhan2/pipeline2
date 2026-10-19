import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, executeSingleJob, resolveTtsSelection } from '../src/intake/intake.js';
import { generatePreview } from '../src/intake/voicePreview.js';
import { extendSeries, resolveOutroTts } from '../src/player/seriesTools.js';
import { handleStudioRoute } from '../src/player/studio.js';
import { getSecret, putSecret } from '../src/config/secretStore.js';
import { upsertProvider } from '../src/config/studioConfig.js';
import {
  VERTEX_TTS_VOICES,
  hasVertexTtsCredentials,
  synthesizeVertexTtsToFile,
} from '../src/llm/vertexTts.js';

let root: string;
let seriesRoot: string;
let dir: string;
const slug = 'review-series';

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  root = fs.mkdtempSync('/tmp/opencode/studio-review-');
  seriesRoot = path.join(root, 'series');
  dir = path.join(seriesRoot, slug);
  fs.mkdirSync(path.join(dir, 'ch1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ch1', '001.png'), 'PAGE');
  writeJson(path.join(dir, 'meta.json'), {
    title: 'Review Series', tts: { engine: 'edge' },
    visuals: { background: 'starfield', motion: 'cut', custom: 'keep' }, extra: 'keep',
  });
  vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
  vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
  vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
  vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
  vi.stubEnv('MANHWA_RENDER_REMOTE', '');
  vi.stubEnv('MANHWA_RENDER_CLOUD', '');
  vi.stubEnv('GITHUB_COPILOT_CLIENT_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('review fixes: existing-series execution', () => {
  it.each([undefined, '1080p'] as const)('applies visuals and resolves render quality %s before spawning', async (renderQuality) => {
    const view = await createJob({ slug, chapters: '1', background: 'mist-pines', motion: 'duo', spawnWorker: false });
    const job = JSON.parse(fs.readFileSync(path.join(root, 'out', 'jobs', `${view.id}.json`), 'utf8'));
    job.renderQuality = renderQuality;
    const capture = path.join(root, 'captured.json');
    await executeSingleJob(job, {
      repoRoot: root,
      env: { ...process.env, MANHWA_RENDER_QUALITY: '720p' },
      runCmdOverride: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ meta: JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(dir, 'meta.json'))}, 'utf8')), quality: process.env.MANHWA_RENDER_QUALITY }));`, '--'],
    });
    expect(job.status, job.error).toBe('completed');
    const actual = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(actual).toMatchObject({
      quality: renderQuality || '720p',
      meta: { title: 'Review Series', extra: 'keep', tts: { engine: 'edge' }, visuals: { background: 'mist-pines', motion: 'duo', custom: 'keep' } },
    });
  });

  it('does not inject a quality override when the job and environment have none', async () => {
    const view = await createJob({ slug, chapters: '1', spawnWorker: false });
    const job = JSON.parse(fs.readFileSync(path.join(root, 'out', 'jobs', `${view.id}.json`), 'utf8'));
    delete job.renderQuality;
    const env = { ...process.env };
    delete env.MANHWA_RENDER_QUALITY;
    const capture = path.join(root, 'quality.json');
    await executeSingleJob(job, {
      repoRoot: root, env,
      runCmdOverride: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ quality: process.env.MANHWA_RENDER_QUALITY ?? null }));`, '--'],
    });
    expect(job.status, job.error).toBe('completed');
    expect(JSON.parse(fs.readFileSync(capture, 'utf8'))).toEqual({ quality: null });
  });

  it('rejects disabling completed-chapter preservation before importing anything', async () => {
    await expect(extendSeries({ seriesRoot, slug, preserveCompleted: false, spawnWorker: false })).rejects.toThrow('preserveCompleted must be true');
    expect(fs.existsSync(path.join(root, 'out', 'jobs'))).toBe(false);
  });
});

describe('review fixes: outro provider routing', () => {
  it('uses the requested provider adapter, settings and default voice instead of persisted TTS', async () => {
    const catalog = path.join(root, 'tts.json');
    writeJson(catalog, { providers: [{
      id: 'new-provider', engine: 'external', provider: 'upstream-new',
      command: [process.execPath, '/new-adapter.cjs'], revision: '2',
      settings: { model: 'new-model' }, voices: [{ id: 'new-voice', default: true }],
    }] });
    vi.stubEnv('MANHWA_TTS_CATALOG', catalog);
    const tts = await resolveOutroTts({ engine: 'external', command: ['/old-adapter'], voice_id: 'old-voice' }, { provider: 'new-provider' });
    expect(tts).toMatchObject({ engine: 'external', provider: 'upstream-new', command: [process.execPath, '/new-adapter.cjs'], voice_id: 'new-voice', revision: '2', settings: { model: 'new-model' } });
  });

  it('switches an external series to Edge and preserves stored adapters for voice-only overrides', async () => {
    const stored = { engine: 'external', command: ['/stored-adapter'], voice_id: 'stored-voice', provider: 'stored' };
    expect(await resolveOutroTts(stored, { provider: 'edge' })).toEqual({ engine: 'edge', voice_id: 'en-US-AndrewMultilingualNeural' });
    expect(await resolveOutroTts(stored, { voice: 'other-voice' })).toEqual({ ...stored, voice_id: 'other-voice' });
    expect(await resolveOutroTts(stored)).toEqual(stored);
    await expect(resolveOutroTts(stored, { provider: 'missing-provider' })).rejects.toThrow('Unknown TTS provider');
  });
});

async function deviceRequest(action: 'device-start' | 'device-poll', body: Record<string, unknown> = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = 'POST';
  req.headers = { host: 'studio.local', origin: 'http://studio.local', 'x-csrf-token': 'review-csrf' };
  const pathname = `/api/studio/oauth/${action}`;
  let result!: { status: number; body: any };
  await handleStudioRoute(req, {} as ServerResponse, pathname, new URL(pathname, 'http://studio.local'), {
    user: 'review-admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'review-csrf',
  }, (_res, status, response) => { result = { status, body: response }; });
  return result;
}

async function studioPost(pathname: string, body: Record<string, unknown> = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = 'POST';
  req.headers = { host: 'studio.local', origin: 'http://studio.local', 'x-csrf-token': 'review-csrf' };
  let result!: { status: number; body: any };
  await handleStudioRoute(req, {} as ServerResponse, pathname, new URL(pathname, 'http://studio.local'), {
    user: 'review-admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'review-csrf',
  }, (_res, status, response) => { result = { status, body: response }; });
  return result;
}

describe('review fixes: real device authorization', () => {
  it('rejects unconfigured flows without making up a user code', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await deviceRequest('device-start');
    expect(response.status).toBe(400);
    expect(response.body.userCode).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
    expect((await deviceRequest('device-poll')).status).toBe(400);
  });

  it('reports upstream start failures instead of fabricating a working login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const response = await deviceRequest('device-start', { clientId: 'test-client' });
    expect(response.status).toBe(502);
    expect(response.body.userCode).toBeUndefined();
  });

  it('polls real codes and stops reporting pending after a terminal provider error', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'real-device', user_code: 'REAL-CODE', verification_uri: 'https://github.com/login/device' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'access_denied' })));
    vi.stubGlobal('fetch', upstream);
    const start = await deviceRequest('device-start', { clientId: 'test-client' });
    expect(start).toMatchObject({ status: 200, body: { upstream: true, userCode: 'REAL-CODE' } });
    expect(await deviceRequest('device-poll')).toMatchObject({ status: 200, body: { status: 'pending' } });
    expect(await deviceRequest('device-poll')).toMatchObject({ status: 400, body: { status: 'failed', error: 'access_denied' } });
    expect((await deviceRequest('device-poll')).status).toBe(400);
  });

  it('keeps manually pasted access tokens usable without starting a device flow', async () => {
    const response = await deviceRequest('device-poll', { accessToken: 'manual-device-token' });
    expect(response).toMatchObject({ status: 200, body: { status: 'authorized' } });
    expect(getSecret('provider:github-copilot', path.join(root, 'out'))).toBe('manual-device-token');
  });
});

describe('review fixes: claude-oauth subscription login', () => {
  it('builds a Claude PKCE start URL with the console client, code=true and callback redirect', async () => {
    const response = await studioPost('/api/studio/oauth/pkce-start', { providerId: 'claude-oauth' });
    expect(response.status).toBe(200);
    expect(response.body.redirectUri).toBe('https://console.anthropic.com/oauth/code/callback');
    const url = new URL(response.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.anthropic.com/oauth/code/callback');
    expect(url.searchParams.get('scope')).toBe('org:create_api_key user:profile user:inference');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges a `code#state` paste as JSON against the Anthropic token endpoint', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'sk-ant-oat01-access', refresh_token: 'sk-ant-ort01-refresh', expires_in: 3600,
    })));
    vi.stubGlobal('fetch', upstream);
    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'claude-oauth',
      codeOrUrl: 'abc123#xyz789',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.provider.id).toBe('claude-oauth');
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'abc123',
      state: 'xyz789',
      redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
      code_verifier: 'v'.repeat(43),
    });
    expect(JSON.parse(getSecret('provider:claude-oauth', path.join(root, 'out'))!))
      .toMatchObject({ access_token: 'sk-ant-oat01-access' });
  });

  it('stores a pasted `claude setup-token` token without calling the token endpoint', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'claude-oauth',
      codeOrUrl: 'sk-ant-oat01-setup-token-value',
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.provider.id).toBe('claude-oauth');
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.parse(getSecret('provider:claude-oauth', path.join(root, 'out'))!))
      .toMatchObject({ access_token: 'sk-ant-oat01-setup-token-value' });
  });
});

describe('review fixes: provider create PKCE bundle keeps id_token and client fields', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const idToken = [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({ email: 'bundle@example.com', sub: 'bundle-sub' }),
    'sig',
  ].join('.');

  it('stores id_token, client_id and token_url for an OpenAI PKCE create', async () => {
    const outDir = path.join(root, 'out');
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      access_token: 'create-access', refresh_token: 'create-refresh', id_token: idToken,
      expires_in: 3600, token_type: 'Bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/providers', {
      id: 'codex-oauth',
      preset: 'codex-oauth',
      codeOrUrl: 'create-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(JSON.parse(getSecret('provider:codex-oauth', outDir)!)).toMatchObject({
      access_token: 'create-access',
      refresh_token: 'create-refresh',
      id_token: idToken,
      token_url: 'https://auth.openai.com/oauth/token',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
  });

  it('stores the shipped client_secret for a Vertex PKCE create', async () => {
    const outDir = path.join(root, 'out');
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('cloudresourcemanager.googleapis.com')) {
        return new Response(JSON.stringify({
          projects: [{ projectId: 'create-project', name: 'Create Project' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'vertex-create-access', refresh_token: 'vertex-create-refresh',
        id_token: idToken, expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/providers', {
      id: 'vertex-ai',
      preset: 'vertex-ai',
      codeOrUrl: 'vertex-create-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(stored).toMatchObject({
      access_token: 'vertex-create-access',
      refresh_token: 'vertex-create-refresh',
      id_token: idToken,
      token_url: 'https://oauth2.googleapis.com/token',
      client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
      client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty',
    });
  });
});

describe('review fixes: OpenAI device-code subscription login', () => {
  it('starts OpenAI deviceauth, polls approval and exchanges the authorization code', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'dev-auth-1', user_code: 'OPEN-CODE', interval: 5,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'auth-code-1', code_verifier: 'verifier-1',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'openai-access', refresh_token: 'openai-refresh', expires_in: 3600,
      })));
    vi.stubGlobal('fetch', upstream);

    const start = await deviceRequest('device-start', { providerId: 'codex-oauth' });
    expect(start).toMatchObject({
      status: 200,
      body: {
        ok: true,
        providerId: 'codex-oauth',
        deviceCode: 'dev-auth-1',
        userCode: 'OPEN-CODE',
        verificationUri: 'https://auth.openai.com/codex/device',
        interval: 5,
        expiresIn: 900,
        upstream: true,
      },
    });
    const [startUrl, startInit] = upstream.mock.calls[0];
    expect(String(startUrl)).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(startInit.headers['User-Agent']).toBe('opencode/production/2.0.26/opencode');
    expect(JSON.parse(startInit.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

    const poll = await deviceRequest('device-poll', { providerId: 'codex-oauth' });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ ok: true, status: 'authorized' });
    expect(poll.body.provider.id).toBe('codex-oauth');

    const [pollUrl, pollInit] = upstream.mock.calls[1];
    expect(String(pollUrl)).toBe('https://auth.openai.com/api/accounts/deviceauth/token');
    expect(JSON.parse(pollInit.body)).toEqual({ device_auth_id: 'dev-auth-1', user_code: 'OPEN-CODE' });

    const [exchangeUrl, exchangeInit] = upstream.mock.calls[2];
    expect(String(exchangeUrl)).toBe('https://auth.openai.com/oauth/token');
    const form = new URLSearchParams(String(exchangeInit.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('code_verifier')).toBe('verifier-1');
    expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(form.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

    expect(JSON.parse(getSecret('provider:codex-oauth', path.join(root, 'out'))!)).toMatchObject({
      access_token: 'openai-access',
      refresh_token: 'openai-refresh',
      token_url: 'https://auth.openai.com/oauth/token',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
  });

  it('persists id_token from the OpenAI token response in the stored secret', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'dev-auth-idt', user_code: 'OPEN-IDT', interval: 5,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'auth-code-idt', code_verifier: 'verifier-idt',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'openai-access-idt',
        refresh_token: 'openai-refresh-idt',
        id_token: 'openai-id-token-value',
        expires_in: 3600,
      })));
    vi.stubGlobal('fetch', upstream);

    expect((await deviceRequest('device-start', { providerId: 'codex-oauth' })).status).toBe(200);
    const poll = await deviceRequest('device-poll', { providerId: 'codex-oauth' });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('authorized');
    expect(JSON.parse(getSecret('provider:codex-oauth', path.join(root, 'out'))!)).toMatchObject({
      access_token: 'openai-access-idt',
      refresh_token: 'openai-refresh-idt',
      id_token: 'openai-id-token-value',
    });
  });

  it('reports OpenAI device authorization as pending on 403 and on authorization_pending', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'dev-auth-2', user_code: 'OPEN-TWO', interval: 5,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'deviceauth_authorization_pending' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' })));
    vi.stubGlobal('fetch', upstream);

    expect((await deviceRequest('device-start', { providerId: 'codex-oauth' })).status).toBe(200);
    expect(await deviceRequest('device-poll', { providerId: 'codex-oauth' })).toMatchObject({
      status: 200, body: { ok: true, status: 'pending' },
    });
    expect(await deviceRequest('device-poll', { providerId: 'codex-oauth' })).toMatchObject({
      status: 200, body: { ok: true, status: 'pending' },
    });
  });
});

describe('review fixes: xAI SuperGrok device-code login', () => {
  it('starts auth.x.ai with OpenCode scopes and stores the refreshable token JSON', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'grok-device',
        user_code: 'GROK-CODE',
        verification_uri: 'https://auth.x.ai/device',
        verification_uri_complete: 'https://auth.x.ai/device?code=GROK-CODE',
        interval: 5,
        expires_in: 900,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'grok-access', refresh_token: 'grok-refresh', expires_in: 3600,
      })));
    vi.stubGlobal('fetch', upstream);

    const start = await deviceRequest('device-start', { providerId: 'grok-subscription' });
    expect(start).toMatchObject({
      status: 200,
      body: {
        ok: true,
        providerId: 'grok-subscription',
        deviceCode: 'grok-device',
        userCode: 'GROK-CODE',
        verificationUri: 'https://auth.x.ai/device',
        verificationUriComplete: 'https://auth.x.ai/device?code=GROK-CODE',
        upstream: true,
      },
    });
    const [startUrl, startInit] = upstream.mock.calls[0];
    expect(String(startUrl)).toBe('https://auth.x.ai/oauth2/device/code');
    expect(startInit.headers['User-Agent']).toBe('opencode/production/2.0.26/opencode');
    const startForm = new URLSearchParams(String(startInit.body));
    expect(startForm.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(startForm.get('scope')).toBe('openid profile email offline_access grok-cli:access api:access');
    expect(startForm.get('referrer')).toBe('opencode');

    const poll = await deviceRequest('device-poll', { providerId: 'grok-subscription' });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ ok: true, status: 'authorized' });
    const [pollUrl] = upstream.mock.calls[1];
    expect(String(pollUrl)).toBe('https://auth.x.ai/oauth2/token');

    expect(JSON.parse(getSecret('provider:grok-subscription', path.join(root, 'out'))!)).toMatchObject({
      access_token: 'grok-access',
      refresh_token: 'grok-refresh',
      token_url: 'https://auth.x.ai/oauth2/token',
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
    });
  });
});

describe('review fixes: pre-save provider verification', () => {
  it('rejects a bearer provider without an API key before creating it', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { getProvider } = await import('../src/config/studioConfig.js');
    const response = await studioPost('/api/studio/providers', {
      id: 'no-key', preset: 'openai', verifyBeforeSave: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('API key is required to verify and add this provider.');
    expect(upstream).not.toHaveBeenCalled();
    expect(getProvider('no-key', path.join(root, 'out'))).toBeNull();
  });

  it('rolls back a provider whose live verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 })));
    const { getProvider } = await import('../src/config/studioConfig.js');
    const response = await studioPost('/api/studio/providers', {
      id: 'bad-key', preset: 'openai', apiKey: 'sk-bad-key', verifyBeforeSave: true,
    });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/^Provider verification failed: /);
    expect(getProvider('bad-key', path.join(root, 'out'))).toBeNull();
    expect(getSecret('provider:bad-key', path.join(root, 'out'))).toBeNull();
  });

  it('keeps a provider whose /models catalog answers successfully', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-4o', display_name: 'GPT-4o' }, { id: 'gpt-4o-mini' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const { getProvider } = await import('../src/config/studioConfig.js');
    const response = await studioPost('/api/studio/providers', {
      id: 'good-key', preset: 'openai', apiKey: 'sk-good-key', verifyBeforeSave: true,
    });
    expect(response.status).toBe(201);
    expect(response.body.provider.id).toBe('good-key');
    expect(response.body.provider.models.map((m: { id: string }) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(getProvider('good-key', path.join(root, 'out'))!.models.map((m) => m.id))
      .toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(String(upstream.mock.calls[0][0])).toBe('https://api.openai.com/v1/models');
  });
});

describe('review fixes: config root and default chains', () => {
  it('MANHWA_OUT_DIR drives both lanes.json and studio config without leakage', async () => {
    const laneConfig = await import('../src/config/laneConfig.js');
    const studioConfig = await import('../src/config/studioConfig.js');
    const outA = path.join(root, 'out-a');
    const outB = path.join(root, 'out-b');
    fs.mkdirSync(path.join(outA, 'config'), { recursive: true });
    fs.mkdirSync(path.join(outB, 'config'), { recursive: true });

    vi.stubEnv('MANHWA_OUT_DIR', outA);
    vi.stubEnv('MANHWA_LANE_CONFIG', '');
    vi.stubEnv('MANHWA_LANE_CONFIG_DIR', '');
    expect(laneConfig.configPath()).toBe(path.join(outA, 'lanes.json'));

    // Explicit outDir is used for that call only; the next implicit call must
    // not remember it (no `lastExplicitOutDir` fallback).
    const explicit = studioConfig.listRenderNodesConfig(outB);
    expect(Array.isArray(explicit)).toBe(true);
    expect(studioConfig.getStagesConfig().persisted).toBe(false);
    expect(fs.existsSync(path.join(outA, 'config', 'stages.json'))).toBe(false);
    expect(fs.existsSync(path.join(outB, 'config', 'stages.json'))).toBe(false);

    const defaults = laneConfig.getDefaultConfig();
    laneConfig.putLanesState(
      { revision: 0, render: defaults.render, models: defaults.models },
      'admin',
    );
    expect(fs.existsSync(path.join(outA, 'lanes.json'))).toBe(true);
    expect(fs.existsSync(path.join(outB, 'lanes.json'))).toBe(false);

    vi.stubEnv('MANHWA_OUT_DIR', outB);
    expect(laneConfig.configPath()).toBe(path.join(outB, 'lanes.json'));
    expect(laneConfig.getLanesState().persisted).toBe(false);
  });

  it('shares one canonical default vision/writer chain across modules', async () => {
    const laneConfig = await import('../src/config/laneConfig.js');
    const studioConfig = await import('../src/config/studioConfig.js');
    const llm = await import('../src/llm/client.js');
    const ids = (lanes: Array<{ provider?: string; name?: string; model: string }>) =>
      lanes.map((lane) => `${lane.provider ?? lane.name}:${lane.model}`);

    const defaults = laneConfig.getDefaultConfig();
    const staticLanes = laneConfig.inspectStaticLanes();
    expect(defaults.models.vision.map((lane) => lane.id)).toEqual(ids(staticLanes.vision));
    expect(defaults.models.writer.map((lane) => lane.id)).toEqual(ids(staticLanes.writer));
    expect(ids(llm.VISION_LANES)).toEqual(ids(staticLanes.vision));
    expect(ids(llm.WRITER_LANES)).toEqual(ids(staticLanes.writer));

    const stages = studioConfig.getStagesConfig(path.join(root, 'out'));
    expect(stages.reader.chain).toEqual(ids(staticLanes.vision));
    expect(stages.writer.chain).toEqual(ids(staticLanes.writer));
  });
});

describe('review fixes: subscription presets and live /models discovery', () => {
  it('exposes a grok-subscription preset with Grok models', async () => {
    const { PROVIDER_PRESETS } = await import('../src/config/studioConfig.js');
    const preset = PROVIDER_PRESETS['grok-subscription'];
    expect(preset).toMatchObject({
      label: 'xAI SuperGrok / Grok Subscription',
      category: 'subscription',
      kind: 'subscription',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      authMode: 'device-code',
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
      tokenUrl: 'https://auth.x.ai/oauth2/token',
    });
    expect(preset!.defaultModels.map((m) => m.id)).toEqual(
      expect.arrayContaining(['grok-4', 'grok-2-vision-latest']),
    );
    expect(preset!.description).toMatch(/bridge/i);
  });

  it('accepts either an xAI key or a local Grok subscription bridge URL', async () => {
    const { upsertProvider, getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');

    // xAI API key / bearer token against the public endpoint.
    const api = upsertProvider({ id: 'grok-api', preset: 'grok-subscription', apiKey: 'xai-key' }, outDir);
    expect(api.baseUrl).toBe('https://api.x.ai/v1');
    expect(api.allowPrivateNetwork).toBe(false);
    expect(api.models.map((m) => m.id)).toEqual(expect.arrayContaining(['grok-4']));

    // Local subscription bridge override, with the private-network opt-in.
    const bridge = upsertProvider({
      id: 'grok-bridge',
      preset: 'grok-subscription',
      baseUrl: 'http://127.0.0.1:8317/v1',
      allowPrivateNetwork: true,
      apiKey: 'bridge-token',
    }, outDir);
    expect(bridge.baseUrl).toBe('http://127.0.0.1:8317/v1');
    expect(bridge.allowPrivateNetwork).toBe(true);
    expect(getProvider('grok-bridge', outDir)!.auth.hasSecret).toBe(true);
  });

  it('discovers bare /models ids, strips a redundant provider prefix, and saves them', async () => {
    const { discoverProviderModels, getProvider, upsertProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    upsertProvider({ id: 'xai', preset: 'xai', apiKey: 'xai-key' }, outDir);
    const urls: string[] = [];
    const models = await discoverProviderModels('xai', {
      outDir,
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          data: [
            { id: 'grok-4', display_name: 'Grok 4', context_length: 256000 },
            { id: 'xai/grok-2-vision-latest' },
            { id: 'grok-vision-beta' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    expect(urls).toEqual(['https://api.x.ai/v1/models']);
    expect(models.map((m) => m.id)).toEqual(['grok-4', 'grok-2-vision-latest', 'grok-vision-beta']);
    expect(models[0]).toMatchObject({ label: 'Grok 4', contextWindow: 256000 });
    expect(models[1]!.capabilities.vision).toBe(true);
    expect(models[2]!.capabilities.vision).toBe(true);
    const saved = getProvider('xai', outDir)!;
    expect(saved.models.map((m) => m.id)).toEqual(['grok-4', 'grok-2-vision-latest', 'grok-vision-beta']);
  });

  it('resolves a bare model id against the enabled provider that lists it', async () => {
    const { upsertProvider } = await import('../src/config/studioConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    upsertProvider({ id: 'xai', preset: 'xai', apiKey: 'xai-key' }, outDir);
    upsertProvider({ id: 'deepseek', preset: 'deepseek', apiKey: 'ds-key' }, outDir);

    const lane = llm.laneFromConfigEntry({ id: 'grok-4' }, 'writer', outDir);
    expect(lane.name).toBe('xai');
    expect(lane.provider).toBe('xai');
    expect(lane.model).toBe('grok-4');
    expect(lane.base).toBe('https://api.x.ai/v1');

    const explicit = llm.laneFromConfigEntry({ id: 'deepseek:deepseek-chat' }, 'writer', outDir);
    expect(explicit.provider).toBe('deepseek');
    expect(explicit.model).toBe('deepseek-chat');
  });

  it('keeps bare model ids that contain a colon intact (Ollama, OpenRouter)', async () => {
    const { upsertProvider } = await import('../src/config/studioConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    upsertProvider({ id: 'ollama', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', allowPrivateNetwork: true }, outDir);
    upsertProvider({
      id: 'openrouter',
      preset: 'openrouter',
      apiKey: 'or-key',
      models: [{ id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)' }],
    }, outDir);

    // `llama3` is not a provider id, so the whole string stays the model id.
    const ollama = llm.laneFromConfigEntry({ id: 'llama3:8b' }, 'writer', outDir);
    expect(ollama.provider).toBe('ollama');
    expect(ollama.model).toBe('llama3:8b');
    expect(ollama.provider).not.toBe('llama3');

    const openrouter = llm.laneFromConfigEntry({ id: 'google/gemma-4-31b-it:free' }, 'writer', outDir);
    expect(openrouter.provider).toBe('openrouter');
    expect(openrouter.model).toBe('google/gemma-4-31b-it:free');

    // A real provider prefix still splits.
    const split = llm.laneFromConfigEntry({ id: 'openrouter:llama3:8b' }, 'writer', outDir);
    expect(split.provider).toBe('openrouter');
    expect(split.model).toBe('llama3:8b');
  });

  it('does not persist discover results when save is false, and keeps model flags when save is true', async () => {
    const { getProvider, upsertProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'xai',
      preset: 'xai',
      apiKey: 'xai-key',
      models: [
        { id: 'grok-4', label: 'My Grok 4', enabled: false, reasoningEffort: 'high' },
      ],
    }, outDir);
    const before = fs.readFileSync(path.join(outDir, 'config', 'providers.json'), 'utf8');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'grok-4' }, { id: 'grok-vision-beta' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const unsaved = await studioPost('/api/studio/providers/xai/models/discover', { save: false });
    expect(unsaved.status).toBe(200);
    expect(unsaved.body.models.map((m: { id: string }) => m.id)).toEqual(['grok-4', 'grok-vision-beta']);
    expect(fs.readFileSync(path.join(outDir, 'config', 'providers.json'), 'utf8')).toBe(before);
    expect(getProvider('xai', outDir)!.models.map((m) => m.id)).toEqual(['grok-4']);

    const saved = await studioPost('/api/studio/providers/xai/models/discover', { save: true });
    expect(saved.status).toBe(200);
    const models = saved.body.provider.models;
    expect(models.map((m: { id: string }) => m.id)).toEqual(['grok-4', 'grok-vision-beta']);
    // Operator flags on the surviving id are preserved (no second clobbering upsert).
    expect(models[0]).toMatchObject({ label: 'My Grok 4', enabled: false, reasoningEffort: 'high' });
    expect(getProvider('xai', outDir)!.models).toEqual(models);
  });

  it('auto-discovers models on provider create but stays silent when offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'grok-4', display_name: 'Grok 4' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const created = await studioPost('/api/studio/providers', {
      id: 'xai', preset: 'xai', apiKey: 'xai-key', autoDiscoverModels: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.models.map((m: { id: string }) => m.id)).toEqual(['grok-4']);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const offline = await studioPost('/api/studio/providers', {
      id: 'openai', preset: 'openai', apiKey: 'sk-test1234567890',
    });
    expect(offline.status).toBe(201);
    expect(offline.body.provider.models.length).toBeGreaterThan(0);
    expect(offline.body.discoveryError).toBeTruthy();
  });

  it('serves the node action route for provision and the sbx auth endpoint', async () => {
    const { upsertRenderNodeConfig } = await import('../src/config/studioConfig.js');
    const nodeRegistry = await import('../src/workers/nodeRegistry.js');
    nodeRegistry._resetNodeRegistryForTests();
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    });
    const outDir = path.join(root, 'out');
    upsertRenderNodeConfig({ id: 'sbx-fresh', kind: 'docker-sbx', box: 'sbx-fresh' }, outDir);
    const res = await studioPost('/api/studio/nodes/sbx-fresh/action', { action: 'provision' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('missing-cli');

    const auth = await studioPost('/api/studio/sbx/auth', { mode: 'status' });
    expect(auth.status).toBe(200);
    expect(auth.body).toMatchObject({ installed: false, authenticated: false });

    nodeRegistry._resetNodeRegistryForTests();
    nodeRegistry._setLocalRunnerForTests(null);
  });
});

/** Build an unsigned JWT carrying the ChatGPT auth claim. */
function chatGptJwt(accountId: string, extra: Record<string, unknown> = {}): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      ...extra,
    }),
    'sig',
  ].join('.');
}

describe('review fixes: device-flow client ids stay per-provider', () => {
  it('GITHUB_COPILOT_CLIENT_ID does not override codex-oauth or grok-subscription', async () => {
    vi.stubEnv('GITHUB_COPILOT_CLIENT_ID', 'copilot-env-client');
    const upstream = vi.fn()
      .mockImplementation(async () => new Response(JSON.stringify({
        device_auth_id: 'dev-1', user_code: 'CODE-1', interval: 5,
      })));
    vi.stubGlobal('fetch', upstream);

    await deviceRequest('device-start', { providerId: 'codex-oauth' });
    const [openaiUrl, openaiInit] = upstream.mock.calls[0];
    expect(String(openaiUrl)).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(openaiInit.body).client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

    upstream.mockReset();
    upstream.mockImplementation(async () => new Response(JSON.stringify({
      device_code: 'grok-device', user_code: 'GROK-1',
      verification_uri: 'https://auth.x.ai/device', interval: 5, expires_in: 900,
    })));
    await deviceRequest('device-start', { providerId: 'grok-subscription' });
    const [grokUrl, grokInit] = upstream.mock.calls[0];
    expect(String(grokUrl)).toBe('https://auth.x.ai/oauth2/device/code');
    expect(new URLSearchParams(String(grokInit.body)).get('client_id'))
      .toBe('b1a00492-073a-47ea-816f-4c329264a828');
  });

  it('still honours GITHUB_COPILOT_CLIENT_ID for the github-copilot flow', async () => {
    vi.stubEnv('GITHUB_COPILOT_CLIENT_ID', 'copilot-env-client');
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_code: 'gh-device', user_code: 'GH-1',
      verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900,
    })));
    vi.stubGlobal('fetch', upstream);
    const start = await deviceRequest('device-start', { providerId: 'github-copilot' });
    expect(start.status).toBe(200);
    expect(new URLSearchParams(String(upstream.mock.calls[0][1].body)).get('client_id'))
      .toBe('copilot-env-client');
  });

  it('resolves a subscription preset for a custom provider id and reports slow_down', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'dev-custom', user_code: 'CUSTOM-1', interval: 5,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'slow_down' })));
    vi.stubGlobal('fetch', upstream);

    const start = await deviceRequest('device-start', { providerId: 'my-codex', preset: 'codex-oauth' });
    expect(start.status).toBe(200);
    expect(JSON.parse(upstream.mock.calls[0][1].body).client_id)
      .toBe('app_EMoamEEZ73f0CkXaXp7hrann');

    const poll = await deviceRequest('device-poll', { providerId: 'my-codex', preset: 'codex-oauth' });
    expect(poll).toMatchObject({
      status: 200,
      body: { ok: true, providerId: 'my-codex', status: 'pending', slowDown: true, interval: 10 },
    });
  });
});

describe('review fixes: ChatGPT subscription Codex backend transport', () => {
  it('routes a codex-oauth JWT to the Codex backend and parses the SSE output', async () => {
    const { upsertProvider, putStagesConfig } = await import('../src/config/studioConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    const token = chatGptJwt('acct-123');
    upsertProvider({
      id: 'codex-oauth',
      preset: 'codex-oauth',
      apiKey: JSON.stringify({ access_token: token, refresh_token: 'refresh-1' }),
    }, outDir);
    putStagesConfig({ writer: { chain: ['codex-oauth:gpt-5.6-sol'], concurrency: 1, temperature: 0.5 } }, outDir);

    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const sse = [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello "}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"subscription"}',
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ text: 'Hello subscription' }] }], usage: { input_tokens: 3, output_tokens: 2 } } })}`,
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    try {
      llm._resetSnapshotForTests();
      const reply = await llm.call(
        [
          { role: 'system', content: 'You are a manhwa narrator.' },
          { role: 'user', content: 'Say hello.' },
        ],
        { stage: 'writer', maxTokens: 16 },
      );
      expect(reply.choices[0]!.message.content).toBe('Hello subscription');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(calls[0]!.headers['chatgpt-account-id']).toBe('acct-123');
      expect(calls[0]!.headers.originator).toBe('opencode');
      expect(calls[0]!.headers['user-agent']).toBe('opencode/production/2.0.26/opencode');
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
      expect(calls[0]!.body).toMatchObject({
        instructions: 'You are a manhwa narrator.',
        store: false,
        stream: true,
      });
      expect(calls[0]!.body.input[0]).toMatchObject({ role: 'user', content: 'Say hello.' });
    } finally {
      globalThis.fetch = origFetch;
      llm._resetSnapshotForTests();
    }
  });

  it('extracts the account id from the JWT and falls back to preset models on 401', async () => {
    const { extractChatGptAccountId, discoverProviderModels, upsertProvider, PROVIDER_PRESETS } =
      await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const token = chatGptJwt('acct-456');
    expect(extractChatGptAccountId(token)).toBe('acct-456');
    expect(extractChatGptAccountId('not-a-jwt')).toBeUndefined();

    upsertProvider({ id: 'codex-oauth', preset: 'codex-oauth', apiKey: token }, outDir);
    const models = await discoverProviderModels('codex-oauth', {
      outDir,
      fetchFn: (async () => new Response('billing_not_active', { status: 401 })) as unknown as typeof fetch,
    });
    expect(models.map((m) => m.id)).toEqual(
      PROVIDER_PRESETS['codex-oauth']!.defaultModels.map((m) => m.id),
    );
  });
});

describe('review fixes: verifyBeforeSave rollback for an existing provider', () => {
  it('restores the previous config and secret when verification fails', async () => {
    const { getProvider, upsertProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'existing', preset: 'openai', apiKey: 'sk-original-key', label: 'Original',
    }, outDir);
    const before = getProvider('existing', outDir)!;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 })));
    const response = await studioPost('/api/studio/providers', {
      id: 'existing', preset: 'openai', apiKey: 'sk-broken-key', label: 'Broken',
      verifyBeforeSave: true,
    });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/^Provider verification failed: /);

    const after = getProvider('existing', outDir)!;
    expect(after.label).toBe('Original');
    expect(after.baseUrl).toBe(before.baseUrl);
    expect(getSecret('provider:existing', outDir)).toBe('sk-original-key');
  });
});

describe('review fixes: codex-oauth model catalog', () => {
  const CODEX_MODELS = [
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ];

  it('lists exactly the 7 Codex backend models and drops the stale API models', async () => {
    const { PROVIDER_PRESETS } = await import('../src/config/studioConfig.js');
    const ids = PROVIDER_PRESETS['codex-oauth']!.defaultModels.map((m) => m.id);
    expect(ids).toEqual(CODEX_MODELS);
    for (const stale of ['gpt-4o', 'gpt-5', 'gpt-5-codex']) {
      expect(ids).not.toContain(stale);
    }
    const sol = PROVIDER_PRESETS['codex-oauth']!.defaultModels[0]!;
    expect(sol).toMatchObject({
      label: 'GPT-6.1 Sol',
      capabilities: { vision: true, writer: true, reasoning: true },
      reasoningEffort: 'high',
      costTier: 'free',
    });
  });

  it('discovers Codex models from the ChatGPT backend, hiding non-list entries, and persists them', async () => {
    const { discoverProviderModels, getProvider, upsertProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const token = chatGptJwt('acct-789');
    upsertProvider({ id: 'codex-oauth', preset: 'codex-oauth', apiKey: token }, outDir);

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const models = await discoverProviderModels('codex-oauth', {
      outDir,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return new Response(JSON.stringify({
          models: [
            { slug: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', visibility: 'list', context_window: 400000 },
            { slug: 'gpt-6-astra', title: 'GPT-6 Astra', visibility: 'list' },
            { slug: 'gpt-6-internal', title: 'GPT-6 Internal', visibility: 'hide' },
            { id: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(calls[0]!.headers.originator).toBe('opencode');
    expect(calls[0]!.headers['user-agent']).toBe('opencode/production/2.0.26/opencode');
    expect(calls[0]!.headers['chatgpt-account-id']).toBe('acct-789');

    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']);
    expect(models[0]).toMatchObject({
      label: 'GPT-6.1 Sol',
      contextWindow: 400000,
      capabilities: { vision: true, writer: true, reasoning: true },
      reasoningEffort: 'high',
    });
    // Every discovered Codex model is a reasoning model, including one that is
    // not in the preset list.
    expect(models.every((m) => m.capabilities.reasoning === true)).toBe(true);
    expect(models.map((m) => m.reasoningEffort)).toEqual(['high', 'high', 'high']);

    const saved = getProvider('codex-oauth', outDir)!;
    expect(saved.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']);
    expect(saved.models.every((m) => m.capabilities.reasoning === true)).toBe(true);
    expect(saved.models.map((m) => m.reasoningEffort)).toEqual(['high', 'high', 'high']);
    expect(saved.models[0]!.capabilities.vision).toBe(true);
    expect(saved.models[0]!.capabilities.writer).toBe(true);
  });

  it('falls back to the 7 preset models when the Codex backend returns no models', async () => {
    const { discoverProviderModels, PROVIDER_PRESETS, upsertProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const token = chatGptJwt('acct-000');
    upsertProvider({ id: 'codex-oauth', preset: 'codex-oauth', apiKey: token }, outDir);
    const models = await discoverProviderModels('codex-oauth', {
      outDir,
      fetchFn: (async () => new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    expect(models.map((m) => m.id)).toEqual(
      PROVIDER_PRESETS['codex-oauth']!.defaultModels.map((m) => m.id),
    );
  });
});

describe('review fixes: grok-subscription TTS catalog wiring', () => {
  it('exposes a grok TTS provider when Studio has a connected grok-subscription provider', async () => {
    const { loadRawTtsProviders } = await import('../src/intake/intake.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', 'xai-studio-token', outDir);
    const providers = loadRawTtsProviders({
      MANHWA_OUT_DIR: outDir,
      PATH: process.env.PATH ?? '',
    } as never);
    expect(providers.map((p) => p.id)).toContain('grok');
    const grok = providers.find((p) => p.id === 'grok')!;
    expect(grok.engine).toBe('grok');
    expect(grok.provider).toBe('grok-subscription-tts');
    expect(grok.voices.length).toBeGreaterThan(0);
    expect(grok.voices.some((v) => v.default)).toBe(true);
  });

  it('stays off without a Studio grok-subscription provider (hermetic unit tests)', async () => {
    const { loadRawTtsProviders } = await import('../src/intake/intake.js');
    const providers = loadRawTtsProviders({
      MANHWA_OUT_DIR: path.join(root, 'out'),
      MANHWA_JOBS_DIR: path.join(root, 'out', 'jobs'),
      PATH: process.env.PATH ?? '',
    } as never);
    expect(providers.map((p) => p.id)).toEqual(['edge']);
  });

  it('discovers xAI voices into out/config/grok-tts-voices.json and synthesizes via /v1/tts', async () => {
    const { discoverGrokTtsVoices, synthesizeGrokTtsToFile, GROK_TTS_VOICES_CACHE_FILENAME } =
      await import('../src/llm/grokTts.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', 'xai-studio-token', outDir);
    const env = { MANHWA_OUT_DIR: outDir, PATH: process.env.PATH ?? '' };
    const fixture = vertexFixtureMp3(root);
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/voices')) {
        return new Response(JSON.stringify({ voices: [{ voice_id: 'ara' }, { voice_id: 'rex' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(fs.readFileSync(fixture), {
        status: 200, headers: { 'content-type': 'audio/mpeg' },
      });
    }) as unknown as typeof fetch;

    const voices = await discoverGrokTtsVoices(env, { fetchImpl });
    expect(voices.map((v) => v.id)).toEqual(['ara', 'rex']);
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/tts/voices');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer xai-studio-token');
    const cacheFile = path.join(outDir, 'config', GROK_TTS_VOICES_CACHE_FILENAME);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const dest = path.join(root, 'grok.mp3');
    await synthesizeGrokTtsToFile({
      text: 'The gate opened again.', voiceId: 'ara', destPath: dest, env, fetchImpl,
    });
    expect(calls[1]!.url).toBe('https://api.x.ai/v1/tts');
    expect(calls[1]!.init.headers.Authorization).toBe('Bearer xai-studio-token');
    expect(JSON.parse(calls[1]!.init.body)).toMatchObject({
      input: 'The gate opened again.', voice_id: 'ara', response_format: 'mp3',
    });
    expect(fs.statSync(dest).size).toBe(fs.statSync(fixture).size);
  });

  it('still honours an explicit MANHWA_TTS_CATALOG', async () => {
    const { loadRawTtsProviders } = await import('../src/intake/intake.js');
    const catalog = path.join(root, 'explicit-tts.json');
    writeJson(catalog, { providers: [{
      id: 'explicit', engine: 'external', provider: 'explicit-upstream',
      command: ['node', '/explicit.cjs'], voices: [{ id: 'v1', default: true }],
    }] });
    const providers = loadRawTtsProviders({
      MANHWA_TTS_CATALOG: catalog,
      MANHWA_JOBS_DIR: '/tmp/opencode/jobs',
      PATH: process.env.PATH ?? '',
    } as never);
    expect(providers.map((p) => p.id)).toEqual(['edge', 'explicit']);
  });
});

// ---------------------------------------------------------------------------
// Vertex AI TTS (Chirp 3 HD + Gemini 3.8 Flash TTS)
// ---------------------------------------------------------------------------

/** MP3 fixture so the preview/line writers can prove real audio. */
function vertexFixtureMp3(dirPath: string): string {
  const out = path.join(dirPath, 'vertex-fixture.mp3');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-ac', '1', '-ar', '24000', '-b:a', '64k', out,
  ], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${String(r.stderr)}`);
  return out;
}

/** WAV fixture, as Gemini TTS returns 24 kHz audio. */
function vertexFixtureWav(dirPath: string): string {
  const out = path.join(dirPath, 'vertex-fixture.wav');
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-ac', '1', '-ar', '24000', out,
  ], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${String(r.stderr)}`);
  return out;
}

/** Vertex env with a stored Studio provider + secret (never host ADC). */
function vertexStudioEnv(fixtureMp3: string): Record<string, string> {
  const outDir = path.join(root, 'out');
  upsertProvider({
    id: 'vertex-ai',
    preset: 'vertex-ai',
    auth: {
      mode: 'vertex-oauth',
      projectId: 'studio-project',
      secretRef: 'provider:vertex-ai',
    },
  }, outDir);
  putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);
  const catalog = path.join(root, 'tts-vertex.json');
  writeJson(catalog, { providers: [] });
  return {
    MANHWA_OUT_DIR: outDir,
    MANHWA_JOBS_DIR: path.join(outDir, 'jobs'),
    MANHWA_TTS_CATALOG: catalog,
    PATH: process.env.PATH ?? '',
    _FIXTURE: fixtureMp3,
  };
}

describe('review fixes: Vertex AI TTS', () => {
  it('exposes the Chirp 3 HD and Gemini 3.8 Flash TTS voice catalog', () => {
    const ids = VERTEX_TTS_VOICES.map((v) => v.id);
    expect(ids).toContain('en-US-Chirp3-HD-Charon');
    expect(ids).toContain('en-US-Chirp3-HD-Zephyr');
    expect(ids).toContain('gemini-tts:Charon');
    expect(ids).toContain('gemini-tts:Aoede');
    expect(VERTEX_TTS_VOICES.find((v) => v.id === 'en-US-Chirp3-HD-Charon')?.default).toBe(true);
    expect(VERTEX_TTS_VOICES.filter((v) => v.default)).toHaveLength(1);
  });

  it('synthesizes Chirp 3 HD via texttospeech.googleapis.com with x-goog-user-project', async () => {
    const fixture = vertexFixtureMp3(root);
    const env = vertexStudioEnv(fixture);
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        audioContent: fs.readFileSync(fixture).toString('base64'),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const dest = path.join(root, 'chirp.mp3');
    await synthesizeVertexTtsToFile({
      text: 'The gate opened again.', voiceId: 'en-US-Chirp3-HD-Charon',
      destPath: dest, speed: 1.1, env, fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer studio-access-token');
    expect(calls[0]!.init.headers['x-goog-user-project']).toBe('studio-project');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toMatchObject({
      input: { text: 'The gate opened again.' },
      voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Charon' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.1 },
    });
    expect(fs.statSync(dest).size).toBe(fs.statSync(fixture).size);
  });

  it('synthesizes Gemini 3.8 Flash TTS via aiplatform generateContent and transcodes to MP3', async () => {
    const wav = vertexFixtureWav(root);
    const env = vertexStudioEnv(wav);
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: fs.readFileSync(wav).toString('base64'), mimeType: 'audio/wav' } }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const dest = path.join(root, 'gemini.mp3');
    await synthesizeVertexTtsToFile({
      text: 'Someone was waiting for her.', voiceId: 'gemini-tts:Charon',
      destPath: dest, env, fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/studio-project/locations/global'
      + '/publishers/google/models/gemini-3.8-flash-tts:generateContent',
    );
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Charon');
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', dest], { encoding: 'utf8' });
    expect(String(probe.stdout)).toMatch(/mp3/);
  });

  it('rejects unknown voices and surfaces HTTP failures without leaking secrets', async () => {
    const env = vertexStudioEnv(vertexFixtureMp3(root));
    await expect(synthesizeVertexTtsToFile({
      text: 'x', voiceId: 'en-US-Chirp3-HD-Nope', destPath: path.join(root, 'x.mp3'), env,
    })).rejects.toThrow(/not a Vertex TTS voice/);
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: { message: 'permission denied', token: 'super-secret-token' } }),
      { status: 403 },
    )) as unknown as typeof fetch;
    const err = await synthesizeVertexTtsToFile({
      text: 'x', voiceId: 'en-US-Chirp3-HD-Charon',
      destPath: path.join(root, 'x.mp3'), env, fetchImpl,
    }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/HTTP 403/);
    expect(err?.message).not.toContain('super-secret-token');
  });

  it('intake.resolveTtsSelection resolves a vertex voice to the vertex engine', async () => {
    const fixture = vertexFixtureMp3(root);
    const env = vertexStudioEnv(fixture);
    const sel = await resolveTtsSelection('vertex', 'en-US-Chirp3-HD-Charon', undefined, env, true);
    expect(sel.providerId).toBe('vertex');
    expect(sel.engine).toBe('vertex');
    expect(sel.voiceId).toBe('en-US-Chirp3-HD-Charon');
    expect(sel.metaTts).toMatchObject({
      engine: 'vertex', provider: 'vertex-ai', voice_id: 'en-US-Chirp3-HD-Charon', revision: '1',
    });
    // no voice id picks the catalog default (Chirp 3 HD Charon)
    const def = await resolveTtsSelection('vertex', '', undefined, env, true);
    expect(def.voiceId).toBe('en-US-Chirp3-HD-Charon');
    // a Gemini voice stays on the same engine
    const gem = await resolveTtsSelection('vertex', 'gemini-tts:Puck', undefined, env, true);
    expect(gem.voiceId).toBe('gemini-tts:Puck');
    await expect(resolveTtsSelection('vertex', 'not-a-voice', undefined, env, true))
      .rejects.toThrow(/not in server catalog/);
  });

  it('voicePreview.generatePreview("vertex") synthesizes and caches through the vertex engine', async () => {
    const fixture = vertexFixtureMp3(root);
    const env = vertexStudioEnv(fixture);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        audioContent: fs.readFileSync(fixture).toString('base64'),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const first = await generatePreview('vertex', 'en-US-Chirp3-HD-Charon', env as never);
    expect(first.cached).toBe(false);
    expect(first.duration).toBeGreaterThan(0);
    expect(calls[0]).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    const again = await generatePreview('vertex', 'en-US-Chirp3-HD-Charon', env as never);
    expect(again).toMatchObject({ id: first.id, cached: true });
    expect(calls).toHaveLength(1);
    // unknown voice never reaches the API
    await expect(generatePreview('vertex', 'gemini-tts:Nope', env as never))
      .rejects.toThrow(/not in server catalog/);
    expect(calls).toHaveLength(1);
  });

  it('hasVertexTtsCredentials stays off in a synthetic test env without a provider', () => {
    const avail = hasVertexTtsCredentials({
      MANHWA_JOBS_DIR: path.join(root, 'out', 'jobs'),
      MANHWA_OUT_DIR: path.join(root, 'out'),
      HOME: '/nonexistent-home',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    });
    expect(avail.available).toBe(false);
    expect(avail.reason).toMatch(/Vertex AI credentials/);
  });

  it('discovers voices via GET /v1/voices and caches them in out/config/vertex-tts-voices.json', async () => {
    const { discoverVertexTtsVoices, listVertexTtsVoices, VERTEX_TTS_VOICES_CACHE_FILENAME } =
      await import('../src/llm/vertexTts.js');
    const env = vertexStudioEnv(vertexFixtureMp3(root));
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        voices: [
          { name: 'en-US-Chirp3-HD-Charon', languageCodes: ['en-US'] },
          { name: 'en-US-Studio-O', languageCodes: ['en-US'] },
          { name: 'en-US-Neural2-D', languageCodes: ['en-US'] },
          { name: 'en-US-Standard-A', languageCodes: ['en-US'] },
          { name: 'fr-FR-Chirp3-HD-Kore', languageCodes: ['fr-FR'] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const voices = await discoverVertexTtsVoices(env, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://texttospeech.googleapis.com/v1/voices?languageCode=en-US');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer studio-access-token');
    expect(calls[0]!.init.headers['x-goog-user-project']).toBe('studio-project');
    // Natural narration families only, English only.
    expect(voices.map((v) => v.id)).toEqual([
      'en-US-Chirp3-HD-Charon', 'en-US-Studio-O', 'en-US-Neural2-D',
    ]);
    const cacheFile = path.join(root, 'out', 'config', VERTEX_TTS_VOICES_CACHE_FILENAME);
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cached.projectId).toBe('studio-project');
    // The synchronous catalog sees the discovered voices plus the Gemini voices.
    const catalog = listVertexTtsVoices(env);
    expect(catalog.map((v) => v.id)).toContain('en-US-Studio-O');
    expect(catalog.map((v) => v.id)).toContain('gemini-tts:Charon');
  });

  it('never reads a hardcoded host path for Vertex credentials', async () => {
    const studioConfig = await import('../src/config/studioConfig.js');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'config', 'studioConfig.ts'), 'utf8',
    );
    expect(source).not.toMatch(/\/root\//);
    expect(source).not.toMatch(/\/home\/shair\//);
    expect(source).not.toMatch(/"\/home\//);
    expect(typeof studioConfig.discoverVertexProjects).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Vertex AI: unprefixed model ids + project auto-detection
// ---------------------------------------------------------------------------

describe('review fixes: Vertex model ids and project auto-detection', () => {
  it('keeps PROVIDER_PRESETS["vertex-ai"] model ids unprefixed', async () => {
    const { PROVIDER_PRESETS } = await import('../src/config/studioConfig.js');
    const ids = PROVIDER_PRESETS['vertex-ai']!.defaultModels.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => id.startsWith('google/'))).toBe(false);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).toContain('gemini-2.5-pro');
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('gemini-3.8-flash-tts');
  });

  it('sends google/<model> only in the Vertex OpenAI-compatible request payload', async () => {
    const llm = await import('../src/llm/client.js');
    const { upsertProvider, putStagesConfig } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      protocol: 'vertex-openai',
      auth: {
        mode: 'vertex-oauth',
        projectId: 'studio-project',
        secretRef: 'provider:vertex-ai',
      },
      models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);
    putStagesConfig({
      writer: { chain: ['vertex-ai:gemini-2.5-flash'], concurrency: 1, temperature: 0.2 },
    }, outDir);
    llm._resetSnapshotForTests();

    const seen: Array<{ url: string; body: any }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const reply = await llm.call(
        [{ role: 'user', content: 'Write one line.' }],
        { stage: 'writer' },
      );
      expect((reply as any).choices?.[0]?.message?.content).toBe('ok');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('/projects/studio-project/');
    expect(seen[0]!.url).toContain('/chat/completions');
    expect(seen[0]!.body.model).toBe('google/gemini-2.5-flash');
    // The lane itself keeps the bare id for config/UI.
    const lane = llm.laneFromConfigEntry({ id: 'vertex-ai:gemini-2.5-flash' }, 'writer', outDir);
    expect(lane.model).toBe('gemini-2.5-flash');
  });

  it('auto-detects projectId during pkce-exchange when the caller omits it', async () => {
    const { getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: any) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      if (String(url).includes('cloudresourcemanager.googleapis.com')) {
        return new Response(JSON.stringify({
          projects: [
            { projectId: 'auto-project-1', name: 'Auto One', lifecycleState: 'ACTIVE' },
            { projectId: 'auto-project-2', name: 'Auto Two', lifecycleState: 'ACTIVE' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'vertex-oauth-access', refresh_token: 'vertex-oauth-refresh',
        expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      codeOrUrl: 'auth-code-1',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectId).toBe('auto-project-1');
    expect(response.body.projects.map((p: any) => p.projectId)).toEqual([
      'auto-project-1', 'auto-project-2',
    ]);
    expect(getProvider('vertex-ai', outDir)?.auth.projectId).toBe('auto-project-1');
    expect(getProvider('vertex-ai', outDir)?.auth.projects).toEqual([
      { projectId: 'auto-project-1', name: 'Auto One' },
      { projectId: 'auto-project-2', name: 'Auto Two' },
    ]);

    const discovery = calls.find((c) => c.url.includes('cloudresourcemanager'));
    expect(discovery?.url).toBe(
      'https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE',
    );
    expect(discovery?.headers.Authorization).toBe('Bearer vertex-oauth-access');
  });

  it('persists auth.projects when the caller supplies a projectId', async () => {
    const { getProvider, listProviders } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    vi.stubGlobal('fetch', (async (url: string) => {
      if (String(url).includes('cloudresourcemanager.googleapis.com')) {
        return new Response(JSON.stringify({
          projects: [
            { projectId: 'picked-project', name: 'Picked' },
            { projectId: 'other-project', name: 'Other' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'supplied-access', refresh_token: 'supplied-refresh',
        expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      codeOrUrl: 'supplied-code',
      codeVerifier: 'v'.repeat(43),
      projectId: 'picked-project',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.projectId).toBe('picked-project');
    const expected = [
      { projectId: 'picked-project', name: 'Picked' },
      { projectId: 'other-project', name: 'Other' },
    ];
    expect(getProvider('vertex-ai', outDir)?.auth.projectId).toBe('picked-project');
    expect(getProvider('vertex-ai', outDir)?.auth.projects).toEqual(expected);
    expect(listProviders(outDir).find((p) => p.id === 'vertex-ai')?.auth.projects).toEqual(expected);
  });

  it('serves GET /api/studio/vertex/projects for a connected vertex-ai provider', async () => {
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: {
        mode: 'vertex-oauth',
        projectId: 'studio-project',
        secretRef: 'provider:vertex-ai',
      },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'studio-access-token' }), outDir);
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      projects: [{ projectId: 'studio-project', name: 'Studio Project' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch);

    const pathname = '/api/studio/vertex/projects';
    const req = Readable.from([]) as IncomingMessage;
    req.method = 'GET';
    req.headers = { host: 'studio.local', origin: 'http://studio.local' };
    let result!: { status: number; body: any };
    await handleStudioRoute(req, {} as ServerResponse, pathname, new URL(`${pathname}?providerId=vertex-ai`, 'http://studio.local'), {
      user: 'review-admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'review-csrf',
    }, (_res, status, response) => { result = { status, body: response }; });
    expect(result.status).toBe(200);
    expect(result.body.projectId).toBe('studio-project');
    expect(result.body.projects).toEqual([{ projectId: 'studio-project', name: 'Studio Project' }]);
  });
});

// ---------------------------------------------------------------------------
// Review fixes: OAuth token bundles, Google offline consent, Grok token refresh
// ---------------------------------------------------------------------------

describe('review fixes: pasted JSON OAuth bundles', () => {
  it('parses a pasted JSON bundle in pkce-exchange and discovers projects with its access_token', async () => {
    const { getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: any) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return new Response(JSON.stringify({
        projects: [{ projectId: 'bundle-project', name: 'Bundle Project' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const bundle = {
      access_token: 'bundle-access-token',
      refresh_token: 'bundle-refresh-token',
      expires_at: 4_000_000_000,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'bundle-client-id.apps.googleusercontent.com',
    };
    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      codeOrUrl: JSON.stringify(bundle),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectId).toBe('bundle-project');

    const stored = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(stored).toMatchObject({
      access_token: 'bundle-access-token',
      refresh_token: 'bundle-refresh-token',
      expires_at: 4_000_000_000,
      token_uri: 'https://oauth2.googleapis.com/token',
    });
    expect(stored.access_token).not.toContain('{');

    const discovery = calls.find((c) => c.url.includes('cloudresourcemanager'));
    expect(discovery?.headers.Authorization).toBe('Bearer bundle-access-token');
    expect(getProvider('vertex-ai', outDir)?.auth.projectId).toBe('bundle-project');
  });

  it('parses a JSON bundle sent as accessToken without a code verifier', async () => {
    const outDir = path.join(root, 'out');
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      projects: [{ projectId: 'direct-project', name: 'Direct Project' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      accessToken: JSON.stringify({
        access_token: 'direct-access-token',
        refresh_token: 'direct-refresh-token',
        expires_at: 4_100_000_000,
      }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.projectId).toBe('direct-project');
    const stored = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(stored).toMatchObject({
      access_token: 'direct-access-token',
      refresh_token: 'direct-refresh-token',
      expires_at: 4_100_000_000,
    });
  });
});

describe('review fixes: Google OAuth offline consent', () => {
  it('adds access_type=offline and prompt=consent for accounts.google.com', async () => {
    const { createPkceChallenge } = await import('../src/config/studioConfig.js');
    const pkce = createPkceChallenge({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientId: 'google-client-id',
      redirectUri: 'http://localhost',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const url = new URL(pkce.authorizeUrl!);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('does not force offline consent on a non-Google authorize URL', async () => {
    const { createPkceChallenge } = await import('../src/config/studioConfig.js');
    const pkce = createPkceChallenge({
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
    const url = new URL(pkce.authorizeUrl!);
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBeNull();
  });
});

describe('review fixes: Grok TTS token refresh', () => {
  it('persists the rotated refresh_token and re-resolves when the secret changes', async () => {
    const { resolveGrokAccessToken } = await import('../src/llm/grokTts.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', JSON.stringify({
      access_token: 'expired-access',
      refresh_token: 'old-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 600,
      token_url: 'https://auth.x.ai/oauth2/token',
      client_id: 'grok-client',
    }), outDir);

    const env = { MANHWA_OUT_DIR: outDir, PATH: process.env.PATH ?? '' };
    const refreshCalls: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      refreshCalls.push(String(url));
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('refresh_token')).toBe('old-refresh');
      return new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const first = await resolveGrokAccessToken(env, { fetchImpl });
    expect(first.accessToken).toBe('fresh-access');
    expect(refreshCalls).toEqual(['https://auth.x.ai/oauth2/token']);

    const persisted = JSON.parse(getSecret('provider:grok-subscription', outDir)!);
    expect(persisted).toMatchObject({
      access_token: 'fresh-access',
      refresh_token: 'rotated-refresh',
      token_url: 'https://auth.x.ai/oauth2/token',
      client_id: 'grok-client',
    });
    expect(persisted.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The refreshed token is cached under the new secret: no second network call.
    const cached = await resolveGrokAccessToken(env, { fetchImpl });
    expect(cached.accessToken).toBe('fresh-access');
    expect(refreshCalls).toHaveLength(1);

    // Replacing the credential invalidates the cache entry.
    putSecret('provider:grok-subscription', 'xai-new-api-key', outDir);
    const replaced = await resolveGrokAccessToken(env, { fetchImpl });
    expect(replaced.accessToken).toBe('xai-new-api-key');
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('review fixes: Vertex OAuth refresh client_id and project pagination', () => {
  it('honours the stored client_id and falls back to the public CLI default', async () => {
    const { resolveVertexOAuthAccessToken, VERTEX_OAUTH_DEFAULT_CLIENT_ID } =
      await import('../src/config/studioConfig.js');
    const bodies: URLSearchParams[] = [];
    const fetchFn = (async (_url: string, init: any) => {
      bodies.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 60 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const expired = { refresh_token: 'refresh-1', expires_at: 1 };

    await resolveVertexOAuthAccessToken(
      JSON.stringify({ ...expired, client_id: 'stored-client' }),
      { fetchFn, clientId: 'provider-client', nowSec: 1000 },
    );
    await resolveVertexOAuthAccessToken(JSON.stringify(expired), { fetchFn, nowSec: 1000 });

    expect(bodies[0]!.get('client_id')).toBe('stored-client');
    expect(bodies[1]!.get('client_id')).toBe(VERTEX_OAUTH_DEFAULT_CLIENT_ID);
  });

  it('follows nextPageToken in discoverVertexProjects and dedupes projects', async () => {
    const { discoverVertexProjects } = await import('../src/config/studioConfig.js');
    const urls: string[] = [];
    const pages = [
      { projects: [{ projectId: 'p1', name: 'One' }], nextPageToken: 'page-2' },
      { projects: [{ projectId: 'p2' }, { projectId: 'p1' }], nextPageToken: 'page-3' },
      { projects: [{ projectId: 'p3' }] },
    ];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(pages[urls.length - 1]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const projects = await discoverVertexProjects('access', fetchFn);
    expect(projects.map((p) => p.projectId)).toEqual(['p1', 'p2', 'p3']);
    expect(urls[0]).toBe('https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE');
    expect(urls[1]).toContain('pageToken=page-2');
    expect(urls[2]).toContain('pageToken=page-3');
  });
});

describe('review fixes: refresh-only OAuth bundles (gcloud authorized_user)', () => {
  it('mints an access token from a refresh-only bundle and honours quota_project_id', async () => {
    const { getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({
          access_token: 'minted-access-token', expires_in: 3600, token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        projects: [{ projectId: 'other-project', name: 'Other' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      codeOrUrl: JSON.stringify({
        client_id: 'adc-client-id.apps.googleusercontent.com',
        client_secret: 'adc-client-secret',
        refresh_token: 'adc-refresh-token',
        quota_project_id: 'quota-project',
        type: 'authorized_user',
      }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectId).toBe('quota-project');

    const tokenCall = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
    const form = new URLSearchParams(tokenCall!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('adc-refresh-token');
    expect(form.get('client_id')).toBe('adc-client-id.apps.googleusercontent.com');
    expect(form.get('client_secret')).toBe('adc-client-secret');

    const stored = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(stored).toMatchObject({
      access_token: 'minted-access-token',
      refresh_token: 'adc-refresh-token',
      client_id: 'adc-client-id.apps.googleusercontent.com',
      client_secret: 'adc-client-secret',
    });
    const discovery = calls.find((c) => c.url.includes('cloudresourcemanager'));
    expect(discovery).toBeDefined();
    expect(getProvider('vertex-ai', outDir)?.auth.projectId).toBe('quota-project');
  });

  it('sends the stored client_secret when refreshing a stored blob', async () => {
    const { resolveVertexOAuthAccessToken } = await import('../src/config/studioConfig.js');
    const bodies: URLSearchParams[] = [];
    const fetchFn = (async (_url: string, init: any) => {
      bodies.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 60 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await resolveVertexOAuthAccessToken(
      JSON.stringify({
        refresh_token: 'r', expires_at: 1,
        client_id: 'stored-client', client_secret: 'stored-secret',
      }),
      { fetchFn, nowSec: 1000 },
    );
    expect(bodies[0]!.get('client_id')).toBe('stored-client');
    expect(bodies[0]!.get('client_secret')).toBe('stored-secret');
  });
});

describe('review fixes: Gemini TTS atempo chaining', () => {
  it('splits out-of-range speeds into atempo stages within 0.5..2.0', async () => {
    const { buildAtempoFilter } = await import('../src/llm/vertexTts.js');
    expect(buildAtempoFilter(1.5)).toBe('atempo=1.5');
    expect(buildAtempoFilter(0.25)).toBe('atempo=0.5,atempo=0.5');
    expect(buildAtempoFilter(4)).toBe('atempo=2,atempo=2');
    expect(buildAtempoFilter(3)).toBe('atempo=2,atempo=1.5');
    expect(buildAtempoFilter(0.4)).toBe('atempo=0.5,atempo=0.8');
    // Clamped to the supported range.
    expect(buildAtempoFilter(9)).toBe('atempo=2,atempo=2');
    for (const stage of buildAtempoFilter(0.25).split(',')) {
      const value = Number(stage.replace('atempo=', ''));
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(2);
    }
  });
});

describe('review fixes: Grok TTS concurrent refresh dedupe', () => {
  it('shares one upstream refresh between concurrent callers', async () => {
    const { resolveGrokAccessToken } = await import('../src/llm/grokTts.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'grok-subscription',
      preset: 'grok-subscription',
      auth: { mode: 'device-code', secretRef: 'provider:grok-subscription' },
    }, outDir);
    putSecret('provider:grok-subscription', JSON.stringify({
      access_token: 'expired-access',
      refresh_token: 'shared-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 600,
    }), outDir);
    const env = { MANHWA_OUT_DIR: outDir, PATH: process.env.PATH ?? '' };

    let refreshCount = 0;
    const fetchImpl = (async () => {
      refreshCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({
        access_token: 'shared-access', refresh_token: 'shared-rotated', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      resolveGrokAccessToken(env, { fetchImpl }),
      resolveGrokAccessToken(env, { fetchImpl }),
    ]);
    expect(refreshCount).toBe(1);
    expect(a.accessToken).toBe('shared-access');
    expect(b.accessToken).toBe('shared-access');
    expect(JSON.parse(getSecret('provider:grok-subscription', outDir)!)).toMatchObject({
      access_token: 'shared-access',
      refresh_token: 'shared-rotated',
    });
  });
});

describe('review fixes: Vertex project pagination loop guard', () => {
  it('stops when the upstream repeats a page token', async () => {
    const { discoverVertexProjects } = await import('../src/config/studioConfig.js');
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        projects: [{ projectId: `p${urls.length}` }],
        nextPageToken: 'same-token',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const projects = await discoverVertexProjects('access', fetchFn);
    expect(urls).toHaveLength(2);
    expect(projects.map((p) => p.projectId)).toEqual(['p1', 'p2']);
  });
});

// ---------------------------------------------------------------------------
// Round 4 audit fixes
// ---------------------------------------------------------------------------

describe('review fixes: Vertex OAuth secret shape detection', () => {
  it('accepts snake_case and camelCase token fields and still rejects service accounts', async () => {
    const { isVertexOAuthSecret } = await import('../src/config/studioConfig.js');
    expect(isVertexOAuthSecret(JSON.stringify({ access_token: 'a' }))).toBe(true);
    expect(isVertexOAuthSecret(JSON.stringify({ accessToken: 'a' }))).toBe(true);
    expect(isVertexOAuthSecret(JSON.stringify({ refresh_token: 'r' }))).toBe(true);
    expect(isVertexOAuthSecret(JSON.stringify({ refreshToken: 'r' }))).toBe(true);
    expect(isVertexOAuthSecret(JSON.stringify({ accessToken: '  ' }))).toBe(false);
    expect(isVertexOAuthSecret(JSON.stringify({
      type: 'service_account', client_email: 'sa@project.iam.gserviceaccount.com', private_key: 'k',
    }))).toBe(false);
    expect(isVertexOAuthSecret('not-json')).toBe(false);
  });
});

describe('review fixes: external preview stdin EPIPE', () => {
  it('survives an adapter that exits before consuming a large stdin payload', async () => {
    const outDir = path.join(root, 'out');
    const catalog = path.join(root, 'epipe-tts.json');
    writeJson(catalog, { providers: [{
      id: 'epipe', engine: 'external', provider: 'epipe-upstream',
      command: [process.execPath, '-e', 'process.exit(0)'],
      preflightArgs: [],
      // Larger than a pipe buffer so the write cannot finish before the child exits.
      settings: { blob: 'x'.repeat(300_000) },
      voices: [{ id: 'v1', default: true }],
    }] });
    const env = {
      MANHWA_OUT_DIR: outDir,
      MANHWA_JOBS_DIR: path.join(outDir, 'jobs'),
      MANHWA_TTS_CATALOG: catalog,
      PATH: process.env.PATH ?? '',
    };
    const err = await generatePreview('epipe', 'v1', env as never)
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Voice preview (generation failed|produced no audio)/);
  });
});

describe('review fixes: disabled persisted lanes do not re-enable defaults', () => {
  it('keeps a lanes.json role empty when its only lane belongs to a disabled provider', async () => {
    const laneConfig = await import('../src/config/laneConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'agy',
      label: 'AGY',
      enabled: false,
      baseUrl: 'https://agy.example.com/v1',
      apiKey: 'agy-key',
    }, outDir);
    const defaults = laneConfig.getDefaultConfig();
    laneConfig.putLanesState({
      revision: 0,
      render: defaults.render,
      models: {
        vision: [{ id: 'agy:gemini-3.8-flash-low', enabled: true, concurrency: 1 }],
        writer: [{ id: 'workbuddy:deepseek-v4.1-flash', enabled: true, concurrency: 1 }],
      },
    }, 'test');
    try {
      llm._resetSnapshotForTests();
      expect(llm._activeLanes('vision')).toEqual([]);
      expect(llm._activeLanes('writer').map((lane) => `${lane.name}:${lane.model}`))
        .toEqual(['workbuddy:deepseek-v4.1-flash']);
    } finally {
      llm._resetSnapshotForTests();
    }
  });

  it('keeps a persisted stage route empty when every lane is disabled', async () => {
    const { putStagesConfig } = await import('../src/config/studioConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      enabled: false,
      protocol: 'vertex-openai',
      models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
    }, outDir);
    putStagesConfig({
      writer: { chain: ['vertex-ai:gemini-2.5-flash'], concurrency: 1, temperature: 0.2 },
    }, outDir);
    try {
      llm._resetSnapshotForTests();
      await expect(llm.call([{ role: 'user', content: 'Write one line.' }], { stage: 'writer' }))
        .rejects.toThrow(/all lanes failed/);
    } finally {
      llm._resetSnapshotForTests();
    }
  });
});

describe('review fixes: Vertex OAuth refresh persistence keeps the client fields', () => {
  it('preserves client_id, client_secret, token_uri and quota_project_id when writing the refreshed token', async () => {
    const { resolveVertexTtsCredentials } = await import('../src/llm/vertexTts.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      auth: { mode: 'vertex-oauth', projectId: 'studio-project', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({
      refresh_token: 'refresh-1',
      expires_at: 1,
      client_id: 'stored-client-id',
      client_secret: 'stored-client-secret',
      token_uri: 'https://oauth2.googleapis.com/token',
      quota_project_id: 'quota-project',
    }), outDir);
    const fetchImpl = (async () => new Response(JSON.stringify({
      access_token: 'refreshed-access', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const env = { MANHWA_OUT_DIR: outDir, PATH: process.env.PATH ?? '' };

    const creds = await resolveVertexTtsCredentials(env, { fetchImpl });
    expect(creds.accessToken).toBe('refreshed-access');
    const persisted = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(persisted).toMatchObject({
      access_token: 'refreshed-access',
      refresh_token: 'refresh-1',
      client_id: 'stored-client-id',
      client_secret: 'stored-client-secret',
      token_uri: 'https://oauth2.googleapis.com/token',
      quota_project_id: 'quota-project',
    });
    expect(persisted.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('review fixes: Google Cloud SDK remote OAuth for Vertex AI', () => {
  const SDK_REDIRECT = 'https://sdk.cloud.google.com/applicationdefaultauthcode.html';
  const SDK_CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
  const SDK_CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty';

  it('starts a remote-code flow against the Cloud SDK callback with offline consent', async () => {
    const response = await studioPost('/api/studio/oauth/pkce-start', { providerId: 'vertex-ai' });
    expect(response.status).toBe(200);
    expect(response.body.redirectUri).toBe(SDK_REDIRECT);
    const url = new URL(response.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe(SDK_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(SDK_REDIRECT);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('token_usage')).toBe('remote');
    expect(url.searchParams.get('scope')).toBe([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/sqlservice.login',
    ].join(' '));
  });

  it('exchanges the remote code with the SDK client secret and extracts the account email', async () => {
    const { getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const idToken = [
      b64({ alg: 'none', typ: 'JWT' }),
      b64({ email: 'shairukham@gmail.com', name: 'Shair Khan', sub: 'google-sub-1' }),
      'sig',
    ].join('.');
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: any) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) });
      if (String(url).includes('cloudresourcemanager.googleapis.com')) {
        return new Response(JSON.stringify({
          projects: [{ projectId: 'project-ac58', name: 'AC58', lifecycleState: 'ACTIVE' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'sdk-access', refresh_token: 'sdk-refresh', id_token: idToken,
        expires_in: 3600, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    const response = await studioPost('/api/studio/oauth/pkce-exchange', {
      providerId: 'vertex-ai',
      codeOrUrl: '4/0AY0e-g7-sdk-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.ok).toBe(true);

    const tokenCall = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.body.get('grant_type')).toBe('authorization_code');
    expect(tokenCall!.body.get('redirect_uri')).toBe(SDK_REDIRECT);
    expect(tokenCall!.body.get('client_id')).toBe(SDK_CLIENT_ID);
    expect(tokenCall!.body.get('client_secret')).toBe(SDK_CLIENT_SECRET);

    const stored = JSON.parse(getSecret('provider:vertex-ai', outDir)!);
    expect(stored).toMatchObject({
      access_token: 'sdk-access',
      refresh_token: 'sdk-refresh',
      id_token: idToken,
      client_id: SDK_CLIENT_ID,
      client_secret: SDK_CLIENT_SECRET,
    });

    const provider = getProvider('vertex-ai', outDir);
    expect(provider?.auth.accountEmail).toBe('shairukham@gmail.com');
    expect(provider?.auth.accountName).toBe('Shair Khan');
    expect(provider?.auth.accountPlan).toBe('GCP Project: project-ac58');
  });

  it('refreshes a gcloud SDK token with the shipped client secret when none is stored', async () => {
    const { resolveVertexOAuthAccessToken, VERTEX_OAUTH_DEFAULT_CLIENT_ID } =
      await import('../src/config/studioConfig.js');
    const bodies: URLSearchParams[] = [];
    const fetchFn = (async (_url: string, init: any) => {
      bodies.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 60 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await resolveVertexOAuthAccessToken(
      JSON.stringify({ refresh_token: 'r', expires_at: 1, client_id: VERTEX_OAUTH_DEFAULT_CLIENT_ID }),
      { fetchFn, nowSec: 1000 },
    );
    expect(bodies[0]!.get('client_id')).toBe(VERTEX_OAUTH_DEFAULT_CLIENT_ID);
    expect(bodies[0]!.get('client_secret')).toBe(SDK_CLIENT_SECRET);
  });
});

describe('review fixes: connected account details on ProviderAuthView', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

  it('decodes ChatGPT plan, email, name and account id from the OAuth JWT', async () => {
    const { getProvider, listProviders } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    const jwt = [
      b64({ alg: 'RS256', typ: 'JWT' }),
      b64({
        iss: 'https://auth.openai.com',
        email: 'hamimsarkar56745@gmail.com',
        name: 'Shair Khan',
        sub: 'auth0|user-1',
        'https://api.openai.com/profile': { email: 'hamimsarkar56745@gmail.com', name: 'Shair Khan' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'go',
          chatgpt_account_id: 'acct-9f8e7d',
        },
        exp: 4_000_000_000,
      }),
      'sig',
    ].join('.');
    upsertProvider({
      id: 'codex-oauth',
      preset: 'codex-oauth',
      apiKey: JSON.stringify({ access_token: jwt, refresh_token: 'refresh-1' }),
    }, outDir);

    const provider = getProvider('codex-oauth', outDir);
    expect(provider?.auth).toMatchObject({
      accountEmail: 'hamimsarkar56745@gmail.com',
      accountName: 'Shair Khan',
      accountPlan: 'ChatGPT GO',
      accountId: 'acct-9f8e7d',
      expiresAt: 4_000_000_000,
    });
    const listed = listProviders(outDir).find((p) => p.id === 'codex-oauth');
    expect(listed?.auth.accountPlan).toBe('ChatGPT GO');
  });

  it('reports a Service Account identity from the stored key JSON', async () => {
    const { getProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    upsertProvider({
      id: 'vertex-sa',
      preset: 'vertex-ai',
      serviceAccountJson: JSON.stringify({
        type: 'service_account',
        project_id: 'project-ac58',
        client_email: 'studio@project-ac58.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
      }),
    }, outDir);

    const provider = getProvider('vertex-sa', outDir);
    expect(provider?.auth.accountEmail).toBe('studio@project-ac58.iam.gserviceaccount.com');
    expect(provider?.auth.accountPlan).toBe('Service Account · project-ac58');
  });
});

/* ================================================================== *
 * Production fixes: remotion scale, telemetry stage, Vertex discovery,
 * sandbox CLI, stage reconciliation, lane snapshot authority
 * ================================================================== */

describe('review fixes: remotion render scale', () => {
  let renderRoot: string;

  beforeEach(async () => {
    const renderlane = await import('../src/workers/renderlane.js');
    renderlane._resetHooksForTests();
    renderRoot = path.join(root, 'render');
    fs.mkdirSync(renderRoot, { recursive: true });
  });

  afterEach(async () => {
    const renderlane = await import('../src/workers/renderlane.js');
    renderlane._resetHooksForTests();
    delete process.env.MANHWA_RENDER_QUALITY;
  });

  async function renderWith(propsBody: Record<string, unknown>, envQuality?: string) {
    const renderlane = await import('../src/workers/renderlane.js');
    const videoDir = path.join(renderRoot, 'ch1', 'video');
    fs.mkdirSync(videoDir, { recursive: true });
    const video = path.join(videoDir, 'video.mp4');
    const props = path.join(videoDir, 'shots.json');
    fs.writeFileSync(props, JSON.stringify(propsBody));
    if (envQuality === undefined) delete process.env.MANHWA_RENDER_QUALITY;
    else process.env.MANHWA_RENDER_QUALITY = envQuality;
    const seen: string[][] = [];
    renderlane._hooks._capfreeNode = () => null;
    renderlane._hooks.subprocess = {
      run: (args: readonly string[]) => {
        seen.push([...args]);
        fs.writeFileSync(video, 'rendered');
        return { returncode: 0, status: 0, stdout: '', stderr: '' };
      },
    } as typeof renderlane.subprocess;
    await renderlane.renderLocal(props, video);
    return seen[0]!;
  }

  it('never passes a fractional --scale: 1280x720 is already 720p', async () => {
    const args = await renderWith({ quality: '720p' });
    expect(args.some((a) => a.startsWith('--scale'))).toBe(false);
  });

  it('upscales by an exact 1.5x only when 1080p is requested in props', async () => {
    const args = await renderWith({ quality: '1080p' });
    expect(args).toContain('--scale=1.5');
  });

  it('honours the MANHWA_RENDER_QUALITY env override for 1080p', async () => {
    const args = await renderWith({}, '1080p');
    expect(args).toContain('--scale=1.5');
  });

  it('keeps the offline props {} argv free of --scale', async () => {
    const args = await renderWith({});
    expect(args.some((a) => a.startsWith('--scale'))).toBe(false);
    expect(args.slice(0, 5)).toEqual(['npx', 'remotion', 'render', 'src/index.ts', 'Recap']);
  });
});

describe('review fixes: telemetry failure marks the active stage', () => {
  let statusDir: string;

  beforeEach(async () => {
    const telemetry = await import('../src/telemetry/telemetry.js');
    telemetry._reset();
    statusDir = path.join(root, 'status');
    fs.mkdirSync(statusDir, { recursive: true });
    vi.stubEnv('PIPELINE_STATUS_DIR', statusDir);
    vi.stubEnv('PIPELINE_LOG', path.join(root, 'pipeline.log'));
    telemetry.start('telemetry-series', ['ch1'], true);
  });

  afterEach(async () => {
    const telemetry = await import('../src/telemetry/telemetry.js');
    telemetry._reset();
  });

  it('fails render, not the already-done audio stage, when called outside run()', async () => {
    const telemetry = await import('../src/telemetry/telemetry.js');
    telemetry.stage('ch1', 'audio', 'done');
    telemetry.stage('ch1', 'clean', 'done');
    telemetry.stage('ch1', 'timeline', 'done');
    telemetry.stage('ch1', 'render', 'running');

    telemetry.failed('ch1', new TypeError('height must be an integer'));

    const stages = telemetry._data()!.chapters.ch1!.stages;
    expect(stages.render!.state).toBe('failed');
    expect(stages.audio!.state).toBe('done');
    expect(stages.timeline!.state).toBe('done');
    expect(stages.render!.note).toBe('TypeError');
  });

  it('falls back to the context stage when no stage is running', async () => {
    const telemetry = await import('../src/telemetry/telemetry.js');
    telemetry.bind({ chapter: 'ch1' });
    telemetry.stage('ch1', 'reader', 'running');
    telemetry.failed('ch1', new Error('boom'));
    const stages = telemetry._data()!.chapters.ch1!.stages;
    expect(stages.reader!.state).toBe('failed');
  });
});

describe('review fixes: Vertex AI probe and discovery', () => {
  async function seedVertex(outDir: string) {
    const { upsertProvider } = await import('../src/config/studioConfig.js');
    upsertProvider({
      id: 'vertex-ai',
      preset: 'vertex-ai',
      protocol: 'vertex-openai',
      auth: { mode: 'vertex-oauth', projectId: 'project-ac58', secretRef: 'provider:vertex-ai' },
    }, outDir);
    putSecret('provider:vertex-ai', JSON.stringify({ access_token: 'vertex-access-token' }), outDir);
  }

  it('prefixes google/ on the inference probe for vertex-openai', async () => {
    const { probeProviderInference } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    await seedVertex(outDir);
    const bodies: any[] = [];
    const result = await probeProviderInference('vertex-ai', {
      outDir,
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(bodies[0]!.model).toBe('google/gemini-4-argon');
  });

  it('falls back to the catalog when /models 404s but inference works', async () => {
    const { discoverProviderModels, PROVIDER_PRESETS } =
      await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    await seedVertex(outDir);
    const urls: string[] = [];
    const models = await discoverProviderModels('vertex-ai', {
      outDir,
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        if (String(url).includes('/models')) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(urls[0]).toContain('/models');
    expect(urls.some((u) => u.endsWith('/chat/completions'))).toBe(true);
    expect(models.map((m) => m.id)).toEqual(
      PROVIDER_PRESETS['vertex-ai']!.defaultModels.map((m) => m.id),
    );
  });

  it('still fails discovery when the probe also fails', async () => {
    const { discoverProviderModels } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    await seedVertex(outDir);
    await expect(discoverProviderModels('vertex-ai', {
      outDir,
      fetchFn: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    })).rejects.toThrow(/HTTP 404/);
  });
});

describe('review fixes: sandbox CLI creation and listing', () => {
  it('creates a base sandbox with an agent subcommand and reports stderr on failure', async () => {
    const cloudlane = await import('../src/workers/cloudlane.js');
    const nodeRegistry = await import('../src/workers/nodeRegistry.js');
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx', stderr: '' };
      return { status: 0, stdout: '{"sandboxes":[]}', stderr: '' };
    });
    const calls: string[][] = [];
    const runner: import('../src/workers/cloudlane.js').ProcessRunner = (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'tar') {
        fs.writeFileSync(args[2] as string, 'archive');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[2] === 'ls') return { status: 0, stdout: JSON.stringify({ sandboxes: [] }), stderr: '' };
      if (args[2] === 'create') {
        // The real CLI rejects a create without a command when --template is absent.
        if (args.includes('--template')) {
          return { status: 1, stdout: '', stderr: 'template missing-template not found' };
        }
        if (!args.includes('shell')) {
          return { status: 1, stdout: '', stderr: 'error: create requires a command (try `shell`)' };
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[2] === 'exec' && String(args[6]).includes('printf')) {
        return { status: 0, stdout: '{"cpus":8,"mem_gb":16,"disk_gb":40,"ffmpeg":true,"studio":true,"miss":""}\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    cloudlane._setRunnerForTests(runner);
    const outDir = path.join(root, 'out');
    writeJson(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1,
      revision: 1,
      nodes: [{
        id: 'sbx-fresh', label: 'Fresh', kind: 'docker-sbx', enabled: true, slots: 2,
        supportsCleaner: true, box: 'sbx-fresh', template: 'missing-template', remoteDir: '/tmp/manhwa-cloud/studio',
      }],
    });
    const res = nodeRegistry.runNodeAction('sbx-fresh', 'provision', { outDir });
    expect(res.ok, res.detail).toBe(true);
    expect(calls.some((args) => args[2] === 'create' && !args.includes('--template') && args.includes('shell'))).toBe(true);
    cloudlane._setRunnerForTests(null);
    nodeRegistry._setLocalRunnerForTests(null);
  });

  it('includes the CLI stderr tail in a failed nodeRun message', async () => {
    const cloudlane = await import('../src/workers/cloudlane.js');
    const node = cloudlane.createCloudNode(
      { id: 'sbx-err', box: 'sbx-err', template: 'tmpl' },
      () => ({ status: 1, stdout: '', stderr: 'error: boom detail' }),
      { allowControl: true },
    );
    const res = node.create();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('rc=1');
    expect(res.detail).toContain('boom detail');
  });

  it('parses sandboxes from `sbx ls --json` into the auth status', async () => {
    const nodeRegistry = await import('../src/workers/nodeRegistry.js');
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx', stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify({
          sandboxes: [{ name: 'manhwa-box-1', id: 'bx_1', status: 'running', cpus: 8, memory_mib: 16384 }],
        }),
        stderr: '',
      };
    });
    const status = nodeRegistry.sandboxAuthStatus();
    expect(status.sandboxes).toEqual([
      { name: 'manhwa-box-1', id: 'bx_1', status: 'running', cpus: 8, memoryMib: 16384 },
    ]);
    const outDir = path.join(root, 'out');
    nodeRegistry.registerNodeForRuntime(
      { id: 'sbx-1', label: 'Cloud Sandbox', kind: 'docker-sbx', enabled: true, slots: 2, box: 'manhwa-box-1' },
      outDir,
    );
    const action = nodeRegistry.runNodeAction('sbx-1', 'auth-status', { outDir });
    expect((action.probe as any)?.sandboxes?.[0]?.name).toBe('manhwa-box-1');
    nodeRegistry.removeNodeFromRuntime('sbx-1');
    nodeRegistry._setLocalRunnerForTests(null);
  });

  it('returns sandboxes from GET /api/studio/sbx/auth', async () => {
    const nodeRegistry = await import('../src/workers/nodeRegistry.js');
    nodeRegistry._setLocalRunnerForTests((args) => {
      if (String(args[2]).includes('command -v sbx')) return { status: 0, stdout: '/usr/local/bin/sbx', stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify({ sandboxes: [{ name: 'manhwa-box-1', id: 'bx_1', status: 'stopped' }] }),
        stderr: '',
      };
    });
    const req = Readable.from([]) as IncomingMessage;
    req.method = 'GET';
    req.headers = { host: 'studio.local' };
    let result!: { status: number; body: any };
    const pathname = '/api/studio/sbx/auth';
    await handleStudioRoute(req, {} as ServerResponse, pathname, new URL(pathname, 'http://studio.local'), {
      user: 'review-admin', exp: Date.now() + 60_000, isTemp: false, privileged: true, csrfToken: 'review-csrf',
    }, (_res, status, response) => { result = { status, body: response }; });
    expect(result.status).toBe(200);
    expect(result.body.sandboxes).toEqual([
      { name: 'manhwa-box-1', id: 'bx_1', status: 'stopped' },
    ]);
    nodeRegistry._setLocalRunnerForTests(null);
  });

  it('lets an admin Start/Stop a sandbox through the node action route', async () => {
    const cloudlane = await import('../src/workers/cloudlane.js');
    const nodeRegistry = await import('../src/workers/nodeRegistry.js');
    const outDir = path.join(root, 'out');
    writeJson(path.join(outDir, 'config', 'render-nodes.json'), {
      schemaVersion: 1,
      revision: 1,
      nodes: [{
        id: 'sbx-1', label: 'Cloud Sandbox', kind: 'docker-sbx', enabled: true, slots: 2,
        supportsCleaner: true, box: 'manhwa-box-1', template: 'manhwa-render-arm',
      }],
    });
    const calls: string[][] = [];
    cloudlane._setRunnerForTests((args) => {
      calls.push([...args]);
      return { status: 0, stdout: '', stderr: '' };
    });
    nodeRegistry.registerNodeForRuntime({ id: 'sbx-1', label: 'Cloud Sandbox', kind: 'docker-sbx', enabled: true, slots: 2, box: 'manhwa-box-1' }, outDir);
    const res = await studioPost('/api/studio/nodes/sbx-1/action', { action: 'stop' });
    expect(res.status).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(calls.some((args) => args[2] === 'stop' && args[3] === 'manhwa-box-1')).toBe(true);
    cloudlane._setRunnerForTests(null);
    nodeRegistry.removeNodeFromRuntime('sbx-1');
  });
});

describe('review fixes: status probe lists configured sandbox nodes', () => {
  it('adds enabled docker-sbx nodes from render-nodes.json to status.workers', async () => {
    const statusProbe = await import('../src/telemetry/statusProbe.js');
    const statusDir = path.join(root, 'out', 'status');
    fs.mkdirSync(statusDir, { recursive: true });
    writeJson(path.join(root, 'out', 'config', 'render-nodes.json'), {
      schemaVersion: 1,
      revision: 1,
      nodes: [
        { id: 'sbx-1', label: 'Cloud Sandbox', kind: 'docker-sbx', enabled: true, slots: 2, box: 'manhwa-box-1' },
        { id: 'sbx-off', label: 'Off', kind: 'docker-sbx', enabled: false, slots: 1, box: 'off-box' },
        { id: 'local', label: 'Local', kind: 'local', enabled: true, slots: 1 },
      ],
    });
    writeJson(path.join(root, 'out', 'cloud-list.json'), {
      at: 1, name: 'manhwa-box-1', box: { name: 'manhwa-box-1', status: 'running', cpus: 8, memory_mib: 16384 },
    });
    const snap = statusProbe.collectStatus({
      root: path.join(root, 'out'),
      series: path.join(root, 'series'),
      log: path.join(root, 'out', 'pipeline.log'),
      status: statusDir,
      now: 100,
      procs: {},
      listSandbox: () => [null, 'sandbox not found'],
    });
    const ids = (snap.workers as any[]).map((w) => w.id);
    expect(ids).toContain('sbx-1');
    expect(ids).not.toContain('sbx-off');
    const row = (snap.workers as any[]).find((w) => w.id === 'sbx-1');
    expect(row).toMatchObject({ kind: 'cloud', status: 'idle', available: true, boxStatus: 'running' });
  });
});

describe('review fixes: stages.json reconciliation after provider changes', () => {
  function seedProvider(outDir: string, id: string, models: string[], preset?: string) {
    upsertProvider({
      id,
      label: id,
      protocol: 'openai-compatible',
      baseUrl: `https://${id}.example/v1`,
      apiKey: `${id}-key`,
      ...(preset ? { preset } : {}),
      // Declare both roles: reconciliation must never route a vision stage to
      // a model without the capability, so the seed has to state it.
      models: models.map((m) => ({
        id: m,
        label: m,
        enabled: true,
        capabilities: { vision: true, writer: true, json: true, reasoning: false, streaming: false, tts: false },
      })),
    }, outDir);
  }

  it('replaces a removed model with the first compatible model on the same provider', async () => {
    const { getStagesConfig, putStagesConfig, deleteProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    seedProvider(outDir, 'alpha', ['vision-a', 'vision-b']);
    putStagesConfig({
      stages: {
        reader: { chain: ['alpha:gone-model'], concurrency: 1, temperature: 0.2, inheritFrom: null },
        writer: { chain: ['alpha:vision-a'], concurrency: 1, temperature: 0.7, inheritFrom: null },
      },
    }, outDir);

    deleteProvider('nope', outDir); // no-op: stages untouched
    const untouched = getStagesConfig(outDir);
    expect(untouched.reader.chain).toEqual(['alpha:gone-model']);

    seedProvider(outDir, 'alpha', ['vision-a', 'vision-b']); // triggers reconcile
    const after = getStagesConfig(outDir);
    expect(after.reader.chain).toEqual(['alpha:vision-a']);
    expect(after.reader.primary).toBe('alpha:vision-a');
    expect(after.reader.fallbacks).toEqual([]);
  });

  it('falls back to another enabled provider when the provider is deleted', async () => {
    const { getStagesConfig, putStagesConfig, deleteProvider } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    seedProvider(outDir, 'alpha', ['vision-a']);
    upsertProvider({
      id: 'beta',
      label: 'beta',
      protocol: 'openai-compatible',
      baseUrl: 'https://beta.example/v1',
      apiKey: 'beta-key',
      models: [
        { id: 'vision-b', label: 'vision-b', enabled: true, capabilities: { vision: true, writer: false, json: true, reasoning: false, streaming: false, tts: false } },
        { id: 'writer-b', label: 'writer-b', enabled: true, capabilities: { vision: false, writer: true, json: true, reasoning: false, streaming: false, tts: false } },
      ],
    }, outDir);
    putStagesConfig({
      stages: {
        reader: { chain: ['alpha:vision-a'], concurrency: 1, temperature: 0.2, inheritFrom: null },
        writer: { chain: ['alpha:vision-a'], concurrency: 1, temperature: 0.7, inheritFrom: null },
      },
    }, outDir);

    deleteProvider('alpha', outDir);
    const after = getStagesConfig(outDir);
    expect(after.reader.chain).toEqual(['beta:vision-b']);
    expect(after.writer.chain).toEqual(['beta:writer-b']);
  });

  it('leaves CLI bridge lanes (agy/workbuddy/opencode) untouched', async () => {
    const { getStagesConfig, putStagesConfig } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    putStagesConfig({
      stages: {
        reader: { chain: ['agy:gemini-3.8-flash-low', 'opencode:mimo-v2.5-free'], concurrency: 1, temperature: 0.2, inheritFrom: null },
      },
    }, outDir);
    seedProvider(outDir, 'alpha', ['vision-a']);
    expect(getStagesConfig(outDir).reader.chain).toEqual([
      'agy:gemini-3.8-flash-low', 'opencode:mimo-v2.5-free',
    ]);
  });

  it('deduplicates chains and re-derives primary/fallbacks', async () => {
    const { getStagesConfig, putStagesConfig } = await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    seedProvider(outDir, 'alpha', ['vision-a']);
    putStagesConfig({
      stages: {
        reader: {
          chain: ['alpha:vision-a', 'alpha:gone', 'alpha:vision-a'],
          concurrency: 1, temperature: 0.2, inheritFrom: null,
        },
      },
    }, outDir);
    seedProvider(outDir, 'alpha', ['vision-a']);
    const after = getStagesConfig(outDir);
    expect(after.reader.chain).toEqual(['alpha:vision-a']);
    expect(after.reader.primary).toBe('alpha:vision-a');
    expect(after.reader.fallbacks).toEqual([]);
  });

  it('does not write stages.json when no provider is configured', async () => {
    const { reconcileStagesWithProviders, getStagesConfig, putStagesConfig } =
      await import('../src/config/studioConfig.js');
    const outDir = path.join(root, 'out');
    putStagesConfig({
      stages: { reader: { chain: ['agy:gemini-3.8-flash-low'], concurrency: 1, temperature: 0.2, inheritFrom: null } },
    }, outDir);
    const before = getStagesConfig(outDir);
    reconcileStagesWithProviders(outDir);
    const after = getStagesConfig(outDir);
    expect(after.revision).toBe(before.revision);
  });
});

describe('review fixes: lane snapshot prefers persisted stages.json', () => {
  it('resolves LANES.vision/writer from stages.json over a stale lanes.json', async () => {
    const studio = await import('../src/config/studioConfig.js');
    const laneConfig = await import('../src/config/laneConfig.js');
    const llm = await import('../src/llm/client.js');
    const outDir = path.join(root, 'out');
    // Persisted lanes.json points at an old provider/model.
    // A stale lanes.json written by hand: its catalog ids no longer resolve, so
    // laneConfig reports `invalid_persisted` and stages.json must win.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, laneConfig.LANE_CONFIG_FILENAME), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      models: {
        vision: [{ id: 'old:old-vision', enabled: true, concurrency: 1 }],
        writer: [{ id: 'old:old-writer', enabled: true, concurrency: 1 }],
      },
      render: laneConfig.getDefaultConfig().render,
    }));

    upsertProvider({
      id: 'new',
      label: 'new',
      protocol: 'openai-compatible',
      baseUrl: 'https://new.example/v1',
      apiKey: 'new-key',
      models: [
        { id: 'new-vision', label: 'new-vision', enabled: true, capabilities: { vision: true, writer: false, json: true, reasoning: false, streaming: false, tts: false } },
        { id: 'new-writer', label: 'new-writer', enabled: true, capabilities: { vision: false, writer: true, json: true, reasoning: false, streaming: false, tts: false } },
      ],
    }, outDir);

    // stages.json is newer than lanes.json.
    const future = Date.now() + 60_000;
    fs.writeFileSync(path.join(outDir, 'config', 'stages.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: future,
      updatedBy: 'admin',
      stages: {
        reader: { stage: 'reader', chain: ['new:new-vision'], primary: 'new:new-vision', fallbacks: [], concurrency: 1, temperature: 0.2, inheritFrom: null },
        writer: { stage: 'writer', chain: ['new:new-writer'], primary: 'new:new-writer', fallbacks: [], concurrency: 1, temperature: 0.7, inheritFrom: null },
      },
    }));

    vi.stubEnv('MANHWA_OUT_DIR', outDir);
    const prevLane = process.env.MANHWA_LANE_CONFIG;
    const prevLaneDir = process.env.MANHWA_LANE_CONFIG_DIR;
    delete process.env.MANHWA_LANE_CONFIG;
    delete process.env.MANHWA_LANE_CONFIG_DIR;
    try {
      llm._resetSnapshotForTests();
      const resolved = llm._resolveSnapshot();
      expect(resolved.source).toBe('persisted');
      expect(resolved.lanes.vision.map((l) => `${l.provider}:${l.model}`)).toEqual(['new:new-vision']);
      expect(resolved.lanes.writer.map((l) => `${l.provider}:${l.model}`)).toEqual(['new:new-writer']);
    } finally {
      if (prevLane !== undefined) process.env.MANHWA_LANE_CONFIG = prevLane;
      if (prevLaneDir !== undefined) process.env.MANHWA_LANE_CONFIG_DIR = prevLaneDir;
      llm._resetSnapshotForTests();
    }
  });
});
