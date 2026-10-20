/**
 * Keeps the screen awake while a long initial sync runs on a mobile device;
 * if the screen turns off, the tab is frozen and the sync stalls.
 *
 * Reference-counted so overlapping syncs share one sentinel, and re-acquired
 * on visibilitychange because the browser releases it when the tab is hidden.
 */
let sentinel: WakeLockSentinel | null = null
let holders = 0

async function acquire() {
  if (!('wakeLock' in navigator) || sentinel) return
  try {
    sentinel = await navigator.wakeLock.request('screen')
    sentinel.addEventListener('release', () => {
      sentinel = null
    })
  } catch {
    // Not allowed (battery saver, iframe, no user gesture). Sync still works.
  }
}

function onVisibility() {
  if (document.visibilityState === 'visible' && holders > 0) void acquire()
}

export async function holdWakeLock(): Promise<() => void> {
  holders++
  if (holders === 1) document.addEventListener('visibilitychange', onVisibility)
  await acquire()

  let released = false
  return () => {
    if (released) return
    released = true
    holders--
    if (holders === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release()
      sentinel = null
    }
  }
}
