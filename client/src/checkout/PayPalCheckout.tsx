import { useEffect, useRef, useState } from 'react'
import { HANDOFF_WINDOW_HOURS, RISK_HOLD_WINDOW_HOURS } from '@campus/shared'
import { ApiError } from '../api/client'
import { Alert, Card } from '../components'
import type { Listing } from '../listings/listingsApi'
import { RISK_WARNING } from '../orders/orderStatus'
import { authorizeOrder, startCheckout, type CheckoutOrder } from './checkoutApi'
import { loadPayPalSdk, PAYPAL_CLIENT_ID, type PayPalButtons } from './paypalSdk'
import './checkout.css'

type Props = { listing: Listing; onAuthorized: (order: CheckoutOrder) => void }

/**
 * PayPal Buttons for buying a listing. createOrder asks our API for a PayPal
 * order; after the buyer approves, onApprove asks our API to authorize it.
 * Funds are held, not taken, until the handoff QR scan.
 */
export function PayPalCheckout({ listing, onAuthorized }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const orderId = useRef<string | null>(null)
  // Set when our API explained the failure, so PayPal's generic onError doesn't overwrite it.
  const explained = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [riskWarning, setRiskWarning] = useState(false)

  // Latest callback without re-rendering the buttons when the parent re-renders.
  const onAuthorizedRef = useRef(onAuthorized)
  useEffect(() => {
    onAuthorizedRef.current = onAuthorized
  })

  useEffect(() => {
    if (!PAYPAL_CLIENT_ID) return
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
            try {
              const res = await startCheckout(listing.id)
              orderId.current = res.orderId
              setRiskWarning(res.riskWarning)
              return res.paypalOrderId
            } catch (err) {
              fail(err, 'Could not start checkout. Please try again.')
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
  }, [listing.id, listing.currency])

  return (
    <Card title="Buy with PayPal" className="checkout">
      <div className="stack">
        <p className="text-muted checkout__explain">
          Your payment is held, not taken. You're only charged when you scan the seller's QR code at the handoff. If you
          don't meet within {riskWarning ? RISK_HOLD_WINDOW_HOURS : HANDOFF_WINDOW_HOURS} hours, the hold is cancelled.
        </p>
        {riskWarning && <Alert tone="error">{RISK_WARNING}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        {(!PAYPAL_CLIENT_ID || status === 'unavailable') && (
          <Alert tone="error">Payments aren't available right now. Please try again later.</Alert>
        )}
        {PAYPAL_CLIENT_ID && status === 'loading' && <p className="text-muted">Loading PayPal…</p>}
        <div ref={container} className="checkout__buttons" />
      </div>
    </Card>
  )
}
