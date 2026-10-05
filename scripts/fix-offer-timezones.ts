/**
 * Re-reads offer schedules that were saved as UTC wall-clock in shops whose real zone is not UTC.
 *
 *   pnpm tsx scripts/fix-offer-timezones.ts [--shop <domain>] [--name-like <pattern>] [--env <file>] [--apply]
 *
 * Dry-run by default. Targets offers with timezone NULL/'UTC' in shops whose timezone is a real non-UTC zone,
 * status draft/scheduled/active/paused. Sets offers.timezone = shop zone. Shops with a changed active offer
 * are flagged publish-pending (the offers cron republishes them).
 */
import process from "node:process";
import { resolve } from "node:path";

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  for (const file of [flag("--env"), ".env", ".env.local"].filter(Boolean) as string[]) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  const apply = process.argv.includes("--apply");
  const shopArg = flag("--shop");
  const nameLike = flag("--name-like");
  const [{ and, eq, ilike, inArray, isNull, ne, or }, { closeDb, getDb, offers, shops }, { planTimezoneFix }] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/offer-timezone-fix.server.js"),
  ]);
  console.log(apply ? "APPLY mode: writing changes." : "DRY-RUN: no writes. Pass --apply to write.");
  const db = getDb();
  try {
    const rows = await db
      .select({
        id: offers.id, name: offers.internalName, status: offers.status, startsAt: offers.startsAt, endsAt: offers.endsAt,
        shopId: shops.id, domain: shops.myshopifyDomain, shopTz: shops.timezone,
      })
      .from(offers)
      .innerJoin(shops, eq(shops.id, offers.shopId))
      .where(and(
        ne(shops.timezone, "UTC"),
        or(isNull(offers.timezone), eq(offers.timezone, "UTC")),
        inArray(offers.status, ["draft", "scheduled", "active", "paused"]),
        shopArg ? eq(shops.myshopifyDomain, shopArg.includes(".") ? shopArg : `${shopArg}.myshopify.com`) : undefined,
        nameLike ? ilike(offers.internalName, nameLike) : undefined,
      ));
    const iso = (d: Date | null) => (d ? d.toISOString() : "-");
    const republish = new Map<string, string>();
    for (const r of rows) {
      const plan = planTimezoneFix({ status: r.status, startsAt: r.startsAt, endsAt: r.endsAt }, r.shopTz);
      if (!plan) continue;
      console.log(`- [${r.domain}] ${r.name} (${r.id}) tz ${r.shopTz}`);
      console.log(`    starts ${iso(r.startsAt)} -> ${iso(plan.startsAt)}`);
      console.log(`    ends   ${iso(r.endsAt)} -> ${iso(plan.endsAt)}`);
      console.log(`    status ${r.status} -> ${plan.status}`);
      if (r.status === "active" || plan.status === "active") {
        if (plan.changed) republish.set(r.shopId, r.domain);
      }
      if (apply) {
        await db.update(offers)
          .set({ startsAt: plan.startsAt, endsAt: plan.endsAt, status: plan.status, timezone: r.shopTz, updatedAt: new Date() })
          .where(and(eq(offers.id, r.id), eq(offers.status, r.status)));
      }
    }
    for (const [shopId, domain] of republish) {
      console.log(`${apply ? "FLAGGED publish-pending" : "WOULD FLAG publish-pending"}: ${domain} (offers cron republishes)`);
      if (apply) await db.update(shops).set({ publishPendingAt: new Date() }).where(eq(shops.id, shopId));
    }
    console.log(`\n${rows.length} candidate offer(s).`);
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
