// Pure helpers for the on-disk attachment layout (spec §5 + R9 + R10).
//
// Two-column rule: `originalName` is the verbatim display name (kept in DB +
// served via Content-Disposition). `storagePath` is what hits the filesystem
// — derived purely from a generated UUID + a sanitized extension. The two
// MUST NOT mix; user-controlled strings never reach the filesystem path.

import path from "node:path";

import { env } from "../env";

// Cap chosen to match the spec R10 contract: `[a-zA-Z0-9]{0,8}`. Anything
// longer or with non-alphanumeric chars becomes empty — favours safety over
// fidelity to weird extensions.
const EXT_PATTERN = /^[a-zA-Z0-9]{1,8}$/;

export function sanitizeExtension(rawExt: string): string {
  // path.extname returns either "" or ".something"; strip the leading dot.
  const stripped = rawExt.startsWith(".") ? rawExt.slice(1) : rawExt;
  if (stripped.length === 0) return "";
  return EXT_PATTERN.test(stripped) ? `.${stripped}` : "";
}

export interface StoragePath {
  relativePath: string;
  absolutePath: string;
}

export function buildStoragePath(
  attachmentId: string,
  originalName: string,
  now: Date = new Date(),
): StoragePath {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = sanitizeExtension(path.extname(originalName));
  const relativePath = path.posix.join(yyyy, mm, `${attachmentId}${ext}`);
  return {
    relativePath,
    absolutePath: path.join(env.UPLOAD_DIR, relativePath),
  };
}

// Used by the download handler. Always compose via path.join so that a
// stored relative path of "2026/04/<id>.png" resolves against UPLOAD_DIR
// without any opportunity to escape it (R10 guarantees the relative path
// is built from sanitized inputs, so this is defence in depth).
export function resolveStorageAbsolute(relativePath: string): string {
  return path.join(env.UPLOAD_DIR, relativePath);
}
