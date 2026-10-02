import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, encoding: "utf8" });

describe("check-function-query-cost", () => {
  const scratch = mkdtempSync(join(tmpdir(), "qcost-"));
  const write = (name: string, body: string) => {
    const file = join(scratch, name);
    writeFileSync(file, body);
    return file;
  };

  it("passes every shipped Function input query", () => {
    const result = run("check-function-query-cost.mjs", []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("applies leaf=1, __typename=0, metafield=3, hasTags=3", () => {
    const file = write(
      "ok.graphql",
      `query Q($t: [String!]! = []) { a { __typename id metafield(namespace: "n", key: "k") { value } customer { hasTags(tags: $t) { tag hasTag } } } }`,
    );
    const result = run("check-function-query-cost.mjs", [file]);
    expect(result.stdout).toContain(" 7/30");
  });

  it("fails a query over 30", () => {
    const fields = Array.from({ length: 31 }, (_, i) => `f${i}`).join(" ");
    const result = run("check-function-query-cost.mjs", [write("over.graphql", `query Q { cart { ${fields} } }`)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("31/30");
  });
});

describe("check-migration-safety", () => {
  const dirWith = (sql: string) => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0099_test.sql"), sql);
    return dir;
  };
  const check = (sql: string) => run("check-migration-safety.mjs", ["--dir", dirWith(sql), "--grandfathered", "17"]);

  it("accepts additive DDL", () => {
    expect(check('ALTER TABLE "offers" ADD COLUMN "x" text;\nCREATE INDEX "i" ON "offers" ("x");').status).toBe(0);
    expect(check('ALTER TABLE "offers" ADD COLUMN "x" boolean DEFAULT false NOT NULL;').status).toBe(0);
  });

  it.each([
    'ALTER TABLE "offers" DROP COLUMN "x";',
    'DROP TABLE "offers";',
    'ALTER TABLE "offers" RENAME COLUMN "a" TO "b";',
    'ALTER TABLE "offers" ALTER COLUMN "a" SET NOT NULL;',
    'ALTER TABLE "offers" ADD COLUMN "a" text NOT NULL;',
  ])("blocks %s", (sql) => {
    expect(check(sql).status).toBe(1);
  });

  it("allows destructive DDL with an override marker", () => {
    expect(check('-- destructive-ok: column unused since release 2026-10-01\nALTER TABLE "offers" DROP COLUMN "x";').status).toBe(0);
  });

  it("ignores statements inside comments", () => {
    expect(check('-- DROP TABLE offers\nSELECT 1;').status).toBe(0);
  });
});
