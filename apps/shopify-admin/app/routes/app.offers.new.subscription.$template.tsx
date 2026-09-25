import { useEffect, useState } from "react";
import { Link, redirect, useActionData, useLoaderData, useNavigate, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { OfferWizardHeader, OfferWizardSection, type WizardAccent } from "../components/offers/OfferWizardLayout.js";
import { SkioShippingManager } from "../components/SkioShippingManager.js";
import { SubscriptionCyclePricingForm } from "../components/SubscriptionCyclePricingForm.js";
import { Toast } from "../components/Toast.js";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { getSkioApiKey } from "../lib/skio-credentials.server.js";
import {
  addSkioShippingTier,
  loadSkioShippingConfig,
  saveSkioShippingConfig,
} from "../lib/skio-shipping-config.server.js";
import { skioShippingTierSchema } from "../lib/skio-shipping-tiers.js";
import { createCyclePricingPlan, parseCyclePricingFormData } from "../lib/subscription-cycle-pricing.server.js";
import { resolveSubscriptionTemplate } from "../lib/subscription-offer-templates.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const ACCENT: WizardAccent = {
  color: "#4f46e5",
  gradient: "linear-gradient(135deg, #818cf8 0%, #4f46e5 100%)",
  soft: "rgba(79,70,229,0.12)",
};

function templateOr404(slug: string | undefined) {
  const template = resolveSubscriptionTemplate(slug);
  if (!template) throw new Response("Unknown subscription template", { status: 404 });
  return template;
}

function adminClient(session: { shop: string; accessToken?: string }) {
  if (!session.accessToken) throw new Response("Shopify access token missing — reinstall the app", { status: 401 });
  return { shopDomain: session.shop, accessToken: session.accessToken };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const template = templateOr404(params.template);
  const { db, shopId, session } = await getShopContext(request);
  if (template.slug !== "skio-shipping") return { slug: template.slug, skio: null };
  const [loaded, apiKey] = await Promise.all([
    loadSkioShippingConfig(adminClient(session)),
    getSkioApiKey(db, shopId),
  ]);
  return {
    slug: template.slug,
    skio: {
      tierCount: loaded.config.tiers.length,
      configValid: loaded.configValid,
      configError: loaded.configError,
      apiKeyConnected: Boolean(apiKey),
    },
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const template = templateOr404(params.template);
  const { session } = await getShopContext(request);
  const client = adminClient(session);
  const formData = await request.formData();

  try {
    if (template.slug === "cycle-pricing") {
      const parsed = parseCyclePricingFormData(formData);
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid plan." };
      const result = await createCyclePricingPlan(client, parsed.data);
      if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
      return redirect(result.id ? `/app/subscription-pricing/${encodeURIComponent(result.id)}` : template.manageTo);
    }

    if (formData.get("intent") !== "save-tier") return { error: "Unsupported action." };
    const parsed = skioShippingTierSchema.safeParse(JSON.parse(String(formData.get("tier") ?? "{}")) as unknown);
    if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join(" ") };
    const loaded = await loadSkioShippingConfig(client);
    if (!loaded.configValid) return { error: "Repair the stored Skio configuration before adding tiers." };
    const next = addSkioShippingTier(loaded.config, parsed.data);
    if ("error" in next) return { error: next.error };
    const result = await saveSkioShippingConfig(client, next.config);
    if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
    return redirect(template.manageTo);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create the subscription offer." };
  }
}

function SubscriptionIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export default function NewSubscriptionOfferPage() {
  const { slug, skio } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const { markDirty, blocker } = useUnsavedGuard(isSubmitting);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  useEffect(() => {
    if (navigation.state === "submitting") setDismissedError(null);
  }, [navigation.state]);
  const template = resolveSubscriptionTemplate(slug)!;
  const error = actionData?.error;

  return (
    <div className="b-page">
      <OfferWizardHeader
        title={skio ? "New Skio shipping tier" : "New subscription cycle pricing"}
        subtitle={template.name}
        badge="Subscription"
        icon={<SubscriptionIcon />}
        accent={ACCENT}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }} onChange={markDirty}>
        {skio ? (
          <>
            <OfferWizardSection step={1} title="Skio connection" accent={ACCENT}>
              <div className="b-row b-justify-between b-gap-4">
                <p className="b-help" style={{ margin: 0 }}>
                  {skio.apiKeyConnected
                    ? "Skio is connected. New tiers apply on the next sync."
                    : "Tiers are saved in Shopify now and start syncing once Skio is connected."}{" "}
                  <Link to={template.manageTo}>Manage connection and existing tiers</Link>
                  {skio.tierCount > 0 && ` (${skio.tierCount} configured)`}.
                </p>
                <span className={`b-status-pill ${skio.apiKeyConnected ? "b-status-pill-green" : "b-status-pill-muted"}`}>
                  {skio.apiKeyConnected ? "Connected" : "Not connected"}
                </span>
              </div>
              {!skio.configValid && (
                <div className="b-banner b-banner-red" role="alert" style={{ marginTop: 12 }}>
                  Stored configuration is invalid. {skio.configError}
                </div>
              )}
            </OfferWizardSection>
            <OfferWizardSection step={2} title="Shipping tier" accent={ACCENT}>
              <SkioShippingManager
                tiers={[]}
                createOnly
                disabled={!skio.configValid}
                onCancel={() => void navigate("/app/offers")}
              />
            </OfferWizardSection>
          </>
        ) : (
          <>
            <OfferWizardSection step={1} title="Plan configuration" accent={ACCENT}>
              <p className="b-help" style={{ marginTop: 0 }}>
                Creates a Shopify selling plan group. Shopify freezes these pricing policies onto each
                new subscription contract; existing contracts keep their original pricing.{" "}
                <Link to={template.manageTo}>View existing plans</Link>.
              </p>
              <SubscriptionCyclePricingForm
                isSubmitting={isSubmitting}
                submitLabel="Create plan"
                cancelTo="/app/offers"
              />
            </OfferWizardSection>
          </>
        )}
      </div>

      {blocker.state === "blocked" && (
        <div className="b-modal-overlay">
          <div className="b-modal">
            <div className="b-modal-body">
              <h2>Discard unsaved changes?</h2>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="b-btn b-btn-secondary" onClick={() => blocker.reset()}>
                  Keep editing
                </button>
                <button type="button" className="b-btn b-btn-primary" onClick={() => blocker.proceed()}>
                  Discard
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {error && error !== dismissedError && (
        <Toast type="error" message={error} onDismiss={() => setDismissedError(error)} />
      )}
    </div>
  );
}
