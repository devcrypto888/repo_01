import { describe, expect, it } from 'vitest'
import { createScanDeduper } from '../src/scanner/dedupe'

describe('createScanDeduper', () => {
  it('counts a label held in frame once', () => {
    const seen = createScanDeduper(1_000)
    expect(seen('ABC12345', 0)).toBe(true)
    expect(seen('ABC12345', 300)).toBe(false)
    expect(seen('ABC12345', 900)).toBe(false)
    // sliding window: still within 1s of the last sighting
    expect(seen('ABC12345', 1_800)).toBe(false)
  })

  it('counts again after the label left the frame for the cooldown', () => {
    const seen = createScanDeduper(1_000)
    seen('ABC12345', 0)
    expect(seen('ABC12345', 1_500)).toBe(true)
  })

  it('rejects truncated reads of a recent code', () => {
    const seen = createScanDeduper(1_000)
    seen('ABC12345', 0)
    expect(seen('ABC123', 100)).toBe(false)
  })

  it('rejects too-short codes and trims whitespace', () => {
    const seen = createScanDeduper(1_000)
    expect(seen('12', 0)).toBe(false)
    expect(seen('  XYZ999 \n', 0)).toBe(true)
    expect(seen('XYZ999', 10)).toBe(false)
  })

  it('different labels are independent', () => {
    const seen = createScanDeduper(1_000)
    expect(seen('AAAA1', 0)).toBe(true)
    expect(seen('BBBB2', 10)).toBe(true)
  })
})
