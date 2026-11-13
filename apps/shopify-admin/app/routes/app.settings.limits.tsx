/**
 * Offer limits rollout: the per-shop `limits.enforced` flag. Until it is on, per-cart and per-customer
 * limits are saved but the Functions ignore them. Only shops in LIMITS_TOGGLE_SHOPS can flip it; every change
 * is audited and republishes the shop's offers so the Functions pick it up. Turning it on is refused while
 * limited automatic offers share a discount title (orders are attributed by title).
 */

import { useLoaderData, useActionData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { canToggleLimits, isLimitsEnforced } from "../lib/limits-enforced.server.js";
import { changeLimitsEnforced } from "../lib/shop-settings.server.js";
import { publishShopConfig } from "../lib/offer-publish-flow.server.js";
import type { ShopPublishFn } from "../lib/offer-publish-flow.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db, shopDomain } = await getShopContext(request);
  return { enforced: await isLimitsEnforced(db, shopId), canToggle: canToggleLimits(shopDomain) };
};

const publishAsFailure: ShopPublishFn = async (id, domain) => {
  const message = await publishShopConfig(id, domain);
  return message ? { message, scope: "shop" } : null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, shopDomain, db, session } = context;
  const enabled = formData.get("limits_enforced") === "on";
  const performedBy = session.onlineAccessInfo?.associated_user?.email ?? session.id;
  const result = await changeLimitsEnforced({ db, shopId, shopDomain, performedBy, publish: publishAsFailure }, enabled);
  return result.ok ? { success: true } : { error: result.error };
};

export default function LimitsSettingsPage() {
  const { enforced, canToggle } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="b-page">
      <PageHeader title="Offer limits" backTo="/app/settings" />

      {actionData && "success" in actionData && (
        <div className="b-banner b-banner-green" role="status" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <div className="b-banner-title">Saved and republished</div>
          </div>
        </div>
      )}
      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red" role="alert" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <div className="b-banner-title" style={{ color: "var(--red)" }}>{actionData.error}</div>
          </div>
        </div>
      )}

      <Form method="POST">
        <div className="b-card">
          <div className="b-card-header">Enforcement</div>
          <div className="b-settings-section">
            <div className="b-settings-label-col">
              <p className="b-settings-section-title">Enforce per-cart and per-customer limits</p>
              <p className="b-settings-section-desc">
                When on, Shopify checkout enforces each offer&apos;s max per cart, max per customer and
                &quot;require an identified customer&quot;. Turning it off republishes without them.
              </p>
            </div>
            <div className="b-settings-control-col">
              <div className="b-checkbox-row">
                <input
                  type="checkbox"
                  id="limits_enforced"
                  name="limits_enforced"
                  defaultChecked={enforced}
                  disabled={!canToggle}
                />
                <label htmlFor="limits_enforced" className="b-checkbox-label">Enforce limits</label>
              </div>
              {!canToggle && <p className="b-text-sm b-text-sub">Not available for this shop.</p>}
            </div>
          </div>
        </div>
        {canToggle && (
          <button type="submit" className="b-btn b-btn-primary" style={{ marginTop: 16 }}>Save</button>
        )}
      </Form>
    </div>
  );
}
