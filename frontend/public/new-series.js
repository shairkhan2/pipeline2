// Screening Room — "Create a series" intake UI.
// Talks to the existing intake API only:
//   GET  /api/intake/catalog        -> providers/voices/presets + csrfToken (privileged)
//   GET  /api/intake/jobs           -> persistent queue + log tails
//   POST /api/intake/preview        -> {id,duration,cached,audioUrl} (provider+voice only)
//   GET  <audioUrl>                 -> authenticated audio/mpeg
//   POST /api/intake/jobs           -> enqueue (gdrive JSON or zip upload)
//   POST /api/intake/jobs/:id/retry -> re-queue failed/interrupted job ({job})
//   POST /api/intake/jobs/:id/continue -> continue series with {chapters} ({job})
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let catalog = null;
let csrfToken = '';
let privileged = true;
let sourceMode = 'gdrive';
let slugTouched = false;
let submitting = false;
let pollTimer = null;
let activeLaunchId = '';
let studioStep = 0;
let queueError = '';
// Per-job action bookkeeping: in-flight action key, and jobs whose server
// refused an action because the endpoint does not exist yet.
const jobActionBusy = new Set();
const jobActionUnsupported = new Set();
// Last jobs payload, so an action result can be merged without waiting for a poll.
let lastJobs = [];

// The launch panel is anchored to a job id so a reload keeps showing the same run.
const ACTIVE_JOB_KEY = 'screeningroom.intake.activeJob';
const STAGE_ORDER = ['download', 'extract', 'pipeline'];
const studioSteps = ['storyStep', 'voiceStep', 'productionStep'];
const BG_LABELS = { 'starfield': 'Starfield', 'storm-valley': 'Storm Valley', 'mist-pines': 'Mist Pines' };
const MOTION_LABELS = { 'cut': 'Cut', 'duo': 'Duo' };
const DEFAULT_RENDER_LANE = 'inherit';
const FALLBACK_RENDER_LANES = [
  { id: 'inherit', label: 'Auto', available: true, unavailableReason: null },
];
const RENDER_LANE_LABELS = {
  inherit: 'Auto',
  local: 'Local',
  laptop: 'Laptop',
  cloud: 'Cloud',
};

function normalizeRenderLaneValue(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  // Custom nodes (docker-sbx, ssh) are registered server-side; keep any valid id.
  return /^[a-z0-9][a-z0-9._-]*$/.test(val) ? val : DEFAULT_RENDER_LANE;
}

function effectiveRenderLanes() {
  const raw = catalog?.renderLanes;
  if (!Array.isArray(raw) || !raw.length) return FALLBACK_RENDER_LANES;
  const valid = raw
    .filter((item) => item && typeof item === 'object' && /^[a-z0-9][a-z0-9._-]*$/.test(String(item.id || '').trim().toLowerCase()))
    .map((item) => {
      const id = String(item.id).trim().toLowerCase();
      return {
        id,
        label: RENDER_LANE_LABELS[id] || String(item.label || id).trim(),
        available: id === DEFAULT_RENDER_LANE ? true : item.available !== false,
        unavailableReason:
          id === DEFAULT_RENDER_LANE
            ? null
            : item.unavailableReason
              ? String(item.unavailableReason).trim()
              : null,
      };
    });
  if (!valid.length) return FALLBACK_RENDER_LANES;
  if (!valid.some((item) => item.id === DEFAULT_RENDER_LANE)) {
    valid.unshift(FALLBACK_RENDER_LANES[0]);
  }
  return valid;
}

function renderLaneById(id) {
  const norm = String(id ?? '').trim().toLowerCase();
  return effectiveRenderLanes().find((item) => item.id === norm) || null;
}

function currentRenderLane() {
  const sel = $('renderLane');
  const raw = sel ? sel.value : DEFAULT_RENDER_LANE;
  return renderLaneById(raw) || effectiveRenderLanes()[0];
}

function formatJobRenderLane(rawLane) {
  const id = normalizeRenderLaneValue(rawLane);
  const opt = renderLaneById(id);
  const label = opt?.label || RENDER_LANE_LABELS[id] || id;
  if (id === DEFAULT_RENDER_LANE) {
    return label;
  }
  return `${label} only`;
}

function renderRenderLaneNote() {
  const noteEl = $('renderLaneNote');
  const opts = effectiveRenderLanes();
  const chosen = currentRenderLane();
  if (noteEl) {
    if (chosen && chosen.id !== DEFAULT_RENDER_LANE) {
      noteEl.textContent = chosen.available
        ? `${chosen.label} only · no fallback · waits if offline`
        : `${chosen.label} unavailable: ${chosen.unavailableReason || 'not available'}`;
    } else {
      noteEl.textContent = 'Follows global policy · waits if offline';
    }
  }
  const unavail = opts.filter((o) => !o.available && o.id !== chosen?.id);
  const detailsEl = $('renderLaneDetails');
  const summaryEl = $('renderLaneDetailsSummary');
  const listEl = $('renderLaneAvailability');
  if (detailsEl && summaryEl && listEl) {
    if (!unavail.length) {
      detailsEl.hidden = true;
      detailsEl.open = false;
      listEl.innerHTML = '';
    } else {
      detailsEl.hidden = false;
      summaryEl.textContent = `Unavailable: ${unavail.map((u) => u.label).join(', ')}`;
      listEl.innerHTML = unavail
        .map((u) => `<li><strong>${esc(u.label)}</strong> — ${esc(u.unavailableReason || 'unavailable')}</li>`)
        .join('');
    }
  }
}

function parseDriveId(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com'].includes(host)) return '';
    if (/\/(?:folders|document|spreadsheets|presentation|forms)(?:\/|$)/i.test(parsed.pathname)) return '';
    const trimmed = parsed.pathname.replace(/\/+$/, '');
    const queryId = ['/open', '/uc', '/download'].includes(trimmed) ? parsed.searchParams.get('id') : '';
    return parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || queryId || '';
  } catch { return ''; }
}

function cleanVoiceName(label) {
  return String(label || '').replace(/\s*\([^)]*\)/g, '').trim() || String(label || '');
}

function validateStory() {
  const title = $('seriesTitle').value.trim();
  const file = $('zipFile').files?.[0];
  const url = $('gdriveUrl').value.trim();
  setFieldError('title', title ? '' : 'Enter a series title to continue.');
  let sourceError = '';
  if (sourceMode === 'gdrive') {
    if (!parseDriveId(url)) {
      sourceError = url ? 'Use a public Google Drive file link, not a folder link.' : 'Paste a public Google Drive ZIP file link.';
    }
  } else if (!file || !/\.zip$/i.test(file.name)) {
    sourceError = 'Choose a .zip archive to continue.';
  } else if (file.size > (catalog?.limits?.maxZipBytes || 1536 * 1024 * 1024)) {
    sourceError = 'This archive exceeds the upload size limit.';
  }
  setFieldError(sourceMode === 'gdrive' ? 'gdrive' : 'file', sourceError);
  if (!title || sourceError) {
    showStep(0, false);
    (!title ? $('seriesTitle') : sourceMode === 'gdrive' ? $('gdriveUrl') : $('zipFile')).focus();
    return false;
  }
  return true;
}

function showStep(index, focus = true) {
  studioStep = index;
  studioSteps.forEach((id, i) => { $(id).hidden = i !== index; });
  document.querySelectorAll('[data-step]').forEach((button) => {
    const step = Number(button.dataset.step);
    if (step === index) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.classList.toggle('complete', step < index);
  });
  if ($('studioHud')) $('studioHud').hidden = index === 2;
  const navBar = document.querySelector('.studio-navigation');
  const formActions = document.querySelector('.form-actions');
  if (navBar && formActions && $('submitBtn')) {
    (index === 2 ? navBar : formActions).appendChild($('submitBtn'));
  }
  $('stepBack').hidden = index === 0;
  $('stepNext').hidden = index === 2;
  $('stepNext').innerHTML = `${index === 0 ? 'Next: Voice &amp; style' : 'Next: Launch'} <svg class="icon"><use href="#i-arrow"/></svg>`;
  $('stepHint').textContent = ['01 / 03', '02 / 03', '03 / 03'][index];
  if (index !== 1) resetPreview();
  if (focus) {
    $(['sourceHeading', 'narrationHeading', 'productionHeading'][index]).focus({ preventScroll: true });
    $('creationStudio').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function goToStep(index) {
  if (submitting) return;
  if (index > 0 && !validateStory()) return;
  if (index > 1 && (!currentProvider()?.available || !currentVoice())) {
    showStep(1);
    setFieldError('voice', 'Choose an available narrator before continuing.');
    return;
  }
  showAlert('');
  showStep(index);
}

function renderVoiceCards() {
  const provider = currentProvider();
  const focusedVoice = document.activeElement?.closest('[data-voice]')?.dataset.voice;
  $('voiceCards').innerHTML = (provider?.voices || []).map((voice) =>
    `<button type="button" class="voice-choice" data-voice="${esc(voice.id)}" aria-pressed="${voice.id === $('ttsVoice').value}" ${!provider.available ? 'disabled' : ''}><span class="voice-avatar">${esc(cleanVoiceName(voice.label).slice(0, 1))}</span><span><strong>${esc(cleanVoiceName(voice.label))}</strong>${voice.default ? '<small>Default</small>' : ''}</span><span class="voice-check" aria-hidden="true">✓</span></button>`
  ).join('');
  if (focusedVoice) [...$('voiceCards').querySelectorAll('[data-voice]')].find(button => button.dataset.voice === focusedVoice)?.focus({ preventScroll: true });
}

// Voice preview state. Every request carries a generation token so a late reply
// from an abandoned provider/voice selection can never reach the audio element.
let previewGen = 0;
let previewController = null;
let previewPreparing = false;
let previewPlaying = false;

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\.(zip|cbz)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/g, '');
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function fmtAge(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - Number(ts)));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function showAlert(msg, kind = 'error') {
  const el = $('formAlert');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'intake-alert';
    return;
  }
  el.hidden = false;
  el.className = 'intake-alert' + (kind === 'success' ? ' success' : '');
  el.textContent = msg;
}

/* ---------- inline field errors ---------- */

const FIELD_ERRORS = {
  title: 'titleError',
  slug: 'slugError',
  gdrive: 'gdriveError',
  file: 'fileError',
  voice: 'voiceError',
  renderLane: 'renderLaneError',
};

// The control each error belongs to, so aria-invalid always matches the message.
const FIELD_CONTROLS = {
  title: 'seriesTitle',
  slug: 'seriesSlug',
  gdrive: 'gdriveUrl',
  file: 'zipFile',
  voice: 'ttsVoice',
  renderLane: 'renderLane',
};

function setFieldError(field, msg) {
  const el = $(FIELD_ERRORS[field]);
  const control = FIELD_CONTROLS[field] ? $(FIELD_CONTROLS[field]) : null;
  if (control) {
    if (msg) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function clearFieldErrors() {
  Object.keys(FIELD_ERRORS).forEach((f) => setFieldError(f, ''));
}

/* ---------- source mode ---------- */

function setMode(mode) {
  sourceMode = mode === 'upload' ? 'upload' : 'gdrive';
  const isGdrive = sourceMode === 'gdrive';
  $('tabGdrive').classList.toggle('on', isGdrive);
  $('tabGdrive').setAttribute('aria-selected', String(isGdrive));
  $('tabUpload').classList.toggle('on', !isGdrive);
  $('tabUpload').setAttribute('aria-selected', String(!isGdrive));
  $('paneGdrive').hidden = !isGdrive;
  $('paneUpload').hidden = isGdrive;
  setFieldError('gdrive', '');
  setFieldError('file', '');
  showAlert('');
  updateSummary();
}

/* ---------- catalog ---------- */

function providerById(id) {
  if (!catalog || !Array.isArray(catalog.providers)) return null;
  return catalog.providers.find((p) => p.id === id) || null;
}

function currentProvider() {
  return providerById($('ttsProvider').value) || (catalog?.providers || [])[0] || null;
}

function currentVoice() {
  const prov = currentProvider();
  if (!prov) return null;
  return (prov.voices || []).find((v) => v.id === $('ttsVoice').value) || (prov.voices || [])[0] || null;
}

function providerVoiceLabel() {
  const prov = currentProvider();
  const voice = currentVoice();
  if (!prov || !voice) return 'Not set';
  return `${prov.label} · ${voice.label}`;
}

function populateVoices() {
  const prov = currentProvider();
  if (!prov) return;
  const voices = prov.voices || [];
  $('ttsVoice').innerHTML = voices
    .map((v) => `<option value="${esc(v.id)}" ${v.default ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  renderNarrationNotices();
  updateSummary();
  resetPreview('Selection changed — listen again for this voice.');
}

function renderNarrationNotices() {
  const prov = currentProvider();
  $('ttsNotice').textContent = prov?.costNotice || '';

  const unavailable = (catalog?.providers || []).filter((p) => !p.available && p.unavailableReason);
  const list = $('voiceAvailability');
  if (!unavailable.length) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  list.hidden = false;
  list.innerHTML = unavailable
    .map((p) => `<li><strong>${esc(p.label)}</strong> — ${esc(p.unavailableReason)}</li>`)
    .join('');

  // An unavailable provider can never be selected or previewed.
  const disabled = Boolean(prov && !prov.available);
  $('previewListen').disabled = disabled || !privileged;
  if (disabled) {
    $('previewStatus').textContent = 'Preview unavailable for this provider.';
  }
}

function renderCatalog() {
  if (!catalog) return;
  if (catalog.spendingNotice) {
    $('spendingNoticeText').textContent = catalog.spendingNotice;
  }
  if (Array.isArray(catalog.backgrounds) && catalog.backgrounds.length) {
    $('bgPreset').innerHTML = catalog.backgrounds
      .map((b) => `<option value="${esc(b)}" ${b === catalog.defaultBackground ? 'selected' : ''}>${esc(b)}${b === catalog.defaultBackground ? ' (Default)' : ''}</option>`)
      .join('');
  }
  if (Array.isArray(catalog.motions) && catalog.motions.length) {
    $('motionPreset').innerHTML = catalog.motions
      .map((m) => `<option value="${esc(m)}" ${m === catalog.defaultMotion ? 'selected' : ''}>${esc(m)}${m === catalog.defaultMotion ? ' (Default)' : ''}</option>`)
      .join('');
  }

  const renderOpts = effectiveRenderLanes();
  const prevLane = $('renderLane')?.value || DEFAULT_RENDER_LANE;
  const defaultLane = normalizeRenderLaneValue(catalog?.capabilities?.renderLane?.default || DEFAULT_RENDER_LANE);
  if ($('renderLane')) {
    $('renderLane').innerHTML = renderOpts
      .map((opt) => {
        const isDefault = opt.id === defaultLane;
        const suffix = !opt.available
          ? ' (Unavailable)'
          : isDefault
            ? ' (Default)'
            : '';
        return `<option value="${esc(opt.id)}" ${isDefault ? 'selected' : ''} ${!opt.available ? 'disabled' : ''}>${esc(opt.label)}${esc(suffix)}</option>`;
      })
      .join('');
    const keepPrev = renderOpts.find((o) => o.id === prevLane && o.available);
    $('renderLane').value = keepPrev ? keepPrev.id : defaultLane;
    $('renderLane').disabled = !privileged || submitting;
  }

  const provs = catalog.providers || [];
  $('ttsProvider').innerHTML = provs
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === catalog.defaultProvider ? 'selected' : ''} ${!p.available ? 'disabled' : ''}>${esc(p.label)}${!p.available ? ' (Unavailable)' : ''}</option>`,
    )
    .join('');

  // If the server default is disabled, fall back to the first usable provider.
  if (!$('ttsProvider').value || currentProvider()?.available === false) {
    const usable = provs.find((p) => p.available) || provs[0];
    if (usable) $('ttsProvider').value = usable.id;
  }

  populateVoices();

  if (!privileged) {
    $('privilegeNotice').hidden = false;
    $('privilegeNotice').textContent =
      'Signed in with a temporary viewing account. Temporary accounts can watch the library and view status, but cannot preview voices or start paid pipeline jobs.';
    $('submitBtn').disabled = true;
    $('previewListen').disabled = true;
    if ($('renderLane')) $('renderLane').disabled = true;
    $('previewStatus').textContent = 'Temporary accounts cannot generate previews.';
  } else {
    $('privilegeNotice').hidden = true;
    if (!submitting) {
      $('submitBtn').disabled = false;
      if ($('renderLane')) $('renderLane').disabled = false;
    }
    renderNarrationNotices();
  }
  updateSummary();
}

/* ---------- section 3 summary ---------- */

function updateSummary() {
  const title = $('seriesTitle').value.trim();
  const bg = $('bgPreset').value || 'starfield';
  const motion = $('motionPreset').value || 'cut';
  const driveId = parseDriveId($('gdriveUrl').value);
  $('driveLinkCard').hidden = sourceMode !== 'gdrive' || !driveId;
  if (driveId) $('driveFileMeta').textContent = `File ${driveId.slice(0, 10)}… · Ready to download`;
  $('summaryTitle').textContent = title || 'Not set';
  $('summaryVoice').textContent = providerVoiceLabel();
  $('summaryChapters').textContent = ($('chaptersSpec').value.trim() || 'all');
  $('conceptTitle').textContent = title || 'Untitled series';
  const concept = document.querySelector('.series-concept');
  concept.classList.toggle('has-title', Boolean(title));
  concept.dataset.bg = bg;
  concept.dataset.motion = motion;
  $('previewBadge').textContent = `${BG_LABELS[bg] || bg} · ${MOTION_LABELS[motion] || motion}`;
  const source = sourceMode === 'upload' ? ($('zipFile').files?.[0]?.name || 'No ZIP selected') : (driveId ? 'Google Drive ZIP' : 'Waiting for link');
  $('summarySource').textContent = `${source} · ${BG_LABELS[bg] || bg} · ${MOTION_LABELS[motion] || motion}`;
  const chosenLane = currentRenderLane();
  if ($('summaryRenderLane')) {
    $('summaryRenderLane').textContent = formatJobRenderLane(chosenLane?.id);
  }
  renderRenderLaneNote();
  $('briefSource').textContent = source;
  $('briefVoice').textContent = cleanVoiceName(currentVoice()?.label) || 'Select a voice';
  $('briefChapters').textContent = $('chaptersSpec').value.trim() === 'all' ? 'All chapters' : ($('chaptersSpec').value.trim() || 'All chapters');
  document.querySelectorAll('[data-chapters]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.chapters === $('chaptersSpec').value.trim())));
  document.querySelectorAll('[data-bg]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.bg === bg)));
  document.querySelectorAll('[data-motion]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.motion === motion)));
  renderVoiceCards();
}

/* ---------- launch panel (no auto-redirect: the user stays on this page) ---------- */

function transferStageFor(jobOrStatus) {
  const job = jobOrStatus && typeof jobOrStatus === 'object' ? jobOrStatus : null;
  const status = String(job ? job.status : jobOrStatus || 'queued').toLowerCase();
  const phase = String(job?.progress?.phase || job?.stage || '').toLowerCase();
  if (STAGE_ORDER.includes(phase)) return phase;
  if (status === 'failed') {
    if (Array.isArray(job?.ingestedChapters) && job.ingestedChapters.length) return 'pipeline';
    if (job?.sourceType === 'upload') return 'extract';
    return 'download';
  }
  return (
    {
      queued: 'download',
      downloading: 'download',
      ingesting: 'extract',
      running: 'pipeline',
      completed: 'pipeline',
      interrupted: 'pipeline',
    }[status] || 'download'
  );
}

// The backend reports download progress inside job.progress ({loadedBytes, totalBytes})
// or inside statusNote ("Downloading ZIP (12.3 MB)…"). Prefer structured progress
// when present; never fabricate a total or percentage when totalBytes is unknown.
function downloadProgress(job) {
  const p = job?.progress;
  if (p && typeof p === 'object') {
    const hasLoaded = p.loadedBytes !== null && p.loadedBytes !== undefined && Number.isFinite(Number(p.loadedBytes)) && Number(p.loadedBytes) >= 0;
    const hasTotal = p.totalBytes !== null && p.totalBytes !== undefined && Number.isFinite(Number(p.totalBytes)) && Number(p.totalBytes) > 0;
    if (hasLoaded) {
      return { loaded: Number(p.loadedBytes), total: hasTotal ? Number(p.totalBytes) : null };
    }
  }
  const m = /\(([\d.]+)\s*MB\)/.exec(String(job?.statusNote || ''));
  if (m) return { loaded: Math.round(Number(m[1]) * 1024 * 1024), total: null };
  return null;
}

function pipelineProgress(job) {
  const p = job?.progress;
  if (!p || typeof p !== 'object') return null;
  const idx = p.chapterIndex !== null && p.chapterIndex !== undefined && Number.isFinite(Number(p.chapterIndex)) ? Number(p.chapterIndex) : null;
  const total = p.chapterTotal !== null && p.chapterTotal !== undefined && Number.isFinite(Number(p.chapterTotal)) && Number(p.chapterTotal) > 0 ? Number(p.chapterTotal) : null;
  const rawCompleted = p.completedChapters ?? p.chaptersCompleted;
  const completed =
    rawCompleted !== null &&
    rawCompleted !== undefined &&
    Number.isFinite(Number(rawCompleted)) &&
    Number(rawCompleted) >= 0
      ? Number(rawCompleted)
      : null;
  if (idx === null && total === null && completed === null) return null;
  return {
    chapter: typeof p.chapter === 'string' && p.chapter.trim() ? p.chapter.trim() : null,
    chapterIndex: idx,
    chapterTotal: total,
    completedChapters: completed,
  };
}

function setTrackProgress(track, bar, loaded, total) {
  const known = Number.isFinite(loaded) && loaded >= 0 && Number.isFinite(total) && total > 0;
  track.classList.toggle('is-indeterminate', !known);
  track.setAttribute('aria-busy', 'true');
  bar.style.width = known ? `${Math.min(100, Math.round((loaded / total) * 100))}%` : '';
  return known;
}

function clearTrackProgress(track, bar) {
  track.classList.remove('is-indeterminate');
  track.removeAttribute('aria-busy');
  bar.style.width = '0%';
}

function canJobAction(job, action) {
  if (!privileged || !job || jobActionUnsupported.has(job.id)) return false;
  if (Array.isArray(job.actions)) return job.actions.includes(action);
  const st = String(job.status || '').toLowerCase();
  if (action === 'retry') return st === 'failed' || st === 'interrupted';
  if (action === 'continue') return st === 'completed' || st === 'interrupted' || st === 'failed';
  return false;
}

function renderLaunchActions(job) {
  const retryable = canJobAction(job, 'retry');
  const continuable = canJobAction(job, 'continue');
  const busy = Boolean(job?.id && jobActionBusy.has(job.id));
  const retryBtn = $('retryJob');
  const continueForm = $('continueForm');
  const continueHint = $('continueHint');
  retryBtn.hidden = !retryable;
  continueForm.hidden = !continuable;
  if (continueHint) continueHint.hidden = !continuable;
  retryBtn.disabled = !privileged || busy;
  $('continueJob').disabled = !privileged || !continuable || busy;
  $('continueChapters').disabled = !privileged || busy;
  retryBtn.textContent = busy ? 'Retrying…' : 'Retry job';
  $('continueJob').textContent = busy ? 'Continuing…' : 'Continue run';
  $('viewPipelineLink').href = job?.statusUrl || '/status.html';
}

function renderLaunchPanel(job) {
  const status = String(job.status || 'queued').toLowerCase();
  const title = job.title || job.slug || 'this series';
  const step = transferStageFor(job);
  const cur = STAGE_ORDER.indexOf(step);
  document.querySelectorAll('[data-transfer]').forEach((el) => {
    const idx = STAGE_ORDER.indexOf(el.dataset.transfer);
    el.classList.toggle('on', status !== 'completed' && idx === cur);
    el.classList.toggle('done', status === 'completed' ? true : idx < cur);
  });

  const heading = $('successHeading');
  const detail = $('successDetail');
  const stage = $('transferStage');
  const errorEl = $('launchError');
  errorEl.hidden = true;
  errorEl.textContent = '';
  $('launchSuccess').classList.toggle('is-error', status === 'failed' || status === 'interrupted');
  $('launchSuccess').classList.toggle('is-interrupted', status === 'interrupted');
  $('launchSuccess').classList.toggle('is-done', status === 'completed');

  const progress = downloadProgress(job);
  const pipeProg = pipelineProgress(job);
  const progressWrap = $('launchProgress');
  const track = $('launchProgressTrack');
  const bar = $('launchProgressBar');

  if (status === 'failed') {
    stage.textContent = 'JOB STOPPED';
    heading.textContent = `Couldn’t finish ${title}`;
    const friendlyErr = friendlyJobError(job);
    const note =
      job.statusNote && (!job.error || !job.statusNote.includes(job.error))
        ? job.statusNote
        : 'The run stopped before completing. Retry from existing chapters or adjust your source.';
    detail.textContent = friendlyErr ? note : job.statusNote || 'The run stopped before completing.';
    if (friendlyErr) {
      errorEl.hidden = false;
      errorEl.textContent = friendlyErr;
    }
    progressWrap.hidden = true;
    clearTrackProgress(track, bar);
  } else if (status === 'interrupted') {
    stage.textContent = 'JOB INTERRUPTED';
    heading.textContent = `${title} was interrupted`;
    detail.textContent = job.statusNote || 'The worker stopped before this run finished. Retry to continue it, or continue with a chapter range.';
    const friendlyErr = friendlyJobError(job);
    if (friendlyErr && friendlyErr !== detail.textContent) {
      errorEl.hidden = false;
      errorEl.textContent = friendlyErr;
    }
    progressWrap.hidden = true;
    clearTrackProgress(track, bar);
  } else if (status === 'queued') {
    stage.textContent = 'QUEUED';
    heading.textContent = `Preparing ${title}`;
    detail.textContent = job.statusNote || 'Waiting for the queue worker to pick this run up.';
    progressWrap.hidden = true;
    clearTrackProgress(track, bar);
  } else if (status === 'downloading') {
    stage.textContent = 'DOWNLOADING ZIP';
    heading.textContent = `Fetching ${title}`;
    detail.textContent = job.statusNote || 'Streaming the chapter archive from Google Drive.';
    progressWrap.hidden = false;
    const known = progress
      ? setTrackProgress(track, bar, progress.loaded, progress.total)
      : (setTrackProgress(track, bar, NaN, NaN), false);
    $('launchProgressLabel').textContent = known ? 'Downloading archive' : 'Downloading archive (total size unknown)';
    if (known) {
      const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
      $('launchProgressBytes').textContent = `${fmtBytes(progress.loaded)} / ${fmtBytes(progress.total)} received (${pct}%)`;
    } else {
      $('launchProgressBytes').textContent = progress && progress.loaded > 0 ? `${fmtBytes(progress.loaded)} received` : '';
    }
  } else if (status === 'ingesting') {
    stage.textContent = 'EXTRACTING CHAPTERS';
    heading.textContent = `Unpacking ${title}`;
    detail.textContent = job.statusNote || 'Validating pages and building chapters.';
    progressWrap.hidden = false;
    setTrackProgress(track, bar, NaN, NaN);
    $('launchProgressLabel').textContent = 'Extracting chapters (no page total reported)';
    $('launchProgressBytes').textContent = '';
  } else if (status === 'running') {
    stage.textContent = 'PRODUCTION LIVE';
    heading.textContent = `${title} is running`;
    detail.textContent = job.statusNote || 'Vision reading, script writing, voice synthesis and rendering are running on the server.';
    progressWrap.hidden = false;
    // chapterIndex is the current chapter ordinal (set on chapter start), not completed count.
    // Never treat current ordinal or backend percent derived from it as completion percentage.
    const hasCompletedCount =
      pipeProg &&
      pipeProg.completedChapters !== null &&
      pipeProg.completedChapters > 0 &&
      pipeProg.chapterTotal > 0 &&
      pipeProg.completedChapters <= pipeProg.chapterTotal;
    if (hasCompletedCount) {
      setTrackProgress(track, bar, pipeProg.completedChapters, pipeProg.chapterTotal);
    } else {
      setTrackProgress(track, bar, NaN, NaN);
    }
    if (pipeProg && pipeProg.chapterIndex > 0 && pipeProg.chapterTotal > 0) {
      $('launchProgressLabel').textContent = pipeProg.chapter
        ? `Producing chapter ${pipeProg.chapterIndex} of ${pipeProg.chapterTotal} (${pipeProg.chapter})`
        : `Producing chapter ${pipeProg.chapterIndex} of ${pipeProg.chapterTotal}`;
    } else if (pipeProg && pipeProg.chapterTotal > 0) {
      $('launchProgressLabel').textContent = `Producing video (${pipeProg.chapterTotal} chapter${pipeProg.chapterTotal === 1 ? '' : 's'})`;
    } else {
      $('launchProgressLabel').textContent = 'Producing video (no step total reported)';
    }
    if (hasCompletedCount) {
      const pct = Math.min(100, Math.round((pipeProg.completedChapters / pipeProg.chapterTotal) * 100));
      $('launchProgressBytes').textContent = `${pipeProg.completedChapters} / ${pipeProg.chapterTotal} completed (${pct}%)`;
    } else {
      $('launchProgressBytes').textContent = '';
    }
  } else if (status === 'completed') {
    stage.textContent = 'COMPLETED';
    heading.textContent = `${title} is ready`;
    detail.textContent = job.statusNote || 'Every selected chapter finished.';
    progressWrap.hidden = true;
    clearTrackProgress(track, bar);
  } else {
    progressWrap.hidden = true;
    clearTrackProgress(track, bar);
  }

  if ($('launchRenderLaneBar')) {
    $('launchRenderLaneBar').hidden = false;
    const laneId = normalizeRenderLaneValue(job?.renderLane);
    $('launchRenderLane').dataset.renderLane = laneId;
    $('launchRenderLane').textContent = formatJobRenderLane(laneId);
  }

  renderLaunchActions(job);
}

function updateLaunchTransfer(jobs) {
  if ($('launchSuccess').hidden) return;
  if (!activeLaunchId) {
    const query = readQuerySelection();
    const matched = query ? findJobForQuery(query, jobs) : null;
    if (matched) {
      showAlert('');
      openLaunchPanel(matched);
    }
    return;
  }
  const job = jobs.find((item) => item.id === activeLaunchId);
  if (!job) return;
  renderLaunchPanel(job);
}

/* ---------- active-job persistence ---------- */

function readStoredActiveJob() {
  try {
    return localStorage.getItem(ACTIVE_JOB_KEY) || '';
  } catch {
    return '';
  }
}

function storeActiveJob(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_JOB_KEY, id);
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {}
}

function readQuerySelection() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const job = (params.get('job') || '').trim();
    const series = (params.get('series') || '').trim().toLowerCase();
    if (!job && !series) return null;
    return { job, series };
  } catch {
    return null;
  }
}

function jobRecencyScore(job) {
  for (const key of ['updatedAt', 'createdAt', 'startedAt']) {
    const v = Number(job?.[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const m = /^job-(\d+)-/.exec(String(job?.id || ''));
  return m ? Number(m[1]) : 0;
}

function findJobForQuery(query, jobs = lastJobs) {
  if (!query || !Array.isArray(jobs) || !jobs.length) return null;
  if (query.job) {
    const byId = jobs.find((item) => String(item?.id || '').trim() === query.job);
    if (byId) return byId;
  }
  if (query.series) {
    const matches = jobs.filter(
      (item) => String(item?.slug || '').trim().toLowerCase() === query.series,
    );
    if (matches.length) {
      matches.sort((a, b) => jobRecencyScore(b) - jobRecencyScore(a));
      return matches[0];
    }
  }
  return null;
}

function renderJobsSelection() {
  $('jobsList').querySelectorAll('.job-card[data-job]').forEach((card) => {
    const selected = Boolean(activeLaunchId && card.dataset.job === activeLaunchId);
    card.classList.toggle('is-selected', selected);
    if (selected) card.setAttribute('data-selected', 'true');
    else card.removeAttribute('data-selected');
  });
}

function renderNotFoundLaunchPanel(query) {
  activeLaunchId = '';
  storeActiveJob('');
  $('creationStudio').hidden = true;
  const panel = $('launchSuccess');
  panel.hidden = false;
  panel.classList.add('is-error');
  panel.classList.remove('is-done', 'is-interrupted');
  document.querySelectorAll('[data-transfer]').forEach((el) => {
    el.classList.remove('on', 'done');
  });
  $('transferStage').textContent = 'RUN NOT FOUND';
  const targetLabel = query.job || query.series || 'selection';
  $('successHeading').textContent = `No run found for ${targetLabel}`;
  $('successDetail').textContent = query.job
    ? `No intake job with ID “${query.job}” exists in the queue. Check Recent runs below or start a new series when you are ready.`
    : `No intake job for series “${query.series}” exists in the queue. Check Recent runs below or start a new series when you are ready.`;
  $('launchProgress').hidden = true;
  if ($('launchRenderLaneBar')) $('launchRenderLaneBar').hidden = true;
  clearTrackProgress($('launchProgressTrack'), $('launchProgressBar'));
  const errorEl = $('launchError');
  errorEl.hidden = false;
  errorEl.textContent = query.job
    ? `Could not find intake job “${query.job}”.`
    : `Could not find an intake job for series “${query.series}”.`;
  showLaunchActionNote('');
  $('retryJob').hidden = true;
  $('retryJob').disabled = true;
  $('continueForm').hidden = true;
  $('continueJob').disabled = true;
  $('continueChapters').disabled = true;
  if ($('continueHint')) $('continueHint').hidden = true;
  $('viewPipelineLink').href = '/status.html';
  showAlert(errorEl.textContent);
  renderJobsSelection();
  panel.scrollIntoView({ block: 'start', behavior: 'instant' });
  panel.focus({ preventScroll: true });
}

function openLaunchPanel(job, { focus = false } = {}) {
  const nextId = job.id || '';
  if (nextId !== activeLaunchId) {
    showLaunchActionNote('');
  }
  activeLaunchId = nextId;
  storeActiveJob(activeLaunchId);
  $('creationStudio').hidden = true;
  const panel = $('launchSuccess');
  panel.hidden = false;
  renderLaunchPanel(job);
  renderJobsSelection();
  if (focus) {
    panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    panel.focus({ preventScroll: true });
  }
}

// Statuses worth re-opening the launch panel for after a reload. A finished
// run stays in the queue list (with its Watch link) so it never hijacks the form.
const RESTORE_STATUSES = ['queued', 'downloading', 'ingesting', 'running', 'failed', 'interrupted'];

function restoreActiveJob() {
  const query = readQuerySelection();
  if (query) {
    const matched = findJobForQuery(query, lastJobs);
    if (!matched) {
      renderNotFoundLaunchPanel(query);
      return;
    }
    showAlert('');
    openLaunchPanel(matched, { focus: true });
    return;
  }
  const stored = readStoredActiveJob();
  if (!stored || activeLaunchId) return;
  const job = lastJobs.find((item) => item.id === stored);
  if (!job || !RESTORE_STATUSES.includes(String(job.status || '').toLowerCase())) {
    if (!job) storeActiveJob(''); // the job is gone from the queue: forget it
    return;
  }
  openLaunchPanel(job);
}

// A failed poll must never blank the queue; surface one quiet, self-clearing line.
function setQueueNotice(message) {
  const el = $('queueNotice');
  queueError = message || '';
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

/* ---------- job actions: retry / continue ---------- */

function showLaunchActionNote(msg, kind = 'error') {
  const el = $('launchActionNote');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('success');
    return;
  }
  el.hidden = false;
  el.classList.toggle('success', kind === 'success');
  el.textContent = msg;
}

const CHAPTERS_SPEC_RE = /^(all|\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/i;

function normalizeChaptersSpec(raw) {
  const spec = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*-\s*/g, '-');
  if (!spec) return { ok: false, error: 'Enter a chapter range, for example 2-5, or “all”.' };
  if (!CHAPTERS_SPEC_RE.test(spec)) {
    return { ok: false, error: 'Use “all”, a range like 2-5, or a list like 1,2,3.' };
  }
  const parts = spec.split(',');
  for (const part of parts) {
    if (part === 'all') continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!(a >= 1) || !(b >= a)) return { ok: false, error: `“${part}” is not a valid range. Use 2-5.` };
    } else if (!(Number(part) >= 1)) {
      return { ok: false, error: `“${part}” is not a valid chapter number.` };
    }
  }
  return { ok: true, spec };
}

// POST an action to a job endpoint. Returns the parsed body; throws a friendly Error.
async function postJobAction(jobId, action, payload) {
  const res = await apiFetch(`/api/intake/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(payload || {}),
  });
  if (res.status === 401) {
    location.assign('/login');
    throw new Error('Your session expired. Sign in again to continue.');
  }
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (res.status === 404 || res.status === 405) {
    const err = new Error(
      'This server does not support that action yet. Use “View pipeline” to watch the run.',
    );
    err.unsupported = true;
    throw err;
  }
  if (res.status === 403) {
    throw new Error(body.error || 'This account cannot change pipeline jobs.');
  }
  if (res.status === 409) {
    throw new Error(body.error || 'That job is already running or queued.');
  }
  if (!res.ok) {
    throw new Error(body.error || `The request failed (HTTP ${res.status}). Try again.`);
  }
  if (body && body.job && body.job.id) return body.job;
  return body;
}

function syncJobBusyUi(jobId) {
  const busy = jobActionBusy.has(jobId);
  updateLaunchTransfer(lastJobs);
  $('jobsList').querySelectorAll(`[data-job-action][data-job-id="${CSS.escape(jobId)}"]`).forEach((btn) => {
    btn.disabled = !privileged || busy;
    if (btn.dataset.jobAction === 'retry') {
      btn.textContent = busy ? 'Retrying…' : 'Retry job';
    } else if (btn.dataset.jobAction === 'continue') {
      btn.textContent = busy ? 'Continuing…' : 'Continue…';
    }
  });
}

async function runJobAction(jobId, action, payload) {
  if (!privileged) {
    showLaunchActionNote('Temporary viewing accounts cannot change pipeline jobs.');
    return;
  }
  if (jobActionBusy.has(jobId)) return; // never double-submit
  const existing = lastJobs.find((item) => item.id === jobId) || { id: jobId, status: 'failed' };
  openLaunchPanel(existing);
  jobActionBusy.add(jobId);
  showLaunchActionNote('');
  syncJobBusyUi(jobId);
  try {
    const job = await postJobAction(jobId, action, payload);
    const merged = {
      ...existing,
      ...job,
      id: jobId,
      renderLane: normalizeRenderLaneValue(job?.renderLane || existing?.renderLane),
    };
    const idx = lastJobs.findIndex((item) => item.id === jobId);
    if (idx >= 0) lastJobs[idx] = merged;
    else lastJobs.unshift(merged);
    activeLaunchId = jobId;
    storeActiveJob(jobId);
    renderLaunchPanel(merged);
    showLaunchActionNote(
      action === 'retry'
        ? `Retry requested for ${merged.title || merged.slug || 'this job'}. The worker picks it up in queue order.`
        : `Continuing ${merged.title || merged.slug || 'this job'} with chapters ${payload?.chapters || 'all'}.`,
      'success',
    );
  } catch (err) {
    if (err?.unsupported) {
      jobActionUnsupported.add(jobId);
      renderLaunchPanel(lastJobs.find((item) => item.id === jobId) || existing);
      $('jobsList').querySelectorAll(`[data-job-action][data-job-id="${CSS.escape(jobId)}"]`).forEach((btn) => btn.remove());
    }
    showLaunchActionNote(err.message || 'The action failed. Try again.');
  } finally {
    jobActionBusy.delete(jobId);
    syncJobBusyUi(jobId);
    loadJobs();
  }
}

$('retryJob').addEventListener('click', () => {
  if (!activeLaunchId) return;
  runJobAction(activeLaunchId, 'retry', {});
});

$('continueJob').addEventListener('click', () => {
  if (!activeLaunchId) return;
  const check = normalizeChaptersSpec($('continueChapters').value);
  if (!check.ok) {
    showLaunchActionNote(check.error);
    $('continueChapters').focus();
    return;
  }
  runJobAction(activeLaunchId, 'continue', { chapters: check.spec });
});

$('continueChapters').addEventListener('input', () => {
  if (!$('launchActionNote').classList.contains('success')) {
    showLaunchActionNote('');
  }
});

$('continueChapters').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('continueJob').click();
  }
});

/* ---------- queue ---------- */

function renderJobs(data) {
  const jobs = data?.jobs || [];
  const extRuns = data?.externalRuns || [];
  lastJobs = jobs;
  const activeJob = jobs.find((j) => ['downloading', 'ingesting', 'running'].includes(j.status));
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;
  updateLaunchTransfer(jobs);

  const pill = $('queueStatePill');
  if (activeJob || data?.workerActive) {
    pill.className = 'pill running';
    pill.textContent = activeJob ? `● ${activeJob.title || activeJob.slug}` : '● Running';
  } else if (queuedCount > 0) {
    pill.className = 'pill queued';
    pill.textContent = `${queuedCount} queued`;
  } else {
    pill.className = 'pill idle';
    pill.textContent = 'Ready';
  }

  if (extRuns.length && !activeJob) {
    $('externalRunBanner').hidden = false;
    $('externalRunBanner').textContent = `Another series (${extRuns[0].series}) is currently running. New series will start right after.`;
  } else {
    $('externalRunBanner').hidden = true;
  }

  if (!jobs.length) {
    $('jobsList').innerHTML = `<div class="panel dashboard-empty"><svg class="icon queue-empty-icon" aria-hidden="true"><use href="#i-clock"/></svg><h3>No active runs</h3><p>Started series appear here while chapters download and render.</p></div>`;
    return;
  }

  // A poll must never steal focus or drop what the user typed in a job card.
  const focus = captureJobsFocus();
  const openLogs = new Set(
    [...$('jobsList').querySelectorAll('details[data-job-id]')].filter((d) => d.open).map((d) => d.dataset.jobId),
  );

  $('jobsList').innerHTML = jobs
    .map((j) => {
      const st = String(j.status || 'queued').toLowerCase();
      const chInfo =
        j.ingestedChapters && j.ingestedChapters.length
          ? `${j.ingestedChapters.length} chapters ready`
          : `Chapters: ${j.chapters || 'all'}`;
      const logs = Array.isArray(j.logTail) ? j.logTail : [];
      const isOpen = openLogs.has(j.id);
      const busy = jobActionBusy.has(j.id);
      const retryable = canJobAction(j, 'retry');
      const continuable = canJobAction(j, 'continue');
      const errorText = friendlyJobError(j);
      const selected = Boolean(activeLaunchId && j.id === activeLaunchId);
      const laneId = normalizeRenderLaneValue(j.renderLane);
      const laneFact = laneId === DEFAULT_RENDER_LANE ? 'Render: inherit' : `Render: ${laneId}`;
      return `<article class="job-card${selected ? ' is-selected' : ''}" data-job="${esc(j.id)}"${selected ? ' data-selected="true"' : ''}>
        <div class="job-head">
          <div>
            <h3 class="job-title">${esc(j.title || j.slug)}</h3>
          </div>
          <span class="pill ${esc(st)}">${esc(st.toUpperCase())}</span>
        </div>
        <div class="job-facts">
          <span>${esc(cleanVoiceName(j.tts?.voiceLabel || j.tts?.voiceId || j.tts?.providerLabel || 'Narrated'))}</span>
          <span>·</span>
          <span>${esc(chInfo)}</span>
          <span>·</span>
          <span data-job-render-lane="${esc(laneId)}">${esc(laneFact)}</span>
          <span>·</span>
          <span>${fmtAge(j.updatedAt || j.createdAt)}</span>
        </div>
        ${j.statusNote && !errorText ? `<div class="job-note">${esc(j.statusNote)}</div>` : ''}
        ${errorText ? `<div class="job-error" role="alert">${esc(errorText)}</div>` : ''}
        ${
          logs.length
            ? `<details class="job-logs" data-job-id="${esc(j.id)}" ${isOpen ? 'open' : ''}>
                <summary>Raw log (${logs.length} lines)</summary>
                <pre>${esc(logs.join('\n'))}</pre>
              </details>`
            : ''
        }
        <div class="job-links">
          <a class="text-link" href="${esc(j.statusUrl || '/status.html')}">View pipeline <svg class="icon"><use href="#i-arrow"/></svg></a>
          ${
            st === 'completed'
              ? `<a class="btn small primary" href="${esc(j.libraryUrl || '/')}"><svg class="icon"><use href="#i-play"/></svg> Watch</a>`
              : ''
          }
          ${
            retryable
              ? `<button type="button" class="btn small" data-job-action="retry" data-job-id="${esc(j.id)}" ${!privileged || busy ? 'disabled' : ''}>${busy ? 'Retrying…' : 'Retry job'}</button>`
              : ''
          }
          ${
            continuable
              ? `<button type="button" class="btn small" data-job-action="continue" data-job-id="${esc(j.id)}" ${!privileged || busy ? 'disabled' : ''}>${busy ? 'Continuing…' : 'Continue…'}</button>`
              : ''
          }
        </div>
      </article>`;
    })
    .join('');

  restoreJobsFocus(focus);
  $('queueUpdatedAt').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// Turn a raw pipeline error into one actionable sentence, keeping the original.
function friendlyJobError(job) {
  const raw = String(job.error || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (/quota|too many users have viewed|rate limit|429/.test(lower)) {
    return `Download limit reached: ${raw} Retry in a few hours, or upload the ZIP instead.`;
  }
  if (/not found|404|permission|access denied|private/.test(lower)) {
    return `The link is not publicly readable: ${raw} Set the ZIP to “Anyone with the link”, then retry.`;
  }
  if (/already exists|never overwritten/.test(lower)) {
    return `That series folder already exists: ${raw} Choose a different slug.`;
  }
  if (/zip|archive|corrupt|invalid/.test(lower)) {
    return `The archive could not be read: ${raw} Re-export the ZIP and try again.`;
  }
  return raw;
}

// Focus/selection capture so a background poll does not disturb the user.
function captureJobsFocus() {
  const el = document.activeElement;
  if (!el || !$('jobsList').contains(el)) return null;
  const actionBtn = el.closest('[data-job-action][data-job-id]');
  const summary = el.closest('details[data-job-id] > summary');
  return {
    id: el.id || null,
    jobId: actionBtn?.dataset.jobId || summary?.parentElement?.dataset.jobId || null,
    action: actionBtn?.dataset.jobAction || null,
    isSummary: Boolean(summary),
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
    value: typeof el.value === 'string' ? el.value : null,
  };
}

function restoreJobsFocus(snapshot) {
  if (!snapshot) return;
  let el = snapshot.id ? $(snapshot.id) : null;
  if (!el && snapshot.jobId && snapshot.action) {
    el = $('jobsList').querySelector(
      `[data-job-id="${CSS.escape(snapshot.jobId)}"][data-job-action="${CSS.escape(snapshot.action)}"]`,
    );
  } else if (!el && snapshot.jobId && snapshot.isSummary) {
    el = $('jobsList').querySelector(`details[data-job-id="${CSS.escape(snapshot.jobId)}"] > summary`);
  }
  if (!el) return;
  if (snapshot.value !== null && typeof el.value === 'string' && el.value !== snapshot.value) {
    el.value = snapshot.value;
  }
  try {
    el.focus({ preventScroll: true });
    if (snapshot.start !== null && typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    }
  } catch {}
}

/* ---------- data loading ---------- */

async function loadCatalog() {
  const res = await apiFetch('/api/intake/catalog');
  if (res.status === 401) {
    location.assign('/login');
    return;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load intake catalog');
  catalog = data;
  csrfToken = data.csrfToken || csrfToken;
  privileged = data.privileged !== false;
  renderCatalog();
}

async function loadJobs() {
  try {
    const res = await apiFetch('/api/intake/jobs', { timeoutMs: 15000 });
    if (res.status === 401) {
      location.assign('/login');
      return;
    }
    if (!res.ok) {
      setQueueNotice('Could not refresh the queue just now. Retrying…');
      return;
    }
    const data = await res.json();
    if (data.csrfToken) csrfToken = data.csrfToken;
    if (typeof data.privileged === 'boolean') privileged = data.privileged;
    setQueueNotice('');
    renderJobs(data);
  } catch {
    setQueueNotice('Could not reach the server. Showing the last known queue. Retrying…');
  }
}

async function pollPipelineStatusDot() {
  try {
    const res = await apiFetch('/api/status', { timeoutMs: 15000 });
    if (!res.ok) return;
    const s = await res.json();
    $('statusDot').dataset.state = s.state;
  } catch {}
}

/* ---------- voice preview ---------- */

const audioEl = () => $('previewAudio');

function stopPreviewAudio() {
  const audio = audioEl();
  try {
    audio.pause();
  } catch {}
  previewPlaying = false;
  $('previewStop').hidden = true;
}

function resetPreview(statusText = '') {
  // Abandon any in-flight request and invalidate late replies.
  previewGen += 1;
  if (previewController) {
    try {
      previewController.abort();
    } catch {}
    previewController = null;
  }
  previewPreparing = false;
  stopPreviewAudio();

  const audio = audioEl();
  audio.removeAttribute('src');
  try {
    audio.load();
  } catch {}
  audio.hidden = true;

  $('previewRetry').hidden = true;
  setFieldError('voice', '');
  $('previewError').hidden = true;
  $('previewError').textContent = '';
  $('previewListenText').textContent = 'Listen sample';
  $('previewListen').hidden = false;
  $('previewSelection').textContent = providerVoiceLabel();
  const prov = currentProvider();
  const blocked = !privileged || (prov && !prov.available);
  $('previewListen').disabled = Boolean(blocked);
  $('previewStatus').textContent = blocked
    ? (!privileged ? 'Temporary accounts cannot generate previews.' : 'Preview unavailable for this provider.')
    : statusText;
}

function previewError(message) {
  previewPreparing = false;
  $('previewListenText').textContent = 'Listen sample';
  $('previewListen').hidden = false;
  $('previewListen').disabled = !privileged || currentProvider()?.available === false;
  $('previewStop').hidden = true;
  $('previewStatus').textContent = 'Preview failed.';
  $('previewError').hidden = false;
  $('previewError').textContent = message;
  $('previewRetry').hidden = false;
}

async function requestPreview() {
  if (previewPreparing || submitting) return;
  const prov = currentProvider();
  const voice = currentVoice();
  if (!privileged) return;
  if (!prov || !voice) {
    setFieldError('voice', 'Select a provider and voice first.');
    return;
  }
  if (!prov.available) {
    setFieldError('voice', `${prov.label} is unavailable: ${prov.unavailableReason || 'not configured'}`);
    return;
  }

  const gen = ++previewGen;
  if (previewController) {
    try {
      previewController.abort();
    } catch {}
  }
  const controller = new AbortController();
  previewController = controller;

  previewPreparing = true;
  stopPreviewAudio();
  setFieldError('voice', '');
  $('previewError').hidden = true;
  $('previewRetry').hidden = true;
  $('previewListen').hidden = false;
  $('previewListen').disabled = true;
  $('previewListenText').textContent = 'Preparing…';
  $('previewStatus').textContent = `Preparing sample for ${prov.label} · ${voice.label}…`;
  $('previewStop').hidden = false;

  let body;
  try {
    const res = await apiFetch('/api/intake/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ provider: prov.id, voice: voice.id }),
      signal: controller.signal,
    });
    body = await res.json().catch(() => ({}));
    if (gen !== previewGen) return; // a newer selection superseded this request

    if (res.status === 401) {
      location.assign('/login');
      return;
    }
    if (res.status === 403) {
      privileged = false;
      previewError(body.error || 'Temporary accounts cannot generate previews.');
      $('previewStatus').textContent = 'Temporary accounts cannot generate previews.';
      $('previewRetry').hidden = true;
      return;
    }
    if (res.status === 429) {
      previewError(body.error || 'A preview is already being generated. Try again shortly.');
      return;
    }
    if (!res.ok) {
      previewError(body.error || `Preview failed (HTTP ${res.status}).`);
      return;
    }
  } catch (err) {
    if (gen !== previewGen || err?.name === 'AbortError') return; // superseded or cancelled
    previewError('Could not reach the preview service. Check your connection and retry.');
    return;
  }

  if (gen !== previewGen) return;
  previewPreparing = false;
  previewController = null;
  $('previewListenText').textContent = 'Listen sample';
  $('previewListen').hidden = true;
  $('previewListen').disabled = false;
  $('previewStop').hidden = false;
  $('previewStatus').textContent = body.cached
    ? `Playing cached sample for ${prov.label} · ${voice.label}.`
    : `Playing new sample for ${prov.label} · ${voice.label}.`;

  const audio = audioEl();
  audio.hidden = false;
  audio.src = body.audioUrl;
  try {
    await audio.play();
    previewPlaying = true;
  } catch {
    // Autoplay refused: the native controls stay visible for a manual play.
    previewPlaying = false;
    $('previewStatus').textContent = 'Sample ready — press play to hear it.';
  }
}

$('previewListen').addEventListener('click', requestPreview);
$('previewRetry').addEventListener('click', requestPreview);
$('previewStop').addEventListener('click', () => {
  if (previewPreparing && previewController) {
    previewGen += 1;
    try {
      previewController.abort();
    } catch {}
    previewController = null;
    previewPreparing = false;
    $('previewListenText').textContent = 'Listen sample';
    $('previewListen').hidden = false;
    $('previewListen').disabled = !privileged || currentProvider()?.available === false;
    $('previewStatus').textContent = 'Preview stopped.';
  } else {
    // Keep the "ready for manual play" hint when autoplay was refused.
    const wasReady = $('previewStatus').textContent.startsWith('Sample ready');
    stopPreviewAudio();
    $('previewStatus').textContent = wasReady ? 'Sample ready — press play to hear it.' : 'Preview stopped.';
    $('previewStop').hidden = true;
    return;
  }
  stopPreviewAudio();
  $('previewStop').hidden = true;
});

const previewAudioEl = audioEl();
previewAudioEl.addEventListener('play', () => {
  previewPlaying = true;
  $('previewStop').hidden = false;
});
previewAudioEl.addEventListener('ended', () => {
  previewPlaying = false;
  $('previewStop').hidden = true;
});
previewAudioEl.addEventListener('pause', () => {
  previewPlaying = false;
  if (!previewPreparing) $('previewStop').hidden = true;
});

/* ---------- upload ---------- */

function uploadZipWithProgress(file, meta) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({
      sourceType: 'upload',
      title: meta.title,
      slug: meta.slug,
      provider: meta.provider,
      voice: meta.voice,
      chapters: meta.chapters,
      background: meta.background,
      motion: meta.motion,
      renderLane: meta.renderLane || DEFAULT_RENDER_LANE,
      filename: file.name || 'archive.zip',
    });
    xhr.open('POST', `/api/intake/jobs?${qs.toString()}`, true);
    xhr.timeout = 720000; // Ten-minute upload budget plus validation/preflight time.
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    $('uploadProgressWrap').hidden = false;
    $('uploadPhase').textContent = 'Uploading archive…';
    $('uploadPct').textContent = '0%';
    $('uploadBar').style.width = '0%';

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && e.total > 0) {
        const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
        $('uploadPct').textContent = `${pct}% (${fmtBytes(e.loaded)} / ${fmtBytes(e.total)})`;
        $('uploadBar').style.width = `${pct}%`;
        if (pct >= 100) {
          $('uploadPhase').textContent = 'Validating ZIP & preflighting pipeline…';
        }
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 401) {
        location.assign('/login');
        reject(new Error('Authentication required'));
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch {
        reject(new Error(`Invalid upload response (HTTP ${xhr.status}). Refresh the queue before retrying.`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed);
      } else {
        reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error while uploading ZIP archive')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out. Refresh the queue before retrying.')));
    xhr.send(file);
  });
}

/* ---------- selected file ---------- */

function clearSelectedFile() {
  $('zipFile').value = '';
  $('fileLabel').textContent = 'Drop .zip or browse';
  $('fileMeta').textContent = 'Chapters or .cbz archive';
  $('fileActions').hidden = true;
  setFieldError('file', '');
  updateSummary();
}

function setSelectedFile(file) {
  if (!file) {
    clearSelectedFile();
    return;
  }
  if (!/\.zip$/i.test(file.name || '')) {
    clearSelectedFile();
    setFieldError('file', 'Only .zip archives are supported.');
    return;
  }
  const maxBytes = catalog?.limits?.maxZipBytes;
  $('fileLabel').textContent = file.name;
  $('fileMeta').textContent = `${fmtBytes(file.size)} · ready to validate & upload`;
  $('fileActions').hidden = false;
  setFieldError('file', maxBytes && file.size > maxBytes ? `File exceeds the ${fmtBytes(maxBytes)} limit.` : '');

  if (!$('seriesTitle').value.trim()) {
    const stem = file.name.replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').trim();
    $('seriesTitle').value = stem;
    if (!slugTouched) {
      $('seriesSlug').value = slugify(stem);
    }
    updateSummary();
  }
  updateSummary();
}

/* ---------- wiring ---------- */

$('tabGdrive').addEventListener('click', () => setMode('gdrive'));
$('tabUpload').addEventListener('click', () => setMode('upload'));

$('ttsProvider').addEventListener('change', () => {
  populateVoices();
  resetPreview('Selection changed — listen again for this voice.');
});
$('ttsVoice').addEventListener('change', () => {
  updateSummary();
  resetPreview('Selection changed — listen again for this voice.');
});

$('seriesTitle').addEventListener('input', () => {
  if (!slugTouched) {
    $('seriesSlug').value = slugify($('seriesTitle').value);
  }
  setFieldError('title', '');
  updateSummary();
});

$('seriesSlug').addEventListener('input', () => {
  slugTouched = Boolean($('seriesSlug').value.trim());
  setFieldError('slug', '');
});

$('chaptersSpec').addEventListener('input', updateSummary);
$('gdriveUrl').addEventListener('input', () => { setFieldError('gdrive', ''); updateSummary(); });

$('zipFile').addEventListener('change', () => setSelectedFile($('zipFile').files?.[0]));

$('fileReplace').addEventListener('click', () => $('zipFile').click());
$('fileRemove').addEventListener('click', () => clearSelectedFile());

['dragenter', 'dragover'].forEach((ev) => {
  $('fileDrop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('fileDrop').classList.add('dragover');
  });
});
['dragleave', 'dragend'].forEach((ev) => {
  $('fileDrop').addEventListener(ev, () => $('fileDrop').classList.remove('dragover'));
});
$('fileDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('fileDrop').classList.remove('dragover');
  const dropped = e.dataTransfer?.files?.[0];
  if (!dropped) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(dropped);
    $('zipFile').files = dt.files;
  } catch {}
  setSelectedFile(dropped);
});
// Never let a stray drop navigate the page away from the form.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (!$('fileDrop').contains(e.target)) e.preventDefault();
});

$('intakeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting || !privileged) return;
  if (studioStep < 2) { goToStep(studioStep + 1); return; }
  if (!validateStory()) return;
  if (!currentProvider()?.available || !currentVoice()) { goToStep(1); return; }
  showAlert('');
  clearFieldErrors();

  const title = $('seriesTitle').value.trim();
  const slug = $('seriesSlug').value.trim().toLowerCase() || slugify(title);
  $('seriesSlug').value = slug;
  const provider = $('ttsProvider').value || 'edge';
  const voice = $('ttsVoice').value || '';
  const chapters = $('chaptersSpec').value.trim() || 'all';
  const background = $('bgPreset').value || 'starfield';
  const motion = $('motionPreset').value || 'cut';
  const rawRenderLane = String($('renderLane')?.value ?? DEFAULT_RENDER_LANE).trim().toLowerCase() || DEFAULT_RENDER_LANE;
  const chosenLaneOpt = renderLaneById(rawRenderLane);

  let invalid = false;
  if (!chosenLaneOpt) {
    setFieldError('renderLane', 'Choose a render lane from the list.');
    invalid = true;
  } else if (!chosenLaneOpt.available) {
    setFieldError(
      'renderLane',
      `${chosenLaneOpt.label} is unavailable: ${chosenLaneOpt.unavailableReason || 'not available'}.`,
    );
    invalid = true;
  }
  const renderLane = chosenLaneOpt && chosenLaneOpt.available ? chosenLaneOpt.id : DEFAULT_RENDER_LANE;
  if (!title) {
    setFieldError('title', 'Enter a series title.');
    invalid = true;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2) {
    setFieldError('slug', 'Slug needs 2+ characters: lowercase letters, numbers, hyphens.');
    $('advancedOptions').open = true;
    invalid = true;
  }
  if (sourceMode === 'gdrive' && !$('gdriveUrl').value.trim()) {
    setFieldError('gdrive', 'Paste a public Google Drive file .zip link.');
    invalid = true;
  }
  if (sourceMode === 'upload' && !$('zipFile').files?.[0]) {
    setFieldError('file', 'Select or drop a .zip archive.');
    invalid = true;
  }
  if (invalid) {
    showStep(2, false);
    const first = $('formAlert');
    first.hidden = false;
    first.className = 'intake-alert';
    first.textContent = 'Fix the highlighted fields before queueing.';
    document.querySelector('.field-error:not([hidden])')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  submitting = true;
  $('intakeForm').setAttribute('aria-busy', 'true');
  const lockedControls = [...document.querySelectorAll('#intakeForm input, #intakeForm select, #intakeForm button, [data-step]')];
  const disabledBefore = new Map(lockedControls.map(control => [control, control.disabled]));
  lockedControls.forEach(control => { control.disabled = true; });
  $('submitBtn').disabled = true;
  const origBtnText = $('submitBtnText').textContent;
  $('submitBtnText').textContent = sourceMode === 'upload' ? 'Uploading & validating…' : 'Validating & queueing…';

  try {
    let created;
    if (sourceMode === 'gdrive') {
      const gdriveUrl = $('gdriveUrl').value.trim();
      const res = await apiFetch('/api/intake/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          sourceType: 'gdrive',
          gdriveUrl,
          title,
          slug,
          provider,
          voice,
          chapters,
          background,
          motion,
          renderLane,
          csrfToken,
        }),
      });
      if (res.status === 401) {
        location.assign('/login');
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Request failed (HTTP ${res.status})`);
      }
      created = body;
      $('gdriveUrl').value = '';
    } else {
      const file = $('zipFile').files?.[0];
      const maxBytes = catalog?.limits?.maxZipBytes || 1536 * 1024 * 1024;
      if (file.size > maxBytes) {
        throw new Error(`Selected file (${fmtBytes(file.size)}) exceeds maximum allowed size (${fmtBytes(maxBytes)}).`);
      }
      created = await uploadZipWithProgress(file, {
        title,
        slug,
        provider,
        voice,
        chapters,
        background,
        motion,
        renderLane,
      });
      clearSelectedFile();
    }

    $('seriesTitle').value = '';
    $('seriesSlug').value = '';
    if ($('renderLane')) $('renderLane').value = DEFAULT_RENDER_LANE;
    slugTouched = false;
    updateSummary();
    showAlert(
      `Queued ${created.title} (series/${created.slug}) as ${created.id} · ${providerVoiceLabel()} · chapters ${chapters} · render ${renderLane}. The pipeline runs automatically in the background.`,
      'success',
    );
    openLaunchPanel({
      ...created,
      id: created.id || '',
      title: created.title || title,
      slug: created.slug || slug,
      renderLane: normalizeRenderLaneValue(created.renderLane || renderLane),
      status: created.status || (sourceMode === 'gdrive' ? 'downloading' : 'ingesting'),
      sourceType: created.sourceType || sourceMode,
      statusNote: created.statusNote || 'This page updates live. Use “View pipeline” when you want the full run view.',
    });
    $('launchSuccess').focus();
    await loadJobs();
  } catch (err) {
    showAlert(err.message || 'Could not queue intake job.');
  } finally {
    submitting = false;
    $('intakeForm').removeAttribute('aria-busy');
    lockedControls.forEach(control => { control.disabled = disabledBefore.get(control); });
    $('uploadProgressWrap').hidden = true;
    $('submitBtnText').textContent = origBtnText;
    if (privileged) $('submitBtn').disabled = false;
  }
});

$('refreshJobs').addEventListener('click', () => loadJobs());

// Queue-card actions. "Retry job" fires immediately; "Continue…" anchors the
// launch panel to that job and hands focus to the chapter-range input, so the
// user types the range once and the shared continue form handles the POST.
$('jobsList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-job-action]');
  if (!button || button.disabled || !privileged) return;
  const jobId = button.dataset.jobId;
  if (!jobId || jobActionBusy.has(jobId)) return;
  if (button.dataset.jobAction === 'continue') {
    const job = lastJobs.find((item) => item.id === jobId) || { id: jobId, status: 'completed' };
    openLaunchPanel(job);
    $('continueChapters').focus({ preventScroll: false });
    return;
  }
  runJobAction(jobId, button.dataset.jobAction, {});
});

/* ---------- tab visibility: never keep audio running ---------- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resetPreview('Paused — the tab was hidden.');
  }
});
window.addEventListener('pagehide', () => {
  stopPreviewAudio();
});

/* ---------- init ---------- */

// Keep the production choices visible; only the filesystem slug is advanced.
$('productionStep').insertBefore($('productionControls'), $('submitSummary'));
$('intakeForm').insertBefore($('uploadProgressWrap'), document.querySelector('.studio-navigation'));
$('advancedOptions').querySelector('.advanced-hint').textContent = 'slug';
$('stepNext').addEventListener('click', () => goToStep(studioStep + 1));
$('stepBack').addEventListener('click', () => goToStep(studioStep - 1));
document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => goToStep(Number(button.dataset.step))));
document.querySelectorAll('[data-chapters]').forEach(button => button.addEventListener('click', () => {
  $('chaptersSpec').value = button.dataset.chapters;
  updateSummary();
}));
$('bgPreset').addEventListener('change', updateSummary);
$('motionPreset').addEventListener('change', updateSummary);
$('renderLane')?.addEventListener('change', () => {
  setFieldError('renderLane', '');
  updateSummary();
});
$('bgCards').addEventListener('click', event => {
  const button = event.target.closest('[data-bg]');
  if (!button) return;
  $('bgPreset').value = button.dataset.bg;
  updateSummary();
});
$('motionCards').addEventListener('click', event => {
  const button = event.target.closest('[data-motion]');
  if (!button) return;
  $('motionPreset').value = button.dataset.motion;
  updateSummary();
});
$('voiceCards').addEventListener('click', event => {
  const button = event.target.closest('[data-voice]');
  if (!button || button.disabled) return;
  $('ttsVoice').value = button.dataset.voice;
  $('ttsVoice').dispatchEvent(new Event('change'));
});

function bindButtonGroupKeys(container, selector) {
  if (!container) return;
  container.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...container.querySelectorAll(selector)].filter((b) => !b.disabled);
    const cur = buttons.indexOf(event.target.closest(selector));
    if (cur < 0 || buttons.length < 2) return;
    event.preventDefault();
    const nextIdx =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? (cur + 1) % buttons.length
            : (cur - 1 + buttons.length) % buttons.length;
    const target = buttons[nextIdx];
    target.focus();
    target.click();
  });
}

bindButtonGroupKeys(document.querySelector('.setup-path'), '[data-step]');
bindButtonGroupKeys($('voiceCards'), '[data-voice]');
bindButtonGroupKeys($('bgCards'), '[data-bg]');
bindButtonGroupKeys($('motionCards'), '[data-motion]');
bindButtonGroupKeys(document.querySelector('.chapter-shortcuts'), '[data-chapters]');
$('createAnother').addEventListener('click', () => {
  activeLaunchId = '';
  storeActiveJob('');
  if (window.location.search) {
    try { history.replaceState(null, '', window.location.pathname); } catch {}
  }
  if ($('renderLane')) $('renderLane').value = DEFAULT_RENDER_LANE;
  setFieldError('renderLane', '');
  $('launchSuccess').hidden = true;
  $('creationStudio').hidden = false;
  renderJobsSelection();
  showAlert('');
  updateSummary();
  showStep(0);
});
document.querySelector('.source-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const mode = event.key === 'Home' ? 'gdrive' : event.key === 'End' ? 'upload' : sourceMode === 'gdrive' ? 'upload' : 'gdrive';
  setMode(mode);
  $(mode === 'gdrive' ? 'tabGdrive' : 'tabUpload').focus();
});
$('previewAudio').addEventListener('playing', () => $('previewCard').classList.add('is-playing'));
['pause', 'ended', 'error', 'emptied'].forEach(event => $('previewAudio').addEventListener(event, () => $('previewCard').classList.remove('is-playing')));
showStep(0, false);

(async function init() {
  try {
    await Promise.all([loadCatalog(), loadJobs(), pollPipelineStatusDot()]);
  } catch (err) {
    showAlert(err.message || 'Failed to initialize intake page.');
  }
  updateSummary();
  restoreActiveJob();
  pollTimer = setInterval(() => {
    if (!document.hidden) {
      loadJobs();
      pollPipelineStatusDot();
    }
  }, 4000);
})();
