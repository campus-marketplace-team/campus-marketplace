// How an escalation the dispute agent couldn't decide reads to an admin. Decisions
// are audit history and are never edited, so older rows keep their original
// wording in the database; the dashboard maps it to this wording when it shows them.
// New escalations are saved with this wording already.

/** The causes with their own wording. The dispute agent records both budget errors (exceeded, unavailable) as `budget`. */
export type WordedEscalationCause = "api_error" | "budget" | "injection_detected";

const FIRST_SENTENCE = "Claude couldn't reach a decision on this dispute, so it was escalated to a person.";

const REASON_TEXT: Record<WordedEscalationCause, string> = {
  api_error: "the AI service returned an error",
  budget: "today's AI usage limit was reached",
  injection_detected: "the report or chat contained text aimed at the AI",
};

/** The reasoning saved on a new escalation with one of these causes. */
export function escalationReasoning(cause: WordedEscalationCause): string {
  return `${FIRST_SENTENCE} (Reason: ${REASON_TEXT[cause]}.)`;
}

/** What escalations with these causes were saved with before this wording, exactly. */
const LEGACY_REASONING: Record<WordedEscalationCause, string> = {
  api_error: "The automated dispute agent didn't settle this dispute because a call to the Claude API failed, so it needs an admin's decision.",
  budget: "The automated dispute agent couldn't run because the Claude API budget was used up, so this dispute needs an admin's decision. No evidence was assessed.",
  injection_detected:
    "The automated dispute agent didn't settle this dispute because text in the report, listing or chat matched our prompt-injection rules, so the agent wasn't run on it, so it needs an admin's decision.",
};

const CAUSE_BY_STORED_TEXT = new Map<string, WordedEscalationCause>(
  (Object.keys(REASON_TEXT) as WordedEscalationCause[]).flatMap((cause) => [
    [LEGACY_REASONING[cause], cause],
    [escalationReasoning(cause), cause],
  ]),
);

/**
 * The reasoning to show for a dispute decision. Only an escalation our own code
 * saved (no model output) is mapped: one the agent chose keeps its own reasoning,
 * even if the model happened to write one of these texts. Anything without a
 * mapping is shown as stored.
 */
export function displayDisputeReasoning(decision: { outcome: string; reasoning: string | null; llmOutput: unknown }): string | null {
  const { outcome, reasoning, llmOutput } = decision;
  if (outcome !== "ESCALATE" || llmOutput !== null || reasoning === null) return reasoning;
  const cause = CAUSE_BY_STORED_TEXT.get(reasoning);
  return cause ? escalationReasoning(cause) : reasoning;
}
