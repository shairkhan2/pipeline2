#!/usr/bin/env node
/**
 * Standalone browser fixture for the Hindi language-version feature.
 *
 * Starts the REAL `src/player/server.ts` against an isolated series under
 * /tmp/opencode, with:
 *   - a controlled offline LLM seam (deterministic Hindi translation + accept),
 *   - the REAL locale render path (renderlane.prepare -> timeline.main) with the
 *     offline fake Edge "python" and real ffmpeg audio,
 *   - the Remotion step replaced by an ffmpeg render seam (the expensive part).
 *
 * No paid provider, no network, no real series. Prints the URL, the login and a
 * ready-to-use session cookie so a browser/driver can open the library.
 *
 *   npx tsx tools/language-fixture.ts [--port 4189]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fakeEdgeCalls, languageTestStudioPublic } from '../tests/helpers/language-studio-env.js';

const PORT = Number(
  (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '') ||
    process.env.FIXTURE_PORT ||
    4189,
);
const USER = 'admin';
const PASS = 'fixture-password';
const SLUG = 'hi-fixture';
const ROOT = '/tmp/opencode/language-fixture';

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function json(file: string, value: unknown): void {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function buildSeries(seriesRoot: string): string {
  const sdir = path.join(seriesRoot, SLUG);
  const out = path.join(sdir, 'out');
  const ch = 'ch1';
  const panelsDir = path.join(out, 'panels', ch);
  fs.mkdirSync(panelsDir, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const res = spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=0x${(0x203040 + i * 0x101010).toString(16)}:s=320x480:d=1`,
      '-frames:v', '1', path.join(panelsDir, `p0001_${i}.jpg`),
    ], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`panel fixture failed: ${res.stderr}`);
  }
  json(path.join(panelsDir, 'manifest.json'), [1, 2, 3].map((i) => ({
    panel: `p0001_${i}.jpg`, page: 1, idx: i, art_top: 0, art_bottom: 1,
  })));
  json(path.join(out, `obs_${ch}.json`), {
    panels: [1, 2, 3].map((i) => ({
      id: `p0001_${i}`, art: 0.9, bubble_at: 'none', overlay: [], world: [],
      page: 1, idx: i, focus_y: 0.5, weight: 2,
    })),
    characters: [],
    gags: [],
    events: [],
  });
  write(
    path.join(out, ch, 'script.md'),
    'He runs fast. @p0001_1\nShe waits here. @p0001_2\nThey leave now. @p0001_3\n',
  );
  json(path.join(sdir, 'meta.json'), {
    title: 'Hindi Fixture',
    tts: { engine: 'edge', voice_id: 'en-US-AndrewMultilingualNeural', speed: 1 },
    visuals: { background: 'starfield', motion: 'cut' },
  });
  json(path.join(out, ch, 'report.json'), { series: SLUG, ch, status: 'ok', lines: 3, issues: [] });
  return sdir;
}

function offlineLlm() {
  return async (messages: unknown, options: { tag?: string }) => {
    const raw = (messages as Array<{ content: string }>)[0]!.content;
    if (String(options?.tag ?? '').includes('review')) {
      return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', issues: [] }) } }] };
    }
    const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
    if (!block) throw new Error('translate prompt missing units');
    const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
    const hindi: Record<string, string> = {
      'He runs fast.': 'वह तेज़ दौड़ता है।',
      'She waits here.': 'वह यहाँ इंतज़ार करती है।',
      'They leave now.': 'वे अब चले जाते हैं।',
    };
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            units: units.map((u) => {
              const plain = u.text.replace(/⟦[ETH]\d*⟧/g, '').trim();
              const translated = hindi[plain];
              if (!translated) throw new Error(`no offline Hindi for ${plain}`);
              return { id: u.id, text: u.text.replace(plain, translated) };
            }),
            glossary: { names: {}, terms: {} },
          }),
        },
      }],
    };
  };
}

async function main(): Promise<void> {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const seriesRoot = path.join(ROOT, 'series');
  const sdir = buildSeries(seriesRoot);

  process.env.PLAYER_HTPASSWD = path.join(ROOT, 'users');
  process.env.PLAYER_SECRET_FILE = path.join(ROOT, 'secret');
  process.env.PLAYER_TEMP_USERS = path.join(ROOT, 'temp-users');
  process.env.PLAYER_API_ONLY = '1';
  process.env.MANHWA_SERIES_ROOT = seriesRoot;
  process.env.MANHWA_JOBS_DIR = path.join(ROOT, 'out', 'jobs');
  process.env.MANHWA_OUT_DIR = path.join(ROOT, 'out');
  process.env.PIPELINE_LOG = path.join(ROOT, 'out', 'pipeline.log');
  process.env.MANHWA_NO_AUTO_WORKER = '1';
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';

  const serverMod = await import('../src/player/server.js');
  const languagesMod = await import('../src/player/languages.js');
  const localize = await import('../src/stages/localize.js');
  const renderlane = await import('../src/workers/renderlane.js');

  write(path.join(ROOT, 'users'), `${USER}:${serverMod.apr1(PASS, 'fixture')}\n`);

  localize._setLlmCallForTests(offlineLlm() as never);
  localize._setSleepForTests(async () => {});
  // Run the persisted job IN THIS PROCESS: the offline LLM/TTS seams are
  // process-local, so a spawned CLI would leave them behind (and could reach a
  // real provider). Execution stays asynchronous, exactly like the worker.
  languagesMod._setJobSpawnerForTests((dir, jobId) => {
    void localize
      .runLocalizeJob(dir, jobId, { log: (m) => console.log(`[job ${jobId}] ${m}`) })
      .catch((err) => console.error(`[job ${jobId}] failed:`, (err as Error).message));
  });
  // Real locale timeline; only Remotion is replaced by ffmpeg.
  renderlane._hooks.renderLocal = (props: string, video: string) => {
    fs.mkdirSync(path.dirname(video), { recursive: true });
    const parsed = JSON.parse(fs.readFileSync(props, 'utf8')) as {
      audio: string;
      shots: Array<{ end_s: number }>;
    };
    const audio = path.join(languageTestStudioPublic(), parsed.audio);
    const duration = Math.max(0.5, Math.max(...parsed.shots.map((s) => s.end_s)));
    const res = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x101820:s=320x240:d=${duration}`,
      '-i', audio,
      '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', video,
    ], { encoding: 'utf8', timeout: 120_000 });
    if (res.status !== 0) throw new Error(`ffmpeg render seam failed: ${res.stderr}`);
  };

  const server = serverMod.createPlayerServer();
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${PORT}`;

  // Log in once so the printed cookie is usable by a browser driver.
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ user: USER, pass: PASS }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as {
    csrfToken?: string;
  };

  console.log(`fixture series: ${sdir}`);
  console.log(`url:            ${base}/`);
  console.log(`login:          ${USER} / ${PASS}`);
  console.log(`cookie:         ${cookie}`);
  console.log(`csrf:           ${session.csrfToken ?? ''}`);
  console.log(`languages:      ${base}/api/series/${SLUG}/languages`);
  console.log(`POST example:   curl -s -X POST ${base}/api/series/${SLUG}/languages \\`);
  console.log('                  -H "cookie: <cookie>" -H "origin: ' + base + '" \\');
  console.log('                  -H "x-csrf-token: <csrf>" -H "content-type: application/json" \\');
  console.log('                  -d \'{"locale":"hi-IN","chapters":"1","voice":"hi-IN-MadhurNeural"}\'');
  console.log('ready - Ctrl-C to stop');

  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

void fakeEdgeCalls;
