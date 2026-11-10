import type { DisputeReason, RiskHardRule } from '@campus/shared'
import { api } from '../api/client'
import type { CheckoutOrder } from '../checkout/checkoutApi'

// Mirrors the server's order status endpoints (server/src/orders/orderStatus.ts).
export type OrderStatus = CheckoutOrder & {
  role: 'buyer' | 'seller'
  platformFeeCents: number
  createdAt: string
  listing: { id: string; title: string; photoUrls: string[] }
  buyer: { displayName: string }
  seller: { displayName: string }
  /** Single-order view only, and only for the buyer. */
  riskWarning?: boolean
  /** Hard rules behind the warning, shown with their fixed labels. */
  riskReasons?: RiskHardRule[]
  /** Single-order view only. Null if no problem was reported. */
  dispute?: OrderDispute | null
}

export type OrderDispute = {
  /** One of DISPUTE_REASONS, or PAYPAL_<reason> for a dispute opened in PayPal. */
  reason: string
  description: string | null
  photoUrls: string[]
  status: 'OPEN' | 'PENDING_APPROVAL' | 'RESOLVED' | 'ESCALATED'
  createdAt: string
}

/** One of my orders (as buyer or seller). */
export function fetchOrder(orderId: string, signal?: AbortSignal) {
  return api<{ order: OrderStatus }>(`/api/orders/${encodeURIComponent(orderId)}`, { signal })
}

/** Buyer reports a problem: the order moves to IN_DISPUTE. */
export function openDispute(orderId: string, input: { reason: DisputeReason; description: string }) {
  return api<{ dispute: OrderDispute }>(`/api/orders/${encodeURIComponent(orderId)}/dispute`, { method: 'POST', body: input })
}

/** Adds one photo to the buyer's open report. */
export function uploadDisputePhoto(orderId: string, photo: File) {
  return api<{ dispute: OrderDispute }>(`/api/orders/${encodeURIComponent(orderId)}/dispute/photos`, { method: 'POST', body: photo })
}

/** Orders I bought or sold, newest first. */
export function fetchMyOrders(signal?: AbortSignal) {
  return api<{ orders: OrderStatus[] }>('/api/orders', { signal })
}
