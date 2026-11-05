import { isDisputeReason, LISTING_LIMITS, type DisputeReason, type OrderState } from '@campus/shared'

// What each order state means to people, for the status page and "My orders".

export const ORDER_STATE_LABELS: Record<OrderState, string> = {
  CREATED: 'Awaiting payment',
  BLOCKED: 'Blocked',
  AUTHORIZED: 'Awaiting handoff',
  VOIDED: 'Cancelled',
  IN_DISPUTE: 'In dispute',
  REFUNDED: 'Refunded',
  PARTIAL_REFUND: 'Partly refunded',
  RELEASED: 'Released to seller',
  ESCALATED: 'Under review',
  CAPTURED: 'Paid',
  PAYOUT_PENDING: 'Payout on the way',
  PAID_OUT: 'Complete',
  PAYOUT_RETRY: 'Payout delayed',
}

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  NOT_AS_DESCRIBED: 'Item isn’t as described',
  DAMAGED: 'Item is damaged or doesn’t work',
  WRONG_ITEM: 'Wrong item',
  SELLER_NO_SHOW: 'Seller didn’t show up',
  OTHER: 'Something else',
}

/** A stored reason for people to read. Disputes opened in PayPal carry PayPal's own reasons. */
export function disputeReasonLabel(reason: string): string {
  return isDisputeReason(reason) ? DISPUTE_REASON_LABELS[reason] : 'Reported through PayPal'
}

/** Why a file picked for a report can't be uploaded, or null if it's fine. */
export function disputePhotoProblem(file: File): string | null {
  if (!(LISTING_LIMITS.photoTypes as readonly string[]).includes(file.type)) return `${file.name} isn't a JPEG, PNG or WebP image.`
  const maxBytes = LISTING_LIMITS.photoMaxBytes
  if (file.size > maxBytes) return `${file.name} is over ${maxBytes / (1024 * 1024)} MB.`
  return null
}

/** Shown to the buyer of an order the risk check flagged. Fixed text: the check's reasons are internal. */
export const RISK_WARNING =
  'Our safety checks flagged this order, so you have extra time to meet. Never pay outside the app, and only scan the seller’s code once you have the item and are happy with it.'

/** Badge colour group for a state. */
export function stateTone(state: OrderState): 'waiting' | 'done' | 'problem' {
  switch (state) {
    case 'CAPTURED':
    case 'PAYOUT_PENDING':
    case 'PAID_OUT':
    case 'RELEASED':
      return 'done'
    case 'BLOCKED':
    case 'VOIDED':
    case 'IN_DISPUTE':
    case 'REFUNDED':
    case 'PARTIAL_REFUND':
    case 'ESCALATED':
    case 'PAYOUT_RETRY':
      return 'problem'
    default:
      return 'waiting'
  }
}

/** One sentence on where things stand, from the viewer's side. */
export function describeState(state: OrderState, role: 'buyer' | 'seller'): string {
  const buyer = role === 'buyer'
  switch (state) {
    case 'CREATED':
      return buyer ? "You haven't finished paying in PayPal yet." : "The buyer hasn't finished paying yet."
    case 'BLOCKED':
      return 'This order was blocked by our safety checks. No money was taken.'
    case 'AUTHORIZED':
      return buyer
        ? "Your payment is held, not taken. You're charged when you scan the seller's QR code at the handoff."
        : "The buyer's payment is held. Show them your QR code when you hand over the item to get paid."
    case 'VOIDED':
      return buyer
        ? "The handoff didn't happen in time, so the hold was cancelled. You weren't charged."
        : "The handoff didn't happen in time, so the buyer's hold was cancelled."
    case 'IN_DISPUTE':
      return 'A problem was reported. The payment stays on hold while it is looked into.'
    case 'REFUNDED':
      return buyer ? 'You were refunded in full.' : 'The buyer was refunded in full.'
    case 'PARTIAL_REFUND':
      return buyer ? 'You were refunded part of the payment.' : 'The buyer was refunded part of the payment.'
    case 'RELEASED':
      return 'The dispute was resolved in favour of the seller.'
    case 'ESCALATED':
      return 'The dispute was passed to a person for review.'
    case 'CAPTURED':
      return buyer ? 'Payment complete. Enjoy!' : "Payment complete. Your payout will be sent to PayPal soon."
    case 'PAYOUT_PENDING':
      return buyer ? 'Payment complete. Enjoy!' : 'Your payout is on its way to your PayPal account.'
    case 'PAID_OUT':
      return buyer ? 'Payment complete. Enjoy!' : 'Your payout was sent to your PayPal account.'
    case 'PAYOUT_RETRY':
      return buyer ? 'Payment complete. Enjoy!' : "Your payout didn't go through yet. We'll try again."
  }
}

/** Time left as "2d 5h", "3h 12m" or "4:05" (under an hour), counting down to zero. */
export function formatTimeLeft(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
