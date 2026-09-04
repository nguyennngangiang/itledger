// The translation context and its hook.
//
// Split from the provider file on purpose: a module that exports both components
// and plain functions trips react-refresh/only-export-components, and this hook is
// imported by nearly every component.
import { createContext, useContext } from "react";
import type { Key } from "./catalog";
import type { Lang } from "./scramble";

export type Vars = Record<string, string | number>;

/** `{name}` → value. An unknown name is left visible rather than blanked, so a
 * mistyped placeholder shows up instead of silently vanishing. */
export function format(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type Translate = {
  /** Look up a key. `vars.n` also selects between `key.one` and `key.other`. */
  t: (key: Key, vars?: Vars) => string;
  /** The language a key is rendering in — "en" when the shuffle is off. */
  langOf: (key: Key) => Lang | "en";
  /** `dir` for a key, so a right-to-left string doesn't wreck its container. */
  dirOf: (key: Key) => "rtl" | undefined;
  scrambled: boolean;
  toggle: () => void;
};

export const I18nContext = createContext<Translate | undefined>(undefined);

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within an I18nProvider");
  return ctx;
}
