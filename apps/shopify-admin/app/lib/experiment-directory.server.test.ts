import { beforeEach, describe, expect, it, vi } from "vitest";

const gql = vi.hoisted(() => ({
  handler: null as null | ((args: { shopDomain: string; accessToken: string; query: string; variables: Record<string, unknown> }) => unknown),
  calls: [] as Array<{ shopDomain: string; accessToken: string; query: string; variables: Record<string, unknown> }>,
}));
const ctx = vi.hoisted(() => ({ fail: false }));

vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: async (args: { shopDomain: string; accessToken: string; query: string; variables: Record<string, unknown> }) => {
    gql.calls.push(args);
    return gql.handler!(args);
  },
}));
vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => {
    if (ctx.fail) throw new Response("Unauthorized", { status: 401 });
    return { shopDomain: "tenant-a.myshopify.com", session: { accessToken: "tok-a" } };
  },
}));

import { getExperimentDirectory, getExperimentWarnings } from "./experiment-directory.server.js";
import { loader } from "../routes/app.api.experiments.js";

const value = JSON.stringify({
  v: 1,
  updatedAt: "2026-10-26T00:00:00Z",
  experiments: [{ id: "abcd1234", name: "PDP hero", status: "RUNNING", mode: "inline", variants: [{ key: "control", name: "Control", control: true }] }],
});
const auth = { shopDomain: "s.myshopify.com", accessToken: "t" };

beforeEach(() => {
  gql.calls = [];
  gql.handler = () => ({ shop: { metafield: { value } } });
  ctx.fail = false;
});

describe("getExperimentDirectory", () => {
  it("reads the merchant-owned metafield by namespace and key", async () => {
    const dir = await getExperimentDirectory(auth);
    expect(dir.unavailable).toBeFalsy();
    expect(gql.calls[0]!.variables).toEqual({ namespace: "experiment_engine", key: "directory" });
  });

  it("is unavailable when the metafield is absent, garbage or the read fails", async () => {
    gql.handler = () => ({ shop: { metafield: null } });
    expect(await getExperimentDirectory(auth)).toEqual({ unavailable: true });
    gql.handler = () => ({ shop: { metafield: { value: "{{{" } } });
    expect(await getExperimentDirectory(auth)).toEqual({ unavailable: true });
    gql.handler = () => {
      throw new Error("Shopify down");
    };
    expect(await getExperimentDirectory(auth)).toEqual({ unavailable: true });
  });
});

describe("getExperimentWarnings", () => {
  it("warns on a missing experiment and on a missing arm", async () => {
    const out = await getExperimentWarnings(auth, [
      { experimentId: "deadbeef", variantKeys: ["control"], experimentName: "Old" },
      { experimentId: "abcd1234", variantKeys: ["control", "gone"] },
    ]);
    expect(out).toEqual(['Experiment "Old" is not in your Experiment Engine directory.', 'Experiment "abcd1234" has no arm "gone".']);
  });

  it("says nothing when the directory is unreadable or nothing is stored", async () => {
    gql.handler = () => ({ shop: { metafield: null } });
    expect(await getExperimentWarnings(auth, [{ experimentId: "deadbeef", variantKeys: ["x"] }])).toEqual([]);
    gql.calls = [];
    expect(await getExperimentWarnings(auth, [])).toEqual([]);
    expect(gql.calls).toHaveLength(0);
  });
});

describe("GET /app/api/experiments", () => {
  const call = () => (loader as unknown as (a: unknown) => Promise<Response>)({ request: new Request("http://localhost/app/api/experiments"), params: {}, context: {} });

  it("is shop-scoped: queries only with the session's shop and token, and is never cached", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(((await res.json()) as { experiments: unknown[] }).experiments).toHaveLength(1);
    expect(gql.calls[0]).toMatchObject({ shopDomain: "tenant-a.myshopify.com", accessToken: "tok-a" });
  });

  it("answers { unavailable: true } when the metafield is absent", async () => {
    gql.handler = () => ({ shop: { metafield: null } });
    expect(await (await call()).json()).toEqual({ unavailable: true });
  });

  it("rejects an unauthenticated request without calling Shopify", async () => {
    ctx.fail = true;
    const res = await call();
    expect(res.status).toBe(401);
    expect(gql.calls).toHaveLength(0);
  });
});
