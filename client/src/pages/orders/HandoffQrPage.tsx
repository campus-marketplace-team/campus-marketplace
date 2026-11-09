import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { Alert, Button, ButtonLink, Card, LoadError, LoadingState, Textarea } from '../../components'
import { fetchHandoffToken } from '../../handoff/handoffApi'
import { Page } from '../../layout/Page'
import './handoff.css'

// Seller's side of the handoff: a QR code the buyer scans to release the
// payment. Each code works once and expires after a few minutes, so a fresh
// one is fetched shortly before it runs out. "Copy code" gives the same token
// as text, for the buyer's paste fallback when their camera can't scan.

const REFRESH_BEFORE_EXPIRY_MS = 30_000
const COPIED_FEEDBACK_MS = 2000

type State =
  | { status: 'loading' }
  | { status: 'ready'; token: string; qr: string; expiresAt: number }
  | { status: 'closed'; message: string }
  | { status: 'error'; message: string }

/** Fetches a fresh token and renders it as a QR image (qrcode is loaded on first use). */
async function loadCode(orderId: string): Promise<State> {
  try {
    const [{ token, expiresAt }, { default: QRCode }] = await Promise.all([fetchHandoffToken(orderId), import('qrcode')])
    const qr = await QRCode.toDataURL(token, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
    return { status: 'ready', token, qr, expiresAt: new Date(expiresAt).getTime() }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'HANDOFF_EXPIRED') {
      return { status: 'closed', message: "The handoff deadline has passed, so the buyer's payment hold will be cancelled." }
    }
    if (err instanceof ApiError && err.code === 'ORDER_NOT_AUTHORIZED') {
      return {
        status: 'closed',
        message: "This order isn't waiting for a handoff anymore. If the buyer just scanned, the payment is complete.",
      }
    }
    return { status: 'error', message: err instanceof ApiError ? err.message : 'Could not load the QR code.' }
  }
}

export function HandoffQrPage() {
  const { orderId = '' } = useParams()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(() => loadCode(orderId).then(setState), [orderId])

  useEffect(() => {
    let cancelled = false
    void loadCode(orderId).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [orderId])

  // Countdown, plus a fresh code shortly before this one expires.
  const expiresAt = state.status === 'ready' ? state.expiresAt : null
  useEffect(() => {
    if (expiresAt === null) return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const refresh = window.setTimeout(() => void load(), Math.max(expiresAt - Date.now() - REFRESH_BEFORE_EXPIRY_MS, 5000))
    // Background tabs throttle timers; catch up when the seller comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && expiresAt - Date.now() < REFRESH_BEFORE_EXPIRY_MS) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [expiresAt, load])

  const secondsLeft = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000))

  // Which token the last copy was for, so a refreshed code doesn't show "Copied" or the fallback field.
  const [copy, setCopy] = useState<{ token: string; result: 'copied' | 'failed' } | null>(null)
  const token = state.status === 'ready' ? state.token : null
  const copyResult = copy && copy.token === token ? copy.result : null

  async function copyCode(value: string) {
    try {
      // Needs a secure context (HTTPS or localhost) and may be refused by the browser.
      await navigator.clipboard.writeText(value)
      setCopy({ token: value, result: 'copied' })
      window.setTimeout(() => setCopy((c) => (c?.token === value && c.result === 'copied' ? null : c)), COPIED_FEEDBACK_MS)
    } catch {
      setCopy({ token: value, result: 'failed' })
    }
  }

  return (
    <Page title="Handoff QR code" description="Show this to the buyer when you hand over the item." width="narrow">
      <Card>
        <div className="stack handoff">
          {state.status === 'loading' && <LoadingState label="Getting a code…" />}
          {state.status === 'error' && (
            <LoadError message={state.message} onRetry={() => void load()}>
              <ButtonLink to={`/orders/${orderId}`} variant="ghost" size="sm">
                Back to the order
              </ButtonLink>
            </LoadError>
          )}
          {state.status === 'closed' && (
            <>
              <Alert>{state.message}</Alert>
              <ButtonLink to={`/orders/${orderId}`} variant="secondary">
                View order
              </ButtonLink>
            </>
          )}
          {state.status === 'ready' && (
            <>
              <img className="handoff__qr" src={state.qr} alt="Handoff QR code for the buyer to scan" />
              <Button variant="secondary" size="sm" onClick={() => void copyCode(state.token)}>
                {copyResult === 'copied' ? 'Copied' : 'Copy code'}
              </Button>
              {copyResult === 'failed' && (
                <Textarea
                  className="handoff__code"
                  label="Couldn't copy automatically. Select the code and copy it:"
                  rows={4}
                  value={state.token}
                  readOnly
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
              <p className="text-muted handoff__hint">
                {secondsLeft > 0
                  ? `Code refreshes automatically · expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                  : 'Code expired. Getting a new one…'}
              </p>
              <p className="handoff__explain">
                Only hand over the item once the buyer's scan says the payment went through. Each code works once.
              </p>
              <Button variant="secondary" onClick={() => void load()}>
                New code
              </Button>
            </>
          )}
        </div>
      </Card>
    </Page>
  )
}
