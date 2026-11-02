import { useEffect, useMemo, useState } from 'react'
import { useAuth } from './auth/useAuth'
import { enforceSessionIdentity } from './sync/session-guard'
import { hasCompletedStartupSync, runStartupSync, type PullSource } from './sync/startup-sync'
import { useBackgroundSync } from './react/useBackgroundSync'
import { startConnectivityMonitor } from './store/connectivity'
import { watchForUpdates, type UpdateHandle } from './pwa/update-guard'
import { installBfcacheGuard } from './pwa/bfcache-guard'
import { StartupSyncScreen } from './components/StartupSyncScreen'
import { SyncStatusBadge } from './components/SyncStatusBadge'
import { fetchNotesPage } from './sync/handlers/notes'
import { Router } from './Router'
import './sync/handlers/attachments'

const SOURCES: PullSource[] = [{ kind: 'notes', label: 'Notes', fetchPage: fetchNotesPage as PullSource['fetchPage'] }]

/**
 * Boot order matters:
 *   1. auth confirms who the user is (may be served from cache while offline)
 *   2. identity guard wipes local data if it belongs to someone else
 *   3. first-time sync blocks with a progress screen; later launches don't
 *   4. background sync keeps things fresh from then on
 */
export function App() {
  const { user, status, revalidate } = useAuth()
  const [ready, setReady] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [update, setUpdate] = useState<UpdateHandle | null>(null)
  const [orphanExport, setOrphanExport] = useState<Blob | null>(null)

  useEffect(() => startConnectivityMonitor(), [])
  useEffect(() => watchForUpdates(setUpdate), [])
  useEffect(() => installBfcacheGuard(() => void revalidate()), [revalidate])

  useEffect(() => {
    if (status !== 'authenticated' || !user) return
    const abort = new AbortController()

    ;(async () => {
      const guard = await enforceSessionIdentity({ userId: user.id, tenantId: user.tenantId })
      if (guard.orphanedChanges) setOrphanExport(guard.orphanedChanges)

      if (!hasCompletedStartupSync(user.id)) {
        setBlocking(true)
        await runStartupSync(user.id, SOURCES, abort.signal).catch(() => undefined)
      }
      setReady(true)
    })()

    return () => abort.abort()
  }, [status, user])

  const sources = useMemo(() => (ready ? SOURCES : []), [ready])
  useBackgroundSync(sources)

  if (status === 'loading') return null
  if (status !== 'authenticated') return <Router.Login />

  if (blocking && !ready) {
    return (
      <StartupSyncScreen
        onRetryFailed={() => user && void runStartupSync(user.id, SOURCES, new AbortController().signal)}
        onContinue={() => setReady(true)}
      />
    )
  }

  return (
    <>
      <header className="flex items-center justify-between border-b px-4 py-2">
        <span className="font-semibold">Field notes</span>
        <SyncStatusBadge />
      </header>

      {update && (
        <div className="bg-sky-50 px-4 py-2 text-sm">
          A new version is available.{' '}
          <button
            className="underline"
            onClick={async () => {
              if ((await update.apply()) === 'deferred') {
                // Unsent changes: ask before reloading.
                if (window.confirm('Some changes have not been uploaded yet. Update anyway?')) await update.apply(true)
              }
            }}
          >
            Update now
          </button>
        </div>
      )}

      {orphanExport && (
        <div className="bg-amber-50 px-4 py-2 text-sm">
          Changes from a previous sign-in could not be uploaded.{' '}
          <a href={URL.createObjectURL(orphanExport)} download="unsent-changes.json" className="underline">
            Download them
          </a>
        </div>
      )}

      <Router.App />
    </>
  )
}
