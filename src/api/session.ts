const REFRESH_PATH = '/auth/refresh'

/**
 * Refreshes the session cookie. Returns false when the refresh token itself is
 * gone; the caller then surfaces the 401 and the auth guard sends the user to
 * login.
 *
 * Deliberately uses bare fetch, not the api client, so a 401 here can't
 * recurse into another refresh attempt.
 */
export async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? '/api'}${REFRESH_PATH}`, {
      method: 'POST',
      credentials: 'include',
    })
    return res.ok
  } catch {
    // Offline: keep the user in the app. Cached data stays usable and the
    // outbox will retry once we're back.
    return false
  }
}

export interface SessionIdentity {
  userId: string
  tenantId: string
}

const IDENTITY_KEY = 'offline.identity'

export function readStoredIdentity(): SessionIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    return raw ? (JSON.parse(raw) as SessionIdentity) : null
  } catch {
    return null
  }
}

export function storeIdentity(identity: SessionIdentity) {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  } catch {
    // Private mode / quota: the identity guard simply re-checks next launch.
  }
}

export function clearIdentity() {
  try {
    localStorage.removeItem(IDENTITY_KEY)
  } catch {
    /* ignore */
  }
}
