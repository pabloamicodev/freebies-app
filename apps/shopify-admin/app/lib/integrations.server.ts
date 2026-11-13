import type { Db } from "@promo/db";
import { WEBHOOK_URL_ERRORS, safeErrorMessage } from "./safe-error.js";
import { validateKlaviyoApiKey } from "./integration-dispatcher.server.js";
import {
  deleteIntegrationCredential,
  isIntegrationId,
  listConnectedIntegrations,
  saveIntegrationCredential,
  type IntegrationId,
} from "./integration-credentials.server.js";
import { assertSafeWebhookUrl } from "./safe-webhook-url.server.js";

/** What the secret is: Klaviyo takes a private API key (validated live); the others a webhook URL (SSRF-checked). */
export const INTEGRATION_SECRET_KIND: Record<IntegrationId, "api_key" | "webhook_url"> = {
  klaviyo: "api_key",
  omnisend: "webhook_url",
  attentive: "webhook_url",
  rebuy: "webhook_url",
  gorgias: "webhook_url",
  postscript: "webhook_url",
};

export type IntegrationResult = { ok: true; integrationId: IntegrationId } | { ok: false; error: string };

export type IntegrationDeps = {
  validateApiKey?: typeof validateKlaviyoApiKey;
  assertSafeUrl?: (url: string) => Promise<unknown>;
};

/** Connect or rotate an integration. Same checks and messages as the Integrations page. The secret is never returned. */
export async function connectIntegration(
  db: Db,
  shopId: string,
  rawId: string,
  rawSecret: string,
  deps: IntegrationDeps = {},
): Promise<IntegrationResult> {
  const secret = rawSecret.trim();
  if (!rawId || !secret) return { ok: false, error: "API key / webhook URL is required" };
  if (!isIntegrationId(rawId)) return { ok: false, error: "Unknown integration" };

  if (INTEGRATION_SECRET_KIND[rawId] === "api_key") {
    const validation = await (deps.validateApiKey ?? validateKlaviyoApiKey)(secret);
    if (!validation.ok) return { ok: false, error: validation.error ?? "Invalid API key" };
  } else {
    try {
      await (deps.assertSafeUrl ?? assertSafeWebhookUrl)(secret);
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, "Webhook URL is invalid", WEBHOOK_URL_ERRORS) };
    }
  }

  await saveIntegrationCredential(db, shopId, rawId, secret);
  return { ok: true, integrationId: rawId };
}

export async function disconnectIntegration(db: Db, shopId: string, rawId: string): Promise<IntegrationResult> {
  if (!isIntegrationId(rawId)) return { ok: false, error: "Unknown integration" };
  await deleteIntegrationCredential(db, shopId, rawId);
  return { ok: true, integrationId: rawId };
}

export async function integrationStatus(db: Db, shopId: string): Promise<{ id: IntegrationId; secretKind: "api_key" | "webhook_url"; connected: boolean }[]> {
  const connected = new Set(await listConnectedIntegrations(db, shopId));
  return (Object.keys(INTEGRATION_SECRET_KIND) as IntegrationId[]).map((id) => ({ id, secretKind: INTEGRATION_SECRET_KIND[id], connected: connected.has(id) }));
}
