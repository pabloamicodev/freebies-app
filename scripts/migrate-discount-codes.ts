/**
 * Moves legacy code gating (enabled `discount_code` conditions and
 * `offers.requiredDiscountCode`) onto the discount_codes table.
 *
 *   pnpm exec tsx --env-file=.env scripts/migrate-discount-codes.ts            # dry run (default)
 *   pnpm exec tsx --env-file=.env scripts/migrate-discount-codes.ts --apply    # writes
 *
 * Dry run only reads. Nothing is touched on Shopify either way; migrated
 * offers keep their live code node, and the next publish takes it over.
 */
import process from "node:process";
import { closeDb, getDb } from "@promo/db";
import { migrateLegacyDiscountCodes } from "../apps/shopify-admin/app/lib/discount-code-migration.server.js";

const apply = process.argv.includes("--apply");
const shopId = process.argv.find((arg) => arg.startsWith("--shop="))?.slice("--shop=".length);

async function main() {
  try {
    const report = await migrateLegacyDiscountCodes(getDb(), { apply, shopId });
    console.info(apply ? "APPLIED" : "DRY RUN (no changes written)");
    console.info(
      `offers with a discount_code condition to convert: ${report.conditionOffers.length}`,
    );
    console.info(
      `offers with requiredDiscountCode to convert:      ${report.requiredCodeOffers.length}`,
    );
    const liveNodes = report.requiredCodeOffers.filter((offer) => offer.codeDiscountId);
    console.info(`  of which already have a live Shopify code node:  ${liveNodes.length}`);
    console.info(
      `disabled discount_code rows to drop:               ${report.disabledConditionRowsDropped}`,
    );
    console.info(`archived offers skipped:                           ${report.skippedArchived}`);
    console.info(`conflicts needing a human:                         ${report.conflicts.length}`);
    for (const conflict of report.conflicts) {
      console.info(`  - ${conflict.internalName} (${conflict.offerId}): ${conflict.error}`);
    }
    for (const offer of liveNodes) {
      console.info(
        `  live node: ${offer.internalName} code=${offer.code} node=${offer.codeDiscountId}`,
      );
    }
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
