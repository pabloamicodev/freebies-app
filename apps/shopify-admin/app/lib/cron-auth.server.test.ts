import { afterEach, describe, expect, it } from "vitest";
import { isCronRequestAuthorized } from "./cron-auth.server.js";

const originalSecret = process.env["CRON_SECRET"];

afterEach(() => {
  if (originalSecret === undefined) delete process.env["CRON_SECRET"];
  else process.env["CRON_SECRET"] = originalSecret;
});

describe("isCronRequestAuthorized", () => {
  it("fails closed when the secret is missing", () => {
    delete process.env["CRON_SECRET"];
    expect(isCronRequestAuthorized(new Request("https://example.com"))).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    process.env["CRON_SECRET"] = "expected-secret";
    const request = new Request("https://example.com", {
      headers: { authorization: "Bearer expected-secret" },
    });
    expect(isCronRequestAuthorized(request)).toBe(true);
  });

  it("rejects a mismatched token", () => {
    process.env["CRON_SECRET"] = "expected-secret";
    const request = new Request("https://example.com", {
      headers: { "x-vercel-cron-secret": "wrong-secret" },
    });
    expect(isCronRequestAuthorized(request)).toBe(false);
  });
});
