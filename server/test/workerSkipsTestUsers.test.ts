import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepApprovedDisputeDecisions } from "../src/disputes/actionTools.js";
import { sweepExpiringAuthorizations } from "../src/jobs/authorizationExpiry.js";
import { sweepHandoffDeadlines } from "../src/jobs/handoffDeadline.js";
import { sweepReconciliation } from "../src/jobs/reconciliation.js";
import { DISPUTE_NEEDS_DECISION, ORDER_STATE_CHANGED } from "../src/outbox/handlers.js";
import { drainOutbox, enqueueOutbox, MAX_ATTEMPTS } from "../src/outbox/outbox.js";
import { sweepPayouts } from "../src/payouts/payouts.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { PAYPAL_WEBHOOK_TOPIC } from "../src/webhooks/ingest.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// The deployed worker shares this database with `npm test`, so every job and
// relay it runs must leave test users' rows alone (src/testUsers.ts). Each case
// runs once with skipTestUsers (what the worker passes): nothing is touched and
// PayPal isn't called. Then it runs once without it, proving the same row
// really was due. That second run's PayPal calls all fail with a plain error,
// which every job treats as "try again later", so nothing is recorded.
//
// The rows are due around 1999, before every other test file's (2000 and later),
// so the run without the filter can't reach another file's rows, and no real
// row is due that early either. The reverse isn't true: another file's sweep
// (at 2000 or later) would reach these rows, so vitest.config.ts runs this file
// alone, after all the others.

const NOW = new Date("1999-01-01T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unreachable = () => Promise.reject(new Error("fake PayPal: unreachable"));
const paypal = {
  voidAuthorization: vi.fn(unreachable),
  reauthorize: vi.fn(unreachable),
  captureAuthorization: vi.fn(unreachable),
  getAuthorization: vi.fn(unreachable),
  getCapture: vi.fn(unreachable),
  getRefund: vi.fn(unreachable),
  getPayoutBatch: vi.fn(unreachable),
  createPayout: vi.fn(unreachable),
};
const fakePayPal = paypal as unknown as PayPalClient;

let buyerId: string;
let sellerId: string;
let listingId: string;
const webhookEventIds: string[] = [];

beforeAll(async () => {
  buyerId = (await createTestUser("skip-buyer")).id;
  sellerId = (await createTestUser("skip-seller")).id;
  listingId = (
    await prisma.listing.create({
      data: { sellerId, title: "worker skip test", description: "test", category: "OTHER", priceCents: 5000, status: "RESERVED" },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  // Webhook outbox rows have no order id, so cleanup() wouldn't find them.
  await prisma.outboxEvent.deleteMany({ where: { OR: webhookEventIds.map((id) => ({ payload: { path: ["webhookEventId"], equals: id } })) } });
  await prisma.webhookEvent.deleteMany({ where: { id: { in: webhookEventIds } } });
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function createOrder(data: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return prisma.order.create({
    data: {
      listingId,
      buyerId,
      sellerId,
      state: "AUTHORIZED",
      version: 1,
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      ...data,
    },
  });
}

function anyPayPalCall() {
  return Object.values(paypal).some((fn) => fn.mock.calls.length > 0);
}

describe("scheduled jobs", () => {
  it("handoff-deadline skips a test user's overdue order", async () => {
    const order = await createOrder({ handoffDeadline: new Date(NOW.getTime() - HOUR), authorizedAt: new Date(NOW.getTime() - 73 * HOUR) });

    expect(await sweepHandoffDeadlines(fakePayPal, { now: NOW, skipTestUsers: true })).toMatchObject({ checked: 0 });
    expect(anyPayPalCall()).toBe(false);

    expect(await sweepHandoffDeadlines(fakePayPal, { now: NOW })).toMatchObject({ checked: 1, failed: 1 });
    expect(paypal.voidAuthorization).toHaveBeenCalledWith(expect.objectContaining({ orderId: order.id }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("AUTHORIZED");
  });

  it("authorization-expiry skips a test user's authorization past its honor period", async () => {
    const order = await createOrder({
      handoffDeadline: new Date(NOW.getTime() + 2 * DAY),
      authorizedAt: new Date(NOW.getTime() - 4 * DAY),
      honorPeriodEndsAt: new Date(NOW.getTime() - HOUR),
      authorizationExpiresAt: new Date(NOW.getTime() + 20 * DAY),
    });

    expect(await sweepExpiringAuthorizations(fakePayPal, { now: NOW, skipTestUsers: true })).toMatchObject({ checked: 0 });
    expect(anyPayPalCall()).toBe(false);

    expect(await sweepExpiringAuthorizations(fakePayPal, { now: NOW })).toMatchObject({ checked: 1, failed: 1 });
    expect(paypal.reauthorize).toHaveBeenCalledWith(expect.objectContaining({ orderId: order.id }));
  });

  it("reconciliation skips a test user's order", async () => {
    const order = await createOrder({ handoffDeadline: new Date(NOW.getTime() + 2 * DAY), updatedAt: new Date(NOW.getTime() - HOUR) });

    expect(await sweepReconciliation(fakePayPal, { now: NOW, skipTestUsers: true })).toMatchObject({ checked: 0 });
    expect(anyPayPalCall()).toBe(false);

    expect(await sweepReconciliation(fakePayPal, { now: NOW })).toMatchObject({ checked: 1, failed: 1 });
    expect(paypal.getAuthorization).toHaveBeenCalledWith({ authorizationId: order.paypalAuthorizationId });
  });

  it("payouts skips a test user's payout waiting for a status check", async () => {
    const order = await createOrder({
      state: "PAYOUT_PENDING",
      capturedAt: new Date(NOW.getTime() - DAY),
      paypalCaptureId: `CAPTURE-${randomUUID()}`,
      paypalPayoutBatchId: `BATCH-${randomUUID()}`,
      payoutAttempts: 1,
      payoutNextAttemptAt: new Date(NOW.getTime() - MINUTE),
    });

    expect(await sweepPayouts(fakePayPal, { now: NOW, skipTestUsers: true })).toMatchObject({ checked: 0 });
    expect(anyPayPalCall()).toBe(false);

    expect(await sweepPayouts(fakePayPal, { now: NOW })).toMatchObject({ checked: 1, failed: 1 });
    expect(paypal.getPayoutBatch).toHaveBeenCalledWith({ payoutBatchId: order.paypalPayoutBatchId });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("PAYOUT_PENDING");
  });

  it("dispute-decisions skips a test user's approved decision", async () => {
    const order = await createOrder({ state: "IN_DISPUTE", handoffDeadline: new Date(NOW.getTime() + 2 * DAY) });
    const dispute = await prisma.dispute.create({ data: { orderId: order.id, openedById: buyerId, reason: "NOT_AS_DESCRIBED" } });
    const decision = await prisma.decision.create({
      data: {
        kind: "DISPUTE",
        outcome: "RELEASE",
        orderId: order.id,
        disputeId: dispute.id,
        inputs: {},
        actionStatus: "APPROVED",
        approvedAt: new Date(NOW.getTime() - 10 * MINUTE),
      },
    });

    expect(await sweepApprovedDisputeDecisions(fakePayPal, { now: NOW, skipTestUsers: true })).toMatchObject({ checked: 0 });
    expect(anyPayPalCall()).toBe(false);

    expect(await sweepApprovedDisputeDecisions(fakePayPal, { now: NOW })).toMatchObject({ checked: 1, waiting: 1 });
    expect(paypal.captureAuthorization).toHaveBeenCalledWith(expect.objectContaining({ orderId: order.id }));
    expect((await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } })).actionStatus).toBe("APPROVED");
  });
});

describe("outbox relays", () => {
  const handler = vi.fn(async () => {});
  const handlers = { [ORDER_STATE_CHANGED]: handler, [PAYPAL_WEBHOOK_TOPIC]: handler, [DISPUTE_NEEDS_DECISION]: handler };
  const due = (offsetMs = 0) => new Date(NOW.getTime() + offsetMs);

  async function webhookRow(resource: Record<string, unknown>) {
    const event = await prisma.webhookEvent.create({
      data: {
        eventId: `WH-SKIP-TEST-${randomUUID()}`,
        eventType: "PAYMENT.AUTHORIZATION.VOIDED",
        payload: { event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource },
      },
    });
    webhookEventIds.push(event.id);
    return (await enqueueOutbox(prisma, { topic: PAYPAL_WEBHOOK_TOPIC, payload: { webhookEventId: event.id }, availableAt: due() })).id;
  }

  const status = async (id: string) => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true } }));

  it("leave a test user's rows alone, for every topic, while still taking rows that aren't theirs", async () => {
    const order = await createOrder({ handoffDeadline: new Date(NOW.getTime() + 2 * DAY) });
    const stateChanged = (await enqueueOutbox(prisma, { topic: ORDER_STATE_CHANGED, orderId: order.id, payload: { from: "CREATED", to: "AUTHORIZED", version: 1 }, availableAt: due() })).id;
    const disputeRun = (await enqueueOutbox(prisma, { topic: DISPUTE_NEEDS_DECISION, orderId: order.id, payload: {}, availableAt: due() })).id;
    // No order id of its own: it's a test user's because the event names the order's authorization.
    const testWebhook = await webhookRow({ id: order.paypalAuthorizationId });
    // Names no order at all, so it isn't a test user's and must still be claimed.
    const otherWebhook = await webhookRow({ id: `AUTH-NOBODY-${randomUUID()}` });

    expect(await drainOutbox(handlers, { now: NOW, skipTestUsers: true })).toMatchObject({ claimed: 1, done: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: otherWebhook }));
    for (const id of [stateChanged, disputeRun, testWebhook]) expect(await status(id)).toEqual({ status: "PENDING", attempts: 0 });

    expect(await drainOutbox(handlers, { now: NOW })).toMatchObject({ claimed: 3, done: 3 });
    for (const id of [stateChanged, disputeRun, testWebhook]) expect((await status(id)).status).toBe("DONE");
  });

  it("find a webhook's test order by any of the ids the webhook processor looks up", async () => {
    const order = await createOrder({
      handoffDeadline: new Date(NOW.getTime() + 2 * DAY),
      paypalCaptureId: `CAPTURE-${randomUUID()}`,
      paypalPayoutBatchId: `BATCH-${randomUUID()}`,
      paypalPayoutItemId: `ITEM-${randomUUID()}`,
    });
    const rows = [
      await webhookRow({ custom_id: order.id }),
      await webhookRow({ purchase_units: [{ custom_id: order.id }] }),
      await webhookRow({ payout_item: { sender_item_id: order.id } }),
      await webhookRow({ supplementary_data: { related_ids: { order_id: order.paypalOrderId } } }),
      await webhookRow({ supplementary_data: { related_ids: { authorization_id: order.paypalAuthorizationId } } }),
      await webhookRow({ supplementary_data: { related_ids: { capture_id: order.paypalCaptureId } } }),
      await webhookRow({ disputed_transactions: [{ seller_transaction_id: order.paypalCaptureId }] }),
      await webhookRow({ payout_item_id: order.paypalPayoutItemId }),
      await webhookRow({ payout_batch_id: order.paypalPayoutBatchId }),
    ];

    expect(await drainOutbox(handlers, { now: NOW, skipTestUsers: true })).toMatchObject({ claimed: 0 });
    expect(await drainOutbox(handlers, { now: NOW })).toMatchObject({ claimed: rows.length });
  });

  it("don't dead-letter a test user's abandoned row", async () => {
    const order = await createOrder({ handoffDeadline: new Date(NOW.getTime() + 2 * DAY) });
    const row = await prisma.outboxEvent.create({
      data: { orderId: order.id, topic: ORDER_STATE_CHANGED, payload: {}, status: "PROCESSING", attempts: MAX_ATTEMPTS, nextAttemptAt: due(-MINUTE) },
    });

    await drainOutbox(handlers, { now: NOW, skipTestUsers: true });
    expect((await status(row.id)).status).toBe("PROCESSING");

    await drainOutbox(handlers, { now: NOW });
    expect((await status(row.id)).status).toBe("DEAD");
  });
});
