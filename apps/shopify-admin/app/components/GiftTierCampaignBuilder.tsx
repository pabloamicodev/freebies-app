import { useMemo, useState } from "react";
import { Form } from "react-router";
import { ProductPicker } from "./ProductPicker.js";
import { OfferConditionsBuilder } from "./OfferConditionsBuilder.js";

interface TierDraft {
  id: string;
  minimumSubtotal: string;
  quantity: string;
  variantIds: string[];
}

export function GiftTierCampaignBuilder({ action }: { action?: string } = {}) {
  const [campaignId, setCampaignId] = useState("");
  const [name, setName] = useState("");
  const [stackingMode, setStackingMode] = useState<"highest_tier_only" | "cumulative">(
    "highest_tier_only",
  );
  const [tiers, setTiers] = useState<TierDraft[]>([
    { id: "tier-1", minimumSubtotal: "50", quantity: "1", variantIds: [] },
  ]);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  const serialized = useMemo(
    () =>
      JSON.stringify({
        campaignId,
        name,
        stackingMode,
        tiers: tiers.map((tier) => ({
          id: tier.id,
          minimumSubtotalCents: Math.round(Number(tier.minimumSubtotal) * 100),
          quantity: Number(tier.quantity),
          variantIds: tier.variantIds,
        })),
      }),
    [campaignId, name, stackingMode, tiers],
  );

  const updateTier = (index: number, patch: Partial<TierDraft>) =>
    setTiers((current) =>
      current.map((tier, tierIndex) => (tierIndex === index ? { ...tier, ...patch } : tier)),
    );

  return (
    <>
      <ProductPicker
        open={pickerIndex !== null}
        onClose={() => setPickerIndex(null)}
        mode="variants"
        allowMultiple
        title="Select gift variants"
        selectedIds={pickerIndex === null ? [] : (tiers[pickerIndex]?.variantIds ?? [])}
        onSelect={(ids) => {
          if (pickerIndex !== null) updateTier(pickerIndex, { variantIds: ids });
          setPickerIndex(null);
        }}
      />
      <Form method="post" action={action} className="b-card b-p-5 b-stack b-gap-5">
        <input type="hidden" name="intent" value="create-campaign" />
        <input type="hidden" name="campaign" value={serialized} />
        <div className="b-grid-2">
          <div>
            <label className="b-label" htmlFor="giftCampaignName">
              Campaign name
            </label>
            <input
              id="giftCampaignName"
              className="b-input"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label className="b-label" htmlFor="giftCampaignId">
              Campaign ID
            </label>
            <input
              id="giftCampaignId"
              className="b-input"
              required
              pattern="[a-z0-9][a-z0-9-]*"
              value={campaignId}
              onChange={(event) =>
                setCampaignId(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
              }
            />
          </div>
          <div>
            <label className="b-label" htmlFor="giftStacking">
              Stacking
            </label>
            <select
              id="giftStacking"
              className="b-select"
              value={stackingMode}
              onChange={(event) => setStackingMode(event.target.value as typeof stackingMode)}
            >
              <option value="highest_tier_only">Highest qualifying tier only</option>
              <option value="cumulative">Every qualifying tier</option>
            </select>
          </div>
        </div>

        <div className="b-stack b-gap-4">
          {tiers.map((tier, index) => (
            <section className="b-subcard" key={`${index}-${tier.id}`}>
              <div className="b-row b-justify-between b-mb-4">
                <h3 className="b-editor-section-title">Gift tier {index + 1}</h3>
                {tiers.length > 1 && (
                  <button
                    type="button"
                    className="b-btn b-btn-secondary b-btn-sm"
                    onClick={() =>
                      setTiers((current) => current.filter((_, tierIndex) => tierIndex !== index))
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="b-grid-3">
                <div>
                  <label className="b-label" htmlFor={`giftTierId-${index}`}>
                    Tier ID
                  </label>
                  <input
                    id={`giftTierId-${index}`}
                    className="b-input"
                    required
                    pattern="[a-z0-9][a-z0-9-]*"
                    value={tier.id}
                    onChange={(event) =>
                      updateTier(index, {
                        id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                      })
                    }
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor={`giftTierMinimum-${index}`}>
                    Minimum subtotal
                  </label>
                  <input
                    id={`giftTierMinimum-${index}`}
                    className="b-input"
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={tier.minimumSubtotal}
                    onChange={(event) => updateTier(index, { minimumSubtotal: event.target.value })}
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor={`giftTierQuantity-${index}`}>
                    Gift quantity
                  </label>
                  <input
                    id={`giftTierQuantity-${index}`}
                    className="b-input"
                    required
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={tier.quantity}
                    onChange={(event) => updateTier(index, { quantity: event.target.value })}
                  />
                </div>
              </div>
              <div className="b-row b-gap-3 b-mt-4">
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => setPickerIndex(index)}
                >
                  Select gift variants
                </button>
                <span className="b-text-sm b-text-muted">
                  {tier.variantIds.length ? `${tier.variantIds.length} selected` : "Required"}
                </span>
              </div>
              {tier.variantIds.length > 0 && (
                <div className="b-chip-list">
                  {tier.variantIds.map((id) => (
                    <button
                      type="button"
                      className="b-chip"
                      key={id}
                      onClick={() =>
                        updateTier(index, {
                          variantIds: tier.variantIds.filter((candidate) => candidate !== id),
                        })
                      }
                    >
                      {id.split("/").pop()} ×
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>

        <OfferConditionsBuilder
          title="Campaign eligibility conditions"
          description="Apply the same URL, customer, location, subscription, attribute, and usage conditions to every generated tier."
        />

        <div className="b-row b-gap-3">
          <button
            type="button"
            className="b-btn b-btn-secondary"
            onClick={() =>
              setTiers((current) => [
                ...current,
                {
                  id: `tier-${current.length + 1}`,
                  minimumSubtotal: "",
                  quantity: "1",
                  variantIds: [],
                },
              ])
            }
          >
            Add tier
          </button>
          <button
            type="submit"
            className="b-btn b-btn-primary"
            disabled={tiers.some((tier) => tier.variantIds.length === 0)}
          >
            Create draft offers
          </button>
        </div>
        <p className="b-help">
          Each tier becomes a normal draft offer with an inclusive lower bound and an automatically
          derived upper bound, so tiers never overlap.
        </p>
      </Form>
    </>
  );
}
