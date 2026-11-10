import { AUTHORIZATION_VALID_DAYS, HONOR_PERIOD_MS, platformFeeCents, type RiskHardRule } from "@campus/shared";
import { type Db, prisma } from "../db.js";
import { isUuid } from "../ids.js";
import { postTransaction } from "../ledger/postTransaction.js";
import { type Authorization, type PayPalClient, PayPalError } from "../paypal/client.js";
import {
  assessOrderRisk,
  buyerRiskStatus,
  type Classify,
  currentRiskDecision,
  isBlockedForBuyer,
  latestRiskOutcome,
  latestRiskReasons,
  reasonsFrom,
} from "../risk/assess.js";
import { handoffWindowMs, type RiskOutcome } from "../risk/policy.js";
import { StaleOrderError, transition } from "./stateMachine.js";

// Checkout (see CLAUDE.md "Payment model"):
//   1. assessCheckout ("Check & buy"): our order (CREATED) and a risk decision,
//      which can block the order here. The buyer sees the result before PayPal opens.
//   2. startCheckout (the Buttons' createOrder): a PayPal order with intent
//      AUTHORIZE, only against a current, unblocked decision from step 1.
//   3. The buyer approves in the PayPal popup.
//   4. authorizeCheckout: PayPal authorizes (funds held, not taken), then ONE DB
//      transaction reserves the listing, moves the order to AUTHORIZED with a
//      handoff deadline set by the risk decision, and posts escrow_held / buyer_funds.
//
// Both steps are safe to repeat: PayPal calls reuse the order's request ids,
// and an order that's already AUTHORIZED is returned as is.

/** A refusal the route sends to the client as `{ error, code }` with this HTTP status. */
export class CheckoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Thrown inside the DB transaction when someone else reserved the listing first. */
class ListingUnavailableError extends Error {}

/** The order fields the API returns to the client (also used by the QR handoff). */
export const orderView = {
  id: true,
  listingId: true,
  state: true,
  version: true,
  amountCents: true,
  currency: true,
  paypalOrderId: true,
  authorizedAt: true,
  handoffDeadline: true,
  capturedAt: true,
} as const;

/** Turns a PayPalError into a CheckoutError (503 if retryable, else 502); rethrows anything else. */
export function paypalFailure(err: unknown): never {
  if (!(err instanceof PayPalError)) throw err;
  console.error(`${err.message}${err.debugId ? ` (debug id ${err.debugId})` : ""}`);
  if (err.retryable) {
    throw new CheckoutError(503, "PAYPAL_UNAVAILABLE", "PayPal didn't respond. Please try again.");
  }
  throw new CheckoutError(502, "PAYPAL_ERROR", "PayPal couldn't process this payment. Please try again later.");
}

/** The same fixed refusal everywhere. The classifier's reasons stay internal: they're shaped by untrusted text. */
function riskBlocked() {
  return new CheckoutError(403, "RISK_BLOCKED", "This order was blocked by our safety checks. You haven't been charged.");
}

/** No current risk decision: the client shows "Check & buy" again. */
function notAssessed() {
  return new CheckoutError(409, "NOT_ASSESSED", "Something changed since your safety check. Please check again before paying.");
}

/** Voids an authorization we can't use. Failures are logged; the handoff deadline sweeper is the backstop. */
async function voidQuietly(paypal: PayPalClient, orderId: string, authorizationId: string) {
  try {
    await paypal.voidAuthorization({ orderId, authorizationId });
  } catch (err) {
    console.error(`Could not void authorization ${authorizationId} for order ${orderId}:`, (err as Error).message);
  }
}

/** The listing, if this buyer may buy it right now. */
async function buyableListing(buyerId: string, listingId: unknown) {
  const listing = isUuid(listingId)
    ? await prisma.listing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true, status: true, priceCents: true, currency: true },
      })
    : null;
  if (!listing || listing.status === "REMOVED") throw new CheckoutError(404, "NOT_FOUND", "Listing not found");
  if (listing.sellerId === buyerId) throw new CheckoutError(403, "OWN_LISTING", "You can't buy your own listing");
  if (listing.status !== "ACTIVE") {
    throw new CheckoutError(409, "LISTING_UNAVAILABLE", "This listing isn't available anymore");
  }
  return listing;
}

type BuyableListing = Awaited<ReturnType<typeof buyableListing>>;

/**
 * The buyer's unpaid order at the listing's current price. A price change since
 * then gets a fresh order (and a fresh PayPal request id, so PayPal can't answer
 * with the old amount).
 */
function openOrder(buyerId: string, listing: BuyableListing) {
  return prisma.order.findFirst({
    where: { listingId: listing.id, buyerId, state: "CREATED", amountCents: listing.priceCents, currency: listing.currency },
    orderBy: { createdAt: "desc" },
    select: { id: true, listingId: true, buyerId: true, sellerId: true, paypalOrderId: true },
  });
}

export type CheckoutAssessment = { outcome: RiskOutcome; reasons: RiskHardRule[] };

/**
 * Step 1 of checkout ("Check & buy"): creates (or reuses) the buyer's CREATED
 * order for this listing and decides its risk, reusing a current decision
 * rather than calling the classifier again. Returns the outcome and the
 * buyer-safe reasons; a BLOCKED outcome has moved the order to BLOCKED.
 */
export async function assessCheckout(classify: Classify, buyerId: string, listingId: unknown): Promise<CheckoutAssessment> {
  const listing = await buyableListing(buyerId, listingId);
  // A block sticks, so retrying can't re-roll the classifier.
  const status = await buyerRiskStatus(buyerId, listing.id);
  if (status.outcome === "BLOCKED") return { outcome: "BLOCKED", reasons: status.reasons };

  const order =
    (await openOrder(buyerId, listing)) ??
    (await prisma.order.create({
      data: {
        listingId: listing.id,
        buyerId,
        sellerId: listing.sellerId,
        amountCents: listing.priceCents,
        platformFeeCents: platformFeeCents(listing.priceCents),
        currency: listing.currency,
      },
      select: { id: true },
    }));

  let outcome: RiskOutcome;
  try {
    outcome = await assessOrderRisk(order.id, { classify });
  } catch (err) {
    // The order left CREATED during the assessment, e.g. a concurrent authorize in another tab.
    if (err instanceof StaleOrderError) throw new CheckoutError(409, "ORDER_CLOSED", "This order can't be paid anymore");
    throw err;
  }
  // Fixed ids for fixed labels: the classifier's own reasons stay internal.
  return { outcome, reasons: await latestRiskReasons(prisma, order.id) };
}

/**
 * Step 2 of checkout, from the PayPal Buttons' createOrder: creates the PayPal
 * order for the buyer's assessed order. Never calls the classifier: it only
 * accepts a current decision from assessCheckout (recent, with no chat or
 * listing change since), and refuses with NOT_ASSESSED otherwise. Returns the
 * PayPal order id and whether to warn the buyer.
 */
export async function startCheckout(paypal: PayPalClient, buyerId: string, listingId: unknown) {
  const listing = await buyableListing(buyerId, listingId);
  if (await isBlockedForBuyer(prisma, buyerId, listing.id)) throw riskBlocked();

  const order = await openOrder(buyerId, listing);
  const decision = order ? await currentRiskDecision(order) : null;
  if (!order || !decision) throw notAssessed();
  if (decision.outcome === "BLOCKED") throw riskBlocked();
  const riskWarning = decision.outcome === "HOLD_WITH_WARNING";
  const riskReasons = riskWarning ? reasonsFrom(decision.evidence) : [];

  if (order.paypalOrderId) return { orderId: order.id, paypalOrderId: order.paypalOrderId, riskWarning, riskReasons };

  const created = await paypal
    .createOrder({ orderId: order.id, amountCents: listing.priceCents, currency: listing.currency })
    .catch(paypalFailure);
  // Same request id on a retry means the same PayPal order, so this only ever sets one value.
  await prisma.order.updateMany({
    where: { id: order.id, paypalOrderId: null },
    data: { paypalOrderId: created.paypalOrderId },
  });
  return { orderId: order.id, paypalOrderId: created.paypalOrderId, riskWarning, riskReasons };
}

/**
 * The DB half of authorizing, in the caller's transaction: reserve the
 * listing, CREATED → AUTHORIZED with the handoff deadline (longer if the latest
 * risk decision says so), and post escrow_held +amount / buyer_funds −amount.
 * Throws ListingUnavailableError
 * or StaleOrderError, which roll the whole transaction back.
 */
export async function recordAuthorization(
  tx: Db,
  order: { id: string; listingId: string; version: number; amountCents: number },
  authorization: Authorization,
  now: Date,
) {
  const reserved = await tx.listing.updateMany({
    where: { id: order.listingId, status: "ACTIVE" },
    data: { status: "RESERVED" },
  });
  if (reserved.count === 0) throw new ListingUnavailableError();

  await transition(tx, order.id, "CREATED", "AUTHORIZED", order.version, {
    paypalAuthorizationId: authorization.authorizationId,
    authorizedAt: now,
    handoffDeadline: new Date(now.getTime() + handoffWindowMs(await latestRiskOutcome(tx, order.id))),
    honorPeriodEndsAt: new Date(now.getTime() + HONOR_PERIOD_MS),
    authorizationExpiresAt:
      authorization.expiresAt ?? new Date(now.getTime() + AUTHORIZATION_VALID_DAYS * 24 * 60 * 60 * 1000),
  });

  await postTransaction(
    tx,
    [
      { account: "escrow_held", amountCents: order.amountCents },
      { account: "buyer_funds", amountCents: -order.amountCents },
    ],
    { kind: "AUTHORIZE", orderId: order.id, paypalRef: authorization.authorizationId },
  );
}

/** Called after the buyer approves in PayPal. Returns the AUTHORIZED order. */
export async function authorizeCheckout(paypal: PayPalClient, buyerId: string, orderId: unknown) {
  const order = isUuid(orderId)
    ? await prisma.order.findUnique({
        where: { id: orderId },
        select: { ...orderView, buyerId: true, sellerId: true, paypalAuthorizationId: true },
      })
    : null;
  // Someone else's order looks the same as a missing one.
  if (!order || order.buyerId !== buyerId) throw new CheckoutError(404, "NOT_FOUND", "Order not found");
  if (order.state === "AUTHORIZED") return getOrderView(order.id);
  if (order.state === "BLOCKED") throw riskBlocked();
  if (order.state !== "CREATED") {
    throw new CheckoutError(409, "ORDER_CLOSED", "This order can't be paid anymore");
  }
  if (!order.paypalOrderId) {
    throw new CheckoutError(409, "NOT_STARTED", "Start checkout with PayPal first");
  }
  // No money is held without a decision: covers orders from before the risk engine,
  // and a second open order for this listing whose sibling got blocked.
  if (await isBlockedForBuyer(prisma, buyerId, order.listingId)) throw riskBlocked();
  // Only against a decision that still matches the chat and listing, as for createOrder.
  const decision = await currentRiskDecision(order);
  if (!decision) throw notAssessed();
  if (decision.outcome === "BLOCKED") throw riskBlocked();

  let authorization: Authorization;
  try {
    authorization = await paypal.authorizeOrder({ orderId: order.id, paypalOrderId: order.paypalOrderId });
  } catch (err) {
    if (err instanceof PayPalError && err.status === 422) {
      if (err.issue === "ORDER_NOT_APPROVED") {
        throw new CheckoutError(409, "NOT_APPROVED", "Approve the payment in PayPal first");
      }
      if (err.issue === "INSTRUMENT_DECLINED") {
        throw new CheckoutError(402, "PAYMENT_DECLINED", "PayPal declined that payment method. Please try another one.");
      }
    }
    paypalFailure(err);
  }

  // CREATED is PayPal's status for a successful authorization.
  if (authorization.status !== "CREATED") {
    console.error(`Order ${order.id}: authorization ${authorization.authorizationId} is ${authorization.status}`);
    throw new CheckoutError(402, "NOT_AUTHORIZED", "PayPal didn't authorize this payment. Please try again.");
  }
  if (authorization.amountCents !== order.amountCents || authorization.currency !== order.currency) {
    console.error(
      `Order ${order.id}: PayPal authorized ${authorization.amountCents} ${authorization.currency}, expected ${order.amountCents} ${order.currency}`,
    );
    await voidQuietly(paypal, order.id, authorization.authorizationId);
    throw new CheckoutError(502, "AMOUNT_MISMATCH", "PayPal authorized the wrong amount, so the payment was cancelled");
  }

  try {
    await prisma.$transaction((tx) => recordAuthorization(tx, order, authorization, new Date()));
  } catch (err) {
    if (err instanceof ListingUnavailableError) {
      await voidQuietly(paypal, order.id, authorization.authorizationId);
      throw new CheckoutError(409, "LISTING_UNAVAILABLE", "Someone else just bought this. You haven't been charged.");
    }
    if (err instanceof StaleOrderError) {
      // A concurrent request (e.g. a double click) got there first with the same authorization.
      const current = await prisma.order.findUnique({
        where: { id: order.id },
        select: { state: true, paypalAuthorizationId: true },
      });
      if (current?.state === "AUTHORIZED" && current.paypalAuthorizationId === authorization.authorizationId) {
        return getOrderView(order.id);
      }
      throw new CheckoutError(409, "ORDER_CLOSED", "This order can't be paid anymore");
    }
    throw err;
  }
  return getOrderView(order.id);
}

export async function getOrderView(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id }, select: orderView });
}
