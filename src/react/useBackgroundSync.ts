import { useEffect, useRef, useState } from 'react'
import { pushOutbox } from '../sync/push'
import { pullAll, type FetchPage, type PullProgress } from '../sync/pull'
import { holdWakeLock } from '../sync/wake-lock'
import type { EntityKind } from '../sync/db'

type Source = { kind: EntityKind; fetchPage: FetchPage<Record<string, unknown>> }

type State =
  | { phase: 'idle' }
  | { phase: 'syncing'; progress: PullProgress[] }
  | { phase: 'error'; message: string }

const PUSH_INTERVAL_MS = 15_000

/**
 * Drives the sync engine from the UI:
 * - full pull once on mount (resumable), with a wake lock held
 * - periodic outbox push, plus an immediate push when connectivity returns
 * - everything cancelled on unmount via a single AbortController
 */
export function useBackgroundSync(sources: Source[]) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources

  useEffect(() => {
    const abort = new AbortController()
    let release: (() => void) | undefined

    const progress = new Map<EntityKind, PullProgress>()

    async function initialPull() {
      release = await holdWakeLock()
      setState({ phase: 'syncing', progress: [] })
      try {
        for (const { kind, fetchPage } of sourcesRef.current) {
          await pullAll(kind, fetchPage, {
            signal: abort.signal,
            onProgress: (p) => {
              progress.set(p.kind, p)
              setState({ phase: 'syncing', progress: [...progress.values()] })
            },
          })
        }
        await pushOutbox()
        setState({ phase: 'idle' })
      } catch (err) {
        if (abort.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        release?.()
      }
    }

    const push = () => {
      if (navigator.onLine) void pushOutbox().catch(() => undefined)
    }

    void initialPull()
    const timer = setInterval(push, PUSH_INTERVAL_MS)
    window.addEventListener('online', push)

    return () => {
      abort.abort()
      clearInterval(timer)
      window.removeEventListener('online', push)
      release?.()
    }
  }, [])

  return state
}
