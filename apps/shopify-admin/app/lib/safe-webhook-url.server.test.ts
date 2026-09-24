import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl } from "./safe-webhook-url.server.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("assertSafeWebhookUrl", () => {
  it("accepts an HTTPS URL resolving only to public addresses", async () => {
    await expect(assertSafeWebhookUrl("https://hooks.example.com/promo", publicResolver))
      .resolves.toMatchObject({ hostname: "hooks.example.com" });
  });

  it.each([
    "http://hooks.example.com/promo",
    "https://user:pass@hooks.example.com/promo",
    "https://hooks.example.com:8443/promo",
    "https://localhost/promo",
    "https://127.0.0.1/promo",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/promo",
    "https://[::1]/promo",
  ])("rejects unsafe destination %s", async (url) => {
    await expect(assertSafeWebhookUrl(url, publicResolver)).rejects.toThrow();
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    const mixedResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.4", family: 4 },
    ];
    await expect(assertSafeWebhookUrl("https://hooks.example.com", mixedResolver))
      .rejects.toThrow("private or reserved");
  });
});
