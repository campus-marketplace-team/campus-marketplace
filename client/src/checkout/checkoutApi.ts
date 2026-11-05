import type { OrderState } from '@campus/shared'
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
  return api<{ orderId: string; paypalOrderId: string; riskWarning: boolean }>('/api/orders', {
    method: 'POST',
    body: { listingId },
  })
}

/** After the buyer approves in PayPal: the server authorizes and holds the funds. */
export function authorizeOrder(orderId: string) {
  return api<{ order: CheckoutOrder }>(`/api/orders/${encodeURIComponent(orderId)}/authorize`, { method: 'POST' })
}
