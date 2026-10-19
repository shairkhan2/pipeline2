/**
 * Persistent 0o600 secret store at `<outDir>/config/secrets.json`.
 *
 * Supports AES-256-GCM encryption (`enc:v1:<ivHex>:<tagHex>:<cipherHex>`) when
 * `process.env.MANHWA_MASTER_KEY` is non-empty, and plaintext `0o600` otherwise.
 * Raw secret values are write-only to callers outside the backend runtime; UI/API
 * read paths use `getSecretMeta` and `maskSecretHint`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "out");

export const SECRETS_SCHEMA_VERSION = 1;
export const SECRETS_FILENAME = "secrets.json";
const ENC_PREFIX = "enc:v1:";

export interface SecretMeta {
  hasSecret: boolean;
  hint: string | null;
  updatedAt: number | null;
}

export interface PutSecretResult {
  hasSecret: boolean;
  hint: string;
  updatedAt: number;
}

interface StoredSecretRecord {
  value: string;
  hint: string;
  updatedAt: number;
}

interface StoredSecretsFile {
  schemaVersion: number;
  updatedAt: number;
  secrets: Record<string, StoredSecretRecord>;
}

const SECRET_REDACTION_PATTERNS: Array<{ re: RegExp; replace: (...args: any[]) => string }> = [
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    replace: (_m, p1: string) => `${p1}[REDACTED]`,
  },
  {
    re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bsk-or-[A-Za-z0-9_\-]{6,}\b/gi,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bsk-ant-[A-Za-z0-9_\-]{6,}\b/gi,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bsk-[A-Za-z0-9_\-]{8,}\b/gi,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bxai-[A-Za-z0-9_\-]{6,}\b/gi,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bAIza[A-Za-z0-9_\-]{10,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bgsk_[A-Za-z0-9_\-]{6,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /((?:api[_-]?key|authorization|password|secret|token|access_token|refresh_token|client_secret|private_key)\s*[=:]\s*)\S+/gi,
    replace: (_m, p1: string) => `${p1}[REDACTED]`,
  },
  {
    re: /("(?:access|refresh|api_key|apiKey|token|access_token|refresh_token|client_secret|private_key|authorization|secret|password)"\s*:\s*)"[^"]*"/gi,
    replace: (_m, p1: string) => `${p1}"[REDACTED]"`,
  },
];

function stripTrailingConfigDir(value: string): string {
  const resolved = path.resolve(value);
  return path.basename(resolved) === "config" ? path.dirname(resolved) : resolved;
}

export function resolveOutDir(outDir?: string): string {
  if (typeof outDir === "string" && outDir.trim().length > 0) {
    return path.resolve(outDir.trim());
  }
  const envOut = process.env.MANHWA_OUT_DIR || process.env.PIPELINE_OUT_DIR;
  if (envOut && envOut.trim().length > 0) {
    return path.resolve(envOut.trim());
  }
  const laneCfgDir = String(process.env.MANHWA_LANE_CONFIG_DIR ?? "").trim();
  if (laneCfgDir) return stripTrailingConfigDir(laneCfgDir);
  const laneCfg = String(process.env.MANHWA_LANE_CONFIG ?? "").trim();
  if (laneCfg) return stripTrailingConfigDir(path.dirname(path.resolve(laneCfg)));
  const jobsDir = String(process.env.MANHWA_JOBS_DIR ?? "").trim();
  if (jobsDir) return path.dirname(path.resolve(jobsDir));
  if (String(process.env.VITEST ?? "").trim()) {
    return path.join(REPO_ROOT, "out", ".vitest-empty");
  }
  return DEFAULT_OUT_DIR;
}

export function secretsFilePath(outDir?: string): string {
  const base = resolveOutDir(outDir);
  return path.join(base, "config", SECRETS_FILENAME);
}

function normalizeRef(ref: string): string {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error("Secret reference (ref) must be a non-empty string");
  }
  return ref.trim();
}

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash("sha256").update(masterKey).digest();
}

export function encryptSecretValue(value: string, masterKey = process.env.MANHWA_MASTER_KEY ?? ""): string {
  const key = masterKey.trim();
  if (!key) return value;
  const keyBuf = deriveKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecretValue(
  stored: string,
  masterKey = process.env.MANHWA_MASTER_KEY ?? "",
): string | null {
  if (typeof stored !== "string") return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = masterKey.trim();
  if (!key) return null;
  const rest = stored.slice(ENC_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, cipherHex] = parts;
  if (!ivHex || !tagHex || cipherHex === undefined) return null;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const cipherBuf = Buffer.from(cipherHex, "hex");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(key), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function maskSecretHint(value: string): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) {
    return "****";
  }
  let prefix = trimmed.slice(0, 3);
  for (const knownPrefix of ["sk-or-", "sk-ant-", "sk-", "xai-", "gsk_", "AIza"]) {
    if (trimmed.startsWith(knownPrefix)) {
      prefix = knownPrefix;
      break;
    }
  }
  const suffix = trimmed.slice(-4);
  if (prefix.length + suffix.length >= trimmed.length) {
    return "****";
  }
  return `${prefix}...${suffix}`;
}

export function scrubSecrets(text: string): string {
  if (text === null || text === undefined || (text as unknown) === false || (text as unknown) === 0 || text === "") {
    return "";
  }
  let out = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const { re, replace } of SECRET_REDACTION_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

function readSecretsDoc(outDir?: string): StoredSecretsFile | null {
  const filePath = secretsFilePath(outDir);
  let raw: string;
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSecretsFile>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const secrets = parsed.secrets && typeof parsed.secrets === "object" && !Array.isArray(parsed.secrets)
      ? parsed.secrets
      : {};
    return {
      schemaVersion: SECRETS_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      secrets,
    };
  } catch {
    return null;
  }
}

function writeSecretsDoc(doc: StoredSecretsFile, outDir?: string): void {
  const filePath = secretsFilePath(outDir);
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dirPath,
    `.${SECRETS_FILENAME}.${process.pid}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`,
  );
  const payload = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tmpPath, flags, 0o600);
    try {
      let offset = 0;
      while (offset < payload.length) {
        const written = fs.writeSync(fd, payload, offset, payload.length - offset);
        if (written <= 0) throw new Error("Short write to temporary secrets store");
        offset += written;
      }
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
  }
}

export function putSecret(
  ref: string,
  value: string,
  outDir?: string,
): PutSecretResult {
  const key = normalizeRef(ref);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Secret value must be a non-empty string");
  }
  const existing = readSecretsDoc(outDir) ?? {
    schemaVersion: SECRETS_SCHEMA_VERSION,
    updatedAt: 0,
    secrets: {},
  };
  const updatedAt = Date.now();
  const hint = maskSecretHint(value);
  const storedValue = encryptSecretValue(value);
  existing.updatedAt = updatedAt;
  existing.secrets[key] = {
    value: storedValue,
    hint,
    updatedAt,
  };
  writeSecretsDoc(existing, outDir);
  return {
    hasSecret: true,
    hint,
    updatedAt,
  };
}

export function getSecret(ref: string, outDir?: string): string | null {
  const key = normalizeRef(ref);
  const doc = readSecretsDoc(outDir);
  if (!doc) return null;
  const entry = doc.secrets[key];
  if (!entry || typeof entry.value !== "string") return null;
  return decryptSecretValue(entry.value);
}

export function deleteSecret(ref: string, outDir?: string): boolean {
  const key = normalizeRef(ref);
  const doc = readSecretsDoc(outDir);
  if (!doc || !(key in doc.secrets)) return false;
  delete doc.secrets[key];
  doc.updatedAt = Date.now();
  writeSecretsDoc(doc, outDir);
  return true;
}

export function getSecretMeta(ref: string, outDir?: string): SecretMeta {
  const key = normalizeRef(ref);
  const doc = readSecretsDoc(outDir);
  if (!doc) {
    return { hasSecret: false, hint: null, updatedAt: null };
  }
  const entry = doc.secrets[key];
  if (!entry) {
    return { hasSecret: false, hint: null, updatedAt: null };
  }
  return {
    hasSecret: true,
    hint: typeof entry.hint === "string" ? entry.hint : maskSecretHint(entry.value),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
  };
}
