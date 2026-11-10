import { useEffect, useRef, useState } from 'react'
import { HANDOFF_WINDOW_HOURS, RISK_HOLD_WINDOW_HOURS } from '@campus/shared'
import { ApiError } from '../api/client'
import { Alert, Card } from '../components'
import type { Listing } from '../listings/listingsApi'
import { RISK_BLOCKED, RISK_WARNING } from '../orders/orderStatus'
import { authorizeOrder, fetchRiskStatus, startCheckout, type CheckoutOrder, type RiskStatus } from './checkoutApi'
import { loadPayPalSdk, PAYPAL_CLIENT_ID, type PayPalButtons } from './paypalSdk'
import { RiskReasonList } from './RiskReasons'
import './checkout.css'

type Props = {
  listing: Listing
  onAuthorized: (order: CheckoutOrder) => void
  /** Changes whenever the chat gets a new message, so a risk result it has moved past is dropped. */
  chatVersion?: string | null
}

const NO_RESULT: RiskStatus = { outcome: null, reasons: [] }

/**
 * PayPal Buttons for buying a listing. createOrder asks our API for a PayPal
 * order; after the buyer approves, onApprove asks our API to authorize it.
 * Funds are held, not taken, until the handoff QR scan.
 *
 * The risk result shown always comes from the server: on load, after each new
 * chat message, and from each Pay click. A block hides the buttons for good
 * (it sticks on the server); a warning disappears once the chat or listing
 * changes, and the next Pay click checks again.
 */
export function PayPalCheckout({ listing, onAuthorized, chatVersion = null }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const orderId = useRef<string | null>(null)
  // Set when our API explained the failure, so PayPal's generic onError doesn't overwrite it.
  const explained = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // null until the first answer, so the buttons don't flash up for a blocked buyer.
  const [risk, setRisk] = useState<RiskStatus | null>(null)
  // Bumped by every risk update, so an older answer arriving late can't overwrite a newer one.
  const riskSeq = useRef(0)
  const blocked = risk?.outcome === 'BLOCKED'
  const warning = risk?.outcome === 'HOLD_WITH_WARNING'

  // Latest callback without re-rendering the buttons when the parent re-renders.
  const onAuthorizedRef = useRef(onAuthorized)
  useEffect(() => {
    onAuthorizedRef.current = onAuthorized
  })

  function refreshRisk(signal?: AbortSignal) {
    const seq = ++riskSeq.current
    return fetchRiskStatus(listing.id, signal)
      .then((next) => {
        if (seq === riskSeq.current) setRisk(next)
      })
      .catch(() => {
        // The server still checks on Pay, so show the buttons rather than nothing.
        if (seq === riskSeq.current && !signal?.aborted) setRisk((prev) => prev ?? NO_RESULT)
      })
  }
  const refreshRiskRef = useRef(refreshRisk)
  useEffect(() => {
    refreshRiskRef.current = refreshRisk
  })

  // On load and after every new chat message.
  useEffect(() => {
    const controller = new AbortController()
    void refreshRiskRef.current(controller.signal)
    return () => controller.abort()
  }, [listing.id, chatVersion])

  const ready = risk !== null
  useEffect(() => {
    if (!PAYPAL_CLIENT_ID || !ready || blocked) return
    let buttons: PayPalButtons | null = null
    let cancelled = false

    function fail(err: unknown, fallback: string) {
      explained.current = true
      setError(err instanceof ApiError ? err.message : fallback)
    }

    loadPayPalSdk(listing.currency)
      .then((paypal) => {
        if (cancelled || !container.current) return
        buttons = paypal.Buttons({
          style: { layout: 'vertical', label: 'pay', height: 45 },
          async createOrder() {
            setError(null)
            setNotice(null)
            explained.current = false
            const seq = ++riskSeq.current
            try {
              const res = await startCheckout(listing.id)
              orderId.current = res.orderId
              if (seq === riskSeq.current) {
                setRisk({ outcome: res.riskWarning ? 'HOLD_WITH_WARNING' : 'NORMAL', reasons: res.riskReasons ?? [] })
              }
              return res.paypalOrderId
            } catch (err) {
              if (err instanceof ApiError && err.code === 'RISK_BLOCKED') {
                // Shown by the blocked state below, with its reasons.
                explained.current = true
                void refreshRiskRef.current()
              } else {
                fail(err, 'Could not start checkout. Please try again.')
              }
              throw err
            }
          },
          async onApprove(_data, actions) {
            try {
              const { order } = await authorizeOrder(orderId.current!)
              onAuthorizedRef.current(order)
            } catch (err) {
              // PayPal's recommended recovery: reopen the popup to pick another funding source.
              if (err instanceof ApiError && err.code === 'PAYMENT_DECLINED') return actions.restart()
              if (err instanceof ApiError && err.code === 'RISK_BLOCKED') {
                explained.current = true
                void refreshRiskRef.current()
                return
              }
              fail(err, 'Could not confirm your payment. You have not been charged.')
            }
          },
          onCancel() {
            setNotice("Payment cancelled. You haven't been charged.")
          },
          onError() {
            if (!explained.current) setError('PayPal ran into a problem. Please try again.')
          },
        })
        if (!buttons.isEligible()) {
          setStatus('unavailable')
          return
        }
        return buttons.render(container.current).then(() => {
          if (!cancelled) setStatus('ready')
        })
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable')
      })

    return () => {
      cancelled = true
      buttons?.close().catch(() => {})
    }
  }, [listing.id, listing.currency, ready, blocked])

  if (blocked) {
    return (
      <Card title="Buy with PayPal" className="checkout">
        <Alert tone="error">
          {RISK_BLOCKED}
          <RiskReasonList reasons={risk.reasons} />
        </Alert>
      </Card>
    )
  }

  return (
    <Card title="Buy with PayPal" className="checkout">
      <div className="stack">
        <p className="text-muted checkout__explain">
          Your payment is held, not taken. You're only charged when you scan the seller's QR code at the handoff. If you
          don't meet within {warning ? RISK_HOLD_WINDOW_HOURS : HANDOFF_WINDOW_HOURS} hours, the hold is cancelled.
        </p>
        {warning && (
          <Alert tone="error">
            {RISK_WARNING}
            <RiskReasonList reasons={risk.reasons} />
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        {(!PAYPAL_CLIENT_ID || status === 'unavailable') && (
          <Alert tone="error">Payments aren't available right now. Please try again later.</Alert>
        )}
        {PAYPAL_CLIENT_ID && (status === 'loading' || !ready) && <p className="text-muted">Loading PayPal…</p>}
        <div ref={container} className="checkout__buttons" />
      </div>
    </Card>
  )
}
