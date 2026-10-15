import { getDb, type EntityKind, type LocalRecord, type SyncStatus } from './db'
import { enqueue } from './outbox'
import { notifyChanged } from './broadcast'

export const recordKey = (kind: EntityKind, localId: string) => `${kind}:${localId}`

export async function getRecord<T>(key: string) {
  const db = await getDb()
  return (await db.get('records', key)) as LocalRecord<T> | undefined
}

export async function listRecords<T>(kind: EntityKind, opts: { includeDeleted?: boolean } = {}) {
  const db = await getDb()
  const all = (await db.getAllFromIndex('records', 'by-kind', kind)) as LocalRecord<T>[]
  return opts.includeDeleted ? all : all.filter((r) => !r.deletedAt)
}

export async function findByRemoteId<T>(remoteId: string) {
  const db = await getDb()
  return (await db.getFromIndex('records', 'by-remoteId', remoteId)) as LocalRecord<T> | undefined
}

export async function countByStatus(status: SyncStatus) {
  const db = await getDb()
  return db.countFromIndex('records', 'by-status', status)
}

/**
 * Creates a record locally and queues it for the server. The UI gets a stable
 * localId right away; the remoteId arrives whenever the device is next online.
 */
export async function createLocal<T extends Record<string, unknown>>(kind: EntityKind, data: T) {
  const db = await getDb()
  const localId = crypto.randomUUID()
  const record: LocalRecord<T> = {
    key: recordKey(kind, localId),
    kind,
    localId,
    data,
    status: 'pending-create',
    updatedAt: Date.now(),
  }
  await db.put('records', record as LocalRecord)
  await enqueue({ recordKey: record.key, kind, action: 'create', payload: data })
  notifyChanged(kind, [record.key])
  return record
}

/**
 * Applies a partial update. Only the changed fields go into the outbox
 * payload, so two devices editing different fields of the same record merge
 * cleanly on the server.
 */
export async function updateLocal<T extends Record<string, unknown>>(key: string, patch: Partial<T>) {
  const db = await getDb()
  const tx = db.transaction('records', 'readwrite')
  const current = (await tx.store.get(key)) as LocalRecord<T> | undefined
  if (!current) throw new Error(`Record ${key} not found`)

  const next: LocalRecord<T> = {
    ...current,
    data: { ...current.data, ...patch },
    status: current.status === 'pending-create' || current.status === 'local-only' ? current.status : 'pending-update',
    updatedAt: Date.now(),
  }
  await tx.store.put(next as LocalRecord)
  await tx.done

  await enqueue({
    recordKey: key,
    kind: current.kind,
    action: 'update',
    payload: { ...patch, __baseVersion: current.baseVersion },
  })
  notifyChanged(current.kind, [key])
  return next
}

/** Soft delete: hidden from lists immediately, physically removed after the server confirms. */
export async function deleteLocal(key: string) {
  const db = await getDb()
  const current = await db.get('records', key)
  if (!current) return

  if (!current.remoteId) {
    // Never reached the server: nothing to tell it, just forget it.
    await enqueue({ recordKey: key, kind: current.kind, action: 'delete' })
    await db.delete('records', key)
  } else {
    await db.put('records', { ...current, status: 'pending-delete', deletedAt: Date.now(), updatedAt: Date.now() })
    await enqueue({ recordKey: key, kind: current.kind, action: 'delete' })
  }
  notifyChanged(current.kind, [key])
}

/** User picked a side in the conflict dialog. */
export async function resolveConflict<T extends Record<string, unknown>>(
  key: string,
  choice: 'mine' | 'theirs' | { merged: T },
) {
  const db = await getDb()
  const current = (await db.get('records', key)) as LocalRecord<T & { __server?: T }> | undefined
  if (!current || current.status !== 'conflict') return

  const { __server: server, ...mine } = current.data

  if (choice === 'theirs') {
    await db.put('records', { ...current, data: server ?? mine, status: 'synced', updatedAt: Date.now() } as LocalRecord)
  } else {
    const data = choice === 'mine' ? mine : choice.merged
    await db.put('records', { ...current, data, status: 'pending-update', updatedAt: Date.now() } as LocalRecord)
    // baseVersion was bumped to the server version when the conflict was
    // recorded, so this push is now a deliberate overwrite of that version.
    await enqueue({ recordKey: key, kind: current.kind, action: 'update', payload: { ...data, __baseVersion: current.baseVersion } })
  }
  notifyChanged(current.kind, [key])
}
