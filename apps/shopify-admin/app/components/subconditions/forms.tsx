// Individual form for each subcondition type.
// Each export is a self-contained React component with its own local state.
// They are pure UI — the parent serializes their values via hidden inputs or
// a ref callback if structured submission is needed in the future.

import { useState } from "react";
import { ProductPicker } from "../ProductPicker.js";

// ─── Link ─────────────────────────────────────────────────────────────────────
export function LinkForm() {
  const [dest, setDest] = useState("home");
  const [word, setWord] = useState("");
  const generated = `https://giftswapp.com/?freegifts_code=${word || "<freegifts_code>"}`;
  const param = "?freegifts_code=";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label">Destino del enlace</label>
        <select className="b-select" value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="home">Home page</option>
          <option value="product">Product page</option>
          <option value="collection">Collection page</option>
          <option value="custom">Custom page</option>
        </select>
      </div>

      <div>
        <label className="b-label">Entrar a palabras para personalizar</label>
        <input className="b-input" value={word} onChange={(e) => setWord(e.target.value)}
          placeholder="E.g. summers2024" autoComplete="off" />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <label className="b-label" style={{ margin: 0 }}>Enlace generado</label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(generated)}
            style={{ fontSize: 11, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>
            Copiar link
          </button>
        </div>
        <input className="b-input" readOnly value={generated}
          style={{ background: "var(--bg)", color: "var(--text-sub)" }} />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <label className="b-label" style={{ margin: 0 }}>Parámetro</label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(param)}
            style={{ fontSize: 11, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>
            Copiar parámetro
          </button>
        </div>
        <input className="b-input" readOnly value={param}
          style={{ background: "var(--bg)", color: "var(--text-sub)" }} />
      </div>
    </div>
  );
}

// ─── Order history ────────────────────────────────────────────────────────────
export function OrderHistoryForm() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label">Orden creada a partir de</label>
        <input className="b-input" type="date" style={{ maxWidth: 200 }} />
      </div>
      {[
        "Total gastado en el historial de pedidos",
        "Total gastado en el último pedido",
        "Número total de pedidos realizados",
        "Limitar un número de usos por cliente",
      ].map((label) => (
        <label key={label} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
          <input type="checkbox" style={{ accentColor: "var(--blue)", width: 14, height: 14, flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
        </label>
      ))}
    </div>
  );
}

// ─── Customer tags ────────────────────────────────────────────────────────────
export function CustomerTagsForm() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label">Seleccionar etiquetas</label>
        <input className="b-input" placeholder="Seleccionar..." autoComplete="off" />
      </div>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Excluir clientes con estas etiquetas</span>
      </label>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Considere no iniciar sesión como cliente sin etiquetas</span>
      </label>
    </div>
  );
}

// ─── Location ─────────────────────────────────────────────────────────────────
export function LocationForm() {
  return (
    <div>
      <label className="b-label">Seleccionar países</label>
      <input className="b-input" placeholder="Seleccionar países..." autoComplete="off" />
    </div>
  );
}

// ─── Subscription ─────────────────────────────────────────────────────────────
export function SubscriptionForm() {
  const [mode, setMode] = useState("subscription");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Aplicar la oferta a:</div>
      {[
        { value: "subscription", label: "Solo productos de suscripción" },
        { value: "one_time",     label: "Productos de compra única" },
      ].map((opt) => (
        <label key={opt.value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
          <input type="radio" name="sub_subscription_mode" value={opt.value}
            checked={mode === opt.value} onChange={() => setMode(opt.value)}
            style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// ─── Sales channel ────────────────────────────────────────────────────────────
export function SalesChannelForm() {
  const [online, setOnline] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [pos, setPos]       = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Tienda en línea</span>
      </label>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Canal de aplicaciones móvil</span>
      </label>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" checked={pos} onChange={(e) => setPos(e.target.checked)}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Canal de punto de venta</span>
      </label>
      <div style={{ background: "#f0f4ff", border: "1px solid #c4d0fb", borderRadius: 6, padding: "10px 12px", fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
        De forma predeterminada, BOGOS trabaja con nuestro socio creador de aplicaciones móviles:{" "}
        <strong>OneMobile</strong>, <strong>Superflux</strong>. Si está utilizando una aplicación móvil
        personalizada, Contáctenos para la integración.
      </div>
    </div>
  );
}

// ─── Markets ──────────────────────────────────────────────────────────────────
export function MarketsForm() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: "#fff8e1", border: "1px solid #fbbf24", borderRadius: 6, padding: "10px 12px", fontSize: 12, color: "#78350f", lineHeight: 1.5 }}>
        ⚠ Esta condición requiere acceso adicional para obtener sus mercados existentes.
        <div style={{ marginTop: 6 }}>
          <button type="button"
            style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
            Actualizar permisos
          </button>
        </div>
      </div>
      <div>
        <label className="b-label">Seleccionar mercados</label>
        <input className="b-input" placeholder="Seleccionar..." autoComplete="off" />
      </div>
      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Excluir clientes de mercados seleccionados</span>
      </label>
    </div>
  );
}

// ─── Quantity limit ───────────────────────────────────────────────────────────
export function QuantityLimitForm() {
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [rules, setRules] = useState([{ qty: 1, scope: "specific_products", productIds: [] as string[] }]);
  const [pickerIdx, setPickerIdx] = useState<number | null>(null);

  function addRule() {
    setRules((r) => [...r, { qty: 1, scope: "specific_products", productIds: [] }]);
  }
  function removeRule(i: number) {
    setRules((r) => r.filter((_, idx) => idx !== i));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Los clientes deben tener:</div>
        <div style={{ display: "flex", gap: 16 }}>
          {[{ v: "all", l: "Todas las reglas" }, { v: "any", l: "Cualquier regla" }].map((opt) => (
            <label key={opt.v} className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
              <input type="radio" name="qty_match_mode" value={opt.v}
                checked={matchMode === opt.v}
                onChange={() => setMatchMode(opt.v as "all" | "any")}
                style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
              <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.l}</span>
            </label>
          ))}
        </div>
      </div>

      {rules.map((rule, i) => (
        <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>Comprar</span>
            <select className="b-select" style={{ width: 120 }} defaultValue="at_least">
              <option value="at_least">Al menos</option>
              <option value="exactly">Exactamente</option>
            </select>
            <input className="b-input" type="number" min="1" value={rule.qty}
              onChange={(e) => setRules((r) => r.map((x, idx) => idx === i ? { ...x, qty: parseInt(e.target.value) || 1 } : x))}
              style={{ width: 64 }} autoComplete="off" />
            <button type="button" onClick={() => removeRule(i)}
              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 18, lineHeight: 1 }}>
              ×
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>de</span>
            <select className="b-select" value={rule.scope}
              onChange={(e) => setRules((r) => r.map((x, idx) => idx === i ? { ...x, scope: e.target.value } : x))}>
              <option value="specific_products">productos seleccionados</option>
              <option value="any_product">cualquier producto</option>
            </select>
          </div>

          {rule.scope === "specific_products" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text-sub)" }}>Productos</span>
              <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setPickerIdx(i)}>
                Seleccionar productos
              </button>
              <span style={{ fontSize: 12, color: "var(--text-sub)" }}>
                {rule.productIds.length} productos seleccionados
              </span>
            </div>
          )}
        </div>
      ))}

      <button type="button" onClick={addRule}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--blue)", fontSize: 13, fontWeight: 500, textAlign: "left", padding: 0 }}>
        + Agregar regla
      </button>

      {pickerIdx !== null && (
        <ProductPicker
          open
          title="Seleccionar productos"
          allowMultiple
          selectedIds={rules[pickerIdx]?.productIds ?? []}
          onClose={() => setPickerIdx(null)}
          onSelect={(gids) => {
            setRules((r) => r.map((x, idx) => idx === pickerIdx ? { ...x, productIds: gids } : x));
            setPickerIdx(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Registry: id → form component ───────────────────────────────────────────
import type { SubconditionId } from "./types.js";

export const SUB_FORMS: Record<SubconditionId, () => JSX.Element> = {
  link:           LinkForm,
  order_history:  OrderHistoryForm,
  customer_tags:  CustomerTagsForm,
  location:       LocationForm,
  subscription:   SubscriptionForm,
  sales_channel:  SalesChannelForm,
  markets:        MarketsForm,
  quantity_limit: QuantityLimitForm,
};
