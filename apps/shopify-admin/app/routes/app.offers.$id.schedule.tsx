/**
 * Offer Schedule editor — configure start/end dates and timezone.
 */

import { useLoaderData, Form, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo",
  "Asia/Singapore", "Australia/Sydney",
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });
  return {
    offer: {
      id: offer.id, internalName: offer.internalName, status: offer.status,
      startsAt: offer.startsAt?.toISOString().slice(0, 16) ?? "",
      endsAt: offer.endsAt?.toISOString().slice(0, 16) ?? "",
      timezone: offer.timezone ?? "UTC",
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  const startsAtStr = formData.get("starts_at") as string;
  const endsAtStr = formData.get("ends_at") as string;
  const timezone = (formData.get("timezone") as string) || "UTC";

  await db.update(offers).set({
    startsAt: startsAtStr ? new Date(startsAtStr) : null,
    endsAt: endsAtStr ? new Date(endsAtStr) : null,
    timezone,
    updatedAt: new Date(),
  }).where(eq(offers.id, offerId));

  return null;
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
  const { offer } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <Link
            to={`/app/offers/${offer.id}`}
            className="b-btn b-btn-secondary b-btn-sm"
            style={{ textDecoration: "none" }}
          >
            ← Back
          </Link>
          <h1 className="b-page-title">Schedule</h1>
          <span className={statusBadgeClass(offer.status ?? "draft")}>
            {offer.status ?? "draft"}
          </span>
        </div>
        <span className="b-text-sm b-text-sub b-truncate" style={{ maxWidth: 280 }}>
          {offer.internalName}
        </span>
      </div>

      {/* Body: main + sidebar */}
      <div className="b-editor-layout">

        {/* Main card */}
        <div>
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Schedule Settings</h2>
            <div className="b-editor-section-body">
              <Form method="POST">
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
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </div>

                  {/* Save */}
                  <div>
                    <button type="submit" className="b-btn b-btn-primary">
                      Save
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
