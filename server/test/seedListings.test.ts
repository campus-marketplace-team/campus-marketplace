import { describe, expect, it } from "vitest";
import type { OrderState } from "../src/generated/prisma/client.js";
import { SEED_LISTINGS, seedListingAction, type SeedListingOrder } from "../prisma/seedListings.js";

// Re-running the seed may put a seed listing back on sale only once nothing
// still depends on it: an active order (money held or moving, an open dispute,
// a buyer in PayPal) keeps it as it is.

const SEED_SELLER = "00000000-0000-4000-a000-000000000101";
const SEED_USERS = [SEED_SELLER, "00000000-0000-4000-a000-000000000102"];
const OTHER_USER = "11111111-1111-4111-a111-111111111111";

const order = (state: OrderState, paypalOrderId: string | null = "PP-1", id = "order-1"): SeedListingOrder => ({
  id,
  state,
  paypalOrderId,
});

const ACTIVE_STATES = ["AUTHORIZED", "IN_DISPUTE", "ESCALATED", "CAPTURED", "PAYOUT_PENDING", "PAYOUT_RETRY"] as const;
const FINISHED_STATES = ["PAID_OUT", "VOIDED", "REFUNDED", "PARTIAL_REFUND", "RELEASED", "BLOCKED"] as const;

describe("seedListingAction", () => {
  it("creates a missing listing", () => {
    expect(seedListingAction(null, SEED_USERS, [])).toEqual({ kind: "create" });
  });

  it("refreshes a listing that's still for sale", () => {
    expect(seedListingAction({ status: "ACTIVE", sellerId: SEED_SELLER }, SEED_USERS, [])).toEqual({ kind: "update" });
  });

  it.each(["RESERVED", "SOLD", "REMOVED"] as const)("resets a %s listing with no orders", (status) => {
    expect(seedListingAction({ status, sellerId: SEED_SELLER }, SEED_USERS, [])).toEqual({ kind: "reset" });
  });

  it.each(FINISHED_STATES)("resets a sold listing whose only order is %s", (state) => {
    expect(seedListingAction({ status: "SOLD", sellerId: SEED_SELLER }, SEED_USERS, [order(state)])).toEqual({
      kind: "reset",
    });
  });

  it("resets past a CREATED order that never got a PayPal order", () => {
    expect(
      seedListingAction({ status: "RESERVED", sellerId: SEED_SELLER }, SEED_USERS, [order("CREATED", null)]),
    ).toEqual({ kind: "reset" });
  });

  it("skips a listing whose buyer is in PayPal (CREATED with a PayPal order)", () => {
    expect(
      seedListingAction({ status: "RESERVED", sellerId: SEED_SELLER }, SEED_USERS, [order("CREATED", "PP-9", "o-9")]),
    ).toEqual({ kind: "skip", reason: "ACTIVE_ORDER", order: { id: "o-9", state: "CREATED" } });
  });

  it.each(ACTIVE_STATES)("skips a listing with a %s order and names it", (state) => {
    expect(
      seedListingAction({ status: "RESERVED", sellerId: SEED_SELLER }, SEED_USERS, [order(state, "PP-2", "o-2")]),
    ).toEqual({ kind: "skip", reason: "ACTIVE_ORDER", order: { id: "o-2", state } });
  });

  it("is blocked by one active order among finished ones", () => {
    const orders = [order("VOIDED", "PP-1", "o-1"), order("PAID_OUT", "PP-2", "o-2"), order("IN_DISPUTE", "PP-3", "o-3")];
    expect(seedListingAction({ status: "SOLD", sellerId: SEED_SELLER }, SEED_USERS, orders)).toEqual({
      kind: "skip",
      reason: "ACTIVE_ORDER",
      order: { id: "o-3", state: "IN_DISPUTE" },
    });
  });

  it.each(["ACTIVE", "RESERVED", "SOLD", "REMOVED"] as const)("never touches a %s listing another user sells", (status) => {
    expect(seedListingAction({ status, sellerId: OTHER_USER }, SEED_USERS, [])).toEqual({
      kind: "skip",
      reason: "OTHER_SELLER",
    });
  });
});

describe("SEED_LISTINGS", () => {
  it("has a unique photo slug per listing", () => {
    const slugs = SEED_LISTINGS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("stays below the demo listing ids (301+)", () => {
    expect(201 + SEED_LISTINGS.length - 1).toBeLessThan(301);
  });
});
