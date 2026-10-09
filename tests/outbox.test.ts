import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueue, listDue, backoffMs, reschedule } from '../src/sync/outbox'
import { closeDb, getDb } from '../src/sync/db'

async function reset() {
  await closeDb()
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase('app-offline')
    req.onsuccess = req.onerror = () => r()
  })
}

describe('outbox', () => {
  beforeEach(reset)

  it('folds an update into a pending create', async () => {
    await enqueue({ recordKey: 'notes:1', kind: 'notes', action: 'create', payload: { title: 'a', body: '' } })
    await enqueue({ recordKey: 'notes:1', kind: 'notes', action: 'update', payload: { body: 'hello' } })

    const jobs = await listDue()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].action).toBe('create')
    expect(jobs[0].payload).toEqual({ title: 'a', body: 'hello' })
  })

  it('create + delete of an unsynced record cancels out', async () => {
    await enqueue({ recordKey: 'notes:2', kind: 'notes', action: 'create', payload: { title: 'x' } })
    await enqueue({ recordKey: 'notes:2', kind: 'notes', action: 'update', payload: { title: 'y' } })
    await enqueue({ recordKey: 'notes:2', kind: 'notes', action: 'delete' })

    expect(await listDue()).toHaveLength(0)
  })

  it('keeps separate jobs for a synced record', async () => {
    await enqueue({ recordKey: 'notes:3', kind: 'notes', action: 'update', payload: { title: 'a' } })
    await enqueue({ recordKey: 'notes:3', kind: 'notes', action: 'update', payload: { body: 'b' } })
    expect(await listDue()).toHaveLength(2)
  })

  it('returns due jobs in creation order', async () => {
    // Only fake Date: fake-indexeddb schedules its work on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      await enqueue({ recordKey: 'notes:b', kind: 'notes', action: 'update' })
      vi.setSystemTime(500)
      await enqueue({ recordKey: 'notes:a', kind: 'notes', action: 'update' })
      vi.setSystemTime(2_000)

      const jobs = await listDue()
      expect(jobs.map((j) => j.recordKey)).toEqual(['notes:a', 'notes:b'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reschedule pushes a job out of the due window', async () => {
    const job = await enqueue({ recordKey: 'notes:4', kind: 'notes', action: 'update' })
    await reschedule(job.id, 'boom')

    expect(await listDue()).toHaveLength(0)
    const stored = await (await getDb()).get('outbox', job.id)
    expect(stored?.attempts).toBe(1)
    expect(stored?.lastError).toBe('boom')
  })

  it.each([
    [0, 30_000],
    [1, 60_000],
    [4, 480_000],
    [10, 900_000],
  ])('backoff for attempt %i is %i ms', (attempts, expected) => {
    expect(backoffMs(attempts)).toBe(expected)
  })
})
