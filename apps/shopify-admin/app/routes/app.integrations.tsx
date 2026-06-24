import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { getShopContext } from "../lib/shop-context.server.js";
import { appSettings } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { validateKlaviyoApiKey } from "../lib/integration-dispatcher.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const INTEGRATIONS = [
  {
    id: "klaviyo",
    name: "Klaviyo",
    initial: "K",
    color: "#7c3aed",
    description: "Send gift and order events to Klaviyo flows and segments.",
    fieldLabel: "Private API Key",
    fieldPlaceholder: "pk_xxxxxxxxxxxxxxxxxxxxxxxx",
    helpText: "Klaviyo → Settings → API Keys",
    validates: true,
  },
  {
    id: "omnisend",
    name: "Omnisend",
    initial: "O",
    color: "#16a34a",
    description: "Trigger Omnisend automations on gift events via webhook.",
    fieldLabel: "Webhook URL",
    fieldPlaceholder: "https://hooks.omnisend.com/...",
    helpText: "Omnisend → Automation → Webhooks",
    validates: false,
  },
  {
    id: "attentive",
    name: "Attentive",
    initial: "A",
    color: "#ea580c",
    description: "Send gift event notifications to Attentive SMS flows.",
    fieldLabel: "Webhook URL",
    fieldPlaceholder: "https://hooks.attentivemobile.com/...",
    helpText: "Attentive → Developer → Webhooks",
    validates: false,
  },
  {
    id: "rebuy",
    name: "Rebuy",
    initial: "R",
    color: "#2c6ecb",
    description: "Post promo events to a Rebuy webhook endpoint.",
    fieldLabel: "Webhook URL",
    fieldPlaceholder: "https://...",
    helpText: "Your Rebuy custom webhook URL",
    validates: false,
  },
  {
    id: "gorgias",
    name: "Gorgias",
    initial: "G",
    color: "#dc2626",
    description: "Forward offer events to Gorgias for support ticket context.",
    fieldLabel: "Webhook URL",
    fieldPlaceholder: "https://...",
    helpText: "Your Gorgias webhook URL",
    validates: false,
  },
  {
    id: "postscript",
    name: "Postscript",
    initial: "P",
    color: "#4f46e5",
    description: "Send gift events to Postscript SMS flows.",
    fieldLabel: "Webhook URL",
    fieldPlaceholder: "https://...",
    helpText: "Your Postscript webhook URL",
    validates: false,
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const settingRows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.shopId, shopId));

  const connected: Record<string, string> = {};
  for (const row of settingRows) {
    if (row.key.startsWith("integration.") && row.key.endsWith(".api_key")) {
      const id = row.key.split(".")[1];
      if (id) connected[id] = row.value;
    }
  }
  return { connected };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "disconnect") {
    const integrationId = formData.get("integrationId") as string;
    if (!integrationId) return { error: "Missing integrationId" };
    await db
      .delete(appSettings)
      .where(
        and(
          eq(appSettings.shopId, shopId),
          eq(appSettings.key, `integration.${integrationId}.api_key`),
        ),
      );
    return { ok: true, integrationId };
  }

  if (intent === "connect") {
    const integrationId = formData.get("integrationId") as string;
    const apiKey = (formData.get("apiKey") as string)?.trim();
    if (!integrationId || !apiKey) return { error: "API key / webhook URL is required" };

    const integration = INTEGRATIONS.find((i) => i.id === integrationId);
    if (!integration) return { error: "Unknown integration" };

    if (integrationId === "klaviyo" && integration.validates) {
      const validation = await validateKlaviyoApiKey(apiKey);
      if (!validation.ok) return { error: validation.error ?? "Invalid API key" };
    }

    if (!integration.validates && !apiKey.startsWith("https://")) {
      return { error: "Webhook URL must start with https://" };
    }

    await db
      .insert(appSettings)
      .values({ shopId, key: `integration.${integrationId}.api_key`, value: apiKey })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: apiKey, updatedAt: new Date() },
      });
    return { ok: true, integrationId };
  }

  return { error: "Unknown intent" };
};

export default function IntegrationsPage() {
  const { connected } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [modal, setModal] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const isBusy = fetcher.state !== "idle";
  const actionResult = fetcher.data;

  const connectedMap: Record<string, boolean> = Object.fromEntries(
    Object.keys(connected).map((id) => [id, true]),
  );
  if (actionResult && "ok" in actionResult && actionResult.integrationId) {
    const intId = actionResult.integrationId;
    const lastIntent = fetcher.formData?.get("intent");
    if (lastIntent === "connect") connectedMap[intId] = true;
    if (lastIntent === "disconnect") delete connectedMap[intId];
  }

  const openModal = (id: string) => { setModal(id); setApiKeyInput(""); };
  const closeModal = () => { setModal(null); setApiKeyInput(""); };

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modal || !apiKeyInput.trim()) return;
    fetcher.submit(
      { intent: "connect", integrationId: modal, apiKey: apiKeyInput.trim() },
      { method: "post" },
    );
    closeModal();
  };

  const activeModal = INTEGRATIONS.find((i) => i.id === modal);

  return (
    <div className="b-page" style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: "700", color: "#1a1a1a", margin: "0 0 4px 0" }}>
          Integrations
        </h1>
        <p style={{ margin: 0, fontSize: "14px", color: "#6b7280" }}>
          Connect your marketing tools to receive promo events automatically.
        </p>
      </div>

      {actionResult && "error" in actionResult && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 16,
            color: "#dc2626",
            fontSize: 14,
          }}
        >
          {actionResult.error}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", marginBottom: "28px" }}>
        {INTEGRATIONS.map((integration) => {
          const isConnected = !!connectedMap[integration.id];
          return (
            <div
              key={integration.id}
              className="b-card b-card-body"
              style={{ minWidth: 260, flex: "1 1 260px" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div
                  style={{
                    backgroundColor: integration.color,
                    color: "#fff",
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 15,
                    flexShrink: 0,
                  }}
                >
                  {integration.initial}
                </div>
                <span style={{ fontWeight: "700", fontSize: "15px", color: "#1a1a1a" }}>
                  {integration.name}
                </span>
              </div>
              <p
                style={{
                  margin: "8px 0 12px",
                  fontSize: "13px",
                  color: "#6b7280",
                  lineHeight: "1.5",
                  flexGrow: 1,
                }}
              >
                {integration.description}
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    backgroundColor: isConnected ? "#dcfce7" : "#f3f4f6",
                    color: isConnected ? "#16a34a" : "#6b7280",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: isConnected ? "#16a34a" : "#9ca3af",
                      display: "inline-block",
                    }}
                  />
                  {isConnected ? "Connected" : "Not connected"}
                </span>
                {isConnected ? (
                  <button
                    type="button"
                    onClick={() =>
                      fetcher.submit(
                        { intent: "disconnect", integrationId: integration.id },
                        { method: "post" },
                      )
                    }
                    disabled={isBusy}
                    style={{
                      fontSize: 13,
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      cursor: "pointer",
                      color: "#374151",
                    }}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openModal(integration.id)}
                    disabled={isBusy}
                    style={{
                      fontSize: 13,
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: "#111827",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {modal && activeModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={closeModal}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 28,
              width: 420,
              maxWidth: "90vw",
              boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  backgroundColor: activeModal.color,
                  color: "#fff",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 15,
                  flexShrink: 0,
                }}
              >
                {activeModal.initial}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Connect {activeModal.name}</div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>{activeModal.description}</div>
              </div>
            </div>
            <form onSubmit={handleConnect}>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  marginBottom: 6,
                  color: "#374151",
                }}
              >
                {activeModal.fieldLabel}
              </label>
              <input
                type={activeModal.validates ? "password" : "text"}
                placeholder={activeModal.fieldPlaceholder}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                required
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  marginBottom: 6,
                }}
              />
              <p style={{ margin: "0 0 16px", fontSize: 12, color: "#9ca3af" }}>
                {activeModal.helpText}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={closeModal}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 6,
                    border: "1px solid #e5e7eb",
                    background: "#fff",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "#374151",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!apiKeyInput.trim()}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 6,
                    border: "none",
                    background: "#111827",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    opacity: !apiKeyInput.trim() ? 0.5 : 1,
                  }}
                >
                  {activeModal.validates ? "Validate & Save" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
