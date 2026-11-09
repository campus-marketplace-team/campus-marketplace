import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Alert, Button, ButtonLink } from '../components'
import { Page } from '../layout/Page'
import { NotFoundPage } from './NotFoundPage'

// Shown when a page throws while rendering, or its code fails to download
// (router.tsx). Without it React Router shows its own developer error screen.

/** A lazy page's code couldn't be fetched, usually because a deploy replaced the old files. Wording differs per browser. */
function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message)
}

export function RouteErrorPage() {
  const error = useRouteError()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />

  // Never show the error itself: it can include internals. It's in the console for developers.
  console.error(error)
  const chunk = isChunkLoadError(error)

  return (
    <Page title="Something went wrong" width="narrow">
      <Alert tone="error">
        {chunk
          ? "This page couldn't load. The app may have just been updated, so reloading usually fixes it."
          : 'This page hit an unexpected error. Reloading usually fixes it.'}
      </Alert>
      <div className="load-error__actions">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <ButtonLink to="/" variant="secondary">
          Go to browse
        </ButtonLink>
      </div>
    </Page>
  )
}
