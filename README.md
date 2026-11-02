# offline-first-sync

Code samples from a mobile web app (PWA) that keeps working for hours with
no network: field staff create, edit, photograph and scan, and everything
syncs once they're back in coverage.

> These are excerpts that show the architecture. They are **not** a runnable
> package: the app shell, routing, styling and real endpoints are left out.

## Layout

```
src/
  api/          fetch client: timeouts, jittered retries, single-flight token refresh, typed errors
  auth/         auth hook that falls back to the last confirmed user while offline
  sync/
    db.ts             IndexedDB schema, versioned upgrades, multi-tab connection lifecycle
    records.ts        local CRUD: optimistic create/update/delete, conflict resolution
    outbox.ts         persistent mutation queue: merges update into create, cancels create+delete, backoff
    push.ts           pushes the outbox through pluggable per-entity handlers
    pull.ts           resumable paginated pull: per-page cursor, local edits win, pruning
    lock.ts           promise-chain mutex so push and pull never interleave
    broadcast.ts      cross-tab change notifications (BroadcastChannel, coalesced)
    reference-cache.ts  stale-while-revalidate lookup data with ETags
    blob-store.ts     offline photos: client-side downscaling, LRU eviction under quota pressure
    startup-sync.ts   phased first sync with progress and partial-failure handling
    session-guard.ts  wipes local data on user switch and exports unsent changes first
    wake-lock.ts      ref-counted Screen Wake Lock during long syncs
    handlers/         per-entity push handlers (idempotency keys, If-Match, presigned uploads)
  pwa/
    sw.ts             Workbox service worker: app shell precache, SWR map tiles, Background Sync
    update-guard.ts   never activates a new SW mid-sync or with unsent changes
    bfcache-guard.ts  back/forward-cache safety for open DB connections and stale screens
  scanner/
    useBarcodeScanner.ts  camera scanning: native BarcodeDetector → zbar WASM → ZXing fallback, torch
    dedupe.ts             one label = one scan, rejects partial reads; keyboard-wedge scanner detection
  store/        zustand stores: startup progress with weighted % and ETA, connectivity quality
  react/        useSyncExternalStore live queries over IndexedDB, background sync driver
  components/   sync badge, startup progress screen, field-level conflict resolver
  features/     notes list (virtualized, instant local search), autosaving editor, scan page
tests/          vitest + fake-indexeddb: outbox merging, lock semantics, scan dedupe, progress math
```

## Design decisions

- **Single writer.** Every read-then-write on shared records goes through
  `withSyncLock`, so a push that just got a server id can't race a pull
  into creating a duplicate.
- **Local edits win; conflicts are explicit.** A pull never overwrites a
  record with unsent changes. A 409 from the server keeps both versions,
  and the user picks per field.
- **Idempotent pushes.** Creates carry the outbox job id as an
  `Idempotency-Key`, so a retry after a lost response can't create twice.
- **Resumable everything.** The first sync of tens of thousands of rows
  survives reloads, sleep, network drops and app updates.
- **Shared devices.** Local data is bound to a user identity and is wiped
  when someone else signs in. Their unsent changes are offered as a
  download, never silently dropped.

Stack: TypeScript, React 18, IndexedDB (`idb`), Workbox, zustand, react-hook-form + zod, react-virtuoso, ZXing / zbar-wasm, Vitest.
