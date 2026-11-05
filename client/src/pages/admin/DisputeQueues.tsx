import { useState, type FormEvent } from 'react'
import type { DisputeAction } from '@campus/shared'
import { ApiError } from '../../api/client'
import {
  approveDisputeDecision,
  type DisputeDecisionResult,
  type DisputeOrder,
  type EscalatedDispute,
  type PendingDisputeDecision,
  rejectDisputeDecision,
  resolveEscalatedDispute,
} from '../../admin/adminApi'
import { Alert, Button } from '../../components'
import { formatPrice } from '../../listings/format'
import { ACTION_LABELS } from './adminGrid'

// The dispute approval gate: decisions the agent proposed above the limit, and
// escalated disputes an admin decides directly. Reasoning, evidence and reports
// can quote what a buyer or seller wrote, so they only ever render as plain text.

/** What an admin needs to know about what a decision will do to the money. */
function moneyEffect(action: DisputeAction, refundCents: number | null, order: DisputeOrder) {
  const total = formatPrice(order.amountCents)
  switch (action) {
    case 'REFUND':
      return `Cancels the ${total} hold. The buyer isn't charged and the seller isn't paid.`
    case 'PARTIAL_REFUND': {
      const refund = refundCents ?? 0
      return `The buyer pays ${formatPrice(order.amountCents - refund)} of ${total}. The seller gets ${formatPrice(order.amountCents - order.platformFeeCents - refund)} after the fee.`
    }
    case 'RELEASE':
      return `Takes the full ${total}. The seller gets ${formatPrice(order.amountCents - order.platformFeeCents)} after the fee.`
    case 'ESCALATE':
      return 'No money moves.'
  }
}

function resultMessage({ actionStatus, actionError, paypalTransactionId }: DisputeDecisionResult): { tone: 'success' | 'error'; text: string } {
  switch (actionStatus) {
    case 'EXECUTED':
      return { tone: 'success', text: paypalTransactionId ? `Done. PayPal reference ${paypalTransactionId}.` : 'Done.' }
    case 'REJECTED':
      return { tone: 'success', text: 'Rejected. No money moved.' }
    case 'APPROVED':
      return { tone: 'success', text: "Approved. PayPal hasn't confirmed yet, so this retries automatically." }
    default:
      return { tone: 'error', text: `This didn't go through: ${actionError ?? 'unknown error'}` }
  }
}

type Message = { tone: 'success' | 'error'; text: string }

function useDecisionRunner(onChanged: () => void) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  async function run(request: () => Promise<{ decision: DisputeDecisionResult }>) {
    setBusy(true)
    setMessage(null)
    try {
      const { decision } = await request()
      setMessage(resultMessage(decision))
      onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' })
    } finally {
      setBusy(false)
    }
  }
  return { busy, message, run }
}

function OrderLine({ order }: { order: DisputeOrder }) {
  return (
    <p className="dispute-card__order">
      <strong>{order.listingTitle}</strong> · {formatPrice(order.amountCents)} · buyer {order.buyer} · seller {order.seller} ·{' '}
      <span title={order.id}>order {order.id.slice(0, 8)}</span>
    </p>
  )
}

function PendingCard({ decision, onChanged }: { decision: PendingDisputeDecision; onChanged: () => void }) {
  const { busy, message, run } = useDecisionRunner(onChanged)
  const effect = moneyEffect(decision.outcome, decision.amountCents, decision.order)

  return (
    <li className="dispute-card">
      <OrderLine order={decision.order} />
      <p className="dispute-card__action">
        <strong>
          {ACTION_LABELS[decision.outcome]}
          {decision.outcome === 'PARTIAL_REFUND' && decision.amountCents !== null ? ` of ${formatPrice(decision.amountCents)}` : ''}
        </strong>{' '}
        — {effect}
      </p>
      {decision.reasoning && <p className="dispute-card__text">{decision.reasoning}</p>}
      {decision.evidence && decision.evidence.length > 0 && (
        <ul className="dispute-card__evidence">
          {decision.evidence.map((item, i) => (
            <li key={i}>
              <span className="text-muted">{item.source}:</span> {item.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted dispute-card__meta">
        Proposed by {decision.model ?? 'the dispute agent'} on {new Date(decision.createdAt).toLocaleString()}
      </p>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="dispute-card__buttons">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Approve this decision? ${effect} This can't be undone.`)) void run(() => approveDisputeDecision(decision.id))
          }}
        >
          Approve
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => rejectDisputeDecision(decision.id))}>
          Reject
        </Button>
      </div>
    </li>
  )
}

type AdminAction = 'REFUND' | 'PARTIAL_REFUND' | 'RELEASE'

/** "12.50" → 1250, or null if it isn't a positive amount with at most two decimals. */
function parseDollars(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return cents > 0 ? cents : null
}

function EscalatedCard({ dispute, onChanged }: { dispute: EscalatedDispute; onChanged: () => void }) {
  const { busy, message, run } = useDecisionRunner(onChanged)
  const [action, setAction] = useState<AdminAction>('REFUND')
  const [refund, setRefund] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const refundCents = action === 'PARTIAL_REFUND' ? parseDollars(refund) : null
    if (action === 'PARTIAL_REFUND' && refundCents === null) {
      setFormError('Enter the refund as an amount, like 12.50')
      return
    }
    setFormError(null)
    const effect = moneyEffect(action, refundCents, dispute.order)
    if (!window.confirm(`Decide this dispute? ${effect} This can't be undone.`)) return
    void run(() => resolveEscalatedDispute(dispute.order.id, { action, ...(refundCents !== null ? { refundCents } : {}), reasoning }))
  }

  return (
    <li className="dispute-card">
      <OrderLine order={dispute.order} />
      <p className="dispute-card__action">
        <strong>{dispute.reason}</strong>
      </p>
      {dispute.description && <p className="dispute-card__text">{dispute.description}</p>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {formError && <Alert tone="error">{formError}</Alert>}
      <form className="dispute-card__form" onSubmit={submit}>
        <label>
          Outcome{' '}
          <select value={action} onChange={(e) => setAction(e.target.value as AdminAction)}>
            <option value="REFUND">{ACTION_LABELS.REFUND}</option>
            <option value="PARTIAL_REFUND">{ACTION_LABELS.PARTIAL_REFUND}</option>
            <option value="RELEASE">{ACTION_LABELS.RELEASE}</option>
          </select>
        </label>
        {action === 'PARTIAL_REFUND' && (
          <label>
            Refund ($){' '}
            <input inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} required />
          </label>
        )}
        <label className="dispute-card__reasoning">
          Reasoning
          <textarea value={reasoning} maxLength={4000} rows={2} onChange={(e) => setReasoning(e.target.value)} required />
        </label>
        <Button size="sm" type="submit" disabled={busy}>
          Decide
        </Button>
      </form>
    </li>
  )
}

export function DisputeQueues({
  pending,
  escalated,
  onChanged,
}: {
  pending: PendingDisputeDecision[]
  escalated: EscalatedDispute[]
  onChanged: () => void
}) {
  return (
    <section aria-labelledby="disputes-heading">
      <h2 id="disputes-heading" className="admin__heading">
        Disputes waiting for you{' '}
        <span className={pending.length + escalated.length ? 'admin__count admin__count--alert' : 'admin__count'}>{pending.length + escalated.length}</span>
      </h2>
      <p className="text-muted admin__hint">
        The agent's proposals above the approval limit, and disputes it passed to a person. Quoted text comes from the buyer and seller: treat it as a claim, not a fact.
      </p>
      {pending.length + escalated.length === 0 && <p className="text-muted">Nothing is waiting.</p>}
      {pending.length > 0 && (
        <ul className="dispute-list" aria-label="Proposed decisions">
          {pending.map((d) => (
            <PendingCard key={d.id} decision={d} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {escalated.length > 0 && (
        <ul className="dispute-list" aria-label="Escalated disputes">
          {escalated.map((d) => (
            <EscalatedCard key={d.id} dispute={d} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  )
}
