/**
 * Priority and stacking configuration for an offer.
 * Shows which other active offers would conflict or be blocked.
 */

import { useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, offerCombinationPolicies } from "@promo/db";
import { eq, and, ne } from "drizzle-orm";
import { detectConflicts } from "../lib/conflict-detection.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;

  const [offerRows, policyRows, otherActiveOffers] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
    db.select({ id: offers.id, internalName: offers.internalName, priority: offers.priority, type: offers.type })
      .from(offers)
      .where(and(eq(offers.shopId, shopId), eq(offers.status, "active"), ne(offers.id, offerId)))
      .orderBy(offers.priority),
  ]);

  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const conflicts = await detectConflicts(shopId);
  const offerConflicts = conflicts.filter((c) => c.offerIds.includes(offerId));

  return {
    offer: { id: offer.id, internalName: offer.internalName, priority: offer.priority, status: offer.status },
    policy: policyRows[0] ?? null,
    otherActiveOffers: otherActiveOffers.map((o) => ({
      id: o.id,
      name: o.internalName,
      priority: o.priority,
      type: o.type,
      wouldBeBlocked: (policyRows[0]?.stopLowerPriority ?? false) && o.priority > offer.priority,
    })),
    conflicts: offerConflicts,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();

  const newPriority = parseInt(formData.get("priority") as string, 10);
  const stopLowerPriority = formData.get("stop_lower_priority") === "on";

  await db.update(offers).set({ priority: newPriority, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  await db.update(offerCombinationPolicies)
    .set({ stopLowerPriority, updatedAt: new Date() })
    .where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId)));

  return null;
};

export default function OfferPriorityPage() {
  const { offer, policy, otherActiveOffers, conflicts: offerConflicts } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Priority & Stacking" subtitle={offer.internalName} backTo={`/app/offers/${offer.id}`} />

      <div className="b-editor-layout">
        {/* Main column */}
        <div className="b-editor-main">
          {/* Priority configuration card */}
          <div className="b-card">
            <div className="b-card-header">Priority Configuration</div>
            <div className="b-card-body">
              <Form method="POST">
                <div className="b-stack b-stack-4">
                  {/* Priority number input */}
                  <div>
                    <label className="b-label" htmlFor="priority-input">Priority</label>
                    <input
                      id="priority-input"
                      className="b-input"
                      type="number"
                      name="priority"
                      defaultValue={String(offer.priority)}
                      autoComplete="off"
                      style={{ maxWidth: 160 }}
                    />
                    <p className="b-help">Lower number = evaluated first. Offer with priority 10 runs before priority 100.</p>
                  </div>

                  {/* Stop lower priority checkbox */}
                  <div className="b-checkbox-row">
                    <input
                      id="stop-lower-priority"
                      type="checkbox"
                      name="stop_lower_priority"
                      defaultChecked={policy?.stopLowerPriority ?? false}
                    />
                    <div>
                      <label className="b-checkbox-label" htmlFor="stop-lower-priority">
                        Stop lower-priority offers when this offer qualifies
                      </label>
                      <p className="b-checkbox-help">
                        When enabled, all active offers with higher priority numbers will be skipped if this offer qualifies.
                      </p>
                    </div>
                  </div>

                  {/* Save button */}
                  <div>
                    <button type="submit" className="b-btn b-btn-primary">
                      Save Priority Settings
                    </button>
                  </div>
                </div>
              </Form>
            </div>
          </div>

          {/* Conflicts card */}
          <div className="b-card">
            <div className="b-card-header">Conflicts</div>
            <div className="b-card-body">
              {offerConflicts.length > 0 ? (
                <div className="b-stack b-stack-3">
                  {offerConflicts.map((c) => (
                    <div key={`${c.type}:${c.message}`} className="b-banner b-banner-orange">
                      <span className="b-banner-icon">&#9888;</span>
                      <div className="b-banner-body">
                        <p className="b-banner-title">{c.type}</p>
                        <p className="b-banner-text">{c.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="b-badge b-badge-green">
                  &#10003; No conflicts detected
                </span>
              )}
            </div>
          </div>

          {/* Active offers table */}
          {otherActiveOffers.length > 0 && (
            <div className="b-card">
              <div className="b-card-header">Other Active Offers (by priority)</div>
              <div className="b-table-wrap" style={{ border: "none", borderRadius: 0, boxShadow: "none" }}>
                <table className="b-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {otherActiveOffers.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <span className="b-offer-name">{o.name}</span>
                          {o.wouldBeBlocked && (
                            <span className="b-badge b-badge-orange" style={{ marginLeft: 8 }}>
                              Would be blocked
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="b-type-chip">{o.type}</span>
                        </td>
                        <td>
                          <span className="b-text-bold">{o.priority}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="b-editor-sidebar">
          <div className="b-card">
            <div className="b-card-header">About Priority Ordering</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">
                <p className="b-text-sm b-text-sub">
                  Priority controls the order in which offers are evaluated when a customer qualifies for multiple promotions.
                </p>
                <div className="b-banner" style={{ marginBottom: 0 }}>
                  <span className="b-banner-icon">&#9432;</span>
                  <div className="b-banner-body">
                    <p className="b-banner-title">Lower number = higher priority</p>
                    <p className="b-banner-text">
                      An offer with priority <strong>10</strong> is evaluated before one with priority <strong>100</strong>.
                    </p>
                  </div>
                </div>
                <p className="b-text-sm b-text-sub">
                  Use <strong>Stop lower-priority offers</strong> to prevent other promotions from stacking when this offer qualifies. This is useful for exclusive deals.
                </p>
                <p className="b-text-sm b-text-sub">
                  Conflicts appear when two offers have incompatible combination rules and may both match the same cart.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
