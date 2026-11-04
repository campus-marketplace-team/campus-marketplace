// Gives (or with --revoke, removes) admin rights for an existing account, so it
// can open /admin. There's deliberately no API for this.
//
//   npm run admin:grant -w server -- seed.alex.chen@mcmaster.ca
//   npm run admin:grant -w server -- seed.alex.chen@mcmaster.ca --revoke
//
// The database is shared with production, so this changes the live account.

import { normalizeEmail } from "../src/auth/email.js";
import { prisma } from "../src/db.js";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const email = normalizeEmail(args.find((a) => !a.startsWith("--")));

try {
  if (!email) {
    console.error("Usage: npm run admin:grant -w server -- <email> [--revoke]");
    process.exitCode = 1;
  } else {
    const { count } = await prisma.user.updateMany({ where: { email }, data: { isAdmin: !revoke } });
    if (count === 0) {
      console.error(`No account with email ${email}`);
      process.exitCode = 1;
    } else {
      console.log(`${email} is ${revoke ? "no longer an admin" : "now an admin"}.`);
    }
  }
} finally {
  await prisma.$disconnect();
}
