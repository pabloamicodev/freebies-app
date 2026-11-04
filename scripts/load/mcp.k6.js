/**
 * Light k6 load test for the MCP endpoint (read tools only), hpn-test-store only.
 *
 *   k6 run -e MCP_URL=https://<deployment>/api/mcp -e MCP_TOKEN=pemcp_... [-e VUS=2] [-e DURATION=1m] scripts/load/mcp.k6.js
 *
 * Use a viewer token whose allow list is ["hpn-test-store.myshopify.com"] only. The per-operator read limit
 * (MCP_RATE_READS, default 60/min) applies, so the default pacing stays well under it; 429/RATE_LIMITED
 * responses are counted separately and are not failures.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const URL = __ENV.MCP_URL;
const TOKEN = __ENV.MCP_TOKEN;
const VUS = Number(__ENV.VUS || 2);
if (!URL || !TOKEN) throw new Error("MCP_URL and MCP_TOKEN are required");
if (VUS > 5) throw new Error("VUS above 5 is not allowed: this is a light check, not a stress test");

const rateLimited = new Counter("mcp_rate_limited");

export const options = {
  scenarios: { light: { executor: "constant-vus", vus: VUS, duration: __ENV.DURATION || "1m" } },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.98"],
  },
};

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${TOKEN}`,
};

function rpc(id, method, params, name) {
  const res = http.post(URL, JSON.stringify({ jsonrpc: "2.0", id, method, params }), { headers, tags: { name } });
  if (res.status === 429) {
    rateLimited.add(1);
    return res;
  }
  check(res, {
    [`${name} 200`]: (r) => r.status === 200,
    [`${name} no error`]: (r) => {
      try {
        const body = r.json();
        return !body.error && !(body.result && body.result.isError && body.result.structuredContent && body.result.structuredContent.code !== "RATE_LIMITED");
      } catch (e) {
        return false;
      }
    },
  });
  return res;
}

export default function () {
  rpc(1, "tools/list", {}, "tools_list");
  sleep(2);
  rpc(2, "tools/call", { name: "shops_list", arguments: {} }, "shops_list");
  sleep(2);
  rpc(3, "tools/call", { name: "promos_active", arguments: { shops: ["hpn-test-store.myshopify.com"], limit: 20 } }, "promos_active");
  sleep(2);
}
