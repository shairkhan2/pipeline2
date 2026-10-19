# Safe Migration Plan: Python (`/home/shair/manhwa-pipeline`) to Strict TypeScript (`/home/shair/pipeline-v2`)

## 1. Executive Decision: Target Language & Stack

**Chosen Language:** **Strict TypeScript (Node.js 22 LTS + TypeScript 5 `strict: true` + `zod` + `sharp`)**

### Why Strict TypeScript Wins Over Go, Rust, and Python for This Codebase
1. **Unifies the Entire Stack Into One Language:**
   - `player/` (`server.js`, `jobs.js`, `lanes.js`, `status.js`, `library-delete.js`) is already Node.js.
   - `remotion-studio/` (`src/motions/fit.ts`, `hold.ts`, `SoloCard.tsx`, `types.ts`) is already TypeScript.
   - Building `pipeline-v2` in TypeScript collapses the system from **2 runtimes (Python + Node)** to **1 runtime (Node/TypeScript)** and shares types (`Shot`, `LaneConfig`, `TelemetrySnapshot`) directly across `player`, `pipeline`, and `remotion-studio`.
2. **Eliminates Subprocess Spawning in the Web Player:**
   - In v1, every HTTP call to `/api/status`, `/api/lanes`, `/api/intake`, and chapter video deletion in `player/` spawns a cold `python3` subprocess (`status_probe.py`, `lane_config.py`, `intake.py`, `series_lock.py`). In `pipeline-v2`, `player/server` imports those modules in-process (<1ms, zero serialization drift).
3. **Best-in-Class AI / Vibe-Coding Maintainability:**
   - `tsc --noEmit` runs in **<1 second** and acts as a strict compile-time guardrail for AI edits without Rust's borrow-checker/lifetime loops.
   - `zod` schemas at every JSON/LLM boundary replace ~450 lines of defensive `if isinstance(x, bool) or not isinstance(x, int)` and `math.isfinite` boilerplate scattered across `reader.py`, `timeline.py`, `cleaner.py`, and `story_writer.py`.
4. **Native C-Backed Image Processing via `sharp` (`libvips`):**
   - Replaces Python `Pillow` + `NumPy` for panel cropping, contact sheets (`visual_matcher`), promo blur masks (`promo_mask`), and grayscale row statistics (`slicer`) with lower memory usage and faster execution.
5. **External ML Remains Decoupled:**
   - `/opt/manga-image-translator` (`/opt/mit-venv312/bin/python`) is already invoked as an external tool subprocess in `cleaner.py`, just like `ffmpeg`, `ffprobe`, `ssh`, and `sbx`. `pipeline-v2` drives it the exact same way without keeping the backend in Python.

---

## 2. Non-Negotiable Safety Laws (Read Before Writing Any v2 Code)

1. **`/home/shair/manhwa-pipeline` Stays 100% Untouched:**
   - All v2 code, tests, configs, and build artifacts live strictly inside `/home/shair/pipeline-v2/`.
   - Never edit, overwrite, or delete files inside `/home/shair/manhwa-pipeline/` during development.
   - `/home/shair/manhwa-pipeline/` is read-only reference for logic, prompts, and golden-test verification.
2. **Never Touch Live Series Outputs (`/home/shair/manhwa-pipeline/series/`):**
   - Check `ps -ef | grep run.py` before running any parity check.
   - `pipeline-v2` uses its own isolated `series/` / scratch directories (or `/tmp/opencode/`) during development and testing; when inspecting v1 artifacts for golden tests, open them strictly read-only.
3. **Zero Re-Billing / 100% Cache-Hash Parity:**
   - Existing series directories hold paid vision caches (`out/batches/<ch>/bNN.json`, `out/batches/<ch>/v4/bNN.json`, `out/obs_<ch>.json`, `out/judge_cache.json`), writer scripts (`script.md`, `script_eleven.md`, `script_voice.md`), TTS audio (`line_NNN.mp3` + `.txt`), and cleaned panels (`out/cleaned/<ch>/*.png` + `.done` + `.promo_boxes.json`).
   - `pipeline-v2` **must** produce bit-for-bit identical cache keys (`schema_hash`, `brief_hash`, `_pages_hash`, `_promo_cache_hash`, `_narration_cache_key`, `_line_proof_token`, `judge` signature).
   - A v2 run against a copied/mounted cached chapter **must make 0 LLM/TTS API calls**.
4. **Cross-Process Lock Compatibility:**
   - `pipeline-v2` must honor the exact same `flock(2)` advisory lock protocol:
     - `<series_root>/<slug>/.series.lock` (`LOCK_SH` for pipeline writers, `LOCK_EX | LOCK_NB` for video deletion)
     - `lanes.lock` (lane config atomic updates)
     - `cloud-locks/<sha256>.gate` and `.use` (Docker cloud sandbox leases)

---

## 3. Architectural Flaws in Python v1 That v2 Must Fix (Not Copy)

When porting logic from `/home/shair/manhwa-pipeline/pipeline/` to `/home/shair/pipeline-v2/`, keep the **business rules and domain invariants (`I-01`..`I-55`)**, but **eliminate** these Python structural flaws:

| Python v1 Maintainability Flaw | Where It Lives in v1 | How `/home/shair/pipeline-v2` Fixes It |
| :--- | :--- | :--- |
| **Untyped `dict` soup & boolean/int traps** | `reader.py`, `timeline.py`, `cleaner.py`, `story_writer.py` | Parse once at disk/LLM boundaries with `zod` (`z.number().int().finite()`, `z.boolean()`). Pass strongly typed TypeScript interfaces internally. |
| **Three-valued `promo_page` (`True \| False \| None`)** | `reader.py:294`, `cleaner.py:234`, `promo_block.py:78` | Represent as an explicit discriminated union / enum: `promoPage: 'full' \| 'partial' \| 'unknown'` (mapped to/from JSON `true`/`false`/`undefined` only in the serializer). |
| **AST-parsing `llm.py` to avoid import side effects** | `lane_config.py:18, 107-120` | Keep pure declarative lane/model catalogs in `src/config/catalog.ts` with zero side effects at import time. Both `llm.ts` and `laneConfig.ts` import `catalog.ts`. |
| **Copy-pasted functions across modules** | `timeline.py:409` (`_keymap`, `_adj_keys`) & `writer.py:230` (`SHOT_MIN_S`) | Extract pure geometry/ordering helpers (`panelOrderKey`, `keymap`, `adjKeys`, `SHOT_MIN_S`) into `src/domain/panels.ts` with zero heavy dependencies. |
| **Hidden module globals & thread-locals** | `writer.LAST_WINDOW`, `writer.LAST_BUDGET`, `slicer.LAST_STATS`, `lappy._tls.remote`, `telemetry._tls` | Return explicit result objects (`{ script, windowTxt, wordBudget }`) and pass an explicit `RunContext` (or `AsyncLocalStorage` only for telemetry trace context). |
| **Node -> Python CLI subprocess bridge** | `player/status.js`, `lanes.js`, `jobs.js`, `library-delete.js` | Import `pipeline-v2` TypeScript modules directly into `player/` in-process. |

---

## 4. Target Directory Layout (`/home/shair/pipeline-v2/`)

```text
/home/shair/pipeline-v2/
├── package.json
├── tsconfig.json                 # strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true
├── safe-migration.md
├── src/
│   ├── contracts/                # Zod schemas + TS types + byte-exact hash functions
│   │   ├── schemas.ts            # Manifest, Obs, Bible, Shot, Lanes, Jobs, Telemetry
│   │   ├── hashes.ts             # briefHash, schemaHash, pagesHash, promoCacheHash, narrationCacheKey
│   │   └── briefs.ts             # Frozen prompts (byte-identical to v1 briefs.py so brief_hash matches)
│   ├── domain/
│   │   └── panels.ts             # Shared panel ordering (panelOrderKey, keymap, adjKeys, SHOT_MIN_S)
│   ├── locks/
│   │   └── seriesLock.ts         # flock(2) wrapper matching series_lock.py (.series.lock, lanes.lock)
│   ├── config/
│   │   ├── catalog.ts            # Pure static model & render lane definitions (no side effects)
│   │   ├── laneConfig.ts         # Validated lanes.json read/write with optimistic revision control
│   │   └── renderPolicy.ts       # Effective render plan & availability resolution
│   ├── telemetry/
│   │   ├── telemetry.ts          # Atomic status JSON snapshots + /proc startTicks binding
│   │   └── statusProbe.ts        # In-process replacement for player/status_probe.py
│   ├── intake/
│   │   ├── ingest.ts             # ZIP/CBZ extraction, ComicInfo parsing, page numbering
│   │   ├── intake.ts             # GDrive preflight/download, job queue state machine
│   │   ├── promoBlock.ts         # R1-R4 scanlator/domain/credit blocklist builder + promo_sources.json
│   │   └── voicePreview.ts       # Cached voice preview generator
│   ├── llm/
│   │   └── client.ts             # Multi-lane OpenAI/SSE client, retry/backoff, FilterBlocked rescue
│   ├── stages/
│   │   ├── slicer.ts             # sharp-based gutter detection, aspect-aware floor, straddle stitching
│   │   ├── reader.ts             # 12-panel batch vision reader, id_audit, bible merge, alias uniqueness
│   │   ├── scout.ts              # Opening chapter/hook selector & context digest
│   │   ├── writer.ts             # Story writer (story_writer + legacy fallback) & continuity window
│   │   ├── visualMatcher.ts      # Contact-sheet builder + vision semantic panel matcher & reviewer
│   │   ├── factCheck.ts          # Deterministic grounding, continuity, and promo lint
│   │   ├── cleaner.ts            # MIT batch orchestration + local sharp promo_mask hard-blur + vision gates
│   │   └── timeline.ts           # TTS synthesis (edge/eleven/external), pickPanels, borrowRun, buildShots
│   ├── workers/
│   │   ├── lappy.ts              # Tailscale SSH remote worker probe, circuit breaker, rsync transfers
│   │   ├── cloudlane.ts          # Docker sbx cloud render lease, TTL, 2-slot flock, auto-pause
│   │   └── renderlane.ts         # Local/Laptop/Cloud render queue & capfree-node execution
│   ├── player/                   # Unified TypeScript Player server (in-process imports, zero Python execFile)
│   └── cli/
│       └── run.ts                # Drop-in CLI replacement for `run.py`
├── remotion-studio/              # Studio composition sharing `Shot` types with `src/contracts/schemas.ts`
└── tests/                        # Golden-file parity tests against read-only v1 fixtures
```

---

## 5. Priority-Ordered Migration Roadmap

Each phase is ordered from **lowest risk / highest immediate foundation value** to **most sensitive algorithmic stage**, with a strict **Exit Gate** before moving to the next phase.

---

### Priority 0: Project Scaffold, Contracts, Schemas, Hash Parity & File Locks
**Scope:** Initialize `/home/shair/pipeline-v2` (`package.json`, `tsconfig.json`, `vitest`), port prompt constants, hash functions, Zod schemas, and `seriesLock`.
* **Port from `/home/shair/manhwa-pipeline/pipeline/`:**
  * `briefs.py` -> `src/contracts/briefs.ts` (keep prompt strings byte-identical, including whitespace/newlines).
  * Hash functions from `reader.py`, `slicer.py`, `cleaner.py`, `timeline.py`, `promo_block.py` -> `src/contracts/hashes.ts`.
  * `series_lock.py` -> `src/locks/seriesLock.ts`.
  * Zod schemas for `manifest.json`, `manifest.meta.json`, `bNN.json`, `obs_<ch>.json`, `bible.json`, `promo_block.json`, `shots.json`, `report.json`, and `lanes.json` -> `src/contracts/schemas.ts`.
* **Risk:** If `briefHash(1)` (`9529b2f7`) or `briefHash(4)` (`821ef7aa`) differs by 1 character, v2 will mark all existing series caches as `STALE` and re-bill vision calls.
* **Exit Gate (Must Pass 100%):**
  1. Unit test asserts `briefHash(1) === "9529b2f7"` and `briefHash(4) === "821ef7aa"`, and `schemaHash()` matches Python `reader.schema_hash()`.
  2. Read-only validation test loads existing `/home/shair/manhwa-pipeline/series/*/out/obs_*.json`, `bible.json`, `panels/*/manifest.json`, and `ch*/video/shots.json` through the new Zod schemas with **0 parse errors**.
  3. Lock test proves `seriesLock.ts` honors `LOCK_SH` and `LOCK_EX | LOCK_NB` semantics identically to `series_lock.py`.

---

### Priority 1: Control Plane, Telemetry & Unified Player Server
**Scope:** Port `lane_config.py`, `lane_registry.py`, `render_policy.py`, `telemetry.py`, `player/status_probe.py`, and `player/*.js` into TypeScript with direct in-process calls.
* **Why Priority 1:**
  * Zero LLM calls, zero TTS calls, zero media cost.
  * Deletes the `ast.parse("llm.py")` hack in `lane_config.py` and the duplicated `FORBIDDEN_FIELDS` across `player/lanes.js`, `player/jobs.js`, and `pipeline/lane_config.py`.
  * Eliminates cold Python subprocess spawning on every `/api/status`, `/api/lanes`, and `/api/library` delete request.
* **Port:**
  * `lane_registry.py` + `lane_config.py` + `render_policy.py` -> `src/config/`.
  * `telemetry.py` + `player/status_probe.py` -> `src/telemetry/`.
  * `player/server.js`, `status.js`, `lanes.js`, `jobs.js`, `library-delete.js` -> `src/player/`.
* **Exit Gate (Must Pass 100%):**
  1. Equivalents of `test_lane_config.py`, `test_model_lanes.py`, `test_render_policy.py`, `test_series_lock.py`, and `test_status.py` pass in `pipeline-v2`.
  2. `lanes.json` schema and revision semantics match v1 byte-for-byte.

---

### Priority 2: Mechanical Intake, Ingest & Promo Blocklist
**Scope:** Port deterministic archive/file/regex stages that make zero LLM calls.
* **Port:**
  * `promo_block.py` + `promo_sources.json` (`Block`, R1–R4 rules, registry merge) -> `src/intake/promoBlock.ts`.
  * `ingest.py` (ZIP/CBZ extraction, natural chapter sorting, page renormalization) -> `src/intake/ingest.ts`.
  * `voice_preview.py` -> `src/intake/voicePreview.ts`.
  * `intake.py` (Google Drive preflight/download, SSRF/redirect guards, job state machine) -> `src/intake/intake.ts`.
* **Exit Gate (Must Pass 100%):**
  1. Running `promoBlock.ts` (in read-only memory mode) against `/home/shair/manhwa-pipeline/series/*` produces the **exact same** `blocked`, `seeds`, `domains`, and `hash` as `promo_block.py`.
  2. Running `ingest.ts` on a test archive in `/tmp/opencode/` produces byte-identical chapter folders and page filenames as `ingest.py`.
  3. Equivalents of `test_intake.py`, `test_voice_preview.py`, and `test_promo_block_registry.py` pass.

---

### Priority 3: LLM Client, Fact Check, Reader & Scout
**Scope:** Port the vision reader, bible folding, alias resolution, and deterministic fact checker.
* **Port:**
  * `llm.py` -> `src/llm/client.ts` (multi-lane failover, per-lane semaphores, SSE stream collector for `workbuddy`, JSON extractor `parseJson`, base64 image encoder via `sharp`, `FilterBlocked` error classification).
  * `fact_check.py` -> `src/stages/factCheck.ts`.
  * `reader.py` -> `src/stages/reader.ts` (`readChapter`, `idAudit`, `normBox`, `normPromoBbox`, `applyPromoMeta`, `castBlock`, `mergeBible`, `enforceAliasUniqueness`).
  * `scout.py` -> `src/stages/scout.ts`.
* **Exit Gate (Must Pass 100%):**
  1. **Zero-Call Cache Replay:** Run `reader.ts` on a scratch copy of a cached series -> must report `cache hit (0 API calls)` on every chapter and assemble the exact same `obs_<ch>.json`.
  2. **Deterministic Bible Replay:** Replay `mergeBible` across all cached `obs_ch*.json` files of 3 multi-chapter series (feeding cached `judge_cache.json` verdicts) -> resulting `bible.json` must match Python `merge_bible` key-for-key (`characters`, `aliases`, `visual_now`, `covered`, `links`).
  3. **Fact Check Parity:** Run `factCheck.ts` on all existing `script*.md` + `transcript.md` files (read-only) -> must return the exact same issue strings as `fact_check.py`.

---

### Priority 4: Timeline, TTS Engines & Cleaner Orchestration
**Scope:** Port audio synthesis, panel selection/swapping/borrowing, shot timing, and bubble/promo cleaning.
* **Port:**
  * `timeline.py` + `say.py` + `audio_check.py` -> `src/stages/timeline.ts`.
    * Preserves `parseScript`, `pickPanels` adjacency-first ladder, `_borrowRun`, reserved future anchors, callback panels, and `buildShots`.
    * Supports all 3 TTS engines (`edge-tts`, ElevenLabs via `gsk`, and `external` JSON-stdin subprocess protocol) with `.txt` sidecar content proofs (`I-24`).
  * `promo_mask.py` + `cleaner.py` -> `src/stages/cleaner.ts`.
    * Port `blurPromoRegions` pixelation + Gaussian blur using `sharp` + typed `Uint8Array` buffers.
    * Keep `_promo_cache_hash` (`pmask-v4`) and `.promo_boxes.json` sidecar validation compatible with existing `out/cleaned/` caches.
* **Exit Gate (Must Pass 100%):**
  1. **Golden `shots.json` Test:** Given existing `script*.md`, `obs_<ch>.json`, `manifest.json`, and cached `line_NNN.mp3` files across 20 chapters (read-only), `timeline.ts::buildShots` must emit a `shots.json` that is **100% identical** to Python `timeline.py::build_shots`.
  2. **Cleaner Cache Hit Test:** On a scratch copy of a chapter with existing `out/cleaned/<ch>/*.png` + `.done` + `.promo_boxes.json`, `cleaner.ts` hits cache on 100% of panels with 0 tool/vision runs.
  3. Equivalents of `test_external_tts.py`, `test_promo_mask.py`, and `test_promo_cleaner.py` pass.

---

### Priority 5: Render Lanes, Remote Bridges & Main Orchestrator
**Scope:** Port `lappy.py`, `cloudlane.py`, `renderlane.py`, and `run.py`.
* **Port:**
  * `lappy.py` -> `src/workers/lappy.ts` (SSH probe, load/RAM/disk gate, 2-failure circuit breaker, `rsync` push/pull).
  * `cloudlane.py` -> `src/workers/cloudlane.ts` (`sbx` cloud sandbox lease, `.gate`/`.use` locks, studio signature sync, 2-slot remote flock, auto-pause on idle).
  * `renderlane.py` -> `src/workers/renderlane.ts` (worker pool, `_capfree_node` capability-stripped node copy for `/tmp` shm safety, per-lane routing).
  * `run.py` -> `src/cli/run.ts` (`--status`, `--clear-cache`, `--video`, `--force`, `--scout`, `--reader-captions`, continuity gate `I-15`, hook echo dropper).
* **Exit Gate (Must Pass 100%):**
  1. `run.ts <series> --status` output matches `python3 /home/shair/manhwa-pipeline/pipeline/run.py <series> --status` across all series.
  2. Equivalents of `test_cloudlane.py`, `test_cloud_lifecycle.py`, and `test_renderlane_cloud.py` pass.

---

### Priority 6: Slicer, Writer & Visual Matcher (Algorithmic Core)
**Scope:** Port pixel-level page slicing (`slicer.py`) and story/matcher generation (`writer.py`, `story_writer.py`, `visual_matcher.py`).
* **Why Last:**
  * `slicer.py` has 11 tuned pixel rules (`find_cuts`, `trim` dark-branch median guard, `art_bounds`, `interior_gutters`, `short_wide_panel`, `weld_is_sound`, `RESLICE_FUSED`).
  * `writer.py` has dead legacy experiments noted in `TODO.md` Section 3 (`moment.py`, `MATCH_SAMPLES` consensus voting, `USE_EVENT_PRIOR`, `_pred_map`, `_shots_to_script`) that should be dropped rather than ported.
* **Port:**
  * `slicer.py` -> `src/stages/slicer.ts` using `sharp` to decode pages to grayscale `Float32Array`/`Uint8Array` and running the exact row-mean/variance/run algorithms.
  * `story_writer.py` + `visual_matcher.py` + active parts of `writer.py` -> `src/stages/writer.ts` and `src/stages/visualMatcher.ts` (using `sharp` to compose contact sheets and detail cards).
* **Exit Gate (Must Pass 100%):**
  1. **Slicer Pixel Parity:** Run `slicer.ts` on 10 real chapters in `/tmp/opencode/` and compare `manifest.json` against Python `slicer.py`: panel count, `page`, `idx`, `w`, `h`, `page_span`, `art_top`, and `art_bottom` must match within `±1px` / `±0.002`.
  2. **Story & Matcher Validation Parity:** All schema/contract validators (`validatePlan`, `validateDraft`, `validateReview`, semantic matcher validation) pass unit and fixture tests.

---

### Priority 7: Cutover & Decommissioning `/home/shair/manhwa-pipeline`
Do **not** retire `/home/shair/manhwa-pipeline` until every item below is checked off:

- [x] **1. Full End-to-End Chapter Run in `/home/shair/pipeline-v2`:** Ingest and run 1 complete chapter end-to-end producing `obs_ch1.json`, `bible.json`, `script.md`, `shots.json`, and `video.mp4` with `fact_check: PASS`.
- [x] **2. Zero-Regression Cache Check:** Run `pipeline-v2` `--status` pointing at `/home/shair/manhwa-pipeline/series` (read-only) and confirm 0 unexpected `STALE` batches and 0 re-billed calls on completed chapters.
- [x] **3. Player Control Center Check:** Verify `/api/status`, `/api/lanes` (GET/PUT/reset), `/api/intake` (catalog, preview, enqueue, retry, continue), and chapter video deletion work in-process with zero `python3` subprocesses.
- [x] **4. Point Live Series & Service to `/home/shair/pipeline-v2`:** Move/repoint `series/`, `downloads/`, `thumbnails/`, and the Player service to `/home/shair/pipeline-v2`, then archive `/home/shair/manhwa-pipeline`.
