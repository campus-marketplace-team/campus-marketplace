import { buyerRiskReasons, type RiskHardRule } from "@campus/shared";
import type { ClaudeBudget } from "../ai/claude.js";
import { type Db, prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { transition } from "../orders/stateMachine.js";
import { loadRiskInput, type RiskClassification, type RiskInput } from "./classifier.js";
import { orderChatWhere } from "./features.js";
import { applyRiskPolicy, type RiskOutcome } from "./policy.js";

// Runs the whole risk engine for an order before checkout: features → classifier
// → policy, then saves the decision. A block and its decision commit together.

/** Replaceable so tests never call the real classifier. */
export type Classify = (input: RiskInput, budget: ClaudeBudget) => Promise<RiskClassification>;

/**
 * Clicking Pay again reuses a decision this recent if nothing it read has
 * changed, since each new assessment makes the buyer wait for a paid LLM call.
 */
export const DECISION_REUSE_MS = 60 * 60 * 1000;

/** The newest risk outcome saved for an order, or null if it was never assessed. */
export async function latestRiskOutcome(db: Db, orderId: string): Promise<RiskOutcome | null> {
  const decision = await db.decision.findFirst({
    where: { orderId, kind: "RISK" },
    orderBy: { createdAt: "desc" },
    select: { outcome: true },
  });
  return (decision?.outcome as RiskOutcome | undefined) ?? null;
}

/** True if this buyer has a blocked order on this listing. A block sticks, so retrying can't re-roll the classifier. */
export async function isBlockedForBuyer(db: Db, buyerId: string, listingId: string): Promise<boolean> {
  return (await db.order.count({ where: { buyerId, listingId, state: "BLOCKED" } })) > 0;
}

/**
 * The order's latest decision, if a Pay click would reuse it: it's recent and
 * neither the chat nor the listing has changed since.
 */
async function currentDecision(order: { id: string; listingId: string; buyerId: string; sellerId: string }, now: Date) {
  const decision = await prisma.decision.findFirst({
    where: { orderId: order.id, kind: "RISK" },
    orderBy: { createdAt: "desc" },
    select: { outcome: true, evidence: true, createdAt: true },
  });
  if (!decision || now.getTime() - decision.createdAt.getTime() > DECISION_REUSE_MS) return null;

  const [newMessages, editedListing] = await Promise.all([
    prisma.chatMessage.count({ where: { ...orderChatWhere(order, now), createdAt: { gt: decision.createdAt } } }),
    prisma.listing.count({ where: { id: order.listingId, updatedAt: { gt: decision.createdAt } } }),
  ]);
  return newMessages === 0 && editedListing === 0 ? decision : null;
}

/** The hard rules a buyer may see (fixed labels, see @campus/shared) from a decision's saved evidence. */
function reasonsFrom(evidence: Prisma.JsonValue | null): RiskHardRule[] {
  const hardRules = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence.hardRules : null;
  return buyerRiskReasons(hardRules);
}

/** The buyer-safe reasons behind an order's latest risk decision. */
export async function latestRiskReasons(db: Db, orderId: string): Promise<RiskHardRule[]> {
  const decision = await db.decision.findFirst({
    where: { orderId, kind: "RISK" },
    orderBy: { createdAt: "desc" },
    select: { evidence: true },
  });
  return reasonsFrom(decision?.evidence ?? null);
}

export type BuyerRiskStatus = { outcome: RiskOutcome | null; reasons: RiskHardRule[] };

/**
 * What the listing page shows this buyer before they pay. A block sticks (see
 * isBlockedForBuyer), so it's shown whatever happened since. A warning is shown
 * only while it still matches the chat and listing, i.e. while a Pay click would
 * reuse it; otherwise null, and the next Pay click assesses again.
 */
export async function buyerRiskStatus(buyerId: string, listingId: string, now = new Date()): Promise<BuyerRiskStatus> {
  const blocked = await prisma.order.findFirst({
    where: { buyerId, listingId, state: "BLOCKED" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (blocked) return { outcome: "BLOCKED", reasons: await latestRiskReasons(prisma, blocked.id) };

  const open = await prisma.order.findFirst({
    where: { buyerId, listingId, state: "CREATED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, listingId: true, buyerId: true, sellerId: true },
  });
  const decision = open ? await currentDecision(open, now) : null;
  if (!decision) return { outcome: null, reasons: [] };
  return { outcome: decision.outcome as RiskOutcome, reasons: reasonsFrom(decision.evidence) };
}

/**
 * Decides a CREATED order's risk and returns the outcome. A BLOCKED outcome has
 * already moved the order to BLOCKED. Throws if the decision can't be saved, or
 * StaleOrderError if the order left CREATED meanwhile, so checkout stops rather
 * than going ahead unassessed.
 */
export async function assessOrderRisk(orderId: string, { classify, now = new Date() }: { classify: Classify; now?: Date }): Promise<RiskOutcome> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, listingId: true, buyerId: true, sellerId: true, version: true },
  });
  const reusable = await currentDecision(order, now);
  if (reusable) return reusable.outcome as RiskOutcome;

  const input = await loadRiskInput(prisma, orderId, now);
  // Charged to the buyer, whose click on Pay caused the call.
  const classification = await classify(input, { userId: order.buyerId });
  const decision = applyRiskPolicy(input.features, classification);

  // Not inside a transaction with the classifier call, which can take many seconds.
  await prisma.$transaction(async (tx) => {
    await tx.decision.create({
      data: {
        kind: "RISK",
        orderId,
        listingId: order.listingId,
        risk: decision.risk,
        outcome: decision.outcome,
        // A listing can be edited later, so keep what was assessed. Chat can't, so its ids are enough.
        inputs: {
          features: input.features,
          listing: input.listing,
          chatMessageIds: input.chat.map((message) => message.id),
          omittedChatMessages: input.omittedChatMessages,
        } as Prisma.InputJsonObject,
        llmOutput: {
          source: classification.source,
          fallbackReason: classification.fallbackReason,
          risk: classification.risk,
          rawOutput: classification.rawOutput,
        },
        reasons: classification.reasons,
        signals: classification.signals,
        evidence: { floor: decision.floor, hardRules: decision.hardRules },
        reasoning: decision.reasoning,
        model: classification.model,
        // When the inputs were read, so a message sent during the classifier call still counts as new.
        createdAt: now,
      },
    });
    if (decision.outcome === "BLOCKED") await transition(tx, orderId, "CREATED", "BLOCKED", order.version);
  });
  return decision.outcome;
}
