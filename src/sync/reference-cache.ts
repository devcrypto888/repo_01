import { openDB, type DBSchema } from 'idb'

/**
 * Read-mostly lookup data (categories, locations, user list) used by forms.
 * Stored in its own small DB so wiping the outbox never loses the dropdowns,
 * and the other way round.
 *
 * Stale-while-revalidate: callers always get the cached copy immediately, and
 * a refresh runs in the background once the TTL is exceeded.
 */
export type ReferenceType = 'categories' | 'locations' | 'members' | 'tags'

interface Entry<T = unknown> {
  type: ReferenceType
  items: T[]
  etag?: string
  fetchedAt: number
}

interface RefSchema extends DBSchema {
  reference: { key: ReferenceType; value: Entry }
}

const TTL_MS: Record<ReferenceType, number> = {
  categories: 24 * 3600_000,
  locations: 6 * 3600_000,
  members: 3600_000,
  tags: 6 * 3600_000,
}

const dbp = openDB<RefSchema>('app-reference', 1, {
  upgrade(db) {
    db.createObjectStore('reference', { keyPath: 'type' })
  },
})

const inflight = new Map<ReferenceType, Promise<Entry>>()

async function fetchAndStore(type: ReferenceType, prev?: Entry): Promise<Entry> {
  const existing = inflight.get(type)
  if (existing) return existing

  const p = (async () => {
    const res = await fetch(`/api/reference/${type}`, {
      credentials: 'include',
      headers: prev?.etag ? { 'If-None-Match': prev.etag } : {},
    })

    const db = await dbp
    if (res.status === 304 && prev) {
      const touched = { ...prev, fetchedAt: Date.now() }
      await db.put('reference', touched)
      return touched
    }
    if (!res.ok) throw new Error(`Reference ${type}: ${res.status}`)

    const entry: Entry = {
      type,
      items: await res.json(),
      etag: res.headers.get('ETag') ?? undefined,
      fetchedAt: Date.now(),
    }
    await db.put('reference', entry)
    return entry
  })().finally(() => inflight.delete(type))

  inflight.set(type, p)
  return p
}

export async function getReference<T>(type: ReferenceType): Promise<T[]> {
  const db = await dbp
  const cached = await db.get('reference', type)

  if (!cached) return (await fetchAndStore(type)).items as T[]

  if (Date.now() - cached.fetchedAt > TTL_MS[type] && navigator.onLine) {
    void fetchAndStore(type, cached).catch(() => undefined)
  }
  return cached.items as T[]
}

/** Startup prefetch: best effort, each type independent. */
export async function warmReferenceCache(onEach?: (type: ReferenceType, ok: boolean) => void) {
  const types = Object.keys(TTL_MS) as ReferenceType[]
  await Promise.all(
    types.map(async (t) => {
      try {
        const db = await dbp
        await fetchAndStore(t, await db.get('reference', t))
        onEach?.(t, true)
      } catch {
        onEach?.(t, false)
      }
    }),
  )
}

export async function clearReferenceCache() {
  const db = await dbp
  await db.clear('reference')
}

