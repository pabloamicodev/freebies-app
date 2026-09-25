import { useFetcher } from "react-router";

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
  // A fetcher (not raw fetch) resolves ?index on index routes, surfaces action errors
  // returned with 200, and revalidates the list so the switch reflects the saved status.
  const fetcher = useFetcher<{ error?: string }>();
  const pending = fetcher.formData?.get("currentStatus");
  const on = pending ? pending !== "active" : status === "active";
  const loading = fetcher.state !== "idle";
  const error = fetcher.state === "idle" ? (fetcher.data?.error ?? null) : null;

  const handleChange = () => {
    const fd = new FormData();
    fd.append("intent", "toggle_status");
    fd.append("offerId", offerId);
    fd.append("currentStatus", status === "active" ? "active" : "paused");
    void fetcher.submit(fd, { method: "POST", ...(endpoint ? { action: endpoint } : {}) });
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
