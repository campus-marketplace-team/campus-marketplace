import { randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { isListingCategory, LISTING_LIMITS, type ListingCategory } from "@campus/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { isUuid } from "../ids.js";
import { deleteObject, getStorageConfig, pathFromPublicUrl, sniffImage, uploadObject } from "../storage.js";

export const listingsRouter = Router();

const publicListing = {
  id: true,
  title: true,
  description: true,
  category: true,
  priceCents: true,
  currency: true,
  photoUrls: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  // Only public seller fields; never expose email or PayPal email.
  seller: { select: { id: true, displayName: true } },
} as const;

const DEFAULT_PAGE = 24;
const MAX_PAGE = 50;
const MY_LISTINGS_MAX = 200;

function getPublicListing(id: string) {
  return prisma.listing.findUnique({ where: { id }, select: publicListing });
}

type ListingInput = {
  title?: string;
  description?: string;
  category?: ListingCategory;
  priceCents?: number;
};

// Validates the editable fields. With partial = false (create) every field is required.
function parseListingInput(body: unknown, partial: boolean): { data: ListingInput } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const data: ListingInput = {};

  if (b.title !== undefined || !partial) {
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title || title.length > LISTING_LIMITS.titleMax) {
      return { error: `Title must be 1-${LISTING_LIMITS.titleMax} characters` };
    }
    data.title = title;
  }
  if (b.description !== undefined || !partial) {
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (!description || description.length > LISTING_LIMITS.descriptionMax) {
      return { error: `Description must be 1-${LISTING_LIMITS.descriptionMax} characters` };
    }
    data.description = description;
  }
  if (b.category !== undefined || !partial) {
    if (!isListingCategory(b.category)) return { error: "Pick a valid category" };
    data.category = b.category;
  }
  if (b.priceCents !== undefined || !partial) {
    const price = b.priceCents;
    if (
      typeof price !== "number" ||
      !Number.isInteger(price) ||
      price < LISTING_LIMITS.priceMinCents ||
      price > LISTING_LIMITS.priceMaxCents
    ) {
      return {
        error: `priceCents must be a whole number of cents from ${LISTING_LIMITS.priceMinCents} to ${LISTING_LIMITS.priceMaxCents}`,
      };
    }
    data.priceCents = price;
  }

  if (partial && Object.keys(data).length === 0) {
    return { error: "Nothing to update. Send title, description, category or priceCents" };
  }
  return { data };
}

// Loads a listing for a seller-only action. Sends 404/403 and returns null if
// the listing doesn't exist or the logged-in user isn't its seller.
async function findOwnListing(req: Request, res: Response) {
  const id = req.params.id;
  const listing = isUuid(id)
    ? await prisma.listing.findUnique({ where: { id }, select: { id: true, sellerId: true, status: true, photoUrls: true } })
    : null;
  if (!listing || listing.status === "REMOVED") {
    res.status(404).json({ error: "Listing not found" });
    return null;
  }
  if (listing.sellerId !== req.user!.id) {
    res.status(403).json({ error: "Only the seller can change this listing" });
    return null;
  }
  return listing;
}

function parseCents(value: unknown): number | null | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

// GET /api/listings — active listings, newest first.
// Query: category (one or comma-separated, e.g. TEXTBOOKS,ELECTRONICS),
//        minPriceCents, maxPriceCents (inclusive), limit (1-50, default 24),
//        cursor (nextCursor from the previous page).
listingsRouter.get("/", async (req, res) => {
  const where: Prisma.ListingWhereInput = { status: "ACTIVE" };

  if (req.query.category !== undefined && req.query.category !== "") {
    const raw = typeof req.query.category === "string" ? req.query.category : "";
    const categories = raw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (categories.length === 0 || !categories.every(isListingCategory)) {
      res.status(400).json({ error: "Unknown category" });
      return;
    }
    where.category = { in: categories };
  }

  const min = parseCents(req.query.minPriceCents);
  const max = parseCents(req.query.maxPriceCents);
  if (min === null || max === null) {
    res.status(400).json({ error: "minPriceCents and maxPriceCents must be whole numbers of cents" });
    return;
  }
  if (min !== undefined && max !== undefined && min > max) {
    res.status(400).json({ error: "minPriceCents can't be more than maxPriceCents" });
    return;
  }
  if (min !== undefined || max !== undefined) where.priceCents = { gte: min, lte: max };

  let limit = DEFAULT_PAGE;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      res.status(400).json({ error: `limit must be 1-${MAX_PAGE}` });
      return;
    }
  }

  const cursor = req.query.cursor;
  if (cursor !== undefined && !isUuid(cursor)) {
    res.status(400).json({ error: "Invalid cursor" });
    return;
  }

  // Fetch one extra row to know whether there's another page.
  const rows = await prisma.listing.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: publicListing,
  });
  const listings = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? listings[listings.length - 1].id : null;
  res.json({ listings, nextCursor });
});

// GET /api/listings/mine  (protected) — the logged-in user's listings in every
// status except REMOVED, newest first. Registered before /:id so "mine" isn't read as an id.
listingsRouter.get("/mine", requireAuth, async (req, res) => {
  const listings = await prisma.listing.findMany({
    where: { sellerId: req.user!.id, status: { not: "REMOVED" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MY_LISTINGS_MAX,
    select: publicListing,
  });
  res.json({ listings });
});

// GET /api/listings/:id — one listing. Sold listings stay viewable; removed ones don't.
listingsRouter.get("/:id", async (req, res) => {
  const listing = isUuid(req.params.id) ? await getPublicListing(req.params.id) : null;
  if (!listing || listing.status === "REMOVED") {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  res.json({ listing });
});

// POST /api/listings  (protected)  { title, description, category, priceCents }
// Photos are added afterwards with POST /api/listings/:id/photos.
listingsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = parseListingInput(req.body, false);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { title, description, category, priceCents } = parsed.data;
  const listing = await prisma.listing.create({
    data: { sellerId: req.user!.id, title: title!, description: description!, category: category!, priceCents: priceCents! },
    select: publicListing,
  });
  res.status(201).json({ listing });
});

// PATCH /api/listings/:id  (seller only)  any of { title, description, category, priceCents }
// Only ACTIVE listings can be edited, so a price can't change under a buyer mid-order.
listingsRouter.patch("/:id", requireAuth, async (req, res) => {
  const listing = await findOwnListing(req, res);
  if (!listing) return;
  if (listing.status !== "ACTIVE") {
    res.status(409).json({ error: `Can't edit a ${listing.status.toLowerCase()} listing` });
    return;
  }
  const parsed = parseListingInput(req.body, true);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Conditional on status so a listing that was just sold or reserved isn't edited.
  const { count } = await prisma.listing.updateMany({
    where: { id: listing.id, sellerId: req.user!.id, status: "ACTIVE" },
    data: parsed.data,
  });
  if (count === 0) {
    res.status(409).json({ error: "This listing just changed. Reload and try again" });
    return;
  }
  res.json({ listing: await getPublicListing(listing.id) });
});

// POST /api/listings/:id/sold  (seller only)  — marks the listing SOLD.
// Safe to repeat: an already-sold listing is returned as is.
listingsRouter.post("/:id/sold", requireAuth, async (req, res) => {
  const listing = await findOwnListing(req, res);
  if (!listing) return;
  if (listing.status !== "SOLD") {
    await prisma.listing.updateMany({
      where: { id: listing.id, sellerId: req.user!.id, status: { in: ["ACTIVE", "RESERVED"] } },
      data: { status: "SOLD" },
    });
  }
  const updated = await getPublicListing(listing.id);
  if (updated?.status !== "SOLD") {
    res.status(409).json({ error: "This listing just changed. Reload and try again" });
    return;
  }
  res.json({ listing: updated });
});

const rawImage = express.raw({ type: [...LISTING_LIMITS.photoTypes], limit: LISTING_LIMITS.photoMaxBytes });

// POST /api/listings/:id/photos  (seller only)
// Body: the raw image bytes, one photo per request, with Content-Type image/jpeg,
// image/png or image/webp (max 5 MB, 6 photos per listing).
// From the browser: fetch(url, { method: "POST", headers: { Authorization }, body: file })
listingsRouter.post("/:id/photos", requireAuth, rawImage, async (req, res) => {
  const listing = await findOwnListing(req, res);
  if (!listing) return;
  if (listing.status !== "ACTIVE") {
    res.status(409).json({ error: `Can't add photos to a ${listing.status.toLowerCase()} listing` });
    return;
  }
  if (listing.photoUrls.length >= LISTING_LIMITS.photosMax) {
    res.status(409).json({ error: `A listing can have at most ${LISTING_LIMITS.photosMax} photos` });
    return;
  }

  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(415).json({ error: "Send the photo as the request body with Content-Type image/jpeg, image/png or image/webp" });
    return;
  }
  const image = sniffImage(body);
  if (!image) {
    res.status(415).json({ error: "That file isn't a JPEG, PNG or WebP image" });
    return;
  }

  const storage = getStorageConfig();
  if (!storage) {
    res.status(503).json({ error: "Photo uploads aren't configured on this server" });
    return;
  }

  const path = `listings/${listing.id}/${randomUUID()}.${image.ext}`;
  let url: string;
  try {
    url = await uploadObject(storage, path, body, image.type);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Couldn't upload the photo. Try again" });
    return;
  }

  // Atomic append, so two uploads at once can't go past the photo limit.
  // photo_urls is NULL (not '{}') on listings Prisma created without photos.
  const appended = await prisma.$executeRaw`
    UPDATE listings
    SET photo_urls = array_append(photo_urls, ${url}), updated_at = now()
    WHERE id = ${listing.id}::uuid
      AND seller_id = ${req.user!.id}::uuid
      AND status = 'ACTIVE'
      AND cardinality(coalesce(photo_urls, '{}')) < ${LISTING_LIMITS.photosMax}`;
  if (appended === 0) {
    await deleteObject(storage, path).catch((err) => console.error(err));
    res.status(409).json({ error: `This listing changed or already has ${LISTING_LIMITS.photosMax} photos` });
    return;
  }
  res.status(201).json({ listing: await getPublicListing(listing.id) });
});

// DELETE /api/listings/:id/photos/:photo  (seller only)
// :photo is the last part of the photo URL, e.g. 3f2c...e1.jpg
listingsRouter.delete("/:id/photos/:photo", requireAuth, async (req, res) => {
  const listing = await findOwnListing(req, res);
  if (!listing) return;
  if (listing.status !== "ACTIVE") {
    res.status(409).json({ error: `Can't change photos on a ${listing.status.toLowerCase()} listing` });
    return;
  }

  const suffix = `/listings/${listing.id}/${req.params.photo}`;
  const url = listing.photoUrls.find((u) => u.endsWith(suffix));
  if (!url) {
    res.status(404).json({ error: "Photo not found on this listing" });
    return;
  }

  await prisma.$executeRaw`
    UPDATE listings
    SET photo_urls = array_remove(photo_urls, ${url}), updated_at = now()
    WHERE id = ${listing.id}::uuid AND seller_id = ${req.user!.id}::uuid`;

  // The listing no longer references it, so a failed delete only leaves an orphaned file.
  const storage = getStorageConfig();
  const path = storage ? pathFromPublicUrl(storage, url) : null;
  if (storage && path) await deleteObject(storage, path).catch((err) => console.error(err));

  res.json({ listing: await getPublicListing(listing.id) });
});
