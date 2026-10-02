import { useState } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { and, desc, eq, gt } from "drizzle-orm";
import { gdprExports } from "@promo/db";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { db, shopId } = await getShopContext(request);
  const rows = await db
    .select({
      id: gdprExports.id,
      customerId: gdprExports.customerId,
      requestedAt: gdprExports.requestedAt,
      expiresAt: gdprExports.expiresAt,
    })
    .from(gdprExports)
    .where(and(eq(gdprExports.shopId, shopId), gt(gdprExports.expiresAt, new Date())))
    .orderBy(desc(gdprExports.requestedAt))
    .limit(100);
  return {
    exports: rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      requestedAt: row.requestedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
  };
};

const formatDate = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default function DataRequestsPage() {
  const { exports } = useLoaderData<typeof loader>();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // App Bridge adds the session token to fetch(), a plain <a href> would not be authenticated in the embedded frame.
  async function download(id: string, customerId: string) {
    setDownloading(id);
    setError(null);
    try {
      const response = await fetch(`/app/settings/data-requests/${id}/download`);
      if (!response.ok) throw new Error(String(response.status));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `customer-data-${customerId.replace(/\W+/g, "")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The export could not be downloaded. It may have expired. Reload the page and try again.");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="b-page">
      <PageHeader
        title="Customer data requests"
        subtitle="Exports generated when a customer asks Shopify for their data. Each one is kept for a limited time."
        backTo="/app/settings"
      />
      {error && <div className="b-banner b-banner-red b-mb-4" role="alert"><div className="b-banner-body"><p className="b-banner-text">{error}</p></div></div>}
      <div className="b-card">
        {exports.length === 0 ? (
          <div className="b-card-body">
            <p className="b-text-sub" style={{ margin: 0 }}>No customer data requests are waiting. When Shopify forwards one, the export appears here.</p>
          </div>
        ) : (
          <div className="b-table-wrap">
            <table className="b-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Requested</th>
                  <th>Available until</th>
                  <th aria-label="Download" />
                </tr>
              </thead>
              <tbody>
                {exports.map((item) => (
                  <tr key={item.id}>
                    <td>{item.customerId}</td>
                    <td>{formatDate(item.requestedAt)}</td>
                    <td>{formatDate(item.expiresAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        disabled={downloading === item.id}
                        onClick={() => void download(item.id, item.customerId)}
                      >
                        {downloading === item.id ? "Preparing…" : "Download JSON"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
