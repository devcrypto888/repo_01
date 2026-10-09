/**
 * Serialises every operation that reads-then-writes shared local records:
 * pushing the outbox and pulling server changes.
 *
 * Without it, a push that has just received a remoteId can interleave with a
 * pull that reads the same record mid-write. The pull finds no local match
 * for that remoteId, treats it as new, and inserts a duplicate.
 *
 * This is a queue, not a dedupe: every caller still runs with its own
 * arguments and gets its own result, just never concurrently.
 */
let tail: Promise<unknown> = Promise.resolve()

export function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn)
  // One failing caller must not jam the queue for everyone after it.
  tail = run.catch(() => undefined)
  return run
}
