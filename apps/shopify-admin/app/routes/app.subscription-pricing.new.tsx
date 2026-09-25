import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

// Legacy URL: plan creation lives in the offer-creation wizard.
export const loader = ({ request }: LoaderFunctionArgs) =>
  redirect(`/app/offers/new/subscription/cycle-pricing${new URL(request.url).search}`);
