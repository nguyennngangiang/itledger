// The loading context and its hook.
//
// Split from the provider file on purpose: a module that exports both components
// and plain functions trips react-refresh/only-export-components, so editing the
// provider stopped hot-reloading and forced a full page refresh. Same split, and
// the same reason, as i18n/useT.ts next to i18n/I18nProvider.tsx.
import { createContext, useContext } from "react";

export interface LoadingContextType {
  loading: boolean;
  startLoading: () => void;
  endLoading: () => void;
}

/** Undefined until a LoadingProvider wraps the tree. */
export const LoadingContext = createContext<LoadingContextType | undefined>(
  undefined,
);

/** Read or drive the ONE shared loading state. */
export function useLoading() {
  const ctx = useContext(LoadingContext);
  if (!ctx) throw new Error("useLoading must be used within a LoadingProvider");
  return ctx;
}
