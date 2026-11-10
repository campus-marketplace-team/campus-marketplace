import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import './index.css'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { UnreadProvider } from './chat/UnreadProvider.tsx'
import { router } from './router.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <UnreadProvider>
        <RouterProvider router={router} />
      </UnreadProvider>
    </AuthProvider>
  </StrictMode>,
)
