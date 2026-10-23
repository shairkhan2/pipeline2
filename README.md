# Manhwa Pipeline v2

A TypeScript pipeline and browser workspace for turning chapter images into
reviewed narration and rendered recap videos. The backend manages intake,
provider calls, cached analysis, durable jobs, audio, rendering, and media
delivery. The React frontend provides the library, batch controls, and Studio.

**Install with Docker:** follow the [beginner Docker setup guide](docs/docker-setup.md)
for Engine/Compose installation, login, provider setup, a first chapter, and safe
backups and updates. See [Deployment](docs/deployment.md) for image architecture
and advanced verification.

## Features

- Import chapter ZIPs and process English chapters in batches, with continuity
  checks, panel analysis, script generation, review, and reusable caches.
- Generate Hindi (`hi-IN`) narration and video from reviewed English scripts.
  Localization reuses source analysis without modifying English artifacts.
- Produce chapter videos with TTS, panel motion, and optional bubble cleaning;
  browse, stream, and download completed media.
- Merge chapter videos and generate or attach an outro through series tools.
- Configure providers, models, role lanes, voices, and render nodes in Studio.
  Local rendering and optional remote/cloud lanes have separate requirements.
- Track durable batch and localization jobs, retry transient failures, and
  reconcile interrupted work. Retries reuse matching verified artifacts;
  permanent errors and failed source checks require operator action.

These workflows require configured providers and the relevant external tools.
A running UI or successful `/healthz` response does not prove render readiness.
Provider calls, voice previews, and cloud capacity can incur charges.

## Prerequisites

- Node.js 22 and npm for source development.
- Linux is the deployment baseline; filesystem locking uses `flock` from
  `util-linux`. Install `ffmpeg`/`ffprobe` for media operations and media tests.
- For local video production: dependencies in `remotion-studio/`, Chromium and
  its runtime libraries, and a configured TTS engine. Edge TTS needs Python and
  `edge-tts`, plus network access; no API key does not mean offline operation.
- Optional source-install cleaning needs PanelCleaner, its Python dependencies,
  detector/inpainting models, and Tesseract. These are not installed by `npm ci`.
  The backend Docker image bundles the cleaner, models, Chromium, and Edge TTS.
- Optional remote render lanes need their own workers, tools, authentication,
  and reachable storage paths. External voice adapters and the agy rotator are
  deployment-specific integrations, not bundled services.
- Container deployment requires Docker Engine and Compose 2.24 or newer.

## Safe local quickstart

Use a separate checkout for development, not a directory serving live traffic.
The following starts an empty, loopback-only workspace with temporary storage.
It does not import existing jobs or configure paid providers. Run from the
repository root in one shell:

```sh
npm ci
npm ci --prefix frontend
mkdir -p /tmp/opencode
export DEV_ROOT="$(mktemp -d /tmp/opencode/pipeline-dev.XXXXXX)"
mkdir -p "$DEV_ROOT"/{series,out/jobs,thumbnails,auth}
npm --prefix frontend run build -- --outDir "$DEV_ROOT/public"
export MANHWA_SERIES_ROOT="$DEV_ROOT/series"
export MANHWA_OUT_DIR="$DEV_ROOT/out"
export MANHWA_JOBS_DIR="$DEV_ROOT/out/jobs"
export MANHWA_THUMBS_ROOT="$DEV_ROOT/thumbnails"
export MANHWA_LANE_CONFIG="$DEV_ROOT/out/lanes.json"
export PIPELINE_LOG="$DEV_ROOT/out/pipeline.log"
export PLAYER_HTPASSWD="$DEV_ROOT/auth/htpasswd"
export PLAYER_SECRET_FILE="$DEV_ROOT/auth/session.key"
export PLAYER_TEMP_USERS="$DEV_ROOT/auth/temp-users.json"
export PLAYER_PUBLIC="$DEV_ROOT/public"
HOST=127.0.0.1 PORT=4176 PLAYER_COOKIE_SECURE=false npm run player
```

Open `http://127.0.0.1:4176/setup.html` and use the one-time bootstrap token
printed by the server to create an account. Keep this token private. Use insecure
cookies only for loopback HTTP testing; public deployments require HTTPS.
Temporary data stays at `$DEV_ROOT`; retain that directory if you need it later.
Do not enable providers or submit a batch until you intend to make real calls.

**Build warning:** `npm --prefix frontend run build` normally empties and writes
`src/player/public`, which may be the live player assets. For development checks,
always override `--outDir` with a new temporary directory, as above. The build
also runs frontend TypeScript checks. Do not rebuild live assets casually.

For frontend hot reload, keep the backend above running and use a second shell:

```sh
VITE_API_TARGET=http://127.0.0.1:4176 npm --prefix frontend run dev -- --host 127.0.0.1
```

Vite uses port 5173 by default and proxies API/media routes. Complete account
setup and login on the backend origin; it is the baseline for authentication
and same-origin mutation checks.

## Configure and run a series

In Studio, connect the required providers, assign vision/writer model lanes,
select a voice engine, and configure the intended render lane. Start with a
short scratch chapter before submitting a batch. Hindi Vertex voices require a
connected Vertex AI provider in Studio; unavailable voices are not silently
replaced with Edge. Translation and independent review also need a writer lane.

For CLI use, keep the scratch storage environment above in the calling shell.
Chapter images belong under `<slug>/ch1/`, `<slug>/ch2/`, etc., within
`MANHWA_SERIES_ROOT` (default: `series/`). Processing can make provider calls:

```sh
npm run run -- my-series --status
npm run run -- my-series ch1
npm run run -- my-series --video --all
```

Install render dependencies with `npm ci --prefix remotion-studio` before local
video production, then configure the external tools described above. See the
[language-version guide](docs/language-versions.md) for Hindi eligibility,
provider setup, CLI commands, caching, and retry behavior.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/cli/`, `src/stages/`, `src/llm/` | Orchestration, analysis, writing, provider calls |
| `src/intake/`, `src/workers/`, `src/localization/` | Durable intake, rendering, language versions |
| `src/player/`, `src/config/` | HTTP API, authentication, Studio configuration |
| `frontend/` | React/Vite application source |
| `remotion-studio/` | Video compositions and local renderer dependencies |
| `series/`, `out/`, `thumbnails/` | Default local data, caches, jobs, and media |
| `tests/`, `tools/` | Automated tests and operational utilities |
| `docker/`, `compose.yaml`, `docs/` | Images, deployment definition, detailed guides |

## Checks and deployment

Run `npm run typecheck`, `npm test`, and `npm --prefix frontend run typecheck`.
Media tests require real `ffmpeg`/`ffprobe`; configured provider smoke tests are
separate from offline checks. Use the temporary-output build above to check
frontend bundling without replacing player assets.

The existing deployment uses separate Nginx frontend and Node backend images,
one backend replica, and a persistent `pipeline-data` volume. Follow
[Deployment](docs/deployment.md) for `.env.example`, login credentials, image
builds, HTTPS, backups, and `npm run test:images` offline integration checks.
Do not use `docker compose down -v` unless you intend to delete persisted data.
Keep credentials out of source control and use scratch copies for migration tests.

See also [frontend/backend architecture](docs/frontend-backend.md),
[language versions](docs/language-versions.md), and [roadmap](ROADMAP.md).
