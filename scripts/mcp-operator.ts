/**
 * Manage MCP operators (docs/MCP.md).
 *
 *   tsx scripts/mcp-operator.ts create --email you@x.com --name "You" --shops a.myshopify.com,b.myshopify.com|'*' [--role viewer|editor|admin] [--ttl-days 1-90] [--env <file>]
 *   tsx scripts/mcp-operator.ts list   [--env <file>]
 *   tsx scripts/mcp-operator.ts revoke --email you@x.com [--env <file>]
 *   tsx scripts/mcp-operator.ts totp-enable  --email you@x.com [--env <file>]   (prints the otpauth:// URI once; needs TOKEN_ENCRYPTION_KEY)
 *   tsx scripts/mcp-operator.ts totp-disable --email you@x.com [--env <file>]
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
  const [{ getDb, closeDb, mcpOperators, mcpCredentials }, { and, desc, eq, isNull, sql }, auth, totp] = await Promise.all([
    import("@promo/db"),
    import("drizzle-orm"),
    import("../apps/shopify-admin/app/lib/mcp/auth.server.js"),
    import("../apps/shopify-admin/app/lib/mcp/totp.server.js"),
  ]);
  const db = getDb();

  if (command === "create") {
    const email = flag("email");
    const name = flag("name");
    const role = (flag("role") ?? "viewer") as "viewer" | "editor" | "admin";
    if (!email || !name || !["viewer", "editor", "admin"].includes(role)) {
      throw new Error("create needs --email, --name and a valid --role (default viewer)");
    }
    const shops = flag("shops");
    if (!shops) {
      throw new Error("create needs --shops <a.myshopify.com,b.myshopify.com>, or --shops '*' for every shop (least privilege: no default)");
    }
    const shopAllowList = auth.normalizeAllowList(shops.split(","));
    const ttlDays = flag("ttl-days") === undefined ? undefined : Number(flag("ttl-days"));
    if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90)) {
      throw new Error("--ttl-days must be an integer from 1 to 90");
    }
    const { operatorId, pat, expiresAt } = await auth.createOperatorWithPat(db, { email, name, role, shopAllowList, ttlDays });
    out(`Operator ${email} (${role}) created: ${operatorId}`);
    out(`Expires: ${expiresAt.toISOString()}`);
    out("PAT (shown once, store it now):");
    out(pat);
  } else if (command === "list") {
    const rows = await db
      .select({
        email: mcpOperators.email,
        role: mcpOperators.role,
        id: mcpOperators.id,
        disabledAt: mcpOperators.disabledAt,
        shopAllowList: mcpOperators.shopAllowList,
        totpOn: sql<boolean>`${mcpOperators.totpSecret} is not null`,
      })
      .from(mcpOperators);
    const creds = await db
      .select({
        operatorId: mcpCredentials.operatorId,
        prefix: mcpCredentials.prefix,
        expiresAt: mcpCredentials.expiresAt,
        lastUsedAt: mcpCredentials.lastUsedAt,
      })
      .from(mcpCredentials)
      .where(and(eq(mcpCredentials.kind, "pat"), isNull(mcpCredentials.revokedAt)))
      .orderBy(desc(mcpCredentials.createdAt));
    out("email\tstatus\trole\tpat_prefix\tshops\tlast_used_at\texpires_at\ttotp\tid");
    for (const r of rows) {
      const pat = creds.find((c) => c.operatorId === r.id);
      const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "-");
      out(
        [r.email, r.disabledAt ? "disabled" : "active", r.role, pat?.prefix ?? "-", r.shopAllowList.join(",") || "-", iso(pat?.lastUsedAt), iso(pat?.expiresAt), r.totpOn ? "on" : "off", r.id].join("\t"),
      );
    }
  } else if (command === "totp-enable") {
    const email = flag("email");
    if (!email) throw new Error("totp-enable needs --email");
    const { uri } = await totp.enableTotp(db, email);
    out("TOTP enabled (replaces any previous secret). Add this to your authenticator app; it is shown once:");
    out(uri);
  } else if (command === "totp-disable") {
    const email = flag("email");
    if (!email) throw new Error("totp-disable needs --email");
    await totp.disableTotp(db, email);
    out(`TOTP disabled for ${email}.`);
  } else if (command === "revoke") {
    const email = flag("email");
    if (!email) throw new Error("revoke needs --email");
    const [operator] = await db.select().from(mcpOperators).where(eq(mcpOperators.email, email.trim().toLowerCase()));
    if (!operator) throw new Error("no such operator");
    await auth.revokeOperatorCredentials(db, operator.id);
    await db.update(mcpOperators).set({ disabledAt: new Date() }).where(eq(mcpOperators.id, operator.id));
    out(`Operator ${email} disabled and credentials revoked.`);
  } else {
    throw new Error("usage: create | list | revoke | totp-enable | totp-disable (see header of this file)");
  }
  await closeDb();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "error");
  process.exit(1);
});
