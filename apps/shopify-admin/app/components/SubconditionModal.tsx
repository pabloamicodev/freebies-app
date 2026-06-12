import { useState, useEffect } from "react";
import type { SubconditionDef, SubconditionId } from "./subconditions/types.js";
import { SUB_ICONS, ICrown } from "./subconditions/icons.js";

interface SubconditionModalProps {
  open: boolean;
  active: SubconditionId[];
  types: SubconditionDef[];
  onClose: () => void;
  onConfirm: (ids: SubconditionId[]) => void;
}

function ICheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd"/>
    </svg>
  );
}

export function SubconditionModal({ open, active, types, onClose, onConfirm }: SubconditionModalProps) {
  const [selected, setSelected] = useState<SubconditionId[]>([...active]);

  useEffect(() => {
    if (open) setSelected([...active]);
  }, [open, active]);

  if (!open) return null;

  function toggle(id: SubconditionId) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function handleConfirm() {
    onConfirm(selected);
    onClose();
  }

  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal" style={{ maxWidth: 660, width: "92%" }} onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <div>
            <h2 className="b-modal-title">Add sub-conditions</h2>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "4px 0 0" }}>
              Refine when this offer triggers. Multiple sub-conditions are combined with AND logic.
            </p>
          </div>
          <button className="b-modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>
          </button>
        </div>

        <div className="b-modal-body">
          {selected.length > 0 && (
            <div style={{ marginBottom: 16, padding: "10px 14px", background: "var(--blue-light, #f0f4ff)", border: "1px solid rgba(44,110,203,0.2)", borderRadius: 8, fontSize: 13, color: "var(--blue)" }}>
              {selected.length} sub-condition{selected.length !== 1 ? "s" : ""} selected — click a card to deselect.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {types.map((sub) => {
              const Icon = SUB_ICONS[sub.id];
              const isSelected = selected.includes(sub.id);
              return (
                <div
                  key={sub.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(sub.id)}
                  onKeyDown={(e) => e.key === "Enter" && toggle(sub.id)}
                  style={{
                    border: `1.5px solid ${isSelected ? "var(--blue)" : "var(--border)"}`,
                    borderRadius: 10,
                    padding: "14px 16px",
                    cursor: "pointer",
                    background: isSelected ? "var(--blue-light, #f0f4ff)" : "var(--bg-card)",
                    position: "relative",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    transition: "border-color 0.12s, background 0.12s, box-shadow 0.12s",
                    boxShadow: isSelected ? "0 0 0 3px rgba(44,110,203,0.12)" : "none",
                    outline: "none",
                  }}
                >
                  {/* Plus badge */}
                  {sub.plus && (
                    <div style={{
                      position: "absolute", top: 8, right: 8,
                      background: "#fbbf24", borderRadius: 4,
                      padding: "2px 6px", display: "flex", alignItems: "center", gap: 3,
                      fontSize: 10, fontWeight: 600, color: "#78350f",
                    }}>
                      <ICrown />
                      <span>Plus</span>
                    </div>
                  )}

                  {/* Icon */}
                  <div style={{
                    width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                    background: isSelected ? "var(--blue)" : "var(--bg-hover)",
                    color: isSelected ? "#fff" : "var(--text-sub)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, color 0.12s",
                  }}>
                    <Icon />
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
                      {sub.name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.45 }}>
                      {sub.desc}
                    </div>
                  </div>

                  {/* Check indicator */}
                  {isSelected && (
                    <div style={{
                      position: "absolute", top: 10, right: 10,
                      width: 18, height: 18, borderRadius: "50%",
                      background: "var(--blue)", color: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <ICheck />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="b-btn b-btn-dark" onClick={handleConfirm}>
            {selected.length > 0 ? `Apply ${selected.length} sub-condition${selected.length !== 1 ? "s" : ""}` : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
