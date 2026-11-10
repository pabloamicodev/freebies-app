import {
  appSettings,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  variantCache,
  type Db,
  type Offer,
  type OfferCombinationPolicy,
  type OfferCondition,
  type OfferReward,
} from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { selectionFromPick } from "./whole-product-selection.server.js";
import { duplicateOffer } from "./offer-duplicate.server.js";
import { partName, sliceTarget } from "./sync/slice-offer-definition.js";

type OfferStatus = Offer["status"];

/** One reversible database change. `before` is everything Undo needs to put the row back byte for byte. */
export type Edit =
  | { table: "reward"; id: string; offerId: string; before: { target: unknown }; after: { target: unknown } }
  | { table: "condition"; id: string; offerId: string; before: { operator: OfferCondition["operator"] }; after: { operator: OfferCondition["operator"] } }
  | { table: "offer"; id: string; before: { status: OfferStatus }; after: { status: OfferStatus } }
  | { table: "policy"; id: string; offerId: string; before: { combinesWithProductDiscounts: boolean }; after: { combinesWithProductDiscounts: boolean } }
  | { table: "setting"; key: string; before: { value: string | null }; after: { value: string | null } };

export interface OfferRows {
  offer: Offer;
  rewards: OfferReward[];
  conditions: OfferCondition[];
  policy: OfferCombinationPolicy | null;
}

export async function loadOfferRows(db: Db, shopId: string, offerIds: readonly string[]): Promise<Map<string, OfferRows>> {
  const result = new Map<string, OfferRows>();
  if (offerIds.length === 0) return result;
  const ids = [...offerIds];
  const [offerRows, rewards, conditions, policies] = await Promise.all([
    db.select().from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, ids))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, ids))).orderBy(offerRewards.sortOrder),
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, ids))).orderBy(offerConditions.sortOrder),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, ids))),
  ]);
  for (const offer of offerRows) {
    result.set(offer.id, {
      offer,
      rewards: rewards.filter((row) => row.offerId === offer.id),
      conditions: conditions.filter((row) => row.offerId === offer.id),
      policy: policies.find((row) => row.offerId === offer.id) ?? null,
    });
  }
  return result;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

/** Writes the `after` values (or the `before` ones to revert), every row scoped by shop. Touched offers get a new updated_at. */
export async function applyEdits(tx: Db, shopId: string, edits: readonly Edit[], direction: "apply" | "revert" = "apply"): Promise<string[]> {
  const touched = new Set<string>();
  const ordered = direction === "apply" ? edits : [...edits].reverse();
  for (const edit of ordered) {
    const values = direction === "apply" ? edit.after : edit.before;
    switch (edit.table) {
      case "reward":
        await tx.update(offerRewards).set({ target: (values as { target: unknown }).target, updatedAt: new Date() }).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.id, edit.id)));
        touched.add(edit.offerId);
        break;
      case "condition":
        await tx.update(offerConditions).set({ operator: (values as { operator: OfferCondition["operator"] }).operator, updatedAt: new Date() }).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.id, edit.id)));
        touched.add(edit.offerId);
        break;
      case "policy":
        await tx.update(offerCombinationPolicies).set({ combinesWithProductDiscounts: (values as { combinesWithProductDiscounts: boolean }).combinesWithProductDiscounts, updatedAt: new Date() }).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.id, edit.id)));
        touched.add(edit.offerId);
        break;
      case "offer": {
        const { status } = values as { status: OfferStatus };
        await tx.update(offers).set({ status, archivedAt: status === "archived" ? new Date() : null, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, edit.id)));
        touched.add(edit.id);
        break;
      }
      case "setting": {
        const { value } = values as { value: string | null };
        if (value === null) await tx.delete(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, edit.key)));
        else
          await tx
            .insert(appSettings)
            .values({ shopId, key: edit.key, value })
            .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: new Date() } });
        break;
      }
    }
  }
  const stamp = [...touched].filter((id) => !edits.some((edit) => edit.table === "offer" && edit.id === id));
  if (stamp.length > 0) await tx.update(offers).set({ updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), inArray(offers.id, stamp)));
  return [...touched];
}

export const settingEdit = async (db: Db, shopId: string, key: string, value: string): Promise<Extract<Edit, { table: "setting" }>> => {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, key)));
  return { table: "setting", key, before: { value: row?.value ?? null }, after: { value } };
};

export const pauseEdits = (rows: Iterable<OfferRows>): Edit[] =>
  [...rows].filter((row) => row.offer.status === "active").map((row) => ({ table: "offer", id: row.offer.id, before: { status: "active" }, after: { status: "paused" } }));

// ---------------------------------------------------------------------------------------------------- catalog

export interface CatalogIndex {
  ownerOf: Map<string, string>;
  allVariantsOf: Map<string, Set<string>>;
}

export async function loadCatalogIndex(db: Db, shopId: string, variantIds: readonly string[]): Promise<CatalogIndex> {
  const ownerOf = new Map<string, string>();
  const allVariantsOf = new Map<string, Set<string>>();
  const unique = [...new Set(variantIds)];
  for (let start = 0; start < unique.length; start += 1000) {
    const rows = await db
      .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, unique.slice(start, start + 1000))));
    for (const row of rows) ownerOf.set(row.variantGid, row.productGid);
  }
  const products = [...new Set(ownerOf.values())];
  for (let start = 0; start < products.length; start += 500) {
    const rows = await db
      .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.productGid, products.slice(start, start + 500))));
    for (const row of rows) {
      const set = allVariantsOf.get(row.productGid) ?? new Set<string>();
      set.add(row.variantGid);
      allVariantsOf.set(row.productGid, set);
    }
  }
  return { ownerOf, allVariantsOf };
}

// ---------------------------------------------------------------------------------------------------- planners

const PRODUCT_REWARD_TYPES = new Set(["product_discount", "bundle_discount", "upsell_discount"]);

export function productVariantIds(rows: Iterable<OfferRows>): string[] {
  return [...rows].flatMap((row) => row.rewards.filter((reward) => PRODUCT_REWARD_TYPES.has(reward.rewardType)).flatMap((reward) => strings(asRecord(reward.target)["variantIds"])));
}

/** Product rewards whose variants are ALL variants of fully selected products become product-level targets, in place. */
export function planWholeProducts(rows: OfferRows, catalog: CatalogIndex): { edits: Edit[]; unknownVariants: number } {
  const edits: Edit[] = [];
  let unknownVariants = 0;
  for (const reward of rows.rewards) {
    if (!PRODUCT_REWARD_TYPES.has(reward.rewardType)) continue;
    const target = asRecord(reward.target);
    const variants = strings(target["variantIds"]);
    if (variants.length === 0 || target["selectionLevel"] === "product") continue;
    unknownVariants += variants.filter((id) => !catalog.ownerOf.has(id)).length;
    const wholeCandidates = [...new Set(variants.map((id) => catalog.ownerOf.get(id)).filter((id): id is string => id !== undefined))];
    const picked = selectionFromPick([...strings(target["productIds"]), ...variants], wholeCandidates, catalog.ownerOf, catalog.allVariantsOf);
    if (picked.variantIds.length > 0 || picked.productIds.length === 0) continue;
    const { variantIds: _variants, ...rest } = target;
    edits.push({ table: "reward", id: reward.id, offerId: rows.offer.id, before: { target: reward.target }, after: { target: { ...rest, productIds: picked.productIds, selectionLevel: "product" } } });
  }
  return { edits, unknownVariants };
}

/** All-of "specific products" conditions with plain quantities become any-of. Returns how many items the condition lists. */
export function planRequireAny(rows: OfferRows): { edits: Edit[]; items: number } {
  const edits: Edit[] = [];
  let items = 0;
  for (const condition of rows.conditions) {
    if (!condition.isEnabled || condition.conditionType !== "specific_product" || condition.operator === "any") continue;
    const requirements = asRecordArray(asRecord(condition.value)["requirements"]);
    const plain = requirements.every((req) => Number(req["minQuantity"] ?? 1) <= 1 && req["maxQuantity"] === undefined);
    if (requirements.length < 2 || !plain) continue;
    items += requirements.length;
    edits.push({ table: "condition", id: condition.id, offerId: rows.offer.id, before: { operator: condition.operator }, after: { operator: "any" } });
  }
  return { edits, items };
}

const asRecordArray = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);

export interface GiftStock {
  availableForSale: boolean;
  inventoryTracked: boolean | null;
  inventoryPolicy: string | null;
  inventoryQuantity: number | null;
  title: string;
}

const isAvailable = (stock: GiftStock | undefined) =>
  stock === undefined ? false : stock.availableForSale && (stock.inventoryTracked === false || stock.inventoryPolicy === "CONTINUE" || (stock.inventoryQuantity ?? 0) > 0);

/** Available first, then more stock, then the merchant's own order (Array.sort is stable). */
export function rankGiftVariants(variantIds: readonly string[], stock: ReadonlyMap<string, GiftStock>): string[] {
  const score = (id: string) => ({ ok: isAvailable(stock.get(id)) ? 1 : 0, qty: stock.get(id)?.inventoryQuantity ?? 0 });
  return [...variantIds].sort((a, b) => score(b).ok - score(a).ok || score(b).qty - score(a).qty);
}

export async function loadGiftStock(db: Db, shopId: string, variantIds: readonly string[]): Promise<Map<string, GiftStock>> {
  const stock = new Map<string, GiftStock>();
  const unique = [...new Set(variantIds)];
  for (let start = 0; start < unique.length; start += 1000) {
    const rows = await db
      .select({
        id: variantCache.variantGid,
        availableForSale: variantCache.availableForSale,
        inventoryTracked: variantCache.inventoryTracked,
        inventoryPolicy: variantCache.inventoryPolicy,
        inventoryQuantity: variantCache.inventoryQuantity,
        title: variantCache.title,
      })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, unique.slice(start, start + 1000))));
    for (const { id, ...row } of rows) stock.set(id, row);
  }
  return stock;
}

/** The gift reward with the longest picker list, if it has more than one option. */
export function largestGiftReward(rows: OfferRows): { reward: OfferReward; variantIds: string[]; fallback: number } | null {
  let best: { reward: OfferReward; variantIds: string[]; fallback: number } | null = null;
  for (const reward of rows.rewards) {
    if (reward.rewardType !== "product_gift") continue;
    const target = asRecord(reward.target);
    const variantIds = strings(target["variantIds"]);
    if (variantIds.length > 1 && (!best || variantIds.length > best.variantIds.length)) best = { reward, variantIds, fallback: strings(target["fallbackVariantIds"]).length };
  }
  return best;
}

/** Keeps the `keep` best-ranked options, in the merchant's original order. */
export function planReduceGifts(rows: OfferRows, stock: ReadonlyMap<string, GiftStock>, keep: number): { edits: Edit[]; removed: string[] } | null {
  const best = largestGiftReward(rows);
  if (!best || keep < 1 || keep >= best.variantIds.length) return null;
  const kept = new Set(rankGiftVariants(best.variantIds, stock).slice(0, keep));
  const removed = best.variantIds.filter((id) => !kept.has(id));
  const target = { ...asRecord(best.reward.target), variantIds: best.variantIds.filter((id) => kept.has(id)) };
  return { edits: [{ table: "reward", id: best.reward.id, offerId: rows.offer.id, before: { target: best.reward.target }, after: { target } }], removed };
}

export function planAllowCombine(rows: Iterable<OfferRows>): Edit[] {
  return [...rows]
    .filter((row) => row.policy && !row.policy.combinesWithProductDiscounts)
    .map((row) => ({ table: "policy", id: row.policy!.id, offerId: row.offer.id, before: { combinesWithProductDiscounts: false }, after: { combinesWithProductDiscounts: true } }));
}

// ---------------------------------------------------------------------------------------------------- split

export interface SplitOutcome {
  partIds: string[];
  /** Parts archived to active, then the original active to paused (when it was live): replaying or reverting them is the whole Undo. */
  edits: Edit[];
}

/**
 * Inside the caller's transaction: copies the offer k times with disjoint slices, switches the parts on and pauses
 * the original. A copy keeps the original's priority and combination policy; codes and usage counters are not copied.
 */
export async function runSplit(tx: Db, shopId: string, rows: OfferRows, rewardId: string, k: number): Promise<SplitOutcome | null> {
  const reward = rows.rewards.find((row) => row.id === rewardId);
  if (!reward) return null;
  const slices = sliceTarget(reward.target, k);
  if (slices.length < 2) return null;
  const partIds: string[] = [];
  for (const [index, slice] of slices.entries()) {
    let name = partName(rows.offer.internalName, index, slices.length);
    for (let attempt = 2; (await tx.select({ id: offers.id }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.internalName, name)))).length > 0; attempt++) {
      name = `${partName(rows.offer.internalName, index, slices.length)} #${attempt}`;
    }
    const id = await duplicateOffer(tx, shopId, rows.offer.id, { name });
    if (!id) return null;
    const [copied] = await tx.select({ id: offerRewards.id }).from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, id)));
    await tx.update(offerRewards).set({ target: slice }).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, id), eq(offerRewards.id, copied!.id)));
    await tx.update(offers).set({ status: "active", updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, id)));
    partIds.push(id);
  }
  const originalEdits = pauseEdits([rows]);
  await applyEdits(tx, shopId, originalEdits);
  const partEdits = partIds.map((id): Edit => ({ table: "offer", id, before: { status: "archived" }, after: { status: "active" } }));
  return { partIds, edits: [...partEdits, ...originalEdits] };
}
