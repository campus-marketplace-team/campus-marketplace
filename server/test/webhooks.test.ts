import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../src/generated/prisma/client.js";
import { outboxHandlers } from "../src/outbox/handlers.js";
import { createPayPalClient, type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { PAYPAL_WEBHOOK_TOPIC } from "../src/webhooks/ingest.js";
import {
  canReach,
  findOrderForEvent,
  handlePayPalWebhookJob,
  isStale,
  processWebhookEvent,
  type WebhookEventHandler,
} from "../src/webhooks/process.js";
import { type Api, cleanup, createTestUser, prisma, startApi } from "./helpers/api.js";

// PayPal webhook endpoint (verify → store → queue) and the worker-side
// processing (order lookup, stale check). Signature verification is faked:
// PayPal's verify endpoint is the only thing that can check a real signature.
// Every event id here starts with EVENT_PREFIX and is deleted after each test.

const EVENT_PREFIX = `WH-TEST-${randomUUID().slice(0, 8)}-`;
const WEBHOOK_ID = "WH-ID-TEST";

const SIGNATURE_HEADERS = {
  "PAYPAL-AUTH-ALGO": "SHA256withRSA",
  "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
  "PAYPAL-TRANSMISSION-ID": "tx-1",
  "PAYPAL-TRANSMISSION-SIG": "sig-1",
  "PAYPAL-TRANSMISSION-TIME": "2026-11-03T12:00:00Z",
};

const paypal = { verifyWebhookSignature: vi.fn() };
const fakePayPal = paypal as unknown as PayPalClient;

let api: Api;
let buyerId: string;
let sellerId: string;
let listingId: string;
let savedWebhookId: string | undefined;

beforeAll(async () => {
  savedWebhookId = process.env.PAYPAL_WEBHOOK_ID;
  api = await startApi({ paypal: () => fakePayPal });
  buyerId = (await createTestUser("wh-buyer")).id;
  sellerId = (await createTestUser("wh-seller")).id;
  listingId = (
    await prisma.listing.create({
      data: { sellerId, title: "webhook test", description: "test", category: "OTHER", priceCents: 5000 },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
  paypal.verifyWebhookSignature.mockReset().mockResolvedValue({ verificationStatus: "SUCCESS" });
});

afterEach(async () => {
  const events = await prisma.webhookEvent.findMany({ where: { eventId: { startsWith: EVENT_PREFIX } }, select: { id: true } });
  if (events.length > 0) {
    await prisma.outboxEvent.deleteMany({
      where: {
        topic: PAYPAL_WEBHOOK_TOPIC,
        OR: events.map((e) => ({ payload: { path: ["webhookEventId"], equals: e.id } })),
      },
    });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
  }
});

afterAll(async () => {
  if (savedWebhookId === undefined) delete process.env.PAYPAL_WEBHOOK_ID;
  else process.env.PAYPAL_WEBHOOK_ID = savedWebhookId;
  await api.close();
  await cleanup();
  await prisma.$disconnect();
});

function eventId() {
  return `${EVENT_PREFIX}${randomUUID()}`;
}

function captureCompleted(id = eventId(), captureId = `CAP-${randomUUID()}`) {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_type: "capture",
    create_time: "2026-11-03T12:00:00Z",
    resource: { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" } },
  };
}

async function post(body: string, headers: Record<string, string> = SIGNATURE_HEADERS) {
  const res = await fetch(`${api.url}/webhooks/paypal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function stored(id: string) {
  return prisma.webhookEvent.findUnique({ where: { eventId: id } });
}

async function queuedFor(webhookEventId: string) {
  return prisma.outboxEvent.findMany({
    where: { topic: PAYPAL_WEBHOOK_TOPIC, payload: { path: ["webhookEventId"], equals: webhookEventId } },
  });
}

describe("PayPal client: verifyWebhookSignature", () => {
  it("sends the headers, our webhook id and the raw event byte for byte, and returns the status", async () => {
    const sent: { url: string; body: string; auth: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      sent.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
    }) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });

    // Spacing and key order a re-serialization would change.
    const rawEvent = '{ "id":"WH-1",  "event_type":"X", "resource":{"b":1,"a":2.50} }';
    const result = await client.verifyWebhookSignature({
      webhookId: WEBHOOK_ID,
      headers: { authAlgo: "ALG", certUrl: "CERT", transmissionId: "TID", transmissionSig: "SIG", transmissionTime: "TIME" },
      rawEvent,
    });

    expect(result).toEqual({ verificationStatus: "SUCCESS" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://paypal.test/v1/notifications/verify-webhook-signature");
    expect(sent[0].auth).toBe("Bearer tok");
    expect(sent[0].body.endsWith(`"webhook_event":${rawEvent}}`)).toBe(true);
    expect(JSON.parse(sent[0].body)).toEqual({
      auth_algo: "ALG",
      cert_url: "CERT",
      transmission_id: "TID",
      transmission_sig: "SIG",
      transmission_time: "TIME",
      webhook_id: WEBHOOK_ID,
      webhook_event: JSON.parse(rawEvent),
    });
  });

  it("throws a retryable PayPalError on a 5xx", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response("{}", { status: 503 })) as typeof fetch;
    const client = createPayPalClient({ clientId: "c", clientSecret: "s", baseUrl: "https://paypal.test" }, { fetch: fakeFetch });
    const err = await client
      .verifyWebhookSignature({
        webhookId: WEBHOOK_ID,
        headers: { authAlgo: "A", certUrl: "C", transmissionId: "T", transmissionSig: "S", transmissionTime: "T" },
        rawEvent: "{}",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.retryable).toBe(true);
  });
});

describe("POST /api/webhooks/paypal", () => {
  it("verifies, stores the event and queues it for the worker in one go", async () => {
    const event = captureCompleted();
    const raw = JSON.stringify(event);
    const res = await post(raw);

    expect(res).toEqual({ status: 200, body: { received: true, duplicate: false } });
    expect(paypal.verifyWebhookSignature).toHaveBeenCalledExactlyOnceWith({
      webhookId: WEBHOOK_ID,
      headers: {
        authAlgo: SIGNATURE_HEADERS["PAYPAL-AUTH-ALGO"],
        certUrl: SIGNATURE_HEADERS["PAYPAL-CERT-URL"],
        transmissionId: "tx-1",
        transmissionSig: "sig-1",
        transmissionTime: SIGNATURE_HEADERS["PAYPAL-TRANSMISSION-TIME"],
      },
      rawEvent: raw,
    });

    const row = await stored(event.id);
    expect(row).toMatchObject({
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: event.resource.id,
      payload: event,
      processedAt: null,
    });
    const queued = await queuedFor(row!.id);
    expect(queued.map((q) => [q.status, q.payload])).toEqual([["PENDING", { webhookEventId: row!.id }]]);
  });

  it("stores a redelivered event once and queues it once (ON CONFLICT DO NOTHING)", async () => {
    const raw = JSON.stringify(captureCompleted());
    const results = await Promise.all([post(raw), post(raw), post(raw)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);

    const id = JSON.parse(raw).id;
    expect(await prisma.webhookEvent.count({ where: { eventId: id } })).toBe(1);
    expect(await queuedFor((await stored(id))!.id)).toHaveLength(1);
  });

  it("refuses and doesn't store an event whose signature PayPal doesn't confirm", async () => {
    paypal.verifyWebhookSignature.mockResolvedValue({ verificationStatus: "FAILURE" });
    const event = captureCompleted();
    expect((await post(JSON.stringify(event))).status).toBe(400);
    expect(await stored(event.id)).toBeNull();
  });

  it("refuses an event with missing signature headers without calling PayPal", async () => {
    const event = captureCompleted();
    const { "PAYPAL-TRANSMISSION-SIG": _sig, ...partial } = SIGNATURE_HEADERS;
    expect((await post(JSON.stringify(event), partial)).status).toBe(400);
    expect(paypal.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(await stored(event.id)).toBeNull();
  });

  it("answers 503 (so PayPal redelivers) when verification can't be done right now", async () => {
    paypal.verifyWebhookSignature.mockRejectedValue(new PayPalError("verify-webhook", "timeout", "no response"));
    const event = captureCompleted();
    expect((await post(JSON.stringify(event))).status).toBe(503);
    expect(await stored(event.id)).toBeNull();
  });

  it("answers 503 when PAYPAL_WEBHOOK_ID isn't set", async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    const event = captureCompleted();
    expect((await post(JSON.stringify(event))).status).toBe(503);
    expect(paypal.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(await stored(event.id)).toBeNull();
  });

  it("refuses malformed bodies without calling PayPal", async () => {
    for (const body of ["not json", "[]", "null", JSON.stringify({ id: eventId() }), JSON.stringify({ event_type: "X" })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(paypal.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("needs no login (PayPal calls it), and other routes still parse JSON", async () => {
    expect((await post(JSON.stringify(captureCompleted()))).status).toBe(200);
    const login = await api.call("POST", "/auth/login", { json: { email: "nobody@example.com", password: "x" } });
    expect(login.status).not.toBe(400); // the JSON body was parsed (wrong credentials, not a malformed body)
  });
});

describe("processing a stored event", () => {
  async function createOrder(state: Prisma.OrderCreateInput["state"], ids: Partial<Record<string, string>> = {}) {
    return prisma.order.create({
      data: {
        listingId,
        buyerId,
        sellerId,
        state,
        version: 3,
        amountCents: 5000,
        platformFeeCents: 500,
        paypalOrderId: `PPORDER-${randomUUID()}`,
        paypalAuthorizationId: `AUTH-${randomUUID()}`,
        ...ids,
      },
    });
  }

  async function store(eventType: string, resource: Record<string, unknown>) {
    return prisma.webhookEvent.create({
      data: { eventId: eventId(), eventType, payload: { id: "x", event_type: eventType, resource } as Prisma.InputJsonObject },
    });
  }

  async function readEvent(id: string) {
    return prisma.webhookEvent.findUniqueOrThrow({ where: { id }, select: { processedAt: true, processError: true } });
  }

  it("logs and drops a stale event: the order is already at or past that state", async () => {
    const captureId = `CAP-${randomUUID()}`;
    const order = await createOrder("CAPTURED", { paypalCaptureId: captureId });
    const handler = vi.fn<WebhookEventHandler>();

    const e1 = await store("PAYMENT.CAPTURE.COMPLETED", { id: captureId });
    expect(await processWebhookEvent(e1.id, { "PAYMENT.CAPTURE.COMPLETED": handler })).toBe("stale");
    // A void for an order that was captured can't apply either.
    const e2 = await store("PAYMENT.AUTHORIZATION.VOIDED", { id: order.paypalAuthorizationId });
    expect(await processWebhookEvent(e2.id, { "PAYMENT.AUTHORIZATION.VOIDED": handler })).toBe("stale");

    expect(handler).not.toHaveBeenCalled();
    for (const e of [e1, e2]) {
      const row = await readEvent(e.id);
      expect(row.processedAt).not.toBeNull();
      expect(row.processError).toMatch(/^stale, dropped: order is CAPTURED/);
    }
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { state: true, version: true } })).toEqual({
      state: "CAPTURED",
      version: 3,
    });
  });

  it("hands a current event to its handler with the order, then marks it processed", async () => {
    const order = await createOrder("AUTHORIZED");
    const handler = vi.fn<WebhookEventHandler>().mockResolvedValue(undefined);
    const e = await store("PAYMENT.AUTHORIZATION.VOIDED", { id: order.paypalAuthorizationId });

    expect(await processWebhookEvent(e.id, { "PAYMENT.AUTHORIZATION.VOIDED": handler })).toBe("handled");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].order).toMatchObject({ id: order.id, state: "AUTHORIZED", version: 3 });
    expect(await readEvent(e.id)).toMatchObject({ processError: null });
    expect((await readEvent(e.id)).processedAt).not.toBeNull();

    // Already processed: a second run does nothing.
    expect(await processWebhookEvent(e.id, { "PAYMENT.AUTHORIZATION.VOIDED": handler })).toBe("already_processed");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("leaves a current event unprocessed when its type has no handler yet", async () => {
    const order = await createOrder("AUTHORIZED");
    const e = await store("PAYMENT.AUTHORIZATION.VOIDED", { id: order.paypalAuthorizationId });
    expect(await processWebhookEvent(e.id, {})).toBe("unhandled");
    expect(await readEvent(e.id)).toEqual({ processedAt: null, processError: "no handler for PAYMENT.AUTHORIZATION.VOIDED" });
  });

  it("throws when no order matches yet, so the relay retries", async () => {
    const e = await store("PAYMENT.CAPTURE.COMPLETED", { id: `CAP-${randomUUID()}` });
    await expect(processWebhookEvent(e.id, {})).rejects.toThrow(/no matching order/);
    expect((await readEvent(e.id)).processedAt).toBeNull();
  });

  it("records event types we don't use as ignored", async () => {
    const e = await store("BILLING.SUBSCRIPTION.CREATED", { id: "I-1" });
    expect(await processWebhookEvent(e.id, {})).toBe("ignored");
    expect(await readEvent(e.id)).toMatchObject({ processError: "ignored: event type not used" });
  });

  it("finds the order by related PayPal ids, a refund's capture link, or our custom_id", async () => {
    const captureId = `CAP-${randomUUID()}`;
    const order = await createOrder("CAPTURED", { paypalCaptureId: captureId });

    const byRelated = await findOrderForEvent("PAYMENT.CAPTURE.COMPLETED", {
      resource: { id: `CAP-${randomUUID()}`, supplementary_data: { related_ids: { order_id: order.paypalOrderId } } },
    });
    const byUpLink = await findOrderForEvent("PAYMENT.CAPTURE.REFUNDED", {
      resource: { id: "REFUND-1", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
    });
    const byCustomId = await findOrderForEvent("PAYMENT.CAPTURE.COMPLETED", {
      resource: { id: `CAP-${randomUUID()}`, custom_id: order.id },
    });
    const byDispute = await findOrderForEvent("CUSTOMER.DISPUTE.CREATED", {
      resource: { dispute_id: "PP-D-1", disputed_transactions: [{ seller_transaction_id: captureId }] },
    });
    for (const found of [byRelated, byUpLink, byCustomId, byDispute]) expect(found?.id).toBe(order.id);

    // Junk in the payload never matches anything.
    expect(await findOrderForEvent("PAYMENT.CAPTURE.COMPLETED", { resource: { id: 42, custom_id: "not-a-uuid" } })).toBeNull();
    expect(await findOrderForEvent("PAYMENT.CAPTURE.COMPLETED", null)).toBeNull();
  });

  it("is wired into the outbox relay as the paypal.webhook handler", async () => {
    expect(outboxHandlers[PAYPAL_WEBHOOK_TOPIC]).toBe(handlePayPalWebhookJob);
    const job = { id: randomUUID(), orderId: null, topic: PAYPAL_WEBHOOK_TOPIC, attempts: 1 };
    await expect(handlePayPalWebhookJob({ ...job, payload: { webhookEventId: "nope" } })).rejects.toThrow(/malformed/);

    const ignored = await store("BILLING.SUBSCRIPTION.CREATED", { id: "I-2" });
    await handlePayPalWebhookJob({ ...job, payload: { webhookEventId: ignored.id } });
    expect((await readEvent(ignored.id)).processedAt).not.toBeNull();
  });
});

describe("stale check", () => {
  it("follows the state machine", () => {
    expect(canReach("CREATED", "PAID_OUT")).toBe(true);
    expect(canReach("AUTHORIZED", "VOIDED")).toBe(true);
    expect(canReach("CAPTURED", "VOIDED")).toBe(false);
    expect(isStale("AUTHORIZED", "CAPTURED")).toBe(false);
    expect(isStale("CAPTURED", "CAPTURED")).toBe(true);
    expect(isStale("PAID_OUT", "CAPTURED")).toBe(true);
    expect(isStale("CREATED", "AUTHORIZED")).toBe(false);
    expect(isStale("VOIDED", "AUTHORIZED")).toBe(true);
  });
});
