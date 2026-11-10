import { HANDOFF_WINDOW_MS } from "@campus/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { recordAuthorization } from "../src/orders/checkout.js";
import { type Authorization, type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// Checkout against the real database with a fake PayPal client.
//
// ledger_entries is append-only, so no test may commit an authorization:
// the happy path (recordAuthorization) runs in a rolled-back transaction, and
// the API tests only cover paths that write no ledger entries.

const paypal = {
  createOrder: vi.fn(),
  authorizeOrder: vi.fn(),
  captureAuthorization: vi.fn(),
  voidAuthorization: vi.fn(),
};

let api: Api;
let buyerToken: string;
let sellerToken: string;
let otherToken: string;
let sellerId: string;
let buyerId: string;

beforeAll(async () => {
  api = await startApi({ paypal: () => paypal as unknown as PayPalClient });
  const buyer = await createTestUser("co-buyer");
  const seller = await createTestUser("co-seller");
  const other = await createTestUser("co-other");
  sellerId = seller.id;
  buyerId = buyer.id;
  buyerToken = await login(api, buyer.email);
  sellerToken = await login(api, seller.email);
  otherToken = await login(api, other.email);
});

afterAll(async () => {
  await cleanup();
  await api.close();
  await prisma.$disconnect();
});

let paypalOrderSeq = 0;
beforeEach(() => {
  vi.resetAllMocks();
  paypal.createOrder.mockImplementation(async () => ({
    paypalOrderId: `PPORDER-${++paypalOrderSeq}`,
    status: "CREATED",
    approveUrl: null,
  }));
  paypal.voidAuthorization.mockResolvedValue({ status: "VOIDED" });
});

function createListing(status: "ACTIVE" | "SOLD" = "ACTIVE", priceCents = 5000) {
  return prisma.listing.create({
    // Backdated, or this file's many listings would trip the many_recent_listings risk rule.
    data: {
      sellerId,
      title: "checkout test",
      description: "test",
      category: "OTHER",
      priceCents,
      status,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
}

function authorization(overrides: Partial<Authorization> = {}): Authorization {
  return {
    authorizationId: `AUTH-${Math.random().toString(36).slice(2)}`,
    status: "CREATED",
    amountCents: 5000,
    currency: "USD",
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

/** "Check & buy" (the risk check), which createOrder's POST /orders needs first. */
async function assess(listingId: string) {
  const res = await api.call("POST", "/orders/assess", { token: buyerToken, json: { listingId } });
  expect(res.status).toBe(200);
  return res.body;
}

async function startCheckout(listingId: string) {
  await assess(listingId);
  const res = await api.call("POST", "/orders", { token: buyerToken, json: { listingId } });
  expect(res.status).toBe(201);
  return res.body as { orderId: string; paypalOrderId: string };
}

describe("POST /api/orders (start checkout)", () => {
  it("needs a login", async () => {
    const listing = await createListing();
    expect((await api.call("POST", "/orders", { json: { listingId: listing.id } })).status).toBe(401);
  });

  it("creates a CREATED order with a 10% fee and a PayPal order", async () => {
    const listing = await createListing("ACTIVE", 5000);
    const { orderId, paypalOrderId } = await startCheckout(listing.id);

    expect(paypal.createOrder).toHaveBeenCalledWith({ orderId, amountCents: 5000, currency: "USD" });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({
      state: "CREATED",
      version: 0,
      amountCents: 5000,
      platformFeeCents: 500,
      sellerId,
      paypalOrderId,
    });
  });

  it("reuses the unpaid order instead of creating another", async () => {
    const listing = await createListing();
    const first = await startCheckout(listing.id);
    const second = await startCheckout(listing.id);
    expect(second).toEqual(first);
    expect(paypal.createOrder).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when PayPal is down, and the retry reuses the same order", async () => {
    const listing = await createListing();
    paypal.createOrder.mockRejectedValueOnce(new PayPalError("create-order", "timeout", "no response"));
    await assess(listing.id);
    const failed = await api.call("POST", "/orders", { token: buyerToken, json: { listingId: listing.id } });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("PAYPAL_UNAVAILABLE");

    const { orderId } = await startCheckout(listing.id);
    const calls = paypal.createOrder.mock.calls.map(([input]) => input.orderId);
    expect(calls).toEqual([orderId, orderId]); // same order id → same PayPal-Request-Id
  });

  it("refuses the seller's own listing", async () => {
    const listing = await createListing();
    const res = await api.call("POST", "/orders", { token: sellerToken, json: { listingId: listing.id } });
    expect(res.status).toBe(403);
    expect(paypal.createOrder).not.toHaveBeenCalled();
  });

  it("refuses a listing that isn't for sale", async () => {
    const listing = await createListing("SOLD");
    const res = await api.call("POST", "/orders", { token: buyerToken, json: { listingId: listing.id } });
    expect(res.status).toBe(409);
  });

  it("answers 404 for a bad listing id", async () => {
    const res = await api.call("POST", "/orders", { token: buyerToken, json: { listingId: "nope" } });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/orders/:id/authorize (failure paths)", () => {
  async function readOrder(id: string) {
    return prisma.order.findUniqueOrThrow({ where: { id }, select: { state: true, version: true } });
  }

  it("hides other people's orders", async () => {
    const { orderId } = await startCheckout((await createListing()).id);
    const res = await api.call("POST", `/orders/${orderId}/authorize`, { token: otherToken });
    expect(res.status).toBe(404);
    expect(paypal.authorizeOrder).not.toHaveBeenCalled();
  });

  it("asks for approval when the buyer hasn't approved in PayPal", async () => {
    const { orderId } = await startCheckout((await createListing()).id);
    paypal.authorizeOrder.mockRejectedValueOnce(
      new PayPalError("authorize", "http", "HTTP 422", { status: 422, issue: "ORDER_NOT_APPROVED" }),
    );
    const res = await api.call("POST", `/orders/${orderId}/authorize`, { token: buyerToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_APPROVED");
    expect(await readOrder(orderId)).toEqual({ state: "CREATED", version: 0 });
  });

  it("voids the authorization and changes nothing when someone else reserved the listing first", async () => {
    const listing = await createListing();
    const { orderId } = await startCheckout(listing.id);
    const auth = authorization();
    // Reserved while PayPal was authorizing. (Before authorize, the listing change would make the risk check stale.)
    paypal.authorizeOrder.mockImplementationOnce(async () => {
      await prisma.listing.update({ where: { id: listing.id }, data: { status: "RESERVED" } });
      return auth;
    });

    const res = await api.call("POST", `/orders/${orderId}/authorize`, { token: buyerToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LISTING_UNAVAILABLE");
    expect(paypal.voidAuthorization).toHaveBeenCalledWith({ orderId, authorizationId: auth.authorizationId });
    expect(await readOrder(orderId)).toEqual({ state: "CREATED", version: 0 });
    expect(await prisma.ledgerEntry.count({ where: { orderId } })).toBe(0);
  });

  it("voids an authorization for the wrong amount", async () => {
    const { orderId } = await startCheckout((await createListing()).id);
    const auth = authorization({ amountCents: 4999 });
    paypal.authorizeOrder.mockResolvedValueOnce(auth);

    const res = await api.call("POST", `/orders/${orderId}/authorize`, { token: buyerToken });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("AMOUNT_MISMATCH");
    expect(paypal.voidAuthorization).toHaveBeenCalledWith({ orderId, authorizationId: auth.authorizationId });
    expect(await readOrder(orderId)).toEqual({ state: "CREATED", version: 0 });
  });

  it("refuses an authorization PayPal didn't complete", async () => {
    const { orderId } = await startCheckout((await createListing()).id);
    paypal.authorizeOrder.mockResolvedValueOnce(authorization({ status: "PENDING" }));
    const res = await api.call("POST", `/orders/${orderId}/authorize`, { token: buyerToken });
    expect(res.status).toBe(402);
    expect(await readOrder(orderId)).toEqual({ state: "CREATED", version: 0 });
  });

  it("refuses an order that hasn't started PayPal checkout", async () => {
    const listing = await createListing();
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId, sellerId, amountCents: 5000, platformFeeCents: 500 },
    });
    const res = await api.call("POST", `/orders/${order.id}/authorize`, { token: buyerToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_STARTED");
  });
});

describe("recordAuthorization (the one DB transaction)", () => {
  class Rollback extends Error {}

  async function inRolledBackTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it("reserves the listing, moves the order to AUTHORIZED with a 72h deadline, and posts escrow", async () => {
    const listing = await createListing();
    const { orderId } = await startCheckout(listing.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const auth = authorization();
    const now = new Date("2026-10-22T12:00:00.000Z");

    await inRolledBackTx(async (tx) => {
      await recordAuthorization(tx, order, auth, now);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the ledger's commit-time balance check

      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(updated).toMatchObject({
        state: "AUTHORIZED",
        version: 1,
        paypalAuthorizationId: auth.authorizationId,
        authorizedAt: now,
        handoffDeadline: new Date(now.getTime() + HANDOFF_WINDOW_MS),
        authorizationExpiresAt: auth.expiresAt,
      });
      expect(updated.handoffDeadline!.getTime() - now.getTime()).toBe(72 * 60 * 60 * 1000);

      const reserved = await tx.listing.findUniqueOrThrow({ where: { id: listing.id }, select: { status: true } });
      expect(reserved.status).toBe("RESERVED");

      const entries = await tx.ledgerEntry.findMany({ where: { orderId }, orderBy: { amountCents: "desc" } });
      expect(entries.map((e) => [e.account, e.amountCents, e.kind, e.paypalRef])).toEqual([
        ["escrow_held", 5000, "AUTHORIZE", auth.authorizationId],
        ["buyer_funds", -5000, "AUTHORIZE", auth.authorizationId],
      ]);
      expect(new Set(entries.map((e) => e.transactionId)).size).toBe(1);
    });

    // Rolled back: nothing persisted.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true } })).toEqual({
      state: "CREATED",
    });
    expect(await prisma.ledgerEntry.count({ where: { orderId } })).toBe(0);
  });

  it("rolls back everything when the order was already moved (stale version)", async () => {
    const listing = await createListing();
    const { orderId } = await startCheckout(listing.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    await expect(
      prisma.$transaction((tx) => recordAuthorization(tx, { ...order, version: 7 }, authorization(), new Date())),
    ).rejects.toThrow(/expected CREATED v7/);
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id }, select: { status: true } });
    expect(after.status).toBe("ACTIVE");
    expect(await prisma.ledgerEntry.count({ where: { orderId } })).toBe(0);
  });
});
