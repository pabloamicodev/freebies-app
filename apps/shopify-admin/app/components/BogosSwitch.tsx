import { useState } from "react";

interface BogosSwitchProps {
  /** Current on/off state */
  on: boolean;
  /** Called when the user toggles — receives the new state */
  onChange: (next: boolean) => void;
  /** Optional aria-label */
  label?: string;
}

/**
 * Toggle switch that exactly matches BOGOS CSS:
 *   .switch / .switch-on / .switch-track / .switch-thumb
 *
 * Styles are defined in bogos.css.
 */
export function BogosSwitch({ on, onChange, label }: BogosSwitchProps) {
  return (
    <button
      type="button"
      className={`switch cursor-pointer${on ? " switch-on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="switch-track" />
      <span className="switch-thumb" />
    </button>
  );
}

/**
 * Stateful switch for offer rows — fires a background POST on toggle.
 * Used in the All Offers table and Boosters table.
 */
export function OfferToggle({ offerId, status, endpoint }: {
  offerId: string;
  status: string;
  endpoint?: string;
}) {
  const [on, setOn] = useState(status === "active");

  const handleChange = async (next: boolean) => {
    setOn(next);
    const fd = new FormData();
    fd.append("intent", "toggle_status");
    fd.append("offerId", offerId);
    fd.append("currentStatus", on ? "active" : "paused");
    await fetch(endpoint ?? window.location.pathname, { method: "POST", body: fd });
  };

  return <BogosSwitch on={on} onChange={handleChange} />;
}
