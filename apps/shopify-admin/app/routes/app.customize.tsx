/**
 * Customize — global widget theme and default copy settings.
 * Controls colors, fonts, and default strings across all widgets.
 * Matches BOGOS's "Customize" section.
 */

import { useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { useState } from "react";
import { getShopContext } from "../lib/shop-context.server.js";
import { appSettings } from "@promo/db";
import { and, eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const THEME_SETTINGS_KEY = "widget.global_theme";

const DEFAULTS = {
  primaryColor: "#111111",
  accentColor: "#059669",
  buttonColor: "#111111",
  buttonTextColor: "#ffffff",
  backgroundColor: "#ffffff",
  textColor: "#111111",
  borderRadius: "8",
  fontFamily: "inherit",
  giftsLabel: "Free Gift",
  sliderTitle: "Choose Your Gift",
  progressBeforeGoal: "Spend {{remaining_amount}} more for a free gift!",
  progressAfterGoal: "🎁 You've unlocked your free gift!",
  todayOfferTitle: "Today's Deals",
  addToCartText: "Add to Cart",
  noThanksText: "No thanks",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);

  const [settingRow] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, THEME_SETTINGS_KEY)))
    .limit(1);

  let theme = DEFAULTS;
  if (settingRow?.value) {
    try { theme = { ...DEFAULTS, ...JSON.parse(settingRow.value) }; } catch {}
  }

  return { shopId, theme };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();

  const theme: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    theme[key] = value as string;
  }

  await db.insert(appSettings)
    .values({ shopId, key: THEME_SETTINGS_KEY, value: JSON.stringify(theme) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(theme), updatedAt: new Date() },
    });

  return { success: true };
};

// Small inline color swatch prefix for text inputs
function ColorSwatch({ color }: { color: string }) {
  return (
    <div
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        background: color,
        border: "1px solid #e5e7eb",
        flexShrink: 0,
      }}
    />
  );
}

// Input with a color swatch displayed inline before the text field
function ColorInputRow({
  label,
  name,
  value,
  onChange,
  defaultValue,
  helpText,
}: {
  label: string;
  name: string;
  value?: string;
  onChange?: (v: string) => void;
  defaultValue?: string;
  helpText?: string;
}) {
  const controlled = value !== undefined && onChange !== undefined;
  return (
    <div>
      <label className="b-label" htmlFor={name}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ColorSwatch color={controlled ? value! : (defaultValue ?? "#000000")} />
        {controlled ? (
          <input
            id={name}
            className="b-input"
            name={name}
            value={value}
            onChange={(e) => onChange!(e.target.value)}
            autoComplete="off"
          />
        ) : (
          <input
            id={name}
            className="b-input"
            name={name}
            defaultValue={defaultValue}
            autoComplete="off"
          />
        )}
      </div>
      {helpText && <p className="b-help">{helpText}</p>}
    </div>
  );
}

export default function CustomizePage() {
  const { theme } = useLoaderData<typeof loader>();
  const [primaryColor, setPrimaryColor] = useState(theme.primaryColor);
  const [accentColor, setAccentColor] = useState(theme.accentColor);
  const [buttonColor, setButtonColor] = useState(theme.buttonColor);

  return (
    <div className="b-page">
      {/* ── Page header ───────────────────────────────────────── */}
      <PageHeader title="Customize" subtitle="Global widget appearance and default copy" />

      {/* ── Info banner ───────────────────────────────────────── */}
      <div className="b-banner">
        <div className="b-banner-icon">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5" />
            <path d="M10 9v5M10 7h.01" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <div className="b-banner-body">
          <p className="b-banner-title">These settings apply globally to all widgets</p>
          <p className="b-banner-text">
            Individual offers can override colors and copy in their widget settings.
            Changes here are applied immediately on the next page load.
          </p>
        </div>
      </div>

      {/* ── Two-column layout ─────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16, alignItems: "start" }}>

        {/* ── LEFT: form ──────────────────────────────────────── */}
        <Form method="POST">
          <div className="b-stack" style={{ gap: 16 }}>

            {/* Colors card */}
            <div className="b-card">
              <div className="b-card-header">Colors</div>
              <div className="b-card-body">
                <div className="b-stack" style={{ gap: 14 }}>
                  <div className="b-grid-2">
                    <ColorInputRow
                      label="Primary color (buttons, borders)"
                      name="primaryColor"
                      value={primaryColor}
                      onChange={setPrimaryColor}
                      helpText="Used for button backgrounds, progress bar fill, and selected states."
                    />
                    <ColorInputRow
                      label="Accent / success color"
                      name="accentColor"
                      value={accentColor}
                      onChange={setAccentColor}
                      helpText="Used for 'Free', success states, and discount labels."
                    />
                  </div>
                  <div className="b-grid-2">
                    <ColorInputRow
                      label="Button color"
                      name="buttonColor"
                      value={buttonColor}
                      onChange={setButtonColor}
                    />
                    <div>
                      <label className="b-label" htmlFor="buttonTextColor">Button text color</label>
                      <input
                        id="buttonTextColor"
                        className="b-input"
                        name="buttonTextColor"
                        defaultValue={theme.buttonTextColor}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div className="b-grid-2">
                    <div>
                      <label className="b-label" htmlFor="backgroundColor">Widget background color</label>
                      <input
                        id="backgroundColor"
                        className="b-input"
                        name="backgroundColor"
                        defaultValue={theme.backgroundColor}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="textColor">Text color</label>
                      <input
                        id="textColor"
                        className="b-input"
                        name="textColor"
                        defaultValue={theme.textColor}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Typography & Shape card */}
            <div className="b-card">
              <div className="b-card-header">Typography &amp; Shape</div>
              <div className="b-card-body">
                <div className="b-stack" style={{ gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="fontFamily">Font family</label>
                    <select
                      id="fontFamily"
                      className="b-select"
                      name="fontFamily"
                      defaultValue={theme.fontFamily}
                    >
                      <option value="inherit">Inherit from theme (recommended)</option>
                      <option value="system-ui, sans-serif">System UI</option>
                      <option value="Inter, sans-serif">Inter</option>
                      <option value="'Helvetica Neue', sans-serif">Helvetica Neue</option>
                    </select>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="borderRadius">Border radius (px)</label>
                    <input
                      id="borderRadius"
                      className="b-input"
                      name="borderRadius"
                      type="number"
                      defaultValue={theme.borderRadius}
                      autoComplete="off"
                    />
                    <p className="b-help">
                      Controls rounded corners on widgets and buttons. 0 = square, 8 = slightly rounded, 999 = pill.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Default Widget Copy card */}
            <div className="b-card">
              <div className="b-card-header">Default Widget Copy</div>
              <div className="b-card-body">
                <p className="b-text-sm b-text-sub" style={{ marginBottom: 14 }}>
                  These strings are used across all widgets unless overridden per-offer or per-translation.
                  Use <code>{"{{remaining_amount}}"}</code>, <code>{"{{remaining_quantity}}"}</code> as dynamic values.
                </p>
                <div className="b-stack" style={{ gap: 14 }}>
                  <div className="b-grid-2">
                    <div>
                      <label className="b-label" htmlFor="giftsLabel">Gift label</label>
                      <input
                        id="giftsLabel"
                        className="b-input"
                        name="giftsLabel"
                        defaultValue={theme.giftsLabel}
                        autoComplete="off"
                        placeholder="Free Gift"
                      />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="sliderTitle">Gift slider title</label>
                      <input
                        id="sliderTitle"
                        className="b-input"
                        name="sliderTitle"
                        defaultValue={theme.sliderTitle}
                        autoComplete="off"
                        placeholder="Choose Your Gift"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="progressBeforeGoal">Progress bar — before goal</label>
                    <input
                      id="progressBeforeGoal"
                      className="b-input"
                      name="progressBeforeGoal"
                      defaultValue={theme.progressBeforeGoal}
                      autoComplete="off"
                    />
                    <p className="b-help">Shown while cart has not reached the threshold yet.</p>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="progressAfterGoal">Progress bar — after goal</label>
                    <input
                      id="progressAfterGoal"
                      className="b-input"
                      name="progressAfterGoal"
                      defaultValue={theme.progressAfterGoal}
                      autoComplete="off"
                    />
                    <p className="b-help">Shown when the cart has reached the threshold.</p>
                  </div>
                  <div className="b-grid-2">
                    <div>
                      <label className="b-label" htmlFor="todayOfferTitle">Today Offer widget title</label>
                      <input
                        id="todayOfferTitle"
                        className="b-input"
                        name="todayOfferTitle"
                        defaultValue={theme.todayOfferTitle}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="addToCartText">Add to cart button text</label>
                      <input
                        id="addToCartText"
                        className="b-input"
                        name="addToCartText"
                        defaultValue={theme.addToCartText}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="noThanksText">Upsell dismiss text</label>
                    <input
                      id="noThanksText"
                      className="b-input"
                      name="noThanksText"
                      defaultValue={theme.noThanksText}
                      autoComplete="off"
                      placeholder="No thanks"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Save button */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="b-btn b-btn-primary">
                Save Customization
              </button>
            </div>

          </div>
        </Form>

        {/* ── RIGHT: preview sidebar ──────────────────────────── */}
        <div className="b-card" style={{ position: "sticky", top: 20 }}>
          <div className="b-card-header">Preview</div>
          <div className="b-card-body" style={{ fontFamily: theme.fontFamily }}>

            {/* Gift slider preview */}
            <div
              style={{
                border: `2px solid ${primaryColor}`,
                borderRadius: `${theme.borderRadius}px`,
                padding: 12,
                marginBottom: 12,
                background: theme.backgroundColor,
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px", color: theme.textColor }}>
                {theme.sliderTitle}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "8px 10px",
                  border: `2px solid ${primaryColor}`,
                  borderRadius: `${theme.borderRadius}px`,
                  alignItems: "center",
                }}
              >
                <div style={{ width: 40, height: 40, background: "#f3f4f6", borderRadius: 4, flexShrink: 0 }} />
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, margin: 0, color: theme.textColor }}>Sample Gift</p>
                  <p style={{ fontSize: 11, color: accentColor, margin: 0, fontWeight: 700 }}>Free</p>
                </div>
              </div>
              <button
                type="button"
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "8px 16px",
                  background: buttonColor,
                  color: theme.buttonTextColor,
                  border: "none",
                  borderRadius: `${theme.borderRadius}px`,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {theme.addToCartText}
              </button>
            </div>

            {/* Progress bar preview */}
            <div style={{ marginBottom: 4 }}>
              <p style={{ fontSize: 12, color: theme.textColor, marginBottom: 6, margin: "0 0 6px" }}>
                {theme.progressBeforeGoal.replace("{{remaining_amount}}", "$25.00")}
              </p>
              <div className="b-progress">
                <div
                  className="b-progress-fill"
                  style={{ width: "60%", background: primaryColor }}
                />
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}
