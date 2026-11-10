// Dev seed: 5 verified test users and 21 listings across several categories
// (prisma/seedListings.ts). Listing photos are client/public/images/<slug>.webp,
// fetched once with scripts/fetchListingImages.ts.
// Re-running it puts a reserved, sold or removed seed listing (ids 201+) back
// on sale unless one of its orders still holds the buyer's money (AUTHORIZED,
// IN_DISPUTE, ESCALATED; see seedListingAction). It never touches demo
// listings (3xx), other users' listings, orders, ledger entries or decisions.
// With DEMO_SELLER_PAYPAL_EMAIL set (and the PayPal sandbox), every seed user's
// payout email is set to it, so the worker can pay out their captured sales.
// Run: npm run seed -w server 

import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";
import type { ListingCategory, ListingStatus, Prisma } from "../src/generated/prisma/client.js";
import { getPayPalConfig } from "../src/paypal/client.js";
import { seedPayoutEmail } from "./seedPayoutEmail.js";
import { SEED_LISTINGS, seedListingAction, seedPhotoPath, type SeedListingOrder } from "./seedListings.js";

// Dev-only login for every seed user. Never use seed accounts with real money.
const SEED_PASSWORD = "password123";

const SCHOOL_DOMAIN = "mcmaster.ca";

const seedId = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

type SeedUser = { id: string; email: string; displayName: string };

const users: SeedUser[] = [
  { id: seedId(101), email: `seed.alex.chen@${SCHOOL_DOMAIN}`, displayName: "Alex Chen" },
  { id: seedId(102), email: `seed.priya.patel@${SCHOOL_DOMAIN}`, displayName: "Priya Patel" },
  { id: seedId(103), email: `seed.jordan.smith@${SCHOOL_DOMAIN}`, displayName: "Jordan Smith" },
  { id: seedId(104), email: `seed.fatima.ali@${SCHOOL_DOMAIN}`, displayName: "Fatima Ali" },
  { id: seedId(105), email: `seed.marcus.lee@${SCHOOL_DOMAIN}`, displayName: "Marcus Lee" },
];

type SeedListingData = {
  sellerId: string;
  title: string;
  description: string;
  category: ListingCategory;
  priceCents: number;
  photoUrls: string[];
};

/**
 * Creates, refreshes or resets one seed listing in the caller's transaction.
 * The listing row and its orders are locked first, so no checkout can start
 * (a new order or authorize waits on the listing row, a PayPal order or state
 * change waits on the order row) between the check and the write.
 */
async function seedOneListing(tx: Prisma.TransactionClient, id: string, data: SeedListingData, seedUserIds: string[]) {
  const [current] = await tx.$queryRaw<{ status: ListingStatus; sellerId: string }[]>`
    SELECT "status", "seller_id"::text AS "sellerId" FROM "listings" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const orders = await tx.$queryRaw<SeedListingOrder[]>`
    SELECT "id"::text AS "id", "state"
    FROM "orders" WHERE "listing_id" = ${id}::uuid
    ORDER BY "created_at"
    FOR UPDATE`;
  const action = seedListingAction(current ?? null, seedUserIds, orders);
  if (action.kind === "create") await tx.listing.create({ data: { id, ...data, status: "ACTIVE" } });
  else if (action.kind === "update") await tx.listing.update({ where: { id }, data });
  else if (action.kind === "reset") await tx.listing.update({ where: { id }, data: { ...data, status: "ACTIVE" } });
  return action;
}

async function main() {
  const now = new Date();
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const u of users) {
    const data = { email: u.email, displayName: u.displayName, emailVerifiedAt: now, passwordHash };
    await prisma.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
  }

  const seedUserIds = users.map((u) => u.id);
  const payout = seedPayoutEmail(process.env.DEMO_SELLER_PAYPAL_EMAIL, getPayPalConfig()?.baseUrl ?? process.env.PAYPAL_BASE_URL);
  if (payout.kind === "set") {
    await prisma.user.updateMany({ where: { id: { in: seedUserIds } }, data: { paypalEmail: payout.email } });
  }

  const reset: string[] = [];
  const skipped: string[] = [];
  for (const [i, l] of SEED_LISTINGS.entries()) {
    const id = seedId(201 + i);
    const data = {
      sellerId: users[l.seller].id,
      title: l.title,
      description: l.description,
      category: l.category,
      priceCents: l.priceCents,
      photoUrls: [seedPhotoPath(l.slug)],
    };
    const action = await prisma.$transaction((tx) => seedOneListing(tx, id, data, seedUserIds));
    if (action.kind === "reset") reset.push(l.title);
    else if (action.kind === "skip" && action.reason === "OTHER_SELLER") {
      skipped.push(`${l.title} [${id}]: now sold by another user`);
    } else if (action.kind === "skip") {
      skipped.push(`${l.title} [${id}]: order ${action.order.id} is ${action.order.state} (money still held)`);
    }
  }

  console.log(`Seeded ${users.length} users and ${SEED_LISTINGS.length} listings.`);
  if (payout.kind === "set") console.log(`Seed users' payout email set to ${payout.email}.`);
  else console.log(`Seed users' payout emails left as they were: ${payout.reason}.`);
  if (reset.length) console.log(`Reset to ACTIVE (${reset.length}):\n  ${reset.join("\n  ")}`);
  if (skipped.length) console.log(`Skipped (${skipped.length}):\n  ${skipped.join("\n  ")}`);
  console.log(`Seed users log in with password "${SEED_PASSWORD}".`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());