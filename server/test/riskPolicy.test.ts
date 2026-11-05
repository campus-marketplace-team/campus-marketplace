import { HANDOFF_WINDOW_MS, RISK_HOLD_WINDOW_MS } from "@campus/shared";
import { describe, expect, it } from "vitest";
import type { RiskFeatures } from "../src/risk/features.js";
import { applyRiskPolicy, handoffWindowMs, type RiskLevel } from "../src/risk/policy.js";

const calm: RiskFeatures = {
  sellerAccountAgeDays: 200,
  sellerListingsLast24h: 1,
  price: { amountCents: 4000, categoryMedianCents: 4500, ratioToMedian: 0.89, comparableListings: 8 },
  sellerPastDisputes: 0,
  buyerPastDisputes: 0,
  offPlatformPhrases: [],
};

const withRatio = (ratioToMedian: number | null): RiskFeatures["price"] => ({ ...calm.price, ratioToMedian });
const phrase = (sender: "buyer" | "seller") => ({ phrase: "e_transfer" as const, messageId: "m1", sender });
const llm = (risk: RiskLevel, signals: string[] = []) => ({ risk, signals: signals as never, source: "llm" as const });

describe("applyRiskPolicy", () => {
  it("maps the classifier's level to an outcome when no hard rule fires", () => {
    expect(applyRiskPolicy(calm, llm("low"))).toMatchObject({ risk: "low", outcome: "NORMAL", floor: "low", hardRules: [] });
    expect(applyRiskPolicy(calm, llm("medium"))).toMatchObject({ risk: "medium", outcome: "HOLD_WITH_WARNING" });
    expect(applyRiskPolicy(calm, llm("high"))).toMatchObject({ risk: "high", outcome: "BLOCKED" });
  });

  it.each<[string, Partial<RiskFeatures>, string]>([
    ["an off-platform phrase", { offPlatformPhrases: [phrase("buyer")] }, "off_platform_payment"],
    ["a very low price", { price: withRatio(0.25) }, "very_low_price"],
    ["a burst of listings", { sellerListingsLast24h: 10 }, "many_recent_listings"],
    ["many past disputes", { sellerPastDisputes: 3 }, "many_past_disputes"],
  ])("%s holds the order even when the classifier says low", (_name, change, rule) => {
    const decision = applyRiskPolicy({ ...calm, ...change }, llm("low"));
    expect(decision).toMatchObject({ risk: "medium", outcome: "HOLD_WITH_WARNING", floor: "medium" });
    expect(decision.hardRules).toContain(rule);
  });

  it("holds an order the classifier flagged for injection but rated low", () => {
    const decision = applyRiskPolicy(calm, llm("low", ["prompt_injection"]));
    expect(decision).toMatchObject({ outcome: "HOLD_WITH_WARNING", hardRules: ["prompt_injection"] });
  });

  it("leaves values just inside the thresholds alone", () => {
    const decision = applyRiskPolicy({ ...calm, price: withRatio(0.26), sellerListingsLast24h: 9, sellerPastDisputes: 2 }, llm("low"));
    expect(decision).toMatchObject({ outcome: "NORMAL", hardRules: [] });
  });

  it("doesn't treat an unknown median as a low price", () => {
    const features = { ...calm, sellerAccountAgeDays: 0, offPlatformPhrases: [phrase("seller")], price: withRatio(null) };
    expect(applyRiskPolicy(features, llm("low"))).toMatchObject({ outcome: "HOLD_WITH_WARNING", hardRules: ["off_platform_payment"] });
  });

  describe("the classic scam: new seller, off-platform request, low price", () => {
    const scam: RiskFeatures = { ...calm, sellerAccountAgeDays: 6, offPlatformPhrases: [phrase("seller")], price: withRatio(0.5) };

    it("is blocked even when the classifier was talked into low", () => {
      expect(applyRiskPolicy(scam, llm("low"))).toMatchObject({ risk: "high", outcome: "BLOCKED", floor: "high" });
    });

    it("isn't blocked by a buyer's message alone", () => {
      const features = { ...scam, offPlatformPhrases: [phrase("buyer")] };
      expect(applyRiskPolicy(features, llm("low")).outcome).toBe("HOLD_WITH_WARNING");
    });

    it.each<[string, Partial<RiskFeatures>]>([
      ["an established seller", { sellerAccountAgeDays: 7 }],
      ["a fair price", { price: withRatio(0.51) }],
    ])("isn't blocked for %s", (_name, change) => {
      expect(applyRiskPolicy({ ...scam, ...change }, llm("low")).outcome).toBe("HOLD_WITH_WARNING");
    });
  });

  it("never lowers the classifier's answer, whatever the floor", () => {
    expect(applyRiskPolicy({ ...calm, offPlatformPhrases: [phrase("buyer")] }, llm("high")).outcome).toBe("BLOCKED");
  });

  it("says in its reasoning when the classifier failed", () => {
    const { reasoning } = applyRiskPolicy(calm, { risk: "medium", signals: [], source: "fallback" });
    expect(reasoning).toMatch(/Classifier failed/);
  });
});

describe("handoffWindowMs", () => {
  it("is longer only for a hold with warning", () => {
    expect(handoffWindowMs("HOLD_WITH_WARNING")).toBe(RISK_HOLD_WINDOW_MS);
    expect(handoffWindowMs("NORMAL")).toBe(HANDOFF_WINDOW_MS);
    expect(handoffWindowMs(null)).toBe(HANDOFF_WINDOW_MS);
    expect(RISK_HOLD_WINDOW_MS).toBeGreaterThan(HANDOFF_WINDOW_MS);
  });
});
