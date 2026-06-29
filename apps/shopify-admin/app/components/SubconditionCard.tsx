// Generic collapsible card wrapper for an active subcondition.
// Used by every offer-type creation/edit page.

import { useState } from "react";
import type { SubconditionDef } from "./subconditions/types.js";

function IChevUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15"/>
    </svg>
  );
}
function IChevDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

interface SubconditionCardProps {
  def: SubconditionDef;
  onRemove: () => void;
  children: React.ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function SubconditionCard({ def, onRemove, children, collapsed: collapsedProp, onToggleCollapse }: SubconditionCardProps) {
  const [collapsedLocal, setCollapsedLocal] = useState(false);
  const collapsed = collapsedProp !== undefined ? collapsedProp : collapsedLocal;
  const toggle = onToggleCollapse ?? (() => setCollapsedLocal((v) => !v));

  return (
    <div className="b-card" style={{ marginBottom: 12 }}>
      <div
        className="b-card-header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>{def.name}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={toggle}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", display: "flex" }}
          >
            {collapsed ? <IChevDown /> : <IChevUp />}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rd-style-009"
          >
            ×
          </button>
        </div>
      </div>

      <div className="b-card-body" style={{ display: collapsed ? 'none' : 'block' }}>{children}</div>
    </div>
  );
}
