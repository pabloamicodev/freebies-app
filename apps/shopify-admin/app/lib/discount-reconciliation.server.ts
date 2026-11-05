import { createHash } from "node:crypto";
import { discountCodes, getDb, offers, shops, type Db } from "@promo/db";
import { and, count, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { FUNCTION_CONFIG_NAMESPACES, publishOffersForShop } from "./sync/offer-publisher.server.js";
import { ShardPlanBlockedError } from "./sync/cart-shards.server.js";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import { configHash, readPublishManifest, type PublishManifest } from "./publish-manifest.server.js";
import { insertAuditLog } from "./audit-log.server.js";
import { isDriftRepairGloballyDisabled, isDriftRepairPausedForShop } from "./drift-repair-settings.server.js";
import {
  VALIDATION_FUNCTION_HANDLE,
  VALIDATION_METAFIELD_KEY,
  VALIDATION_APP_METAFIELD_NAMESPACE,
  VALIDATION_METAFIELD_NAMESPACE,
} from "./cart-validation.server.js";

export interface DiscountReconciliationTarget {
  shopId: string;
  shopDomain: string;
}

export interface DiscountReconciliationResult {
  attempted: number;
  succeeded: number;
  failures: Array<{ shopId: string; error: string; capacity?: ShardPlanBlockedError["capacity"] }>;
}

export function needsDiscountReconciliation(state: {
  discountId: string | null;
  deliveryDiscountId: string | null;
  compiledConfig: unknown | null;
}): boolean {
  return (
    state.discountId === null || state.deliveryDiscountId === null || state.compiledConfig === null
  );
}

export async function executeDiscountNodeReconciliation(
  targets: DiscountReconciliationTarget[],
  publishShop: (shopId: string, shopDomain: string) => Promise<unknown>,
): Promise<DiscountReconciliationResult> {
  const uniqueTargets = [...new Map(targets.map((target) => [target.shopId, target])).values()];
  const failures: DiscountReconciliationResult["failures"] = [];
  let succeeded = 0;

  // Sequential publication avoids a burst of Admin API mutations and keeps
  // each store's two discount nodes synchronized before moving to the next.
  for (const target of uniqueTargets) {
    try {
      await publishShop(target.shopId, target.shopDomain);
      succeeded += 1;
    } catch (error) {
      failures.push({
        shopId: target.shopId,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ShardPlanBlockedError ? { capacity: error.capacity } : {}),
      });
    }
  }

  return { attempted: uniqueTargets.length, succeeded, failures };
}

export async function reconcileActiveShopDiscountNodes(): Promise<DiscountReconciliationResult> {
  const db = getDb();
  const missing = await db
    .select({ shopId: shops.id, shopDomain: shops.myshopifyDomain })
    .from(shops)
    .innerJoin(offers, and(eq(offers.shopId, shops.id), eq(offers.status, "active")))
    .where(
      and(
        eq(shops.isActive, true),
        or(
          isNull(shops.discountId),
          isNull(shops.deliveryDiscountId),
          isNull(offers.compiledConfig),
        ),
      ),
    );
  // A publish that lost the per-shop lock was parked, not failed: this is its backstop.
  const pending = await db
    .select({ shopId: shops.id, shopDomain: shops.myshopifyDomain })
    .from(shops)
    .where(and(eq(shops.isActive, true), isNotNull(shops.publishPendingAt)));

  return executeDiscountNodeReconciliation([...missing, ...pending], publishOffersForShop);
}

// ─── Drift detection and repair ─────────────────────────────────────────────

export type DriftIssue =
  | "missing_node"
  | "config_mismatch"
  | "inactive_node"
  | "code_count_mismatch"
  | "purchase_type_mismatch"
  | "validation_mismatch"
  | "validation_missing"
  | "missing_manifest";

export interface DriftFinding {
  shopId: string;
  shopDomain: string;
  issue: DriftIssue;
  nodeId?: string;
  detail?: string;
}

export interface DiscountDriftResult {
  shops: number;
  drifted: number;
  repaired: number;
  /** Drift found but not repaired because repair is paused (kill switch); one info event per shop. */
  paused: number;
  /** The repair publish was parked (lock timeout / unknown outcome); the cron retries it, no alert. */
  deferred: number;
  /** Still wrong after the repair publish; an alert was raised for each shop. */
  unresolved: DriftFinding[];
  failures: Array<{ shopId: string; error: string }>;
}

interface PurchaseTypeState {
  status?: string;
  appliesOnSubscription?: boolean | null;
  appliesOnOneTimePurchase?: boolean | null;
}

interface DriftNode {
  __typename?: string;
  id?: string;
  [alias: `m${number}`]: { value: string } | null | undefined;
  automaticDiscount?: PurchaseTypeState | null;
  codeDiscount?: (PurchaseTypeState & { codesCount?: { count: number } | null }) | null;
}

interface DriftDeps {
  graphQL: typeof shopifyGraphQL;
  publish: (shopId: string, shopDomain: string) => Promise<unknown>;
}

/** What the check observed beyond the findings; lets a dry run show current vs expected per item. */
interface DriftFacts {
  nodes: Record<
    string,
    {
      status?: string;
      appliesOnSubscription?: boolean | null;
      appliesOnOneTimePurchase?: boolean | null;
      copies: Array<{ namespace: string; hash: string | null; bytes: number | null }>;
    }
  >;
  codeCounts: Record<string, { actual: number; expected: number }>;
  validation?: { present: boolean; copies: Array<string | null> };
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

// Every namespace the publisher writes must hold the published config: Functions read the
// $app one, so a shop whose new copy was never written counts as drifted and gets republished.
const metafieldSelections = FUNCTION_CONFIG_NAMESPACES.map(
  (namespace, index) => `m${index}: metafield(namespace: "${namespace}", key: "function_config") { value }`,
).join(" ");

/** Reads every node the last publish wrote and compares it with what that publish pushed. */
async function checkShopDrift(
  shop: { id: string; domain: string; accessToken: string; discountId: string | null; deliveryDiscountId: string | null },
  manifest: PublishManifest | null,
  graphQL: DriftDeps["graphQL"],
  db: Db,
  facts?: DriftFacts,
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];
  const base = { shopId: shop.id, shopDomain: shop.domain };
  // Published before manifests existed: nothing to compare against, and its Functions may
  // still lack the $app:promo_engine copy. One republish writes both and records a manifest.
  if (!manifest) findings.push({ ...base, issue: "missing_manifest" });
  const nodeIds = [
    ...new Set([
      ...Object.keys(manifest?.nodes ?? {}),
      ...(shop.discountId ? [shop.discountId] : []),
      ...(shop.deliveryDiscountId ? [shop.deliveryDiscountId] : []),
    ]),
  ];

  const nodes: Record<string, DriftNode | null> = {};
  for (let offset = 0; offset < nodeIds.length; offset += 50) {
    const ids = nodeIds.slice(offset, offset + 50);
    const data = await graphQL<{ nodes: Array<DriftNode | null> }>({
      shopDomain: shop.domain,
      accessToken: shop.accessToken,
      query: `query PromoEngineDriftCheck($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on DiscountAutomaticNode {
            id
            ${metafieldSelections}
            automaticDiscount { ... on DiscountAutomaticApp { status appliesOnSubscription appliesOnOneTimePurchase } }
          }
          ... on DiscountCodeNode {
            id
            ${metafieldSelections}
            codeDiscount { ... on DiscountCodeApp { status appliesOnSubscription appliesOnOneTimePurchase codesCount { count } } }
          }
        }
      }`,
      variables: { ids },
    });
    ids.forEach((id, index) => {
      const node = data.nodes[index];
      nodes[id] = node && node.id ? node : null;
    });
  }

  for (const id of nodeIds) {
    const node = nodes[id];
    if (!node) {
      findings.push({ ...base, issue: "missing_node", nodeId: id });
      continue;
    }
    const expected = manifest?.nodes[id];
    if (!expected) continue;
    const copies = FUNCTION_CONFIG_NAMESPACES.map((namespace, index) => {
      const value = node[`m${index}`]?.value;
      return { namespace, hash: value ? configHash(value) : null, bytes: value ? byteLength(value) : null };
    });
    const wrong = copies.find((copy) => copy.hash !== expected.hash);
    if (facts) {
      facts.nodes[id] = {
        status: node.automaticDiscount?.status ?? node.codeDiscount?.status,
        appliesOnSubscription: (node.automaticDiscount ?? node.codeDiscount)?.appliesOnSubscription,
        appliesOnOneTimePurchase: (node.automaticDiscount ?? node.codeDiscount)?.appliesOnOneTimePurchase,
        copies,
      };
    }
    if (wrong) {
      findings.push({
        ...base,
        issue: "config_mismatch",
        nodeId: id,
        detail: `${wrong.namespace} metafield ${wrong.hash ? "differs from the last publish" : "is missing"}`,
      });
    }
    // Shopify skips app discounts on selling-plan lines when appliesOnSubscription is false (the
    // pre-2026-07 default), so an old node needs one republish, which re-sends both flags.
    const live = node.automaticDiscount ?? node.codeDiscount;
    const wantsSubscription = expected.appliesOnSubscription ?? true;
    const wantsOneTime = expected.appliesOnOneTimePurchase ?? true;
    const wrongFlags = [
      live?.appliesOnSubscription != null && live.appliesOnSubscription !== wantsSubscription
        ? `appliesOnSubscription is ${live.appliesOnSubscription}, expected ${wantsSubscription}`
        : null,
      live?.appliesOnOneTimePurchase != null && live.appliesOnOneTimePurchase !== wantsOneTime
        ? `appliesOnOneTimePurchase is ${live.appliesOnOneTimePurchase}, expected ${wantsOneTime}`
        : null,
    ].filter((message): message is string => message !== null);
    if (wrongFlags.length > 0) {
      findings.push({ ...base, issue: "purchase_type_mismatch", nodeId: id, detail: wrongFlags.join("; ") });
    }
    const status = node.automaticDiscount?.status ?? node.codeDiscount?.status;
    if (expected.active && status && status !== "ACTIVE") {
      findings.push({ ...base, issue: "inactive_node", nodeId: id, detail: `status ${status}` });
    }
  }

  if (manifest?.validationHash) {
    const data = await graphQL<{
      validations: {
        nodes: Array<{
          shopifyFunction: { handle: string };
          metafield: { value: string } | null;
          appMetafield: { value: string } | null;
        }>;
      };
    }>({
      shopDomain: shop.domain,
      accessToken: shop.accessToken,
      query: `query PromoEngineValidationDrift {
        validations(first: 25) {
          nodes {
            shopifyFunction { handle }
            metafield(namespace: "${VALIDATION_METAFIELD_NAMESPACE}", key: "${VALIDATION_METAFIELD_KEY}") { value }
            appMetafield: metafield(namespace: "${VALIDATION_APP_METAFIELD_NAMESPACE}", key: "${VALIDATION_METAFIELD_KEY}") { value }
          }
        }
      }`,
    });
    const validation = data.validations.nodes.find(
      (node) => node.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE,
    );
    if (facts) {
      facts.validation = {
        present: Boolean(validation),
        copies: validation ? [validation.metafield, validation.appMetafield].map((copy) => (copy?.value ? configHash(copy.value) : null)) : [],
      };
    }
    if (!validation) findings.push({ ...base, issue: "validation_missing" });
    else if (
      [validation.metafield, validation.appMetafield].some(
        (copy) => !copy?.value || configHash(copy.value) !== manifest.validationHash,
      )
    ) {
      findings.push({ ...base, issue: "validation_mismatch" });
    }
  }
  return findings.concat(await checkCodeCounts(shop, manifest, nodes, db, facts));
}

/** A code node must hold exactly the codes the database says are on it. */
async function checkCodeCounts(
  shop: { id: string; domain: string },
  manifest: PublishManifest | null,
  nodes: Record<string, DriftNode | null>,
  db: Db,
  facts?: DriftFacts,
): Promise<DriftFinding[]> {
  const codeNodeIds = Object.entries(manifest?.nodes ?? {})
    .filter(([id, node]) => (node.kind === "code" || node.kind === "code-delivery") && node.active && nodes[id])
    .map(([id]) => id);
  if (codeNodeIds.length === 0) return [];
  const owners = await db
    .select({ id: offers.id, codeDiscountId: offers.codeDiscountId })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), inArray(offers.codeDiscountId, codeNodeIds)));
  if (owners.length === 0) return [];
  const ownerIds = owners.map((offer) => offer.id);
  const [synced, inFlight] = await Promise.all([
    db
      .select({ offerId: discountCodes.offerId, total: count() })
      .from(discountCodes)
      .where(
        and(
          eq(discountCodes.shopId, shop.id),
          inArray(discountCodes.offerId, ownerIds),
          isNotNull(discountCodes.shopifySyncedAt),
        ),
      )
      .groupBy(discountCodes.offerId),
    db
      .select({ offerId: discountCodes.offerId })
      .from(discountCodes)
      .where(
        and(
          eq(discountCodes.shopId, shop.id),
          inArray(discountCodes.offerId, ownerIds),
          isNotNull(discountCodes.shopifySyncPendingAt),
        ),
      ),
  ]);
  const syncedByOffer = new Map(synced.map((row) => [row.offerId, Number(row.total)]));
  const busy = new Set(inFlight.map((row) => row.offerId));
  const findings: DriftFinding[] = [];
  for (const offer of owners) {
    const node = offer.codeDiscountId ? nodes[offer.codeDiscountId] : null;
    const actual = node?.codeDiscount?.codesCount?.count;
    const expected = syncedByOffer.get(offer.id);
    // Legacy single-code offers have no rows; rows in flight make the count legitimately unsettled.
    if (actual === undefined || expected === undefined || busy.has(offer.id)) continue;
    if (actual !== expected) {
      if (facts && offer.codeDiscountId) facts.codeCounts[offer.codeDiscountId] = { actual, expected };
      findings.push({
        shopId: shop.id,
        shopDomain: shop.domain,
        issue: "code_count_mismatch",
        nodeId: offer.codeDiscountId ?? undefined,
        detail: `Shopify has ${actual} codes, the app expects ${expected}`,
      });
    }
  }
  return findings;
}

const NODE_CODES_MAX_PAGES = 100;

/** Every code on a code node, uppercased; null when the node is too big to list (a repair can't pinpoint codes). */
async function readNodeCodes(
  shop: { domain: string; accessToken: string },
  nodeId: string,
  graphQL: DriftDeps["graphQL"],
): Promise<Set<string> | null> {
  const codes = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < NODE_CODES_MAX_PAGES; page += 1) {
    const data: {
      codeDiscountNode: {
        codeDiscount: {
          codes?: { nodes: Array<{ code: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        };
      } | null;
    } = await graphQL({
      shopDomain: shop.domain,
      accessToken: shop.accessToken,
      query: `query PromoEngineNodeCodes($id: ID!, $after: String) {
        codeDiscountNode(id: $id) {
          codeDiscount { ... on DiscountCodeApp { codes(first: 250, after: $after) { nodes { code } pageInfo { hasNextPage endCursor } } } }
        }
      }`,
      variables: { id: nodeId, after },
    });
    const connection = data.codeDiscountNode?.codeDiscount.codes;
    if (!connection) return codes;
    for (const node of connection.nodes) codes.add(node.code.toUpperCase());
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) return codes;
    after = connection.pageInfo.endCursor;
  }
  return null;
}

/**
 * A code the database says is on a node but Shopify doesn't have (deleted in the Shopify admin) is
 * queued for exactly one re-add: its synced flag is cleared and the repair publish attaches it again.
 * If that re-add fails (taken by another discount, rejected) the publisher disables the code with a
 * note, so the same deletion can never keep the drift repair running.
 */
export async function queueMissingCodesForReadd(
  shop: { id: string; domain: string; accessToken: string },
  codeNodeId: string,
  graphQL: DriftDeps["graphQL"],
  db: Db = getDb(),
): Promise<number> {
  const [offer] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.codeDiscountId, codeNodeId)))
    .limit(1);
  if (!offer) return 0;
  const onNode = await readNodeCodes(shop, codeNodeId, graphQL);
  if (!onNode) {
    Sentry.captureMessage("Code node too large to pinpoint missing codes", {
      level: "warning",
      tags: { shopId: shop.id, cron: "drift-repair" },
      extra: { nodeId: codeNodeId },
    });
    return 0;
  }
  const synced = await db
    .select({ id: discountCodes.id, code: discountCodes.code })
    .from(discountCodes)
    .where(
      and(
        eq(discountCodes.shopId, shop.id),
        eq(discountCodes.offerId, offer.id),
        isNotNull(discountCodes.shopifySyncedAt),
        isNull(discountCodes.shopifySyncPendingAt),
      ),
    );
  const missing = synced.filter((row) => !onNode.has(row.code.toUpperCase()));
  for (let offset = 0; offset < missing.length; offset += 1_000) {
    await db
      .update(discountCodes)
      .set({ shopifySyncedAt: null, shopifyReaddAttemptedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(discountCodes.shopId, shop.id),
          inArray(
            discountCodes.id,
            missing.slice(offset, offset + 1_000).map((row) => row.id),
          ),
        ),
      );
  }
  return missing.length;
}

async function reactivateAutomaticNodes(
  shop: { domain: string; accessToken: string },
  findings: DriftFinding[],
  graphQL: DriftDeps["graphQL"],
): Promise<void> {
  for (const finding of findings) {
    if (finding.issue !== "inactive_node" || !finding.nodeId?.includes("DiscountAutomaticNode")) continue;
    await graphQL({
      shopDomain: shop.domain,
      accessToken: shop.accessToken,
      retryable: true,
      query: `mutation PromoEngineActivateAutomatic($id: ID!) {
        discountAutomaticActivate(id: $id) { userErrors { field message } }
      }`,
      variables: { id: finding.nodeId },
    });
  }
}

export interface DriftItem {
  issue: DriftIssue;
  target: "metafield" | "discount_node" | "validation" | "settings";
  nodeId?: string;
  namespace?: string;
  detail?: string;
  current: unknown;
  expected: unknown;
  bytesBefore: number | null;
  bytesAfter: number | null;
  action: string;
}

export type DriftRepairOutcome =
  | "no_nodes"
  | "settling"
  | "clean"
  | "drifted"
  | "paused"
  | "diff_changed"
  | "deferred"
  | "repaired"
  | "unresolved";

export interface DriftRepairResult {
  outcome: DriftRepairOutcome;
  findings: DriftFinding[];
  items: DriftItem[];
  /** sha256 of the items: a confirm token bound to it refuses a repair if the diff moved. */
  diffHash: string;
  wouldWrite: string[];
  unresolved: DriftFinding[];
}

export interface DriftRepairContext extends Partial<DriftDeps> {
  /** A shop published more recently than this is left alone: its metafields may be mid-write. */
  settleMs?: number;
  globallyPaused?: boolean;
}

const shortHash = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : null);

function describeDrift(findings: DriftFinding[], facts: DriftFacts, manifest: PublishManifest | null): DriftItem[] {
  const items: DriftItem[] = [];
  const republish = "republish the shop config";
  for (const finding of findings) {
    const { issue, nodeId, detail } = finding;
    const node = nodeId ? facts.nodes[nodeId] : undefined;
    const expected = nodeId ? manifest?.nodes[nodeId] : undefined;
    if (issue === "config_mismatch" && node && expected) {
      const good = node.copies.find((copy) => copy.hash === expected.hash);
      for (const copy of node.copies.filter((c) => c.hash !== expected.hash)) {
        items.push({
          issue,
          target: "metafield",
          nodeId,
          namespace: copy.namespace,
          detail,
          current: { hash: shortHash(copy.hash), missing: copy.hash === null },
          expected: { hash: shortHash(expected.hash) },
          bytesBefore: copy.bytes,
          bytesAfter: good?.bytes ?? null,
          action: `rewrite ${copy.namespace}/function_config through ${republish}`,
        });
      }
    } else if (issue === "inactive_node") {
      items.push({
        issue,
        target: "discount_node",
        nodeId,
        detail,
        current: { status: node?.status ?? null },
        expected: { status: "ACTIVE" },
        bytesBefore: null,
        bytesAfter: null,
        action: nodeId?.includes("DiscountAutomaticNode") ? "discountAutomaticActivate, then republish" : `${republish} (reopens the code node's end date)`,
      });
    } else if (issue === "purchase_type_mismatch") {
      items.push({
        issue,
        target: "discount_node",
        nodeId,
        detail,
        current: { appliesOnSubscription: node?.appliesOnSubscription ?? null, appliesOnOneTimePurchase: node?.appliesOnOneTimePurchase ?? null },
        expected: { appliesOnSubscription: expected?.appliesOnSubscription ?? true, appliesOnOneTimePurchase: expected?.appliesOnOneTimePurchase ?? true },
        bytesBefore: null,
        bytesAfter: null,
        action: republish,
      });
    } else if (issue === "code_count_mismatch") {
      const counts = nodeId ? facts.codeCounts[nodeId] : undefined;
      items.push({
        issue,
        target: "discount_node",
        nodeId,
        detail,
        current: { codes: counts?.actual ?? null },
        expected: { codes: counts?.expected ?? null },
        bytesBefore: null,
        bytesAfter: null,
        action: `queue the codes missing on Shopify for one re-add, then ${republish}`,
      });
    } else if (issue === "missing_node") {
      items.push({
        issue,
        target: "discount_node",
        nodeId,
        detail,
        current: null,
        expected: { kind: expected?.kind ?? null },
        bytesBefore: null,
        bytesAfter: null,
        action: `recreate the node through ${republish}`,
      });
    } else if (issue === "validation_mismatch" || issue === "validation_missing") {
      items.push({
        issue,
        target: "validation",
        detail,
        current: facts.validation?.present ? { hashes: facts.validation.copies.map(shortHash) } : null,
        expected: { hash: shortHash(manifest?.validationHash) },
        bytesBefore: null,
        bytesAfter: null,
        action: `rewrite the cart-validation config through ${republish}`,
      });
    } else {
      items.push({
        issue,
        target: "settings",
        detail,
        current: manifest ? { updatedAt: manifest.updatedAt } : null,
        expected: { manifest: true },
        bytesBefore: null,
        bytesAfter: null,
        action: `${republish} (writes both metafield copies and records a manifest)`,
      });
    }
  }
  return items;
}

const summarize = (list: DriftFinding[]) => list.map(({ issue, nodeId, detail }) => ({ issue, nodeId, detail }));

/**
 * One shop's drift check and repair; the cron calls it per shop and the MCP drift_repair_settings
 * tool calls it with a dry run first. A dry run only reads Shopify and never writes. `expectedDiffHash`
 * makes the repair refuse (`diff_changed`) when what is out of sync differs from what was previewed.
 */
export async function repairShopDrift(
  db: Db,
  ctx: DriftRepairContext,
  options: {
    shopId: string;
    dryRun: boolean;
    performedBy?: string;
    auditExtra?: Record<string, unknown>;
    expectedDiffHash?: string | null;
  },
): Promise<DriftRepairResult> {
  const graphQL = ctx.graphQL ?? shopifyGraphQL;
  const publish = ctx.publish ?? publishOffersForShop;
  const empty = (outcome: DriftRepairOutcome, findings: DriftFinding[] = [], items: DriftItem[] = []): DriftRepairResult => ({
    outcome,
    findings,
    items,
    diffHash: createHash("sha256").update(JSON.stringify(items)).digest("hex"),
    wouldWrite: [],
    unresolved: [],
  });
  const [row] = await db
    .select({
      id: shops.id,
      domain: shops.myshopifyDomain,
      accessTokenEncrypted: shops.accessTokenEncrypted,
      discountId: shops.discountId,
      deliveryDiscountId: shops.deliveryDiscountId,
    })
    .from(shops)
    .where(eq(shops.id, options.shopId))
    .limit(1);
  if (!row) throw new Error(`Shop ${options.shopId} not found`);
  if (!row.discountId && !row.deliveryDiscountId) return empty("no_nodes");
  const shop = {
    id: row.id,
    domain: row.domain,
    accessToken: await decryptToken(row.accessTokenEncrypted),
    discountId: row.discountId,
    deliveryDiscountId: row.deliveryDiscountId,
  };
  const manifest = await readPublishManifest(row.id, db);
  if (manifest && Date.now() - Date.parse(manifest.updatedAt) < (ctx.settleMs ?? 120_000)) return empty("settling");
  const facts: DriftFacts = { nodes: {}, codeCounts: {} };
  const found = await checkShopDrift(shop, manifest, graphQL, db, facts);
  if (found.length === 0) return empty("clean");

  const items = describeDrift(found, facts, manifest);
  const base = empty("drifted", found, items);
  const globallyPaused = ctx.globallyPaused ?? isDriftRepairGloballyDisabled();
  const paused = globallyPaused || (await isDriftRepairPausedForShop(row.id, db));
  base.wouldWrite = [
    ...found
      .filter((f) => f.issue === "inactive_node" && f.nodeId?.includes("DiscountAutomaticNode"))
      .map((f) => `discountAutomaticActivate ${f.nodeId}`),
    ...found.filter((f) => f.issue === "code_count_mismatch" && f.nodeId).map((f) => `queue missing codes of ${f.nodeId} for one re-add`),
    "publish the shop config: every function_config metafield copy, the discount nodes, the cart-validation config and the publish manifest",
  ];
  if (options.dryRun) return paused ? { ...base, outcome: "paused" } : base;

  if (paused) {
    Sentry.captureMessage("Discount drift detected, repair is paused", {
      level: "info",
      tags: { shopId: row.id, cron: "drift-repair" },
      extra: { scope: globallyPaused ? "DRIFT_REPAIR_DISABLED" : "drift_repair.paused", findings: summarize(found) },
    });
    return { ...base, outcome: "paused" };
  }
  if (options.expectedDiffHash != null && options.expectedDiffHash !== base.diffHash) return { ...base, outcome: "diff_changed" };

  await reactivateAutomaticNodes(shop, found, graphQL);
  for (const finding of found) {
    if (finding.issue === "code_count_mismatch" && finding.nodeId) {
      await queueMissingCodesForReadd(shop, finding.nodeId, graphQL, db);
    }
  }
  const audit = async (outcome: DriftRepairOutcome, remaining: DriftFinding[]) => {
    if (!options.performedBy) return;
    await insertAuditLog(db, {
      shopId: row.id,
      entityType: "shop",
      entityId: row.id,
      action: "drift_repair",
      before: { items: items.map(({ issue, target, nodeId, namespace }) => ({ issue, target, nodeId, namespace })) },
      after: { outcome, unresolved: summarize(remaining), ...options.auditExtra },
      performedBy: options.performedBy,
    });
  };

  const published = await publish(row.id, row.domain);
  if (published === "pending") {
    // The publish was parked behind a lock or a timed-out request; its retry rewrites the manifest.
    // Checking now would compare against the old manifest and raise a false alert.
    await audit("deferred", []);
    return { ...base, outcome: "deferred" };
  }
  // The publish may have created nodes (new ids on the shop row) and rewrote the manifest.
  const [fresh] = await db
    .select({ discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId })
    .from(shops)
    .where(eq(shops.id, row.id))
    .limit(1);
  const after = await checkShopDrift(
    {
      ...shop,
      discountId: fresh?.discountId ?? shop.discountId,
      deliveryDiscountId: fresh?.deliveryDiscountId ?? shop.deliveryDiscountId,
    },
    await readPublishManifest(row.id, db),
    graphQL,
    db,
  );
  if (after.length === 0) {
    Sentry.captureMessage("Discount drift repaired", {
      level: "warning",
      tags: { shopId: row.id, cron: "drift-repair" },
      extra: { findings: summarize(found) },
    });
    await audit("repaired", []);
    return { ...base, outcome: "repaired" };
  }
  Sentry.captureMessage("Discount drift could not be repaired", {
    level: "error",
    tags: { shopId: row.id, cron: "drift-repair" },
    extra: { findings: summarize(after) },
  });
  await audit("unresolved", after);
  return { ...base, outcome: "unresolved", unresolved: after };
}

/**
 * Verifies, per active shop, that everything the last publish put on Shopify is still there:
 * both automatic discount nodes, the coded-shipping pool, every code node (existing, active,
 * holding the codes the database says it holds), their `function_config` metafields, and the
 * cart-validation config. Anything that drifted (the merchant deleted or edited it in the
 * Shopify admin) is repaired by one republish; what is still wrong afterwards raises a Sentry alert.
 */
export async function runDiscountDriftRepair(
  deps: Partial<DriftDeps> & {
    /** A shop published more recently than this is left alone: its metafields may be mid-write. */
    settleMs?: number;
  } = {},
): Promise<DiscountDriftResult> {
  const db = getDb();
  const activeShops = await db
    .select({ id: shops.id, discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId })
    .from(shops)
    .where(eq(shops.isActive, true));

  const globallyPaused = isDriftRepairGloballyDisabled();
  const result: DiscountDriftResult = {
    shops: 0,
    drifted: 0,
    repaired: 0,
    paused: 0,
    deferred: 0,
    unresolved: [],
    failures: [],
  };
  for (const row of activeShops) {
    // Shops that never published have nothing on Shopify to drift from.
    if (!row.discountId && !row.deliveryDiscountId) continue;
    result.shops += 1;
    try {
      const repair = await repairShopDrift(db, { ...deps, globallyPaused }, { shopId: row.id, dryRun: false });
      if (repair.findings.length === 0) continue;
      result.drifted += 1;
      if (repair.outcome === "paused") result.paused += 1;
      else if (repair.outcome === "deferred") result.deferred += 1;
      else if (repair.outcome === "repaired") result.repaired += 1;
      else if (repair.outcome === "unresolved") result.unresolved.push(...repair.unresolved);
    } catch (error) {
      result.failures.push({ shopId: row.id, error: error instanceof Error ? error.message : String(error) });
      Sentry.captureException(error, { tags: { shopId: row.id, cron: "drift-repair" } });
    }
  }
  return result;
}
