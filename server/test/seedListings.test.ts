import { describe, expect, it } from "vitest";
import type { OrderState } from "../src/generated/prisma/client.js";
import { ORDER_STATES } from "@campus/shared";
import { SEED_LISTINGS, seedListingAction, type SeedListingOrder } from "../prisma/seedListings.js";
import { seedPayoutEmail } from "../prisma/seedPayoutEmail.js";

// Re-running the seed puts a seed listing back on sale unless one of its
// orders still holds the buyer's money (AUTHORIZED, IN_DISPUTE, ESCALATED).
// Orders themselves are history and are never changed.

const SEED_SELLER = "00000000-0000-4000-a000-000000000101";
const SEED_USERS = [SEED_SELLER, "00000000-0000-4000-a000-000000000102"];
const OTHER_USER = "11111111-1111-4111-a111-111111111111";

const order = (state: OrderState, id = "order-1"): SeedListingOrder => ({ id, state });

const HOLDING_STATES = ["AUTHORIZED", "IN_DISPUTE", "ESCALATED"] as const;
const NON_BLOCKING_STATES = [
  "CREATED",
  "BLOCKED",
  "CAPTURED",
  "PAYOUT_PENDING",
  "PAYOUT_RETRY",
  "PAID_OUT",
  "VOIDED",
  "REFUNDED",
  "PARTIAL_REFUND",
  "RELEASED",
] as const;

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

  it.each(NON_BLOCKING_STATES)("resets a sold listing whose order is %s", (state) => {
    expect(seedListingAction({ status: "SOLD", sellerId: SEED_SELLER }, SEED_USERS, [order(state)])).toEqual({
      kind: "reset",
    });
  });

  it.each(HOLDING_STATES)("skips a listing with a %s order and names it", (state) => {
    expect(seedListingAction({ status: "RESERVED", sellerId: SEED_SELLER }, SEED_USERS, [order(state, "o-2")])).toEqual({
      kind: "skip",
      reason: "MONEY_HELD",
      order: { id: "o-2", state },
    });
  });

  it("is blocked by one held order among finished ones", () => {
    const orders = [order("VOIDED", "o-1"), order("CAPTURED", "o-2"), order("IN_DISPUTE", "o-3"), order("PAID_OUT", "o-4")];
    expect(seedListingAction({ status: "SOLD", sellerId: SEED_SELLER }, SEED_USERS, orders)).toEqual({
      kind: "skip",
      reason: "MONEY_HELD",
      order: { id: "o-3", state: "IN_DISPUTE" },
    });
  });

  it("covers every order state as either holding or not", () => {
    const all = [...HOLDING_STATES, ...NON_BLOCKING_STATES].sort();
    expect(all).toEqual([...ORDER_STATES].sort());
  });

  it.each(["ACTIVE", "RESERVED", "SOLD", "REMOVED"] as const)("never touches a %s listing another user sells", (status) => {
    expect(seedListingAction({ status, sellerId: OTHER_USER }, SEED_USERS, [])).toEqual({
      kind: "skip",
      reason: "OTHER_SELLER",
    });
  });
});

describe("seedPayoutEmail", () => {
  const SANDBOX = "https://api-m.sandbox.paypal.com";

  it("sets the trimmed email against the sandbox", () => {
    expect(seedPayoutEmail("  seller@personal.example.com ", SANDBOX)).toEqual({
      kind: "set",
      email: "seller@personal.example.com",
    });
  });

  it.each([undefined, "", "   "])("leaves emails alone when unset (%j)", (raw) => {
    expect(seedPayoutEmail(raw, SANDBOX).kind).toBe("leave");
  });

  it("leaves emails alone for something that isn't an email", () => {
    expect(seedPayoutEmail("not-an-email", SANDBOX).kind).toBe("leave");
  });

  it.each(["https://api-m.paypal.com", "", undefined])("never sets one outside the sandbox (%j)", (baseUrl) => {
    expect(seedPayoutEmail("seller@personal.example.com", baseUrl).kind).toBe("leave");
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
