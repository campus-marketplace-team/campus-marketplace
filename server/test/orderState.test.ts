import {
  LEGAL_TRANSITIONS,
  ORDER_STATES,
  type OrderState,
  isLegalTransition,
  isOrderState,
} from "@campus/shared";
import { describe, expect, it } from "vitest";
import { OrderState as PrismaOrderState } from "../src/generated/prisma/enums.js";

// The state machine from CLAUDE.md, written out independently of the table
// in shared/ so a typo in either one fails this test.
const expected: Array<[OrderState, OrderState]> = [
  ["CREATED", "BLOCKED"],
  ["CREATED", "AUTHORIZED"],
  ["AUTHORIZED", "VOIDED"],
  ["AUTHORIZED", "IN_DISPUTE"],
  ["AUTHORIZED", "CAPTURED"],
  ["IN_DISPUTE", "REFUNDED"],
  ["IN_DISPUTE", "PARTIAL_REFUND"],
  ["IN_DISPUTE", "RELEASED"],
  ["IN_DISPUTE", "ESCALATED"],
  ["CAPTURED", "PAYOUT_PENDING"],
  ["PAYOUT_PENDING", "PAID_OUT"],
  ["PAYOUT_PENDING", "PAYOUT_RETRY"],
  ["PAYOUT_RETRY", "PAYOUT_PENDING"],
];
const key = (from: string, to: string) => `${from}->${to}`;
const expectedKeys = new Set(expected.map(([from, to]) => key(from, to)));

describe("order state machine", () => {
  it("has the same states as the Prisma OrderState enum", () => {
    expect([...ORDER_STATES].sort()).toEqual(Object.values(PrismaOrderState).sort());
  });

  it("allows exactly the transitions in CLAUDE.md", () => {
    const actual = Object.entries(LEGAL_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => key(from, to)),
    );
    expect(new Set(actual)).toEqual(expectedKeys);
  });

  it("isLegalTransition agrees with the table for every pair of states", () => {
    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATES) {
        expect(isLegalTransition(from, to), key(from, to)).toBe(expectedKeys.has(key(from, to)));
      }
    }
  });

  it("never allows staying in the same state", () => {
    for (const s of ORDER_STATES) expect(isLegalTransition(s, s)).toBe(false);
  });

  it("rejects unknown states", () => {
    expect(isOrderState("SHIPPED")).toBe(false);
    expect(isOrderState("toString")).toBe(false);
    expect(isLegalTransition("CREATED", "SHIPPED" as OrderState)).toBe(false);
    expect(isLegalTransition("SHIPPED" as OrderState, "CREATED")).toBe(false);
  });
});
