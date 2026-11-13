/**
 * Converts offers' percentage order_discount rewards into sitewide product_discount rewards, so checkout shows
 * the sale as a strikethrough on each line (Shopify does that only for PRODUCT-class discounts).
 *
 *   pnpm tsx scripts/convert-order-to-product-discount.ts <offerId...> [--apply] [--full]
 *
 * Dry-run by default: prints the reward rows, the conditions and the compiled config before/after (`--full` prints
 * the whole compiled offer, otherwise only the changed keys). `--apply` rewrites the rewards in one transaction
 * (offer version snapshot + audit row), republishes the shop and prints discount_shards; if the publish fails the
 * rewards are put back and the shop is republished again. Code offers convert the same way: their code node already
 * carries both PRODUCT and ORDER classes (CART_DISCOUNT_CLASSES). Needs DATABASE_URL and the Shopify app env.
 */
import process from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

for (const file of [".env", ".env.local"]) {
  if (existsSync(resolve(file))) process.loadEnvFile(resolve(file));
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const full = args.includes("--full");
const offerIds = args.filter((a) => !a.startsWith("--"));
if (args.some((a) => a.startsWith("--") && !["--apply", "--full"].includes(a)) || offerIds.length === 0) {
  console.error("usage: convert-order-to-product-discount.ts <offerId...> [--apply] [--full]");
  process.exit(2);
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const json = (value: unknown) => JSON.stringify(value);

async function main(): Promise<void> {
  const { getDb, shops, offers, offerRewards, offerConditions, offerCombinationPolicies, offerVersions, auditLogs } =
    await import("@promo/db");
  const { desc, eq, inArray, sql } = await import("drizzle-orm");
  const { compileOfferConfig } = await import("../apps/shopify-admin/app/lib/sync/compile-config.js");
  const { computeOfferVersion } = await import("../apps/shopify-admin/app/lib/offer-version.server.js");
  const { isLimitsEnforced } = await import("../apps/shopify-admin/app/lib/limits-enforced.server.js");
  const { planOrderToProductConversion } = await import("../apps/shopify-admin/app/lib/order-to-product-discount.js");
  const { publishShopConfig } = await import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js");
  const db = getDb();

  const offerRows = await db.select().from(offers).where(inArray(offers.id, offerIds));
  const missing = offerIds.filter((id) => !offerRows.some((row) => row.id === id));
  if (missing.length > 0) {
    console.error(`unknown offer id(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  interface Prepared {
    offer: (typeof offerRows)[number];
    shopDomain: string;
    conversions: Array<{ rewardId: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  }
  const prepared: Prepared[] = [];
  let refused = 0;

  for (const offer of offerRows) {
    out(`\n=== ${offer.internalName} (${offer.id}) status=${offer.status} type=${offer.type}${offer.requiredDiscountCode ? ` code=${offer.requiredDiscountCode} redemption=${offer.codeRedemption}` : ""}`);
    const [shop] = await db.select({ domain: shops.shopDomain, currency: shops.currencyCode }).from(shops).where(eq(shops.id, offer.shopId));
    const [rewards, conditions, [policy]] = await Promise.all([
      db.select().from(offerRewards).where(eq(offerRewards.offerId, offer.id)),
      db.select().from(offerConditions).where(eq(offerConditions.offerId, offer.id)),
      db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offer.id)).limit(1),
    ]);
    for (const reward of rewards) out(`reward ${reward.id}: ${reward.rewardType}/${reward.discountType} value=${json(reward.value)} target=${json(reward.target)}`);
    for (const c of conditions) out(`condition ${c.scope}/${c.conditionType} ${c.operator} enabled=${c.isEnabled} value=${json(c.value)}`);

    if (offer.status === "archived") {
      out("REFUSED: offer is archived");
      refused += 1;
      continue;
    }
    const plan = planOrderToProductConversion(rewards);
    if (!plan.ok) {
      out(`REFUSED: ${plan.reason}`);
      refused += 1;
      continue;
    }

    const limitsEnforced = await isLimitsEnforced(db, offer.shopId);
    const options = {
      shopCurrencyCode: shop!.currency,
      limitsEnforced,
      ...(offer.requiredDiscountCode && offer.codeRedemption === "checkout_code" ? { codePromo: true } : {}),
    };
    const byId = new Map(plan.conversions.map((c) => [c.rewardId, c]));
    const converted = rewards.map((reward) => {
      const change = byId.get(reward.id);
      return change ? { ...reward, ...change.after } : reward;
    });
    const beforeVersion = computeOfferVersion(offer, conditions, rewards, policy ?? null);
    const afterVersion = computeOfferVersion(offer, conditions, converted, policy ?? null);
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    try {
      before = compileOfferConfig(offer, conditions, rewards, policy ?? null, beforeVersion, options) as unknown as Record<string, unknown>;
      after = compileOfferConfig(offer, conditions, converted, policy ?? null, afterVersion, options) as unknown as Record<string, unknown>;
    } catch (error) {
      out(`REFUSED: converted offer does not compile: ${error instanceof Error ? error.message : String(error)}`);
      refused += 1;
      continue;
    }
    for (const change of plan.conversions) out(`convert ${change.rewardId}: ${json(change.before)} -> ${json(change.after)}`);
    if (full) {
      out(`compiled before: ${json(before)}`);
      out(`compiled after:  ${json(after)}`);
    } else {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => json(before[key]) !== json(after[key]));
      for (const key of keys) out(`compiled ${key}:\n  before ${json(before[key])}\n  after  ${json(after[key])}`);
    }
    prepared.push({ offer, shopDomain: shop!.domain, conversions: plan.conversions as unknown as Prepared["conversions"] });
  }

  if (!apply) {
    out(`\ndry-run: ${prepared.length} convertible, ${refused} refused. Re-run with --apply to write.`);
    process.exit(refused > 0 ? 1 : 0);
  }
  if (refused > 0) {
    console.error(`${refused} offer(s) refused; nothing written`);
    process.exit(1);
  }

  const write = async (direction: "after" | "before", action: string) => {
    await db.transaction(async (tx) => {
      for (const { offer, conversions } of prepared) {
        await tx.execute(sql`SELECT id FROM offers WHERE id = ${offer.id} FOR UPDATE`);
        for (const change of conversions) {
          const to = change[direction] as { rewardType: never; discountType: never; value: unknown; target: unknown };
          await tx
            .update(offerRewards)
            .set({ rewardType: to.rewardType, discountType: to.discountType, value: to.value, target: to.target })
            .where(eq(offerRewards.id, change.rewardId));
        }
        await tx.update(offers).set({ updatedBy: "script:convert-order-to-product" }).where(eq(offers.id, offer.id));
        const [offerSnapshot] = await tx.select().from(offers).where(eq(offers.id, offer.id));
        const rewardSnapshot = await tx.select().from(offerRewards).where(eq(offerRewards.offerId, offer.id));
        const conditionSnapshot = await tx.select().from(offerConditions).where(eq(offerConditions.offerId, offer.id));
        const [policySnapshot] = await tx.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offer.id)).limit(1);
        const [last] = await tx
          .select({ versionNumber: offerVersions.versionNumber })
          .from(offerVersions)
          .where(eq(offerVersions.offerId, offer.id))
          .orderBy(desc(offerVersions.versionNumber))
          .limit(1);
        await tx.insert(offerVersions).values({
          shopId: offer.shopId,
          offerId: offer.id,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          snapshot: { offer: offerSnapshot, conditions: conditionSnapshot, rewards: rewardSnapshot, combinationPolicy: policySnapshot ?? null },
          createdBy: "script:convert-order-to-product",
        });
        await tx.insert(auditLogs).values({
          shopId: offer.shopId,
          entityType: "offer",
          entityId: offer.id,
          action,
          before: conversions.map((c) => ({ rewardId: c.rewardId, ...(direction === "after" ? c.before : c.after) })),
          after: conversions.map((c) => ({ rewardId: c.rewardId, ...c[direction] })),
          performedBy: "script:convert-order-to-product",
        });
      }
    });
  };

  await write("after", "convert_order_to_product");
  out("\nrewards converted");

  const shopsToPublish = [...new Map(prepared.map((p) => [p.offer.shopId, p.shopDomain])).entries()];
  let failed = false;
  for (const [shopId, domain] of shopsToPublish) {
    const error = await publishShopConfig(shopId, domain);
    const res = (await db.execute(
      sql`select slot, config_bytes, jsonb_array_length(unit_keys) as units from discount_shards where shop_id = ${shopId} order by slot`,
    )) as unknown as { rows?: Array<{ slot: number; config_bytes: number; units: number }> } & Array<{ slot: number; config_bytes: number; units: number }>;
    const shards = (res.rows ?? res).map((r) => `slot${r.slot}=${r.config_bytes}B/${r.units}u`).join(" ");
    out(`${domain}: ${error ?? "ok"} | ${shards || "(no shards)"}`);
    if (error !== null) failed = true;
  }
  if (failed) {
    out("publish failed: restoring the original rewards and republishing");
    await write("before", "convert_order_to_product_rollback");
    for (const [shopId, domain] of shopsToPublish) out(`${domain}: ${(await publishShopConfig(shopId, domain)) ?? "ok"} (rolled back)`);
    process.exit(1);
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
