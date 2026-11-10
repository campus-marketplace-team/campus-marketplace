import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStorageConfig, pathFromPublicUrl, sniffImage } from "../storage.js";

// Loads the photos the dispute agent looks at, so they can go to Claude as base64.
// Claude can't fetch every URL we store: seed listings keep paths relative to the
// web app (/images/<slug>.webp), and one URL it can't load fails the whole request.
// So we load each photo ourselves, from the web app's public folder for those paths
// and from our Supabase bucket for uploads, and never fetch any other host: the URLs
// are in our database, but nothing else needs loading. A photo that can't be loaded
// comes back with a reason, for the agent to be told it's missing.

/** The API's limit for one base64 image. Uploads are far smaller, so a bigger file isn't one of ours. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** src/disputes and dist/disputes are both two levels under server/, which sits next to client/. */
const WEB_PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/public");
/** Only plain file names in /images, so a stored path can't climb out of the folder. */
const WEB_IMAGE_PATH = /^\/images\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:webp|png|jpe?g)$/;

export type LoadedPhoto = { ok: true; mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string } | { ok: false; reason: string };
export type PhotoLoader = (url: string) => Promise<LoadedPhoto>;

function toPhoto(bytes: Buffer): LoadedPhoto {
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, reason: "file is too large" };
  // The bytes decide the type, not the extension or a Content-Type header.
  const kind = sniffImage(bytes);
  if (!kind) return { ok: false, reason: "not a JPEG, PNG or WebP image" };
  return { ok: true, mediaType: kind.type as "image/jpeg" | "image/png" | "image/webp", data: bytes.toString("base64") };
}

async function fromWebPublicDir(path: string): Promise<LoadedPhoto> {
  try {
    return toPhoto(await readFile(resolve(WEB_PUBLIC_DIR, `.${path}`)));
  } catch {
    return { ok: false, reason: "file not found" };
  }
}

async function fromStorage(url: string): Promise<LoadedPhoto> {
  try {
    // Public bucket: no key is sent.
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `download failed (HTTP ${res.status})` };
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) return { ok: false, reason: "file is too large" };
    return toPhoto(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    return { ok: false, reason: err instanceof Error && err.name === "TimeoutError" ? "download timed out" : "download failed" };
  }
}

/** Loads one stored photo URL. Never throws. */
export const loadDisputePhoto: PhotoLoader = async (url) => {
  if (url.startsWith("/")) return WEB_IMAGE_PATH.test(url) ? fromWebPublicDir(url) : { ok: false, reason: "not a path to one of our images" };
  const storage = getStorageConfig();
  if (storage && pathFromPublicUrl(storage, url) !== null) return fromStorage(url);
  return { ok: false, reason: "not stored by this app" };
};
