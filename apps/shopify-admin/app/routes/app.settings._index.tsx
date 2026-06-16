import { useLoaderData, Form, useActionData } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq } from "drizzle-orm";
import { parseStoredJson } from "../lib/offer-validation.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

type SettingKey =
  | "app.enabled"
  | "gift.logic_mode"
  | "gift.auto_add"
  | "gift.discount_by"
  | "gift.price_constraint"
  | "gift.selection_limit"
  | "gift.exclude_cart"
  | "gift.remove_on_deactivate"
  | "gift.include_compare_price"
  | "gift.sku_format"
  | "gift.barcode_format"
  | "gift.title_format"
  | "gift.include_product_type"
  | "gift.include_tags"
  | "inventory.method"
  | "inventory.when_out"
  | "fraud.notify_email"
  | "fraud.email_address"
  | "fraud.cart_payment_rule"
  | "fraud.condition_type"
  | "fraud.min_cart_value"
  | "fraud.min_cart_qty"
  | "fraud.max_gifts"
  | "fraud.per_offer_config"
  | "fraud.order_protection"
  | "advanced.draft_order_api";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const settingRows = await db.select().from(appSettings).where(eq(appSettings.shopId, shop.id));

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) {
    settings[row.key] = parseStoredJson(row.value);
  }

  const defaults: Record<SettingKey, unknown> = {
    "app.enabled": true,
    "gift.logic_mode": "function",
    "gift.auto_add": true,
    "gift.discount_by": "current_price",
    "gift.price_constraint": false,
    "gift.selection_limit": false,
    "gift.exclude_cart": false,
    "gift.remove_on_deactivate": true,
    "gift.include_compare_price": false,
    "gift.sku_format": "same_as_original",
    "gift.barcode_format": "blank",
    "gift.title_format": "emoji_name_pct",
    "gift.include_product_type": false,
    "gift.include_tags": false,
    "inventory.method": "sync_auto",
    "inventory.when_out": "stop",
    "fraud.notify_email": true,
    "fraud.email_address": "",
    "fraud.cart_payment_rule": true,
    "fraud.condition_type": "all",
    "fraud.min_cart_value": false,
    "fraud.min_cart_qty": false,
    "fraud.max_gifts": false,
    "fraud.per_offer_config": false,
    "fraud.order_protection": false,
    "advanced.draft_order_api": false,
  };

  return { shop, settings: { ...defaults, ...settings } };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  if (!shopId) return { error: "Shop not found" };

  const formData = await request.formData();

  const boolField = (name: string) => formData.get(name) === "on" || formData.get(name) === "true";
  const strField = (name: string) => (formData.get(name) as string | null) ?? "";

  // Validate: email is required when fraud notifications are enabled
  const fraudNotifyEnabled = boolField("fraud_notify_email");
  const fraudEmailValue = strField("fraud_email_address").trim();
  if (fraudNotifyEnabled) {
    if (!fraudEmailValue) {
      return { error: "Email address is required when fraud notifications are enabled." };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(fraudEmailValue)) {
      return { error: "Please enter a valid email address for fraud notifications." };
    }
  }

  const requestedGiftLogicMode = strField("gift_logic_mode");
  const giftLogicMode = requestedGiftLogicMode === "function" ? requestedGiftLogicMode : "function";

  const updates: Record<string, unknown> = {
    "app.enabled": boolField("app_enabled"),
    "gift.logic_mode": giftLogicMode,
    "gift.auto_add": boolField("gift_auto_add"),
    "gift.discount_by": strField("gift_discount_by"),
    "gift.price_constraint": boolField("gift_price_constraint"),
    "gift.selection_limit": boolField("gift_selection_limit"),
    "gift.exclude_cart": boolField("gift_exclude_cart"),
    "gift.remove_on_deactivate": boolField("gift_remove_on_deactivate"),
    "gift.include_compare_price": boolField("gift_include_compare_price"),
    "gift.sku_format": strField("gift_sku_format"),
    "gift.barcode_format": strField("gift_barcode_format"),
    "gift.title_format": strField("gift_title_format"),
    "gift.include_product_type": boolField("gift_include_product_type"),
    "gift.include_tags": boolField("gift_include_tags"),
    "inventory.method": strField("inventory_method"),
    "inventory.when_out": strField("inventory_when_out"),
    "fraud.notify_email": boolField("fraud_notify_email"),
    "fraud.email_address": strField("fraud_email_address"),
    "fraud.cart_payment_rule": boolField("fraud_cart_payment_rule"),
    "fraud.condition_type": strField("fraud_condition_type"),
    "fraud.min_cart_value": boolField("fraud_min_cart_value"),
    "fraud.min_cart_qty": boolField("fraud_min_cart_qty"),
    "fraud.max_gifts": boolField("fraud_max_gifts"),
    "fraud.per_offer_config": boolField("fraud_per_offer_config"),
    "fraud.order_protection": boolField("fraud_order_protection"),
    "advanced.draft_order_api": boolField("advanced_draft_order_api"),
    "app.timezone": strField("timezone"),
    "app.language": strField("language"),
  };

  await Promise.all(Object.entries(updates).map(([key, value]) =>
    db.insert(appSettings)
      .values({ shopId, key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      }),
  ));

  return { success: true };
};

/* ── Section wrapper ─────────────────────────────────────── */
function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="b-settings-section">
      <div className="b-settings-label-col">
        <h3 className="b-settings-section-title">{title}</h3>
        <p className="b-settings-section-desc">{desc}</p>
      </div>
      <div className="b-settings-control-col">
        {children}
      </div>
    </div>
  );
}

/* ── Checkbox row ────────────────────────────────────────── */
function CheckRow({
  name, label, help, checked, onChange,
}: {
  name: string; label: string; help?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="b-checkbox-row">
      <input
        aria-label={label}
        type="checkbox"
        id={name}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div>
        <label htmlFor={name} className="b-checkbox-label">{label}</label>
        {help && <div className="b-checkbox-help">{help}</div>}
      </div>
    </div>
  );
}

/* ── Radio row ───────────────────────────────────────────── */
function RadioRow({
  name, value, label, checked, onChange,
}: {
  name: string; value: string; label: string; checked: boolean; onChange: (v: string) => void;
}) {
  return (
    <div className="b-checkbox-row">
      <input
        aria-label={label}
        type="radio"
        id={`${name}-${value}`}
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      <label htmlFor={`${name}-${value}`} className="b-checkbox-label">{label}</label>
    </div>
  );
}

/* ── Function logic illustration (discount tag) ─────────── */
function FunctionIllustration() {
  return (
    <div style={{ position: "relative", width: 64, height: 56, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="rd-style-073">
        <span style={{ fontSize: 20, fontWeight: 800, color: "#ca8a04" }}>%</span>
      </div>
      <div className="rd-style-074" />
    </div>
  );
}

export default function SettingsPage() {
  const { settings: s } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [settingsState, setSettingsField] = useObjectState(() => ({
    appEnabled: Boolean(s["app.enabled"]),
    logicMode: "function",
    autoAdd: Boolean(s["gift.auto_add"]),
    discountBy: String(s["gift.discount_by"] ?? "current_price"),
    priceConstraint: Boolean(s["gift.price_constraint"]),
    selectionLimit: Boolean(s["gift.selection_limit"]),
    excludeCart: Boolean(s["gift.exclude_cart"]),
    removeOnDeactivate: Boolean(s["gift.remove_on_deactivate"]),
    includeComparePrice: Boolean(s["gift.include_compare_price"]),
    skuFormat: String(s["gift.sku_format"] ?? "same_as_original"),
    barcodeFormat: String(s["gift.barcode_format"] ?? "blank"),
    titleFormat: String(s["gift.title_format"] ?? "emoji_name_pct"),
    includeProductType: Boolean(s["gift.include_product_type"]),
    includeTags: Boolean(s["gift.include_tags"]),
    invMethod: String(s["inventory.method"] ?? "sync_auto"),
    whenOut: String(s["inventory.when_out"] ?? "stop"),
    fraudNotify: Boolean(s["fraud.notify_email"]),
    fraudEmail: String(s["fraud.email_address"] ?? ""),
    cartPayRule: Boolean(s["fraud.cart_payment_rule"]),
    condType: String(s["fraud.condition_type"] ?? "all"),
    minCartVal: Boolean(s["fraud.min_cart_value"]),
    minCartQty: Boolean(s["fraud.min_cart_qty"]),
    maxGifts: Boolean(s["fraud.max_gifts"]),
    perOfferConfig: Boolean(s["fraud.per_offer_config"]),
    orderProtection: Boolean(s["fraud.order_protection"]),
    draftOrderApi: Boolean(s["advanced.draft_order_api"]),
  }));
  const {
    appEnabled,
    logicMode,
    autoAdd,
    discountBy,
    priceConstraint,
    selectionLimit,
    excludeCart,
    removeOnDeactivate,
    includeComparePrice,
    skuFormat,
    barcodeFormat,
    titleFormat,
    includeProductType,
    includeTags,
    invMethod,
    whenOut,
    fraudNotify,
    fraudEmail,
    cartPayRule,
    condType,
    minCartVal,
    minCartQty,
    maxGifts,
    perOfferConfig,
    orderProtection,
    draftOrderApi,
  } = settingsState;
  const setAppEnabled = createFieldSetter(setSettingsField, "appEnabled");
  const setAutoAdd = createFieldSetter(setSettingsField, "autoAdd");
  const setDiscountBy = createFieldSetter(setSettingsField, "discountBy");
  const setPriceConstraint = createFieldSetter(setSettingsField, "priceConstraint");
  const setSelectionLimit = createFieldSetter(setSettingsField, "selectionLimit");
  const setExcludeCart = createFieldSetter(setSettingsField, "excludeCart");
  const setRemoveOnDeactivate = createFieldSetter(setSettingsField, "removeOnDeactivate");
  const setIncludeComparePrice = createFieldSetter(setSettingsField, "includeComparePrice");
  const setSkuFormat = createFieldSetter(setSettingsField, "skuFormat");
  const setBarcodeFormat = createFieldSetter(setSettingsField, "barcodeFormat");
  const setTitleFormat = createFieldSetter(setSettingsField, "titleFormat");
  const setIncludeProductType = createFieldSetter(setSettingsField, "includeProductType");
  const setIncludeTags = createFieldSetter(setSettingsField, "includeTags");
  const setInvMethod = createFieldSetter(setSettingsField, "invMethod");
  const setWhenOut = createFieldSetter(setSettingsField, "whenOut");
  const setFraudNotify = createFieldSetter(setSettingsField, "fraudNotify");
  const setFraudEmail = createFieldSetter(setSettingsField, "fraudEmail");
  const setCartPayRule = createFieldSetter(setSettingsField, "cartPayRule");
  const setCondType = createFieldSetter(setSettingsField, "condType");
  const setMinCartVal = createFieldSetter(setSettingsField, "minCartVal");
  const setMinCartQty = createFieldSetter(setSettingsField, "minCartQty");
  const setMaxGifts = createFieldSetter(setSettingsField, "maxGifts");
  const setPerOfferConfig = createFieldSetter(setSettingsField, "perOfferConfig");
  const setOrderProtection = createFieldSetter(setSettingsField, "orderProtection");
  const setDraftOrderApi = createFieldSetter(setSettingsField, "draftOrderApi");

  return (
    <div className="b-page">
      <div className="b-page-header">
        <h1 className="b-page-title">Settings</h1>
      </div>

      {actionData && "success" in actionData && (
        <div className="b-banner b-banner-green" style={{ marginBottom: 16 }}>
          <span className="b-banner-icon">✓</span>
          <div className="b-banner-body">
            <div className="b-banner-title">Settings saved successfully</div>
          </div>
        </div>
      )}

      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red" style={{ marginBottom: 16 }}>
          <span className="b-banner-icon">⚠</span>
          <div className="b-banner-body">
            <div className="b-banner-title" style={{ color: "var(--red)" }}>{actionData.error}</div>
          </div>
        </div>
      )}

      <Form method="POST">
        <div className="b-card" style={{ marginBottom: 0 }}>

          {/* ── General ───────────────────────────────────────── */}
          <Section title="General" desc="Manage BOGOS general settings.">
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span className="b-text-sm b-text-bold">BOGOS Status</span>
              <span className={`b-badge ${appEnabled ? "b-badge-green" : "b-badge-gray"}`}>
                {appEnabled ? "Activated" : "Deactivated"}
              </span>
              <button
                type="button"
                className="b-btn b-btn-danger b-btn-sm"
                style={{ marginLeft: "auto" }}
                onClick={() => setAppEnabled(!appEnabled)}
              >
                {appEnabled ? "Deactivate" : "Activate"}
              </button>
              <input type="hidden" name="app_enabled" value={appEnabled ? "on" : ""} />
            </div>
            <p className="b-text-sm b-text-sub" style={{ margin: "0 0 16px" }}>
              Do not deactivate BOGOS status if you currently have active offers.
            </p>

            <div style={{ marginBottom: 12 }}>
              <label className="b-label" htmlFor="settings-timezone">Timezone</label>
              <select id="settings-timezone" aria-label="Timezone" className="b-select" name="timezone" defaultValue="(GMT-03:00) America/Buenos_Aires">
                <option>(GMT-03:00) America/Buenos_Aires</option>
                <option>(GMT-05:00) America/New_York</option>
                <option>(GMT+00:00) UTC</option>
                <option>(GMT+01:00) Europe/London</option>
              </select>
            </div>
            <div>
              <label className="b-label" htmlFor="settings-language">App language</label>
              <select id="settings-language" aria-label="App language" className="b-select" name="language" defaultValue="en">
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
              </select>
            </div>
          </Section>

          {/* ── Gift logic mechanism ─────────────────────────── */}
          <Section title="Gift logic mechanism" desc="Manage the logical mechanism of the gift offer.">
            <p className="b-text-sm b-text-sub" style={{ margin: "0 0 14px" }}>The app uses Shopify discount functions for gift logic.</p>
            <div className="b-logic-cards">
              {/* Gift function card */}
              <button
                type="button"
                className={`b-logic-card${logicMode === "function" ? " active" : ""}`}
              >
                {logicMode === "function" && (
                  <div className="b-logic-card-active-badge">Currently enabled</div>
                )}
                <FunctionIllustration />
                <div className="b-logic-card-title">Gift function</div>
                <div className="b-logic-card-desc">
                  Gift products are added directly and discounted using Shopify&apos;s discount function.
                </div>
              </button>
            </div>
            <input type="hidden" name="gift_logic_mode" value={logicMode} />

            <div className="b-banner b-banner-orange" style={{ marginBottom: 0 }}>
              <div className="b-banner-body">
                <div className="b-banner-text">
                  ⚠️ If you want to change the gift logic mechanism, it is recommended to contact support for help.
                </div>
              </div>
              <a href="mailto:support@secomapp.com" className="b-btn b-btn-secondary b-btn-sm" style={{ flexShrink: 0, marginLeft: 12 }}>
                Contact support
              </a>
            </div>
          </Section>

          {/* ── Gift condition ───────────────────────────────── */}
          <Section title="Gift condition" desc="Manage conditions for all offers.">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CheckRow
                name="gift_auto_add"
                label="Automatically add a gift to cart"
                checked={autoAdd}
                onChange={setAutoAdd}
              />

              <div style={{ marginTop: 4 }}>
                <p className="b-text-sm b-text-bold" style={{ marginBottom: 8 }}>Gift discount calculated by</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 4 }}>
                  <RadioRow name="gift_discount_by" value="current_price" label="Current price" checked={discountBy === "current_price"} onChange={setDiscountBy} />
                  <RadioRow name="gift_discount_by" value="compare_price" label="Compare price" checked={discountBy === "compare_price"} onChange={setDiscountBy} />
                </div>
              </div>

              <CheckRow
                name="gift_price_constraint"
                label="The gift price must be less than or equal to the product price"
                checked={priceConstraint}
                onChange={setPriceConstraint}
              />
              <CheckRow
                name="gift_selection_limit"
                label="Limit of one selection per gift in the gift slider control"
                help="This feature allows customers to select each gift item in the gift slider only once."
                checked={selectionLimit}
                onChange={setSelectionLimit}
              />
              <CheckRow
                name="gift_exclude_cart"
                label="Exclude product in cart"
                help="This feature prevents customers from getting an identical item to one already in their cart."
                checked={excludeCart}
                onChange={setExcludeCart}
              />
            </div>
          </Section>

          {/* ── Cloned gift product ──────────────────────────── */}
          <Section title="Cloned gift product" desc="Configure the clone gift product's information inheritance from the original product.">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CheckRow
                name="gift_remove_on_deactivate"
                label="Remove gift products after deactivating offers"
                help="Enable this feature to remove cloned products after disabling offers. By default, cloned products are only removed after deleting the offers."
                checked={removeOnDeactivate}
                onChange={setRemoveOnDeactivate}
              />
              <CheckRow
                name="gift_include_compare_price"
                label="Include compare price on cloned product"
                checked={includeComparePrice}
                onChange={setIncludeComparePrice}
              />

              <div>
                  <label className="b-label" htmlFor="settings-gift-sku-format">Clone SKU format of product</label>
                  <select id="settings-gift-sku-format" aria-label="Clone SKU format of product" className="b-select" name="gift_sku_format" value={skuFormat} onChange={(e) => setSkuFormat(e.target.value)}>
                  <option value="same_as_original">Same as original product</option>
                  <option value="suffix_gift">Original SKU + _GIFT</option>
                  <option value="blank">Blank</option>
                </select>
              </div>
              <div>
                  <label className="b-label" htmlFor="settings-gift-barcode-format">Clone barcode format of product</label>
                  <select id="settings-gift-barcode-format" aria-label="Clone barcode format of product" className="b-select" name="gift_barcode_format" value={barcodeFormat} onChange={(e) => setBarcodeFormat(e.target.value)}>
                  <option value="blank">Blank</option>
                  <option value="same_as_original">Same as original product</option>
                </select>
              </div>
              <div>
                  <label className="b-label" htmlFor="settings-gift-title-format">Clone title format of product</label>
                  <select id="settings-gift-title-format" aria-label="Clone title format of product" className="b-select" name="gift_title_format" value={titleFormat} onChange={(e) => setTitleFormat(e.target.value)}>
                  <option value="emoji_name_pct">🎁 Product name (100% off)</option>
                  <option value="name_pct">Product name (100% off)</option>
                  <option value="same_as_original">Same as original</option>
                </select>
              </div>

              <div>
                <div className="b-row-between" style={{ marginBottom: 6 }}>
                  <div className="b-label" style={{ margin: 0 }}>Sales channels</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)" }}>
                  <span style={{ width: 8, height: 8, background: "var(--green)", borderRadius: "50%", display: "inline-block" }} />
                  Online Store
                </div>
              </div>

              <div>
                <p className="b-text-sm b-text-bold" style={{ marginBottom: 8 }}>Include other original product details</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <CheckRow name="gift_include_product_type" label="Product type" checked={includeProductType} onChange={setIncludeProductType} />
                  <CheckRow name="gift_include_tags" label="Tags" checked={includeTags} onChange={setIncludeTags} />
                </div>
              </div>
            </div>
          </Section>

          {/* ── Gift inventory management ────────────────────── */}
          <Section title="Gift inventory management" desc="Manage how gift inventory is adjusted.">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="b-label" htmlFor="settings-inventory-method">Select inventory method</label>
                <select id="settings-inventory-method" aria-label="Select inventory method" className="b-select" name="inventory_method" value={invMethod} onChange={(e) => setInvMethod(e.target.value)}>
                  <option value="sync_auto">Sync cloned product quantity with originals automatically</option>
                  <option value="manual">Manual inventory management</option>
                  <option value="unlimited">Unlimited (no tracking)</option>
                </select>
              </div>
              <div>
                <p className="b-text-sm b-text-bold" style={{ marginBottom: 8 }}>When the gift is out of stock</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <RadioRow name="inventory_when_out" value="stop" label="Stop the offers" checked={whenOut === "stop"} onChange={setWhenOut} />
                  <RadioRow name="inventory_when_out" value="continue" label="Keep selling" checked={whenOut === "continue"} onChange={setWhenOut} />
                </div>
              </div>
            </div>
          </Section>

          {/* ── Fraud protection ─────────────────────────────── */}
          <Section title="Fraud protection" desc="Level up your store's security.">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CheckRow
                name="fraud_notify_email"
                label="Notify via email"
                checked={fraudNotify}
                onChange={setFraudNotify}
              />
              {fraudNotify && (
                <div style={{ paddingLeft: 26 }}>
                  <label className="b-label" htmlFor="settings-fraud-email">
                    Email address <span style={{ color: "var(--red)" }}>*</span>
                  </label>
                  <input
                    id="settings-fraud-email"
                    aria-label="Email address"
                    className="b-input"
                    type="email"
                    name="fraud_email_address"
                    value={fraudEmail}
                    onChange={(e) => setFraudEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    style={fraudNotify && !fraudEmail ? { borderColor: "var(--red)" } : undefined}
                  />
                  {fraudNotify && !fraudEmail && (
                    <div className="b-help" style={{ color: "var(--red)" }}>
                      Required when fraud notifications are enabled.
                    </div>
                  )}
                </div>
              )}

              <div className="b-checkbox-row">
                <input
                  type="checkbox"
                  id="fraud_cart_payment_rule"
                  name="fraud_cart_payment_rule"
                  checked={cartPayRule}
                  onChange={(e) => setCartPayRule(e.target.checked)}
                />
                <div>
                  <label htmlFor="fraud_cart_payment_rule" className="b-checkbox-label">
                    Cart and payment protection rule{" "}
                    <span className="b-badge b-badge-blue" style={{ verticalAlign: "middle", fontSize: 12 }}>Recommended</span>
                  </label>
                  <div className="b-checkbox-help">
                    Once you activate the cart and payment protection rule, BOGOS will add a custom checkout validation rule to Configuration &gt; Payment &gt; Checkout rules. This rule will prevent customers from paying only with gifts.
                  </div>
                </div>
              </div>

              {cartPayRule && (
                <div style={{ paddingLeft: 26 }}>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 8 }}>Additional condition</p>
                  <div style={{ display: "flex", gap: 16 }}>
                    <RadioRow name="fraud_condition_type" value="all" label="All conditions" checked={condType === "all"} onChange={setCondType} />
                    <RadioRow name="fraud_condition_type" value="any" label="Any condition" checked={condType === "any"} onChange={setCondType} />
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <CheckRow name="fraud_min_cart_value" label="Minimum cart value" checked={minCartVal} onChange={setMinCartVal} />
                    <CheckRow name="fraud_min_cart_qty" label="Minimum cart quantity" checked={minCartQty} onChange={setMinCartQty} />
                    <CheckRow name="fraud_max_gifts" label="Maximum number of gifts per order" checked={maxGifts} onChange={setMaxGifts} />
                  </div>
                </div>
              )}

              <CheckRow
                name="fraud_per_offer_config"
                label="Apply the cart and payment protection configuration for each offer separately"
                checked={perOfferConfig}
                onChange={setPerOfferConfig}
              />
              <CheckRow
                name="fraud_order_protection"
                label="Order protection"
                checked={orderProtection}
                onChange={setOrderProtection}
              />
            </div>
          </Section>

          {/* ── Advanced ─────────────────────────────────────── */}
          <Section title="Advanced" desc="More advanced configurations for the offers.">
            <CheckRow
              name="advanced_draft_order_api"
              label="Preliminary order API"
              help="This feature redirects orders that have gifts to the Order Draft page instead of going to the normal checkout page. It is necessary to enable this feature if a gift card is selected as a gift."
              checked={draftOrderApi}
              onChange={setDraftOrderApi}
            />
          </Section>

          {/* ── Reset ────────────────────────────────────────── */}
          <Section title="Reset application data" desc="Reset the application to disable it and clean up.">
            <p className="b-text-sm b-text-sub" style={{ margin: "0 0 12px" }}>
              To uninstall or disable the app, remove the app blocks from your theme and contact support if you need a full data cleanup.
            </p>
            <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
              <div className="b-banner-body">
                <div className="b-banner-title" style={{ color: "var(--red)" }}>⚠️ This action cannot be undone!</div>
                <p className="b-banner-text">A full reset stops all offers and removes app-created discount configuration.</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a href="mailto:support@secomapp.com" className="b-btn b-btn-secondary">Contact support</a>
              <a href="mailto:support@secomapp.com?subject=Reset%20application%20data" className="b-btn b-btn-danger">
                Request reset
              </a>
            </div>
          </Section>
        </div>

        {/* Save button */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="submit" className="b-btn b-btn-primary">Save settings</button>
        </div>
      </Form>

      {/* Terms */}
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <a href="https://secomapp.com/terms" className="b-btn b-btn-plain b-text-sm b-text-sub" style={{ textDecoration: "underline" }}>
          BOGOS Terms and Conditions ↗
        </a>
      </div>
    </div>
  );
}
