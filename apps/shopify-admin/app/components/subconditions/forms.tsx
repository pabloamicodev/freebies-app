// Individual form for each subcondition type.
// Each form receives `value` (external state) and `onChange` (persist callback).
// The parent serializes their values via hidden inputs on form submit.

import { useState, useId } from "react";
import { ProductPicker } from "../ProductPicker.js";
import type { SubconditionId } from "./types.js";

// ─── Shared props ─────────────────────────────────────────────────────────────
export interface SubFormProps {
  /** Current value (external state). Passed from parent so state survives collapses. */
  value?: Record<string, unknown>;
  /** Called whenever the form value changes, with the full serialised object. */
  onChange?: (value: Record<string, unknown>) => void;
}

// ─── Helper: typed input value from value prop ─────────────────────────────────
function getv(v: Record<string, unknown> | undefined, key: string, fallback: unknown): unknown {
  return v && key in v ? v[key] : fallback;
}

interface QuantityRule {
  id: string;
  qty: number;
  scope: string;
  operator: string;
  productIds: string[];
}

function createQuantityRule(overrides: Partial<Omit<QuantityRule, "id">> = {}): QuantityRule {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `qty-rule-${Date.now()}-${Math.random()}`,
    qty: 1,
    scope: "specific_products",
    operator: "at_least",
    productIds: [],
    ...overrides,
  };
}

function normalizeQuantityRules(rawRules: unknown): QuantityRule[] {
  if (!Array.isArray(rawRules) || rawRules.length === 0) return [createQuantityRule()];

  return rawRules.map((rule) => {
    const value = rule as Partial<QuantityRule>;
    return createQuantityRule({
      qty: typeof value.qty === "number" ? value.qty : 1,
      scope: typeof value.scope === "string" ? value.scope : "specific_products",
      operator: typeof value.operator === "string" ? value.operator : "at_least",
      productIds: Array.isArray(value.productIds) ? value.productIds.filter((id): id is string => typeof id === "string") : [],
    });
  });
}

function serializeQuantityRules(rules: QuantityRule[]): Array<Omit<QuantityRule, "id">> {
  return rules.map(({ id: _id, ...rule }) => rule);
}

const ORDER_HISTORY_LABELS = [
  "Total gastado en el historial de pedidos",
  "Total gastado en el último pedido",
  "Número total de pedidos realizados",
  "Limitar un número de usos por cliente",
];

// ─── Link ─────────────────────────────────────────────────────────────────────
export function LinkForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const dest = getv(value, "dest", "home") as string;
  const word = getv(value, "word", "") as string;

  function emit(d: string, w: string) {
    onChange?.({ dest: d, word: w });
  }

  const generated = `https://giftswapp.com/?freegifts_code=${word || "<freegifts_code>"}`;
  const param = "?freegifts_code=";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-dest`}>Destino del enlace</label>
        <select id={`${idPrefix}-dest`} aria-label="Destino del enlace" className="b-select" value={dest} onChange={(e) => emit(e.target.value, word)}>
          <option value="home">Home page</option>
          <option value="product">Product page</option>
          <option value="collection">Collection page</option>
          <option value="custom">Custom page</option>
        </select>
      </div>

      <div>
        <label className="b-label" htmlFor={`${idPrefix}-word`}>Entrar a palabras para personalizar</label>
        <input id={`${idPrefix}-word`} aria-label="Entrar a palabras para personalizar" className="b-input" value={word} onChange={(e) => emit(dest, e.target.value)}
          placeholder="E.g. summers2024" autoComplete="off" />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <label className="b-label" htmlFor={`${idPrefix}-generated`} style={{ margin: 0 }}>Enlace generado</label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(generated)}
            style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>
            Copiar link
          </button>
        </div>
        <input id={`${idPrefix}-generated`} aria-label="Enlace generado" className="b-input" readOnly value={generated}
          style={{ background: "var(--bg)", color: "var(--text-sub)" }} />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <label className="b-label" htmlFor={`${idPrefix}-param`} style={{ margin: 0 }}>Parámetro</label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(param)}
            style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>
            Copiar parámetro
          </button>
        </div>
        <input id={`${idPrefix}-param`} aria-label="Parámetro" className="b-input" readOnly value={param}
          style={{ background: "var(--bg)", color: "var(--text-sub)" }} />
      </div>
    </div>
  );
}

// ─── Order history ────────────────────────────────────────────────────────────
export function OrderHistoryForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const dateFrom = getv(value, "dateFrom", "") as string;
  const checkboxes = getv(value, "checkboxes", []) as number[];

  function toggle(idx: number) {
    const next = checkboxes.includes(idx) ? checkboxes.filter((x) => x !== idx) : [...checkboxes, idx];
    onChange?.({ dateFrom, checkboxes: next });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-date-from`}>Orden creada a partir de</label>
        <input id={`${idPrefix}-date-from`} aria-label="Orden creada a partir de" className="b-input" type="date" style={{ maxWidth: 200 }} value={dateFrom}
          onChange={(e) => onChange?.({ dateFrom: e.target.value, checkboxes })} />
      </div>
      {ORDER_HISTORY_LABELS.map((label, i) => (
        <label key={label} className="b-checkbox-row" htmlFor={`${idPrefix}-history-${i}`} style={{ cursor: "pointer", gap: 10 }}>
          <input id={`${idPrefix}-history-${i}`} aria-label={label} type="checkbox" checked={checkboxes.includes(i)} onChange={() => toggle(i)}
            style={{ accentColor: "var(--blue)", width: 14, height: 14, flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
        </label>
      ))}
    </div>
  );
}

// ─── Customer tags ────────────────────────────────────────────────────────────
export function CustomerTagsForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const tags = getv(value, "tags", "") as string;
  const exclude = getv(value, "exclude", false) as boolean;
  const guest = getv(value, "guest", false) as boolean;

  function emit(patch: Partial<Record<string, unknown>>) {
    const next = { tags, exclude, guest, ...patch };
    onChange?.(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-tags`}>Seleccionar etiquetas</label>
        <input id={`${idPrefix}-tags`} aria-label="Seleccionar etiquetas" className="b-input" placeholder="Seleccionar..." autoComplete="off" value={tags}
          onChange={(e) => emit({ tags: e.target.value })} />
      </div>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-exclude`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-exclude`} aria-label="Excluir clientes con estas etiquetas" type="checkbox" checked={exclude} onChange={(e) => emit({ exclude: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Excluir clientes con estas etiquetas</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-guest`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-guest`} aria-label="Considere no iniciar sesión como cliente sin etiquetas" type="checkbox" checked={guest} onChange={(e) => emit({ guest: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Considere no iniciar sesión como cliente sin etiquetas</span>
      </label>
    </div>
  );
}

// ─── Location ─────────────────────────────────────────────────────────────────
export function LocationForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const countries = getv(value, "countries", "") as string;

  return (
    <div>
      <label className="b-label" htmlFor={`${idPrefix}-countries`}>Seleccionar países</label>
      <input id={`${idPrefix}-countries`} aria-label="Seleccionar países" className="b-input" placeholder="Seleccionar países..." autoComplete="off" value={countries}
        onChange={(e) => onChange?.({ countries: e.target.value })} />
    </div>
  );
}

// ─── Subscription ─────────────────────────────────────────────────────────────
export function SubscriptionForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const mode = getv(value, "mode", "subscription") as string;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Aplicar la oferta a:</div>
      {[
        { value: "subscription", label: "Solo productos de suscripción" },
        { value: "one_time",     label: "Productos de compra única" },
      ].map((opt) => (
        <label key={opt.value} className="b-checkbox-row" htmlFor={`${idPrefix}-${opt.value}`} style={{ cursor: "pointer", gap: 10 }}>
          <input id={`${idPrefix}-${opt.value}`} aria-label={opt.label} type="radio" name="sub_subscription_mode" value={opt.value}
            checked={mode === opt.value}
            onChange={() => onChange?.({ mode: opt.value })}
            style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// ─── Sales channel ────────────────────────────────────────────────────────────
export function SalesChannelForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const online = getv(value, "online", true) as boolean;
  const mobile = getv(value, "mobile", false) as boolean;
  const pos = getv(value, "pos", false) as boolean;

  function emit(patch: Partial<Record<string, unknown>>) {
    const next = { online, mobile, pos, ...patch };
    onChange?.(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-online`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-online`} aria-label="Tienda en línea" type="checkbox" checked={online} onChange={(e) => emit({ online: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Tienda en línea</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-mobile`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-mobile`} aria-label="Canal de aplicaciones móvil" type="checkbox" checked={mobile} onChange={(e) => emit({ mobile: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Canal de aplicaciones móvil</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-pos`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-pos`} aria-label="Canal de punto de venta" type="checkbox" checked={pos} onChange={(e) => emit({ pos: e.target.checked })}
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
export function MarketsForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const marketIds = getv(value, "marketIds", "") as string;
  const exclude = getv(value, "exclude", false) as boolean;

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
        <label className="b-label" htmlFor={`${idPrefix}-markets`}>Seleccionar mercados</label>
        <input id={`${idPrefix}-markets`} aria-label="Seleccionar mercados" className="b-input" placeholder="Seleccionar..." autoComplete="off" value={marketIds}
          onChange={(e) => onChange?.({ marketIds: e.target.value, exclude })} />
      </div>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-exclude-markets`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-exclude-markets`} aria-label="Excluir clientes de mercados seleccionados" type="checkbox" checked={exclude}
          onChange={(e) => onChange?.({ marketIds, exclude: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Excluir clientes de mercados seleccionados</span>
      </label>
    </div>
  );
}

// ─── Quantity limit ───────────────────────────────────────────────────────────
export function QuantityLimitForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const [matchMode, setMatchMode] = useState<"all" | "any">(getv(value, "matchMode", "all") as "all" | "any");
  const [rules, setRules] = useState<QuantityRule[]>(
    () => normalizeQuantityRules(getv(value, "rules", undefined))
  );
  const [pickerIdx, setPickerIdx] = useState<number | null>(null);

  function emit(mm: "all" | "any", r: typeof rules) {
    setMatchMode(mm); setRules(r);
    onChange?.({ matchMode: mm, rules: serializeQuantityRules(r) });
  }

  function addRule() {
    const next = [...rules, createQuantityRule()];
    emit(matchMode, next);
  }
  function removeRule(i: number) {
    const next = rules.filter((_, idx) => idx !== i);
    emit(matchMode, next.length > 0 ? next : [createQuantityRule()]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Los clientes deben tener:</div>
        <div style={{ display: "flex", gap: 16 }}>
          {[{ v: "all", l: "Todas las reglas" }, { v: "any", l: "Cualquier regla" }].map((opt) => (
            <label key={opt.v} className="b-checkbox-row" htmlFor={`${idPrefix}-match-${opt.v}`} style={{ cursor: "pointer", gap: 8 }}>
              <input id={`${idPrefix}-match-${opt.v}`} aria-label={opt.l} type="radio" name="qty_match_mode" value={opt.v}
                checked={matchMode === opt.v}
                onChange={() => emit(opt.v as "all" | "any", rules)}
                style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
              <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.l}</span>
            </label>
          ))}
        </div>
      </div>

      {rules.map((rule, i) => (
        <div key={rule.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>Comprar</span>
            <select aria-label={`Operador de cantidad para regla ${i + 1}`} className="b-select" style={{ width: 120 }} value={rule.operator}
              onChange={(e) => {
                const next = rules.map((x, idx) => idx === i ? { ...x, operator: e.target.value } : x);
                emit(matchMode, next);
              }}>
              <option value="at_least">Al menos</option>
              <option value="exactly">Exactamente</option>
            </select>
            <input aria-label={`Cantidad para regla ${i + 1}`} className="b-input" type="number" min="1" value={rule.qty}
              onChange={(e) => {
                const next = rules.map((x, idx) => idx === i ? { ...x, qty: parseInt(e.target.value) || 1 } : x);
                emit(matchMode, next);
              }}
              style={{ width: 64 }} autoComplete="off" />
            <button type="button" onClick={() => removeRule(i)}
              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 18, lineHeight: 1 }}>
              ×
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>de</span>
            <select aria-label={`Alcance de producto para regla ${i + 1}`} className="b-select" value={rule.scope}
              onChange={(e) => {
                const next = rules.map((x, idx) => idx === i ? { ...x, scope: e.target.value } : x);
                emit(matchMode, next);
              }}>
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
        className="rd-style-083">
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
            const next = rules.map((x, idx) => idx === pickerIdx ? { ...x, productIds: gids } : x);
            emit(matchMode, next);
            setPickerIdx(null);
          }}
        />
      )}
    </div>
  );
}
