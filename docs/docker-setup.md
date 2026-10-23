# Docker setup: from a fresh Linux host to a first chapter

This guide uses the repository's `compose.yaml`: one Node backend and one Nginx
frontend. Only the frontend publishes a host port. The backend runs as UID/GID
1000 and stores application data in a named volume mounted at `/data`.

Run commands in Bash from the repository root unless stated otherwise. Commands
below are instructions, not a claim that this revision's full image builds or
end-to-end production workflow have been tested. No Docker installation, image
build, service change, or real provider call was performed while writing this guide.
See [Deployment](deployment.md) for architecture and separately recorded checks.

## 1. Prepare the host

### Requirements

- Linux **amd64/x86_64** is the deployment baseline. ARM, Windows, and macOS are
  not verified targets for this guide; forcing amd64 emulation is not equivalent
  to a supported native install.
- Docker Engine and the **Docker Compose plugin 2.24.0 or newer** (`docker compose`,
  not legacy `docker-compose`). The Compose file uses optional `env_file` syntax.
- Git, curl, sudo access for host installation/permissions, and an internet
  connection. Image builds download npm/Python dependencies, Chromium packages,
  cleaner source, and model weights. Runtime providers and Edge TTS need network
  access too.
- Use **one backend replica**. This scheduler is not a distributed multi-host queue.

**Planning recommendations, not measured minimums or performance guarantees:**
start with 4 CPU cores, 16 GiB RAM, and at least 50 GiB free SSD space for a small
single-job installation. More CPU/RAM helps CPU cleaning and Chromium rendering;
large chapters or parallel work can need much more. Budget additional disk space
for source images, caches, audio, videos, build layers, and a complete backup.
No GPU is required by the bundled CPU cleaner. Watch actual usage before batching.

### Install Docker

Use Docker's official instructions for your distribution; do not mix distribution
packages with Docker's repository packages:

- [Ubuntu Engine installation](https://docs.docker.com/engine/install/ubuntu/)
- [Debian Engine installation](https://docs.docker.com/engine/install/debian/)
- [Other Linux distributions](https://docs.docker.com/engine/install/)
- [Compose plugin installation](https://docs.docker.com/compose/install/linux/)

On Ubuntu/Debian, after configuring Docker's official apt repository as directed
there, the package installation is:

```sh
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git curl
sudo systemctl enable --now docker
```

Docker access is effectively root access. Use `sudo docker ...`, or explicitly
choose Docker's [non-root group setup](https://docs.docker.com/engine/install/linux-postinstall/).
If you choose the group setup, log out and back in before continuing. The rest of
this guide assumes your current account can run `docker` without sudo; otherwise
prefix Docker commands with `sudo`. Never make the Docker socket world-writable.

```sh
uname -m
docker version
docker compose version
docker run --rm hello-world
```

Expect `x86_64`, a reachable Engine server, and Compose v2.24.0 or later. Resolve
daemon/permission errors before continuing. Host Node.js, npm, Python, ffmpeg,
Chromium, and PanelCleaner are not required for this Docker installation.

## 2. Clone and set local configuration

```sh
git clone https://github.com/shairkhan2/pipeline2.git
cd pipeline2
cp .env.example .env
chmod 600 .env
```

Do not repeat `cp` over an existing configured `.env`. Edit `.env` with your editor.
For the loopback-only HTTP installation used in this guide, set:

```dotenv
PLAYER_COOKIE_SECURE=false
PLAYER_BIND=127.0.0.1
PLAYER_PORT=8080
```

The example file defaults to `PLAYER_COOKIE_SECURE=true` for HTTPS deployments.
The local HTTP flow needs the explicit `false` setting to avoid Secure-cookie
login failures. Do not publish this insecure-cookie setup to the internet.
Keep the image's storage environment defaults; changing paths without matching
mounts can put valuable files outside the persistent volume.

For a remote Linux server, keep the loopback bind. From your own computer run
`ssh -N -L 8080:127.0.0.1:8080 your-user@your-server`, then browse the local URL
below. This forwards access without opening a public application port.

## 3. Create the login file

Compose requires `secrets/player.htpasswd` to exist before startup. Create an
`admin` account interactively; the password is not an API key:

```sh
mkdir -p secrets
chmod 700 secrets
docker run --rm -it -v "$PWD/secrets:/secrets" httpd:2.4-alpine \
  htpasswd -cm /secrets/player.htpasswd admin
sudo chown 1000:1000 secrets/player.htpasswd
sudo chmod 600 secrets/player.htpasswd
```

`-m` selects **APR1** (`$apr1$`), the application's supported htpasswd verifier.
Do not use bcrypt (`-B`). `-c` creates/replaces the file: **never repeat `-c` on
an existing account file** unless intentionally replacing all accounts. To change
the password or add another username, omit `-c`:

```sh
docker run --rm -it -v "$PWD/secrets:/secrets" httpd:2.4-alpine \
  htpasswd -m /secrets/player.htpasswd admin
sudo chown 1000:1000 secrets/player.htpasswd
sudo chmod 600 secrets/player.htpasswd
```

Reapply ownership/mode after edits: the backend's UID 1000 must read the mounted
secret. A host account with another UID may need sudo to manage this file.
For an already running installation, recreate the backend after replacing the file:
`docker compose up -d --force-recreate backend` (wait for jobs to finish first).
Keep `.env`, `secrets/`, passwords, bootstrap tokens, and backups out of Git.

## 4. Build, start, and verify login

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 backend frontend
curl -f http://127.0.0.1:8080/healthz
docker compose exec backend node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(async r => {console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1)}).catch(e => {console.error(e); process.exit(1)})"
```

The initial build is large and can take substantial time. Both containers should
be running and eventually healthy; Compose waits for backend health before
starting the frontend. Inspect logs instead of assuming a fixed startup time.
The public `/healthz` is Nginx's own response; the backend command checks the API
separately. Neither proves that credentials, TTS, cleaning, or rendering work.

Open **http://127.0.0.1:8080/login** and sign in as `admin` with the password you
created. In the same logged-in browser, open `/api/session`; expect your user and
`privileged: true`. Do not share its CSRF token. An unauthenticated curl request
to `/api/session` returning 401 is normal. Verify the library and New Series page
load. This htpasswd flow does not require the first-run bootstrap wizard.

Do not submit a job or press provider/voice test controls yet. A new, empty
installation can build, start, and serve login without paid inference calls.
An existing volume can contain pending jobs that startup reconciliation resumes.

## 5. Configure the actual UI Settings

Sign in as the permanent admin and open **Settings**. Direct URLs below use the
same origin, for example `http://127.0.0.1:8080/?settings=providers`.

1. **Providers** (`/?settings=providers`): add the intended provider connection,
   endpoint, authentication, and models. Select the appropriate provider preset
   and enter its key or complete its supported account connection. Vertex AI
   supports its own service-account/OAuth project/location configuration; it is
   not interchangeable with a generic bearer key. Check provider requirements,
   billing, and limits before any test or model request.
2. **Stage routing** (`/?settings=routing`): assign configured, available models
   to vision stages (Reader, Matcher, Scout) and text stages (Writer, Fact Check).
   Confirm vision capability where needed. Review fallback chains as well as
   primaries: defaults may reference operator-specific services that you do not
   run. Remove unavailable or unwanted paid fallbacks and save the configuration.
3. **Voice** (`/?settings=voice`): choose an available engine/voice. Edge TTS is
   bundled and uses an external network service; it is not offline or a promise
   of service availability. Other engines need their own credentials/adapters.
   Voice previews can call external services and can incur charges. Hindi Vertex
   voices require a connected Vertex provider; see [language versions](language-versions.md).
4. **Render nodes** (`/?settings=nodes`): review node availability and render-lane
   configuration. Start with the built-in **local** lane and one slot. Do not
   enable cloud/laptop/SSH nodes without provisioning those workers. On the New
   Series form, explicitly choose the local render lane for your first test.

Settings persist in `/data/out`, including provider configuration and
`/data/out/config/secrets.json`. The secret store uses mode 0600; values are
plaintext unless `MANHWA_MASTER_KEY` is configured. If you enable that optional
encryption, retain the same key across restarts and back it up securely; changing
or losing it prevents decrypting saved credentials. Do not assume a masked UI
value means the on-disk file is encrypted.

A provider at `127.0.0.1` means **inside the backend container**, not your host.
For a host model server, explicitly configure a Docker-reachable address and
secure network access. Linux does not automatically provide every Docker Desktop
hostname mapping. There is no model server, agy rotator, or cloud worker in Compose.

## 6. Run one small chapter only when ready

This is the first deliberate end-to-end test, not an automatic installation step.
It can make paid provider calls. Set provider-side spend limits first; retries
and fallbacks can make more than one request.

1. Prepare a small ZIP containing chapter images you have permission to process.
   Use a simple layout such as `ch1/001.jpg`, `ch1/002.jpg`, `ch1/003.jpg`.
2. Open **New Series**, choose ZIP upload, and use a unique scratch series slug.
   Select chapter `1`, not `all`. Check the intended provider routes, voice, and
   **local** render lane before submitting. Submission starts processing; it is
   not merely passive file storage.
3. Submit once. Follow job progress in the UI and
   `docker compose logs -f --tail=100 backend`. Do not bulk retry failures before
   reading their cause and checking costs.
4. Inspect the generated script/audio/video, playback seeking, and download.
   Confirm the chapter succeeded before attempting a larger batch. Reusable
   caches reduce duplicate work but do not guarantee zero-cost retries.

The backend image already bundles **PanelCleaner**, CPU torch, detector/LaMa
weights, Tesseract English, Chromium, ffmpeg/ffprobe, Edge TTS, and local Remotion
dependencies. You do not need a separate PanelCleaner service. Cleaner failure
can fall back to uncleaned panels; a completed video alone does not prove cleaning
succeeded. Inspect logs/output quality.

## 7. Know what persists

| Location | What it contains |
| --- | --- |
| `/data/series` | Sources, analysis/paid caches, scripts, audio, rendered media |
| `/data/out` | Jobs/uploads/previews, logs, settings, provider secrets, lane configuration |
| `/data/thumbnails` | Library thumbnails |
| `/data/auth` | Session signing key and temporary-user metadata |
| Host `.env` and `secrets/player.htpasswd` | Runtime environment and login file; outside the volume |

`pipeline-data` is the **Compose logical volume key**, not a guaranteed Docker
volume name. The real name depends on the Compose project name. Keep the same
checkout/project name for normal operations; changing directories, `-p`, or
`COMPOSE_PROJECT_NAME` can select an empty volume and make data appear missing.
Host `series/` and `out/` are not mounted by this Compose file.

Container replacement, `stop`, and ordinary `down` preserve the named volume.
**Never run `docker compose down -v`, `docker volume prune`, or volume removal
against data you want to keep.** Do not delete cache directories as a routine
troubleshooting step: they can represent paid work.

## 8. Stop and restart safely

Stop submitting new work and let active jobs finish before maintenance. The
60-second stop grace period is not a job-aware drain. Then:

```sh
docker compose stop
docker compose start
```

Run these separately as needed, not as a mandatory pair. After changing `.env`,
use `docker compose up -d --force-recreate` instead of `restart` so containers
receive the new environment. Ordinary `docker compose down` removes containers
and their network but retains data; `docker compose up -d` recreates them.

## 9. Back up the real volume and host configuration

Use this in the repository root **after jobs finish**. It stops services for a
consistent file backup. Keep the resulting directory protected and copy it to
another disk/host securely. It contains credentials and session material.

```sh
umask 077
BACKUP_DIR="$HOME/pipeline-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
BACKEND_ID="$(docker compose ps -a -q backend)"
test -n "$BACKEND_ID"
DATA_VOLUME="$(docker inspect "$BACKEND_ID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
docker volume inspect "${DATA_VOLUME:?No /data named volume found}"
git rev-parse HEAD > "$BACKUP_DIR/source-commit.txt"
docker compose images > "$BACKUP_DIR/images.txt"
docker compose stop
docker run --rm -v "${DATA_VOLUME:?}:/data:ro" alpine:3.20 \
  tar -C /data -czf - . > "$BACKUP_DIR/pipeline-data.tar.gz"
sudo tar -czf - .env secrets > "$BACKUP_DIR/host-config.tar.gz"
tar -tzf "$BACKUP_DIR/pipeline-data.tar.gz" > /dev/null
tar -tzf "$BACKUP_DIR/host-config.tar.gz" > /dev/null
docker compose start
```

Run line by line and **stop on any error**. `test` or inspection failure must not
be ignored. The data mount is read-only during backup; tar preserves numeric
ownership in the archive. Archive listing checks readability, not full recovery.
Test a restore separately. Retain any external master key, worker credentials,
Compose overrides, and source modifications too; this example archives only the
standard `.env`, `secrets/`, and `/data` contents.

## 10. Restore without overwriting the current volume

Use a **separate checkout/directory**, compatible source/images, and an unused
Compose project name. Restore never merges cleanly with a running installation.
Do not extract an archive over the live volume. The following creates a fresh
project named `pipeline-restore`; verify that name is unused first.

In that separate checkout, set the absolute backup path and recover host files:

```sh
BACKUP_DIR="$HOME/pipeline-backups/REPLACE_WITH_BACKUP_TIMESTAMP"
sudo tar -xzpf "$BACKUP_DIR/host-config.tar.gz" -C .
sudo chown "$(id -u):$(id -g)" .env secrets
sudo chmod 600 .env
sudo chown 1000:1000 secrets/player.htpasswd
sudo chmod 600 secrets/player.htpasswd
```

Read/edit the restored `.env`. Use `PLAYER_BIND=127.0.0.1`
and an unused `PLAYER_PORT`, such as `8081`; use insecure cookies only for local
HTTP. Recovered provider credentials and queued jobs can make real calls on
startup. For a recovery drill, use only a backup with no runnable work, disable
provider access, and isolate external network access before starting the backend.

Build the compatible revision if its images are not available, then create but
**do not start** the backend. Derive its new volume name:

```sh
docker compose -p pipeline-restore build
docker compose -p pipeline-restore create backend
RESTORE_ID="$(docker compose -p pipeline-restore ps -a -q backend)"
test -n "$RESTORE_ID"
RESTORE_VOLUME="$(docker inspect "$RESTORE_ID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
docker volume inspect "${RESTORE_VOLUME:?No restore volume found}"
docker run --rm -v "${RESTORE_VOLUME:?}:/data:ro" alpine:3.20 ls -la /data
```

Confirm this is the **new** volume, not the original. Image-initialized empty
directories are normal. If it contains existing jobs/media, stop and choose a
new project name. Only after that check, restore ownership and contents:

```sh
docker run --rm -i -v "${RESTORE_VOLUME:?}:/data" alpine:3.20 \
  tar -C /data -xzpf - < "$BACKUP_DIR/pipeline-data.tar.gz"
docker compose -p pipeline-restore up -d
docker compose -p pipeline-restore ps
```

Use the new port to verify login, library, settings, source/cache files, and
sample video playback. Keep the original volume and backups until recovery is
verified. Use `-p pipeline-restore` on every subsequent command for this project.

## 11. Update without losing data

Finish jobs and make the backup above first. Record the current source revision
and image list. Preserve `.env`, `secrets/`, the project name, and volume.

```sh
git status --short
git pull --ff-only
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 backend frontend
```

If Git reports local changes or cannot fast-forward, stop and reconcile them;
do not reset or overwrite local work. If the build fails, do not force recreation
with missing images. Check login and a small intentional test after upgrading.
Read release/migration notes first: an old image may not understand new on-disk
data. A rollback may require the matching pre-update backup and source revision,
not only rebuilding an old commit. Never use `down -v` as an update step.

## Troubleshooting

- **Compose rejects `env_file` / `required`:** upgrade the Compose plugin to
  2.24.0 or later. Confirm you are using `docker compose`.
- **Docker permission denied:** confirm daemon access/group membership or use
  sudo. Do not loosen socket permissions.
- **Secret missing / mount is a directory:** create the actual
  `secrets/player.htpasswd` file before startup. Do not replace it with a folder.
- **Login rejected:** verify username/password, APR1 format, and UID 1000 read
  access. Reapply the ownership/mode commands and recreate the backend after
  replacing the secret. Do not print the full hash/password into shared logs.
- **Login loops on HTTP:** set `PLAYER_COOKIE_SECURE=false` for loopback HTTP and
  recreate containers. Clear old cookies; use one consistent hostname/port.
- **403 on Settings edits behind a proxy:** preserve the original public Host
  header, including a non-default port. Use one browser-facing origin; do not
  point browser JavaScript at `http://backend:8080`.
- **Backend cannot write `/data`:** inspect logs and `docker compose exec backend
  id`. Default named-volume initialization is designed for UID/GID 1000. A
  migrated/bind-mounted directory must have appropriate ownership. Do not run
  broad recursive chown against an unknown host path or erase data to fix it.
- **Frontend healthy but API fails:** Nginx health is independent. Use the backend
  health command in section 4 and inspect both services' logs.
- **Killed build/render, exit 137, disk full:** check `free -h`, `df -h`,
  `docker stats --no-stream`, and `docker system df`. Reduce work/concurrency or
  add resources. Do not prune volumes or paid caches to free space.
- **Provider connection refused:** container loopback is not host loopback.
  Verify reachable endpoints, saved credentials, supported models, stage routes,
  quotas, and egress before retrying. A default lane is not a bundled provider.
- **Port 8080 in use:** choose another `PLAYER_PORT` in `.env`, recreate, and use
  that port consistently in your browser, tunnel, and checks.
- **Cleaning unavailable:** inspect backend logs. The image already bundles
  PanelCleaner; repeated failures can temporarily pause cleaning and leave
  bubbles visible. Do not assume health checks exercise a full cleaner job.

For public deployment, put a properly configured **HTTPS reverse proxy** in
front of the frontend and set `PLAYER_COOKIE_SECURE=true`, then recreate services.
TLS certificates/reverse proxy are not bundled in Compose. Retain loopback bind
when the proxy runs on the host; other topologies need deliberate private-network
configuration. Publishing `0.0.0.0` is not an HTTPS setup.

Optional remote/cloud/SSH render workers, provider/model servers, agy rotator,
external voice adapters, credentials, storage access, and Docker sandbox runtime
support require separate provisioning. The presence of SSH/rsync or a sandbox CLI
in the image does not provision these integrations. See [Deployment](deployment.md)
and [frontend/backend architecture](frontend-backend.md) for further details.
