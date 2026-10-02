import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApiVersion } from "@shopify/shopify-api";
import { SHOPIFY_API_VERSION as SHARED_VERSION } from "@promo/shared-types";
import { describe, expect, it } from "vitest";
import { SHOPIFY_API_VERSION } from "./shopify-api-version.js";

const ADMIN = resolve(__dirname, "../..");
const REPO = resolve(ADMIN, "../..");
const read = (path: string) => readFileSync(path, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "build", ".react-router", "target", "dist", ".vercel"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe("one Shopify API version", () => {
  it("the server derives its version from the shared constant", () => {
    expect(String(SHOPIFY_API_VERSION)).toBe(SHARED_VERSION);
  });

  it("is a version @shopify/shopify-api actually supports", () => {
    expect(Object.values(ApiVersion) as string[]).toContain(SHARED_VERSION);
  });

  it.each(["shopify.app.toml", "shopify.app.ambrosia.toml"])("%s webhooks use it", (file) => {
    const match = /^\[webhooks\][\s\S]*?^api_version\s*=\s*"([^"]+)"/m.exec(read(join(ADMIN, file)));
    expect(match?.[1]).toBe(SHARED_VERSION);
  });

  it("every extension's api_version matches", () => {
    const tomls = readdirSync(join(ADMIN, "extensions"))
      .map((dir) => join(ADMIN, "extensions", dir, "shopify.extension.toml"))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    const withVersion = tomls.flatMap((path) => {
      const match = /^api_version\s*=\s*"([^"]+)"/m.exec(read(path));
      return match ? [{ path, version: match[1] }] : [];
    });
    // The function and UI extensions declare one; theme and pixel extensions have none.
    expect(withVersion.length).toBeGreaterThanOrEqual(5);
    for (const { path, version } of withVersion) expect({ path, version }).toEqual({ path, version: SHARED_VERSION });
  });

  it("every Function schema is for it", () => {
    for (const dir of readdirSync(join(ADMIN, "extensions"))) {
      const schema = join(ADMIN, "extensions", dir, "schema.graphql");
      try {
        statSync(schema);
      } catch {
        continue;
      }
      expect(read(schema).split("\n")[0]).toBe(`# api_version: ${SHARED_VERSION}`);
    }
  });

  it("no source file hardcodes an Admin API URL version instead of using the constant", () => {
    const files = [...walk(join(ADMIN, "app")), ...walk(join(REPO, "packages")), ...walk(join(REPO, "scripts"))].filter(
      (path) => /\.(ts|tsx|mjs|js)$/.test(path) && !/\.test\./.test(path),
    );
    const offenders = files.filter((path) => /admin\/api\/\d{4}-\d{2}/.test(read(path)));
    expect(offenders).toEqual([]);
  });
});
