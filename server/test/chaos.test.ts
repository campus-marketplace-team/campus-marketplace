import { randomUUID } from "node:crypto";
import type { OrderState } from "@campus/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_DELIVERIES } from "../src/admin/chaos.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { isSandboxBaseUrl, type PayPalClient } from "../src/paypal/client.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// POST /api/admin/chaos/:scenario against the real database with a fake PayPal
// client. ledger_entries is append-only, so postTransaction is stubbed (as in
// handoffDeadline.test.ts) and cleanup() can delete the test orders. Each
// scenario only touches the order it's given, and the deployed worker skips
// test users, so the shared database's real orders are never affected.

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

const HOUR = 60 * 60 * 1000;

let api: Api;
let adminToken: string;
let userToken: string;
let buyerId: string;
let sellerId: string;
const webhookEventIds: string[] = [];

beforeAll(async () => {
  api = await startApi({ paypal: () => fakePayPal });
  const admin = await createTestUser("chaos-admin");
  await prisma.user.update({ where: { id: admin.id }, data: { isAdmin: true } });
  adminToken = await login(api, admin.email);
  const buyer = await createTestUser("chaos-buyer");
  buyerId = buyer.id;
  userToken = await login(api, buyer.email);
  sellerId = (await createTestUser("chaos-seller")).id;
});

afterAll(async () => {
  await api.close();
  await prisma.webhookEvent.deleteMany({ where: { id: { in: webhookEventIds } } });
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postTransaction).mockResolvedValue({ transactionId: randomUUID(), entryCount: 2 });
  paypal.voidAuthorization.mockResolvedValue({ status: "VOIDED" });
  // Values are made up; only the base URL's host matters to the sandbox check.
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function createOrder({ state = "AUTHORIZED" as OrderState, deadlineInMs = 24 * HOUR } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "chaos test", description: "test", category: "OTHER", priceCents: 5000, status: "RESERVED" },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state,
      version: 1,
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      authorizedAt: new Date(),
      handoffDeadline: new Date(Date.now() + deadlineInMs),
    },
  });
}

const chaos = (scenario: string, orderId: unknown, token = adminToken) =>
  api.call("POST", `/admin/chaos/${scenario}`, { token, json: { orderId } });

async function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id },
    select: { state: true, version: true, paypalCaptureId: true, handoffDeadline: true, listing: { select: { status: true } } },
  });
}

describe("isSandboxBaseUrl", () => {
  it("accepts only PayPal's sandbox API over https", () => {
    expect(isSandboxBaseUrl("https://api-m.sandbox.paypal.com")).toBe(true);
    expect(isSandboxBaseUrl("https://api.sandbox.paypal.com/")).toBe(true);
    expect(isSandboxBaseUrl("https://api-m.paypal.com")).toBe(false);
    expect(isSandboxBaseUrl("http://api-m.sandbox.paypal.com")).toBe(false);
    expect(isSandboxBaseUrl("https://api-m.sandbox.paypal.com.evil.example")).toBe(false);
    expect(isSandboxBaseUrl("")).toBe(false);
    expect(isSandboxBaseUrl(null)).toBe(false);
  });
});

describe("access", () => {
  it("is admins only", async () => {
    const order = await createOrder();
    expect((await api.call("POST", "/admin/chaos/expire-deadline", { json: { orderId: order.id } })).status).toBe(401);
    expect((await chaos("expire-deadline", order.id, userToken)).status).toBe(403);
    expect((await readOrder(order.id)).state).toBe("AUTHORIZED");
  });

  it("refuses to run unless PayPal is the sandbox, and the dashboard says so", async () => {
    const order = await createOrder();
    expect((await api.call("GET", "/admin/dashboard", { token: adminToken })).body.chaosEnabled).toBe(true);

    vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.paypal.com");
    const res = await chaos("expire-deadline", order.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CHAOS_DISABLED");
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).state).toBe("AUTHORIZED");
    expect((await api.call("GET", "/admin/dashboard", { token: adminToken })).body.chaosEnabled).toBe(false);
  });

  it("404s an unknown scenario or order", async () => {
    expect((await chaos("drop-database", randomUUID())).status).toBe(404);
    expect((await chaos("expire-deadline", randomUUID())).status).toBe(404);
    expect((await chaos("expire-deadline", "not-a-uuid")).status).toBe(404);
  });
});

describe("duplicate-webhook", () => {
  it("redelivers a processed event: deduped, not processed again, the order unchanged", async () => {
    const order = await createOrder();
    const eventId = `WH-chaos-${randomUUID()}`;
    const stored = await prisma.webhookEvent.create({
      data: {
        eventId,
        eventType: "PAYMENT.AUTHORIZATION.CREATED",
        resourceId: order.paypalAuthorizationId,
        payload: { id: eventId, event_type: "PAYMENT.AUTHORIZATION.CREATED", resource: { id: order.paypalAuthorizationId } },
        processedAt: new Date(),
      },
    });
    webhookEventIds.push(stored.id);

    const res = await chaos("duplicate-webhook", order.id);
    expect(res.status).toBe(200);
    expect(res.body.order).toEqual({ state: "AUTHORIZED", version: 1 });
    expect(res.body.steps.map((s: { label: string }) => s.label)).toContain(`Redelivered it ${DUPLICATE_DELIVERIES} times at once`);
    expect(res.body.steps.at(-1).label).toBe("Nothing changed");

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    const queued = await prisma.outboxEvent.findMany({ where: { topic: "paypal.webhook", status: { in: ["PENDING", "PROCESSING"] } }, select: { payload: true } });
    expect(queued.filter((q) => (q.payload as { webhookEventId?: string }).webhookEventId === stored.id)).toEqual([]);
  });

  it("409s an order with no processed webhook", async () => {
    const order = await createOrder();
    const res = await chaos("duplicate-webhook", order.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_WEBHOOK");
  });
});

describe("capture-timeout", () => {
  it("drops the first answer, retries with the same request, and records one capture", async () => {
    const order = await createOrder();
    const captureId = `CAP-${randomUUID()}`;
    paypal.captureAuthorization.mockResolvedValue({ captureId, status: "COMPLETED", amountCents: 5000, currency: "USD" });

    const res = await chaos("capture-timeout", order.id);
    expect(res.status).toBe(200);
    expect(res.body.order).toEqual({ state: "CAPTURED", version: 2 });

    // Both calls are the same request (same order and action, so the same PayPal-Request-Id).
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(2);
    expect(paypal.captureAuthorization.mock.calls[1]).toEqual(paypal.captureAuthorization.mock.calls[0]);
    expect(paypal.captureAuthorization.mock.calls[0][0]).toMatchObject({ orderId: order.id, authorizationId: order.paypalAuthorizationId, amountCents: 5000 });
    expect(paypal.captureAuthorization.mock.calls[0][0].action).toBeUndefined(); // the default "capture"

    expect(postTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postTransaction).mock.calls[0][2]).toMatchObject({ kind: "CAPTURE", orderId: order.id, paypalRef: captureId });
    expect(await readOrder(order.id)).toMatchObject({ state: "CAPTURED", paypalCaptureId: captureId, listing: { status: "SOLD" } });
  });

  it("records nothing if PayPal answers the retry with a different capture", async () => {
    const order = await createOrder();
    paypal.captureAuthorization
      .mockResolvedValueOnce({ captureId: `CAP-${randomUUID()}`, status: "COMPLETED", amountCents: 5000, currency: "USD" })
      .mockResolvedValueOnce({ captureId: `CAP-${randomUUID()}`, status: "COMPLETED", amountCents: 5000, currency: "USD" });

    const res = await chaos("capture-timeout", order.id);
    expect(res.status).toBe(502);
    expect(postTransaction).not.toHaveBeenCalled();
    expect(await readOrder(order.id)).toMatchObject({ state: "AUTHORIZED", version: 1, paypalCaptureId: null });
  });

  it("409s an order that isn't AUTHORIZED, or whose deadline has passed, without calling PayPal", async () => {
    const captured = await createOrder({ state: "CAPTURED" });
    expect((await chaos("capture-timeout", captured.id)).body.code).toBe("ORDER_NOT_AUTHORIZED");
    const late = await createOrder({ deadlineInMs: -HOUR });
    expect((await chaos("capture-timeout", late.id)).body.code).toBe("HANDOFF_EXPIRED");
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });
});

describe("expire-deadline", () => {
  it("moves the deadline into the past, refuses QR codes, and voids now", async () => {
    const order = await createOrder();

    const res = await chaos("expire-deadline", order.id);
    expect(res.status).toBe(200);
    expect(res.body.order).toEqual({ state: "VOIDED", version: 2 });
    expect(res.body.steps.map((s: { detail: string }) => s.detail).join(" ")).toContain("HANDOFF_EXPIRED");

    expect(paypal.voidAuthorization).toHaveBeenCalledTimes(1);
    expect(paypal.voidAuthorization).toHaveBeenCalledWith({ orderId: order.id, authorizationId: order.paypalAuthorizationId });
    expect(vi.mocked(postTransaction).mock.calls[0][2]).toMatchObject({ kind: "VOID", orderId: order.id });
    const after = await readOrder(order.id);
    expect(after).toMatchObject({ state: "VOIDED", listing: { status: "ACTIVE" } });
    expect(after.handoffDeadline!.getTime()).toBeLessThan(Date.now());
    expect(await prisma.qrToken.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("409s an order that isn't AUTHORIZED and leaves its deadline alone", async () => {
    const order = await createOrder({ state: "CAPTURED" });
    const res = await chaos("expire-deadline", order.id);
    expect(res.status).toBe(409);
    expect((await readOrder(order.id)).handoffDeadline).toEqual(order.handoffDeadline);
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
  });
});
