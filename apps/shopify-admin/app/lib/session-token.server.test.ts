import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rate-limit.server.js", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getClientIp: vi.fn().mockReturnValue("203.0.113.9"),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn(), flush: vi.fn() }));

const { verifySessionToken, bearerToken } = await import("./session-token.server.js");
const { checkRateLimit } = await import("./rate-limit.server.js");
const Sentry = await import("@sentry/node");
const { action } = await import("../routes/api.report-error.js");

const ENV = { SHOPIFY_API_KEY: "client-id", SHOPIFY_API_SECRET: "app-secret" };
const NOW = 1_800_000_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(claims: Record<string, unknown>, secret = ENV.SHOPIFY_API_SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const unsigned = `${b64(header)}.${b64(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
const goodClaims = { aud: "client-id", dest: "https://Shop-A.myshopify.com", exp: NOW + 60, nbf: NOW - 5 };

describe("verifySessionToken", () => {
  it("returns the shop from dest for a valid App Bridge token", () => {
    expect(verifySessionToken(sign(goodClaims), ENV, NOW)).toBe("shop-a.myshopify.com");
  });

  it.each([
    ["wrong secret", sign(goodClaims, "other-secret")],
    ["wrong audience", sign({ ...goodClaims, aud: "someone-else" })],
    ["expired", sign({ ...goodClaims, exp: NOW - 60 })],
    ["not yet valid", sign({ ...goodClaims, nbf: NOW + 600 })],
    ["non-shop dest", sign({ ...goodClaims, dest: "https://evil.example.com" })],
    ["alg none", sign(goodClaims, "", { alg: "none" })],
    ["garbage", "not.a.jwt"],
    ["empty", ""],
  ])("rejects %s", (_name, token) => {
    expect(verifySessionToken(token, ENV, NOW)).toBeNull();
  });

  it("rejects everything when the app credentials are not configured", () => {
    expect(verifySessionToken(sign(goodClaims), {}, NOW)).toBeNull();
  });

  it("extracts a bearer token", () => {
    expect(bearerToken(new Request("https://a.test", { headers: { authorization: "Bearer abc.def" } }))).toBe("abc.def");
    expect(bearerToken(new Request("https://a.test"))).toBeNull();
  });
});

describe("POST /api/report-error", () => {
  beforeEach(() => {
    process.env["SHOPIFY_API_KEY"] = ENV.SHOPIFY_API_KEY;
    process.env["SHOPIFY_API_SECRET"] = ENV.SHOPIFY_API_SECRET;
    vi.mocked(checkRateLimit).mockClear().mockResolvedValue({ ok: true });
    vi.mocked(Sentry.captureException).mockClear();
  });
  const call = (headers: Record<string, string> = {}, url = "https://app.test/api/report-error") =>
    action({
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message: "boom" }) }),
      params: {},
      context: {},
    } as never);
  const liveToken = () => sign({ ...goodClaims, exp: Math.floor(Date.now() / 1000) + 60, nbf: 0 });

  it("rejects callers without a valid session token, including a forged ?shop= claim", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({}, "https://app.test/api/report-error?shop=victim.myshopify.com")).status).toBe(401);
    expect((await call({ authorization: "Bearer nope" })).status).toBe(401);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("meters by the shop in the verified token (not the query string) and keeps the global ceiling", async () => {
    const response = await call({ authorization: `Bearer ${liveToken()}` }, "https://app.test/api/report-error?shop=victim.myshopify.com");
    expect(response.status).toBe(202);
    const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
    expect(keys).toContain("report-error:global");
    expect(keys).toContain("report-error:shop:shop-a.myshopify.com");
    expect(keys).not.toContain("report-error:shop:victim.myshopify.com");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("answers 429 when the shop budget is spent", async () => {
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => (key.startsWith("report-error:shop:") ? { ok: false, retryAfterSeconds: 12 } : { ok: true }));
    const response = await call({ authorization: `Bearer ${liveToken()}` });
    expect(response.status).toBe(429);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
