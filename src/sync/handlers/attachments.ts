import { api } from '../../api/client'
import { ApiError } from '../../api/errors'
import { getDb, type LocalRecord, type OutboxJob } from '../db'
import { PermanentSyncError, registerPushHandler, type PushResult } from '../push'
import { getBlob, deleteBlob } from '../blob-store'

/**
 * Photos taken offline. The binary lives in a separate blob store (see
 * blob-store.ts); the record only holds metadata + a blob key.
 *
 * Upload is two-step:
 *   1. ask the API for a presigned PUT URL (cheap, authenticated)
 *   2. PUT the bytes straight to object storage (no app server in the path)
 *   3. confirm, so the server links the object to its parent note
 *
 * If the device dies between 2 and 3, the retry repeats 1–3 with the same
 * idempotency key, and the server returns the same object key, so nothing is
 * orphaned twice.
 */
interface AttachmentData extends Record<string, unknown> {
  blobKey: string
  parentKey: string // local record key of the note it belongs to
  fileName: string
  mimeType: string
  size: number
}

async function pushAttachment(job: OutboxJob, record: LocalRecord): Promise<PushResult> {
  const data = record.data as AttachmentData

  if (job.action === 'delete') {
    if (record.remoteId) await api.delete(`/attachments/${record.remoteId}`)
    await deleteBlob(data.blobKey)
    return { kind: 'accepted' }
  }

  // Parent must exist server-side first. If it's still pending, defer by
  // throwing a retryable error: the outbox backoff handles the ordering.
  const db = await getDb()
  const parent = await db.get('records', data.parentKey)
  if (!parent) return { kind: 'gone' }
  if (!parent.remoteId) throw new Error('Parent note not synced yet')

  const blob = await getBlob(data.blobKey)
  if (!blob) throw new PermanentSyncError('Attachment file missing from device storage')

  try {
    const { uploadUrl, objectKey } = await api.post<{ uploadUrl: string; objectKey: string }>(
      '/attachments/presign',
      { noteId: parent.remoteId, fileName: data.fileName, mimeType: data.mimeType, size: data.size },
      { idempotencyKey: job.id },
    )

    const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': data.mimeType } })
    if (!put.ok) throw new Error(`Storage upload failed: ${put.status}`)

    const created = await api.post<{ id: string; version: number }>(
      '/attachments/confirm',
      { noteId: parent.remoteId, objectKey },
      { idempotencyKey: `${job.id}:confirm` },
    )

    // Keep the local blob as a cache for the thumbnail; it is evicted by the
    // storage-pressure sweep, not here.
    return { kind: 'accepted', remoteId: created.id, version: created.version }
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) {
      throw new PermanentSyncError('File is too large to upload')
    }
    throw err
  }
}

registerPushHandler('attachments', pushAttachment)
