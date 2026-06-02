/** @jsxImportSource preact */
import { useState, useEffect } from "preact/hooks";
import { h } from "preact";
import { render } from "preact";
import { on, PromoEvents, emit, publishAnalytics } from "../event-bus.js";
import type { EvaluationResult } from "../types.js";

interface TodayOfferItem {
  offerId: string;
  title: string;
  description: string;
  imageUrl: string | null;
  buttonText: string;
  redirectUrl: string | null;
  badgeText: string | null;
}

interface TodayOfferConfig {
  position: "bottom_right" | "bottom_left";
  style: "icon_only" | "icon_title";
  primaryColor: string;
  iconSizeRem: number;
}

const DEFAULT_CONFIG: TodayOfferConfig = {
  position: "bottom_right",
  style: "icon_title",
  primaryColor: "#111",
  iconSizeRem: 3.5,
};

const WIDGET_STYLES = `
.pe-today-wrap {
  position: fixed; bottom: 24px; z-index: 9998;
  display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
}
.pe-today-wrap.pe-left { left: 24px; align-items: flex-start; }
.pe-today-wrap.pe-right { right: 24px; }
.pe-today-trigger {
  display: flex; align-items: center; gap: 8px;
  background: var(--pe-primary, #111); color: #fff;
  border: none; border-radius: 999px; padding: 10px 16px 10px 12px;
  cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  font-size: 14px; font-weight: 600; font-family: inherit;
  transition: transform .15s, box-shadow .15s; position: relative;
}
.pe-today-trigger:hover { transform: scale(1.04); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
.pe-today-icon { font-size: 20px; }
.pe-today-dot {
  position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
  background: #ef4444; border-radius: 50%; border: 2px solid #fff;
  animation: pe-pulse 2s infinite;
}
@keyframes pe-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: .8; }
}
.pe-today-panel {
  background: #fff; border-radius: 12px; width: 280px;
  box-shadow: 0 8px 32px rgba(0,0,0,.2); overflow: hidden;
  animation: pe-slide-up .2s ease;
}
@keyframes pe-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.pe-today-panel-header {
  padding: 12px 16px; background: var(--pe-primary, #111); color: #fff;
  display: flex; justify-content: space-between; align-items: center;
}
.pe-today-panel-title { font-size: 14px; font-weight: 700; margin: 0; }
.pe-today-close { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; padding: 0; }
.pe-today-offers { padding: 8px 0; max-height: 320px; overflow-y: auto; }
.pe-today-offer-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  cursor: pointer; transition: background .12s; text-decoration: none; color: inherit;
}
.pe-today-offer-item:hover { background: #f9f9f9; }
.pe-today-offer-img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-today-offer-info { flex: 1; min-width: 0; }
.pe-today-offer-title { font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pe-today-offer-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; }
.pe-today-offer-btn { font-size: 11px; color: var(--pe-primary, #111); font-weight: 700; flex-shrink: 0; }
`;

function TodayOfferWidget({
  items,
  config,
  sessionId,
}: {
  items: TodayOfferItem[];
  config: TodayOfferConfig;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible || items.length === 0) return null;

  const posClass = config.position === "bottom_left" ? "pe-left" : "pe-right";

  function handleItemClick(item: TodayOfferItem) {
    publishAnalytics("promo_engine:widget_clicked", {
      offer_id: item.offerId,
      widget_type: "today_offer",
      session_id: sessionId,
    });
    if (item.redirectUrl) window.location.href = item.redirectUrl;
    else setOpen(false);
  }

  return (
    <div
      class={`pe-today-wrap ${posClass}`}
      style={{ "--pe-primary": config.primaryColor } as any}
    >
      {open && (
        <div class="pe-today-panel" role="dialog" aria-label="Today's offers">
          <div class="pe-today-panel-header">
            <h3 class="pe-today-panel-title">Today's Offers</h3>
            <button class="pe-today-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>
          <div class="pe-today-offers">
            {items.map((item) => (
              <div
                key={item.offerId}
                class="pe-today-offer-item"
                onClick={() => handleItemClick(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") handleItemClick(item); }}
              >
                {item.imageUrl ? (
                  <img class="pe-today-offer-img" src={item.imageUrl} alt={item.title} loading="lazy" />
                ) : (
                  <div class="pe-today-offer-img" aria-hidden="true">🎁</div>
                )}
                <div class="pe-today-offer-info">
                  <p class="pe-today-offer-title">{item.title}</p>
                  {item.description && <p class="pe-today-offer-desc">{item.description}</p>}
                </div>
                <span class="pe-today-offer-btn">{item.buttonText || "View →"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        class="pe-today-trigger"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) {
            publishAnalytics("promo_engine:widget_viewed", {
              widget_type: "today_offer",
              offer_count: items.length,
              session_id: sessionId,
            });
          }
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${items.length} offer${items.length !== 1 ? "s" : ""} available`}
      >
        <span class="pe-today-icon" aria-hidden="true">🎁</span>
        {config.style === "icon_title" && <span>Today's Deals</span>}
        <span class="pe-today-dot" aria-hidden="true" />
      </button>
    </div>
  );
}

let container: HTMLDivElement | null = null;

export function initTodayOfferWidget(config: Partial<TodayOfferConfig>, sessionId: string) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Inject styles
  if (!document.getElementById("pe-today-styles")) {
    const style = document.createElement("style");
    style.id = "pe-today-styles";
    style.textContent = WIDGET_STYLES;
    document.head.appendChild(style);
  }

  if (!container) {
    container = document.createElement("div");
    container.id = "pe-today-offer-root";
    document.body.appendChild(container);
  }

  on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
    const todayOffers = result.qualifiedOffers.map((o) => ({
      offerId: o.offerId,
      title: o.type + " offer",
      description: "",
      imageUrl: null,
      buttonText: "View",
      redirectUrl: null,
      badgeText: null,
    }));

    render(
      h(TodayOfferWidget, { items: todayOffers, config: mergedConfig, sessionId }),
      container!,
    );
  });
}
