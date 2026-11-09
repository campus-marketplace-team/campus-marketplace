import { Navigate, Outlet, useLocation } from 'react-router'
import { LoadingState } from '../components'
import { safeRedirect, type RedirectState } from './redirect'
import { useAuth } from './useAuth'

/** Route guard: renders child routes for logged-in users, otherwise sends them to /login. */
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <LoadingState />
  if (status === 'anonymous') {
    const from = location.pathname + location.search + location.hash
    return <Navigate to="/login" replace state={{ from } satisfies RedirectState} />
  }
  return <Outlet />
}

/**
 * Route guard for admin pages, nested inside RequireAuth. The API enforces
 * admin access too (requireAdmin); this only avoids showing a page that
 * would fail to load.
 */
export function RequireAdmin() {
  const auth = useAuth()
  if (auth.status !== 'authenticated') return null // RequireAuth handles loading and logged-out users
  if (!auth.user.isAdmin) {
    return (
      <div className="page">
        <h1>Admins only</h1>
        <p className="text-muted">This page is for marketplace admins.</p>
      </div>
    )
  }
  return <Outlet />
}

/** For /login and /signup: logged-in users are sent on (back to where they were headed, or home). */
export function RedirectIfAuthenticated() {
  const { status } = useAuth()
  const location = useLocation()
  const from = (location.state as RedirectState | null)?.from

  if (status === 'loading') return <LoadingState />
  if (status === 'authenticated') return <Navigate to={safeRedirect(from)} replace />
  return <Outlet />
}
