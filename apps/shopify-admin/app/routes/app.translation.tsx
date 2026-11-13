/**
 * Translation management page.
 * Allows merchants to customize widget strings per locale.
 */

import { useLoaderData, useActionData, Form } from "react-router";
import { useState } from "react";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadTranslations, setTranslations } from "../lib/translations.server.js";
import { TRANSLATION_KEYS } from "../lib/translation-keys.js";
import { SUPPORTED_LOCALES, type WidgetTranslations } from "@promo/shared-types";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  if (!shopId) return { translations: {} as Record<string, Partial<WidgetTranslations>>, shopId: "" };
  return { translations: await loadTranslations(db, shopId), shopId };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  if (!shopId) return { error: "Shop not found" };

  const formData = await request.formData();
  const locale = formData.get("locale") as string;

  // The form names each field `<locale>.<key>`.
  const strings: Record<string, string | null> = {};
  for (const { key } of TRANSLATION_KEYS) {
    strings[key] = (formData.get(`${locale}.${key}`) ?? formData.get(key)) as string | null;
  }
  const result = await setTranslations({ db, shopId }, { locale, strings, mode: "replace" });
  if (!result.ok) return { error: result.error };
  return { success: true, locale };
};

export default function TranslationPage() {
  const { translations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red" role="alert" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">{actionData.error}</div>
        </div>
      )}
      <Form key={locale} id="translation-form" method="POST">
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
                          className="rd-style-086"
                        >
                          {token}
                        </span>
                      ))}
                    </p>
                  )}
                  <input
                    id={`field-${key}`}
                    aria-label={`${locale} ${key}`}
                    className="b-input"
                    type="text"
                    name={`${locale}.${key}`}
                    defaultValue={translations[locale]?.[key] ?? ""}
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
