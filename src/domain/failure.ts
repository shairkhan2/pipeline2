/**
 * failure.ts - one place that decides whether a failure can heal by waiting.
 *
 *   transient  waiting helps: rate limits, timeouts, 5xx, dropped connections.
 *   permanent  waiting cannot help: auth, moderation or policy refusals, structural gates.
 *   unknown    neither is certain: the script lane retries it in place; the video
 *              lane leaves it to the job-level auto-retry.
 *
 * Shared by the script lane (cli/run.ts), the video lane (workers/renderlane.ts)
 * and intake, so every layer agrees on what "retry later" means.
 *
 * failureNote() builds the short, payload-free label telemetry shows for a failed
 * stage ("HTTP 429 · rate limited"). It never returns prompt or response text.
 */

export type FailClass = "permanent" | "transient" | "unknown";

/**
 * I-15 policy patterns for messages that carry no parseable HTTP status. Status
 * codes match as whole numbers only, so "14033 tokens" is not a 403.
 */
export const PERMANENT =
  /\b(?:401|403|422)\b|moderation|violence|data_inspection|continuity gate|0 narration lines|AuthError|voice_id is empty|unknown tts\.engine/i;
export const TRANSIENT =
  /\b(?:429|5\d\d)\b|timeout|timed out|connection|reset|refused|empty content|unparseable|missing after assembly|temporarily|overload/i;

/** Extra transient wording seen from providers and the network stack. */
const TRANSIENT_EXTRA =
  /resource exhausted|rate.?limit|too many requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|failed to fetch|network.?error|lane cooling|quota-exhausted/i;

/**
 * A provider's policy refusal delivered as ordinary text (often HTTP 200), plus the
 * lane-skip wording client.ts uses for it ("policy refusal: ...").
 */
export const REFUSAL =
  /Prohibited Use policy|prompt could not be submitted|prompt contains sensitive words|policy refusal/i;

const ALL_LANES = /all lanes failed:\s*/i;
const ELEVENLABS_POOL = /ElevenLabs key pool exhausted/i;

const STATUS_HINT: Record<number, string> = {
  400: "request rejected",
  401: "key rejected",
  402: "payment required",
  403: "access denied",
  404: "not found",
  408: "timed out",
  413: "too large",
  422: "blocked",
  429: "rate limited",
  500: "provider error",
  502: "provider unreachable",
  503: "provider overloaded",
  504: "timed out",
};

function errorName(e: unknown): string {
  if (e === null || e === undefined) return typeof e;
  if (typeof e === "object") {
    const named = (e as { name?: unknown }).name;
    if (typeof named === "string" && named && named !== "Error") return named;
    const ctor = (e as { constructor?: { name?: string } }).constructor?.name;
    if (ctor && ctor !== "Object") return ctor;
    if (typeof named === "string" && named) return named;
    return ctor ?? "Object";
  }
  return typeof e;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message || String(e)}`;
  return String(e);
}

/** First HTTP error status (400-599) named in a message, or null. */
export function httpStatusOf(text: string): number | null {
  const patterns = [/\bHTTP[ /]?(\d{3})\b/gi, /"code"\s*:\s*(\d{3})\b/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 400 && n <= 599) return n;
    }
  }
  return null;
}

/** HTTP statuses worth retrying after a wait. */
export function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function classOfStatus(status: number): FailClass {
  if (retryableHttpStatus(status)) return "transient";
  if (status === 401 || status === 403 || status === 422) return "permanent";
  return "unknown";
}

/** True when text is a provider policy refusal, not a real answer. */
export function isRefusalText(text: string): boolean {
  return REFUSAL.test(text);
}

function classifyText(s: string, name: string): FailClass {
  if (name === "FilterBlocked" || REFUSAL.test(s)) return "permanent";
  const status = httpStatusOf(s);
  if (status !== null) {
    const cls = classOfStatus(status);
    if (cls !== "unknown") return cls;
  }
  if (PERMANENT.test(s)) return "permanent";
  if (TRANSIENT.test(s) || TRANSIENT_EXTRA.test(s)) return "transient";
  return "unknown";
}

/**
 * Classify a failure. An AllLanesFailed message is judged lane by lane: one lane
 * that may come back (rate limit, cooling, outage) makes the whole call transient.
 */
export function failClass(e: unknown): FailClass {
  if (e !== null && typeof e === "object" && "permanent" in e && Boolean((e as { permanent?: unknown }).permanent)) {
    return "permanent"; // story/semantic gates must not trigger whole-draft rewrite loops
  }
  const name = errorName(e);
  const s = errorText(e);
  // The key pool already waited for a key; a wrapped copy must not requeue either.
  if (name === "ElevenLabsPoolExhaustedError" || ELEVENLABS_POOL.test(s)) return "permanent";
  // A 402 is billing (credits or plan), never cured by waiting minutes.
  if (/ElevenLabs HTTP 402\b/i.test(s)) return "permanent";
  const m = ALL_LANES.exec(s);
  if (m) {
    const parts = s.slice(m.index + m[0].length).split(" | ").map((p) => p.trim()).filter(Boolean);
    if (parts.length) {
      const classes = parts.map((p) => classifyText(p, ""));
      if (classes.includes("transient")) return "transient";
      if (classes.every((c) => c === "permanent")) return "permanent";
      return "unknown";
    }
  }
  return classifyText(s, name);
}

/**
 * Short label for a failed stage: "HTTP 429 · rate limited", "Timed out",
 * "Invalid audio", "Policy refusal · safety filter". Falls back to the error
 * class name. Never includes prompt, response or credential text.
 */
export function failureNote(e: unknown): string {
  const name = errorName(e);
  const s = errorText(e);
  if (name === "ElevenLabsPoolExhaustedError" || ELEVENLABS_POOL.test(s)) return "ElevenLabs keys exhausted";
  if (ALL_LANES.test(s)) {
    const cls = failClass(e);
    if (cls === "transient") return "All models busy";
    return REFUSAL.test(s) ? "Policy refusal · all models" : "All models failed";
  }
  if (name === "FilterBlocked" || REFUSAL.test(s)) return "Policy refusal · safety filter";
  if (/moderation|data_inspection|inappropriate content|content_policy/i.test(s)) return "Blocked · moderation";
  const status = httpStatusOf(s);
  if (status !== null) {
    return `HTTP ${status} · ${STATUS_HINT[status] ?? (status >= 500 ? "provider error" : "request failed")}`;
  }
  if (/resource exhausted|rate.?limit|too many requests/i.test(s)) return "HTTP 429 · rate limited";
  if (/TimeoutError|timed out|timeout/i.test(s)) return "Timed out";
  if (/unparseable|invalid json/i.test(s)) return "Unparseable reply";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|failed to fetch|network.?error|connection/i.test(s)) {
    return "Connection failed";
  }
  if (/invalid audio|produced no MP3|empty audio|missing inline audio/i.test(s)) return "Invalid audio";
  if (/ENOSPC|no space left/i.test(s)) return "Disk full";
  if (/ENOMEM|heap out of memory|out of memory/i.test(s)) return "Out of memory";
  return name || "Error";
}
