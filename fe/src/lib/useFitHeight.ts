// On a phone, size a box to exactly what is left of the screen below it, so
// controls inside it are always visible. Measured, not guessed: header height
// differs per phone, and old browsers (iOS < 15.4) have no dvh to do it in CSS.
import { useLayoutEffect, type RefObject } from "react";

/** `reserve`: pixels to leave free under the box — for a sticky save bar that
 * would otherwise sit on top of the box's own buttons. */
export function useFitHeight(ref: RefObject<HTMLElement | null>, deps: unknown[] = [], min = 220, reserve = 0) {
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      if (window.innerWidth > 760) {
        el.style.removeProperty("height");
        return;
      }
      const scroller = el.closest(".app-content");
      const shellTop = scroller?.getBoundingClientRect().top ?? 0;
      const top = el.getBoundingClientRect().top - shellTop + (scroller?.scrollTop ?? 0);
      const avail = window.innerHeight - shellTop - top - 12 - reserve;
      el.style.height = `${Math.round(Math.max(min, Math.min(avail, window.innerWidth * 1.33)))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reserve]);
}
