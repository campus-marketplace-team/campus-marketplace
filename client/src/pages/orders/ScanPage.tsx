import { useCallback, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import type { CheckoutOrder } from '../../checkout/checkoutApi'
import { Alert, Button, ButtonLink, LoadingState, Textarea } from '../../components'
import { scanHandoffToken } from '../../handoff/handoffApi'
import { useQrScanner } from '../../handoff/useQrScanner'
import { Page } from '../../layout/Page'
import { formatPrice } from '../../listings/format'
import './handoff.css'

// Buyer's side of the handoff: scan the seller's QR code to release the
// payment. The server checks the code and that this logged-in buyer owns the
// order, then captures. Pasting the code is a fallback for devices without a camera.
//
// Built for a phone held up to another phone: on small screens the camera view
// runs edge to edge, the viewport keeps its place while a code is checked (so
// the page doesn't jump), and the paste fallback stays folded away unless the
// camera can't be used.

type State =
  | { status: 'scanning' }
  | { status: 'submitting' }
  | { status: 'done'; order: CheckoutOrder }
  | { status: 'error'; message: string }

export function ScanPage() {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<State>({ status: 'scanning' })
  const [pasted, setPasted] = useState('')

  const submit = useCallback(async (token: string) => {
    setState({ status: 'submitting' })
    try {
      // Tokens never contain whitespace; pasted ones can pick up line breaks.
      const { order } = await scanHandoffToken(token.replace(/\s+/g, ''))
      setState({ status: 'done', order })
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not check that code.' })
    }
  }, [])

  const camera = useQrScanner(video, state.status === 'scanning', submit)
  const cameraFailed = camera === 'denied' || camera === 'unavailable'

  function onPaste(e: FormEvent) {
    e.preventDefault()
    if (pasted.trim()) void submit(pasted)
  }

  if (state.status === 'done') {
    return (
      <Page title="Payment complete" width="narrow">
        <div className="scan">
          <div className="scan__done" role="status">
            <span className="scan__done-icon" aria-hidden="true">
              ✓
            </span>
            <p className="scan__done-amount">{formatPrice(state.order.amountCents, state.order.currency)}</p>
            <p className="text-muted">released to the seller. Enjoy!</p>
          </div>
          <ButtonLink to={`/orders/${state.order.id}`} fullWidth>
            View order
          </ButtonLink>
        </div>
      </Page>
    )
  }

  return (
    <Page title="Scan handoff code" description="Scan the seller's QR code once you have the item." width="narrow">
      <div className="scan">
        {/* Always mounted, since the camera needs the video element; the same size while scanning, checking or after an error. */}
        <div className="scan__viewport" hidden={cameraFailed}>
          <video ref={video} className="scan__video" muted playsInline />
          {state.status === 'scanning' && camera === 'scanning' && <span className="scan__frame" aria-hidden="true" />}
          {state.status === 'scanning' && camera === 'starting' && <p className="scan__overlay">Starting camera…</p>}
          {state.status === 'submitting' && (
            <p className="scan__overlay" role="status">
              <span className="scan__spinner" aria-hidden="true" />
              Checking the code…
            </p>
          )}
          {state.status === 'error' && (
            <p className="scan__overlay" aria-hidden="true">
              Code not accepted
            </p>
          )}
        </div>

        {cameraFailed && state.status === 'submitting' && <LoadingState inline label="Checking the code…" />}
        {state.status === 'scanning' && camera === 'scanning' && (
          <p className="scan__hint" role="status">
            Point your camera at the seller's code. It scans by itself.
          </p>
        )}
        {state.status === 'scanning' && camera === 'denied' && (
          <Alert tone="error">Camera access was blocked. Allow it in your browser settings and reload, or paste the code below.</Alert>
        )}
        {state.status === 'scanning' && camera === 'unavailable' && <Alert>No camera available here. Paste the code below.</Alert>}

        {state.status === 'error' && (
          <>
            <Alert tone="error">{state.message}</Alert>
            <Button fullWidth onClick={() => setState({ status: 'scanning' })}>
              Scan again
            </Button>
          </>
        )}

        {state.status === 'scanning' && (
          // Remounted when the camera fails so it opens; otherwise it starts folded away.
          <details key={cameraFailed ? 'open' : 'closed'} className="scan__paste" open={cameraFailed}>
            <summary>Can't scan? Paste the code instead</summary>
            <form className="stack" onSubmit={onPaste}>
              <Textarea
                label="Handoff code"
                hint="The seller can copy it from their QR code page."
                rows={3}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
              />
              <Button type="submit" variant="secondary" fullWidth disabled={!pasted.trim()}>
                Submit code
              </Button>
            </form>
          </details>
        )}
      </div>
    </Page>
  )
}
