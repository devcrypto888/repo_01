import { openDB, type DBSchema } from 'idb'

/**
 * Binary storage for offline photos. Kept apart from the records DB so that
 * large values never slow down index scans on the records store, and so the
 * whole thing can be evicted under storage pressure without touching data.
 */
interface BlobSchema extends DBSchema {
  blobs: {
    key: string
    value: { key: string; blob: Blob; size: number; createdAt: number; lastAccess: number }
    indexes: { 'by-lastAccess': number }
  }
}

const dbp = openDB<BlobSchema>('app-blobs', 1, {
  upgrade(db) {
    const s = db.createObjectStore('blobs', { keyPath: 'key' })
    s.createIndex('by-lastAccess', 'lastAccess')
  },
})

const MAX_EDGE_PX = 2048
const JPEG_QUALITY = 0.82

/**
 * Downscales camera photos before storing. A modern phone shoots 12+ MP, and
 * a few hundred of those would blow through Safari's storage quota.
 */
export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size < 1_500_000) {
    bitmap.close()
    return file
  }

  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
  return new Promise<Blob>((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('Encode failed'))), 'image/jpeg', JPEG_QUALITY),
  )
}

export async function putBlob(blob: Blob): Promise<string> {
  const db = await dbp
  const key = crypto.randomUUID()
  const now = Date.now()
  await db.put('blobs', { key, blob, size: blob.size, createdAt: now, lastAccess: now })
  return key
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const db = await dbp
  const row = await db.get('blobs', key)
  if (!row) return undefined
  void db.put('blobs', { ...row, lastAccess: Date.now() })
  return row.blob
}

export async function deleteBlob(key: string) {
  const db = await dbp
  await db.delete('blobs', key)
}

/**
 * LRU eviction once usage passes a fraction of the origin quota. Blobs that
 * are still waiting to upload are never evicted: `isPinned` lets the caller
 * protect them.
 */
export async function evictIfNeeded(isPinned: (key: string) => Promise<boolean>, threshold = 0.7) {
  const est = await navigator.storage?.estimate?.()
  if (!est?.quota || !est.usage || est.usage / est.quota < threshold) return 0

  const target = est.quota * (threshold - 0.1)
  let usage = est.usage
  let freed = 0

  const db = await dbp
  let cursor = await db.transaction('blobs', 'readwrite').store.index('by-lastAccess').openCursor()
  while (cursor && usage > target) {
    if (!(await isPinned(cursor.value.key))) {
      usage -= cursor.value.size
      freed += cursor.value.size
      await cursor.delete()
    }
    cursor = await cursor.continue()
  }
  return freed
}

/** Ask the browser not to evict us under pressure (granted silently for installed PWAs). */
export async function requestPersistentStorage() {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
