import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpCallLog, type Db } from "@promo/db";
import { handleMcpRequest } from "../handler.server.js";
import { createOperatorWithPat, type Operator } from "../auth.server.js";
import { redactArgs } from "../call-log.server.js";
import { createTestDb } from "../../test-support/pglite-db.js";
import { mcpCallLogQuery } from "./mcp-call-log-query.server.js";

const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
let db: Db;
let close: () => Promise<void>;
let admin: Operator;
let adminPat: string;
let viewerPat: string;
let aliceId: string;
const t0 = new Date("2026-04-01T10:00:00.000Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const a = await createOperatorWithPat(db, { email: "admin@example.com", name: "Admin", role: "admin", shopAllowList: ["*"] }, env);
  adminPat = a.pat;
  admin = { id: a.operatorId, email: "admin@example.com", name: "Admin", role: "admin", shopAllowList: ["*"] };
  const al = await createOperatorWithPat(db, { email: "alice@example.com", name: "Alice", role: "editor", shopAllowList: ["*"] }, env);
  aliceId = al.operatorId;
  ({ pat: viewerPat } = await createOperatorWithPat(db, { email: "viewer@example.com", name: "V", role: "viewer", shopAllowList: ["*"] }, env));
  const rows = Array.from({ length: 7 }, (_, i) => ({
    operatorId: i % 2 === 0 ? aliceId : admin.id,
    tool: i % 3 === 0 ? "promos_pause_all" : "promos_active",
    shops: ["hpn-test-store"],
    argsRedacted: redactArgs(i % 3 === 0 ? "promos_pause_all" : "promos_active", { shop: "hpn-test-store", reason: "free text secret@x.com", limit: 5 }),
    outcome: i === 3 ? "FORBIDDEN" : "ok",
    durationMs: 10 + i,
    createdAt: at(i),
    resultRef: { secret: "stored-result" },
    idempotencyKey: `key-${i}-0000000`,
  }));
  await db.insert(mcpCallLog).values(rows);
}, 60_000);
afterAll(async () => {
  await close();
});

describe("mcpCallLogQuery", () => {
  it("is admin only", async () => {
    for (const role of ["viewer", "editor"] as const) {
      await expect(mcpCallLogQuery(db, { ...admin, role }, {})).rejects.toMatchObject({ payload: { code: "FORBIDDEN", details: { reason: "ROLE" } } });
    }
  });

  it("returns newest first with a keyset cursor that walks every row exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await mcpCallLogQuery(db, admin, { limit: 3, cursor, since: at(0).toISOString() });
      seen.push(...res.data.calls.map((c) => c.at));
      cursor = res.meta.page?.cursor;
      if (!res.meta.page?.hasMore) break;
    }
    expect(seen).toHaveLength(7);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(new Set(seen).size).toBe(7);
  });

  it("filters by operatorEmail, tool, outcome and the time window", async () => {
    const byAlice = await mcpCallLogQuery(db, admin, { operatorEmail: "ALICE@example.com", since: at(0).toISOString() });
    expect(byAlice.data.calls.map((c) => c.operatorName)).toEqual(["Alice", "Alice", "Alice", "Alice"]);
    const pause = await mcpCallLogQuery(db, admin, { tool: "promos_pause_all", since: at(0).toISOString() });
    expect(pause.data.calls.map((c) => c.tool)).toEqual(["promos_pause_all", "promos_pause_all", "promos_pause_all"]);
    const forbidden = await mcpCallLogQuery(db, admin, { outcome: "FORBIDDEN", since: at(0).toISOString() });
    expect(forbidden.data.calls).toHaveLength(1);
    const window = await mcpCallLogQuery(db, admin, { since: at(2).toISOString(), until: at(4).toISOString() });
    expect(window.data.calls.map((c) => c.durationMs)).toEqual([14, 13, 12]);
  });

  it("rejects bad dates and cursors, and caps the page", async () => {
    await expect(mcpCallLogQuery(db, admin, { since: "nope" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(mcpCallLogQuery(db, admin, { cursor: Buffer.from('{"t":"x","id":"y"}').toString("base64url") })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(mcpCallLogQuery(db, admin, { cursor: "%%%" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
  });

  it("never returns emails, result_ref, idempotency keys or raw free text", async () => {
    const res = await mcpCallLogQuery(db, admin, { limit: 200 });
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/"(email|ip|ipAddress)"\s*:/);
    for (const forbidden of ["@example.com", "secret@x.com", "stored-result", "key-1-0000000", "resultRef", "idempotencyKey", "confirmJti", "pemcp_", "customerId", "orderId", "accessToken"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(res.data.calls[0]!.args).toMatchObject({ shop: "hpn-test-store", _omitted: expect.arrayContaining(["reason"]) });
  });
});

describe("mcp_call_log_query over the MCP endpoint", () => {
  const rpc = async (pat: string, method: string, params: unknown) => {
    const res = await handleMcpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pat}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      { db, env, rateLimit: async () => ({ ok: true }) },
    );
    return (await res.json()).result;
  };

  it("is registered read-only, answers admins and refuses viewers; the call itself is logged", async () => {
    const { tools } = await rpc(adminPat, "tools/list", {});
    expect(tools.find((t: { name: string }) => t.name === "mcp_call_log_query")?.annotations.readOnlyHint).toBe(true);
    const ok = await rpc(adminPat, "tools/call", { name: "mcp_call_log_query", arguments: { tool: "promos_pause_all", limit: 2 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.data.calls).toHaveLength(2);
    const denied = await rpc(viewerPat, "tools/call", { name: "mcp_call_log_query", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.code).toBe("FORBIDDEN");
    const own = await mcpCallLogQuery(db, admin, { tool: "mcp_call_log_query" });
    expect(own.data.calls.map((c) => c.outcome).sort()).toEqual(["FORBIDDEN", "ok"]);
  });
});
