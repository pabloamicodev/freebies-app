import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

interface AccessibleModalProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  onClose: () => void;
  style?: CSSProperties;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function AccessibleModal({ ariaLabel, children, className = "", onClose, style }: AccessibleModalProps) {
  const modalRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // This dialog doesn't call showModal() (it manages its own overlay/focus
    // trap in JS/CSS instead), which means content behind it is never marked
    // inert — a screen reader can still read and interact with the page
    // underneath. Mark every other top-level element inert while open.
    const root = modalRef.current?.closest(".b-modal-overlay")?.parentElement;
    const siblings = root
      ? Array.from(root.children).filter((el) => !el.contains(modalRef.current))
      : [];
    for (const el of siblings) el.setAttribute("inert", "");

    const focusable = modalRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    focusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
        .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const el of siblings) el.removeAttribute("inert");
      previousFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="b-modal-overlay">
      <button
        type="button"
        className="b-modal-backdrop-button"
        aria-label={`Close ${ariaLabel}`}
        onClick={onClose}
      />
      <dialog
        open
        ref={modalRef}
        className={`b-modal${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        style={style}
      >
        {children}
      </dialog>
    </div>
  );
}
