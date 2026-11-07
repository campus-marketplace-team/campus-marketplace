import type Anthropic from "@anthropic-ai/sdk";
import { callClaude, type ClaudeBudget, ClaudeBudgetExceededError, ClaudeBudgetUnavailableError, type ClaudeParams, type CreateMessage } from "../ai/claude.js";
import { CheckoutError } from "../orders/checkout.js";
import type { PayPalClient } from "../paypal/client.js";
import { proposeDisputeAction } from "./actionTools.js";

// How the dispute agent calls Claude. When the budget stops a call, the dispute goes
// to an admin with the payment still on hold, rather than waiting on an agent that
// can't run. The agent's loop (agent.ts) makes every call through here.

export type DisputeAgentCallResult = { status: "answered"; response: Anthropic.Beta.Messages.BetaMessage } | { status: "left_for_admin" };

const OUT_OF_BUDGET_REASONING = "The automated dispute agent couldn't run because the Claude API budget was used up, so this dispute needs an admin's decision. No evidence was assessed.";

/** Records that the agent didn't decide, and passes the dispute to a person with the payment still on hold. */
export async function leaveDisputeForAdmin(paypal: PayPalClient, orderId: string, reasoning: string) {
  try {
    // Escalating moves no money and makes no PayPal call. No llmOutput: the model didn't decide this.
    await proposeDisputeAction(paypal, orderId, { action: "ESCALATE", reasoning, evidence: null }, { kind: "agent", model: null });
  } catch (err) {
    // Another decision got there first, so it isn't waiting on the agent any more.
    if (err instanceof CheckoutError && err.status === 409) return;
    throw err;
  }
}

export async function callDisputeAgentClaude(
  paypal: PayPalClient,
  orderId: string,
  budget: ClaudeBudget,
  params: ClaudeParams,
  options: { timeout: number; maxRetries: number },
  createMessage?: CreateMessage,
): Promise<DisputeAgentCallResult> {
  try {
    return { status: "answered", response: await callClaude("dispute_agent", budget, params, options, createMessage) };
  } catch (err) {
    if (!(err instanceof ClaudeBudgetExceededError || err instanceof ClaudeBudgetUnavailableError)) throw err;
    console.warn(`[dispute-agent] left order ${orderId} for an admin: ${err.message}`);
    await leaveDisputeForAdmin(paypal, orderId, OUT_OF_BUDGET_REASONING);
    return { status: "left_for_admin" };
  }
}
