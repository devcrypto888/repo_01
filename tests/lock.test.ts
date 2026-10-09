import { describe, expect, it } from 'vitest'
import { withSyncLock } from '../src/sync/lock'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('withSyncLock', () => {
  it('never runs two callers at once', async () => {
    let active = 0
    let maxActive = 0
    const job = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick(5)
      active--
    }

    await Promise.all([withSyncLock(job), withSyncLock(job), withSyncLock(job)])
    expect(maxActive).toBe(1)
  })

  it('preserves call order', async () => {
    const order: number[] = []
    await Promise.all([3, 1, 2].map((n) => withSyncLock(async () => { await tick(n); order.push(n) })))
    expect(order).toEqual([3, 1, 2])
  })

  it('a failing caller does not block the next one', async () => {
    const failing = withSyncLock(async () => { throw new Error('nope') })
    const next = withSyncLock(async () => 'ok')
    await expect(failing).rejects.toThrow('nope')
    await expect(next).resolves.toBe('ok')
  })

  it('each caller gets its own result', async () => {
    const [a, b] = await Promise.all([withSyncLock(async () => 'a'), withSyncLock(async () => 'b')])
    expect([a, b]).toEqual(['a', 'b'])
  })
})
