import { HONOR_PERIOD_MS } from "@campus/shared";
import { prisma } from "../db.js";
import { type PayPalClient, PayPalError } from "../paypal/client.js";
import { type OverdueOrder, voidAndRecord, voidOverdueOrder } from "./handoffDeadline.js";

// Reauthorize-or-void (see CLAUDE.md "PayPal limits"). A PayPal authorization
// has a 3-day honor period (capture inside it, or the capture may fail) and
// expires after 29 days. Orders still holding an authorization after the
// honor period are normally handled by the 72-hour deadline job; this job
// covers the ones that outlive it, e.g. an order sitting IN_DISPUTE.
//
// For each AUTHORIZED / IN_DISPUTE order, every few minutes:
//   - within EXPIRY_MARGIN_MS of the 29-day expiry: it can't be kept alive.
//     AUTHORIZED → void and notify both sides. IN_DISPUTE can't be voided by
//     the state machine, so both sides (and the logs) are told it needs
//     resolving now; if it isn't, PayPal voids the hold itself.
//   - honor period over and the handoff still pending (AUTHORIZED before its
//     deadline, or IN_DISPUTE awaiting a decision): reauthorize. PayPal returns
//     a NEW authorization id with a new honor period; it's saved to the order
//     so the capture uses it. Reauthorizing is only allowed after the honor
//     period, hence a small margin after it.
//   - AUTHORIZED past its handoff deadline: void and notify (the deadline job's path).
//   - a reauthorization PayPal refuses (e.g. funds no longer available): void
//     and notify if AUTHORIZED; flag if IN_DISPUTE.
//
// No money moves in a reauthorization, so there's no ledger entry. The
// request id is keyed by the authorization being replaced, so a retry after a
// timeout gets the same new authorization rather than a second one.

/** Give up on keeping the hold alive this long before PayPal's 29-day expiry. */
export const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Reauthorize this long after the honor period ends (PayPal refuses inside it; allow for clock skew). */
export const REAUTHORIZE_AFTER_HONOR_MS = 5 * 60 * 1000;
/** If PayPal still says it's too soon, try again this much later. */
export const TOO_SOON_RETRY_MS = 60 * 60 * 1000;
export const EXPIRY_BATCH_SIZE = 20;

export const AUTHORIZATION_EXPIRING_NOTIFICATION = "AUTHORIZATION_EXPIRING";

export type ExpiryOutcome =
  | "reauthorized" // new authorization saved, new honor period
  | "voided" // voided at PayPal and recorded, both sides notified
  | "review" // IN_DISPUTE with a hold that can't be kept: both sides notified, logged for an admin
  | "waiting" // PayPal says it's too soon to reauthorize; retried later
  | "captured" // PayPal says it was captured; left alone
  | "skipped" // nothing due any more, or another run got there first
  | "failed"; // PayPal or the DB failed; the next run tries again

export type ExpirySweepResult = { checked: number } & Record<ExpiryOutcome, number>;

const VOID_MESSAGES = {
  expiring: {
    buyer: "Your order was cancelled because PayPal's payment hold was about to expire. You haven't been charged.",
    seller: "An order was cancelled because the buyer's payment hold was about to expire. Your listing is back on sale.",
  },
  refused: {
    buyer: "Your order was cancelled because PayPal couldn't renew the payment hold. You haven't been charged.",
    seller: "An order was cancelled because PayPal couldn't renew the buyer's payment hold. Your listing is back on sale.",
  },
};

const DISPUTE_HOLD_MESSAGES = {
  buyer:
    "Your dispute is still open and the payment hold is about to expire. If it isn't resolved first, PayPal releases the hold and you won't be charged.",
  seller:
    "A disputed order's payment hold is about to expire. If the dispute isn't resolved first, PayPal releases the hold and the sale won't be paid.",
};

const orderSelect = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  state: true,
  version: true,
  amountCents: true,
  currency: true,
  paypalAuthorizationId: true,
  handoffDeadline: true,
  honorPeriodEndsAt: true,
  authorizationExpiresAt: true,
} as const;

type ExpiryOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function loadOrder(id: string) {
  return prisma.order.findFirst({
    where: { id, state: { in: ["AUTHORIZED", "IN_DISPUTE"] }, paypalAuthorizationId: { not: null } },
    select: orderSelect,
  });
}

function asOverdue(order: ExpiryOrder): OverdueOrder {
  return { ...order, paypalAuthorizationId: order.paypalAuthorizationId };
}

/** Tells both sides a disputed order's hold can't be kept (once: notifications are unique per kind). */
async function flagDispute(order: ExpiryOrder, why: string): Promise<ExpiryOutcome> {
  const { count } = await prisma.notification.createMany({
    data: [
      { userId: order.buyerId, orderId: order.id, kind: AUTHORIZATION_EXPIRING_NOTIFICATION, message: DISPUTE_HOLD_MESSAGES.buyer },
      { userId: order.sellerId, orderId: order.id, kind: AUTHORIZATION_EXPIRING_NOTIFICATION, message: DISPUTE_HOLD_MESSAGES.seller },
    ],
    skipDuplicates: true,
  });
  if (count > 0) console.error(`order ${order.id}: needs review: IN_DISPUTE and ${why}; resolve the dispute before PayPal voids the hold`);
  return "review";
}

async function reauthorize(paypal: PayPalClient, order: ExpiryOrder, now: Date): Promise<ExpiryOutcome> {
  const oldId = order.paypalAuthorizationId!;
  let renewed;
  try {
    renewed = await paypal.reauthorize({ orderId: order.id, authorizationId: oldId });
  } catch (err) {
    if (!(err instanceof PayPalError)) {
      console.error(`order ${order.id}: reauthorize failed:`, (err as Error).message);
      return "failed";
    }
    const detail = `${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`;
    if (err.status === 422 && err.issue === "REAUTHORIZATION_TOO_SOON") {
      await prisma.order.updateMany({
        where: { id: order.id, paypalAuthorizationId: oldId },
        data: { honorPeriodEndsAt: new Date(now.getTime() + TOO_SOON_RETRY_MS) },
      });
      return "waiting";
    }
    if (err.retryable) {
      console.error(`order ${order.id}: reauthorize outcome unknown, will retry: ${detail}`);
      return "failed";
    }
    console.error(`order ${order.id}: PayPal refused to reauthorize: ${detail}`);
    if (order.state === "IN_DISPUTE") return flagDispute(order, `PayPal refused to reauthorize (${err.issue ?? err.status})`);
    return voidAndRecord(paypal, asOverdue(order), now, { notify: VOID_MESSAGES.refused });
  }

  if (renewed.status !== "CREATED" || renewed.amountCents !== order.amountCents || renewed.currency !== order.currency) {
    // Not usable as is; the old authorization is untouched in our records. An admin decides.
    console.error(
      `order ${order.id}: needs review: reauthorization ${renewed.authorizationId} is ${renewed.status} for ${renewed.amountCents} ${renewed.currency}`,
    );
    return "failed";
  }

  // Never past PayPal's 29-day limit: the new honor period can't outlive the authorization.
  const honorEnds = new Date(now.getTime() + HONOR_PERIOD_MS);
  const expiresAt = order.authorizationExpiresAt;
  const { count } = await prisma.order.updateMany({
    // Only if nothing changed meanwhile (e.g. a capture against the old id).
    where: { id: order.id, paypalAuthorizationId: oldId, state: { in: ["AUTHORIZED", "IN_DISPUTE"] } },
    data: {
      paypalAuthorizationId: renewed.authorizationId,
      honorPeriodEndsAt: expiresAt && expiresAt < honorEnds ? expiresAt : honorEnds,
      ...(renewed.expiresAt && (!expiresAt || renewed.expiresAt < expiresAt) ? { authorizationExpiresAt: renewed.expiresAt } : {}),
    },
  });
  if (count === 0) {
    console.error(
      `order ${order.id}: needs review: reauthorized as ${renewed.authorizationId}, but the order changed meanwhile; void that authorization if it's unused`,
    );
    return "skipped";
  }
  console.log(`order ${order.id}: reauthorized ${oldId} → ${renewed.authorizationId}`);
  return "reauthorized";
}

/** Decides and does what one order's authorization needs. Failures are logged and returned, not thrown. */
export async function handleExpiringAuthorization(paypal: PayPalClient, orderId: string, now = new Date()): Promise<ExpiryOutcome> {
  const order = await loadOrder(orderId);
  if (!order) return "skipped";
  try {
    const nearExpiry = order.authorizationExpiresAt !== null && order.authorizationExpiresAt.getTime() - EXPIRY_MARGIN_MS <= now.getTime();
    const honorOver = order.honorPeriodEndsAt !== null && order.honorPeriodEndsAt.getTime() + REAUTHORIZE_AFTER_HONOR_MS <= now.getTime();
    const handoffPending =
      order.state === "IN_DISPUTE" || (order.handoffDeadline !== null && order.handoffDeadline.getTime() > now.getTime());

    if (order.state === "AUTHORIZED" && !handoffPending) {
      // Past its handoff deadline: void it the deadline job's way (with its grace period and message).
      return await voidOverdueOrder(paypal, order.id, now);
    }
    const expired = order.authorizationExpiresAt !== null && order.authorizationExpiresAt.getTime() <= now.getTime();

    if (nearExpiry && order.state === "AUTHORIZED") {
      const outcome = await voidAndRecord(paypal, asOverdue(order), now, { notify: VOID_MESSAGES.expiring });
      if (outcome === "voided") console.log(`order ${order.id}: authorization about to expire, voided`);
      return outcome;
    }
    if (nearExpiry) {
      // IN_DISPUTE: tell both sides, but keep it capturable until the end in case it's released to the seller.
      const flagged = await flagDispute(order, "the authorization expires within a day");
      return honorOver && !expired ? await reauthorize(paypal, order, now) : flagged;
    }
    if (honorOver) return await reauthorize(paypal, order, now);
    return "skipped";
  } catch (err) {
    console.error(`order ${order.id}: authorization expiry step failed:`, (err as Error).message);
    return "failed";
  }
}

/** Finds authorizations past their honor period or near their 29-day expiry and handles them, oldest first. */
export async function sweepExpiringAuthorizations(
  paypal: PayPalClient,
  { now = new Date(), limit = EXPIRY_BATCH_SIZE }: { now?: Date; limit?: number } = {},
): Promise<ExpirySweepResult> {
  const due = await prisma.order.findMany({
    where: {
      paypalAuthorizationId: { not: null },
      OR: [
        {
          state: { in: ["AUTHORIZED", "IN_DISPUTE"] },
          honorPeriodEndsAt: { lte: new Date(now.getTime() - REAUTHORIZE_AFTER_HONOR_MS) },
          // Past PayPal's expiry there's nothing left to reauthorize.
          OR: [{ authorizationExpiresAt: null }, { authorizationExpiresAt: { gt: now } }],
        },
        { state: "AUTHORIZED", authorizationExpiresAt: { lte: new Date(now.getTime() + EXPIRY_MARGIN_MS) } },
        {
          // Disputes near expiry, until both sides have been told.
          state: "IN_DISPUTE",
          authorizationExpiresAt: { lte: new Date(now.getTime() + EXPIRY_MARGIN_MS) },
          notifications: { none: { kind: AUTHORIZATION_EXPIRING_NOTIFICATION } },
        },
      ],
    },
    orderBy: { authorizedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const result: ExpirySweepResult = {
    checked: due.length,
    reauthorized: 0,
    voided: 0,
    review: 0,
    waiting: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
  };
  for (const { id } of due) result[await handleExpiringAuthorization(paypal, id, now)] += 1;
  return result;
}
