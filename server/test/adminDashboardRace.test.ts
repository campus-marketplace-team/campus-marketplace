import { describe, expect, it, vi } from "vitest";

// Prisma reads relations in separate queries, so a row deleted between them comes
// back with a "required" relation null. That timing can't be forced against a real
// database, so these are the rows Prisma returned when it happened, from a fake client.

const party = { displayName: "Someone" };
const orderFields = { id: "o", state: "CREATED", amountCents: 5000, platformFeeCents: 500, currency: "USD" };
const whole = { ...orderFields, listing: { title: "Still here" }, buyer: party, seller: party };
const deletedMidRead = { ...orderFields, id: "gone", listing: null, buyer: party, seller: party };
const decision = { reasons: [], signals: [], evidence: null, inputs: {}, llmOutput: null, approver: null, createdAt: new Date() };

vi.mock("../src/db.js", () => {
  const none = async () => [];
  const zero = async () => 0;
  return {
    prisma: {
      order: { groupBy: none, count: zero, findMany: async () => [whole, deletedMidRead] },
      ledgerEntry: { groupBy: none },
      reconciliationFlag: { count: zero, findMany: async () => [{ id: "flag-gone", order: null }, { id: "flag", order: { state: "CREATED" } }] },
      outboxEvent: { count: zero, findMany: none },
      claudeBudgetUsage: { findMany: none },
      dispute: { findMany: async () => [{ id: "esc-gone", order: deletedMidRead }, { id: "esc", order: whole }] },
      decision: {
        groupBy: none,
        findMany: async ({ where }: { where: { kind: string; actionStatus?: string } }) =>
          where.actionStatus
            ? [{ ...decision, id: "pending-gone", order: deletedMidRead }, { ...decision, id: "pending", order: whole }]
            : [{ ...decision, id: `${where.kind}-gone`, order: deletedMidRead }, { ...decision, id: `${where.kind}`, order: whole }],
      },
    },
  };
});

const { getAdminDashboard } = await import("../src/admin/dashboard.js");

describe("getAdminDashboard when a row is deleted mid-read", () => {
  it("still answers, leaving out what can't be acted on", async () => {
    const body = await getAdminDashboard();
    expect(body.orders.map((o) => o.id)).toEqual(["o"]);
    expect(body.flags.map((f) => f.id)).toEqual(["flag"]);
    expect(body.escalatedDisputes.map((d) => d.id)).toEqual(["esc"]);
    expect(body.pendingDisputeDecisions.map((d) => d.id)).toEqual(["pending"]);
  });

  it("keeps a decision record, without the order details it lost", async () => {
    const body = await getAdminDashboard();
    expect(body.riskDecisions.find((d) => d.id === "RISK-gone")).toMatchObject({ orderId: null, listingTitle: null, buyer: null });
    expect(body.riskDecisions.find((d) => d.id === "RISK")).toMatchObject({ orderId: "o", listingTitle: "Still here" });
    expect(body.disputeDecisions.find((d) => d.id === "DISPUTE-gone")).toMatchObject({ orderId: null, listingTitle: null });
  });
});
