// Risk engine ids shared by the API and the client (see CLAUDE.md "AI").

/** The policy layer's hard rules (server/src/risk/policy.ts). */
export const RISK_HARD_RULES = [
  "off_platform_payment",
  "very_low_price",
  "many_recent_listings",
  "many_past_disputes",
  /** The classifier reported the prompt_injection signal. A fooled classifier won't. */
  "prompt_injection",
  /** Our own phrase detector found injection text, whatever the classifier said. */
  "injection_phrase",
  "new_seller_off_platform_low_price",
] as const;

export type RiskHardRule = (typeof RISK_HARD_RULES)[number];

/**
 * What the buyer is told about why an order was held or blocked: one fixed sentence
 * per deterministic hard rule. Never the classifier's own reasons or any chat or
 * listing text, which are shaped by untrusted input. `prompt_injection` has no label
 * because it comes from the classifier, not from our own checks.
 */
export const BUYER_RISK_REASON_LABELS: Record<RiskHardRule, string | null> = {
  off_platform_payment: "Someone in this chat mentioned paying outside the app",
  very_low_price: "The price is far below similar listings",
  many_recent_listings: "This seller posted a lot of listings in the last day",
  many_past_disputes: "This seller has had several disputes on past orders",
  prompt_injection: null,
  injection_phrase: "This chat or listing contains text aimed at our safety checks",
  new_seller_off_platform_low_price: "A very new seller account asked to be paid outside the app, at a low price",
};

/** The hard rules safe to show a buyer, from a stored decision's JSON. Unknown values are dropped. */
export function buyerRiskReasons(hardRules: unknown): RiskHardRule[] {
  if (!Array.isArray(hardRules)) return [];
  const known = new Set<string>(RISK_HARD_RULES);
  const seen = new Set<RiskHardRule>();
  for (const rule of hardRules) {
    if (typeof rule === "string" && known.has(rule) && BUYER_RISK_REASON_LABELS[rule as RiskHardRule]) seen.add(rule as RiskHardRule);
  }
  return [...seen];
}
