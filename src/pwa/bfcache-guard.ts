import { closeDb } from '../sync/db'

/**
 * Back/forward cache: browsers freeze a page instead of unloading it, then
 * restore it in place. Two problems for an offline app:
 *
 *   1. An open IndexedDB connection makes the page ineligible for bfcache in
 *      some browsers. Worse, a frozen page that holds one blocks version
 *      upgrades from other tabs.
 *   2. A restored page shows whatever was on screen when it was frozen, which
 *      may be hours old, and may belong to a user who has since logged out.
 *
 * On pagehide we close the DB. On a persisted pageshow we ask the app to
 * re-validate the session and refresh visible data.
 */
export function installBfcacheGuard(onRestore: () => void) {
  const onHide = (e: PageTransitionEvent) => {
    if (e.persisted) void closeDb()
  }
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted) onRestore()
  }
  window.addEventListener('pagehide', onHide)
  window.addEventListener('pageshow', onShow)
  return () => {
    window.removeEventListener('pagehide', onHide)
    window.removeEventListener('pageshow', onShow)
  }
}
