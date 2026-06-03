/**
 * Migration from BOGOS page.
 * Guides the merchant through the cutover process:
 * 1. Shadow mode — run promo engine in parallel with BOGOS
 * 2. Parity validation — compare evaluation results
 * 3. Test theme — enable promo engine on a duplicate theme
 * 4. Gradual cutover — disable BOGOS, enable promo engine
 * 5. Post-cutover cleanup — remove BOGOS scripts/classes
 */

import { useLoaderData, Form } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings, offers } from "@promo/db";
import { eq, and, count } from "drizzle-orm";
import { isShadowModeEnabled, setShadowMode } from "../lib/shadow-mode.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const [shadowMode, activeOffers, draftOffers] = await Promise.all([
    isShadowModeEnabled(shopId),
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.status, "active"))),
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.status, "draft"))),
  ]);

  return {
    shopId,
    shadowMode,
    activeOffers: activeOffers[0]?.count ?? 0,
    draftOffers: draftOffers[0]?.count ?? 0,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "enable_shadow":
      await setShadowMode(shopId, true);
      break;
    case "disable_shadow":
      await setShadowMode(shopId, false);
      break;
  }

  return null;
};

const MIGRATION_STEPS = [
  { id: "audit",     label: "Phase 0 — Audit current BOGOS offers",        description: "Export and document all BOGOS offers, settings, and Scripts before any changes." },
  { id: "scripts",   label: "Scripts sunset check",                          description: "Verify no legacy Shopify Scripts are active. Scripts stop executing June 30, 2026." },
  { id: "create",    label: "Create equivalent offers in Promo Engine",      description: "Recreate each BOGOS offer as a draft in the promo engine admin." },
  { id: "shadow",    label: "Enable shadow mode",                            description: "Run promo engine in parallel with BOGOS. Evaluation runs but cart mutations are skipped." },
  { id: "validate",  label: "Validate parity",                               description: "Compare evaluation results between BOGOS and promo engine. Fix any discrepancies." },
  { id: "testtheme", label: "Test on duplicate theme",                       description: "Enable promo engine blocks on a duplicate theme. Disable BOGOS on that theme. QA all flows." },
  { id: "publish",   label: "Publish all offers",                            description: "Move offers from draft to active. Disable shadow mode." },
  { id: "cutover",   label: "Cutover — disable BOGOS",                      description: "Uninstall BOGOS app. Promo engine is now the sole promotion system." },
  { id: "cleanup",   label: "Post-cutover cleanup",                          description: "Remove BOGOS CSS classes, event listeners, and DOM markers from theme code." },
];

type StepStatus = "pending" | "running" | "done" | "error";

function StatusBadge({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, { cls: string; label: string }> = {
    pending: { cls: "b-badge b-badge-gray",   label: "Pending"  },
    running: { cls: "b-badge b-badge-blue",   label: "Running"  },
    done:    { cls: "b-badge b-badge-green",  label: "Done"     },
    error:   { cls: "b-badge",                label: "Error"    },
  };
  const { cls, label } = map[status];
  const style = status === "error"
    ? { background: "var(--red-bg)", color: "var(--red)", borderRadius: "var(--r-pill)", fontSize: 12, fontWeight: 500, padding: "2px 10px", lineHeight: 1.4 }
    : undefined;
  return <span className={cls} style={style}>{label}</span>;
}

export default function MigrationPage() {
  const { shadowMode, activeOffers, draftOffers } = useLoaderData<typeof loader>();
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>(
    () => Object.fromEntries(MIGRATION_STEPS.map((s) => [s.id, "pending" as StepStatus]))
  );

  const doneCount  = Object.values(stepStatuses).filter((v) => v === "done").length;
  const progress   = Math.round((doneCount / MIGRATION_STEPS.length) * 100);

  function cycleStatus(id: string) {
    const order: StepStatus[] = ["pending", "running", "done", "error"];
    setStepStatuses((prev) => {
      const cur = prev[id] ?? "pending";
      const next = order[(order.indexOf(cur) + 1) % order.length];
      return { ...prev, [id]: next } as Record<string, StepStatus>;
    });
  }

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <h1 className="b-page-title">Migration</h1>
          {progress === 100 && (
            <span className="b-badge b-badge-green">Complete</span>
          )}
        </div>
        <div className="b-page-actions">
          <Form method="POST">
            {shadowMode ? (
              <button
                className="b-btn b-btn-danger"
                type="submit"
                name="intent"
                value="disable_shadow"
              >
                Disable Shadow Mode (go live)
              </button>
            ) : (
              <button
                className="b-btn b-btn-primary"
                type="submit"
                name="intent"
                value="enable_shadow"
              >
                Run Migration
              </button>
            )}
          </Form>
        </div>
      </div>

      {/* Scripts sunset warning */}
      <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
        <div className="b-banner-icon" style={{ fontSize: 18 }}>&#9888;</div>
        <div className="b-banner-body">
          <div className="b-banner-title">Shopify Scripts sunset: June 30, 2026</div>
          <p className="b-banner-text">
            Before migrating, audit whether BOGOS uses any Shopify Scripts. Scripts stop executing on
            June 30, 2026. All Script-based promotion logic must be replaced by Discount Functions before that date.
          </p>
        </div>
      </div>

      {/* Progress + status row */}
      <div className="b-grid-2" style={{ marginBottom: 16 }}>
        {/* Progress card */}
        <div className="b-card">
          <div className="b-card-header">Migration Progress</div>
          <div className="b-card-body">
            <div className="b-row-between b-mb-4" style={{ marginBottom: 8 }}>
              <span className="b-text-sm b-text-sub">{doneCount} / {MIGRATION_STEPS.length} steps complete</span>
              <span className={`b-badge ${progress === 100 ? "b-badge-green" : progress > 50 ? "b-badge-orange" : "b-badge-blue"}`}>
                {progress === 100 ? "Migration Complete" : `${progress}%`}
              </span>
            </div>
            <div className="b-progress">
              <div className="b-progress-fill" style={{ width: `${progress}%`, background: "var(--green)" }} />
            </div>
          </div>
        </div>

        {/* Status card */}
        <div className="b-card">
          <div className="b-card-header">Current Status</div>
          <div className="b-card-body b-stack b-stack-2">
            <div className="b-row b-gap-3">
              <span className="b-text-bold b-text-sm">Shadow mode</span>
              <span className={`b-badge ${shadowMode ? "b-badge-orange" : "b-badge-gray"}`}>
                {shadowMode ? "Enabled — evaluating, not mutating" : "Disabled"}
              </span>
            </div>
            <div className="b-row b-gap-3">
              <span className="b-text-bold b-text-sm">Active offers</span>
              <span className="b-text-sm">{activeOffers}</span>
            </div>
            <div className="b-row b-gap-3">
              <span className="b-text-bold b-text-sm">Draft offers</span>
              <span className="b-text-sm">{draftOffers}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Migration steps table */}
      <div className="b-table-wrap">
        <div className="b-card-header" style={{ borderBottom: "1px solid var(--border)" }}>
          Migration Checklist
        </div>
        <table className="b-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>Step</th>
              <th>Description</th>
              <th style={{ width: 110 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {MIGRATION_STEPS.map((step, i) => (
              <tr key={step.id}>
                <td>
                  <span className="b-text-sm b-text-muted">{i + 1}</span>
                </td>
                <td>
                  <span
                    className="b-text-sm b-text-bold"
                    style={{
                      textDecoration: stepStatuses[step.id] === "done" ? "line-through" : "none",
                      color: stepStatuses[step.id] === "done" ? "var(--text-muted)" : "var(--text)",
                    }}
                  >
                    {step.label}
                  </span>
                </td>
                <td>
                  <span className="b-text-xs b-text-sub">{step.description}</span>
                </td>
                <td>
                  <button
                    className="b-btn-plain"
                    type="button"
                    title="Click to advance status"
                    onClick={() => cycleStatus(step.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <StatusBadge status={stepStatuses[step.id] ?? "pending"} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
