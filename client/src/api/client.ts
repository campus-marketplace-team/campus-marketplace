import { getToken } from '../auth/session'

// Empty in local dev (Vite proxies /api to the server). Set to the API's URL on Vercel.
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

export class ApiError extends Error {
  status: number
  /** Machine-readable code from the API, e.g. EMAIL_NOT_VERIFIED. */
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let onUnauthorized: (() => void) | null = null

/** Called when an authenticated request gets a 401 (expired or revoked session). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Sent as JSON, except a Blob/File, which is sent as raw bytes with its own type (e.g. photo uploads). */
  body?: unknown
  signal?: AbortSignal
}

/** What to tell someone who hit a rate limit (HTTP 429). Every page already shows ApiError's message. */
export function rateLimitMessage(retryAfterSeconds: unknown): string {
  const seconds = Number(retryAfterSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return "You're doing that a bit too often. Please wait a little and try again."
  const wait = seconds < 60 ? 'less than a minute' : `about ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}`
  return `You're doing that a bit too often. Please try again in ${wait}.`
}

/** Request to the API. Sends the session token if there is one. Throws ApiError on non-2xx. */
export async function api<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  const isBlob = body instanceof Blob
  if (isBlob) headers['Content-Type'] = body.type || 'application/octet-stream'
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: isBlob ? body : body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.")
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.()
    const message =
      res.status === 429
        ? rateLimitMessage(data?.retryAfterSeconds ?? res.headers.get('Retry-After'))
        : typeof data?.error === 'string'
          ? data.error
          : 'Something went wrong. Please try again.'
    throw new ApiError(res.status, message, typeof data?.code === 'string' ? data.code : undefined)
  }
  return data as T
}
