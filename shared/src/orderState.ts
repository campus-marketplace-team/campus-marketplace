// Order state machine (see CLAUDE.md "Order state machine").
// Pure data + helpers only: no database logic here. The server's
// transition() function enforces this table on every state change.

/**
 * Every order state. Values are identical to the Prisma `OrderState` enum,
 * so a Prisma order's `state` can be passed to these helpers directly.
 */
export const OrderState = {
  CREATED: "CREATED",
  BLOCKED: "BLOCKED",
  AUTHORIZED: "AUTHORIZED",
  VOIDED: "VOIDED",
  IN_DISPUTE: "IN_DISPUTE",
  REFUNDED: "REFUNDED",
  PARTIAL_REFUND: "PARTIAL_REFUND",
  RELEASED: "RELEASED",
  ESCALATED: "ESCALATED",
  CAPTURED: "CAPTURED",
  PAYOUT_PENDING: "PAYOUT_PENDING",
  PAID_OUT: "PAID_OUT",
  PAYOUT_RETRY: "PAYOUT_RETRY",
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

export const ORDER_STATES: readonly OrderState[] = Object.values(OrderState);

const S = OrderState;

/**
 * Legal transitions, keyed by the current state. Anything not listed is
 * illegal, including staying in the same state. States with an empty list
 * have no way out.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  [S.CREATED]: [S.BLOCKED, S.AUTHORIZED], // risk high | buyer approves in PayPal
  [S.BLOCKED]: [],
  [S.AUTHORIZED]: [S.VOIDED, S.IN_DISPUTE, S.CAPTURED], // deadline passes | problem reported | QR scan verified
  [S.VOIDED]: [],
  [S.IN_DISPUTE]: [S.REFUNDED, S.PARTIAL_REFUND, S.RELEASED, S.ESCALATED],
  [S.REFUNDED]: [],
  [S.PARTIAL_REFUND]: [S.PAYOUT_PENDING], // the seller is paid what's left
  [S.RELEASED]: [S.PAYOUT_PENDING], // the seller is paid
  [S.ESCALATED]: [S.REFUNDED, S.PARTIAL_REFUND, S.RELEASED], // an admin decides
  [S.CAPTURED]: [S.PAYOUT_PENDING],
  [S.PAYOUT_PENDING]: [S.PAID_OUT, S.PAYOUT_RETRY], // payout succeeds | payout fails
  [S.PAID_OUT]: [],
  [S.PAYOUT_RETRY]: [S.PAYOUT_PENDING], // worker re-sends the payout
};

/** True for strings that are a known order state (e.g. values from webhooks or requests). */
export function isOrderState(value: unknown): value is OrderState {
  return typeof value === "string" && Object.hasOwn(LEGAL_TRANSITIONS, value);
}

/** True only if `from → to` appears in LEGAL_TRANSITIONS. Unknown states are illegal. */
export function isLegalTransition(from: OrderState, to: OrderState): boolean {
  if (!isOrderState(from) || !isOrderState(to)) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** True if no transition leads out of this state. */
export function isTerminalState(state: OrderState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}
