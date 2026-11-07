import { type Db, prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { type PaymentRecord, type PayPalClient, PayPalError, type PayoutItemStatus } from "../paypal/client.js";
import { orderScope } from "../testUsers.js";

// Reconciliation (see CLAUDE.md "Reliability rules"): PayPal is the source of
// truth for money, so every few minutes a batch of orders is compared with
// PayPal's records, the orders checked longest ago first.
//
// For each order the ledger is reduced to three totals and compared with what
// PayPal's records imply:
//   HELD      escrow_held                              vs  an authorization still holding funds (CREATED / PENDING)
//   CAPTURED  seller_payable + platform_fees + paid_out vs  the capture (COMPLETED / PENDING) minus completed refunds
//   PAID_OUT  paid_out                                  vs  the payout item, if SUCCESS
// plus PAYPAL_RECORD when an id we store isn't found at PayPal. A mismatch is
// saved in reconciliation_flags (one row per order and kind); a flag whose
// totals agree again is marked RESOLVED. The job never changes an order or
// the ledger: fixing a mismatch is a human decision.
//
// Orders changed within QUIET_MS are skipped: other jobs may be mid-way
// through recording something PayPal already did (a capture's DB write, a
// payout waiting for its next status check), which isn't a mismatch.
// PayPal's responses are untrusted data; they're only compared and stored.

/** Skip orders changed more recently than this (longer than the payout job's 10-minute status checks). */
export const QUIET_MS = 15 * 60 * 1000;
export const RECONCILE_BATCH_SIZE = 25;

export const FLAG_KINDS = ["HELD", "CAPTURED", "PAID_OUT", "PAYPAL_RECORD"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export type ReconcileOutcome = "ok" | "flagged" | "failed" | "skipped";
export type ReconcileSweepResult = { checked: number } & Record<ReconcileOutcome, number>;

export type LedgerTotals = { held: number; captured: number; paidOut: number; refundRefs: string[] };
export type PayPalTotals = { held: number; captured: number; paidOut: number };

type Mismatch = { kind: FlagKind; message: string };

const orderSelect = {
  id: true,
  amountCents: true,
  currency: true,
  paypalAuthorizationId: true,
  paypalCaptureId: true,
  paypalPayoutBatchId: true,
} as const;

type ReconcileOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function loadOrder(id: string) {
  return prisma.order.findUnique({ where: { id }, select: orderSelect });
}

/** The order's ledger reduced to held / captured / paid-out totals, plus the refund ids it recorded. */
export async function ledgerTotals(orderId: string, db: Db = prisma): Promise<LedgerTotals> {
  const [sums, refunds] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ["account"], where: { orderId }, _sum: { amountCents: true } }),
    db.ledgerEntry.findMany({
      where: { orderId, kind: "REFUND", paypalRef: { not: null } },
      distinct: ["paypalRef"],
      select: { paypalRef: true },
    }),
  ]);
  const balance = (account: string) => sums.find((s) => s.account === account)?._sum.amountCents ?? 0;
  return {
    held: balance("escrow_held"),
    captured: balance("seller_payable") + balance("platform_fees") + balance("paid_out"),
    paidOut: balance("paid_out"),
    refundRefs: refunds.map((r) => r.paypalRef!),
  };
}

type PayPalRecords = {
  authorization: PaymentRecord | null;
  capture: PaymentRecord | null;
  refunds: PaymentRecord[];
  payoutItem: PayoutItemStatus | null;
};

/** What PayPal's records say the three totals should be. Pure, so it's easy to test. */
export function expectedTotals(order: { amountCents: number }, records: PayPalRecords): PayPalTotals {
  const { authorization, capture, refunds, payoutItem } = records;
  const held =
    authorization && (authorization.status === "CREATED" || authorization.status === "PENDING")
      ? (authorization.amountCents ?? order.amountCents)
      : 0;

  let captured = 0;
  if (capture) {
    if (capture.status === "REFUNDED") captured = 0;
    else if (["COMPLETED", "PENDING", "PARTIALLY_REFUNDED"].includes(capture.status)) {
      const refunded = refunds.filter((r) => r.status === "COMPLETED").reduce((sum, r) => sum + (r.amountCents ?? 0), 0);
      captured = (capture.amountCents ?? 0) - refunded;
    }
  } else if (authorization && (authorization.status === "CAPTURED" || authorization.status === "PARTIALLY_CAPTURED")) {
    // Captured at PayPal but we never recorded a capture (e.g. a scan whose DB write was lost).
    captured = authorization.amountCents ?? order.amountCents;
  }

  const paidOut = payoutItem?.transactionStatus === "SUCCESS" ? (payoutItem.amountCents ?? 0) : 0;
  return { held, captured, paidOut };
}

/** The mismatches between the ledger and PayPal, if any. */
export function compare(ledger: LedgerTotals, paypal: PayPalTotals, records: PayPalRecords): Mismatch[] {
  const out: Mismatch[] = [];
  const fmt = (cents: number) => `${cents} cents`;
  if (ledger.held !== paypal.held) {
    out.push({
      kind: "HELD",
      message: `ledger holds ${fmt(ledger.held)} in escrow; PayPal's authorization (${records.authorization?.status ?? "none"}) holds ${fmt(paypal.held)}`,
    });
  }
  const unrecordedRefunds =
    (records.capture?.status === "REFUNDED" || records.capture?.status === "PARTIALLY_REFUNDED") && ledger.refundRefs.length === 0;
  if (ledger.captured !== paypal.captured || unrecordedRefunds) {
    out.push({
      kind: "CAPTURED",
      message: unrecordedRefunds
        ? `PayPal's capture is ${records.capture!.status}, but the ledger has no refund`
        : `ledger has ${fmt(ledger.captured)} captured; PayPal (capture ${records.capture?.status ?? "none"}) has ${fmt(paypal.captured)}`,
    });
  }
  if (ledger.paidOut !== paypal.paidOut) {
    out.push({
      kind: "PAID_OUT",
      message: `ledger paid out ${fmt(ledger.paidOut)}; PayPal's payout item (${records.payoutItem?.transactionStatus ?? "none"}) paid ${fmt(paypal.paidOut)}`,
    });
  }
  return out;
}

class MissingAtPayPal extends Error {}

async function fetchRecords(paypal: PayPalClient, order: ReconcileOrder, refundRefs: string[]): Promise<PayPalRecords> {
  const notFound = (what: string) => (err: unknown) => {
    if (err instanceof PayPalError && err.status === 404) throw new MissingAtPayPal(what);
    throw err;
  };
  const authorization = order.paypalAuthorizationId
    ? await paypal.getAuthorization({ authorizationId: order.paypalAuthorizationId }).catch(notFound(`authorization ${order.paypalAuthorizationId}`))
    : null;
  const capture = order.paypalCaptureId
    ? await paypal.getCapture({ captureId: order.paypalCaptureId }).catch(notFound(`capture ${order.paypalCaptureId}`))
    : null;
  const refunds: PaymentRecord[] = [];
  for (const refundId of refundRefs) refunds.push(await paypal.getRefund({ refundId }).catch(notFound(`refund ${refundId}`)));
  let payoutItem: PayoutItemStatus | null = null;
  if (order.paypalPayoutBatchId) {
    const batch = await paypal
      .getPayoutBatch({ payoutBatchId: order.paypalPayoutBatchId })
      .catch(notFound(`payout batch ${order.paypalPayoutBatchId}`));
    payoutItem = batch.items.find((i) => i.senderItemId === order.id) ?? null;
  }
  return { authorization, capture, refunds, payoutItem };
}

async function flag(orderId: string, kind: FlagKind, message: string, ledger: unknown, paypal: unknown, now: Date) {
  const existing = await prisma.reconciliationFlag.findUnique({ where: { orderId_kind: { orderId, kind } }, select: { status: true } });
  const data = { message, ledger: ledger as Prisma.InputJsonValue, paypal: paypal as Prisma.InputJsonValue, lastSeenAt: now };
  await prisma.reconciliationFlag.upsert({
    where: { orderId_kind: { orderId, kind } },
    create: { orderId, kind, ...data, firstSeenAt: now },
    update: { ...data, status: "OPEN", resolvedAt: null },
  });
  if (existing?.status !== "OPEN") console.error(`order ${orderId}: reconciliation mismatch (${kind}): ${message}`);
}

async function resolve(orderId: string, kinds: readonly FlagKind[], now: Date) {
  const { count } = await prisma.reconciliationFlag.updateMany({
    where: { orderId, kind: { in: [...kinds] }, status: "OPEN" },
    data: { status: "RESOLVED", resolvedAt: now },
  });
  if (count > 0) console.log(`order ${orderId}: ${count} reconciliation flag(s) resolved`);
}

/** Moves the cursor without touching updated_at (which means "last real change" to the quiet-period check). */
async function markReconciled(orderId: string, now: Date) {
  await prisma.$executeRaw`UPDATE "orders" SET "last_reconciled_at" = ${now} WHERE "id" = ${orderId}::uuid`;
}

/** Compares one order with PayPal and records the result. Never throws. (`readLedger` is swappable for tests.) */
export async function reconcileOrder(
  paypal: PayPalClient,
  orderId: string,
  now = new Date(),
  readLedger: (orderId: string) => Promise<LedgerTotals> = ledgerTotals,
): Promise<ReconcileOutcome> {
  const order = await loadOrder(orderId);
  if (!order) return "skipped";
  try {
    const ledger = await readLedger(order.id);
    let records: PayPalRecords;
    try {
      records = await fetchRecords(paypal, order, ledger.refundRefs);
    } catch (err) {
      if (!(err instanceof MissingAtPayPal)) throw err;
      await flag(order.id, "PAYPAL_RECORD", `${err.message} isn't found at PayPal`, ledger, { missing: err.message }, now);
      await markReconciled(order.id, now);
      return "flagged"; // the other totals can't be checked without it; their flags stay as they were
    }

    const expected = expectedTotals(order, records);
    const mismatches = compare(ledger, expected, records);
    const paypalView = { ...records, expected };
    for (const m of mismatches) await flag(order.id, m.kind, m.message, ledger, paypalView, now);
    const agreeing = FLAG_KINDS.filter((k) => !mismatches.some((m) => m.kind === k));
    await resolve(order.id, agreeing, now);
    await markReconciled(order.id, now);
    return mismatches.length > 0 ? "flagged" : "ok";
  } catch (err) {
    // PayPal unreachable or similar: no verdict this time. Move on so one order can't block the rest.
    console.error(`order ${order.id}: reconciliation failed:`, (err as Error).message);
    await markReconciled(order.id, now).catch(() => {});
    return "failed";
  }
}

/** Reconciles the orders with PayPal records that were checked longest ago (never-checked first). `skipTestUsers`: see src/testUsers.ts. */
export async function sweepReconciliation(
  paypal: PayPalClient,
  {
    now = new Date(),
    limit = RECONCILE_BATCH_SIZE,
    readLedger = ledgerTotals,
    skipTestUsers = false,
  }: { now?: Date; limit?: number; readLedger?: (orderId: string) => Promise<LedgerTotals>; skipTestUsers?: boolean } = {},
): Promise<ReconcileSweepResult> {
  const due = await prisma.order.findMany({
    where: {
      ...orderScope(skipTestUsers),
      updatedAt: { lte: new Date(now.getTime() - QUIET_MS) },
      OR: [{ paypalAuthorizationId: { not: null } }, { paypalCaptureId: { not: null } }, { paypalPayoutBatchId: { not: null } }],
    },
    orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }, { updatedAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const result: ReconcileSweepResult = { checked: due.length, ok: 0, flagged: 0, failed: 0, skipped: 0 };
  for (const { id } of due) result[await reconcileOrder(paypal, id, now, (orderId) => readLedger(orderId))] += 1;
  return result;
}
