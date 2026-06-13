import { useState } from "react";
import { AccessibleModal } from "./AccessibleModal.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MainConditionType = "cart_value" | "cart_quantity" | "specific_product" | "cart_value_multiplier" | "pack_of_products";

interface MainConditionOption {
  id: MainConditionType;
  name: string;
  desc: string;
  combinable: boolean;
  icon: JSX.Element;
  color: string;
}

interface MainConditionModalProps {
  open: boolean;
  initialSelected: MainConditionType;
  onClose: () => void;
  onConfirm: (type: MainConditionType) => void;
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function ICartValue() {
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" fill="currentColor">
      <path fillRule="evenodd" d="M5.5 3.5a2 2 0 0 0-2 2v3.75c0 .414.336.75.75.75h2v5.769a.85.85 0 0 0 1.433.618l1.442-1.357 1.611 1.516a.75.75 0 0 0 1.028 0l1.611-1.516 1.442 1.357a.85.85 0 0 0 1.433-.618v-10.269a2 2 0 0 0-2-2h-8.494l.005.017a2.02 2.02 0 0 0-.261-.017Zm-.5 2a.5.5 0 0 1 1 0v3h-1v-3Zm2.75-.48-.006-.02h6.506a.5.5 0 0 1 .5.5v8.764l-.69-.649a1 1 0 0 0-1.37 0l-1.44 1.355-1.44-1.355a1 1 0 0 0-1.37 0l-.69.65v-9.245Zm2 1.48a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Zm-.75 3.75a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Z"/>
    </svg>
  );
}

function ICartQty() {
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" fill="currentColor">
      <path d="M3.25 3a.75.75 0 0 0 0 1.5h1.612a.25.25 0 0 1 .248.22l1.04 8.737a1.75 1.75 0 0 0 1.738 1.543h6.362a.75.75 0 0 0 0-1.5h-6.362a.25.25 0 0 1-.248-.22l-.093-.78h6.35a2.75 2.75 0 0 0 2.743-2.54l.358-4.652a.75.75 0 0 0-1.496-.116l-.358 4.654a1.25 1.25 0 0 1-1.246 1.154h-6.53l-.768-6.457a1.75 1.75 0 0 0-1.738-1.543h-1.612Z"/>
      <path d="M12 9.25a.75.75 0 0 1-1.5 0v-3.69l-1.22 1.22a.75.75 0 0 1-1.06-1.06l2.5-2.5a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1-1.06 1.06l-1.22-1.22v3.69Z"/>
      <path d="M10 17a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
      <path d="M15 17a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
    </svg>
  );
}

function ISpecificProduct() {
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" fill="currentColor">
      <path d="M11.276 3.5a3.75 3.75 0 0 0-2.701 1.149l-4.254 4.417a2.75 2.75 0 0 0 .036 3.852l2.898 2.898a2.5 2.5 0 0 0 3.502.033l.45-.434a.75.75 0 1 0-1.04-1.08l-.45.434a1 1 0 0 1-1.401-.014l-2.898-2.898a1.25 1.25 0 0 1-.016-1.75l4.253-4.418a2.25 2.25 0 0 1 1.62-.689h1.975c.966 0 1.75.784 1.75 1.75v2.371c0 .358-.146.7-.403.948a.75.75 0 1 0 1.04 1.08 2.81 2.81 0 0 0 .863-2.028v-2.371a3.25 3.25 0 0 0-3.25-3.25h-1.974Z"/>
      <path d="M13 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>
      <path d="M14.75 12a.75.75 0 0 1 .75.75v1.25h1.25a.75.75 0 0 1 0 1.5h-1.25v1.25a.75.75 0 0 1-1.5 0v-1.25h-1.25a.75.75 0 0 1 0-1.5h1.25v-1.25a.75.75 0 0 1 .75-.75Z"/>
    </svg>
  );
}

function ICartMultiplier() {
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" fill="currentColor">
      <path d="M7.75 5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 1 0 0-1.5h-4.5Z"/>
      <path d="M7 8.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M7.75 11a.75.75 0 0 0 0 1.5h1.5a.75.75 0 0 0 0-1.5h-1.5Z"/>
      <path d="M11 8.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M11.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Z"/>
      <path fillRule="evenodd" d="M4 16a1.5 1.5 0 0 0 2.615 1.003l1.135-1.26 1.135 1.26a1.5 1.5 0 0 0 2.23 0l1.135-1.26 1.135 1.26a1.5 1.5 0 0 0 2.615-1.003v-11a2.5 2.5 0 0 0-2.5-2.5h-7a2.5 2.5 0 0 0-2.5 2.5v11Zm2.5-12a1 1 0 0 0-1 1v11l1.507-1.674a1 1 0 0 1 1.486 0l1.507 1.674 1.507-1.674a1 1 0 0 1 1.486 0l1.507 1.674v-11a1 1 0 0 0-1-1h-7Z"/>
    </svg>
  );
}

function IPackOfProducts() {
  return (
    <svg viewBox="0 0 20 20" width="22" height="22" fill="currentColor">
      <path fillRule="evenodd" d="M7 9a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-4Zm.5 3.5v-2h3v2h-3Z"/>
      <path fillRule="evenodd" d="M5.315 4.45a2.25 2.25 0 0 1 1.836-.95h5.796a2.25 2.25 0 0 1 1.872 1.002l1.22 1.828c.3.452.461.983.461 1.526v6.894a1.75 1.75 0 0 1-1.75 1.75h-9.5a1.75 1.75 0 0 1-1.75-1.75v-6.863c0-.57.177-1.125.506-1.59l1.309-1.848Zm1.836.55a.75.75 0 0 0-.612.316l-.839 1.184h3.55v-1.5h-2.1Zm3.599 1.5h3.599l-.778-1.166a.75.75 0 0 0-.624-.334h-2.197v1.5Zm4.25 1.5h-10v6.75c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-6.75Z"/>
    </svg>
  );
}

function ICheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd"/>
    </svg>
  );
}

// ─── Options ────────────────────────────────────────────────────────────────

const COMBINABLE_OPTIONS: MainConditionOption[] = [
  {
    id: "cart_value",
    name: "Cart Value",
    desc: "Trigger when cart total reaches a threshold — e.g. spend $100 to unlock a gift.",
    combinable: true,
    color: "#3b82f6",
    icon: <ICartValue />,
  },
  {
    id: "cart_quantity",
    name: "Cart Quantity",
    desc: "Trigger based on item count in the cart — e.g. buy 5 products to get a gift.",
    combinable: true,
    color: "#8b5cf6",
    icon: <ICartQty />,
  },
];

const INDEPENDENT_OPTIONS: MainConditionOption[] = [
  {
    id: "specific_product",
    name: "Specific Product",
    desc: "Trigger when a particular product is in the cart — e.g. buy product A, get gift B.",
    combinable: false,
    color: "#f59e0b",
    icon: <ISpecificProduct />,
  },
  {
    id: "cart_value_multiplier",
    name: "Tiered Cart Value",
    desc: "Unlock more rewards as spend increases — e.g. $100 = 1 gift, $200 = 2 gifts.",
    combinable: false,
    color: "#10b981",
    icon: <ICartMultiplier />,
  },
  {
    id: "pack_of_products",
    name: "Product Bundle",
    desc: "Require a combination of specific products — e.g. buy A and B together to get a gift.",
    combinable: false,
    color: "#ef4444",
    icon: <IPackOfProducts />,
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export function MainConditionModal({ open, initialSelected, onClose, onConfirm }: MainConditionModalProps) {
  const [selected, setSelected] = useState<MainConditionType | null>(initialSelected ?? null);

  if (!open) return null;

  function handleConfirm() {
    if (selected) onConfirm(selected);
    onClose();
  }

  return (
    <AccessibleModal ariaLabel="Choose a condition type" onClose={onClose} style={{ maxWidth: 660, width: "92%" }}>
        {/* Header */}
        <div className="b-modal-header">
          <div>
            <h2 className="b-modal-title">Choose a condition type</h2>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "4px 0 0" }}>
              This determines when the offer triggers for customers.
            </p>
          </div>
          <button className="b-modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="b-modal-body">
          {/* Combinable section */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-sub)" }}>Combinable conditions</span>
              <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
              <span style={{ fontSize: 11, background: "#e8f5e9", color: "#2e7d32", padding: "2px 8px", borderRadius: 100, fontWeight: 500 }}>Can stack with other conditions</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {COMBINABLE_OPTIONS.map((opt) => (
                <ConditionCard key={opt.id} opt={opt} selected={selected === opt.id} onSelect={() => setSelected(opt.id)} />
              ))}
            </div>
          </div>

          {/* Independent section */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-sub)" }}>Independent conditions</span>
              <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
              <span style={{ fontSize: 11, background: "#fff3e0", color: "#e65100", padding: "2px 8px", borderRadius: 100, fontWeight: 500 }}>Used standalone only</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {INDEPENDENT_OPTIONS.map((opt) => (
                <ConditionCard key={opt.id} opt={opt} selected={selected === opt.id} onSelect={() => setSelected(opt.id)} />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="b-btn b-btn-dark" onClick={handleConfirm} disabled={!selected}>
            Use this condition
          </button>
        </div>
    </AccessibleModal>
  );
}

// ─── Condition card ──────────────────────────────────────────────────────────

function ConditionCard({ opt, selected, onSelect }: { opt: MainConditionOption; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        border: `1.5px solid ${selected ? "var(--blue)" : "var(--border)"}`,
        borderRadius: 10,
        background: selected ? "var(--blue-light, #f0f4ff)" : "var(--bg-card)",
        cursor: "pointer",
        padding: "14px 16px",
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        position: "relative",
        transition: "border-color 0.12s, background 0.12s, box-shadow 0.12s",
        boxShadow: selected ? "0 0 0 3px rgba(44,110,203,0.12)" : "none",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      {/* Icon pill */}
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: selected ? opt.color : `${opt.color}18`,
        color: selected ? "#fff" : opt.color,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.12s, color 0.12s",
      }}>
        {opt.icon}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{opt.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.45 }}>{opt.desc}</div>
      </div>

      {/* Check */}
      {selected && (
        <div style={{
          position: "absolute", top: 10, right: 10,
          width: 20, height: 20, borderRadius: "50%",
          background: "var(--blue)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <ICheck />
        </div>
      )}
    </button>
  );
}
