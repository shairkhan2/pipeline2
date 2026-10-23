/**
 * Render node registry: dynamic replacement for the hardcoded `local | laptop |
 * cloud` singleton assumption.
 *
 * Nodes come from two places:
 *   - built-ins: `local` always, plus legacy `laptop` / `cloud` when their env
 *     transports are configured (or when a legacy test asks for them);
 *   - `<outDir>/config/render-nodes.json`: operator-registered `local`,
 *     `docker-sbx`, and `ssh` nodes.
 *
 * The registry never touches the cloudlane/lappy module singletons: a custom
 * node owns its own state, breaker, and slots. It holds no credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getSecret, scrubSecrets } from "../config/secretStore.js";
import * as cloudlane from "./cloudlane.js";
import * as lappy from "./lappy.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

export const NODES_FILE = "render-nodes.json";
export const NODES_DIR = "config";

export const BUILTIN_NODE_IDS = ["local", "laptop", "cloud"] as const;

export type RenderNodeKind = "local" | "docker-sbx" | "ssh";

export interface RenderNodeRecord {
  id: string;
  /** Secret-store reference for an uploaded SSH private key. */
  secretRef?: string;
  label?: string;
  kind: RenderNodeKind;
  enabled?: boolean;
  /** docker-sbx */
  box?: string;
  template?: string;
  /** ssh */
  host?: string;
  user?: string;
  port?: number;
  remoteDir?: string;
  identityFile?: string;
  supportsCleaner?: boolean;
  maxLoadFactor?: number;
  /** shared */
  slots?: number;
  maxHours?: number;
  idlePauseS?: number;
  minMemGb?: number;
  minDiskGb?: number;
  [key: string]: unknown;
}

export interface RenderNodeInstance {
  id: string;
  kind: RenderNodeKind;
  record: RenderNodeRecord;
  slots: number;
  healthy(force?: boolean): [boolean, string];
  render(propsPath: string, outVideo: string, log?: (msg: string) => void): Promise<void>;
  status(): { ok: boolean; status: string; reason: string };
  start?(): { ok: boolean; detail: string };
  stop?(): { ok: boolean; detail: string };
  create?(): { ok: boolean; detail: string };
}

const NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function stripTrailingConfigDir(value: string): string {
  const resolved = path.resolve(value);
  return path.basename(resolved) === "config" ? path.dirname(resolved) : resolved;
}

export function resolveOutDir(outDir?: string): string {
  if (outDir) return path.resolve(outDir);
  const env = process.env.MANHWA_OUT_DIR || process.env.PIPELINE_OUT_DIR;
  if (env) return path.resolve(env);
  const laneCfgDir = String(process.env.MANHWA_LANE_CONFIG_DIR ?? "").trim();
  if (laneCfgDir) return stripTrailingConfigDir(laneCfgDir);
  const laneCfg = String(process.env.MANHWA_LANE_CONFIG ?? "").trim();
  if (laneCfg) return stripTrailingConfigDir(path.dirname(path.resolve(laneCfg)));
  const jobsDir = String(process.env.MANHWA_JOBS_DIR ?? "").trim();
  if (jobsDir) return path.dirname(path.resolve(jobsDir));
  if (String(process.env.VITEST ?? "").trim()) {
    return path.join(REPO_ROOT, "out", ".vitest-empty");
  }
  return path.join(REPO_ROOT, "out");
}

export function nodesFilePath(outDir?: string): string {
  return path.join(resolveOutDir(outDir), NODES_DIR, NODES_FILE);
}

function envOn(key: string): boolean {
  return Boolean(String(process.env[key] ?? "").trim());
}

function legacyBuiltins(): RenderNodeRecord[] {
  const out: RenderNodeRecord[] = [
    { id: "local", label: "Local Host", kind: "local", enabled: true, slots: 1, supportsCleaner: true },
  ];
  if (envOn("MANHWA_RENDER_REMOTE")) {
    out.push({
      id: "laptop",
      label: "Remote Laptop",
      kind: "ssh",
      enabled: true,
      host: String(process.env.MANHWA_RENDER_REMOTE ?? "").trim(),
      remoteDir: String(process.env.MANHWA_RENDER_REMOTE_DIR ?? "render-worker"),
      slots: lappy.MAX_RENDER_SLOTS,
      supportsCleaner: true,
    });
  }
  if (envOn("MANHWA_RENDER_CLOUD")) {
    out.push({
      id: "cloud",
      label: "Docker Cloud Sandbox",
      kind: "docker-sbx",
      enabled: true,
      box: String(process.env.MANHWA_RENDER_CLOUD ?? "").trim(),
      slots: cloudlane.MAX_RENDER_SLOTS,
      supportsCleaner: false,
    });
  }
  return out;
}

function readNodeFile(outDir?: string): RenderNodeRecord[] {
  const file = nodesFilePath(outDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown }).nodes)
      ? ((parsed as { nodes: unknown[] }).nodes)
      : [];
  const out: RenderNodeRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as RenderNodeRecord;
    const id = String(rec.id ?? "").trim();
    if (!id || !NODE_ID_RE.test(id)) continue;
    const kind = String(rec.kind ?? "").trim() as RenderNodeKind;
    if (kind !== "local" && kind !== "docker-sbx" && kind !== "ssh") continue;
    out.push({ ...rec, id, kind });
  }
  return out;
}

/** Every registered node: file entries first, then built-ins not overridden. */
export function getRegisteredNodes(outDir?: string): RenderNodeRecord[] {
  const merged = new Map<string, RenderNodeRecord>();
  for (const rec of readNodeFile(outDir)) {
    merged.set(rec.id, rec);
  }
  for (const rec of legacyBuiltins()) {
    if (!merged.has(rec.id)) merged.set(rec.id, rec);
  }
  return [...merged.values()];
}

const instances = new Map<string, RenderNodeInstance>();

function localInstance(rec: RenderNodeRecord): RenderNodeInstance {
  return {
    id: rec.id,
    kind: "local",
    record: rec,
    slots: Math.max(1, Math.trunc(Number(rec.slots ?? 1)) || 1),
    healthy: () => [true, "local"],
    async render(): Promise<void> {
      // Local renders are dispatched by renderlane.renderLocal; a registry-only
      // call has no composition root to run, so it reports the contract gap.
      throw new cloudlane.RuntimeError(
        "local node renders through renderlane.renderLocal, not nodeRegistry",
      );
    },
    status: () => ({ ok: true, status: "available", reason: "local" }),
  };
}

function cloudInstance(rec: RenderNodeRecord): RenderNodeInstance {
  const node = cloudlane.createCloudNode({
    id: rec.id,
    box: String(rec.box ?? rec.id),
    template: rec.template === undefined ? undefined : String(rec.template),
    slots: rec.slots,
    maxHours: rec.maxHours,
    idlePauseS: rec.idlePauseS,
    minMemGb: rec.minMemGb,
    minDiskGb: rec.minDiskGb,
    remoteDir: rec.remoteDir,
  });
  return {
    id: rec.id,
    kind: "docker-sbx",
    record: rec,
    slots: Math.max(1, Math.trunc(Number(rec.slots ?? 1)) || 1),
    healthy: (force) => node.healthy(force),
    render: (propsPath, outVideo, log) => node.render(propsPath, outVideo, log),
    status: () => node.status(),
    start: () => node.start(),
    stop: () => node.stop(),
    create: () => node.create(),
  };
}

/** `<outDir>/config/ssh-keys/<node id>.key`: 0o600 private key materialized for ssh. */
export function nodeKeyPath(id: string, outDir?: string): string {
  return path.join(resolveOutDir(outDir), "config", "ssh-keys", `${id}.key`);
}

/**
 * Materialize the uploaded node key (`render-node:<id>` in the secret store)
 * to a 0o600 file and return its path. Returns null when no key was uploaded.
 */
export function materializeNodeKey(rec: RenderNodeRecord, outDir?: string): string | null {
  const ref = typeof rec.secretRef === "string" && rec.secretRef.trim()
    ? rec.secretRef.trim()
    : `render-node:${rec.id}`;
  const secret = getSecret(ref, resolveOutDir(outDir));
  if (!secret) return null;
  const target = nodeKeyPath(rec.id, outDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let current: string | null = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  if (current !== secret) {
    fs.writeFileSync(target, secret, { mode: 0o600 });
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best effort
  }
  return target;
}

/** Configured key file, else the materialized upload, else nothing. */
function resolveIdentityFile(rec: RenderNodeRecord, outDir?: string): string | null {
  if (typeof rec.identityFile === "string" && rec.identityFile.trim()) {
    return rec.identityFile.trim();
  }
  return materializeNodeKey(rec, outDir);
}

/**
 * `remoteDir` as used on the remote host. Absolute and `~`-rooted paths are
 * honoured as written; a bare relative path stays relative to `$HOME`.
 */
function remoteDirArg(rec: RenderNodeRecord): string {
  const raw = rec.remoteDir === undefined || rec.remoteDir === null ? "" : String(rec.remoteDir).trim();
  if (!raw) return "render-worker";
  if (raw.startsWith("/") || raw.startsWith("~")) return raw;
  return `~/${raw}`;
}

function sshInstance(rec: RenderNodeRecord, outDir?: string): RenderNodeInstance {
  const rdir = remoteDirArg(rec);
  const node = lappy.createSshNode({
    id: rec.id,
    host: String(rec.host ?? ""),
    user: rec.user === undefined ? undefined : String(rec.user),
    port: rec.port,
    remoteDir: rec.remoteDir === undefined ? undefined : String(rec.remoteDir),
    identityFile: resolveIdentityFile(rec, outDir) ?? undefined,
    slots: rec.slots,
    supportsCleaner: rec.supportsCleaner,
    maxLoadFactor: rec.maxLoadFactor,
    minMemGb: rec.minMemGb,
    minDiskGb: rec.minDiskGb,
  });
  return {
    id: rec.id,
    kind: "ssh",
    record: rec,
    slots: Math.max(1, Math.trunc(Number(rec.slots ?? 1)) || 1),
    healthy: (force) => node.healthy(force, true),
    async render(propsPath, outVideo, log): Promise<void> {
      const write = log ?? (() => {});
      const studio = process.env.MANHWA_STUDIO || path.join(REPO_ROOT, "remotion-studio");
      const parsed = JSON.parse(fs.readFileSync(propsPath, "utf8")) as { audio?: string; quality?: string };
      const proj = String(parsed.audio ?? "").split("/")[0] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(proj)) {
        throw new lappy.RuntimeError("invalid chapter asset directory");
      }
      // The Recap composition is 1280x720; 1080p is an exact 1.5x upscale.
      const scale = parsed.quality === "1080p" ? " --scale=1.5" : "";
      const rstudio = `${rdir}/studio`;
      const job = `${rdir}/jobs/${proj}`;
      await node.acquire();
      try {
        node.exec(`mkdir -p ${rstudio}/public ${job}`, null, 60);
        node.push(
          studio.replace(/\/+$/, "") + "/",
          `${rstudio}/`,
          null,
          true,
          ["node_modules", "public"],
        );
        node.push(path.join(studio, "public", proj) + "/", `${rstudio}/public/${proj}/`, null, true);
        node.push(propsPath, `${job}/shots.json`, null);
        write(`[ssh ${node.id}] ${proj}`);
        node.exec(
          `cd ${rstudio} && npx remotion render src/index.ts Recap ` +
            `../jobs/${proj}/video.mp4 --props=../jobs/${proj}/shots.json --log=info${scale}`,
          null,
          3600,
        );
        const tmp = `${outVideo}.part`;
        fs.mkdirSync(path.dirname(outVideo), { recursive: true });
        node.pull(`${job}/video.mp4`, tmp, null);
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
          throw new lappy.RuntimeError(
            `ssh node ${node.id} pulled an empty or missing video for ${proj}`,
          );
        }
        fs.renameSync(tmp, outVideo);
      } finally {
        try {
          const tmp = `${outVideo}.part`;
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // a lingering .part must never mask the render result
        }
        try {
          node.exec(`rm -rf ${job} ${rstudio}/public/${proj}`, null, 60);
        } catch {
          // cleanup must never mask a completed render
        }
        node.release();
      }
    },
    status: () => {
      const s = node.status();
      return { ok: s.ok, status: s.status, reason: s.reason };
    },
  };
}

/** Build (or reuse) the live instance for a record. */
export function registerNodeForRuntime(cfg: RenderNodeRecord, outDir?: string): RenderNodeInstance {
  const id = String(cfg.id ?? "").trim();
  if (!id || !NODE_ID_RE.test(id)) {
    throw new cloudlane.ValueError(`invalid render node id ${JSON.stringify(cfg.id)}`);
  }
  const kind = cfg.kind;
  if (kind !== "local" && kind !== "docker-sbx" && kind !== "ssh") {
    throw new cloudlane.ValueError(`unknown render node kind ${JSON.stringify(kind)}`);
  }
  let instance: RenderNodeInstance;
  if (kind === "local") instance = localInstance({ ...cfg, id });
  else if (kind === "docker-sbx") instance = cloudInstance({ ...cfg, id });
  else instance = sshInstance({ ...cfg, id }, outDir);
  instances.set(instanceKey(id, outDir), instance);
  return instance;
}

/** Cache key: one live instance per (out dir, node id) pair. */
function instanceKey(id: string, outDir?: string): string {
  return `${resolveOutDir(outDir)}:${String(id).trim()}`;
}

/** Drop every cached instance for an id, across out dirs (used after config delete). */
export function removeNodeFromRuntime(id: string): boolean {
  const suffix = `:${String(id).trim()}`;
  let removed = false;
  for (const key of [...instances.keys()]) {
    if (key.endsWith(suffix)) {
      instances.delete(key);
      removed = true;
    }
  }
  return removed;
}

/** Drop the cached instance for one id in one out dir (after provision/control). */
function forgetNodeInstance(id: string, outDir?: string): void {
  instances.delete(instanceKey(id, outDir));
}

/** Live instance for an id, from the runtime cache or the persisted records. */
export function getNodeInstance(id: string, outDir?: string): RenderNodeInstance | null {
  const key = String(id ?? "").trim();
  if (!key) return null;
  const cached = instances.get(instanceKey(key, outDir));
  if (cached) return cached;
  const records = getRegisteredNodes(outDir);
  const rec =
    records.find((node) => node.id === key) ??
    records.find((node) => node.id.toLowerCase() === key.toLowerCase());
  if (!rec) return null;
  return registerNodeForRuntime(rec, outDir);
}

/** Probe one node. Never mutates the module singletons. */
export function testNodeConnection(
  id: string,
  outDir?: string,
): { ok: boolean; reason: string; kind: string } {
  const instance = getNodeInstance(id, outDir);
  if (!instance) {
    return { ok: false, reason: `unknown render node ${JSON.stringify(id)}`, kind: "unknown" };
  }
  const [ok, reason] = instance.healthy(true);
  return { ok, reason, kind: instance.kind };
}

export function runNodeAction(
  id: string,
  action: "start" | "stop" | "create" | "status" | "provision" | "bootstrap" | "auth-status" | "auth-start",
  opts?: { allowControl?: boolean; outDir?: string },
): { ok: boolean; detail: string; status?: string; probe?: Record<string, unknown> } {
  const instance = getNodeInstance(id, opts?.outDir);
  if (!instance) {
    return { ok: false, detail: `unknown render node ${JSON.stringify(id)}` };
  }
  if (action === "status") {
    let s = instance.status();
    if (s.status === "unknown" || s.reason === "not probed") {
      instance.healthy(true);
      s = instance.status();
    }
    return { ok: s.ok, detail: s.reason, status: s.status };
  }
  if (action === "provision" || action === "bootstrap") {
    try {
      return provisionNode(instance, opts?.outDir);
    } finally {
      forgetNodeInstance(id, opts?.outDir);
    }
  }
  if (action === "auth-status" || action === "auth-start") {
    return sandboxAuthAction(action, opts?.outDir);
  }
  const allow =
    opts?.allowControl === true || process.env.MANHWA_ALLOW_SANDBOX_CONTROL === "1";
  if (instance.kind !== "docker-sbx") {
    return {
      ok: false,
      detail: `render node ${instance.id} (${instance.kind}) has no ${action} control`,
    };
  }
  if (!allow) {
    return {
      ok: false,
      detail: `sandbox control disabled (set MANHWA_ALLOW_SANDBOX_CONTROL=1 to allow ${action})`,
    };
  }
  const rec = instance.record;
  const node = cloudlane.createCloudNode(
    {
      id: instance.id,
      box: String(rec.box ?? instance.id),
      template: rec.template === undefined ? undefined : String(rec.template),
      slots: rec.slots,
      maxHours: rec.maxHours,
      idlePauseS: rec.idlePauseS,
      minMemGb: rec.minMemGb,
      minDiskGb: rec.minDiskGb,
      remoteDir: rec.remoteDir,
    },
    undefined,
    { allowControl: true },
  );
  try {
    if (action === "start") {
      const r = node.start();
      return { ok: r.ok, detail: r.detail };
    }
    if (action === "stop") {
      const r = node.stop();
      return { ok: r.ok, detail: r.detail };
    }
    const r = node.create();
    return { ok: r.ok, detail: r.detail };
  } finally {
    // status()/healthy() must not read the pre-control cached state.
    forgetNodeInstance(id, opts?.outDir);
  }
}

/** Test-only: forget every live instance. */
export function _resetNodeRegistryForTests(): void {
  instances.clear();
  activeLoginSession = null;
}

/* ------------------------------------------------------------------ *
 * Fresh-account provisioning & sandbox CLI auth
 * ------------------------------------------------------------------ */

/** ANSI escape sequences (CSI, OSC and two-byte) that a TTY wraps around text. */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])/g;

/** Strip terminal control codes so URLs and codes match plain text. */
function stripTerminalEscapes(text: string): string {
  return String(text ?? "").replace(ANSI_ESCAPE_RE, "").replace(/\r/g, "");
}

/** Hosts that are documentation, never a live sign-in page. */
const SBX_DOC_HOSTS = /(^|\.)(docs?\.)?sbx\.dev$|(^|\.)docs\.docker\.com$/i;
/** Paths on Docker hosts that are legal/help pages rather than sign-in. */
const SBX_NON_LOGIN_PATH = /\/legal\/|\/terms\/|\/privacy\//i;

/**
 * Drop trailing `)`, `]` or `}` only while unbalanced, and a trailing unmatched
 * opener (`(`, `[`, `{`) that never closes inside the URL.
 */
function trimUnbalancedBracket(candidate: string): string {
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  let out = candidate;
  for (;;) {
    const last = out.slice(-1);
    const closePair = pairs.find(([, close]) => close === last);
    if (closePair) {
      const [open, close] = closePair;
      const opens = out.split(open).length - 1;
      const closes = out.split(close).length - 1;
      if (closes <= opens) return out;
      out = out.slice(0, -1);
      continue;
    }
    const openPair = pairs.find(([open]) => open === last);
    if (!openPair) return out;
    const [open, close] = openPair;
    const opens = out.split(open).length - 1;
    const closes = out.split(close).length - 1;
    // A trailing opener with no closer is sentence noise, not a URL character.
    if (opens <= closes) return out;
    out = out.slice(0, -1);
  }
}

/**
 * Validate one candidate URL: http(s) only, no documentation or legal page, no
 * trailing terminal punctuation, and nothing that is really a shell command.
 */
function normalizeLoginUrl(raw: string): string | null {
  let candidate = stripTerminalEscapes(raw).trim();
  if (!candidate) return null;
  // Sentence punctuation after a URL is never part of it. Brackets are handled
  // separately so a balanced one inside a query value survives.
  candidate = candidate.replace(/[>"',;:.]+$/g, "");
  candidate = trimUnbalancedBracket(candidate);
  if (!/^https?:\/\//i.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname.includes(".")) return null;
  if (SBX_DOC_HOSTS.test(parsed.hostname) && !/\/device|\/activate/i.test(parsed.pathname)) {
    return null;
  }
  if (SBX_NON_LOGIN_PATH.test(parsed.pathname)) return null;
  return parsed.toString();
}

/** True when the URL is a real device/verification link rather than a homepage. */
function isLoginCandidate(url: string): boolean {
  return /device|activate|login|signin|sign-in|auth|[?&](?:user_)?code=/i.test(url);
}

export function parseSbxLoginOutput(text: string): {
  verificationUrl: string | null;
  userCode: string | null;
} {
  const clean = stripTerminalEscapes(text);
  const codeMatch =
    /confirmation code is:?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(clean) ??
    /(?:enter|use)\s+(?:the\s+)?code:?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(clean) ??
    /[?&](?:user_)?code=([A-Za-z0-9_-]{4,})/i.exec(clean);
  const userCode = codeMatch ? codeMatch[1]! : null;

  // The CLI labels its sign-in link; prefer that over any other URL in the log.
  const labelled = /(?:Open this URL to sign in|sign in (?:at|using|with)|verification URL|visit)\s*:?\s*(https?:\/\/[^\s"'<>]+)/i.exec(clean);
  const labelledUrl = labelled ? normalizeLoginUrl(labelled[1]!) : null;
  if (labelledUrl && isLoginCandidate(labelledUrl)) {
    return { verificationUrl: labelledUrl, userCode };
  }

  const candidates: string[] = [];
  for (const match of clean.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const normalized = normalizeLoginUrl(match[0]);
    if (normalized) candidates.push(normalized);
  }
  const verificationUrl =
    candidates.find((url) => isLoginCandidate(url)) ?? null;
  return { verificationUrl, userCode };
}

/**
 * Human-readable next step for a login attempt. Never invents a link: when the
 * CLI printed none, the user is told to run it in a terminal.
 */
function sbxLoginInstructions(
  parsed: { verificationUrl: string | null; userCode: string | null },
  started: boolean,
): string {
  if (!started) {
    return "Could not start `sbx login`. Install the sbx CLI and run `sbx login` in a terminal, then retry.";
  }
  if (!parsed.verificationUrl) {
    return "`sbx login` started but printed no sign-in link. Run `sbx login` in a terminal to finish the browser flow, then retry.";
  }
  if (parsed.userCode) {
    return `Open ${parsed.verificationUrl} and enter code ${parsed.userCode} to finish \`sbx login\` in your browser.`;
  }
  return `Open ${parsed.verificationUrl} to finish \`sbx login\` in your browser.`;
}

let activeLoginSession: { pid: number; logFile: string; startedAt: number } | null = null;

export interface SandboxBoxInfo {
  name: string;
  id: string;
  status: string;
  cpus?: number;
  memoryMib?: number;
}

/** Parse `sbx --cloud ls --json` best-effort. Never throws. */
export function parseSandboxListing(stdout: string): SandboxBoxInfo[] {
  try {
    const parsed = JSON.parse(stdout) as { sandboxes?: Array<Record<string, unknown>> };
    const list = Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : [];
    return list
      .map((item) => {
        const name = String(item.name ?? item.id ?? "").trim();
        if (!name) return null;
        const cpusRaw = item.cpus ?? item.cpu ?? item.vcpus;
        const memRaw = item.memoryMib ?? item.memory_mib ?? item.mem_mib;
        const cpus = Number(cpusRaw);
        const memoryMib = Number(memRaw);
        const out: SandboxBoxInfo = {
          name,
          id: String(item.id ?? name),
          status: String(item.status ?? "unknown"),
        };
        if (Number.isFinite(cpus)) out.cpus = cpus;
        if (Number.isFinite(memoryMib)) out.memoryMib = memoryMib;
        return out;
      })
      .filter((item): item is SandboxBoxInfo => item !== null);
  } catch {
    return [];
  }
}

/** Ensure `sbx` CLI is installed on the host, auto-downloading on real runtime if missing. */
export function ensureSbxCliInstalled(): {
  installed: boolean;
  binPath: string;
  detail: string;
} {
  if (localRunnerIsCustom) {
    const probe = runLocal(["sh", "-c", "command -v sbx"], 15);
    const binPath = probe.status === 0 ? probe.stdout.trim() : "";
    return {
      installed: binPath.length > 0,
      binPath,
      detail: binPath || "sbx CLI not installed; install it and retry (https://docs.sbx.dev)",
    };
  }
  const localBinDir = path.join(os.homedir(), ".local", "bin");
  const pathParts = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const extra of ["/usr/local/bin", localBinDir]) {
    if (!pathParts.includes(extra)) {
      pathParts.unshift(extra);
    }
  }
  process.env.PATH = pathParts.join(path.delimiter);

  const probe = runLocal(
    ["sh", "-c", 'PATH="$HOME/.local/bin:/usr/local/bin:$PATH" command -v sbx'],
    15,
  );
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    const binPath = probe.stdout.trim();
    return { installed: true, binPath, detail: `sbx CLI installed (${binPath})` };
  }

  const archive =
    process.platform === "darwin"
      ? "DockerSandboxes-darwin.tar.gz"
      : `DockerSandboxes-linux-${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  const url = `https://github.com/docker/sbx-releases/releases/latest/download/${archive}`;
  const installScript = [
    "set -e",
    'TMP_DIR="$(mktemp -d)"',
    'trap \'rm -rf "$TMP_DIR"\' EXIT',
    `curl -fsSL "${url}" | tar -xz -C "$TMP_DIR" --strip-components=1 docker-sbx/sbx`,
    'chmod 0755 "$TMP_DIR/sbx"',
    'if [ -w /usr/local/bin ]; then mv "$TMP_DIR/sbx" /usr/local/bin/sbx && echo /usr/local/bin/sbx;',
    'elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n mv "$TMP_DIR/sbx" /usr/local/bin/sbx && sudo -n chmod 0755 /usr/local/bin/sbx && echo /usr/local/bin/sbx;',
    `else mkdir -p "${localBinDir}" && mv "$TMP_DIR/sbx" "${localBinDir}/sbx" && echo "${localBinDir}/sbx"; fi`,
  ].join("\n");
  const installRes = runLocal(["sh", "-c", installScript], 120);
  if (installRes.status === 0) {
    const verify = runLocal(
      ["sh", "-c", 'PATH="$HOME/.local/bin:/usr/local/bin:$PATH" command -v sbx'],
      15,
    );
    const binPath = (verify.stdout || installRes.stdout).trim().split("\n").pop()?.trim() ?? "";
    if (binPath) {
      return { installed: true, binPath, detail: `sbx CLI auto-installed (${binPath})` };
    }
  }
  const errDetail = (installRes.stderr || installRes.stdout).trim().slice(-300);
  return {
    installed: false,
    binPath: "",
    detail: errDetail
      ? `sbx CLI auto-install failed: ${errDetail}`
      : "sbx CLI not installed; install it and retry (https://docs.sbx.dev)",
  };
}

/** `which sbx` + `sbx ls`: is the CLI present and logged in on this host? */
export function sandboxAuthStatus(): {
  ok: boolean;
  installed: boolean;
  authenticated: boolean;
  detail: string;
  sandboxes: SandboxBoxInfo[];
} {
  if (!localRunnerIsCustom) {
    const localBinDir = path.join(os.homedir(), ".local", "bin");
    const pathParts = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const extra of ["/usr/local/bin", localBinDir]) {
      if (!pathParts.includes(extra)) pathParts.unshift(extra);
    }
    process.env.PATH = pathParts.join(path.delimiter);
  }
  const probe = runLocal(["sh", "-c", "command -v sbx"], 15);
  const installed = probe.status === 0 && probe.stdout.trim().length > 0;
  if (!installed) {
    return {
      ok: false,
      installed: false,
      authenticated: false,
      detail: "sbx CLI not installed; install it and retry (https://docs.sbx.dev)",
      sandboxes: [],
    };
  }
  const listing = runLocal(["sbx", "--cloud", "ls", "--json"], 60);
  if (listing.status === 0) {
    const sandboxes = parseSandboxListing(listing.stdout);
    return {
      ok: true,
      installed: true,
      authenticated: true,
      detail: `sbx authenticated (${probe.stdout.trim()})${sandboxes.length ? ` · ${sandboxes.length} sandbox${sandboxes.length === 1 ? "" : "es"}` : ""}`,
      sandboxes,
    };
  }
  const why = (listing.stderr || listing.stdout).trim().slice(-300);
  return {
    ok: false,
    installed: true,
    authenticated: false,
    detail: why || "sbx is installed but not authenticated; run `sbx login`",
    sandboxes: [],
  };
}

/**
 * Start (or describe) the sandbox login. A stored `SBX_TOKEN` authenticates
 * non-interactively; otherwise the CLI prints its verification URL/instructions.
 */
export function sandboxAuthStart(token?: string): {
  ok: boolean;
  authenticated: boolean;
  verificationUrl: string | null;
  userCode: string | null;
  instructions: string;
  detail: string;
} {
  if (!localRunnerIsCustom) {
    const cli = ensureSbxCliInstalled();
    if (!cli.installed) {
      return {
        ok: false,
        authenticated: false,
        verificationUrl: null,
        userCode: null,
        instructions: "Install the `sbx` CLI (https://docs.sbx.dev) and retry.",
        detail: scrubSecrets(cli.detail),
      };
    }
  }
  const explicit = String(token ?? process.env.SBX_TOKEN ?? "").trim();
  if (explicit) {
    const res = runLocal(["sh", "-c", "sbx auth login --token \"$SBX_TOKEN\" 2>&1 || sbx auth --token \"$SBX_TOKEN\" 2>&1 || true"],
      120, { SBX_TOKEN: explicit });
    const status = sandboxAuthStatus();
    return {
      ok: status.authenticated,
      authenticated: status.authenticated,
      verificationUrl: null,
      userCode: null,
      instructions: "Run `sbx login` in a terminal, or paste an sbx token.",
      detail: scrubSecrets(
        status.authenticated
          ? "sbx authenticated with the supplied token"
          : (res.stdout || res.stderr).trim().slice(-300) || status.detail,
      ),
    };
  }
  // Real runtime: a synchronous `sbx login` blocks until the browser flow
  // finishes, so the caller never sees the verification URL. Start it detached
  // instead, read the first chunk (or wait up to 4000 ms) and leave the process
  // alive in the background to finish the browser auth.
  if (!localRunnerIsCustom) {
    const login = startLoginDetached(4000);
    const parsed = parseSbxLoginOutput(login.text);
    const instructions = sbxLoginInstructions(parsed, login.started);
    return {
      ok: login.started,
      authenticated: false,
      verificationUrl: parsed.verificationUrl,
      userCode: parsed.userCode,
      instructions,
      detail: scrubSecrets(
        login.text.slice(-400)
          || (login.started
            ? "sbx login started in the background; finish the browser flow"
            : "could not start `sbx login`"),
      ),
    };
  }
  const start = runLocal(["sbx", "login"], 20);
  const text = `${start.stdout}\n${start.stderr}`.trim();
  const parsed = parseSbxLoginOutput(text);
  const instructions = sbxLoginInstructions(parsed, start.status !== null);
  return {
    ok: start.status === 0,
    authenticated: start.status === 0,
    verificationUrl: parsed.verificationUrl,
    userCode: parsed.userCode,
    instructions,
    detail: scrubSecrets(text.slice(-400) || "sbx login started; finish the browser flow"),
  };
}

/**
 * Spawn `sbx login` detached, mirroring its output into a temp log, and return
 * the first chunk (or whatever arrived within `timeoutMs`). The child is
 * unref'd so it outlives this call and can complete the browser flow.
 */
function startLoginDetached(timeoutMs = 4000): { text: string; started: boolean } {
  if (activeLoginSession && Date.now() - activeLoginSession.startedAt < 5 * 60 * 1000) {
    try {
      process.kill(activeLoginSession.pid, 0);
      const existingText = fs.readFileSync(activeLoginSession.logFile, "utf8");
      if (parseSbxLoginOutput(existingText).verificationUrl !== null) {
        return { text: existingText.trim(), started: true };
      }
    } catch {
      activeLoginSession = null;
    }
  }
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sbx-login-"));
  const logFile = path.join(dir, "login.log");
  let started = false;
  let fd: number | null = null;
  let pid: number | undefined;
  try {
    fd = fs.openSync(logFile, "a", 0o600);
    const child = spawn("sbx", ["login"], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {});
    child.unref();
    pid = child.pid;
    started = pid !== undefined;
  } catch {
    started = false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
  if (started && pid !== undefined) {
    activeLoginSession = { pid, logFile, startedAt: Date.now() };
  }
  const readLog = (): string => {
    try {
      return fs.readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let text = readLog();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && parseSbxLoginOutput(text).verificationUrl === null) {
    Atomics.wait(sleeper, 0, 0, 50);
    text = readLog();
  }
  return { text: text.trim(), started };
}

type LocalResult = { status: number | null; stdout: string; stderr: string };

/** True when a test injected `localRunner`; false on the real runtime. */
let localRunnerIsCustom = false;

function defaultLocalRunner(
  args: readonly string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
): LocalResult {
  const res = spawnSync(args[0] as string, args.slice(1), {
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Injectable local process runner for sandbox CLI calls (tests swap it). */
let localRunner: (args: readonly string[], timeout: number, env?: NodeJS.ProcessEnv) => LocalResult =
  defaultLocalRunner;

/** Replace the local CLI runner (offline unit tests). Pass null to restore. */
export function _setLocalRunnerForTests(
  runner: ((args: readonly string[], timeout: number, env?: NodeJS.ProcessEnv) => LocalResult) | null,
): void {
  localRunnerIsCustom = runner !== null;
  localRunner = runner ?? defaultLocalRunner;
}

function runLocal(args: readonly string[], timeout: number, env?: NodeJS.ProcessEnv): LocalResult {
  return localRunner(args, timeout, env);
}

function sandboxAuthAction(
  action: "auth-status" | "auth-start",
  _outDir?: string,
): { ok: boolean; detail: string; status?: string; probe?: Record<string, unknown> } {
  if (action === "auth-status") {
    const st = sandboxAuthStatus();
    return {
      ok: st.ok,
      detail: st.detail,
      status: st.authenticated ? "authorized" : st.installed ? "unauthenticated" : "missing-cli",
      probe: {
        installed: st.installed,
        authenticated: st.authenticated,
        sandboxes: st.sandboxes,
      },
    };
  }
  const started = sandboxAuthStart();
  return {
    ok: started.ok,
    detail: started.detail,
    status: started.authenticated ? "authorized" : "pending",
    probe: {
      verificationUrl: started.verificationUrl,
      userCode: started.userCode,
      instructions: started.instructions,
    },
  };
}

/** Provision a docker-sbx or ssh node: create/bootstrap, deploy, probe. */
function provisionNode(
  instance: RenderNodeInstance,
  outDir?: string,
): { ok: boolean; detail: string; status?: string; probe?: Record<string, unknown> } {
  const rec = instance.record;
  const studio = process.env.MANHWA_STUDIO || path.join(REPO_ROOT, "remotion-studio");
  try {
    if (instance.kind === "docker-sbx") {
      let auth = sandboxAuthStatus();
      if (!auth.installed && !localRunnerIsCustom) {
        const cli = ensureSbxCliInstalled();
        if (cli.installed) {
          auth = sandboxAuthStatus();
        } else {
          return { ok: false, detail: cli.detail, status: "missing-cli" };
        }
      }
      if (!auth.installed) return { ok: false, detail: auth.detail, status: "missing-cli" };
      if (!auth.authenticated) {
        return {
          ok: false,
          detail: `${auth.detail}; complete the sandbox login first`,
          status: "unauthenticated",
        };
      }
      const node = cloudlane.createCloudNode(
        {
          id: instance.id,
          box: String(rec.box ?? instance.id),
          template: rec.template === undefined ? undefined : String(rec.template),
          slots: rec.slots,
          maxHours: rec.maxHours,
          idlePauseS: rec.idlePauseS,
          minMemGb: rec.minMemGb,
          minDiskGb: rec.minDiskGb,
          remoteDir: rec.remoteDir,
        },
        undefined,
        { allowControl: true },
      );
      const res = node.provision({ studio });
      return { ok: res.ok, detail: res.detail, status: res.ok ? "provisioned" : "failed", probe: res.probe };
    }
    if (instance.kind === "ssh") {
      const node = lappy.createSshNode({
        id: instance.id,
        host: String(rec.host ?? ""),
        user: rec.user === undefined ? undefined : String(rec.user),
        port: rec.port,
        remoteDir: rec.remoteDir === undefined ? undefined : String(rec.remoteDir),
        identityFile: resolveIdentityFile(rec, outDir) ?? undefined,
        slots: rec.slots,
        supportsCleaner: rec.supportsCleaner,
        maxLoadFactor: rec.maxLoadFactor,
        minMemGb: rec.minMemGb,
        minDiskGb: rec.minDiskGb,
      });
      const res = node.provision({ studio });
      return { ok: res.ok, detail: res.detail, status: res.ok ? "provisioned" : "failed", probe: res.probe };
    }
    return {
      ok: false,
      detail: `render node ${instance.id} (${instance.kind}) needs no provisioning`,
      status: "not-applicable",
    };
  } catch (err) {
    return { ok: false, detail: String((err as Error)?.message ?? err), status: "failed" };
  }
}