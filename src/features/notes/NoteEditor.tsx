import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useLocalRecord } from '../../react/useLocalRecords'
import { createLocal, updateLocal, deleteLocal } from '../../sync/records'
import { compressImage, putBlob } from '../../sync/blob-store'
import { ConflictResolver } from '../../components/ConflictResolver'
import type { Note } from '../../sync/handlers/notes'
import { debounce } from '../../lib/debounce'

const schema = z.object({
  title: z.string().trim().max(200),
  body: z.string().max(20_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  pinned: z.boolean().optional(),
})
type FormValues = z.infer<typeof schema>

/**
 * Editor that autosaves to IndexedDB as the user types. There is no "Save"
 * button and no network round trip in the edit path. The outbox handles the
 * server side, and coalesces a burst of keystrokes into one PATCH.
 */
export function NoteEditor({ recordKey, onCreated, onClose }: { recordKey?: string; onCreated: (key: string) => void; onClose: () => void }) {
  const snap = useLocalRecord<Note>(recordKey)
  const record = snap.status === 'ready' ? snap.data : undefined
  const keyRef = useRef(recordKey)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', body: '', tags: [], pinned: false },
  })

  // Hydrate once when the record first loads. Don't reset on every live
  // update, or the cursor would jump while typing.
  const hydrated = useRef(false)
  useEffect(() => {
    if (record && !hydrated.current) {
      hydrated.current = true
      form.reset({ title: record.data.title, body: record.data.body, tags: record.data.tags, pinned: record.data.pinned })
    }
  }, [record, form])

  const persist = useRef(
    debounce(async (values: FormValues, dirty: Partial<Record<keyof FormValues, boolean>>) => {
      if (!keyRef.current) {
        if (!values.title && !values.body) return
        const created = await createLocal<Note>('notes', { ...values, locationId: null })
        keyRef.current = created.key
        onCreated(created.key)
      } else {
        const patch = Object.fromEntries(Object.keys(dirty).map((k) => [k, values[k as keyof FormValues]])) as Partial<Note>
        if (Object.keys(patch).length) await updateLocal<Note>(keyRef.current, patch)
      }
      setSavedAt(Date.now())
    }, 600),
  ).current

  useEffect(() => {
    const sub = form.watch((values, { name }) => {
      const parsed = schema.safeParse(values)
      if (!parsed.success) return
      persist(parsed.data, name ? { [name]: true } : form.formState.dirtyFields)
    })
    return () => {
      sub.unsubscribe()
      persist.flush()
    }
  }, [form, persist])

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length || !keyRef.current) return
    for (const file of Array.from(files)) {
      const blob = await compressImage(file)
      const blobKey = await putBlob(blob)
      await createLocal('attachments', {
        blobKey,
        parentKey: keyRef.current,
        fileName: file.name,
        mimeType: blob.type || file.type,
        size: blob.size,
      })
    }
  }

  if (record?.status === 'conflict') {
    return (
      <ConflictResolver<Note>
        record={record as never}
        fields={[
          { key: 'title', label: 'Title' },
          { key: 'body', label: 'Text' },
          { key: 'tags', label: 'Tags', format: (v) => (v as string[]).join(', ') },
        ]}
        onDone={() => (hydrated.current = false)}
      />
    )
  }

  return (
    <form className="flex h-full flex-col gap-3 p-4" onSubmit={(e) => e.preventDefault()}>
      <input {...form.register('title')} placeholder="Title" className="input text-lg font-medium" autoFocus={!recordKey} />
      <textarea {...form.register('body')} placeholder="Write something…" className="input min-h-[40vh] flex-1 resize-none" />

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <label className="btn-ghost cursor-pointer">
          Add photo
          <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
        </label>
        <span className="flex-1">{savedAt ? 'Saved on this device' : ''}</span>
        {keyRef.current && (
          <button
            type="button"
            className="text-red-600"
            onClick={async () => {
              persist.cancel()
              await deleteLocal(keyRef.current!)
              onClose()
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  )
}
