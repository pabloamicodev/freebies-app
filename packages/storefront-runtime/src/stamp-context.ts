import {
  capStampEntries,
  PROMO_EXPERIMENT_KEY,
  PROMO_SECTIONS_KEY,
  PROMO_TEMPLATE_KEY,
  STAMP_CAPS,
} from "@promo/shared-types/page-stamps";

/**
 * Template / section / experiment stamps for new cart lines. Only refs listed in the app's
 * `stampTargets` are ever read or stored, so shops and offers that do not use these conditions
 * see nothing new. Like the landing URL, remembered refs are FUNCTIONAL storage; the experiment
 * arm derives from analytics data and is purged when analytics consent is withdrawn.
 *
 * Memory (`promo_engine_seen`) is one flat map `{ "<kind>:<ref>": expiresMs }` with kind s (section),
 * t (template) or e (experiment, ref = `<id>:<variantKey>`).
 */
type Kind = "s" | "t" | "e";
interface Arm {
  variantKey?: string;
  mode?: string;
}
interface StampConfig {
  template?: string;
  stampTargets?: Partial<Record<Kind, string[]>> | null;
}

const SEEN_KEY = "promo_engine_seen";
const TTL_MS = 24 * 60 * 60 * 1000;
const KINDS: Kind[] = ["s", "t", "e"];
const LINE_KEYS = { s: PROMO_SECTIONS_KEY, t: PROMO_TEMPLATE_KEY, e: PROMO_EXPERIMENT_KEY } as const;
const SEEN_CAP = 30;
const SECTION_ID = /^shopify-section-template--\d+__(.+)$/;
const INERT_CHILD = /^(TEMPLATE|SCRIPT|STYLE|LINK|NOSCRIPT|META)$/;
const EXPERIMENT_REF = /^[a-z0-9]{8,40}:[A-Za-z0-9_-]{1,64}$/;

let eventDenied = false;
let listening = false;

function readSeen(now: number): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(stored).filter(([, expires]) => expires > now));
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, SEEN_CAP))));
  } catch {
    // Storage full or disabled: only inheritance is lost.
  }
}

/** Displayed: the element and its ancestors render, ignoring opacity. */
function isDisplayed(el: Element): boolean {
  if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** Shown = wrapper displayed and at least one real child renders (an inert Margin Labs arm leaves only template/script). */
function isSectionShown(wrapper: Element): boolean {
  return isDisplayed(wrapper) && Array.from(wrapper.children).some((c) => !INERT_CHILD.test(c.tagName) && isDisplayed(c));
}

function consentDenied(): boolean {
  try {
    const shopify = (window as unknown as { Shopify?: { customerPrivacy?: { analyticsProcessingAllowed?: () => boolean } } }).Shopify;
    const privacy = (shopify && shopify.customerPrivacy) || {};
    if (privacy.analyticsProcessingAllowed) return privacy.analyticsProcessingAllowed() === false;
  } catch {
    // Privacy API threw: fall back to the last consent event.
  }
  return eventDenied;
}

/**
 * The stamp for a NEW line: refs seen on this page (`@`) first, then refs remembered earlier in the
 * visit. Null means "stamp nothing" (no targets, or nothing seen). Every call also refreshes the memory.
 */
export function browserStampContext(): Record<string, string> | null {
  if (typeof document === "undefined") return null;
  const config: StampConfig = window.__promoEngineConfig || {};
  const listed = config.stampTargets || {};
  const targets = (kind: Kind): string[] => listed[kind] || [];
  if (!KINDS.some((kind) => targets(kind).length > 0)) return null;
  const now = Date.now();
  const seen = readSeen(now);
  const current: string[] = [];
  const template = config.template;
  if (template && targets("t").includes(template)) current.push(`t:${template}`);
  if (template && targets("s").length > 0) {
    document.querySelectorAll('[id^="shopify-section-template--"]').forEach((el) => {
      const key = SECTION_ID.exec(el.id);
      const ref = `s:${template}/${key && key[1]}`;
      if (key && targets("s").includes(ref.slice(2)) && !current.includes(ref) && isSectionShown(el)) current.push(ref);
    });
  }

  const denied = consentDenied();
  const ml = (window as unknown as { __ml?: { experiments?: Record<string, Arm> } }).__ml;
  const arms: Record<string, Arm> = (ml && ml.experiments) || {};
  const forget = (prefix: string) => Object.keys(seen).forEach((key) => key.startsWith(prefix) && delete seen[key]);
  if (denied) forget("e:");
  for (const id of Object.keys(arms)) {
    // Whatever the engine reports now replaces what was remembered for this experiment (one arm each; "original" purges it).
    forget(`e:${id}:`);
    const { mode, variantKey } = arms[id] || {};
    if (!denied && (mode === "inline" || mode === "redirect") && targets("e").includes(id) && EXPERIMENT_REF.test(`${id}:${variantKey}`)) {
      current.push(`e:${id}:${variantKey}`);
    }
  }
  current.forEach((key) => (seen[key] = now + TTL_MS));
  writeSeen(seen);

  const stamp: Record<string, string> = {};
  for (const kind of KINDS) {
    const refs = (keys: string[]) => keys.filter((key) => key[0] === kind).map((key) => key.slice(2));
    // `seen` keeps the order it was stored in (latest sighting first).
    const remembered = refs(Object.keys(seen).filter((key) => !current.includes(key))).filter((ref) => targets(kind).includes(kind === "e" ? ref.split(":")[0]! : ref));
    const value = capStampEntries([...refs(current).map((ref) => `@${ref}`), ...remembered], STAMP_CAPS[LINE_KEYS[kind]]);
    if (value) stamp[LINE_KEYS[kind]] = value;
  }
  return Object.keys(stamp).length > 0 ? stamp : null;
}

function snapshot(): void {
  try {
    browserStampContext();
  } catch {
    // Never let memory upkeep break the page.
  }
}

/** Assignment and consent listeners plus the load / pagehide snapshots. Idempotent. */
export function installStampListeners(): void {
  if (listening || typeof document === "undefined" || !window.addEventListener) return;
  listening = true;
  // The engine writes window.__ml.experiments before it fires the event, so the event only has to trigger a snapshot.
  document.addEventListener("ml:experiment:assigned", snapshot);
  document.addEventListener("visitorConsentCollected", (event) => {
    eventDenied = (event as CustomEvent<{ analyticsAllowed?: boolean }>).detail.analyticsAllowed === false;
    snapshot();
  });
  window.addEventListener("pagehide", snapshot);
  const afterLoad = () => setTimeout(snapshot, 1_500);
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad);
}
