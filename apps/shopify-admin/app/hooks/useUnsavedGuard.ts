import { useEffect, useState } from "react";
import { useBlocker } from "react-router";

export function useUnsavedGuard(isSubmitting: boolean) {
  const [isDirty, setIsDirty] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    isDirty && !isSubmitting && (
      currentLocation.pathname !== nextLocation.pathname ||
      currentLocation.search !== nextLocation.search
    ),
  );

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return { markDirty: () => setIsDirty(true), blocker };
}
