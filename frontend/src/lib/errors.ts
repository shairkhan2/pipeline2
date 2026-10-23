import { isApiError } from "@/lib/api";

/**
 * One way to explain a failure everywhere in the UI: what happened (title),
 * the server's own words (detail), and what to do next (hint).
 */
export type ErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "too-large"
  | "invalid"
  | "rate-limit"
  | "server"
  | "unknown";

export interface ErrorInfo {
  kind: ErrorKind;
  title: string;
  detail: string;
  hint: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
  retryable: boolean;
}

const BY_KIND: Record<ErrorKind, { title: string; hint: string; retryable: boolean }> = {
  network: { title: "Can’t reach server", hint: "Check your connection.", retryable: true },
  timeout: { title: "Timed out", hint: "The server may be busy.", retryable: true },
  auth: { title: "Signed out", hint: "Sign in again.", retryable: false },
  forbidden: { title: "Not allowed", hint: "Needs an admin account. Reload if the page was open long.", retryable: false },
  "not-found": { title: "Not found", hint: "It may have been moved or deleted.", retryable: false },
  conflict: { title: "Changed elsewhere", hint: "Reload, then make your change again.", retryable: false },
  "too-large": { title: "Too large", hint: "Use a smaller file.", retryable: false },
  invalid: { title: "Check input", hint: "Fix the value and try again.", retryable: false },
  "rate-limit": { title: "Rate limited", hint: "Wait a minute.", retryable: true },
  server: { title: "Server error", hint: "Check the server log for the request ID.", retryable: true },
  unknown: { title: "Something went wrong", hint: "", retryable: true },
};

function kindFromStatus(status: number): ErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not-found";
  if (status === 409) return "conflict";
  if (status === 413) return "too-large";
  if (status === 429) return "rate-limit";
  if (status === 400 || status === 422) return "invalid";
  if (status >= 500) return "server";
  return "unknown";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Server messages that are not useful to show as-is. */
const GENERIC = new Set(["server error", "bad request", "request failed", "forbidden", "not found", "auth required"]);

export function describeError(error: unknown, fallback = "Request failed"): ErrorInfo {
  if (isApiError(error)) {
    const payload = (error.payload && typeof error.payload === "object" ? error.payload : {}) as Record<string, unknown>;
    let kind = kindFromStatus(error.status);
    if (error.status === 0 && /timed out|cancel/i.test(error.message)) kind = "timeout";
    const base = BY_KIND[kind];
    const raw = str(payload.error) ?? str(error.message) ?? fallback;
    // Status 0 messages are written by the client and repeat the title.
    const detail = error.status === 0 || GENERIC.has(raw.toLowerCase()) ? "" : raw;
    return {
      kind,
      title: base.title,
      detail,
      hint: str(payload.hint) ?? base.hint,
      status: error.status || null,
      code: error.code ?? str(payload.code),
      requestId: str(payload.requestId),
      retryable: base.retryable,
    };
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { kind: "timeout", ...BY_KIND.timeout, detail: "", status: null, code: null, requestId: null };
  }
  return {
    kind: "unknown",
    title: BY_KIND.unknown.title,
    detail: message || fallback,
    hint: BY_KIND.unknown.hint,
    status: null,
    code: null,
    requestId: null,
    retryable: true,
  };
}

/** One readable line for places that can only show text (notices, toasts, inline errors). */
export function errorLine(error: unknown, fallback = "Request failed"): string {
  const info = describeError(error, fallback);
  if (info.kind === "unknown") return info.detail || info.title;
  return info.detail && info.detail.length <= 80 ? `${info.title}: ${info.detail}` : info.title;
}

/* ------------------------------------------------------------------------ */
/* Pipeline failure notes: "HTTP 403 · request illegal · access denied …"    */
/* ------------------------------------------------------------------------ */

export type FailureTone = "danger" | "warning" | "info";

export interface FailureNote {
  /** One word for the status dot: "Denied", "Limited", "Empty", "Blocked", "Timeout", "Failed". */
  label: string;
  /** Plain title, 4 words at most. */
  title: string;
  /** What happens next, a few words ("Retrying", "Lane paused 30 min"). */
  action: string;
  /** Full original note, shown only under Details. */
  raw: string;
  tone: FailureTone;
}

const HTTP_TITLES: Record<number, [string, string]> = {
  400: ["Rejected", "Request rejected"],
  401: ["Signed out", "Key rejected"],
  403: ["Denied", "Access denied"],
  404: ["Not found", "Model not found"],
  408: ["Timeout", "Provider timed out"],
  413: ["Too large", "Request too large"],
  422: ["Blocked", "Content blocked"],
  429: ["Limited", "Rate limited"],
  500: ["Error", "Provider error"],
  502: ["Offline", "Provider unreachable"],
  503: ["Busy", "Provider overloaded"],
  504: ["Timeout", "Provider timed out"],
};

/** Short next step from client.ts hints ("rate limited - backing off, retrying same lane"). */
function shortAction(hint: string): string {
  const h = hint.toLowerCase();
  const parked = /parked (\d+ ?\w+)/.exec(h);
  if (parked) return `Lane paused ${parked[1]}`;
  if (h.includes("bigger cap")) return "Retrying with more tokens";
  if (h.includes("next lane")) return "Trying next model";
  if (h.includes("retrying") || h.includes("backing off")) return "Retrying";
  if (h.includes("reconnect")) return "Reconnect in Settings";
  if (h.includes("check model")) return "Check model settings";
  return "";
}

/**
 * Turn a telemetry note from src/llm/client.ts (httpErrorNote / emptyNote,
 * separator " · ") into a short title, a short next step and the raw text.
 */
export function parseFailureNote(note: string | null | undefined): FailureNote {
  const raw = String(note ?? "").trim();
  const parts = raw.split(" · ").map((p) => p.trim()).filter(Boolean);
  const known: Array<[RegExp, string, string, FailureTone]> = [
    [/policy refusal|refused · safety|blocked · moderation/i, "Blocked", "Blocked by safety filter", "danger"],
    [/invalid audio/i, "Invalid", "Invalid audio", "danger"],
    [/all models failed/i, "Failed", "All models failed", "danger"],
    [/connection failed|ECONN|fetch failed/i, "Offline", "Connection failed", "warning"],
    [/disk full|ENOSPC/i, "Full", "Disk full", "danger"],
    [/out of memory|ENOMEM/i, "Failed", "Out of memory", "danger"],
    [/unparseable reply/i, "Unreadable", "Unparseable reply", "danger"],
  ];
  for (const [pattern, label, title, tone] of known) {
    if (pattern.test(raw)) return { label, title, tone, raw, action: shortAction(raw) };
  }
  const http = /^HTTP (\d{3})$/.exec(parts[0] ?? "");
  if (http) {
    const status = Number(http[1]);
    const [label, title] = HTTP_TITLES[status] ?? (status >= 500 ? ["Error", "Provider error"] : ["Failed", "Request failed"]);
    return {
      label,
      title,
      action: shortAction(parts[parts.length - 1] ?? "") || (status === 429 || status >= 500 ? "Retrying" : ""),
      raw,
      tone: status === 429 || status >= 500 ? "warning" : "danger",
    };
  }
  if (/^Empty response/i.test(parts[0] ?? "")) {
    const blocked = parts.some((p) => /^blocked/i.test(p));
    return {
      label: blocked ? "Blocked" : "Empty",
      title: blocked ? "Reply blocked" : "Empty reply",
      action: shortAction(parts[parts.length - 1] ?? "") || "Retrying",
      raw,
      tone: blocked ? "danger" : "warning",
    };
  }
  if (/all (?:lanes|models) busy/i.test(raw)) {
    const wait = /retrying in (\d+s)/i.exec(raw);
    return { label: "Waiting", title: "All models busy", action: wait ? `Retry in ${wait[1]}` : "Waiting", raw, tone: "warning" };
  }
  if (/rate limit|\b429\b/i.test(raw)) return { label: "Limited", title: "Rate limited", action: "Retrying", raw, tone: "warning" };
  if (/AllLanesFailed|all lanes failed/i.test(raw)) {
    return { label: "Failed", title: "All models failed", action: "", raw, tone: "danger" };
  }
  if (/prohibited use|sensitive words|could not be submitted|content.?filter|safety/i.test(raw)) {
    return { label: "Blocked", title: "Blocked by safety filter", action: "", raw, tone: "danger" };
  }
  if (/unparseable|invalid json|parse/i.test(raw)) {
    return { label: "Unreadable", title: "Unreadable reply", action: "", raw, tone: "danger" };
  }
  if (/AbortError|TimeoutError|timed out/i.test(raw)) {
    return { label: "Timeout", title: "Timed out", action: "Retrying", raw, tone: "warning" };
  }
  return { label: "Failed", title: "Failed", action: "", raw, tone: "danger" };
}

/* ------------------------------------------------------------------------ */
/* Job failures: "summary: 0 ok | FAILED: ch2", "TimeoutError: …"           */
/* ------------------------------------------------------------------------ */

export interface JobFailure {
  title: string;
  /** Optional short reason, 8 words at most. */
  reason: string;
  raw: string;
}

/** Plain title for a failed intake job; the raw server text stays for Details. */
export function describeJobFailure(error: string | null | undefined, statusNote?: string | null): JobFailure {
  const raw = [error, statusNote].filter((x) => x && String(x).trim()).join("\n");
  const text = String(error ?? "");
  const chapters = [...text.matchAll(/FAILED:\s*([^|\n]+)/gi)]
    .flatMap((m) => m[1]!.split(/[\s,]+/))
    .map((c) => /ch?(\d+)/i.exec(c)?.[1])
    .filter((n): n is string => Boolean(n));
  if (chapters.length === 1) return { title: `Chapter ${chapters[0]} failed`, reason: "", raw };
  if (chapters.length > 1) return { title: `${chapters.length} chapters failed`, reason: `Chapters ${chapters.join(", ")}`, raw };
  if (/TimeoutError|timed out|aborted due to timeout/i.test(text)) return { title: "Download timed out", reason: "", raw };
  if (/drive|gdrive|quota exceeded|not shared|403/i.test(text)) return { title: "Download failed", reason: "Check the Drive link is public", raw };
  if (/zip|archive|extract/i.test(text)) return { title: "Couldn’t read the ZIP", reason: "", raw };
  if (/stopped|interrupted|cancel/i.test(text)) return { title: "Stopped", reason: "", raw };
  return { title: "Run failed", reason: "", raw };
}
