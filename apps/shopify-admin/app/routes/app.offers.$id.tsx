import { Outlet, useLocation, useParams } from "react-router";
import { OfferStepTabs, type OfferStepKey } from "../components/OfferStepTabs.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const STEP_KEYS: OfferStepKey[] = ["conditions", "codes", "rewards", "combination", "schedule", "widget", "preview"];

/**
 * Shared layout for every /app/offers/:id/* step page. Rendering the tab bar
 * here (instead of separately inside each step's own route file) keeps it
 * mounted across client-side navigations between steps — only the step
 * content below it now unmounts/remounts, not the tabs themselves. The
 * bare /app/offers/:id overview page (gift-offer inline editor) renders its
 * own copy of OfferStepTabs in a different position and is intentionally
 * left alone here (no step key matches its URL, so nothing renders twice).
 */
export default function OfferDetailLayout() {
  const { id } = useParams();
  const location = useLocation();
  const lastSegment = location.pathname.split("/").filter(Boolean).pop();
  const active = STEP_KEYS.find((key) => key === lastSegment);

  return (
    <>
      {id && active && (
        <div className="b-page-tabs-bar">
          <OfferStepTabs offerId={id} active={active} />
        </div>
      )}
      <Outlet />
    </>
  );
}
