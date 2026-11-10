import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { describeCapacityModal, type CapacityModalData } from "../lib/capacity-modal-copy.js";
import { AccessibleModal } from "./AccessibleModal.js";

interface CapacityLimitModalProps {
  /** `capacity` from the action result; a new object opens the modal again. */
  data: CapacityModalData | null | undefined;
}

/**
 * Names the Shopify limit that blocked a Save / Activate / publish, the offers involved and the fix.
 * Mount it unconditionally; it renders nothing without data.
 */
export function CapacityLimitModal({ data }: CapacityLimitModalProps) {
  const [dismissed, setDismissed] = useState<CapacityModalData | null>(null);
  const uid = useId();
  useEffect(() => setDismissed(null), [data]);
  if (!data || dismissed === data) return null;

  const copy = describeCapacityModal(data);
  const close = () => setDismissed(data);

  return (
    <AccessibleModal ariaLabel={copy.title} className="b-modal-sm" onClose={close}>
      <div className="b-modal-header">
        <h2 className="b-modal-title">{copy.title}</h2>
        <button type="button" className="b-modal-close" onClick={close} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="b-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <section aria-labelledby={`${uid}-limit`}>
          <h3 id={`${uid}-limit`} style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "var(--text)" }}>
            Shopify limit
          </h3>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{copy.limit}</p>
        </section>
        <section aria-labelledby={`${uid}-what`}>
          <h3 id={`${uid}-what`} style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "var(--text)" }}>
            What happened
          </h3>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{copy.body}</p>
          {data.offers.length > 0 && (
            <ul style={{ fontSize: 14, color: "var(--text-sub)", margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.6 }} aria-label="Offers involved">
              {data.offers.map((offer) => (
                <li key={offer.id}>{offer.name}</li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby={`${uid}-fix`}>
          <h3 id={`${uid}-fix`} style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "var(--text)" }}>
            What to do
          </h3>
          <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{copy.fix}</p>
        </section>
      </div>
      <div className="b-modal-footer">
        {copy.actions.map((action) =>
          action.kind === "external" ? (
            <a key={action.label} className="b-btn b-btn-secondary" href={action.href} target="_top" rel="noreferrer">
              {action.label}
            </a>
          ) : (
            <Link key={action.label} className="b-btn b-btn-secondary" to={action.to} onClick={close}>
              {action.label}
            </Link>
          ),
        )}
        <button type="button" className="b-btn b-btn-primary" onClick={close}>
          Got it
        </button>
      </div>
    </AccessibleModal>
  );
}
