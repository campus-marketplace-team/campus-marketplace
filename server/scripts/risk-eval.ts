// Runs the labeled risk eval set through the risk engine with the real Claude API
// and prints precision and recall. Needs ANTHROPIC_API_KEY in server/.env. Uses no
// database and makes one paid API call per case. Exits 1 if any case fell back,
// because those aren't scored and the numbers would be incomplete.
//
// Run:  npm run risk:eval -w server

import "dotenv/config";
import { RISK_EVAL_CASES } from "../evals/riskCases.js";
import { isFlagged, runRiskEval, summarizeRiskEval, type Score } from "../evals/riskEval.js";
import { classifyRisk } from "../src/risk/classifier.js";

const CONCURRENCY = 4;

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

function printScore(title: string, { precision, recall, truePositives, falsePositives, falseNegatives, trueNegatives }: Score) {
  console.log(`\n${title}`);
  console.log(`  precision: ${percent(precision)}`);
  console.log(`  recall:    ${percent(recall)}`);
  console.log(`  scams caught ${truePositives}, missed ${falseNegatives}; legit stopped ${falsePositives}, passed ${trueNegatives}`);
}

async function main() {
  const results = await runRiskEval(RISK_EVAL_CASES, classifyRisk, CONCURRENCY);

  console.log(`${"case".padEnd(34)} ${"label".padEnd(6)} ${"llm".padEnd(7)} ${"floor".padEnd(7)} ${"outcome".padEnd(18)} result`);
  for (const result of results) {
    const { testCase, classification, decision } = result;
    const llm = classification.source === "llm" ? classification.risk : "failed";
    const verdict = classification.source !== "llm" ? "NOT SCORED" : isFlagged(result) === (testCase.label === "scam") ? "ok" : "WRONG";
    console.log(`${testCase.id.padEnd(34)} ${testCase.label.padEnd(6)} ${llm.padEnd(7)} ${decision.floor.padEnd(7)} ${decision.outcome.padEnd(18)} ${verdict}`);
  }

  const summary = summarizeRiskEval(results);
  console.log(`\nScored ${summary.scored} of ${results.length} cases on ${[...new Set(results.map((r) => r.classification.model))].join(", ")}.`);
  printScore("Flagged (order held or blocked)", summary.flagged);
  printScore("Blocked only", summary.blocked);

  console.log("\nFlagged by group");
  for (const [group, { flagged, total }] of Object.entries(summary.groups)) console.log(`  ${group.padEnd(16)} ${flagged}/${total}`);

  if (summary.mistakes.length > 0) console.log("\nMistakes");
  for (const { testCase, classification, decision } of summary.mistakes) {
    console.log(`  ${testCase.id} (${testCase.label}): ${testCase.note}`);
    console.log(`    policy: ${decision.reasoning}`);
    console.log(`    signals: ${classification.signals.join(", ") || "(none)"}`);
    for (const reason of classification.reasons) console.log(`    reason: ${reason}`);
  }

  if (summary.fallbacks.length > 0) {
    console.error(`\nRisk eval INCOMPLETE: ${summary.fallbacks.length} case(s) fell back and weren't scored: ${summary.fallbacks.map((r) => `${r.testCase.id} (${r.classification.fallbackReason})`).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
