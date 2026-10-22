/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { StaleWhileRevalidate, CacheFirst, NetworkOnly } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope

/**
 * App shell is precached so the app boots with zero network. Data never goes
 * through the SW cache: it lives in IndexedDB and is owned by the sync engine,
 * so the SW only deals with static assets and map tiles.
 */
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigation: every route resolves to the cached index.html.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }))

// API: always network. A cached API response would fight the sync engine's
// own view of the data.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly())

// Fonts and icons: cache-first, effectively immutable.
registerRoute(
  ({ request }) => request.destination === 'font' || request.destination === 'image',
  new CacheFirst({
    cacheName: 'static-media',
    plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 24 * 3600 })],
  }),
)

// Map tiles: SWR with a hard cap so a day of panning doesn't fill the quota.
registerRoute(
  ({ url }) => /\/tiles\/\d+\/\d+\/\d+\.(png|webp)$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'map-tiles',
    plugins: [new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 14 * 24 * 3600, purgeOnQuotaError: true })],
  }),
)

// The page decides when to activate (see update-guard.ts); never skipWaiting on install.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

// Background Sync where supported (Chromium): the page registers 'outbox' tag
// on every enqueue; the SW wakes the page to push even if the tab is in the
// background. Browsers without it fall back to the page's interval push.
self.addEventListener('sync', (event) => {
  const e = event as Event & { tag: string; waitUntil(p: Promise<unknown>): void }
  if (e.tag !== 'outbox') return
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) c.postMessage({ type: 'FLUSH_OUTBOX' })
    }),
  )
})
