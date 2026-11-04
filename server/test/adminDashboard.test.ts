import { randomUUID } from "node:crypto";
import { ORDER_STATES } from "@campus/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// GET /api/admin/dashboard against the real (shared) database, so the
// numbers include real data: the checks are about access, shape, and this
// file's own rows showing up correctly.

let api: Api;
let adminToken: string;
let userToken: string;
let orderId: string;

beforeAll(async () => {
  api = await startApi();
  const admin = await createTestUser("dash-admin");
  await prisma.user.update({ where: { id: admin.id }, data: { isAdmin: true } });
  const user = await createTestUser("dash-user");
  adminToken = await login(api, admin.email);
  userToken = await login(api, user.email);

  const listing = await prisma.listing.create({
    data: { sellerId: user.id, title: "dashboard test", description: "test", category: "OTHER", priceCents: 5000, status: "SOLD" },
  });
  const order = await prisma.order.create({
    data: { listingId: listing.id, buyerId: admin.id, sellerId: user.id, state: "PAYOUT_RETRY", amountCents: 5000, platformFeeCents: 500 },
  });
  orderId = order.id;
  await prisma.reconciliationFlag.create({
    data: { orderId, kind: "PAID_OUT", message: "test mismatch", ledger: { paidOut: 0 }, paypal: { paidOut: 4500 } },
  });
  await prisma.outboxEvent.create({
    data: { orderId, topic: `test.dashboard.${randomUUID().slice(0, 8)}`, payload: { n: 1 }, status: "DEAD", attempts: 5, lastError: "boom" },
  });
});

afterAll(async () => {
  await api.close();
  await cleanup();
  await prisma.$disconnect();
});

describe("GET /api/admin/dashboard", () => {
  it("is admins only: 401 without a login, 403 for a normal user", async () => {
    expect((await api.call("GET", "/admin/dashboard")).status).toBe(401);
    expect((await api.call("GET", "/admin/dashboard", { token: userToken })).status).toBe(403);
  });

  it("returns orders by state, ledger money totals, orders, flags and dead letters", async () => {
    const res = await api.call("GET", "/admin/dashboard", { token: adminToken });
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.ordersByState.map((s: { state: string }) => s.state)).toEqual([...ORDER_STATES]);
    expect(body.ordersByState.find((s: { state: string }) => s.state === "PAYOUT_RETRY").count).toBeGreaterThanOrEqual(1);
    for (const key of ["held", "captured", "paidOut", "sellerPayable", "platformFees"]) {
      expect(Number.isInteger(body.money[key]), key).toBe(true);
    }
    expect(body.money.captured).toBe(body.money.sellerPayable + body.money.platformFees + body.money.paidOut);

    const order = body.orders.find((o: { id: string }) => o.id === orderId);
    expect(order).toMatchObject({
      state: "PAYOUT_RETRY",
      amountCents: 5000,
      listingTitle: "dashboard test",
      ledger: { held: 0, captured: 0, paidOut: 0, sellerPayable: 0, platformFees: 0 },
    });
    expect(body.flags.find((f: { orderId: string }) => f.orderId === orderId)).toMatchObject({
      kind: "PAID_OUT",
      status: "OPEN",
      message: "test mismatch",
      orderState: "PAYOUT_RETRY",
    });
    expect(body.openFlagCount).toBeGreaterThanOrEqual(1);
    expect(body.deadLetters.find((d: { orderId: string }) => d.orderId === orderId)).toMatchObject({
      attempts: 5,
      lastError: "boom",
      payload: '{"n":1}',
    });
    expect(body.deadLetterCount).toBeGreaterThanOrEqual(1);
  });
});
