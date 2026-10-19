# Frontend/backend separation after the Python port

## Why this boundary comes next

The byte-compatible port preserved paid caches and pipeline behavior. It also preserved synchronous subprocesses, module globals, host-specific defaults, and repeated request-handling code. Those are architectural concerns, not reasons to change prompts, cache hashes, or narration rules during deployment work.

## Deployment boundaries

- **Frontend image:** Nginx plus the static application in `src/player/public`. No credentials, pipeline code, series files, or Node runtime. Nginx serves authenticated UI assets and proxies API, login, and media requests to the backend.
- **Backend image:** Node/TypeScript API, intake scheduler, pipeline stages, and Remotion studio. Owns authentication, authorization, CSRF validation, uploads, filesystem locks, durable jobs, and media range responses. `PLAYER_API_ONLY=1` disables its legacy static UI routes.
- **Same public origin:** browsers call relative `/api/*` URLs. Nginx forwards the original Host, Cookie, Origin, and CSRF headers. No browser-visible backend hostname or broad CORS policy is needed.
- **Durable storage:** series, jobs, status, lane configuration, thumbnails, and session signing secret live under `/data`. Credentials enter through a read-only mounted htpasswd file or runtime environment, never the image build context.
- **Worker lifecycle:** the existing durable intake queue continues to spawn child pipeline processes. Run one backend replica initially. API health does not claim that optional ML tools or providers are configured.

The frontend source stays at its existing path to preserve local development and asset references; image contents and runtime ownership are separate. The backend retains the login response because credential verification and cookie issuance belong to the backend.

## HTTP contract and error handling

1. Public `GET /healthz` reports process liveness without reading paid providers.
2. `GET /api/session` returns session identity and CSRF metadata, or 401. Nginx uses it for asset authorization.
3. API JSON responses use `Cache-Control: no-store`. The service worker never caches API/session responses.
4. The server assigns an `X-Request-ID`. Unexpected API errors return a safe JSON message and that identifier. Server logs retain the diagnostic error.
5. Malformed URLs and cookie encodings are handled at the request boundary. Invalid JSON and oversized bodies produce controlled 400/413 responses.
6. Media streaming handles file-open errors and disconnects. Already-started responses are closed instead of receiving a second header block.
7. Browser API transport centralizes credentials, deadlines, session-expiry redirects, and non-JSON gateway errors. Mutations are not automatically retried: a timeout does not prove the server rejected the operation.
8. ZIP uploads retain XHR progress reporting with a twelve-minute client deadline. The backend's ten-minute upload deadline runs before Node's request deadline, and invalid gateway responses cannot count as upload success.

Existing endpoint-specific payloads and status codes remain compatible. Future endpoint changes should define Zod request/response contracts and stable error codes rather than relying on error-message matching.

## Further modernization, in order

### Keep blocking work outside the API event loop

`src/workers/renderlane.ts` still uses `spawnSync` for rendering. Calling that work from an async function does not make it asynchronous. Likewise, filesystem scans and flock subprocesses remain synchronous in control-plane code. Keep pipeline execution in child processes now; migrate long-lived render subprocesses to `spawn` with deadlines, cancellation, and bounded output next. Add an API latency test while a render is running.

### Separate scheduler ownership from reads

`listJobs` and `getJob` currently reconcile and wake workers. Introduce an explicit scheduler process with startup recovery and durable queue ownership before horizontally scaling the API. GET endpoints should eventually become read-only projections. A dedicated worker service will also simplify graceful shutdown and cancellation.

### Replace implicit state with run context

Pass chapter identity, continuity window, budget, cancellation signal, and telemetry context explicitly. Remove dependencies on `LAST_WINDOW`, mutable test hooks, and process-wide state one boundary at a time. Preserve golden parity tests around compatibility serializers.

### Improve browser data flow

Use typed request/response contracts, stop polling when pages are hidden, prevent overlapping refreshes, and display last-success timestamps. Add request idempotency for job submission before introducing automatic mutation retries. Consider SSE for job/status updates only after durable job events and reconnect semantics are defined.

### Separate capabilities from liveness

Keep liveness cheap. Expose authenticated capability/preflight results for ffmpeg, TTS, cleaner, local renderer, and remote workers. Missing optional tools should disable the affected action with a clear reason, not masquerade as a failed API deployment.

See `improvements.md` for the broader reliability review and `docs/deployment.md` for image setup and operational limits.
