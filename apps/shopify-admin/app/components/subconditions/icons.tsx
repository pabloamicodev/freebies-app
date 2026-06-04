import type { SubconditionId } from "./types.js";

export function ILink() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );
}

export function IHistory() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
    </svg>
  );
}

export function IPerson() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

export function ILocation() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

export function ISub() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    </svg>
  );
}

export function IChannel() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <path d="M8 21h8M12 17v4"/>
    </svg>
  );
}

export function IGlobe() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}

export function IQty() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5c6ac4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/>
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
    </svg>
  );
}

export function ICrown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="1">
      <path d="M2 20h20M5 20V10l7-7 7 7v10"/>
    </svg>
  );
}

export const SUB_ICONS: Record<SubconditionId, () => JSX.Element> = {
  link:           ILink,
  order_history:  IHistory,
  customer_tags:  IPerson,
  location:       ILocation,
  subscription:   ISub,
  sales_channel:  IChannel,
  markets:        IGlobe,
  quantity_limit: IQty,
};
