/**
 * Translation management page.
 * Allows merchants to customize widget strings per locale.
 */

import { useLoaderData, Form } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { SUPPORTED_LOCALES, type WidgetTranslations } from "@promo/shared-types";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const TRANSLATION_KEYS: Array<{ key: keyof WidgetTranslations; label: string; hint?: string }> = [
  { key: "progress.before_goal", label: "Progress bar — before goal", hint: "Use {{remaining_amount}} for the amount, {{remaining_quantity}} for quantity." },
  { key: "progress.after_goal", label: "Progress bar — after goal" },
  { key: "gift_slider.title", label: "Gift slider title" },
  { key: "gift_slider.confirm_button", label: "Gift slider confirm button" },
  { key: "gift_slider.out_of_stock", label: "Gift out of stock label" },
  { key: "gift_slider.free_label", label: "Free price label" },
  { key: "today_offer.title", label: "Today Offer widget title" },
  { key: "today_offer.button", label: "Today Offer button text" },
  { key: "volume_discount.title", label: "Volume discount title" },
  { key: "fbt.title", label: "FBT widget title" },
  { key: "fbt.add_button", label: "FBT add button", hint: "Use {{count}} for number of items." },
  { key: "upsell.no_thanks", label: "Upsell dismiss text" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { translations: {} as Record<string, Partial<WidgetTranslations>>, shopId: "" };

  const settingRows = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "translations.strings")))
    .limit(1);

  let translations: Record<string, Partial<WidgetTranslations>> = {};
  if (settingRows[0]) {
    try { translations = JSON.parse(settingRows[0].value); } catch {}
  }

  return { translations, shopId };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const formData = await request.formData();
  const locale = formData.get("locale") as string;

  const strings: Partial<WidgetTranslations> = { locale };
  for (const { key } of TRANSLATION_KEYS) {
    const val = formData.get(key) as string | null;
    if (val?.trim()) (strings as any)[key] = val.trim();
  }

  // Load existing translations
  const existing = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "translations.strings")))
    .limit(1);

  let allTranslations: Record<string, Partial<WidgetTranslations>> = {};
  if (existing[0]) {
    try { allTranslations = JSON.parse(existing[0].value); } catch {}
  }
  allTranslations[locale] = strings;

  await db.insert(appSettings)
    .values({ shopId, key: "translations.strings", value: JSON.stringify(allTranslations) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(allTranslations), updatedAt: new Date() },
    });

  return { success: true, locale };
};

export default function TranslationPage() {
  const { translations } = useLoaderData<typeof loader>();
  const [locale, setLocale] = useState("en");

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <h1 className="b-page-title">Translation</h1>
        <div className="b-page-actions">
          <button type="submit" form="translation-form" className="b-btn b-btn-primary">
            Save
          </button>
        </div>
      </div>

      {/* Locale selector tabs */}
      <div className="b-card" style={{ marginBottom: 16 }}>
        <div className="b-tabs">
          <ul className="b-tabs-list">
            {SUPPORTED_LOCALES.map((l) => (
              <li key={l}>
                <button
                  type="button"
                  className={`b-tab${locale === l ? " active" : ""}`}
                  onClick={() => setLocale(l)}
                >
                  {l.toUpperCase()}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Translation form */}
      <Form id="translation-form" method="POST">
        <input type="hidden" name="locale" value={locale} />

        <div className="b-card">
          <div className="b-card-header">
            Widget strings — {locale.toUpperCase()}
          </div>
          <div className="b-card-body">
            <div className="b-stack b-stack-4">
              {TRANSLATION_KEYS.map(({ key, label, hint }) => (
                <div key={key}>
                  <label className="b-label" htmlFor={`field-${key}`}>
                    {label}
                  </label>
                  {hint && (
                    <p className="b-help" style={{ marginBottom: 6 }}>
                      {hint.replace(/(\{\{[^}]+\}\})/g, "")}
                      {hint.match(/\{\{[^}]+\}\}/g)?.map((token) => (
                        <span
                          key={token}
                          style={{
                            display: "inline-block",
                            background: "#f3f4f6",
                            color: "#6d7175",
                            borderRadius: 3,
                            padding: "0 4px",
                            fontFamily: "monospace",
                            fontSize: 11,
                            marginLeft: 2,
                          }}
                        >
                          {token}
                        </span>
                      ))}
                    </p>
                  )}
                  <input
                    id={`field-${key}`}
                    className="b-input"
                    type="text"
                    name={`${locale}.${key}`}
                    defaultValue={(translations[locale] as any)?.[key] ?? ""}
                    placeholder="Leave empty to use default English string"
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="b-btn b-btn-primary">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </Form>
    </div>
  );
}
