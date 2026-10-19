/**
 * Deep integration and negative/characterization test suite for:
 *   1. Player HTTP API / frontend-backend boundary / auth / temp-users / CSRF /
 *      upload stream limits / zip validation / media range streaming / service worker
 *   2. Cloud renderer (`cloudlane.ts`), render lane scheduler (`renderlane.ts`),
 *      render policy (`renderPolicy.ts`), and status collector (`statusProbe.ts`)
 *   3. Read-only deployment capability verification (host & Podman images)
 *
 * All tests use isolated temporary directories under /tmp/opencode and injected
 * process runners. No live cloud resources or paid provider APIs are started or mutated.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';

import * as cloudlane from '../src/workers/cloudlane.js';
import * as lappy from '../src/workers/lappy.js';
import * as renderlane from '../src/workers/renderlane.js';
import * as renderPolicy from '../src/config/renderPolicy.js';
import * as laneConfig from '../src/config/laneConfig.js';
import * as statusProbe from '../src/telemetry/statusProbe.js';
import * as telemetry from '../src/telemetry/telemetry.js';
import * as voicePreview from '../src/intake/voicePreview.js';
import * as intake from '../src/intake/intake.js';
import { acquireSharedSeriesLock, releaseSharedSeriesLock } from '../src/locks/seriesLock.js';

const TMP_BASE = '/tmp/opencode';

function makeTmpDir(prefix: string): string {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_BASE, prefix));
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Build a valid minimal chapter ZIP archive in memory (1x1 PNG in ch1/001.png). */
function buildMinimalChapterZipBuffer(chapterDir = 'ch1', pageName = '001.png'): Buffer {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const zip = new AdmZip();
  zip.addFile(`${chapterDir}/${pageName}`, png1x1);
  return zip.toBuffer();
}

/* ========================================================================== *
 * PART 1: HTTP API, Auth, Temp Users, CSRF, Uploads, Streams, Service Worker
 * ========================================================================== */

describe('Part 1: HTTP API, Auth, Temp Users, CSRF, Uploads & Media Streaming', () => {
  let root: string;
  let htpasswdPath: string;
  let secretPath: string;
  let tempUsersPath: string;
  let seriesRoot: string;
  let jobsRoot: string;
  let thumbsRoot: string;
  let logPath: string;
  let lanesPath: string;
  let serverMod: typeof import('../src/player/server.js');
  let server: http.Server;
  let base: string;

  let adminCookie: string;
  let adminCsrf: string;
  let viewerCookie: string;
  let viewerCsrf: string;

  beforeAll(async () => {
    root = makeTmpDir('deep-api-http-');
    htpasswdPath = path.join(root, 'player.htpasswd');
    secretPath = path.join(root, 'session.key');
    tempUsersPath = path.join(root, 'temp-users.json');
    seriesRoot = path.join(root, 'series');
    jobsRoot = path.join(root, 'out', 'jobs');
    thumbsRoot = path.join(root, 'thumbnails');
    logPath = path.join(root, 'out', 'pipeline.log');
    lanesPath = path.join(root, 'out', 'lanes.json');

    fs.mkdirSync(seriesRoot, { recursive: true });
    fs.mkdirSync(jobsRoot, { recursive: true });
    fs.mkdirSync(thumbsRoot, { recursive: true });

    vi.stubEnv('PLAYER_HTPASSWD', htpasswdPath);
    vi.stubEnv('PLAYER_SECRET_FILE', secretPath);
    vi.stubEnv('PLAYER_TEMP_USERS', tempUsersPath);
    vi.stubEnv('PLAYER_API_ONLY', '0');
    vi.stubEnv('PLAYER_COOKIE_SECURE', 'false');
    vi.stubEnv('MANHWA_SERIES_ROOT', seriesRoot);
    vi.stubEnv('MANHWA_JOBS_DIR', jobsRoot);
    vi.stubEnv('MANHWA_THUMBS_ROOT', thumbsRoot);
    vi.stubEnv('PIPELINE_LOG', logPath);
    vi.stubEnv('MANHWA_LANE_CONFIG', lanesPath);
    vi.stubEnv('MANHWA_NO_AUTO_WORKER', '1');
    vi.stubEnv('MANHWA_MAX_ZIP_BYTES', String(64 * 1024)); // 64 KiB cap for fast limit tests

    vi.resetModules();
    serverMod = await import('../src/player/server.js');

    const now = Date.now();
    fs.writeFileSync(
      htpasswdPath,
      [
        `admin:${serverMod.apr1('admin-pass', 'saltadmn')}`,
        `viewer:${serverMod.apr1('viewer-pass', 'saltview')}`,
        `expired:${serverMod.apr1('expired-pass', 'saltexpr')}`,
        `dot.user:${serverMod.apr1('dot-pass', 'saltdotu')}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    fs.writeFileSync(
      tempUsersPath,
      JSON.stringify({
        viewer: now + 3600 * 1000,
        expired: now - 10_000,
      }),
      'utf8',
    );

    server = serverMod.createPlayerServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Sign in persistent admin
    const adminLogin = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'admin', pass: 'admin-pass' }),
      redirect: 'manual',
    });
    expect(adminLogin.status).toBe(303);
    adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0]!;
    const adminSess = (await (
      await fetch(`${base}/api/session`, { headers: { cookie: adminCookie } })
    ).json()) as { user: string; privileged: boolean; csrfToken: string };
    expect(adminSess).toMatchObject({ user: 'admin', privileged: true });
    adminCsrf = adminSess.csrfToken;

    // Sign in temporary viewer
    const viewerLogin = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'viewer', pass: 'viewer-pass' }),
      redirect: 'manual',
    });
    expect(viewerLogin.status).toBe(303);
    viewerCookie = viewerLogin.headers.get('set-cookie')!.split(';')[0]!;
    const viewerSess = (await (
      await fetch(`${base}/api/session`, { headers: { cookie: viewerCookie } })
    ).json()) as { user: string; privileged: boolean; csrfToken: string };
    expect(viewerSess).toMatchObject({ user: 'viewer', privileged: false });
    viewerCsrf = viewerSess.csrfToken;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmrf(root);
  });

  it('serves GET and HEAD /healthz publicly with X-Request-ID and Cache-Control: no-store', async () => {
    const getRes = await fetch(`${base}/healthz`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getRes.headers.get('cache-control')).toBe('no-store');
    expect(await getRes.json()).toEqual({ status: 'ok' });

    const headRes = await fetch(`${base}/healthz`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe('');
  });

  it('enforces login credentials, rejects expired temp accounts, and caps login body at 4096 bytes', async () => {
    const badLogin = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'admin', pass: 'wrong-pass' }),
      redirect: 'manual',
    });
    expect(badLogin.status).toBe(401);
    expect(await badLogin.text()).toContain('Wrong username or password');

    const expiredLogin = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'expired', pass: 'expired-pass' }),
      redirect: 'manual',
    });
    expect(expiredLogin.status).toBe(401);

    const oversizedLogin = await fetch(`${base}/login`, {
      method: 'POST',
      body: `user=admin&pass=${'a'.repeat(5000)}`,
      redirect: 'manual',
    });
    expect(oversizedLogin.status).toBe(413);
    const oversizedJson = (await oversizedLogin.json()) as { error: string; requestId: string };
    expect(oversizedJson.error).toContain('Login request body too large');
    expect(oversizedJson.requestId).toBeTruthy();
  });

  it('rejects forged, expired, outliving-temp-expiry, or removed-user cookies on /api/session', async () => {
    const forgedSig = `${adminCookie.slice(0, -4)}ffff`;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: forgedSig } })).status).toBe(401);

    // Cookie whose exp is in the past
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    const pastExp = Date.now() - 5000;
    const pastSig = crypto.createHmac('sha256', secret).update(`admin.${pastExp}`).digest('hex');
    const pastCookie = `sr_session=${encodeURIComponent(`admin.${pastExp}.${pastSig}`)}`;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: pastCookie } })).status).toBe(401);

    // Temp user cookie whose exp outlives temp-users.json expiry
    const outliveExp = Date.now() + 24 * 3600 * 1000;
    const outliveSig = crypto.createHmac('sha256', secret).update(`viewer.${outliveExp}`).digest('hex');
    const outliveCookie = `sr_session=${encodeURIComponent(`viewer.${outliveExp}.${outliveSig}`)}`;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: outliveCookie } })).status).toBe(401);

    // Validly signed cookie for user not present in htpasswd
    const ghostExp = Date.now() + 60_000;
    const ghostSig = crypto.createHmac('sha256', secret).update(`ghost.${ghostExp}`).digest('hex');
    const ghostCookie = `sr_session=${encodeURIComponent(`ghost.${ghostExp}.${ghostSig}`)}`;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: ghostCookie } })).status).toBe(401);
  });

  it('supports usernames containing a dot in login (303) and parseSession (200)', async () => {
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'dot.user', pass: 'dot-pass' }),
      redirect: 'manual',
    });
    expect(loginRes.status).toBe(303);
    const dotCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
    const sessRes = await fetch(`${base}/api/session`, { headers: { cookie: dotCookie } });
    expect(sessRes.status).toBe(200);
    expect(await sessRes.json()).toMatchObject({ user: 'dot.user', privileged: true });
  });

  it('fails closed (401) when temp-users.json exists on disk but is corrupted or unreadable, and never escalates an issued temp cookie if temp-users.json is deleted', async () => {
    const backup = fs.readFileSync(tempUsersPath, 'utf8');
    try {
      // Simulate a syntax error or partial write in temp-users.json
      fs.writeFileSync(tempUsersPath, '{corrupted-json', 'utf8');
      const res = await fetch(`${base}/api/session`, { headers: { cookie: viewerCookie } });
      expect(res.status).toBe(401);

      const loginRes = await fetch(`${base}/login`, {
        method: 'POST',
        body: new URLSearchParams({ user: 'viewer', pass: 'viewer-pass' }),
        redirect: 'manual',
      });
      expect(loginRes.status).toBe(401);

      // Deleting temp-users.json must NOT escalate an already-issued temp cookie to privileged: true
      fs.unlinkSync(tempUsersPath);
      const deletedRes = await fetch(`${base}/api/session`, { headers: { cookie: viewerCookie } });
      expect(deletedRes.status).toBe(401);
      // Admin cookie continues to work when temp-users.json does not exist
      const adminRes = await fetch(`${base}/api/session`, { headers: { cookie: adminCookie } });
      expect(adminRes.status).toBe(200);
      expect(await adminRes.json()).toMatchObject({ user: 'admin', privileged: true });
    } finally {
      fs.writeFileSync(tempUsersPath, backup, 'utf8');
    }
  });

  it('blocks temporary viewing accounts (403) from all mutating endpoints while allowing read endpoints', async () => {
    // Read endpoints succeed and report privileged: false
    for (const getPath of ['/api/session', '/api/library', '/api/lanes', '/api/intake/catalog', '/api/intake/jobs']) {
      const res = await fetch(`${base}${getPath}`, { headers: { cookie: viewerCookie } });
      expect(res.status, getPath).toBe(200);
      const data = (await res.json()) as { privileged?: boolean };
      expect(data.privileged, getPath).toBe(false);
    }

    const mutatingRequests: Array<{ path: string; method: string; body: string; contentType?: string }> = [
      { path: '/api/lanes', method: 'PUT', body: JSON.stringify({ revision: 0, render: [], models: {} }) },
      { path: '/api/lanes/reset', method: 'POST', body: JSON.stringify({ revision: 0 }) },
      { path: '/api/library/delete', method: 'POST', body: JSON.stringify({ slug: 'demo', chapter: 'ch1', confirm: 'demo/ch1' }) },
      { path: '/api/intake/preview', method: 'POST', body: JSON.stringify({ provider: 'edge', voice: 'en-US-AndrewMultilingualNeural' }) },
      { path: '/api/intake/jobs', method: 'POST', body: JSON.stringify({ sourceType: 'gdrive', gdriveUrl: 'https://drive.google.com/file/d/1234567890abcdef/view', title: 'Demo' }) },
      { path: '/api/intake/jobs?sourceType=upload&title=Demo&slug=demo', method: 'POST', body: 'PK\x03\x04', contentType: 'application/zip' },
      { path: '/api/intake/jobs/job-1700000000000-abcdef01/retry', method: 'POST', body: '{}' },
      { path: '/api/intake/jobs/job-1700000000000-abcdef01/continue', method: 'POST', body: JSON.stringify({ chapters: 'all' }) },
    ];

    for (const reqSpec of mutatingRequests) {
      const res = await fetch(`${base}${reqSpec.path}`, {
        method: reqSpec.method,
        headers: {
          cookie: viewerCookie,
          Origin: base,
          'X-CSRF-Token': viewerCsrf,
          'Content-Type': reqSpec.contentType || 'application/json',
        },
        body: reqSpec.body,
      });
      expect(res.status, `${reqSpec.method} ${reqSpec.path}`).toBe(403);
    }
  });

  it('enforces CSRF Origin, Referer, Sec-Fetch-Site, and X-CSRF-Token checks on mutations', async () => {
    // 1. Missing both Origin and Referer -> 403
    const noOrigin = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'X-CSRF-Token': adminCsrf, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: string }).error).toContain('Origin or Referer header required');

    // 2. Origin: null -> 403
    const nullOrigin = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: { cookie: adminCookie, Origin: 'null', 'X-CSRF-Token': adminCsrf, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(nullOrigin.status).toBe(403);
    expect(((await nullOrigin.json()) as { error: string }).error).toContain('null Origin rejected');

    // 3. Cross-origin Origin -> 403
    const evilOrigin = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: { cookie: adminCookie, Origin: 'https://evil.example', 'X-CSRF-Token': adminCsrf, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(evilOrigin.status).toBe(403);
    expect(((await evilOrigin.json()) as { error: string }).error).toContain('Origin host mismatch');

    // 4. Sec-Fetch-Site: cross-site -> 403
    const crossSite = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'Sec-Fetch-Site': 'cross-site',
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    expect(((await crossSite.json()) as { error: string }).error).toContain('cross-site request blocked');

    // 5. Same-origin Referer without Origin -> 200
    const refererOnly = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Referer: `${base}/status.html`,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(refererOnly.status).toBe(200);
  });

  it('accepts body csrfToken in /api/lanes/reset and /api/intake/jobs/:id/retry when X-CSRF-Token header is omitted', async () => {
    const resetWithBodyToken = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: { cookie: adminCookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: adminCsrf }),
    });
    expect(resetWithBodyToken.status).toBe(200);

    // Passes CSRF gate and reaches job lookup (404 for nonexistent job ID)
    const retryWithBodyToken = await fetch(`${base}/api/intake/jobs/job-1700000000000-abcdef01/retry`, {
      method: 'POST',
      headers: { cookie: adminCookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: adminCsrf }),
    });
    expect(retryWithBodyToken.status).toBe(404);
  });

  it('accepts valid same-origin request in verifyCsrf when Host header explicitly includes default port (:80 or :443)', async () => {
    const fakeReq = {
      headers: {
        host: 'example.com:443',
        origin: 'https://example.com',
        'x-csrf-token': adminCsrf,
      },
    } as unknown as http.IncomingMessage;
    const res = serverMod ? await import('../src/player/lanes.js') : null;
    const check = res!.verifyCsrf(fakeReq, {
      user: 'admin',
      exp: Date.now() + 60_000,
      isTemp: false,
      privileged: true,
      csrfToken: adminCsrf,
    });
    expect(check).toEqual({ ok: true });
  });

  it('validates lane config mutations, optimistic concurrency revisions (409), and forbidden keys (400)', async () => {
    const initial = (await (
      await fetch(`${base}/api/lanes`, { headers: { cookie: adminCookie } })
    ).json()) as { revision: number; config: laneConfig.LaneConfig };

    // Stale revision -> 409 with currentRevision
    const conflictRes = await fetch(`${base}/api/lanes`, {
      method: 'PUT',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: initial.revision + 99,
        render: initial.config.render,
        models: initial.config.models,
      }),
    });
    expect(conflictRes.status).toBe(409);
    const conflictBody = (await conflictRes.json()) as { code: string; currentRevision: number };
    expect(conflictBody).toMatchObject({
      code: 'revision_conflict',
      currentRevision: initial.revision,
    });

    // Nested forbidden key in lane config -> 400
    const forbiddenRes = await fetch(`${base}/api/lanes`, {
      method: 'PUT',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: initial.revision,
        render: initial.config.render,
        models: { ...initial.config.models, x_api_key: 'secret' },
      }),
    });
    expect(forbiddenRes.status).toBe(400);
    expect(((await forbiddenRes.json()) as { error: string }).error).toContain('Forbidden configuration field');
  });

  it('marks inherit unavailable in /api/intake/catalog when PUT /api/lanes leaves no enabled render lane configured', async () => {
    const cur = (await (
      await fetch(`${base}/api/lanes`, { headers: { cookie: adminCookie } })
    ).json()) as { revision: number; config: laneConfig.LaneConfig };

    const putRes = await fetch(`${base}/api/lanes`, {
      method: 'PUT',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: cur.revision,
        render: [
          { id: 'cloud', enabled: true, slots: 2 },
          { id: 'laptop', enabled: false, slots: 1 },
          { id: 'local', enabled: false, slots: 1 },
        ],
        models: cur.config.models,
      }),
    });
    // PUT /api/lanes persists the policy while /api/intake/catalog marks inherit
    // unavailable because MANHWA_RENDER_CLOUD is unset and local/laptop are disabled.
    expect(putRes.status).toBe(200);

    const catRes = await fetch(`${base}/api/intake/catalog`, { headers: { cookie: adminCookie } });
    expect(catRes.status).toBe(200);
    const cat = (await catRes.json()) as {
      renderLanes: Array<{ id: string; available: boolean; unavailableReason: string | null }>;
    };
    const concreteAvailable = cat.renderLanes.filter((l) => l.id !== 'inherit' && l.available);
    expect(concreteAvailable).toHaveLength(0);
    const inheritOpt = cat.renderLanes.find((l) => l.id === 'inherit');
    expect(inheritOpt?.available).toBe(false);
    expect(inheritOpt?.unavailableReason).toContain('no enabled render lane is configured');

    // Restore default lanes
    const afterPut = (await putRes.json()) as { revision: number };
    const resetRes = await fetch(`${base}/api/lanes/reset`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revision: afterPut.revision }),
    });
    expect(resetRes.status).toBe(200);
  });

  it('rejects bad upload inputs: empty Content-Length, oversized Content-Length, oversized chunked stream, multipart body, and truncated/corrupt ZIP', async () => {
    const uploadsDir = path.join(jobsRoot, 'uploads');

    // 1. Declared Content-Length: 0 -> 400
    const emptyDeclared = await new Promise<{ status: number; body: { error: string } }>((resolve, reject) => {
      const req = http.request(
        `${base}/api/intake/jobs?sourceType=upload&title=Empty&slug=empty-zip`,
        {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            Origin: base,
            'X-CSRF-Token': adminCsrf,
            'Content-Type': 'application/zip',
            'Content-Length': '0',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(emptyDeclared.status).toBe(400);
    expect(emptyDeclared.body.error).toContain('empty');

    // 2. Declared Content-Length > 64 KiB -> 413
    const hugeDeclared = await new Promise<{ status: number; body: { error: string } }>((resolve, reject) => {
      const req = http.request(
        `${base}/api/intake/jobs?sourceType=upload&title=Huge&slug=huge-zip`,
        {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            Origin: base,
            'X-CSRF-Token': adminCsrf,
            'Content-Type': 'application/zip',
            'Content-Length': String(128 * 1024),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            req.destroy();
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          });
        },
      );
      req.on('error', () => {
        // socket closed after 413 response
      });
      req.flushHeaders();
    });
    expect(hugeDeclared.status).toBe(413);
    expect(hugeDeclared.body.error).toContain('exceeds maximum allowed size');

    // 3. Chunked stream (no Content-Length) exceeding 64 KiB mid-stream -> 413 and .part cleaned up
    const chunkedOver = await new Promise<{ status: number; body: { error: string } }>((resolve, reject) => {
      const req = http.request(
        `${base}/api/intake/jobs?sourceType=upload&title=Chunked&slug=chunked-over`,
        {
          method: 'POST',
          headers: {
            cookie: adminCookie,
            Origin: base,
            'X-CSRF-Token': adminCsrf,
            'Content-Type': 'application/zip',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
        },
      );
      req.on('error', reject);
      req.write(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(70 * 1024, 0x41)]));
      req.end();
    });
    expect(chunkedOver.status).toBe(413);
    expect(chunkedOver.body.error).toContain('exceeds maximum allowed size');

    // 4. Multipart form-data sent to ?sourceType=upload -> 400 (bad magic header)
    const multipartUpload = await fetch(`${base}/api/intake/jobs?sourceType=upload&title=Multi&slug=multi-test`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'multipart/form-data; boundary=----FormBoundary7MA4YWxkTrZu0gW',
      },
      body: '------FormBoundary7MA4YWxkTrZu0gW\r\nContent-Disposition: form-data; name="file"; filename="ch1.zip"\r\n\r\nPK\x03\x04...\r\n------FormBoundary7MA4YWxkTrZu0gW--\r\n',
    });
    expect(multipartUpload.status).toBe(400);
    expect(((await multipartUpload.json()) as { error: string }).error).toContain('bad magic header');

    // 5. Valid 4-byte PK\x03\x04 header but corrupt/truncated central directory -> 400 & unlinked
    const corruptZip = await fetch(`${base}/api/intake/jobs?sourceType=upload&title=Corrupt&slug=corrupt-zip`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/zip',
      },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
    });
    expect(corruptZip.status).toBe(400);
    expect(((await corruptZip.json()) as { error: string }).error).toMatch(/Corrupt or invalid ZIP|not a zip/i);

    // Finalized .zip files from failed uploads must always be unlinked;
    // note that fast first-chunk rejections in streamUploadToStaging (src/player/jobs.ts:158-174)
    // can race with async createWriteStream(partPath) open and leave a 0-byte .zip.part file
    // until reconcileOrphans sweeps it.
    const leftover = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    expect(leftover.filter((f) => f.endsWith('.zip'))).toEqual([]);
    for (const part of leftover.filter((f) => f.endsWith('.part'))) {
      fs.unlinkSync(path.join(uploadsDir, part));
    }

    // 6. Forbidden X-* header on upload -> 400
    const forbiddenHeaderUpload = await fetch(`${base}/api/intake/jobs?sourceType=upload&title=Clean&slug=clean-slug`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/zip',
        'X-Api-Key': 'secret-token',
      },
      body: buildMinimalChapterZipBuffer(),
    });
    expect(forbiddenHeaderUpload.status).toBe(400);
    expect(((await forbiddenHeaderUpload.json()) as { error: string }).error).toContain('Forbidden configuration field');
  });

  it('streamUploadToStaging opens partPath synchronously and removes .zip.part on first-chunk rejection without leaving orphans', async () => {
    const uploadsDir = path.join(jobsRoot, 'uploads');
    for (const f of fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []) {
      fs.unlinkSync(path.join(uploadsDir, f));
    }

    const origOpen = fs.open;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(((...args: any[]) => {
      const target = String(args[0] ?? '');
      if (target.endsWith('.zip.part')) {
        setTimeout(() => {
          (origOpen as any).apply(fs, args);
        }, 10);
        return;
      }
      return (origOpen as any).apply(fs, args);
    }) as any);

    try {
      const res = await fetch(`${base}/api/intake/jobs?sourceType=upload&title=Race&slug=race-part`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/zip',
        },
        body: 'NOTZ',
      });
      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      openSpy.mockRestore();
    }

    const parts = (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []).filter((f) =>
      f.endsWith('.zip.part'),
    );
    expect(parts.length).toBe(0);
  });

  it('accepts a valid streamed ZIP upload (201), lists/gets the job, and rejects duplicate active series (409)', async () => {
    const validZip = buildMinimalChapterZipBuffer('ch1', '001.png');
    const createRes = await fetch(
      `${base}/api/intake/jobs?sourceType=upload&title=Valid+Upload&slug=valid-upload-series&chapters=1`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/zip',
        },
        body: validZip,
      },
    );
    expect(createRes.status).toBe(201);
    const createdJob = (await createRes.json()) as { id: string; slug: string; status: string; renderLane: string };
    expect(createdJob.id).toMatch(/^job-\d+-[a-f0-9]+$/);
    expect(createdJob.slug).toBe('valid-upload-series');
    expect(createdJob.status).toBe('queued');
    expect(createdJob.renderLane).toBe('inherit');

    // Lookup via GET /api/intake/jobs/:id
    const getJobRes = await fetch(`${base}/api/intake/jobs/${createdJob.id}`, {
      headers: { cookie: adminCookie },
    });
    expect(getJobRes.status).toBe(200);
    expect(((await getJobRes.json()) as { id: string }).id).toBe(createdJob.id);

    // Duplicate upload for same active slug -> 409 Conflict
    const dupRes = await fetch(
      `${base}/api/intake/jobs?sourceType=upload&title=Valid+Upload&slug=valid-upload-series&chapters=1`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/zip',
        },
        body: validZip,
      },
    );
    expect(dupRes.status).toBe(409);
    expect(((await dupRes.json()) as { error: string }).error).toContain('already has an active/queued job');
  });

  it('enforces renderLane immutability on retry/continue and refuses retry when a job’s pinned lane is later disabled in lanes.json', async () => {
    const validZip = buildMinimalChapterZipBuffer('ch1', '001.png');
    const createRes = await fetch(
      `${base}/api/intake/jobs?sourceType=upload&title=Pinned+Local&slug=pinned-local-series&chapters=1&renderLane=local`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/zip',
        },
        body: validZip,
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; renderLane: string };
    expect(created.renderLane).toBe('local');

    // Mark job as failed on disk so retry/continue are permitted by state
    const jobFile = path.join(jobsRoot, `${created.id}.json`);
    const jobDoc = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    jobDoc.status = 'failed';
    jobDoc.error = 'synthetic failure';
    fs.writeFileSync(jobFile, JSON.stringify(jobDoc, null, 2));

    // Attempting to change renderLane in retry or continue -> 400
    for (const action of ['retry', 'continue'] as const) {
      const res = await fetch(`${base}/api/intake/jobs/${created.id}/${action}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ renderLane: 'inherit' }),
      });
      expect(res.status, action).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('renderLane cannot be changed');
    }

    // Now disable 'local' in lanes.json (leaving 'laptop' enabled) and verify retry refuses (400)
    const curLanes = (await (
      await fetch(`${base}/api/lanes`, { headers: { cookie: adminCookie } })
    ).json()) as { revision: number; config: laneConfig.LaneConfig };

    const putRes = await fetch(`${base}/api/lanes`, {
      method: 'PUT',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: curLanes.revision,
        render: [
          { id: 'laptop', enabled: true, slots: 1 },
          { id: 'local', enabled: false, slots: 1 },
          { id: 'cloud', enabled: false, slots: 2 },
        ],
        models: curLanes.config.models,
      }),
    });
    expect(putRes.status).toBe(200);
    const afterPut = (await putRes.json()) as { revision: number };

    try {
      const retryBlocked = await fetch(`${base}/api/intake/jobs/${created.id}/retry`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(retryBlocked.status).toBe(400);
      expect(((await retryBlocked.json()) as { error: string }).error).toContain(
        "Render lane 'local' can no longer be used",
      );
    } finally {
      await fetch(`${base}/api/lanes/reset`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ revision: afterPut.revision }),
      });
    }
  });

  it('streams media, comparison arms, posters, and thumbnails with Range/HEAD support and blocks path traversal & active-lock deletes', async () => {
    const sdir = path.join(seriesRoot, 'demo-series');
    const videoDir = path.join(sdir, 'out', 'ch1', 'video');
    const vpDir = path.join(sdir, 'out', 'ch1', 'video_paths');
    const chSrcDir = path.join(sdir, 'ch1');
    fs.mkdirSync(videoDir, { recursive: true });
    fs.mkdirSync(vpDir, { recursive: true });
    fs.mkdirSync(chSrcDir, { recursive: true });

    const videoFile = path.join(videoDir, 'video.mp4');
    fs.writeFileSync(videoFile, '0123456789ABCDEF');
    fs.writeFileSync(path.join(vpDir, 'duo.mp4'), 'ARM_VIDEO_DATA');
    fs.writeFileSync(path.join(chSrcDir, '001.webp'), 'WEBP_POSTER');
    fs.writeFileSync(path.join(thumbsRoot, 'demo-series_cover.png'), 'PNG_THUMB');

    // Library scan discovers series, chapter, poster, arm, and thumbnail
    const libRes = await fetch(`${base}/api/library`, { headers: { cookie: adminCookie } });
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as {
      series: Array<{ slug: string; chapters: Array<{ ch: string; poster: string; arms?: Array<{ name: string; url: string }> }> }>;
      thumbnails: Array<{ name: string; url: string }>;
    };
    const foundSeries = lib.series.find((s) => s.slug === 'demo-series');
    expect(foundSeries).toBeTruthy();
    expect(foundSeries!.chapters[0]!.poster).toBe('/poster/demo-series/ch1');
    expect(foundSeries!.chapters[0]!.arms?.[0]?.name).toBe('duo');
    expect(lib.thumbnails.some((t) => t.name === 'demo-series_cover.png')).toBe(true);

    // Byte range and suffix range on video
    const rangeRes = await fetch(`${base}/media/demo-series/ch1/video.mp4`, {
      headers: { cookie: adminCookie, Range: 'bytes=4-9' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe('bytes 4-9/16');
    expect(await rangeRes.text()).toBe('456789');

    // Unsatisfiable range -> 416
    for (const badRange of ['bytes=50-60', 'bytes=10-4', 'bytes=-0', 'bytes=invalid']) {
      const r416 = await fetch(`${base}/media/demo-series/ch1/video.mp4`, {
        headers: { cookie: adminCookie, Range: badRange },
      });
      expect(r416.status, badRange).toBe(416);
      expect(r416.headers.get('content-range')).toBe('bytes */16');
    }

    // Traversal attempts on /media, /thumbs, /poster -> 403/404
    expect((await fetch(`${base}/thumbs/nested/secret.png`, { headers: { cookie: adminCookie } })).status).toBe(403);
    expect((await fetch(`${base}/thumbs/bad.txt`, { headers: { cookie: adminCookie } })).status).toBe(403);
    expect((await fetch(`${base}/poster/demo-series/ch1/extra`, { headers: { cookie: adminCookie } })).status).toBe(403);

    // Holding a shared series lock blocks POST /api/library/delete with 409 pipeline_active
    const lockPath = acquireSharedSeriesLock({ directSdir: sdir, seriesRoot });
    expect(lockPath).toBeTruthy();
    try {
      const delLocked = await fetch(`${base}/api/library/delete`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          Origin: base,
          'X-CSRF-Token': adminCsrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'demo-series', chapter: 'ch1', confirm: 'demo-series/ch1' }),
      });
      expect(delLocked.status).toBe(409);
      expect(((await delLocked.json()) as { code: string }).code).toBe('pipeline_active');
      expect(fs.existsSync(videoFile)).toBe(true);
    } finally {
      releaseSharedSeriesLock(lockPath);
    }

    // Once lock is released, delete succeeds (200) and keeps source chapter + arm
    const delOk = await fetch(`${base}/api/library/delete`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        Origin: base,
        'X-CSRF-Token': adminCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ slug: 'demo-series', chapter: 'ch1', confirm: 'demo-series/ch1' }),
    });
    expect(delOk.status).toBe(200);
    expect(fs.existsSync(videoFile)).toBe(false);
    expect(fs.existsSync(path.join(chSrcDir, '001.webp'))).toBe(true);
    expect(fs.existsSync(path.join(vpDir, 'duo.mp4'))).toBe(true);
  });

  it('rejects POST/DELETE on GET-only endpoints (/api/session, /api/library, /api/status, /api/agy) with 405 and supports HEAD /api/intake/preview/<id>.mp3 (200)', async () => {
    const postSession = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: 'ignored',
    });
    expect(postSession.status).toBe(405);

    const deleteLibrary = await fetch(`${base}/api/library`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(deleteLibrary.status).toBe(405);

    const postStatus = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: 'ignored',
    });
    expect(postStatus.status).toBe(405);

    const deleteAgy = await fetch(`${base}/api/agy`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(deleteAgy.status).toBe(405);

    const previewId = 'a'.repeat(64);
    const previewDir = path.join(jobsRoot, voicePreview.PREVIEW_DIR_NAME);
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, `${previewId}.mp3`), 'FAKE_MP3_DATA');

    const getPreview = await fetch(`${base}/api/intake/preview/${previewId}.mp3`, {
      headers: { cookie: adminCookie },
    });
    expect(getPreview.status).toBe(200);

    const headPreview = await fetch(`${base}/api/intake/preview/${previewId}.mp3`, {
      method: 'HEAD',
      headers: { cookie: adminCookie },
    });
    expect(headPreview.status).toBe(200);
    expect(headPreview.headers.get('content-length')).toBe(String('FAKE_MP3_DATA'.length));
    expect(await headPreview.text()).toBe('');
  });

  it('Service Worker (sw.js) refuses to cache redirected /login HTML under app route or artwork when session expires', async () => {
    const swSource = fs.readFileSync(new URL('../src/player/public/sw.js', import.meta.url), 'utf8');
    expect(swSource).toContain('/status.css?v=5');
    const handlers: Record<string, (event: any) => void> = {};
    const store = new Map<string, Response>();
    const cacheObj = {
      match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
      put: vi.fn(async (req: Request, res: Response) => {
        store.set(req.url, res);
      }),
      addAll: vi.fn(async () => {}),
    };
    const cachesMock = {
      open: vi.fn(async () => cacheObj),
      match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    };

    // Simulate expired session: fetch('/status.html') follows 303 redirect to '/login' (status 200, redirected=true)
    const loginHtmlRes = new Response('<!doctype html><title>Screening Room — sign in</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(loginHtmlRes, 'redirected', { value: true });

    const fetchMock = vi.fn(async (_req?: Request, _init?: RequestInit) => {
      const r = loginHtmlRes.clone();
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    });
    const context = vm.createContext({
      self: {
        addEventListener: (name: string, fn: (e: any) => void) => {
          handlers[name] = fn;
        },
        skipWaiting: () => {},
        clients: { claim: () => {} },
      },
      location: { origin: 'https://player.test' },
      URL,
      fetch: fetchMock,
      caches: cachesMock,
    });
    vm.runInContext(swSource, context);

    let navResult: Promise<Response> | undefined;
    const navReq = new Request('https://player.test/status.html');
    Object.defineProperty(navReq, 'mode', { value: 'navigate' });
    handlers.fetch!({
      request: navReq,
      respondWith: (p: Promise<Response>) => {
        navResult = p;
      },
    });
    await navResult;
    expect(cacheObj.put).not.toHaveBeenCalled();
    expect(store.has('https://player.test/status.html')).toBe(false);

    // Posters and thumbnails must be network-only (cache: 'no-store') and never fall back to caches.match
    fetchMock.mockClear();
    cachesMock.match.mockClear();
    let posterResult: Promise<Response> | undefined;
    handlers.fetch!({
      request: new Request('https://player.test/poster/demo-series/ch1'),
      respondWith: (p: Promise<Response>) => {
        posterResult = p;
      },
    });
    await posterResult;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: 'no-store' });
    expect(cachesMock.match).not.toHaveBeenCalled();

    fetchMock.mockClear();
    let thumbResult: Promise<Response> | undefined;
    handlers.fetch!({
      request: new Request('https://player.test/thumbs/demo_cover.png'),
      respondWith: (p: Promise<Response>) => {
        thumbResult = p;
      },
    });
    await thumbResult;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: 'no-store' });
    expect(cachesMock.match).not.toHaveBeenCalled();
  });
});

/* ========================================================================== *
 * PART 2: Cloud Renderer Lifecycle, Render Policy, Breakers & Fallbacks
 * ========================================================================== */

describe('Part 2: Cloud Renderer Full Lifecycle via Injected Process Transport', () => {
  let root: string;
  let lockdir: string;
  let studioDir: string;
  let seriesDir: string;
  let prevLockdir: string | undefined;

  beforeEach(() => {
    root = makeTmpDir('deep-cloud-');
    lockdir = path.join(root, 'cloud-locks');
    studioDir = path.join(root, 'studio');
    seriesDir = path.join(root, 'series', 'solo-test');

    prevLockdir = process.env.MANHWA_RENDER_CLOUD_LOCKDIR;
    process.env.MANHWA_RENDER_CLOUD_LOCKDIR = lockdir;

    fs.mkdirSync(path.join(studioDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'src', 'index.ts'), 'export const Root = () => null;\n');
    fs.writeFileSync(path.join(studioDir, 'package.json'), '{"name":"studio"}\n');
    fs.writeFileSync(path.join(studioDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(studioDir, 'remotion.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(studioDir, 'tsconfig.json'), '{}\n');
    fs.mkdirSync(path.join(studioDir, 'public', 'solo-test_ch1'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'public', 'solo-test_ch1', 'narration.mp3'), 'AUDIO');

    fs.mkdirSync(path.join(seriesDir, 'out', 'ch1', 'video'), { recursive: true });

    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests('sbx-render-1');
    cloudlane._setStudioForTests('/home/agent/studio');
    lappy._resetStateForTests();
    lappy._setHostForTests(null);
    lappy._setRunnerForTests(null);
    renderlane._resetHooksForTests();
    renderPolicy.resetRenderPlan();
    renderPolicy.setTransportDefaults(null);
    renderPolicy.setHealthProbes(null);
    telemetry._reset();
  });

  afterEach(() => {
    cloudlane._setRunnerForTests(null);
    cloudlane._resetOpsForTests();
    cloudlane._resetStateForTests();
    cloudlane._setNameForTests(null);
    cloudlane._setStudioForTests(null);
    lappy._resetStateForTests();
    lappy._setHostForTests(null);
    lappy._setRunnerForTests(null);
    renderlane._resetHooksForTests();
    renderPolicy.resetRenderPlan();
    renderPolicy.setTransportDefaults(null);
    renderPolicy.setHealthProbes(null);
    telemetry._reset();
    if (prevLockdir === undefined) delete process.env.MANHWA_RENDER_CLOUD_LOCKDIR;
    else process.env.MANHWA_RENDER_CLOUD_LOCKDIR = prevLockdir;
    rmrf(root);
  });

  it('executes the complete real cloudlane.render lifecycle through _setRunnerForTests (ls -> gate/use lock -> waitState -> ready -> ttl -> syncStudio -> push -> flock render -> pull -> ffprobe validate -> atomic rename -> rm -> auto-pause)', async () => {
    const propsPath = path.join(seriesDir, 'out', 'ch1', 'video', 'shots.json');
    const videoPath = path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4');
    fs.writeFileSync(propsPath, JSON.stringify({ audio: 'solo-test_ch1/narration.mp3', shots: [] }));
    fs.writeFileSync(videoPath, 'OLD_VIDEO_BYTES');

    const commands: string[][] = [];
    let boxStatus = 'stopped';
    let remoteMarker = '';

    cloudlane._setRunnerForTests((args) => {
      commands.push([...args]);
      const [bin, ...rest] = args;
      if (bin === 'ffprobe') {
        const target = rest.at(-1)!;
        const content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        if (content === 'NEW_CLOUD_MP4_BYTES') {
          return { status: 0, stdout: '64.5\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'Invalid data' };
      }
      if (bin === 'sbx') {
        const sub = rest[1]; // rest[0] is '--cloud'
        if (sub === 'ls') {
          return {
            status: 0,
            stdout: JSON.stringify({
              sandboxes: [{ name: 'sbx-render-1', id: 'sbx_id_123', status: boxStatus }],
            }),
            stderr: '',
          };
        }
        if (sub === 'ttl') {
          if (rest.includes('--json')) {
            return {
              status: 0,
              stdout: JSON.stringify({
                expires_in_seconds: 1200,
                max_remaining_seconds: 86400,
                stopped: false,
                ttl_paused: false,
              }),
              stderr: '',
            };
          }
          // ttl extension call: ['--cloud', 'ttl', '+4200s', 'sbx-render-1']
          return { status: 0, stdout: 'extended\n', stderr: '' };
        }
        if (sub === 'exec') {
          const shCmd = rest[5] ?? '';
          // Exec resumes a stopped sandbox
          boxStatus = 'running';
          if (shCmd.includes('.kit-ready')) {
            return {
              status: 0,
              stdout: JSON.stringify({ cpus: 8, mem_gb: 16.0, disk_gb: 40.0, miss: '' }),
              stderr: '',
            };
          }
          if (shCmd.includes('.pipeline-src-sha256') && shCmd.includes('sha256sum')) {
            return { status: 0, stdout: remoteMarker, stderr: '' };
          }
          if (shCmd.startsWith("printf '%s' ")) {
            remoteMarker = shCmd.split(' ')[2]?.replace(/^'|'$/g, '') ?? '';
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: 'exec ok\n', stderr: '' };
        }
        if (sub === 'cp') {
          const src = rest[2]!;
          const dst = rest[3]!;
          if (src.startsWith('sbx-render-1:')) {
            // Pull video from sandbox to local .part file
            fs.writeFileSync(dst, 'NEW_CLOUD_MP4_BYTES');
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sub === 'stop') {
          boxStatus = 'stopped';
          return { status: 0, stdout: 'stopped\n', stderr: '' };
        }
      }
      return { status: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
    });

    await cloudlane.render(propsPath, videoPath, studioDir);

    // 1. Atomic replacement succeeded and .part is gone
    expect(fs.readFileSync(videoPath, 'utf8')).toBe('NEW_CLOUD_MP4_BYTES');
    expect(fs.existsSync(`${videoPath}.part`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(videoPath), 'render.log'))).toBe(true);

    // 2. TTL was extended by +4200s (5400 - 1200)
    expect(commands.some((c) => c[0] === 'sbx' && c[2] === 'ttl' && c[3] === '+4200s')).toBe(true);

    // 3. Studio composition synced on first render and marker recorded
    expect(remoteMarker).toMatch(/^[a-f0-9]{64}$/);
    const cpCountFirst = commands.filter((c) => c[0] === 'sbx' && c[2] === 'cp').length;
    expect(cpCountFirst).toBe(6); // 3 studio files + 1 public assets dir + 1 shots.json + 1 pulled video.mp4

    // 4. Sandbox auto-paused after lease completion
    expect(commands.some((c) => c[0] === 'sbx' && c[2] === 'stop' && c[3] === 'sbx-render-1')).toBe(true);
    expect(boxStatus).toBe('stopped');

    // 5. Second render with identical studio files skips composition push
    commands.length = 0;
    await cloudlane.render(propsPath, videoPath, studioDir);
    const cpCountSecond = commands.filter((c) => c[0] === 'sbx' && c[2] === 'cp').length;
    expect(cpCountSecond).toBe(3); // ONLY public assets dir + shots.json + pulled video.mp4
  });

  it('preserves original video, removes .part, cleans remote dirs, and pauses sandbox across resume, render, copy, and ffprobe validation failures', async () => {
    const propsPath = path.join(seriesDir, 'out', 'ch1', 'video', 'shots.json');
    const videoPath = path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4');
    fs.writeFileSync(propsPath, JSON.stringify({ audio: 'solo-test_ch1/narration.mp3', shots: [] }));

    for (const failMode of ['kit-missing', 'dep-mismatch', 'remotion-rc1', 'pull-interrupted', 'ffprobe-corrupt'] as const) {
      fs.writeFileSync(videoPath, `GOOD_VIDEO_${failMode}`);
      const stopCalls: string[][] = [];
      const rmCalls: string[] = [];

      cloudlane._setRunnerForTests((args) => {
        const [bin, ...rest] = args;
        if (bin === 'ffprobe') {
          if (failMode === 'ffprobe-corrupt') {
            return { status: 0, stdout: '0\n', stderr: '' };
          }
          return { status: 0, stdout: '30.0\n', stderr: '' };
        }
        const sub = rest[1];
        if (sub === 'ls') {
          return {
            status: 0,
            stdout: JSON.stringify({
              sandboxes: [{ name: 'sbx-render-1', id: 'sbx_id_123', status: 'stopped' }],
            }),
            stderr: '',
          };
        }
        if (sub === 'ttl') {
          return {
            status: 0,
            stdout: JSON.stringify({
              expires_in_seconds: 7200,
              max_remaining_seconds: 86400,
              stopped: false,
              ttl_paused: false,
            }),
            stderr: '',
          };
        }
        if (sub === 'stop') {
          stopCalls.push([...args]);
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sub === 'exec') {
          const shCmd = rest[5] ?? '';
          if (shCmd.includes('.kit-ready')) {
            if (failMode === 'kit-missing') {
              return {
                status: 0,
                stdout: JSON.stringify({ cpus: 8, mem_gb: 16.0, disk_gb: 40.0, miss: ' kit-ready remotion' }),
                stderr: '',
              };
            }
            return {
              status: 0,
              stdout: JSON.stringify({ cpus: 8, mem_gb: 16.0, disk_gb: 40.0, miss: '' }),
              stderr: '',
            };
          }
          if (shCmd.includes('studio dependencies differ')) {
            if (failMode === 'dep-mismatch') {
              return { status: 1, stdout: '', stderr: 'studio dependencies differ; rebake cloud-kit' };
            }
            return { status: 0, stdout: '', stderr: '' };
          }
          if (shCmd.includes('npx remotion render')) {
            if (failMode === 'remotion-rc1') {
              return { status: 1, stdout: '', stderr: 'Chromium crashed' };
            }
            return { status: 0, stdout: '', stderr: '' };
          }
          if (shCmd.startsWith('rm -rf ')) {
            rmCalls.push(shCmd);
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sub === 'cp') {
          const src = rest[2]!;
          const dst = rest[3]!;
          if (src.startsWith('sbx-render-1:')) {
            fs.writeFileSync(dst, 'PARTIAL_OR_CORRUPT_BYTES');
            if (failMode === 'pull-interrupted') {
              return { status: 1, stdout: '', stderr: 'connection reset during sbx cp' };
            }
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      });

      await expect(cloudlane.render(propsPath, videoPath, studioDir), failMode).rejects.toThrow();
      // Original video must never be overwritten or deleted
      expect(fs.readFileSync(videoPath, 'utf8'), failMode).toBe(`GOOD_VIDEO_${failMode}`);
      // .part file must be cleaned up
      expect(fs.existsSync(`${videoPath}.part`), failMode).toBe(false);
      // Sandbox must always be stopped on lease exit
      expect(stopCalls.length, failMode).toBe(1);
      // If job entered the render block, both remote job dir and public dir must be cleaned up
      if (failMode !== 'kit-missing') {
        expect(rmCalls.length, failMode).toBe(2);
      }
    }
  });

  it('cloudlane.healthy() rejects non-"stopped" error states (e.g. "error", "stopping") as unhealthy and resets prior probe or single job failure count on recovery, while capture/run reject signal-killed (status === null) processes', () => {
    cloudlane._setRunnerForTests(() => ({
      status: 0,
      stdout: JSON.stringify({
        sandboxes: [{ name: 'sbx-render-1', id: 'sbx_1', status: 'error' }],
      }),
      stderr: '',
    }));
    expect(cloudlane.healthy(0)).toEqual([false, 'sandbox status: error']);
    expect(cloudlane._state.fails).toBe(1);

    cloudlane._setRunnerForTests(() => ({
      status: 0,
      stdout: JSON.stringify({
        sandboxes: [{ name: 'sbx-render-1', id: 'sbx_1', status: 'running' }],
      }),
      stderr: '',
    }));
    expect(cloudlane.healthy(0)).toEqual([true, 'ok']);
    expect(cloudlane._state.fails).toBe(0);

    // Single job failure followed by healthy probe also clears _state.fails
    cloudlane.report(false);
    expect(cloudlane._state.fails).toBe(1);
    expect(cloudlane.healthy(0)).toEqual([true, 'ok']);
    expect(cloudlane._state.fails).toBe(0);

    // Signal-killed child (status === null) in _capture and run throws RuntimeError
    cloudlane._setRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: 'killed by SIGKILL',
    }));
    expect(() => cloudlane._capture(['ls', '--json'])).toThrow(/rc=null/);
    expect(() => cloudlane.run(['exec', 'sbx-render-1', 'true'], null)).toThrow(/rc=null/);
  });

  it('[CHARACTERIZATION: CACHE POLICY] cloudlane.healthy(maxAge=20) caches a failed probe result for maxAge seconds without re-probing or incrementing breaker on cached reads', () => {
    let lsCalls = 0;
    cloudlane._setRunnerForTests(() => {
      lsCalls += 1;
      return { status: 1, stdout: '', stderr: 'error: not signed in to Docker' };
    });

    // Call 1 with default maxAge (20s) probes sbx ls and records 1 failure
    const [ok1, why1] = cloudlane.healthy();
    expect(ok1).toBe(false);
    expect(why1).toContain('not signed in to Docker');
    expect(lsCalls).toBe(1);
    expect(cloudlane._state.fails).toBe(1);

    // Call 2 within maxAge (20s) serves the cached probe result without re-probing
    const [ok2] = cloudlane.healthy();
    expect(ok2).toBe(false);
    expect(lsCalls).toBe(1);
    expect(cloudlane._state.fails).toBe(1);
    expect(cloudlane._state.until).toBe(0);
  });

  it('cloudlane._ensureTtl() throws RuntimeError("invalid cloud TTL payload") when expires_in_seconds and max_remaining_seconds are missing from JSON', () => {
    const seenArgs: string[][] = [];
    cloudlane._setRunnerForTests((args) => {
      seenArgs.push([...args]);
      return { status: 0, stdout: '{}', stderr: '' };
    });
    expect(() => cloudlane._ensureTtl()).toThrow('invalid cloud TTL payload');
    expect(seenArgs).toHaveLength(1);
  });

  it('persisted render plan (_workerPlan -> _renderOnLane) falls back via fallbackChain when unpinned cloud fails mid-render', async () => {
    const lanesFile = path.join(root, 'lanes.json');
    vi.stubEnv('MANHWA_LANE_CONFIG', lanesFile);
    vi.stubEnv('MANHWA_RENDER_CLOUD', 'sbx-render-1');

    // Save a valid persisted config with cloud Primary and local Fallback 1 (unpinned / inherit)
    const defaults = laneConfig.getDefaultConfig();
    laneConfig.putLanesState(
      {
        revision: 0,
        render: [
          { id: 'cloud', enabled: true, slots: 1 },
          { id: 'local', enabled: true, slots: 1 },
          { id: 'laptop', enabled: false, slots: 1 },
        ],
        models: defaults.models,
      },
      'admin',
    );

    const plan = renderPolicy.buildRenderPlan();
    expect(plan.legacy).toBe(false);
    expect(plan.override).toBeNull();
    expect(renderPolicy.fallbackChain(plan, 'cloud').map((l) => l.id)).toEqual(['cloud', 'local']);

    let localRenderCalled = false;
    renderlane._hooks.prepare = async (_sdir, ch) => [`${ch}.json`, `${ch}.mp4`] as [string, string];
    renderlane._hooks.cloudlane.NAME = 'sbx-render-1';
    renderlane._hooks.cloudlane.healthy = () => [true, 'paused; checked on render'];
    renderlane._hooks._probe = () => 42;
    renderlane._hooks.renderCloud = () => {
      throw new cloudlane.RuntimeError('sbx exec rc=1; see render.log');
    };
    renderlane._hooks.renderLocal = () => {
      localRenderCalled = true;
    };

    const q = new renderlane.RenderQueue<string | null>();
    q.put('ch1');
    q.put(null);
    const results: Record<string, renderlane.VideoResult> = {};
    const failcounts: Record<string, number> = {};

    await renderlane._workerPlan(seriesDir, path.join(seriesDir, 'out'), q, results, failcounts, plan);

    expect(localRenderCalled).toBe(true);
    expect(results.ch1?.status).toBe('video-ok');
  });

  it('concurrent produce() calls isolate lappy.useRemote() and telemetry chapter context via withRemote() and telemetry.run()', async () => {
    const observedRemoteDuringPrepare: Record<string, boolean> = {};

    lappy._setHostForTests('lappy-host');
    renderlane._hooks.lappy.HOST = 'lappy-host';
    renderlane._hooks.lappy.healthy = () => [true, 'ok'];
    renderlane._hooks.cloudlane.NAME = 'sbx-render-1';
    renderlane._hooks.cloudlane.healthy = () => [true, 'ok'];
    renderlane._hooks._probe = () => 10;
    renderlane._hooks.renderRemote = () => {};
    renderlane._hooks.renderCloud = () => {};
    renderlane._hooks.renderLocal = () => {};

    let resolveFirstPrepare!: () => void;
    const firstPrepareGate = new Promise<void>((resolve) => {
      resolveFirstPrepare = resolve;
    });

    renderlane._hooks.prepare = async (_sdir, ch) => {
      if (ch === 'ch1') {
        await firstPrepareGate;
      }
      // Record what lappy.useRemote() reports at the end of prepare()
      observedRemoteDuringPrepare[ch] = lappy.useRemote();
      return [`${ch}.json`, `${ch}.mp4`];
    };

    // Start ch1 on 'laptop'
    const p1 = renderlane.produce(seriesDir, 'ch1', path.join(seriesDir, 'out'), {
      lane: 'laptop',
      workerId: 'lappy-host',
      log: () => {},
    });

    // While ch1 is awaiting inside prepare(), start ch2 on 'cloud'
    const p2 = renderlane.produce(seriesDir, 'ch2', path.join(seriesDir, 'out'), {
      lane: 'cloud',
      workerId: 'sbx-render-1',
      log: () => {},
    });

    await p2;
    resolveFirstPrepare();
    await p1;

    expect(observedRemoteDuringPrepare.ch2).toBe(false);
    expect(observedRemoteDuringPrepare.ch1).toBe(true);
  });

  it('legacy _render falls back from cloud to local on failure and opens the cloud breaker after two failures', async () => {
    const propsPath = path.join(seriesDir, 'out', 'ch1', 'video', 'shots.json');
    const videoPath = path.join(seriesDir, 'out', 'ch1', 'video', 'video.mp4');
    fs.writeFileSync(propsPath, JSON.stringify({ audio: 'solo-test_ch1/narration.mp3', shots: [] }));
    fs.writeFileSync(videoPath, 'LOCAL_FALLBACK_VIDEO');

    let localFallbackCount = 0;
    renderlane._hooks.lappy.HOST = '';
    renderlane._hooks.cloudlane.NAME = 'sbx-render-1';
    renderlane._hooks.cloudlane.healthy = () => [true, 'ok'];
    renderlane._hooks.cloudlane.report = (ok: boolean) => cloudlane.report(ok);
    renderlane._hooks._probe = () => 55;
    renderlane._hooks.renderLocal = () => {
      localFallbackCount += 1;
    };

    // Cloud listed as running, but renderCloud fails on both chapters
    cloudlane._setRunnerForTests((args) => {
      if (args[0] === 'sbx' && args[2] === 'ls') {
        return {
          status: 0,
          stdout: JSON.stringify({ sandboxes: [{ name: 'sbx-render-1', status: 'running' }] }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'cloud render failed' };
    });

    const r1 = await renderlane._render('ch1', propsPath, videoPath, () => {}, null);
    expect(r1).toEqual([videoPath, 55]);
    expect(localFallbackCount).toBe(1);
    expect(cloudlane._state.fails).toBe(1);
    expect(cloudlane._state.until).toBe(0);

    const r2 = await renderlane._render('ch2', propsPath, videoPath, () => {}, null);
    expect(r2).toEqual([videoPath, 55]);
    expect(localFallbackCount).toBe(2);
    // Two failures open the 600s breaker
    expect(cloudlane._state.until).toBeGreaterThan(0);
    expect(cloudlane.healthy(0)[0]).toBe(false);
    expect(cloudlane.healthy(0)[1]).toContain('breaker open');
  });

  it('standalone renderPolicy.laneAvailability(plan) honors plan.lanes[i].configured without requiring setTransportDefaults', () => {
    renderPolicy.setTransportDefaults(null);
    const env = { MANHWA_RENDER_CLOUD: 'sbx-render-1', MANHWA_RENDER_PLAN_SNAPSHOT: '0' };
    const plan = renderPolicy.buildRenderPlan(env);
    const cloudLaneEntry = plan.lanes.find((l) => l.id === 'cloud');
    expect(cloudLaneEntry?.configured).toBe(true);
    expect(cloudLaneEntry?.enabled).toBe(true);

    const directAvail = renderPolicy.laneAvailability(plan);
    expect(directAvail.cloud).toEqual([true, 'configured']);

    renderlane._hooks.cloudlane.NAME = 'sbx-render-1';
    renderlane._hooks.cloudlane.healthy = () => [true, 'ok'];
    const syncedAvail = renderlane.renderPolicy.laneAvailability(plan);
    expect(syncedAvail.cloud).toEqual([true, 'ok']);
  });

  it('statusProbe.cloudLane() marks a running sandbox unavailable and surfaces the error when sbx ls fails', () => {
    const statusDir = path.join(root, 'out', 'status');
    fs.mkdirSync(statusDir, { recursive: true });
    const paths: statusProbe.Paths = {
      root,
      series: seriesDir,
      log: path.join(root, 'out', 'pipeline.log'),
      status: statusDir,
    };
    vi.stubEnv('MANHWA_RENDER_CLOUD', 'sbx-render-1');

    // First probe at t=100 succeeds
    const first = statusProbe.cloudLane(100, paths, () => [
      { name: 'sbx-render-1', id: 'sbx_1', status: 'running', cpus: 8, memory_mib: 16384 },
      null,
    ]);
    expect(first).toMatchObject({
      id: 'sbx-render-1',
      status: 'idle',
      available: true,
      reason: 'Running',
      probedAt: 100,
    });

    // Second probe at t=200 (after 30s cache expiry) fails because sbx is logged out
    const second = statusProbe.cloudLane(200, paths, () => [null, 'error: not signed in to Docker']);
    expect(second).toMatchObject({
      id: 'sbx-render-1',
      status: 'unavailable',
      available: false,
      reason: 'error: not signed in to Docker',
      stale: true,
      lastError: 'error: not signed in to Docker',
      probedAt: 100,
    });

    // Third probe at t=300 with non-ready box status ("error" / "stopping") marks available: false
    const third = statusProbe.cloudLane(300, paths, () => [
      { name: 'sbx-render-1', id: 'sbx_1', status: 'error', cpus: 8, memory_mib: 16384 },
      null,
    ]);
    expect(third).toMatchObject({
      id: 'sbx-render-1',
      status: 'unavailable',
      available: false,
      reason: 'Sandbox status: error',
      boxStatus: 'error',
    });
  });
});

/* ========================================================================== *
 * PART 3: Offline Deployment & Contract Boundary Characterizations
 * ========================================================================== */

describe('Part 3: Offline Deployment & Contract Boundary Characterizations', () => {
  it('handles offline cloudLane status collection when sbx is unauthenticated or absent without invoking live sbx', () => {
    const statusTmp = makeTmpDir('deep-status-offline-');
    try {
      const statusDir = path.join(statusTmp, 'out', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const paths: statusProbe.Paths = {
        root: statusTmp,
        series: path.join(statusTmp, 'series'),
        log: path.join(statusTmp, 'out', 'pipeline.log'),
        status: statusDir,
      };
      vi.stubEnv('MANHWA_RENDER_CLOUD', 'sbx-render-1');

      const res = statusProbe.cloudLane(500, paths, () => [null, 'error: not signed in to Docker']);
      expect(res).toMatchObject({
        id: 'sbx-render-1',
        kind: 'cloud',
        status: 'unavailable',
        available: false,
        reason: 'error: not signed in to Docker',
      });
    } finally {
      rmrf(statusTmp);
    }
  });

  it('voicePreview.generatePreview("edge") invokes EDGE_TTS_PYTHON before falling back to python3 on PATH', async () => {
    const previewTmp = makeTmpDir('deep-preview-');
    try {
      const fakePathDir = path.join(previewTmp, 'fake-path-bin');
      const edgePyDir = path.join(previewTmp, 'opt-tts-bin');
      fs.mkdirSync(fakePathDir, { recursive: true });
      fs.mkdirSync(edgePyDir, { recursive: true });

      const logFile = path.join(previewTmp, 'invocations.log');
      const fakePython3 = path.join(fakePathDir, 'python3');
      const fakeEdgePython = path.join(edgePyDir, 'python');

      fs.writeFileSync(
        fakePython3,
        `#!/bin/sh\necho "path-python3" >> "${logFile}"\necho "No module named edge_tts" >&2\nexit 1\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        fakeEdgePython,
        `#!/bin/sh\necho "edge-tts-python" >> "${logFile}"\nexit 1\n`,
        { mode: 0o755 },
      );

      const env: Record<string, string | undefined> = {
        PATH: fakePathDir,
        MANHWA_JOBS_DIR: path.join(previewTmp, 'jobs'),
        EDGE_TTS_PYTHON: fakeEdgePython,
        MANHWA_PIPELINE_PYTHON: undefined,
      };
      await expect(
        voicePreview.generatePreview('edge', 'en-US-AndrewMultilingualNeural', env),
      ).rejects.toThrow(/edge-tts is not available/);

      const invoked = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      expect(invoked).toEqual(['edge-tts-python', 'path-python3']);
    } finally {
      rmrf(previewTmp);
    }
  });

  it('intake.jobsDir() defaults to <repo>/out/jobs or <repo>/pipeline/out/jobs consistently', () => {
    const emptyEnv: Record<string, string | undefined> = {};
    const jdir = intake.jobsDir(emptyEnv);
    expect([
      path.join(intake.REPO_ROOT, 'out', 'jobs'),
      path.join(intake.REPO_ROOT, 'pipeline', 'out', 'jobs'),
    ]).toContain(jdir);
  });

  it('frontend parseDriveId (new-series.js) accepts drive.google.com, drive.usercontent.google.com, and docs.google.com file URLs', () => {
    const ucontentUrl =
      'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&export=download';
    const docsUrl = 'https://docs.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view';

    expect(intake.parseGdriveUrl(ucontentUrl).fileId).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(intake.parseGdriveUrl(docsUrl).fileId).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');

    const jsSource = fs.readFileSync(new URL('../src/player/public/new-series.js', import.meta.url), 'utf8');
    const fnMatch = /function parseDriveId\(url\)\s*\{[\s\S]*?\n\}/.exec(jsSource);
    expect(fnMatch).toBeTruthy();
    const ctx = vm.createContext({ URL });
    vm.runInContext(fnMatch![0], ctx);
    expect(ctx.parseDriveId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view')).toBe(
      '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    );
    expect(ctx.parseDriveId(ucontentUrl)).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(ctx.parseDriveId(docsUrl)).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(ctx.parseDriveId('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit')).toBe('');
    expect(ctx.parseDriveId('https://drive.google.com/drive/my-drive?id=1AbCdEfGhIjKlMnOpQrStUvWxYz')).toBe('');
  });
});
