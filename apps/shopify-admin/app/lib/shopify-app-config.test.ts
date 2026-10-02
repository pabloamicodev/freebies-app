import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN = resolve(__dirname, "../..");
const TOMLS = ["shopify.app.toml", "shopify.app.ambrosia.toml"] as const;
const read = (file: string) => readFileSync(join(ADMIN, file), "utf8");
const scopes = (file: string) =>
  (/^scopes\s*=\s*"([^"]*)"/m.exec(read(file))?.[1] ?? "").split(",").filter(Boolean);
const topics = (file: string) =>
  [...read(file).matchAll(/topics\s*=\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((topic) => topic[1]!),
  );

describe.each(TOMLS)("%s", (file) => {
  it("does not subscribe to customers/update, which the app never acted on", () => {
    expect(topics(file)).not.toContain("customers/update");
    expect(read(file)).not.toContain("/webhooks/customers");
  });

  it("asks for write_discounts only: it already grants read access", () => {
    expect(scopes(file)).toContain("write_discounts");
    expect(scopes(file)).not.toContain("read_discounts");
  });

  it("subscribes only to topics the webhook route handles", () => {
    const route = readFileSync(join(ADMIN, "app/routes/webhooks.$.tsx"), "utf8");
    for (const topic of topics(file)) {
      const enumName = topic.replace("/", "_").toUpperCase();
      expect(route, `no handler for ${topic}`).toContain(`case "${enumName}"`);
    }
  });
});

describe("the two app configs", () => {
  it("request exactly the same scopes and the same webhook topics", () => {
    expect([...scopes(TOMLS[0])].sort()).toEqual([...scopes(TOMLS[1])].sort());
    expect([...topics(TOMLS[0])].sort()).toEqual([...topics(TOMLS[1])].sort());
  });

  it("the webhook route no longer carries a customers/update handler", () => {
    const route = readFileSync(join(ADMIN, "app/routes/webhooks.$.tsx"), "utf8");
    expect(route).not.toContain("CUSTOMERS_UPDATE");
    expect(route).not.toContain("handleCustomersUpdate");
  });
});
