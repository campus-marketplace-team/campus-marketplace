import type { OrderState } from '@campus/shared'
import { api } from '../api/client'

// Mirrors GET /api/admin/dashboard (server/src/admin/dashboard.ts). Dates arrive as ISO strings.

/** Ledger totals in cents: held = escrow_held, captured = seller_payable + platform_fees + paid_out. */
export type MoneyTotals = {
  held: number
  captured: number
  paidOut: number
  sellerPayable: number
  platformFees: number
}

export type AdminOrder = {
  id: string
  state: OrderState
  amountCents: number
  platformFeeCents: number
  currency: string
  createdAt: string
  updatedAt: string
  handoffDeadline: string | null
  payoutAttempts: number
  payoutLastError: string | null
  listingTitle: string
  buyer: string
  seller: string
  ledger: MoneyTotals
}

export type ReconciliationFlag = {
  id: string
  orderId: string
  kind: string
  status: 'OPEN' | 'RESOLVED'
  message: string
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  orderState: OrderState
}

export type DeadLetter = {
  id: string
  orderId: string | null
  topic: string
  attempts: number
  lastError: string | null
  payload: string
  createdAt: string
}

export type AdminDashboard = {
  generatedAt: string
  money: MoneyTotals
  ordersByState: { state: OrderState; count: number }[]
  orders: AdminOrder[]
  orderCount: number
  flags: ReconciliationFlag[]
  openFlagCount: number
  deadLetters: DeadLetter[]
  deadLetterCount: number
}

export function fetchAdminDashboard(signal?: AbortSignal) {
  return api<AdminDashboard>('/api/admin/dashboard', { signal })
}
