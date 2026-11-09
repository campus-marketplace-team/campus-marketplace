import { createBrowserRouter } from 'react-router'
import { RedirectIfAuthenticated, RequireAdmin, RequireAuth } from './auth/RequireAuth'
import { LoadingState } from './components'
import { AppLayout } from './layout/AppLayout'
import { LoginPage } from './pages/auth/LoginPage'
import { SignupPage } from './pages/auth/SignupPage'
import { BrowsePage } from './pages/listings/BrowsePage'
import { ListingDetailPage } from './pages/listings/ListingDetailPage'
import { SellPage } from './pages/listings/SellPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { MyStuffPage } from './pages/me/MyStuffPage'
import { HandoffQrPage } from './pages/orders/HandoffQrPage'
import { OrderStatusPage } from './pages/orders/OrderStatusPage'
import { ReportProblemPage } from './pages/orders/ReportProblemPage'
import { ScanPage } from './pages/orders/ScanPage'
import { RouteErrorPage } from './pages/RouteErrorPage'

// Every page renders inside AppLayout. Add new routes as children here:
// public pages at the top level, logged-in-only pages under RequireAuth.
// Unknown paths also render inside the layout (vercel.json rewrites all paths to index.html).
// A page that throws (or whose code fails to download) shows RouteErrorPage inside the layout.
export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    // Shown while a lazy page (the admin dashboard) downloads on a direct visit.
    hydrateFallbackElement: <LoadingState />,
    // Errors in the layout itself; page errors are caught by the route below, inside the layout.
    errorElement: <RouteErrorPage />,
    children: [
      {
        errorElement: <RouteErrorPage />,
        children: [
          { path: '/', element: <BrowsePage /> },
          { path: '/listings/:listingId', element: <ListingDetailPage /> },
          {
            element: <RequireAuth />,
            children: [
              { path: '/sell', element: <SellPage /> },
              { path: '/me', element: <MyStuffPage /> },
              { path: '/orders/:orderId', element: <OrderStatusPage /> },
              { path: '/orders/:orderId/handoff', element: <HandoffQrPage /> },
              { path: '/orders/:orderId/report', element: <ReportProblemPage /> },
              { path: '/scan', element: <ScanPage /> },
              {
                element: <RequireAdmin />,
                // Lazy so AG Grid only downloads for admins who open the dashboard.
                children: [
                  {
                    path: '/admin',
                    lazy: async () => ({ Component: (await import('./pages/admin/AdminDashboardPage')).AdminDashboardPage }),
                  },
                ],
              },
            ],
          },
          {
            element: <RedirectIfAuthenticated />,
            children: [
              { path: '/login', element: <LoginPage /> },
              { path: '/signup', element: <SignupPage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
