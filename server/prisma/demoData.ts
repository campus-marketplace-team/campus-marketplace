// Demo scenarios (task 5.3), created by scripts/demo-seed.ts on top of the
// regular seed (prisma/seed.ts). Each scenario goes through the app's own code
// against the PayPal sandbox, so every PayPal id is real:
//
//   sale     Priya buys Alex's yoga mat: approved in PayPal, QR scanned,
//            captured. The worker then pays Alex out (PAYOUT_PENDING → PAID_OUT).
//            (Listing 304. The first sale listing, 301, the laptop stand, is held
//            by a manual test order and is no longer part of the demo.)
//   scam     Jordan tries to buy a $25 "sealed" Switch from Sam, an account a few
//            days old who asks for an Interac e-transfer in chat. The hard rule
//            new_seller_off_platform_low_price blocks it before PayPal is called.
//   dispute  Fatima buys Marcus's speaker, then reports it's not as described.
//            It's over DISPUTE_APPROVAL_LIMIT_CENTS, so the dispute agent's
//            proposal waits in the admin approval queue with the hold in place.
//
// Chat lines and the report are ordinary user text: the risk engine and the
// dispute agent read them as untrusted input, like any other.

import type { DisputeReason } from "@campus/shared";
import type { ListingCategory } from "../src/generated/prisma/client.js";

/** Same id scheme as prisma/seed.ts: users 1xx, seed listings 2xx, demo listings 3xx. */
export const demoId = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const SCHOOL_DOMAIN = "mcmaster.ca";

export const DEMO_EMAILS = {
  alex: `seed.alex.chen@${SCHOOL_DOMAIN}`,
  priya: `seed.priya.patel@${SCHOOL_DOMAIN}`,
  jordan: `seed.jordan.smith@${SCHOOL_DOMAIN}`,
  fatima: `seed.fatima.ali@${SCHOOL_DOMAIN}`,
  marcus: `seed.marcus.lee@${SCHOOL_DOMAIN}`,
  sam: `seed.sam.rivera@${SCHOOL_DOMAIN}`,
} as const;

/**
 * The scam seller. Created by the demo seed, so the account is new when the scam
 * runs: the blocking rule needs a seller younger than NEW_SELLER_DAYS.
 */
export const DEMO_NEW_USER = { id: demoId(106), email: DEMO_EMAILS.sam, displayName: "Sam Rivera" };

export type DemoListing = {
  id: string;
  sellerEmail: string;
  title: string;
  description: string;
  category: ListingCategory;
  priceCents: number;
  /** Photo file name (without .webp) in client/public/images; see scripts/fetchListingImages.ts. */
  slug: string;
  photoSearch: string;
  pixabayId?: number;
};

export const DEMO_LISTINGS: Record<"sale" | "scam" | "dispute", DemoListing> = {
  sale: {
    id: demoId(304),
    sellerEmail: DEMO_EMAILS.alex,
    category: "SPORTS",
    priceCents: 2500,
    title: "Yoga mat with carry strap",
    description: "6 mm thick, non-slip on both sides. Used for one term of drop-in classes at the Pulse, wiped down and rolled up.",
    slug: "yoga-mat",
    photoSearch: "yoga mat",
  },
  scam: {
    id: demoId(302),
    sellerEmail: DEMO_EMAILS.sam,
    category: "ELECTRONICS",
    priceCents: 2500,
    title: "Nintendo Switch OLED, sealed in box",
    description: "Brand new, never opened. Moving abroad next week so it has to go fast.",
    slug: "game-console",
    photoSearch: "game console",
    pixabayId: 3953601,
  },
  dispute: {
    id: demoId(303),
    sellerEmail: DEMO_EMAILS.marcus,
    category: "ELECTRONICS",
    priceCents: 4500,
    title: "JBL Flip 5 Bluetooth speaker",
    description: "Loud and waterproof. Works perfectly, battery lasts all day. Comes with the charging cable.",
    slug: "bluetooth-speaker",
    photoSearch: "bluetooth speaker",
    pixabayId: 4109274,
  },
};

export type DemoChatLine = { from: "buyer" | "seller"; body: string };

export type DemoScenario = { listing: DemoListing; buyerEmail: string; chat: DemoChatLine[] };

export const DEMO_SCENARIOS: Record<"sale" | "scam" | "dispute", DemoScenario> = {
  sale: {
    listing: DEMO_LISTINGS.sale,
    buyerEmail: DEMO_EMAILS.priya,
    chat: [
      { from: "buyer", body: "Hi! Is the yoga mat still available? Could we meet at Mills Library tomorrow at 2?" },
      { from: "seller", body: "Yes, still available. Mills Library entrance at 2 works for me." },
      { from: "buyer", body: "Great, see you then! I'll pay through the app." },
    ],
  },
  scam: {
    listing: DEMO_LISTINGS.scam,
    buyerEmail: DEMO_EMAILS.jordan,
    chat: [
      { from: "buyer", body: "Is the Switch still available? That price is amazing." },
      { from: "seller", body: "Yes! I'm moving away so I need it gone fast. Interac e-transfer only, I'll ship it right after you pay." },
    ],
  },
  dispute: {
    listing: DEMO_LISTINGS.dispute,
    buyerEmail: DEMO_EMAILS.fatima,
    chat: [
      { from: "buyer", body: "Hi, does the speaker work well? Any issues with the sound or battery?" },
      { from: "seller", body: "Works perfectly, battery lasts all day. Can meet at the student centre Thursday at noon." },
      { from: "buyer", body: "Perfect, see you Thursday at noon." },
    ],
  },
};

/** The buyer's report on the dispute scenario's order. */
export const DEMO_DISPUTE_REPORT: { reason: DisputeReason; description: string } = {
  reason: "NOT_AS_DESCRIBED",
  description:
    "We met at the student centre and I tested it at home: the speaker crackles at every volume and turns off after about 10 minutes on battery. The listing and the seller's message both said it works perfectly. I haven't scanned the QR code, and I still have the speaker to return.",
};
