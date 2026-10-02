// Individual form for each subcondition type.
// Each form receives `value` (external state) and `onChange` (persist callback).
// The parent serializes their values via hidden inputs on form submit.

import { useState, useId, useEffect } from "react";
import {
  CART_ATTRIBUTE_KEYS,
  LINE_ATTRIBUTE_KEYS,
  resolveOnlyMatchedLines,
  resolveRejectUnmatchedLines,
} from "@promo/shared-types";
import { ProductPicker } from "../ProductPicker.js";
import { PAGE_TYPE_OPTIONS, readPageTypes } from "../../lib/page-types.js";

// ─── Shared props ─────────────────────────────────────────────────────────────
export interface SubFormProps {
  /** Current value (external state). Passed from parent so state survives collapses. */
  value?: Record<string, unknown>;
  /** Called whenever the form value changes, with the full serialised object. */
  onChange?: (value: Record<string, unknown>) => void;
  /** The offer only runs while one of its discount codes is entered (changes some defaults). */
  isCodePromo?: boolean;
}

// ─── "Only discount items added from this page" (page_url / utm_parameters / specific_link) ───
export function OnlyMatchedLinesCheckbox({
  id,
  name,
  checked,
  defaultChecked,
  onChange,
}: {
  id: string;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <div className="b-checkbox-row">
      <input
        type="checkbox"
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
      />
      <div>
        <label htmlFor={id} className="b-checkbox-label">
          Apply the discount only to products added from this page
        </label>
        <div className="b-checkbox-help">
          Only the items a customer adds to their cart while on the matching page get the discount.
          Anything they add later from other pages of your store stays at full price, even if it's in
          the same cart. Leave this unchecked to discount the whole cart once the customer has visited
          the page.
        </div>
      </div>
    </div>
  );
}

// ─── "Don't apply if other pages' products are in the cart" ───────────────────
export function RejectUnmatchedLinesCheckbox({
  id,
  name,
  checked,
  defaultChecked,
  onChange,
}: {
  id: string;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <div className="b-checkbox-row">
      <input
        type="checkbox"
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
      />
      <div>
        <label htmlFor={id} className="b-checkbox-label">
          Don't apply the offer if the cart has products added from other pages
        </label>
        <div className="b-checkbox-help">
          As soon as the cart holds something the customer added on a page that doesn't match, the
          whole offer stops applying (for a code offer, the code stops working).
        </div>
      </div>
    </div>
  );
}

// ─── Helper: typed input value from value prop ─────────────────────────────────
function getv(v: Record<string, unknown> | undefined, key: string, fallback: unknown): unknown {
  return v && key in v ? v[key] : fallback;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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

// ─── Link ─────────────────────────────────────────────────────────────────────
export function LinkForm({ value, onChange, isCodePromo = false }: SubFormProps) {
  const idPrefix = useId();
  const requiredUrl = getv(value, "requiredUrl", "") as string;
  const paramName = getv(value, "paramName", "freegifts_code") as string;
  const paramValue = getv(value, "paramValue", "") as string;
  const onlyMatchedLines = resolveOnlyMatchedLines(value?.["onlyMatchedLines"], isCodePromo);
  const rejectUnmatchedLines = resolveRejectUnmatchedLines(value?.["rejectUnmatchedLines"]);

  // Always emit an explicit onlyMatchedLines so what's saved matches what's shown.
  function emit(patch: Partial<Record<string, string | boolean>>) {
    onChange?.({ requiredUrl, paramName, paramValue, onlyMatchedLines, rejectUnmatchedLines, ...patch });
  }

  const generated = `${requiredUrl || "/"}${paramName ? `?${encodeURIComponent(paramName)}=${encodeURIComponent(paramValue || "<value>")}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-url`}>Destination URL or path</label>
        <input id={`${idPrefix}-url`} aria-label="Destination URL or path" className="b-input" value={requiredUrl}
          onChange={(e) => emit({ requiredUrl: e.target.value })} placeholder="/pages/vip" autoComplete="off" />
      </div>

      <div>
        <label className="b-label" htmlFor={`${idPrefix}-param-name`}>Query parameter (optional)</label>
        <input id={`${idPrefix}-param-name`} aria-label="Query parameter" className="b-input" value={paramName}
          onChange={(e) => emit({ paramName: e.target.value })} placeholder="freegifts_code" autoComplete="off" />
      </div>

      <div>
        <label className="b-label" htmlFor={`${idPrefix}-param-value`}>Expected value (optional)</label>
        <input id={`${idPrefix}-param-value`} aria-label="Expected value" className="b-input" value={paramValue}
          onChange={(e) => emit({ paramValue: e.target.value })} placeholder="summer2024" autoComplete="off" />
      </div>

      <OnlyMatchedLinesCheckbox
        id={`${idPrefix}-only-matched-lines`}
        checked={onlyMatchedLines}
        onChange={(checked) => emit({ onlyMatchedLines: checked })}
      />
      <RejectUnmatchedLinesCheckbox
        id={`${idPrefix}-reject-unmatched-lines`}
        checked={rejectUnmatchedLines}
        onChange={(checked) => emit({ rejectUnmatchedLines: checked })}
      />

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <label className="b-label" htmlFor={`${idPrefix}-generated`} style={{ margin: 0 }}>Generated link</label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(generated)}
            style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>
            Copy link
          </button>
        </div>
        <input id={`${idPrefix}-generated`} aria-label="Generated link" className="b-input" readOnly value={generated}
          style={{ background: "var(--bg)", color: "var(--text-sub)" }} />
      </div>

      <div className="b-help">Evaluates the browser's actual URL. No remote code is inserted or executed.</div>
    </div>
  );
}

// ─── Order history ────────────────────────────────────────────────────────────
export function OrderHistoryForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const metric = getv(value, "metric", "total_spent") as string;
  const operator = getv(value, "operator", "gte") as string;
  const threshold = getv(value, "threshold", 0) as number;

  function emit(patch: Partial<Record<string, unknown>>) {
    onChange?.({ metric, operator, threshold, ...patch });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-metric`}>Metric</label>
        <select id={`${idPrefix}-metric`} className="b-select" value={metric} onChange={(e) => emit({ metric: e.target.value })}>
          <option value="total_spent">Total spent</option>
          <option value="last_order_spent">Total spent on last order</option>
          <option value="total_orders">Total number of orders</option>
          <option value="one_use_per_customer">One use per customer</option>
        </select>
      </div>
      {metric !== "one_use_per_customer" && <>
        <div>
          <label className="b-label" htmlFor={`${idPrefix}-operator`}>Comparison</label>
          <select id={`${idPrefix}-operator`} className="b-select" value={operator} onChange={(e) => emit({ operator: e.target.value })}>
            <option value="gte">At least</option>
            <option value="gt">Greater than</option>
            <option value="eq">Exactly</option>
            <option value="lte">At most</option>
            <option value="lt">Less than</option>
          </select>
        </div>
        <div>
          <label className="b-label" htmlFor={`${idPrefix}-threshold`}>{metric === "total_orders" ? "Quantity" : "Amount"}</label>
          <input id={`${idPrefix}-threshold`} className="b-input" type="number" min="0" step={metric === "total_orders" ? "1" : "0.01"}
            value={threshold} onChange={(e) => emit({ threshold: Number(e.target.value) })} />
        </div>
      </>}
      <div className="b-help">
        Checked against the customer's real Shopify order history at checkout, so it can't be
        spoofed from the browser. Guests (no account) always fail — they have no order history to
        check. "One use per customer" is a separate mode: it limits each customer to one redemption
        of this offer instead of comparing spend or order count.
      </div>
    </div>
  );
}

// ─── Customer tags ────────────────────────────────────────────────────────────
export function CustomerTagsForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const legacyTags = readStringList(getv(value, "tags", []));
  const includeTags = readStringList(getv(value, "includeTags", []));
  const excludeTags = readStringList(getv(value, "excludeTags", []));
  const exclude = excludeTags.length > 0 || (includeTags.length === 0 && getv(value, "exclude", false) === true);
  const tags = (exclude ? excludeTags : includeTags).length > 0
    ? (exclude ? excludeTags : includeTags).join(", ")
    : legacyTags.join(", ");
  const guest = getv(value, "treatGuestAsNoTags", getv(value, "guest", true)) as boolean;

  function emit(patch: Partial<Record<string, unknown>>) {
    const nextTags = readStringList(patch["tags"] ?? tags);
    const nextExclude = (patch["exclude"] ?? exclude) === true;
    const nextGuest = (patch["guest"] ?? guest) === true;
    onChange?.({
      includeTags: nextExclude ? [] : nextTags,
      excludeTags: nextExclude ? nextTags : [],
      treatGuestAsNoTags: nextGuest,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-tags`}>Select tags</label>
        <input id={`${idPrefix}-tags`} aria-label="Select tags" className="b-input" placeholder="Select..." autoComplete="off" value={tags}
          onChange={(e) => emit({ tags: e.target.value })} />
      </div>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-exclude`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-exclude`} aria-label="Exclude customers with these tags" type="checkbox" checked={exclude} onChange={(e) => emit({ exclude: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Exclude customers with these tags</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-guest`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-guest`} aria-label="Treat guest customers as having no tags" type="checkbox" checked={guest} onChange={(e) => emit({ guest: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Treat guest customers as having no tags</span>
      </label>
      <div className="b-help">
        Checked against the customer's real Shopify account tags at checkout. With this box
        checked, a guest (no account) fails an "include" rule and passes an "exclude" rule, exactly
        as if they had no tags at all.
      </div>
    </div>
  );
}

// ─── Location ─────────────────────────────────────────────────────────────────
export function LocationForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const legacyCountries = readStringList(getv(value, "countries", []));
  const includeCountries = readStringList(getv(value, "includeCountryCodes", []));
  const excludeCountries = readStringList(getv(value, "excludeCountryCodes", []));
  const exclude = excludeCountries.length > 0 || (includeCountries.length === 0 && getv(value, "exclude", false) === true);
  const countries = (exclude ? excludeCountries : includeCountries).length > 0
    ? (exclude ? excludeCountries : includeCountries).join(", ")
    : legacyCountries.join(", ");

  function emit(nextCountries: string, nextExclude: boolean) {
    const countryCodes = readStringList(nextCountries).map((country) => country.toUpperCase());
    onChange?.({
      includeCountryCodes: nextExclude ? [] : countryCodes,
      excludeCountryCodes: nextExclude ? countryCodes : [],
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="b-label" htmlFor={`${idPrefix}-countries`}>Select countries</label>
      <input id={`${idPrefix}-countries`} aria-label="Select countries" className="b-input" placeholder="Select countries..." autoComplete="off" value={countries}
        onChange={(e) => emit(e.target.value, exclude)} />
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-exclude-countries`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-exclude-countries`} type="checkbox" checked={exclude}
          onChange={(e) => emit(countries, e.target.checked)} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Exclude these countries</span>
      </label>
      <div className="b-help">
        Uses two-letter country codes (US, CA, GB…). The country comes from the buyer's Shopify
        identity or resolved Market, not raw IP geolocation.
      </div>
    </div>
  );
}

// ─── Subscription ─────────────────────────────────────────────────────────────
export function SubscriptionForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const storedMode = getv(value, "mode", "subscription_only") as string;
  const mode = storedMode === "subscription" ? "subscription_only" : storedMode === "one_time" ? "one_time_only" : storedMode;

  return (
    <fieldset className="b-radio-group" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <legend style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Apply offer to:</legend>
      {[
        { value: "subscription_only", label: "Subscription products only" },
        { value: "one_time_only",     label: "One-time purchase products" },
      ].map((opt) => (
        <label key={opt.value} className="b-checkbox-row" htmlFor={`${idPrefix}-${opt.value}`} style={{ cursor: "pointer", gap: 10 }}>
          <input id={`${idPrefix}-${opt.value}`} aria-label={opt.label} type="radio" name="sub_subscription_mode" value={opt.value}
            checked={mode === opt.value}
            onChange={() => onChange?.({ mode: opt.value })}
            style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.label}</span>
        </label>
      ))}
      <div className="b-help">
        Passes as soon as at least one cart line matches — it looks at what's actually in the cart
        right now (a line with a selling plan attached), not the customer's account or purchase
        history.
      </div>
    </fieldset>
  );
}

// ─── Sales channel ────────────────────────────────────────────────────────────
export function SalesChannelForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const channels = readStringList(getv(value, "channels", []));
  const hasCanonicalChannels = Array.isArray(value?.["channels"]);
  const online = hasCanonicalChannels ? channels.includes("online_store") : getv(value, "online", true) as boolean;
  const mobile = hasCanonicalChannels ? channels.includes("mobile_app") : getv(value, "mobile", false) as boolean;
  const pos = hasCanonicalChannels ? channels.includes("pos") : getv(value, "pos", false) as boolean;

  function emit(patch: Partial<Record<string, unknown>>) {
    const nextOnline = (patch["online"] ?? online) === true;
    const nextMobile = (patch["mobile"] ?? mobile) === true;
    const nextPos = (patch["pos"] ?? pos) === true;
    onChange?.({ channels: [
      ...(nextOnline ? ["online_store"] : []),
      ...(nextMobile ? ["mobile_app"] : []),
      ...(nextPos ? ["pos"] : []),
    ] });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-online`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-online`} aria-label="Online store" type="checkbox" checked={online} onChange={(e) => emit({ online: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Online store</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-mobile`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-mobile`} aria-label="Mobile app channel" type="checkbox" checked={mobile} onChange={(e) => emit({ mobile: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Mobile app channel</span>
      </label>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-pos`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-pos`} aria-label="Point of sale channel" type="checkbox" checked={pos} onChange={(e) => emit({ pos: e.target.checked })}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Point of sale channel</span>
      </label>
      <div style={{ background: "#f0f4ff", border: "1px solid #c4d0fb", borderRadius: 6, padding: "10px 12px", fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
        Mobile orders are recognised from the checkout&apos;s source channel. If you use a custom
        mobile app, contact support for integration help.
      </div>
      <div className="b-help">
        Passes if the order comes from any one of the checked channels (OR, not AND) — check every
        channel this offer should be available on.
      </div>
    </div>
  );
}

// ─── Markets ──────────────────────────────────────────────────────────────────
export function MarketsForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const legacyMarketIds = readStringList(getv(value, "marketIds", []));
  const includeMarketIds = readStringList(getv(value, "includeMarketIds", []));
  const excludeMarketIds = readStringList(getv(value, "excludeMarketIds", []));
  const exclude = excludeMarketIds.length > 0 || (includeMarketIds.length === 0 && getv(value, "exclude", false) === true);
  const marketIds = (exclude ? excludeMarketIds : includeMarketIds).length > 0
    ? (exclude ? excludeMarketIds : includeMarketIds).join(", ")
    : legacyMarketIds.join(", ");
  const [markets, setMarkets] = useState<Array<{ id: string; name: string; currencyCode: string; enabled: boolean }>>([]);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/markets", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { markets?: Array<{ id: string; name: string; currencyCode: string; enabled: boolean }>; error?: string };
        if (!response.ok) throw new Error(`Markets request failed (${response.status})`);
        setMarkets(body.markets ?? []);
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setMarketError("Markets could not be loaded.");
      });
    return () => controller.abort();
  }, []);

  const selected = new Set(marketIds.split(",").map((id) => id.trim()).filter(Boolean));

  function toggleMarket(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    emit([...next].join(", "), exclude);
  }

  function emit(nextMarketIds: string, nextExclude: boolean) {
    const ids = readStringList(nextMarketIds);
    onChange?.({
      includeMarketIds: nextExclude ? [] : ids,
      excludeMarketIds: nextExclude ? ids : [],
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {markets.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {markets.map((market) => (
            <label key={market.id} className="b-checkbox-row" htmlFor={`${idPrefix}-${market.id.split("/").pop()}`} style={{ cursor: "pointer", gap: 10 }}>
              <input id={`${idPrefix}-${market.id.split("/").pop()}`} type="checkbox" checked={selected.has(market.id)} onChange={() => toggleMarket(market.id)} />
              <span style={{ fontSize: 13, color: "var(--text)" }}>{market.name} · {market.currencyCode}{market.enabled ? "" : " · inactive"}</span>
            </label>
          ))}
        </div>
      )}
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-markets`}>{markets.length > 0 ? "Selected Market IDs" : "Market IDs"}</label>
        <input id={`${idPrefix}-markets`} aria-label="Select markets" className="b-input" placeholder="gid://shopify/Market/..." autoComplete="off" value={marketIds}
          onChange={(e) => emit(e.target.value, exclude)} />
        {marketError && <div className="b-help">Live Markets could not be loaded: {marketError}. You can still enter Market GIDs manually.</div>}
      </div>
      <label className="b-checkbox-row" htmlFor={`${idPrefix}-exclude-markets`} style={{ cursor: "pointer", gap: 10 }}>
        <input id={`${idPrefix}-exclude-markets`} aria-label="Exclude selected markets" type="checkbox" checked={exclude}
          onChange={(e) => emit(marketIds, e.target.checked)}
          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Exclude selected markets</span>
      </label>
      <div className="b-help">
        Restricts this offer to (or away from) the buyer's resolved Shopify Market — the same
        Markets you configure under Settings → Markets, used for region-specific pricing/currency.
      </div>
    </div>
  );
}

// ─── UTM parameters ────────────────────────────────────────────────────────────
export function UtmParametersForm({ value, onChange, isCodePromo = false }: SubFormProps) {
  const idPrefix = useId();
  const utmSource = getv(value, "utmSource", "") as string;
  const utmMedium = getv(value, "utmMedium", "") as string;
  const utmCampaign = getv(value, "utmCampaign", "") as string;
  const utmTerm = getv(value, "utmTerm", "") as string;
  const utmContent = getv(value, "utmContent", "") as string;
  const scope = value?.["scope"] === "visit" ? "visit" : "page";
  const onlyMatchedLines = resolveOnlyMatchedLines(value?.["onlyMatchedLines"], isCodePromo);
  const rejectUnmatchedLines = resolveRejectUnmatchedLines(value?.["rejectUnmatchedLines"]);

  // Always emit an explicit onlyMatchedLines so what's saved matches what's shown.
  function emit(patch: Partial<Record<string, unknown>>) {
    onChange?.({
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      scope,
      onlyMatchedLines,
      rejectUnmatchedLines,
      ...patch,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-utm-source`}>UTM Source</label>
        <input id={`${idPrefix}-utm-source`} className="b-input" value={utmSource} onChange={(event) => emit({ utmSource: event.target.value })} placeholder="amazon" autoComplete="off" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-utm-medium`}>UTM Medium</label>
        <input id={`${idPrefix}-utm-medium`} className="b-input" value={utmMedium} onChange={(event) => emit({ utmMedium: event.target.value })} placeholder="cpc" autoComplete="off" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-utm-campaign`}>UTM Campaign</label>
        <input id={`${idPrefix}-utm-campaign`} className="b-input" value={utmCampaign} onChange={(event) => emit({ utmCampaign: event.target.value })} placeholder="primeday2026" autoComplete="off" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-utm-term`}>UTM Term</label>
        <input id={`${idPrefix}-utm-term`} className="b-input" value={utmTerm} onChange={(event) => emit({ utmTerm: event.target.value })} placeholder="running-shoes" autoComplete="off" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-utm-content`}>UTM Content</label>
        <input id={`${idPrefix}-utm-content`} className="b-input" value={utmContent} onChange={(event) => emit({ utmContent: event.target.value })} placeholder="banner-a" autoComplete="off" />
      </div>
      <UtmScopeChoice name={`${idPrefix}-utm-scope`} value={scope} onChange={(next) => emit({ scope: next })} />
      <OnlyMatchedLinesCheckbox
        id={`${idPrefix}-only-matched-lines`}
        checked={onlyMatchedLines}
        onChange={(checked) => emit({ onlyMatchedLines: checked })}
      />
      <RejectUnmatchedLinesCheckbox
        id={`${idPrefix}-reject-unmatched-lines`}
        checked={rejectUnmatchedLines}
        onChange={(checked) => emit({ rejectUnmatchedLines: checked })}
      />
      <div className="b-banner b-banner-blue" role="status">
        <div className="b-banner-body" style={{ width: "100%" }}>
          <p className="b-banner-title">What this does</p>
          <p className="b-banner-text">
            UTM parameters are the tags marketers add to a link (like <code>?utm_source=amazon</code>) to
            track where traffic came from. This condition only lets the offer apply if the customer's
            original landing URL carried the values you fill in below — for example, set UTM Source to
            "amazon-primeday" to gate an offer to customers who clicked through from that campaign.
          </p>
          <p className="b-banner-text" style={{ marginTop: 8 }}>
            <strong>No setup required:</strong> these values are captured automatically from the
            customer's landing page on every visit — unlike the <code>__landing_source</code> line
            property elsewhere in this app, there's no snippet to add to a landing page.
          </p>
          <p className="b-banner-text" style={{ marginTop: 8 }}>
            <strong>Not a secret:</strong> UTM tags are visible in the link, so anyone who has the link
            qualifies. Use them to target a campaign, not to keep an offer private. Values are not
            case-sensitive.
          </p>
          <p className="b-banner-text" style={{ marginTop: 8 }}>
            <strong>Combining it:</strong> add it alongside any other condition here — they all apply
            together (AND). Leave a field blank to skip checking that parameter — only the fields you
            fill in are required to match.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── UTM scope: the add-to-cart page vs. anywhere in the visit ─────────────────
export const UTM_SCOPE_OPTIONS = [
  {
    value: "visit",
    label: "Visitor arrived with these UTMs at any point in the visit",
    help: "Works even if they browse around first; the UTMs from their latest tagged link in this visit count.",
  },
  {
    value: "page",
    label: "UTM must be in the URL of the page where the product is added",
    help: "Stricter: the product has to be added on a page whose address still carries the UTMs.",
  },
] as const;

export function UtmScopeChoice({
  name,
  value,
  defaultValue,
  onChange,
}: {
  name: string;
  value?: "page" | "visit";
  defaultValue?: "page" | "visit";
  onChange?: (value: "page" | "visit") => void;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <legend className="b-label">When do the UTMs count?</legend>
      {UTM_SCOPE_OPTIONS.map((option) => (
        <label key={option.value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === undefined ? undefined : value === option.value}
            defaultChecked={defaultValue === undefined ? undefined : defaultValue === option.value}
            onChange={() => onChange?.(option.value)}
            style={{ accentColor: "var(--blue)", width: 14, height: 14, marginTop: 3 }}
          />
          <span>
            <span style={{ fontSize: 13, color: "var(--text)" }}>{option.label}</span>
            <span className="b-checkbox-help" style={{ display: "block" }}>{option.help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ─── Store page types ─────────────────────────────────────────────────────────
export function PageTypeCheckboxes({
  idPrefix,
  selected,
  onChange,
  name,
}: {
  idPrefix: string;
  selected: string[];
  onChange?: (next: string[]) => void;
  /** When set, each checkbox posts its value under this name (plain form submit). */
  name?: string;
}) {
  // At least one page type must stay selected: an empty list matches nothing and the schema rejects it.
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="b-sr-only">Pages where the products were added</legend>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))", gap: 8 }}>
      {PAGE_TYPE_OPTIONS.map((option) => {
        const id = `${idPrefix}-page-type-${option.value}`;
        return (
          <label key={option.value} htmlFor={id} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
            <input
              id={id}
              type="checkbox"
              name={name}
              value={option.value}
              {...(onChange
                ? {
                    checked: selected.includes(option.value),
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                      if (event.target.checked) onChange([...selected, option.value]);
                      else if (selected.some((type) => type !== option.value)) onChange(selected.filter((type) => type !== option.value));
                    },
                  }
                : {
                    defaultChecked: selected.includes(option.value),
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                      if (event.target.checked) return;
                      const group = event.target.closest("fieldset");
                      if (!group?.querySelector("input[type=checkbox]:checked")) event.target.checked = true;
                    },
                  })}
              style={{ accentColor: "var(--blue)", width: 14, height: 14, marginTop: 3 }}
            />
            <span>
              <span style={{ fontSize: 13, color: "var(--text)" }}>{option.label}</span>
              <span className="b-checkbox-help" style={{ display: "block" }}>{option.example}</span>
            </span>
          </label>
        );
      })}
    </div>
    </fieldset>
  );
}

export const PAGE_TYPES_HELP =
  "We look at the page each product was added to the cart from, not the page the customer is on at checkout. Products added another way (Buy it now buttons, cart permalinks, or apps that add to the cart without a page) count as \"other pages\" and match none of the types above.";

export function PageTypesForm({ value, onChange, isCodePromo = false }: SubFormProps) {
  const idPrefix = useId();
  const pageTypes = readPageTypes(value?.["pageTypes"]);
  const onlyMatchedLines = resolveOnlyMatchedLines(value?.["onlyMatchedLines"], isCodePromo);
  const rejectUnmatchedLines = resolveRejectUnmatchedLines(value?.["rejectUnmatchedLines"]);

  function emit(patch: Partial<Record<string, unknown>>) {
    onChange?.({ pageTypes, onlyMatchedLines, rejectUnmatchedLines, ...patch });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageTypeCheckboxes idPrefix={idPrefix} selected={pageTypes} onChange={(next) => emit({ pageTypes: next })} />
      <div className="b-help">{PAGE_TYPES_HELP}</div>
      <OnlyMatchedLinesCheckbox
        id={`${idPrefix}-only-matched-lines`}
        checked={onlyMatchedLines}
        onChange={(checked) => emit({ onlyMatchedLines: checked })}
      />
      <RejectUnmatchedLinesCheckbox
        id={`${idPrefix}-reject-unmatched-lines`}
        checked={rejectUnmatchedLines}
        onChange={(checked) => emit({ rejectUnmatchedLines: checked })}
      />
    </div>
  );
}

// ─── Store-specific line/cart attribute ──────────────────────────────────────
export function CustomAttributeForm({ value, onChange }: SubFormProps) {
  const idPrefix = useId();
  const scope = getv(value, "scope", "line") as "line" | "cart";
  const key = getv(value, "key", "") as string;
  const expectedValue = getv(value, "value", "") as string;
  const matchMode = getv(value, "matchMode", "equals") as "equals" | "not_equals";
  const minMatchingQuantity = getv(value, "minMatchingQuantity", 1) as number;
  const suggestions = scope === "cart" ? CART_ATTRIBUTE_KEYS : LINE_ATTRIBUTE_KEYS;

  function emit(patch: Partial<Record<string, unknown>>) {
    onChange?.({ scope, key, value: expectedValue, matchMode, minMatchingQuantity, ...patch });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-scope`}>Attribute location</label>
        <select id={`${idPrefix}-scope`} className="b-select" value={scope} onChange={(event) => emit({ scope: event.target.value })}>
          <option value="line">Cart line property</option>
          <option value="cart">Cart attribute</option>
        </select>
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-key`}>Store attribute key</label>
        <input id={`${idPrefix}-key`} className="b-input" list={`${idPrefix}-suggestions`} value={key} onChange={(event) => emit({ key: event.target.value })} placeholder={scope === "cart" ? "affiliate_campaign" : "engraving_message"} autoComplete="off" />
        <datalist id={`${idPrefix}-suggestions`}>
          {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
        </datalist>
        <div className="b-help">Keys are registered for this store when the offer is published. HPN names are optional migration presets.</div>
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-value`}>Expected value</label>
        <input id={`${idPrefix}-value`} className="b-input" value={expectedValue} onChange={(event) => emit({ value: event.target.value })} autoComplete="off" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${idPrefix}-match`}>Match</label>
        <select id={`${idPrefix}-match`} className="b-select" value={matchMode} onChange={(event) => emit({ matchMode: event.target.value })}>
          <option value="equals">Equals</option>
          <option value="not_equals">Does not equal</option>
        </select>
        <div className="b-help">
          "Does not equal" also passes when the attribute is missing entirely — use this to exclude
          carts/lines tagged a certain way (e.g. requiring a landing-page attribute to be absent)
          without a separate "attribute doesn't exist" option.
        </div>
      </div>
      {scope === "line" && (
        <div>
          <label className="b-label" htmlFor={`${idPrefix}-quantity`}>Minimum matching quantity</label>
          <input id={`${idPrefix}-quantity`} className="b-input" type="number" min="1" step="1" value={minMatchingQuantity} onChange={(event) => emit({ minMatchingQuantity: Math.max(1, Number(event.target.value) || 1) })} />
        </div>
      )}
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
      <fieldset className="b-radio-group">
        <legend style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Customers must have:</legend>
        <div style={{ display: "flex", gap: 16 }}>
          {[{ v: "all", l: "All rules" }, { v: "any", l: "Any rule" }].map((opt) => (
            <label key={opt.v} className="b-checkbox-row" htmlFor={`${idPrefix}-match-${opt.v}`} style={{ cursor: "pointer", gap: 8 }}>
              <input id={`${idPrefix}-match-${opt.v}`} aria-label={opt.l} type="radio" name="qty_match_mode" value={opt.v}
                checked={matchMode === opt.v}
                onChange={() => emit(opt.v as "all" | "any", rules)}
                style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
              <span style={{ fontSize: 13, color: "var(--text)" }}>{opt.l}</span>
            </label>
          ))}
        </div>
        <div className="b-help">
          "All rules" requires every rule below to be satisfied at once; "Any rule" passes if at
          least one is. Quantities are summed across every matching cart line, not checked per line.
        </div>
      </fieldset>

      {rules.map((rule, i) => (
        <div key={rule.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>Buy</span>
            <select aria-label={`Quantity operator for rule ${i + 1}`} className="b-select" style={{ width: 120 }} value={rule.operator}
              onChange={(e) => {
                const next = rules.map((x, idx) => idx === i ? { ...x, operator: e.target.value } : x);
                emit(matchMode, next);
              }}>
              <option value="at_least">At least</option>
              <option value="exactly">Exactly</option>
            </select>
            <input aria-label={`Quantity for rule ${i + 1}`} className="b-input" type="number" min="1" value={rule.qty}
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
            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>of</span>
            <select aria-label={`Product scope for rule ${i + 1}`} className="b-select" value={rule.scope}
              onChange={(e) => {
                const next = rules.map((x, idx) => idx === i ? { ...x, scope: e.target.value } : x);
                emit(matchMode, next);
              }}>
              <option value="specific_products">selected products</option>
              <option value="any_product">any product</option>
            </select>
          </div>

          {rule.scope === "specific_products" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text-sub)" }}>Products</span>
              <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setPickerIdx(i)}>
                Select products
              </button>
              <span style={{ fontSize: 12, color: "var(--text-sub)" }}>
                {rule.productIds.length} products selected
              </span>
            </div>
          )}
        </div>
      ))}

      <button type="button" onClick={addRule}
        className="rd-style-083">
        + Add rule
      </button>

      {pickerIdx !== null && (
        <ProductPicker
          open
          title="Select products"
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
