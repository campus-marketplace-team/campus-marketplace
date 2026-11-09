import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { isListingCategory, LISTING_CATEGORIES, type ListingCategory } from '@campus/shared'
import { ApiError } from '../../api/client'
import { Alert, Button, ButtonLink, Card, Input, LoadError, LoadingState } from '../../components'
import { Page } from '../../layout/Page'
import { CATEGORY_LABELS, centsToDollarInput, formatPrice, parseDollarsToCents } from '../../listings/format'
import { fetchListings, type Listing, type ListingFilters } from '../../listings/listingsApi'
import './listings.css'

// Filters live in the URL (?category=TEXTBOOKS,ELECTRONICS&min=10&max=50, prices in dollars)
// so a filtered view can be shared, bookmarked and survives a reload.
function filtersFromParams(params: URLSearchParams): ListingFilters {
  const categories = (params.get('category') ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(isListingCategory)
  const min = parseDollarsToCents(params.get('min') ?? '')
  const max = parseDollarsToCents(params.get('max') ?? '')
  return {
    categories: categories.length ? categories : undefined,
    minPriceCents: min ?? undefined,
    maxPriceCents: max ?? undefined,
  }
}

type Result =
  | { status: 'error'; message: string }
  | { status: 'ready'; listings: Listing[]; nextCursor: string | null; loadMoreError?: string }

export function BrowsePage() {
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  // Keyed on the query string, so the fetch effect below runs once per filter change.
  const filters = useMemo(() => filtersFromParams(new URLSearchParams(paramsKey)), [paramsKey])

  // Each result remembers which filters it was loaded for; until the current filters'
  // result arrives, the page shows as loading.
  const [result, setResult] = useState<(Result & { key: string }) | null>(null)
  const state = result?.key === paramsKey ? result : ({ status: 'loading' } as const)
  const [loadingMore, setLoadingMore] = useState(false)
  // Bumped by "Try again" to re-run the fetch for the same filters.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchListings(filters, null, controller.signal)
      .then(({ listings, nextCursor }) => setResult({ key: paramsKey, status: 'ready', listings, nextCursor }))
      .catch((err) => {
        if (controller.signal.aborted) return
        const message = err instanceof ApiError ? err.message : 'Could not load listings.'
        setResult({ key: paramsKey, status: 'error', message })
      })
    return () => controller.abort()
  }, [filters, paramsKey, attempt])

  async function loadMore() {
    if (state.status !== 'ready' || !state.nextCursor) return
    const key = paramsKey
    // Ignore the page if the filters changed while it was loading.
    const update = (change: (prev: Extract<Result, { status: 'ready' }>) => Result) =>
      setResult((prev) => (prev?.key === key && prev.status === 'ready' ? { key, ...change(prev) } : prev))
    setLoadingMore(true)
    try {
      const page = await fetchListings(filters, state.nextCursor)
      update((prev) => ({ status: 'ready', listings: [...prev.listings, ...page.listings], nextCursor: page.nextCursor }))
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not load more listings.'
      update((prev) => ({ ...prev, loadMoreError: message }))
    } finally {
      setLoadingMore(false)
    }
  }

  function updateParams(change: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params)
    change(next)
    setParams(next, { replace: true })
  }

  function toggleCategory(category: ListingCategory) {
    const current = filters.categories ?? []
    const selected = current.includes(category) ? current.filter((c) => c !== category) : [...current, category]
    updateParams((next) => {
      if (selected.length) next.set('category', selected.join(','))
      else next.delete('category')
    })
  }

  const hasFilters = Boolean(filters.categories || filters.minPriceCents !== undefined || filters.maxPriceCents !== undefined)

  return (
    <Page
      title="Browse"
      description="Find things other students are selling."
      actions={<ButtonLink to="/sell">Post a listing</ButtonLink>}
    >
      <div className="browse">
        <aside className="browse__filters" aria-label="Filters">
          <Card>
            <div className="stack">
              <fieldset className="filter-group">
                <legend className="field__label">Category</legend>
                <div className="chips">
                  {LISTING_CATEGORIES.map((c) => {
                    const active = filters.categories?.includes(c) ?? false
                    return (
                      <button
                        key={c}
                        type="button"
                        className={active ? 'chip chip--active' : 'chip'}
                        aria-pressed={active}
                        onClick={() => toggleCategory(c)}
                      >
                        {CATEGORY_LABELS[c]}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
              <PriceFilter
                // Remount when the URL changes (e.g. "Clear filters") so the inputs show the applied values.
                key={`${filters.minPriceCents}-${filters.maxPriceCents}`}
                minPriceCents={filters.minPriceCents}
                maxPriceCents={filters.maxPriceCents}
                onApply={(min, max) =>
                  updateParams((next) => {
                    if (min !== undefined) next.set('min', centsToDollarInput(min))
                    else next.delete('min')
                    if (max !== undefined) next.set('max', centsToDollarInput(max))
                    else next.delete('max')
                  })
                }
              />
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              )}
            </div>
          </Card>
        </aside>

        <section className="browse__results" aria-live="polite" aria-busy={state.status === 'loading'}>
          {state.status === 'loading' && <LoadingState label="Loading listings…" />}
          {state.status === 'error' && (
            <LoadError
              message={state.message}
              onRetry={() => {
                setResult(null)
                setAttempt((n) => n + 1)
              }}
            />
          )}
          {state.status === 'ready' && state.listings.length === 0 && (
            <Card>
              <p className="text-muted">
                {hasFilters ? 'No listings match these filters.' : 'Nothing for sale yet. Be the first to post something!'}
              </p>
            </Card>
          )}
          {state.status === 'ready' && state.listings.length > 0 && (
            <>
              <ul className="listing-grid">
                {state.listings.map((listing) => (
                  <li key={listing.id}>
                    <ListingCard listing={listing} />
                  </li>
                ))}
              </ul>
              {state.loadMoreError && <Alert tone="error">{state.loadMoreError}</Alert>}
              {state.nextCursor && (
                <div className="browse__more">
                  <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Page>
  )
}

type PriceFilterProps = {
  minPriceCents?: number
  maxPriceCents?: number
  onApply: (min: number | undefined, max: number | undefined) => void
}

function PriceFilter({ minPriceCents, maxPriceCents, onApply }: PriceFilterProps) {
  const [min, setMin] = useState(minPriceCents === undefined ? '' : centsToDollarInput(minPriceCents))
  const [max, setMax] = useState(maxPriceCents === undefined ? '' : centsToDollarInput(maxPriceCents))
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const minCents = min.trim() ? parseDollarsToCents(min) : undefined
    const maxCents = max.trim() ? parseDollarsToCents(max) : undefined
    if (minCents === null || maxCents === null) {
      setError('Enter prices like 20 or 19.99.')
      return
    }
    if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
      setError("Min price can't be more than max price.")
      return
    }
    setError(null)
    onApply(minCents, maxCents)
  }

  return (
    <form className="filter-group" onSubmit={handleSubmit} noValidate>
      <span className="field__label">Price ($)</span>
      <div className="price-filter">
        <Input label="Min" inputMode="decimal" placeholder="0" value={min} onChange={(e) => setMin(e.target.value)} />
        <Input label="Max" inputMode="decimal" placeholder="Any" value={max} onChange={(e) => setMax(e.target.value)} />
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="secondary" size="sm" fullWidth>
        Apply price
      </Button>
    </form>
  )
}

function ListingCard({ listing }: { listing: Listing }) {
  const photo = listing.photoUrls?.[0]
  return (
    <Link to={`/listings/${listing.id}`} className="listing-card">
      <div className="listing-card__photo">
        {photo ? <img src={photo} alt="" loading="lazy" /> : <span className="listing-card__no-photo">No photo</span>}
      </div>
      <div className="listing-card__body">
        <span className="listing-card__price">{formatPrice(listing.priceCents, listing.currency)}</span>
        <span className="listing-card__title">{listing.title}</span>
        <span className="listing-card__meta">
          {CATEGORY_LABELS[listing.category]} · {listing.seller.displayName}
        </span>
      </div>
    </Link>
  )
}
