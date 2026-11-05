import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import type { OrderState, Prisma } from "../src/generated/prisma/client.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { enqueueOutbox } from "../src/outbox/outbox.js";
import {
  onAuthorizationVoided,
  onCaptureCompleted,
  onCaptureRefunded,
  onDisputeCreated,
  onPayoutFailed,
  onPayoutNotice,
  onPayoutSucceeded,
  refundEntries,
  webhookEventHandlers,
} from "../src/webhooks/handlers.js";
import { PAYPAL_WEBHOOK_TOPIC, requeueUnprocessedWebhookEvents } from "../src/webhooks/ingest.js";
import { processWebhookEvent, type WebhookEventHandler, type WebhookOrder } from "../src/webhooks/process.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// Webhook event handlers against the real database.
//
// ledger_entries is append-only, so nothing here may commit a ledger posting:
// handlers that move money run inside a transaction that is then rolled back
// (with the ledger's commit-time balance check forced first), and the
// end-to-end runs through processWebhookEvent stub postTransaction.

vi.mock("../src/ledger/postTransaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger/postTransaction.js")>();
  return { ...actual, postTransaction: vi.fn(actual.postTransaction) };
});

const EVENT_PREFIX = `WH-HANDLER-TEST-${randomUUID().slice(0, 8)}-`;
const NOW = new Date("2026-11-03T12:00:00.000Z");

let buyerId: string;
let sellerId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("whh-buyer")).id;
  sellerId = (await createTestUser("whh-seller")).id;
});

beforeEach(() => {
  vi.resetAllMocks(); // postTransaction goes back to the real one
});

afterEach(async () => {
  const events = await prisma.webhookEvent.findMany({ where: { eventId: { startsWith: EVENT_PREFIX } }, select: { id: true } });
  if (events.length > 0) {
    await prisma.outboxEvent.deleteMany({
      where: { topic: PAYPAL_WEBHOOK_TOPIC, OR: events.map((e) => ({ payload: { path: ["webhookEventId"], equals: e.id } })) },
    });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const orderSelect = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  state: true,
  version: true,
  amountCents: true,
  platformFeeCents: true,
  refundedCents: true,
  currency: true,
  paypalOrderId: true,
  paypalAuthorizationId: true,
  paypalCaptureId: true,
  paypalPayoutItemId: true,
  payoutAttempts: true,
} as const;

/** A committed $50 order (fee $5) in `state`, with no ledger entries, and its listing. */
async function createOrder(state: OrderState, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}): Promise<WebhookOrder> {
  const listingStatus = state === "AUTHORIZED" || state === "IN_DISPUTE" ? "RESERVED" : state === "CREATED" ? "ACTIVE" : "SOLD";
  const listing = await prisma.listing.create({
    data: { sellerId, title: "webhook handler test", description: "test", category: "OTHER", priceCents: 5000, status: listingStatus },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state,
      version: 4,
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      ...extra,
    },
    select: orderSelect,
  });
}

function event(eventType: string, resource: Record<string, unknown>) {
  return { id: randomUUID(), eventId: `${EVENT_PREFIX}${randomUUID()}`, eventType, payload: { event_type: eventType, resource } };
}

class Rollback extends Error {}

/** Runs `body` in a transaction that is always rolled back; the ledger's balance check runs before `body`'s assertions. */
async function inRollback(body: (tx: Db) => Promise<void>) {
  await expect(
    prisma.$transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function run(handler: WebhookEventHandler, tx: Db, order: WebhookOrder, e: ReturnType<typeof event>) {
  const note = await handler({ event: e, order, tx, now: NOW });
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the ledger's commit-time balance check
  return note;
}

async function ledger(tx: Db, orderId: string) {
  const entries = await tx.ledgerEntry.findMany({ where: { orderId }, orderBy: { id: "asc" } });
  return entries.map((e) => [e.kind, e.account, e.amountCents]);
}

async function stateOf(db: Db, orderId: string) {
  return db.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true, version: true } });
}

/** Ledger history an order would have after authorizing (and, with `captured`, capturing). */
async function postHistory(tx: Db, orderId: string, { captured = false } = {}) {
  await postTransaction(tx, [{ account: "escrow_held", amountCents: 5000 }, { account: "buyer_funds", amountCents: -5000 }], {
    kind: "AUTHORIZE",
    orderId,
  });
  if (captured) {
    await postTransaction(
      tx,
      [
        { account: "escrow_held", amountCents: -5000 },
        { account: "seller_payable", amountCents: 4500 },
        { account: "platform_fees", amountCents: 500 },
      ],
      { kind: "CAPTURE", orderId },
    );
  }
}

const usd = (value: string) => ({ currency_code: "USD", value });
/** Payouts' amount shape: { currency, value } (not currency_code). */
const payoutUsd = (value: string) => ({ currency: "USD", value });

describe("PAYMENT.AUTHORIZATION.VOIDED", () => {
  it("AUTHORIZED → VOIDED: escrow back to the buyer, listing back on sale", async () => {
    const order = await createOrder("AUTHORIZED");
    await inRollback(async (tx) => {
      const note = await run(onAuthorizationVoided, tx, order, event("PAYMENT.AUTHORIZATION.VOIDED", { id: order.paypalAuthorizationId }));
      expect(note).toBeUndefined();
      expect(await stateOf(tx, order.id)).toEqual({ state: "VOIDED", version: 5 });
      expect(await ledger(tx, order.id)).toEqual([
        ["VOID", "escrow_held", -5000],
        ["VOID", "buyer_funds", 5000],
      ]);
      expect((await tx.listing.findUniqueOrThrow({ where: { id: order.listingId } })).status).toBe("ACTIVE");
      // Not the deadline job's "72 hours" message; the outbox's generic one follows instead.
      expect(await tx.notification.count({ where: { orderId: order.id } })).toBe(0);
      expect(await tx.outboxEvent.count({ where: { orderId: order.id, topic: "order.state_changed" } })).toBe(1);
    });
  });

  it("ignores a void of an authorization that isn't the order's current one", async () => {
    const order = await createOrder("AUTHORIZED");
    await inRollback(async (tx) => {
      const note = await run(onAuthorizationVoided, tx, order, event("PAYMENT.AUTHORIZATION.VOIDED", { id: "AUTH-OLD" }));
      expect(note).toMatch(/^ignored: authorization AUTH-OLD isn't the order's current one/);
      expect(await stateOf(tx, order.id)).toEqual({ state: "AUTHORIZED", version: 4 });
    });
  });
});

describe("PAYMENT.CAPTURE.COMPLETED", () => {
  function captureEvent(order: WebhookOrder, overrides: Record<string, unknown> = {}) {
    return event("PAYMENT.CAPTURE.COMPLETED", {
      id: `CAP-${randomUUID()}`,
      status: "COMPLETED",
      amount: usd("50.00"),
      supplementary_data: { related_ids: { authorization_id: order.paypalAuthorizationId, order_id: order.paypalOrderId } },
      ...overrides,
    });
  }

  it("AUTHORIZED → CAPTURED with the capture posting (a scan whose DB write was lost)", async () => {
    const order = await createOrder("AUTHORIZED");
    const e = captureEvent(order);
    await inRollback(async (tx) => {
      expect(await run(onCaptureCompleted, tx, order, e)).toBeUndefined();
      const row = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row).toMatchObject({ state: "CAPTURED", version: 5, paypalCaptureId: e.payload.resource.id, capturedAt: NOW });
      expect(await ledger(tx, order.id)).toEqual([
        ["CAPTURE", "escrow_held", -5000],
        ["CAPTURE", "seller_payable", 4500],
        ["CAPTURE", "platform_fees", 500],
      ]);
      expect((await tx.listing.findUniqueOrThrow({ where: { id: order.listingId } })).status).toBe("SOLD");
    });
  });

  it("flags a wrong amount or someone else's authorization for review and records nothing", async () => {
    const order = await createOrder("AUTHORIZED");
    await inRollback(async (tx) => {
      const wrongAmount = await run(onCaptureCompleted, tx, order, captureEvent(order, { amount: usd("500.00") }));
      expect(wrongAmount).toMatch(/^needs review: capture .* is 50000 USD, expected 5000 USD/);
      const wrongAuth = await run(
        onCaptureCompleted,
        tx,
        order,
        captureEvent(order, { supplementary_data: { related_ids: { authorization_id: "AUTH-OTHER" } } }),
      );
      expect(wrongAuth).toMatch(/^needs review: .*AUTH-OTHER/);
      expect(await stateOf(tx, order.id)).toEqual({ state: "AUTHORIZED", version: 4 });
      expect(await ledger(tx, order.id)).toEqual([]);
    });
  });
});

describe("PAYMENT.CAPTURE.REFUNDED", () => {
  function refundEvent(value: string, total = value) {
    return event("PAYMENT.CAPTURE.REFUNDED", {
      id: `REF-${randomUUID()}`,
      status: "COMPLETED",
      amount: usd(value),
      seller_payable_breakdown: { total_refunded_amount: usd(total) },
    });
  }

  it("IN_DISPUTE → REFUNDED on a full refund, everything back to the buyer, dispute resolved", async () => {
    const order = await createOrder("IN_DISPUTE");
    await inRollback(async (tx) => {
      await postHistory(tx, order.id, { captured: true });
      await tx.dispute.create({ data: { orderId: order.id, openedById: buyerId, reason: "NOT_RECEIVED", photoUrls: [] } });

      expect(await run(onCaptureRefunded, tx, order, refundEvent("50.00"))).toBeUndefined();
      expect(await stateOf(tx, order.id)).toEqual({ state: "REFUNDED", version: 5 });
      const refund = (await ledger(tx, order.id)).filter(([kind]) => kind === "REFUND");
      expect(refund).toEqual([
        ["REFUND", "seller_payable", -4500],
        ["REFUND", "platform_fees", -500],
        ["REFUND", "buyer_funds", 5000],
      ]);
      expect(await tx.dispute.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
        status: "RESOLVED",
        resolution: "REFUNDED",
        refundCents: 5000,
      });
    });
  });

  it("IN_DISPUTE → PARTIAL_REFUND: the refund comes out of the seller's share, the fee stays", async () => {
    const order = await createOrder("IN_DISPUTE");
    await inRollback(async (tx) => {
      await postHistory(tx, order.id, { captured: true });
      expect(await run(onCaptureRefunded, tx, order, refundEvent("20.00"))).toBeUndefined();
      expect(await stateOf(tx, order.id)).toEqual({ state: "PARTIAL_REFUND", version: 5 });
      expect((await ledger(tx, order.id)).filter(([kind]) => kind === "REFUND")).toEqual([
        ["REFUND", "seller_payable", -2000],
        ["REFUND", "buyer_funds", 2000],
      ]);
    });
  });

  it("flags refunds outside a dispute, or above the amount paid, for review", async () => {
    const captured = await createOrder("CAPTURED");
    const disputed = await createOrder("IN_DISPUTE");
    await inRollback(async (tx) => {
      expect(await run(onCaptureRefunded, tx, captured, refundEvent("50.00"))).toMatch(/^needs review: .*order is CAPTURED/);
      expect(await run(onCaptureRefunded, tx, disputed, refundEvent("10.00", "60.00"))).toMatch(/more than the 5000 paid/);
      expect(await stateOf(tx, captured.id)).toEqual({ state: "CAPTURED", version: 4 });
      expect(await stateOf(tx, disputed.id)).toEqual({ state: "IN_DISPUTE", version: 4 });
    });
  });

  it("refundEntries balances and never takes more than the order holds", () => {
    const held = new Map([["escrow_held", 5000]] as const);
    expect(refundEntries(new Map(held), 5000, true)).toEqual([
      { account: "escrow_held", amountCents: -5000 },
      { account: "buyer_funds", amountCents: 5000 },
    ]);
    const captured = new Map([
      ["escrow_held", 0],
      ["seller_payable", 4500],
      ["platform_fees", 500],
    ] as const);
    expect(refundEntries(new Map(captured), 5000, false)).toBeNull(); // a partial refund can't take the fee
    const paidOut = new Map([["paid_out", 4500], ["platform_fees", 500]] as const);
    expect(refundEntries(new Map(paidOut), 1000, false)).toBeNull();
    for (const entries of [refundEntries(new Map(captured), 1234, false), refundEntries(new Map(captured), 5000, true)]) {
      expect(entries!.reduce((sum, e) => sum + e.amountCents, 0)).toBe(0);
    }
  });
});

describe("PAYMENT.PAYOUTS-ITEM.*", () => {
  function payoutEvent(eventType: string, order: WebhookOrder, overrides: Record<string, unknown> = {}) {
    return event(eventType, {
      payout_item_id: `ITEM-${randomUUID()}`,
      payout_batch_id: `payout-${order.id}`,
      transaction_status: eventType.split(".").pop(),
      payout_item: { sender_item_id: order.id, amount: payoutUsd("45.00"), receiver: "seller@example.com" },
      ...overrides,
    });
  }

  it("SUCCEEDED: PAYOUT_PENDING → PAID_OUT, seller_payable → paid_out", async () => {
    const order = await createOrder("PAYOUT_PENDING");
    const e = payoutEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", order);
    await inRollback(async (tx) => {
      await postHistory(tx, order.id, { captured: true });
      expect(await run(onPayoutSucceeded, tx, order, e)).toBeUndefined();
      const row = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row).toMatchObject({ state: "PAID_OUT", version: 5, paidOutAt: NOW, paypalPayoutItemId: e.payload.resource.payout_item_id });
      expect((await ledger(tx, order.id)).filter(([kind]) => kind === "PAYOUT")).toEqual([
        ["PAYOUT", "seller_payable", -4500],
        ["PAYOUT", "paid_out", 4500],
      ]);
    });
  });

  it("SUCCEEDED with the wrong amount or another order's item is flagged, not recorded", async () => {
    const order = await createOrder("PAYOUT_PENDING");
    await inRollback(async (tx) => {
      const wrongAmount = payoutEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", order, {
        payout_item: { sender_item_id: order.id, amount: payoutUsd("50.00") },
      });
      expect(await run(onPayoutSucceeded, tx, order, wrongAmount)).toMatch(/expected 4500 USD/);
      const otherItem = payoutEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", order, {
        payout_item: { sender_item_id: randomUUID(), amount: payoutUsd("45.00") },
      });
      expect(await run(onPayoutSucceeded, tx, order, otherItem)).toMatch(/isn't this order's/);
      expect(await stateOf(tx, order.id)).toEqual({ state: "PAYOUT_PENDING", version: 4 });
    });
  });

  it("SUCCEEDED before the payout is recorded as sent: throws so the relay retries", async () => {
    const order = await createOrder("CAPTURED");
    await inRollback(async (tx) => {
      await expect(run(onPayoutSucceeded, tx, order, payoutEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", order))).rejects.toThrow(
        /payout isn't recorded as sent yet/,
      );
    });
  });

  it("FAILED, BLOCKED and RETURNED: PAYOUT_PENDING → PAYOUT_RETRY", async () => {
    for (const type of ["FAILED", "BLOCKED", "RETURNED"]) {
      const order = await createOrder("PAYOUT_PENDING");
      await inRollback(async (tx) => {
        const note = await run(onPayoutFailed, tx, order, payoutEvent(`PAYMENT.PAYOUTS-ITEM.${type}`, order));
        expect(note).toBe(`payout ${type}: will be retried`);
        expect(await stateOf(tx, order.id)).toEqual({ state: "PAYOUT_RETRY", version: 5 });
        const row = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(row.payoutNextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime()); // the worker re-sends later
        expect(row.payoutLastError).toContain(type);
      });
    }
  });

  it("HELD / UNCLAIMED / CANCELED change nothing; REFUNDED is flagged", async () => {
    const order = await createOrder("PAYOUT_PENDING");
    await inRollback(async (tx) => {
      expect(await run(onPayoutNotice, tx, order, payoutEvent("PAYMENT.PAYOUTS-ITEM.UNCLAIMED", order))).toBe(
        "payout UNCLAIMED: no state change",
      );
      expect(await run(onPayoutNotice, tx, order, payoutEvent("PAYMENT.PAYOUTS-ITEM.REFUNDED", order))).toMatch(
        /^needs review: payout .* was refunded back to us/,
      );
      expect(await stateOf(tx, order.id)).toEqual({ state: "PAYOUT_PENDING", version: 4 });
    });
  });
});

describe("CUSTOMER.DISPUTE.CREATED", () => {
  const disputeEvent = () => event("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-123", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });

  it("AUTHORIZED → IN_DISPUTE with a disputes row", async () => {
    const order = await createOrder("AUTHORIZED");
    await inRollback(async (tx) => {
      expect(await run(onDisputeCreated, tx, order, disputeEvent())).toBeUndefined();
      expect(await stateOf(tx, order.id)).toEqual({ state: "IN_DISPUTE", version: 5 });
      expect(await tx.dispute.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
        openedById: buyerId,
        reason: "PAYPAL_MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "OPEN",
      });
    });
  });

  it("a dispute on a captured order is flagged for review (no legal move to IN_DISPUTE)", async () => {
    const order = await createOrder("CAPTURED");
    await inRollback(async (tx) => {
      expect(await run(onDisputeCreated, tx, order, disputeEvent())).toMatch(/^needs review: PayPal dispute PP-D-123 .* CAPTURED order/);
      expect(await stateOf(tx, order.id)).toEqual({ state: "CAPTURED", version: 4 });
      expect(await tx.dispute.count({ where: { orderId: order.id } })).toBe(0);
    });
  });
});

describe("processWebhookEvent with the real handlers", () => {
  function stubLedger() {
    vi.mocked(postTransaction).mockResolvedValue({ transactionId: randomUUID(), entryCount: 2 });
  }

  async function store(e: ReturnType<typeof event>) {
    return prisma.webhookEvent.create({
      data: { eventId: e.eventId, eventType: e.eventType, payload: e.payload as Prisma.InputJsonObject },
    });
  }

  function captureCompleted(order: WebhookOrder) {
    return event("PAYMENT.CAPTURE.COMPLETED", {
      id: `CAP-${randomUUID()}`,
      status: "COMPLETED",
      amount: usd("50.00"),
      supplementary_data: { related_ids: { authorization_id: order.paypalAuthorizationId } },
    });
  }

  it("registers a handler for each event the task names", () => {
    for (const type of [
      "PAYMENT.AUTHORIZATION.VOIDED",
      "PAYMENT.CAPTURE.COMPLETED",
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      "PAYMENT.PAYOUTS-ITEM.FAILED",
      "PAYMENT.PAYOUTS-ITEM.BLOCKED",
      "PAYMENT.PAYOUTS-ITEM.RETURNED",
      "PAYMENT.PAYOUTS-ITEM.HELD",
      "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
      "PAYMENT.PAYOUTS-ITEM.CANCELED",
      "PAYMENT.PAYOUTS-ITEM.REFUNDED",
      "CUSTOMER.DISPUTE.CREATED",
    ]) {
      expect(webhookEventHandlers[type], type).toBeTypeOf("function");
    }
  });

  it("applies the event and marks it processed in one transaction; a replay is a no-op", async () => {
    stubLedger();
    const order = await createOrder("AUTHORIZED");
    const e = captureCompleted(order);
    const row = await store(e);

    expect(await processWebhookEvent(row.id)).toBe("handled");
    expect(await stateOf(prisma, order.id)).toEqual({ state: "CAPTURED", version: 5 });
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processedAt).not.toBeNull();
    expect(after.processError).toBeNull();
    expect(postTransaction).toHaveBeenCalledOnce();

    expect(await processWebhookEvent(row.id)).toBe("already_processed");
    // The same capture delivered again under a new event id is stale now.
    const again = await store({ ...e, id: randomUUID(), eventId: `${EVENT_PREFIX}${randomUUID()}` });
    expect(await processWebhookEvent(again.id)).toBe("stale");
    expect(postTransaction).toHaveBeenCalledOnce();
  });

  it("two relays processing the same event apply it once", async () => {
    stubLedger();
    const order = await createOrder("AUTHORIZED");
    const row = await store(captureCompleted(order));

    const outcomes = await Promise.allSettled([processWebhookEvent(row.id), processWebhookEvent(row.id)]);
    const values = outcomes.map((o) => (o.status === "fulfilled" ? o.value : "threw"));
    expect(values).toContain("handled");
    expect(values.filter((v) => v === "handled")).toHaveLength(1);
    expect(await stateOf(prisma, order.id)).toEqual({ state: "CAPTURED", version: 5 });
    expect(postTransaction).toHaveBeenCalledOnce();
  });

  it("stores a needs-review note and finishes the event", async () => {
    // Disputes name the capture, so the order is found by its capture id.
    const captureId = `CAP-${randomUUID()}`;
    await createOrder("CAPTURED", { paypalCaptureId: captureId });
    const row = await store(
      event("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-9", disputed_transactions: [{ seller_transaction_id: captureId }] }),
    );

    expect(await processWebhookEvent(row.id)).toBe("handled");
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processedAt).not.toBeNull();
    expect(after.processError).toMatch(/^needs review: PayPal dispute PP-D-9/);
  });

  it("the replay script finds unprocessed events that have nothing queued (dry run)", async () => {
    const order = await createOrder("AUTHORIZED");
    const waiting = await store(captureCompleted(order));
    const orphan = await store(captureCompleted(order));
    await enqueueOutbox(prisma, { topic: PAYPAL_WEBHOOK_TOPIC, payload: { webhookEventId: waiting.id } });

    const ids = await requeueUnprocessedWebhookEvents(); // dry run: reads only
    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(waiting.id);
  });
});
