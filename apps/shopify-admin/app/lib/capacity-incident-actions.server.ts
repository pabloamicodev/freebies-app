import type { Db } from "@promo/db";
import { applyWorkaround, undoWorkaround, type ApplyDeps, type ShopRef } from "./capacity-apply.server.js";
import { dismissIncident, snoozeIncidents } from "./capacity-incidents.server.js";
import type { WorkaroundKind, WorkaroundResult } from "./capacity-workarounds.js";

export type IncidentIntentInput =
  | { intent: "apply"; incidentId: string; kind: WorkaroundKind; selected?: string[]; confirm: boolean; expectedVersions: Record<string, string> }
  | { intent: "undo"; actionId: string }
  | { intent: "snooze" }
  | { intent: "dismiss"; incidentId: string };

/** The four capacity-incident actions as one typed service; the admin route and the MCP tools both call it. */
export async function runIncidentIntent(db: Db, shop: ShopRef, input: IncidentIntentInput, performedBy: string, deps: ApplyDeps = {}): Promise<WorkaroundResult> {
  switch (input.intent) {
    case "apply":
      return applyWorkaround(
        db,
        shop,
        {
          incidentId: input.incidentId,
          kind: input.kind,
          ...(input.selected ? { selected: input.selected } : {}),
          confirm: input.confirm,
          expectedVersions: input.expectedVersions,
          performedBy,
        },
        deps,
      );
    case "undo":
      return undoWorkaround(db, shop, input.actionId, performedBy, deps);
    case "snooze":
      await snoozeIncidents(db, shop.id);
      return { ok: true, code: "applied", message: "We will remind you tomorrow." };
    case "dismiss": {
      const done = await dismissIncident(db, shop.id, input.incidentId);
      return done ? { ok: true, code: "applied", message: "Dismissed." } : { ok: false, code: "not_found", message: "This incident is no longer open." };
    }
  }
}
