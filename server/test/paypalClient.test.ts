import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  centsToValue,
  createPayPalClient,
  PayPalError,
  requestId,
  valueToCents,
} from "../src/paypal/client.js";

// Unit tests with a fake fetch: no network and no PayPal credentials needed.
// Response shapes follow PayPal's Orders v2 / Payments v2 docs.

const config = { clientId: "test-client", clientSecret: "test-secret", baseUrl: "https://paypal.test" };

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const tokenOk = () => json(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 32400 });

/** A fake fetch that answers the token endpoint and hands everything else to `api`. */
function fakePayPal(api: (call: Call) => Response | Promise<Response>, token: () => Response = tokenOk) {
  const calls: Call[] = [];
  let tokenRequests = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) {
      tokenRequests++;
      return token();
    }
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return api(call);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls, tokenRequests: () => tokenRequests };
}

const orderId = randomUUID();

describe("money helpers", () => {
  it("formats integer cents as PayPal values", () => {
    expect(centsToValue(5000)).toBe("50.00");
    expect(centsToValue(1)).toBe("0.01");
    expect(centsToValue(123456)).toBe("1234.56");
    for (const bad of [0, -100, 50.5, NaN]) expect(() => centsToValue(bad)).toThrow(RangeError);
  });

  it("parses PayPal values to integer cents", () => {
    expect(valueToCents("50.00")).toBe(5000);
    expect(valueToCents("50")).toBe(5000);
    expect(valueToCents("0.5")).toBe(50);
    expect(valueToCents("1234.56")).toBe(123456);
    for (const bad of ["", "-1.00", "1.234", "1e3", "abc"]) expect(() => valueToCents(bad)).toThrow(RangeError);
  });
});

describe("requestId", () => {
  it("is the order id plus the action", () => {
    expect(requestId(orderId, "capture")).toBe(`${orderId}-capture`);
  });
  it("refuses a non-UUID order id", () => {
    expect(() => requestId("x", "capture")).toThrow(TypeError);
  });
});

describe("PayPal client", () => {
  it("creates an AUTHORIZE order with the request id and returns the approve link", async () => {
    const pp = fakePayPal(() =>
      json(201, {
        id: "PPORDER1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://paypal.test/approve/PPORDER1" }],
      }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });

    const order = await client.createOrder({ orderId, amountCents: 5000 });
    expect(order).toEqual({
      paypalOrderId: "PPORDER1",
      status: "CREATED",
      approveUrl: "https://paypal.test/approve/PPORDER1",
    });

    const [call] = pp.calls;
    expect(call.url).toBe("https://paypal.test/v2/checkout/orders");
    expect(call.method).toBe("POST");
    expect(call.headers["PayPal-Request-Id"]).toBe(`${orderId}-create-order`);
    expect(call.headers.Authorization).toBe("Bearer tok-1");
    expect(call.body).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        { reference_id: orderId, custom_id: orderId, amount: { currency_code: "USD", value: "50.00" } },
      ],
    });
  });

  it("authorizes an approved order and returns the authorization", async () => {
    const pp = fakePayPal(() =>
      json(201, {
        id: "PPORDER1",
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              authorizations: [
                {
                  id: "AUTH1",
                  status: "CREATED",
                  amount: { currency_code: "USD", value: "50.00" },
                  expiration_time: "2026-11-20T12:00:00Z",
                },
              ],
            },
          },
        ],
      }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });

    const auth = await client.authorizeOrder({ orderId, paypalOrderId: "PPORDER1" });
    expect(auth).toEqual({
      authorizationId: "AUTH1",
      status: "CREATED",
      amountCents: 5000,
      currency: "USD",
      expiresAt: new Date("2026-11-20T12:00:00Z"),
    });
    expect(pp.calls[0].url).toBe("https://paypal.test/v2/checkout/orders/PPORDER1/authorize");
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBe(`${orderId}-authorize`);
  });

  it("captures exactly the given amount as the final capture", async () => {
    const pp = fakePayPal(() =>
      json(201, { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" } }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });

    const cap = await client.captureAuthorization({ orderId, authorizationId: "AUTH1", amountCents: 5000 });
    expect(cap).toEqual({ captureId: "CAP1", status: "COMPLETED", amountCents: 5000, currency: "USD" });
    expect(pp.calls[0].url).toBe("https://paypal.test/v2/payments/authorizations/AUTH1/capture");
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBe(`${orderId}-capture`);
    expect(pp.calls[0].body).toEqual({ amount: { currency_code: "USD", value: "50.00" }, final_capture: true });
  });

  it("voids an authorization (204 No Content)", async () => {
    const pp = fakePayPal(() => new Response(null, { status: 204 }));
    const client = createPayPalClient(config, { fetch: pp.fetch });

    expect(await client.voidAuthorization({ orderId, authorizationId: "AUTH1" })).toEqual({ status: "VOIDED" });
    expect(pp.calls[0].url).toBe("https://paypal.test/v2/payments/authorizations/AUTH1/void");
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBe(`${orderId}-void`);
  });

  it("sends the same request id when a call is retried", async () => {
    const pp = fakePayPal(() =>
      json(201, { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" } }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const input = { orderId, authorizationId: "AUTH1", amountCents: 5000 };
    await client.captureAuthorization(input);
    await client.captureAuthorization(input);
    expect(pp.calls.map((c) => c.headers["PayPal-Request-Id"])).toEqual([`${orderId}-capture`, `${orderId}-capture`]);
  });

  it("reuses the access token, sharing one token request between concurrent calls", async () => {
    const pp = fakePayPal(() => new Response(null, { status: 204 }));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    await Promise.all([
      client.voidAuthorization({ orderId, authorizationId: "A" }),
      client.voidAuthorization({ orderId, authorizationId: "B" }),
    ]);
    await client.voidAuthorization({ orderId, authorizationId: "C" });
    expect(pp.tokenRequests()).toBe(1);
  });

  it("refreshes the token once on a 401 and retries with the same request id", async () => {
    let n = 0;
    const pp = fakePayPal(() => (n++ === 0 ? json(401, { error: "invalid_token" }) : new Response(null, { status: 204 })));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    await client.voidAuthorization({ orderId, authorizationId: "AUTH1" });
    expect(pp.tokenRequests()).toBe(2);
    expect(pp.calls).toHaveLength(2);
    expect(pp.calls[1].headers["PayPal-Request-Id"]).toBe(`${orderId}-void`);
  });

  it("reports PayPal's error name, issue and debug id, and marks 4xx as not retryable", async () => {
    const pp = fakePayPal(() =>
      json(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "Authorization has been previously captured." }],
        debug_id: "dbg-123",
      }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const err = await client
      .captureAuthorization({ orderId, authorizationId: "AUTH1", amountCents: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({
      kind: "http",
      action: "capture",
      status: 422,
      paypalName: "UNPROCESSABLE_ENTITY",
      issue: "AUTHORIZATION_ALREADY_CAPTURED",
      debugId: "dbg-123",
      retryable: false,
    });
  });

  it("marks 5xx as retryable", async () => {
    const pp = fakePayPal(() => json(503, { name: "SERVICE_UNAVAILABLE" }, { "PayPal-Debug-Id": "dbg-hdr" }));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const err = await client.voidAuthorization({ orderId, authorizationId: "AUTH1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "http", status: 503, retryable: true, debugId: "dbg-hdr" });
  });

  it("turns a slow response into a retryable timeout error", async () => {
    const pp = fakePayPal(() => new Promise<Response>(() => {})); // never answers
    // The fake ignores the signal, so reject when it aborts, as real fetch does.
    const fetchWithAbort = (async (input: RequestInfo | URL, init: RequestInit = {}) =>
      Promise.race([
        pp.fetch(input, init),
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
      ])) as typeof fetch;
    const client = createPayPalClient(config, { fetch: fetchWithAbort, timeoutMs: 50 });

    const err = await client.captureAuthorization({ orderId, authorizationId: "AUTH1", amountCents: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ kind: "timeout", action: "capture", retryable: true });
    expect(err.message).toMatch(/outcome unknown/);
  });

  it("turns a connection failure into a retryable network error", async () => {
    const pp = fakePayPal(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const err = await client.voidAuthorization({ orderId, authorizationId: "AUTH1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "network", retryable: true });
    expect(err.message).toMatch(/ECONNRESET/);
  });

  it("reports bad credentials as an auth error without leaking the secret", async () => {
    const pp = fakePayPal(
      () => new Response(null, { status: 204 }),
      () => json(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const err = await client.voidAuthorization({ orderId, authorizationId: "AUTH1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "auth", status: 401, retryable: false });
    expect(err.message).not.toContain(config.clientSecret);
    expect(pp.calls).toHaveLength(0);
  });

  it("rejects a 2xx response missing the fields we need", async () => {
    const pp = fakePayPal(() => json(201, { id: "PPORDER1", status: "COMPLETED", purchase_units: [] }));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    const err = await client.authorizeOrder({ orderId, paypalOrderId: "PPORDER1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("refuses non-integer or non-positive amounts before calling PayPal", async () => {
    const pp = fakePayPal(() => json(201, {}));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    await expect(client.createOrder({ orderId, amountCents: 49.99 })).rejects.toThrow(RangeError);
    await expect(client.createOrder({ orderId, amountCents: 0 })).rejects.toThrow(RangeError);
    expect(pp.calls).toHaveLength(0);
  });
});

describe("getCheckoutOrder", () => {
  it("reads an order's status with a plain GET (no request id, nothing changes at PayPal)", async () => {
    const pp = fakePayPal(() => json(200, { id: "PPORDER-1", status: "APPROVED", intent: "AUTHORIZE" }));
    const client = createPayPalClient(config, { fetch: pp.fetch });

    expect(await client.getCheckoutOrder({ paypalOrderId: "PPORDER-1" })).toEqual({ id: "PPORDER-1", status: "APPROVED" });
    expect(pp.calls).toHaveLength(1);
    expect(pp.calls[0]).toMatchObject({ method: "GET", url: "https://paypal.test/v2/checkout/orders/PPORDER-1" });
    expect(pp.calls[0].headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("refuses a response without a status", async () => {
    const pp = fakePayPal(() => json(200, { id: "PPORDER-1" }));
    const client = createPayPalClient(config, { fetch: pp.fetch });
    await expect(client.getCheckoutOrder({ paypalOrderId: "PPORDER-1" })).rejects.toBeInstanceOf(PayPalError);
  });
});
