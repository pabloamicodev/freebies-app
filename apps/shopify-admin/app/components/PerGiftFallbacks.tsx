import { useEffect, useState } from "react";
import { ProductPicker } from "./ProductPicker.js";
import { SelectedProductsList, type SelectedProduct } from "./SelectedProductsList.js";

interface Props {
  /** Gift variant GIDs, one row each. */
  giftIds: string[];
  /** Gift variant GID -> fallback variant GIDs. */
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
  small?: boolean;
}

function giftLabel(products: SelectedProduct[], gid: string): string {
  for (const product of products) {
    const variant = product.variants?.find((v) => v.id === gid);
    if (variant) return (product.variants?.length ?? 0) > 1 ? `${product.title} — ${variant.title}` : product.title;
  }
  return "Gift";
}

/** One optional "If sold out, give instead" picker per gift. The same fallback may serve several gifts. */
export function PerGiftFallbacks({ giftIds, value, onChange, small }: Props) {
  const [products, setProducts] = useState<SelectedProduct[]>([]);
  const [pickingFor, setPickingFor] = useState<string | null>(null);

  useEffect(() => {
    if (giftIds.length === 0) return;
    const params = new URLSearchParams({ ids: giftIds.join(","), variants: "true" });
    fetch(`/api/products/search?${params}`)
      .then((r) => r.json())
      .then((data) => setProducts(data.products ?? []))
      .catch(() => undefined);
  }, [giftIds.join(",")]);

  if (giftIds.length === 0) return null;
  const btn = small ? "b-btn b-btn-secondary b-btn-sm" : "b-btn b-btn-secondary";
  const set = (gift: string, list: string[]) => onChange({ ...value, [gift]: list.slice(0, 5) });

  return (
    <div className="b-fieldset" style={{ marginTop: 16 }}>
      <p className="b-form-title">If sold out, give instead (optional)</p>
      <p className="b-form-desc">
        Pick a replacement for each gift. Without one, a sold-out gift is not given and the other gifts still are.
        The same replacement can be used for several gifts; each gift grants it on its own.
      </p>
      {giftIds.map((gift) => (
        <div key={gift} style={{ marginTop: 10 }} data-testid="gift-fallback-row">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", flex: 1, minWidth: 0 }}>
              {giftLabel(products, gift)}
            </span>
            <button type="button" className={btn} onClick={() => setPickingFor(gift)}>
              If sold out, give instead
            </button>
          </div>
          <SelectedProductsList
            gids={value[gift] ?? []}
            onRemove={(gid) => set(gift, (value[gift] ?? []).filter((id) => id !== gid))}
          />
        </div>
      ))}
      <ProductPicker
        open={pickingFor !== null}
        onClose={() => setPickingFor(null)}
        title="Give instead if sold out (used in order)"
        availabilityPolicy="block"
        allowMultiple
        selectedIds={pickingFor ? (value[pickingFor] ?? []) : []}
        onSelect={(gids) => {
          if (pickingFor) set(pickingFor, gids);
        }}
      />
    </div>
  );
}
