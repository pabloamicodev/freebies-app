import { useEffect, useState } from "react";
import { useBlocker } from "react-router";

export function useUnsavedGuard(isSubmitting: boolean) {
  const [isDirty, setIsDirty] = useState(false);
  const blocker = useBlocker(isDirty && !isSubmitting);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    if (isSubmitting) setIsDirty(false);
  }, [isSubmitting]);

  return { markDirty: () => setIsDirty(true), blocker };
}
