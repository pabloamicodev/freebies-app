import { limitsBanner, type LimitsMeter } from "../lib/capacity-meter.js";

const LEVEL_COLOR = { unknown: "var(--border-strong)", ok: "var(--green)", warning: "var(--amber)", critical: "var(--red)" } as const;

export function ShopifyLimitsBanner({ meter }: { meter: LimitsMeter | null | undefined }) {
  const banner = meter ? limitsBanner(meter) : null;
  if (!meter || !banner) return null;
  return (
    <div className={`b-banner ${meter.level === "critical" ? "b-banner-red" : "b-banner-orange"}`} role={meter.level === "critical" ? "alert" : "status"}>
      <div className="b-banner-body">
        <div className="b-banner-title">{banner.title}</div>
        <p className="b-banner-text">{banner.body}</p>
        {meter.discountsUrl && (
          <p className="b-banner-text" style={{ marginTop: 6 }}>
            <a href={meter.discountsUrl} target="_top" rel="noreferrer">
              Review automatic discounts
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

/** Diagnostics card: always shown (informational); the offers list only warns from 80%. */
export function ShopifyLimitsCard({ meter }: { meter: LimitsMeter | null | undefined }) {
  if (!meter) {
    return (
      <div className="b-card" style={{ marginTop: 16 }}>
        <div className="b-card-header">Shopify limits</div>
        <div className="b-card-body">
          <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
            Promo Engine couldn't read your automatic discount count right now. Shopify allows 25 active automatic discounts per store.
          </p>
        </div>
      </div>
    );
  }
  const used = meter.storeActive;
  const pct = used === null ? 0 : Math.min(100, Math.round((used / meter.limit) * 100));
  const ours = meter.ours;
  return (
    <div className="b-card" style={{ marginTop: 16 }}>
      <div className="b-card-header">Shopify limits</div>
      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p id="limits-meter-label" style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {used === null
            ? `Automatic discounts: unknown of ${meter.limit} used.`
            : `Automatic discounts: ${used} of ${meter.limit} used. Promo Engine uses ${ours}${meter.others !== null ? `, other apps and Shopify discounts use ${meter.others}` : ""}.`}
        </p>
        <div
          role="meter"
          aria-labelledby="limits-meter-label"
          aria-valuemin={0}
          aria-valuemax={meter.limit}
          aria-valuenow={used ?? 0}
          aria-valuetext={used === null ? "Unknown" : `${used} of ${meter.limit}`}
          style={{ height: 8, borderRadius: 4, background: "var(--border-light)", overflow: "hidden" }}
        >
          <div style={{ width: `${pct}%`, height: "100%", background: LEVEL_COLOR[meter.level] }} />
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-sub)" }}>
          Promo Engine capacity: {meter.slotsInUse} of {meter.shardsEnabled ? meter.maxCartSlots : 1} Shopify discount{(meter.shardsEnabled ? meter.maxCartSlots : 1) === 1 ? "" : "s"} in use for offers.
        </p>
      </div>
    </div>
  );
}
