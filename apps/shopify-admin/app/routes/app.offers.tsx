import { Outlet } from "react-router";
export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export default function OffersLayout() {
  return <Outlet />;
}
