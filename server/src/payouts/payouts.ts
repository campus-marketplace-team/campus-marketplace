import { type Db, prisma } from "../db.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { StaleOrderError, transition } from "../orders/stateMachine.js";
import { type PayPalClient, PayPalError } from "../paypal/client.js";

// Seller payouts (see CLAUDE.md "Payment model" and "Payouts"). After capture
// the seller gets amount − platform fee through PayPal Payouts:
//
//   CAPTURED ──send──▶ PAYOUT_PENDING ──SUCCESS──▶ PAID_OUT (seller_payable → paid_out)
//                         │    ▲
//         FAILED/BLOCKED/ │    │ re-send (next attempt, after a backoff)
//        DENIED/RETURNED  ▼    │
//                       PAYOUT_RETRY   (stays here after MAX_PAYOUT_ATTEMPTS: admin)
//
// sweepPayouts (worker, every minute) does the sending and, when no webhook
// has arrived, checks the payout's status at PayPal. The webhook handlers
// (src/webhooks/handlers.ts) record the same outcomes through the same
// recordPayoutSucceeded / recordPayoutFailed, whichever comes first.
//
// Paying exactly once:
//   - The order moves to PAYOUT_PENDING (attempt n recorded) BEFORE PayPal is
//     called, so a crash can't lose track of a payout that went out.
//   - Attempt n always sends sender_batch_id payout-<order>-<n> and
//     PayPal-Request-Id <order>-payout-<n>. If the outcome is unknown (timeout,
//     5xx), the same attempt is re-sent, and PayPal answers with the first result.
//   - Only a payout PayPal says definitely failed moves to PAYOUT_RETRY and
//     gets attempt n+1. If a re-send of an attempt is refused (4xx), the first
//     send may still have gone through, so it's left for an admin rather than
//     retried with a new batch id.
//
// A seller without a PayPal email (users.paypal_email) isn't paid until they set one.

export const MAX_PAYOUT_ATTEMPTS = 5;
/** Wait before attempt n+1 after attempt n failed: 10 min · 2^(n−1). */
export const PAYOUT_RETRY_BASE_MS = 10 * 60 * 1000;
/** Re-send the same attempt this long after an unknown outcome (or a crash before the send was recorded). */
export const PAYOUT_RESEND_AFTER_MS = 2 * 60 * 1000;
/** Check the status at PayPal this often while no webhook has settled a sent payout. */
export const PAYOUT_CHECK_AFTER_MS = 10 * 60 * 1000;
export const PAYOUT_BATCH_SIZE = 20;

const MAX_ERROR_LENGTH = 500;

/** PayPal item statuses that mean the money definitely didn't reach the seller (CLAUDE.md mapping). */
export const PAYOUT_FAILED_STATUSES = new Set(["FAILED", "BLOCKED", "DENIED", "RETURNED"]);

export type PayoutOrder = {
  id: string;
  state: string;
  version: number;
  amountCents: number;
  platformFeeCents: number;
  currency: string;
  payoutAttempts: number;
};

export type PayoutOutcome =
  | "sent" // attempt sent, waiting for PayPal's result
  | "paid" // PAID_OUT recorded
  | "retry" // PAYOUT_RETRY recorded (another attempt later, unless it gave up)
  | "waiting" // nothing to do yet (still pending at PayPal, or no PayPal email)
  | "review" // needs an admin; won't be touched again automatically
  | "skipped" // not due any more, or another run got there first
  | "failed"; // PayPal or the DB failed; the next run tries again

export type PayoutSweepResult = { checked: number } & Record<PayoutOutcome, number>;

/** What the seller receives: the sale minus our fee. */
export function payoutCents(order: { amountCents: number; platformFeeCents: number }) {
  return order.amountCents - order.platformFeeCents;
}

/** When to send the next attempt after `attempts` failed ones; null once MAX_PAYOUT_ATTEMPTS have failed. */
export function payoutRetryAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_PAYOUT_ATTEMPTS) return null;
  return new Date(now.getTime() + PAYOUT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function errorText(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
}

// ---------- DB halves (shared with the webhook handlers) ----------

/**
 * PAYOUT_PENDING → PAID_OUT and seller_payable −x / paid_out +x, in the
 * caller's transaction. Returns a reason (and changes nothing) if the payout
 * doesn't match what this order is owed; null when recorded.
 */
export async function recordPayoutSucceeded(
  tx: Db,
  order: PayoutOrder,
  item: { payoutItemId: string; amountCents: number | null; currency: string | null },
  now: Date,
): Promise<string | null> {
  if (order.state !== "PAYOUT_PENDING") return `payout ${item.payoutItemId} succeeded while the order is ${order.state}`;
  const expected = payoutCents(order);
  if (item.amountCents !== expected || item.currency !== order.currency) {
    return `payout ${item.payoutItemId} is ${item.amountCents ?? "unreadable"} ${item.currency ?? ""}, expected ${expected} ${order.currency}`;
  }
  await transition(tx, order.id, "PAYOUT_PENDING", "PAID_OUT", order.version, {
    paidOutAt: now,
    paypalPayoutItemId: item.payoutItemId,
    payoutNextAttemptAt: null,
    payoutLastError: null,
  });
  await postTransaction(
    tx,
    [
      { account: "seller_payable", amountCents: -expected },
      { account: "paid_out", amountCents: expected },
    ],
    { kind: "PAYOUT", orderId: order.id, paypalRef: item.payoutItemId },
  );
  return null;
}

/**
 * PAYOUT_PENDING → PAYOUT_RETRY in the caller's transaction, with the next
 * attempt scheduled (or none, after MAX_PAYOUT_ATTEMPTS). Returns a note.
 */
export async function recordPayoutFailed(
  tx: Db,
  order: PayoutOrder,
  failure: { payoutItemId: string | null; status: string },
  now: Date,
): Promise<string> {
  const retryAt = payoutRetryAt(order.payoutAttempts, now);
  const lastError = `attempt ${order.payoutAttempts}: ${failure.status}`.slice(0, MAX_ERROR_LENGTH);
  await transition(tx, order.id, "PAYOUT_PENDING", "PAYOUT_RETRY", order.version, {
    payoutNextAttemptAt: retryAt,
    payoutLastError: retryAt ? lastError : `needs review: gave up after ${order.payoutAttempts} attempts (${lastError})`,
    ...(failure.payoutItemId ? { paypalPayoutItemId: failure.payoutItemId } : {}),
  });
  if (!retryAt) console.error(`order ${order.id}: payout gave up after ${order.payoutAttempts} attempts (${failure.status})`);
  return retryAt
    ? `payout ${failure.status}: will be retried`
    : `needs review: payout ${failure.status}, gave up after ${order.payoutAttempts} attempts`;
}

// ---------- Worker ----------

const payoutSelect = {
  id: true,
  state: true,
  version: true,
  amountCents: true,
  platformFeeCents: true,
  currency: true,
  payoutAttempts: true,
  payoutNextAttemptAt: true,
  capturedAt: true,
  paypalPayoutBatchId: true,
  seller: { select: { paypalEmail: true } },
} as const;

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function loadOrder(id: string) {
  return prisma.order.findUnique({ where: { id }, select: payoutSelect });
}

/** Leaves the order for an admin: no further automatic attempts or checks. */
async function flagForReview(order: LoadedOrder, why: string): Promise<PayoutOutcome> {
  console.error(`order ${order.id}: payout needs review: ${why}`);
  await prisma.order.updateMany({
    where: { id: order.id, version: order.version },
    data: { payoutNextAttemptAt: null, payoutLastError: `needs review: ${why}`.slice(0, MAX_ERROR_LENGTH) },
  });
  return "review";
}

/** Updates the scheduling fields only if the order hasn't moved since it was read. */
async function reschedule(order: LoadedOrder, at: Date, lastError: string | null) {
  await prisma.order.updateMany({
    where: { id: order.id, version: order.version },
    data: { payoutNextAttemptAt: at, payoutLastError: lastError?.slice(0, MAX_ERROR_LENGTH) ?? null },
  });
}

/** Moves CAPTURED / PAYOUT_RETRY → PAYOUT_PENDING with the next attempt number, then sends it. */
async function startAttempt(paypal: PayPalClient, order: LoadedOrder, now: Date): Promise<PayoutOutcome> {
  const receiver = order.seller.paypalEmail;
  if (!receiver) return "waiting";
  if (payoutCents(order) <= 0) return flagForReview(order, `nothing to pay out (${payoutCents(order)} cents)`);

  const attempt = order.payoutAttempts + 1;
  let version: number;
  try {
    ({ version } = await prisma.$transaction((tx) =>
      transition(tx, order.id, order.state as "CAPTURED" | "PAYOUT_RETRY", "PAYOUT_PENDING", order.version, {
        payoutAttempts: attempt,
        // If we crash before recording the send, the next sweep re-sends this attempt.
        payoutNextAttemptAt: new Date(now.getTime() + PAYOUT_RESEND_AFTER_MS),
        paypalPayoutBatchId: null,
        paypalPayoutItemId: null,
        payoutLastError: null,
      }),
    ));
  } catch (err) {
    if (err instanceof StaleOrderError) return "skipped";
    throw err;
  }
  return send(paypal, { ...order, state: "PAYOUT_PENDING", version, payoutAttempts: attempt }, receiver, now, false);
}

/** Sends attempt `order.payoutAttempts`. `resend`: this attempt may already have reached PayPal. */
async function send(
  paypal: PayPalClient,
  order: LoadedOrder,
  receiver: string,
  now: Date,
  resend: boolean,
): Promise<PayoutOutcome> {
  const attempt = order.payoutAttempts;
  try {
    const created = await paypal.createPayout({
      orderId: order.id,
      attempt,
      receiverEmail: receiver,
      amountCents: payoutCents(order),
      currency: order.currency,
    });
    const { count } = await prisma.order.updateMany({
      where: { id: order.id, state: "PAYOUT_PENDING", payoutAttempts: attempt, paypalPayoutBatchId: null },
      data: {
        paypalPayoutBatchId: created.payoutBatchId,
        payoutNextAttemptAt: new Date(now.getTime() + PAYOUT_CHECK_AFTER_MS),
        payoutLastError: null,
      },
    });
    if (count === 1) console.log(`order ${order.id}: payout attempt ${attempt} sent (batch ${created.payoutBatchId})`);
    return "sent";
  } catch (err) {
    if (!(err instanceof PayPalError)) {
      console.error(`order ${order.id}: payout attempt ${attempt} failed:`, errorText(err));
      await reschedule(order, new Date(now.getTime() + PAYOUT_RESEND_AFTER_MS), errorText(err));
      return "failed";
    }
    const detail = `${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`;
    if (err.retryable) {
      // Outcome unknown: re-send the SAME attempt later; PayPal pays it at most once.
      console.error(`order ${order.id}: payout attempt ${attempt} outcome unknown, will re-send: ${detail}`);
      await reschedule(order, new Date(now.getTime() + PAYOUT_RESEND_AFTER_MS), `attempt ${attempt} unknown: ${detail}`);
      return "failed";
    }
    if (resend) {
      return flagForReview(order, `re-send of attempt ${attempt} was refused (${detail}); the first send may have gone through`);
    }
    // A first send refused outright: no payout was created, so the next attempt is safe.
    const status = err.issue ?? err.paypalName ?? `HTTP ${err.status ?? "error"}`;
    console.error(`order ${order.id}: payout attempt ${attempt} refused: ${detail}`);
    try {
      await prisma.$transaction((tx) => recordPayoutFailed(tx, order, { payoutItemId: null, status }, now));
    } catch (recordErr) {
      if (recordErr instanceof StaleOrderError) return "skipped";
      throw recordErr;
    }
    return "retry";
  }
}

/** For a sent payout no webhook has settled: ask PayPal for the item's status and record it. */
async function check(paypal: PayPalClient, order: LoadedOrder, now: Date): Promise<PayoutOutcome> {
  let batch;
  try {
    batch = await paypal.getPayoutBatch({ payoutBatchId: order.paypalPayoutBatchId! });
  } catch (err) {
    if (err instanceof PayPalError && !err.retryable && err.status === 404) {
      return flagForReview(order, `payout batch ${order.paypalPayoutBatchId} not found at PayPal`);
    }
    console.error(`order ${order.id}: payout status check failed:`, errorText(err));
    await reschedule(order, new Date(now.getTime() + PAYOUT_CHECK_AFTER_MS), `status check failed: ${errorText(err)}`);
    return "failed";
  }

  const item = batch.items.find((i) => i.senderItemId === order.id);
  if (!item) {
    await reschedule(order, new Date(now.getTime() + PAYOUT_CHECK_AFTER_MS), `batch ${batch.batchStatus}: no item yet`);
    return "waiting";
  }

  const status = item.transactionStatus;
  try {
    if (status === "SUCCESS") {
      const problem = await prisma.$transaction((tx) => recordPayoutSucceeded(tx, order, item, now));
      return problem ? flagForReview(order, problem) : "paid";
    }
    if (PAYOUT_FAILED_STATUSES.has(status)) {
      await prisma.$transaction((tx) =>
        recordPayoutFailed(tx, order, { payoutItemId: item.payoutItemId, status: item.errorName ? `${status} ${item.errorName}` : status }, now),
      );
      return "retry";
    }
  } catch (err) {
    if (err instanceof StaleOrderError) return "skipped"; // a webhook recorded it first
    throw err;
  }
  if (status === "REFUNDED" || status === "REVERSED") {
    return flagForReview(order, `payout item ${item.payoutItemId} is ${status}`);
  }
  // PENDING, UNCLAIMED (seller has no PayPal account yet; returned after 30 days), ONHOLD: keep checking.
  await reschedule(order, new Date(now.getTime() + PAYOUT_CHECK_AFTER_MS), `item ${status}`);
  return "waiting";
}

/** Does whatever the order's payout needs next. Failures are logged and returned, not thrown. */
export async function processPayout(paypal: PayPalClient, orderId: string, now = new Date()): Promise<PayoutOutcome> {
  const order = await loadOrder(orderId);
  if (!order) return "skipped";
  try {
    if (order.state === "CAPTURED" && order.capturedAt && order.capturedAt <= now) {
      return await startAttempt(paypal, order, now);
    }
    const due = order.payoutNextAttemptAt !== null && order.payoutNextAttemptAt <= now;
    if (order.state === "PAYOUT_RETRY" && due && order.payoutAttempts < MAX_PAYOUT_ATTEMPTS) {
      return await startAttempt(paypal, order, now);
    }
    if (order.state === "PAYOUT_PENDING" && due) {
      if (order.paypalPayoutBatchId) return await check(paypal, order, now);
      if (!order.seller.paypalEmail) return flagForReview(order, "seller's PayPal email was removed mid-payout");
      return await send(paypal, order, order.seller.paypalEmail, now, true);
    }
    return "skipped";
  } catch (err) {
    console.error(`order ${order.id}: payout step failed:`, errorText(err));
    return "failed";
  }
}

/** Sends due payouts and checks unsettled ones, oldest first. */
export async function sweepPayouts(
  paypal: PayPalClient,
  { now = new Date(), limit = PAYOUT_BATCH_SIZE }: { now?: Date; limit?: number } = {},
): Promise<PayoutSweepResult> {
  const due = await prisma.order.findMany({
    where: {
      OR: [
        { state: "CAPTURED", capturedAt: { lte: now }, seller: { paypalEmail: { not: null } } },
        { state: "PAYOUT_RETRY", payoutAttempts: { lt: MAX_PAYOUT_ATTEMPTS }, payoutNextAttemptAt: { lte: now } },
        { state: "PAYOUT_PENDING", payoutNextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const result: PayoutSweepResult = {
    checked: due.length,
    sent: 0,
    paid: 0,
    retry: 0,
    waiting: 0,
    review: 0,
    skipped: 0,
    failed: 0,
  };
  for (const { id } of due) result[await processPayout(paypal, id, now)] += 1;
  return result;
}
