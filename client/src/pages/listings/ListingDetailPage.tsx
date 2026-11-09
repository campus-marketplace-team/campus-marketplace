import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { useAuth } from '../../auth/useAuth'
import { ChatPanel } from '../../chat/ChatPanel'
import type { CheckoutOrder } from '../../checkout/checkoutApi'
import { PayPalCheckout } from '../../checkout/PayPalCheckout'
import { Alert, ButtonLink, Card, LoadError, LoadingState } from '../../components'
import { Page } from '../../layout/Page'
import { CATEGORY_LABELS, formatPrice } from '../../listings/format'
import { fetchListing, type Listing } from '../../listings/listingsApi'
import { NotFoundPage } from '../NotFoundPage'
import './listings.css'

/** Navigation state set by the post-a-listing form. */
export type ListingDetailState = { posted?: boolean; photoErrors?: string[] }

type Result =
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; listing: Listing }

export function ListingDetailPage() {
  const { listingId = '' } = useParams()
  const notice = useLocation().state as ListingDetailState | null
  // Tagged with the listing it was loaded for, so moving to another listing shows as loading.
  const [result, setResult] = useState<(Result & { id: string }) | null>(null)
  const state = result?.id === listingId ? result : ({ status: 'loading' } as const)
  // Bumped by "Try again" to re-run the fetch.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchListing(listingId, controller.signal)
      .then(({ listing }) => setResult({ id: listingId, status: 'ready', listing }))
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 404) setResult({ id: listingId, status: 'not-found' })
        else {
          const message = err instanceof ApiError ? err.message : 'Could not load this listing.'
          setResult({ id: listingId, status: 'error', message })
        }
      })
    return () => controller.abort()
  }, [listingId, attempt])

  if (state.status === 'not-found') return <NotFoundPage />
  if (state.status === 'loading') {
    return (
      <Page title="Listing">
        <LoadingState label="Loading listing…" />
      </Page>
    )
  }
  if (state.status === 'error') {
    return (
      <Page title="Listing">
        <LoadError
          message={state.message}
          onRetry={() => {
            setResult(null)
            setAttempt((n) => n + 1)
          }}
        >
          <ButtonLink to="/" variant="ghost" size="sm">
            Back to browse
          </ButtonLink>
        </LoadError>
      </Page>
    )
  }
  return <ListingDetail key={state.listing.id} listing={state.listing} notice={notice} />
}

function ListingDetail({ listing: loaded, notice }: { listing: Listing; notice: ListingDetailState | null }) {
  const auth = useAuth()
  // Set once this buyer's payment is authorized; the listing is then reserved for them.
  const [order, setOrder] = useState<CheckoutOrder | null>(null)
  const listing: Listing = order ? { ...loaded, status: 'RESERVED' } : loaded
  const isSeller = auth.status === 'authenticated' && auth.user.id === listing.seller.id
  const photos = listing.photoUrls ?? []
  const [photoIndex, setPhotoIndex] = useState(0)
  const posted = new Date(listing.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })

  return (
    <Page title={listing.title}>
      <p>
        <Link to="/">← Back to browse</Link>
      </p>

      {notice?.posted && !notice.photoErrors?.length && <Alert tone="success">Your listing is live.</Alert>}
      {notice?.photoErrors?.length ? (
        <Alert tone="error">
          Your listing is live, but {notice.photoErrors.length === 1 ? 'one photo' : `${notice.photoErrors.length} photos`}{' '}
          didn't upload:
          <ul className="listing-detail__errors">
            {notice.photoErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {order?.handoffDeadline && (
        <Alert tone="success">
          Payment authorized. Your money is held until you scan the seller's QR code at the handoff. Meet the seller by{' '}
          {new Date(order.handoffDeadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}, or
          the hold is cancelled and you won't be charged.{' '}
          <Link to={`/orders/${order.id}`}>Track your order</Link> and scan the code there when you meet.
        </Alert>
      )}

      <div className="listing-detail">
        <div className="listing-detail__gallery">
          <div className="listing-detail__photo">
            {photos.length ? (
              <img src={photos[photoIndex]} alt={`${listing.title}, photo ${photoIndex + 1} of ${photos.length}`} />
            ) : (
              <span className="listing-card__no-photo">No photos</span>
            )}
          </div>
          {photos.length > 1 && (
            <div className="listing-detail__thumbs">
              {photos.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  className={i === photoIndex ? 'thumb thumb--active' : 'thumb'}
                  aria-label={`Show photo ${i + 1}`}
                  aria-pressed={i === photoIndex}
                  onClick={() => setPhotoIndex(i)}
                >
                  <img src={url} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="listing-detail__side">
          <Card className="listing-detail__info">
            <div className="stack">
              <div className="listing-detail__price-row">
                <span className="listing-detail__price">{formatPrice(listing.priceCents, listing.currency)}</span>
                {listing.status !== 'ACTIVE' && (
                  <span className="status-badge">{listing.status === 'SOLD' ? 'Sold' : 'Reserved'}</span>
                )}
              </div>
              <dl className="listing-detail__facts">
                <div>
                  <dt>Category</dt>
                  <dd>
                    <Link to={`/?category=${listing.category}`}>{CATEGORY_LABELS[listing.category]}</Link>
                  </dd>
                </div>
                <div>
                  <dt>Seller</dt>
                  <dd>{isSeller ? `${listing.seller.displayName} (you)` : listing.seller.displayName}</dd>
                </div>
                <div>
                  <dt>Posted</dt>
                  <dd>{posted}</dd>
                </div>
              </dl>
              <div>
                <h2 className="listing-detail__heading">Description</h2>
                {/* Seller-written text: rendered as plain text, never as HTML. */}
                <p className="listing-detail__description">{listing.description}</p>
              </div>
              {!isSeller && auth.status === 'anonymous' && listing.status === 'ACTIVE' && (
                <ButtonLink to="/login" state={{ from: `/listings/${listing.id}` }} variant="secondary" fullWidth>
                  Log in to contact the seller
                </ButtonLink>
              )}
            </div>
          </Card>
          {auth.status === 'authenticated' && !isSeller && listing.status === 'ACTIVE' && (
            <PayPalCheckout listing={listing} onAuthorized={setOrder} />
          )}
          {auth.status === 'authenticated' && <ChatPanel listing={listing} meId={auth.user.id} />}
        </div>
      </div>
    </Page>
  )
}
