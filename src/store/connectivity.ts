import { create } from 'zustand'

/**
 * navigator.onLine only says whether a network interface is up, not whether
 * the API is reachable (captive portals, dead spots with one bar of signal).
 * We combine it with a lightweight heartbeat and with the outcome of real
 * requests, which are the best evidence we have.
 */
type Quality = 'online' | 'degraded' | 'offline'

interface ConnectivityState {
  quality: Quality
  lastOkAt: number | null
  consecutiveFailures: number
  reportSuccess(): void
  reportFailure(): void
  setBrowserOnline(online: boolean): void
}

export const useConnectivity = create<ConnectivityState>()((set, get) => ({
  quality: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'online',
  lastOkAt: null,
  consecutiveFailures: 0,

  reportSuccess: () => set({ quality: 'online', lastOkAt: Date.now(), consecutiveFailures: 0 }),

  reportFailure: () => {
    const failures = get().consecutiveFailures + 1
    set({ consecutiveFailures: failures, quality: failures >= 3 ? 'offline' : 'degraded' })
  },

  setBrowserOnline: (online) => set(online ? { quality: 'degraded', consecutiveFailures: 0 } : { quality: 'offline' }),
}))

const HEARTBEAT_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 5_000

export function startConnectivityMonitor(pingUrl = '/api/health') {
  const store = useConnectivity.getState()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function ping() {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS)
    try {
      const res = await fetch(pingUrl, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal })
      if (res.ok) useConnectivity.getState().reportSuccess()
      else useConnectivity.getState().reportFailure()
    } catch {
      useConnectivity.getState().reportFailure()
    } finally {
      clearTimeout(t)
      // Back off the heartbeat while offline to save battery.
      const q = useConnectivity.getState().quality
      timer = setTimeout(ping, q === 'offline' ? HEARTBEAT_MS * 4 : HEARTBEAT_MS)
    }
  }

  const onOnline = () => {
    store.setBrowserOnline(true)
    clearTimeout(timer)
    void ping()
  }
  const onOffline = () => store.setBrowserOnline(false)

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  void ping()

  return () => {
    clearTimeout(timer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}
