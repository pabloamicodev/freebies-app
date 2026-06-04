// Generic subcondition picker modal.
// Accepts any list of SubconditionDef so it works across gift / bundle / upsell / discount flows.

import { useState } from "react";
import type { SubconditionDef, SubconditionId } from "./subconditions/types.js";
import { SUB_ICONS, ICrown } from "./subconditions/icons.js";

interface SubconditionModalProps {
  open: boolean;
  /** Currently active subcondition IDs (controls pre-selected state). */
  active: SubconditionId[];
  /** The set of subconditions to offer — pass GIFT_SUBCONDITIONS, BUNDLE_SUBCONDITIONS, etc. */
  types: SubconditionDef[];
  onClose: () => void;
  /** Called with the full new selection when the user confirms. */
  onConfirm: (ids: SubconditionId[]) => void;
}

export function SubconditionModal({ open, active, types, onClose, onConfirm }: SubconditionModalProps) {
  const [selected, setSelected] = useState<SubconditionId[]>([...active]);

  // Re-sync when the modal is opened with a different active set.
  // (useState initialiser only runs once, so we use a key on the parent instead — see usage note.)

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
    <div
      className="b-modal-overlay"
      onClick={onClose}
      style={{ zIndex: 1000 }}
    >
      <div
        className="b-modal"
        style={{ maxWidth: 680, width: "90%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="b-modal-header">
          <h2 className="b-modal-title">Agregar subcondición</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="b-modal-body" style={{ padding: "20px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {types.map((sub) => {
              const Icon = SUB_ICONS[sub.id];
              const isSelected = selected.includes(sub.id);

              return (
                <div
                  key={sub.id}
                  onClick={() => toggle(sub.id)}
                  style={{
                    border: `2px solid ${isSelected ? "var(--blue)" : "var(--border)"}`,
                    borderRadius: 10,
                    padding: "18px 16px",
                    cursor: "pointer",
                    background: isSelected ? "var(--blue-light)" : "white",
                    position: "relative",
                    textAlign: "center",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  {sub.plus && (
                    <div style={{
                      position: "absolute", top: 8, right: 8,
                      background: "#fbbf24", borderRadius: 4,
                      padding: "2px 5px", display: "flex", alignItems: "center", gap: 3,
                    }}>
                      <ICrown />
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                    <Icon />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                    {sub.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>
                    {sub.desc}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="b-btn b-btn-dark" onClick={handleConfirm}>
            Añadir esta condición
          </button>
        </div>
      </div>
    </div>
  );
}
