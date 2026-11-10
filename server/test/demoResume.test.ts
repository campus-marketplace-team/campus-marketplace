import { describe, expect, it } from "vitest";
import { planDemoScenario, type DemoOrder } from "../prisma/demoResume.js";
import type { OrderState } from "../src/generated/prisma/client.js";

// scripts/demo-seed.ts reruns against the shared database, so it has to pick up
// each scenario from whatever state it's in, and say so when it can't.

const PRIYA = "seed.priya.patel@mcmaster.ca";
const MARCUS = "seed.marcus.lee@mcmaster.ca";

let n = 0;
const order = (state: OrderState, buyerEmail = PRIYA, minutes = n++): DemoOrder => ({
  id: `order-${state}-${minutes}`,
  state,
  buyerEmail,
  createdAt: new Date(Date.UTC(2026, 10, 9, 23, minutes)),
});

describe("planDemoScenario", () => {
  it("starts a checkout when the buyer has no order and the listing is for sale", () => {
    expect(planDemoScenario("sale", PRIYA, "ACTIVE", [])).toEqual({ step: "start", order: null });
  });

  it("reuses the buyer's CREATED order (startCheckout picks it up)", () => {
    const created = order("CREATED");
    expect(planDemoScenario("sale", PRIYA, "ACTIVE", [created])).toEqual({ step: "start", order: created });
  });

  it("starts again after a VOIDED or BLOCKED order once the listing is back for sale", () => {
    for (const state of ["VOIDED", "BLOCKED"] as const) {
      expect(planDemoScenario("sale", PRIYA, "ACTIVE", [order(state)]).step).toBe("start");
    }
  });

  it.each([
    ["AUTHORIZED", "finish"],
    ["CAPTURED", "wait"],
    ["PAYOUT_PENDING", "wait"],
    ["PAID_OUT", "done"],
  ] as const)("sale: resumes a %s order (%s), even with a newer CREATED one beside it", (state, step) => {
    const advanced = order(state);
    const plan = planDemoScenario("sale", PRIYA, "RESERVED", [advanced, order("CREATED")]);
    expect(plan).toEqual({ step, order: advanced });
  });

  it.each([
    ["AUTHORIZED", "finish"],
    ["IN_DISPUTE", "done"],
    ["ESCALATED", "done"],
  ] as const)("dispute: resumes a %s order (%s)", (state, step) => {
    const o = order(state);
    expect(planDemoScenario("dispute", PRIYA, "RESERVED", [o])).toEqual({ step, order: o });
  });

  it.each(["PAYOUT_RETRY", "IN_DISPUTE", "REFUNDED", "PARTIAL_REFUND", "RELEASED", "ESCALATED"] as const)(
    "sale: reports a %s order as stuck, naming it",
    (state) => {
      const o = order(state);
      const plan = planDemoScenario("sale", PRIYA, "RESERVED", [o]);
      expect(plan.step).toBe("stuck");
      if (plan.step === "stuck") expect(plan.reason).toContain(o.id);
    },
  );

  it.each(["CAPTURED", "PAYOUT_PENDING", "PAID_OUT", "REFUNDED"] as const)("dispute: reports a %s order as stuck", (state) => {
    expect(planDemoScenario("dispute", PRIYA, "SOLD", [order(state)]).step).toBe("stuck");
  });

  it("doesn't take over another buyer's order holding the listing, and names it", () => {
    // What happened on Nov 9: Priya's order stayed CREATED while Marcus authorized the same listing.
    const priyas = order("CREATED", PRIYA);
    const marcus = order("AUTHORIZED", MARCUS);
    const plan = planDemoScenario("sale", PRIYA, "RESERVED", [priyas, marcus]);
    expect(plan.step).toBe("stuck");
    expect(plan.order).toEqual(priyas);
    if (plan.step === "stuck") {
      expect(plan.reason).toContain(marcus.id);
      expect(plan.reason).toContain(MARCUS);
    }
  });

  it("reports a listing that isn't for sale when nobody's order explains it", () => {
    const plan = planDemoScenario("sale", PRIYA, "REMOVED", [order("VOIDED")]);
    expect(plan.step).toBe("stuck");
    if (plan.step === "stuck") expect(plan.reason).toContain("REMOVED");
  });
});
