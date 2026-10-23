/**
 * Backend audit fixes: Docker first-run setup reachability and extensionless
 * SPA routes.
 *
 * Env is stubbed before the dynamic import because `server.ts` captures
 * PLAYER_HTPASSWD at module load.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TMP_ROOT = '/tmp/opencode';

describe('player routes and setup reachability', () => {
  let root: string;
  let server: import('node:http').Server;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'player-routes-'));
    vi.stubEnv('PLAYER_HTPASSWD', path.join(root, 'users'));
    vi.stubEnv('PLAYER_SECRET_FILE', path.join(root, 'secret'));
    vi.stubEnv('PLAYER_TEMP_USERS', path.join(root, 'temp-users'));
    vi.stubEnv('PLAYER_PUBLIC', path.resolve('src/player/public'));
    vi.stubEnv('MANHWA_OUT_DIR', path.join(root, 'out'));
    vi.stubEnv('MANHWA_SERIES_ROOT', path.join(root, 'series'));
    vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
    delete process.env.PLAYER_API_ONLY;

    const mod = await import('../src/player/server.js');
    fs.writeFileSync(path.join(root, 'users'), `admin:${mod.apr1('test-password', 'fixture')}\n`);
    server = mod.createPlayerServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'admin', pass: 'test-password' }),
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['/status', 'status.html'],
    ['/meter', 'meter.html'],
    ['/settings', 'studio.html'],
    ['/new-series', 'new-series.html'],
  ])('serves extensionless %s as %s', async (route, file) => {
    const res = await fetch(`${base}${route}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    const expected = fs.readFileSync(path.resolve('src/player/public', file), 'utf8');
    expect(body).toBe(expected);
  });

  it('still serves the dotted routes unchanged', async () => {
    const res = await fetch(`${base}/status.html`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('Docker first-run setup reachability', () => {
  let root: string;

  beforeAll(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'setup-open-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens setup on the default container secret path when no user exists', async () => {
    const setup = await import('../src/player/setup.js');
    const previous = {
      htpasswd: process.env.PLAYER_HTPASSWD,
      mode: process.env.MANHWA_SETUP_MODE,
      out: process.env.MANHWA_OUT_DIR,
    };
    process.env.PLAYER_HTPASSWD = '/run/secrets/player_htpasswd';
    process.env.MANHWA_OUT_DIR = path.join(root, 'out-open');
    delete process.env.MANHWA_SETUP_MODE;
    try {
      expect(fs.existsSync(setup.setupCompleteMarkerPath())).toBe(false);
      expect(setup.isSetupOpen()).toBe(true);
      // A completed marker still closes it.
      fs.mkdirSync(path.dirname(setup.setupCompleteMarkerPath()), { recursive: true });
      fs.writeFileSync(setup.setupCompleteMarkerPath(), '{}\n');
      expect(setup.isSetupOpen()).toBe(false);
    } finally {
      if (previous.htpasswd === undefined) delete process.env.PLAYER_HTPASSWD;
      else process.env.PLAYER_HTPASSWD = previous.htpasswd;
      if (previous.mode === undefined) delete process.env.MANHWA_SETUP_MODE;
      else process.env.MANHWA_SETUP_MODE = previous.mode;
      if (previous.out === undefined) delete process.env.MANHWA_OUT_DIR;
      else process.env.MANHWA_OUT_DIR = previous.out;
    }
  });

  it('keeps a custom PLAYER_HTPASSWD path fail-closed without MANHWA_SETUP_MODE=1', async () => {
    const setup = await import('../src/player/setup.js');
    const previous = {
      htpasswd: process.env.PLAYER_HTPASSWD,
      mode: process.env.MANHWA_SETUP_MODE,
      out: process.env.MANHWA_OUT_DIR,
    };
    process.env.PLAYER_HTPASSWD = path.join(root, 'custom-users');
    process.env.MANHWA_OUT_DIR = path.join(root, 'out-custom');
    delete process.env.MANHWA_SETUP_MODE;
    try {
      expect(setup.isSetupOpen()).toBe(false);
      process.env.MANHWA_SETUP_MODE = '1';
      expect(setup.isSetupOpen()).toBe(true);
    } finally {
      if (previous.htpasswd === undefined) delete process.env.PLAYER_HTPASSWD;
      else process.env.PLAYER_HTPASSWD = previous.htpasswd;
      if (previous.mode === undefined) delete process.env.MANHWA_SETUP_MODE;
      else process.env.MANHWA_SETUP_MODE = previous.mode;
      if (previous.out === undefined) delete process.env.MANHWA_OUT_DIR;
      else process.env.MANHWA_OUT_DIR = previous.out;
    }
  });
});
