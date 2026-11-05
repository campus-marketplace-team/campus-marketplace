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
