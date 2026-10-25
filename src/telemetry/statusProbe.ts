/**
 * Read-only dashboard collector. No SSH probes or pipeline jobs.
 *
 * The only external call is a non-waking `sbx --cloud ls` for the configured
 * Docker render lane. It never resumes, stops, or creates a sandbox.
 *
 * Structured snapshots are preferred. A registered legacy stdout log can observe
 * an already-running process without restarting it. File presence is inventory,
 * never proof that a current render completed.
 *
 * Ported from `player/status_probe.py` (in-process, zero `python3` subprocess) and
 * `player/status.js` (`sampleRates`, `pipelineStatus`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STAGES = ['reader', 'writer', 'check', 'audio', 'clean', 'timeline', 'render'] as const;

export interface Paths {
  root: string;
  series: string;
  log: string;
  status: string;
}

export function defaultPaths(): Paths {
  const root = ROOT;
  const series = process.env.MANHWA_SERIES_ROOT || path.join(root, 'series');
  const log = process.env.PIPELINE_LOG || path.join(root, 'out', 'pipeline.log');
  const status = process.env.PIPELINE_STATUS_DIR || path.join(path.dirname(log), 'status');
  return { root, series, log, status };
}

export type Run = Record<string, any>;

/* ------------------------------------------------------------------ *
 * Small file helpers
 * ------------------------------------------------------------------ */

export function readJson<T = any>(file: string, def: T | null = null, limit = 2_000_000): T | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(limit + 1);
      const n = fs.readSync(fd, buf, 0, limit + 1, 0);
      if (n > limit) return def;
      return JSON.parse(buf.subarray(0, n).toString('utf8')) as T;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return def;
  }
}

export function tail(file: string, limit = 196608): string {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const start = Math.max(0, size - limit);
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.allocUnsafe(limit);
      const n = fs.readSync(fd, buf, 0, limit, start);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (size > limit) {
      const idx = text.indexOf('\n');
      text = idx >= 0 ? text.slice(idx + 1) : '';
    }
    return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  } catch {
    return '';
  }
}

export function statFile(file: string): { bytes: number; mtime: number } | null {
  try {
    const s = fs.statSync(file);
    return { bytes: s.size, mtime: s.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

export function safeChild(root: string, name: string): string | null {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') return null;
  const rootResolved = path.resolve(root);
  const child = path.resolve(rootResolved, name);
  if (child === rootResolved) return null;
  return child.startsWith(rootResolved + path.sep) ? child : null;
}

export function scrub(text: string): string {
  let out = text.replace(/(bearer\s+)\S+/gi, '$1[redacted]');
  out = out.replace(/((?:api[_-]?key|authorization|password|secret)\s*[=:]\s*)\S+/gi, '$1[redacted]');
  return out.slice(0, 500);
}

/* ------------------------------------------------------------------ *
 * /proc scanning
 * ------------------------------------------------------------------ */

function sysconfClkTck(): number {
  return cachedSysconf('CLK_TCK', 100);
}

function sysconfPageSize(): number {
  return cachedSysconf('PAGESIZE', 4096);
}

const sysconfCache: Record<string, number> = {};
function cachedSysconf(name: string, fallback: number): number {
  if (sysconfCache[name] !== undefined) return sysconfCache[name];
  let value = fallback;
  try {
    const raw = execFileSync('getconf', [name], { encoding: 'utf8', timeout: 2000 }).trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) value = n;
  } catch {
    // Keep the standard Linux fallback.
  }
  sysconfCache[name] = value;
  return value;
}

export function processes(now: number, clockTicks?: number, pageSize?: number): Record<number, Run> {
  const hz = clockTicks ?? sysconfClkTck();
  const pagesize = pageSize ?? sysconfPageSize();
  let uptime = 0;
  try {
    uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
  } catch {
    uptime = 0;
  }
  const rows: Record<number, Run> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return rows;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = fs.readFileSync(path.join('/proc', entry, 'stat'), 'utf8');
      const idx = raw.lastIndexOf(')');
      const s = raw.slice(idx + 1).trim().split(/\s+/);
      const cmdline = fs.readFileSync(path.join('/proc', entry, 'cmdline'));
      const args = cmdline.toString('utf8').replace(/^\0+|\0+$/g, '').split('\0');
      const pid = Number(entry);
      const name = raw.slice(raw.indexOf('(') + 1, idx);
      rows[pid] = {
        pid,
        ppid: Number(s[1]),
        name,
        state: s[0],
        ticks: Number(s[11]) + Number(s[12]),
        startTicks: Number(s[19]),
        rss: Number(s[21]) * pagesize,
        startedAt: now - uptime + Number(s[19]) / hz,
        args,
      };
    } catch {
      continue;
    }
  }
  return rows;
}

export function runnerArgs(p: Run): [string, string[], boolean] | null {
  const args: string[] = p.args || [];
  const markers = [
    'pipeline/run.py',
    'pipeline/renderlane.py',
    path.join(ROOT, 'pipeline/run.py'),
    path.join(ROOT, 'pipeline/renderlane.py'),
    'src/cli/run.ts',
    'src/workers/renderlane.ts',
    path.join(ROOT, 'src/cli/run.ts'),
    path.join(ROOT, 'src/workers/renderlane.ts'),
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (markers.includes(arg)) {
      const rest = args.slice(i + 1);
      if (!rest.length || rest.includes('--status') || rest.includes('--clear-cache')) return null;
      const chs = rest.slice(1).filter((a) => /^ch\d+$/i.test(a));
      const video = rest.includes('--video') || arg.endsWith('renderlane.py') || arg.endsWith('renderlane.ts');
      return [rest[0], chs, video];
    }
  }
  return null;
}

export function blankRun(
  p: Run,
  series: string,
  chapters: string[],
  video: boolean,
  source = 'process',
): Run {
  return {
    id: `${p.pid}-${p.startTicks}`,
    pid: p.pid,
    startTicks: p.startTicks,
    series,
    startedAt: p.startedAt,
    updatedAt: p.startedAt,
    state: 'running',
    jobId: null,
    pausedWhere: null,
    video,
    source,
    chapters: Object.fromEntries(chapters.map((ch) => [ch, { stages: {} }])),
    workers: {},
    models: {},
    providers: {},
    activeCalls: {},
    recentCalls: [],
    events: [],
    totals: {},
  };
}

export function observeLog(run: Run, text: string): void {
  let current: string | null = null;
  const stage = (ch: string | null, name: string, state: string, details: Record<string, unknown> = {}) => {
    if (!ch) return;
    const row = (run.chapters[ch] = run.chapters[ch] || { stages: {} });
    row.stages[name] = { ...(row.stages[name] || {}), state, ...details };
  };
  const worker = (name: string, details: Record<string, unknown> = {}) => {
    run.workers[name] = {
      ...(run.workers[name] || {}),
      id: name,
      kind: name === 'local' ? 'local' : 'remote',
      ...details,
    };
  };
  for (const line of text.split('\n')) {
    let m = /^== (ch\d+): (READER|WRITER)/.exec(line);
    if (m) {
      current = m[1];
      const name = m[2].toLowerCase();
      if (name === 'writer') stage(current, 'reader', 'done');
      stage(current, name, 'running');
    }
    m = /batch (\d+)\/(\d+) (?:read|cached)/.exec(line);
    if (m) stage(current, 'reader', 'running', { completed: Number(m[1]), total: Number(m[2]), unit: 'batches' });
    m = /script: (\d+) lines \| fact_check: (PASS|FAIL)(?: \((\d+)\))?/.exec(line);
    if (m) {
      stage(current, 'writer', 'done');
      stage(current, 'check', m[2] === 'PASS' ? 'done' : 'warning', {
        lines: Number(m[1]),
        findings: Number(m[3] || 0),
      });
    }
    if (line.includes('queued for video lane')) stage(current, 'audio', 'queued');
    m = /\[video\]\s+dispatch: (ch\d+) -> (\S+)/.exec(line);
    if (m) {
      stage(m[1], 'audio', 'running', { note: 'Preparing audio / timeline (observed dispatch)' });
      run.chapters[m[1]] = run.chapters[m[1]] || { stages: {} };
      run.chapters[m[1]].worker = m[2];
      worker(m[2], { status: 'busy' });
    }
    m = /\[([^\]]+)\] (DOWN: (.+)|UP \((.+)\))/.exec(line);
    if (m) worker(m[1], { available: Boolean(m[4]), reason: m[3] || m[4] });
    m = /render: (ch\d+) starting on (\S+)/.exec(line);
    if (m) {
      const ch = m[1];
      const host = m[2];
      for (const name of ['audio', 'clean', 'timeline']) {
        stage(ch, name, 'done', { note: 'Preparation finished before render' });
      }
      stage(ch, 'render', 'running');
      run.chapters[ch] = run.chapters[ch] || { stages: {} };
      run.chapters[ch].worker = host;
      worker(host, { status: 'busy' });
    }
    m = /render: (ch\d+) DONE ([\d.]+)s video in ([\d.]+)s wall \[([^\]]+)\]/.exec(line);
    if (m) {
      stage(m[1], 'render', 'done', { duration: Number(m[2]), wallSeconds: Number(m[3]) });
      worker(m[4], { status: 'idle' });
    }
    m = /(?:\[video\]\s+!! |!! )(ch\d+) FAILED/.exec(line);
    if (m) {
      const row = (run.chapters[m[1]] = run.chapters[m[1]] || { stages: {} });
      const name = line.includes('[video]') ? 'render' : 'writer' in row.stages ? 'writer' : 'reader';
      stage(m[1], name, 'failed', { note: 'See recent activity' });
    }
    m = /^videos: (\d+) ok/.exec(line);
    if (m) run.state = line.includes('FAILED:') ? 'failed' : 'completed';
    m = /^== PAUSED at (.+)$/.exec(line);
    if (m) {
      run.state = 'paused';
      run.pausedWhere = m[1].trim();
    }
  }
  const warningTokens = ['!!', 'DOWN:', 'fact_check: FAIL', 'UNGROUNDED'];
  run.events = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => ({
      at: null,
      message: scrub(line),
      kind: line.includes('FAILED')
        ? 'error'
        : warningTokens.some((s) => line.includes(s))
          ? 'warning'
          : 'info',
    }))
    .slice(-30);
}

function parseLocalTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [Y, Mo, D, H, Mi, S] = m.slice(1).map(Number);
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return null;
  const d = new Date(Y, Mo - 1, D, H, Mi, S);
  const t = d.getTime() / 1000;
  return Number.isFinite(t) ? t : null;
}

export function parseCalls(text: string): Run[] {
  const calls: Run[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (OK|ERR)\s+(.+?) \[([^\]]+)\] attempt=(\d+)\s+(.*)/.exec(line);
    if (!m) continue;
    const at = parseLocalTime(m[1]);
    if (at === null) continue;
    const usage = /^(\d+)s tokens=(\d+|\?)/.exec(m[6]);
    const ch = /\bch\d+\b/.exec(m[3]);
    calls.push({
      provider: m[4],
      model: null,
      tag: m[3].slice(0, 120),
      chapter: ch ? ch[0] : null,
      state: m[2] === 'OK' ? 'ok' : 'error',
      attempt: Number(m[5]),
      endedAt: at,
      duration: usage ? Number(usage[1]) : null,
      tokens: usage && /^\d+$/.test(usage[2]) ? Number(usage[2]) : null,
      note: usage ? null : scrub(m[6]),
    });
  }
  return calls.slice(-60);
}

/* ------------------------------------------------------------------ *
 * Run enrichment
 * ------------------------------------------------------------------ */

export function enrichRun(run: Run, procs: Record<number, Run>, now: number, paths: Paths): Run {
  // Python's arithmetic on a malformed `startedAt`/`updatedAt` (None) raises
  // TypeError, which collect_runs catches to drop the snapshot. Mirror that.
  if (typeof run.startedAt !== 'number' || !Number.isFinite(run.startedAt)) {
    throw new TypeError('malformed run: startedAt');
  }
  const p = procs[run.pid];
  const alive = Boolean(p && p.startTicks === run.startTicks && p.state !== 'Z');
  run.alive = alive;
  run.jobId = typeof run.jobId === 'string' && run.jobId ? run.jobId : null;
  run.pausedWhere = typeof run.pausedWhere === 'string' && run.pausedWhere ? run.pausedWhere : null;
  if (!alive && run.state === 'running') run.state = 'interrupted';
  // Final snapshots can outlive both their process and their last network call.
  if (!alive || run.state !== 'running') {
    run.activeCalls = {};
    for (const row of Object.values(run.chapters) as Run[]) {
      for (const stage of Object.values((row.stages || {}) as Record<string, Run>)) {
        if (['running', 'queued', 'retrying'].includes(stage.state)) {
          stage.state = run.state === 'paused' ? 'paused' : 'interrupted';
        }
      }
    }
  }
  const endRef = alive && run.state === 'running' ? now : (run.endedAt ?? run.updatedAt);
  run.elapsed = Math.max(0, endRef - run.startedAt);

  const sdir = safeChild(paths.series, run.series);
  const meta = sdir ? readJson<Record<string, any>>(path.join(sdir, 'meta.json'), {}) || {} : {};
  run.title = meta.title || String(run.series).replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());

  let completed = 0;
  for (const [name, chRaw] of Object.entries(run.chapters) as Array<[string, Run]>) {
    if (!sdir || !/^ch\d+$/i.test(name)) continue;
    const ch = chRaw;
    const out = path.join(sdir, 'out');
    const video = path.join(out, name, 'video');
    ch.artifacts = Object.fromEntries(
      (
        [
          ['script', path.join(out, name, 'script.md')],
          ['audio', path.join(video, 'narration.mp3')],
          ['shots', path.join(video, 'shots.json')],
          ['video', path.join(video, 'video.mp4')],
        ] as Array<[string, string]>
      ).map(([key, file]) => [key, statFile(file)]),
    );
    const report = readJson<Record<string, any>>(path.join(out, name, 'report.json'), {}) || {};
    ch.findings = Array.isArray(report.issues) ? report.issues.length : 0;
    const stages = (ch.stages = ch.stages || {});
    if (report.status === 'video-ok' && (statFile(path.join(out, name, 'report.json')) || {}).mtime! >= run.startedAt) {
      if (!stages.render) stages.render = { state: 'done', duration: report.duration };
    }
    const last = (stages[run.video ? 'render' : 'check'] || {}).state;
    ch.complete = last === 'done' || last === 'warning';
    completed += ch.complete ? 1 : 0;
    // Counts during TTS are explicitly file inventory, not freshness guarantees.
    if (stages.audio && stages.audio.state === 'running') {
      try {
        let count = 0;
        for (const d of fs.readdirSync(video, { withFileTypes: true })) {
          if (!d.name.startsWith('tts_lines_')) continue;
          try {
            count += fs.readdirSync(path.join(video, d.name)).filter((f) => /^line_.*\.mp3$/.test(f)).length;
          } catch {
            // ignore unreadable subdirectory
          }
        }
        ch.audioFiles = count;
      } catch {
        // OSError: leave audioFiles unset
      }
    }
    const render = stages.render || {};
    const renderStat = statFile(path.join(video, 'render.log'));
    if (renderStat && renderStat.mtime >= run.startedAt) {
      const text = tail(path.join(video, 'render.log'), 32768);
      const matches = [...text.matchAll(/(Rendered|Encoded)\s+(\d+)\s*\/\s*(\d+)/g)];
      if (matches.length) {
        const frame = matches[matches.length - 1];
        render.completed = Number(frame[2]);
        render.total = Number(frame[3]);
        render.unit = 'frames';
        render.phase = frame[1] === 'Encoded' ? 'Encoding' : 'Rendering';
        // Rendering 100% is not the same as a successfully encoded movie.
        stages.render = render;
      }
    }
  }
  run.completed = completed;
  run.total = Object.keys(run.chapters).length;
  return run;
}

export function collectRuns(procs: Record<number, Run>, now: number, paths: Paths): Run[] {
  let runs: Run[] = [];
  let snapshots: string[] = [];
  try {
    snapshots = fs
      .readdirSync(paths.status)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(paths.status, f))
      .map((f) => ({ f, m: (statFile(f) || { mtime: 0 }).mtime }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 24)
      .map((x) => x.f);
  } catch {
    snapshots = [];
  }
  for (const file of snapshots) {
    const snap = readJson<Run>(file);
    if (!snap || typeof snap !== 'object' || snap.schemaVersion !== 1 || typeof snap.chapters !== 'object') continue;
    if (!['pid', 'startTicks', 'series', 'startedAt', 'updatedAt', 'state'].every((k) => k in snap)) continue;
    snap.source = 'telemetry';
    runs.push(snap);
  }
  const known = new Set(runs.map((r) => `${r.pid}-${r.startTicks}`));
  const sources = readJson<Run[]>(path.join(path.dirname(paths.log), 'status-sources.json'), []) || [];
  for (const source of sources) {
    if (known.has(`${source.pid}-${source.startTicks}`)) continue;
    const text = tail(source.path || '', 524288);
    const head = /^series: ([\w.-]+) .*?chapters: ([^\n\[]+)/m.exec(text);
    if (!head) continue;
    let p = procs[source.pid] || {};
    // Explicit identity allows observation of root-owned stdout from the player user.
    p = { ...p, pid: source.pid, startTicks: source.startTicks, startedAt: source.startedAt };
    const run = blankRun(p, head[1], (head[2].match(/ch\d+/g) || []), text.includes('[VIDEO LANE ON]'), 'log');
    run.updatedAt = (statFile(source.path) || { mtime: run.startedAt }).mtime;
    observeLog(run, text);
    runs.push(run);
    known.add(`${run.pid}-${run.startTicks}`);
  }
  for (const p of Object.values(procs)) {
    const args = runnerArgs(p);
    if (!args || known.has(`${p.pid}-${p.startTicks}`)) continue;
    const run = blankRun(p, args[0], args[1], args[2]);
    try {
      const stdout = fs.realpathSync(`/proc/${p.pid}/fd/1`);
      const st = fs.statSync(stdout);
      if (st.isFile() && st.size) {
        observeLog(run, tail(stdout, 524288));
        run.source = 'log';
        run.updatedAt = st.mtimeMs / 1000;
      }
    } catch {
      // OSError: keep the blank run
    }
    runs.push(run);
  }
  const enriched: Run[] = [];
  for (const run of runs) {
    try {
      enriched.push(enrichRun(run, procs, now, paths));
    } catch {
      continue; // one malformed/old snapshot must not hide other live runs
    }
  }
  enriched.sort((a, b) => {
    const av = a.alive && a.state === 'running' ? 1 : 0;
    const bv = b.alive && b.state === 'running' ? 1 : 0;
    if (av !== bv) return bv - av;
    return b.startedAt - a.startedAt;
  });
  return enriched.slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * System info
 * ------------------------------------------------------------------ */

function sysText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function sysInt(file: string): number | null {
  const v = sysText(file);
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function batterySeconds(status: string, now: number | null, full: number | null, rate: number | null): number | null {
  /** now/full/rate share units (µWh/µW or µAh/µA); rate is the hourly draw. */
  if (!rate || rate <= 0 || now === null) return null;
  let hours: number;
  if (status === 'Discharging') hours = now / rate;
  else if (status === 'Charging' && full !== null && full > now) hours = (full - now) / rate;
  else return null;
  if (hours <= 0 || hours > 96) return null;
  return Math.round(hours * 3600);
}

export function batteryInfo(root = '/sys/class/power_supply'): Run | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    return null;
  }
  let ac: boolean | null = null;
  const packs: Run[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const kind = sysText(path.join(dir, 'type'));
    if (kind === 'Mains') {
      const online = sysText(path.join(dir, 'online'));
      if (online === '0' || online === '1') ac = Boolean(ac) || online === '1';
      continue;
    }
    if (kind !== 'Battery' || sysText(path.join(dir, 'present')) === '0') continue;
    const energy = sysInt(path.join(dir, 'energy_now'));
    const fullEnergy = sysInt(path.join(dir, 'energy_full'));
    const charge = sysInt(path.join(dir, 'charge_now'));
    const fullCharge = sysInt(path.join(dir, 'charge_full'));
    let percent = sysInt(path.join(dir, 'capacity'));
    if (percent === null) {
      if (energy !== null && fullEnergy) percent = Math.round((100 * energy) / fullEnergy);
      else if (charge !== null && fullCharge) percent = Math.round((100 * charge) / fullCharge);
    }
    if (percent !== null) percent = Math.max(0, Math.min(100, percent));
    const status = sysText(path.join(dir, 'status')) || 'Unknown';
    const power = sysInt(path.join(dir, 'power_now'));
    const current = sysInt(path.join(dir, 'current_now'));
    const voltage = sysInt(path.join(dir, 'voltage_now'));
    let seconds: number | null = null;
    if (energy !== null && power) seconds = batterySeconds(status, energy, fullEnergy, power);
    else if (charge !== null && current) seconds = batterySeconds(status, charge, fullCharge, current);
    else if (energy !== null && current && voltage) seconds = batterySeconds(status, energy, fullEnergy, (current * voltage) / 1_000_000);
    packs.push({ percent, status, seconds });
  }
  const known = packs.filter((p) => p.percent !== null);
  if (!known.length) return null;
  const primary = known.reduce((a, b) => (b.percent < a.percent ? b : a));
  return { percent: primary.percent, status: primary.status, ac, seconds: primary.seconds };
}

export function systemInfo(procs: Record<number, Run>, runs: Run[], paths: Paths): Run {
  const cpu = fs
    .readFileSync('/proc/stat', 'utf8')
    .split('\n')[0]
    .split(/\s+/)
    .slice(1, 9)
    .map(Number);
  const mem: Record<string, number> = {};
  for (const m of fs.readFileSync('/proc/meminfo', 'utf8').matchAll(/^(\w+):\s+(\d+) kB/gm)) {
    mem[m[1]] = Number(m[2]) * 1024;
  }
  let disk = { total: 0, free: 0, available: 0 };
  try {
    const st = fs.statfsSync(fs.existsSync(paths.series) ? paths.series : paths.root);
    disk = {
      total: st.blocks * st.bsize,
      free: st.bfree * st.bsize,
      available: st.bavail * st.bsize,
    };
  } catch {
    disk = { total: 0, free: 0, available: 0 };
  }
  const interfaces: Run[] = [];
  for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (name === 'lo' || !name) continue;
    const values = line.slice(i + 1).trim().split(/\s+/);
    interfaces.push({ name, rx: Number(values[0]), tx: Number(values[8]) });
  }
  const ids = new Set<number>(runs.filter((r) => r.alive).map((r) => r.pid));
  for (let i = 0; i < 20; i++) {
    const children = new Set<number>(
      Object.values(procs)
        .filter((p) => ids.has(p.ppid))
        .map((p) => p.pid),
    );
    let subset = true;
    for (const c of children) {
      if (!ids.has(c)) {
        subset = false;
        break;
      }
    }
    if (subset) break;
    for (const c of children) ids.add(c);
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    cores: os.cpus().length,
    uptime: Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]),
    load: os.loadavg(),
    cpuTicks: { total: cpu.reduce((a, b) => a + b, 0), idle: cpu[3] + cpu[4] },
    clockTicks: sysconfClkTck(),
    memory: {
      total: mem.MemTotal,
      available: mem.MemAvailable ?? mem.MemFree ?? 0,
      swapTotal: mem.SwapTotal ?? 0,
      swapFree: mem.SwapFree ?? 0,
    },
    disk,
    battery: batteryInfo(),
    interfaces,
    processes: [...ids]
      .filter((pid) => pid in procs)
      .map((pid) => Object.fromEntries(Object.entries(procs[pid]).filter(([k]) => k !== 'args' && k !== 'ppid'))),
  };
}

/* ------------------------------------------------------------------ *
 * Cloud lane (non-waking list only)
 * ------------------------------------------------------------------ */

function writeJson(file: string, obj: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch {
    // fail-open
  }
}

export function listNamedSandbox(name: string, timeout = 6): [Run | null, string | null] {
  /** Non-waking cloud list. Never start, stop, or exec into the sandbox. */
  let stdout = '';
  try {
    stdout = execFileSync('sbx', ['--cloud', 'ls', '--json'], {
      encoding: 'utf8',
      timeout: timeout * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    if (typeof err?.status === 'number') {
      const text = String(err.stderr || err.stdout || 'sbx ls failed').trim();
      const lines = text.split('\n');
      return [null, (lines[lines.length - 1] || 'sbx ls failed').slice(0, 180)];
    }
    if (err?.signal) return [null, 'TimeoutExpired'];
    return [null, err?.code || err?.name || 'OSError'];
  }
  let boxes: Run[];
  try {
    boxes = JSON.parse(stdout).sandboxes || [];
  } catch {
    return [null, 'cloud list was not JSON'];
  }
  for (const box of boxes) {
    if (box.name === name || box.id === name) {
      return [
        Object.fromEntries(
          ['name', 'id', 'status', 'cpus', 'memory_mib'].map((k) => [k, box[k]]),
        ),
        null,
      ];
    }
  }
  return [null, 'sandbox not found'];
}

export function cloudLane(
  now: number,
  paths: Paths,
  listSandbox: (name: string) => [Run | null, string | null] = listNamedSandbox,
): Run | null {
  /** Configured Docker render lane, including while the pipeline is idle. */
  const cachePath = path.join(path.dirname(paths.status), 'cloud-list.json');
  let cached = readJson<Run>(cachePath);
  if (!cached || typeof cached !== 'object') cached = {};
  const name =
    (process.env.MANHWA_RENDER_CLOUD || '').trim() || String(cached.name || '').trim();
  if (!name) return null;
  const recent = cached.name === name && now - Number(cached.at || 0) < 30;
  let listing: Run | null = recent && (cached.box || cached.error) ? cached : null;
  if (listing === null) {
    const [box, err] = listSandbox(name);
    listing = { at: now, name, box, error: err };
    if (err && cached.name === name && cached.box && !cached.stale) {
      listing.box = cached.box;
      listing.stale = true;
      listing.listedAt = cached.listedAt ?? cached.at;
    }
    writeJson(cachePath, listing);
  }
  const box = listing.box || {};
  const raw = String(box.status || '').toLowerCase();
  const err = listing.error;
  let status: string;
  let available: boolean;
  let reason: string;
  if (listing.stale && raw !== 'stopped') {
    status = 'unavailable';
    available = false;
    reason = err || 'Cloud lane not listed';
  } else if (raw === 'stopped') {
    status = 'paused';
    available = true;
    reason = 'Stopped · warm, not billed';
  } else if (raw === 'running' || raw === 'ready') {
    status = 'idle';
    available = true;
    reason = 'Running';
  } else if (Object.keys(box).length) {
    status = 'unavailable';
    available = false;
    reason = raw ? `Sandbox status: ${raw}` : (err || 'Sandbox unavailable');
  } else {
    status = 'unavailable';
    available = false;
    reason = err || 'Cloud lane not listed';
  }
  if (listing.stale && err && !Object.keys(box).length) reason = err;
  const mem = box.memory_mib;
  let metrics: Run | null = null;
  if (box.cpus || mem) {
    metrics = {
      cpus: box.cpus,
      mem_gb: mem ? Math.round((mem / 1024) * 10) / 10 : null,
      disk_gb: null,
      load: null,
    };
  }
  return {
    id: box.name || name,
    kind: 'cloud',
    jobs: [],
    status,
    available,
    reason,
    probedAt: listing.listedAt ?? listing.at,
    stale: Boolean(listing.stale),
    lastError: err || null,
    metrics,
    boxStatus: raw || null,
  };
}

/**
 * One worker row per enabled `docker-sbx` node in `<outDir>/config/render-nodes.json`.
 * A node found in the caller's cached `sbx --cloud ls --json` result costs no CLI
 * call; any other node is probed directly (result cached in `cloud-boxes.json`
 * for 30s) so custom sandbox nodes report their real live status.
 */
export function configuredCloudWorkers(
  now: number,
  nodes: Array<Record<string, unknown>>,
  listing: Run | null,
  listSandbox: (name: string) => [Run | null, string | null] = listNamedSandbox,
  cacheDir?: string,
): Run[] {
  const boxes: Run[] = Array.isArray(listing?.sandboxes)
    ? (listing!.sandboxes as Run[])
    : listing?.box && typeof listing.box === 'object'
      ? [listing.box as Run]
      : [];
  // `cloud-list.json` only exists when MANHWA_RENDER_CLOUD is set, so a custom
  // `docker-sbx` node must be probed directly. Cache each box for 30s so a
  // status poll never spawns one `sbx` call per node per second.
  const cachePath = cacheDir ? path.join(cacheDir, 'cloud-boxes.json') : null;
  let cache: Run = cachePath ? (readJson<Run>(cachePath) ?? {}) : {};
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  const cachedBoxes: Record<string, Run> = cache.boxes && typeof cache.boxes === 'object'
    ? (cache.boxes as Record<string, Run>)
    : {};
  let cacheDirty = false;
  const rows: Run[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (String(node.kind ?? '') !== 'docker-sbx') continue;
    if (node.enabled === false) continue;
    const id = String(node.id ?? '').trim();
    if (!id) continue;
    const name = String(node.box ?? id).trim() || id;
    let box: Run | null = null;
    for (const item of boxes) {
      if (item && (item.name === name || item.id === name)) {
        box = item;
        break;
      }
    }
    let error: string | null = null;
    if (!box) {
      const cached = cachedBoxes[name];
      const fresh = cached && now - Number(cached.at || 0) < 30;
      if (fresh && (cached.box || cached.error)) {
        box = (cached.box as Run) || null;
        error = (cached.error as string) || null;
      } else {
        const [found, err] = listSandbox(name);
        box = found;
        error = err;
        cachedBoxes[name] = { at: now, box: found, error: err };
        cacheDirty = true;
      }
    }
    const raw = String(box?.status ?? '').toLowerCase();
    const available = raw === 'running' || raw === 'ready' || raw === 'stopped';
    const status = raw === 'stopped' ? 'paused' : raw === 'running' || raw === 'ready' ? 'idle' : 'unavailable';
    const mem = Number(box?.memory_mib ?? box?.memoryMib);
    rows.push({
      id,
      kind: 'cloud',
      box: name,
      jobs: [],
      slots: Number(node.slots) || 1,
      status,
      available,
      reason: available
        ? raw === 'stopped' ? 'Stopped · warm, not billed' : 'Running'
        : (error || (raw ? `Sandbox status: ${raw}` : 'Sandbox not listed')),
      probedAt: now,
      stale: false,
      lastError: error,
      metrics: Number.isFinite(mem) && mem > 0
        ? { cpus: box?.cpus ?? null, mem_gb: Math.round((mem / 1024) * 10) / 10, disk_gb: null, load: null }
        : null,
      boxStatus: raw || null,
    });
  }
  if (cachePath && cacheDirty) writeJson(cachePath, { at: now, boxes: cachedBoxes });
  return rows;
}

export function workerKind(name: string, record: unknown): string {
  /** Authoritative kind for one worker id. */
  if (name === 'local') return 'local';
  const kind = record && typeof record === 'object' ? (record as Run).kind : null;
  return typeof kind === 'string' && kind.trim() ? kind : 'discovered';
}

export function mergeWorker(workers: Record<string, Run>, name: string, record: unknown): Run | null {
  /** Merge one worker record into the aggregation, tolerating partial input. */
  if (typeof name !== 'string' || !name) return null;
  let current = workers[name];
  if (!current || typeof current !== 'object') current = {};
  const fields = record && typeof record === 'object' ? (record as Run) : {};
  const merged: Run = { ...current, ...fields, id: name, kind: workerKind(name, { ...current, ...fields }) };
  const jobs = current.jobs;
  merged.jobs = Array.isArray(jobs) ? jobs : [];
  workers[name] = merged;
  return merged;
}

/* ------------------------------------------------------------------ *
 * Model source (lane config injection)
 * ------------------------------------------------------------------ */

export interface ModelSource {
  models: Record<string, Array<{ name: string | null; model: string | null; kind: string | null }>>;
  modelSnapshot: Run | null;
}

let modelSource: (() => ModelSource) | null = null;

/**
 * Wire the resolved lane configuration (T1.1) into status collection without a
 * hard import dependency. Python imported `llm` here; v2 keeps it injectable.
 */
export function setModelSource(fn: (() => ModelSource) | null): void {
  modelSource = fn;
}

/* ------------------------------------------------------------------ *
 * collect()
 * ------------------------------------------------------------------ */

export interface CollectOptions {
  root?: string;
  series?: string;
  log?: string;
  status?: string;
  now?: number;
  procs?: Record<number, Run>;
  listSandbox?: (name: string) => [Run | null, string | null];
  models?: Record<string, Array<{ name: string | null; model: string | null; kind: string | null }>>;
  modelSnapshot?: Run | null;
}

export function collectStatus(options: CollectOptions = {}): Run {
  const base = defaultPaths();
  const paths: Paths = {
    root: options.root ?? base.root,
    series: options.series ?? base.series,
    log: options.log ?? base.log,
    status: options.status ?? base.status,
  };
  const now = options.now ?? Date.now() / 1000;
  const procs = options.procs ?? processes(now);
  const runs = collectRuns(procs, now, paths);
  const calls = parseCalls(tail(paths.log));

  let models: Record<string, unknown> = options.models ?? {};
  let modelSnapshot: Run | null = options.modelSnapshot ?? null;
  if (options.models === undefined && modelSource) {
    try {
      const src = modelSource();
      models = src.models;
      modelSnapshot = src.modelSnapshot;
    } catch {
      models = {};
    }
  }

  const active = runs.filter((r) => r.alive && r.state === 'running');
  const shown = active.length ? active : runs.slice(0, 1);
  const activeSet = new Set(active);
  const workers: Record<string, Run> = {};
  for (const run of shown) {
    const runWorkers = run.workers && typeof run.workers === 'object' && !Array.isArray(run.workers) ? run.workers : {};
    for (const [name, worker] of Object.entries(runWorkers)) mergeWorker(workers, name, worker);
    for (const [name, ch] of Object.entries(run.chapters) as Array<[string, Run]>) {
      const host = ch.worker;
      const stages = Object.entries((ch.stages || {}) as Record<string, Run>)
        .filter(([, s]) => ['running', 'queued', 'retrying'].includes(s.state))
        .map(([k, s]) => ({ ...s, id: k }));
      if (host && stages.length && activeSet.has(run)) {
        let worker: Run | null = workers[host];
        if (!worker || typeof worker !== 'object') worker = mergeWorker(workers, host, { kind: 'discovered' });
        if (worker) worker.jobs.push({ series: run.series, chapter: name, stages });
      }
    }
    models = { ...models, ...(run.models || {}) };
  }
  mergeWorker(workers, 'local', { kind: 'local' });
  for (const worker of Object.values(workers)) {
    worker.status = worker.jobs.length
      ? 'busy'
      : active.length && worker.available === false
        ? 'unavailable'
        : 'idle';
    if (!active.length && worker.kind !== 'local') worker.status = 'last-seen';
  }
  const cloud = cloudLane(now, paths, options.listSandbox);
  if (cloud) {
    const current = workers[cloud.id];
    if (current && typeof current === 'object' && current.jobs?.length) {
      cloud.status = 'busy';
      cloud.jobs = current.jobs;
    }
    workers[cloud.id] = { ...(current || {}), ...cloud };
  }
  // Custom `docker-sbx` render nodes configured in Studio: `cloudLane` only
  // knows the MANHWA_RENDER_CLOUD box, so read render-nodes.json as well.
  const outDir = path.dirname(paths.status);
  const nodesDoc = readJson<Run>(path.join(outDir, 'config', 'render-nodes.json'));
  const nodes = Array.isArray(nodesDoc?.nodes) ? (nodesDoc!.nodes as Run[]) : [];
  if (nodes.length) {
    const cachedListing = readJson<Run>(path.join(outDir, 'cloud-list.json'));
    const listing = cachedListing && typeof cachedListing === 'object' ? cachedListing : { sandboxes: [] };
    // Probe the real `sbx` CLI only when the caller is online: an injected
    // `procs` without an injected `listSandbox` means an offline unit test, and
    // shelling out there would hang or invent state. Offline, an unlisted node
    // keeps reporting "Sandbox not listed" and nothing is cached.
    const online = options.listSandbox !== undefined || options.procs === undefined;
    const probeBoxes = options.listSandbox ?? listNamedSandbox;
    for (const row of configuredCloudWorkers(
      now,
      nodes,
      listing,
      online ? probeBoxes : () => [null, 'Sandbox not listed'],
      online ? outDir : undefined,
    )) {
      const current = workers[row.id];
      if (current && typeof current === 'object' && current.jobs?.length) {
        row.status = 'busy';
        row.jobs = current.jobs;
      }
      workers[row.id] = { ...(current || {}), ...row };
    }
  }
  const rank: Record<string, number> = { remote: 0, cloud: 1, local: 2 };

  let chapters = 0;
  let videos = 0;
  try {
    for (const sdir of fs.readdirSync(paths.series, { withFileTypes: true })) {
      if (!sdir.isDirectory()) continue;
      const out = path.join(paths.series, sdir.name, 'out');
      if (!fs.existsSync(out)) continue;
      for (const ch of fs.readdirSync(out, { withFileTypes: true })) {
        if (!/^ch\d+$/i.test(ch.name) || !ch.isDirectory()) continue;
        chapters += 1;
        const video = statFile(path.join(out, ch.name, 'video', 'video.mp4'));
        const inFlight = active.some(
          (r) => r.series === sdir.name && ch.name in r.chapters && !r.chapters[ch.name].complete,
        );
        if (video && video.bytes && !inFlight) videos += 1;
      }
    }
  } catch {
    // OSError: keep partial inventory
  }

  const last = calls.length ? calls[calls.length - 1] : null;
  const latest = Math.max(
    ...shown.map((r) => r.updatedAt).filter((n): n is number => Number.isFinite(n)),
    ...(last ? [last.endedAt].filter((n): n is number => Number.isFinite(n)) : []),
    0,
  );
  const running = active.length > 0;
  const state = running ? 'RUNNING' : 'IDLE';

  // Additive convenience fields (not in the Python payload) for in-process consumers.
  const providers: Record<string, unknown> = {};
  for (const run of shown) {
    if (run.providers && typeof run.providers === 'object') Object.assign(providers, run.providers);
  }
  const events: Run[] = [];
  for (const run of shown) {
    if (Array.isArray(run.events)) events.push(...run.events);
  }
  events.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  const logTail = tail(paths.log, 65536)
    .split('\n')
    .filter((l) => l.trim())
    .slice(-40)
    .map(scrub)
    .join('\n');

  return {
    schemaVersion: 2,
    at: now * 1000,
    state,
    running,
    // Long API calls/renders can be quiet: inactivity is a hint, not a false stall assertion.
    progress: running && now - latest < 900,
    lastAgeS: latest ? Math.trunc(now - latest) : null,
    lastLine: last ? `${last.tag} · ${last.provider} · ${last.state}` : null,
    series: active.length ? active[0].series : null,
    chapters,
    videos,
    runs,
    workers: Object.values(workers).sort(
      (a, b) => (rank[a.kind] ?? 1) - (rank[b.kind] ?? 1) || String(a.id || '').localeCompare(String(b.id || '')),
    ),
    models,
    modelSnapshot,
    recentCalls: calls.slice(-30),
    system: systemInfo(procs, runs, paths),
    stageOrder: [...STAGES],
    // Additive:
    active,
    recent: runs,
    calls,
    events: events.slice(-30),
    providers,
    cloud,
    logTail,
  };
}

/* ------------------------------------------------------------------ *
 * status.js — sampleRates + pipelineStatus
 * ------------------------------------------------------------------ */

export function sampleRates(snapshot: Run, prior?: Run | null): Run {
  const s = snapshot.system;
  const before = prior?.system;
  const seconds = prior ? (snapshot.at - prior.at) / 1000 : 0;
  const total = before ? s.cpuTicks.total - before.cpuTicks.total : 0;
  s.cpuPercent =
    total > 0 ? Math.max(0, Math.min(100, 100 * (1 - (s.cpuTicks.idle - before.cpuTicks.idle) / total))) : null;
  for (const nic of s.interfaces) {
    const old = before?.interfaces.find((n: Run) => n.name === nic.name);
    nic.rxPerSecond = old && seconds > 0 && nic.rx >= old.rx ? (nic.rx - old.rx) / seconds : null;
    nic.txPerSecond = old && seconds > 0 && nic.tx >= old.tx ? (nic.tx - old.tx) / seconds : null;
  }
  for (const proc of s.processes) {
    const old = before?.processes.find((p: Run) => p.pid === proc.pid && p.startTicks === proc.startTicks);
    proc.cpuPercent =
      old && seconds > 0 && proc.ticks >= old.ticks
        ? (100 * (proc.ticks - old.ticks)) / s.clockTicks / seconds
        : null;
  }
  return snapshot;
}

let cached: Run | null = null;
let pending: Promise<Run> | null = null;
let previous: Run | null = null;

// One bounded probe per interval, shared by every client and the library nav dot.
export function pipelineStatus(options: CollectOptions = {}): Promise<Run> {
  if (cached && Date.now() - cached.at < 4000) return Promise.resolve(cached);
  if (pending) return pending;
  let result: Promise<Run>;
  try {
    // In-process collection is synchronous; resolve immediately on success.
    const fresh = collectStatus(options);
    sampleRates(fresh, previous);
    previous = fresh;
    cached = fresh;
    result = Promise.resolve(fresh);
  } catch (err) {
    // Preserve last measurement with explicit staleness, never fabricate zeros.
    result = cached
      ? Promise.resolve({ ...cached, stale: true, error: 'Status collector unavailable' })
      : Promise.reject(err);
  }
  pending = result.finally(() => {
    pending = null;
  });
  return pending;
}

/** Test-only: forget the cached/prior measurements. */
export function _resetStatusCache(): void {
  cached = null;
  pending = null;
  previous = null;
}

export default collectStatus;
