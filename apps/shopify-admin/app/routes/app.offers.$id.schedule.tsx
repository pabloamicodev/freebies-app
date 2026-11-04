/**
 * Offer Schedule editor — configure start/end dates and timezone.
 */

import { parseUuidParam } from "../lib/route-params.js";
import { useRef, useState } from "react";
import { useLoaderData, Form, useActionData, useNavigation, useSubmit } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { BackButton } from "../components/BackButton.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { toZonedLocalInput } from "../lib/offer-validation.server.js";
import { setOfferSchedule } from "../lib/offer-lifecycle.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

function timezoneOptions(...extra: string[]): string[] {
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set(["UTC", ...supported, ...extra])].sort();
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db, timezone: shopTimezone } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const offer = await loadOwnedOffer(db, shopId, offerId);
  const timezone = offer.timezone ?? shopTimezone;
  return {
    timezones: timezoneOptions(timezone, shopTimezone),
    offer: {
      id: offer.id, internalName: offer.internalName, status: offer.status,
      startsAt: toZonedLocalInput(offer.startsAt, timezone),
      endsAt: toZonedLocalInput(offer.endsAt, timezone),
      timezone,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db, timezone: shopTimezone } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const formData = await request.formData();
  const input = {
    shopId,
    shopDomain: session.shop,
    offerId,
    shopTimezone,
    timezone: (formData.get("timezone") as string) || null,
    startsAt: (formData.get("starts_at") as string | null) ?? "",
    endsAt: (formData.get("ends_at") as string | null) ?? "",
  };
  const check = await setOfferSchedule(db, input, { performedBy: session.shop, dryRun: true });
  if (!check.ok) {
    if (check.code === "not_found") throw new Response("Not found", { status: 404 });
    return { error: check.error };
  }
  const warnings = check.warnings ?? [];
  if (warnings.length > 0 && formData.get("acknowledgeWarnings") !== "1") return { warnings };
  const result = await setOfferSchedule(db, input, { performedBy: session.shop, publishWarnings: async () => warnings });
  if (!result.ok) {
    if (result.code === "not_found") throw new Response("Not found", { status: 404 });
    return { error: result.error };
  }
  return { success: true };
};

function statusBadgeClass(status: string) {
  switch (status) {
    case "active":   return "b-badge b-badge-green";
    case "draft":    return "b-badge b-badge-gray";
    case "paused":   return "b-badge b-badge-orange";
    case "archived": return "b-badge b-badge-gray";
    default:         return "b-badge b-badge-gray";
  }
}

export default function OfferSchedulePage() {
  const { offer, timezones } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);
  const [dismissedWarnings, setDismissedWarnings] = useState<unknown>(null);
  const warnings = actionData && "warnings" in actionData ? actionData.warnings : undefined;

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <BackButton to={`/app/offers/${offer.id}`} />
          <h1 className="b-page-title">Schedule</h1>
          <span className={statusBadgeClass(offer.status ?? "draft")}>
            {offer.status ?? "draft"}
          </span>
        </div>
        <span className="b-text-sm b-text-sub b-truncate" style={{ maxWidth: 280 }}>
          {offer.internalName}
        </span>
      </div>


      <ConfirmDialog
        open={Boolean(warnings?.length) && dismissedWarnings !== actionData}
        ariaLabel="Publish warnings"
        title="Publish anyway?"
        message={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {warnings?.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        }
        confirmLabel="Publish anyway"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => {
          setDismissedWarnings(actionData);
          if (!formRef.current) return;
          const data = new FormData(formRef.current);
          data.set("acknowledgeWarnings", "1");
          void submit(data, { method: "POST" });
        }}
        onCancel={() => setDismissedWarnings(actionData)}
      />

      {/* Action feedback */}
      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red b-mb-4">
          <span className="b-banner-icon">✕</span>
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
          </div>
        </div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="b-banner b-banner-green b-mb-4" role="status">
          <span className="b-banner-icon">✓</span>
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>Schedule saved.</p>
          </div>
        </div>
      )}

      {/* Body: main + sidebar */}
      <div className="b-editor-layout">

        {/* Main card */}
        <div>
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Schedule Settings</h2>
            <div className="b-editor-section-body">
              <Form method="POST" ref={formRef}>
                <div className="b-stack b-stack-4">

                  {/* Start time */}
                  <div>
                    <label className="b-label" htmlFor="starts_at">Start time</label>
                    <input
                      id="starts_at"
                      className="b-input"
                      type="datetime-local"
                      name="starts_at"
                      defaultValue={offer.startsAt}
                    />
                  </div>

                  {/* End time */}
                  <div>
                    <label className="b-label" htmlFor="ends_at">End time</label>
                    <input
                      id="ends_at"
                      className="b-input"
                      type="datetime-local"
                      name="ends_at"
                      defaultValue={offer.endsAt}
                    />
                    <p className="b-help">Leave blank for no end date</p>
                  </div>

                  {/* Timezone */}
                  <div>
                    <label className="b-label" htmlFor="timezone">Timezone</label>
                    <select
                      id="timezone"
                      className="b-select"
                      name="timezone"
                      defaultValue={offer.timezone}
                    >
                      {timezones.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </div>

                  {/* Save */}
                  <div>
                    <button
                      type="submit"
                      className="b-btn b-btn-primary"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? "Saving…" : "Save"}
                    </button>
                  </div>

                </div>
              </Form>
            </div>
          </div>
        </div>

        {/* Right sidebar info card */}
        <div className="b-editor-sidebar">
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">How scheduling works</h2>
            <div className="b-editor-section-body">
              <div className="b-stack b-stack-3">
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  Set a start and end time to automatically activate and deactivate
                  this offer. All times are evaluated in the selected timezone.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  If you leave the start time blank, the offer becomes active
                  immediately once enabled. If you leave the end time blank, the
                  offer runs indefinitely until you manually pause or archive it.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  Scheduled offers only activate when their status is set to
                  <strong> Active</strong>. A draft or paused offer will not go
                  live even if the scheduled window has started.
                </p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
