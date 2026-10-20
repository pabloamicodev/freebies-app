/**
 * Mounts storefront widgets the way the theme-extension blocks render them.
 * The hpn-test-store theme has no promo blocks placed in its templates and the
 * app has no write_themes scope, so specs create the same custom elements the
 * block liquid would and drive them through the real evaluation endpoint.
 */

import type { Page, Response } from "@playwright/test";

export type Evaluation = {
  qualifiedOffers: Array<{ offerId: string; type: string; qualified: boolean }>;
  progressBars: Array<{
    offerId: string;
    targetCents: number;
    targetQuantity: number | null;
    progressPercent: number;
    messageBeforeGoal: string;
    isGoalReached: boolean;
  }>;
  giftSlider: { offerId?: string } | null;
};

const EVALUATE_ATTEMPTS = 4;
const EVALUATE_PATH = "/apps/promo-engine/evaluate";

/**
 * Runs a real evaluation; the runtime also applies its cart actions and notifies mounted widgets.
 * PromoEngine.evaluate() resolves null when a newer evaluation aborted it (the cart mutation just
 * made schedules one), on HTTP 429/503 (it re-schedules itself) and on any endpoint error, so retry
 * a bounded number of times, fall back to the runtime's last result, and name the HTTP reason if
 * it never produces one.
 */
export async function evaluateNow(page: Page): Promise<Evaluation> {
  const replies: string[] = [];
  const onResponse = async (response: Response) => {
    if (!response.url().includes(EVALUATE_PATH)) return;
    const body = response.ok() ? "" : ` ${(await response.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ")}`;
    replies.push(`HTTP ${response.status()}${body}`);
  };
  page.on("response", onResponse);
  try {
    for (let attempt = 1; attempt <= EVALUATE_ATTEMPTS; attempt++) {
      await page.waitForFunction(() => typeof (window as { PromoEngine?: unknown }).PromoEngine !== "undefined", undefined, {
        timeout: 15_000,
      });
      const result = await page.evaluate(async () => {
        const api = (
          window as unknown as { PromoEngine: { evaluate: () => Promise<unknown>; lastResult: () => unknown } }
        ).PromoEngine;
        return (await api.evaluate()) ?? api.lastResult();
      });
      if (result) return result as Evaluation;
      await page.waitForTimeout(2_000 * attempt);
    }
  } finally {
    page.off("response", onResponse);
  }
  const reason =
    replies.length > 0
      ? replies.slice(-3).join("; ")
      : "no request reached the evaluate endpoint (runtime not initialised, cart fetch failed or evaluation aborted)";
  throw new Error(
    `PromoEngine.evaluate() returned no result after ${EVALUATE_ATTEMPTS} attempts on ${page.url()}. Evaluate endpoint replies: ${reason}.`,
  );
}

export async function mountWidget(
  page: Page,
  tag: string,
  attributes: Record<string, string>,
): Promise<void> {
  await page.evaluate(
    ({ tag, attributes }) => {
      document.querySelectorAll(tag).forEach((node) => node.remove());
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      document.body.appendChild(element);
    },
    { tag, attributes },
  );
}

/** Same bootstrap as blocks/bundle_builder.liquid. */
export async function mountBundleBuilder(page: Page, offerId: string): Promise<void> {
  await page.evaluate(async (offerId) => {
    document.querySelectorAll("[id^='pe-bundle-builder-']").forEach((node) => node.remove());
    const container = document.createElement("div");
    container.id = `pe-bundle-builder-e2e`;
    container.dataset["offerId"] = offerId;
    document.body.appendChild(container);
    const params = new URLSearchParams({ page_url: window.location.href, offer_id: offerId });
    const response = await fetch(`/apps/promo-engine/bundle?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`bundle endpoint answered HTTP ${response.status}`);
    const result = (await response.json()) as { bundleBuilder?: unknown };
    if (!result.bundleBuilder) throw new Error("bundle endpoint returned no bundleBuilder: the bundle offer is not live");
    const init = (window as unknown as { initBundleBuilder: (el: HTMLElement, cfg: unknown, session: string) => void })
      .initBundleBuilder;
    init(container, result.bundleBuilder, sessionStorage.getItem("promo_engine_session_id") || "e2e");
  }, offerId);
}
