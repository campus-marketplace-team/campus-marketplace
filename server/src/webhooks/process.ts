import { LEGAL_TRANSITIONS, type OrderState } from "@campus/shared";
import { type Db, prisma } from "../db.js";
import { isUuid } from "../ids.js";
import type { OutboxEvent } from "../outbox/outbox.js";
import { webhookEventHandlers } from "./handlers.js";

// Processing a stored PayPal webhook event (outbox topic paypal.webhook, run
// by the worker's relay). Webhooks arrive late, twice and out of order, so:
//   - an event type we don't use is recorded as ignored;
//   - an event whose order can't be found yet is retried by the relay (our own
//     DB write may not have committed yet), and dead-lettered after 5 tries;
//   - a stale event, whose order is already at or past the state the event
//     would move it to, is logged and dropped;
//   - anything else goes to the handler for its event type (src/webhooks/handlers.ts).
// processed_at is set once an event is finished (handled, ignored or dropped);
// process_error says why it was ignored or dropped.
//
// The payload is untrusted data: only short id strings are read from it, and
// only to look up our own order.

/** The order state each event type would move an order to. Types without one aren't checked for staleness. */
export const WEBHOOK_TARGET_STATE: Readonly<Record<string, OrderState | null>> = {
  "CHECKOUT.ORDER.APPROVED": "AUTHORIZED", // approval leads to AUTHORIZED; once there, it's old news
  "PAYMENT.AUTHORIZATION.CREATED": "AUTHORIZED",
  "PAYMENT.AUTHORIZATION.VOIDED": "VOIDED",
  "PAYMENT.CAPTURE.COMPLETED": "CAPTURED",
  "PAYMENT.CAPTURE.PENDING": null,
  "PAYMENT.CAPTURE.DECLINED": null,
  "PAYMENT.CAPTURE.REFUNDED": null,
  "PAYMENT.CAPTURE.REVERSED": null,
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "PAID_OUT",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "PAYOUT_RETRY",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "PAYOUT_RETRY",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "PAYOUT_RETRY",
  "PAYMENT.PAYOUTS-ITEM.HELD": null,
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": null,
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": null,
  "PAYMENT.PAYOUTS-ITEM.CANCELED": null,
  // Not IN_DISPUTE: PayPal disputes are usually on captured orders, which the
  // state machine can't move to IN_DISPUTE. The handler flags those for review
  // instead of the stale check silently dropping them.
  "CUSTOMER.DISPUTE.CREATED": null,
  "CUSTOMER.DISPUTE.UPDATED": null,
  "CUSTOMER.DISPUTE.RESOLVED": null,
};

export type WebhookOrder = {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  state: OrderState;
  version: number;
  amountCents: number;
  platformFeeCents: number;
  currency: string;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  paypalPayoutItemId: string | null;
  payoutAttempts: number;
};

export type StoredWebhookEvent = { id: string; eventId: string; eventType: string; payload: unknown };

/**
 * Applies one non-stale event to its order (src/webhooks/handlers.ts). Runs in
 * `tx`, the same transaction that marks the event processed, so a crash can't
 * apply it twice. Returns a note for process_error (e.g. "needs review: ..."),
 * or nothing. Throws to have the relay retry (e.g. a race that will settle).
 */
export type WebhookEventHandler = (input: {
  event: StoredWebhookEvent;
  order: WebhookOrder;
  tx: Db;
  now: Date;
}) => Promise<string | null | void>;

export type ProcessOutcome = "handled" | "stale" | "ignored" | "unhandled" | "already_processed";

const orderSelect = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  state: true,
  version: true,
  amountCents: true,
  platformFeeCents: true,
  currency: true,
  paypalOrderId: true,
  paypalAuthorizationId: true,
  paypalCaptureId: true,
  paypalPayoutItemId: true,
  payoutAttempts: true,
} as const;

/** true if `to` can be reached from `from` by one or more legal transitions. */
export function canReach(from: OrderState, to: OrderState): boolean {
  const seen = new Set<OrderState>([from]);
  const queue: OrderState[] = [from];
  while (queue.length > 0) {
    for (const next of LEGAL_TRANSITIONS[queue.shift()!]) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Stale: the order is already in the target state, or past it (the target can't be reached any more). */
export function isStale(current: OrderState, target: OrderState): boolean {
  return current === target || !canReach(current, target);
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The last path segment of a link with rel "up" (a refund's capture), if any. */
function upLinkId(resource: Record<string, unknown>): string | null {
  const links = Array.isArray(resource.links) ? resource.links : [];
  const up = links.map(obj).find((l) => l.rel === "up");
  const href = id(up?.href);
  return href ? id(href.split("?")[0].split("/").filter(Boolean).pop()) : null;
}

/** PayPal ids (and our own order id, which we send as custom_id / sender_item_id) named by the event. */
export function orderRefs(eventType: string, payload: unknown) {
  const resource = obj(obj(payload).resource);
  const related = obj(obj(resource.supplementary_data).related_ids);
  const refs = {
    paypalOrderId: id(related.order_id),
    authorizationId: id(related.authorization_id),
    captureId: id(related.capture_id),
    payoutItemId: null as string | null,
    payoutBatchId: null as string | null,
    ourOrderId: id(resource.custom_id),
  };

  if (eventType.startsWith("CHECKOUT.ORDER.")) {
    refs.paypalOrderId = id(resource.id);
    const units = Array.isArray(resource.purchase_units) ? resource.purchase_units.map(obj) : [];
    refs.ourOrderId ??= id(units[0]?.custom_id);
  } else if (eventType.startsWith("PAYMENT.AUTHORIZATION.")) {
    refs.authorizationId = id(resource.id);
  } else if (eventType === "PAYMENT.CAPTURE.REFUNDED" || eventType === "PAYMENT.CAPTURE.REVERSED") {
    refs.captureId ??= upLinkId(resource); // the resource is the refund, not the capture
  } else if (eventType.startsWith("PAYMENT.CAPTURE.")) {
    refs.captureId = id(resource.id);
  } else if (eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    refs.payoutItemId = id(resource.payout_item_id);
    refs.payoutBatchId = id(resource.payout_batch_id);
    refs.ourOrderId ??= id(obj(resource.payout_item).sender_item_id);
  } else if (eventType.startsWith("CUSTOMER.DISPUTE.")) {
    const disputed = Array.isArray(resource.disputed_transactions) ? resource.disputed_transactions.map(obj) : [];
    refs.captureId = id(disputed[0]?.seller_transaction_id);
  }
  return refs;
}

/** Finds our order by the PayPal ids in the event, falling back to our own order id. */
export async function findOrderForEvent(eventType: string, payload: unknown): Promise<WebhookOrder | null> {
  const refs = orderRefs(eventType, payload);
  const byPayPal = [
    refs.paypalOrderId && { paypalOrderId: refs.paypalOrderId },
    refs.authorizationId && { paypalAuthorizationId: refs.authorizationId },
    refs.captureId && { paypalCaptureId: refs.captureId },
    refs.payoutItemId && { paypalPayoutItemId: refs.payoutItemId },
    refs.payoutBatchId && { paypalPayoutBatchId: refs.payoutBatchId },
  ].filter((c): c is NonNullable<typeof c> & object => Boolean(c));

  if (byPayPal.length > 0) {
    const order = await prisma.order.findFirst({ where: { OR: byPayPal }, select: orderSelect });
    if (order) return order;
  }
  if (refs.ourOrderId && isUuid(refs.ourOrderId)) {
    return prisma.order.findUnique({ where: { id: refs.ourOrderId }, select: orderSelect });
  }
  return null;
}

class AlreadyProcessed extends Error {}

async function finish(webhookEventId: string, note: string | null) {
  await prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, processedAt: null },
    data: { processedAt: new Date(), processError: note },
  });
}

/**
 * Processes one stored event. Throws (so the relay retries) when its order
 * can't be found yet or its handler fails.
 */
export async function processWebhookEvent(
  webhookEventId: string,
  handlers: Readonly<Record<string, WebhookEventHandler>> = webhookEventHandlers,
): Promise<ProcessOutcome> {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { id: true, eventId: true, eventType: true, payload: true, processedAt: true },
  });
  if (!event) throw new Error(`webhook event ${webhookEventId} not found`);
  if (event.processedAt) return "already_processed";
  const label = `webhook ${event.eventId} (${event.eventType})`;

  if (!Object.hasOwn(WEBHOOK_TARGET_STATE, event.eventType)) {
    console.log(`${label}: not an event type we use, ignored`);
    await finish(event.id, "ignored: event type not used");
    return "ignored";
  }

  const order = await findOrderForEvent(event.eventType, event.payload);
  if (!order) throw new Error(`${label}: no matching order (yet)`);

  const target = WEBHOOK_TARGET_STATE[event.eventType];
  if (target && isStale(order.state, target)) {
    const note = `stale, dropped: order is ${order.state}, event would move it to ${target}`;
    console.log(`${label}: ${note} (order ${order.id})`);
    await finish(event.id, note);
    return "stale";
  }

  const handler = Object.hasOwn(handlers, event.eventType) ? handlers[event.eventType] : undefined;
  if (!handler) {
    // Left unprocessed (processed_at null) so it can be replayed once a handler exists.
    console.log(`${label}: no handler yet for order ${order.id} (${order.state}); left unprocessed`);
    await prisma.webhookEvent.updateMany({
      where: { id: event.id, processedAt: null },
      data: { processError: `no handler for ${event.eventType}` },
    });
    return "unhandled";
  }

  const now = new Date();
  let note: string | null;
  try {
    note = await prisma.$transaction(async (tx) => {
      const result = (await handler({ event, order, tx, now })) ?? null;
      const { count } = await tx.webhookEvent.updateMany({
        where: { id: event.id, processedAt: null },
        data: { processedAt: now, processError: result },
      });
      // Another run finished it first: roll this one back so nothing is applied twice.
      if (count === 0) throw new AlreadyProcessed();
      return result;
    });
  } catch (err) {
    if (err instanceof AlreadyProcessed) return "already_processed";
    throw err;
  }
  if (note) console.log(`${label}: ${note} (order ${order.id})`);
  return "handled";
}

/** Outbox handler for topic paypal.webhook. */
export async function handlePayPalWebhookJob(job: OutboxEvent) {
  const webhookEventId = obj(job.payload).webhookEventId;
  if (typeof webhookEventId !== "string" || !isUuid(webhookEventId)) {
    throw new Error("malformed paypal.webhook payload");
  }
  await processWebhookEvent(webhookEventId);
}
