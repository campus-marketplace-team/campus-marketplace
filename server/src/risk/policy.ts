import { HANDOFF_WINDOW_MS, RISK_HOLD_WINDOW_MS } from "@campus/shared";
import type { RiskClassification } from "./classifier.js";
import type { RiskFeatures } from "./features.js";

// The policy layer: the last step of the risk engine, and the only one that
// decides anything (see CLAUDE.md "AI"). Pure and deterministic.
//
// Hard rules set a floor, and the final risk is the higher of the floor and the
// classifier's answer. So the classifier can raise risk but never lower it: a
// listing or chat that talks it into "low" still lands on the floor.

/** A price at or below this share of the category median is suspicious on its own. */
export const VERY_LOW_PRICE_RATIO = 0.25;
/** The lower bar for a low price when it comes with the other signs of the classic scam. */
export const LOW_PRICE_RATIO = 0.5;
/** A seller account younger than this counts as new. */
export const NEW_SELLER_DAYS = 7;
export const MANY_RECENT_LISTINGS = 10;
export const MANY_PAST_DISPUTES = 3;

export type RiskLevel = RiskClassification["risk"];
export type RiskOutcome = "NORMAL" | "HOLD_WITH_WARNING" | "BLOCKED";

export type HardRule =
  | "off_platform_payment"
  | "very_low_price"
  | "many_recent_listings"
  | "many_past_disputes"
  /** The classifier reported the prompt_injection signal. A fooled classifier won't. */
  | "prompt_injection"
  /** Our own phrase detector found injection text, whatever the classifier said. */
  | "injection_phrase"
  | "new_seller_off_platform_low_price";

export type RiskPolicyDecision = {
  /** Final level: the higher of the floor and the classifier's answer. */
  risk: RiskLevel;
  outcome: RiskOutcome;
  floor: RiskLevel;
  /** The hard rules that fired, whatever the classifier said. */
  hardRules: HardRule[];
  /** One deterministic sentence, built only from our own values. */
  reasoning: string;
};

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const OUTCOMES: Record<RiskLevel, RiskOutcome> = { low: "NORMAL", medium: "HOLD_WITH_WARNING", high: "BLOCKED" };

function higher(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Each hard rule that fired, with the floor it sets. */
function evaluateHardRules(features: RiskFeatures, signals: readonly string[]): { rule: HardRule; floor: RiskLevel }[] {
  const ratio = features.price.ratioToMedian;
  const fired: { rule: HardRule; floor: RiskLevel }[] = [];

  if (features.offPlatformPhrases.length > 0) fired.push({ rule: "off_platform_payment", floor: "medium" });
  if (ratio !== null && ratio <= VERY_LOW_PRICE_RATIO) fired.push({ rule: "very_low_price", floor: "medium" });
  if (features.sellerListingsLast24h >= MANY_RECENT_LISTINGS) fired.push({ rule: "many_recent_listings", floor: "medium" });
  if (features.sellerPastDisputes >= MANY_PAST_DISPUTES) fired.push({ rule: "many_past_disputes", floor: "medium" });
  if (signals.includes("prompt_injection")) fired.push({ rule: "prompt_injection", floor: "medium" });
  if (features.injectionPhrases.length > 0) fired.push({ rule: "injection_phrase", floor: "medium" });

  // Blocks without the classifier's help, so injection can't rescue the classic scam.
  // Only the seller's own words count: a buyer's message can't get a seller's listing blocked.
  if (
    features.offPlatformPhrases.some((hit) => hit.sender === "seller") &&
    features.sellerAccountAgeDays < NEW_SELLER_DAYS &&
    ratio !== null &&
    ratio <= LOW_PRICE_RATIO
  ) {
    fired.push({ rule: "new_seller_off_platform_low_price", floor: "high" });
  }
  return fired;
}

/** Combines the hard rules with the classifier's answer into the final decision. */
export function applyRiskPolicy(
  features: RiskFeatures,
  classification: Pick<RiskClassification, "risk" | "signals" | "source">,
): RiskPolicyDecision {
  const fired = evaluateHardRules(features, classification.signals);
  const floor = fired.reduce<RiskLevel>((level, { floor }) => higher(level, floor), "low");
  const risk = higher(floor, classification.risk);
  const hardRules = fired.map(({ rule }) => rule);
  const answer = classification.source === "llm" ? `Classifier said ${classification.risk}` : `Classifier failed, so ${classification.risk} was assumed`;
  const rules = hardRules.length > 0 ? `hard rules set a floor of ${floor} (${hardRules.join(", ")})` : "no hard rules fired";
  return { risk, outcome: OUTCOMES[risk], floor, hardRules, reasoning: `${answer}; ${rules}; final risk ${risk}.` };
}

/** How long the buyer and seller have to meet, given the order's risk outcome. */
export function handoffWindowMs(outcome: RiskOutcome | null): number {
  return outcome === "HOLD_WITH_WARNING" ? RISK_HOLD_WINDOW_MS : HANDOFF_WINDOW_MS;
}
