import { Outlet, useLoaderData, useLocation, useParams } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { getOfferPublishErrors } from "../lib/offer-publish-errors.server.js";
import { OfferEditGuard } from "../components/OfferEditGuard.js";
import { OfferStepTabs, type OfferStepKey } from "../components/OfferStepTabs.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const STEP_KEYS: OfferStepKey[] = ["conditions", "codes", "rewards", "combination", "schedule", "widget", "preview"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId } = await getShopContext(request);
  const id = params["id"];
  const errors = await getOfferPublishErrors(shopId);
  return { publishError: (id && errors[id]) || null };
};

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
  const { publishError } = useLoaderData<typeof loader>();
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
      {publishError && (
        <div className="b-banner b-banner-critical" role="alert" style={{ margin: "12px 24px 0" }}>
          <div className="b-banner-body">
            <div className="b-banner-title">Part of this offer is not live</div>
            <p className="b-banner-text">{publishError}</p>
          </div>
        </div>
      )}
      <OfferEditGuard>
        <Outlet />
      </OfferEditGuard>
    </>
  );
}
