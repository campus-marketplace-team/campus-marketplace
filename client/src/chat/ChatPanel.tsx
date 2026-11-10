import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CHAT_LIMITS } from '@campus/shared'
import { ApiError } from '../api/client'
import { Alert, Button, Card, LoadingState } from '../components'
import type { Listing } from '../listings/listingsApi'
import { fetchMessages, fetchThreads, markConversationRead, sendMessage, type ChatMessage, type ChatThread } from './chatApi'
import { usePoll } from './usePoll'
import { useUnread } from './useUnread'
import '../components/Input.css'
import './chat.css'

// 240 requests per 15 minutes at most, under the API's general limit of 300 even with other pages' requests.
const MESSAGE_POLL_MS = 5000
const THREAD_POLL_MS = 15000

/**
 * Chat on a listing's page, for a logged-in user. Buyers get their one conversation
 * with the seller; the seller picks which buyer's conversation to read.
 */
export function ChatPanel({
  listing,
  meId,
  onLatestMessage,
  initialBuyerId,
}: {
  listing: Listing
  meId: string
  /** Buyer side only: called with the newest message's id whenever it changes. */
  onLatestMessage?: (id: string | null) => void
  /** Seller side only: which buyer's conversation to open first (e.g. from the Messages inbox). */
  initialBuyerId?: string | null
}) {
  return listing.seller.id === meId ? (
    <SellerChats listing={listing} meId={meId} initialBuyerId={initialBuyerId ?? null} />
  ) : (
    <Card title={`Message ${listing.seller.displayName}`}>
      <Conversation
        listingId={listing.id}
        meId={meId}
        otherName={listing.seller.displayName}
        canStart={listing.status === 'ACTIVE'}
        onLatestMessage={onLatestMessage}
      />
    </Card>
  )
}

function SellerChats({ listing, meId, initialBuyerId }: { listing: Listing; meId: string; initialBuyerId: string | null }) {
  const [threads, setThreads] = useState<ChatThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedBuyerId, setSelectedBuyerId] = useState<string | null>(initialBuyerId)

  usePoll(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          const all = (await fetchThreads(signal)).threads
          setThreads(all.filter((t) => t.role === 'seller' && t.listing.id === listing.id))
          setError(null)
        } catch (err) {
          if (!signal.aborted) setError(err instanceof ApiError ? err.message : 'Could not load messages.')
        }
      },
      [listing.id],
    ),
    THREAD_POLL_MS,
  )

  // Most recent conversation until the seller picks one.
  const selected = threads?.find((t) => t.buyerId === selectedBuyerId) ?? threads?.[0]

  return (
    <Card title="Messages from buyers">
      <div className="stack">
        {error && <Alert tone="error">{error}</Alert>}
        {threads === null && !error && <LoadingState inline label="Loading messages…" />}
        {threads?.length === 0 && <p className="text-muted">No messages yet. Buyers' questions will show up here.</p>}
        {threads && threads.length > 1 && (
          <div className="chat-buyers" role="tablist" aria-label="Conversations">
            {threads.map((t) => (
              <button
                key={t.buyerId}
                type="button"
                role="tab"
                aria-selected={t.buyerId === selected?.buyerId}
                className={t.buyerId === selected?.buyerId ? 'chip chip--active' : 'chip'}
                onClick={() => setSelectedBuyerId(t.buyerId)}
              >
                {t.otherUser.displayName}
                {t.unread && t.buyerId !== selected?.buyerId && (
                  <>
                    <span className="unread-dot" aria-hidden="true" />
                    <span className="visually-hidden"> (unread)</span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        {selected && (
          <Conversation
            // Remount per buyer so each conversation starts from a clean state.
            key={selected.buyerId}
            listingId={listing.id}
            buyerId={selected.buyerId}
            meId={meId}
            otherName={selected.otherUser.displayName}
            canStart
          />
        )}
      </div>
    </Card>
  )
}

/** Merges new messages in, dropping duplicates and keeping (createdAt, id) order like the API. */
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  )
}

type ConversationProps = {
  listingId: string
  /** Only for the seller, to say which buyer's conversation. */
  buyerId?: string
  meId: string
  otherName: string
  /** Whether a new conversation can be started (the listing is still for sale). */
  canStart: boolean
  onLatestMessage?: (id: string | null) => void
}

function Conversation({ listingId, buyerId, meId, otherName, canStart, onLatestMessage }: ConversationProps) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // Cursor for polling: only advanced by polls, never by our own sends, so a message
  // the other person sent just before ours can't be skipped.
  const lastPolledId = useRef<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  usePoll(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          const res = await fetchMessages(listingId, buyerId, lastPolledId.current, signal)
          if (res.messages.length) lastPolledId.current = res.messages[res.messages.length - 1].id
          setMessages((prev) => mergeMessages(prev ?? [], res.messages))
          setLoadError(null)
        } catch (err) {
          if (!signal.aborted) setLoadError(err instanceof ApiError ? err.message : 'Could not load messages.')
        }
      },
      [listingId, buyerId],
    ),
    MESSAGE_POLL_MS,
  )

  const loaded = messages !== null
  const latestId = messages?.length ? messages[messages.length - 1].id : null
  const onLatestRef = useRef(onLatestMessage)
  useEffect(() => {
    onLatestRef.current = onLatestMessage
  })
  useEffect(() => {
    if (loaded) onLatestRef.current?.(latestId)
  }, [latestId, loaded])

  // Showing the conversation reads it, up to the newest message from the other person
  // that's actually on screen (never "now", so a message not fetched yet stays unread).
  const { setCount: setUnreadCount } = useUnread()
  const latestIncomingId = messages?.findLast((m) => m.senderId !== meId)?.id ?? null
  useEffect(() => {
    if (!latestIncomingId) return
    markConversationRead(listingId, latestIncomingId, buyerId)
      .then(({ unreadCount }) => setUnreadCount(unreadCount))
      .catch(() => {
        // Not critical: it stays unread, and the next new message tries again.
      })
  }, [latestIncomingId, listingId, buyerId, setUnreadCount])

  // Keep the newest message in view.
  const count = messages?.length ?? 0
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [count])

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setSendError(null)
    try {
      const { message } = await sendMessage(listingId, body, buyerId)
      setMessages((prev) => mergeMessages(prev ?? [], [message]))
      setDraft('')
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Message not sent. Please try again.')
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter adds a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  if (messages === null) {
    // The poll keeps retrying, so there's no button here.
    return loadError ? <Alert tone="error">{loadError} Retrying…</Alert> : <LoadingState inline label="Loading messages…" />
  }

  const canSend = messages.length > 0 || canStart

  return (
    <div className="chat">
      {messages.length > 0 ? (
        <ol className="chat__messages" ref={listRef} aria-label={`Conversation with ${otherName}`} aria-live="polite">
          {messages.map((m) => {
            const mine = m.senderId === meId
            return (
              <li key={m.id} className={mine ? 'chat-msg chat-msg--mine' : 'chat-msg'}>
                {/* Message text is untrusted user input: rendered as plain text, never HTML. */}
                <p className="chat-msg__body">{m.body}</p>
                <span className="chat-msg__meta">
                  {mine ? 'You' : otherName} ·{' '}
                  {new Date(m.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-muted">
          {canStart ? `Ask ${otherName} a question or arrange a handoff.` : "This listing isn't available anymore."}
        </p>
      )}

      {loadError && <p className="field__error">Couldn't check for new messages. Retrying…</p>}

      {canSend && (
        <form className="chat__composer" onSubmit={send}>
          <textarea
            aria-label={`Message ${otherName}`}
            className="field__input field__input--textarea chat__input"
            rows={2}
            maxLength={CHAT_LIMITS.messageMax}
            placeholder={`Message ${otherName}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {sendError && (
            <p className="field__error" role="alert">
              {sendError}
            </p>
          )}
          <div className="chat__actions">
            <span className="field__hint">Never pay outside the app. Payment goes through PayPal at checkout.</span>
            <Button type="submit" size="sm" loading={sending} disabled={!draft.trim()}>
              Send
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
