import type { Db } from "../db.js";

// Deterministic risk features for an order (see CLAUDE.md "AI"). These are the
// first step of the risk engine: the LLM classifier reads them and the policy
// layer's hard rules are based on them.
//
// The result holds only numbers, our own phrase ids and row ids, never listing
// or chat text. Chat is untrusted input, so a message can trip a phrase id but
// can't put its own words into the features.

const DAY_MS = 24 * 60 * 60 * 1000;

/** With fewer comparable listings than this, a category median is noise, so it's reported as null. */
export const MIN_COMPARABLE_LISTINGS = 3;

// ---------- Off-platform payment phrases ----------

/**
 * Matched against normalize()'s output: lowercase a-z, digits, "&", single
 * spaces. Over-matching ("no e-transfer please") is accepted: a hit is only a
 * signal, and the policy layer turns it into a warning rather than a block.
 */
const OFF_PLATFORM_PATTERNS = {
  e_transfer: /\b(?:e ?transfers?|e ?xfers?|e ?trans|interac|email money transfer)\b/,
  cash_app: /\b(?:cash ?app|cash ?tag)\b/,
  venmo: /\bvenmo\b/,
  zelle: /\bzelle\b/,
  other_wallet: /\b(?:revolut|apple ?pay|google ?pay|g ?pay|wechat ?pay|ali ?pay)\b/,
  bank_transfer: /\b(?:wire (?:transfer|me|the money|the payment)|bank transfer|western union|money ?gram)\b/,
  crypto: /\b(?:crypto|bitcoin|btc|ethereum|usdt)\b/,
  gift_card: /\b(?:gift ?cards?|steam cards?|itunes cards?|amazon cards?)\b/,
  paypal_direct: /\b(?:paypal me|friends (?:and|&|n) family|f ?& ?f|to my paypal)\b/,
  cash_in_person:
    /\b(?:cash (?:only|instead|in person|on (?:pickup|delivery)|at pickup|when we meet|is (?:fine|ok|okay))|pay(?:ing)? (?:(?:you|me) )?(?:(?:with|in|by|using) )?cash|in cash)\b/,
  avoid_platform:
    /\b(?:off (?:the )?(?:platform|app|site)|outside (?:of )?(?:the )?(?:platform|app|site|paypal|escrow)|(?:skip|avoid|bypass) (?:the )?(?:platform|app|site|paypal|escrow|fees?)|without (?:the )?(?:platform|app|site|paypal|escrow))\b/,
} as const;

export type OffPlatformPhrase = keyof typeof OFF_PLATFORM_PATTERNS;

const PHRASES = Object.entries(OFF_PLATFORM_PATTERNS) as [OffPlatformPhrase, RegExp][];

// Cyrillic and Greek letters that look like a-z, used to slip past filters.
// Written as code points because they'd be indistinguishable from Latin letters in a diff.
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  (
    [
      [0x0430, "a"], // Cyrillic
      [0x0441, "c"],
      [0x0435, "e"],
      [0x0456, "i"],
      [0x043e, "o"],
      [0x0440, "p"],
      [0x0455, "s"],
      [0x0445, "x"],
      [0x0443, "y"],
      [0x03b1, "a"], // Greek
      [0x03bf, "o"],
      [0x03bd, "v"],
    ] as const
  ).map(([code, letter]) => [String.fromCodePoint(code), letter]),
);
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");

const LEET: Record<string, string> = { "@": "a", $: "s", "!": "i", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/** Turns separators into single spaces and joins spaced-out letters ("v e n m o"). */
function normalize(text: string): string {
  return text
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\b(?:[a-z0-9] ){2,}[a-z0-9]\b/g, (spaced) => spaced.replaceAll(" ", ""))
    .trim();
}

/**
 * The off-platform payment phrases found in a piece of text. Checks the text
 * as written and with leetspeak undone ("c@sh app", "v3nmo"), separately, so
 * ordinary digits like prices can't hide a match. Accents and invisible
 * characters are removed first.
 */
export function findOffPlatformPhrases(text: string): OffPlatformPhrase[] {
  const folded = text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLowerCase()
    .replace(LOOKALIKE_RE, (ch) => LOOKALIKES[ch]);
  const plain = normalize(folded);
  const unleet = normalize(folded.replace(/[@$!013457]/g, (ch) => LEET[ch]));
  return PHRASES.filter(([, pattern]) => pattern.test(plain) || pattern.test(unleet)).map(([phrase]) => phrase);
}

// ---------- Price ----------

/** Median of integer cents, rounded to whole cents. Null for an empty list. */
export function medianCents(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ---------- Features ----------

export type RiskFeatures = {
  /** Whole days since the seller signed up. */
  sellerAccountAgeDays: number;
  /** Listings the seller posted in the 24 hours before `now`, including removed ones. */
  sellerListingsLast24h: number;
  /** The order's amount, the median for its category, and amount ÷ median (2 decimals). */
  price: {
    amountCents: number;
    categoryMedianCents: number | null;
    ratioToMedian: number | null;
    comparableListings: number;
  };
  /** Disputes on the seller's other orders. */
  sellerPastDisputes: number;
  /** Disputes the buyer opened on their other orders. */
  buyerPastDisputes: number;
  /** One entry per phrase per message in this order's buyer/seller chat, oldest first. */
  offPlatformPhrases: { phrase: OffPlatformPhrase; messageId: string; sender: "buyer" | "seller" }[];
};

/**
 * An order's buyer/seller chat up to `now`. By listing and participants: the
 * chat API doesn't set chat_messages.order_id.
 */
export function orderChatWhere({ listingId, buyerId, sellerId }: { listingId: string; buyerId: string; sellerId: string }, now: Date) {
  return {
    listingId,
    createdAt: { lte: now },
    OR: [
      { senderId: buyerId, recipientId: sellerId },
      { senderId: sellerId, recipientId: buyerId },
    ],
  };
}

/**
 * Computes an order's risk features as of `now`. Read-only; takes a transaction
 * client so the caller can combine it with its own writes.
 */
export async function computeRiskFeatures(db: Db, orderId: string, now: Date = new Date()): Promise<RiskFeatures> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      amountCents: true,
      currency: true,
      buyerId: true,
      sellerId: true,
      listingId: true,
      listing: { select: { category: true } },
      seller: { select: { createdAt: true } },
    },
  });
  const { buyerId, sellerId, listingId } = order;

  const [sellerListingsLast24h, comparables, sellerPastDisputes, buyerPastDisputes, messages] = await Promise.all([
    db.listing.count({ where: { sellerId, createdAt: { gt: new Date(now.getTime() - DAY_MS), lte: now } } }),
    // Other sellers only, so nobody can post listings to shift their own median.
    db.listing.findMany({
      where: {
        category: order.listing.category,
        currency: order.currency,
        id: { not: listingId },
        sellerId: { not: sellerId },
        status: { not: "REMOVED" },
        createdAt: { lte: now },
      },
      select: { priceCents: true },
    }),
    db.dispute.count({ where: { orderId: { not: orderId }, order: { sellerId }, createdAt: { lte: now } } }),
    db.dispute.count({ where: { orderId: { not: orderId }, openedById: buyerId, createdAt: { lte: now } } }),
    db.chatMessage.findMany({
      where: orderChatWhere({ listingId, buyerId, sellerId }, now),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, senderId: true, body: true },
    }),
  ]);

  const median = comparables.length >= MIN_COMPARABLE_LISTINGS ? medianCents(comparables.map((l) => l.priceCents)) : null;

  return {
    sellerAccountAgeDays: Math.max(0, Math.floor((now.getTime() - order.seller.createdAt.getTime()) / DAY_MS)),
    sellerListingsLast24h,
    price: {
      amountCents: order.amountCents,
      categoryMedianCents: median,
      ratioToMedian: median ? Math.round((order.amountCents / median) * 100) / 100 : null,
      comparableListings: comparables.length,
    },
    sellerPastDisputes,
    buyerPastDisputes,
    offPlatformPhrases: messages.flatMap((message) =>
      findOffPlatformPhrases(message.body).map((phrase) => ({
        phrase,
        messageId: message.id,
        sender: message.senderId === sellerId ? ("seller" as const) : ("buyer" as const),
      })),
    ),
  };
}
