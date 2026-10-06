import { DISCOUNT_MESSAGE_MAX_LENGTH } from "../lib/discount-message.js";
/**
 * Discount Codes wizard: an offer that only applies while one of its own codes
 * is entered. Routes: /app/offers/new/codes/single | bulk | campaign.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { and, eq } from "drizzle-orm";
import { offers } from "@promo/db";
import { getShopContext, type ShopContext } from "../lib/shop-context.server.js";
import { nowInZone } from "../lib/offer-validation.server.js";
import {
  finalizeCreatedOffer,
  publishShopConfig,
  validateOffersPublishable,
} from "../lib/offer-publish-flow.server.js";
import { insertCodeOffer, parseCodeOfferForm, type DiscountTarget } from "../lib/code-offer-wizard.server.js";
import { CODE_CHARSETS, type CodeCharset } from "../lib/discount-code-generation.js";
import { automaticModeWarnings } from "../lib/code-redemption.js";
import { DEFAULT_CODE_PAGE_TYPES, pageTypeLabel } from "../lib/page-types.js";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard.js";
import { OfferWizardHeader, OfferWizardSection, type WizardAccent } from "../components/offers/OfferWizardLayout.js";
import { OfferConditionsBuilder } from "../components/OfferConditionsBuilder.js";
import { PageTypeCheckboxes, PAGE_TYPES_HELP, UtmScopeChoice } from "../components/subconditions/forms.js";
import { PurchaseTypeField } from "../components/PurchaseTypeField.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { SelectedProductsList } from "../components/SelectedProductsList.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Toast } from "../components/Toast.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// Above this many new codes, publishing inline could outlive the request (same as the Codes tab).
const INLINE_PUBLISH_LIMIT = 500;
const COLLECTION_PAGE_LIMIT = 4;

const COLLECTION_PRODUCTS_QUERY = `#graphql
  query WizardCollectionProducts($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

async function collectionProductIds(admin: ShopContext["admin"], collectionIds: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const id of collectionIds) {
    let after: string | null = null;
    for (let page = 0; page < COLLECTION_PAGE_LIMIT; page += 1) {
      const response = await admin.graphql(COLLECTION_PRODUCTS_QUERY, { variables: { id, after } });
      const body = (await response.json()) as {
        data?: {
          collection?: {
            products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> };
          } | null;
        };
      };
      const products = body.data?.collection?.products;
      if (!products) break;
      for (const node of products.nodes) ids.add(node.id);
      if (!products.pageInfo.hasNextPage) break;
      after = products.pageInfo.endCursor;
    }
  }
  return [...ids];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { timezone, currencyCode } = await getShopContext(request);
  return { nowLocal: nowInZone(timezone), currencyCode };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { db, shopId, session, timezone, currencyCode, admin } = context;

  const parsed = parseCodeOfferForm(formData, { timezone, currencyCode });
  if (!parsed.ok) return { error: parsed.error };
  const created = await insertCodeOffer(db, shopId, timezone, parsed.data, (ids) =>
    collectionProductIds(admin, ids),
  );
  if (!created.ok) return { error: created.error };
  const { offerId, codesCreated } = created.data;

  let publishError: string | null;
  if (parsed.data.status === "active" && codesCreated > INLINE_PUBLISH_LIMIT) {
    const validation = await validateOffersPublishable(db, shopId, [offerId]);
    publishError = validation.ok ? null : (validation.error ?? "The offer could not be published.");
    if (publishError) {
      await db
        .update(offers)
        .set({ status: "draft", updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
    } else {
      waitUntil(publishShopConfig(shopId, session.shop));
    }
  } else {
    publishError = await finalizeCreatedOffer(db, shopId, session.shop, offerId, parsed.data.status);
  }
  // The offer and its codes exist either way; resubmitting would only hit "code already used".
  if (publishError) return { error: `${publishError} It was saved as a draft.`, offerId };
  return redirect(parsed.data.redemption === "automatic" ? `/app/offers/${offerId}` : `/app/offers/${offerId}/codes`);
};

// ─── Client ──────────────────────────────────────────────────────────────────

const CODE_WIZARD_TEMPLATES = ["single", "bulk", "campaign"] as const;
type CodeWizardTemplate = (typeof CODE_WIZARD_TEMPLATES)[number];

const ACCENT: WizardAccent = {
  color: "#ea580c",
  gradient: "linear-gradient(135deg, #fb923c 0%, #ea580c 100%)",
  soft: "rgba(234,88,12,0.12)",
};

const TEMPLATE_COPY: Record<CodeWizardTemplate, { title: string; subtitle: string; name: string; publicTitle: string }> = {
  single: {
    title: "Single discount code",
    subtitle: "One code you share with everyone, like SUMMER10",
    name: "Discount code",
    publicTitle: "Discount code",
  },
  bulk: {
    title: "Bulk discount codes",
    subtitle: "Many unique codes, usually one use each",
    name: "Unique codes",
    publicTitle: "Your personal code",
  },
  campaign: {
    title: "Campaign discount code",
    subtitle: "A code that only works for visitors from a tagged campaign link",
    name: "Campaign code",
    publicTitle: "Campaign code",
  },
};

const CHARSET_LABELS: Record<CodeCharset, string> = {
  unambiguous: "Letters and numbers (no 0/O/1/I)",
  alphanumeric: "All letters and numbers",
  letters: "Letters only",
  numbers: "Numbers only",
};

const UTM_LABELS = [
  ["utmSource", "UTM source", "amazon"],
  ["utmMedium", "UTM medium", "cpc"],
  ["utmCampaign", "UTM campaign", "primeday2026"],
  ["utmTerm", "UTM term", "running-shoes"],
  ["utmContent", "UTM content", "banner-a"],
] as const;
type UtmKey = (typeof UTM_LABELS)[number][0];

function CodesIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
      <path d="M15 9l-6 6" />
      <path d="M9.5 9.5h.01M14.5 14.5h.01" />
    </svg>
  );
}

function RadioCard({
  name,
  value,
  checked,
  onChange,
  title,
  help,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  help?: ReactNode;
}) {
  return (
    <label
      className="b-checkbox-row"
      style={{
        cursor: "pointer",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: 8,
        border: `1.5px solid ${checked ? ACCENT.color : "var(--border)"}`,
        background: checked ? ACCENT.soft : "transparent",
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        style={{ accentColor: ACCENT.color, width: 14, height: 14, marginTop: 3 }}
      />
      <span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{title}</span>
        {help && <span className="b-checkbox-help" style={{ display: "block" }}>{help}</span>}
      </span>
    </label>
  );
}

type CollectionOption = { id: string; title: string };

function CollectionPicker({
  selected,
  onChange,
}: {
  selected: CollectionOption[];
  onChange: (next: CollectionOption[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CollectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/products/search/collections?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as { collections?: CollectionOption[]; message?: string };
          if (!response.ok) throw new Error("Collections could not be loaded.");
          setError(null);
          setResults(body.collections ?? []);
        })
        .catch((err: unknown) => {
          if ((err as Error).name !== "AbortError") setError("Collections could not be loaded.");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const selectedIds = new Set(selected.map((collection) => collection.id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        type="search"
        className="b-input"
        aria-label="Search collections"
        placeholder="Search collections"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
        }}
        autoComplete="off"
      />
      {error && <p className="b-help" style={{ margin: 0 }}>{error}</p>}
      <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {results.map((collection) => (
          <label key={collection.id} className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
            <input
              type="checkbox"
              checked={selectedIds.has(collection.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, { id: collection.id, title: collection.title }]
                    : selected.filter((item) => item.id !== collection.id),
                )
              }
              style={{ accentColor: ACCENT.color }}
            />
            <span style={{ fontSize: 13 }}>{collection.title}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {selected.map((collection) => (
            <span key={collection.id} className="b-badge b-badge-gray" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              {collection.title}
              <button
                type="button"
                aria-label={`Remove ${collection.title}`}
                onClick={() => onChange(selected.filter((item) => item.id !== collection.id))}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function discountSummary(target: DiscountTarget, type: string, value: string, currency: string, products: number, collections: number) {
  if (target === "shipping") return "Free shipping on the order";
  const amount = type === "percentage" ? `${value || "?"}% off` : `${currency} ${value || "?"} off`;
  if (target === "order") return `${amount} the whole order`;
  const parts = [
    products ? `${products} product${products === 1 ? "" : "s"}` : null,
    collections ? `${collections} collection${collections === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `${amount} ${parts.join(" and ") || "the selected products"}`;
}

export default function NewCodesOfferPage() {
  const { nowLocal, currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const { state } = useNavigation();
  const isSubmitting = state !== "idle";
  const { markDirty, blocker } = useUnsavedGuard(isSubmitting);
  const { template: rawTemplate = "single" } = useParams<{ template: string }>();
  const template: CodeWizardTemplate = (CODE_WIZARD_TEMPLATES as readonly string[]).includes(rawTemplate)
    ? (rawTemplate as CodeWizardTemplate)
    : "single";
  const copy = TEMPLATE_COPY[template];

  // Step 1 — codes
  const [redemption, setRedemption] = useState<"checkout_code" | "automatic">("checkout_code");
  const [codeMode, setCodeMode] = useState<"single" | "bulk">(template === "bulk" ? "bulk" : "single");
  const [code, setCode] = useState("");
  const [batchCount, setBatchCount] = useState("100");
  const [batchPrefix, setBatchPrefix] = useState("");
  const [batchLength, setBatchLength] = useState("8");
  const [batchCharset, setBatchCharset] = useState<CodeCharset>("unambiguous");
  const [usageLimit, setUsageLimit] = useState(template === "bulk" ? "1" : "");
  const [oncePerCustomer, setOncePerCustomer] = useState(template === "bulk");
  const [codeStartsAt, setCodeStartsAt] = useState("");
  const [codeEndsAt, setCodeEndsAt] = useState("");
  // Step 2 — discount
  const [discountTarget, setDiscountTarget] = useState<DiscountTarget>("order");
  const [discountType, setDiscountType] = useState<"percentage" | "fixed_amount">("percentage");
  const [discountValue, setDiscountValue] = useState("10");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  // Steps 3–5 — where it works
  const [pageTypes, setPageTypes] = useState<string[]>(DEFAULT_CODE_PAGE_TYPES);
  const [utmEnabled, setUtmEnabled] = useState(template === "campaign");
  const [utm, setUtm] = useState<Record<UtmKey, string>>({
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    utmTerm: "",
    utmContent: "",
  });
  const [utmScope, setUtmScope] = useState<"page" | "visit">("visit");
  const [mixedCart, setMixedCart] = useState<"only_matched" | "reject">("only_matched");
  // Step 7 — name, schedule, combinations
  const [internalName, setInternalName] = useState(copy.name);
  const [publicTitle, setPublicTitle] = useState(copy.publicTitle);
  const [startsAt, setStartsAt] = useState(nowLocal);
  const [endsAt, setEndsAt] = useState("");
  const [combines, setCombines] = useState({ order: false, product: true, shipping: true });
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    if (actionData?.error) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [actionData]);

  const isShipping = discountTarget === "shipping";
  const automatic = redemption === "automatic";
  const automaticWarnings = automatic ? automaticModeWarnings({ combinesWithOrderDiscounts: combines.order, pageTypes }) : [];
  const filledUtms = UTM_LABELS.filter(([key]) => utm[key].trim());

  function validate(): string | null {
    if (!automatic && codeMode === "single" && !code.trim()) return "Enter the discount code customers will type.";
    if (!automatic && codeMode === "bulk" && !(Number(batchCount) >= 1)) return "Enter how many codes to generate.";
    if (!isShipping && !(Number(discountValue) > 0)) return "Enter a discount greater than zero.";
    if (discountTarget === "products" && productIds.length === 0 && collections.length === 0) {
      return "Select at least one product or collection to discount.";
    }
    if (pageTypes.length === 0) return "Choose at least one kind of page where the code works.";
    if (utmEnabled && filledUtms.length === 0) {
      return "Fill in at least one UTM parameter, or turn off UTM validation.";
    }
    if (!internalName.trim()) return "Give the offer a name.";
    return null;
  }

  const codeSummary =
    codeMode === "single"
      ? `Code ${code.trim().toUpperCase() || "…"}`
      : `${Number(batchCount) || 0} unique codes like ${batchPrefix.trim().toUpperCase()}${"X".repeat(Math.min(Number(batchLength) || 8, 32))}`;
  const limitSummary = [
    usageLimit ? `up to ${usageLimit} use${usageLimit === "1" ? "" : "s"} per code` : "unlimited uses",
    oncePerCustomer ? "once per customer" : null,
  ]
    .filter(Boolean)
    .join(", ");

  let step = 0;
  const nextStep = () => (step += 1);

  return (
    <div className="b-page">
      <OfferWizardHeader
        title={copy.title}
        subtitle={copy.subtitle}
        badge="Discount codes"
        icon={<CodesIcon />}
        accent={ACCENT}
      />

      {actionData?.error && (
        <div className="b-banner b-banner-red b-mb-4" role="alert">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>
              {actionData.error}{" "}
              {"offerId" in actionData && actionData.offerId && (
                <Link to={`/app/offers/${actionData.offerId}/codes`}>Open the saved offer</Link>
              )}
            </p>
          </div>
        </div>
      )}

      <Form
        method="POST"
        onChange={markDirty}
        onSubmit={(event) => {
          const message = validate();
          setClientError(message);
          if (message) {
            event.preventDefault();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <input type="hidden" name="codeRedemption" value={redemption} />
        <input type="hidden" name="codeMode" value={codeMode} />
        <input type="hidden" name="discountTarget" value={discountTarget} />
        <input type="hidden" name="productIds" value={JSON.stringify(productIds)} />
        <input type="hidden" name="collectionIds" value={JSON.stringify(collections.map((collection) => collection.id))} />

        {/* ── 1. Codes ── */}
        <OfferWizardSection step={nextStep()} title="Codes" accent={ACCENT}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <fieldset className="b-radio-group b-grid-2" style={{ gap: 8 }}>
              <legend className="b-sr-only">How customers get the discount</legend>
              <RadioCard
                name="codeRedemptionChoice"
                value="checkout_code"
                checked={!automatic}
                onChange={() => setRedemption("checkout_code")}
                title="Customer enters a code at checkout"
                help="The discount applies only while one of the offer's codes is entered."
              />
              <RadioCard
                name="codeRedemptionChoice"
                value="automatic"
                checked={automatic}
                onChange={() => setRedemption("automatic")}
                title="Apply automatically — no code"
                help="No code needed. The offer applies to every cart that meets its conditions."
              />
            </fieldset>

            {automatic && (
              <div className="b-banner b-banner-blue" role="status" style={{ margin: 0 }}>
                <div className="b-banner-body">
                  <p className="b-banner-text" style={{ margin: 0 }}>
                    Usage limits, one-use-per-customer and code dates can't be enforced without a code, so they are
                    not available. The offer is gated only by the pages and conditions below.
                  </p>
                </div>
              </div>
            )}
            {automaticWarnings.map((warning) => (
              <div key={warning} className="b-banner b-banner-orange" role="alert" style={{ margin: 0 }}>
                <div className="b-banner-body">
                  <p className="b-banner-text" style={{ margin: 0 }}>{warning}</p>
                </div>
              </div>
            ))}

            {!automatic && (<>
            <fieldset className="b-radio-group b-grid-2" style={{ gap: 8 }}>
<legend className="b-sr-only">How many codes</legend>
              <RadioCard
                name="codeModeChoice"
                value="single"
                checked={codeMode === "single"}
                onChange={() => setCodeMode("single")}
                title="One code"
                help="Everyone uses the same code."
              />
              <RadioCard
                name="codeModeChoice"
                value="bulk"
                checked={codeMode === "bulk"}
                onChange={() => setCodeMode("bulk")}
                title="Many unique codes"
                help="We generate them; export them as CSV afterwards."
              />
            </fieldset>

            {codeMode === "single" ? (
              <div>
                <label className="b-label" htmlFor="code">Discount code</label>
                <input
                  id="code"
                  name="code"
                  className="b-input"
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="SUMMER10"
                  autoComplete="off"
                  style={{ textTransform: "uppercase" }}
                />
                <p className="b-help">Letters, numbers, dashes and underscores. Customers can type it in any case.</p>
              </div>
            ) : (
              <div className="b-grid-2">
                <div>
                  <label className="b-label" htmlFor="batchCount">Number of codes</label>
                  <input id="batchCount" name="batchCount" className="b-input" type="number" min={1} max={5000} value={batchCount} onChange={(event) => setBatchCount(event.target.value)} />
                  <p className="b-help">Up to 5,000 at a time. You can generate more later on the Codes tab.</p>
                </div>
                <div>
                  <label className="b-label" htmlFor="batchPrefix">Prefix (optional)</label>
                  <input id="batchPrefix" name="batchPrefix" className="b-input" value={batchPrefix} onChange={(event) => setBatchPrefix(event.target.value.toUpperCase())} placeholder="VIP-" autoComplete="off" style={{ textTransform: "uppercase" }} />
                </div>
                <div>
                  <label className="b-label" htmlFor="batchLength">Code length</label>
                  <input id="batchLength" name="batchLength" className="b-input" type="number" min={4} max={32} value={batchLength} onChange={(event) => setBatchLength(event.target.value)} />
                  <p className="b-help">Characters after the prefix.</p>
                </div>
                <div>
                  <label className="b-label" htmlFor="batchCharset">Characters</label>
                  <select id="batchCharset" name="batchCharset" className="b-select" value={batchCharset} onChange={(event) => setBatchCharset(event.target.value as CodeCharset)}>
                    {(Object.keys(CODE_CHARSETS) as CodeCharset[]).map((key) => (
                      <option key={key} value={key}>{CHARSET_LABELS[key]}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="b-grid-2">
              <div>
                <label className="b-label" htmlFor="usageLimit">Usage limit per code (optional)</label>
                <input id="usageLimit" name="usageLimit" className="b-input" type="number" min={1} value={usageLimit} onChange={(event) => setUsageLimit(event.target.value)} placeholder="No limit" />
                <p className="b-help">How many orders can use each code in total.</p>
              </div>
              <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8, alignSelf: "center" }}>
                <input type="checkbox" name="oncePerCustomer" checked={oncePerCustomer} onChange={(event) => setOncePerCustomer(event.target.checked)} style={{ accentColor: ACCENT.color }} />
                <span style={{ fontSize: 13 }}>Limit to one use per customer</span>
              </label>
              <div>
                <label className="b-label" htmlFor="codeStartsAt">Code works from (optional)</label>
                <input id="codeStartsAt" name="codeStartsAt" className="b-input" type="datetime-local" value={codeStartsAt} onChange={(event) => setCodeStartsAt(event.target.value)} />
              </div>
              <div>
                <label className="b-label" htmlFor="codeEndsAt">Code works until (optional)</label>
                <input id="codeEndsAt" name="codeEndsAt" className="b-input" type="datetime-local" value={codeEndsAt} onChange={(event) => setCodeEndsAt(event.target.value)} />
              </div>
            </div>
            <p className="b-help" style={{ margin: 0 }}>
              Leave the dates empty and the codes work whenever the offer is live (see the last step).
            </p>
            </>)}
          </div>
        </OfferWizardSection>

        {/* ── 2. Discount ── */}
        <OfferWizardSection step={nextStep()} title="Discount" accent={ACCENT}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <fieldset className="b-radio-group b-grid-3" style={{ gap: 8 }}>
<legend className="b-sr-only">What the discount applies to</legend>
              <RadioCard name="discountTargetChoice" value="order" checked={discountTarget === "order"} onChange={() => setDiscountTarget("order")} title="Whole order" help="Money off the order subtotal." />
              <RadioCard name="discountTargetChoice" value="products" checked={discountTarget === "products"} onChange={() => setDiscountTarget("products")} title="Specific products" help="Only the products or collections you pick." />
              <RadioCard name="discountTargetChoice" value="shipping" checked={discountTarget === "shipping"} onChange={() => setDiscountTarget("shipping")} title="Free shipping" help="Shipping costs nothing." />
            </fieldset>

            {!isShipping && (
              <div className="b-grid-2">
                <div>
                  <label className="b-label" htmlFor="discountType">Discount type</label>
                  <select id="discountType" name="discountType" className="b-select" value={discountType} onChange={(event) => setDiscountType(event.target.value as "percentage" | "fixed_amount")}>
                    <option value="percentage">Percentage off</option>
                    <option value="fixed_amount">Fixed amount off</option>
                  </select>
                </div>
                <div>
                  <label className="b-label" htmlFor="discountValue">{discountType === "percentage" ? "Percentage" : `Amount (${currencyCode})`}</label>
                  <input id="discountValue" name="discountValue" className="b-input" type="number" min="0" step={discountType === "percentage" ? "1" : "0.01"} max={discountType === "percentage" ? 100 : undefined} value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} />
                  {discountType === "fixed_amount" && discountTarget === "products" && (
                    <p className="b-help">Taken off each discounted product line.</p>
                  )}
                </div>
              </div>
            )}

            {!isShipping && <PurchaseTypeField idPrefix="code-wizard-purchase-type" />}

            {discountTarget === "products" && (
              <div className="b-grid-2">
                <div>
                  <div className="b-label">Products</div>
                  <button type="button" className="b-btn b-btn-secondary" onClick={() => setProductPickerOpen(true)}>
                    Select products
                  </button>
                  <SelectedProductsList
                    gids={productIds}
                    variantMode={false}
                    onRemove={(gid) => setProductIds(productIds.filter((id) => id !== gid))}
                  />
                </div>
                <div>
                  <div className="b-label">Collections</div>
                  <CollectionPicker selected={collections} onChange={setCollections} />
                  <p className="b-help">
                    We save the products that are in these collections now. Products you add to a collection later aren't included.
                  </p>
                </div>
              </div>
            )}
          </div>
        </OfferWizardSection>

          <>
            {/* ── 3. Where the code works ── */}
            <OfferWizardSection step={nextStep()} title="Where the code works" accent={ACCENT}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>
                  The code counts the page each product was added to cart from. Pick the pages that qualify.
                </p>
                <PageTypeCheckboxes idPrefix="codes" name="pageTypes" selected={pageTypes} onChange={setPageTypes} />
                <p className="b-help" style={{ margin: 0 }}>
                  {PAGE_TYPES_HELP} For example, with only Product pages checked, something added from a collection
                  grid doesn't count.
                </p>
              </div>
            </OfferWizardSection>

            {/* ── 4. UTM validation ── */}
            <OfferWizardSection step={nextStep()} title="UTM validation (optional)" accent={ACCENT}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name="utmEnabled" checked={utmEnabled} onChange={(event) => setUtmEnabled(event.target.checked)} style={{ accentColor: ACCENT.color }} />
                  <span style={{ fontSize: 13 }}>Only accept the code from visitors who came through a tagged link</span>
                </label>
                <p className="b-help" style={{ margin: 0 }}>
                  UTMs are the tags in a campaign link, like <code>?utm_source=newsletter</code>. Fill in only the ones
                  you want to check; empty fields are ignored. UTM values are not case-sensitive (<code>Email</code> matches
                  <code> email</code>). They are visible in the link, so they are not a secret: anyone who has the link can
                  use the code. Use them to target a campaign, not to keep a code private.
                </p>
                {utmEnabled && (
                  <>
                    <div className="b-grid-2">
                      {UTM_LABELS.map(([key, label, placeholder]) => (
                        <div key={key}>
                          <label className="b-label" htmlFor={key}>{label}</label>
                          <input id={key} name={key} className="b-input" value={utm[key]} onChange={(event) => setUtm({ ...utm, [key]: event.target.value })} placeholder={placeholder} autoComplete="off" />
                        </div>
                      ))}
                    </div>
                    <UtmScopeChoice name="utmScope" value={utmScope} onChange={setUtmScope} />
                  </>
                )}
              </div>
            </OfferWizardSection>

            {/* ── 5. Mixed carts ── */}
            <OfferWizardSection step={nextStep()} title="Carts with products from other pages" accent={ACCENT}>
              <fieldset className="b-radio-group" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
<legend className="b-sr-only">What happens with products from other pages</legend>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>
                  What happens when the cart also has products added from pages that don't qualify{utmEnabled ? " (or without the UTMs)" : ""}?
                  Products added by Buy it now, cart permalinks or apps that skip the page count as products from other pages.
                </p>
                {isShipping && (
                  <p className="b-help" style={{ margin: 0 }}>
                    In &quot;discount only products from allowed pages&quot; mode, free shipping applies if at least one product came
                    from an allowed page; choose &quot;code doesn&apos;t work…&quot; to require every product to come from an allowed page.
                  </p>
                )}
                <RadioCard
                  name="mixedCart"
                  value="only_matched"
                  checked={mixedCart === "only_matched"}
                  onChange={() => setMixedCart("only_matched")}
                  title="Discount only products added from allowed pages"
                  help="The code still works; the other products stay at full price."
                />
                <RadioCard
                  name="mixedCart"
                  value="reject"
                  checked={mixedCart === "reject"}
                  onChange={() => setMixedCart("reject")}
                  title="Code doesn't work if the cart has products from other pages"
                  help="Strict: the customer has to remove those products to use the code."
                />
              </fieldset>
            </OfferWizardSection>

            {/* ── 6. Extra conditions ── */}
            {!isShipping && (
            <OfferWizardSection step={nextStep()} title="Extra conditions (optional)" accent={ACCENT}>
              <OfferConditionsBuilder
                title="Extra conditions"
                description="Every condition here must also be true for the code to work. Only conditions checkout can verify are listed."
                functionEnforcedOnly
                exclude={["page_types", "utm_parameters"]}
                isCodePromo={!automatic}
              />
            </OfferWizardSection>
            )}
          </>

        {/* ── 7. Schedule, combinations and review ── */}
        <OfferWizardSection step={nextStep()} title="Schedule, combinations and review" accent={ACCENT}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="b-grid-2">
              <div>
                <label className="b-label" htmlFor="internalName">Offer name</label>
                <input id="internalName" name="internalName" className="b-input" value={internalName} onChange={(event) => setInternalName(event.target.value)} autoComplete="off" />
                <p className="b-help">Only your team sees this.</p>
              </div>
              <div>
                <label className="b-label" htmlFor="publicTitle">Discount message (shown in cart, checkout and orders)</label>
                <input id="publicTitle" maxLength={DISCOUNT_MESSAGE_MAX_LENGTH} name="publicTitle" className="b-input" value={publicTitle} onChange={(event) => setPublicTitle(event.target.value)} autoComplete="off" />
<div className="b-help">{publicTitle.length}/{DISCOUNT_MESSAGE_MAX_LENGTH} · Leave empty to use the offer name.</div>
                <p className="b-help">Shown next to the discount in the cart and at checkout.</p>
              </div>
              <div>
                <label className="b-label" htmlFor="startsAt">Offer starts <span style={{ fontWeight: 400, color: "var(--text-sub)", fontSize: 11 }}>(store time)</span></label>
                <input id="startsAt" name="startsAt" className="b-input" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
              </div>
              <div>
                <label className="b-label" htmlFor="endsAt">Offer ends (optional)</label>
                <input id="endsAt" name="endsAt" className="b-input" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
              </div>
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              <legend className="b-label">The code can be used together with</legend>
              {([
                ["product", "combinesProductDiscounts", "Product discounts"],
                ["order", "combinesOrderDiscounts", "Order discounts"],
                ["shipping", "combinesShippingDiscounts", "Shipping discounts"],
              ] as const).map(([key, name, label]) => (
                <label key={key} className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name={name} checked={combines[key]} onChange={(event) => setCombines({ ...combines, [key]: event.target.checked })} style={{ accentColor: ACCENT.color }} />
                  <span style={{ fontSize: 13 }}>{label}</span>
                </label>
              ))}
            </fieldset>

            <div style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Summary</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text)", display: "flex", flexDirection: "column", gap: 4 }}>
                <li>{automatic ? "Applies automatically, no code needed" : `${codeSummary} — ${limitSummary}`}</li>
                <li>{discountSummary(discountTarget, discountType, discountValue, currencyCode, productIds.length, collections.length)}</li>
                {(
                  <>
                    <li>Counts products added from: {pageTypes.map(pageTypeLabel).join(", ") || "no pages selected"}</li>
                    {utmEnabled && (
                      <li>
                        Needs {filledUtms.map(([key]) => `${key.replace("utm", "utm_").toLowerCase()}=${utm[key].trim()}`).join(", ") || "UTM parameters"}{" "}
                        {utmScope === "visit" ? "anywhere in the visit" : "on the page the product is added from"}
                      </li>
                    )}
                    <li>
                      {mixedCart === "reject"
                        ? "The code stops working if the cart has products from other pages"
                        : "Products from other pages stay at full price"}
                    </li>
                  </>
                )}
              </ul>
            </div>
          </div>
        </OfferWizardSection>

        <div style={{ fontSize: 12, color: "var(--text-sub)", textAlign: "right" }}>
          <strong>Save draft</strong> keeps everything off until you publish. <strong>Publish</strong> makes the codes
          work right away (or at the start time).
        </div>
        <div className="rd-style-031">
          <button type="button" className="b-btn b-btn-secondary" onClick={() => void navigate("/app/offers")}>
            Cancel
          </button>
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save draft"}
          </button>
          <button
            type="submit"
            name="intent"
            value="publish"
            className="b-btn b-btn-primary"
            style={{ background: ACCENT.gradient, boxShadow: `0 4px 12px ${ACCENT.soft}` }}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Publishing…" : "Publish"}
          </button>
        </div>
      </Form>

      <ProductPicker
        open={productPickerOpen}
        onClose={() => setProductPickerOpen(false)}
        title="Select products"
        mode="products"
        allowMultiple
        selectedIds={productIds}
        onSelect={setProductIds}
      />

      {clientError && <Toast message={clientError} type="error" onDismiss={() => setClientError(null)} />}

      <ConfirmDialog
        open={blocker.state === "blocked"}
        ariaLabel="Discard unsaved changes"
        title="Discard unsaved changes?"
        message="You have unsaved changes. If you leave, they will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  );
}
