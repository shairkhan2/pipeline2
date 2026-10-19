# Pipeline v2: code review and improvement plan

Reviewed: 2026-10-17.

Implementation follow-up: `docs/frontend-backend.md` defines the post-migration boundaries, and `docs/deployment.md` describes the separate images. The follow-up addresses request error containment, shared media streaming, browser request handling, API cache isolation, and explicit container paths. The findings below retain the original review evidence; remaining pipeline/cache/scheduler changes are separate work.

## Summary

The highest-value changes are request crash containment, input-aware cache validation, and explicit quality gates before rendering. The existing tests provide substantial compatibility coverage, but passing them does not cover these failure paths.

Validation performed:

- `npm test`: **504 tests passed across 7 files**.
- `npm run typecheck`: **passed**.
- Local, offline probes confirmed malformed URL rejection escapes the request handler and incomplete SSE output is accepted.
- Static review covered orchestration, reader/writer caching, LLM transport, render scheduling, intake lifecycle, player HTTP handling, service-worker caching, and renderer/build configuration. This is a targeted review, not an exhaustive audit of every module.
- Live provider calls, remote workers, browser flows, and full video rendering were not exercised. Root typechecking explicitly excludes `remotion-studio`.

Priority: **P1** = reliability or output-integrity fix; **P2** = correctness or operational improvement; **P3** = maintainability.

## P1 — Reliability and output integrity

### 1. Contain rejected request promises and stream errors

**Evidence:** `src/player/server.ts:556-560, 588-600, 743-753`; `src/player/server.ts:469-501`; `src/player/jobs.ts:147-154`.

URL construction and percent decoding run before the handler's `try`. The HTTP callback discards the returned promise without a rejection handler. Several asynchronous route calls are returned without `await`, so their later rejection also bypasses the local `catch`. File streams have no error handlers.

**Confirmed:** invoking `handleRequest` with `/%ZZ` rejects with `URIError: URI malformed`. Under Node's default unhandled-rejection behavior, this can terminate the player. Deleting a file between `stat` and stream opening can similarly emit an unhandled stream error.

**Improve:** move request parsing inside the guarded block; attach a final rejection handler at the HTTP boundary; use `await` where local error mapping is intended. Centralize streaming with error handling and disconnect cleanup. If headers were already sent, destroy the response rather than attempting another status response.

**Acceptance:** malformed paths return 400; asynchronous route failures return controlled errors; stream-open failures and client disconnects do not terminate the process.

### 2. Include source identity in reader caches

**Evidence:** `src/stages/slicer.ts:949-984`; `src/stages/reader.ts:367-394, 554-579, 602-609`.

The slicer invalidates its manifest using `slicer_rev` and `pages_hash`. Reader cache validity checks only the brief hash and caption version. The assembled observation fast path does not compare its panel inventory with the newly loaded manifest. Batch validation checks IDs, which cannot detect changed pixels under unchanged IDs.

**Impact:** replacing chapter images or changing slicing can produce new panels while reusing observations from old artwork. Wrong observations then feed narration and image selection.

**Improve:** version the cache envelope and include a source/manifest fingerprint. Include relevant reader context identity, or explicitly define when context changes invalidate observations. Treat invalidation as visible stale state, with an estimated reread cost before expensive regeneration.

**Acceptance:** changed image content or panel membership invalidates affected observations; unchanged input reuses caches with zero provider calls.

### 3. Make fact-check failures an explicit render decision

**Evidence:** `src/cli/run.ts:1046-1051, 1074-1105`.

The CLI prints `fact_check: FAIL`, but writes `status: "ok"`, records chapter success, and queues rendering regardless of findings. Only an empty narration independently blocks this path.

**Impact:** checks can identify bad narration without preventing TTS and render spending or successful job completion.

**Improve:** return structured findings with stable codes and severity. Block rendering on defined correctness failures; keep stylistic warnings advisory. Persist a distinct blocked status and provide an explicit override for intentional exceptions. Do not treat every stylistic finding as fatal.

**Acceptance:** a blocking finding prevents video enqueue and produces a nonzero run result; advisory findings remain visible without blocking.

### 4. Add writer mutual exclusion separate from deletion protection

**Evidence:** `src/locks/seriesLock.ts:8-15`; `src/cli/run.ts:668-670`; `src/workers/renderlane.ts:2140-2151`.

The series lock intentionally permits multiple writers through shared flock acquisition. It protects active work from deletion, but does not serialize two CLI runs for the same series. Those runs can update the same bible, scripts, caches, and render outputs. Intake's single worker does not constrain separately launched CLI processes.

**Improve:** retain the shared deletion-protection lock and add a separate exclusive orchestration lock per series. Add chapter-level render ownership for overlapping standalone render commands. Reject duplicate work with an actionable owner/run message.

**Acceptance:** two processes targeting the same series cannot concurrently mutate its narrative state; different series can still run independently.

### 5. Reject incomplete LLM streams

**Evidence:** `src/llm/client.ts:742-786, 838-869`.

`_readSse` accepts accumulated text without requiring a terminal event or inspecting `finish_reason`. Malformed event JSON is silently skipped. `callLane` treats any nonempty resulting content as success.

**Confirmed:** a stream containing one content delta and no terminal event returns `partial draft` as a successful completion.

**Impact:** a connection that ends cleanly with incomplete provider output can be mistaken for a completed draft. Token-limit truncation is also not distinguished from a normal stop.

**Improve:** track provider-compatible completion markers and finish reasons. Distinguish truncation, malformed events, and successful completion; retry or surface incomplete output before downstream persistence. Preserve usage and finish metadata in the completion contract.

**Acceptance:** incomplete EOF, malformed chunks, and token-limit termination are detected; supported terminal-event variants succeed.

## P2 — Correctness and operations

### 6. Remove global writer state from cached-script checks

**Evidence:** `src/stages/writer.ts:718-729, 774-781`; `src/cli/run.ts:980-1011, 1046-1048`.

`LAST_WINDOW` updates when generating a script. Reusing a cached script skips generation but still passes that global into fact checking. The value can be empty or belong to a different chapter generated earlier in the same process.

**Improve:** compute each chapter's continuity window independently of script generation. Return generation metadata explicitly instead of relying on `LAST_WINDOW` and `LAST_BUDGET` globals.

**Acceptance:** checking the same cached chapter alone or after another chapter produces identical findings for identical inputs.

### 7. Supervise render workers before waiting for queue completion

**Evidence:** `src/cli/run.ts:780-786, 1162-1166`; `src/workers/renderlane.ts:1597-1600, 1656-1661, 1729-1740, 2145-2151`.

The producer waits for `queue.join()` before awaiting the worker promise. A worker startup failure can reject before the queue drains. Slot tasks are also only collectively awaited after the input sentinel arrives. Exceptions outside per-chapter `runOne` handling can therefore become unhandled rejections or leave queue completion without a consumer.

**Improve:** observe worker and slot-task failures immediately. Give the queue a failure/close state that rejects outstanding waits. Use `try/finally` to stop consumers and finalize telemetry even when producer work fails.

**Acceptance:** inject a startup error and an availability-probe error; each run exits promptly with a failed result and no hanging queue or unhandled rejection.

### 8. Use atomic publication for all authoritative text artifacts

**Evidence:** `src/stages/writer.ts:751-758, 844`; `src/cli/run.ts:978, 1002-1008, 1087-1100, 1126-1138, 1187`.

Story-mode scripts already use a temporary file and rename. Legacy scripts, opening-hook rewrites, and reports write directly to final paths. A crash or disk-full failure can leave a truncated script that still contains narration and is reused on restart.

**Improve:** share an atomic-write utility using unique temporary files in the destination directory. Validate authoritative artifacts before publication and on reuse. Publish completion metadata only after the artifact is committed.

**Acceptance:** interrupted or failed replacement preserves the previous complete script/report; partial artifacts are never treated as completed work.

### 9. Unify runtime paths and document a reproducible setup

**Evidence:** `src/cli/run.ts:117`; `src/player/server.ts:42-46`; `src/intake/intake.ts:322-331`; `src/workers/renderlane.ts:2066, 2128`; `package.json:6-10`.

Without environment overrides, the CLI uses `/root/manhwa/series` while intake and the player use repository-local `series`. The renderer defaults to `/root/remotion-studio` despite a studio directory existing in this repository. Log defaults also differ.

**Impact:** independently started components can inspect or write different libraries. A fresh checkout depends on deployment knowledge outside its package scripts.

**Improve:** centralize path resolution, choose consistent checkout-relative defaults, and preserve explicit environment overrides. Add setup documentation and an environment example covering Node, Python adapters, ffmpeg/ffprobe, flock, rendering dependencies, storage paths, and credentials. Provide a read-only preflight command that prints resolved paths and missing tools.

**Acceptance:** documented setup makes intake, CLI, player, and renderer agree on directories without hidden host-specific assumptions.

### 10. Invalidate media duration caches when files change

**Evidence:** `src/player/server.ts:259-273, 350-358, 374-386`.

Duration promises are cached forever by pathname, including failed probes returning `null`. Re-rendering the same chapter does not refresh duration until the server restarts.

**Improve:** key entries by file identity plus size/mtime, expire failed probes, and bound cache size. Reuse the `stat` already obtained during library scanning. Use bounded parallelism for cold library probes instead of serial probing across chapters.

**Acceptance:** replacing a video updates duration on the next scan; a temporary ffprobe failure can recover; large libraries do not spawn unbounded probes.

### 11. Scope offline API caches to authenticated identity

**Evidence:** `src/player/public/sw.js:33-40, 77-80`; `src/player/server.ts:602-610`.

The service worker caches every successful GET under `/api/` by request URL. Library responses include username, privilege state, and CSRF token. Offline fallback can serve a previous account's response after identity changes because cache entries are not partitioned or cleared by user.

**Improve:** allowlist offline-safe data. Keep session/CSRF and control-plane responses out of persistent caches, or partition and clear caches on identity transitions. Purge sensitive cached entries after authentication failure. Cache only the presentation data needed offline.

**Acceptance:** after switching accounts or losing authentication, offline mode does not expose the previous account's session metadata or privileged controls.

### 12. Make coverage portable and include renderer checks

**Evidence:** `tests/phase6-slicer-writer.test.ts:573-585`; `tsconfig.json:18-19`; `remotion-studio/package.json:5-13`.

Some parity tests use `/home/shair/manhwa-pipeline/series` and return successfully when fixtures are absent. A fresh machine can report passing tests without running these comparisons. The root typecheck excludes the renderer, whose package has no typecheck or test script.

**Improve:** commit small synthetic golden fixtures for mandatory coverage. Put full-library parity tests in a separately configured integration suite with explicit skips or required-fixture failures. Add a renderer typecheck and small render smoke test to CI, alongside HTTP failure-boundary and queue-failure tests from this review.

**Acceptance:** a clean checkout runs meaningful mandatory tests; missing integration data appears as skipped or failed rather than passed; renderer changes receive automated validation.

## P3 — Maintainability

### 13. Extract shared infrastructure after fixing behavior

**Evidence:** range-serving logic is duplicated in `src/player/server.ts:462-502` and `src/player/jobs.ts:113-155`. Python-compatibility helpers appear throughout the CLI and stages. Intake, locking, and render modules each span thousands of lines.

Extract HTTP streaming, atomic file publication, path resolution, and compatibility serialization into focused modules with explicit contracts. Then split intake into persistence, download, scheduling, and execution modules. Replace mutable hook/global dependencies incrementally with injected run contexts.

Keep compatibility behavior covered by existing golden tests. Avoid a broad rewrite before the reliability fixes land.

## Suggested delivery order

1. HTTP error containment and stream lifecycle handling.
2. Input-aware reader caches, writer ownership, and atomic artifact publication.
3. Structured fact-check policy, explicit continuity context, and SSE completion validation.
4. Worker supervision and failure-aware queue completion.
5. Consistent runtime paths, duration invalidation, and account-aware offline caching.
6. Portable fixtures, renderer checks, and incremental module extraction.

Each change should include the failure-focused acceptance checks above rather than tests that merely duplicate implementation details.
