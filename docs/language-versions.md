# Language versions (Hindi, first release)

A language version is a **separate narration and render of a reviewed English
script**. It reuses the English pipeline's paid analysis (reader observations,
panels, bible, matcher tags) read-only and produces its own script, TTS,
timing and video. English files are never modified.

## Scope of the first release

| | |
| --- | --- |
| Locale | `hi-IN` (Hindi) |
| Voices | Edge `hi-IN-MadhurNeural`, `hi-IN-SwaraNeural` (no credentials) and Vertex AI: Chirp 3 HD (`hi-IN-Chirp3-HD-*`) and Gemini 3.8 Flash TTS (`gemini-tts:<Name>`) |
| Source | final English script after writer + matcher + check |
| Output | `out/languages/hi-IN/<ch>/` (script, TTS cache, shots, `video/video.mp4`) |

### Providers and models

The picker groups voices by **provider and model**, and every group is always
listed with its real state for this install:

| Group | Voice ids | Needs |
| --- | --- | --- |
| Edge | `hi-IN-MadhurNeural`, `hi-IN-SwaraNeural` | nothing (default) |
| Vertex · Chirp 3 HD | `hi-IN-Chirp3-HD-Aoede`, `-Charon`, `-Kore`, `-Puck` | a connected `vertex-ai` provider in Studio |
| Vertex · Gemini 3.8 Flash TTS | `gemini-tts:Charon`, `:Kore`, `:Puck`, `:Aoede` | the same Vertex provider |

- Chirp 3 HD Hindi ids follow the vendor format `<locale>-Chirp3-HD-<voice>`
  (`cloud.google.com/text-to-speech/docs/chirp3-hd`, Hindi GA).
- Gemini TTS voices are language-agnostic NAMES (`Charon`), GA for Hindi
  (`cloud.google.com/text-to-speech/docs/gemini-tts`); the id prefix
  `gemini-tts:` is this pipeline's spelling, the API receives the bare name.
- Voice names are **not** filtered by a `<lang>-` prefix for Gemini: that filter
  is why `Charon` used to vanish from a Hindi picker. Any account-discovered
  voice for `hi-IN` (own cache file) is appended after the built-in list.
- Without Vertex credentials the Vertex groups are reported `available: false`
  with an actionable hint. The UI disables them; the API answers `400
  provider_unavailable`. There is **no** silent substitution by an Edge voice.
- Credentials come only from the Studio store (`providers.json` +
  `secrets.json`); no environment variable, host ADC file or HTTP-supplied
  value is ever read for a language version.
- The catalog read is synchronous and offline: it never triggers discovery. An
  account's already-discovered `hi-IN` voices (its own
  `out/config/vertex-tts-voices.hi-IN.json` cache, written by
  `discoverVertexTtsVoices`) are appended after the built-in list, and the
  credential probe is memoized until the provider/secret store changes.

The Gemini request for a localized run adds the target `languageCode` and sends
only the spoken transcript, with bracketed delivery controls removed (the stored
script keeps them). Gemini speaks part text verbatim, so no instruction text is
sent; the English request is unchanged byte-for-byte (no `languageCode`, no
wrapper). Localized Gemini line proofs and narration keys carry
`GEMINI_LOCALE_REQUEST_REV`, so audio cached from the older wrapper-carrying
request regenerates instead of being reused.

Direct translation from the raw reader output (without an English script) is
**not** implemented. The English script is the reviewed, fact-checked narration
and is the only source of truth for a translation; translating raw captions
would reintroduce the errors the English review already removed.

## Pipeline

1. **validate** - read-only source gate, evaluated on the CURRENT bytes:
   - the script the configured engine actually voiced (`script_voice.md` for
     `external`, `script_eleven.md` for `eleven`, else `script.md`); a leftover
     expressive script never shadows the edge script,
   - `out/obs_<ch>.json`, with every `@pXXXX_N` tag present in the observations
     AND its panel image file present under `out/panels/<ch>/`,
   - `out/<ch>/report.json` with a valid schema (`status` in
     `ok|failed|video-ok|video-failed`, `issues` a list of strings, `lines` a
     non-negative integer or null); a malformed report is a refusal,
   - a **deterministic re-check of the current script on every call**: a fresh
     transcript is rebuilt from obs, and the fact check runs with the same
     continuity window and previous script the English pipeline used. A clean
     report left over from an older pass therefore cannot admit an edited,
     unreviewed script.
   - Every source path is validated without following a symlink.

   Findings are split by what they can actually prove:

   | Class | Examples | Effect |
   | --- | --- | --- |
   | **Hard** | `bad tag @p…`, `page-level tag`, `UNKNOWN emotion tag`, `NON-ENGLISH NARRATION`, `number/word-number/phrase not in transcript` | blocks the language version |
   | **Advisory** | `DUB`, `SCREENREADER`, `CAPTION`, `CAPTION/MULTI`, `UNGROUNDED`, `LORE IMPORT` | never blocks by itself; surfaced as `warnings` and handed to the semantic review |

   The advisory set is measured to mislead (the `UNGROUNDED` lint scores F1 ≈
   0.35 on hand-labelled data) and fires on legitimate paraphrase, deliberate
   quotes and world text. Treating it as a factual verdict would reject most
   already-approved chapters. Instead, the independent semantic review receives
   the **fresh transcript, cast/events grounding and every advisory finding**
   and decides whether the English script actually invents a fact, a mechanism,
   a motive, an identity or a number. Only a genuine unsupported claim rejects.
   There is no bypass switch and no "approve anyway" API: the only path forward
   is fixing the script or passing that review.
2. **translate** - the structured narration units are sent through the
   configured writer lane (`llm/client`), together with the cast, events,
   source dialogue and the locale glossary. The model returns one Hindi line
   per unit id plus name/term suggestions.
3. **review** - a second, independent call does two jobs: (a) judge the English
   script's factual claims against the source evidence, using the advisory
   findings as leads, and (b) check the Hindi against the English unit-by-unit.
   A rejection (or an unparseable verdict) blocks rendering.
4. **render** - `renderlane.produce(sdir, ch, out, { locale, tts, lane: "local" })`
   renders into the locale directory. The renderer must advertise locale
   support; an unmarked renderer is refused rather than risking an English
   overwrite.
5. **verify** - the MP4 is probed with `ffprobe`, hashed, and its size recorded
   before the manifest marks the chapter `completed`. English artifacts are
   hashed before and after the render and any change fails the chapter.

## Script skeleton contract

The translation must keep, exactly:

- the same number of narration units, in the same order,
- every `## BEAT ...` header, in order,
- every `@pXXXX_N` panel tag, per unit, in order,
- `@hold` on exactly the units that had it,
- every emotion control (`[deadpan]`, ...) on the same unit.

Controls are replaced by placeholders (`⟦T1⟧`, `⟦E1⟧`, `⟦H⟧`) for the model and
restored verbatim, so a dropped or moved control is a hard validation error.

Language checks:

- every line must contain Devanagari text (no untranslated English line),
- numbers are compared **by value**, so "ten thousand", "दस हज़ार", "दसहज़ार"
  and "१०,०००" are all 10000, while a changed magnitude (एक हज़ार, बीस हज़ार) is
  rejected,
- a large length difference is a **warning only**; a good Hindi line is not
  required to match an English character count.

## Cache identity

Two independent identities keep paid work from being repeated or reused wrongly:

```
translationKey = sha256(locale, prompt versions, English script, obs, bible,
                        approved glossary, writer model config)
renderKey      = sha256(translationKey, engine, voice, speed,
                        [provider, model, locale when engine is Vertex],
                        lane, renderer revision,
                        background, motion, quality, cleaner revision, panel revision)
```

- Changing **only the voice/speed/provider** re-renders from the cached
  translation. The provider/model/locale fields are added to the hash ONLY for a
  Vertex render, so every existing Edge render key is unchanged and its
  published video stays valid.
- Changing **background, motion, render quality, cleaner revision or any panel
  image** re-renders without retranslating (those are render-only inputs).
- Changing the **English script** (or approved glossary/model) retranslates.
- The model's own name suggestions live in `glossary.auto.json` and are
  **excluded** from the translation key, so writing them cannot invalidate the
  translation that produced them. Auto entries are **immutable**: a later
  chapter cannot change a pronunciation earlier chapters already used. Only an
  operator-edited `glossary.json` (approved) changes the key.

A translation is only reused when the manifest carries a matching proof
(`translation.key` + sha256 of the exact localized script + unit count) and the
script on disk still re-validates structurally. An edited, truncated or
unreviewed Hindi script is retranslated, never rendered.

### Saved provider identity

`engine`, `provider` and `modelId` are persisted on the job, the chapter record
and the published artifact. A restart, a retry or a preview therefore resolves
the SAME provider and model instead of inferring them from the voice string. An
older job (or artifact) without those fields derives them from the catalog, and
finally falls back to Edge - which is what every pre-Vertex job rendered with.

The per-line TTS proof for a localized Vertex take includes `language` and
`model`, so a Hindi take can never prove an English line (or another model's
take). The English proof string is unchanged.

The preview cache id includes engine, provider, model, locale, voice, speed and
a SHA-256 **fingerprint** of the effective Vertex configuration (provider id,
project, secret material). No token, key or project id is stored in the id; a
different account cannot serve another account's sample.

## Durable jobs

A POST persists a job under `out/languages/jobs/<id>.json` and spawns the serial
`src/cli/localize.ts` subprocess; the HTTP request returns `202` immediately.

- Statuses: `queued`, `running`, `completed`, `failed`, `interrupted`.
- Every selected chapter gets its own progress row, including chapters the run
  has not reached yet. The API always reports the **newest job** for a chapter,
  so a retry never hides behind an older `completed`/`failed` record.
- Reconcile (job + manifest) is one short state-lock transaction; a dead worker
  or a job that never started becomes `interrupted` and retryable, and the last
  good video stays published.
- The job holds a **shared** series lock for its whole life: compatible with the
  renderer's own shared lock, and it blocks the library's exclusive delete.
- The job records `pid` + process start ticks; a restart marks a dead `running`
  job `interrupted`, and a `queued` job that never started is marked
  `interrupted` after a 30s grace period. No job stays `queued` forever.
- Retries are bounded (3 attempts per chapter) and only for transient errors
  (timeouts, 5xx, 429, empty/unparseable answers). Completed chapters and
  verified videos are reused, so a retry resumes at the failed chapter.
- One localization job per series at a time. Planning is a cross-process
  transaction (flock on `out/languages/.localize.state.lock`), so two
  concurrent requests can never both pass the "no active job" check; the second
  gets `409`. The long-running worker additionally holds
  `out/languages/.localize.job.lock`.
- If the CLI subprocess cannot be spawned, the job is immediately marked
  `interrupted` with the reason (no `queued` job that never starts, no crash).
- The job also refuses to start while the **English** pipeline has an active
  intake job or a live `run.ts`/`renderlane.ts` process for the series.

### Locking note

`renderlane.produce`/`prepare` take a **shared** series lock internally, and the
shared-lock helper does not observe a held exclusive lock (taking the exclusive
lock around a render would deadlock). The job therefore holds a **shared**
series lock for its whole life — refcounted, so the renderer's own shared
acquisition nests safely — plus the localization job lock. That combination
still blocks the library's exclusive delete, which is the risk it guards.

## HTTP contract

All routes require a session cookie. Mutations require a persistent
(non-temporary) account and a valid CSRF token (header or body field), plus a
same-origin `Origin`/`Referer`.

### `GET /api/series/:slug/languages`

```json
{
  "ok": true,
  "slug": "my-series",
  "catalog": [
    {
      "locale": "hi-IN",
      "label": "Hindi",
      "nativeLabel": "हिन्दी",
      "voices": [
        {
          "id": "hi-IN-MadhurNeural",
          "label": "Madhur",
          "engine": "edge",
          "provider": "edge",
          "modelId": "edge",
          "modelLabel": "Edge",
          "available": true
        },
        {
          "id": "hi-IN-Chirp3-HD-Aoede",
          "label": "Aoede · Chirp 3 HD",
          "engine": "vertex",
          "provider": "vertex",
          "modelId": "chirp-3-hd",
          "modelLabel": "Chirp 3 HD",
          "available": false,
          "unavailableReason": "No Vertex AI credentials: connect a vertex-ai provider in Studio"
        },
        {
          "id": "gemini-tts:Charon",
          "label": "Charon · Gemini 3.8 Flash TTS",
          "engine": "vertex",
          "provider": "vertex",
          "modelId": "gemini-3.8-flash-tts",
          "modelLabel": "Gemini 3.8 Flash TTS",
          "available": false,
          "unavailableReason": "No Vertex AI credentials: connect a vertex-ai provider in Studio"
        }
      ]
    }
  ],
  "sourceChapters": [
    { "chapter": "ch1", "eligible": true },
    { "chapter": "ch2", "eligible": false, "reason": "Generate/review the English script first: ..." }
  ],
  "versions": [
    {
      "locale": "hi-IN",
      "label": "Hindi",
      "status": "completed",
      "voice": "hi-IN-MadhurNeural",
      "speed": 1,
      "updatedAt": "2026-10-20T12:00:00.000Z",
      "chapters": [
        {
          "chapter": "ch1",
          "status": "completed",
          "stage": "verify",
          "videoUrl": "/media/my-series/languages/hi-IN/ch1/video.mp4",
          "duration": 512.4,
          "updatedAt": "2026-10-20T12:00:00.000Z",
          "voice": "hi-IN-MadhurNeural",
          "speed": 1,
          "warnings": ["dropped 2 unshowable panels"]
        }
      ]
    }
  ]
}
```

`videoUrl` is present **only** for a verified artifact whose canonical file still
exists and matches its recorded size, and is cache-busted by the artifact
revision (`?rev=N`). That URL keeps working while a retry is running or after it
fails: attempt state (`status`/`stage`/`error`) and the last good video are
separate fields. `"stale": true` means the published video no longer matches the
current source or render settings (script, panel image, voice, background,
motion, quality) and should be regenerated.

`voice` and `speed` are the saved settings of the most recent request at the
version level and of the render (or in-flight job) at the chapter level, so a UI
retry can reuse them. `engine`, `provider` and `modelId` are the saved provider
identity of those settings, so a retry resends exactly what rendered.
`warnings` carries non-fatal findings (dropped panels, translation-length
advisories) that would otherwise only live in logs.

### `POST /api/series/:slug/languages`

```json
{ "locale": "hi-IN", "chapters": "1-3", "voice": "hi-IN-MadhurNeural", "speed": 1 }
```

- `202` with the same state shape; rendering continues in the background job.
- `400` unsupported locale / voice / provider, malformed chapters or speed, or
  any field outside `locale, chapters, voice, speed, csrfToken`. A Vertex voice
  with no configured credentials is `400 provider_unavailable` with the setup
  hint, before any translation spend.
- `chapters` accepts `all`, `1`, `1-3`, and comma-separated lists (`1,3`,
  `1-3,7`). A retry list is executed exactly as sent: `1,3` never includes `2`.
  Duplicates are collapsed; more than 500 chapters or a malformed list is `400`.
- `422` when a requested chapter has no eligible English source (reason in
  `error`), or the series has no chapter folders.
- `409` when a localization job is already active, or the English pipeline is
  writing the series.
- Repeating the same request after a failure retries the failed chapters;
  already-completed chapters with the same identity are free.

### `POST /api/series/:slug/languages/preview`

```json
{ "locale": "hi-IN", "voice": "hi-IN-MadhurNeural", "speed": 1 }
```

Returns `{ "ok": true, "url": "/media/<slug>/languages/hi-IN/preview/<id>.mp3" }`.
The sample text is fixed server-side (callers cannot supply text). Edge and
Vertex voices are both supported: a Vertex sample goes through the same
`synthesizeVertexTtsToFile` call as the chapter audio, with the same locale and
speed, and a `60s` AbortSignal deadline. Per-settings cache (plus a hashed
credential fingerprint) and a 10s cooldown bound TTS spend; a cancelled or timed
out sample removes its temp file and answers `504 preview_timeout`. Errors are
clean JSON without host paths or secrets.

### Media

- `GET|HEAD /media/:slug/languages/:locale/:ch/video.mp4` (add `?download=1` for
  an attachment) - range-capable streaming via `streamFile`.
- `GET /media/:slug/languages/:locale/preview/:id.mp3`

Only paths inside the locale chapter directory are served, symlinks are
refused, and the chapter id / locale are validated as tags (never path
fragments).

## CLI

```bash
# create and run a job by hand
npx tsx src/cli/localize.ts my-series --locale hi-IN --chapters 1-3 \
  --voice hi-IN-MadhurNeural [--speed 1] [--json]

# run a persisted job (this is what the server spawns)
npx tsx src/cli/localize.ts my-series --job loc-... [--json]

# inspect
npx tsx src/cli/localize.ts my-series --status [--json]
```

Exit codes: `0` completed, `1` failed, `2` bad arguments, `3` busy/conflict.

## Failure modes and what the user sees

| Situation | Result |
| --- | --- |
| No English script / failed check / stale obs | `422`, `Generate/review the English script first` plus the specific cause |
| English report lists issues but re-check passes | proceeds, records a warning |
| Vertex voice chosen with no Studio credential | `400 provider_unavailable` + setup hint, before any spend; no Edge substitution |
| Vertex credential rejected / HTTP 4xx-5xx | `failed` with a scrubbed provider message (no token or path) |
| Translation drops a tag/hold/emotion, or stays English | validation error, one bounded repair, then `failed` |
| Semantic review rejects | `failed` with the reviewer's first reason |
| Renderer lacks locale support | `failed`, English untouched |
| Renderer writes outside the locale dir | `failed`, output not published |
| Renderer changes English artifacts | `failed`, nothing published |
| Render times out once | retried; translation is reused |
| Server restarts mid-job | `interrupted` in job and manifest; retry resumes, last video still streams |
| Retry fails after a good render | `failed` + `stale`, previous `videoUrl` still streams |
| Worker subprocess cannot start | job marked `interrupted` immediately with the reason |
| Preview TTS hangs | cancelled at the deadline, child killed, temp file removed, server stays responsive |

## Tests

- `tests/language-localization.test.ts` - skeleton/control preservation, number
  values, source gating (missing script, unknown panels, report issues,
  re-check), translation/render identities, voice-change reuse, script-change
  invalidation, stale marking, bounded retry, restart reconciliation, job
  conflicts, English hash preservation, renderer path/English guards, verified
  media resolution, cached preview. LLM and renderer are fakes; MP4 fixtures are
  produced with real ffmpeg and verified with ffprobe.
- `tests/language-api.test.ts` - exact response shape, auth/CSRF/temporary
  account, unsupported locale/voice/chapters/speed, runtime-override rejection,
  `422` source ineligibility, `202` + spawn, `409` duplicate, preview contract,
  range/HEAD/download streaming, traversal and symlink refusal.
- `tests/language-vertex.test.ts` - the complete Vertex Hindi path: grouped
  catalog with configured/unavailable status, `hi-IN` discovery in its own cache
  file, Gemini Hindi lookup and request body (languageCode + Hindi prompt, no
  control tags), per-line proof identity, provider preflight with no
  translation spend, persisted/restart-preserved job identity, renderlane
  `engine: "vertex"` payload, provider-only change re-rendering without
  retranslating, bounded Vertex preview with temp cleanup, and the unchanged
  English Gemini request and Edge catalog.
- `tests/language-ui.test.ts` - pure helper behaviour (chapter spec, retry
  grouping, provider/model grouping, unavailable-voice preselection) plus panel
  wiring, with no DOM and no network.
