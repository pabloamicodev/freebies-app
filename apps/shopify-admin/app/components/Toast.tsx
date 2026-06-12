import { useEffect } from "react";

interface ToastProps {
  message: string;
  type?: "error" | "success" | "warning";
  onDismiss: () => void;
  duration?: number;
}

export function Toast({ message, type = "error", onDismiss, duration = 4000 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [onDismiss, duration]);

  return (
    <div className={`b-toast b-toast-${type}`} role="alert">
      <span style={{ flex: 1 }}>{message}</span>
      <button type="button" className="b-toast-close" onClick={onDismiss} aria-label="Cerrar">
        ×
      </button>
    </div>
  );
}
