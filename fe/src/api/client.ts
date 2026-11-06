// Single place that owns the API base URL, JSON handling, and error shape.
// Every resource module (devices.ts, users.ts, ...) goes through request().

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

// FastAPI's `detail` is a plain string for HTTPException but an ARRAY of
// {loc, msg, type} objects for a 422 validation error. Interpolating that array
// into an Error message yields "[object Object]", which is what every failed
// create used to show — flatten it to "<field>: <msg>" instead.
type ValidationItem = { loc?: (string | number)[]; msg?: string }

function describeDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const parts = (detail as ValidationItem[])
      .map((item) => {
        // loc looks like ["body", "serial_number"] — drop the request-part prefix.
        const field = (item.loc ?? []).filter((p) => p !== 'body').join('.')
        const msg = item.msg ?? 'invalid value'
        return field ? `${field}: ${msg}` : msg
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return fallback
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })

  if (!res.ok) {
    // FastAPI puts the message under `detail`.
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, describeDetail(body.detail, res.statusText))
  }

  // 204 No Content (e.g. DELETE) has no body to parse.
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * POST that answers with Server-Sent Events, yielded one parsed event at a time.
 *
 * Only the handover reader needs this, and only because its wait is long enough to
 * look like a hang: a scanned record is OCR'd for tens of seconds, and a cold model
 * spends ~44s loading before it emits a character. `request()` cannot express that —
 * it has one result and no middle.
 *
 * Errors arrive two ways and both matter. A request that fails outright still has a
 * status to read, so it throws `ApiError` like everything else here. A request that
 * fails AFTER the stream opened cannot change its status code, so the server sends
 * a `{phase:"error"}` event; that one is the caller's to notice.
 */
export async function* streamRequest<T>(
  path: string,
  options: RequestInit = {},
): AsyncGenerator<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, describeDetail(body.detail, res.statusText))
  }
  if (!res.body) throw new ApiError(500, 'Empty response stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Events are separated by a blank line; anything after the last one is a
      // partial event that has to wait for the next chunk.
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          yield JSON.parse(data) as T
        } catch {
          // A malformed event is not worth failing a whole read over.
        }
      }
    }
  } finally {
    // Abandoning the generator early (an unmounted modal) must not leave the
    // response body open.
    reader.cancel().catch(() => {})
  }
}

/**
 * DELETE /<resource>/batch. Every resource had a byte-identical copy of this,
 * differing only in the path segment and what it called the id list.
 *
 * The named per-resource wrappers stay — they are what the screens import, they
 * carry the right parameter name, and each file is where that resource's notes
 * live. This only removes the repeated body.
 */
export function deleteBatch(resource: string, ids: string[], permanent = false) {
  return request<void>(`/${resource}/batch${permanent ? '?permanent=true' : ''}`, {
    method: 'DELETE',
    body: JSON.stringify(ids),
  })
}
