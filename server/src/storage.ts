// Supabase Storage for listing and dispute photos, via its REST API (server only).
//
// The bucket is public-read, so photo URLs work in <img> tags without auth.
// Only this server can write to it: uploads use the secret (service role) key,
// which must never reach the client. Create the bucket once with
// `npm run storage:setup -w server`.

export type StorageConfig = {
  url: string;
  key: string;
  bucket: string;
};

/** null when Supabase Storage isn't configured; photo upload then answers 503. */
export function getStorageConfig(): StorageConfig | null {
  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET ?? "").trim() || "listing-photos";
  return { url, key, bucket };
}

// Identifies the image type from its first bytes. The Content-Type header is
// only a hint: the stored type comes from the bytes, so nothing but real
// JPEG/PNG/WebP files ends up in the public bucket.
export function sniffImage(buf: Buffer): { type: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: "image/png", ext: "png" };
  }
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { type: "image/webp", ext: "webp" };
  }
  return null;
}

function headers(config: StorageConfig, extra: Record<string, string> = {}) {
  // Same key in both headers, as supabase-js does. Works for legacy
  // service_role JWTs and the newer sb_secret_... keys.
  return { apikey: config.key, Authorization: `Bearer ${config.key}`, ...extra };
}

async function failure(action: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`Supabase Storage ${action} failed: ${res.status} ${body.slice(0, 300)}`);
}

/** Uploads one object and returns its public URL. Never overwrites an existing object. */
export async function uploadObject(
  config: StorageConfig,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const res = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${path}`, {
    method: "POST",
    headers: headers(config, {
      "Content-Type": contentType,
      "Cache-Control": "max-age=31536000", // object paths are random and never reused
      "x-upsert": "false",
    }),
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure("upload", res);
  return publicUrl(config, path);
}

export async function deleteObject(config: StorageConfig, path: string): Promise<void> {
  const res = await fetch(`${config.url}/storage/v1/object/${config.bucket}`, {
    method: "DELETE",
    headers: headers(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: [path] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await failure("delete", res);
}

export function publicUrl(config: StorageConfig, path: string): string {
  return `${config.url}/storage/v1/object/public/${config.bucket}/${path}`;
}

/** The object path inside our bucket for one of our public URLs, or null if it isn't one. */
export function pathFromPublicUrl(config: StorageConfig, url: string): string | null {
  const prefix = `${config.url}/storage/v1/object/public/${config.bucket}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

/** Creates the public bucket if it doesn't exist yet. Safe to re-run. */
export async function ensureBucket(
  config: StorageConfig,
  options: { fileSizeLimit: number; allowedMimeTypes: readonly string[] },
): Promise<"created" | "exists"> {
  const existing = await fetch(`${config.url}/storage/v1/bucket/${config.bucket}`, {
    headers: headers(config),
    signal: AbortSignal.timeout(10_000),
  });
  if (existing.ok) return "exists";

  const res = await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST",
    headers: headers(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: config.bucket,
      name: config.bucket,
      public: true,
      file_size_limit: options.fileSizeLimit,
      allowed_mime_types: options.allowedMimeTypes,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await failure("create bucket", res);
  return "created";
}
