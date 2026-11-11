/**
 * mergeCandidates dev-store proof, PREPARED AND NOT RUN: pending owner OK for a Functions deploy.
 *
 * hpn-test-store runs on the promo-engine-hpn app, the same app as production HPN and TRU, so the Functions that read
 * `mergeCandidates` have to be deployed (`shopify app deploy` from apps/shopify-admin) before this proof can run, and
 * that deploy touches the production Functions. Do not run this file until the owner has said so.
 *
 *   pnpm tsx scripts/seed-merge-candidates-e2e.ts seed      [--env path]   (offers + snapshot, flag off, publish)
 *   pnpm tsx scripts/seed-merge-candidates-e2e.ts flag on|off [--env path] (sets function_config.merge_candidates, publish)
 *   pnpm tsx scripts/seed-merge-candidates-e2e.ts status    [--env path]
 *   pnpm tsx scripts/seed-merge-candidates-e2e.ts cleanup   [--env path]   (archives the offers, restores everything)
 *
 * Then, from apps/shopify-admin, once per flag state:
 *   MERGE_E2E_STATE=off pnpm exec playwright test tests/e2e/merge-candidates.spec.ts
 *   pnpm tsx ../../scripts/seed-merge-candidates-e2e.ts flag on
 *   MERGE_E2E_STATE=on  pnpm exec playwright test tests/e2e/merge-candidates.spec.ts   (also compares with the "off" run)
 *
 * Only ever touches hpn-test-store.myshopify.com (hard refusal otherwise). `seed` pauses the store's other active offers
 * (recorded in app_settings `merge_e2e.snapshot`) so the carts are not polluted; `cleanup` restores their exact status and
 * the flag's previous value. Nothing here is a production-code knob.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const DEV_SHOP = "hpn-test-store.myshopify.com";
const PREFIX = "[MERGE E2E] ";
const SNAPSHOT_KEY = "merge_e2e.snapshot";
const FLAG_KEY = "function_config.merge_candidates";
const MARKER = resolve("apps/shopify-admin/tests/e2e/fixtures/merge-candidates-seed.json");
const KEEP_ACTIVE = new Set(["E2E Gift Offer", "[Ambrosia E2E] cart-subtotal-free-gift-mtrcmr6l", "E2E Volume Discount", "E2E Classic Bundle"]);
const DENY_HANDLES = new Set(["test-product", "test-bundle-product", "test-gift-product", "test-volume-product", "the-complete-snowboard"]);
const PRODUCT_COUNT = 5;

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = (line: string) => process.stdout.write(`${line}\n`);

for (const file of [flag("--env"), ".env", ".env.local"]) {
  if (file && existsSync(resolve(file))) process.loadEnvFile(resolve(file));
}

interface Snapshot {
  takenAt: string;
  mergeFlag: string | null;
  pausedOffers: Array<{ id: string; name: string; status: string }>;
}

async function main(): Promise<void> {
  const [{ and, eq, inArray, like }, db_, { shopifyGraphQL }, { decryptToken }, { publishShopConfig }, { validateConditionValue, validateRewardPayload }] =
    await Promise.all([
      import("drizzle-orm"),
      import("@promo/db"),
      import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
      import("../apps/shopify-admin/app/lib/token-crypto.server.js"),
      import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js"),
      import("@promo/shared-types"),
    ]);
  const { getDb, closeDb, shops, shopifySessions, offers, offerConditions, offerRewards, offerCombinationPolicies, appSettings } = db_;
  const db = getDb();

  try {
    const [shop] = await db.select().from(shops).where(eq(shops.myshopifyDomain, DEV_SHOP)).limit(1);
    if (!shop || shop.myshopifyDomain !== DEV_SHOP) throw new Error(`Refusing to run: ${DEV_SHOP} not found.`);
    const [session] = await db
      .select({ accessToken: shopifySessions.accessToken })
      .from(shopifySessions)
      .where(and(eq(shopifySessions.shop, DEV_SHOP), eq(shopifySessions.isOnline, false)))
      .limit(1);
    if (!session?.accessToken) throw new Error("No offline session for the dev store.");
    const accessToken = await decryptToken(session.accessToken);
    const admin = <T>(query: string, variables: Record<string, unknown> = {}) =>
      shopifyGraphQL<T>({ shopDomain: DEV_SHOP, accessToken, query, variables });

    const setting = async (key: string) =>
      (await db.select({ value: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, key))))[0]?.value ?? null;
    const putSetting = (key: string, value: string) =>
      db.insert(appSettings).values({ shopId: shop.id, key, value }).onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value, updatedAt: new Date() },
      });
    const publish = async () => {
      const error = await publishShopConfig(shop.id, DEV_SHOP);
      if (error) throw new Error(`Publish failed: ${error}`);
    };

    if (command === "status") {
      out(`merge flag=${await setting(FLAG_KEY)} snapshot=${(await setting(SNAPSHOT_KEY)) ? "present" : "none"} marker=${existsSync(MARKER)}`);
      return;
    }

    if (command === "flag") {
      const mode = args[1];
      if (mode !== "on" && mode !== "off") throw new Error("usage: flag on|off");
      await putSetting(FLAG_KEY, String(mode === "on"));
      await publish();
      if (existsSync(MARKER)) {
        const marker = JSON.parse(readFileSync(MARKER, "utf8")) as Record<string, unknown>;
        marker["flag"] = mode;
        writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
      }
      out(`${FLAG_KEY} = ${await setting(FLAG_KEY)}`);
      return;
    }

    if (command === "seed") {
      if (await setting(SNAPSHOT_KEY)) throw new Error("A merge-candidates snapshot already exists: run `cleanup` first.");
      await db.delete(offers).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`), eq(offers.status, "archived")));

      // 1. Products: PRODUCT_COUNT purchasable catalog products, all in one price band so the cart has equal lines.
      const data = await admin<{
        products: { nodes: Array<{ id: string; handle: string; status: string; publishedAt: string | null; requiresSellingPlan: boolean; isGiftCard: boolean; variants: { nodes: Array<{ id: string; price: string; availableForSale: boolean }> } }> };
      }>(`#graphql
        query MergeCatalog { products(first: 250, query: "status:active") { nodes { id handle status publishedAt requiresSellingPlan isGiftCard variants(first: 5) { nodes { id price availableForSale } } } } }
      `);
      const usable = data.products.nodes
        .filter((p) => p.status === "ACTIVE" && p.publishedAt && !p.requiresSellingPlan && !p.isGiftCard && !DENY_HANDLES.has(p.handle))
        .flatMap((p) => {
          const v = p.variants.nodes.find((variant) => variant.availableForSale);
          return v ? [{ productId: p.id, handle: p.handle, variantId: v.id, price: Number(v.price) }] : [];
        })
        .sort((a, b) => a.price - b.price || (a.handle < b.handle ? -1 : 1));
      const products = usable.slice(0, PRODUCT_COUNT);
      if (products.length < PRODUCT_COUNT) throw new Error(`Need ${PRODUCT_COUNT} purchasable products, found ${products.length}.`);

      // 2. Snapshot, then quiet the store.
      const activeRows = await db
        .select({ id: offers.id, name: offers.internalName, status: offers.status })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")));
      const toPause = activeRows.filter((row) => !KEEP_ACTIVE.has(row.name) && !row.name.startsWith(PREFIX));
      const snapshot: Snapshot = {
        takenAt: new Date().toISOString(),
        mergeFlag: await setting(FLAG_KEY),
        pausedOffers: toPause.map((row) => ({ id: row.id, name: row.name, status: row.status })),
      };
      await putSetting(SNAPSHOT_KEY, JSON.stringify(snapshot));
      out(`snapshot: ${JSON.stringify(snapshot)}`);
      if (toPause.length > 0) {
        await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), inArray(offers.id, toPause.map((r) => r.id))));
      }
      await putSetting(FLAG_KEY, "false");

      // 3. One sitewide 15% offer over every picked product: a cart with all of them yields PRODUCT_COUNT identical
      //    adjacent candidates, which is exactly what the flag folds into one.
      const open = { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true };
      const spec = {
        name: `${PREFIX}15% on ${PRODUCT_COUNT} products`,
        conditions: [{ conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1, includeGiftValues: false } }],
        rewards: [{
          rewardType: "product_discount", discountType: "percentage", value: { amount: 15, currencyCode: "USD" },
          target: { scopeMode: "sitewide", scope: "cart", productIds: products.map((p) => p.productId), selectionLevel: "product", subscriptionMode: "any", selectionMode: "all", countRule: "all" },
        }],
      };
      for (const c of spec.conditions) {
        const v = validateConditionValue(c.conditionType as never, c.value);
        if (!v.success) throw new Error(`condition: ${v.error.message}`);
      }
      for (const r of spec.rewards) {
        const v = validateRewardPayload(r.rewardType as never, r.discountType as never, r.value, r.target);
        if (!v.success) throw new Error(`reward: ${v.error.message}`);
      }
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(offers)
          .values({
            shopId: shop.id, type: "discount", status: "active", internalName: spec.name, publicTitle: spec.name,
            description: "mergeCandidates dev-store proof fixture. Archived by scripts/seed-merge-candidates-e2e.ts cleanup.",
            priority: 100, discountTags: ["merge-e2e"], createdBy: "merge-e2e-seeder", updatedBy: "merge-e2e-seeder",
          })
          .returning({ id: offers.id });
        const offerId = row!.id;
        await tx.insert(offerConditions).values(spec.conditions.map((c, index) => ({
          shopId: shop.id, offerId, scope: "main" as const, conditionType: c.conditionType as never, operator: c.operator as never,
          value: c.value, sortOrder: index, isEnabled: true,
        })));
        await tx.insert(offerRewards).values(spec.rewards.map((r, index) => ({
          shopId: shop.id, offerId, rewardType: r.rewardType as never, discountType: r.discountType as never, value: r.value,
          target: r.target, quantity: null, isAutoAdd: false, isCustomerSelectable: false,
          trackMode: "variant" as const, sortOrder: index, label: null,
        })));
        await tx.insert(offerCombinationPolicies).values({
          shopId: shop.id, offerId,
          combinesWithOrderDiscounts: open.orderDiscounts,
          combinesWithProductDiscounts: open.productDiscounts,
          combinesWithShippingDiscounts: open.shippingDiscounts,
          combinesWithOtherAppOffers: open.productDiscounts,
        });
      });

      await publish();
      writeFileSync(
        MARKER,
        `${JSON.stringify({ shop: DEV_SHOP, seededAt: new Date().toISOString(), flag: "off", percent: 15, products }, null, 2)}\n`,
      );
      out(`marker written: ${MARKER}`);
      return;
    }

    if (command === "cleanup") {
      const raw = await setting(SNAPSHOT_KEY);
      if (!raw) throw new Error("No merge-candidates snapshot: nothing to restore.");
      const snapshot = JSON.parse(raw) as Snapshot;
      await db.update(offers).set({ status: "archived", updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`)));
      for (const row of snapshot.pausedOffers) {
        await db.update(offers).set({ status: row.status as never, updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), eq(offers.id, row.id)));
      }
      if (snapshot.mergeFlag === null) {
        await db.delete(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, FLAG_KEY)));
      } else {
        await putSetting(FLAG_KEY, snapshot.mergeFlag);
      }
      await publish();
      out(`restored ${snapshot.pausedOffers.length} offers; merge flag back to ${snapshot.mergeFlag ?? "(unset)"}`);
      await db.delete(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, SNAPSHOT_KEY)));
      if (existsSync(MARKER)) rmSync(MARKER);
      return;
    }

    throw new Error(`Unknown command ${command}. Use seed | flag on|off | status | cleanup.`);
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
