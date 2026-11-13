import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  COMBINATIONS_DESCRIPTION,
  PRIORITY_DESCRIPTION,
  promoSetCombinationsInput,
  promoSetPriorityInput,
  setCombinationsTool,
  setPriorityTool,
} from "./promo-combinations.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerPromoCombinationsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_set_combinations",
    { title: "Set combinations and limits", description: COMBINATIONS_DESCRIPTION, inputSchema: promoSetCombinationsInput, annotations: WRITE },
    (args, extra) => setCombinationsTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_set_priority",
    { title: "Set priority", description: PRIORITY_DESCRIPTION, inputSchema: promoSetPriorityInput, annotations: WRITE },
    (args, extra) => setPriorityTool(ctx, call(extra), args),
  );
}
