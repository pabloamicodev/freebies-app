import { discountCodes, getDb, offers, shops } from "@promo/db";
import { and, count, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { FUNCTION_CONFIG_NAMESPACES, publishOffersForShop } from "./sync/offer-publisher.server.js";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import { configHash, readPublishManifest, type PublishManifest } from "./publish-manifest.server.js";
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
  failures: Array<{ shopId: string; error: string }>;
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

interface DriftNode {
  __typename?: string;
  id?: string;
  [alias: `m${number}`]: { value: string } | null | undefined;
  automaticDiscount?: { status?: string } | null;
  codeDiscount?: { status?: string; codesCount?: { count: number } | null } | null;
}

interface DriftDeps {
  graphQL: typeof shopifyGraphQL;
  publish: (shopId: string, shopDomain: string) => Promise<unknown>;
}

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
            automaticDiscount { ... on DiscountAutomaticApp { status } }
          }
          ... on DiscountCodeNode {
            id
            ${metafieldSelections}
            codeDiscount { ... on DiscountCodeApp { status codesCount { count } } }
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
      return { namespace, hash: value ? configHash(value) : null };
    });
    const wrong = copies.find((copy) => copy.hash !== expected.hash);
    if (wrong) {
      findings.push({
        ...base,
        issue: "config_mismatch",
        nodeId: id,
        detail: `${wrong.namespace} metafield ${wrong.hash ? "differs from the last publish" : "is missing"}`,
      });
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
    if (!validation) findings.push({ ...base, issue: "validation_missing" });
    else if (
      [validation.metafield, validation.appMetafield].some(
        (copy) => !copy?.value || configHash(copy.value) !== manifest.validationHash,
      )
    ) {
      findings.push({ ...base, issue: "validation_mismatch" });
    }
  }
  return findings.concat(await checkCodeCounts(shop, manifest, nodes));
}

/** A code node must hold exactly the codes the database says are on it. */
async function checkCodeCounts(
  shop: { id: string; domain: string },
  manifest: PublishManifest | null,
  nodes: Record<string, DriftNode | null>,
): Promise<DriftFinding[]> {
  const codeNodeIds = Object.entries(manifest?.nodes ?? {})
    .filter(([id, node]) => (node.kind === "code" || node.kind === "code-delivery") && node.active && nodes[id])
    .map(([id]) => id);
  if (codeNodeIds.length === 0) return [];
  const db = getDb();
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
): Promise<number> {
  const db = getDb();
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
  const graphQL = deps.graphQL ?? shopifyGraphQL;
  const publish = deps.publish ?? publishOffersForShop;
  const db = getDb();
  const activeShops = await db
    .select({
      id: shops.id,
      domain: shops.myshopifyDomain,
      accessTokenEncrypted: shops.accessTokenEncrypted,
      discountId: shops.discountId,
      deliveryDiscountId: shops.deliveryDiscountId,
    })
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
      const shop = {
        id: row.id,
        domain: row.domain,
        accessToken: await decryptToken(row.accessTokenEncrypted),
        discountId: row.discountId,
        deliveryDiscountId: row.deliveryDiscountId,
      };
      const manifest = await readPublishManifest(row.id);
      if (manifest && Date.now() - Date.parse(manifest.updatedAt) < (deps.settleMs ?? 120_000)) continue;
      const found = await checkShopDrift(shop, manifest, graphQL);
      if (found.length === 0) continue;
      result.drifted += 1;

      const summary = (list: DriftFinding[]) => list.map(({ issue, nodeId, detail }) => ({ issue, nodeId, detail }));
      if (globallyPaused || (await isDriftRepairPausedForShop(row.id))) {
        result.paused += 1;
        Sentry.captureMessage("Discount drift detected, repair is paused", {
          level: "info",
          tags: { shopId: row.id, cron: "drift-repair" },
          extra: { scope: globallyPaused ? "DRIFT_REPAIR_DISABLED" : "drift_repair.paused", findings: summary(found) },
        });
        continue;
      }

      await reactivateAutomaticNodes(shop, found, graphQL);
      for (const finding of found) {
        if (finding.issue === "code_count_mismatch" && finding.nodeId) {
          await queueMissingCodesForReadd(shop, finding.nodeId, graphQL);
        }
      }
      const outcome = await publish(row.id, row.domain);
      if (outcome === "pending") {
        // The publish was parked behind a lock or a timed-out request; its retry rewrites the manifest.
        // Checking now would compare against the old manifest and raise a false alert.
        result.deferred += 1;
        continue;
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
        await readPublishManifest(row.id),
        graphQL,
      );
      if (after.length === 0) {
        result.repaired += 1;
        Sentry.captureMessage("Discount drift repaired", {
          level: "warning",
          tags: { shopId: row.id, cron: "drift-repair" },
          extra: { findings: summary(found) },
        });
      } else {
        result.unresolved.push(...after);
        Sentry.captureMessage("Discount drift could not be repaired", {
          level: "error",
          tags: { shopId: row.id, cron: "drift-repair" },
          extra: { findings: summary(after) },
        });
      }
    } catch (error) {
      result.failures.push({ shopId: row.id, error: error instanceof Error ? error.message : String(error) });
      Sentry.captureException(error, { tags: { shopId: row.id, cron: "drift-repair" } });
    }
  }
  return result;
}
