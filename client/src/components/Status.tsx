import type { ReactNode } from 'react'
import { Alert } from './Alert'
import { Button } from './Button'
import './Status.css'

/** "Loading…" with a spinner, announced to screen readers. `inline` for inside a card; the default is page-sized. */
export function LoadingState({ label = 'Loading…', inline = false }: { label?: string; inline?: boolean }) {
  return (
    <p className={inline ? 'loading-state loading-state--inline' : 'loading-state page-status'} role="status">
      <span className="loading-state__spinner" aria-hidden="true" />
      {label}
    </p>
  )
}

/** A failed load: the error, a "Try again" button when `onRetry` is given, and any other way out (`children`). */
export function LoadError({ message, onRetry, children }: { message: string; onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className="load-error">
      <Alert tone="error">{message}</Alert>
      {(onRetry || children) && (
        <div className="load-error__actions">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  )
}
