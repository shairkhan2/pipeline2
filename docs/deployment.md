# Deploy the frontend and backend images

## Requirements and boundaries

- Docker Engine with Compose 2.24 or newer.
- Linux/amd64 is the initial target. The backend includes Chromium, ffmpeg/ffprobe, flock, SSH/rsync, and Edge TTS. It runs as UID/GID 1000.
- The frontend contains only static assets and Nginx. The backend contains the API, pipeline, and local Remotion renderer. Both images have independent health checks.
- The backend bundles the bubble cleaner: PanelCleaner (pinned upstream commit, CPU torch) at `/opt/panelcleaner`, its verified text-detector and LaMa weights, and Tesseract English. Promo OCR uses the same detector. If the cleaner fails, it is retried once per batch; after repeated failed batches it pauses (`MANHWA_CLEANER_MAX_FAILS`, default 3; `MANHWA_CLEANER_COOLDOWN_S`, default 1800) and ordinary panels ship uncleaned instead of failing the render.
- The optional agy rotator, external voice adapters, and cloud/SSH credentials are deployment-specific integrations. They are **not bundled**. API health alone does not assert pipeline readiness.
- Keep one backend replica. The current scheduler and local durable-file queue are not a multi-host distributed service.

## Build and start

From the repository root:

```sh
cp .env.example .env
mkdir -p secrets
docker run --rm -it -v "$PWD/secrets:/secrets" httpd:2.4-alpine \
  htpasswd -cm /secrets/player.htpasswd admin
docker compose build
docker compose up -d
docker compose ps
```

`htpasswd -m` is required by the existing APR1 verifier. Ensure the mounted file is readable by UID 1000. Re-running the command with `-c` replaces the account file; omit `-c` when adding users.

The frontend listens on `127.0.0.1:8080` by default. Put an HTTPS reverse proxy in front of it and preserve the original Host header, including any port. Cookies are Secure by default. For **local HTTP testing only**, set `PLAYER_COOKIE_SECURE=false` in `.env` and recreate the backend. Do not use that setting on a public HTTP deployment.

Open `/login`, sign in, and check `/api/session`, the library, status, and intake pages. Backend port 8080 is internal to Compose; only the frontend port is published. The frontend forwards uploads without buffering, and media range requests reach the backend unchanged.

## Build images independently

Both builds use the repository root as context:

```sh
docker build -f docker/frontend/Dockerfile -t pipeline-v2-frontend:local .
docker build -f docker/backend/Dockerfile -t pipeline-v2-backend:local .
# When using Podman, pass --format docker so HEALTHCHECK metadata is preserved:
podman build --format docker -f docker/frontend/Dockerfile -t pipeline-v2-frontend:local .
podman build --format docker -f docker/backend/Dockerfile -t pipeline-v2-backend:local .
```

Set frontend `BACKEND_URL` to an origin such as `http://backend:8080` (no path or trailing slash). The hostname must resolve when Nginx starts. Recreate/reload the frontend when changing the backend address. Retain a shared browser-facing origin: do not point browser JavaScript at a container DNS name.

## Persistent data and credentials

The `pipeline-data` volume holds:

| Container path | Contents |
| --- | --- |
| `/data/series` | Source chapters, paid caches, scripts, audio, rendered video |
| `/data/out/jobs` | Durable intake job records, uploads, previews |
| `/data/out` | Pipeline log, telemetry, lane configuration and locks |
| `/data/thumbnails` | Library thumbnails |
| `/data/auth` | Persistent session signing secret and optional temporary-user expiry map |

Back up the whole volume and retain `/data/auth/session.key` across restarts. Do not use `docker compose down -v` unless you intend to delete stored pipeline data. Bind mounts must be writable by UID 1000. Use copies of existing series for migration validation; do not mount the original live Python library writable during testing.

Provider credentials belong in runtime `.env` or a deployment secret mechanism. No local `.env`, `env.sh`, credentials, series, or node_modules are sent in the Docker context. The image explicitly configures common storage paths, avoiding CLI/player legacy-default mismatches.

For optional adapters, extend the backend image or add Compose override mounts and environment variables. Do not mount a host Python virtual environment built for a different OS/runtime and assume it will work. Cleaner dependencies and models need their own reproducible image extension. SSH/cloud workers also need explicit tool installations, authentication, and reachable worker paths.

## Operations and verification

```sh
curl -f http://127.0.0.1:8080/healthz
docker compose exec backend node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(async r => console.log(r.status, await r.text()))"
docker compose exec backend ffprobe -version
docker compose exec backend /opt/tts/bin/python -m edge_tts --help
docker compose exec backend chromium --version
docker compose exec backend /opt/panelcleaner/venv/bin/python -m pcleaner.main --version
docker compose logs --tail=100 backend frontend
```

Before production use, test login/session expiry, CSRF-protected lane edits, invalid JSON, ZIP uploads, video seeking, and restart recovery against scratch data. Test a short local render after configuring the cleaner and providers. No image build or health check makes paid API calls.

Stop accepting new jobs and let active jobs finish before planned upgrades. Compose uses an init process and a 60-second shutdown grace period; this is not yet a job-aware graceful drain. Interrupted jobs rely on the existing durable reconciliation/retry flow. Do not scale API replicas until scheduler ownership has been separated.

Local development remains available with `npm run player`; omit `PLAYER_API_ONLY=1` to serve assets directly without Nginx. See `frontend-backend.md` for architecture and further modernization work.

After building both images, run `npm run test:images` for an offline integration check. It creates disposable containers, credentials, and scratch media, then removes them. It tests login, authenticated assets, API-only isolation, CSRF rejection, invalid JSON, and byte-range seeking without paid calls. For Podman, use `CONTAINER_ENGINE=podman npm run test:images`.

Set `SMOKE_RENDER=1` to also render one synthetic frame and verify it with ffprobe. This checks local Chromium/Remotion dependencies without a cleaner, source chapter, or provider request.

### Verification recorded on 2026-10-17

- Both Dockerfiles built successfully with Podman on Linux/amd64.
- The generated frontend Nginx configuration passed `nginx -t`.
- The disposable-container integration test passed authentication, protected assets, API-only isolation, proxy-preserved CSRF, malformed JSON, and media ranges.
- A synthetic one-frame Chromium/Remotion render completed and ffprobe reported a positive duration.
- The application suite passed 514 tests; TypeScript checks passed. The focused HTTP suite also passed after the upload deadline changes.

Docker Compose itself was not available on the verification host; the equivalent two-image network was exercised through Podman. Actual provider calls, full cleaner jobs, remote render lanes, and production TLS termination require deployment-specific verification. When running the backend outside Compose, pass `--init` so Node and its child processes receive normal termination handling.
