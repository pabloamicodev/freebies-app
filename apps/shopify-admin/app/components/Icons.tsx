/**
 * Shared SVG icon components used across the admin app.
 * Import from here instead of defining locally in routes.
 *
 * Usage:
 *   import { IconChevronLeft, IconTrash, GiftIcon } from "../components/Icons.js";
 */

/* ── Navigation ─────────────────────────────────────────── */

export function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M11.78 5.47a.75.75 0 0 1 0 1.06L8.31 10l3.47 3.47a.75.75 0 1 1-1.06 1.06l-4-4a.75.75 0 0 1 0-1.06l4-4a.75.75 0 0 1 1.06 0Z"/>
    </svg>
  );
}

export function IconChevronRight() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M8.22 5.47a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 1 1-1.06-1.06L11.69 10 8.22 6.53a.75.75 0 0 1 0-1.06Z"/>
    </svg>
  );
}

export function IconChevronDown() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M5.72 8.47a.75.75 0 0 1 1.06 0l3.47 3.47 3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06Z"/>
    </svg>
  );
}

export function IconChevronUp() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M14.28 11.53a.75.75 0 0 1-1.06 0L10 8.06l-3.22 3.47a.75.75 0 1 1-1.06-1.06l4-4a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1 0 1.06Z"/>
    </svg>
  );
}

export function IconX() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M10 8.586 6.707 5.293a1 1 0 0 0-1.414 1.414L8.586 10l-3.293 3.293a1 1 0 1 0 1.414 1.414L10 11.414l3.293 3.293a1 1 0 0 0 1.414-1.414L11.414 10l3.293-3.293a1 1 0 0 0-1.414-1.414L10 8.586Z"/>
    </svg>
  );
}

/* ── Actions ─────────────────────────────────────────────── */

export function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

/** Duplicate/copy icon — exact Polaris SVG used by BOGOS */
export function IconCopy() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M11.25 8.5c-.414 0-.75.336-.75.75v1.25h-1.25c-.414 0-.75.336-.75.75s.336.75.75.75h1.25v1.25c0 .414.336.75.75.75s.75-.336.75-.75v-1.25h1.25c.414 0 .75-.336.75-.75s-.336-.75-.75-.75h-1.25v-1.25c0-.414-.336-.75-.75-.75Z"/>
      <path fillRule="evenodd" d="M8.75 16.5c-1.438 0-2.618-1.104-2.74-2.51-1.406-.122-2.51-1.302-2.51-2.74v-5c0-1.519 1.231-2.75 2.75-2.75h5c1.438 0 2.618 1.104 2.74 2.51 1.406.122 2.51 1.302 2.51 2.74v5c0 1.519-1.231 2.75-2.75 2.75h-5Zm0-10.5c-1.519 0-2.75 1.231-2.75 2.75v3.725c-.57-.116-1-.62-1-1.225v-5c0-.69.56-1.25 1.25-1.25h5c.605 0 1.11.43 1.225 1h-3.725Zm0 1.5c-.69 0-1.25.56-1.25 1.25v5c0 .69.56 1.25 1.25 1.25h5c.69 0 1.25-.56 1.25-1.25v-5c0-.69-.56-1.25-1.25-1.25h-5Z"/>
    </svg>
  );
}

/** Trash icon — exact Polaris SVG used by BOGOS (red tone in actions column) */
export function IconTrash() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M11.5 8.25a.75.75 0 0 1 .75.75v4.25a.75.75 0 0 1-1.5 0v-4.25a.75.75 0 0 1 .75-.75Z"/>
      <path d="M9.25 9a.75.75 0 0 0-1.5 0v4.25a.75.75 0 0 0 1.5 0v-4.25Z"/>
      <path fillRule="evenodd" d="M7.25 5.25a2.75 2.75 0 0 1 5.5 0h3a.75.75 0 0 1 0 1.5h-.75v5.45c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311c-.642.327-1.482.327-3.162.327h-.4c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311c-.327-.642-.327-1.482-.327-3.162v-5.45h-.75a.75.75 0 0 1 0-1.5h3Zm1.5 0a1.25 1.25 0 1 1 2.5 0h-2.5Zm-2.25 1.5h7v5.45c0 .865-.001 1.423-.036 1.848-.033.408-.09.559-.128.633a1.5 1.5 0 0 1-.655.655c-.074.038-.225.095-.633.128-.425.035-.983.036-1.848.036h-.4c-.865 0-1.423-.001-1.848-.036-.408-.033-.559-.09-.633-.128a1.5 1.5 0 0 1-.656-.655c-.037-.074-.094-.225-.127-.633-.035-.425-.036-.983-.036-1.848v-5.45Z"/>
    </svg>
  );
}

/* ── Status / Feedback ──────────────────────────────────── */

export function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

/** Larger check for pricing/feature lists */
export function IconCheckLg({ color = "currentColor" }: { color?: string }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <polyline points="17 5 8 16 3 11"/>
    </svg>
  );
}

export function IconInfo() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

/* ── UI ─────────────────────────────────────────────────── */

export function IconSearch() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M12.323 13.383a5.5 5.5 0 1 1 1.06-1.06l2.897 2.897a.75.75 0 1 1-1.06 1.06l-2.897-2.897Zm.677-4.383a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/>
    </svg>
  );
}

export function IconFilter() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M3 6a.75.75 0 0 1 .75-.75h12.5a.75.75 0 0 1 0 1.5h-12.5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M6.75 14a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75Z"/>
      <path d="M5.5 9.25a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5h-9Z"/>
    </svg>
  );
}

export function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

export function IconEye() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" d="M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-1.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/>
      <path fillRule="evenodd" d="M10 4c-2.476 0-4.348 1.23-5.577 2.532a9.266 9.266 0 0 0-1.4 1.922 5.98 5.98 0 0 0-.37.818c-.082.227-.153.488-.153.728s.071.501.152.728c.088.246.213.524.371.818.317.587.784 1.27 1.4 1.922 1.229 1.302 3.1 2.532 5.577 2.532 2.476 0 4.348-1.23 5.577-2.532a9.265 9.265 0 0 0 1.4-1.922 5.98 5.98 0 0 0 .37-.818c.082-.227.153-.488.153-.728s-.071-.501-.152-.728a5.984 5.984 0 0 0-.371-.818 9.269 9.269 0 0 0-1.4-1.922c-1.229-1.302-3.1-2.532-5.577-2.532Zm-5.999 6.002v-.004c.004-.02.017-.09.064-.223a4.5 4.5 0 0 1 .278-.608 7.768 7.768 0 0 1 1.17-1.605c1.042-1.104 2.545-2.062 4.487-2.062 1.942 0 3.445.958 4.486 2.062a7.77 7.77 0 0 1 1.17 1.605c.13.24.221.447.279.608.047.132.06.203.064.223v.004c-.004.02-.017.09-.064.223a4.503 4.503 0 0 1-.278.608 7.768 7.768 0 0 1-1.17 1.605c-1.042 1.104-2.545 2.062-4.487 2.062-1.942 0-3.445-.958-4.486-2.062a7.766 7.766 0 0 1-1.17-1.605 4.5 4.5 0 0 1-.279-.608c-.047-.132-.06-.203-.064-.223Z"/>
    </svg>
  );
}

/** Sort arrows for table headers — active prop highlights the active direction */
export function SortIcon({ active }: { active?: "asc" | "desc" }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" fillOpacity={active === "asc" ? 1 : 0.33} d="M9.116 4.823a1.25 1.25 0 0 1 1.768 0l2.646 2.647a.75.75 0 0 1-1.06 1.06l-2.47-2.47-2.47 2.47a.75.75 0 1 1-1.06-1.06l2.646-2.647Z"/>
      <path fillRule="evenodd" fillOpacity={active === "desc" ? 1 : 0.33} d="M9.116 15.177a1.25 1.25 0 0 0 1.768 0l2.646-2.647a.75.75 0 0 0-1.06-1.06l-2.47 2.47-2.47-2.47a.75.75 0 0 0-1.06 1.06l2.646 2.647Z"/>
    </svg>
  );
}

/* ── Offer-specific ─────────────────────────────────────── */

/** Gift box SVG — exact data URI paths used by BOGOS in the type column */
export function GiftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M5.5 10.5V14.5L14.5 14.5V10.5H16.5V14.5C16.5 15.6046 15.6046 16.5 14.5 16.5H5.5C4.39543 16.5 3.5 15.6046 3.5 14.5V10.5H5.5Z" fill="#4A4A4A"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M2.5 6C2.5 5.44772 2.94772 5 3.5 5H16.5C17.0523 5 17.5 5.44772 17.5 6V8C17.5 8.55228 17.0523 9 16.5 9H3.5C2.94772 9 2.5 8.55228 2.5 8V6Z" fill="#4A4A4A"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M7.25707 2.08594L9.93798 4.76681L12.6189 2.08594L14.0331 3.50015L11.3522 6.18102C10.5712 6.96206 9.30483 6.96207 8.52378 6.18103L5.84287 3.50016L7.25707 2.08594Z" fill="#4A4A4A"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M11 6.56641L11 15.7881L9 15.7881L9 6.56641L11 6.56641Z" fill="#4A4A4A"/>
    </svg>
  );
}

/* ── Analytics ──────────────────────────────────────────── */

export function IconDollar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23"/>
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  );
}

export function IconClipboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
    </svg>
  );
}

export function IconBox() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  );
}

/* ── Dashboard / Bot ─────────────────────────────────────── */

export function IconBot() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2c6ecb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="6" r="3"/>
      <line x1="12" y1="9" x2="12" y2="11"/>
      <line x1="8" y1="15" x2="8" y2="17"/>
      <line x1="16" y1="15" x2="16" y2="17"/>
    </svg>
  );
}

/* ── Link / Time (sidebar detail icons) ─────────────────── */

export function IconLink() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );
}

export function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

export function IconCondition() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

export function IconDatabase() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

export function IconQueue() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/>
      <line x1="3" y1="12" x2="3.01" y2="12"/>
      <line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  );
}

export function IconWarning() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

export function IconShopify() {
  return (
    <svg viewBox="0 0 109.5 124.5" width="16" height="16" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M74.7 14.8s-.3 0-.8.1c-.4-1.2-1-2.3-1.9-3.2-2.8-3.1-6.8-4.6-11.1-4.6-.3 0-.6 0-.9.1-.1-.2-.3-.4-.4-.6C58.3 4.4 55.9 3.5 53 3.6c-5.6.1-11.2 4.2-15.7 11.4-3.2 5.1-5.6 11.5-6.3 16.5L18.9 35c-3.5 1.1-3.6 1.2-4 4.5L6 116.7l68.3 11.8 36.9-9.5L74.7 14.8zM60.4 19.1c-3.8 1.2-8 1.3-8 1.3-.1 0-2.1-5.1-5.8-8.8 1.7-.4 3.5-.6 5.3-.6 1.8 0 3.6.4 5.2 1.1 1.5.7 3 2.3 3.3 7zm-10.7-11.7c.8 0 1.5.1 2.2.3-5.2 2.4-10.6 8.6-12.9 21l-7.5 2.3c2.1-10 9.3-23.6 18.2-23.6z"/>
    </svg>
  );
}

export function IconFunction() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <path d="M6 4a2 2 0 0 1 2-2 8 8 0 0 1 8 8 2 2 0 0 0 2 2 2 2 0 0 1 0 4 2 2 0 0 0-2 2 8 8 0 0 1-8 8 2 2 0 0 1-2-2"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
    </svg>
  );
}

/** Settings/gear icon — used in summary sidebar */
export function IconSettings() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}
