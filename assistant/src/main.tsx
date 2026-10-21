import './zod-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { captureInviteFromUrl } from './features/team/pendingInvite'

captureInviteFromUrl() // must run before the router reads the URL: it stores the token and clears it from the address bar

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
