import { ORDER_STATES, isLegalTransition } from "@campus/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { LedgerAccount } from "../src/generated/prisma/enums.js";
import { LedgerValidationError, postTransaction, type LedgerEntryInput } from "../src/ledger/postTransaction.js";
import { recordAuthorization } from "../src/orders/checkout.js";
import { recordCapture } from "../src/orders/handoff.js";
import { IllegalTransitionError, StaleOrderError, transition } from "../src/orders/stateMachine.js";
import { cleanup, createTestUser, prisma } from "./helpers/api.js";

// The Phase 2 money invariants, each checked exhaustively or over many cases:
// every illegal transition is rejected, N concurrent updates on one version
// produce exactly one winner, every ledger transaction sums to zero, and an
// unbalanced one is refused (by postTransaction and, if bypassed, by Postgres).
//
// ledger_entries is append-only, so nothing here commits ledger rows: writes
// run in inRolledBackTx(), which fires the deferred balance check first.

class Rollback extends Error {}

async function inRolledBackTx(fn: (tx: Db) => Promise<void>) {
  await expect(
    prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 20_000 },
    ),
  ).rejects.toBeInstanceOf(Rollback);
}

/** A Db that fails the test if anything touches it: proves a call was refused before any query. */
function untouchableDb(): Db {
  return new Proxy({} as Db, {
    get(_target, prop) {
      throw new Error(`database was touched (${String(prop)})`);
    },
  });
}

// Deterministic PRNG so a failing case reproduces.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = Object.values(LedgerAccount);

/** 2-6 non-zero integer-cent entries over random accounts that sum to zero. */
function randomBalanced(rand: () => number): LedgerEntryInput[] {
  const n = 2 + Math.floor(rand() * 5);
  const entries: LedgerEntryInput[] = [];
  for (let i = 0; i < n - 1; i++) {
    const cents = 1 + Math.floor(rand() * 1_000_000);
    entries.push({ account: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)], amountCents: rand() < 0.5 ? cents : -cents });
  }
  let rest = -entries.reduce((s, e) => s + e.amountCents, 0);
  if (rest === 0) {
    entries[0].amountCents += 1;
    rest = -1;
  }
  entries.push({ account: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)], amountCents: rest });
  return entries;
}

let buyerId: string;
let sellerId: string;

beforeAll(async () => {
  buyerId = (await createTestUser("inv-buyer")).id;
  sellerId = (await createTestUser("inv-seller")).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function createOrder({ amountCents = 5000, platformFeeCents = 500 } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "invariants test", description: "test", category: "OTHER", priceCents: amountCents },
    select: { id: true },
  });
  return prisma.order.create({
    data: { listingId: listing.id, buyerId, sellerId, amountCents, platformFeeCents },
    select: { id: true, listingId: true, version: true, amountCents: true, platformFeeCents: true },
  });
}

async function readOrder(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id }, select: { state: true, version: true } });
}

describe("every illegal transition is rejected", () => {
  const illegal = ORDER_STATES.flatMap((from) =>
    ORDER_STATES.filter((to) => !isLegalTransition(from, to)).map((to) => [from, to] as const),
  );

  it("covers all state pairs outside the 18 legal moves", () => {
    expect(illegal).toHaveLength(ORDER_STATES.length ** 2 - 18);
  });

  it.each(illegal)("%s → %s throws IllegalTransitionError before any query", async (from, to) => {
    const err = await transition(untouchableDb(), randomUUID(), from, to, 0).catch((e) => e);
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err).toMatchObject({ from, to });
  });
});

describe("concurrent updates with the same version", () => {
  const RACERS = 5;

  it("double-clicked capture: of N identical transitions, each in its own transaction, exactly one wins", async () => {
    const order = await createOrder();
    await transition(prisma, order.id, "CREATED", "AUTHORIZED", 0);

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () =>
        prisma.$transaction((tx) => transition(tx, order.id, "AUTHORIZED", "CAPTURED", 1)),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(RACERS - 1);
    for (const l of lost) expect(l.reason).toBeInstanceOf(StaleOrderError);

    // Version moved by exactly one: no loser slipped a second update in.
    expect(await readOrder(order.id)).toEqual({ state: "CAPTURED", version: 2 });
  });

  it("capture vs void vs dispute racing on one version: exactly one wins and its state sticks", async () => {
    const order = await createOrder();
    await transition(prisma, order.id, "CREATED", "AUTHORIZED", 0);

    const targets = ["CAPTURED", "VOIDED", "IN_DISPUTE", "CAPTURED", "VOIDED"] as const;
    const results = await Promise.allSettled(
      targets.map((to) => prisma.$transaction((tx) => transition(tx, order.id, "AUTHORIZED", to, 1))),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(StaleOrderError);

    const winner = (won[0] as PromiseFulfilledResult<{ state: string }>).value.state;
    expect(await readOrder(order.id)).toEqual({ state: winner, version: 2 });
  });

  it("a loser's StaleOrderError rolls back the rest of its transaction", async () => {
    const order = await createOrder();
    await transition(prisma, order.id, "CREATED", "AUTHORIZED", 0);

    // Each racer first writes a listing change, then tries the transition.
    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        prisma.$transaction(async (tx) => {
          await tx.listing.update({ where: { id: order.listingId }, data: { title: `racer ${i}` } });
          return { i, ...(await transition(tx, order.id, "AUTHORIZED", "CAPTURED", 1)) };
        }),
      ),
    );
    const won = results.filter((r): r is PromiseFulfilledResult<{ i: number }> => r.status === "fulfilled");
    expect(won).toHaveLength(1);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: order.listingId }, select: { title: true } });
    expect(listing.title).toBe(`racer ${won[0].value.i}`);
  });
});

describe("every ledger transaction sums to zero", () => {
  // [amount, fee] in cents, including a zero fee and odd amounts.
  const sales: Array<[number, number]> = [
    [5000, 500],
    [5, 0],
    [1999, 199],
    [123_457, 12_346],
    [1, 0],
  ];

  it.each(sales)("authorize + capture of a %i¢ sale (fee %i¢) posts only zero-sum transactions", async (amountCents, platformFeeCents) => {
    const order = await createOrder({ amountCents, platformFeeCents });

    await inRolledBackTx(async (tx) => {
      const now = new Date();
      await recordAuthorization(
        tx,
        order,
        { authorizationId: `AUTH-${randomUUID()}`, status: "CREATED", amountCents, currency: "USD", expiresAt: null },
        now,
      );
      await recordCapture(
        tx,
        { ...order, version: order.version + 1 },
        { captureId: `CAP-${randomUUID()}`, status: "COMPLETED", amountCents, currency: "USD" },
        now,
      );
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the commit-time balance check

      const entries = await tx.ledgerEntry.findMany({ where: { orderId: order.id } });
      const sumByTx = new Map<string, number>();
      for (const e of entries) sumByTx.set(e.transactionId, (sumByTx.get(e.transactionId) ?? 0) + e.amountCents);
      expect(sumByTx.size).toBe(2);
      for (const [txId, sum] of sumByTx) expect(sum, txId).toBe(0);

      // Net position per account after capture: escrow released, seller + fee = buyer's money.
      const net = (account: LedgerAccount) =>
        entries.filter((e) => e.account === account).reduce((s, e) => s + e.amountCents, 0);
      expect(net("escrow_held")).toBe(0);
      expect(net("buyer_funds")).toBe(-amountCents);
      expect(net("seller_payable")).toBe(amountCents - platformFeeCents);
      expect(net("platform_fees")).toBe(platformFeeCents);
    });
  });

  // One round trip per transaction to the remote DB, hence the longer timeout.
  it("accepts 20 random balanced transactions and each one sums to zero in the database", { timeout: 30_000 }, async () => {
    const rand = mulberry32(27);
    await inRolledBackTx(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const posted = await postTransaction(tx, randomBalanced(rand), { kind: "TEST-INVARIANT" });
        ids.push(posted.transactionId);
      }
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;

      const sums = await tx.ledgerEntry.groupBy({
        by: ["transactionId"],
        where: { transactionId: { in: ids } },
        _sum: { amountCents: true },
      });
      expect(sums).toHaveLength(20);
      for (const s of sums) expect(s._sum.amountCents, s.transactionId).toBe(0);
    });
  });

  it("no committed transaction in the ledger is unbalanced", async () => {
    const unbalanced = await prisma.ledgerEntry.groupBy({
      by: ["transactionId"],
      _sum: { amountCents: true },
      having: { amountCents: { _sum: { not: 0 } } },
    });
    expect(unbalanced).toEqual([]);
  });
});

describe("an unbalanced transaction is refused", () => {
  it("postTransaction refuses 200 random off-by-some transactions before any query", async () => {
    const rand = mulberry32(72);
    for (let i = 0; i < 200; i++) {
      const entries = randomBalanced(rand);
      const delta = (1 + Math.floor(rand() * 100)) * (rand() < 0.5 ? 1 : -1);
      const j = Math.floor(rand() * entries.length);
      // Skip the rare nudge that lands on zero; that's refused for a different reason.
      if (entries[j].amountCents + delta === 0) continue;
      entries[j] = { ...entries[j], amountCents: entries[j].amountCents + delta };

      await expect(postTransaction(untouchableDb(), entries, { kind: "TEST" }), JSON.stringify(entries)).rejects.toThrow(
        new LedgerValidationError(`Ledger transaction is unbalanced (sum = ${delta})`),
      );
    }
  });

  it("Postgres refuses an unbalanced transaction at COMMIT even when postTransaction is bypassed", async () => {
    const kind = `TEST-${randomUUID()}`;
    const transactionId = randomUUID();
    await expect(
      prisma.$transaction((tx) =>
        tx.ledgerEntry.createMany({
          data: [
            { transactionId, account: "escrow_held", amountCents: 5000, kind },
            { transactionId, account: "buyer_funds", amountCents: -4999, kind },
          ],
        }),
      ),
    ).rejects.toThrow(/unbalanced/);
    expect(await prisma.ledgerEntry.count({ where: { kind } })).toBe(0);
  });

  it("an order's state change rolls back with a refused ledger transaction", async () => {
    const order = await createOrder();
    await expect(
      prisma.$transaction(async (tx) => {
        await transition(tx, order.id, "CREATED", "AUTHORIZED", 0);
        await postTransaction(
          tx,
          [
            { account: "escrow_held", amountCents: 5000 },
            { account: "buyer_funds", amountCents: -4500 },
          ],
          { kind: "AUTHORIZE", orderId: order.id },
        );
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError);
    expect(await readOrder(order.id)).toEqual({ state: "CREATED", version: 0 });
    expect(await prisma.ledgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });
});
