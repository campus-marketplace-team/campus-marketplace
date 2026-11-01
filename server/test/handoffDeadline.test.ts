import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import {
  DEADLINE_GRACE_MS,
  ORDER_VOIDED_NOTIFICATION,
  recordVoid,
  sweepHandoffDeadlines,
  voidOverdueOrder,
} from "../src/jobs/handoffDeadline.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// Handoff deadline sweeper against the real database with a fake PayPal client.
//
// ledger_entries is append-only, so no test may commit a VOID posting: the
// ledger half (recordVoid) is checked in a rolled-back transaction, and the
// job tests stub postTransaction so cleanup() can delete their orders.
//
// The database is shared with real (sandbox) orders, so every test works in
// the year 2001: test orders' deadlines are around NOW below, and a sweep run
// "at" NOW can't see any real order, whose deadlines are all far later.

vi.mock("../src/ledger/postTransaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger/postTransaction.js")>();
  return { ...actual, postTransaction: vi.fn(actual.postTransaction) };
});

const paypal = {
  createOrder: vi.fn(),
  authorizeOrder: vi.fn(),
  captureAuthorization: vi.fn(),
  voidAuthorization: vi.fn(),
};
const fakePayPal = paypal as unknown as PayPalClient;

const NOW = new Date("2001-01-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let buyerId: string;
let sellerId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("deadline-buyer")).id;
  sellerId = (await createTestUser("deadline-seller")).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks(); // postTransaction goes back to the real one
  paypal.voidAuthorization.mockResolvedValue({ status: "VOIDED" });
});

/** Ledger writes are skipped so the committed order can be cleaned up. */
function stubLedger() {
  vi.mocked(postTransaction).mockResolvedValue({ transactionId: crypto.randomUUID(), entryCount: 2 });
}

/** An AUTHORIZED order (no ledger entries) whose deadline is `deadlineInMs` from `now`. */
async function createAuthorizedOrder({ deadlineInMs = -HOUR, amountCents = 5000, now = NOW } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "deadline test", description: "test", category: "OTHER", priceCents: amountCents, status: "RESERVED" },
    select: { id: true },
  });
  const deadline = now.getTime() + deadlineInMs;
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state: "AUTHORIZED",
      version: 1,
      amountCents,
      platformFeeCents: Math.floor(amountCents / 10),
      paypalOrderId: `PPORDER-${crypto.randomUUID()}`,
      paypalAuthorizationId: `AUTH-${crypto.randomUUID()}`,
      authorizedAt: new Date(deadline - 72 * HOUR),
      handoffDeadline: new Date(deadline),
    },
  });
}

async function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id }, select: { state: true, version: true } });
}

async function listingStatus(listingId: string) {
  return (await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, select: { status: true } })).status;
}

async function notificationsFor(orderId: string) {
  return prisma.notification.findMany({ where: { orderId }, orderBy: { userId: "asc" } });
}

describe("recordVoid (the one DB transaction)", () => {
  class Rollback extends Error {}

  it("moves the order to VOIDED, puts the listing back on sale, returns escrow to the buyer, and notifies both sides", async () => {
    const order = await createAuthorizedOrder();

    await expect(
      prisma.$transaction(async (tx: Db) => {
        await recordVoid(tx, order, NOW);
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the ledger's commit-time balance check

        expect(await tx.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ state: "VOIDED", version: 2 });
        const listing = await tx.listing.findUniqueOrThrow({ where: { id: order.listingId }, select: { status: true } });
        expect(listing.status).toBe("ACTIVE");

        const entries = await tx.ledgerEntry.findMany({ where: { orderId: order.id }, orderBy: { amountCents: "desc" } });
        expect(entries.map((e) => [e.account, e.amountCents, e.kind, e.paypalRef])).toEqual([
          ["buyer_funds", 5000, "VOID", order.paypalAuthorizationId],
          ["escrow_held", -5000, "VOID", order.paypalAuthorizationId],
        ]);
        expect(entries.reduce((sum, e) => sum + e.amountCents, 0)).toBe(0);
        expect(new Set(entries.map((e) => e.transactionId)).size).toBe(1);

        const notes = await tx.notification.findMany({ where: { orderId: order.id } });
        expect(notes.map((n) => n.userId).sort()).toEqual([buyerId, sellerId].sort());
        expect(notes.every((n) => n.kind === ORDER_VOIDED_NOTIFICATION && n.message && n.readAt === null)).toBe(true);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // Rolled back: nothing persisted.
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("rolls back everything when the order was already moved (stale version)", async () => {
    const order = await createAuthorizedOrder();
    await expect(prisma.$transaction((tx) => recordVoid(tx, { ...order, version: 7 }, NOW))).rejects.toThrow(
      /expected AUTHORIZED v7/,
    );
    expect(await listingStatus(order.listingId)).toBe("RESERVED");
    expect(await notificationsFor(order.id)).toEqual([]);
  });
});

describe("voidOverdueOrder", () => {
  it("voids through PayPal, then records VOIDED with the VOID ledger posting and two notifications", async () => {
    stubLedger();
    const order = await createAuthorizedOrder();

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("voided");

    expect(paypal.voidAuthorization).toHaveBeenCalledExactlyOnceWith({
      orderId: order.id,
      authorizationId: order.paypalAuthorizationId,
    });
    expect(await readOrder(order.id)).toEqual({ state: "VOIDED", version: 2 });
    expect(await listingStatus(order.listingId)).toBe("ACTIVE");
    expect(postTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      [
        { account: "escrow_held", amountCents: -5000 },
        { account: "buyer_funds", amountCents: 5000 },
      ],
      { kind: "VOID", orderId: order.id, paypalRef: order.paypalAuthorizationId },
    );
    expect((await notificationsFor(order.id)).length).toBe(2);
  });

  it("leaves orders alone before the deadline and during the grace period after it", async () => {
    for (const deadlineInMs of [HOUR, -DEADLINE_GRACE_MS + 1000]) {
      const order = await createAuthorizedOrder({ deadlineInMs });
      expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("skipped");
      expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    }
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
  });

  it("skips an order that isn't AUTHORIZED any more (e.g. captured by a last-minute scan)", async () => {
    const order = await createAuthorizedOrder();
    await prisma.order.update({ where: { id: order.id }, data: { state: "CAPTURED", version: 2 } });

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("skipped");
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
  });

  it("records nothing when PayPal times out, and the next run voids it with the same request", async () => {
    stubLedger();
    const order = await createAuthorizedOrder();
    paypal.voidAuthorization.mockRejectedValueOnce(new PayPalError("void", "timeout", "no response"));

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("failed");
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await notificationsFor(order.id)).toEqual([]);
    expect(postTransaction).not.toHaveBeenCalled();

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("voided");
    expect(paypal.voidAuthorization).toHaveBeenCalledTimes(2);
    expect(paypal.voidAuthorization.mock.calls[0]).toEqual(paypal.voidAuthorization.mock.calls[1]);
    expect(await readOrder(order.id)).toEqual({ state: "VOIDED", version: 2 });
  });

  it("records the void when PayPal says the authorization is already void", async () => {
    stubLedger();
    const order = await createAuthorizedOrder();
    paypal.voidAuthorization.mockRejectedValueOnce(
      new PayPalError("void", "http", "HTTP 422", { status: 422, issue: "PREVIOUSLY_VOIDED" }),
    );

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("voided");
    expect(await readOrder(order.id)).toEqual({ state: "VOIDED", version: 2 });
  });

  it("does not void when PayPal says the authorization was already captured", async () => {
    const order = await createAuthorizedOrder();
    paypal.voidAuthorization.mockRejectedValueOnce(
      new PayPalError("void", "http", "HTTP 422", { status: 422, issue: "AUTHORIZATION_ALREADY_CAPTURED" }),
    );

    expect(await voidOverdueOrder(fakePayPal, order.id, NOW)).toBe("captured");
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await listingStatus(order.listingId)).toBe("RESERVED");
    expect(await notificationsFor(order.id)).toEqual([]);
  });

  it("two concurrent runs on one order record it exactly once", async () => {
    stubLedger();
    const order = await createAuthorizedOrder();

    const outcomes = await Promise.all([
      voidOverdueOrder(fakePayPal, order.id, NOW),
      voidOverdueOrder(fakePayPal, order.id, NOW),
    ]);
    expect(outcomes.sort()).toEqual(["skipped", "voided"]);
    expect(await readOrder(order.id)).toEqual({ state: "VOIDED", version: 2 });
    expect(postTransaction).toHaveBeenCalledTimes(1);
    expect((await notificationsFor(order.id)).length).toBe(2);
  });
});

describe("sweepHandoffDeadlines", () => {
  // Earlier than every other order in this file (some are left AUTHORIZED and overdue at NOW).
  const SWEEP_NOW = new Date("2000-06-01T12:00:00.000Z");

  it("voids every overdue AUTHORIZED order and leaves the rest", async () => {
    stubLedger();
    const now = SWEEP_NOW;
    const overdue = [
      await createAuthorizedOrder({ deadlineInMs: -2 * HOUR, now }),
      await createAuthorizedOrder({ deadlineInMs: -HOUR, now }),
    ];
    const notYet = await createAuthorizedOrder({ deadlineInMs: HOUR, now });
    paypal.voidAuthorization.mockRejectedValueOnce(new PayPalError("void", "network", "refused"));

    // Oldest deadline first, so the first (network error) is overdue[0].
    expect(await sweepHandoffDeadlines(fakePayPal, { now })).toMatchObject({
      checked: 2,
      voided: 1,
      failed: 1,
      skipped: 0,
      captured: 0,
    });
    expect(await readOrder(overdue[0].id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await readOrder(overdue[1].id)).toEqual({ state: "VOIDED", version: 2 });
    expect(await readOrder(notYet.id)).toEqual({ state: "AUTHORIZED", version: 1 });

    // The next run retries the failed one.
    expect(await sweepHandoffDeadlines(fakePayPal, { now })).toMatchObject({ checked: 1, voided: 1 });
    expect(await readOrder(overdue[0].id)).toEqual({ state: "VOIDED", version: 2 });
  });
});
