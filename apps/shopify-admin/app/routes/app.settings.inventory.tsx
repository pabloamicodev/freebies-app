/**
 * Gift Inventory Policy Settings
 * Controls how the promo engine behaves when gift products are out of stock.
 */

import { useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { appSettings } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { parseStoredJson } from "../lib/offer-validation.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import bogosStyles from "../styles/bogos.css?url";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const links = () => [{ rel: "stylesheet", href: bogosStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);

  const settingRows = await db.select()
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId)));

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) {
    settings[row.key] = parseStoredJson(row.value);
  }

  return {
    shopId,
    oosBehavior: (settings["gift.oos_behavior"] as string) ?? "hide",
    autoSwapEnabled: Boolean(settings["gift.auto_swap_enabled"] ?? false),
    continueSelling: Boolean(settings["gift.continue_selling_enabled"] ?? false),
    hideOosGifts: Boolean(settings["gift.hide_oos_gifts"] ?? true),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, db } = context;

  const updates = {
    "gift.oos_behavior": formData.get("oos_behavior") as string ?? "hide",
    "gift.auto_swap_enabled": formData.get("auto_swap") === "on",
    "gift.continue_selling_enabled": formData.get("continue_selling") === "on",
    "gift.hide_oos_gifts": formData.get("hide_oos") === "on",
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

export default function InventorySettingsPage() {
  const { oosBehavior, autoSwapEnabled, continueSelling, hideOosGifts } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Inventory Settings" backTo="/app/settings" />

      {/* Info banner */}
      <div className="b-banner">
        <span className="b-banner-icon">&#8505;&#65039;</span>
        <div className="b-banner-body">
          <p className="b-banner-title">Inventory limitation</p>
          <p className="b-banner-text">
            Shopify does not natively reserve cart inventory. A gift shown as available may sell out
            between cart creation and checkout. These settings control the best-effort behavior.
          </p>
        </div>
      </div>

      {/* Settings card */}
      <Form method="POST">
        <div className="b-card">

          {/* Section 1: Inventory method */}
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Out-of-Stock Behavior</p>
              <p className="b-settings-section-desc">
                Controls what customers see when a gift product has 0 inventory.
              </p>
            </div>
            <div className="b-settings-control-col">
              <label className="b-label" htmlFor="oos_behavior">
                When gift goes out of stock
              </label>
              <select
                id="oos_behavior"
                name="oos_behavior"
                defaultValue={oosBehavior}
                className="b-select"
              >
                <option value="hide">Hide the gift (don&apos;t show as option)</option>
                <option value="show_disabled">Show as disabled (greyed out, unselectable)</option>
                <option value="show_available">Show as available (use continue-selling policy)</option>
              </select>
              <p className="b-help">Controls what customers see when a gift product has 0 inventory.</p>
            </div>
          </div>

          {/* Section 2: Sync options */}
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Sync Options</p>
              <p className="b-settings-section-desc">
                Configure how the promo engine syncs and falls back when gifts run out.
              </p>
            </div>
            <div className="b-settings-control-col">
              <div className="b-settings-row">
                <label className="b-checkbox-row">
                  <input
                    type="checkbox"
                    name="auto_swap"
                    defaultChecked={autoSwapEnabled}
                  />
                  <div>
                    <span className="b-checkbox-label">Auto-swap to fallback gift</span>
                    <p className="b-checkbox-help">
                      When the primary gift is OOS, automatically offer the next gift in the reward list by sort order.
                    </p>
                  </div>
                </label>
              </div>

              <div className="b-settings-row">
                <label className="b-checkbox-row">
                  <input
                    type="checkbox"
                    name="continue_selling"
                    defaultChecked={continueSelling}
                  />
                  <div>
                    <span className="b-checkbox-label">Continue selling gifts when inventory_policy = CONTINUE</span>
                    <p className="b-checkbox-help">
                      If the gift product has &apos;Continue selling when out of stock&apos; enabled in Shopify,
                      allow auto-add even when inventory_quantity is 0.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Section 3: Out-of-stock display */}
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Out-of-Stock Display</p>
              <p className="b-settings-section-desc">
                Control how OOS gifts appear in the gift slider shown to customers.
              </p>
            </div>
            <div className="b-settings-control-col">
              <div className="b-settings-row">
                <label className="b-checkbox-row">
                  <input
                    type="checkbox"
                    name="hide_oos"
                    defaultChecked={hideOosGifts}
                  />
                  <div>
                    <span className="b-checkbox-label">Hide OOS gifts from slider</span>
                    <p className="b-checkbox-help">
                      Remove out-of-stock gifts from the gift slider entirely (not shown as disabled).
                    </p>
                  </div>
                </label>
              </div>

              <hr className="b-divider" />

              <p className="b-text-sm b-text-bold">At checkout (always enforced):</p>
              <div className="b-stack b-stack-2 b-mt-2">
                <span className="b-text-sm b-text-sub">Gift is removed if OOS at checkout prepare</span>
                <span className="b-text-sm b-text-sub">Discount Function validates gift availability</span>
                <span className="b-text-sm b-text-sub">Validation Function blocks invalid gift quantity</span>
              </div>
            </div>
          </div>

        </div>

        {/* Save button */}
        <div className="b-row b-justify-between b-mt-4">
          <span />
          <button type="submit" className="b-btn b-btn-primary">
            Save Inventory Settings
          </button>
        </div>
      </Form>
    </div>
  );
}
