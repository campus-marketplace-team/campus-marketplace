import type { Classify } from "../src/risk/assess.js";
import type { RiskClassification, RiskInput } from "../src/risk/classifier.js";
import { findOffPlatformPhrases, type RiskFeatures } from "../src/risk/features.js";
import { applyRiskPolicy, type RiskPolicyDecision } from "../src/risk/policy.js";
import type { RiskEvalCase, RiskEvalGroup } from "./riskCases.js";

// Runs eval cases through the real risk engine: phrase detection, the classifier
// and the policy layer. Cases are held in memory rather than saved as orders,
// because the database is shared with production, so the database half of the
// pipeline is left to riskFeatures.test.ts and riskCheckout.test.ts.

export type RiskEvalResult = {
  testCase: RiskEvalCase;
  classification: RiskClassification;
  decision: RiskPolicyDecision;
};

/** What computeRiskFeatures and loadRiskInput would produce for this case's rows. */
export function buildRiskInput(testCase: RiskEvalCase): RiskInput {
  const { listing, medianCents, seller = {}, buyerPastDisputes = 0 } = testCase;
  const chat = testCase.chat.map(([sender, body], index) => ({ id: `${testCase.id}-m${index + 1}`, sender, body }));
  const features: RiskFeatures = {
    sellerAccountAgeDays: seller.accountAgeDays ?? 200,
    sellerListingsLast24h: seller.listingsLast24h ?? 1,
    price: {
      amountCents: listing.priceCents,
      categoryMedianCents: medianCents,
      ratioToMedian: medianCents ? Math.round((listing.priceCents / medianCents) * 100) / 100 : null,
      comparableListings: medianCents ? 8 : 0,
    },
    sellerPastDisputes: seller.pastDisputes ?? 0,
    buyerPastDisputes,
    offPlatformPhrases: chat.flatMap(({ id, sender, body }) => findOffPlatformPhrases(body).map((phrase) => ({ phrase, messageId: id, sender }))),
  };
  return { listing: { ...listing, currency: "USD" }, features, chat, omittedChatMessages: 0 };
}

export async function runRiskCase(testCase: RiskEvalCase, classify: Classify): Promise<RiskEvalResult> {
  const input = buildRiskInput(testCase);
  const classification = await classify(input);
  return { testCase, classification, decision: applyRiskPolicy(input.features, classification) };
}

/** Runs every case, at most `concurrency` at a time, and keeps the cases' order. */
export async function runRiskEval(cases: RiskEvalCase[], classify: Classify, concurrency: number): Promise<RiskEvalResult[]> {
  const results = new Array<RiskEvalResult>(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++;
      results[index] = await runRiskCase(cases[index], classify);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------- Metrics ----------

export type Score = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Null when nothing was predicted positive. */
  precision: number | null;
  /** Null when there are no scams. */
  recall: number | null;
};

function score(results: RiskEvalResult[], isPositive: (result: RiskEvalResult) => boolean): Score {
  const count = (scam: boolean, positive: boolean) => results.filter((r) => (r.testCase.label === "scam") === scam && isPositive(r) === positive).length;
  const truePositives = count(true, true);
  const falsePositives = count(false, true);
  const falseNegatives = count(true, false);
  const trueNegatives = count(false, false);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : null,
    recall: truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : null,
  };
}

export const isFlagged = ({ decision }: RiskEvalResult) => decision.outcome !== "NORMAL";

export type RiskEvalSummary = {
  /** Cases the classifier answered. The only ones scored. */
  scored: number;
  /** Cases where the classifier failed. */
  fallbacks: RiskEvalResult[];
  /** A scam counts as caught if the order is held or blocked. */
  flagged: Score;
  /** A scam counts as caught only if the order is blocked. */
  blocked: Score;
  /** Flagged cases per group. */
  groups: Record<RiskEvalGroup, { flagged: number; total: number }>;
  /** Scored cases where flagged-or-not disagrees with the label. */
  mistakes: RiskEvalResult[];
};

/**
 * Scores only the cases the classifier answered. A fallback becomes medium, which
 * counts as flagged, so an unreachable API would otherwise look like perfect recall.
 */
export function summarizeRiskEval(results: RiskEvalResult[]): RiskEvalSummary {
  const answered = results.filter((r) => r.classification.source === "llm");
  const groups: RiskEvalSummary["groups"] = {
    scam: { flagged: 0, total: 0 },
    injection: { flagged: 0, total: 0 },
    legit: { flagged: 0, total: 0 },
    legit_lookalike: { flagged: 0, total: 0 },
  };
  for (const result of answered) {
    const group = groups[result.testCase.group];
    group.total += 1;
    if (isFlagged(result)) group.flagged += 1;
  }
  return {
    scored: answered.length,
    fallbacks: results.filter((r) => r.classification.source !== "llm"),
    flagged: score(answered, isFlagged),
    blocked: score(answered, ({ decision }) => decision.outcome === "BLOCKED"),
    groups,
    mistakes: answered.filter((r) => isFlagged(r) !== (r.testCase.label === "scam")),
  };
}
