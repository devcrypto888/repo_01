import { useMemo, useState } from 'react'
import type { LocalRecord } from '../sync/db'
import { resolveConflict } from '../sync/records'

interface Props<T extends Record<string, unknown>> {
  record: LocalRecord<T & { __server?: T }>
  /** Human labels for fields; fields not listed here are not shown. */
  fields: { key: keyof T & string; label: string; format?: (v: unknown) => string }[]
  onDone: () => void
}

/**
 * Field-level three-way choice. Only fields that actually differ are shown,
 * and each one can be taken from "mine" or "theirs". This beats a whole-record
 * "keep mine / keep theirs" when two people edited different parts.
 */
export function ConflictResolver<T extends Record<string, unknown>>({ record, fields, onDone }: Props<T>) {
  const { __server: server, ...mine } = record.data
  const theirs = (server ?? {}) as T

  const diffs = useMemo(
    () => fields.filter((f) => JSON.stringify(mine[f.key]) !== JSON.stringify(theirs[f.key])),
    [fields, mine, theirs],
  )

  const [pick, setPick] = useState<Record<string, 'mine' | 'theirs'>>(() =>
    Object.fromEntries(diffs.map((d) => [d.key, 'mine'])),
  )
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const merged = { ...theirs } as T
    for (const d of diffs) {
      ;(merged as Record<string, unknown>)[d.key] = pick[d.key] === 'mine' ? mine[d.key] : theirs[d.key]
    }
    const allTheirs = diffs.every((d) => pick[d.key] === 'theirs')
    await resolveConflict<T>(record.key, allTheirs ? 'theirs' : { merged })
    setSaving(false)
    onDone()
  }

  const fmt = (f: (typeof fields)[number], v: unknown) => (f.format ? f.format(v) : v == null || v === '' ? '—' : String(v))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        This item was changed on another device while you were offline. Choose which version to keep for each field.
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted-foreground">
            <th className="py-1">Field</th>
            <th>Your version</th>
            <th>Server version</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((f) => (
            <tr key={f.key} className="border-t align-top">
              <td className="py-2 pr-2 font-medium">{f.label}</td>
              {(['mine', 'theirs'] as const).map((side) => (
                <td key={side} className="py-2 pr-2">
                  <label className={`block cursor-pointer rounded-md border p-2 ${pick[f.key] === side ? 'border-primary bg-primary/5' : ''}`}>
                    <input
                      type="radio"
                      className="sr-only"
                      name={f.key}
                      checked={pick[f.key] === side}
                      onChange={() => setPick((p) => ({ ...p, [f.key]: side }))}
                    />
                    <span className="whitespace-pre-wrap break-words">{fmt(f, side === 'mine' ? mine[f.key] : theirs[f.key])}</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => setPick(Object.fromEntries(diffs.map((d) => [d.key, 'theirs'])))}>
          Use all server
        </button>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save choice'}
        </button>
      </div>
    </div>
  )
}
