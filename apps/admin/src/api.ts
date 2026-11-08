const TOKEN_KEY = 'cxtool_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export interface ApiFetchOptions extends RequestInit {
  query?: Record<string, string | number | undefined>
  /** Skip the global 401 redirect — the caller handles the error inline (e.g. the login page). */
  skipAuthRedirect?: boolean
  /** Return the response body as a Blob instead of parsed JSON (binary downloads, e.g. PDFs). */
  blob?: boolean
}

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API error ${status}`)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T = unknown>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const { query, headers, skipAuthRedirect, blob, ...rest } = opts
  const url = new URL(`/wxt${path}`, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }

  const token = getToken()
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(rest.body !== undefined && !(rest.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  })

  if (res.status === 401) {
    if (!skipAuthRedirect) {
      clearToken()
      window.location.assign('/wxt/login')
    }
    throw new ApiError(401, await res.json().catch(() => null), '未登录或登录已过期')
  }
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null))
  }
  if (res.status === 204) return undefined as T
  if (blob) return (await res.blob()) as T
  return (await res.json()) as T
}
