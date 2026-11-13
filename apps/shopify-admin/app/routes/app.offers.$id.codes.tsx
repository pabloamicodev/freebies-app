/**
 * Offer Codes — the single place discount codes live. An offer with codes
 * applies only while one of its codes is entered at checkout or in the cart.
 */

import { parseUuidParam } from "../lib/route-params.js";
import { useRef, useState } from "react";
import { useLoaderData, Form, Link, useActionData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { waitUntil } from "@vercel/functions";
import { and, eq, sql } from "drizzle-orm";
import { PAGE_TYPES } from "@promo/shared-types";
import { discountCodes, offerCombinationPolicies, offerConditions } from "@promo/db";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { parseDateRange, parseInteger } from "../lib/offer-validation.server.js";
import { publishShopConfig } from "../lib/offer-publish-flow.server.js";
import { isPublishPending } from "../lib/publish-pending.server.js";
import { getCodeNotices, listDiscountCodes, type CodeSettings } from "../lib/discount-codes.server.js";
import { runOfferCodesCommand, type OfferCodesCommand } from "../lib/offer-codes.server.js";
import { DiscountMessageField } from "../components/DiscountMessageField.js";
import { automaticModeWarnings, type CodeRedemptionMode } from "../lib/code-redemption.js";
import { CODE_CHARSETS, isCodeRedeemable, type CodeCharset } from "../lib/discount-code-generation.js";
import "../styles/bogos.css";
import { CapacityLimitModal } from "../components/CapacityLimitModal.js";
import { withCapacityModal } from "../lib/capacity-capture.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

const PAGE_SIZE = 50;
const STATUS_FILTERS = ["active", "disabled", "exhausted"] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db, timezone: shopTimezone, shopDomain } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const offer = await loadOwnedOffer(db, shopId, offerId);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const statusParam = url.searchParams.get("status");
  const status = STATUS_FILTERS.find((value) => value === statusParam);
  const page = Math.max(Number(url.searchParams.get("page") ?? "1") || 1, 1);

  const [{ rows, total }, counts, [pageCondition], [policy]] = await Promise.all([
    listDiscountCodes(db, shopId, offerId, { search, status, page, pageSize: PAGE_SIZE }),
    db
      .select({
        status: discountCodes.status,
        count: sql<number>`count(*)::int`,
        redemptions: sql<number>`coalesce(sum(${discountCodes.usageCount}), 0)::int`,
      })
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId)))
      .groupBy(discountCodes.status),
    db
      .select({ value: offerConditions.value })
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "page_types"), eq(offerConditions.isEnabled, true)))
      .limit(1),
    db
      .select({ order: offerCombinationPolicies.combinesWithOrderDiscounts })
      .from(offerCombinationPolicies)
      .where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId)))
      .limit(1),
  ]);
  // No page-types condition means no page restriction at all.
  const selectedPageTypes = pageCondition ? ((pageCondition.value as { pageTypes?: string[] }).pageTypes ?? []) : PAGE_TYPES;
  const automaticWarnings = automaticModeWarnings({
    combinesWithOrderDiscounts: policy?.order ?? true,
    pageTypes: selectedPageTypes,
  });
  const now = new Date();
  const [notices, publishPending] = await Promise.all([getCodeNotices(db, shopId, offer, now), isPublishPending(shopId)]);
  return {
    notices,
    publishPending,
    shopDomain,
    automaticWarnings,
    offer: {
      codeRedemption: offer.codeRedemption,
      publicTitle: offer.publicTitle,
      id: offer.id,
      internalName: offer.internalName,
      status: offer.status,
      legacyCode: offer.requiredDiscountCode,
      timezone: offer.timezone ?? shopTimezone,
    },
    codes: rows.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      live: isCodeRedeemable(row, now),
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      usageLimit: row.usageLimit,
      usageCount: row.usageCount,
      oncePerCustomer: row.oncePerCustomer,
      synced: Boolean(row.shopifySyncedAt),
      syncPending: Boolean(row.shopifySyncPendingAt),
      syncNote: row.syncNote,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    search,
    status: status ?? "",
    summary: {
      total: counts.reduce((sum, row) => sum + row.count, 0),
      active: counts.find((row) => row.status === "active")?.count ?? 0,
      disabled: counts.find((row) => row.status === "disabled")?.count ?? 0,
      exhausted: counts.find((row) => row.status === "exhausted")?.count ?? 0,
      redemptions: counts.reduce((sum, row) => sum + row.redemptions, 0),
    },
  };
};

function parseSettings(formData: FormData, timeZone: string): { error: string } | { settings: CodeSettings } {
  const dates = parseDateRange(formData, timeZone);
  if (dates.error) return { error: dates.error };
  const limit = parseInteger(formData, "usageLimit", 0, { min: 1, label: "Usage limit" });
  if (limit.error) return { error: limit.error };
  const rawLimit = String(formData.get("usageLimit") ?? "").trim();
  return {
    settings: {
      startsAt: dates.data!.startsAt,
      endsAt: dates.data!.endsAt,
      usageLimit: rawLimit ? limit.data! : null,
      oncePerCustomer: formData.get("oncePerCustomer") === "on",
    },
  };
}

export const action = withCapacityModal(async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db, timezone: shopTimezone, currencyCode } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const offer = await loadOwnedOffer(db, shopId, offerId);
  const deps = { db, shopId, shopDomain: session.shop, shopCurrency: currencyCode, timezone: offer.timezone ?? shopTimezone };
  const command = formToCommand(intent, formData, deps.timezone);
  if ("error" in command) return { error: command.error };

  const result = await runOfferCodesCommand(deps, offerId, command.command, { performedBy: "admin", allowDeferredPublish: true });
  if (!result.ok) {
    if (result.kind === "not_found") throw new Response("Not found", { status: 404 });
    return { error: result.error };
  }
  if (result.deferredPublish) waitUntil(publishShopConfig(shopId, session.shop));
  return { success: result.message, ...(result.warning ? { warning: result.warning } : {}) };
});

function formToCommand(intent: string, formData: FormData, timeZone: string): { command: OfferCodesCommand } | { error: string } {
  if (intent === "add_code" || intent === "generate_batch") {
    const parsed = parseSettings(formData, timeZone);
    if ("error" in parsed) return { error: parsed.error };
    if (intent === "add_code") return { command: { intent, code: formData.get("code"), settings: parsed.settings } };
    const count = parseInteger(formData, "count", 0, { min: 1, label: "Number of codes" });
    const length = parseInteger(formData, "length", 8, { min: 4, max: 32, label: "Code length" });
    if (count.error) return { error: count.error };
    if (length.error) return { error: length.error };
    const charset = String(formData.get("charset") ?? "unambiguous") as CodeCharset;
    return {
      command: {
        intent,
        spec: { prefix: String(formData.get("prefix") ?? ""), length: length.data!, charset, count: count.data! },
        settings: parsed.settings,
      },
    };
  }
  if (intent === "activate" || intent === "deactivate") {
    const ids = formData.getAll("ids").map(String);
    const batchId = String(formData.get("batchId") ?? "");
    const all = formData.get("all") === "1";
    if (ids.length === 0 && !batchId && !all) return { error: "Select at least one code." };
    return {
      command: {
        intent: "set_status",
        status: intent === "activate" ? "active" : "disabled",
        target: { ids: ids.length > 0 ? ids : undefined, batchId: batchId || undefined, all },
      },
    };
  }
  if (intent === "set_discount_message") return { command: { intent, message: formData.get("publicTitle") } };
  if (intent === "set_redemption_mode") return { command: { intent, mode: String(formData.get("mode") ?? "") as CodeRedemptionMode } };
  if (intent === "retry_original") return { command: { intent, codeId: String(formData.get("codeId") ?? "") } };
  if (intent === "delete") return { command: { intent, ids: formData.getAll("ids").map(String) } };
  return { error: "Unknown action." };
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="b-btn"
      style={{ padding: "2px 8px", fontSize: 12 }}
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => undefined);
      }}
      title={url}
    >
      {copied ? "Copied" : "Copy shareable link"}
    </button>
  );
}

function statusBadge(status: string, live: boolean) {
  if (status === "exhausted") return <span className="b-badge b-badge-orange">Used up</span>;
  if (status === "disabled") return <span className="b-badge b-badge-gray">Deactivated</span>;
  return live ? (
    <span className="b-badge b-badge-green">Active</span>
  ) : (
    <span className="b-badge b-badge-gray">Scheduled / expired</span>
  );
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
}

function SettingsFields({ prefix }: { prefix: string }) {
  return (
    <>
      <div>
        <label className="b-label" htmlFor={`${prefix}-limit`}>Usage limit (optional)</label>
        <input id={`${prefix}-limit`} className="b-input" name="usageLimit" type="number" min={1} placeholder="No limit" />
        <p className="b-help">How many times each code can be used in total.</p>
      </div>
      <div>
        <label className="b-label" htmlFor={`${prefix}-starts`}>Start time (optional)</label>
        <input id={`${prefix}-starts`} className="b-input" name="startsAt" type="datetime-local" />
      </div>
      <div>
        <label className="b-label" htmlFor={`${prefix}-ends`}>End time (optional)</label>
        <input id={`${prefix}-ends`} className="b-input" name="endsAt" type="datetime-local" />
      </div>
      <label className="b-checkbox-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" name="oncePerCustomer" />
        <span>Limit to one use per customer</span>
      </label>
    </>
  );
}

export default function OfferCodesPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const busy = navigation.state !== "idle";
  const submit = useSubmit();
  const listFormRef = useRef<HTMLFormElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingMode, setConfirmingMode] = useState(false);
  const [discountMessage, setDiscountMessage] = useState(data.offer.publicTitle);
  const automatic = data.offer.codeRedemption === "automatic";
  const pages = Math.max(Math.ceil(data.total / data.pageSize), 1);
  const exportQuery = new URLSearchParams();
  if (data.search) exportQuery.set("q", data.search);
  if (data.status) exportQuery.set("status", data.status);
  const pageLink = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    return `?${next.toString()}`;
  };

  return (
    <div className="b-page">
      <CapacityLimitModal data={actionData?.capacity} />
      <PageHeader
        title="Discount codes"
        subtitle={data.offer.internalName}
        backTo={`/app/offers/${data.offer.id}`}
        actions={
          <a
            href={`/api/offers/${data.offer.id}/codes/export?${exportQuery.toString()}`}
            className="b-btn"
            download
          >
            Export CSV
          </a>
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red b-mb-4" role="alert">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
          </div>
        </div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="b-banner b-banner-green b-mb-4" role="status">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>{actionData.success}</p>
          </div>
        </div>
      )}

      {actionData && "warning" in actionData && actionData.warning && (
        <div className="b-banner b-banner-orange b-mb-4" role="status">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>{actionData.warning}</p>
          </div>
        </div>
      )}
      {data.publishPending && (
        <div className="b-banner b-banner-blue b-mb-4" role="status">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>Changes are being applied. Codes may take a minute to update in Shopify.</p>
          </div>
        </div>
      )}

      <div className="b-banner b-banner-blue b-mb-4" role="status">
        <div className="b-banner-body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p className="b-banner-text" style={{ margin: 0, flex: 1 }}>
            {automatic ? (
              <><strong>Applies automatically.</strong> No code is needed; the offer runs on its conditions alone. Its codes are paused and customers who type them get &quot;invalid&quot;. Switch back any time without losing them.</>
            ) : (
              <><strong>Customer enters a code at checkout.</strong> Switch to automatic if you would rather skip the code.</>
            )}
          </p>
          <button type="button" className="b-btn" disabled={busy} onClick={() => setConfirmingMode(true)}>
            {automatic ? "Require a code at checkout" : "Apply automatically"}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmingMode}
        ariaLabel="Change redemption mode"
        title={automatic ? "Require a code at checkout?" : "Apply this offer automatically?"}
        destructive={false}
        confirmLabel={automatic ? "Require a code" : "Apply automatically"}
        message={
          automatic ? (
            <p style={{ margin: 0 }}>Customers will need to enter one of this offer&apos;s codes at checkout again. The paused codes become active, with their usage limits and once-per-customer rules enforced.</p>
          ) : (
            <div>
              <p style={{ marginTop: 0 }}>Customers will no longer need a code. This offer will apply to every cart that meets its conditions.</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>The codes are paused: customers who type one will get &quot;invalid&quot;. They are kept, so you can switch back.</li>
                <li>Usage limits, once-per-customer and code dates are not enforced.</li>
                <li>Combination rules are shared with all automatic offers.</li>
                <li>If the offer works on all pages, it applies sitewide.</li>
              </ul>
              {data.automaticWarnings.map((warning) => (
                <p key={warning} style={{ marginBottom: 0, color: "var(--red, #b91c1c)" }}>{warning}</p>
              ))}
            </div>
          )
        }
        onCancel={() => setConfirmingMode(false)}
        onConfirm={() => {
          setConfirmingMode(false);
          const fd = new FormData();
          fd.set("intent", "set_redemption_mode");
          fd.set("mode", automatic ? "checkout_code" : "automatic");
          void submit(fd, { method: "POST" });
        }}
      />

      {automatic && (
        <Form method="POST" className="b-editor-section b-mb-4">
          <input type="hidden" name="intent" value="set_discount_message" />
          <div className="b-editor-section-body" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <DiscountMessageField value={discountMessage} onChange={setDiscountMessage} />
            </div>
            <button type="submit" className="b-btn" disabled={busy}>Save message</button>
          </div>
        </Form>
      )}

      {!automatic && data.notices.inert && (
        <div className="b-banner b-banner-orange b-mb-4" role="alert">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>
              This offer needs a discount code, but none can be redeemed right now, so it is not live.
              Add a code, or activate one below.
            </p>
          </div>
        </div>
      )}
      {data.notices.collisions.map((collision) => (
        <div key={collision.id} className="b-banner b-banner-orange b-mb-4" role="status">
          <div className="b-banner-body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <p className="b-banner-text" style={{ margin: 0, flex: 1 }}>
              {collision.requestedCode} already exists in Shopify
              {collision.existingDiscount ? ` (discount "${collision.existingDiscount}")` : ""}; it was published as{" "}
              <strong>{collision.code}</strong>.
            </p>
            <Form method="POST">
              <input type="hidden" name="intent" value="retry_original" />
              <input type="hidden" name="codeId" value={collision.id} />
              <button type="submit" className="b-btn" disabled={busy}>Retry original code</button>
            </Form>
          </div>
        </div>
      ))}

      {!automatic && <div className="b-banner b-banner-blue b-mb-4" role="status">
        <div className="b-banner-body">
          <p className="b-banner-text" style={{ margin: 0 }}>
            This offer applies only while the customer has one of its codes entered, at checkout or in the cart.
            Add the codes here; you never manage them in Shopify. Any conditions on this offer apply in addition
            to the code.
            {data.offer.legacyCode && (
              <>
                {" "}This offer still uses the older single code <strong>{data.offer.legacyCode}</strong>, which keeps
                working until you migrate it.
              </>
            )}
          </p>
        </div>
      </div>}

      <div className="b-editor-layout">
        <div>
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">
              Codes{" "}
              <span className="b-text-sm b-text-sub">
                {data.summary.total.toLocaleString("en-US")} total · {data.summary.active.toLocaleString("en-US")} active ·{" "}
                {data.summary.redemptions.toLocaleString("en-US")} redemptions
              </span>
            </h2>
            <div className="b-editor-section-body">
              <Form method="GET" className="b-stack b-stack-3" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input className="b-input" name="q" placeholder="Search codes" defaultValue={data.search} style={{ flex: 1, minWidth: 180 }} />
                  <select className="b-select" name="status" defaultValue={data.status} aria-label="Status">
                    <option value="">All statuses</option>
                    <option value="active">Active</option>
                    <option value="disabled">Deactivated</option>
                    <option value="exhausted">Used up</option>
                  </select>
                  <button type="submit" className="b-btn">Filter</button>
                </div>
              </Form>

              {data.codes.length === 0 ? (
                <p className="b-text-sub">No codes yet. Create one or generate a batch.</p>
              ) : (
                <Form method="POST" ref={listFormRef} data-no-dirty>
                  <div className="b-table-wrap">
                    <table className="b-table">
                      <thead>
                        <tr>
                          <th aria-label="Select" />
                          <th>Code</th>
                          <th>Status</th>
                          <th>Used</th>
                          <th>Starts</th>
                          <th>Ends</th>
                          {!automatic && <th aria-label="Link" />}
                        </tr>
                      </thead>
                      <tbody>
                        {data.codes.map((code) => (
                          <tr key={code.id}>
                            <td><input type="checkbox" name="ids" value={code.id} aria-label={`Select ${code.code}`} /></td>
                            <td>
                              <code>{code.code}</code>
                              {code.oncePerCustomer && <span className="b-text-sm b-text-sub"> · 1 per customer</span>}
                            </td>
                            <td>
                              {automatic && code.status === "active" ? <span className="b-badge b-badge-gray">Paused (automatic)</span> : statusBadge(code.status, code.live)}
                              {code.status === "disabled" && code.syncNote && (
                                <div className="b-text-sm b-text-sub" title={code.syncNote}>Disabled: {code.syncNote}</div>
                              )}
                              {code.syncPending && <span className="b-badge b-badge-blue"> Syncing with Shopify�</span>}
                            </td>
                            <td>{code.usageCount.toLocaleString("en-US")}{code.usageLimit ? ` / ${code.usageLimit.toLocaleString("en-US")}` : ""}</td>
                            <td>{formatDate(code.startsAt)}</td>
                            <td>{formatDate(code.endsAt)}</td>
                            {!automatic && (
                              <td>
                                <CopyLinkButton url={`https://${data.shopDomain}/discount/${encodeURIComponent(code.code)}`} />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button type="submit" name="intent" value="deactivate" className="b-btn" disabled={busy}>Deactivate selected</button>
                    <button type="submit" name="intent" value="activate" className="b-btn" disabled={busy}>Activate selected</button>
                    <button type="button" className="b-btn" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete selected</button>
                  </div>
                  <p className="b-help">Deleting is available once a deactivated code has been removed from Shopify.</p>
                  <ConfirmDialog
                    open={confirmingDelete}
                    ariaLabel="Delete selected codes"
                    title="Delete selected codes?"
                    message="The selected codes will be permanently deleted. This cannot be undone."
                    confirmLabel="Delete codes"
                    onCancel={() => setConfirmingDelete(false)}
                    onConfirm={() => {
                      setConfirmingDelete(false);
                      if (!listFormRef.current) return;
                      const fd = new FormData(listFormRef.current);
                      fd.set("intent", "delete");
                      void submit(fd, { method: "POST" });
                    }}
                  />
                </Form>
              )}

              {pages > 1 && (
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                  {data.page > 1 && <Link className="b-btn" to={pageLink(data.page - 1)}>Previous</Link>}
                  <span className="b-text-sm b-text-sub">Page {data.page} of {pages}</span>
                  {data.page < pages && <Link className="b-btn" to={pageLink(data.page + 1)}>Next</Link>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="b-editor-sidebar">
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Create code</h2>
            <div className="b-editor-section-body">
              <Form method="POST" className="b-stack b-stack-3">
                <input type="hidden" name="intent" value="add_code" />
                <div>
                  <label className="b-label" htmlFor="code">Discount code</label>
                  <input id="code" className="b-input" name="code" placeholder="SUMMER10" autoComplete="off" style={{ textTransform: "uppercase" }} required />
                  <p className="b-help">Customers can type it in any case.</p>
                </div>
                <SettingsFields prefix="single" />
                <button type="submit" className="b-btn b-btn-primary" disabled={busy}>Create code</button>
              </Form>
            </div>
          </div>

          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Generate codes</h2>
            <div className="b-editor-section-body">
              <Form method="POST" className="b-stack b-stack-3">
                <input type="hidden" name="intent" value="generate_batch" />
                <div>
                  <label className="b-label" htmlFor="count">Number of codes</label>
                  <input id="count" className="b-input" name="count" type="number" min={1} max={5000} defaultValue={100} required />
                </div>
                <div>
                  <label className="b-label" htmlFor="prefix">Prefix (optional)</label>
                  <input id="prefix" className="b-input" name="prefix" placeholder="AMZ-" autoComplete="off" style={{ textTransform: "uppercase" }} />
                </div>
                <div>
                  <label className="b-label" htmlFor="length">Code length</label>
                  <input id="length" className="b-input" name="length" type="number" min={4} max={32} defaultValue={8} />
                  <p className="b-help">Characters after the prefix.</p>
                </div>
                <div>
                  <label className="b-label" htmlFor="charset">Characters</label>
                  <select id="charset" className="b-select" name="charset" defaultValue="unambiguous">
                    {(Object.keys(CODE_CHARSETS) as CodeCharset[]).map((key) => (
                      <option key={key} value={key}>
                        {{ unambiguous: "Letters and numbers (no 0/O/1/I)", alphanumeric: "All letters and numbers", letters: "Letters only", numbers: "Numbers only" }[key]}
                      </option>
                    ))}
                  </select>
                </div>
                <SettingsFields prefix="batch" />
                <button type="submit" className="b-btn b-btn-primary" disabled={busy}>Generate codes</button>
              </Form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
