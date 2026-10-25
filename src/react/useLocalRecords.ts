import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { EntityKind, LocalRecord } from '../sync/db'
import { listRecords, getRecord } from '../sync/records'
import { subscribe } from '../sync/broadcast'

/**
 * Live query over the local store: React reads straight from IndexedDB and
 * re-renders when any tab writes to the same kind.
 *
 * Implemented as an external store (useSyncExternalStore) rather than
 * useState+useEffect, so concurrent rendering never tears between two
 * components reading the same list.
 */
type Snapshot<T> = { status: 'loading' } | { status: 'ready'; data: T }

function createLiveStore<T>(kind: EntityKind, load: () => Promise<T>, filterKeys?: (keys: string[]) => boolean) {
  let snapshot: Snapshot<T> = { status: 'loading' }
  const subs = new Set<() => void>()
  let version = 0

  const refresh = async () => {
    const v = ++version
    const data = await load()
    if (v !== version) return // a newer refresh superseded this one
    snapshot = { status: 'ready', data }
    subs.forEach((s) => s())
  }

  return {
    subscribe(cb: () => void) {
      subs.add(cb)
      if (subs.size === 1) void refresh()
      const unsub = subscribe((k, keys) => {
        if (k === kind && (!filterKeys || filterKeys(keys))) void refresh()
      })
      return () => {
        subs.delete(cb)
        unsub()
      }
    },
    getSnapshot: () => snapshot,
  }
}

export function useLocalRecords<T>(
  kind: EntityKind,
  select?: (rows: LocalRecord<T>[]) => LocalRecord<T>[],
  deps: unknown[] = [],
) {
  const selectRef = useRef(select)
  selectRef.current = select

  const store = useMemo(
    () =>
      createLiveStore(kind, async () => {
        const rows = await listRecords<T>(kind)
        return selectRef.current ? selectRef.current(rows) : rows
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, ...deps],
  )

  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useLocalRecord<T>(key: string | undefined) {
  const kind = key?.split(':')[0] as EntityKind | undefined
  const store = useMemo(
    () => (key && kind ? createLiveStore(kind, () => getRecord<T>(key), (keys) => keys.includes(key)) : null),
    [key, kind],
  )

  const noop = useMemo(() => ({ subscribe: () => () => undefined, getSnapshot: () => ({ status: 'loading' }) as Snapshot<undefined> }), [])
  const s = store ?? noop
  return useSyncExternalStore(s.subscribe, s.getSnapshot) as Snapshot<LocalRecord<T> | undefined>
}

/** Count of unsent changes, for the sync badge. Polls cheaply because outbox writes aren't broadcast. */
export function usePendingCount(intervalMs = 3_000) {
  const ref = useRef(0)
  const store = useMemo(() => {
    const subs = new Set<() => void>()
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = async () => {
      const { getDb } = await import('../sync/db')
      const n = await (await getDb()).count('outbox')
      if (n !== ref.current) {
        ref.current = n
        subs.forEach((s) => s())
      }
    }
    return {
      subscribe(cb: () => void) {
        subs.add(cb)
        if (subs.size === 1) {
          void tick()
          timer = setInterval(tick, intervalMs)
        }
        return () => {
          subs.delete(cb)
          if (!subs.size) clearInterval(timer)
        }
      },
      getSnapshot: () => ref.current,
    }
  }, [intervalMs])

  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
