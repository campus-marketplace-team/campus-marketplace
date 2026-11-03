import { isLegalTransition, type OrderState } from "@campus/shared";
import { type Db, prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { isUuid } from "../ids.js";
import { ORDER_STATE_CHANGED, type OrderStateChangedPayload } from "../outbox/handlers.js";
import { enqueueOutbox } from "../outbox/outbox.js";

// The only way an order's state changes (see CLAUDE.md "Order state machine").
// Callers pass a Prisma transaction client so the state change commits or
// rolls back together with their ledger entries. Every successful transition
// also writes an `order.state_changed` outbox row in that same transaction,
// which the worker's relay turns into side effects (see src/outbox/).

export type TransitionResult = { orderId: string; state: OrderState; version: number };

/**
 * Other order columns written in the same UPDATE as the state change (e.g.
 * authorizedAt + handoffDeadline on AUTHORIZED). id, state and version are
 * owned by transition() and can't be set here.
 */
export type TransitionData = Omit<Prisma.OrderUpdateManyMutationInput, "id" | "state" | "version">;

/** from → to is not in LEGAL_TRANSITIONS. Nothing was written. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Illegal order transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** No order has this id. */
export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = "OrderNotFoundError";
  }
}

/**
 * The order is not at (from, expectedVersion) any more: someone else moved it
 * first. Callers reload and decide again; webhook handlers log and drop.
 */
export class StaleOrderError extends Error {
  constructor(
    readonly orderId: string,
    readonly expected: { state: OrderState; version: number },
    readonly actual: { state: OrderState; version: number },
  ) {
    super(
      `Order ${orderId} is ${actual.state} v${actual.version}, expected ${expected.state} v${expected.version}`,
    );
    this.name = "StaleOrderError";
  }
}

/**
 * Moves an order from `from` to `to` if that move is legal and the order is
 * still exactly at (from, expectedVersion). Bumps version by one.
 *
 * Optimistic concurrency: a single conditional UPDATE; zero rows updated
 * means someone else won, and this throws StaleOrderError. `data` is part of
 * that same UPDATE, so it is written only if the transition wins.
 */
export async function transition(
  db: Db,
  orderId: string,
  from: OrderState,
  to: OrderState,
  expectedVersion: number,
  data: TransitionData = {},
): Promise<TransitionResult> {
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
  if (!isUuid(orderId)) throw new OrderNotFoundError(orderId);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new TypeError(`expectedVersion must be a non-negative integer, got ${expectedVersion}`);
  }

  // Given the root client, open a transaction so the update and its outbox row still commit together.
  // (Compared by identity: at runtime a transaction client also has a $transaction method.)
  if (db === prisma) {
    return prisma.$transaction((tx) => transition(tx, orderId, from, to, expectedVersion, data));
  }

  // Drop the reserved keys at runtime too, in case an untyped caller sends them.
  const { id: _id, state: _state, version: _version, ...extra } = data as Prisma.OrderUpdateManyMutationInput;

  const { count } = await db.order.updateMany({
    where: { id: orderId, state: from, version: expectedVersion },
    data: { ...extra, state: to, version: { increment: 1 } },
  });
  if (count === 1) {
    const version = expectedVersion + 1;
    const payload: OrderStateChangedPayload = { from, to, version };
    await enqueueOutbox(db, { topic: ORDER_STATE_CHANGED, orderId, payload });
    return { orderId, state: to, version };
  }

  // Lost the race (or the caller's view was stale). Read only to explain why.
  const current = await db.order.findUnique({ where: { id: orderId }, select: { state: true, version: true } });
  if (!current) throw new OrderNotFoundError(orderId);
  throw new StaleOrderError(orderId, { state: from, version: expectedVersion }, current);
}
