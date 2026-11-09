// Dev seed: 5 verified test users and 20 listings across several categories
// (prisma/seedListings.ts). Listing photos are client/public/images/<slug>.webp,
// fetched once with scripts/fetchListingImages.ts.
// Run: npm run seed -w server 

import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth/password.js";
import { SEED_LISTINGS, seedPhotoPath } from "./seedListings.js";

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

async function main() {
  const now = new Date();
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const u of users) {
    const data = { email: u.email, displayName: u.displayName, emailVerifiedAt: now, passwordHash };
    await prisma.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
  }

  for (const [i, l] of SEED_LISTINGS.entries()) {
    const id = seedId(201 + i);
    const data = {
      sellerId: users[l.seller].id,
      title: l.title,
      description: l.description,
      category: l.category,
      priceCents: l.priceCents,
      photoUrls: [seedPhotoPath(l.slug)],
      status: "ACTIVE" as const,
    };
    await prisma.listing.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  console.log(`Seeded ${users.length} users and ${SEED_LISTINGS.length} listings.`);
  console.log(`Seed users log in with password "${SEED_PASSWORD}".`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());