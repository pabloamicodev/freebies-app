/**
 * Backfills offer_customer_usages from Shopify order history for one shop (limits DL3).
 *
 *   tsx scripts/backfill-offer-usage.ts --shop <myshopify domain> [--offer <id>] [--since <YYYY-MM-DD>]
 *       [--batch <rows per insert>] [--poll-seconds <n>] [--env <file>] [--apply]
 *
 * Dry-run (default) runs the read-only Shopify bulk orders query and prints per-offer counts, nothing else.
 * --apply inserts rows (ON CONFLICT DO NOTHING, source "backfill") and marks the affected customers
 * pending so the cron pushes their metafields. Only offers with a per-customer limit
 * (max_applications_per_customer > 0 or an enabled one_use_per_customer condition) are considered.
 * Only customer and order GIDs are handled; no emails or tokens are fetched or printed.
 */

import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnvironment() {
  for (const file of [...(arg("--env") ? [arg("--env")!] : []), ".env", ".env.local"]) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadEnvironment();
  const apply = process.argv.includes("--apply");
  const shopDomain = arg("--shop");
  if (!shopDomain) throw new Error("--shop <myshopify domain> is required");
  const onlyOffer = arg("--offer");
  const batch = Number(arg("--batch") ?? 500);
  const pollMs = Number(arg("--poll-seconds") ?? 5) * 1000;
  if (!Number.isInteger(batch) || batch < 1 || !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error("--batch must be a positive integer and --poll-seconds a non-negative number");
  }
  const sinceArg = arg("--since");
  if (sinceArg && Number.isNaN(Date.parse(sinceArg))) throw new Error("--since must be a date like 2026-01-31");

  const [
    { and, eq, ne, or, gt, exists, sql },
    { closeDb, getDb, offers, offerCombinationPolicies, offerConditions, shops, shopifySessions, discountCodes },
    { shopifyGraphQL },
    { decryptToken },
    { applyBackfillUsages, buildBulkOrdersQuery, parseBulkOrdersJsonl },
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
    import("../apps/shopify-admin/app/lib/token-crypto.server.js"),
    import("../apps/shopify-admin/app/lib/offer-usage-backfill.server.js"),
  ]);

  console.log(apply ? "APPLY mode: writing rows." : "DRY-RUN: no writes. Pass --apply to write.");
  const db = getDb();
  try {
    const [shop] = await db
      .select({ id: shops.id, isActive: shops.isActive })
      .from(shops)
      .where(eq(shops.myshopifyDomain, shopDomain))
      .limit(1);
    if (!shop?.isActive) throw new Error(`${shopDomain} is not an active shop.`);

    const allOffers = await db
      .select({
        id: offers.id,
        internalName: offers.internalName,
        publicTitle: offers.publicTitle,
        requiresCode: offers.requiresCode,
        requiredDiscountCode: offers.requiredDiscountCode,
        createdAt: offers.createdAt,
      })
      .from(offers)
      .where(and(eq(offers.shopId, shop.id), ne(offers.status, "archived")));
    const limitedRows = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(
          eq(offers.shopId, shop.id),
          ne(offers.status, "archived"),
          or(
            exists(
              db
                .select({ one: sql`1` })
                .from(offerCombinationPolicies)
                .where(and(eq(offerCombinationPolicies.offerId, offers.id), gt(offerCombinationPolicies.maxApplicationsPerCustomer, 0))),
            ),
            exists(
              db
                .select({ one: sql`1` })
                .from(offerConditions)
                .where(
                  and(
                    eq(offerConditions.offerId, offers.id),
                    eq(offerConditions.conditionType, "one_use_per_customer"),
                    eq(offerConditions.isEnabled, true),
                  ),
                ),
            ),
          ),
        ),
      );
    const targets = new Set(limitedRows.map((r) => r.id).filter((id) => !onlyOffer || id === onlyOffer));
    if (onlyOffer && targets.size === 0) throw new Error(`Offer ${onlyOffer} is not a non-archived offer with a per-customer limit in this shop.`);
    if (targets.size === 0) {
      console.log("No offers with a per-customer limit. Nothing to do.");
      return;
    }
    const targetOffers = allOffers.filter((o) => targets.has(o.id));
    const since = sinceArg ?? new Date(Math.min(...targetOffers.map((o) => o.createdAt.getTime()))).toISOString().slice(0, 10);
    console.log(`shop ${shopDomain}: ${targets.size} limited offer(s), orders since ${since}`);

    const codeRows = await db
      .select({ offerId: discountCodes.offerId, code: discountCodes.code })
      .from(discountCodes)
      .where(eq(discountCodes.shopId, shop.id));
    const codeOfferIds = new Map<string, string[]>();
    for (const { offerId, code } of codeRows) codeOfferIds.set(code, [...(codeOfferIds.get(code) ?? []), offerId]);

    const [session] = await db
      .select({ accessToken: shopifySessions.accessToken })
      .from(shopifySessions)
      .where(and(eq(shopifySessions.shop, shopDomain), eq(shopifySessions.isOnline, false)))
      .limit(1);
    if (!session?.accessToken) throw new Error(`No offline Shopify session exists for ${shopDomain}.`);
    const accessToken = await decryptToken(session.accessToken);
    const admin = <T>(query: string, variables: Record<string, unknown> = {}) =>
      shopifyGraphQL<T>({ shopDomain, accessToken, query, variables, timeoutMs: 30_000 });

    const started = await admin<{
      bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: Array<{ message: string }> };
    }>(
      `mutation BackfillOrders($query: String!) {
        bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } }
      }`,
      { query: buildBulkOrdersQuery(since) },
    );
    const { bulkOperation, userErrors } = started.bulkOperationRunQuery;
    if (!bulkOperation || userErrors.length > 0) {
      throw new Error(`Bulk operation not started: ${userErrors.map((e) => e.message).join(", ") || "unknown"}`);
    }
    console.log("bulk operation started; waiting for Shopify...");

    let url: string | null = null;
    let objectCount = "0";
    for (;;) {
      await sleep(pollMs);
      const { node } = await admin<{
        node: { status: string; errorCode: string | null; url: string | null; objectCount: string } | null;
      }>(`query BackfillStatus($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode url objectCount } } }`, {
        id: bulkOperation.id,
      });
      if (!node) throw new Error("Bulk operation disappeared.");
      if (node.status === "COMPLETED") {
        url = node.url;
        objectCount = node.objectCount;
        break;
      }
      if (["FAILED", "CANCELED", "EXPIRED"].includes(node.status)) {
        throw new Error(`Bulk operation ${node.status}${node.errorCode ? ` (${node.errorCode})` : ""}.`);
      }
    }

    let jsonl = "";
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Bulk result download failed: ${res.status}`);
      jsonl = await res.text();
    }
    console.log(`downloaded ${objectCount} object(s)`);

    const parsed = parseBulkOrdersJsonl(jsonl.split("\n"), allOffers, codeOfferIds, targets);
    const perOffer = new Map<string, { orders: number; customers: Set<string> }>();
    for (const r of parsed.rows) {
      const entry = perOffer.get(r.offerId) ?? { orders: 0, customers: new Set<string>() };
      entry.orders += 1;
      entry.customers.add(r.customerGid);
      perOffer.set(r.offerId, entry);
    }
    console.log(`\norders scanned: ${parsed.orders}, usage rows: ${parsed.rows.length}, skipped lines: ${parsed.skipped}`);
    for (const o of targetOffers) {
      const e = perOffer.get(o.id);
      console.log(`- ${o.internalName} [${o.id}]: ${e?.orders ?? 0} order(s), ${e?.customers.size ?? 0} customer(s)`);
    }

    if (!apply) {
      console.log("\nDry-run only. Re-run with --apply to insert.");
      return;
    }
    const result = await applyBackfillUsages(db, shop.id, parsed.rows, batch);
    console.log(`\napplied: ${result.inserted} new row(s) (${parsed.rows.length - result.inserted} already present), ${result.customersMarked} customer(s) marked pending for the metafield push.`);
  } finally {
    await closeDb();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
