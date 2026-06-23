import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

// 1. Describe what the context will hold
interface LoadingContextType {
  loading: boolean;
  startLoading: () => void;
  endLoading: () => void;
}

// 2. Create the context (undefined until a Provider wraps the app)
const LoadingContext = createContext<LoadingContextType | undefined>(undefined);

// 3. The Provider owns the ONE shared state
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

// 4. A hook so components can read/update that shared state
export function useLoading() {
  const ctx = useContext(LoadingContext);
  if (!ctx) throw new Error("useLoading must be used within a LoadingProvider");
  return ctx;
}
