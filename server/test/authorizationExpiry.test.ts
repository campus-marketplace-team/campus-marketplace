import { randomUUID } from "node:crypto";
import { HONOR_PERIOD_MS } from "@campus/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_EXPIRING_NOTIFICATION,
  EXPIRY_MARGIN_MS,
  handleExpiringAuthorization,
  REAUTHORIZE_AFTER_HONOR_MS,
  sweepExpiringAuthorizations,
  TOO_SOON_RETRY_MS,
} from "../src/jobs/authorizationExpiry.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { createPayPalClient, type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// Reauthorize-or-void job against the real database with a fake PayPal client.
// ledger_entries is append-only, so postTransaction is stubbed (the VOID
// posting is checked in handoffDeadline.test.ts). The database is shared, so
// every order here lives in 2001 and every run happens "in" 2001.

vi.mock("../src/ledger/postTransaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger/postTransaction.js")>();
  return { ...actual, postTransaction: vi.fn(actual.postTransaction) };
});

const paypal = { reauthorize: vi.fn(), voidAuthorization: vi.fn() };
const fakePayPal = paypal as unknown as PayPalClient;

const NOW = new Date("2001-08-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let buyerId: string;
let sellerId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("reauth-buyer")).id;
  sellerId = (await createTestUser("reauth-seller")).id;
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postTransaction).mockResolvedValue({ transactionId: randomUUID(), entryCount: 2 });
  paypal.voidAuthorization.mockResolvedValue({ status: "VOIDED" });
  paypal.reauthorize.mockImplementation(async () => ({
    authorizationId: `AUTH-NEW-${randomUUID()}`,
    status: "CREATED",
    amountCents: 5000,
    currency: "USD",
    expiresAt: null,
  }));
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/**
 * A $50 order authorized 4 days before NOW: honor period over a day ago,
 * authorization valid for 25 more days. AUTHORIZED orders get a long hold
 * (handoff deadline 2 days ahead) unless told otherwise.
 */
async function createOrder({
  state = "AUTHORIZED" as "AUTHORIZED" | "IN_DISPUTE",
  honorEndsIn = -DAY,
  expiresIn = 25 * DAY,
  deadlineIn = 2 * DAY,
  now = NOW,
} = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "reauth test", description: "test", category: "OTHER", priceCents: 5000, status: "RESERVED" },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId,
      sellerId,
      state,
      version: 3,
      amountCents: 5000,
      platformFeeCents: 500,
      paypalOrderId: `PPORDER-${randomUUID()}`,
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
      authorizedAt: new Date(now.getTime() - 4 * DAY),
      honorPeriodEndsAt: new Date(now.getTime() + honorEndsIn),
      authorizationExpiresAt: new Date(now.getTime() + expiresIn),
      handoffDeadline: new Date(now.getTime() + deadlineIn),
    },
  });
}

function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id },
    select: { state: true, version: true, paypalAuthorizationId: true, honorPeriodEndsAt: true, authorizationExpiresAt: true },
  });
}

async function notes(orderId: string) {
  return prisma.notification.findMany({ where: { orderId }, select: { userId: true, kind: true, message: true } });
}

describe("reauthorizing when the handoff is still pending", () => {
  it("IN_DISPUTE after the honor period: new authorization id saved, new honor period, no state change", async () => {
    const order = await createOrder({ state: "IN_DISPUTE" });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("reauthorized");

    expect(paypal.reauthorize).toHaveBeenCalledExactlyOnceWith({ orderId: order.id, authorizationId: order.paypalAuthorizationId });
    const row = await readOrder(order.id);
    expect(row.paypalAuthorizationId).toMatch(/^AUTH-NEW-/);
    expect(row).toMatchObject({ state: "IN_DISPUTE", version: 3, honorPeriodEndsAt: at(HONOR_PERIOD_MS) });
    expect(postTransaction).not.toHaveBeenCalled(); // no money moves
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
  });

  it("AUTHORIZED with a longer hold (deadline still ahead): reauthorized", async () => {
    const order = await createOrder({ deadlineIn: 2 * DAY });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("reauthorized");
    expect((await readOrder(order.id)).state).toBe("AUTHORIZED");
  });

  it("does nothing until the honor period (plus a margin) is over, since PayPal refuses earlier", async () => {
    const order = await createOrder({ state: "IN_DISPUTE", honorEndsIn: -REAUTHORIZE_AFTER_HONOR_MS + 1000 });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("skipped");
    expect(paypal.reauthorize).not.toHaveBeenCalled();
  });

  it("REAUTHORIZATION_TOO_SOON: tries again an hour later", async () => {
    const order = await createOrder({ state: "IN_DISPUTE" });
    paypal.reauthorize.mockRejectedValueOnce(
      new PayPalError("reauthorize", "http", "HTTP 422", { status: 422, issue: "REAUTHORIZATION_TOO_SOON" }),
    );
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("waiting");
    expect(await readOrder(order.id)).toMatchObject({
      paypalAuthorizationId: order.paypalAuthorizationId,
      honorPeriodEndsAt: at(TOO_SOON_RETRY_MS),
    });
  });

  it("after a timeout, retries the same reauthorization (same old id, so the same request id)", async () => {
    const order = await createOrder({ state: "IN_DISPUTE" });
    paypal.reauthorize.mockRejectedValueOnce(new PayPalError("reauthorize", "timeout", "no response"));
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("failed");
    expect((await readOrder(order.id)).paypalAuthorizationId).toBe(order.paypalAuthorizationId);

    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("reauthorized");
    expect(paypal.reauthorize.mock.calls[1]).toEqual(paypal.reauthorize.mock.calls[0]);
  });

  it("never lets the new honor period run past PayPal's 29-day expiry", async () => {
    const order = await createOrder({ state: "IN_DISPUTE", expiresIn: 2 * DAY });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("reauthorized");
    expect((await readOrder(order.id)).honorPeriodEndsAt).toEqual(at(2 * DAY));
  });

  it("doesn't save the new authorization if the order changed meanwhile (e.g. captured)", async () => {
    const order = await createOrder();
    paypal.reauthorize.mockImplementationOnce(async () => {
      await prisma.order.update({ where: { id: order.id }, data: { state: "CAPTURED", version: 4 } });
      return { authorizationId: `AUTH-NEW-${randomUUID()}`, status: "CREATED", amountCents: 5000, currency: "USD", expiresAt: null };
    });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("skipped");
    expect((await readOrder(order.id)).paypalAuthorizationId).toBe(order.paypalAuthorizationId);
  });
});

describe("voiding (and notifying) when the hold can't be kept", () => {
  it("AUTHORIZED within a day of the 29-day expiry: voided with an 'expiring' message to both sides", async () => {
    const order = await createOrder({ expiresIn: EXPIRY_MARGIN_MS - HOUR });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("voided");

    expect(paypal.reauthorize).not.toHaveBeenCalled();
    expect(paypal.voidAuthorization).toHaveBeenCalledExactlyOnceWith({ orderId: order.id, authorizationId: order.paypalAuthorizationId });
    expect((await readOrder(order.id)).state).toBe("VOIDED");
    const sent = await notes(order.id);
    expect(sent.map((n) => n.userId).sort()).toEqual([buyerId, sellerId].sort());
    expect(sent.every((n) => n.kind === "ORDER_VOIDED" && /payment hold was about to expire/.test(n.message))).toBe(true);
  });

  it("AUTHORIZED whose reauthorization PayPal refuses: voided, both sides told", async () => {
    const order = await createOrder();
    paypal.reauthorize.mockRejectedValueOnce(new PayPalError("reauthorize", "http", "HTTP 422", { status: 422, issue: "INSTRUMENT_DECLINED" }));
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("voided");
    expect((await readOrder(order.id)).state).toBe("VOIDED");
    expect((await notes(order.id)).every((n) => /couldn't renew/.test(n.message))).toBe(true);
  });

  it("AUTHORIZED past its handoff deadline: voided the deadline job's way", async () => {
    const order = await createOrder({ deadlineIn: -HOUR });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("voided");
    expect(paypal.reauthorize).not.toHaveBeenCalled();
    expect((await notes(order.id)).every((n) => /before its deadline/.test(n.message))).toBe(true);
  });

  it("IN_DISPUTE whose reauthorization is refused: not voided (no legal move); both sides told once", async () => {
    const order = await createOrder({ state: "IN_DISPUTE" });
    paypal.reauthorize.mockRejectedValue(new PayPalError("reauthorize", "http", "HTTP 422", { status: 422, issue: "INSTRUMENT_DECLINED" }));
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("review");
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("review");

    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
    const sent = await notes(order.id);
    expect(sent).toHaveLength(2);
    expect(sent.every((n) => n.kind === AUTHORIZATION_EXPIRING_NOTIFICATION)).toBe(true);
  });

  it("IN_DISPUTE in its last day: both sides told, and still reauthorized so a release can be captured", async () => {
    const order = await createOrder({ state: "IN_DISPUTE", expiresIn: EXPIRY_MARGIN_MS - HOUR });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("reauthorized");
    expect((await notes(order.id)).map((n) => n.kind)).toEqual([AUTHORIZATION_EXPIRING_NOTIFICATION, AUTHORIZATION_EXPIRING_NOTIFICATION]);
  });

  it("past PayPal's expiry there's nothing to reauthorize", async () => {
    const order = await createOrder({ state: "IN_DISPUTE", expiresIn: -HOUR });
    expect(await handleExpiringAuthorization(fakePayPal, order.id, NOW)).toBe("review");
    expect(paypal.reauthorize).not.toHaveBeenCalled();
  });
});

describe("sweepExpiringAuthorizations", () => {
  // Earlier than every other order in this file, so only this test's orders are due here. Later
  // than the other files' sweep times (2000), whose sweeps must not see these orders either.
  const SWEEP_NOW = new Date("2001-07-01T12:00:00.000Z");

  it("handles orders past their honor period or near expiry, and leaves the rest", async () => {
    const now = SWEEP_NOW;
    const due = await createOrder({ state: "IN_DISPUTE", now });
    const expiring = await createOrder({ expiresIn: HOUR, now });
    const fresh = await createOrder({ state: "IN_DISPUTE", honorEndsIn: DAY, now });

    expect(await sweepExpiringAuthorizations(fakePayPal, { now })).toMatchObject({ checked: 2, reauthorized: 1, voided: 1 });
    expect((await readOrder(due.id)).paypalAuthorizationId).not.toBe(due.paypalAuthorizationId);
    expect((await readOrder(expiring.id)).state).toBe("VOIDED");
    expect(await readOrder(fresh.id)).toMatchObject({ paypalAuthorizationId: fresh.paypalAuthorizationId, state: "IN_DISPUTE" });

    // Reauthorized: not due again until its new honor period ends.
    expect(await sweepExpiringAuthorizations(fakePayPal, { now })).toMatchObject({ checked: 0 });
  });
});

describe("PayPal client: reauthorize", () => {
  it("POSTs to the authorization's reauthorize endpoint with a request id keyed by that authorization", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(
        JSON.stringify({
          id: "AUTH-2",
          status: "CREATED",
          amount: { currency_code: "USD", value: "50.00" },
          expiration_time: "2001-08-25T12:00:00Z",
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });
    const orderId = randomUUID();

    expect(await client.reauthorize({ orderId, authorizationId: "AUTH-1" })).toEqual({
      authorizationId: "AUTH-2",
      status: "CREATED",
      amountCents: 5000,
      currency: "USD",
      expiresAt: new Date("2001-08-25T12:00:00Z"),
    });
    expect(calls[0].url).toBe("https://paypal.test/v2/payments/authorizations/AUTH-1/reauthorize");
    expect(calls[0].headers["PayPal-Request-Id"]).toBe(`${orderId}-reauthorize-AUTH-1`);
  });
});
