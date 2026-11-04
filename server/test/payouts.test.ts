import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { createPayPalClient, type PayPalClient, PayPalError, payoutSenderBatchId } from "../src/paypal/client.js";
import {
  MAX_PAYOUT_ATTEMPTS,
  PAYOUT_CHECK_AFTER_MS,
  PAYOUT_RESEND_AFTER_MS,
  PAYOUT_RETRY_BASE_MS,
  processPayout,
  sweepPayouts,
} from "../src/payouts/payouts.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi, TEST_PASSWORD } from "./helpers/api.js";

// Seller payouts against the real database with a fake PayPal client.
//
// ledger_entries is append-only, so postTransaction is stubbed here (the
// PAID_OUT posting itself is checked in webhookHandlers.test.ts, in a
// rolled-back transaction). The database is shared with real orders, so every
// order here is captured in 2001 and every run happens "in" 2001: no real
// order is ever due at that time.

vi.mock("../src/ledger/postTransaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger/postTransaction.js")>();
  return { ...actual, postTransaction: vi.fn(actual.postTransaction) };
});

const paypal = { createPayout: vi.fn(), getPayoutBatch: vi.fn() };
const fakePayPal = paypal as unknown as PayPalClient;

const NOW = new Date("2001-05-01T12:00:00.000Z");
const MIN = 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let buyerId: string;
let sellerId: string;
let sellerEmail: string;
let unpayableSellerId: string;
let payoutEmail: string;

beforeAll(async () => {
  buyerId = (await createTestUser("payout-buyer")).id;
  const seller = await createTestUser("payout-seller");
  sellerId = seller.id;
  sellerEmail = seller.email;
  payoutEmail = `seller-${randomUUID().slice(0, 8)}@personal.example.com`;
  await prisma.user.update({ where: { id: sellerId }, data: { paypalEmail: payoutEmail } });
  unpayableSellerId = (await createTestUser("payout-seller-no-paypal")).id;
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postTransaction).mockResolvedValue({ transactionId: randomUUID(), entryCount: 2 });
  paypal.createPayout.mockImplementation(async ({ attempt }: { attempt: number }) => ({
    payoutBatchId: `BATCH-${attempt}-${randomUUID()}`,
    batchStatus: "PENDING",
  }));
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** A $50 order (fee $5, so $45 to the seller) captured `capturedAgoMs` before `now`. */
async function createCapturedOrder({ seller = sellerId, now = NOW, ...extra }: Record<string, any> = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId: seller, title: "payout test", description: "test", category: "OTHER", priceCents: 5000, status: "SOLD" },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId: seller,
      state: "CAPTURED",
      version: 2,
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      paypalCaptureId: `CAP-${randomUUID()}`,
      capturedAt: new Date(now.getTime() - MIN),
      ...extra,
    },
  });
}

function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      version: true,
      payoutAttempts: true,
      payoutNextAttemptAt: true,
      payoutLastError: true,
      paypalPayoutBatchId: true,
      paypalPayoutItemId: true,
      paidOutAt: true,
    },
  });
}

function item(orderId: string, transactionStatus: string, overrides: Record<string, unknown> = {}) {
  return {
    payoutItemId: `ITEM-${randomUUID()}`,
    transactionStatus,
    senderItemId: orderId,
    amountCents: 4500,
    currency: "USD",
    errorName: null,
    ...overrides,
  };
}

describe("sending", () => {
  it("CAPTURED → PAYOUT_PENDING as attempt 1, then sends amount minus fee to the seller's PayPal email", async () => {
    const order = await createCapturedOrder();
    expect(await processPayout(fakePayPal, order.id, NOW)).toBe("sent");

    expect(paypal.createPayout).toHaveBeenCalledExactlyOnceWith({
      orderId: order.id,
      attempt: 1,
      receiverEmail: payoutEmail,
      amountCents: 4500,
      currency: "USD",
    });
    const row = await readOrder(order.id);
    expect(row).toMatchObject({ state: "PAYOUT_PENDING", version: 3, payoutAttempts: 1, payoutLastError: null });
    expect(row.paypalPayoutBatchId).toMatch(/^BATCH-1-/);
    expect(row.payoutNextAttemptAt).toEqual(at(PAYOUT_CHECK_AFTER_MS)); // check the status if no webhook comes
  });

  it("waits while the seller has no PayPal email", async () => {
    const order = await createCapturedOrder({ seller: unpayableSellerId });
    expect(await processPayout(fakePayPal, order.id, NOW)).toBe("waiting");
    expect(paypal.createPayout).not.toHaveBeenCalled();
    expect(await readOrder(order.id)).toMatchObject({ state: "CAPTURED", version: 2, payoutAttempts: 0 });
  });

  it("after a timeout, re-sends the SAME attempt (same sender_batch_id), so PayPal pays at most once", async () => {
    const order = await createCapturedOrder();
    paypal.createPayout.mockRejectedValueOnce(new PayPalError("payout-1", "timeout", "no response"));

    expect(await processPayout(fakePayPal, order.id, NOW)).toBe("failed");
    expect(await readOrder(order.id)).toMatchObject({
      state: "PAYOUT_PENDING",
      payoutAttempts: 1,
      paypalPayoutBatchId: null,
      payoutNextAttemptAt: at(PAYOUT_RESEND_AFTER_MS),
    });

    expect(await processPayout(fakePayPal, order.id, at(PAYOUT_RESEND_AFTER_MS - 1))).toBe("skipped"); // not due yet
    expect(await processPayout(fakePayPal, order.id, at(PAYOUT_RESEND_AFTER_MS))).toBe("sent");
    expect(paypal.createPayout).toHaveBeenCalledTimes(2);
    expect(paypal.createPayout.mock.calls[1]).toEqual(paypal.createPayout.mock.calls[0]);
    expect((await readOrder(order.id)).payoutAttempts).toBe(1);
  });

  it("a refused RE-send isn't retried with a new batch id (the first may have paid): flagged for review", async () => {
    const order = await createCapturedOrder();
    paypal.createPayout
      .mockRejectedValueOnce(new PayPalError("payout-1", "timeout", "no response"))
      .mockRejectedValueOnce(new PayPalError("payout-1", "http", "HTTP 400", { status: 400, paypalName: "VALIDATION_ERROR" }));

    await processPayout(fakePayPal, order.id, NOW);
    expect(await processPayout(fakePayPal, order.id, at(PAYOUT_RESEND_AFTER_MS))).toBe("review");
    const row = await readOrder(order.id);
    expect(row).toMatchObject({ state: "PAYOUT_PENDING", payoutAttempts: 1, payoutNextAttemptAt: null });
    expect(row.payoutLastError).toMatch(/^needs review: re-send of attempt 1 was refused/);

    // Never touched again automatically.
    expect(await processPayout(fakePayPal, order.id, at(365 * 24 * 60 * MIN))).toBe("skipped");
    expect(paypal.createPayout).toHaveBeenCalledTimes(2);
  });

  it("a first send refused outright → PAYOUT_RETRY, then attempt 2 with a new sender_batch_id after the backoff", async () => {
    const order = await createCapturedOrder();
    paypal.createPayout.mockRejectedValueOnce(
      new PayPalError("payout-1", "http", "HTTP 422", { status: 422, issue: "RECEIVER_ACCOUNT_LOCKED" }),
    );

    expect(await processPayout(fakePayPal, order.id, NOW)).toBe("retry");
    expect(await readOrder(order.id)).toMatchObject({
      state: "PAYOUT_RETRY",
      payoutAttempts: 1,
      payoutNextAttemptAt: at(PAYOUT_RETRY_BASE_MS),
      payoutLastError: "attempt 1: RECEIVER_ACCOUNT_LOCKED",
    });

    expect(await processPayout(fakePayPal, order.id, at(PAYOUT_RETRY_BASE_MS - 1))).toBe("skipped");
    expect(await processPayout(fakePayPal, order.id, at(PAYOUT_RETRY_BASE_MS))).toBe("sent");
    expect(paypal.createPayout.mock.calls.map(([c]) => c.attempt)).toEqual([1, 2]);
    expect(await readOrder(order.id)).toMatchObject({ state: "PAYOUT_PENDING", payoutAttempts: 2, payoutLastError: null });
  });

  it("two concurrent runs on one CAPTURED order send one payout", async () => {
    const order = await createCapturedOrder();
    const outcomes = await Promise.all([processPayout(fakePayPal, order.id, NOW), processPayout(fakePayPal, order.id, NOW)]);
    expect(outcomes.sort()).toEqual(["sent", "skipped"]);
    expect(paypal.createPayout).toHaveBeenCalledOnce();
  });
});

describe("checking a sent payout no webhook has settled", () => {
  async function sentOrder() {
    const order = await createCapturedOrder();
    await processPayout(fakePayPal, order.id, NOW);
    return order;
  }
  const checkTime = at(PAYOUT_CHECK_AFTER_MS);

  it("SUCCESS → PAID_OUT with the seller_payable → paid_out posting", async () => {
    const order = await sentOrder();
    const success = item(order.id, "SUCCESS");
    paypal.getPayoutBatch.mockResolvedValue({ batchStatus: "SUCCESS", items: [success] });

    expect(await processPayout(fakePayPal, order.id, checkTime)).toBe("paid");
    const row = await readOrder(order.id);
    expect(row).toMatchObject({ state: "PAID_OUT", paidOutAt: checkTime, paypalPayoutItemId: success.payoutItemId, payoutNextAttemptAt: null });
    expect(postTransaction).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      [
        { account: "seller_payable", amountCents: -4500 },
        { account: "paid_out", amountCents: 4500 },
      ],
      { kind: "PAYOUT", orderId: order.id, paypalRef: success.payoutItemId },
    );
  });

  it("SUCCESS for the wrong amount is flagged, not recorded", async () => {
    const order = await sentOrder();
    paypal.getPayoutBatch.mockResolvedValue({ batchStatus: "SUCCESS", items: [item(order.id, "SUCCESS", { amountCents: 5000 })] });
    expect(await processPayout(fakePayPal, order.id, checkTime)).toBe("review");
    expect(await readOrder(order.id)).toMatchObject({ state: "PAYOUT_PENDING", payoutNextAttemptAt: null });
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it("FAILED, BLOCKED, DENIED, RETURNED → PAYOUT_RETRY", async () => {
    for (const status of ["FAILED", "BLOCKED", "DENIED", "RETURNED"]) {
      const order = await sentOrder();
      paypal.getPayoutBatch.mockResolvedValue({ batchStatus: "DENIED", items: [item(order.id, status)] });
      expect(await processPayout(fakePayPal, order.id, checkTime), status).toBe("retry");
      expect(await readOrder(order.id)).toMatchObject({ state: "PAYOUT_RETRY", payoutLastError: `attempt 1: ${status}` });
    }
  });

  it("UNCLAIMED or PENDING: keeps checking later", async () => {
    const order = await sentOrder();
    paypal.getPayoutBatch.mockResolvedValue({ batchStatus: "SUCCESS", items: [item(order.id, "UNCLAIMED")] });
    expect(await processPayout(fakePayPal, order.id, checkTime)).toBe("waiting");
    expect(await readOrder(order.id)).toMatchObject({
      state: "PAYOUT_PENDING",
      payoutNextAttemptAt: at(2 * PAYOUT_CHECK_AFTER_MS),
      payoutLastError: "item UNCLAIMED",
    });
  });

  it("gives up after 5 failed attempts and leaves it in PAYOUT_RETRY for an admin", async () => {
    const order = await sentOrder();
    await prisma.order.update({ where: { id: order.id }, data: { payoutAttempts: MAX_PAYOUT_ATTEMPTS } });
    paypal.getPayoutBatch.mockResolvedValue({ batchStatus: "DENIED", items: [item(order.id, "FAILED")] });

    expect(await processPayout(fakePayPal, order.id, checkTime)).toBe("retry");
    const row = await readOrder(order.id);
    expect(row).toMatchObject({ state: "PAYOUT_RETRY", payoutNextAttemptAt: null });
    expect(row.payoutLastError).toMatch(/^needs review: gave up after 5 attempts/);
    expect(await processPayout(fakePayPal, order.id, at(365 * 24 * 60 * MIN))).toBe("skipped");
  });
});

describe("sweepPayouts", () => {
  // Earlier than every other order in this file, so only this test's orders are due.
  const SWEEP_NOW = new Date("2000-02-01T12:00:00.000Z");

  it("sends due payouts and skips sellers without a PayPal email", async () => {
    const payable = await createCapturedOrder({ now: SWEEP_NOW });
    const unpayable = await createCapturedOrder({ now: SWEEP_NOW, seller: unpayableSellerId });

    expect(await sweepPayouts(fakePayPal, { now: SWEEP_NOW })).toMatchObject({ checked: 1, sent: 1 });
    expect((await readOrder(payable.id)).state).toBe("PAYOUT_PENDING");
    expect((await readOrder(unpayable.id)).state).toBe("CAPTURED");
  });
});

describe("PayPal client: createPayout", () => {
  it("sends one EMAIL item with { currency, value }, sender_batch_id and request id per attempt", async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ batch_header: { payout_batch_id: "BATCH-X", batch_status: "PENDING" } }), {
        status: 201,
      });
    }) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });
    const orderId = randomUUID();

    expect(await client.createPayout({ orderId, attempt: 2, receiverEmail: "s@example.com", amountCents: 4500 })).toEqual({
      payoutBatchId: "BATCH-X",
      batchStatus: "PENDING",
    });
    expect(calls[0].url).toBe("https://paypal.test/v1/payments/payouts");
    expect(calls[0].headers["PayPal-Request-Id"]).toBe(`${orderId}-payout-2`);
    expect(calls[0].body.sender_batch_header.sender_batch_id).toBe(payoutSenderBatchId(orderId, 2));
    expect(calls[0].body.items).toEqual([
      {
        recipient_type: "EMAIL",
        receiver: "s@example.com",
        amount: { currency: "USD", value: "45.00" },
        sender_item_id: orderId,
        note: expect.any(String),
      },
    ]);
  });

  it("parses item statuses from GET /v1/payments/payouts/{id}", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(
            JSON.stringify({
              batch_header: { batch_status: "SUCCESS" },
              items: [
                {
                  payout_item_id: "ITEM-1",
                  transaction_status: "FAILED",
                  payout_item: { sender_item_id: "order-1", amount: { currency: "USD", value: "45.00" } },
                  errors: { name: "RECEIVER_UNREGISTERED" },
                },
              ],
            }),
          )) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });
    expect(await client.getPayoutBatch({ payoutBatchId: "B" })).toEqual({
      batchStatus: "SUCCESS",
      items: [
        {
          payoutItemId: "ITEM-1",
          transactionStatus: "FAILED",
          senderItemId: "order-1",
          amountCents: 4500,
          currency: "USD",
          errorName: "RECEIVER_UNREGISTERED",
        },
      ],
    });
  });
});

describe("PUT /api/auth/me/paypal-email", () => {
  let api: Api;
  beforeAll(async () => {
    api = await startApi({ paypal: () => fakePayPal });
  });
  afterAll(async () => {
    await api.close();
  });

  it("sets and clears the payout email, with the current password", async () => {
    const token = await login(api, sellerEmail);
    const path = "/auth/me/paypal-email";

    expect((await api.call("PUT", path, { json: { paypalEmail: "x@example.com", password: TEST_PASSWORD } })).status).toBe(401);
    expect((await api.call("PUT", path, { token, json: { paypalEmail: "x@example.com", password: "wrong" } })).status).toBe(401);
    expect((await api.call("PUT", path, { token, json: { paypalEmail: "not an email", password: TEST_PASSWORD } })).status).toBe(400);

    const set = await api.call("PUT", path, { token, json: { paypalEmail: " New@Example.com ", password: TEST_PASSWORD } });
    expect(set).toEqual({ status: 200, body: { paypalEmail: "new@example.com" } });
    const cleared = await api.call("PUT", path, { token, json: { paypalEmail: null, password: TEST_PASSWORD } });
    expect(cleared).toEqual({ status: 200, body: { paypalEmail: null } });

    // Put back the address the other tests in this file pay to.
    await prisma.user.update({ where: { id: sellerId }, data: { paypalEmail: payoutEmail } });
  });
});
