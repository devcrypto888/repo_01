import type { EntityKind, LocalRecord, OutboxJob } from './db'
import { getDb } from './db'
import { withSyncLock } from './lock'
import { complete, listDue, reschedule } from './outbox'

export type PushResult =
  | { kind: 'accepted'; remoteId?: string; version?: number }
  | { kind: 'gone' } // server no longer has it; drop local copy
  | { kind: 'conflict'; serverData: Record<string, unknown>; version: number }

export type PushHandler = (job: OutboxJob, record: LocalRecord) => Promise<PushResult>

/** A 4xx that will never succeed on retry (validation, permissions). */
export class PermanentSyncError extends Error {}

const handlers = new Map<EntityKind, PushHandler>()

export function registerPushHandler(kind: EntityKind, handler: PushHandler) {
  handlers.set(kind, handler)
}

export const pushOutbox = () => withSyncLock(pushOutboxUnlocked)

async function pushOutboxUnlocked() {
  const db = await getDb()

  for (const job of await listDue()) {
    const record = await db.get('records', job.recordKey)

    // Record was removed locally after the job was queued: nothing to send.
    if (!record) {
      await complete(job.id)
      continue
    }

    const handler = handlers.get(job.kind)
    if (!handler) continue // feature not loaded in this build; keep the job

    try {
      const result = await handler(job, record)
      await applyResult(record, job, result)
      await complete(job.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (err instanceof PermanentSyncError) {
        await db.put('records', { ...record, status: 'conflict' })
        await complete(job.id)
        continue
      }

      await reschedule(job.id, message)
    }
  }
}

async function applyResult(record: LocalRecord, job: OutboxJob, result: PushResult) {
  const db = await getDb()

  switch (result.kind) {
    case 'gone':
      await db.delete('records', record.key)
      return

    case 'conflict':
      // Keep local edits, but surface them to the user next to the server copy.
      await db.put('records', {
        ...record,
        status: 'conflict',
        data: { ...record.data, __server: result.serverData },
        baseVersion: result.version,
      })
      return

    case 'accepted':
      if (job.action === 'delete') {
        await db.delete('records', record.key)
        return
      }

      // Another edit may have landed while the request was in flight.
      // Only mark synced if nothing newer is waiting in the outbox.
      const stillPending = await db.countFromIndex('outbox', 'by-recordKey', record.key)
      await db.put('records', {
        ...record,
        remoteId: result.remoteId ?? record.remoteId,
        baseVersion: result.version ?? record.baseVersion,
        status: stillPending > 1 ? record.status : 'synced',
      })
  }
}
