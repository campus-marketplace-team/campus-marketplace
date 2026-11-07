import { defineConfig } from "vitest/config";

// Smoke checks against the DEPLOYED app (npm run test:smoke -w server). Never
// part of `npm test`: the default config's include pattern (*.test.ts) doesn't
// match smoke/*.smoke.ts. Read-only requests only; see CLAUDE.md
// "Testing against the deployed app".
export default defineConfig({
  test: {
    include: ["smoke/**/*.smoke.ts"],
    // Render's free plan can take about a minute to wake up.
    testTimeout: 150_000,
    hookTimeout: 150_000,
  },
});
