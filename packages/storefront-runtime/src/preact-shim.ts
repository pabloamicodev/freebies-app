// Aliased in for "preact", "preact/hooks", "preact/jsx-runtime" and the cart/format/i18n/event-bus modules when building
// promo-engine-blocks.js, so the lazy chunk shares the main bundle's copies (hooks must run on the same preact instance).
// The main bundle publishes them in preact-share.ts.
import type { PreactShare } from "./preact-share.js";

const p = (window as unknown as { __pePreact: PreactShare }).__pePreact;

export const { h, render, Fragment, useState, useEffect, useMemo, useRef, jsx, jsxs, AjaxCartAdapter, formatMoney, t, emit, PromoEvents, publishAnalytics } = p;
