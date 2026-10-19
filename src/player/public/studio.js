// Creative Studio — providers, stage routing, render nodes, and voice defaults.
// Endpoints (all same-origin, JSON, CSRF on every mutation):
//   GET  /api/studio/providers          POST /api/studio/providers
//   POST /api/studio/providers/:id/test POST /api/studio/providers/:id/models/discover
//   POST /api/studio/oauth/pkce-start   POST /api/studio/oauth/pkce-exchange
//   POST /api/studio/oauth/device-start POST /api/studio/oauth/device-poll
//   GET  /api/studio/stages             PUT  /api/studio/stages
//   GET  /api/studio/nodes              POST /api/studio/nodes
//   POST /api/studio/nodes/:id/test     POST /api/studio/nodes/:id/action
//   GET  /api/intake/catalog            POST /api/intake/preview
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const STAGE_META = [
  {
    id: 'reader',
    label: 'Reader',
    purpose: 'Panel vision extraction (reader.ts)',
    gate: 'vision',
    gateLabel: 'Vision required',
  },
  {
    id: 'matcher',
    label: 'Matcher',
    purpose: 'Visual contact-sheet & semantic panel matching (visualMatcher.ts)',
    gate: 'vision',
    gateLabel: 'Vision required',
    inheritable: true,
  },
  {
    id: 'writer',
    label: 'Writer',
    purpose: 'Chapter recap & story script generation (writer.ts, storyWriter.ts)',
    gate: 'text',
    gateLabel: 'Text model',
  },
  {
    id: 'scout',
    label: 'Scout',
    purpose: 'Promo / watermark / credit page detection (scout.ts, cleaner.ts)',
    gate: 'vision',
    gateLabel: 'Vision required',
    inheritable: true,
  },
  {
    id: 'fact_check',
    label: 'Fact check',
    purpose: 'Deterministic rules plus an optional LLM continuity verifier (factCheck.ts)',
    gate: 'text',
    gateLabel: 'Text model',
    verifyToggle: true,
  },
  {
    id: 'tts',
    label: 'TTS',
    purpose: 'Voice narration engine (edge, elevenlabs, openai-tts, custom)',
    gate: 'tts',
    gateLabel: 'Audio synthesis',
    voiceTab: true,
  },
];

// Stages the routing store persists. The narration engine is configured in the
// Voice & TTS tab, so `tts` is shown for completeness but never written here.
const ROUTABLE_STAGES = new Set(['reader', 'matcher', 'writer', 'scout', 'fact_check']);

const PROVIDER_PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', authMode: 'bearer' },
  { id: 'openai', label: 'OpenAI', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', authMode: 'bearer' },
  { id: 'anthropic', label: 'Anthropic Claude', kind: 'cloud-api', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', authMode: 'bearer' },
  { id: 'gemini', label: 'Google Gemini API', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authMode: 'bearer' },
  { id: 'xai', label: 'xAI (Grok)', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', authMode: 'bearer' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', authMode: 'bearer' },
  { id: 'dashscope', label: 'Alibaba DashScope (Qwen)', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authMode: 'bearer' },
  { id: 'groq', label: 'Groq Cloud', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', authMode: 'bearer' },
  { id: 'custom-openai', label: 'Custom OpenAI-compatible', kind: 'cloud-api', protocol: 'openai-compatible', baseUrl: '', authMode: 'bearer' },
  { id: 'codex-oauth', label: 'OpenAI Codex (ChatGPT Plus/Pro)', kind: 'subscription', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', authMode: 'oauth-pkce' },
  { id: 'claude-oauth', label: 'Claude Pro / Max', kind: 'subscription', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', authMode: 'oauth-pkce' },
  { id: 'github-copilot', label: 'GitHub Copilot (device code)', kind: 'subscription', protocol: 'openai-compatible', baseUrl: 'https://api.githubcopilot.com', authMode: 'device-code' },
  { id: 'subscription-bridge', label: 'Subscription proxy / gateway', kind: 'subscription', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:8317/v1', authMode: 'bearer' },
  { id: 'vertex-ai', label: 'Google Vertex AI', kind: 'cloud-iam', protocol: 'vertex-openai', baseUrl: 'https://aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/endpoints/openapi', authMode: 'vertex-service-account' },
  { id: 'ollama', label: 'Ollama', kind: 'local', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', authMode: 'none' },
  { id: 'lmstudio', label: 'LM Studio', kind: 'local', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', authMode: 'none' },
  { id: 'vllm', label: 'vLLM', kind: 'local', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', authMode: 'none' },
];

const KIND_LABEL = { 'cloud-api': 'Cloud API', subscription: 'Subscription', 'cloud-iam': 'Cloud IAM', local: 'Local' };
const PLAYBACK_RATES = [0.9, 1.0, 1.1, 1.25];
const TTS_STORAGE_KEY = 'screeningroom.studio.tts';
const DEFAULT_PREVIEW_LINE =
  'The gate opened onto a courtyard of black stone, and for the first time in nine hundred years, the sword answered.';

const state = {
  csrf: '',
  tab: 'providers',
  filter: 'all',
  providers: [],
  providersRevision: 0,
  providersAvailable: true,
  stages: null,
  stagesDraft: null,
  stagesBaseRevision: 0,
  stagesDirty: false,
  stagesAvailable: true,
  nodes: [],
  nodesRevision: 0,
  nodesAvailable: true,
  oauth: { pkce: null, deviceTimer: null, device: null },
  dialogMode: 'api',
  vertexJson: '',
  editingProviderId: '',
  editingNodeId: '',
  tts: { catalog: null, provider: '', voice: '', rate: 1, text: DEFAULT_PREVIEW_LINE, bars: [], gen: 0, controller: null },
  focusKey: '',
  confirmDelete: { id: '', timer: null },
};

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

async function request(path, { method = 'GET', body, timeoutMs = 25000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const res = await apiFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });
  if (res.status === 401) {
    location.assign('/login');
    throw new Error('Your session expired. Sign in again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showNotice(message, kind = 'error') {
  const el = $('studioNotice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'dashboard-notice';
    return;
  }
  el.hidden = false;
  el.className = 'dashboard-notice' + (kind === 'info' ? ' studio-notice-info' : '');
  el.textContent = message;
}

function toast(message) {
  const el = $('studioToast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setConnection(text, mode) {
  const el = $('studioConnection');
  el.className = 'connection ' + (mode || '');
  el.innerHTML = `<span class="dot"></span>${esc(text)}`;
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtCtx(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1000000) return `${Math.round(v / 100000) / 10}M ctx`;
  return `${Math.round(v / 1000)}k ctx`;
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

function setTab(tab, { focus = false } = {}) {
  state.tab = tab;
  document.querySelectorAll('[data-studio-tab]').forEach((button) => {
    const on = button.dataset.studioTab === tab;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    if (on && focus) button.focus({ preventScroll: true });
  });
  for (const [name, panelId] of [
    ['providers', 'panelProviders'],
    ['stages', 'panelStages'],
    ['nodes', 'panelNodes'],
    ['voices', 'panelVoices'],
  ]) {
    $(panelId).hidden = name !== tab;
  }
  if (tab === 'voices') loadTtsCatalog();
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

function providerKind(provider) {
  const kind = String(provider?.kind || provider?.presetKind || 'cloud-api');
  return KIND_LABEL[kind] ? kind : 'cloud-api';
}

function probeBadge(provider) {
  const test = provider?.lastTest;
  if (!test || !test.testedAt) {
    return '<span class="probe-badge" title="Never tested"><span class="latency-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="mono">Untested</span></span>';
  }
  const ms = Number(test.latencyMs) || 0;
  const cls = !test.ok ? 'bad' : ms < 800 ? 'ok' : ms <= 2500 ? 'warn' : 'bad';
  const bars = !test.ok ? 1 : ms < 800 ? 5 : ms <= 2500 ? 3 : 1;
  const title = `Last tested ${new Date(test.testedAt).toLocaleString()} · ${test.ok ? 'HTTP ' + (test.status || 200) : test.error || 'failed'}`;
  return `<span class="probe-badge ${cls}" title="${esc(title)}"><span class="latency-bars" aria-hidden="true">${Array.from({ length: 5 }, (_, i) => `<i class="${i < bars ? 'on' : ''}"></i>`).join('')}</span><span class="mono">${test.ok ? esc(fmtMs(ms)) : 'Failed'}</span></span>`;
}

function modelCaps(model) {
  const caps = model?.capabilities || {};
  return {
    vision: Boolean(caps.vision),
    json: Boolean(caps.json),
    reasoning: Boolean(caps.reasoning),
    streaming: Boolean(caps.streaming),
    tts: Boolean(caps.tts),
  };
}

function renderModelRow(provider, model) {
  const caps = modelCaps(model);
  const ctx = fmtCtx(model.contextWindow);
  return `<li class="provider-model-item">
    <strong class="mono">${esc(model.id)}</strong>
    <div class="cap-badges" role="group" aria-label="Capabilities for ${esc(model.id)}">
      <button type="button" class="cap-pill ${caps.vision ? 'on' : ''}" data-provider-cap="vision" data-provider-id="${esc(provider.id)}" data-model-id="${esc(model.id)}" aria-pressed="${caps.vision}" title="Vision input supported">Vision</button>
      <button type="button" class="cap-pill ${caps.json ? 'on' : ''}" data-provider-cap="json" data-provider-id="${esc(provider.id)}" data-model-id="${esc(model.id)}" aria-pressed="${caps.json}" title="Structured JSON output">JSON</button>
      <button type="button" class="cap-pill ${caps.reasoning ? 'on' : ''}" data-provider-cap="reasoning" data-provider-id="${esc(provider.id)}" data-model-id="${esc(model.id)}" aria-pressed="${caps.reasoning}" title="Reasoning / thinking mode">Thinking</button>
      <button type="button" class="cap-pill ${caps.streaming ? 'on' : ''}" data-provider-cap="streaming" data-provider-id="${esc(provider.id)}" data-model-id="${esc(model.id)}" aria-pressed="${caps.streaming}" title="Streaming responses">Stream</button>
      ${ctx ? `<span class="cap-meta mono">${esc(ctx)}</span>` : ''}
    </div>
  </li>`;
}

function providerCard(provider) {
  const kind = providerKind(provider);
  const auth = provider.auth || {};
  const monogram = (provider.label || provider.id || '?')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase();
  const models = Array.isArray(provider.models) ? provider.models : [];
  const hasSecret = Boolean(auth.hasSecret);
  const pending = state.confirmDelete.id === provider.id;
  return `<article class="provider-card" data-provider-id="${esc(provider.id)}" data-kind="${esc(kind)}" data-health="${provider.lastTest && !provider.lastTest.ok ? 'error' : provider.lastTest?.ok ? 'ok' : 'unknown'}">
    <div class="provider-card-head">
      <span class="provider-monogram" aria-hidden="true">${esc(monogram || '·')}</span>
      <div class="provider-title-wrap">
        <h3>${esc(provider.label || provider.id)} <code class="lane-id">${esc(provider.id)}</code></h3>
        <span class="provider-endpoint mono">${esc(provider.baseUrl || 'No base URL')}</span>
      </div>
      ${probeBadge(provider)}
    </div>

    <div class="provider-auth-row">
      ${
        hasSecret
          ? `<span class="secret-hint-chip" data-has-secret="true">${icon('check')}Key stored · <code>${esc(auth.secretHint || '••••')}</code></span>`
          : `<span class="pill">${esc(auth.mode === 'none' ? 'No key needed' : 'No key stored')}</span>`
      }
      <span class="provider-model-count">${models.length} model${models.length === 1 ? '' : 's'} · ${esc(KIND_LABEL[kind])}</span>
      ${provider.allowPrivateNetwork ? '<span class="badge-square mono">allowPrivateNetwork</span>' : ''}
    </div>

    ${
      models.length
        ? `<ul class="provider-models-list" aria-label="Models in ${esc(provider.label || provider.id)}">${models.map((m) => renderModelRow(provider, m)).join('')}</ul>`
        : '<p class="provider-model-count">No models yet. Discover them or add one manually.</p>'
    }

    <details class="advanced-block provider-add-model">
      <summary>Add a model manually</summary>
      <div class="stage-add-bar">
        <label for="addModel-${esc(provider.id)}">Model ID</label>
        <div class="stage-add-controls">
          <input id="addModel-${esc(provider.id)}" class="field-input mono" type="text" placeholder="vendor/model-name" data-add-model-input="${esc(provider.id)}" spellcheck="false">
          <button type="button" class="btn small primary" data-provider-action="add-model" data-id="${esc(provider.id)}">Add model</button>
        </div>
        <div class="cap-badges" role="group" aria-label="New model capabilities">
          <button type="button" class="cap-pill" data-new-cap="vision" data-provider-id="${esc(provider.id)}" aria-pressed="false">Vision</button>
          <button type="button" class="cap-pill on" data-new-cap="json" data-provider-id="${esc(provider.id)}" aria-pressed="true">JSON</button>
          <button type="button" class="cap-pill" data-new-cap="reasoning" data-provider-id="${esc(provider.id)}" aria-pressed="false">Thinking</button>
          <button type="button" class="cap-pill on" data-new-cap="streaming" data-provider-id="${esc(provider.id)}" aria-pressed="true">Stream</button>
        </div>
        <div class="stage-add-controls">
          <input class="field-input mono" type="number" min="0" step="1000" placeholder="Context window" data-add-model-ctx="${esc(provider.id)}" aria-label="Context window tokens">
          <input class="field-input mono" type="number" min="0" step="256" placeholder="Max output tokens" data-add-model-max="${esc(provider.id)}" aria-label="Max output tokens">
        </div>
      </div>
    </details>

    <div class="provider-card-actions">
      <button type="button" class="btn small" data-provider-action="test" data-id="${esc(provider.id)}">Test connection</button>
      <button type="button" class="btn small" data-provider-action="discover" data-id="${esc(provider.id)}">Discover models</button>
      <button type="button" class="btn small" data-provider-action="edit" data-id="${esc(provider.id)}">Edit</button>
      <button type="button" class="btn small ${pending ? 'danger' : 'quiet danger-text'}" data-provider-action="delete" data-id="${esc(provider.id)}">${pending ? 'Confirm remove' : 'Remove'}</button>
    </div>
  </article>`;
}

function renderProviders() {
  const grid = $('providerGrid');
  if (!state.providersAvailable) {
    grid.innerHTML = `<div class="provider-empty-note">This server build does not expose <code>/api/studio/providers</code> yet. The studio UI is ready; provider storage arrives with the studio API.</div>`;
    $('providerCount').textContent = '0 providers';
    return;
  }
  const list = state.providers.filter((p) => state.filter === 'all' || providerKind(p) === state.filter);
  $('providerCount').textContent = `${list.length} of ${state.providers.length} provider${state.providers.length === 1 ? '' : 's'}`;
  if (!list.length) {
    grid.innerHTML = `<div class="provider-empty-note">${state.providers.length ? 'No providers match this filter.' : 'No providers yet. Use <strong>Add provider</strong> to register your first model endpoint.'}</div>`;
    return;
  }
  grid.innerHTML = list.map(providerCard).join('');
  $('studioAlertDot').hidden = !state.providers.some((p) => p.lastTest && !p.lastTest.ok);
}

async function loadProviders() {
  try {
    const data = await request('/api/studio/providers');
    state.providers = Array.isArray(data) ? data : data?.providers || [];
    state.providersRevision = Number(data?.revision ?? state.providersRevision) || 0;
    state.providersAvailable = true;
  } catch (err) {
    if (err.status === 404 || err.status === 501) {
      state.providersAvailable = false;
    } else {
      throw err;
    }
  }
  renderProviders();
}

function findProvider(id) {
  return state.providers.find((p) => p.id === id) || null;
}

function providerPayload(provider, patch = {}) {
  return {
    id: provider.id,
    label: provider.label,
    preset: provider.preset,
    kind: providerKind(provider),
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled !== false,
    allowPrivateNetwork: Boolean(provider.allowPrivateNetwork),
    headers: provider.headers || undefined,
    extraBody: provider.extraBody || undefined,
    models: (provider.models || []).map((m) => ({
      id: m.id,
      label: m.label,
      enabled: m.enabled !== false,
      capabilities: modelCaps(m),
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
    })),
    expectedRevision: state.providersRevision,
    ...patch,
  };
}

async function saveProvider(payload) {
  const data = await request('/api/studio/providers', { method: 'POST', body: payload });
  const revision = Number(data?.provider?.revision ?? data?.revision);
  if (Number.isFinite(revision)) state.providersRevision = revision;
  await loadProviders();
  return data;
}

async function testProvider(id) {
  const card = document.querySelector(`[data-provider-id="${CSS.escape(id)}"]`);
  const button = card?.querySelector('[data-provider-action="test"]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Testing…';
  }
  try {
    const data = await request(`/api/studio/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
    const count = Number(data?.modelsCount ?? (Array.isArray(data?.models) ? data.models.length : 0)) || 0;
    toast(
      data?.ok === false
        ? `Test failed: ${data.error || 'no response'}`
        : `Connected · ${fmtMs(data?.latencyMs)}${count ? ` · ${count} model${count === 1 ? '' : 's'}` : ''}`,
    );
    await loadProviders();
  } catch (err) {
    toast(err.message);
    if (button) {
      button.disabled = false;
      button.textContent = 'Test connection';
    }
  }
}

async function discoverModels(id) {
  const card = document.querySelector(`[data-provider-id="${CSS.escape(id)}"]`);
  const button = card?.querySelector('[data-provider-action="discover"]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Discovering…';
  }
  try {
    const data = await request(`/api/studio/providers/${encodeURIComponent(id)}/models/discover`, { method: 'POST', body: {} });
    const count = Array.isArray(data?.models) ? data.models.length : Number(data?.modelCount) || 0;
    toast(`Discovered ${count} model${count === 1 ? '' : 's'}.`);
    await loadProviders();
  } catch (err) {
    toast(err.message);
    if (button) {
      button.disabled = false;
      button.textContent = 'Discover models';
    }
  }
}

async function toggleCapability(providerId, modelId, cap) {
  const provider = findProvider(providerId);
  if (!provider) return;
  const model = (provider.models || []).find((m) => m.id === modelId);
  if (!model) return;
  const caps = modelCaps(model);
  model.capabilities = { ...caps, [cap]: !caps[cap] };
  renderProviders();
  try {
    await saveProvider(providerPayload(provider));
    toast('Capability saved.');
  } catch (err) {
    toast(err.message);
    await loadProviders();
  }
}

async function addModel(providerId) {
  const provider = findProvider(providerId);
  if (!provider) return;
  const input = document.querySelector(`[data-add-model-input="${CSS.escape(providerId)}"]`);
  const modelId = String(input?.value || '').trim();
  if (!modelId) {
    toast('Enter a model ID first.');
    input?.focus();
    return;
  }
  if ((provider.models || []).some((m) => m.id === modelId)) {
    toast('That model is already registered.');
    return;
  }
  const caps = {};
  document.querySelectorAll(`[data-new-cap][data-provider-id="${CSS.escape(providerId)}"]`).forEach((button) => {
    caps[button.dataset.newCap] = button.getAttribute('aria-pressed') === 'true';
  });
  const ctx = Number(document.querySelector(`[data-add-model-ctx="${CSS.escape(providerId)}"]`)?.value) || undefined;
  const max = Number(document.querySelector(`[data-add-model-max="${CSS.escape(providerId)}"]`)?.value) || undefined;
  provider.models = [
    ...(provider.models || []),
    {
      id: modelId,
      label: modelId,
      enabled: true,
      capabilities: {
        vision: Boolean(caps.vision),
        json: Boolean(caps.json),
        reasoning: Boolean(caps.reasoning),
        streaming: Boolean(caps.streaming),
        tts: false,
        writer: true,
      },
      contextWindow: ctx,
      maxOutputTokens: max,
    },
  ];
  try {
    await saveProvider(providerPayload(provider));
    toast(`Added ${modelId}.`);
  } catch (err) {
    toast(err.message);
    await loadProviders();
  }
}

function handleProviderDelete(id) {
  const button = document.querySelector(`[data-provider-action="delete"][data-id="${CSS.escape(id)}"]`);
  if (state.confirmDelete.id !== id) {
    state.confirmDelete.id = id;
    clearTimeout(state.confirmDelete.timer);
    state.confirmDelete.timer = setTimeout(() => {
      state.confirmDelete.id = '';
      renderProviders();
    }, 5000);
    renderProviders();
    document.querySelector(`[data-provider-action="delete"][data-id="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  clearTimeout(state.confirmDelete.timer);
  state.confirmDelete.id = '';
  request(`/api/studio/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: { expectedRevision: state.providersRevision },
  })
    .then(async () => {
      toast('Provider removed.');
      await loadProviders();
    })
    .catch((err) => {
      toast(err.message);
      renderProviders();
    });
  if (button) button.disabled = true;
}

/* ------------------------------------------------------------------ *
 * Provider dialog
 * ------------------------------------------------------------------ */

function setMode(mode) {
  state.dialogMode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const on = button.dataset.mode === mode;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  });
  for (const name of ['api', 'oauth', 'vertex', 'local']) {
    $(`modePanel${name[0].toUpperCase()}${name.slice(1)}`).hidden = name !== mode;
  }
  if (mode === 'oauth') syncOAuthFlow();
  if (state.editingProviderId) return;
  // Retarget the draft identity when the user switches connection mode.
  const defaults = {
    api: { id: 'openrouter-main', label: 'OpenRouter' },
    oauth: { id: 'codex-oauth', label: 'OpenAI Codex (subscription)' },
    vertex: { id: 'vertex-main', label: 'Google Vertex AI' },
    local: { id: 'ollama-local', label: 'Ollama (local)' },
  }[mode];
  if (!defaults) return;
  const idField = $('pvId');
  const labelField = $('pvLabel');
  const knownIds = ['openrouter-main', 'codex-oauth', 'vertex-main', 'ollama-local'];
  if (!idField.value.trim() || knownIds.includes(idField.value.trim())) idField.value = defaults.id;
  if (!labelField.value.trim() || labelField.value.trim() === 'OpenRouter') labelField.value = defaults.label;
}

function syncOAuthFlow() {
  const flow = $('oauthFlow').value;
  $('oauthPkceBlock').hidden = !['codex-oauth', 'claude-oauth'].includes(flow);
  $('oauthDeviceBlock').hidden = flow !== 'github-copilot';
  $('oauthGatewayBlock').hidden = flow !== 'subscription-bridge';
  if (flow === 'subscription-bridge') {
    const preset = PROVIDER_PRESETS.find((p) => p.id === 'subscription-bridge');
    if (preset && !$('gwUrl').value) $('gwUrl').value = preset.baseUrl;
  }
}

function fillPresetOptions(kind) {
  const options = PROVIDER_PRESETS.filter((p) => p.kind === kind);
  $('pvPreset').innerHTML = options.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
}

function applyPreset(presetId) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  if (preset.baseUrl) $('pvBaseUrl').value = preset.baseUrl;
  if (!$('pvLabel').value.trim()) $('pvLabel').value = preset.label;
  if (!$('pvId').value.trim()) $('pvId').value = preset.id === 'custom-openai' ? 'custom-openai-main' : preset.id;
}

function resetProviderDialog() {
  state.editingProviderId = '';
  state.vertexJson = '';
  state.oauth.pkce = null;
  stopDevicePoll();
  $('providerDialogTitle').textContent = 'Add a provider';
  $('providerForm').reset();
  $('pvId').disabled = false;
  $('pvApiKey').value = '';
  $('pvHeaders').value = '';
  $('pvExtraBody').value = '';
  $('pvKeyChip').hidden = true;
  $('pvRevokeKey').hidden = true;
  $('vertexPreview').hidden = true;
  $('vertexError').hidden = true;
  $('providerFormError').hidden = true;
  $('pkceLink').value = '';
  $('pkceCallback').value = '';
  $('pkceStatus').textContent = 'Not started';
  $('pkceStatus').dataset.state = 'idle';
  $('deviceCode').textContent = '········';
  $('deviceStatus').textContent = 'Not started';
  $('deviceStatus').dataset.state = 'idle';
  $('localAllowPrivate').checked = true;
  $('vertexDrop').classList.remove('is-valid');
  $('vertexDropLabel').textContent = 'Drop the .json key or browse';
  $('vertexDropMeta').textContent = 'Validated locally · under 64 KB';
  setMode('api');
  fillPresetOptions('cloud-api');
  applyPreset('openrouter');
}

function openProviderDialog(providerId = '') {
  resetProviderDialog();
  if (providerId) {
    const provider = findProvider(providerId);
    if (provider) {
      state.editingProviderId = provider.id;
      $('providerDialogTitle').textContent = `Edit ${provider.label || provider.id}`;
      $('pvId').value = provider.id;
      $('pvId').disabled = true;
      $('pvLabel').value = provider.label || '';
      const kind = providerKind(provider);
      setMode(kind === 'subscription' ? 'oauth' : kind === 'cloud-iam' ? 'vertex' : kind === 'local' ? 'local' : 'api');
      if (kind === 'cloud-api') {
        fillPresetOptions('cloud-api');
        if (provider.preset) $('pvPreset').value = provider.preset;
      }
      $('pvBaseUrl').value = provider.baseUrl || '';
      if (kind === 'local') $('localBaseUrl').value = provider.baseUrl || '';
      if (kind === 'subscription') {
        if (provider.preset) $('oauthFlow').value = provider.preset;
        syncOAuthFlow();
      }
      if (kind === 'cloud-iam') {
        $('vertexLocation').value = provider.auth?.location || 'global';
        if (provider.auth?.projectId) {
          $('vertexPreview').hidden = false;
          $('vertexProject').textContent = provider.auth.projectId;
          $('vertexEmail').textContent = provider.auth.clientEmail || '—';
        }
      }
      if (provider.auth?.hasSecret) {
        $('pvKeyChip').hidden = false;
        $('pvKeyHint').textContent = provider.auth.secretHint || '••••';
        $('pvRevokeKey').hidden = false;
      }
      if (provider.headers) $('pvHeaders').value = JSON.stringify(provider.headers, null, 2);
      if (provider.extraBody) $('pvExtraBody').value = JSON.stringify(provider.extraBody, null, 2);
    }
  }
  $('providerDialog').showModal();
  ($('pvId').disabled ? $('pvLabel') : $('pvId')).focus({ preventScroll: true });
}

function parseJsonField(id, label) {
  const raw = $(id).value.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function providerSubmitPayload() {
  const mode = state.dialogMode;
  const id = $('pvId').value.trim();
  const label = $('pvLabel').value.trim() || id;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('Provider ID must be lowercase letters, numbers, dots, or dashes.');
  const existing = findProvider(id);

  if (mode === 'api') {
    const preset = $('pvPreset').value;
    const baseUrl = $('pvBaseUrl').value.trim();
    if (!baseUrl) throw new Error('Base URL is required.');
    const payload = {
      id,
      label,
      preset,
      kind: 'cloud-api',
      protocol: PROVIDER_PRESETS.find((p) => p.id === preset)?.protocol || 'openai-compatible',
      baseUrl,
      allowPrivateNetwork: false,
      headers: parseJsonField('pvHeaders', 'Custom headers'),
      extraBody: parseJsonField('pvExtraBody', 'Extra body'),
      expectedRevision: state.providersRevision,
    };
    const key = $('pvApiKey').value.trim();
    if (key) payload.apiKey = key;
    else if (!existing?.auth?.hasSecret) throw new Error('Enter an API key for this provider.');
    return payload;
  }

  if (mode === 'oauth') {
    const flow = $('oauthFlow').value;
    const preset = PROVIDER_PRESETS.find((p) => p.id === flow);
    if (flow === 'subscription-bridge') {
      const gateway = $('gwUrl').value.trim();
      if (!gateway) throw new Error('Gateway URL is required.');
      const token = $('gwToken').value.trim();
      return {
        id,
        label,
        preset: flow,
        kind: 'subscription',
        protocol: 'openai-compatible',
        baseUrl: gateway,
        allowPrivateNetwork: /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(gateway),
        expectedRevision: state.providersRevision,
        auth: { mode: 'bearer' },
        ...(token ? { apiKey: token } : {}),
      };
    }
    if (!state.oauth.pkce?.authorized && !state.oauth.device?.authorized && !existing?.auth?.hasSecret) {
      throw new Error('Finish the login flow before saving this provider.');
    }
    return {
      id,
      label,
      preset: flow,
      kind: 'subscription',
      protocol: preset?.protocol || 'openai-compatible',
      baseUrl: preset?.baseUrl || '',
      allowPrivateNetwork: false,
      expectedRevision: state.providersRevision,
      auth: { mode: flow === 'github-copilot' ? 'device-code' : 'oauth-pkce' },
    };
  }

  if (mode === 'vertex') {
    if (!state.vertexJson && !existing?.auth?.hasSecret) {
      throw new Error('Drop the service account JSON before saving.');
    }
    const payload = {
      id,
      label,
      preset: 'vertex-ai',
      kind: 'cloud-iam',
      protocol: 'vertex-openai',
      baseUrl: 'https://aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/endpoints/openapi',
      allowPrivateNetwork: false,
      expectedRevision: state.providersRevision,
      auth: {
        mode: 'vertex-service-account',
        projectId: $('vertexProject').textContent !== '—' ? $('vertexProject').textContent : undefined,
        location: $('vertexLocation').value,
      },
    };
    if (state.vertexJson) payload.serviceAccountJson = state.vertexJson;
    return payload;
  }

  const localUrl = $('localBaseUrl').value.trim();
  if (!localUrl) throw new Error('Local base URL is required.');
  if (!/^https?:\/\//.test(localUrl)) throw new Error('Local base URL must start with http:// or https://.');
  return {
    id,
    label,
    kind: 'local',
    protocol: 'openai-compatible',
    baseUrl: localUrl,
    allowPrivateNetwork: $('localAllowPrivate').checked,
    expectedRevision: state.providersRevision,
    auth: { mode: 'none' },
  };
}

async function submitProvider(event) {
  event.preventDefault();
  const errorEl = $('providerFormError');
  const button = $('providerSubmit');
  errorEl.hidden = true;
  let payload;
  try {
    payload = providerSubmitPayload();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message;
    return;
  }
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await saveProvider(payload);
    $('pvApiKey').value = '';
    $('gwToken').value = '';
    state.vertexJson = '';
    $('providerDialog').close();
    toast(`Saved ${payload.label}.`);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Save provider';
  }
}

/* ------------------------------------------------------------------ *
 * OAuth: PKCE + device code
 * ------------------------------------------------------------------ */

async function startPkce() {
  const flow = $('oauthFlow').value;
  const button = $('pkceStartBtn');
  button.disabled = true;
  $('pkceStatus').dataset.state = 'busy';
  $('pkceStatus').textContent = 'Generating…';
  try {
    const data = await request('/api/studio/oauth/pkce-start', {
      method: 'POST',
      body: { preset: flow, providerId: $('pvId').value.trim() || undefined },
    });
    const url = data?.authorizeUrl || data?.authorize_url || data?.url || '';
    state.oauth.pkce = {
      flow,
      state: data?.state || '',
      codeVerifier: data?.codeVerifier || data?.code_verifier || '',
      redirectUri: data?.redirectUri || data?.redirect_uri || '',
      authorized: false,
    };
    $('pkceLink').value = url;
    $('pkceOpenBtn').disabled = !url;
    $('pkceStatus').dataset.state = 'ready';
    $('pkceStatus').textContent = url ? 'Link ready' : 'No link returned';
    if (url) {
      $('pkceCopy').focus({ preventScroll: true });
    }
  } catch (err) {
    $('pkceStatus').dataset.state = 'error';
    $('pkceStatus').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function exchangePkce() {
  const raw = $('pkceCallback').value.trim();
  if (!raw) {
    $('pkceStatus').dataset.state = 'error';
    $('pkceStatus').textContent = 'Paste the callback URL or code first.';
    return;
  }
  const button = $('pkceExchangeBtn');
  button.disabled = true;
  $('pkceStatus').dataset.state = 'busy';
  $('pkceStatus').textContent = 'Exchanging…';
  try {
    let code = raw;
    let stateParam = state.oauth.pkce?.state || '';
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      code = parsed.searchParams.get('code') || raw;
      stateParam = parsed.searchParams.get('state') || stateParam;
    }
    const data = await request('/api/studio/oauth/pkce-exchange', {
      method: 'POST',
      body: {
        preset: $('oauthFlow').value,
        providerId: $('pvId').value.trim() || undefined,
        code,
        state: stateParam,
        codeVerifier: state.oauth.pkce?.codeVerifier,
        redirectUri: state.oauth.pkce?.redirectUri,
      },
    });
    state.oauth.pkce = { ...(state.oauth.pkce || {}), authorized: true };
    $('pkceCallback').value = '';
    $('pkceStatus').dataset.state = 'ok';
    const expires = Number(data?.expiresIn ?? data?.expires_in);
    $('pkceStatus').textContent = Number.isFinite(expires) && expires > 0
      ? `Connected · auto-refreshes · valid ${Math.round(expires / 60)}m`
      : 'Connected · auto-refreshes';
  } catch (err) {
    $('pkceStatus').dataset.state = 'error';
    $('pkceStatus').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function formatDeviceCode(raw) {
  const clean = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length === 8) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return clean || '········';
}

function stopDevicePoll() {
  if (state.oauth.deviceTimer) {
    clearInterval(state.oauth.deviceTimer);
    state.oauth.deviceTimer = null;
  }
}

async function startDevice() {
  stopDevicePoll();
  const flow = $('oauthFlow').value;
  const button = $('deviceStartBtn');
  button.disabled = true;
  $('deviceStatus').dataset.state = 'busy';
  $('deviceStatus').textContent = 'Requesting code…';
  try {
    const data = await request('/api/studio/oauth/device-start', {
      method: 'POST',
      body: { providerId: flow },
    });
    const userCode = data?.userCode || data?.user_code || '';
    const verificationUri = data?.verificationUri || data?.verification_uri || data?.verificationUrl || '';
    const interval = Math.max(3, Number(data?.interval) || 5);
    state.oauth.device = {
      flow,
      deviceCode: data?.deviceCode || data?.device_code || '',
      authorized: false,
      verificationUri,
    };
    $('deviceCode').textContent = formatDeviceCode(userCode);
    $('deviceOpenBtn').disabled = !verificationUri;
    $('deviceOpenBtn').dataset.href = verificationUri;
    $('deviceStatus').dataset.state = 'waiting';
    let elapsed = 0;
    $('deviceStatus').textContent = `Waiting for browser authorization · ${elapsed}s…`;
    state.oauth.deviceTimer = setInterval(async () => {
      elapsed += interval;
      $('deviceStatus').textContent = `Waiting for browser authorization · ${elapsed}s…`;
      try {
        const poll = await request('/api/studio/oauth/device-poll', {
          method: 'POST',
          body: { providerId: flow, deviceCode: state.oauth.device?.deviceCode },
        });
        if (poll?.status === 'authorized' || poll?.provider) {
          stopDevicePoll();
          state.oauth.device.authorized = true;
          $('deviceStatus').dataset.state = 'ok';
          $('deviceStatus').textContent = 'Authorized · tokens stored';
          return;
        }
        if (poll?.status === 'pending' || poll?.pending) {
          if (elapsed >= 900) {
            stopDevicePoll();
            $('deviceStatus').dataset.state = 'error';
            $('deviceStatus').textContent = 'The code expired. Start the device login again.';
          }
          return;
        }
        stopDevicePoll();
        $('deviceStatus').dataset.state = 'error';
        $('deviceStatus').textContent = 'Authorization was not completed.';
      } catch (err) {
        stopDevicePoll();
        $('deviceStatus').dataset.state = 'error';
        $('deviceStatus').textContent = err.message;
      }
    }, interval * 1000);
  } catch (err) {
    $('deviceStatus').dataset.state = 'error';
    $('deviceStatus').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Vertex service account dropzone
 * ------------------------------------------------------------------ */

async function readVertexFile(file) {
  const errorEl = $('vertexError');
  errorEl.hidden = true;
  if (!file) return;
  if (!/\.json$/i.test(file.name || '')) {
    errorEl.hidden = false;
    errorEl.textContent = 'That file is not a .json key. Export the service account key as JSON.';
    return;
  }
  if (file.size > 64 * 1024) {
    errorEl.hidden = false;
    errorEl.textContent = 'That key is larger than 64 KB. Export a fresh service account key.';
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    errorEl.hidden = false;
    errorEl.textContent = 'That file is not valid JSON.';
    return;
  }
  const missing = ['type', 'project_id', 'client_email', 'private_key'].filter((k) => !parsed?.[k]);
  if (missing.length || parsed.type !== 'service_account') {
    errorEl.hidden = false;
    errorEl.textContent = `Not a service account key (missing ${missing.join(', ') || 'type: service_account'}).`;
    return;
  }
  state.vertexJson = JSON.stringify(parsed);
  $('vertexPreview').hidden = false;
  $('vertexProject').textContent = parsed.project_id;
  $('vertexEmail').textContent = parsed.client_email;
  $('vertexDrop').classList.add('is-valid');
  $('vertexDropLabel').textContent = file.name;
  $('vertexDropMeta').textContent = `${Math.round(file.size / 1024)} KB · parsed locally, stored write-only`;
  if (!$('pvLabel').value.trim()) $('pvLabel').value = `Vertex ${parsed.project_id}`;
  if (!$('pvId').value.trim()) $('pvId').value = 'vertex-main';
  if (!$('pvApiKey').value) $('pvApiKey').value = '';
}

/* ------------------------------------------------------------------ *
 * Stage routing
 * ------------------------------------------------------------------ */

function normalizeStages(data) {
  const stages = data?.stages || data || {};
  const out = {};
  for (const meta of STAGE_META) {
    const raw = stages[meta.id] || {};
    const chain = Array.isArray(raw.chain)
      ? raw.chain.map(String).filter(Boolean)
      : [raw.primary, ...(Array.isArray(raw.fallbacks) ? raw.fallbacks : [])].filter(Boolean).map(String);
    out[meta.id] = {
      stage: meta.id,
      chain,
      concurrency: Math.min(8, Math.max(1, Number(raw.concurrency) || 1)),
      temperature: Math.min(2, Math.max(0, Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.4)),
      inheritFrom: meta.inheritable && raw.inheritFrom ? String(raw.inheritFrom) : null,
      llmVerify: Boolean(raw.llmVerify),
    };
  }
  return out;
}

function routableStages() {
  const out = {};
  for (const [id, stage] of Object.entries(state.stagesDraft || {})) {
    if (ROUTABLE_STAGES.has(id)) out[id] = stage;
  }
  return out;
}

function stageModels() {
  const out = [];
  for (const provider of state.providers) {
    for (const model of provider.models || []) {
      const caps = modelCaps(model);
      out.push({
        lane: `${provider.id}:${model.id}`,
        providerId: provider.id,
        providerLabel: provider.label || provider.id,
        modelId: model.id,
        vision: caps.vision,
        json: caps.json,
        reasoning: caps.reasoning,
        streaming: caps.streaming,
        tts: caps.tts,
      });
    }
  }
  return out;
}

function laneInfo(lane) {
  const [providerId, ...rest] = String(lane).split(':');
  const modelId = rest.join(':');
  const provider = findProvider(providerId);
  const model = provider?.models?.find((m) => m.id === modelId);
  return {
    providerId,
    modelId,
    label: provider ? `${provider.label || providerId} / ${modelId}` : lane,
    caps: model ? modelCaps(model) : null,
    known: Boolean(provider && model),
  };
}

function chainSummary(stage) {
  const chain = stage.chain || [];
  if (!chain.length) return 'no models';
  const first = laneInfo(chain[0]);
  return chain.length === 1 ? first.modelId : `${first.modelId} + ${chain.length - 1} fallback${chain.length === 2 ? '' : 's'}`;
}

function stageRow(stage, modelLane, index, total) {
  const info = laneInfo(modelLane);
  const caps = info.caps;
  const capLine = caps
    ? [caps.vision ? 'Vision' : null, caps.json ? 'JSON' : null, caps.reasoning ? 'Thinking' : null].filter(Boolean).join(' · ') || 'Text only'
    : 'Not registered';
  const rank = index === 0 ? 'Primary' : `Fallback ${index}`;
  const rankClass = index === 0 ? 'primary' : 'fallback';
  return `<div class="lane-edit-row" role="listitem" draggable="true" data-stage="${esc(stage.stage)}" data-model-lane="${esc(modelLane)}" data-index="${index}">
    <button type="button" class="drag-handle" aria-label="Drag to reorder" tabindex="-1">⋮⋮</button>
    <span class="lane-rank-badge ${rankClass}" data-lane-rank>${rank}</span>
    <div class="lane-edit-copy">
      <strong>${esc(info.label)} <code class="lane-id">${esc(modelLane)}</code></strong>
      <span class="lane-desc">${esc(capLine)}${info.known ? '' : ' · not in the provider catalog'}</span>
    </div>
    <div class="lane-edit-controls">
      <div class="lane-move-group" role="group" aria-label="Reorder ${esc(modelLane)}">
        <button type="button" class="btn small lane-move-btn" data-stage-move="up" data-stage="${esc(stage.stage)}" data-model-lane="${esc(modelLane)}" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
        <button type="button" class="btn small lane-move-btn" data-stage-move="down" data-stage="${esc(stage.stage)}" data-model-lane="${esc(modelLane)}" aria-label="Move down" ${index === total - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>
        <button type="button" class="btn small lane-move-btn" data-stage-move="primary" data-stage="${esc(stage.stage)}" data-model-lane="${esc(modelLane)}" aria-label="Make primary" ${index === 0 ? 'disabled' : ''}>1st</button>
        <button type="button" class="btn small lane-move-btn danger" data-stage-remove data-stage="${esc(stage.stage)}" data-model-lane="${esc(modelLane)}" aria-label="Remove ${esc(modelLane)}">×</button>
      </div>
    </div>
  </div>`;
}

function stageCard(meta) {
  const draft = state.stagesDraft?.[meta.id];
  if (!draft) return '';
  if (meta.voiceTab) {
    const provider = state.tts.catalog?.providers?.find((p) => p.id === state.tts.provider)
      || state.tts.catalog?.providers?.[0]
      || null;
    const voice = provider?.voices?.find((v) => v.id === state.tts.voice) || provider?.voices?.[0] || null;
    return `<section class="stage-router-card" data-stage-card="${meta.id}" aria-labelledby="stageHead-${meta.id}">
      <header class="stage-router-head">
        <div>
          <div class="stage-title-line">
            <h3 id="stageHead-${meta.id}">${esc(meta.label)} <code class="lane-id">${meta.id}</code></h3>
            <span class="cap-gate-badge soft">${esc(meta.gateLabel)}</span>
          </div>
          <p class="stage-purpose">${esc(meta.purpose)}</p>
        </div>
      </header>
      <div class="stage-inherited-view">
        <span class="flow-arrow" aria-hidden="true">↳</span>
        <span>Configured in the Voice tab: <strong>${esc(provider ? `${provider.label} · ${voice?.label || 'no voice'}` : 'no narration provider')}</strong></span>
        <button type="button" class="btn small" data-action="open-voices">Open Voice &amp; TTS</button>
      </div>
    </section>`;
  }
  const reader = state.stagesDraft.reader;
  const inherited = Boolean(meta.inheritable && draft.inheritFrom === 'reader');
  const gate = meta.gate;
  const incompatible = !inherited && gate === 'vision'
    ? draft.chain.filter((lane) => laneInfo(lane).caps && !laneInfo(lane).caps.vision)
    : [];
  const options = stageModels()
    .slice()
    .sort((a, b) => Number(b.vision) - Number(a.vision) || a.lane.localeCompare(b.lane))
    .map((model) => {
      const blocked = gate === 'vision' && !model.vision;
      return `<option value="${esc(model.lane)}" ${blocked ? 'disabled' : ''}>${blocked ? 'Incompatible (requires vision) · ' : ''}${esc(model.lane)}</option>`;
    })
    .join('');
  return `<section class="stage-router-card" data-stage-card="${meta.id}" aria-labelledby="stageHead-${meta.id}">
    <header class="stage-router-head">
      <div>
        <div class="stage-title-line">
          <h3 id="stageHead-${meta.id}">${esc(meta.label)} <code class="lane-id">${meta.id}</code></h3>
          <span class="cap-gate-badge ${gate === 'vision' ? '' : 'soft'}">${esc(meta.gateLabel)}</span>
        </div>
        <p class="stage-purpose">${esc(meta.purpose)}</p>
      </div>
      ${
        meta.inheritable
          ? `<label class="inherit-toggle" title="Use the same model chain as reader">
              <input type="checkbox" data-stage-inherit="${meta.id}" data-inherit-from="reader" ${inherited ? 'checked' : ''}>
              <span>Inherit <code>reader</code></span>
            </label>`
          : ''
      }
    </header>

    ${
      inherited
        ? `<div class="stage-inherited-view" id="stageInherited-${meta.id}">
            <span class="flow-arrow" aria-hidden="true">↳</span>
            <span>Follows <strong>Reader</strong> chain (${esc(chainSummary(reader))})</span>
            <button type="button" class="btn small" data-action="customize-stage" data-stage="${meta.id}">Customize</button>
          </div>`
        : ''
    }

    <div class="stage-custom-view" id="stageCustom-${meta.id}" ${inherited ? 'hidden' : ''}>
      ${
        draft.chain.length
          ? `<div class="lane-editor-list sortable-stage-list" role="list" data-stage-list="${meta.id}">${draft.chain
              .map((lane, index) => stageRow(draft, lane, index, draft.chain.length))
              .join('')}</div>`
          : '<p class="stage-purpose">No models in this chain yet. Add one below.</p>'
      }
      ${incompatible.length ? `<p class="stage-gate-warning">${icon('shield')} ${incompatible.length} model${incompatible.length === 1 ? '' : 's'} in this chain do not report <code>vision: true</code>. Panel reading will fail for those calls.</p>` : ''}
      <div class="stage-params">
        <div class="stage-param-group" role="group" aria-label="Concurrency for ${meta.id}">
          <span class="stage-param-label">Concurrency</span>
          <div class="drag-stepper">
            <button type="button" class="step-dec" data-stage-step="-1" data-stage="${meta.id}" aria-label="Decrease concurrency">−</button>
            <input type="number" class="lane-num-input" data-stage-concurrency data-stage="${meta.id}" min="1" max="8" value="${draft.concurrency}" aria-label="Concurrency for ${meta.id}">
            <button type="button" class="step-inc" data-stage-step="1" data-stage="${meta.id}" aria-label="Increase concurrency">+</button>
          </div>
        </div>
        <label class="stage-param">Temp <input type="number" min="0" max="2" step="0.05" value="${draft.temperature}" data-stage-temp data-stage="${meta.id}" aria-label="Temperature for ${meta.id}"></label>
        ${
          meta.verifyToggle
            ? `<label class="lane-toggle"><input type="checkbox" data-stage-verify data-stage="${meta.id}" ${draft.llmVerify ? 'checked' : ''}><span>LLM verify pass</span></label>`
            : ''
        }
        <span class="stage-param">${draft.chain.length} model${draft.chain.length === 1 ? '' : 's'}</span>
      </div>
      <div class="stage-add-bar">
        <label for="stageAdd-${meta.id}">Add model to ${esc(meta.id)}</label>
        <div class="stage-add-controls">
          <select id="stageAdd-${meta.id}" data-stage-picker="${meta.id}" aria-label="Models for ${meta.id}">
            <option value="">Select a model…</option>
            ${options}
          </select>
          <button type="button" class="btn small" data-stage-add="${meta.id}">Add</button>
        </div>
      </div>
    </div>
  </section>`;
}

function renderStages() {
  const board = $('stageBoard');
  if (!state.stagesAvailable) {
    board.innerHTML = `<div class="provider-empty-note">This server build does not expose <code>/api/studio/stages</code> yet. The routing board is ready for it.</div>`;
    return;
  }
  if (!state.stagesDraft) {
    board.innerHTML = '<div class="panel dashboard-empty">Loading stage routing…</div>';
    return;
  }
  if (!state.focusKey) {
    const captured = captureStageFocus();
    if (captured) state.focusKey = captured;
  }
  board.innerHTML = STAGE_META.map(stageCard).join('');
  $('stageSaveBtn').disabled = !state.stagesDirty;
  restoreStageFocus();
  state.focusKey = '';
}

function captureStageFocus() {
  const el = document.activeElement;
  if (!el || !$('stageBoard').contains(el)) return '';
  const row = el.closest('[data-stage][data-model-lane]');
  const control = el.dataset.stageMove
    ? `move:${el.dataset.stageMove}`
    : el.dataset.stageRemove
      ? 'remove'
      : el.dataset.stageConcurrency !== undefined
        ? 'concurrency'
        : el.dataset.stageStep
          ? `step:${el.dataset.stageStep}`
          : el.dataset.stageInherit
            ? 'inherit'
            : el.dataset.stageTemp !== undefined
              ? 'temp'
              : el.dataset.stagePicker
                ? 'picker'
                : el.tagName.toLowerCase();
  return `${el.dataset.stage || ''}|${row?.dataset.modelLane || ''}|${control}`;
}

function restoreStageFocus() {
  if (!state.focusKey) return;
  const [stageId, lane, control] = state.focusKey.split('|');
  const card = $('stageBoard').querySelector(`[data-stage-card="${CSS.escape(stageId)}"]`);
  if (!card) return;
  let el = null;
  const row = lane ? card.querySelector(`[data-model-lane="${CSS.escape(lane)}"]`) : null;
  if (control.startsWith('move:') && row) el = row.querySelector(`[data-stage-move="${CSS.escape(control.slice(5))}"]`);
  else if (control === 'remove' && row) el = row.querySelector('[data-stage-remove]');
  else if (control === 'concurrency' && row) el = row.querySelector('[data-stage-concurrency]');
  else if (control.startsWith('step:') && row) el = row.querySelector(`[data-stage-step="${CSS.escape(control.slice(5))}"]`);
  else if (control.startsWith('step:')) el = card.querySelector(`[data-stage-step="${CSS.escape(control.slice(5))}"]`);
  else if (control === 'concurrency' && !row) el = card.querySelector('[data-stage-concurrency]');
  else if (control === 'inherit') el = card.querySelector('[data-stage-inherit]');
  else if (control === 'temp') el = card.querySelector('[data-stage-temp]');
  else if (control === 'picker') el = card.querySelector('[data-stage-picker]');
  if (el && !el.disabled) el.focus({ preventScroll: true });
}

async function loadStages() {
  try {
    const data = await request('/api/studio/stages');
    state.stages = data;
    state.stagesBaseRevision = Number(data?.revision) || 0;
    state.stagesDraft = normalizeStages(data);
    state.stagesDirty = false;
    state.stagesAvailable = true;
  } catch (err) {
    if (err.status === 404 || err.status === 501) {
      state.stagesAvailable = false;
      state.stagesDraft = normalizeStages(null);
    } else {
      throw err;
    }
  }
  renderStages();
}

function markStagesDirty() {
  state.stagesDirty = true;
  $('stageSaveBtn').disabled = false;
}

function stageNotice(message, kind = 'ok') {
  const el = $('stageNotice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = 'lane-notice' + (kind === 'error' ? ' error' : kind === 'warning' ? ' warning' : '');
  el.textContent = message;
}

function moveStageModel(stageId, lane, direction) {
  const stage = state.stagesDraft?.[stageId];
  if (!stage) return;
  const index = stage.chain.indexOf(lane);
  if (index < 0) return;
  const next = direction === 'primary' ? 0 : direction === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= stage.chain.length) return;
  stage.chain.splice(index, 1);
  stage.chain.splice(next, 0, lane);
  state.focusKey = `${stageId}|${lane}|move:${direction}`;
  markStagesDirty();
  renderStages();
}

async function saveStages() {
  if (!state.stagesDraft) return;
  const button = $('stageSaveBtn');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const body = { revision: state.stagesBaseRevision, stages: routableStages() };
    const data = await request('/api/studio/stages', { method: 'PUT', body });
    state.stagesBaseRevision = Number(data?.revision ?? state.stagesBaseRevision) || state.stagesBaseRevision;
    state.stages = data;
    state.stagesDraft = normalizeStages(data);
    state.stagesDirty = false;
    $('stageConflict').hidden = true;
    stageNotice('Routing saved. New calls use this order.');
    renderStages();
  } catch (err) {
    if (err.status === 409) {
      $('stageConflict').hidden = false;
      stageNotice('Save blocked: a newer revision exists. Keep your draft or reload.', 'warning');
    } else {
      stageNotice(err.message, 'error');
    }
  } finally {
    button.textContent = 'Save routing';
    button.disabled = !state.stagesDirty;
  }
}

/* ------------------------------------------------------------------ *
 * Render nodes
 * ------------------------------------------------------------------ */

const NODE_ICON = { local: 'monitor', 'docker-sbx': 'cloud', ssh: 'network' };

function nodeMeter(label, level, value, zone) {
  const pct = Math.max(0, Math.min(1, Number(level) || 0));
  return `<div class="node-meter-row">
    <span class="node-meter-label">${esc(label)}</span>
    <div class="audiocn-meter" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}" data-zone="${esc(zone || 'ok')}" style="--meter-level: ${pct.toFixed(2)}"><i class="meter-fill"></i></div>
    <span class="node-meter-val mono">${esc(value)}</span>
  </div>`;
}

function nodeCard(node) {
  const kind = String(node.kind || 'local');
  const label = node.label || node.id;
  const status = String(node.status || (node.enabled === false ? 'disabled' : 'available'));
  const statusPill = status === 'busy'
    ? '<span class="pill busy">Busy</span>'
    : status === 'paused'
      ? '<span class="pill paused">Paused</span>'
      : status === 'breaker-open' || status === 'unavailable'
        ? '<span class="pill failed">Offline</span>'
        : node.enabled === false
          ? '<span class="pill unavailable">Disabled</span>'
          : '<span class="pill running">Ready</span>';
  const facts = [
    kind === 'docker-sbx' ? `Box <code>${esc(node.box || '—')}</code>` : '',
    kind === 'ssh' ? `<code>${esc(node.user || '—')}@${esc(node.host || '—')}:${esc(node.port || 22)}</code>` : '',
    `${esc(node.slots || 1)} slot${Number(node.slots) === 1 ? '' : 's'}`,
    node.supportsCleaner ? 'Cleaner on' : 'Cleaner off',
    Number.isFinite(Number(node.priority)) ? `Priority ${esc(node.priority)}` : '',
  ].filter(Boolean);
  const cpu = Number(node.cpuLoad ?? node.load ?? NaN);
  const mem = Number(node.memFreeGb ?? NaN);
  const disk = Number(node.diskFreeGb ?? NaN);
  const ttlUsed = Number(node.ttlUsedHours ?? NaN);
  const ttlMax = Number(node.maxHours ?? 0);
  const cpuText = Number.isFinite(cpu) ? `${Math.round(cpu)}%` : '—';
  const memText = Number.isFinite(mem) ? `${mem.toFixed(1)} GB` : '—';
  const diskText = Number.isFinite(disk) ? `${disk.toFixed(1)} GB` : '—';
  return `<article class="worker-card studio-node-card" data-node-id="${esc(node.id)}" data-kind="${esc(kind)}">
    <div class="worker-head">
      <span class="worker-icon">${icon(NODE_ICON[kind] || 'monitor')}</span>
      <div>
        <h3>${esc(label)} <code class="lane-id">${esc(node.id)}</code></h3>
        <p>${esc(kind === 'docker-sbx' ? 'Docker cloud sandbox' : kind === 'ssh' ? 'Remote SSH worker' : 'Local machine')}</p>
      </div>
      ${statusPill}
    </div>

    <div class="lcd-strip">
      <span>KIND <b>${esc(kind)}</b></span>
      ${kind === 'docker-sbx' ? `<span>TEMPLATE <b>${esc(node.template || 'manhwa-render-arm')}</b></span><span>TTL <b>${ttlMax ? `${Number.isFinite(ttlUsed) ? ttlUsed.toFixed(1) : '0.0'} / ${ttlMax.toFixed(1)}h` : '—'}</b></span><span>IDLE PAUSE <b>${esc(node.idlePauseS ?? 300)}s</b></span>` : ''}
      ${kind === 'ssh' ? `<span>MIN RAM <b>${esc(node.minMemGb ?? '—')} GB</b></span><span>MIN DISK <b>${esc(node.minDiskGb ?? '—')} GB</b></span><span>KEY <b>${node.auth?.hasSecret ? esc(node.auth.secretHint || 'stored') : 'none'}</b></span>` : ''}
      ${kind === 'local' ? '<span>BUILT-IN <b>yes</b></span>' : ''}
    </div>

    <div class="node-meters">
      ${nodeMeter('CPU LOAD', Number.isFinite(cpu) ? cpu / 100 : 0, cpuText, Number.isFinite(cpu) && cpu > 85 ? 'clip' : Number.isFinite(cpu) && cpu > 60 ? 'warn' : 'ok')}
      ${nodeMeter('RAM FREE', Number.isFinite(mem) ? mem / Math.max(1, Number(node.minMemGb || 16)) : 0, memText, Number.isFinite(mem) && mem < Number(node.minMemGb || 0) ? 'clip' : 'ok')}
      ${nodeMeter('DISK FREE', Number.isFinite(disk) ? disk / Math.max(1, Number(node.minDiskGb || 50)) : 0, diskText, Number.isFinite(disk) && disk < Number(node.minDiskGb || 0) ? 'clip' : 'ok')}
    </div>

    <div class="node-facts">${facts.map((fact) => `<span>${fact}</span>`).join('')}</div>

    <div class="worker-card-actions node-live-actions">
      <button type="button" class="btn small" data-node-action="probe" data-id="${esc(node.id)}">Test probe</button>
      ${kind === 'docker-sbx' ? `<button type="button" class="btn small primary" data-node-action="start" data-id="${esc(node.id)}">Start sandbox</button><button type="button" class="btn small" data-node-action="stop" data-id="${esc(node.id)}">Stop</button>` : ''}
      <button type="button" class="btn small" data-node-action="edit" data-id="${esc(node.id)}">Configure</button>
    </div>
  </article>`;
}

function renderNodes() {
  const grid = $('nodeGrid');
  if (!state.nodesAvailable) {
    grid.innerHTML = `<div class="provider-empty-note">This server build does not expose <code>/api/studio/nodes</code> yet. The node registry UI is ready for it.</div>`;
    return;
  }
  if (!state.nodes.length) {
    grid.innerHTML = `<div class="provider-empty-note">No render nodes registered. The local machine is used by default; add a cloud sandbox or SSH worker for more throughput.</div>`;
    return;
  }
  grid.innerHTML = state.nodes.map(nodeCard).join('');
}

async function loadNodes() {
  try {
    const data = await request('/api/studio/nodes');
    const configured = Array.isArray(data) ? data : data?.nodes || [];
    const runtime = Array.isArray(data?.runtimeNodes) ? data.runtimeNodes : [];
    const byId = new Map(runtime.map((node) => [node.id, node]));
    state.nodes = configured.map((node) => ({ ...(byId.get(node.id) || {}), ...node }));
    state.nodesRevision = configured.reduce((max, node) => Math.max(max, Number(node.revision) || 0), 0);
    state.nodesAvailable = true;
  } catch (err) {
    if (err.status === 404 || err.status === 501) {
      state.nodesAvailable = false;
    } else {
      throw err;
    }
  }
  renderNodes();
}

function nodeNotice(message, kind = 'ok') {
  const el = $('nodeNotice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = 'lane-notice' + (kind === 'error' ? ' error' : kind === 'warning' ? ' warning' : '');
  el.textContent = message;
}

async function runNodeAction(id, action) {
  const node = state.nodes.find((n) => n.id === id);
  const kind = String(node?.kind || 'local');
  const button = document.querySelector(`[data-node-action="${action}"][data-id="${CSS.escape(id)}"]`);
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = action === 'probe' ? 'Probing…' : `${action[0].toUpperCase()}${action.slice(1)}…`;
  }
  try {
    if (action === 'probe') {
      const data = await request(`/api/studio/nodes/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
      nodeNotice(
        data?.ok === false ? `Probe failed: ${data.reason || 'no response'}` : `Probe ok · ${data?.reason || kind}`,
        data?.ok === false ? 'error' : 'ok',
      );
    } else {
      const data = await request(`/api/studio/nodes/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body: { action },
      });
      nodeNotice(
        `${action[0].toUpperCase()}${action.slice(1)} for ${id}: ${data?.detail || (data?.ok === false ? 'refused' : 'accepted')}`,
        data?.ok === false ? 'error' : 'ok',
      );
    }
    await loadNodes();
  } catch (err) {
    nodeNotice(err.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function resetSbxDialog() {
  state.editingNodeId = '';
  $('sbxForm').reset();
  $('sbxDialogTitle').textContent = 'Add cloud sandbox';
  $('sbxSlots').value = '2';
  $('sbxMaxHours').value = '4';
  $('sbxIdlePause').value = '300';
  $('sbxIdlePauseValue').textContent = '300s';
  $('sbxLogBody').textContent = 'No sandbox actions yet.';
  $('sbxError').hidden = true;
}

function openSbxDialog(nodeId = '') {
  resetSbxDialog();
  if (nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node) {
      state.editingNodeId = node.id;
      $('sbxDialogTitle').textContent = `Configure ${node.label || node.id}`;
      $('sbxId').value = node.id;
      $('sbxId').disabled = true;
      $('sbxLabel').value = node.label || '';
      $('sbxBox').value = node.box || '';
      $('sbxTemplate').value = node.template || 'manhwa-render-arm';
      $('sbxSlots').value = String(node.slots || 2);
      $('sbxMaxHours').value = String(node.maxHours || 4);
      $('sbxIdlePause').value = String(node.idlePauseS || 300);
      $('sbxIdlePauseValue').textContent = `${node.idlePauseS || 300}s`;
    }
  }
  $('sbxDialog').showModal();
  ($('sbxId').disabled ? $('sbxLabel') : $('sbxId')).focus({ preventScroll: true });
}

function resetSshDialog() {
  state.editingNodeId = '';
  $('sshForm').reset();
  $('sshDialogTitle').textContent = 'Add SSH worker';
  $('sshPort').value = '22';
  $('sshSlots').value = '2';
  $('sshMaxLoad').value = '8';
  $('sshMinMem').value = '4';
  $('sshMinDisk').value = '10';
  $('sshCleaner').checked = true;
  $('sshKeyFile').value = '';
  $('sshKeyPaste').value = '';
  $('sshKeyChip').hidden = true;
  $('sshPreflight').hidden = true;
  $('sshProbeStatus').textContent = 'Not probed';
  $('sshProbeStatus').dataset.state = 'idle';
  $('sshError').hidden = true;
}

function openSshDialog(nodeId = '') {
  resetSshDialog();
  if (nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (node) {
      state.editingNodeId = node.id;
      $('sshDialogTitle').textContent = `Configure ${node.label || node.id}`;
      $('sshId').value = node.id;
      $('sshId').disabled = true;
      $('sshLabel').value = node.label || '';
      $('sshHost').value = node.host || '';
      $('sshUser').value = node.user || '';
      $('sshPort').value = String(node.port || 22);
      $('sshRemoteDir').value = node.remoteDir || '';
      $('sshSlots').value = String(node.slots || 2);
      $('sshMaxLoad').value = String(node.maxLoadFactor ?? 8);
      $('sshMinMem').value = String(node.minMemGb ?? 4);
      $('sshMinDisk').value = String(node.minDiskGb ?? 10);
      $('sshCleaner').checked = node.supportsCleaner !== false;
      if (node.auth?.hasSecret) {
        $('sshKeyChip').hidden = false;
        $('sshKeyHint').textContent = node.auth.secretHint || 'SHA256:…';
      }
    }
  }
  $('sshDialog').showModal();
  ($('sshId').disabled ? $('sshLabel') : $('sshId')).focus({ preventScroll: true });
}

async function submitSbx(event) {
  event.preventDefault();
  const errorEl = $('sbxError');
  errorEl.hidden = true;
  const id = $('sbxId').value.trim();
  const box = $('sbxBox').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    errorEl.hidden = false;
    errorEl.textContent = 'Node ID must be lowercase letters, numbers, dots, or dashes.';
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(box)) {
    errorEl.hidden = false;
    errorEl.textContent = 'Sandbox box name must be 3–63 lowercase characters, numbers, or hyphens.';
    return;
  }
  const button = $('sbxSubmit');
  button.disabled = true;
  try {
    await request('/api/studio/nodes', {
      method: 'POST',
      body: {
        id,
        label: $('sbxLabel').value.trim() || id,
        kind: 'docker-sbx',
        box,
        template: $('sbxTemplate').value,
        slots: Number($('sbxSlots').value) || 2,
        maxHours: Number($('sbxMaxHours').value) || 4,
        idlePauseS: Number($('sbxIdlePause').value) || 300,
        enabled: true,
        supportsCleaner: true,
        expectedRevision: state.nodesRevision,
      },
    });
    $('sbxDialog').close();
    nodeNotice(`Saved sandbox ${id}.`);
    await loadNodes();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function submitSsh(event) {
  event.preventDefault();
  const errorEl = $('sshError');
  errorEl.hidden = true;
  const id = $('sshId').value.trim();
  const host = $('sshHost').value.trim();
  const user = $('sshUser').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    errorEl.hidden = false;
    errorEl.textContent = 'Node ID must be lowercase letters, numbers, dots, or dashes.';
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host) || host.startsWith('-')) {
    errorEl.hidden = false;
    errorEl.textContent = 'Host may only contain letters, numbers, dots, dashes, or underscores.';
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(user) || user.startsWith('-')) {
    errorEl.hidden = false;
    errorEl.textContent = 'User may only contain letters, numbers, dots, dashes, or underscores.';
    return;
  }
  const keyFile = $('sshKeyFile').files?.[0];
  const keyPaste = $('sshKeyPaste').value.trim();
  let sshKey = keyPaste;
  if (!sshKey && keyFile) sshKey = await keyFile.text();
  if (sshKey && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sshKey.trim())) {
    errorEl.hidden = false;
    errorEl.textContent = 'That does not look like an OpenSSH private key.';
    return;
  }
  const button = $('sshSubmit');
  button.disabled = true;
  try {
    await request('/api/studio/nodes', {
      method: 'POST',
      body: {
        id,
        label: $('sshLabel').value.trim() || id,
        kind: 'ssh',
        host,
        user,
        port: Number($('sshPort').value) || 22,
        remoteDir: $('sshRemoteDir').value.trim() || undefined,
        slots: Number($('sshSlots').value) || 1,
        supportsCleaner: $('sshCleaner').checked,
        maxLoadFactor: Number($('sshMaxLoad').value) || undefined,
        minMemGb: Number($('sshMinMem').value) || undefined,
        minDiskGb: Number($('sshMinDisk').value) || undefined,
        enabled: true,
        expectedRevision: state.nodesRevision,
        ...(sshKey ? { sshKey } : {}),
      },
    });
    $('sshKeyPaste').value = '';
    $('sshKeyFile').value = '';
    $('sshDialog').close();
    nodeNotice(`Saved SSH worker ${id}.`);
    await loadNodes();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function probeSshFromDialog() {
  const id = $('sshId').value.trim();
  const status = $('sshProbeStatus');
  if (!id) {
    $('sshError').hidden = false;
    $('sshError').textContent = 'Save the node before probing it.';
    return;
  }
  const button = $('sshProbeBtn');
  button.disabled = true;
  status.dataset.state = 'busy';
  status.textContent = 'Probing…';
  try {
    const data = await request(`/api/studio/nodes/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
    const ok = data?.ok !== false;
    $('sshPreflight').hidden = false;
    $('sshPreflight').querySelectorAll('[data-preflight]').forEach((el) => {
      el.classList.toggle('ok', ok);
      el.classList.toggle('bad', !ok);
    });
    status.dataset.state = ok ? 'ok' : 'error';
    status.textContent = ok ? `Probe ok · ${data?.reason || 'reachable'}` : data?.reason || 'Probe failed';
  } catch (err) {
    status.dataset.state = 'error';
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function sbxDialogAction(action) {
  const id = $('sbxId').value.trim();
  const log = $('sbxLogBody');
  if (!id) {
    $('sbxError').hidden = false;
    $('sbxError').textContent = 'Enter a node ID first.';
    return;
  }
  $('sbxError').hidden = true;
  log.textContent = `${action} → ${id}…`;
  try {
    const data = await request(`/api/studio/nodes/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: { action },
    });
    const lines = [
      `${action} → ${id}`,
      data?.detail || (data?.ok === false ? 'refused' : 'accepted'),
    ];
    if (data?.status) lines.push(`status ${data.status}`);
    if (data?.ok === false) lines.push('Enable MANHWA_ALLOW_SANDBOX_CONTROL=1 to allow start/stop/create from the UI.');
    log.textContent = lines.join('\n');
  } catch (err) {
    log.textContent = `${action} failed\n${err.message}`;
  }
}

/* ------------------------------------------------------------------ *
 * TTS + voice preview
 * ------------------------------------------------------------------ */

function ttsProviders() {
  return Array.isArray(state.tts.catalog?.providers) ? state.tts.catalog.providers : [];
}

function ttsProvider() {
  return ttsProviders().find((p) => p.id === state.tts.provider) || ttsProviders()[0] || null;
}

function ttsVoice() {
  const provider = ttsProvider();
  const voices = provider?.voices || [];
  return voices.find((v) => v.id === state.tts.voice) || voices[0] || null;
}

function readStoredTts() {
  try {
    const raw = JSON.parse(localStorage.getItem(TTS_STORAGE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      if (typeof raw.provider === 'string') state.tts.provider = raw.provider;
      if (typeof raw.voice === 'string') state.tts.voice = raw.voice;
      if (Number.isFinite(Number(raw.rate))) state.tts.rate = Math.min(1.25, Math.max(0.9, Number(raw.rate)));
      if (typeof raw.text === 'string' && raw.text.trim()) state.tts.text = raw.text;
    }
  } catch {}
}

async function loadTtsCatalog() {
  if (state.tts.catalog) {
    if (!state.tts.provider) state.tts.provider = state.tts.catalog.defaultProvider || ttsProviders()[0]?.id || '';
    if (!state.tts.voice) {
      const provider = ttsProvider();
      state.tts.voice = provider?.voices?.find((v) => v.default)?.id || provider?.voices?.[0]?.id || '';
    }
    renderTtsForm();
    return;
  }
  try {
    const data = await request('/api/intake/catalog', { timeoutMs: 20000 });
    state.tts.catalog = data;
    if (data?.csrfToken) state.csrf = data.csrfToken;
    state.tts.provider = data?.defaultProvider || ttsProviders()[0]?.id || '';
    const provider = ttsProviders().find((p) => p.id === state.tts.provider);
    state.tts.voice = provider?.voices?.find((v) => v.default)?.id || provider?.voices?.[0]?.id || '';
  } catch (err) {
    $('ttsError').hidden = false;
    $('ttsError').textContent = `Could not load narration providers: ${err.message}`;
    return;
  }
  readStoredTts();
  renderTtsForm();
}

function renderTtsForm() {
  const providers = ttsProviders();
  $('ttsProvider').innerHTML = providers
    .map((p) => `<option value="${esc(p.id)}" ${p.id === state.tts.provider ? 'selected' : ''} ${p.available === false ? 'disabled' : ''}>${esc(p.label)}${p.available === false ? ' (Unavailable)' : ''}</option>`)
    .join('');
  const provider = ttsProvider();
  $('ttsVoice').innerHTML = (provider?.voices || [])
    .map((v) => `<option value="${esc(v.id)}" ${v.id === state.tts.voice ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  $('ttsText').value = state.tts.text;
  $('ttsRate').value = String(state.tts.rate);
  $('ttsRateValue').textContent = `${state.tts.rate.toFixed(2)}×`;
  $('ttsPlayerSelection').textContent = provider && ttsVoice() ? `${provider.label} · ${ttsVoice().label}` : 'Select a provider and voice';
  $('ttsPlayerTitle').textContent = ttsVoice()?.label || 'Voice sample';
  $('ttsPlay').disabled = !provider || provider.available === false;
  buildWaveform();
}

function buildWaveform() {
  const bars = state.tts.bars.length ? state.tts.bars : envelopeBars(state.tts.voice || 'voice');
  state.tts.bars = bars;
  $('ttsWaveBars').innerHTML = bars.map((peak) => `<i style="--peak:${peak.toFixed(3)}"></i>`).join('');
}

// Deterministic 48-bar speech envelope. Used until real peaks are decoded.
function envelopeBars(seed) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bars = [];
  for (let i = 0; i < 48; i += 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
    const noise = ((hash >>> 8) & 0xff) / 255;
    const shape = 0.42 + 0.58 * Math.sin((i / 47) * Math.PI);
    bars.push(Math.max(0.12, Math.min(1, 0.18 + noise * shape)));
  }
  return bars;
}

async function decodePeaks(audioUrl) {
  try {
    const res = await fetch(audioUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(buffer);
    const channel = decoded.getChannelData(0);
    const size = Math.floor(channel.length / 48) || 1;
    const bars = [];
    for (let i = 0; i < 48; i += 1) {
      let peak = 0;
      const start = i * size;
      for (let j = 0; j < size; j += 1) peak = Math.max(peak, Math.abs(channel[start + j] || 0));
      bars.push(Math.max(0.08, Math.min(1, peak * 1.6)));
    }
    ctx.close?.();
    return bars;
  } catch {
    return null;
  }
}

function audioEl() {
  return $('ttsAudio');
}

function setWaveProgress(ratio) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  $('ttsWave').style.setProperty('--waveform-position', clamped.toFixed(4));
  $('ttsWave').setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  const bars = $('ttsWaveBars').children;
  const played = Math.round(clamped * bars.length);
  for (let i = 0; i < bars.length; i += 1) bars[i].classList.toggle('is-played', i < played);
}

function syncPlayerClock() {
  const audio = audioEl();
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  $('ttsTimeCurrent').textContent = fmtClock(current);
  $('ttsTimeRemaining').textContent = fmtClock(Math.max(0, duration - current));
  $('ttsWave').setAttribute('aria-valuemax', String(Math.round(duration)));
  $('ttsWave').setAttribute('aria-valuenow', String(Math.round(current)));
  $('ttsWave').setAttribute('aria-valuetext', `${fmtClock(current)} of ${fmtClock(duration)}`);
  setWaveProgress(duration ? current / duration : 0);
}

function setPlayerState(playerState) {
  const player = $('voicePlayer');
  player.dataset.playing = playerState === 'playing' ? 'true' : 'false';
  player.dataset.paused = playerState === 'playing' ? 'false' : 'true';
  if (playerState !== 'playing') delete player.dataset.playing;
}

async function requestPreview() {
  const provider = ttsProvider();
  const voice = ttsVoice();
  const errorEl = $('ttsPlayerError');
  errorEl.hidden = true;
  if (!provider || !voice) {
    errorEl.hidden = false;
    errorEl.textContent = 'Select a provider and voice first.';
    return;
  }
  const gen = ++state.tts.gen;
  if (state.tts.controller) {
    try {
      state.tts.controller.abort();
    } catch {}
  }
  const controller = new AbortController();
  state.tts.controller = controller;
  $('ttsPlay').disabled = true;
  $('ttsPlayText').textContent = 'Preparing…';
  $('ttsPlayerStatus').textContent = `Preparing sample for ${provider.label} · ${voice.label}…`;
  setPlayerState('loading');
  try {
    const data = await request('/api/intake/preview', {
      method: 'POST',
      body: { provider: provider.id, voice: voice.id },
      timeoutMs: 180000,
    });
    if (gen !== state.tts.gen) return;
    const audio = audioEl();
    audio.src = data.audioUrl;
    audio.playbackRate = state.tts.rate;
    const peaks = await decodePeaks(data.audioUrl);
    if (peaks) {
      state.tts.bars = peaks;
      buildWaveform();
    }
    await audio.play().catch(() => {});
    $('ttsPlayText').textContent = 'Listen sample';
    $('ttsPlayerStatus').textContent = data.cached
      ? `Playing cached sample for ${provider.label} · ${voice.label}.`
      : `Playing new sample for ${provider.label} · ${voice.label}.`;
    $('ttsStop').hidden = false;
  } catch (err) {
    if (gen !== state.tts.gen) return;
    setPlayerState('error');
    errorEl.hidden = false;
    errorEl.textContent = err.message;
    $('ttsPlayerStatus').textContent = 'Preview failed.';
    $('ttsPlayText').textContent = 'Listen sample';
  } finally {
    if (gen === state.tts.gen) {
      state.tts.controller = null;
      $('ttsPlay').disabled = false;
    }
  }
}

function stopPreview() {
  const audio = audioEl();
  state.tts.gen += 1;
  if (state.tts.controller) {
    try {
      state.tts.controller.abort();
    } catch {}
    state.tts.controller = null;
  }
  try {
    audio.pause();
  } catch {}
  $('ttsStop').hidden = true;
  $('ttsPlayText').textContent = 'Listen sample';
  $('ttsPlay').disabled = false;
  setPlayerState('paused');
}

function cycleRate() {
  const index = PLAYBACK_RATES.indexOf(state.tts.rate);
  const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
  state.tts.rate = next;
  audioEl().playbackRate = next;
  $('ttsRateBtn').textContent = `${next.toFixed(1)}×`;
  $('ttsRateBtn').setAttribute('aria-label', `Playback speed ${next.toFixed(1)}×`);
  $('ttsRate').value = String(next);
  $('ttsRateValue').textContent = `${next.toFixed(2)}×`;
}

function seekFromEvent(event) {
  const audio = audioEl();
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const rect = $('ttsWave').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
  syncPlayerClock();
}

async function saveTtsDefaults() {
  const button = $('ttsSaveBtn');
  const provider = ttsProvider();
  const voice = ttsVoice();
  if (!provider || !voice) return;
  button.disabled = true;
  try {
    try {
      await request('/api/studio/tts', {
        method: 'PUT',
        body: { provider: provider.id, voice: voice.id, rate: state.tts.rate, sampleText: state.tts.text },
      });
      toast('Narration defaults saved.');
    } catch (err) {
      if (err.status !== 404 && err.status !== 501) throw err;
      localStorage.setItem(
        TTS_STORAGE_KEY,
        JSON.stringify({ provider: provider.id, voice: voice.id, rate: state.tts.rate, text: state.tts.text }),
      );
      toast('Saved for this browser. Server-side TTS defaults are not available yet.');
    }
  } catch (err) {
    $('ttsError').hidden = false;
    $('ttsError').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

document.querySelectorAll('[data-studio-tab]').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.studioTab));
});

$('providerFilters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  $('providerFilters').querySelectorAll('[data-filter]').forEach((el) => {
    const on = el.dataset.filter === state.filter;
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', String(on));
  });
  renderProviders();
});

$('providerGrid').addEventListener('click', (event) => {
  const newCap = event.target.closest('[data-new-cap]');
  if (newCap) {
    const on = newCap.getAttribute('aria-pressed') === 'true';
    newCap.setAttribute('aria-pressed', String(!on));
    newCap.classList.toggle('on', !on);
    return;
  }
  const cap = event.target.closest('[data-provider-cap]');
  if (cap) {
    toggleCapability(cap.dataset.providerId, cap.dataset.modelId, cap.dataset.providerCap);
    return;
  }
  const action = event.target.closest('[data-provider-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.providerAction === 'test') testProvider(id);
  else if (action.dataset.providerAction === 'discover') discoverModels(id);
  else if (action.dataset.providerAction === 'edit') openProviderDialog(id);
  else if (action.dataset.providerAction === 'add-model') addModel(id);
  else if (action.dataset.providerAction === 'delete') handleProviderDelete(id);
});

$('addProviderBtn').addEventListener('click', () => openProviderDialog());
$('providerDialogClose').addEventListener('click', () => $('providerDialog').close());
$('providerCancel').addEventListener('click', () => $('providerDialog').close());
$('providerForm').addEventListener('submit', submitProvider);

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    setMode(button.dataset.mode);
    if (button.dataset.mode !== 'api') return;
    fillPresetOptions('cloud-api');
    if (!$('pvPreset').value) applyPreset('openrouter');
  });
});

$('pvPreset').addEventListener('change', () => applyPreset($('pvPreset').value));
$('oauthFlow').addEventListener('change', syncOAuthFlow);

document.querySelectorAll('[data-toggle-pass]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.togglePass);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-label', show ? 'Hide secret' : 'Show secret');
  });
});

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = $(button.dataset.copyTarget);
    const value = target?.value || target?.textContent || '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value.trim());
      toast('Copied to the clipboard.');
    } catch {
      toast('Could not copy. Select the text and copy it manually.');
    }
  });
});

$('pkceStartBtn').addEventListener('click', startPkce);
$('pkceExchangeBtn').addEventListener('click', exchangePkce);
$('pkceOpenBtn').addEventListener('click', () => {
  const url = $('pkceLink').value.trim();
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
});
$('deviceStartBtn').addEventListener('click', startDevice);
$('deviceOpenBtn').addEventListener('click', () => {
  const url = $('deviceOpenBtn').dataset.href;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
});
$('pvRevokeKey').addEventListener('click', async () => {
  const id = $('pvId').value.trim();
  if (!id) return;
  try {
    await request(`/api/studio/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { revokeSecret: true, expectedRevision: state.providersRevision },
    });
    $('pvKeyChip').hidden = true;
    $('pvRevokeKey').hidden = true;
    $('pvApiKey').value = '';
    toast('Stored key revoked.');
    await loadProviders();
  } catch (err) {
    $('providerFormError').hidden = false;
    $('providerFormError').textContent = err.message;
  }
});

$('gwImportBtn').addEventListener('click', async () => {
  const id = $('pvId').value.trim();
  if (!id) {
    $('providerFormError').hidden = false;
    $('providerFormError').textContent = 'Save the gateway provider first, then import its models.';
    return;
  }
  try {
    const data = await request(`/api/studio/providers/${encodeURIComponent(id)}/models/discover`, { method: 'POST', body: {} });
    toast(`Imported ${Array.isArray(data?.models) ? data.models.length : 0} models.`);
    await loadProviders();
  } catch (err) {
    $('providerFormError').hidden = false;
    $('providerFormError').textContent = err.message;
  }
});

// Vertex dropzone
['dragenter', 'dragover'].forEach((type) => {
  $('vertexDrop').addEventListener(type, (event) => {
    event.preventDefault();
    $('vertexDrop').classList.add('dragover');
  });
});
['dragleave', 'dragend'].forEach((type) => {
  $('vertexDrop').addEventListener(type, () => $('vertexDrop').classList.remove('dragover'));
});
$('vertexDrop').addEventListener('drop', (event) => {
  event.preventDefault();
  $('vertexDrop').classList.remove('dragover');
  readVertexFile(event.dataTransfer?.files?.[0]);
});
$('vertexFile').addEventListener('change', () => readVertexFile($('vertexFile').files?.[0]));

// Local presets
document.querySelectorAll('[data-local-url]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-local-url]').forEach((el) => el.classList.toggle('on', el === button));
    $('localBaseUrl').value = button.dataset.localUrl;
    if (!$('pvLabel').value.trim()) $('pvLabel').value = `${button.dataset.localLabel} (local)`;
    if (!$('pvId').value.trim()) $('pvId').value = `${button.dataset.localLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-local`;
  });
});

/* ---- stage board interactions ---- */

$('stageBoard').addEventListener('click', (event) => {
  const move = event.target.closest('[data-stage-move]');
  if (move) {
    moveStageModel(move.dataset.stage, move.dataset.modelLane, move.dataset.stageMove);
    return;
  }
  const remove = event.target.closest('[data-stage-remove]');
  if (remove) {
    const stage = state.stagesDraft?.[remove.dataset.stage];
    if (!stage) return;
    stage.chain = stage.chain.filter((lane) => lane !== remove.dataset.modelLane);
    state.focusKey = `${remove.dataset.stage}||picker`;
    markStagesDirty();
    renderStages();
    return;
  }
  const step = event.target.closest('[data-stage-step]');
  if (step) {
    const stage = state.stagesDraft?.[step.dataset.stage];
    if (!stage) return;
    stage.concurrency = Math.min(8, Math.max(1, stage.concurrency + Number(step.dataset.stepDelta || step.dataset.stageStep)));
    state.focusKey = `${step.dataset.stage}||step:${step.dataset.stageStep}`;
    markStagesDirty();
    renderStages();
    return;
  }
  const customize = event.target.closest('[data-action="customize-stage"]');
  if (customize) {
    const stage = state.stagesDraft?.[customize.dataset.stage];
    if (!stage) return;
    stage.inheritFrom = null;
    stage.chain = [...(state.stagesDraft.reader.chain || [])];
    state.focusKey = `${customize.dataset.stage}||inherit`;
    markStagesDirty();
    renderStages();
    return;
  }
  if (event.target.closest('[data-action="open-voices"]')) {
    setTab('voices');
    return;
  }
  const add = event.target.closest('[data-stage-add]');
  if (add) {
    const stage = state.stagesDraft?.[add.dataset.stageAdd];
    const picker = $(`stageAdd-${add.dataset.stageAdd}`);
    const lane = picker?.value;
    if (!stage || !lane) {
      picker?.focus();
      return;
    }
    if (stage.chain.includes(lane)) {
      stageNotice(`${lane} is already in the ${add.dataset.stageAdd} chain.`, 'warning');
      return;
    }
    stage.chain.push(lane);
    state.focusKey = `${add.dataset.stageAdd}||picker`;
    markStagesDirty();
    renderStages();
  }
});

$('stageBoard').addEventListener('change', (event) => {
  const inherit = event.target.closest('[data-stage-inherit]');
  if (inherit) {
    const stage = state.stagesDraft?.[inherit.dataset.stageInherit];
    if (!stage) return;
    stage.inheritFrom = inherit.checked ? inherit.dataset.inheritFrom : null;
    if (inherit.checked) stage.chain = [...(state.stagesDraft.reader.chain || [])];
    state.focusKey = `${inherit.dataset.stageInherit}||inherit`;
    markStagesDirty();
    renderStages();
    return;
  }
  const temp = event.target.closest('[data-stage-temp]');
  if (temp) {
    const stage = state.stagesDraft?.[temp.dataset.stage];
    if (!stage) return;
    stage.temperature = Math.min(2, Math.max(0, Number(temp.value) || 0));
    markStagesDirty();
    return;
  }
  const verify = event.target.closest('[data-stage-verify]');
  if (verify) {
    const stage = state.stagesDraft?.[verify.dataset.stage];
    if (!stage) return;
    stage.llmVerify = verify.checked;
    markStagesDirty();
    return;
  }
  const concurrency = event.target.closest('[data-stage-concurrency]');
  if (concurrency) {
    const stage = state.stagesDraft?.[concurrency.dataset.stage];
    if (!stage) return;
    stage.concurrency = Math.min(8, Math.max(1, Number(concurrency.value) || 1));
    markStagesDirty();
  }
});

$('stageBoard').addEventListener('keydown', (event) => {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const row = event.target.closest('[data-stage][data-model-lane]');
  if (!row) return;
  event.preventDefault();
  moveStageModel(row.dataset.stage, row.dataset.modelLane, event.key === 'ArrowUp' ? 'up' : 'down');
});

let dragStage = null;
$('stageBoard').addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-stage][data-model-lane]');
  if (!row) return;
  dragStage = { stage: row.dataset.stage, lane: row.dataset.modelLane };
  row.classList.add('dragging');
  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.modelLane);
  } catch {}
});
$('stageBoard').addEventListener('dragend', () => {
  dragStage = null;
  $('stageBoard').querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
});
$('stageBoard').addEventListener('dragover', (event) => {
  const row = event.target.closest('[data-stage][data-model-lane]');
  if (!row || !dragStage || row.dataset.stage !== dragStage.stage) return;
  event.preventDefault();
  $('stageBoard').querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  row.classList.add('drop-target');
});
$('stageBoard').addEventListener('drop', (event) => {
  const row = event.target.closest('[data-stage][data-model-lane]');
  if (!row || !dragStage || row.dataset.stage !== dragStage.stage) return;
  event.preventDefault();
  const stage = state.stagesDraft?.[dragStage.stage];
  if (!stage) return;
  const from = stage.chain.indexOf(dragStage.lane);
  const to = stage.chain.indexOf(row.dataset.modelLane);
  if (from < 0 || to < 0 || from === to) return;
  stage.chain.splice(from, 1);
  stage.chain.splice(to, 0, dragStage.lane);
  state.focusKey = `${dragStage.stage}|${dragStage.lane}|move:up`;
  markStagesDirty();
  renderStages();
});

$('stageSaveBtn').addEventListener('click', saveStages);
$('stageKeepDraft').addEventListener('click', () => {
  $('stageConflict').hidden = true;
  stageNotice('Keeping your draft. Reload when you are ready to merge.');
});
$('stageReloadServer').addEventListener('click', async () => {
  await loadStages();
  $('stageConflict').hidden = true;
  stageNotice('Server settings reloaded.');
});
$('stageInheritPreset').addEventListener('click', () => {
  if (!state.stagesDraft) return;
  for (const id of ['matcher', 'scout']) {
    state.stagesDraft[id].inheritFrom = 'reader';
    state.stagesDraft[id].chain = [...(state.stagesDraft.reader.chain || [])];
  }
  markStagesDirty();
  renderStages();
  stageNotice('matcher and scout now inherit the reader chain.');
});
$('stageResetBtn').addEventListener('click', async () => {
  try {
    const data = await request('/api/studio/stages');
    state.stagesDraft = normalizeStages(data);
    state.stagesBaseRevision = Number(data?.revision) || 0;
    state.stagesDirty = false;
    renderStages();
    stageNotice('Reverted to the saved routing.');
  } catch (err) {
    stageNotice(err.message, 'error');
  }
});

/* ---- node wiring ---- */

$('addSbxBtn').addEventListener('click', () => openSbxDialog());
$('addSshBtn').addEventListener('click', () => openSshDialog());
$('sbxDialogClose').addEventListener('click', () => $('sbxDialog').close());
$('sbxCancel').addEventListener('click', () => $('sbxDialog').close());
$('sshDialogClose').addEventListener('click', () => $('sshDialog').close());
$('sshCancel').addEventListener('click', () => $('sshDialog').close());
$('sbxForm').addEventListener('submit', submitSbx);
$('sshForm').addEventListener('submit', submitSsh);
$('sshProbeBtn').addEventListener('click', probeSshFromDialog);
$('sbxIdlePause').addEventListener('input', () => {
  $('sbxIdlePauseValue').textContent = `${$('sbxIdlePause').value}s`;
});

document.querySelectorAll('[data-sbx-action]').forEach((button) => {
  button.addEventListener('click', () => sbxDialogAction(button.dataset.sbxAction));
});

$('nodeGrid').addEventListener('click', (event) => {
  const action = event.target.closest('[data-node-action]');
  if (!action) return;
  const id = action.dataset.id;
  const node = state.nodes.find((n) => n.id === id);
  if (action.dataset.nodeAction === 'edit') {
    if (String(node?.kind) === 'ssh') openSshDialog(id);
    else if (String(node?.kind) === 'docker-sbx') openSbxDialog(id);
    else nodeNotice('The local node is built in and needs no configuration.');
    return;
  }
  runNodeAction(id, action.dataset.nodeAction);
});

document.querySelectorAll('[data-step-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.stepTarget);
    const next = Math.min(Number(input.max) || 99, Math.max(Number(input.min) || 1, Number(input.value) + Number(button.dataset.stepDelta)));
    input.value = String(next);
    if (input.id === 'sbxIdlePause') $('sbxIdlePauseValue').textContent = `${next}s`;
  });
});

/* ---- TTS wiring ---- */

$('ttsProvider').addEventListener('change', () => {
  state.tts.provider = $('ttsProvider').value;
  const provider = ttsProvider();
  state.tts.voice = provider?.voices?.find((v) => v.default)?.id || provider?.voices?.[0]?.id || '';
  state.tts.bars = [];
  stopPreview();
  renderTtsForm();
});
$('ttsVoice').addEventListener('change', () => {
  state.tts.voice = $('ttsVoice').value;
  state.tts.bars = [];
  stopPreview();
  renderTtsForm();
});
$('ttsText').addEventListener('input', () => {
  state.tts.text = $('ttsText').value;
});
$('ttsRate').addEventListener('input', () => {
  state.tts.rate = Math.min(1.25, Math.max(0.9, Number($('ttsRate').value) || 1));
  $('ttsRateValue').textContent = `${state.tts.rate.toFixed(2)}×`;
  audioEl().playbackRate = state.tts.rate;
});
$('ttsPlay').addEventListener('click', requestPreview);
$('ttsStop').addEventListener('click', stopPreview);
$('ttsRateBtn').addEventListener('click', cycleRate);
$('ttsSaveBtn').addEventListener('click', saveTtsDefaults);

$('ttsWave').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  seekFromEvent(event);
  const move = (moveEvent) => seekFromEvent(moveEvent);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

$('ttsWave').addEventListener('keydown', (event) => {
  const audio = audioEl();
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 5 : -5;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
    syncPlayerClock();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    audio.currentTime = event.key === 'Home' ? 0 : audio.duration;
    syncPlayerClock();
  } else if (event.key === ' ' || event.key === 'k') {
    event.preventDefault();
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
});

const ttsAudio = audioEl();
['timeupdate', 'loadedmetadata', 'seeked'].forEach((type) => ttsAudio.addEventListener(type, syncPlayerClock));
ttsAudio.addEventListener('play', () => {
  setPlayerState('playing');
  $('ttsStop').hidden = false;
  const tick = () => {
    if (ttsAudio.paused) return;
    syncPlayerClock();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
ttsAudio.addEventListener('pause', () => {
  setPlayerState('paused');
  $('ttsStop').hidden = true;
  syncPlayerClock();
});
ttsAudio.addEventListener('ended', () => {
  setPlayerState('ended');
  $('ttsStop').hidden = true;
  syncPlayerClock();
});
ttsAudio.addEventListener('error', () => {
  if (!ttsAudio.src) return;
  setPlayerState('error');
  $('ttsPlayerError').hidden = false;
  $('ttsPlayerError').textContent = 'The sample could not be played.';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPreview();
});
window.addEventListener('pagehide', stopPreview);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function refreshAll() {
  $('studioRefresh').disabled = true;
  setConnection('Refreshing', '');
  try {
    await Promise.all([loadProviders(), loadStages(), loadNodes()]);
    setConnection('Live', 'live');
    showNotice('');
    $('studioRevisionPill').textContent = `providers r${state.providersRevision} · stages r${state.stagesBaseRevision}`;
  } catch (err) {
    setConnection('Offline', 'stale');
    showNotice(err.message);
  } finally {
    $('studioRefresh').disabled = false;
    $('studioUpdatedAt').textContent = `Updated ${new Date().toLocaleTimeString()} · admin settings`;
  }
}

$('studioRefresh').addEventListener('click', refreshAll);

(async function init() {
  setTab('providers');
  try {
    const session = await request('/api/intake/catalog', { timeoutMs: 20000 }).catch(() => null);
    if (session?.csrfToken) state.csrf = session.csrfToken;
    if (session) state.tts.catalog = session;
  } catch {}
  await refreshAll();
  buildWaveform();
})();
