/**
 * CI guard: new Drizzle migrations must be expand-only (docs/RUNBOOK.md, "Migration policy").
 * Migrations apply on every production Vercel build BEFORE the new code is live and while the old code
 * still serves traffic, so anything that breaks the previous release is blocked unless the file carries
 *   -- destructive-ok: <why this is safe, which release already stopped using it>
 * (or the narrower `-- backfill-ok: <reason>` for a reviewed index / UPDATE / DELETE).
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
];
const OVERRIDE = /--\s*(?:destructive|backfill)-ok\s*:\s*\S+/i;
const TRIVIAL_WHERE = /\bWHERE\s+(?:true|1\s*=\s*1)\s*$/i;
const INDEX_ON = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?/i;
const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/gi;

/**
 * Per-statement rules that need the statement's shape:
 *  - CREATE INDEX without CONCURRENTLY on a table this file did not create: takes a SHARE lock and blocks
 *    writes for the whole build. Drizzle runs a migration in one transaction, where CONCURRENTLY is not
 *    allowed, so on a big table the index is built by a hand-run step (docs/RUNBOOK.md); on a small or
 *    brand-new table add the marker with the reason.
 *  - UPDATE / DELETE with no WHERE (or WHERE true): one transaction over the whole table, long row locks
 *    and WAL. Batch it (split backfills) or add the marker with the reason it is bounded.
 */
function statementRisks(code) {
  const created = new Set([...code.matchAll(CREATE_TABLE)].map((match) => match[1].toLowerCase()));
  const risks = new Set();
  for (const raw of code.split(/;|-->\s*statement-breakpoint/)) {
    const statement = raw.trim();
    const index = INDEX_ON.exec(statement);
    if (index && !created.has(index[1].toLowerCase())) risks.add("CREATE INDEX without CONCURRENTLY on an existing table");
    const unbounded = !/\bWHERE\b/i.test(statement) || TRIVIAL_WHERE.test(statement);
    if (/^UPDATE\b/i.test(statement) && unbounded) risks.add("UPDATE without WHERE (unbounded backfill)");
    if (/^DELETE\s+FROM\b/i.test(statement) && unbounded) risks.add("DELETE FROM without WHERE");
  }
  return [...risks];
}

export function findRisks(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--(?!>).*$/gm, "");
  return [...RULES.filter(([re]) => re.test(code)).map(([, label]) => label), ...statementRisks(code)];
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
    console.info(`[migration-safety] ${file}: ${risks.join(", ")} (allowed by marker)`);
    continue;
  }
  failed = true;
  console.error(
    `[migration-safety] ${file}: ${risks.join(", ")}\n  Use expand/contract (docs/RUNBOOK.md) or add "-- destructive-ok: <reason>" (or "-- backfill-ok: <reason>" for an index, UPDATE or DELETE).`,
  );
}
if (failed) process.exit(1);
console.info("[migration-safety] ok");
