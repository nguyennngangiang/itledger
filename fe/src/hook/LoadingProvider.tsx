// The provider that owns the one shared loading flag. Nothing else lives here —
// the context object and the useLoading hook are in ./useLoading.ts, because a
// module exporting both a component and a plain function breaks fast refresh.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LoadingContext } from "./useLoading";

/** The loading cat stays at least this long once shown. On the LAN the API answers
 * in tens of milliseconds, so without a floor the overlay was a one-frame flicker
 * nobody could see — the team asked for the cat to actually stay ~1–2 s. */
export const MIN_LOADING_MS = 1500;

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(false);
  // Overlapping loads share one showing: a count of open requests, when the
  // cat appeared, and the pending hide.
  const open = useRef(0);
  const shownAt = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startLoading = useCallback(() => {
    open.current++;
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);       // a new load during the hold: keep showing
      hideTimer.current = null;
      return;
    }
    if (open.current === 1) {
      shownAt.current = performance.now();
      setLoading(true);
    }
  }, []);

  const endLoading = useCallback(() => {
    open.current = Math.max(0, open.current - 1);
    if (open.current > 0 || hideTimer.current) return;
    const left = MIN_LOADING_MS - (performance.now() - shownAt.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (open.current === 0) setLoading(false);
    }, Math.max(0, left));
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const value = useMemo(() => ({ loading, startLoading, endLoading }), [loading, startLoading, endLoading]);
  return <LoadingContext.Provider value={value}>{children}</LoadingContext.Provider>;
}
