// "Report a problem" rules shared by the API (validation) and the client (form).

/**
 * Why a buyer reports a problem. Disputes opened in PayPal itself are stored
 * with a `PAYPAL_<reason>` reason instead, so readers must expect others too.
 */
export const DISPUTE_REASONS = ["NOT_AS_DESCRIBED", "DAMAGED", "WRONG_ITEM", "SELLER_NO_SHOW", "OTHER"] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export function isDisputeReason(value: unknown): value is DisputeReason {
  return typeof value === "string" && (DISPUTE_REASONS as readonly string[]).includes(value);
}

export const DISPUTE_LIMITS = {
  descriptionMax: 2000,
  photosMax: 6,
} as const;

/**
 * The dispute agent decides on its own only for orders up to this amount; above
 * it, refunds and releases wait for an admin. It's the order's amount, not the
 * refund's, because a small partial refund still sends the rest to the seller.
 */
export const DISPUTE_APPROVAL_LIMIT_CENTS = 2500;

/** What can decide a dispute. Values are the Prisma DecisionOutcome names. */
export const DISPUTE_ACTIONS = ["REFUND", "PARTIAL_REFUND", "RELEASE", "ESCALATE"] as const;

export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];
