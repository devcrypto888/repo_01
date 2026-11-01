export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** Run the pending call now (e.g. on unmount, so the last keystroke isn't lost). */
  flush(): void
  cancel(): void
  pending(): boolean
}

/**
 * Trailing debounce with flush/cancel, plus a maxWait so a user who never stops
 * typing still gets periodic saves.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => unknown, waitMs: number, maxWaitMs = waitMs * 5): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstCallAt: number | undefined
  let lastArgs: A | undefined

  const invoke = () => {
    clearTimeout(timer)
    timer = undefined
    firstCallAt = undefined
    const args = lastArgs
    lastArgs = undefined
    if (args) void fn(...args)
  }

  const d = ((...args: A) => {
    lastArgs = args
    const now = Date.now()
    firstCallAt ??= now
    clearTimeout(timer)
    const remainingMax = maxWaitMs - (now - firstCallAt)
    timer = setTimeout(invoke, Math.max(0, Math.min(waitMs, remainingMax)))
  }) as Debounced<A>

  d.flush = () => {
    if (timer) invoke()
  }
  d.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    firstCallAt = undefined
    lastArgs = undefined
  }
  d.pending = () => timer !== undefined

  return d
}
