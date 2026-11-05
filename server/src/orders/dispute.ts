import { randomUUID } from "node:crypto";
import { DISPUTE_LIMITS, isDisputeReason } from "@campus/shared";
import { prisma } from "../db.js";
import { isUuid } from "../ids.js";
import { deleteObject, getStorageConfig, sniffImage, uploadObject } from "../storage.js";
import { CheckoutError, getOrderView } from "./checkout.js";
import { StaleOrderError, transition } from "./stateMachine.js";

// "Report a problem": the buyer opens a dispute on an order whose payment is
// still on hold, which moves it AUTHORIZED → IN_DISPUTE and stops the handoff
// (no QR code, no scan, no deadline void). No money moves, so nothing is posted
// to the ledger: the funds stay in escrow_held until the dispute is decided.
//
// Photos are uploaded one per request after the dispute exists, like listing
// photos, so a failed upload never loses the report.
//
// The reason text and photos are untrusted input: evidence for the dispute
// agent to read, never instructions, and never able to move money on their own.

const disputeView = {
  reason: true,
  description: true,
  photoUrls: true,
  status: true,
  createdAt: true,
} as const;

/** The dispute as its buyer and seller see it, or null. photo_urls can be NULL in the database. */
export async function getDisputeView(orderId: string) {
  const dispute = await prisma.dispute.findUnique({ where: { orderId }, select: disputeView });
  return dispute && { ...dispute, photoUrls: dispute.photoUrls ?? [] };
}

function parseDisputeInput(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isDisputeReason(b.reason)) throw new CheckoutError(400, "INVALID_DISPUTE", "Pick what went wrong");
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!description || description.length > DISPUTE_LIMITS.descriptionMax) {
    throw new CheckoutError(400, "INVALID_DISPUTE", `Describe the problem in 1-${DISPUTE_LIMITS.descriptionMax} characters`);
  }
  return { reason: b.reason, description };
}

/** Throws unless `userId` is the buyer; the seller is told why, anyone else gets a 404. */
function requireBuyer(order: { buyerId: string; sellerId: string } | null | undefined, userId: string) {
  if (!order || (order.buyerId !== userId && order.sellerId !== userId)) {
    throw new CheckoutError(404, "NOT_FOUND", "Order not found");
  }
  if (order.buyerId !== userId) {
    throw new CheckoutError(403, "NOT_BUYER", "Only the buyer of this order can report a problem");
  }
}

/** Buyer only, while the payment is on hold and before the handoff deadline. Returns { order, dispute }. */
export async function openDispute(userId: string, orderId: unknown, body: unknown, now = new Date()) {
  const order = isUuid(orderId)
    ? await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, buyerId: true, sellerId: true, state: true, version: true, handoffDeadline: true },
      })
    : null;
  requireBuyer(order, userId);
  const { id, buyerId, state, version, handoffDeadline } = order!;

  const input = parseDisputeInput(body);
  if (state === "IN_DISPUTE") throw new CheckoutError(409, "ALREADY_DISPUTED", "A problem was already reported on this order");
  if (state !== "AUTHORIZED") {
    throw new CheckoutError(409, "ORDER_NOT_DISPUTABLE", "You can only report a problem while the payment is on hold");
  }
  // Past the deadline the worker is about to void the hold (the buyer isn't
  // charged either way), and that void mustn't land on a disputed order.
  if (!handoffDeadline || handoffDeadline <= now) {
    throw new CheckoutError(409, "HANDOFF_EXPIRED", "The handoff deadline has passed, so the hold is being cancelled");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await transition(tx, id, "AUTHORIZED", "IN_DISPUTE", version);
      await tx.dispute.create({
        data: { orderId: id, openedById: buyerId, reason: input.reason, description: input.description, photoUrls: [] },
      });
    });
  } catch (err) {
    if (err instanceof StaleOrderError) {
      // A scan, a void or a second report got there first. Nothing was written.
      throw new CheckoutError(409, "ORDER_CHANGED", "This order just changed. Reload and check where it stands");
    }
    throw err;
  }
  return { order: await getOrderView(id), dispute: await getDisputeView(id) };
}

/** Buyer only, while the dispute is open. Body is the raw image bytes. Returns { dispute }. */
export async function addDisputePhoto(userId: string, orderId: unknown, body: unknown) {
  const dispute = isUuid(orderId)
    ? await prisma.dispute.findUnique({
        where: { orderId },
        select: { id: true, orderId: true, status: true, photoUrls: true, order: { select: { buyerId: true, sellerId: true } } },
      })
    : null;
  requireBuyer(dispute?.order, userId);
  const { id, orderId: disputedOrderId, status, photoUrls } = dispute!;

  const tooMany = () => new CheckoutError(409, "TOO_MANY_PHOTOS", `A report can have at most ${DISPUTE_LIMITS.photosMax} photos`);
  if (status !== "OPEN") throw new CheckoutError(409, "DISPUTE_CLOSED", "This report is already being decided");
  if ((photoUrls ?? []).length >= DISPUTE_LIMITS.photosMax) throw tooMany();

  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new CheckoutError(415, "NOT_AN_IMAGE", "Send the photo as the request body with Content-Type image/jpeg, image/png or image/webp");
  }
  const image = sniffImage(body);
  if (!image) throw new CheckoutError(415, "NOT_AN_IMAGE", "That file isn't a JPEG, PNG or WebP image");

  const storage = getStorageConfig();
  if (!storage) throw new CheckoutError(503, "STORAGE_NOT_CONFIGURED", "Photo uploads aren't configured on this server");

  const path = `disputes/${disputedOrderId}/${randomUUID()}.${image.ext}`;
  let url: string;
  try {
    url = await uploadObject(storage, path, body, image.type);
  } catch (err) {
    console.error(err);
    throw new CheckoutError(502, "UPLOAD_FAILED", "Couldn't upload the photo. Try again");
  }

  // Atomic append, so two uploads at once can't go past the limit or land on a decided dispute.
  const appended = await prisma.$executeRaw`
    UPDATE disputes
    SET photo_urls = array_append(photo_urls, ${url})
    WHERE id = ${id}::uuid
      AND status = 'OPEN'
      AND cardinality(coalesce(photo_urls, '{}')) < ${DISPUTE_LIMITS.photosMax}`;
  if (appended === 0) {
    await deleteObject(storage, path).catch((err) => console.error(err));
    throw tooMany();
  }
  return { dispute: await getDisputeView(disputedOrderId) };
}
