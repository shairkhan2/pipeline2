const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const labels = { reader: 'Read', writer: 'Write', check: 'Check', audio: 'Voice', clean: 'Clean', timeline: 'Stage', render: 'Render' };
const longLabels = { reader: 'Reading panels', writer: 'Writing the story', check: 'Checking the script', audio: 'Preparing narration', clean: 'Cleaning artwork', timeline: 'Building the timeline', render: 'Rendering video' };
const states = new Set(['running', 'busy', 'done', 'completed', 'idle', 'queued', 'retrying', 'failed', 'warning', 'interrupted', 'skipped', 'unavailable', 'last-seen', 'paused']);
let data = null;
let selectedRun = null;
let paused = false;
let inFlight = false;
let timer;
const history = [];

let lanesState = null;
let lanesError = '';
let draftConfig = null;
let draftBaseRevision = 0;
let draftDirty = false;
let renderEditorOpen = false;
let modelEditorOpen = false;
let laneMutationInFlight = false;
let resetConfirmOpen = false;
let saveConfirmOpen = false;
let editorError = '';
let renderBoundsNote = '';
let modelBoundsNote = '';
let conflictState = null;
let laneBanner = null;

function bytes(value, decimals = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Math.max(0, Number(value));
  const unit = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0;
  return `${(n / 1024 ** unit).toFixed(unit ? decimals : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
function duration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + 's';
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
function percent(value) { return value == null || !Number.isFinite(value) ? '—' : Math.max(0, Math.min(100, value)).toFixed(0) + '%'; }
function clock(at) { return at ? new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'stdout'; }
function age(at) { return at ? duration(Date.now() / 1000 - at) + ' ago' : 'Not reported'; }
function number(n) { return n == null ? '—' : Number(n).toLocaleString(); }
function title(s) { return String(s || '').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); }
function pill(state, text) { return `<span class="pill ${states.has(state) ? state : ''}">${esc(text || title(state))}</span>`; }
function updateHTML(id, html) { if ($(id).innerHTML !== html) $(id).innerHTML = html; }
function sparkline(key) {
  const points = history.map((h) => h[key]).filter((v) => v != null);
  if (points.length < 2) return '<span>Collecting samples</span>';
  const max = key === 'network' ? Math.max(...points, 1) : 100;
  const coords = points.map((n, i) => `${(i / (points.length - 1) * 85).toFixed(1)},${(24 - Math.min(n / max, 1) * 21).toFixed(1)}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 85 26" aria-label="Recent measured ${esc(key)} trend" role="img"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function meter(value) { return `<div class="mini-progress"><i style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i></div>`; }
function currentRun() { return data.runs.find((r) => r.id === selectedRun) || data.runs[0] || null; }
function activeStages(run) {
  if (!run?.alive || run.state !== 'running') return [];
  return Object.entries(run.chapters).flatMap(([ch, row]) => Object.entries(row.stages).filter(([, s]) => s.state === 'running').map(([stage, s]) => ({ ch, stage, ...s })));
}

function batteryView(b) {
  if (!b || !Number.isFinite(Number(b.percent))) return null;
  const pct = Math.max(0, Math.min(100, Number(b.percent)));
  const charging = b.status === 'Charging';
  const discharging = b.status === 'Discharging';
  const full = b.status === 'Full' || (pct >= 100 && b.ac === true);
  const state = full ? 'Full' : charging ? 'Charging' : discharging ? 'On battery' : b.status === 'Not charging' ? 'Not charging' : 'Battery';
  const power = b.ac === true ? 'Plugged in' : b.ac === false ? 'Unplugged' : '';
  const remain = Number.isFinite(Number(b.seconds)) ? (charging ? `${duration(b.seconds)} to full` : discharging ? `${duration(b.seconds)} left` : '') : '';
  return { pct, state, power, remain, tone: pct <= 15 ? 'low' : pct <= 30 && discharging ? 'mid' : '' };
}
function renderSystem() {
  const s = data.system;
  const used = s.memory.total - s.memory.available;
  const memoryPercent = used / s.memory.total * 100;
  const diskPercent = (s.disk.total - s.disk.free) / s.disk.total * 100;
  const knownNetwork = s.interfaces.some((i) => i.rxPerSecond != null);
  const rx = knownNetwork ? s.interfaces.reduce((n, i) => n + (i.rxPerSecond || 0), 0) : null;
  const tx = knownNetwork ? s.interfaces.reduce((n, i) => n + (i.txPerSecond || 0), 0) : null;
  const battery = batteryView(s.battery);
  if (!history.length || history[history.length - 1].at !== data.at) {
    history.push({ at: data.at, cpu: s.cpuPercent, memory: memoryPercent, network: rx });
    if (history.length > 13) history.shift();
  }
  const card = (label, ico, value, subtitle, bottom) => `<article class="metric-card"><div class="metric-top"><span class="metric-label">${label}</span>${icon(ico)}</div><div class="metric-value">${value}</div><p>${subtitle}</p>${bottom}</article>`;
  const batteryCard = battery ? `<article class="metric-card battery${battery.tone ? ' ' + battery.tone : ''}"><div class="battery-main"><span class="battery-icon">${icon('battery')}</span><div class="battery-copy"><span class="metric-label">BATTERY</span><p>${esc([battery.state, battery.power].filter(Boolean).join(' · '))}</p></div><div class="battery-readout"><div class="metric-value">${percent(battery.pct)}</div>${battery.remain ? `<span class="battery-remain">${esc(battery.remain)}</span>` : ''}</div></div><div class="metric-gauge ${battery.tone}" role="meter" aria-label="Battery charge" aria-valuenow="${Math.round(battery.pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${battery.pct}%"></i></div></article>` : '';
  updateHTML('systemMetrics',
    card('CPU USAGE', 'cpu', percent(s.cpuPercent), `${s.cores} logical cores · system-wide`, `<div class="metric-bottom"><span>Load ${s.load[0].toFixed(2)}</span>${sparkline('cpu')}</div>`) +
    card('MEMORY', 'memory', `${bytes(used)}<small>/ ${bytes(s.memory.total)}</small>`, `${percent(memoryPercent)} in use · ${bytes(s.memory.available)} available`, `<div class="metric-bottom"><span>RAM</span>${sparkline('memory')}</div>`) +
    card('STORAGE', 'disk', `${bytes(s.disk.available)}<small>available</small>`, `${bytes(s.disk.total)} total · output filesystem`, `<div class="metric-gauge" role="meter" aria-label="Disk used" aria-valuenow="${Math.round(diskPercent)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${diskPercent}%"></i></div><div class="metric-bottom"><span>${percent(diskPercent)} used</span></div>`) +
    card('NETWORK', 'network', `${bytes(rx)}<small>/ second received</small>`, `↑ ${bytes(tx)}/s sent`, `<div class="metric-bottom"><span>All interfaces</span>${sparkline('network')}</div>`) +
    batteryCard);
  $('hostSummary').textContent = `${s.hostname} · ${s.cores} cores · up ${duration(s.uptime)}`;
  const procs = [...s.processes].sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0));
  const batteryMeta = battery ? `<span><b>BATTERY</b>${percent(battery.pct)} · ${esc([battery.state, battery.power, battery.remain].filter(Boolean).join(' · '))}</span>` : '';
  updateHTML('hostContent', `<div class="host-meta"><span><b>LOAD AVERAGE · 1 / 5 / 15 MIN</b>${s.load.map((v) => v.toFixed(2)).join(' / ')}</span><span><b>SWAP IN USE</b>${bytes(s.memory.swapTotal - s.memory.swapFree)} / ${bytes(s.memory.swapTotal)}</span><span><b>PIPELINE PROCESS RSS</b>${bytes(procs.reduce((n, p) => n + p.rss, 0))}</span>${batteryMeta}<span><b>NETWORK INTERFACES</b>${s.interfaces.map((i) => esc(i.name)).join(', ') || 'None'}</span></div>
    <div class="table-wrap"><table class="process-table"><thead><tr><th>PID</th><th>Pipeline process</th><th>CPU</th><th>Memory (RSS)</th></tr></thead><tbody>${procs.slice(0, 12).map((p) => `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.cpuPercent == null ? 'Sampling…' : p.cpuPercent.toFixed(1) + '%'}</td><td>${bytes(p.rss)}</td></tr>`).join('') || '<tr><td colspan="4">No active pipeline processes.</td></tr>'}</tbody></table></div><p class="host-caption">Process CPU uses one core = 100%. RSS includes shared pages. Network totals include virtual interfaces.</p>`);
}

function stageDetail(stage) {
  const parts = [];
  if (stage.total) parts.push(stage.completed == null ? `${number(stage.total)} ${stage.unit || ''} to process` : `${number(stage.completed)} / ${number(stage.total)} ${stage.unit || ''}`);
  if (stage.phase) parts.push(stage.phase);
  if (stage.startedAt && stage.state === 'running') parts.push(duration(Date.now() / 1000 - stage.startedAt));
  if (stage.note) parts.push(stage.note);
  return parts.join(' · ');
}
function runManageHref(run) {
  const jobId = typeof run?.jobId === 'string' ? run.jobId.trim() : '';
  const series = typeof run?.series === 'string' ? run.series.trim() : (typeof run?.slug === 'string' ? run.slug.trim() : '');
  if (jobId && series) return `/new-series.html?job=${encodeURIComponent(jobId)}&series=${encodeURIComponent(series)}`;
  if (jobId) return `/new-series.html?job=${encodeURIComponent(jobId)}`;
  if (series) return `/new-series.html?series=${encodeURIComponent(series)}`;
  return '';
}
function renderProgress(run) {
  const options = data.runs.map((r) => `<option value="${esc(r.id)}" ${r.id === run?.id ? 'selected' : ''}>${esc(r.title)} · ${r.alive && r.state === 'running' ? 'live' : title(r.state)}</option>`).join('');
  updateHTML('runSelect', options);
  $('runSelect').hidden = data.runs.length < 2;
  if (!run) {
    updateHTML('runProgress', `<div class="dashboard-empty"><h3>A quiet moment in the studio.</h3><p>No pipeline run is active. Start a run as usual and its chapters, model calls, and render workers will appear here automatically.</p><div class="empty-actions"><a class="btn" href="/">Back to library ${icon('arrow')}</a><a class="btn" href="/new-series.html">Manage runs ${icon('arrow')}</a></div></div>`);
    return;
  }
  const active = activeStages(run);
  const progress = run.total ? run.completed / run.total * 100 : 0;
  const activity = active.map((s) => `${s.ch} · ${longLabels[s.stage] || title(s.stage)}`).join(' / ');
  const manageHref = runManageHref(run);
  const needsRecovery = ['failed', 'interrupted'].includes(run.state);
  const manageLabel = needsRecovery ? 'Recover run' : 'Manage run';
  const order = [...new Set([...data.stageOrder.filter((s) => run.video || ['reader', 'writer', 'check'].includes(s)), ...Object.values(run.chapters).flatMap((c) => Object.keys(c.stages))])];
  const rows = Object.entries(run.chapters).map(([ch, row]) => {
    const stages = row.stages;
    const doing = Object.entries(stages).filter(([, s]) => ['running', 'retrying', 'failed', 'interrupted'].includes(s.state));
    const render = stages.render || {};
    const notes = doing.map(([name, stage]) => `${longLabels[name] || title(name)}${stageDetail(stage) ? ' · ' + stageDetail(stage) : ''}`);
    if (render.state === 'done') notes.push(`${duration(render.duration)} video · ${duration(render.wallSeconds)} render time`);
    if (row.audioFiles != null) notes.push(`${row.audioFiles} audio line files on disk`);
    if (row.artifacts.video?.bytes) notes.push(`${bytes(row.artifacts.video.bytes)} video${row.complete ? '' : ' on disk (in progress)'}`);
    const findings = stages.check?.findings ?? row.findings;
    return `<div class="chapter-row"><div class="chapter-line"><div class="chapter-name">Chapter ${esc(ch.replace(/^ch/i, ''))}<span class="small-state${row.complete ? ' ready' : ''}">${row.complete ? 'Complete' : doing.length ? title(doing[0][1].state) : 'Waiting'}</span></div>
      <div class="stage-track" style="--stage-count:${order.length}">${order.map((key) => {
        const stage = stages[key] || { state: 'pending' };
        const state = states.has(stage.state) ? stage.state : 'pending';
      const mark = state === 'done' ? icon('check') : state === 'running' ? '<span class="running-dot"></span>' : ['failed', 'interrupted', 'warning'].includes(state) ? '!' : state === 'queued' || state === 'retrying' ? icon('clock') : '—';
        const label = `${title(key)}: ${state}${stageDetail(stage) ? ', ' + stageDetail(stage) : ''}`;
        return `<div class="stage-step ${state}" title="${esc(label)}" aria-label="${esc(label)}"><span class="step-mark" aria-hidden="true">${mark}</span>${esc(labels[key] || title(key))}</div>`;
      }).join('')}</div></div><div class="chapter-detail"><span>${esc(notes.join(' · ') || (row.complete ? 'Finished this run' : 'Waiting for its turn'))}${findings ? ` <span class="issue-note">· ${findings} script findings</span>` : ''}</span>${row.complete && run.video ? `<a class="text-link" href="/#/watch/${encodeURIComponent(run.series)}/${encodeURIComponent(ch)}">Watch ${icon('arrow')}</a>` : ''}</div></div>`;
  }).join('');
  updateHTML('runProgress', `<div class="run-overview"><span class="eyebrow">${run.alive && run.state === 'running' ? 'ON THE PRODUCTION FLOOR' : 'LATEST RUN'} · ${esc(title(run.state))}</span><div class="run-topline"><div><h3 class="run-title">${esc(run.title)}</h3><div class="run-meta"><span>${icon('clock')} ${duration(run.elapsed)} elapsed</span><span>PID ${run.pid}</span><span>${run.video ? 'Script + video' : 'Script lane'}${run.captionVersion ? ' · captions v' + run.captionVersion : ''}</span></div></div><div class="run-fraction"><strong>${run.completed}</strong> / ${run.total}<span>chapters complete</span></div></div><div class="run-progress-track" role="progressbar" aria-label="Completed chapters" aria-valuemin="0" aria-valuemax="${Math.max(1, run.total)}" aria-valuenow="${run.completed}"><i style="width:${progress}%"></i></div><div class="run-progress-caption"><span>${esc(activity || (run.state === 'completed' ? 'Run finished' : run.alive ? 'Waiting for the next reported stage' : 'Run is no longer active'))}</span><span>${run.source === 'telemetry' ? 'Live telemetry' : 'Observed from ' + run.source}</span></div>${manageHref ? `<div class="run-actions"><a class="btn small${needsRecovery ? ' primary' : ''}" id="manageRunLink" data-manage-run="${esc(run.series || run.jobId || '')}" href="${esc(manageHref)}">${manageLabel} ${icon('arrow')}</a></div>` : ''}</div>
    ${run.source !== 'telemetry' ? '<div class="source-note">This run started before live telemetry was enabled. Stage transitions come from its log; model activity below shows completed calls, not an assumed in-flight request.</div>' : ''}
    ${rows || '<div class="dashboard-empty">Chapter selection has not been reported yet.</div>'}`);
}

function catalogRenderById(id) {
  return (lanesState?.catalog?.render || []).find((r) => r.id === id) || null;
}
function catalogModelById(id) {
  return (lanesState?.catalog?.models || []).find((m) => m.id === id) || null;
}
function cloneConfig(cfg) {
  const src = cfg || lanesState?.config || lanesState?.defaults || { render: [], models: { vision: [], writer: [] } };
  return {
    render: (src.render || []).map((r) => ({
      id: String(r.id),
      enabled: Boolean(r.enabled),
      slots: Number(r.slots) || 1,
    })),
    models: {
      vision: (src.models?.vision || []).map((m) => ({
        id: String(m.id),
        enabled: Boolean(m.enabled),
        concurrency: Number(m.concurrency) || 1,
      })),
      writer: (src.models?.writer || []).map((m) => ({
        id: String(m.id),
        enabled: Boolean(m.enabled),
        concurrency: Number(m.concurrency) || 1,
      })),
    },
  };
}
function friendlyLaneMessage(raw, fallback) {
  const s = String(raw || '').trim();
  if (!s || /<html|<!doctype|traceback|econnreset|etimedout|\bat\s+[\w.$]+\s*\(|\(\/.*:\d+:\d+\)/i.test(s)) return fallback;
  return s.slice(0, 260);
}
function ensureDraftStarted() {
  if (!draftConfig && lanesState) {
    draftConfig = cloneConfig(lanesState.config);
    draftBaseRevision = Number.isInteger(lanesState.revision) ? lanesState.revision : 0;
    draftDirty = false;
  }
}
function getEnvEnabledLaneIds() {
  const policy = lanesState?.renderRuntime?.policy;
  const ids = new Set();
  if (policy && typeof policy === 'object') {
    if (policy.envRenderSwitches && typeof policy.envRenderSwitches === 'object') {
      for (const [k, v] of Object.entries(policy.envRenderSwitches)) {
        if (v) ids.add(String(k));
      }
    }
    if (Array.isArray(policy.envEnabledButDisabled)) {
      for (const id of policy.envEnabledButDisabled) {
        if (id) ids.add(String(id));
      }
    }
  }
  return ids;
}
function getAffectedEnvLanesForRenderList(renderList) {
  const envIds = getEnvEnabledLaneIds();
  if (!envIds.size) return [];
  const list = Array.isArray(renderList) ? renderList : [];
  return list
    .filter((r) => r && !r.enabled && envIds.has(String(r.id)))
    .map((r) => String(r.id));
}
function formatLaneListWithIds(laneIds) {
  return laneIds
    .map((id) => {
      const cat = catalogRenderById(id);
      return cat?.label ? `${cat.label} (${id})` : id;
    })
    .join(', ');
}
function renderLaneNotice(id, notice) {
  const el = $(id);
  if (!el) return;
  if (!notice || !notice.text) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'lane-notice';
    return;
  }
  el.hidden = false;
  el.className = 'lane-notice' + (notice.kind ? ' ' + notice.kind : '');
  el.innerHTML = `<span>${esc(notice.text)}</span><button type="button" class="btn small" data-action="dismiss-lane-notice">Dismiss</button>`;
}
function renderLanePolicies() {
  const renderBar = $('renderPolicySummary');
  const modelBar = $('modelPolicySummary');
  const cfgRenderBtn = $('configureRenderBtn');
  const cfgModelsBtn = $('configureModelsBtn');
  if (!renderBar || !modelBar) return;

  if (!lanesState) {
    if (cfgRenderBtn) cfgRenderBtn.hidden = true;
    if (cfgModelsBtn) cfgModelsBtn.hidden = true;
    if (lanesError) {
      renderBar.hidden = false;
      renderBar.innerHTML = `<div class="policy-head"><span class="policy-label">Configured render policy</span><span class="policy-meta">${esc(lanesError)}</span><button type="button" class="btn small" data-action="retry-load-lanes">Retry</button></div>`;
      modelBar.hidden = false;
      modelBar.innerHTML = `<div class="policy-head"><span class="policy-label">Configured model policy</span><span class="policy-meta">${esc(lanesError)}</span><button type="button" class="btn small" data-action="retry-load-lanes">Retry</button></div>`;
    }
    return;
  }

  const privileged = Boolean(lanesState.privileged);
  if (!privileged && (renderEditorOpen || modelEditorOpen)) {
    renderEditorOpen = false;
    modelEditorOpen = false;
    draftConfig = null;
    draftDirty = false;
    $('renderConfigPanel').hidden = true;
    $('modelConfigPanel').hidden = true;
  }
  if (cfgRenderBtn) {
    cfgRenderBtn.hidden = !privileged;
    cfgRenderBtn.setAttribute('aria-expanded', String(privileged && renderEditorOpen));
    cfgRenderBtn.textContent = renderEditorOpen ? 'Close' : 'Configure';
  }
  if (cfgModelsBtn) {
    cfgModelsBtn.hidden = !privileged;
    cfgModelsBtn.setAttribute('aria-expanded', String(privileged && modelEditorOpen));
    cfgModelsBtn.textContent = modelEditorOpen ? 'Close' : 'Configure';
  }

  const rt = lanesState.runtimeIntegration || {};
  const cfg = lanesState.config || lanesState.defaults || { render: [], models: { vision: [], writer: [] } };
  const appliesText = (lanesState.appliesTo === 'next-run' || rt.appliesTo === 'next-run' || !lanesState.appliesTo)
    ? 'Applies to new runs'
    : `Applies: ${lanesState.appliesTo}`;
  const revLabel = lanesState.source === 'persisted' && lanesState.persistedValid
    ? `Saved policy · rev ${lanesState.revision}`
    : lanesState.source === 'invalid_persisted'
      ? `Defaults active (invalid saved file · rev ${lanesState.revision})`
      : `Default policy · rev ${lanesState.revision}`;
  const renderRtText = rt.renderSchedulerIntegrated
    ? (rt.renderLanesActive ? 'Render scheduler wired · custom active for new runs' : 'Render scheduler wired')
    : 'Render scheduler wiring in progress';
  const modelRtText = rt.modelLanesIntegrated
    ? (rt.modelLanesActive ? 'Model runtime wired · custom active for new runs' : 'Model runtime wired')
    : 'Model runtime wiring in progress';

  let enabledRank = 0;
  const renderChips = (cfg.render || []).map((r) => {
    const cat = catalogRenderById(r.id);
    const label = cat?.label || r.id;
    const minSlots = cat?.minSlots ?? 1;
    const maxSlots = cat?.maxSlots ?? 1;
    const fixedCap = minSlots === maxSlots;
    const capText = fixedCap
      ? `${r.slots} ${r.slots === 1 ? 'slot' : 'slots'} (fixed capacity)`
      : `${r.slots} / ${maxSlots} ${maxSlots === 1 ? 'slot' : 'slots'}`;
    const slotText = `${capText}${cat?.costTier === 'paid-opt-in' ? ' · paid opt-in' : ''}`;
    if (r.enabled) {
      enabledRank += 1;
      const rankTag = enabledRank === 1 ? 'Primary' : `Fallback ${enabledRank - 1}`;
      return `<li class="policy-chip enabled" data-policy-render="${esc(r.id)}"><span class="chip-rank">${esc(rankTag)}</span><strong>${esc(label)}</strong><span class="chip-meta">${esc(slotText)}</span></li>`;
    }
    return `<li class="policy-chip disabled" data-policy-render="${esc(r.id)}"><span class="chip-rank">Off</span><strong>${esc(label)}</strong><span class="chip-meta">${esc(slotText)}</span></li>`;
  }).join('');

  const configErrHtml = lanesState.configError
    ? `<div class="policy-config-error" role="alert"><span>${esc(lanesState.configError)}</span>${privileged ? '<button type="button" class="btn small danger" data-action="repair-reset-lanes">Reset to defaults</button>' : ''}</div>`
    : '';
  const readonlyBadge = !privileged
    ? `<span class="pill readonly-pill" data-readonly-badge>Temporary account · read-only</span>`
    : '';
  const envDisabledIds = Array.isArray(lanesState.renderRuntime?.policy?.envEnabledButDisabled)
    ? lanesState.renderRuntime.policy.envEnabledButDisabled
    : [];
  const envDisabledNoteHtml = envDisabledIds.length
    ? `<p class="policy-unavail-note" id="envDisabledRenderSummary" data-env-disabled-summary><strong>Environment-configured lane disabled by saved policy (${esc(envDisabledIds.join(', '))}):</strong> ${esc(formatLaneListWithIds(envDisabledIds))} is configured in the server environment but disabled by the saved render policy.</p>`
    : '';

  renderBar.hidden = false;
  updateHTML('renderPolicySummary', `
    <div class="policy-head">
      <span class="policy-label">Configured render policy</span>
      <span class="pill policy-pill">${esc(appliesText)}</span>
      <span class="policy-meta">${esc(revLabel)} · ${esc(renderRtText)}</span>
      ${readonlyBadge}
      <span class="policy-note">Live worker cards below show observed telemetry, separate from saved policy.</span>
    </div>
    ${configErrHtml}
    <ol class="policy-chain">${renderChips}</ol>
    ${envDisabledNoteHtml}
  `);

  const unavail = lanesState.catalog?.unavailableModels || [];
  const unavailReason = unavail[0]?.reason || '';
  const unavailNames = unavail.map((u) => u.id).join(', ');
  const unavailSummaryHtml = unavail.length
    ? `<p class="policy-unavail-note" id="unavailableModelsSummary"><strong>Unavailable (${esc(unavailNames)}):</strong> ${esc(unavailReason)}</p>`
    : '';

  const roleSummaries = ['vision', 'writer'].map((role) => {
    const chain = cfg.models?.[role] || [];
    const enabled = chain.filter((m) => m.enabled);
    const primary = enabled[0];
    const pCat = primary ? catalogModelById(primary.id) : null;
    const pLabel = pCat ? `${pCat.name} / ${pCat.model}` : (primary?.id || 'None');
    const fbCount = Math.max(0, enabled.length - 1);
    const concText = primary && primary.concurrency > 1 ? ` · ${primary.concurrency}×` : '';
    return `<li class="policy-chip enabled" data-policy-role="${esc(role)}"><span class="chip-rank">${esc(title(role))}</span><strong>${esc(pLabel)}${esc(concText)}</strong><span class="chip-meta">${fbCount} ${fbCount === 1 ? 'fallback' : 'fallbacks'}</span></li>`;
  }).join('');

  modelBar.hidden = false;
  updateHTML('modelPolicySummary', `
    <div class="policy-head">
      <span class="policy-label">Configured model policy</span>
      <span class="pill policy-pill">${esc(appliesText)}</span>
      <span class="policy-meta">${esc(revLabel)} · ${esc(modelRtText)}</span>
      ${readonlyBadge}
    </div>
    <ul class="policy-chain">${roleSummaries}</ul>
    ${unavailSummaryHtml}
  `);

  renderLaneNotice('renderConfigNotice', laneBanner && (laneBanner.section === 'render' || laneBanner.section === 'both') ? laneBanner : null);
  renderLaneNotice('modelConfigNotice', laneBanner && (laneBanner.section === 'models' || laneBanner.section === 'both') ? laneBanner : null);
}

function editorAlertBarsHtml(section) {
  const conflictRev = conflictState?.currentRevision ?? lanesState?.revision ?? draftBaseRevision;
  const conflictHtml = conflictState
    ? `<div class="lane-conflict-bar" role="alert" data-lane-conflict>
        <div><strong>Revision conflict (server at rev ${esc(conflictRev)}, draft started at rev ${esc(draftBaseRevision)}).</strong> ${esc(conflictState.message || 'Settings changed in another session.')} Your draft edits are preserved.</div>
        <div class="lane-conflict-actions">
          <button type="button" class="btn small primary" data-action="conflict-review-draft">Review &amp; keep draft (use rev ${esc(conflictRev)})</button>
          <button type="button" class="btn small" data-action="conflict-reload-server">Reload server settings</button>
        </div>
      </div>`
    : '';
  const errorHtml = editorError
    ? `<div class="lane-error-bar" role="alert" data-lane-error><span>${esc(editorError)}</span></div>`
    : '';
  const boundsNote = section === 'render' ? renderBoundsNote : modelBoundsNote;
  const boundsHtml = boundsNote
    ? `<div class="lane-bounds-bar" role="status" data-lane-bounds><span>${esc(boundsNote)}</span></div>`
    : '';
  const saveAffectedEnv = draftConfig ? getAffectedEnvLanesForRenderList(draftConfig.render) : [];
  const saveConfirmHtml = saveConfirmOpen && saveAffectedEnv.length
    ? `<div class="lane-confirm-bar" role="alert" data-save-confirm>
        <span>Saving this global policy will disable environment-enabled render lane(s): <strong>${esc(formatLaneListWithIds(saveAffectedEnv))}</strong>. Model and render settings are saved together for new runs.</span>
        <div class="lane-confirm-actions">
          <button type="button" class="btn small primary" id="${section === 'render' ? 'keepEnvSaveRenderBtn' : 'keepEnvSaveModelBtn'}" data-action="save-keep-env-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Keep ${esc(saveAffectedEnv.join(', '))} enabled &amp; save</button>
          <button type="button" class="btn small danger" id="${section === 'render' ? 'confirmSaveRenderBtn' : 'confirmSaveModelBtn'}" data-action="confirm-save-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Confirm save (disable ${esc(saveAffectedEnv.join(', '))})</button>
          <button type="button" class="btn small" id="${section === 'render' ? 'cancelSaveConfirmRenderBtn' : 'cancelSaveConfirmModelBtn'}" data-action="cancel-save-confirm" ${laneMutationInFlight ? 'disabled' : ''}>Back to draft</button>
        </div>
      </div>`
    : '';
  const resetAffectedEnv = getAffectedEnvLanesForRenderList(lanesState?.defaults?.render);
  const resetEnvWarn = resetAffectedEnv.length
    ? ` Warning: resetting to factory defaults will disable environment-enabled render lane(s): ${formatLaneListWithIds(resetAffectedEnv)}.`
    : '';
  const resetConfirmHtml = resetConfirmOpen
    ? `<div class="lane-confirm-bar" role="alert" data-reset-confirm>
        <span>Reset render and model lane policy to factory defaults?${esc(resetEnvWarn)} Applies to new runs only.</span>
        <div class="lane-confirm-actions">
          <button type="button" class="btn small danger" id="${section === 'render' ? 'confirmResetRenderBtn' : 'confirmResetModelBtn'}" data-action="confirm-reset-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Confirm reset</button>
          <button type="button" class="btn small" id="${section === 'render' ? 'cancelResetRenderBtn' : 'cancelResetModelBtn'}" data-action="cancel-reset-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Keep current</button>
        </div>
      </div>`
    : '';
  return { conflictHtml, errorHtml, boundsHtml, saveConfirmHtml, resetConfirmHtml };
}

function editorFooterHtml(section) {
  const pfx = section === 'render' ? 'Render' : 'Model';
  return `<div class="lane-editor-footer">
    <span class="lane-rev-note" data-rev-status>Base revision ${esc(draftBaseRevision)}${draftDirty ? ' · Unsaved draft edits' : ' · Saved state'} · Applies to new runs</span>
    <div class="lane-editor-actions">
      <button type="button" class="btn small" id="reset${pfx}LanesBtn" data-action="reset-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Reset to defaults</button>
      <button type="button" class="btn small" id="cancel${pfx}LanesBtn" data-action="cancel-lanes" ${laneMutationInFlight ? 'disabled' : ''}>Cancel</button>
      <button type="button" class="btn small primary" id="save${pfx}LanesBtn" data-action="save-lanes" ${laneMutationInFlight ? 'disabled' : ''}>${laneMutationInFlight ? 'Saving…' : 'Save changes'}</button>
    </div>
  </div>`;
}

function renderRenderEditor() {
  const panel = $('renderConfigPanel');
  if (!panel) return;
  if (!renderEditorOpen || !lanesState?.privileged || !draftConfig) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const rt = lanesState.runtimeIntegration || {};
  const rtHint = rt.renderSchedulerIntegrated
    ? 'Render scheduler is wired; saved order and slot limits apply to new runs.'
    : 'Saved order and slot limits are persisted now and apply to new runs (render scheduler wiring in progress).';
  const { conflictHtml, errorHtml, boundsHtml, saveConfirmHtml, resetConfirmHtml } = editorAlertBarsHtml('render');

  let enabledRank = 0;
  const rows = draftConfig.render.map((entry, idx) => {
    const cat = catalogRenderById(entry.id);
    const label = cat?.label || entry.id;
    const minSlots = cat?.minSlots ?? 1;
    const maxSlots = cat?.maxSlots ?? 1;
    const fixedSlots = minSlots === maxSlots;
    const slotLabelHtml = fixedSlots
      ? `Capacity <small>(${maxSlots} ${maxSlots === 1 ? 'slot' : 'slots'} fixed)</small>`
      : `Slots <small>(${minSlots}–${maxSlots})</small>`;
    const desc = cat?.description || '';
    const isPaid = cat?.costTier === 'paid-opt-in';
    if (entry.enabled) enabledRank += 1;
    const rankText = entry.enabled ? (enabledRank === 1 ? 'Primary' : `Fallback ${enabledRank - 1}`) : 'Disabled';
    const isPrimary = entry.enabled && enabledRank === 1;
    return `<div class="lane-edit-row${entry.enabled ? '' : ' is-disabled'}" role="listitem" data-render-lane="${esc(entry.id)}" data-index="${idx}">
      <div class="lane-edit-main">
        <span class="lane-rank-badge${isPrimary ? ' primary' : ''}" data-lane-rank>${esc(rankText)}</span>
        <div class="lane-edit-copy">
          <strong>${esc(label)} <code class="lane-id">${esc(entry.id)}</code>${isPaid ? '<span class="cost-badge">Paid opt-in</span>' : ''}</strong>
          ${desc ? `<span class="lane-desc">${esc(desc)}</span>` : ''}
        </div>
      </div>
      <div class="lane-edit-controls">
        <label class="lane-toggle">
          <input type="checkbox" data-render-enable="${esc(entry.id)}" ${entry.enabled ? 'checked' : ''} aria-label="Enable ${esc(label)}">
          <span>${entry.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
        <label class="lane-num-label" data-slot-mode="${fixedSlots ? 'fixed' : 'range'}">
          <span>${slotLabelHtml}</span>
          <input type="number" class="lane-num-input" data-render-slots="${esc(entry.id)}" min="${minSlots}" max="${maxSlots}" step="1" value="${entry.slots}" ${fixedSlots ? 'readonly aria-readonly="true"' : ''} aria-label="${esc(label)} slots (${fixedSlots ? `${maxSlots} fixed` : `${minSlots} to ${maxSlots}`})">
        </label>
        <div class="lane-move-group" role="group" aria-label="Reorder ${esc(label)}">
          <button type="button" class="btn small lane-move-btn" data-render-move="up" data-lane-id="${esc(entry.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${esc(label)} up">↑ Up</button>
          <button type="button" class="btn small lane-move-btn" data-render-move="down" data-lane-id="${esc(entry.id)}" ${idx === draftConfig.render.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(label)} down">↓ Down</button>
          <button type="button" class="btn small lane-move-btn" data-render-move="primary" data-lane-id="${esc(entry.id)}" ${idx === 0 && entry.enabled ? 'disabled' : ''} aria-label="Make ${esc(label)} primary">Make primary</button>
        </div>
      </div>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="lane-editor-head">
      <div>
        <h3 id="renderEditorHeading">Configure render lane policy</h3>
        <p>${esc(rtHint)} Active workers are never interrupted.</p>
      </div>
      <span class="pill policy-pill">Applies to new runs</span>
    </div>
    ${conflictHtml}
    ${errorHtml}
    ${boundsHtml}
    <div class="lane-editor-list" role="list" id="renderLaneEditorList">${rows}</div>
    ${saveConfirmHtml}
    ${resetConfirmHtml}
    ${editorFooterHtml('render')}
  `;
}

function renderModelEditor() {
  const panel = $('modelConfigPanel');
  if (!panel) return;
  if (!modelEditorOpen || !lanesState?.privileged || !draftConfig) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const catalog = lanesState.catalog || {};
  const globalBounds = catalog.modelConcurrencyBounds || { min: 1, max: 4, default: 1 };
  const { conflictHtml, errorHtml, boundsHtml, saveConfirmHtml, resetConfirmHtml } = editorAlertBarsHtml('models');

  const roleCards = ['vision', 'writer'].map((role) => {
    const list = draftConfig.models[role] || [];
    const presentIds = new Set(list.map((m) => m.id));
    const compatibleAvailable = (catalog.models || []).filter(
      (m) => (m.roles || []).includes(role) && m.capabilities?.[role] !== false && !presentIds.has(m.id),
    );
    const unavailableForRole = (catalog.unavailableModels || []).filter(
      (u) => !u.roles?.length || u.roles.includes(role),
    );

    let enabledRank = 0;
    const rows = list.map((entry, idx) => {
      const cat = catalogModelById(entry.id);
      const label = cat?.label || entry.id;
      const minConc = cat?.concurrencyBounds?.min ?? globalBounds.min ?? 1;
      const maxConc = cat?.concurrencyBounds?.max ?? globalBounds.max ?? 4;
      const isCandidate = cat?.source === 'candidate';
      if (entry.enabled) enabledRank += 1;
      const rankText = entry.enabled ? (enabledRank === 1 ? 'Primary' : `Fallback ${enabledRank - 1}`) : 'Disabled';
      const isPrimary = entry.enabled && enabledRank === 1;
      return `<div class="lane-edit-row${entry.enabled ? '' : ' is-disabled'}" role="listitem" data-model-lane="${esc(entry.id)}" data-role="${esc(role)}" data-index="${idx}">
        <div class="lane-edit-main">
          <span class="lane-rank-badge${isPrimary ? ' primary' : ''}" data-lane-rank>${esc(rankText)}</span>
          <div class="lane-edit-copy">
            <strong>${esc(label)} <code class="lane-id">${esc(entry.id)}</code>${isCandidate ? '<span class="candidate-badge">Candidate</span>' : ''}</strong>
            ${cat?.note ? `<span class="lane-desc">${esc(cat.note)}</span>` : ''}
          </div>
        </div>
        <div class="lane-edit-controls">
          <label class="lane-toggle">
            <input type="checkbox" data-model-enable="${esc(entry.id)}" data-role="${esc(role)}" ${entry.enabled ? 'checked' : ''} aria-label="Enable ${esc(label)} for ${esc(role)}">
            <span>${entry.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
          <label class="lane-num-label">
            <span>Concurrency <small>(${minConc}–${maxConc})</small></span>
            <input type="number" class="lane-num-input" data-model-concurrency="${esc(entry.id)}" data-role="${esc(role)}" min="${minConc}" max="${maxConc}" step="1" value="${entry.concurrency}" aria-label="${esc(label)} ${esc(role)} concurrency (${minConc} to ${maxConc})">
          </label>
          <div class="lane-move-group" role="group" aria-label="Reorder ${esc(label)} in ${esc(role)}">
            <button type="button" class="btn small lane-move-btn" data-model-move="up" data-role="${esc(role)}" data-lane-id="${esc(entry.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${esc(label)} up in ${esc(role)}">↑ Up</button>
            <button type="button" class="btn small lane-move-btn" data-model-move="down" data-role="${esc(role)}" data-lane-id="${esc(entry.id)}" ${idx === list.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(label)} down in ${esc(role)}">↓ Down</button>
            <button type="button" class="btn small lane-move-btn" data-model-move="primary" data-role="${esc(role)}" data-lane-id="${esc(entry.id)}" ${idx === 0 && entry.enabled ? 'disabled' : ''} aria-label="Make ${esc(label)} primary for ${esc(role)}">Make primary</button>
            ${isCandidate ? `<button type="button" class="btn small lane-move-btn danger" data-model-remove="${esc(entry.id)}" data-role="${esc(role)}" aria-label="Remove ${esc(label)} from ${esc(role)}">Remove</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    const selectOptions = [
      compatibleAvailable.length
        ? `<option value="">Select compatible ${esc(role)} model…</option>`
        : `<option value="">All compatible ${esc(role)} models in chain</option>`,
      ...compatibleAvailable.map((m) => `<option value="${esc(m.id)}">${esc(m.label)} (${esc(m.id)})</option>`),
      ...unavailableForRole.map((u) => `<option value="${esc(u.id)}" disabled>${esc(u.label)} (${esc(u.id)}) — Unavailable</option>`),
    ].join('');

    return `<section class="model-role-editor" data-model-role="${esc(role)}" aria-labelledby="roleEditorHeading-${esc(role)}">
      <div class="role-editor-head">
        <h4 id="roleEditorHeading-${esc(role)}">${esc(title(role))} chain</h4>
        <span>${list.filter((m) => m.enabled).length} enabled · concurrency ${globalBounds.min}–${globalBounds.max}</span>
      </div>
      <div class="lane-editor-list" role="list" id="modelLaneEditorList-${esc(role)}">${rows}</div>
      <div class="add-model-bar" data-add-model-bar="${esc(role)}">
        <label for="addModelSelect-${esc(role)}">Add role-compatible ${esc(role)} model from catalog</label>
        <div class="add-model-controls">
          <select id="addModelSelect-${esc(role)}" data-add-model-select="${esc(role)}" aria-label="Add ${esc(role)} model from catalog">${selectOptions}</select>
          <button type="button" class="btn small" id="addModelBtn-${esc(role)}" data-add-model-btn="${esc(role)}" ${compatibleAvailable.length === 0 ? 'disabled' : ''}>Add model</button>
        </div>
      </div>
    </section>`;
  }).join('');

  const unavail = catalog.unavailableModels || [];
  const unavailBox = unavail.length
    ? `<div class="unavailable-models-box" id="unavailableModelsBox" aria-label="Unavailable models">
        <strong>Unavailable models on this host (disabled):</strong>
        <ul class="unavailable-models-list">
          ${unavail.map((u) => `<li data-unavailable-model="${esc(u.id)}"><code class="lane-id">${esc(u.id)}</code> <span>${esc(u.reason)}</span></li>`).join('')}
        </ul>
      </div>`
    : '';

  panel.innerHTML = `
    <div class="lane-editor-head">
      <div>
        <h3 id="modelEditorHeading">Configure model lane policy</h3>
        <p>Order sets primary and fallback priority per role. Saved changes are consumed at run start and apply to new runs only.</p>
      </div>
      <span class="pill policy-pill">Applies to new runs</span>
    </div>
    ${conflictHtml}
    ${errorHtml}
    ${boundsHtml}
    <div class="model-editor-grid">${roleCards}</div>
    ${unavailBox}
    ${saveConfirmHtml}
    ${resetConfirmHtml}
    ${editorFooterHtml('models')}
  `;
}

function renderOpenEditors() {
  renderRenderEditor();
  renderModelEditor();
}

function renderWorkers() {
  $('workerCount').textContent = `${data.workers.length} discovered`;
  updateHTML('workers', data.workers.map((w) => {
    const local = w.kind === 'local';
    const battery = local ? batteryView(data.system.battery) : null;
    const cloud = w.kind === 'cloud';
    const metrics = local ? `<span>${percent(data.system.cpuPercent)} <small>CPU</small></span><span>${bytes(data.system.memory.available)} <small>RAM free</small></span><span>${bytes(data.system.disk.available)} <small>disk free</small></span>${battery ? `<span>${percent(battery.pct)} <small>battery</small></span>` : ''}` : cloud ? `<span>${w.metrics?.cpus ?? '—'} <small>cores</small></span><span>${w.metrics?.mem_gb ?? '—'} GB <small>memory</small></span><span>${esc(w.boxStatus || 'cloud')} <small>sandbox</small></span>` : w.metrics ? `<span>${w.metrics.load ?? '—'} / ${w.metrics.cpus ?? '—'} <small>load / cores</small></span><span>${w.metrics.mem_gb ?? '—'} GB <small>RAM free</small></span><span>${w.metrics.disk_gb ?? '—'} GB <small>disk free</small></span>` : '<span>Remote resource data not reported</span>';
    const idle = w.status === 'paused' ? 'Sandbox is stopped. A render resumes it; idle time is not billed.' : w.status === 'unavailable' ? (w.reason || 'Worker unavailable') : w.status === 'last-seen' ? 'No active run. Showing the last reported worker.' : 'No chapter assigned. Ready for the next job.';
    return `<article class="worker-card ${w.status === 'busy' ? 'busy' : ''}" data-worker="${esc(w.id)}"><div class="worker-head"><span class="worker-icon">${icon(local ? 'monitor' : 'cloud')}</span><div><h3>${esc(w.id)}</h3><p>${local ? 'Local render worker' : cloud ? 'Docker cloud render lane' : esc(title(w.kind)) + ' render worker'}</p></div>${pill(w.status, w.status === 'last-seen' ? 'Last seen' : null)}</div>
      ${w.jobs.length ? w.jobs.map((job) => `<div class="worker-job"><strong>${esc(job.chapter)} · ${esc(job.series.replace(/-/g, ' '))}</strong><p>${job.stages.map((s) => esc(`${longLabels[s.id] || title(s.id)} · ${s.state}${stageDetail(s) ? ' · ' + stageDetail(s) : ''}`)).join('<br>')}</p>${job.stages.filter((s) => s.total).map((s) => meter((s.completed || 0) / s.total * 100)).join('')}</div>`).join('') : `<p class="worker-idle">${esc(idle)}</p>`}
      <div class="worker-health">${metrics}</div>${!local ? `<p class="health-note">${w.probedAt ? 'Health checked ' + age(w.probedAt) : 'Health from the last recorded run event'}${w.reason ? ' · ' + esc(w.reason) : ''}</p>` : ''}${w.lastError ? `<p class="health-note">Last failure: ${esc(w.lastError)}</p>` : ''}</article>`;
  }).join(''));
}

function renderModels(run) {
  const activeRuns = (data?.runs || []).filter((r) => r.alive && r.state === 'running');
  const active = activeRuns.flatMap((r) => Object.values(r.activeCalls || {}).map((c) => ({ ...c, series: r.series })));
  const providers = Object.assign({}, ...activeRuns.map((r) => r.providers || {}));
  $('callSummary').textContent = active.length ? `${active.length} in flight` : run?.totals?.calls != null ? `${number(run.totals.calls)} attempts this run` : 'Configured lanes';
  if (data) {
    updateHTML('activeCalls', active.length ? active.map((c) => `<div class="active-call"><div><strong>${esc(c.provider)} / ${esc(c.model)}</strong><p>${esc(c.role)} · ${esc(c.tag || c.chapter || 'Request')} · attempt ${c.attempt} · ${esc(c.series)}</p></div><span class="call-duration">${duration(Date.now() / 1000 - c.startedAt)}</span></div>`).join('') : `<p class="no-calls">${data.running ? 'No in-flight model request reported.' : 'No model requests in flight.'} ${run?.source === 'log' ? 'The most recent responses are listed below.' : ''}</p>`);
  }
  const open = new Map([...$('models').querySelectorAll('details')].map((d) => [d.dataset.role, d.open]));
  if (lanesState?.config?.models) {
    const html = ['vision', 'writer'].map((role) => {
      const chain = lanesState.config.models[role] || [];
      const enabledCount = chain.filter((m) => m.enabled).length;
      const disabledCount = chain.length - enabledCount;
      let enabledIdx = 0;
      const rows = chain.map((entry) => {
        const cat = catalogModelById(entry.id);
        const [prov, ...modParts] = String(entry.id || '').split(':');
        const name = cat?.name || cat?.provider || prov || entry.id;
        const model = cat?.model || modParts.join(':') || entry.id;
        const inUse = active.some((c) => c.provider === name && c.model === model && c.role === role);
        const cooling = providers[name]?.coolingUntil > Date.now() / 1000;
        const orderBadge = entry.enabled ? ++enabledIdx : '–';
        const kindLabel = !entry.enabled
          ? 'Disabled'
          : inUse
            ? 'In use'
            : cooling
              ? 'Cooling ' + duration(providers[name].coolingUntil - Date.now() / 1000)
              : enabledIdx === 1
                ? 'Primary'
                : 'Fallback ' + (enabledIdx - 1);
        const concSuffix = entry.concurrency > 1 ? ` · ${entry.concurrency}× concurrency` : '';
        return `<div class="model-lane${inUse ? ' active' : ''}${entry.enabled ? '' : ' disabled'}" data-lane-id="${esc(entry.id)}"><span class="lane-order">${esc(orderBadge)}</span><span class="lane-copy"><strong>${esc(name)}</strong><span>${esc(model)}${esc(concSuffix)}</span></span><span class="lane-kind">${esc(kindLabel)}</span></div>`;
      }).join('');
      return `<details class="model-chain" data-role="${esc(role)}" ${open.get(role) !== false ? 'open' : ''}><summary>${esc(title(role))}<span>${enabledCount} enabled${disabledCount ? ` · ${disabledCount} off` : ''} · in priority order</span></summary><div class="lane-list">${rows}</div></details>`;
    }).join('');
    updateHTML('models', html || '<div class="panel dashboard-empty">Model configuration is not available.</div>');
    return;
  }
  const groups = data?.models || {};
  const html = Object.entries(groups).map(([role, lanes]) => `<details class="model-chain" data-role="${esc(role)}" ${open.get(role) !== false ? 'open' : ''}><summary>${esc(title(role))}<span>${lanes.length} models · in priority order</span></summary><div class="lane-list">${lanes.map((lane, i) => {
    const inUse = active.some((c) => c.provider === lane.name && c.model === lane.model && c.role === role);
    const cooling = providers[lane.name]?.coolingUntil > Date.now() / 1000;
    return `<div class="model-lane${inUse ? ' active' : ''}"><span class="lane-order">${i + 1}</span><span class="lane-copy"><strong>${esc(lane.name)}</strong><span>${esc(lane.model)}</span></span><span class="lane-kind">${inUse ? 'In use' : cooling ? 'Cooling ' + duration(providers[lane.name].coolingUntil - Date.now() / 1000) : i ? 'Fallback ' + i : 'Primary'}</span></div>`;
  }).join('')}</div></details>`).join('');
  updateHTML('models', html || '<div class="panel dashboard-empty">Model configuration is not available.</div>');
}
function renderRecent(run) {
  const calls = run?.source === 'telemetry' ? run.recentCalls || [] : data.recentCalls;
  updateHTML('recentCalls', [...calls].reverse().slice(0, 20).map((c) => `<div class="request-row"><span class="request-icon ${c.state === 'error' ? 'error' : ''}">${c.state === 'error' ? '!' : icon('check')}</span><div class="request-main"><strong>${esc(c.tag || c.role || 'Model request')}</strong><p>${esc(c.provider)} · ${esc(c.model || 'model not recorded')} · attempt ${c.attempt}</p><p>${c.tokens == null ? 'Tokens not reported' : number(c.tokens) + ' tokens'}${c.note ? ' · ' + esc(c.note) : ''}</p></div><div class="request-time">${duration(c.duration)}<span>${clock(c.endedAt)}</span></div></div>`).join('') || '<div class="dashboard-empty">No completed requests recorded yet.</div>');
}
function renderActivity(run) {
  const onlyIssues = $('activityFilter').value === 'issues';
  const events = [...(run?.events || [])].reverse().filter((e) => !onlyIssues || ['error', 'warning'].includes(e.kind));
  updateHTML('activity', events.slice(0, 40).map((e) => `<div class="activity-row ${e.kind === 'error' ? 'error' : e.kind === 'warning' ? 'warning' : ''}"><time>${clock(e.at)}</time><p>${esc(e.message)}</p></div>`).join('') || `<div class="dashboard-empty">${onlyIssues ? 'No issues in the recent activity.' : 'Run events will appear here.'}</div>`);
}
function render() {
  const run = currentRun();
  $('overallState').className = 'pill ' + (data.running ? 'running' : 'idle');
  $('overallState').textContent = data.running ? '● Pipeline active' : 'Pipeline idle';
  $('statusDot').dataset.state = data.state;
  renderSystem();
  renderProgress(run);
  renderLanePolicies();
  renderWorkers();
  renderModels(run);
  renderRecent(run);
  renderActivity(run);
  $('updatedAt').textContent = `Updated ${new Date(data.at).toLocaleTimeString()} · every 5 seconds · ${lanesState?.privileged ? 'live monitoring' : 'read-only'}`;
}
function connection(stale = false) {
  const el = $('connection');
  const label = stale ? 'Reconnecting' : paused ? 'Paused' : 'Live · 5s';
  const cls = 'connection ' + (stale ? 'stale' : paused ? '' : 'live');
  // Only touch the DOM when something actually changed: a 5s poll must not
  // restart the live dot animation or reset the role="status" announcement.
  if (el.dataset.state === label && el.className === cls) return;
  el.dataset.state = label;
  el.className = cls;
  const dot = el.querySelector('.dot');
  if (dot) {
    [...el.childNodes].forEach((node) => { if (node.nodeType === 3) node.remove(); });
    el.append(document.createTextNode(label));
  } else {
    el.innerHTML = `<span class="dot"></span>${label}`;
  }
}
async function fetchLanes({ silent = false } = {}) {
  try {
    const res = await apiFetch('/api/lanes', { timeoutMs: 15000 });
    if (res.status === 401) { location.assign('/login'); return false; }
    if (!res.ok) throw new Error('Lane configuration unavailable');
    const freshLanes = await res.json();
    if (!freshLanes || typeof freshLanes !== 'object' || !freshLanes.config || !freshLanes.catalog) {
      throw new Error('Invalid lane configuration response');
    }
    lanesState = freshLanes;
    lanesError = '';
    renderLanePolicies();
    if (data) renderModels(currentRun());
    else renderModels(null);
    // Never overwrite draftConfig or re-render open editor inputs during background polling.
    return true;
  } catch {
    if (!lanesState && !silent) {
      lanesError = 'Lane configuration is temporarily unavailable. Live monitoring continues.';
      renderLanePolicies();
    }
    return false;
  }
}
async function refresh(manual = false) {
  if (inFlight || (!manual && (paused || document.hidden))) return;
  inFlight = true;
  $('refresh').disabled = true;
  try {
    const [statusResult] = await Promise.allSettled([
      (async () => {
        const res = await apiFetch('/api/status', { timeoutMs: 15000 });
        if (res.status === 401) { location.assign('/login'); return; }
        if (!res.ok) throw new Error('Status unavailable');
        const fresh = await res.json();
        if (fresh.schemaVersion !== 2 || !fresh.system) throw new Error('Status updating');
        data = fresh;
        render();
        $('connectionError').hidden = !fresh.stale;
        if (fresh.stale) $('connectionError').textContent = 'The collector is temporarily unavailable. Showing the last measurement from ' + new Date(fresh.at).toLocaleTimeString() + '.';
        connection(!!fresh.stale);
      })(),
      fetchLanes(),
    ]);
    if (statusResult.status === 'rejected') {
      connection(true);
      $('connectionError').hidden = false;
      $('connectionError').textContent = data ? 'Connection lost. These are the last received values; retrying automatically.' : 'Couldn’t reach the status collector. Retrying automatically, or use the refresh button.';
    }
  } finally {
    inFlight = false;
    $('refresh').disabled = false;
  }
}

/* ---------- Lane configuration interactions ---------- */

function focusMovedRenderButton(laneId, preferredMove) {
  const row = $('renderConfigPanel')?.querySelector(`[data-render-lane="${CSS.escape(laneId)}"]`);
  if (!row) return;
  const preferred = row.querySelector(`[data-render-move="${CSS.escape(preferredMove)}"]`);
  if (preferred && !preferred.disabled) { preferred.focus(); return; }
  const fallbackBtn = [...row.querySelectorAll('[data-render-move]')].find((b) => !b.disabled) || row.querySelector('input, button');
  if (fallbackBtn) fallbackBtn.focus();
}

function focusMovedModelButton(role, laneId, preferredMove) {
  const row = $('modelConfigPanel')?.querySelector(`[data-model-role="${CSS.escape(role)}"] [data-model-lane="${CSS.escape(laneId)}"]`);
  if (!row) return;
  const preferred = row.querySelector(`[data-model-move="${CSS.escape(preferredMove)}"]`);
  if (preferred && !preferred.disabled) { preferred.focus(); return; }
  const fallbackBtn = [...row.querySelectorAll('[data-model-move]')].find((b) => !b.disabled) || row.querySelector('input, button');
  if (fallbackBtn) fallbackBtn.focus();
}

function moveRenderLane(laneId, dir) {
  if (!draftConfig || !lanesState?.privileged || laneMutationInFlight) return;
  const list = draftConfig.render;
  const idx = list.findIndex((r) => r.id === laneId);
  if (idx < 0) return;
  if (dir === 'up' && idx > 0) {
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  } else if (dir === 'down' && idx < list.length - 1) {
    [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
  } else if (dir === 'primary') {
    const [item] = list.splice(idx, 1);
    item.enabled = true;
    list.unshift(item);
  } else {
    return;
  }
  draftDirty = true;
  saveConfirmOpen = false;
  editorError = '';
  renderOpenEditors();
  focusMovedRenderButton(laneId, dir);
}

function moveModelLane(role, laneId, dir) {
  if (!draftConfig || !lanesState?.privileged || laneMutationInFlight) return;
  const list = draftConfig.models?.[role];
  if (!Array.isArray(list)) return;
  const idx = list.findIndex((m) => m.id === laneId);
  if (idx < 0) return;
  if (dir === 'up' && idx > 0) {
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  } else if (dir === 'down' && idx < list.length - 1) {
    [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
  } else if (dir === 'primary') {
    const [item] = list.splice(idx, 1);
    item.enabled = true;
    list.unshift(item);
  } else {
    return;
  }
  draftDirty = true;
  saveConfirmOpen = false;
  editorError = '';
  renderOpenEditors();
  focusMovedModelButton(role, laneId, dir);
}

function removeCandidateModelLane(role, laneId) {
  if (!draftConfig || !lanesState?.privileged || laneMutationInFlight) return;
  const list = draftConfig.models?.[role];
  if (!Array.isArray(list)) return;
  const remaining = list.filter((m) => m.id !== laneId);
  if (!remaining.some((m) => m.enabled)) {
    editorError = `Model role '${role}' must keep at least one enabled lane.`;
    renderOpenEditors();
    return;
  }
  draftConfig.models[role] = remaining;
  draftDirty = true;
  saveConfirmOpen = false;
  editorError = '';
  renderOpenEditors();
  $('addModelSelect-' + role)?.focus();
}

function addCatalogModelLane(role) {
  if (!draftConfig || !lanesState?.privileged || laneMutationInFlight) return;
  const select = $('addModelSelect-' + role);
  const id = String(select?.value || '').trim();
  if (!id) {
    editorError = `Choose a compatible ${role} model from the catalog first.`;
    renderOpenEditors();
    return;
  }
  const unavail = (lanesState.catalog?.unavailableModels || []).find((u) => u.id === id);
  if (unavail) {
    editorError = friendlyLaneMessage(unavail.reason, `${id} is not available on this host.`);
    renderOpenEditors();
    return;
  }
  const cat = catalogModelById(id);
  if (!cat || !(cat.roles || []).includes(role) || cat.capabilities?.[role] === false) {
    editorError = `Model '${id}' is not compatible with role '${role}'.`;
    renderOpenEditors();
    return;
  }
  const list = draftConfig.models[role];
  if (list.some((m) => m.id === id)) {
    editorError = `Model '${id}' is already in the ${role} chain.`;
    renderOpenEditors();
    return;
  }
  const defConc = cat.concurrencyBounds?.default ?? lanesState.catalog?.modelConcurrencyBounds?.default ?? 1;
  list.push({ id, enabled: true, concurrency: defConc });
  draftDirty = true;
  saveConfirmOpen = false;
  editorError = '';
  renderOpenEditors();
  focusMovedModelButton(role, id, 'up');
}

function cancelLanesEdit(focusSection = null) {
  if (laneMutationInFlight) return;
  renderEditorOpen = false;
  modelEditorOpen = false;
  draftConfig = null;
  draftDirty = false;
  resetConfirmOpen = false;
  saveConfirmOpen = false;
  editorError = '';
  renderBoundsNote = '';
  modelBoundsNote = '';
  conflictState = null;
  renderLanePolicies();
  renderOpenEditors();
  if (focusSection === 'render') $('configureRenderBtn')?.focus();
  else if (focusSection === 'models') $('configureModelsBtn')?.focus();
}

async function reloadServerLanesIntoDraft() {
  if (laneMutationInFlight) return;
  laneMutationInFlight = true;
  renderOpenEditors();
  try {
    await fetchLanes({ silent: true });
    if (lanesState) {
      draftConfig = cloneConfig(lanesState.config);
      draftBaseRevision = lanesState.revision;
      draftDirty = false;
      conflictState = null;
      saveConfirmOpen = false;
      resetConfirmOpen = false;
      editorError = '';
      renderBoundsNote = '';
      modelBoundsNote = '';
      laneBanner = { section: 'both', text: `Loaded latest server lane settings (revision ${lanesState.revision}).`, kind: '' };
    }
  } finally {
    laneMutationInFlight = false;
    renderLanePolicies();
    renderOpenEditors();
  }
}

async function saveLanes({ confirmedEnvDisable = false } = {}) {
  if (!lanesState?.privileged || !draftConfig || laneMutationInFlight) return;
  if (!draftConfig.render.some((r) => r.enabled)) {
    editorError = 'At least one render lane must remain enabled.';
    renderOpenEditors();
    return;
  }
  for (const role of ['vision', 'writer']) {
    if (!(draftConfig.models[role] || []).some((m) => m.enabled)) {
      editorError = `Model role '${role}' must keep at least one enabled lane.`;
      renderOpenEditors();
      return;
    }
  }

  const affectedEnv = getAffectedEnvLanesForRenderList(draftConfig.render);
  if (affectedEnv.length > 0 && !confirmedEnvDisable) {
    saveConfirmOpen = true;
    resetConfirmOpen = false;
    editorError = '';
    renderOpenEditors();
    const activePanel = modelEditorOpen && !renderEditorOpen ? $('modelConfigPanel') : ($('renderConfigPanel') || $('modelConfigPanel'));
    activePanel?.querySelector('[data-action="save-keep-env-lanes"], [data-action="confirm-save-lanes"]')?.focus();
    return;
  }
  saveConfirmOpen = false;

  const payload = {
    revision: draftBaseRevision,
    render: draftConfig.render.map((r) => {
      const cat = catalogRenderById(r.id);
      const min = cat?.minSlots ?? 1;
      const max = cat?.maxSlots ?? 1;
      const slots = Math.max(min, Math.min(max, Math.trunc(Number(r.slots) || min)));
      return { id: String(r.id), enabled: Boolean(r.enabled), slots };
    }),
    models: {
      vision: draftConfig.models.vision.map((m) => {
        const cat = catalogModelById(m.id);
        const min = cat?.concurrencyBounds?.min ?? 1;
        const max = cat?.concurrencyBounds?.max ?? 4;
        const concurrency = Math.max(min, Math.min(max, Math.trunc(Number(m.concurrency) || 1)));
        return { id: String(m.id), enabled: Boolean(m.enabled), concurrency };
      }),
      writer: draftConfig.models.writer.map((m) => {
        const cat = catalogModelById(m.id);
        const min = cat?.concurrencyBounds?.min ?? 1;
        const max = cat?.concurrencyBounds?.max ?? 4;
        const concurrency = Math.max(min, Math.min(max, Math.trunc(Number(m.concurrency) || 1)));
        return { id: String(m.id), enabled: Boolean(m.enabled), concurrency };
      }),
    },
  };

  laneMutationInFlight = true;
  editorError = '';
  renderOpenEditors();

  try {
    const res = await apiFetch('/api/lanes', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': lanesState.csrfToken || '',
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { location.assign('/login'); return; }
    let body = {};
    try { body = await res.json(); } catch {}

    if (res.status === 409) {
      conflictState = {
        message: friendlyLaneMessage(body.error, 'Lane settings were updated in another session.'),
        currentRevision: Number.isInteger(body.currentRevision) ? body.currentRevision : null,
      };
      // Refresh server snapshot in background without overwriting draftConfig.
      await fetchLanes({ silent: true });
      if (conflictState.currentRevision == null && Number.isInteger(lanesState?.revision)) {
        conflictState.currentRevision = lanesState.revision;
      }
      return;
    }

    if (!res.ok) {
      editorError = res.status >= 500
        ? 'Couldn’t save lane settings right now. Your draft edits are preserved — please try again.'
        : friendlyLaneMessage(body.error, 'Couldn’t save lane settings right now. Your draft edits are preserved.');
      return;
    }

    lanesState = body;
    draftConfig = cloneConfig(lanesState.config);
    draftBaseRevision = lanesState.revision;
    draftDirty = false;
    conflictState = null;
    resetConfirmOpen = false;
    saveConfirmOpen = false;
    renderBoundsNote = '';
    modelBoundsNote = '';
    renderEditorOpen = false;
    modelEditorOpen = false;
    draftConfig = null;
    laneBanner = {
      section: 'both',
      text: `Saved lane policy (revision ${lanesState.revision}) · Applies to new runs.`,
      kind: '',
    };
    renderLanePolicies();
    if (data) renderModels(currentRun());
    else renderModels(null);
  } catch {
    editorError = 'Network error while saving lane settings. Your draft edits are still here — please try again.';
  } finally {
    laneMutationInFlight = false;
    renderLanePolicies();
    renderOpenEditors();
  }
}

async function resetLanesToDefaults() {
  if (!lanesState?.privileged || laneMutationInFlight) return;
  const rev = draftConfig ? draftBaseRevision : lanesState.revision;
  laneMutationInFlight = true;
  editorError = '';
  renderOpenEditors();

  try {
    const res = await apiFetch('/api/lanes/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': lanesState.csrfToken || '',
      },
      body: JSON.stringify({ revision: rev }),
    });
    if (res.status === 401) { location.assign('/login'); return; }
    let body = {};
    try { body = await res.json(); } catch {}

    if (res.status === 409) {
      resetConfirmOpen = false;
      conflictState = {
        message: friendlyLaneMessage(body.error, 'Lane settings were updated in another session before reset.'),
        currentRevision: Number.isInteger(body.currentRevision) ? body.currentRevision : null,
      };
      await fetchLanes({ silent: true });
      if (conflictState.currentRevision == null && Number.isInteger(lanesState?.revision)) {
        conflictState.currentRevision = lanesState.revision;
      }
      return;
    }

    if (!res.ok) {
      editorError = res.status >= 500
        ? 'Couldn’t reset lane settings right now. Your draft is preserved — please try again.'
        : friendlyLaneMessage(body.error, 'Couldn’t reset lane settings right now. Please try again.');
      return;
    }

    lanesState = body;
    resetConfirmOpen = false;
    saveConfirmOpen = false;
    conflictState = null;
    editorError = '';
    renderBoundsNote = '';
    modelBoundsNote = '';
    renderEditorOpen = false;
    modelEditorOpen = false;
    draftConfig = null;
    draftDirty = false;
    laneBanner = {
      section: 'both',
      text: `Restored default lane policy (revision ${lanesState.revision}) · Applies to new runs.`,
      kind: '',
    };
    renderLanePolicies();
    if (data) renderModels(currentRun());
    else renderModels(null);
  } catch {
    editorError = 'Network error while resetting lane settings. Your draft is preserved — please try again.';
  } finally {
    laneMutationInFlight = false;
    renderLanePolicies();
    renderOpenEditors();
  }
}

function toggleSectionEditor(section) {
  if (!lanesState?.privileged) return;
  laneBanner = null;
  if (section === 'render') {
    if (renderEditorOpen) {
      renderEditorOpen = false;
      if (!modelEditorOpen && !draftDirty) {
        draftConfig = null;
        resetConfirmOpen = false;
        saveConfirmOpen = false;
        editorError = '';
        conflictState = null;
      }
    } else {
      ensureDraftStarted();
      renderEditorOpen = true;
    }
  } else {
    if (modelEditorOpen) {
      modelEditorOpen = false;
      if (!renderEditorOpen && !draftDirty) {
        draftConfig = null;
        resetConfirmOpen = false;
        saveConfirmOpen = false;
        editorError = '';
        conflictState = null;
      }
    } else {
      ensureDraftStarted();
      modelEditorOpen = true;
    }
  }
  renderLanePolicies();
  renderOpenEditors();
}

$('configureRenderBtn').addEventListener('click', () => toggleSectionEditor('render'));
$('configureModelsBtn').addEventListener('click', () => toggleSectionEditor('models'));

function handleEditorClick(e) {
  const renderMoveBtn = e.target.closest('[data-render-move]');
  if (renderMoveBtn) {
    moveRenderLane(renderMoveBtn.dataset.laneId, renderMoveBtn.dataset.renderMove);
    return;
  }
  const modelMoveBtn = e.target.closest('[data-model-move]');
  if (modelMoveBtn) {
    moveModelLane(modelMoveBtn.dataset.role, modelMoveBtn.dataset.laneId, modelMoveBtn.dataset.modelMove);
    return;
  }
  const modelRemoveBtn = e.target.closest('[data-model-remove]');
  if (modelRemoveBtn) {
    removeCandidateModelLane(modelRemoveBtn.dataset.role, modelRemoveBtn.dataset.modelRemove);
    return;
  }
  const addModelBtn = e.target.closest('[data-add-model-btn]');
  if (addModelBtn) {
    addCatalogModelLane(addModelBtn.dataset.addModelBtn);
    return;
  }
  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  if (action === 'save-lanes') {
    saveLanes({ confirmedEnvDisable: false });
  } else if (action === 'confirm-save-lanes') {
    saveLanes({ confirmedEnvDisable: true });
  } else if (action === 'save-keep-env-lanes') {
    if (draftConfig) {
      const affected = new Set(getAffectedEnvLanesForRenderList(draftConfig.render));
      for (const r of draftConfig.render) {
        if (affected.has(String(r.id))) r.enabled = true;
      }
      draftDirty = true;
    }
    saveLanes({ confirmedEnvDisable: true });
  } else if (action === 'cancel-save-confirm') {
    saveConfirmOpen = false;
    renderOpenEditors();
    const panel = actionBtn.closest('.lane-editor');
    panel?.querySelector('[data-action="save-lanes"]')?.focus();
  } else if (action === 'cancel-lanes') {
    const inRender = Boolean(actionBtn.closest('#renderConfigPanel'));
    cancelLanesEdit(inRender ? 'render' : 'models');
  } else if (action === 'reset-lanes') {
    resetConfirmOpen = true;
    saveConfirmOpen = false;
    editorError = '';
    renderOpenEditors();
    const panel = actionBtn.closest('.lane-editor');
    panel?.querySelector('[data-action="confirm-reset-lanes"]')?.focus();
  } else if (action === 'confirm-reset-lanes') {
    resetLanesToDefaults();
  } else if (action === 'cancel-reset-lanes') {
    resetConfirmOpen = false;
    renderOpenEditors();
    const panel = actionBtn.closest('.lane-editor');
    panel?.querySelector('[data-action="reset-lanes"]')?.focus();
  } else if (action === 'conflict-review-draft') {
    const nextRev = conflictState?.currentRevision ?? lanesState?.revision;
    if (Number.isInteger(nextRev)) draftBaseRevision = nextRev;
    conflictState = null;
    saveConfirmOpen = false;
    editorError = '';
    renderOpenEditors();
    const panel = actionBtn.closest('.lane-editor');
    panel?.querySelector('[data-action="save-lanes"]')?.focus();
  } else if (action === 'conflict-reload-server') {
    reloadServerLanesIntoDraft();
  } else if (action === 'retry-load-lanes') {
    fetchLanes();
  } else if (action === 'repair-reset-lanes') {
    ensureDraftStarted();
    renderEditorOpen = true;
    resetConfirmOpen = true;
    saveConfirmOpen = false;
    renderLanePolicies();
    renderOpenEditors();
    $('confirmResetRenderBtn')?.focus();
  } else if (action === 'dismiss-lane-notice') {
    laneBanner = null;
    renderLanePolicies();
  }
}

function syncEditorBoundsStatus(section) {
  const panel = $(section === 'render' ? 'renderConfigPanel' : 'modelConfigPanel');
  if (!panel) return;
  const note = section === 'render' ? renderBoundsNote : modelBoundsNote;
  let bar = panel.querySelector('[data-lane-bounds]');
  if (note) {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'lane-bounds-bar';
      bar.setAttribute('role', 'status');
      bar.setAttribute('data-lane-bounds', '');
      const list = panel.querySelector('.lane-editor-list, .model-editor-grid');
      if (list) panel.insertBefore(bar, list);
    }
    bar.innerHTML = `<span>${esc(note)}</span>`;
  } else if (bar) {
    bar.remove();
  }
  for (const revEl of document.querySelectorAll('[data-rev-status]')) {
    revEl.textContent = `Base revision ${draftBaseRevision}${draftDirty ? ' · Unsaved draft edits' : ' · Saved state'} · Applies to new runs`;
  }
}

function handleEditorNumeric(target, isCommit) {
  if (!draftConfig || !lanesState?.privileged) return;
  if (target.dataset.renderSlots) {
    const id = target.dataset.renderSlots;
    const entry = draftConfig.render.find((r) => r.id === id);
    if (!entry) return;
    const cat = catalogRenderById(id);
    const min = cat?.minSlots ?? 1;
    const max = cat?.maxSlots ?? 1;
    const rawStr = String(target.value).trim();
    if (!isCommit && rawStr === '') return;
    const parsed = Number(rawStr);
    const intVal = Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
    if (!Number.isFinite(intVal) || intVal < min || intVal > max) {
      const clamped = !Number.isFinite(intVal) ? (cat?.defaultSlots ?? min) : Math.max(min, Math.min(max, intVal));
      entry.slots = clamped;
      target.value = String(clamped);
      renderBoundsNote = min === max
        ? `Slots for ${cat?.label || id} has fixed capacity of ${max} (between ${min} and ${max}, clamped to ${clamped}).`
        : `Slots for ${cat?.label || id} must be between ${min} and ${max} (clamped to ${clamped}).`;
    } else {
      entry.slots = intVal;
      if (isCommit) target.value = String(intVal);
      renderBoundsNote = '';
    }
    draftDirty = true;
    saveConfirmOpen = false;
    syncEditorBoundsStatus('render');
    return;
  }
  if (target.dataset.modelConcurrency) {
    const id = target.dataset.modelConcurrency;
    const role = target.dataset.role;
    const entry = (draftConfig.models?.[role] || []).find((m) => m.id === id);
    if (!entry) return;
    const cat = catalogModelById(id);
    const min = cat?.concurrencyBounds?.min ?? lanesState.catalog?.modelConcurrencyBounds?.min ?? 1;
    const max = cat?.concurrencyBounds?.max ?? lanesState.catalog?.modelConcurrencyBounds?.max ?? 4;
    const rawStr = String(target.value).trim();
    if (!isCommit && rawStr === '') return;
    const parsed = Number(rawStr);
    const intVal = Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
    if (!Number.isFinite(intVal) || intVal < min || intVal > max) {
      const clamped = !Number.isFinite(intVal) ? 1 : Math.max(min, Math.min(max, intVal));
      entry.concurrency = clamped;
      target.value = String(clamped);
      modelBoundsNote = `Concurrency for ${cat?.label || id} must be between ${min} and ${max} (clamped to ${clamped}).`;
    } else {
      entry.concurrency = intVal;
      if (isCommit) target.value = String(intVal);
      modelBoundsNote = '';
    }
    draftDirty = true;
    saveConfirmOpen = false;
    syncEditorBoundsStatus('models');
  }
}

function handleEditorChange(e) {
  if (!draftConfig || !lanesState?.privileged) return;
  const target = e.target;
  if (target.dataset.renderEnable) {
    const id = target.dataset.renderEnable;
    const entry = draftConfig.render.find((r) => r.id === id);
    if (!entry) return;
    const nextEnabled = Boolean(target.checked);
    if (!nextEnabled && draftConfig.render.filter((r) => r.enabled).length <= 1) {
      target.checked = true;
      editorError = 'At least one render lane must remain enabled.';
      renderOpenEditors();
      $('renderConfigPanel')?.querySelector(`[data-render-enable="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    entry.enabled = nextEnabled;
    draftDirty = true;
    saveConfirmOpen = false;
    editorError = '';
    renderOpenEditors();
    $('renderConfigPanel')?.querySelector(`[data-render-enable="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  if (target.dataset.modelEnable) {
    const id = target.dataset.modelEnable;
    const role = target.dataset.role;
    const list = draftConfig.models?.[role] || [];
    const entry = list.find((m) => m.id === id);
    if (!entry) return;
    const nextEnabled = Boolean(target.checked);
    if (!nextEnabled && list.filter((m) => m.enabled).length <= 1) {
      target.checked = true;
      editorError = `Model role '${role}' must keep at least one enabled lane.`;
      renderOpenEditors();
      $('modelConfigPanel')?.querySelector(`[data-model-role="${CSS.escape(role)}"] [data-model-enable="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    entry.enabled = nextEnabled;
    draftDirty = true;
    saveConfirmOpen = false;
    editorError = '';
    renderOpenEditors();
    $('modelConfigPanel')?.querySelector(`[data-model-role="${CSS.escape(role)}"] [data-model-enable="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  handleEditorNumeric(target, true);
}

function handleEditorInput(e) {
  handleEditorNumeric(e.target, false);
}

function handleEditorKeydown(e) {
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const dir = e.key === 'ArrowUp' ? 'up' : 'down';
    const renderRow = e.target.closest('[data-render-lane]');
    if (renderRow) {
      e.preventDefault();
      moveRenderLane(renderRow.dataset.renderLane, dir);
      return;
    }
    const modelRow = e.target.closest('[data-model-lane]');
    if (modelRow) {
      e.preventDefault();
      moveModelLane(modelRow.dataset.role, modelRow.dataset.modelLane, dir);
      return;
    }
  }
  if (e.key === 'Escape') {
    if (saveConfirmOpen) {
      e.preventDefault();
      saveConfirmOpen = false;
      renderOpenEditors();
      const panel = e.target.closest('.lane-editor');
      panel?.querySelector('[data-action="save-lanes"]')?.focus();
    } else if (resetConfirmOpen) {
      e.preventDefault();
      resetConfirmOpen = false;
      renderOpenEditors();
      const panel = e.target.closest('.lane-editor');
      panel?.querySelector('[data-action="reset-lanes"]')?.focus();
    } else if (!draftDirty) {
      const inRender = Boolean(e.target.closest('#renderConfigPanel'));
      cancelLanesEdit(inRender ? 'render' : 'models');
    }
  }
}

for (const id of ['renderPolicySummary', 'modelPolicySummary', 'renderConfigNotice', 'modelConfigNotice', 'renderConfigPanel', 'modelConfigPanel']) {
  $(id)?.addEventListener('click', handleEditorClick);
}
for (const id of ['renderConfigPanel', 'modelConfigPanel']) {
  $(id)?.addEventListener('change', handleEditorChange);
  $(id)?.addEventListener('input', handleEditorInput);
  $(id)?.addEventListener('keydown', handleEditorKeydown);
}

$('refresh').addEventListener('click', () => refresh(true));
$('pauseUpdates').addEventListener('click', () => {
  paused = !paused;
  $('pauseUpdates').setAttribute('aria-pressed', String(paused));
  $('pauseUpdates').setAttribute('aria-label', paused ? 'Resume live updates' : 'Pause live updates');
  $('pauseUpdates').title = paused ? 'Resume live updates' : 'Pause live updates';
  $('pauseUpdates').innerHTML = icon(paused ? 'play' : 'pause');
  connection(!!data?.stale);
  if (!paused) refresh();
});
$('runSelect').addEventListener('change', () => { selectedRun = $('runSelect').value; if (data) render(); });
$('activityFilter').addEventListener('change', () => { if (data) renderActivity(currentRun()); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', () => refresh());
timer = setInterval(() => refresh(), 5000);
window.addEventListener('pagehide', () => clearInterval(timer));
window.addEventListener('pageshow', (e) => { if (e.persisted) { timer = setInterval(() => refresh(), 5000); refresh(); } });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
refresh();
