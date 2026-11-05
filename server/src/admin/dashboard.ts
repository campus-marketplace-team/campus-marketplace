import { ORDER_STATES, type OrderState } from "@campus/shared";
import { z } from "zod";
import { prisma } from "../db.js";

// Data for the admin dashboard (client/src/pages/admin). Read-only. Money is
// computed from the ledger, never from order fields:
//   held      = escrow_held                               (authorized, not captured)
//   captured  = seller_payable + platform_fees + paid_out (taken from buyers, net of refunds)
//   paid out  = paid_out                                  (sent to sellers)
// plus seller_payable (owed to sellers) and platform_fees (ours).

/** Rows per grid; the totals cover everything. */
export const DASHBOARD_LIMITS = { orders: 500, flags: 200, deadLetters: 200, disputes: 100, decisions: 200 } as const;
const MAX_PAYLOAD_PREVIEW = 500;

export type MoneyTotals = { held: number; captured: number; paidOut: number; sellerPayable: number; platformFees: number };

function moneyFrom(sums: { account: string; _sum: { amountCents: number | null } }[]): MoneyTotals {
  const balance = (account: string) => sums.filter((s) => s.account === account).reduce((n, s) => n + (s._sum.amountCents ?? 0), 0);
  const sellerPayable = balance("seller_payable");
  const platformFees = balance("platform_fees");
  const paidOut = balance("paid_out");
  return { held: balance("escrow_held"), captured: sellerPayable + platformFees + paidOut, paidOut, sellerPayable, platformFees };
}

type OrderParties = { listing: unknown; buyer: unknown; seller: unknown };

/**
 * The order, or null if its listing, buyer or seller is gone. Prisma reads relations
 * in separate queries, so a row deleted mid-read comes back with a "required" relation
 * null, whatever the types say. One such row mustn't take the whole dashboard down.
 */
function complete<T extends OrderParties>(order: T | null): T | null {
  return order && order.listing && order.buyer && order.seller ? order : null;
}

const disputeOrderView = {
  select: {
    id: true,
    amountCents: true,
    platformFeeCents: true,
    currency: true,
    listing: { select: { title: true } },
    buyer: { select: { displayName: true } },
    seller: { select: { displayName: true } },
  },
} as const;

type DisputeOrderRow = { id: string; amountCents: number; platformFeeCents: number; currency: string; listing: { title: string }; buyer: { displayName: string }; seller: { displayName: string } };

function flattenDisputeOrder({ listing, buyer, seller, ...order }: DisputeOrderRow) {
  return { ...order, listingTitle: listing.title, buyer: buyer.displayName, seller: seller.displayName };
}

/** Dispute decisions waiting for an admin, and escalated disputes for an admin to decide. Reasoning and reports are untrusted text: shown as plain text only. */
async function getDisputeQueues() {
  const [pending, escalated] = await Promise.all([
    prisma.decision.findMany({
      where: { kind: "DISPUTE", actionStatus: "PENDING_APPROVAL" },
      orderBy: { createdAt: "asc" },
      take: DASHBOARD_LIMITS.disputes,
      select: { id: true, outcome: true, amountCents: true, reasoning: true, evidence: true, model: true, createdAt: true, order: disputeOrderView },
    }),
    prisma.dispute.findMany({
      where: { status: "ESCALATED" },
      orderBy: { createdAt: "asc" },
      take: DASHBOARD_LIMITS.disputes,
      select: { id: true, reason: true, description: true, createdAt: true, order: disputeOrderView },
    }),
  ]);
  return {
    pendingDisputeDecisions: pending.flatMap(({ order, ...d }) => {
      const whole = complete(order);
      return whole ? [{ ...d, order: flattenDisputeOrder(whole) }] : [];
    }),
    escalatedDisputes: escalated.flatMap(({ order, ...d }) => (complete(order) ? [{ ...d, order: flattenDisputeOrder(order) }] : [])),
  };
}

const decisionOrderView = {
  select: {
    id: true,
    state: true,
    amountCents: true,
    listing: { select: { title: true } },
    buyer: { select: { displayName: true } },
    seller: { select: { displayName: true } },
  },
} as const;

type DecisionOrderRow = { id: string; state: OrderState; amountCents: number; listing: { title: string }; buyer: { displayName: string }; seller: { displayName: string } };

/** Decision columns are JSONB, and the rows outlive the code that wrote them, so nothing about their shape is assumed. */
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Numbers and our own phrase ids only, never listing or chat text (risk/features.ts). Anything else is left out. */
const riskFeaturesView = z.object({
  sellerAccountAgeDays: z.number(),
  sellerListingsLast24h: z.number(),
  price: z.object({
    amountCents: z.number(),
    categoryMedianCents: z.number().nullable(),
    ratioToMedian: z.number().nullable(),
    comparableListings: z.number(),
  }),
  sellerPastDisputes: z.number(),
  buyerPastDisputes: z.number(),
  offPlatformPhrases: z.array(z.object({ phrase: z.string(), sender: z.enum(["buyer", "seller"]) })),
});

function flattenDecisionOrder(row: DecisionOrderRow | null) {
  const order = complete(row);
  return {
    orderId: order?.id ?? null,
    orderState: order?.state ?? null,
    orderAmountCents: order?.amountCents ?? null,
    listingTitle: order?.listing.title ?? null,
    buyer: order?.buyer.displayName ?? null,
    seller: order?.seller.displayName ?? null,
  };
}

function disputeEvidence(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const { source, detail } = asObject(item);
    return typeof source === "string" && typeof detail === "string" ? [{ source, detail }] : [];
  });
}

/**
 * The AI decision records, newest first, for reading: every state of a dispute
 * decision (the approval queue above is what can be acted on), and what the risk
 * engine decided before each checkout. Reasons, reasoning and evidence are model
 * output that can quote untrusted text: shown as plain text only. The listing
 * snapshot and raw model output in `inputs` / `llm_output` stay out of this.
 */
async function getDecisionRecords() {
  const [risk, riskGroups, disputes, disputeGroups] = await Promise.all([
    prisma.decision.findMany({
      where: { kind: "RISK" },
      orderBy: { createdAt: "desc" },
      take: DASHBOARD_LIMITS.decisions,
      select: {
        id: true,
        risk: true,
        outcome: true,
        reasons: true,
        signals: true,
        evidence: true,
        reasoning: true,
        model: true,
        inputs: true,
        llmOutput: true,
        createdAt: true,
        order: decisionOrderView,
      },
    }),
    prisma.decision.groupBy({ by: ["outcome"], where: { kind: "RISK" }, _count: { _all: true } }),
    prisma.decision.findMany({
      where: { kind: "DISPUTE" },
      orderBy: { createdAt: "desc" },
      take: DASHBOARD_LIMITS.decisions,
      select: {
        id: true,
        outcome: true,
        actionStatus: true,
        actionError: true,
        amountCents: true,
        reasoning: true,
        evidence: true,
        model: true,
        llmOutput: true,
        paypalTransactionId: true,
        approvedAt: true,
        rejectedAt: true,
        executedAt: true,
        reviewNote: true,
        createdAt: true,
        approver: { select: { displayName: true } },
        order: decisionOrderView,
      },
    }),
    prisma.decision.groupBy({ by: ["actionStatus"], where: { kind: "DISPUTE" }, _count: { _all: true } }),
  ]);

  const riskCount = (outcome: string) => riskGroups.find((g) => g.outcome === outcome)?._count._all ?? 0;
  const disputeCount = (status: string) => disputeGroups.find((g) => g.actionStatus === status)?._count._all ?? 0;

  return {
    riskDecisions: risk.map(({ order, reasons, signals, evidence, inputs, llmOutput, ...d }) => {
      const policy = asObject(evidence);
      const classifier = asObject(llmOutput);
      return {
        ...d,
        ...flattenDecisionOrder(order),
        reasons: asStrings(reasons),
        signals: asStrings(signals),
        floor: asString(policy.floor),
        hardRules: asStrings(policy.hardRules),
        classifierRisk: asString(classifier.risk),
        classifierFallbackReason: asString(classifier.fallbackReason),
        features: riskFeaturesView.safeParse(asObject(inputs).features).data ?? null,
      };
    }),
    riskDecisionCounts: {
      total: riskGroups.reduce((n, g) => n + g._count._all, 0),
      normal: riskCount("NORMAL"),
      holdWithWarning: riskCount("HOLD_WITH_WARNING"),
      blocked: riskCount("BLOCKED"),
    },
    disputeDecisions: disputes.map(({ order, approver, evidence, llmOutput, ...d }) => ({
      ...d,
      ...flattenDecisionOrder(order),
      // The agent's decisions always save its tool input; an admin's own never have one.
      proposedByAgent: llmOutput !== null,
      approver: approver?.displayName ?? null,
      evidence: disputeEvidence(evidence),
    })),
    disputeDecisionCounts: {
      total: disputeGroups.reduce((n, g) => n + g._count._all, 0),
      failed: disputeCount("FAILED"),
    },
  };
}

export async function getAdminDashboard() {
  const [stateGroups, accountSums, orderCount, orders, flags, openFlagCount, deadLetters, deadLetterCount, disputeQueues, decisionRecords] = await Promise.all([
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
    getDisputeQueues(),
    getDecisionRecords(),
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
    orders: orders.filter((o) => complete(o)).map(({ listing, buyer, seller, ...o }) => ({
      ...o,
      listingTitle: listing.title,
      buyer: buyer.displayName,
      seller: seller.displayName,
      ledger: moneyByOrder.get(o.id)!,
    })),
    orderCount,
    flags: flags.flatMap(({ order, ...f }) => (order ? [{ ...f, orderState: order.state }] : [])),
    openFlagCount,
    // Payloads are shown as text, cut short; they're our own outbox data, never rendered as HTML.
    deadLetters: deadLetters.map(({ payload, ...d }) => ({ ...d, payload: JSON.stringify(payload).slice(0, MAX_PAYLOAD_PREVIEW) })),
    deadLetterCount,
    ...disputeQueues,
    ...decisionRecords,
  };
}

export type AdminDashboard = Awaited<ReturnType<typeof getAdminDashboard>>;
