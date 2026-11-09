import { DISPUTE_APPROVAL_LIMIT_CENTS, DISPUTE_LIMITS, DISPUTE_REASONS } from "@campus/shared";
import { describe, expect, it } from "vitest";
import { DEMO_DISPUTE_REPORT, DEMO_LISTINGS, DEMO_SCENARIOS } from "../prisma/demoData.js";
import { SEED_LISTINGS } from "../prisma/seedListings.js";
import { findInjectionPhrases, findOffPlatformPhrases, medianCents } from "../src/risk/features.js";
import { LOW_PRICE_RATIO } from "../src/risk/policy.js";

// The demo seed (scripts/demo-seed.ts) runs once against the shared database, so
// nothing exercises it day to day. These pin what each scenario relies on, so a
// change to the rules or the data can't quietly turn the demo into something else.

describe("demo scenarios", () => {
  it("scam: the seller asks to pay off the platform, so the new-seller rule can fire", () => {
    const sellerLines = DEMO_SCENARIOS.scam.chat.filter((l) => l.from === "seller");
    expect(sellerLines.flatMap((l) => findOffPlatformPhrases(l.body))).toContain("e_transfer");
  });

  it("scam: priced at most half the Electronics median of the seed and demo listings", () => {
    const electronics = [...SEED_LISTINGS, ...Object.values(DEMO_LISTINGS)]
      .filter((l) => l.category === "ELECTRONICS" && l.title !== DEMO_LISTINGS.scam.title)
      .map((l) => l.priceCents);
    const median = medianCents(electronics)!;
    expect(DEMO_LISTINGS.scam.priceCents / median).toBeLessThanOrEqual(LOW_PRICE_RATIO);
  });

  it("sale and dispute: nothing in their chat looks off-platform or like injection, so only the classifier decides", () => {
    for (const key of ["sale", "dispute"] as const) {
      for (const line of DEMO_SCENARIOS[key].chat) {
        expect(findOffPlatformPhrases(line.body), line.body).toEqual([]);
        expect(findInjectionPhrases(line.body), line.body).toEqual([]);
      }
    }
  });

  it("dispute: above the approval limit, so the agent's proposal waits for an admin", () => {
    expect(DEMO_LISTINGS.dispute.priceCents).toBeGreaterThan(DISPUTE_APPROVAL_LIMIT_CENTS);
  });

  it("dispute: the report is one the app accepts", () => {
    expect(DISPUTE_REASONS).toContain(DEMO_DISPUTE_REPORT.reason);
    expect(DEMO_DISPUTE_REPORT.description.length).toBeLessThanOrEqual(DISPUTE_LIMITS.descriptionMax);
  });

  it("every chat starts with the buyer, as the chat API requires", () => {
    for (const scenario of Object.values(DEMO_SCENARIOS)) expect(scenario.chat[0].from).toBe("buyer");
  });

  it("demo listings have their own photo slugs and ids", () => {
    const slugs = [...SEED_LISTINGS, ...Object.values(DEMO_LISTINGS)].map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const ids = Object.values(DEMO_LISTINGS).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
