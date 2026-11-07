import type { Db } from "../db.js";

// Deterministic risk features for an order (see CLAUDE.md "AI"). These are the
// first step of the risk engine: the LLM classifier reads them (except the
// injection phrases) and the policy layer's hard rules are based on them.
//
// The result holds only numbers, our own phrase ids and row ids, never listing
// or chat text. Listings and chat are untrusted input, so they can trip a phrase
// id but can't put their own words into the features.

const DAY_MS = 24 * 60 * 60 * 1000;

/** With fewer comparable listings than this, a category median is noise, so it's reported as null. */
export const MIN_COMPARABLE_LISTINGS = 3;

// ---------- Off-platform payment phrases ----------

/**
 * Matched against normalize()'s output: lowercase a-z, digits, "&", single
 * spaces. Over-matching ("no e-transfer please") is accepted: a hit is only a
 * signal. On its own the policy layer turns it into a warning rather than a
 * block; it only blocks alongside a new seller and a low price.
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

/** Removes accents and invisible characters. Keeps case and punctuation. */
function stripInvisible(text: string): string {
  return text.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "");
}

function fold(text: string): string {
  return stripInvisible(text)
    .toLowerCase()
    .replace(LOOKALIKE_RE, (ch) => LOOKALIKES[ch]);
}

/** A folded text as written and with leetspeak undone, normalized separately so ordinary digits can't hide a match. */
function wordForms(folded: string): string[] {
  return [normalize(folded), normalize(folded.replace(/[@$!013457]/g, (ch) => LEET[ch]))];
}

/**
 * The off-platform payment phrases found in a piece of text. Checks the text
 * as written and with leetspeak undone ("c@sh app", "v3nmo"). Accents and
 * invisible characters are removed first.
 */
export function findOffPlatformPhrases(text: string): OffPlatformPhrase[] {
  const forms = wordForms(fold(text));
  return PHRASES.filter(([, pattern]) => forms.some((form) => pattern.test(form))).map(([phrase]) => phrase);
}

// ---------- Prompt-injection phrases ----------

/**
 * Text trying to steer the risk assessment. The floor these set has to hold when
 * the classifier has been fooled, so unlike the classifier's prompt_injection
 * signal this doesn't depend on it. Like the off-platform phrases, a hit is only a
 * signal: the policy layer holds the order with a warning, and never blocks on it.
 *
 * Matched against normalize()'s output, with no punctuation left. "ignore the
 * instructions" is left out because of "ignore the instructions on the box".
 */
const INJECTION_WORD_PATTERNS = {
  ignore_instructions:
    /\b(?:(?:ignore|disregard|forget|override) (?!the (?:instructions?|prompts?|guidelines?)\b)(?:(?:all|any|every|of|the|your|prior|previous|above|earlier|preceding|system) ){0,5}(?:instructions?|prompts?|guidelines?)|(?:ignore|disregard) (?:all |everything )?(?:of )?(?:the )?above|(?:ignora|ignorar|ignore|olvida) (?:\w+ ){0,3}instrucciones)\b/,
  note_to_ai:
    /\b(?:notes?|messages?|instructions?|attention|memo) (?:to|for) (?:(?:the|any|all|our) )?(?:ai(?: model)?|llm|assistant|assessor|reviewer|moderator|classifier|bot|checker)s?\b/,
  mark_low_risk: /\b(?:mark(?:ed)?|rate|classif(?:y|ied)|flag|label|score|report|treat|assess|consider|approve)(?: \w+){0,4} (?:as |at )?low risk\b/,
  prior_assessment: /\b(?:prior|previous|earlier|past|last) (?:(?:risk|fraud|manual) )?(?:assessment|classification|evaluation)\b/,
} as const;

/**
 * Matched against fold()'s output, because these rely on punctuation. A role name
 * counts only at the start of the text or after a delimiter, so "Operating system:
 * Windows 11" doesn't match.
 */
const INJECTION_MARKUP_PATTERNS = {
  role_marker:
    /(?:^|[\n.!?;:>\]{}()"'*#-])\s*(?:system|assistant|developer|admin(?:istrator)?)\s*:|\[\s*(?:system|assistant|developer|admin(?:istrator)?)\b|<\s*\/?\s*(?:system|assistant|instructions?|facts|untrusted\w*)\b/,
  addresses_ai: /\b(?:ai|llm|automated)\s+(?:assessors?|reviewers?|moderators?|classifiers?|checkers?|systems?|agents?)\s*[:,]/,
  forged_result: /["']?\brisk["']?\s*[:=]\s*["']?(?:low|medium|high)\b/,
} as const;

/**
 * Long enough to carry an instruction. Needs upper and lower case, so hex hashes
 * don't count, and has no "/", "-" or "_", so URLs and slugs don't either.
 */
const BASE64_BLOB_RE = /[A-Za-z0-9+]{40,}={0,2}/g;

export type InjectionPhrase = keyof typeof INJECTION_WORD_PATTERNS | keyof typeof INJECTION_MARKUP_PATTERNS | "base64_blob";

const INJECTION_WORD_PHRASES = Object.entries(INJECTION_WORD_PATTERNS) as [InjectionPhrase, RegExp][];
const INJECTION_MARKUP_PHRASES = Object.entries(INJECTION_MARKUP_PATTERNS) as [InjectionPhrase, RegExp][];

function hasBase64Blob(text: string): boolean {
  return (stripInvisible(text).match(BASE64_BLOB_RE) ?? []).some((blob) => /[a-z]/.test(blob) && /[A-Z]/.test(blob));
}

/** The prompt-injection phrases found in a piece of text. Same evasion handling as findOffPlatformPhrases. */
export function findInjectionPhrases(text: string): InjectionPhrase[] {
  const folded = fold(text);
  const forms = wordForms(folded);
  return [
    ...INJECTION_WORD_PHRASES.filter(([, pattern]) => forms.some((form) => pattern.test(form))).map(([phrase]) => phrase),
    ...INJECTION_MARKUP_PHRASES.filter(([, pattern]) => pattern.test(folded)).map(([phrase]) => phrase),
    ...(hasBase64Blob(text) ? (["base64_blob"] as const) : []),
  ];
}

export type InjectionHit = {
  phrase: InjectionPhrase;
  /** The chat message it was found in, or null for the listing. */
  messageId: string | null;
  sender: "buyer" | "seller";
};

/** Every injection phrase in a listing and its chat: listing first, then one entry per phrase per message. */
export function findInjectionHits(
  listing: { title: string; description: string },
  messages: { id: string; sender: "buyer" | "seller"; body: string }[],
): InjectionHit[] {
  return [
    ...findInjectionPhrases(`${listing.title}\n${listing.description}`).map((phrase) => ({ phrase, messageId: null, sender: "seller" as const })),
    ...messages.flatMap(({ id, sender, body }) => findInjectionPhrases(body).map((phrase) => ({ phrase, messageId: id, sender }))),
  ];
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
  /** Injection phrases in the listing and this order's chat. Not sent to the classifier, so the floor stays independent of it. */
  injectionPhrases: InjectionHit[];
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
      listing: { select: { category: true, title: true, description: true } },
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
  const chat = messages.map(({ id, senderId, body }) => ({ id, body, sender: senderId === sellerId ? ("seller" as const) : ("buyer" as const) }));

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
    offPlatformPhrases: chat.flatMap(({ id, sender, body }) => findOffPlatformPhrases(body).map((phrase) => ({ phrase, messageId: id, sender }))),
    injectionPhrases: findInjectionHits(order.listing, chat),
  };
}
