# Deep Integration & Cloud Renderer Verification Report (`pipeline-v2`)

**Date:** 2026-10-17  
**Scope:** `src/player/{server,jobs,lanes,stream,status,libraryDelete}.ts`, `src/player/public/{api,app,new-series,status-app,sw}.js`, `src/intake/{intake,ingest,voicePreview}.ts`, `src/config/{laneConfig,renderPolicy}.ts`, `src/workers/{cloudlane,renderlane,lappy}.ts`, `src/telemetry/{telemetry,statusProbe}.ts`, `docker/{frontend,backend}/*`.  
**Executable Suites:**
- `tests/deep-api-cloud.test.ts` (32 offline unit/integration/characterization tests; zero external CLI/network calls)
- `tools/deep-api-cloud-capabilities.ts` (explicit read-only host/container capability harness)
- `CONTAINER_ENGINE=podman npm run test:images` (disposable two-container Podman smoke test)

---

## Executive Answers

### 1. Are the API, frontend, and backend endpoints actually wired?
**Yes.** The Screening Room HTTP control plane (`src/player/server.ts`) is wired in-process in TypeScript without legacy Python subprocess bridges for `/api/session`, `/api/library`, `/api/library/delete`, `/api/lanes`, `/api/lanes/reset`, `/api/status`, and `/api/intake/*` (`catalog`, `jobs`, `jobs/:id`, `jobs/:id/retry`, `jobs/:id/continue`, `preview`, `preview/:id.mp3`), plus byte-range streaming for `/media/*`, `/poster/*`, and `/thumbs/*`. The two-container Podman deployment (`pipeline-v2-frontend:local` Nginx proxy + `pipeline-v2-backend:local` API-only Node service) is wired and passes end-to-end authentication, `auth_request` asset gating, CSRF forwarding, and range streaming.

Deep testing identified **11 confirmed reachable production defects** (4 P1, 5 P2, 2 P3) and **3 design/policy or standalone helper contract observations** (Items #12–#14), detailed below.

### 2. Is the cloud renderer proven working end-to-end or only simulated?
**PROVEN WORKING LIVE END-TO-END ON HOST (`manhwa-render-arm`) — WITH 2 LIVE BUGS EXPOSED.**

After authenticating `sbx login` as `shair25`, we executed the real `cloudlane.render()` lifecycle against the live Docker Cloud Sandbox `manhwa-render-arm` (`sbx_001m4sv9vrydkqktbqzx2adxart`, 8 CPUs, 16 GB RAM):
1. **Live End-to-End Render Succeeded:** `cloudlane.render` resumed `manhwa-render-arm` from `stopped`, verified `.kit-ready` / `remotion` / `flock` / RAM / disk, extended TTL, synced `remotion-studio`, uploaded panel + audio assets + `shots.json`, rendered 45/45 frames (`Recap`, H.264, 4x concurrency), downloaded `161,272` bytes to `video.mp4.part`, validated duration `1.557333s` with `ffprobe`, atomically renamed `video.mp4`, cleaned remote dirs, and stopped the sandbox (`status: "stopped"`).
2. **Live Bug Exposed #1 (`src/workers/cloudlane.ts:374, 434`):** `sbx --cloud stop manhwa-render-arm` transitions the sandbox through `"stopping"` for ~125s before reaching `"stopped"`, exceeding `waitState(new Set(["stopped"]), 120)` and logging a false `[cloud] WARNING: automatic pause failed (RuntimeError); stop the sandbox manually`.
3. **Live Bug Exposed #2 (`remotion-studio/src/motions/SoloCard.tsx:87`, `hold.ts:31`):** Any shot shorter than `ENTRY_S + EXIT_S` (`0.52s` / 16 frames) passes a decreasing `inputRange` (`[8.4, 7.8]`) to `interpolate()`, crashing Remotion frame 0 in the cloud sandbox.
4. **Remaining Deployment Gaps:** `MANHWA_RENDER_CLOUD` is still unset by default, `sbx` is not installed in `docker/backend/Dockerfile`, and `src/workers/cloudlane.ts:122` still uses synchronous `spawnSync`.

---

## Part A: Confirmed Reachable Production Defects (1–11)

### P1 — High-Impact Correctness, Security & Reliability Defects

#### 1. [P1] Corrupted or unreadable `temp-users.json` fails open and escalates temporary viewing accounts to full `privileged: true` admin
- **Citation:** `src/player/server.ts:82-88`, `src/player/server.ts:195-208`
- **Expected:** If a user is a temporary viewer or if `PLAYER_TEMP_USERS` (`temp-users.json`) is unreadable/corrupted, `parseSession` must fail closed (`null` or `privileged: false`). Cookie payload or session verification must never silently grant administrative privileges (`privileged: true`) when `temp-users.json` fails to parse.
- **Actual:** `makeCookie(user)` (`src/player/server.ts:158-163`) signs only `${user}.${exp}` without encoding account privilege/temp status. On every request, `parseSession` calls `loadTempUsers()` (`src/player/server.ts:82-88`), which catches any `ENOENT`/`EACCES`/`SyntaxError` and returns `{}`. Consequently, `isTemp` evaluates to `false` and `privileged: !isTemp` becomes `true`, allowing a temporary viewer to delete library videos (`POST /api/library/delete`), mutate lane policy (`PUT /api/lanes`), and enqueue paid jobs (`POST /api/intake/jobs`).
- **Proposed Fix:** Encode account role (`admin` vs `temp`) inside the HMAC-signed cookie payload (`${user}.${exp}.${role}.${sig}`) at login time, and fail closed (`return null`) in `loadTempUsers()` when `TEMP_USERS_FILE` exists on disk (`fsSync.existsSync`) but cannot be read or parsed as a plain JSON object.

#### 2. [P1] Voice preview (`POST /api/intake/preview`) for default `edge` provider fails in `pipeline-v2-backend:local` and on default host env because `voicePreview.ts` ignores `EDGE_TTS_PYTHON`
- **Citation:** `src/intake/voicePreview.ts:374-399`, `docker/backend/Dockerfile:13-14, 30`, `src/stages/audio.ts:199-221`, `src/intake/intake.ts:1213`
- **Expected:** Clicking "Listen sample" (`POST /api/intake/preview` with `{ provider: "edge", voice: "en-US-AndrewMultilingualNeural" }`) should synthesize a sample using the configured Edge TTS Python environment (`EDGE_TTS_PYTHON=/opt/tts/bin/python` in Docker, or fallback venv on host), matching `src/stages/audio.ts:200`.
- **Actual:**
  - `src/intake/intake.ts:1213` (`preflightTtsProvider`) hardcodes `if (engine === "edge") return [true, null];` without checking whether `edge-tts` is runnable.
  - `src/intake/voicePreview.ts:374-399` (`generateEdge`) only checks `commandOnPath("edge-tts", env)` and `resolveEnv(env).MANHWA_PIPELINE_PYTHON || "python3"`.
  - In `docker/backend/Dockerfile:13-14, 30`, `edge-tts` is installed in `/opt/tts/bin` and exposed via `EDGE_TTS_PYTHON=/opt/tts/bin/python`, while `/opt/tts/bin` is not in `PATH` and `MANHWA_PIPELINE_PYTHON` is unset. `generateEdge` invokes `/usr/bin/python3 -c "import edge_tts..."`, which fails with `ModuleNotFoundError` and returns HTTP 400 `Voice preview generation failed: edge-tts is not available`.
- **Proposed Fix:** Update `generateEdge` in `src/intake/voicePreview.ts:374-395` to check `env.EDGE_TTS_PYTHON`, `env.MANHWA_PIPELINE_PYTHON`, and `/opt/tts/bin/python` (matching `src/stages/audio.ts:199-221`), and add `/opt/tts/bin` to `PATH` in `docker/backend/Dockerfile`.

#### 3. [P1] Persisted render plan (`_workerPlan` -> `_renderOnLane`) never uses `fallbackChain` when an unpinned lane (`cloud` or `laptop`) fails mid-render
- **Citation:** `src/workers/renderlane.ts:1222-1296`, `src/workers/renderlane.ts:1633-1648`, `src/config/renderPolicy.ts:505-514`
- **Expected:** When a persisted `lanes.json` is active with `override: null` (`inherit`), the enabled lanes form a priority chain (`Primary`, `Fallback 1`, `Fallback 2` in `src/player/public/status-app.js:306` and `fallbackChain()` in `src/config/renderPolicy.ts:505`). If `cloud` passes the non-waking `sbx ls` pre-dispatch check (`healthy() -> [true, "paused; checked on render"]`) but fails when `renderCloud` actually wakes/probes/syncs/renders the chapter, the chapter should fall back to the next eligible lane in `fallbackChain(plan, lane)` (e.g., `local`).
- **Actual:** `fallbackChain` in `src/config/renderPolicy.ts:505` is dead code (never called anywhere in `src/`). `_workerPlan` dispatches the chapter to `produce(..., { lane: "cloud" })` -> `_renderOnLane(..., "cloud")`, which treats every persisted-plan dispatch identically to a hard pin (`throw e` at `src/workers/renderlane.ts:1286, 1294`), immediately marking the chapter `status: "video-failed"` without attempting `local`.
- **Proposed Fix:** When `plan.override === null` (unpinned), iterate through `fallbackChain(plan, selectedLane)` in `_workerPlan` / `produce` on render failure (calling `report(false)` on the failed remote/cloud transport and trying the next eligible available lane), reserving no-fallback failure strictly for pinned runs (`plan.override !== null`).

#### 4. [P1] Concurrent `produce()` calls clobber shared `lappy.useRemote()` and `telemetry` context because `lappy.withRemote()` and `telemetry.run()` are never entered
- **Citation:** `src/workers/renderlane.ts:1371-1381`, `src/workers/lappy.ts:179-199`, `src/telemetry/telemetry.ts:70-99, 184-195, 247-255`
- **Expected:** When `renderlane.worker` runs multiple chapter slots concurrently (e.g., `laptop` + `cloud` or `cloud#0` + `cloud#1`) or runs alongside the script lane in `src/cli/run.ts`, each async task must have isolated `AsyncLocalStorage` state for `lappy.useRemote()` and `telemetry.stageCurrent()`.
- **Actual:** Neither `lappy.withRemote()` (`src/workers/lappy.ts:188`) nor `telemetry.run()` (`src/telemetry/telemetry.ts:87`) is called anywhere in `src/`. Instead, `produce()` (`src/workers/renderlane.ts:1372-1380`) calls `tel.bind({ chapter: ch, worker: wid })` and `lp.setRemoteForThread(Boolean(remote))`, which mutate the single process-wide fallback objects `defaultContext` and `defaultRemoteContext`. When Slot 1 (`laptop`, `remote=true`) is awaiting inside `prepare()` and Slot 2 (`cloud` or `local`, `remote=false`) starts, Slot 2 overwrites `defaultRemoteContext.remote = false` and `defaultContext.chapter = "ch2"`, routing Slot 1's cleaner/render locally and attributing Slot 1's `stageCurrent()` calls to `ch2`. Additionally, when the first of two concurrent cloud slots finishes `produce()`, its `finally` block (`src/workers/renderlane.ts:1379`) sets `tel.worker(wid, { status: "idle" })` while the second slot is still actively rendering on the same worker.
- **Proposed Fix:** Wrap the body of `produce()` in `lappy.withRemote(Boolean(remote), () => telemetry.run({ chapter: ch, worker: wid }, async () => { ... }))`, and only mark a multi-slot worker `"idle"` when all active slots on that worker have completed.

---

### P2 — Medium-Impact Functional, API & Operational Defects

#### 5. [P2] `cloudlane.healthy()` treats non-`"stopped"` error states (e.g. `"error"`, `"failed"`, `"stopping"`) as `[true, "ok"]` and does not reset `_state.fails` on a healthy probe
- **Citation:** `src/workers/cloudlane.ts:625-635`
- **Expected:** `cloudlane.healthy()` should only treat usable sandbox states (`"running"`, `"ready"`, `"stopped"`) as healthy (`true`), rejecting `"error"`, `"failed"`, or `"deleting"` with `[false, ...]`, and a healthy probe should reset `_state.fails = 0` so a single stale failure from much earlier does not cause the next single failure to trip the 600s breaker.
- **Actual:** Line 628 executes `result = [true, h.status === "stopped" ? "paused; checked on render" : "ok"];`, returning `[true, "ok"]` for any status other than `"stopped"` (including `"error"`), and never calls `report(true)` on a successful probe.
- **Proposed Fix:** Check `if (h.status === "stopped") result = [true, "paused; checked on render"]; else if (h.status === "running" || h.status === "ready") result = [true, "ok"]; else throw new RuntimeError(\`sandbox status is \${h.status}\`);` and reset `_state.fails = 0` on healthy probe.

#### 6. [P2] `statusProbe.cloudLane()` overwrites `cloud-list.json` with stale `cached.box` on `sbx ls` errors and reports `available: true` indefinitely (unreachable dead code on line 760)
- **Citation:** `src/telemetry/statusProbe.ts:722-781`
- **Expected:** When `listSandbox(name)` returns `[null, err]` after `cloud-list.json` previously cached a box, `/api/status` should surface the error/staleness instead of reporting the cloud worker as healthy (`available: true`, `reason: "Running"`) forever.
- **Actual:** At `src/telemetry/statusProbe.ts:730-735`:
  ```ts
  if (err && cached.name === name && cached.box) {
    listing.box = cached.box;
    listing.stale = true;
    listing.listedAt = cached.at;
  }
  writeJson(cachePath, listing);
  ```
  Because `listing.box` is populated with `cached.box` (which has 5 keys), `raw` is `"running"` or `"stopped"`, so lines 744-750 set `available = true` and `reason = "Running"` (or `"Stopped · warm, not billed"`). Line 760 (`if (listing.stale && err && !Object.keys(box).length) reason = err;`) is **unreachable dead code** because `listing.stale` is only set when `cached.box` is truthy (`Object.keys(box).length > 0`). Furthermore, `writeJson` writes `cached.box` back with `at: now`, perpetuating the stale box across all future 30s intervals, and line 723 (`(process.env.MANHWA_RENDER_CLOUD || '').trim() || String(cached.name || '').trim()`) keeps showing the cloud lane even after `MANHWA_RENDER_CLOUD` is unset.
- **Proposed Fix:** Do not overwrite `at: now` when preserving a stale `cached.box`, expire stale cache entries after a bounded age, mark `available = false` (or include `stale: true` and `reason: "${reason} (stale: ${err})"`), and return `null` when `process.env.MANHWA_RENDER_CLOUD` is empty.

#### 7. [P2] Service Worker (`sw.js`) caches redirected `/login` HTML over app pages when session expires and serves `/thumbs/*` / `/poster/*` from cache without auth
- **Citation:** `src/player/public/sw.js:12, 34-42, 85-103`, `src/player/public/status.html:14`
- **Expected:** When a session cookie expires and a navigation request (`GET /`, `/status.html`, `/new-series.html`) receives `303 See Other -> /login` (which resolves to `200 OK` login HTML with `res.redirected === true`), the Service Worker must not cache the login page HTML under the app route URL, and must not serve private series posters/thumbnails after session expiry. Also, `SHELL` in `sw.js:12` should match the CSS query version in `status.html:14`.
- **Actual:**
  - `networkFirst(req)` (`src/player/public/sw.js:34-42`) checks `if (res.ok)` without checking `!res.redirected`. When `fetch(req)` follows `303 -> /login`, `res.ok` is `true`, so `caches.open(VERSION).then((c) => c.put(req, copy))` overwrites the cached app shell (`/`, `/status.html`, `/new-series.html`) with the login HTML.
  - `/thumbs/*` falls into the catch-all `if (sameOrigin)` cache-first handler (`src/player/public/sw.js:92-103`), and `/poster/*` uses `staleWhileRevalidate` (`src/player/public/sw.js:85-88`), serving cached private artwork without hitting the server after sign-out/expiry.
  - `sw.js:12` pre-caches `/status.css?v=4`, whereas `status.html:14` requests `/status.css?v=5`.
- **Proposed Fix:** Guard cache writes with `if (res.ok && !res.redirected)`, redirect navigations to `/login` when `res.redirected && res.url.endsWith('/login')`, exclude `/thumbs/` and `/poster/` from unauthenticated cache-first fallback (or clear cache on 401), and update `sw.js:12` to `/status.css?v=5`.

#### 8. [P2] Default path divergence across `intake.ts`, `run.ts`, `renderlane.ts`, and `server.ts` when `env.sh` is absent
- **Citation:** `src/intake/intake.ts:329-332`, `src/cli/run.ts:117`, `src/workers/renderlane.ts:97`, `src/player/server.ts:45-46`
- **Expected:** In a local checkout without `env.sh` or manual env exports (`npm run player` / `npm run run`), all modules should resolve the same repository-relative `series`, `out/jobs`, and `remotion-studio` paths.
- **Actual:**
  - `intake.jobsDir()` (`src/intake/intake.ts:330`) defaults to `<repo>/pipeline/out/jobs` (legacy v1 path) when `MANHWA_JOBS_DIR` and `PIPELINE_LOG` are unset, whereas `server.ts:46`, `statusProbe.ts:33`, and `laneConfig.ts:432` default to `<repo>/out/...`.
  - `intake.seriesRoot()` and `server.ts` default to `<repo>/series`, whereas `src/cli/run.ts:117` defaults to `/root/manhwa/series` and `src/workers/renderlane.ts:97` defaults to `/root/remotion-studio`. Because `/home/shair/pipeline-v2/env.sh` does not exist, `buildPipelineEnv` throws `PreflightError` (`environment file missing`), which `executeSingleJob` (`src/intake/intake.ts:2510`) catches by falling back to `{ ...env }` without setting `MANHWA_SERIES_ROOT` or `MANHWA_STUDIO`.
- **Proposed Fix:** Change `intake.ts:330` default `logPath` to `path.join(REPO_ROOT, "out", "pipeline.log")`, and default `SERIES_ROOT` in `src/cli/run.ts:117` and `STUDIO` in `src/workers/renderlane.ts:97` (or `executeSingleJob` in `intake.ts`) to `path.join(REPO_ROOT, "series")` and `path.join(REPO_ROOT, "remotion-studio")`.

#### 9. [P2] `cloudlane._ensureTtl()` invokes `sbx --cloud ttl +NaNs <NAME>` when `expires_in_seconds` / `max_remaining_seconds` are absent from JSON
- **Citation:** `src/workers/cloudlane.ts:409-422`
- **Expected:** If `sbx --cloud ttl <NAME> --json` returns JSON without finite numeric `expires_in_seconds` or `max_remaining_seconds`, `_ensureTtl()` should either throw a descriptive `RuntimeError` or treat TTL as non-extensible.
- **Actual:** `Math.trunc(Number(undefined))` evaluates to `NaN`. Both `remaining >= TTL_BUDGET_S` (`NaN >= 5400`) and `Math.trunc(Number(ttl.max_remaining_seconds)) < TTL_BUDGET_S` (`NaN < 5400`) evaluate to `false`, so line 421 executes `_ops.capture(["ttl", "+NaNs", NAME])`.
- **Proposed Fix:** Validate `if (!Number.isFinite(remaining) || !Number.isFinite(maxRemaining)) throw new RuntimeError("invalid cloud TTL payload");`.

#### 10. [P2] `streamUploadToStaging` races async `fs.createWriteStream(partPath)` open against synchronous `fs.unlinkSync(partPath)` on first-chunk rejection, leaving orphan `.zip.part` files
- **Citation:** `src/player/jobs.ts:158-179, 188-212`
- **Expected:** When an upload stream is rejected on its first `data` chunk (e.g., bad `PK\x03\x04` magic header on `multipart/form-data` or oversized first chunk), `cleanupFail` must not leave an orphan `upload-<ts>-<hex>.zip.part` file in `jobs/uploads/`.
- **Actual:** `fsSync.createWriteStream(partPath, { mode: 0o640 })` (`src/player/jobs.ts:158`) opens `partPath` asynchronously via libuv's threadpool. When the first request chunk was buffered during `await fs.mkdir(uploadsDir)` and `req.on('data')` rejects immediately before libuv's `fs.open` completes, `cleanupFail` calls `out.destroy()` and `fsSync.unlinkSync(partPath)` (`src/player/jobs.ts:171`) before `partPath` exists. When libuv finishes `fs.open` a moment later, it creates and closes a 0-byte `.zip.part` file that remains on disk until `reconcileOrphans` runs an hour later.
- **Proposed Fix:** Open the staging file descriptor synchronously (`const fd = fsSync.openSync(partPath, 'w', 0o640); const out = fsSync.createWriteStream(partPath, { fd });`) or unlink `partPath` inside `out.once('close', ...)` when `settled` failed.

---

### P3 — Low-Impact Production API & Validation Defects

#### 11. [P3] Username containing `.` in `.htpasswd`, inconsistent CSRF `bodyToken` / default-port handling, HTTP method checks on GET-only routes, and frontend `parseDriveId` host allowlist
- **Citations:**
  - `src/player/server.ts:158-163, 191-194`
  - `src/player/lanes.ts:142-196, 275, 322, 332` & `src/player/jobs.ts:327, 339, 349, 395, 518`
  - `src/player/lanes.ts:168-171`
  - `src/player/server.ts:574, 594, 663, 667` & `src/player/jobs.ts:363`
  - `src/player/public/new-series.js:138-144` vs `src/intake/intake.ts:64-68`
- **Details:**
  1. **Dot in `.htpasswd` username (`src/player/server.ts:158-163, 191-194`):** `makeCookie` joins `${user}.${exp}.${sig}` and `parseSession` checks `const parts = val.split('.'); if (parts.length !== 3) return null;`. A username like `dot.user` logs in (`303`) but its cookie splits into 4 parts and fails `parseSession` (`401`). Fix: split from the right (`lastIndexOf('.')`).
  2. **CSRF `bodyToken` ignored (`src/player/lanes.ts:275, 322, 332` & `src/player/jobs.ts:327, 339, 349`):** `PUT /api/lanes`, `POST /api/lanes/reset`, `POST /api/intake/jobs/:id/retry`, and `POST /api/intake/jobs/:id/continue` whitelist `csrfToken` in their JSON request bodies, but call `verifyCsrf(req, session)` without passing `body.csrfToken` (unlike `POST /api/intake/jobs` at `src/player/jobs.ts:518`).
  3. **CSRF default port mismatch (`src/player/lanes.ts:168-171`):** `verifyCsrf` compares `new URL(origin).host` (which strips default ports `:443` and `:80`) against raw `req.headers.host`. If a proxy preserves `Host: example.com:443` with `Origin: https://example.com`, `verifyCsrf` rejects with `403 Origin host mismatch`.
  4. **Method checks (`src/player/server.ts:574, 594, 663, 667` & `src/player/jobs.ts:363`):** `/api/session`, `/api/library`, `/api/status`, and `/api/agy` do not check `req.method` (accepting `POST`/`DELETE` with `200 OK`), while `/api/intake/preview/<id>.mp3` (`src/player/jobs.ts:363`) checks `req.method === 'GET'` and rejects `HEAD` with `405` even though `streamFile` (`src/player/stream.ts:42-45`) supports `HEAD`.
  5. **Frontend Drive URL host check (`src/player/public/new-series.js:141`):** `parseDriveId` only allows `drive.google.com`, rejecting `drive.usercontent.google.com` and `docs.google.com` links that `ALLOWED_GDRIVE_INITIAL_HOSTS` in `src/intake/intake.ts:64-68` explicitly accepts.

---

## Part B: Design, Policy & Standalone Helper Contract Observations (12–14)

The following items are **design/policy characterizations or standalone module-contract observations**, not reachable production crashes under normal wiring:

#### 12. [Policy Characterization] `PUT /api/lanes` permits saving a render policy where the only enabled lane is unconfigured on the host
- **Citation:** `src/config/laneConfig.ts:1047-1131`, `src/config/renderPolicy.ts:321-358`, `src/workers/renderlane.ts:1656-1695`
- **Observation:** `validateRenderList` (`src/config/laneConfig.ts:1125`) requires at least one render lane to have `enabled: true`, but does not require that lane to be currently configured in the host environment (`MANHWA_RENDER_CLOUD` / `MANHWA_RENDER_REMOTE`). If an operator disables `local` and `laptop` and enables only `cloud` while `MANHWA_RENDER_CLOUD` is unset, `PUT /api/lanes` succeeds (`200`), `GET /api/intake/catalog` reports `inherit` as `available: true` while all concrete lanes are `available: false`, and a job using `inherit` waits `unavailableGraceS` (600s) before failing.
- **Recommendation:** Either warn/reject in `putLanesState` when zero enabled lanes have configured transports, or mark `inherit` unavailable in `renderOverrideOptions` when no enabled lane is configured.

#### 13. [Cache Policy Characterization] `cloudlane.healthy(maxAge = 20)` caches failed probe results for `maxAge` seconds
- **Citation:** `src/workers/cloudlane.ts:585-600, 622-635`
- **Observation:** Inside `healthy(maxAge = 20)`, a failed `_ops.listedBox()` probe calls `report(false)` (which sets `_state.fails += 1` and `_state.t = 0.0`) and then sets `_state.t = at; _state.h = { result, box: h }`. Because cached reads within the 20s `maxAge` window are not separate probe attempts, subsequent `healthy(20)` calls within 20s return the cached `[false, ...]` result without re-running `sbx --cloud ls` or incrementing `_state.fails`. Callers that want an uncached probe pass `maxAge = 0` (`healthy(0)`). Note that when `report(false)` is called after an actual render job failure (`renderlane.ts:1136, 1285`), `_state.t = 0.0` remains `0.0` and invalidates any prior cached `[true, ...]` probe as intended.

#### 14. [Standalone Helper Contract] `renderPolicy.laneAvailability(plan)` requires `setTransportDefaults()` when called directly outside `renderlane.renderPolicy`
- **Citation:** `src/config/renderPolicy.ts:95-103, 171-179, 450-481`, `src/workers/renderlane.ts:615-623, 647-654`
- **Observation:** In production worker execution, `renderlane.ts` calls `renderlane.renderPolicy.laneAvailability(plan)` (`src/workers/renderlane.ts:615-623`), which invokes `syncPolicyTransports()` (`src/workers/renderlane.ts:647-654`) to copy `_hooks.lappy.HOST` and `_hooks.cloudlane.NAME` into `renderPolicy.setTransportDefaults(...)`. Thus, production worker calls are properly wired whenever `cloudlane.NAME` is set. However, if a caller invokes the standalone `renderPolicy.buildRenderPlan(env)` with `env = { MANHWA_RENDER_CLOUD: "sbx-render-1" }` and then calls `renderPolicy.laneAvailability(plan)` directly without calling `setTransportDefaults()`, `configuredHost("cloud")` reads only `transportDefaults.cloudName` rather than `plan.lanes[i].configured` and returns `[false, "no cloud configured"]`.
- **Recommendation:** Have `renderPolicy.laneAvailability(plan)` honor `lane.configured` from the passed `plan` so standalone callers and `renderlane.renderPolicy` behave identically.

---

## Tested Route & Cloud Lifecycle Matrix

### HTTP Endpoint Matrix

| Endpoint & Method | Auth / Privilege Gate | CSRF Gate | Bad Input / Limit Handling | Result |
| --- | --- | --- | --- | --- |
| `GET /healthz`, `HEAD /healthz` | Public (200) | N/A | N/A | PASS (`X-Request-ID`, `Cache-Control: no-store`) |
| `GET /login`, `POST /login` | Public (200 / 303 / 401) | N/A | `>4096 B` -> 413 JSON; expired temp user -> 401; `dot.user` -> 303 then 401 (**Defect #11.1**) | PASS + Defect characterized |
| `GET /api/session` | Cookie required (401/200) | N/A | Bad sig, `%ZZ`, expired, outliving temp key, ghost user -> 401; corrupt `temp-users.json` -> `privileged: true` (**Defect #1**) | PASS + Defect characterized |
| `GET /api/library` | Cookie required (401/200) | N/A | Scans chapters, posters, `video_paths` arms, thumbnails | PASS |
| `POST /api/library/delete` | Privileged only (403 for temp) | Required (403) | `>2048 B` -> 413; bad slug/confirm -> 400; active shared `.series.lock` or `.part` -> 409 `pipeline_active` | PASS |
| `GET /api/lanes` | Cookie required (401/200) | N/A | Returns `config`, `defaults`, `catalog`, `renderRuntime`, `privileged`, `csrfToken` | PASS |
| `PUT /api/lanes`, `POST /api/lanes/reset` | Privileged only (403 for temp) | Required (403) | `>16384 B` -> 413; stale revision -> 409 `revision_conflict`; forbidden keys -> 400; body `csrfToken` ignored (**Defect #11.2**); disabling all configured lanes allowed (**Policy #12**) | PASS + Characterized |
| `GET /api/status` | Cookie required (401/200) | N/A | Async error containment -> 500 `{ error: "server error", requestId }` | PASS |
| `GET /api/intake/catalog` | Cookie required (401/200) | N/A | Returns providers, voices, renderLanes, limits, capabilities | PASS |
| `GET /api/intake/jobs`, `GET /api/intake/jobs/:id` | Cookie required (401/200) | N/A | Invalid job ID -> 400; missing job -> 404 | PASS |
| `POST /api/intake/jobs` (JSON GDrive) | Privileged only (403 for temp) | Required (403) | Malformed JSON / `null` / `[]` -> 400; chunked `>16384 B` -> 413; forbidden fields -> 400; non-https / folder / private IP -> 400 | PASS |
| `POST /api/intake/jobs?sourceType=upload` | Privileged only (403 for temp) | Required (403) | `Content-Length: 0` -> 400; declared/chunked `>maxZipBytes` -> 413; multipart body -> 400 (`bad magic header`); corrupt ZIP after `PK\x03\x04` -> 400 & unlinked; async `createWriteStream` `.zip.part` race (**Defect #10**); duplicate active series -> 409; valid ZIP -> 201 | PASS + Defect characterized |
| `POST /api/intake/jobs/:id/retry`, `continue` | Privileged only (403 for temp) | Required (403) | Rejects `renderLane` change (400); refuses retry when pinned lane is disabled in `lanes.json` (400) | PASS |
| `POST /api/intake/preview`, `GET /api/intake/preview/:id.mp3` | Privileged for POST (403); Cookie for GET (200) | Required on POST | `HEAD` on `.mp3` -> 405 (**Defect #11.4**); `edge` preview ignores `EDGE_TTS_PYTHON` (**Defect #2**) | PASS + Defects characterized |
| `GET /media/*`, `/poster/*`, `/thumbs/*` | Cookie required (303/200/206) | N/A | `Range: bytes=4-9` -> 206; suffix `bytes=-3` -> 206; `bytes=50-60`, `bytes=10-4`, `bytes=-0`, `bytes=invalid` -> 416; traversal -> 403 | PASS |
| Nginx Frontend Proxy (`pipeline-v2-frontend:local`) | `auth_request /_session_check` (303 to `/login` on 401) | Forwards `Host`, `Origin`, `Cookie`, `X-CSRF-Token` | Blocks direct static asset serving on backend (`PLAYER_API_ONLY=1` -> 404); forwards byte ranges (206) | PASS |

### Cloud Lifecycle Matrix (Injected Process Transport)

| Lifecycle Stage / Failure Mode | Exercised Path | Observed Behavior | Status |
| --- | --- | --- | --- |
| Default off (`MANHWA_RENDER_CLOUD=""`) | `cloudlane.healthy()`, `renderlane._render()` | Never invokes `sbx`; routes directly to `local` | PASS |
| Non-waking health probe (`stopped` / `running`) | `cloudlane.healthy()` -> `sbx --cloud ls --json` | Returns `[true, "paused; checked on render"]` / `[true, "ok"]`; cached for `maxAge` | PASS |
| Non-`"stopped"` error status (`status: "error"`) | `cloudlane.healthy(0)` | Returns `[true, "ok"]` instead of `[false, ...]`; does not clear prior `_state.fails` | **Defect #5** |
| Probe failure caching with default `maxAge=20` | `cloudlane.healthy()` called twice within 20s | Serves cached `[false, ...]` for `maxAge` without re-probing or incrementing breaker on cached read | **Policy #13** |
| Shared `.gate` / `.use` flock lease & auto-pause | `cloudlane._lease()` across threads and child processes | Serializes `.gate`, holds shared `.use` during job, runs `sbx --cloud stop` only when last holder exits | PASS |
| Kit & resource verification (`_ready`) | `sbx --cloud exec <NAME> sh -c <PROBE>` | Rejects missing `.kit-ready`/`remotion`/`flock`, `cpus < 1`, `mem_gb < 4.0`, `disk_gb < 5.0`; still auto-pauses box on failure | PASS |
| TTL budget check & extension (`_ensureTtl`) | `sbx --cloud ttl <NAME> --json` & `+delta` | Skips when paused/stopped or `>=5400s`; extends by `+(5400-rem)s`; throws on ceiling `<5400s`; sends `+NaNs` if fields missing (**Defect #9**) | PASS + Defect characterized |
| Studio composition sync (`_syncStudio`) | SHA-256 of `src/**`, `remotion.config.ts`, `tsconfig.json` | Verifies remote `package.json`/`package-lock.json` sha256; uploads composition on first run; skips upload when `.pipeline-src-sha256` matches; aborts on lockfile mismatch | PASS |
| Remote render & 2-slot flock loop | `sbx --cloud exec` with `for slot in 0 1; do flock -n -E 75 ...` | Stages `public/<proj>` and `shots.json`, runs Remotion with per-job `TMPDIR`, cleans remote job & public dirs in `finally` | PASS |
| Atomic download & `ffprobe` validation | `sbx --cloud cp` -> `<video>.part` -> `ffprobe` -> `fs.renameSync` | Rejects non-zero `ffprobe` or `duration <= 0`, unlinks `.part`, preserves original `video.mp4` | PASS |
| Legacy fallback & circuit breaker (`lane=null`) | `renderlane._render()` | Falls back `laptop -> cloud -> local`; 2 consecutive cloud failures open 600s breaker | PASS |
| Persisted plan fallback (`_workerPlan`, `override=null`) | `renderlane._workerPlan()` -> `_renderOnLane()` | Rethrows cloud failure without consulting `fallbackChain(plan, "cloud")`, failing chapter without trying `local` | **Defect #3** |

---

## Read-Only Deployment Capability Matrix

| Capability / Component | Host (`/home/shair/pipeline-v2`) | Backend Container (`pipeline-v2-backend:local`) | Frontend Container (`pipeline-v2-frontend:local`) | Live / Simulated Status |
| --- | --- | --- | --- | --- |
| Container engine | `podman` (`/usr/bin/podman`), no `docker` CLI | N/A | N/A | Verified live via Podman |
| `ffprobe` / `ffmpeg` | Installed | Installed (`/usr/bin/ffprobe`, `/usr/bin/ffmpeg`) | Not present (by design) | Verified live |
| `flock` (`util-linux`) | Installed | Installed (`/usr/bin/flock`) | Not present (by design) | Verified live |
| `chromium` + `remotion-studio` | Present | Installed (`/usr/bin/chromium`, `/app/remotion-studio`) | Not present (by design) | Verified offline |
| `edge-tts` | In `/home/shair/manhwa-pipeline/.venv/bin/edge-tts` (not on default `PATH` or `/usr/bin/python3`) | In `/opt/tts/bin` (`EDGE_TTS_PYTHON=/opt/tts/bin/python`, not on `PATH`) | Not present (by design) | `audio.ts` wired; `voicePreview.ts` broken (**Defect #2**) |
| `sbx` CLI binary | Installed (`/usr/local/bin/sbx`) | **MISSING** (not installed in `docker/backend/Dockerfile`) | Not present (by design) | Host binary present; container missing |
| `sbx` Cloud Auth (`sbx --cloud ls --json`) | **NOT AUTHENTICATED** (`error: not signed in to Docker; try: sbx login`) | N/A (`sbx` missing) | N/A | **Simulated only** |
| `MANHWA_RENDER_CLOUD` | Unset (`<unset>` in env and empty in v1 `env.sh`) | Unset | N/A | **Simulated only** |
| `MANHWA_RENDER_REMOTE` | Unset in process env (`lappy` in v1 `env.sh`) | Unset | N/A | **Simulated only** |

---

## Reproduction Commands

```sh
# 1. Run TypeScript typecheck
npm run typecheck

# 2. Run the offline deep API/frontend/backend & cloud lifecycle test suite (32 tests)
npx vitest run tests/deep-api-cloud.test.ts

# 3. Run the full unit/integration test suite (546 tests across 9 files)
npm test

# 4. Run the explicit read-only host & container capability check (optional, outside npm test)
npx tsx tools/deep-api-cloud-capabilities.ts

# 5. Run the disposable two-container Podman deployment smoke test
CONTAINER_ENGINE=podman npm run test:images
```

## What Remains Unverified

1. **Live Docker Cloud Sandbox (`sbx --cloud`) execution:** Cannot be tested live without running `sbx login`, provisioning a cloud-kit sandbox, setting `MANHWA_RENDER_CLOUD=<sandbox-name>`, and installing `sbx` inside the backend environment/container.
2. **Live Tailscale SSH laptop worker (`lappy`):** Probed only via injected runners to avoid mutating remote machines.
3. **Live paid LLM / external TTS provider calls:** Verified through local contract/mock harnesses to avoid spending provider quota.
