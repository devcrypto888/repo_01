import { useDeferredValue, useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useLocalRecords } from '../../react/useLocalRecords'
import type { LocalRecord } from '../../sync/db'
import type { Note } from '../../sync/handlers/notes'
import { foldForSearch } from '../../lib/search'

/**
 * Lists tens of thousands of notes from IndexedDB with instant search.
 *
 * - The search index is built once per data change, and keystrokes only scan
 *   it. useDeferredValue keeps typing responsive while the filter runs.
 * - Virtualized rows: the DOM stays at about 30 nodes regardless of list size.
 * - Unsynced and conflicted items are visually marked.
 */
export function NotesList({ onOpen }: { onOpen: (key: string) => void }) {
  const snap = useLocalRecords<Note>('notes', (rows) =>
    rows.sort((a, b) => Number(b.data.pinned ?? 0) - Number(a.data.pinned ?? 0) || b.updatedAt - a.updatedAt),
  )
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)

  const rows = snap.status === 'ready' ? snap.data : []

  const index = useMemo(
    () => rows.map((r) => ({ r, hay: foldForSearch(`${r.data.title} ${r.data.body} ${r.data.tags.join(' ')}`) })),
    [rows],
  )

  const filtered = useMemo(() => {
    const terms = foldForSearch(deferred).split(/\s+/).filter(Boolean)
    if (!terms.length) return rows
    return index.filter(({ hay }) => terms.every((t) => hay.includes(t))).map(({ r }) => r)
  }, [index, rows, deferred])

  if (snap.status === 'loading') return <div className="p-4 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${rows.length.toLocaleString()} notes`}
          className="input w-full"
        />
      </div>
      <Virtuoso
        className="flex-1"
        data={filtered}
        computeItemKey={(_, r) => r.key}
        itemContent={(_, r) => <NoteRow record={r} onOpen={onOpen} stale={query !== deferred} />}
      />
    </div>
  )
}

function NoteRow({ record, onOpen, stale }: { record: LocalRecord<Note>; onOpen: (k: string) => void; stale: boolean }) {
  const mark =
    record.status === 'conflict'
      ? <span className="pill bg-red-100 text-red-800">Needs review</span>
      : record.status !== 'synced'
        ? <span className="pill bg-sky-100 text-sky-800">Not uploaded</span>
        : null

  return (
    <button
      onClick={() => onOpen(record.key)}
      className={`flex w-full flex-col items-start gap-0.5 border-b px-4 py-3 text-left hover:bg-muted/40 ${stale ? 'opacity-70' : ''}`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="flex-1 truncate font-medium">{record.data.title || 'Untitled'}</span>
        {mark}
      </div>
      <span className="line-clamp-2 text-sm text-muted-foreground">{record.data.body}</span>
    </button>
  )
}
