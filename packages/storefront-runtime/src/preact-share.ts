import { h, render, Fragment } from "preact";
import { useState, useEffect, useMemo, useRef } from "preact/hooks";
import { jsx, jsxs } from "preact/jsx-runtime";
import { AjaxCartAdapter } from "./cart-adapter.js";
import { formatMoney } from "./format.js";
import { t } from "./i18n.js";
import { emit, on, PromoEvents, publishAnalytics } from "./event-bus.js";
import { canPromise } from "./eligibility-context.js";

export const preactShare = { h, render, Fragment, useState, useEffect, useMemo, useRef, jsx, jsxs, AjaxCartAdapter, formatMoney, t, emit, on, PromoEvents, publishAnalytics, canPromise };
export type PreactShare = typeof preactShare;

declare global {
  interface Window {
    __pePreact?: PreactShare;
  }
}

/** Publishes the bundled preact and the helpers the lazy blocks chunk reuses instead of bundling its own copy. */
export function sharePreact(): void {
  window.__pePreact = preactShare;
}
