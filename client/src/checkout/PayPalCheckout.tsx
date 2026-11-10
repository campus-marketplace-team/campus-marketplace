import { useEffect, useRef, useState } from 'react'
import { HANDOFF_WINDOW_HOURS, RISK_HOLD_WINDOW_HOURS } from '@campus/shared'
import { ApiError } from '../api/client'
import { Alert, Button, Card } from '../components'
import type { Listing } from '../listings/listingsApi'
import { RISK_BLOCKED, RISK_WARNING } from '../orders/orderStatus'
import { assessCheckout, authorizeOrder, fetchRiskStatus, startCheckout, type CheckoutOrder, type RiskStatus } from './checkoutApi'
import { loadPayPalSdk, PAYPAL_CLIENT_ID, type PayPalButtons } from './paypalSdk'
import { RiskReasonList } from './RiskReasons'
import './checkout.css'

type Props = {
  listing: Listing
  onAuthorized: (order: CheckoutOrder) => void
  /** Changes whenever the chat gets a new message, so a risk result it has moved past is dropped. */
  chatVersion?: string | null
}

/** A finished check, tagged with what it was made against, so a newer chat message or listing edit drops it. */
type Checked = { outcome: 'NORMAL' | 'HOLD_WITH_WARNING'; reasons: RiskStatus['reasons']; chatVersion: string | null; listingStamp: string }

const listingStamp = (listing: Listing) => `${listing.updatedAt}|${listing.priceCents}|${listing.currency}`

const CHANGED = 'Something changed since your safety check (a new message or a listing edit). Please check again.'

/**
 * Two-step checkout. "Check & buy" runs the server's risk check first, so the
 * buyer reads the result before PayPal opens:
 *   - NORMAL: the PayPal Buttons appear.
 *   - HOLD_WITH_WARNING: the warning and reasons, and the Buttons only once the
 *     buyer ticks that they understand the hold.
 *   - BLOCKED: the blocked message, never the Buttons. A block sticks on the server.
 * A new chat message or listing change hides the Buttons until the buyer checks
 * again. The server enforces all of this too: createOrder and authorize are
 * refused without a current, unblocked check.
 */
export function PayPalCheckout({ listing, onAuthorized, chatVersion = null }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const orderId = useRef<string | null>(null)
  // Set when our API explained the failure, so PayPal's generic onError doesn't overwrite it.
  const explained = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [blocked, setBlocked] = useState<RiskStatus['reasons'] | null>(null)

  const stamp = listingStamp(listing)
  // A result the chat or listing has moved past counts as no result: back to "Check & buy".
  const current = checked && checked.chatVersion === chatVersion && checked.listingStamp === stamp ? checked : null
  const warning = current?.outcome === 'HOLD_WITH_WARNING'
  const showButtons = !blocked && !!current && (!warning || acknowledged)

  // Latest callback without re-rendering the buttons when the parent re-renders.
  const onAuthorizedRef = useRef(onAuthorized)
  useEffect(() => {
    onAuthorizedRef.current = onAuthorized
  })

  // A block from an earlier visit is shown straight away. Anything else waits for "Check & buy".
  useEffect(() => {
    const controller = new AbortController()
    fetchRiskStatus(listing.id, controller.signal)
      .then((res) => {
        if (res.outcome === 'BLOCKED') setBlocked(res.reasons)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [listing.id])

  /** Drops the check, e.g. when the server says it's stale. The buyer sees "Check & buy" again. */
  function resetCheck(message: string | null) {
    setChecked(null)
    setAcknowledged(false)
    setNotice(message)
  }
  const resetCheckRef = useRef(resetCheck)
  useEffect(() => {
    resetCheckRef.current = resetCheck
  })

  /** Shows the block with its reasons, which only the server knows. */
  function showBlocked() {
    explained.current = true
    setChecked(null)
    setBlocked([])
    fetchRiskStatus(listing.id)
      .then((res) => setBlocked(res.reasons))
      .catch(() => {})
  }
  const showBlockedRef = useRef(showBlocked)
  useEffect(() => {
    showBlockedRef.current = showBlocked
  })

  async function check() {
    const madeFor = { chatVersion, listingStamp: stamp }
    setChecking(true)
    setError(null)
    setNotice(null)
    setAcknowledged(false)
    try {
      const res = await assessCheckout(listing.id)
      if (res.outcome === 'BLOCKED') {
        setChecked(null)
        setBlocked(res.reasons)
      } else {
        setChecked({ outcome: res.outcome, reasons: res.reasons, ...madeFor })
      }
    } catch (err) {
      setChecked(null)
      setError(err instanceof ApiError ? err.message : 'Could not run the safety check. Please try again.')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (!PAYPAL_CLIENT_ID || !showButtons) return
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
              // Uses the check above; the server never runs a second one here.
              const res = await startCheckout(listing.id)
              orderId.current = res.orderId
              return res.paypalOrderId
            } catch (err) {
              if (err instanceof ApiError && err.code === 'RISK_BLOCKED') {
                showBlockedRef.current()
              } else if (err instanceof ApiError && err.code === 'NOT_ASSESSED') {
                explained.current = true
                resetCheckRef.current(CHANGED)
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
              if (err instanceof ApiError && err.code === 'RISK_BLOCKED') return showBlockedRef.current()
              if (err instanceof ApiError && err.code === 'NOT_ASSESSED') {
                explained.current = true
                return resetCheckRef.current(`${CHANGED} You haven't been charged.`)
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
      // So showing the Buttons again starts from "Loading PayPal…".
      setStatus('loading')
      buttons?.close().catch(() => {})
    }
  }, [listing.id, listing.currency, showButtons])

  if (blocked) {
    return (
      <Card title="Buy with PayPal" className="checkout">
        <Alert tone="error">
          {RISK_BLOCKED}
          <RiskReasonList reasons={blocked} />
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
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        {!PAYPAL_CLIENT_ID && <Alert tone="error">Payments aren't available right now. Please try again later.</Alert>}

        {PAYPAL_CLIENT_ID && !current && (
          <div className="checkout__check">
            <Button onClick={() => void check()} loading={checking}>
              {checking ? 'Running safety check…' : 'Check & buy'}
            </Button>
            <p className="text-muted checkout__explain">We run a quick safety check on this listing and chat before PayPal opens.</p>
          </div>
        )}

        {warning && (
          <>
            <Alert tone="error">
              {RISK_WARNING}
              <RiskReasonList reasons={current.reasons} />
            </Alert>
            <label className="checkout__ack">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>I understand: my payment stays held until I scan the seller's code with the item.</span>
            </label>
          </>
        )}

        {showButtons && status === 'unavailable' && (
          <Alert tone="error">Payments aren't available right now. Please try again later.</Alert>
        )}
        {showButtons && status === 'loading' && <p className="text-muted">Loading PayPal…</p>}
        {/* Only mounted while the Buttons may show, so hiding them also tears down PayPal's iframe. */}
        {showButtons && <div ref={container} className="checkout__buttons" />}
      </div>
    </Card>
  )
}
