// Storage for the session token (be/auth.py — one shared admin account, no
// user table). localStorage rather than sessionStorage on purpose: an
// internal tool that logged everyone out on every tab/reload would just
// train people to leave a tab pinned open forever.
const KEY = "itledger.auth.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* private mode / quota exceeded — the user just has to log in again next reload */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Fired by api/client.ts whenever a request comes back 401 (no token, or the
// token expired/was invalidated) — App.tsx listens for this to drop back to
// the login screen without every call site having to check the response
// itself.
export const UNAUTHORIZED_EVENT = "itledger:unauthorized";

export function notifyUnauthorized(): void {
  clearToken();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
