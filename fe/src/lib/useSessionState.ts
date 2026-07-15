import { useCallback, useState } from "react";

// `useState` backed by sessionStorage: state persists across page reloads and
// tab navigation within the SAME browser-tab session, and is cleared when the tab
// closes ("per session"). JSON-serialized. Storage access is wrapped so a
// private-mode / quota failure degrades gracefully to plain in-memory state.
//
// The returned setter mirrors React's: accepts a value or an updater function.
export function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          sessionStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* ignore write failures (private mode / quota exceeded) */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
