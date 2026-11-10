import { createContext, useContext } from 'react'

export type UnreadContextValue = {
  /** Unread conversations for the logged-in user; 0 when logged out. */
  count: number
  /** Sets the count from a response that already includes it (e.g. marking a conversation read). */
  setCount: (count: number) => void
}

export const UnreadContext = createContext<UnreadContextValue>({ count: 0, setCount: () => {} })

export function useUnread(): UnreadContextValue {
  return useContext(UnreadContext)
}
