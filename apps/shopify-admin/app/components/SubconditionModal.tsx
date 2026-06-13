import { useState } from "react";
import { AccessibleModal } from "./AccessibleModal.js";
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
  if (!open) return null;

  return (
    <SubconditionModalContent
      key={active.join("|")}
      active={active}
      types={types}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

function SubconditionModalContent({
  active,
  types,
  onClose,
  onConfirm,
}: Omit<SubconditionModalProps, "open">) {
  const [selected, setSelected] = useState<SubconditionId[]>(() => [...active]);

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
    <AccessibleModal ariaLabel="Add sub-conditions" onClose={onClose} style={{ maxWidth: 660, width: "92%" }}>
        <div className="b-modal-header">
          <div>
            <h2 className="b-modal-title">Add sub-conditions</h2>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "4px 0 0" }}>
              Refine when this offer triggers. Multiple sub-conditions are combined with AND logic.
            </p>
          </div>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close">
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
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => toggle(sub.id)}
                  aria-pressed={isSelected}
                  className="rd-style-093" style={{ border: `1.5px solid ${isSelected ? "var(--blue)" : "var(--border)"}`, background: isSelected ? "var(--blue-light, #f0f4ff)" : "var(--bg-card)", boxShadow: isSelected ? "0 0 0 3px rgba(44,110,203,0.12)" : "none" }}
                >
                  {/* Plus badge */}
                  {sub.plus && (
                    <div className="rd-style-094">
                      <ICrown />
                      <span>Plus</span>
                    </div>
                  )}

                  {/* Icon */}
                  <div className="rd-style-095" style={{ background: isSelected ? "var(--blue)" : "var(--bg-hover)", color: isSelected ? "#fff" : "var(--text-sub)" }}>
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
                    <div className="rd-style-096">
                      <ICheck />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="b-modal-footer">
          <button type="button" className="b-btn b-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="b-btn b-btn-dark" onClick={handleConfirm}>
            {selected.length > 0 ? `Apply ${selected.length} sub-condition${selected.length !== 1 ? "s" : ""}` : "Apply"}
          </button>
        </div>
    </AccessibleModal>
  );
}
