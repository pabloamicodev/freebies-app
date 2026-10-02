/**
 * Golden TS/Rust parity fixtures: packages/rule-engine/test-fixtures/parity/*.json.
 *
 * Each fixture is `{ name, description, source, config, cart, expected }`:
 *  - `config`   the discount-Function config exactly as compile-config emits it (the metafield JSON, parsed)
 *  - `cart`     { currency, presentmentCurrencyRate, country, customerTags, enteredCodes, lines[] }, line =
 *               { id, variantId, productId, quantity, unitPrice, lineType, metadata }. `lineType` is the
 *               `_promo_engine_line_type` attribute; `metadata` is the packed `_promo_engine_metadata` JSON.
 *  - `expected` { qualifiedOfferIds, discountedLineIds: { offerId: lineIds }, discountedQuantities? }.
 *               Invariant: an offer is qualified iff it discounts at least one line, so the Rust side can
 *               derive "qualified" from "emitted a candidate". `discountedQuantities` ({ offerId: { lineId: units } })
 *               is only present where unit caps are the point (D5).
 *  - `source`   the offers as the evaluator sees them (conditions/rewards), used by the TS parity test in
 *               packages/rule-engine; Rust ignores it.
 *
 * This test regenerates every fixture from the scenario table below and fails when a file on disk differs.
 * Refresh with: UPDATE_PARITY_FIXTURES=1 npx vitest run apps/shopify-admin/app/lib/sync/parity-fixtures.test.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileOfferConfig, serializeFunctionConfig } from "./compile-config.js";

const DIR = fileURLToPath(new URL("../../../../../packages/rule-engine/test-fixtures/parity/", import.meta.url));

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const GIFT_REWARD = "dddddddd-0000-4000-8000-000000000004";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const P = (n: number) => `gid://shopify/Product/${n}`;

interface LineSpec {
  id: string;
  variantId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  lineType: "gift" | "upsell" | null;
  metadata: Record<string, string> | null;
}

function line(id: string, n: number, metadata: Record<string, string> | null, extra: Partial<LineSpec> = {}): LineSpec {
  return { id, variantId: V(n), productId: P(n), quantity: 1, unitPrice: "10.00", lineType: null, metadata, ...extra };
}
const page = (url: string, extra: Record<string, string> = {}) => ({ _promo_page_url: url, ...extra });

type Cond = [conditionType: string, value: Record<string, unknown>, scope?: "main" | "sub"];

interface OfferSpec {
  id: string;
  type: "discount" | "gift" | "upsell";
  priority?: number;
  stopLowerPriority?: boolean;
  codePromo?: boolean;
  conditions: Cond[];
  rewards: Array<Record<string, unknown>>;
}

function discountOffer(id: string, conditions: Cond[], target: Record<string, unknown> = {}, extra: Partial<OfferSpec> = {}): OfferSpec {
  return {
    id,
    type: "discount",
    conditions,
    rewards: [
      {
        id: `${id.slice(0, 8)}-reward`,
        rewardType: "product_discount",
        discountType: "percentage",
        value: { amount: 10, currencyCode: "USD" },
        target,
        quantity: null,
        isAutoAdd: false,
        isCustomerSelectable: false,
        trackMode: "variant",
        sortOrder: 0,
        label: null,
      },
    ],
    ...extra,
  };
}

/** "single": one gift product. "set": every product is given (one reward each). "picker": choose from the products. */
function giftOffer(
  id: string,
  conditions: Cond[],
  quantity = 1,
  products: number[] = [50],
  mode: "single" | "set" | "picker" = "single",
): OfferSpec {
  const reward = (rewardId: string, ns: number[], selectable: boolean) => ({
    id: rewardId,
    rewardType: "product_gift",
    discountType: "free",
    value: { percentage: 100, currencyCode: "USD" },
    target: { variantIds: ns.map(V), productIds: ns.map(P) },
    quantity,
    isAutoAdd: false,
    isCustomerSelectable: selectable,
    trackMode: "variant",
    sortOrder: 0,
    label: null,
  });
  return {
    id,
    type: "gift",
    conditions,
    rewards:
      mode === "set"
        ? products.map((n) => reward(setRewardId(n), [n], false))
        : [reward(GIFT_REWARD, products, mode === "picker")],
  };
}

const setRewardId = (n: number) => `dddddddd-0000-4000-8000-0000000000${n}`;

function upsellOffer(id: string, conditions: Cond[], productIds: string[]): OfferSpec {
  return {
    id,
    type: "upsell",
    conditions,
    rewards: [
      {
        id: `${id.slice(0, 8)}-upsell`,
        rewardType: "upsell_discount",
        discountType: "percentage",
        value: { amount: 20, currencyCode: "USD" },
        target: { scopeMode: "tagged_offer", requiredOfferId: id, productIds },
        quantity: null,
        isAutoAdd: false,
        isCustomerSelectable: false,
        trackMode: "variant",
        sortOrder: 0,
        label: null,
      },
    ],
  };
}

const pageTypes = (types: string[], extra: Record<string, unknown> = {}): Cond => ["page_types", { pageTypes: types, ...extra }];
const utm = (value: Record<string, unknown>): Cond => ["utm_parameters", value];
const pageUrl = (patterns: string[], matchMode: string, extra: Record<string, unknown> = {}): Cond => [
  "page_url",
  { patterns, matchMode, caseSensitive: false, ...extra },
];
const cartValue = (thresholdCents: number, scopeFilter?: Record<string, unknown>): Cond => [
  "cart_value",
  { thresholdCents, currencyCode: "USD", includeGiftValues: false, ...(scopeFilter ? { scopeFilter } : {}) },
  "main",
];

interface Scenario {
  name: string;
  description: string;
  offers: OfferSpec[];
  country?: string | null;
  lines: LineSpec[];
  qualified: string[];
  discounted: Record<string, string[]>;
  quantities?: Record<string, Record<string, number>>;
}

const gift = (id: string, offerId: string, metadata: Record<string, string> = {}, extra: Partial<LineSpec> = {}): LineSpec =>
  line(id, 50, {
    _promo_engine_offer_id: offerId,
    _promo_engine_reward_id: GIFT_REWARD,
    _promo_engine_offer_version: "1",
    ...metadata,
  }, { lineType: "gift", unitPrice: "5.00", ...extra });

const landingLine = (id: string, n: number, quantity: number): LineSpec =>
  line(id, n, { __landing_source: "tru-landing" }, { quantity });

function landingOffer(quantity: number | null): OfferSpec {
  return discountOffer(
    A,
    [["line_attribute", { key: "__landing_source", value: "tru-landing", matchMode: "equals", minMatchingQuantity: 1 }, "main"]],
    {
      scopeMode: "landing",
      requiredLineAttributeValue: "tru-landing",
      requiredAnchorVariantIds: [V(1)],
      requiredAnchorMinQuantity: 1,
      productIds: [P(2), P(3)],
    },
    {
      rewards: [
        {
          id: "landing-reward",
          rewardType: "product_discount",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            scopeMode: "landing",
            requiredLineAttributeValue: "tru-landing",
            requiredAnchorVariantIds: [V(1)],
            requiredAnchorMinQuantity: 1,
            productIds: [P(2), P(3)],
          },
          quantity,
          isAutoAdd: false,
          isCustomerSelectable: false,
          trackMode: "variant",
          sortOrder: 0,
          label: null,
        },
      ],
    },
  );
}

const SCENARIOS: Scenario[] = [
  {
    name: "page-types-product-restrict",
    description: "page_types [product] with only-matched-lines: nested /collections/x/products/y counts as a product page.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/products/a")),
      line("l2", 2, page("/")),
      line("l3", 3, page("/collections/x/products/y")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1", "l3"] },
  },
  {
    name: "page-types-locale-prefixes",
    description: "Locale segments (/en, /fr-ca, /EN-US) are ignored; a 3-letter /eng is not a locale; case-insensitive.",
    offers: [discountOffer(A, [pageTypes(["product", "collection"], { onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/en/products/a")),
      line("l2", 2, page("/fr-ca/collections/sale")),
      line("l3", 3, page("/EN-US/Products/B")),
      line("l4", 4, page("/eng/products/x")),
      line("l5", 5, page("/pt-BR/pages/about")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1", "l2", "l3"] },
  },
  {
    name: "page-types-collection-product-path",
    description: "page_types [product] only: /collections/x/products/y (with or without locale) is a product page, bare collections are not.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/collections/x/products/y")),
      line("l2", 2, page("/collections/x")),
      line("l3", 3, page("/en/collections/x/products/y")),
      line("l4", 4, page("/collections")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1", "l3"] },
  },
  {
    name: "page-types-every-kind",
    description: "home/search/page/blog/cart selected; product, collection and unclassified paths (/account, /policies) do not match.",
    offers: [discountOffer(A, [pageTypes(["home", "search", "page", "blog", "cart"], { onlyMatchedLines: true })])],
    lines: [
      line("h1", 1, page("/")),
      line("h2", 2, page("/search?q=x")),
      line("h3", 3, page("/pages/about")),
      line("h4", 4, page("/blogs/news/x")),
      line("h5", 5, page("/cart")),
      line("h6", 6, page("/products/a")),
      line("h7", 7, page("/collections/all")),
      line("h8", 8, page("/account")),
      line("h9", 9, page("/policies/refund-policy")),
    ],
    qualified: [A],
    discounted: { [A]: ["h1", "h2", "h3", "h4", "h5"] },
  },
  {
    name: "page-url-contains-case-insensitive",
    description: "page_url contains /pages/VIP, case-insensitive: the path is matched, the query string is not.",
    offers: [discountOffer(A, [pageUrl(["/pages/VIP"], "contains", { onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/pages/vip-landing")),
      line("l2", 2, page("/Pages/VIP?x=1")),
      line("l3", 3, page("/pages/other")),
      line("l4", 4, page("/pages/other?ref=/pages/vip")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1", "l2"] },
  },
  {
    name: "page-url-case-sensitive-exact",
    description: "page_url exact and case-sensitive; an absolute URL is reduced to its path first.",
    offers: [discountOffer(A, [["page_url", { patterns: ["/pages/vip"], matchMode: "exact", caseSensitive: true, onlyMatchedLines: true }]])],
    lines: [
      line("l1", 1, page("/pages/vip")),
      line("l2", 2, page("/pages/VIP")),
      line("l3", 3, page("https://shop.example/pages/vip?ref=1")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1", "l3"] },
  },
  {
    name: "page-url-forms",
    description: "D3 URL forms: http(s)://, protocol-relative // and fragments are stripped; a bare host/path and a :// inside the query are not misread.",
    offers: [discountOffer(A, [pageUrl(["/pages/vip"], "exact", { onlyMatchedLines: true })])],
    lines: [
      line("a1", 1, page("https://shop.example/pages/vip")),
      line("a2", 2, page("//shop.example/pages/vip")),
      line("a3", 3, page("HTTP://Shop.Example/pages/vip#frag")),
      line("a4", 4, page("shop.example/pages/vip")),
      line("a5", 5, page("/pages/vip#frag")),
      line("a6", 6, page("/pages/vip?next=https://x.com/pages/other")),
    ],
    qualified: [A],
    discounted: { [A]: ["a1", "a2", "a3", "a5", "a6"] },
  },
  {
    name: "page-url-nested-in-query",
    description: "A URL nested inside a query string (encoded or not) never counts as the page path.",
    offers: [discountOffer(A, [pageUrl(["/products/x"], "contains", { onlyMatchedLines: true })])],
    lines: [
      line("n1", 1, page("/pages/redirect?next=https%3A%2F%2Fshop.test%2Fproducts%2Fx")),
      line("n2", 2, page("/pages/redirect?next=https://shop.test/products/x")),
      line("n3", 3, page("/products/x?next=https://a.com/pages/vip")),
      line("n4", 4, page("/en/products/x/?ref=1")),
    ],
    qualified: [A],
    discounted: { [A]: ["n3", "n4"] },
  },
  {
    name: "unstamped-lines-only-stamped-match",
    description: "Lines without _promo_page_url (null metadata, {}, landing-only) never match; only a stamped matching line does.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, null),
      line("l2", 2, {}),
      line("l3", 3, page("/products/a")),
      line("l4", 4, { _promo_landing_url: "/products/z" }),
    ],
    qualified: [A],
    discounted: { [A]: ["l3"] },
  },
  {
    name: "unstamped-cart-does-not-qualify",
    description: "No line carries a page stamp, so a page-conditioned offer does not qualify at all.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [line("l1", 1, null), line("l2", 2, {})],
    qualified: [],
    discounted: {},
  },
  {
    name: "utm-encoding-slash",
    description: "utm_source 'fb/ig' (stored raw) matches %2F, a literal slash and lowercase hex escapes; double-encoding does not.",
    offers: [discountOffer(A, [utm({ utmSource: "fb/ig", onlyMatchedLines: true })])],
    lines: [
      line("u1", 1, page("/?utm_source=fb%2Fig")),
      line("u2", 2, page("/?utm_source=fb/ig")),
      line("u3", 3, page("/?utm_source=FB%2fIG")),
      line("u4", 4, page("/?utm_source=fb")),
      line("u5", 5, page("/?utm_source=fb%252Fig")),
    ],
    qualified: [A],
    discounted: { [A]: ["u1", "u2", "u3"] },
  },
  {
    name: "utm-plus-and-percent20",
    description: "utm_campaign 'summer sale': + and %20 both decode to a space, case-insensitive; %2B is a real plus and does not match.",
    offers: [discountOffer(A, [utm({ utmCampaign: "summer sale", onlyMatchedLines: true })])],
    lines: [
      line("v1", 1, page("/?utm_campaign=summer+sale")),
      line("v2", 2, page("/?utm_campaign=summer%20sale")),
      line("v3", 3, page("/?utm_campaign=Summer%20Sale")),
      line("v4", 4, page("/?utm_campaign=summer-sale")),
      line("v5", 5, page("/?utm_campaign=summer%2Bsale")),
    ],
    qualified: [A],
    discounted: { [A]: ["v1", "v2", "v3"] },
  },
  {
    name: "utm-case-insensitive-names-and-values",
    description: "utm_* names and values compare ASCII case-insensitively; every configured field must match.",
    offers: [discountOffer(A, [utm({ utmSource: "Amazon", utmMedium: "CPC", onlyMatchedLines: true })])],
    lines: [
      line("c1", 1, page("/?UTM_SOURCE=amazon&utm_medium=cpc")),
      line("c2", 2, page("/?utm_source=AMAZON&UTM_Medium=Cpc")),
      line("c3", 3, page("/?utm_source=amazon")),
      line("c4", 4, page("/?utm_source=amazon&utm_medium=email")),
    ],
    qualified: [A],
    discounted: { [A]: ["c1", "c2"] },
  },
  {
    name: "utm-non-ascii-case-is-ascii-only",
    description: "Case folding is ASCII only: %C3%89 (E-acute) is not the same as %C3%A9 (e-acute).",
    offers: [discountOffer(A, [utm({ utmCampaign: "été", onlyMatchedLines: true })])],
    lines: [
      line("e1", 1, page("/?utm_campaign=%C3%A9t%C3%A9")),
      line("e2", 2, page("/?utm_campaign=été")),
      line("e3", 3, page("/?utm_campaign=%C3%89T%C3%89")),
    ],
    qualified: [A],
    discounted: { [A]: ["e1", "e2"] },
  },
  {
    name: "utm-visit-scope-reads-landing",
    description: "Visit-scoped UTM reads _promo_landing_url; a utm on the add page alone does not count.",
    offers: [discountOffer(A, [utm({ utmSource: "amazon", scope: "visit", onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/products/a", { _promo_landing_url: "/pages/prime?utm_source=amazon" })),
      line("l2", 2, page("/products/b?utm_source=amazon")),
      line("l3", 3, page("/products/c", { _promo_landing_url: "/pages/prime?utm_source=google" })),
    ],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "utm-page-scope-ignores-landing",
    description: "Page-scoped UTM reads the add page; a landing URL carrying the utm does not count.",
    offers: [discountOffer(A, [utm({ utmSource: "amazon", onlyMatchedLines: true })])],
    lines: [
      line("l1", 1, page("/products/a?utm_source=amazon")),
      line("l2", 2, page("/products/b", { _promo_landing_url: "/x?utm_source=amazon" })),
    ],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "combined-conditions-same-line",
    description: "D1: page_types [product] AND utm_source amazon must both hold on the same line.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true }), utm({ utmSource: "amazon" })])],
    lines: [
      line("l1", 1, page("/products/a?utm_source=amazon")),
      line("l2", 2, page("/?utm_source=amazon")),
      line("l3", 3, page("/products/b")),
    ],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "combined-conditions-split-across-lines",
    description: "D1: one line matches only the page type, another only the utm: no single line matches both, so the offer does not qualify.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true }), utm({ utmSource: "amazon" })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/?utm_source=amazon"))],
    qualified: [],
    discounted: {},
  },
  {
    name: "specific-link-path-and-param",
    description: "specific_link: required path is a case-insensitive contains (absolute URL reduced to its path), param name/value are exact.",
    offers: [
      discountOffer(A, [
        ["specific_link", { requiredUrl: "https://shop.example/pages/vip", paramName: "freegifts_code", paramValue: "SUMMER", onlyMatchedLines: true }],
      ]),
    ],
    lines: [
      line("s1", 1, page("/pages/vip?freegifts_code=SUMMER")),
      line("s2", 2, page("/pages/vip?freegifts_code=summer")),
      line("s3", 3, page("/pages/other?freegifts_code=SUMMER")),
      line("s4", 4, page("https://shop.example/pages/VIP?x=1&freegifts_code=SUMMER")),
      line("s5", 5, page("/en/pages/vip?freegifts_code=SUMMER")),
    ],
    qualified: [A],
    discounted: { [A]: ["s1", "s4", "s5"] },
  },
  {
    name: "specific-link-encoded-name-and-value",
    description: "specific_link param 'gift code' = 'a&b' (stored raw): + / %20 in the name and %26 in the value decode.",
    offers: [discountOffer(A, [["specific_link", { requiredUrl: "/pages/vip", paramName: "gift code", paramValue: "a&b", onlyMatchedLines: true }]])],
    lines: [
      line("e1", 1, page("/pages/vip?gift+code=a%26b")),
      line("e2", 2, page("/pages/vip?gift%20code=a%26b")),
      line("e3", 3, page("/pages/vip?gift+code=a&b")),
      line("e4", 4, page("/pages/vip?gift_code=a%26b")),
    ],
    qualified: [A],
    discounted: { [A]: ["e1", "e2"] },
  },
  {
    name: "reject-mixed-cart-blocks-offer",
    description: "rejectUnmatchedLines: one non-matching line blocks the whole offer.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true, rejectUnmatchedLines: true })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/"))],
    qualified: [],
    discounted: {},
  },
  {
    name: "reject-all-lines-match",
    description: "rejectUnmatchedLines with every line matching: the offer applies to all of them.",
    offers: [discountOffer(A, [pageTypes(["product"], { rejectUnmatchedLines: true })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/en/collections/x/products/y"))],
    qualified: [A],
    discounted: { [A]: ["l1", "l2"] },
  },
  {
    name: "reject-unstamped-line-blocks-offer",
    description: "A non-gift line with no page stamp counts as unmatched in reject mode.",
    offers: [discountOffer(A, [pageTypes(["product"], { rejectUnmatchedLines: true })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, null)],
    qualified: [],
    discounted: {},
  },
  {
    name: "exclude-mixed-cart-discounts-only-matched",
    description: "Exclude mode (only-matched-lines, no reject): the mixed cart qualifies, only the matched line is discounted.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/"))],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "exclude-without-restrict-discounts-every-line",
    description: "onlyMatchedLines false: one matched line unlocks the offer for every non-gift line.",
    offers: [discountOffer(A, [pageTypes(["product"], { onlyMatchedLines: false })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/"))],
    qualified: [A],
    discounted: { [A]: ["l1", "l2"] },
  },
  {
    name: "code-promo-defaults-to-restrict",
    description: "A code promo with onlyMatchedLines unset restricts to matched lines (compiler emits restrictToMatchedLines).",
    offers: [discountOffer(A, [pageTypes(["home"])], {}, { codePromo: true })],
    lines: [line("l1", 1, page("/")), line("l2", 2, page("/products/a"))],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "threshold-counts-whole-cart-in-restrict-mode",
    description: "Thresholds count the whole cart even when only matched lines are discounted.",
    offers: [discountOffer(A, [cartValue(5000), pageTypes(["product"], { onlyMatchedLines: true })])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/"), { unitPrice: "60.00" })],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "reject-ignores-excluded-product-lines",
    description: "A line whose product is excluded is ignored by the reject check (and never discounted).",
    offers: [
      discountOffer(A, [cartValue(100, { excludeProductIds: [P(9)] }), pageTypes(["product"], { onlyMatchedLines: true, rejectUnmatchedLines: true })]),
    ],
    lines: [line("l1", 1, page("/products/a")), line("l9", 9, page("/"))],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "excluded-product-never-discounted",
    description: "Offer-level excluded products are never discounted even when their page matches.",
    offers: [discountOffer(A, [cartValue(100, { excludeProductIds: [P(9)] }), pageTypes(["product"])])],
    lines: [line("l1", 1, page("/products/a")), line("l2", 2, page("/products/b")), line("l9", 9, page("/products/c"))],
    qualified: [A],
    discounted: { [A]: ["l1", "l2"] },
  },
  {
    name: "reject-exempts-upsell-lines",
    description: "App-added upsell lines are exempt from the reject check: the upsell from /cart does not block the offer, and (no restrict) is discounted.",
    offers: [upsellOffer(A, [pageTypes(["product"], { rejectUnmatchedLines: true })], [P(60)])],
    lines: [
      line("l1", 1, page("/products/a")),
      line("u1", 60, page("/cart", { _promo_engine_offer_id: A }), { lineType: "upsell" }),
    ],
    qualified: [A],
    discounted: { [A]: ["u1"] },
  },
  {
    name: "restrict-upsell-line-must-match",
    description: "With only-matched-lines an upsell line is discounted only when its own page matches.",
    offers: [upsellOffer(A, [pageTypes(["product"], { onlyMatchedLines: true })], [P(60), P(61)])],
    lines: [
      line("l1", 1, page("/products/a")),
      line("u1", 60, page("/cart", { _promo_engine_offer_id: A }), { lineType: "upsell" }),
      line("u2", 61, page("/products/z", { _promo_engine_offer_id: A }), { lineType: "upsell" }),
    ],
    qualified: [A],
    discounted: { [A]: ["u2"] },
  },
  {
    name: "gift-line-discounted-when-offer-qualifies",
    description: "A gift offer gated on page_types qualifies via a matching regular line; its gift line is discounted even though it was stamped from /cart.",
    offers: [giftOffer(A, [pageTypes(["product"])])],
    lines: [line("l1", 1, page("/products/a")), gift("g1", A, page("/cart"))],
    qualified: [A],
    discounted: { [A]: ["g1"] },
  },
  {
    name: "gift-offer-without-matching-line-does-not-qualify",
    description: "No regular line matches the page condition: the gift offer does not qualify and its gift line is not discounted.",
    offers: [giftOffer(A, [pageTypes(["product"])])],
    lines: [line("l1", 1, page("/")), gift("g1", A)],
    qualified: [],
    discounted: {},
  },
  {
    name: "priority-stop-blocks-only-strictly-lower",
    description: "A stop offer at priority 10 blocks priority 20 but not another priority-10 offer.",
    offers: [
      discountOffer(A, [], { productIds: [P(1)] }, { priority: 10, stopLowerPriority: true }),
      discountOffer(B, [], { productIds: [P(2)] }, { priority: 10 }),
      discountOffer(C, [], { productIds: [P(3)] }, { priority: 20 }),
    ],
    lines: [line("l1", 1, null), line("l2", 2, null), line("l3", 3, null)],
    qualified: [A, B],
    discounted: { [A]: ["l1"], [B]: ["l2"] },
  },
  {
    name: "priority-stop-offer-not-qualifying-does-not-block",
    description: "A stop-lower-priority offer that does not qualify blocks nothing.",
    offers: [
      discountOffer(A, [pageTypes(["cart"], { onlyMatchedLines: true })], { productIds: [P(1)] }, { priority: 10, stopLowerPriority: true }),
      discountOffer(C, [], { productIds: [P(3)] }, { priority: 20 }),
    ],
    lines: [line("l1", 1, page("/products/a")), line("l3", 3, page("/products/c"))],
    qualified: [C],
    discounted: { [C]: ["l3"] },
  },
  {
    name: "customer-location-include-cart-country",
    description: "customer_location uses the cart's market country (localization): US is in the include list.",
    offers: [discountOffer(A, [["customer_location", { includeCountryCodes: ["US"] }]])],
    country: "US",
    lines: [line("l1", 1, null)],
    qualified: [A],
    discounted: { [A]: ["l1"] },
  },
  {
    name: "customer-location-excluded-country",
    description: "customer_location exclude list blocks the cart's market country (CA).",
    offers: [discountOffer(A, [["customer_location", { excludeCountryCodes: ["CA"] }]])],
    country: "CA",
    lines: [line("l1", 1, null)],
    qualified: [],
    discounted: {},
  },
  {
    name: "customer-location-not-in-include-list",
    description: "customer_location include list [US, CA] rejects a MX cart.",
    offers: [discountOffer(A, [["customer_location", { includeCountryCodes: ["US", "CA"] }]])],
    country: "MX",
    lines: [line("l1", 1, null)],
    qualified: [],
    discounted: {},
  },
  {
    name: "landing-limit-defaults-to-one-set-per-target-product",
    description: "D5: no configured limit, so the gift set is granted once: 1 free unit of each target product, however many anchors (2) or target units (10 each) are in the cart.",
    offers: [landingOffer(null)],
    country: null,
    lines: [landingLine("anchor", 1, 2), landingLine("target2", 2, 10), landingLine("target3", 3, 10)],
    qualified: [A],
    discounted: { [A]: ["target2", "target3"] },
    quantities: { [A]: { target2: 1, target3: 1 } },
  },
  {
    name: "landing-limit-is-sets-per-target-product",
    description: "D5: a configured limit of 3 is the number of sets: up to 3 free units of EACH target product, not 3 in total, even with 5 anchors and 10 units per target.",
    offers: [landingOffer(3)],
    lines: [landingLine("anchor", 1, 5), landingLine("target2", 2, 10), landingLine("target3", 3, 10)],
    qualified: [A],
    discounted: { [A]: ["target2", "target3"] },
    quantities: { [A]: { target2: 3, target3: 3 } },
  },
  {
    name: "gift-manual-quantity-bump-limit-1",
    description: "A shopper raises the gift line to 5 with limit 1: exactly 1 unit is free, the other 4 are charged.",
    offers: [giftOffer(A, [pageTypes(["product"])])],
    lines: [line("l1", 1, page("/products/a")), gift("g1", A, page("/cart"), { quantity: 5 })],
    qualified: [A],
    discounted: { [A]: ["g1"] },
    quantities: { [A]: { g1: 1 } },
  },
  {
    name: "gift-manual-quantity-bump-set-limit-2",
    description: "A 2-gift set (all gifts are given) with limit 2, each gift line raised to 5: 2 free units of EACH product, not 2 shared.",
    offers: [giftOffer(A, [pageTypes(["product"])], 2, [50, 51], "set")],
    lines: [
      line("l1", 1, page("/products/a")),
      gift("g1", A, page("/cart", { _promo_engine_reward_id: setRewardId(50) }), { quantity: 5 }),
      gift("g2", A, page("/cart", { _promo_engine_reward_id: setRewardId(51) }), { quantity: 5, variantId: V(51), productId: P(51) }),
    ],
    qualified: [A],
    discounted: { [A]: ["g1", "g2"] },
    quantities: { [A]: { g1: 2, g2: 2 } },
  },
  {
    name: "gift-picker-one-of-four-all-added",
    description: "A choose-1-of-4 picker where the shopper POSTs /cart/add for all four gifts: only the first line added is free.",
    offers: [giftOffer(A, [pageTypes(["product"])], 1, [50, 51, 52, 53], "picker")],
    lines: [
      line("l1", 1, page("/products/a")),
      ...[50, 51, 52, 53].map((n) =>
        gift(`g${n}`, A, page("/cart"), { variantId: V(n), productId: P(n) }),
      ),
    ],
    qualified: [A],
    discounted: { [A]: ["g50"] },
    quantities: { [A]: { g50: 1 } },
  },
  {
    name: "gift-picker-bumped-quantity-and-extra-option",
    description: "Picker of 3 with limit 1: the picked gift raised to qty 4 gets 1 free unit, and a second option added on top gets nothing.",
    offers: [giftOffer(A, [pageTypes(["product"])], 1, [50, 51, 52], "picker")],
    lines: [
      line("l1", 1, page("/products/a")),
      gift("g50", A, page("/cart"), { quantity: 4 }),
      gift("g51", A, page("/cart"), { variantId: V(51), productId: P(51) }),
    ],
    qualified: [A],
    discounted: { [A]: ["g50"] },
    quantities: { [A]: { g50: 1 } },
  },
];

function build(scenario: Scenario) {
  const compiled = scenario.offers.map((spec) =>
    compileOfferConfig(
      { id: spec.id, type: spec.type, priority: spec.priority ?? 100, publicTitle: null } as never,
      spec.conditions.map(([conditionType, value, scope], index) => ({
        id: `${spec.id}-c${index}`,
        conditionType,
        value,
        operator: conditionType === "cart_value" ? "gte" : "eq",
        scope: scope ?? "sub",
        isEnabled: true,
        sortOrder: index,
      })) as never,
      spec.rewards.map((reward) => ({ ...reward, target: reward["target"] ?? {} })) as never,
      { stopLowerPriority: spec.stopLowerPriority ?? false } as never,
      1,
      { codePromo: spec.codePromo === true },
    ),
  );
  const config = JSON.parse(
    serializeFunctionConfig({ offers: compiled, shippingOffers: [], version: "parity", compiledAt: "2026-01-01T00:00:00.000Z" }),
  ) as unknown;
  return {
    name: scenario.name,
    description: scenario.description,
    source: {
      offers: scenario.offers.map((spec) => ({
        id: spec.id,
        version: 1,
        type: spec.type,
        priority: spec.priority ?? 100,
        stopLowerPriority: spec.stopLowerPriority ?? false,
        conditions: spec.conditions.map(([conditionType, value, scope], index) => ({
          conditionType,
          value,
          scope: scope ?? "sub",
          operator: conditionType === "cart_value" ? "gte" : "eq",
          sortOrder: index,
        })),
        rewards: spec.rewards,
      })),
    },
    config,
    cart: {
      currency: "USD",
      presentmentCurrencyRate: 1,
      country: scenario.country === undefined ? "US" : scenario.country,
      customerTags: [] as string[],
      enteredCodes: [] as string[],
      lines: scenario.lines,
    },
    expected: {
      qualifiedOfferIds: scenario.qualified,
      discountedLineIds: scenario.discounted,
      ...(scenario.quantities ? { discountedQuantities: scenario.quantities } : {}),
    },
  };
}

const fileOf = (name: string) => `${DIR}${name}.json`;
const serialize = (fixture: ReturnType<typeof build>) => `${JSON.stringify(fixture, null, 2)}\n`;

describe("TS/Rust parity fixtures", () => {
  it("has at least 15 fixtures with unique names", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(SCENARIOS.length);
  });

  it("keeps qualified == discounts at least one line, so Rust can derive it from candidates", () => {
    for (const scenario of SCENARIOS) {
      const withLines = Object.entries(scenario.discounted)
        .filter(([, lines]) => lines.length > 0)
        .map(([offerId]) => offerId)
        .sort();
      expect(withLines, scenario.name).toEqual([...scenario.qualified].sort());
    }
  });

  if (process.env["UPDATE_PARITY_FIXTURES"] === "1") {
    it("writes the fixtures", () => {
      mkdirSync(DIR, { recursive: true });
      const names = new Set(SCENARIOS.map((scenario) => `${scenario.name}.json`));
      for (const file of readdirSync(DIR)) if (file.endsWith(".json") && !names.has(file)) unlinkSync(`${DIR}${file}`);
      for (const scenario of SCENARIOS) writeFileSync(fileOf(scenario.name), serialize(build(scenario)));
    });
  } else {
    it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
      "%s is in sync with compile-config output",
      (name, scenario) => {
        expect(existsSync(fileOf(name)), `missing ${name}.json, run with UPDATE_PARITY_FIXTURES=1`).toBe(true);
        expect(readFileSync(fileOf(name), "utf8")).toBe(serialize(build(scenario)));
      },
    );

    it("has no stray fixture files", () => {
      const names = new Set(SCENARIOS.map((scenario) => `${scenario.name}.json`));
      expect(readdirSync(DIR).filter((file) => !names.has(file))).toEqual([]);
    });
  }
});
