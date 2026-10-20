import { pullAll, type FetchPage } from './pull'
import { pushOutbox } from './push'
import { warmReferenceCache } from './reference-cache'
import { holdWakeLock } from './wake-lock'
import { requestPersistentStorage } from './blob-store'
import type { EntityKind } from './db'
import { useStartupProgress, type PhaseId } from '../store/startup-progress'

/**
 * First-launch / post-login sync. It runs as phases so the progress screen
 * can show what is happening and a failure in one phase doesn't hide the rest.
 *
 *   reference    lookup lists for forms (small, parallel)
 *   push         flush anything created offline before this login
 *   pull:<kind>  full resumable pull per entity kind (large, sequential)
 *
 * A "completed" flag is persisted. After a reload the app opens straight into
 * the cached data and runs a cheap delta sync, not the full walk again.
 */
export interface PullSource {
  kind: EntityKind
  label: string
  fetchPage: FetchPage<Record<string, unknown>>
}

const COMPLETED_KEY = 'offline.startupSync.completedFor'

export function hasCompletedStartupSync(userId: string) {
  try {
    return localStorage.getItem(COMPLETED_KEY) === userId
  } catch {
    return false
  }
}

function markCompleted(userId: string) {
  try {
    localStorage.setItem(COMPLETED_KEY, userId)
  } catch {
    /* quota / private mode: we'll just run the full sync again next time */
  }
}

export function resetStartupSyncFlag() {
  try {
    localStorage.removeItem(COMPLETED_KEY)
  } catch {
    /* ignore */
  }
}

let running: Promise<void> | null = null

/** Idempotent: concurrent callers (StrictMode double effects, two routes) share one run. */
export function runStartupSync(userId: string, sources: PullSource[], signal: AbortSignal) {
  running ??= run(userId, sources, signal).finally(() => {
    running = null
  })
  return running
}

async function run(userId: string, sources: PullSource[], signal: AbortSignal) {
  const progress = useStartupProgress.getState()
  progress.begin([
    { id: 'reference', label: 'Reference data' },
    { id: 'push', label: 'Uploading offline changes' },
    ...sources.map((s) => ({ id: `pull:${s.kind}` as PhaseId, label: s.label })),
  ])

  const release = await holdWakeLock()
  void requestPersistentStorage()

  try {
    await phase('reference', async () => {
      let done = 0
      await warmReferenceCache(() => progress.update('reference', { processed: ++done, total: 4 }))
    })

    await phase('push', () => pushOutbox())

    for (const src of sources) {
      signal.throwIfAborted()
      await phase(`pull:${src.kind}`, () =>
        pullAll(src.kind, src.fetchPage, {
          signal,
          onProgress: (p) => progress.update(`pull:${src.kind}`, { processed: p.processed, total: p.total }),
        }),
      )
    }

    if (useStartupProgress.getState().phases.every((p) => p.status === 'done')) {
      markCompleted(userId)
    }
  } finally {
    release()
    progress.finish()
  }

  async function phase(id: PhaseId, fn: () => Promise<unknown>) {
    progress.start(id)
    try {
      await fn()
      progress.complete(id)
    } catch (err) {
      if (signal.aborted) throw err
      // Record and keep going: partial data beats a blocked app. The progress
      // screen offers "retry failed" for these.
      progress.fail(id, err instanceof Error ? err.message : String(err))
    }
  }
}
