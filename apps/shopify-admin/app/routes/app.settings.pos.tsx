/**
 * POS Settings — configure which offers apply in Shopify POS.
 * POS cannot render web widgets (gift slider, progress bar, etc.)
 * but Discount Function applies at POS checkout.
 */

import { useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { appSettings } from "@promo/db";
import { and, eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);

  const posSettingRows = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "pos.enabled")))
    .limit(1);

  const posEnabled = posSettingRows[0]?.value === "true";
  return { shopId, posEnabled };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);

  const formData = await request.formData();
  const posEnabled = formData.get("pos_enabled") === "on";

  await db.insert(appSettings)
    .values({ shopId, key: "pos.enabled", value: String(posEnabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(posEnabled), updatedAt: new Date() },
    });

  return { success: true };
};

export default function PosSettingsPage() {
  const { posEnabled } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Page header */}
      <PageHeader title="POS Settings" backTo="/app/settings" />

      {/* Info banner */}
      <div className="b-banner b-mb-4">
        <div className="b-banner-icon">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5" />
            <path d="M10 9v5" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="6.5" r="0.75" fill="#2c6ecb" />
          </svg>
        </div>
        <div className="b-banner-body">
          <p className="b-banner-title">POS promotions work differently</p>
          <p className="b-banner-text">
            Web widgets (gift slider, progress bar, today offer) cannot render in POS.
            Discounts are applied via Shopify Discount Function at POS checkout.
            Auto-add gifts may need to be added manually by the POS operator.
          </p>
        </div>
      </div>

      <Form method="POST">
        <div className="b-card">
          <div className="b-card-header">POS Configuration</div>

          {/* Section: Enable toggle */}
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Enable POS promotions</p>
              <p className="b-settings-section-desc">
                Turn on to allow the Discount Function to evaluate and apply eligible
                promotions at Shopify POS checkout.
              </p>
            </div>
            <div className="b-settings-control-col">
              <div className="b-checkbox-row">
                <label className="b-toggle">
                  <input
                    type="checkbox"
                    name="pos_enabled"
                    defaultChecked={posEnabled}
                  />
                  <span className="b-toggle-track" />
                  <span className="b-toggle-thumb" />
                </label>
                <div>
                  <span className="b-checkbox-label">Enable promotions in Shopify POS</span>
                  <p className="b-checkbox-help">
                    When enabled, eligible promotions are evaluated at POS checkout via the
                    Discount Function.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Section: POS compatibility reference */}
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Feature compatibility</p>
              <p className="b-settings-section-desc">
                Overview of which promotion features work in Shopify POS versus
                online storefronts.
              </p>
            </div>
            <div className="b-settings-control-col">
              <div className="b-stack b-stack-2">
                {/* Supported */}
                <p className="b-label" style={{ marginBottom: 8 }}>Supported in POS</p>
                {[
                  "Discount Function applies gift discounts at checkout",
                  "Cart discount (% or fixed amount)",
                  "Volume discount tiers",
                  "Cheapest item free",
                ].map((item) => (
                  <div key={item} className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                    <span style={{ color: "var(--green)", flexShrink: 0, marginTop: 1 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <circle cx="7" cy="7" r="6" fill="var(--green-badge)" />
                        <path d="M4 7l2 2 4-4" stroke="var(--green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="b-text-sm">{item}</span>
                  </div>
                ))}

                <hr className="b-divider" />

                {/* Not supported */}
                <p className="b-label" style={{ marginBottom: 8 }}>Not supported in POS</p>
                {[
                  "Gift slider (web widget)",
                  "Progress bar (web widget)",
                  "Today Offer floating widget",
                  "Auto-add gift (POS operator must add manually)",
                ].map((item) => (
                  <div key={item} className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                    <span style={{ color: "var(--red)", flexShrink: 0, marginTop: 1 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <circle cx="7" cy="7" r="6" fill="var(--red-bg)" />
                        <path d="M5 5l4 4M9 5l-4 4" stroke="var(--red)" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                    <span className="b-text-sm b-text-sub">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Save button */}
        <div className="b-row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="submit" className="b-btn b-btn-primary">
            Save POS Settings
          </button>
        </div>
      </Form>
    </div>
  );
}
