import { useState } from "react";
import { SubconditionCard } from "./SubconditionCard.js";
import { SubconditionModal } from "./SubconditionModal.js";
import { SUB_FORMS } from "./subconditions/registry.js";
import { GIFT_SUBCONDITIONS, isFunctionEnforcedSubcondition } from "./subconditions/types.js";
import type { SubconditionId } from "./subconditions/types.js";
import { initializeOfferConditionValues } from "../lib/offer-condition-defaults.js";

interface OfferConditionsBuilderProps {
  name?: string;
  title?: string;
  description?: string;
  /** Only offer conditions checkout can enforce (code offers can't publish with the others). */
  functionEnforcedOnly?: boolean;
  /** Conditions the surrounding wizard already asks for in its own steps. */
  exclude?: SubconditionId[];
  /** The offer is code-gated; forwarded to forms whose defaults depend on it. */
  isCodePromo?: boolean;
}

/**
 * Shared advanced-condition editor used by every creation wizard. The hidden
 * JSON field is normalized and validated again by the server action; this
 * component is deliberately presentation-only.
 */
export function OfferConditionsBuilder({
  name = "subconditions",
  title = "Advanced conditions",
  description = "URL, customer, market, subscription, store attributes and quantity guards are combined with AND logic.",
  functionEnforcedOnly = false,
  exclude,
  isCodePromo = false,
}: OfferConditionsBuilderProps) {
  const [active, setActive] = useState<SubconditionId[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const types = GIFT_SUBCONDITIONS.filter(
    (definition) =>
      !exclude?.includes(definition.id) &&
      (!functionEnforcedOnly || isFunctionEnforcedSubcondition(definition.id)),
  );

  return (
    <>
      <input type="hidden" name={name} value={JSON.stringify(values)} />
      <section className="b-card">
        <div className="b-card-header" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div className="b-help b-m-0" style={{ fontWeight: 400 }}>
            {description}
          </div>
        </div>
        <div className="b-card-body">
          {active.map((id) => {
            const SubForm = SUB_FORMS[id];
            const definition = types.find((candidate) => candidate.id === id);
            if (!definition) return null;
            return (
              <SubconditionCard
                key={id}
                def={definition}
                collapsed={Boolean(collapsed[id])}
                onToggleCollapse={() =>
                  setCollapsed((current) => ({ ...current, [id]: !current[id] }))
                }
                onRemove={() => {
                  setActive((current) => current.filter((candidate) => candidate !== id));
                  setValues((current) => {
                    const next = { ...current };
                    delete next[id];
                    return next;
                  });
                }}
              >
                <SubForm
                  value={values[id] ?? {}}
                  onChange={(nextValue) =>
                    setValues((current) => ({ ...current, [id]: nextValue }))
                  }
                  isCodePromo={isCodePromo}
                />
              </SubconditionCard>
            );
          })}

          <button
            type="button"
            className="b-card-body b-add-subcondition-trigger"
            style={{ width: "100%" }}
            onClick={() => setModalOpen(true)}
          >
            <span aria-hidden="true">＋</span>
            {active.length === 0 ? "Add condition" : "Add or change conditions"}
          </button>
        </div>
      </section>

      <SubconditionModal
        open={modalOpen}
        active={active}
        types={types}
        onClose={() => setModalOpen(false)}
        onConfirm={(nextActive) => {
          setActive(nextActive);
          setValues((current) => initializeOfferConditionValues(nextActive, current));
        }}
      />
    </>
  );
}
