import type { RiskHardRule, OrderState } from '@campus/shared'
import { api } from '../api/client'

// Mirrors the server's checkout shapes (server/src/orders/checkout.ts).
export type CheckoutOrder = {
  id: string
  listingId: string
  state: OrderState
  version: number
  amountCents: number
  currency: string
  paypalOrderId: string | null
  authorizedAt: string | null
  handoffDeadline: string | null
  capturedAt: string | null
}

/**
 * Step 2, from the PayPal Buttons' createOrder: my order's PayPal order. Uses the check from
 * assessCheckout; refused with NOT_ASSESSED if there's none or it's stale, RISK_BLOCKED if blocked.
 */
export function startCheckout(listingId: string) {
  return api<{ orderId: string; paypalOrderId: string; riskWarning: boolean; riskReasons: RiskHardRule[] }>('/api/orders', {
    method: 'POST',
    body: { listingId },
  })
}

export type RiskOutcome = 'NORMAL' | 'HOLD_WITH_WARNING' | 'BLOCKED'
export type RiskStatus = { outcome: RiskOutcome | null; reasons: RiskHardRule[] }

/** Step 1, "Check & buy": runs (or reuses) the risk check on my order for this listing. */
export function assessCheckout(listingId: string) {
  return api<{ outcome: RiskOutcome; reasons: RiskHardRule[] }>('/api/orders/assess', {
    method: 'POST',
    body: { listingId },
  })
}

/**
 * The risk result for me on a listing. A block sticks; anything else is null once the
 * chat or listing changed since it was made (I have to check again).
 */
export function fetchRiskStatus(listingId: string, signal?: AbortSignal) {
  return api<RiskStatus>(`/api/orders/risk?listingId=${encodeURIComponent(listingId)}`, { signal })
}

/** After the buyer approves in PayPal: the server authorizes and holds the funds. */
export function authorizeOrder(orderId: string) {
  return api<{ order: CheckoutOrder }>(`/api/orders/${encodeURIComponent(orderId)}/authorize`, { method: 'POST' })
}
