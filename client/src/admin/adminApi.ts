import type { DisputeAction, OrderState } from '@campus/shared'
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

export type DisputeOrder = {
  id: string
  amountCents: number
  platformFeeCents: number
  currency: string
  listingTitle: string
  buyer: string
  seller: string
}

/** A dispute agent decision waiting for an admin. Reasoning and evidence can quote untrusted text. */
export type PendingDisputeDecision = {
  id: string
  outcome: DisputeAction
  amountCents: number | null
  reasoning: string | null
  evidence: { source: string; detail: string }[] | null
  model: string | null
  createdAt: string
  order: DisputeOrder
}

export type EscalatedDispute = {
  id: string
  reason: string
  description: string | null
  createdAt: string
  order: DisputeOrder
}

/** Where a decision ended up after approving or deciding it. APPROVED means PayPal's answer is unknown and the worker is retrying. */
export type DisputeDecisionResult = {
  id: string
  actionStatus: 'PENDING_APPROVAL' | 'APPROVED' | 'EXECUTED' | 'REJECTED' | 'FAILED'
  actionError: string | null
  paypalTransactionId: string | null
}

export type AdminDashboard = {
  pendingDisputeDecisions: PendingDisputeDecision[]
  escalatedDisputes: EscalatedDispute[]
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

type DecisionResponse = { decision: DisputeDecisionResult }

export function approveDisputeDecision(id: string) {
  return api<DecisionResponse>(`/api/admin/dispute-decisions/${id}/approve`, { method: 'POST' })
}

export function rejectDisputeDecision(id: string) {
  return api<DecisionResponse>(`/api/admin/dispute-decisions/${id}/reject`, { method: 'POST', body: {} })
}

export function resolveEscalatedDispute(orderId: string, body: { action: 'REFUND' | 'PARTIAL_REFUND' | 'RELEASE'; refundCents?: number; reasoning: string }) {
  return api<DecisionResponse>(`/api/admin/disputes/${orderId}/resolve`, { method: 'POST', body })
}
