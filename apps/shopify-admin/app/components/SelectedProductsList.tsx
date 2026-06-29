import { useEffect, useState } from "react";

interface SelectedVariant {
  id: string;
  title: string;
  price: string | null;
  sku: string | null;
}

interface SelectedProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  variants?: SelectedVariant[];
}

interface Props {
  gids: string[];
  onRemove: (gid: string) => void;
  /** If true, gids are variant GIDs; if false, product GIDs */
  variantMode?: boolean;
  label?: string;
}

export function SelectedProductsList({ gids, onRemove, variantMode = true, label }: Props) {
  const [products, setProducts] = useState<SelectedProduct[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (gids.length === 0) {
      setProducts([]);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ ids: gids.join(",") });
    if (variantMode) params.set("variants", "true");
    fetch(`/api/products/search?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setProducts(data.products ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [gids.join(","), variantMode]);

  if (gids.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      {label && (
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-sub)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {label}
        </div>
      )}
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--text-sub)", padding: "8px 0" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {variantMode
            ? renderVariantRows(gids, products, onRemove)
            : renderProductRows(products, onRemove)}
        </div>
      )}
    </div>
  );
}

function renderProductRows(products: SelectedProduct[], onRemove: (gid: string) => void) {
  return products.map((p) => (
    <div key={p.id} style={rowStyle}>
      <img
        src={p.imageUrl ?? ""}
        alt=""
        style={thumbStyle}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.title}
        </div>
      </div>
      <button type="button" aria-label={`Remove ${p.title}`} style={removeBtnStyle} onClick={() => onRemove(p.id)}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  ));
}

function renderVariantRows(gids: string[], products: SelectedProduct[], onRemove: (gid: string) => void) {
  // Build a map of variantGid → { variant, product }
  const variantMap = new Map<string, { variant: SelectedVariant; product: SelectedProduct }>();
  for (const p of products) {
    for (const v of p.variants ?? []) {
      variantMap.set(v.id, { variant: v, product: p });
    }
  }

  return gids.map((gid) => {
    const entry = variantMap.get(gid);
    if (!entry) {
      return (
        <div key={gid} style={rowStyle}>
          <div style={{ flex: 1, fontSize: 13, color: "var(--text-sub)" }}>Loading…</div>
          <button type="button" aria-label="Remove" style={removeBtnStyle} onClick={() => onRemove(gid)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      );
    }
    const { variant, product } = entry;
    const isOnlyVariant = (product.variants?.length ?? 0) <= 1;
    return (
      <div key={gid} style={rowStyle}>
        <img
          src={product.imageUrl ?? ""}
          alt=""
          style={thumbStyle}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {product.title}{!isOnlyVariant && ` — ${variant.title}`}
          </div>
          {variant.price && (
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>
              ${variant.price}{variant.sku ? ` · SKU: ${variant.sku}` : ""}
            </div>
          )}
        </div>
        <button type="button" aria-label={`Remove ${product.title}`} style={removeBtnStyle} onClick={() => onRemove(gid)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    );
  });
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--bg)",
  border: "1px solid var(--border)",
};

const thumbStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  objectFit: "cover",
  borderRadius: 4,
  flexShrink: 0,
  background: "var(--border)",
};

const removeBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--text-sub)",
  padding: 0,
};
