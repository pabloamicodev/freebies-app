import type { ActionFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { restoreArchivedOffers } from "../lib/restore-archived-offers.contract.server.js";
import { safeErrorMessage } from "../lib/safe-error.js";

/** POST /app/restore-offers: one-click restore of the offers archived when the app was uninstalled. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { db, shopId, shopDomain } = await getShopContext(request);
  try {
    const result = await restoreArchivedOffers({ db, shopId, shopDomain });
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error: safeErrorMessage(error, "Could not restore your offers. Try again in a moment.") };
  }
};
