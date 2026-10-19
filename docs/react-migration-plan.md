# Full React + TypeScript Frontend Migration Plan (`frontend/`)

## 1. Goal: Zero Legacy Hybrid Debt
Migrate the **entire** player & studio frontend from scattered vanilla HTML/CSS/JS files (`index.html`, `app.js`, `status.html`, `status-app.js`, `new-series.html`, `new-series.js`, `meter.html`) into a single, unified **React 19 + TypeScript + Tailwind CSS v4 + `motion/react` + Verbatim Registry Components (`AudioCN`, `Shoogle`, `Bencho`, `Beautiful UI`)** application in `frontend/`.

### Backup & Rollback Safety
- Full snapshot of the legacy vanilla frontend is preserved at **`backups/player-public-vanilla/`**.
- Static PWA / compatibility assets (`sw.js`, `manifest.webmanifest`, `icons/`, `previews/`) live in `frontend/public/` and copy cleanly into the build output (`src/player/public/`).

---

## 2. Unified Application Architecture (`frontend/src/`)

```text
frontend/
├── package.json
├── tsconfig.json
├── vite.config.ts               # Emits production bundle to ../src/player/public
├── public/                      # sw.js, manifest.webmanifest, icons/, previews/
└── src/
    ├── index.css                # Tailwind v4 + Cinema/Studio CSS tokens + AudioCN variables
    ├── main.tsx                 # Unified entrypoint & route dispatcher
    ├── lib/
    │   ├── utils.ts             # cn() helper
    │   ├── api.ts               # Typed API client (/api/session, /api/library, /api/status, /api/lanes, /api/intake/*, /api/studio/*, /api/setup/*, /api/agy)
    │   └── driveUrl.ts          # Google Drive URL / file ID parser (100% parity with backend intake.parseGdriveUrl)
    ├── components/
    │   ├── ui/                  # Verbatim .tsx components from AudioCN, Hirael, Cult-UI, Glint-UI, UIArc, EaseUI
    │   │   ├── audio-player.tsx
    │   │   ├── waveform.tsx
    │   │   ├── level-meter.tsx
    │   │   ├── lcd-display.tsx
    │   │   ├── bar-visualizer.tsx
    │   │   ├── parameter-slider.tsx
    │   │   ├── track-list.tsx
    │   │   ├── channel-strip.tsx
    │   │   ├── animated-tabs.tsx
    │   │   ├── halo-tabs.tsx
    │   │   ├── model-selector.tsx
    │   │   ├── sortable.tsx
    │   │   ├── stepper.tsx
    │   │   ├── terminal.tsx
    │   │   └── ...
    │   └── layout/
    │       └── AppShell.tsx     # Single unified Sidebar + Mobile Navigation + Live Status Dot + Setup Redirect Guard
    └── pages/
        ├── LibraryPage.tsx      # Screening Room: Series Grid, Series Detail, Video Player (with shortcuts, rate, resume, delete dialog), Artwork Gallery
        ├── NewSeriesPage.tsx    # Create a Series: 3-Step Wizard (Drive/ZIP Upload -> AudioCN Waveform Voice Preview -> Dynamic Render Lane Launch) + Jobs Queue
        ├── StudioPage.tsx       # Creative Studio: Provider/Subscription/Vertex/Local Adder, 6-Stage Sortable Router, Render Node (sbx/SSH) Adder + Terminal Drawer, TTS Studio
        ├── StatusPage.tsx       # Production Desk: Zero-flicker 5s live telemetry, AudioCN LevelMeter + LcdDisplay worker cards, Chapter stage matrix, Lane policy editor
        ├── MeterPage.tsx        # Meter Room: Provider & rotator quota ring gauges + 30-day token usage stacked bar chart
        └── SetupPage.tsx        # First-Run Onboarding: 4-Step Bootstrap Wizard (Token Shimmer, Admin Password Strength, Provider Quick-Connect, Render Lane Check)
```

---

## 3. Route & URL Parity Contract

To ensure bookmarks, Nginx proxy rules, Service Worker caching, and existing integration tests (`tools/smoke-images.ts`, `tests/player-http.test.ts`, `tests/deep-api-cloud.test.ts`) continue to work seamlessly:
- `/` and `/index.html` (`#/` / `#/series/:slug` / `#/watch/:slug/:ch` / `#/artwork`) -> **`LibraryPage`**
- `/new-series.html` and `/#/new-series` -> **`NewSeriesPage`**
- `/studio.html`, `/studio`, and `/#/studio` -> **`StudioPage`**
- `/status.html` and `/#/status` -> **`StatusPage`**
- `/meter.html` and `/#/meter` -> **`MeterPage`**
- `/setup`, `/setup.html`, and `/#/setup` -> **`SetupPage`**

---

## 4. Execution Phases & Model Assignments

1. **Batch 1 (`google-vertex/gemini-4-argon#high` — In Progress):**
   - Scaffold `frontend/` + install dependencies + pull verbatim `.tsx` registry components into `frontend/src/components/ui/` and verify `tsc --noEmit`.
2. **Batch 2A (`google-vertex/gemini-4-argon#high`):**
   - Build `frontend/src/lib/{api,driveUrl}.ts`, `frontend/src/components/layout/AppShell.tsx`, `StudioPage.tsx`, and `SetupPage.tsx` using the verbatim registry components.
3. **Batch 2B (`google-vertex/gemini-4-argon#high`):**
   - Migrate `LibraryPage.tsx` (Series Grid, Video Player, Delete Dialog, Artwork), `NewSeriesPage.tsx` (3-step wizard + AudioCN Waveform preview + Jobs queue), `StatusPage.tsx` (Live telemetry + AudioCN LevelMeter/LcdDisplay worker cards + Lane editor), and `MeterPage.tsx` into React, wire multi-page Vite output + `docker/frontend/Dockerfile`.
4. **Batch 3 (`xai/grok-4.7#xhigh` Reviewer):**
   - Full UI/UX, anti-slop, accessibility, and integration audit across all 6 React pages + container smoke test (`CONTAINER_ENGINE=podman npm run test:images`).
