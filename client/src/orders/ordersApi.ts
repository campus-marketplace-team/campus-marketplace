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
}

/** One of my orders (as buyer or seller). */
export function fetchOrder(orderId: string, signal?: AbortSignal) {
  return api<{ order: OrderStatus }>(`/api/orders/${encodeURIComponent(orderId)}`, { signal })
}

/** Orders I bought or sold, newest first. */
export function fetchMyOrders(signal?: AbortSignal) {
  return api<{ orders: OrderStatus[] }>('/api/orders', { signal })
}
