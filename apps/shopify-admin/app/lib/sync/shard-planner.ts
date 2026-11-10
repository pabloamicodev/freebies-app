import { compactCompiledOffer, serializeFunctionConfig, type CompiledOffer } from "./compile-config.js";
import type { SplitRefusal } from "./offer-split.js";

export interface PlanUnit {
  key: string;
  bytes: number;
  cartAttributeKeys: string[];
  customerTags: string[];
  priority: number;
  hasOrderRewards: boolean;
  stopLowerPriority: boolean;
  /** Product ids the unit's rewards can touch; null = sitewide (intersects every target). */
  targetProductIds: string[] | null;
  /** Emits multi-line fixed candidates (quiz bundle etc.): colocated with every intersecting unit (C5). */
  multiLineFixed: boolean;
  /** Split hook: pre-sliced parts (keyed `offerId#k`) that replace this unit when it is bigger than a slot. */
  splittable?: PlanUnit[];
  /** Why an oversize unit could not be split (offer-split.ts), so a blocked plan can say so. */
  splitRefusal?: SplitRefusal;
}

export interface PlannerLimits {
  slotBytes: number;
  targetFill: number;
  maxSlots: number;
  maxKeys: number;
  maxTags: number;
}

export { SLOT_LIMITS } from "./slot-limits.js";
import { SLOT_LIMITS } from "./slot-limits.js";

export interface CombinationPolicy {
  productDiscounts: boolean;
  orderDiscounts: boolean;
}

export type PlanBlockCode =
  | "SLOT0_GROUP_TOO_LARGE"
  | "OFFER_TOO_LARGE"
  | "GROUP_TOO_LARGE"
  | "AUTOMATIC_DISCOUNT_LIMIT"
  | "SLOT_FULL";

export type PlanBlockReason = "bytes" | "keys" | "tags";

export interface PlanBlocked {
  code: PlanBlockCode;
  unitKeys: string[];
  /** For the too-large codes: which limit the (first) offender broke. */
  reason?: PlanBlockReason;
  /** OFFER_TOO_LARGE only: why the first offender is not splittable. */
  splitRefusal?: SplitRefusal;
  numbers: Record<string, number>;
}

export interface PlannedSlot {
  index: number;
  unitKeys: string[];
  bytes: number;
  keys: string[];
  tags: string[];
}

export interface PlanMove {
  unitKey: string;
  from: number;
  to: number;
}

export interface ShardPlan {
  slots: PlannedSlot[];
  moves: PlanMove[];
  blocked?: PlanBlocked;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Bytes the offer adds to a slot's `offers` array: its compacted JSON (exactly what
 * `serializeFunctionConfig` emits for it) plus one for the array separator. A slot with n units
 * weighs `envelopeBytes + sum(unitBytes) - 1`. `sharedConfigBreakdown` measures the uncompacted
 * offer, so it overstates; the planner uses this exact figure.
 */
export function unitBytes(offer: CompiledOffer, compactIds = false): number {
  return utf8Bytes(JSON.stringify(compactCompiledOffer(offer, compactIds))) + 1;
}

/** Per-slot envelope: version, compiledAt, c1..c3 query variables, customerTags (and l1/l2 when set) and the empty `offers` array. */
export function envelopeBytes(
  cartAttributeKeys: readonly string[],
  customerTags: readonly string[],
  lineAttributeKeys: { l1?: string; l2?: string } = {},
): number {
  const [c1, c2, c3] = [...cartAttributeKeys].sort(compareText);
  return utf8Bytes(
    serializeFunctionConfig({
      offers: [],
      shippingOffers: [],
      version: "1",
      compiledAt: "1970-01-01T00:00:00.000Z",
      ...(lineAttributeKeys.l1 !== undefined ? { l1: lineAttributeKeys.l1 } : {}),
      ...(lineAttributeKeys.l2 !== undefined ? { l2: lineAttributeKeys.l2 } : {}),
      ...(c1 !== undefined ? { c1 } : {}),
      ...(c2 !== undefined ? { c2 } : {}),
      ...(c3 !== undefined ? { c3 } : {}),
      ...(customerTags.length > 0 ? { customerTags: [...customerTags].sort(compareText) } : {}),
    }),
  );
}

const compareUnits = (a: PlanUnit, b: PlanUnit) => a.priority - b.priority || compareText(a.key, b.key);

interface Group {
  units: PlanUnit[];
  sum: number;
  keys: Set<string>;
  tags: Set<string>;
  pinned: boolean;
  minPriority: number;
  minKey: string;
}

interface Measure {
  bytes: number;
  keys: string[];
  tags: string[];
}

function measure(groups: readonly Group[]): Measure {
  const keys = new Set<string>();
  const tags = new Set<string>();
  let sum = 0;
  let count = 0;
  for (const group of groups) {
    group.keys.forEach((key) => keys.add(key));
    group.tags.forEach((tag) => tags.add(tag));
    sum += group.sum;
    count += group.units.length;
  }
  const keyList = [...keys].sort(compareText);
  const tagList = [...tags].sort(compareText);
  const bytes = envelopeBytes(keyList, tagList) + sum - (count > 0 ? 1 : 0);
  return { bytes, keys: keyList, tags: tagList };
}

const makeGroup = (units: PlanUnit[], pinned: boolean): Group => {
  const sorted = [...units].sort(compareUnits);
  return {
    units: sorted,
    sum: sorted.reduce((total, unit) => total + unit.bytes, 0),
    keys: new Set(sorted.flatMap((unit) => unit.cartAttributeKeys)),
    tags: new Set(sorted.flatMap((unit) => unit.customerTags)),
    pinned,
    minPriority: sorted[0]?.priority ?? 0,
    minKey: sorted[0]?.key ?? "",
  };
};

const compareGroups = (a: Group, b: Group) => a.minPriority - b.minPriority || compareText(a.minKey, b.minKey);
const compareBySize = (a: Group, b: Group) => b.sum - a.sum || compareText(a.minKey, b.minKey);

function intersects(a: PlanUnit, b: PlanUnit): boolean {
  if (a.targetProductIds === null || b.targetProductIds === null) return true;
  const ids = new Set(a.targetProductIds);
  return b.targetProductIds.some((id) => ids.has(id));
}

function buildGroups(units: PlanUnit[]): Group[] {
  const parent = units.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const minStop = Math.min(...units.filter((unit) => unit.stopLowerPriority).map((unit) => unit.priority));
  const isPinned = (unit: PlanUnit) => unit.hasOrderRewards || unit.stopLowerPriority || unit.priority > minStop;
  const pinnedIndexes = units.flatMap((unit, index) => (isPinned(unit) ? [index] : []));
  pinnedIndexes.slice(1).forEach((index) => union(pinnedIndexes[0]!, index));

  units.forEach((unit, i) => {
    if (!unit.multiLineFixed) return;
    units.forEach((other, j) => {
      if (i !== j && intersects(unit, other)) union(i, j);
    });
  });

  const buckets = new Map<number, number[]>();
  units.forEach((_, index) => {
    const root = find(index);
    buckets.set(root, [...(buckets.get(root) ?? []), index]);
  });
  return [...buckets.values()].map((indexes) =>
    makeGroup(
      indexes.map((index) => units[index]!),
      indexes.some((index) => isPinned(units[index]!)),
    ),
  );
}

function assemble(bins: Map<number, Group[]>, previous: ReadonlyMap<string, number>, blocked?: PlanBlocked): ShardPlan {
  if (!bins.has(0)) bins.set(0, []);
  const slots: PlannedSlot[] = [...bins.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, groups]) => {
      const { bytes, keys, tags } = measure(groups);
      return {
        index,
        unitKeys: groups.flatMap((group) => group.units).sort(compareUnits).map((unit) => unit.key),
        bytes,
        keys,
        tags,
      };
    });
  const moves = slots
    .flatMap((slot) =>
      slot.unitKeys.flatMap((unitKey) => {
        const from = previous.get(unitKey);
        return from !== undefined && from !== slot.index ? [{ unitKey, from, to: slot.index }] : [];
      }),
    )
    .sort((a, b) => compareText(a.unitKey, b.unitKey));
  return { slots, moves, ...(blocked ? { blocked } : {}) };
}

type Fits = (groups: readonly Group[], cap: number) => boolean;

function compactOne(bins: Map<number, Group[]>, cap: number, fits: Fits): void {
  const victim = [...bins.entries()]
    .filter(([index]) => index !== 0)
    .map(([index, binGroups]) => ({ index, binGroups, bytes: measure(binGroups).bytes }))
    .sort((a, b) => a.bytes - b.bytes || b.index - a.index)[0];
  if (!victim) return;
  const trial = new Map<number, Group[]>(
    [...bins.entries()].filter(([index]) => index !== victim.index).map(([index, g]) => [index, [...g]]),
  );
  const order = [...trial.keys()].sort((a, b) => a - b);
  for (const group of [...victim.binGroups].sort(compareBySize)) {
    const target = order.find((index) => fits([...trial.get(index)!, group], cap));
    if (target === undefined) return;
    trial.get(target)!.push(group);
  }
  bins.delete(victim.index);
  for (const [index, binGroups] of trial) bins.set(index, binGroups);
}

/**
 * Pure bin-packing of compiled cart offers into automatic discount nodes (slot 0 = the existing
 * node). Deterministic: ties break on (priority, key). `previous` makes placement sticky.
 *
 * A plan carrying `blocked` must never be written to Shopify: its slots are partial or empty.
 * Single-shard mode packs greedily in priority order, so on overflow it may skip a higher-priority
 * unit while still packing smaller lower-priority ones; `blocked.unitKeys` names the skipped units.
 */
export function planShards(
  inputUnits: readonly PlanUnit[],
  previous: ReadonlyMap<string, number>,
  limits: PlannerLimits,
  policy: CombinationPolicy,
): ShardPlan {
  const hard = limits.slotBytes;
  const soft = Math.floor(hard * limits.targetFill);
  const overLimit = (groups: readonly Group[], cap: number): { reason: PlanBlockReason; m: Measure } | null => {
    const m = measure(groups);
    if (m.bytes > cap) return { reason: "bytes", m };
    if (m.keys.length > limits.maxKeys) return { reason: "keys", m };
    if (m.tags.length > limits.maxTags) return { reason: "tags", m };
    return null;
  };
  const fits: Fits = (groups, cap) => overLimit(groups, cap) === null;
  const fitsAlone = (unit: PlanUnit) => fits([makeGroup([unit], false)], hard);
  const tooLargeNumbers = (m: Measure, extra: Record<string, number> = {}): Record<string, number> => ({
    slotBytes: hard,
    maxKeys: limits.maxKeys,
    maxTags: limits.maxTags,
    bytes: m.bytes,
    keys: m.keys.length,
    tags: m.tags.length,
    ...extra,
  });

  const hasOrders = inputUnits.some((unit) => unit.hasOrderRewards);
  const single = limits.maxSlots <= 1 || !policy.productDiscounts || (hasOrders && !policy.orderDiscounts);

  const units: PlanUnit[] = [];
  const tooLarge: string[] = [];
  for (const unit of [...inputUnits].sort(compareUnits)) {
    if (fitsAlone(unit)) units.push(unit);
    else if (!single && !unit.hasOrderRewards && unit.splittable?.length && unit.splittable.every(fitsAlone)) {
      units.push(...unit.splittable);
    } else tooLarge.push(unit.key);
  }
  if (tooLarge.length > 0) {
    const offender = inputUnits.find((unit) => unit.key === tooLarge[0])!;
    const first = overLimit([makeGroup([offender], false)], hard)!;
    return {
      slots: [],
      moves: [],
      blocked: {
        code: "OFFER_TOO_LARGE",
        unitKeys: tooLarge,
        reason: first.reason,
        ...(offender.splitRefusal ? { splitRefusal: offender.splitRefusal } : {}),
        numbers: tooLargeNumbers(first.m),
      },
    };
  }
  units.sort(compareUnits);
  const everyone = units.map((unit) => makeGroup([unit], false));

  if (single) {
    const placed: Group[] = [];
    const overflow: string[] = [];
    for (const group of everyone) {
      if (fits([...placed, group], hard)) placed.push(group);
      else overflow.push(group.minKey);
    }
    return assemble(
      new Map([[0, placed]]),
      previous,
      overflow.length > 0
        ? {
            code: "SLOT_FULL",
            unitKeys: overflow,
            numbers: { slotBytes: hard, neededBytes: measure(everyone).bytes, overflowUnits: overflow.length },
          }
        : undefined,
    );
  }

  const spread = units.some((unit) => (previous.get(unit.key) ?? 0) > 0);
  if (!spread && fits(everyone, hard)) return assemble(new Map([[0, everyone]]), previous);

  const groups = buildGroups(units);
  const pinned = groups.find((group) => group.pinned);
  if (pinned && !fits([pinned], hard)) {
    const named = pinned.units.filter((unit) => unit.hasOrderRewards || unit.stopLowerPriority);
    return {
      slots: [],
      moves: [],
      blocked: {
        code: "SLOT0_GROUP_TOO_LARGE",
        unitKeys: (named.length > 0 ? named : pinned.units).map((unit) => unit.key),
        numbers: { slotBytes: hard, groupBytes: measure([pinned]).bytes, groupUnits: pinned.units.length },
      },
    };
  }

  for (const group of groups.filter((g) => !g.pinned)) {
    const over = overLimit([group], hard);
    if (over) {
      return {
        slots: [],
        moves: [],
        blocked: {
          code: "GROUP_TOO_LARGE",
          unitKeys: group.units.map((unit) => unit.key),
          reason: over.reason,
          numbers: tooLargeNumbers(over.m, { groupUnits: group.units.length }),
        },
      };
    }
  }

  const bins = new Map<number, Group[]>([[0, pinned ? [pinned] : []]]);
  const pending: Group[] = [];
  for (const group of groups.filter((g) => !g.pinned).sort(compareGroups)) {
    const prevSlots = group.units.flatMap((unit) => previous.get(unit.key) ?? []).filter((slot) => slot < limits.maxSlots);
    if (prevSlots.length === 0) pending.push(group);
    else {
      const slot = Math.min(...prevSlots);
      bins.set(slot, [...(bins.get(slot) ?? []), group]);
    }
  }
  for (const [, binGroups] of [...bins.entries()].sort(([a], [b]) => a - b)) {
    while (!fits(binGroups, hard)) {
      const victim = binGroups.filter((group) => !group.pinned).sort(compareBySize)[0];
      if (!victim) break;
      binGroups.splice(binGroups.indexOf(victim), 1);
      pending.push(victim);
    }
  }
  for (const [index, binGroups] of [...bins.entries()]) if (index !== 0 && binGroups.length === 0) bins.delete(index);

  const lowestFree = () => {
    let index = 0;
    while (bins.has(index)) index++;
    return index;
  };
  const place = (group: Group, cap: number) => {
    for (const [, binGroups] of [...bins.entries()].sort(([a], [b]) => a - b)) {
      if (fits([...binGroups, group], cap)) {
        binGroups.push(group);
        return true;
      }
    }
    return false;
  };
  for (const group of pending.sort(compareBySize)) {
    if (place(group, soft)) continue;
    if (bins.size >= limits.maxSlots && place(group, hard)) continue;
    bins.set(lowestFree(), [group]);
  }

  const totalBytes = [...bins.values()].reduce((total, binGroups) => total + measure(binGroups).bytes, 0);
  if (bins.size > Math.ceil(totalBytes / soft) + 1) compactOne(bins, soft, fits);

  if (bins.size > limits.maxSlots) {
    const overflow = [...bins.entries()].filter(([index]) => index >= limits.maxSlots);
    return assemble(bins, previous, {
      code: "AUTOMATIC_DISCOUNT_LIMIT",
      unitKeys: overflow
        .flatMap(([, binGroups]) => binGroups.flatMap((group) => group.units.map((unit) => unit.key)))
        .sort(compareText),
      numbers: { needed: bins.size, allowed: limits.maxSlots },
    });
  }
  return assemble(bins, previous);
}
