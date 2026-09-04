// Language state for the whole app: English by default, or the shuffle.
//
// Mirrors hook/LoadingProvider — the app's one existing pattern for cross-cutting
// state. The toggle lives in sessionStorage via useSessionState so a refresh does
// not quietly drop you back to English mid-demo.
import { useMemo } from "react";
import type { ReactNode } from "react";
import { EN, isKey } from "./catalog";
import type { Key } from "./catalog";
import { RTL, SCRAMBLE } from "./scramble";
import { I18nContext, format, useT } from "./useT";
import type { Translate, Vars } from "./useT";
import { useSessionState } from "../lib/useSessionState";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [scrambled, setScrambled] = useSessionState("itledger.scramble", false);

  const value = useMemo<Translate>(() => {
    // The base key carries the plural wording; a `.one` sibling, where one
    // exists, replaces it for a count of exactly one. Keys with no sibling are
    // left alone, so a plain string never gets rewritten into a key that isn't
    // in the catalog.
    const resolve = (key: Key, vars?: Vars): Key => {
      if (vars?.n === 1) {
        const singular = `${key}.one`;
        if (isKey(singular)) return singular;
      }
      return key;
    };

    return {
      t: (key, vars) => {
        const k = resolve(key, vars);
        const shuffled = scrambled ? SCRAMBLE[k] : undefined;
        // English is always a complete fallback, which is what lets scramble.ts
        // be filled in a bit at a time instead of all at once.
        return format(shuffled ? shuffled[1] : EN[k], vars);
      },
      langOf: (key) => (scrambled && SCRAMBLE[key]?.[0]) || "en",
      dirOf: (key) => {
        const lang = scrambled ? SCRAMBLE[key]?.[0] : undefined;
        return lang && RTL.has(lang) ? ("rtl" as const) : undefined;
      },
      scrambled,
      toggle: () => setScrambled((v) => !v),
    };
  }, [scrambled, setScrambled]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Render a key as text, carrying `dir` so right-to-left strings behave. Use this
 * instead of a bare `t()` wherever the string sits inline in prose. */
export function T({ k, vars }: { k: Key; vars?: Vars }) {
  const { t, dirOf } = useT();
  const dir = dirOf(k);
  const text = t(k, vars);
  return dir ? <span dir={dir}>{text}</span> : <>{text}</>;
}
