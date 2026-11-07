import type { Db } from "../db.js";
import type { LedgerAccount } from "../generated/prisma/enums.js";
import { recordVoid } from "../jobs/handoffDeadline.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { recordCapture } from "../orders/handoff.js";
import { transition } from "../orders/stateMachine.js";
import { enqueueDisputeDecision } from "../outbox/handlers.js";
import { valueToCents } from "../paypal/client.js";
import { recordPayoutFailed, recordPayoutSucceeded } from "../payouts/payouts.js";
import type { WebhookEventHandler, WebhookOrder } from "./process.js";

// What each PayPal webhook event does to its order, always through the state
// machine. process.ts has already found the order and dropped stale events;
// each handler runs in the same transaction that marks the event processed.
//
// Outcomes:
//   - a legal transition (with its ledger posting), returning nothing;
//   - a note, when there's nothing to change. Notes starting "needs review:"
//     are cases the state machine can't express or that don't add up (e.g. a
//     wrong amount); they're logged as errors for an admin;
//   - a throw, when the order is likely just one step behind (the relay retries).
//
// The payload is untrusted data. Ids are compared with ours, never trusted
// alone, and amounts must match what we expect before any money is recorded.

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function resourceOf(payload: unknown) {
  return obj(obj(payload).resource);
}

/**
 * An amount → cents and currency, or null if it isn't readable. Orders and
 * payments use { currency_code, value }; Payouts use { currency, value }.
 */
function amountOf(value: unknown): { cents: number; currency: string } | null {
  const a = obj(value);
  const currency = str(a.currency_code) ?? str(a.currency);
  if (!currency || typeof a.value !== "string") return null;
  try {
    return { cents: valueToCents(a.value), currency };
  } catch {
    return null;
  }
}

function needsReview(order: WebhookOrder, why: string) {
  const note = `needs review: ${why}`;
  console.error(`order ${order.id}: ${note}`);
  return note;
}

// ---------- Authorizations ----------

/** PAYMENT.AUTHORIZATION.VOIDED: AUTHORIZED → VOIDED (e.g. PayPal expired it), escrow back to the buyer. */
export const onAuthorizationVoided: WebhookEventHandler = async ({ event, order, tx, now }) => {
  const authorizationId = str(resourceOf(event.payload).id);
  if (!authorizationId || authorizationId !== order.paypalAuthorizationId) {
    // e.g. an older authorization replaced by a reauthorization.
    return `ignored: authorization ${authorizationId} isn't the order's current one`;
  }
  if (order.state !== "AUTHORIZED") return `ignored: order is ${order.state}, nothing was held`;
  await recordVoid(tx, { ...order, paypalAuthorizationId: authorizationId }, now, { notify: false });
};

// ---------- Captures ----------

/**
 * PAYMENT.CAPTURE.COMPLETED: AUTHORIZED → CAPTURED. Normally the QR scan has
 * already recorded it (then the event is stale); this covers a scan whose
 * capture went through at PayPal but whose DB write didn't.
 */
export const onCaptureCompleted: WebhookEventHandler = async ({ event, order, tx, now }) => {
  const resource = resourceOf(event.payload);
  const captureId = str(resource.id);
  const status = str(resource.status);
  const amount = amountOf(resource.amount);
  const authorizationId = str(obj(obj(resource.supplementary_data).related_ids).authorization_id);

  if (order.state !== "AUTHORIZED") {
    return needsReview(order, `capture ${captureId} completed while the order is ${order.state}`);
  }
  if (!captureId || status !== "COMPLETED") return needsReview(order, `unreadable capture (status ${status})`);
  if (authorizationId && authorizationId !== order.paypalAuthorizationId) {
    return needsReview(order, `capture ${captureId} is for authorization ${authorizationId}, not the order's`);
  }
  if (!amount || amount.cents !== order.amountCents || amount.currency !== order.currency) {
    return needsReview(
      order,
      `capture ${captureId} is ${amount ? `${amount.cents} ${amount.currency}` : "unreadable"}, expected ${order.amountCents} ${order.currency}`,
    );
  }
  await recordCapture(tx, order, { captureId, status, amountCents: amount.cents, currency: amount.currency }, now);
};

/** The order's balance in each ledger account (sum of its entries). */
async function orderBalances(tx: Db, orderId: string) {
  const rows = await tx.ledgerEntry.groupBy({ by: ["account"], where: { orderId }, _sum: { amountCents: true } });
  const balances = new Map<LedgerAccount, number>();
  for (const r of rows) balances.set(r.account, r._sum.amountCents ?? 0);
  return balances;
}

/**
 * Ledger entries returning `refundCents` to the buyer: taken from what the
 * order still has in escrow_held, then seller_payable, and from platform_fees
 * only on a full refund (a partial refund comes out of the seller's share).
 * null if the order doesn't hold that much (e.g. already paid out).
 */
export function refundEntries(
  balances: Map<LedgerAccount, number>,
  refundCents: number,
  full: boolean,
): { account: LedgerAccount; amountCents: number }[] | null {
  const sources: LedgerAccount[] = full ? ["escrow_held", "seller_payable", "platform_fees"] : ["escrow_held", "seller_payable"];
  const entries: { account: LedgerAccount; amountCents: number }[] = [];
  let left = refundCents;
  for (const account of sources) {
    const take = Math.min(left, Math.max(0, balances.get(account) ?? 0));
    if (take > 0) {
      entries.push({ account, amountCents: -take });
      left -= take;
    }
  }
  if (left > 0) return null;
  return [...entries, { account: "buyer_funds", amountCents: refundCents }];
}

/**
 * PAYMENT.CAPTURE.REFUNDED: IN_DISPUTE → REFUNDED (everything refunded) or
 * PARTIAL_REFUND, with the refund posted to the ledger. The state machine only
 * allows refunds out of a dispute, so a refund in any other state (e.g. made
 * in PayPal's dashboard) is flagged for review instead.
 */
export const onCaptureRefunded: WebhookEventHandler = async ({ event, order, tx, now }) => {
  const resource = resourceOf(event.payload); // the refund
  const refundId = str(resource.id);
  const refund = amountOf(resource.amount);
  // Cumulative across all refunds of this capture; fall back to this refund alone.
  const total = amountOf(obj(resource.seller_payable_breakdown).total_refunded_amount) ?? refund;

  if (order.state !== "IN_DISPUTE") {
    return needsReview(order, `refund ${refundId} while the order is ${order.state}; refunds only move a disputed order`);
  }
  if (!refundId || !refund || !total || refund.cents <= 0 || refund.currency !== order.currency) {
    return needsReview(order, `unreadable refund ${refundId}`);
  }
  if (total.cents > order.amountCents) {
    return needsReview(order, `refunds total ${total.cents}, more than the ${order.amountCents} paid`);
  }

  const full = total.cents === order.amountCents;
  const entries = refundEntries(await orderBalances(tx, order.id), refund.cents, full);
  if (!entries) return needsReview(order, `refund ${refundId} of ${refund.cents} is more than the order still holds`);

  const to = full ? "REFUNDED" : "PARTIAL_REFUND";
  await transition(tx, order.id, "IN_DISPUTE", to, order.version);
  await postTransaction(tx, entries, { kind: "REFUND", orderId: order.id, paypalRef: refundId });
  await tx.dispute.updateMany({
    where: { orderId: order.id, status: { in: ["OPEN", "PENDING_APPROVAL"] } },
    data: { status: "RESOLVED", resolution: to, refundCents: total.cents, resolvedAt: now },
  });
};

// ---------- Payouts ----------

/** Which payout item an event is about; it must be this order's. */
function payoutItemOf(payload: unknown) {
  const resource = resourceOf(payload);
  const item = obj(resource.payout_item);
  return {
    payoutItemId: str(resource.payout_item_id),
    senderItemId: str(item.sender_item_id),
    amount: amountOf(item.amount),
    status: str(resource.transaction_status),
  };
}

function isThisOrdersItem(order: WebhookOrder, item: ReturnType<typeof payoutItemOf>) {
  if (order.paypalPayoutItemId) return item.payoutItemId === order.paypalPayoutItemId;
  return item.senderItemId === order.id;
}

/** The order is CAPTURED: its payout hasn't been recorded as sent yet. Retry until it is. */
function payoutNotSentYet(order: WebhookOrder): never {
  throw new Error(`order ${order.id} is ${order.state}; its payout isn't recorded as sent yet`);
}

/** PAYMENT.PAYOUTS-ITEM.SUCCEEDED: PAYOUT_PENDING → PAID_OUT, seller_payable → paid_out (src/payouts). */
export const onPayoutSucceeded: WebhookEventHandler = async ({ event, order, tx, now }) => {
  const item = payoutItemOf(event.payload);
  if (order.state === "CAPTURED") payoutNotSentYet(order);
  if (order.state !== "PAYOUT_PENDING") {
    return needsReview(order, `payout ${item.payoutItemId} succeeded while the order is ${order.state}`);
  }
  if (!item.payoutItemId || !isThisOrdersItem(order, item)) {
    return needsReview(order, `payout item ${item.payoutItemId} isn't this order's`);
  }
  const problem = await recordPayoutSucceeded(
    tx,
    order,
    { payoutItemId: item.payoutItemId, amountCents: item.amount?.cents ?? null, currency: item.amount?.currency ?? null },
    now,
  );
  if (problem) return needsReview(order, problem);
};

/** PAYMENT.PAYOUTS-ITEM.FAILED / BLOCKED / RETURNED: PAYOUT_PENDING → PAYOUT_RETRY; the worker re-sends after a backoff. */
export const onPayoutFailed: WebhookEventHandler = async ({ event, order, tx, now }) => {
  const item = payoutItemOf(event.payload);
  if (order.state === "CAPTURED") payoutNotSentYet(order);
  if (order.state !== "PAYOUT_PENDING") {
    return needsReview(order, `payout ${item.payoutItemId} ${event.eventType} while the order is ${order.state}`);
  }
  if (!isThisOrdersItem(order, item)) return needsReview(order, `payout item ${item.payoutItemId} isn't this order's`);

  const status = item.status ?? event.eventType.split(".").pop() ?? event.eventType;
  return recordPayoutFailed(tx, order, { payoutItemId: item.payoutItemId, status }, now);
};

/**
 * HELD, UNCLAIMED, CANCELED, REFUNDED: no state the state machine has.
 * UNCLAIMED (the seller has no PayPal account yet) comes back to us after 30
 * days as RETURNED; REFUNDED after PAID_OUT means the money came back.
 */
export const onPayoutNotice: WebhookEventHandler = async ({ event, order }) => {
  const item = payoutItemOf(event.payload);
  if (event.eventType === "PAYMENT.PAYOUTS-ITEM.REFUNDED") {
    return needsReview(order, `payout ${item.payoutItemId} was refunded back to us (order is ${order.state})`);
  }
  return `payout ${item.status ?? event.eventType}: no state change`;
};

// ---------- Disputes ----------

/**
 * CUSTOMER.DISPUTE.CREATED: AUTHORIZED → IN_DISPUTE (with a disputes row) when
 * the state machine allows it. PayPal disputes usually come after capture,
 * where it doesn't, so those are flagged for review.
 */
export const onDisputeCreated: WebhookEventHandler = async ({ event, order, tx }) => {
  const resource = resourceOf(event.payload);
  const disputeId = str(resource.dispute_id);
  const reason = str(resource.reason) ?? "UNKNOWN";

  if (order.state === "IN_DISPUTE") return `ignored: order already in dispute (PayPal dispute ${disputeId})`;
  if (order.state !== "AUTHORIZED") {
    return needsReview(order, `PayPal dispute ${disputeId} (${reason}) opened on a ${order.state} order`);
  }

  await transition(tx, order.id, "AUTHORIZED", "IN_DISPUTE", order.version);
  await tx.dispute.createMany({
    data: [
      {
        orderId: order.id,
        openedById: order.buyerId,
        reason: `PAYPAL_${reason}`.slice(0, 128),
        description: `Opened in PayPal (dispute ${disputeId ?? "unknown"})`,
        photoUrls: [],
      },
    ],
    skipDuplicates: true, // the buyer may have reported it in the app first
  });
  await enqueueDisputeDecision(tx, order.id);
};

/** Handlers by event type. Types not listed stay unprocessed until one exists. */
export const webhookEventHandlers: Readonly<Record<string, WebhookEventHandler>> = {
  "PAYMENT.AUTHORIZATION.VOIDED": onAuthorizationVoided,
  "PAYMENT.CAPTURE.COMPLETED": onCaptureCompleted,
  "PAYMENT.CAPTURE.REFUNDED": onCaptureRefunded,
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": onPayoutSucceeded,
  "PAYMENT.PAYOUTS-ITEM.FAILED": onPayoutFailed,
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": onPayoutFailed,
  "PAYMENT.PAYOUTS-ITEM.RETURNED": onPayoutFailed,
  "PAYMENT.PAYOUTS-ITEM.HELD": onPayoutNotice,
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": onPayoutNotice,
  "PAYMENT.PAYOUTS-ITEM.CANCELED": onPayoutNotice,
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": onPayoutNotice,
  "CUSTOMER.DISPUTE.CREATED": onDisputeCreated,
};
