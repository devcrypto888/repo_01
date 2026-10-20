import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { isOfflineError } from '../api/errors'

export interface User {
  id: string
  tenantId: string
  name: string
  roles: string[]
}

type Status = 'loading' | 'authenticated' | 'anonymous'

const CACHE_KEY = 'auth.lastUser'

/**
 * Resolves the current user. When offline, falls back to the last confirmed
 * user so the app still opens in a dead zone. The session cookie is
 * re-validated as soon as the network is back, and a 401 at that point logs
 * the user out properly.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  const revalidate = useCallback(async () => {
    try {
      const me = await api.get<User>('/auth/me', { timeoutMs: 8_000, retries: 0 })
      setUser(me)
      setStatus('authenticated')
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(me)) } catch { /* ignore */ }
    } catch (err) {
      if (isOfflineError(err)) {
        const cached = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as User | null } catch { return null } })()
        setUser(cached)
        setStatus(cached ? 'authenticated' : 'anonymous')
      } else {
        try { localStorage.removeItem(CACHE_KEY) } catch { /* ignore */ }
        setUser(null)
        setStatus('anonymous')
      }
    }
  }, [])

  useEffect(() => {
    void revalidate()
    const onOnline = () => void revalidate()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [revalidate])

  return { user, status, revalidate }
}
