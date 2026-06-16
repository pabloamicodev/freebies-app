import { useState } from "react";

interface BogosSwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}

function BogosSwitch({ on, onChange, label, disabled }: BogosSwitchProps) {
  return (
    <button
      type="button"
      className={`switch cursor-pointer${on ? " switch-on" : ""}${disabled ? " switch-disabled" : ""}`}
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="switch-track" />
      <span className="switch-thumb" />
    </button>
  );
}

export function OfferToggle({ offerId, status, endpoint }: {
  offerId: string;
  status: string;
  endpoint?: string;
}) {
  const [on, setOn] = useState(status === "active");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (next: boolean) => {
    setOn(next);
    setLoading(true);
    setError(null);
    const fd = new FormData();
    fd.append("intent", "toggle_status");
    fd.append("offerId", offerId);
    fd.append("currentStatus", on ? "active" : "paused");
    try {
      const res = await fetch(endpoint ?? window.location.pathname, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
    } catch (err) {
      setOn(!next); // rollback
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <BogosSwitch on={on} onChange={handleChange} disabled={loading} />
      {error && (
        <span style={{ fontSize: 11, color: "var(--color-critical, #d72c0d)", whiteSpace: "nowrap" }}>
          {error}
        </span>
      )}
    </div>
  );
}
