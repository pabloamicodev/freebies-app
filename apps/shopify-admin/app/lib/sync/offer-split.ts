import { compactCompiledOffer, compactId, type CompiledOffer, type CompiledProductReward } from "./compile-config.js";

/**
 * Automatic split of an offer that is bigger than one Function node (architect-capacity.md §2).
 * Every part is a full copy of the offer carrying one disjoint slice of ONE list; parts that land in
 * the same slot are merged back (`mergeOfferParts`). The Function sees ordinary offers, so duplicate
 * candidates on the same line resolve to one (best_candidate_per_line, or Shopify's one product
 * discount per line across nodes). Anything not in the §2.2 table is refused with a reason code.
 */
export type SplitRefusal =
  | "STOP_LOWER_PRIORITY"
  | "ORDER_REWARDS"
  | "ANCHOR_CONSUMPTION"
  | "QUIZ_BUNDLE"
  | "NO_REWARD_SHAPE"
  | "AGGREGATING_REWARD"
  | "CART_WIDE_CAP"
  | "MIXED_TARGETS"
  | "LANDING_SELF_ANCHOR"
  | "NOT_LANDING_ANCHOR"
  | "ANCHOR_MIN_QUANTITY"
  | "GIFT_PICKER"
  | "GIFT_REWARDS_OVERLAP"
  | "GIFT_TIER_HIGHEST"
  | "GIFT_ANCHOR_OVERLAP"
  | "VARIANT_PRODUCT_UNKNOWN"
  | "REQUIRED_TAGS_ALL_OF"
  | "EXCLUDED_TAGS"
  | "ALL_OF_CONDITION"
  | "REQUIRED_IDS"
  | "EXCLUDED_PRODUCTS"
  | "REJECT_UNMATCHED_LINES"
  | "NO_SPLITTABLE_LIST"
  | "STILL_TOO_LARGE";

export interface SplitOptions {
  /** Variant gid to its product gid. Needed only where a per-product cap applies to a variant list. */
  productOfVariant?: (variantId: string) => string | undefined;
  /** Measure with the numeric-id form (the shop has the compact-ids flag on), like `unitBytes`. */
  compactIds?: boolean;
  /** Attach each unit's estimated instructions (the shop has the instruction budget on). */
  instructions?: boolean;
}

export interface SplitList {
  id: string;
  /** Offer paths (dot notation) the list occupies, e.g. `productRewards.0.targetVariantIds`. */
  paths: string[];
  /** Bytes of the list's ids in the serialized offer. */
  size: number;
  splittable: boolean;
  reason?: SplitRefusal;
}

export interface SplitPart {
  index: number;
  offer: CompiledOffer;
}

export type SplitResult =
  | { ok: true; listId: string; paths: string[]; rewardArray?: "giftRewards"; parts: SplitPart[] }
  | { ok: false; reason: SplitRefusal };

type Group = Record<string, string[]>;

interface Spec extends SplitList {
  /** Offer-level lists mirrored from a sliced list: kept for ids outside it, filtered for ids inside it. */
  derived: Array<{ path: string; from: string; others: string[] }>;
  groups: Group[] | null;
  /** The list is the offer's gift reward array: groups hold reward indexes, and the parts keep whole rewards. */
  rewardArray?: "giftRewards";
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;
const idBytes = (id: string, compact = false) => utf8(JSON.stringify(compact ? compactId(id) : id)) + 1;
const offerBytes = (offer: CompiledOffer, compact = false) => utf8(JSON.stringify(compactCompiledOffer(offer, compact))) + 1;

function getAt(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node === undefined || node === null ? undefined : (node as Record<string, unknown>)[key]), root);
}

function setAt(root: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as Record<string, unknown>;
  parent[last] = value;
}

const listAt = (offer: CompiledOffer, path: string): string[] => {
  const value = getAt(offer, path);
  return Array.isArray(value) ? (value as string[]) : [];
};

const sizeOf = (offer: CompiledOffer, paths: readonly string[], compact = false) =>
  paths.reduce((total, path) => total + listAt(offer, path).reduce((sum, id) => sum + idBytes(id, compact), 0), 0);

function perLineReward(reward: CompiledProductReward): boolean {
  return (
    reward.quantityTiers.length === 0 &&
    reward.priceTiers.length === 0 &&
    reward.maxUnitsTotal === undefined &&
    reward.selectionMode === "all" &&
    reward.discountType !== "cheapest_item_free" &&
    reward.discountType !== "most_expensive_item_discount"
  );
}

// Mirrors `is_free_landing_gift` and the set-limit rule of evaluate_product_reward.
function setLimited(reward: CompiledProductReward): boolean {
  const freeLanding =
    reward.scopeMode === "landing" &&
    reward.priceTiers.length === 0 &&
    reward.quantityTiers.length === 0 &&
    (reward.discountType === "free" || (reward.discountType === "percentage" && reward.discountValue >= 100));
  return freeLanding || ((reward.scopeMode === "landing" || reward.scopeMode === "tagged_offer") && reward.maxQuantity !== undefined);
}

function itemGroups(offer: CompiledOffer, paths: readonly string[]): Group[] {
  return paths.flatMap((path) => listAt(offer, path).map((id) => ({ [path]: [id] })));
}

/** Variants travel with their product, so a per-product cap sees the whole product in one part. */
function productGroups(offer: CompiledOffer, variantPath: string, productPath: string, productOf?: (id: string) => string | undefined): Group[] | null {
  const byProduct = new Map<string, Group>();
  const add = (key: string, path: string, id: string) => {
    const group = byProduct.get(key) ?? {};
    (group[path] ??= []).push(id);
    byProduct.set(key, group);
  };
  for (const id of listAt(offer, productPath)) add(id, productPath, id);
  for (const id of listAt(offer, variantPath)) {
    const product = productOf?.(id);
    if (!product) return null;
    add(product, variantPath, id);
  }
  return [...byProduct.values()];
}

function gate(offer: CompiledOffer): SplitRefusal | null {
  if (offer.stopLowerPriority) return "STOP_LOWER_PRIORITY";
  if (offer.orderRewards.length > 0) return "ORDER_REWARDS";
  if (offer.canStackWithGiftOffers === false) return "ANCHOR_CONSUMPTION";
  if (offer.productRewards.some((reward) => reward.scopeMode === "quiz_bundle")) return "QUIZ_BUNDLE";
  if (offer.productRewards.length === 0 && offer.giftRewards.length === 0) return "NO_REWARD_SHAPE";
  return null;
}

function buildSpecs(offer: CompiledOffer, options: SplitOptions): Spec[] {
  const specs: Spec[] = [];
  const productOf = options.productOfVariant;
  const push = (spec: Omit<Spec, "size" | "derived" | "groups"> & Partial<Pick<Spec, "derived" | "groups" | "size">>) => {
    const size = spec.size ?? sizeOf(offer, spec.paths, options.compactIds);
    if (size === 0) return;
    specs.push({ derived: [], groups: null, ...spec, size });
  };
  const refused = (id: string, paths: string[], reason: SplitRefusal) => push({ id, paths, splittable: false, reason });

  offer.productRewards.forEach((reward, index) => {
    const base = `productRewards.${index}`;
    const targets = [`${base}.targetVariantIds`, `${base}.targetProductIds`];
    const variants = reward.targetVariantIds.length;
    const products = reward.targetProductIds.length;
    let reason: SplitRefusal | undefined;
    // Without anchor variants the Function takes every tagged line except the reward's own targets as the anchor, so a
    // target sliced into another part would unlock this part's targets.
    if (reward.scopeMode === "landing" && reward.requiredAnchorVariantIds.length === 0) reason = "LANDING_SELF_ANCHOR";
    else if (!perLineReward(reward)) reason = "AGGREGATING_REWARD";
    else if (!setLimited(reward) && (reward.maxQuantity !== undefined || offer.mpc !== undefined)) reason = "CART_WIDE_CAP";
    else if (setLimited(reward) && variants > 0 && products > 0) reason = "MIXED_TARGETS";
    let groups: Group[] | null = null;
    if (!reason) {
      groups =
        reward.maxUnitsPerProduct !== undefined && variants > 0
          ? productGroups(offer, targets[0]!, targets[1]!, productOf)
          : itemGroups(offer, targets);
      if (!groups) reason = "VARIANT_PRODUCT_UNKNOWN";
    }
    push({ id: `${base}.targets`, paths: targets, splittable: !reason, ...(reason ? { reason } : {}), groups });

    const anchors = `${base}.requiredAnchorVariantIds`;
    let anchorReason: SplitRefusal | undefined;
    if (reward.scopeMode !== "landing") anchorReason = "NOT_LANDING_ANCHOR";
    else if (reward.requiredAnchorMinQuantity > 1) anchorReason = "ANCHOR_MIN_QUANTITY";
    else if (!perLineReward(reward)) anchorReason = "AGGREGATING_REWARD";
    push({ id: anchors, paths: [anchors], splittable: !anchorReason, ...(anchorReason ? { reason: anchorReason } : {}), groups: itemGroups(offer, [anchors]) });
  });

  offer.giftRewards.forEach((reward, index) => {
    const base = `giftRewards.${index}`;
    const targets = [`${base}.targetVariantIds`, `${base}.targetProductIds`];
    let reason: SplitRefusal | undefined;
    let groups: Group[] | null = null;
    if (reward.selectable || reward.selectionCount !== undefined || reward.targetVariantIds.length > 1) reason = "GIFT_PICKER";
    else {
      groups = productGroups(offer, targets[0]!, targets[1]!, productOf);
      if (!groups) reason = "VARIANT_PRODUCT_UNKNOWN";
    }
    const others = (key: "targetVariantIds" | "targetProductIds") =>
      offer.giftRewards.flatMap((other, otherIndex) => (otherIndex === index ? [] : other[key]));
    push({
      id: `${base}.targets`,
      paths: targets,
      splittable: !reason,
      ...(reason ? { reason } : {}),
      groups,
      derived: [
        { path: "giftVariantIds", from: targets[0]!, others: others("targetVariantIds") },
        { path: "giftProductIds", from: targets[1]!, others: others("targetProductIds") },
      ],
    });
  });

  if (offer.giftRewards.length > 1) {
    const rewards = offer.giftRewards;
    const ids = rewards.map((reward) => reward.id);
    const distinct = (lists: string[][]) => new Set(lists.flat()).size === lists.flat().length;
    const productSets = rewards.map((reward) => {
      const owners = reward.targetVariantIds.map((id) => productOf?.(id));
      return owners.some((owner) => owner === undefined) ? null : [...new Set([...reward.targetProductIds, ...(owners as string[])])];
    });
    let reason: SplitRefusal | undefined;
    if (rewards.some((reward) => reward.selectionCount !== undefined)) reason = "GIFT_PICKER";
    else if (offer.tm === "h" && rewards.some((reward) => reward.mcs !== undefined)) reason = "GIFT_TIER_HIGHEST";
    else if (new Set(ids).size !== ids.length || !distinct(rewards.map((reward) => reward.targetVariantIds))) reason = "GIFT_REWARDS_OVERLAP";
    else if (rewards.some((reward) => reward.targetVariantIds.length === 0 && reward.targetProductIds.length === 0)) reason = "GIFT_REWARDS_OVERLAP";
    else if (productSets.some((set) => set === null)) reason = "VARIANT_PRODUCT_UNKNOWN";
    else if (!distinct(productSets as string[][])) reason = "GIFT_REWARDS_OVERLAP";
    const weights = rewards.map((reward) => utf8(JSON.stringify(reward)) + 1);
    push({
      id: "giftRewards",
      paths: [],
      size: weights.reduce((total, value) => total + value, 0),
      splittable: !reason,
      ...(reason ? { reason } : {}),
      rewardArray: "giftRewards",
      groups: rewards.map((_, index) => ({ giftRewards: [String(index)] })),
      derived: [
        { path: "giftVariantIds", from: "giftRewards", others: [] },
        { path: "giftProductIds", from: "giftRewards", others: [] },
      ],
    });
  }

  const anyPaths = ["anyRequiredVariantIds", "anyRequiredProductIds"];
  let anyReason: SplitRefusal | undefined;
  if (offer.giftRewards.length > 0) {
    const giftVariants = new Set(offer.giftRewards.flatMap((reward) => reward.targetVariantIds));
    const giftProducts = new Set(offer.giftRewards.flatMap((reward) => reward.targetProductIds));
    const anyVariants = offer.anyRequiredVariantIds;
    const anyProducts = offer.anyRequiredProductIds;
    // An untagged gift line that is also an any-of anchor reserves one unit, so the parts could disagree on it.
    if (anyVariants.some((id) => giftVariants.has(id)) || anyProducts.some((id) => giftProducts.has(id))) anyReason = "GIFT_ANCHOR_OVERLAP";
    else if (anyProducts.length > 0 && giftVariants.size > 0) {
      const owners = [...giftVariants].map((id) => productOf?.(id));
      if (owners.some((owner) => owner === undefined)) anyReason = "VARIANT_PRODUCT_UNKNOWN";
      else if (owners.some((owner) => anyProducts.includes(owner!))) anyReason = "GIFT_ANCHOR_OVERLAP";
    } else if (anyVariants.length > 0 && giftProducts.size > 0) {
      const owners = anyVariants.map((id) => productOf?.(id));
      if (owners.some((owner) => owner === undefined)) anyReason = "VARIANT_PRODUCT_UNKNOWN";
      else if (owners.some((owner) => giftProducts.has(owner!))) anyReason = "GIFT_ANCHOR_OVERLAP";
    }
  }
  push({
    id: "anyRequired",
    paths: anyPaths,
    splittable: !anyReason,
    ...(anyReason ? { reason: anyReason } : {}),
    groups: itemGroups(offer, anyPaths),
  });

  (offer.pageUrlConditions ?? []).forEach((condition, index) => {
    const path = `pageUrlConditions.${index}.patterns`;
    const reason: SplitRefusal | undefined = offer.rejectUnmatchedLines
      ? "REJECT_UNMATCHED_LINES"
      : offer.restrictToMatchedLines && !offer.productRewards.every(perLineReward)
        ? "AGGREGATING_REWARD"
        : undefined;
    // page_type patterns starting with "!" are exclusions that win over every listed page: they stay in every part.
    const exclusions = condition.matchMode === "page_type" ? condition.patterns.filter((pattern) => pattern.startsWith("!")) : [];
    const groups = condition.patterns.filter((pattern) => !exclusions.includes(pattern)).map((pattern) => ({ [path]: [pattern] }));
    push({
      id: path,
      paths: [path],
      splittable: !reason,
      ...(reason ? { reason } : {}),
      groups,
      derived: exclusions.length > 0 ? [{ path, from: path, others: exclusions }] : [],
    });
  });

  // Not in the §2.2 table: AND or absence semantics, so a slice would change the outcome.
  const refusals: Array<[string, string[], SplitRefusal]> = [
    ["requiredCustomerTags", ["requiredCustomerTags"], "REQUIRED_TAGS_ALL_OF"],
    ["excludedCustomerTags", ["excludedCustomerTags"], "EXCLUDED_TAGS"],
    ["requirements", [], "ALL_OF_CONDITION"],
    ["requiredIds", ["requiredVariantIds", "requiredProductIds"], "REQUIRED_IDS"],
    ["excludedProductIds", ["excludedProductIds"], "EXCLUDED_PRODUCTS"],
  ];
  for (const [id, paths, reason] of refusals) {
    if (id === "requirements") {
      const size = offer.requirements.reduce((total, requirement) => total + utf8(JSON.stringify(requirement)) + 1, 0);
      if (size > 0) specs.push({ id, paths: ["requirements"], size, splittable: false, reason, derived: [], groups: null });
    } else refused(id, paths, reason);
  }

  const blocked = gate(offer);
  return blocked ? specs.map((spec) => ({ ...spec, splittable: false, reason: blocked })) : specs;
}

/** Every list an offer carries that could matter for its size, with whether (and why not) it can be split. */
export function splittableLists(offer: CompiledOffer, options: SplitOptions = {}): SplitList[] {
  return buildSpecs(offer, options).map(({ id, paths, size, splittable, reason }) => ({ id, paths, size, splittable, ...(reason ? { reason } : {}) }));
}

function build(offer: CompiledOffer, spec: Spec, chunk: Group[], index: number): SplitPart {
  const part = structuredClone(offer);
  for (const path of spec.paths) setAt(part, path, chunk.flatMap((group) => group[path] ?? []));
  if (spec.rewardArray) {
    const kept = chunk.flatMap((group) => group[spec.rewardArray!]!.map((position) => offer.giftRewards[Number(position)]!));
    part.giftRewards = structuredClone(kept);
    const ids = (rewards: readonly CompiledOffer["giftRewards"][number][], key: "targetVariantIds" | "targetProductIds") => new Set(rewards.flatMap((reward) => reward[key]));
    for (const [path, key] of [["giftVariantIds", "targetVariantIds"], ["giftProductIds", "targetProductIds"]] as const) {
      const all = ids(offer.giftRewards, key);
      const mine = ids(kept, key);
      setAt(part, path, listAt(offer, path).filter((id) => !all.has(id) || mine.has(id)));
    }
    return { index, offer: part };
  }
  for (const derived of spec.derived) {
    if (derived.path === derived.from) {
      setAt(part, derived.path, [...listAt(part, derived.path), ...derived.others]);
      continue;
    }
    const full = new Set(listAt(offer, derived.from));
    const slice = new Set(listAt(part, derived.from));
    const others = new Set(derived.others);
    setAt(
      part,
      derived.path,
      listAt(offer, derived.path).filter((id) => !full.has(id) || slice.has(id) || others.has(id)),
    );
  }
  return { index, offer: part };
}

function chunkGroups(groups: Group[], budget: number, weigh?: (group: Group) => number, compact = false): Group[][] | null {
  if (budget <= 0) return null;
  const weight = weigh ?? ((group: Group) => Object.values(group).reduce((total, ids) => total + ids.reduce((sum, id) => sum + idBytes(id, compact), 0), 0));
  const weights = groups.map(weight);
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (weights.some((value) => value > budget)) return null;
  const count = Math.max(1, Math.ceil(total / budget));
  const target = Math.ceil(total / count);
  const chunks: Group[][] = [];
  let current: Group[] = [];
  let used = 0;
  groups.forEach((group, index) => {
    const w = weights[index]!;
    if (current.length > 0 && (used + w > budget || (used >= target && chunks.length < count - 1))) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(group);
    used += w;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Splits an offer into parts that each serialize to at most `maxBytes` (the same `unitBytes` measure the
 * planner uses: compacted JSON plus the array separator). Slices the largest splittable list that works.
 */
export function splitOffer(offer: CompiledOffer, maxBytes: number, options: SplitOptions = {}): SplitResult {
  const blocked = gate(offer);
  if (blocked) return { ok: false, reason: blocked };
  const specs = buildSpecs(offer, options);
  const candidates = specs.filter((spec) => spec.splittable && spec.groups && spec.groups.length > 1).sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) {
    const blocking = specs.filter((spec) => spec.reason).sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))[0];
    return { ok: false, reason: blocking?.reason ?? "NO_SPLITTABLE_LIST" };
  }
  for (const spec of candidates) {
    const emptied = structuredClone(offer);
    for (const path of spec.paths) setAt(emptied, path, []);
    for (const derived of spec.derived.filter((entry) => entry.path !== entry.from)) setAt(emptied, derived.path, []);
    if (spec.rewardArray) emptied.giftRewards = [];
    const weigh = spec.rewardArray
      ? (group: Group) => utf8(JSON.stringify(offer.giftRewards[Number(group[spec.rewardArray!]![0])])) + 1
      : undefined;
    const compact = options.compactIds === true;
    let budget = maxBytes - offerBytes(emptied, compact);
    for (let attempt = 0; attempt < 6; attempt++) {
      const chunks = chunkGroups(spec.groups!, budget, weigh, compact);
      if (!chunks) break;
      const parts = chunks.map((chunk, index) => build(offer, spec, chunk, index));
      const worst = Math.max(...parts.map((part) => offerBytes(part.offer, compact)));
      if (worst <= maxBytes) {
        return {
          ok: true,
          listId: spec.id,
          paths: [...spec.paths, ...spec.derived.map((entry) => entry.path)],
          ...(spec.rewardArray ? { rewardArray: spec.rewardArray } : {}),
          parts,
        };
      }
      budget -= worst - maxBytes + 1;
    }
  }
  // Slicing did not bring it under the limit: when what the offer keeps in every part is itself too big, name that list.
  const core = structuredClone(offer);
  for (const spec of specs.filter((entry) => entry.splittable)) for (const path of spec.paths) setAt(core, path, []);
  const heaviest = specs.filter((spec) => !spec.splittable).sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))[0];
  return { ok: false, reason: heaviest?.reason && offerBytes(core, options.compactIds === true) > maxBytes ? heaviest.reason : "STILL_TOO_LARGE" };
}

/** The offer carrying the union of the given parts' slices, in the base offer's order (all parts give back the base offer). */
export function mergeOfferParts(base: CompiledOffer, parts: readonly SplitPart[], paths: readonly string[], rewardArray?: "giftRewards"): CompiledOffer {
  const merged = structuredClone(base);
  if (rewardArray) {
    const present = new Set(parts.flatMap((part) => part.offer.giftRewards.map((reward) => reward.id)));
    merged.giftRewards = base.giftRewards.filter((reward) => present.has(reward.id));
  }
  for (const path of paths) {
    const union = new Set(parts.flatMap((part) => listAt(part.offer, path)));
    setAt(merged, path, listAt(base, path).filter((id) => union.has(id)));
  }
  return merged;
}
