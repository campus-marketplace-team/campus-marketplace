import { Link, NavLink, Outlet, useNavigate, useNavigation } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Button, ButtonLink } from '../components'
import './layout.css'

const navItems = [
  { to: '/', label: 'Browse', end: true },
  { to: '/sell', label: 'Sell' },
  { to: '/me', label: 'My stuff' },
]

/** Shell shared by every page: header + nav on top, routed page below. */
export function AppLayout() {
  const auth = useAuth()
  const navigation = useNavigation()
  const items =
    auth.status === 'authenticated' && auth.user.isAdmin ? [...navItems, { to: '/admin', label: 'Admin' }] : navItems
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="app-header__brand">
            <span className="app-header__logo" aria-hidden="true">
              CM
            </span>
            Campus Marketplace
          </Link>
          <nav className="app-nav" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => (isActive ? 'app-nav__link app-nav__link--active' : 'app-nav__link')}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <HeaderAuth />
        </div>
      </header>
      {/* While a lazy page (the admin dashboard) downloads after a click, the old page stays up. */}
      {navigation.state === 'loading' && <div className="app-progress" role="progressbar" aria-label="Loading page" />}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}

function HeaderAuth() {
  const auth = useAuth()
  const navigate = useNavigate()

  if (auth.status === 'loading') return <div className="app-header__auth" />

  if (auth.status === 'authenticated') {
    return (
      <div className="app-header__auth">
        <span className="app-header__user" title={auth.user.email}>
          Hi, {auth.user.displayName}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            auth.logout()
            navigate('/')
          }}
        >
          Log out
        </Button>
      </div>
    )
  }

  return (
    <div className="app-header__auth">
      <ButtonLink to="/login" variant="ghost" size="sm">
        Log in
      </ButtonLink>
      <ButtonLink to="/signup" size="sm">
        Sign up
      </ButtonLink>
    </div>
  )
}
