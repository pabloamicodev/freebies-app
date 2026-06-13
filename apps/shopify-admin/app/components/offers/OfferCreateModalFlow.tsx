import { useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { AccessibleModal } from "../AccessibleModal.js";

export type OfferCreateModalType = "type" | "gift" | "bundle" | "upsell" | "discount";

const GIFT_SLUG_MAP: Record<string, string> = {
  buy_x_get_y: "bxgy",
  bogo: "bogo",
  buy_x_gift: "free-sample",
  cart_value: "cart-value",
  tiered: "tiered",
  custom: "scratch",
};

const BUNDLE_SLUG_MAP: Record<string, string> = {
  classic: "classic-bundle",
  mix: "mix-match",
  build_a_box: "bundle-page",
};

const UPSELL_SLUG_MAP: Record<string, string> = {
  fbt: "fbt",
  checkout: "checkout",
  thank_you: "thank-you",
};

const DISCOUNT_SLUG_MAP: Record<string, string> = {
  volume: "volume",
  cheapest: "cheapest",
  cart: "cart",
};

function GiftSvg() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12"/>
      <rect x="2" y="7" width="20" height="5"/>
      <line x1="12" y1="22" x2="12" y2="7"/>
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
    </svg>
  );
}
function BundleSvg() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="14" width="20" height="8" rx="2"/>
      <rect x="4" y="9" width="16" height="6" rx="2"/>
      <rect x="6" y="4" width="12" height="6" rx="2"/>
    </svg>
  );
}
function UpsellSvg() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14"/>
      <path d="M12 5l7 7-7 7"/>
    </svg>
  );
}
function DiscountSvg() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
      <line x1="7" y1="7" x2="7.01" y2="7"/>
      <line x1="9" y1="14" x2="15" y2="8"/>
    </svg>
  );
}

/* Gift offer templates */
const GIFT_TEMPLATES = [
  {
    id: "cart_value",
    name: "Spend X to get gifts",
    desc: "e.g. Spend $500 and get gifts",
    IllusComponent: () => (
      <div className="b-illus-cart-gift">
        <div className="b-illus-cart-box">
          <span className="b-illus-cart-label">CART VALUE</span>
          <span className="b-illus-cart-value">$514.99</span>
          <span style={{ fontSize: 20 }}>🛒</span>
        </div>
        <span className="b-illus-arrow">→</span>
        <div className="b-illus-gift-box">🎁</div>
      </div>
    ),
  },
  {
    id: "buy_x_gift",
    name: "Free sample with purchase",
    desc: "e.g. Reward customers with a sample once they buy at least 1 product.",
    IllusComponent: () => (
      <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <div className="rd-style-035">1 item Added!</div>
        <div className="rd-style-036">🛒</div>
        <span style={{ color: "#6d7175", fontSize: 18 }}>→</span>
        <div className="rd-style-036">🧴</div>
      </div>
    ),
  },
  {
    id: "bogo",
    name: "BOGO (Buy 1 get 1 same)",
    desc: "e.g. Buy a pair of socks and take another one for free.",
    IllusComponent: () => (
      <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", justifyContent: "space-around", width: "100%", position: "absolute", top: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6d7175" }}>Buy One</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6d7175" }}>Get One</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <div className="rd-style-037">👕</div>
          <div style={{ width: 8, height: 1, background: "#e5e7eb" }} />
          <div className="rd-style-038">+</div>
          <div style={{ width: 8, height: 1, background: "#e5e7eb" }} />
          <div className="rd-style-039">👕</div>
        </div>
      </div>
    ),
  },
  {
    id: "buy_x_get_y",
    name: "Buy X get Y",
    desc: "e.g. Buy a shirt and get a cap for free.",
    IllusComponent: () => (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", height: "100%" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6d7175", marginBottom: 4 }}>Buy X</div>
          <div className="rd-style-037">👕</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div className="rd-style-038">+</div>
          <div style={{ width: 20, height: 1, background: "#e5e7eb" }} />
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6d7175", marginBottom: 4 }}>Get Y</div>
          <div className="rd-style-039">🧢</div>
        </div>
      </div>
    ),
  },
  {
    id: "tiered",
    name: "Tiered spend with gifts",
    desc: "e.g. Spend $500 get 1 gift, $1000 get 2 gifts.",
    IllusComponent: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 8px", width: "100%" }}>
        {[{ amt: "$500", done: true }, { amt: "$1000", done: true }, { amt: "$1500", done: false }].map((tier) => (
          <div key={tier.amt} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", background: "white", borderRadius: 6, border: "1px solid #e5e7eb" }}>
            <div className="rd-style-040" style={{ background: tier.done ? "#008060" : "#e5e7eb" }}>
              {tier.done ? "✓" : ""}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: tier.done ? "#202223" : "#babec3", flex: 1 }}>SPEND {tier.amt}</span>
            <span style={{ fontSize: 14 }}>{tier.done ? "🎁" : ""}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "custom",
    name: "Can't find the template you need?",
    desc: "Create an offer manually, from conditions to gifts.",
    IllusComponent: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 8px", width: "100%" }}>
        {[
          { label: "Main condition", icons: "🛒💳🔄" },
          { label: "Discount type", value: "Percent  Amount" },
          { label: "Amount", value: "% 30" },
        ].map((row) => (
          <div key={row.label} className="rd-style-041">
            <span style={{ color: "#6d7175" }}>{row.label}</span>
            <span style={{ color: "#202223", fontWeight: 500 }}>{row.icons ?? row.value}</span>
          </div>
        ))}
      </div>
    ),
  },
];

/* ══════════════════════════════════════════════════════════
   MODAL 1 — Choose offer type (premium dark catalog)
   ══════════════════════════════════════════════════════════ */

const OFFER_CATALOG = [
  {
    value: "gift",
    name: "Gift offer",
    tagline: "Reward customers with free products",
    examples: ["Spend $400 → receive a gift", "Buy 3 products → get 1 free"],
    accent: "#f59e0b",
    glow: "rgba(245,158,11,0.18)",
    iconBg: "rgba(245,158,11,0.12)",
    iconBorder: "rgba(245,158,11,0.25)",
    Icon: GiftSvg,
  },
  {
    value: "bundle",
    name: "Bundle offer",
    tagline: "Group products into curated sets",
    examples: ["Buy A + B together with discount", "Classic, Mix & Match, Bundle Page"],
    accent: "#10b981",
    glow: "rgba(16,185,129,0.18)",
    iconBg: "rgba(16,185,129,0.10)",
    iconBorder: "rgba(16,185,129,0.22)",
    Icon: BundleSvg,
  },
  {
    value: "upsell",
    name: "Upsell offer",
    tagline: "Suggest higher-value alternatives",
    examples: ["Checkout upsell widget", "Frequently bought together"],
    accent: "#a78bfa",
    glow: "rgba(167,139,250,0.18)",
    iconBg: "rgba(167,139,250,0.10)",
    iconBorder: "rgba(167,139,250,0.22)",
    Icon: UpsellSvg,
  },
  {
    value: "discount",
    name: "Discount offer",
    tagline: "Volume pricing and cart incentives",
    examples: ["Buy 2 → 10% off, buy 3 → 30% off", "Cart value discount tiers"],
    accent: "#f472b6",
    glow: "rgba(244,114,182,0.18)",
    iconBg: "rgba(244,114,182,0.10)",
    iconBorder: "rgba(244,114,182,0.22)",
    Icon: DiscountSvg,
  },
];

function Modal1TypeSelector({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (type: string) => void;
}) {
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const handleMouseEnter = useCallback((type: string) => setHoveredType(type), []);
  const handleMouseLeave = useCallback(() => setHoveredType(null), []);
  const handleSelect = useCallback((type: string) => onSelect(type), [onSelect]);

  return (
    <AccessibleModal ariaLabel="Create a new offer" onClose={onClose} style={{ maxWidth: 580 }}>
        <div className="b-modal-header">
          <div>
            <h2 className="b-modal-title">Create a new offer</h2>
            <p className="b-modal-subtitle">Choose the promotion type that fits your strategy</p>
          </div>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="b-modal-body" style={{ padding: "20px 24px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {OFFER_CATALOG.map((type) => {
              const isHovered = hoveredType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => handleSelect(type.value)}
                  onMouseEnter={() => handleMouseEnter(type.value)}
                  onMouseLeave={handleMouseLeave}
                  className="rd-style-042" style={{ border: `2px solid ${isHovered ? `var(--${type.value}-color)` : "var(--border)"}`, transform: isHovered ? "translateY(-3px)" : "translateY(0)", boxShadow: isHovered ? "0 8px 24px rgba(28,25,23,0.14), 0 2px 6px rgba(28,25,23,0.08)" : "0 1px 3px rgba(28,25,23,0.06)" }}
                >
                  {/* Gradient illustration band */}
                  <div style={{
                    background: `var(--${type.value}-grad)`,
                    height: 92,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    position: "relative", overflow: "hidden",
                  }}>
                    <div className="rd-style-043" />
                    <div className="rd-style-044" />
                    <div className="rd-style-045">
                      <type.Icon />
                    </div>
                  </div>

                  {/* Content */}
                  <div style={{ padding: "14px 16px 16px", flex: 1, display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 3, fontFamily: "var(--font-display)", letterSpacing: "-0.2px" }}>
                      {type.name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>
                      {type.tagline}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                      {type.examples.map((ex) => (
                        <div key={ex} style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
                          <div style={{ width: 4, height: 4, borderRadius: "50%", flexShrink: 0, background: `var(--${type.value}-color)`, marginTop: 6 }} />
                          <span style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{ex}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border-light)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: `var(--${type.value}-color)` }}>Get started</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                        style={{ color: `var(--${type.value}-color)`, transition: "transform 0.18s", transform: isHovered ? "translateX(2px)" : "translateX(0)" }}>
                        <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
                      </svg>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
    </AccessibleModal>
  );
}

/* ══════════════════════════════════════════════════════════
   MODAL 2 — Gift offer: scratch or template
   ══════════════════════════════════════════════════════════ */
function Modal2GiftWizard({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const navigate = useNavigate();

  return (
    <AccessibleModal ariaLabel="Create gift offer" onClose={onClose}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Create gift offer</h2>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div className="b-modal-body">
          {/* Scratch option */}
          <button
            type="button"
            className={`b-template-scratch${selected === "scratch" ? " selected" : ""}`}
            onClick={() => setSelected("scratch")}
          >
            <div className="b-template-scratch-title">Start from scratch</div>
            <div className="b-template-scratch-desc">Create offers manually, from conditions to gifts.</div>
          </button>

          <div className="b-template-divider">or</div>

          <p className="b-template-section-label">Choose a template:</p>

          {/* Template grid */}
          <div className="b-template-grid">
            {GIFT_TEMPLATES.map((tmpl) => (
              <button
                type="button"
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
                aria-pressed={selected === tmpl.id}
              >
                <div className="b-template-illus">
                  <tmpl.IllusComponent />
                </div>
                <div className="b-template-info">
                  <div className="b-template-radio-row" aria-hidden="true">
                    <span className={`b-template-radio${selected === tmpl.id ? " selected" : ""}`} />
                  </div>
                  <p className="b-template-name">{tmpl.name}</p>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </button>
            ))}
          </div>

        </div>
        <div className="b-modal-footer">
          <button type="button" className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button type="button"
            className="b-btn b-btn-dark"
            onClick={() => {
              void navigate(`/app/offers/new/gift/${GIFT_SLUG_MAP[selected ?? "scratch"] ?? selected ?? "scratch"}`);
              onClose();
            }}
          >
            Create offer
          </button>
        </div>
    </AccessibleModal>
  );
}

/* ══════════════════════════════════════════════════════════
   MODAL 2 — BUNDLE: choose bundle sub-type
   ══════════════════════════════════════════════════════════ */
const BUNDLE_TEMPLATES = [
  {
    id: "classic",
    name: "Classic bundle",
    desc: "e.g. Buy a bundle of A and B with discount.",
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Save more with this bundle</div>
        {[
          { name: "Radiant Glow Serum", qty: "x2", price: "$105.00", orig: "$150.00" },
          { name: "Velvet Matte Lipstick", qty: "x1", price: "$15.00", orig: "$20.00" },
        ].map((item) => (
          <div key={item.name} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, color: "#202223" }}>{item.name}</div>
              <div style={{ fontSize: 12, color: "#6d7175" }}>{item.qty}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#2c6ecb" }}>{item.price}</div>
              <div style={{ fontSize: 12, color: "#babec3", textDecoration: "line-through" }}>{item.orig}</div>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #f3f4f6", paddingTop: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: "#6d7175" }}>Total bundle price</span>
          <div>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#202223" }}>$120.00 </span>
            <span style={{ fontSize: 12, color: "#babec3", textDecoration: "line-through" }}>$170.00</span>
          </div>
        </div>
        <div style={{ background: "#2c6ecb", color: "white", textAlign: "center", padding: "5px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>ADD BUNDLE TO CART</div>
      </div>
    ),
  },
  {
    id: "mix",
    name: "Mix and match",
    desc: "Mix your favorite items from a list to create a perfect combination",
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Mix your own bundle</div>
        {[
          { name: "Radiant Glow Serum", price: "$105.00", checked: false },
          { name: "Mix item 2", price: "", change: true, checked: true },
          { name: "Velvet Matte Lipstick", price: "$15.00", checked: false },
          { name: "Mix item 3", price: "", change: true, checked: false },
        ].map((item) => (
          <div key={item.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{
                width: 14, height: 14, borderRadius: 2, border: "1.5px solid #e5e7eb", flexShrink: 0,
                background: item.checked ? "#2c6ecb" : "white",
              }} />
              <span style={{ fontSize: 12, color: "#202223" }}>{item.name}</span>
            </div>
            {item.change
              ? <span style={{ fontSize: 12, color: "#2c6ecb", border: "1px solid #2c6ecb", padding: "1px 4px", borderRadius: 3 }}>CHANGE</span>
              : <span style={{ fontSize: 12, fontWeight: 600, color: "#202223" }}>{item.price}</span>}
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "build_a_box",
    name: "Bundle page",
    desc: "Allow customers to create their own bundle on a single page",
    shopifyPlus: true,
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", position: "relative" }}>
        <div style={{ position: "absolute", top: -8, right: 8 }}>
          <span style={{ background: "#fbbf24", color: "#78350f", fontSize: 12, fontWeight: 700, padding: "2px 6px", borderRadius: 10 }}>+ Shopify Plus only</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: "#202223" }}>Select items for your own bundle</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {["#2c6ecb", "#e5e7eb", "#e5e7eb"].map((c, i) => (
            <div key={i} style={{ flex: 1, height: 4, background: c, borderRadius: 2 }} />
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} style={{ background: "#f3f4f6", borderRadius: 4, height: 28, border: "1px solid #e5e7eb" }} />
          ))}
        </div>
        <div style={{ marginTop: 8, height: 16, background: "#2c6ecb", borderRadius: 4 }} />
      </div>
    ),
  },
];

function Modal2BundleWizard({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string>("classic");
  const navigate = useNavigate();
  return (
    <AccessibleModal ariaLabel="Choose the type of bundle" onClose={onClose}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Choose the type of bundle</h2>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {BUNDLE_TEMPLATES.map((tmpl) => (
              <button
                type="button"
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
                aria-pressed={selected === tmpl.id}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row" aria-hidden="true">
                    <span className={`b-template-radio${selected === tmpl.id ? " selected" : ""}`} />
                    <p className="b-template-name">
                      {tmpl.name}
                      {tmpl.shopifyPlus && <span className="b-shopify-plus-badge">Shopify Plus only</span>}
                    </p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="b-modal-footer">
          <button type="button" className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button type="button" className="b-btn b-btn-dark" onClick={() => { void navigate(`/app/offers/new/bundle/${BUNDLE_SLUG_MAP[selected] ?? selected}`); onClose(); }}>Create bundle</button>
        </div>
    </AccessibleModal>
  );
}

/* ══════════════════════════════════════════════════════════
   MODAL 2 — UPSELL: choose upsell sub-type
   ══════════════════════════════════════════════════════════ */
const UPSELL_TEMPLATES = [
  {
    id: "checkout",
    name: "Checkout upsell",
    desc: "Encourage your customer to buy more at checkout",
    shopifyPlus: true,
    IllusComponent: () => (
      <div style={{ width: "90%", background: "white", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", position: "relative" }}>
        <div className="rd-style-046">+ Shopify Plus</div>
        <div style={{ background: "#f3f4f6", padding: "8px 10px" }}>
          <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, marginBottom: 4, width: "60%" }} />
          <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, width: "40%" }} />
        </div>
        <div style={{ padding: "8px 10px", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ width: 32, height: 32, background: "#f3f4f6", borderRadius: 4, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#202223", marginBottom: 2 }}>Radiant Glow Serum</div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#2c6ecb", fontWeight: 700 }}>$5.99</span>
              <span style={{ fontSize: 12, textDecoration: "line-through", color: "#babec3" }}>$9.99</span>
            </div>
          </div>
          <div style={{ background: "#2c6ecb", color: "white", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 4 }}>ADD</div>
        </div>
        <div style={{ padding: "4px 10px 8px" }}>
          {[1, 2, 3].map((i) => <div key={i} style={{ height: 4, background: "#f3f4f6", borderRadius: 2, marginBottom: 4 }} />)}
        </div>
      </div>
    ),
  },
  {
    id: "fbt",
    name: "Frequently bought together",
    desc: "Sell more to your customers with complementary or related products",
    IllusComponent: () => (
      <div style={{ width: "90%", background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#202223", marginBottom: 8 }}>Frequently bought together</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
          {["🧴", "💄", "🧴"].map((emoji, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div className="rd-style-047">{emoji}</div>
              {i < 2 && <span style={{ color: "#6d7175", fontSize: 12 }}>+</span>}
            </span>
          ))}
          <div style={{ background: "#2c6ecb", color: "white", fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 4, marginLeft: 4 }}>ADD</div>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: i === 2 ? "#2c6ecb" : "#e5e7eb", border: "1.5px solid #babec3" }} />
            <div style={{ flex: 1, height: 4, background: "#f3f4f6", borderRadius: 2 }} />
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "thank_you",
    name: "Thank you page upsell",
    desc: "Encourage your customer to buy more on the thank you page",
    IllusComponent: () => (
      <div style={{ width: "90%", background: "white", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ background: "#f3f4f6", padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <div className="rd-style-048">✓</div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#202223" }}>Thank you</span>
        </div>
        <div style={{ padding: "8px 10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            {[1, 2, 3].map((i) => <div key={i} style={{ height: 4, background: "#f3f4f6", borderRadius: 2, marginBottom: 4 }} />)}
            <div style={{ height: 20, background: "#f3f4f6", borderRadius: 4, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 12, color: "#6d7175" }}>📍</span>
            </div>
          </div>
          <div>
            <div className="rd-style-049">🧴</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#202223", marginBottom: 2 }}>Radiant Glow Serum</div>
            <div style={{ fontSize: 12, color: "#2c6ecb", fontWeight: 600, marginBottom: 4 }}>$5.99 <span style={{ color: "#babec3", textDecoration: "line-through" }}>$9.99</span></div>
            <div style={{ background: "#2c6ecb", color: "white", fontSize: 12, textAlign: "center", padding: "2px", borderRadius: 3 }}>ADD</div>
          </div>
        </div>
      </div>
    ),
  },
];

function Modal2UpsellWizard({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string>("fbt");
  const navigate = useNavigate();
  return (
    <AccessibleModal ariaLabel="Choose the type of offer" onClose={onClose}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Choose the type of offer</h2>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {UPSELL_TEMPLATES.map((tmpl) => (
              <button
                type="button"
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
                aria-pressed={selected === tmpl.id}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row" aria-hidden="true">
                    <span className={`b-template-radio${selected === tmpl.id ? " selected" : ""}`} />
                    <p className="b-template-name">
                      {tmpl.name}
                      {tmpl.shopifyPlus && <span className="b-shopify-plus-badge">Shopify Plus only</span>}
                    </p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="b-modal-footer">
          <button type="button" className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button type="button" className="b-btn b-btn-dark" onClick={() => { void navigate(`/app/offers/new/upsell/${UPSELL_SLUG_MAP[selected] ?? selected}`); onClose(); }}>Create upsell</button>
        </div>
    </AccessibleModal>
  );
}

/* ══════════════════════════════════════════════════════════
   MODAL 2 — DISCOUNT: choose discount sub-type
   ══════════════════════════════════════════════════════════ */
const DISCOUNT_TEMPLATES = [
  {
    id: "volume",
    name: "Volume discount",
    desc: "e.g. Buy 2 with 10% off, buy 3 with 30% off.",
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Buy more get more</div>
        {[
          { qty: "1 Item", price: "$20.00", badge: null, selected: false },
          { qty: "2 Items", price: "$36.00", badge: "10% OFF", orig: "$40.00", selected: true },
          { qty: "3 Items", price: "$58.00", badge: "30% OFF", orig: "$60.00", selected: false },
        ].map((row) => (
          <div key={row.qty} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px solid #babec3", background: row.selected ? "#2c6ecb" : "white", flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, color: "#202223" }}>{row.qty}</span>
            {row.badge && <span style={{ background: "#fbbf24", color: "#78350f", fontSize: 12, fontWeight: 700, padding: "1px 4px", borderRadius: 3 }}>{row.badge}</span>}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: row.selected ? "#2c6ecb" : "#202223" }}>{row.price}</div>
              {row.orig && <div style={{ fontSize: 12, textDecoration: "line-through", color: "#babec3" }}>{row.orig}</div>}
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "cheapest",
    name: "Cheapest/most expensive item discount",
    desc: "e.g. Buy 3 get 1 cheapest item free",
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Buy 3 get cheapest free</div>
        {[true, false, false].map((checked, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px solid #babec3", background: checked ? "#2c6ecb" : "white", flexShrink: 0 }} />
            <div style={{ flex: 1, height: 4, background: "#f3f4f6", borderRadius: 2 }} />
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
          {["🧴", "💄", "🧴"].map((emoji, i) => (
            <div key={i} className="rd-style-050">
              <span style={{ fontSize: 14 }}>{emoji}</span>
              <div style={{ width: "100%", height: 12, background: "#2c6ecb", borderRadius: 2 }} />
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "cart",
    name: "Cart discount",
    desc: "e.g. Buy $500 and get 10% off.",
    IllusComponent: () => (
      <div style={{ width: "90%", display: "flex", flexDirection: "column", gap: 6 }}>
        {[
          { label: "Buy $ 300 get 5% OFF", active: false, loading: false },
          { label: "Buy $ 500 get 10% OFF", active: true, loading: false },
          { label: "Buy $ 800 get 15% OFF", active: false, loading: true },
        ].map((tier) => (
          <div key={tier.label} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "5px 10px",
            background: tier.active ? "#eff6ff" : "white",
            border: `1.5px solid ${tier.active ? "#2c6ecb" : "#e5e7eb"}`,
            borderRadius: 6,
          }}>
            <div className="rd-style-051" style={{ background: tier.loading ? "transparent" : tier.active ? "#2c6ecb" : "white" }}>
              {tier.loading && <div style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #babec3", borderTopColor: "#2c6ecb" }} />}
            </div>
            <span style={{ fontSize: 12, fontWeight: tier.active ? 700 : 400, color: tier.active ? "#2c6ecb" : tier.loading ? "#babec3" : "#6d7175" }}>{tier.label}</span>
          </div>
        ))}
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
          <div className="rd-style-052">🛒</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6d7175", letterSpacing: "0.5px" }}>CART VALUE</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#202223" }}>$ 514.99</div>
          </div>
        </div>
      </div>
    ),
  },
];

function Modal2DiscountWizard({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string>("volume");
  const navigate = useNavigate();
  return (
    <AccessibleModal ariaLabel="Create discount offer" onClose={onClose}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Create discount offer</h2>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {DISCOUNT_TEMPLATES.map((tmpl) => (
              <button
                type="button"
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
                aria-pressed={selected === tmpl.id}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row" aria-hidden="true">
                    <span className={`b-template-radio${selected === tmpl.id ? " selected" : ""}`} />
                    <p className="b-template-name">{tmpl.name}</p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="b-modal-footer">
          <button type="button" className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button type="button" className="b-btn b-btn-dark" onClick={() => { void navigate(`/app/offers/new/discount/${DISCOUNT_SLUG_MAP[selected] ?? selected}`); onClose(); }}>Create discount</button>
        </div>
    </AccessibleModal>
  );
}

type OfferCreateModalFlowProps = {
  modal: OfferCreateModalType;
  onClose: () => void;
  onChange: (modal: OfferCreateModalType) => void;
};

export default function OfferCreateModalFlow({ modal, onClose, onChange }: OfferCreateModalFlowProps) {
  if (modal === "type") {
    return (
      <Modal1TypeSelector
        onClose={onClose}
        onSelect={(type) => {
          if (type === "gift" || type === "bundle" || type === "upsell" || type === "discount") {
            onChange(type);
          }
        }}
      />
    );
  }

  if (modal === "gift") {
    return <Modal2GiftWizard onClose={onClose} onBack={() => onChange("type")} />;
  }

  if (modal === "bundle") {
    return <Modal2BundleWizard onClose={onClose} onBack={() => onChange("type")} />;
  }

  if (modal === "upsell") {
    return <Modal2UpsellWizard onClose={onClose} onBack={() => onChange("type")} />;
  }

  return <Modal2DiscountWizard onClose={onClose} onBack={() => onChange("type")} />;
}
