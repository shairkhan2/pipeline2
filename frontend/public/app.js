/* Screening Room — a small, dependency-free player. */
const view = document.getElementById('view');
const find = document.getElementById('find');
const toast = document.getElementById('toast');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const watchURL = (s, c) => `#/watch/${encodeURIComponent(s.slug)}/${encodeURIComponent(c.ch)}`;
const manageSeriesURL = (slug) => `/new-series.html?series=${encodeURIComponent(slug)}`;
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
let library = null;
let query = '';
let sort = storage.get('library-sort') || 'latest';
let onScreen = null;
let routeVersion = 0;
let lastHash = '';
let toastTimer;
let libraryRequest = null;
let csrfToken = '';
let privileged = false;
let refreshWarning = '';
const railMemo = {};

function fmtTime(s) {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
}
function fmtLength(s) {
  if (!s) return 'Ready to watch';
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}
function fmtSize(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round((b || 0) / 1048576)) + ' MB'; }
const getPos = (s, c) => Math.max(0, Number(storage.get(`pos:${s}:${c}`)) || 0);
const isDone = (s, c) => storage.get(`done:${s}:${c}`) === '1';
function setPos(s, c, t) {
  storage.set(`pos:${s}:${c}`, t);
  storage.set(`at:${s}:${c}`, Date.now());
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
async function fetchLibrary(force = false) {
  if (libraryRequest && !force) return libraryRequest;
  const req = (async () => {
    const res = await apiFetch('/api/library', { timeoutMs: 30000 });
    if (res.status === 401) { location.assign('/login'); throw new Error('Sign in required'); }
    if (!res.ok) throw new Error('Library unavailable');
    const data = await res.json();
    if (data && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
    privileged = data?.privileged !== false;
    return data;
  })();
  libraryRequest = req;
  try { return await req; } finally { if (libraryRequest === req) libraryRequest = null; }
}
function hasChapterInLibrary(slug, ch) {
  const s = (library?.series || []).find((item) => item.slug === slug);
  return Boolean(s && (s.chapters || []).some((c) => c.ch === ch));
}
function removeChapterFromLibrary(slug, ch) {
  if (!library || !Array.isArray(library.series)) return;
  library = {
    ...library,
    series: library.series
      .map((s) => (s.slug === slug ? { ...s, chapters: (s.chapters || []).filter((c) => c.ch !== ch) } : s))
      .filter((s) => s.chapters.length > 0),
  };
  const countEl = document.getElementById('libraryCount');
  if (countEl) countEl.textContent = library.series.length;
}
function refreshWarningBanner() {
  if (!refreshWarning) return '';
  return `<div class="refresh-warning" id="refreshWarning" role="status" aria-live="polite"><span>${esc(refreshWarning)}</span><button class="btn small" type="button" id="retryRefresh" data-refresh>${icon('refresh')} Retry refresh</button></div>`;
}
function pickResume() {
  let best = null;
  for (const s of library?.series || []) for (const c of s.chapters) {
    const pos = getPos(s.slug, c.ch), at = Number(storage.get(`at:${s.slug}:${c.ch}`)) || 0;
    if (pos <= 5 || isDone(s.slug, c.ch) || (c.duration && pos >= c.duration - 8)) continue;
    if (!best || at > best.at) best = { series: s, chapter: c, pos, at };
  }
  return best;
}
function artworkPicks() {
  const names = new Set();
  return (library?.thumbnails || []).filter((t) => {
    const key = t.name.split('_')[0];
    if (names.has(key)) return false;
    names.add(key);
    return true;
  }).slice(0, 3);
}
function artworkLabel(name) {
  return name.replace(/\.[a-z]+$/i, '').replace(/__dup(\d+)$/, ' · version $1').replace(/[_-]+/g, ' ');
}
function seriesArt(s) {
  return (library.thumbnails || []).find((t) => t.name.startsWith(s.slug + '_'))?.url || s.chapters.find((c) => c.poster)?.poster;
}
function picture(url, label = '', eager = false) {
  return url ? `<img src="${esc(url)}" alt="${esc(label)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async">` : '';
}
function pageHeading(eyebrow, title, description, aside = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${aside}</div>`;
}
function emptyState(title, text, action = '', kind = 'film') {
  return `<div class="state"><span class="state-icon">${icon(kind)}</span><h2>${title}</h2><p>${text}</p>${action}</div>`;
}

/* ---------- library ---------- */
function renderLibrary() {
  document.title = 'Library — Screening Room';
  view.querySelectorAll('.rail').forEach((r) => { railMemo[r.dataset.rail] = r.scrollLeft; });
  const all = [...(library.series || [])];
  const newest = (s) => Math.max(0, ...s.chapters.map((c) => c.mtime || 0));
  all.sort(sort === 'title' ? (a, b) => a.title.localeCompare(b.title) : (a, b) => newest(b) - newest(a));
  const chapters = all.reduce((n, s) => n + s.chapters.length, 0);
  const picks = artworkPicks();
  const resume = pickResume();
  let html = refreshWarningBanner() + pageHeading('SETTLE IN. PRESS PLAY.', 'Your next chapter.', 'Great stories deserve a good seat. This one is yours.',
    `<div class="collection-count">${icon('film')}<div><strong>${chapters}</strong><span>chapter${chapters === 1 ? '' : 's'} to explore</span></div></div>`);

  if (all.length) {
    const featured = [...all].sort((a, b) => newest(b) - newest(a))[0];
    const chapter = featured.chapters[0];
    const art = seriesArt(featured);
    html += `<section class="hero" aria-label="Featured series">
      ${art ? `<img class="hero-art" src="${esc(art)}" alt="" fetchpriority="high">` : ''}
      <div class="hero-copy"><span class="eyebrow">IN THE SPOTLIGHT</span><h2>${esc(featured.title)}</h2>
      <p>${featured.chapters.length} chapter${featured.chapters.length === 1 ? '' : 's'} · ${fmtLength(featured.chapters.reduce((n, c) => n + (c.duration || 0), 0))}<br>Your next escape is ready when you are.</p>
      <div class="hero-actions"><a class="btn primary" href="${watchURL(featured, chapter)}">${icon('play')} Start watching</a><button class="btn" data-browse="${esc(featured.slug)}">Explore chapters ${icon('arrow')}</button></div></div>
      <span class="hero-tag">THE SCREENING ROOM COLLECTION</span></section>`;
  } else {
    html += `<section class="hero empty-hero"><div class="art-stack" aria-hidden="true">${picks.map((t) => picture(t.url, '', true)).join('')}</div>
      <div class="hero-copy"><span class="eyebrow">YOUR PRIVATE CINEMA</span><h2>A home for<br><em>every chapter.</em></h2><p>Big adventures. Beautiful worlds. All your manhwa stories, together in one place.</p>
      <div class="hero-actions"><a class="btn primary" href="/status.html">${icon('status')} View pipeline</a>${privileged ? `<a class="btn" href="/new-series.html">Manage runs ${icon('arrow')}</a>` : ''}<a class="btn" href="#/artwork">Explore artwork ${icon('arrow')}</a></div></div></section>`;
  }
  if (resume) {
    const { series: s, chapter: c, pos } = resume;
    html += `<a class="resume" href="${watchURL(s, c)}"><span class="shot">${picture(c.poster || seriesArt(s))}<span class="progress"><i style="width:${Math.min(100, c.duration ? pos / c.duration * 100 : 0)}%"></i></span></span>
      <span class="rmain"><span class="eyebrow">RIGHT WHERE YOU LEFT OFF</span><span class="rtitle">${esc(s.title)}</span><span class="rmeta">Chapter ${c.num} · ${c.duration ? fmtTime(c.duration - pos) + ' remaining' : fmtTime(pos) + ' watched'}</span></span><span class="btn primary">${icon('play')} Continue watching</span></a>`;
  }
  html += `<div class="section-heading library-heading"><h2>In your library <span>${all.length} series</span></h2><div class="section-tools">
    ${all.length ? `<label class="sort-label"><span>Sort by</span><select id="sort" aria-label="Sort library"><option value="latest" ${sort === 'latest' ? 'selected' : ''}>Recently added</option><option value="title" ${sort === 'title' ? 'selected' : ''}>Title A–Z</option></select></label>` : ''}
    <button class="icon-btn" data-refresh aria-label="Refresh library" title="Refresh library">${icon('refresh')}</button></div></div><p id="hits" class="search-summary" role="status" hidden></p>`;
  if (!all.length) {
    html += `<div class="state empty-library"><span class="state-icon">${icon('film')}</span><div class="empty-copy"><h2>The screen is ready. Your stories are on their way.</h2><p>Finished chapters appear here automatically. Check the pipeline to see what’s in the making, or manage runs that stopped before producing a video.</p></div><div class="actions"><a class="btn" href="/status.html">Check progress ${icon('arrow')}</a>${privileged ? `<a class="btn" id="emptyManageRuns" href="/new-series.html">Manage runs ${icon('arrow')}</a>` : ''}</div></div>`;
  }
  html += all.map((s) => {
    const seen = Number(storage.get(`seen:${s.slug}`)) || 0;
    const fresh = seen ? s.chapters.filter((c) => c.mtime > seen).length : 0;
    const tiles = s.chapters.map((c) => {
      const pos = getPos(s.slug, c.ch), done = isDone(s.slug, c.ch);
      const pct = done ? 100 : c.duration ? Math.min(100, pos / c.duration * 100) : 0;
      return `<a class="ch" data-n="${c.num}" href="${watchURL(s, c)}" aria-label="${esc(s.title)}, Chapter ${c.num}${done ? ', watched' : ''}"><span class="shot">
        ${c.poster ? picture(c.poster) : `<span class="fallback-art">${String(c.num).padStart(2, '0')}</span>`}<span class="duration">${fmtTime(c.duration)}</span><span class="cue">${icon('play')}</span>${pct ? `<span class="progress"><i style="width:${pct}%"></i></span>` : ''}</span>
        <span class="cap"><span>Chapter ${String(c.num).padStart(2, '0')}</span><span class="muted">${fmtSize(c.size)}</span></span><span class="chapter-status${done ? ' watched' : ''}">${done ? 'Watched' : pos > 5 ? 'Continue watching' : 'Ready to play'}</span></a>`;
    }).join('');
    return `<section class="block" data-title="${esc(s.title.toLowerCase())}" data-series="${esc(s.slug)}"><div class="railhead"><div><h3>${esc(s.title)}</h3><div class="facts"><span>${s.chapters.length} chapter${s.chapters.length === 1 ? '' : 's'}</span><span>·</span><span>${fmtLength(s.chapters.reduce((n, c) => n + (c.duration || 0), 0))}</span></div></div>${fresh ? `<span class="new">${fresh} new</span>` : ''}<span class="grow"></span>
      ${privileged ? `<a class="btn small" data-manage-series="${esc(s.slug)}" href="${esc(manageSeriesURL(s.slug))}">Manage chapters ${icon('arrow')}</a>` : ''}
      ${s.full ? `<a class="btn small" href="${esc(s.full.url)}?download=1" download>${icon('download')} Full series · ${fmtSize(s.full.size)}</a>` : ''}
      <div class="rail-controls"><button class="icon-btn previous" data-scroll="-1" aria-label="Previous chapters in ${esc(s.title)}">${icon('arrow')}</button><button class="icon-btn" data-scroll="1" aria-label="More chapters in ${esc(s.title)}">${icon('arrow')}</button></div></div><div class="railwrap"><div class="rail" data-rail="${esc(s.slug)}">${tiles}</div></div></section>`;
  }).join('');
  html += `<div id="noresults" hidden>${emptyState('No stories found', 'Try a series title or a chapter number, like “chapter 12”.', '<button class="btn" data-clear-search>Clear search</button>', 'search')}</div>`;
  if (picks.length) {
    html += `<section class="art-preview"><div class="section-heading"><div><h2>Behind the stories</h2><p>A little art for your next adventure.</p></div><a class="text-link" href="#/artwork">All artwork ${icon('arrow')}</a></div><div class="preview-grid">${picks.map((t) => `<a class="preview-card" href="#/artwork">${picture(t.url)}<span>${esc(t.name.split('_')[0].replace(/-/g, ' '))}</span></a>`).join('')}</div></section>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('.rail').forEach((rail) => {
    rail.scrollLeft = railMemo[rail.dataset.rail] || 0;
    const update = () => {
      railMemo[rail.dataset.rail] = rail.scrollLeft;
      const controls = rail.closest('.block').querySelectorAll('[data-scroll]');
      controls[0].disabled = rail.scrollLeft <= 2;
      controls[1].disabled = rail.scrollWidth - rail.clientWidth - rail.scrollLeft <= 2;
    };
    rail.addEventListener('scroll', update, { passive: true });
    requestAnimationFrame(update);
  });
  all.forEach((s) => storage.set(`seen:${s.slug}`, newest(s)));
  applyFilter();
}

/* ---------- artwork and search ---------- */
function renderArtwork() {
  document.title = 'Artwork — Screening Room';
  const thumbs = library.thumbnails || [];
  view.innerHTML = refreshWarningBanner() + pageHeading('THE ART OF THE STORY', 'Beyond the frame.', `${thumbs.length} artwork${thumbs.length === 1 ? '' : 's'} from your collection. Open to explore, download to keep.`,
    '<button class="btn small" data-refresh>' + icon('refresh') + ' Refresh</button>') +
    `<p id="hits" class="search-summary" role="status" hidden></p>` +
    (thumbs.length ? `<div class="agrid">${thumbs.map((t) => {
      const label = artworkLabel(t.name);
      return `<article class="art" data-title="${esc(label.toLowerCase())}"><a class="shot" href="${esc(t.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(label)}">${picture(t.url, label)}</a><div class="art-meta"><div><span class="name">${esc(label)}</span><span class="file-info">${esc(t.name.split('.').pop().toUpperCase())} · ${fmtSize(t.size)}</span></div><a class="icon-btn dl" href="${esc(t.url)}?download=1" download="${esc(t.name)}" aria-label="Download ${esc(label)}" title="Download artwork">${icon('download')}</a></div></article>`;
    }).join('')}</div>` : emptyState('A blank canvas, for now.', 'Generated thumbnails will find their home here. Come back when your next artwork is ready.', '<a class="btn" href="#/">Back to library</a>', 'art')) +
    `<div id="noresults" hidden>${emptyState('No artwork found', 'Try a different name or clear your search to explore the full collection.', '<button class="btn" data-clear-search>Clear search</button>', 'search')}</div>`;
  applyFilter();
}
function applyFilter() {
  const q = query.trim().toLowerCase();
  document.getElementById('searchClear').hidden = !query;
  document.getElementById('searchHint').hidden = !!query;
  view.querySelectorAll('.hero, .resume, .art-preview, .empty-library').forEach((el) => { el.hidden = !!q; });
  let count = 0;
  const artwork = (location.hash || '').startsWith('#/artwork');
  if (artwork) {
    view.querySelectorAll('.art').forEach((el) => { el.hidden = !!q && !el.dataset.title.includes(q); if (!el.hidden) count++; });
  } else {
    const bare = q.replace(/^(chapter|ch)\s*/, '').trim();
    view.querySelectorAll('.block').forEach((section) => {
      const titleMatch = section.dataset.title.includes(q);
      let shown = 0;
      section.querySelectorAll('.ch').forEach((tile) => {
        const match = !q || titleMatch || (/^\d+$/.test(bare) && Number(tile.dataset.n) === Number(bare));
        tile.hidden = !match;
        if (match) shown++;
      });
      section.hidden = !shown;
      if (q) section.querySelector('.rail').scrollLeft = 0;
      count += shown;
    });
  }
  const hits = view.querySelector('#hits');
  if (hits) { hits.hidden = !q; hits.textContent = `${count} ${artwork ? 'artwork' : 'chapter'}${count === 1 ? '' : 's'} matching “${query.trim()}”`; }
  const none = view.querySelector('#noresults');
  if (none) none.hidden = !q || count > 0;
}
function clearSearch() { query = ''; find.value = ''; applyFilter(); }
find.addEventListener('input', () => {
  query = find.value;
  if (onScreen) location.hash = '#/';
  else applyFilter();
});
document.getElementById('searchClear').addEventListener('click', () => { clearSearch(); find.focus(); });

/* ---------- watch ---------- */
function renderWatch(slug, ch) {
  const series = library.series.find((s) => s.slug === slug);
  const idx = series?.chapters.findIndex((c) => c.ch === ch) ?? -1;
  if (idx < 0) {
    view.innerHTML = refreshWarningBanner() + emptyState('This chapter isn’t ready yet.', 'It may still be rendering. Head back to the library to see what’s available.', `<div class="actions"><a class="btn primary" href="#/">Back to library</a>${privileged && slug ? `<a class="btn" data-manage-series="${esc(slug)}" href="${esc(manageSeriesURL(slug))}">Manage chapters ${icon('arrow')}</a>` : ''}</div>`);
    return;
  }
  const chapter = series.chapters[idx], prev = series.chapters[idx - 1], next = series.chapters[idx + 1];
  const url = (c) => watchURL(series, c);
  const cuts = [{ name: 'Original cut', ...chapter }, ...(chapter.arms || [])];
  document.title = `Chapter ${chapter.num} — ${series.title}`;
  view.innerHTML = `${refreshWarningBanner()}<div class="watchhead"><a class="backlink" href="#/">${icon('arrow')} Back to library</a><div class="watch-title-row"><div><span class="series">${esc(series.title)}</span><h1>Chapter ${String(chapter.num).padStart(2, '0')}</h1></div><span class="wcount">${idx + 1} of ${series.chapters.length} chapters</span></div></div>
    <div class="watch-layout"><div class="watch-main"><div class="stage"><video id="player" controls playsinline preload="metadata" src="${esc(chapter.url)}" ${chapter.poster ? `poster="${esc(chapter.poster)}"` : ''} aria-label="${esc(series.title)}, chapter ${chapter.num}"></video><div class="upnext" id="upnext"></div></div>
    <div class="playback-error" id="playbackError" role="alert" hidden>We couldn’t play this video. Try loading it again.<button class="btn small" id="retryVideo">Retry</button></div>
    <div class="player-meta"><div><div class="cut-label" id="cutLabel">Original cut</div><div class="cut-detail" id="cutDetail">${fmtTime(chapter.duration)} runtime · ${fmtSize(chapter.size)}</div></div><div class="player-actions"><a class="btn" id="downloadChapter" href="${esc(chapter.url)}?download=1" download>${icon('download')} Download video</a>${privileged ? `<a class="btn" id="manageSeries" data-manage-series="${esc(series.slug)}" href="${esc(manageSeriesURL(series.slug))}">Manage chapters ${icon('arrow')}</a><button class="btn danger" id="deleteChapter" type="button" data-delete-slug="${esc(series.slug)}" data-delete-ch="${esc(chapter.ch)}" data-delete-title="${esc(series.title)}" data-delete-num="${chapter.num}" data-delete-size="${chapter.size || 0}" data-delete-arms="${(chapter.arms || []).length}">${icon('trash')} Delete video</button>` : ''}</div></div>
    ${cuts.length > 1 ? `<details class="arms"><summary>Compare cuts <span>${cuts.length} versions</span></summary><div class="arm-options" role="group" aria-label="Video cuts">${cuts.map((a, i) => `<button class="btn armbtn${i === 0 ? ' primary' : ''}" data-cut="${i}" aria-pressed="${i === 0}">${esc(a.name)}</button>`).join('')}</div></details>` : ''}
    <div class="undernav">${prev ? `<a class="btn" href="${url(prev)}">← Chapter ${prev.num}</a>` : '<span></span>'}${next ? `<a class="btn primary" href="${url(next)}">Chapter ${next.num} ${icon('arrow')}</a>` : '<a class="btn" href="#/">Back to library ' + icon('library') + '</a>'}</div>
    <p class="hints"><kbd>Space</kbd> Play / pause &nbsp; <kbd>←</kbd><kbd>→</kbd> Seek 10s &nbsp; <kbd>F</kbd> Fullscreen</p></div>
    <aside class="chapter-panel" aria-label="Chapter selection"><div class="chapter-panel-head"><h2>Chapters <span class="muted">/ ${series.chapters.length}</span></h2><p>Every part of the story, in order.</p></div><nav class="chapter-list" aria-label="Chapters in ${esc(series.title)}">${series.chapters.map((c) => {
      const current = c.ch === ch;
      return `<a class="cell${current ? ' cur' : ''}" href="${url(c)}" ${current ? 'aria-current="true"' : ''} aria-label="Chapter ${c.num}${current ? ', now playing' : ''}"><span class="cell-number">${current ? icon('play') : String(c.num).padStart(2, '0')}</span><span><span class="cell-title">Chapter ${c.num}</span><span class="cell-info" style="display:block">${current ? 'Now playing' : fmtTime(c.duration)}</span></span>${!current && isDone(series.slug, c.ch) ? icon('check') : ''}</a>`;
    }).join('')}</nav></aside></div>`;
  const video = document.getElementById('player'), upnext = document.getElementById('upnext');
  const error = document.getElementById('playbackError');
  let selected = 0, pendingSeek = null, lastSaved = 0, initialLoad = true;
  const save = () => {
    if (selected || video.ended || !video.currentTime || video.seeking) return;
    setPos(series.slug, chapter.ch, video.currentTime);
  };
  onScreen = { slug: series.slug, ch: chapter.ch, video, save, prev: prev && url(prev), next: next && url(next) };
  video.addEventListener('loadedmetadata', () => {
    error.hidden = true;
    if (pendingSeek) {
      video.currentTime = Math.min(pendingSeek.time, Math.max(0, video.duration - .5));
      if (pendingSeek.play) video.play().catch(() => {});
      pendingSeek = null;
    } else if (initialLoad) {
      const pos = getPos(series.slug, chapter.ch);
      if (pos > 5 && pos < video.duration - 8 && !isDone(series.slug, chapter.ch)) {
        video.currentTime = pos;
        showToast(`Picked up at ${fmtTime(pos)}`);
      }
    }
    initialLoad = false;
  });
  video.addEventListener('timeupdate', () => {
    if (Math.abs(video.currentTime - lastSaved) > 2) { lastSaved = video.currentTime; save(); }
  });
  video.addEventListener('pause', save);
  video.addEventListener('play', () => {
    upnext.classList.remove('show');
    if (selected === 0) storage.remove(`done:${series.slug}:${chapter.ch}`);
  });
  video.addEventListener('error', () => { error.hidden = false; });
  document.getElementById('retryVideo').addEventListener('click', () => { error.hidden = true; video.load(); video.play().catch(() => {}); });
  view.querySelectorAll('[data-cut]').forEach((button) => button.addEventListener('click', () => {
    const i = Number(button.dataset.cut);
    if (selected === i) return;
    save();
    pendingSeek = { time: pendingSeek?.time ?? video.currentTime ?? 0, play: pendingSeek?.play ?? (!video.paused && !video.ended) };
    selected = i;
    const cut = cuts[i];
    upnext.classList.remove('show');
    error.hidden = true;
    video.src = cut.url;
    video.load();
    document.getElementById('cutLabel').textContent = cut.name;
    document.getElementById('cutDetail').textContent = `${fmtTime(cut.duration)} runtime · ${fmtSize(cut.size)}`;
    document.getElementById('downloadChapter').href = cut.url + '?download=1';
    view.querySelectorAll('[data-cut]').forEach((b) => { const active = b === button; b.classList.toggle('primary', active); b.setAttribute('aria-pressed', String(active)); });
  }));
  video.addEventListener('ended', () => {
    if (selected === 0) {
      storage.set(`done:${series.slug}:${chapter.ch}`, '1');
      storage.remove(`pos:${series.slug}:${chapter.ch}`);
    }
    upnext.innerHTML = `<div><span class="eyebrow">${next ? 'THE STORY CONTINUES' : 'ALL CAUGHT UP'}</span><div class="next-title">${next ? `Up next: Chapter ${next.num}` : 'That’s a wrap. For now.'}</div><div class="actions">${next ? `<a class="btn primary" href="${url(next)}">${icon('play')} Play next chapter</a>` : '<a class="btn primary" href="#/">Back to library</a>'}<button class="btn" id="replay">${icon('refresh')} Watch again</button></div></div>`;
    upnext.classList.add('show');
    document.getElementById('replay').addEventListener('click', () => { upnext.classList.remove('show'); video.currentTime = 0; video.play().catch(() => {}); });
  });
  const current = view.querySelector('.cell.cur'), list = view.querySelector('.chapter-list');
  requestAnimationFrame(() => { list.scrollTop = current.offsetTop - list.offsetTop - 70; });
  video.play().catch(() => {});
}

/* ---------- delete a rendered chapter video ---------- */
const deleteDialog = document.getElementById('deleteDialog');
let pendingDelete = null;
let dialogSeq = 0;
let activeDialogId = 0;
let submittingDialogId = 0;
const inFlightDeletes = new Map();

function openDeleteDialog(subject) {
  if (!privileged) return;
  pendingDelete = subject;
  activeDialogId = ++dialogSeq;
  submittingDialogId = 0;
  const error = document.getElementById('deleteError');
  error.hidden = true;
  error.textContent = '';
  document.getElementById('deleteTarget').innerHTML =
    `<strong>${esc(subject.title)}</strong> — Chapter ${subject.num} <span class="muted">(${esc(subject.slug)}/${esc(subject.ch)})</span>`
    + (subject.size ? `<br><span class="muted">Rendered file · ${fmtSize(subject.size)}</span>` : '')
    + (subject.arms ? `<br><span class="muted">${subject.arms} alternate cut${subject.arms === 1 ? '' : 's'} in this chapter stay on disk.</span>` : '');
  const confirmButton = document.getElementById('deleteConfirm');
  confirmButton.disabled = false;
  confirmButton.textContent = 'Delete video';
  if (!deleteDialog.open) deleteDialog.showModal();
}

async function requestDelete(subject) {
  const res = await apiFetch('/api/library/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ slug: subject.slug, chapter: subject.ch, confirm: `${subject.slug}/${subject.ch}` }),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Could not delete this video.');
  return data;
}

function forgetChapter(slug, ch) {
  storage.remove(`pos:${slug}:${ch}`);
  storage.remove(`at:${slug}:${ch}`);
  storage.remove(`done:${slug}:${ch}`);
}

function performChapterDelete(subject) {
  const key = `${subject.slug}/${subject.ch}`;
  if (inFlightDeletes.has(key)) return inFlightDeletes.get(key);
  const task = (async () => {
    const result = await requestDelete(subject);
    forgetChapter(subject.slug, subject.ch);
    removeChapterFromLibrary(subject.slug, subject.ch);
    if (onScreen && onScreen.slug === subject.slug && onScreen.ch === subject.ch) {
      onScreen.video.pause();
      try { onScreen.video.removeAttribute('src'); onScreen.video.load(); } catch {}
      onScreen = null;
    }
    const delBtn = document.getElementById('deleteChapter');
    if (delBtn && delBtn.dataset.deleteSlug === subject.slug && delBtn.dataset.deleteCh === subject.ch) {
      delBtn.remove();
    }
    return result;
  })().finally(() => {
    inFlightDeletes.delete(key);
  });
  inFlightDeletes.set(key, task);
  return task;
}

deleteDialog.addEventListener('close', () => {
  if (deleteDialog.open) return;
  pendingDelete = null;
  activeDialogId = 0;
  submittingDialogId = 0;
  const m = (location.hash || '').match(/^#\/watch\/([^/]+)\/([^/]+)$/);
  if (m && library && !hasChapterInLibrary(decodeURIComponent(m[1]), decodeURIComponent(m[2]))) {
    location.hash = '#/';
    route(false);
  }
});
deleteDialog.addEventListener('submit', async (event) => {
  if (!event.submitter || event.submitter.value !== 'confirm') return; // cancel: let the dialog close
  event.preventDefault();
  if (!privileged || !pendingDelete || submittingDialogId === activeDialogId) return;
  const subject = pendingDelete;
  const dialogId = activeDialogId;
  submittingDialogId = dialogId;
  const error = document.getElementById('deleteError');
  const confirmButton = document.getElementById('deleteConfirm');
  error.hidden = true;
  error.textContent = '';

  if (library && !hasChapterInLibrary(subject.slug, subject.ch) && !inFlightDeletes.has(`${subject.slug}/${subject.ch}`)) {
    pendingDelete = null;
    deleteDialog.close();
    if ((location.hash || '#/') !== '#/') location.hash = '#/';
    else await route(false);
    return;
  }

  confirmButton.disabled = true;
  confirmButton.textContent = 'Deleting…';

  let result;
  try {
    result = await performChapterDelete(subject);
  } catch (err) {
    if (dialogId === activeDialogId && deleteDialog.open) {
      submittingDialogId = 0;
      error.textContent = err.message || 'Could not delete this video.';
      error.hidden = false;
      confirmButton.disabled = false;
      confirmButton.textContent = 'Delete video';
    }
    return;
  }

  const isCurrentDialog = dialogId === activeDialogId && deleteDialog.open;
  if (isCurrentDialog) {
    pendingDelete = null;
    deleteDialog.close();
  }
  const canRerender = () => {
    if (deleteDialog.open && activeDialogId > dialogId) return false;
    if (onScreen && (onScreen.slug !== subject.slug || onScreen.ch !== subject.ch)) return false;
    return true;
  };
  const deletedWatchHash = watchURL({ slug: subject.slug }, { ch: subject.ch });
  const currentHash = location.hash || '#/';
  const shouldLeaveWatch = currentHash === deletedWatchHash;

  if (canRerender() && (isCurrentDialog || shouldLeaveWatch || currentHash === '#/')) {
    if (currentHash !== '#/') location.hash = '#/';
    await route(false);
  }
  showToast(result.message || 'Rendered video deleted.');

  try {
    library = await fetchLibrary(true);
    refreshWarning = '';
    if (canRerender()) await route(false);
  } catch {
    refreshWarning = 'Video deleted. Couldn’t refresh the library from the server — showing your updated local collection.';
    if (canRerender()) await route(false);
  }
});

/* ---------- interactions and routing ---------- */
view.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-refresh')) {
    button.disabled = true;
    try { library = await fetchLibrary(true); refreshWarning = ''; await route(false); showToast('Your collection is up to date'); }
    catch { showToast('Couldn’t refresh. Please try again.'); }
    finally { button.disabled = false; }
  } else if (button.hasAttribute('data-clear-search')) { clearSearch(); find.focus(); }
  else if (button.hasAttribute('data-browse')) {
    const section = [...view.querySelectorAll('.block')].find((s) => s.dataset.series === button.dataset.browse);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section?.querySelector('.ch')?.focus({ preventScroll: true });
  } else if (button.hasAttribute('data-scroll')) {
    const rail = button.closest('.block').querySelector('.rail');
    rail.scrollBy({ left: Number(button.dataset.scroll) * rail.clientWidth * .8, behavior: 'smooth' });
  } else if (button.hasAttribute('data-delete-slug')) {
    if (!privileged) return;
    openDeleteDialog({
      slug: button.dataset.deleteSlug,
      ch: button.dataset.deleteCh,
      title: button.dataset.deleteTitle,
      num: button.dataset.deleteNum,
      size: Number(button.dataset.deleteSize) || 0,
      arms: Number(button.dataset.deleteArms) || 0,
    });
  }
});
view.addEventListener('change', (event) => {
  if (event.target.id === 'sort') { sort = event.target.value; storage.set('library-sort', sort); renderLibrary(); document.getElementById('sort')?.focus(); }
});
document.addEventListener('keydown', (e) => {
  if (deleteDialog.open) return;
  if (e.key === 'Escape' && document.activeElement === find) { clearSearch(); find.blur(); return; }
  if (e.target.closest('input, textarea, select, button, a, video, summary, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); find.focus(); return; }
  if (!onScreen) return;
  const { video, prev, next } = onScreen;
  if (e.shiftKey && e.key === 'ArrowLeft' && prev) { e.preventDefault(); location.hash = prev; }
  else if (e.shiftKey && e.key === 'ArrowRight' && next) { e.preventDefault(); location.hash = next; }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (e.key === 'ArrowLeft' ? -10 : 10)));
  } else if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); }
  else if (e.key.toLowerCase() === 'f') { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : video.requestFullscreen?.().catch(() => {}); }
});
async function route(scroll = true) {
  const version = ++routeVersion;
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/watch\/([^/]+)\/([^/]+)$/);
  const artwork = hash.replace(/\/$/, '') === '#/artwork';
  if (onScreen) { onScreen.save(); onScreen.video.pause(); onScreen = null; }
  if (hash !== lastHash && (m || artwork || lastHash.startsWith('#/artwork'))) clearSearch();
  lastHash = hash;
  document.body.classList.toggle('watching', !!m);
  document.getElementById('sectionName').textContent = m ? 'Now playing' : artwork ? 'Artwork' : 'Library';
  find.placeholder = artwork ? 'Search artwork…' : 'Search series or chapter…';
  find.setAttribute('aria-label', artwork ? 'Search artwork' : 'Search series or chapter');
  ['navHome', 'navArt'].forEach((id, i) => {
    const active = i ? artwork : !artwork;
    const el = document.getElementById(id);
    el.classList.toggle('on', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  view.setAttribute('aria-busy', 'true');
  try {
    if (!library) library = await fetchLibrary();
    if (version !== routeVersion) return;
    document.getElementById('libraryCount').textContent = library.series.length;
    if (m) renderWatch(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    else if (artwork) renderArtwork();
    else renderLibrary();
  } catch {
    if (version !== routeVersion) return;
    view.innerHTML = emptyState('We lost the connection.', 'Your collection will be here when the server is back. Give it another try.', '<button class="btn primary" data-refresh>' + icon('refresh') + ' Try again</button>', 'status');
  }
  view.setAttribute('aria-busy', 'false');
  if (scroll) window.scrollTo(0, 0);
}
async function refreshInBackground() {
  if (document.hidden || onScreen || inFlightDeletes.size) return;
  try {
    const fresh = await fetchLibrary();
    if (onScreen || inFlightDeletes.size) return;
    const hadWarning = Boolean(refreshWarning);
    refreshWarning = '';
    const shape = (data) => JSON.stringify([data?.series || [], data?.thumbnails || []]);
    if (shape(fresh) === shape(library)) {
      if (hadWarning) await route(false);
      return;
    }
    library = fresh;
    await route(false);
    showToast('Your collection has been updated');
  } catch {}
}
async function pollStatus() {
  try {
    const res = await apiFetch('/api/status', { timeoutMs: 15000 });
    if (!res.ok) return;
    const status = await res.json();
    document.getElementById('statusDot').dataset.state = status.state;
    document.getElementById('navStatus').title = `Pipeline: ${status.state.toLowerCase()}`;
  } catch {}
}
window.addEventListener('hashchange', () => route());
window.addEventListener('focus', refreshInBackground);
window.addEventListener('pagehide', () => onScreen?.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) onScreen?.save(); });
window.addEventListener('resize', () => view.querySelectorAll('.rail').forEach((r) => r.dispatchEvent(new Event('scroll'))));
setInterval(() => { if (!document.hidden) { refreshInBackground(); pollStatus(); } }, 20000);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
pollStatus();
route();
