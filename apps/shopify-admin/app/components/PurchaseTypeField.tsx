import { useState } from "react";
import { purchaseTypesToMode, type SubscriptionMode } from "../lib/purchase-type.js";

interface Props {
  defaultMode?: SubscriptionMode;
  idPrefix?: string;
}

/** Posts `subscriptionMode`; at least one purchase type always stays checked. */
export function PurchaseTypeField({ defaultMode = "any", idPrefix = "purchase-type" }: Props) {
  const [oneTime, setOneTime] = useState(defaultMode !== "subscription_only");
  const [subscription, setSubscription] = useState(defaultMode !== "one_time_only");
  const mode = purchaseTypesToMode(oneTime, subscription);
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="b-label">Apply to</legend>
      <input type="hidden" name="subscriptionMode" value={mode} />
      <label style={{ display: "flex", gap: 8, alignItems: "center" }} htmlFor={`${idPrefix}-one-time`}>
        <input
          id={`${idPrefix}-one-time`}
          type="checkbox"
          checked={oneTime}
          onChange={(event) => {
            if (!event.target.checked && !subscription) return;
            setOneTime(event.target.checked);
          }}
        />
        One-time purchases
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }} htmlFor={`${idPrefix}-subscription`}>
        <input
          id={`${idPrefix}-subscription`}
          type="checkbox"
          checked={subscription}
          onChange={(event) => {
            if (!event.target.checked && !oneTime) return;
            setSubscription(event.target.checked);
          }}
        />
        Subscriptions (Skio / selling plans)
      </label>
      <p className="b-help">At least one is required. Unchecking subscriptions keeps this discount off subscription lines.</p>
    </fieldset>
  );
}
