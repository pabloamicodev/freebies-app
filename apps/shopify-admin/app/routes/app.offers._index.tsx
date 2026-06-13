import { useLoaderData, useNavigate, useSearchParams, useFetcher } from "react-router";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import {
  analyticsEvents,
  appSettings,
  bundleDefinitions,
  cartMutationLogs,
  giftCloneProducts,
  offers,
  widgets,
} from "@promo/db";
import { eq, and, like, desc } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  IconCopy, IconTrash, IconArchive, IconEye, IconSearch, IconFilter,
  IconChevronDown, SortIcon,
} from "../components/Icons.js";
import { AccessibleModal } from "../components/AccessibleModal.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { OfferToggle } from "../components/BogosSwitch.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { createRouteTimer } from "../lib/route-timing.server.js";
import type { OfferCreateModalType } from "../components/offers/OfferCreateModalFlow.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

type OfferStatus = "draft" | "active" | "paused" | "scheduled" | "expired" | "archived";

const OfferCreateModalFlow = lazy(() => import("../components/offers/OfferCreateModalFlow.js"));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const timer = createRouteTimer("app.offers._index");
  const { shopId, db } = await timer.time("shop_context", () => getShopContext(request));
  if (!shopId) {
    timer.done({ shopFound: false });
    return { offers: [] };
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") as OfferStatus | "all" | null;
  const search = url.searchParams.get("q") ?? "";

  const conditions = [eq(offers.shopId, shopId)];
  if (statusFilter && statusFilter !== "all") conditions.push(eq(offers.status, statusFilter));
  if (search) conditions.push(like(offers.internalName, `%${search}%`));

  const rows = await timer.time("offers.select_list", () =>
    db
      .select({
        id: offers.id,
        type: offers.type,
        status: offers.status,
        internalName: offers.internalName,
        publicTitle: offers.publicTitle,
        priority: offers.priority,
        startsAt: offers.startsAt,
        updatedAt: offers.updatedAt,
      })
      .from(offers)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(offers.priority, desc(offers.updatedAt))
      .limit(100),
  );

  const serializedOffers = await timer.time("offers.serialize_rows", () =>
    rows.map((row) => ({
      ...row,
      startsAt: row.startsAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  );

  timer.done({
    shopFound: true,
    rowCount: rows.length,
    statusFilter: statusFilter ?? "all",
    hasSearch: search.length > 0,
  });

  return {
    offers: serializedOffers,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, db } = context;
  if (!shopId) throw new Response("Shop not found", { status: 404 });

  const intent = formData.get("intent") as string;
  const offerIds = formData.getAll("offerIds[]") as string[];

  if (request.method.toUpperCase() === "DELETE" || intent === "delete") {
    const offerId = formData.get("offerId") as string | null;
    if (!offerId) throw new Response("Missing offerId", { status: 400 });

    await db.transaction(async (tx) => {
      await Promise.all([
        tx.delete(analyticsEvents).where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId))),
        tx.delete(cartMutationLogs).where(and(eq(cartMutationLogs.shopId, shopId), eq(cartMutationLogs.offerId, offerId))),
        tx.delete(giftCloneProducts).where(and(eq(giftCloneProducts.shopId, shopId), eq(giftCloneProducts.offerId, offerId))),
        tx.delete(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, `widget.market_overrides.${offerId}`))),
        tx.delete(widgets).where(and(eq(widgets.shopId, shopId), eq(widgets.offerId, offerId))),
        tx.delete(bundleDefinitions).where(and(eq(bundleDefinitions.shopId, shopId), eq(bundleDefinitions.offerId, offerId))),
      ]);
      await tx.delete(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
    });

    return null;
  }

  switch (intent) {
    case "bulk_pause":
      await Promise.all(offerIds.map((id) =>
        db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, id))),
      ));
      break;
    case "bulk_activate":
      await Promise.all(offerIds.map((id) =>
        db.update(offers).set({ status: "active", updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, id))),
      ));
      break;
    case "toggle_status": {
      const offerId = formData.get("offerId") as string;
      const currentStatus = formData.get("currentStatus") as string;
      const newStatus = currentStatus === "active" ? "paused" : "active";
      await db.update(offers).set({ status: newStatus, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      break;
    }
    case "archive": {
      const offerId = formData.get("offerId") as string;
      await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      break;
    }
  }

  return null;
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
type OfferRow = {
  id: string;
  type: string;
  status: string;
  internalName: string;
  publicTitle: string;
  priority: number;
  startsAt: string | null;
  updatedAt: string;
};

type ConfirmActionState = {
  type: "archive" | "delete";
  offer: Pick<OfferRow, "id" | "internalName">;
};


const TABS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Disabled", value: "paused" },
  { label: "Scheduled", value: "scheduled" },
  { label: "Expired", value: "expired" },
  { label: "Archived", value: "archived" },
];

const TYPE_LABEL: Record<string, string> = {
  gift: "Gift",
  bundle: "Bundle",
  upsell: "Upsell",
  discount: "Discount",
  booster: "Booster",
};

/* ══════════════════════════════════════════════════════════
   OFFER TYPE ICONS (SVG line-art on blue gradient background)
   ══════════════════════════════════════════════════════════ */
function TypeIcon({ type }: { type: string }) {
  return (
    <div className={`b-offer-icon b-offer-icon-${type}`}>
      {type === "gift" && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/>
          <line x1="12" y1="22" x2="12" y2="7"/>
          <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
          <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
        </svg>
      )}
      {type === "bundle" && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="14" width="20" height="8" rx="2"/>
          <rect x="4" y="9" width="16" height="6" rx="2"/>
          <rect x="6" y="4" width="12" height="6" rx="2"/>
        </svg>
      )}
      {type === "upsell" && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
        </svg>
      )}
      {(type !== "gift" && type !== "bundle" && type !== "upsell") && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
          <line x1="9" y1="14" x2="15" y2="8"/>
        </svg>
      )}
    </div>
  );
}
function OfferCreateModalFallback({ onClose }: { onClose: () => void }) {
  return (
    <AccessibleModal ariaLabel="Create offer" className="b-modal-sm" onClose={onClose}>
        <div className="b-modal-header">
          <h2 className="b-modal-title">Create offer</h2>
          <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div className="b-modal-body">
          <div className="b-route-loader-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
    </AccessibleModal>
  );
}

export default function OffersPage() {
  const { offers: offerRows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bannerVisible, setBannerVisible] = useState(true);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(null);
  const deleteFetcher = useFetcher();
  const archiveFetcher = useFetcher();
  const bulkFetcher = useFetcher();

  // Modal state
  const [modal, setModal] = useState<OfferCreateModalType | null>(null);

  const activeTab = searchParams.get("status") ?? "all";

  const allOfferIds = useMemo(() => offerRows.map((offer) => offer.id), [offerRows]);

  const deletingId = deleteFetcher.state !== "idle"
    ? (deleteFetcher.formData?.get("offerId") as string | null)
    : null;
  const archivingId = archiveFetcher.state !== "idle"
    ? (archiveFetcher.formData?.get("offerId") as string | null)
    : null;

  const visibleOffers = useMemo(
    () => offerRows.filter((offer) => {
      if (deletingId && offer.id === deletingId) return false;
      if (archivingId && offer.id === archivingId && activeTab !== "archived") return false;
      return true;
    }),
    [activeTab, archivingId, deletingId, offerRows],
  );

  const setTab = useCallback((val: string) => {
    if (val === "all") {
      setSearchParams({});
    } else {
      setSearchParams({ status: val });
    }
  }, [setSearchParams]);

  const toggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (checkedIds.size === offerRows.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(allOfferIds));
    }
  }, [allOfferIds, checkedIds.size, offerRows.length]);

  const closeConfirmAction = useCallback(() => {
    setConfirmAction(null);
  }, []);

  const confirmDelete = useCallback((offer: OfferRow) => {
    setConfirmAction({ type: "delete", offer: { id: offer.id, internalName: offer.internalName } });
  }, []);

  const executeDelete = useCallback((offerId: string) => {
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("offerId", offerId);
    void deleteFetcher.submit(fd, { method: "DELETE" });
    closeConfirmAction();
  }, [closeConfirmAction, deleteFetcher]);

  const confirmArchive = useCallback((offer: OfferRow) => {
    setConfirmAction({ type: "archive", offer: { id: offer.id, internalName: offer.internalName } });
  }, []);

  const executeArchive = useCallback((offerId: string) => {
    const fd = new FormData();
    fd.append("intent", "archive");
    fd.append("offerId", offerId);
    void archiveFetcher.submit(fd, { method: "POST" });
    closeConfirmAction();
  }, [archiveFetcher, closeConfirmAction]);

  const bulkAction = useCallback((intent: "bulk_pause" | "bulk_activate") => {
    const fd = new FormData();
    fd.append("intent", intent);
    for (const id of checkedIds) {
      fd.append("offerIds[]", id);
    }
    void bulkFetcher.submit(fd, { method: "POST" });
    setCheckedIds(new Set());
  }, [bulkFetcher, checkedIds]);

  return (
    <div className="b-page">
      {/* ── Modals ──────────────────────────────────────────── */}
      {modal && (
        <Suspense fallback={<OfferCreateModalFallback onClose={() => setModal(null)} />}>
          <OfferCreateModalFlow modal={modal} onClose={() => setModal(null)} onChange={setModal} />
        </Suspense>
      )}
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="b-page-header">
        <h1 className="b-page-title">All Offers</h1>
        <div className="b-page-actions">
          <button type="button" className="b-btn b-btn-secondary">
            More actions <IconChevronDown />
          </button>
          <button type="button" className="b-btn b-btn-primary" onClick={() => setModal("type")}>
            Create offer
          </button>
        </div>
      </div>

      {/* ── Cart integration banner ─────────────────────────── */}
      {bannerVisible && (
        <div className="b-banner">
          <div className="b-banner-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#2c6ecb"/>
              <line x1="12" y1="8" x2="12" y2="12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="b-banner-body">
            <div className="b-banner-title">Cart integration</div>
            <p className="b-banner-text">
              If you&apos;re using a custom cart drawer/XHR, BOGOS may need a larger integration.{" "}
              <button type="button" className="b-btn b-btn-plain" style={{ color: "var(--blue)", textDecoration: "underline" }}>Send us a message</button> for support.
            </p>
          </div>
          <button type="button" className="b-banner-close" onClick={() => setBannerVisible(false)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ── Action confirmation dialog ──────────────────────── */}
      {confirmAction && (
        <AccessibleModal ariaLabel={confirmAction.type === "delete" ? "Delete offer permanently" : "Archive offer"} className="b-modal-sm" onClose={closeConfirmAction}>
            <div className="b-modal-header">
              <h2 className="b-modal-title">
                {confirmAction.type === "delete" ? "Delete offer permanently?" : "Archive offer?"}
              </h2>
              <button type="button" className="b-modal-close" onClick={closeConfirmAction} aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div className="b-modal-body">
              <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0, lineHeight: 1.6 }}>
                {confirmAction.type === "delete" ? (
                  <>
                    This will <strong style={{ color: "var(--text)" }}>permanently delete</strong> the offer and all its data. This action cannot be undone.
                  </>
                ) : (
                  "The offer will be archived and hidden from customers. You can restore it later from the archived view."
                )}
                {" "}Offer: {confirmAction.offer.internalName}.
              </p>
            </div>
            <div className="b-modal-footer">
              <button type="button" className="b-btn b-btn-secondary" onClick={closeConfirmAction}>Cancel</button>
              {confirmAction.type === "delete" ? (
                <button type="button" className="b-btn b-btn-danger" onClick={() => executeDelete(confirmAction.offer.id)}>
                  Delete permanently
                </button>
              ) : (
                <button type="button" className="b-btn b-btn-secondary" onClick={() => executeArchive(confirmAction.offer.id)} style={{ borderColor: "#9ca3af" }}>
                  Archive offer
                </button>
              )}
            </div>
        </AccessibleModal>
      )}

      {/* ── Bulk actions toolbar ─────────────────────────────── */}
      {checkedIds.size > 0 && (
        <div className="rd-style-008">
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginRight: 4 }}>
            {checkedIds.size} selected
          </span>
          <button type="button"
            className="b-btn b-btn-secondary b-btn-sm"
            onClick={() => bulkAction("bulk_activate")}
            disabled={bulkFetcher.state !== "idle"}
          >
            Activate
          </button>
          <button type="button"
            className="b-btn b-btn-secondary b-btn-sm"
            onClick={() => bulkAction("bulk_pause")}
            disabled={bulkFetcher.state !== "idle"}
          >
            Pause
          </button>
          <button type="button"
            className="b-btn b-btn-plain b-btn-sm"
            style={{ marginLeft: "auto", color: "var(--text-sub)", fontSize: 13 }}
            onClick={() => setCheckedIds(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Table card ──────────────────────────────────────── */}
      <div className="b-table-wrap">
        {/* Filter Tabs */}
        <div className="b-tabs">
          <ul className="b-tabs-list">
            {TABS.map((tab) => (
              <li key={tab.value}>
                <button type="button"
                  className={`b-tab${activeTab === tab.value ? " active" : ""}`}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                  onClick={() => setTab(tab.value)}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="b-tabs-actions">
            <button type="button" className="b-btn-icon" aria-label="Search"><IconSearch /></button>
            <button type="button" className="b-btn-icon" aria-label="Filter"><IconFilter /></button>
          </div>
        </div>

        {/* Table */}
        <table className="b-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  aria-label="Select all offers"
                  type="checkbox"
                  style={{ accentColor: "var(--blue)", width: 15, height: 15, cursor: "pointer" }}
                  checked={checkedIds.size === offerRows.length && offerRows.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon active="asc" />
                  <span>Title</span>
                </button>
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>Offer type</span>
                </button>
              </th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>Start date</span>
                </button>
              </th>
              <th><span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-sub)" }}>Status</span></th>
              <th>
                <button className="bogos-sort-btn" type="button">
                  <SortIcon />
                  <span>On / Off</span>
                </button>
              </th>
              <th><span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-sub)" }}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleOffers.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "48px 24px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 40 }}>🎁</div>
                    <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Create your first promotion</p>
                    <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
                      Add free gifts, bundles, upsells and discounts to your store.
                    </p>
                    <button type="button" className="b-btn b-btn-primary" onClick={() => setModal("type")}>Create offer</button>
                  </div>
                </td>
              </tr>
            ) : (
              visibleOffers.map((offer: OfferRow) => (
                <tr key={offer.id}>
                  <td>
                    <input
                      aria-label={`Select offer ${offer.internalName}`}
                      type="checkbox"
                      style={{ accentColor: "var(--blue)", width: 15, height: 15, cursor: "pointer" }}
                      checked={checkedIds.has(offer.id)}
                      onChange={() => toggleCheck(offer.id)}
                    />
                  </td>
                  {/* Offer name with colored type icon */}
                  <td>
                    <div className="b-table-offer-cell">
                      <TypeIcon type={offer.type} />
                      <div style={{ minWidth: 0 }}>
                        <button
                          type="button"
                          className="bogos-offer-title-text"
                          data-primary-link="true"
                          onClick={() => navigate(`/app/offers/${offer.id}`)}
                        >
                          {offer.internalName}
                        </button>
                        {offer.publicTitle && (
                          <div className="b-offer-subtitle">{offer.publicTitle}</div>
                        )}
                      </div>
                      <div className="bogos-row-reveal" title="Preview">
                        <span style={{ color: "var(--text-muted)", display: "flex" }}><IconEye /></span>
                      </div>
                    </div>
                  </td>

                  {/* Offer type chip — colored by type */}
                  <td>
                    <span className={`b-type-chip b-type-chip-${offer.type}`}>
                      {TYPE_LABEL[offer.type] ?? offer.type}
                    </span>
                  </td>

                  {/* Start date in mono */}
                  <td>
                    <span className="b-mono">{formatDate(offer.startsAt ?? offer.updatedAt)}</span>
                  </td>

                  {/* Estado badge */}
                  <td>
                    <StatusBadge status={offer.status} />
                  </td>

                  {/* Encendido apagado toggle */}
                  <td>
                    <div style={{ display: "flex", width: "fit-content" }}>
                      <OfferToggle offerId={offer.id} status={offer.status} />
                    </div>
                  </td>

                  {/* Actions — duplicate + archive + delete */}
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <button
                        type="button"
                        className="bogos-action-btn"
                        onClick={(e) => { e.stopPropagation(); void navigate(`/app/offers/${offer.id}`); }}
                        aria-label="Duplicate offer"
                        title="Duplicate"
                      >
                        <IconCopy />
                      </button>
                      <button
                        type="button"
                        className="bogos-action-btn"
                        onClick={(e) => { e.stopPropagation(); confirmArchive(offer); }}
                        aria-label="Archive offer"
                        title="Archive"
                        style={{ color: "var(--text-sub)" }}
                      >
                        <IconArchive />
                      </button>
                      <button
                        type="button"
                        className="bogos-action-btn red"
                        onClick={(e) => { e.stopPropagation(); confirmDelete(offer); }}
                        aria-label="Delete offer permanently"
                        title="Delete permanently"
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
