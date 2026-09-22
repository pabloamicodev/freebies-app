import { redirect, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { SubscriptionCyclePricingForm } from "../components/SubscriptionCyclePricingForm.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { createCyclePricingPlan, parseCyclePricingFormData } from "../lib/subscription-cycle-pricing.server.js";
export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await getShopContext(request);
  if (!session.accessToken) return { error: "Shopify access token missing — reinstall the app." };
  const parsed = parseCyclePricingFormData(await request.formData());
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid plan." };
  const result = await createCyclePricingPlan({ shopDomain: session.shop, accessToken: session.accessToken }, parsed.data);
  if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
  return redirect("/app/subscription-pricing");
}

export default function NewSubscriptionPricingPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <div className="b-page">
      <PageHeader title="New subscription cycle pricing" subtitle="Shopify freezes these pricing policies onto each new subscription contract." backTo="/app/subscription-pricing" />
      <div className="b-card b-p-5">
        <SubscriptionCyclePricingForm error={actionData?.error} isSubmitting={navigation.state !== "idle"} submitLabel="Create plan" />
      </div>
    </div>
  );
}
