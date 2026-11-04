import {
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  giftCloneProducts,
  offerConditions,
  offerRewards,
  shops,
  type Db,
} from "@promo/db";
import { and, eq } from "drizzle-orm";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

export type ResourceKind = "product" | "variant" | "collection" | "gift_clone";
export type MappedResource = { from: string; to: string; kind: ResourceKind; key: string };
export type UnmatchedResource = { from: string; kind: ResourceKind; key: string | null; reason: string };
export type ResourceMapping = { mapped: MappedResource[]; unmatched: UnmatchedResource[] };
export type AdminQuery = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
export type AdminFor = (shopId: string) => Promise<AdminQuery>;

const GID_RE = /^gid:\/\/shopify\/(Product|ProductVariant|Collection)\/[^/\s]+$/;
const KIND_OF: Record<string, ResourceKind> = { Product: "product", ProductVariant: "variant", Collection: "collection" };
const BATCH = 20;
const NODES_BATCH = 50;

export const gidKind = (value: unknown): ResourceKind | null => {
  if (typeof value !== "string") return null;
  const m = GID_RE.exec(value);
  return m ? KIND_OF[m[1]!]! : null;
};

function walk(value: unknown, onGid: (gid: string) => void): void {
  if (typeof value === "string") {
    if (gidKind(value)) onGid(value);
  } else if (Array.isArray(value)) {
    for (const v of value) walk(v, onGid);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) walk(v, onGid);
  }
}

/** Every JSON column of an offer that can hold Shopify resource GIDs. */
export async function loadOfferResourceJson(db: Db, shopId: string, offerId: string): Promise<unknown[]> {
  const conditions = await db.select({ v: offerConditions.value }).from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
  const rewards = await db.select({ v: offerRewards.value, t: offerRewards.target }).from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
  const [bundle] = await db.select({ id: bundleDefinitions.id, c: bundleDefinitions.config }).from(bundleDefinitions).where(and(eq(bundleDefinitions.shopId, shopId), eq(bundleDefinitions.offerId, offerId))).limit(1);
  const out: unknown[] = [conditions.map((r) => r.v), rewards.map((r) => [r.v, r.t])];
  if (bundle) {
    const steps = await db.select({ s: bundleSteps.sourceConfig, f: bundleSteps.filterOptions, o: bundleSteps.sortOptions }).from(bundleSteps).where(and(eq(bundleSteps.shopId, shopId), eq(bundleSteps.bundleId, bundle.id)));
    const tiers = await db.select({ v: bundleTiers.value }).from(bundleTiers).where(and(eq(bundleTiers.shopId, shopId), eq(bundleTiers.bundleId, bundle.id)));
    out.push(bundle.c, steps.map((r) => [r.s, r.f, r.o]), tiers.map((r) => r.v));
  }
  return out;
}

export async function adminForShop(db: Db): Promise<AdminFor> {
  return async (shopId) => {
    const [shop] = await db.select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted }).from(shops).where(eq(shops.id, shopId)).limit(1);
    if (!shop) throw new Error("Shop not found");
    const accessToken = await decryptToken(shop.token);
    return <T>(query: string, variables: Record<string, unknown>) =>
      shopifyGraphQL<T>({ shopDomain: shop.domain, accessToken, query, variables, maxRetries: 2 });
  };
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type SourceNode =
  | null
  | { __typename: "Product" | "Collection"; handle: string }
  | { __typename: "ProductVariant"; sku: string | null; selectedOptions: { name: string; value: string }[]; product: { handle: string } };

const SOURCE_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Product { handle } ... on Collection { handle } ... on ProductVariant { sku selectedOptions { name value } product { handle } } } }`;

const optionsKey = (opts: { value: string }[]) => opts.map((o) => o.value).join("/");

type SourceKey = { gid: string; kind: ResourceKind; key: string; sku?: string; handle?: string; options?: string } | { gid: string; kind: ResourceKind; missing: true };

async function resolveSource(q: AdminQuery, gids: string[]): Promise<SourceKey[]> {
  const out: SourceKey[] = [];
  for (const ids of chunk(gids, NODES_BATCH)) {
    const { nodes } = await q<{ nodes: SourceNode[] }>(SOURCE_QUERY, { ids });
    ids.forEach((gid, i) => {
      const node = nodes[i];
      const kind = gidKind(gid)!;
      if (!node) return void out.push({ gid, kind, missing: true });
      if (node.__typename === "ProductVariant") {
        const options = optionsKey(node.selectedOptions);
        const handle = node.product.handle;
        out.push(node.sku ? { gid, kind, key: `sku:${node.sku}`, sku: node.sku, handle, options } : { gid, kind, key: `${handle}#${options}`, handle, options });
      } else out.push({ gid, kind, key: node.handle, handle: node.handle });
    });
  }
  return out;
}

async function findByHandle(q: AdminQuery, field: "productByIdentifier" | "collectionByIdentifier", handles: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const batch of chunk(handles, BATCH)) {
    const decl = batch.map((_, i) => `$h${i}: String!`).join(", ");
    const body = batch.map((_, i) => `a${i}: ${field}(identifier: { handle: $h${i} }) { id }`).join(" ");
    const vars = Object.fromEntries(batch.map((h, i) => [`h${i}`, h]));
    const data = await q<Record<string, { id: string } | null>>(`query(${decl}) { ${body} }`, vars);
    batch.forEach((h, i) => {
      const id = data[`a${i}`]?.id;
      if (id) found.set(h, id);
    });
  }
  return found;
}

const searchQuote = (sku: string) => `sku:"${sku.replace(/[\\"]/g, "\\$&")}"`;

async function findBySku(q: AdminQuery, skus: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const batch of chunk(skus, BATCH)) {
    const decl = batch.map((_, i) => `$s${i}: String!`).join(", ");
    const body = batch.map((_, i) => `a${i}: productVariants(first: 2, query: $s${i}) { nodes { id sku } }`).join(" ");
    const vars = Object.fromEntries(batch.map((s, i) => [`s${i}`, searchQuote(s)]));
    const data = await q<Record<string, { nodes: { id: string; sku: string | null }[] }>>(`query(${decl}) { ${body} }`, vars);
    batch.forEach((s, i) => found.set(s, (data[`a${i}`]?.nodes ?? []).filter((n) => n.sku === s).map((n) => n.id)));
  }
  return found;
}

async function findVariantsByOptions(q: AdminQuery, wanted: { handle: string; options: string }[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const handles = [...new Set(wanted.map((w) => w.handle))];
  for (const batch of chunk(handles, 5)) {
    const decl = batch.map((_, i) => `$h${i}: String!`).join(", ");
    const body = batch.map((_, i) => `a${i}: productByIdentifier(identifier: { handle: $h${i} }) { variants(first: 100) { nodes { id selectedOptions { name value } } } }`).join(" ");
    const vars = Object.fromEntries(batch.map((h, i) => [`h${i}`, h]));
    const data = await q<Record<string, { variants: { nodes: { id: string; selectedOptions: { value: string }[] }[] } } | null>>(`query(${decl}) { ${body} }`, vars);
    batch.forEach((h, i) => {
      for (const v of data[`a${i}`]?.variants.nodes ?? []) {
        const k = `${h}#${optionsKey(v.selectedOptions)}`;
        found.set(k, [...(found.get(k) ?? []), v.id]);
      }
    });
  }
  return found;
}

/**
 * Collects every product, variant and collection GID the offer references (any JSON field) and
 * finds the same resource in the target shop: products and collections by handle, variants by SKU
 * (fallback: product handle + option values). Gift clone products are never mapped.
 */
export async function mapOfferResourcesToShop(
  db: Db,
  args: { sourceShopId: string; offerId: string; targetShopId: string; adminFor?: AdminFor },
): Promise<ResourceMapping> {
  const adminFor = args.adminFor ?? (await adminForShop(db));
  const gids = new Set<string>();
  for (const json of await loadOfferResourceJson(db, args.sourceShopId, args.offerId)) walk(json, (g) => gids.add(g));

  const clones = await db.select().from(giftCloneProducts).where(and(eq(giftCloneProducts.shopId, args.sourceShopId), eq(giftCloneProducts.offerId, args.offerId)));
  const unmatched: UnmatchedResource[] = [];
  const cloneGids = new Set<string>();
  const cloneReason = "Gift clone product belongs to the source shop and is not copied; recreate it in the target shop.";
  for (const c of clones) {
    cloneGids.add(c.cloneProductGid).add(c.cloneVariantGid);
    unmatched.push({ from: c.cloneProductGid, kind: "gift_clone", key: c.cloneHandle, reason: cloneReason });
    gids.delete(c.cloneProductGid);
    if (gids.delete(c.cloneVariantGid)) unmatched.push({ from: c.cloneVariantGid, kind: "gift_clone", key: c.cloneHandle, reason: cloneReason });
  }
  if (gids.size === 0) return { mapped: [], unmatched };

  const [sourceQ, targetQ] = [await adminFor(args.sourceShopId), await adminFor(args.targetShopId)];
  const sources = await resolveSource(sourceQ, [...gids].sort());
  const keyed = sources.filter((s): s is Extract<SourceKey, { key: string }> => "key" in s);
  for (const s of sources) if ("missing" in s) unmatched.push({ from: s.gid, kind: s.kind, key: null, reason: "Not found in the source shop (deleted?)." });

  const productHandles = [...new Set(keyed.filter((s) => s.kind === "product").map((s) => s.key))];
  const collectionHandles = [...new Set(keyed.filter((s) => s.kind === "collection").map((s) => s.key))];
  const variants = keyed.filter((s) => s.kind === "variant");
  const skus = [...new Set(variants.flatMap((s) => (s.sku ? [s.sku] : [])))];

  const products = productHandles.length ? await findByHandle(targetQ, "productByIdentifier", productHandles) : new Map<string, string>();
  const collections = collectionHandles.length ? await findByHandle(targetQ, "collectionByIdentifier", collectionHandles) : new Map<string, string>();
  const bySku = skus.length ? await findBySku(targetQ, skus) : new Map<string, string[]>();
  const needOptions = variants.filter((s) => !s.sku || (bySku.get(s.sku) ?? []).length === 0).map((s) => ({ handle: s.handle!, options: s.options! }));
  const byOptions = needOptions.length ? await findVariantsByOptions(targetQ, needOptions) : new Map<string, string[]>();

  const mapped: MappedResource[] = [];
  const hit = (s: { gid: string; kind: ResourceKind; key: string }, to: string | undefined, reason: string) =>
    to ? void mapped.push({ from: s.gid, to, kind: s.kind, key: s.key }) : void unmatched.push({ from: s.gid, kind: s.kind, key: s.key, reason });

  for (const s of keyed) {
    if (s.kind === "product") hit(s, products.get(s.key), "No product with this handle in the target shop.");
    else if (s.kind === "collection") hit(s, collections.get(s.key), "No collection with this handle in the target shop.");
    else {
      const skuHits = s.sku ? (bySku.get(s.sku) ?? []) : [];
      if (skuHits.length > 1) {
        unmatched.push({ from: s.gid, kind: s.kind, key: s.key, reason: "SKU is not unique in the target shop." });
        continue;
      }
      if (skuHits.length === 1) {
        hit(s, skuHits[0], "");
        continue;
      }
      const optionHits = byOptions.get(`${s.handle}#${s.options}`) ?? [];
      if (optionHits.length > 1) unmatched.push({ from: s.gid, kind: s.kind, key: s.key, reason: "Several variants of the target product share these option values." });
      else hit(s, optionHits[0], s.sku ? "No variant with this SKU, nor with the same product handle and options, in the target shop." : "No variant with the same product handle and options in the target shop.");
    }
  }
  const order = (a: { from: string }, b: { from: string }) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  return { mapped: mapped.sort(order), unmatched: unmatched.sort(order) };
}

const STRIP = Symbol("strip");

/** Rewrites mapped GIDs; unmatched (or unknown) GIDs are removed from arrays and objects, never carried over. */
export function applyResourceMapping<T>(value: T, mapping: ResourceMapping): T {
  const to = new Map(mapping.mapped.map((m) => [m.from, m.to]));
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") return gidKind(v) ? (to.get(v) ?? STRIP) : v;
    if (Array.isArray(v)) return v.map(rewrite).filter((x) => x !== STRIP);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]).filter(([, x]) => x !== STRIP));
    }
    return v;
  };
  const out = rewrite(value);
  return (out === STRIP ? null : out) as T;
}
