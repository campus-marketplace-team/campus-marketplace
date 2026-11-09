// One-off: gives every seed listing a photo from Pixabay. Run it by hand, never
// from a build or start step:
//
//   npx tsx server/scripts/fetchListingImages.ts
//
// For each listing in prisma/seedListings.ts it searches Pixabay for the
// listing's photoSearch term (photos, horizontal, safe search), takes the top
// result, downloads it (Pixabay forbids hotlinking), crops it to 800x600 and
// saves it as client/public/images/<slug>.webp. The seed already points each
// listing at /images/<slug>.webp; run `npm run seed -w server` to apply that.
//
// A listing whose file already exists is skipped, so rerunning never replaces a
// photo you swapped by hand. To fetch one again, delete its file and rerun.
//
// Needs PIXABAY_API_KEY in server/.env (pixabay.com/api/docs, free account).
// The key is sent in the request URL, so URLs and errors are never printed
// without it being stripped out first.

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import sharp from "sharp";
import { SEED_LISTINGS } from "../prisma/seedListings.js";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES_DIR = resolve(SERVER_DIR, "../client/public/images");

const PIXABAY_API = "https://pixabay.com/api/";
/** Pixabay allows 100 requests a minute; one request a second stays well under. */
const DELAY_MS = 1200;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const WIDTH = 800;
const HEIGHT = 600;
const WEBP_QUALITY = 80;

config({ path: join(SERVER_DIR, ".env"), quiet: true });
const apiKey = (process.env.PIXABAY_API_KEY ?? "").trim();

/** Removes the API key from anything about to be printed. */
function redact(text: string) {
  return apiKey ? text.split(apiKey).join("[PIXABAY_API_KEY]").split(encodeURIComponent(apiKey)).join("[PIXABAY_API_KEY]") : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Hit = { pageURL: string; largeImageURL: string };

async function searchTopHit(term: string): Promise<Hit | null> {
  const params = new URLSearchParams({
    key: apiKey,
    q: term,
    image_type: "photo",
    orientation: "horizontal",
    safesearch: "true",
    per_page: "3", // Pixabay's minimum
  });
  const res = await fetch(`${PIXABAY_API}?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Pixabay search answered HTTP ${res.status} ${body}`.trim());
  }
  const json = (await res.json()) as { hits?: Partial<Hit>[] };
  const hit = json.hits?.[0];
  return hit?.pageURL && hit.largeImageURL ? { pageURL: hit.pageURL, largeImageURL: hit.largeImageURL } : null;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`image download answered HTTP ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("download wasn't an image");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("image is too large");
  return bytes;
}

type Row = { title: string; file: string; search: string; pixabay: string };

async function main() {
  if (!apiKey) {
    console.error("PIXABAY_API_KEY isn't set in server/.env. Get a key at https://pixabay.com/api/docs/ and add it there.");
    process.exitCode = 1;
    return;
  }
  await mkdir(IMAGES_DIR, { recursive: true });

  const rows: Row[] = [];
  let failed = 0;
  let calledApi = false;

  for (const listing of SEED_LISTINGS) {
    const file = `${listing.slug}.webp`;
    const target = join(IMAGES_DIR, file);
    const row: Row = { title: listing.title, file, search: listing.photoSearch, pixabay: "" };
    rows.push(row);

    if (existsSync(target)) {
      row.search = "-";
      row.pixabay = "skipped: file already exists";
      continue;
    }

    // One request at a time, spaced out for the rate limit.
    if (calledApi) await sleep(DELAY_MS);
    calledApi = true;
    try {
      const hit = await searchTopHit(listing.photoSearch);
      if (!hit) {
        row.pixabay = "FAILED: no results, try another photoSearch term";
        failed += 1;
        continue;
      }
      const image = await sharp(await download(hit.largeImageURL))
        .rotate() // respect EXIF orientation
        .resize(WIDTH, HEIGHT, { fit: "cover" })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      // Write then rename, so a crash never leaves a half-written file that a rerun would skip.
      const partial = `${target}.partial`;
      await writeFile(partial, image);
      await rename(partial, target);
      row.pixabay = hit.pageURL;
      console.log(`saved ${file} (${Math.round(image.length / 1024)} KB)`);
    } catch (err) {
      row.pixabay = `FAILED: ${redact((err as Error).message)}`;
      failed += 1;
    }
  }

  console.log();
  console.table(rows.map((r) => ({ "listing title": r.title, file: r.file, "search term": r.search, "Pixabay page": r.pixabay })));
  console.log(`\n${rows.length - failed} of ${rows.length} listings have a photo in client/public/images.`);
  if (failed > 0) {
    console.log("Fix the failed ones (change photoSearch in prisma/seedListings.ts, or add a file by hand) and rerun.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exitCode = 1;
});
