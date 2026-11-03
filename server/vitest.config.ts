import { defineConfig } from "vitest/config";

// Tests run against the shared Supabase database through its session pooler,
// which allows only 15 clients in total, shared with the API and the worker.
// `npm test` runs 3 test files at once (--maxWorkers=3), each with its own pg
// pool, so each pool is capped at 4 connections (src/db.ts reads
// DATABASE_POOL_MAX): at most 12 for the suite. That's still enough for the
// concurrency tests to use parallel connections. dotenv doesn't override a
// variable that's already set, so this wins over any DATABASE_POOL_MAX in .env.
export default defineConfig({
  test: {
    env: { DATABASE_POOL_MAX: "4" },
  },
});
