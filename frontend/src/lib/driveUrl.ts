/**
 * Google Drive file-id parser.
 * Rejection rules match `intake.parseGdriveUrl` in `src/intake/intake.ts`.
 * Invalid input returns null instead of throwing.
 */

export const GDRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{10,120}$/;

export const ALLOWED_GDRIVE_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
]);

const FOLDER_PATH = /\/folders(?:\/|$)/i;
const DOC_PATH = /\/(?:document|spreadsheets|presentation|forms)(?:\/|$)/i;
const FILE_PATH = /\/file\/d\/([A-Za-z0-9_-]+)/;

export interface DriveLink {
  fileId: string;
  canonicalUrl: string;
  downloadUrl: string;
}

function linkFor(fileId: string): DriveLink {
  return {
    fileId,
    canonicalUrl: `https://drive.google.com/file/d/${fileId}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

/**
 * Extract a Drive file id from a sharing URL.
 * Mirrors `intake.parseGdriveUrl`: a bare id is rejected so client validation
 * never passes a value that `POST /api/intake/jobs` would 400 on.
 */
export function parseDriveId(input: string): string | null {
  return parseDriveUrl(input)?.fileId ?? null;
}

/** Same acceptance rules as `parseGdriveUrl`. Returns null when the backend would throw. */
export function parseDriveUrl(input: string): DriveLink | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol.toLowerCase() !== "https:") return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_GDRIVE_HOSTS.has(host)) return null;
  if (parsed.port && parsed.port !== "443") return null;

  const urlPath = parsed.pathname || "";
  if (FOLDER_PATH.test(urlPath) || urlPath.toLowerCase().includes("drive/folders")) return null;
  if (DOC_PATH.test(urlPath)) return null;

  let fileId: string | null = null;
  const pathMatch = FILE_PATH.exec(urlPath);
  if (pathMatch) {
    fileId = pathMatch[1] ?? null;
  } else {
    const trimmed = urlPath.replace(/\/+$/, "");
    if (trimmed === "/open" || trimmed === "/uc" || trimmed === "/download") {
      fileId = parsed.searchParams.get("id");
    }
  }

  if (!fileId || !GDRIVE_FILE_ID_RE.test(fileId)) return null;
  return linkFor(fileId);
}
