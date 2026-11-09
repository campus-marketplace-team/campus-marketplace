import { describe, expect, it } from "vitest";
import { SEED_LISTINGS, seedListingAction } from "../prisma/seedListings.js";

// Re-running the seed on the shared database must never put a sold or reserved
// item back on sale (that's how one seed listing was sold twice), or rewrite
// what a dispute shows was sold.

describe("seedListingAction", () => {
  it("creates a missing listing", () => {
    expect(seedListingAction(null)).toBe("create");
  });

  it("refreshes a listing that's still for sale", () => {
    expect(seedListingAction("ACTIVE")).toBe("update");
  });

  it.each(["RESERVED", "SOLD", "REMOVED"] as const)("leaves a %s listing exactly as it is", (status) => {
    expect(seedListingAction(status)).toBe("keep");
  });
});

describe("SEED_LISTINGS", () => {
  it("has a unique photo slug per listing", () => {
    const slugs = SEED_LISTINGS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
