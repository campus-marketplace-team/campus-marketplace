import { AUTHORIZATION_VALID_DAYS, HANDOFF_WINDOW_MS, HONOR_PERIOD_MS, platformFeeCents } from "@campus/shared";
import { type Db, prisma } from "../db.js";
import { isUuid } from "../ids.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { type Authorization, type PayPalClient, PayPalError } from "../paypal/client.js";
import { StaleOrderError, transition } from "./stateMachine.js";

// Checkout (see CLAUDE.md "Payment model"):
//   1. startCheckout: our order (CREATED) + a PayPal order with intent AUTHORIZE.
//   2. The buyer approves in the PayPal popup.
//   3. authorizeCheckout: PayPal authorizes (funds held, not taken), then ONE DB
//      transaction reserves the listing, moves the order to AUTHORIZED with a
//      72-hour handoff deadline, and posts escrow_held / buyer_funds.
//
// Both steps are safe to repeat: PayPal calls reuse the order's request ids,
// and an order that's already AUTHORIZED is returned as is.

/** A refusal the route sends to the client as `{ error, code }` with this HTTP status. */
export class CheckoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Thrown inside the DB transaction when someone else reserved the listing first. */
class ListingUnavailableError extends Error {}

/** The order fields the API returns to the client (also used by the QR handoff). */
export const orderView = {
  id: true,
  listingId: true,
  state: true,
  version: true,
  amountCents: true,
  currency: true,
  paypalOrderId: true,
  authorizedAt: true,
  handoffDeadline: true,
  capturedAt: true,
} as const;

/** Turns a PayPalError into a CheckoutError (503 if retryable, else 502); rethrows anything else. */
export function paypalFailure(err: unknown): never {
  if (!(err instanceof PayPalError)) throw err;
  console.error(`${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`);
  if (err.retryable) {
    throw new CheckoutError(503, "PAYPAL_UNAVAILABLE", "PayPal didn't respond. Please try again.");
  }
  throw new CheckoutError(502, "PAYPAL_ERROR", "PayPal couldn't process this payment. Please try again later.");
}

/** Voids an authorization we can't use. Failures are logged; the 72-hour sweeper is the backstop. */
async function voidQuietly(paypal: PayPalClient, orderId: string, authorizationId: string) {
  try {
    await paypal.voidAuthorization({ orderId, authorizationId });
  } catch (err) {
    console.error(`Could not void authorization ${authorizationId} for order ${orderId}:`, (err as Error).message);
  }
}

/**
 * Creates (or reuses) the buyer's CREATED order for this listing and its
 * PayPal order. Returns the PayPal order id for the Buttons' createOrder.
 */
export async function startCheckout(paypal: PayPalClient, buyerId: string, listingId: unknown) {
  const listing = isUuid(listingId)
    ? await prisma.listing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true, status: true, priceCents: true, currency: true },
      })
    : null;
  if (!listing || listing.status === "REMOVED") throw new CheckoutError(404, "NOT_FOUND", "Listing not found");
  if (listing.sellerId === buyerId) throw new CheckoutError(403, "OWN_LISTING", "You can't buy your own listing");
  if (listing.status !== "ACTIVE") {
    throw new CheckoutError(409, "LISTING_UNAVAILABLE", "This listing isn't available anymore");
  }

  // Reuse an unpaid order at the current price, so clicking Pay twice doesn't
  // pile up orders. A price change since then gets a fresh order (and a fresh
  // PayPal request id, so PayPal can't answer with the old amount).
  const existing = await prisma.order.findFirst({
    where: {
      listingId: listing.id,
      buyerId,
      state: "CREATED",
      amountCents: listing.priceCents,
      currency: listing.currency,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, paypalOrderId: true },
  });
  const order =
    existing ??
    (await prisma.order.create({
      data: {
        listingId: listing.id,
        buyerId,
        sellerId: listing.sellerId,
        amountCents: listing.priceCents,
        platformFeeCents: platformFeeCents(listing.priceCents),
        currency: listing.currency,
      },
      select: { id: true, paypalOrderId: true },
    }));
  if (order.paypalOrderId) return { orderId: order.id, paypalOrderId: order.paypalOrderId };

  const created = await paypal
    .createOrder({ orderId: order.id, amountCents: listing.priceCents, currency: listing.currency })
    .catch(paypalFailure);
  // Same request id on a retry means the same PayPal order, so this only ever sets one value.
  await prisma.order.updateMany({
    where: { id: order.id, paypalOrderId: null },
    data: { paypalOrderId: created.paypalOrderId },
  });
  return { orderId: order.id, paypalOrderId: created.paypalOrderId };
}

/**
 * The DB half of authorizing, in the caller's transaction: reserve the
 * listing, CREATED → AUTHORIZED with the handoff deadline, and post
 * escrow_held +amount / buyer_funds −amount. Throws ListingUnavailableError
 * or StaleOrderError, which roll the whole transaction back.
 */
export async function recordAuthorization(
  tx: Db,
  order: { id: string; listingId: string; version: number; amountCents: number },
  authorization: Authorization,
  now: Date,
) {
  const reserved = await tx.listing.updateMany({
    where: { id: order.listingId, status: "ACTIVE" },
    data: { status: "RESERVED" },
  });
  if (reserved.count === 0) throw new ListingUnavailableError();

  await transition(tx, order.id, "CREATED", "AUTHORIZED", order.version, {
    paypalAuthorizationId: authorization.authorizationId,
    authorizedAt: now,
    handoffDeadline: new Date(now.getTime() + HANDOFF_WINDOW_MS),
    honorPeriodEndsAt: new Date(now.getTime() + HONOR_PERIOD_MS),
    authorizationExpiresAt:
      authorization.expiresAt ?? new Date(now.getTime() + AUTHORIZATION_VALID_DAYS * 24 * 60 * 60 * 1000),
  });

  await postTransaction(
    tx,
    [
      { account: "escrow_held", amountCents: order.amountCents },
      { account: "buyer_funds", amountCents: -order.amountCents },
    ],
    { kind: "AUTHORIZE", orderId: order.id, paypalRef: authorization.authorizationId },
  );
}

/** Called after the buyer approves in PayPal. Returns the AUTHORIZED order. */
export async function authorizeCheckout(paypal: PayPalClient, buyerId: string, orderId: unknown) {
  const order = isUuid(orderId)
    ? await prisma.order.findUnique({
        where: { id: orderId },
        select: { ...orderView, buyerId: true, paypalAuthorizationId: true },
      })
    : null;
  // Someone else's order looks the same as a missing one.
  if (!order || order.buyerId !== buyerId) throw new CheckoutError(404, "NOT_FOUND", "Order not found");
  if (order.state === "AUTHORIZED") return getOrderView(order.id);
  if (order.state !== "CREATED") {
    throw new CheckoutError(409, "ORDER_CLOSED", "This order can't be paid anymore");
  }
  if (!order.paypalOrderId) {
    throw new CheckoutError(409, "NOT_STARTED", "Start checkout with PayPal first");
  }

  let authorization: Authorization;
  try {
    authorization = await paypal.authorizeOrder({ orderId: order.id, paypalOrderId: order.paypalOrderId });
  } catch (err) {
    if (err instanceof PayPalError && err.status === 422) {
      if (err.issue === "ORDER_NOT_APPROVED") {
        throw new CheckoutError(409, "NOT_APPROVED", "Approve the payment in PayPal first");
      }
      if (err.issue === "INSTRUMENT_DECLINED") {
        throw new CheckoutError(402, "PAYMENT_DECLINED", "PayPal declined that payment method. Please try another one.");
      }
    }
    paypalFailure(err);
  }

  // CREATED is PayPal's status for a successful authorization.
  if (authorization.status !== "CREATED") {
    console.error(`Order ${order.id}: authorization ${authorization.authorizationId} is ${authorization.status}`);
    throw new CheckoutError(402, "NOT_AUTHORIZED", "PayPal didn't authorize this payment. Please try again.");
  }
  if (authorization.amountCents !== order.amountCents || authorization.currency !== order.currency) {
    console.error(
      `Order ${order.id}: PayPal authorized ${authorization.amountCents} ${authorization.currency}, expected ${order.amountCents} ${order.currency}`,
    );
    await voidQuietly(paypal, order.id, authorization.authorizationId);
    throw new CheckoutError(502, "AMOUNT_MISMATCH", "PayPal authorized the wrong amount, so the payment was cancelled");
  }

  try {
    await prisma.$transaction((tx) => recordAuthorization(tx, order, authorization, new Date()));
  } catch (err) {
    if (err instanceof ListingUnavailableError) {
      await voidQuietly(paypal, order.id, authorization.authorizationId);
      throw new CheckoutError(409, "LISTING_UNAVAILABLE", "Someone else just bought this. You haven't been charged.");
    }
    if (err instanceof StaleOrderError) {
      // A concurrent request (e.g. a double click) got there first with the same authorization.
      const current = await prisma.order.findUnique({
        where: { id: order.id },
        select: { state: true, paypalAuthorizationId: true },
      });
      if (current?.state === "AUTHORIZED" && current.paypalAuthorizationId === authorization.authorizationId) {
        return getOrderView(order.id);
      }
      throw new CheckoutError(409, "ORDER_CLOSED", "This order can't be paid anymore");
    }
    throw err;
  }
  return getOrderView(order.id);
}

export async function getOrderView(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id }, select: orderView });
}
