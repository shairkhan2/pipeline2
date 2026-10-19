# `pipeline-v2` Complete Rewrite Roadmap

> **Source Reference (Read-Only):** `/home/shair/manhwa-pipeline`
> **Target Workspace:** `/home/shair/pipeline-v2`
> **Target Stack:** Node.js 22 LTS + TypeScript 5 (`strict: true`) + `zod` + `sharp` + `vitest`

---

## 1. Complete 1-to-1 Module Mapping (v1 -> v2)

Every file in `/home/shair/manhwa-pipeline` is accounted for below: ported cleanly, unified in-process, or explicitly dropped as dead code.

| v1 File (`/home/shair/manhwa-pipeline`) | Lines | v2 Target (`/home/shair/pipeline-v2`) | Action & Key Improvements |
| :--- | :---: | :--- | :--- |
| `pipeline/briefs.py` | ~780 | `src/contracts/briefs.ts` | **Port verbatim.** Keep `READER_BATCH`, `READER_SCHEMA`, `READER_CAPTION_V1..V4`, `READER_PROMO_RULES`, `READER_MERGE`, `SCOUT_*`, `STORY_*`, `WRITER_*`, `EMOTION_TAGS` byte-identical so `brief_hash` and `schema_hash` never change. |
| `pipeline/series_lock.py` | ~380 | `src/locks/seriesLock.ts` | **Port + unify with `library-delete`.** Shared `flock(LOCK_SH)` with in-process refcounting per `(pid, realSdir)` + nonblocking `LOCK_EX \| LOCK_NB` for video deletion. |
| `pipeline/lane_registry.py` | 130 | `src/config/laneRegistry.ts` | **Port.** Static typed catalog (`PROVIDER_TRANSPORTS`, `MODEL_CANDIDATES`, `UNAVAILABLE_MODEL_CANDIDATES`). |
| `pipeline/lane_config.py` | ~680 | `src/config/laneConfig.ts` | **Port + simplify.** Drop the `ast.parse("llm.py")` hack; import `catalog.ts` directly. Keep `lanes.json` + `lanes.lock` optimistic concurrency (`revision`), `FORBIDDEN_KEYS`, and `_SECRET_PATTERNS`. |
| `pipeline/render_policy.py` | ~310 | `src/config/renderPolicy.ts` | **Port.** Snapshot render plan, `effectiveSlots` clamping (`RENDER_TRANSPORT_SLOT_CAP`), `MANHWA_RENDER_LANE` pin validation, `unavailableGraceS`. |
| `pipeline/telemetry.py` | 191 | `src/telemetry/telemetry.ts` | **Port + replace `_tls` globals.** Atomic `<pid>-<startTicks>.json` status snapshots using `AsyncLocalStorage` for trace context instead of mutating module globals. |
| `player/status_probe.py` | ~360 | `src/telemetry/statusProbe.ts` | **Port in-process.** Read `/proc`, telemetry snapshots, `pipeline.log` tail, and `sbx --cloud ls` directly inside Node without spawning `python3`. |
| `player/server.js`, `status.js`, `lanes.js`, `jobs.js`, `library-delete.js` | ~1,100 | `src/player/*.ts` | **Unify in-process.** Keep cookie auth (`$apr1$`, `.htpasswd`, `.temp_users.json`, CSRF) and Range MP4 streaming; replace all `execFile('python3', ...)` calls with direct TypeScript function calls. |
| `pipeline/promo_block.py` + `promo_sources.json` | ~450 | `src/intake/promoBlock.ts` + `src/intake/promo_sources.json` | **Port.** R1 URL, R2 PROMO, R3 CREDIT, R4 EDGE rules + shared registry merge + `panelFullPromo` (`promo_page` explicit bool + art/bubble fallback). |
| `pipeline/ingest.py` | ~520 | `src/intake/ingest.ts` | **Port.** ZIP/CBZ bomb/path-traversal/ratio validation, natural chapter numbering, `ComicInfo.xml` parsing, idempotent page extraction. |
| `pipeline/voice_preview.py` | ~270 | `src/intake/voicePreview.ts` | **Port.** SHA-256 preview cache key, `generate.lock`, 10s `cooldown.json`, `ffprobe` MP3 validation. |
| `pipeline/intake.py` | ~950 | `src/intake/intake.ts` | **Port.** Google Drive URL preflight/download (host allowlist, redirect cap, HTML virus-scan confirm token), job queue state machine (`queued` -> `downloading` -> `ingesting` -> `running` -> `completed`/`failed`/`interrupted`), orphan cleanup. |
| `pipeline/llm.py` | ~520 | `src/llm/client.ts` | **Port.** Multi-lane failover (`VISION_LANES`, `WRITER_LANES`), per-lane `Semaphore` concurrency, SSE streaming collector (`workbuddy`), `FilterBlocked` detection, `sharp` image resize/base64 encoding, `parseJson`. |
| `pipeline/fact_check.py` | ~440 | `src/stages/factCheck.ts` | **Port.** Number/age grounding, `@pXXXX_N` tag check, `DUB` (>=8 consecutive overlay words outside quotes), `PERSONA LAW` P1 check, `PROMO` lint, attitude-tail/mind-read advisories. |
| `pipeline/reader.py` | 792 | `src/stages/reader.ts` | **Port with Zod validation.** 12-panel batch vision reads, `id_audit`, `FilterBlocked` binary-search rescue, `normBox`, `normPromoBbox`, `applyPromoMeta`, manifest `page`/`idx` injection, `castBlock`, `mergeBible`, `enforceAliasUniqueness` (`I-27`). |
| `pipeline/scout.py` | ~220 | `src/stages/scout.ts` | **Port.** Two-pass opening chapter/event + vision hook selector (`out/opening.json`) and `contextDigest`. |
| `pipeline/promo_mask.py` | ~340 | `src/stages/promoMask.ts` | **Port using `sharp`.** Parse MIT text/JSON coords, font-height-scaled banner expansion (`EXPAND_TOP/BOTTOM/SIDE_FRAC`), `MAX_UNION_FRAC=0.30` and protected-text overlap guards, 2x2 pixelation + Gaussian blur. |
| `pipeline/cleaner.py` + `tools/promo_ocr_export.py` | 1,120 | `src/stages/cleaner.ts` + `tools/promo_ocr_export.py` | **Port.** `shouldClean`, `hasWorldText`, `promoPageBoundary` (hard safety stop + vision classifier), `cleanPromoMask` (`.promo_boxes.json` sidecar + `pmask-v4` stamp + 1x/2x ROI OCR rescue), `cleanBatch` (MIT local/remote batch + `residualOverlay` / `promoGone` vision verifiers). |
| `pipeline/framing.py` | ~250 | `src/stages/framing.ts` | **Port using `sharp`.** Render-only interest-box art cropping (`cropWindow`, `_trimBlankPadding`, `_speechEdges`, `_continuation` seam donor join with promo donor guard). |
| `pipeline/gskbin.py` + `pipeline/audio_check.py` + `pipeline/say.py` | ~135 | `src/stages/audio.ts` | **Port.** `gsk`/`gskr` launcher, `edge-tts` synthesis with 3x retry, ElevenLabs `gsk audio` + `ffmpeg silenceremove`, external TTS JSON-stdin runner, and `audio_check` ASR drift sweep. |
| `pipeline/timeline.py` | 1,140 | `src/stages/timeline.ts` | **Port with shared `Shot` type.** `parseScript`, `pickPanels` adjacency-first swap ladder, `_nearestUnseen`, `_borrowRun`, reserved future anchors, callback panels, `buildShots`, `_applyCleaned`, `frameShots` integration, studio asset staging. |
| `pipeline/lappy.py` | 156 | `src/workers/lappy.ts` | **Port.** SSH health probe (`load`, `cpus`, `mem_gb`, `disk_gb`, `miss`), 2-failure circuit breaker (`BREAKER_S=600`), local `HEAVY` mutex, `rsync` helpers. |
| `pipeline/cloudlane.py` | 362 | `src/workers/cloudlane.ts` | **Port.** `sbx --cloud` lease (`.gate` / `.use` flocks), TTL extension, `_syncStudio` hash check, 2-slot remote flock (`for slot in 0 1`), `ffprobe` validation, auto-pause when idle. |
| `pipeline/renderlane.py` | 591 | `src/workers/renderlane.ts` | **Port.** `prepare` + `_render` / `_renderOnLane`, `_capfreeNode` (strips `security.capability` xattrs so `TMPDIR` survives into Chrome), multi-slot worker queue. |
| `pipeline/slicer.py` | 835 | `src/stages/slicer.ts` | **Port using `sharp` raw buffers.** `findCuts`, `trim` (median-gated dark branch), `artBounds`, `nearWhiteRows`, `artRows`, `interiorGutters`, `shortWidePanel`, `shippable`, `_foldSlivers`, `_dropSlivers`, `boundaryContinuous`, `weldIsSound`, `interiorFused`, `sliceChapter` (`SLICER_REV=3`). |
| `pipeline/story_writer.py` + `pipeline/visual_matcher.py` + `pipeline/writer.py` | ~2,100 | `src/stages/storyWriter.ts`, `src/stages/visualMatcher.ts`, `src/stages/writer.ts` | **Port active paths; drop dead code.** Port `castContext`, `validatePlan`, `validateDraft`, `validateReview`, `visualMatcher` (contact sheets + detail cards + 2-pass review), `previousWindow` (`HOOK_BEATS=3`), `panelTranscript`, `writerDialogueLookup`, and active matcher. |
| `pipeline/run.py` | 579 | `src/cli/run.ts` | **Port.** CLI flags (`--status`, `--clear-cache`, `--video`, `--force`, `--keep-stale`, `--write-anyway`, `--scout`, `--reader-captions`), `failClass`, retry loop, continuity gate (`I-15`), `_withHook` / `_dropHookEcho`. |
| `pipeline/moment.py` & dead functions in `writer.py` | ~500 | *Dropped* | **Do not port.** Unwired `moment.py`, dead `MATCH_SAMPLES` consensus voting, `USE_EVENT_PRIOR`, `_pred_map`, `_shots_to_script`, `_best_by_words` (per `TODO.md` Section 3). |

---

## 2. Frozen On-Disk & Hash Contracts (Zero-Regression Rules)

To guarantee `pipeline-v2` never invalidates existing caches or corrupts series state, these exact formulas and file formats are locked:

1. **Reader Cache Hashes (`src/contracts/hashes.ts`):**
   - `schemaHash() = sha256(READER_SCHEMA).slice(0, 8)`
   - `briefHash(1) = sha256(READER_BATCH).slice(0, 8)` -> **Must equal `"9529b2f7"`**
   - `briefHash(4) = sha256(readerBatch(4)).slice(0, 8)` -> **Must equal `"821ef7aa"`**
   - Batch cache path: `out/batches/<ch>/b<NN>.json` for `cv=1`; `out/batches/<ch>/v<cv>/b<NN>.json` for `cv>1`.
2. **Slicer Cache Sidecar (`out/panels/<ch>/manifest.meta.json`):**
   - `{"slicer_rev": 3, "pages_hash": sha256(sorted "<filename>:<size>\n")}`
3. **Promo Cleaner Cache (`out/cleaned/<ch>/<pid>.png.done` + `.promo_boxes.json`):**
   - `PROMO_ALGO_VERSION = "pmask-v4"`
   - SHA-1 over `PROMO_ALGO_VERSION` + `cleaner_config.json` bytes + source image bytes + `promo_ocr_export.py` bytes + JSON(`{pad: 0.5, regions}`) + `_promoRulesHash` + sorted unique `overlay + world` strings.
4. **Audio Per-Line Proof Sidecar (`line_<NNN>.mp3` + `line_<NNN>.txt`):**
   - For `edge`/`eleven`: exact line text string.
   - For `external`: canonical JSON `{"text": text, "tts": {command, engine, language, provider, revision, settings, speed, style, voice_id}}`.
5. **Advisory Lock Files (`flock(2)`):**
   - Series lock: `<series_root>/<slug>/.series.lock`
   - Lane config lock: `<pipeline_out>/lanes.lock`
   - Voice preview lock: `<jobs_dir>/voice-previews/generate.lock`
   - Cloud sandbox locks: `<cloud_lockdir>/<sha256(box_id)>.gate` and `.use`

---

## 3. Step-by-Step Implementation Phases

### Phase 0: Workspace Init, Contracts, Hashes & Locks
**Goal:** Boot the TypeScript project in `/home/shair/pipeline-v2`, lock down all data schemas with `zod`, verify 100% hash parity against v1, and implement `flock` file locking.

- [x] **0.1 Initialize Project:**
  - Create `package.json` (`type: "module"`, `zod`, `sharp`, `tsx`, `typescript`, `vitest`, `@types/node`).
  - Create `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`, `target: "ES2023"`, `moduleResolution: "Bundler"`).
- [x] **0.2 Port Prompts & Hash Contracts (`src/contracts/briefs.ts`, `src/contracts/hashes.ts`):**
  - Port `READER_SCHEMA`, `READER_BATCH`, `READER_CAPTION_V1..V4`, `READER_PROMO_RULES`, and all writer/scout/matcher prompts.
  - Implement `schemaHash()`, `briefHash(cv)`, `pagesHash(chdir)`, `promoCacheHash(it, srcPath)`, `narrationCacheKey(...)`.
- [x] **0.3 Define Zod Schemas (`src/contracts/schemas.ts`) & Shared Panel Helpers (`src/domain/panels.ts`):**
  - Schemas for `ManifestRec`, `ManifestMeta`, `PanelObs`, `ChapterObs`, `Bible`, `Opening`, `PromoBlock`, `PromoSidecar`, `Shot`, `LaneConfig`, `IntakeJob`, `TelemetrySnapshot`.
  - Shared `panelOrderKey`, `panelPositions`, `keymap`, `adjKeys`, `SHOT_MIN_S = 0.8`.
- [x] **0.4 Implement Advisory Locks (`src/locks/seriesLock.ts`):**
  - Implement `withSharedSeriesLock`, `withExclusiveSeriesLock`, `validateSlug`, `validateChapter`, symlink-safe path traversal walk, and `deleteChapterVideo`.
- [x] **Phase 0 Gate (`tests/phase0-contracts.test.ts`):**
  - Assert `briefHash(1) === "9529b2f7"` and `briefHash(4) === "821ef7aa"`.
  - Parse all existing JSON files under `/home/shair/manhwa-pipeline/series/*/out/` (read-only) through `schemas.ts` with 0 failures.
  - Verify `seriesLock.ts` refcounting and `LOCK_SH` / `LOCK_EX` contention.

---

### Phase 1: Control Plane, Telemetry & Unified Player Server
**Goal:** Port lane configuration, render policy, telemetry, status probing, and the Screening Room web server (`player/`) into a single in-process TypeScript server.

- [x] **1.1 Model & Render Lane Config (`src/config/laneRegistry.ts`, `src/config/laneConfig.ts`, `src/config/renderPolicy.ts`):**
  - Port static model/render catalogs, `getLanesState`, `updateLanesState` (with `lanes.lock` + revision check + secret/forbidden-key rejection), and `resolveRenderPlan`.
- [x] **1.2 Telemetry & Status Collector (`src/telemetry/telemetry.ts`, `src/telemetry/statusProbe.ts`):**
  - Port atomic status snapshot writer (`<pid>-<startTicks>.json`) and `/proc` + log tail collector (`statusProbe.ts`).
- [x] **1.3 Unified Player HTTP Server (`src/player/server.ts`, `lanes.ts`, `status.ts`, `libraryDelete.ts`):**
  - Port cookie auth (`$apr1$`, `.htpasswd`, `.temp_users.json`, CSRF verification), video Range streaming, thumbnail serving, and wire `/api/status`, `/api/lanes`, and `/api/library/video` (`DELETE`) directly to in-process TypeScript functions.
- [x] **Phase 1 Gate (`tests/phase1-control-plane.test.ts`):**
  - Port and pass all test cases from `test_lane_config.py`, `test_model_lanes.py`, `test_render_policy.py`, `test_series_lock.py`, and `player/tests/test_status.py`.

---

### Phase 2: Intake, Ingest, Voice Preview & Promo Blocklist
**Goal:** Port all deterministic archive, Google Drive, voice preview, and scanlator promo-block modules; wire `/api/intake/*` in-process.

- [x] **2.1 Promo Blocklist (`src/intake/promoBlock.ts`):**
  - Port `Block` class, `domainMatches`, `nameMatches`, R1–R4 cross-chapter corroboration, `promo_sources.json` merge, and `panelFullPromo`.
- [x] **2.2 Archive Ingest (`src/intake/ingest.ts`):**
  - Port `validateZipArchive` (size/entry/ratio/symlink/traversal guards), nested `.cbz` sorting, `ComicInfo.xml` title/translator extraction, and idempotent chapter page extraction.
- [x] **2.3 Voice Preview & Intake Queue (`src/intake/voicePreview.ts`, `src/intake/intake.ts`):**
  - Port preview cache/lock/cooldown, Google Drive downloader (host allowlist + virus-scan token extraction), job queue state machine, and orphan cleanup.
  - Connect `src/player/jobs.ts` directly to `intake.ts` and `voicePreview.ts`.
- [x] **Phase 2 Gate (`tests/phase2-intake.test.ts`):**
  - Verify `promoBlock.ts` produces identical hashes and block sets as `promo_block.py` on read-only series fixtures.
  - Port and pass all test cases from `test_intake.py`, `test_voice_preview.py`, and `test_promo_block_registry.py`.

---

### Phase 3: LLM Client, Fact Check, Reader & Scout
**Goal:** Port the multi-lane LLM client, deterministic script fact checker, vision batch reader, bible merger, and opening scout.

- [x] **3.1 Multi-Lane LLM Client (`src/llm/client.ts`):**
  - Port `call()`, `_activeLanes(role)`, per-lane concurrency semaphores, SSE stream reader (`workbuddy`), retry/backoff (`429`/`5xx`/timeout vs `401`/`403` skip vs `FilterBlocked` failfast), `parseJson`, and `pageBlocks` (using `sharp` resize + JPEG base64).
- [x] **3.2 Fact Checker (`src/stages/factCheck.ts`):**
  - Port `check()`, `stripEmotion`, `connectives`, attitude-tail & mind-read advisories, `DUB` check, `PERSONA` P1 check, number/tag grounding, and `PROMO` check.
- [x] **3.3 Vision Reader & Bible Merger (`src/stages/reader.ts`):**
  - Port `readChapter`, `idAudit`, `findBlocked` + `unblock` rescue, `normBox`, `normPromoBbox`, `applyPromoMeta`, `castBlock`, `mergeBible`, and `enforceAliasUniqueness`.
- [x] **3.4 Opening Scout (`src/stages/scout.ts`):**
  - Port `scout()` and `contextDigest()`.
- [x] **Phase 3 Gate (`tests/phase3-reader-factcheck.test.ts`):**
  - Replay `readChapter` on a scratch copy of a cached series -> 100% cache hit, 0 network calls, identical `obs_<ch>.json`.
  - Replay `mergeBible` on cached `obs_ch*.json` + `judge_cache.json` -> identical `bible.json`.
  - Run `factCheck.ts` across all existing `script*.md` + `transcript.md` in `/home/shair/manhwa-pipeline/series/` (read-only) -> 100% identical findings to `fact_check.py`.

---

### Phase 4: Cleaner, Promo Mask, Framing & Timeline/TTS
**Goal:** Port the render-preparation pipeline (`script.md` + `obs_<ch>.json` -> `narration.mp3` + cleaned/framed panels + `shots.json`).

- [x] **4.1 Local Promo Mask & Cleaner (`src/stages/promoMask.ts`, `src/stages/cleaner.ts`):**
  - Port `parseTextExport` and `blurPromoRegions` using `sharp` raw RGB pixel buffers.
  - Port `promoPageBoundary`, `writePromoSidecar`, `validatePromoSidecar`, `cleanPromoMask` (1x/2x ROI OCR via `promo_ocr_export.py`), and `cleanBatch` (local/laptop MIT batch + `promoGone` and `residualOverlay` vision gates).
- [x] **4.2 Render-Only Art Framing (`src/stages/framing.ts`):**
  - Port `cropWindow`, `_trimBlankPadding`, `_speechEdges`, `_continuation` (with promo donor guard), and `frameShots` using `sharp`.
- [x] **4.3 Audio TTS & Timeline Builder (`src/stages/audio.ts`, `src/stages/timeline.ts`):**
  - Port `ttsLines` (`edge-tts`), `ttsLinesEleven` (`gsk` + `ffmpeg silenceremove`), `ttsLinesExternal`, `audio_check.sweep`, `parseScript`, `pickPanels`, `_nearestUnseen`, `_borrowRun`, `buildShots`, `_applyCleaned`, and studio `public/<series>_<ch>` asset staging.
- [x] **Phase 4 Gate (`tests/phase4-timeline-cleaner.test.ts`):**
  - Run `buildShots` against 20 chapters of read-only `script*.md` + `obs_<ch>.json` + `manifest.json` + cached `line_NNN.mp3` durations -> 100% identical `shots.json` output to Python `timeline.py`.
  - Port and pass `test_external_tts.py`, `test_promo_mask.py`, `test_promo_cleaner.py`, and `test_render_framing.py`.

---

### Phase 5: Render Workers (`lappy`, `cloudlane`, `renderlane`) & Orchestrator CLI (`run.ts`)
**Goal:** Port local/laptop/cloud render scheduling and the top-level chapter pipeline runner.

- [x] **5.1 Remote & Cloud Render Bridges (`src/workers/lappy.ts`, `src/workers/cloudlane.ts`):**
  - Port SSH health probe, circuit breaker, `rsync` helpers (`lappy.ts`), and Docker `sbx --cloud` lease, `.gate`/`.use` locks, studio sync, 2-slot flock, and auto-pause (`cloudlane.ts`).
- [x] **5.2 Render Lane Scheduler (`src/workers/renderlane.ts`):**
  - Port `prepare`, `renderLocal` (including `_capfreeNode`), `renderRemote`, `renderCloud`, `_workerPlan`, and `_drainPending`.
- [x] **5.3 Main Pipeline Runner (`src/cli/run.ts`):**
  - Port CLI parser, `status()`, `clearCache()`, continuity gate (`I-15`), `RETRY_ROUNDS` / `RETRY_WAITS`, `_withHook`, `_dropHookEcho`, and off-thread video queue orchestration.
- [x] **Phase 5 Gate (`tests/phase5-renderlane.test.ts`):**
  - Port and pass `test_cloudlane.py`, `test_cloud_lifecycle.py`, and `test_renderlane_cloud.py`.
  - Verify `npx tsx src/cli/run.ts <series> --status` matches Python `run.py <series> --status` output across all series.

---

### Phase 6: Page Slicer (`slicer.ts`) & Story Writer / Semantic Matcher (`writer.ts`, `storyWriter.ts`, `visualMatcher.ts`)
**Goal:** Port the pixel page slicer and the story writer + vision panel matcher, dropping dead v1 experiments.

- [x] **6.1 Webtoon Page Slicer (`src/stages/slicer.ts`):**
  - Decode chapter page images to raw grayscale + RGB buffers via `sharp`.
  - Port `findCuts`, `trim` (with `page_median >= 25` dark-branch guard), `artBounds`, `nearWhiteRows`, `artRows`, `interiorGutters`, `shortWidePanel`, `shippable`, `_foldSlivers`, `_dropSlivers`, `_splitOnWhite`, `segments`, `boundaryContinuous`, `weldIsSound`, `interiorFused`, and `sliceChapter` (`SLICER_REV = 3`).
- [x] **6.2 Story Writer & Semantic Visual Matcher (`src/stages/storyWriter.ts`, `src/stages/visualMatcher.ts`, `src/stages/writer.ts`):**
  - Port `castContext`, `validatePlan`, `validateDraft`, `validateReview`, `writeStoryScript`.
  - Port `_buildSheets` and `_buildDetails` contact-sheet composition using `sharp` + SVG text labels, plus 2-pass vision selection & review in `visualMatcher.ts`.
  - Port `panelTranscript`, `writerDialogueLookup`, `previousWindow` (`HOOK_BEATS = 3`), and active caption matcher in `writer.ts`.
- [x] **Phase 6 Gate (`tests/phase6-slicer-writer.test.ts`):**
  - Run `slicer.ts` on 10 chapters copied to `/tmp/opencode/` and verify `manifest.json` matches Python `slicer.py` (`panel`, `page`, `idx`, `w`, `h`, `page_span`, `art_top`, `art_bottom`).
  - Run `storyWriter` and `visualMatcher` contract tests (`verify_beats.py`, `test_reader_batch.py` equivalents).

---

### Phase 7: Remotion Studio Integration & Full End-to-End Parity Run
**Goal:** Wire `remotion-studio` into `/home/shair/pipeline-v2`, run a full end-to-end chapter test in `/home/shair/pipeline-v2`, and verify every output artifact.

- [x] **7.1 Link/Copy `remotion-studio` & Share `Shot` Types:**
  - Copy `remotion-studio/` into `/home/shair/pipeline-v2/remotion-studio/` (keeping `/home/shair/manhwa-pipeline/remotion-studio` untouched) and export `Shot` from one shared type definition.
- [x] **7.2 End-to-End Chapter Run:**
  - Run 1 full chapter in `/home/shair/pipeline-v2` (`ingest` -> `slicer` -> `reader` -> `writer` -> `factCheck` -> `timeline` -> `cleaner` -> `framing` -> `remotion render`) and verify `video.mp4`, `shots.json`, `report.json`, and `telemetry` status snapshots.
- [x] **7.3 Final Cutover Checklist:**
  - Confirm 100% cache-hit (`0 API calls`) when pointing `run.ts --status` at existing series caches.
  - Switch production runner & Player service to `/home/shair/pipeline-v2`, then archive `/home/shair/manhwa-pipeline`.
