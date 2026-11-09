import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ListingStatus } from '@campus/shared'
import { ApiError } from '../../api/client'
import { ButtonLink, Card, LoadError, LoadingState } from '../../components'
import { Page } from '../../layout/Page'
import { CATEGORY_LABELS, formatPrice } from '../../listings/format'
import { fetchMyListings, type Listing } from '../../listings/listingsApi'
import { ORDER_STATE_LABELS, stateTone } from '../../orders/orderStatus'
import { fetchMyOrders, type OrderStatus } from '../../orders/ordersApi'
import '../orders/orders.css'
import './me.css'

const STATUS_LABELS: Record<ListingStatus, string> = {
  ACTIVE: 'For sale',
  RESERVED: 'Reserved',
  SOLD: 'Sold',
  REMOVED: 'Removed',
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; listings: Listing[] }

export function MyStuffPage() {
  return (
    <Page title="My stuff" actions={<ButtonLink to="/sell">Post a listing</ButtonLink>}>
      <MyListings />
      <MyOrders />
    </Page>
  )
}

type OrdersState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; orders: OrderStatus[] }

function MyOrders() {
  const [state, setState] = useState<OrdersState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchMyOrders(controller.signal)
      .then(({ orders }) => setState({ status: 'ready', orders }))
      .catch((err) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not load your orders.' })
      })
    return () => controller.abort()
  }, [attempt])

  function retry() {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  return (
    <Card title="My orders">
      {state.status === 'loading' && <LoadingState inline label="Loading your orders…" />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={retry} />}
      {state.status === 'ready' && state.orders.length === 0 && (
        <p className="text-muted">No orders yet. Things you buy or sell will show up here.</p>
      )}
      {state.status === 'ready' && state.orders.length > 0 && (
        <ul className="my-listings">
          {state.orders.map((order) => {
            const photo = order.listing.photoUrls[0]
            return (
              <li key={order.id}>
                <Link to={`/orders/${order.id}`} className="my-listing">
                  <span className="my-listing__photo">{photo && <img src={photo} alt="" loading="lazy" />}</span>
                  <span className="my-listing__info">
                    <span className="my-listing__title">{order.listing.title}</span>
                    <span className="my-listing__meta">
                      {formatPrice(order.amountCents, order.currency)} ·{' '}
                      {order.role === 'seller' ? `Sold to ${order.buyer.displayName}` : `Bought from ${order.seller.displayName}`}
                    </span>
                  </span>
                  <span className={`order-badge order-badge--${stateTone(order.state)}`}>
                    {ORDER_STATE_LABELS[order.state]}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function MyListings() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchMyListings(controller.signal)
      .then(({ listings }) => setState({ status: 'ready', listings }))
      .catch((err) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not load your listings.' })
      })
    return () => controller.abort()
  }, [attempt])

  function retry() {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  return (
    <Card title="My listings">
      {state.status === 'loading' && <LoadingState inline label="Loading your listings…" />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={retry} />}
      {state.status === 'ready' && state.listings.length === 0 && (
        <p className="text-muted">
          You haven't posted anything yet. <Link to="/sell">Post your first listing</Link>.
        </p>
      )}
      {state.status === 'ready' && state.listings.length > 0 && (
        <ul className="my-listings">
          {state.listings.map((listing) => {
            const photo = listing.photoUrls?.[0]
            return (
              <li key={listing.id}>
                <Link to={`/listings/${listing.id}`} className="my-listing">
                  <span className="my-listing__photo">{photo && <img src={photo} alt="" loading="lazy" />}</span>
                  <span className="my-listing__info">
                    <span className="my-listing__title">{listing.title}</span>
                    <span className="my-listing__meta">
                      {formatPrice(listing.priceCents, listing.currency)} · {CATEGORY_LABELS[listing.category]}
                    </span>
                  </span>
                  <span className={`my-listing__status my-listing__status--${listing.status.toLowerCase()}`}>
                    {STATUS_LABELS[listing.status]}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
