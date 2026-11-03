import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { enqueueOutbox } from "../outbox/outbox.js";
import { type PayPalClient, PayPalError, type WebhookSignatureHeaders } from "../paypal/client.js";

// PayPal webhook ingestion (see CLAUDE.md "Webhooks"): verify, store, queue,
// answer 2xx. Processing happens later in the worker (src/webhooks/process.ts),
// so PayPal gets its answer quickly.
//
//   1. Verify the signature with PayPal's verify-webhook-signature endpoint,
//      sending the PAYPAL-* headers, our webhook id and the raw body.
//      Anything but verification_status SUCCESS is refused and not stored.
//   2. In ONE DB transaction: insert into webhook_events with ON CONFLICT
//      (event_id) DO NOTHING, and, only if that inserted a row, an outbox row
//      (topic paypal.webhook) for the worker. A redelivery is a no-op.
//
// The payload is untrusted data until verified, and even then it's data, never
// instructions. Nothing from it is logged except the event id and type.

/** Outbox topic for a stored webhook event waiting to be processed. */
export const PAYPAL_WEBHOOK_TOPIC = "paypal.webhook";

export type PayPalWebhookJob = { webhookEventId: string };

/** Longest event id / type / resource id we store; PayPal's are far shorter. */
const MAX_ID_LENGTH = 255;

export type IngestResult =
  | { status: 200; body: { received: true; duplicate: boolean } }
  | { status: 400 | 503; body: { error: string } };

/** PAYPAL_WEBHOOK_ID: the id PayPal shows for our webhook (Apps & Credentials → app → Webhooks). */
export function getPayPalWebhookId(): string | null {
  return (process.env.PAYPAL_WEBHOOK_ID ?? "").trim() || null;
}

/** The five PAYPAL-* headers, or null if any is missing. `get` reads a header case-insensitively. */
export function signatureHeaders(get: (name: string) => string | undefined): WebhookSignatureHeaders | null {
  const authAlgo = get("paypal-auth-algo");
  const certUrl = get("paypal-cert-url");
  const transmissionId = get("paypal-transmission-id");
  const transmissionSig = get("paypal-transmission-sig");
  const transmissionTime = get("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return null;
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

function shortString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

const refuse = (status: 400 | 503, error: string): IngestResult => ({ status, body: { error } });

export async function ingestPayPalWebhook(
  paypal: PayPalClient,
  input: { webhookId: string | null; headers: WebhookSignatureHeaders | null; rawBody: string },
): Promise<IngestResult> {
  // Without our webhook id nothing can be verified. 503 so PayPal keeps retrying (for 3 days) until it's set.
  if (!input.webhookId) {
    console.error("webhook: PAYPAL_WEBHOOK_ID is not set; refusing PayPal webhooks until it is");
    return refuse(503, "Webhooks aren't configured");
  }
  if (!input.headers) return refuse(400, "Missing PayPal signature headers");

  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(400, "Malformed event");
    event = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "Malformed event");
  }
  const eventId = shortString(event.id);
  const eventType = shortString(event.event_type);
  if (!eventId || !eventType) return refuse(400, "Malformed event");

  try {
    const { verificationStatus } = await paypal.verifyWebhookSignature({
      webhookId: input.webhookId,
      headers: input.headers,
      rawEvent: input.rawBody,
    });
    if (verificationStatus !== "SUCCESS") {
      console.error(`webhook ${eventId} (${eventType}): signature verification ${verificationStatus}; not stored`);
      return refuse(400, "Signature verification failed");
    }
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    // We couldn't check it, so we can't accept it. 503: PayPal redelivers it later.
    console.error(`webhook ${eventId} (${eventType}): ${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`);
    return refuse(503, "Couldn't verify the event right now");
  }

  const resource = event.resource as Record<string, unknown> | undefined;
  const id = randomUUID();
  const inserted = await prisma.$transaction(async (tx) => {
    // createMany + skipDuplicates is INSERT ... ON CONFLICT DO NOTHING; the conflict is UNIQUE(event_id).
    const { count } = await tx.webhookEvent.createMany({
      data: [
        {
          id,
          eventId,
          eventType,
          resourceId: shortString(resource && typeof resource === "object" ? resource.id : null),
          payload: event as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) {
      const job: PayPalWebhookJob = { webhookEventId: id };
      await enqueueOutbox(tx, { topic: PAYPAL_WEBHOOK_TOPIC, payload: job });
    }
    return count === 1;
  });

  if (!inserted) console.log(`webhook ${eventId} (${eventType}): duplicate delivery, ignored`);
  return { status: 200, body: { received: true, duplicate: !inserted } };
}

/**
 * Stored events that were never finished (processed_at null, e.g. left
 * "no handler" before their handler existed) and have no outbox row waiting.
 * With `apply`, queues each of them again. Returns their ids.
 */
export async function requeueUnprocessedWebhookEvents({ apply = false } = {}) {
  const unprocessed = await prisma.webhookEvent.findMany({
    where: { processedAt: null },
    orderBy: { receivedAt: "asc" },
    select: { id: true },
  });
  const waiting = await prisma.outboxEvent.findMany({
    where: { topic: PAYPAL_WEBHOOK_TOPIC, status: { in: ["PENDING", "PROCESSING"] } },
    select: { payload: true },
  });
  const queued = new Set(waiting.map((w) => (w.payload as Partial<PayPalWebhookJob> | null)?.webhookEventId));
  const ids = unprocessed.map((e) => e.id).filter((id) => !queued.has(id));
  if (apply) {
    for (const id of ids) {
      const job: PayPalWebhookJob = { webhookEventId: id };
      await enqueueOutbox(prisma, { topic: PAYPAL_WEBHOOK_TOPIC, payload: job });
    }
  }
  return ids;
}
