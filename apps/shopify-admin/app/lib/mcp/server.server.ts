import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "@promo/db";
import type { Operator } from "./auth.server.js";
import { toToolErrorPayload, type ToolResult } from "./result.server.js";
import { visibleShops } from "./shops.server.js";
import { registerInsightsTools } from "./tools/register-insights.server.js";
import { shopsList, shopsListInput } from "./tools/shops-list.server.js";
import { registerResourcesAndPrompts } from "./resources.server.js";
import { registerCatalogTools } from "./tools/register-catalog.server.js";
import { registerWriteTools } from "./tools/register-writes.server.js";
import { instrumentReadTools, type RateLimiter } from "./call-log.server.js";
import type { ShopPublishFn } from "../offer-lifecycle.server.js";

export type McpContext = {
  db: Db;
  env: NodeJS.ProcessEnv;
  operator: Operator;
  now: () => Date;
  /** Per-operator tool limits; defaults to the shared limiter. Tests inject one. */
  rateLimit?: RateLimiter;
  /** Replaces only the Shopify publish of the write tools; production leaves it unset. */
  publish?: ShopPublishFn;
};

export function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: result.summary }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

export function toErrorCallToolResult(error: unknown): CallToolResult {
  const payload = toToolErrorPayload(error);
  return { isError: true, content: [{ type: "text", text: `${payload.code}: ${payload.message}` }], structuredContent: payload };
}

export async function runTool(fn: () => Promise<ToolResult<unknown>>): Promise<CallToolResult> {
  try {
    return toCallToolResult(await fn());
  } catch (error) {
    return toErrorCallToolResult(error);
  }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "promo-engine", version: "0.1.0" });
  instrumentReadTools(server, ctx);

  server.registerTool(
    "shops_list",
    {
      title: "List shops",
      description:
        "Lists the shops you can see with currency, timezone, active offer count and writeMode (read_only | write). Writes run only on shops in write mode; today that is every shop, and each write still needs a dry run and a confirmToken.",
      inputSchema: shopsListInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(async () => shopsList(ctx.db, await visibleShops(ctx.db, ctx.operator), args, ctx.env, ctx.now)),
  );

  registerCatalogTools(server, ctx);
  registerInsightsTools(server, ctx);
  registerWriteTools(server, ctx);
  registerResourcesAndPrompts(server, ctx);

  return server;
}
