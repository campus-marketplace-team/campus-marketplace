import { useCallback, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../api/client'
import { useAuth } from '../../auth/useAuth'
import { fetchThreads, type ChatThread } from '../../chat/chatApi'
import { formatRelativeTime } from '../../chat/relativeTime'
import { usePoll } from '../../chat/usePoll'
import { ButtonLink, Card, LoadError, LoadingState } from '../../components'
import { Page } from '../../layout/Page'
import '../../chat/chat.css'
import '../listings/listings.css'
import './messages.css'

// Same rate as the seller's conversation list on a listing page.
const THREAD_POLL_MS = 15000

/** Every conversation I'm in, newest activity first. A row opens the chat on its listing's page. */
export function MessagesPage() {
  // Bumped by "Try again": remounting the inbox restarts its poll straight away.
  const [attempt, setAttempt] = useState(0)
  return (
    <Page title="Messages" description="Your conversations with buyers and sellers.">
      <Inbox key={attempt} onRetry={() => setAttempt((n) => n + 1)} />
    </Page>
  )
}

function Inbox({ onRetry }: { onRetry: () => void }) {
  const auth = useAuth()
  const meId = auth.status === 'authenticated' ? auth.user.id : ''
  const [threads, setThreads] = useState<ChatThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  usePoll(
    useCallback(async (signal: AbortSignal) => {
      try {
        setThreads((await fetchThreads(signal)).threads)
        setError(null)
      } catch (err) {
        if (!signal.aborted) setError(err instanceof ApiError ? err.message : 'Could not load your messages.')
      }
    }, []),
    THREAD_POLL_MS,
  )

  return (
    <>
      {threads === null && !error && <LoadingState label="Loading messages…" />}
      {threads === null && error && <LoadError message={error} onRetry={onRetry} />}
      {threads?.length === 0 && (
        <Card>
          <div className="messages-empty">
            <p className="text-muted">
              No conversations yet. Message a seller from any listing and it'll show up here.
            </p>
            <ButtonLink to="/" size="sm">
              Browse listings
            </ButtonLink>
          </div>
        </Card>
      )}
      {threads && threads.length > 0 && (
        <ul className="inbox" aria-label="Conversations">
          {threads.map((t) => (
            <li key={`${t.listing.id}:${t.buyerId}`}>
              <ThreadRow thread={t} meId={meId} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function ThreadRow({ thread, meId }: { thread: ChatThread; meId: string }) {
  const { listing, otherUser, lastMessage, unread, role, buyerId } = thread
  const photo = listing.photoUrls?.[0]
  // Sellers have one conversation per buyer, so the link says which one.
  const to = `/listings/${listing.id}${role === 'seller' ? `?buyer=${encodeURIComponent(buyerId)}` : ''}#chat`
  const mine = lastMessage.senderId === meId

  return (
    <Link to={to} className={unread ? 'inbox-row inbox-row--unread' : 'inbox-row'}>
      <span className="inbox-row__photo">
        {photo ? <img src={photo} alt="" loading="lazy" /> : <span className="listing-card__no-photo">No photo</span>}
      </span>
      <span className="inbox-row__body">
        <span className="inbox-row__top">
          <span className="inbox-row__title">{listing.title}</span>
          <time className="inbox-row__time" dateTime={lastMessage.createdAt} title={new Date(lastMessage.createdAt).toLocaleString()}>
            {formatRelativeTime(lastMessage.createdAt)}
          </time>
        </span>
        <span className="inbox-row__who">
          {otherUser.displayName}
          <span className="text-muted"> · {role === 'seller' ? 'buyer' : 'seller'}</span>
          {listing.status !== 'ACTIVE' && (
            <span className="status-badge inbox-row__status">{listing.status === 'SOLD' ? 'Sold' : 'Reserved'}</span>
          )}
        </span>
        {/* Message text is untrusted user input: rendered as plain text, never HTML. */}
        <span className="inbox-row__preview">
          {mine && 'You: '}
          {lastMessage.body}
        </span>
      </span>
      {unread && (
        <>
          <span className="unread-dot inbox-row__dot" aria-hidden="true" />
          <span className="visually-hidden">Unread</span>
        </>
      )}
    </Link>
  )
}
