/**
 * FIX-cap-12 dev-store proof: seeds offers that force several combination groups across 3+ Shopify nodes on
 * hpn-test-store, so the Shopify-resolution cases (g)-(k) of the architect's design can be observed.
 *
 *   pnpm tsx scripts/seed-cap12-e2e.ts seed       [--env path] [--padding N]
 *   pnpm tsx scripts/seed-cap12-e2e.ts nc loosen|tighten | compact on|off   (debug helpers: flip the NC offers / compact ids, republish)
 *   pnpm tsx scripts/seed-cap12-e2e.ts status     [--env path]
 *   pnpm tsx scripts/seed-cap12-e2e.ts verify-k   [--env path]   (loosen slot 0, republish, compare Admin API vs manifest, restore)
 *   pnpm tsx scripts/seed-cap12-e2e.ts cleanup    [--env path]
 *
 * `--padding N` (default 0) adds N inert product ids to the heavy offers to force a size-driven split. Observed on
 * 2026-11-10: with N=140 no Promo Engine node holding such an offer applied any discount (see the PR), so the default
 * relies on the planner's sticky spread: nodes of the previous publish are kept, and each holds one combination group.
 *
 * Only ever touches hpn-test-store.myshopify.com (hard refusal otherwise). No production-code knobs: the split is forced
 * with function_compact_ids off plus heavy offers (many product targets), and publishing runs the branch's own publisher.
 * `seed` pauses every other active offer of the dev store (recorded in app_settings `cap12_e2e.snapshot`) so the cases
 * are not polluted by the store's QA offers; `cleanup` restores their exact status.
 */
import { resolve } from "node:path";
import { writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import process from "node:process";

const DEV_SHOP = "hpn-test-store.myshopify.com";
const PREFIX = "[CAP12 E2E] ";
const SNAPSHOT_KEY = "cap12_e2e.snapshot";
const CODE = "CAP12E2E";
const MARKER = resolve("apps/shopify-admin/tests/e2e/fixtures/cap12-seed.json");
// Offers the storefront E2E global setup probes (E2E Gift Offer + the $85 subtotal gift) or the other specs rely on.
const KEEP_ACTIVE = new Set([
  "E2E Gift Offer",
  "[Ambrosia E2E] cart-subtotal-free-gift-mtrcmr6l",
  "E2E Volume Discount",
  "E2E Classic Bundle",
]);
const DENY_HANDLES = new Set([
  "test-product",
  "test-bundle-product",
  "test-gift-product",
  "test-volume-product",
  "6-foundations-to-mens-health-ebook",
  "muscle-growth-system-ebook",
  "planta-single-serving-packet",
  "the-complete-snowboard",
  "nad3-60",
  "nad3-240-an-all-natural-nad-booster-4-month-supply",
  "planta-organic-plant-protein",
  "pa7-mediator-mtor-elevation",
  "c2-creapure",
]);

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
  compactIds: string | null;
  pausedOffers: Array<{ id: string; name: string; status: string }>;
  shardsBefore: Array<{ slot: number; nodeId: string | null; units: number; configBytes: number | null }>;
  discountId: string | null;
}

async function main(): Promise<void> {
  const [
    { and, eq, inArray, like, ne, sql },
    db_,
    { shopifyGraphQL },
    { decryptToken },
    { publishShopConfig },
    { setFunctionCompactIdsEnabled, FUNCTION_COMPACT_IDS_SETTING },
    { readPublishManifest },
    { readLiveCombinations },
    { validateConditionValue, validateRewardPayload },
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
    import("../apps/shopify-admin/app/lib/token-crypto.server.js"),
    import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js"),
    import("../apps/shopify-admin/app/lib/function-compact-ids-flag.server.js"),
    import("../apps/shopify-admin/app/lib/publish-manifest.server.js"),
    import("../apps/shopify-admin/app/lib/discount-node.server.js"),
    import("@promo/shared-types"),
  ]);
  const {
    getDb, closeDb, shops, shopifySessions, offers, offerConditions, offerRewards, offerCombinationPolicies,
    appSettings, discountShards,
  } = db_;
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

    const shardShape = async () => {
      const rows = await db.select().from(discountShards).where(eq(discountShards.shopId, shop.id));
      return rows
        .sort((a, b) => a.slot - b.slot)
        .map((row) => ({ slot: row.slot, nodeId: row.discountNodeId, units: row.unitKeys.length, configBytes: row.configBytes, unitKeys: row.unitKeys }));
    };
    const publish = async () => {
      const error = await publishShopConfig(shop.id, DEV_SHOP);
      if (error) throw new Error(`Publish failed: ${error}`);
    };
    const cartNodeIds = async () => {
      const shards = await shardShape();
      return [shop.discountId!, ...shards.filter((s) => s.slot > 0 && s.nodeId).map((s) => s.nodeId!)];
    };

    const report = async (label: string) => {
      const shards = await shardShape();
      const manifest = await readPublishManifest(shop.id, db);
      const ids = await cartNodeIds();
      const live = await readLiveCombinations(DEV_SHOP, accessToken, ids);
      const names = new Map(
        (await db.select({ id: offers.id, name: offers.internalName }).from(offers).where(eq(offers.shopId, shop.id))).map((o) => [o.id, o.name]),
      );
      out(`--- ${label}`);
      const rows: Array<{ node: string; slot: number; manifest: string; live: string; match: boolean; bytes: number | null; units: string[] }> = [];
      const fmt = (p?: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean }) =>
        p ? `product=${p.productDiscounts} order=${p.orderDiscounts} shipping=${p.shippingDiscounts}` : "(none)";
      for (const id of ids) {
        const slot = id === shop.discountId ? 0 : (shards.find((s) => s.nodeId === id)?.slot ?? -1);
        const shard = shards.find((s) => s.slot === slot);
        const m = manifest?.nodes[id]?.combinesWith;
        const l = live.get(id);
        const match = !!m && !!l && fmt(m) === fmt(l);
        rows.push({ node: id, slot, manifest: fmt(m), live: fmt(l), match, bytes: shard?.configBytes ?? null, units: (shard?.unitKeys ?? []).map((k) => names.get(k.split("#")[0]!) ?? k) });
      }
      for (const r of rows.sort((a, b) => a.slot - b.slot)) {
        out(`slot ${r.slot} ${r.node} bytes=${r.bytes} manifest[${r.manifest}] shopify[${r.live}] ${r.match ? "MATCH" : "MISMATCH"}`);
        for (const u of r.units) out(`    - ${u}`);
      }
      return rows;
    };

    if (command === "status") {
      out(`compactIds=${await setting(FUNCTION_COMPACT_IDS_SETTING)} snapshot=${(await setting(SNAPSHOT_KEY)) ? "present" : "none"}`);
      await report("status");
      return;
    }

    if (command === "seed") {
      if (await setting(SNAPSHOT_KEY)) throw new Error("A cap12 snapshot already exists: run `cleanup` first.");
      const padding = Number(flag("--padding") ?? 0);
      // Archived rows of an earlier run keep their names unique-constrained; they are this script's own rows.
      await db.delete(offers).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`), eq(offers.status, "archived")));

      // 1. Pick products from the live catalog (active, published, one purchasable variant).
      const data = await admin<{
        products: { nodes: Array<{ id: string; handle: string; status: string; publishedAt: string | null; requiresSellingPlan: boolean; isGiftCard: boolean; variants: { nodes: Array<{ id: string; price: string; availableForSale: boolean }> } }> };
      }>(`#graphql
        query Cap12Catalog { products(first: 250, query: "status:active") { nodes { id handle status publishedAt requiresSellingPlan isGiftCard variants(first: 5) { nodes { id price availableForSale } } } } }
      `);
      const usable = data.products.nodes
        .filter((p) => p.status === "ACTIVE" && p.publishedAt && !p.requiresSellingPlan && !p.isGiftCard && !DENY_HANDLES.has(p.handle))
        .flatMap((p) => {
          const v = p.variants.nodes.find((variant) => variant.availableForSale);
          return v ? [{ productId: p.id, handle: p.handle, variantId: v.id, price: Number(v.price) }] : [];
        })
        .sort((a, b) => a.price - b.price || (a.handle < b.handle ? -1 : 1));
      const used = new Set<string>();
      const pick = (role: string, min: number, max: number) => {
        const found = usable.find((p) => p.price >= min && p.price <= max && !used.has(p.productId));
        if (!found) throw new Error(`No catalog product for ${role} in $${min}-$${max}.`);
        used.add(found.productId);
        return found;
      };
      const gift = pick("gift", 3, 20);
      const ncAnchor = pick("ncAnchor", 5, 60);
      const cA = pick("cA", 22, 70);
      const cB = pick("cB", 18, 70);
      const codeProduct = pick("codeProduct", 30, 200);
      const padIds = data.products.nodes
        .filter((p) => !used.has(p.id) && !DENY_HANDLES.has(p.handle))
        .map((p) => p.id)
        .sort()
        .slice(0, padding);
      // The catalog is smaller than a 600-id probe needs: top up with ids that match no product (inert by construction).
      for (let n = 0; padIds.length < padding; n++) padIds.push(`gid://shopify/Product/9900000000${String(n).padStart(3, "0")}`);

      // 2. Snapshot, then quiet the store.
      const activeRows = await db
        .select({ id: offers.id, name: offers.internalName, status: offers.status })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")));
      const toPause = activeRows.filter((row) => !KEEP_ACTIVE.has(row.name) && !row.name.startsWith(PREFIX));
      const snapshot: Snapshot = {
        takenAt: new Date().toISOString(),
        compactIds: await setting(FUNCTION_COMPACT_IDS_SETTING),
        pausedOffers: toPause.map((row) => ({ id: row.id, name: row.name, status: row.status })),
        shardsBefore: (await shardShape()).map(({ slot, nodeId, units, configBytes }) => ({ slot, nodeId, units, configBytes })),
        discountId: shop.discountId,
      };
      await putSetting(SNAPSHOT_KEY, JSON.stringify(snapshot));
      out(`snapshot: ${JSON.stringify(snapshot)}`);
      if (toPause.length > 0) {
        await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), inArray(offers.id, toPause.map((r) => r.id))));
      }
      if (!args.includes("--keep-compact")) await setFunctionCompactIdsEnabled(db, shop.id, false);

      // 3. The offers.
      const NC = { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false };
      const C = { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true };
      const pctOffer = (key: string, name: string, priority: number, productIds: string[], pct: number, policy: typeof C) => ({
        key, name, type: "discount" as const, priority, policy,
        conditions: [{ conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1, includeGiftValues: false } }],
        rewards: [{
          rewardType: "product_discount", discountType: "percentage", value: { amount: pct, currencyCode: "USD" },
          target: { scopeMode: "sitewide", scope: "cart", productIds, selectionLevel: "product", subscriptionMode: "any", selectionMode: "all", countRule: "all" },
          quantity: null, isAutoAdd: false, isCustomerSelectable: false,
        }],
      });
      const specs = [
        {
          key: "nc-gift", name: `${PREFIX}NC gift`, type: "gift" as const, priority: 10, policy: NC,
          conditions: [{ conditionType: "specific_product", operator: "all", value: { requirements: [{ variantId: ncAnchor.variantId, trackMode: "variant", minQuantity: 1 }] } }],
          rewards: [{
            rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
            target: { variantIds: [gift.variantId] }, quantity: 1, isAutoAdd: true, isCustomerSelectable: true,
          }],
        },
        ...(padIds.length > 0 ? [pctOffer("nc-filler", `${PREFIX}NC filler (inert, heavy)`, 11, padIds, 5, NC)] : []),
        pctOffer("c-a", `${PREFIX}C 20% product A`, 20, [cA.productId, ...padIds], 20, C),
        pctOffer("c-b", `${PREFIX}C 10% product B`, 21, [cB.productId, ...padIds], 10, C),
      ];
      for (const spec of specs) {
        for (const c of spec.conditions) {
          const v = validateConditionValue(c.conditionType as never, c.value);
          if (!v.success) throw new Error(`condition ${spec.key}: ${v.error.message}`);
        }
        for (const r of spec.rewards) {
          const v = validateRewardPayload(r.rewardType as never, r.discountType as never, r.value, r.target);
          if (!v.success) throw new Error(`reward ${spec.key}: ${v.error.message}`);
        }
      }
      const created: Record<string, string> = {};
      await db.transaction(async (tx) => {
        for (const spec of specs) {
          const [row] = await tx
            .insert(offers)
            .values({
              shopId: shop.id, type: spec.type, status: "active", internalName: spec.name, publicTitle: spec.name,
              description: "FIX-cap-12 dev-store proof fixture. Archived by scripts/seed-cap12-e2e.ts cleanup.",
              priority: spec.priority, discountTags: ["cap12-e2e"], createdBy: "cap12-e2e-seeder", updatedBy: "cap12-e2e-seeder",
            })
            .returning({ id: offers.id });
          const offerId = row!.id;
          created[spec.key] = offerId;
          await tx.insert(offerConditions).values(spec.conditions.map((c, index) => ({
            shopId: shop.id, offerId, scope: "main" as const, conditionType: c.conditionType as never, operator: c.operator as never,
            value: c.value, sortOrder: index, isEnabled: true,
          })));
          await tx.insert(offerRewards).values(spec.rewards.map((r, index) => ({
            shopId: shop.id, offerId, rewardType: r.rewardType as never, discountType: r.discountType as never, value: r.value,
            target: r.target, quantity: r.quantity ?? null, isAutoAdd: r.isAutoAdd, isCustomerSelectable: r.isCustomerSelectable,
            trackMode: "variant" as const, sortOrder: index, label: null,
          })));
          await tx.insert(offerCombinationPolicies).values({
            shopId: shop.id, offerId,
            combinesWithOrderDiscounts: spec.policy.orderDiscounts,
            combinesWithProductDiscounts: spec.policy.productDiscounts,
            combinesWithShippingDiscounts: spec.policy.shippingDiscounts,
            combinesWithOtherAppOffers: spec.policy.productDiscounts,
          });
        }
      });

      // 4. Native product code that combines with product discounts (cases h/i).
      const existing = await admin<{ codeDiscountNodeByCode: { id: string } | null }>(
        `query Cap12Code($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code: CODE });
      if (existing.codeDiscountNodeByCode) {
        await admin(`mutation($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }`, { id: existing.codeDiscountNodeByCode.id });
      }
      const nativeResult = await admin<{ discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
        `#graphql
        mutation Cap12CodeCreate($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message } }
        }`,
        {
          input: {
            title: `${PREFIX}native product code`, code: CODE, startsAt: new Date(Date.now() - 3_600_000).toISOString(),
            customerSelection: { all: true },
            customerGets: { value: { percentage: 0.5 }, items: { products: { productsToAdd: [codeProduct.productId] } } },
            combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true },
          },
        },
      );
      if (nativeResult.discountCodeBasicCreate.userErrors.length > 0) {
        throw new Error(`native code: ${JSON.stringify(nativeResult.discountCodeBasicCreate.userErrors)}`);
      }

      // 5. Publish with this branch's publisher and prove the split happened.
      await publish();
      const rows = await report("after seed publish");
      const policies = new Set(rows.map((r) => r.live));
      if (!args.includes("--keep-compact") && padding > 0 && (rows.length < 3 || policies.size < 2)) {
        throw new Error(`Split not forced: ${rows.length} node(s), ${policies.size} distinct combinesWith. Raise --padding.`);
      }
      writeFileSync(
        MARKER,
        `${JSON.stringify({
          shop: DEV_SHOP, seededAt: new Date().toISOString(), code: CODE,
          percent: { cA: 20, cB: 10, code: 50 },
          products: { gift, ncAnchor, cA, cB, codeProduct },
          offers: created,
          nodes: rows.map((r) => ({ slot: r.slot, node: r.node, combinesWith: r.live, units: r.units })),
        }, null, 2)}\n`,
      );
      out(`marker written: ${MARKER}`);
      return;
    }

    if (command === "lists") {
      for (const id of await cartNodeIds()) {
        const r = await admin<{ node: { metafield: { value: string } | null } | null }>(
          `query($id: ID!) { node(id: $id) { ... on DiscountAutomaticNode { metafield(namespace: "promo_engine", key: "function_config") { value } } } }`, { id });
        const config = JSON.parse(r.node?.metafield?.value ?? "{}") as { offers?: Array<Record<string, unknown>> };
        for (const offer of config.offers ?? []) {
          const rewards = (offer["productRewards"] ?? offer["pr"] ?? []) as Array<Record<string, unknown>>;
          for (const reward of rewards) {
            for (const [key, value] of Object.entries(reward)) {
              if (/ProductIds$|^tp/.test(key)) out(`${id.split("/").pop()} ${String(offer["title"] ?? offer["id"]).slice(0, 28)} ${key}: ${Array.isArray(value) ? `array(${value.length})` : `${typeof value} len=${String(value).length} commas=${String(value).split(",").length - 1}`}`);
            }
          }
        }
      }
      return;
    }

    if (command === "unfunded") {
      const mode = args[1];
      if (mode !== "on" && mode !== "off") throw new Error("usage: unfunded on|off");
      await putSetting("storefront.remove_unfunded_gifts", String(mode === "on"));
      await publish();
      if (existsSync(MARKER)) {
        const marker = JSON.parse(readFileSync(MARKER, "utf8")) as Record<string, unknown>;
        marker["unfunded"] = mode === "on";
        writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}
`);
      }
      out(`storefront.remove_unfunded_gifts = ${await setting("storefront.remove_unfunded_gifts")}`);
      return;
    }

    if (command === "compact") {
      const mode = args[1];
      if (mode !== "on" && mode !== "off") throw new Error("usage: compact on|off");
      await setFunctionCompactIdsEnabled(db, shop.id, mode === "on");
      await publish();
      await report(`compact ids ${mode}`);
      return;
    }

    if (command === "verify-k" || command === "nc") {
      const ncIds = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}NC%`), ne(offers.status, "archived")));
      const setNc = async (policy: boolean) => {
        await db
          .update(offerCombinationPolicies)
          .set({ combinesWithOrderDiscounts: policy, combinesWithProductDiscounts: policy, combinesWithShippingDiscounts: policy, combinesWithOtherAppOffers: policy, updatedAt: new Date() })
          .where(and(eq(offerCombinationPolicies.shopId, shop.id), inArray(offerCombinationPolicies.offerId, ncIds.map((o) => o.id))));
        await db.update(offers).set({ compiledConfig: null, updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), inArray(offers.id, ncIds.map((o) => o.id))));
      };
      if (command === "nc") {
        const mode = args[1];
        if (mode !== "loosen" && mode !== "tighten") throw new Error("usage: nc loosen|tighten");
        await setNc(mode === "loosen");
        await publish();
        await report(`nc ${mode}`);
        return;
      }
      const assertAll = (rows: Awaited<ReturnType<typeof report>>, label: string) => {
        const bad = rows.filter((r) => !r.match);
        out(`(k) ${label}: ${rows.length - bad.length}/${rows.length} nodes match the manifest -> ${bad.length === 0 ? "PASS" : "FAIL"}`);
        if (bad.length > 0) process.exitCode = 1;
      };
      assertAll(await report("k.1 restrictive state"), "restrictive state");
      try {
        await setNc(true);
        await publish();
        const loosened = await report("k.2 after loosening the NC offers (slot 0 loosened)");
        assertAll(loosened, "after loosening");
        const slot0 = loosened.find((r) => r.slot === 0);
        out(`(k) slot 0 live policy after loosening: ${slot0?.live}`);
      } finally {
        await setNc(false);
        await publish();
      }
      assertAll(await report("k.3 restored restrictive state"), "restored");
      return;
    }

    if (command === "cleanup") {
      const raw = await setting(SNAPSHOT_KEY);
      if (!raw) throw new Error("No cap12 snapshot: nothing to restore.");
      const snapshot = JSON.parse(raw) as Snapshot;
      out(`before cleanup shards: ${JSON.stringify((await shardShape()).map(({ unitKeys: _u, ...rest }) => rest))}`);
      await db
        .update(offers)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`)));
      const existing = await admin<{ codeDiscountNodeByCode: { id: string } | null }>(
        `query Cap12Code($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code: CODE });
      if (existing.codeDiscountNodeByCode) {
        const deleted = await admin<{ discountCodeDelete: { userErrors: Array<{ message: string }> } }>(
          `mutation($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }`, { id: existing.codeDiscountNodeByCode.id });
        if (deleted.discountCodeDelete.userErrors.length > 0) throw new Error(JSON.stringify(deleted.discountCodeDelete.userErrors));
      }
      for (const row of snapshot.pausedOffers) {
        await db.update(offers).set({ status: row.status as never, updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), eq(offers.id, row.id)));
      }
      if (snapshot.compactIds === null) {
        await db.delete(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, FUNCTION_COMPACT_IDS_SETTING)));
      } else {
        await setFunctionCompactIdsEnabled(db, shop.id, snapshot.compactIds === "true");
      }
      await publish();
      const after = await shardShape();
      out(`before seed shards: ${JSON.stringify(snapshot.shardsBefore)}`);
      out(`after cleanup shards: ${JSON.stringify(after.map(({ unitKeys: _u, ...rest }) => rest))}`);
      const rows = await report("after cleanup publish");
      const restored = await db.select({ id: offers.id, status: offers.status }).from(offers).where(and(eq(offers.shopId, shop.id), inArray(offers.id, snapshot.pausedOffers.map((r) => r.id))));
      const mismatched = snapshot.pausedOffers.filter((row) => restored.find((r) => r.id === row.id)?.status !== row.status);
      out(`restored ${snapshot.pausedOffers.length - mismatched.length}/${snapshot.pausedOffers.length} offers to their prior status`);
      const live = await db.select({ n: sql<number>`count(*)` }).from(offers).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`), ne(offers.status, "archived")));
      out(`non-archived CAP12 offers: ${live[0]?.n}; compact ids now: ${await setting(FUNCTION_COMPACT_IDS_SETTING)} (before: ${snapshot.compactIds})`);
      out(`mismatch nodes: ${rows.filter((r) => !r.match).length}`);
      const gone = await admin<{ codeDiscountNodeByCode: { id: string } | null }>(
        `query Cap12Code($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`, { code: CODE });
      out(`native code ${CODE} still exists on Shopify: ${gone.codeDiscountNodeByCode ? "YES" : "no"}`);
      const nodes = await admin<{ discountNodes: { nodes: Array<{ id: string; discount: { title?: string; status?: string } }> } }>(
        `query { discountNodes(first: 50, query: "type:app") { nodes { id discount { ... on DiscountAutomaticApp { title status } } } } }`);
      out(`automatic app nodes on Shopify: ${nodes.discountNodes.nodes.filter((n) => n.id.includes("DiscountAutomaticNode")).map((n) => `${n.discount.title}(${n.discount.status})`).join(", ")}`);
      await db.delete(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, SNAPSHOT_KEY)));
      if (existsSync(MARKER)) rmSync(MARKER);
      return;
    }

    throw new Error(`Unknown command ${command}. Use seed | status | verify-k | cleanup.`);
  } finally {
    await closeDb();
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
