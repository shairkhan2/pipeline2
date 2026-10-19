# Creative Studio Architecture & Fresh-Install Improvement Plan

Audited by **Gemini 4 Argon**, **WorkBuddy DeepSeek (`workbuddy/deepseek-v4.1-flash`)**, and **Grok 4.7 (`xai/grok-4.7`)**.

---

## 1. Why a Fresh Install Fails Today (Inherited Host/Personal Coupling)

Even with separate `frontend` and `backend` container images, a fresh deployment currently inherits the original author's host environment and blocks UI-driven setup in 6 places:

1. **Hardcoded Author Model Chains & Transports (`src/config/laneConfig.ts:109`, `src/config/laneRegistry.ts:33-123`, `src/llm/client.ts:166-246`)**
   - Default `vision` and `writer` chains point to `agy:gemini-3.8-flash-*` (`http://127.0.0.1:8329/v1`), `workbuddy:deepseek-v4.1-flash` (`https://www.codebuddy.ai/v2`), and `opencode:mimo-v2.5-free` (`http://127.0.0.1:8324/v1`).
   - `UNAVAILABLE_MODEL_CANDIDATES` hardcodes a blocklist against `grok:grok-4.7` / `grok-4.6` / `grok-4.3`.
   - `src/llm/client.ts:40` hardcodes `VPROJ = "gen-lang-client-0479917230"` and `~/.config/gcloud/application_default_credentials.json`.
   - `src/llm/client.ts:572` and `src/stages/audio.ts:768` fall back to reading `~/.hermes/.env`.
2. **Hardcoded Personal Paths (`src/stages/audio.ts:60,203`, `src/intake/voicePreview.ts:400`, `src/intake/intake.ts:100`, `src/player/server.ts:52`)**
   - Fallback paths reference `/home/shair/manhwa-pipeline/.venv/bin/python`, `/home/shair/home/tts/providers.json`, `~/genspark-rotation/gskr`, and `/home/ubuntu/agy-rotation`.
3. **`FORBIDDEN_KEYS` & Fixed Catalogs Block UI Model/Node Addition (`src/config/laneConfig.ts:45-76, 1080, 1191`)**
   - `lanes.json` is a *selection* file, not a *registration* store: it rejects `url`, `baseUrl`, `apiKey`, `host`, `ssh`, `token`, `headers`, and rejects any model ID or render lane ID not already in the static catalog.
4. **Only 2 Model Roles (`vision`, `writer`) Instead of Per-Stage Routing (`src/config/laneConfig.ts:38`)**
   - `reader.ts`, `visualMatcher.ts`, `cleaner.ts`, and `scout.ts` all share `lane: "vision"`.
   - `writer.ts` and `storyWriter.ts` share `lane: "writer"`.
   - `factCheck.ts` is deterministic rules today (no optional LLM verify pass), and TTS is not configurable from the UI.
5. **Closed Set of 3 Render Lanes (`laptop`, `cloud`, `local`) Read from Startup Env (`src/config/renderPolicy.ts:95`, `src/workers/lappy.ts:41`, `src/workers/cloudlane.ts:57`, `src/player/public/new-series.js:37`)**
   - `MANHWA_RENDER_REMOTE` and `MANHWA_RENDER_CLOUD` are read once at process start.
   - `cloudlane.ts` and `lappy.ts` are singletons rather than multi-node instances, and `new-series.js` + `jobs.ts` filter out any lane ID outside `inherit | local | laptop | cloud`.
6. **No First-Run Onboarding Wizard (`src/player/server.ts:59, 148`, `docker/backend/Dockerfile:29`)**
   - If `.htpasswd` is missing on a fresh volume, login permanently returns `401` with no `/setup` bootstrap flow.

---

## 2. Target Architecture: Self-Contained Creative Studio

### A. Clean Storage Split (`out/config/`)
Keep `lanes.json` credential-free while adding dedicated, locked (`0600`) registration stores:
- **`out/config/providers.json` (`0600`)**: Registered LLM & TTS providers (`id`, `label`, `kind`, `protocol`, `baseUrl`, `auth.mode`, `secretRef`, `models[]`, `lastTest`).
- **`out/config/secrets.json` (`0600`, write-only API)**: Raw API keys, OAuth `access_token` / `refresh_token` / `expires_at`, GCP Vertex Service Account JSON, and SSH private keys. Encrypted with AES-256-GCM when `MANHWA_MASTER_KEY` is set. `GET` endpoints only ever return `{ hasSecret: true, hint: "sk-...4f2a" }`.
- **`out/config/render-nodes.json` (`0600`)**: Registered render workers (`local`, `docker-sbx` cloud sandboxes, `ssh` remote workers).
- **`out/lanes.json` (Schema v2)**: Ordered stage-to-model routing chains and active render-node order/slots. Auto-migrates v1 `lanes.json` on read.
- **`out/config/studio-audit.log`**: Append-only audit trail (`{ at, user, action, target, revision }`) with zero secret material.

---

### B. OpenCode-Style Provider & Model Adder (4 Connection Modes)

Users can add any model provider from the browser UI (`/studio.html`) with **Test Connection** and **Auto-Discover Models (`/v1/models`)**:

1. **Preset & Custom Cloud APIs (`builtin-api` / `openai-compatible`)**
   - Built-in form templates (not pre-enabled until configured): **OpenRouter**, **OpenAI**, **Anthropic**, **Google Gemini**, **xAI (Grok)**, **DeepSeek**, **Alibaba DashScope**, **Groq**, **Together**, **Fireworks**, plus **Custom OpenAI-Compatible** (`baseUrl` + Bearer key + custom headers + custom `extraBody`).
2. **Subscription & OAuth Flows (`subscription`)**
   - **OpenAI Codex (ChatGPT Plus/Pro):** OAuth2 PKCE flow (`auth.openai.com`) with browser login link + callback URL/code paste (`access_token` + `refresh_token` auto-refresh in `client.ts` -> Codex `responses` adapter).
   - **Claude Pro / Max:** OAuth PKCE login link / code paste or `claude setup-token` token (`anthropic-beta: oauth-2025-04-20` -> `/v1/messages` adapter).
   - **GitHub Copilot / Device Flow Providers:** `POST /api/studio/providers/oauth/device-start` displays the 8-character user code + verification link and polls until authorized.
   - **Subscription Gateways (`CLIProxyAPI`, `opencode serve`, `WorkBuddy`, `AGY`):** Point to the gateway URL + optional token and auto-import all exposed subscription models.
3. **Cloud IAM (`vertex-ai`)**
   - **GCP Vertex AI:** Drag-and-drop Service Account `.json` + `projectId` + `location` (`global`, `us-central1`, etc.). Backend signs RS256 JWTs natively via `node:crypto`, caches 55-minute OAuth bearer tokens, and calls Vertex Gemini / Partner endpoints with zero `gcloud` CLI dependency.
4. **Local Endpoints (`local`)**
   - One-click presets for **Ollama** (`:11434/v1`), **LM Studio** (`:1234/v1`), **vLLM** (`:8000/v1`), and **llama.cpp**.
   - Explicit `allowPrivateNetwork: true` opt-in for local endpoints so remote endpoints remain protected by strict SSRF guards.

Each model entry has editable capability badges:
- `vision` (required for `reader`, `matcher`, `scout`, `cleaner` OCR verification)
- `json` / structured output
- `reasoning` / `thinking` (`enable_thinking`, `reasoning_effort`)
- `streaming`
- `contextWindow` & `maxOutputTokens`

---

### C. Stage-to-Model Router Matrix

Replaces the fixed 2-role (`vision` / `writer`) bottleneck with per-stage ordered chains (Primary + Fallbacks + Concurrency + Temperature):

| Stage ID | Purpose | Capability Gate | Default Fallback Inheritance |
|---|---|---|---|
| **`reader`** | Panel vision extraction (`reader.ts`) | Requires `vision: true` | Primary vision chain |
| **`matcher`** | Visual contact-sheet & semantic panel matching (`visualMatcher.ts`, `writer.ts`) | Requires `vision: true` | Inherits `reader` if unset |
| **`writer`** | Chapter recap & story script generation (`writer.ts`, `storyWriter.ts`) | Text (`vision` optional) | Primary writer chain |
| **`scout`** | Promo / watermark / credit page detection (`scout.ts`, `cleaner.ts`) | Requires `vision: true` | Inherits `reader` if unset |
| **`fact_check`** | Deterministic rules + optional LLM continuity verifier (`factCheck.ts`) | Text (optional toggle `llmVerify`) | Deterministic rules by default |
| **`tts`** | Voice narration engine (`edge`, `elevenlabs`, `openai-tts`, `custom`) | Audio synth | Built-in `edge-tts` default |

*Paid-cache hash invariant preserved:* `briefHash`, `schemaHash`, `pagesHash`, `narrationCacheKey`, and `promoCacheHash` are computed from prompt contracts and media inputs — changing provider/model routing never invalidates already-paid chapter caches unless `--force` is used.

---

### D. Renderlane & Worker Adder (`Local`, `Docker Cloud Sandbox sbx`, `Remote SSH`)

Replaces the hardcoded `laptop | cloud | local` singleton assumption with a dynamic **Node Registry (`src/workers/nodeRegistry.ts`)**:

1. **Local Node (`kind: "local"`)**
   - Always available out of the box on a fresh container install; configurable slot cap (`1..N`) and cleaner toggle.
2. **Docker Cloud Sandbox Adder (`kind: "docker-sbx"`)**
   - Add one or more `sbx` sandboxes from the UI: `id`, `label`, `box` (`^[a-z0-9][a-z0-9-]{2,62}$`), `template` (`manhwa-render-arm`), `slots` (`1..2`), `maxHours` (TTL budget), `idlePauseS`.
   - UI actions: **Test Probe**, **Status**, **Start**, **Stop**, and (when `MANHWA_ALLOW_SANDBOX_CONTROL=1` is enabled) **Create Sandbox**.
   - Refactors `cloudlane.ts` into `createCloudNode(cfg)` so multiple sandboxes can run concurrently with isolated semaphores, TTL timers, and circuit breakers.
3. **Remote SSH Worker Adder (`kind: "ssh"`)**
   - Add one or more SSH render machines from the UI: `id`, `label`, `host`, `user`, `port`, `remoteDir`, uploaded SSH key (`secretRef` in `secrets.json`, mode `0600`), `slots`, `supportsCleaner`, `maxLoadFactor`, `minMemGb`, `minDiskGb`.
   - Refactors `lappy.ts` into `createSshNode(cfg)` using strict `argv`-only SSH execution (rejecting leading `-` host strings or `ProxyCommand` injection).

---

### E. First-Run Setup Wizard (`/setup`)

On a fresh container install (`!hasAnyUser(HTPASSWD) && !exists(.setup-complete)`):
1. **Step 1 — Create Admin Account:** Protected by a one-time `setupToken` printed to container logs (or `MANHWA_SETUP_TOKEN`), writes `/data/auth/htpasswd` (`0600`), and signs the admin in.
2. **Step 2 — Add First AI Provider:** Connect OpenRouter, OpenAI/Codex, Claude, Gemini/Vertex, xAI Grok, DeepSeek, or Local Ollama; test connection and auto-assign `reader` + `writer` models.
3. **Step 3 — Configure Render Lanes:** Local render lane is active immediately; optionally add a Docker `sbx` sandbox or SSH worker.
4. **Step 4 — Launch Studio:** Writes starter `out/config/providers.json`, `out/config/render-nodes.json`, and `out/lanes.json`, marks `.setup-complete`, and opens the Studio.

---

### F. Non-Negotiable Security Guardrails (from `xai/grok-4.7` Audit)

1. **Write-Only Secrets:** API keys, OAuth tokens, Vertex keys, and SSH private keys never enter `lanes.json`, `shots.json`, `report.json`, or `GET /api/*` responses.
2. **SSRF Protection on `/test` and `/models/discover`:** Only `http:` / `https:`, no redirect following, DNS resolution pinned and checked against link-local (`169.254.0.0/16`), cloud metadata, and loopback/RFC1918 unless `kind === "local"` is explicitly enabled by an admin.
3. **Strict `argv` Validation for `sbx` and `ssh`:** Hostnames, usernames, remote directories, and sandbox names are validated against strict regex allowlists (`^[A-Za-z0-9._-]+$`); no shell-string interpolation of user fields.
4. **Admin-Only Studio Routes + CSRF + Optimistic Locking:** All `/api/studio/*` mutations and `/test` routes require a privileged admin session, valid CSRF header/token, and matching `revision`.
