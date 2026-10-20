import { describe, expect, it } from 'vitest'
import { overallPercent, etaSeconds, type Phase } from '../src/store/startup-progress'

const phase = (p: Partial<Phase> & Pick<Phase, 'id'>): Phase => ({ label: p.id, status: 'pending', processed: 0, total: 0, ...p })

describe('overallPercent', () => {
  it('weights pull phases heavier than small phases', () => {
    const phases = [phase({ id: 'reference', status: 'done' }), phase({ id: 'push', status: 'done' }), phase({ id: 'pull:notes' })]
    // 2 of weight 1 done, 0 of weight 4 → 2/6
    expect(overallPercent(phases)).toBe(33)
  })

  it('uses fractional progress inside a running phase', () => {
    const phases = [phase({ id: 'pull:notes', status: 'running', processed: 250, total: 1000 })]
    expect(overallPercent(phases)).toBe(25)
  })

  it('treats failed phases as finished for the bar', () => {
    expect(overallPercent([phase({ id: 'push', status: 'failed' })])).toBe(100)
  })
})

describe('etaSeconds', () => {
  it('is null until there is enough signal', () => {
    expect(etaSeconds(phase({ id: 'pull:x', startedAt: 0, processed: 10, total: 100 }), 1_000)).toBeNull()
  })

  it('extrapolates from throughput', () => {
    // 100 items in 10s → 10/s, 900 left → 90s
    expect(etaSeconds(phase({ id: 'pull:x', startedAt: 0, processed: 100, total: 1000 }), 10_000)).toBe(90)
  })
})
