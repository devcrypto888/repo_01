import { getDb, type EntityKind, type OutboxJob, type SyncAction } from './db'

export async function enqueue(input: {
  recordKey: string
  kind: EntityKind
  action: SyncAction
  payload?: Record<string, unknown>
}): Promise<OutboxJob> {
  const db = await getDb()
  const tx = db.transaction('outbox', 'readwrite')

  // Collapse redundant work: an update queued behind a still-pending create
  // is folded into that create instead of becoming a second request.
  const existing = await tx.store.index('by-recordKey').getAll(input.recordKey)
  const pendingCreate = existing.find((j) => j.action === 'create')

  if (pendingCreate && input.action === 'update') {
    const merged = { ...pendingCreate, payload: { ...pendingCreate.payload, ...input.payload } }
    await tx.store.put(merged)
    await tx.done
    return merged
  }

  // Deleting something the server has never seen: drop every queued job for it.
  if (pendingCreate && input.action === 'delete') {
    await Promise.all(existing.map((j) => tx.store.delete(j.id)))
    await tx.done
    return { ...pendingCreate, action: 'delete' }
  }

  const job: OutboxJob = {
    id: crypto.randomUUID(),
    ...input,
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
  }
  await tx.store.put(job)
  await tx.done
  return job
}

export async function listDue(now = Date.now()) {
  const db = await getDb()
  const jobs = await db.getAllFromIndex('outbox', 'by-nextAttemptAt', IDBKeyRange.upperBound(now))
  return jobs.sort((a, b) => a.createdAt - b.createdAt)
}

export async function complete(id: string) {
  const db = await getDb()
  await db.delete('outbox', id)
}

/** Exponential backoff: 30s, 60s, 120s ... capped at 15 minutes. */
export function backoffMs(attempts: number) {
  return Math.min(30_000 * 2 ** attempts, 15 * 60_000)
}

export async function reschedule(id: string, error: string) {
  const db = await getDb()
  const job = await db.get('outbox', id)
  if (!job) return

  await db.put('outbox', {
    ...job,
    attempts: job.attempts + 1,
    nextAttemptAt: Date.now() + backoffMs(job.attempts),
    lastError: error,
  })
}
