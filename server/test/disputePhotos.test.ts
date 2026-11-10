import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDisputePhoto, MAX_PHOTO_BYTES } from "../src/disputes/photos.js";

// How the dispute agent's photos are loaded before they go to Claude as base64.
// No database and no real network: storage downloads use a stubbed fetch.

const STORAGE = "https://project.supabase.test";
const BUCKET = "listing-photos";
const storageUrl = (path: string) => `${STORAGE}/storage/v1/object/public/${BUCKET}/${path}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function stubStorage() {
  vi.stubEnv("SUPABASE_URL", STORAGE);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("SUPABASE_STORAGE_BUCKET", BUCKET);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadDisputePhoto", () => {
  it("reads a seed listing's web-app path (/images/<slug>.webp) from client/public", async () => {
    const photo = await loadDisputePhoto("/images/bookshelf.webp");
    const onDisk = await readFile(new URL("../../client/public/images/bookshelf.webp", import.meta.url));
    expect(photo).toEqual({ ok: true, mediaType: "image/webp", data: onDisk.toString("base64") });
  });

  it("reports a missing seed photo instead of throwing", async () => {
    expect(await loadDisputePhoto("/images/no-such-photo.webp")).toEqual({ ok: false, reason: "file not found" });
  });

  it.each(["/images/../../server/.env", "/images/%2e%2e/x.webp", "/etc/passwd", "/images/sub/dir.webp", "/images/x.svg"])("refuses %s, which isn't a plain image file name", async (path) => {
    expect(await loadDisputePhoto(path)).toEqual({ ok: false, reason: "not a path to one of our images" });
  });

  it("downloads a photo from our storage bucket, without sending the key", async () => {
    stubStorage();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(PNG, { status: 200 }));

    expect(await loadDisputePhoto(storageUrl("disputes/a.png"))).toEqual({ ok: true, mediaType: "image/png", data: PNG.toString("base64") });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.stringify(init)).not.toContain("test-key");
  });

  it("never fetches a URL outside our bucket", async () => {
    stubStorage();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of ["https://evil.test/a.png", `${STORAGE}/storage/v1/object/public/other-bucket/a.png`, "http://169.254.169.254/latest/meta-data"]) {
      expect(await loadDisputePhoto(url)).toEqual({ ok: false, reason: "not stored by this app" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips downloads that fail, aren't images or are too large", async () => {
    stubStorage();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await loadDisputePhoto(storageUrl("a.png"))).toEqual({ ok: false, reason: "download failed (HTTP 404)" });

    fetchSpy.mockResolvedValueOnce(new Response("<svg/>", { status: 200 }));
    expect(await loadDisputePhoto(storageUrl("a.png"))).toEqual({ ok: false, reason: "not a JPEG, PNG or WebP image" });

    fetchSpy.mockResolvedValueOnce(new Response(Buffer.concat([PNG, Buffer.alloc(MAX_PHOTO_BYTES)]), { status: 200 }));
    expect(await loadDisputePhoto(storageUrl("a.png"))).toEqual({ ok: false, reason: "file is too large" });

    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await loadDisputePhoto(storageUrl("a.png"))).toEqual({ ok: false, reason: "download failed" });
  });
});
