import { compactCompiledOffer, SHOPIFY_VARIABLE_LIST_LIMIT, serializeFunctionConfig, type CompiledOffer } from "./compile-config.js";
import type { SplitRefusal } from "./offer-split.js";

export interface PlanUnit {
  key: string;
  bytes: number;
  cartAttributeKeys: string[];
  customerTags: string[];
  /** The offer's own combination flags; absent means it combines with everything. */
  domain?: CombinationPolicy;
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
  /** A list of the offer that cannot be packed or split is over Shopify's 100-element variable limit. */
  listOverflow?: { listKind: number; listCount: number };
  /** Estimated wasm instructions the offer adds to a node's run beyond the facts it shares (instruction-estimate.ts); omitted = not counted. */
  instructions?: number;
  /** Shared line facts the offer makes its node read (FACT_* flags): their cost is paid once per node, not once per offer. */
  instructionFacts?: number;
}

export interface PlannerLimits {
  slotBytes: number;
  targetFill: number;
  maxSlots: number;
  maxKeys: number;
  maxTags: number;
  maxOffers: number;
  /**
   * Soft cap on the summed `instructions` of the units of one node. A node holding a single bundle (one unit, or units
   * the planner must colocate) may exceed it. When the cap would need more nodes than `maxSlots` allows, the plan falls
   * back to the byte-only packing and carries a warning instead of blocking.
   */
  maxInstructions?: number;
  /** Cost of each shared fact (`FACT_QTY` = 1, `FACT_VALUE` = 2) a node's units need, counted once per node against `maxInstructions`. */
  instructionFacts?: { qty: number; value: number };
}

export { SLOT_LIMITS } from "./slot-limits.js";
import { SLOT_LIMITS } from "./slot-limits.js";

/** A node's Shopify combinesWith triple. An offer's combination group is the triple of its own flags. */
export interface CombinationPolicy {
  productDiscounts: boolean;
  orderDiscounts: boolean;
  shippingDiscounts: boolean;
}

export const OPEN_POLICY: CombinationPolicy = { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true };

/**
 * `uniform`: one policy for every node, so an offer that does not combine forces a single node (today's behavior).
 * `domains`: nodes are homogeneous by combination group and each gets its own members' policy.
 */
export type PlanMode = "uniform" | "domains";

export const andPolicies = (policies: readonly CombinationPolicy[]): CombinationPolicy => ({
  productDiscounts: policies.every((policy) => policy.productDiscounts),
  orderDiscounts: policies.every((policy) => policy.orderDiscounts),
  shippingDiscounts: policies.every((policy) => policy.shippingDiscounts),
});

export const policyKey = (policy: CombinationPolicy): string =>
  `${policy.productDiscounts ? 1 : 0}${policy.orderDiscounts ? 1 : 0}${policy.shippingDiscounts ? 1 : 0}`;

const restrictiveness = (policy: CombinationPolicy) =>
  [policy.productDiscounts, policy.orderDiscounts, policy.shippingDiscounts].filter((flag) => !flag).length;

export type PlanBlockCode =
  | "SLOT0_GROUP_TOO_LARGE"
  | "OFFER_TOO_LARGE"
  | "GROUP_TOO_LARGE"
  | "AUTOMATIC_DISCOUNT_LIMIT"
  | "SLOT_FULL";

export type PlanBlockReason = "bytes" | "keys" | "tags" | "offers" | "lists";

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
  /** combinesWith the node must carry: the AND of its members (the node's own group in `domains` mode). */
  policy: CombinationPolicy;
  /** Sum of the members' estimated instructions; only present when the plan was made with `maxInstructions`. */
  instructions?: number;
}

export type PlanWarningCode = "INSTRUCTION_BUDGET_UNREACHABLE" | "INSTRUCTION_BUDGET_EXCEEDED";

export interface PlanWarning {
  code: PlanWarningCode;
  /** Slots (or, for UNREACHABLE, the units' nodes needed vs allowed) the warning is about. */
  slots: number[];
  numbers: Record<string, number>;
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
  warnings?: PlanWarning[];
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
  domain: CombinationPolicy;
  dkey: string;
  minPriority: number;
  minKey: string;
  instr: number;
  facts: number;
}

interface Measure {
  offers: number;
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
  return { offers: count, bytes, keys: keyList, tags: tagList };
}

const makeGroup = (units: PlanUnit[], pinned: boolean): Group => {
  const sorted = [...units].sort(compareUnits);
  const domain = andPolicies(sorted.map((unit) => unit.domain ?? OPEN_POLICY));
  return {
    units: sorted,
    sum: sorted.reduce((total, unit) => total + unit.bytes, 0),
    keys: new Set(sorted.flatMap((unit) => unit.cartAttributeKeys)),
    tags: new Set(sorted.flatMap((unit) => unit.customerTags)),
    pinned,
    domain,
    dkey: policyKey(domain),
    minPriority: sorted[0]?.priority ?? 0,
    minKey: sorted[0]?.key ?? "",
    instr: sorted.reduce((total, unit) => total + (unit.instructions ?? 0), 0),
    facts: sorted.reduce((all, unit) => all | (unit.instructionFacts ?? 0), 0),
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

function assemble(
  bins: Map<number, Group[]>,
  previous: ReadonlyMap<string, number>,
  blocked?: PlanBlocked,
  binDomain: ReadonlyMap<number, CombinationPolicy> = new Map(),
): ShardPlan {
  if (!bins.has(0)) bins.set(0, []);
  const slots: PlannedSlot[] = [...bins.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, groups]) => {
      const { bytes, keys, tags } = measure(groups);
      const members = groups.flatMap((group) => group.units);
      return {
        policy: members.length > 0 ? andPolicies(members.map((unit) => unit.domain ?? OPEN_POLICY)) : (binDomain.get(index) ?? OPEN_POLICY),
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

function compactOne(bins: Map<number, Group[]>, cap: number, fits: Fits, binDomain: Map<number, string>): void {
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
    const target = order.find((index) => binDomain.get(index) === group.dkey && fits([...trial.get(index)!, group], cap));
    if (target === undefined) return;
    trial.get(target)!.push(group);
  }
  bins.delete(victim.index);
  binDomain.delete(victim.index);
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
function planCore(
  inputUnits: readonly PlanUnit[],
  previous: ReadonlyMap<string, number>,
  limits: PlannerLimits,
  mode: PlanMode,
): ShardPlan {
  const hard = limits.slotBytes;
  let instructionCap = limits.maxInstructions ?? Infinity;
  const factCost = (facts: number) => (facts & 1 ? (limits.instructionFacts?.qty ?? 0) : 0) + (facts & 2 ? (limits.instructionFacts?.value ?? 0) : 0);
  const instructionsOf = (groups: readonly Group[]) =>
    groups.reduce((total, group) => total + group.instr, 0) + factCost(groups.reduce((all, group) => all | group.facts, 0));
  const overInstructions = (groups: readonly Group[]) => instructionCap !== Infinity && groups.length > 1 && instructionsOf(groups) > instructionCap;
  // How much of a node a group takes: bytes, or instructions when that is the scarcer resource.
  const weight = (group: Group) => (instructionCap === Infinity ? group.sum : Math.max(group.sum / hard, (group.instr + factCost(group.facts)) / instructionCap));
  const bySize = (a: Group, b: Group) => weight(b) - weight(a) || compareText(a.minKey, b.minKey);
  const soft = Math.floor(hard * limits.targetFill);
  const overLimit = (groups: readonly Group[], cap: number): { reason: PlanBlockReason; m: Measure } | null => {
    const m = measure(groups);
    if (m.bytes > cap) return { reason: "bytes", m };
    if (m.keys.length > limits.maxKeys) return { reason: "keys", m };
    if (m.tags.length > limits.maxTags) return { reason: "tags", m };
    if (m.offers > limits.maxOffers) return { reason: "offers", m };
    return null;
  };
  const fits: Fits = (groups, cap) => overLimit(groups, cap) === null && !overInstructions(groups);
  const fitsAlone = (unit: PlanUnit) => fits([makeGroup([unit], false)], hard);
  const tooLargeNumbers = (m: Measure, extra: Record<string, number> = {}): Record<string, number> => ({
    slotBytes: hard,
    maxKeys: limits.maxKeys,
    maxTags: limits.maxTags,
    maxOffers: limits.maxOffers,
    offers: m.offers,
    bytes: m.bytes,
    keys: m.keys.length,
    tags: m.tags.length,
    ...extra,
  });

  const hasOrders = inputUnits.some((unit) => unit.hasOrderRewards);
  const shared = andPolicies(inputUnits.map((unit) => unit.domain ?? OPEN_POLICY));
  const single =
    limits.maxSlots <= 1 || (mode === "uniform" && (!shared.productDiscounts || (hasOrders && !shared.orderDiscounts)));
  // Everything shares one node anyway: the instruction cap cannot spread it, so it only warns (see planShards).
  if (single) instructionCap = Infinity;

  const units: PlanUnit[] = [];
  const tooLarge: string[] = [];
  for (const unit of [...inputUnits].sort(compareUnits)) {
    if (unit.listOverflow) tooLarge.push(unit.key);
    else if (fitsAlone(unit)) units.push(unit);
    else if (!single && !unit.hasOrderRewards && unit.splittable?.length && unit.splittable.every(fitsAlone)) {
      units.push(...unit.splittable);
    } else tooLarge.push(unit.key);
  }
  if (tooLarge.length > 0) {
    const offender = inputUnits.find((unit) => unit.key === tooLarge[0])!;
    const first = overLimit([makeGroup([offender], false)], hard);
    return {
      slots: [],
      moves: [],
      blocked: {
        code: "OFFER_TOO_LARGE",
        unitKeys: tooLarge,
        reason: offender.listOverflow ? "lists" : first!.reason,
        ...(offender.splitRefusal ? { splitRefusal: offender.splitRefusal } : {}),
        numbers: offender.listOverflow
          ? { ...offender.listOverflow, listLimit: SHOPIFY_VARIABLE_LIST_LIMIT }
          : tooLargeNumbers(first!.m),
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
  if (mode === "uniform") for (const group of groups) group.dkey = "*";
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
  // Every bin holds one combination group (`dkey`); in uniform mode there is only one, so this never splits anything.
  const binDomain = new Map<number, string>();
  const domainOf = new Map<string, CombinationPolicy>(groups.map((group) => [group.dkey, group.domain]));
  const prevSlotOf = (group: Group) => {
    const prevSlots = group.units.flatMap((unit) => previous.get(unit.key) ?? []).filter((slot) => slot < limits.maxSlots);
    return prevSlots.length === 0 ? null : Math.min(...prevSlots);
  };
  const free = groups.filter((g) => !g.pinned).sort(compareGroups);
  // A bin's group is the one holding most of its previous bytes (ties on key), so one flipped offer moves alone.
  const stickyDomain = new Map<number, string>();
  const bytesByBin = new Map<number, Map<string, number>>();
  for (const group of free) {
    const slot = prevSlotOf(group);
    if (slot === null) continue;
    const byDomain = bytesByBin.get(slot) ?? new Map<string, number>();
    byDomain.set(group.dkey, (byDomain.get(group.dkey) ?? 0) + group.sum);
    bytesByBin.set(slot, byDomain);
  }
  for (const [slot, byDomain] of bytesByBin) {
    stickyDomain.set(slot, [...byDomain.entries()].sort(([ka, a], [kb, b]) => b - a || compareText(ka, kb))[0]![0]);
  }
  if (pinned) binDomain.set(0, pinned.dkey);
  else {
    // First split: the restrictive offers were already in slot 0, so they stay and the permissive ones move out.
    const present = [...domainOf.entries()].sort(
      ([ka, a], [kb, b]) => restrictiveness(b) - restrictiveness(a) || compareText(ka, kb),
    );
    const slot0 = spread ? stickyDomain.get(0) : present[0]?.[0];
    if (slot0 !== undefined) binDomain.set(0, slot0);
  }
  const pending: Group[] = [];
  for (const group of free) {
    const slot = prevSlotOf(group);
    if (slot === null) {
      pending.push(group);
      continue;
    }
    const wanted = binDomain.get(slot) ?? stickyDomain.get(slot);
    if (wanted !== group.dkey) pending.push(group);
    else {
      binDomain.set(slot, wanted);
      bins.set(slot, [...(bins.get(slot) ?? []), group]);
    }
  }
  for (const [, binGroups] of [...bins.entries()].sort(([a], [b]) => a - b)) {
    while (!fits(binGroups, hard)) {
      // A node over its instruction budget (not its bytes) gives up the unit that costs the most instructions: the fewest moves.
      const byInstructions = overLimit(binGroups, hard) === null && overInstructions(binGroups);
      const victim = binGroups
        .filter((group) => !group.pinned)
        .sort(byInstructions ? (a, b) => b.instr - a.instr || compareText(a.minKey, b.minKey) : compareBySize)[0];
      if (!victim) break;
      binGroups.splice(binGroups.indexOf(victim), 1);
      pending.push(victim);
    }
  }
  for (const [index, binGroups] of [...bins.entries()]) {
    if (index !== 0 && binGroups.length === 0) {
      bins.delete(index);
      binDomain.delete(index);
    }
  }

  const lowestFree = () => {
    let index = 0;
    while (bins.has(index)) index++;
    return index;
  };
  const place = (group: Group, cap: number) => {
    for (const [index, binGroups] of [...bins.entries()].sort(([a], [b]) => a - b)) {
      const domain = binDomain.get(index);
      if ((domain === undefined || domain === group.dkey) && fits([...binGroups, group], cap)) {
        binDomain.set(index, group.dkey);
        binGroups.push(group);
        return true;
      }
    }
    return false;
  };
  for (const group of pending.sort(bySize)) {
    if (place(group, soft)) continue;
    if (bins.size >= limits.maxSlots && place(group, hard)) continue;
    const index = lowestFree();
    bins.set(index, [group]);
    binDomain.set(index, group.dkey);
  }

  const policies = () => new Map([...binDomain].map(([index, key]) => [index, domainOf.get(key) ?? OPEN_POLICY]));
  const totalBytes = [...bins.values()].reduce((total, binGroups) => total + measure(binGroups).bytes, 0);
  const domainCount = Math.max(1, new Set([...binDomain.values()]).size);
  if (bins.size > Math.ceil(totalBytes / soft) + domainCount) compactOne(bins, soft, fits, binDomain);

  if (bins.size > limits.maxSlots) {
    const overflow = [...bins.entries()].filter(([index]) => index >= limits.maxSlots);
    return assemble(bins, previous, {
      code: "AUTOMATIC_DISCOUNT_LIMIT",
      unitKeys: overflow
        .flatMap(([, binGroups]) => binGroups.flatMap((group) => group.units.map((unit) => unit.key)))
        .sort(compareText),
      numbers: { needed: bins.size, allowed: limits.maxSlots },
    }, policies());
  }
  return assemble(bins, previous, undefined, policies());
}

const costOf = (unit: PlanUnit) => ({ own: unit.instructions ?? 0, facts: unit.instructionFacts ?? 0 });
const instructionsByKey = (units: readonly PlanUnit[]) =>
  new Map(units.flatMap((unit) => [[unit.key, costOf(unit)] as const, ...(unit.splittable ?? []).map((part) => [part.key, costOf(part)] as const)]));

/**
 * `planCore` plus the soft instruction dimension. Without `limits.maxInstructions` this is the byte planner, untouched.
 * With it the planner tries to keep every node's summed instruction estimate under the cap (more nodes, never more than
 * `maxSlots`); if that cannot be done it returns the byte-only plan with an INSTRUCTION_BUDGET_UNREACHABLE warning, so the
 * dimension never turns a publishable shop into a blocked one. Nodes still over the cap (a single bundle bigger than the
 * budget) are reported as INSTRUCTION_BUDGET_EXCEEDED.
 */
export function planShards(
  inputUnits: readonly PlanUnit[],
  previous: ReadonlyMap<string, number>,
  limits: PlannerLimits,
  mode: PlanMode = "uniform",
): ShardPlan {
  const cap = limits.maxInstructions;
  if (cap === undefined) return planCore(inputUnits, previous, limits, mode);
  const costs = instructionsByKey(inputUnits);
  const annotate = (plan: ShardPlan, warnings: PlanWarning[]): ShardPlan => {
    if (plan.blocked) return plan;
    const factCost = (facts: number) => (facts & 1 ? (limits.instructionFacts?.qty ?? 0) : 0) + (facts & 2 ? (limits.instructionFacts?.value ?? 0) : 0);
    const slots = plan.slots.map((slot) => {
      const members = slot.unitKeys.map((key) => costs.get(key) ?? { own: 0, facts: 0 });
      return { ...slot, instructions: members.reduce((total, member) => total + member.own, 0) + factCost(members.reduce((all, member) => all | member.facts, 0)) };
    });
    const over = slots.filter((slot) => slot.instructions > cap);
    const all = [
      ...warnings,
      ...(over.length > 0
        ? [{ code: "INSTRUCTION_BUDGET_EXCEEDED" as const, slots: over.map((slot) => slot.index), numbers: { budget: cap, worst: Math.max(...over.map((slot) => slot.instructions)) } }]
        : []),
    ];
    return { ...plan, slots, ...(all.length > 0 ? { warnings: all } : {}) };
  };
  const bounded = planCore(inputUnits, previous, limits, mode);
  if (!bounded.blocked) return annotate(bounded, []);
  const bytesOnly = planCore(inputUnits, previous, { ...limits, maxInstructions: undefined }, mode);
  if (bytesOnly.blocked) return bytesOnly;
  return annotate(bytesOnly, [{ code: "INSTRUCTION_BUDGET_UNREACHABLE", slots: [], numbers: { budget: cap, allowedSlots: limits.maxSlots, ...bounded.blocked.numbers } }]);
}
