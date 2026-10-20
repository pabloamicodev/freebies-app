/**
 * Offer limits rollout: the per-shop `limits.enforced` flag. Until it is on, per-cart and per-customer
 * limits are saved but the Functions ignore them. Only the shop owner can flip it; every change is audited
 * and republishes the shop's offers so the Functions pick it up.
 */

import { useLoaderData, useActionData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { canToggleLimits, isLimitsEnforced, setLimitsEnforced } from "../lib/limits-enforced.server.js";
import { publishShopConfig } from "../lib/offer-publish-flow.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db, session } = await getShopContext(request);
  return { enforced: await isLimitsEnforced(db, shopId), canToggle: canToggleLimits(session) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, shopDomain, db, session } = context;
  if (!canToggleLimits(session)) return { error: "Only the shop owner can change this setting." };
  const enabled = formData.get("limits_enforced") === "on";
  const performedBy = session.onlineAccessInfo?.associated_user?.email ?? session.id;
  await setLimitsEnforced(db, shopId, enabled, performedBy);
  const publishError = await publishShopConfig(shopId, shopDomain);
  if (publishError) return { error: `Saved, but republishing to Shopify failed: ${publishError}` };
  return { success: true };
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
                  aria-label="Enforce offer limits"
                />
                <label htmlFor="limits_enforced" className="b-checkbox-label">Enforce limits</label>
              </div>
              {!canToggle && <p className="b-text-sm b-text-sub">Only the shop owner can change this.</p>}
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
