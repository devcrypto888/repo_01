/**
 * Returns a predicate that is true for the first sighting of a code and
 * false while the same code keeps appearing within the cooldown.
 *
 * Each sighting extends the window ("sliding"), so a label held in front of
 * the camera for 10 seconds counts once. Pull it away for `cooldownMs` and
 * present it again, and it counts again. This is what operators expect when
 * they rescan on purpose.
 *
 * Also rejects obviously partial reads: 1D decoders sometimes return a
 * truncated prefix of the real code from a blurry frame.
 */
export function createScanDeduper(cooldownMs: number, minLength = 4) {
  const lastSeen = new Map<string, number>()

  return (raw: string, now = Date.now()) => {
    const code = raw.trim()
    if (code.length < minLength) return false

    for (const [k, t] of lastSeen) {
      if (now - t > cooldownMs) lastSeen.delete(k)
    }

    // A short read that is a prefix of a code seen moments ago is a partial frame.
    for (const k of lastSeen.keys()) {
      if (k !== code && k.startsWith(code)) return false
    }

    const seen = lastSeen.has(code)
    lastSeen.set(code, now)
    return !seen
  }
}

/**
 * Hardware wedge scanners type the code as keystrokes followed by Enter.
 * Distinguish them from a human typing by inter-key timing.
 */
export function createKeyboardWedgeListener(onScan: (code: string) => void, maxGapMs = 35, minLength = 4) {
  let buf = ''
  let last = 0

  return (e: KeyboardEvent) => {
    const now = performance.now()
    if (now - last > maxGapMs) buf = ''
    last = now

    if (e.key === 'Enter') {
      if (buf.length >= minLength) {
        e.preventDefault()
        onScan(buf)
      }
      buf = ''
      return
    }
    if (e.key.length === 1) buf += e.key
  }
}
