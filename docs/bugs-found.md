# Bugs found during the 2026-10 frontend redesign

Each entry lists what was seen, the evidence, and a suggested fix. Fixed entries move to the bottom with the commit or file that fixed them.

## Open

### B15. A refused lane is retried on every later call

- **Seen:** after the B1 fix, a policy refusal skips to the next lane, but the refusing lane is not parked. Each later call (every chapter, every phase) tries it first and spends a full round-trip, about 300 s on agy, before falling back.
- **Evidence:** `src/llm/client.ts` `callLane`: the refusal branch returns `skip` without `cooldown()`. That is deliberate, because the refusal is specific to that prompt.
- **Fix:** park the lane for this prompt's tag only (for example `visual_match ch2`), or for a short time after 2 refusals in a row.

### B2. `GET /api/series/:slug/settings` returns 500 when `meta.json` is missing

- **Seen:** a series folder without `meta.json` gives `{"error":"server error"}` with HTTP 500.
- **Evidence:** `src/player/seriesSettings.ts:21`. `fs.lstatSync(file)` throws ENOENT, and the global handler turns that into a 500.
- **Fix:** return 404 `Series settings not found` when `meta.json` is missing. Or return empty settings, since a meta-less series has default style.

### B3. Static `.ttf`, `.woff` and `.woff2` files return 404, so the Barlow font never loads (fixed)

- **Seen:** `/fonts/barlow/Barlow-Regular.ttf` returns 404 on every page. Studio falls back to the system font.
- **Evidence:** the `MIME` map in `src/player/server.ts:306` has no font types. The static fallback (`server.ts:969`) only serves extensions that are in `MIME`.
- **Fix:** add `.ttf: font/ttf`, `.woff: font/woff` and `.woff2: font/woff2`. Required by the redesign (self-hosted fonts).

### B4. Telemetry tests write into the live `out/status` folder

- **Seen:** 108 of 114 files in `out/status/` are `series-lang-dropped` runs. They come from `tests/language-rendering.test.ts:715`, which calls `telemetry.start()` without its own `PIPELINE_STATUS_DIR`. They show up as phantom runs in the Pipeline page's run picker.
- **Fix:** set `PIPELINE_STATUS_DIR` and `PIPELINE_LOG` to a temp folder in that test, or in a vitest `setupFiles` for all tests. Then delete the stale `series-lang-dropped` snapshots. That deletion needs your approval.

### B5. Tests append fake calls to the live `out/pipeline.log`

- **Seen:** `out/pipeline.log` contains 297 lines like `OK claude-studio [claude-studio] … tokens=0` and `custom-openai-2 … ok`. These come from provider test fixtures, not real calls. The Pipeline status line can show `custom-openai-2 · custom-openai-2 · ok` as the last event.
- **Fix:** same as B4. Point `PIPELINE_LOG` at a temp file for the whole test run.

### B6. Merging series videos refuses symlinked chapter videos

- **Seen:** `GET /api/series/:slug/merge` returns 400 `Refusing to follow a symbolic link` when any chapter `video.mp4` is a symlink.
- **Note:** this is intended hardening (`assertNoSymlinks`). It only matters if videos are ever stored on another disk through symlinks. Recorded so it is not mistaken for a UI bug.

### B7. `api.mergeAll({ force })` sends a field the server ignores

- **Evidence:** `frontend/src/lib/api.ts` sends `force`. `src/player/server.ts:809` never reads it.
- **Fix:** drop `force` from the client, or implement it on the server.

### B8. Client `NodeAction` type allows `pause`, but the server rejects it

- **Evidence:** `frontend/src/lib/api.ts:55` lists `pause`. `src/player/studio.ts:1696` rejects it with 400.
- **Fix:** remove `pause` from the type, or add it to the server.

### B9. Device-code OAuth ignores `slowDown` and `interval`

- **Evidence:** `src/player/studio.ts:1428-1435,1523-1532` returns `slowDown` and `interval`, but the client poll type omits both and polls at a fixed rate.
- **Fix:** respect `interval` and back off on `slowDown`.

### B10. A provider save can succeed while model discovery fails, with no message

- **Evidence:** `src/player/studio.ts:989,1086` returns `discoveryError`. The client types and UI ignore it.
- **Fix:** show it as a warning after the save.

### B11. Activity feed hides rate-limit warnings (fixed)

- **Evidence:** the backend emits `kind: "warn"` (`src/llm/client.ts`, "all lanes busy"). The Pipeline page's Issues filter only admits `warning` and `error` (`frontend/src/pages/StatusPage.tsx:814`).
- **Fix:** treat `warn` as `warning`. This is part of the redesign, step 8.

### B13. The sign-in page's icon is behind the login wall

- **Seen:** `/icons/icon-192.png` answers 303 to `/login` before sign-in, so the login page shows no favicon.
- **Fix:** serve `/icons/*` and `/manifest.webmanifest` before the session gate in `src/player/server.ts`. Cosmetic only.

### B14. First-run setup can overwrite an existing singleton provider's connection details

- **Seen:** reconnecting a local or Vertex preset through setup reuses its canonical provider ID without an explicit update choice. For local presets, setup sends the preset URL and label even if the saved connection was customized.
- **Evidence:** the pre-redesign snapshot and current `frontend/src/pages/SetupPage.tsx` share the same `isMultiInstanceMode`, `targetId`, and create/update branches. Only key/custom connections use instance selection and `createOnly`; other modes POST the canonical ID. `src/player/studio.ts` treats that POST as an upsert, and `src/config/studioConfig.ts` prefers supplied labels and URLs over saved values.
- **Fix:** require an explicit existing-connection selection before updating a singleton provider, and preserve its saved label and endpoint when testing it.

## Fixed

- **B1:** a provider policy refusal that comes back as an HTTP 200 answer now skips to the next lane instead of becoming "unparseable JSON" (`src/llm/client.ts` `callLane`, `isRefusalText` in `src/domain/failure.ts`). It shows as "Blocked by safety filter".
- **B16:** one transient error used to fail a whole run, e.g. text77 ch1 on 2026-10-22 16:42 with one Vertex TTS `HTTP 429` on line 11. The pipeline now heals on four layers:
  - the TTS line retries for about 5 min (`src/stages/audio.ts`)
  - the video lane re-queues after 2, then 10 min (`src/workers/renderlane.ts`)
  - the job auto-retries after 10, 30 and 60 min, rerunning only unfinished chapters (`src/intake/intake.ts`)
  - a crashed run is auto-resumed, through reconcile plus a 60 s server watchdog (`src/player/jobs.ts`)

  Classification is shared in `src/domain/failure.ts`. Settings › Render nodes has Auto-retry and Attempts.
- **B17:** the Check stage showed "warning" in red on almost every chapter. Its `UNGROUNDED` lint is documented as measured to mislead. `UNGROUNDED` is now advisory, and warnings are amber with a "N notes" tooltip (`src/cli/run.ts`, `StatusPage.tsx`).
- **B18:** a failed stage showed the bare class name ("RuntimeError"). Stage notes are now short labels such as "HTTP 429 · rate limited" (`failureNote` in `src/telemetry/telemetry.ts`).
- **B19:** video results were written to `report.json` only at the end of a run, so a crash after N renders lost their "video-ok" marks. Each result is now merged as soon as it is known (`src/cli/run.ts`).

- **B20:** Hindi Gemini TTS read the English instruction wrapper aloud. Localized requests wrapped the text in "Read the following … never read out bracketed tags: …", and `gemini-3.8-flash-tts` speaks part text verbatim (text77 hi-IN ch2: 12/19 lines ~8-10 s too long). Localized requests now send only the transcript, with `languageCode` pinned (`synthesizeGemini` in `src/llm/vertexTts.ts`). A request rev (`GEMINI_LOCALE_REQUEST_REV`) in the localized Gemini line proof and narration key makes poisoned lines regenerate. English proofs are unchanged. Hardening: `localizedSpeechText` also drops leftover square-bracket segments such as `[आह]` or `[Sighs]` for every localized engine (Gemini, Chirp, Edge). Parentheses are left alone, since they can be real narration.
- **B21:** Hindi translations used bookish, Sanskritized Hindi instead of spoken Hinglish. Translate and review prompts are now v3: casual recap Hinglish in Devanagari (वो/ये, everyday English loanwords like पावर/लेवल/सिस्टम). The reviewer flags bookish wording. Existing Hindi chapters are stale until re-run.
- **B22:** the Hindi dialog had no batch selection: a chip replaced the selection with one chapter. It now has All, ranges (1-25), multi-select chips and a count, and sends only eligible chapters as a compressed list. Continuity: each chapter's translation gets the previous chapter's Hindi ending as a style/term hint (not in the cache key), and the glossary carries forward.
- **B23:** language jobs could not survive an overnight batch. Per-chapter retry waits were 250/500 ms, there was no job auto-retry or watchdog, and a dead worker stayed "running". Now:
  - transient waits are 60/240 s, model-output errors 2/5 s
  - job auto-retry runs at 600/1800/3600 s, max 3
  - a dead worker resumes after 120 s
  - a 60 s server tick honors the Studio autoRetry setting and `MANHWA_AUTO_RETRY`

  Open gap: the localize CLI has no SIGTERM handler or AbortSignal. The tick recovers its jobs after a restart.
- **B24:** the Hindi merge and outro POSTs were synchronous. Cloudflare Tunnel (v2.shairkhan.in) answers 524 when the origin sends no headers within 100 s. The outro budget is about 180 s, and a big merge stream-copies gigabytes (text77 hi-IN ch2 alone is 191 MB). Now:
  - the POST validates, takes the export lock and answers 202 with `busy.merge`/`busy.outro`
  - the work runs in-process, detached from the request; a client disconnect does not abort it
  - the outcome goes to `out/languages/<locale>/export-status.json` (`lastMerge`/`lastOutro`), which the export GET returns
  - restart: the export lock is a kernel flock, so it dies with the process. A `running` record with no lock holder reads as `interrupted`, and `.merge-`/`.outro-` temp dirs are removed. Finished files are only swapped in by rename.

  English merge and outro stay synchronous (`src/player/languageExport.ts`, `src/player/languages.ts`).
- **B25:** a single-panel outro rendered one video frame, followed by audio over a frozen picture. A two-panel outro cut its last panel to 2 frames. Cause: the concat demuxer plus output `-r 30` on ffmpeg n9 ends the video stream at the last panel's start. It affected the English outro and the Hindi path. An `fps` filter in `encodeOutroShowcase` (`src/player/seriesTools.ts`) now holds every panel for its full share: 60 frames per 2 s panel. With 3+ panels the old output was already within one frame per panel. Regression test: "English outro picture length (B25)" in `tests/outro-generation.test.ts`.
- **B26:** the merge duration guard compared container durations only. A segment whose video ended early passed it while its audio kept running, so a merge with a one-frame outro looked complete. Language merges now also check the video-track total (`concatVideoSegments`), and a rendered Hindi outro must have a picture as long as its narration.
- **B27:** the Hindi number check summed comma-separated numbers into one value. "August 25, 2023, six months" became 2054 (25 + 2023 + 6), so text77 hi-IN ch1 failed every attempt and auto-retry with "number value(s) missing: 2054". `numberValues` (`src/stages/localeScript.ts`) now treats each digit run as its own value. Punctuation, ranges (3-5), times (10:30) and list "and" end a phrase. Only real compounds combine: "twenty-five", "two thousand twenty-three", "two hundred and five", "5 thousand", दो लाख पचास हज़ार. नब्बे (90) was missing from the Hindi words. A changed number still fails (twenty-five vs 24). Audit of 7356 English script lines: false failures on a correct Hindi line dropped from 11 to 0 real ones. The translation key is unchanged, and the existing Hindi chapters still validate. Tests: "locale script skeleton" in `tests/language-localization.test.ts`.
- **B3:** added `.woff2`, `.woff` and `.ttf` to `MIME` in `src/player/server.ts`. The new Figtree font is bundled by Vite and loads.
- **B11:** the Pipeline feed now treats `warn` as `warning` (`frontend/src/components/status/RunHealth.tsx`, `buildFeed`).
- **B12:** the storage drawer used to hide load failures. `StorageTrashDrawer.tsx` turned failed fetches into `null`, so a failed request looked like an empty trash. It now shows an error with Retry and the request ID, and marks the trash contents as unknown.
