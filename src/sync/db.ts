import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb'

export type EntityKind = 'notes' | 'checklists' | 'attachments'

export type SyncStatus =
  | 'local-only'
  | 'pending-create'
  | 'pending-update'
  | 'pending-delete'
  | 'synced'
  | 'conflict'

export type SyncAction = 'create' | 'update' | 'delete'

/** Locally stored copy of a server entity (or one that does not exist on the server yet). */
export interface LocalRecord<T = Record<string, unknown>> {
  /** Stable client-side key: `${kind}:${localId}` */
  key: string
  kind: EntityKind
  localId: string
  /** Assigned once the server has accepted the create. */
  remoteId?: string
  data: T
  status: SyncStatus
  /** Server-side version we last saw; used for optimistic concurrency. */
  baseVersion?: number
  updatedAt: number
  deletedAt?: number | null
}

export interface OutboxJob {
  id: string
  recordKey: string
  kind: EntityKind
  action: SyncAction
  payload?: Record<string, unknown>
  attempts: number
  nextAttemptAt: number
  createdAt: number
  lastError?: string
}

/** Resume point for a paginated "pull everything from server" pass. */
export interface PullCursor {
  kind: EntityKind
  nextPage: number
  seenRemoteIds: string[]
  processed: number
  total: number
  updatedAt: number
}

interface AppSchema extends DBSchema {
  records: {
    key: string
    value: LocalRecord
    indexes: {
      'by-kind': EntityKind
      'by-remoteId': string
      'by-status': SyncStatus
    }
  }
  outbox: {
    key: string
    value: OutboxJob
    indexes: {
      'by-recordKey': string
      'by-nextAttemptAt': number
    }
  }
  pullCursors: {
    key: EntityKind
    value: PullCursor
  }
}

const DB_NAME = 'app-offline'
const DB_VERSION = 3

let connection: Promise<IDBPDatabase<AppSchema>> | null = null

function open() {
  return openDB<AppSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Each step is idempotent so a client can jump several versions at once.
      if (oldVersion < 1) {
        const records = db.createObjectStore('records', { keyPath: 'key' })
        records.createIndex('by-kind', 'kind')
        records.createIndex('by-remoteId', 'remoteId')
        records.createIndex('by-status', 'status')
      }
      if (oldVersion < 2) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' })
        outbox.createIndex('by-recordKey', 'recordKey')
        outbox.createIndex('by-nextAttemptAt', 'nextAttemptAt')
      }
      if (oldVersion < 3) {
        db.createObjectStore('pullCursors', { keyPath: 'kind' })
      }
    },

    // Another tab (or our own wipe) wants exclusive access for an upgrade/delete.
    // deleteDatabase() never force-closes a live connection, so we must yield ours.
    blocking() {
      void closeDb()
    },

    // Browser killed the connection abnormally: drop the cached handle so the
    // next call reopens instead of returning a dead connection.
    terminated() {
      connection = null
    },
  })
}

export function getDb() {
  connection ??= open()
  return connection
}

export async function closeDb() {
  if (!connection) return
  const db = await connection
  db.close()
  connection = null
}

const WIPE_TIMEOUT_MS = 3_000

/**
 * Wipes all local state (logout, account switch).
 *
 * A tab running an older build may not have the `blocking` handler and will
 * hold its connection forever, leaving the delete request "blocked". We can't
 * force it, so race against a timeout: the caller proceeds, and the browser
 * finishes the delete in the background once the old tab lets go.
 */
export async function wipeLocalDb(): Promise<'done' | 'errored' | 'timed-out'> {
  await closeDb()

  const attempt = deleteDB(DB_NAME, {
    blocked: (version) => console.warn('[offline] wipe blocked by another connection', { version }),
  })
    .then(() => 'done' as const)
    .catch(() => 'errored' as const)

  const timeout = new Promise<'timed-out'>((r) => setTimeout(() => r('timed-out'), WIPE_TIMEOUT_MS))

  return Promise.race([attempt, timeout])
}
