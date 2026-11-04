import { ORDER_STATES, type OrderState } from "@campus/shared";
import { prisma } from "../db.js";

// Data for the admin dashboard (client/src/pages/admin). Read-only. Money is
// computed from the ledger, never from order fields:
//   held      = escrow_held                               (authorized, not captured)
//   captured  = seller_payable + platform_fees + paid_out (taken from buyers, net of refunds)
//   paid out  = paid_out                                  (sent to sellers)
// plus seller_payable (owed to sellers) and platform_fees (ours).

/** Rows per grid; the totals cover everything. */
export const DASHBOARD_LIMITS = { orders: 500, flags: 200, deadLetters: 200 } as const;
const MAX_PAYLOAD_PREVIEW = 500;

export type MoneyTotals = { held: number; captured: number; paidOut: number; sellerPayable: number; platformFees: number };

function moneyFrom(sums: { account: string; _sum: { amountCents: number | null } }[]): MoneyTotals {
  const balance = (account: string) => sums.filter((s) => s.account === account).reduce((n, s) => n + (s._sum.amountCents ?? 0), 0);
  const sellerPayable = balance("seller_payable");
  const platformFees = balance("platform_fees");
  const paidOut = balance("paid_out");
  return { held: balance("escrow_held"), captured: sellerPayable + platformFees + paidOut, paidOut, sellerPayable, platformFees };
}

export async function getAdminDashboard() {
  const [stateGroups, accountSums, orderCount, orders, flags, openFlagCount, deadLetters, deadLetterCount] = await Promise.all([
    prisma.order.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.ledgerEntry.groupBy({ by: ["account"], _sum: { amountCents: true } }),
    prisma.order.count(),
    prisma.order.findMany({
      orderBy: { updatedAt: "desc" },
      take: DASHBOARD_LIMITS.orders,
      select: {
        id: true,
        state: true,
        amountCents: true,
        platformFeeCents: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
        handoffDeadline: true,
        payoutAttempts: true,
        payoutLastError: true,
        listing: { select: { title: true } },
        buyer: { select: { displayName: true } },
        seller: { select: { displayName: true } },
      },
    }),
    prisma.reconciliationFlag.findMany({
      orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }], // OPEN before RESOLVED
      take: DASHBOARD_LIMITS.flags,
      select: {
        id: true,
        orderId: true,
        kind: true,
        status: true,
        message: true,
        firstSeenAt: true,
        lastSeenAt: true,
        resolvedAt: true,
        order: { select: { state: true } },
      },
    }),
    prisma.reconciliationFlag.count({ where: { status: "OPEN" } }),
    prisma.outboxEvent.findMany({
      where: { status: "DEAD" },
      orderBy: { createdAt: "desc" },
      take: DASHBOARD_LIMITS.deadLetters,
      select: { id: true, orderId: true, topic: true, attempts: true, lastError: true, payload: true, createdAt: true },
    }),
    prisma.outboxEvent.count({ where: { status: "DEAD" } }),
  ]);

  // Per-order ledger totals for the rows shown.
  const perOrder = await prisma.ledgerEntry.groupBy({
    by: ["orderId", "account"],
    where: { orderId: { in: orders.map((o) => o.id) } },
    _sum: { amountCents: true },
  });
  const moneyByOrder = new Map<string, MoneyTotals>();
  for (const o of orders) moneyByOrder.set(o.id, moneyFrom(perOrder.filter((s) => s.orderId === o.id)));

  const counts = new Map(stateGroups.map((g) => [g.state as OrderState, g._count._all]));
  return {
    generatedAt: new Date(),
    money: moneyFrom(accountSums),
    ordersByState: ORDER_STATES.map((state) => ({ state, count: counts.get(state) ?? 0 })),
    orders: orders.map(({ listing, buyer, seller, ...o }) => ({
      ...o,
      listingTitle: listing.title,
      buyer: buyer.displayName,
      seller: seller.displayName,
      ledger: moneyByOrder.get(o.id)!,
    })),
    orderCount,
    flags: flags.map(({ order, ...f }) => ({ ...f, orderState: order.state })),
    openFlagCount,
    // Payloads are shown as text, cut short; they're our own outbox data, never rendered as HTML.
    deadLetters: deadLetters.map(({ payload, ...d }) => ({ ...d, payload: JSON.stringify(payload).slice(0, MAX_PAYLOAD_PREVIEW) })),
    deadLetterCount,
  };
}

export type AdminDashboard = Awaited<ReturnType<typeof getAdminDashboard>>;
