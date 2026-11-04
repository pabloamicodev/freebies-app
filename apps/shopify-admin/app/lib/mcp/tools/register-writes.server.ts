import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import { registerCriticalTools } from "./register-critical.server.js";
import {
  codesSetStatusInput,
  codesSetStatusTool,
  createDraftFromTemplateTool,
  duplicateTool,
  promoArchiveInput,
  promoCreateDraftInput,
  promoDuplicateInput,
  promoPauseInput,
  promoResumeInput,
  promoSetPageExcludeUrlsInput,
  promoSetScheduleInput,
  promosRepublishShopInput,
  republishShopTool,
  setPageExcludeUrlsTool,
  setScheduleTool,
  statusChange,
} from "./write-tools.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const FLOW =
  " dryRun defaults to true: it returns the diff and a confirmToken (5 min, single use, bound to these exact arguments); call again with dryRun:false and that token to apply. Only write-enabled shops (hpn-test-store); other shops answer SHOP_READ_ONLY.";

/** Phase 3 write tools (editor; archive and republish need admin). They call the offer-lifecycle service, never SQL. */
export function registerWriteTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_pause",
    {
      title: "Pause a promotion",
      description: `Pauses a live (active or scheduled) offer and republishes the shop; the pause is rolled back if the publish fails.${FLOW}`,
      inputSchema: promoPauseInput,
      annotations: WRITE,
    },
    (args, extra) => statusChange(ctx, call(extra), "promo_pause", args),
  );

  server.registerTool(
    "promo_resume",
    {
      title: "Resume a promotion",
      description: `Resumes a paused offer (validates it first; the schedule decides active, scheduled or expired) and republishes.${FLOW}`,
      inputSchema: promoResumeInput,
      annotations: WRITE,
    },
    (args, extra) => statusChange(ctx, call(extra), "promo_resume", args),
  );

  server.registerTool(
    "promo_archive",
    {
      title: "Archive a promotion",
      description: `Archives an offer (admin role) and republishes the shop. Limited to 3 executions a minute.${FLOW}`,
      inputSchema: promoArchiveInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => statusChange(ctx, call(extra), "promo_archive", args),
  );

  server.registerTool(
    "promos_republish_shop",
    {
      title: "Republish a shop's config",
      description: `Re-publishes the shop's Function config to Shopify without changing any offer (admin role).${FLOW}`,
      inputSchema: promosRepublishShopInput,
      annotations: WRITE,
    },
    (args, extra) => republishShopTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_duplicate",
    {
      title: "Duplicate a promotion as a draft",
      description: `Copies an offer with its conditions, rewards and bundle definition as a DRAFT with a unique name; discount codes and widgets are not copied. targetShop copies into another write-enabled shop of this app.${FLOW}`,
      inputSchema: promoDuplicateInput,
      annotations: WRITE,
    },
    (args, extra) => duplicateTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_create_draft_from_template",
    {
      title: "Create a draft from a template offer",
      description: `v1: clones an existing offer (the template) as a draft and applies bounded overrides (schedule, Store pages URLs), validated like the admin UI.${FLOW}`,
      inputSchema: promoCreateDraftInput,
      annotations: WRITE,
    },
    (args, extra) => createDraftFromTemplateTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_set_page_exclude_urls",
    {
      title: "Set Store pages exclude URLs",
      description: `Replaces the excludeUrls (and optionally pageUrls) of the offer's Store pages condition, with the admin UI's normalization and limits (100 x 300 chars). A live offer is republished; a failed publish does not undo the saved change but may pause the offer.${FLOW}`,
      inputSchema: promoSetPageExcludeUrlsInput,
      annotations: WRITE,
    },
    (args, extra) => setPageExcludeUrlsTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_set_schedule",
    {
      title: "Set a promotion's schedule",
      description: `Changes startsAt/endsAt (shop-local 'YYYY-MM-DDTHH:mm', or an ISO instant); the status follows the new dates. A live offer is republished; a failed publish does not undo the saved dates but may pause the offer.${FLOW}`,
      inputSchema: promoSetScheduleInput,
      annotations: WRITE,
    },
    (args, extra) => setScheduleTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_set_status",
    {
      title: "Activate or deactivate discount codes",
      description: `Sets the status of codes of one offer (ids, a batchId, or all; max 2000 per call). Exhausted codes are never changed. A live offer is republished and the statuses are restored if that fails.${FLOW}`,
      inputSchema: codesSetStatusInput,
      annotations: WRITE,
    },
    (args, extra) => codesSetStatusTool(ctx, call(extra), args),
  );

  registerCriticalTools(server, ctx);
}
