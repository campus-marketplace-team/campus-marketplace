import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { DISPUTE_LIMITS, isTerminalState, LISTING_LIMITS } from '@campus/shared'
import { ApiError } from '../../api/client'
import { Alert, Button, ButtonLink, Card, LoadError, LoadingState } from '../../components'
import { usePoll } from '../../chat/usePoll'
import { Page } from '../../layout/Page'
import { formatPrice } from '../../listings/format'
import {
  describeState,
  disputePhotoProblem,
  disputeReasonLabel,
  formatTimeLeft,
  ORDER_STATE_LABELS,
  RISK_WARNING,
  stateTone,
} from '../../orders/orderStatus'
import { fetchOrder, uploadDisputePhoto, type OrderDispute, type OrderStatus } from '../../orders/ordersApi'
import type { OrderStatusNotice } from './ReportProblemPage'
import './orders.css'
import { RiskReasonList } from '../../checkout/RiskReasons'

// Order status for the buyer and the seller: where the order stands, the
// handoff deadline countdown while the payment is held, the next step (seller
// shows the QR code, buyer scans it or reports a problem), and any report made.
// Polls so each side sees the other's scan or report without reloading.

const POLL_MS = 10_000

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; order: OrderStatus }

export function OrderStatusPage() {
  const { orderId = '' } = useParams()
  // Bumped by "Try again", which remounts the loader.
  const [attempt, setAttempt] = useState(0)
  return (
    <Page title="Order status" width="narrow">
      {/* Keyed so a different order (or a retry) starts fresh (state and polling). */}
      <OrderLoader key={`${orderId}-${attempt}`} orderId={orderId} onRetry={() => setAttempt((n) => n + 1)} />
    </Page>
  )
}

function OrderLoader({ orderId, onRetry }: { orderId: string; onRetry: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  // Nothing changes once an order can't move anymore, so polling stops there.
  const settled = useRef(false)
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (settled.current) return
      try {
        const { order } = await fetchOrder(orderId, signal)
        settled.current = isTerminalState(order.state)
        setState({ status: 'ready', order })
      } catch (err) {
        if (signal.aborted) return
        // Keep showing the last good copy if a later poll fails.
        setState((prev) =>
          prev.status === 'ready'
            ? prev
            : { status: 'error', message: err instanceof ApiError ? err.message : 'Could not load this order.' },
        )
      }
    },
    [orderId],
  )
  usePoll(load, POLL_MS)

  if (state.status === 'loading') return <LoadingState label="Loading the order…" />
  if (state.status === 'error') {
    return (
      <LoadError message={state.message} onRetry={onRetry}>
        <ButtonLink to="/me" variant="ghost" size="sm">
          Back to my stuff
        </ButtonLink>
      </LoadError>
    )
  }
  return (
    <OrderDetails
      order={state.order}
      onDisputeChange={(dispute) =>
        setState((prev) => (prev.status === 'ready' ? { status: 'ready', order: { ...prev.order, dispute } } : prev))
      }
    />
  )
}

function OrderDetails({ order, onDisputeChange }: { order: OrderStatus; onDisputeChange: (dispute: OrderDispute) => void }) {
  const isSeller = order.role === 'seller'
  const other = isSeller ? order.buyer : order.seller
  const photo = order.listing.photoUrls[0]
  const notice = useLocation().state as OrderStatusNotice | null

  return (
    <div className="stack">
      {notice?.reported && <Alert tone="success">Your report was sent. Your payment stays on hold while it's looked into.</Alert>}
      {notice?.photoErrors?.length ? (
        <Alert tone="error">
          {notice.photoErrors.length === 1 ? 'One photo' : `${notice.photoErrors.length} photos`} didn't upload. You can try
          again below:
          <ul className="order-report__errors">
            {notice.photoErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {order.riskWarning && order.state === 'AUTHORIZED' && (
        <Alert tone="error">
          {RISK_WARNING}
          <RiskReasonList reasons={order.riskReasons ?? []} />
        </Alert>
      )}
      <Card>
        <div className="order-status">
          <Link to={`/listings/${order.listing.id}`} className="order-status__item">
            <span className="order-status__photo">{photo && <img src={photo} alt="" />}</span>
            <span className="order-status__info">
              <span className="order-status__title">{order.listing.title}</span>
              <span className="text-muted">
                {formatPrice(order.amountCents, order.currency)} · {isSeller ? 'Buyer' : 'Seller'}: {other.displayName}
              </span>
            </span>
          </Link>
          <div className="order-status__state">
            <span className={`order-badge order-badge--${stateTone(order.state)}`}>{ORDER_STATE_LABELS[order.state]}</span>
            <p className="order-status__explain">{describeState(order.state, order.role)}</p>
          </div>
          {order.state === 'AUTHORIZED' && order.handoffDeadline && (
            <HandoffAction orderId={order.id} isSeller={isSeller} deadline={order.handoffDeadline} />
          )}
        </div>
      </Card>
      {order.dispute && (
        <DisputeDetails orderId={order.id} dispute={order.dispute} isSeller={isSeller} onChange={onDisputeChange} />
      )}
      {/* While disputed, the seller may not get this at all. */}
      {isSeller && order.state !== 'IN_DISPUTE' && (
        <Card title="Your payout">
          <dl className="order-money">
            <dt>Sale price</dt>
            <dd>{formatPrice(order.amountCents, order.currency)}</dd>
            <dt>Platform fee</dt>
            <dd>−{formatPrice(order.platformFeeCents, order.currency)}</dd>
            <dt>You get</dt>
            <dd>{formatPrice(order.amountCents - order.platformFeeCents, order.currency)}</dd>
          </dl>
        </Card>
      )}
      <p className="text-muted order-status__chat">
        Need to arrange the meetup? <Link to={`/listings/${order.listing.id}`}>Message the {isSeller ? 'buyer' : 'seller'}</Link>{' '}
        on the listing page.
      </p>
    </div>
  )
}

/** The report on this order. The buyer can add photos until it starts being decided. */
function DisputeDetails({
  orderId,
  dispute,
  isSeller,
  onChange,
}: {
  orderId: string
  dispute: OrderDispute
  isSeller: boolean
  onChange: (dispute: OrderDispute) => void
}) {
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const room = DISPUTE_LIMITS.photosMax - dispute.photoUrls.length
  const canAddPhotos = !isSeller && dispute.status === 'OPEN' && room > 0
  const reportedOn = new Date(dispute.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  async function addPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // so picking the same file again still fires onChange
    const problems: string[] = files.slice(room).length ? [`You can add ${room} more.`] : []
    const picked = files.slice(0, room)
    for (const [i, file] of picked.entries()) {
      const problem = disputePhotoProblem(file)
      if (problem) {
        problems.push(problem)
        continue
      }
      setProgress(`Uploading photo ${i + 1} of ${picked.length}…`)
      try {
        onChange((await uploadDisputePhoto(orderId, file)).dispute)
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`)
      }
    }
    setProgress(null)
    setError(problems.length ? problems.join(' ') : null)
  }

  return (
    <Card title={isSeller ? 'What the buyer reported' : 'Your report'}>
      <div className="order-report">
        <p className="order-report__reason">{disputeReasonLabel(dispute.reason)}</p>
        <p className="text-muted order-report__date">Reported {reportedOn}</p>
        {dispute.description && <p className="order-report__text">{dispute.description}</p>}
        {dispute.photoUrls.length > 0 && (
          <ul className="order-report__photos">
            {dispute.photoUrls.map((url, i) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt={`Photo ${i + 1} of ${dispute.photoUrls.length} from the report`} />
                </a>
              </li>
            ))}
          </ul>
        )}
        {canAddPhotos && (
          <div>
            <input ref={fileInput} type="file" accept={LISTING_LIMITS.photoTypes.join(',')} multiple hidden onChange={addPhotos} />
            <Button variant="secondary" size="sm" loading={progress !== null} onClick={() => fileInput.current?.click()}>
              {progress ?? 'Add photos'}
            </Button>
          </div>
        )}
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Card>
  )
}

/** The deadline countdown plus the handoff step for this side of the order. */
function HandoffAction({ orderId, isSeller, deadline }: { orderId: string; isSeller: boolean; deadline: string }) {
  const deadlineMs = new Date(deadline).getTime()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])

  const left = deadlineMs - now
  if (left <= 0) {
    // The worker voids it shortly; until then the order still reads AUTHORIZED.
    return (
      <Alert>
        The handoff deadline has passed, so the payment hold will be cancelled.{' '}
        {isSeller ? 'The buyer won’t be charged.' : 'You won’t be charged.'}
      </Alert>
    )
  }

  const deadlineText = new Date(deadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="order-handoff">
      <div className="order-handoff__countdown">
        <span className="order-handoff__time" aria-live="off">
          {formatTimeLeft(left)}
        </span>
        <span className="text-muted">left to meet · by {deadlineText}</span>
      </div>
      {isSeller ? (
        <ButtonLink to={`/orders/${orderId}/handoff`} fullWidth>
          Show QR code
        </ButtonLink>
      ) : (
        <ButtonLink to="/scan" fullWidth>
          Scan seller's QR code
        </ButtonLink>
      )}
      <p className="text-muted order-handoff__hint">
        {isSeller
          ? 'Hand over the item only after the buyer’s scan says the payment went through.'
          : 'Scan only once you have the item and are happy with it. Scanning releases your payment.'}
      </p>
      {!isSeller && (
        <ButtonLink to={`/orders/${orderId}/report`} variant="secondary" fullWidth>
          Report a problem
        </ButtonLink>
      )}
    </div>
  )
}
