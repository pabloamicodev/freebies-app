import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

// Legacy standalone page: gift tiers are created from the gift wizard now.
export const loader = ({ request }: LoaderFunctionArgs) =>
  redirect(`/app/offers/new/gift/tiered${new URL(request.url).search}`);
