// Server-only PayPal REST client: Orders v2 with intent AUTHORIZE, plus
// capture and void on the authorization (see CLAUDE.md "Payment model").
//
// Every money call sends PayPal-Request-Id = `<orderId>-<action>`, so a retry
// after a timeout or 5xx is answered with the original result instead of
// running twice. A timeout means the outcome is unknown, not that it failed:
// retry with the same order ID and action, never with a new one.
//
// Never logs or returns the client secret or access token.

import { isUuid } from "../ids.js";

const TOKEN_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export type PayPalConfig = { clientId: string; clientSecret: string; baseUrl: string };

/** null when PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET or PAYPAL_BASE_URL isn't set. */
export function getPayPalConfig(): PayPalConfig | null {
  const clientId = (process.env.PAYPAL_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET ?? "").trim();
  const baseUrl = (process.env.PAYPAL_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!clientId || !clientSecret || !baseUrl) return null;
  return { clientId, clientSecret, baseUrl };
}

// ---------- Errors ----------

export type PayPalErrorKind =
  | "timeout" // no answer in time: outcome unknown, retry with the same request id
  | "network" // never reached PayPal (DNS, refused, reset)
  | "auth" // OAuth token request refused (bad credentials)
  | "http" // PayPal answered with an error status
  | "invalid_response"; // 2xx but not the shape we expect

export class PayPalError extends Error {
  readonly kind: PayPalErrorKind;
  readonly action: string;
  readonly status?: number;
  /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY. */
  readonly paypalName?: string;
  /** First detail issue, e.g. AUTHORIZATION_ALREADY_CAPTURED. */
  readonly issue?: string;
  /** Quote this to PayPal support. */
  readonly debugId?: string;
  /** Safe to retry with the same request id. */
  readonly retryable: boolean;

  constructor(
    action: string,
    kind: PayPalErrorKind,
    message: string,
    extra: { status?: number; paypalName?: string; issue?: string; debugId?: string; cause?: unknown } = {},
  ) {
    super(`PayPal ${action} failed: ${message}`, { cause: extra.cause });
    this.name = "PayPalError";
    this.action = action;
    this.kind = kind;
    this.status = extra.status;
    this.paypalName = extra.paypalName;
    this.issue = extra.issue;
    this.debugId = extra.debugId;
    this.retryable =
      kind === "timeout" ||
      kind === "network" ||
      (kind === "http" && (extra.status === 429 || (extra.status ?? 0) >= 500));
  }
}

// ---------- Money ----------

/** 5000 → "50.00". Integer cents only; we only use 2-decimal currencies. */
export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError(`Invalid amount in cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "50.00" → 5000. Throws on anything that isn't a plain decimal amount. */
export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new RangeError(`Invalid PayPal amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

// ---------- Request ids ----------

export type PayPalAction = "create-order" | "authorize" | "capture" | "void";

/** PayPal-Request-Id for one action on one of our orders (max 108 chars; ours is 36 + action). */
export function requestId(orderId: string, action: PayPalAction): string {
  if (!isUuid(orderId)) throw new TypeError(`orderId must be a UUID, got ${orderId}`);
  return `${orderId}-${action}`;
}

// ---------- Results ----------

export type CreatedOrder = { paypalOrderId: string; status: string; approveUrl: string | null };

export type Authorization = {
  authorizationId: string;
  /** CREATED means authorized; PENDING / DENIED need handling by the caller. */
  status: string;
  amountCents: number;
  currency: string;
  expiresAt: Date | null;
};

export type Capture = { captureId: string; status: string; amountCents: number; currency: string };

/** The PAYPAL-* headers of a webhook delivery, which PayPal's verify endpoint checks. */
export type WebhookSignatureHeaders = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
};

export type PayPalClient = ReturnType<typeof createPayPalClient>;

type Fetch = typeof fetch;

// ---------- Client ----------

export function createPayPalClient(
  config: PayPalConfig,
  options: { fetch?: Fetch; timeoutMs?: number; now?: () => number } = {},
) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let token: { value: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<string> | null = null;

  async function send(action: string, url: string, init: RequestInit, ms: number): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string };
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new PayPalError(action, "timeout", `no response within ${ms} ms; outcome unknown`, { cause: err });
      }
      const reason = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
      throw new PayPalError(action, "network", `could not reach PayPal (${reason})`, { cause: err });
    }
  }

  async function fetchToken(): Promise<string> {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await send(
      "auth",
      `${config.baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      },
      TOKEN_TIMEOUT_MS,
    );
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
      | null;
    if (!res.ok) {
      const detail = body?.error ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : "";
      if (res.status >= 500) throw new PayPalError("auth", "http", `HTTP ${res.status} ${detail}`.trim(), { status: res.status });
      throw new PayPalError("auth", "auth", `HTTP ${res.status} ${detail}`.trim(), { status: res.status });
    }
    if (!body?.access_token || typeof body.expires_in !== "number") {
      throw new PayPalError("auth", "invalid_response", "token response had no access_token");
    }
    token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return token.value;
  }

  /** Cached until shortly before expiry; concurrent callers share one request. */
  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > now()) return token.value;
    tokenRequest ??= fetchToken().finally(() => {
      tokenRequest = null;
    });
    return tokenRequest;
  }

  async function call(
    action: PayPalAction,
    orderId: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: any }> {
    const rid = requestId(orderId, action);
    const attempt = async () =>
      send(
        action,
        `${config.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "PayPal-Request-Id": rid,
            Prefer: "return=representation",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        timeoutMs,
      );

    let res = await attempt();
    if (res.status === 401) {
      // Token revoked or expired early. Same request id, so retrying is safe.
      token = null;
      res = await attempt();
    }

    const text = await res.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const issue = Array.isArray(json?.details) ? json.details[0]?.issue : undefined;
      const description = Array.isArray(json?.details) ? json.details[0]?.description : undefined;
      const message = [`HTTP ${res.status}`, json?.name, issue, description ?? json?.message].filter(Boolean).join(" ");
      throw new PayPalError(action, "http", message, {
        status: res.status,
        paypalName: json?.name,
        issue,
        debugId: json?.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
      });
    }
    return { status: res.status, json };
  }

  function invalid(action: PayPalAction, what: string): never {
    throw new PayPalError(action, "invalid_response", what);
  }

  function parseAmount(action: PayPalAction, amount: any): { amountCents: number; currency: string } {
    if (typeof amount?.value !== "string" || typeof amount?.currency_code !== "string") {
      invalid(action, "response had no amount");
    }
    try {
      return { amountCents: valueToCents(amount.value), currency: amount.currency_code };
    } catch {
      invalid(action, `response had an unreadable amount ${amount.value}`);
    }
  }

  return {
    /** POST /v2/checkout/orders with intent AUTHORIZE. The buyer approves it in PayPal next. */
    async createOrder(input: { orderId: string; amountCents: number; currency?: string }): Promise<CreatedOrder> {
      const { json } = await call("create-order", input.orderId, "/v2/checkout/orders", {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: input.orderId,
            custom_id: input.orderId, // echoed back in webhooks
            amount: { currency_code: input.currency ?? "USD", value: centsToValue(input.amountCents) },
          },
        ],
      });
      if (typeof json?.id !== "string") invalid("create-order", "response had no order id");
      const links: Array<{ rel?: string; href?: string }> = Array.isArray(json.links) ? json.links : [];
      const approve = links.find((l) => l.rel === "approve" || l.rel === "payer-action");
      return { paypalOrderId: json.id, status: String(json.status), approveUrl: approve?.href ?? null };
    },

    /** POST /v2/checkout/orders/{id}/authorize after the buyer approved. Funds are held, not taken. */
    async authorizeOrder(input: { orderId: string; paypalOrderId: string }): Promise<Authorization> {
      const { json } = await call(
        "authorize",
        input.orderId,
        `/v2/checkout/orders/${encodeURIComponent(input.paypalOrderId)}/authorize`,
        {},
      );
      const auth = json?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (typeof auth?.id !== "string") invalid("authorize", "response had no authorization");
      const expiresAt = typeof auth.expiration_time === "string" ? new Date(auth.expiration_time) : null;
      return {
        authorizationId: auth.id,
        status: String(auth.status),
        ...parseAmount("authorize", auth.amount),
        expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      };
    },

    /**
     * POST /v2/payments/authorizations/{id}/capture for exactly `amountCents`
     * (never more than authorized), as the final capture.
     */
    async captureAuthorization(input: {
      orderId: string;
      authorizationId: string;
      amountCents: number;
      currency?: string;
    }): Promise<Capture> {
      const { json } = await call(
        "capture",
        input.orderId,
        `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`,
        {
          amount: { currency_code: input.currency ?? "USD", value: centsToValue(input.amountCents) },
          final_capture: true,
        },
      );
      if (typeof json?.id !== "string") invalid("capture", "response had no capture id");
      return { captureId: json.id, status: String(json.status), ...parseAmount("capture", json.amount) };
    },

    /**
     * POST /v1/notifications/verify-webhook-signature. `rawEvent` is the
     * webhook request body exactly as received: it's embedded byte for byte,
     * because re-serializing parsed JSON can change it and fail verification.
     * The caller must have checked it parses as a JSON object. Not a money
     * call, so no PayPal-Request-Id. Returns PayPal's verification_status;
     * only "SUCCESS" means the event is genuine.
     */
    async verifyWebhookSignature(input: {
      webhookId: string;
      headers: WebhookSignatureHeaders;
      rawEvent: string;
    }): Promise<{ verificationStatus: string }> {
      const action = "verify-webhook";
      const h = input.headers;
      const fields = JSON.stringify({
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: input.webhookId,
      });
      const body = `${fields.slice(0, -1)},"webhook_event":${input.rawEvent}}`;

      const attempt = async () =>
        send(
          action,
          `${config.baseUrl}/v1/notifications/verify-webhook-signature`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await accessToken()}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body,
          },
          timeoutMs,
        );
      let res = await attempt();
      if (res.status === 401) {
        token = null;
        res = await attempt();
      }
      const json = (await res.json().catch(() => null)) as
        | { verification_status?: unknown; name?: string; debug_id?: string; message?: string }
        | null;
      if (!res.ok) {
        throw new PayPalError(action, "http", [`HTTP ${res.status}`, json?.name, json?.message].filter(Boolean).join(" "), {
          status: res.status,
          paypalName: json?.name,
          debugId: json?.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
        });
      }
      if (typeof json?.verification_status !== "string") {
        throw new PayPalError(action, "invalid_response", "response had no verification_status");
      }
      return { verificationStatus: json.verification_status };
    },

    /** POST /v2/payments/authorizations/{id}/void. The buyer is never charged. */
    async voidAuthorization(input: { orderId: string; authorizationId: string }): Promise<{ status: string }> {
      const { status, json } = await call(
        "void",
        input.orderId,
        `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/void`,
        undefined,
      );
      // 204 No Content unless PayPal honours Prefer: return=representation.
      return { status: status === 204 || !json ? "VOIDED" : String(json.status ?? "VOIDED") };
    },
  };
}

let shared: PayPalClient | null = null;

/** The app's client, built from env on first use. Throws if PayPal isn't configured. */
export function getPayPalClient(): PayPalClient {
  if (shared) return shared;
  const config = getPayPalConfig();
  if (!config) {
    throw new Error("PayPal is not configured: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_BASE_URL in server/.env");
  }
  shared = createPayPalClient(config);
  return shared;
}
