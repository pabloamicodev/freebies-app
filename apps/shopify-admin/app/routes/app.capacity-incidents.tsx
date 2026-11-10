import * as Sentry from "@sentry/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { applyWorkaround, discountOps, undoWorkaround } from "../lib/capacity-apply.server.js";
import { dismissIncident, listOpenIncidents, snoozeIncidents } from "../lib/capacity-incidents.server.js";
import { runWithCapacitySource } from "../lib/capacity-source.server.js";
import { proposeForIncident } from "../lib/capacity-workarounds.server.js";
import { WORKAROUND_KINDS, type IncidentProposals, type WorkaroundResult } from "../lib/capacity-workarounds.js";
import { getShopContext } from "../lib/shop-context.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const MAX_INCIDENTS = 10;

export interface CapacityIncidentsData {
  incidents: IncidentProposals[];
}

/** A fetcher error would replace the whole page with the route boundary, so unexpected failures come back as data. */
const FAILED = { error: true as const };

const loaderQuery = z.object({
  incident: z.string().uuid().optional(),
  discounts: z.literal("1").optional(),
});

export async function loader({ request }: LoaderFunctionArgs) {
  const { db, shopId, shopDomain } = await getShopContext(request);
  const query = loaderQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new Response("Bad request", { status: 400 });
  try {
    const live = await listOpenIncidents(db, shopId);

    if (query.data.discounts) {
      const incident = live.find((row) => row.id === query.data.incident);
      if (!incident) throw new Response("Not found", { status: 404 });
      const candidates = await (await discountOps(db)).list({ id: shopId, domain: shopDomain });
      return { candidates };
    }

    const chosen = (query.data.incident ? live.filter((row) => row.id === query.data.incident) : live).slice(0, MAX_INCIDENTS);
    const incidents: IncidentProposals[] = [];
    for (const incident of chosen) incidents.push(await proposeForIncident(db, incident));
    return { incidents } satisfies CapacityIncidentsData;
  } catch (error) {
    if (error instanceof Response) throw error;
    Sentry.captureException(error, { tags: { shopId, context: "capacity-incidents-loader" } });
    return FAILED;
  }
}

const json = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== "string" || value === "") return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }, schema);

const applySchema = z.object({
  intent: z.literal("apply"),
  incidentId: z.string().uuid(),
  kind: z.enum(WORKAROUND_KINDS),
  selected: json(z.array(z.string().max(300)).max(50)).optional(),
  confirm: z.enum(["true", "false"]).default("false"),
  expectedVersions: json(z.record(z.string(), z.string())).default({}),
});

const actionSchema = z.discriminatedUnion("intent", [
  applySchema,
  z.object({ intent: z.literal("undo"), actionId: z.string().uuid() }),
  z.object({ intent: z.literal("snooze") }),
  z.object({ intent: z.literal("dismiss"), incidentId: z.string().uuid() }),
]);

export async function action({ request }: ActionFunctionArgs): Promise<WorkaroundResult> {
  const { db, shopId, shopDomain } = await getShopContext(request);
  const parsed = actionSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { ok: false, code: "refused", message: "That request was not valid." };
  const input = parsed.data;
  const shop = { id: shopId, domain: shopDomain };
  return runWithCapacitySource("admin", true, async (): Promise<WorkaroundResult> => {
    try {
      return await run(input);
    } catch (error) {
      Sentry.captureException(error, { tags: { shopId, context: "capacity-incidents-action", intent: input.intent } });
      return { ok: false, code: "rolled_back", message: "Something went wrong. Your offers were not changed. Try again in a minute." };
    }
  });

  async function run(input: z.infer<typeof actionSchema>): Promise<WorkaroundResult> {
    switch (input.intent) {
      case "apply":
        return applyWorkaround(db, shop, {
          incidentId: input.incidentId,
          kind: input.kind,
          ...(input.selected ? { selected: input.selected } : {}),
          confirm: input.confirm === "true",
          expectedVersions: input.expectedVersions,
          performedBy: shopDomain,
        });
      case "undo":
        return undoWorkaround(db, shop, input.actionId, shopDomain);
      case "snooze":
        await snoozeIncidents(db, shopId);
        return { ok: true, code: "applied", message: "We will remind you tomorrow." };
      case "dismiss": {
        const done = await dismissIncident(db, shopId, input.incidentId);
        return done ? { ok: true, code: "applied", message: "Dismissed." } : { ok: false, code: "not_found", message: "This incident is no longer open." };
      }
    }
  }
}
