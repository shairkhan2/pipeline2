/** Offline deployment smoke test against disposable containers and scratch media. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { apr1 } from '../src/player/server.js';

const engine = process.env.CONTAINER_ENGINE || 'docker';
const id = `pipeline-smoke-${crypto.randomBytes(5).toString('hex')}`;
const backend = `${id}-backend`;
const frontend = `${id}-frontend`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-image-smoke-'));
const password = crypto.randomBytes(20).toString('hex');
const run = (...args: string[]) => execFileSync(engine, args, { encoding: 'utf8', timeout: 120000 }).trim();
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
let networkCreated = false;
try {
  const users = path.join(root, 'users');
  fs.writeFileSync(users, `smoke:${apr1(password, 'smoke')}\n`, { mode: 0o644 });
  run('network', 'create', id);
  networkCreated = true;
  run('run', '-d', '--init', '--name', backend, '--network', id,
    '-e', 'MANHWA_NO_AUTO_WORKER=1', '-e', 'PLAYER_COOKIE_SECURE=false',
    '-v', `${users}:/run/secrets/player_htpasswd:ro`,
    process.env.BACKEND_IMAGE || 'pipeline-v2-backend:local');
  run('run', '-d', '--name', frontend, '--network', id,
    '-e', `BACKEND_URL=http://${backend}:8080`, '-p', '127.0.0.1::8080',
    process.env.FRONTEND_IMAGE || 'pipeline-v2-frontend:local');
  const port = run('port', frontend, '8080/tcp').split('\n')[0]!.split(':').at(-1)!;
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await request(`${base}/api/session`)).status === 401) break;
    } catch { /* Startup can briefly refuse connections. */ }
    if (attempt >= 30) throw new Error('Containers did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal((await request(`${base}/`, { redirect: 'manual' })).status, 303);
  const login = await request(`${base}/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ user: 'smoke', pass: password }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { cookie };
  const session = await request(`${base}/api/session`, { headers });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  const identity = await session.json() as { csrfToken: string };
  assert.ok(identity.csrfToken);
  for (const asset of ['/', '/api.js?v=1', '/app.js?v=3', '/new-series.html', '/status.html', '/sw.js']) {
    assert.equal((await request(`${base}${asset}`, { headers })).status, 200, asset);
  }
  const directStatic = run('exec', backend, 'node', '-e',
    `fetch('http://127.0.0.1:8080/app.js',{headers:{cookie:${JSON.stringify(cookie)}}}).then(r=>console.log(r.status))`);
  assert.equal(directStatic, '404');
  assert.equal((await request(`${base}/api/intake/jobs`, {
    method: 'POST', headers: { ...headers, Origin: base, 'Content-Type': 'application/json' }, body: '{}',
  })).status, 403);
  assert.equal((await request(`${base}/api/intake/jobs`, {
    method: 'POST', headers: { ...headers, Origin: base, 'X-CSRF-Token': identity.csrfToken, 'Content-Type': 'application/json' },
    body: 'null',
  })).status, 400);
  const validatedMutation = await request(`${base}/api/lanes`, {
    method: 'PUT', headers: { ...headers, Origin: base, 'X-CSRF-Token': identity.csrfToken, 'Content-Type': 'application/json' },
    body: '{"command":"forbidden"}',
  });
  assert.equal(validatedMutation.status, 400);
  assert.match(((await validatedMutation.json()) as { error: string }).error, /Forbidden configuration field/);
  run('exec', backend, 'node', '-e',
    "const fs=require('fs'); fs.mkdirSync('/data/series/smoke/out/ch1/video',{recursive:true}); fs.writeFileSync('/data/series/smoke/out/ch1/video/video.mp4','0123456789')");
  const media = await request(`${base}/media/smoke/ch1/video.mp4`, { headers: { ...headers, Range: 'bytes=2-5' } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await media.text(), '2345');
  assert.equal((await request(`${base}/healthz`)).status, 200);
  if (process.env.SMOKE_RENDER === '1') {
    run('exec', '-w', '/app/remotion-studio', backend,
      'npx', 'remotion', 'render', 'src/index.ts', 'Recap', '/tmp/smoke.mp4',
      '--props={"shots":[],"audio":"","background":"starfield","motion":"cut"}', '--frames=0-0');
    const duration = run('exec', backend, 'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', '/tmp/smoke.mp4');
    assert.ok(Number(duration) > 0);
    console.log('Local Chromium/Remotion one-frame render passed.');
  }
  console.log('Image smoke passed: login, asset auth, API-only backend, CSRF, invalid JSON, and media seeking.');
} catch (error) {
  for (const container of [frontend, backend]) {
    try { console.error(run('logs', '--tail', '40', container)); } catch { /* Container may not exist. */ }
  }
  throw error;
} finally {
  for (const container of [frontend, backend]) {
    try { run('rm', '-f', container); } catch { /* Container may not exist. */ }
  }
  if (networkCreated) run('network', 'rm', id);
  fs.rmSync(root, { recursive: true, force: true });
}
