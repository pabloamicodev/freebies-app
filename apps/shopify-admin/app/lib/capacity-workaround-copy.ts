
/** English copy for capacity incidents and guided workarounds. Client-safe: no server imports. */

export const confirmSemanticChangeLabel = "I understand what changes for customers";
export const noChangeForCustomers = "Nothing changes for customers.";

const list = (names: readonly string[], max = 5) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const workaroundCopy = {
  useWholeProducts: {
    title: "Select whole products instead of variants",
    summary: "Targets the products as a whole instead of listing each variant. The configuration gets much smaller.",
    customerChange: "Nothing changes today. Variants you add to these products later will also be included.",
  },
  requireAny: {
    title: "Qualify with any one of the required items",
    summary: (n: number) => `Changes the condition from "all ${n} items in the cart" to "any one of them".`,
    customerChange: (n: number) => `Customers qualify by buying any one of these ${n} items instead of all of them.`,
  },
  requireAnyManual: (n: number) =>
    `Shopify can't check that a cart contains all of ${n} items. Reduce the list to 100 or change the condition.`,
  reduceGiftOptions: {
    title: "Offer fewer gifts",
    summary: (keep: number, total: number) => `Keeps ${keep} of the ${total} gift options, the most available ones first.`,
    customerChange: (keep: number, total: number, removed: readonly string[]) =>
      `Customers choose from ${keep} gifts instead of ${total}. Removed: ${list(removed)}.`,
    note: "Undo puts the full list back; the offer then comes back paused because it doesn't fit.",
  },
  splitOffer: {
    title: "Split the offer into smaller parts",
    summary: (parts: number) => `Creates ${parts} offers that each cover a slice of the products, switches them on and pauses the original.`,
    customerChange:
      "Quantities count separately in each part: buying 2 items from part 1 and 1 from part 2 no longer reaches the 3-item tier.",
    note: "Storefront widgets and the offer's history stay on the paused original.",
  },
  syncProducts: {
    title: "Sync your products",
    summary: "Refreshes the product catalog from Shopify, then publishes again.",
    customerChange: noChangeForCustomers,
    note: "This can't be undone, and doesn't need to be.",
  },
  pauseOffers: {
    title: "Pause some offers",
    summary: "Pauses the offers you keep selected, the lowest priority first, so the rest fit.",
    customerChange: (names: readonly string[]) => `These offers stop running: ${list(names)}.`,
    optionsLabel: "Offers to pause",
    note: "Undo switches them back on.",
  },
  deactivateDiscounts: {
    title: "Deactivate other Shopify discounts",
    summary: "Deactivates the automatic Shopify discounts you select, freeing room for these offers.",
    customerChange: (titles: readonly string[]) => `These Shopify discounts stop applying in your store: ${list(titles)}.`,
    customerChangeUnselected: "The Shopify discounts you select stop applying in your store.",
    optionsLabel: "Automatic discounts to deactivate",
    note: "Includes discounts from other apps. Nothing is selected for you. Undo reactivates them.",
  },
  allowCombine: {
    title: "Let these offers combine with product discounts",
    summary: "Allows the blocking offers to combine with other product discounts.",
    customerChange:
      "These offers will stack with other product discounts, including other Promo Engine offers and discount codes.",
  },
  contactSupport: "Contact support: we can turn on a setting for your store that spreads offers over more Shopify discounts. It is not something you can change yourself.",
  stillDoesntFit: (message: string) => `Still doesn't fit: ${message}`,
  stale: "The offer changed; review the proposal again.",
  busy: "Another fix is already running for this incident.",
  notFound: "This incident is no longer open.",
  tryAgainInAMinute: "Try again in a minute.",
  undoRestoresPaused: "The original offer comes back paused because it still doesn't fit.",
  undoChangedSince: "Changed since; undo by hand.",
  undoExpired: "The 24 hour undo window has passed.",
  appliedMessage: (title: string) => `${title}: done.`,
  appliedPendingMessage: (title: string) => `${title}: done. Another update is publishing right now, so it will go live shortly.`,
  revertPending: "Something failed while applying the fix. We are reverting it and will retry automatically; check your offers in a few minutes.",
  undoneMessage: "Undone.",
  activatedMessage: (names: readonly string[]) => `${plural(names.length, "offer")} switched on: ${list(names)}.`,
  keptOffMessage: (items: ReadonlyArray<{ name: string; status: string }>) =>
    `${items.map((item) => `${item.name} stays ${item.status}`).join("; ")} because it was changed after the block.`,
  timedOut: "The fix timed out and was reverted.",
  killSwitch: "Automatic fixes are switched off for now. Follow the steps below.",
} as const;

export const incidentDialogCopy = {
  title: "Offers blocked by a Shopify limit",
  intro: "Shopify limits how much one store can run. These offers could not go live. Pick a fix, or handle it your own way.",
  apply: "Apply",
  applying: "Applying…",
  notNow: "Not now",
  dismiss: "Dismiss",
  undo: "Undo",
  undoing: "Undoing…",
  close: "Close",
  empty: "No blocked offers. Everything fits.",
  loading: "Loading blocked offers…",
  loadFailed: "Couldn't load the blocked offers. Try again in a minute.",
  whatChanges: "What changes for customers",
  selectAtLeast: (n: number) => `Select at least ${n}.`,
  seenTimes: (n: number) => `Seen ${n} times`,
  openOffer: (name: string) => `Open ${name}`,
  banner: (n: number) => `${plural(n, "offer group")} ${n === 1 ? "is" : "are"} blocked by a Shopify limit.`,
  review: "Review",
  diagnosticsTitle: "Capacity incidents",
  diagnosticsEmpty: "No capacity incidents.",
} as const;
