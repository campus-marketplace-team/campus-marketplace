import { type Db, prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { TEST_USER_EMAIL_PREFIX } from "../testUsers.js";
import { PAYPAL_WEBHOOK_TOPIC } from "../webhooks/ingest.js";

// Transactional outbox (see CLAUDE.md "Reliability rules").
//
// Writers call enqueueOutbox() with the transaction client of the change that
// causes the side effect, so the outbox row commits or rolls back with it.
// The worker's relay (drainOutbox) then delivers each row at least once:
//   1. claim: one UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
//      marks a batch PROCESSING, counts the attempt, and leases the rows until
//      LEASE_MS from now. Concurrent relays skip each other's rows.
//   2. run the topic's handler outside any transaction (it may call PayPal).
//   3. success → DONE. Failure → PENDING again after an exponential backoff,
//      or DEAD (dead letter) once MAX_ATTEMPTS attempts have failed.
// A relay that dies mid-handler leaves its rows PROCESSING; they're claimed
// again when the lease runs out (that counted as an attempt too).
//
// At least once means a handler can run twice for one row (e.g. lease expiry
// during a slow handler), so every handler must be idempotent.

/** A row is dead-lettered after this many failed attempts. */
export const MAX_ATTEMPTS = 5;
/** Delay before retry n is BACKOFF_BASE_MS · 2^(n−1): 30 s, 1 min, 2 min, 4 min. */
export const BACKOFF_BASE_MS = 30 * 1000;
/** How long a claimed row belongs to the relay that claimed it. Handlers must finish well within it. */
export const LEASE_MS = 5 * 60 * 1000;
/** Rows claimed per drain. */
export const DRAIN_BATCH_SIZE = 20;

const MAX_ERROR_LENGTH = 1000;

export type OutboxEvent = {
  id: string;
  orderId: string | null;
  topic: string;
  payload: Prisma.JsonValue;
  /** Attempts so far, including this one (1 on the first run). */
  attempts: number;
};

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;
export type OutboxHandlers = Readonly<Record<string, OutboxHandler>>;

export type DrainResult = { claimed: number; done: number; retried: number; dead: number };

/** Writes an outbox row in the caller's transaction. */
export async function enqueueOutbox(
  db: Db,
  event: { topic: string; orderId?: string | null; payload: Prisma.InputJsonValue; availableAt?: Date },
) {
  return db.outboxEvent.create({
    data: {
      topic: event.topic,
      orderId: event.orderId ?? null,
      payload: event.payload,
      ...(event.availableAt ? { nextAttemptAt: event.availableAt } : {}),
    },
    select: { id: true },
  });
}

/** Wait before the retry that follows failed attempt `attempts` (1-based). */
export function backoffMs(attempts: number) {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/** Which topics a relay handles: only these, or all but these. Left out, it handles every topic. */
export type OutboxTopicFilter = { only?: readonly string[]; except?: readonly string[] };

/** Which rows a relay may touch. `skipTestUsers`: leave test users' rows alone (see src/testUsers.ts). */
export type OutboxScope = { topics?: OutboxTopicFilter; skipTestUsers?: boolean };

/**
 * SQL conditions on "outbox" rows for a relay's scope. A test user's row is one
 * whose order has a test buyer or seller, or a paypal.webhook row (no order id
 * of its own) whose stored event names such an order by one of the ids
 * findOrderForEvent looks up (src/webhooks/process.ts).
 */
function scopeSql({ topics: { only, except } = {}, skipTestUsers = false }: OutboxScope): Prisma.Sql {
  const onlyTopics = only ? [...only] : null;
  const exceptTopics = except ? [...except] : [];
  const topicSql = Prisma.sql`
    AND (${onlyTopics}::text[] IS NULL OR "outbox"."topic" = ANY(${onlyTopics}::text[]))
    AND NOT ("outbox"."topic" = ANY(${exceptTopics}::text[]))`;
  if (!skipTestUsers) return topicSql;
  const testEmail = `${TEST_USER_EMAIL_PREFIX}%`;
  return Prisma.sql`${topicSql}
    AND NOT EXISTS (
      SELECT 1 FROM "orders" o
      JOIN "users" b ON b."id" = o."buyer_id"
      JOIN "users" s ON s."id" = o."seller_id"
      WHERE (b."email" LIKE ${testEmail} OR s."email" LIKE ${testEmail})
        AND (
          o."id" = "outbox"."order_id"
          OR ("outbox"."topic" = ${PAYPAL_WEBHOOK_TOPIC} AND EXISTS (
            SELECT 1 FROM "webhook_events" w, LATERAL (SELECT w."payload" -> 'resource' AS r) res
            WHERE w."id"::text = "outbox"."payload" ->> 'webhookEventId'
              AND (
                o."id"::text IN (res.r ->> 'custom_id', res.r -> 'purchase_units' -> 0 ->> 'custom_id', res.r -> 'payout_item' ->> 'sender_item_id')
                OR o."paypal_order_id" IN (res.r ->> 'id', res.r -> 'supplementary_data' -> 'related_ids' ->> 'order_id')
                OR o."paypal_authorization_id" IN (res.r ->> 'id', res.r -> 'supplementary_data' -> 'related_ids' ->> 'authorization_id')
                OR o."paypal_capture_id" IN (
                  res.r ->> 'id',
                  res.r -> 'supplementary_data' -> 'related_ids' ->> 'capture_id',
                  res.r -> 'disputed_transactions' -> 0 ->> 'seller_transaction_id'
                )
                OR o."paypal_payout_item_id" = res.r ->> 'payout_item_id'
                OR o."paypal_payout_batch_id" = res.r ->> 'payout_batch_id'
              )
          ))
        )
    )`;
}

/** Claims up to `limit` due rows (PENDING, or PROCESSING with an expired lease) for this relay. */
export async function claimOutboxBatch(
  now: Date,
  limit = DRAIN_BATCH_SIZE,
  topics: OutboxTopicFilter = {},
  { skipTestUsers = false }: { skipTestUsers?: boolean } = {},
): Promise<OutboxEvent[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return prisma.$queryRaw<OutboxEvent[]>`
    UPDATE "outbox"
    SET "status" = 'PROCESSING', "attempts" = "attempts" + 1, "next_attempt_at" = ${leaseUntil}
    WHERE "id" IN (
      SELECT "id" FROM "outbox"
      WHERE "status" IN ('PENDING', 'PROCESSING')
        AND "next_attempt_at" <= ${now}
        AND "attempts" < ${MAX_ATTEMPTS}
        ${scopeSql({ topics, skipTestUsers })}
      ORDER BY "next_attempt_at"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "order_id" AS "orderId", "topic", "payload", "attempts"`;
}

/**
 * Rows whose last allowed attempt was claimed but never finished (the relay
 * died, or the handler outran its lease) can't be claimed again: dead-letter
 * them. Only rows in the relay's scope.
 */
export async function deadLetterAbandoned(now: Date, scope: OutboxScope = {}) {
  const lastError = "lease expired on the last attempt (relay stopped or handler too slow)";
  const count = await prisma.$executeRaw`
    UPDATE "outbox"
    SET "status" = 'DEAD', "last_error" = ${lastError}
    WHERE "status" = 'PROCESSING'
      AND "next_attempt_at" <= ${now}
      AND "attempts" >= ${MAX_ATTEMPTS}
      ${scopeSql(scope)}`;
  if (count > 0) console.error(`outbox: ${count} row(s) dead-lettered after an abandoned last attempt`);
  return count;
}

/** Only the relay that claimed this attempt may finish it: a re-claim bumps attempts. */
function ownClaim(event: OutboxEvent) {
  return { id: event.id, status: "PROCESSING" as const, attempts: event.attempts };
}

/** Runs one claimed row's handler and records the outcome. */
export async function processOutboxEvent(
  handlers: OutboxHandlers,
  event: OutboxEvent,
  now: Date,
): Promise<"done" | "retried" | "dead"> {
  let error: string | null = null;
  const handler = Object.hasOwn(handlers, event.topic) ? handlers[event.topic] : undefined;
  if (!handler) {
    // Retried rather than dead-lettered at once: a worker older than the server may just not know it yet.
    error = `no handler for topic ${event.topic}`;
  } else {
    try {
      await handler(event);
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)) || "handler failed";
    }
  }

  if (error === null) {
    const { count } = await prisma.outboxEvent.updateMany({
      where: ownClaim(event),
      data: { status: "DONE", processedAt: new Date(), lastError: null },
    });
    if (count === 0) console.error(`outbox ${event.id}: finished after its lease ran out (it may run again)`);
    return "done";
  }

  const lastError = error.slice(0, MAX_ERROR_LENGTH);
  if (event.attempts >= MAX_ATTEMPTS) {
    await prisma.outboxEvent.updateMany({ where: ownClaim(event), data: { status: "DEAD", lastError } });
    console.error(`outbox ${event.id} (${event.topic}): dead-lettered after ${event.attempts} attempts: ${lastError}`);
    return "dead";
  }
  await prisma.outboxEvent.updateMany({
    where: ownClaim(event),
    data: { status: "PENDING", lastError, nextAttemptAt: new Date(now.getTime() + backoffMs(event.attempts)) },
  });
  console.error(`outbox ${event.id} (${event.topic}): attempt ${event.attempts} failed, will retry: ${lastError}`);
  return "retried";
}

/** One relay pass: dead-letter abandoned rows, then claim and process one batch. */
export async function drainOutbox(
  handlers: OutboxHandlers,
  { now = new Date(), limit = DRAIN_BATCH_SIZE, topics, skipTestUsers = false }: { now?: Date; limit?: number } & OutboxScope = {},
): Promise<DrainResult> {
  await deadLetterAbandoned(now, { topics, skipTestUsers });
  const batch = await claimOutboxBatch(now, limit, topics, { skipTestUsers });
  const result: DrainResult = { claimed: batch.length, done: 0, retried: 0, dead: 0 };
  // One at a time, in claim order (oldest first).
  for (const event of batch) {
    result[await processOutboxEvent(handlers, event, now)] += 1;
  }
  return result;
}
