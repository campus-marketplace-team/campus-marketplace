import type { ListingStatus } from '@campus/shared'
import { api } from '../api/client'

// Mirrors the server's chat shapes (server/src/routes/chat.ts).
export type ChatMessage = {
  id: string
  listingId: string
  senderId: string
  recipientId: string
  body: string
  createdAt: string
}

export type ChatThread = {
  listing: { id: string; title: string; status: ListingStatus; priceCents: number; photoUrls: string[] | null }
  buyerId: string
  role: 'buyer' | 'seller'
  otherUser: { id: string; displayName: string }
  lastMessage: ChatMessage
  /** The other person has written since I last read this conversation. */
  unread: boolean
}

/** My conversations across all listings, most recent first. */
export function fetchThreads(signal?: AbortSignal) {
  return api<{ threads: ChatThread[] }>('/api/chats', { signal })
}

/** How many of my conversations are unread. Cheap; polled by the nav badge. */
export function fetchUnreadCount(signal?: AbortSignal) {
  return api<{ unreadCount: number }>('/api/chats/unread-count', { signal })
}

/** Marks a conversation read up to `messageId` (the newest message shown). Returns my new unread count. */
export function markConversationRead(listingId: string, messageId: string, buyerId?: string) {
  return api<{ unreadCount: number }>(`/api/chats/${encodeURIComponent(listingId)}/read`, {
    method: 'POST',
    body: buyerId ? { messageId, buyerId } : { messageId },
  })
}

/**
 * Messages in one conversation, oldest first. A buyer omits buyerId; the seller
 * must pass it. With `after`, only messages newer than that message id.
 */
export function fetchMessages(listingId: string, buyerId?: string, after?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams()
  if (buyerId) params.set('buyerId', buyerId)
  if (after) params.set('after', after)
  const query = params.toString()
  return api<{ buyerId: string; sellerId: string; messages: ChatMessage[] }>(
    `/api/chats/${encodeURIComponent(listingId)}/messages${query ? `?${query}` : ''}`,
    { signal },
  )
}

export function sendMessage(listingId: string, body: string, buyerId?: string) {
  return api<{ message: ChatMessage }>(`/api/chats/${encodeURIComponent(listingId)}/messages`, {
    method: 'POST',
    body: buyerId ? { body, buyerId } : { body },
  })
}
