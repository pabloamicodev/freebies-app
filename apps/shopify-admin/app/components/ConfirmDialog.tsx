import type { ReactNode } from "react";
import { AccessibleModal } from "./AccessibleModal.js";

interface ConfirmDialogProps {
  open: boolean;
  ariaLabel: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red). Default true — nearly every use here is a delete/remove. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Branded replacement for window.confirm(), built on AccessibleModal.
 * Renders nothing when `open` is false so call sites can mount it unconditionally.
 */
export function ConfirmDialog({
  open,
  ariaLabel,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <AccessibleModal ariaLabel={ariaLabel} className="b-modal-sm" onClose={onCancel}>
      <div className="b-modal-header">
        <h2 className="b-modal-title">{title}</h2>
        <button type="button" className="b-modal-close" onClick={onCancel} aria-label="Close">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="b-modal-body">
        <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{message}</p>
      </div>
      <div className="b-modal-footer">
        <button type="button" className="b-btn b-btn-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? "b-btn b-btn-danger" : "b-btn b-btn-secondary"}
          style={destructive ? undefined : { borderColor: "#9ca3af" }}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </AccessibleModal>
  );
}
