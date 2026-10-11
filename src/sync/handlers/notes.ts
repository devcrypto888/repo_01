import { api } from '../../api/client'
import { ApiError } from '../../api/errors'
import { PermanentSyncError, registerPushHandler, type PushResult } from '../push'
import type { LocalRecord, OutboxJob } from '../db'

export interface Note extends Record<string, unknown> {
  title: string
  body: string
  tags: string[]
  locationId?: string | null
  pinned?: boolean
}

interface NoteDto extends Note {
  id: string
  version: number
}

/** Strips client-only bookkeeping fields before anything leaves the device. */
function toPayload(job: OutboxJob) {
  const { __baseVersion, __server, ...rest } = (job.payload ?? {}) as Record<string, unknown>
  return { fields: rest, baseVersion: __baseVersion as number | undefined }
}

async function pushNote(job: OutboxJob, record: LocalRecord): Promise<PushResult> {
  try {
    switch (job.action) {
      case 'create': {
        // The job id doubles as the idempotency key: if the response is lost
        // and we retry, the server returns the note it already created.
        const dto = await api.post<NoteDto>('/notes', toPayload(job).fields, { idempotencyKey: job.id })
        return { kind: 'accepted', remoteId: dto.id, version: dto.version }
      }

      case 'update': {
        const { fields, baseVersion } = toPayload(job)
        const dto = await api.patch<NoteDto>(`/notes/${record.remoteId}`, fields, {
          headers: baseVersion !== undefined ? { 'If-Match': String(baseVersion) } : {},
        })
        return { kind: 'accepted', version: dto.version }
      }

      case 'delete':
        if (!record.remoteId) return { kind: 'gone' }
        await api.delete(`/notes/${record.remoteId}`)
        return { kind: 'accepted' }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.isGone) return { kind: 'gone' }
      if (err.isConflict) {
        const server = err.payload as { current?: NoteDto } | undefined
        if (server?.current) {
          return { kind: 'conflict', serverData: server.current, version: server.current.version }
        }
      }
      if (err.isPermanent) throw new PermanentSyncError(err.message)
    }
    throw err
  }

  throw new PermanentSyncError(`Unsupported action ${job.action as string}`)
}

registerPushHandler('notes', pushNote)

export const fetchNotesPage = (page: number, signal: AbortSignal) =>
  api.get<{ items: NoteDto[]; page: number; totalPages: number; total: number }>('/notes', {
    query: { page, pageSize: 200, includeArchived: false },
    signal,
    timeoutMs: 45_000,
  })
