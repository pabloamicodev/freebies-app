import { shopify } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await shopify.login(request);
  return null;
};
