import { useMemo, useState, type FormEvent } from "react";
import { Form } from "react-router";
import { ProductPicker } from "./ProductPicker.js";
import type { CycleOverride, SkioShippingTier } from "../lib/skio-shipping-tiers.js";

interface Props {
  tiers: SkioShippingTier[];
  disabled?: boolean;
}

interface Draft {
  originalId: string | null;
  id: string;
  name: string;
  subscriptionDurationMonths: string;
  minSubtotal: string;
  maxSubtotal: string;
  productVariantIds: string[];
  cycleOverrides: Array<{ cycle: string; amount: string }>;
  defaultAmount: string;
}

function emptyDraft(): Draft {
  return {
    originalId: null,
    id: "",
    name: "",
    subscriptionDurationMonths: "3",
    minSubtotal: "0",
    maxSubtotal: "",
    productVariantIds: [],
    cycleOverrides: [{ cycle: "1", amount: "" }],
    defaultAmount: "1.99",
  };
}

function tierToDraft(tier: SkioShippingTier): Draft {
  return {
    originalId: tier.id,
    id: tier.id,
    name: tier.name,
    subscriptionDurationMonths: String(tier.subscriptionDurationMonths),
    minSubtotal: String(tier.minSubtotal),
    maxSubtotal: tier.maxSubtotal === null ? "" : String(tier.maxSubtotal),
    productVariantIds: tier.productVariantIds ?? [],
    cycleOverrides: tier.cycleOverrides.map((entry) => ({
      cycle: String(entry.cycle),
      amount: entry.override.amount === null ? "" : String(entry.override.amount),
    })),
    defaultAmount: tier.defaultOverride.amount === null ? "" : String(tier.defaultOverride.amount),
  };
}

function numberOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function serializeDraft(draft: Draft): SkioShippingTier {
  const cycleOverrides: CycleOverride[] = draft.cycleOverrides.map((entry) => ({
    cycle: Number(entry.cycle),
    override: { amount: numberOrNull(entry.amount) },
  }));
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    subscriptionDurationMonths: Number(draft.subscriptionDurationMonths),
    minSubtotal: Number(draft.minSubtotal),
    maxSubtotal: numberOrNull(draft.maxSubtotal),
    productVariantIds: draft.productVariantIds.length ? draft.productVariantIds : null,
    cycleOverrides,
    defaultOverride: { amount: numberOrNull(draft.defaultAmount) },
  };
}

function money(value: number | null): string {
  return value === null ? "Shopify rate" : value === 0 ? "Free" : `$${value.toFixed(2)}`;
}

export function SkioShippingManager({ tiers, disabled = false }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const serialized = useMemo(() => draft ? JSON.stringify(serializeDraft(draft)) : "", [draft]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const updateCycle = (index: number, patch: Partial<Draft["cycleOverrides"][number]>) => {
    if (!draft) return;
    update("cycleOverrides", draft.cycleOverrides.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  };

  return (
    <section className="b-stack b-gap-4">
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mode="variants"
        allowMultiple
        title="Select variants for this Skio tier"
        selectedIds={draft?.productVariantIds ?? []}
        onSelect={(ids) => { update("productVariantIds", ids); setPickerOpen(false); }}
      />

      <div className="b-row b-justify-between b-gap-4">
        <div>
          <h2 className="b-editor-section-title">Shipping tiers</h2>
          <p className="b-text-muted">The first matching tier wins. Maximum subtotal is exclusive.</p>
        </div>
        <button type="button" className="b-btn b-btn-primary" disabled={disabled} onClick={() => setDraft(emptyDraft())}>New tier</button>
      </div>

      {tiers.length === 0 ? (
        <div className="b-card b-p-5"><p>No Skio shipping tiers yet.</p></div>
      ) : (
        <div className="b-card b-table-wrap">
          <table className="b-table">
            <thead><tr><th>Tier</th><th>Plan</th><th>Subtotal</th><th>Cycle pricing</th><th>Products</th><th>Actions</th></tr></thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id}>
                  <td><strong>{tier.name}</strong><div className="b-help">{tier.id}</div></td>
                  <td>{tier.subscriptionDurationMonths} months</td>
                  <td>${tier.minSubtotal.toFixed(2)} – {tier.maxSubtotal === null ? "No limit" : `$${tier.maxSubtotal.toFixed(2)}`}</td>
                  <td>{tier.cycleOverrides.map((entry) => `C${entry.cycle}: ${money(entry.override.amount)}`).join(" · ") || `All: ${money(tier.defaultOverride.amount)}`}</td>
                  <td>{tier.productVariantIds?.length ?? "All"}</td>
                  <td>
                    <div className="b-row b-gap-2">
                      <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setDraft(tierToDraft(tier))}>Edit</button>
                      <Form method="post" onSubmit={(event: FormEvent<HTMLFormElement>) => { if (!window.confirm(`Delete ${tier.name}?`)) event.preventDefault(); }}>
                        <input type="hidden" name="intent" value="delete-tier" />
                        <input type="hidden" name="tierId" value={tier.id} />
                        <button type="submit" className="b-btn b-btn-secondary b-btn-sm">Delete</button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <Form method="post" className="b-card b-p-5 b-stack b-gap-5">
          <input type="hidden" name="intent" value="save-tier" />
          <input type="hidden" name="tier" value={serialized} />
          <div className="b-row b-justify-between">
            <div><h3 className="b-editor-section-title">{draft.originalId ? "Edit shipping tier" : "New shipping tier"}</h3><p className="b-text-muted">Blank price means keep Skio's current calculated delivery price.</p></div>
            <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setDraft(null)}>Close</button>
          </div>

          <div className="b-grid-2">
            <div><label className="b-label" htmlFor="skioTierName">Name</label><input id="skioTierName" className="b-input" required value={draft.name} onChange={(event) => update("name", event.target.value)} /></div>
            <div><label className="b-label" htmlFor="skioTierId">Tier ID</label><input id="skioTierId" className="b-input" required pattern="[a-z0-9][a-z0-9-]*" disabled={Boolean(draft.originalId)} value={draft.id} onChange={(event) => update("id", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /></div>
            <div><label className="b-label" htmlFor="skioDuration">Subscription duration</label><div className="b-input-suffix"><input id="skioDuration" className="b-input" type="number" min="1" step="1" required value={draft.subscriptionDurationMonths} onChange={(event) => update("subscriptionDurationMonths", event.target.value)} /><span>months</span></div></div>
            <div><label className="b-label" htmlFor="skioDefault">Default shipping price</label><input id="skioDefault" className="b-input" type="number" min="0" step="0.01" placeholder="Keep current rate" value={draft.defaultAmount} onChange={(event) => update("defaultAmount", event.target.value)} /></div>
            <div><label className="b-label" htmlFor="skioMin">Minimum subtotal</label><input id="skioMin" className="b-input" type="number" min="0" step="0.01" required value={draft.minSubtotal} onChange={(event) => update("minSubtotal", event.target.value)} /></div>
            <div><label className="b-label" htmlFor="skioMax">Maximum subtotal</label><input id="skioMax" className="b-input" type="number" min="0" step="0.01" placeholder="No upper limit" value={draft.maxSubtotal} onChange={(event) => update("maxSubtotal", event.target.value)} /></div>
          </div>

          <fieldset className="b-stack b-gap-3">
            <legend className="b-label">Cycle overrides</legend>
            {draft.cycleOverrides.map((entry, index) => (
              <div className="b-grid-3" key={`${index}-${entry.cycle}`}>
                <div><label className="b-label" htmlFor={`skioCycle-${index}`}>Cycle</label><input id={`skioCycle-${index}`} className="b-input" type="number" min="1" step="1" required value={entry.cycle} onChange={(event) => updateCycle(index, { cycle: event.target.value })} /></div>
                <div><label className="b-label" htmlFor={`skioAmount-${index}`}>Shipping price</label><input id={`skioAmount-${index}`} className="b-input" type="number" min="0" step="0.01" placeholder="Keep current rate" value={entry.amount} onChange={(event) => updateCycle(index, { amount: event.target.value })} /></div>
                <div className="b-row b-items-end"><button type="button" className="b-btn b-btn-secondary" onClick={() => update("cycleOverrides", draft.cycleOverrides.filter((_, entryIndex) => entryIndex !== index))}>Remove</button></div>
              </div>
            ))}
            <button type="button" className="b-btn b-btn-secondary b-self-start" onClick={() => update("cycleOverrides", [...draft.cycleOverrides, { cycle: String(draft.cycleOverrides.length + 1), amount: "" }])}>Add cycle</button>
          </fieldset>

          <fieldset className="b-stack b-gap-3">
            <legend className="b-label">Product targeting</legend>
            <p className="b-help">Leave empty to match every product in a qualifying subscription.</p>
            <div className="b-row b-gap-3"><button type="button" className="b-btn b-btn-secondary" onClick={() => setPickerOpen(true)}>Select variants</button><span className="b-text-muted">{draft.productVariantIds.length || "All products"}</span></div>
            {draft.productVariantIds.length > 0 && <div className="b-chip-list">{draft.productVariantIds.map((id) => <button key={id} type="button" className="b-chip" onClick={() => update("productVariantIds", draft.productVariantIds.filter((value) => value !== id))}>{id.split("/").pop()} ×</button>)}</div>}
          </fieldset>

          <div className="b-row b-gap-3"><button type="submit" className="b-btn b-btn-primary">Save tier</button><button type="button" className="b-btn b-btn-secondary" onClick={() => setDraft(null)}>Cancel</button></div>
        </Form>
      )}
    </section>
  );
}
