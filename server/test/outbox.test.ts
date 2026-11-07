import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { transition } from "../src/orders/stateMachine.js";
import {
  notifyOrderStateChanged,
  ORDER_STATE_CHANGED,
  outboxHandlers,
  stateNotificationKind,
} from "../src/outbox/handlers.js";
import {
  BACKOFF_BASE_MS,
  backoffMs,
  claimOutboxBatch,
  drainOutbox,
  enqueueOutbox,
  LEASE_MS,
  MAX_ATTEMPTS,
  type OutboxEvent,
  type OutboxHandler,
  processOutboxEvent,
} from "../src/outbox/outbox.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// Transactional outbox against the real database.
//
// The database is shared with real rows, so relay tests run in the year 2001:
// their rows are due around NOW, and a drain "at" NOW can't claim any real row
// (all due far later). Their topics carry this run's id and are deleted after
// each test. Don't run the worker while the tests run: it would claim these rows.

const NOW = new Date("2001-03-01T12:00:00.000Z");
const SECOND = 1000;
const TOPIC = `test.outbox.${randomUUID().slice(0, 8)}`;

let buyerId: string;
let sellerId: string;
let listingId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("outbox-buyer")).id;
  sellerId = (await createTestUser("outbox-seller")).id;
  listingId = (
    await prisma.listing.create({
      data: { sellerId, title: "outbox test", description: "test", category: "OTHER", priceCents: 5000 },
      select: { id: true },
    })
  ).id;
});

afterEach(async () => {
  await prisma.outboxEvent.deleteMany({ where: { topic: { startsWith: TOPIC } } });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function at(offsetMs: number) {
  return new Date(NOW.getTime() + offsetMs);
}

/** A test row due at NOW (+ offset). */
async function enqueue({ topic = TOPIC, offsetMs = 0, payload = { n: 1 } } = {}) {
  return (await enqueueOutbox(prisma, { topic, payload, availableAt: at(offsetMs) })).id;
}

async function readRow(id: string) {
  return prisma.outboxEvent.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempts: true, nextAttemptAt: true, lastError: true, processedAt: true },
  });
}

function createOrder() {
  return prisma.order.create({
    data: { listingId, buyerId, sellerId, amountCents: 5000, platformFeeCents: 500 },
    select: { id: true },
  });
}

function outboxFor(orderId: string) {
  return prisma.outboxEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

describe("topic filters", () => {
  const OTHER = `${TOPIC}.slow`;

  it("lets one relay take only some topics and another take the rest", async () => {
    const fast = await enqueue();
    const slow = await enqueue({ topic: OTHER });
    const fastClaim = await claimOutboxBatch(NOW, 20, { except: [OTHER] });
    expect(fastClaim.map((row) => row.id)).toEqual([fast]);
    const slowClaim = await claimOutboxBatch(NOW, 20, { only: [OTHER] });
    expect(slowClaim.map((row) => row.id)).toEqual([slow]);
  });

  it("drains the filtered topics only", async () => {
    const handler = vi.fn(async () => {});
    await enqueue();
    const slow = await enqueue({ topic: OTHER });
    const result = await drainOutbox({ [TOPIC]: handler, [OTHER]: handler }, { now: NOW, limit: 1, topics: { only: [OTHER] } });
    expect(result).toMatchObject({ claimed: 1, done: 1 });
    expect((await readRow(slow)).status).toBe("DONE");
  });
});

describe("transition() writes the outbox row in the same transaction", () => {
  it("writes one order.state_changed row per successful transition", async () => {
    const order = await createOrder();
    await prisma.$transaction((tx) => transition(tx, order.id, "CREATED", "AUTHORIZED", 0));
    await transition(prisma, order.id, "AUTHORIZED", "CAPTURED", 1); // root client: wrapped in its own transaction

    const rows = await outboxFor(order.id);
    expect(rows.map((r) => [r.topic, r.payload, r.status, r.attempts])).toEqual([
      [ORDER_STATE_CHANGED, { from: "CREATED", to: "AUTHORIZED", version: 1 }, "PENDING", 0],
      [ORDER_STATE_CHANGED, { from: "AUTHORIZED", to: "CAPTURED", version: 2 }, "PENDING", 0],
    ]);
  });

  it("rolls the outbox row back with the caller's transaction", async () => {
    const order = await createOrder();
    await expect(
      prisma.$transaction(async (tx) => {
        await transition(tx, order.id, "CREATED", "AUTHORIZED", 0);
        expect(await tx.outboxEvent.count({ where: { orderId: order.id } })).toBe(1);
        throw new Error("later write failed");
      }),
    ).rejects.toThrow("later write failed");
    expect(await outboxFor(order.id)).toEqual([]);
  });

  it("writes nothing when the transition loses or is illegal", async () => {
    const order = await createOrder();
    await expect(transition(prisma, order.id, "CREATED", "AUTHORIZED", 5)).rejects.toThrow(/expected CREATED v5/);
    await expect(transition(prisma, order.id, "CREATED", "CAPTURED", 0)).rejects.toThrow(/Illegal/);
    expect(await outboxFor(order.id)).toEqual([]);
  });

  it("of two concurrent transitions, only the winner writes a row", async () => {
    const order = await createOrder();
    await transition(prisma, order.id, "CREATED", "AUTHORIZED", 0);
    const results = await Promise.allSettled([
      transition(prisma, order.id, "AUTHORIZED", "CAPTURED", 1),
      transition(prisma, order.id, "AUTHORIZED", "VOIDED", 1),
    ]);
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ state: string }>;
    const rows = await outboxFor(order.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].payload).toEqual({ from: "AUTHORIZED", to: winner.value.state, version: 2 });
  });
});

describe("drainOutbox", () => {
  it("runs the topic's handler and marks the row DONE", async () => {
    const handler = vi.fn<OutboxHandler>().mockResolvedValue(undefined);
    const id = await enqueue({ payload: { n: 42 } });

    expect(await drainOutbox({ [TOPIC]: handler }, { now: NOW })).toEqual({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id, orderId: null, topic: TOPIC, payload: { n: 42 }, attempts: 1 });
    expect(await readRow(id)).toMatchObject({ status: "DONE", attempts: 1, lastError: null });
    expect((await readRow(id)).processedAt).not.toBeNull();

    // Done rows are never claimed again.
    expect((await drainOutbox({ [TOPIC]: handler }, { now: at(LEASE_MS * 10) })).claimed).toBe(0);
  });

  it("doesn't claim rows before they're due", async () => {
    const handler = vi.fn<OutboxHandler>().mockResolvedValue(undefined);
    await enqueue({ offsetMs: SECOND });
    expect((await drainOutbox({ [TOPIC]: handler }, { now: NOW })).claimed).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("retries with exponential backoff and dead-letters after 5 failed attempts", async () => {
    const handler = vi.fn<OutboxHandler>().mockRejectedValue(new Error("PayPal timed out"));
    const handlers = { [TOPIC]: handler };
    const id = await enqueue();

    let now = NOW;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await drainOutbox(handlers, { now });
      const row = await readRow(id);
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe("PayPal timed out");

      if (attempt < MAX_ATTEMPTS) {
        expect(result).toMatchObject({ claimed: 1, retried: 1 });
        expect(row.status).toBe("PENDING");
        const delay = row.nextAttemptAt.getTime() - now.getTime();
        delays.push(delay);
        // Not claimable a moment before it's due.
        expect((await drainOutbox(handlers, { now: new Date(row.nextAttemptAt.getTime() - 1) })).claimed).toBe(0);
        now = row.nextAttemptAt;
      } else {
        expect(result).toMatchObject({ claimed: 1, dead: 1 });
        expect(row.status).toBe("DEAD");
      }
    }
    expect(delays).toEqual([1, 2, 4, 8].map((x) => x * BACKOFF_BASE_MS));
    expect(handler).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    // Dead rows stay dead.
    expect((await drainOutbox(handlers, { now: at(24 * 60 * 60 * SECOND) })).claimed).toBe(0);
  });

  it("succeeds on a later attempt after failures", async () => {
    const handler = vi
      .fn<OutboxHandler>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue(undefined);
    const id = await enqueue();

    await drainOutbox({ [TOPIC]: handler }, { now: NOW });
    await drainOutbox({ [TOPIC]: handler }, { now: at(backoffMs(1)) });
    await drainOutbox({ [TOPIC]: handler }, { now: at(backoffMs(1) + backoffMs(2)) });

    expect(await readRow(id)).toMatchObject({ status: "DONE", attempts: 3, lastError: null });
    expect(handler.mock.calls.map(([e]) => e.attempts)).toEqual([1, 2, 3]);
  });

  it("retries a topic with no handler instead of dropping it", async () => {
    const id = await enqueue({ topic: `${TOPIC}.unknown` });
    expect(await drainOutbox({}, { now: NOW })).toMatchObject({ claimed: 1, retried: 1 });
    expect(await readRow(id)).toMatchObject({ status: "PENDING", lastError: `no handler for topic ${TOPIC}.unknown` });
  });

  it("skips rows another transaction has locked (FOR UPDATE SKIP LOCKED) and claims the rest", async () => {
    const handler = vi.fn<OutboxHandler>().mockResolvedValue(undefined);
    const locked = await enqueue();
    const free = await enqueue();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "outbox" WHERE "id" = ${locked}::uuid FOR UPDATE`;
      // A relay on another connection doesn't wait for the lock; it skips the row.
      expect(await drainOutbox({ [TOPIC]: handler }, { now: NOW })).toMatchObject({ claimed: 1, done: 1 });
    });

    expect(handler.mock.calls.map(([e]) => e.id)).toEqual([free]);
    expect(await readRow(locked)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await readRow(free)).toMatchObject({ status: "DONE" });
  });

  it("concurrent relays process every row exactly once", async () => {
    const seen: string[] = [];
    const handler: OutboxHandler = async (e) => {
      seen.push(e.id);
    };
    const ids = await Promise.all(Array.from({ length: 12 }, () => enqueue()));

    const results = await Promise.all(
      Array.from({ length: 3 }, () => drainOutbox({ [TOPIC]: handler }, { now: NOW, limit: 5 })),
    );
    // Drain until empty in case one relay's batch came back short.
    while ((await drainOutbox({ [TOPIC]: handler }, { now: NOW, limit: 5 })).claimed > 0);

    expect(results.reduce((n, r) => n + r.claimed, 0)).toBeLessThanOrEqual(12);
    expect(seen.sort()).toEqual([...ids].sort());
    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: ids } }, select: { status: true, attempts: true } });
    expect(rows.every((r) => r.status === "DONE" && r.attempts === 1)).toBe(true);
  });

  it("re-claims a row whose relay died mid-handler once the lease runs out", async () => {
    const id = await enqueue();
    // A relay claims it and then dies without recording anything.
    expect((await claimOutboxBatch(NOW)).map((e) => e.id)).toEqual([id]);
    expect(await readRow(id)).toMatchObject({ status: "PROCESSING", attempts: 1 });

    const handler = vi.fn<OutboxHandler>().mockResolvedValue(undefined);
    expect((await drainOutbox({ [TOPIC]: handler }, { now: at(LEASE_MS - 1) })).claimed).toBe(0);
    expect(await drainOutbox({ [TOPIC]: handler }, { now: at(LEASE_MS) })).toMatchObject({ claimed: 1, done: 1 });
    expect(await readRow(id)).toMatchObject({ status: "DONE", attempts: 2 });
  });

  it("a relay whose lease ran out can't overwrite the newer attempt's result", async () => {
    const id = await enqueue();
    const [stale] = await claimOutboxBatch(NOW); // attempt 1, then stalls
    const [fresh] = await claimOutboxBatch(at(LEASE_MS)); // attempt 2 after the lease
    expect([stale.attempts, fresh.attempts]).toEqual([1, 2]);

    await processOutboxEvent({ [TOPIC]: async () => {} }, fresh, at(LEASE_MS));
    await processOutboxEvent({ [TOPIC]: async () => Promise.reject(new Error("late failure")) }, stale, NOW);
    expect(await readRow(id)).toMatchObject({ status: "DONE", attempts: 2, lastError: null });
  });

  it("dead-letters a row whose last allowed attempt was abandoned", async () => {
    const id = await enqueue();
    await prisma.outboxEvent.update({ where: { id }, data: { attempts: MAX_ATTEMPTS - 1 } });
    await claimOutboxBatch(NOW); // the 5th attempt, abandoned

    const handler = vi.fn<OutboxHandler>().mockResolvedValue(undefined);
    expect((await drainOutbox({ [TOPIC]: handler }, { now: at(LEASE_MS) })).claimed).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(await readRow(id)).toMatchObject({ status: "DEAD", attempts: MAX_ATTEMPTS });
  });
});

describe("order.state_changed handler", () => {
  function event(orderId: string | null, payload: unknown): OutboxEvent {
    return { id: randomUUID(), orderId, topic: ORDER_STATE_CHANGED, payload: payload as OutboxEvent["payload"], attempts: 1 };
  }

  async function notes(orderId: string) {
    return prisma.notification.findMany({ where: { orderId }, select: { userId: true, kind: true, message: true } });
  }

  it("is the registered handler for the topic", () => {
    expect(outboxHandlers[ORDER_STATE_CHANGED]).toBe(notifyOrderStateChanged);
  });

  it("notifies the buyer and the seller once, however often it runs", async () => {
    const order = await createOrder();
    const e = event(order.id, { from: "CREATED", to: "AUTHORIZED", version: 1 });
    await notifyOrderStateChanged(e);
    await notifyOrderStateChanged(e);

    const rows = await notes(order.id);
    expect(rows.map((n) => n.userId).sort()).toEqual([buyerId, sellerId].sort());
    expect(rows.every((n) => n.kind === stateNotificationKind("AUTHORIZED") && n.message.length > 0)).toBe(true);
  });

  it("doesn't duplicate a notification the writer already created (the deadline job's ORDER_VOIDED)", async () => {
    const order = await createOrder();
    await prisma.notification.create({
      data: { userId: buyerId, orderId: order.id, kind: "ORDER_VOIDED", message: "from the deadline job" },
    });
    await notifyOrderStateChanged(event(order.id, { from: "AUTHORIZED", to: "VOIDED", version: 2 }));

    const rows = await notes(order.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((n) => n.userId === buyerId)?.message).toBe("from the deadline job");
  });

  it("sends nothing for states without a message, or when the order is gone", async () => {
    const order = await createOrder();
    await notifyOrderStateChanged(event(order.id, { from: "CREATED", to: "BLOCKED", version: 1 }));
    await notifyOrderStateChanged(event(randomUUID(), { from: "CREATED", to: "AUTHORIZED", version: 1 }));
    expect(await notes(order.id)).toEqual([]);
  });

  it("rejects a malformed payload (so the relay retries, then dead-letters it)", async () => {
    const order = await createOrder();
    for (const payload of [null, {}, { from: "CREATED", to: "NOPE", version: 1 }, { from: "CREATED", to: "AUTHORIZED" }]) {
      await expect(notifyOrderStateChanged(event(order.id, payload))).rejects.toThrow(/malformed/);
    }
  });
});
