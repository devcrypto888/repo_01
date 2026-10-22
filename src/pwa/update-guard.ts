import { useStartupProgress } from '../store/startup-progress'
import { getDb } from '../sync/db'

/**
 * A new service worker must not take over in the middle of a sync. Reloading
 * mid-pull is recoverable thanks to the cursor, but reloading mid-push can
 * lose the response that assigns a remoteId, which then means a duplicate
 * create on retry if the endpoint isn't idempotent.
 *
 * So updates are announced, and applied only when:
 *   - no startup sync is running, and
 *   - the outbox is empty, or the user explicitly confirms.
 */
export interface UpdateHandle {
  apply(force?: boolean): Promise<'applied' | 'deferred'>
}

export function watchForUpdates(onAvailable: (h: UpdateHandle) => void) {
  if (!('serviceWorker' in navigator)) return () => undefined

  let reg: ServiceWorkerRegistration | undefined
  let reloading = false

  const onControllerChange = () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  const handle: UpdateHandle = {
    async apply(force = false) {
      const waiting = reg?.waiting
      if (!waiting) return 'deferred'
      if (!force && !(await isSafeToReload())) return 'deferred'
      waiting.postMessage({ type: 'SKIP_WAITING' })
      return 'applied'
    },
  }

  const track = (r: ServiceWorkerRegistration) => {
    reg = r
    if (r.waiting && navigator.serviceWorker.controller) onAvailable(handle)
    r.addEventListener('updatefound', () => {
      const sw = r.installing
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) onAvailable(handle)
      })
    })
  }

  void navigator.serviceWorker.getRegistration().then((r) => r && track(r))

  // Installed PWAs can stay open for days; check for a new build periodically
  // and whenever the app is brought back to the foreground.
  const check = () => void reg?.update().catch(() => undefined)
  const interval = setInterval(check, 60 * 60_000)
  const onVisible = () => document.visibilityState === 'visible' && check()
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    clearInterval(interval)
    document.removeEventListener('visibilitychange', onVisible)
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }
}

async function isSafeToReload() {
  if (useStartupProgress.getState().active) return false
  const db = await getDb()
  return (await db.count('outbox')) === 0
}
