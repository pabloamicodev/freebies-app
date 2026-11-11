import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { incidentDialogCopy as copy } from "../lib/capacity-workaround-copy.js";
import { AccessibleModal } from "./AccessibleModal.js";
import { IncidentWorkaroundsPanel } from "./CapacityWorkaroundList.js";

export const OPEN_CAPACITY_INCIDENTS_EVENT = "capacity-incidents:open";

/** One automatic open per full app load: client navigations never reopen it, so it can't stack with a save-time modal. */
let openedThisLoad = false;
export const resetCapacityDialogForTests = () => {
  openedThisLoad = false;
};

interface Props {
  /** Open incidents the merchant has not snoozed, from the app layout loader. */
  unsnoozed: number;
}

export function CapacityIncidentsDialog({ unsnoozed }: Props) {
  const [open, setOpen] = useState(false);
  const snooze = useFetcher();

  useEffect(() => {
    if (unsnoozed > 0 && !openedThisLoad) {
      openedThisLoad = true;
      setOpen(true);
    }
  }, [unsnoozed]);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_CAPACITY_INCIDENTS_EVENT, show);
    return () => window.removeEventListener(OPEN_CAPACITY_INCIDENTS_EVENT, show);
  }, []);

  if (!open) return null;
  const close = () => setOpen(false);
  const notNow = () => {
    snooze.submit({ intent: "snooze" }, { method: "post", action: "/app/capacity-incidents" });
    close();
  };

  return (
    <AccessibleModal ariaLabel={copy.title} className="b-modal-lg" onClose={close}>
      <div className="b-modal-header">
        <h2 className="b-modal-title">{copy.title}</h2>
        <button type="button" className="b-modal-close" onClick={close} aria-label={copy.close}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="b-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "70vh", overflowY: "auto" }}>
        <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{copy.intro}</p>
        <IncidentWorkaroundsPanel />
      </div>
      <div className="b-modal-footer">
        <button type="button" className="b-btn b-btn-secondary" onClick={notNow}>
          {copy.notNow}
        </button>
        <button type="button" className="b-btn b-btn-primary" onClick={close}>
          {copy.close}
        </button>
      </div>
    </AccessibleModal>
  );
}

/** Offers-list banner: persistent reminder that offers are blocked, with the way back into the dialog. */
export function CapacityIncidentsBanner({ open }: { open: number }) {
  if (open <= 0) return null;
  return (
    <div className="b-banner b-banner-orange" role="status">
      <div className="b-banner-body">
        <div className="b-banner-title">{copy.banner(open)}</div>
        <p className="b-banner-text">
          <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => window.dispatchEvent(new Event(OPEN_CAPACITY_INCIDENTS_EVENT))}>
            {copy.review}
          </button>
        </p>
      </div>
    </div>
  );
}
