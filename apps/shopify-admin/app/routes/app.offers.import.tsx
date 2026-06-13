/**
 * CSV Import page for bulk offer creation.
 * Parses CSV, validates each row, shows diff preview, creates offers in draft.
 */

import { Form, useActionData, useNavigate } from "react-router";
import { BackButton } from "../components/BackButton.js";
import { useState, useRef, useId } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const VALID_OFFER_TYPES = new Set(["gift", "bundle", "upsell", "discount", "booster"]);
const VALID_OFFER_TYPE_LABELS = Array.from(VALID_OFFER_TYPES).join(", ");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

/**
 * RFC 4180-compliant CSV parser.
 * Handles quoted fields with embedded commas, double-quote escapes, and CRLF/LF line endings.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Normalize line endings
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  while (i < src.length) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // Peek next char
        if (src[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        if (row.some((f) => f.trim())) rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Flush last field/row
  if (field || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim())) rows.push(row);
  }

  return rows;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const csvContent = formData.get("csvContent") as string;

  if (!csvContent) return { error: "No CSV content provided", created: [], errors: [] };

  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found", created: [], errors: [] };

  const parsedRows = parseCSV(csvContent);
  if (parsedRows.length < 2) return { error: "CSV must have a header row and at least one data row", created: [], errors: [] };

  const headerRow = parsedRows[0]!.map((h) => h.trim());
  const dataRows = parsedRows.slice(1);
  const rowResults = await Promise.all(dataRows.map(async (values, i) => {
    const row: Record<string, string> = {};
    headerRow.forEach((h, idx) => { row[h] = (values[idx] ?? "").trim(); });

    const internalName = row["internal_name"];
    const publicTitle = row["public_title"];
    const offerType = row["type"] as "gift" | "bundle" | "upsell" | "discount" | "booster";

    const rowNumber = i + 2; // +1 for header, +1 for 1-based indexing

    if (!internalName || !publicTitle || !offerType) {
      return { error: { row: rowNumber, message: "Missing required fields: internal_name, public_title, type" } };
    }

    if (!VALID_OFFER_TYPES.has(offerType)) {
      return { error: { row: rowNumber, message: `Invalid type "${offerType}". Must be one of: ${VALID_OFFER_TYPE_LABELS}` } };
    }

    try {
      const [newOffer] = await db.insert(offers).values({
        shopId,
        internalName,
        publicTitle,
        type: offerType,
        status: "draft",
        priority: parseInt(row["priority"] ?? "100", 10) || 100,
        discountTags: row["discount_tags"] ? row["discount_tags"].split("|") : [],
      }).returning({ id: offers.id });

      if (!newOffer) return { error: { row: rowNumber, message: "Failed to create offer" } };

      const setupTasks: Array<PromiseLike<unknown>> = [
        db.insert(offerCombinationPolicies).values({
          shopId, offerId: newOffer.id,
          combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
          stopLowerPriority: false, giftValueCountsForOtherOffers: false,
        }),
      ];

      if (row["condition_type"] && row["condition_value_threshold_cents"]) {
        setupTasks.push(db.insert(offerConditions).values({
          shopId,
          offerId: newOffer.id,
          scope: "main",
          conditionType: row["condition_type"],
          operator: "gte",
          value: { thresholdCents: parseInt(row["condition_value_threshold_cents"], 10), currencyCode: "USD", includeGiftValues: false },
          sortOrder: 0,
          isEnabled: true,
        }));
      }

      if (row["reward_type"] && row["discount_type"]) {
        const variantIds = row["gift_variant_gids"] ? row["gift_variant_gids"].split("|").filter(Boolean) : [];
        setupTasks.push(db.insert(offerRewards).values({
          shopId,
          offerId: newOffer.id,
          rewardType: row["reward_type"] as "product_gift" | "order_discount" | "bundle_discount" | "upsell_discount",
          discountType: row["discount_type"] as "free" | "percentage" | "fixed_amount" | "fixed_price",
          value: { amount: parseFloat(row["reward_value"] ?? "0") || 100 },
          target: { variantIds },
          quantity: parseInt(row["gift_quantity"] ?? "1", 10) || 1,
          isAutoAdd: row["is_auto_add"] === "true",
          isCustomerSelectable: false,
          trackMode: (row["track_mode"] as "product" | "variant") ?? "product",
          sortOrder: 0,
          label: null,
        }));
      }

      await Promise.all(setupTasks);
      return { created: newOffer.id };
    } catch (e) {
      return { error: { row: rowNumber, message: (e as Error).message } };
    }
  }));

  const created = rowResults.flatMap((result) => result.created ? [result.created] : []);
  const errors = rowResults.flatMap((result) => result.error ? [result.error] : []);

  return { created, errors, error: null };
};

const COLUMNS = [
  { col: "internal_name", req: true,  note: "Unique internal identifier" },
  { col: "public_title",  req: true,  note: "Customer-facing offer name" },
  { col: "type",          req: true,  note: "gift | bundle | upsell | discount | booster" },
  { col: "priority",      req: false, note: "Integer, default 100" },
  { col: "condition_type",req: false, note: "cart_value | cart_quantity" },
  { col: "condition_value_threshold_cents", req: false, note: "Integer in cents (e.g. 5000 = $50)" },
  { col: "reward_type",   req: false, note: "product_gift | order_discount" },
  { col: "discount_type", req: false, note: "free | percentage | fixed_amount" },
  { col: "reward_value",  req: false, note: "Numeric (e.g. 10 for 10%)" },
  { col: "gift_variant_gids", req: false, note: "Shopify variant GIDs, pipe-separated" },
  { col: "gift_quantity", req: false, note: "Integer, default 1" },
  { col: "is_auto_add",   req: false, note: "true | false" },
  { col: "track_mode",    req: false, note: "product | variant" },
  { col: "discount_tags", req: false, note: "Tag strings, pipe-separated" },
];

const TEMPLATE_CSV = `internal_name,public_title,type,priority,condition_type,condition_value_threshold_cents,reward_type,discount_type,reward_value,gift_variant_gids,gift_quantity,is_auto_add,track_mode,discount_tags
free-gift-50-usd,Free Gift with $50 Purchase,gift,100,cart_value,5000,product_gift,free,100,gid://shopify/ProductVariant/12345,1,true,product,summer-promo
volume-discount-3plus,Volume Discount Buy 3+,discount,200,cart_quantity,3,order_discount,percentage,10,,,,, `;

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "offer-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function OffersImportPage() {
  const navigate = useNavigate();
  const actionData = useActionData<typeof action>();
  const fileInputId = useId();
  const [csvText, setCsvText] = useState("");
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function parsePreview(text: string) {
    // Use the same RFC 4180 parser — extract first 6 rows for preview
    const allRows = parseCSV(text);
    if (allRows.length < 1) return;
    const hdrs = allRows[0]!.map((h) => h.trim());
    const rows = allRows.slice(1, 6).map((r) => r.map((v) => v.trim()));
    setPreviewHeaders(hdrs);
    setPreviewRows(rows);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setCsvText(text);
      parsePreview(text);
    };
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  const hasResult = actionData && !actionData.error;
  const allOk = hasResult && actionData.errors.length === 0;

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <BackButton to="/app/offers" label="← All Offers" />
          <h1 className="b-page-title">Import Offers</h1>
        </div>
        <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
          Bulk-create draft offers from a CSV file.
        </p>
      </div>

      {/* Error banner */}
      {actionData?.error && (
        <div className="b-banner b-banner-red b-mb-4">
          <span className="b-banner-icon">&#9888;</span>
          <div className="b-banner-body">
            <p className="b-banner-title">Import error</p>
            <p className="b-banner-text">{actionData.error}</p>
          </div>
        </div>
      )}

      {/* Result banner */}
      {hasResult && (
        <div className={`b-banner ${allOk ? "b-banner-green" : "b-banner-orange"} b-mb-4`}>
          <span className="b-banner-icon">{allOk ? "✓" : "⚠"}</span>
          <div className="b-banner-body">
            <p className="b-banner-title">
              {actionData.created.length} offer{actionData.created.length !== 1 ? "s" : ""} created
              {actionData.errors.length > 0 && `, ${actionData.errors.length} row${actionData.errors.length !== 1 ? "s" : ""} failed`}
            </p>
            {actionData.errors.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                {actionData.errors.map((e) => (
                  <li key={e.row} className="b-text-sm b-text-sub">
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="b-stack b-stack-4">
        {/* Upload card */}
        <div className="b-card">
          <div className="b-card-header">Upload CSV</div>
          <div className="b-card-body">
            <Form method="POST">
              <div className="b-stack b-stack-4">
                {/* Drop zone */}
                <label
                  htmlFor={fileInputId}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  style={{
                    border: `2px dashed ${isDragOver ? "var(--blue)" : "var(--border)"}`,
                    borderRadius: "var(--r)",
                    background: isDragOver ? "var(--blue-light)" : "var(--bg-hover)",
                    padding: "36px 24px",
                    textAlign: "center",
                    cursor: "pointer",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 8 }}>&#128196;</div>
                  <p className="b-text-bold" style={{ margin: "0 0 4px" }}>
                    Drop a CSV file here
                  </p>
                  <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                    or click to browse — .csv files only
                  </p>
                  <input
                    id={fileInputId}
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    style={{ display: "none" }}
                    onChange={handleFileInput}
                  />
                </label>

                {/* Paste fallback */}
                <div>
                  <label className="b-label" htmlFor="csvContent">
                    Or paste CSV content
                  </label>
                  <textarea
                    id="csvContent"
                    name="csvContent"
                    rows={8}
                    className="b-input"
                    style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
                    placeholder="Paste CSV here..."
                    value={csvText}
                    onChange={(e) => {
                      setCsvText(e.target.value);
                      parsePreview(e.target.value);
                    }}
                  />
                  <p className="b-help">All created offers start as drafts. You can activate them after reviewing.</p>
                </div>

                {/* Preview table */}
                {previewRows.length > 0 && (
                  <div>
                    <p className="b-label" style={{ marginBottom: 8 }}>
                      Preview — first {previewRows.length} data row{previewRows.length !== 1 ? "s" : ""}
                    </p>
                    <div className="b-table-wrap" style={{ overflowX: "auto" }}>
                      <table className="b-table">
                        <thead>
                          <tr>
                            {previewHeaders.map((h) => (
                              <th key={h}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci} className="b-text-sm">
                                  {cell || <span className="b-text-muted">—</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="b-row b-gap-3">
                  <button
                    type="submit"
                    className="b-btn b-btn-primary"
                    disabled={!csvText.trim()}
                    style={!csvText.trim() ? { opacity: 0.5, cursor: "not-allowed" } : {}}
                  >
                    Import{previewRows.length > 0 ? ` (${previewRows.length} row${previewRows.length !== 1 ? "s" : ""})` : ""}
                  </button>
                  <button
                    type="button"
                    className="b-btn b-btn-secondary"
                    onClick={() => navigate("/app/offers")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Form>
          </div>
        </div>

        {/* Format guide card */}
        <div className="b-card">
          <div className="b-card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>CSV Format Guide</span>
            <button
              type="button"
              className="b-btn b-btn-secondary b-btn-sm"
              onClick={downloadTemplate}
            >
              Download template
            </button>
          </div>
          <div className="b-card-body" style={{ padding: 0 }}>
            <table className="b-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {COLUMNS.map(({ col, req, note }) => (
                  <tr key={col}>
                    <td>
                      <code style={{ fontFamily: "monospace", fontSize: 12, background: "var(--border-light)", padding: "2px 6px", borderRadius: 3 }}>
                        {col}
                      </code>
                    </td>
                    <td>
                      {req
                        ? <span className="b-badge b-badge-green">Required</span>
                        : <span className="b-badge b-badge-gray">Optional</span>
                      }
                    </td>
                    <td className="b-text-sm b-text-sub">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Results table (only shown after a successful import with created IDs) */}
        {hasResult && actionData.created.length > 0 && (
          <div className="b-card">
            <div className="b-card-header">Created Offer IDs</div>
            <div className="b-card-body" style={{ padding: 0 }}>
              <table className="b-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Offer ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.created.map((id, i) => (
                    <tr key={id}>
                      <td className="b-text-sm b-text-sub">{i + 1}</td>
                      <td>
                        <code style={{ fontFamily: "monospace", fontSize: 12 }}>{id}</code>
                      </td>
                      <td>
                        <span className="b-badge b-badge-orange">Draft</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
