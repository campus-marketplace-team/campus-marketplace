import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { isTerminalState } from '@campus/shared'
import { ApiError } from '../../api/client'
import { Alert, ButtonLink, Card } from '../../components'
import { usePoll } from '../../chat/usePoll'
import { Page } from '../../layout/Page'
import { formatPrice } from '../../listings/format'
import { describeState, formatTimeLeft, ORDER_STATE_LABELS, RISK_WARNING, stateTone } from '../../orders/orderStatus'
import { fetchOrder, type OrderStatus } from '../../orders/ordersApi'
import './orders.css'

// Order status for the buyer and the seller: where the order stands, the
// handoff deadline countdown while the payment is held, and the next step
// (seller shows the QR code, buyer scans it). Polls so each side sees the
// other's scan without reloading.

const POLL_MS = 10_000

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; order: OrderStatus }

export function OrderStatusPage() {
  const { orderId = '' } = useParams()
  return (
    <Page title="Order status" width="narrow">
      {/* Keyed so a different order starts fresh (state and polling). */}
      <OrderLoader key={orderId} orderId={orderId} />
    </Page>
  )
}

function OrderLoader({ orderId }: { orderId: string }) {
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

  if (state.status === 'loading') return <p className="text-muted">Loading the order…</p>
  if (state.status === 'error') {
    return (
      <div className="stack">
        <Alert tone="error">{state.message}</Alert>
        <ButtonLink to="/me" variant="secondary">
          Back to my stuff
        </ButtonLink>
      </div>
    )
  }
  return <OrderDetails order={state.order} />
}

function OrderDetails({ order }: { order: OrderStatus }) {
  const isSeller = order.role === 'seller'
  const other = isSeller ? order.buyer : order.seller
  const photo = order.listing.photoUrls[0]

  return (
    <div className="stack">
      {order.riskWarning && order.state === 'AUTHORIZED' && <Alert tone="error">{RISK_WARNING}</Alert>}
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
      {isSeller && (
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
    </div>
  )
}
