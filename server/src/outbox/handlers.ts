import { isOrderState, type OrderState } from "@campus/shared";
import { prisma } from "../db.js";
import type { OutboxEvent, OutboxHandlers } from "./outbox.js";

// Side effects the worker's outbox relay delivers, by topic. Each runs at
// least once per row, so each must be idempotent.

/** Written by transition() in the same transaction as every order state change. */
export const ORDER_STATE_CHANGED = "order.state_changed";

export type OrderStateChangedPayload = { from: OrderState; to: OrderState; version: number };

/** What the buyer and the seller are told when an order reaches a state. States not listed send nothing. */
const STATE_MESSAGES: Partial<Record<OrderState, { buyer: string; seller: string }>> = {
  AUTHORIZED: {
    buyer: "Your payment is on hold, not charged yet. Meet the seller within 72 hours and scan their handoff code.",
    seller: "Your item has a buyer. Meet within 72 hours and show them the handoff code on the order page.",
  },
  CAPTURED: {
    buyer: "Handoff confirmed. Your payment is complete.",
    seller: "Handoff confirmed. The buyer's payment was taken and your payout is on the way.",
  },
  VOIDED: {
    buyer: "Your order was cancelled. You haven't been charged.",
    seller: "An order was cancelled. Your listing is back on sale.",
  },
};

/** Notification kind for an order reaching `state`, e.g. ORDER_VOIDED (the same kind the deadline job writes). */
export function stateNotificationKind(state: OrderState) {
  return `ORDER_${state}`;
}

function parseStateChanged(payload: OutboxEvent["payload"]): OrderStateChangedPayload {
  const p = payload as Partial<Record<keyof OrderStateChangedPayload, unknown>> | null;
  if (!p || typeof p !== "object" || !isOrderState(p.from) || !isOrderState(p.to) || !Number.isInteger(p.version)) {
    throw new Error("malformed order.state_changed payload");
  }
  return { from: p.from, to: p.to, version: p.version as number };
}

/**
 * Notifies the buyer and the seller. Idempotent: notifications are unique per
 * (user, order, kind), so a repeat (or a notification the writer already
 * created in its own transaction, like the deadline job's ORDER_VOIDED) is skipped.
 */
export async function notifyOrderStateChanged(event: OutboxEvent) {
  const { to } = parseStateChanged(event.payload);
  const messages = STATE_MESSAGES[to];
  if (!messages || !event.orderId) return;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    select: { id: true, buyerId: true, sellerId: true },
  });
  if (!order) return; // deleted since; nobody to tell

  const kind = stateNotificationKind(to);
  await prisma.notification.createMany({
    data: [
      { userId: order.buyerId, orderId: order.id, kind, message: messages.buyer },
      { userId: order.sellerId, orderId: order.id, kind, message: messages.seller },
    ],
    skipDuplicates: true,
  });
}

export const outboxHandlers: OutboxHandlers = {
  [ORDER_STATE_CHANGED]: notifyOrderStateChanged,
};
