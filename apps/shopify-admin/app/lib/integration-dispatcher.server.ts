/**
 * Dispatches promo engine events to connected third-party integrations.
 * Reads encrypted integration configs and delivers webhook/API calls. Transient
 * failures propagate so Shopify retries the source webhook; destinations receive
 * a stable delivery id so those retries can be deduplicated.
 */

import type { Db } from "@promo/db";
import { getIntegrationCredentials } from "./integration-credentials.server.js";
import { postJsonToSafeWebhook } from "./safe-webhook-url.server.js";

interface PromoEvent {
  event: "order_paid" | "gift_added" | "offer_redeemed";
  shopDomain: string;
  orderId?: string;
  offerIds?: string[];
  totalPriceCents?: number;
  sessionId?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  timestamp: string;
}

export class TransientIntegrationError extends Error {
  readonly transient = true;
}

export class PermanentIntegrationError extends Error {}

export async function dispatchIntegrationEvents(
  shopId: string,
  db: Db,
  event: PromoEvent,
): Promise<void> {
  const configs = await getIntegrationCredentials(db, shopId);

  if (configs.size === 0) return;

  const requests = [
    configs.has("klaviyo") ? dispatchKlaviyo(configs.get("klaviyo")!, event) : null,
    configs.has("omnisend") ? dispatchWebhook("omnisend", configs.get("omnisend")!, event) : null,
    configs.has("attentive") ? dispatchWebhook("attentive", configs.get("attentive")!, event) : null,
    configs.has("rebuy") ? dispatchWebhook("rebuy", configs.get("rebuy")!, event) : null,
    configs.has("gorgias") ? dispatchWebhook("gorgias", configs.get("gorgias")!, event) : null,
    configs.has("postscript") ? dispatchWebhook("postscript", configs.get("postscript")!, event) : null,
  ].filter((request): request is Promise<void> => request !== null);
  const results = await Promise.allSettled(requests);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  const failure = classifyIntegrationFailures(failures);
  if (failure) throw failure;
}

export function classifyIntegrationFailures(failures: unknown[]): Error | null {
  if (failures.length === 0) return null;
  const transient = failures.find((error) => error instanceof TransientIntegrationError);
  if (transient instanceof Error) return transient;
  const first = failures[0];
  return first instanceof PermanentIntegrationError
    ? first
    : new TransientIntegrationError(first instanceof Error ? first.message : "Integration dispatch failed");
}

async function dispatchKlaviyo(apiKey: string, event: PromoEvent): Promise<void> {
  const profile = event.customerEmail
    ? { email: event.customerEmail }
    : event.customerPhone
      ? { phone_number: event.customerPhone }
      : event.customerId
        ? { external_id: event.customerId }
        : null;

  if (!profile) {
    console.warn("[integration-dispatcher] skipped Klaviyo event without a customer identifier", {
      event: event.event,
      shop: event.shopDomain,
      orderId: event.orderId,
    });
    return;
  }

  const body = {
    data: {
      type: "event",
      attributes: {
        metric: {
          data: {
            type: "metric",
            attributes: { name: `Promo Engine: ${humanize(event.event)}` },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: profile,
          },
        },
        properties: {
          offer_ids: event.offerIds ?? [],
          total_price_cents: event.totalPriceCents ?? 0,
          session_id: event.sessionId ?? null,
          order_id: event.orderId ?? null,
        },
        time: event.timestamp,
        unique_id: deliveryId(event),
        value: event.totalPriceCents ? event.totalPriceCents / 100 : undefined,
      },
    },
  };

  const res = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      "Authorization": `Klaviyo-API-Key ${apiKey}`,
      "Content-Type": "application/json",
      "revision": "2026-07-15",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new TransientIntegrationError(`Klaviyo API temporarily returned ${res.status}`);
    }
    throw new PermanentIntegrationError(`Klaviyo API rejected the event with ${res.status}`);
  }
}

async function dispatchWebhook(
  id: string,
  webhookUrl: string,
  event: PromoEvent,
): Promise<void> {
  const res = await postJsonToSafeWebhook(webhookUrl, {
    headers: {
      "X-Promo-Engine-Event": event.event,
      "X-Promo-Engine-Delivery-Id": deliveryId(event),
    },
    body: JSON.stringify(event),
    timeoutMs: 5000,
  });

  if (res.status < 200 || res.status >= 300) {
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new TransientIntegrationError(`[${id}] webhook temporarily returned ${res.status}`);
    }
    throw new PermanentIntegrationError(`[${id}] webhook rejected the event with ${res.status}`);
  }
}

function deliveryId(event: PromoEvent): string {
  return [
    "promo-engine",
    event.shopDomain,
    event.event,
    event.orderId ?? event.sessionId ?? event.timestamp,
  ].join(":").slice(0, 255);
}

function humanize(event: string): string {
  return event.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function validateKlaviyoApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://a.klaviyo.com/api/accounts/", {
      headers: {
        "Authorization": `Klaviyo-API-Key ${apiKey}`,
        "revision": "2026-07-15",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 403) return { ok: false, error: "API key needs permission to read accounts" };
    if (res.status === 401) return { ok: false, error: "Invalid API key" };
    return { ok: false, error: `Klaviyo returned ${res.status}` };
  } catch {
    return { ok: false, error: "Could not reach Klaviyo API" };
  }
}
