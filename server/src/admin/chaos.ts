import type { OrderState } from "@campus/shared";
import { prisma } from "../db.js";
import { isUuid } from "../ids.js";
import { DEADLINE_GRACE_MS, voidOverdueOrder, type VoidOutcome } from "../jobs/handoffDeadline.js";
import { CheckoutError } from "../orders/checkout.js";
import { capture, issueHandoffToken, recordCapture } from "../orders/handoff.js";
import { StaleOrderError } from "../orders/stateMachine.js";
import { type PayPalClient, getPayPalConfig, isSandboxBaseUrl } from "../paypal/client.js";
import { processWebhookEvent } from "../webhooks/process.js";
import { storeWebhookEvent } from "../webhooks/ingest.js";

// Admin "chaos" buttons (task 5.1): trigger a failure live on one order and
// show, step by step, that the reliability rules hold. PayPal sandbox only:
// every scenario refuses to run unless PAYPAL_BASE_URL is the sandbox API.
//
//   duplicate-webhook  Redelivers a stored, already verified event for the
//                      order several times at once through the same store step
//                      as POST /api/webhooks/paypal (UNIQUE event_id + ON
//                      CONFLICT DO NOTHING), then runs the worker's processing
//                      on it again. Nothing about the order or its ledger changes.
//   capture-timeout    Captures an AUTHORIZED order at PayPal but drops the
//                      answer, as if it timed out after PayPal charged. The
//                      retry sends the same PayPal-Request-Id, so PayPal answers
//                      with the first capture: one charge, recorded once.
//   expire-deadline    Moves an AUTHORIZED order's handoff deadline into the past
//                      and runs the deadline sweeper on it now instead of waiting
//                      for the worker: QR codes are refused, the authorization is
//                      voided and the buyer is never charged.
//
// These skip the QR scan and the 72-hour wait on purpose. They change real
// (sandbox) orders in the shared database, so the dashboard asks first.

export const CHAOS_SCENARIOS = ["duplicate-webhook", "capture-timeout", "expire-deadline"] as const;
export type ChaosScenario = (typeof CHAOS_SCENARIOS)[number];

/** Times the stored event is redelivered, all at once. */
export const DUPLICATE_DELIVERIES = 3;

export type ChaosStep = { label: string; detail: string };
export type ChaosResult = { scenario: ChaosScenario; orderId: string; steps: ChaosStep[]; order: { state: OrderState; version: number } };

/** Chaos runs only against PayPal's sandbox. */
export function chaosEnabled(): boolean {
  return isSandboxBaseUrl(getPayPalConfig()?.baseUrl);
}

export function isChaosScenario(value: unknown): value is ChaosScenario {
  return typeof value === "string" && (CHAOS_SCENARIOS as readonly string[]).includes(value);
}

const notFound = () => new CheckoutError(404, "NOT_FOUND", "Order not found");
const notAuthorized = (state: OrderState) =>
  new CheckoutError(409, "ORDER_NOT_AUTHORIZED", `This scenario needs an order waiting for its handoff (AUTHORIZED); this one is ${state}`);

/** State, version and ledger entry count: what a scenario must (or must not) change. */
async function snapshot(orderId: string) {
  const [order, ledgerEntries] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true, version: true } }),
    prisma.ledgerEntry.count({ where: { orderId } }),
  ]);
  return { ...order, ledgerEntries };
}

const describeOrder = (s: Awaited<ReturnType<typeof snapshot>>) => `${s.state}, version ${s.version}, ${s.ledgerEntries} ledger entries`;

export async function runChaos(paypal: PayPalClient, scenario: ChaosScenario, orderId: unknown, now = new Date()): Promise<ChaosResult> {
  if (!isUuid(orderId)) throw notFound();
  const exists = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) throw notFound();

  const steps =
    scenario === "duplicate-webhook"
      ? await duplicateWebhook(orderId)
      : scenario === "capture-timeout"
        ? await captureTimeout(paypal, orderId, now)
        : await expireDeadline(paypal, orderId, now);
  const { state, version } = await snapshot(orderId);
  return { scenario, orderId, steps, order: { state, version } };
}

async function duplicateWebhook(orderId: string): Promise<ChaosStep[]> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { paypalOrderId: true, paypalAuthorizationId: true, paypalCaptureId: true, paypalPayoutItemId: true },
  });
  const resourceIds = [order.paypalOrderId, order.paypalAuthorizationId, order.paypalCaptureId, order.paypalPayoutItemId].filter(
    (id): id is string => id !== null,
  );
  // Only finished events: one still waiting would be processed for real here.
  const event = await prisma.webhookEvent.findFirst({
    where: { resourceId: { in: resourceIds }, processedAt: { not: null } },
    orderBy: { receivedAt: "desc" },
    select: { id: true, eventId: true, eventType: true, payload: true },
  });
  if (!event) {
    throw new CheckoutError(409, "NO_WEBHOOK", "PayPal hasn't sent a webhook for this order yet (or it's still being processed)");
  }
  const payload = event.payload as Record<string, unknown>;
  const steps: ChaosStep[] = [];
  const before = await snapshot(orderId);
  steps.push({ label: "Picked the order's latest processed webhook", detail: `${event.eventType} (event ${event.eventId}). Order is ${describeOrder(before)}.` });

  const inserted = await Promise.all(
    Array.from({ length: DUPLICATE_DELIVERIES }, () => storeWebhookEvent({ eventId: event.eventId, eventType: event.eventType, event: payload })),
  );
  const stored = inserted.filter(Boolean).length;
  steps.push({
    label: `Redelivered it ${DUPLICATE_DELIVERIES} times at once`,
    detail:
      stored === 0
        ? `All ${DUPLICATE_DELIVERIES} were answered 200 as duplicates: UNIQUE(event_id) + ON CONFLICT DO NOTHING stored none, so nothing new was queued for the worker.`
        : `Unexpected: ${stored} of the deliveries were stored as new events.`,
  });

  const outcome = await processWebhookEvent(event.id);
  steps.push({
    label: "Ran the worker's processing on the event again",
    detail: outcome === "already_processed" ? "Skipped: the event is already marked processed." : `Unexpected outcome: ${outcome}.`,
  });

  const after = await snapshot(orderId);
  const unchanged = after.state === before.state && after.version === before.version && after.ledgerEntries === before.ledgerEntries;
  steps.push({
    label: unchanged ? "Nothing changed" : "The order changed",
    detail: unchanged
      ? `Order is still ${describeOrder(after)}.`
      : `Order is now ${describeOrder(after)} (another request or the worker may have moved it meanwhile).`,
  });
  return steps;
}

async function captureTimeout(paypal: PayPalClient, orderId: string, now: Date): Promise<ChaosStep[]> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      listingId: true,
      state: true,
      version: true,
      amountCents: true,
      platformFeeCents: true,
      currency: true,
      paypalAuthorizationId: true,
      handoffDeadline: true,
    },
  });
  if (order.state !== "AUTHORIZED") throw notAuthorized(order.state);
  if (!order.handoffDeadline || order.handoffDeadline <= now) {
    throw new CheckoutError(409, "HANDOFF_EXPIRED", "The handoff deadline has passed, so this order can't be captured");
  }
  const steps: ChaosStep[] = [];

  // PayPal does the capture; we throw its answer away, as if the connection dropped.
  const lost = await capture(paypal, order);
  const afterLoss = await snapshot(orderId);
  steps.push({
    label: "Capture sent; PayPal's answer was dropped (simulated timeout)",
    detail: `PayPal-Request-Id ${order.id}-capture. As far as we know the outcome is unknown, so nothing is recorded: order is still ${describeOrder(afterLoss)}.`,
  });

  const retried = await capture(paypal, order);
  if (retried.captureId !== lost.captureId) {
    console.error(`Order ${order.id}: chaos capture retry got capture ${retried.captureId}, first was ${lost.captureId}`);
    throw new CheckoutError(502, "CAPTURE_MISMATCH", "PayPal answered the retry with a different capture. Reconciliation will flag this order.");
  }
  steps.push({
    label: "Retried with the same PayPal-Request-Id",
    detail: `PayPal replayed the first answer: capture ${retried.captureId} (${retried.status}), the same one. The buyer was charged once.`,
  });

  if (retried.status !== "COMPLETED" && retried.status !== "PENDING") {
    throw new CheckoutError(402, "CAPTURE_DECLINED", `PayPal says the capture is ${retried.status}`);
  }
  if (retried.amountCents !== order.amountCents || retried.currency !== order.currency) {
    console.error(`Order ${order.id}: chaos capture ${retried.captureId} is ${retried.amountCents} ${retried.currency}, expected ${order.amountCents} ${order.currency}`);
    throw new CheckoutError(502, "CAPTURE_MISMATCH", "PayPal captured an unexpected amount. We'll review this order.");
  }

  try {
    await prisma.$transaction((tx) => recordCapture(tx, order, retried, now));
  } catch (err) {
    if (err instanceof StaleOrderError) {
      throw new CheckoutError(409, "ORDER_CHANGED", `Captured at PayPal, but the order moved to ${err.actual.state} first. Reconciliation will flag it.`);
    }
    throw err;
  }
  const after = await snapshot(orderId);
  steps.push({ label: "Recorded the capture once", detail: `One DB transaction: order is now ${describeOrder(after)}, listing SOLD.` });
  return steps;
}

const VOID_DETAIL: Record<VoidOutcome, string> = {
  voided: "Authorization voided at PayPal (PayPal-Request-Id <order>-void), then in one DB transaction: VOIDED, listing back on sale, escrow returned to the buyer. The buyer was never charged.",
  skipped: "Skipped: the worker or another request voided or moved the order first.",
  captured: "PayPal says it was already captured, so it wasn't voided.",
  failed: "The void failed (see the API logs); the worker retries it on its next run.",
};

async function expireDeadline(paypal: PayPalClient, orderId: string, now: Date): Promise<ChaosStep[]> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true, sellerId: true } });
  if (order.state !== "AUTHORIZED") throw notAuthorized(order.state);
  const steps: ChaosStep[] = [];

  // Past the sweeper's grace period too, so it acts now.
  const deadline = new Date(now.getTime() - DEADLINE_GRACE_MS - 1000);
  const moved = await prisma.order.updateMany({ where: { id: orderId, state: "AUTHORIZED" }, data: { handoffDeadline: deadline } });
  if (moved.count === 0) throw notAuthorized((await snapshot(orderId)).state);
  steps.push({ label: "Moved the handoff deadline into the past", detail: `Deadline is now ${deadline.toISOString()}.` });

  try {
    await issueHandoffToken(order.sellerId, orderId, now);
    steps.push({ label: "Unexpected: a QR code was still issued", detail: "The deadline check didn't refuse it." });
  } catch (err) {
    if (!(err instanceof CheckoutError)) throw err;
    steps.push({ label: "The seller asked for a QR code", detail: `Refused: ${err.message} (${err.code}).` });
  }

  const outcome = await voidOverdueOrder(paypal, orderId, now);
  const after = await snapshot(orderId);
  steps.push({ label: `Ran the deadline sweeper: ${outcome}`, detail: `${VOID_DETAIL[outcome]} Order is now ${describeOrder(after)}.` });
  return steps;
}
