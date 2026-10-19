# OpenCode Migration TODO (`pipeline-v2`)

> **Workspace:** `/home/shair/pipeline-v2`
> **Read-Only v1 Reference:** `/home/shair/manhwa-pipeline` (NEVER modify or delete anything in `/home/shair/manhwa-pipeline`)
> **Subagent Model Pool & Concurrency Caps:**
> - `google-vertex/gemini-4-argon` — **max 1 concurrent** (complex algorithmic / pixel / architecture-critical modules)
> - `xai/grok-4.7` — **max 2 concurrent** (core stages, state machines, reader, timeline, cleaner)
> - `workbuddy/deepseek-v4.1-flash` — **max 2 concurrent** (config, intake, fact-check, workers, player routes)
> - `opencode/glm-5.3-flash-free` — **max 1 concurrent** (self-contained leaf modules, helpers, parity test suites)

---

## Phase 0: Workspace Scaffold, Contracts, Schemas, Hashes & Locks
- [x] **T0.0** Initialize `/home/shair/pipeline-v2` (`package.json`, `tsconfig.json`, `vitest.config.ts`, `npm install`).
- [x] **T0.1** `src/contracts/briefs.ts` + `src/contracts/hashes.ts` — Port byte-exact prompts from `pipeline/briefs.py` and hash functions (`schemaHash`, `briefHash`, `pagesHash`, `promoRulesHash`, `promoCacheHash`, `narrationCacheKey`, `lineProofToken`). Must pass `briefHash(1) === "9529b2f7"` and `briefHash(4) === "821ef7aa"`. *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T0.2** `src/contracts/schemas.ts` + `src/domain/panels.ts` — Define strict `zod` schemas + TS types (`ManifestRec`, `ManifestMeta`, `PanelObs`, `ChapterObs`, `Bible`, `Opening`, `PromoBlock`, `PromoSidecar`, `Shot`, `LaneConfig`, `IntakeJob`, `TelemetrySnapshot`) and shared panel ordering (`panelOrderKey`, `panelPositions`, `keymap`, `adjKeys`, `SHOT_MIN_S = 0.8`). *(Model: `xai/grok-4.7`)*
- [x] **T0.3** `src/locks/seriesLock.ts` — Port `pipeline/series_lock.py` + `player/library-delete.js` lock & symlink-safe path validation (`validateSlug`, `validateChapter`, `inferSeriesDir`, `withSharedSeriesLock`, `withExclusiveSeriesLock`, `resolveChapterVideo`, `deleteChapterVideo`). *(Model: `google-vertex/gemini-4-argon`)*
- [x] **T0.4** `tests/phase0-contracts.test.ts` — Golden parity tests verifying `briefHash(1)`, `briefHash(4)`, `schemaHash()`, parsing real read-only JSON files from `/home/shair/manhwa-pipeline/series/*/out/`, and testing `seriesLock.ts`. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 1: Control Plane, Telemetry & Unified Player Server
- [x] **T1.1** `src/config/laneRegistry.ts` + `src/config/laneConfig.ts` + `src/config/renderPolicy.ts` — Port static model/render catalogs (no AST hack), `lanes.json` + `lanes.lock` atomic persistence with revision check, `FORBIDDEN_KEYS`, secret scrubbing, and `resolveRenderPlan`. *(Model: `xai/grok-4.7`)*
- [x] **T1.2** `src/telemetry/telemetry.ts` + `src/telemetry/statusProbe.ts` — Port atomic `<pid>-<startTicks>.json` telemetry writer (`AsyncLocalStorage` context) and in-process `/proc` + `pipeline.log` + `sbx --cloud ls` collector (`statusProbe.ts`). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T1.3** `src/player/server.ts` + `src/player/status.ts` + `src/player/lanes.ts` + `src/player/libraryDelete.ts` — Port Player HTTP server (cookie `$apr1$` auth, `.htpasswd`, `.temp_users.json`, CSRF, Range MP4 streaming, static UI) wired in-process to `statusProbe`, `laneConfig`, and `seriesLock` (zero `python3` subprocesses). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T1.4** `tests/phase1-control-plane.test.ts` — Port and pass `test_lane_config`, `test_model_lanes`, `test_render_policy`, `test_series_lock`, and `test_status` suites. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 2: Intake, Ingest, Voice Preview & Promo Blocklist
- [x] **T2.1** `src/intake/promoBlock.ts` + `src/intake/promo_sources.json` — Port `pipeline/promo_block.py` (`Block`, `domainMatches`, `nameMatches`, R1–R4 cross-chapter rules, shared registry merge, `panelFullPromo`). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T2.2** `src/intake/ingest.ts` — Port `pipeline/ingest.py` (ZIP/CBZ bomb/ratio/symlink/traversal validation, natural chapter sorting, `ComicInfo.xml` parsing, idempotent page extraction). *(Model: `xai/grok-4.7`)*
- [x] **T2.3** `src/intake/voicePreview.ts` + `src/intake/intake.ts` + `src/player/jobs.ts` — Port `voice_preview.py`, `intake.py` (Google Drive preflight/download, job queue state machine, orphan cleanup), and wire `src/player/jobs.ts` in-process. *(Model: `google-vertex/gemini-4-argon`)*
- [x] **T2.4** `tests/phase2-intake.test.ts` — Parity tests for `promoBlock` against read-only series in `/home/shair/manhwa-pipeline/series/`, plus `ingest`, `voicePreview`, and `intake` test suites. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 3: LLM Client, Fact Check, Reader & Scout
- [x] **T3.1** `src/llm/client.ts` — Port `pipeline/llm.py` (`VISION_LANES`, `WRITER_LANES`, persisted snapshot resolution, per-lane concurrency semaphores, SSE stream collector, retry/backoff, `FilterBlocked`, `sharp` image resize/base64 `imgB64`/`pageBlocks`, `parseJson`). *(Model: `xai/grok-4.7`)*
- [x] **T3.2** `src/stages/factCheck.ts` — Port `pipeline/fact_check.py` (number/age grounding, `@pXXXX_N` tag check, `DUB` check, `PERSONA LAW` P1 check, `PROMO` lint, connectives/attitude-tail/mind-read advisories). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T3.3** `src/stages/reader.ts` + `src/stages/scout.ts` — Port `pipeline/reader.py` (`readChapter`, `idAudit`, `normBox`, `normPromoBbox`, `applyPromoMeta`, `castBlock`, `mergeBible`, `enforceAliasUniqueness`) and `pipeline/scout.py` (`scout`, `contextDigest`). *(Model: `google-vertex/gemini-4-argon`)*
- [x] **T3.4** `tests/phase3-reader-factcheck.test.ts` — Zero-API-call cache replay test on existing series, deterministic `mergeBible` replay test, and golden `factCheck` comparison across all read-only scripts in `/home/shair/manhwa-pipeline/series/`. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 4: Cleaner, Promo Mask, Framing & Timeline/TTS
- [x] **T4.1** `src/stages/promoMask.ts` + `src/stages/cleaner.ts` — Port `promo_mask.py` (`parseTextExport`, `blurPromoRegions` via `sharp`) and `cleaner.py` (`shouldClean`, `hasWorldText`, `promoPageBoundary`, `writePromoSidecar`, `validatePromoSidecar`, `cleanPromoMask`, `cleanBatch`, `promoGone`, `residualOverlay`). *(Model: `google-vertex/gemini-4-argon`)*
- [x] **T4.2** `src/stages/framing.ts` — Port `pipeline/framing.py` (`cropWindow`, `_trimBlankPadding`, `_speechEdges`, `_continuation` with promo donor guard, `frameShots` via `sharp`). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T4.3** `src/stages/audio.ts` + `src/stages/timeline.ts` — Port `gskbin.py`, `say.py`, `audio_check.py`, and `timeline.py` (`ttsLines`, `ttsLinesEleven`, `ttsLinesExternal`, `parseScript`, `pickPanels` adjacency-first ladder, `_nearestUnseen`, `_borrowRun`, `buildShots`, `_applyCleaned`, studio asset staging). *(Model: `xai/grok-4.7`)*
- [x] **T4.4** `tests/phase4-timeline-cleaner.test.ts` — Golden `buildShots` parity test across 20 read-only chapters from `/home/shair/manhwa-pipeline/series/` + cleaner/promoMask/framing/external-TTS unit tests. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 5: Render Workers (`lappy`, `cloudlane`, `renderlane`) & Orchestrator CLI (`run.ts`)
- [x] **T5.1** `src/workers/lappy.ts` + `src/workers/cloudlane.ts` — Port SSH laptop bridge (`healthy`, circuit breaker, `HEAVY` mutex, `rsync`) and Docker cloud sandbox bridge (`sbx --cloud`, `.gate`/`.use` flocks, `_syncStudio`, 2-slot remote flock, auto-pause). *(Model: `workbuddy/deepseek-v4.1-flash`)*
- [x] **T5.2** `src/workers/renderlane.ts` + `src/cli/run.ts` — Port `renderlane.py` (`prepare`, `renderLocal` with `_capfreeNode`, `renderRemote`, `renderCloud`, `_workerPlan`) and `run.py` (`status`, `clearCache`, continuity gate `I-15`, retry loop, `_withHook`, `_dropHookEcho`). *(Model: `xai/grok-4.7`)*
- [x] **T5.3** `tests/phase5-renderlane.test.ts` — Port and pass `test_cloudlane`, `test_cloud_lifecycle`, `test_renderlane_cloud`, and verify `run.ts --status` parity against `run.py --status`. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 6: Webtoon Slicer (`slicer.ts`) & Story Writer / Matcher (`storyWriter.ts`, `visualMatcher.ts`, `writer.ts`)
- [x] **T6.1** `src/stages/slicer.ts` — Port `pipeline/slicer.py` (`findCuts`, `trim` dark-branch median guard, `artBounds`, `nearWhiteRows`, `artRows`, `interiorGutters`, `shortWidePanel`, `shippable`, `_foldSlivers`, `_dropSlivers`, `_splitOnWhite`, `segments`, `boundaryContinuous`, `weldIsSound`, `interiorFused`, `sliceChapter` with `SLICER_REV = 3`) using `sharp`. *(Model: `google-vertex/gemini-4-argon`)*
- [x] **T6.2** `src/stages/storyWriter.ts` + `src/stages/visualMatcher.ts` + `src/stages/writer.ts` — Port active story planning/drafting/review (`story_writer.py`), contact-sheet/detail-card semantic matcher (`visual_matcher.py`), and `writer.py` (`panelTranscript`, `writerDialogueLookup`, `previousWindow`, active matcher), dropping dead legacy code (`moment.py`, `MATCH_SAMPLES`, `USE_EVENT_PRIOR`, `_pred_map`, `_shots_to_script`). *(Model: `xai/grok-4.7`)*
- [x] **T6.3** `tests/phase6-slicer-writer.test.ts` — Golden pixel-slice parity test on chapters copied to `/tmp/opencode/` + story/matcher validation tests. *(Model: `opencode/glm-5.3-flash-free`)*

---

## Phase 7: Remotion Studio Integration & Final Verification
- [x] **T7.1** Copy `remotion-studio` into `/home/shair/pipeline-v2/remotion-studio/`, wire shared `Shot` type, copy `player/public` assets into `/home/shair/pipeline-v2/player/public`, and run full typecheck (`tsc --noEmit`) + full test suite (`vitest run`). *(Model: `google-vertex/gemini-4-argon`)*
