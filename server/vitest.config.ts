import { configDefaults, defineConfig } from "vitest/config";

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
//
// Test files keep apart by date: each puts its due rows in its own window
// (2000, 2001, ...) and sweeps with `now` inside it. A sweep picks up every row
// due before `now`, though, so the file with the earliest rows can't share the
// database with anyone: workerSkipsTestUsers.test.ts (1999) runs its jobs
// without the test-user filter, and any other file's sweep running at the same
// time would also reach its rows. So it runs alone, in a second group that
// starts only after every other file has finished.
const RUNS_ALONE = ["test/workerSkipsTestUsers.test.ts"];

export default defineConfig({
  test: {
    env: { DATABASE_POOL_MAX: "4" },
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: "parallel", exclude: [...configDefaults.exclude, ...RUNS_ALONE], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "alone", include: RUNS_ALONE, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
