/**
 * Dispatches promo engine events to connected third-party integrations.
 * Reads integration configs from appSettings and fires async webhook/API calls.
 * Failures are logged but never throw — they must not block the webhook response.
 */

import { eq, like } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";

interface PromoEvent {
  event: "order_paid" | "gift_added" | "offer_redeemed";
  shopDomain: string;
  orderId?: string;
  offerIds?: string[];
  totalPriceCents?: number;
  sessionId?: string | null;
  timestamp: string;
}

interface IntegrationConfig {
  id: string;
  apiKey: string;
}

export async function dispatchIntegrationEvents(
  shopId: string,
  db: Db,
  event: PromoEvent,
): Promise<void> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.shopId, shopId));

  const configs = new Map<string, string>();
  for (const row of rows) {
    if (row.key.startsWith("integration.") && row.key.endsWith(".api_key")) {
      const id = row.key.split(".")[1];
      if (id) configs.set(id, row.value);
    }
  }

  if (configs.size === 0) return;

  await Promise.allSettled([
    configs.has("klaviyo") ? dispatchKlaviyo(configs.get("klaviyo")!, event) : null,
    configs.has("omnisend") ? dispatchWebhook("omnisend", configs.get("omnisend")!, event) : null,
    configs.has("attentive") ? dispatchWebhook("attentive", configs.get("attentive")!, event) : null,
    configs.has("rebuy") ? dispatchWebhook("rebuy", configs.get("rebuy")!, event) : null,
    configs.has("gorgias") ? dispatchWebhook("gorgias", configs.get("gorgias")!, event) : null,
    configs.has("postscript") ? dispatchWebhook("postscript", configs.get("postscript")!, event) : null,
  ].filter(Boolean).map((p) =>
    Promise.resolve(p).catch((err) =>
      console.error("[integration-dispatcher] dispatch failed", err instanceof Error ? err.message : err),
    ),
  ));
}

async function dispatchKlaviyo(apiKey: string, event: PromoEvent): Promise<void> {
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
        properties: {
          offer_ids: event.offerIds ?? [],
          total_price_cents: event.totalPriceCents ?? 0,
          session_id: event.sessionId ?? null,
          order_id: event.orderId ?? null,
        },
        time: event.timestamp,
        value: event.totalPriceCents ? event.totalPriceCents / 100 : undefined,
      },
    },
  };

  const res = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      "Authorization": `Klaviyo-API-Key ${apiKey}`,
      "Content-Type": "application/json",
      "revision": "2024-02-15",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Klaviyo API error ${res.status}`);
  }
}

async function dispatchWebhook(
  id: string,
  webhookUrl: string,
  event: PromoEvent,
): Promise<void> {
  // Generic webhook dispatch for integrations that accept a webhook URL
  if (!webhookUrl.startsWith("https://")) {
    throw new Error(`[${id}] invalid webhook URL`);
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Promo-Engine-Event": event.event,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`[${id}] webhook returned ${res.status}`);
  }
}

function humanize(event: string): string {
  return event.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function validateKlaviyoApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://a.klaviyo.com/api/accounts/", {
      headers: {
        "Authorization": `Klaviyo-API-Key ${apiKey}`,
        "revision": "2024-02-15",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 403) return { ok: true }; // 403 = valid key, insufficient scope
    if (res.status === 401) return { ok: false, error: "Invalid API key" };
    return { ok: false, error: `Klaviyo returned ${res.status}` };
  } catch {
    return { ok: false, error: "Could not reach Klaviyo API" };
  }
}
