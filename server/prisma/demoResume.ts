// How scripts/demo-seed.ts picks up a demo scenario from wherever an earlier run
// (or someone clicking around the app) left it. Pure, so it's tested without
// PayPal or the database: test/demoResume.test.ts.

import type { OrderState } from "../src/generated/prisma/client.js";

export type DemoOrder = { id: string; state: OrderState; buyerEmail: string; createdAt: Date };

/**
 * What the script does next for one scenario:
 *   start   startCheckout: creates the buyer's order, or reuses their unpaid CREATED one, then waits for approval
 *   finish  the order is AUTHORIZED: capture it with a QR scan (sale) or open the dispute (dispute)
 *   wait    nothing for the script to do; the worker carries on (payout)
 *   done    the scenario is where the demo needs it
 *   stuck   it can't continue from here without someone deciding what to do
 */
export type DemoPlan =
  | { step: "start"; order: DemoOrder | null }
  | { step: "finish" | "wait" | "done"; order: DemoOrder }
  | { step: "stuck"; order: DemoOrder | null; reason: string };

/** States in which an order no longer holds the listing and can be replaced by a new checkout. */
const REPLACEABLE: readonly OrderState[] = ["CREATED", "VOIDED", "BLOCKED"];

const AFTER_AUTHORIZE: Record<"sale" | "dispute", Partial<Record<OrderState, "finish" | "wait" | "done">>> = {
  sale: { AUTHORIZED: "finish", CAPTURED: "wait", PAYOUT_PENDING: "wait", PAID_OUT: "done" },
  dispute: { AUTHORIZED: "finish", IN_DISPUTE: "done", ESCALATED: "done" },
};

const latest = (orders: DemoOrder[]) =>
  orders.reduce<DemoOrder | null>((a, o) => (a && a.createdAt >= o.createdAt ? a : o), null);

const label = (o: DemoOrder) => `order ${o.id} (${o.buyerEmail}, ${o.state})`;

/**
 * `orders` is every order on the scenario's listing, from any buyer. The
 * scenario's own order is the buyer's latest one that got past CREATED; failing
 * that, their latest one. Another buyer's order is never taken over: the
 * scenario's chat and evidence belong to its own buyer.
 */
export function planDemoScenario(
  key: "sale" | "dispute",
  buyerEmail: string,
  listingStatus: string,
  orders: DemoOrder[],
): DemoPlan {
  const mine = orders.filter((o) => o.buyerEmail === buyerEmail);
  const order = latest(mine.filter((o) => !REPLACEABLE.includes(o.state))) ?? latest(mine);

  if (order && !REPLACEABLE.includes(order.state)) {
    const step = AFTER_AUTHORIZE[key][order.state];
    if (step) return { step, order };
    return {
      step: "stuck",
      order,
      reason:
        `${label(order)} is in a state the ${key} scenario can't continue from` +
        (order.state === "PAYOUT_RETRY"
          ? ": the payout failed. The worker re-sends it (up to 5 attempts); check payoutLastError and the admin dashboard."
          : ". Look at it on /admin."),
    };
  }

  // The buyer has nothing past CREATED, so the script needs a checkout, which needs the listing for sale.
  if (listingStatus === "ACTIVE") return { step: "start", order };
  const holder = latest(orders.filter((o) => o.buyerEmail !== buyerEmail && !REPLACEABLE.includes(o.state)));
  return {
    step: "stuck",
    order,
    reason: holder
      ? `the listing is ${listingStatus} because of another buyer's ${label(holder)}, not ${buyerEmail}'s. ` +
        "The script won't take over someone else's order; that order has to finish or be voided first."
      : `the listing is ${listingStatus} and ${buyerEmail} has no order on it past CREATED.`,
  };
}
