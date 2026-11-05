import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { DISPUTE_LIMITS, DISPUTE_REASONS, isDisputeReason, LISTING_LIMITS } from '@campus/shared'
import { ApiError } from '../../api/client'
import { Alert, Button, ButtonLink, Card, Select, Textarea } from '../../components'
import { Page } from '../../layout/Page'
import { DISPUTE_REASON_LABELS, disputePhotoProblem } from '../../orders/orderStatus'
import { fetchOrder, openDispute, uploadDisputePhoto, type OrderStatus } from '../../orders/ordersApi'
import '../listings/listings.css'
import './orders.css'

// "Report a problem": the buyer describes what went wrong and adds photos. The
// report is created first and the photos uploaded after it, so a failed photo
// never loses the report; the order page says which ones to try again.

/** Navigation state set by this form for the order page. */
export type OrderStatusNotice = { reported?: boolean; photoErrors?: string[] }

type PhotoDraft = { key: string; file: File; previewUrl: string }
type FieldErrors = Partial<Record<'reason' | 'description', string>>
type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; order: OrderStatus }

const reasonOptions = DISPUTE_REASONS.map((r) => ({ value: r, label: DISPUTE_REASON_LABELS[r] }))
const maxPhotoMb = LISTING_LIMITS.photoMaxBytes / (1024 * 1024)

export function ReportProblemPage() {
  const { orderId = '' } = useParams()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    fetchOrder(orderId, controller.signal)
      .then(({ order }) => setState({ status: 'ready', order }))
      .catch((err) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not load this order.' })
      })
    return () => controller.abort()
  }, [orderId])

  return (
    <Page title="Report a problem" description="Your payment stays on hold while we look into it." width="narrow">
      {state.status === 'loading' && <p className="text-muted">Loading the order…</p>}
      {state.status === 'error' && <Alert tone="error">{state.message}</Alert>}
      {state.status === 'ready' &&
        (state.order.role === 'buyer' && state.order.state === 'AUTHORIZED' ? (
          <ReportForm order={state.order} />
        ) : (
          <div className="stack">
            <Alert>
              {state.order.role === 'buyer'
                ? 'You can only report a problem while your payment is on hold.'
                : 'Only the buyer of this order can report a problem.'}
            </Alert>
            <ButtonLink to={`/orders/${state.order.id}`} variant="secondary">
              Back to the order
            </ButtonLink>
          </div>
        ))}
    </Page>
  )
}

function ReportForm({ order }: { order: OrderStatus }) {
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [photos, setPhotos] = useState<PhotoDraft[]>([])
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Free the preview object URLs when the page unmounts.
  const photosRef = useRef(photos)
  useEffect(() => {
    photosRef.current = photos
  }, [photos])
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), [])

  function addPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // so picking the same file again still fires onChange
    const rejected: string[] = []
    const accepted: PhotoDraft[] = []
    for (const file of files) {
      const problem = disputePhotoProblem(file)
      if (problem) {
        rejected.push(problem)
      } else if (photos.length + accepted.length >= DISPUTE_LIMITS.photosMax) {
        rejected.push(`You can add up to ${DISPUTE_LIMITS.photosMax} photos.`)
        break
      } else {
        accepted.push({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) })
      }
    }
    setPhotos((prev) => [...prev, ...accepted])
    setPhotoError(rejected.length ? rejected.join(' ') : null)
  }

  function removePhoto(key: string) {
    setPhotos((prev) => {
      const photo = prev.find((p) => p.key === key)
      if (photo) URL.revokeObjectURL(photo.previewUrl)
      return prev.filter((p) => p.key !== key)
    })
    setPhotoError(null)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const errors: FieldErrors = {}
    if (!isDisputeReason(reason)) errors.reason = 'Pick what went wrong.'
    if (!description.trim()) errors.description = 'Describe the problem.'
    setFieldErrors(errors)
    if (!isDisputeReason(reason) || !description.trim()) return

    setProgress('Sending your report…')
    try {
      await openDispute(order.id, { reason, description: description.trim() })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_DISPUTED') {
        navigate(`/orders/${order.id}`, { replace: true })
        return
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      setProgress(null)
      return
    }

    // The report exists now, so a failed photo doesn't undo it: the order page says so and can retry.
    const photoErrors: string[] = []
    for (const [i, photo] of photos.entries()) {
      setProgress(`Uploading photo ${i + 1} of ${photos.length}…`)
      try {
        await uploadDisputePhoto(order.id, photo.file)
      } catch (err) {
        photoErrors.push(`${photo.file.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`)
      }
    }

    const state: OrderStatusNotice = { reported: true, photoErrors }
    navigate(`/orders/${order.id}`, { replace: true, state })
  }

  const submitting = progress !== null

  return (
    <div className="stack">
      <Alert>
        Reporting stops the handoff for <strong>{order.listing.title}</strong>: the seller can't show a QR code and you
        won't be charged while it's looked into. The seller can see what you write and the photos you add.
      </Alert>
      <Card>
        <form className="sell-form" onSubmit={handleSubmit} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <fieldset className="sell-form__fields" disabled={submitting}>
            <Select
              label="What went wrong?"
              required
              placeholder="Pick one"
              options={reasonOptions}
              value={reason}
              error={fieldErrors.reason}
              onChange={(e) => {
                setReason(e.target.value)
                setFieldErrors((prev) => ({ ...prev, reason: undefined }))
              }}
            />
            <Textarea
              label="What happened?"
              hint="Stick to the facts: what you expected, what you got, and anything you and the seller agreed."
              required
              maxLength={DISPUTE_LIMITS.descriptionMax}
              value={description}
              error={fieldErrors.description}
              onChange={(e) => {
                setDescription(e.target.value)
                setFieldErrors((prev) => ({ ...prev, description: undefined }))
              }}
            />

            <div className="field">
              <span className="field__label">Photos</span>
              <p className="field__hint">
                Optional. Up to {DISPUTE_LIMITS.photosMax} JPEG, PNG or WebP images, {maxPhotoMb} MB each.
              </p>
              {photos.length > 0 && (
                <ul className="photo-previews">
                  {photos.map((p, i) => (
                    <li key={p.key} className="photo-preview">
                      <img src={p.previewUrl} alt={`Photo ${i + 1}: ${p.file.name}`} />
                      <button
                        type="button"
                        className="photo-preview__remove"
                        aria-label={`Remove ${p.file.name}`}
                        onClick={() => removePhoto(p.key)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={fileInput}
                type="file"
                accept={LISTING_LIMITS.photoTypes.join(',')}
                multiple
                hidden
                onChange={addPhotos}
              />
              {photos.length < DISPUTE_LIMITS.photosMax && (
                <div>
                  <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                    {photos.length ? 'Add more photos' : 'Add photos'}
                  </Button>
                </div>
              )}
              {photoError && (
                <p className="field__error" role="alert">
                  {photoError}
                </p>
              )}
            </div>
          </fieldset>

          <Button type="submit" fullWidth loading={submitting}>
            {progress ?? 'Send report'}
          </Button>
          {!submitting && (
            <p className="text-muted order-report__cancel">
              <Link to={`/orders/${order.id}`}>Never mind, go back to the order</Link>
            </p>
          )}
        </form>
      </Card>
    </div>
  )
}
