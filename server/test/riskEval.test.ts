import { isListingCategory } from "@campus/shared";
import { describe, expect, it } from "vitest";
import { RISK_EVAL_CASES } from "../evals/riskCases.js";
import { buildRiskInput, runRiskCase, runRiskEval, summarizeRiskEval } from "../evals/riskEval.js";
import type { Classify } from "../src/risk/assess.js";
import type { RiskClassification } from "../src/risk/classifier.js";

const answer = (risk: RiskClassification["risk"], source: RiskClassification["source"] = "llm"): RiskClassification => ({
  risk,
  reasons: ["test"],
  signals: [],
  source,
  fallbackReason: source === "llm" ? null : "llm_error",
  model: "test",
  rawOutput: null,
});

/** A classifier that injection has fully talked around. */
const alwaysLow: Classify = async () => answer("low");

const byId = (id: string) => {
  const found = RISK_EVAL_CASES.find((testCase) => testCase.id === id);
  if (!found) throw new Error(`No eval case ${id}`);
  return found;
};

describe("risk eval set", () => {
  it("has 40 uniquely named cases, half scams, including injection attempts", () => {
    expect(RISK_EVAL_CASES).toHaveLength(40);
    expect(new Set(RISK_EVAL_CASES.map((c) => c.id)).size).toBe(40);
    expect(RISK_EVAL_CASES.filter((c) => c.label === "scam")).toHaveLength(20);
    expect(RISK_EVAL_CASES.filter((c) => c.group === "injection").length).toBeGreaterThanOrEqual(5);
  });

  it("gives each group the label it stands for, and uses real categories", () => {
    for (const { group, label, listing } of RISK_EVAL_CASES) {
      expect(label).toBe(group === "scam" || group === "injection" ? "scam" : "legit");
      expect(isListingCategory(listing.category)).toBe(true);
    }
  });
});

describe("buildRiskInput", () => {
  it("runs chat through the real phrase detector, including evasions", () => {
    for (const [id, phrase] of [
      ["scam-macbook-etransfer", "e_transfer"],
      ["scam-leetspeak-venmo", "venmo"],
      ["scam-spaced-etransfer", "e_transfer"],
      ["inj-classic-scam-with-injection", "cash_app"],
    ]) {
      expect(buildRiskInput(byId(id)).features.offPlatformPhrases.map((hit) => hit.phrase)).toContain(phrase);
    }
  });

  it("computes the price ratio the way computeRiskFeatures does, and null without a median", () => {
    expect(buildRiskInput(byId("scam-macbook-etransfer")).features.price.ratioToMedian).toBe(0.17);
    expect(buildRiskInput(byId("legit-no-median")).features.price).toMatchObject({ categoryMedianCents: null, ratioToMedian: null, comparableListings: 0 });
  });
});

describe("runRiskCase", () => {
  it("still blocks the classic scam when injection talks the classifier into low", async () => {
    const { decision } = await runRiskCase(byId("inj-classic-scam-with-injection"), alwaysLow);
    expect(decision).toMatchObject({ outcome: "BLOCKED", hardRules: expect.arrayContaining(["new_seller_off_platform_low_price"]) });
  });

  it("uses the classifier's answer when no hard rule fires", async () => {
    const { decision } = await runRiskCase(byId("legit-calculus-book"), async () => answer("high"));
    expect(decision).toMatchObject({ floor: "low", outcome: "BLOCKED" });
  });
});

describe("runRiskEval", () => {
  it("keeps the cases' order and stays within the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const results = await runRiskEval(
      RISK_EVAL_CASES,
      async () => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return answer("low");
      },
      4,
    );
    expect(results.map((r) => r.testCase.id)).toEqual(RISK_EVAL_CASES.map((c) => c.id));
    expect(peak).toBe(4);
  });
});

describe("summarizeRiskEval", () => {
  // No hard rules fire on this case, so the classifier's answer decides.
  const calmCase = byId("legit-calculus-book");
  const run = (label: "scam" | "legit", risk: RiskClassification["risk"], source: RiskClassification["source"] = "llm") =>
    runRiskCase({ ...calmCase, label }, async () => answer(risk, source));

  it("scores held and blocked orders separately", async () => {
    const summary = summarizeRiskEval(
      await Promise.all([run("scam", "high"), run("scam", "medium"), run("scam", "low"), run("legit", "medium"), run("legit", "low"), run("legit", "low")]),
    );
    expect(summary.flagged).toEqual({ truePositives: 2, falseNegatives: 1, falsePositives: 1, trueNegatives: 2, precision: 2 / 3, recall: 2 / 3 });
    expect(summary.blocked).toEqual({ truePositives: 1, falseNegatives: 2, falsePositives: 0, trueNegatives: 3, precision: 1, recall: 1 / 3 });
    expect(summary.mistakes).toHaveLength(2);
  });

  it("leaves fallbacks out of the score, so a dead API can't look like perfect recall", async () => {
    const summary = summarizeRiskEval(await Promise.all([run("scam", "medium", "fallback"), run("legit", "low")]));
    expect(summary.scored).toBe(1);
    expect(summary.fallbacks).toHaveLength(1);
    expect(summary.flagged.truePositives).toBe(0);
    expect(summary.flagged.recall).toBeNull();
  });

  it("reports precision as null when nothing was flagged", async () => {
    expect(summarizeRiskEval([await run("legit", "low")]).flagged.precision).toBeNull();
  });
});
