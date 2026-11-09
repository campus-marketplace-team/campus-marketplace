// One-off: gives every seed listing a photo from Pixabay. Run it by hand, never
// from a build or start step:
//
//   npx tsx server/scripts/fetchListingImages.ts
//
// For each listing in prisma/seedListings.ts and prisma/demoData.ts it searches Pixabay for the
// listing's photoSearch term (photos, horizontal, safe search) and picks a
// product shot: it tries "<term> isolated" first (Pixabay's tag for cut-out
// product photos), then the plain term, and takes the first result whose tags
// name the item and don't mention people. It downloads that image (Pixabay
// forbids hotlinking), crops it to 800x600 and saves it as
// client/public/images/<slug>.webp. A listing with a pixabayId gets exactly that
// image instead of a search result. The seed already points each
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
import { DEMO_LISTINGS } from "../prisma/demoData.js";
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

/** Results looked at per search before giving up on it. */
const CANDIDATES = 50;

// A listing photo should show the item, not someone using it. Pixabay only has a
// few tags per photo, so this catches most people shots, not all of them.
const PEOPLE_TAGS = new Set(
  ("man men woman women person people girl girls boy boys child children kid kids teen teenager guy lady model adult human " +
    "portrait face hand hands finger fingers businessman worker chef baby beard female male blonde brunette athlete " +
    "bodybuilder bodybuilding muscle muscles arm arms cyclist cyclists skier student students family couple selfie")
    .split(" "),
);

/** "boxes" → "box", "dumbbells" → "dumbbell": close enough to match tags. */
const stem = (word: string) => word.toLowerCase().replace(/(x|ch|sh)es$/, "$1").replace(/s$/, "");

/** A photo's tags, e.g. "dumbbell, weights, fitness", as lowercase words. */
const tagWords = (tags: string) => tags.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True if the photo is tagged with the item (the term's last word) and not with people. */
function isProductShot(tags: string, term: string) {
  const words = tagWords(tags);
  if (words.some((w) => PEOPLE_TAGS.has(w))) return false;
  const item = stem(term.trim().split(/\s+/).at(-1) ?? "");
  return words.some((w) => stem(w) === item);
}

type Hit = { pageURL: string; largeImageURL: string; tags: string };

/**
 * The first product shot for `term` that isn't in `used` (so similar listings, like
 * the textbooks, don't all get the same photo), searching "<term> isolated" first.
 * Returns the query that found it.
 */
async function findProductShot(term: string, used: Set<string>): Promise<{ hit: Hit; query: string } | null> {
  for (const query of [`${term} isolated`, term]) {
    const hit = (await search(query)).find((h) => !used.has(h.pageURL) && isProductShot(h.tags, term));
    if (hit) return { hit, query };
    await sleep(DELAY_MS);
  }
  return null;
}

/** The image with this Pixabay id, picked by hand in seedListings.ts. */
async function findById(id: number): Promise<{ hit: Hit; query: string } | null> {
  const [hit] = await search({ id: String(id) });
  return hit ? { hit, query: `pixabayId ${id}` } : null;
}

async function search(query: string | { id: string }): Promise<Hit[]> {
  const params = new URLSearchParams({
    key: apiKey,
    ...(typeof query === "string" ? { q: query } : query),
    image_type: "photo",
    orientation: "horizontal",
    safesearch: "true",
    per_page: String(CANDIDATES),
  });
  const res = await fetch(`${PIXABAY_API}?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Pixabay search answered HTTP ${res.status} ${body}`.trim());
  }
  const json = (await res.json()) as { hits?: Partial<Hit>[] };
  return (json.hits ?? []).flatMap((h) =>
    h.pageURL && h.largeImageURL ? [{ pageURL: h.pageURL, largeImageURL: h.largeImageURL, tags: h.tags ?? "" }] : [],
  );
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
  const used = new Set<string>();

  // The demo listings (scripts/demo-seed.ts) need photos too.
  for (const listing of [...SEED_LISTINGS, ...Object.values(DEMO_LISTINGS)]) {
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
      const found = listing.pixabayId ? await findById(listing.pixabayId) : await findProductShot(listing.photoSearch, used);
      if (!found) {
        row.pixabay = "FAILED: no product shot without people, try another photoSearch term";
        failed += 1;
        continue;
      }
      const { hit, query } = found;
      used.add(hit.pageURL);
      row.search = query;
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
