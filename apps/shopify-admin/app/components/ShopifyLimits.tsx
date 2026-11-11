import { useId, useState } from "react";
import { Link } from "react-router";
import {
  combinationDomainsConfirm,
  combinationDomainsOffNote,
  combinationForcedReasonLabel,
  combinationGroupsMessage,
} from "../lib/capacity-copy.js";
import { limitsBanner, type CombinationGroupsView, type LimitsMeter } from "../lib/capacity-meter.js";
import { AccessibleModal } from "./AccessibleModal.js";

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

interface CombinationGroupsRowProps {
  groups: CombinationGroupsView;
  domainsEnabled: boolean;
  /** Turns the combination-groups setting on or off; absent renders the row read-only. */
  onSetDomains?: (enabled: boolean) => void;
  busy?: boolean;
  /** Opens the W3 confirmation on first render (the limit modal links here). */
  initialConfirmOpen?: boolean;
}

/** W2 row: what the planner did with offers that don't combine, plus the W3 confirmation to allow it. */
export function CombinationGroupsRow({ groups, domainsEnabled, onSetDomains, busy, initialConfirmOpen = false }: CombinationGroupsRowProps) {
  const [confirming, setConfirming] = useState(initialConfirmOpen);
  const uid = useId();
  const split = domainsEnabled && groups.nodes > 1;
  return (
    <section id="combination-groups" aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`} style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
        Combination groups
      </h3>
      {split ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-sub)" }}>
          {combinationGroupsMessage(groups.nonCombining.length, groups.nonCombiningNodes, groups.combining)}
        </p>
      ) : domainsEnabled ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-sub)" }}>
          {groups.nonCombining.length} offer{groups.nonCombining.length === 1 ? "" : "s"} don&apos;t combine with other discounts. All offers still fit in one Shopify discount; if they stop fitting,
          offers that don&apos;t combine will run in their own.
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-sub)" }}>{combinationDomainsOffNote}</p>
      )}
      {split && groups.forced.length > 0 && (
        <>
          <p style={{ margin: "8px 0 4px", fontSize: 13, color: "var(--text-sub)" }}>
            These offers combine, but must run in a Shopify discount that doesn&apos;t:
          </p>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--text-sub)" }}>
            {groups.forced.map((offer) => (
              <li key={offer.id}>
                <Link to={`/app/offers/${offer.id}`}>{offer.name}</Link> {combinationForcedReasonLabel[offer.reason]}
              </li>
            ))}
          </ul>
        </>
      )}
      {onSetDomains && !domainsEnabled && (
        <button type="button" className="b-btn b-btn-secondary" style={{ marginTop: 8 }} onClick={() => setConfirming(true)} disabled={busy}>
          Let them run separately…
        </button>
      )}
      {onSetDomains && domainsEnabled && !split && (
        <button type="button" className="b-btn b-btn-secondary" style={{ marginTop: 8 }} onClick={() => onSetDomains(false)} disabled={busy}>
          Keep one discount
        </button>
      )}
      {confirming && (
        <AccessibleModal ariaLabel={combinationDomainsConfirm.title} className="b-modal-sm" onClose={() => setConfirming(false)}>
          <div className="b-modal-header">
            <h2 className="b-modal-title">{combinationDomainsConfirm.title}</h2>
          </div>
          <div className="b-modal-body">
            <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>{combinationDomainsConfirm.body}</p>
          </div>
          <div className="b-modal-footer">
            <button type="button" className="b-btn b-btn-secondary" onClick={() => setConfirming(false)}>
              {combinationDomainsConfirm.keep}
            </button>
            <button
              type="button"
              className="b-btn b-btn-primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onSetDomains?.(true);
              }}
            >
              {combinationDomainsConfirm.allow}
            </button>
          </div>
        </AccessibleModal>
      )}
    </section>
  );
}

interface ShopifyLimitsCardProps {
  meter: LimitsMeter | null | undefined;
  onSetDomains?: (enabled: boolean) => void;
  domainsBusy?: boolean;
  initialConfirmOpen?: boolean;
}

/** Diagnostics card: always shown (informational); the offers list only warns from 80%. */
export function ShopifyLimitsCard({ meter, onSetDomains, domainsBusy, initialConfirmOpen }: ShopifyLimitsCardProps) {
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
        {meter.shardsEnabled && meter.combinationGroups && (
          <CombinationGroupsRow
            groups={meter.combinationGroups}
            domainsEnabled={meter.domainsEnabled ?? true}
            onSetDomains={onSetDomains}
            busy={domainsBusy}
            initialConfirmOpen={initialConfirmOpen}
          />
        )}
      </div>
    </div>
  );
}
