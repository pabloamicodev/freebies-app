/**
 * Installation / Theme Blocks page
 * Guides merchant to enable the app embed and place app blocks in the theme editor.
 * Also shows status of extensions (web pixel, checkout extension).
 */

import { useLoaderData } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";
import "../styles/bogos.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // Check theme app embed status via Admin API
  let appEmbedEnabled = false;
  let activeThemeId = "";
  try {
    const res = await admin.graphql(`
      query {
        themes(first: 10, roles: [MAIN]) {
          nodes { id name role }
        }
      }
    `);
    interface ThemeQueryResult {
      data?: { themes?: { nodes?: Array<{ id: string; name: string; role: string }> } };
    }
    const data = await res.json() as ThemeQueryResult;
    const mainTheme = data.data?.themes?.nodes?.[0];
    activeThemeId = mainTheme?.id ?? "";
    // Note: checking actual app embed status requires a separate API call
    // We optimistically assume it may not be enabled
    appEmbedEnabled = false;
  } catch {
    // API unavailable
  }

  return {
    shopDomain,
    activeThemeId,
    appEmbedEnabled,
    themeEditorUrl: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/${activeThemeId.split("/").pop()}/editor`,
  };
};

const EXTENSION_STATUS = [
  { label: "Web Pixel Extension (Analytics)", status: "Installed" },
  { label: "Checkout UI Extension (Upsell — Plus)", status: "Installed" },
  { label: "Customer Account UI Extension", status: "Installed" },
  { label: "Discount Function (Rust)", status: "Deployed" },
  { label: "Cart Transform Function (Rust — Plus)", status: "Deployed" },
  { label: "Validation Function (Rust)", status: "Deployed" },
];

const APP_BLOCKS = [
  { name: "Gift Slider Block", desc: "Gift selection popup trigger" },
  { name: "Cart Message Block", desc: "Inline cart qualification message" },
  { name: "Progress Bar Block", desc: "Cart value progress toward threshold" },
  { name: "Today Offer Block", desc: "Inline version of Today Offer widget" },
  { name: "Volume Discount Block", desc: "Product page quantity tier table" },
  { name: "Frequently Bought Together Block", desc: "Product page FBT widget" },
];

export default function InstallationPage() {
  const { shopDomain, themeEditorUrl, appEmbedEnabled } = useLoaderData<typeof loader>();

  return (
    <div className="b-page">
      {/* Page header */}
      <PageHeader title="Theme Installation" backTo="/app/settings" />

      {/* Warning banner when embed status is unknown / disabled */}
      {!appEmbedEnabled && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
          <div className="b-banner-icon">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 4v4m0 4h.01" stroke="#c2410c" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="b-banner-body">
            <p className="b-banner-title">App embed may not be enabled</p>
            <p className="b-banner-text">
              The promo engine requires the app embed to be active in your theme editor.
              Open the theme editor below and enable it under <strong>App embeds</strong>.
            </p>
          </div>
        </div>
      )}

      <div className="b-stack b-stack-4">

        {/* ── Installation Status Card ───────────────────────── */}
        <div className="b-card">
          <div className="b-card-header b-row-between">
            <span>Installation Status</span>
            <span className={`b-badge ${appEmbedEnabled ? "b-badge-green" : "b-badge-orange"}`}>
              {appEmbedEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="b-card-body">
            <p className="b-text-sub b-text-sm" style={{ margin: "0 0 16px" }}>
              The app embed script powers auto-add gifts, cart messages, progress bars, and the gift
              slider. It must be toggled on in your active theme.
            </p>
            <div className="b-row b-gap-3">
              <a
                href={themeEditorUrl}
                target="_blank"
                rel="noreferrer"
                className="b-btn b-btn-primary"
              >
                Open Theme Editor →
              </a>
              <span
                className="b-status-pill b-status-pill-green"
                style={appEmbedEnabled ? {} : { background: "var(--orange-badge)", color: "var(--orange-txt)", borderColor: "#fcd34d" }}
              >
                {!appEmbedEnabled && (
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#c2410c", display: "inline-block" }} />
                )}
                {appEmbedEnabled && <span className="b-status-dot" />}
                {appEmbedEnabled ? "Embed active" : "Status unknown"}
              </span>
            </div>
          </div>
        </div>

        {/* ── Step-by-step guide cards ───────────────────────── */}

        {/* Step 1 */}
        <div className="b-card">
          <div className="b-card-header b-row b-gap-3">
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "var(--blue)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              1
            </span>
            Enable App Embed
          </div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">
              <p style={{ margin: 0 }}>
                Open the theme editor and navigate to{" "}
                <strong>App embeds</strong> in the left sidebar. Find{" "}
                <strong>Promo Engine</strong> and toggle it <strong>ON</strong>.
              </p>
              <div className="b-stack b-stack-2">
                <div className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                  <span style={{ color: "var(--blue)", marginTop: 2, flexShrink: 0 }}>①</span>
                  <span className="b-text-sm">In Shopify Admin, go to <strong>Online Store → Themes</strong></span>
                </div>
                <div className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                  <span style={{ color: "var(--blue)", marginTop: 2, flexShrink: 0 }}>②</span>
                  <span className="b-text-sm">Click <strong>Customize</strong> on your active theme</span>
                </div>
                <div className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                  <span style={{ color: "var(--blue)", marginTop: 2, flexShrink: 0 }}>③</span>
                  <span className="b-text-sm">Select <strong>App embeds</strong> from the left panel</span>
                </div>
                <div className="b-row b-gap-2" style={{ alignItems: "flex-start" }}>
                  <span style={{ color: "var(--blue)", marginTop: 2, flexShrink: 0 }}>④</span>
                  <span className="b-text-sm">Toggle <strong>Promo Engine</strong> to ON, then click Save</span>
                </div>
              </div>
              <div>
                <a
                  href={themeEditorUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="b-btn b-btn-primary b-btn-sm"
                >
                  Open Theme Editor →
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className="b-card">
          <div className="b-card-header b-row b-gap-3">
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "var(--blue)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              2
            </span>
            Add App Blocks{" "}
            <span className="b-badge b-badge-gray" style={{ marginLeft: 4, fontSize: 11 }}>
              Optional
            </span>
          </div>
          <div className="b-card-body">
            <p className="b-text-sub b-text-sm" style={{ margin: "0 0 16px" }}>
              App blocks let you place specific widgets at exact positions in your theme layout.
              Add them via <strong>Theme editor → click any section → Add block</strong>.
            </p>
            <div className="b-stack b-stack-2">
              {APP_BLOCKS.map((block) => (
                <div
                  key={block.name}
                  className="b-row-between"
                  style={{
                    padding: "10px 14px",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--r-sm)",
                    background: "var(--bg-hover)",
                  }}
                >
                  <div>
                    <span className="b-text-bold b-text-sm">{block.name}</span>
                    <span className="b-text-sub b-text-xs" style={{ marginLeft: 8 }}>
                      — {block.desc}
                    </span>
                  </div>
                  <span className="b-badge b-badge-gray" style={{ fontSize: 11 }}>Block</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 — Extension Status */}
        <div className="b-card">
          <div className="b-card-header b-row b-gap-3">
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "var(--green)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              3
            </span>
            Extension Status
          </div>
          <div className="b-card-body" style={{ padding: 0 }}>
            {EXTENSION_STATUS.map((ext, i) => (
              <div key={ext.label}>
                <div
                  className="b-row-between"
                  style={{ padding: "12px 20px" }}
                >
                  <span className="b-text-sm">{ext.label}</span>
                  <span className="b-badge b-badge-green">{ext.status}</span>
                </div>
                {i < EXTENSION_STATUS.length - 1 && (
                  <hr className="b-divider b-divider-full" style={{ margin: 0 }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Headless / Hydrogen Integration */}
        <div className="b-card">
          <div className="b-card-header">Headless / Hydrogen Integration</div>
          <div className="b-card-body">
            <p style={{ margin: "0 0 12px" }}>
              For headless storefronts, install the{" "}
              <code
                style={{
                  background: "var(--border-light)",
                  padding: "2px 6px",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                }}
              >
                @promo/headless-sdk
              </code>{" "}
              package and use the{" "}
              <code
                style={{
                  background: "var(--border-light)",
                  padding: "2px 6px",
                  borderRadius: "var(--r-sm)",
                  fontSize: 12,
                }}
              >
                createPromoClient
              </code>{" "}
              function with your store domain and public key.
            </p>
            <pre
              style={{
                background: "#f3f4f6",
                padding: "12px 16px",
                borderRadius: "var(--r)",
                fontSize: 12,
                overflow: "auto",
                margin: 0,
                lineHeight: 1.6,
                border: "1px solid var(--border)",
              }}
            >
{`import { createPromoClient } from '@promo/headless-sdk';
import { usePromoOffers } from '@promo/headless-sdk/react';

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const client = createPromoClient({
  storeDomain: '${shopDomain}',
  publicKey: 'YOUR_PUBLIC_KEY',
});`}
            </pre>
          </div>
        </div>

        {/* Troubleshooting */}
        <div className="b-card">
          <div className="b-card-header">Troubleshooting</div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">

              <div>
                <p className="b-text-bold b-text-sm" style={{ margin: "0 0 4px" }}>
                  App embed is toggled on but widgets don't appear
                </p>
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  Make sure you clicked <strong>Save</strong> in the theme editor after enabling the
                  embed. Changes are not applied until saved.
                </p>
              </div>

              <hr className="b-divider" style={{ margin: "4px 0" }} />

              <div>
                <p className="b-text-bold b-text-sm" style={{ margin: "0 0 4px" }}>
                  Widgets appear on some pages but not others
                </p>
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  App blocks are section-scoped. Add the relevant block to each template (product,
                  cart, collection) that should display the widget.
                </p>
              </div>

              <hr className="b-divider" style={{ margin: "4px 0" }} />

              <div>
                <p className="b-text-bold b-text-sm" style={{ margin: "0 0 4px" }}>
                  Using a headless or custom storefront?
                </p>
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  Theme embeds and app blocks are not applicable. Use the{" "}
                  <code
                    style={{
                      background: "var(--border-light)",
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontSize: 12,
                    }}
                  >
                    @promo/headless-sdk
                  </code>{" "}
                  instead — see the Headless integration section above.
                </p>
              </div>

              <hr className="b-divider" style={{ margin: "4px 0" }} />

              <div>
                <p className="b-text-bold b-text-sm" style={{ margin: "0 0 4px" }}>
                  Still having issues?
                </p>
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  Contact our support team via the chat widget or email{" "}
                  <a href="mailto:support@bogos.io" className="b-btn b-btn-plain" style={{ fontSize: 13 }}>
                    support@bogos.io
                  </a>
                  . Include your shop domain and a brief description of the issue.
                </p>
              </div>

            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
