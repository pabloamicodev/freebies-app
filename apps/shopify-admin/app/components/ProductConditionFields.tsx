import type { SelectedProduct } from "./SelectedProductsList.js";
import {
  MATCH_BY_LABELS,
  packVariantHint,
  productConditionHelp,
  type MatchBy,
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

export function ProductConditionNote({ type, matchBy, minQty, items }: {
  type: ProductConditionType;
  matchBy: MatchBy;
  minQty: number;
  items: PickedItem[];
}) {
  const { lines, example } = productConditionHelp({ type, matchBy, minQty, items });
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
