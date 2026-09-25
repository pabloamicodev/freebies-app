import { useState } from "react";
import { Form, Link } from "react-router";
import { ProductPicker } from "./ProductPicker.js";
import type { SubscriptionCyclePricingPlan } from "../lib/subscription-cycle-pricing.js";

interface Props {
  plan?: SubscriptionCyclePricingPlan;
  error?: string;
  isSubmitting: boolean;
  submitLabel: string;
}

export function SubscriptionCyclePricingForm({ plan, error, isSubmitting, submitLabel }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [productIds, setProductIds] = useState(plan?.productIds ?? []);

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mode="products"
        allowMultiple
        title="Select subscription products"
        selectedIds={productIds}
        onSelect={setProductIds}
      />
      <Form method="post" className="b-stack b-gap-5">
        {error && <div className="b-banner b-banner-red" role="alert">{error}</div>}

        <div>
          <label className="b-label" htmlFor="cyclePlanName">Plan name</label>
          <input id="cyclePlanName" name="name" className="b-input" defaultValue={plan?.name ?? ""} required autoComplete="off" placeholder="3-month subscription" />
        </div>

        <div className="b-grid-2">
          <div>
            <label className="b-label" htmlFor="intervalUnit">Billing interval</label>
            <select id="intervalUnit" name="intervalUnit" className="b-select" defaultValue={plan?.intervalUnit ?? "MONTH"}>
              <option value="DAY">Day</option>
              <option value="WEEK">Week</option>
              <option value="MONTH">Month</option>
              <option value="YEAR">Year</option>
            </select>
          </div>
          <div>
            <label className="b-label" htmlFor="intervalCount">Every</label>
            <input id="intervalCount" name="intervalCount" type="number" min="1" step="1" className="b-input" defaultValue={plan?.intervalCount ?? 1} required />
          </div>
          <div>
            <label className="b-label" htmlFor="totalCycles">Total billing cycles</label>
            <input id="totalCycles" name="totalCycles" type="number" min="2" step="1" className="b-input" defaultValue={plan?.totalCycles ?? 3} required />
          </div>
        </div>

        <fieldset className="b-card b-p-4">
          <legend className="b-label">First cycle</legend>
          <div className="b-grid-2">
            <select name="firstCycleDiscountType" className="b-select" aria-label="First-cycle discount type" defaultValue={plan?.firstCycleDiscount.type ?? "percentage"}>
              <option value="percentage">Percentage off</option>
              <option value="fixed_amount">Fixed amount off</option>
            </select>
            <input name="firstCycleDiscountValue" type="number" min="0" step="0.01" className="b-input" aria-label="First-cycle discount value" defaultValue={plan?.firstCycleDiscount.value ?? 0} required />
          </div>
        </fieldset>

        <fieldset className="b-card b-p-4">
          <legend className="b-label">Cycle 2 onward</legend>
          <div className="b-grid-2">
            <select name="recurringDiscountType" className="b-select" aria-label="Recurring discount type" defaultValue={plan?.recurringDiscount.type ?? "fixed_amount"}>
              <option value="percentage">Percentage off</option>
              <option value="fixed_amount">Fixed amount off</option>
            </select>
            <input name="recurringDiscountValue" type="number" min="0" step="0.01" className="b-input" aria-label="Recurring discount value" defaultValue={plan?.recurringDiscount.value ?? 2} required />
          </div>
        </fieldset>

        <fieldset className="b-card b-p-4">
          <legend className="b-label">Products</legend>
          <input type="hidden" name="productIds" value={JSON.stringify(productIds)} />
          <div className="b-row b-gap-3">
            <button type="button" className="b-btn b-btn-secondary" onClick={() => setPickerOpen(true)}>Select products</button>
            <span className="b-text-muted">{productIds.length} selected</span>
          </div>
          {productIds.length > 0 && (
            <ul className="b-stack b-gap-2 b-mt-3">
              {productIds.map((id) => (
                <li key={id} className="b-row b-gap-2">
                  <span>{plan?.productTitlesById[id] ?? id.split("/").pop()}</span>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setProductIds((current) => current.filter((value) => value !== id))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div className="b-row b-gap-3">
          <button type="submit" className="b-btn b-btn-primary" disabled={isSubmitting || productIds.length === 0}>{isSubmitting ? "Saving…" : submitLabel}</button>
          <Link to="/app/subscription-pricing" className="b-btn b-btn-secondary">Cancel</Link>
        </div>
      </Form>
    </>
  );
}
