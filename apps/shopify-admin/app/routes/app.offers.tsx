import { useLoaderData, useNavigate, useSearchParams, Form } from "react-router";
import { useState, useRef } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers } from "@promo/db";
import { eq, and, like, desc } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  GiftIcon, IconCopy, IconTrash, IconEye, IconSearch, IconFilter,
  IconChevronDown, SortIcon,
} from "../components/Icons.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { OfferToggle } from "../components/BogosSwitch.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

type OfferStatus = "draft" | "active" | "paused" | "scheduled" | "expired" | "archived";
type OfferType = "gift" | "bundle" | "upsell" | "discount" | "booster";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") as OfferStatus | null;
  const search = url.searchParams.get("q") ?? "";

  const conditions = [];
  if (statusFilter && statusFilter !== "all") conditions.push(eq(offers.status, statusFilter));
  if (search) conditions.push(like(offers.internalName, `%${search}%`));

  const rows = await db
    .select({
      id: offers.id,
      type: offers.type,
      status: offers.status,
      internalName: offers.internalName,
      publicTitle: offers.publicTitle,
      priority: offers.priority,
      startsAt: offers.startsAt,
      updatedAt: offers.updatedAt,
    })
    .from(offers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(offers.priority, desc(offers.updatedAt))
    .limit(100);

  return {
    offers: rows.map((row) => ({
      ...row,
      startsAt: row.startsAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const offerIds = formData.getAll("offerIds[]") as string[];

  switch (intent) {
    case "bulk_pause":
      for (const id of offerIds) {
        await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(eq(offers.id, id));
      }
      break;
    case "bulk_activate":
      for (const id of offerIds) {
        await db.update(offers).set({ status: "active", updatedAt: new Date() }).where(eq(offers.id, id));
      }
      break;
    case "toggle_status": {
      const offerId = formData.get("offerId") as string;
      const currentStatus = formData.get("currentStatus") as string;
      const newStatus = currentStatus === "active" ? "paused" : "active";
      await db.update(offers).set({ status: newStatus, updatedAt: new Date() }).where(eq(offers.id, offerId));
      break;
    }
    case "delete": {
      const offerId = formData.get("offerId") as string;
      await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, offerId));
      break;
    }
  }

  return null;
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type OfferRow = {
  id: string;
  type: string;
  status: string;
  internalName: string;
  publicTitle: string | null;
  priority: number;
  startsAt: string | null;
  updatedAt: string;
};


const TABS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Disabled", value: "paused" },
  { label: "Scheduled", value: "scheduled" },
  { label: "Expired", value: "expired" },
];

const TYPE_LABEL: Record<string, string> = {
  gift: "Gift",
  bundle: "Bundle",
  upsell: "Upsell",
  discount: "Discount",
  booster: "Booster",
};

/* ══════════════════════════════════════════════════════════
   OFFER TYPE ICONS (SVG line-art on blue gradient background)
   ══════════════════════════════════════════════════════════ */
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

const OFFER_TYPES_MODAL = [
  {
    value: "gift",
    Icon: GiftSvg,
    name: "Gift offer",
    tag: "Example",
    bullets: ["Spend $400 to receive a gift", "Buy 3 products to receive a gift"],
  },
  {
    value: "bundle",
    Icon: BundleSvg,
    name: "Bundle offer",
    tag: "Example",
    bullets: ["Buy a bundle of A and B with discount"],
  },
  {
    value: "upsell",
    Icon: UpsellSvg,
    name: "Upsell offer",
    tag: "Example",
    bullets: [
      "Buy an item from a collection at half the deactivation price",
      "Buy the second item at half price",
    ],
  },
  {
    value: "discount",
    Icon: DiscountSvg,
    name: "Discount offer",
    tag: "Example",
    bullets: ["Buy 2 with 10% off, buy 3 with 30% off"],
  },
];

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
        <div style={{ background: "#3b82f6", color: "white", fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, position: "absolute", top: 8, right: 8 }}>1 item Added!</div>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "white", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🛒</div>
        <span style={{ color: "#6d7175", fontSize: 18 }}>→</span>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "white", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🧴</div>
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
          <span style={{ fontSize: 10, fontWeight: 700, color: "#6d7175" }}>Buy One</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#6d7175" }}>Get One</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#f3f4f6", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>👕</div>
          <div style={{ width: 8, height: 1, background: "#e5e7eb" }} />
          <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700 }}>+</div>
          <div style={{ width: 8, height: 1, background: "#e5e7eb" }} />
          <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fff3e0", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>👕</div>
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
          <div style={{ fontSize: 9, fontWeight: 700, color: "#6d7175", marginBottom: 4 }}>Buy X</div>
          <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#f3f4f6", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>👕</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700 }}>+</div>
          <div style={{ width: 20, height: 1, background: "#e5e7eb" }} />
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#6d7175", marginBottom: 4 }}>Get Y</div>
          <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fff3e0", border: "1.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧢</div>
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
            <div style={{ width: 14, height: 14, borderRadius: "50%", background: tier.done ? "#008060" : "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "white", fontWeight: 700, flexShrink: 0 }}>
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
          <div key={row.label} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", fontSize: 11, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#6d7175" }}>{row.label}</span>
            <span style={{ color: "#202223", fontWeight: 500 }}>{row.icons ?? row.value}</span>
          </div>
        ))}
      </div>
    ),
  },
];

/* ══════════════════════════════════════════════════════════
   MODAL 1 — Choose offer type
   ══════════════════════════════════════════════════════════ */
function Modal1TypeSelector({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (type: string) => void;
}) {
  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal b-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Choose the type of offer</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b-modal-body">
          <p style={{ textAlign: "center", fontSize: 14, fontWeight: 500, color: "var(--text)", margin: "0 0 16px" }}>
            Choose a type of offer to start
          </p>
          <div className="b-offer-type-list">
            {OFFER_TYPES_MODAL.map((t) => (
              <div key={t.value} className="b-offer-type-card">
                <div className="b-type-icon-wrap">
                  <t.Icon />
                </div>
                <div className="b-offer-type-body">
                  <p className="b-offer-type-name">{t.name}</p>
                  <p className="b-offer-type-tag">{t.tag}</p>
                  <ul className="b-offer-type-bullets">
                    {t.bullets.map((b) => <li key={b}>{b}</li>)}
                  </ul>
                </div>
                <div className="b-offer-type-action">
                  <button
                    className="b-btn b-btn-secondary b-btn-sm"
                    onClick={() => onSelect(t.value)}
                  >
                    Start &gt;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
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
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Create gift offer</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b-modal-body">
          {/* Scratch option */}
          <div
            className={`b-template-scratch${selected === "scratch" ? " selected" : ""}`}
            onClick={() => setSelected("scratch")}
          >
            <div className="b-template-scratch-title">Start from scratch</div>
            <div className="b-template-scratch-desc">Create offers manually, from conditions to gifts.</div>
          </div>

          <div className="b-template-divider">O</div>

          <p className="b-template-section-label">Choose a template:</p>

          {/* Template grid */}
          <div className="b-template-grid">
            {GIFT_TEMPLATES.map((tmpl) => (
              <div
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
              >
                <div className="b-template-illus">
                  <tmpl.IllusComponent />
                </div>
                <div className="b-template-info">
                  <div className="b-template-radio-row">
                    <input
                      type="radio"
                      name="template"
                      value={tmpl.id}
                      checked={selected === tmpl.id}
                      onChange={() => setSelected(tmpl.id)}
                      style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                    />
                  </div>
                  <p className="b-template-name">{tmpl.name}</p>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Hidden form for submission */}
          <Form ref={formRef} method="POST" action="/app/offers/new" style={{ display: "none" }}>
            <input type="hidden" name="offerType" value="gift" />
            <input type="hidden" name="template" value={selected ?? "scratch"} />
            <input type="hidden" name="internalName" value={`Gift Offer ${new Date().toLocaleDateString()}`} />
            <input type="hidden" name="publicTitle" value="Free Gift with Purchase" />
            <input type="hidden" name="priority" value="100" />
          </Form>
        </div>
        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button
            className="b-btn b-btn-dark"
            onClick={() => formRef.current?.submit()}
          >
            Create offer
          </button>
        </div>
      </div>
    </div>
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
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 11 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Save more with this bundle</div>
        {[
          { name: "Radiant Glow Serum", qty: "x2", price: "$105.00", orig: "$150.00" },
          { name: "Velvet Matte Lipstick", qty: "x1", price: "$15.00", orig: "$20.00" },
        ].map((item) => (
          <div key={item.name} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: "#202223" }}>{item.name}</div>
              <div style={{ fontSize: 10, color: "#6d7175" }}>{item.qty}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#2c6ecb" }}>{item.price}</div>
              <div style={{ fontSize: 10, color: "#babec3", textDecoration: "line-through" }}>{item.orig}</div>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #f3f4f6", paddingTop: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: "#6d7175" }}>Total bundle price</span>
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#202223" }}>$120.00 </span>
            <span style={{ fontSize: 10, color: "#babec3", textDecoration: "line-through" }}>$170.00</span>
          </div>
        </div>
        <div style={{ background: "#2c6ecb", color: "white", textAlign: "center", padding: "5px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>ADD BUNDLE TO CART</div>
      </div>
    ),
  },
  {
    id: "mix",
    name: "Mix and match",
    desc: "Mix your favorite items from a list to create a perfect combination",
    IllusComponent: () => (
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 11 }}>
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
              <span style={{ fontSize: 10, color: "#202223" }}>{item.name}</span>
            </div>
            {item.change
              ? <span style={{ fontSize: 9, color: "#2c6ecb", border: "1px solid #2c6ecb", padding: "1px 4px", borderRadius: 3 }}>CHANGE</span>
              : <span style={{ fontSize: 10, fontWeight: 600, color: "#202223" }}>{item.price}</span>}
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
          <span style={{ background: "#fbbf24", color: "#78350f", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 10 }}>+ Shopify Plus only</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 8, color: "#202223" }}>Select items for your own bundle</div>
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
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Choose the type of bundle</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {BUNDLE_TEMPLATES.map((tmpl) => (
              <div
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row">
                    <input type="radio" name="bundle_template" value={tmpl.id} checked={selected === tmpl.id} onChange={() => setSelected(tmpl.id)} style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                    <p className="b-template-name">
                      {tmpl.name}
                      {tmpl.shopifyPlus && <span className="b-shopify-plus-badge">Shopify Plus only</span>}
                    </p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Form ref={formRef} method="POST" action="/app/offers/new" style={{ display: "none" }}>
            <input type="hidden" name="offerType" value="bundle" />
            <input type="hidden" name="template" value={selected} />
            <input type="hidden" name="internalName" value={`Bundle Offer ${new Date().toLocaleDateString()}`} />
            <input type="hidden" name="publicTitle" value="Bundle Deal" />
            <input type="hidden" name="priority" value="100" />
          </Form>
        </div>
        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button className="b-btn b-btn-dark" onClick={() => formRef.current?.submit()}>Create bundle</button>
        </div>
      </div>
    </div>
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
        <div style={{ position: "absolute", top: 0, right: 0, background: "#fbbf24", fontSize: 8, fontWeight: 700, padding: "2px 6px", color: "#78350f" }}>+ Shopify Plus</div>
        <div style={{ background: "#f3f4f6", padding: "8px 10px" }}>
          <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, marginBottom: 4, width: "60%" }} />
          <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, width: "40%" }} />
        </div>
        <div style={{ padding: "8px 10px", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ width: 32, height: 32, background: "#f3f4f6", borderRadius: 4, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#202223", marginBottom: 2 }}>Radiant Glow Serum</div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#2c6ecb", fontWeight: 700 }}>$5.99</span>
              <span style={{ fontSize: 9, textDecoration: "line-through", color: "#babec3" }}>$9.99</span>
            </div>
          </div>
          <div style={{ background: "#2c6ecb", color: "white", fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4 }}>ADD</div>
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
        <div style={{ fontSize: 11, fontWeight: 700, color: "#202223", marginBottom: 8 }}>Frequently bought together</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
          {["🧴", "💄", "🧴"].map((emoji, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 28, background: "#f3f4f6", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>{emoji}</div>
              {i < 2 && <span style={{ color: "#6d7175", fontSize: 12 }}>+</span>}
            </span>
          ))}
          <div style={{ background: "#2c6ecb", color: "white", fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, marginLeft: 4 }}>ADD</div>
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
          <div style={{ width: 14, height: 14, borderRadius: "50%", border: "1.5px solid #008060", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#008060" }}>✓</div>
          <span style={{ fontSize: 10, fontWeight: 600, color: "#202223" }}>Thank you</span>
        </div>
        <div style={{ padding: "8px 10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            {[1, 2, 3].map((i) => <div key={i} style={{ height: 4, background: "#f3f4f6", borderRadius: 2, marginBottom: 4 }} />)}
            <div style={{ height: 20, background: "#f3f4f6", borderRadius: 4, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 8, color: "#6d7175" }}>📍</span>
            </div>
          </div>
          <div>
            <div style={{ width: "100%", height: 40, background: "#f3f4f6", borderRadius: 4, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>🧴</div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#202223", marginBottom: 2 }}>Radiant Glow Serum</div>
            <div style={{ fontSize: 9, color: "#2c6ecb", fontWeight: 600, marginBottom: 4 }}>$5.99 <span style={{ color: "#babec3", textDecoration: "line-through" }}>$9.99</span></div>
            <div style={{ background: "#2c6ecb", color: "white", fontSize: 8, textAlign: "center", padding: "2px", borderRadius: 3 }}>ADD</div>
          </div>
        </div>
      </div>
    ),
  },
];

function Modal2UpsellWizard({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string>("fbt");
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Choose the type of offer</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {UPSELL_TEMPLATES.map((tmpl) => (
              <div
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row">
                    <input type="radio" name="upsell_template" value={tmpl.id} checked={selected === tmpl.id} onChange={() => setSelected(tmpl.id)} style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                    <p className="b-template-name">
                      {tmpl.name}
                      {tmpl.shopifyPlus && <span className="b-shopify-plus-badge">Shopify Plus only</span>}
                    </p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Form ref={formRef} method="POST" action="/app/offers/new" style={{ display: "none" }}>
            <input type="hidden" name="offerType" value="upsell" />
            <input type="hidden" name="template" value={selected} />
            <input type="hidden" name="internalName" value={`Upsell Offer ${new Date().toLocaleDateString()}`} />
            <input type="hidden" name="publicTitle" value="Frequently Bought Together" />
            <input type="hidden" name="priority" value="100" />
          </Form>
        </div>
        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button className="b-btn b-btn-dark" onClick={() => formRef.current?.submit()}>Create upsell</button>
        </div>
      </div>
    </div>
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
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 11 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Buy more get more</div>
        {[
          { qty: "1 Item", price: "$20.00", badge: null, selected: false },
          { qty: "2 Items", price: "$36.00", badge: "10% OFF", orig: "$40.00", selected: true },
          { qty: "3 Items", price: "$58.00", badge: "30% OFF", orig: "$60.00", selected: false },
        ].map((row) => (
          <div key={row.qty} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px solid #babec3", background: row.selected ? "#2c6ecb" : "white", flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11, color: "#202223" }}>{row.qty}</span>
            {row.badge && <span style={{ background: "#fbbf24", color: "#78350f", fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3 }}>{row.badge}</span>}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: row.selected ? "#2c6ecb" : "#202223" }}>{row.price}</div>
              {row.orig && <div style={{ fontSize: 9, textDecoration: "line-through", color: "#babec3" }}>{row.orig}</div>}
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
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", width: "90%", fontSize: 11 }}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: "#202223" }}>Buy 3 get cheapest free</div>
        {[true, false, false].map((checked, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px solid #babec3", background: checked ? "#2c6ecb" : "white", flexShrink: 0 }} />
            <div style={{ flex: 1, height: 4, background: "#f3f4f6", borderRadius: 2 }} />
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
          {["🧴", "💄", "🧴"].map((emoji, i) => (
            <div key={i} style={{ flex: 1, background: "#f3f4f6", borderRadius: 4, padding: "4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
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
            <div style={{
              width: 14, height: 14, borderRadius: "50%",
              border: "1.5px solid #babec3",
              background: tier.loading ? "transparent" : tier.active ? "#2c6ecb" : "white",
              flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {tier.loading && <div style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #babec3", borderTopColor: "#2c6ecb" }} />}
            </div>
            <span style={{ fontSize: 10, fontWeight: tier.active ? 700 : 400, color: tier.active ? "#2c6ecb" : tier.loading ? "#babec3" : "#6d7175" }}>{tier.label}</span>
          </div>
        ))}
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 24, height: 24, background: "#f3f4f6", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>🛒</div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#6d7175", letterSpacing: "0.5px" }}>CART VALUE</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#202223" }}>$ 514.99</div>
          </div>
        </div>
      </div>
    ),
  },
];

function Modal2DiscountWizard({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string>("volume");
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <div className="b-modal-overlay" onClick={onClose}>
      <div className="b-modal" onClick={(e) => e.stopPropagation()}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Create discount offer</h2>
          <button className="b-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="b-modal-body">
          <div className="b-template-grid">
            {DISCOUNT_TEMPLATES.map((tmpl) => (
              <div
                key={tmpl.id}
                className={`b-template-card${selected === tmpl.id ? " selected" : ""}`}
                onClick={() => setSelected(tmpl.id)}
              >
                <div className="b-template-illus"><tmpl.IllusComponent /></div>
                <div className="b-template-info">
                  <div className="b-template-radio-row">
                    <input type="radio" name="discount_template" value={tmpl.id} checked={selected === tmpl.id} onChange={() => setSelected(tmpl.id)} style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                    <p className="b-template-name">{tmpl.name}</p>
                  </div>
                  <p className="b-template-desc">{tmpl.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Form ref={formRef} method="POST" action="/app/offers/new" style={{ display: "none" }}>
            <input type="hidden" name="offerType" value="discount" />
            <input type="hidden" name="template" value={selected} />
            <input type="hidden" name="internalName" value={`Discount Offer ${new Date().toLocaleDateString()}`} />
            <input type="hidden" name="publicTitle" value="Volume Discount" />
            <input type="hidden" name="priority" value="100" />
          </Form>
        </div>
        <div className="b-modal-footer">
          <button className="b-btn b-btn-secondary" onClick={onBack}>Back</button>
          <button className="b-btn b-btn-dark" onClick={() => formRef.current?.submit()}>Create discount</button>
        </div>
      </div>
    </div>
  );
}

export default function OffersPage() {
  const { offers: offerRows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bannerVisible, setBannerVisible] = useState(true);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Modal state
  const [modal, setModal] = useState<null | "type" | "gift" | "bundle" | "upsell" | "discount">(null);

  const activeTab = searchParams.get("status") ?? "all";

  function setTab(val: string) {
    if (val === "all") {
      setSearchParams({});
    } else {
      setSearchParams({ status: val });
    }
  }

  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === offerRows.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(offerRows.map((o) => o.id)));
    }
  }

  async function deleteOffer(id: string) {
    if (!confirm("Archive this offer?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("offerId", id);
    await fetch(window.location.pathname, { method: "POST", body: fd });
    window.location.reload();
  }

  return (
    <div className="b-page">
      {/* ── Modals ──────────────────────────────────────────── */}
      {modal === "type" && (
        <Modal1TypeSelector
          onClose={() => setModal(null)}
          onSelect={(type) => {
            if (type === "gift") setModal("gift");
            else if (type === "bundle") setModal("bundle");
            else if (type === "upsell") setModal("upsell");
            else if (type === "discount") setModal("discount");
          }}
        />
      )}
      {modal === "gift" && (
        <Modal2GiftWizard
          onClose={() => setModal(null)}
          onBack={() => setModal("type")}
        />
      )}
      {modal === "bundle" && (
        <Modal2BundleWizard onClose={() => setModal(null)} onBack={() => setModal("type")} />
      )}
      {modal === "upsell" && (
        <Modal2UpsellWizard onClose={() => setModal(null)} onBack={() => setModal("type")} />
      )}
      {modal === "discount" && (
        <Modal2DiscountWizard onClose={() => setModal(null)} onBack={() => setModal("type")} />
      )}
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="b-page-header">
        <h1 className="b-page-title">All Offers</h1>
        <div className="b-page-actions">
          <button className="b-btn b-btn-secondary">
            More actions <IconChevronDown />
          </button>
          <button className="b-btn b-btn-primary" onClick={() => setModal("type")}>
            Create offer
          </button>
        </div>
      </div>

      {/* ── Cart integration banner ─────────────────────────── */}
      {bannerVisible && (
        <div className="b-banner">
          <div className="b-banner-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#2c6ecb"/>
              <line x1="12" y1="8" x2="12" y2="12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="b-banner-body">
            <div className="b-banner-title">Cart integration</div>
            <p className="b-banner-text">
              If you&apos;re using a custom cart drawer/XHR, BOGOS may need a larger integration.{" "}
              <a href="#" style={{ color: "var(--blue)", textDecoration: "underline" }}>Send us a message</a> for support.
            </p>
          </div>
          <button className="b-banner-close" onClick={() => setBannerVisible(false)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ── Table card ──────────────────────────────────────── */}
      <div className="b-table-wrap">
        {/* Filter Tabs */}
        <div className="b-tabs">
          <ul className="b-tabs-list">
            {TABS.map((tab) => (
              <li key={tab.value}>
                <button
                  className={`b-tab${activeTab === tab.value ? " active" : ""}`}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                  onClick={() => setTab(tab.value)}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="b-tabs-actions">
            <button className="b-btn-icon" aria-label="Search"><IconSearch /></button>
            <button className="b-btn-icon" aria-label="Filter"><IconFilter /></button>
          </div>
        </div>

        {/* Table */}
        <table className="b-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  style={{ accentColor: "var(--blue)", width: 15, height: 15, cursor: "pointer" }}
                  checked={checkedIds.size === offerRows.length && offerRows.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon active="asc" />
                  <span>Título</span>
                </button>
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>Tipo de oferta</span>
                </button>
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>Fecha de inicio</span>
                </button>
              </th>
              <th><span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-sub)" }}>Estado</span></th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>Encendido apagado</span>
                </button>
              </th>
              <th><span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-sub)" }}>Comportamiento</span></th>
            </tr>
          </thead>
          <tbody>
            {offerRows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "48px 24px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 40 }}>🎁</div>
                    <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Create your first promotion</p>
                    <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
                      Add free gifts, bundles, upsells and discounts to your store.
                    </p>
                    <button className="b-btn b-btn-primary" onClick={() => setModal("type")}>Create offer</button>
                  </div>
                </td>
              </tr>
            ) : (
              offerRows.map((offer: OfferRow) => (
                <tr key={offer.id}>
                  <td>
                    <input
                      type="checkbox"
                      style={{ accentColor: "var(--blue)", width: 15, height: 15, cursor: "pointer" }}
                      checked={checkedIds.has(offer.id)}
                      onChange={() => toggleCheck(offer.id)}
                    />
                  </td>
                  {/* Título — title button + invisible eye on hover */}
                  <td onClick={() => navigate(`/app/offers/${offer.id}`)}>
                    <div className="bogos-offer-title-cell">
                      <button
                        type="button"
                        className="bogos-offer-title-text"
                        data-primary-link="true"
                      >
                        {offer.internalName}
                      </button>
                      <div className="bogos-row-reveal" title="Preview">
                        <span style={{ color: "var(--text-muted)", display: "flex" }}>
                          <IconEye />
                        </span>
                      </div>
                    </div>
                  </td>

                  {/* Tipo de oferta — gift SVG icon + label */}
                  <td>
                    <div className="bogos-type-cell">
                      <GiftIcon />
                      <span>{TYPE_LABEL[offer.type] ?? offer.type}</span>
                    </div>
                  </td>

                  {/* Fecha de inicio */}
                  <td>
                    <span style={{ fontSize: 14, color: "var(--text)" }}>
                      {formatDate(offer.startsAt ?? offer.updatedAt)}
                    </span>
                  </td>

                  {/* Estado badge */}
                  <td>
                    <StatusBadge status={offer.status} />
                  </td>

                  {/* Encendido apagado toggle */}
                  <td>
                    <div style={{ display: "flex", width: "fit-content" }}>
                      <OfferToggle offerId={offer.id} status={offer.status} />
                    </div>
                  </td>

                  {/* Comportamiento — duplicate + delete */}
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span title="Duplicate offer" tabIndex={0}>
                        <div className="cursor-pointer">
                          <button
                            type="button"
                            className="bogos-action-btn"
                            onClick={(e) => { e.stopPropagation(); navigate(`/app/offers/${offer.id}`); }}
                            aria-label="Duplicate"
                          >
                            <IconCopy />
                          </button>
                        </div>
                      </span>
                      <span title="Delete offer" tabIndex={0}>
                        <div className="cursor-pointer">
                          <button
                            type="button"
                            className="bogos-action-btn red"
                            onClick={(e) => { e.stopPropagation(); deleteOffer(offer.id); }}
                            aria-label="Delete"
                          >
                            <IconTrash />
                          </button>
                        </div>
                      </span>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
