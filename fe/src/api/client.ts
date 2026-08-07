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
