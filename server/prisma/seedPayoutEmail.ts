import { isSandboxBaseUrl } from "../src/paypal/client.js";

export type SeedPayoutEmail = { kind: "set"; email: string } | { kind: "leave"; reason: string };

/**
 * Whether the seed sets every seed user's payout (PayPal) email, given
 * DEMO_SELLER_PAYPAL_EMAIL and PAYPAL_BASE_URL. Seed accounts never get real
 * money, so it only happens against the PayPal sandbox. Unset leaves whatever
 * emails the seed users already have.
 */
export function seedPayoutEmail(raw: string | undefined, paypalBaseUrl: string | null | undefined): SeedPayoutEmail {
  const email = (raw ?? "").trim();
  if (!email) return { kind: "leave", reason: "DEMO_SELLER_PAYPAL_EMAIL isn't set" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { kind: "leave", reason: "DEMO_SELLER_PAYPAL_EMAIL isn't an email address" };
  if (!isSandboxBaseUrl(paypalBaseUrl)) return { kind: "leave", reason: "PAYPAL_BASE_URL isn't the PayPal sandbox" };
  return { kind: "set", email };
}
