/**
 * Read-only check that the app's TOKEN_ENCRYPTION_KEY decrypts every shop's stored token and that
 * the token still works: one `{ shop { myshopifyDomain } }` Admin GraphQL query per shop.
 *
 *   tsx scripts/mcp-verify-shop-tokens.ts [--env <file>]
 *
 * Prints only "<domain> ok|fail (reason)". Never prints a token. Only SELECT and one query per shop.
 */

import process from "node:process";
import { resolve } from "node:path";

const out = (line: string) => process.stdout.write(line + "\n");

function envFiles(): string[] {
  const files: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === "--env" && process.argv[i + 1]) files.push(process.argv[i + 1]!);
  });
  return files;
}

function loadEnvironment() {
  for (const file of [...envFiles(), ".env", ".env.local"]) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
  }
}

async function main() {
  loadEnvironment();
  const [{ getDb, closeDb, shops }, { isNull }, { decryptToken }, { shopifyGraphQL }] = await Promise.all([
    import("@promo/db"),
    import("drizzle-orm"),
    import("../apps/shopify-admin/app/lib/token-crypto.server.js"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
  ]);
  const rows = await getDb()
    .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted })
    .from(shops)
    .where(isNull(shops.uninstalledAt));

  let failures = 0;
  for (const row of rows) {
    try {
      const accessToken = await decryptToken(row.token);
      const data = await shopifyGraphQL<{ shop: { myshopifyDomain: string } }>({
        shopDomain: row.domain,
        accessToken,
        query: "{ shop { myshopifyDomain } }",
        maxRetries: 1,
        timeoutMs: 10_000,
      });
      const ok = data?.shop?.myshopifyDomain === row.domain;
      if (!ok) failures += 1;
      out(`${row.domain} ${ok ? "ok" : "fail (domain mismatch)"}`);
    } catch (error) {
      failures += 1;
      // Keep only the error class: never echo messages that could carry request details.
      out(`${row.domain} fail (${error instanceof Error ? error.name : "error"})`);
    }
  }
  await closeDb();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.name : "error");
  process.exit(1);
});
