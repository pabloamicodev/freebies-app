/**
 * CI guard: new Drizzle migrations must be expand-only (docs/RUNBOOK.md, "Migration policy").
 * Migrations apply on every production Vercel build BEFORE the new code is live and while the old code
 * still serves traffic, so anything that breaks the previous release is blocked unless the file carries
 *   -- destructive-ok: <why this is safe, which release already stopped using it>
 *
 * Usage: node scripts/check-migration-safety.mjs [--dir packages/db/drizzle] [--grandfathered 17]
 * Files numbered <= --grandfathered predate the guard and are skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RULES = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bDROP\s+(SCHEMA|TYPE)\b/i, "DROP SCHEMA/TYPE"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bRENAME\s+(COLUMN|TO)\b/i, "RENAME (table or column)"],
  [/\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, "SET NOT NULL on an existing column"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "ALTER COLUMN TYPE (table rewrite)"],
  [/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?![^,;]*\bDEFAULT\b)[^,;]*\bNOT\s+NULL\b/i, "ADD COLUMN NOT NULL without DEFAULT"],
  [/\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, "DELETE FROM without WHERE"],
];
const OVERRIDE = /--\s*destructive-ok\s*:\s*\S+/i;

export function findRisks(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, "");
  return RULES.filter(([re]) => re.test(code)).map(([, label]) => label);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dir = arg("dir", "packages/db/drizzle");
const grandfathered = Number(arg("grandfathered", "17"));
let failed = false;
for (const file of readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
  if (Number(file.slice(0, 4)) <= grandfathered) continue;
  const sql = readFileSync(join(dir, file), "utf8");
  const risks = findRisks(sql);
  if (risks.length === 0) continue;
  if (OVERRIDE.test(sql)) {
    console.info(`[migration-safety] ${file}: ${risks.join(", ")} (allowed by destructive-ok marker)`);
    continue;
  }
  failed = true;
  console.error(`[migration-safety] ${file}: ${risks.join(", ")}\n  Use expand/contract (docs/RUNBOOK.md) or add "-- destructive-ok: <reason>".`);
}
if (failed) process.exit(1);
console.info("[migration-safety] ok");
