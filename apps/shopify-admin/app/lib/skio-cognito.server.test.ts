import { beforeEach, describe, expect, it } from "vitest";
import { SKIO_COGNITO, resetSkioJwksCacheForTests, verifySkioIdToken } from "./skio-cognito.server.js";

const USER = "0ac366ea-530f-4e3b-9f07-ca8a938294b5";
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function setup() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) => {
    const data = `${enc(header)}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { fetchJwks: async () => [jwk], sign };
}

const valid = (extra: Record<string, unknown> = {}) => ({
  iss: SKIO_COGNITO.ISSUER,
  aud: SKIO_COGNITO.CLIENT_ID,
  token_use: "id",
  exp: Math.floor(Date.now() / 1000) + 600,
  "custom:storefrontUserId": USER,
  ...extra,
});

describe("verifySkioIdToken", () => {
  beforeEach(() => resetSkioJwksCacheForTests());

  it("returns the storefrontUserId of a valid token", async () => {
    const { fetchJwks, sign } = await setup();
    expect(await verifySkioIdToken(await sign(valid()), { fetchJwks })).toBe(USER);
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["wrong audience", { aud: "other" }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["access token", { token_use: "access" }],
    ["missing user", { "custom:storefrontUserId": undefined }],
  ])("rejects a token with %s", async (_label, extra) => {
    const { fetchJwks, sign } = await setup();
    expect(await verifySkioIdToken(await sign(valid(extra)), { fetchJwks })).toBeNull();
  });

  it("rejects a token signed by another key", async () => {
    const { fetchJwks } = await setup();
    const other = await setup();
    expect(await verifySkioIdToken(await other.sign(valid()), { fetchJwks })).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { fetchJwks, sign } = await setup();
    const [h, , s] = (await sign(valid())).split(".");
    const forged = `${h}.${enc(valid({ "custom:storefrontUserId": "11111111-1111-1111-1111-111111111111" }))}.${s}`;
    expect(await verifySkioIdToken(forged, { fetchJwks })).toBeNull();
  });

  it("rejects non-RS256 and garbage", async () => {
    const { fetchJwks, sign } = await setup();
    expect(await verifySkioIdToken(await sign(valid(), { alg: "none", kid: "k1" }), { fetchJwks })).toBeNull();
    expect(await verifySkioIdToken("not.a.jwt", { fetchJwks })).toBeNull();
  });
});
