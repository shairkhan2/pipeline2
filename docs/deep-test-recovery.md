# Deep test: stage failure, retry and recovery

Test-only pass (2026-10-17). No production file was changed.
Suite: `tests/deep-recovery.test.ts` (42 tests). Typecheck: `npm run typecheck` (clean).

Scope is the batch/chapter pipeline, not provider/cloud transport:

```
intake job -> run.ts chapter loop -> reader batches -> bible -> writer -> check
           -> video lane: timeline (audio -> cleaner -> framing) -> render
           -> report.json / job.json / telemetry / retry
```

Everything is offline: injected `call`, injected `_hooks`, a fake external-TTS
python command, a fake MIT python command, a fake Remotion subprocess and real
local node child processes for intake. Scratch lives under `/tmp/opencode`.
No v1 output is written.

## How to run

```bash
cd /home/shair/pipeline-v2
npx vitest run tests/deep-recovery.test.ts            # 42 tests, ~4 s
npx vitest run tests/deep-recovery.test.ts -t reader  # one group
npm run typecheck
```

## Evidence classes

| Class | Meaning in this suite |
| --- | --- |
| **real process / real file** | reader batch files, external TTS (`python3` child + `ffmpeg`), cleaner `spawnSync`, timeline outputs, intake job JSON, `runWorker` lock. Restart evidence comes from a second call in a fresh function scope reading only what is on disk. |
| **mocked stage** | `run.ts` stage hooks (`readChapter`, `writeScript`, `renderlane.worker`, `time.sleep`), `renderlane.produce`, render subprocess. Behaviour of the orchestrator is real; the stage is a stub. |
| **unit** | `_applyCleaned` with a Promise vs a resolved value. |

A mocked reader/writer still exercises the real retry loop, the real report
writer and the real telemetry, so retry counts, waits, halting and report
contents are genuine. Paid-cache retention is proven against real batch/obs
files and real `line_*.mp3` files, never against a mock.

---

## Findings

Severity: **S1** data loss / silent wrong output, **S2** stuck or unrecoverable
state, **S3** misleading visibility.

### R-01 (S1) Cleaner failure is silent and the run still reports success

`src/stages/cleaner.ts:640-655` runs the MIT tool with `spawnSync` and **never
inspects `r.status`**. `cleanBatch` creates the `_runBatch` output dir with
`fs.mkdtempSync(path.join(os.tmpdir(), "cleaner_out_"))`
(`src/stages/cleaner.ts:1153`; the 2x rescue path does the same at `:1188`)
*before* calling `_runBatch` at `:1157`. So after a non-zero exit `outDir`
already exists, `!isDir(outDir)` at `:653` is false, the failure log at `:654` is
skipped, and every panel returns `null`.

`src/stages/timeline.ts:1168-1171` then applies `null` as "keep the original",
marks `stage(ch, "clean", "done", { cleaned: 0 })` and continues. There is no
degradation flag anywhere: `shots.json` points at the uncleaned
`<series>_<ch>/pXXXX_Y.jpg`, `report.json` says `status: "ok"` / `video-ok`, the
job completes, and the only signal is nothing at all.

Expected: a cleaner that cannot run is either a stage failure (retryable) or an
explicit, reported degradation. Observed: silent fallback to original art plus a
`done` stage and a successful job.

Evidence: real `spawnSync` of a fake `MANHWA_MIT_PY` that exits 3; real
`timeline.main`; real `report.json`. Tests:
`cleaner fallback semantics ... DEFECT: a non-zero cleaner exit returns null ...`,
`timeline ... DEFECT: cleaner non-zero exit silently ships the original panel ...`.

Smallest fix: in `_runBatch`, `if (r.status !== 0) throw new Error(...)` (or
return a structured `{failed: true}` and let `timeline` raise/flag). At minimum
record `cleaner_degraded` in `shots.json`/`report.json` and set the stage to
`warning`.

### R-02 (S1) `timeline.main` never awaits `cleanBatch`

`src/stages/timeline.ts:1168`: `const res = cleanBatch(...)` (an `async`
function) is passed straight into the synchronous `_applyCleaned`
(`src/stages/timeline.ts:1169`). `res[pid]` on a Promise is always `undefined`,
so a **successful** clean is also discarded and every shot keeps the original
panel. Only the promo branch notices, because it throws for
`it.promo_item` (`src/stages/timeline.ts:819-825`).

Expected: cleaned PNGs are used. Observed: cleaning is dead code at runtime for
the non-promo path, and promo panels hard-fail. This makes R-01 worse: even a
working cleaner would be invisible.

Evidence: unit test with a pending Promise vs the same value awaited (0 vs 1
applied). The real-timeline test additionally shows the original panel path in
`shots.json`. Fix: `await cleanBatch(...)`.

### R-03 (S2) A video-lane worker that throws hangs `run.ts` forever

`src/cli/run.ts:1162-1166` does `await vq.join(); vq.put(null); await vt;`. If
`renderlane.worker` rejects before draining (e.g. `_workerPlan` raises
`"render plan has no eligible lane"` at `src/workers/renderlane.ts:1597-1601`,
or the queue/lock setup throws), nothing ever calls `taskDone()` for the queued
chapters and `join()` never resolves. The chapter already printed as `ok`, so
the operator sees a successful script lane and a process that never exits.

Expected: worker failure fails the pending chapters and the run returns 1.
Observed: `unfinished_tasks` stays 1 and `join()` is pending (test bounds the
wait at 120 ms).

Fix: wrap the worker promise (`vt.catch(...)`), and on rejection drain the queue
with a `video-failed` result for every remaining chapter before `join()`.
Optionally give `RenderQueue.join()` a deadline.

### R-04 (S1) `--force` is re-applied on every retry, wiping the paid cache

`src/cli/run.ts:832` calls `readChapter(chdir, out, force, ...)` inside the
retry loop, and `src/stages/reader.ts:548-553` deletes `out/panels/<ch>`,
`out/batches/<ch>/v<cv>` and `obs_<ch>.json` when `force` is true. A transient
failure on a `--force` run therefore discards the batches that the first attempt
already paid for, and the retry re-reads the whole chapter.

Expected: `force` applies to the first attempt only; retries resume per batch
(the log even claims "per-batch cache resumes"). Observed: `force` is passed
unchanged on attempts 1..3.

Fix: `const forceThisAttempt = force && attempt === 0;`.

### R-05 (S3) A failed rerun destroys the previous success report

`src/cli/run.ts:1124-1138` writes `report.json` with only
`{status, class, error}` on failure, overwriting the `ok` report (lines, issues,
`window_holes`). Completed work (`script.md`, batches, obs, cleaned, video) is
retained, but the record that the chapter ever passed is gone, and
`statusProbe` reads `report.json` for findings/completion.

Expected: failure recorded without erasing the last success, e.g.
`status: "failed", previous: {...}` or a separate `failure.json`. Observed:
`lines`/`issues` disappear.

Fix: merge instead of replace, or write `report.failed.json`.

### R-06 (S3) Video-lane failure has no automatic retry and no attempt counter in the report

`src/workers/renderlane.ts:1633-1651` (`runOne`) attempts a chapter exactly once;
`failcounts` is in-memory only and never persisted. `run.ts` merges only
`{status, video, duration, error}` into `report.json`
(`src/cli/run.ts:1175-1188`). After the process exits, nothing records that
chapter X failed the video lane once, so a manual rerun starts from zero
knowledge and cannot distinguish "never tried" from "failed".

Expected: at least `video_attempts` in the report, or a bounded automatic retry.
Observed: single attempt, transient render failures are fatal for that chapter.

### R-07 (S2) intake: a corrupt job file disappears without a trace

`src/intake/intake.ts:701-709` returns `null` for unparseable JSON, and
`reconcileJobsLocked` / `runWorker` skip `null` records silently. The job file
stays on disk but is unreachable: it is absent from `listJobs`, and `getJob`
answers `Job not found`, which the UI shows as a 404.

Expected: a corrupt record is surfaced as an error/interrupted job, or quarantined
with a visible note. Observed: silent disappearance.

### R-08 (S2) intake: the external-run gate has no default timeout

`src/intake/intake.ts:2280-2300`: `maxWaitS` is `null` unless
`MANHWA_EXTERNAL_RUN_WAIT_S` is set, so a queued job waits indefinitely while
any `pipeline/run.py`, `pipeline/renderlane.py`, `src/cli/run.ts` or
`src/workers/renderlane.ts` process is alive — including a **v1** run, which is
detected by path suffix. On this host a live v1 `contract --video --all` process
blocked every intake test until the scanner was stubbed. A crashed-but-not-reaped
foreign process (or a stale PID that still passes the cmdline check) hangs the
whole queue with no status change beyond a `statusNote`.

Expected: bounded wait with an actionable failure, or a heartbeat-based check.
Observed: unbounded wait. Fix: default `maxWaitS` to e.g. 3600 s and fail the job
with a clear message.

### R-09 (S2) intake: half-dead "running" jobs are never reconciled

`src/intake/intake.ts:1985-2013` only marks a job `interrupted` when **both**
`workerPid` and `runPid` are dead. If the worker is alive but the pipeline child
died (killed by OOM, `SIGKILL` to the group, container restart that reused the
worker), the job stays `running` forever, offers no `retry` action and blocks
`retryJob`/`enqueueJob` for that slug via the active-state conflict.

Expected: `runPid` dead while `workerPid` alive and state `running` is an
anomaly worth at least a warning/`interrupted`. Observed: permanent `running`.

### R-10 (S3) Zero-byte render output is accepted as `video-ok`

`src/workers/renderlane.ts:949` only checks `returncode !== 0 || !existsSync(video)`.
`_probe` then returns 0, and `produce`/`runOne` record
`{status: "video-ok", duration: 0}`; `report.json` says `video-ok` with
`duration: 0`, and `statusProbe` treats `report.status === 'video-ok'` as a
finished render. A truncated encode (rc 0, empty file) therefore ships as success.

Expected: `duration <= 0` is a failure. Fix: reuse `_probe(video) > 0` as a
completion condition in `renderLocal`/`_render`.

---

## Test matrix per stage

Legend: **auto** = automatic in-process retry, **manual** = operator action,
**cache** = paid work retained across the failure, **visible** = failure state in
report/telemetry/job.

| Stage | Auto retry | Manual retry | Cache retention | Failure visible | Tests |
| --- | --- | --- | --- | --- | --- |
| reader batches | yes: 2 temperatures per batch (`reader.ts:628-704`) | rerun resumes at the failed batch; `--force` re-reads (R-04) | batch files kept byte-identical; obs only written after full assembly | `report.json` + `CHAPTERFAIL` log | 6 |
| reader cache state | n/a | `--keep-stale` returns stale obs with 0 calls; corrupt obs rebuilt from batches; corrupt/poisoned batch re-read | fresh cache = 0 calls | stderr warning for stale | in above |
| writer | yes: chapter-level retry (`run.ts:811-1143`), transient only | rerun reuses `script.md` unless `--force` | prior script untouched until `writeScript` succeeds (atomic rename in story mode) | `report.json` class/error | 5 |
| check / gates | no: continuity gate and 0-line are `permanent` | fix the blocker, rerun | n/a | `report.json` `class: permanent` | 2 |
| audio / TTS | external/eleven: none; edge: 3 tries per line (`audio.ts:271`). Chapter-level retry otherwise | rerun reuses every `line_*.mp3` with a matching `.txt` proof | per-line mp3 + sidecar kept; `shots.json` written only after success | exception + `CHAPTERFAIL` | 3 |
| cleaner | **none** (R-01) | rerun re-runs the tool | batch path caches a rejection as `.rej` per config hash; the promo-mask path has no negative cache (B2a) | **not visible** (R-01/R-02) | 4 |
| timeline / prepare | no | rerun recomputes from cached audio | `narration.mp3` + `narration.key` + `tts_durs.json` | exception | 4 |
| render | no (single attempt, R-06) | rerun re-renders; `video.mp4` is overwritten in place | shots/audio/crops reused | `video-failed` in `report.json` | 5 |
| video lane queue | no | rerun only the failed chapter | completed chapters untouched | merged into `report.json`; `failcounts` in-memory only | 4 |
| intake job | no (job-level only) | `retryJob` (failed/interrupted), `continueJob` (completed/failed/interrupted) | chapters, `out/` and the staged ZIP are kept; `skipIngest` set | `job.status`, `error`, `logTail`, `retryCount` | 7 |

### Retry counts and waits (verified, not assumed)

* `RETRY_ROUNDS = 2`, `RETRY_WAITS = [60, 240]` (`src/cli/run.ts:164-165`).
* 3 attempts total for transient/unknown, 1 for permanent (both asserted with a
  fake `time.sleep`, so no wall-clock cost).
* Chapter chain policy: after the final failure `halted` is set and every later
  chapter is untouched — no `report.json`, no `script.md`, no reader call.
* Video lane: exactly one attempt per chapter; a failure does **not** halt the
  script lane (asserted for ch1 failing while ch2/ch3 continue).
* intake: no automatic rerun at all. A killed pipeline becomes `failed` with
  `exited with code 137`; `reconcileJobs` converts a dead `running` job to
  `interrupted` with the note "not auto-rerun"; retry is manual and preserves
  `runChapters`, `retryCount` and the paid `out/batches` bytes.

---

## Reproduction

```bash
# everything
npx vitest run tests/deep-recovery.test.ts

# the cleaner defects (real subprocess, no network)
npx vitest run tests/deep-recovery.test.ts -t "cleaner"

# the queue hang
npx vitest run tests/deep-recovery.test.ts -t "leaves run.ts queue.join()"

# reader resume / corrupt state
npx vitest run tests/deep-recovery.test.ts -t "reader batch failure"

# intake job lifecycle
npx vitest run tests/deep-recovery.test.ts -t "intake job failure"
```

Manual reproduction of R-01 without the suite: point `MANHWA_MIT_PY` at any
script that exits non-zero, run `npx tsx src/workers/renderlane.ts <series> <ch>`
on a chapter with a long overlay panel, then compare `out/<ch>/video/shots.json`
panels against `out/cleaned/<ch>/` (empty) and `out/<ch>/report.json`
(`video-ok`).

Manual reproduction of R-03: `MANHWA_RENDER_LANE=cloud` with an unconfigured
cloud lane, `--video`; the script lane finishes, then the process waits forever
after printing `video lane: waiting for queue to drain...`.

## Fix order suggested

1. R-02 (`await cleanBatch`) — one word, restores the cleaner at all.
2. R-01 (inspect `spawnSync.status`) — stops silent uncleaned output.
3. R-04 (`force` only on attempt 0) — stops paid re-reads on retry.
4. R-03 (worker rejection drain) — stops the hang.
5. R-05/R-06/R-10 (report merge, attempt count, zero-byte check) — visibility.
6. R-07/R-08/R-09 (intake corrupt record, bounded wait, half-dead reconcile).

## Known non-goals

* No provider, TTS or cloud transport behaviour is asserted (Argon owns that).
* No production code was modified; the defects above are characterized, not fixed.
* `run.ts` is exercised through `_runLocked` with injected stage hooks; the CLI
  argument parser and the real Remotion render are out of scope here.
