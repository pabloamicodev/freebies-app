/**
 * Manage MCP operators (docs/MCP.md).
 *
 *   tsx scripts/mcp-operator.ts create --email you@x.com --name "You" [--role admin] [--shops a.myshopify.com,b.myshopify.com] [--ttl-days 90] [--env <file>]
 *   tsx scripts/mcp-operator.ts list   [--env <file>]
 *   tsx scripts/mcp-operator.ts revoke --email you@x.com [--env <file>]
 *
 * Needs DATABASE_URL and MCP_TOKEN_PEPPER (the same pepper as the deployment that serves /api/mcp).
 * `create` prints the PAT once; only its peppered hash is stored. Writes to whatever DATABASE_URL points at.
 */

import process from "node:process";
import { resolve } from "node:path";

const out = (line: string) => process.stdout.write(line + "\n");
const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadEnvironment() {
  for (const file of [flag("env"), ".env", ".env.local"]) {
    if (!file) continue;
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
  const [{ getDb, closeDb, mcpOperators }, { eq }, auth] = await Promise.all([
    import("@promo/db"),
    import("drizzle-orm"),
    import("../apps/shopify-admin/app/lib/mcp/auth.server.js"),
  ]);
  const db = getDb();

  if (command === "create") {
    const email = flag("email");
    const name = flag("name");
    const role = (flag("role") ?? "admin") as "viewer" | "editor" | "admin";
    if (!email || !name || !["viewer", "editor", "admin"].includes(role)) {
      throw new Error("create needs --email, --name and a valid --role");
    }
    const shopAllowList = flag("shops")?.split(",").map((s) => s.trim()).filter(Boolean);
    const ttlDays = flag("ttl-days") ? Number(flag("ttl-days")) : undefined;
    const { operatorId, pat, expiresAt } = await auth.createOperatorWithPat(db, { email, name, role, shopAllowList, ttlDays });
    out(`Operator ${email} (${role}) created: ${operatorId}`);
    out(`Expires: ${expiresAt.toISOString()}`);
    out("PAT (shown once, store it now):");
    out(pat);
  } else if (command === "list") {
    const rows = await db.select().from(mcpOperators);
    for (const r of rows) out(`${r.email}\t${r.role}\t${r.disabledAt ? "disabled" : "active"}\t${r.id}`);
  } else if (command === "revoke") {
    const email = flag("email");
    if (!email) throw new Error("revoke needs --email");
    const [operator] = await db.select().from(mcpOperators).where(eq(mcpOperators.email, email.toLowerCase()));
    if (!operator) throw new Error("no such operator");
    await auth.revokeOperatorCredentials(db, operator.id);
    await db.update(mcpOperators).set({ disabledAt: new Date() }).where(eq(mcpOperators.id, operator.id));
    out(`Operator ${email} disabled and credentials revoked.`);
  } else {
    throw new Error("usage: create | list | revoke (see header of this file)");
  }
  await closeDb();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "error");
  process.exit(1);
});
