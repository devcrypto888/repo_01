import { ApiError, NetworkError, TimeoutError, isRetryableStatus } from './errors'
import { refreshSession } from './session'

export interface RequestOptions extends Omit<RequestInit, 'body' | 'signal'> {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  /** Per-request timeout. The caller's signal still applies on top of it. */
  timeoutMs?: number
  /** Idempotent requests (GET, PUT with the same key) may be retried transparently. */
  retries?: number
  /** Sent as Idempotency-Key so a retried POST is applied at most once server-side. */
  idempotencyKey?: string
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api'
const DEFAULT_TIMEOUT_MS = 20_000

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(path.replace(/^\//, ''), BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/**
 * Combines the caller's AbortSignal with a timeout. AbortSignal.any is not
 * available everywhere we ship (older iOS Safari), so it is wired by hand.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new TimeoutError(ms)), ms)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) ctrl.abort(signal.reason)

  return {
    signal: ctrl.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })

let refreshInFlight: Promise<boolean> | null = null

/** Many requests can hit 401 at once; only one refresh call goes out. */
function refreshOnce() {
  refreshInFlight ??= refreshSession().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    body,
    query,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = method === 'GET' ? 2 : 0,
    idempotencyKey,
    headers,
    ...rest
  } = opts

  let attempt = 0
  let refreshed = false

  for (;;) {
    const t = withTimeout(signal, timeoutMs)
    try {
      const res = await fetch(buildUrl(path, query), {
        ...rest,
        method,
        credentials: 'include',
        signal: t.signal,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      })

      if (res.status === 401 && !refreshed) {
        refreshed = true
        if (await refreshOnce()) continue
      }

      if (!res.ok) {
        const payload = await res.json().catch(() => undefined)
        const err = new ApiError(res.status, payload?.message ?? res.statusText, payload)
        if (attempt < retries && isRetryableStatus(res.status)) throw err
        throw Object.assign(err, { final: true })
      }

      if (res.status === 204) return undefined as T
      const type = res.headers.get('content-type') ?? ''
      return (type.includes('application/json') ? await res.json() : await res.blob()) as T
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      if ((err as { final?: boolean }).final) throw err

      const wrapped =
        err instanceof ApiError || err instanceof TimeoutError
          ? err
          : new NetworkError(err instanceof Error ? err.message : 'Network request failed')

      if (attempt >= retries) throw wrapped
      attempt++
      // Full jitter backoff: spreads retries from many devices reconnecting at once.
      await sleep(Math.random() * Math.min(8_000, 500 * 2 ** attempt), signal)
    } finally {
      t.dispose()
    }
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
}
