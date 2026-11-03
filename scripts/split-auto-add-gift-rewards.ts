/**
 * Splits legacy "Automatically add all gifts" rewards: one product_gift reward that is auto-add and
 * lists 2+ variants (the engine treats it as a customer picker, so nothing is auto-added and only one
 * gift is free). Becomes one reward per gift product, quantity 1: a product with one picked variant is
 * auto-added, a product with several picked variants opens the picker for that product only.
 * DRY-RUN by default (read-only); pass --apply to write and republish the affected shops.
 *
 *   tsx scripts/split-auto-add-gift-rewards.ts [shop.myshopify.com ...] [--every-shop] [--apply] [--env path/to/.env]
 */
import process from "node:process";

const out = (line: string) => process.stdout.write(`${line}\n`);
const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes("--apply");
process.loadEnvFile(flagValue("--env") ?? ".env");

async function main(): Promise<void> {
  const { getDb, shops, offers, offerRewards } = await import("@promo/db");
  const { and, eq, inArray, isNull, sql } = await import("drizzle-orm");
  const { planGiftRewards, rewardFallbackIds, rewardVariantIds } = await import(
    "../apps/shopify-admin/app/lib/gift-rewards.js"
  );
  const { loadProductOf, applyGiftRewardPlan } = await import("../apps/shopify-admin/app/lib/gift-rewards.server.js");
  const db = getDb();

  const named = args.filter((arg) => arg.endsWith(".myshopify.com"));
  if (named.length === 0 && !args.includes("--every-shop")) {
    throw new Error("usage: split-auto-add-gift-rewards.ts <shop.myshopify.com ...> | --every-shop [--apply]");
  }
  const targets = await db
    .select({ id: shops.id, domain: shops.myshopifyDomain })
    .from(shops)
    .where(
      named.length > 0
        ? and(inArray(shops.myshopifyDomain, named), isNull(shops.uninstalledAt))
        : isNull(shops.uninstalledAt),
    );

  let total = 0;
  const republish: Array<{ id: string; domain: string }> = [];
  for (const shop of targets) {
    const rows = await db
      .select({
        id: offerRewards.id,
        offerId: offerRewards.offerId,
        offerName: offers.internalName,
        offerStatus: offers.status,
        discountType: offerRewards.discountType,
        value: offerRewards.value,
        target: offerRewards.target,
        quantity: offerRewards.quantity,
        sortOrder: offerRewards.sortOrder,
        isAutoAdd: offerRewards.isAutoAdd,
      })
      .from(offerRewards)
      .innerJoin(offers, eq(offers.id, offerRewards.offerId))
      .where(
        and(
          eq(offerRewards.shopId, shop.id),
          eq(offerRewards.rewardType, "product_gift"),
          eq(offerRewards.isAutoAdd, true),
          sql`jsonb_array_length(${offerRewards.target}->'variantIds') > 1`,
        ),
      );
    if (rows.length === 0) continue;
    total += rows.length;
    out(`${shop.domain}: ${rows.length} reward(s)`);
    for (const row of rows) {
      const variantIds = rewardVariantIds(row.target);
      const productOf = await loadProductOf(db, shop.id, variantIds);
      const plan = planGiftRewards({
        existing: [{ id: row.id, target: row.target, sortOrder: row.sortOrder, isAutoAdd: row.isAutoAdd }],
        variantIds,
        productOf,
        fallbackVariantIds: rewardFallbackIds(row.target),
        autoAddAll: true,
        quantity: 1,
        discountType: row.discountType,
        value: row.value as Record<string, unknown>,
        preferredId: row.id,
        baseSortOrder: row.sortOrder,
      });
      const after = [...plan.update.map((u) => u.values), ...plan.insert]
        .map((v) => `${rewardVariantIds(v.target).length}v ${v.isAutoAdd ? "auto-add" : "picker"}`)
        .join(", ");
      const uncached = variantIds.filter((id) => !productOf.has(id)).length;
      out(
        `  offer "${row.offerName}" [${row.offerStatus}] ${row.offerId} reward ${row.id}: ${variantIds.length} variants, ` +
          `qty ${row.quantity ?? "null"} -> ${plan.update.length + plan.insert.length} rewards (${after})` +
          (uncached > 0 ? ` WARNING ${uncached} variant(s) not in variant_cache, treated as standalone gifts` : ""),
      );
      if (apply) {
        await db.transaction((tx) => applyGiftRewardPlan(tx, shop.id, row.offerId, plan));
        if (row.offerStatus === "active" && !republish.some((r) => r.id === shop.id)) {
          republish.push({ id: shop.id, domain: shop.domain });
        }
      }
    }
  }
  out(`${apply ? "APPLIED" : "DRY-RUN"}: ${total} reward(s) across ${targets.length} shop(s)`);
  if (apply && republish.length > 0) {
    const { publishShopConfig } = await import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js");
    for (const shop of republish) {
      const error = await publishShopConfig(shop.id, shop.domain);
      out(`republish ${shop.domain}: ${error ?? "ok"}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
