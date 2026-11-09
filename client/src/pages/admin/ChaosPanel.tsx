import { useMemo, useState } from 'react'
import { ApiError } from '../../api/client'
import { type AdminOrder, type ChaosResult, type ChaosScenario, runChaos } from '../../admin/adminApi'
import { Alert, Button, Select } from '../../components'
import { formatPrice } from '../../listings/format'
import { ORDER_STATE_LABELS } from '../../orders/orderStatus'

// Chaos buttons (server/src/admin/chaos.ts): trigger a failure on one order and
// show, step by step, what the system did about it. Only shown while the API
// uses the PayPal sandbox; the server refuses them otherwise anyway.

type Scenario = {
  id: ChaosScenario
  title: string
  what: string
  /** Asked before running, for scenarios that move (sandbox) money. */
  confirm?: string
  /** Why it can't run on this order, or null. */
  unavailable: (order: AdminOrder) => string | null
}

const needsAuthorized = (order: AdminOrder) => (order.state === 'AUTHORIZED' ? null : 'Needs an order waiting for its handoff')

const SCENARIOS: Scenario[] = [
  {
    id: 'duplicate-webhook',
    title: 'Duplicate webhook',
    what: "Redelivers the order's latest PayPal webhook 3 times at once. Dedupe on event_id should store none of them, and nothing about the order should change.",
    unavailable: (order) => (order.state === 'CREATED' || order.state === 'BLOCKED' ? "PayPal hasn't sent webhooks for this order" : null),
  },
  {
    id: 'capture-timeout',
    title: 'Capture timeout',
    what: "Captures at PayPal but drops the answer, as if it timed out. The retry reuses the PayPal-Request-Id, so PayPal replays the first capture: one charge, recorded once.",
    confirm: 'This captures the order in the PayPal sandbox and marks the listing sold, skipping the QR scan. Continue?',
    unavailable: (order) =>
      needsAuthorized(order) ??
      (order.handoffDeadline && new Date(order.handoffDeadline) <= new Date() ? 'The handoff deadline has passed' : null),
  },
  {
    id: 'expire-deadline',
    title: 'Expired deadline',
    what: 'Moves the 72-hour handoff deadline into the past and runs the deadline sweeper now. QR codes are refused and the hold is voided, so the buyer is never charged.',
    confirm: 'This voids the order in the PayPal sandbox and puts the listing back on sale. Continue?',
    unavailable: needsAuthorized,
  },
]

function orderLabel(o: AdminOrder) {
  return `${ORDER_STATE_LABELS[o.state]} · ${o.listingTitle} · ${formatPrice(o.amountCents)} · ${o.id.slice(0, 8)}`
}

export function ChaosPanel({ orders, onChanged }: { orders: AdminOrder[]; onChanged: () => void }) {
  // Orders that can take every scenario first.
  const options = useMemo(
    () => [...orders].sort((a, b) => Number(b.state === 'AUTHORIZED') - Number(a.state === 'AUTHORIZED')),
    [orders],
  )
  const [picked, setPicked] = useState<string>('')
  const order = options.find((o) => o.id === picked) ?? options[0]
  const [busy, setBusy] = useState<ChaosScenario | null>(null)
  const [result, setResult] = useState<ChaosResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(scenario: Scenario) {
    if (!order) return
    if (scenario.confirm && !window.confirm(scenario.confirm)) return
    setBusy(scenario.id)
    setResult(null)
    setError(null)
    try {
      setResult(await runChaos(scenario.id, order.id))
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="chaos-heading">
      <h2 id="chaos-heading" className="admin__heading">
        Chaos buttons <span className="admin__count">PayPal sandbox</span>
      </h2>
      <p className="text-muted admin__hint">Trigger a failure on a real sandbox order and watch what the system does about it.</p>
      {options.length === 0 ? (
        <p className="text-muted">No orders yet.</p>
      ) : (
        <div className="chaos">
          <Select
            label="Order"
            value={order?.id ?? ''}
            options={options.map((o) => ({ value: o.id, label: orderLabel(o) }))}
            onChange={(e) => {
              setPicked(e.target.value)
              setResult(null)
              setError(null)
            }}
          />
          <ul className="chaos__scenarios">
            {SCENARIOS.map((s) => {
              const unavailable = order ? s.unavailable(order) : 'Pick an order'
              return (
                <li key={s.id} className="dispute-card">
                  <p className="dispute-card__action">
                    <strong>{s.title}</strong>
                  </p>
                  <p className="dispute-card__meta">{s.what}</p>
                  {unavailable && <p className="text-muted dispute-card__meta">{unavailable}.</p>}
                  <div className="dispute-card__buttons">
                    <Button size="sm" variant="danger" disabled={busy !== null || unavailable !== null} loading={busy === s.id} onClick={() => void run(s)}>
                      Run
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
          {error && <Alert tone="error">{error}</Alert>}
          {result && (
            <div className="dispute-card" role="status">
              <p className="dispute-card__action">
                <strong>{SCENARIOS.find((s) => s.id === result.scenario)?.title}</strong> on order{' '}
                <span title={result.orderId}>{result.orderId.slice(0, 8)}</span>: now {ORDER_STATE_LABELS[result.order.state]}
              </p>
              <ol className="chaos__steps">
                {result.steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.label}.</strong> <span className="text-muted">{step.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
