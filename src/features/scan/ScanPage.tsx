import { useCallback, useEffect, useState } from 'react'
import { useBarcodeScanner } from '../../scanner/useBarcodeScanner'
import { createKeyboardWedgeListener } from '../../scanner/dedupe'
import { findByRemoteId, listRecords } from '../../sync/records'
import type { Note } from '../../sync/handlers/notes'
import { Flashlight, FlashlightOff, ScanLine } from 'lucide-react'

type Hit = { code: string; at: number; match?: { key: string; title: string } }

/**
 * Scan labels with the camera or a Bluetooth/USB wedge scanner. The lookup is
 * fully local, so it works with no connection and returns instantly.
 */
export function ScanPage({ onOpen }: { onOpen: (key: string) => void }) {
  const [hits, setHits] = useState<Hit[]>([])

  const resolve = useCallback(async (code: string) => {
    const byId = await findByRemoteId<Note>(code)
    const record = byId ?? (await listRecords<Note>('notes')).find((r) => r.data.tags.includes(code))
    setHits((h) => [{ code, at: Date.now(), match: record && { key: record.key, title: record.data.title } }, ...h].slice(0, 50))
  }, [])

  const { videoRef, state, start, stop, torch, toggleTorch } = useBarcodeScanner({ onScan: (c) => void resolve(c) })

  useEffect(() => {
    const onKey = createKeyboardWedgeListener((c) => void resolve(c))
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resolve])

  return (
    <div className="flex h-full flex-col">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-black">
        <video ref={videoRef} className="h-full w-full object-cover" muted />
        <div className="pointer-events-none absolute inset-x-[10%] inset-y-[25%] rounded-lg border-2 border-white/70" />

        {state !== 'scanning' && (
          <div className="absolute inset-0 grid place-items-center text-center text-sm text-white">
            {state === 'denied' ? (
              <p className="max-w-[16rem]">Camera access was blocked. Enable it in the browser settings, or use a handheld scanner.</p>
            ) : state === 'unsupported' ? (
              <p>This device has no camera access. A handheld scanner still works.</p>
            ) : (
              <button className="btn-primary inline-flex items-center gap-2" onClick={start} disabled={state === 'starting'}>
                <ScanLine size={16} /> {state === 'starting' ? 'Starting…' : 'Start camera'}
              </button>
            )}
          </div>
        )}

        {state === 'scanning' && (
          <div className="absolute bottom-3 right-3 flex gap-2">
            {torch.supported && (
              <button className="rounded-full bg-black/60 p-2 text-white" onClick={toggleTorch} aria-label="Toggle light">
                {torch.on ? <FlashlightOff size={18} /> : <Flashlight size={18} />}
              </button>
            )}
            <button className="rounded-full bg-black/60 px-3 py-1 text-sm text-white" onClick={stop}>Stop</button>
          </div>
        )}
      </div>

      <ul className="flex-1 divide-y overflow-auto">
        {hits.map((h) => (
          <li key={h.at} className="flex items-center gap-3 px-4 py-2 text-sm">
            <code className="font-mono">{h.code}</code>
            {h.match ? (
              <button className="flex-1 truncate text-left text-primary underline" onClick={() => onOpen(h.match!.key)}>
                {h.match.title || 'Untitled'}
              </button>
            ) : (
              <span className="flex-1 text-muted-foreground">Not found on this device</span>
            )}
            <time className="text-xs text-muted-foreground">{new Date(h.at).toLocaleTimeString()}</time>
          </li>
        ))}
      </ul>
    </div>
  )
}
