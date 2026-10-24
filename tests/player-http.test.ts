import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';

vi.mock('../src/player/status.js', () => ({
  pipelineStatus: async () => { throw new Error('private diagnostic detail'); },
}));

describe('separated backend HTTP boundary', () => {
  let root: string;
  let server: http.Server;
  let base: string;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-http-'));
    vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
    vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
    vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
    vi.stubEnv('PLAYER_API_ONLY', '1');
    vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series'));
    vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
    vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
    vi.stubEnv('MANHWA_JOBS_DIR', path.join(root, 'out', 'jobs'));
    const mod = await import('../src/player/server.js');
    fs.writeFileSync(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
    server = mod.createPlayerServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'test-password' }), redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('set-cookie')).toContain('Secure');
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers health without authentication and protects sessions', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/session`)).status).toBe(401);
    const session = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(session.headers.get('cache-control')).toBe('no-store');
    expect(await session.json()).toMatchObject({ user: 'admin', privileged: true, csrfToken: csrf });
  });

  it('does not serve frontend assets in API-only mode', async () => {
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/app.js`, { headers: { cookie } })).status).toBe(404);
  });

  it('contains malformed URL and cookie encodings', async () => {
    expect((await fetch(`${base}/%ZZ`)).status).toBe(400);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: 'sr_session=%ZZ' } })).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('maps asynchronous route failures to safe JSON with a request id', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${base}/api/status`, { headers: { cookie } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'server error', requestId: response.headers.get('x-request-id') });
    } finally {
      log.mockRestore();
    }
  });

  it('rejects malformed and non-object JSON without losing the connection', async () => {
    for (const body of ['{', 'null', '[]']) {
      const response = await fetch(`${base}/api/intake/jobs`, {
        method: 'POST', headers: { cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it('passes card animation from a Drive job request into the queued job, and rejects an invalid one', async () => {
    const post = (body: unknown) => fetch(`${base}/api/intake/jobs`, {
      method: 'POST', headers: { cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const base_ = { sourceType: 'gdrive', gdriveUrl: `https://drive.google.com/file/d/ANIM${Date.now()}x${process.pid}/view`, title: `Anim Demo ${Date.now()}` };
    const ok = await post({ ...base_, animation: { entry: 'fade', pushIn: 'strong' } });
    if (ok.status !== 201) throw new Error(`status ${ok.status}: ${await ok.text()}`);
    const job = await ok.json() as { id: string; visuals?: { motion?: string; animation?: unknown } };
    expect(job.visuals?.animation).toEqual({ entry: 'fade', pushIn: 'strong' });
    expect(job.visuals?.motion).toBe('window');
    const bad = await post({ ...base_, gdriveUrl: `https://drive.google.com/file/d/ANIMBAD${Date.now()}x${process.pid}/view`, title: `Anim Bad ${Date.now()}`, animation: { entry: 'spin' } });
    expect(bad.status).toBe(400);
  });

  it('returns 413 for an oversized chunked body instead of resetting the socket', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/intake/jobs`, {
        method: 'POST', headers: { cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write(' '.repeat(17000));
      req.end();
    });
    expect(status).toBe(413);
  });
});

describe('shared media streaming', () => {
  let root: string;
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-http-'));
    fs.writeFileSync(path.join(root, 'clip'), '0123456789');
    const { streamFile } = await import('../src/player/stream.js');
    server = http.createServer((req, res) => {
      void streamFile(req, res, path.join(root, req.url === '/missing' ? 'missing' : 'clip'), 'video/mp4');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('supports seeking, suffix ranges, HEAD, and unsatisfiable ranges', async () => {
    const partial = await fetch(base, { headers: { Range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');
    expect(await (await fetch(base, { headers: { Range: 'bytes=-3' } })).text()).toBe('789');
    expect((await fetch(base, { headers: { Range: 'bytes=20-' } })).status).toBe(416);
    const head = await fetch(base, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });
});

describe('browser API transport', () => {
  const source = fs.readFileSync(new URL('../src/player/public/api.js', import.meta.url), 'utf8');
  function transport(fetchImpl: typeof fetch) {
    const assign = vi.fn();
    const context = vm.createContext({ window: {}, fetch: fetchImpl, AbortSignal, Response, location: { assign } });
    vm.runInContext(source, context);
    return { request: context.window.apiFetch, assign };
  }
  it('normalizes gateway HTML and never retries mutations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const { request } = transport(fetchImpl);
    const response = await request('/api/intake/jobs', { method: 'POST' });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('HTTP 502');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });
  it('redirects expired sessions and rejects rather than returning login HTML', async () => {
    const { request, assign } = transport(vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(request('/api/session')).rejects.toThrow('session expired');
    expect(assign).toHaveBeenCalledWith('/login');
  });
});

it('never falls back to cached session data in the service worker', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const cached = vi.fn(() => { throw new Error('API must not access cache'); });
  const offlineFetch = vi.fn().mockRejectedValue(new Error('offline'));
  const context = vm.createContext({
    self: { addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; } },
    location: { origin: 'https://player.test' }, URL, fetch: offlineFetch,
    caches: { match: cached, open: cached },
  });
  vm.runInContext(fs.readFileSync(new URL('../src/player/public/sw.js', import.meta.url), 'utf8'), context);
  let response: Promise<Response> | undefined;
  handlers.fetch!({
    request: new Request('https://player.test/api/session'),
    respondWith: (result: Promise<Response>) => { response = result; },
  });
  await expect(response).rejects.toThrow('offline');
  expect(cached).not.toHaveBeenCalled();
  expect(offlineFetch.mock.calls[0]![1]).toEqual({ cache: 'no-store' });
});
