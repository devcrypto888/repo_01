import { getDb, type EntityKind, type LocalRecord, type PullCursor } from './db'
import { withSyncLock } from './lock'

export interface RemotePage<T> {
  items: (T & { id: string; version: number })[]
  page: number
  totalPages: number
  total: number
}

export type FetchPage<T> = (page: number, signal: AbortSignal) => Promise<RemotePage<T>>

export interface PullProgress {
  kind: EntityKind
  processed: number
  total: number
}

const PAGE_FLUSH_EVERY = 1

/**
 * Walks every server page for `kind` and reconciles it into the local store.
 *
 * - Resumable: progress is persisted after each page, so a reload, sleep or
 *   lost connection continues from the last page instead of starting over.
 * - Local edits win: records with pending changes are never overwritten.
 * - Deletions: once the full walk completes, synced local records whose
 *   remoteId was not seen on any page are removed.
 */
export function pullAll<T extends Record<string, unknown>>(
  kind: EntityKind,
  fetchPage: FetchPage<T>,
  opts: { signal: AbortSignal; onProgress?: (p: PullProgress) => void },
) {
  return withSyncLock(() => pullAllUnlocked(kind, fetchPage, opts))
}

async function pullAllUnlocked<T extends Record<string, unknown>>(
  kind: EntityKind,
  fetchPage: FetchPage<T>,
  { signal, onProgress }: { signal: AbortSignal; onProgress?: (p: PullProgress) => void },
) {
  const db = await getDb()

  let cursor: PullCursor = (await db.get('pullCursors', kind)) ?? {
    kind,
    nextPage: 1,
    seenRemoteIds: [],
    processed: 0,
    total: 0,
    updatedAt: Date.now(),
  }
  const seen = new Set(cursor.seenRemoteIds)

  for (;;) {
    signal.throwIfAborted()

    const page = await fetchPage(cursor.nextPage, signal)
    await mergePage(kind, page.items)
    page.items.forEach((item) => seen.add(item.id))

    cursor = {
      ...cursor,
      nextPage: page.page + 1,
      seenRemoteIds: [...seen],
      processed: cursor.processed + page.items.length,
      total: page.total,
      updatedAt: Date.now(),
    }

    if (page.page % PAGE_FLUSH_EVERY === 0) await db.put('pullCursors', cursor)
    onProgress?.({ kind, processed: cursor.processed, total: cursor.total })

    if (page.page >= page.totalPages) break
  }

  await pruneMissing(kind, seen)
  await db.delete('pullCursors', kind)
}

async function mergePage<T extends Record<string, unknown>>(
  kind: EntityKind,
  items: (T & { id: string; version: number })[],
) {
  const db = await getDb()
  const tx = db.transaction('records', 'readwrite')
  const byRemoteId = tx.store.index('by-remoteId')

  for (const item of items) {
    const local = await byRemoteId.get(item.id)

    if (local && local.status !== 'synced') continue // unsent local edits win
    if (local && (local.baseVersion ?? 0) >= item.version) continue // nothing new

    const next: LocalRecord = {
      key: local?.key ?? `${kind}:${item.id}`,
      kind,
      localId: local?.localId ?? item.id,
      remoteId: item.id,
      data: item,
      status: 'synced',
      baseVersion: item.version,
      updatedAt: Date.now(),
    }
    await tx.store.put(next)
  }

  await tx.done
}

async function pruneMissing(kind: EntityKind, seen: Set<string>) {
  const db = await getDb()
  const tx = db.transaction('records', 'readwrite')
  let cursor = await tx.store.index('by-kind').openCursor(kind)

  while (cursor) {
    const r = cursor.value
    if (r.status === 'synced' && r.remoteId && !seen.has(r.remoteId)) {
      await cursor.delete()
    }
    cursor = await cursor.continue()
  }

  await tx.done
}
