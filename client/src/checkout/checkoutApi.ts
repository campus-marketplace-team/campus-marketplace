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

/** Creates (or reuses) my order for this listing and its PayPal order, unless the risk check blocks it. */
export function startCheckout(listingId: string) {
  return api<{ orderId: string; paypalOrderId: string; riskWarning: boolean; riskReasons: RiskHardRule[] }>('/api/orders', {
    method: 'POST',
    body: { listingId },
  })
}

export type RiskOutcome = 'NORMAL' | 'HOLD_WITH_WARNING' | 'BLOCKED'
export type RiskStatus = { outcome: RiskOutcome | null; reasons: RiskHardRule[] }

/**
 * The risk result to show me on a listing before I pay. A block sticks; a warning is
 * null once the chat or listing changed since it was made (the next Pay click re-checks).
 */
export function fetchRiskStatus(listingId: string, signal?: AbortSignal) {
  return api<RiskStatus>(`/api/orders/risk?listingId=${encodeURIComponent(listingId)}`, { signal })
}

/** After the buyer approves in PayPal: the server authorizes and holds the funds. */
export function authorizeOrder(orderId: string) {
  return api<{ order: CheckoutOrder }>(`/api/orders/${encodeURIComponent(orderId)}/authorize`, { method: 'POST' })
}
