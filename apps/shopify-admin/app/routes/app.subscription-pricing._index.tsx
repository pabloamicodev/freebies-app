import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import {
  deleteCyclePricingPlan,
  getCyclePricingPlan,
  listCyclePricingPlans,
} from "../lib/subscription-cycle-pricing.server.js";
export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

function client(session: { shop: string; accessToken?: string }) {
  if (!session.accessToken) throw new Response("Shopify access token missing — reinstall the app", { status: 401 });
  return { shopDomain: session.shop, accessToken: session.accessToken };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await getShopContext(request);
  return { plans: await listCyclePricingPlans(client(session)) };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await getShopContext(request);
  const formData = await request.formData();
  if (formData.get("intent") !== "delete") return { error: "Unsupported action." };
  const planId = String(formData.get("planId") ?? "");
  if (!planId.startsWith("gid://shopify/SellingPlanGroup/")) return { error: "Invalid Selling Plan Group ID." };
  const cycleClient = client(session);
  // getCyclePricingPlan only returns plans whose merchantCode carries this
  // app's (or the legacy app's) prefix — without this check, any Selling
  // Plan Group ID on the shop (including other apps' subscription plans)
  // could be deleted via this form.
  const owned = await getCyclePricingPlan(cycleClient, planId);
  if (!owned) return { error: "That plan was not created by this app and cannot be deleted here." };
  const result = await deleteCyclePricingPlan(cycleClient, planId);
  if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
  return { success: true };
}

export default function SubscriptionPricingPage() {
  const { plans } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <div className="b-page">
      <PageHeader
        title="Subscription cycle pricing"
        subtitle="Set one price for the first shipment and another from cycle 2 onward."
        backTo="/app/offers"
        backLabel="← All Offers"
        actions={<Link className="b-btn b-btn-primary" to="/app/offers/new/subscription/cycle-pricing">New plan</Link>}
      />
      {actionData?.error && <div className="b-banner b-banner-red" role="alert">{actionData.error}</div>}
      {plans.length === 0 ? (
        <div className="b-card b-p-5"><p>No cycle-pricing plans yet. <Link to="/app/offers/new/subscription/cycle-pricing">Create your first plan</Link>.</p></div>
      ) : (
        <div className="b-card b-table-wrap">
          <table className="b-table">
            <thead><tr><th>Plan</th><th>Schedule</th><th>Pricing</th><th>Products</th><th>Actions</th></tr></thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td>{plan.name}</td>
                  <td>Every {plan.intervalCount} {plan.intervalUnit.toLowerCase()} · {plan.totalCycles} cycles</td>
                  <td>{plan.firstCycleDiscount.value}{plan.firstCycleDiscount.type === "percentage" ? "%" : ""} first · {plan.recurringDiscount.value}{plan.recurringDiscount.type === "percentage" ? "%" : ""} later</td>
                  <td>{plan.productIds.length}</td>
                  <td>
                    <div className="b-row b-gap-2">
                      <Link className="b-btn b-btn-secondary b-btn-sm" to={`/app/subscription-pricing/${encodeURIComponent(plan.id)}`}>Edit</Link>
                      <Form method="post" onSubmit={(event: React.FormEvent<HTMLFormElement>) => { if (!window.confirm(`Delete ${plan.name}? Existing contracts remain, but new customers cannot select it.`)) event.preventDefault(); }}>
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="planId" value={plan.id} />
                        <button type="submit" className="b-btn b-btn-secondary b-btn-sm" disabled={navigation.state !== "idle"}>Delete</button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
