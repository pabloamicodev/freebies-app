/**
 * Capacity-incident canary on hpn-test-store ONLY (hard refusal otherwise), driving main's real code paths:
 *   seed     snapshot, pause the other active offers, create a draft "[CAP71 E2E] gift picker" with 150 gift options
 *   block    validateActivationWithPreflight on it: expect a block + an open incident holding that offer
 *   propose  list the incident's proposals
 *   apply    applyWorkaround(reduce_gift_options, confirm)
 *   undo     undoWorkaround on the latest applied action
 *   state    offer / incident / action / shard / live-metafield summary
 *   marker   write the E2E fixture marker (gift variant that survived the top-N cut)
 *   native   create "[CAP71 E2E] native" automatic discount, deactivate + reactivate it, then the same on an active other-app discount
 *   cleanup  archive CAP71 offers, delete the native discount, restore paused offers, republish, dismiss incidents
 * Run: pnpm tsx scripts/seed-cap71-e2e.ts <cmd> --env <path to .env>
 */
import { resolve } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import process from "node:process";

const DEV_SHOP = "hpn-test-store.myshopify.com";
const PREFIX = "[CAP71 E2E] ";
const SNAP = "cap71_e2e.snapshot";
const MARKER = resolve("apps/shopify-admin/tests/e2e/fixtures/cap71-seed.json");
const KEEP = new Set(["E2E Gift Offer", "[Ambrosia E2E] cart-subtotal-free-gift-mtrcmr6l", "E2E Volume Discount", "E2E Classic Bundle"]);
const args = process.argv.slice(2);
const cmd = args[0] ?? "state";
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (l: string) => process.stdout.write(`${l}\n`);
for (const f of [flag("--env"), ".env", ".env.local"]) if (f && existsSync(resolve(f))) process.loadEnvFile(resolve(f));

async function main(): Promise<void> {
  const [{ and, eq, like, inArray, desc, ne }, dbm, { shopifyGraphQL }, { decryptToken }, flow, apply, wk, manifestMod, src] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
    import("../apps/shopify-admin/app/lib/token-crypto.server.js"),
    import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js"),
    import("../apps/shopify-admin/app/lib/capacity-apply.server.js"),
    import("../apps/shopify-admin/app/lib/capacity-workarounds.server.js"),
    import("../apps/shopify-admin/app/lib/publish-manifest.server.js"),
    import("../apps/shopify-admin/app/lib/capacity-source.server.js"),
  ]);
  const { getDb, closeDb, shops, shopifySessions, offers, offerConditions, offerRewards, offerCombinationPolicies, appSettings, discountShards, capacityIncidents, capacityActions, variantCache } = dbm;
  const db = getDb();
  try {
    const [shop] = await db.select().from(shops).where(eq(shops.myshopifyDomain, DEV_SHOP)).limit(1);
    if (!shop || shop.myshopifyDomain !== DEV_SHOP) throw new Error("Refusing: not the dev store.");
    const [session] = await db.select({ t: shopifySessions.accessToken }).from(shopifySessions).where(and(eq(shopifySessions.shop, DEV_SHOP), eq(shopifySessions.isOnline, false))).limit(1);
    const token = await decryptToken(session!.t!);
    const admin = <T>(query: string, variables: Record<string, unknown> = {}) => shopifyGraphQL<T>({ shopDomain: DEV_SHOP, accessToken: token, query, variables });
    const ref = { id: shop.id, domain: DEV_SHOP };
    const setting = async (k: string) => (await db.select({ v: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, k))))[0]?.v ?? null;
    const put = (k: string, v: string) =>
      db.insert(appSettings).values({ shopId: shop.id, key: k, value: v }).onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value: v, updatedAt: new Date() } });
    const shards = async () =>
      (await db.select().from(discountShards).where(eq(discountShards.shopId, shop.id))).sort((a, b) => a.slot - b.slot).map((s) => ({ slot: s.slot, node: s.discountNodeId, units: s.unitKeys.length, bytes: s.configBytes }));
    const giftOffer = async () => (await db.select().from(offers).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}gift%`), ne(offers.status, "archived"))))[0];
    const rewardOf = async (id: string) => (await db.select().from(offerRewards).where(eq(offerRewards.offerId, id)))[0]!;
    const incidents = () => db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shop.id)).orderBy(desc(capacityIncidents.lastSeenAt));
    const publish = async () => {
      const e = await flow.publishShopConfig(shop.id, DEV_SHOP);
      if (e) throw new Error(`publish: ${e}`);
    };

    const summary = async () => {
      const o = await giftOffer();
      if (o) out(`offer ${o.id} status=${o.status} giftVariants=${((await rewardOf(o.id)).target as { variantIds: string[] }).variantIds.length}`);
      for (const i of await incidents()) out(`incident ${i.id} code=${i.code} status=${i.status} resolution=${i.resolution} occ=${i.occurrences} source=${i.source}`);
      for (const a of await db.select().from(capacityActions).where(eq(capacityActions.shopId, shop.id)).orderBy(desc(capacityActions.createdAt))) out(`action ${a.id} kind=${a.kind} status=${a.status} err=${a.error ?? ""}`);
      out(`shards ${JSON.stringify(await shards())}`);
      const mf = await manifestMod.readPublishManifest(shop.id, db);
      out(`manifest nodes ${Object.keys(mf?.nodes ?? {}).length}`);
      const ids = [shop.discountId!, ...(await shards()).filter((s) => s.slot > 0).map((s) => s.node!)];
      for (const id of ids) {
        const r = await admin<{ node: { metafield: { value: string } | null } | null }>(`query($id: ID!) { node(id: $id) { ... on DiscountAutomaticNode { metafield(namespace: "promo_engine", key: "function_config") { value } } } }`, { id });
        const cfg = JSON.parse(r.node?.metafield?.value ?? "{}") as { offers?: Array<Record<string, unknown>> };
        for (const o of cfg.offers ?? []) {
          if (!String(o["title"] ?? "").startsWith(PREFIX)) continue;
          const g = o["giftVariantIds"];
          out(`live node ${id.split("/").pop()} "${o["title"]}" giftVariantIds=${Array.isArray(g) ? `array(${g.length})` : `${typeof g} commas=${String(g).split(",").length - 1}`}`);
        }
      }
    };

    if (cmd === "seed") {
      if (await setting(SNAP)) throw new Error("snapshot exists: cleanup first");
      await db.delete(offers).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`), eq(offers.status, "archived")));
      const active = await db.select({ id: offers.id, name: offers.internalName, status: offers.status }).from(offers).where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")));
      const toPause = active.filter((o) => !KEEP.has(o.name));
      await put(SNAP, JSON.stringify({ at: new Date().toISOString(), paused: toPause, shards: await shards(), compact: await setting("function_compact_ids.enabled") }));
      if (toPause.length) await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), inArray(offers.id, toPause.map((o) => o.id))));
      const anchorHandle = "30-days-to-better-energy-ebook";
      const a = await admin<{ products: { nodes: Array<{ id: string; variants: { nodes: Array<{ id: string }> } }> } }>(
        `query($q: String!) { products(first: 1, query: $q) { nodes { id variants(first: 1) { nodes { id } } } } }`,
        { q: `handle:${anchorHandle}` },
      );
      const anchorVariant = a.products.nodes[0]!.variants.nodes[0]!.id;
      const pool = await db.select({ v: variantCache.variantGid, av: variantCache.availableForSale, inv: variantCache.inventoryQuantity }).from(variantCache).where(eq(variantCache.shopId, shop.id));
      const gifts = pool.filter((r) => r.v !== anchorVariant).sort((x, y) => Number(y.av) - Number(x.av) || (y.inv ?? 0) - (x.inv ?? 0)).slice(0, 150).map((r) => r.v);
      // The merchant's original order is deliberately the reverse of availability order, so the top-N pick is visible.
      gifts.reverse();
      const [row] = await db.insert(offers).values({ shopId: shop.id, type: "gift", status: "draft", internalName: `${PREFIX}gift picker`, publicTitle: `${PREFIX}gift picker`, description: "capacity canary", priority: 5, discountTags: ["cap71-e2e"], createdBy: "cap71", updatedBy: "cap71" }).returning({ id: offers.id });
      const id = row!.id;
      await db.insert(offerConditions).values({ shopId: shop.id, offerId: id, scope: "main", conditionType: "specific_product", operator: "all", value: { requirements: [{ variantId: anchorVariant, trackMode: "variant", minQuantity: 1 }] }, sortOrder: 0, isEnabled: true });
      await db.insert(offerRewards).values({ shopId: shop.id, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { variantIds: gifts }, quantity: 1, isAutoAdd: false, isCustomerSelectable: true, trackMode: "variant", sortOrder: 0, label: null });
      await db.insert(offerCombinationPolicies).values({ shopId: shop.id, offerId: id, combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true });
      out(`seeded draft ${id} anchor=${anchorHandle} variant=${anchorVariant} gifts=${gifts.length}; paused ${toPause.length}`);
      return;
    }

    if (cmd === "grow") {
      const o = (await giftOffer())!;
      const rw = await rewardOf(o.id);
      const anchor = (rw.target as { variantIds: string[] }).variantIds;
      const pool = await db.select({ v: variantCache.variantGid, av: variantCache.availableForSale, inv: variantCache.inventoryQuantity }).from(variantCache).where(eq(variantCache.shopId, shop.id));
      const n = Number(flag("--n") ?? 100000);
      const all = pool.filter((r) => r.v !== "gid://shopify/ProductVariant/45726993055827").sort((x, y) => Number(y.av) - Number(x.av) || (y.inv ?? 0) - (x.inv ?? 0)).slice(0, n).map((r) => r.v).reverse();
      await db.update(offerRewards).set({ target: { variantIds: all } }).where(eq(offerRewards.id, rw.id));
      await db.update(offers).set({ updatedAt: new Date() }).where(eq(offers.id, o.id));
      out(`gift options ${anchor.length} -> ${all.length}`);
      return;
    }

    if (cmd === "block") {
      const o = (await giftOffer())!;
      const res = await src.runWithCapacitySource("background", false, () => flow.validateActivationWithPreflight(db, shop.id, [o.id]));
      out(`validation: ${JSON.stringify(res.validation).slice(0, 500)}`);
      for (const i of await incidents()) out(`incident ${i.id} code=${i.code} reason=${i.reason} status=${i.status} source=${i.source} offerIds=${JSON.stringify(i.offerIds)} lastAlertedAt=${i.lastAlertedAt?.toISOString() ?? null}`);
      out(`offer status after block: ${(await giftOffer())!.status}`);
      return;
    }

    if (cmd === "propose") {
      for (const i of await incidents()) {
        const p = await wk.proposeForIncident(db, i);
        out(`incident ${i.id}: ${p.proposals.map((x) => `${x.kind}(semantic=${x.semanticChange}) params=${JSON.stringify(x.params).slice(0, 200)}`).join(" | ")} guidance=${p.guidance}`);
        for (const x of p.proposals) out(`  ${x.title}: ${x.summary} || ${x.customerChange}`);
      }
      return;
    }

    if (cmd === "apply") {
      const i = (await incidents()).find((x) => x.status === "open")!;
      const p = await wk.proposeForIncident(db, i);
      const prop = p.proposals.find((x) => x.kind === "reduce_gift_options")!;
      out(`reward variants before: ${((await rewardOf(i.offerIds[0]!)).target as { variantIds: string[] }).variantIds.length}`);
      const r = await apply.applyWorkaround(db, ref, { incidentId: i.id, kind: "reduce_gift_options", confirm: true, expectedVersions: prop.offerVersions, performedBy: "cap71-canary" });
      out(`apply result: ${JSON.stringify(r)}`);
      await summary();
      return;
    }

    if (cmd === "undo") {
      const act = (await db.select().from(capacityActions).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.status, "applied"))).orderBy(desc(capacityActions.appliedAt)))[0];
      if (!act) throw new Error("no applied action");
      out(`undo result: ${JSON.stringify(await apply.undoWorkaround(db, ref, act.id, "cap71-canary"))}`);
      await summary();
      return;
    }

    if (cmd === "state") {
      await summary();
      return;
    }

    if (cmd === "marker") {
      const o = (await giftOffer())!;
      const rw = await rewardOf(o.id);
      const variants = (rw.target as { variantIds: string[] }).variantIds;
      const cond = (await db.select().from(offerConditions).where(eq(offerConditions.offerId, o.id)))[0]!;
      const anchor = (cond.value as { requirements: Array<{ variantId: string }> }).requirements[0]!.variantId;
      const avail = new Set((await db.select({ v: variantCache.variantGid }).from(variantCache).where(and(eq(variantCache.shopId, shop.id), eq(variantCache.availableForSale, true)))).map((r) => r.v));
      const gift = variants.find((v) => avail.has(v));
      writeFileSync(MARKER, `${JSON.stringify({ offerId: o.id, rewardId: rw.id, anchorVariantId: anchor, giftVariantId: gift, giftOptions: variants.length }, null, 2)}\n`);
      out(`marker: gift=${gift} options=${variants.length}`);
      return;
    }

    if (cmd === "native") {
      const ops = await apply.discountOps(db);
      const statusOf = async (id: string) =>
        (await admin<{ discountNode: { discount: { status: string } } }>(`query($id: ID!) { discountNode(id: $id) { discount { ... on DiscountAutomaticBasic { status } ... on DiscountAutomaticApp { status } } } }`, { id })).discountNode.discount.status;
      const create = await admin<{ discountAutomaticBasicCreate: { automaticDiscountNode: { id: string } | null; userErrors: Array<{ message: string }> } }>(
        `mutation($d: DiscountAutomaticBasicInput!) { discountAutomaticBasicCreate(automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { message } } }`,
        { d: { title: `${PREFIX}native`, startsAt: new Date(Date.now() - 3_600_000).toISOString(), customerGets: { value: { percentage: 0.01 }, items: { all: true } }, combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true } } },
      );
      if (create.discountAutomaticBasicCreate.userErrors.length) throw new Error(JSON.stringify(create.discountAutomaticBasicCreate.userErrors));
      const id = create.discountAutomaticBasicCreate.automaticDiscountNode!.id;
      out(`native ${id} initial=${await statusOf(id)}`);
      const cands = await ops.list(ref);
      out(`candidates listed: ${cands.map((c) => `${c.title}[${c.type}${c.appTitle ? `/${c.appTitle}` : ""}]`).join(", ")}`);
      await ops.setActive(ref, id, false);
      out(`native after deactivate=${await statusOf(id)}`);
      await ops.setActive(ref, id, true);
      out(`native after reactivate=${await statusOf(id)}`);
      const other = cands.find((c) => c.title.includes("Experiment Engine")) ?? cands.find((c) => c.title.includes("HPN Scripts"));
      if (other) {
        const initial = await statusOf(other.id);
        out(`other-app "${other.title}" (${other.id}) initial=${initial}`);
        if (initial === "ACTIVE") {
          try {
            await ops.setActive(ref, other.id, false);
            out(`other-app after deactivate=${await statusOf(other.id)}`);
          } finally {
            await ops.setActive(ref, other.id, true);
            out(`other-app after reactivate=${await statusOf(other.id)} (initial ${initial})`);
          }
        }
      } else out("no other-app candidate listed");
      return;
    }

    if (cmd === "cleanup") {
      const snap = JSON.parse((await setting(SNAP)) ?? "null") as { paused: Array<{ id: string; status: string }>; shards: unknown; compact: string | null } | null;
      if (!snap) throw new Error("no snapshot");
      await db.update(offers).set({ status: "archived", updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`)));
      const found = await admin<{ discountNodes: { nodes: Array<{ id: string; discount: { title?: string } }> } }>(`query { discountNodes(first: 50, query: "method:automatic") { nodes { id discount { ... on DiscountAutomaticBasic { title } } } } }`);
      for (const n of found.discountNodes.nodes.filter((x) => x.discount?.title?.startsWith(PREFIX))) {
        const d = await admin<{ discountAutomaticDelete: { userErrors: Array<{ message: string }> } }>(`mutation($id: ID!) { discountAutomaticDelete(id: $id) { userErrors { message } } }`, { id: n.id });
        out(`deleted native ${n.id} errors=${JSON.stringify(d.discountAutomaticDelete.userErrors)}`);
      }
      for (const p of snap.paused) await db.update(offers).set({ status: p.status as never, updatedAt: new Date() }).where(and(eq(offers.shopId, shop.id), eq(offers.id, p.id)));
      await publish();
      const dismissed: string[] = [];
      for (const i of await incidents()) {
        if (i.status === "open") {
          await db.update(capacityIncidents).set({ status: "dismissed", dismissedAt: new Date() }).where(eq(capacityIncidents.id, i.id));
          dismissed.push(i.id);
        }
      }
      out(`dismissed open incidents ${JSON.stringify(dismissed)}`);
      out(`before shards ${JSON.stringify(snap.shards)}`);
      out(`after  shards ${JSON.stringify(await shards())}`);
      const restored = await db.select({ id: offers.id, s: offers.status }).from(offers).where(and(eq(offers.shopId, shop.id), inArray(offers.id, snap.paused.map((p) => p.id))));
      out(`restored ${snap.paused.filter((p) => restored.find((r) => r.id === p.id)?.s === p.status).length}/${snap.paused.length}; compact=${await setting("function_compact_ids.enabled")} (before ${snap.compact})`);
      await db.delete(appSettings).where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, SNAP)));
      if (existsSync(MARKER)) rmSync(MARKER);
      return;
    }
    throw new Error(`unknown command ${cmd}`);
  } finally {
    await closeDb();
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : e}\n`);
    process.exit(1);
  },
);
