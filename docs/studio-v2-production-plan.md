# Studio V2 Native Production Plan (10 Features)

## 1. Translation vs. Native TypeScript/React Adaptation

| Layer | Status | Architecture |
|---|---|---|
| **Frontend (`frontend/`)** | **100% Native React 19 + TypeScript** | Vite 6, Tailwind v4, `motion/react`, `@base-ui/react`, `@dnd-kit`, and 65 verbatim registry `.tsx` files (`AudioCN`, `Hirael`, `Cult-UI`, `Glint-UI`, `UIArc`, `GridCN`). Zero legacy DOM `innerHTML` scripts in the active UI. |
| **Control Plane, Vault, Auth, Studio & Nodes (`src/config/*`, `src/player/*`, `src/workers/nodeRegistry.ts`)** | **100% Native Node/TypeScript** | AES-256-GCM `0o600` secret vault, multi-instance `createCloudNode` / `createSshNode` factories, in-process intake reconciliation, native RS256 JWT signer, and SSRF guardrails. |
| **Core Pipeline Stages (`src/stages/*`, `src/contracts/*`)** | **Hybrid by Design (Cache-Hash Compatible + Native Extensions)** | Preserves exact v1 hash serialization (`briefHash`, `schemaHash`, `pagesHash`, `narrationCacheKey`, `promoCacheHash`) so existing v1/v2 series caches never re-bill, while adding native TypeScript capabilities (dynamic stage prompts, 720p/1080p render scaling, character-panel outro generator, `/tmp` trash recovery, and live job pause/resume). |

---

## 2. The 10 New Production Features

1. **Multi-Model Subscription Routing (`src/config/studioConfig.ts`, `src/llm/client.ts`, `StudioPage.tsx`)**
   - A single subscription provider (`codex-oauth`, `claude-oauth`, `github-copilot`, `subscription-bridge`) exposes multiple models across roles (`vision`, `writer`, `reasoning`, `tts`, `image`) with per-model `reasoningEffort` (`low | medium | high | xhigh`) so one subscription can power `reader`, `matcher`, `writer`, and `scout` simultaneously with different models.
2. **GCP Vertex AI Dual Sign-In + Multi-Modal Catalog (`src/config/studioConfig.ts`, `src/player/studio.ts`, `StudioPage.tsx`)**
   - **Mode A — Service Account JSON:** Drag-and-drop/paste `.json` key (`RS256` JWT token exchange).
   - **Mode B — Google OAuth URL + Project ID & Region:** Click OAuth URL -> sign in -> paste authorization code or access/refresh token + enter `projectId` and `location` (`global`, `us-central1`, etc.).
   - **Multi-Modal Vertex Models:** Pre-populated & discoverable Gemini Vision/Writer (`gemini-2.5-pro`, `gemini-2.5-flash`), Imagen (`imagen-3.0-generate-002` `image`), and Cloud TTS (`chirp-3-hd` `tts`).
3. **Interactive Storage Inspector & `/tmp` Reboot-Safe Trash (`src/player/storageTrash.ts`, `src/player/libraryDelete.ts`, `StudioPage.tsx`, `LibraryPage.tsx`)**
   - Clicking storage usage opens a full breakdown by Series, Chapters, Videos, Audio, Panels, and Caches.
   - Deleting any video or artifact moves it to `/tmp/opencode/manhwa-trash/<trashId>/` with a `manifest.json` instead of permanent deletion.
   - Users can **Restore** any deleted item in one click until device reboot (or click **Empty Trash** to purge permanently).
4. **Live Job & Render Lane Pause / Resume / Stop (`src/intake/intake.ts`, `src/player/jobs.ts`, `src/player/studio.ts`, `StatusPage.tsx`, `NewSeriesPage.tsx`)**
   - Running jobs support **Pause** (`SIGSTOP` to active worker process + `status: "paused"`), **Resume** (`SIGCONT` + `status: "running"`), and **Stop** (`SIGTERM` + clean halt).
   - Render lanes support **Pause Lane** / **Resume Lane** / **Stop Active Render** from `StatusPage` and `StudioPage`.
5. **Extend Existing Series Without Rerunning Completed Chapters (`src/player/seriesTools.ts`, `LibraryPage.tsx`, `NewSeriesPage.tsx`)**
   - `POST /api/series/:slug/extend`: Upload new chapter `.zip`, provide a Drive link, or specify new chapter numbers (e.g. `21-40`) on an existing series.
   - Preserves `bible.json`, continuity windows, and `out/ch1..ch20`, running only the new chapters.
6. **New Series Outro Announcement Builder (`src/player/seriesTools.ts`, `NewSeriesPage.tsx`)**
   - Configurable when creating a job (`outroConfig: { enabled, totalChapters, coveredChapters, hookType: "part2" | "next_chapter" | "new_series" | "custom", customPrompt }`).
   - Generates a natural, non-hardcoded narrator outro (e.g. *"This manhwa has 50 chapters so far and we've covered the first 20 — drop a comment for Part 2!"*).
7. **Existing Series Outro Generator with Best Character Panels from `bible.json` + `obs` (`src/player/seriesTools.ts`, `LibraryPage.tsx`)**
   - `POST /api/series/:slug/outro`: Scans `bible.json` (`characters`) and `obs_ch*.json` across the series to select the top character-focused showcase panels (protagonist/named characters, `closeup`/`medium` shots, high visual weight, zero promo/credit/system-box clutter).
   - Generates the contextual outro narration + TTS audio + `outro/shots.json` (and renders `out/outro/video/video.mp4`), showing the selected character panel previews in the UI.
8. **One-Click Merge All Chapter Videos -> Download Button (`src/player/seriesTools.ts`, `LibraryPage.tsx`)**
   - `POST /api/series/:slug/merge`: Concatenates all rendered `ch1..chN` videos in numerical order (plus `out/outro/video/video.mp4` if present) into `series/<slug>/out/full/video/video.mp4` via `ffmpeg -f concat -safe 0 -c copy`.
   - Once merged, the **Merge All Chapters** button morphs directly into **Download Merged Video (`full.mp4`)** (with a secondary **Re-merge** action when new chapters or an outro are added).
9. **720p vs. 1080p Render Quality Setting (`src/config/studioConfig.ts`, `src/stages/timeline.ts`, `src/workers/renderlane.ts`, `StudioPage.tsx`, `NewSeriesPage.tsx`)**
   - Configurable globally in Studio Settings (`/api/studio/settings` `renderQuality: "1080p" | "720p"`) and per-job.
   - Passes `--scale=0.6667` (1280x720 / 720x1280) vs `--scale=1` (1920x1080 / 1080x1920) to Remotion and records `quality` in `shots.json` / `report.json`.
10. **Editable Stage Prompts ("Briefs") in Creative Studio (`src/config/studioConfig.ts`, `src/contracts/briefs.ts`, `src/player/studio.ts`, `StudioPage.tsx`)**
    - `GET / PUT / POST /api/studio/prompts`: View, edit, and reset stage prompts (`reader`, `writer`, `story_writer`, `matcher`, `outro`) from the Studio UI, with a toggle to preserve existing chapter cache hashes (`preserveCacheHashes: true` by default).

---

## 3. Delegation & File Ownership

- **Track 1 (`workbuddy/deepseek-v4.1-flash#xhigh`):**
  - `src/config/studioConfig.ts`, `src/llm/client.ts`, `src/contracts/briefs.ts`, `src/stages/{reader,writer,storyWriter,timeline}.ts`, `src/workers/renderlane.ts`
  - Implements Features #1 (multi-model subscription + effort), #2 (Vertex dual auth + multi-modal catalog), #9 (720p/1080p render quality), and #10 (editable stage prompts/briefs).
- **Track 2 (`openai/gpt-6.1-sol#xhigh`):**
  - `src/player/storageTrash.ts` (NEW), `src/player/seriesTools.ts` (NEW), `src/player/libraryDelete.ts`, `src/intake/intake.ts`, `src/player/jobs.ts`, `src/player/studio.ts`, `src/player/server.ts`, `tests/studio-v2-features.test.ts` (NEW)
  - Implements Features #3 (storage breakdown + `/tmp` trash & restore), #4 (pause/resume/stop jobs & lanes), #5 (extend series without rerunning), #6 & #7 (character-panel outro generator), and #8 (merge all chapters into `full.mp4`).
- **Track 3 (`google-vertex/gemini-4-argon#high`, concurrency 1):**
  - `frontend/src/lib/api.ts`, `frontend/src/pages/{StudioPage,LibraryPage,NewSeriesPage,StatusPage}.tsx`
  - Wires all 10 features into the React Studio, Library, New Series, and Status UIs.
