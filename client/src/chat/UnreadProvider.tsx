import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { fetchUnreadCount } from './chatApi'
import { UnreadContext } from './useUnread'

// The API gives this poll its own bucket (120 per 15 min per user), separate from
// chat and the general limit. 30 s polling is 30 per 15 min; focus refreshes are
// spaced at least 10 s apart, so even constant tab-switching stays under the cap.
const POLL_MS = 30_000
const MIN_GAP_MS = 10_000

/** Polls the unread-conversation count for the nav badge while someone is logged in. */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const userId = auth.status === 'authenticated' ? auth.user.id : null
  // Tagged with the user it was fetched for, so logging out or switching user never shows a stale count.
  const [state, setState] = useState<{ userId: string | null; count: number }>({ userId: null, count: 0 })
  const count = userId && state.userId === userId ? state.count : 0

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let lastStartedAt = 0

    async function refresh(scheduled: boolean) {
      if (inFlight || controller.signal.aborted || document.hidden) return
      if (!scheduled && Date.now() - lastStartedAt < MIN_GAP_MS) return
      clearTimeout(timer)
      inFlight = true
      lastStartedAt = Date.now()
      try {
        const { unreadCount } = await fetchUnreadCount(controller.signal)
        setState({ userId: userId!, count: unreadCount })
      } catch {
        // Keep the last count; the next poll retries.
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(true), POLL_MS)
      }
    }

    // A hidden tab skips its poll; becoming visible or focused again refreshes right away.
    const onFocus = () => void refresh(false)
    const onVisibility = () => {
      if (!document.hidden) void refresh(false)
    }
    void refresh(true)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [userId])

  const setCount = useCallback(
    (next: number) => {
      if (userId) setState({ userId, count: next })
    },
    [userId],
  )
  const value = useMemo(() => ({ count, setCount }), [count, setCount])
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>
}
