// The invitation token arrives in the URL (/invite/<token>). It is removed from the address bar immediately (so it does not
// linger in history, screenshots or referrers) and kept in localStorage only until the invitation has been accepted or has failed,
// so it survives the sign-up -> e-mail-confirmation round trip. Possession of the token alone grants nothing: the server also
// requires a signed-in user whose confirmed e-mail matches the invited address.

const KEY = 'pendingInvite'
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/

const read = (): string | null => { try { return localStorage.getItem(KEY) } catch { return null } }

export function getPendingInvite(): string | null {
  const t = read()
  return t && TOKEN_RE.test(t) ? t : null
}

export function clearPendingInvite(): void {
  try { localStorage.removeItem(KEY) } catch { /* private mode */ }
}

/** Call once at startup. Stores a valid token from /invite/<token> and rewrites the URL to "/". Returns the stored token. */
export function captureInviteFromUrl(loc: Pick<Location, 'pathname'> = window.location, hist: Pick<History, 'replaceState'> = window.history): string | null {
  const m = /^\/invite\/([^/?#]+)\/?$/.exec(loc.pathname)
  if (!m) return getPendingInvite()
  let token = m[1]
  try { token = decodeURIComponent(token) } catch { /* keep raw */ }
  hist.replaceState(null, '', '/') // always drop it from the address bar, valid or not
  if (!TOKEN_RE.test(token)) return getPendingInvite()
  try { localStorage.setItem(KEY, token) } catch { /* private mode: the token then only lives for this page load */ }
  return token
}
