import type { Prisma } from "./generated/prisma/client.js";

// `npm test` runs against the same database as the deployed app, and every
// user it creates has an email starting with TEST_USER_EMAIL_PREFIX
// (test/helpers/api.ts). Its orders are dated around 2001, so a real worker
// would find them overdue and act on them with real PayPal and Claude calls.
// The worker therefore passes `skipTestUsers: true` to every job and relay;
// tests call the same functions without it.

export const TEST_USER_EMAIL_PREFIX = "apitest.";

/** Orders where neither the buyer nor the seller is a test user. */
export const NOT_TEST_USER_ORDER: Prisma.OrderWhereInput = {
  NOT: [{ buyer: { email: { startsWith: TEST_USER_EMAIL_PREFIX } } }, { seller: { email: { startsWith: TEST_USER_EMAIL_PREFIX } } }],
};

/** An order filter to spread into a sweep's `where`: test users' orders left out, or nothing. */
export function orderScope(skipTestUsers = false): Prisma.OrderWhereInput {
  return skipTestUsers ? NOT_TEST_USER_ORDER : {};
}
