import type { EntityKind } from './db'

/**
 * Cross-tab change notifications. IndexedDB has no change events, so every
 * local write calls notifyChanged(). Subscribers in this tab hear it through
 * an in-memory emitter, and other tabs through a BroadcastChannel.
 */
type Listener = (kind: EntityKind, keys: string[]) => void

const listeners = new Set<Listener>()
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('offline-records') : null

channel?.addEventListener('message', (e: MessageEvent<{ kind: EntityKind; keys: string[] }>) => {
  for (const l of listeners) l(e.data.kind, e.data.keys)
})

// Coalesce bursts: a 500-row pull page fires one notification, not 500.
const pending = new Map<EntityKind, Set<string>>()
let scheduled = false

function flush() {
  scheduled = false
  for (const [kind, keys] of pending) {
    const list = [...keys]
    for (const l of listeners) l(kind, list)
    channel?.postMessage({ kind, keys: list })
  }
  pending.clear()
}

export function notifyChanged(kind: EntityKind, keys: string[]) {
  const set = pending.get(kind) ?? new Set()
  keys.forEach((k) => set.add(k))
  pending.set(kind, set)
  if (!scheduled) {
    scheduled = true
    queueMicrotask(flush)
  }
}

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
