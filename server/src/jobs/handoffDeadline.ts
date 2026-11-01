import { type Db, prisma } from "../db.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { type PayPalClient, PayPalError } from "../paypal/client.js";
import { StaleOrderError, transition } from "../orders/stateMachine.js";

// Handoff deadline sweeper (see CLAUDE.md "Payment model"): an AUTHORIZED
// order with no QR scan within 72 hours is voided, so the buyer is never
// charged. For each overdue order:
//   1. void the authorization through PayPal (PayPal-Request-Id `<orderId>-void`,
//      so a retry after a timeout is answered with the first result), then
//   2. in ONE DB transaction: AUTHORIZED → VOIDED, listing RESERVED → ACTIVE,
//      escrow_held −amount / buyer_funds +amount, and a notification each for
//      the buyer and the seller.
//
// QR scan + deadline race: a scan checks the deadline before capturing, but
// its capture can still be in flight when the deadline passes. The sweeper
// waits DEADLINE_GRACE_MS past the deadline, and PayPal settles any remaining
// race: whichever of capture and void reaches the authorization second fails.
// If the capture won, the void is refused and the order is left alone.

/** Wait this long after the deadline so an in-flight scan's capture can finish first. */
export const DEADLINE_GRACE_MS = 2 * 60 * 1000;

/** Orders handled per run; the next run picks up the rest. */
export const SWEEP_BATCH_SIZE = 50;

export const ORDER_VOIDED_NOTIFICATION = "ORDER_VOIDED";

// PayPal issues meaning the authorization is already void: nothing left to do at PayPal.
const ALREADY_VOID = new Set(["PREVIOUSLY_VOIDED", "AUTHORIZATION_VOIDED", "AUTHORIZATION_EXPIRED"]);
// PayPal issues meaning the money was captured, so it must not be voided here.
const ALREADY_CAPTURED = new Set(["PREVIOUSLY_CAPTURED", "AUTHORIZATION_ALREADY_CAPTURED"]);

export type VoidOutcome =
  | "voided" // voided at PayPal and recorded
  | "skipped" // not AUTHORIZED / not overdue any more, or another run got there first
  | "captured" // PayPal says it was captured; left for the scan or reconciliation to record
  | "failed"; // PayPal or the DB failed; the next run retries

export type SweepResult = { checked: number } & Record<VoidOutcome, number>;

type OverdueOrder = {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  version: number;
  amountCents: number;
  paypalAuthorizationId: string | null;
};

const overdueOrderSelect = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  version: true,
  amountCents: true,
  paypalAuthorizationId: true,
} as const;

function cutoff(now: Date) {
  return new Date(now.getTime() - DEADLINE_GRACE_MS);
}

/**
 * The DB half of voiding, in the caller's transaction: AUTHORIZED → VOIDED,
 * listing back on sale, escrow returned to the buyer, both sides notified.
 * Throws StaleOrderError (rolling it all back) if the order moved first.
 */
export async function recordVoid(tx: Db, order: OverdueOrder, now: Date) {
  await transition(tx, order.id, "AUTHORIZED", "VOIDED", order.version);

  // The item wasn't handed over, so it's for sale again.
  await tx.listing.updateMany({ where: { id: order.listingId, status: "RESERVED" }, data: { status: "ACTIVE" } });

  await postTransaction(
    tx,
    [
      { account: "escrow_held", amountCents: -order.amountCents },
      { account: "buyer_funds", amountCents: order.amountCents },
    ],
    { kind: "VOID", orderId: order.id, paypalRef: order.paypalAuthorizationId },
  );

  await tx.notification.createMany({
    data: [
      {
        userId: order.buyerId,
        orderId: order.id,
        kind: ORDER_VOIDED_NOTIFICATION,
        message: "Your order was cancelled because the handoff didn't happen within 72 hours. You haven't been charged.",
        createdAt: now,
      },
      {
        userId: order.sellerId,
        orderId: order.id,
        kind: ORDER_VOIDED_NOTIFICATION,
        message: "An order was cancelled because the handoff didn't happen within 72 hours. Your listing is back on sale.",
        createdAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

/** Voids one overdue order. PayPal and recording failures are logged and returned as "failed", not thrown. */
export async function voidOverdueOrder(paypal: PayPalClient, orderId: string, now = new Date()): Promise<VoidOutcome> {
  // Re-read: a scan, a dispute or another run may have moved it since the batch query.
  const order = await prisma.order.findFirst({
    where: { id: orderId, state: "AUTHORIZED", handoffDeadline: { lt: cutoff(now) } },
    select: overdueOrderSelect,
  });
  if (!order) return "skipped";
  if (!order.paypalAuthorizationId) {
    console.error(`Order ${order.id}: AUTHORIZED with no authorization id, can't void`);
    return "failed";
  }

  try {
    await paypal.voidAuthorization({ orderId: order.id, authorizationId: order.paypalAuthorizationId });
  } catch (err) {
    if (!(err instanceof PayPalError)) {
      console.error(`Order ${order.id}: void failed:`, (err as Error).message);
      return "failed";
    }
    const detail = `${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`;
    if (err.status === 422 && err.issue && ALREADY_CAPTURED.has(err.issue)) {
      console.error(`Order ${order.id}: past its deadline but already captured at PayPal; not voiding. ${detail}`);
      return "captured";
    }
    if (!(err.status === 422 && err.issue && ALREADY_VOID.has(err.issue))) {
      console.error(`Order ${order.id}: ${detail}`);
      return "failed";
    }
    // Already void at PayPal (an earlier run, or PayPal expired it): just record it.
  }

  try {
    await prisma.$transaction((tx) => recordVoid(tx, order, now));
  } catch (err) {
    if (err instanceof StaleOrderError) {
      if (err.actual.state === "VOIDED") return "skipped"; // a concurrent run recorded it
      console.error(`Order ${order.id}: voided at PayPal, but the order moved to ${err.actual.state} first`);
      return "failed";
    }
    console.error(`Order ${order.id}: voided at PayPal, but recording it failed:`, (err as Error).message);
    return "failed";
  }
  console.log(`Order ${order.id}: handoff deadline passed, voided`);
  return "voided";
}

/** Finds AUTHORIZED orders past their handoff deadline (plus grace) and voids them, oldest first. */
export async function sweepHandoffDeadlines(
  paypal: PayPalClient,
  { now = new Date(), limit = SWEEP_BATCH_SIZE }: { now?: Date; limit?: number } = {},
): Promise<SweepResult> {
  const overdue = await prisma.order.findMany({
    where: { state: "AUTHORIZED", handoffDeadline: { lt: cutoff(now) } },
    orderBy: { handoffDeadline: "asc" },
    take: limit,
    select: { id: true },
  });

  const result: SweepResult = { checked: overdue.length, voided: 0, skipped: 0, captured: 0, failed: 0 };
  // One at a time: a handful per run, and it keeps PayPal calls well under rate limits.
  for (const { id } of overdue) {
    result[await voidOverdueOrder(paypal, id, now)] += 1;
  }
  return result;
}
