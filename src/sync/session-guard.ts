import { readStoredIdentity, storeIdentity, clearIdentity, type SessionIdentity } from '../api/session'
import { wipeLocalDb, getDb } from './db'
import { clearReferenceCache } from './reference-cache'
import { resetStartupSyncFlag } from './startup-sync'

/**
 * Guards against one person's offline data leaking into another person's
 * session on a shared device (a common case for tablets handed between shifts).
 *
 * On every authenticated launch we compare the server-confirmed identity with
 * the one the local data was written under. If they differ, everything local
 * goes. Unsent changes from the previous user can't be pushed under the new
 * user's credentials, so they are exported first and handed to the caller,
 * which offers a download instead of silently dropping them.
 */
export interface GuardResult {
  wiped: boolean
  orphanedChanges?: Blob
}

export async function enforceSessionIdentity(current: SessionIdentity): Promise<GuardResult> {
  const stored = readStoredIdentity()

  if (stored && stored.userId === current.userId && stored.tenantId === current.tenantId) {
    return { wiped: false }
  }

  if (!stored) {
    // First run on this device or storage was cleared: claim it.
    storeIdentity(current)
    return { wiped: false }
  }

  const orphanedChanges = await exportUnsynced()
  await wipeAll()
  storeIdentity(current)
  return { wiped: true, orphanedChanges }
}

export async function wipeAll() {
  resetStartupSyncFlag()
  clearIdentity()
  await Promise.allSettled([wipeLocalDb(), clearReferenceCache()])
}

async function exportUnsynced(): Promise<Blob | undefined> {
  try {
    const db = await getDb()
    const outbox = await db.getAll('outbox')
    if (!outbox.length) return undefined

    const records = await Promise.all(outbox.map((j) => db.get('records', j.recordKey)))
    const payload = {
      exportedAt: new Date().toISOString(),
      reason: 'Signed in as a different user while changes were still pending',
      jobs: outbox,
      records: records.filter(Boolean),
    }
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  } catch {
    return undefined
  }
}
