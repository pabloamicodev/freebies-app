import { Form, useActionData, useLoaderData, useSubmit } from "react-router";
import { safeErrorMessage } from "../lib/safe-error.js";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { SkioShippingManager } from "../components/SkioShippingManager.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { getSkioApiKey } from "../lib/skio-credentials.server.js";
import { loadSkioShippingConfig } from "../lib/skio-shipping-config.server.js";
import { connectSkio, deleteSkioTier, disconnectSkio, saveSkioTier, syncSkio } from "../lib/subscription-admin.server.js";
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
      const result = await connectSkio(db, shopId, String(formData.get("apiKey") ?? ""));
      return result.ok ? { success: "Skio connected." } : { error: result.error };
    }

    if (intent === "disconnect") {
      await disconnectSkio(db, shopId);
      return { success: "Skio disconnected." };
    }

    if (intent === "save-tier") {
      const result = await saveSkioTier(client, JSON.parse(String(formData.get("tier") ?? "{}")) as unknown, "upsert");
      return result.ok ? { success: "Shipping tier saved." } : { error: result.error };
    }

    if (intent === "delete-tier") {
      const result = await deleteSkioTier(client, String(formData.get("tierId") ?? ""));
      return result.ok ? { success: "Shipping tier deleted." } : { error: result.error };
    }

    if (intent === "sync") {
      const result = await syncSkio(db, shopId, client);
      return result.ok
        ? { success: `Sync complete: ${result.value.updated} updated, ${result.value.evaluated} evaluated.` }
        : { error: result.error };
    }

    return { error: "Unsupported action." };
  } catch (error) {
    return { error: safeErrorMessage(error, "Skio operation failed. Check your Skio connection and try again.") };
  }
}

export default function SkioShippingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
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
            <button type="button" className="b-btn b-btn-secondary" onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
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

      <ConfirmDialog
        open={confirmDisconnect}
        ariaLabel="Disconnect Skio"
        title="Disconnect Skio?"
        message="Existing delivery overrides remain in Skio."
        confirmLabel="Disconnect"
        onConfirm={() => {
          const fd = new FormData();
          fd.append("intent", "disconnect");
          void submit(fd, { method: "post" });
          setConfirmDisconnect(false);
        }}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}
