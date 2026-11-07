// Runs the dispute agent once against a disputed order, on the real Claude API.
// Needs ANTHROPIC_API_KEY and the PayPal settings in server/.env. Bypasses the app's
// Claude budget and costs a few cents to a few tens of cents. Exits 1 unless the
// agent reached a decision.
//
// The database is shared with the deployed app. A real run goes through the same
// approval gate as the worker: on an order at or under the limit, its decision runs
// against PayPal (sandbox) straight away, and in any case it settles or escalates the
// dispute for real. Use --dry-run to see the proposal with nothing saved and no money moved.
//
// Run:  npm run dispute:agent -w server -- <orderId> [--dry-run]

import "dotenv/config";
import { prisma } from "../src/db.js";
import { runDisputeAgent } from "../src/disputes/agent.js";
import { getPayPalClient } from "../src/paypal/client.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [orderId] = args.filter((arg) => !arg.startsWith("--"));
  if (!orderId) {
    console.error("Usage: npm run dispute:agent -w server -- <orderId> [--dry-run]");
    process.exit(1);
  }

  const result = await runDisputeAgent(getPayPalClient(), orderId, { budget: { bypass: "live_check" }, dryRun });
  console.log(JSON.stringify(result, null, 2));

  if (!dryRun && result.status !== "skipped") {
    const decision = await prisma.decision.findFirst({
      where: { orderId, kind: "DISPUTE" },
      orderBy: { createdAt: "desc" },
      select: { id: true, outcome: true, actionStatus: true, amountCents: true, model: true, reasoning: true, evidence: true, paypalTransactionId: true },
    });
    console.log("\nDecision record:", JSON.stringify(decision, null, 2));
  }
  if (result.status !== "decided" && result.status !== "dry_run") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
