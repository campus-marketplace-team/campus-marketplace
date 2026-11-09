import { randomBytes } from "node:crypto";
import { HANDOFF_TOKEN_TTL_SECONDS } from "@campus/shared";
import { signHandoffToken, verifyHandoffToken } from "../auth/tokens.js";
import { type Db, prisma } from "../db.js";
import type { QrScanResult } from "../generated/prisma/enums.js";
import { isUuid } from "../ids.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { type Capture, type PayPalClient, PayPalError } from "../paypal/client.js";
import { CheckoutError, getOrderView, paypalFailure } from "./checkout.js";
import { StaleOrderError, transition } from "./stateMachine.js";

// QR handoff (see CLAUDE.md "QR handoff"):
//   1. issueHandoffToken: the seller's page asks for a signed token bound to
//      order ID, seller ID and a single-use nonce (a qr_tokens row), valid 5 min.
//   2. redeemHandoffToken: the buyer scans it while logged in. We check the
//      signature, that the scanner is the order's buyer, the nonce is unused and
//      not expired, then mark the nonce used, capture through PayPal, and in ONE
//      DB transaction move the order to CAPTURED, mark the listing SOLD and post
//      escrow_held / seller_payable / platform_fees.
//
// Every scan attempt is written to qr_scans: REJECTED if refused before the
// nonce was used, FAILED if it was used but the capture didn't complete,
// ACCEPTED once captured.
//
// The nonce is used up before PayPal is called, so one token can never cause
// two captures. If the capture then fails, the seller's page shows a fresh
// code. Every capture of an order sends PayPal-Request-Id `<orderId>-capture`,
// so a retry is answered with the first capture instead of charging twice.

const MAX_TOKEN_LENGTH = 2048;
const MAX_USER_AGENT_LENGTH = 512;

// PayPal issues meaning the authorization can no longer be captured.
const AUTHORIZATION_GONE = new Set(["AUTHORIZATION_VOIDED", "AUTHORIZATION_EXPIRED", "PREVIOUSLY_VOIDED"]);

export type ScanContext = { ip?: string | null; userAgent?: string | null };

/** What the scan log knows so far about the token being redeemed. */
type ScanProgress = { orderId: string | null; qrTokenId: string | null; nonceUsed: boolean };

/** Seller only, while the order is AUTHORIZED and before the handoff deadline. */
export async function issueHandoffToken(sellerId: string, orderId: unknown, now = new Date()) {
  const order = isUuid(orderId)
    ? await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, sellerId: true, state: true, handoffDeadline: true },
      })
    : null;
  // Someone else's order looks the same as a missing one.
  if (!order || order.sellerId !== sellerId) throw new CheckoutError(404, "NOT_FOUND", "Order not found");
  if (order.state !== "AUTHORIZED") {
    throw new CheckoutError(409, "ORDER_NOT_AUTHORIZED", "This order isn't waiting for a handoff");
  }
  if (!order.handoffDeadline || order.handoffDeadline <= now) {
    throw new CheckoutError(409, "HANDOFF_EXPIRED", "The handoff deadline has passed");
  }

  const nonce = randomBytes(18).toString("base64url");
  const expiresAt = new Date(now.getTime() + HANDOFF_TOKEN_TTL_SECONDS * 1000);
  await prisma.qrToken.create({ data: { orderId: order.id, sellerId, nonce, expiresAt } });
  const token = await signHandoffToken({ orderId: order.id, sellerId, nonce }, expiresAt);
  return { token, expiresAt };
}

/**
 * The DB half of capturing, in the caller's transaction: AUTHORIZED →
 * CAPTURED, listing RESERVED → SOLD, and escrow_held −amount / seller_payable
 * +(amount − fee) / platform_fees +fee. Throws StaleOrderError (rolling it all
 * back) if the order moved first.
 */
export async function recordCapture(
  tx: Db,
  order: { id: string; listingId: string; version: number; amountCents: number; platformFeeCents: number },
  capture: Capture,
  now: Date,
) {
  await transition(tx, order.id, "AUTHORIZED", "CAPTURED", order.version, {
    paypalCaptureId: capture.captureId,
    capturedAt: now,
  });

  await tx.listing.updateMany({ where: { id: order.listingId, status: "RESERVED" }, data: { status: "SOLD" } });

  const fee = order.platformFeeCents;
  await postTransaction(
    tx,
    [
      { account: "escrow_held", amountCents: -order.amountCents },
      { account: "seller_payable", amountCents: order.amountCents - fee },
      // A tiny sale can round to no fee, and the ledger refuses zero entries.
      ...(fee > 0 ? [{ account: "platform_fees" as const, amountCents: fee }] : []),
    ],
    { kind: "CAPTURE", orderId: order.id, paypalRef: capture.captureId },
  );
}

/** Captures the order's authorization in full (request id `<orderId>-capture`). PayPal refusals become CheckoutErrors. */
export async function capture(
  paypal: PayPalClient,
  order: { id: string; paypalAuthorizationId: string | null; amountCents: number; currency: string },
): Promise<Capture> {
  if (!order.paypalAuthorizationId) {
    throw new CheckoutError(409, "NOT_AUTHORIZED", "This order has no payment hold to capture");
  }
  try {
    return await paypal.captureAuthorization({
      orderId: order.id,
      authorizationId: order.paypalAuthorizationId,
      amountCents: order.amountCents,
      currency: order.currency,
    });
  } catch (err) {
    if (err instanceof PayPalError && err.status === 422 && err.issue && AUTHORIZATION_GONE.has(err.issue)) {
      console.error(`Order ${order.id}: capture refused, ${err.issue}`);
      throw new CheckoutError(
        409,
        "AUTHORIZATION_GONE",
        "The payment hold has expired or was cancelled. The buyer hasn't been charged.",
      );
    }
    paypalFailure(err);
  }
}

async function logScan(scannerId: string, progress: ScanProgress, result: QrScanResult, reason: string, context: ScanContext) {
  try {
    await prisma.qrScan.create({
      data: {
        scannerId,
        orderId: progress.orderId,
        qrTokenId: progress.qrTokenId,
        result,
        reason,
        ip: context.ip ?? null,
        userAgent: context.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      },
    });
  } catch (err) {
    // Never turn a completed capture into an error because the log write failed.
    console.error(`Could not log QR scan (${result} ${reason}) for order ${progress.orderId}:`, (err as Error).message);
  }
}

/** Buyer scans the seller's QR code. Returns the CAPTURED order. */
export async function redeemHandoffToken(
  paypal: PayPalClient,
  buyerId: string,
  token: unknown,
  context: ScanContext = {},
  now = new Date(),
) {
  const progress: ScanProgress = { orderId: null, qrTokenId: null, nonceUsed: false };
  try {
    const order = await redeem(paypal, buyerId, token, context, now, progress);
    await logScan(buyerId, progress, "ACCEPTED", "CAPTURED", context);
    return order;
  } catch (err) {
    const result = err instanceof CheckoutError && !progress.nonceUsed ? "REJECTED" : "FAILED";
    await logScan(buyerId, progress, result, err instanceof CheckoutError ? err.code : "INTERNAL_ERROR", context);
    throw err;
  }
}

async function redeem(
  paypal: PayPalClient,
  buyerId: string,
  token: unknown,
  context: ScanContext,
  now: Date,
  progress: ScanProgress,
) {
  const invalid = () => new CheckoutError(400, "INVALID_TOKEN", "That isn't a valid handoff code");
  const usedUp = () => new CheckoutError(409, "ALREADY_USED", "This code was already used. Ask the seller to show a new one.");
  if (typeof token !== "string" || !token.trim() || token.length > MAX_TOKEN_LENGTH) throw invalid();

  // A JWT has no whitespace; a pasted copy can pick up spaces or line breaks.
  const verified = await verifyHandoffToken(token.replace(/\s+/g, ""));
  if (!verified) throw invalid();
  const { claims } = verified;

  const qrToken = await prisma.qrToken.findUnique({
    where: { nonce: claims.nonce },
    select: { id: true, orderId: true, sellerId: true, expiresAt: true, usedAt: true },
  });
  if (!qrToken || qrToken.orderId !== claims.orderId || qrToken.sellerId !== claims.sellerId) throw invalid();
  progress.orderId = qrToken.orderId;
  progress.qrTokenId = qrToken.id;

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: qrToken.orderId },
    select: {
      id: true,
      listingId: true,
      buyerId: true,
      sellerId: true,
      state: true,
      version: true,
      amountCents: true,
      platformFeeCents: true,
      currency: true,
      paypalAuthorizationId: true,
      handoffDeadline: true,
    },
  });
  if (order.buyerId !== buyerId) {
    throw new CheckoutError(403, "NOT_BUYER", "Only the buyer of this order can scan its handoff code");
  }
  if (order.sellerId !== qrToken.sellerId) throw invalid();
  if (qrToken.usedAt) throw usedUp();
  if (verified.status === "expired" || qrToken.expiresAt <= now) {
    throw new CheckoutError(410, "EXPIRED", "This code has expired. Ask the seller to show a new one.");
  }
  if (order.state !== "AUTHORIZED") {
    throw new CheckoutError(409, "ORDER_NOT_AUTHORIZED", "This order isn't waiting for a handoff");
  }
  if (!order.handoffDeadline || order.handoffDeadline <= now) {
    throw new CheckoutError(409, "HANDOFF_EXPIRED", "The handoff deadline has passed");
  }

  // Use up the nonce. The conditions make this atomic: of two concurrent scans, one wins.
  const used = await prisma.qrToken.updateMany({
    where: { id: qrToken.id, usedAt: null, expiresAt: { gt: now } },
    data: {
      usedAt: now,
      usedById: buyerId,
      scanMeta: { ip: context.ip ?? null, userAgent: context.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null },
    },
  });
  if (used.count === 0) throw usedUp();
  progress.nonceUsed = true;

  const captured = await capture(paypal, order);
  if (captured.status !== "COMPLETED" && captured.status !== "PENDING") {
    console.error(`Order ${order.id}: capture ${captured.captureId} is ${captured.status}`);
    throw new CheckoutError(402, "CAPTURE_DECLINED", "PayPal couldn't take the payment. The buyer hasn't been charged.");
  }
  if (captured.amountCents !== order.amountCents || captured.currency !== order.currency) {
    // Money has moved, so this can't be undone here; reconciliation and an admin take over.
    console.error(
      `Order ${order.id}: PayPal captured ${captured.amountCents} ${captured.currency} (capture ${captured.captureId}), expected ${order.amountCents} ${order.currency}`,
    );
    throw new CheckoutError(502, "CAPTURE_MISMATCH", "PayPal captured an unexpected amount. We'll review this order.");
  }

  try {
    await prisma.$transaction((tx) => recordCapture(tx, order, captured, now));
  } catch (err) {
    if (err instanceof StaleOrderError) {
      // A concurrent scan (of another code) recorded the same capture first.
      const current = await prisma.order.findUnique({
        where: { id: order.id },
        select: { state: true, paypalCaptureId: true },
      });
      if (current?.state === "CAPTURED" && current.paypalCaptureId === captured.captureId) {
        return getOrderView(order.id);
      }
      console.error(`Order ${order.id}: captured ${captured.captureId} but the order is now ${current?.state}`);
      throw new CheckoutError(409, "ORDER_CHANGED", "This order changed during the scan. We'll review it.");
    }
    throw err;
  }
  return getOrderView(order.id);
}
