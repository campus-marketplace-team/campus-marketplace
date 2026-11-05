import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPUTE_LIMITS } from "@campus/shared";
import { voidOverdueOrder } from "../src/jobs/handoffDeadline.js";
import { notifyOrderStateChanged } from "../src/outbox/handlers.js";
import type { OutboxEvent } from "../src/outbox/outbox.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { deleteObject, uploadObject } from "../src/storage.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// "Report a problem" against the real database. Only Supabase Storage is faked.
// Reporting moves no money, so these orders have no ledger entries and
// cleanup() can delete them.

vi.mock("../src/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage.js")>()),
  getStorageConfig: () => ({ url: "https://storage.test", key: "test", bucket: "test" }),
  uploadObject: vi.fn(async (_config: unknown, path: string) => `https://storage.test/${path}`),
  deleteObject: vi.fn(async () => {}),
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HOUR = 60 * 60 * 1000;
const report = { reason: "NOT_AS_DESCRIBED", description: "The screen is cracked, unlike the photos." };

let api: Api;
let buyerId: string;
let sellerId: string;
let buyerToken: string;
let sellerToken: string;
let otherToken: string;

beforeAll(async () => {
  api = await startApi();
  const buyer = await createTestUser("dispute-buyer");
  const seller = await createTestUser("dispute-seller");
  const other = await createTestUser("dispute-other");
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
  vi.mocked(uploadObject).mockClear();
  vi.mocked(deleteObject).mockClear();
});

async function createOrder(data: { state?: "AUTHORIZED" | "CAPTURED" | "CREATED"; handoffDeadline?: Date } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "dispute test", description: "test", category: "OTHER", priceCents: 5000, status: "RESERVED" },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state: data.state ?? "AUTHORIZED",
      version: 1,
      amountCents: 5000,
      platformFeeCents: 500,
      handoffDeadline: data.handoffDeadline ?? new Date(Date.now() + 72 * HOUR),
    },
  });
}

function uploadPhoto(orderId: string, { token = buyerToken, body = PNG, type = "image/png" } = {}) {
  return fetch(`${api.url}/orders/${orderId}/dispute/photos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
    body: new Uint8Array(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function openedDispute() {
  const order = await createOrder();
  const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report });
  expect(res.status).toBe(201);
  return order;
}

describe("POST /api/orders/:id/dispute", () => {
  it("moves the order to IN_DISPUTE through the state machine and saves the report", async () => {
    const order = await createOrder();
    const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ id: order.id, state: "IN_DISPUTE", version: 2 });
    expect(res.body.dispute).toMatchObject({ ...report, status: "OPEN", photoUrls: [] });

    const row = await prisma.dispute.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row).toMatchObject({ openedById: buyerId, ...report, status: "OPEN" });

    const outbox = await prisma.outboxEvent.findMany({ where: { orderId: order.id } });
    expect(outbox.map((e) => e.payload)).toEqual([{ from: "AUTHORIZED", to: "IN_DISPUTE", version: 2 }]);
  });

  it("moves no money: nothing is posted to the ledger", async () => {
    const order = await openedDispute();
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("shows the report to both sides on the order page, without user ids", async () => {
    const order = await openedDispute();
    for (const token of [buyerToken, sellerToken]) {
      const res = await api.call("GET", `/orders/${order.id}`, { token });
      expect(res.body.order.dispute).toMatchObject({ ...report, status: "OPEN", photoUrls: [] });
      expect(res.body.order.dispute).not.toHaveProperty("openedById");
    }
    const undisputed = await createOrder();
    const res = await api.call("GET", `/orders/${undisputed.id}`, { token: buyerToken });
    expect(res.body.order.dispute).toBeNull();
  });

  it("tells both sides once, through the state change's outbox handler", async () => {
    const order = await openedDispute();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { orderId: order.id } });
    await notifyOrderStateChanged(event as unknown as OutboxEvent);
    await notifyOrderStateChanged(event as unknown as OutboxEvent);
    const notifications = await prisma.notification.findMany({ where: { orderId: order.id } });
    expect(notifications.map((n) => n.userId).sort()).toEqual([buyerId, sellerId].sort());
    expect(new Set(notifications.map((n) => n.kind))).toEqual(new Set(["ORDER_IN_DISPUTE"]));
  });

  it("only lets the buyer report", async () => {
    const order = await createOrder();
    expect((await api.call("POST", `/orders/${order.id}/dispute`, { json: report })).status).toBe(401);

    const asSeller = await api.call("POST", `/orders/${order.id}/dispute`, { token: sellerToken, json: report });
    expect(asSeller.status).toBe(403);
    expect(asSeller.body.code).toBe("NOT_BUYER");

    expect((await api.call("POST", `/orders/${order.id}/dispute`, { token: otherToken, json: report })).status).toBe(404);
    expect((await api.call("POST", "/orders/not-a-uuid/dispute", { token: buyerToken, json: report })).status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("AUTHORIZED");
  });

  it.each([
    ["no reason", { description: "x" }],
    ["an unknown reason", { reason: "REFUND_ME_NOW", description: "x" }],
    ["a PayPal-only reason", { reason: "PAYPAL_OTHER", description: "x" }],
    ["no description", { reason: "OTHER" }],
    ["a blank description", { reason: "OTHER", description: "   " }],
    ["a non-string description", { reason: "OTHER", description: { $ne: "" } }],
    ["a description that's too long", { reason: "OTHER", description: "x".repeat(DISPUTE_LIMITS.descriptionMax + 1) }],
  ])("rejects %s and leaves the order alone", async (_name, json) => {
    const order = await createOrder();
    const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json });
    expect(res.status).toBe(400);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { dispute: true } });
    expect(after).toMatchObject({ state: "AUTHORIZED", version: 1, dispute: null });
  });

  it.each(["CREATED", "CAPTURED"] as const)("refuses a %s order", async (state) => {
    const order = await createOrder({ state });
    const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORDER_NOT_DISPUTABLE");
  });

  it("refuses a second report", async () => {
    const order = await openedDispute();
    const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DISPUTED");
  });

  it("refuses after the handoff deadline, when the hold is about to be voided", async () => {
    const order = await createOrder({ handoffDeadline: new Date(Date.now() - 1000) });
    const res = await api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HANDOFF_EXPIRED");
  });

  it("lets one of two concurrent reports win, and writes everything once", async () => {
    const order = await createOrder();
    const results = await Promise.all(
      [1, 2, 3].map(() => api.call("POST", `/orders/${order.id}/dispute`, { token: buyerToken, json: report })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ state: "IN_DISPUTE", version: 2 });
    expect(await prisma.dispute.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("stops the handoff: no new QR code, and the deadline sweeper leaves it alone", async () => {
    const order = await openedDispute();

    const token = await api.call("POST", `/orders/${order.id}/handoff-token`, { token: sellerToken });
    expect(token.status).toBe(409);
    expect(token.body.code).toBe("ORDER_NOT_AUTHORIZED");

    await prisma.order.update({ where: { id: order.id }, data: { handoffDeadline: new Date(Date.now() - 24 * HOUR) } });
    // Returns before touching PayPal, so an empty client proves it wasn't called.
    expect(await voidOverdueOrder({} as PayPalClient, order.id)).toBe("skipped");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("IN_DISPUTE");
  });
});

describe("POST /api/orders/:id/dispute/photos", () => {
  it("adds photos to the open dispute, under the order's folder", async () => {
    const order = await openedDispute();
    const first = await uploadPhoto(order.id);
    const second = await uploadPhoto(order.id);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.dispute.photoUrls).toHaveLength(2);
    expect(second.body.dispute.photoUrls[0]).toMatch(new RegExp(`/disputes/${order.id}/[0-9a-f-]+\\.png$`));

    const row = await prisma.dispute.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.photoUrls).toEqual(second.body.dispute.photoUrls);
  });

  it("only lets the buyer add photos", async () => {
    const order = await openedDispute();
    expect((await uploadPhoto(order.id, { token: sellerToken })).status).toBe(403);
    expect((await uploadPhoto(order.id, { token: otherToken })).status).toBe(404);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("needs a dispute to add to", async () => {
    const order = await createOrder();
    expect((await uploadPhoto(order.id)).status).toBe(404);
  });

  it("goes by the file's bytes, not its claimed type", async () => {
    const order = await openedDispute();
    const res = await uploadPhoto(order.id, { body: Buffer.from("<script>alert(1)</script>"), type: "image/png" });
    expect(res.status).toBe(415);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("refuses other content types", async () => {
    const order = await openedDispute();
    expect((await uploadPhoto(order.id, { type: "text/html" })).status).toBe(415);
  });

  it("freezes the evidence once the dispute is being decided", async () => {
    const order = await openedDispute();
    await prisma.dispute.update({ where: { orderId: order.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await uploadPhoto(order.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DISPUTE_CLOSED");
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("never goes past the limit, even with concurrent uploads, and deletes what didn't fit", async () => {
    const order = await openedDispute();
    const results = await Promise.all(Array.from({ length: DISPUTE_LIMITS.photosMax + 2 }, () => uploadPhoto(order.id)));

    const row = await prisma.dispute.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.photoUrls).toHaveLength(DISPUTE_LIMITS.photosMax);
    expect(results.filter((r) => r.status === 201)).toHaveLength(DISPUTE_LIMITS.photosMax);
    const refused = results.filter((r) => r.status !== 201);
    expect(refused.map((r) => r.status)).toEqual([409, 409]);
    expect(vi.mocked(deleteObject).mock.calls.length).toBe(vi.mocked(uploadObject).mock.calls.length - DISPUTE_LIMITS.photosMax);

    const more = await uploadPhoto(order.id);
    expect(more.status).toBe(409);
    expect(more.body.code).toBe("TOO_MANY_PHOTOS");
  });
});
