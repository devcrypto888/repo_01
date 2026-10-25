import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { createScanDeduper } from './dedupe'

/**
 * Camera barcode scanning with three decoders, best first:
 *
 *   1. native BarcodeDetector (Chromium/Android): fast and battery-friendly
 *   2. zbar compiled to WASM: handles damaged/low-contrast 1D labels well
 *   3. ZXing JS: works everywhere, used on iOS Safari
 *
 * The same physical label stays in frame for many frames, so results go
 * through a deduper. One label equals one scan, until it leaves the frame or a
 * cooldown passes.
 */
export type ScannerState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported' | 'error'

interface Options {
  onScan: (code: string, format: string) => void
  formats?: BarcodeFormat[]
  cooldownMs?: number
  /** Prefer the rear camera; on desktops this falls back to whatever exists. */
  facingMode?: 'environment' | 'user'
}

const DEFAULT_FORMATS = [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]

export function useBarcodeScanner({ onScan, formats = DEFAULT_FORMATS, cooldownMs = 2_500, facingMode = 'environment' }: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<ScannerState>('idle')
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false })
  const stopRef = useRef<() => void>(() => undefined)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  const stop = useCallback(() => {
    stopRef.current()
    stopRef.current = () => undefined
    setState('idle')
  }, [])

  const start = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unsupported')
      return
    }

    setState('starting')
    const dedupe = createScanDeduper(cooldownMs)
    const emit = (code: string, format: string) => {
      if (dedupe(code)) {
        navigator.vibrate?.(60)
        onScanRef.current(code, format)
      }
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
    } catch (err) {
      setState((err as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'error')
      return
    }

    video.srcObject = stream
    video.setAttribute('playsinline', 'true') // iOS: otherwise opens fullscreen player
    await video.play().catch(() => undefined)

    const track = stream.getVideoTracks()[0]
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean }
    setTorch({ supported: !!caps.torch, on: false })

    const stopDecoder = await startBestDecoder(video, formats, emit)

    stopRef.current = () => {
      stopDecoder()
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
    setState('scanning')
  }, [cooldownMs, facingMode, formats])

  const toggleTorch = useCallback(async () => {
    const stream = videoRef.current?.srcObject as MediaStream | null
    const track = stream?.getVideoTracks()[0]
    if (!track || !torch.supported) return
    const next = !torch.on
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
    setTorch({ supported: true, on: next })
  }, [torch])

  // Release the camera when the tab is hidden; iOS kills the stream anyway.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
  }, [stop])

  return { videoRef, state, start, stop, torch, toggleTorch }
}

async function startBestDecoder(
  video: HTMLVideoElement,
  formats: BarcodeFormat[],
  emit: (code: string, format: string) => void,
): Promise<() => void> {
  // 1. Native
  if ('BarcodeDetector' in window) {
    try {
      const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string; format: string }[]> } }).BarcodeDetector
      const detector = new Detector({ formats: formats.map(toNativeFormat).filter(Boolean) as string[] })
      let raf = 0
      let busy = false
      const loop = async () => {
        raf = requestAnimationFrame(loop)
        if (busy || video.readyState < 2) return
        busy = true
        try {
          for (const r of await detector.detect(video)) emit(r.rawValue, r.format)
        } catch {
          /* frame not ready */
        } finally {
          busy = false
        }
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    } catch {
      /* fall through */
    }
  }

  // 2. zbar-wasm, lazy-loaded so it never weighs on the main bundle.
  try {
    const { scanImageData } = await import('@undecaf/zbar-wasm')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    let timer = 0
    const tick = async () => {
      if (video.readyState >= 2) {
        // Decode a centered crop: faster, and avoids picking up neighbouring labels.
        const w = video.videoWidth
        const h = video.videoHeight
        const cw = Math.round(w * 0.8)
        const ch = Math.round(h * 0.5)
        canvas.width = cw
        canvas.height = ch
        ctx.drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch)
        const symbols = await scanImageData(ctx.getImageData(0, 0, cw, ch))
        for (const s of symbols) emit(s.decode(), s.typeName)
      }
      timer = window.setTimeout(tick, 120)
    }
    void tick()
    return () => clearTimeout(timer)
  } catch {
    /* fall through */
  }

  // 3. ZXing
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, formats], [DecodeHintType.TRY_HARDER, true]])
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 })
  const controls: IScannerControls = await reader.decodeFromVideoElement(video, (result) => {
    if (result) emit(result.getText(), BarcodeFormat[result.getBarcodeFormat()])
  })
  return () => controls.stop()
}

function toNativeFormat(f: BarcodeFormat) {
  switch (f) {
    case BarcodeFormat.CODE_128: return 'code_128'
    case BarcodeFormat.CODE_39: return 'code_39'
    case BarcodeFormat.EAN_13: return 'ean_13'
    case BarcodeFormat.QR_CODE: return 'qr_code'
    case BarcodeFormat.DATA_MATRIX: return 'data_matrix'
    default: return null
  }
}
