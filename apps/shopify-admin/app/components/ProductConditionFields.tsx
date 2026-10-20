import type { SelectedProduct } from "./SelectedProductsList.js";
import {
  MATCH_BY_LABELS,
  MATCH_RULE_LABELS,
  packVariantHint,
  productConditionHelp,
  type MatchBy,
  type MatchRule,
  type PickedItem,
  type ProductConditionType,
} from "../lib/product-condition.js";

/** Resolves picked GIDs (variant GIDs or product GIDs, per `matchBy`) against the products SelectedProductsList loaded. */
export function pickedItems(products: SelectedProduct[], gids: string[], matchBy: MatchBy): PickedItem[] {
  const items: PickedItem[] = [];
  for (const gid of gids) {
    for (const product of products) {
      if (matchBy === "product") {
        if (product.id === gid) items.push({ productId: product.id, productTitle: product.title });
        continue;
      }
      const variant = product.variants?.find((v) => v.id === gid);
      if (variant) items.push({ variantId: variant.id, productId: product.id, productTitle: product.title, variantTitle: variant.title });
    }
  }
  return items;
}

export function MatchBySelect({ id, value, onChange }: { id: string; value: MatchBy; onChange: (value: MatchBy) => void }) {
  return (
    <div>
      <label className="b-label" htmlFor={id}>Match by</label>
      <select id={id} className="b-select" value={value} onChange={(e) => onChange(e.target.value === "product" ? "product" : "variant")}>
        {(Object.keys(MATCH_BY_LABELS) as MatchBy[]).map((mode) => (
          <option key={mode} value={mode}>{MATCH_BY_LABELS[mode]}</option>
        ))}
      </select>
    </div>
  );
}

/** Native radios: arrow keys move between them, and the legend names the group for screen readers. */
export function MatchRuleField({ name, value, onChange }: { name: string; value: MatchRule; onChange: (value: MatchRule) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="b-label">Customer must buy</legend>
      {(Object.keys(MATCH_RULE_LABELS) as MatchRule[]).map((rule) => (
        <label key={rule} className="b-checkbox-row" htmlFor={`${name}-${rule}`} style={{ cursor: "pointer", gap: 8 }}>
          <input
            id={`${name}-${rule}`}
            type="radio"
            name={name}
            value={rule}
            checked={value === rule}
            onChange={() => onChange(rule)}
          />
          <span className="b-checkbox-label">{MATCH_RULE_LABELS[rule]}</span>
        </label>
      ))}
      <p className="b-help" style={{ margin: "4px 0 0" }}>
        {value === "any" ? "One selected item in the cart is enough." : "Every selected item must be in the cart."}
      </p>
    </fieldset>
  );
}

export function ProductConditionNote({ type, matchBy, minQty, items, rule }: {
  type: ProductConditionType;
  matchBy: MatchBy;
  minQty: number;
  items: PickedItem[];
  rule?: MatchRule;
}) {
  const { lines, example } = productConditionHelp({ type, matchBy, minQty, items, rule });
  const hint = type === "pack_of_products" && matchBy === "variant" ? packVariantHint(items) : null;
  return (
    <>
      {hint && (
        <div className="b-banner b-banner-orange" role="note">
          <div className="b-banner-body"><p className="b-banner-text" style={{ margin: 0 }}>{hint}</p></div>
        </div>
      )}
      <div className="b-help" role="note">
        <strong>How this works</strong>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {example && <p style={{ margin: "6px 0 0" }}>{example}</p>}
      </div>
    </>
  );
}
