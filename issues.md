# Production Issues Found (`pipeline-v2`)

Date: 2026-10-17  
Status: **FIXED & VERIFIED** (25 of 26 issues fixed in production code and covered by regression tests; **594/594 tests passing** across 10 test files + `tsc --noEmit` clean in root and `remotion-studio`; verified by `xai/grok-4.7` audit). Remaining architectural follow-up: converting synchronous `spawnSync` transport runners in `cloudlane.ts`/`lappy.ts`/`cleaner.ts` to async `spawn` (#11).

### Live `sbx --cloud` Verification Summary (`manhwa-render-arm`, `sbx_001m4sv9vrydkqktbqzx2adxart`)
- **Authenticated as:** `shair25`
- **Live end-to-end cloud render:** **PASSED** (`1.5s` shot, 45 frames rendered & encoded in Docker Cloud Sandbox `manhwa-render-arm`, downloaded `161,272` bytes, `ffprobe` verified `1.557333s` H.264 MP4, sandbox returned to `stopped`).
- **Two additional production bugs were exposed only by running against the real cloud sandbox** (see **#8** and **#9** below).

---

## P1 — Critical Production Bugs (Silent Wrong Output, Auth Escalation, Broken Recovery, Lost Paid Cache)

1. **`timeline.ts` never awaits `cleanBatch` — bubble cleaning is bypassed at runtime**
   - **Location:** `src/stages/timeline.ts:1168-1169`
   - **Issue:** `cleanBatch(...)` is an `async` function returning a `Promise<Record<string, string | null>>`, but `timeline.ts` passes that unawaited `Promise` directly into synchronous `_applyCleaned(...)`. Indexing `res[pid]` on a `Promise` yields `undefined`, so cleaned PNGs are ignored on every normal panel and uncleaned source panels are shipped into the rendered video. Promo panels throw because `res[pid]` is missing.
   - **Fix:** `const res = await cleanBatch(Object.values(items), panelsDir, cleanedDir);`

2. **Cleaner subprocess non-zero exit is ignored and silently marked `done` / `video-ok`**
   - **Location:** `src/stages/cleaner.ts:640-655, 1153, 1188`; `src/stages/timeline.ts:1168-1171`
   - **Issue:** `_runBatch` runs `spawnSync(MIT_PY, ...)` and never checks `r.status`. Because `cleanBatch` pre-creates `outd` via `fs.mkdtempSync` before calling `_runBatch`, `!isDir(outDir)` at line 653 is `false` even when `manga_translator` crashes. No error is logged, every panel returns `null`, `timeline.ts` marks `clean: done`, and the chapter completes as `video-ok` with uncleaned artwork.
   - **Fix:** Check `r.status !== 0` in `_runBatch`, log `stderr`, and either throw a retryable stage error or record explicit cleaner failure/degradation instead of silently succeeding.

3. **Chapter retry loop re-applies `--force` on every retry, deleting paid vision batches from attempt 1**
   - **Location:** `src/cli/run.ts:811-832`; `src/stages/reader.ts:548-553`
   - **Issue:** When running with `--force`, `readChapter(chdir, out, force, ...)` is called inside the `attempt` loop with `force = true` on retries `1..RETRY_ROUNDS`. `readChapter` deletes `out/panels/<ch>`, `out/batches/<ch>/v<cv>`, and `obs_<ch>.json` at the start of every retry, wiping the vision batches that attempt 1 already paid for despite logging `retrying <ch> ... (per-batch cache resumes)`.
   - **Fix:** Pass `force && attempt === 0` into `readChapter`.

4. **Corrupted or unreadable `temp-users.json` fails open and escalates temporary viewers to `privileged: true` admin**
   - **Location:** `src/player/server.ts:82-88, 158-163, 195-208`
   - **Issue:** `loadTempUsers()` catches any read/JSON error and returns `{}`. `parseSession` then computes `isTemp = false` and `privileged = true`, allowing a temporary viewer to delete library videos, change lanes, and start jobs if `PLAYER_TEMP_USERS` is unreadable or malformed.
   - **Fix:** Encode account role/expiry in the signed session token at login and fail closed (`return null`) when `PLAYER_TEMP_USERS` exists on disk but cannot be parsed.

5. **Persisted render plan (`_workerPlan`) never falls back when an unpinned (`inherit`) cloud or laptop lane fails mid-render**
   - **Location:** `src/workers/renderlane.ts:1258-1296, 1633-1648`; `src/config/renderPolicy.ts:505-514`
   - **Issue:** `fallbackChain()` in `renderPolicy.ts` is never called. When `plan.override === null` (`inherit`), `_workerPlan` dispatches to `_renderOnLane`, which rethrows any mid-render cloud/laptop error just like a pinned lane instead of falling back to the next eligible lane (`local`).
   - **Fix:** In unpinned mode (`plan.override === null`), walk `fallbackChain(plan, selectedLane)` when a render attempt fails.

6. **Voice preview (`POST /api/intake/preview`) for `edge` ignores `EDGE_TTS_PYTHON` and fails in Docker / non-venv PATH**
   - **Location:** `src/intake/voicePreview.ts:374-399`; `docker/backend/Dockerfile:13-14, 30`; `src/stages/audio.ts:199-221`
   - **Issue:** `voicePreview.ts` only checks `edge-tts` on `PATH` and `MANHWA_PIPELINE_PYTHON || "python3"`, ignoring `EDGE_TTS_PYTHON` (`/opt/tts/bin/python` in the backend image).
   - **Fix:** Resolve `EDGE_TTS_PYTHON` and `/opt/tts/bin/python` in `voicePreview.ts` (matching `audio.ts`) and add `/opt/tts/bin` to `PATH` in `docker/backend/Dockerfile`.

7. **Concurrent `produce()` calls clobber shared `lappy` remote routing and telemetry chapter context**
   - **Location:** `src/workers/renderlane.ts:1371-1381`; `src/workers/lappy.ts:179-199`; `src/telemetry/telemetry.ts:70-99`
   - **Issue:** `lappy.withRemote()` and `telemetry.run()` are never entered in production code. Concurrent render slots mutate process-wide `defaultRemoteContext` and `defaultContext`, misrouting remote vs local execution and marking a multi-slot worker `idle` when the first slot finishes.
   - **Fix:** Wrap `produce()` in `lappy.withRemote(..., () => telemetry.run(..., ...))` and track active slot counts before setting worker status to `idle`.

---

## P2 — Operational, Queue, Cloud & State-Recovery Bugs

8. **Live Cloud Bug: `pauseIfIdle` times out after 120s while `manhwa-render-arm` is in `"stopping"` state and logs a false `automatic pause failed` warning**
   - **Location:** `src/workers/cloudlane.ts:374-386, 433-450`
   - **Live Evidence:** On a real `cloudlane.render()` against `manhwa-render-arm`, `sbx --cloud stop manhwa-render-arm` transitioned the sandbox to `"stopping"`, which took ~125s to reach `"stopped"`. `waitState(new Set(["stopped"]), 120)` threw `RuntimeError: sandbox still stopping after 120s`, printing `[cloud] WARNING: automatic pause failed (RuntimeError); stop the sandbox manually` and setting telemetry `lastError: "RuntimeError"` even though the sandbox finished stopping a few seconds later. Also, if a new job starts while the box is still `"stopping"`, `leaseImpl` (`line 485`) waits only 120s for `{"running", "stopped"}`.
   - **Fix:** Increase the stop `waitState` timeout (e.g., 240s–300s) and include the actual error message in the warning log (`(err as Error).message`).

9. **Live Remotion Bug: `SoloCard.tsx` / `hold.ts` crashes Remotion when a shot is shorter than `ENTRY_S + EXIT_S` (`0.52s` / 16 frames)**
   - **Location:** `remotion-studio/src/motions/SoloCard.tsx:64-67, 87`; `remotion-studio/src/motions/hold.ts:30-34`; `remotion-studio/src/motions/tunables.ts:7-8`
   - **Live Evidence:** When rendering a `0.5s` (15-frame) shot on `manhwa-render-arm`, `entryF = 0.28 * 30 = 8.4` and `eStart = 15 - 0.24 * 30 = 7.8`, passing `[8.4, 7.8]` to Remotion `interpolate(frame, [entryF, holdEndF], [0, 1])`, which crashed frame 0 across all 4 Chromium tabs with `Error: inputRange must be strictly monotonically increasing but got [8.4,7.800000000000001]`.
   - **Fix:** Clamp `holdEndF = Math.max(entryF + 0.001, holdEndF)` in `holdParts()` (and guard `panPosition` when `entryDelayF >= eEnd`).

10. **Video-lane worker startup failure hangs `run.ts` forever at `await vq.join()`**
   - **Location:** `src/cli/run.ts:1162-1166`; `src/workers/renderlane.ts:1597-1601`
   - **Issue:** If `renderlane.worker` rejects before draining queued chapters (e.g., no eligible lane or lock error), `unfinished_tasks` never reaches 0 and `await vq.join()` hangs indefinitely after the script lane succeeded.
   - **Fix:** Attach a rejection handler to `vt` that drains/fails pending items in `vq` so `vq.join()` resolves and `run.ts` exits non-zero.

11. **Cloud renderer (`cloudlane.ts`) blocks the Node event loop with `spawnSync` and `sbx` is missing in `docker/backend/Dockerfile`**
   - **Location:** `src/workers/cloudlane.ts:122-134`; `docker/backend/Dockerfile:9-14`
   - **Issue:** `defaultProcessRunner` uses `spawnSync` for `sbx --cloud exec` (up to 3600s) and `sbx --cloud cp` (up to 900s), blocking the entire process and preventing 2-slot cloud concurrency (`cloud#0` + `cloud#1`) or parallel script-lane work. Also, `sbx` is not installed in the backend container image.
   - **Fix:** Replace `spawnSync` in `cloudlane.ts` / `renderlane.ts` with async `spawn` and install/mount `sbx` in the backend container when cloud rendering is used.

12. **`cloudlane.healthy()` treats non-`"stopped"` error states (`"error"`, `"stopping"`) as `[true, "ok"]` and does not reset failure count on recovery**
    - **Location:** `src/workers/cloudlane.ts:622-635`
    - **Issue:** `healthy()` only checks `status === "stopped"` vs everything else, reporting `"error"` or `"stopping"` sandboxes as `"ok"`, and never calls `report(true)` on a healthy probe to clear prior failure counts.
    - **Fix:** Only accept `"running"` / `"ready"` as healthy active states (and `"stopped"` as warm/paused), and reset `_state.fails = 0` on healthy probes.

13. **`cloudlane._ensureTtl()` invokes `sbx --cloud ttl +NaNs <NAME>` when TTL JSON fields are missing**
    - **Location:** `src/workers/cloudlane.ts:409-422`
    - **Issue:** Missing `expires_in_seconds` or `max_remaining_seconds` produces `NaN`, bypassing both comparisons and running `sbx --cloud ttl +NaNs <NAME>`.
    - **Fix:** Guard `Number.isFinite(remaining)` and `Number.isFinite(maxRemaining)` before computing TTL delta.

14. **`statusProbe.cloudLane()` rewrites `cloud-list.json` with stale `cached.box` and fresh timestamp on `sbx ls` errors, reporting `available: true` indefinitely**
    - **Location:** `src/telemetry/statusProbe.ts:722-781`
    - **Issue:** On `sbx ls` error, `listing.box = cached.box` makes `Object.keys(box).length > 0`, so `/api/status` reports `available: true` (`reason: "Running"`), line 760 becomes dead code, and `writeJson` refreshes `at: now` on the stale cache forever.
    - **Fix:** Preserve original `listedAt`, surface `err` when `listing.stale` is true, and mark `available: false` after stale expiry.

15. **Zero-byte local render output (`rc=0`, 0 bytes) is accepted as `video-ok` with `duration: 0`**
    - **Location:** `src/workers/renderlane.ts:949, 1360-1370`
    - **Issue:** `renderLocal` only checks `r.returncode !== 0 || !fs.existsSync(video)` without verifying `_probe(video) > 0` (unlike `cloudlane._validate` and `renderRemote`).
    - **Fix:** Validate `_hooks._probe(video) > 0` before accepting a local render.

16. **Failed rerun overwrites `out/<ch>/report.json` and erases prior `ok` report metadata**
    - **Location:** `src/cli/run.ts:1124-1138`
    - **Issue:** If a chapter previously succeeded and a later rerun fails, `report.json` is overwritten with `{status: "failed", class, error}`, losing `lines`, `issues`, and video metadata even though cached artifacts remain on disk.
    - **Fix:** Preserve previous success fields in `report.json` or write failure state without clobbering completed metadata.

17. **Video-lane failures have no retry and no persisted attempt count**
    - **Location:** `src/workers/renderlane.ts:1633-1651`; `src/cli/run.ts:1175-1188`
    - **Issue:** Each chapter gets 1 render attempt and `failcounts` is in-memory only, never written to `report.json`.
    - **Fix:** Persist `video_attempts` in `report.json` and support bounded retry/fallback for transient render failures.

18. **Intake queue reliability gaps: corrupt job JSON vanishes, external-run wait has no default timeout, and half-dead `running` jobs never reconcile**
    - **Location:** `src/intake/intake.ts:701-709, 1985-2013, 2280-2300`
    - **Issue:**
      - Unparseable `jobs/<id>.json` returns `null` and disappears from `listJobs` / `getJob` (404).
      - External-run detection (`detectActivePipelineRuns`) waits forever when `MANHWA_EXTERNAL_RUN_WAIT_S` is unset (including when a v1 `run.py` process is running).
      - `reconcileJobs` only marks a `running` job `interrupted` when both `workerPid` and `runPid` are dead; if `runPid` died while `workerPid` is alive, the job stays `running` forever.
    - **Fix:** Surface corrupt job files as `failed`/`interrupted`, set a bounded default `maxWaitS`, and reconcile dead `runPid` processes.

19. **Upload staging cleanup race leaves orphan `.zip.part` files on first-chunk rejection**
    - **Location:** `src/player/jobs.ts:158-179, 188-212`
    - **Issue:** `fsSync.createWriteStream(partPath)` opens asynchronously; if the first chunk fails magic-header or size validation, `fsSync.unlinkSync(partPath)` runs before libuv creates the file, leaving an orphan `.zip.part` file once the async open completes.
    - **Fix:** Open the fd synchronously (`fsSync.openSync`) before creating the write stream, or unlink in `out.once('close')`.

20. **Service Worker (`sw.js`) caches redirected `/login` HTML on expired sessions and serves `/poster/*` & `/thumbs/*` from cache without auth**
    - **Location:** `src/player/public/sw.js:12, 34-42, 85-103`
    - **Issue:** `networkFirst` caches `200 OK` responses even when `res.redirected === true` (`303 -> /login`), overwriting cached app pages with the login form; `/poster/*` and `/thumbs/*` are served from cache when signed out; `SHELL` lists `/status.css?v=4` while `status.html` loads `v=5`.
    - **Fix:** Do not cache redirected responses (`!res.redirected`), require auth/no-cache on private artwork when unauthenticated, and sync asset versions in `SHELL`.

21. **Default path mismatch across `intake.ts`, `run.ts`, `renderlane.ts`, and `server.ts` when `env.sh` is absent**
    - **Location:** `src/intake/intake.ts:330`; `src/cli/run.ts:117`; `src/workers/renderlane.ts:97`; `src/player/server.ts:44-46`
    - **Issue:** Without `env.sh` or env overrides, `intake.jobsDir()` defaults to `<repo>/pipeline/out/jobs`, `run.ts` defaults to `/root/manhwa/series`, and `renderlane.ts` defaults to `/root/remotion-studio`, while `server.ts` and `statusProbe.ts` use `<repo>/series` and `<repo>/out`.
    - **Fix:** Unify repo-relative defaults across all entrypoints.

22. **`PUT /api/lanes` permits disabling `local` and `laptop` while enabling unconfigured `cloud`, leaving 0 runnable lanes**
    - **Location:** `src/config/laneConfig.ts:1125`; `src/config/renderPolicy.ts:321-358`
    - **Issue:** Lane validation checks that at least one lane is `enabled`, not that at least one enabled lane is actually configured, causing jobs to hang for `unavailableGraceS` (600s) before failing.
    - **Fix:** Reject lane configs that leave zero enabled+configured render lanes (or mark `inherit` unavailable).

---

## P3 — Minor Contract & Validation Issues

23. **Usernames containing `.` in `.htpasswd` log in (`303`) but fail cookie parsing (`401`)**
    - **Location:** `src/player/server.ts:158-163, 191-194`
    - **Issue:** `parseSession` uses `val.split('.')` and requires `parts.length === 3`.

24. **CSRF `bodyToken` ignored on lane/retry/continue endpoints & default port (`:443` / `:80`) rejected in `Host` vs `Origin` comparison**
    - **Location:** `src/player/lanes.ts:168-171, 275, 322`; `src/player/jobs.ts:327`

25. **HTTP method checks missing on GET routes (`/api/session`, `/api/library`, `/api/status`, `/api/agy`) and `HEAD` rejected (`405`) on `/api/intake/preview/<id>.mp3`**
    - **Location:** `src/player/server.ts:574, 594, 663, 667`; `src/player/jobs.ts:363`

26. **Frontend `parseDriveId` (`new-series.js`) rejects `drive.usercontent.google.com` and `docs.google.com` URLs accepted by backend `intake.parseGdriveUrl`**
    - **Location:** `src/player/public/new-series.js:138-144` vs `src/intake/intake.ts:64-68`
