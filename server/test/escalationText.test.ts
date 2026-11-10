import { describe, expect, it } from "vitest";
import { displayDisputeReasoning, escalationReasoning } from "../src/disputes/escalationText.js";

const FIRST = "Claude couldn't reach a decision on this dispute, so it was escalated to a person.";

/** An escalation our own code saved: no model output. */
const saved = (reasoning: string | null) => ({ outcome: "ESCALATE", reasoning, llmOutput: null });

describe("escalationReasoning", () => {
  it("words api_error without mentioning the API", () => {
    expect(escalationReasoning("api_error")).toBe("Claude wasn't able to come up with a solution for this dispute, so it has been escalated to a person.");
  });

  it.each([
    ["budget", "today's AI usage limit was reached"],
    ["injection_detected", "the report or chat contained text aimed at the AI"],
  ] as const)("words %s", (cause, reason) => {
    expect(escalationReasoning(cause)).toBe(`${FIRST} (Reason: ${reason}.)`);
  });
});

describe("displayDisputeReasoning", () => {
  it.each([
    ["api_error", "The automated dispute agent didn't settle this dispute because a call to the Claude API failed, so it needs an admin's decision."],
    ["budget", "The automated dispute agent couldn't run because the Claude API budget was used up, so this dispute needs an admin's decision. No evidence was assessed."],
    [
      "injection_detected",
      "The automated dispute agent didn't settle this dispute because text in the report, listing or chat matched our prompt-injection rules, so the agent wasn't run on it, so it needs an admin's decision.",
    ],
  ] as const)("rewords an older %s escalation as it shows it", (cause, stored) => {
    expect(displayDisputeReasoning(saved(stored))).toBe(escalationReasoning(cause));
  });

  it("shows a new escalation as saved", () => {
    expect(displayDisputeReasoning(saved(escalationReasoning("budget")))).toBe(escalationReasoning("budget"));
  });

  it("falls back to the stored reasoning for a cause without a mapping", () => {
    const stored = "The automated dispute agent didn't settle this dispute because it didn't reach a decision in time, so it needs an admin's decision.";
    expect(displayDisputeReasoning(saved(stored))).toBe(stored);
    expect(displayDisputeReasoning(saved(null))).toBeNull();
  });

  it("keeps the agent's own reasoning when it chose to escalate, even if it matches a mapped text", () => {
    const own = "The buyer and seller disagree about the condition and there are no photos.";
    expect(displayDisputeReasoning({ outcome: "ESCALATE", reasoning: own, llmOutput: { reasoning: own } })).toBe(own);
    const copied = "The automated dispute agent didn't settle this dispute because a call to the Claude API failed, so it needs an admin's decision.";
    expect(displayDisputeReasoning({ outcome: "ESCALATE", reasoning: copied, llmOutput: { reasoning: copied } })).toBe(copied);
  });

  it("leaves other outcomes alone", () => {
    const stored = "The automated dispute agent couldn't run because the Claude API budget was used up, so this dispute needs an admin's decision. No evidence was assessed.";
    expect(displayDisputeReasoning({ outcome: "REFUND", reasoning: stored, llmOutput: null })).toBe(stored);
  });
});
