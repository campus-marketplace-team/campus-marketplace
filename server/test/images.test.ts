import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InvalidImageError, PHOTO_MAX_SIDE, processPhoto } from "../src/images.js";

// Photo processing with real sharp, no storage or database.

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

function solid(width: number, height: number, background = RED) {
  return sharp({ create: { width, height, channels: 3, background } });
}

/** A JPEG whose pixels are 40 wide x 20 tall (red left half, blue right half), tagged EXIF orientation 6 (rotate 90° clockwise to view). */
async function sidewaysPhoneJpeg() {
  const blueHalf = await solid(20, 20, BLUE).png().toBuffer();
  return solid(40, 20)
    .composite([{ input: blueHalf, left: 20, top: 0 }])
    .jpeg({ quality: 95 })
    .withExif({
      IFD0: { Make: "TestPhone", Model: "Model X", Copyright: "secret-owner" },
      // GPS IFD: where the photo was taken.
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 15/1 30/1", GPSLongitudeRef: "W", GPSLongitude: "79/1 55/1 10/1" },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function pixel(image: Buffer, x: number, y: number) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe("processPhoto", () => {
  it("applies EXIF rotation to the pixels", async () => {
    const input = await sidewaysPhoneJpeg();
    const before = await sharp(input).metadata();
    expect(before).toMatchObject({ width: 40, height: 20, orientation: 6 });

    const out = await processPhoto(input);
    const meta = await sharp(out.data).metadata();
    expect(meta).toMatchObject({ width: 20, height: 40 });
    expect(meta.orientation).toBeUndefined();
    expect(out).toMatchObject({ width: 20, height: 40 });

    // Rotated 90° clockwise: the left (red) half is now on top, the right (blue) half below.
    const top = await pixel(out.data, 10, 5);
    const bottom = await pixel(out.data, 10, 35);
    expect(top.r).toBeGreaterThan(200);
    expect(top.b).toBeLessThan(60);
    expect(bottom.b).toBeGreaterThan(200);
    expect(bottom.r).toBeLessThan(60);
  });

  it("strips all metadata, including GPS location", async () => {
    const input = await sidewaysPhoneJpeg();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.exif!.includes(Buffer.from("secret-owner"))).toBe(true);
    expect(before.exif!.includes(Buffer.from("TestPhone"))).toBe(true);

    const out = await processPhoto(input);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    for (const text of ["secret-owner", "TestPhone", "Model X"]) {
      expect(out.data.includes(Buffer.from(text))).toBe(false);
    }
  });

  it("re-encodes as WebP", async () => {
    const out = await processPhoto(await solid(100, 80).png().toBuffer());
    expect(out).toMatchObject({ type: "image/webp", ext: "webp" });
    expect((await sharp(out.data).metadata()).format).toBe("webp");
  });

  it.each([
    { name: "landscape", width: 4000, height: 3000, expected: [1600, 1200] },
    { name: "portrait", width: 1500, height: 4500, expected: [533, 1600] },
    { name: "square", width: 2000, height: 2000, expected: [1600, 1600] },
  ])("caps the longest side at $expected for a $name photo", async ({ width, height, expected }) => {
    const out = await processPhoto(await solid(width, height).jpeg().toBuffer());
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual(expected);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(PHOTO_MAX_SIDE);
  });

  it("never upscales a small photo", async () => {
    const out = await processPhoto(await solid(800, 600).jpeg().toBuffer());
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([800, 600]);
  });

  it("rejects bytes sharp can't decode, even with a valid image signature", async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not really a jpeg")]);
    const real = await solid(200, 200).jpeg().toBuffer();
    const truncated = real.subarray(0, Math.floor(real.length / 2));

    for (const input of [fakePng, fakeJpeg, truncated, Buffer.from("<script>alert(1)</script>")]) {
      await expect(processPhoto(input)).rejects.toBeInstanceOf(InvalidImageError);
    }
  });

  it("keeps working after a rejected image, and handles concurrent uploads one at a time", async () => {
    const good = await solid(300, 200).jpeg().toBuffer();
    const results = await Promise.allSettled([
      processPhoto(good),
      processPhoto(Buffer.from("garbage")),
      processPhoto(good),
      processPhoto(good),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  });
});
