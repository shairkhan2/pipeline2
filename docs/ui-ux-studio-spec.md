# Creative Studio UI/UX Specification & Open Component Mapping

**Target Application:** `pipeline-v2` Screening Room & Creative Studio (`src/player/public/`)  
**Architecture Reference:** `studio-improvements.md` & `docs/frontend-backend.md`  
**Frontend Stack Constraint:** Zero-build, dependency-free Vanilla ES2022 + CSS Custom Properties (`room.css`, `status.css`, `new-series.css`, and new `studio.css` / `setup.css`), served statically by Nginx with same-origin `/api/*` JSON transport (`api.js`).

---

## 1. Executive Summary & Existing Frontend Audit

### 1.1 Existing Frontend Surface (`src/player/public/`)
An inspection of the current `src/player/public/` files reveals two distinct visual themes and four pages:

| File(s) | Purpose | Current Strengths | Gaps Relative to `studio-improvements.md` |
|---|---|---|---|
| `index.html`, `app.js`, `room.css` | **Screening Room** cinema library, artwork gallery, and chapter video player | Warm dark cinema palette (`--bg: #101113`, `--panel: #191a1d`, `--accent: #f18b6e`, `Fraunces` + `DM Sans`); accessible `<dialog id="deleteDialog">`; responsive bottom nav on `<700px`; `16px` mobile inputs to prevent iOS zoom. | Hardcodes `/login` redirect on `401` with no `/setup` bootstrap detection when `.htpasswd` is uninitialized; sidebar lacks a **Studio** (`/studio.html`) navigation entry. |
| `status.html`, `status-app.js`, `status.css` | **Production Desk** live telemetry, worker cards, and inline lane policy editor | Optimistic locking (`revision`, `409` conflict resolution bar); keyboard reordering (`Alt+ArrowUp`/`Alt+ArrowDown` + `↑ Up` / `↓ Down` / `Make primary` buttons); focus restoration across 5s polls; `role="meter"` gauges and SVG sparklines. | Hardcodes only 2 model roles (`vision`, `writer`); cannot register new providers, API keys, OAuth subscriptions, or Vertex JSON; cannot add/probe/control `docker-sbx` or `ssh` render nodes. |
| `new-series.html`, `new-series.js`, `new-series.css`, `series-studio.css` | **Create a Series** 3-step intake wizard (`Source` → `Voice & style` → `Launch`) and queue | Clean dark slate/cyan studio theme (`--bg: #0b0e14`, `--panel: #11161f`, `--accent: #5eead4`); 3-step `setup-path` bar with `aria-current="step"`; generation-token voice preview (`previewGen` + `AbortController`); XHR upload progress; focus-preserving job poll. | Voice preview uses a bare native `<audio controls>` element without waveform scrubbing, rate control, or voice parameters; render lane selector filters against fixed `['inherit', 'local', 'laptop', 'cloud']`. |
| `meter.html` | **Meter Room** quota ring gauges & 30-day stacked token ledger | High-craft SVG ring gauges (`stroke-dasharray`), 30-day stacked bar chart, tabular-num breakdowns. | Tied exclusively to `/api/agy` rather than unified Creative Studio provider telemetry. |

### 1.2 License & Paywall Verification Across Reference Libraries
All components selected in this specification are **100% free and open-source** (no Pro/paywalled tiers used):

1. **AudioCN (`https://www.audiocn.dev/docs/components`)** — Open shadcn registry (`@audiocn/*`, MIT). Provides composable audio transport, canvas/bar waveforms, frequency bar visualizers, parameter sliders, decibel level meters, LCD readouts, and channel strips.
2. **Beautiful UI (`https://www.beautifului.dev/`)** — Confirmed **MIT License** (`https://www.beautifului.dev/license`, Copyright 2026 Shane Levine). All 21 AI-native interface primitives on the site are free and open.
3. **Bencho (`https://bencho.dev/`)** — Open collection of 126 live React micro-interaction blocks (`/blocks/*`) and 181 curated interaction patterns (`/finds/*`).
4. **Shoogle (`https://shoogle.dev/` & `https://mcp.shoogle.dev/mcp`)** — Queried directly via JSON-RPC `tools/call` (`search_registry_items`) to select open shadcn registry components across `@hirael`, `@uiarc`, `@elements`, `@beui`, `@easeui`, `@gridcn`, `@stealth`, `@ericts`, and `@shadcn-ui-blocks`.

Because `src/player/public/` runs without a React bundler, every selected registry component below is paired with its **exact vanilla HTML/CSS/JS implementation contract** modeled directly on the component's DOM anatomy, `data-*` state attributes, CSS custom properties, and ARIA keyboard semantics.

---

## 2. Master Component Source Catalog

### 2.1 AudioCN (`audiocn.dev`) Components Extracted
| Component | Registry / Docs Path | Key Anatomy, CSS Variables & A11y Contract | Studio Application |
|---|---|---|---|
| **Audio Player** | `@audiocn/audio-player` (`/docs/components/audio-player`) | Root state attributes: `data-playing`, `data-paused`, `data-loading`, `data-ended`, `data-error`, `data-muted`. Parts: `AudioPlayerPlay`, `AudioPlayerSeek`, `AudioPlayerTime` (`current` / `remaining`), `AudioPlayerRate` (`[0.85, 1, 1.15, 1.25]`), `AudioPlayerVolume`. Keyboard: `Space`/`K` play/pause, `←`/`→` seek 5s, `M` mute. | Inline Voice Sample Player in `new-series.html` Step 2 and `/studio.html` TTS tab. |
| **Waveform** | `@audiocn/waveform` (`/docs/components/waveform`) | Variants: `"bars" \| "mirror" \| "line"`. CSS vars: `--waveform` (unplayed), `--waveform-progress` (played), `--waveform-cursor` (playhead), `--waveform-position` (`0..1`). Interactive `role="slider"` with `aria-valuetext="0:04 of 0:12"`. | Scrubbable voice sample waveform replacing native `<audio controls>`. |
| **Bar Visualizer** | `@audiocn/bar-visualizer` (`/docs/components/bar-visualizer`) | Frequency-band bars (`barCount={5..16}`, `idle="pulse" \| "wave" \| "static"`, `mirrored`). CSS vars: `--bar-width`, `--bar-gap`, `--bar-radius`, `data-active`, `data-loading`. | Live synthesis activity indicator inside active voice cards and TTS provider test pills. |
| **Parameter Slider** | `@audiocn/parameter-slider` (`/docs/components/parameter-slider`) | Header (`Label` + `Reset` + `Input` + `Unit`) over `Control` slider + `Marks`. Sets `data-modified` when value differs from `resetValue`. Dragging the unit label scrubs value. | TTS speed/rate (`0.75x–1.50x`), pitch/stability, LLM `temperature` (`0.0–2.0`), and sandbox `idlePauseS`. |
| **Level Meter** | `@audiocn/level-meter` (`/docs/components/level-meter`) | `role="meter"` with `--meter-level` (`0..1`), `--meter-ok`, `--meter-warn`, `--meter-clip`, `data-zone="ok\|warn\|clip"`. Updates ARIA attributes at most 4 Hz; respects `prefers-reduced-motion`. | Render worker CPU / RAM / Disk / Load pressure meters and audio loudness readout. |
| **Track List** | `@audiocn/track-list` (`/docs/components/track-list`) | `TrackListItem` with `active`, `playing`, `disabled`. `TrackListItemIndex` swaps number for animated equalizer when `playing`. Arrow keys navigate rows; `TrackListItemActions` stay Tab-reachable without triggering selection. | Narrator voice catalog list in Studio TTS tab & New Series Step 2. |
| **LCD Display** | `@audiocn/lcd-display` (`/docs/components/lcd-display`) | Dot-matrix readout (`--lcd-display-ink`, `data-changed` flash on update, `LcdDisplayStatus` `data-state="idle\|busy\|off"`). | Compact telemetry readout header on Render Worker cards & Sandbox TTL countdowns. |
| **Channel Strip** | `@audiocn/channel-strip` (`/docs/components/channel-strip`) | CSS Grid areas (`header`, `meter`, `fader`, `value`, `controls`, `notice`) with container-query collapse below `36rem` and `ChannelStripStatus` (`tone="default\|live\|muted\|warning\|error"`). | Structural layout for each Stage Lane row in the Stage-to-Model Router Matrix and Render Node rows. |

### 2.2 Beautiful UI (`beautifului.dev` — MIT) Patterns Extracted
| Pattern ID & Name | Key Interaction & Visual Structure | Studio Application |
|---|---|---|
| **01 Loading State** | Pixel-grid shimmer badge with live elapsed `0.1s` counter (`Churning 1.4s`). | Live connection test pill (`/api/studio/providers/:id/test`, SSH probe, `sbx` start). |
| **04 Approval Card** | Step card with `1 / 4` progress counter, pill choices, and `Skip` / `Continue` actions. | First-Run Setup Wizard (`/setup`) step container and environment-override confirmation bar. |
| **05 Tool Chips & 06 Task Rows** | Capsule/list rows showing step name, sub-task progress, and status badge (`Running`, `Completed`, `Failed`). | Onboarding preflight checklist & `sbx` sandbox lifecycle task log. |
| **09 Recommendation Card** | Suggested configuration card with confidence badge + `Alternatives` / `Accept` buttons. | Auto-recommended `reader` (vision) + `writer` (text) model assignment after `/v1/models` discovery. |
| **13 Filter Table** | Status filter chips (`All`, `Connected`, `Cooldown`, `Needs Key`) reorganizing live rows. | Provider & Model catalog filtering in `/studio.html`. |
| **16 Flowchart** | Dotted-canvas nodes with directional connector lines (`If / Else` fallback branches). | Stage-to-Model fallback inheritance badges (`matcher ──inherits──► reader`). |
| **18 Code Block** | Line-numbered monospace surface with copy button and `Code` / `Diff` tab toggle. | SSH / `sbx` probe output viewer and `studio-audit.log` inspector. |
| **19 Fine-tune Card** | Compact property grid with scrubbable numeric inputs (`W`, `H`, `Radius`, `Opacity %`). | Per-stage `concurrency` / `temperature` and per-worker `slots` / `maxHours` / `minMemGb` inspector. |

### 2.3 Bencho (`bencho.dev`) Blocks & Finds Extracted
| Block / Find Path | Name & Interaction Mechanics | Studio Application |
|---|---|---|
| `/blocks/connect-sources` | **Connect Integrations Onboarding Card:** Grid of provider tiles; pressing one connects it, morphing its sparkline from dotted to solid while the setup progress bar climbs. | `/setup` Step 2 (Provider Quick-Connect grid) and `/studio.html` Provider Adder presets. |
| `/blocks/one-time-code` & `/finds/abhijeet-code-shimmer` | **OTP / Token Verify Input:** Single underlying input rendered as character slots so paste, autofill, and backspace work natively; wrong token shakes red, valid token sweeps a green light across slots and folds into a `Verified` pill. | `/setup` Step 1 `setupToken` verification and OAuth Device Flow 8-character `ABCD-1234` user code card. |
| `/blocks/password-strength` | **Password Strength Meter:** Password field that fills a 4-segment bar and ticks off rules as you type. | `/setup` Step 1 Admin password creation. |
| `/blocks/copy-field` | **Copy Link Field with Morphing Copy Icon:** Monospace field + copy button whose two pages merge into a self-drawing checkmark as a soft sheen passes across the text. | OAuth PKCE browser login URL, Device Flow verification URL/code, and SSH command snippet. |
| `/blocks/upload-dropzone` | **Drag and Drop File Upload:** Dashed dropzone that draws the file in on dragover, validates extension/size/JSON structure immediately, and refuses invalid files with an inline reason. | GCP Vertex AI Service Account `.json` dropzone and SSH private key uploader. |
| `/blocks/budget-slider` | **Performance Budget Bars:** Latency/throughput bars against a target budget (e.g. `<800ms` green, `800–2500ms` amber, `>2500ms` red). | Provider & Model latency/probe badges (`lastTest.latencyMs`) on Provider Cards and Router Matrix rows. |
| `/blocks/liq-arrange` | **Drag to Reorder List:** Pointer drag-to-reorder rows with smooth gap insertion and neighbouring row settle. | Stage-to-Model Router Matrix fallback chain ordering and Render Lane priority ordering. |
| `/blocks/stepper` | **Number Stepper with Drag:** Tap `-`/`+` for `±1` step, or hold-and-drag horizontally to sweep values fast. | `concurrency` (`1..4`), `slots` (`1..8`), `maxHours` (`1..24`), and `temperature` (`0.0..2.0`). |
| `/blocks/confirm` | **Inline Delete Confirmation:** Pressing `Delete` / `Remove` / `Stop` morphs the button inline into `Confirm / Cancel` pills with a 5s auto-revert. | Removing a provider, deleting an SSH key, or stopping an active `sbx` sandbox without modal fatigue. |
| `/blocks/step-player` & `/finds/jakub-step-stack` | **Step Progress Indicator:** Step pills where the active step stretches into a progress bar that fills during async work and eases to the next step. | `/setup` 4-step wizard header and `sbx` sandbox provisioning steps. |
| `/finds/disarto_max-model-router` | **Model Router:** Stage routing board with quick profile presets (`Balanced`, `Budget`, `Max Quality`) and visual fallback flow lines. | Stage-to-Model Router Matrix header presets and stage cards. |

### 2.4 Shoogle (`shoogle.dev` MCP Registry) Components Selected
| Category | Registry `addCommandArgument` | Registry | Description & Pattern Adopted |
|---|---|---|---|
| **Stepper Wizard** | `@easeui/stepper` | `@easeui` | Numbered steps joined by a line that fills as you move forward; finished steps trade their number for a check and can be clicked to go back. |
| **Stepper Transition** | `@remocn/stepper` | `@remocn` | Continuous float-progress connector fill between step circles with stroke-dash check animation. |
| **Model Selector** | `@hirael/model-selector` | `@hirael` | Searchable model picker grouped by provider, showing context window size and capability badges (`vision`, `json`, `reasoning`, `streaming`). |
| **Model Metadata** | `@elements/model-info` | `@elements` | Model metadata card displaying provider icon, context window, capability toggle badges, and pricing/cost tier. |
| **Sortable List** | `@hirael/sortable` & `@beui/sortable-stack` | `@hirael`, `@beui` | Drag-to-reorder list with drag handle, keyboard reordering (`Alt+↑/↓`), screen-reader position announcements, and inner controls that remain clickable. |
| **Stage Kanban** | `@shadcncraft/kanban-1` & `@hirael/kanban` | `@shadcncraft`, `@hirael` | Multi-stage board where each stage column/card shows active count, health status bar, and ordered model cards. |
| **Secret / Password Input** | `@uiarc/password-field` & `@uiarc/password-strength` | `@uiarc` | Masked secret input with reveal toggle, write-only hint badge (`sk-...4f2a`), and strength meter. |
| **OTP / Code Input** | `@ericts/otp-input` & `@beui/otp-input` | `@ericts`, `@beui` | Fixed-slot verification code input with paste, autofill, error shake, and staggered success wave. |
| **File Dropzone** | `@gridcn/dropzone` & `@stealth/dropzone` | `@gridcn`, `@stealth` | Dependency-free file dropzone with accept/size/schema checks that seals its dashed border on valid drop and names every rejection. |
| **Side Drawer** | `@beui/drawer` & `@uiarc/drawer` | `@beui`, `@uiarc` | Focused side panel sliding from the right edge with backdrop blur, body scroll lock, and `Esc` to close. |
| **Terminal / Log Viewer** | `@hirael/terminal` | `@hirael` | Terminal surface with title bar, status dot, and streaming monospace output lines for `sbx` / `ssh` probe logs. |
| **Pulse / Square Badges** | `@shadcn-ui-blocks/components-badges-pulse-badge` & `square-badge` | `@shadcn-ui-blocks` | Pulsing live-activity badge and sharp monospace square badge for revision/capability tags. |

---

## 3. Global Design Tokens & Navigation Integration

To unify `room.css` (warm cinema), `status.css` (production telemetry), and `new-series.css` (slate/cyan studio), `studio.css` extends `room.css` + `status.css` with shared semantic tokens:

```css
:root {
  /* Inherited base from room.css / status.css */
  --bg: #101113;
  --panel: #17181a;
  --raised: #1e2024;
  --line: #2b2c30;
  --line-strong: #3c3e44;
  --text: #f2efe9;
  --muted: #a2a19f;
  --accent: #f18b6e;
  --accent-soft: rgba(241, 139, 110, 0.14);

  /* Telemetry & Bencho budget zones */
  --green: #aed1a8;
  --green-soft: #1e281f;
  --green-border: #3d523b;
  --yellow: #d6b57b;
  --yellow-soft: #2a241b;
  --yellow-border: #605139;
  --red: #f0a096;
  --red-soft: #2e1f1e;
  --red-border: #69453e;
  --cyan: #5eead4;
  --cyan-soft: rgba(94, 234, 212, 0.11);

  /* AudioCN waveform & meter variables */
  --waveform: #3a3936;
  --waveform-progress: var(--accent);
  --waveform-cursor: #ffffff;
  --waveform-position: 0;
  --meter-ok: var(--green);
  --meter-warn: var(--yellow);
  --meter-clip: var(--red);
  --bar-width: 3px;
  --bar-gap: 2px;
  --bar-radius: 99px;
}
```

### Sidebar Navigation Update (All Pages)
Under `WORKSPACE` in `index.html`, `status.html`, `new-series.html`, and `studio.html`, add the **Creative Studio** entry (visible to all users with a `Read-only` pill for temporary accounts, full mutation controls for privileged admins):

```html
<span class="nav-caption tools-caption">WORKSPACE</span>
<a class="navitem" href="/new-series.html" id="navNewSeries">
  <svg class="icon"><use href="#i-plus"/></svg><span>New series</span>
</a>
<a class="navitem" href="/studio.html" id="navStudio">
  <svg class="icon"><use href="#i-sliders"/></svg><span>Studio</span>
  <span class="nav-badge" id="studioAlertDot" hidden></span>
</a>
<a class="navitem" href="/status.html" id="navStatus">
  <svg class="icon"><use href="#i-status"/></svg><span>Pipeline</span>
  <span class="dot" id="statusDot"></span>
</a>
<a class="navitem" href="/meter.html">
  <svg class="icon"><use href="#i-meter"/></svg><span>Meter room</span>
</a>
```

---

## 4. Detailed Feature-to-Component Specifications

---

### Feature 1: First-Run Onboarding Wizard (`/setup` -> `setup.html` + `setup.js`)

**When Triggered:**  
When `GET /api/session` or `GET /api/setup/status` reports `{ setupRequired: true }` (`!hasAnyUser(HTPASSWD) && !exists(.setup-complete)`), any page redirect (`401`) routes to `/setup` instead of `/login`. Once `.setup-complete` exists, `/setup` redirects to `/studio.html` (or `/login` if unauthenticated).

#### 1.A Component Mapping
| Sub-element | Selected Component(s) | Pattern Details |
|---|---|---|
| **4-Step Wizard Header** | `@easeui/stepper` + `@remocn/stepper` + Bencho `/blocks/step-player` | Horizontal 4-step bar (`01 Admin Account` → `02 AI Provider` → `03 Render Lanes` → `04 Launch Studio`). Completed steps swap their `01` index badge for a drawn `✓` (`stroke-dashoffset` transition) and remain clickable to revisit; active step shows a bottom fill track. |
| **Bootstrap Token Verify** | `@ericts/otp-input` + Bencho `/blocks/one-time-code` + `/finds/abhijeet-code-shimmer` | Single paste-friendly token input (`id="setupTokenInput"`) with a live `Verify token` pill button. Invalid token triggers a `300ms` horizontal shake (`@keyframes field-shake`) and red border; valid token runs a green shimmer wave and locks in a `Token verified` badge. |
| **Admin Password Field** | `@uiarc/password-field` + `@uiarc/password-strength` + Bencho `/blocks/password-strength` | Username (`default: "admin"`) + masked password input with show/hide eye button and a 4-segment strength bar (`12+ chars`, `mixed case`, `number/symbol`, `not common`). |
| **Provider Quick-Connect Grid** | Bencho `/blocks/connect-sources` + Beautiful UI `09 Recommendation Card` | 8 quick-connect preset tiles (**OpenRouter**, **OpenAI / Codex**, **Anthropic Claude**, **Google Gemini / Vertex**, **xAI Grok**, **DeepSeek**, **Ollama Local**, **Custom OpenAI URL**). Clicking a tile expands its inline credential slot below the grid. |
| **Live Test Pill & Auto-Assign** | Beautiful UI `01 Loading State` + `@shadcn-ui-blocks/components-badges-pulse-badge` | Pressing `Test & Discover Models` morphs the pill into a pulsing dot + elapsed timer (`Testing · 0.4s`). On success, displays `Connected · 240ms · 18 models` and a **Recommendation Card** pre-selecting the best `reader` (vision-capable) and `writer` models with one-click `Accept routing`. |

#### 1.B DOM & State Contract (`setup.html`)
```html
<main class="setup-shell" id="setupMain" tabindex="-1">
  <header class="setup-brand">
    <span class="brand-mark"><svg class="icon"><use href="#i-play"/></svg></span>
    <div>
      <span class="eyebrow">FIRST-RUN BOOTSTRAP</span>
      <h1>Welcome to Screening Room Studio.</h1>
    </div>
    <span class="pill" id="setupStepBadge">Step 1 of 4</span>
  </header>

  <!-- @easeui/stepper + @remocn/stepper -->
  <nav class="setup-path four-steps" aria-label="First-run setup steps">
    <button type="button" data-setup-step="0" aria-current="step">
      <span class="step-index">01</span><strong>Admin account</strong><span class="step-tick">✓</span>
    </button>
    <button type="button" data-setup-step="1" disabled>
      <span class="step-index">02</span><strong>AI provider</strong><span class="step-tick">✓</span>
    </button>
    <button type="button" data-setup-step="2" disabled>
      <span class="step-index">03</span><strong>Render lanes</strong><span class="step-tick">✓</span>
    </button>
    <button type="button" data-setup-step="3" disabled>
      <span class="step-index">04</span><strong>Launch studio</strong><span class="step-tick">✓</span>
    </button>
  </nav>

  <!-- Step 1: Bootstrap Token & Admin Account -->
  <section class="setup-step" id="setupStep0" aria-labelledby="setupHead0">
    <h2 id="setupHead0">1. Verify bootstrap token &amp; create admin</h2>
    <p class="step-desc">Paste the one-time setup token from container logs (<code>docker logs manhwa-backend</code>) or <code>MANHWA_SETUP_TOKEN</code>.</p>
    <div class="token-verify-bar" id="tokenVerifyBox" data-state="idle">
      <input id="setupToken" type="password" class="field-input mono" autocomplete="off" spellcheck="false"
             placeholder="Paste setup token…" aria-describedby="tokenVerifyHint">
      <button type="button" class="btn" id="revealSetupToken" aria-label="Show setup token">Show</button>
      <span class="pill" id="tokenStatusPill">Required</span>
    </div>
    <p id="tokenVerifyHint" class="field-hint">Writes <code>/data/auth/htpasswd</code> (mode <code>0600</code>) and signs you in.</p>

    <div class="field-row">
      <div class="field-col">
        <label class="field-label" for="adminUser">Admin username</label>
        <input id="adminUser" class="field-input mono" type="text" value="admin" autocomplete="username" required>
      </div>
      <div class="field-col">
        <label class="field-label" for="adminPass">Admin password</label>
        <div class="secret-input-wrap">
          <input id="adminPass" class="field-input" type="password" autocomplete="new-password" minlength="10" required>
          <button type="button" class="icon-btn" data-toggle-pass="adminPass" aria-label="Show password">👁</button>
        </div>
        <div class="strength-meter" id="passStrength" data-score="0" role="meter" aria-label="Password strength" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0">
          <i></i><i></i><i></i><i></i>
        </div>
      </div>
    </div>
  </section>

  <!-- Step 2: Connect First AI Provider (Bencho connect-sources grid) -->
  <section class="setup-step" id="setupStep1" aria-labelledby="setupHead1" hidden>
    <div class="step-head-row">
      <div>
        <h2 id="setupHead1">2. Connect your first AI provider</h2>
        <p class="step-desc">Connect at least one vision-capable provider for <code>reader</code> and one text provider for <code>writer</code>.</p>
      </div>
      <span class="live-test-pill" id="setupProviderTestPill" data-state="untested">Not tested</span>
    </div>
    <div class="connect-sources-grid" id="setupProviderPresets" role="radiogroup" aria-label="Choose provider preset">
      <!-- Populated with OpenRouter, OpenAI/Codex, Anthropic, Gemini, Vertex AI, xAI Grok, DeepSeek, Ollama -->
    </div>
    <div id="setupProviderFormSlot"></div>
    <!-- Beautiful UI 09 Recommendation Card: appears after /test + /models/discover -->
    <div class="recommendation-card" id="setupAutoRouteCard" hidden>
      <div class="rec-head">
        <span class="pill running">Recommended starter routing</span>
        <span class="rec-latency" id="setupProbeLatency">210 ms</span>
      </div>
      <div class="rec-body">
        <div class="rec-row"><span>Vision stages (<code>reader</code>, <code>matcher</code>, <code>scout</code>)</span><strong id="recVisionModel">—</strong></div>
        <div class="rec-row"><span>Script stages (<code>writer</code>, <code>fact_check</code>)</span><strong id="recWriterModel">—</strong></div>
      </div>
    </div>
  </section>

  <!-- Step 3: Configure Render Lanes -->
  <section class="setup-step" id="setupStep2" aria-labelledby="setupHead2" hidden>
    <!-- Local node pre-enabled + optional sbx / ssh quick-add -->
  </section>

  <!-- Step 4: Review & Launch Studio -->
  <section class="setup-step" id="setupStep3" aria-labelledby="setupHead3" hidden>
    <!-- Writes providers.json, render-nodes.json, lanes.json v2, .setup-complete -->
  </section>
</main>
```

---

### Feature 2: Model & Subscription Adder Modal + Provider Cards (`studio.html`)

Users can register, test, edit, and remove LLM & TTS providers across **4 connection modes** (`builtin-api` / `openai-compatible`, `subscription` OAuth PKCE / Device Flow / Gateways, `vertex-ai` Service Account JSON, and `local` Ollama / vLLM / LM Studio).

#### 2.A Component Mapping
| Sub-element | Selected Component(s) | Pattern Details |
|---|---|---|
| **Provider Card Grid** | Beautiful UI `13 Filter Table` + Bencho `/blocks/connect-sources` | Top filter bar (`All`, `Cloud API`, `Subscription / OAuth`, `Vertex IAM`, `Local`, `TTS`) above responsive provider cards (`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`). |
| **Bencho Latency / Probe Badge** | Bencho `/blocks/budget-slider` + `@shadcn-ui-blocks/components-badges-pulse-badge` | 5-bar micro-meter + numeric ms badge (`180 ms` green `<800ms`, `1.4 s` amber `800–2500ms`, `3.8 s` red `>2500ms`, or `Cooldown 42s`). Clicking `Probe` runs `POST /api/studio/providers/:id/test` and animates the bars. |
| **Provider Adder Modal (`<dialog>`)** | `@uiarc/drawer` / native `<dialog class="studio-modal">` + 4-Tab Mode Switcher | 4-tab connection mode header: **1. Cloud API Key**, **2. Subscription / OAuth**, **3. GCP Vertex JSON**, **4. Local Server**. |
| **Mode 1: Masked API Key Input** | `@uiarc/password-field` + Write-Only Secret Hint Badge | Input never echoes existing secrets. When `hasSecret: true`, renders a locked chip `Saved: sk-...4f2a` with a `Replace key` button. Includes optional collapsible `Custom Headers` and `Extra Body JSON` for OpenAI-compatible endpoints. |
| **Mode 2: OAuth PKCE & Device Code Card** | Bencho `/blocks/copy-field` + `/blocks/one-time-code` + Beautiful UI `01 Loading State` | - **PKCE Flow (OpenAI Codex / Claude Max):** Step A button opens auth URL + `Copy link` button (morphing copy icon); Step B input accepts pasted redirect URL or authorization code. Shows token expiry/auto-refresh badge (`Auto-refreshes · valid 54m`).<br>- **Device Code Flow (GitHub Copilot / Device Providers):** Displays large 8-char monospace code (`ABCD-1234`) with one-click copy + `Open verification page` button + live polling pill (`Waiting for browser authorization · 14s…`).<br>- **Subscription Gateways (`CLIProxyAPI`, `opencode serve`, `WorkBuddy`, `AGY`):** Gateway URL + optional bearer token + `Auto-Import Exposed Models` button. |
| **Mode 3: GCP Vertex AI JSON Dropzone** | `@gridcn/dropzone` + `@stealth/dropzone` + Bencho `/blocks/upload-dropzone` | Client-side pre-validation before upload: checks `.json` extension, `<64 KB` size, and verifies JSON keys (`"type": "service_account"`, `"project_id"`, `"client_email"`, `"private_key"`). Auto-fills `projectId` and `clientEmail` preview chip (`sa@...iam.gserviceaccount.com`), then sends `private_key` write-only to `secrets.json` while discarding raw file contents from memory. |
| **Mode 4: Local Endpoint Security Card** | Beautiful UI `04 Approval Card` | One-click port presets (`Ollama :11434`, `LM Studio :1234`, `vLLM :8000`, `llama.cpp :8080`) + explicit admin opt-in switch `allowPrivateNetwork: true` (`Allow loopback / RFC1918 requests for this local provider`). |
| **Model Capability Toggles** | `@elements/model-info` + `@hirael/model-selector` | Each discovered or manually added model row inside a provider card displays interactive toggle pills: `vision` (eye icon), `json` (braces icon), `reasoning` (spark/brain icon + effort dropdown `low\|medium\|high`), `streaming` (wave icon), plus editable `contextWindow` (`128k`) and `maxOutputTokens` (`8k`). |

#### 2.B Provider Card & Adder Modal DOM Blueprint
```html
<!-- Provider Card (rendered in #providerGrid) -->
<article class="provider-card" data-provider-id="openrouter-main" data-kind="builtin-api" data-health="ok">
  <div class="provider-card-head">
    <span class="provider-monogram" aria-hidden="true">OR</span>
    <div class="provider-title-wrap">
      <h3>OpenRouter <code class="lane-id">openrouter-main</code></h3>
      <p class="provider-endpoint mono">https://openrouter.ai/api/v1</p>
    </div>
    <!-- Bencho budget-slider style latency + health badge -->
    <div class="probe-badge ok" title="Last tested 2m ago · HTTP 200">
      <span class="latency-bars" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span>
      <span class="mono">310 ms</span>
    </div>
  </div>

  <div class="provider-auth-row">
    <span class="secret-hint-chip" data-has-secret="true">
      <svg class="icon"><use href="#i-check"/></svg> Key stored · <code>sk-or-...9a1c</code>
    </span>
    <span class="provider-model-count">6 models enabled</span>
  </div>

  <!-- Capability-badged model chips (@elements/model-info pattern) -->
  <ul class="provider-models-list" aria-label="Models in OpenRouter">
    <li class="provider-model-item">
      <strong class="mono">google/gemini-2.5-flash</strong>
      <div class="cap-badges" role="group" aria-label="Capabilities for gemini-2.5-flash">
        <button type="button" class="cap-pill on" data-cap="vision" aria-pressed="true" title="Vision input supported">Vision</button>
        <button type="button" class="cap-pill on" data-cap="json" aria-pressed="true" title="Structured JSON output">JSON</button>
        <button type="button" class="cap-pill" data-cap="reasoning" aria-pressed="false" title="Reasoning / thinking mode">Thinking</button>
        <span class="cap-meta mono">1M ctx</span>
      </div>
    </li>
  </ul>

  <div class="provider-card-actions">
    <button type="button" class="btn small" data-provider-action="test" data-id="openrouter-main">Test connection</button>
    <button type="button" class="btn small" data-provider-action="discover" data-id="openrouter-main">Discover models</button>
    <button type="button" class="btn small" data-provider-action="edit" data-id="openrouter-main">Edit</button>
    <!-- Bencho /blocks/confirm inline delete pattern -->
    <button type="button" class="btn small quiet danger-text" data-provider-action="delete" data-id="openrouter-main">Remove</button>
  </div>
</article>
```

---

### Feature 3: Stage-to-Model Router Matrix (`studio.html` & `status.html`)

Replaces the legacy 2-role (`vision` / `writer`) editor with a **6-stage routing matrix**:
1. **`reader`** — Panel vision extraction (`reader.ts`) — **Capability Gate:** requires `vision: true`
2. **`matcher`** — Visual contact-sheet & semantic panel matching (`visualMatcher.ts`, `writer.ts`) — **Capability Gate:** requires `vision: true` (Defaults to *Inherit from `reader`* toggle)
3. **`writer`** — Chapter recap & story script generation (`writer.ts`, `storyWriter.ts`) — **Capability Gate:** text (`vision` optional)
4. **`scout`** — Promo / watermark / credit page detection (`scout.ts`, `cleaner.ts`) — **Capability Gate:** requires `vision: true` (Defaults to *Inherit from `reader`* toggle)
5. **`fact_check`** — Deterministic rules + optional LLM continuity verifier (`factCheck.ts`) — **Mode Toggle:** `Deterministic only (free)` vs `Deterministic + LLM Verify pass`
6. **`tts`** — Voice narration engine (`edge`, `elevenlabs`, `openai-tts`, `custom`) — **Capability Gate:** `audio-tts`

#### 3.A Component Mapping
| Sub-element | Selected Component(s) | Pattern Details |
|---|---|---|
| **Router Matrix Board** | `@shadcncraft/kanban-1` + `@hirael/kanban` + Bencho `/finds/disarto_max-model-router` | 6-card responsive grid (`grid-template-columns: repeat(auto-fit, minmax(340px, 1fr))`), plus a top bar with **Paid-Cache Safe Banner** (`Routing changes apply to new calls and never invalidate paid chapter caches`) and quick routing presets (`Inherit Vision Secondary Stages`, `Reset to Defaults`). |
| **Stage Inheritance Switch (`matcher`, `scout`)** | Beautiful UI `16 Flowchart` connector chip + `@audiocn/channel-strip` header | `matcher` and `scout` headers include an `Inherit from reader` pill toggle. When enabled, the stage card shows a compact flowchart connector badge (`──► Uses reader chain (3 models)`) instead of a duplicate list; toggling off clones `reader`'s current list for independent customization. |
| **Ordered Fallback Lane List** | `@hirael/sortable` + `@beui/sortable-stack` + Bencho `/blocks/liq-arrange` | Each model row in a stage chain has:<br>- **Drag Handle (`⋮⋮`)** supporting HTML5/Pointer drag-and-drop reorder.<br>- **Rank Badge:** `Primary` (accent) → `Fallback 1` → `Fallback 2` → `Off` (dashed).<br>- **Keyboard Reorder:** `Alt+ArrowUp` / `Alt+ArrowDown` on any focused control inside the row, plus accessible `↑` / `↓` / `1st` buttons with automatic focus retention (preserving `status-app.js:772` `focusMovedModelButton` behavior). |
| **Concurrency & Temperature Steppers** | Bencho `/blocks/stepper` + `@audiocn/parameter-slider` | Each model row has a compact drag-stepper for `concurrency` (`1×..4×`), and each stage header has a stage-level `temp` parameter chip (`0.2` for `reader`/`matcher`, `0.6` for `writer`). |
| **Capability Gate Combobox** | `@hirael/model-selector` + `@beui/combobox` | The `+ Add model to <stage>` picker automatically filters registered provider models by the stage's capability gate (e.g., models with `vision: false` are shown disabled under `Incompatible (requires vision)` in `reader`, `matcher`, and `scout`). |

#### 3.B Stage Card DOM Blueprint
```html
<section class="stage-router-card" data-stage="matcher" aria-labelledby="stageHead-matcher">
  <header class="stage-router-head">
    <div>
      <div class="stage-title-line">
        <h3 id="stageHead-matcher">Matcher <code class="lane-id">matcher</code></h3>
        <span class="cap-gate-badge" title="Requires vision capability">Vision required</span>
      </div>
      <p class="stage-purpose">Visual contact-sheet &amp; semantic panel matching (<code>visualMatcher.ts</code>)</p>
    </div>
    <label class="inherit-toggle" title="Use the same model chain as reader">
      <input type="checkbox" data-stage-inherit="matcher" data-inherit-from="reader" checked>
      <span>Inherit <code>reader</code></span>
    </label>
  </header>

  <!-- Shown when Inherit is ON (Beautiful UI 16 Flowchart connector style) -->
  <div class="stage-inherited-view" id="stageInherited-matcher">
    <span class="flow-arrow" aria-hidden="true">↳</span>
    <span>Follows <strong>Reader</strong> chain (<span data-reader-summary>gemini-2.5-flash + 2 fallbacks</span>)</span>
    <button type="button" class="btn small" data-action="customize-stage" data-stage="matcher">Customize</button>
  </div>

  <!-- Shown when Inherit is OFF (@hirael/sortable + Bencho stepper) -->
  <div class="stage-custom-view" id="stageCustom-matcher" hidden>
    <div class="lane-editor-list sortable-stage-list" role="list" data-stage-list="matcher">
      <div class="lane-edit-row" role="listitem" draggable="true" data-stage="matcher" data-model-lane="openrouter:gemini-2.5-flash" data-index="0">
        <button type="button" class="drag-handle" aria-label="Drag to reorder" tabindex="-1">⋮⋮</button>
        <span class="lane-rank-badge primary" data-lane-rank>Primary</span>
        <div class="lane-edit-copy">
          <strong>OpenRouter / gemini-2.5-flash <code class="lane-id">openrouter:gemini-2.5-flash</code></strong>
          <span class="lane-desc">Vision · JSON · 310 ms</span>
        </div>
        <div class="lane-edit-controls">
          <label class="lane-toggle">
            <input type="checkbox" data-stage-enable="openrouter:gemini-2.5-flash" data-stage="matcher" checked>
            <span>On</span>
          </label>
          <!-- Bencho /blocks/stepper -->
          <div class="drag-stepper" role="group" aria-label="Concurrency">
            <button type="button" class="step-dec" data-step-delta="-1" aria-label="Decrease concurrency">−</button>
            <input type="number" class="lane-num-input" data-stage-concurrency="openrouter:gemini-2.5-flash" data-stage="matcher" min="1" max="4" value="2">
            <button type="button" class="step-inc" data-step-delta="1" aria-label="Increase concurrency">+</button>
          </div>
          <div class="lane-move-group" role="group" aria-label="Reorder model">
            <button type="button" class="btn small lane-move-btn" data-stage-move="up">↑</button>
            <button type="button" class="btn small lane-move-btn" data-stage-move="down">↓</button>
            <button type="button" class="btn small lane-move-btn" data-stage-move="primary">1st</button>
            <button type="button" class="btn small lane-move-btn danger" data-stage-remove="openrouter:gemini-2.5-flash">×</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
```

---

### Feature 4: AudioCN-Inspired TTS & Voice Preview Bar (`new-series.html` & `studio.html`)

Upgrades the inline voice preview in `new-series.html` (Step 2: `Voice & style`) and powers the dedicated **TTS & Voices** tab in `studio.html`.

#### 4.A Component Mapping
| Sub-element | Selected Component(s) | Pattern Details |
|---|---|---|
| **Composable Transport Bar** | `@audiocn/audio-player` (`/docs/components/audio-player`) | Root `.audiocn-player` container carrying `data-playing`, `data-paused`, `data-loading`, `data-ended`, `data-error`, `data-muted` attributes. Includes Play/Pause button (with loading spinner when synthesizing), current time (`0:03`), remaining time (`-0:08`), playback rate pill (`0.9×`, `1.0×`, `1.1×`, `1.25×`), and mute toggle. |
| **Interactive Waveform Scrubber** | `@audiocn/waveform` (`/docs/components/waveform`) | 48-bar mirrored SVG/Canvas waveform (`variant="mirror"`) with `--waveform-position` (`0..1`) driven by `requestAnimationFrame` while playing and `timeupdate` when paused. Acts as an accessible `role="slider"` (`aria-label="Seek voice sample"`, `aria-valuemin="0"`, `aria-valuemax="12"`, `aria-valuenow="4"`, `aria-valuetext="0:04 of 0:12"`). Decodes actual audio peaks via Web Audio API `OfflineAudioContext` / `decodeAudioData` (falling back to a deterministic 48-bar speech envelope if `decodeAudioData` is unavailable). |
| **Voice Selector Cards with Live Equalizer** | `@audiocn/track-list` + `@audiocn/bar-visualizer` | In `#voiceCards`, each `.voice-choice` card embeds a 4-bar `@audiocn/bar-visualizer` inside `.voice-avatar` that animates when that voice sample is actively playing (`data-active`). |
| **TTS Parameter Sliders (Studio TTS Tab)** | `@audiocn/parameter-slider` | Labelled slider + numeric readout + reset button (`data-modified`) for **Speaking Rate** (`0.75×` to `1.50×`, default `1.00×`) and **Custom Preview Line** (editable sample text with reset to the default manhwa narration benchmark sentence). |

#### 4.B AudioCN Voice Preview Bar DOM & CSS Blueprint
```html
<!-- Upgraded #previewCard in new-series.html & studio.html -->
<div class="voice-preview audiocn-player" id="previewCard" data-paused>
  <div class="voice-preview-bar">
    <div class="voice-preview-head">
      <div class="audiocn-visualizer" id="previewMiniVis" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i>
      </div>
      <div class="voice-preview-copy">
        <strong id="previewVoiceTitle">Sample</strong>
        <span id="previewSelection">Select a provider and voice</span>
      </div>
    </div>

    <div class="voice-preview-actions">
      <!-- @audiocn/audio-player Play / Stop / Rate controls -->
      <button type="button" class="btn small primary audiocn-play-btn" id="previewListen">
        <svg class="icon"><use href="#i-play"/></svg>
        <span id="previewListenText">Listen sample</span>
      </button>
      <button type="button" class="btn small" id="previewStop" hidden>
        <svg class="icon"><use href="#i-stop"/></svg><span>Stop</span>
      </button>
      <button type="button" class="btn small mono audiocn-rate-btn" id="previewRateBtn" title="Cycle playback rate" aria-label="Playback speed 1x">1.0×</button>
      <button type="button" class="btn small" id="previewRetry" hidden>Retry</button>
    </div>
  </div>

  <!-- @audiocn/waveform interactive seek bar -->
  <div class="audiocn-waveform-row" id="previewWaveformWrap">
    <span class="audiocn-time mono" id="previewTimeCurrent">0:00</span>
    <div class="audiocn-waveform" id="previewWaveform" role="slider" tabindex="0"
         aria-label="Voice sample position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0:00 of 0:00"
         style="--waveform-position: 0">
      <div class="audiocn-waveform-bars" id="previewWaveformBars" aria-hidden="true">
        <!-- 48 mirrored peak bars; bars before --waveform-position take var(--waveform-progress) -->
      </div>
      <div class="audiocn-waveform-cursor" aria-hidden="true"></div>
      <span class="audiocn-waveform-hover mono" id="previewWaveformHover" hidden>0:00</span>
    </div>
    <span class="audiocn-time mono" id="previewTimeRemaining">−0:00</span>
  </div>

  <span id="previewStatus" class="voice-preview-status" role="status" aria-live="polite"></span>
  <p id="previewError" class="field-error voice-preview-error" role="alert" hidden></p>
  <!-- Underlying HTMLAudioElement remains in DOM for backward compatibility with existing tests -->
  <audio id="previewAudio" class="voice-preview-audio sr-only" preload="none" hidden></audio>
</div>
```

```css
/* AudioCN Waveform & Bar Visualizer Vanilla CSS */
.audiocn-waveform-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 42px;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.audiocn-waveform {
  position: relative;
  height: 38px;
  border-radius: 6px;
  background: #090d14;
  border: 1px solid var(--line);
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.audiocn-waveform-bars {
  display: grid;
  grid-template-columns: repeat(48, 1fr);
  align-items: center;
  gap: var(--bar-gap, 2px);
  height: 100%;
}
.audiocn-waveform-bars i {
  display: block;
  width: 100%;
  height: calc(var(--peak, 0.25) * 100%);
  min-height: 3px;
  border-radius: var(--bar-radius, 99px);
  background: var(--waveform, #334155);
  transition: background-color 0.08s, transform 0.12s;
}
.audiocn-waveform-bars i.is-played {
  background: var(--waveform-progress, var(--accent));
}
.audiocn-waveform-cursor {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: calc(8px + (100% - 16px) * var(--waveform-position, 0));
  width: 2px;
  background: var(--waveform-cursor, #fff);
  border-radius: 1px;
  pointer-events: none;
  opacity: 0;
}
.audiocn-player[data-playing] .audiocn-waveform-cursor,
.audiocn-waveform:hover .audiocn-waveform-cursor {
  opacity: 1;
}
```

---

### Feature 5: Renderlane & Worker Adder (`Local`, `Docker Cloud Sandbox sbx`, `Remote SSH`)

Replaces the fixed `local | laptop | cloud` singleton assumption with a dynamic **Render Node Registry UI** in `studio.html` and `status.html` (backed by `out/config/render-nodes.json` and `out/lanes.json`).

#### 5.A Component Mapping
| Sub-element | Selected Component(s) | Pattern Details |
|---|---|---|
| **Worker Node Cards with Live Resource Meters** | `@audiocn/level-meter` + `@audiocn/lcd-display` + `status.css` `.worker-card` | Each registered render node (`local`, `docker-sbx`, `ssh`) renders a card with:<br>- **Header:** Node icon (`monitor` for local, `cloud` for `docker-sbx`, `network` for `ssh`), label, monospace `id` badge, and live status pill (`Ready`, `Busy`, `Paused`, `Offline`, `Probing…`).<br>- **AudioCN Level Meters:** 3 horizontal zone meters (`role="meter"`, `data-zone="ok\|warn\|clip"`) for **CPU / Load**, **RAM Free**, and **Disk Free** (or **TTL Budget Used** on `docker-sbx`).<br>- **LCD Telemetry Strip:** Monospace dot-matrix readout showing `SLOTS 1/2 · CLEANER ON · PROBE 42ms`. |
| **Docker Cloud Sandbox (`sbx`) Control & Adder Drawer** | `@beui/drawer` / `@uiarc/drawer` + `@hirael/terminal` + Bencho `/blocks/confirm` | - **Card Actions:** `Probe`, `Start`, `Stop` (inline confirm), and `Configure` (opens right-side drawer).<br>- **Drawer Fields:** `id`, `label`, `box` (validated against `^[a-z0-9][a-z0-9-]{2,62}$`), `template` (`manhwa-render-arm`), `slots` (`1..2` stepper), `maxHours` TTL budget (`1..12h`), `idlePauseS` (`300s` parameter slider).<br>- **Create Sandbox Action:** Enabled when server reports `capabilities.sandboxControl === true` (`MANHWA_ALLOW_SANDBOX_CONTROL=1`); streams `sbx` creation & probe logs into a `@hirael/terminal` log box inside the drawer. |
| **Remote SSH Worker Adder & Probe Card** | `@gridcn/dropzone` + Beautiful UI `18 Code Block` + `@audiocn/parameter-slider` | - **Fields:** `id`, `label`, `host` (strict regex `^[A-Za-z0-9._-]+$`, rejecting leading `-`), `user`, `port` (`22`), `remoteDir`, `slots` (`1..4`), `supportsCleaner` checkbox, and health thresholds (`maxLoadFactor`, `minMemGb`, `minDiskGb`).<br>- **SSH Private Key Upload:** Drag-and-drop or paste private key (`id_ed25519`); stored write-only in `secrets.json` (`0600`) and displayed afterwards only as `Key stored · SHA256:...8f1a`.<br>- **Live SSH Probe Card:** `Test SSH Probe` button runs `POST /api/studio/render-nodes/:id/probe` (strict `argv`-only SSH check for `ffmpeg`, `node`, `python3`, disk free, RAM free) and renders a 4-item preflight checklist (`SSH Auth ✓`, `FFmpeg ✓`, `Remotion Bundle ✓`, `Free Disk 48.2 GB ✓`). |
| **Per-Run Render Lane Selector (`new-series.html`)** | Dynamic `<select id="renderLane">` | Dynamically populated from `catalog.renderLanes` (all enabled nodes in `render-nodes.json` + `inherit` Auto) instead of filtering against a hardcoded 4-element array. |

#### 5.B Render Node Card & `sbx` / `ssh` Drawer DOM Blueprint
```html
<!-- Render Worker Card with AudioCN LevelMeters & Sandbox Controls -->
<article class="worker-card studio-node-card" data-worker="sbx-arm-1" data-kind="docker-sbx">
  <div class="worker-head">
    <span class="worker-icon"><svg class="icon"><use href="#i-cloud"/></svg></span>
    <div>
      <h3>Cloud Render ARM #1 <code class="lane-id">sbx-arm-1</code></h3>
      <p>Docker Cloud Sandbox · box <code>manhwa-box-01</code> · 2 slots</p>
    </div>
    <span class="pill paused">Paused (0$/hr)</span>
  </div>

  <!-- @audiocn/lcd-display status row -->
  <div class="lcd-strip" data-state="idle">
    <span>TEMPLATE <b>manhwa-render-arm</b></span>
    <span>TTL <b>0.4 / 4.0h</b></span>
    <span>IDLE PAUSE <b>300s</b></span>
  </div>

  <!-- @audiocn/level-meter resource bars -->
  <div class="node-meters">
    <div class="node-meter-row">
      <span class="node-meter-label">CPU LOAD</span>
      <div class="audiocn-meter" role="meter" aria-label="CPU load" aria-valuemin="0" aria-valuemax="100" aria-valuenow="18" data-zone="ok" style="--meter-level: 0.18">
        <i class="meter-fill"></i>
      </div>
      <span class="node-meter-val mono">18%</span>
    </div>
    <div class="node-meter-row">
      <span class="node-meter-label">RAM FREE</span>
      <div class="audiocn-meter" role="meter" aria-label="Memory available" aria-valuemin="0" aria-valuemax="16" aria-valuenow="12.4" data-zone="ok" style="--meter-level: 0.77">
        <i class="meter-fill"></i>
      </div>
      <span class="node-meter-val mono">12.4 GB</span>
    </div>
  </div>

  <div class="worker-card-actions">
    <button type="button" class="btn small" data-node-action="probe" data-id="sbx-arm-1">Test probe</button>
    <button type="button" class="btn small primary" data-node-action="start" data-id="sbx-arm-1">Start sandbox</button>
    <button type="button" class="btn small" data-node-action="stop" data-id="sbx-arm-1" disabled>Stop</button>
    <button type="button" class="btn small" data-node-action="edit" data-id="sbx-arm-1">Configure</button>
  </div>
</article>
```

---

## 5. Security, Accessibility & Resilience Guardrails in UI Code

Every component in `setup.html`, `studio.html`, `status.html`, and `new-series.html` must enforce these invariants:

1. **Zero Secret Echo in DOM or Storage:**
   - Secret fields (`apiKey`, `accessToken`, `refreshToken`, `serviceAccountJson`, `sshPrivateKey`, `setupToken`) are never saved to `localStorage` or `sessionStorage`.
   - Once saved, inputs clear their `.value = ''` immediately and render a read-only `.secret-hint-chip` (`{ hasSecret: true, hint: "sk-...4f2a" }`).
2. **Strict Client + Server Regex Validation for `sbx` & `ssh`:**
   - Sandbox `box` name input enforces `pattern="^[a-z0-9][a-z0-9-]{2,62}$"`.
   - SSH `host` and `user` inputs enforce `pattern="^[A-Za-z0-9._-]+$"` (explicitly blocking leading `-` or whitespace to prevent `ProxyCommand` / option injection).
3. **SSRF Guard Transparency:**
   - Remote provider URLs (`builtin-api`, `openai-compatible`, `subscription`) must begin with `https://` (or `http://` only when explicitly marked `kind: "local"` with admin `allowPrivateNetwork: true` enabled).
4. **CSRF + Optimistic Locking (`revision`) on All Studio Mutations:**
   - Every `POST`, `PUT`, and `DELETE` to `/api/studio/*` and `/api/lanes` sends `X-CSRF-Token: csrfToken` and `{ revision: draftBaseRevision }`.
   - On `HTTP 409`, the UI preserves the user's unsaved form state and displays the `.lane-conflict-bar` (`Review & keep draft` vs `Reload server settings`) already proven in `status-app.js`.
5. **Focus & Polling Hygiene + Mobile Touch Targets:**
   - Background status/queue polling never overwrites open modals, drawers, or dirty draft editors (`draftDirty === true`).
   - All interactive controls maintain `min-height: 44px` and `font-size: 16px` on `<700px` viewports so iOS Safari never auto-zooms on focus.
   - All animations (`@audiocn/bar-visualizer`, `@audiocn/waveform`, shimmer pills) stop or switch to static 4 Hz updates under `@media (prefers-reduced-motion: reduce)`.
