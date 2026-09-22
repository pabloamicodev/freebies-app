import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { SubscriptionCyclePricingForm } from "../components/SubscriptionCyclePricingForm.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { getCyclePricingPlan, parseCyclePricingFormData, updateCyclePricingPlan } from "../lib/subscription-cycle-pricing.server.js";
export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

function decodePlanId(raw: string | undefined): string {
  const id = decodeURIComponent(raw ?? "");
  if (!id.startsWith("gid://shopify/SellingPlanGroup/")) throw new Response("Invalid plan ID", { status: 400 });
  return id;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await getShopContext(request);
  if (!session.accessToken) throw new Response("Shopify access token missing — reinstall the app", { status: 401 });
  const plan = await getCyclePricingPlan({ shopDomain: session.shop, accessToken: session.accessToken }, decodePlanId(params.id));
  if (!plan) throw new Response("Plan not found", { status: 404 });
  return { plan };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await getShopContext(request);
  if (!session.accessToken) return { error: "Shopify access token missing — reinstall the app." };
  const cycleClient = { shopDomain: session.shop, accessToken: session.accessToken };
  const existing = await getCyclePricingPlan(cycleClient, decodePlanId(params.id));
  if (!existing) throw new Response("Plan not found", { status: 404 });
  const parsed = parseCyclePricingFormData(await request.formData());
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid plan." };
  const result = await updateCyclePricingPlan(cycleClient, existing, parsed.data);
  if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
  return redirect("/app/subscription-pricing");
}

export default function EditSubscriptionPricingPage() {
  const { plan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <div className="b-page">
      <PageHeader title="Edit subscription cycle pricing" subtitle={plan.name} backTo="/app/subscription-pricing" />
      <div className="b-card b-p-5">
        <SubscriptionCyclePricingForm plan={plan} error={actionData?.error} isSubmitting={navigation.state !== "idle"} submitLabel="Save changes" />
      </div>
    </div>
  );
}
