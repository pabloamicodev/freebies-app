import type { GiftVariantMode } from "../lib/gift-rewards.js";
import type { SelectedProduct } from "./SelectedProductsList.js";

interface Props {
  /** Gift variant GIDs. */
  giftIds: string[];
  /** The gifts' products, as SelectedProductsList resolves them. */
  products: SelectedProduct[];
  /** Gift variant GID -> what its product does. A product without an entry follows the default. */
  value: Record<string, GiftVariantMode>;
  onChange: (next: Record<string, GiftVariantMode>) => void;
}

/** "Automatically add all gifts": what a product with several picked variants does. Nothing is shown without one. */
export function GiftVariantModes({ giftIds, products, value, onChange }: Props) {
  const rows = products
    .map((product) => ({ product, picked: (product.variants ?? []).map((v) => v.id).filter((id) => giftIds.includes(id)) }))
    .filter((row) => row.picked.length > 1);
  if (rows.length === 0) return null;

  return (
    <div className="b-fieldset" style={{ marginTop: 16 }}>
      <p className="b-form-title">Gifts with several variants selected</p>
      <p className="b-form-desc">
        With every variant of a product selected, the customer picks one in the gift popup. With only some selected,
        each one is added to the cart automatically. Change it per product here.
      </p>
      {rows.map(({ product, picked }) => {
        // Same default as planGiftRewards.
        const mode = picked.map((id) => value[id]).find(Boolean) ?? (picked.length < (product.variantCount ?? 0) ? "each" : "pick");
        return (
          <div key={product.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }} data-testid="gift-variant-mode-row">
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", flex: 1, minWidth: 0 }}>
              {product.title} ({picked.length} variants)
            </span>
            <select
              className="b-select"
              aria-label={`Variants of ${product.title}`}
              style={{ maxWidth: 280 }}
              value={mode}
              onChange={(e) => {
                const next = { ...value };
                for (const id of picked) next[id] = e.target.value as GiftVariantMode;
                onChange(next);
              }}
            >
              <option value="pick">Customer picks one variant</option>
              <option value="each">Add all {picked.length} automatically</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}
