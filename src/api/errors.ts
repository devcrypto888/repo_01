export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get isConflict() {
    return this.status === 409
  }

  get isGone() {
    return this.status === 404 || this.status === 410
  }

  /** Validation / permission errors: retrying the same payload will never succeed. */
  get isPermanent() {
    return this.status >= 400 && this.status < 500 && ![401, 408, 409, 425, 429].includes(this.status)
  }
}

export class NetworkError extends Error {
  readonly name = 'NetworkError'
}

export class TimeoutError extends Error {
  readonly name = 'TimeoutError'
  constructor(readonly ms: number) {
    super(`Request timed out after ${ms}ms`)
  }
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function isOfflineError(err: unknown) {
  return err instanceof NetworkError || err instanceof TimeoutError || (typeof navigator !== 'undefined' && !navigator.onLine)
}

export function errorMessage(err: unknown, fallback = 'Something went wrong') {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof TimeoutError) return 'The server took too long to respond'
  if (err instanceof NetworkError) return 'No connection'
  return err instanceof Error ? err.message : fallback
}
