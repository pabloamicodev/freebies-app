import { Form, useActionData, useLoaderData } from "react-router";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { SkioShippingManager } from "../components/SkioShippingManager.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { deleteSkioApiKey, getSkioApiKey, saveSkioApiKey } from "../lib/skio-credentials.server.js";
import { makeSkioGraphQLProxy, validateSkioApiKey } from "../lib/skio-api.server.js";
import {
  deleteSkioShippingTier,
  loadSkioShippingConfig,
  saveSkioShippingConfig,
  upsertSkioShippingTier,
} from "../lib/skio-shipping-config.server.js";
import { runSkioShippingSync } from "../lib/skio-shipping-runner.server.js";
import { skioShippingTierSchema } from "../lib/skio-shipping-tiers.js";
export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

function adminClient(session: { shop: string; accessToken?: string }) {
  if (!session.accessToken) throw new Response("Shopify access token missing — reinstall the app", { status: 401 });
  return { shopDomain: session.shop, accessToken: session.accessToken };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { db, shopId, session } = await getShopContext(request);
  const [loaded, apiKey] = await Promise.all([
    loadSkioShippingConfig(adminClient(session)),
    getSkioApiKey(db, shopId),
  ]);
  return {
    tiers: loaded.config.tiers,
    configValid: loaded.configValid,
    configError: loaded.configError,
    importedFromLegacy: loaded.importedFromLegacy,
    apiKeyConnected: Boolean(apiKey),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { db, shopId, session } = await getShopContext(request);
  const client = adminClient(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "connect") {
      const apiKey = String(formData.get("apiKey") ?? "").trim();
      if (!apiKey) return { error: "Enter a Skio API key." };
      if (apiKey.length > 4_096) return { error: "Skio API key is too large." };
      const validation = await validateSkioApiKey(apiKey);
      if (!validation.ok) return { error: validation.error ?? "Skio rejected the API key." };
      await saveSkioApiKey(db, shopId, apiKey);
      return { success: "Skio connected." };
    }

    if (intent === "disconnect") {
      await deleteSkioApiKey(db, shopId);
      return { success: "Skio disconnected." };
    }

    const loaded = await loadSkioShippingConfig(client);
    if (!loaded.configValid) return { error: "Repair the stored Skio configuration before making changes." };

    if (intent === "save-tier") {
      const raw = JSON.parse(String(formData.get("tier") ?? "{}")) as unknown;
      const parsed = skioShippingTierSchema.safeParse(raw);
      if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join(" ") };
      const next = upsertSkioShippingTier(loaded.config, parsed.data);
      const result = await saveSkioShippingConfig(client, next);
      if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
      return { success: "Shipping tier saved." };
    }

    if (intent === "delete-tier") {
      const tierId = String(formData.get("tierId") ?? "");
      const next = deleteSkioShippingTier(loaded.config, tierId);
      const result = await saveSkioShippingConfig(client, next);
      if (result.userErrors.length) return { error: result.userErrors.map((issue) => issue.message).join(" ") };
      return { success: "Shipping tier deleted." };
    }

    if (intent === "sync") {
      const apiKey = await getSkioApiKey(db, shopId);
      if (!apiKey) return { error: "Connect Skio before running a sync." };
      const results = await runSkioShippingSync(makeSkioGraphQLProxy(apiKey), loaded.config);
      return {
        success: `Sync complete: ${results.filter((result) => result.applied).length} updated, ${results.length} evaluated.`,
      };
    }

    return { error: "Unsupported action." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Skio operation failed." };
  }
}

export default function SkioShippingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="b-page">
      <PageHeader
        title="Skio shipping"
        backTo="/app/offers"
        backLabel="← All Offers"
        subtitle="Set the delivery price for each subscription cycle without changing Shopify checkout discounts."
      />
      {actionData?.error && <div className="b-banner b-banner-red" role="alert">{actionData.error}</div>}
      {actionData?.success && <div className="b-banner b-banner-green" role="status">{actionData.success}</div>}
      {!data.configValid && <div className="b-banner b-banner-red" role="alert">Stored configuration is invalid. {data.configError}</div>}
      {data.importedFromLegacy && (
        <div className="b-banner b-banner-orange" role="status">
          Imported {data.tiers.length} shipping tier{data.tiers.length === 1 ? "" : "s"} from the legacy
          hpn-scripts-migration app. Review them below — saving any tier persists this list here.
        </div>
      )}

      <section className="b-card b-p-5 b-mb-5">
        <div className="b-row b-justify-between b-gap-4">
          <div>
            <h2 className="b-form-title">Skio connection</h2>
            <p className="b-form-desc">The private key is encrypted and never returned to the browser.</p>
          </div>
          <span className={`b-status-pill ${data.apiKeyConnected ? "b-status-pill-green" : "b-status-pill-muted"}`}>
            {data.apiKeyConnected ? "Connected" : "Not connected"}
          </span>
        </div>
        {data.apiKeyConnected ? (
          <div className="b-row b-gap-3 b-wrap b-mt-4">
            <Form method="post"><input type="hidden" name="intent" value="sync" /><button className="b-btn b-btn-primary" type="submit">Sync now</button></Form>
            <Form method="post" onSubmit={(event: FormEvent<HTMLFormElement>) => { if (!window.confirm("Disconnect Skio? Existing delivery overrides remain in Skio.")) event.preventDefault(); }}>
              <input type="hidden" name="intent" value="disconnect" /><button className="b-btn b-btn-secondary" type="submit">Disconnect</button>
            </Form>
          </div>
        ) : (
          <Form method="post" className="b-row b-gap-3 b-mt-4">
            <input type="hidden" name="intent" value="connect" />
            <label className="b-sr-only" htmlFor="skioApiKey">Skio API key</label>
            <input id="skioApiKey" name="apiKey" type="password" className="b-input" required autoComplete="off" placeholder="Skio private API key" />
            <button className="b-btn b-btn-primary" type="submit">Connect Skio</button>
          </Form>
        )}
      </section>

      <SkioShippingManager tiers={data.tiers} disabled={!data.configValid} />
    </div>
  );
}
