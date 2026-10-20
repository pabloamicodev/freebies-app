import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TARGETS,
  readApplicationUrl,
  renderAppUrlModule,
} from "../../../../scripts/write-extension-app-url.mjs";

const ADMIN = join(__dirname, "../..");
const HOSTS = {
  "shopify.app.toml": "https://freebies-app-shopify-admin.vercel.app",
  "shopify.app.ambrosia.toml": "https://freebies-app-ambrosia.vercel.app",
  "shopify.app.onesol.toml": "https://freebies-app-onesol.vercel.app",
};

describe("extension app url generator", () => {
  it.each(Object.entries(HOSTS))("%s yields its own host", (toml, host) => {
    const url = readApplicationUrl(readFileSync(join(ADMIN, toml), "utf8"));
    expect(url).toBe(host);
    expect(renderAppUrlModule(url)).toContain(`APP_URL = "${host}"`);
  });

  it("rejects a toml without application_url", () => {
    expect(() => readApplicationUrl('name = "x"')).toThrow();
  });

  it("committed files default to HPN", () => {
    for (const file of TARGETS) {
      // Windows checkouts with core.autocrlf turn the committed LF into CRLF.
      expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe(renderAppUrlModule(HOSTS["shopify.app.toml"]));
    }
  });
});
