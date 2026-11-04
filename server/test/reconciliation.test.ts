import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compare,
  expectedTotals,
  type LedgerTotals,
  ledgerTotals,
  QUIET_MS,
  reconcileOrder,
  sweepReconciliation,
} from "../src/jobs/reconciliation.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { createPayPalClient, type PaymentRecord, type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// Reconciliation job against the real database with a fake PayPal client.
// ledger_entries is append-only, so the job tests pass in ledger totals
// (readLedger) and the real ledgerTotals is checked in a rolled-back
// transaction. The database is shared, so every order here was last updated
// in 2001 and every sweep runs "in" 2001: real orders are never picked.

const paypal = { getAuthorization: vi.fn(), getCapture: vi.fn(), getRefund: vi.fn(), getPayoutBatch: vi.fn() };
const fakePayPal = paypal as unknown as PayPalClient;

const NOW = new Date("2001-10-01T12:00:00.000Z");
const MIN = 60 * 1000;

let buyerId: string;
let sellerId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("recon-buyer")).id;
  sellerId = (await createTestUser("recon-seller")).id;
});

beforeEach(() => {
  vi.resetAllMocks();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const record = (id: string, status: string, amountCents: number | null = 5000): PaymentRecord => ({
  id,
  status,
  amountCents,
  currency: "USD",
});
const totals = (held: number, captured: number, paidOut: number, refundRefs: string[] = []): LedgerTotals => ({
  held,
  captured,
  paidOut,
  refundRefs,
});

/** A $50 order with the given PayPal ids, last changed an hour before `now`. */
async function createOrder({ captured = false, payout = false, now = NOW, updatedAgo = 60 * MIN } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "recon test", description: "test", category: "OTHER", priceCents: 5000, status: "SOLD" },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state: payout ? "PAID_OUT" : captured ? "CAPTURED" : "AUTHORIZED",
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      paypalCaptureId: captured || payout ? `CAP-${randomUUID()}` : null,
      paypalPayoutBatchId: payout ? `BATCH-${randomUUID()}` : null,
      updatedAt: new Date(now.getTime() - updatedAgo),
    },
  });
}

async function flags(orderId: string) {
  return prisma.reconciliationFlag.findMany({ where: { orderId }, orderBy: { kind: "asc" } });
}

describe("expectedTotals + compare (what PayPal's records imply)", () => {
  const order = { amountCents: 5000 };
  const none = { authorization: null, capture: null, refunds: [], payoutItem: null };

  it("an authorization still holding funds agrees with escrow_held", () => {
    const records = { ...none, authorization: record("A", "CREATED") };
    expect(expectedTotals(order, records)).toEqual({ held: 5000, captured: 0, paidOut: 0 });
    expect(compare(totals(5000, 0, 0), expectedTotals(order, records), records)).toEqual([]);
  });

  it("a completed capture and successful payout agree with the post-payout ledger", () => {
    const records = {
      ...none,
      authorization: record("A", "CAPTURED"),
      capture: record("C", "COMPLETED"),
      payoutItem: { payoutItemId: "I", transactionStatus: "SUCCESS", senderItemId: "o", amountCents: 4500, currency: "USD", errorName: null },
    };
    expect(expectedTotals(order, records)).toEqual({ held: 0, captured: 5000, paidOut: 4500 });
    // After payout: seller_payable 0, platform_fees 500, paid_out 4500 → captured 5000.
    expect(compare(totals(0, 5000, 4500), expectedTotals(order, records), records)).toEqual([]);
  });

  it("subtracts completed refunds from the capture", () => {
    const records = {
      ...none,
      capture: record("C", "PARTIALLY_REFUNDED"),
      refunds: [record("R1", "COMPLETED", 2000), record("R2", "FAILED", 1000)],
    };
    expect(expectedTotals(order, records).captured).toBe(3000);
    expect(compare(totals(0, 3000, 0, ["R1", "R2"]), expectedTotals(order, records), records)).toEqual([]);
  });

  it("flags money captured at PayPal that the ledger still shows as held", () => {
    const records = { ...none, authorization: record("A", "CAPTURED") };
    const kinds = compare(totals(5000, 0, 0), expectedTotals(order, records), records).map((m) => m.kind);
    expect(kinds).toEqual(["HELD", "CAPTURED"]);
  });

  it("flags a refund PayPal shows but the ledger never recorded", () => {
    const records = { ...none, capture: record("C", "PARTIALLY_REFUNDED") };
    const mismatches = compare(totals(0, 5000, 0), expectedTotals(order, records), records);
    expect(mismatches).toEqual([{ kind: "CAPTURED", message: "PayPal's capture is PARTIALLY_REFUNDED, but the ledger has no refund" }]);
  });
});

describe("ledgerTotals", () => {
  it("sums an order's entries into held / captured / paid out, with its refund ids", async () => {
    const order = await createOrder({ captured: true });
    class Rollback extends Error {}
    await expect(
      prisma.$transaction(async (tx) => {
        const post = (entries: Parameters<typeof postTransaction>[1], kind: string, paypalRef?: string) =>
          postTransaction(tx, entries, { kind, orderId: order.id, paypalRef });
        await post([{ account: "escrow_held", amountCents: 5000 }, { account: "buyer_funds", amountCents: -5000 }], "AUTHORIZE");
        await post(
          [
            { account: "escrow_held", amountCents: -5000 },
            { account: "seller_payable", amountCents: 4500 },
            { account: "platform_fees", amountCents: 500 },
          ],
          "CAPTURE",
        );
        await post([{ account: "seller_payable", amountCents: -1000 }, { account: "buyer_funds", amountCents: 1000 }], "REFUND", "REF-1");
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;

        expect(await ledgerTotals(order.id, tx)).toEqual({ held: 0, captured: 4000, paidOut: 0, refundRefs: ["REF-1"] });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});

describe("reconcileOrder", () => {
  it("agreeing records: no flags, cursor moved, updated_at left alone", async () => {
    const order = await createOrder();
    paypal.getAuthorization.mockResolvedValue(record(order.paypalAuthorizationId!, "CREATED"));

    expect(await reconcileOrder(fakePayPal, order.id, NOW, async () => totals(5000, 0, 0))).toBe("ok");
    expect(await flags(order.id)).toEqual([]);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { lastReconciledAt: true, updatedAt: true } });
    expect(row).toEqual({ lastReconciledAt: NOW, updatedAt: order.updatedAt });
  });

  it("flags a mismatch once, keeps it updated, resolves it when they agree, and reopens it if it recurs", async () => {
    const order = await createOrder();
    paypal.getAuthorization.mockResolvedValue(record(order.paypalAuthorizationId!, "VOIDED")); // voided at PayPal...
    const stillHeld = async () => totals(5000, 0, 0); // ...but our ledger still holds the money

    expect(await reconcileOrder(fakePayPal, order.id, NOW, stillHeld)).toBe("flagged");
    expect(await reconcileOrder(fakePayPal, order.id, new Date(NOW.getTime() + MIN), stillHeld)).toBe("flagged");
    let rows = await flags(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "HELD", status: "OPEN", firstSeenAt: NOW, lastSeenAt: new Date(NOW.getTime() + MIN) });
    expect(rows[0].message).toMatch(/ledger holds 5000 cents in escrow; PayPal's authorization \(VOIDED\) holds 0 cents/);
    expect(rows[0].ledger).toMatchObject({ held: 5000 });
    expect(rows[0].paypal).toMatchObject({ expected: { held: 0 }, authorization: { status: "VOIDED" } });

    // Someone records the void: the ledger agrees again.
    expect(await reconcileOrder(fakePayPal, order.id, NOW, async () => totals(0, 0, 0))).toBe("ok");
    rows = await flags(order.id);
    expect(rows[0]).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });

    expect(await reconcileOrder(fakePayPal, order.id, NOW, stillHeld)).toBe("flagged");
    expect((await flags(order.id))[0]).toMatchObject({ status: "OPEN", resolvedAt: null });
  });

  it("flags a successful payout the ledger doesn't have", async () => {
    const order = await createOrder({ payout: true });
    paypal.getAuthorization.mockResolvedValue(record(order.paypalAuthorizationId!, "CAPTURED"));
    paypal.getCapture.mockResolvedValue(record(order.paypalCaptureId!, "COMPLETED"));
    paypal.getPayoutBatch.mockResolvedValue({
      batchStatus: "SUCCESS",
      items: [{ payoutItemId: "I", transactionStatus: "SUCCESS", senderItemId: order.id, amountCents: 4500, currency: "USD", errorName: null }],
    });

    expect(await reconcileOrder(fakePayPal, order.id, NOW, async () => totals(0, 5000, 0))).toBe("flagged");
    expect((await flags(order.id)).map((f) => f.kind)).toEqual(["PAID_OUT"]);
  });

  it("flags an id PayPal doesn't know as PAYPAL_RECORD", async () => {
    const order = await createOrder({ captured: true });
    paypal.getAuthorization.mockResolvedValue(record(order.paypalAuthorizationId!, "CAPTURED"));
    paypal.getCapture.mockRejectedValue(new PayPalError("get-captures", "http", "HTTP 404", { status: 404 }));

    expect(await reconcileOrder(fakePayPal, order.id, NOW, async () => totals(0, 5000, 0))).toBe("flagged");
    const [f] = await flags(order.id);
    expect(f).toMatchObject({ kind: "PAYPAL_RECORD", status: "OPEN" });
    expect(f.message).toBe(`capture ${order.paypalCaptureId} isn't found at PayPal`);
  });

  it("gives no verdict when PayPal can't be reached (no flags written or resolved)", async () => {
    const order = await createOrder();
    paypal.getAuthorization.mockRejectedValue(new PayPalError("get-authorizations", "timeout", "no response"));
    expect(await reconcileOrder(fakePayPal, order.id, NOW, async () => totals(5000, 0, 0))).toBe("failed");
    expect(await flags(order.id)).toEqual([]);
  });
});

describe("sweepReconciliation", () => {
  // Earlier than every other order in this file, so only this test's orders are due.
  const SWEEP_NOW = new Date("2001-09-01T12:00:00.000Z");

  it("checks quiet orders with PayPal records, never-checked first, and skips ones changed recently", async () => {
    const now = SWEEP_NOW;
    const quiet = await createOrder({ now });
    const busy = await createOrder({ now, updatedAgo: QUIET_MS - MIN });
    paypal.getAuthorization.mockImplementation(async ({ authorizationId }: { authorizationId: string }) =>
      record(authorizationId, "CREATED"),
    );

    expect(await sweepReconciliation(fakePayPal, { now, readLedger: async () => totals(5000, 0, 0) })).toEqual({
      checked: 1,
      ok: 1,
      flagged: 0,
      failed: 0,
      skipped: 0,
    });
    expect(paypal.getAuthorization).toHaveBeenCalledExactlyOnceWith({ authorizationId: quiet.paypalAuthorizationId });
    const busyRow = await prisma.order.findUniqueOrThrow({ where: { id: busy.id }, select: { lastReconciledAt: true } });
    expect(busyRow.lastReconciledAt).toBeNull();
  });
});

describe("PayPal client: payment reads", () => {
  it("GETs an authorization, capture or refund and reads id, status and amount", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      urls.push(`${init.method} ${url}`);
      return new Response(JSON.stringify({ id: url.split("/").pop(), status: "COMPLETED", amount: { currency_code: "USD", value: "45.00" } }));
    }) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });

    expect(await client.getCapture({ captureId: "CAP-1" })).toEqual({ id: "CAP-1", status: "COMPLETED", amountCents: 4500, currency: "USD" });
    await client.getAuthorization({ authorizationId: "AUTH-1" });
    await client.getRefund({ refundId: "REF-1" });
    expect(urls).toEqual([
      "GET https://paypal.test/v2/payments/captures/CAP-1",
      "GET https://paypal.test/v2/payments/authorizations/AUTH-1",
      "GET https://paypal.test/v2/payments/refunds/REF-1",
    ]);
  });
});
