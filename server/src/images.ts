// Normalises uploaded listing and dispute photos before they reach storage.
//
// Every photo is decoded and re-encoded with sharp: EXIF rotation is applied to
// the pixels, all metadata is dropped (phone photos carry GPS location, camera
// serials, etc.), the longest side is capped at PHOTO_MAX_SIDE without
// upscaling, and the result is WebP. Anything sharp can't decode is rejected.
//
// Render's free instance has 512 MB, so photos are processed one at a time
// (a simple queue), sharp's own thread pool and cache are kept small, and
// decoding refuses images above PHOTO_MAX_INPUT_PIXELS.

import sharp from "sharp";

export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_WEBP_QUALITY = 80;
/** ~50 megapixels: above any phone camera, low enough to refuse decompression bombs. */
export const PHOTO_MAX_INPUT_PIXELS = 50_000_000;

sharp.concurrency(1);
sharp.cache(false);

export class InvalidImageError extends Error {
  constructor() {
    super("That file isn't an image we can read");
    this.name = "InvalidImageError";
  }
}

export type ProcessedPhoto = { data: Buffer; type: "image/webp"; ext: "webp"; width: number; height: number };

let queue: Promise<unknown> = Promise.resolve();

/** Runs jobs one after another, so only one image is in memory at a time. */
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

async function normalise(input: Buffer): Promise<ProcessedPhoto> {
  try {
    // No withMetadata()/keepMetadata(): sharp writes no EXIF, XMP, IPTC or ICC
    // to the output unless asked. rotate() with no angle applies EXIF orientation.
    const { data, info } = await sharp(input, { limitInputPixels: PHOTO_MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize(PHOTO_MAX_SIDE, PHOTO_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: PHOTO_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, type: "image/webp", ext: "webp", width: info.width, height: info.height };
  } catch {
    throw new InvalidImageError();
  }
}

/**
 * Throws InvalidImageError if the bytes aren't a decodable image. Callers check
 * the type with sniffImage first, so sharp only ever sees JPEG, PNG or WebP.
 */
export function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  return oneAtATime(() => normalise(input));
}
