import { defineConfig } from "vitest/config";

// Tests run against the shared Supabase database through its session pooler,
// which allows only 15 clients in total, shared with the deployed API + worker
// (at most 6) and local dev. `npm test` runs 2 test files at once
// (--maxWorkers=2 in package.json), each with its own pg pool, so each pool is
// capped at 4 connections (src/db.ts reads DATABASE_POOL_MAX): at most 8 for the
// suite. That's still enough for the concurrency tests to use parallel
// connections. dotenv doesn't override a
// variable that's already set, so this wins over any DATABASE_POOL_MAX in .env.
//
// Round trips to the remote database make a test that does several writes take
// longer than vitest's default 5 s on a slow connection, hence the longer timeout.
export default defineConfig({
  test: {
    env: { DATABASE_POOL_MAX: "4" },
    testTimeout: 30_000,
  },
});
