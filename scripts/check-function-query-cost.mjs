/**
 * CI guard: Shopify validates a Function input query's complexity only at release (`shopify app deploy`),
 * so a query over the cap passes every local check. This reproduces the cost rules:
 *   leaf field = 1, __typename = 0, metafield = 3 (its `value` is included), hasTags = 3 (children included),
 *   objects/lists/inline fragments = sum of their children (lists are not multiplied).
 * Calibrated against the shipped queries: discount-function lines = 30, delivery = 21/22.
 *
 * Usage: node scripts/check-function-query-cost.mjs [file.graphql ...]
 * No arguments: every `input_query` referenced by apps/shopify-admin/extensions/** /shopify.extension.toml.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_COST = 30;
const SPECIAL = new Map([
  ["metafield", 3],
  ["hasTags", 3],
  ["hasAnyTag", 3],
  ["inCollections", 3],
  ["inAnyCollection", 3],
]);

function tokenize(source) {
  const text = source.replace(/#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "");
  const tokens = [];
  const re = /\.\.\.|[{}()]|[A-Za-z_][A-Za-z0-9_]*|[:@$!=\[\],]|"(?:[^"\\]|\\.)*"|-?[0-9.]+/g;
  for (const match of text.matchAll(re)) tokens.push(match[0]);
  return tokens;
}

/** Cost of a GraphQL query document (first operation only). */
export function queryCost(source) {
  const tokens = tokenize(source);
  let i = 0;
  const skipParens = () => {
    if (tokens[i] !== "(") return;
    let depth = 0;
    do {
      if (tokens[i] === "(") depth += 1;
      if (tokens[i] === ")") depth -= 1;
      i += 1;
    } while (depth > 0 && i < tokens.length);
  };
  const skipDirectives = () => {
    while (tokens[i] === "@") {
      i += 2;
      skipParens();
    }
  };

  function selectionSet() {
    i += 1; // {
    let cost = 0;
    while (i < tokens.length && tokens[i] !== "}") {
      if (tokens[i] === "...") {
        i += 1;
        if (tokens[i] === "on") {
          i += 2;
          skipDirectives();
          cost += selectionSet();
        } else {
          throw new Error(`Fragment spreads are not supported by the cost check (near "${tokens[i]}")`);
        }
        continue;
      }
      let name = tokens[i++];
      if (tokens[i] === ":") {
        i += 1;
        name = tokens[i++];
      }
      skipParens();
      skipDirectives();
      if (tokens[i] === "{") {
        const children = selectionSet();
        cost += SPECIAL.get(name) ?? children;
      } else {
        cost += name === "__typename" ? 0 : (SPECIAL.get(name) ?? 1);
      }
    }
    i += 1; // }
    return cost;
  }

  while (i < tokens.length && tokens[i] !== "{") {
    i += 1;
    skipParens();
  }
  if (tokens[i] !== "{") throw new Error("No selection set found");
  return selectionSet();
}

function referencedQueries(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "shopify.extension.toml") {
        for (const match of readFileSync(full, "utf8").matchAll(/^\s*input_query\s*=\s*"([^"]+)"/gm)) {
          found.push(resolve(dirname(full), match[1]));
        }
      }
    }
  };
  walk(root);
  return [...new Set(found)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))) {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((file) => resolve(file)) : referencedQueries(resolve("apps/shopify-admin/extensions"));
  if (files.length === 0) {
    console.error("[query-cost] no input queries found");
    process.exit(1);
  }
  let failed = false;
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`[query-cost] missing ${file}`);
      failed = true;
      continue;
    }
    const cost = queryCost(readFileSync(file, "utf8"));
    const ok = cost <= MAX_COST;
    if (!ok) failed = true;
    console.info(`[query-cost] ${String(cost).padStart(2)}/${MAX_COST} ${ok ? "ok  " : "OVER"} ${file}`);
  }
  if (failed) {
    console.error("[query-cost] a Function input query exceeds the complexity cap. Do not drop a feature: move it to a separate extension.");
    process.exit(1);
  }
}
