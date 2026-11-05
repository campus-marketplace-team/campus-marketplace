import { HANDOFF_TOKEN_TTL_SECONDS } from "@campus/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSessionToken, verifyHandoffToken } from "../src/auth/tokens.js";
import type { Db } from "../src/db.js";
import { issueHandoffToken, recordCapture } from "../src/orders/handoff.js";
import { type Capture, type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// QR handoff against the real database with a fake PayPal client.
//
// ledger_entries is append-only, so no test may commit a capture: the happy
// path (recordCapture) runs in a rolled-back transaction, and the API tests
// only cover paths that stop before the ledger. Orders are inserted directly
// as AUTHORIZED (no ledger entries) so cleanup() can delete them.

const paypal = {
  createOrder: vi.fn(),
  authorizeOrder: vi.fn(),
  captureAuthorization: vi.fn(),
  voidAuthorization: vi.fn(),
};

let api: Api;
let buyerId: string;
let sellerId: string;
let buyerToken: string;
let sellerToken: string;
let otherToken: string;

beforeAll(async () => {
  api = await startApi({ paypal: () => paypal as unknown as PayPalClient });
  const buyer = await createTestUser("qr-buyer");
  const seller = await createTestUser("qr-seller");
  const other = await createTestUser("qr-other");
  buyerId = buyer.id;
  sellerId = seller.id;
  buyerToken = await login(api, buyer.email);
  sellerToken = await login(api, seller.email);
  otherToken = await login(api, other.email);
});

afterAll(async () => {
  await cleanup();
  await api.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
});

const HOUR = 60 * 60 * 1000;

async function createAuthorizedOrder({ amountCents = 5000, platformFeeCents = 500, deadlineInMs = 72 * HOUR } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "handoff test", description: "test", category: "OTHER", priceCents: amountCents, status: "RESERVED" },
    select: { id: true },
  });
  const now = Date.now();
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state: "AUTHORIZED",
      version: 1,
      amountCents,
      platformFeeCents,
      paypalOrderId: `PPORDER-${crypto.randomUUID()}`,
      paypalAuthorizationId: `AUTH-${crypto.randomUUID()}`,
      authorizedAt: new Date(now),
      handoffDeadline: new Date(now + deadlineInMs),
    },
  });
}

async function issue(orderId: string) {
  const res = await api.call("POST", `/orders/${orderId}/handoff-token`, { token: sellerToken });
  expect(res.status).toBe(201);
  return res.body as { token: string; expiresAt: string };
}

function scan(token: unknown, as = buyerToken) {
  return api.call("POST", "/orders/handoff/scan", { token: as, json: { token } });
}

async function nonceOf(token: string) {
  return (await verifyHandoffToken(token))!.claims.nonce;
}

async function readQrToken(token: string) {
  return prisma.qrToken.findUniqueOrThrow({ where: { nonce: await nonceOf(token) } });
}

async function scansFor(orderId: string) {
  return prisma.qrScan.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

async function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id }, select: { state: true, version: true } });
}

function capture(overrides: Partial<Capture> = {}): Capture {
  return { captureId: `CAP-${crypto.randomUUID()}`, status: "COMPLETED", amountCents: 5000, currency: "USD", ...overrides };
}

describe("POST /api/orders/:id/handoff-token (seller)", () => {
  it("returns a signed 5-minute token bound to the order, the seller and a new nonce", async () => {
    const order = await createAuthorizedOrder();
    const before = Date.now();
    const { token, expiresAt } = await issue(order.id);

    const verified = await verifyHandoffToken(token);
    expect(verified?.status).toBe("valid");
    expect(verified!.claims).toMatchObject({ orderId: order.id, sellerId });

    const row = await readQrToken(token);
    expect(row).toMatchObject({ orderId: order.id, sellerId, usedAt: null });
    expect(row.expiresAt.toISOString()).toBe(expiresAt);
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(HANDOFF_TOKEN_TTL_SECONDS * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(HANDOFF_TOKEN_TTL_SECONDS * 1000 + 1000);
  });

  it("gives a different nonce every time", async () => {
    const order = await createAuthorizedOrder();
    const a = await issue(order.id);
    const b = await issue(order.id);
    expect(await nonceOf(a.token)).not.toBe(await nonceOf(b.token));
  });

  it("is seller-only: the buyer and others get 404", async () => {
    const order = await createAuthorizedOrder();
    for (const token of [buyerToken, otherToken]) {
      expect((await api.call("POST", `/orders/${order.id}/handoff-token`, { token })).status).toBe(404);
    }
    expect((await api.call("POST", `/orders/${order.id}/handoff-token`)).status).toBe(401);
  });

  it("refuses an order that isn't AUTHORIZED or is past its deadline", async () => {
    const created = await createAuthorizedOrder();
    await prisma.order.update({ where: { id: created.id }, data: { state: "CREATED" } });
    const res = await api.call("POST", `/orders/${created.id}/handoff-token`, { token: sellerToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORDER_NOT_AUTHORIZED");

    const late = await createAuthorizedOrder({ deadlineInMs: -HOUR });
    const lateRes = await api.call("POST", `/orders/${late.id}/handoff-token`, { token: sellerToken });
    expect(lateRes.status).toBe(409);
    expect(lateRes.body.code).toBe("HANDOFF_EXPIRED");
  });
});

describe("POST /api/orders/handoff/scan (rejections: nothing used up, PayPal not called)", () => {
  it("logs the client IP from True-Client-IP", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    const res = await fetch(`${api.url}/orders/handoff/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json", "True-Client-IP": "203.0.113.9", "X-Forwarded-For": "10.0.0.1" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await scansFor(order.id)).map((s) => s.ip)).toEqual(["203.0.113.9"]);
  });

  it("needs a login", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    expect((await api.call("POST", "/orders/handoff/scan", { json: { token } })).status).toBe(401);
  });

  it("rejects garbage and logs the scan with no order", async () => {
    const before = await prisma.qrScan.count({ where: { scannerId: buyerId, orderId: null } });
    for (const token of ["not-a-token", "", 42, "x".repeat(5000)]) {
      const res = await scan(token);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_TOKEN");
    }
    const after = await prisma.qrScan.findMany({
      where: { scannerId: buyerId, orderId: null },
      orderBy: { createdAt: "desc" },
      take: 4,
    });
    expect(after.length).toBeGreaterThanOrEqual(4);
    expect(await prisma.qrScan.count({ where: { scannerId: buyerId, orderId: null } })).toBe(before + 4);
    expect(after.every((s) => s.result === "REJECTED" && s.reason === "INVALID_TOKEN")).toBe(true);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a tampered token and a token of another kind", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    const [header, payload, sig] = token.split(".");
    const tampered = `${header}.${payload}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    const session = await signSessionToken(order.id); // valid signature, wrong audience

    for (const bad of [tampered, session]) {
      const res = await scan(bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_TOKEN");
    }
    expect((await readQrToken(token)).usedAt).toBeNull();
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("only the order's buyer can redeem (not the seller, not someone else)", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);

    for (const as of [otherToken, sellerToken]) {
      const res = await scan(token, as);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("NOT_BUYER");
    }
    expect((await readQrToken(token)).usedAt).toBeNull();
    expect((await scansFor(order.id)).map((s) => [s.result, s.reason])).toEqual([
      ["REJECTED", "NOT_BUYER"],
      ["REJECTED", "NOT_BUYER"],
    ]);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const order = await createAuthorizedOrder();
    // Issued 6 minutes ago, so both the JWT and the qr_tokens row have expired.
    const { token } = await issueHandoffToken(sellerId, order.id, new Date(Date.now() - 6 * 60 * 1000));

    const res = await scan(token);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("EXPIRED");
    expect((await readQrToken(token)).usedAt).toBeNull();
    expect((await scansFor(order.id)).map((s) => [s.result, s.reason])).toEqual([["REJECTED", "EXPIRED"]]);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a replayed (already used) token", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    await prisma.qrToken.update({ where: { nonce: await nonceOf(token) }, data: { usedAt: new Date(), usedById: buyerId } });

    const res = await scan(token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_USED");
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a scan after the handoff deadline", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { handoffDeadline: new Date(Date.now() - 1000) } });

    const res = await scan(token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HANDOFF_EXPIRED");
    expect((await readQrToken(token)).usedAt).toBeNull();
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects an order that isn't AUTHORIZED any more", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { state: "VOIDED", version: 2 } });

    const res = await scan(token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORDER_NOT_AUTHORIZED");
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/handoff/scan (token used up, capture didn't complete)", () => {
  it("captures exactly the authorized amount; a failed capture leaves the order AUTHORIZED and the token spent", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    paypal.captureAuthorization.mockRejectedValueOnce(new PayPalError("capture", "timeout", "no response"));

    const res = await scan(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PAYPAL_UNAVAILABLE");
    expect(paypal.captureAuthorization).toHaveBeenCalledWith({
      orderId: order.id,
      authorizationId: order.paypalAuthorizationId,
      amountCents: 5000,
      currency: "USD",
    });

    const row = await readQrToken(token);
    expect(row.usedAt).not.toBeNull();
    expect(row.usedById).toBe(buyerId);
    expect(row.scanMeta).toMatchObject({ ip: expect.any(String) });
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);

    // The same code can't be scanned again; the seller shows a new one.
    const replay = await scan(token);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("ALREADY_USED");
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(1);

    const scans = await scansFor(order.id);
    expect(scans.map((s) => [s.result, s.reason])).toEqual([
      ["FAILED", "PAYPAL_UNAVAILABLE"],
      ["REJECTED", "ALREADY_USED"],
    ]);
    expect(scans.every((s) => s.scannerId === buyerId && s.qrTokenId === row.id && s.ip)).toBe(true);
  });

  it("accepts a pasted code with stray whitespace and line breaks", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    paypal.captureAuthorization.mockRejectedValueOnce(new PayPalError("capture", "timeout", "no response"));
    const pasted = `\n  ${token.slice(0, 100)}\r\n${token.slice(100, 200)} ${token.slice(200)}\t\n`;

    const res = await scan(pasted);
    // Got past every token check and used the nonce; only the (fake) capture failed.
    expect(res.body.code).toBe("PAYPAL_UNAVAILABLE");
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(1);
    expect((await readQrToken(token)).usedById).toBe(buyerId);
  });

  it("two simultaneous scans of one token reach PayPal only once", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    paypal.captureAuthorization.mockRejectedValue(
      new PayPalError("capture", "http", "HTTP 422", { status: 422, issue: "AUTHORIZATION_VOIDED" }),
    );

    const results = await Promise.all([scan(token), scan(token)]);
    expect(results.map((r) => r.body.code).sort()).toEqual(["ALREADY_USED", "AUTHORIZATION_GONE"]);
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(1);
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
  });

  it("records nothing when PayPal declines the capture", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    paypal.captureAuthorization.mockResolvedValueOnce(capture({ status: "DECLINED" }));

    const res = await scan(token);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("CAPTURE_DECLINED");
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("records nothing when PayPal captures a different amount", async () => {
    const order = await createAuthorizedOrder();
    const { token } = await issue(order.id);
    paypal.captureAuthorization.mockResolvedValueOnce(capture({ amountCents: 4999 }));

    const res = await scan(token);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("CAPTURE_MISMATCH");
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
    expect((await scansFor(order.id)).map((s) => [s.result, s.reason])).toEqual([["FAILED", "CAPTURE_MISMATCH"]]);
  });
});

describe("recordCapture (the one DB transaction)", () => {
  class Rollback extends Error {}

  async function inRolledBackTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it("moves the order to CAPTURED, marks the listing SOLD, and posts escrow → seller + fee", async () => {
    const order = await createAuthorizedOrder();
    const cap = capture();
    const now = new Date("2026-10-22T15:00:00.000Z");

    await inRolledBackTx(async (tx) => {
      await recordCapture(tx, order, cap, now);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the ledger's commit-time balance check

      const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated).toMatchObject({ state: "CAPTURED", version: 2, paypalCaptureId: cap.captureId, capturedAt: now });

      const listing = await tx.listing.findUniqueOrThrow({ where: { id: order.listingId }, select: { status: true } });
      expect(listing.status).toBe("SOLD");

      const entries = await tx.ledgerEntry.findMany({ where: { orderId: order.id }, orderBy: { amountCents: "desc" } });
      expect(entries.map((e) => [e.account, e.amountCents, e.kind, e.paypalRef])).toEqual([
        ["seller_payable", 4500, "CAPTURE", cap.captureId],
        ["platform_fees", 500, "CAPTURE", cap.captureId],
        ["escrow_held", -5000, "CAPTURE", cap.captureId],
      ]);
      expect(entries.reduce((sum, e) => sum + e.amountCents, 0)).toBe(0);
      expect(new Set(entries.map((e) => e.transactionId)).size).toBe(1);
    });

    // Rolled back: nothing persisted.
    expect(await readOrder(order.id)).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("leaves out the fee entry when the fee rounds to zero", async () => {
    const order = await createAuthorizedOrder({ amountCents: 5, platformFeeCents: 0 });

    await inRolledBackTx(async (tx) => {
      await recordCapture(tx, order, capture({ amountCents: 5 }), new Date());
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      const entries = await tx.ledgerEntry.findMany({ where: { orderId: order.id }, orderBy: { amountCents: "desc" } });
      expect(entries.map((e) => [e.account, e.amountCents])).toEqual([
        ["seller_payable", 5],
        ["escrow_held", -5],
      ]);
    });
  });

  it("rolls back everything when the order was already moved (stale version)", async () => {
    const order = await createAuthorizedOrder();

    await expect(
      prisma.$transaction((tx) => recordCapture(tx, { ...order, version: 7 }, capture(), new Date())),
    ).rejects.toThrow(/expected AUTHORIZED v7/);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: order.listingId }, select: { status: true } });
    expect(listing.status).toBe("RESERVED");
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });
});
