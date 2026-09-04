// The provider that owns the one shared loading flag. Nothing else lives here —
// the context object and the useLoading hook are in ./useLoading.ts, because a
// module exporting both a component and a plain function breaks fast refresh.
import { useState } from "react";
import type { ReactNode } from "react";
import { LoadingContext } from "./useLoading";

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(false);
  const startLoading = () => setLoading(true);
  const endLoading = () => setLoading(false);

  return (
    <LoadingContext.Provider value={{ loading, startLoading, endLoading }}>
      {children}
    </LoadingContext.Provider>
  );
}
